import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Store } from "../src/state/store";
import { SCHEMA_VERSION } from "../src/state/schema";
import { CHUNK_SIZE, serializeRanges } from "../src/state/ranges";
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { aggregate, assertTransition } from "../src/state/model";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pikpak-store-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "tasks.sqlite");
  let store = new Store(path);
  cleanups.push(() => store.close());
  store.ensureAccount("account-a"); store.ensureAccount("account-b");
  const share = store.accept("account-a", "synthetic-share", "/fixed-output", "secret-one");
  const scan = store.claimScan("account-a", share.id)!;
  const file = store.mergeFile(scan, { sourceId: "source", gcid: "a".repeat(40), size: 9007199254740993n, relativePath: "folder/file.bin" });
  return { path, get store() { return store; }, share, scan, file, reopen() { store.close(); store = new Store(path); return store; } };
}

test("重复接收固定输出根，请求版本不会被旧扫描结束或错误清除", () => {
  const f = fixture();
  const next = f.store.accept("account-a", "synthetic-share", "/new-default", "secret-two");
  expect(next.id).toBe(f.share.id);
  expect(next.outputRoot).toBe("/fixed-output");
  expect(next.requestedRevision).toBe(2n);
  expect(f.store.claimScan("account-a", next.id)?.secretRef).toBe("secret-one");
  f.store.finishScan(f.scan, false);
  expect(f.store.share("account-a", next.id).scanStatus).toBe("pending");
  const scan = f.reopen().claimScan("account-a", next.id)!;
  expect(scan.secretRef).toBe("secret-two");
  expect(scan.revision).toBe(2n);
  f.store.finishScan(scan, true);
  expect(f.store.claimScan("account-a", next.id)).toBe(null);
});

test("文件版本唯一，内容相同改名不重复，大整数重开后精确", () => {
  const f = fixture();
  const same = f.store.mergeFile(f.scan, { sourceId: "source", gcid: "a".repeat(40), size: f.file.size, relativePath: "renamed.bin" });
  expect(same.id).toBe(f.file.id);
  expect(same.relativePath).toBe("folder/file.bin");
  const changed = f.store.mergeFile(f.scan, { sourceId: "source", gcid: "b".repeat(40), size: f.file.size, relativePath: "folder/file.bin" });
  expect(changed.id).not.toBe(same.id);
  expect(f.reopen().files("account-a")).toHaveLength(2);
  expect(f.store.file("account-a", f.file.id).size).toBe(9007199254740993n);
});

test("失败事务不确认接收，外层回滚撤销内部工作", () => {
  const f = fixture();
  expect(() => f.store.transaction(() => {
    f.store.accept("account-a", "synthetic-share", "/other", "uncommitted-secret");
    throw Error("synthetic injected failure");
  })).toThrow();
  const share = f.reopen().share("account-a", f.share.id);
  expect(share.requestedRevision).toBe(1n);
  expect(share.secretRef).toBe("secret-one");
  expect(f.store.secretReferenced("uncommitted-secret")).toBe(false);
});

test("拒绝 async 事务，回调在执行前被拦截", () => {
  const f = fixture(); let executed = false;
  expect(() => {
    // @ts-expect-error 异步回调在类型层和运行时都不允许。
    f.store.transaction(async () => { executed = true; });
  }).toThrow();
  expect(executed).toBe(false);
});

test("跨账号读取、修改、扫描合并与操作意图被拒绝", () => {
  const f = fixture();
  expect(() => f.store.file("account-b", f.file.id)).toThrow();
  expect(() => f.store.cancel("account-b", f.share.id)).toThrow();
  expect(() => f.store.beginOperation("account-b", f.file.id, "restore")).toThrow();
  expect(() => f.store.mergeFile({ ...f.scan, accountId: "account-b" }, { sourceId: "wrong", gcid: "a".repeat(40), size: 0n, relativePath: "wrong" })).toThrow();
});

