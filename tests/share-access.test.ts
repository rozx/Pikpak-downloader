import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SecretStore } from "../src/platform/types";
import { Store } from "../src/state/store";
import { acceptShare, collectShareAccess, loadShareAccess } from "../src/auth/share-access";

class FakeSecrets implements SecretStore {
  values = new Map<string, string>();
  fail: "before" | "after" | "delete" | null = null;
  async get(key: string) { return this.values.get(key) ?? null; }
  async set(key: string, value: string) {
    if (this.fail === "before") throw Error("synthetic write failure");
    this.values.set(key, value);
    if (this.fail === "after") throw Error("synthetic lost acknowledgement");
  }
  async delete(key: string) { if (this.fail === "delete") throw Error("synthetic delete failure"); this.values.delete(key); }
}
const input = { accountId: "account", shareId: "share", passCode: "synthetic-private-passcode", outputRoot: "/fixed" };

test("秘密写入前后失败均不确认请求，也不把原始秘密写入 SQLite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pikpak-access-test-")); const path = join(dir, "db.sqlite");
  const store = new Store(path); store.ensureAccount(input.accountId);
  const secrets = new FakeSecrets();
  try {
    for (const fail of ["before", "after"] as const) {
      secrets.fail = fail;
      await expect(acceptShare(store, secrets, input)).rejects.toThrow();
      expect(store.shares(input.accountId)).toHaveLength(0);
      expect(secrets.values.size).toBe(0);
    }
    secrets.fail = null;
    const accepted = await acceptShare(store, secrets, input);
    expect((await loadShareAccess(secrets, accepted.share.secretRef, input.accountId, input.shareId)).passCode).toBe(input.passCode);
    expect((await readFile(path)).includes(Buffer.from(input.passCode))).toBe(false);
    expect((await readFile(`${path}-wal`)).includes(Buffer.from(input.passCode))).toBe(false);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("数据库提交失败保留原资料，活动扫描及未知操作持有旧引用", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pikpak-access-test-")); const path = join(dir, "db.sqlite");
  const store = new Store(path); store.ensureAccount(input.accountId);
  const secrets = new FakeSecrets();
  try {
    const old = await acceptShare(store, secrets, input);
    const scan = store.claimScan(input.accountId, old.share.id)!;
    const file = store.mergeFile(scan, { sourceId: "source", gcid: "a".repeat(40), size: 1n, relativePath: "file" });
    const operation = store.beginOperation(input.accountId, file.id, "restore");
    const readOnly = new Store(path, true);
    try { await expect(acceptShare(readOnly, secrets, { ...input, passCode: "replacement" })).rejects.toThrow(); }
    finally { readOnly.close(); }
    expect(store.share(input.accountId, old.share.id).secretRef).toBe(old.share.secretRef);
    const updated = await acceptShare(store, secrets, { ...input, passCode: "replacement" });
    expect(updated.share.secretRef).not.toBe(old.share.secretRef);
    expect(await collectShareAccess(store, secrets, old.share.secretRef)).toBe(false);
    expect((await loadShareAccess(secrets, scan.secretRef, input.accountId, input.shareId)).passCode).toBe(input.passCode);
    store.finishScan(scan, true);
    expect(await collectShareAccess(store, secrets, old.share.secretRef)).toBe(false);
    store.submitted(input.accountId, operation, "task");
    store.recordCopy(input.accountId, operation, { remoteId: "copy", parentId: "parent", size: 1n, gcid: file.gcid });
    expect(await collectShareAccess(store, secrets, old.share.secretRef)).toBe(true);
    expect(await secrets.get(updated.share.secretRef)).not.toBe(null);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("提交后的清理失败不撤销接收，秘密丢失和身份错配不能换用其他资料", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pikpak-access-test-")); const store = new Store(join(dir, "db.sqlite"));
  store.ensureAccount(input.accountId); const secrets = new FakeSecrets();
  try {
    await acceptShare(store, secrets, input);
    secrets.fail = "delete";
    const updated = await acceptShare(store, secrets, { ...input, passCode: "replacement" });
    expect(updated.cleanupPending).toBe(true);
    expect(store.share(input.accountId, updated.share.id).secretRef).toBe(updated.share.secretRef);
    await expect(loadShareAccess(secrets, updated.share.secretRef, "different-account", input.shareId)).rejects.toThrow();
    secrets.values.delete(updated.share.secretRef);
    await expect(loadShareAccess(secrets, updated.share.secretRef, input.accountId, input.shareId)).rejects.toThrow();
    expect(store.share(input.accountId, updated.share.id).requestedRevision).toBe(2n);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
