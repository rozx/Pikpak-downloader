import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

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

export class ProbeError extends Error {
  constructor(readonly stage: string, readonly reason: string, readonly status?: number) {
    super(`${stage}: ${reason}`);
    this.name = "ProbeError";
  }
}

const permittedErrors = new Set([
  "invalid_client", "invalid_client_metadata", "invalid_redirect_uri", "invalid_request",
  "invalid_scope", "invalid_grant", "unauthorized_client", "access_denied", "insufficient_scope",
  "interaction_required", "login_required", "temporarily_unavailable", "server_error",
  "file_restore_own", "file_space_not_enough", "permission_denied", "not_found", "file_not_found",
]);

function object(value: unknown, stage: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProbeError(stage, "unexpected-response");
  }
  return value as Record<string, unknown>;
}

function nonempty(value: unknown, stage: string): string {
  if (typeof value !== "string" || !value.length) throw new ProbeError(stage, "missing-field");
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
    response = await http(url, { ...init, redirect: "error", signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new ProbeError(stage, "network-error");
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ProbeError(stage, "non-json-response", response.status);
  }
  const data = object(value, stage);
  if (!response.ok || data.error || (typeof data.error_code === "number" && data.error_code !== 0)) {
    const reason = typeof data.error === "string" && permittedErrors.has(data.error)
      ? data.error : "provider-error";
    // 不输出服务端 description、响应全文或请求参数，它们可能包含秘密。
    throw new ProbeError(stage, reason, response.status);
  }
  return data;
}

export async function discover(http: Transport = transport): Promise<void> {
  const metadata = await requestJson("discovery", ENDPOINTS.discovery, {}, http);
  for (const field of ["issuer", "authorization_endpoint", "registration_endpoint", "token_endpoint", "userinfo_endpoint"] as const) {
    if (metadata[field] !== ENDPOINTS[field]) throw new ProbeError("discovery", "endpoint-changed");
  }
  const methods = metadata.code_challenge_methods_supported;
  if (!Array.isArray(methods) || !methods.includes("S256")) throw new ProbeError("discovery", "pkce-unavailable");
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
    throw new ProbeError("registration", "unsupported-client-auth");
  }
  if (!Array.isArray(data.redirect_uris) || !data.redirect_uris.includes(redirectUri)) {
    throw new ProbeError("registration", "redirect-mismatch");
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
    throw new ProbeError("registration", "invalid-local-redirect");
  }
  const data = await requestJson("registration", ENDPOINTS.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Pikpak Downloader Local Verification",
      client_uri: "https://github.com/rozx/Pikpak-downloader",
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
    throw new ProbeError("callback", "state-mismatch");
  }
  if (attempt.used || now >= attempt.expiresAt) throw new ProbeError("callback", "expired-or-consumed");
  const issuers = url.searchParams.getAll("iss");
  if (issuers.length > 1 || (issuers.length === 1 && issuers[0] !== ENDPOINTS.issuer)) {
    throw new ProbeError("callback", "issuer-mismatch");
  }
  if (url.searchParams.has("error")) {
    attempt.used = true;
    throw new ProbeError("callback", "authorization-denied");
  }
  const codes = url.searchParams.getAll("code");
  if (codes.length !== 1 || !codes[0]) throw new ProbeError("callback", "invalid-code-response");
  attempt.used = true;
  return codes[0];
}

export type Tokens = { accessToken: string; refreshToken?: string; expiresIn: number };
function tokens(data: Record<string, unknown>, stage: string): Tokens {
  if (typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer") {
    throw new ProbeError(stage, "unsupported-token-type");
  }
  const accessToken = nonempty(data.access_token, stage);
  const expiresIn = typeof data.expires_in === "number" && Number.isFinite(data.expires_in)
    ? data.expires_in : 0;
  return { accessToken, expiresIn,
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

export async function identity(accessToken: string, http: Transport = transport): Promise<string> {
  const data = await requestJson("identity", ENDPOINTS.userinfo_endpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }, http);
  return nonempty(data.sub, "identity");
}

export async function quotaReadable(accessToken: string, http: Transport = transport): Promise<void> {
  const data = await requestJson("quota", ENDPOINTS.quota, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }, http);
  object(data.quota, "quota");
}
