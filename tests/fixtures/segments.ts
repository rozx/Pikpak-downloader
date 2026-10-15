import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type FileRecord } from "../../src/state/store";
import { CHUNK_SIZE } from "../../src/state/ranges";
import { ContentHasher } from "../../src/download/gcid";
import { UrlLease } from "../../src/download/lease";
import { downloadSegmented, type SegmentedDownload } from "../../src/download/segmented";
import type { DownloadTransport } from "../../src/download/range-worker";
import type { RemoteFile } from "../../src/pikpak/drive";
import type { MemoryFile } from "./memory-file";

// 分段下载测试共用：确定性内容、带交付记录的任务库、可编程的假 CDN 与加速时钟。
export const S = Number(CHUNK_SIZE);
export function bytes(length: number, seed = 1): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(length); let x = seed >>> 0;
  for (let i = 0; i < length; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; data[i] = x >>> 24; }
  return data;
}
export const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
// 加速时钟：慢启动的“每秒 1 个连接”约 20 ms，冷却时间同比缩短。
export const fastClock = () => performance.now() * 50;

export type Setup = Awaited<ReturnType<typeof setup>>;
export async function setup(content: Uint8Array, cleanups: Array<() => Promise<void>>) {
  const root = await mkdtemp(join(tmpdir(), "pikpak-segmented-test-")); const store = new Store(join(root, "db.sqlite"));
  const hash = new ContentHasher(BigInt(content.length)); hash.update(content); const digest = hash.digest();
  store.ensureAccount("account"); const share = store.accept("account", "share", root, "reference"); const scan = store.claimScan("account", share.id)!;
  const file = store.mergeFile(scan, { sourceId: "source", gcid: digest.gcid, size: BigInt(content.length), relativePath: JSON.stringify([{ id: "source", name: "f.bin" }]) });
  store.transition("account", file.id, "ready"); store.allocateDelivery("account", file.id, "tmp", "final");
  cleanups.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, file, digest };
}

// handler 返回 Response 时直接使用（异常状态或异常头）；返回 undefined 时按 Range 正常返回，body 可替换。
export type Served = { start: number; end: number; index: number; url: string };
export function cdn(content: Uint8Array, handler: (request: Served) => Response | { body?: Uint8Array; delayMs?: number } | undefined = () => undefined) {
  const requests: Served[] = []; let active = 0, maxActive = 0;
  const http: DownloadTransport = async (url, init) => {
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get("range")!)!.map(Number) as [number, number, number];
    const request = { start, end, index: requests.length, url }; requests.push(request);
    const custom = handler(request);
    if (custom instanceof Response) return custom;
    const body = custom?.body ?? content.slice(start, end + 1), delayMs = custom?.delayMs ?? 0;
    active++; maxActive = Math.max(maxActive, active);
    let offset = 0, first = true, done = false;
    const finish = () => { if (!done) { done = true; active--; } };
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (first && delayMs) await Bun.sleep(delayMs);
        first = false; await Bun.sleep(0);
        if (init.signal?.aborted) { finish(); controller.error(init.signal.reason); return; }
        if (offset >= body.length) { finish(); controller.close(); return; }
        controller.enqueue(body.slice(offset, offset + 65536)); offset += 65536;
      },
      cancel() { finish(); },
    });
    return new Response(stream, { status: 206, headers: { "content-range": `bytes ${start}-${end}/${content.length}` } });
  };
  return { http, requests, get maxActive() { return maxActive; } };
}
// 每次刷新给出带代数的地址，假 CDN 可按代数决定是否拒绝。
export function leaseFor(file: FileRecord, now: () => number = fastClock) {
  const state = { calls: 0 };
  const check = async (): Promise<RemoteFile> => { state.calls++; return { id: "copy", parentId: "p", name: "f.bin", size: file.size, gcid: file.gcid,
    raw: { links: { "application/octet-stream": { url: `https://cdn.mypikpak.net/signed?g=${state.calls}` } } } }; };
  return { lease: new UrlLease(check, now), state };
}
export function runSegmented(f: Setup, local: MemoryFile, http: DownloadTransport, extra: Partial<SegmentedDownload> = {}) {
  const progress: bigint[] = [], concurrency: number[] = [];
  const result = downloadSegmented({ store: f.store, accountId: "account", file: f.file, local, connections: 4, http, signal: new AbortController().signal,
    progress: value => progress.push(value), now: fastClock, lease: leaseFor(f.file).lease, onConcurrency: value => concurrency.push(value), ...extra });
  return { result, progress, concurrency };
}
