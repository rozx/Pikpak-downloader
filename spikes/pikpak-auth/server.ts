import { randomUUID } from "node:crypto";
import { ENDPOINTS, ProbeError, authorizationUrl, discover, exchange, identity, newAttempt,
  quotaReadable, refresh, register, takeAuthorizationCode, type Attempt, type Client, type Tokens } from "./protocol";
import { parseFixture } from "./fixture";

const PORT = 53682;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const REDIRECT = `${ORIGIN}/callback`;
const SERVICE = "com.rozx.pikpak-downloader.verification";
const localNonce = randomUUID();

type Session = {
  accountId: string;
  clientId: string;
  accessKey: string;
  refreshKey?: string;
  expiresAt: number;
};
type Check = "pending" | "pass" | "fail" | "not-provided";
const status: {
  phase: string;
  registration: Check;
  identity: Check;
  refresh: Check;
  quota: Check;
  lastError: { stage: string; reason: string; status?: number } | null;
  credentialCleanupPending: boolean;
  fixtureStored: boolean;
  fixtureSubmissions: number;
} = { phase: "starting", registration: "pending", identity: "pending", refresh: "pending",
  quota: "pending", lastError: null, credentialCleanupPending: false, fixtureStored: false, fixtureSubmissions: 0 };

let client: Client | undefined;
let attempt: Attempt | undefined;
let callbackRunning = false;

function cleanError(error: unknown): { stage: string; reason: string; status?: number } {
  if (error instanceof ProbeError) {
    return { stage: error.stage, reason: error.reason, ...(error.status ? { status: error.status } : {}) };
  }
  return { stage: "local", reason: "operation-failed" };
}

async function getSecret(name: string): Promise<string | null> {
  try { return await Bun.secrets.get({ service: SERVICE, name }); }
  catch { throw new ProbeError("credential-store", "read-failed"); }
}
async function setSecret(name: string, value: string): Promise<void> {
  try { await Bun.secrets.set({ service: SERVICE, name, value }); }
  catch { throw new ProbeError("credential-store", "write-failed"); }
}
async function removeSecret(name: string): Promise<void> {
  try { await Bun.secrets.delete({ service: SERVICE, name }); }
  catch { status.credentialCleanupPending = true; }
}

function parseSession(raw: string): Session {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new ProbeError("credential-store", "invalid-session-metadata"); }
  if (!value || typeof value !== "object") throw new ProbeError("credential-store", "invalid-session-metadata");
  const record = value as Record<string, unknown>;
  const keyPattern = /^session\.[0-9a-f-]{36}\.(?:access|refresh)$/;
  if (typeof record.accountId !== "string" || !record.accountId || typeof record.clientId !== "string"
    || typeof record.accessKey !== "string" || !keyPattern.test(record.accessKey)
    || (record.refreshKey !== undefined && (typeof record.refreshKey !== "string" || !keyPattern.test(record.refreshKey)))
    || typeof record.expiresAt !== "number") throw new ProbeError("credential-store", "invalid-session-metadata");
  return record as Session;
}

async function saveTokens(tokens: Tokens, accountId: string, currentClient: Client, previousRefresh?: string): Promise<Session> {
  const oldRaw = await getSecret("session.current");
  const old = oldRaw ? parseSession(oldRaw) : undefined;
  const generation = randomUUID();
  const accessKey = `session.${generation}.access`;
  const refreshToken = tokens.refreshToken ?? previousRefresh;
  const refreshKey = refreshToken ? `session.${generation}.refresh` : undefined;
  const session: Session = { accountId, clientId: currentClient.clientId, accessKey,
    expiresAt: Date.now() + Math.max(0, tokens.expiresIn) * 1000,
    ...(refreshKey ? { refreshKey } : {}) };
  let committed = false;
  try {
    await setSecret(accessKey, tokens.accessToken);
    if (refreshKey && refreshToken) await setSecret(refreshKey, refreshToken);
    await setSecret("session.current", JSON.stringify(session));
    committed = true;
  } finally {
    if (!committed) {
      await removeSecret(accessKey);
      if (refreshKey) await removeSecret(refreshKey);
    }
  }
  if (old) {
    await removeSecret(old.accessKey);
    if (old.refreshKey) await removeSecret(old.refreshKey);
  }
  return session;
}

