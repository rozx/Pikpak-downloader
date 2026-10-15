import { afterAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { systemFiles } from "../src/platform/file-system";
import { Drive } from "../src/pikpak/drive";
import type { PikpakClient } from "../src/pikpak/client";
import { Engine, type RuntimeEvent } from "../src/runtime/engine";
import type { LocalFileSystem } from "../src/platform/files";
import { engineFixture } from "./fixtures/engine";

// 手动释放云端副本（add-task-controls 任务 3.1）：引擎层的调度排除、断点续传与云端操作锁。
const nativeFiles = process.platform === "darwin" || process.platform === "win32";
let files: LocalFileSystem | undefined;
const localFiles = () => files ??= systemFiles();
afterAll(async () => { await files?.close(); });

type Fixture = Awaited<ReturnType<typeof engineFixture>>;
// 与夹具共用假服务，但可以拦截请求并收集事件；可选同时下载上限。
function engineFor(f: Fixture, options: { gate?: (path: string) => Promise<void>; fetch?: Fixture["fetch"]; cap?: number } = {}) {
  const events: RuntimeEvent[] = [];
  const api: Pick<PikpakClient, "request"> = { request: async (account, path, init, before) => { await options.gate?.(path); return f.api.request(account, path, init, before); } };
  const engine = new Engine(f.store, f.secrets, new Drive(api, "account"), localFiles(), event => events.push(event), options.fetch ?? f.fetch, async () => {},
    options.cap ? { tier: { refresh: async () => "paid" as const, cap: options.cap } } : {});
  return { engine, events };
}
const MiB = 1048576;

test.if(nativeFiles)("暂停中的文件释放副本后改回就绪、保留断点；继续时重新转存并从断点完成", async () => {
  const f = await engineFixture(localFiles(), 1, [3 * MiB]); f.state.limit = 1000n * BigInt(MiB);
  const ranges: string[] = []; let hold = true;
  // 第一次下载只给 1.5 MiB 后挂起，直到被中断；此时检查点停在 1.5 MiB。
  const fetch = async (url: string, init: RequestInit) => {
    ranges.push(new Headers(init.headers).get("range")!);
    if (!hold) return f.fetch(url, init);
    const full = await (await f.fetch(url, init)).arrayBuffer();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(full.slice(0, 1.5 * MiB)));
      init.signal?.addEventListener("abort", () => controller.error(Error("aborted")), { once: true });
    } });
    return new Response(body, { status: 206, headers: { "content-range": `bytes 0-${3 * MiB - 1}/${3 * MiB}` } });
  };
  const { engine, events } = engineFor(f, { fetch });
  try {
    const step = new AbortController();
    await engine.step(step.signal); // 扫描
    const file = f.store.files("account")[0]!;
    const running = engine.step(step.signal);
    while (f.store.persistedBytes("account", file.id) < 1.5 * MiB) await Bun.sleep(5);
    // 串行步骤正在处理的文件不能释放。
    expect(engine.releasable(file.id)).toEqual({ ok: false, reason: "copy_in_use" });
    step.abort(); expect(await running).toBe(false);
    f.store.pauseTask("account", file.id);
    expect(f.store.file("account", file.id).state).toBe("downloading");
    // 全部释放只处理已完成的任务：暂停中的未完成文件不在其中。
    expect(engine.releasable(null)).toEqual({ ok: false, reason: "copy_absent" });
    expect(engine.releasable(file.id)).toEqual({ ok: true, copies: 1, bytes: BigInt(3 * MiB), unfinished: 1, removed: 0 });
    expect(engine.release(file.id, new AbortController().signal)).toMatchObject({ ok: true, copies: 1 });
    // 释放进行中：同一文件不能再次释放。
    expect(engine.releasable(file.id)).toEqual({ ok: false, reason: "copy_in_use" });
    await engine.settleReleases();
    expect(f.state.deleted).toEqual(["copy-1"]); expect(events.filter(event => event.type === "copy_released")).toEqual([{ type: "copy_released", id: file.id, bytes: BigInt(3 * MiB) }]);
    expect(f.store.file("account", file.id).state).toBe("ready"); expect(f.store.persistedBytes("account", file.id)).toBe(BigInt(1.5 * MiB));
    expect(engine.releasable(file.id)).toEqual({ ok: false, reason: "copy_absent" });

    hold = false; ranges.length = 0; f.store.resumeTask("account", file.id);
    const signal = new AbortController().signal;
    for (let i = 0; i < 5 && f.store.file("account", file.id).state !== "completed"; i++) await engine.step(signal);
    expect(f.store.file("account", file.id).state).toBe("completed"); expect(f.state.saves).toBe(2);
    expect(ranges[0]).toStartWith(`bytes=${1.5 * MiB}-`);
    expect(await readFile(f.store.delivery("account", file.id)!.targetPath)).toEqual(f.sources[0]!.bytes);
  } finally { await f.close(); }
});

