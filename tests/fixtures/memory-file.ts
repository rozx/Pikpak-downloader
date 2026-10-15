import type { LocalFile } from "../../src/platform/files";

// 内存中的本地文件：记录写入、同步与关闭，供下载协调逻辑的单元测试使用；真实文件桥由平台测试覆盖。
// 容量按倍数增长，避免逐块写入大文件时反复整体复制。
export class MemoryFile implements LocalFile {
  private buffer = new Uint8Array(0);
  private length = 0;
  syncs = 0; closed = false;
  readonly writes: Array<{ position: bigint; length: number }> = [];
  failWrite: Error | null = null;
  get data(): Uint8Array<ArrayBuffer> { return this.buffer.subarray(0, this.length); }
  set data(value: Uint8Array<ArrayBuffer>) { this.buffer = value; this.length = value.length; }
  private reserve(size: number) {
    if (size <= this.buffer.length) return;
    const grown = new Uint8Array(Math.max(size, this.buffer.length * 2, 65536)); grown.set(this.buffer.subarray(0, this.length)); this.buffer = grown;
  }
  async info() { return { identity: { volume: "memory", file: "file" }, size: BigInt(this.length) }; }
  async read(position: bigint, length: number) { return this.data.slice(Number(position), Number(position) + length); }
  async write(position: bigint, bytes: Uint8Array) {
    if (this.failWrite) throw this.failWrite;
    const end = Number(position) + bytes.byteLength;
    this.reserve(end);
    // 在原长度之后写入时，中间空缺补零（与真实文件一致）。
    if (Number(position) > this.length) this.buffer.fill(0, this.length, Number(position));
    this.buffer.set(bytes, Number(position)); this.length = Math.max(this.length, end);
    this.writes.push({ position, length: bytes.byteLength });
  }
  async truncate(size: bigint) {
    const next = Number(size);
    if (next > this.length) { this.reserve(next); this.buffer.fill(0, this.length, next); }
    this.length = next;
  }
  async sync() { this.syncs++; }
  async close() { this.closed = true; }
}
