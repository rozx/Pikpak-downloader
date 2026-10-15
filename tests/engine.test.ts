import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { acceptShare } from "../src/auth/share-access";
import { systemFiles } from "../src/platform/file-system";
import { Drive } from "../src/pikpak/drive";
import { ProviderError } from "../src/pikpak/protocol";
import { Engine, type RuntimeEvent } from "../src/runtime/engine";
import type { LocalFileSystem } from "../src/platform/files";
import { engineFixture } from "./fixtures/engine";

// 本地文件适配层在 macOS 与 Windows 上各有实现；Windows 实现背后是常驻桥接进程，测试结束时关闭。
const nativeFiles = ["darwin", "win32", "linux"].includes(process.platform);
let files: LocalFileSystem | undefined;
const localFiles = () => files ??= systemFiles();
afterAll(async () => { await files?.close(); });

const fixture = (count?: number, sizes?: number[]) => engineFixture(localFiles(), count, sizes);

test.if(nativeFiles)("分享总大小大于容量，逐文件转存、交付、按需回收，保留所有本地成果", async () => {
  const f = await fixture(); const signal = new AbortController().signal;
  try {
    for (let i = 0; i < 10 && await f.engine.step(signal); i++) {}
    expect(f.store.summary("account", f.share.id)).toMatchObject({ status: "completed", total: 2, completed: 2 });
    expect(f.state.saves).toBe(2); expect(f.state.deleted).toEqual(["copy-1"]); expect(f.state.usage).toBe(50n);
    for (const file of f.store.files("account")) expect(await readFile(f.store.delivery("account", file.id)!.targetPath)).toEqual(f.sources.find(source => source.id === file.sourceId)!.bytes);
  } finally { await f.close(); }
});

test.if(nativeFiles)("用户暂停时不扫描、不转存、不下载、不回收；与系统暂停并存时解除其一仍不调度", async () => {
  const f = await fixture(); const signal = new AbortController().signal; let requests = 0;
  const engine = new Engine(f.store, f.secrets, new Drive({ request: async (account, path, init = {}, before) => { requests++; return f.api.request(account, path, init, before); } }, "account"),
    localFiles(), () => {}, async (url, init) => { requests++; return f.fetch(url, init); }, async () => {});
  try {
    f.store.setConfig("queue_paused", "1");
    expect(await engine.step(signal)).toBe(false);
    expect(requests).toBe(0); expect(f.store.files("account")).toHaveLength(0); expect(f.store.share("account", f.share.id).scanStatus).toBe("pending");
    f.store.pause("account", "authentication");
    f.store.setConfig("queue_paused", "0");
    expect(await engine.step(signal)).toBe(false);
    f.store.setConfig("queue_paused", "1"); f.store.clearAuthenticationPause("account");
    expect(await engine.step(signal)).toBe(false);
    expect(requests).toBe(0);
    f.store.setConfig("queue_paused", "0");
    expect(await engine.step(signal)).toBe(true);
    expect(requests).toBeGreaterThan(0);
  } finally { await f.close(); }
});

test.if(nativeFiles)("下载进度事件携带字节与大小，每秒最多 4 次", async () => {
  const f = await fixture(1, [64 * 1024]); const signal = new AbortController().signal; f.state.limit = 10n ** 9n;
  const events: Array<{ at: number; event: RuntimeEvent }> = [];
  // 把内容拆成 32 块、每块间隔 40 ms 推送（约 1.3 秒），覆盖多个节流窗口。
  const slow = async (url: string, init: RequestInit) => {
    const response = await f.fetch(url, init); const bytes = new Uint8Array(await response.arrayBuffer());
    const stream = new ReadableStream<Uint8Array>({ async start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 2048) { controller.enqueue(bytes.slice(offset, offset + 2048)); await Bun.sleep(40); }
      controller.close();
    } });
    return new Response(stream, { status: response.status, headers: response.headers });
  };
  const engine = new Engine(f.store, f.secrets, new Drive(f.api, "account"), localFiles(), event => events.push({ at: Date.now(), event }), slow, async () => {});
  try {
    for (let i = 0; i < 5 && await engine.step(signal); i++) {}
    const file = f.store.files("account")[0]!;
    expect(file.state).toBe("completed");
    const progress = events.filter(item => item.event.type === "progress");
    expect(progress.length).toBeGreaterThanOrEqual(3);
    for (const [index, item] of progress.entries()) {
      expect(item.event).toMatchObject({ id: file.id, size: 65536n });
      expect(item.event.bytes! > 0n && item.event.bytes! <= 65536n).toBe(true);
      const previous = progress[index - 1];
      if (previous) { expect(item.at - previous.at).toBeGreaterThanOrEqual(240); expect(item.event.bytes! > previous.event.bytes!).toBe(true); }
    }
  } finally { await f.close(); }
});

