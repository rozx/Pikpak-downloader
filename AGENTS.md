# AGENTS.md

This file provides guidance to AI coding agents (Claude Code and others) when working with code in this repository.

PikPak DL CLI（仓库与可执行文件名 `pikpak-dl-cli`，2026-10-15 由 PikPak Downloader 改名）是 PikPak 分享下载器。它监听剪贴板（或接收粘贴）中的完整分享文本，把文件逐个转存到用户的 PikPak 云盘，再下载、校验并发布到本地。云盘只作中转空间，本工具创建的副本可以按需自动回收，也可以手动释放。

技术栈是 TypeScript 加 Bun 1.4.2；无参数启动时进入 Ink（React）实现的全屏终端界面。代码注释、文档、规格与界面文字都使用中文。

## 常用命令

```sh
bun install --frozen-lockfile
bun run check                                  # 原生模块（仅 macOS）+ 类型检查 + 全部测试；提交前确认输出 "0 fail"
bun run typecheck                              # tsc --noEmit：严格模式，覆盖 src/、tests/、scripts/
bun test tests/space.test.ts                   # 运行单个测试文件
bun test tests/tui-screens.test.tsx -t "全部释放"   # 按测试名过滤
bun run dev                                    # 从源码运行并监视改动，保存后自动重启；无参数且在交互终端中时进入全屏界面
bun run start --help                           # 从源码运行一次 CLI（src/cli.ts），不监视改动
bun scripts/preview-tui.tsx                    # 用模拟数据预览全屏界面，不读写任务库
bun scripts/screenshots.tsx                    # 用虚构数据重新生成 README 用的 docs/images/*.svg；界面改动后运行
bun run build bun-windows-x64                  # 单文件产物输出到 dist/；目标为 bun-{darwin,windows,linux}-{arm64,x64}，默认取当前平台
```

- 改名只涉及对外名称。任务库目录 `PikpakDownloader`、凭据条目 `com.rozx.pikpak-downloader` 与环境变量 `PIKPAK_DOWNLOADER_STATE_DIR` 沿用旧名，已有任务与登录才能继续使用；不要改这些名字。
- `PIKPAK_DOWNLOADER_STATE_DIR` 用来另指任务库与锁所在的目录，测试与本地试验时使用。默认目录：macOS 为 `~/Library/Application Support/PikpakDownloader`，Windows 为 `%LOCALAPPDATA%\PikpakDownloader`，Linux 为 `$XDG_DATA_HOME/PikpakDownloader`（未设置时为 `~/.local/share/PikpakDownloader`）。
- 构建 macOS 原生模块（`native/macos.mm`）需要 Xcode Command Line Tools 与 Node-API 头文件，头文件目录可用 `NODE_API_HEADERS` 指定。
- Windows 产物的图标由 `scripts/icon.ts` 从 24×24 像素图生成 ICO（写到 `dist/icon.ico`），连同名称、发布者、版本经 `Bun.build` 的 `compile.windows` 写入；改图标就改其中的字符图。macOS 与 Linux 的可执行文件无法内嵌图标。

## 工作方式

- 需求变更走 OpenSpec（spec-driven），流程：
  1. 在 `openspec/changes/<name>/` 写 proposal、design、specs 与 tasks。
  2. 实现时逐项勾选 `tasks.md`。
  3. 完成后执行 `openspec archive <name> --yes`，把规格增量合并进 `openspec/specs/`。
  - 规格与任务用中文书写，结构标题与 SHALL/MUST 关键字保持英文（见 `openspec/config.yaml`）。
  - 校验命令：`openspec validate <name> --strict`。
  - 计划只写在变更的 `tasks.md` 里，不另建计划文档。
