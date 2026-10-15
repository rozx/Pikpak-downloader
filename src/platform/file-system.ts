import { AppError } from "../errors";
import { linuxFileSystem } from "./linux-files";
import { macFileSystem } from "./mac-files";
import { windowsFileSystem } from "./windows-files";
import type { LocalFileSystem } from "./files";
export function systemFiles(): LocalFileSystem {
  if (process.platform === "darwin") return macFileSystem;
  if (process.platform === "win32") return windowsFileSystem();
  if (process.platform === "linux") return linuxFileSystem;
  throw new AppError("unsupported_platform");
}
