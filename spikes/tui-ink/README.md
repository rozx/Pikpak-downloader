# Ink 打包验证

OpenSpec 变更 `add-interactive-tui` 任务 1.1/1.2 的隔离验证程序。它只验证 Ink 在 Bun 独立产物和目标终端中的能力，不接入业务代码、账号或分享资料。

## Run

```sh
bun install --frozen-lockfile
bun run typecheck
bun run start          # 直接从源码运行
bun run compile        # 编译四个目标到 dist/
bun compile.ts bun-windows-x64   # 只编译指定目标
```

界面底部的事件区会显示每次按键时 Ink 实际收到的原始输入（内容、长度、按键标志），以及粘贴内容的长度和行数，用于判断各终端的输入行为。

## Packaging Notes

- 依赖：`ink` 8.0.0、`react` 19.3.1（精确版本），Bun 1.4.2。Ink 8 自带 `alternateScreen`、`usePaste`（自动开启括号粘贴，粘贴内容不进入 `useInput`）、`useWindowSize`、`maxFps`、`incrementalRendering`。
- 必须用 `Bun.build` 加插件把可选依赖 `react-devtools-core` 换成空实现（见 `compile.ts`）。不能用 `--external`：Bun 会把外部 import 提升到产物顶层，程序一启动就报 "Cannot find package 'react-devtools-core'" 并退出，即使从未设置 `DEV=true`。
- 编译时关闭 `autoloadDotenv` 和 `autoloadBunfig`。独立产物默认会读取运行目录下的 `.env` 和 `bunfig.toml`，用户目录中的文件不应改变程序行为。
- Bun 1.3.8 不提供 `bun-windows-aarch64` 目标，并且在 Windows 上首次交叉编译 macOS 目标时可能报 "download may be incomplete"；使用项目声明的 Bun 1.4.2 后四个目标一次编译成功。

## Results（2026-10-14，Windows 11 x64 开发机）

| 目标 | 产物体积 |
| --- | --- |
| `bun-darwin-arm64` | 60.5 MiB |
| `bun-darwin-x64` | 67.3 MiB |
| `bun-windows-x64` | 83.2 MiB |
| `bun-windows-arm64` | 75.1 MiB |

同一 Bun 版本下，现有业务 CLI 的 windows-x64 产物为 82.3 MiB，Ink 与 React 约增加 1 MiB。windows-x64 产物已在 Claude Code 终端面板中启动：中日韩名称按显示宽度中间省略，进度条刷新正常，第一次 Ctrl+C 进入停止状态，3 秒后退出并恢复原屏幕。省略后名称会填满整列，正式界面的列之间需要保留 1 列间隔。

## Manual Checklist（任务 1.2）

分别在 Windows Terminal、Windows 传统控制台（conhost，例如直接双击运行或在 `conhost.exe` 中启动）和 macOS 终端运行编译产物，逐项记录：

1. 启动后进入备用屏幕；按 q 等待 3 秒退出后，启动前的终端内容完整恢复。
2. ↑↓、PgUp/PgDn 移动选中行，列表随选中项滚动，标题栏与底部区域保持可见。
3. 中文、日文、韩文和中英混排的名称按显示宽度中间省略，大小列与状态列对齐。
4. 按 a 打开输入框，粘贴包含空行的多行分享文本：事件区显示一次"粘贴 len=… 行=…"，粘贴过程中没有触发提交；再按 Enter 才提交。
5. 输入框里 Esc 返回；按 c 打开确认框，y 和 n 都有效。
6. 拖动改变窗口大小，界面立即重排；缩小到 60×15 以下显示放大提示，放大后恢复。
7. 下载中行的进度条持续刷新，没有明显闪烁，也没有向上滚动的残留行。
8. 按 Ctrl+C 进入"正在停止"，3 秒内再按一次 Ctrl+C 立即退出，终端恢复正常（光标可见，输入回显正常）。
9. 按 x 触发未处理异常，终端恢复并只显示一行说明。
10. 设置 `NO_COLOR=1` 后启动，界面没有颜色，状态仍可由图标与文字区分。
