import { dirname } from "node:path";
import type { Store } from "../state/store";
import type { RuntimeEvent } from "../runtime/engine";
import type { CommandResult, RuntimeSession, SessionCommand } from "../runtime/session";
import { pastePreview, type LogEntry, type OpenResult, type Progress, type TuiController, type TuiSnapshot } from "./controller";
import { describeEvent, type LogLine } from "./view-model";
import { fileName } from "./format";
import { SpeedMeter } from "./speed";
import { openDirectory } from "./open-directory";
import { configuredConnections } from "../download/connections";

export type LiveOptions = {
  store: Store; accountId: string; session: Pick<RuntimeSession, "subscribe" | "command">;
  quota: () => Promise<{ usage: bigint; limit: bigint }>; localFree: () => Promise<bigint>;
  stop: () => void; forceExit: () => void; open?: (path: string) => Promise<OpenResult>;
  now?: () => number; snapshotMs?: number; flushMs?: number; quotaMs?: number; localMs?: number; maxEvents?: number;
};
// 这些事件前后会发生转存、回收或交付，云盘容量随之变化。
const quotaEvents = new Set(["downloading", "completed", "waiting_space"]);

// 真实控制器：快照每 500 ms 或收到事件时重建，但通知界面最多每 flushMs 一次；云盘容量与本地空间按各自周期刷新。
export class LiveController implements TuiController {
  private current: TuiSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly events: LogEntry[] = [];
  private readonly progress = new Map<string, { bytes: bigint; size: bigint }>();
  private readonly meter: SpeedMeter;
  private readonly timers: Array<ReturnType<typeof setInterval>> = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlush = 0;
  private quota: TuiSnapshot["quota"] = null;
  private localFree: bigint | null = null;
  private clipboard: TuiSnapshot["clipboard"];
  private stopping = false;
  private completed = 0;
  private unsubscribe: (() => void) | null = null;
  private readonly now: () => number;
  constructor(private readonly options: LiveOptions) {
    this.now = options.now ?? Date.now;
    this.meter = new SpeedMeter(5000, this.now);
    this.clipboard = options.store.config("clipboard_watch") === "0" ? "off" : "on";
    this.current = this.build();
  }
  start(): void {
    this.unsubscribe = this.options.session.subscribe(event => this.handle(event));
    this.timers.push(setInterval(() => this.refresh(), this.options.snapshotMs ?? 500));
    this.timers.push(setInterval(() => void this.refreshQuota(), this.options.quotaMs ?? 60_000));
    this.timers.push(setInterval(() => void this.refreshLocal(), this.options.localMs ?? 30_000));
    void this.refreshQuota(); void this.refreshLocal();
  }
  dispose(): void {
    this.unsubscribe?.(); this.unsubscribe = null;
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    if (this.flushTimer) clearTimeout(this.flushTimer); this.flushTimer = null;
  }

  snapshot = (): TuiSnapshot => this.current;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  command = async (command: SessionCommand): Promise<CommandResult> => {
    const result = await this.options.session.command(command);
    if (command.kind === "setClipboardWatch" && result.ok) this.clipboard = command.enabled ? "on" : "off";
    this.refresh(); return result;
  };
  note = (line: LogLine): void => { this.log(line); this.refresh(); };
  preview = (text: string) => pastePreview(text);
  targetPath = (fileId: string): string | null => {
    try { return this.options.store.delivery(this.options.accountId, fileId)?.targetPath ?? null; } catch { return null; }
  };
  openDirectory = async (target: { shareId: string; fileId?: string }): Promise<OpenResult> => {
    const path = target.fileId ? this.targetPath(target.fileId) : null;
    let root: string;
    try { root = this.options.store.share(this.options.accountId, target.shareId).outputRoot; } catch { return { ok: false, reason: "account_mismatch" }; }
    return (this.options.open ?? openDirectory)(path ? dirname(path) : root);
  };
  stop = (): void => { if (this.stopping) return; this.stopping = true; this.refresh(); this.options.stop(); };
  forceExit = (): void => this.options.forceExit();
  // 退出后打印在主屏幕上的会话摘要。
  summary(): string {
    let unfinished = 0;
    try { for (const files of Object.values(this.build().files)) unfinished += files.filter(file => file.state !== "completed" && !file.cancelled).length; } catch { /* 任务库已关闭时只报告完成数。 */ }
    return `本次完成 ${this.completed} 个文件${unfinished ? `；还有 ${unfinished} 个未完成，下次启动会继续` : ""}。`;
  }

