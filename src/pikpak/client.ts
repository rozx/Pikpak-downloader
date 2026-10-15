import type { SessionManager } from "../auth/session";
import { AppError } from "../errors";
import type { Store } from "../state/store";
import { ProviderError, requestJson, transport, type Transport } from "./protocol";

export class PikpakClient {
  constructor(private readonly session: SessionManager, private readonly store: Store, private readonly http: Transport = transport) {}
  // quiet：辅助性只读请求（如账号等级）。它的 403 与 429 只抛给调用方，不暂停账号、不记录账号限流；401 仍按登录失效处理。
  async request(accountId: string, path: string, init: RequestInit = {}, beforeSend?: () => void, options: { quiet?: boolean } = {}): Promise<Record<string, unknown>> {
    const delay = this.store.rateDelay(accountId);
    if (delay > 0) throw new ProviderError("drive", "rate_limited", 429, delay);
    const pause = this.store.paused(accountId);
    if (pause && ["authentication", "permission"].includes(pause.reason)) throw new AppError("authorization_failed");
    if (!path.startsWith("/drive/v1/") || path.includes("#")) throw new AppError("invalid_input");
    const url = new URL(path, "https://api-drive.mypikpak.com");
    if (url.origin !== "https://api-drive.mypikpak.com") throw new AppError("invalid_input");
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.session.access(accountId, attempt > 0);
      const headers = new Headers(init.headers); headers.set("Authorization", `Bearer ${token}`);
      beforeSend?.();
      try { return await requestJson("drive", url.href, { ...init, headers }, this.http); }
      catch (error) {
        if (options.quiet && error instanceof ProviderError && error.status !== 401) throw error;
        if (error instanceof ProviderError && error.status === 429) this.store.rateLimit(accountId, error.retryAfterMs ?? 60000);
        if (error instanceof ProviderError && (error.status === 402 || ["download_quota_exceeded", "download_traffic_not_enough", "download_flow_not_enough", "traffic_limit_exceeded"].includes(error.reason))) throw error;
        if (error instanceof ProviderError && error.status === 401 && attempt === 0 && (!init.method || init.method === "GET")) continue;
        if (error instanceof ProviderError && (error.status === 401 || error.status === 403 || error.reason === "permission_denied")) {
          this.store.pause(accountId, error.status === 401 ? "authentication" : "permission");
          throw new AppError("authorization_failed");
        }
        throw error;
      }
    }
    throw new AppError("authorization_failed");
  }
}
