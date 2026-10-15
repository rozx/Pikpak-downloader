import { Box, Text } from "ink";
import type { FileView } from "../state/store";
import type { Theme, Tone } from "./theme";
import type { PastePreview } from "./controller";
import { displayPath, fileName, formatBytes, truncateMiddle } from "./format";
import { explain, fileLook } from "./view-model";
import { Keys, Rule, Title, boxHighlight, textHighlight } from "./parts";
import type { Size } from "./main-panel";
import { about } from "../about";

const copyStates: Record<string, string> = { retained: "保留中 · 交付完成后才可能被回收", deleting: "回收中", deleted: "已回收", protected: "受保护 · 不会自动回收" };
export function DetailPage({ file, shareTitle, targetPath, userPaused, size, theme }: {
  file: FileView; shareTitle: string; targetPath: string | null; userPaused: boolean; size: Size; theme: Theme;
}) {
  const look = fileLook(file, { userPaused }), reason = explain(file.lastError);
  const fields: Array<[string, string, Tone]> = [
    ["文件", fileName(file.relativePath), "strong"], ["相对路径", displayPath(file.relativePath), "text"],
    ["大小", `${formatBytes(file.size)}（${file.size.toLocaleString("en-US")} 字节）`, "text"], ["状态", `${look.icon} ${look.label}`, look.tone],
    ...(reason.reason ? [["原因", reason.reason, "error"], ["建议", reason.advice, "active"]] as Array<[string, string, Tone]> : []),
    ["已重试", `${file.retries} 次`, "text"],
    ...(file.checkpoint > 0n && file.state !== "completed" ? [["断点", `${formatBytes(file.checkpoint)} / ${formatBytes(file.size)}`, "text"]] as Array<[string, string, Tone]> : []),
    ["云端副本", file.copyState ? copyStates[file.copyState] ?? file.copyState : "尚未转存", "text"],
    ["本地目标", targetPath ?? "尚未分配", "muted"],
  ];
  return (
    <Box flexDirection="column" height={size.rows} paddingX={1}>
      <Title text="文件详情" theme={theme} extra={<Text {...theme.paint("text")}>  「{shareTitle}」</Text>} />
      <Rule width={size.columns - 2} theme={theme} />
      <Box flexDirection="column" flexGrow={1} paddingTop={1}>
        {fields.map(([label, value, tone]) => (
          <Box key={label}><Box width={12} flexShrink={0}><Text {...theme.paint("muted")}>  {label}</Text></Box><Text {...theme.paint(tone)} wrap="truncate-middle">{value}</Text></Box>
        ))}
      </Box>
      <Rule width={size.columns - 2} theme={theme} />
      <Keys items={[["r", "重试"], ["c", "取消"], ["o", "打开目录"], ["Esc", "返回"]]} theme={theme} />
    </Box>
  );
}

