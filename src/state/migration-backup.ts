import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function migrationBackup(source: Database, databasePath: string, version: bigint): void {
  const destination = `${databasePath}.backup-v${version}-${randomUUID()}.sqlite`;
  const temporary = `${destination}.tmp`;
  try {
    writeFileSync(temporary, source.serialize(), { flag: "wx", mode: 0o600 });
    const backup = new Database(temporary);
    try { backup.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; UPDATE metadata SET value='1' WHERE key='backup_review_required'"); }
    finally { backup.close(); }
    const file = openSync(temporary, "r+");
    try { fsyncSync(file); } finally { closeSync(file); }
    linkSync(temporary, destination);
    // Windows 不能打开目录句柄同步；其他平台同步目录，让新链接落盘。
    if (process.platform !== "win32") {
      const directory = openSync(dirname(destination), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } finally { try { unlinkSync(temporary); } catch {} }
}
