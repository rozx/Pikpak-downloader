// P3b：多个文件同时下载（add-concurrent-file-downloads 决策 1）。每个文件使用各自的签名地址和 --connections 个 Range 连接（默认 1），
// 1/2/3/5 个文件轮流各运行 3 次，记录合计吞吐、每个文件的速率与 429/403/402 次数。
// 只读取本工具任务库里保留中的云端副本；不写本地文件，不输出签名地址、凭据或文件名。
//
// 用法（需先退出正在运行的界面或 watch，本程序持有执行锁）：
//   bun spikes/concurrent-files/p3b-files.ts --list
//   bun spikes/concurrent-files/p3b-files.ts <文件任务ID>... [--out 结果.json] [--seconds 30] [--connections 1-8] [--rounds 3]
import { writeFile } from "node:fs/promises";
import { prepareState } from "../../src/state/paths";
import { acquireQueueLock } from "../../src/state/lock";
import { Store } from "../../src/state/store";
import { systemSecrets } from "../../src/auth/secrets";
import { SessionManager } from "../../src/auth/session";
import { PikpakClient } from "../../src/pikpak/client";
import { Drive } from "../../src/pikpak/drive";
import { originalLink, secureDownloadUrl } from "../../src/download/original-link";
import { retryAfter } from "../../src/pikpak/protocol";

const MiB = 1048576, REQUEST = 8n * 1048576n, MIN_SIZE = 4n * 1048576n;
const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const ids = args.filter((value, index) => !value.startsWith("--") && !args[index - 1]?.startsWith("--"));
const seconds = Number(option("--seconds") ?? 30), output = option("--out");
const perFile = Number(option("--connections") ?? 1), rounds = Number(option("--rounds") ?? 3);
if (!Number.isInteger(perFile) || perFile < 1 || perFile > 8) throw Error("--connections 取 1–8");

