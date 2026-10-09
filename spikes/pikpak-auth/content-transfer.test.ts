import { expect, test } from "bun:test";
import { ContentHasher } from "./gcid";
import { assertVersion, contentVersion, verifyTransfer } from "./content-transfer";
import type { Transport } from "./protocol";

const bytes = new TextEncoder().encode("synthetic-content");
function metadata(content = bytes, name = "test.bin") {
  const hasher = new ContentHasher(BigInt(content.length));
  hasher.update(content);
  return { id: "synthetic-id", name, size: String(content.length), hash: hasher.digest().gcid,
    kind: "drive#file", phase: "PHASE_TYPE_COMPLETE",
    links: { "application/octet-stream": { url: "https://example.mypikpak.net/synthetic-only" } } };
}
const file = metadata();
const version = contentVersion(file);
const response = (body = bytes, range = `bytes 0-${bytes.length - 1}/${bytes.length}`, status = 206) =>
  new Response(body, { status, headers: { "content-range": range } });

test("同大小替换改变版本，只有改名不改变版本", () => {
  expect(() => assertVersion({ ...file, name: "renamed.bin" }, version)).not.toThrow();
  const changed = bytes.slice(); changed[0] = 0;
  expect(() => assertVersion(metadata(changed), version)).toThrow("version-changed");
  expect(() => contentVersion({ ...file, hash: null })).toThrow("unverifiable-version");
  expect(() => contentVersion({ ...file, size: null })).toThrow("unverifiable-version");
});

test("完整覆盖加已知 GCID，且 CDN 不接收账号 Authorization", async () => {
  const result = await verifyTransfer(async () => file, version, async (_, init) => {
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("range")).toBe(`bytes=0-${bytes.length - 1}`);
    return response();
  });
  expect(result.gcid).toBe(version.gcid);
  expect(result.ranges).toBe(1);
});

test("零字节不请求无效 Range，但必须有已确认的空内容摘要", async () => {
  const zero = metadata(new Uint8Array());
  const result = await verifyTransfer(async () => zero, contentVersion(zero), async () => { throw Error("must-not-fetch"); });
  expect(result.ranges).toBe(0);
  const wrong = { ...zero, hash: file.hash };
  await expect(verifyTransfer(async () => wrong, contentVersion(wrong))).rejects.toThrow("gcid-mismatch");
});

test("过期地址刷新受版本核对和次数上限约束", async () => {
  let reads = 0, requests = 0;
  const result = await verifyTransfer(async () => { reads++; return file; }, version, async () => {
    return ++requests === 1 ? new Response(null, { status: 403 }) : response();
  });
  expect([reads, requests, result.refreshed]).toEqual([3, 2, 1]);
  requests = 0;
  await expect(verifyTransfer(async () => file, version, async () => {
    requests++; return new Response(null, { status: 403 });
  })).rejects.toThrow("url-refresh-exhausted");
  expect(requests).toBe(2);
});

test("中途版本变化（包括刷新后）不交付或请求新版字节", async () => {
  let reads = 0, requests = 0;
  const changed = bytes.slice(); changed[0] = 0;
  const getMetadata = async () => ++reads === 1 ? file : metadata(changed);
  const fetch: Transport = async () => { requests++; return response(); };
  await expect(verifyTransfer(getMetadata, version, fetch)).rejects.toThrow("version-changed");
  reads = 0; requests = 0;
  await expect(verifyTransfer(getMetadata, version, async () => {
    requests++; return new Response(null, { status: 403 });
  })).rejects.toThrow("version-changed");
  expect(requests).toBe(1);
});

test("拒绝 200、错误范围、压缩、截断、超长和同大小内容损坏", async () => {
  const bad = bytes.slice(); bad[0] = 0;
  const cases: Array<[() => Response, string]> = [
    [() => response(bytes, "", 200), "invalid-range-response"],
    [() => response(bytes, `bytes 1-${bytes.length}/${bytes.length + 1}`), "invalid-range-response"],
    [() => { const r = response(); r.headers.set("content-encoding", "gzip"); return r; }, "invalid-range-response"],
    [() => response(bytes.slice(1)), "truncated-range-content"],
    [() => response(new Uint8Array(bytes.length + 1)), "excess-range-content"],
    [() => response(bad), "gcid-mismatch"],
  ];
  for (const [result, reason] of cases) await expect(verifyTransfer(async () => file, version, async () => result())).rejects.toThrow(reason);
});

test("首段和刷新后的尾段精确拼接且覆盖所有字节", async () => {
  const content = Uint8Array.from({ length: 1048593 }, (_, i) => i % 251);
  const large = metadata(content);
  const requests: string[] = [];
  const result = await verifyTransfer(async () => large, contentVersion(large), async (_, init) => {
    const range = new Headers(init.headers).get("range")!;
    requests.push(range);
    const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
    const start = Number(match[1]), end = Number(match[2]);
    return response(content.slice(start, end + 1), `bytes ${start}-${end}/${content.length}`);
  });
  expect(requests).toEqual(["bytes=0-1048575", "bytes=1048576-1048592"]);
  expect(result.ranges).toBe(2);
  expect(result.refreshed).toBe(1);
});
