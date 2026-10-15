import { expect, test } from "bun:test";
import { CHUNK_SIZE, MAX_RANGES, parseRanges, persistedBytes, rangesValid, serializeRanges, type RangeCheckpoint } from "../src/state/ranges";

const S = CHUNK_SIZE, hash = (n: number) => n.toString(16).padStart(64, "0");
const parallel = (...ranges: Array<[bigint, bigint]>): RangeCheckpoint =>
  ({ mode: "parallel", chunk: S, ranges: ranges.map(([offset, bytes], index) => ({ offset, bytes, sha256: hash(index + 1) })) });
const size = 100n * S + 5n;

test("合法区间：从前缀处或对齐分块开始，部分完成与完成的分块，以及最后一个短分块", () => {
  expect(rangesValid(parallel(), 0n, size)).toBe(true);
  expect(rangesValid(parallel([3n * S + 100n, S - 100n], [5n * S, 1n]), 3n * S + 100n, size)).toBe(true);
  expect(rangesValid(parallel([100n * S, 5n]), 99n * S, size)).toBe(true);
  expect(rangesValid(parallel([16n * S + 4096n, 10n]), 16n * S + 4096n, size)).toBe(true);
});

test("拒绝越界、重叠、超过 16 项、未对齐、分块大小不一致和顺序模式下的区间", () => {
  // 越界：在前缀之前、超出分块末尾、超出文件末尾、超出窗口。
  expect(rangesValid(parallel([S, 1n]), 2n * S, size)).toBe(false);
  expect(rangesValid(parallel([2n * S, S + 1n]), 0n, size)).toBe(false);
  expect(rangesValid(parallel([100n * S, 6n]), 0n, size)).toBe(false);
  expect(rangesValid(parallel([16n * S, 1n]), 0n, size)).toBe(false);
  expect(rangesValid(parallel([15n * S, 1n]), 0n, size)).toBe(true);
  // 重叠或同一分块两项、乱序、零字节。
  expect(rangesValid(parallel([2n * S, 10n], [2n * S, 5n]), 0n, size)).toBe(false);
  expect(rangesValid(parallel([3n * S, 1n], [2n * S, 1n]), 0n, size)).toBe(false);
  expect(rangesValid(parallel([2n * S, 0n]), 0n, size)).toBe(false);
  // 超过 16 项（前缀不对齐时窗口内最多 16 个分块）。
  const many = Array.from({ length: MAX_RANGES + 1 }, (_, index) => [BigInt(index) * S, 1n] as [bigint, bigint]);
  expect(rangesValid(parallel(...many), 0n, size)).toBe(false);
  expect(rangesValid(parallel(...many.slice(0, MAX_RANGES)), 0n, size)).toBe(true);
  // 未对齐：不在前缀处的区间必须从分块边界开始。
  expect(rangesValid(parallel([2n * S + 1n, 1n]), 0n, size)).toBe(false);
  // 分块大小与当前程序不一致。
  expect(rangesValid({ ...parallel([2n * S, 1n]), chunk: S / 2n }, 0n, size)).toBe(false);
  // 顺序模式只允许空区间。
  expect(rangesValid({ mode: "sequential", chunk: S, ranges: [] }, 5n, size)).toBe(true);
  expect(rangesValid({ ...parallel([2n * S, 1n]), mode: "sequential" }, 0n, size)).toBe(false);
  // 摘要格式。
  expect(rangesValid({ mode: "parallel", chunk: S, ranges: [{ offset: 2n * S, bytes: 1n, sha256: "A".repeat(64) }] }, 0n, size)).toBe(false);
});

test("超出 JS 安全整数范围的偏移按十进制字符串精确往返", () => {
  const prefix = 9007199254740992n, big = prefix + 3n * S + 7n;
  const state = parallel([prefix, 1n], [prefix + S, S], [prefix + 3n * S, 7n]);
  expect(rangesValid(state, prefix, big)).toBe(true);
  const json = serializeRanges(state);
  expect(json).toContain('"offset":"9007199254740992"');
  expect(parseRanges(json, prefix, big)).toEqual(state);
  expect(persistedBytes(prefix, state)).toBe(prefix + 1n + S + 7n);
});

test("格式错误或违反不变式的 JSON 整体视为空", () => {
  const good = serializeRanges(parallel([2n * S, 10n]));
  expect(parseRanges(good, 0n, size)?.ranges).toHaveLength(1);
  expect(parseRanges(null, 0n, size)).toBe(null);
  for (const bad of ["not json", "null", "[]", '{"v":2,"mode":"parallel","chunk":"8388608","ranges":[]}',
    '{"v":1,"mode":"other","chunk":"8388608","ranges":[]}', '{"v":1,"mode":"parallel","chunk":8388608,"ranges":[]}',
    '{"v":1,"mode":"parallel","chunk":"8388608","ranges":[{"offset":16777216,"bytes":"1","sha256":"' + hash(1) + '"}]}',
    '{"v":1,"mode":"parallel","chunk":"8388608","ranges":[{"offset":"-1","bytes":"1","sha256":"' + hash(1) + '"}]}',
    '{"v":1,"mode":"parallel","chunk":"8388608","ranges":[{"offset":"0x10","bytes":"1","sha256":"' + hash(1) + '"}]}',
    '{"v":1,"mode":"parallel","chunk":"4194304","ranges":[]}', serializeRanges(parallel([S, 1n]))]) {
    expect(parseRanges(bad, 2n * S, size)).toBe(null);
  }
  expect(persistedBytes(42n, null)).toBe(42n);
});