const paths = await prepareState();
const lock = acquireQueueLock(paths.lock);
const store = new Store(paths.database);
const stop = new AbortController();
process.on("SIGINT", () => stop.abort());
try {
  const account = store.config("active_account");
  if (!account) throw Error("尚未登录：先运行程序完成浏览器授权");
  const candidates = store.files(account).flatMap(file => {
    const copy = store.copyForFile(account, file.id);
    return copy && copy.size >= MIN_SIZE ? [{ file, copy }] : [];
  });
  if (args.includes("--list") || !ids.length) {
    console.log(candidates.length ? "可用的测试副本（≥ 4 MiB、云端副本保留中）：" : "没有 ≥ 4 MiB 且云端副本保留中的文件。");
    for (const { file } of candidates) console.log(`  ${file.id}  ${(Number(file.size) / MiB).toFixed(1)} MiB  状态 ${file.state}`);
    process.exit(0);
  }
  const picked = ids.map(id => candidates.find(candidate => candidate.file.id === id) ?? (() => { throw Error(`文件任务 ${id} 不可用`); })());
  if (new Set(picked.map(item => item.copy.remoteId)).size !== picked.length) throw Error("指定的文件需要是不同的云端副本");

  const manager = new SessionManager(systemSecrets(), undefined, () => {});
  if (await manager.existingLogin() !== account) throw Error("登录会话与任务库账号不一致");
  const drive = new Drive(new PikpakClient(manager, store), account);
  // 每个文件一个签名地址；地址约 12 小时有效（P1），整个测试只取一次。
  const files = await Promise.all(picked.map(async ({ file, copy }) => {
    const remote = await drive.file(copy.remoteId, stop.signal);
    if (remote.size !== copy.size || remote.gcid !== copy.gcid) throw Error("云端副本版本已变化");
    const link = originalLink(remote.raw), endpoint = link && secureDownloadUrl(link.url);
    if (!endpoint) throw Error("没有可用的下载地址");
    return { size: file.size, url: endpoint.url.href, cursor: 0n };
  }));
  const counts = [1, 2, 3, 5].filter(count => count <= files.length);
  console.log(`P3b 多文件并发：${files.length} 个副本，每轮 ${seconds} 秒，${counts.join("/")} 个文件各 ${rounds} 轮（轮流进行），每个文件 ${perFile} 个连接`);

  type FileRun = { bytes: number; statuses: Record<string, number>; rateLimited: number; forbidden: number; quota: number; errors: number; retryAfterMs: number[] };
  type Run = { files: number; round: number; seconds: number; MiBps: number; perFileKiBps: number[]; detail: FileRun[] };
  const runs: Run[] = [];
  const once = async (count: number, round: number): Promise<Run> => {
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), seconds * 1000);
    const signal = AbortSignal.any([deadline.signal, stop.signal]), started = performance.now();
    const detail = await Promise.all(files.slice(0, count).map(async target => {
      const run: FileRun = { bytes: 0, statuses: {}, rateLimited: 0, forbidden: 0, quota: 0, errors: 0, retryAfterMs: [] };
      // 同一文件的多个连接共用该文件的偏移游标，各自领取下一段。
      await Promise.all(Array.from({ length: perFile }, () => connection(target, run, signal)));
      return run;
    }));
    clearTimeout(timer);
    const elapsed = (performance.now() - started) / 1000, total = detail.reduce((sum, item) => sum + item.bytes, 0);
    return { files: count, round, seconds: Math.round(elapsed * 10) / 10, MiBps: Math.round(total / MiB / elapsed * 1000) / 1000,
      perFileKiBps: detail.map(item => Math.round(item.bytes / 1024 / elapsed)), detail };
  };
  const connection = async (target: (typeof files)[number], run: FileRun, signal: AbortSignal) => {
      while (!signal.aborted) {
        if (target.cursor >= target.size) target.cursor = 0n;
        const start = target.cursor, end = start + REQUEST - 1n < target.size ? start + REQUEST - 1n : target.size - 1n;
        target.cursor = end + 1n;
        const response = await fetch(target.url, { headers: { Range: `bytes=${start}-${end}`, "Accept-Encoding": "identity" }, redirect: "error", signal }).catch(() => null);
        if (!response) { if (!signal.aborted) run.errors++; break; }
        run.statuses[response.status] = (run.statuses[response.status] ?? 0) + 1;
        if (response.status !== 206) {
          const delay = retryAfter(response.headers.get("retry-after"));
          if (delay !== undefined) run.retryAfterMs.push(delay);
          if (response.status === 429) run.rateLimited++; else if (response.status === 403 || response.status === 401) run.forbidden++; else if (response.status === 402) run.quota++;
          await response.body?.cancel().catch(() => {});
          if (response.status === 402) break;
          await Bun.sleep(Math.min(delay ?? 5000, 10000));
          continue;
        }
        const reader = response.body!.getReader();
        try { while (true) { const part = await reader.read(); if (part.done) break; run.bytes += part.value.byteLength; } }
        catch { if (!signal.aborted) run.errors++; }
        finally { reader.cancel().catch(() => {}); }
      }
  };
  for (let round = 1; round <= rounds && !stop.signal.aborted; round++) {
    for (const count of counts) {
      if (stop.signal.aborted) break;
      const run = await once(count, round);
      runs.push(run);
      console.log(JSON.stringify({ files: run.files, round: run.round, MiBps: run.MiBps, perFileKiBps: run.perFileKiBps,
        rateLimited: run.detail.reduce((sum, item) => sum + item.rateLimited, 0), forbidden: run.detail.reduce((sum, item) => sum + item.forbidden, 0),
        quota: run.detail.reduce((sum, item) => sum + item.quota, 0), errors: run.detail.reduce((sum, item) => sum + item.errors, 0) }));
      await Bun.sleep(3000);
    }
  }
  const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] ?? 0; };
  const summary = counts.map(count => {
    const group = runs.filter(run => run.files === count);
    return { files: count, medianMiBps: median(group.map(run => run.MiBps)), runs: group.length,
      rateLimited: group.reduce((sum, run) => sum + run.detail.reduce((total, item) => total + item.rateLimited, 0), 0),
      forbidden: group.reduce((sum, run) => sum + run.detail.reduce((total, item) => total + item.forbidden, 0), 0),
      quota: group.reduce((sum, run) => sum + run.detail.reduce((total, item) => total + item.quota, 0), 0) };
  });
  const single = summary[0]?.medianMiBps || NaN;
  const ratios = Object.fromEntries(summary.map(item => [item.files, Math.round(item.medianMiBps / single * 100) / 100]));
  console.log(JSON.stringify({ summary, ratiosToSingle: ratios }));
  if (output) await writeFile(output, `${JSON.stringify({ at: new Date().toISOString(), secondsPerRun: seconds, connectionsPerFile: perFile, copiesMiB: files.map(item => Math.round(Number(item.size) / MiB)), runs, summary, ratiosToSingle: ratios }, null, 2)}\n`);
} catch (error) {
  console.log(`P3b 未完成：${error instanceof Error ? error.message : "未知错误"}`);
  process.exitCode = 1;
} finally { store.close(); lock.release(); }
