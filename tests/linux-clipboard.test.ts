import { expect, test } from "bun:test";
import { clipboardCommands, commandRunner, LinuxClipboard, type Output, type Runner } from "../src/platform/linux-clipboard";
import { rejection } from "./fixtures/rejection";

function fakeRunner(respond: (command: string[]) => Output | "missing") {
  const calls: string[][] = [];
  const runner: Runner = async command => {
    calls.push(command);
    const output = respond(command);
    if (output === "missing") throw Error("ENOENT");
    return output;
  };
  return { runner, calls };
}
const text = (value: string): Output => ({ code: 0, data: Buffer.from(value) });

test("按图形会话选择命令：Wayland 用 wl-paste，X11 依次尝试 xclip 与 xsel，没有会话时不读取", () => {
  expect(clipboardCommands({ WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" })).toEqual([["wl-paste", "--no-newline", "--type", "text"]]);
  expect(clipboardCommands({ DISPLAY: ":0" }).map(command => command[0])).toEqual(["xclip", "xsel"]);
  expect(clipboardCommands({})).toEqual([]);
});

test("序号只在文本变化时增加，重复读到同一文本不算新事件", async () => {
  let current = "第一段";
  const { runner } = fakeRunner(() => text(current));
  const clipboard = new LinuxClipboard({ WAYLAND_DISPLAY: "wayland-0" }, runner);
  expect(await clipboard.read()).toEqual({ sequence: "1", text: "第一段" });
  expect(await clipboard.read()).toEqual({ sequence: "1", text: "第一段" });
  current = "https://mypikpak.com/s/synthetic";
  expect(await clipboard.read()).toEqual({ sequence: "2", text: "https://mypikpak.com/s/synthetic" });
});

test("空剪贴板、非零退出、超长输出与无效 UTF-8 都按没有文本处理", async () => {
  let output: Output = text("内容");
  const { runner } = fakeRunner(() => output);
  const clipboard = new LinuxClipboard({ WAYLAND_DISPLAY: "wayland-0" }, runner);
  expect((await clipboard.read())?.text).toBe("内容");
  output = { code: 1, data: Buffer.from("") };
  expect(await clipboard.read()).toEqual({ sequence: "2", text: null });
  output = { code: 0, data: null };
  expect(await clipboard.read()).toEqual({ sequence: "2", text: null });
  output = { code: 0, data: Buffer.from([0xff, 0xfe]) };
  expect(await clipboard.read()).toEqual({ sequence: "2", text: null });
  output = { code: 0, data: Buffer.from("") };
  expect(await clipboard.read()).toEqual({ sequence: "2", text: null });
});

test("xclip 缺失时改用 xsel 并记住；都缺失或没有图形会话时读取失败", async () => {
  const fallback = fakeRunner(command => command[0] === "xclip" ? "missing" : text("x11"));
  const clipboard = new LinuxClipboard({ DISPLAY: ":0" }, fallback.runner);
  expect((await clipboard.read())?.text).toBe("x11");
  expect((await clipboard.read())?.text).toBe("x11");
  expect(fallback.calls.map(command => command[0])).toEqual(["xclip", "xsel", "xsel"]);

  const missing = fakeRunner(() => "missing");
  expect((await rejection(new LinuxClipboard({ DISPLAY: ":0" }, missing.runner).read())).message).toBe("clipboard-unavailable");
  const headless = fakeRunner(() => text("never"));
  expect((await rejection(new LinuxClipboard({}, headless.runner).read())).message).toBe("clipboard-unavailable");
  expect(headless.calls).toHaveLength(0);
});

test.if(process.platform === "linux")("实际命令执行：返回输出与退出码，超过上限时终止并返回空数据，命令不存在或超时时抛出", async () => {
  expect(await commandRunner(["sh", "-c", "printf 'abc'"], 16, 5000)).toEqual({ code: 0, data: Buffer.from("abc") });
  expect((await commandRunner(["sh", "-c", "exit 3"], 16, 5000)).code).toBe(3);
  expect((await commandRunner(["sh", "-c", "head -c 100000 /dev/zero; sleep 5"], 1000, 5000)).data).toBeNull();
  await rejection(commandRunner(["pikpak-missing-clipboard-command"], 16, 5000));
  expect((await rejection(commandRunner(["sleep", "5"], 16, 100))).message).toBe("clipboard-command-timeout");
});
