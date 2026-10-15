import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/state/store";
import { acceptShare } from "../../src/auth/share-access";
import { ContentHasher } from "../../src/download/gcid";
import { Drive } from "../../src/pikpak/drive";
import { requestJson, type Transport } from "../../src/pikpak/protocol";
import type { PikpakClient } from "../../src/pikpak/client";
import { Engine } from "../../src/runtime/engine";
import type { LocalFileSystem } from "../../src/platform/files";

// 引擎与运行时会话测试共用的假 PikPak 服务：分享两层目录、按容量拒绝转存、记录删除与转存次数。
export async function engineFixture(files: LocalFileSystem, count = 2, sizes?: number[]) {
  const root = await mkdtemp(join(tmpdir(), "pikpak-engine-test-")); const store = new Store(join(root, "db.sqlite"));
  const values = new Map<string, string>(); const secrets = { get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => { values.set(key, value); }, delete: async (key: string) => { values.delete(key); } };
  store.ensureAccount("account"); const { share } = await acceptShare(store, secrets, { accountId: "account", shareId: "share", passCode: "demo", outputRoot: root });
  const sources = Array.from({ length: count }, (_, index) => {
    const bytes = Buffer.alloc(sizes?.[index] ?? 40, index); const hash = new ContentHasher(BigInt(bytes.length)); hash.update(bytes);
    return { id: `source-${index}`, name: "file.bin", kind: "drive#file", phase: "PHASE_TYPE_COMPLETE", size: String(bytes.length), hash: hash.digest().gcid, bytes };
  });
  const state = { saves: 0, usage: 10n, limit: 60n, expired: false, deleted: [] as string[], deleteRequests: [] as number[], cloud: new Map<string, Record<string, unknown>>(), tasks: new Map<string, Record<string, unknown>>(), sourceReads: 0 };
  const json = (value: unknown) => Response.json(value, { headers: { date: "Thu, 08 Oct 2026 10:00:00 GMT" } });
  const http: Transport = async (input, init) => {
    const url = new URL(input), path = url.pathname;
    if (path.endsWith("/about")) return json({ quota: { limit: state.limit.toString(), usage: state.usage.toString() } });
    if (path.endsWith("/share")) { state.sourceReads++; return json({ share_status: state.expired ? "UNAVAILABLE" : "OK", title: "synthetic-share", pass_code_token: "synthetic-grant" }); }
    if (path.endsWith("/share/detail")) return json({ share_status: "OK", files: url.searchParams.get("parent_id")
      ? sources.slice(1).map(({ bytes, ...file }) => file) : [{ ...sources[0]!, bytes: undefined }, ...(count > 1 ? [{ id: "folder", name: "folder", kind: "drive#folder" }] : [])] });
    if (path.endsWith("/file_info")) {
      const source = sources.find(item => item.id === url.searchParams.get("file_id"))!;
      return json({ file_info: { ...source, bytes: undefined } });
    }
    if (path.endsWith("/share/restore")) {
      const body = JSON.parse(String(init.body)); expect(body.file_ids).toHaveLength(1);
      const source = sources.find(item => item.id === body.file_ids[0])!;
      if (state.limit - state.usage < BigInt(source.size)) return Response.json({ error: "file_space_not_enough" }, { status: 400 });
      const index = ++state.saves; const id = `copy-${index}`, task = `task-${index}`; state.usage += BigInt(source.size);
      state.cloud.set(id, { ...source, bytes: undefined, id, parent_id: "owned-parent", created_time: "2026-10-08T10:00:00.002Z",
        params: { original_file_id: source.id, original_share_id: "share" }, links: { "application/octet-stream": { url: `https://example.mypikpak.net/${id}` } } });
      state.tasks.set(task, { id: task, type: "restore", phase: "PHASE_TYPE_COMPLETE", created_time: "2026-10-08T10:00:00.001Z", params: { trace_file_ids: { [source.id]: id } } });
      return json({ restore_status: "RESTORE_START", restore_task_id: task });
    }
    if (path.endsWith("/files:batchDelete")) {
      const ids = JSON.parse(String(init.body)).ids as string[]; state.deleteRequests.push(ids.length);
      for (const id of ids) { expect(state.cloud.has(id)).toBe(true); state.usage -= BigInt(String(state.cloud.get(id)!.size)); state.cloud.delete(id); state.deleted.push(id); }
      return json({});
    }
    const id = path.split("/").at(-1)!;
    if (path.includes("/tasks/") && state.tasks.has(id)) return json(state.tasks.get(id));
    if (path.includes("/files/") && state.cloud.has(id)) return json(state.cloud.get(id));
    return Response.json({ error: "file_not_found" }, { status: 404 });
  };
  const api: Pick<PikpakClient, "request"> = { request: async (_, path, init = {}, before) => { before?.(); return requestJson("fake", `https://api-drive.mypikpak.com${path}`, init, http); } };
  const fetch = async (url: string, init: RequestInit) => {
    const file = state.cloud.get(new URL(url).pathname.slice(1))!;
    const source = sources.find(item => item.id === (file.params as { original_file_id: string }).original_file_id)!;
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get("range")!)!;
    const start = Number(range[1]), end = Number(range[2]);
    return new Response(source.bytes.slice(start, end + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${source.size}` } });
  };
  const engine = new Engine(store, secrets, new Drive(api, "account"), files, () => {}, fetch, async () => {});
  return { root, store, share, state, sources, engine, api, secrets, fetch, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}
