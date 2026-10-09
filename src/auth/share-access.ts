import { randomUUID } from "node:crypto";
import { AppError } from "../errors";
import type { SecretStore } from "../platform/types";
import type { Store } from "../state/store";

export type ShareAccess = { version: 1; accountId: string; shareId: string; passCode: string };
const ownReference = (reference: string) => /^share\.[0-9a-f-]{36}$/.test(reference);
export async function loadShareAccess(secrets: SecretStore, reference: string, accountId: string, shareId: string): Promise<ShareAccess> {
  if (!ownReference(reference)) throw new AppError("share_access_required");
  const value = await secrets.get(reference);
  if (!value) throw new AppError("share_access_required");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new AppError("share_access_required"); }
  if (!parsed || typeof parsed !== "object") throw new AppError("share_access_required");
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || record.accountId !== accountId || record.shareId !== shareId || typeof record.passCode !== "string") {
    throw new AppError("share_access_required");
  }
  return record as ShareAccess;
}

export async function collectShareAccess(store: Store, secrets: SecretStore, reference: string): Promise<boolean> {
  if (!ownReference(reference) || store.secretReferenced(reference)) return false;
  await secrets.delete(reference);
  return true;
}

export async function acceptShare(store: Store, secrets: SecretStore, input: Omit<ShareAccess, "version"> & { outputRoot: string }) {
  const reference = `share.${randomUUID()}`;
  const old = store.findShare(input.accountId, input.shareId)?.secretRef;
  const record: ShareAccess = { version: 1, accountId: input.accountId, shareId: input.shareId, passCode: input.passCode };
  // 写入失败时新值也可能已经保存；没有 DB 引用时只能按精确的新引用回收。
  let committed = false;
  try {
    await secrets.set(reference, JSON.stringify(record));
    const share = store.accept(input.accountId, input.shareId, input.outputRoot, reference);
    committed = true;
    let cleanupPending = false;
    if (old) {
      try { await collectShareAccess(store, secrets, old); }
      catch { cleanupPending = true; }
    }
    return { share, cleanupPending };
  } finally {
    if (!committed) await collectShareAccess(store, secrets, reference).catch(() => {});
  }
}
