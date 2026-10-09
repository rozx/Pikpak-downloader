import { expect, test } from "bun:test";
import { link, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemFiles } from "../src/platform/file-system";

test.if(process.platform === "darwin" || process.platform === "win32")("目录句柄约束读写，拒绝符号链接或目录联接逃逸与覆盖发布", async () => {
  const path = await mkdtemp(join(tmpdir(), "pikpak-files-test-"));
  const filesystem = systemFiles(); const root = await filesystem.root(path);
  try {
    const staged = await root.child("staging", true); const target = await root.child("target", true);
    try {
      const file = await staged.file("file.part", true);
      let identity;
      try { await file.write(0n, Buffer.from("synthetic")); await file.sync(); identity = (await file.info()).identity; expect(Buffer.from(await file.read(0n, 9)).toString()).toBe("synthetic"); }
      finally { await file.close(); }
      const other = await target.file("existing.bin", true); await other.close();
      expect(await staged.publish("file.part", target, "existing.bin")).toBe(false);
      expect(await staged.publish("file.part", target, "new.bin")).toBe(true);
      const published = await target.file("new.bin", false);
      try { expect((await published.info()).identity).toEqual(identity); } finally { await published.close(); }
      expect(await readFile(join(path, "target", "existing.bin"), "utf8")).toBe("");
      await symlink(tmpdir(), join(path, "escape"), process.platform === "win32" ? "junction" : "dir");
      await expect(root.child("escape", false)).rejects.toThrow();
      await expect(root.file("../outside", true)).rejects.toThrow();
      if (process.platform === "win32") await link(join(path, "target", "new.bin"), join(path, "staging", "linked"));
      else await symlink(join(path, "target", "new.bin"), join(path, "staging", "linked"));
      await expect(staged.file("linked", false)).rejects.toThrow();
      expect(await root.freeBytes()).toBeGreaterThan(0n);
    } finally { await staged.close(); await target.close(); }
  } finally { await root.close(); await filesystem.close(); await rm(path, { recursive: true, force: true }); }
});
