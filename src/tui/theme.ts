export type Tone = "done" | "active" | "transfer" | "scan" | "warning" | "error" | "muted" | "text" | "strong" | "key";
// 只用标准 16 色，Windows Terminal、传统控制台与 macOS 终端都按各自主题显示。
const palette: Record<Tone, string> = {
  done: "green", active: "cyan", transfer: "blue", scan: "magenta", warning: "yellow", error: "red",
  muted: "gray", text: "white", strong: "whiteBright", key: "yellowBright",
};
export type Highlight = { backgroundColor: string; color?: string } | { inverse: true };
export type Theme = { enabled: boolean; tone(tone: Tone): string | undefined; selection: Highlight; title: Highlight; banner: Highlight };

// NO_COLOR 存在且非空时不输出颜色；选中行与标题改用反色，状态仍由图标与文字区分。
export function createTheme(env: Record<string, string | undefined> = process.env): Theme {
  const enabled = !env.NO_COLOR;
  return {
    enabled, tone: tone => enabled ? palette[tone] : undefined,
    selection: enabled ? { backgroundColor: "blue" } : { inverse: true },
    title: enabled ? { backgroundColor: "blue", color: "whiteBright" } : { inverse: true },
    banner: enabled ? { backgroundColor: "yellow", color: "black" } : { inverse: true },
  };
}
