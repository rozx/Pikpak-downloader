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
import { pollClipboard, type Clipboard } from "../intake/clipboard";
import { Engine, type RuntimeEvent } from "./engine";
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

export async function foregroundLoop(store: Store, accountId: string, clipboard: Clipboard, receiver: IntakeReceiver, engine: Engine,
  signal: AbortSignal, notify: (message: string) => void = console.log): Promise<void> {
  const stop = new AbortController();
  const combined = AbortSignal.any([signal, stop.signal]);
  let wake: (() => void) | undefined;
  const intake = pollClipboard(clipboard, combined, async snapshot => {
    const result = await receiver.receive(snapshot);
    for (const id of result.ids) {
      const share = store.share(accountId, id);
      notify(share.cancelled ? `任务 ${id} 已取消；retry 才会恢复。` : `已接收 ${id}`);
    }
    if (result.issues.length) notify("部分分享文本格式不支持或配对不明确，请分别复制完整文本。");
    if (result.failure) { engine.blockPersistence(); notify("部分输入未确认接收：资料或任务保存失败，请解决后重新复制。"); }
    wake?.();
  }, failed => notify(failed ? "剪贴板暂时不可读，正在退避重试；已有任务保留。" : "剪贴板监听已恢复。"));
  // 监听异常由主流程接收，避免未处理拒绝输出底层数据。
  const intakeResult = intake.catch(() => { engine.blockPersistence(); stop.abort(); });
  notify("监听已启动。复制完整分享文本即可接收任务；Ctrl+C 停止。确认接收前请勿快速覆盖剪贴板。");
  try {
    await engine.resumeLocalPause(combined);
    await engine.resumeTrafficPause(combined);
    if (!store.paused(accountId)) await engine.reconcile(combined);
    while (!combined.aborted) {
      try { if (await engine.step(combined)) continue; }
      catch { engine.blockPersistence(); }
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); combined.removeEventListener("abort", done); wake = undefined; resolve(); };
        const timer = setTimeout(done, 500); wake = done; combined.addEventListener("abort", done, { once: true });
        if (combined.aborted) done();
      });
    }
  } finally {
    stop.abort(); wake?.(); await intakeResult;
    notify("监听已停止，未完成任务和可恢复进度已保留。使用 status 查看，retry 重试，cancel 停止调度。");
  }
}
