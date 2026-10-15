import type { Clipboard } from "../intake/clipboard";
import type { ClipboardSnapshot } from "./types";

// 与 macOS 一致的文本上限。
const LIMIT = 1048576;
export type Output = { code: number; data: Uint8Array | null };
// 执行一次读取命令：命令不存在或超时则抛出；输出超过上限时 data 为 null。
export type Runner = (command: string[], limit: number, timeout: number) => Promise<Output>;

export const commandRunner: Runner = async (command, limit, timeout) => {
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill(), timeout);
  try {
    const reader = child.stdout.getReader(), chunks: Uint8Array[] = [];
    let size = 0, overflow = false;
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      size += chunk.value.byteLength;
      if (size > limit) { overflow = true; child.kill(); await reader.cancel().catch(() => {}); break; }
      chunks.push(chunk.value);
    }
    const code = await child.exited;
    if (child.signalCode && !overflow) throw Error("clipboard-command-timeout");
    return { code, data: overflow ? null : Buffer.concat(chunks) };
  } finally { clearTimeout(timer); }
};

// Wayland 用 wl-paste；X11 依次尝试 xclip 与 xsel。没有图形会话时不读取。
export function clipboardCommands(environment: Record<string, string | undefined>): string[][] {
  if (environment.WAYLAND_DISPLAY) return [["wl-paste", "--no-newline", "--type", "text"]];
  if (environment.DISPLAY) return [["xclip", "-selection", "clipboard", "-out", "-target", "UTF8_STRING"], ["xsel", "--clipboard", "--output"]];
  return [];
}

// Linux 没有系统级剪贴板变更计数，序号在文本与上次不同的时候加一；重复复制同一段文字不算新事件。
export class LinuxClipboard implements Clipboard {
  private sequence = 0;
  private last: string | null | undefined;
  private busy = false;
  private chosen: string[] | undefined;
  constructor(private readonly environment: Record<string, string | undefined> = process.env, private readonly runner: Runner = commandRunner) {}
  private async text(): Promise<string | null> {
    const candidates = this.chosen ? [this.chosen] : clipboardCommands(this.environment);
    for (const command of candidates) {
      let output: Output;
      try { output = await this.runner(command, LIMIT, 5000); } catch { continue; }
      this.chosen = command;
      // 非零退出表示剪贴板为空或没有文本类型；超长或不是有效 UTF-8 时按非文本处理。
      if (output.code !== 0 || !output.data?.byteLength) return null;
      try { return new TextDecoder("utf-8", { fatal: true }).decode(output.data); } catch { return null; }
    }
    this.chosen = undefined;
    throw Error("clipboard-unavailable");
  }
  async read(): Promise<ClipboardSnapshot | null> {
    if (this.busy) throw Error("clipboard-request-already-running");
    this.busy = true;
    try {
      const text = await this.text();
      if (text !== this.last) { this.sequence++; this.last = text; }
      return { sequence: String(this.sequence), text };
    } finally { this.busy = false; }
  }
  async close(): Promise<void> { this.chosen = undefined; }
}
