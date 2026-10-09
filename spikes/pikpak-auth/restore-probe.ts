import { randomUUID } from "node:crypto";
import { loadFixtureSession, VERIFICATION_SERVICE } from "./fixture-session";
import { ProbeError, requestJson, transport, type Transport } from "./protocol";

const BASE = "https://api-drive.mypikpak.com/drive/v1";
const KEY = "share-restore-probe.v1";
type Data = Record<string, unknown>;
type Journal = { version: 1; accountId: string; shareId: string; sourceId: string; operationId: string;
  stage: "intent" | "submitted" | "confirmed"; taskId?: string; destinationId?: string; restoreStatus?: string };
const isId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const object = (value: unknown): Data => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProbeError("restore-shape", "unexpected-response");
  return value as Data;
};
const size = (value: unknown): bigint => {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new ProbeError("quota", "invalid-integer");
};

export function mappedDestination(raw: Data, sourceId: string): string | null {
  const task = raw.task ? object(raw.task) : raw;
  const params = task.params ? object(task.params) : {};
  let mapping: unknown = params.trace_file_ids ?? task.trace_file_ids;
  if (typeof mapping === "string") {
    try { mapping = JSON.parse(mapping); } catch { mapping = null; }
  }
  if (mapping && typeof mapping === "object" && !Array.isArray(mapping)) {
    const destination = (mapping as Data)[sourceId];
    if (isId(destination)) return destination;
  }
  // file_id 可能指向结果目录或不属于当前源的对象；不能代替已实测的精确映射。
  return null;
}

