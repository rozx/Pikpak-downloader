type Sample = { at: number; bytes: bigint };

// 每个文件独立的滑动窗口速度；进度回退（重新下载）时清空窗口。
export class SpeedMeter {
  private readonly samples = new Map<string, Sample[]>();
  constructor(private readonly windowMs = 5000, private readonly now: () => number = Date.now) {}
  sample(id: string, bytes: bigint): void {
    let list = this.samples.get(id) ?? [];
    if (list.length && bytes < list.at(-1)!.bytes) list = [];
    list.push({ at: this.now(), bytes });
    while (list.length > 1 && this.now() - list[0]!.at > this.windowMs) list.shift();
    this.samples.set(id, list);
  }
  private span(id: string): { ms: number; bytes: bigint } | null {
    const list = this.samples.get(id);
    if (!list || list.length < 2) return null;
    return { ms: list.at(-1)!.at - list[0]!.at, bytes: list.at(-1)!.bytes - list[0]!.bytes };
  }
  // 字节/秒；样本跨度不足 1 秒时不报告。
  rate(id: string): number | null {
    const span = this.span(id);
    return span && span.ms >= 1000 ? Number(span.bytes) / span.ms * 1000 : null;
  }
  // 剩余秒数；样本不足 2 秒或速度低于 1 KiB/s 时不报告。
  eta(id: string, size: bigint): number | null {
    const span = this.span(id), rate = this.rate(id), latest = this.samples.get(id)?.at(-1);
    if (!span || span.ms < 2000 || rate === null || rate < 1024 || !latest) return null;
    return Math.max(0, Number(size - latest.bytes) / rate);
  }
  forget(id: string): void { this.samples.delete(id); }
}
