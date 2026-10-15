// P2：Windows 文件桥在有界窗口内乱序写入时的吞吐、单次调用耗时与 NTFS 补零。
// 按 design.md 决策 3、4、5 模拟：8 MiB 分块，写入者按序号领取窗口内最小的空闲分块，
// 每新写 4 MiB 合并一次保存（sync 后把已完成的队头分块读回、核对 SHA-256 并并入前缀）。
// 用法：p2-bridge [目标目录，默认系统临时目录] [结果 JSON 路径] [写入者x窗口分块数，如 8x9；默认 4/8 × 64/128 MiB]
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { systemFiles } from "../../src/platform/file-system";
import type { LocalDirectory, LocalFile } from "../../src/platform/files";

const KiB = 1024, MiB = 1048576, BLOCK = 64 * KiB, CHUNK = 8 * MiB, SAVE_EVERY = 4 * MiB;
const SINGLE_CONNECTION = 245 * KiB;
type Op = "write" | "read" | "sync" | "truncate";
type Stats = { calls: number; totalMs: number; maxMs: number };

class TimedFile {
  readonly stats: Record<Op, Stats> = { write: blank(), read: blank(), sync: blank(), truncate: blank() };
  constructor(readonly file: LocalFile) {}
  private async time<T>(op: Op, run: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try { return await run(); } finally {
      const ms = performance.now() - started, entry = this.stats[op];
      entry.calls++; entry.totalMs += ms; entry.maxMs = Math.max(entry.maxMs, ms);
    }
  }
  write(offset: number, data: Uint8Array) { return this.time("write", () => this.file.write(BigInt(offset), data)); }
  read(offset: number, length: number) { return this.time("read", () => this.file.read(BigInt(offset), length)); }
  sync() { return this.time("sync", () => this.file.sync()); }
  truncate(size: number) { return this.time("truncate", () => this.file.truncate(BigInt(size))); }
}
function blank(): Stats { return { calls: 0, totalMs: 0, maxMs: 0 }; }

// 空文件上直接在窗口末端写一块：测第一次越过 VDL 时补零整个窗口的耗时。
async function vdlJump(directory: LocalDirectory, window: number) {
  const file = new TimedFile(await directory.file(`jump-${window / MiB}.part`, true));
  try {
    await file.truncate(0); await file.sync();
    const block = randomBytes(BLOCK);
    const started = performance.now();
    await file.write(window - BLOCK, block);
    const writeMs = performance.now() - started;
    const syncStarted = performance.now();
    await file.sync();
    return { writeMs: Math.round(writeMs), syncMs: Math.round(performance.now() - syncStarted) };
  } finally { await file.file.close(); }
}