test.if(nativeFiles)("下载池中的文件不能释放；已完成文件释放后自动回收不再选它；非本工具创建的副本不释放", async () => {
  const f = await engineFixture(localFiles(), 2); f.state.limit = 1000n;
  let hold = true;
  const fetch = async (url: string, init: RequestInit) => {
    if (!hold || !url.endsWith("copy-2")) return f.fetch(url, init);
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { init.signal?.addEventListener("abort", () => controller.error(Error("aborted")), { once: true }); } }),
      { status: 206, headers: { "content-range": "bytes 0-39/40" } });
  };
  f.store.setConfig("max_active_files", "2");
  const { engine, events } = engineFor(f, { fetch, cap: 5 });
  try {
    const signal = new AbortController().signal;
    for (let i = 0; i < 10 && engine.activeFiles().length < 2 && f.state.saves < 2; i++) await engine.step(signal);
    const [first, second] = f.store.fileViews("account", f.share.id);
    // 第一个文件完成并离开下载池；第二个文件的下载被挂起，留在池中。
    while (f.store.file("account", first!.id).state !== "completed" || engine.activeFiles().length !== 1) await Bun.sleep(5);
    expect(engine.activeFiles().map(target => target.fileId)).toEqual([second!.id]);
    expect(engine.releasable(second!.id)).toEqual({ ok: false, reason: "copy_in_use" });
    // 分享范围只包含可以释放的那份。
    expect(engine.releasable(f.share.id)).toEqual({ ok: true, copies: 1, bytes: 40n, unfinished: 0, removed: 1 });
    engine.release(f.share.id, signal); await engine.settleReleases();
    expect(f.state.deleted).toEqual(["copy-1"]); expect(f.store.candidates("account")).toEqual([]);
    expect(events.some(event => event.type === "copy_released" && event.id === first!.id && event.reason === "removed")).toBe(true);
    // 已完成文件的记录随释放删除；分享还有文件，保留。
    expect(f.store.fileViews("account", f.share.id).map(file => file.id)).toEqual([second!.id]);
    await engine.stopActive();
    const db = new Database(f.store.path); db.run("UPDATE copies SET ownership='unverified', evidence_json=NULL"); db.close();
    expect(engine.releasable(second!.id)).toEqual({ ok: false, reason: "copy_not_owned" });
  } finally { hold = false; await engine.stopActive(); await f.close(); }
});

test.if(nativeFiles)("云端操作锁：手动释放进行时，自动回收等待，不会同时为同一副本发出删除", async () => {
  const f = await engineFixture(localFiles(), 2);
  // 只拦住手动释放读取 copy-1 元数据的那一次（下载第一个文件时的读取不拦）。
  let open: () => void = () => {}; let armed = false, gated = false;
  const gate = (path: string) => {
    if (!armed || gated || path !== "/drive/v1/files/copy-1") return Promise.resolve();
    gated = true; return new Promise<void>(resolve => { open = resolve; });
  };
  const { engine, events } = engineFor(f, { gate });
  try {
    const signal = new AbortController().signal;
    await engine.step(signal); // 扫描
    const first = f.store.fileViews("account", f.share.id)[0]!;
    while (f.store.file("account", first.id).state !== "completed") await engine.step(signal);
    expect(f.state.usage).toBe(50n);
    armed = true; expect(engine.release(first.id, signal)).toMatchObject({ ok: true });
    // 第二个文件需要空间：没有锁时自动回收会立即删除 copy-1；有锁时等待手动释放结束。
    const stepping = engine.step(signal);
    await Bun.sleep(100);
    expect(f.state.deleted).toEqual([]); expect(f.state.saves).toBe(1);
    open(); await engine.settleReleases(); await stepping;
    for (let i = 0; i < 5 && f.store.summary("account", f.share.id).status !== "completed"; i++) await engine.step(signal);
    // 第一个文件随释放删除了记录，分享里只剩第二个文件。
    expect(f.store.summary("account", f.share.id)).toMatchObject({ status: "completed", total: 1, completed: 1 });
    expect(f.state.deleted).toEqual(["copy-1"]); expect(events.filter(event => event.type === "copy_released")).toHaveLength(1);
    expect(f.store.unresolved("account")).toEqual([]);
  } finally { await f.close(); }
});

