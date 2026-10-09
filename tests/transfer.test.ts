import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/state/store";
import { macFileSystem } from "../src/platform/mac-files";
import { FileWorkspace } from "../src/download/workspace";
import { ContentHasher } from "../src/download/gcid";
import { download, type DownloadTransport } from "../src/download/transfer";
import { publishVerified, reconcilePublication } from "../src/download/publish";
import type { CopyRecord } from "../src/state/store";

async function fixture(content = Buffer.from("synthetic downloadable bytes")) {
  const root = await mkdtemp(join(tmpdir(), "pikpak-transfer-test-")); let store = new Store(join(root, "db.sqlite"));
  const hash = new ContentHasher(BigInt(content.length)); hash.update(content); const digest = hash.digest();
  store.ensureAccount("account"); const share = store.accept("account", "share", root, "reference"); const scan = store.claimScan("account", share.id)!;
  const file = store.mergeFile(scan, { sourceId: "source", gcid: digest.gcid, size: BigInt(content.length), relativePath: JSON.stringify([{ id: "source", name: "file.bin" }]) });
  store.transition("account", file.id, "ready");
  const copy: CopyRecord = { id: "copy", remoteId: "remote-copy", parentId: "parent", size: file.size, gcid: file.gcid,
    ownership: "unverified", state: "retained", operationId: "operation", evidence: null };
  let workspace = await FileWorkspace.open(store, "account", share.id, macFileSystem);
  const metadata = async () => ({ id: copy.remoteId, parentId: "parent", name: "file.bin", size: file.size, gcid: file.gcid,
    raw: { links: { "application/octet-stream": { url: "https://example.mypikpak.net/synthetic" } } } });
  return { root, get store() { return store; }, file, copy, get workspace() { return workspace; }, digest, content, metadata,
    reopen: async () => { await workspace.close(); store.close(); store = new Store(join(root, "db.sqlite")); workspace = await FileWorkspace.open(store, "account", share.id, macFileSystem); },
    close: async () => { await workspace.close(); store.close(); await rm(root, { recursive: true, force: true }); } };
}
const rangeTransport = (content: Uint8Array): DownloadTransport => async (_, init) => {
  expect(new Headers(init.headers).has("authorization")).toBe(false);
  const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get("range")!)!;
  const start = Number(match[1]), end = Number(match[2]);
  return new Response(content.slice(start, end + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${content.length}` } });
};

test.if(process.platform === "darwin")("真实文件流校验后发布，新版本同名保留已有文件", async () => {
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

test.if(process.platform === "darwin")("恢复校验前缀，服务端忽略范围时从头重新读取", async () => {
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

test.if(process.platform === "darwin")("停机期间前缀被改动时不能续接；损坏的完整内容清除检查点", async () => {
  const f = await fixture();
  try {
    const local = await f.workspace.temporary(f.file); const hash = new ContentHasher(f.file.size); hash.update(f.content.subarray(0, 5));
    await local.write(0n, Buffer.from("wrong")); await local.sync(); await local.close();
    f.store.transition("account", f.file.id, "downloading"); f.store.checkpoint("account", f.file.id, 5n, hash.prefixDigest());
    const corrupt = f.content.slice(); corrupt[0] = 0;
    await expect(download(f.store, "account", f.file, f.copy, f.workspace, f.metadata, new AbortController().signal, undefined,
      async (url, init) => { expect(new Headers(init.headers).get("range")).toStartWith("bytes=0-"); return rangeTransport(corrupt)(url, init); })).rejects.toThrow("integrity_mismatch");
    expect(f.store.delivery("account", f.file.id)!.checkpoint).toBe(0n);
    expect(f.store.file("account", f.file.id).state).not.toBe("completed");
  } finally { await f.close(); }
});

test.if(process.platform === "darwin")("更换目标后发布成功但提交前中断，恢复核对最新路径与文件身份", async () => {
  const f = await fixture();
  try {
    const plan = await f.workspace.prepare(f.file); const original = await f.workspace.targetPath(plan); await writeFile(original, f.content);
    const local = await f.workspace.temporary(f.file); await local.write(0n, f.content); await local.sync(); await local.close();
    f.store.transition("account", f.file.id, "downloading"); f.store.transition("account", f.file.id, "verifying");
    await expect(publishVerified(f.store, "account", f.file, f.workspace, f.digest, undefined, async () => { throw Error("injected-after-publish"); })).rejects.toThrow();
    const intent = f.store.delivery("account", f.file.id)!; expect(intent.targetPath).not.toBe(original);
    expect(f.store.file("account", f.file.id).state).toBe("publishing");
    await f.reopen();
    expect(await reconcilePublication(f.store, "account", f.file, f.workspace)).toBe(true);
    expect(await readFile(original)).toEqual(f.content);
    expect(f.store.file("account", f.file.id).state).toBe("completed");
  } finally { await f.close(); }
});

test.if(process.platform === "darwin")("同摘要的既有用户文件不能证明发布完成", async () => {
  const f = await fixture();
  try {
    const plan = await f.workspace.prepare(f.file); const local = await f.workspace.temporary(f.file); await local.write(0n, f.content); await local.close();
    const target = await f.workspace.targetPath(plan); await writeFile(target, f.content);
    f.store.transition("account", f.file.id, "downloading"); f.store.transition("account", f.file.id, "verifying");
    f.store.planPublication("account", f.file.id, plan, target, f.digest.sha256);
    await expect(reconcilePublication(f.store, "account", f.file, f.workspace)).rejects.toThrow();
    expect(f.store.file("account", f.file.id).state).toBe("publishing");
  } finally { await f.close(); }
});

test.if(process.platform === "darwin")("零字节、过期地址刷新与最终版本变化", async () => {
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
    await expect(download(changed.store, "account", changed.file, changed.copy, changed.workspace, async () => ({ ...await changed.metadata(), gcid: ++metadataReads > 2 ? "b".repeat(40) : changed.file.gcid }), new AbortController().signal, undefined, rangeTransport(changed.content))).rejects.toThrow("version_changed");
    expect(changed.store.file("account", changed.file.id).state).not.toBe("completed");
  } finally { await changed.close(); }
});

test.if(process.platform === "darwin")("错误范围、截断与地址持续过期均有界失败，不产生完成记录", async () => {
  for (const mode of ["range", "truncated", "expired"] as const) {
    const f = await fixture(); let calls = 0;
    try {
      await expect(download(f.store, "account", f.file, f.copy, f.workspace, f.metadata, new AbortController().signal, undefined, async () => {
        calls++;
        if (mode === "expired") return new Response(null, { status: 403 });
        return new Response(mode === "truncated" ? f.content.subarray(0, 3) : f.content, { status: 206,
          headers: { "content-range": mode === "range" ? "bytes 1-2/3" : `bytes 0-${f.content.length - 1}/${f.content.length}` } });
      })).rejects.toThrow();
      expect(f.store.delivery("account", f.file.id)?.completedAt).toBe(null);
      expect(calls).toBeLessThanOrEqual(3);
    } finally { await f.close(); }
  }
});
