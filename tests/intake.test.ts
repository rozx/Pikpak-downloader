import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseShares } from "../src/intake/parse";
import { IntakeReceiver } from "../src/intake/receiver";
import { Store } from "../src/state/store";

const first = "https://mypikpak.com/s/synthetic-one";
const second = "https://mypikpak.com/s/synthetic-two";
test("完整文本、无码和码先于链接；独立码与相似域名不接收", () => {
  expect(parseShares(`说明 ${first} 密码：demo`).shares).toEqual([{ shareId: "synthetic-one", passCode: "demo" }]);
  expect(parseShares(`链接：${first}，密码：demo`).shares[0]?.passCode).toBe("demo");
  expect(parseShares(`密码管理器下载 ${first} 密码：demo`).shares[0]?.passCode).toBe("demo");
  expect(parseShares(`提取码 demo\n链接：${first}。`).shares[0]?.passCode).toBe("demo");
  expect(parseShares(first).shares[0]?.passCode).toBe("");
  for (const input of ["demo", "密码 demo", "PikPak 普通说明", "https://mypikpak.com.evil/s/id", "https://mypikpak.com@evil.test/s/id", "https://notmypikpak.com/s/id"]) expect(parseShares(input).shares).toHaveLength(0);
  expect(parseShares("http://mypikpak.com/s/id").shares).toHaveLength(0);
  expect(parseShares("https://mypikpak.com/drive/synthetic").shares).toHaveLength(0);
});

test("多链接明确配对可接收，歧义和互相矛盾的码不猜测", () => {
  const expected = [{ shareId: "synthetic-one", passCode: "demo" }, { shareId: "synthetic-two", passCode: "test" }];
  expect(parseShares(`${first} 密码 demo\n${second} 密码 test`).shares).toEqual(expected);
  expect(parseShares(`${first}\n密码 demo\n${second}\n密码 test`).shares).toEqual(expected);
  expect(parseShares(`${first} 密码 demo ${second} 密码 test`).shares).toEqual(expected);
  expect(parseShares(`${first}?pwd=demo ${second}?passcode=test`).shares).toEqual(expected);
  expect(parseShares(`${first}\n${second}\n密码 demo`).shares).toHaveLength(0);
  expect(parseShares(`${first} 密码 demo 密码 test`).issues).toEqual(["ambiguous_code"]);
  expect(parseShares(`${first}?pwd=demo&pwd=test`).shares).toHaveLength(0);
  expect(parseShares(`${first} 密码 demo\n\n${first} 密码 test`).shares).toHaveLength(0);
  expect(parseShares(`${first} https://other.example/s/another 密码 test`).shares).toHaveLength(0);
});

test("官方复制格式以空行隔开链接与提取码时仍配对，已有码或多链接不借用相邻码", () => {
  expect(parseShares(`${first}\r\n\r\n \r\n\r\n提取码：demo`).shares).toEqual([{ shareId: "synthetic-one", passCode: "demo" }]);
  expect(parseShares(`${first}\n\n密码 demo\n\n${second}\n\n密码 test`).shares)
    .toEqual([{ shareId: "synthetic-one", passCode: "demo" }, { shareId: "synthetic-two", passCode: "test" }]);
  expect(parseShares(`${first} 密码 demo\n\n密码 test`).shares).toEqual([{ shareId: "synthetic-one", passCode: "demo" }]);
  expect(parseShares(`${first}?pwd=demo\n\n密码 test`).shares).toEqual([{ shareId: "synthetic-one", passCode: "demo" }]);
  expect(parseShares(`${first}\n${second}\n\n密码 demo`).shares).toHaveLength(0);
});

test("轮询同一事件只接收一次，重复制相同文本触发新请求且保持原目标", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pikpak-intake-test-")); const store = new Store(join(dir, "db.sqlite"));
  store.ensureAccount("account");
  const values = new Map<string, string>(); let fail = false;
  const secrets = { get: async (key: string) => values.get(key) ?? null, set: async (key: string, value: string) => { if (fail) throw Error("injected"); values.set(key, value); }, delete: async (key: string) => { values.delete(key); } };
  try {
    const receiver = new IntakeReceiver(store, secrets, "account", "/original");
    const initial = await receiver.receive({ sequence: "1", text: first });
    expect(initial.ids).toHaveLength(1);
    expect((await receiver.receive({ sequence: "1", text: first })).ids).toHaveLength(0);
    const scan = store.claimScan("account", initial.ids[0]!)!;
    await receiver.receive({ sequence: "2", text: `${first} 密码 demo` });
    store.finishScan(scan, false);
    const after = store.share("account", initial.ids[0]!);
    expect(after.requestedRevision).toBe(2n); expect(after.scanStatus).toBe("pending");
    const restarted = new IntakeReceiver(store, secrets, "account", "/new-default");
    await restarted.receive({ sequence: "2", text: first });
    expect(store.share("account", after.id).outputRoot).toBe("/original");
    fail = true;
    expect((await restarted.receive({ sequence: "3", text: second })).failure).not.toBe(null);
    fail = false;
    expect((await restarted.receive({ sequence: "3", text: second })).ids).toHaveLength(1);
    store.pause("account", "authentication");
    expect((await restarted.receive({ sequence: "4", text: first })).ids).toHaveLength(1);
    expect(store.paused("account")?.reason).toBe("authentication");
    const count = values.size;
    await restarted.receive({ sequence: "5", text: "a-private-unrelated-password" });
    expect(values.size).toBe(count);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("同一快照部分保存失败时，只重试尚未确认的分享", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pikpak-intake-test-")); const store = new Store(join(dir, "db.sqlite"));
  store.ensureAccount("account"); const values = new Map<string, string>(); let failSecond = true;
  const secrets = { get: async (key: string) => values.get(key) ?? null, set: async (key: string, value: string) => {
    if (JSON.parse(value).shareId === "synthetic-two" && failSecond) throw Error("injected"); values.set(key, value);
  }, delete: async (key: string) => { values.delete(key); } };
  try {
    const receiver = new IntakeReceiver(store, secrets, "account", "/fixed");
    const snapshot = { sequence: "1", text: `${first}\n${second}` };
    const partial = await receiver.receive(snapshot);
    expect(partial.ids).toHaveLength(1); expect(partial.failure).not.toBe(null);
    failSecond = false;
    const remainder = await receiver.receive(snapshot);
    expect(remainder.ids).toHaveLength(1); expect(remainder.failure).toBe(null);
    expect(store.share("account", partial.ids[0]!).requestedRevision).toBe(1n);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
