import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { AppError } from "../errors";
import type { Store } from "../state/store";
import { systemSecrets } from "../auth/secrets";
import { SessionManager } from "../auth/session";
import { PikpakClient } from "../pikpak/client";
import { Drive } from "../pikpak/drive";
import { systemFiles } from "../platform/file-system";
import { systemClipboard } from "../platform/clipboard";
import { IntakeReceiver } from "../intake/receiver";
import type { Clipboard } from "../intake/clipboard";
import { Engine, type RuntimeEvent } from "./engine";
import { RuntimeSession, type SessionEngine } from "./session";
import type { LocalFileSystem } from "../platform/files";
import { AccountTier } from "../pikpak/tier";

const labels: Record<string, string> = { scanning: "正在扫描", scanned: "扫描完成", scan_incomplete: "扫描未完整完成", scan_waiting: "扫描等待处理",
  saving: "正在准备转存", downloading: "正在下载", completed: "已完成", waiting_space: "等待云端空间", paused: "执行已暂停", attention: "需要核对", file_waiting: "文件等待处理" };
// 纯文本进度：同一文件只在跨过 10% 整数倍、或距上次输出满 30 秒且百分比变化时追加一行；开始下载已有单独提示。
export function progressPrinter(now: () => number = Date.now): (event: RuntimeEvent) => string | null {
  const last = new Map<string, { decade: number; percent: number; at: number }>();
  return event => {
    if (event.type !== "progress" || !event.id) return null;
    const percent = event.size ? Number((event.bytes ?? 0n) * 100n / event.size) : 100;
    const decade = Math.floor(percent / 10);
    const previous = last.get(event.id) ?? { decade: 0, percent, at: now() };
    const print = decade > previous.decade || (percent !== previous.percent && now() - previous.at >= 30_000);
    last.set(event.id, print ? { decade, percent, at: now() } : previous);
    return print ? `下载进度 ${event.id}: ${percent}%` : null;
  };
}
const printProgress = progressPrinter();
export function printEvent(event: RuntimeEvent): void {
  if (event.type === "progress") { const line = printProgress(event); if (line) console.log(line); return; }
  console.log(`${labels[event.type] ?? event.type}${event.id ? ` ${event.id}` : ""}${event.count !== undefined ? `，文件版本数 ${event.count}` : ""}${event.reason ? `，原因：${event.reason}` : ""}`);
}
export async function watch(store: Store, output: string | null, signal: AbortSignal): Promise<void> {
  const accountId = store.config("active_account"); if (!accountId) throw new AppError("login_required");
  const configured = output ?? store.config("output_root"); if (!configured) throw new AppError("output_required");
  let root: string;
  try {
    root = await realpath(resolve(configured));
    if (!(await stat(root)).isDirectory()) throw Error("not-directory");
    await access(root, constants.W_OK | constants.X_OK);
  } catch { throw new AppError("output_unavailable"); }
  const filesystem = systemFiles();
  try {
    const { session } = await prepareRuntime(store, accountId, root, filesystem, printEvent);
    session.subscribe(event => { const message = sessionMessage(event); if (message) console.log(message); });
    await session.run(signal);
  } finally { await filesystem.close(); }
}

// watch 与全屏界面共用的启动准备：核对输出目录与登录会话，组装执行器和前台会话。
export async function prepareRuntime(store: Store, accountId: string, root: string, filesystem: LocalFileSystem,
  report: (event: RuntimeEvent) => void): Promise<{ session: RuntimeSession; drive: Drive; tier: AccountTier; manager: SessionManager }> {
  try {
    const validation = await filesystem.root(root);
    try { await validation.identity(); await validation.freeBytes(); } finally { await validation.close(); }
  } catch { throw new AppError("output_unavailable"); }
  const secrets = systemSecrets();
  if (!await secrets.get("session.current")) throw new AppError("login_required");
  const manager = new SessionManager(secrets, undefined, account => { store.ensureAccount(account); store.pause(account, "authentication"); });
  if (!store.rateLimited(accountId)) {
    try {
      const identity = await manager.existingLogin();
      if (identity !== accountId) throw new AppError("account_mismatch");
      store.clearAuthenticationPause(accountId);
    } catch { store.pause(accountId, "authentication"); }
  }
  store.setConfig("output_root", root);
  if (store.paused(accountId)?.reason === "database") store.resume(accountId,
    { authenticated: true, permitted: true, writable: true, hasSpace: true, targetAvailable: true, trafficAvailable: true });
  const client = new PikpakClient(manager, store);
  const drive = new Drive(client, accountId);
  const tier = new AccountTier(client, accountId, store);
  const engine = new Engine(store, secrets, drive, filesystem, report, undefined, undefined, { tier });
  return { session: new RuntimeSession(store, accountId, engine, new IntakeReceiver(store, secrets, accountId, root), systemClipboard()), drive, tier, manager };
}

// 会话自身的事件转成纯文本提示；执行器事件由创建执行器时传入的 printEvent 输出。
export function sessionMessage(event: RuntimeEvent): string | null {
  switch (event.type) {
    case "started": return event.reason === "clipboard_off" ? "执行已启动；剪贴板监听已在设置中关闭。Ctrl+C 停止。"
      : "监听已启动。复制完整分享文本即可接收任务；Ctrl+C 停止。确认接收前请勿快速覆盖剪贴板。";
    case "received": return `已接收 ${event.id}`;
    case "received_cancelled": return `任务 ${event.id} 已取消；retry 才会恢复。`;
    case "intake_issues": return "部分分享文本格式不支持或配对不明确，请分别复制完整文本。";
    case "intake_failed": return "部分输入未确认接收：资料或任务保存失败，请解决后重新复制。";
    case "clipboard_unavailable": return "剪贴板暂时不可读，正在退避重试；已有任务保留。";
    case "clipboard_recovered": return "剪贴板监听已恢复。";
    case "stopped": return "监听已停止，未完成任务和可恢复进度已保留。使用 status 查看，retry 重试，cancel 停止调度。";
    default: return null;
  }
}

export async function foregroundLoop(store: Store, accountId: string, clipboard: Clipboard, receiver: IntakeReceiver, engine: SessionEngine,
  signal: AbortSignal, notify: (message: string) => void = console.log): Promise<void> {
  const session = new RuntimeSession(store, accountId, engine, receiver, clipboard);
  session.subscribe(event => { const message = sessionMessage(event); if (message) notify(message); });
  await session.run(signal);
}
