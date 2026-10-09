import { randomUUID } from "node:crypto";
import { assertVersion, contentVersion } from "./content-transfer";
import { loadFixtureSession, VERIFICATION_SERVICE } from "./fixture-session";
import { ProbeError, requestJson } from "./protocol";

// 仅修改已有受保护转存记录指向的测试副本；保存恢复意图后才发请求。
async function main(): Promise<void> {
  const input = await loadFixtureSession();
  const raw = await Bun.secrets.get({ service: VERIFICATION_SERVICE, name: "share-restore-probe.v1" });
  if (!raw) throw new ProbeError("rename", "restore-record-required");
  const restore = JSON.parse(raw) as Record<string, unknown>;
  if (restore.stage !== "confirmed" || restore.accountId !== input.accountId || restore.shareId !== input.shareId
    || restore.sourceId !== input.selected.id || typeof restore.destinationId !== "string"
    || !/^[A-Za-z0-9_-]{1,128}$/.test(restore.destinationId)) throw new ProbeError("rename", "restore-record-mismatch");
  const endpoint = `https://api-drive.mypikpak.com/drive/v1/files/${encodeURIComponent(restore.destinationId)}`;
  const headers = { Authorization: `Bearer ${input.accessToken}`, "Content-Type": "application/json" };
  const expected = contentVersion({ id: restore.destinationId, kind: "drive#file", phase: "PHASE_TYPE_COMPLETE",
    hash: input.selected.hash, size: input.selected.size });
  const get = async () => {
    const response = await requestJson("rename-read", endpoint, { headers });
    const value = response.file ?? response;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProbeError("rename", "invalid-file");
    const file = value as Record<string, unknown>;
    assertVersion(file, expected);
    if (typeof file.name !== "string") throw new ProbeError("rename", "missing-name");
    return { ...file, name: file.name };
  };
  const key = { service: VERIFICATION_SERVICE, name: "rename-probe.v1" };
  const previous = await Bun.secrets.get(key);
  type Journal = { accountId: string; destinationId: string; original: string; temporary: string;
    stage: "intent" | "renamed" | "restoring" | "complete" };
  let journal: Journal;
  if (previous) {
    journal = JSON.parse(previous) as Journal;
    if (journal.accountId !== input.accountId || journal.destinationId !== expected.id
      || typeof journal.original !== "string" || typeof journal.temporary !== "string"
      || !journal.temporary.startsWith("pikpak-verification-rename-")
      || !["intent", "renamed", "restoring", "complete"].includes(journal.stage)) throw new ProbeError("rename", "journal-mismatch");
  } else {
    const initial = await get();
    if (initial.name !== input.selected.name) throw new ProbeError("rename", "test-copy-already-renamed");
    journal = { accountId: input.accountId, destinationId: expected.id, original: initial.name,
      temporary: `pikpak-verification-rename-${randomUUID()}`, stage: "intent" };
    await Bun.secrets.set({ ...key, value: JSON.stringify(journal) });
    try { await requestJson("rename-write", endpoint, { method: "PATCH", headers, body: JSON.stringify({ name: journal.temporary }) }); }
    catch { /* 可能已执行，按精确 ID 和两种已知名字核对，不重发。 */ }
  }
  const current = await get();
  if (journal.stage === "complete") {
    if (current.name !== journal.original) throw new ProbeError("rename", "name-changed-after-probe");
    console.log(JSON.stringify({ renameVerified: true, versionStable: true, originalNameRestored: true, replayedReadOnly: true }));
    return;
  }
  if (current.name === journal.temporary) {
    journal.stage = "restoring";
    await Bun.secrets.set({ ...key, value: JSON.stringify(journal) });
    try { await requestJson("rename-restore", endpoint, { method: "PATCH", headers, body: JSON.stringify({ name: journal.original }) }); }
    catch { /* 读取已保存的精确目标核对恢复结果。 */ }
    const restored = await get();
    if (restored.name !== journal.original) throw new ProbeError("rename", "restoration-needs-reconciliation");
  } else if (journal.stage !== "restoring" || current.name !== journal.original) {
    throw new ProbeError("rename", "rename-not-confirmed-or-user-change");
  }
  journal.stage = "complete";
  await Bun.secrets.set({ ...key, value: JSON.stringify(journal) });
  console.log(JSON.stringify({ renameVerified: true, versionStable: true, originalNameRestored: true, cleanupEligible: false }));
}

try { await main(); }
catch (error) {
  console.log(JSON.stringify({ renameVerified: false, journalPreserved: true, lastError: error instanceof ProbeError
    ? { stage: error.stage, reason: error.reason, ...(error.status ? { status: error.status } : {}) }
    : { stage: "local", reason: "operation-failed" } }));
  process.exitCode = 1;
}
