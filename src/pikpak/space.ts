import type { CopyRecord, Operation, ReclaimCandidate, Store } from "../state/store";
import { AppError } from "../errors";
import { Drive, definitelyMissing } from "./drive";
import { ProviderError } from "./protocol";
import { unchangedOwnedCopy } from "./ownership";

export type SpaceResult = "ready" | "waiting_space" | "waiting_sync" | "too_large";
// 手动释放一份副本的结果：已释放、已不在云盘中、已被改动（改为保护）、被服务端拒绝、已发出但尚未确认、资格已失效。
export type ReleaseOutcome = { outcome: "released" | "missing" | "changed" | "unconfirmed" | "skipped" } | { outcome: "denied"; reason: string }
  | { outcome: "failed"; error: unknown };
const BATCH = 100, PARALLEL = 4;
// 最多 limit 个任务同时进行；任一任务抛错时整体抛出。
async function limited<T>(items: readonly T[], limit: number, action: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) await action(items[next++]!); }));
}
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
  // 手动释放（add-task-controls 决策 4、11）。调用者持有云端操作锁，自动回收不会同时删除同一份副本。
  // 一批副本：先并发核对（最多 4 个请求同时进行），再按每批最多 100 个 ID 一次删除；删除请求为静默模式，
  // 服务端明确拒绝（401 以外的 4xx）只影响这一批，不暂停账号、不记录账号限流。删除被接受后以副本不可见为准确认，
  // 不等待容量反映（同时进行的转存会让容量上下波动）；仍可见的每 2 秒复查一次，最多 30 秒。
  async releaseMany(items: Array<{ copyId: string; fileId: string }>, signal?: AbortSignal): Promise<Map<string, ReleaseOutcome>> {
    const account = this.drive.accountId, outcomes = new Map<string, ReleaseOutcome>(), verified: Array<{ copy: CopyRecord; fileId: string }> = [];
    await limited(items, PARALLEL, async ({ copyId, fileId }) => {
      const copy = this.store.copy(account, copyId);
      if (!copy.evidence || !this.store.canRelease(account, copyId)) { outcomes.set(copyId, { outcome: "skipped" }); return; }
      try {
        const metadata = await this.drive.metadata(copy.remoteId, signal);
        if (!unchangedOwnedCopy(copy.evidence, metadata)) { this.store.copyState(account, copyId, "protected"); outcomes.set(copyId, { outcome: "changed" }); return; }
        verified.push({ copy, fileId });
      } catch (error) {
        if (signal?.aborted) throw error;
        if (definitelyMissing(error)) { this.store.releaseCopy(account, copyId, "deleted"); outcomes.set(copyId, { outcome: "missing" }); }
        else outcomes.set(copyId, { outcome: "failed", error });
      }
    });
    if (!verified.length) return outcomes;
    const quota = await this.drive.quota(signal);
    for (let start = 0; start < verified.length; start += BATCH) {
      if (signal?.aborted) throw signal.reason ?? Error("interrupted");
      const operations = new Map<string, string>();
      for (const { copy, fileId } of verified.slice(start, start + BATCH)) {
        try {
          operations.set(copy.id, this.store.beginOperation(account, fileId, "delete", {
            copyId: copy.id, freeBefore: quota.free.toString(), usageBefore: quota.usage.toString(), deadline: this.now() + 60000, sent: false, polls: 0,
          }));
        } catch (error) { outcomes.set(copy.id, { outcome: "failed", error }); }
      }
      const sending = verified.slice(start, start + BATCH).filter(item => operations.has(item.copy.id));
      if (!sending.length) continue;
      let taskId: string | undefined;
      try {
        const result = await this.drive.api.request(account, "/drive/v1/files:batchDelete", {
          ...(signal ? { signal } : {}), method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: sending.map(item => item.copy.remoteId) }),
        }, () => {
          if (!sending.every(item => this.store.canRelease(account, item.copy.id))) throw new AppError("needs_reconciliation");
          this.store.transaction(() => { for (const item of sending) this.store.releaseCopy(account, item.copy.id, "deleting", operations.get(item.copy.id)); });
        }, { quiet: true });
        if (typeof result.task_id === "string") taskId = result.task_id;
        this.store.transaction(() => {
          for (const item of sending) this.store.updateOperation(account, operations.get(item.copy.id)!, { status: "submitted", payload: { outcome: "delete_accepted" }, ...(taskId ? { taskId } : {}) });
        });
      } catch (error) {
        const sent = !!this.store.operation(account, operations.get(sending[0]!.copy.id)!).payload.sent;
        const denied = sent && error instanceof ProviderError && error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 401;
        for (const item of sending) {
          const operationId = operations.get(item.copy.id)!;
          if (!sent) { this.store.updateOperation(account, operationId, { status: "confirmed", payload: { outcome: "not_submitted" } }); outcomes.set(item.copy.id, { outcome: "failed", error }); }
          else if (denied) { this.store.releaseDenied(account, operationId, item.copy.id); outcomes.set(item.copy.id, { outcome: "denied", reason: (error as ProviderError).reason }); }
          else { this.store.updateOperation(account, operationId, { status: "attention" }); outcomes.set(item.copy.id, { outcome: "failed", error }); }
        }
        if (signal?.aborted) throw error;
        continue;
      }
      await this.confirmReleased(sending, operations, taskId, outcomes, signal);
    }
    return outcomes;
  }
  private async confirmReleased(items: Array<{ copy: CopyRecord; fileId: string }>, operations: Map<string, string>, taskId: string | undefined,
    outcomes: Map<string, ReleaseOutcome>, signal?: AbortSignal): Promise<void> {
    const account = this.drive.accountId, deadline = this.now() + 30000;
    let pending = items;
    while (pending.length) {
      if (signal?.aborted) throw signal.reason ?? Error("interrupted");
      const task = taskId ? await this.drive.task(taskId, signal) : null;
      if (task?.phase === "PHASE_TYPE_ERROR") break;
      if (!task || task.phase === "PHASE_TYPE_COMPLETE") {
        const still: typeof pending = [];
        await limited(pending, PARALLEL, async item => {
          const operationId = operations.get(item.copy.id)!;
          try {
            const actual = await this.drive.metadata(item.copy.remoteId, signal);
            if (item.copy.evidence && unchangedOwnedCopy(item.copy.evidence, actual)) { still.push(item); return; }
            this.store.transaction(() => { this.store.copyState(account, item.copy.id, "protected"); this.store.updateOperation(account, operationId, { status: "attention" }); });
            outcomes.set(item.copy.id, { outcome: "changed" });
          } catch (error) {
            if (signal?.aborted) throw error;
            if (!absent(error)) { still.push(item); return; }
            this.store.transaction(() => {
              this.store.copyState(account, item.copy.id, "deleted");
              this.store.updateOperation(account, operationId, { status: "confirmed", payload: { outcome: "deleted" } });
            });
            outcomes.set(item.copy.id, { outcome: "released" });
          }
        });
        pending = still;
      }
      if (!pending.length || this.now() >= deadline) break;
      await this.wait(2000, signal);
    }
    for (const item of pending) {
      this.store.updateOperation(account, operations.get(item.copy.id)!, { status: "attention" }); outcomes.set(item.copy.id, { outcome: "unconfirmed" });
    }
  }
  // 单份副本的手动释放；其他错误照常抛出。
  async release(copyId: string, fileId: string, signal?: AbortSignal): Promise<Exclude<ReleaseOutcome, { outcome: "failed" }>> {
    const outcome = (await this.releaseMany([{ copyId, fileId }], signal)).get(copyId)!;
    if (outcome.outcome === "failed") throw outcome.error;
    return outcome;
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