test.if(nativeFiles)("保存副本后分享失效，中断重开仍直接从副本完成下载", async () => {
  const f = await fixture(1); const abort = new AbortController();
  try {
    await f.engine.step(abort.signal);
    const interrupted = new Engine(f.store, f.secrets, new Drive(f.api, "account"), localFiles(), () => {}, async (url, init) => {
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

test.if(nativeFiles)("没有合法回收候选时等待，文件超过总容量时不删除", async () => {
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

test.if(nativeFiles)("大文件等待空间时继续较小文件，不忙循环", async () => {
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

test.if(nativeFiles)("已确认副本丢失时有界重新保存，不需要重新下载有效前缀", async () => {
  const f = await fixture(1); const abort = new AbortController();
  try {
    await f.engine.step(abort.signal);
    const stopped = new Engine(f.store, f.secrets, new Drive(f.api, "account"), localFiles(), () => {}, async (url, init) => {
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

test.if(nativeFiles)("本地空间不足和数据库失败暂停执行，不触发云端清理", async () => {
  const f = await fixture(1); const signal = new AbortController().signal;
  try {
    await f.engine.step(signal);
    const lowSpace: LocalFileSystem = { close: async () => {}, root: async path => {
      const root = await localFiles().root(path);
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

test.if(nativeFiles)("流量额度只读验证后才恢复，限流遵守等待而不删除", async () => {
  const f = await fixture(1); const signal = new AbortController().signal;
  try {
    await f.engine.step(signal);
    const quota = new Engine(f.store, f.secrets, new Drive(f.api, "account"), localFiles(), () => {}, async () => new Response(null, { status: 402 }));
    await quota.step(signal); expect(f.store.paused("account")?.reason).toBe("traffic_quota");
    await quota.resumeTrafficPause(signal); expect(f.store.paused("account")?.reason).toBe("traffic_quota");
    await f.engine.resumeTrafficPause(signal); expect(f.store.paused("account")).toBe(null);
    await f.engine.step(signal); expect(f.store.files("account")[0]?.state).toBe("completed"); expect(f.state.deleted).toHaveLength(0);
  } finally { await f.close(); }
  const limited = await fixture(1);
  try {
    await limited.engine.step(signal);
    const rate = new Engine(limited.store, limited.secrets, new Drive(limited.api, "account"), localFiles(), () => {}, async () => new Response(null, { status: 429, headers: { "retry-after": "60" } }));
    await rate.step(signal); expect(limited.store.rateLimited("account")).toBe(true);
    expect(await rate.step(signal)).toBe(false); expect(limited.state.deleted).toHaveLength(0);
  } finally { await limited.close(); }
});

test.if(nativeFiles)("副本缺失但源已更新时不拼接旧版，模糊 404 不自动重转存", async () => {
  for (const mode of ["changed", "ambiguous"] as const) {
    const f = await fixture(1); const abort = new AbortController();
    try {
      await f.engine.step(abort.signal);
      const interrupted = new Engine(f.store, f.secrets, new Drive(f.api, "account"), localFiles(), () => {}, async (url, init) => { abort.abort(); return f.fetch(url, init); }, async () => {});
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

test.if(nativeFiles)("部分失败耗尽预算后显式重试，成功版本即使本地缺失也不重下", async () => {
  const f = await fixture(); const signal = new AbortController().signal; let failing = true, successfulReads = 0;
  const engine = new Engine(f.store, f.secrets, new Drive(f.api, "account"), localFiles(), () => {}, async (url, init) => {
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

test.if(nativeFiles)("取消永久不可用目标上的任务后，其他目标继续执行", async () => {
  const f = await fixture(1); const otherRoot = await mkdtemp(join(tmpdir(), "pikpak-other-target-")); const signal = new AbortController().signal;
  const filesystem: LocalFileSystem = { close: async () => {}, root: async path => {
    if (path === f.root) throw Object.assign(Error("missing-volume"), { code: "ENODEV" });
    return localFiles().root(path);
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

const twoChunks = 2 * 8388608 + 4099;
const rangeStart = (init: RequestInit) => Number(/^bytes=(\d+)-/.exec(new Headers(init.headers).get("range")!)![1]);

test.if(nativeFiles)("引擎按配置连接数走分段路径，进度单调增加，记住限流后降低的并发；单连接配置走顺序路径", async () => {
  const signal = new AbortController().signal;
  const f = await fixture(1, [twoChunks]); f.state.limit = 10n ** 12n;
  const events: RuntimeEvent[] = []; let limitedOnce = false;
  const fetch = async (url: string, init: RequestInit) => {
    if (rangeStart(init) === 8388608 && !limitedOnce) { limitedOnce = true; return new Response(null, { status: 429, headers: { "retry-after": "1" } }); }
    return f.fetch(url, init);
  };
  const engine = new Engine(f.store, f.secrets, new Drive(f.api, "account"), localFiles(), event => events.push(event), fetch, async () => {});
  try {
    for (let i = 0; i < 6 && await engine.step(signal); i++) {}
    const file = f.store.files("account")[0]!;
    expect(file.state).toBe("completed"); expect(limitedOnce).toBe(true);
    expect(f.store.delivery("account", file.id)?.ranges?.mode).toBe("parallel");
    expect(await readFile(f.store.delivery("account", file.id)!.targetPath)).toEqual(f.sources[0]!.bytes);
    expect((engine as unknown as { concurrency: Map<string, number> }).concurrency.get("account")).toBe(2);
    const progress = events.filter(event => event.type === "progress");
    for (const [index, event] of progress.entries()) {
      expect(event).toMatchObject({ id: file.id, size: BigInt(twoChunks) });
      if (index > 0) expect(event.bytes! >= progress[index - 1]!.bytes!).toBe(true);
    }
    expect(f.state.deleted).toHaveLength(0);
  } finally { await f.close(); }
  const single = await fixture(1, [twoChunks]); single.state.limit = 10n ** 12n; single.store.setConfig("download_connections", "1");
  try {
    for (let i = 0; i < 6 && await single.engine.step(signal); i++) {}
    const file = single.store.files("account")[0]!;
    expect(file.state).toBe("completed"); expect(single.store.delivery("account", file.id)?.ranges).toBe(null);
  } finally { await single.close(); }
}, 60000);

test.if(nativeFiles)("分段下载升级上报的限流走账号限流路径，不消耗回收、不删除云端副本", async () => {
  const signal = new AbortController().signal;
  const f = await fixture(1, [twoChunks]); f.state.limit = 10n ** 12n;
  try {
    await f.engine.step(signal);
    const limited = new Engine(f.store, f.secrets, new Drive(f.api, "account"), localFiles(), () => {},
      async () => new Response(null, { status: 429, headers: { "retry-after": "61" } }), async () => {});
    await limited.step(signal);
    const file = f.store.files("account")[0]!;
    expect(f.store.rateLimited("account")).toBe(true); expect(file.state).toBe("retry_wait"); expect(file.lastError).toBe("rate_limited");
    expect(await limited.step(signal)).toBe(false); expect(f.state.deleted).toHaveLength(0);
  } finally { await f.close(); }
}, 60000);

