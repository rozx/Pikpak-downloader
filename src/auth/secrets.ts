import { AppError } from "../errors";
import type { SecretStore } from "../platform/types";
import { WindowsSecrets } from "../platform/windows-secrets";

export function systemSecrets(): SecretStore {
  if (process.platform === "darwin" || process.platform === "linux") return new SystemSecrets();
  if (process.platform === "win32") return new WindowsSecrets();
  throw new AppError("unsupported_platform");
}

// Bun.secrets 在 macOS 上使用 Keychain，在 Linux 上经 libsecret 使用 Secret Service。
export class SystemSecrets implements SecretStore {
  constructor(private readonly service = "com.rozx.pikpak-downloader") {}
  private check(): void { if (process.platform !== "darwin" && process.platform !== "linux") throw new AppError("unsupported_platform"); }
  async get(reference: string): Promise<string | null> {
    this.check();
    try { return await Bun.secrets.get({ service: this.service, name: reference }); }
    catch { throw new AppError("credentials_unavailable"); }
  }
  async set(reference: string, value: string): Promise<void> {
    this.check();
    try { await Bun.secrets.set({ service: this.service, name: reference, value }); }
    catch { throw new AppError("credentials_unavailable"); }
  }
  async delete(reference: string): Promise<void> {
    this.check();
    try { await Bun.secrets.delete({ service: this.service, name: reference }); }
    catch { throw new AppError("credentials_unavailable"); }
  }
}
