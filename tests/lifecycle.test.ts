import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { version } from "../package.json";
import { acquireQueueLock } from "../src/state/lock";
import { Store } from "../src/state/store";

test("前台主循环收到 SIGINT 后关闭监听并释放执行锁", async () => {
  const root = await mkdtemp(join(tmpdir(), "pikpak-watch-test-"));
  const child = Bun.spawn([process.execPath, "tests/fixtures/watch-worker.ts", root], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const reader = child.stdout.getReader(); let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error("start-timeout")), 5000); })]);
    if (timeout) clearTimeout(timeout);
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    // Windows 上真实 Ctrl+C 走控制台事件，由实机验收覆盖；这里经标准输入触发同一 SIGINT 处理。
    if (process.platform === "win32") { child.stdin.write("SIGINT\n"); await child.stdin.flush(); }
    else child.kill("SIGINT");
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
    expect((await run("--version")).output.trim()).toBe(version);
    expect((await run("status")).output).toContain("未设置活动账号");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("config --connections 校验 1–8 并在 status 中显示；监听占锁时拒绝写入", async () => {
  const root = await mkdtemp(join(tmpdir(), "pikpak-cli-test-"));
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], { env: { ...process.env, PIKPAK_DOWNLOADER_STATE_DIR: root }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { output: await new Response(child.stdout).text(), error: await new Response(child.stderr).text(), code: await child.exited };
  };
  try {
    const saved = await run("config", "--connections", "6"); expect(saved.code).toBe(0); expect(saved.output).toContain("6");
    for (const bad of ["0", "-1", "4.5", "9"]) expect((await run("config", "--connections", bad)).code).toBe(1);
    const store = new Store(join(root, "tasks.sqlite"));
    try { expect(store.config("download_connections")).toBe("6"); store.ensureAccount("account"); store.setConfig("active_account", "account"); }
    finally { store.close(); }
    expect(JSON.parse((await run("status")).output)).toMatchObject({ connections: 6 });
    const lock = acquireQueueLock(join(root, "queue-lock.sqlite"));
    try { expect((await run("config", "--connections", "2")).code).toBe(1); } finally { lock.release(); }
    expect(JSON.parse((await run("status")).output)).toMatchObject({ connections: 6 });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);

test("config --files 校验 1–5，status 显示配置值、账号等级与实际生效值", async () => {
  const root = await mkdtemp(join(tmpdir(), "pikpak-cli-test-"));
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], { env: { ...process.env, PIKPAK_DOWNLOADER_STATE_DIR: root }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { output: await new Response(child.stdout).text(), error: await new Response(child.stderr).text(), code: await child.exited };
  };
  try {
    expect((await run("config", "--files", "3")).code).toBe(0);
    for (const bad of ["0", "6", "2.5", "-1"]) expect((await run("config", "--files", bad)).code).toBe(1);
    const store = new Store(join(root, "tasks.sqlite"));
    try { store.ensureAccount("account"); store.setConfig("active_account", "account"); } finally { store.close(); }
    expect(JSON.parse((await run("status")).output).activeFiles).toEqual({ configured: 3, tier: "unknown", tierCheckedAt: null, effective: 1 });
    const paid = new Store(join(root, "tasks.sqlite"));
    try { paid.setConfig("account_tier", JSON.stringify({ account: "account", tier: "paid", at: Date.parse("2026-10-15T00:00:00Z") })); } finally { paid.close(); }
    expect(JSON.parse((await run("status")).output).activeFiles).toEqual({ configured: 3, tier: "paid", tierCheckedAt: "2026-10-15T00:00:00.000Z", effective: 3 });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);