async function windowed(directory: LocalDirectory, writers: number, window: number, total: number) {
  const file = new TimedFile(await directory.file(`run-${writers}-${window / MiB}.part`, true));
  const chunks = Math.ceil(total / CHUNK), width = window / CHUNK;
  const block = randomBytes(BLOCK);
  const claimed = new Array<boolean>(chunks).fill(false), done = new Array<boolean>(chunks).fill(false);
  const digests = new Array<string>(chunks).fill("");
  let base = 0, unsaved = 0, saving: Promise<void> | null = null, again = false, written = 0, readBack = 0, frontier = 0, maxAhead = 0;
  let failure: unknown = null;
  let wake: () => void = () => {}, waiting = new Promise<void>(resolve => { wake = resolve; });
  const notify = () => { wake(); waiting = new Promise<void>(resolve => { wake = resolve; }); };

  const fold = async () => {
    await file.sync();
    while (base < chunks && done[base]) {
      const start = base * CHUNK, end = Math.min(start + CHUNK, total), hash = createHash("sha256");
      for (let offset = start; offset < end; offset += BLOCK) {
        const data = await file.read(offset, Math.min(BLOCK, end - offset));
        if (data.byteLength !== Math.min(BLOCK, end - offset)) throw Error("short-read");
        hash.update(data); readBack += data.byteLength;
      }
      if (hash.digest("hex") !== digests[base]) throw Error("readback-mismatch");
      base++;
    }
    notify();
  };
  // 同一时刻只有一次保存，期间到达的请求合并为下一次。
  const save = async (): Promise<void> => {
    if (saving) { again = true; return saving; }
    saving = (async () => { do { again = false; unsaved = 0; await fold(); } while (again); })().finally(() => { saving = null; });
    return saving;
  };
  const trigger = () => { save().catch(error => { failure ??= error; notify(); }); };
  // 窗口内没有空闲分块时等待下一次并入；每个分块完成都会触发保存，因此不会空等。
  const claim = async (): Promise<number | null> => {
    while (true) {
      if (failure) throw failure;
      for (let index = base; index < Math.min(base + width, chunks); index++) if (!claimed[index]) { claimed[index] = true; return index; }
      if (base >= chunks) return null;
      await waiting;
    }
  };
  const writer = async () => {
    for (let index = await claim(); index !== null; index = await claim()) {
      const start = index * CHUNK, end = Math.min(start + CHUNK, total), hash = createHash("sha256");
      for (let offset = start; offset < end; offset += BLOCK) {
        const data = block.subarray(0, Math.min(BLOCK, end - offset));
        await file.write(offset, data); hash.update(data);
        written += data.byteLength; unsaved += data.byteLength;
        maxAhead = Math.max(maxAhead, offset + data.byteLength - base * CHUNK); frontier = Math.max(frontier, offset + data.byteLength);
        if (unsaved >= SAVE_EVERY) trigger();
        if (failure) throw failure;
      }
      digests[index] = hash.digest("hex"); done[index] = true; trigger();
    }
  };

  const started = performance.now();
  try {
    await file.truncate(0); await file.sync();
    await Promise.all(Array.from({ length: writers }, writer));
    while (base < chunks) { if (failure) throw failure; await save(); }
    const seconds = (performance.now() - started) / 1000;
    const target = writers * SINGLE_CONNECTION;
    return {
      writers, windowMiB: window / MiB, totalMiB: total / MiB, seconds: Math.round(seconds * 10) / 10,
      writeMiBps: round(written / MiB / seconds), readBackMiBps: round(readBack / MiB / seconds),
      targetMiBps: round(target / MiB), ratioToTarget: round(written / seconds / target),
      maxAheadMiB: round(maxAhead / MiB),
      maxMs: Object.fromEntries(Object.entries(file.stats).map(([op, stats]) => [op, Math.round(stats.maxMs)])),
      calls: Object.fromEntries(Object.entries(file.stats).map(([op, stats]) => [op, stats.calls])),
      error: null as string | null,
    };
  } finally { await file.file.close().catch(() => {}); }
}
const round = (value: number) => Math.round(value * 100) / 100;

const target = process.argv[2] ?? tmpdir(), output = process.argv[3], only = process.argv[4]?.match(/^(\d+)x(\d+)$/);
// 默认四个场景；指定时只运行该场景（用于决策 1 的“窗口降到 C+1 个分块后重测”）。
const scenarios = only ? [[Number(only[1]), Number(only[2]) * 8 * MiB]] : [[4, 64 * MiB], [8, 64 * MiB], [4, 128 * MiB], [8, 128 * MiB]];
const root = await mkdtemp(join(target, "pikpak-p2-"));
const results: unknown[] = [];
console.log(`P2 Windows 文件桥测试：${process.platform}/${process.arch}，目录 ${root}`);
try {
  for (const [writers, window] of scenarios as Array<[number, number]>) {
    {
      // 每个场景独立的桥接会话，前一个场景的会话中断不影响后续场景。
      const files = systemFiles(), directory = await files.root(root);
      try {
        await directory.freeBytes();
        const jump = writers === 4 ? await vdlJump(directory, window) : null;
        const run = await windowed(directory, writers, window, 4 * window).catch(error => ({ writers, windowMiB: window / MiB, error: String((error as Error).message ?? error) }));
        const result = { ...run, vdlJump: jump };
        results.push(result); console.log(JSON.stringify(result));
      } finally { await directory.close().catch(() => {}); await files.close(); }
    }
  }
} finally {
  if (output) await writeFile(output, `${JSON.stringify({ at: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, results }, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
