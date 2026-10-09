import { describe, expect, test } from "bun:test";
import { ENDPOINTS, ProviderError, authorizationUrl, discover, exchange, newAttempt, register,
  requestJson, takeAuthorizationCode, type Client, type Transport } from "../src/pikpak/protocol";

const redirectUri = "http://127.0.0.1:53682/callback";
const client: Client = { clientId: "synthetic-client", clientSecret: "synthetic-secret", redirectUri,
  authMethod: "client_secret_post" };

describe("授权响应边界", () => {
  test("使用标准 PKCE S256 向量，不把校验器送入授权 URL", () => {
    const attempt = newAttempt();
    attempt.verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const url = new URL(authorizationUrl(client, attempt));
    expect(url.searchParams.get("code_challenge")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.href).not.toContain(attempt.verifier);
    expect(url.href).not.toContain(client.clientSecret);
  });
  test("错误或重复 state 不消费合法尝试，合法响应只能消费一次", () => {
    const attempt = newAttempt();
    const url = new URL(redirectUri);
    url.search = new URLSearchParams({ state: "wrong", code: "synthetic-code" }).toString();
    expect(() => takeAuthorizationCode(url, attempt)).toThrow("state-mismatch");
    expect(attempt.used).toBe(false);
    url.searchParams.set("state", attempt.state);
    url.searchParams.append("state", attempt.state);
    expect(() => takeAuthorizationCode(url, attempt)).toThrow("state-mismatch");
    url.searchParams.delete("state");
    url.searchParams.set("state", attempt.state);
    expect(takeAuthorizationCode(url, attempt)).toBe("synthetic-code");
    expect(() => takeAuthorizationCode(url, attempt)).toThrow("expired-or-consumed");
  });
  test("拒绝过期、错误 issuer 和多个 code", () => {
    const attempt = newAttempt(0);
    const url = new URL(redirectUri);
    url.search = new URLSearchParams({ state: attempt.state, code: "synthetic-code" }).toString();
    expect(() => takeAuthorizationCode(url, attempt, attempt.expiresAt)).toThrow("expired-or-consumed");
    url.searchParams.set("iss", "https://example.invalid");
    expect(() => takeAuthorizationCode(url, attempt, 1)).toThrow("issuer-mismatch");
    url.searchParams.delete("iss");
    url.searchParams.append("code", "second");
    expect(() => takeAuthorizationCode(url, attempt, 1)).toThrow("invalid-code-response");
  });
});

describe("提供方请求与脱敏", () => {
  test("不采用发现文档中意外改变的端点", async () => {
    const http: Transport = async () => Response.json({ ...ENDPOINTS,
      token_endpoint: "https://example.invalid/token", code_challenge_methods_supported: ["S256"] });
    await expect(discover(http)).rejects.toThrow("endpoint-changed");
  });
  test("注册本工具的原生客户端与精确回调", async () => {
    let requestBody: Record<string, unknown> = {};
    const http: Transport = async (url, init) => {
      expect(url).toBe(ENDPOINTS.registration_endpoint);
      requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json({ client_id: "registered", client_secret: "synthetic-generated",
        redirect_uris: [redirectUri], token_endpoint_auth_method: "client_secret_post" }, { status: 201 });
    };
    const result = await register(redirectUri, http);
    expect(result.clientId).toBe("registered");
    expect(requestBody.application_type).toBe("native");
    expect(requestBody.redirect_uris).toEqual([redirectUri]);
    expect(requestBody.client_name).toBe("Pikpak Downloader");
  });
  test("拒绝注册结果中的不同回调", async () => {
    const http: Transport = async () => Response.json({ client_id: "registered", client_secret: "synthetic",
      redirect_uris: ["http://127.0.0.1:9/callback"] });
    await expect(register(redirectUri, http)).rejects.toThrow("redirect-mismatch");
  });
  test("授权码交换使用表单、原回调和 PKCE，禁止自动跟随重定向", async () => {
    const http: Transport = async (url, init) => {
      expect(url).toBe(ENDPOINTS.token_endpoint);
      expect(init.redirect).toBe("error");
      const body = new URLSearchParams(String(init.body));
      expect(body.get("code_verifier")).toBe("synthetic-verifier");
      expect(body.get("redirect_uri")).toBe(redirectUri);
      expect(body.get("client_secret")).toBe(client.clientSecret);
      return Response.json({ token_type: "Bearer", access_token: "synthetic-access", expires_in: 60 });
    };
    expect((await exchange(client, "synthetic-code", "synthetic-verifier", http)).accessToken).toBe("synthetic-access");
  });
  test("错误不包含服务端回显的秘密或响应原文", async () => {
    const privateValue = "synthetic-do-not-print";
    const http: Transport = async () => Response.json({ error: "invalid_grant",
      error_description: privateValue, access_token: privateValue }, { status: 400 });
    try {
      await requestJson("test", ENDPOINTS.token_endpoint, {}, http);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect(String(error)).not.toContain(privateValue);
      expect(JSON.stringify(error)).not.toContain(privateValue);
    }
  });
});
