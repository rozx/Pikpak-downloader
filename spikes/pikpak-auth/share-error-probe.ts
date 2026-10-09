import { loadFixtureSession } from "./fixture-session";

try {
  const input = await loadFixtureSession();
  const results = [];
  for (const passCode of ["", "synthetic-invalid-code"]) {
    const query = new URLSearchParams({ share_id: input.shareId, pass_code: passCode });
    const response = await fetch(`https://api-drive.mypikpak.com/drive/v1/share?${query}`, {
      headers: { Authorization: `Bearer ${input.accessToken}` }, redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    const value = await response.json() as Record<string, unknown>;
    const enumeration = (raw: unknown) => typeof raw === "string" && /^[a-zA-Z_]{3,64}$/.test(raw)
      && /(pass|share|code|invalid|error|not_found)/i.test(raw) ? raw : null;
    results.push({ input: passCode ? "synthetic-invalid-code" : "missing-code", httpStatus: response.status,
      error: enumeration(value.error), shareStatus: enumeration(value.share_status),
      numericErrorCode: typeof value.error_code === "number" && Number.isSafeInteger(value.error_code) ? value.error_code : null });
  }
  console.log(JSON.stringify({ readOnlyErrorContract: results }));
} catch { console.log(JSON.stringify({ readOnlyErrorContract: false })); process.exitCode = 1; }
