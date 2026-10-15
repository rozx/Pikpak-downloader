## Context

平台适配集中在 `src/platform/` 与少数按 `process.platform` 分支的位置（凭据、任务库目录、打开浏览器与文件管理器、备份后同步目录）。

- macOS：Node-API 模块 `native/macos.mm` 提供目录句柄（`openat`、`mkdirat`、`renameatx_np(RENAME_EXCL)`、`fstatfs`）与剪贴板；凭据用 `Bun.secrets`（Keychain）。
- Windows：常驻 PowerShell 桥做句柄相对的目录操作，凭据与剪贴板也各有 PowerShell 脚本。

`LocalDirectory` 与 `LocalFile` 的语义由 macOS 实现确定：名称只能是单个路径分量；打开不跟随符号链接，不跨文件系统；文件必须是普通文件且只有一个硬链接；发布以不覆盖方式改名并同步两侧目录；身份由卷标识和文件标识组成，跨重启稳定。

## Goals / Non-Goals

**Goals:**
- Linux x64 与 arm64（glibc）发行产物可以完成登录、监听或粘贴、下载与发布的完整流程。
- 本地文件安全语义与 macOS 一致，复用现有的文件系统测试。
- 不引入需要在用户机器上编译的组件，单文件产物保持自包含。

**Non-Goals:**
- 不支持 musl 发行版：`bun-linux-*-musl` 目标与 glibc 的 libc 符号不同，暂不构建。
- 不为缺少 Secret Service 的环境（无图形会话的服务器）提供明文或文件形式的凭据保存。
- 不支持不提供 `RENAME_NOREPLACE` 的文件系统作为下载目录，不以“建链接再删除”模拟不覆盖改名。
- 不提供 Linux 安装包（deb、rpm、AppImage 等）。

## Decisions

### 1. 本地文件经 `bun:ffi` 调用 libc

可选方案：

| 方案 | 问题 |
| --- | --- |
| 像 macOS 一样编译 Node-API 模块 | 需要在 CI 为两种架构分别交叉编译，构建链更重 |
| `node:fs` 加 `/proc/self/fd/<fd>/<名称>` 模拟句柄相对路径 | 依赖 `/proc` 挂载；`node:fs` 没有不覆盖改名 |
| `bun:ffi` 打开 `libc.so.6` | 直接使用系统调用的原语，无需编译 |

采用 `bun:ffi`。只在 Linux 上首次使用时 `dlopen`，其他平台导入模块不触发加载。绑定的函数：

- `openat`、`mkdirat`、`close`、`fsync`。
- `statx`（glibc 2.28 起）：取文件类型、硬链接数、设备号、inode 与创建时间。结构布局与架构无关。
- `renameat2`（glibc 2.28 起）配合 `RENAME_NOREPLACE`：目标存在时返回 `EEXIST`，发布结果为 `false`。文件系统不支持该标志（`EINVAL`）时报错，不改用其他方式。
- `fstatfs`：可用空间为 `f_bavail × f_frsize`（`f_frsize` 为 0 时用 `f_bsize`），卷标识取 `f_fsid`。x64 与 arm64 的 glibc `struct statfs` 布局相同。
- `__errno_location`：调用失败后立即读取 errno，映射为与 macOS 相同的错误类别（`EEXIST`、`ENOENT`、`ENOSPC`、`EACCES`、`unsafe-path` 等）。

打开标志取运行时的 `fs.constants`（`O_DIRECTORY`、`O_NOFOLLOW` 在 x64 与 arm64 上取值不同），`O_CLOEXEC` 两种架构相同，写为常量。文件的数据读写、截断与同步沿用 macOS 的做法，用 `node:fs` 操作 `openat` 得到的描述符。

检查与 macOS 相同：

- 子目录与文件不得跨设备（`statx` 的设备号与根目录一致）。
- 文件必须是普通文件、硬链接数为 1。
- 新建子目录或发布后同步父目录。

### 2. 文件身份

- 卷标识：`f_fsid` 的十六进制。ext4、xfs、btrfs 由文件系统 UUID 派生，跨重启稳定；全零时报 `volume-identity-unavailable`，与 macOS 拒绝全零 UUID 一致。
- 文件标识：`<inode>:<创建秒>:<创建纳秒>`，取自 `statx` 的 `STATX_BTIME`。文件系统不提供创建时间时，两项写为 `0`，身份退化为 inode。inode 只在文件删除后才可能被复用，而工作区在复用前已经按名称与大小核对，风险可接受。

### 3. 剪贴板

Linux 没有系统级的剪贴板变更计数。每次读取启动一次外部命令：

- 设置了 `WAYLAND_DISPLAY`：`wl-paste --no-newline --type text`。
- 否则设置了 `DISPLAY`：依次尝试 `xclip -selection clipboard -out -target UTF8_STRING`、`xsel --clipboard --output`。
- 都没有：读取失败。

序号由适配器自己维护：文本与上次读到的不同才加一。因此重复复制同一段文字不算新事件；这与现有的按分享去重规则一致，不会漏掉新任务。

命令以非零状态退出（剪贴板为空、没有文本类型）时文本为 `null`。命令不存在或超过 5 秒未结束时读取失败，由 `pollClipboard` 退避重试并显示监听异常。输出超过 1 MiB 时按非文本处理，与 macOS 的上限一致。

### 4. 凭据

`Bun.secrets` 在 Linux 上通过 libsecret 访问 Secret Service，与 macOS 共用同一个实现（服务名 `com.rozx.pikpak-downloader`）。libsecret 缺失、没有会话总线或钥匙环被锁定时抛出 `credentials_unavailable`；文档说明需要安装并解锁 GNOME Keyring 或 KWallet。

### 5. 任务库目录、浏览器与文件管理器

- 任务库：`$XDG_DATA_HOME/PikpakDownloader`；变量未设置或不是绝对路径时用 `~/.local/share/PikpakDownloader`（XDG Base Directory 规范要求忽略相对路径）。`PIKPAK_DOWNLOADER_STATE_DIR` 仍然优先。
- 打开浏览器与下载目录：`xdg-open`，参数单独传递，不经过 shell。打不开浏览器时沿用现有提示，用户手动打开本地入口。
- 备份写入后同步所在目录：原来只在 macOS 上做，改为除 Windows 外都做。

### 6. 构建与发布

- `scripts/build.ts` 新增 `bun-linux-x64` 与 `bun-linux-arm64`，`process.platform` 编译期常量取 `linux`。
- 发布工作流新增 `ubuntu-latest`：运行 `bun run check` 后构建两个 Linux 产物，与 macOS、Windows 产物一起发布。

## Risks / Trade-offs

- [errno 读取] 两次 FFI 调用之间若运行时内部调用了 libc，errno 可能被改写 → 失败调用后立即读取，中间不执行 JS；读到的 errno 只用于选择错误类别，错误时最多给出不准确的原因，不会把失败当作成功。
- [文件系统兼容] FAT、exFAT 等文件系统可能不支持 `RENAME_NOREPLACE` 或硬链接计数异常 → 发布报错并保留临时文件，任务可以在更换下载目录后重试。
- [无图形会话] 服务器上没有 Secret Service 与剪贴板 → 凭据不可用时无法登录；剪贴板失败时提示监听异常，可用粘贴输入。文档明确列出依赖。
- [实机覆盖] CI 只在 x64 Ubuntu 上运行测试；arm64 产物只经过交叉编译，需要实机验收。
