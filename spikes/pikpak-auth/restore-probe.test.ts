import { expect, test } from "bun:test";
import { mappedDestination, runRestoreProbe } from "./restore-probe";
import type { Transport } from "./protocol";

test("只取请求源文件的精确映射，不使用其他映射条目猜测", () => {
  expect(mappedDestination({ params: { trace_file_ids: '{"source":"copy","other":"unrelated"}' } }, "source")).toBe("copy");
  expect(mappedDestination({ params: { trace_file_ids: '{"other":"unrelated"}' } }, "source")).toBe(null);
  expect(mappedDestination({ params: { trace_file_ids: '{"other":"unrelated"}' }, file_id: "unrelated" }, "source")).toBe(null);
  expect(mappedDestination({ file_id: "unrelated" }, "source")).toBe(null);
});
test("识别任务包装，拒绝把源 ID 字符串误当成映射", () => {
  expect(mappedDestination({ task: { params: { trace_file_ids: { source: "copy" } } } }, "source")).toBe("copy");
  expect(mappedDestination({ params: { trace_file_ids: "source" } }, "source")).toBe(null);
  expect(mappedDestination({ file_id: "../unexpected" }, "source")).toBe(null);
});

const input = { accountId: "synthetic-account", accessToken: "synthetic-access", shareId: "synthetic-share", passCode: "demo",
  selected: { id: "source", parentId: "", name: "fixture.bin", size: "10", hash: "synthetic-hash", depth: 0 } };
const source = { id: "source", size: "10", hash: "synthetic-hash" };
function memoryStore() {
  let saved: string | null = null;
  return { read: async () => saved, write: async (value: string) => { saved = value; } };
}
function preceding(path: string): Response | null {
  if (path.endsWith("/about")) return Response.json({ quota: { limit: "100", usage: "0" } });
  if (path.endsWith("/share")) return Response.json({ share_status: "OK", pass_code_token: "synthetic-grant" });
  if (path.endsWith("/file_info")) return Response.json({ file_info: source });
  return null;
}

test("提交响应丢失后保持意图，重新运行不能重复提交", async () => {
  const storage = memoryStore();
  let submissions = 0;
  let calls = 0;
  const http: Transport = async (address) => {
    calls++;
    const path = new URL(address).pathname;
    const earlier = preceding(path);
    if (earlier) return earlier;
    if (path.endsWith("/share/restore")) { submissions++; throw new Error("synthetic response lost after acceptance"); }
    throw new Error("unexpected request");
  };
  await expect(runRestoreProbe(input, storage, http)).rejects.toThrow("network-error");
  expect(JSON.parse((await storage.read())!).stage).toBe("intent");
  const before = calls;
  await expect(runRestoreProbe(input, storage, http)).rejects.toThrow("previous-result-needs-reconciliation");
  expect(calls).toBe(before);
  expect(submissions).toBe(1);
});

test("成功响应按源 ID 映射副本，重放只核对副本而不再次转存", async () => {
  const storage = memoryStore();
  let submissions = 0;
  const http: Transport = async (address, init) => {
    const path = new URL(address).pathname;
    const earlier = preceding(path);
    if (earlier) return earlier;
    if (path.endsWith("/share/restore")) {
      submissions++;
      const body = JSON.parse(String(init.body));
      expect(body.file_ids).toEqual(["source"]);
      return Response.json({ restore_status: "RESTORE_START", restore_task_id: "task" });
    }
    if (path.endsWith("/tasks/task")) return Response.json({ phase: "PHASE_TYPE_COMPLETE", params: { trace_file_ids: { source: "copy" } } });
    if (path.endsWith("/files/copy")) return Response.json({ ...source, id: "copy", kind: "drive#file", phase: "PHASE_TYPE_COMPLETE" });
    throw new Error("unexpected request");
  };
  const first = await runRestoreProbe(input, storage, http);
  expect(first.destinationMetadataMatches).toBe(true);
  expect(JSON.parse((await storage.read())!).stage).toBe("confirmed");
  expect((await runRestoreProbe(input, storage, http)).destinationMetadataMatches).toBe(true);
  expect(submissions).toBe(1);
});

test("任务完成但只映射了其他文件时，不能认领那个副本", async () => {
  const storage = memoryStore();
  const http: Transport = async (address) => {
    const path = new URL(address).pathname;
    const earlier = preceding(path);
    if (earlier) return earlier;
    if (path.endsWith("/share/restore")) return Response.json({ restore_status: "RESTORE_START", restore_task_id: "task" });
    if (path.endsWith("/tasks/task")) return Response.json({ phase: "PHASE_TYPE_COMPLETE", file_id: "unrelated", params: { trace_file_ids: { other: "unrelated" } } });
    throw new Error("unrelated file must not be queried");
  };
  const result = await runRestoreProbe(input, storage, http);
  expect(result.hasDestinationMapping).toBe(false);
  expect(result.destinationMetadataMatches).toBe(false);
  expect(JSON.parse((await storage.read())!).stage).toBe("submitted");
});

test("返回结果映射发生冲突时保留核对状态，不选择其中一份", async () => {
  const storage = memoryStore();
  const http: Transport = async address => {
    const path = new URL(address).pathname;
    const earlier = preceding(path);
    if (earlier) return earlier;
    if (path.endsWith("/share/restore")) return Response.json({ restore_status: "RESTORE_START", restore_task_id: "task", params: { trace_file_ids: { source: "copy-a" } } });
    if (path.endsWith("/tasks/task")) return Response.json({ phase: "PHASE_TYPE_COMPLETE", params: { trace_file_ids: { source: "copy-b" } } });
    throw Error("conflicting destination must not be queried");
  };
  await expect(runRestoreProbe(input, storage, http)).rejects.toThrow("conflicting-destination-mapping");
  expect(JSON.parse((await storage.read())!).stage).toBe("submitted");
});
