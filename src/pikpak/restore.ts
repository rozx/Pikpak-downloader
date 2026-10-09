import { loadShareAccess } from "../auth/share-access";
import { AppError } from "../errors";
import type { SecretStore } from "../platform/types";
import type { CopyRecord, FileRecord, Store } from "../state/store";
import { Drive, object, integer, validId, remoteFile } from "./drive";
import { requireShareAccess } from "./shares";
import { serverTime } from "./protocol";
import { creationEvidence, mappedCopy } from "./ownership";

export class Restore {
  constructor(private readonly store: Store, private readonly secrets: SecretStore, private readonly drive: Drive,
    private readonly wait: (milliseconds: number, signal?: AbortSignal) => Promise<void> = async (milliseconds, signal) => {
      if (signal?.aborted) return;
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, milliseconds); signal?.addEventListener("abort", finish, { once: true });
      });
    }) {}
  async checkSource(file: FileRecord, signal?: AbortSignal): Promise<void> {
    const account = this.drive.accountId;
    let pending = this.store.operationFor(account, file.id, "restore");
    if (pending?.payload.sent || this.store.copyForFile(account, file.id)) return;
    if (pending && pending.secretRef !== this.store.share(account, file.shareId).secretRef) {
      this.store.updateOperation(account, pending.id, { status: "confirmed", payload: { outcome: "superseded_before_submit" } }); pending = null;
    }
    const operation = pending ?? this.store.operation(account, this.store.beginOperation(account, file.id, "restore", { sent: false }));
    const share = this.store.share(account, file.shareId);
    try {
      const access = await loadShareAccess(this.secrets, operation.secretRef, account, share.remoteId);
      const init = signal ? { signal } : {};
      const query = new URLSearchParams({ share_id: share.remoteId, pass_code: access.passCode });
      const grant = requireShareAccess(await this.drive.api.request(account, `/drive/v1/share?${query}`, init));
      const sourceQuery = new URLSearchParams({ share_id: share.remoteId, file_id: file.sourceId, pass_code_token: grant });
      const response = await this.drive.api.request(account, `/drive/v1/share/file_info?${sourceQuery}`, init);
      const source = object(response.file_info ?? response.file ?? response);
      if (source.id !== file.sourceId || source.kind !== "drive#file" || integer(source.size) !== file.size
        || typeof source.hash !== "string" || source.hash.toLowerCase() !== file.gcid) throw Error("source-version-changed");
    } catch (error) {
      this.store.updateOperation(account, operation.id, { status: "confirmed", payload: { outcome: "not_submitted" } }); throw error;
    }
  }
  async ensure(file: FileRecord, signal?: AbortSignal): Promise<CopyRecord> {
    const account = this.drive.accountId;
    file = this.store.file(account, file.id);
    const existing = this.store.copyForFile(account, file.id); if (existing) return existing;
    const share = this.store.share(account, file.shareId);
    let operation = this.store.operationFor(account, file.id, "restore");
    if (!operation) operation = this.store.operation(account, this.store.beginOperation(account, file.id, "restore", { sent: false }));
    const interrupted = () => { if (signal?.aborted) throw signal.reason ?? Error("interrupted"); };
    if (!operation.payload.sent) {
      try {
        interrupted();
        const access = await loadShareAccess(this.secrets, operation.secretRef, account, share.remoteId);
        const query = new URLSearchParams({ share_id: share.remoteId, pass_code: access.passCode });
        const init = signal ? { signal } : {};
        const root = await this.drive.api.request(account, `/drive/v1/share?${query}`, init);
        const grant = requireShareAccess(root);
        const sourceQuery = new URLSearchParams({ share_id: share.remoteId, file_id: file.sourceId, pass_code_token: grant });
        const response = await this.drive.api.request(account, `/drive/v1/share/file_info?${sourceQuery}`, init);
        const source = object(response.file_info ?? response.file ?? response);
        if (source.id !== file.sourceId || source.kind !== "drive#file" || integer(source.size) !== file.size
          || typeof source.hash !== "string" || source.hash.toLowerCase() !== file.gcid) throw Error("source-version-changed");
        const remoteTime = serverTime(response) ?? serverTime(root);
        operation = this.store.updateOperation(account, operation.id, { payload: { ...(remoteTime !== null ? { notBefore: new Date(remoteTime).toISOString() } : {}), deadline: Date.now() + 600000, polls: 0 } });
        const operationId = operation.id;
        const saved = await this.drive.api.request(account, "/drive/v1/share/restore", {
          ...init, method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ share_id: share.remoteId, pass_code_token: grant, file_ids: [file.sourceId], params: { trace_file_ids: file.sourceId } }),
        }, () => {
          interrupted();
          this.store.transaction(() => {
            this.store.updateOperation(account, operationId, { payload: { sent: true } });
            this.store.transition(account, file.id, "saving");
          });
        });
        const taskId = saved.restore_task_id;
        if (saved.restore_status !== "RESTORE_START" || !validId(taskId) || this.store.taskAlreadyRecorded(account, taskId, operation.id)) throw new AppError("needs_reconciliation");
        operation = this.store.updateOperation(account, operation.id, { status: "submitted", taskId });
        this.store.transition(account, file.id, "awaiting_remote");
      } catch (error) {
        operation = this.store.operation(account, operation.id);
        if (!operation.payload.sent) this.store.updateOperation(account, operation.id, { status: "confirmed", payload: { outcome: "not_submitted" } });
        else if (!operation.taskId) {
          this.store.updateOperation(account, operation.id, { status: "attention" });
          throw new AppError("needs_reconciliation");
        }
        throw error;
      }
    }
    if (!operation.taskId) throw new AppError("needs_reconciliation");
    let reconcileOnce = true;
    while (reconcileOnce || ((operation.payload.polls ?? 0) < 150 && Date.now() <= (operation.payload.deadline ?? 0))) {
      reconcileOnce = false;
      interrupted();
      operation = this.store.updateOperation(account, operation.id, { payload: { polls: (operation.payload.polls ?? 0) + 1 } });
      const task = await this.drive.task(operation.taskId!, signal);
      const destination = mappedCopy(task, file.sourceId);
      if (destination) operation = this.store.updateOperation(account, operation.id, { resultId: destination });
      if (task.phase === "PHASE_TYPE_ERROR") throw new AppError("needs_reconciliation");
      if (task.phase === "PHASE_TYPE_COMPLETE" && destination && destination !== file.sourceId) {
        const metadata = await this.drive.metadata(destination, signal);
        if (metadata.phase === "PHASE_TYPE_COMPLETE") {
          const actual = remoteFile(metadata);
          if (actual.size !== file.size || actual.gcid !== file.gcid) throw new AppError("needs_reconciliation");
          const evidence = operation.payload.notBefore ? creationEvidence({ taskId: operation.taskId!, sourceId: file.sourceId,
            shareId: share.remoteId, size: file.size, gcid: file.gcid, notBefore: operation.payload.notBefore }, task, actual.raw) : null;
          const copyId = this.store.transaction(() => {
            if (operation!.status !== "submitted") this.store.updateOperation(account, operation!.id, { status: "submitted" });
            const copyId = this.store.recordCopy(account, operation!.id, { remoteId: actual.id, parentId: actual.parentId, size: actual.size, gcid: actual.gcid });
            if (evidence) this.store.recordCreation(account, copyId, operation!.id, evidence);
            return copyId;
          });
          return this.store.copy(account, copyId);
        }
      }
      if ((operation.payload.polls ?? 0) >= 150 || Date.now() > (operation.payload.deadline ?? 0)) break;
      await this.wait(Math.min(30000, 1000 * 2 ** Math.min(operation.payload.polls ?? 0, 5)), signal);
    }
    this.store.updateOperation(account, operation.id, { status: "attention" });
    throw new AppError("needs_reconciliation");
  }
}
