import { AppError } from "../errors";
import type { SecretStore } from "../platform/types";
import type { LocalFileSystem } from "../platform/files";
import type { FileRecord, ReleaseTarget, Store } from "../state/store";
import { Drive, definitelyMissing } from "../pikpak/drive";
import { Restore } from "../pikpak/restore";
import { SpaceManager } from "../pikpak/space";
import { scanShare, ShareScanError } from "../pikpak/shares";
import { ProviderError } from "../pikpak/protocol";
import { FileWorkspace } from "../download/workspace";
import { download, DownloadError, remainingBytes, type DownloadTransport } from "../download/transfer";
import { publishVerified, reconcilePublication } from "../download/publish";
import { originalLink, secureDownloadUrl } from "../download/original-link";
import { configuredConnections } from "../download/connections";
import { configuredActiveFiles } from "./active-files";
import { collectShareAccess } from "../auth/share-access";
import type { AccountTier } from "../pikpak/tier";

export type RuntimeEvent = { type: string; id?: string; reason?: string; count?: number; bytes?: bigint; size?: bigint };
export type ActiveTarget = { fileId: string; shareId: string };
export type EngineOptions = { tier?: Pick<AccountTier, "refresh" | "cap"> };
// 手动释放的预览：可释放的副本数、合计大小、其中未完成文件的副本数，以及释放后会删除记录的已完成文件数；不能释放时给出原因。
export type ReleasePreview = { ok: true; copies: number; bytes: bigint; unfinished: number; removed: number } | { ok: false; reason: string };
type Delivery = (workspace: FileWorkspace, signal: AbortSignal) => Promise<void>;
type PoolEntry = ActiveTarget & { controller: AbortController; done: Promise<void> };
export class Engine {
  private readonly restore: Restore;
  private readonly space: SpaceManager;
  private blocked = false;
  // 进度节流按文件分别计算，多个文件同时下载时互不挤占。
  private readonly progressAt = new Map<string, number>();
  // 下载池（add-concurrent-file-downloads 决策 2）：已转存、正在下载、校验或发布的文件，每个有自己的中断控制器。
  private readonly pool = new Map<string, PoolEntry>();
  private preferFile = false;
  // 分段下载因限流降低后的并发，按账号在本次运行内记住，下一个文件从这个值开始（不持久化）。
  private readonly concurrency = new Map<string, number>();
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  // 当前串行步骤正在处理的文件；手动释放不处理它。
  private stepFile: string | null = null;
  // 正在手动释放副本的文件：调度不选它们，释放完成后才能重新转存。
  private readonly releasing = new Set<string>();
  private readonly releases = new Set<Promise<void>>();
  // 云端操作锁（add-task-controls 决策 4）：自动回收与手动释放依次执行，不会同时为同一份副本发出删除。
  private cloudQueue: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: Store, private readonly secrets: SecretStore, private readonly drive: Drive,
    private readonly filesystem: LocalFileSystem, private readonly report: (event: RuntimeEvent) => void = () => {},
    private readonly http?: DownloadTransport,
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>, private readonly options: EngineOptions = {}) {
    this.restore = new Restore(store, secrets, drive, wait); this.space = new SpaceManager(store, drive, wait);
  }
  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  private event(event: RuntimeEvent): void {
    this.report(event);
    for (const listener of this.listeners) listener(event);
  }
  private pause(reason: "authentication" | "permission" | "local_space" | "target_unavailable" | "database" | "traffic_quota", fileId?: string): void {
    if (reason === "database") this.blocked = true;
    try { this.store.pause(this.drive.accountId, reason, fileId ?? null); } catch { this.blocked = true; }
    this.event({ type: "paused", reason, ...(fileId ? { id: fileId } : {}) });
    // 账号级暂停对所有在途文件都生效：其余文件在安全点停止并保存检查点。
    this.haltPool(fileId);
  }
  private haltPool(except?: string): void { for (const entry of this.pool.values()) if (entry.fileId !== except) entry.controller.abort(); }
  // 实际生效的同时下载数：配置值与账号等级上限中的较小值；未提供等级时按未知处理（1）。
  capacity(): number { return Math.min(configuredActiveFiles(this.store), this.options.tier?.cap ?? 1); }
  activeFiles(): ActiveTarget[] { return [...this.pool.values()].map(({ fileId, shareId }) => ({ fileId, shareId })); }
  isPooled(fileId: string): boolean { return this.pool.has(fileId); }
  // 中断匹配的在途文件，等它们在安全点返回（检查点已保存）。
  async stopActive(match: (target: ActiveTarget) => boolean = () => true): Promise<void> {
    const entries = [...this.pool.values()].filter(match);
    for (const entry of entries) entry.controller.abort();
    await Promise.allSettled(entries.map(entry => entry.done));
  }
  blockPersistence(): void { this.pause("database"); }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.cloudQueue.then(action);
    this.cloudQueue = result.then(() => {}, () => {});
    return result;
  }
  // id 为 null 表示全部释放：只处理已完成任务的副本与记录，未完成的任务不动（避免释放后立即重新转存）。
  private releaseTargets(id: string | null): { targets: ReleaseTarget[]; orphans: string[]; reason: string | null } {
    const found = this.store.releaseTargets(this.drive.accountId, id);
    const free = (fileId: string) => !this.pool.has(fileId) && fileId !== this.stepFile && !this.releasing.has(fileId);
    const candidates = id === null ? found.targets.filter(target => target.completed) : found.targets;
    const targets = candidates.filter(target => target.fileIds.every(free)), orphans = found.orphans.filter(free);
    const busy = candidates.length + found.orphans.length > targets.length + orphans.length;
    return { targets, orphans, reason: targets.length || orphans.length ? null : busy ? "copy_in_use" : id === null ? "copy_absent" : found.reason ?? "copy_absent" };
  }
  private preview({ targets, orphans, reason }: { targets: ReleaseTarget[]; orphans: string[]; reason: string | null }): ReleasePreview {
    if (reason) return { ok: false, reason };
    return { ok: true, copies: targets.length, bytes: targets.reduce((sum, target) => sum + target.copy.size, 0n), unfinished: targets.filter(target => !target.completed).length,
      removed: targets.filter(target => target.completed).reduce((sum, target) => sum + target.fileIds.length, 0) + orphans.length };
  }
  // 手动释放（add-task-controls 决策 4）：只读预览，供界面决定是否打开确认框。
  releasable(id: string | null): ReleasePreview { return this.preview(this.releaseTargets(id)); }
  // 开始释放并立即返回预览；删除与核对在云端操作锁内于后台进行，结果以事件报告。
  release(id: string | null, signal: AbortSignal): ReleasePreview {
    const found = this.releaseTargets(id), preview = this.preview(found); if (!preview.ok) return preview;
    const { targets, orphans } = found, fileIds = [...targets.flatMap(target => target.fileIds), ...orphans];
    const shareIds = [...new Set(fileIds.map(fileId => this.store.file(this.drive.accountId, fileId).shareId))];
    for (const fileId of fileIds) this.releasing.add(fileId);
    const done = this.exclusive(async () => {
      for (const target of targets) { if (signal.aborted) return; await this.releaseOne(target, signal); }
      for (const fileId of orphans) {
        // 先报告再删除：事件区按 ID 查名称，删除后就查不到了。检查与删除之间没有 await。
        if (!this.store.forgettable(this.drive.accountId, fileId)) continue;
        this.event({ type: "task_removed", id: fileId }); this.store.forgetFile(this.drive.accountId, fileId);
      }
      await this.forgetShares(shareIds);
    }).catch(() => {}).finally(() => {
      for (const fileId of fileIds) this.releasing.delete(fileId);
      this.releases.delete(done); this.event({ type: "release_finished" });
    });
    this.releases.add(done);
    return preview;
  }
  private async releaseOne(target: ReleaseTarget, signal: AbortSignal): Promise<void> {
    const id = target.fileIds[0]!;
    try {
      const result = await this.space.release(target.copy.id, id, signal);
      if (result.outcome === "released" || result.outcome === "missing") {
        // 已完成文件的副本释放后删除任务记录（add-task-controls 决策 7）；先报告再删除。
        const remove = target.completed && target.fileIds.every(fileId => this.store.forgettable(this.drive.accountId, fileId));
        this.event(result.outcome === "released" ? { type: "copy_released", id, bytes: target.copy.size, ...(remove ? { reason: "removed" } : {}) }
          : { type: "copy_missing", id, ...(remove ? { reason: "removed" } : {}) });
        if (remove) for (const fileId of target.fileIds) this.store.forgetFile(this.drive.accountId, fileId);
      } else if (result.outcome === "changed") this.event({ type: "copy_release_skipped", id, reason: "copy_changed" });
      else if (result.outcome === "skipped") this.event({ type: "copy_release_skipped", id, reason: "copy_in_use" });
      else if (result.outcome === "denied") this.event({ type: "copy_release_denied", id, reason: result.reason });
      else this.event({ type: "attention", id, reason: "operation_needs_reconciliation" });
    } catch (error) {
      if (signal.aborted) return;
      const reason = error instanceof AppError ? error.code : error instanceof ProviderError && error.status === 429 ? "rate_limited" : "remote_request_failed";
      this.event({ type: "copy_release_failed", id, reason });
    }
  }
  // 文件记录都已删除的分享随之删除，不再被引用的访问资料一并回收。
  private async forgetShares(shareIds: string[]): Promise<void> {
    for (const shareId of shareIds) {
      if (!this.store.shareForgettable(this.drive.accountId, shareId)) continue;
      this.event({ type: "share_removed", id: shareId });
      const reference = this.store.forgetShare(this.drive.accountId, shareId);
      if (reference) await collectShareAccess(this.store, this.secrets, reference).catch(() => false);
    }
  }
  // 正在手动释放副本的文件（界面显示“释放中”）。
  releasingFiles(): string[] { return [...this.releasing]; }
  // 等待后台释放在安全点结束（会话停止时信号已中断）。
  async settleReleases(): Promise<void> { await Promise.allSettled([...this.releases]); }
  private async local(file: FileRecord): Promise<FileWorkspace> {
    try { return await FileWorkspace.open(this.store, this.drive.accountId, file.shareId, this.filesystem); }
    catch (error) { this.pause("target_unavailable", file.id); throw error; }
  }
  async resumeLocalPause(signal?: AbortSignal): Promise<void> {
    this.store.recheckCancelledPause(this.drive.accountId);
    const pause = this.store.paused(this.drive.accountId);
    if (!pause?.fileId || !["local_space", "target_unavailable"].includes(pause.reason)) return;
    const file = this.store.file(this.drive.accountId, pause.fileId); let workspace: FileWorkspace | undefined;
    try {
      workspace = await FileWorkspace.open(this.store, this.drive.accountId, file.shareId, this.filesystem);
      const remaining = this.store.delivery(this.drive.accountId, file.id)?.sha256 ? 0n : await remainingBytes(this.store, this.drive.accountId, file, workspace, signal);
      if (await workspace.freeBytes() < remaining + 1048576n) return;
      this.store.resume(this.drive.accountId, { authenticated: true, permitted: true, writable: true, hasSpace: true, targetAvailable: true, trafficAvailable: true });
    } catch { /* 条件尚未满足，不清除原暂停。 */ }
    finally { await workspace?.close(); }
  }
  async resumeTrafficPause(signal: AbortSignal): Promise<void> {
    const pause = this.store.paused(this.drive.accountId);
    if (pause?.reason !== "traffic_quota" || !pause.fileId) return;
    const file = this.store.file(this.drive.accountId, pause.fileId), copy = this.store.copyForFile(this.drive.accountId, file.id);
    if (!copy || !file.size) return;
    try {
      const remote = await this.drive.file(copy.remoteId, signal);
      if (remote.gcid !== file.gcid || remote.size !== file.size) return;
      const link = originalLink(remote.raw), endpoint = link && secureDownloadUrl(link.url); if (!endpoint) return;
      const response = await (this.http ?? fetch)(endpoint.url.href, { headers: { Range: "bytes=0-0", "Accept-Encoding": "identity" },
        redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
      try {
        if (response.status !== 206 || response.headers.get("content-range") !== `bytes 0-0/${file.size}` || !response.body) return;
        const reader = response.body.getReader(); let received = 0, ended = false;
        try { while (received <= 1) { const part = await reader.read(); if (part.done) { ended = true; break; } received += part.value.byteLength; } }
        finally { await reader.cancel(); }
        if (ended && received === 1 && this.store.paused(this.drive.accountId)?.reason === "traffic_quota") {
          this.store.resume(this.drive.accountId, { authenticated: true, permitted: true, writable: true, hasSpace: true, targetAvailable: true, trafficAvailable: true });
        }
      } finally { if (!response.body?.locked) await response.body?.cancel().catch(() => {}); }
    } catch { /* 只读验证尚未通过，保留暂停，不转存或清理。 */ }
  }
  async reconcile(signal: AbortSignal): Promise<void> {
    for (const item of this.store.unresolved(this.drive.accountId)) {
      if (signal.aborted || this.blocked) return;
      const operation = this.store.operation(this.drive.accountId, item.id), file = this.store.file(this.drive.accountId, item.fileId);
      if (operation.kind !== "publish" && this.store.rateLimited(this.drive.accountId)) continue;
      let workspace: FileWorkspace | undefined;
      try {
        if (operation.kind === "restore") {
          if (!operation.payload.sent) this.store.updateOperation(this.drive.accountId, operation.id, { status: "confirmed", payload: { outcome: "not_submitted" } });
          else await this.restore.ensure(file, signal);
        } else if (operation.kind === "delete") await this.exclusive(() => this.space.reconcile(operation, 0n, signal));
        else {
          workspace = await FileWorkspace.open(this.store, this.drive.accountId, file.shareId, this.filesystem);
          if (!await reconcilePublication(this.store, this.drive.accountId, file, workspace, signal) && !file.cancelled && !this.store.share(this.drive.accountId, file.shareId).cancelled) {
            const delivery = this.store.delivery(this.drive.accountId, file.id)!;
            await publishVerified(this.store, this.drive.accountId, file, workspace, { gcid: file.gcid, sha256: delivery.sha256! }, signal);
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof AppError && ["authorization_failed", "credentials_unavailable", "login_required"].includes(error.code)) { this.pause("authentication"); return; }
        if (operation.kind !== "delete" && file.state !== "completed") this.store.fileError(this.drive.accountId, file.id, "operation_needs_reconciliation", true);
        this.event({ type: "attention", id: file.id, reason: "operation_needs_reconciliation" });
      } finally { await workspace?.close(); }
    }
  }
  async step(signal: AbortSignal): Promise<boolean> {
    try { return await this.stepOnce(signal); } finally { this.stepFile = null; }
  }
  private async stepOnce(signal: AbortSignal): Promise<boolean> {
    const account = this.drive.accountId;
    // 用户暂停与系统暂停分开记录，任一存在都不调度新的扫描、转存、下载或回收；对已发出操作的核对不受影响。
    if (signal.aborted || this.blocked || this.store.paused(account) || this.store.config("queue_paused") === "1" || this.store.rateLimited(account)) return false;
    await this.options.tier?.refresh(signal);
    // 没有空余名额时不选新文件，但仍可以扫描。
    const capacity = this.capacity(), room = this.pool.size < capacity, busy = [...this.pool.keys(), ...this.releasing];
    const preferred = this.preferFile && room ? this.store.nextFile(account, Date.now(), busy) : null;
    const scan = preferred ? null : this.store.nextScan(account);
    if (scan) {
      this.preferFile = true;
      this.event({ type: "scanning", id: scan.shareId });
      try {
        const result = await scanShare(this.store, this.secrets, this.drive.api, scan, signal);
        this.event({ type: result.complete ? "scanned" : "scan_incomplete", id: scan.shareId, count: result.files });
      } catch (error) {
        if (signal.aborted) return false;
        if (error instanceof ShareScanError || (error instanceof AppError && error.code === "share_access_required")) {
          this.event({ type: "scan_waiting", id: scan.shareId, reason: error instanceof ShareScanError ? error.code : "access_required" });
        } else if (error instanceof AppError && ["authorization_failed", "login_required", "credentials_unavailable", "account_mismatch"].includes(error.code)) this.pause("authentication");
        else if (error instanceof ProviderError) {
          if (error.status === 429) this.store.rateLimit(account, error.retryAfterMs ?? 60000);
          this.store.scanRetry(scan);
        }
        else this.pause("database");
      }
      return true;
    }
    if (!room) return false;
    let file = preferred ?? this.store.nextFile(account, Date.now(), busy);
    if (!file) return false;
    this.preferFile = false; this.stepFile = file.id;
    const accessReference = this.store.operationFor(account, file.id, "restore")?.secretRef ?? this.store.share(account, file.shareId).secretRef;
    // 串行部分：占用名额、检查已有副本、本地空间预检、空间计划与转存。下载、校验与发布交给 delivery。
    let delivery: Delivery | null = null;
    let workspace: FileWorkspace | undefined;
    try {
      if (["discovered", "retry_wait", "waiting_space"].includes(file.state)) { this.store.transition(account, file.id, "ready"); file = this.store.file(account, file.id); }
      if (file.state === "publishing" || (file.state === "reconciling" && this.store.delivery(account, file.id)?.sha256)) {
        const target = file;
        delivery = async (local, taskSignal) => {
          if (!await reconcilePublication(this.store, account, target, local, taskSignal)) {
            const saved = this.store.delivery(account, target.id)!;
            await publishVerified(this.store, account, target, local, { gcid: target.gcid, sha256: saved.sha256! }, taskSignal);
          }
          this.event({ type: "completed", id: target.id });
        };
      } else {
        let copy = this.store.copyForFile(account, file.id);
        if (copy) {
          try {
            const current = await this.drive.file(copy.remoteId, signal);
            if (current.size !== file.size || current.gcid !== file.gcid) {
              this.store.copyState(account, copy.id, "protected"); this.store.fileError(account, file.id, "copy_version_changed"); return true;
            }
          } catch (error) {
            if (definitelyMissing(error)) {
              this.store.copyState(account, copy.id, "deleted");
              if (!this.store.resaveMissing(account, file.id)) return true;
              copy = null; file = this.store.file(account, file.id);
            } else throw error;
          }
        }
        if (!copy && file.size > (await this.drive.quota(signal)).limit) { this.store.fileError(account, file.id, "file_exceeds_cloud_capacity"); return true; }
        workspace = await this.local(file);
        const remaining = await remainingBytes(this.store, account, file, workspace, signal);
        if (await workspace.freeBytes() < remaining + 1048576n) { this.pause("local_space", file.id); return false; }
        if (!copy) {
          this.event({ type: "saving", id: file.id });
          const previous = this.store.operationFor(account, file.id, "restore");
          if (!previous?.payload.sent) {
            await this.restore.checkSource(file, signal);
            const needed = file.size, space = await this.exclusive(() => this.space.ensure(needed, signal));
            if (space === "too_large") { this.store.fileError(account, file.id, "file_exceeds_cloud_capacity"); return true; }
            if (space !== "ready") { this.store.waitForSpace(account, file.id); this.event({ type: "waiting_space", id: file.id, reason: space }); return true; }
          }
          copy = await this.restore.ensure(file, signal);
        }
        file = this.store.file(account, file.id);
        if (file.cancelled || this.store.share(account, file.shareId).cancelled) return true;
        if (file.state === "saving") this.store.transition(account, file.id, "reconciling");
        const target = file, remote = copy;
        delivery = async (local, taskSignal) => {
          this.event({ type: "downloading", id: target.id });
          const remembered = this.concurrency.get(account);
          await download(this.store, account, target, remote, local, () => this.drive.file(remote.remoteId, taskSignal), taskSignal, bytes => {
            const now = Date.now();
            if (now - (this.progressAt.get(target.id) ?? 0) >= 250) { this.progressAt.set(target.id, now); this.event({ type: "progress", id: target.id, bytes, size: target.size }); }
          }, this.http, { connections: configuredConnections(this.store), ...(remembered === undefined ? {} : { startConnections: remembered }),
            onConcurrency: current => { this.concurrency.set(account, current); } });
          this.progressAt.delete(target.id);
          this.event({ type: "completed", id: target.id });
        };
      }
    } catch (error) { return this.failed(error, file, accessReference, signal); }
    finally { await workspace?.close(); }
    // 同时下载数为 1 时在本步内完成，顺序与单执行器相同；否则交给下载池并立即返回。
    if (capacity === 1) return this.deliver(file, accessReference, signal, delivery);
    this.launch(file, accessReference, delivery);
    return true;
  }

  private async deliver(file: FileRecord, accessReference: string, signal: AbortSignal, delivery: Delivery): Promise<boolean> {
    let workspace: FileWorkspace | undefined;
    try { workspace = await this.local(file); await delivery(workspace, signal); return true; }
    catch (error) { return this.failed(error, file, accessReference, signal); }
    finally { await workspace?.close(); }
  }
  private launch(file: FileRecord, accessReference: string, delivery: Delivery): void {
    const entry: PoolEntry = { fileId: file.id, shareId: file.shareId, controller: new AbortController(), done: Promise.resolve() };
    this.pool.set(file.id, entry);
    entry.done = this.deliver(file, accessReference, entry.controller.signal, delivery).then(() => {}, () => {}).finally(() => {
      this.pool.delete(file.id); this.progressAt.delete(file.id);
      this.event({ type: "released", id: file.id });
    });
  }

  // 下载、转存与发布错误的分类；串行步骤与下载池共用。返回值与 step 相同。
  private async failed(error: unknown, file: FileRecord, accessReference: string, signal: AbortSignal): Promise<boolean> {
    const account = this.drive.accountId;
    if (signal.aborted) return false;
    const current = this.store.file(account, file.id);
    const code = (error as { code?: string }).code;
    if (this.store.paused(account)) return false;
    if (code === "ENOSPC") this.pause("local_space", file.id);
    else if (["EACCES", "EROFS", "ENODEV", "native-session-closed"].includes(code ?? (error instanceof Error ? error.message : ""))) this.pause("target_unavailable", file.id);
    else if (error instanceof AppError && ["authorization_failed", "login_required", "credentials_unavailable", "account_mismatch"].includes(error.code)) this.pause("authentication");
    else if ((error instanceof ShareScanError && error.code === "access_required") || (error instanceof AppError && error.code === "share_access_required")) {
      if (this.store.share(account, file.shareId).secretRef === accessReference) this.store.fileError(account, file.id, "access_required");
    } else if (error instanceof ShareScanError) this.store.fileError(account, file.id, error.code);
    else if ((error instanceof DownloadError && error.code === "version_changed") || (error instanceof Error && error.message === "source-version-changed")) {
      this.store.fileError(account, file.id, "version_changed"); this.store.requestRescan(account, file.shareId);
    } else if (current.state === "publishing" || error instanceof AppError || (error instanceof ProviderError && error.status === 404)) this.store.fileError(account, file.id, "needs_reconciliation", true);
    else if (error instanceof DownloadError || error instanceof ProviderError) {
      if ((error instanceof DownloadError && error.code === "traffic_quota") || (error instanceof ProviderError && (error.status === 402 || ["download_quota_exceeded", "download_traffic_not_enough", "download_flow_not_enough", "traffic_limit_exceeded"].includes(error.reason)))) this.pause("traffic_quota", file.id);
      else if ((error instanceof DownloadError && error.code === "rate_limited") || (error instanceof ProviderError && error.status === 429)) {
        // 账号限流同样对所有在途文件生效。
        this.store.rateLimit(account, error.retryAfterMs ?? 60000); this.store.transientFailure(account, file.id, "rate_limited"); this.haltPool(file.id);
      }
      else this.store.transientFailure(account, file.id, error instanceof DownloadError ? error.code : "remote_request_failed");
    } else if (code?.startsWith("SQLITE_")) this.pause("database");
    else this.store.fileError(account, file.id, "local_operation_failed", true);
    this.event({ type: "file_waiting", id: file.id, reason: this.store.file(account, file.id).lastError ?? "paused" }); return true;
  }
}
