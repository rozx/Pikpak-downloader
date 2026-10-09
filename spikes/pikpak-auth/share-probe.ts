import { identity, ProbeError, requestJson, type Transport, transport } from "./protocol";

const SERVICE = "com.rozx.pikpak-downloader.verification";
const BASE = "https://api-drive.mypikpak.com/drive/v1";
export type Fixture = { accountId: string; shareId: string; passCode: string };
export type SelectedFile = { id: string; parentId: string; name: string; size: string; hash: string | null; depth: number };
type Inspection = { requests: number; pages: number; folders: number; files: number; nestedFiles: number;
  paginationObserved: boolean; scanComplete: boolean; selected: SelectedFile | null };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProbeError("share-shape", "unexpected-response");
  return value as Record<string, unknown>;
}
function safeId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function sizeString(value: unknown): string | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value).toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value).toString();
  return null;
}
function requireShareAccess(data: Record<string, unknown>): void {
  if (data.share_status !== "OK") throw new ProbeError("share-access", "share-not-accessible");
}

export async function inspectShare(fixture: Fixture, token: string, http: Transport = transport, requestLimit = 30): Promise<Inspection> {
  const headers = { Authorization: `Bearer ${token}` };
  const accessQuery = new URLSearchParams({ share_id: fixture.shareId, limit: "2" });
  if (fixture.passCode) accessQuery.set("pass_code", fixture.passCode);
  const access = await requestJson("share-access", `${BASE}/share?${accessQuery}`, { headers }, http);
  requireShareAccess(access);
  const grant = typeof access.pass_code_token === "string" ? access.pass_code_token : "";
  const result: Inspection = { requests: 1, pages: 0, folders: 0, files: 0, nestedFiles: 0,
    paginationObserved: false, scanComplete: true, selected: null };
  const pending = [{ parentId: "", depth: 0 }];
  const visitedFolders = new Set<string>();
  const visitedFiles = new Set<string>();
  while (pending.length) {
    const parent = pending.shift()!;
    const tokens = new Set<string>();
    let page = "";
    do {
      if (result.requests >= requestLimit) { result.scanComplete = false; return result; }
      if (tokens.has(page)) throw new ProbeError("share-pagination", "repeated-page-token");
      tokens.add(page);
      const query = new URLSearchParams({ share_id: fixture.shareId, pass_code_token: grant, page_token: page, limit: "2" });
      if (parent.parentId) query.set("parent_id", parent.parentId);
      result.requests++;
      const data = await requestJson("share-detail", `${BASE}/share/detail?${query}`, { headers }, http);
      requireShareAccess(data);
      if (!Array.isArray(data.files)) throw new ProbeError("share-detail", "file-list-missing");
      result.pages++;
      for (const value of data.files) {
        const file = object(value);
        if (!safeId(file.id) || typeof file.name !== "string") throw new ProbeError("share-detail", "invalid-file-metadata");
        if (file.kind === "drive#folder") {
          if (!visitedFolders.has(file.id)) {
            visitedFolders.add(file.id);
            result.folders++;
            pending.push({ parentId: file.id, depth: parent.depth + 1 });
          }
        } else if (file.kind === "drive#file" && !visitedFiles.has(file.id)) {
          visitedFiles.add(file.id);
          result.files++;
          if (parent.depth > 0) result.nestedFiles++;
          const size = sizeString(file.size);
          if (size !== null && (!result.selected || BigInt(size) < BigInt(result.selected.size))) {
            result.selected = { id: file.id, parentId: parent.parentId, name: file.name, size,
              hash: typeof file.hash === "string" && file.hash ? file.hash : null, depth: parent.depth };
          }
        } else if (file.kind !== "drive#file") throw new ProbeError("share-detail", "unsupported-entry-kind");
      }
      if (data.next_page_token !== undefined && typeof data.next_page_token !== "string") {
        throw new ProbeError("share-pagination", "invalid-page-token");
      }
      page = typeof data.next_page_token === "string" ? data.next_page_token : "";
      result.paginationObserved ||= !!page;
    } while (page);
  }
  return result;
}

async function main(): Promise<void> {
  const sessionRaw = await Bun.secrets.get({ service: SERVICE, name: "session.current" });
  const fixtureRaw = await Bun.secrets.get({ service: SERVICE, name: "share-fixture.v1" });
  if (!sessionRaw || !fixtureRaw) throw new ProbeError("fixture", "local-input-required");
  const session = object(JSON.parse(sessionRaw));
  const input = object(JSON.parse(fixtureRaw));
  if (typeof session.accountId !== "string" || typeof session.accessKey !== "string"
    || !/^session\.[0-9a-f-]{36}\.access$/.test(session.accessKey) || input.accountId !== session.accountId
    || !safeId(input.shareId) || typeof input.passCode !== "string" || input.version !== 1) {
    throw new ProbeError("fixture", "account-or-record-mismatch");
  }
  const access = await Bun.secrets.get({ service: SERVICE, name: session.accessKey });
  if (!access || await identity(access) !== session.accountId) throw new ProbeError("identity", "account-mismatch");
  const fixture: Fixture = { accountId: session.accountId, shareId: input.shareId, passCode: input.passCode };
  const result = await inspectShare(fixture, access);
  if (result.selected) {
    await Bun.secrets.set({ service: SERVICE, name: "share-selection.v1", value: JSON.stringify({
      version: 1, accountId: fixture.accountId, shareId: fixture.shareId, selected: result.selected,
      observedAt: Date.now(), scanComplete: result.scanComplete,
    }) });
  }
  console.log(JSON.stringify({
    shareAccess: "pass",
    requests: result.requests,
    pages: result.pages,
    folders: result.folders,
    files: result.files,
    nestedFiles: result.nestedFiles,
    paginationObserved: result.paginationObserved,
    scanComplete: result.scanComplete,
    selectedFileStored: !!result.selected,
    selectedFileIsNested: !!result.selected && result.selected.depth > 0,
    selectedFileHasHash: !!result.selected?.hash,
    fullG2Complete: false,
  }, null, 2));
}

if (import.meta.main) {
  try { await main(); }
  catch (error) {
    const lastError = error instanceof ProbeError ? { stage: error.stage, reason: error.reason,
      ...(error.status ? { status: error.status } : {}) } : { stage: "local", reason: "operation-failed" };
    console.log(JSON.stringify({ lastError, fullG2Complete: false }));
    process.exitCode = 1;
  }
}
