import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/state/store";
import { IntakeReceiver } from "../src/intake/receiver";
import { loadShareAccess } from "../src/auth/share-access";
import { Drive } from "../src/pikpak/drive";
import { Engine, type RuntimeEvent } from "../src/runtime/engine";
import { RuntimeSession, type SessionEngine } from "../src/runtime/session";
import { systemFiles } from "../src/platform/file-system";
import type { LocalFileSystem } from "../src/platform/files";
import type { Clipboard } from "../src/intake/clipboard";
import { engineFixture } from "./fixtures/engine";

const nativeFiles = process.platform === "darwin" || process.platform === "win32";
let files: LocalFileSystem | undefined;
const localFiles = () => files ??= systemFiles();
afterAll(async () => { await files?.close(); });

async function until(condition: () => boolean, timeout = 8000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) { if (Date.now() > deadline) throw Error("condition-timeout"); await Bun.sleep(10); }
}
function memorySecrets() {
  const values = new Map<string, string>();
  return { get: async (key: string) => values.get(key) ?? null, set: async (key: string, value: string) => { values.set(key, value); },
    delete: async (key: string) => { values.delete(key); } };
}
function fakeEngine(step: (signal: AbortSignal) => Promise<boolean>) {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const engine: SessionEngine = { step, resumeLocalPause: async () => {}, resumeTrafficPause: async () => {}, reconcile: async () => {}, blockPersistence: () => {},
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  return { engine, emit: (event: RuntimeEvent) => { for (const listener of listeners) listener(event); } };
}
function fakeClipboard(text = "ordinary-unrelated-text") {
  const state = { reads: 0, closes: 0, sequence: "1", text };
  const clipboard: Clipboard = { read: async () => { state.reads++; return { sequence: state.sequence, text: state.text }; }, close: async () => { state.closes++; } };
  return { clipboard, state };
}
async function storeFixture() {
  const root = await mkdtemp(join(tmpdir(), "pikpak-session-test-")); const store = new Store(join(root, "db.sqlite")); const secrets = memorySecrets();
  store.ensureAccount("account");
  const share = store.accept("account", "synthetic-remote", root, "reference"); const scan = store.claimScan("account", share.id)!;
  const first = store.mergeFile(scan, { sourceId: "first", gcid: "a".repeat(40), size: 10n, relativePath: "first.bin" });
  const second = store.mergeFile(scan, { sourceId: "second", gcid: "b".repeat(40), size: 10n, relativePath: "second.bin" });
  store.fileError("account", first.id, "network_failure");
  return { root, store, secrets, share, first, second, receiver: new IntakeReceiver(store, secrets, "account", root),
    close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("命令在两次步骤之间按序执行", async () => {
  const f = await storeFixture(); const log: string[] = []; let release!: () => void; let steps = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { engine } = fakeEngine(async () => {
    if (++steps === 1) { log.push("step-start"); await gate; log.push("step-end"); return true; }
    await Bun.sleep(5); return false;
  });
  const session = new RuntimeSession(f.store, "account", engine, f.receiver, fakeClipboard().clipboard);
  session.subscribe(event => { if (event.type === "command") log.push(`command:${event.reason}`); });
  const abort = new AbortController(); const running = session.run(abort.signal);
  try {
    await until(() => log.includes("step-start"));
    const results = Promise.all([session.command({ kind: "retry", id: f.first.id }), session.command({ kind: "cancel", id: f.second.id }), session.command({ kind: "resumeQueue" })]);
    await Bun.sleep(50); expect(log).toEqual(["step-start"]);
    release(); expect((await results).every(result => result.ok)).toBe(true);
    expect(log).toEqual(["step-start", "step-end", "command:retry", "command:cancel", "command:resumeQueue"]);
    expect(f.store.file("account", f.first.id).state).toBe("ready"); expect(f.store.file("account", f.second.id).cancelled).toBe(true);
  } finally { abort.abort(); await running; await f.close(); }
});

test("暂停和取消当前执行项会中断当前步骤，取消其他文件不中断", async () => {
  const f = await storeFixture(); const log: string[] = []; let steps = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fake = fakeEngine(async signal => {
    const index = ++steps;
    if (index > 2) { await Bun.sleep(5); return false; }
    fake.emit({ type: "downloading", id: f.first.id }); log.push(`step-${index}-start`);
    await Promise.race([gate, new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }))]);
    log.push(signal.aborted ? `step-${index}-aborted` : `step-${index}-end`); return false;
  });
  const session = new RuntimeSession(f.store, "account", fake.engine, f.receiver, fakeClipboard().clipboard);
  session.subscribe(event => { if (event.type === "command") log.push(`command:${event.reason}:${event.id ?? ""}`); });
  const abort = new AbortController(); const running = session.run(abort.signal);
  try {
    await until(() => log.includes("step-1-start"));
    const other = session.command({ kind: "cancel", id: f.second.id });
    await Bun.sleep(80); expect(log).toEqual(["step-1-start"]);
    expect((await session.command({ kind: "cancel", id: f.first.id })).ok).toBe(true); await other;
    expect(log.slice(0, 4)).toEqual(["step-1-start", "step-1-aborted", `command:cancel:${f.second.id}`, `command:cancel:${f.first.id}`]);
    await until(() => log.includes("step-2-start"));
    expect((await session.command({ kind: "pauseQueue" })).ok).toBe(true);
    expect(log.slice(-2)).toEqual(["step-2-aborted", "command:pauseQueue:"]);
    expect(f.store.config("queue_paused")).toBe("1");
  } finally { release(); abort.abort(); await running; await f.close(); }
});

