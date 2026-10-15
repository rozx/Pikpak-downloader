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
  const state = { limit: 100n, usage: 90n, delayed: false, lost: false, denied: false, quietDenied: false, quiet: [] as boolean[], deletions: [] as string[], requests: [] as number[], lingering: new Set<string>(), files: new Map<string, Record<string, unknown>>() };
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
  const api: Pick<PikpakClient, "request"> = { request: async (_, route, init = {}, before, options = {}) => {
    if (route.endsWith("/about")) return { quota: { limit: state.limit.toString(), usage: state.usage.toString() } };
    if (route === "/drive/v1/files:batchDelete") {
      before?.(); const ids = JSON.parse(String(init.body)).ids; state.quiet.push(!!options.quiet);
      // 静默请求的拒绝只抛给调用者，不暂停账号（与 PikpakClient 的 quiet 选项一致）。
      if (state.quietDenied && options.quiet) throw new ProviderError("delete", "permission_denied", 403);
      if (state.denied) { store.pause("account", "permission"); throw new ProviderError("delete", "permission_denied", 403); }
      state.requests.push(ids.length);
      for (const id of ids as string[]) {
        const file = state.files.get(id); if (!file) throw Error("cannot-delete-unregistered-resource");
        state.deletions.push(id); if (!state.lingering.has(id)) state.files.delete(id);
        if (!state.delayed) state.usage -= BigInt(String(file.size));
      }
      if (state.lost) throw Error("synthetic-response-lost");
      return {};
    }
    const id = route.split("/").at(-1)!;
    const file = state.files.get(id); if (file) return file;
    throw new ProviderError("metadata", "file_not_found", 404);
  } };
  let now = 0;
  const manager = new SpaceManager(store, new Drive(api, "account"), async ms => { now += ms; }, () => now);
  return { root, path, store, share, scan, state, add, manager, elapsed: () => now, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
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

test("手动释放：静默删除；服务端拒绝时副本保留、意图记为被拒绝、账号不暂停", async () => {
  const f = await fixture();
  try {
    const done = f.add("done", true, true);
    expect(f.store.releaseTargets("account", done.file.id)).toMatchObject({ reason: null, targets: [{ fileIds: [done.file.id], completed: true }] });
    f.state.quietDenied = true;
    expect(await f.manager.release(done.copyId, done.file.id)).toEqual({ outcome: "denied", reason: "permission_denied" });
    expect(f.store.copy("account", done.copyId).state).toBe("retained"); expect(f.store.paused("account")).toBe(null);
    expect(f.store.unresolved("account")).toEqual([]); expect(f.state.deletions).toEqual([]);
    f.state.quietDenied = false;
    expect(await f.manager.release(done.copyId, done.file.id)).toEqual({ outcome: "released" });
    expect(f.state.deletions).toEqual(["done"]); expect(f.state.quiet).toEqual([true, true]);
    expect(f.store.copy("account", done.copyId).state).toBe("deleted"); expect(f.store.unresolved("account")).toEqual([]);
    // 释放后自动回收不再把它当作候选。
    expect(f.store.candidates("account")).toEqual([]);
  } finally { await f.close(); }
});

test("手动释放：未完成文件改回就绪并保留断点；非本工具创建、有未核对转存或没有副本时不释放", async () => {
  const f = await fixture();
  try {
    const unfinished = f.add("unfinished", false, true);
    f.store.allocateDelivery("account", unfinished.file.id, join(f.root, "unfinished.part"), join(f.root, "unfinished.bin"));
    f.store.transition("account", unfinished.file.id, "ready"); f.store.transition("account", unfinished.file.id, "downloading");
    f.store.checkpoint("account", unfinished.file.id, 20n, "b".repeat(64)); f.store.pauseTask("account", unfinished.file.id);
    expect(f.store.releaseTargets("account", unfinished.file.id).targets[0]?.completed).toBe(false);
    expect(await f.manager.release(unfinished.copyId, unfinished.file.id)).toEqual({ outcome: "released" });
    const after = f.store.file("account", unfinished.file.id);
    expect(after.state).toBe("ready"); expect(after.retries).toBe(0n); expect(f.store.persistedBytes("account", unfinished.file.id)).toBe(20n);
    expect(f.store.copyForFile("account", unfinished.file.id)).toBe(null);

    const unowned = f.add("unowned", true, false);
    expect(f.store.releaseTargets("account", unowned.file.id)).toEqual({ targets: [], orphans: [], reason: "copy_not_owned" });
    expect(await f.manager.release(unowned.copyId, unowned.file.id)).toEqual({ outcome: "skipped" });
    const busy = f.add("busy", false, true); f.store.beginOperation("account", busy.file.id, "restore");
    expect(f.store.releaseTargets("account", busy.file.id)).toEqual({ targets: [], orphans: [], reason: "copy_in_use" });
    const none = f.store.mergeFile(f.scan, { sourceId: "never-saved", size: 5n, gcid: "a".repeat(40), relativePath: "synthetic" });
    expect(f.store.releaseTargets("account", none.id)).toEqual({ targets: [], orphans: [], reason: "copy_absent" });
    // 分享范围：只列出可释放的副本；不能释放的不影响其他副本。
    expect(f.store.releaseTargets("account", f.share.id)).toEqual({ targets: [], orphans: [], reason: "copy_in_use" });
    const other = f.add("other", true, true);
    expect(f.store.releaseTargets("account", f.share.id).targets.map(target => target.copy.id)).toEqual([other.copyId]);
    expect(f.state.deletions).toEqual(["unfinished"]);
  } finally { await f.close(); }
});

test("手动释放：副本已被改动时改为受保护、已不存在时记为已删除，均不发出删除", async () => {
  const f = await fixture();
  try {
    const moved = f.add("moved", true, true); f.state.files.get("moved")!.parent_id = "user-location";
    expect(await f.manager.release(moved.copyId, moved.file.id)).toEqual({ outcome: "changed" });
    expect(f.store.copy("account", moved.copyId).state).toBe("protected");
    const gone = f.add("gone", true, true); f.state.files.delete("gone");
    expect(await f.manager.release(gone.copyId, gone.file.id)).toEqual({ outcome: "missing" });
    expect(f.store.copy("account", gone.copyId).state).toBe("deleted"); expect(f.state.deletions).toEqual([]);
  } finally { await f.close(); }
});

test("删除任务记录：只删已完成且云端副本都已删除、没有未核对操作的文件；文件都删除且扫描完成后分享也删除", async () => {
  const f = await fixture();
  try {
    const released = f.add("released", true, true), kept = f.add("kept", true, true), pending = f.add("pending", true, true);
    expect(await f.manager.release(released.copyId, released.file.id)).toEqual({ outcome: "released" });
    expect(f.store.forgettable("account", kept.file.id)).toBe(false); // 副本仍保留在云端
    f.store.copyState("account", pending.copyId, "deleted"); f.store.beginOperation("account", pending.file.id, "publish");
    expect(f.store.forgettable("account", pending.file.id)).toBe(false); // 有未核对的操作
    expect(f.store.releaseTargets("account", f.share.id)).toMatchObject({ orphans: [released.file.id] });
    expect(f.store.forgetFile("account", kept.file.id)).toBe(false);
    expect(f.store.forgetFile("account", released.file.id)).toBe(true);
    expect(() => f.store.file("account", released.file.id)).toThrow(); expect(() => f.store.copy("account", released.copyId)).toThrow();
    expect(f.store.files("account").map(file => file.id).sort()).toEqual([kept.file.id, pending.file.id].sort());
    // 还有文件、扫描未完成时分享保留。
    expect(f.store.forgetShare("account", f.share.id)).toBe(null);
    const db = new Database(f.path); db.run("PRAGMA foreign_keys=ON");
    for (const file of [kept, pending]) { db.run("DELETE FROM operations WHERE file_id=? AND status<>'confirmed'", [file.file.id]); db.run("UPDATE copies SET state='deleted' WHERE id=?", [file.copyId]); }
    db.close();
    for (const file of [kept, pending]) expect(f.store.forgetFile("account", file.file.id)).toBe(true);
    expect(f.store.forgetShare("account", f.share.id)).toBe(null); // 扫描仍在进行
    f.store.finishScan(f.scan, true);
    expect(f.store.forgetShare("account", f.share.id)).toBe("reference");
    expect(f.store.shareViews("account")).toEqual([]); expect(f.store.secretReferenced("reference")).toBe(false);
  } finally { await f.close(); }
});

test("批量释放：一次删除请求带多个 ID；以副本不可见为准确认，不等待容量反映", async () => {
  const f = await fixture();
  try {
    const copies = ["one", "two", "three"].map(id => f.add(id, true, true));
    f.state.delayed = true; // 容量迟迟不反映释放（或同时有转存让容量上升）
    const outcomes = await f.manager.releaseMany(copies.map(item => ({ copyId: item.copyId, fileId: item.file.id })));
    expect([...outcomes.values()]).toEqual([{ outcome: "released" }, { outcome: "released" }, { outcome: "released" }]);
    expect(f.state.requests).toEqual([3]); expect(f.state.quiet).toEqual([true]); expect(f.elapsed()).toBe(0);
    for (const item of copies) expect(f.store.copy("account", item.copyId).state).toBe("deleted");
    expect(f.store.unresolved("account")).toEqual([]);
  } finally { await f.close(); }
});

test("批量释放：删除后仍可见的副本 30 秒后标为待核对，其余照常确认；整批被拒绝时全部保留", async () => {
  const f = await fixture();
  try {
    const [gone, stuck] = ["gone", "stuck"].map(id => f.add(id, true, true));
    f.state.lingering.add("stuck");
    const outcomes = await f.manager.releaseMany([gone!, stuck!].map(item => ({ copyId: item.copyId, fileId: item.file.id })));
    expect(outcomes.get(gone!.copyId)).toEqual({ outcome: "released" }); expect(outcomes.get(stuck!.copyId)).toEqual({ outcome: "unconfirmed" });
    expect(f.elapsed()).toBeGreaterThanOrEqual(30000); expect(f.elapsed()).toBeLessThan(40000);
    expect(f.store.unresolved("account").map(item => item.status)).toEqual(["attention"]);
    const denied = ["a", "b"].map(id => f.add(id, true, true)); f.state.quietDenied = true;
    const refused = await f.manager.releaseMany(denied.map(item => ({ copyId: item.copyId, fileId: item.file.id })));
    expect([...refused.values()]).toEqual([{ outcome: "denied", reason: "permission_denied" }, { outcome: "denied", reason: "permission_denied" }]);
    for (const item of denied) expect(f.store.copy("account", item.copyId).state).toBe("retained");
    expect(f.store.paused("account")).toBe(null);
  } finally { await f.close(); }
});
