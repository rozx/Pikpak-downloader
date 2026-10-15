import { afterEach, expect, test } from "bun:test";
import { CHUNK_SIZE } from "../src/state/ranges";
import { DownloadError } from "../src/download/download-error";
import { SequentialFallback, reconcileSegments } from "../src/download/segmented";
import { MemoryFile } from "./fixtures/memory-file";
import { rejection } from "./fixtures/rejection";
import { S, bytes, cdn, fastClock, leaseFor, runSegmented, setup } from "./fixtures/segments";
import { UrlLease } from "../src/download/lease";
import type { RemoteFile } from "../src/pikpak/drive";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const limited = (retryAfter: string) => new Response(null, { status: 429, headers: { "retry-after": retryAfter } });
const code = (error: Error) => (error as DownloadError).code;

test("部分连接被限流：并发减半并冷却，被限流的分块稍后继续，不上报文件级失败", async () => {
  const content = bytes(6 * S + 99, 2), f = await setup(content, cleanups);
  let limitedOnce = false;
  const server = cdn(content, request => {
    if (request.start === 2 * S && !limitedOnce) { limitedOnce = true; return limited("1"); }
    return undefined;
  });
  const job = runSegmented(f, new MemoryFile(), server.http);
  expect(await job.result).toEqual(f.digest);
  expect(limitedOnce).toBe(true); expect(job.concurrency).toContain(2);
  expect(server.requests.filter(request => request.start === 2 * S)).toHaveLength(2);
});

test("单连接仍被限流或等待超过 60 秒时按文件级限流上报，并带上等待时间", async () => {
  const content = bytes(3 * S, 3);
  const single = await setup(content, cleanups);
  const first = await rejection(runSegmented(single, new MemoryFile(), cdn(content, () => limited("3")).http, { startConnections: 1 }).result);
  expect(code(first)).toBe("rate_limited"); expect((first as DownloadError).retryAfterMs).toBe(3000);
  const long = await setup(content, cleanups);
  const second = await rejection(runSegmented(long, new MemoryFile(), cdn(content, () => limited("61")).http).result);
  expect(code(second)).toBe("rate_limited"); expect((second as DownloadError).retryAfterMs).toBe(61000);
});

test("持续成功后逐步恢复连接数", async () => {
  const content = bytes(20 * S, 4), f = await setup(content, cleanups);
  let limitedOnce = false;
  const server = cdn(content, request => {
    if (request.start === S && !limitedOnce) { limitedOnce = true; return limited("1"); }
    return undefined;
  });
  const job = runSegmented(f, new MemoryFile(), server.http);
  expect(await job.result).toEqual(f.digest);
  const lowered = job.concurrency.indexOf(2);
  expect(lowered).toBeGreaterThan(0); expect(job.concurrency.slice(lowered)).toContain(3);
}, 60000);

test("流量配额不足时立即停止全部连接，已保存的检查点可以核对", async () => {
  const content = bytes(4 * S, 5), f = await setup(content, cleanups), local = new MemoryFile();
  const server = cdn(content, request => request.start >= 2 * S ? new Response(null, { status: 402 }) : undefined);
  expect(code(await rejection(runSegmented(f, local, server.http).result))).toBe("traffic_quota");
  const stored = f.store.delivery("account", f.file.id)!;
  const { plan } = await reconcileSegments(f.store, "account", f.file, local, 8);
  expect(plan.prefix).toBe(stored.checkpoint); expect(plan.ranges()).toHaveLength(stored.ranges?.ranges.length ?? 0);
});

test("强制刷新后的新一代地址仍被拒绝时并发减半；刷新超过预算时报告地址刷新耗尽", async () => {
  const content = bytes(4 * S, 6), f = await setup(content, cleanups);
  // 第 1、2 代地址被拒绝，第 3 代可用。
  const server = cdn(content, request => Number(new URL(request.url).searchParams.get("g")) <= 2 ? new Response(null, { status: 403 }) : undefined);
  const lease = leaseFor(f.file);
  const job = runSegmented(f, new MemoryFile(), server.http, { lease: lease.lease });
  expect(await job.result).toEqual(f.digest);
  // 第 1、2 代被拒绝后至少刷新到第 3 代；加速时钟下也可能因 30 秒有效期再刷新。
  expect(lease.state.calls).toBeGreaterThanOrEqual(3); expect(job.concurrency).toContain(2);
  const exhausted = await setup(content, cleanups);
  const denied = cdn(content, () => new Response(null, { status: 403 }));
  expect(code(await rejection(runSegmented(exhausted, new MemoryFile(), denied.http).result))).toBe("url_refresh_exhausted");
});

test("同一分块连续失败 3 次时上报最后一次的错误", async () => {
  const content = bytes(3 * S, 7), f = await setup(content, cleanups);
  const server = cdn(content, () => new Response(null, { status: 503 }));
  expect(code(await rejection(runSegmented(f, new MemoryFile(), server.http, { startConnections: 1 }).result))).toBe("network_failure");
  expect(server.requests.map(request => request.start)).toEqual([0, 0, 0]);
});

