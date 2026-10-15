import { randomUUID } from "node:crypto";
import { AppError } from "../errors";
import type { SecretStore } from "../platform/types";
import { discover, identity, profile, quotaReadable, refresh, register, transport, type Client, type Profile, type Tokens, type Transport } from "../pikpak/protocol";
import { grantedScopes } from "./permissions";

// scopes：服务端授予的授权范围；旧记录或服务端未返回时省略，读作未知。
type Session = { accountId: string; clientId: string; accessKey: string; refreshKey?: string; expiresAt: number; scopes?: string[] };
type Pending = { candidate: Session; cleanup: string[]; phase: "preparing" | "ready" };
const tokenReference = (value: unknown): value is string => typeof value === "string" && /^session\.[0-9a-f-]{36}\.(access|refresh)$/.test(value);
function parseSession(raw: string): Session {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new AppError("credentials_unavailable"); }
  if (!value || typeof value !== "object") throw new AppError("credentials_unavailable");
  const record = value as Record<string, unknown>;
  if (typeof record.accountId !== "string" || !record.accountId || typeof record.clientId !== "string" || !record.clientId
    || !tokenReference(record.accessKey) || (record.refreshKey !== undefined && !tokenReference(record.refreshKey))
    || typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt)
    || (record.scopes !== undefined && !(Array.isArray(record.scopes) && record.scopes.every(item => typeof item === "string")))) throw new AppError("credentials_unavailable");
  return record as Session;
}
const keys = (session: Session | null): string[] => session ? [session.accessKey, ...(session.refreshKey ? [session.refreshKey] : [])] : [];

export class SessionManager {
  private flight: Promise<{ accountId: string; token: string; renewed: boolean }> | null = null;
  private blocked = false;
  constructor(private readonly secrets: SecretStore, private readonly http: Transport = transport,
    private readonly onFailure: (accountId: string) => void = () => {}, private readonly now = Date.now) {}

