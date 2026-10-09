import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFixtureSession } from "./fixture-session";
import { MacSecrets } from "../../src/auth/secrets";
import { SessionManager } from "../../src/auth/session";
import { acceptShare } from "../../src/auth/share-access";
import { Store } from "../../src/state/store";
import { PikpakClient } from "../../src/pikpak/client";
import { scanShare } from "../../src/pikpak/shares";

async function main() {
  const input = await loadFixtureSession();
  const directory = await mkdtemp(join(tmpdir(), "pikpak-production-scan-"));
  const secrets = new MacSecrets(); const store = new Store(join(directory, "tasks.sqlite"));
  let reference: string | undefined;
  try {
    store.ensureAccount(input.accountId);
    const accepted = await acceptShare(store, secrets, { accountId: input.accountId, shareId: input.shareId, passCode: input.passCode, outputRoot: directory });
    reference = accepted.share.secretRef;
    const api = new PikpakClient(new SessionManager(secrets, undefined, account => store.pause(account, "authentication")), store);
    const scan = store.claimScan(input.accountId, accepted.share.id)!;
    const result = await scanShare(store, secrets, api, scan);
    console.log(JSON.stringify({ productionScan: true, fileVersions: result.files, issues: result.issues, complete: result.complete, cloudWrite: false }));
  } finally {
    store.close(); await rm(directory, { recursive: true, force: true });
    // 临时任务库已整体清理，此精确引用只由本次临时库持有。
    if (reference) await secrets.delete(reference);
  }
}
try { await main(); }
catch { console.log(JSON.stringify({ productionScan: false, privateDetailsOmitted: true })); process.exitCode = 1; }