async function initialize(): Promise<void> {
  if (process.platform !== "darwin") throw new ProbeError("platform", "credential-adapter-not-verified");
  await discover();
  const saved = await getSecret("openid-client.v1");
  if (saved) {
    let parsed: unknown;
    try { parsed = JSON.parse(saved); }
    catch { throw new ProbeError("credential-store", "invalid-client-record"); }
    if (!parsed || typeof parsed !== "object") throw new ProbeError("credential-store", "invalid-client-record");
    const value = parsed as Record<string, unknown>;
    if (typeof value.clientId !== "string" || !value.clientId || typeof value.clientSecret !== "string"
      || !value.clientSecret || value.redirectUri !== REDIRECT || value.authMethod !== "client_secret_post") {
      throw new ProbeError("credential-store", "invalid-client-record");
    }
    client = value as Client;
  } else {
    const registered = await register(REDIRECT);
    await setSecret("openid-client.v1", JSON.stringify(registered));
    client = registered;
  }
  status.registration = "pass";
  status.phase = "ready-to-authorize";
  const existing = await getSecret("session.current");
  if (existing) {
    const session = parseSession(existing);
    if (session.clientId !== client.clientId) throw new ProbeError("session", "client-mismatch");
    const savedRefresh = session.refreshKey ? await getSecret(session.refreshKey) : null;
    if (savedRefresh) {
      const renewed = await refresh(client, savedRefresh);
      if (await identity(renewed.accessToken) !== session.accountId) throw new ProbeError("session", "identity-mismatch");
      await saveTokens(renewed, session.accountId, client, savedRefresh);
      status.identity = "pass"; status.refresh = "pass";
      await quotaReadable(renewed.accessToken);
      status.quota = "pass";
      status.phase = "session-verified";
    } else {
      const access = await getSecret(session.accessKey);
      if (!access || await identity(access) !== session.accountId) throw new ProbeError("session", "login-required");
      status.identity = "pass"; status.refresh = "not-provided";
      await quotaReadable(access);
      status.quota = "pass";
      status.phase = "session-verified";
    }
    const fixture = await getSecret("share-fixture.v1");
    if (fixture) {
      try { status.fixtureStored = (JSON.parse(fixture) as { accountId?: string }).accountId === session.accountId; }
      catch { status.fixtureStored = false; }
    }
  }
}

async function finishAuthorization(code: string, currentAttempt: Attempt, currentClient: Client): Promise<void> {
  status.phase = "verifying-session";
  const received = await exchange(currentClient, code, currentAttempt.verifier);
  const accountId = await identity(received.accessToken);
  status.identity = "pass";
  await saveTokens(received, accountId, currentClient);
  let accessToken = received.accessToken;
  if (received.refreshToken) {
    try {
      const renewed = await refresh(currentClient, received.refreshToken);
      const refreshedIdentity = await identity(renewed.accessToken);
      if (refreshedIdentity !== accountId) throw new ProbeError("token-refresh", "identity-mismatch");
      await saveTokens(renewed, accountId, currentClient, received.refreshToken);
      accessToken = renewed.accessToken;
      status.refresh = "pass";
    } catch (error) {
      status.refresh = "fail";
      throw error;
    }
  } else {
    status.refresh = "not-provided";
  }
  try {
    await quotaReadable(accessToken);
    status.quota = "pass";
  } catch (error) {
    status.quota = "fail";
    status.lastError = cleanError(error);
  }
  status.phase = "session-verified";
}

