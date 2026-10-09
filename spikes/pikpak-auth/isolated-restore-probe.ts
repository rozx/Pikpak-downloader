import { randomUUID } from "node:crypto";
import { loadFixtureSession, VERIFICATION_SERVICE } from "./fixture-session";
import { ProbeError, requestJson } from "./protocol";
import { mappedDestination } from "./restore-probe";

type Data = Record<string, unknown>;
const object = (value: unknown): Data => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProbeError("isolated-restore", "invalid-shape");
  return value as Data;
};
const isId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
type Journal = { version: 1; accountId: string; shareId: string; sourceId: string; folderName: string;
  stage: "creating-folder" | "folder-ready" | "restore-intent" | "submitted" | "confirmed";
  folderId?: string; destinationId?: string; taskId?: string };

async function main() {
  const input = await loadFixtureSession();
  const useRestore = process.argv.includes("--restore-endpoint");
  const key = { service: VERIFICATION_SERVICE, name: useRestore ? "isolated-restore-via-restore.v1" : "isolated-restore-probe.v1" };
  const raw = await Bun.secrets.get(key);
  let journal: Journal | null = raw ? JSON.parse(raw) as Journal : null;
  if (journal && (journal.accountId !== input.accountId || journal.shareId !== input.shareId || journal.sourceId !== input.selected.id
    || !journal.folderName.startsWith("pikpak-verification-isolated-") || (journal.folderId !== undefined && !isId(journal.folderId)))) throw new ProbeError("isolated-restore", "record-mismatch");
  const base = "https://api-drive.mypikpak.com/drive/v1";
  const headers = { Authorization: `Bearer ${input.accessToken}`, "Content-Type": "application/json" };
  const save = () => Bun.secrets.set({ ...key, value: JSON.stringify(journal) });
  const children = async (trashed: boolean) => {
    const query = new URLSearchParams({ parent_id: journal!.folderId!, limit: "10", filters: JSON.stringify({ trashed: { eq: trashed } }) });
    const data = await requestJson("isolated-list", `${base}/files?${query}`, { headers });
    if (!Array.isArray(data.files) || data.next_page_token) throw new ProbeError("isolated-restore", "unexpected-or-incomplete-children");
    return data.files.map(object);
  };
  if (journal?.stage === "creating-folder" || journal?.stage === "restore-intent") throw new ProbeError("isolated-restore", "previous-result-needs-reconciliation");
  if (!journal) {
    const quota = object((await requestJson("quota", `${base}/about`, { headers })).quota);
    if (typeof quota.limit !== "string" || typeof quota.usage !== "string" || !/^\d+$/.test(quota.limit) || !/^\d+$/.test(quota.usage)
      || BigInt(quota.limit) - BigInt(quota.usage) < BigInt(input.selected.size)) throw new ProbeError("quota", "insufficient-space-no-cleanup");
    journal = { version: 1, accountId: input.accountId, shareId: input.shareId, sourceId: input.selected.id,
      folderName: `pikpak-verification-isolated-${randomUUID()}`, stage: "creating-folder" };
    await save();
    const created = await requestJson("isolated-create", `${base}/files`, { method: "POST", headers,
      body: JSON.stringify({ kind: "drive#folder", name: journal.folderName, parent_id: "" }) });
    const folder = object(created.file ?? created);
    if (!isId(folder.id) || folder.kind !== "drive#folder" || folder.name !== journal.folderName) throw new ProbeError("isolated-restore", "folder-creation-not-confirmed");
    journal.folderId = folder.id; journal.stage = "folder-ready"; await save();
  }
  if (!journal.folderId) throw new ProbeError("isolated-restore", "folder-identity-required");
  const folder = await requestJson("isolated-folder", `${base}/files/${encodeURIComponent(journal.folderId)}`, { headers });
  const metadata = object(folder.file ?? folder);
  if (metadata.id !== journal.folderId || metadata.kind !== "drive#folder" || metadata.name !== journal.folderName) throw new ProbeError("isolated-restore", "folder-changed");
  if (journal.stage === "folder-ready") {
    if ((await children(false)).length || (await children(true)).length) throw new ProbeError("isolated-restore", "folder-not-empty");
    const query = new URLSearchParams({ share_id: input.shareId, pass_code: input.passCode });
    const access = await requestJson("share-access", `${base}/share?${query}`, { headers });
    if (access.share_status !== "OK") throw new ProbeError("share-access", "share-not-accessible");
    const grant = typeof access.pass_code_token === "string" ? access.pass_code_token : "";
    const sourceQuery = new URLSearchParams({ share_id: input.shareId, file_id: input.selected.id, pass_code_token: grant });
    const response = await requestJson("source", `${base}/share/file_info?${sourceQuery}`, { headers });
    const source = object(response.file_info ?? response.file ?? response);
    if (source.id !== input.selected.id || String(source.size) !== input.selected.size || source.hash !== input.selected.hash) throw new ProbeError("source", "version-changed");
    journal.stage = "restore-intent"; await save();
    const saved = await requestJson("isolated-save", `${base}${useRestore ? "/share/restore" : "/share:batch_save"}`, { method: "POST", headers,
      body: JSON.stringify({ share_id: input.shareId, pass_code_token: grant, file_ids: [input.selected.id], parent_id: journal.folderId,
        ...(useRestore ? { params: { trace_file_ids: input.selected.id } } : {}) }) });
    if (isId(saved.restore_task_id)) journal.taskId = saved.restore_task_id;
    journal.stage = "submitted"; await save();
    console.log(JSON.stringify({ isolatedRequestAccepted: true, responseFields: ["task_id", "restore_task_id", "file_ids", "files", "task"].filter(field => Object.hasOwn(saved, field)) }));
  }
  if (journal.taskId && journal.stage !== "confirmed") {
    for (let attempt = 0; attempt < 30; attempt++) {
      const raw = await requestJson("isolated-task", `${base}/tasks/${encodeURIComponent(journal.taskId)}`, { headers });
      const task = object(raw.task ?? raw);
      const destination = mappedDestination(raw, input.selected.id);
      if (destination) { journal.destinationId = destination; await save(); }
      if (task.phase === "PHASE_TYPE_COMPLETE") {
        if (!destination) throw new ProbeError("isolated-restore", "mapping-required");
        const rawFile = await requestJson("isolated-result", `${base}/files/${encodeURIComponent(destination)}`, { headers });
        const file = object(rawFile.file ?? rawFile);
        if (file.parent_id !== journal.folderId) throw new ProbeError("isolated-restore", "target-not-honored");
        break;
      }
      if (task.phase === "PHASE_TYPE_ERROR" || attempt === 29) throw new ProbeError("isolated-restore", "task-not-complete");
      await Bun.sleep(1000);
    }
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    const live = await children(false);
    if (live.length > 1 || (await children(true)).length) throw new ProbeError("isolated-restore", "unexpected-children");
    const file = live[0];
    if (file) {
      if (!isId(file.id) || file.id === input.selected.id || file.parent_id !== journal.folderId || file.kind !== "drive#file"
        || String(file.size) !== input.selected.size || file.hash !== input.selected.hash) throw new ProbeError("isolated-restore", "child-mismatch");
      if (file.phase === "PHASE_TYPE_COMPLETE") {
        journal.destinationId = file.id; journal.stage = "confirmed"; await save();
        console.log(JSON.stringify({ isolatedTargetHonored: true, exactlyOneMatchingFile: true, sourceAndCopyIndependent: true,
          createdFolderStillPresent: true, localDelivery: false, cleanupEligible: false })); return;
      }
    }
    await Bun.sleep(1000);
  }
  throw new ProbeError("isolated-restore", "result-pending");
}
try { await main(); }
catch (error) {
  console.log(JSON.stringify({ isolatedTargetHonored: false, journalPreserved: true, lastError: error instanceof ProbeError
    ? { stage: error.stage, reason: error.reason, ...(error.status ? { status: error.status } : {}) }
    : { stage: "local", reason: "operation-failed" } })); process.exitCode = 1;
}
