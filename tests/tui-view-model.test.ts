import { expect, test } from "bun:test";
import { fileStates, type FileState } from "../src/state/model";
import type { FileView, ShareView } from "../src/state/store";
import { buildRows, describeEvent, explain, fileLocation, fileLook, knownReasons, pauseExplanation, scrollOffset, shareCounts } from "../src/tui/view-model";

const summary = (status: string, total: number, completed: number) => ({ status, total, completed, cancelled: 0, failed: 0, waiting: 0, active: total - completed, reason: null });
const share = (id: string, status: string, total: number, completed: number): ShareView =>
  ({ id, title: `分享${id}`, outputRoot: "/out", scanStatus: "complete", cancelled: false, lastError: null, summary: summary(status, total, completed), paused: false });
const file = (id: string, state: FileState, extra: Partial<FileView> = {}): FileView =>
  ({ id, shareId: "s_1", relativePath: JSON.stringify([{ id, name: "季" }, { id, name: `${id}.mkv` }]), size: 100n, state, retries: 0n, cancelled: false,
    lastError: null, checkpoint: 0n, copyState: null, paused: false, ...extra });

test("每种文件状态都有图标、色调与说明；取消、暂停与完成优先级正确", () => {
  for (const state of fileStates) {
    const look = fileLook(file("f", state), { userPaused: false });
    expect(look.icon.length).toBeGreaterThan(0); expect(look.label.length).toBeGreaterThan(0);
  }
  expect(fileLook(file("f", "completed", { cancelled: true }), { userPaused: true })).toMatchObject({ icon: "✓", tone: "done" });
  expect(fileLook(file("f", "ready", { cancelled: true }), { userPaused: false })).toMatchObject({ icon: "⊘", label: "已取消" });
  expect(fileLook(file("f", "downloading"), { userPaused: true })).toMatchObject({ icon: "⏸", tone: "warning", label: "已暂停" });
  expect(fileLook(file("f", "ready"), { userPaused: true })).toMatchObject({ icon: "·", label: "排队中" });
  expect(fileLook(file("f", "failed", { lastError: "url_refresh_exhausted" }), { userPaused: false })).toMatchObject({ icon: "✗", tone: "error" });
  expect(fileLook(file("f", "failed", { lastError: "url_refresh_exhausted" }), { userPaused: false }).label).toContain("下载地址");
  expect(fileLook(file("f", "waiting_space"), { userPaused: false })).toMatchObject({ icon: "⌛", tone: "warning", label: "等待云端空间" });
});

test("所有已知原因码与暂停原因都有专门的中文说明和建议", () => {
  for (const reason of knownReasons) {
    const explanation = explain(reason);
    expect(explanation.reason).not.toContain(reason); expect(explanation.advice.length).toBeGreaterThan(0);
  }
  expect(explain("something_new")).toEqual({ reason: "未知原因（something_new）", advice: "按 r 重试；仍失败时可以取消该任务。" });
  expect(explain(null).reason).toBe("");
  for (const reason of ["authentication", "permission", "local_space", "target_unavailable", "database", "traffic_quota"] as const) {
    const explanation = pauseExplanation({ reason, fileId: null });
    expect(explanation.reason.length).toBeGreaterThan(0); expect(explanation.advice.length).toBeGreaterThan(0);
  }
});

