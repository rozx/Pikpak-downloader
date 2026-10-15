import type { FileState } from "../../src/state/model";
import type { FileView, ShareView } from "../../src/state/store";
import type { CommandResult, SessionCommand } from "../../src/runtime/session";
import type { ReleasePreview } from "../../src/runtime/engine";
import { pastePreview, type OpenResult, type TuiController, type TuiSnapshot } from "../../src/tui/controller";
import type { LogLine } from "../../src/tui/view-model";

export const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
export const keys = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", escape: "\x1b", backspace: "\x7f", ctrlC: "\x03" };
export const settle = () => Bun.sleep(40);
// 负载较高时异步状态更新可能晚于固定等待：重试断言直到通过或超时。
export async function eventually(assertion: () => void | Promise<void>, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (true) {
    try { await assertion(); return; } catch (error) { if (Date.now() > deadline) throw error; await Bun.sleep(20); }
  }
}

export const share = (id: string, title: string, status = "partial", extra: Partial<ShareView> = {}): ShareView => ({ id, title, outputRoot: "C:\\Users\\demo\\Downloads\\PikPak-Test",
  scanStatus: "complete", cancelled: false, lastError: null, summary: { status, total: 0, completed: 0, cancelled: 0, failed: 0, waiting: 0, active: 0, reason: null }, paused: false, ...extra });
export const file = (id: string, shareId: string, name: string, state: FileState, size: bigint, extra: Partial<FileView> = {}): FileView => ({ id, shareId,
  relativePath: JSON.stringify([{ id, name }]), size, state, retries: 0n, cancelled: false, lastError: null, checkpoint: 0n, copyState: null, paused: false, ...extra });

// 效果图中的主面板数据：一个下载中、一个失败与等待、一个已完成。
export function mockSnapshot(): TuiSnapshot {
  const mb = 1048576n;
  return {
    shares: [share("s_1", "某某合集"), share("s_2", "纪录片合集"), share("s_3", "另一个分享", "completed")],
    files: {
      s_1: [file("f_1", "s_1", "episode01.mkv", "completed", 412n * mb), file("f_2", "s_1", "episode02.mkv", "downloading", 412n * mb, { checkpoint: 198n * mb, copyState: "retained" }),
        file("f_3", "s_1", "episode03.mkv", "ready", 380n * mb)],
      s_2: [file("f_4", "s_2", "第一季 part1 超长的中文文件名用于测试中间省略.mp4", "failed", 2254857830n, { lastError: "url_refresh_exhausted", retries: 3n, checkpoint: 812n * mb, copyState: "retained" }),
        file("f_5", "s_2", "part2.mp4", "waiting_space", 1932735283n)],
      s_3: [file("f_6", "s_3", "readme.txt", "completed", 4096n), file("f_7", "s_3", "资料包.zip", "completed", 96n * mb)],
    },
    quota: { usage: 21n * 1024n * mb, limit: 10n * 1024n * 1024n * mb }, localFree: 412n * 1024n * mb, clipboard: "on", userPaused: false, systemPause: null,
    progress: { f_2: { bytes: 198n * mb, size: 412n * mb, rate: 2.7 * 1048576, eta: 79 } },
    events: [{ at: Date.parse("2026-10-14T22:31:07"), icon: "⟳", tone: "scan", text: "「某某合集」扫描完成：3 个文件" },
      { at: Date.parse("2026-10-14T22:32:12"), icon: "✗", tone: "error", text: "part1.mp4 下载失败" },
      { at: Date.parse("2026-10-14T22:33:40"), icon: "✓", tone: "done", text: "episode01.mkv 校验通过，已完成" }],
    outputRoot: "C:\\Users\\demo\\Downloads\\PikPak-Test", stopping: false, connections: 4, activeFiles: { configured: 1, effective: 1, tier: "paid" }, localMissing: new Set<string>(), releasing: new Set<string>(),
  };
}

export class FakeController implements TuiController {
  private current: TuiSnapshot;
  private readonly listeners = new Set<() => void>();
  readonly commands: SessionCommand[] = [];
  readonly notes: LogLine[] = [];
  readonly opened: Array<{ shareId: string; fileId?: string }> = [];
  stops = 0; forced = 0;
  result: CommandResult = { ok: true, ids: [], issues: [] };
  openResult: OpenResult = { ok: true };
  release: ReleasePreview = { ok: true, copies: 1, bytes: 412n * 1048576n, unfinished: 0, removed: 1 };
  readonly previews: string[] = [];
  constructor(snapshot: TuiSnapshot = mockSnapshot()) { this.current = snapshot; }
  snapshot = () => this.current;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  update(patch: Partial<TuiSnapshot>): void { this.current = { ...this.current, ...patch }; for (const listener of this.listeners) listener(); }
  command = async (command: SessionCommand) => { this.commands.push(command); return this.result; };
  note = (line: LogLine) => { this.notes.push(line); };
  preview = (text: string) => pastePreview(text);
  targetPath = (fileId: string) => fileId === "f_4" ? "C:\\Users\\demo\\Downloads\\PikPak-Test\\纪录片合集\\part1.mp4" : null;
  openDirectory = async (target: { shareId: string; fileId?: string }) => { this.opened.push(target); return this.openResult; };
  releasePreview = (id: string | null) => { this.previews.push(id ?? "*"); return this.release; };
  stop = () => { this.stops++; };
  forceExit = () => { this.forced++; };
}
