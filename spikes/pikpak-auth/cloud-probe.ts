import { randomUUID } from "node:crypto";
import { identity, ProbeError, type Transport, transport } from "./protocol";

const SERVICE = "com.rozx.pikpak-downloader.verification";
const JOURNAL = "cloud-empty-folder-probe.v1";
const BASE = "https://api-drive.mypikpak.com/drive/v1";
type Role = "target" | "sentinel";
export type Receipt = { role: Role; id: string; name: string; parentId: string; state: "created" | "deleting" | "deleted" };
type Journal = { version: 1; accountId: string; runId: string; folders: Receipt[]; pendingCreate?: Role;
  targetAbsent: boolean; sentinelPreserved: boolean };
type Json = Record<string, unknown>;

function record(value: unknown, stage: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProbeError(stage, "unexpected-response");
  return value as Json;
}
function folderRecord(data: Json): Json { return record(data.file ?? data, "folder-info"); }
function validId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value); }

export function assertOwnedEmpty(receipt: Receipt, value: unknown, liveChildren: unknown, trashedChildren: unknown): void {
  const file = record(value, "ownership");
  if (file.id !== receipt.id || file.name !== receipt.name || file.kind !== "drive#folder"
    || (file.parent_id ?? "") !== receipt.parentId) throw new ProbeError("ownership", "resource-changed");
  for (const result of [liveChildren, trashedChildren]) {
    const children = record(result, "ownership");
    if (!Array.isArray(children.files) || children.files.length || children.next_page_token) {
      throw new ProbeError("ownership", "folder-not-confirmed-empty");
    }
  }
}

