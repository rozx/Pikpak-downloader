// Windows 文件 I/O 吞吐对比：PowerShell 文件桥（每次调用一条 JSON 行）与 Bun node:fs 文件描述符的定位读写。
// 同时核对 fstat 的 ino/dev 能否与文件桥给出的文件索引和卷序列号对应，作为“同一文件”的判断依据。
// 用法：bun spikes/windows-fast-io/probe.ts [目标目录，默认系统临时目录] [MiB，默认 256]
import { mkdtempSync, rmSync } from "node:fs";
import { close, fstat, fsync, open, read, write, type BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemFiles } from "../../src/platform/file-system";

const MiB = 1048576, total = Number(process.argv[3] ?? 256) * MiB;
const root = mkdtempSync(join(process.argv[2] ?? tmpdir(), "pikpak-fastio-"));
const data = Buffer.alloc(512 * 1024, 7);
const p = <T>(run: (done: (error: NodeJS.ErrnoException | null, value?: T) => void) => void) =>
  new Promise<T>((resolve, reject) => run((error, value) => error ? reject(error) : resolve(value as T)));
const rate = (bytes: number, ms: number) => Math.round(bytes / MiB / (ms / 1000) * 10) / 10;

try {
  // 1. 文件桥：写入、同步、读回（512 KiB 读取，64 KiB 写入由适配层拆分）。
  const files = systemFiles(), directory = await files.root(root);
  const bridged = await directory.file("bridge.bin", true);
  let started = performance.now();
  for (let offset = 0; offset < total; offset += data.length) await bridged.write(BigInt(offset), data);
  await bridged.sync();
  const bridgeWrite = rate(total, performance.now() - started);
  started = performance.now();
  for (let offset = 0; offset < total;) offset += (await bridged.read(BigInt(offset), 524288)).byteLength;
  const bridgeRead = rate(total, performance.now() - started);
  const bridgeInfo = await bridged.info();
  await bridged.close();

  // 2. node:fs 描述符：同样的写入、同步、读回。
  const path = join(root, "direct.bin");
  const fd = await p<number>(done => open(path, "w+", done));
  started = performance.now();
  for (let offset = 0; offset < total; offset += data.length) await p<number>(done => write(fd, data, 0, data.length, offset, done));
  await p<void>(done => fsync(fd, done));
  const directWrite = rate(total, performance.now() - started);
  const buffer = Buffer.alloc(524288);
  started = performance.now();
  for (let offset = 0; offset < total;) offset += await p<number>(done => read(fd, buffer, 0, buffer.length, offset, done));
  const directRead = rate(total, performance.now() - started);
  await p<void>(done => close(fd, done));

  // 3. 身份对应：同一个文件分别经文件桥与 node:fs 打开，比较文件索引与卷。
  const again = await directory.file("bridge.bin", false);
  const bridgeIdentity = (await again.info()).identity;
  const fdAgain = await p<number>(done => open(join(root, "bridge.bin"), "r+", done));
  const stat = await p<BigIntStats>(done => fstat(fdAgain, { bigint: true }, done));
  await p<void>(done => close(fdAgain, done)); await again.close();
  await directory.close(); await files.close();

  console.log(JSON.stringify({ MiB: total / MiB, bridge: { writeMiBps: bridgeWrite, readMiBps: bridgeRead }, direct: { writeMiBps: directWrite, readMiBps: directRead },
    identity: { bridgeFile: bridgeIdentity.file, statIno: stat.ino.toString(), statDev: stat.dev.toString(), statBirthtimeNs: stat.birthtimeNs.toString(),
      indexMatches: bridgeIdentity.file.split(":")[0] === stat.ino.toString() }, bridgeSize: bridgeInfo.size.toString() }, null, 1));
} finally { rmSync(root, { recursive: true, force: true }); }
