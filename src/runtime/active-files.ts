import { AppError } from "../errors";
import type { Store } from "../state/store";

// 同时下载的文件数（add-concurrent-file-downloads 决策 5）：默认 1，允许 1–5；实际生效值还受账号等级限制。
export const DEFAULT_ACTIVE_FILES = 1, MAX_ACTIVE_FILES = 5;
export function parseActiveFiles(value: string): number | null { return /^[1-5]$/.test(value) ? Number(value) : null; }
export function configuredActiveFiles(store: Pick<Store, "config">): number {
  return parseActiveFiles(store.config("max_active_files") ?? "") ?? DEFAULT_ACTIVE_FILES;
}
// 超出 1–5、非整数或带多余字符的值一律拒绝，原值保持不变。
export function saveActiveFiles(store: Pick<Store, "setConfig">, value: number | string): number {
  const count = parseActiveFiles(String(value));
  if (count === null) throw new AppError("invalid_input");
  store.setConfig("max_active_files", String(count));
  return count;
}
