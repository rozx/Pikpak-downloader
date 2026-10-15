import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { Highlight, Theme, Tone } from "./theme";
import type { TuiSnapshot } from "./controller";
import { formatBytes } from "./format";
import { pauseExplanation } from "./view-model";

// Box 只支持背景色；无颜色模式下选中改由文字反色表示。
export const boxHighlight = (highlight: Highlight, on: boolean) => on && "backgroundColor" in highlight ? { backgroundColor: highlight.backgroundColor } : {};
export const textHighlight = (highlight: Highlight, on: boolean) => !on ? {} : "inverse" in highlight ? { inverse: true } : highlight.color ? { color: highlight.color } : {};

export function Rule({ width, theme }: { width: number; theme: Theme }) {
  return <Text {...theme.paint("muted")}>{"─".repeat(Math.max(0, width))}</Text>;
}
export function Keys({ items, theme }: { items: Array<[string, string]>; theme: Theme }) {
  return (
    <Text wrap="truncate-end">
      {items.map(([key, label]) => <Text key={key}><Text {...theme.paint("key")} bold>{key}</Text><Text {...theme.paint("muted")}> {label}  </Text></Text>)}
    </Text>
  );
}
export function Bar({ percent, theme, tone = "active", width = 14 }: { percent: number; theme: Theme; tone?: Tone; width?: number }) {
  const filled = Math.max(0, Math.min(width, Math.round(percent / 100 * width)));
  return <Text><Text {...theme.paint(tone)}>{"█".repeat(filled)}</Text><Text {...theme.paint("muted")}>{"░".repeat(width - filled)}</Text></Text>;
}
export function Title({ text, theme, extra }: { text: string; theme: Theme; extra?: ReactNode }) {
  const title = theme.title;
  return <Box><Text bold {...("inverse" in title ? { inverse: true } : { backgroundColor: title.backgroundColor, ...(title.color ? { color: title.color } : {}) })}> {text} </Text>{extra}</Box>;
}

export function Header({ snapshot, theme }: { snapshot: TuiSnapshot; theme: Theme }) {
  const clipboard = snapshot.clipboard === "on" ? { tone: "done" as const, text: "● 监听中" }
    : snapshot.clipboard === "off" ? { tone: "muted" as const, text: "○ 已关闭" } : { tone: "warning" as const, text: "⚠ 正在重试" };
  return (
    <Title text="PikPak Downloader" theme={theme} extra={
      <Text wrap="truncate-end">
        <Text {...theme.paint("done")}>  ● </Text><Text {...theme.paint("text")}>已登录</Text>
        {snapshot.quota && <Text><Text {...theme.paint("muted")}>   云盘 </Text><Text {...theme.paint("text")}>{formatBytes(snapshot.quota.usage)} / {formatBytes(snapshot.quota.limit)}</Text></Text>}
        {snapshot.localFree !== null && <Text><Text {...theme.paint("muted")}>   本地剩余 </Text><Text {...theme.paint("text")}>{formatBytes(snapshot.localFree)}</Text></Text>}
        <Text {...theme.paint("muted")}>   剪贴板 </Text><Text {...theme.paint(clipboard.tone)}>{clipboard.text}</Text>
      </Text>
    } />
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
