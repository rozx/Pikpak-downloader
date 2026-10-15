// P1：真实 CDN 多连接验证。同一个签名地址上用 1/2/4/8 个并发 Range 连接各运行 3 次，
// 记录合计吞吐、状态码与 Content-Range、429/403/402 次数与 Retry-After，并测量地址有效期。
// 只读取本工具任务库里已保留的云端副本；不写本地文件，不输出签名地址、凭据或文件名。
//
// 用法（需先退出正在运行的界面或 watch，本程序持有执行锁）：
//   bun spikes/segment-download/p1-cdn.ts --list
//   bun spikes/segment-download/p1-cdn.ts <文件任务ID> [结果 JSON 路径] [--seconds 30] [--lifetime-minutes 20]
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

const MiB = 1048576, CHUNK = 8n * 1048576n, MIN_SIZE = 256n * 1048576n;
const args = process.argv.slice(2);
const option = (name: string, fallback: number) => { const index = args.indexOf(name); return index >= 0 ? Number(args[index + 1]) : fallback; };
const positional = args.filter((value, index) => !value.startsWith("--") && !args[index - 1]?.startsWith("--"));
const seconds = option("--seconds", 30), lifetimeMinutes = option("--lifetime-minutes", 20);

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
  if (args.includes("--list") || !positional[0]) {
    console.log(candidates.length ? "可用的测试副本（≥ 256 MiB、云端副本保留中）：" : "没有 ≥ 256 MiB 且云端副本保留中的文件。");
    for (const { file } of candidates) console.log(`  ${file.id}  ${(Number(file.size) / MiB).toFixed(1)} MiB  状态 ${file.state}`);
    process.exit(0);
  }
  const picked = candidates.find(candidate => candidate.file.id === positional[0]);
  if (!picked) throw Error("指定的文件任务不存在、小于 256 MiB 或云端副本不在保留中");
  const output = positional[1];

  const manager = new SessionManager(systemSecrets(), undefined, () => {});
  if (await manager.existingLogin() !== account) throw Error("登录会话与任务库账号不一致");
  const drive = new Drive(new PikpakClient(manager, store), account);
  const lease = async () => {
    const remote = await drive.file(picked.copy.remoteId, stop.signal);
    if (remote.id !== picked.copy.remoteId || remote.size !== picked.copy.size || remote.gcid !== picked.copy.gcid) throw Error("云端副本版本已变化");
    const link = originalLink(remote.raw), endpoint = link && secureDownloadUrl(link.url);
    if (!endpoint) throw Error("没有可用的下载地址");
    const entry = (remote.raw.links as Record<string, Record<string, unknown>> | undefined)?.["application/octet-stream"];
    const expire = typeof entry?.expire === "string" ? Date.parse(entry.expire) : NaN;
    return { url: endpoint.url.href, issuedAt: Date.now(), expiresInSeconds: Number.isFinite(expire) ? Math.round((expire - Date.now()) / 1000) : null };
  };
  const size = picked.file.size;
  console.log(`P1 CDN 测试：副本 ${(Number(size) / MiB).toFixed(1)} MiB，每轮 ${seconds} 秒，1/2/4/8 连接各 3 轮（轮流进行）`);

  let current = await lease();
  const first = current;
  let cursor = 0n;
  // 每轮从上一轮结束处继续领取分块，避免重复请求同一区间带来的缓存偏差。
  const nextRange = () => {
    if (cursor >= size) cursor = 0n;
    const start = cursor, end = start + CHUNK - 1n < size ? start + CHUNK - 1n : size - 1n;
    cursor = end + 1n; return { start, end };
  };
  type Run = { connections: number; round: number; seconds: number; bytes: number; MiBps: number; statuses: Record<string, number>;
    contentRangeMismatch: number; encoded: number; rateLimited: number; forbidden: number; quota: number; retryAfterMs: number[]; errors: number; refreshed: number };
  const runs: Run[] = [];
  const once = async (connections: number, round: number): Promise<Run> => {
    const run: Run = { connections, round, seconds: 0, bytes: 0, MiBps: 0, statuses: {}, contentRangeMismatch: 0, encoded: 0, rateLimited: 0, forbidden: 0, quota: 0, retryAfterMs: [], errors: 0, refreshed: 0 };
    const deadline = new AbortController(), started = performance.now();
    const timer = setTimeout(() => deadline.abort(), seconds * 1000);
    const signal = AbortSignal.any([deadline.signal, stop.signal]);
    const worker = async () => {
      while (!signal.aborted) {
        const { start, end } = nextRange(), used = current;
        let response: Response;
        try {
          response = await fetch(used.url, { headers: { Range: `bytes=${start}-${end}`, "Accept-Encoding": "identity" }, redirect: "error", signal });
        } catch { if (!signal.aborted) run.errors++; return; }
        run.statuses[response.status] = (run.statuses[response.status] ?? 0) + 1;
        if (response.status === 429 || response.status === 402 || response.status === 401 || response.status === 403) {
          const delay = retryAfter(response.headers.get("retry-after"));
          if (delay !== undefined) run.retryAfterMs.push(delay);
          await response.body?.cancel().catch(() => {});
          if (response.status === 429) { run.rateLimited++; await Bun.sleep(Math.min(delay ?? 5000, 10000)); continue; }
          if (response.status === 402) { run.quota++; return; }
          run.forbidden++;
          // 地址失效：只由使用这一代地址的连接刷新一次。
          if (current === used) { current = await lease(); run.refreshed++; }
          continue;
        }
        if (response.status !== 206 || response.headers.get("content-range") !== `bytes ${start}-${end}/${size}`) run.contentRangeMismatch++;
        if (![null, "identity"].includes(response.headers.get("content-encoding"))) run.encoded++;
        if (!response.body) continue;
        const reader = response.body.getReader();
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            run.bytes += part.value.byteLength;
          }
        } catch { if (!signal.aborted) run.errors++; }
        finally { await reader.cancel().catch(() => {}); }
      }
    };
    await Promise.all(Array.from({ length: connections }, worker));
    clearTimeout(timer);
    run.seconds = Math.round((performance.now() - started) / 100) / 10;
    run.MiBps = Math.round(run.bytes / MiB / run.seconds * 1000) / 1000;
    return run;
  };
  for (let round = 1; round <= 3 && !stop.signal.aborted; round++) {
    for (const connections of [1, 2, 4, 8]) {
      if (stop.signal.aborted) break;
      const run = await once(connections, round);
      runs.push(run); console.log(JSON.stringify(run));
      await Bun.sleep(3000);
    }
  }
  const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] ?? 0; };
  const summary = [1, 2, 4, 8].map(connections => {
    const group = runs.filter(run => run.connections === connections);
    return { connections, medianMiBps: median(group.map(run => run.MiBps)), runs: group.length,
      rateLimited: group.reduce((sum, run) => sum + run.rateLimited, 0), forbidden: group.reduce((sum, run) => sum + run.forbidden, 0),
      quota: group.reduce((sum, run) => sum + run.quota, 0), contentRangeMismatch: group.reduce((sum, run) => sum + run.contentRangeMismatch, 0) };
  });
  const single = summary[0]!.medianMiBps || NaN;
  const ratios = Object.fromEntries(summary.map(item => [item.connections, Math.round(item.medianMiBps / single * 100) / 100]));
  console.log(JSON.stringify({ summary, ratiosToSingle: ratios }));
  const save = (lifetime: unknown) => output ? writeFile(output, `${JSON.stringify({ at: new Date().toISOString(), copyMiB: Math.round(Number(size) / MiB), secondsPerRun: seconds, runs, summary, ratiosToSingle: ratios, lifetime }, null, 2)}\n`) : Promise.resolve();
  // 先保存吞吐结果；有效期探测可以随时用 Ctrl+C 结束。
  await save(null);

  // 地址有效期：只用最初取得的那一代地址，每分钟请求 1 个字节，直到失效或达到上限。
  const lifetime = { expiresInSecondsFromApi: first.expiresInSeconds, probedMinutes: 0, invalidAfterSeconds: null as number | null, status: null as number | null };
  for (let minute = 0; minute < lifetimeMinutes && !stop.signal.aborted; minute++) {
    const response = await fetch(first.url, { headers: { Range: "bytes=0-0", "Accept-Encoding": "identity" }, redirect: "error", signal: stop.signal }).catch(() => null);
    await response?.body?.cancel().catch(() => {});
    lifetime.probedMinutes = Math.round((Date.now() - first.issuedAt) / 60000);
    if (response && response.status !== 206) { lifetime.invalidAfterSeconds = Math.round((Date.now() - first.issuedAt) / 1000); lifetime.status = response.status; break; }
    console.log(JSON.stringify({ lifetimeProbe: { minutes: lifetime.probedMinutes, status: response?.status ?? "network-error" } }));
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 60000);
      stop.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  console.log(JSON.stringify({ lifetime }));
  await save(lifetime);
} catch (error) {
  console.log(`P1 未完成：${error instanceof Error ? error.message : "未知错误"}`);
  process.exitCode = 1;
} finally { store.close(); lock.release(); }
