export type RestoreIntent = { taskId: string; shareId: string; sourceId: string; size: bigint; gcid: string; notBefore: string };
export type CreationEvidence = { taskId: string; taskCreatedAt: string; copyCreatedAt: string; sourceId: string;
  shareId: string; copyId: string; parentId: string; name: string; gcid: string; size: string; notBefore: string };
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export function timestamp(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return null;
  const local = Date.parse(`${parts[1]}Z`), millis = Date.parse(`${parts[1]}${parts[3]}`);
  if (!Number.isFinite(local) || !Number.isFinite(millis) || new Date(local).toISOString().slice(0, 19) !== parts[1]) return null;
  return BigInt(millis) * 1000000n + BigInt((parts[2] ?? "").padEnd(9, "0"));
}

export function mappedCopy(task: Record<string, unknown>, sourceId: string): string | null {
  let mapping = object(task.params)?.trace_file_ids;
  if (typeof mapping === "string") { try { mapping = JSON.parse(mapping); } catch { return null; } }
  const value = object(mapping)?.[sourceId];
  return id(value) ? value : null;
}

// 任务必须是本次请求返回并已持久化的任务；调用者另行排除已登记的旧结果。
// 时间不能单独证明归属，必须与任务、精确映射、原始来源和内容指纹同时核对。
export function creationEvidence(intent: RestoreIntent, task: Record<string, unknown>, file: Record<string, unknown>): CreationEvidence | null {
  const params = object(file.params);
  const taskTime = timestamp(task.created_time), copyTime = timestamp(file.created_time);
  const notBefore = timestamp(intent.notBefore);
  const size = typeof file.size === "string" && /^\d+$/.test(file.size) ? BigInt(file.size) : null;
  if (task.id !== intent.taskId || task.type !== "restore" || task.phase !== "PHASE_TYPE_COMPLETE"
    || !id(file.id) || file.id === intent.sourceId || mappedCopy(task, intent.sourceId) !== file.id
    || file.kind !== "drive#file" || file.phase !== "PHASE_TYPE_COMPLETE" || (file.trashed !== undefined && file.trashed !== false) || size !== intent.size
    || typeof file.hash !== "string" || file.hash.toLowerCase() !== intent.gcid
    || params?.original_file_id !== intent.sourceId || params?.original_share_id !== intent.shareId
    || taskTime === null || copyTime === null || notBefore === null || taskTime < notBefore || copyTime <= taskTime
    || typeof file.parent_id !== "string" || typeof file.name !== "string") return null;
  return { taskId: intent.taskId, taskCreatedAt: task.created_time as string, copyCreatedAt: file.created_time as string,
    sourceId: intent.sourceId, shareId: intent.shareId, copyId: file.id, parentId: file.parent_id, name: file.name,
    gcid: intent.gcid, size: intent.size.toString(), notBefore: intent.notBefore };
}

export function unchangedOwnedCopy(evidence: CreationEvidence, file: Record<string, unknown>): boolean {
  const params = object(file.params);
  return file.id === evidence.copyId && file.kind === "drive#file" && file.phase === "PHASE_TYPE_COMPLETE"
    && (file.trashed === undefined || file.trashed === false)
    && file.parent_id === evidence.parentId && file.name === evidence.name && timestamp(file.created_time) === timestamp(evidence.copyCreatedAt)
    && String(file.size) === evidence.size && typeof file.hash === "string" && file.hash.toLowerCase() === evidence.gcid
    && params?.original_file_id === evidence.sourceId && params?.original_share_id === evidence.shareId;
}
