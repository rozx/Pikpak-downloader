# 登录与重新授权

当前业务流程仍在开发。macOS 登录可用于开发验证；Windows 凭据桥接已有实现但未实测，不代表完整 Windows 支持。

运行 `pikpak-downloader login`。有有效会话时会核对服务端身份和容量；否则打开本地入口，引导到 PikPak 官方页面授权。密码只在官方页面输入。授权码通过本机回调返回，程序使用 PKCE S256、一次性 state 和服务端账号身份核对，令牌进入系统凭据库。

本地端口被占用时关闭旧的本工具登录窗口对应进程，再重试；自动打开浏览器失败时可手动打开终端显示的本地入口。不要向聊天、终端参数或配置文件粘贴账号密码。官方页面要求额外验证时，请在该页面完成；程序不绕过验证，也不无限重试授权错误。

PikPak 授权页会逐项列出应用权限，请全部勾选。必须勾选的是账号信息（`account`）、管理文件（`files:manage`）和分享（`share`）；云下载（`cloud_download`）本工具暂不使用，建议一并勾选。授权返回后，程序先核对服务端授予的授权范围：缺少必须的权限时不保存这次授权，浏览器页面列出缺少的权限并提供“重新授权”按钮，终端同步提示，登录继续等待。服务端没有返回授权范围，或返回的范围不含任何应用权限时，显示“无法确认”，不阻止登录。运行 `pikpak-downloader permissions` 可以查看服务端返回的授权范围与判定。

全屏界面的设置页第一项是“账号”。按 Enter 进入账号页，查看账号名称、邮箱与 ID，会员状态及到期日期，云盘容量，以及每项权限是否已授予。在账号页按 `r` 重新授权，按 `l` 登出（需确认）。两者都会先在安全点停止当前下载并保存进度；重新授权取消后按 Esc 回到原账号。启动时已保存的授权缺少必须的权限，界面会提示重新授权，也可以按 Esc 暂时继续使用。

`login --force` 重新进行浏览器授权。当前浏览器路径已经通过前期实测，因此没有启用未验证的账号密码备选路径。权限拒绝或刷新失败时，先停止 `watch`，再重新登录；身份与容量读取通过不保证当前账号必然拥有永久删除权限，具体操作拒绝仍会暂停执行。

`logout` 清除认证令牌，保留账号任务、分享资料和本地成果。再次登录同一账号后可以恢复；登录不同账号不能执行或删除旧账号的资源。

Windows 发行候选的对应命令如下，尚待 Windows 实测：

```powershell
.\pikpak-downloader-windows-x64.exe login
.\pikpak-downloader-windows-x64.exe watch --output "$env:USERPROFILE\Downloads"
.\pikpak-downloader-windows-x64.exe status
```

Windows arm64 使用同目录的 `pikpak-downloader-windows-arm64.exe`。停止监听后可使用同样的 `retry`、`cancel`、`config` 和 `logout` 语义。

macOS 使用本应用的 Keychain 条目。Linux 经 libsecret 使用 Secret Service（GNOME Keyring、KWallet 等）的同名条目，钥匙环需已解锁；没有可用服务（例如无图形会话的服务器）时报告凭据存储不可用，不退回明文。Windows 桥接通过系统 PowerShell 调用 Credential Manager 的 `CredWriteW`，明确指定 `CRED_PERSIST_LOCAL_MACHINE`，回读检查持久化标志及值。秘密只走进程管道，不进入命令行或普通文件；超过 2560 个 UTF-8 字节时拒绝保存，不退回明文。字段与限制依据 [Microsoft CREDENTIALW 文档](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw)，实际平台验收仍是任务 8.3。

系统凭据库不可用、被锁定、策略禁止桥接或数据超长时，解决该问题后重试。任务资料引用不可读时，需要重新复制含链接和提取码的完整文本；不会把它误判为分享永久失效，也不会自动取用另一个任务的资料。更新资料使用新的引用，活动扫描和未知操作用完旧引用后才可回收。
