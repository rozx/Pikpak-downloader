import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/state/store";
import { writeBackup } from "../src/state/backup";
import { prepareState } from "../src/state/paths";

test("备份保留已提交记录，拒绝直接执行和覆盖已有备份", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pikpak-backup-test-"));
  const paths = await prepareState(dir);
  const store = new Store(paths.database);
  try {
    store.ensureAccount("synthetic-account");
    const share = store.accept("synthetic-account", "synthetic-share", "/fixed", "reference-only");
    const path = join(dir, "snapshot.sqlite");
    await writeBackup(store, path);
    const before = await readFile(path);
    await expect(writeBackup(store, path)).rejects.toThrow();
    expect(await readFile(path)).toEqual(before);
    expect(() => new Store(path)).toThrow("备份");
    const reader = new Store(path, true);
    try { expect(reader.share("synthetic-account", share.id).secretRef).toBe("reference-only"); }
    finally { reader.close(); }
    expect(store.share("synthetic-account", share.id).outputRoot).toBe("/fixed");
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
