import type { Operation, ReclaimCandidate, Store } from "../state/store";
import { AppError } from "../errors";
import { Drive } from "./drive";
import { ProviderError } from "./protocol";
import { unchangedOwnedCopy } from "./ownership";

export type SpaceResult = "ready" | "waiting_space" | "waiting_sync" | "too_large";
const absent = (error: unknown) => error instanceof ProviderError && error.status === 404 && ["not_found", "file_not_found"].includes(error.reason);

export class SpaceManager {
  constructor(private readonly store: Store, private readonly drive: Drive,
    private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void> = async (ms, signal) => {
      if (signal?.aborted) return;
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, ms); signal?.addEventListener("abort", done, { once: true });
      });
    }, private readonly now = Date.now) {}
  private async *candidates(): AsyncGenerator<ReclaimCandidate> {
    let after: { completedAt: bigint; remoteId: string } | undefined;
    while (true) {
      const page = this.store.candidates(this.drive.accountId, after); if (!page.length) return;
      for (const candidate of page) yield candidate;
      const last = page.at(-1)!; after = { completedAt: last.completedAt, remoteId: last.remoteId };
    }
  }
  private async verify(candidate: ReclaimCandidate, signal?: AbortSignal): Promise<boolean> {
    if (!candidate.evidence || !this.store.canReclaim(this.drive.accountId, candidate.id)) return false;
    let metadata: Record<string, unknown>;
    try { metadata = await this.drive.metadata(candidate.remoteId, signal); }
    catch (error) {
      if (absent(error)) { this.store.copyState(this.drive.accountId, candidate.id, "protected"); return false; }
      throw error;
    }
    if (!unchangedOwnedCopy(candidate.evidence, metadata)) {
      this.store.copyState(this.drive.accountId, candidate.id, "protected"); return false;
    }
    return true;
  }
  async ensure(needed: bigint, signal?: AbortSignal): Promise<SpaceResult> {
    let quota = await this.drive.quota(signal);
    if (needed > quota.limit) return "too_large";
    if (quota.free >= needed) return "ready";
    const pending = this.store.unresolved(this.drive.accountId).filter(operation => operation.kind === "delete");
    if (pending.length) {
      for (const operation of pending) if (!await this.reconcile(this.store.operation(this.drive.accountId, operation.id), needed, signal)) return "waiting_sync";
      quota = await this.drive.quota(signal); if (quota.free >= needed) return "ready";
    }
    // 先验证有足够合法候选；不为一个仍无法容纳的文件徒劳删除。
    let available = quota.free;
    for await (const candidate of this.candidates()) {
      if (signal?.aborted) throw signal.reason ?? Error("interrupted");
      if (await this.verify(candidate, signal)) available += candidate.size;
      if (available >= needed) break;
    }
    if (available < needed) return "waiting_space";
    for await (const candidate of this.candidates()) {
      if (signal?.aborted) throw signal.reason ?? Error("interrupted");
      quota = await this.drive.quota(signal); if (quota.free >= needed) return "ready";
      if (!await this.verify(candidate, signal)) continue;
      const operationId = this.store.beginOperation(this.drive.accountId, candidate.fileId, "delete", {
        copyId: candidate.id, freeBefore: quota.free.toString(), usageBefore: quota.usage.toString(), deadline: this.now() + 60000, sent: false, polls: 0,
      });
      try {
        const result = await this.drive.api.request(this.drive.accountId, "/drive/v1/files:batchDelete", {
          ...(signal ? { signal } : {}), method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [candidate.remoteId] }),
        }, () => {
          if (!this.store.canReclaim(this.drive.accountId, candidate.id)) throw new AppError("needs_reconciliation");
          this.store.transaction(() => { this.store.updateOperation(this.drive.accountId, operationId, { payload: { sent: true } }); this.store.copyState(this.drive.accountId, candidate.id, "deleting"); });
        });
        this.store.updateOperation(this.drive.accountId, operationId, { status: "submitted", payload: { outcome: "delete_accepted" }, ...(typeof result.task_id === "string" ? { taskId: result.task_id } : {}) });
      } catch (error) {
        const operation = this.store.operation(this.drive.accountId, operationId);
        if (!operation.payload.sent) this.store.updateOperation(this.drive.accountId, operationId, { status: "confirmed", payload: { outcome: "not_submitted" } });
        else this.store.updateOperation(this.drive.accountId, operationId, { status: "attention" });
        throw error;
      }
      if (!await this.reconcile(this.store.operation(this.drive.accountId, operationId), needed, signal)) return "waiting_sync";
    }
    return (await this.drive.quota(signal)).free >= needed ? "ready" : "waiting_space";
  }
  async reconcile(operation: Operation, needed = 0n, signal?: AbortSignal): Promise<boolean> {
    if (operation.kind !== "delete" || !operation.payload.copyId) throw new AppError("needs_reconciliation");
    const copy = this.store.copy(this.drive.accountId, operation.payload.copyId);
    if (!operation.payload.sent) {
      this.store.updateOperation(this.drive.accountId, operation.id, { status: "confirmed", payload: { outcome: "not_submitted" } }); return true;
    }
    let first = true;
    while (first || (this.now() <= (operation.payload.deadline ?? 0) && (operation.payload.polls ?? 0) < 15)) {
      first = false;
      if (signal?.aborted) throw signal.reason ?? Error("interrupted");
      operation = this.store.updateOperation(this.drive.accountId, operation.id, { payload: { polls: (operation.payload.polls ?? 0) + 1 } });
      if (operation.taskId) {
        const task = await this.drive.task(operation.taskId, signal);
        if (task.phase === "PHASE_TYPE_ERROR") return false;
        if (task.phase !== "PHASE_TYPE_COMPLETE") { await this.wait(5000, signal); continue; }
      }
      let missing = false;
      try {
        const actual = await this.drive.metadata(copy.remoteId, signal);
        if (!copy.evidence || !unchangedOwnedCopy(copy.evidence, actual)) {
          this.store.copyState(this.drive.accountId, copy.id, "protected"); return false;
        }
      } catch (error) {
        if (absent(error)) missing = error instanceof ProviderError && (error.reason === "file_not_found" || operation.payload.outcome === "delete_accepted" || !!operation.taskId);
        else throw error;
      }
      if (missing) {
        const quota = await this.drive.quota(signal);
        const before = operation.payload.usageBefore ? BigInt(operation.payload.usageBefore) : null;
        // 删除已请求且对象已不可见；容量足够，或完整反映这份副本的释放后，才结束核对。
        if ((needed > 0n && quota.free >= needed) || (before !== null && quota.usage <= before - copy.size)) {
          this.store.transaction(() => {
            this.store.copyState(this.drive.accountId, copy.id, "deleted");
            this.store.updateOperation(this.drive.accountId, operation.id, { status: "confirmed", payload: { outcome: "deleted" } });
          }); return true;
        }
      }
      if (this.now() > (operation.payload.deadline ?? 0) || (operation.payload.polls ?? 0) >= 15) break;
      await this.wait(5000, signal);
    }
    this.store.updateOperation(this.drive.accountId, operation.id, { status: "attention" }); return false;
  }
}
