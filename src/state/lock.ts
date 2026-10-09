import { Database } from "bun:sqlite";
import { AppError } from "../errors";

// 独立锁库的 EXCLUSIVE 事务持有 SQLite 的系统文件锁；任务库不保持长事务。
export function acquireQueueLock(path: string): { release(): void } {
  const lock = new Database(path, { create: true });
  try {
    lock.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY)");
    lock.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    lock.close();
    if ((error as { code?: string }).code === "SQLITE_BUSY" || (error as { code?: string }).code === "SQLITE_LOCKED") {
      throw new AppError("instance_busy");
    }
    throw new AppError("state_unavailable");
  }
  let released = false;
  return { release() {
    if (released) return;
    released = true;
    try { lock.exec("ROLLBACK"); } finally { lock.close(); }
  } };
}
