import { expect, test } from "bun:test";
import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { safeName, foldedName } from "../src/download/names";
import { FileWorkspace } from "../src/download/workspace";
import { macFileSystem } from "../src/platform/mac-files";
import { Store } from "../src/state/store";

test("跨平台名称转换保留扩展名，拒绝穿越效果并处理保留名和 Unicode", () => {
  expect(safeName("CON.txt")).toBe("_CON.txt");
  expect(safeName(".pikpak-staging")).toBe(".pikpak-staging");
  expect(safeName("COM¹.txt")).toBe("_COM¹.txt");
  expect(safeName("CON .txt")).toBe("_CON .txt");
  expect(safeName("../path\\name:bad?.txt")).not.toMatch(/[\\/:?]/);
  expect(safeName(".. ")).toBe("item");
  expect(foldedName("É.TXT")).toBe(foldedName("e\u0301.txt"));
  const long = safeName("文".repeat(1000) + ".bin", "~synthetic");
  expect(Buffer.byteLength(long)).toBeLessThanOrEqual(240); expect(long.endsWith("~synthetic.bin")).toBe(true);
});

test.if(process.platform === "darwin")("固定目录和大小写名称预留可重开，替换为符号链接后拒绝接管", async () => {
  const root = await mkdtemp(join(tmpdir(), "pikpak-workspace-test-")); const store = new Store(join(root, "db.sqlite"));
  let workspace: FileWorkspace | undefined;
  try {
    store.ensureAccount("account"); const share = store.accept("account", "share", root, "reference");
    const scan = store.claimScan("account", share.id)!;
    const first = store.mergeFile(scan, { sourceId: "one", gcid: "a".repeat(40), size: 10n, relativePath: JSON.stringify([{ id: "folder", name: "Folder" }, { id: "one", name: "Name.bin" }]) });
    const second = store.mergeFile(scan, { sourceId: "two", gcid: "b".repeat(40), size: 10n, relativePath: JSON.stringify([{ id: "folder", name: "Folder" }, { id: "two", name: "name.bin" }]) });
    workspace = await FileWorkspace.open(store, "account", share.id, macFileSystem);
    const a = await workspace.prepare(first), b = await workspace.prepare(second);
    expect(foldedName(a.name)).not.toBe(foldedName(b.name));
    const temp = await workspace.temporary(first); await temp.write(0n, Buffer.from("synthetic")); await temp.sync(); await temp.close();
    const path = await workspace.targetPath(a);
    await workspace.close();
    workspace = await FileWorkspace.open(store, "account", share.id, macFileSystem);
    expect(await workspace.prepare(first)).toEqual(a);
    const resumed = await workspace.temporary(first); expect((await resumed.info()).size).toBe(9n); await resumed.close();
    await workspace.close(); workspace = undefined;
    const parent = join(path, "..");
    await rename(parent, `${parent}-moved`); await symlink(root, parent);
    workspace = await FileWorkspace.open(store, "account", share.id, macFileSystem);
    await expect(workspace.prepare(first)).rejects.toThrow();
    expect(store.delivery("account", first.id)?.targetPath).toBe(path);
  } finally { await workspace?.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test.if(process.platform === "darwin")("临时路径出现用户替换文件时不覆盖或接管", async () => {
  const root = await mkdtemp(join(tmpdir(), "pikpak-workspace-test-")); const store = new Store(join(root, "db.sqlite"));
  let workspace: FileWorkspace | undefined;
  try {
    store.ensureAccount("account"); const share = store.accept("account", "share", root, "reference"); const scan = store.claimScan("account", share.id)!;
    const file = store.mergeFile(scan, { sourceId: "file", gcid: "a".repeat(40), size: 10n, relativePath: JSON.stringify([{ id: "file", name: "file.bin" }]) });
    workspace = await FileWorkspace.open(store, "account", share.id, macFileSystem);
    const temporary = await workspace.temporary(file); await temporary.close();
    const path = store.delivery("account", file.id)!.tempPath;
    await rename(path, `${path}.retained`); await writeFile(path, "user-content", { flag: "wx" });
    await expect(workspace.temporary(file)).rejects.toThrow();
  } finally { await workspace?.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});