- 直接提交到 main，标题采用 conventional commits 风格。
- 记得升级版本号。版本只有一个来源：`package.json` 的 `version`，CLI `--version`、界面标题与 `src/about.ts` 都读它。
  - 新功能升次版本号，修复升修订号（当前处于 0.x 阶段）。
  - 用单独的 `chore: bump version to x.y.z` 提交记录。
  - `tests/lifecycle.test.ts` 直接读取 `package.json`，升级版本号不用改测试。
- 发布用 `release-ready` 技能（`.claude/skills/release-ready/`，`.agents/skills/release-ready` 是指向它的符号链接）：
  - 在 `release/x.y.z` 分支上核对版本，写 `docs/releaseNotes/vx.y.z.md`，更新文档，创建带 `release` 标签的 PR。这是“直接提交到 main”的唯一例外。
  - PR 合并后，`.github/workflows/release.yml` 在三个平台上检查并构建，以该发布说明为正文创建 `vx.y.z` 的 Release；发布说明缺失时拒绝发布。
- 分享链接、提取码、令牌和签名下载地址不得出现在输出、日志、事件或测试快照里。凭据只存放在系统受保护存储中，任务库只保存引用。

## 架构

数据流：

1. `intake/` 解析剪贴板或粘贴的文本，经 `auth/share-access.ts` 把提取码存入系统凭据库，并写入任务库。
2. `runtime/session.ts` 的 `RuntimeSession` 是唯一的调度点。
3. `runtime/engine.ts` 的 `Engine.step` 推进任务：`pikpak/` 负责扫描、转存与空间，`download/` 负责工作区、下载、校验与发布。
4. `tui/` 把任务库快照与运行事件呈现给用户。

### 任务库与外部操作

- `state/store.ts` 是 SQLite 任务库，开启 WAL、`synchronous=FULL` 与外键。
  - 结构版本与迁移在 `state/schema.ts`：升级前先做一致性备份，程序拒绝写入更高版本的任务库。
  - 文件状态机在 `state/model.ts`，由 `edges` 与 `assertTransition` 约束。
  - 大小以十进制字符串存储，读出后为 `bigint`。
  - `store.transaction` 的回调必须是同步的，网络与凭据调用不能放进去。
- 单实例互斥靠单独的 `queue-lock.sqlite`（`state/lock.ts`）。运行中仍可用 `status` 只读查询任务库。
- 转存（restore）、删除（delete）、发布（publish）这三类外部操作都先在 `operations` 表写入意图：
  - 请求在 `beforeSend` 回调里同步标记 `sent`，发出后按任务 ID 或远端元数据核对结果。
  - 结果不明时标为 `attention`，由启动时的 `Engine.reconcile` 处理，不会盲目重发。
- 副本可以被删除的前提是 `pikpak/ownership.ts` 的创建证据，即转存任务、精确来源映射、时序与 GCID；删除前还要用 `unchangedOwnedCopy` 重新核对远端元数据。删除有两条路径：
  - 自动回收 `SpaceManager.ensure`：按需触发、最旧优先，并等待云盘容量反映释放。
  - 手动或全部释放 `SpaceManager.releaseMany`：批量删除，以副本不可见为准确认。
  - 两者共用 `Engine` 内的云端操作锁。已完成任务的副本释放后，任务记录随之删除（`store.forgetFile` / `forgetShare`）。

### 会话与引擎

- `RuntimeSession.command` 把命令分为两类：
  - 中断类：暂停队列，以及目标正是当前串行步骤的暂停或取消。它们进入队列，先中断当前步骤再执行。
  - 其余命令：在一条串行 Promise 链上立即执行。
- `Engine.step` 的串行部分依次做：扫描、选文件、副本检查、空间计划与转存。
- 之后的下载、校验与发布分两种情况：
  - 同时下载数为 1 时，在本步内完成。
  - 否则交给下载池。池的容量 `capacity()` 取配置值与账号等级上限中较小的一个，等级见 `pikpak/tier.ts`。
- `stopActive` 让池中文件在安全点停下并保存检查点。

### 本地文件与下载

