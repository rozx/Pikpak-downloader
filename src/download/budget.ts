// 跨文件连接预算（add-concurrent-file-downloads 决策 4）：所有在途文件合计最多 8 个 CDN 连接，
// 每个文件的份额为 max(1, ⌊8 / 在途文件数⌋)。份额变小时只停止补充新连接，不中断已有连接。
export const TOTAL_CONNECTIONS = 8;
export class ConnectionBudget {
  private readonly files = new Set<string>();
  constructor(readonly total = TOTAL_CONNECTIONS) {}
  register(id: string): void { this.files.add(id); }
  release(id: string): void { this.files.delete(id); }
  get active(): number { return this.files.size; }
  share(): number { return Math.max(1, Math.floor(this.total / Math.max(1, this.files.size))); }
}
