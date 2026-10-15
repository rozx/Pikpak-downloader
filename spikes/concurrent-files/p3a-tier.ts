// P3a：用本工具已授权的会话只读判断账号等级（add-concurrent-file-downloads 决策 1）。
// 依次尝试会员信息类接口与容量接口，只输出状态码、字段名和等级相关的取值，不输出账号 ID、邮箱、令牌或签名地址。
//
// 用法（需先退出正在运行的界面或 watch，本程序持有执行锁）：
//   bun spikes/concurrent-files/p3a-tier.ts [结果 JSON 路径]
import { writeFile } from "node:fs/promises";
import { prepareState } from "../../src/state/paths";
import { acquireQueueLock } from "../../src/state/lock";
import { Store } from "../../src/state/store";
import { systemSecrets } from "../../src/auth/secrets";
import { SessionManager } from "../../src/auth/session";

const GiB = 1073741824;
// 只读 GET；会员接口的路径来自官方网页客户端与社区实现，是否对本工具的授权开放正是要验证的内容。
const candidates = [
  { name: "drive-privilege-vip", url: "https://api-drive.mypikpak.com/drive/v1/privilege/vip" },
  { name: "vip-info", url: "https://api-drive.mypikpak.com/vip/v1/vip/info" },
  { name: "vip-info-legacy", url: "https://api-drive.mypikpak.com/vip/v1/vip/info?type=all" },
  { name: "drive-about", url: "https://api-drive.mypikpak.com/drive/v1/about" },
];
// 只保留与等级相关、不能识别个人身份的字段取值。
const TIER_KEYS = /^(type|status|vip_status|is_vip|vip_type|level|plan|product|product_type|expire_status|kind)$/i;
const EXPIRY_KEYS = /expire|expiry|end_time|expires_at/i;

function describe(value: unknown, depth = 0): unknown {
  if (depth > 3 || value === null || typeof value !== "object") return typeof value;
  if (Array.isArray(value)) return value.length ? [describe(value[0], depth + 1)] : [];
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, describe(item, depth + 1)]));
}
function tierFields(value: unknown, path = "", found: Record<string, unknown> = {}, depth = 0): Record<string, unknown> {
  if (depth > 4 || value === null || typeof value !== "object") return found;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const at = path ? `${path}.${key}` : key;
    if (TIER_KEYS.test(key) && (typeof item === "string" || typeof item === "boolean" || typeof item === "number")) found[at] = item;
    else if (EXPIRY_KEYS.test(key) && typeof item === "string") {
      const time = Date.parse(item);
      found[at] = Number.isFinite(time) ? (time > Date.now() ? "future" : "past") : "unparsed";
    } else tierFields(item, at, found, depth + 1);
  }
  return found;
}

const paths = await prepareState();
const lock = acquireQueueLock(paths.lock);
const store = new Store(paths.database, true);
try {
  const account = store.config("active_account");
  if (!account) throw Error("尚未登录：先运行程序完成浏览器授权");
  const manager = new SessionManager(systemSecrets(), undefined, () => {});
  if (await manager.existingLogin() !== account) throw Error("登录会话与任务库账号不一致");
  const token = await manager.access(account);
  const results: unknown[] = [];
  for (const candidate of candidates) {
    const response = await fetch(candidate.url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, redirect: "error" })
      .catch(() => null);
    if (!response) { results.push({ name: candidate.name, status: "network-error" }); continue; }
    const text = await response.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* 非 JSON 时只记录状态码 */ }
    const entry: Record<string, unknown> = { name: candidate.name, status: response.status, shape: describe(body), tier: tierFields(body) };
    if (candidate.name === "drive-about" && body && typeof body === "object") {
      const limit = Number((body as { quota?: { limit?: unknown } }).quota?.limit);
      if (Number.isFinite(limit)) entry.quotaLimitGiB = Math.round(limit / GiB);
    }
    // 服务端错误码（如 permission_denied、unauthorized）有助于判断是否缺少授权，不含个人信息。
    if (response.status >= 400 && body && typeof body === "object") entry.error = (body as { error?: unknown }).error ?? null;
    results.push(entry); console.log(JSON.stringify(entry));
  }
  const output = process.argv[2];
  if (output) await writeFile(output, `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`);
} catch (error) {
  console.log(`P3a 未完成：${error instanceof Error ? error.message : "未知错误"}`);
  process.exitCode = 1;
} finally { store.close(); lock.release(); }
