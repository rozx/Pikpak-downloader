import type { Pause } from "../state/model";
import type { FileView, ShareView } from "../state/store";
import type { CommandResult, SessionCommand } from "../runtime/session";
import type { ReleasePreview } from "../runtime/engine";
import { parseShares } from "../intake/parse";
import type { LogLine } from "./view-model";
import type { Tier } from "../pikpak/tier";

export type Progress = { bytes: bigint; size: bigint; rate: number | null; eta: number | null };
export type LogEntry = LogLine & { at: number };
export type TuiSnapshot = {
  shares: ShareView[]; files: Record<string, FileView[]>;
  quota: { usage: bigint; limit: bigint } | null; localFree: bigint | null;
  clipboard: "on" | "off" | "unavailable"; userPaused: boolean; systemPause: Pause | null;
  progress: Record<string, Progress>; events: LogEntry[]; outputRoot: string | null; stopping: boolean; connections: number;
  // 同时下载的文件数：配置值、账号等级与实际生效值（add-concurrent-file-downloads）。
  activeFiles: { configured: number; effective: number; tier: Tier };
};
export type PastePreview = { shares: number; paired: number; issues: string[] };
export type OpenResult = { ok: true } | { ok: false; reason: string };

// 界面只通过控制器读取快照与下发命令；快照对象在内容变化前保持同一引用。
export interface TuiController {
  snapshot(): TuiSnapshot;
  subscribe(listener: () => void): () => void;
  command(command: SessionCommand): Promise<CommandResult>;
  note(line: LogLine): void;
  preview(text: string): PastePreview;
  targetPath(fileId: string): string | null;
  // 手动释放云端副本的预览（文件或分享）。
  releasePreview(id: string): ReleasePreview;
  openDirectory(target: { shareId: string; fileId?: string }): Promise<OpenResult>;
  stop(): void;
  forceExit(): void;
}

// 粘贴框的实时解析结果与剪贴板使用同一解析器。
export function pastePreview(text: string): PastePreview {
  const parsed = parseShares(text);
  return { shares: parsed.shares.length, paired: parsed.shares.filter(share => share.passCode).length, issues: parsed.issues };
}
