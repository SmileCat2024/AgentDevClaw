/**
 * github_shell 策略声明——手写动词表
 *
 * 与 coder_shell / playwright_shell 同款的手写策略（取代旧版「工具集定义 → 机械投射」
 * 生成方式）：动词从领域工作流反推，主对象参数用位置参数（get-pr 42、
 * search-code '<query>'），选项用 --key=value flag；--owner/--repo 可省略（由 feature
 * 配置 defaultOwner/defaultRepo 兜底）。动词名与旧投射版保持一致（kebab-case），仅调用
 * 形态从全 flag 升级为位置参数。
 *
 * 动词按 toolset 分组（context/repo/issues/pr/actions/releases/notifications），
 * createGitHubShellPolicy(enabledToolsets) 按启用集过滤；各动词的实现是对应的
 * github-shell.ts adapter（key 前缀 github:）。
 */
import type { CapabilityShellPolicy, ShellVerbDecl } from '../../capability-shell/src/types.js';

export const GITHUB_SHELL_NAME = 'github_shell';

/** toolset 全集；默认启用除 notifications 外全部（与 feature 配置默认一致）。 */
export const GITHUB_TOOLSETS = ['context', 'repo', 'issues', 'pr', 'actions', 'releases', 'notifications'] as const;
export type GitHubToolsetId = (typeof GITHUB_TOOLSETS)[number];

export const GITHUB_SHELL_DESCRIPTION = [
  'GitHub 仓库、Issue、Pull Request、Actions、Release 与通知操作。',
  '主对象用位置参数（如 get-pr 42、search-code \'<query>\'），选项用 --名称=值 flag；带空格的值用引号包住。',
  '仓库操作可省略 --owner/--repo（若已配置默认仓库），否则显式 --owner=... --repo=...。',
  '首次使用或涉及 PR review、CI 排查与发布流程时，先激活 github-workflows 技能。',
].join('');

/** 仓库域动词共用的可选 flag。 */
const REPO_FLAGS = ['--owner=', '--repo='];

// ── context ────────────────────────────────────────────────

const CONTEXT_VERBS: Record<string, ShellVerbDecl> = {
  'get-me': {
    description: '查看当前认证身份（login、计划、公开仓库数）。首次使用先跑它验证认证',
    params: [],
    usage: 'get-me',
    adapter: { key: 'github:get-me' },
  },
};

// ── repo ───────────────────────────────────────────────────

