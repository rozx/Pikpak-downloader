import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { parseScopes } from "../auth/permissions";

export const ENDPOINTS = {
  issuer: "https://user.mypikpak.com",
  discovery: "https://user.mypikpak.com/.well-known/openid-configuration",
  authorization_endpoint: "https://mypikpak.com/drive/auth-center",
  registration_endpoint: "https://user.mypikpak.com/v1/clients-registrations/openid-connect",
  token_endpoint: "https://user.mypikpak.com/v1/auth/token",
  userinfo_endpoint: "https://user.mypikpak.com/v1/user/me",
  quota: "https://api-drive.mypikpak.com/drive/v1/about",
} as const;

export type Transport = (input: string, init: RequestInit) => Promise<Response>;
export const transport: Transport = (input, init) => fetch(input, init);
const serverTimes = new WeakMap<object, number>();
export const serverTime = (data: Record<string, unknown>): number | null => serverTimes.get(data) ?? null;

export class ProviderError extends Error {
  constructor(readonly stage: string, readonly reason: string, readonly status?: number, readonly retryAfterMs?: number) {
    super(`${stage}: ${reason}`);
    this.name = "ProviderError";
  }
}
export function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : /^[A-Za-z]{3},/.test(value) ? Date.parse(value) - now : NaN;
  return Number.isNaN(delay) ? undefined : Math.max(0, Math.min(delay, Number.MAX_SAFE_INTEGER - now));
}

const permittedErrors = new Set([
  "invalid_client", "invalid_client_metadata", "invalid_redirect_uri", "invalid_request",
  "invalid_scope", "invalid_grant", "unauthorized_client", "access_denied", "insufficient_scope",
  "interaction_required", "login_required", "temporarily_unavailable", "server_error",
  "file_restore_own", "file_space_not_enough", "permission_denied", "not_found", "file_not_found",
  "download_quota_exceeded", "download_traffic_not_enough", "download_flow_not_enough", "traffic_limit_exceeded",
]);

function object(value: unknown, stage: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError(stage, "unexpected-response");
  }
  return value as Record<string, unknown>;
}

function nonempty(value: unknown, stage: string): string {
  if (typeof value !== "string" || !value.length) throw new ProviderError(stage, "missing-field");
  return value;
}

export async function requestJson(
  stage: string,
  url: string,
  init: RequestInit = {},
  http: Transport = transport,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    const timeout = AbortSignal.timeout(20_000);
    response = await http(url, { ...init, redirect: "error", signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  } catch {
    throw new ProviderError(stage, "network-error");
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ProviderError(stage, "non-json-response", response.status, retryAfter(response.headers.get("retry-after")));
  }
  const data = object(value, stage);
  if (!response.ok || data.error || (typeof data.error_code === "number" && data.error_code !== 0)) {
    const reason = typeof data.error === "string" && permittedErrors.has(data.error)
      ? data.error : "provider-error";
    // 不输出服务端 description、响应全文或请求参数，它们可能包含秘密。
    throw new ProviderError(stage, reason, response.status, retryAfter(response.headers.get("retry-after")));
  }
  const remoteDate = response.headers.get("date");
  if (remoteDate && Number.isFinite(Date.parse(remoteDate))) serverTimes.set(data, Date.parse(remoteDate));
  return data;
}

export async function discover(http: Transport = transport): Promise<void> {
  const metadata = await requestJson("discovery", ENDPOINTS.discovery, {}, http);
  for (const field of ["issuer", "authorization_endpoint", "registration_endpoint", "token_endpoint", "userinfo_endpoint"] as const) {
    if (metadata[field] !== ENDPOINTS[field]) throw new ProviderError("discovery", "endpoint-changed");
  }
  const methods = metadata.code_challenge_methods_supported;
  if (!Array.isArray(methods) || !methods.includes("S256")) throw new ProviderError("discovery", "pkce-unavailable");
}

export type Client = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authMethod: "client_secret_post";
};

export function parseClient(value: unknown, redirectUri: string): Client {
  const data = object(value, "registration");
  if (data.token_endpoint_auth_method && data.token_endpoint_auth_method !== "client_secret_post") {
    throw new ProviderError("registration", "unsupported-client-auth");
  }
  if (!Array.isArray(data.redirect_uris) || !data.redirect_uris.includes(redirectUri)) {
    throw new ProviderError("registration", "redirect-mismatch");
  }
  return {
    clientId: nonempty(data.client_id, "registration"),
    clientSecret: nonempty(data.client_secret, "registration"),
    redirectUri,
    authMethod: "client_secret_post",
  };
}

