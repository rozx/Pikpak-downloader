import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type FileRecord } from "../src/state/store";
import { CHUNK_SIZE, type ByteRange } from "../src/state/ranges";
import { ContentHasher, gcidBlockSize } from "../src/download/gcid";
import { UrlLease } from "../src/download/lease";
import { downloadSegmented, reconcileSegments } from "../src/download/segmented";
import type { DownloadTransport } from "../src/download/range-worker";
import type { RemoteFile } from "../src/pikpak/drive";
import { MemoryFile } from "./fixtures/memory-file";
import { rejection } from "./fixtures/rejection";

const S = Number(CHUNK_SIZE);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function bytes(length: number, seed = 1): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(length); let x = seed >>> 0;
  for (let i = 0; i < length; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; data[i] = x >>> 24; }
  return data;
}
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
// 独立于 ContentHasher 的 GCID 参考实现：按块 SHA-1，再对摘要串联做 SHA-1。
function referenceGcid(data: Uint8Array): string {
  const block = gcidBlockSize(BigInt(data.length)), outer = createHash("sha1");
  for (let i = 0; i < data.length; i += block) outer.update(createHash("sha1").update(data.subarray(i, i + block)).digest());
  return outer.digest("hex");
}

async function setup(content: Uint8Array) {
  const root = await mkdtemp(join(tmpdir(), "pikpak-segmented-test-")); const store = new Store(join(root, "db.sqlite"));
  const hash = new ContentHasher(BigInt(content.length)); hash.update(content); const digest = hash.digest();
  store.ensureAccount("account"); const share = store.accept("account", "share", root, "reference"); const scan = store.claimScan("account", share.id)!;
  const file = store.mergeFile(scan, { sourceId: "source", gcid: digest.gcid, size: BigInt(content.length), relativePath: JSON.stringify([{ id: "source", name: "f.bin" }]) });
  store.transition("account", file.id, "ready"); store.allocateDelivery("account", file.id, "tmp", "final");
  cleanups.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, file, digest };
}

// 假 CDN：按 Range 返回内容，分 64 KiB 交出并让出事件循环，以便多个连接交错写入。
function cdn(content: Uint8Array, shape: { serve?: (start: number, end: number) => Uint8Array; status?: (start: number) => number | undefined; delay?: number } = {}) {
  const requests: Array<[number, number]> = []; let active = 0, maxActive = 0;
  const http: DownloadTransport = async (_url, init) => {
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get("range")!)!.map(Number) as [number, number, number];
    requests.push([start, end]);
    const status = shape.status?.(start);
    if (status) return new Response(null, { status });
    const body = shape.serve?.(start, end) ?? content.slice(start, end + 1);
    active++; maxActive = Math.max(maxActive, active);
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await Bun.sleep(shape.delay ?? 0);
        if (init.signal?.aborted) { active--; controller.error(init.signal.reason); return; }
        if (offset >= body.length) { active--; controller.close(); return; }
        controller.enqueue(body.slice(offset, offset + 65536)); offset += 65536;
      },
      cancel() { active--; },
    });
    return new Response(stream, { status: 206, headers: { "content-range": `bytes ${start}-${end}/${content.length}` } });
  };
  return { http, requests, get maxActive() { return maxActive; } };
}
function lease(file: FileRecord, now: () => number) {
  const state = { calls: 0 };
  const check = async (): Promise<RemoteFile> => { state.calls++; return { id: "copy", parentId: "p", name: "f.bin", size: file.size, gcid: file.gcid,
    raw: { links: { "application/octet-stream": { url: "https://cdn.mypikpak.net/signed" } } } }; };
  return { lease: new UrlLease(check, now), state };
}
// 加速时钟：慢启动的“每秒 1 个连接”约 20 ms。
const fastClock = () => performance.now() * 50;
function run(f: Awaited<ReturnType<typeof setup>>, local: MemoryFile, http: DownloadTransport, connections = 4, signal = new AbortController().signal) {
  const progress: bigint[] = [];
  const result = downloadSegmented({ store: f.store, accountId: "account", file: f.file, local, connections, http, signal,
    progress: bytes => progress.push(bytes), now: fastClock, lease: lease(f.file, fastClock).lease });
  return { result, progress };
}
const stored = (f: Awaited<ReturnType<typeof setup>>) => f.store.delivery("account", f.file.id)!;