test("分组行：未完成展开、已完成折叠，用户折叠优先，计数区分各状态", () => {
  const shares = [share("s_1", "partial", 3, 1), share("s_2", "completed", 2, 2), share("s_3", "scanning", 0, 0)];
  const files = { s_1: [file("a", "completed"), file("b", "downloading"), file("c", "ready")], s_2: [file("d", "completed"), file("e", "completed")], s_3: [] };
  const rows = buildRows({ shares, files, expanded: {}, userPaused: false });
  expect(rows.map(row => row.kind === "share" ? `S:${row.share.id}:${row.expanded}` : `F:${row.file.id}`))
    .toEqual(["S:s_1:true", "F:a", "F:b", "F:c", "S:s_2:false", "S:s_3:true"]);
  const fileRow = rows[1]!; expect(fileRow.kind === "file" && fileRow.name).toBe("a.mkv"); expect(fileRow.kind === "file" && fileRow.path).toBe("季/a.mkv");
  const folded = buildRows({ shares, files, expanded: { s_1: false, s_2: true }, userPaused: false });
  expect(folded.map(row => row.kind === "share" ? `S:${row.share.id}` : `F:${row.file.id}`)).toEqual(["S:s_1", "S:s_2", "F:d", "F:e", "S:s_3"]);
  expect(shareCounts(files.s_1, false)).toMatchObject({ total: 3, completed: 1, downloading: 1, queued: 1, paused: 0 });
  expect(shareCounts(files.s_1, true)).toMatchObject({ downloading: 0, paused: 1, queued: 1 });
  expect(shareCounts([file("x", "failed"), file("y", "waiting_space"), file("z", "ready", { cancelled: true }), file("w", "saving")], false))
    .toMatchObject({ failed: 1, waiting: 1, cancelled: 1, transferring: 1 });
});

test("滚动只在选中行离开可见区时移动，并随窗口高度和总数收敛", () => {
  expect(scrollOffset(0, 3, 5, 20)).toBe(0);
  expect(scrollOffset(0, 5, 5, 20)).toBe(1);
  expect(scrollOffset(10, 4, 5, 20)).toBe(4);
  expect(scrollOffset(15, 19, 10, 20)).toBe(10);
  expect(scrollOffset(8, 2, 10, 5)).toBe(0);
  expect(scrollOffset(3, 0, 0, 5)).toBe(0);
});

test("事件区描述使用名称而非内部 ID，进度事件不进入事件区", () => {
  const names = { share: (id: string) => id === "s_1" ? "某某合集" : null, file: (id: string) => id === "f_1" ? "episode01.mkv" : null };
  expect(describeEvent({ type: "completed", id: "f_1" }, names)).toEqual({ icon: "✓", tone: "done", text: "episode01.mkv 校验通过，已完成" });
  expect(describeEvent({ type: "scanned", id: "s_1", count: 3 }, names)?.text).toBe("「某某合集」扫描完成：3 个文件");
  expect(describeEvent({ type: "received", id: "s_1" }, names)?.text).toBe("已接收分享「某某合集」");
  expect(describeEvent({ type: "file_waiting", id: "f_1", reason: "network_failure" }, names)?.text).toContain("episode01.mkv");
  expect(describeEvent({ type: "paused", reason: "authentication" }, names)).toMatchObject({ icon: "⏸", tone: "warning" });
  expect(describeEvent({ type: "command", reason: "pauseQueue" }, names)?.text).toBe("队列已暂停");
  expect(describeEvent({ type: "command_failed", reason: "output_unavailable" }, names)).toMatchObject({ icon: "✗", tone: "error" });
  expect(describeEvent({ type: "progress", id: "f_1", bytes: 1n, size: 2n }, names)).toBe(null);
  expect(describeEvent({ type: "completed", id: "f_unknown" }, names)?.text).toContain("f_unknown");
});

