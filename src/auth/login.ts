import { randomUUID } from "node:crypto";
import { AppError } from "../errors";
import { authorizationUrl, exchange, newAttempt, takeAuthorizationCode } from "../pikpak/protocol";
import type { SessionManager } from "./session";

async function openBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? ["/usr/bin/open", url]
    : process.platform === "win32" ? ["rundll32.exe", "url.dll,FileProtocolHandler", url] : null;
  if (!command) throw new AppError("unsupported_platform");
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  if (await child.exited !== 0) throw new AppError("authorization_failed");
}

export async function login(session: SessionManager, force = false, announce = console.log): Promise<string> {
  if (!force) {
    try { const existing = await session.existingLogin(); if (existing) return existing; }
    catch { /* 明确的 login 命令允许重新授权，旧任务仍保留。 */ }
  }
  const client = await session.client();
  const callback = new URL(client.redirectUri);
  const attempt = newAttempt();
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
      if (url.pathname === `/authorize/${nonce}`) return new Response(null, { status: 302, headers: { ...headers, Location: authorizationUrl(client, attempt) } });
      if (url.pathname === "/") return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>PikPak 登录</title><h1>PikPak Downloader</h1><p>请在官方页面登录并授权。密码不会交给本地程序。</p><a href="/authorize/${nonce}">前往 PikPak 登录与授权</a></html>`, { headers });
      if (url.pathname !== "/callback" || callbackRunning) return new Response("页面不可用", { status: 404 });
      let code: string;
      try { code = takeAuthorizationCode(url, attempt); }
      catch {
        if (attempt.used) setTimeout(() => reject(new AppError("authorization_failed")), 200);
        return new Response("授权响应无效，请回到终端重新登录。", { headers, status: 400 });
      }
      callbackRunning = true;
      try {
        const tokens = await exchange(client, code, attempt.verifier);
        const account = await session.accept(tokens, client);
        setTimeout(() => resolve(account), 200);
        return new Response("登录已完成，可以关闭此页面并回到终端。", { headers });
      } catch {
        setTimeout(() => reject(new AppError("authorization_failed")), 200);
        return new Response("授权未能保存或权限检查失败，请查看终端提示。", { headers, status: 400 });
      }
    },
  });
  const timeout = setTimeout(() => reject(new AppError("authorization_failed")), 15 * 60_000);
  try {
    announce(`请在浏览器完成登录。本地入口：${callback.origin}`);
    await openBrowser(callback.origin).catch(() => { announce("自动打开浏览器失败，请手动打开上方本地入口。"); });
    return await result;
  } finally { clearTimeout(timeout); server.stop(true); }
}
