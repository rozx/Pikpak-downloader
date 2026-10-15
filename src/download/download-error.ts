export type DownloadErrorCode = "network_failure" | "range_mismatch" | "truncated_content" | "integrity_mismatch" | "version_changed"
  | "unsupported_download_url" | "url_refresh_exhausted" | "rate_limited" | "traffic_quota";
export class DownloadError extends Error {
  constructor(readonly code: DownloadErrorCode, readonly retryAfterMs?: number) { super(code); }
}
