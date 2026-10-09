import { AppError } from "../errors";
import type { PikpakClient } from "./client";
import { ProviderError } from "./protocol";

export type RemoteFile = { id: string; parentId: string; name: string; size: bigint; gcid: string; raw: Record<string, unknown> };
export const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("needs_reconciliation");
  return value as Record<string, unknown>;
}
export function integer(value: unknown): bigint {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new AppError("needs_reconciliation");
}
export function remoteFile(value: Record<string, unknown>): RemoteFile {
  if (!validId(value.id) || value.kind !== "drive#file" || value.phase !== "PHASE_TYPE_COMPLETE" || typeof value.parent_id !== "string"
    || typeof value.name !== "string" || typeof value.hash !== "string" || !/^[a-f0-9]{40}$/i.test(value.hash)) throw new AppError("needs_reconciliation");
  const size = integer(value.size); const gcid = value.hash.toLowerCase();
  return { id: value.id, parentId: value.parent_id, name: value.name, size, gcid, raw: { ...value, size: size.toString(), hash: gcid } };
}
export class Drive {
  constructor(readonly api: Pick<PikpakClient, "request">, readonly accountId: string) {}
  async quota(signal?: AbortSignal) {
    const data = await this.api.request(this.accountId, "/drive/v1/about", signal ? { signal } : {});
    const quota = object(data.quota); const limit = integer(quota.limit), usage = integer(quota.usage);
    return { limit, usage, free: usage >= limit ? 0n : limit - usage };
  }
  async metadata(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!validId(id)) throw new AppError("needs_reconciliation");
    const raw = await this.api.request(this.accountId, `/drive/v1/files/${encodeURIComponent(id)}`, signal ? { signal } : {});
    const file = object(raw.file ?? raw);
    if (file.id !== id) throw new AppError("needs_reconciliation"); return file;
  }
  async file(id: string, signal?: AbortSignal): Promise<RemoteFile> { return remoteFile(await this.metadata(id, signal)); }
  async task(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!validId(id)) throw new AppError("needs_reconciliation");
    const raw = await this.api.request(this.accountId, `/drive/v1/tasks/${encodeURIComponent(id)}`, signal ? { signal } : {});
    const task = object(raw.task ?? raw);
    if (task.id !== id) throw new AppError("needs_reconciliation"); return task;
  }
}
// 不把普通 not_found/403 当作确定丢失；只有明确的文件不存在类别可触发有界重建。
export const definitelyMissing = (error: unknown): boolean => error instanceof ProviderError && error.status === 404 && error.reason === "file_not_found";
