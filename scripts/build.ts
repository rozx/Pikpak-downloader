import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BunPlugin } from "bun";

const root = resolve(import.meta.dir, "..");
const targets = ["bun-darwin-arm64", "bun-darwin-x64", "bun-windows-x64", "bun-windows-arm64", "bun-linux-x64", "bun-linux-arm64"] as const;
type Target = typeof targets[number];
const isTarget = (value: string): value is Target => targets.some(known => known === value);
const requested = process.argv.slice(2);
const selected = requested.length ? requested : [`bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`];
if (selected.some(target => target.startsWith("bun-darwin")) && process.platform === "darwin") await import("./build-native");

// Ink 静态导入仅在 DEV=true 时使用的可选依赖 react-devtools-core。标为外部会被提升到产物顶层，独立产物启动即因找不到该包退出；
// 打包时换成无副作用的空实现。
const devtoolsStub: BunPlugin = {
  name: "react-devtools-core-stub",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "devtools-stub" }));
    build.onLoad({ filter: /.*/, namespace: "devtools-stub" }, () => ({
      contents: "export default { initialize() {}, connectToDevTools() {} };", loader: "js",
    }));
  },
};

await mkdir(join(root, "dist"), { recursive: true });
for (const target of selected) {
  if (!isTarget(target)) throw Error("目标必须是声明的 macOS、Windows 或 Linux 架构");
  const outfile = join(root, "dist", `pikpak-dl-cli-${target.replace("bun-", "")}${target.includes("windows") ? ".exe" : ""}`);
  const platform = target.includes("windows") ? "win32" : target.includes("linux") ? "linux" : "darwin";
  const arch = target.endsWith("arm64") ? "arm64" : "x64";
  const build = await Bun.build({
    entrypoints: [join(root, "src/main.ts")],
    // 独立产物不读取运行目录下的 .env 与 bunfig.toml，避免用户目录中的文件改变程序行为。
    compile: { target, outfile, autoloadDotenv: false, autoloadBunfig: false },
    minify: { syntax: true },
    define: { "process.platform": JSON.stringify(platform), "process.arch": JSON.stringify(arch) },
    plugins: [devtoolsStub],
  });
  for (const log of build.logs) console.error(String(log));
  if (!build.success) process.exit(1);
  console.log(`已生成 ${outfile}`);
}