test("未确认外部操作、取消及凭据引用跨重启保留", () => {
  const f = fixture();
  const operation = f.store.beginOperation("account-a", f.file.id, "restore");
  f.store.finishScan(f.scan, true);
  f.store.accept("account-a", "synthetic-share", "/new", "secret-two");
  f.store.cancel("account-a", f.share.id);
  const store = f.reopen();
  expect(store.unresolved("account-a")[0]?.id).toBe(operation);
  expect(store.secretReferenced("secret-one")).toBe(true);
  expect(store.claimScan("account-a", f.share.id)).toBe(null);
  store.accept("account-a", "synthetic-share", "/new", "secret-three");
  expect(store.share("account-a", f.share.id).cancelled).toBe(true);
  expect(() => store.beginOperation("account-a", f.file.id, "restore")).toThrow();
  store.retry("account-a", f.share.id);
  expect(store.file("account-a", f.file.id).state).toBe("reconciling");
  expect(store.unresolved("account-a")).toHaveLength(1);
});

test("重启不重置自动重试预算，耗尽后显式重试才开启新周期", () => {
  const f = fixture();
  f.store.transition("account-a", f.file.id, "ready");
  f.store.transition("account-a", f.file.id, "downloading");
  for (let attempt = 0; attempt < 4; attempt++) {
    f.store.transientFailure("account-a", f.file.id, "network_failure");
    f.reopen();
    if (attempt < 3) f.store.transition("account-a", f.file.id, "downloading");
  }
  expect(f.store.file("account-a", f.file.id).state).toBe("failed");
  expect(f.store.file("account-a", f.file.id).retries).toBe(3n);
  f.store.retry("account-a", f.file.id);
  expect(f.store.file("account-a", f.file.id).retries).toBe(0n);
});

test("暂停恢复先检查条件，取消其他任务不清除账号暂停", () => {
  const f = fixture();
  const conditions = { authenticated: false, permitted: true, writable: true, hasSpace: true, targetAvailable: true, trafficAvailable: true };
  f.store.pause("account-a", "authentication");
  f.store.cancel("account-a", f.file.id);
  expect(f.reopen().resume("account-a", conditions)).toBe(false);
  expect(f.store.paused("account-a")?.reason).toBe("authentication");
  expect(f.store.resume("account-a", { ...conditions, authenticated: true })).toBe(true);
});

test("状态聚合区分部分成功、未完成扫描、等待和取消", () => {
  const files = [{ state: "completed", cancelled: false }, { state: "failed", cancelled: false }] as const;
  expect(aggregate(files, "complete")).toMatchObject({ status: "partial", completed: 1, failed: 1 });
  expect(aggregate([files[0]], "failed").status).toBe("scan_incomplete");
  expect(aggregate([{ state: "waiting_space", cancelled: false }], "complete").status).toBe("waiting");
  expect(aggregate(files, "complete", true)).toMatchObject({ status: "cancelled", completed: 1, cancelled: 1 });
  expect(() => assertTransition("completed", "ready")).toThrow();
});

test("未经交付记录不能完成，旧程序不能写更高版本结构", () => {
  const f = fixture();
  f.store.transition("account-a", f.file.id, "ready");
  f.store.transition("account-a", f.file.id, "downloading");
  f.store.transition("account-a", f.file.id, "verifying");
  f.store.transition("account-a", f.file.id, "publishing");
  expect(() => f.store.transition("account-a", f.file.id, "completed")).toThrow();
  const db = new Database(f.path);
  db.exec("PRAGMA user_version=999"); db.close();
  expect(() => new Store(f.path)).toThrow("更新版本");
});

test("写入实例运行时允许另一个只读状态连接", () => {
  const f = fixture();
  const reader = new Store(f.path, true);
  try {
    expect(reader.file("account-a", f.file.id).size).toBe(f.file.size);
    expect(() => reader.cancel("account-a", f.file.id)).toThrow();
  } finally { reader.close(); }
});

