import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareState } from "../src/state/paths";
import { Store } from "../src/state/store";
import { acquireQueueLock } from "../src/state/lock";

test("跨进程写命令拒绝并发，status 可读，强制结束后锁文件不造成假锁", async () => {
  const root = await mkdtemp(join(tmpdir(), "pikpak-lock-test-"));
  const paths = await prepareState(root);
  const store = new Store(paths.database);
  store.ensureAccount("synthetic-account"); store.setConfig("active_account", "synthetic-account");
  const share = store.accept("synthetic-account", "synthetic-share", root, "reference"); store.close();
  const child = Bun.spawn([process.execPath, "tests/fixtures/lock-worker.ts", paths.lock], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const reader = child.stdout.getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error("worker-timeout")), 5000); })]);
    if (timeout) clearTimeout(timeout);
    expect(new TextDecoder().decode(ready.value)).toBe("held\n");
    expect(() => acquireQueueLock(paths.lock)).toThrow("已有实例");
    const run = async (...args: string[]) => {
      const proc = Bun.spawn([process.execPath, "src/cli.ts", ...args], { env: { ...process.env, PIKPAK_DOWNLOADER_STATE_DIR: root }, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code: await proc.exited, stdout, stderr };
    };
    expect((await run("status")).code).toBe(0);
    const conflict = await run("cancel", share.id);
    expect(conflict.code).toBe(1); expect(conflict.stderr).toContain("已有实例");
    child.kill("SIGKILL"); await child.exited;
    const acquired = acquireQueueLock(paths.lock); acquired.release(); acquired.release();
    expect((await run("cancel", share.id)).code).toBe(0);
    const status = await run("status", share.id);
    expect(JSON.parse(status.stdout).tasks[0].status).toBe("cancelled");
  } finally {
    if (timeout) clearTimeout(timeout);
    child.kill("SIGKILL"); await child.exited; reader.releaseLock();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
