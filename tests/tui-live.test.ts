import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../src/state/store";
import type { RuntimeEvent } from "../src/runtime/engine";
import type { SessionCommand } from "../src/runtime/session";
import { LiveController } from "../src/tui/live";
import { directoryCommand, openDirectory } from "../src/tui/open-directory";

async function fixture(options: Partial<ConstructorParameters<typeof LiveController>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), "pikpak-live-test-")); const store = new Store(join(root, "db.sqlite"));
  store.ensureAccount("account"); store.setConfig("output_root", root);
  const share = store.accept("account", "remote", root, "reference"); const scan = store.claimScan("account", share.id)!;
  store.captureTitle(scan, "某某合集");
  const file = store.mergeFile(scan, { sourceId: "s", gcid: "a".repeat(40), size: 1000n, relativePath: JSON.stringify([{ id: "s", name: "episode01.mkv" }]) });
  const listeners = new Set<(event: RuntimeEvent) => void>(); const commands: SessionCommand[] = []; const counts = { quota: 0, local: 0, stops: 0, forced: 0, opened: [] as string[] };
  const live = new LiveController({ store, accountId: "account",
    session: { subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, command: async command => { commands.push(command); return { ok: true, ids: [], issues: [] }; } },
    quota: async () => { counts.quota++; return { usage: 10n, limit: 100n }; }, localFree: async () => { counts.local++; return 5000n; },
    stop: () => { counts.stops++; }, forceExit: () => { counts.forced++; }, open: async path => { counts.opened.push(path); return { ok: true }; }, ...options });
  const emit = (event: RuntimeEvent) => { for (const listener of listeners) listener(event); };
  return { root, store, share, file, live, emit, commands, counts, close: async () => { live.dispose(); store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("快照来自任务库只读视图，包含暂停、目录与剪贴板状态", async () => {
  const f = await fixture();
  try {
    f.store.setConfig("queue_paused", "1"); f.store.pause("account", "authentication");
    f.live.start(); await Bun.sleep(30);
    const snapshot = f.live.snapshot();
    expect(snapshot.shares.map(share => share.title)).toEqual(["某某合集"]);
    expect(snapshot.files[f.share.id]!.map(file => file.id)).toEqual([f.file.id]);
    expect(snapshot).toMatchObject({ userPaused: true, systemPause: { reason: "authentication" }, outputRoot: f.root, clipboard: "on", quota: { usage: 10n, limit: 100n }, localFree: 5000n, connections: 4, activeFiles: { configured: 1, effective: 1, tier: "unknown" } });
  } finally { await f.close(); }
});

test("进度事件驱动速度与剩余时间；事件区用名称描述", async () => {
  let now = 0; const f = await fixture({ now: () => now, flushMs: 0 });
  try {
    f.live.start();
    f.emit({ type: "downloading", id: f.file.id });
    for (const [at, bytes] of [[0, 0n], [1000, 200n], [2000, 400n]] as const) { now = at; f.emit({ type: "progress", id: f.file.id, bytes, size: 1000n }); }
    expect(f.live.snapshot().progress[f.file.id]).toEqual({ bytes: 400n, size: 1000n, rate: 200, eta: null });
    f.emit({ type: "completed", id: f.file.id });
    expect(f.live.snapshot().progress[f.file.id]).toBe(undefined);
    expect(f.live.snapshot().events.map(event => event.text)).toEqual(["开始下载 episode01.mkv", "episode01.mkv 校验通过，已完成"]);
    f.emit({ type: "scanned", id: f.share.id, count: 1 });
    expect(f.live.snapshot().events.at(-1)?.text).toBe("「某某合集」扫描完成：1 个文件");
  } finally { await f.close(); }
});

test("高频事件合并通知，界面每秒最多重绘 10 次", async () => {
  const f = await fixture({ flushMs: 100, snapshotMs: 60_000 });
  try {
    const notified: number[] = []; f.live.subscribe(() => notified.push(performance.now())); f.live.start(); await Bun.sleep(150); notified.length = 0;
    const started = Date.now();
    while (Date.now() - started < 500) { f.emit({ type: "progress", id: f.file.id, bytes: BigInt(Date.now() - started), size: 1000n }); await Bun.sleep(5); }
    await Bun.sleep(150);
    expect(notified.length).toBeGreaterThanOrEqual(3);
    // 每秒最多 10 次：相邻两次通知至少间隔约 100 ms（计时器允许几毫秒误差）。
    for (let index = 1; index < notified.length; index++) expect(notified[index]! - notified[index - 1]!).toBeGreaterThanOrEqual(95);
  } finally { await f.close(); }
});

test("快照按周期重建，云盘容量在下载等事件后与按周期刷新，本地空间按周期刷新", async () => {
  const f = await fixture({ snapshotMs: 50, quotaMs: 150, localMs: 150, flushMs: 0 });
  try {
    f.live.start(); await Bun.sleep(30);
    expect(f.counts.quota).toBe(1); expect(f.counts.local).toBe(1);
    f.store.cancel("account", f.file.id); await Bun.sleep(80);
    expect(f.live.snapshot().files[f.share.id]![0]!.cancelled).toBe(true);
    f.emit({ type: "downloading", id: f.file.id }); await Bun.sleep(10);
    expect(f.counts.quota).toBe(2);
    await Bun.sleep(400);
    expect(f.counts.quota).toBeGreaterThanOrEqual(4); expect(f.counts.local).toBeGreaterThanOrEqual(3);
  } finally { await f.close(); }
});

test("命令转交会话，剪贴板与停止状态同步；打开目录优先使用文件所在目录", async () => {
  const f = await fixture({ flushMs: 0 });
  try {
    f.live.start();
    await f.live.command({ kind: "setClipboardWatch", enabled: false });
    expect(f.commands).toEqual([{ kind: "setClipboardWatch", enabled: false }]); expect(f.live.snapshot().clipboard).toBe("off");
    f.emit({ type: "clipboard_unavailable" }); expect(f.live.snapshot().clipboard).toBe("unavailable");
    await f.live.openDirectory({ shareId: f.share.id }); expect(f.counts.opened).toEqual([f.root]);
    const target = join(f.root, "某某合集", "episode01.mkv");
    f.store.allocateDelivery("account", f.file.id, join(f.root, "tmp"), target);
    expect(f.live.targetPath(f.file.id)).toBe(target);
    await f.live.openDirectory({ shareId: f.share.id, fileId: f.file.id }); expect(f.counts.opened.at(-1)).toBe(dirname(target));
    f.live.note({ icon: "!", tone: "warning", text: "本地提示" }); expect(f.live.snapshot().events.at(-1)?.text).toBe("本地提示");
    f.live.stop(); f.live.stop(); expect(f.counts.stops).toBe(1); expect(f.live.snapshot().stopping).toBe(true);
    f.live.forceExit(); expect(f.counts.forced).toBe(1);
  } finally { await f.close(); }
});

test("打开目录：按平台构造参数且不经过 shell，目录不存在或是文件时不启动进程", async () => {
  const root = await mkdtemp(join(tmpdir(), "pikpak-open-test-"));
  try {
    const folder = join(root, "带 空格 的目录"); await mkdir(folder); await writeFile(join(root, "file.txt"), "x");
    expect(directoryCommand("win32", folder)).toEqual(["explorer.exe", folder]);
    expect(directoryCommand("darwin", folder)).toEqual(["/usr/bin/open", folder]);
    expect(directoryCommand("linux", folder)).toEqual(["xdg-open", folder]);
    expect(() => directoryCommand("freebsd", folder)).toThrow();
    const launched: string[][] = [];
    expect(await openDirectory(folder, command => { launched.push(command); }, "win32")).toEqual({ ok: true });
    expect(launched).toEqual([["explorer.exe", folder]]);
    expect(await openDirectory(join(root, "missing"), command => { launched.push(command); }, "win32")).toEqual({ ok: false, reason: "output_unavailable" });
    expect(await openDirectory(join(root, "file.txt"), command => { launched.push(command); }, "win32")).toEqual({ ok: false, reason: "output_unavailable" });
    expect(await openDirectory(folder, command => { launched.push(command); }, "freebsd")).toEqual({ ok: false, reason: "unsupported_platform" });
    expect(launched).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("快照中的同时下载文件数取配置值与账号等级上限中的较小值", async () => {
  let tier: "paid" | "free" | "unknown" = "paid";
  const f = await fixture({ tier: () => tier });
  try {
    f.store.setConfig("max_active_files", "3");
    f.live.start(); await Bun.sleep(30);
    expect(f.live.snapshot().activeFiles).toEqual({ configured: 3, effective: 3, tier: "paid" });
    tier = "free"; f.emit({ type: "command", reason: "setActiveFiles" }); await Bun.sleep(150);
    expect(f.live.snapshot().activeFiles).toEqual({ configured: 3, effective: 1, tier: "free" });
  } finally { await f.close(); }
});

test("文件完成后立即刷新本地剩余空间，不等下一个周期", async () => {
  const f = await fixture({ localMs: 60_000, flushMs: 0 });
  try {
    f.live.start(); await Bun.sleep(30);
    const before = f.counts.local;
    f.emit({ type: "completed", id: f.file.id }); await Bun.sleep(30);
    expect(f.counts.local).toBe(before + 1);
    f.emit({ type: "progress", id: f.file.id, bytes: 10n, size: 1000n }); await Bun.sleep(30);
    expect(f.counts.local).toBe(before + 1);
  } finally { await f.close(); }
});

test("已完成文件的本地文件是否仍在：存在、被删除后标为缺失、无法判断时保留上次结果", async () => {
  let unknown = false;
  const f = await fixture({ localMs: 60_000, flushMs: 0, exists: async path => unknown ? null : Bun.file(path).exists() });
  try {
    const target = join(f.root, "episode01.mkv"); await writeFile(target, "x");
    f.store.allocateDelivery("account", f.file.id, join(f.root, "episode01.part"), target);
    f.store.bindTemporary("account", f.file.id, { volume: "volume", file: "identity" });
    for (const state of ["ready", "downloading", "verifying"] as const) f.store.transition("account", f.file.id, state);
    f.store.planPublication("account", f.file.id, { parent: "p", name: "episode01.mkv", tempParent: "t", tempName: "episode01.part", baseName: "episode01.mkv" }, target, "a".repeat(64));
    f.store.completePublication("account", f.file.id, { volume: "volume", file: "identity" }, "a".repeat(64));
    expect(f.store.deliveredTargets("account")).toEqual([{ fileId: f.file.id, targetPath: target }]);
    f.live.start(); await Bun.sleep(30);
    expect(f.live.snapshot().localMissing.has(f.file.id)).toBe(false);
    await rm(target); f.emit({ type: "completed", id: f.file.id }); await Bun.sleep(30);
    expect(f.live.snapshot().localMissing.has(f.file.id)).toBe(true);
    unknown = true; await writeFile(target, "x"); f.emit({ type: "completed", id: f.file.id }); await Bun.sleep(30);
    expect(f.live.snapshot().localMissing.has(f.file.id)).toBe(true);
    unknown = false; f.emit({ type: "completed", id: f.file.id }); await Bun.sleep(30);
    expect(f.live.snapshot().localMissing.has(f.file.id)).toBe(false);
  } finally { await f.close(); }
});

test("账号资料在启动与打开账号页时读取；读取失败保留上次结果", async () => {
  let reads = 0, fail = false;
  const f = await fixture({ account: async () => { reads++; if (fail) throw Error("synthetic-failure");
    return { id: "account", name: `用户${reads}`, email: null, scopes: ["account"], membership: null }; } });
  try {
    expect(f.live.snapshot().account).toBe(null);
    f.live.start(); await Bun.sleep(30);
    expect(f.live.snapshot().account?.name).toBe("用户1");
    f.live.refreshAccount(); await Bun.sleep(30);
    expect(f.live.snapshot().account?.name).toBe("用户2");
    fail = true; f.live.refreshAccount(); await Bun.sleep(30);
    expect(reads).toBe(3); expect(f.live.snapshot().account?.name).toBe("用户2");
  } finally { await f.close(); }
});
