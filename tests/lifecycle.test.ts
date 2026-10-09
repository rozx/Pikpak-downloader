import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireQueueLock } from "../src/state/lock";

test("前台主循环收到 SIGINT 后关闭监听并释放执行锁", async () => {
  const root = await mkdtemp(join(tmpdir(), "pikpak-watch-test-"));
  const child = Bun.spawn([process.execPath, "tests/fixtures/watch-worker.ts", root], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const reader = child.stdout.getReader(); let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error("start-timeout")), 5000); })]);
    if (timeout) clearTimeout(timeout);
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    child.kill("SIGINT");
    const exit = await Promise.race([child.exited, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error("stop-timeout")), 3000); })]);
    expect(exit).toBe(0);
    const lock = acquireQueueLock(join(root, "queue-lock.sqlite")); lock.release();
  } finally {
    if (timeout) clearTimeout(timeout); child.kill("SIGKILL"); await child.exited; await reader.cancel();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

test("干净状态缺登录时 watch 给出指引，配置与版本命令可独立使用", async () => {
  const root = await mkdtemp(join(tmpdir(), "pikpak-cli-test-"));
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], { env: { ...process.env, PIKPAK_DOWNLOADER_STATE_DIR: root }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { output: await new Response(child.stdout).text(), error: await new Response(child.stderr).text(), code: await child.exited };
  };
  try {
    const watch = await run("watch", "--output", root); expect(watch.code).toBe(1); expect(watch.error).toContain("login");
    expect((await run("config", "--output", root)).code).toBe(0);
    expect((await run("--version")).output.trim()).toBe("0.1.0");
    expect((await run("status")).output).toContain("未设置活动账号");
  } finally { await rm(root, { recursive: true, force: true }); }
});