const REPO_VERBS: Record<string, ShellVerbDecl> = {
  'get-repo': {
    description: '查看仓库元信息：默认分支、可见性、描述、star/fork 数——分支/发布等流程的前置核对',
    params: [],
    flags: REPO_FLAGS,
    usage: 'get-repo',
    adapter: { key: 'github:get-repo' },
  },
  'list-tags': {
    description: '列 tag（发布前核对 tag 是否已存在）',
    params: [],
    flags: ['--per-page=', ...REPO_FLAGS],
    usage: 'list-tags [--per-page=<n>]',
    adapter: { key: 'github:list-tags' },
  },
  'get-file-contents': {
    description: '读取仓库文件内容（自动 base64 解码）或目录清单。省略 path 列根目录；--ref= 指定分支/tag/SHA',
    params: [{ name: 'path', kind: 'literal', required: false }],
    flags: ['--ref=', ...REPO_FLAGS],
    usage: 'get-file-contents [path] [--ref=<分支|tag|SHA>]',
    adapter: { key: 'github:get-file-contents' },
  },
  'search-code': {
    description: '全站代码搜索（GitHub 搜索语法，如 "repo:owner/repo function hello"）。注意：传统代码搜索只覆盖已被索引的仓库，小/新仓库可能搜不到——断言「不存在」前用 get-file-contents 核实；repo: 需用当前规范名（改名仓库会静默失败）',
    params: [{ name: 'query', kind: 'literal' }],
    flags: ['--per-page='],
    usage: "search-code '<query>' [--per-page=<n>]",
    adapter: { key: 'github:search-code' },
  },
  'search-repos': {
    description: '搜索 GitHub 仓库（如 "language:typescript stars:>1000 agent framework"）',
    params: [{ name: 'query', kind: 'literal' }],
    flags: ['--per-page='],
    usage: "search-repos '<query>' [--per-page=<n>]",
    adapter: { key: 'github:search-repos' },
  },
  'list-commits': {
    description: '列提交历史（新到旧）；[sha] 为起点分支或 SHA，--path= 只看某路径的变更',
    params: [{ name: 'sha', kind: 'literal', required: false }],
    flags: ['--path=', '--per-page=', ...REPO_FLAGS],
    usage: 'list-commits [sha] [--path=<路径>] [--per-page=<n>]',
    adapter: { key: 'github:list-commits' },
  },
  'get-commit': {
    description: '查看提交详情：作者、提交信息、改动文件与增删统计',
    params: [{ name: 'ref', kind: 'literal' }],
    flags: REPO_FLAGS,
    usage: 'get-commit <SHA|分支|tag>',
    adapter: { key: 'github:get-commit' },
  },
  'list-branches': {
    description: '列分支（含保护标记与头提交）',
    params: [],
    flags: ['--per-page=', ...REPO_FLAGS],
    usage: 'list-branches [--per-page=<n>]',
    adapter: { key: 'github:list-branches' },
  },
  'create-branch': {
    description: '创建新分支；[from-ref] 为起点（分支/tag/SHA），省略则用仓库默认分支',
    params: [
      { name: 'branch', kind: 'literal' },
      { name: 'from-ref', kind: 'literal', required: false },
    ],
    flags: REPO_FLAGS,
    usage: 'create-branch <新分支名> [from-ref]',
    adapter: { key: 'github:create-branch' },
  },
  'create-or-update-file': {
    description: '经 GitHub API 直接创建/更新单个文件（提交直达远端，不经本地 git）。--message= 与 --content= 必填；更新已有文件需 --sha=（被替换文件的 blob SHA，可从 get-file-contents 取）',
    params: [{ name: 'path', kind: 'literal' }],
    flags: ['--message=', '--content=', '--branch=', '--sha=', ...REPO_FLAGS],
    usage: 'create-or-update-file <仓库内路径> --message=<提交信息> --content=<内容> [--branch=<分支>] [--sha=<blob-sha>]',
    adapter: { key: 'github:create-or-update-file' },
  },
  'get-tree': {
    description: '查看文件树；默认递归全量，--recursive=false 关闭',
    params: [{ name: 'tree-sha', kind: 'literal', required: false }],
    flags: ['--recursive=', ...REPO_FLAGS],
    usage: 'get-tree [tree-sha] [--recursive=<true|false>]',
    adapter: { key: 'github:get-tree' },
  },
};

// ── issues ─────────────────────────────────────────────────

const ISSUE_VERBS: Record<string, ShellVerbDecl> = {
  'list-issues': {
    description: '列 Issue（默认只列 open，自动滤掉 PR）；--state= 过滤状态，--labels= 逗号分隔过滤',
    params: [],
    flags: ['--state=', '--labels=', '--per-page=', ...REPO_FLAGS],
    usage: 'list-issues [--state=<open|closed|all>] [--labels=<a,b>] [--per-page=<n>]',
    adapter: { key: 'github:list-issues' },
  },
  'get-issue': {
    description: '查看 Issue 详情（元信息、正文与评论数）',
    params: [{ name: 'number', kind: 'literal' }],
    flags: REPO_FLAGS,
    usage: 'get-issue <编号>',
    adapter: { key: 'github:get-issue' },
  },
  'search-issues': {
    description: '搜索 Issue 与 PR（"is:issue"/"is:pr" 过滤类型，"repo:owner/repo" 限定仓库）',
    params: [{ name: 'query', kind: 'literal' }],
    flags: ['--per-page='],
    usage: "search-issues '<query>' [--per-page=<n>]",
    adapter: { key: 'github:search-issues' },
  },
  'get-issue-comments': {
    description: '读 Issue（或 PR）的评论区——处理 issue 讨论时配合 get-issue 使用',
    params: [{ name: 'number', kind: 'literal' }],
    flags: ['--per-page=', ...REPO_FLAGS],
    usage: 'get-issue-comments <编号> [--per-page=<n>]',
    adapter: { key: 'github:get-issue-comments' },
  },
  'create-issue': {
    description: '创建 Issue；--labels= / --assignees= 逗号分隔（空值表示清空，仅 update 有意义）',
    params: [{ name: 'title', kind: 'literal' }],
    flags: ['--body=', '--labels=', '--assignees=', ...REPO_FLAGS],
    usage: "create-issue '<标题>' [--body=<markdown>] [--labels=<a,b>] [--assignees=<u1,u2>]",
    adapter: { key: 'github:create-issue' },
  },
  'update-issue': {
    description: '更新 Issue 字段；--labels= / --assignees= 逗号分隔，空值（--labels=）表示清空',
    params: [{ name: 'number', kind: 'literal' }],
    flags: ['--title=', '--body=', '--state=', '--labels=', '--assignees=', '--milestone=', ...REPO_FLAGS],
    usage: 'update-issue <编号> [--title=<新标题>] [--body=<markdown>] [--state=<open|closed>] [--labels=<a,b>] [--assignees=<u1,u2>] [--milestone=<n|空>]',
    adapter: { key: 'github:update-issue' },
  },
  'add-issue-comment': {
    description: '给 Issue 或 PR 添加评论；--body= 必填',
    params: [{ name: 'number', kind: 'literal' }],
    flags: ['--body=', ...REPO_FLAGS],
    usage: "add-issue-comment <编号> --body='<markdown>'",
    adapter: { key: 'github:add-issue-comment' },
  },
};