test.if(nativeFiles)("取消下载中的文件后断点与云端副本保留，其他文件继续", async () => {
  const f = await engineFixture(localFiles(), 2, [3 * 1024 * 1024, 40]); f.state.limit = 10n ** 9n;
  const slow = async (url: string, init: RequestInit) => {
    const response = await f.fetch(url, init); const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 1024) return new Response(bytes, { status: response.status, headers: response.headers });
    const stream = new ReadableStream<Uint8Array>({ async start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 65536) { controller.enqueue(bytes.slice(offset, offset + 65536)); await Bun.sleep(25); }
      controller.close();
    } });
    return new Response(stream, { status: response.status, headers: response.headers });
  };
  const engine = new Engine(f.store, f.secrets, new Drive(f.api, "account"), localFiles(), () => {}, slow, async () => {});
  const session = new RuntimeSession(f.store, "account", engine, new IntakeReceiver(f.store, f.secrets, "account", f.root), fakeClipboard().clipboard);
  const abort = new AbortController(); const running = session.run(abort.signal);
  try {
    const large = () => f.store.files("account").find(file => file.size === 3n * 1024n * 1024n);
    await until(() => { const file = large(); return !!file && (f.store.delivery("account", file.id)?.checkpoint ?? 0n) >= 1048576n; }, 20000);
    const target = large()!;
    expect((await session.command({ kind: "cancel", id: target.id })).ok).toBe(true);
    const cancelled = f.store.file("account", target.id); const delivery = f.store.delivery("account", target.id)!;
    expect(cancelled.cancelled).toBe(true); expect(cancelled.state).not.toBe("completed");
    expect(delivery.checkpoint >= 1048576n).toBe(true); expect(existsSync(delivery.tempPath)).toBe(true);
    expect(f.store.copyForFile("account", target.id)?.state).toBe("retained");
    await until(() => f.store.files("account").some(file => file.size === 40n && file.state === "completed"), 20000);
    expect(f.store.file("account", target.id).state).not.toBe("completed");
  } finally { abort.abort(); await running; await f.close(); }
}, 40000);

