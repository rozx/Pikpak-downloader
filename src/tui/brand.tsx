import { Box, Text } from "ink";
import { about } from "../about";
import type { Theme } from "./theme";
import { displayWidth } from "./format";

// ANSI Shadow 字形：实心块与阴影线分别着色，各字母等宽拼接。
const glyphs: Record<string, string[]> = {
  P: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔═══╝ ", "██║     ", "╚═╝     "],
  I: ["██╗", "██║", "██║", "██║", "██║", "╚═╝"],
  K: ["██╗  ██╗", "██║ ██╔╝", "█████╔╝ ", "██╔═██╗ ", "██║  ██╗", "╚═╝  ╚═╝"],
  A: [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
};
export const LOGO = [0, 1, 2, 3, 4, 5].map(row => [..."PIKPAK"].map(letter => glyphs[letter]![row]).join(""));
export const LOGO_WIDTH = Math.max(...LOGO.map(displayWidth));
const SUBTITLE = "D  O  W  N  L  O  A  D  E  R";
// 标志 6 行、副标题、空行、版本信息与说明各 1 行。
export const BRAND_LINES = LOGO.length + 4;

function LogoLine({ line, theme }: { line: string; theme: Theme }) {
  const runs = line.match(/█+|[^█]+/g) ?? [];
  return <Text>{runs.map((run, index) => <Text key={index} {...theme.paint(run.startsWith("█") ? "active" : "transfer")}>{run}</Text>)}</Text>;
}

export function AboutLine({ theme }: { theme: Theme }) {
  return (
    <Text wrap="truncate-end">
      <Text {...theme.paint("strong")}>v{about.version}</Text><Text {...theme.paint("muted")}>  ·  作者 </Text>
      <Text {...theme.paint("text")}>{about.author}</Text><Text {...theme.paint("muted")}>  ·  </Text><Text {...theme.paint("active")}>{about.site}</Text>
    </Text>
  );
}

// 放不下完整标志时只显示单行标题，保证下方的操作提示可见。
export function Brand({ theme, compact }: { theme: Theme; compact: boolean }) {
  if (compact) {
    return (
      <Box flexDirection="column" alignItems="center">
        <Text><Text {...theme.paint("active")} bold>{about.name}</Text></Text>
        <AboutLine theme={theme} />
      </Box>
    );
  }
  return (
    <Box flexDirection="column" alignItems="center">
      {LOGO.map((line, index) => <LogoLine key={index} line={line} theme={theme} />)}
      <Text {...theme.paint("strong")} bold>{SUBTITLE}</Text>
      <Text> </Text>
      <AboutLine theme={theme} />
      <Text {...theme.paint("muted")}>复制分享文本 → 转存到 PikPak 云盘 → 下载到本地</Text>
    </Box>
  );
}
