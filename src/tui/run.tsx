import { render } from "ink";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AppError } from "../errors";
import { prepareState } from "../state/paths";
import { acquireQueueLock } from "../state/lock";
import { Store } from "../state/store";
import { systemSecrets } from "../auth/secrets";
import { SessionManager } from "../auth/session";
import { login } from "../auth/login";
import { missingPermissions } from "../auth/permissions";
import { systemFiles } from "../platform/file-system";
import { prepareRuntime } from "../runtime/watch";
import { writableDirectory } from "../runtime/session";
import { LiveController } from "./live";
import { StartupApp, type StartupDeps } from "./startup";
import { guardTerminal } from "./terminal";

// 全屏界面入口：返回退出码。持有执行锁直到退出；拿不到锁时只显示已有实例的提示，不写任务库。
export async function runTui(): Promise<number> {
  const paths = await prepareState();
  let lock: { release(): void } | null = null;
  try { lock = acquireQueueLock(paths.lock); }
  catch (error) { if (!(error instanceof AppError && error.code === "instance_busy")) throw error; }
  const store = lock ? new Store(paths.database) : null;
  const filesystem = systemFiles();
  // 当前运行时；登出或重新授权时停止它但不退出程序（improve-account-login 决策 6）。
  let runtime: { abort: AbortController; done: Promise<void>; detached: boolean } | null = null;
  let live: LiveController | null = null;
  let finish!: (code: number) => void;
  const finished = new Promise<number>(resolve => { finish = resolve; });
  const requireStore = () => { if (!store) throw new AppError("instance_busy"); return store; };
  const deps: StartupDeps = {
    busy: !store,
    account: async () => {
      const account = requireStore().config("active_account");
      return account && await systemSecrets().get("session.current") ? account : null;
    },
    missing: async () => missingPermissions(await new SessionManager(systemSecrets()).scopes()).map(permission => permission.label),
    login: async (announce, signal) => {
      const state = requireStore();
      const manager = new SessionManager(systemSecrets(), undefined, account => { state.ensureAccount(account); state.pause(account, "authentication"); });
      const account = await login(manager, true, announce, { signal });
      state.ensureAccount(account); state.setConfig("active_account", account); state.clearAuthenticationPause(account);
      return account;
    },
    outputRoot: async () => {
      const root = requireStore().config("output_root");
      if (!root) return null;
      try { return await writableDirectory(root); } catch { return null; }
    },
    defaultOutputRoot: join(homedir(), "Downloads", "PikPak"),
    saveOutputRoot: async path => {
      try { await mkdir(path, { recursive: true }); requireStore().setConfig("output_root", await writableDirectory(path)); return { ok: true }; }
      catch { return { ok: false, reason: "output_unavailable" }; }
    },
    start: async account => {
      const state = requireStore(), root = state.config("output_root");
      if (!root) throw new AppError("output_unavailable");
      const { session, drive, tier, manager } = await prepareRuntime(state, account, root, filesystem, () => {});
      const abort = new AbortController();
      const controller = new LiveController({ store: state, accountId: account, session, quota: () => drive.quota(), tier: () => tier.current,
        // 账号页资料：账号名称与邮箱读不到时只显示 ID；授权范围来自会话记录。
        account: async () => {
          await tier.refresh();
          let profile: { id: string; name: string | null; email: string | null } = { id: account, name: null, email: null };
          try { profile = await manager.profile(account); } catch { /* 保留 ID。 */ }
          return { ...profile, scopes: await manager.scopes(), membership: tier.membership };
        },
        // 按当前的默认下载目录计算剩余空间；在设置页改到另一个磁盘后随之更新。
        localFree: async () => {
          const directory = await filesystem.root(state.config("output_root") ?? root);
          try { return await directory.freeBytes(); } finally { await directory.close(); }
        },
        // 有界停止：会话 10 秒内仍未结束则强制退出；任务库按可随时中断设计。
        stop: () => { abort.abort(); setTimeout(() => finish(130), 10_000).unref(); },
        forceExit: () => finish(130) });
      live = controller; controller.start();
      const current: NonNullable<typeof runtime> = { abort, detached: false, done: Promise.resolve() };
      current.done = session.run(abort.signal).then(() => { if (!current.detached) finish(0); }, () => { if (!current.detached) finish(1); });
      runtime = current;
      return controller;
    },
    // 在安全点停止当前执行并保存进度，不退出程序；30 秒内未停止时报告失败，不同时运行两个执行器。
    suspend: async () => {
      const current = runtime;
      if (!current) return;
      current.detached = true; live?.dispose(); current.abort.abort();
      const stopped = await Promise.race([current.done.then(() => true), Bun.sleep(30_000).then(() => false)]);
      if (!stopped) throw new Error("suspend-timeout");
      runtime = null;
    },
    logout: async () => {
      const state = requireStore(), account = state.config("active_account");
      if (account) state.pause(account, "authentication");
      await new SessionManager(systemSecrets()).logout();
    },
    exit: code => finish(code),
  };
  const instance = render(<StartupApp deps={deps} />, { exitOnCtrlC: false, alternateScreen: true, maxFps: 10, incrementalRendering: true });
  const guard = guardTerminal({ restore: () => instance.unmount(), summary: () => live?.summary() ?? null });
  const code = await finished;
  (live as LiveController | null)?.dispose();
  guard.restore(); guard.dispose();
  const summary = (live as LiveController | null)?.summary();
  if (summary) process.stdout.write(`${code === 130 ? "已立即退出。" : "已停止，进度已保存。"}${summary}\n`);
  // 立即退出时不等待仍在进行的网络操作；正常退出时会话已结束，可以安全关闭资源。
  if (code !== 130) { await filesystem.close(); store?.close(); lock?.release(); }
  return code;
}
