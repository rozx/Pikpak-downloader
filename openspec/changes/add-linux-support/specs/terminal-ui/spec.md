## MODIFIED Requirements

### Requirement: 无参数进入交互界面

系统 SHALL 在不带任何参数且标准输入、标准输出均为交互终端时启动全屏界面。标准输入或输出不是交互终端时，系统 SHALL 打印帮助并退出，MUST NOT 输出界面控制序列。带子命令启动时 SHALL 保持子命令原有行为。

#### Scenario: 交互终端无参数启动
- **WHEN** 用户在 macOS、Windows 或 Linux 终端中不带参数运行本工具
- **THEN** 系统切换到备用屏幕并进入启动检查流程

#### Scenario: 输出被重定向
- **WHEN** 用户不带参数运行本工具并把标准输出重定向到文件
- **THEN** 系统打印帮助文本，文件中不含光标控制或颜色序列