  private handle(event: RuntimeEvent): void {
    if (event.type === "progress" && event.id && event.bytes !== undefined && event.size !== undefined) {
      this.progress.set(event.id, { bytes: event.bytes, size: event.size }); this.meter.sample(event.id, event.bytes);
    } else {
      if (event.type === "completed" && event.id) { this.completed++; this.progress.delete(event.id); this.meter.forget(event.id); }
      if (event.type === "clipboard_unavailable") this.clipboard = "unavailable";
      if (event.type === "clipboard_recovered" || (event.type === "started" && event.reason !== "clipboard_off")) this.clipboard = this.options.store.config("clipboard_watch") === "0" ? "off" : "on";
      if (event.type === "started" && event.reason === "clipboard_off") this.clipboard = "off";
      if (quotaEvents.has(event.type)) void this.refreshQuota();
      const line = describeEvent(event, { share: id => this.shareTitle(id), file: id => this.fileTitle(id) });
      if (line) this.log(line);
    }
    this.refresh();
  }
  private log(line: LogLine): void {
    this.events.push({ ...line, at: this.now() });
    const max = this.options.maxEvents ?? 50; if (this.events.length > max) this.events.splice(0, this.events.length - max);
  }
  private shareTitle(id: string): string | null {
    try { return this.options.store.shareTitle(this.options.accountId, id); } catch { return null; }
  }
  private fileTitle(id: string): string | null {
    try { return fileName(this.options.store.file(this.options.accountId, id).relativePath); } catch { return null; }
  }
  private async refreshQuota(): Promise<void> {
    try { const quota = await this.options.quota(); this.quota = { usage: quota.usage, limit: quota.limit }; this.refresh(); } catch { /* 读不到容量时保留上次结果。 */ }
  }
  private async refreshLocal(): Promise<void> {
    try { this.localFree = await this.options.localFree(); this.refresh(); } catch { /* 读不到本地空间时保留上次结果。 */ }
  }

  private build(): TuiSnapshot {
    const { store, accountId } = this.options;
    const shares = store.shareViews(accountId);
    const files = Object.fromEntries(shares.map(share => [share.id, store.fileViews(accountId, share.id)]));
    const progress: Record<string, Progress> = {};
    for (const [id, value] of this.progress) progress[id] = { ...value, rate: this.meter.rate(id), eta: this.meter.eta(id, value.size) };
    return { shares, files, quota: this.quota, localFree: this.localFree, clipboard: this.clipboard,
      userPaused: store.config("queue_paused") === "1", systemPause: store.paused(accountId), progress, events: [...this.events],
      outputRoot: store.config("output_root"), stopping: this.stopping, connections: configuredConnections(store) };
  }
  // 重建快照后合并通知，界面重绘频率不超过每 flushMs 一次。
  private refresh(): void {
    try { this.current = this.build(); } catch { return; }
    // 已有待发通知时只更新快照，由该通知带上最新内容，避免与立即通知背靠背重绘。
    if (this.flushTimer) return;
    const wait = (this.options.flushMs ?? 100) - (this.now() - this.lastFlush);
    if (wait <= 0) { this.flush(); return; }
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, wait);
  }
  private flush(): void { this.lastFlush = this.now(); for (const listener of this.listeners) listener(); }
}
