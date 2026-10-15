import { expect, test } from "bun:test";
import { displayPath, displayWidth, fileName, formatBytes, formatDuration, formatSpeed, truncateMiddle } from "../src/tui/format";
import { SpeedMeter } from "../src/tui/speed";
import { createTheme } from "../src/tui/theme";
import { LOGO, LOGO_WIDTH } from "../src/tui/brand";

test("大小、速度与时长使用紧凑的中文格式", () => {
  expect([0n, 512n, 1024n, 1536n, 412n * 1048576n, 2254857830n, 21n * 1024n ** 3n, 10n * 1024n ** 4n].map(value => formatBytes(value)))
    .toEqual(["0 B", "512 B", "1.0 KB", "1.5 KB", "412 MB", "2.1 GB", "21 GB", "10 TB"]);
  // 标题栏的已用与剩余空间保留一位小数，下载几百 MB 也能看出变化。
  expect([512n, 262n * 1024n ** 3n + 400n * 1048576n, 24n * 1024n ** 3n + 300n * 1048576n, 1023n * 1048576n, 10n * 1024n ** 4n].map(value => formatBytes(value, true)))
    .toEqual(["512 B", "262.4 GB", "24.3 GB", "1023 MB", "10.0 TB"]);
  expect(formatBytes(9007199254740993n)).toBe("8192 TB");
  expect(formatSpeed(2.7 * 1048576)).toBe("2.7 MB/s");
  expect([0, 9.4, 59.6, 79, 3600, 7500].map(formatDuration)).toEqual(["0秒", "9秒", "1分00秒", "1分19秒", "1时00分", "2时05分"]);
});

test("按显示宽度中间省略，中文与组合字符不会被截断或错位", () => {
  expect(displayWidth("中文ab")).toBe(6);
  expect(truncateMiddle("episode01.mkv", 20)).toBe("episode01.mkv");
  const cut = truncateMiddle("非常长的文件名用于测试中间省略是否正确.zip", 20);
  expect(displayWidth(cut)).toBeLessThanOrEqual(20); expect(cut).toContain("…"); expect(cut.startsWith("非常")).toBe(true); expect(cut.endsWith(".zip")).toBe(true);
  const mixed = truncateMiddle("a中b文c字d符e❤️f😀g", 9);
  expect(displayWidth(mixed)).toBeLessThanOrEqual(9); expect(mixed).not.toContain("�");
  expect(truncateMiddle("长文件名", 1)).toBe("…"); expect(truncateMiddle("长文件名", 0)).toBe("");
});

test("相对路径兼容任务库的 JSON 组件格式与普通路径", () => {
  const stored = JSON.stringify([{ id: "a", name: "纪录片合集" }, { id: "b", name: "第一季" }, { id: "c", name: "part1.mp4" }]);
  expect(displayPath(stored)).toBe("纪录片合集/第一季/part1.mp4"); expect(fileName(stored)).toBe("part1.mp4");
  expect(displayPath("folder/file.bin")).toBe("folder/file.bin"); expect(fileName("folder/file.bin")).toBe("file.bin");
});

test("5 秒窗口速度：样本不足 2 秒或低于 1 KiB/s 时不给剩余时间，进度回退时重置", () => {
  let now = 0; const meter = new SpeedMeter(5000, () => now);
  meter.sample("f", 0n); expect(meter.rate("f")).toBe(null);
  now = 1000; meter.sample("f", 2_000_000n);
  expect(meter.rate("f")).toBe(2_000_000); expect(meter.eta("f", 10_000_000n)).toBe(null);
  now = 2000; meter.sample("f", 4_000_000n); expect(meter.eta("f", 10_000_000n)).toBe(3);
  now = 9000; meter.sample("f", 4_000_100n); expect(meter.rate("f")).toBe(null);
  now = 11000; meter.sample("f", 4_000_200n); expect(meter.rate("f")).toBe(50); expect(meter.eta("f", 10_000_000n)).toBe(null);
  now = 12000; meter.sample("f", 100n); expect(meter.rate("f")).toBe(null);
  meter.forget("f"); expect(meter.rate("f")).toBe(null);
});

test("主题使用标准 16 色，NO_COLOR 关闭颜色并以反色标示选中", () => {
  const colored = createTheme({});
  expect(colored.enabled).toBe(true);
  expect([colored.tone("done"), colored.tone("active"), colored.tone("warning"), colored.tone("error"), colored.tone("muted")]).toEqual(["green", "cyan", "yellow", "red", "gray"]);
  expect(colored.selection).toEqual({ backgroundColor: "white" });
  const plain = createTheme({ NO_COLOR: "1" });
  expect(plain.enabled).toBe(false); expect(plain.tone("error")).toBe(undefined); expect(plain.selection).toEqual({ inverse: true });
  expect(createTheme({ NO_COLOR: "" }).enabled).toBe(true);
});

test("选中行为浅色底，文字只用黑色，下载与转存用蓝色；NO_COLOR 下不输出颜色", () => {
  const colored = createTheme({});
  const tones = ["done", "active", "transfer", "scan", "warning", "error", "muted", "text", "strong", "key"] as const;
  for (const tone of tones) expect(colored.paint(tone, true)).toEqual({ color: ["active", "transfer"].includes(tone) ? "blue" : "black" });
  expect(colored.paint("transfer")).toEqual({ color: "blue" });
  for (const tone of tones) expect(createTheme({ NO_COLOR: "1" }).paint(tone, true)).toEqual({});
});

test("标志各行显示宽度一致且不超过 60 列", () => {
  expect(LOGO).toHaveLength(6);
  for (const line of LOGO) expect(displayWidth(line)).toBe(LOGO_WIDTH);
  expect(LOGO_WIDTH).toBeLessThanOrEqual(60);
});

