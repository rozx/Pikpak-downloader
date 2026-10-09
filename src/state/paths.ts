import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { AppError } from "../errors";

export function stateRoot(environment = process.env, platform = process.platform): string {
  if (environment.PIKPAK_DOWNLOADER_STATE_DIR) return resolve(environment.PIKPAK_DOWNLOADER_STATE_DIR);
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "PikpakDownloader");
  if (platform === "win32" && environment.LOCALAPPDATA) return join(environment.LOCALAPPDATA, "PikpakDownloader");
  throw new AppError("unsupported_platform");
}

export async function prepareState(root = stateRoot()): Promise<{ root: string; database: string; lock: string }> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonical = await realpath(root);
  const database = join(canonical, "tasks.sqlite");
  try { const file = await open(database, "wx", 0o600); await file.close(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const info = await lstat(database);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new AppError("state_unavailable");
  return { root: canonical, database, lock: join(canonical, "queue-lock.sqlite") };
}
