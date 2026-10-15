# Spec Delta

## Purpose

本地任务目录使用不带后缀的任务名称，下载过程不在下载目录里留下暂存目录。

## ADDED Requirements

### Requirement: 任务目录名称与临时文件位置

新分享的任务目录 SHALL 以任务名称命名：分享标题去掉文件后缀，包括普通后缀、分卷后缀与双后缀。任务目录名 MUST NOT 附加分享 ID 等内部后缀。与磁盘上已有目录重名时，系统 SHALL 改用“名称 (2)”这类编号名称，MUST NOT 写入已有目录。下载中的临时文件 SHALL 放在目标文件所在目录，完成后在同一目录内以不覆盖方式发布，系统 MUST NOT 为此创建单独的暂存目录。已有分享的目录与进行中的交付 SHALL 保持原有路径。

#### Scenario: 分卷压缩包分享
- **WHEN** 分享标题为“Shibarin.7z.002”，下载目录中还没有名为“Shibarin”的目录
- **THEN** 系统创建“Shibarin”目录，文件下载期间以“Shibarin.7z.001.pikpak-part”存在于该目录，完成后改名为“Shibarin.7z.001”，目录中不留下其他内容

#### Scenario: 与已有目录重名
- **WHEN** 下载目录中已有用户自己的“Shibarin”目录
- **THEN** 系统改用“Shibarin (2)”，不向用户的目录写入任何文件
