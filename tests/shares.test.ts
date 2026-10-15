import { expect, test } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Store } from "../src/state/store";
import { acceptShare } from "../src/auth/share-access";
import { scanShare, requireShareAccess } from "../src/pikpak/shares";
import type { PikpakClient } from "../src/pikpak/client";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pikpak-scan-test-")); const path = join(directory, "db.sqlite");
  let store = new Store(path); store.ensureAccount("account"); const values = new Map<string, string>();
  const secrets = { get: async (key: string) => values.get(key) ?? null, set: async (key: string, value: string) => { values.set(key, value); }, delete: async (key: string) => { values.delete(key); } };
  const input = { accountId: "account", shareId: "share", passCode: "demo", outputRoot: directory };
  const { share } = await acceptShare(store, secrets, input);
  const scan = store.claimScan("account", share.id)!;
  return { directory, path, get store() { return store; }, secrets, input, share, scan,
    reopen() { store.close(); store = new Store(path); }, close: async () => { store.close(); await rm(directory, { recursive: true, force: true }); } };
}
const file = (id: string, hash = "a".repeat(40)) => ({ id, name: `${id}.bin`, kind: "drive#file", size: "3", hash });
function fake(pages: (parent: string, page: string) => Record<string, unknown>): Pick<PikpakClient, "request"> {
  return { request: async (_, path) => {
    const url = new URL(path, "https://api-drive.mypikpak.com");
    if (url.pathname.endsWith("/share")) return { share_status: "OK", pass_code_token: "synthetic-grant" };
    return pages(url.searchParams.get("parent_id") ?? "", url.searchParams.get("page_token") ?? "");
  } };
}

test("分页和嵌套入库，重复条目合并，增量版本独立且旧路径保持", async () => {
  const f = await fixture();
  try {
    const api = fake((parent, page) => ({ share_status: "OK", files: parent ? [file("nested")] : page ? [file("root")]
      : [file("root"), { id: "folder", name: "目录", kind: "drive#folder" }], next_page_token: !parent && !page ? "next" : "" }));
    expect(await scanShare(f.store, f.secrets, api, f.scan)).toMatchObject({ complete: true, files: 2 });
    const initial = f.store.files("account"); expect(initial).toHaveLength(2);
    const nested = initial.find(item => item.sourceId === "nested")!;
    const root = initial.find(item => item.sourceId === "root")!;
    expect(JSON.parse(nested.relativePath).map((part: { name: string }) => part.name)).toEqual(["目录", "nested.bin"]);
    await acceptShare(f.store, f.secrets, f.input);
    const next = f.store.claimScan("account", f.share.id)!;
    await scanShare(f.store, f.secrets, fake(() => ({ share_status: "OK", files: [{ ...file("root"), name: "renamed.bin" }, file("root", "b".repeat(40)), file("added") ] })), next);
    expect(f.store.files("account")).toHaveLength(4);
    expect(f.store.file("account", nested.id).relativePath).toBe(nested.relativePath);
    expect(f.store.file("account", root.id).relativePath).toBe(root.relativePath);
  } finally { await f.close(); }
});

