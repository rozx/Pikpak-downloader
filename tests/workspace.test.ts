import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { safeName, foldedName, taskName } from "../src/download/names";
import { FileWorkspace } from "../src/download/workspace";
import { systemFiles } from "../src/platform/file-system";
import type { LocalFileSystem } from "../src/platform/files";
import { Store } from "../src/state/store";
import { Database } from "bun:sqlite";
import { rejection } from "./fixtures/rejection";

// 本地文件适配层在 macOS 与 Windows 上各有实现；Windows 实现背后是常驻桥接进程，测试结束时关闭。
const nativeFiles = process.platform === "darwin" || process.platform === "win32";
let files: LocalFileSystem | undefined;
const localFiles = () => files ??= systemFiles();
afterAll(async () => { await files?.close(); });

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

test.if(nativeFiles)("固定目录和大小写名称预留可重开，替换为符号链接后拒绝接管", async () => {
  const root = await mkdtemp(join(tmpdir(), "pikpak-workspace-test-")); const store = new Store(join(root, "db.sqlite"));
  let workspace: FileWorkspace | undefined;
  try {
    store.ensureAccount("account"); const share = store.accept("account", "share", root, "reference");
    const scan = store.claimScan("account", share.id)!;
    const first = store.mergeFile(scan, { sourceId: "one", gcid: "a".repeat(40), size: 10n, relativePath: JSON.stringify([{ id: "folder", name: "Folder" }, { id: "one", name: "Name.bin" }]) });
    const second = store.mergeFile(scan, { sourceId: "two", gcid: "b".repeat(40), size: 10n, relativePath: JSON.stringify([{ id: "folder", name: "Folder" }, { id: "two", name: "name.bin" }]) });
    workspace = await FileWorkspace.open(store, "account", share.id, localFiles());
    const a = await workspace.prepare(first), b = await workspace.prepare(second);
    expect(foldedName(a.name)).not.toBe(foldedName(b.name));
    const temp = await workspace.temporary(first); await temp.write(0n, Buffer.from("synthetic")); await temp.sync(); await temp.close();
    const path = await workspace.targetPath(a);
    await workspace.close();
    workspace = await FileWorkspace.open(store, "account", share.id, localFiles());
    expect(await workspace.prepare(first)).toEqual(a);
    const resumed = await workspace.temporary(first); expect((await resumed.info()).size).toBe(9n); await resumed.close();
    await workspace.close(); workspace = undefined;
    const parent = join(path, "..");
    // Windows 创建目录符号链接需要额外权限，用无需权限的目录联接模拟同样的替换。
    await rename(parent, `${parent}-moved`); await symlink(root, parent, process.platform === "win32" ? "junction" : "dir");
    workspace = await FileWorkspace.open(store, "account", share.id, localFiles());
    await rejection(workspace.prepare(first));
    expect(store.delivery("account", first.id)?.targetPath).toBe(path);
  } finally { await workspace?.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test.if(nativeFiles)("临时路径出现用户替换文件时不覆盖或接管", async () => {
  const root = await mkdtemp(join(tmpdir(), "pikpak-workspace-test-")); const store = new Store(join(root, "db.sqlite"));
  let workspace: FileWorkspace | undefined;
  try {
    store.ensureAccount("account"); const share = store.accept("account", "share", root, "reference"); const scan = store.claimScan("account", share.id)!;
    const file = store.mergeFile(scan, { sourceId: "file", gcid: "a".repeat(40), size: 10n, relativePath: JSON.stringify([{ id: "file", name: "file.bin" }]) });
    workspace = await FileWorkspace.open(store, "account", share.id, localFiles());
    const temporary = await workspace.temporary(file); await temporary.close();
    const path = store.delivery("account", file.id)!.tempPath;
    await rename(path, `${path}.retained`); await writeFile(path, "user-content", { flag: "wx" });
    await rejection(workspace.temporary(file));
  } finally { await workspace?.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test.if(nativeFiles)("打开工作区期间分享被迁移到新目录时，按新目录重新打开并记录新目录的身份", async () => {
  const root = await mkdtemp(join(tmpdir(), "pikpak-workspace-race-")); const store = new Store(join(root, "db.sqlite"));
  const before = join(root, "old"), after = join(root, "new");
  await Bun.write(join(before, ".keep"), ""); await Bun.write(join(after, ".keep"), "");
  const base = localFiles(); let moved = false;
  // 第一次读取旧目录身份时，模拟设置页把默认目录改到新目录并迁移尚未开始的分享。
  const racing: LocalFileSystem = { close: async () => {}, root: async path => {
    const directory = await base.root(path);
    return Object.assign(Object.create(directory), {
      identity: async () => { const value = await directory.identity(); if (!moved && path === before) { moved = true; store.moveUnstartedShares("account", after); } return value; },
      close: () => directory.close(), child: directory.child.bind(directory), file: directory.file.bind(directory), sync: directory.sync.bind(directory),
      freeBytes: directory.freeBytes.bind(directory), publish: directory.publish.bind(directory),
    });
  } };
  try {
    store.ensureAccount("account"); const share = store.accept("account", "race", before, "secret");
    const workspace = await FileWorkspace.open(store, "account", share.id, racing);
    try {
      expect(moved).toBe(true);
      expect(store.share("account", share.id).outputRoot).toBe(after);
      const expected = await base.root(after);
      try {
        const bound = new Database(join(root, "db.sqlite"), { readonly: true });
        try {
          const row = bound.query<{ volume: string; identity: string }, [string]>("SELECT root_volume AS volume,root_identity AS identity FROM shares WHERE id=?").get(share.id)!;
          expect({ volume: row.volume, file: row.identity }).toEqual(await expected.identity());
        } finally { bound.close(); }
      } finally { await expected.close(); }
    } finally { await workspace.close(); }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("任务名称去掉文件后缀：普通后缀、分卷后缀与双后缀；没有后缀或只有数字的点保持原样", () => {
  expect(taskName("[DODO]26年10月作品 爱丽速子x曼城茶座.rar")).toBe("[DODO]26年10月作品 爱丽速子x曼城茶座");
  expect(taskName("Shibarin.7z.002")).toBe("Shibarin"); expect(taskName("プチロマンス.7z.001")).toBe("プチロマンス");
  expect(taskName("movie.part1.rar")).toBe("movie"); expect(taskName("backup.tar.gz")).toBe("backup"); expect(taskName("old.r00")).toBe("old");
  expect(taskName("[GS_mel]26.10.14作品 绝区零 普罗米娅.rar")).toBe("[GS_mel]26.10.14作品 绝区零 普罗米娅");
  expect(taskName("某某合集")).toBe("某某合集"); expect(taskName("Season 1.5")).toBe("Season 1.5"); expect(taskName(".rar")).toBe(".rar");
  // 目录名不拆后缀：冲突编号加在末尾。
  expect(safeName("[GS_mel]26.10.14作品", " (2)", 240, false)).toBe("[GS_mel]26.10.14作品 (2)");
});

test.if(nativeFiles)("任务目录用去掉后缀的任务名，重名时写作“名称 (2)”；临时文件放在目标旁边，不建 .pikpak-staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "pikpak-workspace-layout-")); const store = new Store(join(root, "db.sqlite"));
  let workspace: FileWorkspace | undefined;
  try {
    store.ensureAccount("account"); const share = store.accept("account", "share", root, "reference");
    const scan = store.claimScan("account", share.id)!; store.captureTitle(scan, "Shibarin.7z.002");
    await mkdir(join(root, "Shibarin")); // 用户已有同名目录：不写进去
    const file = store.mergeFile(scan, { sourceId: "one", gcid: "a".repeat(40), size: 10n, relativePath: JSON.stringify([{ id: "one", name: "Shibarin.7z.001" }]) });
    workspace = await FileWorkspace.open(store, "account", share.id, localFiles());
    const plan = await workspace.prepare(file);
    const delivery = store.delivery("account", file.id)!;
    expect(delivery.targetPath).toBe(join(root, "Shibarin (2)", "Shibarin.7z.001"));
    expect(delivery.tempPath).toBe(join(root, "Shibarin (2)", "Shibarin.7z.001.pikpak-part"));
    expect(plan.tempParent).toBe(plan.parent);
    const temp = await workspace.temporary(file); await temp.close();
    expect((await readdir(join(root, "Shibarin (2)"))).sort()).toEqual(["Shibarin.7z.001.pikpak-part"]);
    expect(await readdir(join(root, "Shibarin"))).toEqual([]);
  } finally { await workspace?.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});
