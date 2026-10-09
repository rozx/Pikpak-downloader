import { loadFixtureSession } from "./fixture-session";
import { ProbeError, requestJson } from "./protocol";
import { originalLink, secureDownloadUrl } from "./original-link";

async function main(): Promise<void> {
  const input = await loadFixtureSession();
  const anonymous = process.argv.includes("--anonymous");
  const headers: Record<string, string> = anonymous ? {} : { Authorization: `Bearer ${input.accessToken}` };
  const query = new URLSearchParams({ share_id: input.shareId });
  if (input.passCode) query.set("pass_code", input.passCode);
  const access = await requestJson("share-access", `https://api-drive.mypikpak.com/drive/v1/share?${query}`, { headers });
  if (access.share_status !== "OK") throw new ProbeError("share-access", "share-not-accessible");
  const details = new URLSearchParams({ share_id: input.shareId, file_id: input.selected.id,
    pass_code_token: typeof access.pass_code_token === "string" ? access.pass_code_token : "" });
  const response = await requestJson("share-file-info", `https://api-drive.mypikpak.com/drive/v1/share/file_info?${details}`, { headers });
  const payload = response.file_info ?? response.file ?? response;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ProbeError("share-file-info", "unexpected-response");
  }
  const file = payload as Record<string, unknown>;
  const selectedLink = originalLink(file);
  const link = selectedLink?.url ?? null;
  const result = { anonymousShareRequests: anonymous, originalLinkOffered: !!link, linkField: selectedLink?.source ?? null,
    metadataIdentityMatches: file.id === input.selected.id,
    sizeMatches: String(file.size) === input.selected.size,
    hashMatches: !!input.selected.hash && file.hash === input.selected.hash,
    downloadHostAccepted: false, upgradedToHttps: false, rangeResponseStatus: 0, rangeHeaderMatches: false,
    oneByteRead: false, fullFileVerified: false, cloudFilesCreated: 0 };
  if (link) {
    const endpoint = secureDownloadUrl(link);
    result.downloadHostAccepted = !!endpoint;
    result.upgradedToHttps = endpoint?.upgraded ?? false;
    if (endpoint && result.sizeMatches && result.hashMatches && result.metadataIdentityMatches
      && BigInt(input.selected.size) > 0n) {
      let content: Response;
      try {
        content = await fetch(endpoint.url, { headers: { Range: "bytes=0-0", "Accept-Encoding": "identity" },
          redirect: "error", signal: AbortSignal.timeout(20_000) });
      } catch { throw new ProbeError("direct-download", "network-error"); }
      result.rangeResponseStatus = content.status;
      result.rangeHeaderMatches = content.headers.get("content-range") === `bytes 0-0/${input.selected.size}`;
      if (content.status === 206 && result.rangeHeaderMatches && content.body) {
        const reader = content.body.getReader();
        try {
          const first = await reader.read();
          const second = first.value?.byteLength === 1 ? await reader.read() : null;
          result.oneByteRead = first.value?.byteLength === 1 && second?.done === true;
        } finally { await reader.cancel(); }
      } else { await content.body?.cancel(); }
    }
  }
  // 不输出直链、响应头、文件内容、文件名或任何账号标识。
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  try { await main(); }
  catch (error) {
    console.log(JSON.stringify({ lastError: error instanceof ProbeError
      ? { stage: error.stage, reason: error.reason, ...(error.status ? { status: error.status } : {}) }
      : { stage: "local", reason: "operation-failed" }, fullFileVerified: false }));
    process.exitCode = 1;
  }
}
