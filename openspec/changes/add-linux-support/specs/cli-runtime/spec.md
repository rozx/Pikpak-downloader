## MODIFIED Requirements

### Requirement: 独立跨平台发行

系统 SHALL 为 macOS、Windows 和 Linux（glibc，x64 与 arm64）提供可运行的发行产物，使用一致的命令语义。用户 SHALL 无需安装官方 PikPak CLI、官方桌面应用或开发语言运行时，即可使用核心下载流程。Linux 上 SHALL 使用 Secret Service 保存凭据，任务库默认位于 `$XDG_DATA_HOME/PikpakDownloader`，未设置时位于 `~/.local/share/PikpakDownloader`。

#### Scenario: 干净环境首次运行
- **WHEN** 用户在受支持的 macOS、Windows 或 Linux 环境安装本工具，未安装其他 PikPak 客户端
- **THEN** 用户可以查看帮助、完成所支持的登录并启动前台监听

#### Scenario: Linux 缺少凭据服务
- **WHEN** 用户在没有可用 Secret Service 的 Linux 环境中登录
- **THEN** 系统报告凭据存储不可用并说明需要可用的钥匙环服务，不以明文保存令牌
