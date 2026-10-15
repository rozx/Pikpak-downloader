---
name: release-ready
description: 准备一次发布：核对 release/x.y.z 分支与 package.json 版本（不一致则升级版本号），在 docs/releaseNotes 写中文发布说明，按本次改动更新 README 与 docs，最后推送分支并创建带 release 标签的 PR。用户说“release ready”“准备发布”“发版”或输入 /release-ready 时使用。
---

# release ready

把当前改动整理成一个可合并的发布 PR。合并后，`.github/workflows/release.yml` 会构建全部产物，并以本技能写的发布说明创建 GitHub Release。

发布是“直接提交到 main”规则的唯一例外：所有发布相关提交都放在 `release/<版本>` 分支，经 PR 合并。

按顺序执行下面的步骤，中途不要停下来询问，除非遇到“停止条件”。

## 1. 确定版本与分支

1. 确认工作区干净（`git status --porcelain` 为空），否则停止，请用户先提交或丢弃改动。
2. 读取当前版本：`package.json` 的 `version`（版本的唯一来源）。
3. 找到上一次发布：`git tag --list 'v*' --sort=-v:refname | head -1`。没有标签时视为首次发布。
4. 读取当前分支名 `git branch --show-current`：
   - **在 `release/<版本>` 分支上**（允许 `release/v<版本>`）：分支中的版本即目标版本。
   - **在其他分支上（通常是 main）**：按上次发布以来的改动推算目标版本（当前处于 0.x 阶段：有新功能升次版本号，只有修复升修订号；参考 conventional commits 前缀 `feat`、`fix`）。如果 `package.json` 的版本已经高于上一个标签，直接用它。然后 `git switch -c release/<目标版本>`。
5. 核对目标版本：
   - 必须是 `x.y.z` 格式，且高于上一个发布标签。
   - `git ls-remote --tags origin "refs/tags/v<目标版本>"` 必须为空。
6. 目标版本与 `package.json` 不一致时，只修改 `package.json` 的 `version`，单独提交：`chore: bump version to <目标版本>`。CLI `--version`、界面标题与 `src/about.ts` 都读它，不要改别处；`tests/lifecycle.test.ts` 直接读 `package.json`，不用改测试。

**停止条件**：分支名中的版本低于 `package.json` 的版本或不高于上一个标签、标签已经存在、分支名不是 `release/<x.y.z>` 格式。说明原因并请用户决定。

## 2. 收集本次改动

以上一个标签为起点（首次发布则从仓库第一个提交开始）：

- `git log <上一个标签>..HEAD --no-merges --format='%h %s'`：提交标题。
- `git diff --stat <上一个标签>..HEAD`：改动范围。
- `openspec/changes/archive/` 中在此期间新增的变更：读它们的 `proposal.md`（为什么、改了什么）和 `tasks.md`（未勾选的项目就是待验收或已知问题）。
- `openspec list` 中仍未归档的变更：说明哪些工作尚未完成。

需要时读具体提交的 diff，弄清对用户可见的行为变化。

## 3. 写发布说明

文件：`docs/releaseNotes/v<目标版本>.md`，中文书写。发布工作流按这个路径取文件作为 GitHub Release 的正文，文件缺失时发布失败。

```markdown
# PikPak DL CLI v<版本>

发布日期：<YYYY-MM-DD>

<一两句话概括这次发布。>

## 新功能

- <面向用户描述：能做什么、在哪里操作。>

## 改进

## 修复

## 下载

| 平台 | 文件 |
| --- | --- |
| macOS Apple 芯片 | `pikpak-dl-cli-darwin-arm64` |
| macOS Intel | `pikpak-dl-cli-darwin-x64` |
| Windows x64 | `pikpak-dl-cli-windows-x64.exe` |
| Windows arm64 | `pikpak-dl-cli-windows-arm64.exe` |
| Linux x64（glibc） | `pikpak-dl-cli-linux-x64` |
| Linux arm64（glibc） | `pikpak-dl-cli-linux-arm64` |

`SHA256SUMS.txt` 列出各文件的校验和。

## 升级说明

<任务库迁移、配置变化、需要重新登录等。没有就写“直接替换可执行文件即可。”>

## 已知问题与待验收

<未勾选的 OpenSpec 任务、尚未实机验证的平台等。>
```

写作要求：

- 面向使用者描述行为变化，不罗列提交哈希，不写内部重构；没有内容的小节删除。
- 下载表与 `scripts/build.ts` 的 `targets` 保持一致；目标有增减时同步修改。
- 分享链接、提取码、令牌、签名下载地址、账号标识、真实文件名不得出现在发布说明里。
- 遵循项目文风：简洁、陈述句、中文全角标点，代码与路径用反引号。

## 4. 更新 README 与文档

逐一检查 `README.md`、`AGENTS.md` 和 `docs/*.md`（不含 `docs/releaseNotes/`），把与本次改动不符的内容改正：

- 功能、按键、命令与选项、支持的平台与产物名、依赖、默认目录。
- “开发中”“待验收”之类的状态描述：以第 2 步的事实为准，不夸大也不遗漏；验收与已知问题只写在发布说明里，不另建验收文档。
- 新功能缺少说明时，补到最相关的文档里，并在 README 中链接。

不要修改 `openspec/specs/` 与 `openspec/changes/archive/`：它们由 OpenSpec 流程维护。

## 5. 检查与提交

1. `bun run check`，确认输出 `0 fail`。失败时修复或停止，不要带着失败发布。
2. `openspec validate --specs --strict`。
3. 提交（标题用 conventional commits，正文末尾带会话要求的署名行）：
   - 发布说明：`docs: add release notes for v<版本>`
   - 文档更新：`docs: update docs for v<版本>`（没有改动就跳过）

## 6. 推送并创建 PR

1. 确保仓库有 `release` 标签：`gh label list --search release`；没有时创建：
   `gh label create release --color 0E8A16 --description "合并后构建并发布"`
2. `git push -u origin release/<版本>`
3. 创建 PR，正文用发布说明，末尾加会话要求的 PR 署名：

   ```sh
   gh pr create --base main --head release/<版本> --title "release: v<版本>" --label release --body-file <正文文件>
   ```

   正文文件写在临时目录（发布说明加署名），不要提交到仓库。
4. 把 PR 链接告诉用户，并说明：合并后工作流会核对版本与标签，在 macOS、Windows、Linux 上运行检查并构建，然后创建 `v<版本>` 标签和 Release，正文取自 `docs/releaseNotes/v<版本>.md`。

## 发布工作流的约束（供核对）

- PR 必须合并到 main，带 `release` 标签，来源分支以 `release/` 开头且位于本仓库。
- 分支名中的版本必须等于 `package.json` 的版本；`v<版本>` 的标签与 Release 不能已存在。
- `docs/releaseNotes/v<版本>.md` 必须存在且非空。
