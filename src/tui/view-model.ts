import type { FileState, Pause, PauseReason } from "../state/model";
import type { FileView, ShareView } from "../state/store";
import type { RuntimeEvent } from "../runtime/engine";
import type { Tone } from "./theme";
import { displayPath, fileName } from "./format";

export type Look = { icon: string; tone: Tone; label: string };
export type Explanation = { reason: string; advice: string };

const stateLooks: Record<FileState, Look> = {
  discovered: { icon: "·", tone: "muted", label: "排队中" }, ready: { icon: "·", tone: "muted", label: "排队中" },
  saving: { icon: "⇡", tone: "transfer", label: "转存中" }, awaiting_remote: { icon: "⇡", tone: "transfer", label: "等待转存完成" },
  downloading: { icon: "↓", tone: "active", label: "下载中" }, verifying: { icon: "⟳", tone: "active", label: "校验中" },
  publishing: { icon: "↓", tone: "active", label: "正在落盘" }, completed: { icon: "✓", tone: "done", label: "已完成" },
  waiting_space: { icon: "⌛", tone: "warning", label: "等待云端空间" }, retry_wait: { icon: "⌛", tone: "warning", label: "稍后重试" },
  failed: { icon: "✗", tone: "error", label: "失败" }, reconciling: { icon: "⟳", tone: "warning", label: "正在核对" },
  needs_attention: { icon: "✗", tone: "error", label: "需要处理" },
};
const inProgress: readonly FileState[] = ["saving", "awaiting_remote", "downloading", "verifying", "publishing"];

const reasons: Record<string, Explanation> = {
  access_required: { reason: "分享需要提取码，或提取码不正确", advice: "重新复制包含链接和提取码的完整分享文本，或按 a 粘贴。" },
  cloud_space: { reason: "云盘剩余空间不足，正在等待可回收的空间", advice: "等待已完成文件的云端副本被回收，或在 PikPak 中自行清理空间。" },
  waiting_sync: { reason: "云盘容量尚未反映刚释放的空间", advice: "稍后会自动重新检查，无需操作。" },
  copy_version_changed: { reason: "云盘中的副本已被改动，与分享中的版本不一致", advice: "按 r 重试，将重新转存分享中的文件。" },
  file_exceeds_cloud_capacity: { reason: "文件大于云盘总容量，无法经云盘中转", advice: "扩容云盘后按 r 重试，或取消该文件。" },
  integrity_mismatch: { reason: "下载内容校验不一致", advice: "按 r 重试，将从头重新下载。" },
  interrupted: { reason: "操作被中断", advice: "按 r 重试。" },
  invalid_metadata: { reason: "分享返回的文件信息不完整", advice: "稍后按 r 重试；分享可能已被修改。" },
  invalid_name: { reason: "分享中的文件名无法识别", advice: "该条目已跳过，可在 PikPak 中手动处理。" },
  local_operation_failed: { reason: "本地文件操作失败", advice: "检查下载目录的权限和磁盘状态后按 r 重试。" },
  needs_reconciliation: { reason: "云端或本地操作结果未知，需要核对", advice: "重启程序会自动核对；仍无法确认时按 r 重试或取消。" },
  network_failure: { reason: "网络连接中断", advice: "检查网络或代理后按 r 重试；断点已保存。" },
  pagination_loop: { reason: "分享目录分页异常，扫描已停止", advice: "稍后按 r 重试。" },
  range_mismatch: { reason: "服务器返回的数据范围不正确", advice: "按 r 重试。" },
  rate_limited: { reason: "请求过于频繁，PikPak 暂时限流", advice: "稍后会自动重试，无需操作。" },
  remote_copy_missing: { reason: "云盘中的副本已不存在", advice: "按 r 重试，将重新转存。" },
  remote_request_failed: { reason: "PikPak 请求失败", advice: "稍后按 r 重试。" },
  scan_retry_exhausted: { reason: "扫描多次失败", advice: "检查网络后按 r 重试。" },
  share_unavailable: { reason: "分享已失效或无法访问", advice: "确认分享链接仍然有效。" },
  traffic_quota: { reason: "PikPak 下载流量额度已用完", advice: "额度恢复后会自动继续。" },
  truncated_content: { reason: "下载内容不完整", advice: "按 r 重试；断点已保存。" },
  unsupported_download_url: { reason: "下载地址不受支持", advice: "按 r 重试；仍失败时请反馈问题。" },
  unsupported_entry: { reason: "分享中包含不支持的条目", advice: "该条目已跳过。" },
  unverifiable_entries: { reason: "部分条目无法校验版本，已跳过", advice: "其他文件照常下载。" },
  unverifiable_version: { reason: "文件缺少可校验的版本信息", advice: "该文件已跳过。" },
  url_refresh_exhausted: { reason: "下载地址多次刷新后仍被拒绝", advice: "检查网络或代理后按 r 重试；断点已保存。" },
  version_changed: { reason: "分享中的文件版本已变化", advice: "已安排重新扫描，新版本会作为新的文件下载。" },
  credentials_unavailable: { reason: "系统凭据存储不可用", advice: "检查系统凭据管理器后重启程序。" },
  output_unavailable: { reason: "下载目录不可用或不可写", advice: "在设置中选择一个可写的目录。" },
  account_mismatch: { reason: "当前账号与任务所属账号不一致", advice: "使用原账号重新登录。" },
  authorization_failed: { reason: "登录已失效", advice: "重新启动程序并完成浏览器登录。" },
  invalid_input: { reason: "输入无效", advice: "检查输入后重试。" },
  invalid_transition: { reason: "任务当前状态不允许此操作", advice: "等待当前操作完成后再试。" },
  state_unavailable: { reason: "任务库不可用", advice: "检查状态目录的权限和磁盘空间后重启程序。" },
  stopped: { reason: "程序正在停止", advice: "重新启动后再操作。" },
  operation_failed: { reason: "操作失败", advice: "按 r 重试。" },
};
const aliases: Record<string, string> = { share_access_required: "access_required", waiting_space: "cloud_space",
  operation_needs_reconciliation: "needs_reconciliation", login_required: "authorization_failed", database: "state_unavailable", credentials: "credentials_unavailable" };
