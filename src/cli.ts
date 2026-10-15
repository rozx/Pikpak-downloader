#!/usr/bin/env bun
import { AppError, publicError } from "./errors";
import { version } from "../package.json";
import { join, resolve } from "node:path";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { prepareState, stateRoot } from "./state/paths";
import { acquireQueueLock } from "./state/lock";
import { Store } from "./state/store";
import { systemSecrets } from "./auth/secrets";
import { SessionManager } from "./auth/session";
import { login } from "./auth/login";
import { clipboardWorker } from "./intake/clipboard-worker";
import { watch } from "./runtime/watch";
import { interruptible } from "./runtime/lifecycle";

const help = `PikPak Downloader ${version}（开发中）
把 PikPak 云盘作为下载中转空间。

用法：pikpak-downloader <命令> [选项]

  --help                 显示帮助
  --version              显示版本
  login [--force]         浏览器登录或核对已有会话
  logout                 清除认证令牌并保留任务
  watch [--output <目录>] 前台监听剪贴板并处理下载队列
  status [任务ID]        只读查看任务状态
  config --output <目录> 设置新分享的默认目录
  retry <任务ID>         开启新的有限重试周期
  cancel <任务ID>        停止调度并保留资源

尚未完成真实综合验收；Windows 与其他架构仍需实际运行验证。
`;

function activeAccount(store: Store): string {
  const account = store.config("active_account");
  if (!account) throw new AppError("login_required");
  return account;
}

export async function runCli(args: string[]): Promise<void> {
  if (args[0] === "--internal-clipboard") {
    if (process.stdin.isTTY || process.stdout.isTTY) throw new AppError("invalid_input");
    await clipboardWorker(args[1]); return;
  }
  if (!args.length || (args.length === 1 && ["--help", "-h", "help"].includes(args[0]!))) {
    console.log(help); return;
  }
  if (args.length === 1 && ["--version", "-v"].includes(args[0]!)) { console.log(version); return; }
  const command = args[0];
  if (command === "status") {
    if (args.length > 2) throw new AppError("invalid_input");
    const database = join(stateRoot(), "tasks.sqlite");
    if (!await Bun.file(database).exists()) { console.log("尚无任务记录。请先登录并配置下载目录。"); return; }
    const store = new Store(database, true);
    try {
      const account = store.config("active_account");
      if (!account) { console.log("未设置活动账号，请先登录。"); return; }
      if (args[1]?.startsWith("f_")) {
        const file = store.file(account, args[1]);
        console.log(JSON.stringify({ id: file.id, state: file.state === "completed" ? "completed" : file.cancelled ? "cancelled" : file.state, retries: Number(file.retries), reason: file.lastError }));
      } else {
        const shares = args[1] ? [store.share(account, args[1])] : store.shares(account);
        console.log(JSON.stringify({ paused: store.paused(account), tasks: shares.map(share => ({ id: share.id, ...store.summary(account, share.id) })) }, null, 2));
      }
    } finally { store.close(); }
    return;
  }
  if (["config", "retry", "cancel", "login", "logout", "watch"].includes(command!)) {
    if (command === "config" ? args.length !== 3 || args[1] !== "--output" : ["retry", "cancel"].includes(command!) && args.length !== 2) throw new AppError("invalid_input");
    if (command === "login" && (args.length > 2 || (args[1] && args[1] !== "--force"))) throw new AppError("invalid_input");
    if (command === "logout" && args.length !== 1) throw new AppError("invalid_input");
    if (command === "watch" && args.length !== 1 && !(args.length === 3 && args[1] === "--output")) throw new AppError("invalid_input");
    const paths = await prepareState();
    const lock = acquireQueueLock(paths.lock);
    try {
      const store = new Store(paths.database);
      try {
        if (command === "watch") {
          await interruptible(signal => watch(store, args[2] ?? null, signal));
          return;
        }
        if (command === "login" || command === "logout") {
          const session = new SessionManager(systemSecrets(), undefined, account => { store.ensureAccount(account); store.pause(account, "authentication"); });
          if (command === "logout") {
            const account = store.config("active_account");
            if (account) store.pause(account, "authentication");
            await session.logout();
            console.log("已登出。任务历史、分享资料和下载文件均保留。");
          } else {
            const account = await login(session, args[1] === "--force");
            store.ensureAccount(account); store.setConfig("active_account", account); store.clearAuthenticationPause(account);
            console.log("登录成功，账号身份与容量读取已核对。");
          }
          return;
        }
        if (command === "config") {
          const output = await realpath(resolve(args[2]!));
          if (!(await stat(output)).isDirectory()) throw new AppError("invalid_input");
          await access(output, constants.W_OK | constants.X_OK);
          store.setConfig("output_root", output);
          console.log("已保存新分享的默认下载目录；已有分享保持原目录。");
        } else {
          const account = activeAccount(store);
          if (command === "cancel") { store.cancel(account, args[1]!); store.recheckCancelledPause(account); console.log("已取消未完成工作；本地文件、云端副本和操作记录均保留。"); }
          else { store.retry(account, args[1]!); console.log("已安排重试；已完成版本保持不变，未知操作仍需先核对。"); }
        }
      } finally { store.close(); }
    } finally { lock.release(); }
    return;
  }
  throw new AppError("invalid_input");
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  try { await runCli(args); }
  catch (error) { console.error(publicError(error)); process.exitCode = 1; }
}

if (import.meta.main) await main();
