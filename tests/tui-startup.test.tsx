import { afterEach, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { AppError } from "../src/errors";
import { StartupApp, type StartupDeps } from "../src/tui/startup";
import { createTheme } from "../src/tui/theme";
import { login } from "../src/auth/login";
import { FakeController, eventually, keys, settle, stripAnsi } from "./fixtures/tui";
import { about } from "../src/about";
import { LOGO, SUBTITLE } from "../src/tui/brand";
import type { Size } from "../src/tui/main-panel";
import { rejection } from "./fixtures/rejection";

const mounted: Array<() => void> = [];
afterEach(() => { for (const unmount of mounted.splice(0)) unmount(); });
function fakeDeps(overrides: Partial<StartupDeps> = {}) {
  const calls = { exits: [] as number[], logins: 0, saved: [] as string[], started: [] as string[], signal: null as AbortSignal | null };
  const deps: StartupDeps = { busy: false, account: async () => "account", outputRoot: async () => "D:\\Downloads\\PikPak", defaultOutputRoot: "C:\\Users\\demo\\Downloads\\PikPak",
    login: async (announce, signal) => {
      calls.logins++; calls.signal = signal; announce("请在浏览器完成登录。本地入口：http://127.0.0.1:53683");
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new AppError("authorization_failed")), { once: true }));
    },
    saveOutputRoot: async path => { calls.saved.push(path); return { ok: true }; },
    start: async account => { calls.started.push(account); return new FakeController(); },
    exit: code => { calls.exits.push(code); }, ...overrides };
  return { deps, calls };
}
function mount(deps: StartupDeps, { size = { columns: 100, rows: 24 }, splashMs = 0 }: { size?: Size; splashMs?: number } = {}) {
  const app = render(<StartupApp deps={deps} theme={createTheme({ NO_COLOR: "1" })} size={size} splashMs={splashMs} />);
  mounted.push(app.unmount);
  return { frame: () => stripAnsi(app.lastFrame() ?? ""), press: async (...inputs: string[]) => { for (const input of inputs) { app.stdin.write(input); await settle(); } } };
}

test("已有实例时只提示并在按键后退出，不触碰登录与任务库", async () => {
  const { deps, calls } = fakeDeps({ busy: true, account: async () => { throw Error("must-not-read"); } });
  const { frame, press } = mount(deps);
  await eventually(() => { expect(frame()).toContain("已有实例正在使用任务库"); expect(frame()).toContain("按任意键退出"); });
  // 按键可能早于输入监听生效；重复按键直到退出被记录。
  await eventually(async () => { if (!calls.exits.length) await press("x"); expect(calls.exits[0]).toBe(1); });
  expect(calls.logins).toBe(0);
});

test("已登录且目录可用时直接进入主面板", async () => {
  const { deps, calls } = fakeDeps();
  const { frame } = mount(deps);
  await eventually(() => { expect(calls.started).toEqual(["account"]); expect(frame()).toContain("PikPak DL CLI"); expect(frame()).toContain("Enter 详情"); });
});

test("未登录：Enter 打开浏览器授权并显示本地入口，Esc 取消授权；界面内没有密码输入", async () => {
  const { deps, calls } = fakeDeps({ account: async () => null });
  const { frame, press } = mount(deps);
  await eventually(() => { expect(frame()).toContain("尚未登录"); expect(frame()).toContain("按 Enter 在浏览器中打开 PikPak 官方授权页"); });
  expect(frame()).not.toMatch(/密码[:：]/);
  await eventually(async () => { if (!calls.logins) await press(keys.enter); expect(calls.logins).toBe(1); });
  await eventually(() => { expect(frame()).toContain("正在等待浏览器授权"); expect(frame()).toContain("http://127.0.0.1:53683"); });
  await press(keys.escape);
  await eventually(() => { expect(calls.signal?.aborted).toBe(true); expect(frame()).toContain("✗ 已取消授权"); });
  await eventually(async () => { if (!calls.exits.length) await press(keys.escape); expect(calls.exits).toEqual([0]); });
});

test("授权成功后检查目录：缺失时进入首次设置，保存失败显示原因，成功后进入主面板", async () => {
  let saves = 0;
  const { deps, calls } = fakeDeps({ account: async () => null, outputRoot: async () => null,
    login: async () => "account", saveOutputRoot: async path => { calls.saved.push(path); return ++saves === 1 ? { ok: false, reason: "output_unavailable" } : { ok: true }; } });
  const { frame, press } = mount(deps);
  await eventually(() => expect(frame()).toContain("尚未登录"));
  await eventually(async () => { if (!frame().includes("首次设置")) await press(keys.enter); expect(frame()).toContain("首次设置"); });
  expect(frame()).toContain("首次设置"); expect(frame()).toContain("C:\\Users\\demo\\Downloads\\PikPak▌"); expect(frame()).toContain("目录不存在时会自动创建");
  await press(keys.enter);
  await eventually(() => { expect(calls.saved).toEqual(["C:\\Users\\demo\\Downloads\\PikPak"]); expect(frame()).toContain("✗ 下载目录不可用或不可写"); });
  await press(keys.backspace, keys.backspace, "\x1b[200~X\r\n\x1b[201~", keys.enter);
  await eventually(() => { expect(calls.saved.at(-1)).toBe("C:\\Users\\demo\\Downloads\\PikPX"); expect(calls.started).toEqual(["account"]); expect(frame()).toContain("Enter 详情"); });
});

