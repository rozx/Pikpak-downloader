import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { link, mkdtemp, open, readFile, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Database } from "bun:sqlite";

// Defined only by the standalone build; source execution uses the Bun interpreter.
declare const PROBE_COMPILED: boolean;
const compiled = typeof PROBE_COMPILED !== "undefined" && PROBE_COMPILED;

type Result = {
  check: string;
  status: "pass" | "fail" | "not-run";
  detail: string;
};

function database(path: string): Database {
  const db = new Database(path, { safeIntegers: true });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
  return db;
}

async function databaseWorker(path: string, mode: string): Promise<never> {
  assert.equal(basename(path), "probe.sqlite");
  assert.ok(basename(join(path, "..")).startsWith("pikpak-bun-probe-"));
  assert.ok(mode === "commit" || mode === "rollback");
  const db = database(path);
  db.exec("BEGIN IMMEDIATE");
  db.query("INSERT INTO crash_records (id, value) VALUES (?, ?)").run(mode, 123n);
  if (mode === "commit") db.exec("COMMIT");
  process.stdout.write("ready\n");
  // The parent kills only this child after the expected write/commit has happened.
  return await new Promise<never>(() => setInterval(() => {}, 60_000));
}

async function crashWriter(path: string, mode: "commit" | "rollback"): Promise<void> {
  const args = ["--internal-db-worker", path, mode];
  const command = compiled
    ? [process.execPath, ...args]
    : [process.execPath, import.meta.path, ...args];
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const reader = child.stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("worker-timeout")), 10_000);
      }),
    ]);
    assert.equal(new TextDecoder().decode(first.value), "ready\n");
  } finally {
    if (timer) clearTimeout(timer);
    child.kill("SIGKILL");
    await child.exited;
    reader.releaseLock();
  }
}