export async function register(redirectUri: string, http: Transport = transport): Promise<Client> {
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1" || redirect.pathname !== "/callback") {
    throw new ProviderError("registration", "invalid-local-redirect");
  }
  const data = await requestJson("registration", ENDPOINTS.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "PikPak DL CLI",
      client_uri: "https://github.com/rozx/pikpak-dl-cli",
      application_type: "native",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    }),
  }, http);
  return parseClient(data, redirectUri);
}

export type Attempt = { state: string; verifier: string; expiresAt: number; used: boolean };
export function newAttempt(now = Date.now()): Attempt {
  return { state: randomBytes(32).toString("base64url"), verifier: randomBytes(32).toString("base64url"),
    expiresAt: now + 15 * 60_000, used: false };
}

export function authorizationUrl(client: Client, attempt: Attempt): string {
  const url = new URL(ENDPOINTS.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    scope: "openid profile",
    state: attempt.state,
    code_challenge: createHash("sha256").update(attempt.verifier).digest("base64url"),
    code_challenge_method: "S256",
    prompt: "consent",
  }).toString();
  return url.href;
}

export function takeAuthorizationCode(url: URL, attempt: Attempt, now = Date.now()): string {
  const states = url.searchParams.getAll("state");
  const expected = Buffer.from(attempt.state);
  const received = Buffer.from(states[0] ?? "");
  if (states.length !== 1 || received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new ProviderError("callback", "state-mismatch");
  }
  if (attempt.used || now >= attempt.expiresAt) throw new ProviderError("callback", "expired-or-consumed");
  const issuers = url.searchParams.getAll("iss");
  if (issuers.length > 1 || (issuers.length === 1 && issuers[0] !== ENDPOINTS.issuer)) {
    throw new ProviderError("callback", "issuer-mismatch");
  }
  if (url.searchParams.has("error")) {
    attempt.used = true;
    throw new ProviderError("callback", "authorization-denied");
  }
  const codes = url.searchParams.getAll("code");
  if (codes.length !== 1 || !codes[0]) throw new ProviderError("callback", "invalid-code-response");
  attempt.used = true;
  return codes[0];
}

// scope：服务端授予的授权范围（RFC 6749 §5.1）；未返回时省略。
export type Tokens = { accessToken: string; refreshToken?: string; expiresIn: number; scope?: string[] };
function tokens(data: Record<string, unknown>, stage: string): Tokens {
  if (typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer") {
    throw new ProviderError(stage, "unsupported-token-type");
  }
  const accessToken = nonempty(data.access_token, stage);
  const expiresIn = typeof data.expires_in === "number" && Number.isFinite(data.expires_in)
    ? data.expires_in : 0;
  const scope = parseScopes(data.scope);
  return { accessToken, expiresIn, ...(scope ? { scope } : {}),
    ...(typeof data.refresh_token === "string" && data.refresh_token ? { refreshToken: data.refresh_token } : {}) };
}

export async function exchange(client: Client, code: string, verifier: string, http: Transport = transport): Promise<Tokens> {
  const data = await requestJson("token-exchange", ENDPOINTS.token_endpoint, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.clientId,
      client_secret: client.clientSecret, redirect_uri: client.redirectUri, code, code_verifier: verifier }),
  }, http);
  return tokens(data, "token-exchange");
}

export async function refresh(client: Client, refreshToken: string, http: Transport = transport): Promise<Tokens> {
  const data = await requestJson("token-refresh", ENDPOINTS.token_endpoint, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.clientId,
      client_secret: client.clientSecret, refresh_token: refreshToken }),
  }, http);
  return tokens(data, "token-refresh");
}

export type Profile = { id: string; name: string | null; email: string | null };
export async function profile(accessToken: string, http: Transport = transport): Promise<Profile> {
  const data = await requestJson("identity", ENDPOINTS.userinfo_endpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }, http);
  const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
  return { id: nonempty(data.sub, "identity"), name: text(data.name), email: text(data.email) };
}
export async function identity(accessToken: string, http: Transport = transport): Promise<string> {
  return (await profile(accessToken, http)).id;
}

export async function quotaReadable(accessToken: string, http: Transport = transport): Promise<void> {
  const data = await requestJson("quota", ENDPOINTS.quota, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }, http);
  object(data.quota, "quota");
}
