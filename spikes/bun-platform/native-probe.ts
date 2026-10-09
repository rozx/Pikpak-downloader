import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

declare const PROBE_COMPILED: boolean;
const compiled = typeof PROBE_COMPILED !== "undefined" && PROBE_COMPILED;
interface MacNative {
  createBoard(): string;
  boardCount(name: string): bigint;
  boardText(name: string): string | null;
  writeBoard(name: string, value: string): boolean;
  releaseBoard(name: string): boolean;
  acquireLock(path: string): object | null;
  releaseLock(handle: object): boolean;
  identity(path: string): { dev: bigint; ino: bigint };
  publish(from: string, to: string): boolean;
}
const native: MacNative = require("./dist/macos.node");

function snapshot(name: string, between: () => void = () => {}): { sequence: bigint; text: string | null } | null {
  for (let attempts = 0; attempts < 3; attempts++) {
    const before = native.boardCount(name);
    between();
    const text = native.boardText(name);
    const after = native.boardCount(name);
    if (before === after) return { sequence: after, text };
  }
  return null;
}

function clipboardProbe(): void {
  const name = native.createBoard();
  try {
    native.writeBoard(name, "公开合成测试文本 🚀");
    const first = snapshot(name);
    assert.equal(first?.text, "公开合成测试文本 🚀");
    native.writeBoard(name, "公开合成测试文本 🚀");
    const copied = snapshot(name);
    assert.equal(copied?.text, first?.text);
    assert.notEqual(copied?.sequence, first?.sequence);
    let changed = false;
    const interleaved = snapshot(name, () => {
      if (!changed) { changed = true; native.writeBoard(name, "替换后的合成内容"); }
    });
    assert.equal(interleaved?.text, "替换后的合成内容");
    assert.equal(interleaved?.sequence, native.boardCount(name));
    assert.equal(snapshot(name, () => { native.writeBoard(name, "持续变化"); }), null);
    for (let i = 0; i < 50; i++) native.writeBoard(name, `合成覆盖 ${i}`);
    assert.equal(snapshot(name)?.text, "合成覆盖 49");
    assert.equal(snapshot(name)?.sequence, native.boardCount(name));
  } finally { native.releaseBoard(name); }
}

function command(...args: string[]): string[] {
  return compiled ? [process.execPath, ...args] : [process.execPath, import.meta.path, ...args];
}

async function checkLockChild(path: string, expected: "busy" | "available"): Promise<void> {
  const child = Bun.spawn(command("--check-lock", path), { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  assert.equal((await new Response(child.stdout).text()).trim(), expected);
  assert.equal(await child.exited, 0);
}

async function lockProbe(dir: string): Promise<void> {
  const path = join(dir, "queue.lock");
  const held = native.acquireLock(path);
  assert.ok(held);
  try { await checkLockChild(path, "busy"); } finally { native.releaseLock(held); }
  await checkLockChild(path, "available");
  const child = Bun.spawn(command("--hold-lock", path), { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const reader = child.stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const first = await Promise.race([reader.read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error("lock-child-timeout")), 10_000);
    })]);
    assert.equal(new TextDecoder().decode(first.value), "held\n");
    assert.equal(native.acquireLock(path), null);
  } finally {
    if (timer) clearTimeout(timer);
    child.kill("SIGKILL"); await child.exited; reader.releaseLock();
  }
  await checkLockChild(path, "available");
  const link = join(dir, "linked.lock");
  await symlink(path, link);
  assert.throws(() => native.acquireLock(link));
}

async function publicationProbe(dir: string): Promise<void> {
  const from = join(dir, "pending.part"), existing = join(dir, "existing.bin"), target = join(dir, "delivered.bin");
  await writeFile(from, "合成待发布内容", { flag: "wx", mode: 0o600 });
  await writeFile(existing, "合成已有内容", { flag: "wx", mode: 0o600 });
  const handle = await open(from, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
  const identity = native.identity(from);
  assert.equal(native.publish(from, existing), false);
  assert.equal(await readFile(existing, "utf8"), "合成已有内容");
  assert.deepEqual(native.identity(from), identity);
  assert.equal(native.publish(from, target), true);
  assert.deepEqual(native.identity(target), identity);
  assert.notDeepEqual(native.identity(existing), identity);
  const directory = await open(dir, "r");
  try { await directory.sync(); } finally { await directory.close(); }
  await assert.rejects(readFile(from));
  assert.equal(await readFile(target, "utf8"), "合成待发布内容");
  const linked = join(dir, "linked-file");
  await symlink(target, linked);
  assert.throws(() => native.identity(linked));
}

async function main(): Promise<void> {
  assert.equal(process.platform, "darwin");
  const dir = await mkdtemp(join(tmpdir(), "pikpak-native-probe-"));
  const results: Array<{ check: string; pass: boolean }> = [];
  try {
    for (const [check, run] of [
      ["clipboard-stable-repeat-interleaving-overwrite", () => clipboardProbe()],
      ["kernel-lock-exclusion-and-crash-release", () => lockProbe(dir)],
      ["exclusive-publication-file-identity", () => publicationProbe(dir)],
    ] as const) {
      try { await run(); results.push({ check, pass: true }); }
      catch { results.push({ check, pass: false }); }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
  console.log(JSON.stringify({ runtime: Bun.version, platform: process.platform, arch: process.arch, compiled, results,
    generalClipboardTouched: false, otherPlatformsVerified: false }, null, 2));
  if (results.some(result => !result.pass)) process.exitCode = 1;
}

const mode = process.argv[2];
if (mode === "--check-lock" || mode === "--hold-lock") {
  const path = process.argv[3];
  assert.ok(path && basename(path) === "queue.lock" && basename(join(path, "..")).startsWith("pikpak-native-probe-"));
  const handle = native.acquireLock(path);
  if (mode === "--check-lock") {
    console.log(handle ? "available" : "busy");
    if (handle) native.releaseLock(handle);
  } else {
    assert.ok(handle);
    console.log("held");
    await new Promise<never>(() => setInterval(() => { void handle; }, 60_000));
  }
} else { await main(); }
