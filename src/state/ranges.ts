// 分段下载检查点（add-parallel-segment-download 决策 4）：deliveries.checkpoint 与 prefix_sha256 仍表示连续已验证前缀 [0, L)，
// ranges_json 另外记录前缀之后、窗口之内最多 16 个分块区间，以及因 Range 异常而回退后的顺序模式。
export const CHUNK_SIZE = 8388608n;
export const MAX_RANGES = 16;
export type ByteRange = { offset: bigint; bytes: bigint; sha256: string };
export type RangeCheckpoint = { mode: "parallel" | "sequential"; chunk: bigint; ranges: ByteRange[] };

const decimal = /^(0|[1-9]\d*)$/, digest = /^[a-f0-9]{64}$/;
const chunkEnd = (offset: bigint, size: bigint) => { const end = (offset / CHUNK_SIZE + 1n) * CHUNK_SIZE; return end < size ? end : size; };

// 区间按偏移升序、各占一个分块且互不重叠；起点要么等于 L，要么对齐分块；全部位于 [L, (⌊L/S⌋ + 16)·S) 之内。
export function rangesValid(state: RangeCheckpoint, prefix: bigint, size: bigint): boolean {
  if (state.chunk !== CHUNK_SIZE || prefix < 0n || prefix > size) return false;
  if (state.mode === "sequential") return state.ranges.length === 0;
  if (state.mode !== "parallel" || state.ranges.length > MAX_RANGES) return false;
  const limit = (prefix / CHUNK_SIZE + BigInt(MAX_RANGES)) * CHUNK_SIZE;
  let earliest = prefix;
  for (const { offset, bytes, sha256 } of state.ranges) {
    if (offset < earliest || (offset !== prefix && offset % CHUNK_SIZE !== 0n) || !digest.test(sha256)) return false;
    const end = chunkEnd(offset, size);
    if (bytes <= 0n || offset + bytes > end || offset + bytes > limit) return false;
    earliest = end;
  }
  return true;
}

// 字段缺失、格式错误或违反不变式时整体视为没有区间（返回 null），由调用方保留前缀。
export function parseRanges(json: string | null, prefix: bigint, size: bigint): RangeCheckpoint | null {
  if (json === null) return null;
  try {
    const raw = JSON.parse(json) as { v?: unknown; mode?: unknown; chunk?: unknown; ranges?: unknown };
    if (!raw || raw.v !== 1 || (raw.mode !== "parallel" && raw.mode !== "sequential") || typeof raw.chunk !== "string"
      || !decimal.test(raw.chunk) || !Array.isArray(raw.ranges)) return null;
    const ranges = raw.ranges.map((entry: unknown) => {
      const value = entry as { offset?: unknown; bytes?: unknown; sha256?: unknown };
      if (!value || typeof value.offset !== "string" || !decimal.test(value.offset) || typeof value.bytes !== "string"
        || !decimal.test(value.bytes) || typeof value.sha256 !== "string") throw Error("invalid-range");
      return { offset: BigInt(value.offset), bytes: BigInt(value.bytes), sha256: value.sha256 };
    });
    const state: RangeCheckpoint = { mode: raw.mode, chunk: BigInt(raw.chunk), ranges };
    return rangesValid(state, prefix, size) ? state : null;
  } catch { return null; }
}

export function serializeRanges(state: RangeCheckpoint): string {
  return JSON.stringify({ v: 1, mode: state.mode, chunk: state.chunk.toString(),
    ranges: state.ranges.map(range => ({ offset: range.offset.toString(), bytes: range.bytes.toString(), sha256: range.sha256 })) });
}

// 已持久化字节数：前缀加各区间已保存的字节。
export const persistedBytes = (prefix: bigint, state: RangeCheckpoint | null) => prefix + (state?.ranges.reduce((sum, range) => sum + range.bytes, 0n) ?? 0n);
