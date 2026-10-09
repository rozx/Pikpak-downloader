import { expect, test } from "bun:test";
import { originalLink, secureDownloadUrl } from "./original-link";

test("优先使用原始二进制链接，兼容旧字段", () => {
  expect(originalLink({ links: { "application/octet-stream": { url: "https://example.invalid/original" } },
    web_content_link: "https://example.invalid/legacy" })).toEqual({ url: "https://example.invalid/original", source: "octet-stream" });
  expect(originalLink({ web_content_link: "https://example.invalid/legacy" })?.source).toBe("legacy");
});

test("媒体播放地址不能自动替代原始文件地址", () => {
  expect(originalLink({ medias: [{ link: { url: "https://example.invalid/transcoded" } }] })).toBe(null);
  expect(originalLink({ links: { "video/mp4": { url: "https://example.invalid/video" } } })).toBe(null);
});

test("只将官方默认端口地址升级到 HTTPS，保持路径和签名参数", () => {
  const result = secureDownloadUrl("http://dl-test.mypikpak.com/download?signature=synthetic%2Bvalue");
  expect(result?.upgraded).toBe(true);
  expect(result?.url.href).toBe("https://dl-test.mypikpak.com/download?signature=synthetic%2Bvalue");
  expect(secureDownloadUrl("https://dl-test.mypikpak.com/download")?.upgraded).toBe(false);
  expect(secureDownloadUrl("https://mypikpak.com.example.invalid/download")).toBe(null);
  expect(secureDownloadUrl("https://user:secret@mypikpak.com/download")).toBe(null);
  expect(secureDownloadUrl("http://dl-test.mypikpak.com:8080/download")).toBe(null);
  expect(secureDownloadUrl("not-a-url")).toBe(null);
});
