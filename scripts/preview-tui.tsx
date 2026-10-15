// 正式界面预览：用模拟数据渲染启动画面与主面板，只用于在真实终端中查看观感，不读写任务库。
// 用法：bun scripts/preview-tui.tsx [启动画面停留毫秒数，默认 3000]
import { render } from "ink";
import { StartupApp, type StartupDeps } from "../src/tui/startup";
import { FakeController } from "../tests/fixtures/tui";

const splashMs = Number(process.argv[2] ?? 3000);
const deps: StartupDeps = {
  busy: false, account: async () => "preview", outputRoot: async () => "C:\\Users\\demo\\Downloads\\PikPak-Test",
  defaultOutputRoot: "C:\\Users\\demo\\Downloads\\PikPak", login: async () => "preview", saveOutputRoot: async () => ({ ok: true }),
  start: async () => {
    const controller = new FakeController();
    controller.stop = () => { instance.unmount(); process.exit(0); };
    return controller;
  },
  exit: code => { instance.unmount(); process.exit(code); },
};
const instance = render(<StartupApp deps={deps} splashMs={splashMs} />, { exitOnCtrlC: false, alternateScreen: true, maxFps: 10 });