test("启动时会话失效回到登录页，其他启动失败显示原因并按键退出", async () => {
  const expired = fakeDeps({ start: async () => { throw new AppError("login_required"); } });
  const first = mount(expired.deps);
  await eventually(() => expect(first.frame()).toContain("登录已失效，请重新授权"));
  const broken = fakeDeps({ start: async () => { throw new AppError("state_unavailable"); } });
  const second = mount(broken.deps);
  await eventually(() => expect(second.frame()).toContain("任务库不可用"));
  await eventually(async () => { if (!broken.calls.exits.length) await second.press("x"); expect(broken.calls.exits[0]).toBe(1); });
});

test("取消浏览器授权后本地回调端口立即释放", async () => {
  const port = 53000 + Math.floor(Math.random() * 900);
  const session = { existingLogin: async () => null, accept: async () => "account",
    client: async () => ({ clientId: "client", clientSecret: "secret", redirectUri: `http://127.0.0.1:${port}/callback`, authMethod: "client_secret_post" as const }) };
  const controller = new AbortController(); const announced: string[] = [];
  const pending = login(session, true, message => { announced.push(message); }, { signal: controller.signal, openBrowser: async () => {} });
  await Bun.sleep(50);
  expect(announced[0]).toContain(`http://127.0.0.1:${port}`);
  controller.abort();
  expect((await rejection(pending)).message).toContain("授权");
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") });
  server.stop(true);
});

test("不带参数且输出被重定向时打印纯文本帮助，不含控制序列", async () => {
  const child = Bun.spawn([process.execPath, "src/cli.ts"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.end();
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(code).toBe(0); expect(output).toContain("在交互终端中打开全屏界面"); expect(output).toContain("watch [--output <目录>]");
  expect(output).not.toContain("\x1b");
});

test("启动检查画面显示标志、版本、作者与项目地址，并至少保留设定时长", async () => {
  const { deps, calls } = fakeDeps();
  const { frame } = mount(deps, { size: { columns: 100, rows: 30 }, splashMs: 300 }); await settle();
  const text = frame();
  for (const part of [LOGO[0]!, LOGO[5]!, SUBTITLE, `v${about.version}`, `作者 ${about.author}`, about.site, "正在检查登录状态与下载目录"]) expect(text).toContain(part);
  expect(calls.started).toEqual([]);
  await Bun.sleep(400); await settle();
  expect(calls.started).toEqual(["account"]); expect(frame()).toContain("Enter 详情");
});

test("窗口不足 60×24 时启动画面改为单行标题，登录提示仍然可见", async () => {
  const { deps } = fakeDeps({ account: async () => null });
  const { frame } = mount(deps, { size: { columns: 100, rows: 20 } }); await settle();
  const text = frame();
  expect(text).not.toContain(LOGO[0]!); expect(text).toContain(about.name); expect(text).toContain(about.site);
  expect(text).toContain("按 Enter 在浏览器中打开 PikPak 官方授权页"); expect(text).toContain("Esc 退出");
});


// 按键可能早于输入监听生效：重复按键直到进入账号页。
async function openAccount(frame: () => string, press: (...inputs: string[]) => Promise<void>) {
  await eventually(async () => { if (!frame().includes("Enter 查看")) await press("s"); expect(frame()).toContain("Enter 查看"); });
  await eventually(async () => { if (!frame().includes("r 重新授权")) await press(keys.enter); expect(frame()).toContain("r 重新授权"); });
}

test("启动时已保存的授权缺少必须的权限：提示重新授权，Esc 暂时继续使用", async () => {
  const { deps, calls } = fakeDeps({ missing: async () => ["管理文件"] });
  const { frame, press } = mount(deps);
  await eventually(() => { expect(frame()).toContain("当前授权缺少必须的权限"); expect(frame()).toContain("✗ 缺少：管理文件"); });
  expect(frame()).toContain("请全部勾选（必须：账号信息、管理文件、分享）"); expect(frame()).toContain("Esc 返回，继续使用当前授权");
  expect(calls.started).toEqual([]);
  await eventually(async () => { if (!calls.started.length) await press(keys.escape); expect(calls.started).toEqual(["account"]); });
  expect(calls.exits).toEqual([]);
});

test("账号页登出：先停止执行再清除令牌，回到登录页", async () => {
  const order: string[] = [];
  const { deps, calls } = fakeDeps({ suspend: async () => { order.push("suspend"); }, logout: async () => { order.push("logout"); } });
  const { frame, press } = mount(deps);
  await openAccount(frame, press);
  await press("l", "y");
  await eventually(() => { expect(order).toEqual(["suspend", "logout"]); expect(frame()).toContain("已登出"); expect(frame()).toContain("Esc 退出"); });
  await eventually(async () => { if (!calls.logins) await press(keys.enter); expect(calls.logins).toBe(1); });
});

test("账号页重新授权：停止执行后立即授权，取消后 Esc 回到原账号；停止超时显示失败", async () => {
  let suspends = 0;
  const { deps, calls } = fakeDeps({ suspend: async () => { suspends++; } });
  const { frame, press } = mount(deps);
  await openAccount(frame, press);
  await press("r");
  await eventually(() => { expect(suspends).toBe(1); expect(calls.logins).toBe(1); expect(frame()).toContain("重新授权"); expect(frame()).toContain("正在等待浏览器授权"); });
  await eventually(async () => { if (!calls.signal?.aborted) await press(keys.escape); expect(frame()).toContain("✗ 已取消授权"); });
  expect(frame()).toContain("Esc 返回，继续使用当前授权");
  await eventually(async () => { if (calls.started.length < 2) await press(keys.escape); expect(calls.started).toEqual(["account", "account"]); });
  const stuck = fakeDeps({ suspend: async () => { throw Error("suspend-timeout"); } });
  const second = mount(stuck.deps);
  await openAccount(second.frame, second.press);
  await second.press("r");
  await eventually(() => expect(second.frame()).toContain("当前下载未能及时停止"));
  expect(stuck.calls.logins).toBe(0);
});
