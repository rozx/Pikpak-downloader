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

const labels: Record<string, string> = { scanning: "正在扫描", scanned: "扫描完成", scan_incomplete: "扫描未完整完成", scan_waiting: "扫描等待处理",
  saving: "正在准备转存", downloading: "正在下载", completed: "已完成", waiting_space: "等待云端空间", paused: "执行已暂停", attention: "需要核对", file_waiting: "文件等待处理" };
const printedPercent = new Map<string, number>();
export function printEvent(event: RuntimeEvent): void {
  if (event.type === "progress") {
    // 进度事件每秒最多 4 次；同一文件的百分比未变化时不重复打印。
    const percent = event.size ? Number((event.bytes ?? 0n) * 100n / event.size) : 100;
    if (event.id && printedPercent.get(event.id) === percent) return;
    if (event.id) printedPercent.set(event.id, percent);
    console.log(`下载进度 ${event.id}: ${percent}%`); return;
  }
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
  try { await startWatch(store, accountId, root, signal, filesystem); }
  finally { await filesystem.close(); }
}

async function startWatch(store: Store, accountId: string, root: string, signal: AbortSignal, filesystem: LocalFileSystem): Promise<void> {
  try {
    const validation = await filesystem.root(root);
    try { await validation.identity(); await validation.freeBytes(); } finally { await validation.close(); }
  } catch { throw new AppError("output_unavailable"); }
  const secrets = systemSecrets();
  if (!await secrets.get("session.current")) throw new AppError("login_required");
  const session = new SessionManager(secrets, undefined, account => { store.ensureAccount(account); store.pause(account, "authentication"); });
  if (!store.rateLimited(accountId)) {
    try {
      const identity = await session.existingLogin();
      if (identity !== accountId) throw new AppError("account_mismatch");
      store.clearAuthenticationPause(accountId);
    } catch { store.pause(accountId, "authentication"); }
  }
  store.setConfig("output_root", root);
  if (store.paused(accountId)?.reason === "database") store.resume(accountId,
    { authenticated: true, permitted: true, writable: true, hasSpace: true, targetAvailable: true, trafficAvailable: true });
  const clipboard = systemClipboard();
  const receiver = new IntakeReceiver(store, secrets, accountId, root);
  const engine = new Engine(store, secrets, new Drive(new PikpakClient(session, store), accountId), filesystem, printEvent);
  await foregroundLoop(store, accountId, clipboard, receiver, engine, signal);
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
