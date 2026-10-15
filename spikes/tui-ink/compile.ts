import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BunPlugin } from "bun";

const targets = ["bun-darwin-arm64", "bun-darwin-x64", "bun-windows-x64", "bun-windows-arm64"] as const;
type Target = typeof targets[number];
const requested = process.argv.slice(2);
const selected = requested.length ? requested : [...targets];
const ink = await Bun.file(join(import.meta.dir, "node_modules/ink/package.json")).json() as { version: string };

// Ink 的开发工具模块静态导入可选依赖 react-devtools-core；标为外部会被提升到产物顶层并在启动时解析失败。
// 打包时换成无副作用的空实现：只有 DEV=true 且能解析到该包时 Ink 才会调用它。
const devtoolsStub: BunPlugin = {
  name: "react-devtools-core-stub",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "devtools-stub" }));
    build.onLoad({ filter: /.*/, namespace: "devtools-stub" }, () => ({
      contents: "export default { initialize() {}, connectToDevTools() {} };", loader: "js",
    }));
  },
};

await mkdir(join(import.meta.dir, "dist"), { recursive: true });
const results: Array<{ target: string; ok: boolean; sizeMiB: string }> = [];
for (const target of selected) {
  if (!targets.some(known => known === target)) throw Error(`未知目标：${target}`);
  const outfile = join(import.meta.dir, "dist", `tui-ink-${target.replace("bun-", "")}${target.includes("windows") ? ".exe" : ""}`);
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "app.tsx")],
    // 独立产物不读取运行目录下的 .env 和 bunfig.toml，避免用户目录中的文件改变程序行为。
    compile: { target: target as Target, outfile, autoloadDotenv: false, autoloadBunfig: false },
    define: { INK_VERSION: JSON.stringify(ink.version) },
    plugins: [devtoolsStub],
  });
  for (const log of build.logs) console.error(String(log));
  results.push({ target, ok: build.success, sizeMiB: build.success ? ((await stat(outfile)).size / 1048576).toFixed(1) : "-" });
}
console.table(results);
if (results.some(result => !result.ok)) process.exitCode = 1;
