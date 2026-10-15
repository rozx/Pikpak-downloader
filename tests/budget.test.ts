import { afterEach, expect, test } from "bun:test";
import { ConnectionBudget, TOTAL_CONNECTIONS } from "../src/download/budget";
import { ConnectionGate } from "../src/download/chunks";
import { MemoryFile } from "./fixtures/memory-file";
import { S, bytes, cdn, runSegmented, setup } from "./fixtures/segments";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

test("预算份额为 max(1, ⌊8 / 在途文件数⌋)，登记与注销后随之变化", () => {
  const budget = new ConnectionBudget();
  expect(TOTAL_CONNECTIONS).toBe(8); expect(budget.share()).toBe(8);
  budget.register("a"); expect(budget.share()).toBe(8);
  budget.register("b"); expect(budget.share()).toBe(4);
  budget.register("c"); expect(budget.share()).toBe(2);
  budget.register("c"); expect(budget.active).toBe(3);
  for (const id of ["d", "e"]) budget.register(id);
  expect(budget.share()).toBe(1);
  for (const id of ["f", "g", "h", "i"]) budget.register(id);
  expect(budget.active).toBe(9); expect(budget.share()).toBe(1);
  for (const id of ["a", "b", "c", "d", "e", "f", "g", "h"]) budget.release(id);
  expect(budget.share()).toBe(8);
});

test("闸门的上限取当前并发、剩余分块与预算份额中的最小值", () => {
  let now = 10_000; const gate = new ConnectionGate(4, () => now);
  gate.confirmProbe();
  expect(gate.canStart(1, 10, 2)).toBe(true); expect(gate.canStart(2, 10, 2)).toBe(false);
  expect(gate.canStart(2, 10)).toBe(true); expect(gate.canStart(0, 10, 1)).toBe(true); expect(gate.canStart(1, 10, 1)).toBe(false);
});

test("份额为 2 时最多 2 个连接；份额变小后已有连接完成当前分块，降到份额以下之前不补新连接", async () => {
  const content = bytes(6 * S, 31), f = await setup(content, cleanups);
  const fixed = cdn(content);
  expect(await runSegmented(f, new MemoryFile(), fixed.http, { share: () => 2 }).result).toEqual(f.digest);
  expect(fixed.maxActive).toBeLessThanOrEqual(2);

  const g = await setup(content, cleanups);
  let share = 4, switched = false;
  const starts: Array<{ active: number; after: boolean }> = [];
  let active = 0;
  const server = cdn(content, () => { starts.push({ active, after: switched }); active++; return undefined; });
  const counted = async (url: string, init: RequestInit) => {
    const response = await server.http(url, init);
    if (!response.body) { active--; return response; }
    const reader = response.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) { const part = await reader.read(); if (part.done) { active--; controller.close(); } else controller.enqueue(part.value); },
      cancel() { active--; reader.cancel().catch(() => {}); },
    });
    return new Response(stream, { status: response.status, headers: response.headers });
  };
  const job = runSegmented(g, new MemoryFile(), counted, { share: () => share, progress: bytes => { if (!switched && bytes >= BigInt(S)) { switched = true; share = 1; } } });
  expect(await job.result).toEqual(g.digest);
  expect(switched).toBe(true);
  // 切换之后开始的每个请求，开始时都没有其他在途连接。
  for (const start of starts.filter(item => item.after)) expect(start.active).toBe(0);
  expect(starts.filter(item => !item.after).length).toBeGreaterThanOrEqual(1);
});