test("释放云端副本的事件描述：已释放、已不存在、未释放、被拒绝、失败与命令", () => {
  const names = { share: (id: string) => id === "s_1" ? "某某合集" : null, file: (id: string) => id === "f_1" ? "episode01.mkv" : null };
  expect(describeEvent({ type: "copy_released", id: "f_1", bytes: 412n * 1048576n }, names)).toEqual({ icon: "♻", tone: "done", text: "episode01.mkv 的云端副本已释放（412 MB）" });
  expect(describeEvent({ type: "copy_missing", id: "f_1" }, names)?.text).toBe("episode01.mkv 的云端副本已不在云盘中，记录已更新");
  expect(describeEvent({ type: "copy_release_skipped", id: "f_1", reason: "copy_changed" }, names)?.text).toBe("episode01.mkv 的云端副本未释放：云端副本已被改动，已改为受保护，不会删除");
  expect(describeEvent({ type: "copy_release_denied", id: "f_1", reason: "permission_denied" }, names)).toEqual({ icon: "✗", tone: "error",
    text: "episode01.mkv 的云端副本未能释放：PikPak 拒绝了删除请求，副本保留（permission_denied）" });
  expect(describeEvent({ type: "copy_release_denied", id: "f_1", reason: "has space" }, names)?.text).toBe("episode01.mkv 的云端副本未能释放：PikPak 拒绝了删除请求，副本保留");
  expect(describeEvent({ type: "copy_release_failed", id: "f_1", reason: "rate_limited" }, names)?.text).toBe("episode01.mkv 的云端副本释放失败：请求过于频繁，PikPak 暂时限流");
  expect(describeEvent({ type: "command", reason: "releaseCopy", id: "s_1", count: 2 }, names)?.text).toBe("正在释放 分享「某某合集」 的 2 个云端副本");
  for (const reason of ["copy_absent", "copy_in_use", "copy_not_owned", "copy_changed", "release_denied"]) expect(explain(reason).reason).not.toContain("未知原因");
});

test("任务位置：已完成看本地文件是否仍在，未完成看断点；云端看最近一份副本；分享计数", () => {
  const done = file("a", "completed"), partial = file("b", "downloading", { checkpoint: 10n, copyState: "retained" }), fresh = file("c", "ready");
  expect(fileLocation(done)).toEqual({ local: "full", cloud: false });
  expect(fileLocation(done, true)).toEqual({ local: "missing", cloud: false });
  expect(fileLocation(partial)).toEqual({ local: "partial", cloud: true });
  expect(fileLocation(fresh)).toEqual({ local: null, cloud: false });
  expect(fileLook(done, { userPaused: false, missing: true })).toEqual({ icon: "✓", tone: "warning", label: "已完成 · 本地文件已不在" });
  expect(fileLook(done, { userPaused: false })).toEqual({ icon: "✓", tone: "done", label: "已完成" });
  for (const state of ["retained", "deleting", "protected"] as const) expect(fileLocation({ ...done, copyState: state }).cloud).toBe(true);
  expect(fileLocation({ ...done, copyState: "deleted" }).cloud).toBe(false);
  expect(shareCounts([done, partial, fresh, { ...done, id: "d", copyState: "retained" }], false, false, new Set(["a"]))).toMatchObject({ cloud: 2, missing: 1 });
  const rows = buildRows({ shares: [share("s_1", "partial", 2, 1)], files: { s_1: [done, partial] }, expanded: {}, userPaused: false, missing: new Set(["a"]) });
  expect(rows.flatMap(row => row.kind === "file" ? [row.location] : [])).toEqual([{ local: "missing", cloud: false }, { local: "partial", cloud: true }]);
});

test("删除任务记录的事件描述", () => {
  const names = { share: (id: string) => id === "s_1" ? "某某合集" : null, file: (id: string) => id === "f_1" ? "episode01.mkv" : null };
  expect(describeEvent({ type: "copy_released", id: "f_1", bytes: 412n * 1048576n, reason: "removed" }, names)?.text).toBe("episode01.mkv 的云端副本已释放（412 MB），任务记录已删除");
  expect(describeEvent({ type: "copy_missing", id: "f_1", reason: "removed" }, names)?.text).toBe("episode01.mkv 的云端副本已不在云盘中，任务记录已删除");
  expect(describeEvent({ type: "task_removed", id: "f_1" }, names)?.text).toBe("episode01.mkv 的任务记录已删除，本地文件保留");
  expect(describeEvent({ type: "share_removed", id: "s_1" }, names)?.text).toBe("分享「某某合集」的任务都已删除，已从列表移除");
});
