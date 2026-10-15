import type { LocalFile } from "../platform/files";
import type { Chunk } from "./chunks";
import { chunkLength } from "./chunks";
import { DownloadError } from "./download-error";
import type { Lease } from "./lease";
import { retryAfter } from "../pikpak/protocol";

export type DownloadTransport = (url: string, init: RequestInit) => Promise<Response>;
// status：需要协调器处理的状态码（401/403 地址失效、429 限流、402 流量、5xx）；
// ignored：服务端忽略 Range 返回 200，响应体未读，由协调器决定按顺序接收或放弃；mismatch：Range 响应异常，响应体已丢弃。
export type RangeOutcome = { kind: "complete" } | { kind: "status"; status: number; retryAfterMs?: number }
  | { kind: "ignored"; response: Response } | { kind: "mismatch"; status: number };
export type RangeRequest = {
  http: DownloadTransport; lease: Lease; chunk: Chunk; size: bigint; file: LocalFile; signal: AbortSignal;
  // onAccepted：响应头通过核对、开始接收响应体之前调用（慢启动确认探测、租约刷新预算清零）。
  onAccepted?: () => void; onBytes?: (bytes: number) => void; headerTimeoutMs?: number; stallTimeoutMs?: number;
};

// 一个连接接收一个分块的剩余部分：从已接收位置继续，核对 206 与精确的 Content-Range，
// 写入返回后才把字节计入分块并送入该分块的 SHA-256。超时沿用顺序路径的 20 秒响应头与 60 秒停滞。
export async function receiveRange(request: RangeRequest): Promise<RangeOutcome> {
  const { chunk, size, file, signal } = request;
  const from = chunk.start + chunk.received, last = chunk.end - 1n;
  if (from > last) return { kind: "complete" };
  const stalled = new AbortController(), combined = AbortSignal.any([signal, stalled.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => stalled.abort(), request.headerTimeoutMs ?? 20_000);
  let response: Response;
  try {
    response = await request.http(request.lease.url, { headers: { Range: `bytes=${from}-${last}`, "Accept-Encoding": "identity" }, redirect: "error", signal: combined });
  } catch {
    if (signal.aborted) throw signal.reason ?? Error("interrupted");
    throw new DownloadError("network_failure");
  } finally { clearTimeout(timer); timer = undefined; }
  if ([401, 402, 403, 429].includes(response.status) || response.status >= 500) {
    await response.body?.cancel().catch(() => {});
    const delay = retryAfter(response.headers.get("retry-after"));
    return { kind: "status", status: response.status, ...(delay === undefined ? {} : { retryAfterMs: delay }) };
  }
  if (response.status === 200) return { kind: "ignored", response };
  if (response.status !== 206 || response.headers.get("content-range") !== `bytes ${from}-${last}/${size}` || !response.body
    || ![null, "identity"].includes(response.headers.get("content-encoding"))) {
    await response.body?.cancel().catch(() => {});
    return { kind: "mismatch", status: response.status };
  }
  request.onAccepted?.();
  const reader = response.body.getReader();
  // 中断或停滞时不依赖响应体随信号报错：每次读取都与中断竞争，用户中断抛出中断原因，停滞视为网络失败。
  const stopped = new Promise<never>((_, reject) => {
    const fail = () => reject(signal.aborted ? signal.reason ?? Error("interrupted") : new DownloadError("network_failure"));
    if (combined.aborted) fail(); else combined.addEventListener("abort", fail, { once: true });
  });
  stopped.catch(() => {});
  try {
    while (true) {
      timer = setTimeout(() => stalled.abort(), request.stallTimeoutMs ?? 60_000);
      const part = await Promise.race([reader.read(), stopped]).catch((error: unknown) => {
        if (signal.aborted) throw signal.reason ?? Error("interrupted");
        throw error instanceof DownloadError ? error : new DownloadError("network_failure");
      }).finally(() => { clearTimeout(timer); timer = undefined; });
      if (part.done) break;
      if (signal.aborted) throw signal.reason ?? Error("interrupted");
      const position = chunk.start + chunk.received;
      if (position + BigInt(part.value.byteLength) > chunk.end) throw new DownloadError("range_mismatch");
      await file.write(position, part.value);
      chunk.hash.update(part.value); chunk.received += BigInt(part.value.byteLength);
      request.onBytes?.(part.value.byteLength);
    }
  } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); }
  if (chunk.received !== chunkLength(chunk)) throw new DownloadError("truncated_content");
  return { kind: "complete" };
}
