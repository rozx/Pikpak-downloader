import { expect, test } from "bun:test";
import { creationEvidence, timestamp, unchangedOwnedCopy } from "../src/pikpak/ownership";

const intent = { taskId: "task", shareId: "share", sourceId: "source", size: 1n, gcid: "a".repeat(40), notBefore: "2026-10-08T10:00:00Z" };
const task = { id: "task", type: "restore", phase: "PHASE_TYPE_COMPLETE", created_time: "2026-10-08T10:00:00.000000001Z", params: { trace_file_ids: { source: "copy" } } };
const file = { id: "copy", kind: "drive#file", phase: "PHASE_TYPE_COMPLETE", parent_id: "parent", name: "file.bin", size: "1",
  hash: intent.gcid, created_time: "2026-10-08T10:00:00.000000002Z", params: { original_file_id: "source", original_share_id: "share" } };
test("仅接受同时满足精确任务映射、来源、版本和新建时序的结果", () => {
  expect(creationEvidence(intent, task, file)?.copyId).toBe("copy");
  expect(timestamp(file.created_time)! - timestamp(task.created_time)!).toBe(1n);
  expect(timestamp("2026-10-08T18:00:00.000000002+08:00")).toBe(timestamp(file.created_time));
  expect(creationEvidence(intent, { ...task, created_time: "2026-10-08T18:00:00.000000001+08:00" },
    { ...file, created_time: "2026-10-08T18:00:00.000000002+08:00" })?.copyId).toBe("copy");
  for (const changed of [
    { ...file, created_time: "2026-10-08T09:00:00Z" }, { ...file, created_time: task.created_time },
    { ...file, created_time: "2026-02-30T10:00:00Z" }, { ...file, params: {} },
    { ...file, params: { original_file_id: "other", original_share_id: "share" } },
    { ...file, hash: "b".repeat(40) }, { ...file, id: "another-same-named-file" },
  ]) expect(creationEvidence(intent, task, changed)).toBe(null);
  expect(creationEvidence(intent, { ...task, id: "another-task" }, file)).toBe(null);
  expect(creationEvidence(intent, { ...task, params: {}, file_id: "copy" }, file)).toBe(null);
  expect(creationEvidence({ ...intent, notBefore: "2026-10-08T11:00:00Z" }, task, file)).toBe(null);
});
test("清理复核拒绝改名、移动、内容替换或来源改变", () => {
  const proof = creationEvidence(intent, task, file)!;
  expect(unchangedOwnedCopy(proof, file)).toBe(true);
  for (const changed of [{ ...file, name: "user-renamed" }, { ...file, parent_id: "elsewhere" },
    { ...file, hash: "b".repeat(40) }, { ...file, params: {} }, { ...file, trashed: true }]) expect(unchangedOwnedCopy(proof, changed)).toBe(false);
});
