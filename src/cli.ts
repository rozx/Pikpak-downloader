#!/usr/bin/env bun
import { AppError, publicError } from "./errors";
import { about } from "./about";
import { join, resolve } from "node:path";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { prepareState, stateRoot } from "./state/paths";
import { acquireQueueLock } from "./state/lock";
import { Store } from "./state/store";
import { systemSecrets } from "./auth/secrets";
import { SessionManager } from "./auth/session";
import { login } from "./auth/login";
import { informativeScopes, missingPermissions, permissionNames, permissionRows } from "./auth/permissions";
import { clipboardWorker } from "./intake/clipboard-worker";
import { watch } from "./runtime/watch";
import { interruptible } from "./runtime/lifecycle";
import { configuredConnections, saveConnections } from "./download/connections";
import { configuredActiveFiles, saveActiveFiles } from "./runtime/active-files";
import { storedTier, tierCap } from "./pikpak/tier";

const help = `${about.name} ${about.version}（开发中）
把 PikPak 云盘作为下载中转空间。作者 ${about.author} · ${about.homepage}

用法：pikpak-downloader              在交互终端中打开全屏界面（检查登录与下载目录后开始监听）
      pikpak-downloader <命令> [选项] 供脚本或非交互场景使用

  --help                 显示帮助
  --version              显示版本
  login [--force]         浏览器登录或核对已有会话
  permissions            查看当前授权的权限
  logout                 清除认证令牌并保留任务
  watch [--output <目录>] 前台监听剪贴板并处理下载队列
  status [任务ID]        只读查看任务状态
  config --output <目录> 设置新分享的默认目录
  config --connections <1-8>
                         设置单个文件的下载连接数（默认 4）
  config --files <1-5>   设置同时下载的文件数（默认 1；免费账号只能 1）
  retry <任务ID>         开启新的有限重试周期
  cancel <任务ID>        停止调度并保留资源

尚未完成真实综合验收；Windows 与其他架构仍需实际运行验证。
`;

// 打印服务端返回的授权范围与每项权限的判定；范围不含应用权限时说明无法确认。
async function printPermissions(session: SessionManager, raw: boolean): Promise<void> {
  const scopes = await session.scopes();
  if (raw) console.log(`服务端返回的授权范围：${scopes?.join(" ") || "未返回"}`);
  if (!informativeScopes(scopes)) {
    console.log("服务端返回的授权范围不含应用权限，无法确认授权页的勾选结果；操作被拒绝时请用 login --force 重新授权并勾选全部权限。");
    return;
  }
  for (const row of permissionRows(scopes)) console.log(`  ${row.state === "granted" ? "✓" : "✗"} ${row.label}（${row.scope}）${row.state === "missing" ? (row.required ? " 缺少" : " 未授予，本工具暂不使用") : ""}`);
  const missing = missingPermissions(scopes);
  if (missing.length) console.log(`缺少必须的权限：${permissionNames(missing)}。请运行 login --force 重新授权并勾选全部权限。`);
}

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
  // 只有标准输入与输出都是交互终端时才进入全屏界面；重定向或管道中打印纯文本帮助。
  if (!args.length && process.stdin.isTTY && process.stdout.isTTY) {
    const { runTui } = await import("./tui/run");
    const code = await runTui();
    if (code === 130) process.exit(code);
    process.exitCode = code; return;
  }
  if (!args.length || (args.length === 1 && ["--help", "-h", "help"].includes(args[0]!))) {
    console.log(help); return;
  }
  if (args.length === 1 && ["--version", "-v"].includes(args[0]!)) { console.log(about.version); return; }
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
        // status 不联网：账号等级取上一次会话读到的结果，未读过时按未知（同时只下载 1 个文件）显示。
        const tier = storedTier(store, account), configured = configuredActiveFiles(store);
        const activeFiles = { configured, tier: tier?.tier ?? "unknown", tierCheckedAt: tier ? new Date(tier.at).toISOString() : null,
          effective: Math.min(configured, tierCap(tier?.tier ?? "unknown")) };
        console.log(JSON.stringify({ paused: store.paused(account), connections: configuredConnections(store), activeFiles,
          tasks: shares.map(share => ({ id: share.id, ...store.summary(account, share.id) })) }, null, 2));
      }
    } finally { store.close(); }
    return;
  }
  if (["config", "retry", "cancel", "login", "logout", "watch", "permissions"].includes(command!)) {
    if (command === "config" ? args.length !== 3 || !["--output", "--connections", "--files"].includes(args[1]!) : ["retry", "cancel"].includes(command!) && args.length !== 2) throw new AppError("invalid_input");
    if (command === "login" && (args.length > 2 || (args[1] && args[1] !== "--force"))) throw new AppError("invalid_input");
    if ((command === "logout" || command === "permissions") && args.length !== 1) throw new AppError("invalid_input");
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
        if (command === "permissions") {
          const session = new SessionManager(systemSecrets());
          if (!await session.scopes() && !await systemSecrets().get("session.current")) console.log("尚未登录。");
          else await printPermissions(session, true);
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
            await printPermissions(session, false);
          }
          return;
        }
        if (command === "config" && args[1] === "--files") {
          console.log(`已保存同时下载的文件数 ${saveActiveFiles(store, args[2]!)}；实际生效值受账号等级限制，免费账号只能同时下载 1 个文件。`);
        } else if (command === "config" && args[1] === "--connections") {
          console.log(`已保存下载连接数 ${saveConnections(store, args[2]!)}；从下一个文件开始生效。`);
        } else if (command === "config") {
          const output = await realpath(resolve(args[2]!));
          if (!(await stat(output)).isDirectory()) throw new AppError("invalid_input");
          await access(output, constants.W_OK | constants.X_OK);
          store.setConfig("output_root", output);
          const account = store.config("active_account"), moved = account ? store.moveUnstartedShares(account, output).length : 0;
          console.log(`已保存默认下载目录${moved ? `；${moved} 个尚未开始的分享改用新目录` : ""}；已开始或已完成的分享保留原目录。`);
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
