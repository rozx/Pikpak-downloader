import { afterAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { systemFiles } from "../src/platform/file-system";
import type { LocalDirectory, LocalFile, LocalFileSystem } from "../src/platform/files";
import type { PikpakClient } from "../src/pikpak/client";
import { Drive } from "../src/pikpak/drive";
import { Engine, type RuntimeEvent } from "../src/runtime/engine";
import { RuntimeSession } from "../src/runtime/session";
import { IntakeReceiver } from "../src/intake/receiver";
import type { Clipboard } from "../src/intake/clipboard";
import { engineFixture } from "./fixtures/engine";
import { eventually } from "./fixtures/tui";

const nativeFiles = ["darwin", "win32", "linux"].includes(process.platform);
let files: LocalFileSystem | undefined;
const localFiles = () => files ??= systemFiles();
afterAll(async () => { await files?.close(); });

const paid = { cap: 5, refresh: async () => "paid" as const };
type Fixture = Awaited<ReturnType<typeof engineFixture>>;

// 计时的假 CDN 与 API：记录同时在途的下载请求与转存请求数。
function instrument(f: Fixture, options: { delayMs?: number; respond?: (url: string) => Response | undefined } = {}) {
  const state = { downloads: 0, maxDownloads: 0, restores: 0, maxRestores: 0, deletes: [] as Array<{ id: string; active: string[] }> };
  const fetch = async (url: string, init: RequestInit) => {
    state.downloads++; state.maxDownloads = Math.max(state.maxDownloads, state.downloads);
    try {
      await Bun.sleep(options.delayMs ?? 150);
      if (init.signal?.aborted) throw init.signal.reason;
      return options.respond?.(url) ?? await f.fetch(url, init);
    } finally { state.downloads--; }
  };
  let engine!: Engine;
  const api: Pick<PikpakClient, "request"> = { request: async (account, path, init = {}, before) => {
    if (path.endsWith("/share/restore")) {
      state.restores++; state.maxRestores = Math.max(state.maxRestores, state.restores);
      try { await Bun.sleep(20); return await f.api.request(account, path, init, before); } finally { state.restores--; }
    }
    if (path.endsWith("/files:batchDelete")) state.deletes.push({ id: JSON.parse(String(init.body)).ids[0], active: engine.activeFiles().map(target => target.fileId) });
    return f.api.request(account, path, init, before);
  } };
  const events: RuntimeEvent[] = [];
  engine = new Engine(f.store, f.secrets, new Drive(api, "account"), localFiles(), event => events.push(event), fetch, async () => {}, { tier: paid });
  return { engine, state, events };
}
// 反复推进直到没有可做的串行工作、下载池也已清空。
async function drain(engine: Engine, signal = new AbortController().signal) {
  for (let i = 0; i < 400; i++) {
    if (await engine.step(signal)) continue;
    if (!engine.activeFiles().length) return;
    await Bun.sleep(20);
  }
  throw Error("engine-did-not-settle");
}
const completed = (f: Fixture) => f.store.files("account").filter(file => file.state === "completed").length;

test.if(nativeFiles)("同时下载 3 个：最多 3 个文件在途，转存始终串行，全部校验发布后名额释放", async () => {
  const f = await engineFixture(localFiles(), 5); f.state.limit = 10n ** 9n; f.store.setConfig("max_active_files", "3");
  const { engine, state } = instrument(f);
  try {
    await drain(engine);
    expect(completed(f)).toBe(5);
    expect(state.maxDownloads).toBeGreaterThanOrEqual(2); expect(state.maxDownloads).toBeLessThanOrEqual(3);
    expect(state.maxRestores).toBe(1); expect(engine.activeFiles()).toEqual([]);
    for (const file of f.store.files("account")) expect(await readFile(f.store.delivery("account", file.id)!.targetPath)).toEqual(f.sources.find(source => source.id === file.sourceId)!.bytes);
  } finally { await f.close(); }
}, 60000);

test.if(nativeFiles)("账号等级未知或配置为 1 时只走单文件路径", async () => {
  const f = await engineFixture(localFiles(), 3); f.state.limit = 10n ** 9n; f.store.setConfig("max_active_files", "3");
  const { state } = instrument(f);
  const unknown = new Engine(f.store, f.secrets, new Drive(f.api, "account"), localFiles(), () => {}, async (url, init) => {
    state.downloads++; state.maxDownloads = Math.max(state.maxDownloads, state.downloads);
    try { await Bun.sleep(100); return await f.fetch(url, init); } finally { state.downloads--; }
  }, async () => {}, { tier: { cap: 1, refresh: async () => "unknown" as const } });
  try {
    expect(unknown.capacity()).toBe(1);
    await drain(unknown);
    expect(completed(f)).toBe(3); expect(state.maxDownloads).toBe(1);
  } finally { await f.close(); }
}, 60000);

test.if(nativeFiles)("一个文件触发流量配额：暂停执行并停止其余在途文件，它们没有被标记失败", async () => {
  const f = await engineFixture(localFiles(), 3); f.state.limit = 10n ** 9n; f.store.setConfig("max_active_files", "3");
  const { engine } = instrument(f, { delayMs: 300, respond: url => url.endsWith("/copy-2") ? new Response(null, { status: 402 }) : undefined });
  try {
    await drain(engine);
    expect(f.store.paused("account")?.reason).toBe("traffic_quota"); expect(engine.activeFiles()).toEqual([]);
    for (const file of f.store.files("account")) if (file.state !== "completed") expect(file.lastError).toBe(null);
  } finally { await f.close(); }
}, 60000);

test.if(nativeFiles)("一个文件反复失败只影响它自己，其他文件继续完成", async () => {
  const f = await engineFixture(localFiles(), 3); f.state.limit = 10n ** 9n; f.store.setConfig("max_active_files", "3");
  const { engine } = instrument(f, { respond: url => url.endsWith("/copy-2") ? new Response("busy", { status: 503 }) : undefined });
  try {
    await drain(engine);
    const states = f.store.files("account").map(file => file.state);
    expect(states.filter(value => value === "completed")).toHaveLength(2);
    expect(states.filter(value => value === "retry_wait")).toHaveLength(1);
    expect(f.store.paused("account")).toBe(null);
  } finally { await f.close(); }
}, 60000);

test.if(nativeFiles)("云端只能再容纳一个副本：下一个文件等待空间，在途副本从不被删除，完成后的副本才被回收", async () => {
  const f = await engineFixture(localFiles(), 3); f.state.usage = 10n; f.state.limit = 50n; f.store.setConfig("max_active_files", "3");
  const { engine, state } = instrument(f, { delayMs: 200 });
  try {
    for (let round = 0; round < 6 && completed(f) < 3; round++) {
      await drain(engine);
      // 等待空间的文件按 retry_at 延后 60 秒；测试中直接让它到期。
      const db = new Database(join(f.root, "db.sqlite")); db.run("UPDATE files SET retry_at=0 WHERE state='waiting_space'"); db.close();
    }
    expect(completed(f)).toBe(3);
    expect(state.deletes.length).toBeGreaterThan(0);
    for (const removed of state.deletes) {
      const owner = f.store.files("account").find(file => f.store.copyForFile("account", file.id)?.remoteId === removed.id || f.state.deleted.includes(removed.id));
      expect(owner).toBeDefined();
      // 被删除的副本不属于删除当时在途的任何文件。
      for (const active of removed.active) expect(f.store.copyForFile("account", active)?.remoteId).not.toBe(removed.id);
    }
  } finally { await f.close(); }
}, 60000);

test.if(nativeFiles)("多个文件同时下载时各自的进度事件互不挤占", async () => {
  const f = await engineFixture(localFiles(), 2, [64 * 1024, 64 * 1024]); f.state.limit = 10n ** 9n; f.store.setConfig("max_active_files", "2");
  const slow = async (url: string, init: RequestInit) => {
    const response = await f.fetch(url, init); const bytes = new Uint8Array(await response.arrayBuffer());
    const stream = new ReadableStream<Uint8Array>({ async start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 2048) { controller.enqueue(bytes.slice(offset, offset + 2048)); await Bun.sleep(40); }
      controller.close();
    } });
    return new Response(stream, { status: response.status, headers: response.headers });
  };
  const events: RuntimeEvent[] = [];
  const engine = new Engine(f.store, f.secrets, new Drive(f.api, "account"), localFiles(), event => events.push(event), slow, async () => {}, { tier: paid });
  try {
    await drain(engine);
    const ids = f.store.files("account").map(file => file.id);
    for (const id of ids) expect(events.filter(event => event.type === "progress" && event.id === id).length).toBeGreaterThanOrEqual(3);
  } finally { await f.close(); }
}, 60000);

