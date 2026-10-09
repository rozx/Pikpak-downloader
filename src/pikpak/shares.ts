import { collectShareAccess, loadShareAccess } from "../auth/share-access";
import type { SecretStore } from "../platform/types";
import type { Scan, Store } from "../state/store";
import type { PikpakClient } from "./client";
import { AppError } from "../errors";

export class ShareScanError extends Error {
  constructor(readonly code: "access_required" | "share_unavailable" | "invalid_metadata" | "pagination_loop" | "interrupted") {
    super(code); this.name = "ShareScanError";
  }
}
export function requireShareAccess(data: Record<string, unknown>): string {
  if (data.share_status === "PASS_CODE_EMPTY" || data.share_status === "PASS_CODE_ERROR") throw new ShareScanError("access_required");
  if (data.share_status !== "OK") throw new ShareScanError("share_unavailable");
  return typeof data.pass_code_token === "string" ? data.pass_code_token : "";
}
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function fileSize(value: unknown): bigint | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

export async function scanShare(store: Store, secrets: SecretStore, api: Pick<PikpakClient, "request">, scan: Scan, signal?: AbortSignal): Promise<{ files: number; issues: number; complete: boolean }> {
  const share = store.share(scan.accountId, scan.shareId);
  const init = signal ? { signal } : {};
  const interrupted = () => { if (signal?.aborted) throw new ShareScanError("interrupted"); };
  try {
    interrupted();
    const access = await loadShareAccess(secrets, scan.secretRef, scan.accountId, share.remoteId);
    const query = new URLSearchParams({ share_id: share.remoteId, pass_code: access.passCode });
    const root = await api.request(scan.accountId, `/drive/v1/share?${query}`, init);
    const grant = requireShareAccess(root);
    if (typeof root.title === "string") store.captureTitle(scan, root.title);
    store.queueDirectory(scan, "", []);
    let directory;
    while ((directory = store.nextDirectory(scan))) {
      store.startDirectory(scan, directory.remoteId);
      let page = "";
      do {
        interrupted();
        if (!store.observePage(scan, directory.remoteId, page)) throw new ShareScanError("pagination_loop");
        const parameters = new URLSearchParams({ share_id: share.remoteId, pass_code_token: grant, page_token: page, limit: "100" });
        if (directory.remoteId) parameters.set("parent_id", directory.remoteId);
        const data = await api.request(scan.accountId, `/drive/v1/share/detail?${parameters}`, init);
        interrupted(); requireShareAccess(data);
        if (!Array.isArray(data.files)) throw new ShareScanError("invalid_metadata");
        for (const [index, raw] of data.files.entries()) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ShareScanError("invalid_metadata");
          const file = raw as Record<string, unknown>;
          if (!validId(file.id)) { store.scanIssue(scan, `invalid-entry-${directory.remoteId}-${index}`, "invalid_metadata"); continue; }
          if (typeof file.name !== "string") { store.scanIssue(scan, file.id, "invalid_name"); continue; }
          const path = [...directory.path, { id: file.id, name: file.name }];
          if (file.kind === "drive#folder") store.queueDirectory(scan, file.id, path);
          else if (file.kind === "drive#file") {
            const size = fileSize(file.size);
            if (size === null || typeof file.hash !== "string" || !/^[a-f0-9]{40}$/i.test(file.hash)) {
              store.scanIssue(scan, file.id, "unverifiable_version"); continue;
            }
            store.mergeFile(scan, { sourceId: file.id, gcid: file.hash.toLowerCase(), size, relativePath: JSON.stringify(path) });
          } else store.scanIssue(scan, file.id, "unsupported_entry");
        }
        if (data.next_page_token !== undefined && typeof data.next_page_token !== "string") throw new ShareScanError("invalid_metadata");
        page = typeof data.next_page_token === "string" ? data.next_page_token : "";
      } while (page);
      store.finishDirectory(scan, directory.remoteId);
    }
    const issues = store.scanIssueCount(scan);
    store.finishScan(scan, issues === 0, issues ? "unverifiable_entries" : null);
    return { files: store.scanFileCount(scan), issues, complete: issues === 0 };
  } catch (error) {
    if (signal?.aborted || (error instanceof ShareScanError && error.code === "interrupted")) throw new ShareScanError("interrupted");
    // 认证/网络故障交给调度器分类；保留活动世代，可从未完成目录幂等重扫。
    if (error instanceof ShareScanError) store.finishScan(scan, false, error.code);
    else if (error instanceof AppError && error.code === "share_access_required") store.finishScan(scan, false, "access_required");
    throw error;
  } finally {
    await collectShareAccess(store, secrets, scan.secretRef).catch(() => {});
  }
}