// ── pull request ───────────────────────────────────────────

const PR_VERBS: Record<string, ShellVerbDecl> = {
  'list-prs': {
    description: '列 PR（默认 open）；--state= 过滤状态',
    params: [],
    flags: ['--state=', '--per-page=', ...REPO_FLAGS],
    usage: 'list-prs [--state=<open|closed|all>] [--per-page=<n>]',
    adapter: { key: 'github:list-prs' },
  },
  'get-pr': {
    description: '查看 PR 详情：元信息、可合并性、改动文件与描述',
    params: [{ name: 'number', kind: 'literal' }],
    flags: REPO_FLAGS,
    usage: 'get-pr <编号>',
    adapter: { key: 'github:get-pr' },
  },
  'search-prs': {
    description: '搜索 PR（自动附加 is:pr，无需手写）',
    params: [{ name: 'query', kind: 'literal' }],
    flags: ['--per-page='],
    usage: "search-prs '<query>' [--per-page=<n>]",
    adapter: { key: 'github:search-prs' },
  },
  'create-pr': {
    description: '创建 PR；--head= 源分支必填，--draft 创建为草稿。本地 git 操作（提交/推送）走 Shell 工具，不走本动词',
    params: [{ name: 'title', kind: 'literal' }],
    flags: ['--head=', '--base=', '--body=', '--draft', ...REPO_FLAGS],
    usage: "create-pr '<标题>' --head=<源分支> [--base=<目标分支>] [--body=<markdown>] [--draft]",
    adapter: { key: 'github:create-pr' },
  },
  'update-pr': {
    description: '更新 PR 字段（标题/正文/状态/目标分支）',
    params: [{ name: 'number', kind: 'literal' }],
    flags: ['--title=', '--body=', '--state=', '--base=', ...REPO_FLAGS],
    usage: 'update-pr <编号> [--title=<新标题>] [--body=<markdown>] [--state=<open|closed>] [--base=<目标分支>]',
    adapter: { key: 'github:update-pr' },
  },
  'update-pr-branch': {
    description: '把 PR 分支与目标分支同步（等同网页上的 Update branch）——CI 要求分支最新时使用',
    params: [{ name: 'number', kind: 'literal' }],
    flags: REPO_FLAGS,
    usage: 'update-pr-branch <编号>',
    adapter: { key: 'github:update-pr-branch' },
  },
  'merge-pr': {
    description: '合并 PR；--method= 选合并方式（默认仓库设置），--title= 合并提交标题',
    params: [{ name: 'number', kind: 'literal' }],
    flags: ['--method=', '--title=', ...REPO_FLAGS],
    usage: 'merge-pr <编号> [--method=<merge|squash|rebase>] [--title=<合并提交标题>]',
    adapter: { key: 'github:merge-pr' },
  },
  'get-pr-reviews': {
    description: '列 PR 上已提交的 review（状态、作者、摘要）',
    params: [{ name: 'number', kind: 'literal' }],
    flags: REPO_FLAGS,
    usage: 'get-pr-reviews <编号>',
    adapter: { key: 'github:get-pr-reviews' },
  },
  'get-pr-review-threads': {
    description: '查 PR 行内评审线程（GraphQL，含 resolved/outdated 状态）。处理评审意见先跑它：筛「未 resolved 且未 outdated」的线程即待办项',
    params: [{ name: 'number', kind: 'literal' }],
    flags: REPO_FLAGS,
    usage: 'get-pr-review-threads <编号>',
    adapter: { key: 'github:get-pr-review-threads' },
  },
  'create-pr-review': {
    description: '提交 review；--event= 为 APPROVE / REQUEST_CHANGES / COMMENT，行内意见用 --comments=（JSON 数组，每项 path/line/side/body）',
    params: [{ name: 'number', kind: 'literal' }],
    flags: ['--event=', '--body=', '--comments=', ...REPO_FLAGS],
    usage: "create-pr-review <编号> --event=<APPROVE|REQUEST_CHANGES|COMMENT> [--body='<markdown>'] [--comments='<JSON数组>']",
    adapter: { key: 'github:create-pr-review' },
  },
  'reply-pr-comment': {
    description: '在行内评审线程下回复；评论 ID 来自 get-pr-review-threads 的输出，--body= 必填',
    params: [
      { name: 'number', kind: 'literal' },
      { name: 'comment-id', kind: 'literal' },
    ],
    flags: ['--body=', ...REPO_FLAGS],
    usage: "reply-pr-comment <PR编号> <评论ID> --body='<markdown>'",
    adapter: { key: 'github:reply-pr-comment' },
  },
};

