import { expect, test } from "bun:test";
import { rejection } from "./fixtures/rejection";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../src/auth/session";
import type { SecretStore } from "../src/platform/types";
import type { Client, Transport } from "../src/pikpak/protocol";
import { PikpakClient } from "../src/pikpak/client";
import { Store } from "../src/state/store";

class Secrets implements SecretStore {
  data = new Map<string, string>();
  failCurrent = false;
  async get(key: string) { return this.data.get(key) ?? null; }
  async set(key: string, value: string) { if (this.failCurrent && key === "session.current") throw Error("synthetic-save-failure"); this.data.set(key, value); }
  async delete(key: string) { this.data.delete(key); }
}
const client: Client = { clientId: "synthetic-client", clientSecret: "synthetic-client-secret", redirectUri: "http://127.0.0.1:53683/callback", authMethod: "client_secret_post" };
function provider() {
  const stats = { refreshed: 0, newAccount: "account", failRefresh: false, writes: 0, forbidden: false };
  const http: Transport = async (url, init) => {
    if (url.endsWith("/auth/token")) {
      stats.refreshed++;
      await Bun.sleep(1);
      if (stats.failRefresh) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, token_type: "Bearer" });
    }
    if (url.endsWith("/user/me")) return Response.json({ sub: new Headers(init.headers).get("authorization") === "Bearer new-access" ? stats.newAccount : "account" });
    if (url.endsWith("/about")) return Response.json({ quota: {} });
    if (init.method === "POST") { stats.writes++; return Response.json({ error: "permission_denied" }, { status: 403 }); }
    throw Error("unexpected test route");
  };
  return { stats, http };
}
async function setup(expiresIn = 0) {
  const secrets = new Secrets(); const { stats, http } = provider(); const failures: string[] = [];
  await secrets.set("openid-client.v1", JSON.stringify(client));
  const manager = new SessionManager(secrets, http, account => failures.push(account));
  await manager.accept({ accessToken: "old-access", refreshToken: "old-refresh", expiresIn }, client);
  return { secrets, stats, http, failures, manager };
}

test("并发访问只刷新一次，先保存新凭据再返回令牌", async () => {
  const f = await setup();
  const tokens = await Promise.all([f.manager.access("account"), f.manager.access("account"), f.manager.access("account")]);
  expect(tokens).toEqual(["new-access", "new-access", "new-access"]);
  expect(f.stats.refreshed).toBe(1);
  expect(await f.secrets.get("session.pending")).toBe(null);
  const session = JSON.parse((await f.secrets.get("session.current"))!);
  expect(await f.secrets.get(session.refreshKey)).toBe("new-refresh");
  expect([...f.secrets.data.values()].includes("old-access")).toBe(false);
});

test("强制刷新遇到正在读取缓存会话时仍刷新一次", async () => {
  const f = await setup(3600);
  const [, token] = await Promise.all([f.manager.access("account"), f.manager.access("account", true)]);
  expect(token).toBe("new-access"); expect(f.stats.refreshed).toBe(1);
});

