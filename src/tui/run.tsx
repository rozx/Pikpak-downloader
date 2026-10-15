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
  const runtime = new AbortController();
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
      const { session, drive } = await prepareRuntime(state, account, root, filesystem, () => {});
      const controller = new LiveController({ store: state, accountId: account, session, quota: () => drive.quota(),
        localFree: async () => { const directory = await filesystem.root(root); try { return await directory.freeBytes(); } finally { await directory.close(); } },
        // 有界停止：会话 10 秒内仍未结束则强制退出；任务库按可随时中断设计。
        stop: () => { runtime.abort(); setTimeout(() => finish(130), 10_000).unref(); },
        forceExit: () => finish(130) });
      live = controller; controller.start();
      void session.run(runtime.signal).then(() => finish(0), () => finish(1));
      return controller;
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
