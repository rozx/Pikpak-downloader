import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { Theme } from "./theme";
import type { TuiSnapshot } from "./controller";
import { formatBytes, formatDuration, formatSpeed, truncateMiddle } from "./format";
import type { Row, ShareCounts } from "./view-model";
import { Banners, Bar, Header, Keys, Rule, bannerLines, boxHighlight, textHighlight } from "./parts";

export type Size = { columns: number; rows: number };
export const MIN_COLUMNS = 60, MIN_ROWS = 15;
const EVENT_LINES = 3;
// 标题、横幅、三条分隔线、事件区与按键提示之外的高度留给列表；覆盖层（确认框、粘贴框）占用列表底部。
export function panelLayout(size: Size, snapshot: TuiSnapshot, overlayLines = 0): { listHeight: number; eventLines: number } {
  const eventLines = Math.min(EVENT_LINES, snapshot.events.length || 1);
  return { listHeight: Math.max(1, size.rows - 1 - bannerLines(snapshot) - 3 - eventLines - 1 - overlayLines), eventLines };
}
const nameWidthFor = (columns: number) => Math.max(18, Math.min(48, columns - 72));

function CountsText({ counts, theme, scanning, cancelled }: { counts: ShareCounts; theme: Theme; scanning: boolean; cancelled: boolean }) {
  const part = (value: number, text: string, tone: Parameters<Theme["paint"]>[0]) => value > 0 ? <Text {...theme.paint(tone)}> · {value} {text}</Text> : null;
  if (scanning && counts.total === 0) return <Text {...theme.paint("scan")}>  扫描中…</Text>;
  return (
    <Text>
      <Text {...theme.paint(counts.completed === counts.total && counts.total > 0 ? "done" : "text")}>  {counts.completed}/{counts.total} 完成</Text>
      {part(counts.downloading, "下载中", "active")}{part(counts.transferring, "转存中", "transfer")}{part(counts.paused, "暂停", "warning")}
      {part(counts.queued, "排队", "muted")}{part(counts.failed, "失败", "error")}{part(counts.waiting, "等待", "warning")}{part(counts.cancelled, "已取消", "muted")}
      {cancelled && <Text {...theme.paint("muted")}> · 分享已取消</Text>}
    </Text>
  );
}

function FileStatus({ row, snapshot, theme }: { row: Extract<Row, { kind: "file" }>; snapshot: TuiSnapshot; theme: Theme }) {
  const progress = snapshot.progress[row.file.id];
  const bytes = progress?.bytes ?? row.file.checkpoint, size = row.file.size;
  const percent = size > 0n ? Number(bytes * 100n / size) : 100;
  if (row.look.label === "已暂停") {
    return <Text><Bar percent={percent} theme={theme} tone="warning" /><Text {...theme.paint("text")}>  {percent}%</Text><Text {...theme.paint("warning")}>  已暂停</Text></Text>;
  }
  if (row.file.state === "downloading" && !row.file.cancelled) {
    return (
      <Text>
        <Bar percent={percent} theme={theme} /><Text {...theme.paint("strong")}>  {percent}%</Text>
        <Text {...theme.paint("text")}>  {formatBytes(bytes)}/{formatBytes(size)}</Text>
        {progress?.rate != null && <Text {...theme.paint("active")}>  {formatSpeed(progress.rate)}</Text>}
        {progress?.eta != null && <Text {...theme.paint("muted")}>  {formatDuration(progress.eta)}</Text>}
      </Text>
    );
  }
  return <Text {...theme.paint(row.look.tone)} wrap="truncate-end">{row.look.label}</Text>;
}

export function RowLine({ row, selected, snapshot, theme, columns }: { row: Row; selected: boolean; snapshot: TuiSnapshot; theme: Theme; columns: number }) {
  if (row.kind === "share") {
    const path = truncateMiddle(row.share.outputRoot, Math.max(10, Math.floor(columns / 3)));
    return (
      <Box {...boxHighlight(theme.selection, selected)}>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            <Text {...theme.paint("muted")}>{row.expanded ? "▼ " : "▶ "}</Text>
            <Text {...theme.paint("strong")} bold {...textHighlight(theme.selection, selected)}>「{row.share.title ?? row.share.id}」</Text>
            <CountsText counts={row.counts} theme={theme} scanning={row.share.scanStatus !== "complete"} cancelled={row.share.cancelled} />
          </Text>
        </Box>
        <Box flexGrow={1} justifyContent="flex-end" flexShrink={0} marginLeft={2}><Text {...theme.paint("muted")}>{path}</Text></Box>
      </Box>
    );
  }
  const nameWidth = nameWidthFor(columns);
  return (
    <Box {...boxHighlight(theme.selection, selected)}>
      <Text {...theme.paint("strong")}>{selected ? "  > " : "    "}</Text>
      <Box width={3}><Text {...theme.paint(row.look.tone)}>{row.look.icon}</Text></Box>
      <Box width={nameWidth} marginRight={1}><Text {...theme.paint(selected ? "strong" : "text")} {...textHighlight(theme.selection, selected)}>{truncateMiddle(row.name, nameWidth)}</Text></Box>
      <Box width={8} marginRight={1}><Text {...theme.paint("muted")}>{formatBytes(row.file.size)}</Text></Box>
      <Box flexShrink={1}><FileStatus row={row} snapshot={snapshot} theme={theme} /></Box>
    </Box>
  );
}

const clock = (at: number) => new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
export function MainPanel({ snapshot, rows, selected, offset, size, theme, overlay, overlayLines = 0, keys }: {
  snapshot: TuiSnapshot; rows: Row[]; selected: number; offset: number; size: Size; theme: Theme;
  overlay?: ReactNode; overlayLines?: number; keys: Array<[string, string]>;
}) {
  const { listHeight, eventLines } = panelLayout(size, snapshot, overlayLines);
  const width = size.columns - 2;
  const events = snapshot.events.slice(-eventLines);
  return (
    <Box flexDirection="column" height={size.rows} paddingX={1}>
      <Header snapshot={snapshot} theme={theme} />
      <Banners snapshot={snapshot} theme={theme} />
      <Rule width={width} theme={theme} />
      <Box flexDirection="column" height={listHeight}>
        {rows.length === 0
          ? <Text {...theme.paint("muted")}>还没有任务。复制包含链接和提取码的分享文本，或按 a 粘贴。</Text>
          : rows.slice(offset, offset + listHeight).map((row, index) =>
            <RowLine key={row.key} row={row} selected={offset + index === selected} snapshot={snapshot} theme={theme} columns={size.columns} />)}
      </Box>
      {overlay}
      <Rule width={width} theme={theme} />
      <Box flexDirection="column" height={eventLines}>
        {events.length === 0 ? <Text {...theme.paint("muted")}>暂无事件</Text> : events.map((event, index) => (
          <Text key={`${event.at}-${index}`} wrap="truncate-end">
            <Text {...theme.paint("muted")}>{clock(event.at)}  </Text><Text {...theme.paint(event.tone)}>{event.icon} </Text><Text {...theme.paint("text")}>{event.text}</Text>
          </Text>
        ))}
      </Box>
      <Rule width={width} theme={theme} />
      {snapshot.stopping
        ? <Text {...theme.paint("warning")}>正在停止并保存进度…（再按 Ctrl+C 立即退出）</Text>
        : <Keys items={keys} theme={theme} />}
    </Box>
  );
}
