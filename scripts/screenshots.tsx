// README 截图：用模拟数据渲染全屏界面，把带颜色的终端帧转换为 SVG，写入 docs/images/。不读写任务库，也不访问网络。
// 用法：bun scripts/screenshots.tsx
// 截图中的分享、文件、账号与链接都是虚构的；修改界面后重新运行即可更新截图。
import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ReactNode } from "react";

// chalk 在导入时检测颜色支持：先强制开启真彩色，再动态导入界面模块。
process.env.FORCE_COLOR = "3";
delete process.env.NO_COLOR;
const { render, Box, Text } = await import("ink");
const { TuiApp } = await import("../src/tui/app");
const { StartupApp } = await import("../src/tui/startup");
const { createTheme } = await import("../src/tui/theme");
const { LOGO } = await import("../src/tui/brand");
const { FakeController, file, keys, share } = await import("../tests/fixtures/tui");
type TuiSnapshot = import("../src/tui/controller").TuiSnapshot;
type StartupDeps = import("../src/tui/startup").StartupDeps;

const outDir = resolve(import.meta.dir, "..", "docs", "images");
const theme = createTheme({});

// ---------- 模拟数据 ----------

const MB = 1048576n, GB = 1024n * MB;
const ROOT = "D:\\Downloads\\PikPak", MEDIA = "E:\\Media\\纪录片";
const at = (time: string) => Date.parse(`2026-10-15T${time}`);
function showcase(): TuiSnapshot {
  const movies = share("s_movies", "Blender 开源电影合集", "partial", { outputRoot: ROOT });
  const course = share("s_course", "公开课：线性代数", "completed", { outputRoot: ROOT });
  const nature = share("s_nature", "自然纪录片 4K", "partial", { outputRoot: MEDIA });
  return {
    shares: [movies, course, nature],
    files: {
      s_movies: [
        file("f_bbb", "s_movies", "Big Buck Bunny (2008).mkv", "completed", 885n * MB, { copyState: "retained" }),
        file("f_sintel", "s_movies", "Sintel (2010).mkv", "downloading", 1229n * MB, { checkpoint: 774n * MB, copyState: "retained" }),
        file("f_tears", "s_movies", "Tears of Steel (2012).mkv", "downloading", 2458n * MB, { checkpoint: 516n * MB, copyState: "retained" }),
        file("f_spring", "s_movies", "Spring (2019).mkv", "saving", 1720n * MB),
        file("f_cosmos", "s_movies", "Cosmos Laundromat (2015).mkv", "ready", 1946n * MB),
      ],
      s_course: Array.from({ length: 12 }, (_, index) =>
        file(`f_la${index}`, "s_course", `第 ${String(index + 1).padStart(2, "0")} 讲.mp4`, "completed", 320n * MB)),
      s_nature: [
        file("f_ocean", "s_nature", "第 01 集 · 海洋的深处.mp4", "failed", 6871947674n, { lastError: "network_failure", retries: 3n, checkpoint: 3407n * MB, copyState: "retained" }),
        file("f_forest", "s_nature", "第 02 集 · 森林的四季.mp4", "waiting_space", 7194070220n),
      ],
    },
    quota: { usage: 5734n * MB, limit: 10n * 1024n * GB }, localFree: 1843n * GB, clipboard: "on", userPaused: false, systemPause: null,
    progress: {
      f_sintel: { bytes: 774n * MB, size: 1229n * MB, rate: 6.4 * 1048576, eta: 71 },
      f_tears: { bytes: 516n * MB, size: 2458n * MB, rate: 5.1 * 1048576, eta: 381 },
    },
    events: [
      { at: at("21:04:12"), icon: "⟳", tone: "scan", text: "「Blender 开源电影合集」扫描完成：5 个文件" },
      { at: at("21:06:47"), icon: "✓", tone: "done", text: "Big Buck Bunny (2008).mkv 校验通过，已完成" },
      { at: at("21:07:03"), icon: "♻", tone: "done", text: "已释放「公开课：线性代数」的 12 个云端副本，腾出 3.8 GB" },
    ],
    outputRoot: ROOT, stopping: false, connections: 4, activeFiles: { configured: 3, effective: 3, tier: "paid" }, localMissing: new Set<string>(), releasing: new Set<string>(),
    account: { id: "demo-account", name: "演示用户", email: "demo@example.com", scopes: ["account", "files:manage", "share", "cloud_download"],
      membership: { tier: "paid", type: "platinum", expire: Date.parse("2027-06-30T12:00:00") } },
  };
}
class ShowcaseController extends FakeController {
  constructor() {
    super(showcase());
    this.release = { ok: true, copies: 1, bytes: 885n * MB, unfinished: 0, removed: 1 };
  }
  override targetPath = (fileId: string): string | null => fileId === "f_ocean" ? `${MEDIA}\\自然纪录片 4K\\第 01 集 · 海洋的深处.mp4` : null;
}
const PASTE = "Blender 开源电影合集\n链接：https://mypikpak.com/s/synthetic-demo\n提取码：demo";

