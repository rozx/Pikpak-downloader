import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { Theme, Tone } from "./theme";
import type { TuiSnapshot } from "./controller";
import { formatBytes, formatDuration, formatSpeed, truncateMiddle } from "./format";
import type { Location, Row, ShareCounts } from "./view-model";
import { Banners, Bar, Header, Keys, Rule, SPINNER, bannerLines, boxHighlight, creditLabel, textHighlight, useSpinner } from "./parts";

export type Size = { columns: number; rows: number };
export const MIN_COLUMNS = 60, MIN_ROWS = 15;
const EVENT_LINES = 3;
// 标题、横幅、三条分隔线、事件区与按键提示之外的高度留给列表；覆盖层（确认框、粘贴框）占用列表底部。
export function panelLayout(size: Size, snapshot: TuiSnapshot, overlayLines = 0): { listHeight: number; eventLines: number } {
  const eventLines = Math.min(EVENT_LINES, snapshot.events.length || 1);
  return { listHeight: Math.max(1, size.rows - 1 - bannerLines(snapshot) - 3 - eventLines - 1 - overlayLines), eventLines };
}
// 名称之外：选中标记、图标、大小与位置列合计约 82 列。
const nameWidthFor = (columns: number) => Math.max(18, Math.min(48, columns - 82));
const LOCATION_WIDTH = 9;

// 选中行的全部文字都改用选中调色板，保证在选中背景上可读。
function CountsText({ counts, theme, scanning, cancelled, paused, selected, frame }: { counts: ShareCounts; theme: Theme; scanning: boolean; cancelled: boolean; paused: boolean; selected: boolean; frame: number | null }) {
  const paint = (tone: Tone) => theme.paint(tone, selected);
  const part = (value: number, text: string, tone: Tone) => value > 0 ? <Text {...paint(tone)}> · {value} {text}</Text> : null;
  if (scanning && counts.total === 0) return <Text {...paint("scan")}>  {frame === null ? "" : `${SPINNER[frame]} `}扫描中…</Text>;
  return (
    <Text>
      <Text {...paint(counts.completed === counts.total && counts.total > 0 ? "done" : "text")}>  {counts.completed}/{counts.total} 完成</Text>
      {part(counts.downloading, "下载中", "active")}{part(counts.transferring, "转存中", "transfer")}{part(counts.paused, "暂停", "warning")}
      {part(counts.queued, "排队", "muted")}{part(counts.failed, "失败", "error")}{part(counts.waiting, "等待", "warning")}{part(counts.cancelled, "已取消", "muted")}
      {part(counts.cloud, "在云端", "transfer")}{part(counts.missing, "本地缺失", "warning")}
      {cancelled && <Text {...paint("muted")}> · 分享已取消</Text>}
      {paused && !cancelled && <Text {...paint("warning")}> · 已暂停</Text>}
    </Text>
  );
}

// 位置列两格：本地格与云端格；空格位置不打字符，NO_COLOR 下也能分辨。
const localCells = { full: ["本地", "done"], missing: ["缺失", "warning"], partial: ["部分", "muted"] } as const;
function LocationText({ location, theme, selected }: { location: Location; theme: Theme; selected: boolean }) {
  const paint = (tone: Tone) => theme.paint(tone, selected);
  const [local, tone] = location.local ? localCells[location.local] : ["    ", "muted"] as const;
  return <Text><Text {...paint(tone)}>{local}</Text><Text {...paint("text")}> </Text><Text {...paint("transfer")}>{location.cloud ? "云端" : "    "}</Text></Text>;
}

function FileStatus({ row, snapshot, theme, selected }: { row: Extract<Row, { kind: "file" }>; snapshot: TuiSnapshot; theme: Theme; selected: boolean }) {
  const paint = (tone: Tone) => theme.paint(tone, selected);
  const progress = snapshot.progress[row.file.id];
  const bytes = progress?.bytes ?? row.file.checkpoint, size = row.file.size;
  const percent = size > 0n ? Number(bytes * 100n / size) : 100;
  if (row.look.label === "已暂停") {
    return <Text><Bar percent={percent} theme={theme} tone="warning" selected={selected} /><Text {...paint("text")}>  {percent}%</Text><Text {...paint("warning")}>  已暂停</Text></Text>;
  }
  if (row.file.state === "downloading" && !row.file.cancelled) {
    return (
      <Text>
        <Bar percent={percent} theme={theme} selected={selected} /><Text {...paint("strong")}>  {percent}%</Text>
        <Text {...paint("text")}>  {formatBytes(bytes)}/{formatBytes(size)}</Text>
        {progress?.rate != null && <Text {...paint("active")}>  {formatSpeed(progress.rate)}</Text>}
        {progress?.eta != null && <Text {...paint("muted")}>  {formatDuration(progress.eta)}</Text>}
      </Text>
    );
  }
  return <Text {...paint(row.look.tone)} wrap="truncate-end">{row.look.label}</Text>;
}