export function SettingsPage({ outputRoot, clipboardOn, selected, editing, draft, error, size, theme }: {
  outputRoot: string | null; clipboardOn: boolean; selected: number; editing: boolean; draft: string; error: string | null; size: Size; theme: Theme;
}) {
  const item = (index: number, label: string, value: (on: boolean) => React.ReactNode, note: string) => {
    const on = selected === index;
    return (
      <Box key={label} flexDirection="column">
        <Box {...boxHighlight(theme.selection, on)}>
          <Text {...theme.paint("key", on)} bold>{on ? "> " : "  "}</Text>
          <Box width={14} flexShrink={0}><Text {...theme.paint("text", on)} bold={on} {...textHighlight(theme.selection, on)}>{label}</Text></Box>
          {value(on)}
        </Box>
        <Box marginLeft={16}><Text {...theme.paint("muted")}>{note}</Text></Box>
      </Box>
    );
  };
  return (
    <Box flexDirection="column" height={size.rows} paddingX={1}>
      <Title text="设置" theme={theme} />
      <Rule width={size.columns - 2} theme={theme} />
      <Box flexDirection="column" flexGrow={1} paddingTop={1} gap={1}>
        {item(0, "下载目录", on => editing
          ? <Text {...theme.paint("strong", on)}>{draft}<Text {...theme.paint("key", on)}>▌</Text></Text>
          : <Text {...theme.paint("strong", on)}>{truncateMiddle(outputRoot ?? "未设置", size.columns - 22)}</Text>,
          editing ? "输入或粘贴目录后按 Enter 保存，Esc 放弃" : "仅对新接收的分享生效，已有分享沿用原目录")}
        {item(1, "剪贴板监听", on => <Text {...theme.paint(clipboardOn ? "done" : "muted", on)}>{clipboardOn ? "● 开" : "○ 关"}</Text>, "关闭后只能用 a 粘贴分享文本")}
        {error && <Text {...theme.paint("error")}>✗ {error}</Text>}
        <Box flexGrow={1} />
        <Box>
          <Box width={16} flexShrink={0}><Text {...theme.paint("muted")}>  关于</Text></Box>
          <Box flexDirection="column">
            <Text><Text {...theme.paint("strong")}>{about.name}</Text><Text {...theme.paint("muted")}>  v{about.version}  ·  作者 </Text><Text {...theme.paint("text")}>{about.author}</Text></Text>
            <Text {...theme.paint("active")}>{about.homepage}</Text>
          </Box>
        </Box>
      </Box>
      <Rule width={size.columns - 2} theme={theme} />
      <Keys items={editing ? [["Enter", "保存"], ["Esc", "放弃"]] : [["↑↓", "选择"], ["Enter", "修改"], ["Space", "切换"], ["Esc", "返回"]]} theme={theme} />
    </Box>
  );
}

export const PASTE_BOX_LINES = 10;
// 多行粘贴只追加到输入框，按 Enter 才提交；预览与剪贴板使用同一解析规则。
export function PasteBox({ draft, preview, outputRoot, message, theme, width }: {
  draft: string; preview: PastePreview; outputRoot: string | null; message: string | null; theme: Theme; width: number;
}) {
  const lines = draft ? draft.split("\n").slice(-4) : [""];
  const status = preview.shares === 0
    ? { tone: draft.trim() ? "warning" as const : "muted" as const, text: draft.trim() ? "未识别到分享链接（单独的提取码不会与之前的内容拼接）" : "粘贴包含链接和提取码的分享文本" }
    : preview.issues.length ? { tone: "warning" as const, text: "配对不明确，请分别粘贴完整文本" }
    : { tone: "done" as const, text: `✓ 识别到 ${preview.shares} 个分享 · ${preview.paired === preview.shares ? "提取码 ✓" : "无提取码"} · 下载到 ${truncateMiddle(outputRoot ?? "未设置", 30)}` };
  return (
    <Box marginLeft={2} borderStyle="round" {...theme.enabled ? { borderColor: "cyan" } : {}} flexDirection="column" paddingX={2} width={Math.min(width, 76)} height={PASTE_BOX_LINES}>
      <Text {...theme.paint("active")} bold>粘贴分享文本</Text>
      {lines.map((line, index) => <Text key={index} {...theme.paint("text")} wrap="truncate-end">{line || " "}</Text>)}
      <Text {...theme.paint("muted")}>{"─".repeat(Math.max(0, Math.min(width, 76) - 6))}</Text>
      <Text {...theme.paint(status.tone)} wrap="truncate-end">{status.text}</Text>
      {message && <Text {...theme.paint("warning")} wrap="truncate-end">{message}</Text>}
    </Box>
  );
}

export const CONFIRM_LINES = 7;
export function ConfirmDialog({ heading, title, detail, confirm, theme }: { heading: string; title: string; detail: string; confirm: string; theme: Theme }) {
  return (
    <Box marginLeft={10} borderStyle="round" {...theme.enabled ? { borderColor: "yellow" } : {}} flexDirection="column" paddingX={2} width={64} height={CONFIRM_LINES}>
      <Text {...theme.paint("key")} bold>{heading}</Text>
      <Text {...theme.paint("text")} wrap="truncate-end">{title}</Text>
      <Text {...theme.paint("muted")}>{detail}</Text>
      <Text><Text {...theme.paint("key")} bold>y</Text><Text {...theme.paint("text")}> {confirm}    </Text><Text {...theme.paint("key")} bold>n</Text><Text {...theme.paint("text")}> 返回</Text></Text>
    </Box>
  );
}