function html(): string {
  const phaseText: Record<string, string> = {
    starting: "正在检查公开授权配置并注册本工具。",
    "ready-to-authorize": "本地客户端已准备好，请使用本次测试账号登录。",
    "waiting-for-authorization": "等待 PikPak 页面完成登录与授权。",
    "verifying-session": "正在验证账号身份、会话刷新与容量读取。",
    "session-verified": "会话检查已结束，下方只显示结果，不显示账号资料。",
    failed: "当前验证未通过。可将下方脱敏错误交给开发者检查。",
  };
  const labels: Record<string, string> = { pending: "未验证", pass: "通过", fail: "未通过", "not-provided": "服务端未提供" };
  const rows = [["客户端注册", status.registration], ["账号身份", status.identity], ["令牌刷新", status.refresh], ["容量读取", status.quota]];
  const safe = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PikPak 本地授权验证</title><style>body{max-width:680px;margin:60px auto;padding:0 24px;font:16px/1.7 system-ui;background:#faf9f6;color:#222}h1{font-size:26px}a{color:#155e63}table{border-collapse:collapse;width:100%;margin:24px 0}td{border-bottom:1px solid #ddd;padding:10px 0}.button{display:inline-block;background:#155e63;color:white;padding:10px 18px;border-radius:6px;text-decoration:none}small{color:#555}pre{white-space:pre-wrap}</style>
<h1>PikPak 本地授权验证</h1><p>${phaseText[status.phase] ?? "状态更新中。"}</p>
<p>登录和授权在 PikPak 官方页面完成。本地程序通过系统凭据库保存令牌，不收集密码。</p>
${client && !callbackRunning && status.identity !== "pass" ? `<p><a class="button" href="/authorize/${localNonce}">前往 PikPak 登录与授权</a></p>` : ""}
<table>${rows.map(([label, result]) => `<tr><td>${label}</td><td>${labels[result ?? "pending"]}</td></tr>`).join("")}</table>
${status.lastError ? `<pre>${safe(JSON.stringify(status.lastError, null, 2))}</pre>` : ""}
${status.identity === "pass" ? `<h2>本地验证资料</h2><p>${status.fixtureStored ? "资料已保存到本机系统凭据库，页面不会回显。" : "请在此处提交测试资料，后续命令只引用钥匙串记录。"}</p>
<form id="fixture-form" method="post" action="/fixture/${localNonce}" autocomplete="off">
<p><label>完整分享文本<br><input type="password" name="text" autocomplete="off" required style="width:100%;padding:10px;box-sizing:border-box"></label></p>
<p><label>提取码（文本中已有则留空）<br><input type="password" name="passcode" autocomplete="off" style="padding:10px"></label></p>
<button type="submit" style="padding:10px 18px">保存到本机系统凭据库</button><p id="fixture-result" role="status"></p></form>
<small>仅保存在本机，供本次 PikPak 接口验证使用；不会写入项目文件、地址栏或日志。</small>` : ""}
<p><a href="/">刷新结果</a></p><small>授权结果不等于全部接口验证通过。页面不会显示账号资料或令牌。关闭终端验证进程可停止本地服务。</small>
<script nonce="${localNonce}">
const form = document.getElementById('fixture-form');
if (form) form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  const output = document.getElementById('fixture-result');
  button.disabled = true;
  output.textContent = '正在保存到本机系统凭据库…';
  try {
    const body = new URLSearchParams();
    for (const [name, value] of new FormData(form)) body.append(name, String(value));
    const response = await fetch(form.action, { method: 'POST', body, headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    const result = await response.json();
    if (response.ok && result.saved) { form.reset(); output.textContent = '资料已保存到本机系统凭据库，页面不会回显。'; }
    else output.textContent = '未保存成功，请检查格式后重试。错误：' + (result.error?.reason ?? 'request-failed');
  } catch { output.textContent = '未保存成功，无法连接本地验证服务。输入仍保留，请重试。'; }
  finally { button.disabled = false; }
});
</script></html>`;
}

const responseHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${localNonce}'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
};

const server = Bun.serve({
  hostname: "127.0.0.1", port: PORT,
  async fetch(request) {
    if (request.headers.get("host") !== `127.0.0.1:${PORT}`) return new Response("无效主机", { status: 400 });
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === `/fixture/${localNonce}`) {
      status.fixtureSubmissions++;
      if (request.headers.get("origin") !== ORIGIN || status.identity !== "pass" || callbackRunning) {
        status.lastError = { stage: "fixture", reason: "local-origin-or-session-rejected" };
        return Response.json({ saved: false, error: status.lastError }, { status: 403, headers: responseHeaders });
      }
      let saved = false;
      try {
        const body = await request.text();
        if (body.length > 32_768) throw new ProbeError("fixture", "input-too-large");
        const fields = new URLSearchParams(body);
        const fixture = parseFixture(fields.get("text") ?? "", fields.get("passcode") ?? "");
        const raw = await getSecret("session.current");
        if (!raw) throw new ProbeError("fixture", "login-required");
        const session = parseSession(raw);
        await setSecret("share-fixture.v1", JSON.stringify({ version: 1, accountId: session.accountId, ...fixture }));
        status.fixtureStored = true;
        status.lastError = null;
        saved = true;
      } catch (error) { status.lastError = cleanError(error); }
      if (request.headers.get("accept")?.includes("application/json")) {
        return Response.json({ saved, error: status.lastError }, { status: saved ? 200 : 400, headers: responseHeaders });
      }
      return new Response(null, { status: 303, headers: { ...responseHeaders, Location: "/" } });
    }
    if (request.method !== "GET") return new Response("不支持的方法", { status: 405 });
    if (url.pathname === "/") return new Response(html(), { headers: { ...responseHeaders, "Content-Type": "text/html; charset=utf-8" } });
    if (url.pathname === "/status") return Response.json({ ...status, gateComplete: false }, { headers: responseHeaders });
    if (url.pathname === `/authorize/${localNonce}`) {
      if (!client || callbackRunning || status.identity === "pass") return new Response("当前会话已验证或正在处理", { status: 409 });
      attempt = newAttempt();
      status.phase = "waiting-for-authorization";
      status.identity = "pending"; status.refresh = "pending"; status.quota = "pending"; status.lastError = null;
      return new Response(null, { status: 302, headers: { ...responseHeaders, Location: authorizationUrl(client, attempt) } });
    }
    if (url.pathname === "/callback") {
      if (!client || !attempt || callbackRunning) return new Response("没有可用授权尝试", { status: 400, headers: responseHeaders });
      try {
        const code = takeAuthorizationCode(url, attempt);
        callbackRunning = true;
        await finishAuthorization(code, attempt, client);
      } catch (error) {
        status.lastError = cleanError(error);
        status.phase = "failed";
      } finally {
        callbackRunning = false;
      }
      return new Response(null, { status: 303, headers: { ...responseHeaders, Location: "/" } });
    }
    return new Response("未找到", { status: 404, headers: responseHeaders });
  },
  error() { return new Response("本地验证遇到错误", { status: 500, headers: responseHeaders }); },
});

process.on("SIGINT", () => { server.stop(true); process.exit(0); });
process.on("SIGTERM", () => { server.stop(true); process.exit(0); });

try {
  await initialize();
  console.log(`本地授权验证已就绪：${ORIGIN}`);
} catch (error) {
  status.phase = "failed";
  if (!client) status.registration = "fail";
  status.lastError = cleanError(error);
  console.log(JSON.stringify({ phase: status.phase, error: status.lastError }));
}
