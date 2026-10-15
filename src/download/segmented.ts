import { createHash, type Hash } from "node:crypto";
import type { FileRecord, Store } from "../state/store";
import type { LocalFile } from "../platform/files";
import { CHUNK_SIZE, MAX_RANGES, type ByteRange } from "../state/ranges";
import { ContentHasher } from "./gcid";
import { ChunkPlan, ConnectionGate, chunkLength, type Chunk } from "./chunks";
import { receiveRange, type DownloadTransport } from "./range-worker";
import { DownloadError } from "./download-error";
import type { UrlLease } from "./lease";

const SAVE_EVERY = 4n * 1048576n, READ_BLOCK = 65536n;
// 失败预算（决策 8）：同一分块连续失败 3 次，或全文件连续 6 次请求失败且期间没有分块完成。
const CHUNK_FAILURES = 3, FILE_FAILURES = 6, RETRY_PAUSE_MS = 500;
// 限流自适应（决策 7）：冷却时间取 Retry-After 并限制在 1–60 秒，缺省 5 秒；连续完成 16 个分块后恢复 1 个连接。
const COOLDOWN_DEFAULT_MS = 5_000, COOLDOWN_MAX_MS = 60_000, RECOVER_AFTER = 16, FORBIDDEN_PAUSE_MS = 2_000;

// Range 异常（服务端忽略范围、Content-Range 不符、内容编码或响应体超出范围）：协调器停止全部连接，
// 持久化顺序模式并从头开始，由调用方改走顺序路径（决策 8）。
export class SequentialFallback extends Error { constructor() { super("sequential_fallback"); } }

async function readInto(local: LocalFile, start: bigint, end: bigint, sink: (bytes: Uint8Array) => void, signal?: AbortSignal): Promise<void> {
  for (let offset = start; offset < end;) {
    if (signal?.aborted) throw signal.reason ?? Error("interrupted");
    const bytes = await local.read(offset, Number(end - offset < READ_BLOCK ? end - offset : READ_BLOCK));
    if (!bytes.byteLength) throw new DownloadError("truncated_content");
    sink(bytes); offset += BigInt(bytes.byteLength);
  }
}

// 恢复核对（决策 4）：先核对连续前缀，不一致时从头开始并丢弃全部区间；前缀有效时逐个读回区间，
// 只丢弃对不上的区间。只有文件长度超过 size 时才截断，不截断前缀之后的数据。清理后的结果写回任务库。
export async function reconcileSegments(store: Store, accountId: string, file: FileRecord, local: LocalFile, window: number,
  signal?: AbortSignal): Promise<{ plan: ChunkPlan; hasher: ContentHasher }> {
  const delivery = store.delivery(accountId, file.id)!, info = await local.info();
  let hasher = new ContentHasher(file.size), prefix = 0n, ranges: ByteRange[] = [];
  const claimed = delivery.checkpoint;
  let prefixValid = claimed === 0n;
  if (claimed > 0n && claimed <= file.size && info.size >= claimed && delivery.prefixSha256) {
    const candidate = new ContentHasher(file.size);
    await readInto(local, 0n, claimed, bytes => candidate.update(bytes), signal);
    if (candidate.prefixDigest() === delivery.prefixSha256) { hasher = candidate; prefix = claimed; prefixValid = true; }
  }
  if (prefixValid) ranges = delivery.ranges?.mode === "parallel" ? delivery.ranges.ranges : [];
  else await local.truncate(0n);
  const plan = new ChunkPlan(file.size, prefix, window);
  for (const range of ranges) {
    if (info.size < range.offset + range.bytes) continue;
    const hash: Hash = createHash("sha256");
    await readInto(local, range.offset, range.offset + range.bytes, bytes => hash.update(bytes), signal);
    if (hash.copy().digest("hex") === range.sha256) plan.restore(range, hash);
  }
  if (info.size > file.size) { await local.truncate(file.size); await local.sync(); }
  // 只会减少声明的数据，不需要先 sync。
  store.checkpoint(accountId, file.id, plan.prefix, hasher.prefixDigest(), { mode: "parallel", chunk: CHUNK_SIZE, ranges: plan.ranges() });
  return { plan, hasher };
}

export type SegmentedDownload = {
  store: Store; accountId: string; file: FileRecord; local: LocalFile; connections: number; lease: UrlLease; http: DownloadTransport;
  signal: AbortSignal; progress: (bytes: bigint) => void; now?: () => number; headerTimeoutMs?: number; stallTimeoutMs?: number;
  // 起始并发（同一账号上一个文件降低后的值）与并发变化通知，由 engine 在本次运行内按账号记住。
  startConnections?: number; onConcurrency?: (current: number) => void;
};