function clipboard(): Clipboard { return { read: async () => ({ sequence: "1", text: "ordinary-unrelated-text" }), close: async () => {} }; }

test.if(nativeFiles)("会话：取消其中一个在途文件时其他文件继续；暂停队列停止全部在途文件；中断后名额全部释放", async () => {
  const f = await engineFixture(localFiles(), 3); f.state.limit = 10n ** 9n; f.store.setConfig("max_active_files", "3");
  const { engine } = instrument(f, { delayMs: 1500 });
  const session = new RuntimeSession(f.store, "account", engine, new IntakeReceiver(f.store, f.secrets, "account", f.root), clipboard());
  const abort = new AbortController(); const running = session.run(abort.signal);
  try {
    await eventually(() => expect(engine.activeFiles().length).toBe(3), 10000);
    const [first, ...rest] = engine.activeFiles();
    expect((await session.command({ kind: "cancel", id: first!.fileId })).ok).toBe(true);
    expect(engine.isPooled(first!.fileId)).toBe(false); expect(f.store.file("account", first!.fileId).cancelled).toBe(true);
    expect(rest.every(target => engine.isPooled(target.fileId))).toBe(true);
    await eventually(() => { for (const target of rest) expect(f.store.file("account", target.fileId).state).toBe("completed"); }, 15000);
    expect(f.store.file("account", first!.fileId).state).not.toBe("completed");
  } finally { abort.abort(); await running; await f.close(); }

  const g = await engineFixture(localFiles(), 3); g.state.limit = 10n ** 9n; g.store.setConfig("max_active_files", "3");
  const second = instrument(g, { delayMs: 1500 });
  const paused = new RuntimeSession(g.store, "account", second.engine, new IntakeReceiver(g.store, g.secrets, "account", g.root), clipboard());
  const stop = new AbortController(); const run = paused.run(stop.signal);
  try {
    await eventually(() => expect(second.engine.activeFiles().length).toBeGreaterThanOrEqual(2), 10000);
    expect((await paused.command({ kind: "pauseQueue" })).ok).toBe(true);
    expect(second.engine.activeFiles()).toEqual([]); expect(g.store.config("queue_paused")).toBe("1");
    await Bun.sleep(600); expect(second.engine.activeFiles()).toEqual([]);
    expect((await paused.command({ kind: "resumeQueue" })).ok).toBe(true);
    await eventually(() => expect(second.engine.activeFiles().length).toBeGreaterThanOrEqual(1), 10000);
    stop.abort(); await run;
    expect(second.engine.activeFiles()).toEqual([]);
  } finally { stop.abort(); await run; await g.close(); }
}, 60000);

