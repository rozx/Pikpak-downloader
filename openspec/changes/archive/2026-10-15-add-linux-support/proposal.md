## Why

发行产物只有 macOS 与 Windows。Linux 用户无法使用：凭据库、基于句柄的本地文件操作、剪贴板、任务库目录、打开浏览器与文件管理器都只有这两个平台的实现，在 Linux 上直接报“当前平台尚无经过验证的运行适配”。发布工作流也因此只能构建两个平台。

## What Changes

- 新增 Linux（glibc，x64 与 arm64）运行适配：
  - 凭据：使用 `Bun.secrets`，由 libsecret 接入 Secret Service（GNOME Keyring、KWallet 等）。服务不可用时报告凭据存储不可用，不退回明文。
  - 本地文件：经 `bun:ffi` 直接调用 libc 的 `openat`、`mkdirat`、`statx`、`renameat2`、`fstatfs`，保持与 macOS 相同的目录句柄约束、身份核对与不覆盖发布语义。
  - 剪贴板：Wayland 下调用 `wl-paste`，X11 下调用 `xclip` 或 `xsel`；没有图形会话或工具缺失时按剪贴板故障处理，粘贴输入照常可用。
  - 任务库目录：`$XDG_DATA_HOME/PikpakDownloader`，未设置时为 `~/.local/share/PikpakDownloader`。
  - 打开浏览器与下载目录：`xdg-open`。
- 构建脚本新增 `bun-linux-x64` 与 `bun-linux-arm64` 目标。
- 发布工作流在 Ubuntu 上运行检查与测试，并构建、发布 Linux 产物。
- 涉及真实文件系统的测试在 Linux 上同样运行。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `cli-runtime`：发行产物增加 Linux。
- `clipboard-intake`：剪贴板监听增加 Linux（Wayland 与 X11）。
- `share-downloads`：跨平台路径约束覆盖 Linux。
- `terminal-ui`：无参数进入界面的场景覆盖 Linux 终端。

## Impact

- `src/platform/`：新增 `linux-files.ts`（libc 绑定与目录句柄）、`linux-clipboard.ts`；`file-system.ts`、`clipboard.ts` 按平台分派。
- `src/auth/secrets.ts`：macOS 与 Linux 共用基于 `Bun.secrets` 的实现。
- `src/auth/login.ts`、`src/tui/open-directory.ts`、`src/state/paths.ts`、`src/state/backup.ts`、`src/state/migration-backup.ts`：增加 Linux 分支。
- `scripts/build.ts`、`.github/workflows/release.yml`：Linux 目标。
- 测试：`nativeFiles` 覆盖 Linux，新增 Linux 适配的单元测试。
- 文档：README 与 `docs/login.md` 说明 Linux 的依赖与用法。
- 不支持 musl 发行版（Alpine 等），不支持不提供 `RENAME_NOREPLACE` 的文件系统作为下载目录。
