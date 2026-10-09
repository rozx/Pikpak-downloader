import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

if (process.platform === "darwin") {
  const root = resolve(import.meta.dir, "..");
  await mkdir(`${root}/dist/native`, { recursive: true });
  const headers = process.env.NODE_API_HEADERS ?? "/opt/homebrew/include/node";
  if (!await Bun.file(`${headers}/node_api.h`).exists()) throw Error("请通过 NODE_API_HEADERS 指定 Node-API 头文件路径");
  for (const [arch, clangArch] of [["arm64", "arm64"], ["x64", "x86_64"]] as const) {
    const child = Bun.spawn(["/usr/bin/clang++", "-std=c++17", "-fobjc-arc", "-mmacosx-version-min=13.0", "-arch", clangArch,
      "-bundle", "-undefined", "dynamic_lookup", "-I", headers, "-framework", "AppKit",
      "-o", `${root}/dist/native/macos-${arch}.node`, `${root}/native/macos.mm`],
      { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    if (await child.exited !== 0) process.exit(1);
  }
}