// 包装真实文件系统：write 被调用第 failAt 次时抛出指定错误，模拟多个文件同时写入时磁盘写满。
function failingFiles(base: LocalFileSystem, failAt: number, error: Error): LocalFileSystem {
  let writes = 0;
  const wrapFile = (file: LocalFile): LocalFile => ({
    info: () => file.info(), read: (position, length) => file.read(position, length),
    write: async (position, data) => { if (++writes === failAt) throw error; return file.write(position, data); },
    truncate: size => file.truncate(size), sync: () => file.sync(), close: () => file.close(),
  });
  // 每个包装后的目录都带着真实目录，发布时把真实目标交给原生实现。
  const wrapDirectory = (directory: LocalDirectory): LocalDirectory & { inner: LocalDirectory } => ({ inner: directory,
    identity: () => directory.identity(), freeBytes: () => directory.freeBytes(),
    child: async (name, create) => wrapDirectory(await directory.child(name, create)),
    file: async (name, create, readOnly) => wrapFile(await directory.file(name, create, readOnly)),
    publish: (name, target, targetName) => directory.publish(name, (target as LocalDirectory & { inner?: LocalDirectory }).inner ?? target, targetName),
    sync: () => directory.sync(), close: () => directory.close(),
  });
  return { root: async path => wrapDirectory(await base.root(path)), close: async () => {} };
}

