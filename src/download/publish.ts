import { AppError } from "../errors";
import type { Store, FileRecord } from "../state/store";
import type { LocalFile } from "../platform/files";
import { sameIdentity } from "../platform/files";
import { ContentHasher } from "./gcid";
import type { FileWorkspace } from "./workspace";

export async function hashFile(file: LocalFile, size: bigint, signal?: AbortSignal): Promise<{ gcid: string; sha256: string }> {
  const hash = new ContentHasher(size); let offset = 0n;
  while (offset < size) {
    if (signal?.aborted) throw signal.reason ?? Error("interrupted");
    const length = Number(size - offset < 65536n ? size - offset : 65536n);
    const bytes = await file.read(offset, length);
    if (!bytes.byteLength) throw Error("local-file-truncated");
    hash.update(bytes); offset += BigInt(bytes.byteLength);
  }
  if ((await file.info()).size !== size) throw Error("local-file-size-changed");
  return hash.digest();
}

export async function reconcilePublication(store: Store, accountId: string, file: FileRecord, workspace: FileWorkspace, signal?: AbortSignal): Promise<boolean> {
  const delivery = store.delivery(accountId, file.id), plan = store.deliveryPlan(accountId, file.id);
  if (!delivery?.sha256 || !delivery.volume || !delivery.identity || !plan) throw new AppError("needs_reconciliation");
  const target = await workspace.directory(plan.parent);
  let existing: LocalFile;
  try { existing = await target.file(plan.name, false, true); }
  catch (error) { if ((error as { code?: string }).code === "ENOENT") return false; throw error; }
  try {
    const info = await existing.info();
    if (!sameIdentity(info.identity, { volume: delivery.volume, file: delivery.identity }) || info.size !== file.size) throw new AppError("needs_reconciliation");
    const hash = await hashFile(existing, file.size, signal);
    if (hash.sha256 !== delivery.sha256 || hash.gcid !== file.gcid) throw new AppError("needs_reconciliation");
    await target.sync();
    store.completePublication(accountId, file.id, info.identity, hash.sha256);
    return true;
  } finally { await existing.close(); }
}

export async function publishVerified(store: Store, accountId: string, file: FileRecord, workspace: FileWorkspace, digest: { gcid: string; sha256: string },
  signal?: AbortSignal, afterPublish: () => Promise<void> = async () => {}): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? Error("interrupted");
  if (digest.gcid !== file.gcid) throw new AppError("needs_reconciliation");
  let plan = await workspace.prepare(file);
  store.planPublication(accountId, file.id, plan, await workspace.targetPath(plan), digest.sha256);
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (signal?.aborted) throw signal.reason ?? Error("interrupted");
    const source = await workspace.directory(plan.tempParent), target = await workspace.directory(plan.parent);
    const local = await source.file(plan.tempName, false, true);
    try {
      const current = await local.info(), expected = store.delivery(accountId, file.id)!;
      if (current.size !== file.size || !sameIdentity(current.identity, { volume: expected.volume!, file: expected.identity! })) throw new AppError("needs_reconciliation");
      const actual = await hashFile(local, file.size, signal);
      if (actual.sha256 !== digest.sha256 || actual.gcid !== file.gcid) throw new AppError("needs_reconciliation");
    } finally { await local.close(); }
    if (await source.publish(plan.tempName, target, plan.name)) {
      await afterPublish();
      if (!await reconcilePublication(store, accountId, file, workspace, signal)) throw new AppError("needs_reconciliation");
      return;
    }
    plan = await workspace.nextTarget(file, Number(store.delivery(accountId, file.id)!.publishAttempt));
    store.planPublication(accountId, file.id, plan, await workspace.targetPath(plan), digest.sha256);
  }
  throw Error("publication-conflict-limit");
}
