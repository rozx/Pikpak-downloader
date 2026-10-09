import { loadFixtureSession, VERIFICATION_SERVICE } from "./fixture-session";
import { assertVersion, contentVersion, verifyTransfer } from "./content-transfer";
import { ProbeError, requestJson } from "./protocol";

async function main(): Promise<void> {
  const input = await loadFixtureSession();
  const saved = await Bun.secrets.get({ service: VERIFICATION_SERVICE, name: "share-restore-probe.v1" });
  if (!saved) throw new ProbeError("download", "restore-not-verified");
  const journal = JSON.parse(saved) as Record<string, unknown>;
  if (journal.stage !== "confirmed" || journal.accountId !== input.accountId || journal.sourceId !== input.selected.id
    || journal.shareId !== input.shareId || typeof journal.destinationId !== "string"
    || !/^[A-Za-z0-9_-]{1,128}$/.test(journal.destinationId)) throw new ProbeError("download", "restore-record-mismatch");
  const expected = contentVersion({ id: journal.destinationId, kind: "drive#file", phase: "PHASE_TYPE_COMPLETE",
    size: input.selected.size, hash: input.selected.hash });
  const getMetadata = async () => {
    const response = await requestJson("download-metadata", `https://api-drive.mypikpak.com/drive/v1/files/${encodeURIComponent(String(journal.destinationId))}`, {
      headers: { Authorization: `Bearer ${input.accessToken}` },
    });
    const payload = response.file ?? response;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ProbeError("download", "invalid-file-shape");
    const file = payload as Record<string, unknown>;
    assertVersion(file, expected);
    return file;
  };
  let lastProgress = 0;
  const result = await verifyTransfer(getMetadata, expected, undefined, received => {
    if (Date.now() - lastProgress < 15_000) return;
    lastProgress = Date.now();
    console.log(JSON.stringify({ stage: "full-content", percent: Number(received * 100n / expected.size) }));
  });
  await Bun.secrets.set({ service: VERIFICATION_SERVICE, name: "content-probe.v1", value: JSON.stringify({
    version: 1, accountId: input.accountId, destinationId: expected.id, size: expected.size.toString(),
    ...result, verifiedAt: new Date().toISOString(), localDelivery: false,
  }) });
  console.log(JSON.stringify({ fullContentVerified: true, gcidMatches: true, localSha256Calculated: true,
    ranges: result.ranges, refreshed: result.refreshed, localDelivery: false, cleanupEligible: false }));
}

try { await main(); }
catch (error) {
  console.log(JSON.stringify({ fullContentVerified: false, lastError: error instanceof ProbeError
    ? { stage: error.stage, reason: error.reason, ...(error.status ? { status: error.status } : {}) }
    : { stage: "local", reason: "operation-failed" } }));
  process.exitCode = 1;
}