test.if(nativeFiles)("取消分享时停止该分享的全部在途文件", async () => {
  const f = await engineFixture(localFiles(), 3); f.state.limit = 10n ** 9n; f.store.setConfig("max_active_files", "3");
  const { engine } = instrument(f, { delayMs: 1500 });
  const session = new RuntimeSession(f.store, "account", engine, new IntakeReceiver(f.store, f.secrets, "account", f.root), clipboard());
  const abort = new AbortController(); const running = session.run(abort.signal);
  try {
    await eventually(() => expect(engine.activeFiles().length).toBeGreaterThanOrEqual(2), 10000);
    expect((await session.command({ kind: "cancel", id: f.share.id })).ok).toBe(true);
    expect(engine.activeFiles()).toEqual([]);
    expect(f.store.files("account").every(file => file.cancelled && file.state !== "completed")).toBe(true);
  } finally { abort.abort(); await running; await f.close(); }
}, 60000);

test.if(nativeFiles)("一个文件被账号限流：记录账号限流并停止其余在途文件，不回收任何副本", async () => {
  const f = await engineFixture(localFiles(), 3); f.state.limit = 10n ** 9n; f.store.setConfig("max_active_files", "3");
  const { engine } = instrument(f, { delayMs: 300, respond: url => url.endsWith("/copy-2") ? new Response(null, { status: 429, headers: { "retry-after": "61" } }) : undefined });
  try {
    await drain(engine);
    expect(f.store.rateLimited("account")).toBe(true); expect(engine.activeFiles()).toEqual([]); expect(f.state.deleted).toHaveLength(0);
    const limited = f.store.files("account").filter(file => file.lastError === "rate_limited");
    expect(limited).toHaveLength(1);
  } finally { await f.close(); }
}, 60000);

test.if(nativeFiles)("多个文件同时写入时本地磁盘写满：暂停执行并停止全部在途文件，恢复后全部完成", async () => {
  const f = await engineFixture(localFiles(), 3, [64 * 1024, 64 * 1024, 64 * 1024]); f.state.limit = 10n ** 9n; f.store.setConfig("max_active_files", "3");
  const disk = failingFiles(localFiles(), 4, Object.assign(Error("ENOSPC"), { code: "ENOSPC" }));
  const slow = async (url: string, init: RequestInit) => { await Bun.sleep(200); return f.fetch(url, init); };
  const engine = new Engine(f.store, f.secrets, new Drive(f.api, "account"), disk, () => {}, slow, async () => {}, { tier: paid });
  try {
    await drain(engine);
    expect(f.store.paused("account")?.reason).toBe("local_space"); expect(engine.activeFiles()).toEqual([]);
    f.store.resume("account", { authenticated: true, permitted: true, writable: true, hasSpace: true, targetAvailable: true, trafficAvailable: true });
    const healthy = new Engine(f.store, f.secrets, new Drive(f.api, "account"), localFiles(), () => {}, f.fetch, async () => {}, { tier: paid });
    await drain(healthy);
    expect(completed(f)).toBe(3);
  } finally { await f.close(); }
}, 60000);

test.if(nativeFiles)("一个文件的云端副本版本变化只影响它自己：记录版本变化并重新扫描，其他文件完成", async () => {
  const f = await engineFixture(localFiles(), 3); f.state.limit = 10n ** 9n; f.store.setConfig("max_active_files", "3");
  // 第二个副本转存完成后，第一次下载请求到达时把它的元数据改为另一个版本。
  const { engine } = instrument(f, { delayMs: 200, respond: url => {
    const copy = url.endsWith("/copy-2") ? f.state.cloud.get("copy-2") : undefined;
    if (copy) f.state.cloud.set("copy-2", { ...copy, hash: "f".repeat(40) });
    return undefined;
  } });
  try {
    await drain(engine);
    const files = f.store.files("account");
    expect(files.filter(file => file.state === "completed")).toHaveLength(2);
    expect(files.filter(file => file.lastError === "version_changed")).toHaveLength(1);
    expect(f.store.paused("account")).toBe(null);
  } finally { await f.close(); }
}, 60000);

