# PikPak Downloader

TypeScript + Bun 开发中的独立 CLI：监听完整分享文本，逐文件转存到 PikPak 云盘，再下载到本地。云盘作为中转空间，仅按需回收本工具已成功交付的副本。

目前已实现前台监听、持久化队列、逐文件下载、内容校验、恢复与按需云端回收。独立登录及真实业务单文件的转存、完整下载、落盘与完成记录验收已通过。**仍是开发版本：Windows、真实嵌套分享与综合故障场景尚未完成发布验收。**

## Development

固定 Bun 1.4.2、TypeScript 7.0.2、`@types/bun` 1.4.2：

```sh
bun install --frozen-lockfile
bun run check
bun run dev                   # 从源码运行并监视改动，保存后自动重启
bun run start --help          # 从源码运行一次，不监视改动
bun run build bun-darwin-arm64 bun-windows-x64 bun-linux-x64
bun scripts/preview-tui.tsx   # 用模拟数据预览全屏界面，不读写任务库
```

macOS 原生构建需要 Xcode Command Line Tools 和 Node-API 头文件；可用 `NODE_API_HEADERS` 指定头文件目录。发行二进制内含运行时与所需适配，使用者无需安装这些开发工具。

## Usage

在终端中不带参数运行即进入全屏界面：

```sh
./dist/pikpak-downloader-windows-x64.exe
```

首次启动会引导在浏览器中完成官方授权（界面内不输入密码）并选择下载目录，之后直接开始监听剪贴板。主面板按分享分组显示文件状态、进度、速度和剩余时间，列表按本地下载目录分组；名称前的图标表示文件在哪里：⧉ 本地与云端都有，▣ 只在本地，☁ 只在 PikPak 云盘，留空表示都不在；带 ⧉ 或 ☁ 的任务可以按 x 释放云端副本，常用按键：

| 按键 | 作用 |
| --- | --- |
| ↑↓ / ←→ / Enter | 选择、折叠或展开分享、查看文件详情 |
| r / c | 重试；取消（需确认，保留本地文件、断点和云端副本） |
| p / P | 暂停或继续选中的文件或分享；全部暂停，或在有任何暂停时全部开始（都在重启后保持） |
| x / X | 释放选中文件或分享的云端副本；X 释放全部已完成任务的云端副本（都需确认，永久删除 PikPak 中本工具创建的副本，本地文件保留）。已完成的任务随之删除记录、从列表消失；x 释放未完成的文件后，继续时从分享重新转存 |
| o / a / s | 打开下载目录；粘贴分享文本；设置下载目录、剪贴板监听、下载连接数与同时下载文件数 |
| q / Ctrl+C | 退出确认：y 或再按 Ctrl+C 停止并保存进度，n / Esc 返回；停止期间再按 Ctrl+C 立即退出 |

设置、粘贴、取消、暂停等操作在下载进行中立即生效，不必等当前文件完成；暂停或取消正在下载的文件会先在安全点保存断点。窗口至少需要 60×15；设置 `NO_COLOR` 可关闭颜色。输出被重定向或在脚本中运行时不会进入界面，可以使用下面的子命令。

子命令（以 macOS arm64 开发构建为例）：

```sh
./dist/pikpak-downloader-darwin-arm64 login
./dist/pikpak-downloader-darwin-arm64 watch --output "$HOME/Downloads"
```

`watch` 是纯文本的前台监听，进度每跨过 10% 或满 30 秒输出一行。看到接收确认后，任务会进入扫描、转存、下载和校验。按 Ctrl+C 停止后可操作：

```sh
./dist/pikpak-downloader-darwin-arm64 status
./dist/pikpak-downloader-darwin-arm64 retry <任务ID>
./dist/pikpak-downloader-darwin-arm64 cancel <任务ID>
./dist/pikpak-downloader-darwin-arm64 config --output "$HOME/Downloads"
./dist/pikpak-downloader-darwin-arm64 config --connections 6
./dist/pikpak-downloader-darwin-arm64 config --files 3
./dist/pikpak-downloader-darwin-arm64 logout
```

将 `<任务ID>` 替换为终端给出的分享或文件任务 ID。运行中的 `status` 只读可用，其余写命令需先停止监听。再次复制同一分享可发现新增/变化版本；单独复制提取码不会与旧输入拼接。取消保留资源，已完成版本的历史回收资格保持不变。

### Linux

Linux 产物为 `pikpak-downloader-linux-x64` 与 `pikpak-downloader-linux-arm64`，需要 glibc 2.28 及以上，不支持 Alpine 等 musl 发行版。运行依赖：

- 凭据：libsecret 与可用的 Secret Service（GNOME Keyring、KWallet 等），钥匙环需已解锁。没有可用服务时无法保存登录，程序不会改用明文。
- 剪贴板：Wayland 会话需要 `wl-paste`（wl-clipboard），X11 会话需要 `xclip` 或 `xsel`。没有图形会话或缺少命令时界面显示监听异常，可按 a 粘贴分享文本。
- 打开浏览器与下载目录：`xdg-open`。打不开时手动打开终端显示的本地入口。
- 下载目录所在的文件系统需要支持不覆盖改名（ext4、xfs、btrfs 等）；不支持时发布失败并保留临时文件。

任务库位于 `$XDG_DATA_HOME/PikpakDownloader`，未设置时位于 `~/.local/share/PikpakDownloader`。

参见[登录](docs/login.md)、[分享文本](docs/clipboard.md)、[下载恢复](docs/downloads.md)和[云端回收](docs/cloud-space.md)。

独立构建包含 Bun 运行时。Windows 构建成功不代表实际运行或原生适配通过；Linux 的测试在 x64 上通过，桌面实机与 arm64 运行尚待验收；真实多页嵌套与完整故障场景、Windows/其他架构运行分别保留 OpenSpec 任务 8.2、8.3 的发布验收。

状态与恢复边界见 [说明](docs/state-and-recovery.md)，脱敏可行性证据见 [设计](openspec/changes/archive/2026-10-15-add-clipboard-download-workflow/design.md)。

完整的实测、合成测试与待验收边界见[验收状态](docs/acceptance.md)。
