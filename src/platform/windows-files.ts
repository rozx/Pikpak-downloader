/// <reference path="./assets.d.ts" />
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
class WindowsFile implements LocalFile {
  constructor(private readonly bridge: ProcessBridge, private readonly id: string) {}
  async info() { return info(await this.bridge.call({ action: "info", id: this.id })); }
  async read(position: bigint, length: number) {
    const encoded = await this.bridge.call({ action: "read", id: this.id, offset: position.toString(), length: Math.min(length, READ_BLOCK) });
    if (typeof encoded !== "string") throw Error("invalid-native-read"); return Buffer.from(encoded, "base64");
  }
  async write(position: bigint, data: Uint8Array) {
    for (let offset = 0; offset < data.byteLength; offset += 65536) await this.bridge.call({ action: "write", id: this.id,
      offset: (position + BigInt(offset)).toString(), data: Buffer.from(data.subarray(offset, offset + 65536)).toString("base64") });
  }
  async truncate(size: bigint) { await this.bridge.call({ action: "truncate", id: this.id, size: size.toString() }); }
  async sync() { await this.bridge.call({ action: "sync", id: this.id }); }
  async close() { await this.bridge.call({ action: "close", id: this.id }); }
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
    return new WindowsFile(this.bridge, handle(await this.bridge.call({ action: "child", parent: this.id, name, directory: false, create, readOnly })));
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
