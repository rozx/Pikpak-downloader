import { afterEach, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { TuiApp } from "../src/tui/app";
import { createTheme, type Theme, type Tone } from "../src/tui/theme";
import { displayWidth } from "../src/tui/format";
import { RowLine, type Size } from "../src/tui/main-panel";
import { Rule, SPINNER, creditLabel } from "../src/tui/parts";
import { buildRows } from "../src/tui/view-model";
import { about } from "../src/about";
import { FakeController, keys, mockSnapshot, settle, stripAnsi } from "./fixtures/tui";

const mounted: Array<() => void> = [];
afterEach(() => { for (const unmount of mounted.splice(0)) unmount(); });
function mount(controller = new FakeController(), size: Size = { columns: 100, rows: 24 }) {
  const app = render(<TuiApp controller={controller} theme={createTheme({ NO_COLOR: "1" })} size={size} />);
  mounted.push(app.unmount);
  const frame = () => stripAnsi(app.lastFrame() ?? "");
  const press = async (...inputs: string[]) => { for (const input of inputs) { app.stdin.write(input); await settle(); } };
  return { controller, frame, press };
}

test("主面板：标题栏、分组、进度、事件区与按键提示", async () => {
  const { frame } = mount(); await settle();
  const text = frame();
  for (const part of ["PikPak Downloader", "● 已登录", "云盘 21 GB / 10 TB", "本地剩余 412 GB", "剪贴板 ● 监听中",
    "▼ 「某某合集」  1/3 完成 · 1 下载中 · 1 排队", "▼ 「纪录片合集」  0/2 完成 · 1 失败 · 1 等待", "▶ 「另一个分享」  2/2 完成",
    "48%  198 MB/412 MB  2.7 MB/s  1分19秒", "失败 · 下载地址多次刷新后仍被拒绝", "等待云端空间",
    "22:33:40  ✓ episode01.mkv 校验通过，已完成", "Enter 详情", "p 暂停"]) expect(text).toContain(part);
  expect(text).not.toContain("readme.txt");
});

test("中文文件名中间省略后，大小列仍然对齐", async () => {
  const { frame } = mount(); await settle();
  const lines = frame().split("\n").filter(line => /\d+(\.\d)? (MB|GB)\s{2,}/.test(line) && !line.includes("云盘"));
  expect(lines.length).toBe(5);
  const columns = lines.map(line => displayWidth(line.slice(0, line.search(/\d+(\.\d)? (MB|GB)\s{2,}/))));
  expect(new Set(columns).size).toBe(1);
  expect(lines.some(line => line.includes("…"))).toBe(true);
});

test("窗口过小时只显示放大提示", async () => {
  const { frame } = mount(new FakeController(), { columns: 50, rows: 20 }); await settle();
  expect(frame().trim()).toBe("窗口太小（50×20），请放大到至少 60×15");
  const short = mount(new FakeController(), { columns: 80, rows: 12 }); await settle();
  expect(short.frame().trim()).toBe("窗口太小（80×12），请放大到至少 60×15");
});

test("用户暂停与系统暂停分别显示横幅，暂停中的下载行标为已暂停", async () => {
  const controller = new FakeController({ ...mockSnapshot(), userPaused: true, systemPause: { reason: "authentication", fileId: null } });
  const { frame } = mount(controller); await settle();
  const text = frame();
  expect(text).toContain("⏸ 队列已暂停"); expect(text).toContain("⏸ 执行已暂停"); expect(text).toContain("登录已失效，执行已暂停。重新启动程序并完成浏览器登录。");
  expect(text).toContain("48%  已暂停"); expect(text).toContain("1 暂停"); expect(text).toContain("p 继续");
  controller.update({ userPaused: false, systemPause: null }); await settle();
  expect(frame()).not.toContain("⏸ 队列已暂停"); expect(frame()).not.toContain("执行已暂停");
});

test("列表超过一屏时随选中项滚动，标题栏与按键提示保持可见", async () => {
  // 15 行时列表区只有 7 行，而列表共有 8 行。
  const { frame, press } = mount(new FakeController(), { columns: 100, rows: 15 }); await settle();
  await press(...Array(7).fill(keys.down));
  const bottom = frame();
  expect(bottom).toContain("PikPak Downloader"); expect(bottom).toContain("q 退出");
  expect(bottom).toContain("▶ 「另一个分享」"); expect(bottom).not.toContain("「某某合集」  1/3");
  await press(keys.up);
  expect(frame().split("\n").find(line => line.includes(">"))).toContain("part2.mp4");
  await press(...Array(6).fill(keys.up));
  expect(frame()).toContain("▼ 「某某合集」"); expect(frame()).toContain("q 退出");
});

test("取消需要确认：y 下发取消，n 与 Esc 返回；已完成文件无需取消", async () => {
  const { controller, frame, press } = mount(); await settle();
  await press(keys.down, "c");
  expect(frame()).toContain("取消任务"); expect(frame()).toContain("取消 episode02.mkv？"); expect(frame()).toContain("本地文件、断点和云端副本都会保留");
  await press("n"); expect(frame()).not.toContain("取消任务"); expect(controller.commands).toEqual([]);
  await press("c", keys.escape); expect(controller.commands).toEqual([]);
  await press("c", "y"); expect(controller.commands).toEqual([{ kind: "cancel", id: "f_2" }]); expect(frame()).not.toContain("取消任务");
  await press(keys.up, keys.up, "c");
  expect(frame()).toContain("取消「某某合集」中未完成的 2 个文件？");
  await press("n", keys.down, "c");
  expect(controller.notes.at(-1)?.text).toBe("episode01.mkv 已完成，无需取消"); expect(frame()).not.toContain("取消任务");
});

test("暂停与继续、重试、打开目录及操作失败提示", async () => {
  const { controller, frame, press } = mount(); await settle();
  await press(keys.down, "p", "r", "o");
  expect(controller.commands).toEqual([{ kind: "pauseQueue" }, { kind: "retry", id: "f_2" }]);
  expect(controller.opened).toEqual([{ shareId: "s_1", fileId: "f_2" }]);
  controller.update({ userPaused: true }); await settle();
  expect(frame()).toContain("⏸ 队列已暂停");
  await press("p"); expect(controller.commands.at(-1)).toEqual({ kind: "resumeQueue" });
  controller.openResult = { ok: false, reason: "output_unavailable" }; await press("o");
  expect(controller.notes.at(-1)?.text).toBe("无法打开目录：下载目录不可用或不可写");
  controller.result = { ok: false, reason: "invalid_transition" }; await press("r");
  expect(controller.notes.at(-1)?.text).toBe("操作失败：任务当前状态不允许此操作");
});

test("折叠与展开分享，Enter 在分享行切换折叠", async () => {
  const { frame, press } = mount(); await settle();
  await press(keys.left);
  expect(frame()).toContain("▶ 「某某合集」"); expect(frame()).not.toContain("episode02.mkv");
  await press(keys.right); expect(frame()).toContain("episode02.mkv");
  await press(keys.enter); expect(frame()).not.toContain("episode02.mkv");
});

test("q 与 Ctrl+C 先确认再停止：y 或再按 Ctrl+C 确认，n 与 Esc 返回；停止期间再按 Ctrl+C 立即退出", async () => {
  const { controller, frame, press } = mount(); await settle();
  await press("q");
  expect(frame()).toContain("退出程序"); expect(frame()).toContain("停止下载并退出？"); expect(frame()).toContain("y 停止并退出");
  expect(controller.stops).toBe(0);
  await press("n"); expect(frame()).not.toContain("退出程序"); expect(controller.stops).toBe(0);
  await press("q", keys.escape); expect(frame()).not.toContain("退出程序"); expect(controller.stops).toBe(0);
  await press(keys.ctrlC); expect(frame()).toContain("停止下载并退出？"); expect(controller.stops).toBe(0);
  await press("n"); expect(frame()).not.toContain("退出程序"); expect(controller.stops).toBe(0);
  await press(keys.enter, keys.ctrlC); expect(frame()).toContain("停止下载并退出？");
  await press(keys.escape); expect(frame()).toContain("Enter 详情"); expect(controller.stops).toBe(0);
  await press("q", "y"); expect(controller.stops).toBe(1); expect(frame()).not.toContain("退出程序");
  await press(keys.ctrlC, keys.ctrlC); expect(controller.stops).toBe(2); expect(controller.forced).toBe(0); expect(frame()).not.toContain("退出程序");
  controller.update({ stopping: true }); await settle();
  expect(frame()).toContain("正在停止并保存进度…（再按 Ctrl+C 立即退出）");
  await press(keys.ctrlC); expect(controller.forced).toBe(1); expect(controller.stops).toBe(2);
});

test("详情页显示路径、原因与建议、断点、副本和本地目标", async () => {
  const { frame, press } = mount(); await settle();
  await press(keys.down, keys.down, keys.down, keys.down, keys.enter);
  const text = frame();
  for (const part of ["文件详情", "「纪录片合集」", "相对路径", "2.1 GB（2,254,857,830 字节）", "✗ 失败 · 下载地址多次刷新后仍被拒绝", "下载地址多次刷新后仍被拒绝",
    "检查网络或代理后按 r 重试；断点已保存。", "3 次", "812 MB / 2.1 GB", "保留中 · 交付完成后才可能被回收", "PikPak-Test\\纪录片合集\\part1.mp4", "Esc 返回"]) expect(text).toContain(part);
  await press(keys.escape); expect(frame()).toContain("Enter 详情");
});

test("设置页修改下载目录与剪贴板监听；目录不可用时显示原因", async () => {
  const { controller, frame, press } = mount(); await settle();
  await press("s");
  expect(frame()).toContain("下载目录"); expect(frame()).toContain("● 开"); expect(frame()).toContain("仅对新接收的分享生效");
  await press(keys.down, " ");
  expect(controller.commands).toEqual([{ kind: "setClipboardWatch", enabled: false }]);
  await press(keys.up, keys.enter, "\\", "n", "e", "w");
  expect(frame()).toContain("PikPak-Test\\new▌");
  controller.result = { ok: false, reason: "output_unavailable" }; await press(keys.enter);
  expect(controller.commands.at(-1)).toEqual({ kind: "setOutputRoot", path: "C:\\Users\\demo\\Downloads\\PikPak-Test\\new" });
  expect(frame()).toContain("✗ 下载目录不可用或不可写");
  controller.result = { ok: true, ids: [], issues: [] }; await press(keys.enter);
  expect(frame()).not.toContain("▌"); await press(keys.escape); expect(frame()).toContain("Enter 详情");
});

test("粘贴框：多行粘贴不提交并实时预览；只粘贴提取码提示未识别", async () => {
  const { controller, frame, press } = mount(); await settle();
  await press("a");
  expect(frame()).toContain("粘贴分享文本");
  await press("\x1b[200~https://mypikpak.com/s/VOtest123\r\n\r\n \r\n\r\n提取码：ab12\x1b[201~");
  expect(frame()).toContain("✓ 识别到 1 个分享 · 提取码 ✓"); expect(controller.commands).toEqual([]);
  controller.result = { ok: true, ids: ["s_9"], issues: [] }; await press(keys.enter);
  expect(controller.commands).toEqual([{ kind: "submitText", text: "https://mypikpak.com/s/VOtest123\n\n \n\n提取码：ab12" }]);
  expect(frame()).not.toContain("粘贴分享文本");
  await press("a", "\x1b[200~提取码：ab12\x1b[201~");
  expect(frame()).toContain("未识别到分享链接");
  controller.result = { ok: true, ids: [], issues: [] }; await press(keys.enter);
  expect(frame()).toContain("未识别到分享链接，未接收任何分享");
  await press(keys.escape); expect(frame()).not.toContain("粘贴分享文本");
});

test("标题栏左侧程序名与版本，右端与分隔线对齐，窄窗口依次省略本地剩余与云盘", async () => {
  // ink-testing-library 的虚拟终端固定 100 列，更宽的布局由实机复看覆盖。
  const cases: Array<[number, string[], string[]]> = [
    [100, ["云盘 21 GB / 10 TB", "本地剩余 412 GB"], []],
    [80, ["云盘 21 GB / 10 TB"], ["本地剩余"]],
    [60, [], ["云盘", "本地剩余"]],
  ];
  for (const [columns, shown, hidden] of cases) {
    const { frame } = mount(new FakeController(), { columns, rows: 24 }); await settle();
    const [header = "", rule = ""] = frame().split("\n");
    expect(header).toContain(`${about.name}   v${about.version}`);
    expect(header).toContain("● 已登录"); expect(header).toContain("剪贴板 ● 监听中");
    for (const part of shown) expect(header).toContain(part);
    for (const part of hidden) expect(header).not.toContain(part);
    expect(displayWidth(header.trimEnd())).toBe(displayWidth(rule.trimEnd()));
    expect(header.trimEnd().endsWith("● 监听中")).toBe(true);
  }
});

test("按键提示上方的分隔线嵌入作者与项目地址，放不下时只画分隔线", async () => {
  const { frame } = mount(); await settle();
  const lines = frame().split("\n");
  const credit = lines.find(line => line.includes(about.site)) ?? "";
  expect(credit).toContain(`作者 ${about.author} · ${about.site} ──`);
  expect(displayWidth(credit.trimEnd())).toBe(displayWidth((lines[1] ?? "").trimEnd()));
  expect(lines[lines.indexOf(credit) + 1]).toContain("q 退出");
  const narrow = render(<Rule width={40} theme={createTheme({ NO_COLOR: "1" })} label={creditLabel} />); mounted.push(narrow.unmount);
  expect(stripAnsi(narrow.lastFrame() ?? "")).toBe("─".repeat(40));
});

test("设置页底部显示版本、作者与项目地址", async () => {
  const { frame, press } = mount(); await settle();
  await press("s");
  const text = frame();
  expect(text).toContain("关于"); expect(text).toContain(`${about.name}  v${about.version}  ·  作者 ${about.author}`); expect(text).toContain(about.homepage);
});

test("选中行的全部文字与进度条使用选中调色板，未选中行不使用", () => {
  const base = createTheme({});
  const calls: Array<[Tone, boolean]> = [];
  const theme: Theme = { ...base, paint: (tone, selected = false) => { calls.push([tone, selected]); return base.paint(tone, selected); } };
  const snapshot = mockSnapshot();
  const rows = buildRows({ shares: snapshot.shares, files: snapshot.files, expanded: {}, userPaused: false });
  const picked = [rows.find(row => row.kind === "share"), ...["f_2", "f_4", "f_5"].map(id => rows.find(row => row.kind === "file" && row.file.id === id))];
  for (const row of picked) {
    for (const selected of [true, false]) {
      calls.length = 0;
      const app = render(<RowLine row={row!} selected={selected} snapshot={snapshot} theme={theme} columns={120} />); app.unmount();
      expect(calls.length).toBeGreaterThan(2);
      expect(calls.every(([, flag]) => flag === selected)).toBe(true);
    }
  }
});

test("正在执行的文件显示动态图标；暂停或系统暂停时恢复静态图标", async () => {
  const controller = new FakeController();
  const { frame } = mount(controller); await settle();
  const downloading = () => frame().split("\n").find(line => line.includes("episode02.mkv")) ?? "";
  const icon = () => downloading().trim().replace(/^>\s*/, "").charAt(0);
  expect(SPINNER).toContain(icon());
  const first = icon(); await Bun.sleep(300);
  expect(SPINNER).toContain(icon()); expect(icon()).not.toBe(first);
  expect(frame().split("\n").find(line => line.includes("episode03.mkv"))).toContain("·  episode03.mkv");
  controller.update({ userPaused: true }); await settle();
  expect(icon()).toBe("⏸");
  controller.update({ userPaused: false, systemPause: { reason: "authentication", fileId: null } }); await settle();
  expect(icon()).toBe("↓");
});

test("设置页调整下载连接数：显示当前值，←→ 发出命令，到达 1 或 8 后不再越界", async () => {
  const controller = new FakeController();
  const { frame, press } = mount(controller); await settle();
  await press("s");
  expect(frame()).toContain("下载连接数"); expect(frame()).toContain("◀ 4 ▶"); expect(frame()).toContain("默认 4");
  await press(keys.down, keys.down);
  expect(frame()).toContain("←→ 调整");
  await press(keys.right, keys.left);
  expect(controller.commands).toEqual([{ kind: "setDownloadConnections", count: 5 }, { kind: "setDownloadConnections", count: 3 }]);
  controller.update({ connections: 8 }); await settle();
  expect(frame()).toContain("◀ 8 ▶");
  await press(keys.right); expect(controller.commands).toHaveLength(2);
  controller.update({ connections: 1 }); await settle();
  await press(keys.left); expect(controller.commands).toHaveLength(2);
  await press(keys.up); expect(frame()).toContain("Enter 修改"); expect(frame()).not.toContain("←→ 调整");
  await press(keys.up, keys.up); expect(frame()).toContain("←→ 调整");
});

