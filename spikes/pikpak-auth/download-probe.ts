import { loadFixtureSession, VERIFICATION_SERVICE } from "./fixture-session";
import { originalLink, secureDownloadUrl } from "./original-link";
import { ProbeError, requestJson } from "./protocol";

async function main(): Promise<void> {
  const input = await loadFixtureSession();
  const saved = await Bun.secrets.get({ service: VERIFICATION_SERVICE, name: "share-restore-probe.v1" });
  if (!saved) throw new ProbeError("download", "restore-not-verified");
  const journal = JSON.parse(saved) as Record<string, unknown>;
  if (journal.stage !== "confirmed" || journal.accountId !== input.accountId || journal.sourceId !== input.selected.id
    || journal.shareId !== input.shareId || typeof journal.destinationId !== "string"
    || !/^[A-Za-z0-9_-]{1,128}$/.test(journal.destinationId)) throw new ProbeError("download", "restore-record-mismatch");
  const getMetadata = async () => {
    const response = await requestJson("download-metadata", `https://api-drive.mypikpak.com/drive/v1/files/${encodeURIComponent(String(journal.destinationId))}`, {
      headers: { Authorization: `Bearer ${input.accessToken}` },
    });
    const payload = response.file ?? response;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ProbeError("download", "invalid-file-shape");
    const file = payload as Record<string, unknown>;
    if (file.id !== journal.destinationId || file.kind !== "drive#file" || String(file.size) !== input.selected.size
      || file.hash !== input.selected.hash || file.phase !== "PHASE_TYPE_COMPLETE") throw new ProbeError("download", "metadata-changed");
    return file;
  };
  const before = await getMetadata();
  const selected = originalLink(before);
  const report = { originalLinkPresent: !!selected, linkField: selected?.source ?? null,
    md5FieldPresent: typeof before.md5_checksum === "string" && /^[a-f0-9]{32}$/i.test(before.md5_checksum),
    gcidFieldPresent: typeof before.hash === "string" && /^[a-f0-9]{40}$/i.test(before.hash),
    hostAccepted: false, upgradedToHttps: false, httpStatus: 0, rangeHeaderMatches: false, receivedExpectedRange: false,
    metadataStableAfterRead: false, fullContentVerified: false };
  if (selected) {
    const endpoint = secureDownloadUrl(selected.url);
    report.hostAccepted = !!endpoint;
    report.upgradedToHttps = endpoint?.upgraded ?? false;
    if (endpoint && BigInt(input.selected.size) > 0n) {
      const length = Number(BigInt(input.selected.size) < 1024n ? BigInt(input.selected.size) : 1024n);
      let response: Response;
      try {
        response = await fetch(endpoint.url, { headers: { Range: `bytes=0-${length - 1}`, "Accept-Encoding": "identity" },
          redirect: "error", signal: AbortSignal.timeout(20_000) });
      } catch { throw new ProbeError("download-range", "network-error"); }
      report.httpStatus = response.status;
      report.rangeHeaderMatches = response.headers.get("content-range") === `bytes 0-${length - 1}/${input.selected.size}`;
      if (response.status === 206 && report.rangeHeaderMatches && response.body) {
        const reader = response.body.getReader();
        let received = 0;
        let finished = false;
        try {
          while (received <= length) {
            const part = await reader.read();
            if (part.done) { finished = true; break; }
            received += part.value.byteLength;
          }
        } finally { await reader.cancel(); }
        report.receivedExpectedRange = finished && received === length;
      } else { await response.body?.cancel(); }
      await getMetadata();
      report.metadataStableAfterRead = true;
    }
  }
  console.log(JSON.stringify(report, null, 2));
}

try { await main(); }
catch (error) {
  console.log(JSON.stringify({ lastError: error instanceof ProbeError
    ? { stage: error.stage, reason: error.reason, ...(error.status ? { status: error.status } : {}) }
    : { stage: "local", reason: "operation-failed" }, fullContentVerified: false }));
  process.exitCode = 1;
}
