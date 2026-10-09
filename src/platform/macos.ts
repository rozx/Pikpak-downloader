import { AppError } from "../errors";
export interface MacNative {
  generalBoard(): string;
  boardCount(name: string): bigint;
  boardText(name: string): string | null;
  createBoard(): string;
  writeBoard(name: string, value: string): void;
  releaseBoard(name: string): void;
  identity(path: string): { dev: bigint; ino: bigint };
  publish(source: string, target: string): boolean;
  rootOpen(path: string): object;
  directoryOpen(parent: object, name: string, create: boolean): object;
  directoryIdentity(directory: object): { dev: bigint; ino: bigint };
  directoryFree(directory: object): bigint;
  directorySync(directory: object): void;
  directoryClose(directory: object): void;
  leafOpen(directory: object, name: string, create: boolean, readOnly: boolean): number;
  leafRename(source: object, name: string, destination: object, target: string): boolean;
  stableDirectoryIdentity(directory: object): { volume: string; file: string };
  stableFileIdentity(fd: number): { volume: string; file: string };
}
let instance: MacNative | undefined;
export function macNative(): MacNative {
  if (process.platform === "darwin") {
    if (!instance) instance = process.arch === "arm64" ? require("../../dist/native/macos-arm64.node") : require("../../dist/native/macos-x64.node");
    return instance!;
  }
  throw new AppError("unsupported_platform");
}
