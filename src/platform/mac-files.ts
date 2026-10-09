import { close, fstat, fsync, ftruncate, read, write, type BigIntStats } from "node:fs";
import type { LocalDirectory, LocalFile, LocalFileSystem } from "./files";
import { macNative } from "./macos";

function position(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("file-offset-unrepresentable");
  return Number(value);
}
class MacFile implements LocalFile {
  private closed = false;
  constructor(private readonly fd: number) {}
  private check() { if (this.closed) throw Error("file-closed"); }
  async info() {
    this.check();
    const value = await new Promise<BigIntStats>((resolve, reject) => {
      fstat(this.fd, { bigint: true }, (error, info) => error ? reject(error) : resolve(info));
    });
    return { identity: macNative().stableFileIdentity(this.fd), size: value.size };
  }
  async read(offset: bigint, length: number) {
    this.check(); const buffer = Buffer.alloc(length);
    const bytes = await new Promise<number>((resolve, reject) => { read(this.fd, buffer, 0, length, position(offset), (error, bytes) => error ? reject(error) : resolve(bytes)); });
    return buffer.subarray(0, bytes);
  }
  async write(offset: bigint, data: Uint8Array) {
    this.check();
    for (let written = 0; written < data.length;) {
      const bytes = await new Promise<number>((resolve, reject) => {
        write(this.fd, data, written, data.length - written, position(offset + BigInt(written)), (error, bytes) => error ? reject(error) : resolve(bytes));
      });
      if (!bytes) throw Error("zero-byte-write");
      written += bytes;
    }
  }
  async truncate(size: bigint) { this.check(); await new Promise<void>((resolve, reject) => ftruncate(this.fd, position(size), error => error ? reject(error) : resolve())); }
  async sync() { this.check(); await new Promise<void>((resolve, reject) => fsync(this.fd, error => error ? reject(error) : resolve())); }
  async close() { if (!this.closed) { this.closed = true; await new Promise<void>((resolve, reject) => close(this.fd, error => error ? reject(error) : resolve())); } }
}
class MacDirectory implements LocalDirectory {
  private closed = false;
  constructor(private readonly handle: object) {}
  private check() { if (this.closed) throw Error("directory-closed"); }
  async identity() { this.check(); return macNative().stableDirectoryIdentity(this.handle); }
  async freeBytes() { this.check(); return macNative().directoryFree(this.handle); }
  async child(name: string, create: boolean) { this.check(); return new MacDirectory(macNative().directoryOpen(this.handle, name, create)); }
  async file(name: string, create: boolean, readOnly = false) { this.check(); return new MacFile(macNative().leafOpen(this.handle, name, create, readOnly)); }
  async publish(sourceName: string, target: LocalDirectory, targetName: string) {
    this.check(); if (!(target instanceof MacDirectory)) throw Error("filesystem-mismatch"); target.check();
    return macNative().leafRename(this.handle, sourceName, target.handle, targetName);
  }
  async sync() { this.check(); macNative().directorySync(this.handle); }
  async close() { if (!this.closed) { this.closed = true; macNative().directoryClose(this.handle); } }
}
export const macFileSystem: LocalFileSystem = { root: async path => new MacDirectory(macNative().rootOpen(path)), close: async () => {} };