async function sqliteProbe(dir: string): Promise<void> {
  const path = join(dir, "probe.sqlite");
  const db = database(path);
  try {
    db.exec("CREATE TABLE integers (id TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    db.exec("CREATE TABLE crash_records (id TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    const exact = 9_007_199_254_740_993n;
    db.query("INSERT INTO integers VALUES (?, ?)").run("precise", exact);
    const row = db.query<{ value: bigint }, []>("SELECT value FROM integers").get();
    assert.equal(row?.value, exact);
    assert.throws(db.transaction(() => {
      db.query("INSERT INTO integers VALUES (?, ?)").run("rolled-back", 1n);
      db.query("INSERT INTO integers VALUES (?, ?)").run("precise", 2n);
    }));
    const count = db.query<{ count: bigint }, []>("SELECT count(*) AS count FROM integers").get();
    assert.equal(count?.count, 1n);
  } finally {
    db.close();
  }

  await crashWriter(path, "rollback");
  await crashWriter(path, "commit");
  const recovered = database(path);
  try {
    const rows = recovered.query<{ id: string; value: bigint }, []>(
      "SELECT id, value FROM crash_records ORDER BY id",
    ).all();
    assert.deepEqual(rows, [{ id: "commit", value: 123n }]);
    assert.equal(recovered.query<{ value: bigint }, []>("SELECT value FROM integers").get()?.value,
      9_007_199_254_740_993n);
  } finally {
    recovered.close();
  }
}

async function publicationProbe(dir: string): Promise<void> {
  const source = join(dir, "staged.part");
  const destination = join(dir, "published.bin");
  const bytes = Buffer.from("public synthetic platform probe\n");
  const handle = await open(source, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const before = await stat(source, { bigint: true });
  await link(source, destination);
  const after = await stat(destination, { bigint: true });
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, BigInt(bytes.length));
  await assert.rejects(link(source, destination), { code: "EEXIST" });
  assert.deepEqual(await readFile(destination), bytes);
  await unlink(source);
  assert.equal((await stat(destination, { bigint: true })).ino, before.ino);
}

async function directorySyncProbe(dir: string): Promise<void> {
  const directory = await open(dir, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function credentialProbe(): Promise<void> {
  const key = { service: "pikpak-downloader.feasibility", name: randomUUID() };
  const value = `synthetic-${randomUUID()}`;
  try {
    await Bun.secrets.set({ ...key, value });
    assert.equal(await Bun.secrets.get(key), value);
    assert.equal(await Bun.secrets.delete(key), true);
    assert.equal(await Bun.secrets.get(key), null);
  } finally {
    // Never enumerate or read other credentials; this key was just generated here.
    await Bun.secrets.delete(key);
  }
}

async function clipboardSignalProbe(): Promise<void> {
  let command: string[];
  if (process.platform === "darwin") {
    command = ["/usr/bin/osascript", "-l", "JavaScript", "-e",
      "ObjC.import('AppKit'); Number($.NSPasteboard.generalPasteboard.changeCount);"];
  } else if (process.platform === "win32") {
    command = ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
      "Add-Type 'using System.Runtime.InteropServices; public static class ClipboardProbe { [DllImport(\"user32.dll\")] public static extern uint GetClipboardSequenceNumber(); }'; [ClipboardProbe]::GetClipboardSequenceNumber()"];
  } else {
    throw new Error("unsupported-probe-platform");
  }
  const processHandle = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const output = (await new Response(processHandle.stdout).text()).trim();
  assert.equal(await processHandle.exited, 0);
  assert.match(output, /^\d+$/);
  // Content is neither read nor changed. A readable counter is not a full clipboard test.
  if (process.platform === "win32") assert.notEqual(output, "0");
}

async function main(): Promise<void> {
  const argumentsSet = new Set(process.argv.slice(2));
  assert.ok([...argumentsSet].every(argument => ["--credentials", "--clipboard-signal"].includes(argument)));
  const results: Result[] = [];
  const dir = await mkdtemp(join(tmpdir(), "pikpak-bun-probe-"));
  const run = async (check: string, action: () => Promise<void>, detail: string) => {
    try {
      await action();
      results.push({ check, status: "pass", detail });
    } catch {
      // Errors from credential/platform APIs are deliberately not echoed with their payloads.
      results.push({ check, status: "fail", detail: "验证未通过；未输出底层敏感数据。" });
    }
  };
  try {
    await run("sqlite-transactions-crash-recovery-bigint", () => sqliteProbe(dir),
      "唯一约束回滚、64 位整数、子进程提交前后强制退出与重新打开。不是全应用恢复测试。");
    await run("hardlink-publication-identity-no-replace", () => publicationProbe(dir),
      "仅验证临时目录所在文件系统的同卷硬链接方案，不代表所有下载磁盘支持。");
    if (process.platform === "darwin") {
      await run("directory-sync", () => directorySyncProbe(dir), "本机目录刷新调用成功；未模拟物理断电。");
    } else {
      results.push({ check: "directory-sync", status: "not-run", detail: "仍需验证目标系统的目录持久化方案。" });
    }
    if (argumentsSet.has("--credentials") && process.platform === "win32") {
      results.push({ check: "synthetic-credential-roundtrip-cleanup", status: "not-run",
        detail: "当前类型定义未确认 Windows 本机持久化选项，未写入凭据；需验证原生适配或运行时支持。" });
    } else if (argumentsSet.has("--credentials")) {
      await run("synthetic-credential-roundtrip-cleanup", credentialProbe,
        "仅写入、读取并删除本次随机生成的测试条目，未使用 PikPak 凭据。");
    } else {
      results.push({ check: "synthetic-credential-roundtrip-cleanup", status: "not-run", detail: "需 --credentials 显式启用。" });
    }
    if (argumentsSet.has("--clipboard-signal")) {
      await run("clipboard-change-signal-only", clipboardSignalProbe,
        "只读取变化标识，不读取或修改剪贴板内容；稳定快照及重复复制尚未验证。");
    } else {
      results.push({ check: "clipboard-change-signal-only", status: "not-run", detail: "需 --clipboard-signal 显式启用。" });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log(JSON.stringify({
    runtime: Bun.version,
    platform: process.platform,
    arch: process.arch,
    compiled,
    results,
    gateComplete: false,
    pending: ["真实账号接口", "完整剪贴板行为", "系统进程互斥", "原生扩展打包", "其他目标系统与文件系统实测"],
  }, null, 2));
  if (results.some(result => result.status === "fail")) process.exitCode = 1;
}

if (process.argv[2] === "--internal-db-worker") {
  const path = process.argv[3];
  const mode = process.argv[4];
  assert.ok(path && mode);
  await databaseWorker(path, mode);
} else {
  await main();
}
