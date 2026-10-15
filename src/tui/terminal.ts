import { publicError } from "../errors";

// 关闭括号粘贴、显示光标、退出备用屏幕。
export const RESTORE_SEQUENCE = "\x1b[?2004l\x1b[?25h\x1b[?1049l";

export type TerminalGuardOptions = {
  restore?: () => void;
  summary: () => string | null;
  write?: (text: string) => void;
  exit?: (code: number) => void;
};
export type TerminalGuard = { restore(): void; dispose(): void };

// Ink 只在正常卸载时恢复终端；守护负责异常、信号与进程退出等其他路径，且恢复只执行一次。
export function guardTerminal(options: TerminalGuardOptions): TerminalGuard {
  const write = options.write ?? (text => { process.stdout.write(text); });
  const exit = options.exit ?? (code => process.exit(code));
  let restored = false;
  const restore = () => {
    if (restored) return; restored = true;
    try { options.restore?.(); } catch { /* 卸载失败时仍写入恢复序列。 */ }
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* 输入不是终端时无需恢复。 */ }
    write(RESTORE_SEQUENCE);
  };
  const failed = (error: unknown) => { restore(); write(`${publicError(error)}\n`); exit(1); };
  const signalled = (code: number) => () => { restore(); const summary = options.summary(); if (summary) write(`${summary}\n`); exit(code); };
  const onTerm = signalled(143), onHangup = signalled(129);
  process.on("uncaughtException", failed); process.on("unhandledRejection", failed);
  process.on("SIGTERM", onTerm); process.on("SIGHUP", onHangup); process.on("exit", restore);
  return {
    restore,
    dispose: () => {
      process.off("uncaughtException", failed); process.off("unhandledRejection", failed);
      process.off("SIGTERM", onTerm); process.off("SIGHUP", onHangup); process.off("exit", restore);
    },
  };
}