test("全文件连续 6 次请求失败且期间没有分块完成时上报，不等任何单个分块用完预算", async () => {
  const content = bytes(6 * S, 8), f = await setup(content, cleanups);
  const attempts = new Map<number, number>();
  // 每个分块前两次失败；第三次成功但响应体延迟到达，期间其他分块的失败先累计到 6 次。
  const server = cdn(content, request => {
    const count = (attempts.get(request.start) ?? 0) + 1; attempts.set(request.start, count);
    return count <= 2 ? new Response(null, { status: 503 }) : { delayMs: 2000 };
  });
  const started = Date.now();
  expect(code(await rejection(runSegmented(f, new MemoryFile(), server.http).result))).toBe("network_failure");
  expect(Date.now() - started).toBeLessThan(2000);
  expect([...attempts.values()].every(count => count <= 3)).toBe(true);
  expect(server.requests.filter(request => (attempts.get(request.start) ?? 0) > 0).length).toBeGreaterThanOrEqual(6);
});

test("多个连接写入时本地写入失败：停止全部连接，原错误原样上报，检查点可以核对", async () => {
  const content = bytes(4 * S, 9);
  for (const failure of [Object.assign(Error("ENOSPC"), { code: "ENOSPC" }), Error("native-session-closed")]) {
    const f = await setup(content, cleanups), local = new MemoryFile();
    let writes = 0;
    const original = local.write.bind(local);
    local.write = async (position, data) => { if (++writes === 300) local.failWrite = failure; return original(position, data); };
    const error = await rejection(runSegmented(f, local, cdn(content).http).result);
    expect(error).toBe(failure);
    local.failWrite = null;
    const stored = f.store.delivery("account", f.file.id)!;
    const { plan } = await reconcileSegments(f.store, "account", f.file, local, 8);
    expect(plan.prefix).toBe(stored.checkpoint); expect(plan.ranges()).toHaveLength(stored.ranges?.ranges.length ?? 0);
  }
});

test("没有进度时探测返回 200：持久化顺序模式，交给顺序路径", async () => {
  const content = bytes(3 * S, 10), f = await setup(content, cleanups), local = new MemoryFile();
  const server = cdn(content, () => new Response(content, { status: 200 }));
  expect(await rejection(runSegmented(f, local, server.http).result)).toBeInstanceOf(SequentialFallback);
  expect(f.store.delivery("account", f.file.id)).toMatchObject({ checkpoint: 0n, ranges: { mode: "sequential", ranges: [] } });
});

test("已有进度时出现 Range 异常：清空区间、截断到 0 并持久化顺序模式", async () => {
  const content = bytes(4 * S, 11), f = await setup(content, cleanups), local = new MemoryFile();
  const server = cdn(content, request => request.start === 3 * S
    ? new Response(content.slice(request.start, request.end + 1), { status: 206, headers: { "content-range": `bytes 0-${S - 1}/${content.length}` } }) : undefined);
  expect(await rejection(runSegmented(f, local, server.http).result)).toBeInstanceOf(SequentialFallback);
  expect(local.data.length).toBe(0);
  expect(f.store.delivery("account", f.file.id)).toMatchObject({ checkpoint: 0n, ranges: { mode: "sequential", chunk: CHUNK_SIZE, ranges: [] } });
});

test("刷新地址时发现版本变化：停止全部连接并上报 version_changed，已保存的检查点可以核对", async () => {
  const content = bytes(4 * S, 12), f = await setup(content, cleanups), local = new MemoryFile();
  let calls = 0;
  const check = async (): Promise<RemoteFile> => {
    if (++calls > 1) throw new DownloadError("version_changed");
    return { id: "copy", parentId: "p", name: "f.bin", size: f.file.size, gcid: f.file.gcid, raw: { links: { "application/octet-stream": { url: "https://cdn.mypikpak.net/v1" } } } };
  };
  // 第 2 块的请求收到 403，刷新时发现版本已变。
  const server = cdn(content, request => request.start === 2 * S ? new Response(null, { status: 403 }) : undefined);
  const error = await rejection(runSegmented(f, local, server.http, { lease: new UrlLease(check, fastClock) }).result);
  expect(code(error)).toBe("version_changed");
  const stored = f.store.delivery("account", f.file.id)!;
  const { plan } = await reconcileSegments(f.store, "account", f.file, local, 8);
  expect(plan.prefix).toBe(stored.checkpoint); expect(plan.ranges()).toHaveLength(stored.ranges?.ranges.length ?? 0);
});

test("单个连接中途断开：该分块从已接收位置继续，其他分块不受影响", async () => {
  const content = bytes(3 * S + 5, 13), f = await setup(content, cleanups);
  let cut = false;
  const server = cdn(content, request => {
    if (request.start === S && !cut) { cut = true; return { body: content.slice(S, S + 300_000) }; }
    return undefined;
  });
  expect(await runSegmented(f, new MemoryFile(), server.http).result).toEqual(f.digest);
  const chunk = server.requests.filter(request => request.start >= S && request.start < 2 * S).map(request => request.start);
  expect(chunk[0]).toBe(S); expect(chunk[1]).toBe(S + 300_000);
  expect(server.requests.filter(request => request.start === 0)).toHaveLength(1);
});

test("连接停滞超过时限后换连接继续，最终完成", async () => {
  const content = bytes(2 * S + 7, 14), f = await setup(content, cleanups);
  let stalled = false;
  const server = cdn(content, request => {
    if (request.start === S && !stalled) { stalled = true; return { delayMs: 5_000 }; }
    return undefined;
  });
  const started = Date.now();
  expect(await runSegmented(f, new MemoryFile(), server.http, { stallTimeoutMs: 100 }).result).toEqual(f.digest);
  expect(stalled).toBe(true); expect(Date.now() - started).toBeLessThan(4_000);
  expect(server.requests.filter(request => request.start === S)).toHaveLength(2);
});

