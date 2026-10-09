import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Store } from "../src/state/store";
import { acceptShare } from "../src/auth/share-access";
import { ContentHasher } from "../src/download/gcid";
import { macFileSystem } from "../src/platform/mac-files";
import { Drive } from "../src/pikpak/drive";
import { ProviderError, requestJson, type Transport } from "../src/pikpak/protocol";
import type { PikpakClient } from "../src/pikpak/client";
import { Engine } from "../src/runtime/engine";
import type { LocalFileSystem } from "../src/platform/files";

async function fixture(count = 2, sizes?: number[]) {
  const root = await mkdtemp(join(tmpdir(), "pikpak-engine-test-")); const store = new Store(join(root, "db.sqlite"));
  const values = new Map<string, string>(); const secrets = { get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => { values.set(key, value); }, delete: async (key: string) => { values.delete(key); } };
  store.ensureAccount("account"); const { share } = await acceptShare(store, secrets, { accountId: "account", shareId: "share", passCode: "demo", outputRoot: root });
  const sources = Array.from({ length: count }, (_, index) => {
    const bytes = Buffer.alloc(sizes?.[index] ?? 40, index); const hash = new ContentHasher(BigInt(bytes.length)); hash.update(bytes);
    return { id: `source-${index}`, name: "file.bin", kind: "drive#file", phase: "PHASE_TYPE_COMPLETE", size: String(bytes.length), hash: hash.digest().gcid, bytes };
  });
  const state = { saves: 0, usage: 10n, limit: 60n, expired: false, deleted: [] as string[], cloud: new Map<string, Record<string, unknown>>(), tasks: new Map<string, Record<string, unknown>>(), sourceReads: 0 };
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
      const ids = JSON.parse(String(init.body)).ids; expect(ids).toHaveLength(1);
      expect(state.cloud.has(ids[0])).toBe(true); state.usage -= BigInt(String(state.cloud.get(ids[0])!.size)); state.cloud.delete(ids[0]); state.deleted.push(ids[0]); return json({});
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
  const engine = new Engine(store, secrets, new Drive(api, "account"), macFileSystem, () => {}, fetch, async () => {});
  return { root, store, share, state, sources, engine, api, secrets, fetch, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test.if(process.platform === "darwin")("分享总大小大于容量，逐文件转存、交付、按需回收，保留所有本地成果", async () => {
  const f = await fixture(); const signal = new AbortController().signal;
  try {
    for (let i = 0; i < 10 && await f.engine.step(signal); i++) {}
    expect(f.store.summary("account", f.share.id)).toMatchObject({ status: "completed", total: 2, completed: 2 });
    expect(f.state.saves).toBe(2); expect(f.state.deleted).toEqual(["copy-1"]); expect(f.state.usage).toBe(50n);
    for (const file of f.store.files("account")) expect(await readFile(f.store.delivery("account", file.id)!.targetPath)).toEqual(f.sources.find(source => source.id === file.sourceId)!.bytes);
  } finally { await f.close(); }
});

test.if(process.platform === "darwin")("保存副本后分享失效，中断重开仍直接从副本完成下载", async () => {
  const f = await fixture(1); const abort = new AbortController();
  try {
    await f.engine.step(abort.signal);
    const interrupted = new Engine(f.store, f.secrets, new Drive(f.api, "account"), macFileSystem, () => {}, async (url, init) => {
      f.state.expired = true; abort.abort(); return f.fetch(url, init);
    }, async () => {});
    await interrupted.step(abort.signal);
    const before = f.state.sourceReads;
    await f.engine.reconcile(new AbortController().signal);
    await f.engine.step(new AbortController().signal);
    expect(f.state.sourceReads).toBe(before); expect(f.state.saves).toBe(1);
    expect(f.store.summary("account", f.share.id).status).toBe("completed");
  } finally { await f.close(); }
});

test.if(process.platform === "darwin")("没有合法回收候选时等待，文件超过总容量时不删除", async () => {
  const f = await fixture(1); const signal = new AbortController().signal;
  try {
    f.state.usage = 60n; await f.engine.step(signal); await f.engine.step(signal);
    expect(f.store.files("account")[0]?.state).toBe("waiting_space"); expect(await f.engine.step(signal)).toBe(false);
    expect(f.state.deleted).toHaveLength(0); expect(f.state.saves).toBe(0);
    const file = f.store.files("account")[0]!; f.store.retry("account", file.id); f.state.limit = 20n;
    await f.engine.step(signal);
    expect(f.store.file("account", file.id).lastError).toBe("file_exceeds_cloud_capacity"); expect(f.state.deleted).toHaveLength(0);
  } finally { await f.close(); }
});

test.if(process.platform === "darwin")("大文件等待空间时继续较小文件，不忙循环", async () => {
  const f = await fixture(2, [40, 5]); const signal = new AbortController().signal;
  try {
    f.state.usage = 50n;
    for (let i = 0; i < 10 && await f.engine.step(signal); i++) {}
    const files = f.store.files("account");
    expect(files.find(file => file.size === 40n)?.state).toBe("waiting_space");
    expect(files.find(file => file.size === 5n)?.state).toBe("completed");
    expect(await f.engine.step(signal)).toBe(false); expect(f.state.deleted).toHaveLength(0);
  } finally { await f.close(); }
});

test.if(process.platform === "darwin")("已确认副本丢失时有界重新保存，不需要重新下载有效前缀", async () => {
  const f = await fixture(1); const abort = new AbortController();
  try {
    await f.engine.step(abort.signal);
    const stopped = new Engine(f.store, f.secrets, new Drive(f.api, "account"), macFileSystem, () => {}, async (url, init) => {
      abort.abort(); return f.fetch(url, init);
    }, async () => {});
    await stopped.step(abort.signal);
    f.state.cloud.delete("copy-1"); f.state.usage = 10n;
    await f.engine.step(new AbortController().signal);
    expect(f.state.saves).toBe(2);
    const file = f.store.files("account")[0]!;
    expect(file.state).toBe("completed"); expect(file.retries).toBe(1n);
    expect(f.state.deleted).toHaveLength(0);
  } finally { await f.close(); }
});

test.if(process.platform === "darwin")("本地空间不足和数据库失败暂停执行，不触发云端清理", async () => {
  const f = await fixture(1); const signal = new AbortController().signal;
  try {
    await f.engine.step(signal);
    const lowSpace: LocalFileSystem = { close: async () => {}, root: async path => {
      const root = await macFileSystem.root(path);
      return { identity: () => root.identity(), child: (name, create) => root.child(name, create), file: (name, create, readOnly) => root.file(name, create, readOnly),
        publish: (name, target, targetName) => root.publish(name, target, targetName), close: () => root.close(), sync: () => root.sync(), freeBytes: async () => 0n };
    } };
    const engine = new Engine(f.store, f.secrets, new Drive(f.api, "account"), lowSpace, () => {}, f.fetch);
    await engine.step(signal); expect(f.store.paused("account")?.reason).toBe("local_space"); expect(f.state.saves).toBe(0);
    f.store.cancel("account", f.share.id); f.store.recheckCancelledPause("account"); expect(f.store.paused("account")).toBe(null);
    expect(f.state.deleted).toHaveLength(0);
  } finally { await f.close(); }
  const broken = await fixture(1);
  try {
    await broken.engine.step(signal);
    broken.store.checkpoint = () => { throw Object.assign(Error("synthetic-write-failure"), { code: "SQLITE_READONLY" }); };
    await broken.engine.step(signal);
    expect(broken.store.paused("account")?.reason).toBe("database");
    expect(await broken.engine.step(signal)).toBe(false); expect(broken.state.deleted).toHaveLength(0);
  } finally { await broken.close(); }
});

test.if(process.platform === "darwin")("流量额度只读验证后才恢复，限流遵守等待而不删除", async () => {
  const f = await fixture(1); const signal = new AbortController().signal;
  try {
    await f.engine.step(signal);
    const quota = new Engine(f.store, f.secrets, new Drive(f.api, "account"), macFileSystem, () => {}, async () => new Response(null, { status: 402 }));
    await quota.step(signal); expect(f.store.paused("account")?.reason).toBe("traffic_quota");
    await quota.resumeTrafficPause(signal); expect(f.store.paused("account")?.reason).toBe("traffic_quota");
    await f.engine.resumeTrafficPause(signal); expect(f.store.paused("account")).toBe(null);
    await f.engine.step(signal); expect(f.store.files("account")[0]?.state).toBe("completed"); expect(f.state.deleted).toHaveLength(0);
  } finally { await f.close(); }
  const limited = await fixture(1);
  try {
    await limited.engine.step(signal);
    const rate = new Engine(limited.store, limited.secrets, new Drive(limited.api, "account"), macFileSystem, () => {}, async () => new Response(null, { status: 429, headers: { "retry-after": "60" } }));
    await rate.step(signal); expect(limited.store.rateLimited("account")).toBe(true);
    expect(await rate.step(signal)).toBe(false); expect(limited.state.deleted).toHaveLength(0);
  } finally { await limited.close(); }
});

test.if(process.platform === "darwin")("副本缺失但源已更新时不拼接旧版，模糊 404 不自动重转存", async () => {
  for (const mode of ["changed", "ambiguous"] as const) {
    const f = await fixture(1); const abort = new AbortController();
    try {
      await f.engine.step(abort.signal);
      const interrupted = new Engine(f.store, f.secrets, new Drive(f.api, "account"), macFileSystem, () => {}, async (url, init) => { abort.abort(); return f.fetch(url, init); }, async () => {});
      await interrupted.step(abort.signal);
      const file = f.store.files("account")[0]!;
      if (mode === "changed") {
        f.state.cloud.delete("copy-1"); f.state.usage = 10n; f.sources[0]!.hash = "b".repeat(40);
      } else {
        const request = f.api.request;
        f.api.request = async (account, path, init, before) => {
          if (path.endsWith("/files/copy-1")) throw new ProviderError("metadata", "not_found", 404);
          return request(account, path, init, before);
        };
      }
      await f.engine.step(new AbortController().signal);
      expect(f.state.saves).toBe(1); expect(f.state.deleted).toHaveLength(0);
      expect(f.store.file("account", file.id).lastError).toBe(mode === "changed" ? "version_changed" : "needs_reconciliation");
    } finally { await f.close(); }
  }
});

test.if(process.platform === "darwin")("部分失败耗尽预算后显式重试，成功版本即使本地缺失也不重下", async () => {
  const f = await fixture(); const signal = new AbortController().signal; let failing = true, successfulReads = 0;
  const engine = new Engine(f.store, f.secrets, new Drive(f.api, "account"), macFileSystem, () => {}, async (url, init) => {
    if (url.endsWith("copy-2") && failing) throw Error("temporary-network-error");
    if (url.endsWith("copy-1")) successfulReads++;
    return f.fetch(url, init);
  }, async () => {});
  try {
    for (let step = 0; step < 12; step++) {
      await engine.step(signal);
      const db = new Database(join(f.root, "db.sqlite")); db.exec("UPDATE files SET retry_at=0 WHERE state='retry_wait'"); db.close();
    }
    const files = f.store.files("account"), completed = files.find(file => file.state === "completed")!, failed = files.find(file => file.state === "failed")!;
    expect(failed.retries).toBe(3n); expect(f.store.summary("account", f.share.id).status).toBe("partial");
    await rm(f.store.delivery("account", completed.id)!.targetPath);
    failing = false; f.store.retry("account", f.share.id);
    for (let step = 0; step < 8 && await engine.step(signal); step++) {}
    expect(f.store.summary("account", f.share.id).status).toBe("completed");
    expect(f.state.saves).toBe(2); expect(successfulReads).toBe(1);
  } finally { await f.close(); }
});

test.if(process.platform === "darwin")("取消永久不可用目标上的任务后，其他目标继续执行", async () => {
  const f = await fixture(1); const otherRoot = await mkdtemp(join(tmpdir(), "pikpak-other-target-")); const signal = new AbortController().signal;
  const filesystem: LocalFileSystem = { close: async () => {}, root: async path => {
    if (path === f.root) throw Object.assign(Error("missing-volume"), { code: "ENODEV" });
    return macFileSystem.root(path);
  } };
  const engine = new Engine(f.store, f.secrets, new Drive(f.api, "account"), filesystem, () => {}, f.fetch, async () => {});
  try {
    await engine.step(signal); await engine.step(signal);
    expect(f.store.paused("account")?.reason).toBe("target_unavailable");
    f.store.cancel("account", f.share.id); f.store.recheckCancelledPause("account");
    const next = await acceptShare(f.store, f.secrets, { accountId: "account", shareId: "another-share", passCode: "demo", outputRoot: otherRoot });
    for (let step = 0; step < 8 && await engine.step(signal); step++) {}
    expect(f.store.summary("account", next.share.id).status).toBe("completed");
    expect(f.store.share("account", f.share.id).cancelled).toBe(true); expect(f.state.deleted).toHaveLength(0);
  } finally { await f.close(); await rm(otherRoot, { recursive: true, force: true }); }
});
