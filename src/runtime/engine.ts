import { AppError } from "../errors";
import type { SecretStore } from "../platform/types";
import type { LocalFileSystem } from "../platform/files";
import type { FileRecord, Store } from "../state/store";
import { Drive, definitelyMissing } from "../pikpak/drive";
import { Restore } from "../pikpak/restore";
import { SpaceManager } from "../pikpak/space";
import { scanShare, ShareScanError } from "../pikpak/shares";
import { ProviderError } from "../pikpak/protocol";
import { FileWorkspace } from "../download/workspace";
import { download, DownloadError, remainingBytes, type DownloadTransport } from "../download/transfer";
import { publishVerified, reconcilePublication } from "../download/publish";
import { originalLink, secureDownloadUrl } from "../download/original-link";

export type RuntimeEvent = { type: string; id?: string; reason?: string; count?: number; bytes?: bigint; size?: bigint };
export class Engine {
  private readonly restore: Restore;
  private readonly space: SpaceManager;
  private blocked = false;
  private lastProgress = 0;
  private preferFile = false;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  constructor(private readonly store: Store, private readonly secrets: SecretStore, private readonly drive: Drive,
    private readonly filesystem: LocalFileSystem, private readonly report: (event: RuntimeEvent) => void = () => {},
    private readonly http?: DownloadTransport,
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>) {
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
  }
  blockPersistence(): void { this.pause("database"); }
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
        } else if (operation.kind === "delete") await this.space.reconcile(operation, 0n, signal);
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
    const account = this.drive.accountId;
    // 用户暂停与系统暂停分开记录，任一存在都不调度新的扫描、转存、下载或回收；对已发出操作的核对不受影响。
    if (signal.aborted || this.blocked || this.store.paused(account) || this.store.config("queue_paused") === "1" || this.store.rateLimited(account)) return false;
    const preferred = this.preferFile ? this.store.nextFile(account) : null;
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
    let file = preferred ?? this.store.nextFile(account);
    if (!file) return false;
    this.preferFile = false;
    const accessReference = this.store.operationFor(account, file.id, "restore")?.secretRef ?? this.store.share(account, file.shareId).secretRef;
    let workspace: FileWorkspace | undefined;
    try {
      if (["discovered", "retry_wait", "waiting_space"].includes(file.state)) { this.store.transition(account, file.id, "ready"); file = this.store.file(account, file.id); }
      if (file.state === "publishing" || (file.state === "reconciling" && this.store.delivery(account, file.id)?.sha256)) {
        workspace = await this.local(file);
        if (!await reconcilePublication(this.store, account, file, workspace, signal)) {
          const delivery = this.store.delivery(account, file.id)!;
          await publishVerified(this.store, account, file, workspace, { gcid: file.gcid, sha256: delivery.sha256! }, signal);
        }
        this.event({ type: "completed", id: file.id }); return true;
      }
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
          const capacity = await this.space.ensure(file.size, signal);
          if (capacity === "too_large") { this.store.fileError(account, file.id, "file_exceeds_cloud_capacity"); return true; }
          if (capacity !== "ready") { this.store.waitForSpace(account, file.id); this.event({ type: "waiting_space", id: file.id, reason: capacity }); return true; }
        }
        copy = await this.restore.ensure(file, signal);
      }
      file = this.store.file(account, file.id);
      if (file.cancelled || this.store.share(account, file.shareId).cancelled) return true;
      if (file.state === "saving") this.store.transition(account, file.id, "reconciling");
      this.event({ type: "downloading", id: file.id });
      await download(this.store, account, file, copy, workspace, () => this.drive.file(copy!.remoteId, signal), signal, bytes => {
        if (Date.now() - this.lastProgress >= 250) { this.lastProgress = Date.now(); this.event({ type: "progress", id: file!.id, bytes, size: file!.size }); }
      }, this.http);
      this.event({ type: "completed", id: file.id }); return true;
    } catch (error) {
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
          this.store.rateLimit(account, error.retryAfterMs ?? 60000); this.store.transientFailure(account, file.id, "rate_limited");
        }
        else this.store.transientFailure(account, file.id, error instanceof DownloadError ? error.code : "remote_request_failed");
      } else if (code?.startsWith("SQLITE_")) this.pause("database");
      else this.store.fileError(account, file.id, "local_operation_failed", true);
      this.event({ type: "file_waiting", id: file.id, reason: this.store.file(account, file.id).lastError ?? "paused" }); return true;
    } finally { await workspace?.close(); }
  }
}
