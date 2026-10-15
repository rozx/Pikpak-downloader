import { AppError } from "../errors";
import type { Clipboard } from "../intake/clipboard";
import { LinuxClipboard } from "./linux-clipboard";
import { ProcessClipboard } from "./windows-clipboard";
import { resolve } from "node:path";

export function macClipboardWorker(board?: string): Clipboard {
  const argumentsList = ["--internal-clipboard", ...(board ? [board] : [])];
  const command = Bun.isStandaloneExecutable ? [process.execPath, ...argumentsList]
    : [process.execPath, resolve(import.meta.dir, "../cli.ts"), ...argumentsList];
  return new ProcessClipboard(() => Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "ignore" }));
}

export function systemClipboard(): Clipboard {
  if (process.platform === "darwin") return macClipboardWorker();
  if (process.platform === "win32") return new ProcessClipboard();
  if (process.platform === "linux") return new LinuxClipboard();
  throw new AppError("unsupported_platform");
}
