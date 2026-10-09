import { AppError } from "../errors";

export const fileStates = ["discovered", "ready", "saving", "awaiting_remote", "downloading", "verifying", "publishing", "completed",
  "waiting_space", "retry_wait", "failed", "reconciling", "needs_attention"] as const;
export type FileState = typeof fileStates[number];
export type PauseReason = "authentication" | "permission" | "local_space" | "target_unavailable" | "database" | "traffic_quota";
export type Pause = { reason: PauseReason; fileId: string | null };
export type Counts = { total: number; completed: number; cancelled: number; failed: number; waiting: number; active: number };
const edges: Record<FileState, readonly FileState[]> = {
  discovered: ["ready", "failed", "needs_attention"],
  ready: ["saving", "downloading", "waiting_space", "retry_wait", "failed", "needs_attention"],
  saving: ["awaiting_remote", "reconciling"],
  awaiting_remote: ["downloading", "retry_wait", "reconciling", "failed"],
  downloading: ["verifying", "retry_wait", "failed", "needs_attention"],
  verifying: ["downloading", "publishing", "retry_wait", "failed", "needs_attention"],
  publishing: ["completed", "reconciling", "needs_attention"],
  completed: [],
  waiting_space: ["ready", "failed"],
  retry_wait: ["ready", "downloading", "failed"],
  failed: ["ready"],
  reconciling: ["awaiting_remote", "downloading", "completed", "needs_attention"],
  needs_attention: ["ready", "reconciling"],
};

export function assertTransition(from: FileState, to: FileState): void {
  if (!edges[from].includes(to)) throw new AppError("invalid_transition");
}

export function aggregate(files: ReadonlyArray<{ state: FileState; cancelled: boolean }>, scan: "pending" | "active" | "complete" | "failed", cancelled = false) {
  const counts = { total: files.length, completed: 0, cancelled: 0, failed: 0, waiting: 0, active: 0 };
  for (const file of files) {
    if (file.state === "completed") counts.completed++;
    else if (cancelled || file.cancelled) counts.cancelled++;
    else if (["failed", "needs_attention"].includes(file.state)) counts.failed++;
    else if (["waiting_space", "retry_wait", "reconciling"].includes(file.state)) counts.waiting++;
    else counts.active++;
  }
  return aggregateCounts(counts, scan, cancelled);
}
export function aggregateCounts(counts: Counts, scan: "pending" | "active" | "complete" | "failed", cancelled = false) {
  const status = cancelled ? "cancelled" : scan !== "complete" ? (scan === "failed" ? "scan_incomplete" : "scanning")
    : counts.completed === counts.total ? (counts.total ? "completed" : "empty")
    : counts.completed > 0 ? "partial" : counts.active > 0 ? "active" : counts.failed > 0 ? "failed"
    : counts.waiting > 0 ? "waiting" : "cancelled";
  return { status, ...counts };
}

export function canResume(pause: Pause, conditions: {
  authenticated: boolean; permitted: boolean; writable: boolean; hasSpace: boolean; targetAvailable: boolean; trafficAvailable: boolean;
}): boolean {
  return ({ authentication: conditions.authenticated, permission: conditions.permitted, database: conditions.writable,
    local_space: conditions.hasSpace, target_unavailable: conditions.targetAvailable, traffic_quota: conditions.trafficAvailable })[pause.reason];
}
