export type ErrorCode = "invalid_input" | "state_unavailable" | "newer_schema" | "backup_review_required"
  | "instance_busy" | "unsupported_platform" | "account_mismatch" | "credentials_unavailable"
  | "not_implemented" | "invalid_transition" | "needs_reconciliation" | "login_required" | "authorization_failed" | "share_access_required" | "output_required" | "output_unavailable";

const messages: Record<ErrorCode, string> = {
  invalid_input: "输入无效，请查看 --help。",
  state_unavailable: "任务库不可用；请检查状态目录权限与磁盘空间。",
  newer_schema: "任务库由更新版本创建；请升级程序，不要用旧版本写入。",
  backup_review_required: "这是任务库备份，需要先核对外部操作与交付结果，不能直接恢复执行。",
  instance_busy: "已有实例占用任务库。请先停止 watch，再执行修改命令。",
  unsupported_platform: "当前平台尚无经过验证的运行适配。",
  account_mismatch: "当前账号与任务所属账号不匹配，请登录匹配账号。",
  credentials_unavailable: "系统凭据存储不可用；不会改用明文保存。",
  not_implemented: "此开发版本尚未接入该命令。",
  invalid_transition: "任务状态不允许执行此操作。",
  needs_reconciliation: "外部操作结果仍待核对，不能重复提交。",
  login_required: "请先执行 login 登录；已有任务与下载进度会保留。",
  authorization_failed: "授权或会话刷新失败，请停止 watch 后重新执行 login。",
  share_access_required: "该任务的访问资料不可读，请重新复制含链接和提取码的完整文本。",
  output_required: "缺少下载目录。请使用 watch --output <目录> 或 config --output <目录>。",
  output_unavailable: "下载目录不可用或不支持安全文件操作，请检查目录、权限与磁盘挂载后重试。",
};

export class AppError extends Error {
  constructor(readonly code: ErrorCode) { super(messages[code]); this.name = "AppError"; }
}

export function publicError(error: unknown): string {
  return error instanceof AppError ? error.message : "操作失败；未输出可能包含私密资料的底层错误。";
}
