import { expect, test } from "bun:test";
import { grantedScopes, jwtScopes, missingPermissions, parseScopes, permissionNames, permissionRows, permissionStates, permissionsUnknown } from "../src/auth/permissions";
import { login } from "../src/auth/login";
import { landingPage } from "../src/auth/login-page";
import { ProviderError, type Client, type Tokens, type Transport } from "../src/pikpak/protocol";
import { PROBES, classifyProbe, probePermissions, probeStates } from "../src/pikpak/permission-probe";
import { rejection } from "./fixtures/rejection";

const jwt = (payload: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.synthetic-signature`;

test("授权范围：解析空格分隔或数组，JWT 载荷与响应合并", () => {
  expect(parseScopes("files:manage  cloud_download share account")).toEqual(["files:manage", "cloud_download", "share", "account"]);
  expect(parseScopes(["account", "share", "account"])).toEqual(["account", "share"]);
  expect(parseScopes(42)).toBe(null); expect(parseScopes([1])).toBe(null);
  expect(jwtScopes(jwt({ scope: "account share" }))).toEqual(["account", "share"]);
  expect(jwtScopes(jwt({ scp: ["files:manage"] }))).toEqual(["files:manage"]);
  expect(jwtScopes("opaque-token")).toBe(null); expect(jwtScopes("a.!!!.c")).toBe(null);
  expect(grantedScopes({ accessToken: jwt({ scope: "account" }), scope: ["share"] })).toEqual(["share", "account"]);
  expect(grantedScopes({ accessToken: "opaque-token", scope: ["openid", "profile"] })).toEqual(["openid", "profile"]);
  expect(grantedScopes({ accessToken: "opaque-token" })).toBe(null);
});

test("探测分类：403 或权限类错误为缺少；其他 4xx 说明已通过权限检查；401、5xx、限流与网络错误无法判断", () => {
  expect(classifyProbe(null)).toBe("granted");
  expect(classifyProbe(new ProviderError("permission", "permission_denied", 403))).toBe("missing");
  expect(classifyProbe(new ProviderError("permission", "insufficient_scope", 400))).toBe("missing");
  for (const status of [400, 404]) expect(classifyProbe(new ProviderError("permission", "provider-error", status))).toBe("granted");
  for (const status of [401, 429, 500, undefined]) expect(classifyProbe(new ProviderError("permission", "provider-error", status))).toBe("unknown");
  expect(classifyProbe(Error("other"))).toBe("unknown");
  expect(probeStates([{ permission: "files:manage", label: "读", status: 404, reason: null, state: "granted" }, { permission: "files:manage", label: "写", status: 403, reason: null, state: "missing" }]))
    .toEqual({ "files:manage": "missing" });
  expect(probeStates([{ permission: "share", label: "读", status: 404, reason: null, state: "granted" }, { permission: "share", label: "写", status: 500, reason: null, state: "unknown" }]))
    .toEqual({ share: "unknown" });
});

test("探测请求都没有副作用：只读，或针对不存在 ID 的空请求体写入；令牌只出现在授权头", async () => {
  const seen: Array<{ url: string; method: string; body: unknown; auth: string | null }> = [];
  const http: Transport = async (url, init) => {
    seen.push({ url, method: init.method ?? "GET", body: init.body, auth: new Headers(init.headers).get("authorization") });
    return Response.json({ error: "file_not_found" }, { status: 404 });
  };
  const results = await probePermissions("synthetic-access", http);
  expect(results.map(result => result.state)).toEqual(PROBES.map(() => "granted"));
  expect(seen).toHaveLength(PROBES.length);
  for (const request of seen) {
    expect(request.url.startsWith("https://api-drive.mypikpak.com/drive/v1/")).toBe(true); expect(request.url).not.toContain("synthetic-access");
    expect(request.auth).toBe("Bearer synthetic-access");
    if (request.method !== "GET") { expect(request.method).toBe("PATCH"); expect(request.body).toBe("{}"); expect(request.url).toContain("pikpak-downloader-permission-probe"); }
  }
});

test("权限状态：探测结果优先，无法判断时才参考含应用权限的授权范围；只回显基础范围时无法确认", () => {
  const states = permissionStates({ account: "granted", "files:manage": "missing", share: "unknown" }, ["share"]);
  expect(states).toEqual({ account: "granted", "files:manage": "missing", share: "granted", cloud_download: "missing" });
  expect(permissionNames(missingPermissions(states))).toBe("管理文件");
  for (const scopes of [null, ["openid", "profile"]]) {
    const unknown = permissionStates(null, scopes);
    expect(missingPermissions(unknown)).toEqual([]); expect(permissionsUnknown(unknown)).toBe(true);
  }
  expect(permissionsUnknown(permissionStates({ account: "granted", "files:manage": "granted", share: "granted" }, null))).toBe(false);
  const rows = permissionRows(states, ["openid", "user:extra"]);
  expect(rows.map(row => [row.scope, row.state])).toEqual([["account", "granted"], ["files:manage", "missing"], ["share", "granted"], ["cloud_download", "missing"], ["user:extra", "granted"]]);
});

test("本地入口页列出必须与建议勾选的权限，转义链接，不加载脚本或外部资源", () => {
  const html = landingPage(`/authorize/"x"`);
  for (const part of ["勾选全部权限", "账号信息", "files:manage", "必须勾选", "建议勾选", "密码只在官方页面输入", "prefers-color-scheme:dark", `href="/authorize/&quot;x&quot;"`]) expect(html).toContain(part);
  expect(html).not.toMatch(/<script|<link|https?:\/\/(?!github)/);
});

// 假服务：令牌接口只回显基础范围；每轮授权拒绝该轮 denied 中权限的探测，其余探测按“不存在”回应。
function flow(rounds: Array<ReadonlySet<string>>) {
  const port = 54000 + Math.floor(Math.random() * 900);
  const client: Client = { clientId: "client", clientSecret: "secret", redirectUri: `http://127.0.0.1:${port}/callback`, authMethod: "client_secret_post" };
  const accepted: Tokens[] = []; let exchanges = 0;
  const http: Transport = async (url, init) => {
    if (url.endsWith("/auth/token")) {
      exchanges++;
      return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600, token_type: "Bearer", scope: "openid profile" });
    }
    const path = url.replace("https://api-drive.mypikpak.com", "");
    const probe = PROBES.find(item => item.path === path && (item.init?.method ?? "GET") === (init.method ?? "GET"))!;
    const denied = rounds[Math.min(exchanges, rounds.length) - 1]!;
    return denied.has(probe.permission) ? Response.json({ error: "permission_denied" }, { status: 403 }) : Response.json({ error: "file_not_found" }, { status: 404 });
  };
  const session = { existingLogin: async () => null as string | null,
    accept: async (tokens: Tokens) => { accepted.push(tokens); return "account"; }, client: async () => client };
  const base = `http://127.0.0.1:${port}`;
  const authorize = async () => {
    const href = /href="(\/authorize\/[^"]+)"/.exec(await (await fetch(`${base}/`)).text())![1]!;
    const location = (await fetch(`${base}${href}`, { redirect: "manual" })).headers.get("location")!;
    return new URL(location).searchParams.get("state")!;
  };
  const callback = async (state: string, code: string) => (await fetch(`${base}/callback?state=${encodeURIComponent(state)}&code=${code}`)).text();
  return { client, session, http, accepted, authorize, callback };
}

