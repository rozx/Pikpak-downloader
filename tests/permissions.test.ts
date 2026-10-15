import { expect, test } from "bun:test";
import { grantedScopes, jwtScopes, missingPermissions, parseScopes, permissionNames, permissionRows } from "../src/auth/permissions";
import { login } from "../src/auth/login";
import { landingPage } from "../src/auth/login-page";
import type { Client, Tokens, Transport } from "../src/pikpak/protocol";
import { rejection } from "./fixtures/rejection";

const jwt = (payload: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.synthetic-signature`;

test("授权范围：解析空格分隔或数组，JWT 载荷作为后备，未知时不判定缺少", () => {
  expect(parseScopes("files:manage  cloud_download share account")).toEqual(["files:manage", "cloud_download", "share", "account"]);
  expect(parseScopes(["account", "share", "account"])).toEqual(["account", "share"]);
  expect(parseScopes(42)).toBe(null); expect(parseScopes([1])).toBe(null);
  expect(jwtScopes(jwt({ scope: "account share" }))).toEqual(["account", "share"]);
  expect(jwtScopes(jwt({ scp: ["files:manage"] }))).toEqual(["files:manage"]);
  expect(jwtScopes("opaque-token")).toBe(null); expect(jwtScopes("a.!!!.c")).toBe(null);
  expect(grantedScopes({ accessToken: jwt({ scope: "account" }), scope: ["share"] })).toEqual(["share", "account"]);
  expect(grantedScopes({ accessToken: "opaque-token", scope: ["openid", "profile"] })).toEqual(["openid", "profile"]);
  expect(grantedScopes({ accessToken: "opaque-token" })).toBe(null);
  expect(grantedScopes({ accessToken: jwt({ scope: "account" }) })).toEqual(["account"]);
  expect(missingPermissions(null)).toEqual([]);
  expect(permissionNames(missingPermissions(["account", "cloud_download"]))).toBe("管理文件、分享");
  expect(missingPermissions(["account", "files:manage", "share"])).toEqual([]);
});

test("实测回归：漏勾“管理文件”时服务端返回的范围准确反映勾选结果；逗号或加号分隔同样解析", () => {
  expect(permissionNames(missingPermissions(parseScopes("cloud_download share account")))).toBe("管理文件");
  expect(missingPermissions(parseScopes("files:manage cloud_download share account"))).toEqual([]);
  expect(parseScopes("files:manage,cloud_download, share+account")).toEqual(["files:manage", "cloud_download", "share", "account"]);
});

test("实测回归：服务端只回显登录基础范围时视为未知，不判定缺少权限", () => {
  for (const scopes of [["openid", "profile"], ["openid", "profile", "email"], ["user:extra"]]) {
    expect(missingPermissions(scopes)).toEqual([]);
    expect(permissionRows(scopes).filter(row => row.scope !== "user:extra").every(row => row.state === "unknown")).toBe(true);
  }
  expect(permissionRows(["openid", "user:extra"]).at(-1)).toMatchObject({ scope: "user:extra", state: "granted" });
});

test("权限行：已知权限按顺序列出状态，登录基础范围不显示，其他范围附在末尾", () => {
  const rows = permissionRows(["openid", "account", "share", "user:extra"]);
  expect(rows.map(row => [row.scope, row.state])).toEqual([["account", "granted"], ["files:manage", "missing"], ["share", "granted"], ["cloud_download", "missing"], ["user:extra", "granted"]]);
  expect(permissionRows(null).every(row => row.state === "unknown")).toBe(true);
});

test("本地入口页列出必须与建议勾选的权限，转义链接，不加载脚本或外部资源", () => {
  const html = landingPage(`/authorize/"x"`);
  for (const part of ["勾选全部权限", "账号信息", "files:manage", "必须勾选", "建议勾选", "密码只在官方页面输入", "prefers-color-scheme:dark", `href="/authorize/&quot;x&quot;"`]) expect(html).toContain(part);
  expect(html).not.toMatch(/<script|<link|https?:\/\/(?!github)/);
});

function flow(scopes: Array<string | undefined>) {
  const port = 54000 + Math.floor(Math.random() * 900);
  const client: Client = { clientId: "client", clientSecret: "secret", redirectUri: `http://127.0.0.1:${port}/callback`, authMethod: "client_secret_post" };
  const accepted: Tokens[] = []; let exchanges = 0;
  const http: Transport = async () => {
    const scope = scopes[Math.min(exchanges++, scopes.length - 1)];
    return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600, token_type: "Bearer", ...scope === undefined ? {} : { scope } });
  };
  const session = { existingLogin: async () => null as string | null, scopes: async () => null as string[] | null,
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

test("授权缺少必须的权限：不保存，结果页列出缺少项并可重新授权；补齐后登录完成", async () => {
  const f = flow(["cloud_download share account", "files:manage cloud_download share account"]);
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
  expect(f.accepted).toHaveLength(1); expect(f.accepted[0]!.scope).toEqual(["files:manage", "cloud_download", "share", "account"]);
});

test("服务端未返回授权范围，或只回显登录基础范围时，照常保存", async () => {
  for (const scope of [undefined, "openid profile"]) {
    const f = flow([scope]);
    const pending = login(f.session, true, () => {}, { openBrowser: async () => {}, http: f.http });
    await Bun.sleep(50);
    expect(await f.callback(await f.authorize(), "synthetic-code")).toContain("登录完成");
    expect(await pending).toBe("account"); expect(f.accepted[0]!.scope).toEqual(scope ? ["openid", "profile"] : undefined);
  }
});

test("非强制登录：已有会话缺少必须的权限时不复用，改走浏览器授权", async () => {
  const f = flow(["account"]);
  const reused = await login({ ...f.session, existingLogin: async () => "account", scopes: async () => ["account", "files:manage", "share"] }, false, () => {});
  expect(reused).toBe("account");
  const controller = new AbortController(); const announced: string[] = [];
  const pending = login({ ...f.session, existingLogin: async () => "account", scopes: async () => ["account"] }, false, message => { announced.push(message); },
    { signal: controller.signal, openBrowser: async () => {}, http: f.http });
  await Bun.sleep(50);
  expect(announced[0]).toContain("请在浏览器完成登录");
  controller.abort(); await rejection(pending);
});
