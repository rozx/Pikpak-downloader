import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ContentHasher, gcidBlockSize } from "./gcid";

// 独立 Python hashlib 参考计算；数据只有公开的合成字节模式。
const vectors = [
  [0, "da39a3ee5e6b4b0d3255bfef95601890afd80709"],
  [262144, "f43c5d94b1f43cd4665dac585073ff87ff44ed68"],
  [262145, "b49c2f0058570f636c866ea282dd5cc9463416e8"],
  [524295, "6a0b5f01331e8dde588577eadd433f7832048ee9"],
] as const;
for (const [size, gcid] of vectors) test(`GCID 分块黄金向量 ${size}`, () => {
  const content = Uint8Array.from({ length: size }, (_, i) => i % 251);
  for (const step of [7919, 262144, size || 1]) {
    const hash = new ContentHasher(BigInt(size));
    for (let i = 0; i < size; i += step) hash.update(content.subarray(i, i + step));
    expect(hash.digest()).toEqual({ gcid, sha256: createHash("sha256").update(content).digest("hex") });
  }
});

test("GCID 使用原始分块摘要，且不是普通 SHA-1", () => {
  const hash = new ContentHasher(3n);
  hash.update(Buffer.from("abc"));
  expect(hash.digest().gcid).toBe("0d3ced9bec10a777aec23ccc353a8c08a633045e");
});

test("GCID 分块阈值与大整数保持精确", () => {
  expect(gcidBlockSize(134217728n)).toBe(262144);
  expect(gcidBlockSize(134217729n)).toBe(524288);
  expect(gcidBlockSize(268435457n)).toBe(1048576);
  expect(gcidBlockSize(536870912n)).toBe(1048576);
  expect(gcidBlockSize(536870913n)).toBe(2097152);
  expect(gcidBlockSize(9007199254740993n)).toBe(2097152);
  expect(() => gcidBlockSize(-1n)).toThrow("invalid-size");
});

test("跨过 128 MiB 阈值的流式摘要符合独立参考值", () => {
  const size = 134217729;
  const hash = new ContentHasher(BigInt(size));
  // 周期对齐的输入块，与 GCID 内部分块故意不对齐。
  const chunk = Uint8Array.from({ length: 251 * 4096 }, (_, i) => i % 251);
  for (let offset = 0; offset < size; offset += chunk.length) hash.update(chunk.subarray(0, Math.min(chunk.length, size - offset)));
  expect(hash.digest().gcid).toBe("6f88a56b3716096bd032a0a8d04604687205ebde");
});

test("拒绝截断、超长和重复终结", () => {
  const hash = new ContentHasher(3n);
  hash.update(Buffer.from("ab"));
  expect(() => hash.digest()).toThrow("truncated-content");
  expect(() => hash.update(Buffer.from("cd"))).toThrow("excess-content");
  hash.update(Buffer.from("c"));
  hash.digest();
  expect(() => hash.digest()).toThrow("already-finalized");
  expect(() => hash.update(new Uint8Array())).toThrow("already-finalized");
});
