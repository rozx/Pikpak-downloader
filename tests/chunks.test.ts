import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ChunkPlan, ConnectionGate, chunkDone, chunkLength, type Chunk } from "../src/download/chunks";
import { CHUNK_SIZE } from "../src/state/ranges";

const S = CHUNK_SIZE;
const fill = (chunk: Chunk, bytes = chunkLength(chunk) - chunk.received) => { chunk.hash.update(Buffer.alloc(Number(bytes))); chunk.received += bytes; };

test("非对齐的旧前缀：前缀所在分块从 L 开始，之后的分块按网格对齐，最后一个分块较短", () => {
  const plan = new ChunkPlan(3n * S + 5n, S + 100n, 4);
  expect(plan.base).toBe(1n);
  const first = plan.claim()!, second = plan.claim()!, last = plan.claim()!;
  expect([first.start, first.end]).toEqual([S + 100n, 2n * S]);
  expect([second.start, second.end]).toEqual([2n * S, 3n * S]);
  expect([last.start, last.end, chunkLength(last)]).toEqual([3n * S, 3n * S + 5n, 5n]);
  expect(plan.claim()).toBe(null);
  expect(plan.remaining()).toBe(3);
});

test("窗口边界：只领取 [⌊L/S⌋, ⌊L/S⌋ + W) 内的分块，队头并入后窗口前移", () => {
  const plan = new ChunkPlan(10n * S, 0n, 2);
  const a = plan.claim()!, b = plan.claim()!;
  expect([a.index, b.index]).toEqual([0n, 1n]);
  expect(plan.claim()).toBe(null);
  // 窗口内的第二块先完成也不能越过窗口。
  fill(b); plan.release(b);
  expect(plan.head()).toBe(null); expect(plan.claim()).toBe(null);
  fill(a); plan.release(a);
  expect(plan.head()).toBe(a);
  plan.advance(a);
  expect(plan.prefix).toBe(S); expect(plan.head()).toBe(b);
  expect(() => plan.advance(a)).toThrow();
  plan.advance(b);
  expect(plan.claim()?.index).toBe(2n); expect(plan.claim()?.index).toBe(3n); expect(plan.claim()).toBe(null);
  expect(plan.remaining()).toBe(8);
});

test("放回的分块从已接收位置继续；区间快照只含已接收字节并取摘要副本", () => {
  const plan = new ChunkPlan(4n * S, 0n, 4);
  const a = plan.claim()!; fill(a, 1000n); plan.release(a);
  const again = plan.claim()!;
  expect(again).toBe(a); expect(again.start + again.received).toBe(1000n);
  const expected = createHash("sha256").update(Buffer.alloc(1000)).digest("hex");
  expect(plan.ranges()).toEqual([{ offset: 0n, bytes: 1000n, sha256: expected }]);
  fill(again, 24n);
  expect(plan.ranges()[0]!.bytes).toBe(1024n); expect(plan.received()).toBe(1024n);
  plan.discard(again);
  expect(again.received).toBe(0n); expect(plan.ranges()).toEqual([]);
});

test("从检查点区间恢复部分完成的分块", () => {
  const plan = new ChunkPlan(4n * S, S, 4);
  const hash = createHash("sha256").update(Buffer.alloc(10));
  const chunk = plan.restore({ offset: 2n * S, bytes: 10n, sha256: "" }, hash);
  expect([chunk.index, chunk.received, chunkDone(chunk)]).toEqual([2n, 10n, false]);
  expect(() => plan.restore({ offset: 2n * S + 1n, bytes: 1n, sha256: "" }, createHash("sha256"))).toThrow();
  expect(plan.claim()?.index).toBe(1n); expect(plan.claim()).toBe(chunk);
});

test("零字节与恰好一个分块的文件", () => {
  const empty = new ChunkPlan(0n, 0n, 2);
  expect([empty.finished, empty.remaining(), empty.claim()]).toEqual([true, 0, null]);
  const one = new ChunkPlan(S, 0n, 2);
  const chunk = one.claim()!; expect([chunk.start, chunk.end]).toEqual([0n, S]); expect(one.claim()).toBe(null);
  fill(chunk); one.release(chunk); one.advance(chunk);
  expect(one.finished).toBe(true); expect(one.head()).toBe(null);
});

test("慢启动：先单个探测，核对后每秒最多新增 1 个连接；有效并发不超过剩余分块", () => {
  let now = 0; const gate = new ConnectionGate(4, () => now);
  expect(gate.canStart(0, 10)).toBe(true); gate.started();
  expect(gate.canStart(1, 10)).toBe(false);
  gate.confirmProbe(); now = 999; expect(gate.canStart(1, 10)).toBe(false);
  now = 1000; expect(gate.canStart(1, 10)).toBe(true); gate.started();
  now = 1500; expect(gate.canStart(2, 10)).toBe(false);
  now = 2000; expect(gate.canStart(2, 10)).toBe(true); gate.started();
  now = 3000; expect(gate.canStart(3, 10)).toBe(true); gate.started();
  now = 9000; expect(gate.canStart(4, 10)).toBe(false);
  expect(gate.canStart(1, 1)).toBe(false); expect(gate.canStart(0, 1)).toBe(true);
});

test("并发上限降低后不补连接，降到上限以下才允许新连接；冷却期内不发起请求", () => {
  let now = 10_000; const gate = new ConnectionGate(4, () => now);
  gate.confirmProbe();
  gate.current = 2;
  expect(gate.canStart(3, 10)).toBe(false); expect(gate.canStart(2, 10)).toBe(false);
  expect(gate.canStart(1, 10)).toBe(true);
  gate.coolDown(now + 5000);
  expect(gate.canStart(1, 10)).toBe(false); expect(gate.waitMs()).toBe(5000);
  now += 5000; expect(gate.canStart(1, 10)).toBe(true);
  expect(() => new ConnectionGate(0)).toThrow();
});
