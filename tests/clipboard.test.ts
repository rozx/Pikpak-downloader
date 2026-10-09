import { expect, test } from "bun:test";
import { stableSnapshot, pollClipboard } from "../src/intake/clipboard";
import { macClipboard } from "../src/platform/mac-clipboard";
import { macNative } from "../src/platform/macos";
import { macClipboardWorker } from "../src/platform/clipboard";

test("读取前后变化时有界重试，不混配文本与序号", async () => {
  let sequence = 1;
  const result = await stableSnapshot({ sequence: () => String(sequence), text: () => { if (sequence === 1) sequence++; return "latest"; } });
  expect(result).toEqual({ sequence: "2", text: "latest" });
  let reads = 0;
  expect(await stableSnapshot({ sequence: () => String(sequence), text: () => { reads++; sequence++; return "changing"; } })).toBe(null);
  expect(reads).toBe(3);
});

test.if(process.platform === "darwin")("子进程剪贴板桥接通过管道读取独立测试区并能结束", async () => {
  const native = macNative(); const name = native.createBoard();
  const clipboard = macClipboardWorker(name);
  try {
    native.writeBoard(name, "synthetic-process-value");
    expect((await clipboard.read())?.text).toBe("synthetic-process-value");
  } finally { await clipboard.close(); native.releaseBoard(name); }
});

test("剪贴板故障退避、持续故障通知和有界退出", async () => {
  const abort = new AbortController(); const delays: number[] = [], notices: boolean[] = []; let reads = 0, closed = false;
  await pollClipboard({ read: async () => { reads++; if (reads <= 3) throw Error("unavailable"); return { sequence: "1", text: null }; }, close: async () => { closed = true; } },
    abort.signal, async () => { abort.abort(); }, failed => notices.push(failed), async ms => { delays.push(ms); });
  expect(delays).toEqual([1000, 2000, 4000, 500]); expect(notices).toEqual([true, false]); expect(closed).toBe(true);
});

test.if(process.platform === "darwin")("macOS 实际独立剪贴板：同内容重复制与快速覆盖", async () => {
  const native = macNative(); const name = native.createBoard(); const clipboard = macClipboard(name);
  try {
    native.writeBoard(name, "synthetic clipboard 中文"); const first = await clipboard.read();
    native.writeBoard(name, "synthetic clipboard 中文"); const copied = await clipboard.read();
    expect(copied?.text).toBe(first?.text); expect(copied?.sequence).not.toBe(first?.sequence);
    for (let i = 0; i < 30; i++) native.writeBoard(name, `synthetic ${i}`);
    expect((await clipboard.read())?.text).toBe("synthetic 29");
    expect(() => native.writeBoard(native.generalBoard(), "forbidden")).toThrow();
  } finally { await clipboard.close(); native.releaseBoard(name); }
});
