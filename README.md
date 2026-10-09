# PikPak Downloader

TypeScript + Bun 开发中的独立 CLI：监听完整分享文本，逐文件转存到 PikPak 云盘，再下载到本地。云盘作为中转空间，仅按需回收本工具已成功交付的副本。

目前已实现前台监听、持久化队列、逐文件下载、内容校验、恢复与按需云端回收。独立登录及真实业务单文件的转存、完整下载、落盘与完成记录验收已通过。**仍是开发版本：Windows、真实嵌套分享与综合故障场景尚未完成发布验收。**

## Development

固定 Bun 1.4.2、TypeScript 7.0.2、`@types/bun` 1.4.2：

```sh
bun install --frozen-lockfile
bun run check
bun run dev --help
bun run build bun-darwin-arm64 bun-windows-x64
```

macOS 原生构建需要 Xcode Command Line Tools 和 Node-API 头文件；可用 `NODE_API_HEADERS` 指定头文件目录。发行二进制内含运行时与所需适配，使用者无需安装这些开发工具。

## Usage

macOS arm64 开发构建：

```sh
./dist/pikpak-downloader-darwin-arm64 login
./dist/pikpak-downloader-darwin-arm64 watch --output "$HOME/Downloads"
```

看到接收确认后，任务会进入扫描、转存、下载和校验。按 Ctrl+C 停止后可操作：

```sh
./dist/pikpak-downloader-darwin-arm64 status
./dist/pikpak-downloader-darwin-arm64 retry <任务ID>
./dist/pikpak-downloader-darwin-arm64 cancel <任务ID>
./dist/pikpak-downloader-darwin-arm64 config --output "$HOME/Downloads"
./dist/pikpak-downloader-darwin-arm64 logout
```

将 `<任务ID>` 替换为终端给出的分享或文件任务 ID。运行中的 `status` 只读可用，其余写命令需先停止监听。再次复制同一分享可发现新增/变化版本；单独复制提取码不会与旧输入拼接。取消保留资源，已完成版本的历史回收资格保持不变。

参见[登录](docs/login.md)、[分享文本](docs/clipboard.md)、[下载恢复](docs/downloads.md)和[云端回收](docs/cloud-space.md)。

独立构建包含 Bun 运行时。Windows 构建成功不代表实际运行或原生适配通过；真实多页嵌套与完整故障场景、Windows/其他架构运行分别保留 OpenSpec 任务 8.2、8.3 的发布验收。

状态与恢复边界见 [说明](docs/state-and-recovery.md)，脱敏可行性证据见 [设计](openspec/changes/add-clipboard-download-workflow/design.md)。`spikes/` 是隔离验证程序，测试资料只从本机系统凭据库读取，不提交真实分享或凭据。

完整的实测、合成测试与待验收边界见[验收状态](docs/acceptance.md)。
