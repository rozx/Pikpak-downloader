import { ContentHasher } from "./gcid";
import { originalLink, secureDownloadUrl } from "./original-link";
import { ProbeError, transport, type Transport } from "./protocol";

export type ContentVersion = { id: string; size: bigint; gcid: string };
export function contentVersion(file: Record<string, unknown>): ContentVersion {
  if (typeof file.id !== "string" || !file.id || file.kind !== "drive#file" || file.phase !== "PHASE_TYPE_COMPLETE"
    || typeof file.size !== "string" || !/^\d+$/.test(file.size)
    || typeof file.hash !== "string" || !/^[a-f0-9]{40}$/i.test(file.hash)) {
    throw new ProbeError("integrity", "unverifiable-version");
  }
  return { id: file.id, size: BigInt(file.size), gcid: file.hash.toLowerCase() };
}

export function assertVersion(file: Record<string, unknown>, expected: ContentVersion): void {
  const actual = contentVersion(file);
  if (actual.id !== expected.id || actual.size !== expected.size || actual.gcid !== expected.gcid) {
    throw new ProbeError("integrity", "version-changed");
  }
}

// 隔离探针：只流式校验，不发布本地成果，也不授予云端清理资格。
export async function verifyTransfer(
  getMetadata: () => Promise<Record<string, unknown>>,
  expected: ContentVersion,
  http: Transport = transport,
  progress: (received: bigint) => void = () => {},
): Promise<{ gcid: string; sha256: string; ranges: number; refreshed: number }> {
  const hasher = new ContentHasher(expected.size);
  let received = 0n;
  let ranges = 0;
  let refreshed = 0;
  let file = await getMetadata();
  assertVersion(file, expected);
  while (received < expected.size) {
    if (ranges > 0) {
      file = await getMetadata();
      assertVersion(file, expected);
      refreshed++;
    }
    const start = received;
    const length = start === 0n ? 1048576n : 8388608n;
    const end = start + length < expected.size ? start + length - 1n : expected.size - 1n;
    let response: Response | undefined;
    // 只重试尚未消费正文的过期地址，且最多刷新一次。
    for (let attempt = 0; attempt < 2; attempt++) {
      const link = originalLink(file);
      const endpoint = link && secureDownloadUrl(link.url);
      if (!endpoint) throw new ProbeError("download", "original-https-link-unavailable");
      try {
        response = await http(endpoint.url.href, { headers: { Range: `bytes=${start}-${end}`, "Accept-Encoding": "identity" },
          redirect: "error", signal: AbortSignal.timeout(600_000) });
      } catch { throw new ProbeError("download", "network-error"); }
      if (response.status !== 401 && response.status !== 403) break;
      await response.body?.cancel();
      if (attempt === 1) throw new ProbeError("download", "url-refresh-exhausted");
      file = await getMetadata();
      assertVersion(file, expected);
      refreshed++;
    }
    if (!response) throw new ProbeError("download", "missing-response");
    if (response.status !== 206 || response.headers.get("content-range") !== `bytes ${start}-${end}/${expected.size}`
      || ![null, "identity"].includes(response.headers.get("content-encoding")) || !response.body) {
      await response.body?.cancel();
      throw new ProbeError("download", "invalid-range-response", response.status);
    }
    const reader = response.body.getReader();
    try {
      while (true) {
        const part = await reader.read().catch(() => { throw new ProbeError("download", "stream-failed"); });
        if (part.done) break;
        if (received + BigInt(part.value.byteLength) > end + 1n) throw new ProbeError("download", "excess-range-content");
        hasher.update(part.value);
        received += BigInt(part.value.byteLength);
        progress(received);
      }
    } finally { await reader.cancel().catch(() => {}); }
    if (received !== end + 1n) throw new ProbeError("download", "truncated-range-content");
    ranges++;
  }
  assertVersion(await getMetadata(), expected);
  const digest = hasher.digest();
  if (digest.gcid !== expected.gcid) throw new ProbeError("integrity", "gcid-mismatch");
  return { ...digest, ranges, refreshed };
}
