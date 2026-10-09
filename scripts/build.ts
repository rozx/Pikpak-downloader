import { mkdir } from "node:fs/promises";

const targets = ["bun-darwin-arm64", "bun-darwin-x64", "bun-windows-x64", "bun-windows-arm64"] as const;
const requested = process.argv.slice(2);
const selected = requested.length ? requested : [`bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`];
if (selected.some(target => target.startsWith("bun-darwin")) && process.platform === "darwin") await import("./build-native");
await mkdir("dist", { recursive: true });
for (const target of selected) {
  if (!targets.some(known => known === target)) throw Error("目标必须是声明的 macOS 或 Windows 架构");
  const output = `dist/pikpak-downloader-${target.replace("bun-", "")}${target.includes("windows") ? ".exe" : ""}`;
  const platform = target.includes("windows") ? "win32" : "darwin";
  const arch = target.endsWith("arm64") ? "arm64" : "x64";
  const child = Bun.spawn([process.execPath, "build", "src/cli.ts", "--compile", "--minify-syntax", `--define=process.platform=${JSON.stringify(platform)}`,
    `--define=process.arch=${JSON.stringify(arch)}`, `--target=${target}`, `--outfile=${output}`],
    { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) process.exit(1);
}
