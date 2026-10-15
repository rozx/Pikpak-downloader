import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { AppError } from "../errors";
import type { Store } from "../state/store";
import type { ClipboardSnapshot } from "../platform/types";
import type { IntakeReceiver, IntakeResult } from "../intake/receiver";
import { pollClipboard, type Clipboard } from "../intake/clipboard";
import type { Engine, RuntimeEvent } from "./engine";
import { saveConnections } from "../download/connections";

export type SessionCommand =
  | { kind: "retry"; id: string } | { kind: "cancel"; id: string }
  | { kind: "pauseQueue" } | { kind: "resumeQueue" }
  | { kind: "submitText"; text: string } | { kind: "setOutputRoot"; path: string }
  | { kind: "setClipboardWatch"; enabled: boolean } | { kind: "setDownloadConnections"; count: number };
export type CommandResult = { ok: true; ids: string[]; issues: string[] } | { ok: false; reason: string };
// stopActive / isPooled 对应下载池（add-concurrent-file-downloads）；只有串行执行器的测试替身可以不提供。
export type SessionEngine = Pick<Engine, "step" | "resumeLocalPause" | "resumeTrafficPause" | "reconcile" | "blockPersistence" | "subscribe">
  & Partial<Pick<Engine, "stopActive" | "isPooled">>;
type Pending = { command: SessionCommand; resolve: (result: CommandResult) => void };

// 与 config --output 相同的目录校验：存在、是目录、可写可进入。
export async function writableDirectory(path: string): Promise<string> {
  try {
    const root = await realpath(resolve(path));
    if (!(await stat(root)).isDirectory()) throw new AppError("output_unavailable");
    await access(root, constants.W_OK | constants.X_OK);
    return root;
  } catch { throw new AppError("output_unavailable"); }
}

// 前台会话：剪贴板接收、执行器循环与界面命令共用一个调度点；命令只在两次步骤之间执行。
export class RuntimeSession {
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly pending: Pending[] = [];
  private active: { shareId?: string; fileId?: string } = {};
  private stepAbort: AbortController | null = null;
  private halt: AbortController | null = null;
  private running: AbortSignal | null = null;
  private intake: { stop: AbortController; done: Promise<void> } | null = null;
  private wake: (() => void) | undefined;
  private stopped = false;
  constructor(private readonly store: Store, private readonly accountId: string, private readonly engine: SessionEngine,
    private readonly receiver: IntakeReceiver, private readonly clipboard: Clipboard) {}

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  private emit(event: RuntimeEvent): void { for (const listener of this.listeners) listener(event); }

  // 暂停和针对当前执行项（或其所属分享）的取消会先中断当前步骤；结果在命令真正写入任务库后返回。
  command(command: SessionCommand): Promise<CommandResult> {
    if (this.stopped) return Promise.resolve({ ok: false, reason: "stopped" });
    return new Promise(resolve => {
      this.pending.push({ command, resolve });
      if (command.kind === "pauseQueue" || (command.kind === "cancel" && (command.id === this.active.fileId || command.id === this.active.shareId))) this.stepAbort?.abort();
      this.wake?.();
    });
  }

  async run(signal: AbortSignal): Promise<void> {
    const halt = new AbortController(); this.halt = halt;
    const combined = AbortSignal.any([signal, halt.signal]); this.running = combined;
    // 下载池空出名额时唤醒空闲等待，下一个文件尽快开始。
    const unsubscribe = this.engine.subscribe(event => { this.track(event); this.emit(event); if (event.type === "released") this.wake?.(); });
    const watching = this.watching();
    if (watching) this.startIntake();
    this.emit({ type: "started", ...(watching ? {} : { reason: "clipboard_off" }) });
    try {
      await this.engine.resumeLocalPause(combined);
      await this.engine.resumeTrafficPause(combined);
      if (!this.store.paused(this.accountId)) await this.engine.reconcile(combined);
      while (!combined.aborted) {
        await this.drain();
        if (combined.aborted) break;
        const step = new AbortController(); this.stepAbort = step; this.active = {};
        let progressed = false;
        try { progressed = await this.engine.step(AbortSignal.any([combined, step.signal])); }
        catch { this.engine.blockPersistence(); }
        finally { this.stepAbort = null; this.active = {}; }
        if (!progressed && !this.pending.length) await this.idle(combined);
      }
    } finally {
      // 中断时下载池中的文件各自在安全点停止并保存检查点。
      halt.abort(); this.wake?.(); await this.engine.stopActive?.().catch(() => {}); await this.stopIntake(); unsubscribe();
      this.stopped = true; this.running = null;
      for (const item of this.pending.splice(0)) item.resolve({ ok: false, reason: "stopped" });
      this.emit({ type: "stopped" });
    }
  }