test("界面只读视图：分享汇总、文件断点与副本状态、缺省值、账号隔离和只读连接", () => {
  const f = fixture();
  const second = f.store.mergeFile(f.scan, { sourceId: "second", gcid: "b".repeat(40), size: 5n, relativePath: "folder/second.bin" });
  f.store.captureTitle(f.scan, "合集标题");
  f.store.transition("account-a", f.file.id, "ready");
  const operation = f.store.beginOperation("account-a", f.file.id, "restore");
  f.store.transition("account-a", f.file.id, "saving");
  f.store.submitted("account-a", operation, "synthetic-remote-task");
  const copy = f.store.recordCopy("account-a", operation, { remoteId: "synthetic-copy", parentId: "parent", size: f.file.size, gcid: f.file.gcid });
  f.store.transition("account-a", f.file.id, "awaiting_remote");
  f.store.transition("account-a", f.file.id, "downloading");
  f.store.allocateDelivery("account-a", f.file.id, "/fixed-output/tmp", "/fixed-output/final");
  f.store.checkpoint("account-a", f.file.id, 9007199254740992n, "a".repeat(64));
  f.store.copyState("account-a", copy, "protected");
  f.store.fileError("account-a", second.id, "access_required"); f.store.cancel("account-a", second.id);
  f.store.setConfig("queue_paused", "1"); f.store.setConfig("clipboard_watch", "0");
  const reader = new Store(f.path, true);
  try {
    const shares = reader.shareViews("account-a");
    expect(shares).toHaveLength(1);
    expect(shares[0]).toMatchObject({ id: f.share.id, title: "合集标题", outputRoot: "/fixed-output",
      scanStatus: f.store.share("account-a", f.share.id).scanStatus, cancelled: false, lastError: null });
    expect(shares[0]!.summary).toMatchObject({ total: 2, active: 1, cancelled: 1 });
    const files = reader.fileViews("account-a", f.share.id);
    expect(files.map(file => file.id)).toEqual([f.file.id, second.id]);
    expect(files[0]).toMatchObject({ shareId: f.share.id, relativePath: "folder/file.bin", size: 9007199254740993n, state: "downloading",
      retries: 0n, cancelled: false, lastError: null, checkpoint: 9007199254740992n, copyState: "protected" });
    expect(files[1]).toMatchObject({ size: 5n, state: "failed", cancelled: true, lastError: "access_required", checkpoint: 0n, copyState: null });
    expect(reader.config("queue_paused")).toBe("1"); expect(reader.config("clipboard_watch")).toBe("0");
    expect(reader.shareViews("account-b")).toEqual([]);
    expect(() => reader.fileViews("account-b", f.share.id)).toThrow();
  } finally { reader.close(); }
});

test("来源关联、保守副本归属和字节检查点持久化，路径分配保持稳定", () => {
  const f = fixture();
  f.store.transition("account-a", f.file.id, "ready");
  const operation = f.store.beginOperation("account-a", f.file.id, "restore");
  f.store.transition("account-a", f.file.id, "saving");
  f.store.submitted("account-a", operation, "synthetic-remote-task");
  const copy = f.store.recordCopy("account-a", operation, { remoteId: "synthetic-copy", parentId: "parent", size: f.file.size, gcid: f.file.gcid });
  f.store.transition("account-a", f.file.id, "awaiting_remote");
  f.store.transition("account-a", f.file.id, "downloading");
  f.store.allocateDelivery("account-a", f.file.id, "/fixed-output/tmp", "/fixed-output/final");
  f.store.checkpoint("account-a", f.file.id, 9007199254740992n, "a".repeat(64));
  const store = f.reopen();
  expect(store.unresolved("account-a")).toHaveLength(0);
  expect(store.allocateDelivery("account-a", f.file.id, "/wrong", "/wrong").targetPath).toBe("/fixed-output/final");
  expect(store.delivery("account-a", f.file.id)?.checkpoint).toBe(9007199254740992n);
  const db = new Database(f.path, { readonly: true });
  try { expect(db.query<{ ownership: string }, [string]>("SELECT ownership FROM copies WHERE id=?").get(copy)?.ownership).toBe("unverified"); }
  finally { db.close(); }
});

function downloading(f: ReturnType<typeof fixture>) {
  f.store.transition("account-a", f.file.id, "ready");
  f.store.transition("account-a", f.file.id, "downloading");
  f.store.allocateDelivery("account-a", f.file.id, "/fixed-output/tmp", "/fixed-output/final");
}

