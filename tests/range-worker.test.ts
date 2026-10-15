import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ChunkPlan } from "../src/download/chunks";
import { receiveRange, type DownloadTransport, type RangeRequest } from "../src/download/range-worker";
import { DownloadError } from "../src/download/download-error";
import { CHUNK_SIZE } from "../src/state/ranges";
import { MemoryFile } from "./fixtures/memory-file";
import { rejection } from "./fixtures/rejection";

const size = CHUNK_SIZE + 4096n;
const content = new Uint8Array(Number(size)).map((_, index) => (index * 31 + 7) % 251);
const lease = { generation: 1, url: "https://cdn.mypikpak.net/signed", forced: false };
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Seen = { range: string | null; auth: boolean; encoding: string | null; redirect: RequestRedirect | undefined };

// 按请求的 Range 返回内容；shape 可改写状态、头或响应体，用来构造各种异常。
function server(shape: (start: number, end: number) => Partial<{ status: number; headers: Record<string, string>; body: BodyInit | null }> = () => ({})) {
  const seen: Seen[] = [];
  const http: DownloadTransport = async (url, init) => {
    expect(url).toBe(lease.url);
    const headers = new Headers(init.headers), range = headers.get("range");
    seen.push({ range, auth: headers.has("authorization"), encoding: headers.get("accept-encoding"), redirect: init.redirect });
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range!)!.map(Number) as [number, number, number];
    const custom = shape(start, end);
    return new Response(custom.body === undefined ? content.slice(start, end + 1) : custom.body, { status: custom.status ?? 206,
      headers: { "content-range": `bytes ${start}-${end}/${size}`, ...custom.headers } });
  };
  return { http, seen };
}
function request(plan: ChunkPlan, http: DownloadTransport, extra: Partial<RangeRequest> = {}) {
  const file = new MemoryFile(), chunk = plan.claim()!, signal = new AbortController().signal;
  let bytes = 0;
  return { file, chunk, get bytes() { return bytes; }, run: () => receiveRange({ http, lease, chunk, size, file, signal, onBytes: count => { bytes += count; }, ...extra }) };
}

test("正确的 206：只发 Range 与 identity，不带账号令牌且不跟随重定向，写入后计入分块摘要", async () => {
  const { http, seen } = server();
  const plan = new ChunkPlan(size, 0n, 2), job = request(plan, http);
  expect(await job.run()).toEqual({ kind: "complete" });
  expect(seen).toEqual([{ range: `bytes=0-${CHUNK_SIZE - 1n}`, auth: false, encoding: "identity", redirect: "error" }]);
  expect(job.file.data).toEqual(content.slice(0, Number(CHUNK_SIZE)));
  expect(job.chunk.received).toBe(CHUNK_SIZE); expect(job.bytes).toBe(Number(CHUNK_SIZE));
  expect(job.chunk.hash.copy().digest("hex")).toBe(sha(content.slice(0, Number(CHUNK_SIZE))));
});

test("从区间中间继续：请求从已接收位置开始，摘要接续之前的字节", async () => {
  const { http, seen } = server();
  const plan = new ChunkPlan(size, 0n, 2), job = request(plan, http);
  plan.release(job.chunk); plan.claim();
  job.chunk.hash.update(content.slice(0, 1000)); job.chunk.received = 1000n;
  expect(await job.run()).toEqual({ kind: "complete" });
  expect(seen[0]!.range).toBe(`bytes=1000-${CHUNK_SIZE - 1n}`);
  expect(job.file.writes[0]!.position).toBe(1000n);
  expect(job.chunk.hash.copy().digest("hex")).toBe(sha(content.slice(0, Number(CHUNK_SIZE))));
  // 最后一个短分块。
  const tail = new ChunkPlan(size, CHUNK_SIZE, 2), last = request(tail, http);
  expect(await last.run()).toEqual({ kind: "complete" });
  expect(seen.at(-1)!.range).toBe(`bytes=${CHUNK_SIZE}-${size - 1n}`); expect(last.chunk.received).toBe(4096n);
});

