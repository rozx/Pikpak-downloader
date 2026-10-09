import { createHash } from "node:crypto";
import { ProbeError } from "./protocol";

// 算法核对来源：rclone/backend/pikpak/helper.go 的 calcGcid。
export function gcidBlockSize(size: bigint): number {
  if (size < 0n) throw new ProbeError("integrity", "invalid-size");
  let block = 256 * 1024;
  while (block < 2 * 1024 * 1024 && size > BigInt(block) * 512n) block *= 2;
  return block;
}

export class ContentHasher {
  readonly blockSize: number;
  private blockHash = createHash("sha1");
  private readonly aggregate = createHash("sha1");
  private readonly localHash = createHash("sha256");
  private blockBytes = 0;
  private received = 0n;
  private finalized = false;

  constructor(readonly size: bigint) { this.blockSize = gcidBlockSize(size); }

  update(chunk: Uint8Array): void {
    if (this.finalized) throw new ProbeError("integrity", "already-finalized");
    if (this.received + BigInt(chunk.byteLength) > this.size) throw new ProbeError("integrity", "excess-content");
    this.localHash.update(chunk);
    this.received += BigInt(chunk.byteLength);
    for (let offset = 0; offset < chunk.byteLength;) {
      const length = Math.min(this.blockSize - this.blockBytes, chunk.byteLength - offset);
      this.blockHash.update(chunk.subarray(offset, offset + length));
      this.blockBytes += length;
      offset += length;
      if (this.blockBytes === this.blockSize) this.flushBlock();
    }
  }

  private flushBlock(): void {
    this.aggregate.update(this.blockHash.digest());
    this.blockHash = createHash("sha1");
    this.blockBytes = 0;
  }

  digest(): { gcid: string; sha256: string } {
    if (this.finalized) throw new ProbeError("integrity", "already-finalized");
    if (this.received !== this.size) throw new ProbeError("integrity", "truncated-content");
    if (this.blockBytes > 0) this.flushBlock();
    this.finalized = true;
    return { gcid: this.aggregate.digest("hex"), sha256: this.localHash.digest("hex") };
  }
}
