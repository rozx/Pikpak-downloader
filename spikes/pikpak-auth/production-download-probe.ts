import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { loadFixtureSession, VERIFICATION_SERVICE } from "./fixture-session";
import { MacSecrets } from "../../src/auth/secrets";
import { SessionManager } from "../../src/auth/session";
import { acceptShare } from "../../src/auth/share-access";
import { Store } from "../../src/state/store";
import { acquireQueueLock } from "../../src/state/lock";
import { PikpakClient } from "../../src/pikpak/client";
import { Drive } from "../../src/pikpak/drive";
import { Engine } from "../../src/runtime/engine";
import { systemFiles } from "../../src/platform/file-system";

async function main() {
  const input = await loadFixtureSession(); const key = { service: VERIFICATION_SERVICE, name: "production-download-probe.v1" };
  const previous = await Bun.secrets.get(key);
  let journal: { accountId: string; root: string; shareId?: string };
  if (previous) {
    journal = JSON.parse(previous);
    if (journal.accountId !== input.accountId || dirname(journal.root) !== tmpdir() || !basename(journal.root).startsWith("pikpak-production-delivery-")) throw Error("journal-mismatch");
  } else {
    journal = { accountId: input.accountId, root: await mkdtemp(join(tmpdir(), "pikpak-production-delivery-")) };
    await Bun.secrets.set({ ...key, value: JSON.stringify(journal) });
  }
  const lock = acquireQueueLock(join(journal.root, "queue-lock.sqlite")); const store = new Store(join(journal.root, "tasks.sqlite"));
  const secrets = new MacSecrets(); const filesystem = systemFiles(); const stop = new AbortController();
  const interrupt = () => stop.abort(); process.on("SIGINT", interrupt);
  let lastProgress = 0;
  try {
    store.ensureAccount(input.accountId); store.setConfig("active_account", input.accountId);
    if (!journal.shareId) {
      const accepted = await acceptShare(store, secrets, { accountId: input.accountId, shareId: input.shareId, passCode: input.passCode, outputRoot: journal.root });
      journal.shareId = accepted.share.id; await Bun.secrets.set({ ...key, value: JSON.stringify(journal) });
    }
    const session = new SessionManager(secrets, undefined, account => store.pause(account, "authentication"));
    if (await session.existingLogin() !== input.accountId) throw Error("account-mismatch");
    const engine = new Engine(store, secrets, new Drive(new PikpakClient(session, store), input.accountId), filesystem, event => {
      if (event.type === "progress") {
        if (Date.now() - lastProgress < 15000) return;
        lastProgress = Date.now(); console.log(JSON.stringify({ stage: "production-download", percent: event.percent }));
      } else console.log(JSON.stringify({ stage: event.type, ...(event.reason ? { reason: event.reason } : {}) }));
    });
    await engine.reconcile(stop.signal);
    if (!store.files(input.accountId).length) await engine.step(stop.signal);
    const files = store.files(input.accountId);
    if (files.length !== 1 || files[0]!.sourceId !== input.selected.id || files[0]!.gcid !== input.selected.hash?.toLowerCase()
      || files[0]!.size.toString() !== input.selected.size) throw Error("test-selection-changed");
    for (let step = 0; step < 10 && !stop.signal.aborted && await engine.step(stop.signal); step++) {}
    const file = store.file(input.accountId, files[0]!.id); const delivery = store.delivery(input.accountId, file.id);
    const copy = store.copyForFile(input.accountId, file.id);
    const passed = file.state === "completed" && !!delivery?.completedAt;
    console.log(JSON.stringify({ productionEndToEnd: passed, localFilePublished: passed, durableCompletionRecorded: passed,
      creationEvidenceRecorded: copy?.ownership === "created", verification: delivery?.verification ?? null,
      fixtureDetailsOmitted: true, cloudCopyRetained: true }));
    if (!passed) process.exitCode = 1;
  } finally { process.off("SIGINT", interrupt); await filesystem.close(); store.close(); lock.release(); }
}
try { await main(); }
catch { console.log(JSON.stringify({ productionEndToEnd: false, privateDetailsOmitted: true, journalPreserved: true })); process.exitCode = 1; }