test("响应体超出请求范围时报 range_mismatch，超出的字节不写入", async () => {
  const { http } = server((start, end) => ({ body: Buffer.concat([content.slice(start, end + 1), Buffer.from([0])]) }));
  const plan = new ChunkPlan(size, CHUNK_SIZE, 2), job = request(plan, http);
  const error = await rejection(job.run());
  expect((error as DownloadError).code).toBe("range_mismatch");
  expect(job.chunk.received).toBeLessThanOrEqual(4096n);
  expect(job.file.data.length).toBeLessThanOrEqual(Number(size));
});

test("截断：已写入的字节保留在分块中，报 truncated_content", async () => {
  const { http } = server(start => ({ body: content.slice(start, start + 100) }));
  const plan = new ChunkPlan(size, CHUNK_SIZE, 2), job = request(plan, http);
  expect(((await rejection(job.run())) as DownloadError).code).toBe("truncated_content");
  expect(job.chunk.received).toBe(100n); expect(job.chunk.hash.copy().digest("hex")).toBe(sha(content.slice(Number(CHUNK_SIZE), Number(CHUNK_SIZE) + 100)));
});

test("响应体停滞超过时限报 network_failure，之前收到的字节保留", async () => {
  const stalling = (start: number) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(content.slice(start, start + 10)); } });
  const { http } = server(start => ({ body: stalling(start) }));
  const plan = new ChunkPlan(size, CHUNK_SIZE, 2), job = request(plan, http, { stallTimeoutMs: 50 });
  expect(((await rejection(job.run())) as DownloadError).code).toBe("network_failure");
  expect(job.chunk.received).toBe(10n);
  // 响应头超时同样报网络失败。
  const silent: DownloadTransport = (_url, init) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(Error("aborted"))));
  const header = request(new ChunkPlan(size, 0n, 2), silent, { headerTimeoutMs: 30 });
  expect(((await rejection(header.run())) as DownloadError).code).toBe("network_failure");
});

test("限流、地址失效、流量与服务端错误交给协调器，带上等待时间", async () => {
  for (const [status, headers, expected] of [[429, { "retry-after": "7" }, { kind: "status", status: 429, retryAfterMs: 7000 }],
    [403, {}, { kind: "status", status: 403 }], [401, {}, { kind: "status", status: 401 }], [402, {}, { kind: "status", status: 402 }],
    [503, {}, { kind: "status", status: 503 }]] as const) {
    const { http } = server(() => ({ status, headers }));
    const job = request(new ChunkPlan(size, 0n, 2), http);
    expect(await job.run()).toEqual(expected); expect(job.chunk.received).toBe(0n); expect(job.file.writes).toHaveLength(0);
  }
});

test("服务端忽略 Range 返回 200 时交还未读的响应；Content-Range 或内容编码不符时丢弃", async () => {
  const ignored = await request(new ChunkPlan(size, 0n, 2), server(() => ({ status: 200 })).http).run();
  expect(ignored.kind).toBe("ignored");
  if (ignored.kind === "ignored") { expect(ignored.response.bodyUsed).toBe(false); await ignored.response.body?.cancel(); }
  for (const headers of [{ "content-range": `bytes 1-${CHUNK_SIZE}/${size}` }, { "content-range": `bytes 0-${CHUNK_SIZE - 1n}/${size + 1n}` }, { "content-encoding": "gzip" }]) {
    const job = request(new ChunkPlan(size, 0n, 2), server(() => ({ headers })).http);
    expect(await job.run()).toEqual({ kind: "mismatch", status: 206 }); expect(job.file.writes).toHaveLength(0);
  }
});

test("用户中断时抛出中断原因而不是下载错误", async () => {
  const abort = new AbortController();
  const slow = (start: number) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(content.slice(start, start + 10)); setTimeout(() => abort.abort(Error("user-stop")), 20); } });
  const plan = new ChunkPlan(size, CHUNK_SIZE, 2), chunk = plan.claim()!;
  const error = await rejection(receiveRange({ http: server(start => ({ body: slow(start) })).http, lease, chunk, size, file: new MemoryFile(), signal: abort.signal }));
  expect(error.message).toBe("user-stop"); expect(chunk.received).toBe(10n);
});
