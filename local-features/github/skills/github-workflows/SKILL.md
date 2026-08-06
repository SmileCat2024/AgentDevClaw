---
name: github-workflows
description: GitHub 工作流编排知识。当用户需要处理 PR review、排查 CI 失败、发布变更时，引导正确组合 GitHub 工具完成任务。
---

# GitHub 工作流编排

本 Feature 提供了 30+ 个 GitHub 工具（`gh_*` 前缀）。以下是三个高频工作流的推荐编排路径。

## PR Review 评论处理

当用户要求"处理 PR 上的 review 评论"或"修复 reviewer 提出的问题"时：

1. **获取 thread 级评论数据**：调用 `gh_get_pr_review_threads` 获取 inline review threads。
   - 该工具返回每个 thread 的 `isResolved`、`isOutdated`、`path`、`line` 和评论内容。
   - REST API 的 review comments 是扁平的，不保留 thread 分组和 resolved 状态，所以必须用这个 GraphQL 工具。

2. **筛选 actionable threads**：只处理 `isResolved=false && isOutdated=false` 的 thread。

3. **聚类**：按文件路径分组，逐文件修复。

4. **修复后回复**：代码修改完成后，用 `gh_reply_pr_comment` 在原 thread 下回复说明。

5. **不要自动 resolve 或 submit review**，除非用户明确要求。

## CI 失败排查

当用户说"CI 挂了"、"check 失败了"时：

1. **确定 PR 的 head SHA**：如果知道 PR 号，用 `gh_get_pr` 获取 `head.sha`。

2. **查看 checks 汇总**：调用 `gh_list_pr_checks`（传入 head SHA 作为 `ref`），查看哪些 check 失败。
   - 该工具会自动标出失败的 check，并提取 run_id。

3. **获取失败 job 详情**：调用 `gh_get_workflow_run`（传入 run_id）获取 job 列表。

4. **获取日志片段**：调用 `gh_get_job_logs`（传入失败的 job_id），获取自动提取的失败上下文片段。
   - 该工具会自动在日志中搜索 error/fail/exception 等标记词，返回附近的上下文。

5. **提出修复方案，等待用户确认后再改代码。**

## 发布变更（从本地到 PR）

当用户说"提交代码发个 PR"时：

1. **本地操作用 Shell 工具**（bash/powershell），不用 GitHub API 做 git 操作：
   - `git status -sb` 确认变更范围
   - 按需创建分支、暂存、提交、推送

2. **创建 PR 用 GitHub API**：分支推到远程后，调用 `gh_create_pr`。
   - `head` 参数 = 当前分支名
   - `base` 参数 = 目标分支（默认分支）
   - PR body 用 Markdown 写清楚 what/why/impact

3. **如果用户明确要求 draft PR**，设置 `draft: true`。