  private track(event: RuntimeEvent): void {
    // 下载池中文件的事件不代表串行步骤的当前项。
    if (!event.id || this.engine.isPooled?.(event.id)) return;
    if (event.type === "scanning") this.active = { shareId: event.id };
    else if (event.type === "saving" || event.type === "downloading") {
      let shareId: string | undefined;
      try { shareId = this.store.file(this.accountId, event.id).shareId; } catch { /* 只读不到时仍按文件匹配。 */ }
      this.active = { fileId: event.id, ...(shareId ? { shareId } : {}) };
    }
  }
  private idle(signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); this.wake = undefined; resolve(); };
      const timer = setTimeout(done, 500); this.wake = done; signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
  private async drain(): Promise<void> {
    while (this.pending.length) { const item = this.pending.shift()!; item.resolve(await this.apply(item.command)); }
  }
  private async apply(command: SessionCommand): Promise<CommandResult> {
    const account = this.accountId;
    const id = "id" in command ? { id: command.id } : {};
    try {
      let result: CommandResult = { ok: true, ids: [], issues: [] };
      if (command.kind === "retry") this.store.retry(account, command.id);
      else if (command.kind === "cancel") {
        // 只停止目标文件（或该分享的文件），其他在途文件继续。
        await this.engine.stopActive?.(target => target.fileId === command.id || target.shareId === command.id);
        this.store.cancel(account, command.id); this.store.recheckCancelledPause(account);
      } else if (command.kind === "pauseQueue") { await this.engine.stopActive?.(); this.store.setConfig("queue_paused", "1"); }
      else if (command.kind === "resumeQueue") this.store.setConfig("queue_paused", "0");
      else if (command.kind === "setOutputRoot") {
        const root = await writableDirectory(command.path);
        this.store.setConfig("output_root", root); this.receiver.setOutputRoot(root);
      } else if (command.kind === "setDownloadConnections") saveConnections(this.store, command.count);
      else if (command.kind === "setClipboardWatch") {
        this.store.setConfig("clipboard_watch", command.enabled ? "1" : "0");
        if (!command.enabled) await this.stopIntake(); else if (this.running) this.startIntake();
      } else {
        const intake = await this.receiver.receiveText(command.text);
        this.report(intake);
        result = intake.failure ? { ok: false, reason: intake.failure } : { ok: true, ids: intake.ids, issues: intake.issues };
      }
      this.emit({ type: "command", reason: command.kind, ...id });
      return result;
    } catch (error) {
      const reason = error instanceof AppError ? error.code : "operation_failed";
      this.emit({ type: "command_failed", reason, ...id });
      return { ok: false, reason };
    }
  }

  private watching(): boolean { return this.store.config("clipboard_watch") !== "0"; }
  private startIntake(): void {
    if (this.intake || !this.running) return;
    const stop = new AbortController();
    const done = pollClipboard(this.clipboard, AbortSignal.any([this.running, stop.signal]), snapshot => this.receiveClipboard(snapshot),
      failed => this.emit({ type: failed ? "clipboard_unavailable" : "clipboard_recovered" }))
      // 监听异常由会话接收，避免未处理拒绝输出底层数据。
      .catch(() => { this.engine.blockPersistence(); this.halt?.abort(); });
    this.intake = { stop, done };
  }
  private async stopIntake(): Promise<void> {
    const intake = this.intake; this.intake = null;
    if (!intake) return;
    intake.stop.abort(); await intake.done;
  }
  private async receiveClipboard(snapshot: ClipboardSnapshot): Promise<void> {
    this.report(await this.receiver.receive(snapshot));
    this.wake?.();
  }
  private report(result: IntakeResult): void {
    for (const id of result.ids) this.emit({ type: this.store.share(this.accountId, id).cancelled ? "received_cancelled" : "received", id });
    if (result.issues.length) this.emit({ type: "intake_issues" });
    if (result.failure) { this.engine.blockPersistence(); this.emit({ type: "intake_failed", reason: result.failure }); }
  }
}
