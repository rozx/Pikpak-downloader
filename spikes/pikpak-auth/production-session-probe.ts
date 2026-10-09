import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MacSecrets } from "../../src/auth/secrets";
import { SessionManager } from "../../src/auth/session";

// 本工具验证阶段的授权可用于业务代码验收；仅在业务凭据为空时迁移，不覆盖已有账号。
async function main() {
  const source = new MacSecrets("com.rozx.pikpak-downloader.verification");
  const target = new MacSecrets();
  const sourceManager = new SessionManager(source);
  const accountId = await sourceManager.existingLogin();
  if (!accountId) throw Error("source-session-required");
  const client = await sourceManager.client();
  const existing = await target.get("session.current");
  const targetManager = new SessionManager(target);
  if (existing) {
    if (await targetManager.existingLogin() !== accountId) throw Error("target-account-mismatch");
  } else {
    const existingClient = await target.get("openid-client.v1");
    if (existingClient && existingClient !== JSON.stringify(client)) throw Error("target-client-already-configured");
    const raw = await source.get("session.current");
    if (!raw) throw Error("source-session-required");
    const session = JSON.parse(raw) as { accountId: string; accessKey: string; refreshKey?: string; expiresAt: number };
    if (session.accountId !== accountId || !/^session\.[0-9a-f-]{36}\.access$/.test(session.accessKey)
      || (session.refreshKey && !/^session\.[0-9a-f-]{36}\.refresh$/.test(session.refreshKey))) throw Error("invalid-source-session");
    const accessToken = await source.get(session.accessKey);
    const refreshToken = session.refreshKey ? await source.get(session.refreshKey) : null;
    if (!accessToken) throw Error("source-token-required");
    await target.set("openid-client.v1", JSON.stringify(client));
    await targetManager.accept({ accessToken, ...(refreshToken ? { refreshToken } : {}),
      expiresIn: Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000)) }, client);
  }
  const state = await mkdtemp(join(tmpdir(), "pikpak-production-session-"));
  try {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), "login"], {
      env: { ...process.env, PIKPAK_DOWNLOADER_STATE_DIR: state }, stdin: "ignore", stdout: "pipe", stderr: "ignore",
    });
    const output = await new Response(child.stdout).text();
    if (await child.exited !== 0 || output.trim() !== "登录成功，账号身份与容量读取已核对。") throw Error("production-login-failed");
    console.log(JSON.stringify({ productionCliLogin: true, existingAuthorizationReused: true, identityAndQuotaVerified: true,
      protectedProductionSessionSaved: true, testShareMigrated: false }));
  } finally { await rm(state, { recursive: true, force: true }); }
}
try { await main(); }
catch { console.log(JSON.stringify({ productionCliLogin: false, privateDetailsOmitted: true })); process.exitCode = 1; }