test("辅助性只读请求被拒绝或限流时只抛给调用方，不暂停账号、不记录账号限流", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pikpak-quiet-test-")); const store = new Store(join(dir, "db.sqlite"));
  try {
    store.ensureAccount("account");
    const f = await setup(3600);
    const http: Transport = async (url, init) => url.includes("/privilege/vip") ? Response.json({ error: "permission_denied" }, { status: 403 })
      : url.includes("/limited") ? Response.json({ error: "too_many_requests" }, { status: 429, headers: { "retry-after": "30" } }) : f.http(url, init);
    const api = new PikpakClient(f.manager, store, http);
    expect((await rejection(api.request("account", "/drive/v1/privilege/vip", {}, undefined, { quiet: true }))).message).toContain("permission_denied");
    expect(((await rejection(api.request("account", "/drive/v1/limited", {}, undefined, { quiet: true }))) as { status?: number }).status).toBe(429);
    expect(store.paused("account")).toBe(null); expect(store.rateLimited("account")).toBe(false);
    await rejection(api.request("account", "/drive/v1/privilege/vip"));
    expect(store.paused("account")?.reason).toBe("permission");
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("服务器已轮换但当前引用提交失败时暂停，重开可核对待提交代次", async () => {
  const f = await setup(); f.secrets.failCurrent = true;
  await expect(f.manager.access("account")).rejects.toThrow();
  expect(f.failures).toEqual(["account"]);
  await expect(f.manager.access("account")).rejects.toThrow();
  expect(f.stats.refreshed).toBe(1);
  f.secrets.failCurrent = false;
  const recovered = new SessionManager(f.secrets, f.http);
  expect(await recovered.access("account")).toBe("new-access");
  expect(f.stats.refreshed).toBe(1);
});

test("刷新失败与刷新后身份改变都暂停，不再继续获取令牌", async () => {
  for (const mismatch of [false, true]) {
    const f = await setup();
    if (mismatch) f.stats.newAccount = "different-account"; else f.stats.failRefresh = true;
    await expect(f.manager.access("account")).rejects.toThrow();
    await expect(f.manager.access("account")).rejects.toThrow();
    expect(f.stats.refreshed).toBe(1); expect(f.failures).toEqual(["account"]);
  }
});

test("登出只清除认证令牌，分享资料保留，重新登录同账号可恢复", async () => {
  const f = await setup(3600);
  await f.secrets.set("share.synthetic", "retained-share-secret");
  await f.manager.logout();
  expect(await f.secrets.get("session.current")).toBe(null);
  expect([...f.secrets.data.keys()].filter(key => key.startsWith("session."))).toHaveLength(0);
  expect(await f.secrets.get("share.synthetic")).toBe("retained-share-secret");
  await f.manager.accept({ accessToken: "old-access", refreshToken: "old-refresh", expiresIn: 3600 }, client);
  expect(await f.manager.access("account")).toBe("old-access");
});

test("会话记录保存授权范围，刷新响应不带范围时沿用；账号资料核对身份", async () => {
  const secrets = new Secrets(); const { http } = provider();
  await secrets.set("openid-client.v1", JSON.stringify(client));
  const manager = new SessionManager(secrets, http);
  expect(await manager.scopes()).toBe(null);
  await manager.accept({ accessToken: "old-access", refreshToken: "old-refresh", expiresIn: 0, scope: ["account", "files:manage", "share"] }, client);
  expect(await manager.scopes()).toEqual(["account", "files:manage", "share"]);
  expect(await manager.access("account")).toBe("new-access");
  expect(await manager.scopes()).toEqual(["account", "files:manage", "share"]);
  expect(await manager.profile("account")).toEqual({ id: "account", name: null, email: null });
  await manager.logout(); expect(await manager.scopes()).toBe(null);
});

test("账号不匹配阻止写入，权限拒绝暂停且不盲目重发写请求", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pikpak-auth-test-")); const store = new Store(join(dir, "db.sqlite"));
  try {
    store.ensureAccount("account"); store.ensureAccount("different-account");
    const f = await setup(3600);
    const api = new PikpakClient(f.manager, store, f.http);
    await expect(api.request("different-account", "/drive/v1/files:batchDelete", { method: "POST" })).rejects.toThrow();
    expect(f.stats.writes).toBe(0);
    const g = await setup(3600); const permitted = new PikpakClient(g.manager, store, g.http);
    await expect(permitted.request("account", "/drive/v1/files:batchDelete", { method: "POST" })).rejects.toThrow();
    expect(g.stats.writes).toBe(1); expect(store.paused("account")?.reason).toBe("permission");
    await expect(permitted.request("account", "/drive/v1/files:batchDelete", { method: "POST" })).rejects.toThrow();
    expect(g.stats.writes).toBe(1);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