export async function runRestoreProbe(
  input: Awaited<ReturnType<typeof loadFixtureSession>>,
  storage: { read(): Promise<string | null>; write(value: string): Promise<void> },
  http: Transport = transport,
  wait: (milliseconds: number) => Promise<unknown> = milliseconds => Bun.sleep(milliseconds),
) {
  const headers = { Authorization: `Bearer ${input.accessToken}`, "Content-Type": "application/json" };
  const old = await storage.read();
  let journal: Journal | undefined = old ? JSON.parse(old) as Journal : undefined;
  if (journal && (journal.version !== 1 || journal.accountId !== input.accountId || journal.shareId !== input.shareId
    || journal.sourceId !== input.selected.id || !["intent", "submitted", "confirmed"].includes(journal.stage)
    || (journal.taskId !== undefined && !isId(journal.taskId))
    || (journal.destinationId !== undefined && !isId(journal.destinationId)))) throw new ProbeError("restore-journal", "record-mismatch");
  if (journal?.stage === "intent") throw new ProbeError("restore", "previous-result-needs-reconciliation");
  const save = async () => storage.write(JSON.stringify(journal));
  let responseFields: string[] = [];
  let taskFields: string[] = [];
  let taskPhase = "not-polled";

  if (!journal) {
    const about = await requestJson("quota", `${BASE}/about`, { headers }, http);
    const quota = object(about.quota);
    const needed = BigInt(input.selected.size);
    const capacity = size(quota.limit);
    const used = size(quota.usage);
    if (needed > capacity || capacity - used < needed) throw new ProbeError("quota", "insufficient-space-no-cleanup");
    const accessQuery = new URLSearchParams({ share_id: input.shareId });
    if (input.passCode) accessQuery.set("pass_code", input.passCode);
    const access = await requestJson("share-access", `${BASE}/share?${accessQuery}`, { headers }, http);
    if (access.share_status !== "OK") throw new ProbeError("share-access", "share-not-accessible");
    const grant = typeof access.pass_code_token === "string" ? access.pass_code_token : "";
    const infoQuery = new URLSearchParams({ share_id: input.shareId, file_id: input.selected.id, pass_code_token: grant });
    const info = await requestJson("source-verification", `${BASE}/share/file_info?${infoQuery}`, { headers }, http);
    const file = object(info.file_info ?? info.file ?? info);
    if (file.id !== input.selected.id || size(file.size) !== needed || !input.selected.hash || file.hash !== input.selected.hash) {
      throw new ProbeError("source-verification", "source-changed-or-unverifiable");
    }
    journal = { version: 1, accountId: input.accountId, shareId: input.shareId, sourceId: input.selected.id,
      operationId: randomUUID(), stage: "intent" };
    await save();
    const restored = await requestJson("restore", `${BASE}/share/restore`, {
      method: "POST", headers, body: JSON.stringify({ share_id: input.shareId, pass_code_token: grant,
        file_ids: [input.selected.id], params: { trace_file_ids: input.selected.id } }),
    }, http);
    responseFields = ["restore_status", "restore_task_id", "task_id", "file_id", "params", "task", "files"]
      .filter(key => Object.hasOwn(restored, key));
    const taskId = restored.restore_task_id ?? restored.task_id;
    const destinationId = mappedDestination(restored, input.selected.id);
    if (isId(taskId)) journal.taskId = taskId;
    if (destinationId) journal.destinationId = destinationId;
    if (typeof restored.restore_status === "string" && /^[A-Z_]+$/.test(restored.restore_status)) journal.restoreStatus = restored.restore_status;
    journal.stage = "submitted";
    await save();
  }

  if (journal.taskId && journal.stage !== "confirmed") {
    for (let attempt = 0; attempt < 30; attempt++) {
      const raw = await requestJson("restore-task", `${BASE}/tasks/${encodeURIComponent(journal.taskId)}`, { headers }, http);
      const task = raw.task ? object(raw.task) : raw;
      taskFields = ["phase", "type", "file_id", "file_ids", "params", "result", "status", "error_code"]
        .filter(key => Object.hasOwn(task, key));
      taskPhase = typeof task.phase === "string" && /^[A-Z_]+$/.test(task.phase) ? task.phase : "unknown";
      const destinationId = mappedDestination(raw, input.selected.id);
      if (destinationId) {
        if (journal.destinationId && journal.destinationId !== destinationId) throw new ProbeError("restore-task", "conflicting-destination-mapping");
        journal.destinationId = destinationId; await save();
      }
      if (taskPhase === "PHASE_TYPE_ERROR") throw new ProbeError("restore-task", "task-failed");
      if (["PHASE_TYPE_COMPLETE", "PHASE_TYPE_COMPLETED"].includes(taskPhase)) break;
      if (attempt === 29) throw new ProbeError("restore-task", "task-still-pending");
      await wait(1000);
    }
  }

  let matchingFile = false;
  if (journal.destinationId && journal.destinationId !== journal.sourceId) {
    const raw = await requestJson("destination-verification", `${BASE}/files/${encodeURIComponent(journal.destinationId)}`, { headers }, http);
    const file = object(raw.file ?? raw);
    matchingFile = file.kind === "drive#file" && file.phase === "PHASE_TYPE_COMPLETE" && file.id === journal.destinationId
      && size(file.size) === BigInt(input.selected.size) && file.hash === input.selected.hash;
    if (matchingFile) { journal.stage = "confirmed"; await save(); }
  }
  return {
    restoreAccepted: true, restoreStatus: journal.restoreStatus ?? "unknown",
    responseFields, taskFields, taskPhase, hasTaskReference: !!journal.taskId,
    hasDestinationMapping: !!journal.destinationId, destinationIsDifferent: !!journal.destinationId && journal.destinationId !== journal.sourceId,
    destinationMetadataMatches: matchingFile, copyRetainedForFurtherVerification: true,
    fullG2Complete: false,
  };
}

async function main(): Promise<void> {
  const input = await loadFixtureSession();
  const report = await runRestoreProbe(input, {
    read: () => Bun.secrets.get({ service: VERIFICATION_SERVICE, name: KEY }),
    write: value => Bun.secrets.set({ service: VERIFICATION_SERVICE, name: KEY, value }),
  });
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.main) {
  try { await main(); }
  catch (error) {
    console.log(JSON.stringify({ lastError: error instanceof ProbeError
      ? { stage: error.stage, reason: error.reason, ...(error.status ? { status: error.status } : {}) }
      : { stage: "local", reason: "operation-failed" }, operationJournalPreserved: true, fullG2Complete: false }));
    process.exitCode = 1;
  }
}