// ---------- 渲染为终端帧 ----------

type Size = { columns: number; rows: number };
class Output extends EventEmitter { frame = ""; constructor(readonly columns: number, readonly rows: number) { super(); } write = (frame: string) => { this.frame = frame; }; }
// 与 ink-testing-library 相同的输入桩：write 触发 readable 与 data。
class Input extends EventEmitter {
  isTTY = true; private data: string | null = null;
  write = (data: string) => { this.data = data; this.emit("readable"); this.emit("data", data); };
  read = () => { const { data } = this; this.data = null; return data; };
  setEncoding() {} setRawMode() {} resume() {} pause() {} ref() {} unref() {}
}
async function capture(tree: (size: Size) => ReactNode, size: Size, inputs: string[] = []): Promise<string> {
  const stdout = new Output(size.columns, size.rows), stdin = new Input();
  const app = render(tree(size), { stdout: stdout as never, stdin: stdin as never, debug: true, exitOnCtrlC: false, patchConsole: false });
  await Bun.sleep(60);
  for (const input of inputs) { stdin.write(input); await Bun.sleep(60); }
  const frame = stdout.frame;
  app.unmount();
  return frame;
}

// ---------- 终端帧转为 SVG ----------

type Style = { fg: string | null; bg: string | null; bold: boolean; inverse: boolean };
type Cell = { char: string; width: number; style: Style } | null;
const plain = (): Style => ({ fg: null, bg: null, bold: false, inverse: false });
// 深色终端配色：标准 16 色依次为黑、红、绿、黄、蓝、品红、青、白，再接 8 个亮色。
const COLORS = ["#2a2d3a", "#f7768e", "#9ece6a", "#e0af68", "#5a8df0", "#bb9af7", "#5ccfe6", "#c8cee0",
  "#6b7089", "#ff8fa3", "#b9f27c", "#ffd580", "#82aaff", "#d4b8ff", "#8be9fd", "#ffffff"];
const BACKGROUND = "#16171f", FOREGROUND = "#c8cee0";

