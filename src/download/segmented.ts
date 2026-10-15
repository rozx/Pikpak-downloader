import { createHash, type Hash } from "node:crypto";
import type { FileRecord, Store } from "../state/store";
import type { LocalFile } from "../platform/files";
import { CHUNK_SIZE, MAX_RANGES, type ByteRange } from "../state/ranges";
import { ContentHasher } from "./gcid";
import { ChunkPlan, ConnectionGate, chunkLength, type Chunk } from "./chunks";
import { receiveRange, type DownloadTransport } from "./range-worker";
import { DownloadError } from "./download-error";
import type { UrlLease } from "./lease";

const SAVE_EVERY = 4n * 1048576n, READ_BLOCK = 65536n, CHUNK_FAILURES = 3;

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

  const gate = new ConnectionGate(options.connections, options.now);
  const stop = new AbortController(), combined = AbortSignal.any([signal, stop.signal]);
  const active = new Set<Promise<void>>();
  let failure: unknown = null, unsaved = 0n;
  const fail = (error: unknown) => { if (failure === null) { failure = error; stop.abort(error); } };

  // 保存周期（决策 4）：取区间快照 → sync → 把快照中已完成的队头分块读回、核对并并入前缀 → 一条语句写入任务库。
  // 快照只包含写入已返回的数据，之后的写入不在本次声明之内。同一时刻只有一次保存，期间的请求合并为下一次。
  const saveOnce = async () => {
    unsaved = 0n;
    const snapshot = plan.ranges();
    await local.sync();
    for (let head = plan.head(); head; head = plan.head()) {
      const entry = snapshot.find(range => range.offset === head!.start);
      if (!entry || entry.bytes !== chunkLength(head)) break;
      // 先读进内存再核对，摘要不符时顺序哈希器不需要回滚。
      const parts: Uint8Array[] = [];
      await readInto(local, head.start, head.end, bytes => { parts.push(bytes); });
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
  const retryable = (chunk: Chunk, error: DownloadError) => { if (++chunk.failures >= CHUNK_FAILURES) fail(error); };

  const worker = async (chunk: Chunk): Promise<void> => {
    try {
      const lease = await options.lease.get();
      const outcome = await receiveRange({ http: options.http, lease, chunk, size: file.size, file: local, signal: combined,
        ...(options.headerTimeoutMs === undefined ? {} : { headerTimeoutMs: options.headerTimeoutMs }),
        ...(options.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: options.stallTimeoutMs }),
        onAccepted: () => { gate.confirmProbe(); options.lease.succeeded(); },
        onBytes: count => { unsaved += BigInt(count); options.progress(plan.received()); if (unsaved >= SAVE_EVERY) requestSave(); } });
      plan.release(chunk);
      if (outcome.kind === "complete") { chunk.failures = 0; requestSave(); return; }
      if (outcome.kind === "ignored") { await outcome.response.body?.cancel().catch(() => {}); throw new DownloadError("range_mismatch"); }
      if (outcome.kind === "mismatch") throw new DownloadError("range_mismatch");
      if (outcome.status === 401 || outcome.status === 403) { await options.lease.invalidate(lease.generation); return; }
      if (outcome.status === 429) throw new DownloadError("rate_limited", outcome.retryAfterMs);
      if (outcome.status === 402) throw new DownloadError("traffic_quota");
      retryable(chunk, new DownloadError("network_failure"));
    } catch (error) {
      plan.release(chunk);
      if (combined.aborted) return;
      if (error instanceof DownloadError && (error.code === "network_failure" || error.code === "truncated_content")) retryable(chunk, error);
      else fail(error);
    }
  };
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
        if (plan.head()) await save(); else await pause(Math.max(gate.waitMs(), 10));
        continue;
      }
      await Promise.race([...active, pause(Math.max(gate.waitMs(), 50))]);
    }
  } catch (error) { fail(error); }

  if (failure !== null || signal.aborted) {
    // 停止全部连接，等在途写入结束后尽力保存；sync 失败时沿用上次已提交的检查点。
    stop.abort(); await Promise.allSettled([...active]);
    await (saving as Promise<void> | null)?.catch(() => {});
    if (store.file(accountId, file.id).state === "downloading") await saveOnce().catch(() => {});
    throw signal.aborted ? signal.reason ?? Error("interrupted") : failure;
  }
  await (saving as Promise<void> | null);
  if (!plan.finished) await save();
  return hasher.digest();
}
