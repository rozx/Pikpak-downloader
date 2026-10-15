/// <reference path="./assets.d.ts" />
import { close, fstat, fsync, ftruncate, open, read, write, type BigIntStats } from "node:fs";
import script from "./windows-files.ps1" with { type: "text" };
import { ProcessBridge } from "./process-bridge";
import { READ_BLOCK, type LocalDirectory, type LocalFile, type LocalFileSystem } from "./files";
import type { FileIdentity } from "./types";

function handle(value: unknown): string { if (typeof value !== "string" || !/^[a-f0-9-]{36}$/i.test(value)) throw Error("invalid-native-handle"); return value; }
function info(value: unknown): { identity: FileIdentity; size: bigint } {
  const data = value as { identity?: { volume?: unknown; file?: unknown }; size?: unknown };
  if (!data || typeof data.identity?.volume !== "string" || typeof data.identity.file !== "string"
    || typeof data.size !== "string" || !/^\d+$/.test(data.size)) throw Error("invalid-native-info");
  return { identity: { volume: data.identity.volume, file: data.identity.file }, size: BigInt(data.size) };
}
const settle = <T>(run: (done: (error: NodeJS.ErrnoException | null, value?: T) => void) => void) =>
  new Promise<T>((resolve, reject) => run((error, value) => error ? reject(error) : resolve(value as T)));
function offset(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("file-offset-unrepresentable");
  return Number(value);
}
// FILETIME（1601 起的 100 ns）换成 fstat 的 Unix 纳秒。
const filetimeToNs = (value: string) => (BigInt(value) - 116444736000000000n) * 100n;

// 文件仍由文件桥按目录句柄相对打开并核对身份；数据读写改用同一文件的 Bun 文件描述符，
// 避免每 64 KiB 一次 JSON 往返（实测文件桥约 23–49 MiB/s，描述符为磁盘速度）。
// 描述符按文件桥给出的路径打开后，必须与文件桥的卷序列号、文件索引和创建时间完全一致才使用，否则退回文件桥读写。
class WindowsFile implements LocalFile {
  private fd: number | null = null;
  private constructor(private readonly bridge: ProcessBridge, private readonly id: string) {}
  static async open(bridge: ProcessBridge, id: string, readOnly: boolean): Promise<WindowsFile> {
    const file = new WindowsFile(bridge, id);
    try { await file.attach(readOnly); } catch { /* 打不开或身份不符时继续用文件桥读写。 */ }
    return file;
  }
  private async attach(readOnly: boolean): Promise<void> {
    const native = await this.bridge.call({ action: "native", id: this.id }) as { path?: unknown; serial?: unknown; index?: unknown; created?: unknown };
    if (typeof native?.path !== "string" || typeof native.serial !== "string" || typeof native.index !== "string" || typeof native.created !== "string") return;
    const fd = await settle<number>(done => open(native.path as string, readOnly ? "r" : "r+", done));
    try {
      const stat = await settle<BigIntStats>(done => fstat(fd, { bigint: true }, done));
      if (stat.ino.toString() !== native.index || stat.dev.toString() !== native.serial || stat.birthtimeNs !== filetimeToNs(native.created)) throw Error("identity-mismatch");
      this.fd = fd;
    } catch (error) { await settle<void>(done => close(fd, done)).catch(() => {}); throw error; }
  }
  get direct(): boolean { return this.fd !== null; }
  async info() { return info(await this.bridge.call({ action: "info", id: this.id })); }
  async read(position: bigint, length: number) {
    if (this.fd !== null) {
      const fd = this.fd, buffer = Buffer.alloc(length);
      const bytes = await settle<number>(done => read(fd, buffer, 0, length, offset(position), done));
      return buffer.subarray(0, bytes);
    }
    const encoded = await this.bridge.call({ action: "read", id: this.id, offset: position.toString(), length: Math.min(length, READ_BLOCK) });
    if (typeof encoded !== "string") throw Error("invalid-native-read"); return Buffer.from(encoded, "base64");
  }
  async write(position: bigint, data: Uint8Array) {
    if (this.fd !== null) {
      const fd = this.fd;
      for (let written = 0; written < data.byteLength;) {
        const bytes = await settle<number>(done => write(fd, data, written, data.byteLength - written, offset(position + BigInt(written)), done));
        if (!bytes) throw Error("zero-byte-write");
        written += bytes;
      }
      return;
    }
    for (let at = 0; at < data.byteLength; at += 65536) await this.bridge.call({ action: "write", id: this.id,
      offset: (position + BigInt(at)).toString(), data: Buffer.from(data.subarray(at, at + 65536)).toString("base64") });
  }
  async truncate(size: bigint) {
    if (this.fd !== null) { const fd = this.fd; await settle<void>(done => ftruncate(fd, offset(size), done)); return; }
    await this.bridge.call({ action: "truncate", id: this.id, size: size.toString() });
  }
  async sync() {
    if (this.fd !== null) { const fd = this.fd; await settle<void>(done => fsync(fd, done)); return; }
    await this.bridge.call({ action: "sync", id: this.id });
  }
  async close() {
    const fd = this.fd; this.fd = null;
    try { if (fd !== null) await settle<void>(done => close(fd, done)); }
    finally { await this.bridge.call({ action: "close", id: this.id }); }
  }
}
class WindowsDirectory implements LocalDirectory {
  constructor(private readonly bridge: ProcessBridge, private readonly id: string) {}
  async identity() { return info(await this.bridge.call({ action: "info", id: this.id })).identity; }
  async freeBytes() {
    const value = await this.bridge.call({ action: "free", id: this.id });
    if (typeof value !== "string" || !/^\d+$/.test(value)) throw Error("invalid-native-size"); return BigInt(value);
  }
  async child(name: string, create: boolean) {
    return new WindowsDirectory(this.bridge, handle(await this.bridge.call({ action: "child", parent: this.id, name, directory: true, create })));
  }
  async file(name: string, create: boolean, readOnly = false) {
    return WindowsFile.open(this.bridge, handle(await this.bridge.call({ action: "child", parent: this.id, name, directory: false, create, readOnly })), readOnly);
  }
  async publish(name: string, target: LocalDirectory, targetName: string) {
    if (!(target instanceof WindowsDirectory) || target.bridge !== this.bridge) throw Error("filesystem-mismatch");
    return await this.bridge.call({ action: "publish", id: this.id, name, target: target.id, targetName }) === true;
  }
  async sync() { await this.bridge.call({ action: "sync", id: this.id }); }
  async close() { await this.bridge.call({ action: "close", id: this.id }); }
}
export function windowsFileSystem(): LocalFileSystem {
  const bridge = new ProcessBridge(script);
  return { root: async path => new WindowsDirectory(bridge, handle(await bridge.call({ action: "root", path }))), close: () => bridge.close() };
}
