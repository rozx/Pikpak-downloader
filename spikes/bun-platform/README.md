# Bun 平台可行性验证

这是 OpenSpec 任务 1.4 的隔离验证程序，不是下载器实现，也不能代替 G1–G4 完整验收。程序不接受 PikPak 链接、提取码或账号密码，不调用 PikPak 接口。

开发版本：Bun 1.4.2、TypeScript 7.0.2、`@types/bun` 1.4.2。依赖与锁文件只属于本验证目录；应用骨架等待 G1–G3 和 macOS 核心验证，Windows 实测按用户确认的顺序保留在发布验收。

## Run

在本目录执行：

```sh
bun install --frozen-lockfile
bun run typecheck
bun run probe
bun run compile
./dist/platform-probe
```

独立构建已内嵌 Bun；Windows 产物使用 `.exe` 后缀。跨平台构建可以通过 Bun 的 `--target` 指定目标，但构建成功不代表实际运行通过。

默认检查 SQLite 的约束回滚、64 位整数、子进程在事务提交前后被强制结束的恢复，以及同卷硬链接发布时的文件身份和不覆盖行为。所有文件写入仅发生在新建的临时目录中，完成后删除该目录。程序只结束自己创建的数据库验证子进程。

可选检查：

```sh
bun probe.ts --credentials --clipboard-signal
./dist/platform-probe --credentials --clipboard-signal
```

`--credentials` 使用 `Bun.secrets` 在系统凭据库创建一个随机测试条目，核对后删除；不会枚举其他条目或访问用户已有账号凭据，系统可能显示权限提示。

当前 `@types/bun` 1.4.2 的凭据写入类型没有在线文档描述的 `persist` 选项。验证程序在 Windows 上明确跳过凭据写入，不能假设透传未知选项就保证本机持久化；这一差异仍需运行时证据或原生适配解决。

`--clipboard-signal` 只读取系统内容变化标识，不读取或修改剪贴板内容。验证程序使用操作系统附带的脚本工具读取标识；这不是生产剪贴板适配器，也没有证明稳定快照、重复复制或快速覆盖处理已经正确。

## Limits

- 硬链接发布检查只证明当前临时目录所在文件系统支持该方案，不证明其他卷或网络文件系统支持。
- 目录刷新成功不等于已做物理断电测试，Windows 的持久化方案仍需实际运行验证。
- 真实认证和下载验证放在 `../pikpak-auth/`，不能由平台探针替代。
- 基础探针的 `gateComplete: false` 指它单独不能完成验证；任务 1.4 现有的完成证据由基础与原生探针共同提供，整个第 1 组仍需接口验证。

## Observed Results

2026-10-08，本机 macOS arm64 / Bun 1.4.2：

- `bun run typecheck` 通过。
- 源码及独立产物的 SQLite、大整数、子进程中断恢复、硬链接不覆盖发布和目录刷新检查通过。
- 独立产物的随机系统凭据往返与清理、只读剪贴板变化标识检查通过。
- Windows x64 独立产物交叉构建成功，尚无 Windows 实际运行结果。

以上结果不包含真实 PikPak 接口或完整平台验收。

## Native macOS Probe

`native/macos.mm` 使用 AppKit 和 Node-API，应用逻辑仍在 TypeScript。构建需要系统 clang 和 Node-API 头文件；可通过 `NODE_API_HEADERS` 指定头文件目录。发布二进制不需要它们。

```sh
bun run typecheck
bun run build:native
bun run probe:native
bun run compile:native
env PATH=/usr/bin:/bin ./dist/native-probe
```

2026-10-08，源码与独立产物均通过：

- 独立命名 pasteboard 的稳定快照、相同文本重复制、读取间变化、持续变化时有界退出、快速覆盖后只取得最终快照。未读取或修改用户 general 剪贴板。
- `flock` 排他锁：另一进程拒绝进入，显式释放和持有进程被强制结束后可以重新取得锁；锁文件留存不会形成永久假锁，符号链接锁路径被拒绝。
- `renamex_np(RENAME_EXCL)` 拒绝已有目标，同卷发布保留 `(dev, ino)` 身份，目录 fsync 成功，符号链接不能被当成普通文件身份。
- 将只有二进制的副本放到新的临时目录，并从 PATH 排除开发运行时后，以上检查仍全部通过；原生 `.node` 已嵌入产物。

因此任务 1.4 的本机 macOS arm64 核心验证已通过。Windows、其他架构、其他文件系统与发布烟测仍保留任务 8.3，未用交叉构建替代。