- 所有本地写入都经过 `download/workspace.ts` 的 `FileWorkspace`：
  - 基于目录句柄的相对路径操作，并记录、核对目录与文件身份，路径不能逃出下载根。
  - 名称映射与冲突后缀在 `names.ts`。任务目录使用 `taskName`，即去掉文件后缀的分享标题。
  - 临时文件命名为 `<名称>.pikpak-part`，与目标位于同一目录；`publish.ts` 以不覆盖方式改名发布，并支持核对恢复。
- `download/transfer.ts` 在两条路径中选择：
  - 分段下载：`segmented.ts`、`chunks.ts`、`range-worker.ts`，条件是文件大于 8 MiB 且连接数大于 1。
  - 顺序下载。
  - 检查点由连续已验证前缀加最多 16 个区间组成（`state/ranges.ts`），保存前先 sync 再读回核对。下载完成后做 GCID 校验。

### 平台适配（`platform/`）

- `files.ts` 定义基于句柄的 `LocalDirectory` 与 `LocalFile` 接口。
  - macOS 使用由 `native/macos.mm` 编译的 Node-API 模块。
  - Windows 使用常驻的 PowerShell 桥（`windows-files.ps1` 加 `process-bridge.ts`）做句柄相对的目录操作；文件身份核对通过后，数据读写改走 node:fs 文件描述符。
  - Linux 经 `bun:ffi` 直接调用 glibc（`linux-files.ts`：`openat`、`statx`、`renameat2(RENAME_NOREPLACE)`、`fstatfs`），语义与 macOS 相同。
- 剪贴板与凭据按平台实现：
  - 凭据在 macOS 与 Linux 上用 `Bun.secrets`（Keychain、Secret Service），Windows 用 PowerShell 脚本。
  - Linux 剪贴板调用 `wl-paste`、`xclip` 或 `xsel`，序号在文本变化时自增。
- 发行产物的入口是 `src/main.ts`：`Bun.build` 编译后入口模块的 `import.meta.main` 为 false，所以不能依赖 `cli.ts` 自身的入口判断。

### 界面（`tui/`）

- `controller.ts` 的 `TuiController` 接口把界面与运行时隔开。
- `live.ts` 的 `LiveController` 从任务库重建快照（节流刷新），并把会话事件交给 `view-model.ts` 的 `describeEvent`。
- `view-model.ts` 是纯逻辑：列表行、按下载目录分组、状态外观、原因说明与位置图标。`app.tsx` 负责按键与页面切换，`main-panel.tsx`、`pages.tsx`、`parts.tsx` 负责渲染。
- 宽度按终端显示宽度（`Bun.stringWidth`）计算。界面只用单宽文本符号，不用 emoji，因为 emoji 在 Windows Terminal 中显示错位。100 列宽的窗口必须放得下整行按键提示。

## 测试

- 涉及真实文件系统的测试用 `test.if(nativeFiles)` 标注，在 macOS、Windows 与 Linux 上运行；Windows 上会启动 PowerShell 桥。
- 假 PikPak 服务有两处：
  - `tests/fixtures/engine.ts`：引擎与会话的端到端测试。
  - `tests/space.test.ts` 内的夹具：空间回收与释放。
- 界面测试用 `tests/fixtures/tui.ts` 的 `FakeController` 配合 `ink-testing-library`，在固定窗口尺寸下断言帧文本。
- 不要用 `expect(promise).rejects`：在 Windows 上，Bun 1.4.2 等待时会停止读取文件桥的输出，导致测试挂起。改用 `tests/fixtures/rejection.ts` 的 `rejection()`。
- 在 Windows 上验证 Linux：`bun run build bun-linux-x64` 后把产物复制到 WSL，用 `BUN_BE_BUN=1 <产物> test tests` 把它当作 bun 运行测试。WSL 的墙钟会跳变，依赖 `Date.now()` 的等待（如 `until()`）可能偶发超时，以 CI 的 Ubuntu 结果为准。