export function safeProviderCode(data: Json): string {
  const permitted = new Set(["permission_denied", "insufficient_scope", "unauthorized", "invalid_token", "not_found", "file_not_found"]);
  return typeof data.error === "string" && permitted.has(data.error) ? data.error : "provider-error";
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") throw new ProbeError("platform", "credential-adapter-not-verified");
  const raw = await Bun.secrets.get({ service: SERVICE, name: "session.current" });
  if (!raw) throw new ProbeError("session", "login-required");
  const session = record(JSON.parse(raw), "session");
  if (typeof session.accessKey !== "string" || !/^session\.[0-9a-f-]{36}\.access$/.test(session.accessKey)
    || typeof session.accountId !== "string") throw new ProbeError("session", "invalid-session-reference");
  const access = await Bun.secrets.get({ service: SERVICE, name: session.accessKey });
  if (!access) throw new ProbeError("session", "login-required");
  const accountId = await identity(access);
  if (accountId !== session.accountId) throw new ProbeError("identity", "account-mismatch");

  const old = await Bun.secrets.get({ service: SERVICE, name: JOURNAL });
  const journal: Journal = old ? JSON.parse(old) as Journal
    : { version: 1, accountId, runId: randomUUID(), folders: [], targetAbsent: false, sentinelPreserved: false };
  if (journal.version !== 1 || journal.accountId !== accountId || !/^[0-9a-f-]{36}$/.test(journal.runId)
    || !Array.isArray(journal.folders) || journal.folders.length > 2) throw new ProbeError("journal", "invalid-record");
  const roles = new Set<Role>();
  for (const receipt of journal.folders) {
    if (!["target", "sentinel"].includes(receipt.role) || roles.has(receipt.role) || !validId(receipt.id)
      || receipt.name !== `.PikpakDownloader-G1-${receipt.role}-${journal.runId}`
      || typeof receipt.parentId !== "string" || !["created", "deleting", "deleted"].includes(receipt.state)) {
      throw new ProbeError("journal", "invalid-receipt");
    }
    roles.add(receipt.role);
  }
  const save = async () => Bun.secrets.set({ service: SERVICE, name: JOURNAL, value: JSON.stringify(journal) });
  const reply = async (stage: string, path: string, method = "GET", body?: Json) => {
    let response: Response;
    try {
      response = await transport(`${BASE}${path}`, { method, redirect: "error", signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new ProbeError(stage, "network-result-unknown"); }
    const text = await response.text();
    let data: Json;
    try { data = text ? record(JSON.parse(text), stage) : {}; }
    catch { throw new ProbeError(stage, "non-json-response", response.status); }
    return { status: response.status, ok: response.ok && !data.error && !data.error_code, data };
  };
  const requireSuccess = (result: Awaited<ReturnType<typeof reply>>, stage: string): Json => {
    if (!result.ok) throw new ProbeError(stage, safeProviderCode(result.data), result.status);
    return result.data;
  };
  const inspect = async (receipt: Receipt) => reply("folder-info", `/files/${encodeURIComponent(receipt.id)}`);
  const absent = (result: Awaited<ReturnType<typeof reply>>) => result.status === 404
    && ["not_found", "file_not_found"].includes(String(result.data.error));

  if (journal.pendingCreate) throw new ProbeError("creation", "previous-result-needs-reconciliation");
  let lastError: ReturnType<typeof publicError> | null = null;
  try {
    for (const role of ["target", "sentinel"] as const) {
      if (journal.folders.some(item => item.role === role)) continue;
      const name = `.PikpakDownloader-G1-${role}-${journal.runId}`;
      journal.pendingCreate = role;
      await save();
      const response = await reply(`create-${role}`, "/files", "POST", { kind: "drive#folder", name, parent_id: "" });
      const file = folderRecord(requireSuccess(response, `create-${role}`));
      if (!validId(file.id) || file.name !== name || file.kind !== "drive#folder"
        || (file.parent_id !== undefined && file.parent_id !== null && typeof file.parent_id !== "string")) {
        throw new ProbeError("creation", "unexpected-created-resource");
      }
      journal.folders.push({ role, id: file.id, name, parentId: typeof file.parent_id === "string" ? file.parent_id : "", state: "created" });
      delete journal.pendingCreate;
      await save();
    }

    const remove = async (receipt: Receipt) => {
      if (receipt.state === "deleted") return;
      const current = await inspect(receipt);
      if (receipt.state === "deleting" && absent(current)) {
        receipt.state = "deleted"; await save(); return;
      }
      const file = folderRecord(requireSuccess(current, "before-delete"));
      const children = [];
      for (const trashed of [false, true]) {
        const query = new URLSearchParams({ parent_id: receipt.id, limit: "2", filters: JSON.stringify({ trashed: { eq: trashed } }) });
        children.push(requireSuccess(await reply("check-empty", `/files?${query}`), "check-empty"));
      }
      assertOwnedEmpty(receipt, file, children[0], children[1]);
      receipt.state = "deleting";
      await save();
      requireSuccess(await reply("permanent-delete", "/files:batchDelete", "POST", { ids: [receipt.id] }), "permanent-delete");
      const after = await inspect(receipt);
      if (!absent(after)) throw new ProbeError("delete-verification", "absence-not-confirmed", after.status);
      receipt.state = "deleted";
      await save();
    };

    const target = journal.folders.find(item => item.role === "target")!;
    const sentinel = journal.folders.find(item => item.role === "sentinel")!;
    await remove(target);
    journal.targetAbsent = target.state === "deleted";
    if (!journal.sentinelPreserved) {
      const info = folderRecord(requireSuccess(await inspect(sentinel), "sentinel-verification"));
      if (info.id !== sentinel.id || info.name !== sentinel.name) throw new ProbeError("sentinel-verification", "resource-changed");
      journal.sentinelPreserved = true;
      await save();
    }
    await remove(sentinel);
  } catch (error) {
    lastError = publicError(error);
  }
  console.log(JSON.stringify({
    identityMatched: true,
    temporaryFoldersCreated: journal.folders.length,
    targetAbsent: journal.targetAbsent,
    sentinelPreserved: journal.sentinelPreserved,
    remainingTemporaryFolders: journal.folders.filter(item => item.state !== "deleted").length,
    creationNeedsReconciliation: !!journal.pendingCreate,
    lastError,
    fullG1Complete: false,
  }, null, 2));
  if (lastError) process.exitCode = 1;
}

function publicError(error: unknown): { stage: string; reason: string; status?: number } {
  if (error instanceof ProbeError) return { stage: error.stage, reason: error.reason,
    ...(error.status ? { status: error.status } : {}) };
  return { stage: "local", reason: "operation-failed" };
}

if (import.meta.main) {
  try { await main(); }
  catch (error) { console.log(JSON.stringify({ lastError: publicError(error), fullG1Complete: false })); process.exitCode = 1; }
}