test.if(nativeFiles)("释放后删除记录：已完成文件随副本删除；被自动回收过的已完成文件直接删除记录；分享的文件都删除后分享与访问资料一并删除", async () => {
  const f = await engineFixture(localFiles(), 2);
  const { engine, events } = engineFor(f);
  try {
    const signal = new AbortController().signal;
    // 容量只够一个文件：第二个文件转存前自动回收第一个文件的副本。
    for (let i = 0; i < 10 && f.store.summary("account", f.share.id).status !== "completed"; i++) await engine.step(signal);
    const [first, second] = f.store.fileViews("account", f.share.id);
    expect(f.state.deleted).toEqual(["copy-1"]); expect(first!.copyState).toBe("deleted"); expect(second!.copyState).toBe("retained");
    const reference = f.store.share("account", f.share.id).secretRef;
    expect(await f.secrets.get(reference)).not.toBe(null);
    // 第一个文件云盘里已没有副本：只删记录。
    expect(engine.releasable(first!.id)).toEqual({ ok: true, copies: 0, bytes: 0n, unfinished: 0, removed: 1 });
    engine.release(first!.id, signal); await engine.settleReleases();
    expect(events.filter(event => event.type === "task_removed")).toEqual([{ type: "task_removed", id: first!.id }]);
    expect(f.store.fileViews("account", f.share.id).map(file => file.id)).toEqual([second!.id]);
    // 本地文件不动。
    expect(await readFile(f.store.delivery("account", second!.id)!.targetPath)).toEqual(f.sources[1]!.bytes);
    // 释放整个分享：最后一个文件的副本删除、记录删除，分享与访问资料随之删除。
    expect(engine.releasable(f.share.id)).toEqual({ ok: true, copies: 1, bytes: 40n, unfinished: 0, removed: 1 });
    engine.release(f.share.id, signal); await engine.settleReleases();
    expect(f.state.deleted).toEqual(["copy-1", "copy-2"]);
    expect(events.map(event => event.type).filter(type => ["copy_released", "share_removed"].includes(type))).toEqual(["copy_released", "share_removed"]);
    expect(f.store.shareViews("account")).toEqual([]); expect(await f.secrets.get(reference)).toBe(null);
    expect(() => engine.releasable(f.share.id)).toThrow();
  } finally { await f.close(); }
});

test.if(nativeFiles)("全部释放：释放全部已完成任务的副本并删除记录，释放期间文件列为释放中；本地文件保留", async () => {
  const f = await engineFixture(localFiles(), 2); f.state.limit = 1000n;
  const { engine, events } = engineFor(f);
  try {
    const signal = new AbortController().signal;
    for (let i = 0; i < 10 && f.store.summary("account", f.share.id).status !== "completed"; i++) await engine.step(signal);
    const files = f.store.fileViews("account", f.share.id), targets = files.map(file => f.store.delivery("account", file.id)!.targetPath);
    expect(engine.releasable(null)).toEqual({ ok: true, copies: 2, bytes: 80n, unfinished: 0, removed: 2 });
    expect(engine.release(null, signal)).toMatchObject({ ok: true, copies: 2 });
    expect(engine.releasingFiles().sort()).toEqual(files.map(file => file.id).sort());
    await engine.settleReleases();
    expect(engine.releasingFiles()).toEqual([]);
    expect(f.state.deleted.sort()).toEqual(["copy-1", "copy-2"]); expect(events.filter(event => event.type === "copy_released")).toHaveLength(2);
    expect(f.store.shareViews("account")).toEqual([]);
    for (const [index, target] of targets.entries()) expect(await readFile(target)).toEqual(f.sources[index]!.bytes);
  } finally { await f.close(); }
});
