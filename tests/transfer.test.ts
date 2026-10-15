import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/state/store";
import { systemFiles } from "../src/platform/file-system";
import type { LocalFileSystem } from "../src/platform/files";
import { FileWorkspace } from "../src/download/workspace";
import { ContentHasher } from "../src/download/gcid";
import { download, remainingBytes, type DownloadTransport } from "../src/download/transfer";
import { CHUNK_SIZE } from "../src/state/ranges";
import { createHash } from "node:crypto";
import { publishVerified, reconcilePublication } from "../src/download/publish";
import type { CopyRecord } from "../src/state/store";
import { rejection } from "./fixtures/rejection";
import { countingFiles } from "./fixtures/counting-files";

// 本地文件适配层在 macOS 与 Windows 上各有实现；Windows 实现背后是常驻桥接进程，测试结束时关闭。
const nativeFiles = ["darwin", "win32", "linux"].includes(process.platform);
let files: LocalFileSystem | undefined;
const localFiles = () => files ??= systemFiles();
afterAll(async () => { await files?.close(); });

async function fixture(content = Buffer.from("synthetic downloadable bytes"), fs?: LocalFileSystem) {
  const root = await mkdtemp(join(tmpdir(), "pikpak-transfer-test-")); let store = new Store(join(root, "db.sqlite"));
  const hash = new ContentHasher(BigInt(content.length)); hash.update(content); const digest = hash.digest();
  store.ensureAccount("account"); const share = store.accept("account", "share", root, "reference"); const scan = store.claimScan("account", share.id)!;
  const file = store.mergeFile(scan, { sourceId: "source", gcid: digest.gcid, size: BigInt(content.length), relativePath: JSON.stringify([{ id: "source", name: "file.bin" }]) });
  store.transition("account", file.id, "ready");
  const copy: CopyRecord = { id: "copy", remoteId: "remote-copy", parentId: "parent", size: file.size, gcid: file.gcid,
    ownership: "unverified", state: "retained", operationId: "operation", evidence: null };
  let workspace = await FileWorkspace.open(store, "account", share.id, fs ?? localFiles());
  const metadata = async () => ({ id: copy.remoteId, parentId: "parent", name: "file.bin", size: file.size, gcid: file.gcid,
    raw: { links: { "application/octet-stream": { url: "https://example.mypikpak.net/synthetic" } } } });
  return { root, get store() { return store; }, file, copy, get workspace() { return workspace; }, digest, content, metadata,
    reopen: async () => { await workspace.close(); store.close(); store = new Store(join(root, "db.sqlite")); workspace = await FileWorkspace.open(store, "account", share.id, fs ?? localFiles()); },
    close: async () => { await workspace.close(); store.close(); await rm(root, { recursive: true, force: true }); } };
}
const rangeTransport = (content: Uint8Array): DownloadTransport => async (_, init) => {
  expect(new Headers(init.headers).has("authorization")).toBe(false);
  const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get("range")!)!;
  const start = Number(match[1]), end = Number(match[2]);
  return new Response(content.slice(start, end + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${content.length}` } });
};

test.if(nativeFiles)("真实文件流校验后发布，新版本同名保留已有文件", async () => {
  const f = await fixture();
  try {
    const plan = await f.workspace.prepare(f.file); const original = await f.workspace.targetPath(plan);
    await writeFile(original, "user-existing-file", { flag: "wx" });
    await download(f.store, "account", f.file, f.copy, f.workspace, f.metadata, new AbortController().signal, undefined, rangeTransport(f.content));
    const delivery = f.store.delivery("account", f.file.id)!;
    expect(f.store.file("account", f.file.id).state).toBe("completed"); expect(delivery.targetPath).not.toBe(original);
    expect(await readFile(original, "utf8")).toBe("user-existing-file"); expect(await readFile(delivery.targetPath)).toEqual(f.content);
    expect(delivery.publishAttempt).toBe(2n); expect(f.store.operationFor("account", f.file.id, "publish")).toBe(null);
  } finally { await f.close(); }
});

test.if(nativeFiles)("恢复校验前缀，服务端忽略范围时从头重新读取", async () => {
  const f = await fixture();
  try {
    const local = await f.workspace.temporary(f.file); const prefix = new ContentHasher(f.file.size); prefix.update(f.content.subarray(0, 5));
    await local.write(0n, f.content.subarray(0, 5)); await local.sync(); await local.close();
    f.store.transition("account", f.file.id, "downloading"); f.store.checkpoint("account", f.file.id, 5n, prefix.prefixDigest());
    const requests: string[] = [];
    const http: DownloadTransport = async (_, init) => { requests.push(new Headers(init.headers).get("range")!); return new Response(f.content, { status: 200 }); };
    await download(f.store, "account", f.file, f.copy, f.workspace, f.metadata, new AbortController().signal, undefined, http);
    expect(requests[0]).toStartWith("bytes=5-"); expect(requests[1]).toStartWith("bytes=0-");
    expect(await readFile(f.store.delivery("account", f.file.id)!.targetPath)).toEqual(f.content);
  } finally { await f.close(); }
});

test.if(nativeFiles)("停机期间前缀被改动时不能续接；损坏的完整内容清除检查点", async () => {
  const f = await fixture();
  try {
    const local = await f.workspace.temporary(f.file); const hash = new ContentHasher(f.file.size); hash.update(f.content.subarray(0, 5));
    await local.write(0n, Buffer.from("wrong")); await local.sync(); await local.close();
    f.store.transition("account", f.file.id, "downloading"); f.store.checkpoint("account", f.file.id, 5n, hash.prefixDigest());
    const corrupt = f.content.slice(); corrupt[0] = 0;
    const failure = await rejection(download(f.store, "account", f.file, f.copy, f.workspace, f.metadata, new AbortController().signal, undefined,
      async (url, init) => { expect(new Headers(init.headers).get("range")).toStartWith("bytes=0-"); return rangeTransport(corrupt)(url, init); }));
    expect(failure.message).toContain("integrity_mismatch");
    expect(f.store.delivery("account", f.file.id)!.checkpoint).toBe(0n);
    expect(f.store.file("account", f.file.id).state).not.toBe("completed");
  } finally { await f.close(); }
});

test.if(nativeFiles)("更换目标后发布成功但提交前中断，恢复核对最新路径与文件身份", async () => {
  const f = await fixture();
  try {
    const plan = await f.workspace.prepare(f.file); const original = await f.workspace.targetPath(plan); await writeFile(original, f.content);
    const local = await f.workspace.temporary(f.file); await local.write(0n, f.content); await local.sync(); await local.close();
    f.store.transition("account", f.file.id, "downloading"); f.store.transition("account", f.file.id, "verifying");
    await rejection(publishVerified(f.store, "account", f.file, f.workspace, f.digest, undefined, async () => { throw Error("injected-after-publish"); }));
    const intent = f.store.delivery("account", f.file.id)!; expect(intent.targetPath).not.toBe(original);
    expect(f.store.file("account", f.file.id).state).toBe("publishing");
    await f.reopen();
    expect(await reconcilePublication(f.store, "account", f.file, f.workspace)).toBe(true);
    expect(await readFile(original)).toEqual(f.content);
    expect(f.store.file("account", f.file.id).state).toBe("completed");
  } finally { await f.close(); }
});

test.if(nativeFiles)("同摘要的既有用户文件不能证明发布完成", async () => {
  const f = await fixture();
  try {
    const plan = await f.workspace.prepare(f.file); const local = await f.workspace.temporary(f.file); await local.write(0n, f.content); await local.close();
    const target = await f.workspace.targetPath(plan); await writeFile(target, f.content);
    f.store.transition("account", f.file.id, "downloading"); f.store.transition("account", f.file.id, "verifying");
    f.store.planPublication("account", f.file.id, plan, target, f.digest.sha256);
    await rejection(reconcilePublication(f.store, "account", f.file, f.workspace));
    expect(f.store.file("account", f.file.id).state).toBe("publishing");
  } finally { await f.close(); }
});

test.if(nativeFiles)("零字节、过期地址刷新与最终版本变化", async () => {
  const zero = await fixture(Buffer.alloc(0));
  try { await download(zero.store, "account", zero.file, zero.copy, zero.workspace, zero.metadata, new AbortController().signal, undefined, async () => { throw Error("must-not-fetch"); }); expect(zero.store.file("account", zero.file.id).state).toBe("completed"); }
  finally { await zero.close(); }
  const f = await fixture(); let requests = 0;
  try {
    await download(f.store, "account", f.file, f.copy, f.workspace, f.metadata, new AbortController().signal, undefined, async (url, init) => ++requests === 1 ? new Response(null, { status: 403 }) : rangeTransport(f.content)(url, init));
    expect(requests).toBe(2);
  } finally { await f.close(); }
  const changed = await fixture(); let metadataReads = 0;
  try {
    const failure = await rejection(download(changed.store, "account", changed.file, changed.copy, changed.workspace, async () => ({ ...await changed.metadata(), gcid: ++metadataReads > 2 ? "b".repeat(40) : changed.file.gcid }), new AbortController().signal, undefined, rangeTransport(changed.content)));
    expect(failure.message).toContain("version_changed");
    expect(changed.store.file("account", changed.file.id).state).not.toBe("completed");
  } finally { await changed.close(); }
});

test.if(nativeFiles)("错误范围、截断与地址持续过期均有界失败，不产生完成记录", async () => {
  for (const mode of ["range", "truncated", "expired"] as const) {
    const f = await fixture(); let calls = 0;
    try {
      await rejection(download(f.store, "account", f.file, f.copy, f.workspace, f.metadata, new AbortController().signal, undefined, async () => {
        calls++;
        if (mode === "expired") return new Response(null, { status: 403 });
        return new Response(mode === "truncated" ? f.content.subarray(0, 3) : f.content, { status: 206,
          headers: { "content-range": mode === "range" ? "bytes 1-2/3" : `bytes 0-${f.content.length - 1}/${f.content.length}` } });
      }));
      expect(f.store.delivery("account", f.file.id)?.completedAt).toBe(null);
      expect(calls).toBeLessThanOrEqual(3);
    } finally { await f.close(); }
  }
});

const segmentedContent = (seed: number) => Buffer.from(Uint8Array.from({ length: 2 * Number(CHUNK_SIZE) + 4099 }, (_, index) => (index * seed + 13) % 251));
const fastClock = () => performance.now() * 50;

test.if(nativeFiles)("多连接分段路径经真实文件桥下载、读回校验并发布", async () => {
  const f = await fixture(segmentedContent(7));
  try {
    const ranges: string[] = [];
    const transport = rangeTransport(f.content);
    const http: DownloadTransport = async (url, init) => { ranges.push(new Headers(init.headers).get("range")!); return transport(url, init); };
    await download(f.store, "account", f.file, f.copy, f.workspace, f.metadata, new AbortController().signal, undefined, http, { connections: 4, now: fastClock });
    expect(f.store.file("account", f.file.id).state).toBe("completed");
    expect(await readFile(f.store.delivery("account", f.file.id)!.targetPath)).toEqual(f.content);
    expect(ranges.map(range => Number(/^bytes=(\d+)-/.exec(range)![1])).sort((a, b) => a - b)).toEqual([0, Number(CHUNK_SIZE), 2 * Number(CHUNK_SIZE)]);
  } finally { await f.close(); }
}, 60000);

test.if(nativeFiles)("同大小但内容被篡改的分段响应不能完成：从头开始并清空区间", async () => {
  const f = await fixture(segmentedContent(11));
  try {
    const tampered = Buffer.from(f.content); tampered[Number(CHUNK_SIZE) + 5] = tampered[Number(CHUNK_SIZE) + 5]! ^ 0xff;
    const error = await rejection(download(f.store, "account", f.file, f.copy, f.workspace, f.metadata, new AbortController().signal, undefined,
      rangeTransport(tampered), { connections: 4, now: fastClock }));
    expect((error as { code?: string }).code).toBe("integrity_mismatch");
    expect(f.store.file("account", f.file.id).state).toBe("downloading");
    expect(f.store.delivery("account", f.file.id)).toMatchObject({ checkpoint: 0n, ranges: null, completedAt: null });
  } finally { await f.close(); }
}, 60000);

test.if(nativeFiles)("本地空间预估不截断前缀之后的分块数据，只截掉超过文件大小的部分", async () => {
  const f = await fixture(segmentedContent(17));
  try {
    const S = Number(CHUNK_SIZE), local = await f.workspace.temporary(f.file);
    await local.write(0n, f.content.subarray(0, S + 100)); await local.sync(); await local.close();
    const prefix = new ContentHasher(f.file.size); prefix.update(f.content.subarray(0, S));
    f.store.transition("account", f.file.id, "downloading");
    f.store.checkpoint("account", f.file.id, CHUNK_SIZE, prefix.prefixDigest(), { mode: "parallel", chunk: CHUNK_SIZE,
      ranges: [{ offset: CHUNK_SIZE, bytes: 100n, sha256: createHash("sha256").update(f.content.subarray(S, S + 100)).digest("hex") }] });
    expect(await remainingBytes(f.store, "account", f.file, f.workspace)).toBe(f.file.size - CHUNK_SIZE);
    let check = await f.workspace.temporary(f.file);
    try { expect((await check.info()).size).toBe(CHUNK_SIZE + 100n); } finally { await check.close(); }
    const grow = await f.workspace.temporary(f.file); await grow.write(f.file.size, Buffer.from("garbage")); await grow.sync(); await grow.close();
    await remainingBytes(f.store, "account", f.file, f.workspace);
    check = await f.workspace.temporary(f.file);
    try { expect((await check.info()).size).toBe(f.file.size); } finally { await check.close(); }
    expect(f.store.delivery("account", f.file.id)?.ranges?.ranges).toHaveLength(1);
  } finally { await f.close(); }
}, 60000);

test.if(nativeFiles)("服务端不支持 Range：探测收到 200 后改走顺序路径完成，并记住顺序模式", async () => {
  const f = await fixture(segmentedContent(19));
  try {
    const ranges: string[] = [];
    const http: DownloadTransport = async (_, init) => { ranges.push(new Headers(init.headers).get("range")!); return new Response(f.content, { status: 200 }); };
    await download(f.store, "account", f.file, f.copy, f.workspace, f.metadata, new AbortController().signal, undefined, http, { connections: 4, now: fastClock });
    expect(f.store.file("account", f.file.id).state).toBe("completed");
    expect(await readFile(f.store.delivery("account", f.file.id)!.targetPath)).toEqual(f.content);
    expect(f.store.delivery("account", f.file.id)?.ranges?.mode).toBe("sequential");
    expect(ranges.every(range => range.startsWith("bytes=0-"))).toBe(true);
  } finally { await f.close(); }
}, 60000);

test.if(nativeFiles)("已有进度时 Range 异常：第一次以顺序模式从头重下，顺序路径再次异常报 range_mismatch", async () => {
  const S = Number(CHUNK_SIZE);
  const recovered = await fixture(segmentedContent(23));
  try {
    let bad = true; const transport = rangeTransport(recovered.content);
    // 分段路径中第 2 块的响应范围错误一次；之后顺序路径的请求都正常。
    const http: DownloadTransport = async (url, init) => {
      const start = Number(/^bytes=(\d+)-/.exec(new Headers(init.headers).get("range")!)![1]);
      if (start === S && bad) { bad = false; return new Response(recovered.content.subarray(0, 10), { status: 206, headers: { "content-range": `bytes 0-9/${recovered.content.length}` } }); }
      return transport(url, init);
    };
    await download(recovered.store, "account", recovered.file, recovered.copy, recovered.workspace, recovered.metadata, new AbortController().signal, undefined, http, { connections: 4, now: fastClock });
    expect(recovered.store.file("account", recovered.file.id).state).toBe("completed");
    expect(await readFile(recovered.store.delivery("account", recovered.file.id)!.targetPath)).toEqual(recovered.content);
  } finally { await recovered.close(); }
  const broken = await fixture(segmentedContent(29));
  try {
    const transport = rangeTransport(broken.content);
    const http: DownloadTransport = async (url, init) => {
      const start = Number(/^bytes=(\d+)-/.exec(new Headers(init.headers).get("range")!)![1]);
      return start === S ? new Response(broken.content.subarray(0, 10), { status: 206, headers: { "content-range": `bytes 0-9/${broken.content.length}` } }) : transport(url, init);
    };
    const error = await rejection(download(broken.store, "account", broken.file, broken.copy, broken.workspace, broken.metadata, new AbortController().signal, undefined, http, { connections: 4, now: fastClock }));
    expect((error as { code?: string }).code).toBe("range_mismatch");
    expect(broken.store.delivery("account", broken.file.id)?.ranges?.mode).toBe("sequential");
  } finally { await broken.close(); }
}, 60000);

test.if(nativeFiles)("校验与发布不再重复整文件读回：分段路径只在并入时读一遍，顺序路径只在校验时读一遍", async () => {
  const content = segmentedContent(37), size = content.length;
  const parallel = countingFiles(localFiles()), f = await fixture(content, parallel.files);
  try {
    await download(f.store, "account", f.file, f.copy, f.workspace, f.metadata, new AbortController().signal, undefined, rangeTransport(f.content), { connections: 4, now: fastClock });
    expect(f.store.file("account", f.file.id).state).toBe("completed");
    expect(await readFile(f.store.delivery("account", f.file.id)!.targetPath)).toEqual(f.content);
    expect(parallel.stats.readBytes).toBeLessThanOrEqual(size);
  } finally { await f.close(); }
  const sequential = countingFiles(localFiles()), g = await fixture(content, sequential.files);
  try {
    await download(g.store, "account", g.file, g.copy, g.workspace, g.metadata, new AbortController().signal, undefined, rangeTransport(g.content));
    expect(g.store.file("account", g.file.id).state).toBe("completed");
    expect(sequential.stats.readBytes).toBe(size);
  } finally { await g.close(); }
}, 120000);