// frame 不为 null 时，正在执行的文件与扫描中的分享显示动态图标。
export function RowLine({ row, selected, snapshot, theme, columns, frame = null }: { row: Row; selected: boolean; snapshot: TuiSnapshot; theme: Theme; columns: number; frame?: number | null }) {
  if (row.kind === "share") {
    // 目录列让位给计数（含“在云端”“本地缺失”），最多占四分之一宽度。
    const path = truncateMiddle(row.share.outputRoot, Math.max(10, Math.floor(columns / 4)));
    return (
      <Box {...boxHighlight(theme.selection, selected)}>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            <Text {...theme.paint("muted", selected)}>{row.expanded ? "▼ " : "▶ "}</Text>
            <Text {...theme.paint("strong", selected)} bold {...textHighlight(theme.selection, selected)}>「{row.share.title ?? row.share.id}」</Text>
            <CountsText counts={row.counts} theme={theme} scanning={row.share.scanStatus !== "complete"} cancelled={row.share.cancelled} paused={row.share.paused} selected={selected} frame={frame} />
          </Text>
        </Box>
        <Box flexGrow={1} justifyContent="flex-end" flexShrink={0} marginLeft={2}><Text {...theme.paint("muted", selected)}>{path}</Text></Box>
      </Box>
    );
  }
  const nameWidth = nameWidthFor(columns);
  return (
    <Box {...boxHighlight(theme.selection, selected)}>
      <Text {...theme.paint("key", selected)} bold>{selected ? "  > " : "    "}</Text>
      <Box width={3}><Text {...theme.paint(row.look.tone, selected)}>{row.look.active && frame !== null ? SPINNER[frame] : row.look.icon}</Text></Box>
      <Box width={nameWidth} marginRight={1}><Text {...theme.paint("text", selected)} bold={selected} {...textHighlight(theme.selection, selected)}>{truncateMiddle(row.name, nameWidth)}</Text></Box>
      <Box width={8} marginRight={1}><Text {...theme.paint("muted", selected)}>{formatBytes(row.file.size)}</Text></Box>
      <Box width={LOCATION_WIDTH} marginRight={1} flexShrink={0}><LocationText location={row.location} theme={theme} selected={selected} /></Box>
      <Box flexShrink={1}><FileStatus row={row} snapshot={snapshot} theme={theme} selected={selected} /></Box>
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
  // 暂停、停止中或系统暂停时执行器不在工作，图标保持静止。
  const frame = useSpinner(!snapshot.stopping && !snapshot.userPaused && !snapshot.systemPause
    && rows.some(row => row.kind === "file" ? !!row.look.active : row.share.scanStatus !== "complete" && row.counts.total === 0));
  return (
    <Box flexDirection="column" height={size.rows} paddingX={1}>
      <Header snapshot={snapshot} theme={theme} width={width} />
      <Banners snapshot={snapshot} theme={theme} />
      <Rule width={width} theme={theme} />
      <Box flexDirection="column" height={listHeight}>
        {rows.length === 0
          ? <Text {...theme.paint("muted")}>还没有任务。复制包含链接和提取码的分享文本，或按 a 粘贴。</Text>
          : rows.slice(offset, offset + listHeight).map((row, index) =>
            <RowLine key={row.key} row={row} selected={offset + index === selected} snapshot={snapshot} theme={theme} columns={size.columns} frame={frame} />)}
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
      <Rule width={width} theme={theme} label={creditLabel} />
      {snapshot.stopping
        ? <Text {...theme.paint("warning")}>正在停止并保存进度…（再按 Ctrl+C 立即退出）</Text>
        : <Keys items={keys} theme={theme} />}
    </Box>
  );
}