test("结构版本 3 升到 4：先备份，旧检查点作为连续前缀保留，区间列为空", () => {
  const f = fixture(); downloading(f);
  f.store.checkpoint("account-a", f.file.id, 9007199254740992n, "a".repeat(64));
  f.store.close();
  const legacy = new Database(f.path);
  legacy.exec("ALTER TABLE deliveries DROP COLUMN ranges_json; PRAGMA user_version=3"); legacy.close();
  const store = f.reopen();
  expect(SCHEMA_VERSION).toBe(4);
  expect(store.delivery("account-a", f.file.id)).toMatchObject({ checkpoint: 9007199254740992n, prefixSha256: "a".repeat(64) });
  expect(readdirSync(dirname(f.path)).filter(name => name.includes("backup-v3") && name.endsWith(".sqlite"))).toHaveLength(1);
  const db = new Database(f.path, { readonly: true });
  try {
    expect(Number(db.query("PRAGMA user_version").values()[0]![0])).toBe(4);
    expect(db.query<{ ranges: string | null }, [string]>("SELECT ranges_json AS ranges FROM deliveries WHERE file_id=?").get(f.file.id)?.ranges).toBe(null);
  } finally { db.close(); }
});

test("升级失败时整体回滚，版本号与数据保持不变；更高版本的任务库被拒绝", () => {
  const f = fixture(); downloading(f);
  f.store.checkpoint("account-a", f.file.id, 5n, "b".repeat(64));
  f.store.close();
  // 版本号标为 3 但已有该列：升级语句失败。
  const broken = new Database(f.path); broken.exec("PRAGMA user_version=3"); broken.close();
  expect(() => new Store(f.path)).toThrow();
  const db = new Database(f.path, { readonly: true });
  try {
    expect(Number(db.query("PRAGMA user_version").values()[0]![0])).toBe(3);
    expect(db.query<{ checkpoint: string }, [string]>("SELECT checkpoint FROM deliveries WHERE file_id=?").get(f.file.id)?.checkpoint).toBe("5");
  } finally { db.close(); }
  const newer = new Database(f.path); newer.exec(`PRAGMA user_version=${SCHEMA_VERSION + 1}`); newer.close();
  expect(() => new Store(f.path)).toThrow("更新版本");
  const restored = new Database(f.path); restored.exec(`PRAGMA user_version=${SCHEMA_VERSION}`); restored.close();
  f.reopen();
});

test("检查点与区间同一次写入；无效区间被拒绝且保留原值；顺序模式在顺序路径保存后保留", () => {
  const f = fixture(); downloading(f);
  const S = CHUNK_SIZE, prefix = 9007199254740992n - 3n * S;
  const ranges = { mode: "parallel" as const, chunk: S, ranges: [{ offset: prefix + S, bytes: S, sha256: "c".repeat(64) }, { offset: prefix + 3n * S, bytes: 1n, sha256: "d".repeat(64) }] };
  f.store.checkpoint("account-a", f.file.id, prefix, "a".repeat(64), ranges);
  expect(f.store.delivery("account-a", f.file.id)).toMatchObject({ checkpoint: prefix, prefixSha256: "a".repeat(64), ranges });
  expect(f.store.persistedBytes("account-a", f.file.id)).toBe(prefix + S + 1n);
  // 超出窗口的区间被拒绝，库中保持上一次的检查点。
  expect(() => f.store.checkpoint("account-a", f.file.id, prefix, "b".repeat(64),
    { mode: "parallel", chunk: S, ranges: [{ offset: prefix + 16n * S, bytes: 1n, sha256: "e".repeat(64) }] })).toThrow();
  expect(f.store.delivery("account-a", f.file.id)).toMatchObject({ prefixSha256: "a".repeat(64), ranges });
  // 顺序路径保存（省略区间）清空区间。
  f.store.checkpoint("account-a", f.file.id, prefix + 10n, "b".repeat(64));
  expect(f.store.delivery("account-a", f.file.id)?.ranges).toBe(null);
  // 顺序模式由顺序路径保存保留，区间仍为空。
  f.store.checkpoint("account-a", f.file.id, 0n, "c".repeat(64), { mode: "sequential", chunk: S, ranges: [] });
  f.store.checkpoint("account-a", f.file.id, 5n, "d".repeat(64));
  expect(f.reopen().delivery("account-a", f.file.id)?.ranges).toEqual({ mode: "sequential", chunk: S, ranges: [] });
});

