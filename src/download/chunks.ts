import { createHash, type Hash } from "node:crypto";
import { CHUNK_SIZE, MAX_RANGES, type ByteRange } from "../state/ranges";

// 分块网格与窗口（add-parallel-segment-download 决策 3）：分块 i 覆盖 [i·S, min((i+1)·S, size))；
// 连续前缀 L 所在的分块从 L 开始。连接只领取 [⌊L/S⌋, ⌊L/S⌋ + W) 内尚未完成、也不在途的分块，序号小的优先。
export type Chunk = { index: bigint; start: bigint; end: bigint; received: bigint; hash: Hash; inflight: boolean; failures: number };
export const chunkLength = (chunk: Chunk) => chunk.end - chunk.start;
export const chunkDone = (chunk: Chunk) => chunk.received === chunkLength(chunk);

export class ChunkPlan {
  private readonly chunks = new Map<bigint, Chunk>();
  private prefixBytes: bigint;
  // window 是窗口内的分块数 W = 2C，最多 16，与检查点区间上限一致。
  constructor(readonly size: bigint, prefix: bigint, readonly window: number) {
    if (prefix < 0n || prefix > size || window < 1 || window > MAX_RANGES) throw Error("invalid-chunk-plan");
    this.prefixBytes = prefix;
  }
  get prefix(): bigint { return this.prefixBytes; }
  get base(): bigint { return this.prefixBytes / CHUNK_SIZE; }
  get finished(): boolean { return this.prefixBytes === this.size; }
  private get last(): bigint { return this.size === 0n ? -1n : (this.size - 1n) / CHUNK_SIZE; }

  chunk(index: bigint): Chunk {
    const existing = this.chunks.get(index);
    if (existing) return existing;
    if (index < this.base || index > this.last) throw Error("chunk-out-of-range");
    const start = index === this.base ? this.prefixBytes : index * CHUNK_SIZE;
    const end = (index + 1n) * CHUNK_SIZE < this.size ? (index + 1n) * CHUNK_SIZE : this.size;
    const chunk: Chunk = { index, start, end, received: 0n, hash: createHash("sha256"), inflight: false, failures: 0 };
    this.chunks.set(index, chunk);
    return chunk;
  }

  // 从已核对的区间恢复：hash 必须已经吃进该区间在磁盘上的 bytes 字节。
  restore(range: ByteRange, hash: Hash): Chunk {
    const chunk = this.chunk(range.offset / CHUNK_SIZE);
    if (chunk.start !== range.offset || range.bytes <= 0n || range.bytes > chunkLength(chunk)) throw Error("invalid-restored-range");
    chunk.received = range.bytes; chunk.hash = hash;
    return chunk;
  }

  claim(): Chunk | null {
    const limit = this.base + BigInt(this.window);
    for (let index = this.base; index < limit && index <= this.last; index++) {
      const chunk = this.chunk(index);
      if (!chunk.inflight && !chunkDone(chunk)) { chunk.inflight = true; return chunk; }
    }
    return null;
  }
  release(chunk: Chunk): void { chunk.inflight = false; }

  // 尚未完成的分块数（含窗口外的），用于有效并发 min(C, 剩余分块)。
  remaining(): number {
    let count = Number(this.last - this.base + 1n);
    for (const chunk of this.chunks.values()) if (chunkDone(chunk)) count--;
    return Math.max(0, count);
  }

  // 队头分块：从 L 开始且已完成，可以读回并入前缀。
  head(): Chunk | null {
    const chunk = this.chunks.get(this.base);
    return chunk && chunk.start === this.prefixBytes && chunkDone(chunk) && !this.finished ? chunk : null;
  }
  advance(chunk: Chunk): void {
    if (chunk !== this.head()) throw Error("not-head-chunk");
    this.chunks.delete(chunk.index); this.prefixBytes = chunk.end;
  }
  // 丢弃一个分块的已接收数据（读回不符或核对失败），之后重新下载。
  discard(chunk: Chunk): void { chunk.received = 0n; chunk.hash = createHash("sha256"); chunk.failures = 0; }

  // 检查点区间：只包含已接收字节的分块；摘要取当前状态的副本。
  ranges(): ByteRange[] {
    return [...this.chunks.values()].filter(chunk => chunk.received > 0n).sort((a, b) => a.index < b.index ? -1 : 1)
      .map(chunk => ({ offset: chunk.start, bytes: chunk.received, sha256: chunk.hash.copy().digest("hex") }));
  }
  // 已接收字节：前缀加各分块已写入的字节，用于进度显示。
  received(): bigint { let total = this.prefixBytes; for (const chunk of this.chunks.values()) total += chunk.received; return total; }
}

// 慢启动：第一个连接先作为探测，响应头核对通过后，每秒最多新增 1 个连接，直到当前上限。
// 上限降低时在途连接继续传输，降到上限以下之前不补新连接。
export class ConnectionGate {
  private probed = false;
  private lastStart = -Infinity;
  private cooldownUntil = 0;
  current: number;
  // initial：从上一个文件降低后的并发开始（同一账号在本次运行内记住），不超过 target。
  constructor(readonly target: number, private readonly now: () => number = Date.now, initial = target) {
    if (!Number.isInteger(target) || target < 1) throw Error("invalid-connections");
    this.current = Math.max(1, Math.min(target, Math.floor(initial)));
  }
  cooling(): boolean { return this.now() < this.cooldownUntil; }
  confirmProbe(): void { this.probed = true; }
  // 冷却期内不发起新请求（限流处理，见决策 7）。
  coolDown(until: number): void { this.cooldownUntil = Math.max(this.cooldownUntil, until); }
  waitMs(): number { return Math.max(0, this.cooldownUntil - this.now(), this.probed ? this.lastStart + 1000 - this.now() : 0); }
  // share：跨文件连接预算分给本文件的份额（多文件同时下载时），不超过它才补新连接。
  canStart(active: number, remaining: number, share = Infinity): boolean {
    const limit = Math.min(this.current, remaining, share);
    if (active >= limit || this.now() < this.cooldownUntil) return false;
    if (active === 0) return true;
    return this.probed && this.now() - this.lastStart >= 1000;
  }
  started(): void { this.lastStart = this.now(); }
}
