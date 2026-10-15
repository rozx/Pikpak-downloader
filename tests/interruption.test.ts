import { afterAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Drive } from "../src/pikpak/drive";
import { Engine } from "../src/runtime/engine";
import type { PikpakClient } from "../src/pikpak/client";
import { systemFiles } from "../src/platform/file-system";
import type { LocalFileSystem } from "../src/platform/files";
import { engineFixture } from "./fixtures/engine";

const nativeFiles = process.platform === "darwin" || process.platform === "win32";
let files: LocalFileSystem | undefined;
const localFiles = () => files ??= systemFiles();
afterAll(async () => { await files?.close(); });
type Fixture = Awaited<ReturnType<typeof engineFixture>>;

// 在指定请求发出前或返回后中断当前步骤，模拟界面暂停/取消或进程退出时网络操作的各个时点。
function interruptingApi(f: Fixture, controller: AbortController, trigger: (path: string, phase: "before" | "after") => boolean): Pick<PikpakClient, "request"> {
  let fired = false;
  const fire = (path: string, phase: "before" | "after") => {
    if (fired || !trigger(path, phase)) return;
    fired = true; controller.abort(); throw controller.signal.reason;
  };
  return { request: async (account, path, init = {}, before) => {
    fire(path, "before");
    const result = await f.api.request(account, path, init, before);
    fire(path, "after");
    return result;
  } };
}
async function interruptedRun(f: Fixture, api: Pick<PikpakClient, "request">, controller: AbortController, http = f.fetch) {
  const engine = new Engine(f.store, f.secrets, new Drive(api, "account"), localFiles(), () => {}, http, async () => {});
  for (let i = 0; i < 20 && !controller.signal.aborted && await engine.step(controller.signal); i++) {}
  expect(controller.signal.aborted).toBe(true);
}
// 中断后以全新执行器恢复：先核对未知操作，再继续调度。
async function restartedRun(f: Fixture, http = f.fetch) {
  const signal = new AbortController().signal;
  const engine = new Engine(f.store, f.secrets, new Drive(f.api, "account"), localFiles(), () => {}, http, async () => {});
  await engine.reconcile(signal);
  for (let i = 0; i < 20 && await engine.step(signal); i++) {}
}
async function expectDelivered(f: Fixture) {
  for (const file of f.store.files("account")) {
    expect(file.state).toBe("completed");
    expect(await readFile(f.store.delivery("account", file.id)!.targetPath)).toEqual(f.sources.find(source => source.id === file.sourceId)!.bytes);
  }
}

test.if(nativeFiles)("下载中途中断后断点不倒退，重启从断点续传并完成校验", async () => {
  const f = await engineFixture(localFiles(), 1, [3 * 1024 * 1024]); f.state.limit = 10n ** 9n;
  try {
    const controller = new AbortController();
    const cut = async (url: string, init: RequestInit) => {
      const response = await f.fetch(url, init); const bytes = new Uint8Array(await response.arrayBuffer()); let offset = 0;
      // 按需拉取，使中断发生在下载方确实读到 1.5 MiB 之后。
      const stream = new ReadableStream<Uint8Array>({ pull(stream) {
        if (offset >= 1.5 * 1048576) { controller.abort(); stream.close(); return; }
        stream.enqueue(bytes.slice(offset, offset + 65536)); offset += 65536;
      } }, { highWaterMark: 0 });
      return new Response(stream, { status: response.status, headers: response.headers });
    };
    await interruptedRun(f, f.api, controller, cut);
    const file = f.store.files("account")[0]!;
    const checkpoint = f.store.delivery("account", file.id)!.checkpoint;
    expect(checkpoint >= 1048576n).toBe(true); expect(file.state).not.toBe("completed");
    const ranges: string[] = [];
    await restartedRun(f, async (url, init) => { ranges.push(new Headers(init.headers).get("range")!); return f.fetch(url, init); });
    expect(ranges[0]).toStartWith(`bytes=${checkpoint}-`);
    expect(f.state.saves).toBe(1);
    await expectDelivered(f);
  } finally { await f.close(); }
}, 30000);

test.if(nativeFiles)("转存请求发出前中断，重启后只提交一次", async () => {
  const f = await engineFixture(localFiles(), 1);
  try {
    const controller = new AbortController();
    await interruptedRun(f, interruptingApi(f, controller, (path, phase) => path.endsWith("/share/restore") && phase === "before"), controller);
    expect(f.state.saves).toBe(0);
    const file = f.store.files("account")[0]!;
    expect(f.store.operationFor("account", file.id, "restore")?.payload.sent ?? false).toBe(false);
    await restartedRun(f);
    expect(f.state.saves).toBe(1);
    await expectDelivered(f);
  } finally { await f.close(); }
});

test.if(nativeFiles)("转存已执行但响应丢失时不重新提交，进入需核对状态", async () => {
  const f = await engineFixture(localFiles(), 1);
  try {
    const controller = new AbortController();
    await interruptedRun(f, interruptingApi(f, controller, (path, phase) => path.endsWith("/share/restore") && phase === "after"), controller);
    expect(f.state.saves).toBe(1);
    await restartedRun(f);
    const file = f.store.files("account")[0]!;
    expect(f.state.saves).toBe(1);
    expect(file.state).toBe("needs_attention");
    expect(f.store.operationFor("account", file.id, "restore")?.status).toBe("attention");
  } finally { await f.close(); }
});

test.if(nativeFiles)("已取得转存任务后中断，重启核对任务结果并完成，不重复提交", async () => {
  const f = await engineFixture(localFiles(), 1);
  try {
    const controller = new AbortController();
    await interruptedRun(f, interruptingApi(f, controller, (path, phase) => path.includes("/tasks/") && phase === "before"), controller);
    const file = f.store.files("account")[0]!;
    expect(f.state.saves).toBe(1); expect(f.store.operationFor("account", file.id, "restore")?.taskId).toBe("task-1");
    await restartedRun(f);
    expect(f.state.saves).toBe(1);
    await expectDelivered(f);
  } finally { await f.close(); }
});

test.if(nativeFiles)("扫描翻页到子目录时中断，重扫不产生重复版本并全部完成", async () => {
  const f = await engineFixture(localFiles(), 2);
  try {
    const controller = new AbortController();
    await interruptedRun(f, interruptingApi(f, controller, (path, phase) => path.includes("/share/detail") && path.includes("parent_id=") && phase === "before"), controller);
    expect(f.store.share("account", f.share.id).scanStatus).not.toBe("complete");
    await restartedRun(f);
    expect(f.store.files("account").map(file => file.sourceId).sort()).toEqual(["source-0", "source-1"]);
    await expectDelivered(f);
  } finally { await f.close(); }
});

test.if(nativeFiles)("删除已执行但响应丢失时只核对同一副本，不补删其他候选", async () => {
  const f = await engineFixture(localFiles(), 2);
  try {
    const controller = new AbortController();
    await interruptedRun(f, interruptingApi(f, controller, (path, phase) => path.endsWith("/files:batchDelete") && phase === "after"), controller);
    expect(f.state.deleted).toEqual(["copy-1"]);
    await restartedRun(f);
    expect(f.state.deleted).toEqual(["copy-1"]); expect(f.state.saves).toBe(2); expect(f.state.usage).toBe(50n);
    await expectDelivered(f);
  } finally { await f.close(); }
});