test.if(nativeFiles)("暂停后重建会话仍暂停，继续后恢复调度", async () => {
  const f = await engineFixture(localFiles(), 1); let requests = 0;
  const countingEngine = () => new Engine(f.store, f.secrets, new Drive({ request: async (account, path, init = {}, before) => { requests++; return f.api.request(account, path, init, before); } }, "account"),
    localFiles(), () => {}, async (url, init) => { requests++; return f.fetch(url, init); }, async () => {});
  const receiver = () => new IntakeReceiver(f.store, f.secrets, "account", f.root);
  try {
    const first = new RuntimeSession(f.store, "account", fakeEngine(async () => { await Bun.sleep(5); return false; }).engine, receiver(), fakeClipboard().clipboard);
    const stopFirst = new AbortController(); const runningFirst = first.run(stopFirst.signal);
    expect((await first.command({ kind: "pauseQueue" })).ok).toBe(true);
    stopFirst.abort(); await runningFirst;
    const second = new RuntimeSession(f.store, "account", countingEngine(), receiver(), fakeClipboard().clipboard);
    const stopSecond = new AbortController(); const runningSecond = second.run(stopSecond.signal);
    try {
      await Bun.sleep(400);
      expect(requests).toBe(0); expect(f.store.files("account")).toHaveLength(0);
      expect((await second.command({ kind: "resumeQueue" })).ok).toBe(true);
      await until(() => requests > 0);
    } finally { stopSecond.abort(); await runningSecond; }
  } finally { await f.close(); }
});

test("手动提交与剪贴板同一规则，不与先前输入拼接，也不重复接收剪贴板旧内容", async () => {
  const f = await storeFixture(); const received: string[] = [];
  const link = "https://mypikpak.com/s/synthetic-manual";
  const clip = fakeClipboard(link);
  const session = new RuntimeSession(f.store, "account", fakeEngine(async () => { await Bun.sleep(5); return false; }).engine, f.receiver, clip.clipboard);
  session.subscribe(event => { if (event.type === "received") received.push(event.id!); });
  const abort = new AbortController(); const running = session.run(abort.signal);
  try {
    await until(() => received.length === 1);
    const share = f.store.findShare("account", "synthetic-manual")!;
    expect((await loadShareAccess(f.secrets, share.secretRef, "account", share.remoteId)).passCode).toBe("");
    const codeOnly = await session.command({ kind: "submitText", text: "提取码：abcd" });
    expect(codeOnly).toEqual({ ok: true, ids: [], issues: [] });
    expect((await loadShareAccess(f.secrets, f.store.share("account", share.id).secretRef, "account", share.remoteId)).passCode).toBe("");
    const full = await session.command({ kind: "submitText", text: `${link}\n\n提取码：abcd` });
    expect(full).toEqual({ ok: true, ids: [share.id], issues: [] });
    const updated = f.store.share("account", share.id);
    expect(updated.requestedRevision).toBe(share.requestedRevision + 1n);
    expect((await loadShareAccess(f.secrets, updated.secretRef, "account", share.remoteId)).passCode).toBe("abcd");
    const reads = clip.state.reads; await until(() => clip.state.reads >= reads + 2);
    expect(received).toEqual([share.id, share.id]);
  } finally { abort.abort(); await running; await f.close(); }
});

test("修改下载目录：新分享与尚未开始的分享改用新目录，已开始的分享保留原目录，不可用目录被拒绝", async () => {
  const f = await storeFixture(); const next = join(f.root, "新目录"); await mkdir(next);
  // f.share 已在本地开始（根目录已打开）；waiting 只接收过、本地还没有任何内容。
  f.store.bindRoot("account", f.share.id, { volume: "volume", file: "root" });
  const waiting = f.store.accept("account", "synthetic-waiting", f.root, "reference-waiting");
  const events: RuntimeEvent[] = [];
  const session = new RuntimeSession(f.store, "account", fakeEngine(async () => { await Bun.sleep(5); return false; }).engine, f.receiver, fakeClipboard().clipboard);
  session.subscribe(event => events.push(event));
  const abort = new AbortController(); const running = session.run(abort.signal);
  try {
    expect(await session.command({ kind: "setOutputRoot", path: join(f.root, "missing") })).toEqual({ ok: false, reason: "output_unavailable" });
    expect(await session.command({ kind: "setOutputRoot", path: next })).toEqual({ ok: true, ids: [waiting.id], issues: [] });
    expect(f.store.config("output_root")).toBe(await realpath(next));
    expect(events.find(event => event.type === "command" && event.reason === "setOutputRoot")?.count).toBe(1);
    const result = await session.command({ kind: "submitText", text: "https://mypikpak.com/s/synthetic-next" });
    expect(result.ok && f.store.share("account", result.ids[0]!).outputRoot).toBe(await realpath(next));
    expect(f.store.share("account", waiting.id).outputRoot).toBe(await realpath(next));
    expect(f.store.share("account", f.share.id).outputRoot).toBe(f.root);
  } finally { abort.abort(); await running; await f.close(); }
});

