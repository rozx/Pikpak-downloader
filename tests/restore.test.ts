import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/state/store";
import { acceptShare } from "../src/auth/share-access";
import { Restore } from "../src/pikpak/restore";
import { Drive } from "../src/pikpak/drive";
import { requestJson, type Transport } from "../src/pikpak/protocol";
import type { PikpakClient } from "../src/pikpak/client";

async function fixture(failure: "none" | "lost" | "old" = "none") {
  const root = await mkdtemp(join(tmpdir(), "pikpak-restore-test-")); let store = new Store(join(root, "db.sqlite"));
  const values = new Map<string, string>(); const secrets = { get: async (key: string) => values.get(key) ?? null, set: async (key: string, value: string) => { values.set(key, value); }, delete: async (key: string) => { values.delete(key); } };
  store.ensureAccount("account"); const { share } = await acceptShare(store, secrets, { accountId: "account", shareId: "share", passCode: "demo", outputRoot: root });
  const scan = store.claimScan("account", share.id)!;
  const file = store.mergeFile(scan, { sourceId: "nested-source", gcid: "a".repeat(40), size: 1n, relativePath: JSON.stringify([{ id: "folder", name: "folder" }, { id: "nested-source", name: "file.bin" }]) });
  store.transition("account", file.id, "ready");
  const state = { submissions: 0, pending: false };
  const json = (value: unknown) => Response.json(value, { headers: { date: "Thu, 08 Oct 2026 10:00:00 GMT" } });
  const http: Transport = async (input, init) => {
    const path = new URL(input).pathname;
    if (path.endsWith("/share")) return json({ share_status: "OK", pass_code_token: "synthetic-grant" });
    if (path.endsWith("/file_info")) return json({ file_info: { id: file.sourceId, kind: "drive#file", size: "1", hash: file.gcid } });
    if (path.endsWith("/share/restore")) {
      state.submissions++;
      expect(JSON.parse(String(init.body)).file_ids).toEqual(["nested-source"]);
      if (failure === "lost") throw Error("accepted-but-response-lost");
      return json({ restore_status: "RESTORE_START", restore_task_id: "task" });
    }
    if (path.endsWith("/tasks/task")) return json({ id: "task", type: "restore", phase: state.pending ? "PHASE_TYPE_RUNNING" : "PHASE_TYPE_COMPLETE", created_time: "2026-10-08T10:00:00.001Z", params: { trace_file_ids: { "nested-source": "copy" } } });
    if (path.endsWith("/files/copy")) return json({ id: "copy", kind: "drive#file", phase: "PHASE_TYPE_COMPLETE", name: "file.bin", parent_id: "parent", size: "1", hash: file.gcid,
      created_time: failure === "old" ? "2026-10-08T09:00:00Z" : "2026-10-08T10:00:00.002Z", params: { original_file_id: file.sourceId, original_share_id: "share" } });
    throw Error("unexpected-request");
  };
  const api: Pick<PikpakClient, "request"> = { request: async (_, path, init = {}, before) => { before?.(); return requestJson("synthetic", `https://api-drive.mypikpak.com${path}`, init, http); } };
  return { get store() { return store; }, file, state, get restore() { return new Restore(store, secrets, new Drive(api, "account"), async () => {}); },
    reopen() { store.close(); store = new Store(join(root, "db.sqlite")); }, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("逐子文件保存与精确来源证明；再次执行复用已确认副本", async () => {
  const f = await fixture();
  try {
    const copy = await f.restore.ensure(f.file);
    expect(copy.ownership).toBe("created"); expect(copy.remoteId).toBe("copy");
    expect((await f.restore.ensure(f.file)).id).toBe(copy.id); expect(f.state.submissions).toBe(1);
  } finally { await f.close(); }
});
test("响应丢失保留意图，重试不产生第二次提交", async () => {
  const f = await fixture("lost");
  try {
    await expect(f.restore.ensure(f.file)).rejects.toThrow();
    expect(f.store.operationFor("account", f.file.id, "restore")?.payload.sent).toBe(true);
    f.reopen();
    await expect(f.restore.ensure(f.file)).rejects.toThrow(); expect(f.state.submissions).toBe(1);
  } finally { await f.close(); }
});
test("同名既有结果只能关联读取，不能取得创建归属", async () => {
  const f = await fixture("old");
  try { expect((await f.restore.ensure(f.file)).ownership).toBe("unverified"); }
  finally { await f.close(); }
});

test("等待预算耗尽后仍可单次核对已完成结果，不重新提交", async () => {
  const f = await fixture(); f.state.pending = true;
  try {
    await expect(f.restore.ensure(f.file)).rejects.toThrow();
    expect(f.store.operationFor("account", f.file.id, "restore")?.status).toBe("attention");
    f.state.pending = false;
    expect((await f.restore.ensure(f.file)).remoteId).toBe("copy"); expect(f.state.submissions).toBe(1);
  } finally { await f.close(); }
});
