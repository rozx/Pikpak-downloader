// 授权范围（improve-account-login 决策 1、2）：PikPak 授权页让用户逐项勾选权限，登录后核对是否齐全。
export type Permission = { scope: string; label: string; use: string; required: boolean };
export const PERMISSIONS: readonly Permission[] = [
  { scope: "account", label: "账号信息", use: "读取身份、会员与容量", required: true },
  { scope: "files:manage", label: "管理文件", use: "转存、下载与释放云端副本", required: true },
  { scope: "share", label: "分享", use: "读取与转存分享", required: true },
  { scope: "cloud_download", label: "云下载", use: "本工具暂不使用", required: false },
];
// 登录基础范围不单独显示。
const BASIC = new Set(["openid", "profile", "email", "offline_access"]);

// 空格分隔的字符串或字符串数组；其他格式视为未知。
export function parseScopes(value: unknown): string[] | null {
  const items = typeof value === "string" ? value.split(/\s+/) : Array.isArray(value) && value.every(item => typeof item === "string") ? value as string[] : null;
  return items ? [...new Set(items.filter(Boolean))] : null;
}
// 访问令牌为 JWT 时读取载荷中的 scope 或 scp。只在进程内解码、不校验签名，仅用于提示。
export function jwtScopes(token: string): string[] | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    return payload && typeof payload === "object" ? parseScopes(payload.scope) ?? parseScopes(payload.scp) : null;
  } catch { return null; }
}
// 合并令牌响应与访问令牌载荷中的范围；两处都没有时为未知。
export function grantedScopes(tokens: { accessToken: string; scope?: string[] }): string[] | null {
  const response = tokens.scope, claims = jwtScopes(tokens.accessToken);
  return response || claims ? [...new Set([...response ?? [], ...claims ?? []])] : null;
}
// 实测（2026-10-15）：用户在授权页勾选全部权限后，服务端返回的范围仍不含任何应用权限，
// 只是回显登录基础范围。范围里一项应用权限都没有时，它不能说明授权页的勾选结果，按未知处理。
const known = new Set(PERMISSIONS.map(permission => permission.scope));
export const informativeScopes = (scopes: readonly string[] | null): readonly string[] | null =>
  scopes?.some(scope => known.has(scope)) ? scopes : null;
// 授权范围未知时不判定缺少。
export function missingPermissions(scopes: readonly string[] | null): Permission[] {
  const granted = informativeScopes(scopes);
  return granted ? PERMISSIONS.filter(permission => permission.required && !granted.includes(permission.scope)) : [];
}

export type PermissionState = "granted" | "missing" | "unknown";
export type PermissionRow = Permission & { state: PermissionState };
// 已知权限按定义顺序列出，再附上未知的额外范围。
// 其他范围即使不足以判断应用权限也照样列出，便于对照授权页。
export function permissionRows(scopes: readonly string[] | null): PermissionRow[] {
  const granted = informativeScopes(scopes);
  const rows: PermissionRow[] = PERMISSIONS.map(permission => ({ ...permission, state: !granted ? "unknown" : granted.includes(permission.scope) ? "granted" : "missing" }));
  for (const scope of scopes ?? []) if (!known.has(scope) && !BASIC.has(scope)) rows.push({ scope, label: scope, use: "其他权限", required: false, state: "granted" });
  return rows;
}
export const permissionNames = (permissions: readonly Permission[]) => permissions.map(permission => permission.label).join("、");
