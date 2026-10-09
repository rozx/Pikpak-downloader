import type { FileIdentity } from "./types";
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