// 有界窗口内多连接下载一个文件（决策 3–5）。返回连续前缀推进到文件末尾时的 GCID 与 SHA-256；
// 完成后的版本核对、读回校验与发布由调用方沿用顺序路径的流程。
export async function downloadSegmented(options: SegmentedDownload): Promise<{ gcid: string; sha256: string }> {
  const { store, accountId, file, local, signal } = options;
  if (signal.aborted) throw signal.reason ?? Error("interrupted");
  const window = Math.min(2 * options.connections, MAX_RANGES);
  const { plan, hasher } = await reconcileSegments(store, accountId, file, local, window, signal);
  if (store.file(accountId, file.id).state !== "downloading") store.transition(accountId, file.id, "downloading");
  options.progress(plan.received());

  const now = options.now ?? Date.now;
  const gate = new ConnectionGate(options.connections, now, options.startConnections ?? options.connections);
  options.onConcurrency?.(gate.current);
  const stop = new AbortController(), combined = AbortSignal.any([signal, stop.signal]);
  const active = new Set<Promise<void>>();
  let failure: unknown = null, unsaved = 0n;
  const fail = (error: unknown) => { if (failure === null) { failure = error; stop.abort(error); } };

  // 保存周期（决策 4）：取区间快照 → sync → 把快照中已完成的队头分块读回、核对并并入前缀 → 一条语句写入任务库。
  // 快照只包含写入已返回的数据，之后的写入不在本次声明之内。同一时刻只有一次保存，期间的请求合并为下一次。
  // fold 为 false 时只保存区间、不读回并入前缀：停止时用它，多个文件同时停止也不必各自读回最多 64 MiB；
  // 区间留在检查点里，下次启动时核对。停止开始后，正在进行的并入也在下一个分块处结束。
  const saveOnce = async (fold = true) => {
    unsaved = 0n;
    const snapshot = plan.ranges();
    await local.sync();
    for (let head = plan.head(); fold && head && !combined.aborted; head = plan.head()) {
      const entry = snapshot.find(range => range.offset === head!.start);
      if (!entry || entry.bytes !== chunkLength(head)) break;
      // 先读进内存再核对，摘要不符时顺序哈希器不需要回滚。
      const parts: Uint8Array[] = [];
      try { await readInto(local, head.start, head.end, bytes => { parts.push(bytes); }, combined); } catch { break; }
      const data = Buffer.concat(parts);
      snapshot.splice(snapshot.indexOf(entry), 1);
      if (createHash("sha256").update(data).digest("hex") !== entry.sha256) { plan.discard(head); break; }
      hasher.update(data); plan.advance(head);
    }
    store.checkpoint(accountId, file.id, plan.prefix, hasher.prefixDigest(),
      { mode: "parallel", chunk: CHUNK_SIZE, ranges: snapshot.filter(range => range.offset >= plan.prefix) });
  };
  let saving: Promise<void> | null = null, again = false;
  const save = (): Promise<void> => {
    if (saving) { again = true; return saving; }
    saving = (async () => { do { again = false; await saveOnce(); } while (again); })().finally(() => { saving = null; });
    return saving;
  };
  const requestSave = () => { save().catch(fail); };
  let consecutive = 0, streak = 0;
  const lower = (to: number) => { if (to < gate.current) { gate.current = to; streak = 0; options.onConcurrency?.(gate.current); } };
  // 网络失败、截断、5xx：分块放回队列并保留已验证字节；超出预算时以最后一次的错误上报，由 engine 计入文件级有限重试。
  const failed = (chunk: Chunk, error: DownloadError) => {
    consecutive++;
    if (++chunk.failures >= CHUNK_FAILURES || consecutive >= FILE_FAILURES) fail(error); else gate.coolDown(now() + RETRY_PAUSE_MS);
  };
  const completed = (chunk: Chunk) => {
    chunk.failures = 0; consecutive = 0;
    if (++streak >= RECOVER_AFTER && gate.current < gate.target) { gate.current++; streak = 0; options.onConcurrency?.(gate.current); }
    requestSave();
  };
  // 429：已在冷却中说明是同一波限流，只放回分块；否则并发减半并冷却。已是单连接或等待超过 60 秒时按文件级限流上报。
  const rateLimited = (retryAfterMs: number | undefined) => {
    if (gate.cooling()) return;
    if (gate.current === 1 || (retryAfterMs ?? 0) > COOLDOWN_MAX_MS) { fail(new DownloadError("rate_limited", retryAfterMs)); return; }
    lower(Math.max(1, Math.floor(gate.current / 2)));
    gate.coolDown(now() + Math.min(COOLDOWN_MAX_MS, Math.max(1_000, retryAfterMs ?? COOLDOWN_DEFAULT_MS)));
  };

  const worker = async (chunk: Chunk): Promise<void> => {
    try {
      const lease = await options.lease.get();
      const outcome = await receiveRange({ http: options.http, lease, chunk, size: file.size, file: local, signal: combined,
        ...(options.headerTimeoutMs === undefined ? {} : { headerTimeoutMs: options.headerTimeoutMs }),
        ...(options.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: options.stallTimeoutMs }),
        onAccepted: () => { gate.confirmProbe(); options.lease.succeeded(); },
        onBytes: count => { unsaved += BigInt(count); options.progress(plan.received()); if (unsaved >= SAVE_EVERY) requestSave(); } });
      plan.release(chunk);
      if (outcome.kind === "complete") { completed(chunk); return; }
      if (outcome.kind === "ignored") { await outcome.response.body?.cancel().catch(() => {}); throw new SequentialFallback(); }
      if (outcome.kind === "mismatch") throw new SequentialFallback();
      if (outcome.status === 401 || outcome.status === 403) {
        // 强制刷新得到的新一代地址仍被拒绝：视为服务端限制并发连接数，并发减半，2 秒后重试。
        if (lease.forced && gate.current > 1 && !gate.cooling()) { lower(Math.floor(gate.current / 2)); gate.coolDown(now() + FORBIDDEN_PAUSE_MS); }
        await options.lease.invalidate(lease.generation); return;
      }
      if (outcome.status === 429) { rateLimited(outcome.retryAfterMs); return; }
      if (outcome.status === 402) throw new DownloadError("traffic_quota");
      failed(chunk, new DownloadError("network_failure"));
    } catch (error) {
      plan.release(chunk);
      if (combined.aborted) return;
      if (error instanceof DownloadError && error.code === "range_mismatch") fail(new SequentialFallback());
      else if (error instanceof DownloadError && (error.code === "network_failure" || error.code === "truncated_content")) failed(chunk, error);
      else fail(error);
    }
  };
  // 等待以短间隔轮询闸门：冷却与慢启动按注入的时钟计算，不直接按其差值睡眠。
  const pause = (ms: number) => new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms);
    combined.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

  try {
    while (!plan.finished && failure === null && !signal.aborted) {
      for (let chunk: Chunk | null; gate.canStart(active.size, plan.remaining()) && (chunk = plan.claim());) {
        gate.started();
        const running: Promise<void> = worker(chunk).finally(() => { active.delete(running); });
        active.add(running);
      }
      if (active.size === 0) {
        // 窗口内的分块都已完成但尚未并入时，保存一次推进前缀；否则等慢启动或冷却结束。
        if (plan.head()) await save(); else await pause(Math.min(Math.max(gate.waitMs(), 10), 100));
        continue;
      }
      await Promise.race([...active, pause(Math.min(Math.max(gate.waitMs(), 10), 100))]);
    }
  } catch (error) { fail(error); }

  if (failure !== null || signal.aborted) {
    // 停止全部连接，等在途写入结束后尽力保存；sync 失败时沿用上次已提交的检查点。
    stop.abort(); await Promise.allSettled([...active]);
    await (saving as Promise<void> | null)?.catch(() => {});
    if (!signal.aborted && failure instanceof SequentialFallback) {
      // 持久化顺序模式，清空区间并截断到 0，之后由顺序路径从头下载；显式 retry 才会清除该标记。
      await local.truncate(0n); await local.sync();
      store.checkpoint(accountId, file.id, 0n, new ContentHasher(file.size).prefixDigest(), { mode: "sequential", chunk: CHUNK_SIZE, ranges: [] });
      throw failure;
    }
    if (store.file(accountId, file.id).state === "downloading") await saveOnce(false).catch(() => {});
    throw signal.aborted ? signal.reason ?? Error("interrupted") : failure;
  }
  await (saving as Promise<void> | null);
  if (!plan.finished) await save();
  return hasher.digest();
}