test("历史完成成果缺失或远端移除不会重建版本或删除历史", async () => {
  const f = await fixture();
  try {
    await scanShare(f.store, f.secrets, fake(() => ({ share_status: "OK", files: [file("completed")] })), f.scan);
    const completed = f.store.files("account")[0]!;
    // 模拟先前程序已可靠交付的历史快照；路径现在不存在。
    const db = new Database(f.path);
    db.query("INSERT INTO deliveries(file_id,account_id,temp_path,target_path,file_volume,file_identity,sha256,verification,completed_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(completed.id, "account", join(f.directory, "old.part"), join(f.directory, "moved-away.bin"), "synthetic-volume", "synthetic-file", "a".repeat(64), "gcid", 1);
    db.query("UPDATE files SET state='completed' WHERE id=?").run(completed.id); db.close();
    for (const entries of [[file("completed")], []]) {
      await acceptShare(f.store, f.secrets, f.input);
      await scanShare(f.store, f.secrets, fake(() => ({ share_status: "OK", files: entries })), f.store.claimScan("account", f.share.id)!);
      expect(f.store.files("account")).toHaveLength(1);
      expect(f.store.file("account", completed.id).state).toBe("completed");
    }
  } finally { await f.close(); }
});

test("中断后重开从未完成目录重扫，不能重复建立版本或虚报完整", async () => {
  const f = await fixture(); const abort = new AbortController();
  try {
    const interrupted = fake((_, page) => {
      if (page) abort.abort();
      return { share_status: "OK", files: [file("one")], next_page_token: "next" };
    });
    await expect(scanShare(f.store, f.secrets, interrupted, f.scan, abort.signal)).rejects.toThrow("interrupted");
    expect(f.store.share("account", f.share.id).scanStatus).toBe("active");
    f.reopen();
    const resumed = f.store.claimScan("account", f.share.id)!; expect(resumed.id).toBe(f.scan.id);
    await scanShare(f.store, f.secrets, fake((_, page) => ({ share_status: "OK", files: [file(page ? "two" : "one")], next_page_token: page ? "" : "next" })), resumed);
    expect(f.store.files("account")).toHaveLength(2);
  } finally { await f.close(); }
});

test("分页循环停止；不可验证条目保留原因，不妨碍其他可靠版本入库", async () => {
  const f = await fixture();
  try {
    await expect(scanShare(f.store, f.secrets, fake(() => ({ share_status: "OK", files: [file("one")], next_page_token: "same" })), f.scan)).rejects.toThrow("pagination_loop");
    expect(f.store.share("account", f.share.id).scanStatus).toBe("failed");
    await acceptShare(f.store, f.secrets, f.input);
    const scan = f.store.claimScan("account", f.share.id)!;
    const result = await scanShare(f.store, f.secrets, fake(() => ({ share_status: "OK", files: [file("valid"), { ...file("weak"), hash: null }] })), scan);
    expect(result).toMatchObject({ complete: false, issues: 1 });
    expect(f.store.files("account").some(item => item.sourceId === "valid")).toBe(true);
    expect(f.store.files("account").some(item => item.sourceId === "weak")).toBe(false);
  } finally { await f.close(); }
});

test("空分享、不可用分享和缺码状态不同", async () => {
  expect(() => requireShareAccess({ share_status: "PASS_CODE_EMPTY" })).toThrow("access_required");
  expect(() => requireShareAccess({ share_status: "PASS_CODE_ERROR" })).toThrow("access_required");
  expect(() => requireShareAccess({ share_status: "UNAVAILABLE" })).toThrow("share_unavailable");
  const f = await fixture();
  try { expect(await scanShare(f.store, f.secrets, fake(() => ({ share_status: "OK", files: [] })), f.scan)).toEqual({ files: 0, issues: 0, complete: true }); }
  finally { await f.close(); }
});

test("v1 升级前生成受保护备份，保留原任务且备份不能直接执行", async () => {
  const f = await fixture();
  try {
    const legacy = new Database(f.path);
    legacy.exec("ALTER TABLE deliveries DROP COLUMN ranges_json; DROP TABLE name_reservations; DROP TABLE directories; DROP INDEX file_share_identity; ALTER TABLE shares DROP COLUMN root_volume; ALTER TABLE shares DROP COLUMN root_identity; ALTER TABLE shares DROP COLUMN title; ALTER TABLE operations DROP COLUMN payload_json; ALTER TABLE copies DROP COLUMN evidence_json; ALTER TABLE deliveries DROP COLUMN plan_json; DROP TABLE scan_pages; DROP TABLE scan_directories; DROP TABLE scan_issues; ALTER TABLE shares DROP COLUMN last_error; PRAGMA user_version=1"); legacy.close();
    f.reopen();
    expect(f.store.share("account", f.share.id).secretRef).toBe(f.share.secretRef);
    const backups = (await readdir(f.directory)).filter(name => name.includes("backup-v1") && name.endsWith(".sqlite"));
    expect(backups).toHaveLength(1);
    const path = join(f.directory, backups[0]!); const backup = new Database(path, { readonly: true });
    try { expect(backup.query<{ value: string }, []>("SELECT value FROM metadata WHERE key='backup_review_required'").get()?.value).toBe("1"); }
    finally { backup.close(); }
    expect(() => new Store(path)).toThrow("备份");
  } finally { await f.close(); }
});
