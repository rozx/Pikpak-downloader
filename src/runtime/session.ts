import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { AppError } from "../errors";
import type { Store } from "../state/store";
import type { ClipboardSnapshot } from "../platform/types";
import type { IntakeReceiver, IntakeResult } from "../intake/receiver";
import { pollClipboard, type Clipboard } from "../intake/clipboard";
import type { Engine, ReleasePreview, RuntimeEvent } from "./engine";
import { saveConnections } from "../download/connections";
import { saveActiveFiles } from "./active-files";

export type SessionCommand =
  | { kind: "retry"; id: string } | { kind: "cancel"; id: string }
  | { kind: "pauseQueue" } | { kind: "resumeQueue" }
  | { kind: "submitText"; text: string } | { kind: "setOutputRoot"; path: string }
  | { kind: "setClipboardWatch"; enabled: boolean } | { kind: "setDownloadConnections"; count: number } | { kind: "setActiveFiles"; count: number }
  | { kind: "pauseTask"; id: string } | { kind: "resumeTask"; id: string } | { kind: "startAll" } | { kind: "releaseCopy"; id: string } | { kind: "releaseAll" };
export type CommandResult = { ok: true; ids: string[]; issues: string[] } | { ok: false; reason: string };
// stopActive / isPooled 对应下载池（add-concurrent-file-downloads）；只有串行执行器的测试替身可以不提供。
export type SessionEngine = Pick<Engine, "step" | "resumeLocalPause" | "resumeTrafficPause" | "reconcile" | "blockPersistence" | "subscribe">
  & Partial<Pick<Engine, "stopActive" | "isPooled" | "releasable" | "release" | "settleReleases" | "releasingFiles">>;
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

// 前台会话：剪贴板接收、执行器循环与界面命令共用一个调度点（add-task-controls 决策 1）。
// 大多数命令按提交顺序立即执行；只有暂停队列、以及目标正是当前串行步骤所处理项的暂停或取消，
// 才先中断当前步骤，等它在安全点返回后、开始下一个步骤之前执行。
export class RuntimeSession {
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly pending: Pending[] = [];
  private chain: Promise<unknown> = Promise.resolve();
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

  // 结果在命令真正写入任务库后返回。
  command(command: SessionCommand): Promise<CommandResult> {
    if (this.stopped) return Promise.resolve({ ok: false, reason: "stopped" });
    if (this.interrupts(command)) {
      return new Promise(resolve => { this.pending.push({ command, resolve }); this.stepAbort?.abort(); this.wake?.(); });
    }
    const result = this.chain.then(() => this.apply(command));
    this.chain = result.then(() => {}, () => {});
    void result.then(() => this.wake?.());
    return result;
  }
  // 需要先停下当前串行步骤的命令；下载池中的目标由 apply 中的 stopActive 停下，不必中断步骤。
  private interrupts(command: SessionCommand): boolean {
    if (command.kind === "pauseQueue") return true;
    return (command.kind === "cancel" || command.kind === "pauseTask") && (command.id === this.active.fileId || command.id === this.active.shareId);
  }

  async run(signal: AbortSignal): Promise<void> {
    const halt = new AbortController(); this.halt = halt;
    const combined = AbortSignal.any([signal, halt.signal]); this.running = combined;
    // 下载池空出名额时唤醒空闲等待，下一个文件尽快开始。
    // 手动释放结束后，被排除的文件可以重新调度。
    const unsubscribe = this.engine.subscribe(event => {
      this.track(event); this.emit(event); if (event.type === "released" || event.type === "release_finished") this.wake?.();
    });
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
      halt.abort(); this.wake?.(); await this.engine.stopActive?.().catch(() => {}); await this.engine.settleReleases?.().catch(() => {});
      await this.stopIntake(); unsubscribe();
      this.stopped = true; this.running = null;
      for (const item of this.pending.splice(0)) item.resolve({ ok: false, reason: "stopped" });
      this.emit({ type: "stopped" });
    }
  }

  releasing(): string[] { return this.engine.releasingFiles?.() ?? []; }
  // 手动释放的预览（只读）：界面据此决定打开确认框还是说明原因。
  releasable(id: string | null): ReleasePreview {
    try { return this.engine.releasable?.(id) ?? { ok: false, reason: "copy_absent" }; }
    catch (error) { return { ok: false, reason: error instanceof AppError ? error.code : "operation_failed" }; }
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
      let result: CommandResult = { ok: true, ids: [], issues: [] }, count: number | undefined, records: number | undefined;
      if (command.kind === "retry") this.store.retry(account, command.id);
      else if (command.kind === "cancel") {
        // 先写取消标记，调度不再选这些文件；再停下下载池中的目标（或该分享的文件），其他在途文件继续。
        this.store.cancel(account, command.id); this.store.recheckCancelledPause(account);
        await this.engine.stopActive?.(target => target.fileId === command.id || target.shareId === command.id);
      } else if (command.kind === "pauseQueue") { this.store.setConfig("queue_paused", "1"); await this.engine.stopActive?.(); }
      else if (command.kind === "pauseTask") {
        // 与取消相同：先写暂停标记，再停下下载池中的目标。
        this.store.pauseTask(account, command.id);
        await this.engine.stopActive?.(target => target.fileId === command.id || target.shareId === command.id);
      } else if (command.kind === "resumeTask") this.store.resumeTask(account, command.id);
      else if (command.kind === "startAll") { this.store.setConfig("queue_paused", "0"); this.store.resumeAllTasks(account); }
      else if (command.kind === "resumeQueue") this.store.setConfig("queue_paused", "0");
      else if (command.kind === "setOutputRoot") {
        const root = await writableDirectory(command.path);
        this.store.setConfig("output_root", root); this.receiver.setOutputRoot(root);
        result = { ok: true, ids: this.store.moveUnstartedShares(account, root), issues: [] }; count = result.ids.length;
      } else if (command.kind === "releaseCopy" || command.kind === "releaseAll") {
        // 立即返回：删除与核对在后台进行，结果由引擎事件报告；会话停止时随运行信号中断。全部释放只处理已完成的任务。
        const started = this.engine.release?.(command.kind === "releaseAll" ? null : command.id, this.running ?? new AbortController().signal) ?? { ok: false, reason: "copy_absent" };
        if (!started.ok) { this.emit({ type: "command_failed", reason: started.reason, ...id }); return started; }
        count = started.copies; if (!started.copies) records = started.removed;
      } else if (command.kind === "setDownloadConnections") saveConnections(this.store, command.count);
      else if (command.kind === "setActiveFiles") saveActiveFiles(this.store, command.count);
      else if (command.kind === "setClipboardWatch") {
        this.store.setConfig("clipboard_watch", command.enabled ? "1" : "0");
        if (!command.enabled) await this.stopIntake(); else if (this.running) this.startIntake();
      } else {
        const intake = await this.receiver.receiveText(command.text);
        this.report(intake);
        result = intake.failure ? { ok: false, reason: intake.failure } : { ok: true, ids: intake.ids, issues: intake.issues };
      }
      // 只删除记录（云盘中已没有副本）时，事件用 size 携带要删除的记录数。
      this.emit({ type: "command", reason: command.kind, ...id, ...(count === undefined ? {} : { count }), ...(records === undefined ? {} : { size: BigInt(records) }) });
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
