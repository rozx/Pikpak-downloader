import { randomUUID } from "node:crypto";
import { AppError } from "../errors";
import { authorizationUrl, exchange, newAttempt, takeAuthorizationCode, type Transport } from "../pikpak/protocol";
import type { SessionManager } from "./session";
import { grantedScopes, missingPermissions, permissionNames } from "./permissions";
import { failurePage, insufficientPage, landingPage, successPage } from "./login-page";

async function openBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? ["/usr/bin/open", url]
    : process.platform === "win32" ? ["rundll32.exe", "url.dll,FileProtocolHandler", url] : null;
  if (!command) throw new AppError("unsupported_platform");
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  if (await child.exited !== 0) throw new AppError("authorization_failed");
}

export type LoginOptions = { signal?: AbortSignal; openBrowser?: (url: string) => Promise<void>; http?: Transport };
export type LoginSession = Pick<SessionManager, "existingLogin" | "client" | "accept"> & Partial<Pick<SessionManager, "scopes">>;
// signal 取消时立即结束等待并关闭本地回调服务。
export async function login(session: LoginSession, force = false, announce = console.log,
  options: LoginOptions = {}): Promise<string> {
  if (!force) {
    try {
      const existing = await session.existingLogin();
      // 已保存的授权缺少必需权限时不复用，改走浏览器授权（improve-account-login 决策 3）。
      if (existing && !missingPermissions(await session.scopes?.() ?? null).length) return existing;
    } catch { /* 明确的 login 命令允许重新授权，旧任务仍保留。 */ }
  }
  const client = await session.client();
  const callback = new URL(client.redirectUri);
  let attempt = newAttempt();
  const nonce = randomUUID();
  let resolve!: (accountId: string) => void;
  let reject!: (reason: unknown) => void;
  const result = new Promise<string>((ok, bad) => { resolve = ok; reject = bad; });
  let callbackRunning = false;
  const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" };
  const server = Bun.serve({ hostname: "127.0.0.1", port: Number(callback.port),
    async fetch(request) {
      if (request.headers.get("host") !== callback.host || request.method !== "GET") return new Response("请求无效", { status: 400 });
      const url = new URL(request.url);
      if (url.pathname === `/authorize/${nonce}`) {
        // 上一次尝试已用掉或过期时（例如权限不足后重新授权）换用新的 state 与 PKCE 参数；未用掉时沿用，避免多开的标签页互相作废。
        if (attempt.used || Date.now() >= attempt.expiresAt) attempt = newAttempt();
        return new Response(null, { status: 302, headers: { ...headers, Location: authorizationUrl(client, attempt) } });
      }
      if (url.pathname === "/") return new Response(landingPage(`/authorize/${nonce}`), { headers });
      if (url.pathname !== "/callback" || callbackRunning) return new Response(failurePage("页面不可用。"), { headers, status: 404 });
      let code: string;
      try { code = takeAuthorizationCode(url, attempt); }
      catch {
        if (attempt.used) setTimeout(() => reject(new AppError("authorization_failed")), 200);
        return new Response(failurePage("授权响应无效或已被拒绝，请回到终端重新登录。"), { headers, status: 400 });
      }
      callbackRunning = true;
      try {
        const tokens = await exchange(client, code, attempt.verifier, options.http);
        // 保存前核对授权范围：缺少必需权限时不保存，保留原会话并继续等待重新授权。
        const missing = missingPermissions(grantedScopes(tokens));
        if (missing.length) {
          callbackRunning = false;
          announce(`授权缺少必须的权限：${permissionNames(missing)}。请在浏览器页面点击“重新授权”并勾选全部权限。`);
          return new Response(insufficientPage(missing, `/authorize/${nonce}`), { headers });
        }
        const account = await session.accept(tokens, client);
        setTimeout(() => resolve(account), 200);
        return new Response(successPage(), { headers });
      } catch {
        setTimeout(() => reject(new AppError("authorization_failed")), 200);
        return new Response(failurePage("授权未能保存，或账号身份与容量核对失败。请查看终端提示。"), { headers, status: 400 });
      }
    },
  });
  const timeout = setTimeout(() => reject(new AppError("authorization_failed")), 15 * 60_000);
  const cancel = () => reject(new AppError("authorization_failed"));
  if (options.signal?.aborted) cancel(); else options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    announce(`请在浏览器完成登录。本地入口：${callback.origin}`);
    await (options.openBrowser ?? openBrowser)(callback.origin).catch(() => { announce("自动打开浏览器失败，请手动打开上方本地入口。"); });
    return await result;
  } finally { clearTimeout(timeout); options.signal?.removeEventListener("abort", cancel); server.stop(true); }
}
