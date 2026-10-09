/// <reference path="./assets.d.ts" />
import script from "./windows-secrets.ps1" with { type: "text" };
import { AppError } from "../errors";
import type { SecretStore } from "./types";

type Request = { action: "get" | "set" | "delete"; reference: string; value?: string };
type Exchange = (request: Request) => Promise<{ ok: boolean; value?: string | null }>;
async function nativeExchange(request: Request): ReturnType<Exchange> {
  if (process.platform !== "win32") throw new AppError("unsupported_platform");
  // 参数只有静态代码；引用和秘密通过 stdin 管道传递，不进入命令行或普通文件。
  const child = Bun.spawn(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const timeout = setTimeout(() => child.kill(), 20_000);
  try {
    child.stdin.write(JSON.stringify(request)); await child.stdin.end();
    const raw = await new Response(child.stdout).text();
    if (await child.exited !== 0) throw new AppError("credentials_unavailable");
    const response = JSON.parse(raw) as { ok?: unknown; value?: unknown };
    if (response.ok !== true || (response.value !== null && typeof response.value !== "string")) throw new AppError("credentials_unavailable");
    return { ok: true, value: response.value };
  } catch { throw new AppError("credentials_unavailable"); }
  finally { clearTimeout(timeout); }
}

export class WindowsSecrets implements SecretStore {
  constructor(private readonly exchange: Exchange = nativeExchange) {}
  private async call(request: Request) {
    if (!/^[a-zA-Z0-9.-]{1,200}$/.test(request.reference)
      || (request.value !== undefined && Buffer.byteLength(request.value, "utf8") > 2560)) throw new AppError("credentials_unavailable");
    try {
      const result = await this.exchange(request);
      if (!result.ok) throw new AppError("credentials_unavailable");
      return result;
    } catch { throw new AppError("credentials_unavailable"); }
  }
  async get(reference: string): Promise<string | null> { return (await this.call({ action: "get", reference })).value ?? null; }
  async set(reference: string, value: string): Promise<void> { await this.call({ action: "set", reference, value }); }
  async delete(reference: string): Promise<void> { await this.call({ action: "delete", reference }); }
}
