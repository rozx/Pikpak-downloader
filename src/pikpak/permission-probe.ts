import { ProviderError, requestJson, transport, type Transport } from "./protocol";
import type { PermissionState, PermissionStates } from "../auth/permissions";

// 权限探测（improve-account-login 决策 2）：服务端返回的授权范围不反映授权页的勾选结果（见 design Evidence），
// 而服务端处理请求时会按实际授权放行或拒绝。每项权限用本工具实际会调用的接口探测，且都没有副作用：
// 只读请求，或针对不存在 ID 的写请求（PATCH 的请求体为空，即使 ID 碰巧存在也不改动任何内容）。
const PROBE_ID = "pikpak-downloader-permission-probe";
type Probe = { permission: string; label: string; path: string; init?: RequestInit };
const json = { "Content-Type": "application/json" };
export const PROBES: readonly Probe[] = [
  { permission: "account", label: "读取会员", path: "/drive/v1/privilege/vip" },
  { permission: "files:manage", label: "读取文件", path: `/drive/v1/files/${PROBE_ID}` },
  { permission: "files:manage", label: "修改文件", path: `/drive/v1/files/${PROBE_ID}`, init: { method: "PATCH", headers: json, body: "{}" } },
  { permission: "share", label: "读取分享", path: `/drive/v1/share?${new URLSearchParams({ share_id: PROBE_ID, pass_code: "" })}` },
  { permission: "cloud_download", label: "读取云下载", path: `/drive/v1/tasks/${PROBE_ID}` },
];
const denied = new Set(["permission_denied", "insufficient_scope", "access_denied", "unauthorized_client"]);

// 403 或权限类错误为缺少；其他 4xx（例如不存在、参数无效）说明请求已通过权限检查；401、网络错误与 5xx 无法判断。
export function classifyProbe(error: unknown): PermissionState {
  if (!error) return "granted";
  if (!(error instanceof ProviderError)) return "unknown";
  if (error.status === 403 || denied.has(error.reason)) return "missing";
  if (error.status === 401 || error.status === undefined || error.status >= 500 || error.status === 429) return "unknown";
  return error.status >= 400 ? "granted" : "unknown";
}

export type ProbeResult = { permission: string; label: string; status: number | null; reason: string | null; state: PermissionState };
export async function probePermissions(accessToken: string, http: Transport = transport, signal?: AbortSignal): Promise<ProbeResult[]> {
  return Promise.all(PROBES.map(async probe => {
    const headers = new Headers(probe.init?.headers); headers.set("Authorization", `Bearer ${accessToken}`);
    try {
      await requestJson("permission", new URL(probe.path, "https://api-drive.mypikpak.com").href, { ...probe.init, headers, ...signal ? { signal } : {} }, http);
      return { permission: probe.permission, label: probe.label, status: 200, reason: null, state: "granted" as const };
    } catch (error) {
      const provider = error instanceof ProviderError ? error : null;
      return { permission: probe.permission, label: probe.label, status: provider?.status ?? null, reason: provider?.reason ?? null, state: classifyProbe(error) };
    }
  }));
}
// 同一权限的多项探测：任一缺少即缺少；全部通过才算已授予；其余无法判断。
export function probeStates(results: readonly ProbeResult[]): PermissionStates {
  const states: PermissionStates = {};
  for (const result of results) {
    const previous = states[result.permission];
    states[result.permission] = previous === "missing" || result.state === "missing" ? "missing"
      : previous === "unknown" || result.state === "unknown" ? "unknown" : "granted";
  }
  return states;
}
