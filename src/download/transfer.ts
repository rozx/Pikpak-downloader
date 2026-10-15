import type { Store, FileRecord, CopyRecord } from "../state/store";
import type { LocalFile } from "../platform/files";
import type { RemoteFile } from "../pikpak/drive";
import { ContentHasher } from "./gcid";
import { originalLink, secureDownloadUrl } from "./original-link";
import { hashFile, publishVerified } from "./publish";
import type { FileWorkspace } from "./workspace";
import { retryAfter } from "../pikpak/protocol";

import { DownloadError } from "./download-error";
export { DownloadError } from "./download-error";
import type { DownloadTransport } from "./range-worker";
export type { DownloadTransport } from "./range-worker";
async function prefix(file: LocalFile, size: bigint, bytes: bigint, signal?: AbortSignal): Promise<ContentHasher> {
  const hash = new ContentHasher(size); let offset = 0n;
  while (offset < bytes) {
    if (signal?.aborted) throw signal.reason ?? Error("interrupted");
    const chunk = await file.read(offset, Number(bytes - offset < 65536n ? bytes - offset : 65536n));
    if (!chunk.byteLength) throw new DownloadError("truncated_content");
    hash.update(chunk); offset += BigInt(chunk.byteLength);
  }
  return hash;
}
export async function remainingBytes(store: Store, accountId: string, file: FileRecord, workspace: FileWorkspace, signal?: AbortSignal): Promise<bigint> {
  const local = await workspace.temporary(file);
  try {
    const delivery = store.delivery(accountId, file.id)!; const info = await local.info();
    if (delivery.checkpoint > 0n && delivery.checkpoint <= file.size && info.size >= delivery.checkpoint && delivery.prefixSha256) {
      const hash = await prefix(local, file.size, delivery.checkpoint, signal);
      if (hash.prefixDigest() === delivery.prefixSha256) {
        if (info.size > delivery.checkpoint) { await local.truncate(delivery.checkpoint); await local.sync(); }
        return file.size - delivery.checkpoint;
      }
    }
    await local.truncate(0n); await local.sync();
    store.checkpoint(accountId, file.id, 0n, new ContentHasher(file.size).prefixDigest());
    return file.size;
  } finally { await local.close(); }
}

export async function download(store: Store, accountId: string, file: FileRecord, copy: CopyRecord, workspace: FileWorkspace,
  metadata: () => Promise<RemoteFile>, signal: AbortSignal, progress: (bytes: bigint) => void = () => {},
  http: DownloadTransport = (url, init) => fetch(url, init)): Promise<void> {
  if (signal.aborted) throw signal.reason ?? Error("interrupted");
  const check = async () => {
    const value = await metadata();
    if (value.id !== copy.remoteId || value.size !== file.size || value.gcid !== file.gcid) throw new DownloadError("version_changed");
    return value;
  };
  let remote = await check();
  const local = await workspace.temporary(file);
  let offset = 0n, hasher = new ContentHasher(file.size), checkpoint = 0n;
  let closed = false;
  const save = async () => {
    await local.sync(); store.checkpoint(accountId, file.id, offset, hasher.prefixDigest()); checkpoint = offset;
  };
  try {
    const delivery = store.delivery(accountId, file.id)!;
    const info = await local.info();
    if (delivery.checkpoint > 0n && delivery.checkpoint <= file.size && info.size >= delivery.checkpoint && delivery.prefixSha256) {
      hasher = await prefix(local, file.size, delivery.checkpoint, signal);
      if (hasher.prefixDigest() === delivery.prefixSha256) offset = delivery.checkpoint;
      else hasher = new ContentHasher(file.size);
    }
    await local.truncate(offset);
    if (store.file(accountId, file.id).state !== "downloading") store.transition(accountId, file.id, "downloading");
    await save();
    // 每段重新核对版本与下载地址，只有一个在途下载连接。
    let addressRetries = 0, rangeRestarts = 0;
    while (offset < file.size) {
      if (signal.aborted) throw signal.reason ?? Error("interrupted");
      remote = await check();
      const link = originalLink(remote.raw), endpoint = link && secureDownloadUrl(link.url);
      if (!endpoint) throw new DownloadError("unsupported_download_url");
      const end = offset + 8388608n < file.size ? offset + 8388607n : file.size - 1n;
      let response: Response;
      const stalled = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => stalled.abort(), 20000);
      try {
        response = await http(endpoint.url.href, { headers: { Range: `bytes=${offset}-${end}`, "Accept-Encoding": "identity" }, redirect: "error",
          signal: AbortSignal.any([signal, stalled.signal]) });
      } catch { throw new DownloadError("network_failure"); }
      finally { clearTimeout(timer); timer = undefined; }
      if (response.status === 429 || response.status === 402) {
        await response.body?.cancel();
        throw new DownloadError(response.status === 429 ? "rate_limited" : "traffic_quota", retryAfter(response.headers.get("retry-after")));
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        if (++addressRetries > 2) throw new DownloadError("url_refresh_exhausted");
        continue;
      }
      const validRange = response.status === 206 && response.headers.get("content-range") === `bytes ${offset}-${end}/${file.size}`;
      const fullResponse = offset === 0n && response.status === 200;
      if ((!validRange && !fullResponse) || !response.body || ![null, "identity"].includes(response.headers.get("content-encoding"))) {
        await response.body?.cancel();
        if (offset > 0n && (response.status === 200 || response.status === 206) && ++rangeRestarts <= 1) {
          offset = 0n; hasher = new ContentHasher(file.size); await local.truncate(0n); await save(); continue;
        }
        throw new DownloadError("range_mismatch");
      }
      const stop = fullResponse ? file.size : end + 1n;
      const reader = response.body.getReader();
      try {
        while (true) {
          timer = setTimeout(() => stalled.abort(), 60000);
          const part = await reader.read().catch(() => { throw new DownloadError("network_failure"); }).finally(() => { clearTimeout(timer); timer = undefined; });
          if (part.done) break;
          if (signal.aborted) throw signal.reason ?? Error("interrupted");
          if (offset + BigInt(part.value.byteLength) > stop) throw new DownloadError("range_mismatch");
          await local.write(offset, part.value); hasher.update(part.value); offset += BigInt(part.value.byteLength); progress(offset);
          if (offset - checkpoint >= 1048576n) await save();
        }
      } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); }
      if (offset !== stop) throw new DownloadError("truncated_content");
      await save(); addressRetries = 0;
    }
    await check(); await save();
    const digest = hasher.digest();
    if (digest.gcid !== file.gcid) throw new DownloadError("integrity_mismatch");
    store.transition(accountId, file.id, "verifying");
    const readBack = await hashFile(local, file.size, signal);
    if (readBack.gcid !== file.gcid || readBack.sha256 !== digest.sha256) throw new DownloadError("integrity_mismatch");
    await local.sync(); await local.close(); closed = true;
    await publishVerified(store, accountId, file, workspace, digest, signal);
  } catch (error) {
    if (!closed && error instanceof DownloadError && error.code === "integrity_mismatch") {
      offset = 0n; hasher = new ContentHasher(file.size); await local.truncate(0n);
      if (store.file(accountId, file.id).state === "verifying") store.transition(accountId, file.id, "downloading");
      await save();
    }
    if (!closed && store.file(accountId, file.id).state === "downloading") {
      // 仅已完整写入并进入摘要的前缀可成为检查点。
      await save().catch(() => {});
    }
    throw error;
  } finally { if (!closed) await local.close(); }
}
