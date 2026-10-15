export type Tone = "done" | "active" | "transfer" | "scan" | "warning" | "error" | "muted" | "text" | "strong" | "key" | "cloud" | "group";
// 只用标准 16 色，Windows Terminal、传统控制台与 macOS 终端都按各自主题显示。
const palette: Record<Tone, string> = {
  done: "green", active: "cyan", transfer: "blue", scan: "magenta", warning: "yellow", error: "red",
  muted: "gray", text: "white", strong: "whiteBright", key: "yellowBright", cloud: "blueBright", group: "cyanBright",
};
// 选中行用浅色底、黑色文字：各终端主题的蓝色亮度差异很大，蓝底配亮色文字在部分主题中看不清。
// 浅色底上只有黑色与蓝色在常见主题中都足够清楚；下载与转存的进度条和动态图标保留蓝色。
const onSelection: Record<Tone, string> = {
  done: "black", active: "blue", transfer: "blue", scan: "black", warning: "black", error: "black",
  muted: "black", text: "black", strong: "black", key: "black", cloud: "blue", group: "black",
};
export const SELECTION_BACKGROUND = "white";
export type Highlight = { backgroundColor: string; color?: string } | { inverse: true };
export type Theme = { enabled: boolean; tone(tone: Tone): string | undefined; paint(tone: Tone, selected?: boolean): { color: string } | Record<string, never>;
  selection: Highlight; title: Highlight; banner: Highlight };

// NO_COLOR 存在且非空时不输出颜色；选中行与标题改用反色，状态仍由图标与文字区分。
export function createTheme(env: Record<string, string | undefined> = process.env): Theme {
  const enabled = !env.NO_COLOR;
  return {
    enabled, tone: tone => enabled ? palette[tone] : undefined,
    paint: (tone, selected = false) => enabled ? { color: (selected ? onSelection : palette)[tone] } : {},
    selection: enabled ? { backgroundColor: SELECTION_BACKGROUND } : { inverse: true },
    title: enabled ? { backgroundColor: "blue", color: "whiteBright" } : { inverse: true },
    banner: enabled ? { backgroundColor: "yellow", color: "black" } : { inverse: true },
  };
}
