import type { RemoteFile } from "../pikpak/drive";
import { originalLink, secureDownloadUrl } from "./original-link";
import { DownloadError } from "./download-error";

// 共享地址租约（add-parallel-segment-download 决策 6）：所有连接共用同一份已核对版本的地址。
// 签名地址只保存在内存里，不写入任务库、事件或日志。
export type Lease = { readonly generation: number; readonly url: string };

export class UrlLease {
  private current: (Lease & { at: number }) | null = null;
  private refreshing: Promise<Lease> | null = null;
  private forced = 0;
  // check() 取元数据并核对副本 ID、大小与 GCID，版本变化时抛出；maxForced 是自上次成功响应以来因 401/403 刷新的上限。
  constructor(private readonly check: () => Promise<RemoteFile>, private readonly now: () => number = Date.now,
    readonly maxAgeMs = 30_000, readonly maxForced = 2) {}

  // 新请求开始前取租约；超过最长有效期时单飞刷新，其他连接等待同一个结果。
  async get(): Promise<Lease> {
    if (this.refreshing) return this.refreshing;
    if (this.current && this.now() - this.current.at < this.maxAgeMs) return this.current;
    return this.refresh();
  }
  // 请求收到 401/403：若仍是这一代就刷新到下一代，已被其他连接刷新过就直接用新租约。
  async invalidate(generation: number): Promise<Lease> {
    if (this.refreshing) return this.refreshing;
    if (this.current && this.current.generation !== generation) return this.current;
    if (++this.forced > this.maxForced) throw new DownloadError("url_refresh_exhausted");
    return this.refresh();
  }
  // 任意请求得到正确的部分内容后，刷新预算清零。
  succeeded(): void { this.forced = 0; }

  private refresh(): Promise<Lease> {
    const generation = (this.current?.generation ?? 0) + 1;
    this.refreshing = (async () => {
      const remote = await this.check();
      const link = originalLink(remote.raw), endpoint = link && secureDownloadUrl(link.url);
      if (!endpoint) throw new DownloadError("unsupported_download_url");
      this.current = { generation, url: endpoint.url.href, at: this.now() };
      return this.current;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
}