function parse(frame: string): Cell[][] {
  const rows: Cell[][] = [[]];
  let style = plain(), column = 0;
  const segmenter = new Intl.Segmenter();
  for (let index = 0; index < frame.length;) {
    if (frame[index] === "\x1b") {
      const match = /^\x1b\[([0-9;]*)m/.exec(frame.slice(index));
      if (!match) throw Error(`不支持的控制序列：${JSON.stringify(frame.slice(index, index + 8))}`);
      const codes = match[1] ? match[1].split(";").map(Number) : [0];
      for (let at = 0; at < codes.length; at++) {
        const code = codes[at]!;
        if (code === 0) style = plain();
        else if (code === 1) style = { ...style, bold: true };
        else if (code === 22) style = { ...style, bold: false };
        else if (code === 7) style = { ...style, inverse: true };
        else if (code === 27) style = { ...style, inverse: false };
        else if (code >= 30 && code <= 37) style = { ...style, fg: COLORS[code - 30]! };
        else if (code >= 90 && code <= 97) style = { ...style, fg: COLORS[code - 82]! };
        else if (code === 39) style = { ...style, fg: null };
        else if (code >= 40 && code <= 47) style = { ...style, bg: COLORS[code - 40]! };
        else if (code >= 100 && code <= 107) style = { ...style, bg: COLORS[code - 92]! };
        else if (code === 49) style = { ...style, bg: null };
        else if ((code === 38 || code === 48) && codes[at + 1] === 2) {
          const hex = "#" + codes.slice(at + 2, at + 5).map(value => value.toString(16).padStart(2, "0")).join("");
          style = code === 38 ? { ...style, fg: hex } : { ...style, bg: hex }; at += 4;
        }
      }
      index += match[0].length;
      continue;
    }
    if (frame[index] === "\n") { rows.push([]); column = 0; index++; continue; }
    const next = frame.indexOf("\x1b", index), end = frame.indexOf("\n", index);
    const stop = Math.min(next < 0 ? frame.length : next, end < 0 ? frame.length : end);
    for (const { segment } of segmenter.segment(frame.slice(index, stop))) {
      const width = Bun.stringWidth(segment);
      if (width === 0) continue;
      const row = rows.at(-1)!;
      row[column] = { char: segment, width, style };
      if (width === 2) row[column + 1] = null;
      column += width;
    }
    index = stop;
  }
  return rows;
}

const CELL_W = 8.4, CELL_H = 18, FONT = 14;
const FONTS = "'Cascadia Mono', 'JetBrains Mono', 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', 'Microsoft YaHei UI', 'PingFang SC', 'Noto Sans Mono CJK SC', monospace";
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const round = (value: number) => Math.round(value * 100) / 100;

// 方块与框线字符画成图形：字体回退时字形宽度、行距各不相同，画成图形才能保证相邻字符严丝合缝。
function shape(char: string, x: number, y: number, color: string): string | null {
  const cx = round(x + CELL_W / 2), cy = round(y + CELL_H / 2), r = round(CELL_W / 2), d = 1.6;
  const right = round(x + CELL_W), bottom = round(y + CELL_H);
  const stroke = (path: string, width = 1.2) => `<path d="${path}" stroke="${color}" stroke-width="${width}" fill="none"/>`;
  switch (char) {
    case "░": return `<rect x="${round(x)}" y="${round(y + 3)}" width="${round(CELL_W + 0.3)}" height="${CELL_H - 6}" fill="${color}" opacity="0.3"/>`;
    case "▌": return `<rect x="${round(x)}" y="${round(y + 1)}" width="${round(CELL_W / 2)}" height="${CELL_H - 2}" fill="${color}"/>`;
    case "─": return stroke(`M${round(x)} ${cy}H${right}`);
    case "━": return stroke(`M${round(x)} ${cy}H${right}`, 2.4);
    case "│": return stroke(`M${cx} ${round(y)}V${bottom}`);
    case "╭": return stroke(`M${right} ${cy}A${r} ${r} 0 0 0 ${cx} ${round(cy + r)}V${bottom}`);
    case "╮": return stroke(`M${round(x)} ${cy}A${r} ${r} 0 0 1 ${cx} ${round(cy + r)}V${bottom}`);
    case "╰": return stroke(`M${cx} ${round(y)}V${round(cy - r)}A${r} ${r} 0 0 0 ${round(cx + r)} ${cy}H${right}`);
    case "╯": return stroke(`M${cx} ${round(y)}V${round(cy - r)}A${r} ${r} 0 0 1 ${round(cx - r)} ${cy}H${round(x)}`);
    case "═": return stroke(`M${round(x)} ${cy - d}H${right}M${round(x)} ${cy + d}H${right}`);
    case "║": return stroke(`M${cx - d} ${round(y)}V${bottom}M${cx + d} ${round(y)}V${bottom}`);
    case "╔": return stroke(`M${right} ${cy - d}H${cx - d}V${bottom}M${right} ${cy + d}H${cx + d}V${bottom}`);
    case "╗": return stroke(`M${round(x)} ${cy - d}H${cx + d}V${bottom}M${round(x)} ${cy + d}H${cx - d}V${bottom}`);
    case "╚": return stroke(`M${cx - d} ${round(y)}V${cy + d}H${right}M${cx + d} ${round(y)}V${cy - d}H${right}`);
    case "╝": return stroke(`M${cx + d} ${round(y)}V${cy + d}H${round(x)}M${cx - d} ${round(y)}V${cy - d}H${round(x)}`);
    default: return null;
  }
}

// 把单元格画在 (left, top) 起的区域内；同一行相同样式的字符合成一个 <text>，逐字给出横坐标。
function drawCells(rows: Cell[][], left: number, top: number): string {
  const parts: string[] = [];
  rows.forEach((row, line) => {
    const y = top + line * CELL_H;
    // 背景：相邻且颜色相同的单元格合并成一个矩形。
    for (let column = 0; column < row.length;) {
      const cell = row[column];
      const bg = cell && (cell.style.inverse ? cell.style.fg ?? FOREGROUND : cell.style.bg);
      if (!cell || !bg) { column++; continue; }
      let end = column + cell.width;
      while (end < row.length) {
        const next = row[end];
        if (next === undefined) break;
        if (next === null) { end++; continue; }
        if ((next.style.inverse ? next.style.fg ?? FOREGROUND : next.style.bg) !== bg) break;
        end += next.width;
      }
      parts.push(`<rect x="${round(left + column * CELL_W)}" y="${y}" width="${round((end - column) * CELL_W + 0.3)}" height="${CELL_H}" fill="${bg}" shape-rendering="crispEdges"/>`);
      column = end;
    }
    // 实心方块：同一行相邻且颜色相同的合成一个矩形，避免相邻矩形之间出现抗锯齿接缝。
    for (let column = 0; column < row.length;) {
      const cell = row[column];
      if (cell?.char !== "█") { column++; continue; }
      const fill = cell.style.fg ?? FOREGROUND;
      let end = column + 1;
      while (row[end]?.char === "█" && (row[end]!.style.fg ?? FOREGROUND) === fill) end++;
      parts.push(`<rect x="${round(left + column * CELL_W)}" y="${y}" width="${round((end - column) * CELL_W)}" height="${CELL_H}" fill="${fill}" shape-rendering="crispEdges"/>`);
      column = end;
    }
    let run: { fill: string; bold: boolean; chars: string[]; xs: number[] } | null = null;
    const flush = () => {
      if (run) parts.push(`<text x="${run.xs.join(" ")}" y="${round(y + CELL_H * 0.74)}" fill="${run.fill}"${run.bold ? " font-weight=\"700\"" : ""}>${escape(run.chars.join(""))}</text>`);
      run = null;
    };
    row.forEach((cell, column) => {
      if (!cell) return;
      const fill = cell.style.inverse ? cell.style.bg ?? BACKGROUND : cell.style.fg ?? FOREGROUND;
      const x = left + column * CELL_W;
      const drawn = cell.char === "█" ? "" : shape(cell.char, x, y, fill);
      if (drawn !== null || cell.char === " ") { flush(); if (drawn) parts.push(drawn); return; }
      if (!run || run.fill !== fill || run.bold !== cell.style.bold) { flush(); run = { fill, bold: cell.style.bold, chars: [], xs: [] }; }
      run.chars.push(cell.char); run.xs.push(round(x));
    });
    flush();
  });
  return parts.join("\n");
}

const svg = (width: number, height: number, label: string, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${round(width)}" height="${round(height)}" viewBox="0 0 ${round(width)} ${round(height)}" role="img" aria-label="${escape(label)}">
<g font-family="${FONTS}" font-size="${FONT}" xml:space="preserve">
${body}
</g>
</svg>
`;

// 终端窗口：圆角、标题栏与三个窗口按钮。
function windowSvg(frame: string, size: Size, label: string): string {
  const rows = parse(frame).slice(0, size.rows);
  const pad = 18, bar = 36, width = size.columns * CELL_W + pad * 2, height = bar + size.rows * CELL_H + pad * 1.5;
  const body = [
    `<rect width="${round(width)}" height="${round(height)}" rx="10" fill="${BACKGROUND}"/>`,
    `<rect x="0.5" y="0.5" width="${round(width - 1)}" height="${round(height - 1)}" rx="10" fill="none" stroke="#2f3242"/>`,
    `<path d="M0.5 ${bar}H${round(width - 0.5)}" stroke="#262836"/>`,
    ...["#ff5f57", "#febc2e", "#28c840"].map((color, index) => `<circle cx="${20 + index * 20}" cy="${bar / 2}" r="6" fill="${color}"/>`),
    `<text x="${round(width / 2)}" y="${bar / 2 + 4.5}" fill="#6b7089" text-anchor="middle" font-size="12.5">pikpak-downloader</text>`,
    drawCells(rows, pad, bar + pad * 0.6),
  ];
  return svg(width, height, label, body.join("\n"));
}

// 标题图：只画标志、副标题与一句说明，去掉末尾空白行列后居中。
function logoSvg(frame: string): string {
  const rows = parse(frame);
  while (rows.length && rows.at(-1)!.every(cell => !cell || cell.char === " ")) rows.pop();
  const columns = Math.max(...rows.map(row => row.length));
  const padX = 36, padY = 28, width = columns * CELL_W + padX * 2, height = rows.length * CELL_H + padY * 2;
  const body = [`<rect width="${round(width)}" height="${round(height)}" rx="14" fill="${BACKGROUND}"/>`, drawCells(rows, padX, padY)];
  return svg(width, height, "PikPak Downloader", body.join("\n"));
}

// ---------- 各个画面 ----------

function Logo() {
  return (
    <Box flexDirection="column" alignItems="center" width={LOGO[0]!.length + 8}>
      {LOGO.map((line, index) => (
        <Text key={index}>{(line.match(/█+|[^█]+/g) ?? []).map((run, at) => <Text key={at} {...theme.paint(run.startsWith("█") ? "active" : "transfer")}>{run}</Text>)}</Text>
      ))}
      <Text {...theme.paint("strong")} bold>D  O  W  N  L  O  A  D  E  R</Text>
      <Text> </Text>
      <Text {...theme.paint("muted")}>复制分享文本 → 转存到 PikPak 云盘 → 下载到本地</Text>
    </Box>
  );
}

const startupDeps = (account: string | null, root: string | null): StartupDeps => ({
  busy: false, account: async () => account, outputRoot: async () => root, defaultOutputRoot: ROOT,
  login: () => new Promise(() => {}), saveOutputRoot: async () => ({ ok: true }), start: async () => new ShowcaseController(), exit: () => {},
});
const main = (size: Size) => <TuiApp controller={new ShowcaseController()} theme={theme} size={size} />;
const MAIN: Size = { columns: 112, rows: 21 };
const shots: Array<{ name: string; label: string; size: Size; tree: (size: Size) => ReactNode; inputs?: string[] }> = [
  { name: "main", label: "主面板：按下载目录分组的分享与文件、进度和事件", size: MAIN, tree: main, inputs: [keys.down] },
  { name: "login", label: "首次启动：在浏览器中完成 PikPak 官方授权", size: { columns: 112, rows: 24 },
    tree: size => <StartupApp deps={startupDeps(null, null)} theme={theme} size={size} splashMs={0} /> },
  { name: "paste", label: "按 a 粘贴分享文本，实时识别链接与提取码", size: MAIN, tree: main, inputs: ["a", `\x1b[200~${PASTE}\x1b[201~`] },
  { name: "detail", label: "文件详情：原因、建议、断点与云端副本", size: { columns: 112, rows: 16 }, tree: main,
    inputs: [...Array<string>(7).fill(keys.down), keys.enter] },
  { name: "release", label: "按 x 释放云端副本前的确认", size: MAIN, tree: main, inputs: ["x"] },
  { name: "settings", label: "设置：下载目录、剪贴板监听、连接数与同时下载文件数", size: { columns: 112, rows: 23 }, tree: main, inputs: ["s"] },
];

await mkdir(outDir, { recursive: true });
const logoFrame = await capture(() => <Logo />, { columns: LOGO[0]!.length + 8, rows: 10 });
await Bun.write(join(outDir, "logo.svg"), logoSvg(logoFrame));
console.log("docs/images/logo.svg");
for (const shot of shots) {
  const frame = await capture(shot.tree, shot.size, shot.inputs);
  await Bun.write(join(outDir, `${shot.name}.svg`), windowSvg(frame, shot.size, shot.label));
  console.log(`docs/images/${shot.name}.svg`);
}
process.exit(0);