// ── actions / CI ───────────────────────────────────────────

const ACTIONS_VERBS: Record<string, ShellVerbDecl> = {
  'list-workflows': {
    description: '列仓库的 workflow 定义（id、名称、文件路径与启用状态）——排查 CI 前先看有哪些',
    params: [],
    flags: REPO_FLAGS,
    usage: 'list-workflows',
    adapter: { key: 'github:list-workflows' },
  },
  'rerun-workflow-run': {
    description: '重跑 workflow run（默认全量；--failed-only 只重跑失败的 job）',
    params: [{ name: 'run-id', kind: 'literal' }],
    flags: ['--failed-only', ...REPO_FLAGS],
    usage: 'rerun-workflow-run <run-id> [--failed-only]',
    adapter: { key: 'github:rerun-workflow-run' },
  },
  'cancel-workflow-run': {
    description: '取消进行中（排队/运行）的 workflow run',
    params: [{ name: 'run-id', kind: 'literal' }],
    flags: REPO_FLAGS,
    usage: 'cancel-workflow-run <run-id>',
    adapter: { key: 'github:cancel-workflow-run' },
  },
  'list-workflow-runs': {
    description: '列 Actions 运行；--branch= / --event= / --status= 过滤',
    params: [],
    flags: ['--branch=', '--event=', '--status=', '--per-page=', ...REPO_FLAGS],
    usage: 'list-workflow-runs [--branch=<分支>] [--event=<事件>] [--status=<状态>] [--per-page=<n>]',
    adapter: { key: 'github:list-workflow-runs' },
  },
  'get-workflow-run': {
    description: '查看运行详情与 job 列表（job id 供 get-job-logs 使用）',
    params: [{ name: 'run-id', kind: 'literal' }],
    flags: REPO_FLAGS,
    usage: 'get-workflow-run <run-id>',
    adapter: { key: 'github:get-workflow-run' },
  },
  'get-job-logs': {
    description: '取 job 日志并自动截取失败标记（error/fail/exception 等）附近片段；--max-lines= 控制返回行数',
    params: [{ name: 'job-id', kind: 'literal' }],
    flags: ['--max-lines=', ...REPO_FLAGS],
    usage: 'get-job-logs <job-id> [--max-lines=<n>]',
    adapter: { key: 'github:get-job-logs' },
  },
  'list-pr-checks': {
    description: '列某 ref 的 check 状态（PR 用 head SHA）；自动标出失败项并提取对应 run_id',
    params: [{ name: 'ref', kind: 'literal' }],
    flags: REPO_FLAGS,
    usage: 'list-pr-checks <ref>',
    adapter: { key: 'github:list-pr-checks' },
  },
};

