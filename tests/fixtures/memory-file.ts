import type { LocalFile } from "../../src/platform/files";

// 内存中的本地文件：记录写入、同步与关闭，供下载协调逻辑的单元测试使用；真实文件桥由平台测试覆盖。
export class MemoryFile implements LocalFile {
  data: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  syncs = 0; closed = false;
  readonly writes: Array<{ position: bigint; length: number }> = [];
  failWrite: Error | null = null;
  async info() { return { identity: { volume: "memory", file: "file" }, size: BigInt(this.data.length) }; }
  async read(position: bigint, length: number) { return this.data.slice(Number(position), Number(position) + length); }
  async write(position: bigint, bytes: Uint8Array) {
    if (this.failWrite) throw this.failWrite;
    const end = Number(position) + bytes.byteLength;
    if (end > this.data.length) { const grown = new Uint8Array(end); grown.set(this.data); this.data = grown; }
    this.data.set(bytes, Number(position)); this.writes.push({ position, length: bytes.byteLength });
  }
  async truncate(size: bigint) { const next = new Uint8Array(Number(size)); next.set(this.data.subarray(0, Number(size))); this.data = next; }
  async sync() { this.syncs++; }
  async close() { this.closed = true; }
}
