import { expect, test } from "bun:test";
import { DEFAULT_ACTIVE_FILES, MAX_ACTIVE_FILES, configuredActiveFiles, parseActiveFiles, saveActiveFiles } from "../src/runtime/active-files";
import { AccountTier, PAID_ACTIVE_FILES, classifyTier, membership, storedTier, tierCap } from "../src/pikpak/tier";
import { ProviderError } from "../src/pikpak/protocol";

function memoryConfig(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { config: (key: string) => values.get(key) ?? null, setConfig: (key: string, value: string) => { values.set(key, value); }, values };
}

test("同时下载的文件数只接受 1–5 的整数，未设置时为 1，非法值保留原值", () => {
  expect([DEFAULT_ACTIVE_FILES, MAX_ACTIVE_FILES, PAID_ACTIVE_FILES]).toEqual([1, 5, 5]);
  expect(["1", "3", "5"].map(parseActiveFiles)).toEqual([1, 3, 5]);
  for (const bad of ["0", "-1", "6", "2.5", "03", " 2", "", "x"]) expect(parseActiveFiles(bad)).toBe(null);
  const store = memoryConfig();
  expect(configuredActiveFiles(store)).toBe(1);
  expect(saveActiveFiles(store, 3)).toBe(3); expect(configuredActiveFiles(store)).toBe(3);
  for (const bad of [0, 6, 1.5, "five"]) { expect(() => saveActiveFiles(store, bad)).toThrow(); expect(store.values.get("max_active_files")).toBe("3"); }
  expect(configuredActiveFiles(memoryConfig({ max_active_files: "9" }))).toBe(1);
});

test("等级判断：只有 ok、非 novip 且未到期时才是会员；格式不符为未知", () => {
  const now = Date.parse("2026-10-15T00:00:00Z"), future = "2027-01-01T00:00:00Z", past = "2026-01-01T00:00:00Z";
  expect(classifyTier({ data: { status: "ok", type: "platinum", expire: future } }, now)).toBe("paid");
  expect(classifyTier({ data: { status: "ok", type: "novip", expire: future } }, now)).toBe("free");
  expect(classifyTier({ data: { status: "ok", type: "platinum", expire: past } }, now)).toBe("free");
  expect(classifyTier({ data: { status: "expired", type: "platinum", expire: future } }, now)).toBe("free");
  expect(classifyTier({ data: { status: "ok", type: "", expire: future } }, now)).toBe("free");
  expect(classifyTier({ data: { status: "ok", type: "platinum", expire: "not a date" } }, now)).toBe("free");
  for (const body of [null, {}, { data: null }, { data: { status: 1, type: "platinum" } }, "text"]) expect(classifyTier(body, now)).toBe("unknown");
  expect([tierCap("paid"), tierCap("free"), tierCap("unknown")]).toEqual([5, 1, 1]);
});

test("会员详情：保留类型与到期时间，免费账号没有类型，格式不符为 null", () => {
  const now = Date.parse("2026-10-15T00:00:00Z"), future = "2027-01-01T00:00:00Z";
  expect(membership({ data: { status: "ok", type: "platinum", expire: future } }, now)).toEqual({ tier: "paid", type: "platinum", expire: Date.parse(future) });
  expect(membership({ data: { status: "ok", type: "novip", expire: "" } }, now)).toEqual({ tier: "free", type: null, expire: null });
  expect(membership({ data: null }, now)).toBe(null);
});

test("等级每 10 分钟刷新；读取失败沿用上次成功的结果并在 1 分钟后重试；从未成功为未知；会员到期后降级", async () => {
  let now = 0, calls = 0, reply: unknown = { data: { status: "ok", type: "platinum", expire: "2999-01-01T00:00:00Z" } };
  const quiet: boolean[] = [];
  const api = { request: async (_account: string, path: string, _init?: RequestInit, _before?: () => void, options?: { quiet?: boolean }) => {
    calls++; expect(path).toBe("/drive/v1/privilege/vip"); quiet.push(options?.quiet === true);
    if (reply instanceof Error) throw reply; return reply as Record<string, unknown>;
  } };
  const store = memoryConfig();
  const tier = new AccountTier(api, "account", store, () => now);
  expect(tier.current).toBe("unknown"); expect(tier.cap).toBe(1);
  expect(await tier.refresh()).toBe("paid"); expect(tier.cap).toBe(5); expect(calls).toBe(1); expect(quiet).toEqual([true]);
  expect(storedTier(store, "account")).toEqual({ account: "account", tier: "paid", at: 0 }); expect(storedTier(store, "other")).toBe(null);
  now = 599_999; await tier.refresh(); expect(calls).toBe(1);
  now = 600_000; reply = new ProviderError("drive", "server_error", 500);
  expect(await tier.refresh()).toBe("paid"); expect(calls).toBe(2);
  now = 630_000; await tier.refresh(); expect(calls).toBe(2);
  now = 660_000; reply = { data: { status: "ok", type: "platinum", expire: "1970-01-01T00:00:00Z" } };
  expect(await tier.refresh()).toBe("free"); expect(tier.cap).toBe(1); expect(storedTier(store, "account")?.tier).toBe("free");
  const failing = new AccountTier({ request: async () => { throw new ProviderError("drive", "permission_denied", 403); } }, "account", undefined, () => now);
  expect(await failing.refresh()).toBe("unknown"); expect(failing.cap).toBe(1);
  const [first, second] = await Promise.all([tier.refresh(), tier.refresh()]); expect(first).toBe(second);
});