// ── releases ───────────────────────────────────────────────

const RELEASE_VERBS: Record<string, ShellVerbDecl> = {
  'create-release': {
    description: '创建 Release（tag 不存在时按 --target-commitish 自动创建）。正文二选一：--notes-file= 读本地文件（workspace 相对路径）、--notes= 直接给文本；--asset= 上传资产文件（安装包等，可重复）；--draft / --prerelease 打标记',
    params: [{ name: 'tag', kind: 'literal' }],
    flags: ['--title=', '--notes=', '--notes-file=', '--target-commitish=', '--draft', '--prerelease', '--asset=', ...REPO_FLAGS],
    usage: "create-release <tag> [--title='<标题>'] [--notes-file=<路径>|--notes='<markdown>'] [--target-commitish=<分支|SHA>] [--draft] [--prerelease] [--asset=<路径>]...",
    adapter: { key: 'github:create-release' },
  },
  'get-release': {
    description: '查看单个 Release（按 tag）：正文与资产清单（名称/大小/下载地址）',
    params: [{ name: 'tag', kind: 'literal' }],
    flags: REPO_FLAGS,
    usage: 'get-release <tag>',
    adapter: { key: 'github:get-release' },
  },
  'update-release': {
    description: '更新已有 Release（按 tag）的标题/正文/草稿/预发布标记——发布后勘误用；正文给法同 create-release（--notes-file= 或 --notes=）',
    params: [{ name: 'tag', kind: 'literal' }],
    flags: ['--title=', '--notes=', '--notes-file=', '--draft=', '--prerelease=', ...REPO_FLAGS],
    usage: "update-release <tag> [--title='<标题>'] [--notes-file=<路径>|--notes='<markdown>'] [--draft=<true|false>] [--prerelease=<true|false>]",
    adapter: { key: 'github:update-release' },
  },
  'delete-release': {
    description: '删除 Release（按 tag；git tag 本身保留）。破坏性操作，须用户明确授权后使用',
    params: [{ name: 'tag', kind: 'literal' }],
    flags: REPO_FLAGS,
    usage: 'delete-release <tag>',
    adapter: { key: 'github:delete-release' },
  },
  'list-releases': {
    description: '列已有 Release（tag、标题、发布日期与资产数）',
    params: [],
    flags: ['--limit=', ...REPO_FLAGS],
    usage: 'list-releases [--limit=<n>]',
    adapter: { key: 'github:list-releases' },
  },
};

// ── notifications ──────────────────────────────────────────

const NOTIFICATION_VERBS: Record<string, ShellVerbDecl> = {
  'list-notifications': {
    description: '列通知；--all 含已读，--participating 只看直接参与的',
    params: [],
    flags: ['--all', '--participating', '--per-page='],
    usage: 'list-notifications [--all] [--participating] [--per-page=<n>]',
    adapter: { key: 'github:list-notifications' },
  },
  'mark-notification-read': {
    description: '标记指定通知为已读',
    params: [{ name: 'thread-id', kind: 'literal' }],
    usage: 'mark-notification-read <thread-id>',
    adapter: { key: 'github:mark-notification-read' },
  },
};

// ── 组装 ───────────────────────────────────────────────────

const TOOLSET_VERB_GROUPS: ReadonlyArray<readonly [GitHubToolsetId, Record<string, ShellVerbDecl>]> = [
  ['context', CONTEXT_VERBS],
  ['repo', REPO_VERBS],
  ['issues', ISSUE_VERBS],
  ['pr', PR_VERBS],
  ['actions', ACTIONS_VERBS],
  ['releases', RELEASE_VERBS],
  ['notifications', NOTIFICATION_VERBS],
];

export function createGitHubShellPolicy(enabledToolsets: ReadonlySet<string>): CapabilityShellPolicy {
  const verbs: Record<string, ShellVerbDecl> = {};
  for (const [toolsetId, group] of TOOLSET_VERB_GROUPS) {
    if (enabledToolsets.has(toolsetId)) Object.assign(verbs, group);
  }
  return {
    name: GITHUB_SHELL_NAME,
    description: GITHUB_SHELL_DESCRIPTION,
    verbs,
  };
}
