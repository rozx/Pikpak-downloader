import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { link, open, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Store } from "./store";

export async function writeBackup(store: Store, destination: string): Promise<void> {
  const temporary = join(dirname(destination), `.pikpak-backup-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, store.snapshot(), { flag: "wx", mode: 0o600 });
    const backup = new Database(temporary);
    try {
      backup.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL");
      backup.query("UPDATE metadata SET value='1' WHERE key='backup_review_required'").run();
    } finally { backup.close(); }
    const file = await open(temporary, "r+");
    try { await file.sync(); } finally { await file.close(); }
    await link(temporary, destination);
    // Windows 不能打开目录句柄同步；其他平台同步目录，让新链接落盘。
    if (process.platform !== "win32") {
      const directory = await open(dirname(destination), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await unlink(temporary).catch(() => {}); }
}
