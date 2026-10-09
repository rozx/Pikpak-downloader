import { mkdir } from "node:fs/promises";

if (process.platform !== "darwin") throw Error("此探针只能在 macOS 构建");
await mkdir(`${import.meta.dir}/dist`, { recursive: true });
const headerDir = process.env.NODE_API_HEADERS ?? "/opt/homebrew/include/node";
if (!await Bun.file(`${headerDir}/node_api.h`).exists()) throw Error("请用 NODE_API_HEADERS 指定 Node-API 头文件目录");
const child = Bun.spawn(["/usr/bin/clang++", "-std=c++17", "-fobjc-arc", "-bundle", "-undefined", "dynamic_lookup",
  "-I", headerDir, "-framework", "AppKit", "-o", `${import.meta.dir}/dist/macos.node`, `${import.meta.dir}/native/macos.mm`],
  { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
if (await child.exited !== 0) process.exit(1);