test("实测探测到缺少必须的权限：不保存，结果页列出缺少项并可重新授权；补齐后登录完成", async () => {
  const f = flow([new Set(["files:manage"]), new Set()]);
  const announced: string[] = [];
  const pending = login(f.session, true, message => { announced.push(message); }, { openBrowser: async () => {}, http: f.http });
  await Bun.sleep(50);
  const first = await f.authorize();
  const page = await f.callback(first, "synthetic-code-1");
  expect(page).toContain("授权缺少必须的权限"); expect(page).toContain("管理文件"); expect(page).toContain("重新授权");
  // 只检查本程序生成的正文：本机的广告过滤软件可能向 head 注入带当前地址的脚本。
  const body = page.slice(page.indexOf("<body>"));
  expect(body).not.toContain("synthetic-code-1"); expect(body).not.toContain("synthetic-access");
  expect(f.accepted).toHaveLength(0);
  expect(announced.at(-1)).toContain("授权缺少必须的权限：管理文件");
  const second = await f.authorize();
  expect(second).not.toBe(first);
  expect(await f.callback(first, "synthetic-code-2")).toContain("授权未完成");
  expect(await f.callback(second, "synthetic-code-3")).toContain("登录完成");
  expect(await pending).toBe("account");
  expect(f.accepted).toHaveLength(1);
});

test("实测回归：授权范围只回显 openid profile 而探测全部通过时登录完成", async () => {
  const f = flow([new Set()]);
  const pending = login(f.session, true, () => {}, { openBrowser: async () => {}, http: f.http });
  await Bun.sleep(50);
  expect(await f.callback(await f.authorize(), "synthetic-code")).toContain("登录完成");
  expect(await pending).toBe("account"); expect(f.accepted[0]!.scope).toEqual(["openid", "profile"]);
});

test("非强制登录：已有会话探测到缺少必须的权限时不复用，改走浏览器授权", async () => {
  const f = flow([new Set()]);
  const reused = await login({ ...f.session, existingLogin: async () => "account", permissions: async () => ({ account: "granted", "files:manage": "unknown" }) }, false, () => {});
  expect(reused).toBe("account");
  const controller = new AbortController(); const announced: string[] = [];
  const pending = login({ ...f.session, existingLogin: async () => "account", permissions: async () => ({ share: "missing" }) }, false, message => { announced.push(message); },
    { signal: controller.signal, openBrowser: async () => {}, http: f.http });
  await Bun.sleep(50);
  expect(announced[0]).toContain("请在浏览器完成登录");
  controller.abort(); await rejection(pending);
});
