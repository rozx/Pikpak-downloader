import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { stateRoot } from "../src/state/paths";

test("任务库目录：环境变量优先，Linux 遵循 XDG_DATA_HOME 且忽略相对路径", () => {
  expect(stateRoot({ PIKPAK_DOWNLOADER_STATE_DIR: "custom" }, "linux")).toBe(resolve("custom"));
  expect(stateRoot({ XDG_DATA_HOME: "/data/home" }, "linux")).toBe(join("/data/home", "PikpakDownloader"));
  expect(stateRoot({}, "linux")).toBe(join(homedir(), ".local", "share", "PikpakDownloader"));
  expect(stateRoot({ XDG_DATA_HOME: "relative/data" }, "linux")).toBe(join(homedir(), ".local", "share", "PikpakDownloader"));
  expect(stateRoot({}, "darwin")).toBe(join(homedir(), "Library", "Application Support", "PikpakDownloader"));
  expect(stateRoot({ LOCALAPPDATA: "C:\Users\a\AppData\Local" }, "win32")).toBe(join("C:\Users\a\AppData\Local", "PikpakDownloader"));
  expect(() => stateRoot({}, "freebsd")).toThrow();
});