test("多连接下载完成：内容与摘要正确，每个分块只请求一次，最终检查点覆盖整个文件且没有区间", async () => {
  // 每 64 KiB 停 1 ms：Linux 上 Bun.sleep(0) 几乎不耗时，分块会在慢启动放开第二个连接之前传完。
  const content = bytes(4 * S + S / 2), f = await setup(content), local = new MemoryFile(), server = cdn(content, { delay: 1 });
  const job = run(f, local, server.http, 4);
  expect(await job.result).toEqual(f.digest);
  expect(local.data).toEqual(content);
  expect(server.requests.map(([start]) => start).sort((a, b) => a - b)).toEqual([0, S, 2 * S, 3 * S, 4 * S]);
  expect(server.maxActive).toBeGreaterThan(1); expect(server.maxActive).toBeLessThanOrEqual(4);
  expect(stored(f)).toMatchObject({ checkpoint: BigInt(content.length), ranges: { mode: "parallel", ranges: [] } });
  expect(job.progress.at(-1)).toBe(BigInt(content.length));
  expect(f.store.file("account", f.file.id).state).toBe("downloading");
});

// 持久化模拟：sync 时把内容记为已落盘；崩溃后文件只剩已落盘的内容，之后的读写全部失败。
class CrashingFile extends MemoryFile {
  durable = new Uint8Array(0); syncCount = 0; crashed = false;
  constructor(private readonly crashAtSync: number | null, private readonly world: { crashed: boolean }) { super(); }
  private alive() { if (this.world.crashed) throw Error("crashed"); }
  override async write(position: bigint, data: Uint8Array) { this.alive(); await super.write(position, data); }
  override async read(position: bigint, length: number) { this.alive(); return super.read(position, length); }
  override async sync() {
    this.alive();
    if (++this.syncCount === this.crashAtSync) { this.world.crashed = true; throw Error("crashed"); }
    this.durable = this.data.slice(); this.syncs++;
  }
}
function crashingStore(store: Store, world: { crashed: boolean }, crashAtCheckpoint: number | null, crashAfterCheckpoint: number | null) {
  let count = 0;
  return new Proxy(store, { get(target, property) {
    if (property === "checkpoint") return (...args: Parameters<Store["checkpoint"]>) => {
      if (world.crashed) throw Error("crashed");
      count++;
      if (count === crashAtCheckpoint) { world.crashed = true; throw Error("crashed"); }
      target.checkpoint(...args);
      if (count === crashAfterCheckpoint) { world.crashed = true; throw Error("crashed"); }
    };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

test("在 sync 前、sync 后事务前、事务后崩溃：检查点从不声明未落盘的字节，重启后可核对并完成", async () => {
  const content = bytes(2 * S + S / 2 + 777, 7);
  for (const [atSync, atCheckpoint, afterCheckpoint] of [[2, null, null], [4, null, null], [null, 2, null], [null, 4, null], [null, null, 2], [null, null, 5]] as const) {
    const f = await setup(content), world = { crashed: false }, local = new CrashingFile(atSync, world), server = cdn(content);
    const error = await rejection(downloadSegmented({ store: crashingStore(f.store, world, atCheckpoint, afterCheckpoint), accountId: "account", file: f.file, local,
      connections: 2, http: server.http, signal: new AbortController().signal, progress: () => {}, now: fastClock, lease: lease(f.file, fastClock).lease }));
    expect(error.message).toBe("crashed");
    // 重启：文件只剩已落盘的内容。声明的前缀与每个区间都必须能核对。
    const claimed = stored(f), restarted = new MemoryFile(); restarted.data = local.durable.slice();
    const { plan } = await reconcileSegments(f.store, "account", f.file, restarted, 4);
    expect(plan.prefix).toBe(claimed.checkpoint);
    expect(plan.ranges().map(range => range.offset)).toEqual((claimed.ranges?.ranges ?? []).map(range => range.offset));
    const resumed = run(f, restarted, server.http, 2);
    expect(await resumed.result).toEqual(f.digest); expect(restarted.data).toEqual(content);
  }
}, 60000);

test("读回摘要与接收时不符：只丢弃该分块并重新下载，坏数据不进入顺序哈希器", async () => {
  const content = bytes(3 * S + 123, 3), f = await setup(content), server = cdn(content);
  class FlakyRead extends MemoryFile {
    flipped = false;
    override async read(position: bigint, length: number) {
      const data = await super.read(position, length);
      if (!this.flipped && position === CHUNK_SIZE) { this.flipped = true; data[0] = data[0]! ^ 0xff; }
      return data;
    }
  }
  const local = new FlakyRead();
  expect(await run(f, local, server.http, 3).result).toEqual(f.digest);
  expect(local.flipped).toBe(true);
  expect(server.requests.filter(([start]) => start === S)).toHaveLength(2);
});

// 恢复核对用的已存在状态：前缀为第 0 块，第 1 块完整、第 2 块部分、第 3 块部分。
async function seeded() {
  const content = bytes(4 * S + 100, 11), f = await setup(content), local = new MemoryFile();
  const ranges: ByteRange[] = [[S, S], [2 * S, 1000], [3 * S, 5000]].map(([offset, length]) =>
    ({ offset: BigInt(offset!), bytes: BigInt(length!), sha256: sha(content.slice(offset!, offset! + length!)) }));
  await local.write(0n, content.slice(0, 2 * S));
  await local.write(BigInt(2 * S), content.slice(2 * S, 2 * S + 1000));
  await local.write(BigInt(3 * S), content.slice(3 * S, 3 * S + 5000));
  f.store.transition("account", f.file.id, "downloading");
  f.store.checkpoint("account", f.file.id, BigInt(S), sha(content.slice(0, S)), { mode: "parallel", chunk: CHUNK_SIZE, ranges });
  return { content, f, local, ranges };
}

test("恢复：前缀被改动时从头开始并丢弃全部区间", async () => {
  const { content, f, local } = await seeded();
  local.data[10] = local.data[10]! ^ 1;
  const { plan } = await reconcileSegments(f.store, "account", f.file, local, 4);
  expect(plan.prefix).toBe(0n); expect(plan.ranges()).toEqual([]); expect(local.data.length).toBe(0);
  expect(stored(f)).toMatchObject({ checkpoint: 0n, ranges: { mode: "parallel", ranges: [] } });
  const server = cdn(content);
  expect(await run(f, local, server.http).result).toEqual(f.digest);
  expect(server.requests).toHaveLength(5);
});

test("恢复：只有被改动的区间重下，其余区间从已接收位置继续", async () => {
  const { content, f, local } = await seeded();
  local.data[2 * S + 500] = local.data[2 * S + 500]! ^ 1;
  const { plan } = await reconcileSegments(f.store, "account", f.file, local, 4);
  expect(plan.prefix).toBe(BigInt(S));
  expect(plan.ranges().map(range => [range.offset, range.bytes])).toEqual([[BigInt(S), BigInt(S)], [BigInt(3 * S), 5000n]]);
  const server = cdn(content);
  expect(await run(f, local, server.http).result).toEqual(f.digest);
  expect(server.requests.map(([start]) => start).sort((a, b) => a - b)).toEqual([2 * S, 3 * S + 5000, 4 * S]);
  expect(local.data).toEqual(content);
});

test("恢复：文件被截短时丢弃超出部分的区间；文件末尾之后有多余数据时只截到文件大小", async () => {
  const short = await seeded();
  short.local.data = short.local.data.slice(0, 2 * S + 500);
  const first = await reconcileSegments(short.f.store, "account", short.f.file, short.local, 4);
  expect(first.plan.ranges().map(range => range.offset)).toEqual([BigInt(S)]);
  const long = await seeded();
  // 区间之外、文件大小之后追加垃圾数据。
  await long.local.write(BigInt(long.content.length), bytes(4096, 99));
  const second = await reconcileSegments(long.f.store, "account", long.f.file, long.local, 4);
  expect(long.local.data.length).toBe(long.content.length);
  expect(second.plan.prefix).toBe(BigInt(S)); expect(second.plan.ranges()).toHaveLength(3);
  // 区间之间的空隙不截断：第 2 块部分区间之后的数据仍在。
  expect(long.local.data.slice(3 * S, 3 * S + 5000)).toEqual(long.content.slice(3 * S, 3 * S + 5000));
});

test("中断：停止全部连接，等在途写入结束后保存可核对的检查点", async () => {
  const content = bytes(4 * S, 5), f = await setup(content), local = new MemoryFile(), server = cdn(content);
  const abort = new AbortController();
  const job = downloadSegmented({ store: f.store, accountId: "account", file: f.file, local, connections: 4, http: server.http, signal: abort.signal,
    progress: bytes => { if (bytes > BigInt(S + S / 2)) abort.abort(Error("user-stop")); }, now: fastClock, lease: lease(f.file, fastClock).lease });
  expect((await rejection(job)).message).toBe("user-stop");
  const claimed = stored(f);
  expect(claimed.checkpoint + (claimed.ranges?.ranges ?? []).reduce((sum, range) => sum + range.bytes, 0n)).toBeGreaterThan(0n);
  const { plan } = await reconcileSegments(f.store, "account", f.file, local, 8);
  expect(plan.prefix).toBe(claimed.checkpoint); expect(plan.ranges()).toHaveLength(claimed.ranges?.ranges.length ?? 0);
  expect(await run(f, local, server.http).result).toEqual(f.digest);
});

test("跨 128 MiB GCID 分块阈值：并行路径的 GCID 与独立参考实现和顺序计算一致", async () => {
  const content = bytes(128 * 1048576 + 3 * 65536 + 17, 21), f = await setup(content);
  expect(gcidBlockSize(BigInt(content.length))).toBe(524288);
  const digest = await run(f, new MemoryFile(), cdn(content).http, 8).result;
  expect(digest).toEqual(f.digest); expect(digest.gcid).toBe(referenceGcid(content)); expect(digest.sha256).toBe(sha(content));
}, 60000);