test("队列暂停期间仍接收并保存新分享；重新复制已取消的分享显示已取消且不自动恢复", async () => {
  const f = await storeFixture(); f.store.setConfig("queue_paused", "1"); const events: RuntimeEvent[] = [];
  const clip = fakeClipboard("https://mypikpak.com/s/synthetic-paused");
  const session = new RuntimeSession(f.store, "account", fakeEngine(async () => { await Bun.sleep(5); return false; }).engine, f.receiver, clip.clipboard);
  session.subscribe(event => events.push(event));
  const abort = new AbortController(); const running = session.run(abort.signal);
  try {
    await until(() => events.some(event => event.type === "received"));
    const share = f.store.findShare("account", "synthetic-paused")!;
    expect(share.cancelled).toBe(false);
    expect((await session.command({ kind: "cancel", id: share.id })).ok).toBe(true);
    clip.state.sequence = "2"; await until(() => events.some(event => event.type === "received_cancelled"));
    expect(f.store.share("account", share.id).cancelled).toBe(true);
    expect(f.store.config("queue_paused")).toBe("1");
  } finally { abort.abort(); await running; await f.close(); }
});

test("关闭剪贴板监听后不再读取，重新开启后恢复", async () => {
  const f = await storeFixture(); const clip = fakeClipboard(); const events: RuntimeEvent[] = [];
  f.store.setConfig("clipboard_watch", "0");
  const session = new RuntimeSession(f.store, "account", fakeEngine(async () => { await Bun.sleep(5); return false; }).engine, f.receiver, clip.clipboard);
  session.subscribe(event => events.push(event));
  const abort = new AbortController(); const running = session.run(abort.signal);
  try {
    await Bun.sleep(700);
    expect(clip.state.reads).toBe(0); expect(events[0]).toEqual({ type: "started", reason: "clipboard_off" });
    expect((await session.command({ kind: "setClipboardWatch", enabled: true })).ok).toBe(true);
    await until(() => clip.state.reads > 0); expect(f.store.config("clipboard_watch")).toBe("1");
    expect((await session.command({ kind: "setClipboardWatch", enabled: false })).ok).toBe(true);
    const reads = clip.state.reads; await Bun.sleep(1200);
    expect(clip.state.reads).toBe(reads); expect(clip.state.closes).toBeGreaterThan(0); expect(f.store.config("clipboard_watch")).toBe("0");
  } finally { abort.abort(); await running; await f.close(); }
});

test("设置下载连接数：合法值写入任务库，越界值被拒绝并保留原值", async () => {
  const f = await storeFixture();
  const session = new RuntimeSession(f.store, "account", fakeEngine(async () => { await Bun.sleep(5); return false; }).engine, f.receiver, fakeClipboard().clipboard);
  const events: RuntimeEvent[] = []; session.subscribe(event => events.push(event));
  const abort = new AbortController(); const running = session.run(abort.signal);
  try {
    expect((await session.command({ kind: "setDownloadConnections", count: 6 })).ok).toBe(true);
    expect(f.store.config("download_connections")).toBe("6");
    expect(events.some(event => event.type === "command" && event.reason === "setDownloadConnections")).toBe(true);
    for (const count of [0, 9, 2.5]) expect(await session.command({ kind: "setDownloadConnections", count })).toEqual({ ok: false, reason: "invalid_input" });
    expect(f.store.config("download_connections")).toBe("6");
  } finally { abort.abort(); await running; await f.close(); }
});