export const knownReasons: readonly string[] = [...Object.keys(reasons), ...Object.keys(aliases)];

export function explain(reason: string | null): Explanation {
  if (!reason) return { reason: "", advice: "" };
  return reasons[aliases[reason] ?? reason] ?? { reason: `未知原因（${reason}）`, advice: "按 r 重试；仍失败时可以取消该任务。" };
}
const pauses: Record<PauseReason, Explanation> = {
  authentication: { reason: "登录已失效，执行已暂停", advice: "重新启动程序并完成浏览器登录。" },
  permission: { reason: "PikPak 拒绝了操作权限", advice: "检查已连接应用的授权后重新登录。" },
  local_space: { reason: "本地磁盘空间不足", advice: "清理下载目录所在磁盘后会自动继续。" },
  target_unavailable: { reason: "下载目录不可用", advice: "确认磁盘已连接且目录可写，或取消受影响的任务。" },
  database: { reason: "任务库写入失败", advice: "检查状态目录的权限和磁盘空间后重启程序。" },
  traffic_quota: { reason: "PikPak 下载流量额度已用完", advice: "额度恢复后会自动继续。" },
};
export const pauseExplanation = (pause: Pause): Explanation => pauses[pause.reason];

// 完成优先于取消，取消优先于暂停；失败与等待附带原因。
export function fileLook(file: FileView, options: { userPaused: boolean }): Look {
  if (file.state === "completed") return stateLooks.completed;
  if (file.cancelled) return { icon: "⊘", tone: "muted", label: "已取消" };
  if (options.userPaused && inProgress.includes(file.state)) return { icon: "⏸", tone: "warning", label: "已暂停" };
  const look = stateLooks[file.state];
  if (file.lastError && ["failed", "needs_attention", "retry_wait"].includes(file.state)) return { ...look, label: `${look.label} · ${explain(file.lastError).reason}` };
  return look;
}

export type ShareCounts = { total: number; completed: number; downloading: number; transferring: number; queued: number; paused: number; failed: number; waiting: number; cancelled: number };
export function shareCounts(files: FileView[], userPaused: boolean): ShareCounts {
  const counts: ShareCounts = { total: files.length, completed: 0, downloading: 0, transferring: 0, queued: 0, paused: 0, failed: 0, waiting: 0, cancelled: 0 };
  for (const file of files) {
    if (file.state === "completed") counts.completed++;
    else if (file.cancelled) counts.cancelled++;
    else if (inProgress.includes(file.state)) {
      if (userPaused) counts.paused++;
      else if (file.state === "saving" || file.state === "awaiting_remote") counts.transferring++;
      else counts.downloading++;
    } else if (file.state === "discovered" || file.state === "ready") counts.queued++;
    else if (file.state === "failed" || file.state === "needs_attention") counts.failed++;
    else counts.waiting++;
  }
  return counts;
}

export type Row = { kind: "share"; key: string; share: ShareView; counts: ShareCounts; expanded: boolean }
  | { kind: "file"; key: string; shareId: string; file: FileView; name: string; path: string; look: Look };
// 未完成的分享默认展开，全部完成的默认折叠；用户的折叠选择优先。
export function buildRows(input: { shares: ShareView[]; files: Record<string, FileView[]>; expanded: Record<string, boolean | undefined>; userPaused: boolean }): Row[] {
  const rows: Row[] = [];
  for (const share of input.shares) {
    const files = input.files[share.id] ?? [];
    const expanded = input.expanded[share.id] ?? share.summary.status !== "completed";
    rows.push({ kind: "share", key: `s:${share.id}`, share, counts: shareCounts(files, input.userPaused), expanded });
    if (expanded) for (const file of files) {
      rows.push({ kind: "file", key: `f:${file.id}`, shareId: share.id, file, name: fileName(file.relativePath), path: displayPath(file.relativePath),
        look: fileLook(file, { userPaused: input.userPaused }) });
    }
  }
  return rows;
}

