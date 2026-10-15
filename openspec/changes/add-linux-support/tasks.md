## 1. 平台分支

- [x] 1.1 `state/paths.ts` 增加 Linux 任务库目录（`$XDG_DATA_HOME` 为绝对路径时使用，否则 `~/.local/share`）。验收：单元测试覆盖已设置、未设置与相对路径三种情况。
- [x] 1.2 `auth/secrets.ts` 的 `Bun.secrets` 实现改名为 `SystemSecrets`，macOS 与 Linux 共用。验收：Linux 上 `systemSecrets()` 不再抛出 `unsupported_platform`，类型检查通过。
- [x] 1.3 `auth/login.ts` 与 `tui/open-directory.ts` 在 Linux 上使用 `xdg-open`；备份后同步目录改为除 Windows 外都做。验收：`directoryCommand("linux", …)` 返回 `xdg-open`，不支持的平台仍返回 `unsupported_platform`。

## 2. 本地文件

- [x] 2.1 新增 `platform/linux-files.ts`：经 `bun:ffi` 绑定 libc，实现 `LocalDirectory` 与 `LocalFile`（目录句柄、身份、可用空间、不覆盖发布、目录同步），`file-system.ts` 在 Linux 上返回它。验收：`local-files.test.ts` 在 Linux 上通过，含符号链接逃逸与覆盖发布被拒绝。
- [x] 2.2 涉及真实文件系统的测试（`nativeFiles`）在 Linux 上运行。验收：在 Linux（WSL Ubuntu）上 `bun test` 全部通过。

## 3. 剪贴板

- [x] 3.1 新增 `platform/linux-clipboard.ts`：按 Wayland 或 X11 选择命令，自维护序号，超时、超长与命令缺失的处理；`clipboard.ts` 在 Linux 上返回它。验收：单元测试用注入的命令执行器覆盖内容变化计数、空剪贴板、命令缺失、超长输出与无图形会话。

## 4. 构建与发布

- [x] 4.1 `scripts/build.ts` 新增 `bun-linux-x64` 与 `bun-linux-arm64`。验收：在 Windows 上交叉构建出两个 Linux 产物，x64 产物在 WSL 中能打印 `--version` 与帮助。
- [x] 4.2 发布工作流新增 Ubuntu 构建：运行 `bun run check` 并构建、上传 Linux 产物。验收：工作流 YAML 解析通过，发布步骤包含六个产物与校验和。

## 5. 文档与验收

- [x] 5.1 更新 README 与 `docs/login.md`：Linux 产物、依赖（Secret Service、`wl-paste`/`xclip`/`xsel`、`xdg-open`）与任务库位置。验收：`bun run check` 输出 0 fail，`openspec validate add-linux-support --strict` 通过。
- [ ] 5.2 Linux 桌面实机验收：登录、剪贴板监听、下载与发布。arm64 产物实机运行。验收：结果写入 `design.md`。
