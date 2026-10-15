import { expect, test } from "bun:test";
import { RESTORE_SEQUENCE } from "../src/tui/terminal";

async function run(mode: string, signal?: NodeJS.Signals) {
  const child = Bun.spawn([process.execPath, "tests/fixtures/terminal-worker.ts", mode], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (signal) {
    const reader = child.stdout.getReader(); const first = await reader.read(); reader.releaseLock();
    expect(new TextDecoder().decode(first.value)).toContain("ready");
    child.kill(signal);
  }
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { output: stdout + stderr, code };
}

test("未处理异常与拒绝：先恢复终端，只输出面向用户的说明", async () => {
  for (const mode of ["throw", "reject"]) {
    const { output, code } = await run(mode);
    expect(code).toBe(1);
    expect(output).toContain("<unmounted>"); expect(output).toContain(RESTORE_SEQUENCE);
    expect(output).toContain("操作失败；未输出可能包含私密资料的底层错误。"); expect(output).not.toContain("secret-token-abc");
    expect(output.indexOf(RESTORE_SEQUENCE)).toBeLessThan(output.indexOf("操作失败"));
  }
  const appError = await run("app-error");
  expect(appError.code).toBe(1); expect(appError.output).toContain("授权或会话刷新失败");
});

test("终止信号：恢复终端并打印会话摘要", async () => {
  const { output, code } = await run("signal");
  expect(code).toBe(143); expect(output).toContain(RESTORE_SEQUENCE); expect(output).toContain("本次完成 1 个，未完成 2 个。");
});

test.if(process.platform !== "win32")("操作系统送达的 SIGTERM 同样恢复终端", async () => {
  const { output, code } = await run("wait", "SIGTERM");
  expect(code).toBe(143); expect(output).toContain(RESTORE_SEQUENCE);
});

test("正常退出时恢复序列只写一次", async () => {
  const { output, code } = await run("exit");
  expect(code).toBe(0); expect(output.split(RESTORE_SEQUENCE)).toHaveLength(2); expect(output).toContain("<unmounted>");
});
