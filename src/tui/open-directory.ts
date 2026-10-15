import { stat } from "node:fs/promises";
import { AppError } from "../errors";
import type { OpenResult } from "./controller";

export type Launch = (command: string[]) => void;
// 路径作为独立参数传给文件管理器，不经过 shell。
export function directoryCommand(platform: NodeJS.Platform, path: string): string[] {
  if (platform === "win32") return ["explorer.exe", path];
  if (platform === "darwin") return ["/usr/bin/open", path];
  throw new AppError("unsupported_platform");
}
// explorer.exe 成功打开时也常返回非零退出码，因此只确认目录存在并成功启动进程。
const launch: Launch = command => { Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref(); };
export async function openDirectory(path: string, start: Launch = launch, platform: NodeJS.Platform = process.platform): Promise<OpenResult> {
  try { if (!(await stat(path)).isDirectory()) return { ok: false, reason: "output_unavailable" }; }
  catch { return { ok: false, reason: "output_unavailable" }; }
  try { start(directoryCommand(platform, path)); return { ok: true }; }
  catch (error) { return { ok: false, reason: error instanceof AppError ? error.code : "operation_failed" }; }
}
