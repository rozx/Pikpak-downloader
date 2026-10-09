import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { WindowsSecrets } from "../src/platform/windows-secrets";

test("Windows 凭据适配按 UTF-8 字节上限拒绝超长值，不透传失败原文", async () => {
  let calls = 0;
  const store = new WindowsSecrets(async () => { calls++; throw Error("synthetic-sensitive-provider-error"); });
  await expect(store.set("test", "é".repeat(1281))).rejects.toThrow("系统凭据");
  expect(calls).toBe(0);
  await expect(store.get("test")).rejects.toThrow("系统凭据");
  expect(calls).toBe(1);
});

test.if(process.platform === "win32")("Windows 实际本机持久化往返与清理", async () => {
  const store = new WindowsSecrets();
  const reference = `probe.${randomUUID()}`;
  try {
    await store.set(reference, "synthetic-中文-value");
    expect(await store.get(reference)).toBe("synthetic-中文-value");
    await store.delete(reference);
    expect(await store.get(reference)).toBe(null);
  } finally { await store.delete(reference); }
}, 60000);
