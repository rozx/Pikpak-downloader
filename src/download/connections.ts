import { AppError } from "../errors";
import type { Store } from "../state/store";

// 单个文件的下载连接数（add-parallel-segment-download 决策 3）：默认 4，允许 1–8，新值从下一个文件开始生效。
export const DEFAULT_CONNECTIONS = 4, MAX_CONNECTIONS = 8;
export function parseConnections(value: string): number | null { return /^[1-8]$/.test(value) ? Number(value) : null; }
// 未设置或库中值无效时取默认值。
export function configuredConnections(store: Pick<Store, "config">): number {
  return parseConnections(store.config("download_connections") ?? "") ?? DEFAULT_CONNECTIONS;
}
// 超出 1–8、非整数或带多余字符的值一律拒绝，原值保持不变。
export function saveConnections(store: Pick<Store, "setConfig">, value: number | string): number {
  const count = parseConnections(String(value));
  if (count === null) throw new AppError("invalid_input");
  store.setConfig("download_connections", String(count));
  return count;
}
