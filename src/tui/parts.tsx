import { Box, Text } from "ink";
import { useEffect, useState, type ReactNode } from "react";
import type { Highlight, Theme, Tone } from "./theme";
import type { TuiSnapshot } from "./controller";
import { displayWidth, formatBytes, formatSpeed } from "./format";
import { pauseExplanation } from "./view-model";
import { about } from "../about";

// Box 只支持背景色；无颜色模式下选中改由文字反色表示。
export const boxHighlight = (highlight: Highlight, on: boolean) => on && "backgroundColor" in highlight ? { backgroundColor: highlight.backgroundColor } : {};
export const textHighlight = (highlight: Highlight, on: boolean) => !on ? {} : "inverse" in highlight ? { inverse: true } : highlight.color ? { color: highlight.color } : {};

export const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
// 有正在执行的项目时每 120 ms 换一帧，否则不启动计时器。
export function useSpinner(enabled: boolean): number | null {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setFrame(value => (value + 1) % SPINNER.length), 120);
    return () => clearInterval(timer);
  }, [enabled]);
  return enabled ? frame : null;
}

export type Segment = { text: string; tone: Tone };
const segmentsWidth = (segments: Segment[]) => segments.reduce((sum, segment) => sum + displayWidth(segment.text), 0);
const Segments = ({ segments, theme }: { segments: Segment[]; theme: Theme }) =>
  <>{segments.map((segment, index) => <Text key={index} {...theme.paint(segment.tone)}>{segment.text}</Text>)}</>;

// 分隔线可在右端嵌入一段说明；放不下时只画分隔线。
export function Rule({ width, theme, label }: { width: number; theme: Theme; label?: Segment[] }) {
  const room = label ? width - segmentsWidth(label) - 4 : 0;
  if (!label || room < 8) return <Text {...theme.paint("muted")}>{"─".repeat(Math.max(0, width))}</Text>;
  return <Text><Text {...theme.paint("muted")}>{"─".repeat(room)} </Text><Segments segments={label} theme={theme} /><Text {...theme.paint("muted")}> ──</Text></Text>;
}
export const creditLabel: Segment[] = [{ text: "作者 ", tone: "muted" }, { text: about.author, tone: "text" }, { text: " · ", tone: "muted" }, { text: about.site, tone: "muted" }];
export function Keys({ items, theme }: { items: Array<[string, string]>; theme: Theme }) {
  return (
    <Text wrap="truncate-end">
      {items.map(([key, label]) => <Text key={key}><Text {...theme.paint("key")} bold>{key}</Text><Text {...theme.paint("muted")}> {label}  </Text></Text>)}
    </Text>
  );
}
export function Bar({ percent, theme, tone = "active", width = 14, selected = false }: { percent: number; theme: Theme; tone?: Tone; width?: number; selected?: boolean }) {
  const filled = Math.max(0, Math.min(width, Math.round(percent / 100 * width)));
  return <Text><Text {...theme.paint(tone, selected)}>{"█".repeat(filled)}</Text><Text {...theme.paint("muted", selected)}>{"░".repeat(width - filled)}</Text></Text>;
}
export function Title({ text, theme, extra }: { text: string; theme: Theme; extra?: ReactNode }) {
  const title = theme.title;
  return <Box><Text bold {...("inverse" in title ? { inverse: true } : { backgroundColor: title.backgroundColor, ...(title.color ? { color: title.color } : {}) })}> {text} </Text>{extra}</Box>;
}

type HeaderItem = { segments: Segment[]; optional?: number };
const ITEM_GAP = 3;
// 正在下载、校验或落盘的文件（不含已取消）。只在同时下载数生效值大于 1 时显示，单文件时与该行的速度重复；暂停时执行器不在工作，不显示。
const DELIVERING = new Set(["downloading", "verifying", "publishing"]);
export function delivering(snapshot: TuiSnapshot): { count: number; rate: number } {
  if (snapshot.activeFiles.effective <= 1 || snapshot.userPaused || snapshot.systemPause) return { count: 0, rate: 0 };
  const files = Object.values(snapshot.files).flat().filter(file => !file.cancelled && DELIVERING.has(file.state));
  return { count: files.length, rate: files.reduce((sum, file) => sum + (snapshot.progress[file.id]?.rate ?? 0), 0) };
}