// 选中行离开可见区时才滚动，偏移限制在有效范围内。
export function scrollOffset(previous: number, selected: number, height: number, total: number): number {
  if (height <= 0) return 0;
  const max = Math.max(0, total - height);
  let offset = Math.min(Math.max(previous, 0), max);
  if (selected < offset) offset = selected;
  else if (selected >= offset + height) offset = selected - height + 1;
  return Math.min(Math.max(offset, 0), max);
}

export type LogLine = { icon: string; tone: Tone; text: string };
export type NameLookup = { share(id: string): string | null; file(id: string): string | null };
// 事件区显示名称而非内部 ID；查不到名称时退回 ID。进度事件只更新列表，不进入事件区。
export function describeEvent(event: RuntimeEvent, names: NameLookup): LogLine | null {
  const share = (id?: string) => `「${(id && names.share(id)) ?? id ?? ""}」`;
  const file = (id?: string) => (id && names.file(id)) ?? id ?? "";
  const target = (id?: string) => id?.startsWith("s_") ? `分享${share(id)}` : file(id);
  switch (event.type) {
    case "started": return { icon: "●", tone: "done", text: event.reason === "clipboard_off" ? "执行已启动，剪贴板监听已关闭" : "监听已启动" };
    case "stopped": return { icon: "●", tone: "muted", text: "已停止" };
    case "received": return { icon: "+", tone: "active", text: `已接收分享${share(event.id)}` };
    case "received_cancelled": return { icon: "⊘", tone: "muted", text: `分享${share(event.id)}已取消，按 r 恢复` };
    case "intake_issues": return { icon: "!", tone: "warning", text: "部分分享文本格式不支持或配对不明确，请分别复制完整文本" };
    case "intake_failed": return { icon: "✗", tone: "error", text: "部分输入未确认接收，请重新复制" };
    case "clipboard_unavailable": return { icon: "⌛", tone: "warning", text: "剪贴板暂时不可读，正在重试" };
    case "clipboard_recovered": return { icon: "●", tone: "done", text: "剪贴板监听已恢复" };
    case "scanning": return { icon: "⟳", tone: "scan", text: `正在扫描${share(event.id)}` };
    case "scanned": return { icon: "⟳", tone: "scan", text: `${share(event.id)}扫描完成：${event.count ?? 0} 个文件` };
    case "scan_incomplete": return { icon: "!", tone: "warning", text: `${share(event.id)}扫描未完整完成` };
    case "scan_waiting": return { icon: "⌛", tone: "warning", text: `${share(event.id)}扫描等待：${explain(event.reason ?? null).reason}` };
    case "saving": return { icon: "⇡", tone: "transfer", text: `正在转存 ${file(event.id)}` };
    case "downloading": return { icon: "↓", tone: "active", text: `开始下载 ${file(event.id)}` };
    case "completed": return { icon: "✓", tone: "done", text: `${file(event.id)} 校验通过，已完成` };
    case "waiting_space": return { icon: "⌛", tone: "warning", text: `${file(event.id)} 等待云端空间` };
    case "paused": return { icon: "⏸", tone: "warning", text: `执行已暂停：${pauses[event.reason as PauseReason]?.reason ?? explain(event.reason ?? null).reason}` };
    case "attention": return { icon: "✗", tone: "error", text: `${file(event.id)} 需要核对：${explain(event.reason ?? null).reason}` };
    case "file_waiting": return { icon: "!", tone: "warning", text: `${file(event.id)}：${explain(event.reason ?? null).reason}` };
    case "command": {
      const kind = event.reason;
      if (kind === "retry") return { icon: "↻", tone: "active", text: `已安排重试 ${target(event.id)}` };
      if (kind === "cancel") return { icon: "⊘", tone: "muted", text: `已取消 ${target(event.id)}` };
      if (kind === "pauseQueue") return { icon: "⏸", tone: "warning", text: "队列已暂停" };
      if (kind === "resumeQueue") return { icon: "▶", tone: "active", text: "队列已继续" };
      if (kind === "setOutputRoot") return { icon: "●", tone: "done", text: "下载目录已更新，只影响之后接收的分享" };
      if (kind === "setClipboardWatch") return { icon: "●", tone: "done", text: "剪贴板监听设置已更新" };
      return null;
    }
    case "command_failed": return { icon: "✗", tone: "error", text: `操作失败：${explain(event.reason ?? null).reason}` };
    default: return null;
  }
}
