import { expect, test } from "bun:test";
import { inspectShare } from "./share-probe";
import type { Transport } from "./protocol";

const fixture = { accountId: "synthetic-account", shareId: "synthetic-share", passCode: "demo" };
test("枚举根分页和子目录，保留精确整数元数据并合并重复文件", async () => {
  const http: Transport = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/share")) return Response.json({ share_status: "OK", pass_code_token: "synthetic-grant" });
    expect(url.searchParams.get("pass_code_token")).toBe("synthetic-grant");
    if (url.searchParams.get("parent_id") === "folder") return Response.json({ share_status: "OK",
      files: [{ id: "small", name: "fixture.bin", kind: "drive#file", size: "1", hash: "synthetic-hash" }] });
    if (url.searchParams.get("page_token")) return Response.json({ share_status: "OK",
      files: [{ id: "big", name: "large.bin", kind: "drive#file", size: "9007199254740993" }] });
    return Response.json({ share_status: "OK", next_page_token: "next", files: [
      { id: "folder", name: "nested", kind: "drive#folder" },
      { id: "big", name: "large.bin", kind: "drive#file", size: "9007199254740993" },
    ] });
  };
  const result = await inspectShare(fixture, "synthetic-token", http);
  expect(result.files).toBe(2);
  expect(result.nestedFiles).toBe(1);
  expect(result.paginationObserved).toBe(true);
  expect(result.scanComplete).toBe(true);
  expect(result.selected?.id).toBe("small");
  expect(result.selected?.parentId).toBe("folder");
});

test("重复页标识停止扫描，不形成无限循环", async () => {
  const http: Transport = async (input) => Response.json(new URL(input).pathname.endsWith("/share")
    ? { share_status: "OK", pass_code_token: "synthetic-grant" }
    : { share_status: "OK", files: [], next_page_token: "same" });
  await expect(inspectShare(fixture, "synthetic-token", http)).rejects.toThrow("repeated-page-token");
});

test("达到验证请求上限时不能报告扫描完整", async () => {
  const http: Transport = async () => Response.json({ share_status: "OK", pass_code_token: "synthetic-grant" });
  const result = await inspectShare(fixture, "synthetic-token", http, 1);
  expect(result.scanComplete).toBe(false);
  expect(result.selected).toBe(null);
});
