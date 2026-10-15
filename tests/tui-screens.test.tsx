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
  for (const part of ["PikPak Downloader", "● 已登录", "云盘 21.0 GB / 10 TB", "本地剩余 412.0 GB", "剪贴板 ● 监听中",
    "▼ 「某某合集」  1/3 完成 · 1 下载中 · 1 排队", "▼ 「纪录片合集」  0/2 完成 · 1 失败 · 1 等待", "▶ 「另一个分享」  2/2 完成",
    "48%  198 MB/412 MB  2.7 MB/s  1分19秒", "失败 · 下载地址多次刷新后仍被拒绝", "等待云端空间",
    "22:33:40  ✓ episode01.mkv 校验通过，已完成", "Enter 详情", "p 暂停", "P 全部暂停"]) expect(text).toContain(part);
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
  expect(text).toContain("48%  已暂停"); expect(text).toContain("1 暂停"); expect(text).toContain("P 全部开始"); expect(text).toContain("按 P 全部开始");
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
  await press(keys.down, "P", "r", "o");
  expect(controller.commands).toEqual([{ kind: "pauseQueue" }, { kind: "retry", id: "f_2" }]);
  expect(controller.opened).toEqual([{ shareId: "s_1", fileId: "f_2" }]);
  controller.update({ userPaused: true }); await settle();
  expect(frame()).toContain("⏸ 队列已暂停");
  await press("P"); expect(controller.commands.at(-1)).toEqual({ kind: "startAll" });
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
    "检查网络或代理后按 r 重试；断点已保存。", "3 次", "已下载部分 · 812 MB / 2.1 GB", "保留中 · 按 x 可立即释放", "PikPak-Test\\纪录片合集\\part1.mp4", "Esc 返回"]) expect(text).toContain(part);
  await press(keys.escape); expect(frame()).toContain("Enter 详情");
});