test("库中区间损坏时整体视为空，前缀保留；界面断点显示已持久化字节数", () => {
  const f = fixture(); downloading(f);
  const S = CHUNK_SIZE;
  f.store.checkpoint("account-a", f.file.id, 4n * S, "a".repeat(64), { mode: "parallel", chunk: S, ranges: [{ offset: 5n * S, bytes: 1000n, sha256: "c".repeat(64) }] });
  expect(f.store.fileViews("account-a", f.share.id)[0]?.checkpoint).toBe(4n * S + 1000n);
  f.store.close();
  const db = new Database(f.path);
  for (const corrupt of ["{broken", serializeRanges({ mode: "parallel", chunk: S, ranges: [{ offset: S, bytes: 1n, sha256: "c".repeat(64) }] })]) {
    db.query("UPDATE deliveries SET ranges_json=? WHERE file_id=?").run(corrupt, f.file.id);
    const reader = new Store(f.path, true);
    try {
      expect(reader.delivery("account-a", f.file.id)).toMatchObject({ checkpoint: 4n * S, prefixSha256: "a".repeat(64), ranges: null });
      expect(reader.persistedBytes("account-a", f.file.id)).toBe(4n * S);
      expect(reader.fileViews("account-a", f.share.id)[0]?.checkpoint).toBe(4n * S);
    } finally { reader.close(); }
  }
  db.close(); f.reopen();
});

test("显式重试清除顺序模式标记，自动重试保留", () => {
  const f = fixture(); downloading(f);
  f.store.checkpoint("account-a", f.file.id, 0n, "a".repeat(64), { mode: "sequential", chunk: CHUNK_SIZE, ranges: [] });
  f.store.transientFailure("account-a", f.file.id, "range_mismatch");
  expect(f.store.delivery("account-a", f.file.id)?.ranges?.mode).toBe("sequential");
  f.store.retry("account-a", f.file.id);
  expect(f.store.delivery("account-a", f.file.id)?.ranges).toBe(null);
  expect(f.store.delivery("account-a", f.file.id)?.prefixSha256).toBe("a".repeat(64));
});

test("改目录时只迁移本地尚未开始的分享：根目录未打开、没有目录映射、没有交付记录", () => {
  const f = fixture();
  const unstarted = f.store.accept("account-a", "unstarted", "/fixed-output", "secret-u");
  const bound = f.store.accept("account-a", "bound", "/fixed-output", "secret-b");
  f.store.bindRoot("account-a", bound.id, { volume: "v", file: "root" });
  const mapped = f.store.accept("account-a", "mapped", "/fixed-output", "secret-m");
  f.store.recordDirectory("account-a", mapped.id, { nodeId: "@share", parentId: "@root", name: "mapped", folded: "mapped", volume: "v", identity: "d" });
  // f.share 有一个文件已分配交付记录。
  f.store.transition("account-a", f.file.id, "ready"); f.store.transition("account-a", f.file.id, "downloading");
  f.store.allocateDelivery("account-a", f.file.id, "/fixed-output/tmp", "/fixed-output/final");
  const other = f.store.accept("account-b", "other-account", "/fixed-output", "secret-o");
  expect(f.store.moveUnstartedShares("account-a", "/new-output")).toEqual([unstarted.id]);
  expect(f.store.share("account-a", unstarted.id).outputRoot).toBe("/new-output");
  for (const share of [bound, mapped, f.share]) expect(f.store.share("account-a", share.id).outputRoot).toBe("/fixed-output");
  expect(f.store.share("account-b", other.id).outputRoot).toBe("/fixed-output");
  expect(f.store.moveUnstartedShares("account-a", "/new-output")).toEqual([]);
  expect(() => f.store.moveUnstartedShares("account-a", "")).toThrow();
});

