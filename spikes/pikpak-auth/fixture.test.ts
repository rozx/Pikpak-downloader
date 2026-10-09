import { expect, test } from "bun:test";
import { parseFixture } from "./fixture";

test("完整文本与独立输入字段得到一致的规范化资料", () => {
  expect(parseFixture("https://mypikpak.com/s/synthetic_fixture 密码: demo")).toEqual({ shareId: "synthetic_fixture", passCode: "demo" });
  expect(parseFixture("https://mypikpak.com/s/synthetic_fixture", "demo")).toEqual({ shareId: "synthetic_fixture", passCode: "demo" });
  expect(parseFixture("https://mypikpak.com/s/synthetic_fixture")).toEqual({ shareId: "synthetic_fixture", passCode: "" });
});

test("拒绝相似主机、多个分享和互相矛盾的访问码", () => {
  expect(() => parseFixture("https://mypikpak.com.example.invalid/s/synthetic")).toThrow("unsupported-share-format");
  expect(() => parseFixture("https://mypikpak.com/s/first https://mypikpak.com/s/second")).toThrow("one-share-required");
  expect(() => parseFixture("https://mypikpak.com/s/synthetic 密码: demo", "different")).toThrow("ambiguous-access-code");
});

test("解析失败的异常不回显原始资料", () => {
  const secret = "synthetic-sensitive-input";
  try { parseFixture(secret); }
  catch (error) { expect(String(error)).not.toContain(secret); }
});