test("设置页修改下载目录与剪贴板监听；目录不可用时显示原因", async () => {
  const { controller, frame, press } = mount(); await settle();
  await press("s");
  expect(frame()).toContain("下载目录"); expect(frame()).toContain("● 开"); expect(frame()).toContain("新分享与尚未开始的分享使用新目录");
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
    [100, ["云盘 21.0 GB / 10 TB", "本地剩余 412.0 GB"], []],
    [80, ["云盘 21.0 GB / 10 TB"], ["本地剩余"]],
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

test("设置页调整同时下载文件数：←→ 发出命令，到达 1 或 5 后不越界；受账号等级限制时说明实际生效值", async () => {
  const controller = new FakeController();
  const { frame, press } = mount(controller); await settle();
  await press("s", keys.down, keys.down, keys.down);
  expect(frame()).toContain("同时下载文件数"); expect(frame()).toContain("会员最多 5 个，免费账号只能 1 个"); expect(frame()).toContain("←→ 调整");
  await press(keys.right, keys.left);
  expect(controller.commands).toEqual([{ kind: "setActiveFiles", count: 2 }]);
  controller.update({ activeFiles: { configured: 5, effective: 5, tier: "paid" } }); await settle();
  await press(keys.right); expect(controller.commands).toHaveLength(1);
  await press(keys.left); expect(controller.commands.at(-1)).toEqual({ kind: "setActiveFiles", count: 4 });
  expect(frame()).not.toContain("实际");
  controller.update({ activeFiles: { configured: 3, effective: 1, tier: "free" } }); await settle();
  expect(frame()).toContain("实际 1 · 免费账号同时只能下载 1 个文件");
  controller.update({ activeFiles: { configured: 3, effective: 1, tier: "unknown" } }); await settle();
  expect(frame()).toContain("暂时无法读取账号等级");
});

function concurrentSnapshot() {
  const snapshot = mockSnapshot(), mb = 1048576n;
  const files = { ...snapshot.files, s_1: snapshot.files.s_1!.map(item => item.id === "f_3" ? { ...item, state: "downloading" as const } : item) };
  return { ...snapshot, files, activeFiles: { configured: 3, effective: 3, tier: "paid" as const },
    progress: { ...snapshot.progress, f_3: { bytes: 10n * mb, size: 380n * mb, rate: 1.3 * 1048576, eta: 300 } } };
}

test("同时下载数大于 1 时标题栏显示在途文件数与合计速度；窄窗口依次省略本地剩余、云盘、合计速度、在途文件数", async () => {
  const cases: Array<[number, string[], string[]]> = [
    [100, ["下载中 2/3", "合计 4.0 MB/s"], ["云盘", "本地剩余"]],
    [80, ["下载中 2/3"], ["合计", "云盘", "本地剩余"]],
    [60, [], ["下载中", "合计", "云盘", "本地剩余"]],
  ];
  for (const [columns, shown, hidden] of cases) {
    const { frame } = mount(new FakeController(concurrentSnapshot()), { columns, rows: 24 }); await settle();
    const [header = "", rule = ""] = frame().split("\n");
    for (const part of shown) expect(header).toContain(part);
    for (const part of hidden) expect(header).not.toContain(part);
    expect(header).toContain("● 已登录"); expect(header).toContain("剪贴板 ● 监听中");
    expect(displayWidth(header.trimEnd())).toBe(displayWidth(rule.trimEnd()));
  }
  // 两行进度同时原地刷新，各自显示速度与动态图标。
  const { frame } = mount(new FakeController(concurrentSnapshot()), { columns: 100, rows: 24 }); await settle();
  const rows = frame().split("\n").filter(line => line.includes("episode02.mkv") || line.includes("episode03.mkv"));
  expect(rows).toHaveLength(2);
  for (const row of rows) { expect(row).toMatch(/MB\/s/); expect(SPINNER).toContain(row.trim().replace(/^>\s*/, "").charAt(0)); }
  // 暂停时不显示。
  const paused = mount(new FakeController({ ...concurrentSnapshot(), userPaused: true }), { columns: 100, rows: 24 }); await settle();
  expect(paused.frame().split("\n")[0]).not.toContain("下载中");
});

test("p 暂停或继续选中的文件或分享，P 在有暂停时全部开始；暂停项显示已暂停", async () => {
  const controller = new FakeController();
  const { frame, press } = mount(controller); await settle();
  await press(keys.down, "p");
  expect(controller.commands.at(-1)).toEqual({ kind: "pauseTask", id: "f_2" });
  const paused = mockSnapshot();
  paused.files.s_1 = paused.files.s_1!.map(item => item.id === "f_2" ? { ...item, paused: true } : item);
  controller.update({ files: paused.files }); await settle();
  const row = frame().split("\n").find(line => line.includes("episode02.mkv")) ?? "";
  expect(row).toContain("⏸"); expect(row).toContain("已暂停");
  expect(frame()).toContain("p 继续"); expect(frame()).toContain("P 全部开始");
  await press("p"); expect(controller.commands.at(-1)).toEqual({ kind: "resumeTask", id: "f_2" });
  await press("P"); expect(controller.commands.at(-1)).toEqual({ kind: "startAll" });
  // 暂停分享：分享行显示已暂停，文件行都显示已暂停；在文件上按 p 继续该分享。
  controller.update({ files: mockSnapshot().files, shares: mockSnapshot().shares.map(item => item.id === "s_1" ? { ...item, paused: true } : item) }); await settle();
  expect(frame()).toContain("「某某合集」"); expect(frame().split("\n").find(line => line.includes("「某某合集」"))).toContain("· 已暂停");
  expect(frame().split("\n").find(line => line.includes("episode03.mkv"))).toContain("已暂停");
  await press("p"); expect(controller.commands.at(-1)).toEqual({ kind: "resumeTask", id: "s_1" });
  await press(keys.up, "p"); expect(controller.commands.at(-1)).toEqual({ kind: "resumeTask", id: "s_1" });
});

test("x 释放云端副本：已完成与未完成文件的确认文字、分享范围、详情页；没有合格副本时只说明原因", async () => {
  const controller = new FakeController();
  const { frame, press } = mount(controller); await settle();
  expect(frame()).toContain("x 释放"); expect(frame()).toContain("q 退出");
  await press("x");
  expect(controller.previews).toEqual(["f_1"]);
  expect(frame()).toContain("释放云端副本"); expect(frame()).toContain("释放 episode01.mkv 的云端副本（412 MB）？");
  expect(frame()).toContain("不进回收站"); expect(frame()).toContain("任务记录一并删除"); expect(frame()).not.toContain("重新转存");
  await press("n"); expect(frame()).not.toContain("释放云端副本"); expect(controller.commands).toEqual([]);
  await press("x", "y"); expect(controller.commands.at(-1)).toEqual({ kind: "releaseCopy", id: "f_1" });

  controller.release = { ok: true, copies: 1, bytes: 412n * 1048576n, unfinished: 1, removed: 0 };
  await press(keys.down, "x");
  expect(frame()).toContain("释放 episode02.mkv 的云端副本"); expect(frame()).toContain("继续时从分享重新转存"); expect(frame()).toContain("分享失效将无法完成");
  await press(keys.escape);

  controller.release = { ok: true, copies: 2, bytes: 824n * 1048576n, unfinished: 0, removed: 2 };
  await press(keys.up, keys.up, "x");
  expect(frame()).toContain("释放「某某合集」中 2 个云端副本（824 MB）？");
  await press("y"); expect(controller.commands.at(-1)).toEqual({ kind: "releaseCopy", id: "s_1" });

  controller.release = { ok: false, reason: "copy_absent" };
  const before = controller.commands.length;
  await press(keys.down, "x");
  expect(frame()).not.toContain("释放云端副本"); expect(controller.commands).toHaveLength(before);
  expect(controller.notes.at(-1)?.text).toBe("episode01.mkv：没有可释放的云端副本");

  // 详情页：x 打开同样的确认框，确认后回到详情页。
  controller.release = { ok: true, copies: 1, bytes: 412n * 1048576n, unfinished: 0, removed: 1 };
  await press(keys.enter); expect(frame()).toContain("x 释放云端副本");
  await press("x"); expect(frame()).toContain("确认释放");
  await press("y"); expect(controller.commands.at(-1)).toEqual({ kind: "releaseCopy", id: "f_1" }); expect(frame()).toContain("x 释放云端副本");
});

test("x 在云盘中已没有副本的已完成任务上只删除记录；已完成与未完成混合时说明两种结果", async () => {
  const controller = new FakeController();
  const { frame, press } = mount(controller); await settle();
  controller.release = { ok: true, copies: 0, bytes: 0n, unfinished: 0, removed: 1 };
  await press("x");
  expect(frame()).toContain("删除任务记录"); expect(frame()).toContain("删除 episode01.mkv 的任务记录？");
  expect(frame()).toContain("云盘中已没有这些副本，只删除任务记录，本地文件保留。"); expect(frame()).toContain("确认删除");
  await press("y"); expect(controller.commands.at(-1)).toEqual({ kind: "releaseCopy", id: "f_1" });
  controller.release = { ok: true, copies: 2, bytes: 824n * 1048576n, unfinished: 1, removed: 1 };
  await press(keys.up, "x");
  expect(frame()).toContain("已完成的删除任务记录"); expect(frame()).toContain("继续时从分享重新转存");
});

test("位置列：本地、部分、缺失与云端两格；分享行显示在云端与本地缺失数；记录删除后行消失，详情页回到主面板", async () => {
  const controller = new FakeController();
  const { frame, press } = mount(controller); await settle();
  const line = (name: string) => frame().split("\n").find(item => item.includes(name)) ?? "";
  expect(line("episode01.mkv")).toMatch(/412 MB\s+本地\s+已完成/);
  expect(line("episode02.mkv")).toContain("部分 云端");
  expect(line("episode03.mkv")).not.toMatch(/本地|部分|云端/);
  expect(line("「某某合集」")).toContain("· 1 在云端");
  const files = mockSnapshot().files;
  files.s_1 = files.s_1!.map(item => item.id === "f_1" ? { ...item, copyState: "retained" as const } : item);
  controller.update({ files }); await settle();
  expect(line("episode01.mkv")).toContain("本地 云端"); expect(line("「某某合集」")).toContain("· 2 在云端");
  controller.update({ localMissing: new Set(["f_1"]) }); await settle();
  expect(line("episode01.mkv")).toContain("缺失 云端"); expect(line("「某某合集」")).toContain("· 1 本地缺失");
  await press(keys.enter);
  expect(frame()).toContain("本地文件"); expect(frame()).toContain("已不存在 · 被移动或删除");
  // 释放成功后记录被删除：详情页回到主面板，行消失。
  controller.update({ files: { ...files, s_1: files.s_1!.filter(item => item.id !== "f_1") } }); await settle();
  expect(frame()).not.toContain("文件详情"); expect(frame()).toContain("q 退出");
  expect(frame().split("\n").filter(item => item.includes("episode01.mkv") && !item.includes("校验通过"))).toEqual([]);
});
