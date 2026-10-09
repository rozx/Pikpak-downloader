import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { Store } from "../src/state/store";
import { Drive } from "../src/pikpak/drive";
import { SpaceManager } from "../src/pikpak/space";
import { ProviderError } from "../src/pikpak/protocol";
import type { PikpakClient } from "../src/pikpak/client";
import type { CreationEvidence } from "../src/pikpak/ownership";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pikpak-space-test-")); const path = join(root, "db.sqlite"), store = new Store(path);
  store.ensureAccount("account"); const share = store.accept("account", "share", root, "reference"); const scan = store.claimScan("account", share.id)!;
  const state = { limit: 100n, usage: 90n, delayed: false, lost: false, denied: false, deletions: [] as string[], files: new Map<string, Record<string, unknown>>() };
  const add = (remoteId: string, completed: boolean, owned: boolean, size = 40n, completedAt = 1) => {
    const file = store.mergeFile(scan, { sourceId: `source-${remoteId}`, size, gcid: "a".repeat(40), relativePath: "synthetic" });
    const operation = store.beginOperation("account", file.id, "restore"); store.submitted("account", operation, `task-${remoteId}`);
    const copyId = store.recordCopy("account", operation, { remoteId, parentId: "parent", size, gcid: file.gcid });
    const proof: CreationEvidence = { taskId: `task-${remoteId}`, taskCreatedAt: "2026-10-08T10:00:00Z", copyCreatedAt: "2026-10-08T10:00:01Z",
      sourceId: file.sourceId, shareId: "share", copyId: remoteId, parentId: "parent", name: `${remoteId}.bin`, gcid: file.gcid, size: size.toString(), notBefore: "2026-10-08T10:00:00Z" };
    if (owned) store.recordCreation("account", copyId, operation, proof);
    state.files.set(remoteId, { id: remoteId, kind: "drive#file", phase: "PHASE_TYPE_COMPLETE", name: proof.name, parent_id: "parent", size: size.toString(), hash: file.gcid,
      created_time: proof.copyCreatedAt, params: { original_file_id: file.sourceId, original_share_id: "share" } });
    if (completed) {
      store.allocateDelivery("account", file.id, join(root, "missing.part"), join(root, `${remoteId}-removed.bin`));
      store.bindTemporary("account", file.id, { volume: "synthetic-volume", file: remoteId });
      store.transition("account", file.id, "ready"); store.transition("account", file.id, "downloading"); store.transition("account", file.id, "verifying");
      store.planPublication("account", file.id, { parent: "parent", name: proof.name, tempParent: "tmp", tempName: "tmp", baseName: proof.name }, join(root, proof.name), "a".repeat(64));
      store.completePublication("account", file.id, { volume: "synthetic-volume", file: remoteId }, "a".repeat(64));
      const db = new Database(path); db.query("UPDATE deliveries SET completed_at=? WHERE file_id=?").run(completedAt, file.id); db.close();
    }
    return { file, copyId };
  };
  const api: Pick<PikpakClient, "request"> = { request: async (_, route, init = {}, before) => {
    if (route.endsWith("/about")) return { quota: { limit: state.limit.toString(), usage: state.usage.toString() } };
    if (route === "/drive/v1/files:batchDelete") {
      before?.(); const ids = JSON.parse(String(init.body)).ids;
      if (state.denied) { store.pause("account", "permission"); throw new ProviderError("delete", "permission_denied", 403); }
      expect(ids).toHaveLength(1); const id = ids[0] as string;
      const file = state.files.get(id); if (!file) throw Error("cannot-delete-unregistered-resource");
      state.deletions.push(id); state.files.delete(id);
      if (!state.delayed) state.usage -= BigInt(String(file.size));
      if (state.lost) throw Error("synthetic-response-lost");
      return {};
    }
    const id = route.split("/").at(-1)!;
    const file = state.files.get(id); if (file) return file;
    throw new ProviderError("metadata", "file_not_found", 404);
  } };
  let now = 0;
  const manager = new SpaceManager(store, new Drive(api, "account"), async ms => { now += ms; }, () => now);
  return { root, path, store, share, scan, state, add, manager, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("本地成果已移除仍按历史完成时间回收，满足需要立即停止", async () => {
  const f = await fixture();
  try {
    f.add("z-oldest", true, true, 40n, 1); f.add("a-newer", true, true, 40n, 2);
    expect(await f.manager.ensure(50n)).toBe("ready"); expect(f.state.deletions).toEqual(["z-oldest"]);
    expect(f.state.files.has("a-newer")).toBe(true);
  } finally { await f.close(); }
});
test("首次已满、未完成、取消及未知归属没有清理资格；超总容量不删除", async () => {
  const f = await fixture();
  try {
    const cancelled = f.add("cancelled", false, true); f.store.cancel("account", cancelled.file.id);
    f.add("failed", false, true); f.add("unowned", true, false);
    expect(await f.manager.ensure(50n)).toBe("waiting_space");
    expect(await f.manager.ensure(101n)).toBe("too_large"); expect(f.state.deletions).toHaveLength(0);
  } finally { await f.close(); }
});
test("候选被移动后保护它；剩余合法容量不足时不徒劳删除", async () => {
  const f = await fixture();
  try {
    const moved = f.add("moved", true, true); f.add("other", true, true);
    f.state.files.get("moved")!.parent_id = "user-location";
    expect(await f.manager.ensure(80n)).toBe("waiting_space"); expect(f.state.deletions).toHaveLength(0);
    expect(f.store.copy("account", moved.copyId).state).toBe("protected");
  } finally { await f.close(); }
});
test("同一副本还有未交付引用时不能回收", async () => {
  const f = await fixture();
  try {
    f.add("shared-copy", true, true);
    const another = f.store.mergeFile(f.scan, { sourceId: "another", gcid: "a".repeat(40), size: 40n, relativePath: "synthetic" });
    const operation = f.store.beginOperation("account", another.id, "restore"); f.store.submitted("account", operation, "another-task");
    f.store.recordCopy("account", operation, { remoteId: "shared-copy", parentId: "parent", size: 40n, gcid: another.gcid });
    expect(await f.manager.ensure(50n)).toBe("waiting_space"); expect(f.state.deletions).toHaveLength(0);
  } finally { await f.close(); }
});
test("删除响应丢失后只核对同一对象，不补删其他候选", async () => {
  const f = await fixture();
  try {
    f.add("first", true, true); f.add("other", true, true, 40n, 2); f.state.lost = true;
    await expect(f.manager.ensure(50n)).rejects.toThrow();
    const operation = f.store.unresolved("account").find(item => item.kind === "delete")!;
    expect(await f.manager.reconcile(f.store.operation("account", operation.id), 50n)).toBe(true);
    expect(f.state.deletions).toEqual(["first"]);
  } finally { await f.close(); }
});
test("容量更新延迟时等待，不因未反映的释放结果继续删除", async () => {
  const f = await fixture();
  try {
    f.add("first", true, true); f.add("other", true, true, 40n, 2); f.state.delayed = true;
    expect(await f.manager.ensure(70n)).toBe("waiting_sync"); expect(f.state.deletions).toEqual(["first"]);
    expect(f.state.files.has("other")).toBe(true);
  } finally { await f.close(); }
});

test("权限拒绝停止删除；已不可读的旧候选不按名称替代", async () => {
  const denied = await fixture();
  try {
    denied.add("first", true, true); denied.add("other", true, true, 40n, 2); denied.state.denied = true;
    await expect(denied.manager.ensure(50n)).rejects.toThrow();
    expect(denied.store.paused("account")?.reason).toBe("permission"); expect(denied.state.deletions).toHaveLength(0);
  } finally { await denied.close(); }
  const missing = await fixture();
  try {
    const first = missing.add("first", true, true); missing.add("other", true, true); missing.state.files.delete("first");
    expect(await missing.manager.ensure(80n)).toBe("waiting_space"); expect(missing.state.deletions).toHaveLength(0);
    expect(missing.store.copy("account", first.copyId).state).toBe("protected");
  } finally { await missing.close(); }
});
