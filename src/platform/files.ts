import type { FileIdentity } from "./types";
// 单次读取的最大字节数。Windows 文件桥每次调用都要往返一条 JSON 行（base64 后约 700 KB，低于 1 MiB 上限），
// 读得越大调用越少；64 KiB 时整文件读回只有约 13 MiB/s。
export const READ_BLOCK = 524288;
export interface LocalFile {
  info(): Promise<{ identity: FileIdentity; size: bigint }>;
  read(position: bigint, length: number): Promise<Uint8Array>;
  write(position: bigint, data: Uint8Array): Promise<void>;
  truncate(size: bigint): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
export interface LocalDirectory {
  identity(): Promise<FileIdentity>;
  freeBytes(): Promise<bigint>;
  child(name: string, create: boolean): Promise<LocalDirectory>;
  file(name: string, create: boolean, readOnly?: boolean): Promise<LocalFile>;
  publish(sourceName: string, target: LocalDirectory, targetName: string): Promise<boolean>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
export type LocalFileSystem = { root(path: string): Promise<LocalDirectory>; close(): Promise<void> };
export function sameIdentity(first: FileIdentity, second: FileIdentity): boolean { return first.volume === second.volume && first.file === second.file; }