test.if(nativeFiles)("多个文件下载中停止会话，重新启动后各自从断点继续完成", async () => {
  const f = await engineFixture(localFiles(), 3, [64 * 1024, 64 * 1024, 64 * 1024]); f.state.limit = 10n ** 9n; f.store.setConfig("max_active_files", "3");
  const slowStream = async (url: string, init: RequestInit) => {
    const response = await f.fetch(url, init); const bytes = new Uint8Array(await response.arrayBuffer());
    const stream = new ReadableStream<Uint8Array>({ async start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 4096) {
        if (init.signal?.aborted) { controller.error(init.signal.reason); return; }
        controller.enqueue(bytes.slice(offset, offset + 4096)); await Bun.sleep(60);
      }
      controller.close();
    } });
    return new Response(stream, { status: response.status, headers: response.headers });
  };
  const first = new Engine(f.store, f.secrets, new Drive(f.api, "account"), localFiles(), () => {}, slowStream, async () => {}, { tier: paid });
  const session = new RuntimeSession(f.store, "account", first, new IntakeReceiver(f.store, f.secrets, "account", f.root), clipboard());
  const abort = new AbortController(); const running = session.run(abort.signal);
  try {
    await eventually(() => expect(first.activeFiles().length).toBe(3), 10000);
    await Bun.sleep(400);
    abort.abort(); await running;
    expect(first.activeFiles()).toEqual([]); expect(completed(f)).toBe(0);
    const resumed = new Engine(f.store, f.secrets, new Drive(f.api, "account"), localFiles(), () => {}, f.fetch, async () => {}, { tier: paid });
    await drain(resumed);
    expect(completed(f)).toBe(3);
    for (const file of f.store.files("account")) expect(await readFile(f.store.delivery("account", file.id)!.targetPath)).toEqual(f.sources.find(source => source.id === file.sourceId)!.bytes);
  } finally { abort.abort(); await running; await f.close(); }
}, 60000);

test.if(nativeFiles)("每个在途文件各自使用连接数设置，不因同时下载的文件数而减少", async () => {
  const size = 8 * 1048576 + 1;
  const f = await engineFixture(localFiles(), 5, Array(5).fill(size)); f.state.limit = 10n ** 12n;
  f.store.setConfig("max_active_files", "5"); f.store.setConfig("download_connections", "2");
  // 按副本统计同时在途的 Range 请求（直到响应体读完）。
  const active = new Map<string, number>(), peak = new Map<string, number>();
  const fetch = async (url: string, init: RequestInit) => {
    const copy = new URL(url).pathname;
    active.set(copy, (active.get(copy) ?? 0) + 1); peak.set(copy, Math.max(peak.get(copy) ?? 0, active.get(copy)!));
    const response = await f.fetch(url, init);
    const reader = response.body!.getReader(); let open = true;
    const done = () => { if (open) { open = false; active.set(copy, active.get(copy)! - 1); } };
    const stream = new ReadableStream<Uint8Array>({
      // 响应体放慢（每 64 KiB 约 20 ms），让慢启动有时间加入第二个连接；本地写入已是磁盘速度。
      async pull(controller) {
        const part = await reader.read();
        if (part.done) { done(); controller.close(); return; }
        for (let at = 0; at < part.value.byteLength; at += 65536) { controller.enqueue(part.value.subarray(at, at + 65536)); await Bun.sleep(20); }
      },
      cancel() { done(); reader.cancel().catch(() => {}); },
    });
    return new Response(stream, { status: response.status, headers: response.headers });
  };
  const engine = new Engine(f.store, f.secrets, new Drive(f.api, "account"), localFiles(), () => {}, fetch, async () => {}, { tier: paid });
  try {
    await drain(engine);
    expect(completed(f)).toBe(5);
    expect(peak.size).toBe(5);
    // 旧的全局预算下 5 个文件各只能 1 个连接；现在至少有文件用到了自己的 2 个连接，且没有文件超过设置。
    expect(Math.max(...peak.values())).toBe(2);
    expect([...peak.values()].every(value => value <= 2)).toBe(true);
  } finally { await f.close(); }
}, 120000);

