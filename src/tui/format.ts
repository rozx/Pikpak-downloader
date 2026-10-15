const units = ["B", "KB", "MB", "GB", "TB"] as const;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// 1024 进制；小于 10 保留一位小数，其余取整，最大单位为 TB。precise 时小于 1000 都保留一位小数，
// 用于标题栏的已用与剩余空间：下载几百 MB 时取整的 GB 数看不出变化。
export function formatBytes(bytes: bigint, precise = false): string {
  if (bytes < 1024n) return `${bytes} B`;
  let value = Number(bytes), unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < (precise ? 1000 : 10) ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
export const formatSpeed = (bytesPerSecond: number): string => `${formatBytes(BigInt(Math.max(0, Math.round(bytesPerSecond))))}/s`;
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds)), pad = (value: number) => String(value).padStart(2, "0");
  if (total < 60) return `${total}秒`;
  if (total < 3600) return `${Math.floor(total / 60)}分${pad(total % 60)}秒`;
  return `${Math.floor(total / 3600)}时${pad(Math.floor(total % 3600 / 60))}分`;
}

export const displayWidth = (text: string): number => Bun.stringWidth(text);
// 按终端显示宽度从中间省略；以字素为单位切分，中文、表情和组合字符不会被截成半个。
export function truncateMiddle(text: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  if (width === 1) return "…";
  const graphemes = [...segmenter.segment(text)].map(part => part.segment);
  const budget = width - 1, headBudget = Math.ceil(budget / 2), tailBudget = budget - headBudget;
  let head = "", tail = "", headWidth = 0, tailWidth = 0;
  for (const grapheme of graphemes) {
    const size = displayWidth(grapheme); if (headWidth + size > headBudget) break;
    head += grapheme; headWidth += size;
  }
  for (const grapheme of graphemes.reverse()) {
    const size = displayWidth(grapheme); if (tailWidth + size > tailBudget) break;
    tail = grapheme + tail; tailWidth += size;
  }
  return `${head}…${tail}`;
}

// 任务库保存的是分享内路径组件的 JSON；也接受普通的斜杠路径。
export function displayPath(relativePath: string): string {
  try {
    const parts: unknown = JSON.parse(relativePath);
    if (Array.isArray(parts) && parts.every(part => part && typeof part === "object" && typeof (part as { name?: unknown }).name === "string")) {
      return parts.map(part => (part as { name: string }).name).join("/");
    }
  } catch { /* 不是 JSON，按普通路径处理。 */ }
  return relativePath;
}
export const fileName = (relativePath: string): string => displayPath(relativePath).split("/").at(-1) ?? relativePath;
