import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsFileSystem } from "../src/platform/windows-files";
import type { LocalFileSystem } from "../src/platform/files";

let files: LocalFileSystem | undefined;
afterAll(async () => { await files?.close(); });

test.if(process.platform === "win32")("Windows 文件经文件桥打开并核对身份后，数据读写改用文件描述符，结果与文件桥一致", async () => {
  files = windowsFileSystem();
  const root = mkdtempSync(join(tmpdir(), "pikpak-winfiles-"));
  try {
    const directory = await files.root(root);
    const file = await directory.file("data.bin", true);
    expect((file as unknown as { direct: boolean }).direct).toBe(true);
    const data = Buffer.from(Array.from({ length: 3 * 524288 + 17 }, (_, index) => index % 251));
    await file.write(0n, data.subarray(0, 1000)); await file.write(1000n, data.subarray(1000));
    await file.sync();
    expect((await file.info()).size).toBe(BigInt(data.length));
    const parts: Uint8Array[] = [];
    for (let offset = 0; offset < data.length;) { const part = await file.read(BigInt(offset), 524288); parts.push(part); offset += part.byteLength; }
    expect(Buffer.concat(parts)).toEqual(data);
    await file.truncate(10n); await file.sync();
    expect((await file.info()).size).toBe(10n);
    expect(await file.read(0n, 64)).toEqual(data.subarray(0, 10));
    const identity = (await file.info()).identity;
    await file.close();
    // 只读打开同样走描述符，身份不变。
    const reader = await directory.file("data.bin", false, true);
    expect((reader as unknown as { direct: boolean }).direct).toBe(true);
    expect((await reader.info()).identity).toEqual(identity);
    expect(await reader.read(0n, 64)).toEqual(data.subarray(0, 10));
    await reader.close(); await directory.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
