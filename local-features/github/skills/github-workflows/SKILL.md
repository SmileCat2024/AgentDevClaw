---
name: github-workflows
description: GitHub 工作流编排知识。当用户需要处理 PR review、排查 CI 失败、发布变更时，引导正确组合 GitHub 工具完成任务。
---

# GitHub 工作流编排

GitHub 能力通过单个 `github_shell` 工具提供。先运行 `help` 查看当前会话启用的命令及参数。

主对象用位置参数传递（如 `get-pr 42`、`search-code '<query>'`），选项用 `--名称=值` flag，带空格的值用引号包住。命令使用连字符，例如 `get-pr`、`list-prs`。仓库操作可省略 --owner/--repo（若已配置默认值），否则显式传 `--owner=... --repo=...`。

公共基座支持 Bash 变量、数组、循环、条件、函数、命令替换及管道；辅助命令和执行边界见 `help`。领域命令名必须静态明确，参数展开后仍校验，不开放 `eval` / `source` 或任意系统命令。批量写操作仍须获得对应授权，不因可用循环就自动扩大修改范围。脚本只在本次工具调用内执行，变量不跨调用保留。

以下工作流说明编排顺序；实际命令名以 `help` 输出为准。

## PR Review 评论处理

当用户要求"处理 PR 上的 review 评论"或"修复 reviewer 提出的问题"时：

1. **获取 thread 级评论数据**：运行 `get-pr-review-threads <PR编号> --owner=<owner> --repo=<repo>`。
   - 该工具返回每个 thread 的 `isResolved`、`isOutdated`、`path`、`line` 和评论内容。
   - REST API 的 review comments 是扁平的，不保留 thread 分组和 resolved 状态，所以必须用这个 GraphQL 工具。

2. **筛选 actionable threads**：只处理 `isResolved=false && isOutdated=false` 的 thread。

3. **聚类**：按文件路径分组，逐文件修复。

4. **修复后回复**：代码修改完成后，用 `reply-pr-comment` 在原 thread 下回复说明。

5. **不要自动 resolve 或 submit review**，除非用户明确要求。

## CI 失败排查

当用户说"CI 挂了"、"check 失败了"时：

1. **确定 PR 的 head SHA**：如果知道 PR 号，用 `get-pr` 获取 `head.sha`。

2. **查看 checks 汇总**：运行 `list-pr-checks <head-sha>`，查看哪些 check 失败。
   - 该工具会自动标出失败的 check，并提取 run_id。

3. **获取失败 job 详情**：运行 `get-workflow-run <run-id>` 获取 job 列表。不知道仓库有哪些 workflow 时先跑 `list-workflows`。

4. **获取日志片段**：运行 `get-job-logs <job-id>`，获取自动提取的失败上下文片段。
   - 该工具会自动在日志中搜索 error/fail/exception 等标记词，返回附近的上下文。

5. **提出修复方案，等待用户确认后再改代码。** 修复推送后可用 `rerun-workflow-run <run-id>` 触发验证（`--failed-only` 只重跑失败的 job）；卡住或误触的 run 用 `cancel-workflow-run <run-id>` 取消。

## 发布变更（从本地到 PR）

当用户说"提交代码发个 PR"时：

1. **本地操作用 Shell 工具**（bash/powershell），不用 GitHub API 做 git 操作：
   - `git status -sb` 确认变更范围
   - 按需创建分支、暂存、提交、推送

2. **创建 PR**：分支推到远程后，运行 `create-pr '<标题>' --head=<源分支> [--base=...] [--body=...] [--draft]`。
   - `--head` = 当前分支名
   - `--base` = 目标分支（缺省用仓库默认分支）
   - PR body 用 Markdown 写清楚 what/why/impact

3. **如果用户明确要求 draft PR**，加 `--draft` flag。

## 发版（GitHub Release）

当用户要求"发个 Release / 发布新版本"时：

1. **核对现状**：`list-releases` 看已有版本与资产；`list-tags` 确认目标 tag 是否已存在（已存在的 tag 直接复用，不重新指向）。

2. **创建 Release**：`create-release <tag> --notes-file=<changelog 路径> [--asset=<文件路径>]... [--target-commitish=<分支|SHA>] [--draft] [--prerelease]`
   - 正文二选一：`--notes-file=`（本地 changelog 文件，工作区相对路径）或 `--notes='<markdown>'`
   - tag 不存在时按 `--target-commitish=` 指向的提交自动创建
   - 安装包等产物用 `--asset=` 上传，可重复多次

3. **核对**：`get-release <tag>` 确认正文与资产清单（名称/大小/下载地址）。

4. **勘误与清理**：`update-release <tag> --title=... / --notes-file=... / --draft=false` 修订已发布内容；误发的 Release 用 `delete-release <tag>` 删除（git tag 本身保留）。

发布是对外可见操作：创建、更新、删除 Release 前须获得用户明确授权。
