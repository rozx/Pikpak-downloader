import { guardTerminal } from "../../src/tui/terminal";
import { AppError } from "../../src/errors";

// 终端守护的子进程夹具：模式决定以哪种方式退出。
const mode = process.argv[2];
guardTerminal({ restore: () => { process.stdout.write("<unmounted>"); }, summary: () => "本次完成 1 个，未完成 2 个。" });
process.stdout.write("ready\n");
if (mode === "throw") setTimeout(() => { throw new Error("secret-token-abc"); }, 0);
else if (mode === "reject") void Promise.reject(new Error("secret-token-abc"));
else if (mode === "app-error") setTimeout(() => { throw new AppError("authorization_failed"); }, 0);
else if (mode === "signal") setTimeout(() => { process.emit("SIGTERM", "SIGTERM"); }, 0);
else if (mode === "exit") setTimeout(() => process.exit(0), 0);
else setTimeout(() => {}, 60_000);
