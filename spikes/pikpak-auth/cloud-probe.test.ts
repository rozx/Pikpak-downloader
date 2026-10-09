import { expect, test } from "bun:test";
import { assertOwnedEmpty, safeProviderCode, type Receipt } from "./cloud-probe";

const receipt: Receipt = { role: "target", id: "synthetic-owned-id", name: ".PikpakDownloader-G1-target-synthetic",
  parentId: "", state: "created" };
const file = { id: receipt.id, name: receipt.name, parent_id: "", kind: "drive#folder" };
const empty = { files: [], next_page_token: "" };

test("只接受精确匹配且已确认完全为空的测试目录", () => {
  expect(() => assertOwnedEmpty(receipt, file, empty, empty)).not.toThrow();
  for (const changed of [{ ...file, id: "other" }, { ...file, name: "user-owned" },
    { ...file, parent_id: "moved" }, { ...file, kind: "drive#file" }]) {
    expect(() => assertOwnedEmpty(receipt, changed, empty, empty)).toThrow("resource-changed");
  }
});

test("未知子项、回收站子项及未完成分页都阻止目录删除", () => {
  const nonempty = { files: [{ id: "unrelated" }] };
  expect(() => assertOwnedEmpty(receipt, file, nonempty, empty)).toThrow("folder-not-confirmed-empty");
  expect(() => assertOwnedEmpty(receipt, file, empty, nonempty)).toThrow("folder-not-confirmed-empty");
  expect(() => assertOwnedEmpty(receipt, file, { files: [], next_page_token: "more" }, empty)).toThrow("folder-not-confirmed-empty");
  expect(() => assertOwnedEmpty(receipt, file, {}, empty)).toThrow("folder-not-confirmed-empty");
});

test("仅公开已知错误类别，不回显任意错误字段", () => {
  expect(safeProviderCode({ error: "insufficient_scope", error_description: "synthetic-private" })).toBe("insufficient_scope");
  expect(safeProviderCode({ error: "synthetic-private" })).toBe("provider-error");
});