  private async current(): Promise<Session | null> {
    const raw = await this.secrets.get("session.current");
    return raw ? parseSession(raw) : null;
  }
  private async pending(): Promise<Pending | null> {
    const raw = await this.secrets.get("session.pending");
    if (!raw) return null;
    let value: Pending;
    try { value = JSON.parse(raw) as Pending; } catch { throw new AppError("credentials_unavailable"); }
    if (!value || !["preparing", "ready"].includes(value.phase) || !Array.isArray(value.cleanup) || !value.cleanup.every(tokenReference)) throw new AppError("credentials_unavailable");
    return { ...value, candidate: parseSession(JSON.stringify(value.candidate)) };
  }
  private async cleanup(pending: Pending): Promise<void> {
    const retained = new Set(keys(pending.candidate));
    for (const reference of pending.cleanup) if (!retained.has(reference)) await this.secrets.delete(reference);
    await this.secrets.delete("session.pending");
  }
  private async recover(): Promise<void> {
    const pending = await this.pending();
    if (!pending) return;
    const access = await this.secrets.get(pending.candidate.accessKey);
    const refreshValue = pending.candidate.refreshKey ? await this.secrets.get(pending.candidate.refreshKey) : true;
    if (!access || !refreshValue) throw new AppError("authorization_failed");
    if (await identity(access, this.http) !== pending.candidate.accountId) throw new AppError("account_mismatch");
    await this.secrets.set("session.current", JSON.stringify(pending.candidate));
    await this.cleanup(pending);
  }
  async client(redirectUri = "http://127.0.0.1:53683/callback"): Promise<Client> {
    const raw = await this.secrets.get("openid-client.v1");
    if (raw) {
      let value: unknown;
      try { value = JSON.parse(raw); } catch { throw new AppError("credentials_unavailable"); }
      if (!value || typeof value !== "object") throw new AppError("credentials_unavailable");
      const client = value as Partial<Client>;
      if (typeof client.clientId !== "string" || !client.clientId || typeof client.clientSecret !== "string" || !client.clientSecret
        || typeof client.redirectUri !== "string" || client.authMethod !== "client_secret_post") throw new AppError("credentials_unavailable");
      const url = new URL(client.redirectUri);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/callback" || url.username || url.password || url.search || url.hash) throw new AppError("credentials_unavailable");
      return client as Client;
    }
    await discover(this.http);
    const client = await register(redirectUri, this.http);
    await this.secrets.set("openid-client.v1", JSON.stringify(client));
    return client;
  }
  private async save(tokens: Tokens, accountId: string, client: Client, previousRefresh?: string, previousScopes?: string[]): Promise<void> {
    const old = await this.current();
    const prior = await this.pending();
    const generation = randomUUID();
    const refreshValue = tokens.refreshToken ?? previousRefresh;
    // 刷新响应不带授权范围时沿用上一代。
    const scopes = grantedScopes(tokens) ?? previousScopes;
    const candidate: Session = { accountId, clientId: client.clientId, accessKey: `session.${generation}.access`,
      ...(refreshValue ? { refreshKey: `session.${generation}.refresh` } : {}),
      expiresAt: this.now() + Math.max(0, tokens.expiresIn) * 1000, ...(scopes ? { scopes } : {}) };
    const pending: Pending = { candidate, cleanup: [...new Set([...keys(old), ...(prior ? [...keys(prior.candidate), ...prior.cleanup] : [])])], phase: "preparing" };
    await this.secrets.set("session.pending", JSON.stringify(pending));
    await this.secrets.set(candidate.accessKey, tokens.accessToken);
    if (candidate.refreshKey && refreshValue) await this.secrets.set(candidate.refreshKey, refreshValue);
    pending.phase = "ready";
    await this.secrets.set("session.pending", JSON.stringify(pending));
    await this.secrets.set("session.current", JSON.stringify(candidate));
    await this.cleanup(pending);
  }
  async accept(tokens: Tokens, client: Client): Promise<string> {
    const accountId = await identity(tokens.accessToken, this.http);
    await quotaReadable(tokens.accessToken, this.http);
    try { await this.save(tokens, accountId, client); }
    catch (error) { this.blocked = true; this.onFailure(accountId); throw error; }
    this.blocked = false;
    return accountId;
  }
  private async obtain(expected: string, force: boolean): Promise<{ accountId: string; token: string; renewed: boolean }> {
    if (this.blocked) throw new AppError("authorization_failed");
    try {
      await this.recover();
      const session = await this.current();
      if (!session) throw new AppError("login_required");
      if (session.accountId !== expected) throw new AppError("account_mismatch");
      const access = await this.secrets.get(session.accessKey);
      if (!force && access && session.expiresAt > this.now() + 60_000) return { accountId: expected, token: access, renewed: false };
      const refreshValue = session.refreshKey ? await this.secrets.get(session.refreshKey) : null;
      if (!refreshValue) throw new AppError("login_required");
      const client = await this.client();
      if (client.clientId !== session.clientId) throw new AppError("account_mismatch");
      const renewed = await refresh(client, refreshValue, this.http);
      if (await identity(renewed.accessToken, this.http) !== expected) throw new AppError("account_mismatch");
      await this.save(renewed, expected, client, refreshValue, session.scopes);
      return { accountId: expected, token: renewed.accessToken, renewed: true };
    } catch (error) { this.blocked = true; this.onFailure(expected); throw error; }
  }
  async access(expected: string, force = false): Promise<string> {
    if (!this.flight) this.flight = this.obtain(expected, force).finally(() => { this.flight = null; });
    const result = await this.flight;
    if (result.accountId !== expected) throw new AppError("account_mismatch");
    if (force && !result.renewed) return this.access(expected, true);
    return result.token;
  }
  async existingLogin(): Promise<string | null> {
    await this.recover();
    const session = await this.current();
    if (!session) return null;
    const token = await this.access(session.accountId);
    if (await identity(token, this.http) !== session.accountId) throw new AppError("account_mismatch");
    await quotaReadable(token, this.http);
    return session.accountId;
  }
  // 当前会话的授权范围；没有会话或未知时为 null。
  async scopes(): Promise<string[] | null> {
    await this.recover();
    return (await this.current())?.scopes ?? null;
  }
  async profile(expected: string): Promise<Profile> {
    const result = await profile(await this.access(expected), this.http);
    if (result.id !== expected) throw new AppError("account_mismatch");
    return result;
  }
  async logout(): Promise<void> {
    this.blocked = true;
    // 写命令持有队列锁；本实例仍在刷新时，先让刷新结束再移除其所有代次。
    await this.flight?.catch(() => {});
    const session = await this.current();
    const pending = await this.pending();
    const references = new Set([...keys(session), ...(pending ? [...keys(pending.candidate), ...pending.cleanup] : [])]);
    for (const reference of references) await this.secrets.delete(reference);
    await this.secrets.delete("session.pending");
    await this.secrets.delete("session.current");
  }
}
