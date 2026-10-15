import type { PikpakClient } from "./client";
import type { Store } from "../state/store";

// 账号等级（add-concurrent-file-downloads 决策 5、Evidence P3a）：GET /drive/v1/privilege/vip 返回 type、status 与 expire。
// 只有 status 为 ok、type 非空且不是 novip、到期时间在未来时才算会员；读不到或格式不符为未知，按免费处理。
export type Tier = "paid" | "free" | "unknown";
export const PAID_ACTIVE_FILES = 5;
export const tierCap = (tier: Tier) => tier === "paid" ? PAID_ACTIVE_FILES : 1;

export function classifyTier(body: unknown, now = Date.now()): Tier {
  const data = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
  if (!data || typeof data !== "object") return "unknown";
  const { status, type, expire } = data as Record<string, unknown>;
  if (typeof status !== "string" || typeof type !== "string") return "unknown";
  const end = typeof expire === "string" ? Date.parse(expire) : NaN;
  return status === "ok" && type !== "" && type !== "novip" && Number.isFinite(end) && end > now ? "paid" : "free";
}

// 账号页显示的会员详情（improve-account-login 决策 5）：类型与到期时间，读不到时为 null。
export type Membership = { tier: Exclude<Tier, "unknown">; type: string | null; expire: number | null };
export function membership(body: unknown, now = Date.now()): Membership | null {
  const tier = classifyTier(body, now);
  if (tier === "unknown") return null;
  const { type, expire } = (body as { data: Record<string, unknown> }).data;
  const end = typeof expire === "string" ? Date.parse(expire) : NaN;
  return { tier, type: typeof type === "string" && type && type !== "novip" ? type : null, expire: Number.isFinite(end) ? end : null };
}

// 上一次成功读取的等级写入配置，供 status 离线显示；会话内的生效值只取本次会话读到的结果。
export type StoredTier = { account: string; tier: Exclude<Tier, "unknown">; at: number };
export function storedTier(store: Pick<Store, "config">, account: string): StoredTier | null {
  try {
    const value = JSON.parse(store.config("account_tier") ?? "null") as Partial<StoredTier> | null;
    return value && value.account === account && (value.tier === "paid" || value.tier === "free") && typeof value.at === "number" ? value as StoredTier : null;
  } catch { return null; }
}

export class AccountTier {
  private value: Tier = "unknown";
  private detail: Membership | null = null;
  private due = -Infinity;
  private reading: Promise<Tier> | null = null;
  // 成功后每 refreshMs 刷新一次；失败时沿用上一次成功的结果，retryMs 后再试。
  constructor(private readonly api: Pick<PikpakClient, "request">, private readonly accountId: string,
    private readonly store?: Pick<Store, "setConfig">, private readonly now: () => number = Date.now,
    readonly refreshMs = 600_000, readonly retryMs = 60_000) {}
  get current(): Tier { return this.value; }
  get cap(): number { return tierCap(this.value); }
  get membership(): Membership | null { return this.detail; }
  refresh(signal?: AbortSignal): Promise<Tier> {
    if (this.reading) return this.reading;
    if (this.now() < this.due) return Promise.resolve(this.value);
    this.reading = (async () => {
      try {
        const body = await this.api.request(this.accountId, "/drive/v1/privilege/vip", signal ? { signal } : {}, undefined, { quiet: true });
        const tier = classifyTier(body, this.now());
        if (tier !== "unknown") {
          this.value = tier; this.detail = membership(body, this.now()); this.due = this.now() + this.refreshMs;
          this.store?.setConfig("account_tier", JSON.stringify({ account: this.accountId, tier, at: this.now() } satisfies StoredTier));
          return this.value;
        }
      } catch { /* 读不到时沿用上一次成功的结果。 */ }
      this.due = this.now() + this.retryMs;
      return this.value;
    })().finally(() => { this.reading = null; });
    return this.reading;
  }
}
