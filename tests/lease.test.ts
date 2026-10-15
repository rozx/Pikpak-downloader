import { expect, test } from "bun:test";
import { UrlLease } from "../src/download/lease";
import { DownloadError } from "../src/download/download-error";
import type { RemoteFile } from "../src/pikpak/drive";
import { rejection } from "./fixtures/rejection";

const remote = (url: string): RemoteFile => ({ id: "copy", parentId: "p", name: "n", size: 1n, gcid: "a".repeat(40),
  raw: { links: { "application/octet-stream": { url } } } });
function metadata(urls: () => string = () => "https://cdn.mypikpak.net/signed?token=secret") {
  const state = { calls: 0, fail: null as Error | null };
  const check = async () => { state.calls++; await Bun.sleep(5); if (state.fail) throw state.fail; return remote(urls()); };
  return { state, check };
}

test("多个连接同时取租约只发一次元数据请求；超过 30 秒后才刷新", async () => {
  let now = 0; const { state, check } = metadata();
  const lease = new UrlLease(check, () => now);
  const leases = await Promise.all([lease.get(), lease.get(), lease.get()]);
  expect(state.calls).toBe(1); expect(new Set(leases.map(item => item.generation))).toEqual(new Set([1]));
  now = 29_999; expect((await lease.get()).generation).toBe(1); expect(state.calls).toBe(1);
  now = 30_000; expect((await lease.get()).generation).toBe(2); expect(state.calls).toBe(2);
});

test("多个连接同时收到 403 时只刷新一次；旧一代的失败直接拿到新租约", async () => {
  const { state, check } = metadata();
  const lease = new UrlLease(check);
  const first = await lease.get();
  const refreshed = await Promise.all([lease.invalidate(first.generation), lease.invalidate(first.generation), lease.invalidate(first.generation)]);
  expect(state.calls).toBe(2); expect(refreshed.map(item => item.generation)).toEqual([2, 2, 2]);
  expect((await lease.invalidate(first.generation)).generation).toBe(2); expect(state.calls).toBe(2);
});

test("自上次成功以来刷新超过 2 次报告地址刷新耗尽，成功响应后预算清零；错误中不含签名地址", async () => {
  const { check } = metadata();
  const lease = new UrlLease(check);
  let current = await lease.get();
  current = await lease.invalidate(current.generation);
  current = await lease.invalidate(current.generation);
  const error = await rejection(lease.invalidate(current.generation));
  expect(error).toBeInstanceOf(DownloadError); expect((error as DownloadError).code).toBe("url_refresh_exhausted");
  expect(String((error as Error).message)).not.toContain("secret"); expect(JSON.stringify(error)).not.toContain("secret");
  lease.succeeded();
  expect((await lease.invalidate(current.generation)).generation).toBe(current.generation + 1);
});

test("刷新时发现版本变化，所有等待中的连接都收到同一错误", async () => {
  const { state, check } = metadata();
  const lease = new UrlLease(check, Date.now, 0);
  await lease.get();
  state.fail = new DownloadError("version_changed");
  const results = await Promise.all([rejection(lease.get()), rejection(lease.get()), rejection(lease.get())]);
  expect(results.map(error => (error as DownloadError).code)).toEqual(["version_changed", "version_changed", "version_changed"]);
  expect(state.calls).toBe(2);
});

test("非 PikPak 域名或带凭据的地址被拒绝", async () => {
  for (const url of ["https://evil.example/file", "https://user:pass@cdn.mypikpak.net/x", "ftp://cdn.mypikpak.net/x"]) {
    const error = await rejection(new UrlLease(metadata(() => url).check).get());
    expect((error as DownloadError).code).toBe("unsupported_download_url");
  }
});