// 状态项按显示顺序排列；optional 越大越先省略：本地剩余、云盘、合计速度、在途文件数，登录与剪贴板始终保留。
export function headerItems(snapshot: TuiSnapshot, available: number): Segment[][] {
  const clipboard: Segment = snapshot.clipboard === "on" ? { tone: "done", text: "● 监听中" }
    : snapshot.clipboard === "off" ? { tone: "muted", text: "○ 已关闭" } : { tone: "warning", text: "⚠ 正在重试" };
  const active = delivering(snapshot);
  let items: HeaderItem[] = [
    { segments: [{ text: "● ", tone: "done" }, { text: "已登录", tone: "text" }] },
    ...active.count ? [{ optional: 1, segments: [{ text: "下载中 ", tone: "muted" }, { text: `${active.count}/${snapshot.activeFiles.effective}`, tone: "active" }] } satisfies HeaderItem] : [],
    ...active.count && active.rate > 0 ? [{ optional: 2, segments: [{ text: "合计 ", tone: "muted" }, { text: formatSpeed(active.rate), tone: "active" }] } satisfies HeaderItem] : [],
    ...snapshot.quota ? [{ optional: 3, segments: [{ text: "云盘 ", tone: "muted" }, { text: `${formatBytes(snapshot.quota.usage, true)} / ${formatBytes(snapshot.quota.limit)}`, tone: "text" }] } satisfies HeaderItem] : [],
    ...snapshot.localFree !== null ? [{ optional: 4, segments: [{ text: "本地剩余 ", tone: "muted" }, { text: formatBytes(snapshot.localFree, true), tone: "text" }] } satisfies HeaderItem] : [],
    { segments: [{ text: "剪贴板 ", tone: "muted" }, clipboard] },
  ];
  const width = (list: HeaderItem[]) => list.reduce((sum, item) => sum + segmentsWidth(item.segments), 0) + ITEM_GAP * Math.max(0, list.length - 1);
  for (const level of [4, 3, 2, 1]) if (width(items) > available) items = items.filter(item => item.optional !== level);
  return items.map(item => item.segments);
}

// 左侧程序名与版本，右侧状态项，右端与分隔线对齐。
export function Header({ snapshot, theme, width }: { snapshot: TuiSnapshot; theme: Theme; width: number }) {
  const version = `  v${about.version}`;
  const left = displayWidth(` ${about.name} `) + displayWidth(version);
  const items = headerItems(snapshot, width - left - 2);
  return (
    <Box width={width} justifyContent="space-between">
      <Box flexShrink={0}><Title text={about.name} theme={theme} extra={<Text {...theme.paint("muted")}>{version}</Text>} /></Box>
      <Text wrap="truncate-start">
        {items.map((segments, index) => <Text key={index}>{index > 0 && " ".repeat(ITEM_GAP)}<Segments segments={segments} theme={theme} /></Text>)}
      </Text>
    </Box>
  );
}

// 用户暂停与系统暂停分别显示：继续只解除用户暂停。
export function Banners({ snapshot, theme }: { snapshot: TuiSnapshot; theme: Theme }) {
  const banner = theme.banner;
  const badge = (text: string) => <Text bold {...("inverse" in banner ? { inverse: true } : { backgroundColor: banner.backgroundColor, ...(banner.color ? { color: banner.color } : {}) })}> {text} </Text>;
  const system = snapshot.systemPause ? pauseExplanation(snapshot.systemPause) : null;
  return (
    <>
      {snapshot.userPaused && <Text wrap="truncate-end">{badge("⏸ 队列已暂停")}<Text {...theme.paint("warning")}>  当前下载已在安全点停止，断点已保存。按 </Text><Text {...theme.paint("key")} bold>p</Text><Text {...theme.paint("warning")}> 继续</Text></Text>}
      {system && <Text wrap="truncate-end">{badge("⏸ 执行已暂停")}<Text {...theme.paint("warning")}>  {system.reason}。{system.advice}</Text></Text>}
    </>
  );
}
export const bannerLines = (snapshot: TuiSnapshot) => (snapshot.userPaused ? 1 : 0) + (snapshot.systemPause ? 1 : 0);
