---
name: github-workflows
description: GitHub 工作流编排知识。当用户需要处理 PR review、排查 CI 失败、发布变更时，引导正确组合 GitHub 工具完成任务。
---

# GitHub 工作流编排

GitHub 能力通过单个 `github_shell` 工具提供。先运行 `help` 查看当前会话启用的命令及参数。

参数以 `--名称=值` 传递；带空格的值用引号包住，例如 `--query='bug in login'`。命令使用连字符，例如 `get-pr`、`list-prs`。仓库操作可省略 owner/repo（若已配置默认值），否则显式传 `--owner=... --repo=...`。

以下工作流说明编排顺序；实际命令名以 `help` 输出为准。

## PR Review 评论处理

当用户要求"处理 PR 上的 review 评论"或"修复 reviewer 提出的问题"时：

1. **获取 thread 级评论数据**：运行 `get-pr-review-threads --owner=<owner> --repo=<repo> --pull-number=<number>`。
   - 该工具返回每个 thread 的 `isResolved`、`isOutdated`、`path`、`line` 和评论内容。
   - REST API 的 review comments 是扁平的，不保留 thread 分组和 resolved 状态，所以必须用这个 GraphQL 工具。

2. **筛选 actionable threads**：只处理 `isResolved=false && isOutdated=false` 的 thread。

3. **聚类**：按文件路径分组，逐文件修复。

4. **修复后回复**：代码修改完成后，用 `reply-pr-comment` 在原 thread 下回复说明。

5. **不要自动 resolve 或 submit review**，除非用户明确要求。

## CI 失败排查

当用户说"CI 挂了"、"check 失败了"时：

1. **确定 PR 的 head SHA**：如果知道 PR 号，用 `get-pr` 获取 `head.sha`。

2. **查看 checks 汇总**：运行 `list-pr-checks --ref=<head-sha>`，查看哪些 check 失败。
   - 该工具会自动标出失败的 check，并提取 run_id。

3. **获取失败 job 详情**：运行 `get-workflow-run --run-id=<run-id>` 获取 job 列表。

4. **获取日志片段**：运行 `get-job-logs --job-id=<job-id>`，获取自动提取的失败上下文片段。
   - 该工具会自动在日志中搜索 error/fail/exception 等标记词，返回附近的上下文。

5. **提出修复方案，等待用户确认后再改代码。**

## 发布变更（从本地到 PR）

当用户说"提交代码发个 PR"时：

1. **本地操作用 Shell 工具**（bash/powershell），不用 GitHub API 做 git 操作：
   - `git status -sb` 确认变更范围
   - 按需创建分支、暂存、提交、推送

2. **创建 PR**：分支推到远程后，运行 `create-pr --title=... --head=... [--body=...] [--base=...] [--draft=true]`。
   - `head` 参数 = 当前分支名
   - `base` 参数 = 目标分支（默认分支）
   - PR body 用 Markdown 写清楚 what/why/impact

3. **如果用户明确要求 draft PR**，设置 `draft: true`。
