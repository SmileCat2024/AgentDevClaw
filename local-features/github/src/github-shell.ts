/**
 * github_shell 直调 adapter——每个动词解析参数后直调 GitHubClient。
 *
 * 逻辑承接自已退役的工具集定义（tools.ts）：用户可见的输出格式保持一致；
 * 失败语义从返回 {error} 记录改为直接 throw（capability-shell 管线统一捕获，
 * 中断 && 链）。参数解析遵循策略声明：位置参数 + 白名单 flag（--key=value 等号
 * 形态；--asset= 可重复收集），未声明的 -- 前缀 token 直接拒绝。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AdapterMap } from '../../capability-shell/src/dispatch.js';
import { isAbsoluteLike, escapesWorkspace } from '../../capability-shell/src/args.js';
import type { GitHubClient } from './client.js';

export { GITHUB_SHELL_NAME, GITHUB_TOOLSETS, createGitHubShellPolicy } from './github-policy.js';

export interface GitHubToolDefaults {
  defaultOwner?: string;
  defaultRepo?: string;
}

// ── 参数解析 ────────────────────────────────────────────────

interface ParsedCommand {
  positionals: string[];
  /** valued flag（--key=value），后值覆盖前值 */
  values: Map<string, string>;
  /** 可重复 valued flag（--asset=a --asset=b） */
  multi: Map<string, string[]>;
  /** plain flag（--draft 等）出现即真 */
  plain: Set<string>;
}

interface ParseOptions {
  plain?: string[];
  valued?: string[];
  repeatable?: string[];
}

function parseCommandArgs(tokens: string[], opts: ParseOptions = {}): ParsedCommand {
  const result: ParsedCommand = { positionals: [], values: new Map(), multi: new Map(), plain: new Set() };
  const plainFlags = opts.plain ?? [];
  // repeatable flag（--asset= 等）本质是可重复的 valued flag：自动并入白名单，
  // 调用方只需在 repeatable 声明一次，无需同时写进 valued。
  const repeatableList = opts.repeatable ?? [];
  const valuedFlags = [...(opts.valued ?? []), ...repeatableList];
  const repeatable = new Set(repeatableList);

  for (const token of tokens) {
    if (!token.startsWith('--')) {
      result.positionals.push(token);
      continue;
    }
    if (plainFlags.includes(token)) {
      result.plain.add(token);
      continue;
    }
    const matched = valuedFlags.find((f) => token.startsWith(f) && token.length > f.length);
    if (matched) {
      const value = token.slice(matched.length);
      if (repeatable.has(matched)) {
        const list = result.multi.get(matched) ?? [];
        list.push(value);
        result.multi.set(matched, list);
      } else {
        result.values.set(matched, value);
      }
      continue;
    }
    // 声明了 --key= 但裸写了 --key：给出定向报错而不是泛化拒绝
    const bare = valuedFlags.find((f) => token === f.slice(0, -1));
    if (bare) throw new Error(`${bare}<值> 需要等号赋值形态（如 ${bare}xxx）`);
    throw new Error(`不支持的参数：${token}。可用 flag 见 help`);
  }
  return result;
}

function requireValue(parsed: ParsedCommand, flag: string, usageHint: string): string {
  const value = parsed.values.get(flag);
  if (value === undefined || value === '') throw new Error(`缺少必填项 ${flag}<值>。用法：${usageHint}`);
  return value;
}

function resolveRepo(parsed: ParsedCommand, defaults: GitHubToolDefaults): { owner: string; repo: string } {
  const owner = parsed.values.get('--owner=')?.trim() || defaults.defaultOwner || '';
  const repo = parsed.values.get('--repo=')?.trim() || defaults.defaultRepo || '';
  if (!owner || !repo) {
    throw new Error('需要 --owner= 与 --repo=（或在 GitHub feature 配置里设置默认仓库）');
  }
  return { owner, repo };
}

function intArg(value: string, name: string): number {
  if (!/^-?\d+$/.test(value)) throw new Error(`参数 ${name} 必须是整数，收到 "${value}"`);
  return Number(value);
}

function optionalInt(parsed: ParsedCommand, flag: string, fallback: number): number {
  const raw = parsed.values.get(flag);
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${flag} 必须是正整数，收到 "${raw}"`);
  return Number(raw);
}

function enumValue(parsed: ParsedCommand, flag: string, allowed: string[], fallback?: string): string | undefined {
  const raw = parsed.values.get(flag);
  if (raw === undefined || raw === '') return fallback;
  if (!allowed.includes(raw)) throw new Error(`${flag} 只允许 ${allowed.join('|')}，收到 "${raw}"`);
  return raw;
}

function boolValue(parsed: ParsedCommand, flag: string, fallback: boolean): boolean {
  const raw = parsed.values.get(flag);
  if (raw === undefined || raw === '') return fallback;
  if (raw !== 'true' && raw !== 'false') throw new Error(`${flag} 只允许 true|false，收到 "${raw}"`);
  return raw === 'true';
}

/** 逗号分隔列表：undefined → 不传该字段；空串 → []（清空语义）；否则拆分。 */
function csvList(parsed: ParsedCommand, flag: string): string[] | undefined {
  const raw = parsed.values.get(flag);
  if (raw === undefined) return undefined;
  if (raw === '') return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + `\n...(truncated, ${text.length} chars total)`;
}

// ── 本地文件读取（workspace 相对路径边界） ─────────────────

function assertWorkspaceRelative(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/');
  if (isAbsoluteLike(normalized)) {
    throw new Error(`本地文件路径必须是工作区相对路径，拒绝绝对路径：${relPath}`);
  }
  if (escapesWorkspace(normalized)) {
    throw new Error(`本地文件路径含 ".."，逃逸工作区边界，拒绝：${relPath}`);
  }
  return normalized;
}

async function readLocalText(relPath: string): Promise<string> {
  const normalized = assertWorkspaceRelative(relPath);
  return readFile(path.resolve(process.cwd(), normalized), 'utf8');
}

async function readLocalBytes(relPath: string): Promise<Buffer> {
  const normalized = assertWorkspaceRelative(relPath);
  return readFile(path.resolve(process.cwd(), normalized));
}

function assetContentType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.zip') return 'application/zip';
  if (ext === '.gz' || ext === '.tgz') return 'application/gzip';
  if (ext === '.json') return 'application/json';
  return 'application/octet-stream';
}

// ── 失败日志辅助（沿用 tools.ts，源自 Codex inspect_pr_checks.py） ──

const FAILURE_MARKERS = ['error', 'fail', 'failed', 'traceback', 'exception', 'assert', 'panic', 'fatal', 'timeout', 'segmentation fault'];

function extractFailureSnippet(logText: string, maxLines: number): string {
  const lines = logText.split('\n');
  if (!lines.length) return '';

  let markerIndex: number | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const lowered = lines[i].toLowerCase();
    if (FAILURE_MARKERS.some((m) => lowered.includes(m))) {
      markerIndex = i;
      break;
    }
  }

  if (markerIndex === null) {
    return lines.slice(-maxLines).join('\n');
  }

  const context = 30;
  const start = Math.max(0, markerIndex - context);
  const end = Math.min(lines.length, markerIndex + context);
  let window = lines.slice(start, end);
  if (window.length > maxLines) {
    window = window.slice(-maxLines);
  }
  return window.join('\n');
}

function extractRunIdFromUrl(url: string): string | null {
  const match = url.match(/\/actions\/runs\/(\d+)/);
  return match ? match[1] : null;
}

// ── adapter 组装 ───────────────────────────────────────────

const REPO_FLAGS_VALUED = ['--owner=', '--repo='];

export function createGitHubShellAdapters(
  client: GitHubClient,
  defaults: GitHubToolDefaults,
  enabledToolsets: ReadonlySet<string>,
): AdapterMap {
  const adapters: AdapterMap = {};
  const has = (toolsetId: string) => enabledToolsets.has(toolsetId);
  const add = (key: string, fn: (args: string[]) => Promise<string>) => {
    adapters[key] = fn;
  };

  // ── context ──────────────────────────────────────────────

  if (has('context')) {
    add('github:get-me', async () => {
      const user = await client.get('/user');
      const lines = [
        `Authenticated as: ${user.login}`,
        `Name: ${user.name || '(not set)'}`,
        `ID: ${user.id}`,
      ];
      if (user.plan?.name) lines.push(`Plan: ${user.plan.name}`);
      if (user.public_repos !== undefined) lines.push(`Public repos: ${user.public_repos}`);
      if (user.followers !== undefined) lines.push(`Followers: ${user.followers}`);
      return lines.join('\n');
    });
  }

  // ── repo ─────────────────────────────────────────────────

  if (has('repo')) {
    add('github:get-repo', async (args) => {
      const parsed = parseCommandArgs(args, { valued: REPO_FLAGS_VALUED });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const r = await client.get(`/repos/${owner}/${repo}`);
      return [
        `${r.full_name} (${r.visibility || (r.private ? 'private' : 'public')})`,
        `Description: ${r.description || '(none)'}`,
        `Default branch: ${r.default_branch}`,
        `Stars: ${r.stargazers_count} | Forks: ${r.forks_count} | Open issues+PRs: ${r.open_issues_count}`,
        `URL: ${r.html_url}`,
      ].join('\n');
    });

    add('github:list-tags', async (args) => {
      const parsed = parseCommandArgs(args, { valued: ['--per-page=', ...REPO_FLAGS_VALUED] });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const data = await client.get(`/repos/${owner}/${repo}/tags`, {
        per_page: optionalInt(parsed, '--per-page=', 30),
      });
      const tags = (data || []).map((t: any) =>
        `  ${t.name} → ${t.commit?.sha?.slice(0, 7) || '?'}`
      );
      return `Tags (${data.length}):\n${tags.join('\n') || '(none)'}`;
    });

    add('github:get-file-contents', async (args) => {
      const parsed = parseCommandArgs(args, { valued: ['--ref=', ...REPO_FLAGS_VALUED] });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const filePath = parsed.positionals[0] || '';
      const ref = parsed.values.get('--ref=');
      const data = await client.get(`/repos/${owner}/${repo}/contents/${filePath}`, { ref });

      if (Array.isArray(data)) {
        const listing = data.map((item: any) => `  ${item.type === 'dir' ? '[dir]' : '[file]'} ${item.name}`).join('\n');
        return `Contents of ${filePath || '/'}:\n${listing || '(empty)'}`;
      }
      if (data.type === 'file' && data.content) {
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        return truncate(content, 30000);
      }
      return JSON.stringify(data, null, 2).slice(0, 5000);
    });

    add('github:search-code', async (args) => {
      const parsed = parseCommandArgs(args, { valued: ['--per-page='] });
      const data = await client.get('/search/code', { q: parsed.positionals[0], per_page: optionalInt(parsed, '--per-page=', 20) });
      const items = (data.items || []).map((item: any) =>
        `  ${item.repository?.full_name || ''}: ${item.path} (score: ${item.score?.toFixed(2) || 'n/a'})`
      );
      return `Found ${data.total_count} result(s):\n${items.join('\n') || '(no results)'}`;
    });

    add('github:search-repos', async (args) => {
      const parsed = parseCommandArgs(args, { valued: ['--per-page='] });
      const data = await client.get('/search/repositories', { q: parsed.positionals[0], per_page: optionalInt(parsed, '--per-page=', 20) });
      const items = (data.items || []).map((item: any) =>
        `  ${item.full_name} (★${item.stargazers_count}) — ${item.description || '(no description)'}`
      );
      return `Found ${data.total_count} repositor(y/ies):\n${items.join('\n') || '(no results)'}`;
    });

    add('github:list-commits', async (args) => {
      const parsed = parseCommandArgs(args, { valued: ['--path=', '--per-page=', ...REPO_FLAGS_VALUED] });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const data = await client.get(`/repos/${owner}/${repo}/commits`, {
        sha: parsed.positionals[0] || undefined,
        path: parsed.values.get('--path=') || undefined,
        per_page: optionalInt(parsed, '--per-page=', 20),
      });
      const commits = (data || []).map((c: any) =>
        `  ${c.sha?.slice(0, 7)} ${c.commit?.message?.split('\n')[0] || '(no message)'} — ${c.commit?.author?.name || 'unknown'}`
      );
      return `Commits (${data.length}):\n${commits.join('\n')}`;
    });

    add('github:get-commit', async (args) => {
      const parsed = parseCommandArgs(args, { valued: REPO_FLAGS_VALUED });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const data = await client.get(`/repos/${owner}/${repo}/commits/${parsed.positionals[0]}`);
      const files = (data.files || []).map((f: any) =>
        `  ${f.status}: ${f.filename} (+${f.additions}/-${f.deletions})`
      );
      return [
        `Commit: ${data.sha?.slice(0, 7)}`,
        `Author: ${data.commit?.author?.name || 'unknown'}`,
        `Message: ${data.commit?.message || '(none)'}`,
        `Stats: +${data.stats?.additions || 0}/-${data.stats?.deletions || 0} across ${data.files?.length || 0} file(s)`,
        'Files:',
        ...files,
      ].join('\n');
    });

    add('github:list-branches', async (args) => {
      const parsed = parseCommandArgs(args, { valued: ['--per-page=', ...REPO_FLAGS_VALUED] });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const data = await client.get(`/repos/${owner}/${repo}/branches`, {
        per_page: optionalInt(parsed, '--per-page=', 30),
      });
      const branches = (data || []).map((b: any) =>
        `  ${b.name}${b.protected ? ' (protected)' : ''} → ${b.commit?.sha?.slice(0, 7) || ''}`
      );
      return `Branches (${data.length}):\n${branches.join('\n')}`;
    });

    add('github:create-branch', async (args) => {
      const parsed = parseCommandArgs(args, { valued: REPO_FLAGS_VALUED });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const branch = parsed.positionals[0];

      let fromRef = parsed.positionals[1];
      if (!fromRef) {
        const repoInfo = await client.get(`/repos/${owner}/${repo}`);
        fromRef = repoInfo.default_branch;
      }
      const refData = await client.get(`/repos/${owner}/${repo}/git/ref/heads/${fromRef}`);
      const sha = refData.object?.sha;
      if (!sha) throw new Error(`Could not resolve SHA for ref "${fromRef}".`);

      await client.post(`/repos/${owner}/${repo}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha,
      });
      return `Created branch "${branch}" from "${fromRef}" (${sha.slice(0, 7)}).`;
    });

    add('github:create-or-update-file', async (args) => {
      const usage = 'create-or-update-file <仓库内路径> --message=<提交信息> --content=<内容> [--branch=<分支>] [--sha=<blob-sha>]';
      const parsed = parseCommandArgs(args, { valued: ['--message=', '--content=', '--branch=', '--sha=', ...REPO_FLAGS_VALUED] });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const filePath = parsed.positionals[0];
      const message = requireValue(parsed, '--message=', usage);
      const content = requireValue(parsed, '--content=', usage);
      const branch = parsed.values.get('--branch=');
      const sha = parsed.values.get('--sha=');

      const encodedContent = Buffer.from(content, 'utf8').toString('base64');
      const data = await client.put(`/repos/${owner}/${repo}/contents/${filePath}`, {
        message,
        content: encodedContent,
        branch,
        sha,
      });
      return `File "${filePath}" ${sha ? 'updated' : 'created'} on branch "${branch || 'default'}". Commit: ${data.commit?.sha?.slice(0, 7) || 'unknown'}.`;
    });

    add('github:get-tree', async (args) => {
      const parsed = parseCommandArgs(args, { valued: ['--recursive=', ...REPO_FLAGS_VALUED] });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const treeSha = parsed.positionals[0] || 'HEAD';
      const recursive = boolValue(parsed, '--recursive=', true);
      const data = await client.get(`/repos/${owner}/${repo}/git/trees/${treeSha}`, {
        recursive: recursive ? '1' : undefined,
      });
      const entries = (data.tree || []).map((item: any) =>
        `  ${item.type === 'tree' ? '[dir]' : item.type === 'blob' ? '[file]' : `[${item.type}]`} ${item.path}`
      );
      return truncate(`Tree (${data.tree?.length || 0} entries, truncated: ${data.truncated || false}):\n${entries.join('\n')}`, 30000);
    });
  }

  // ── issues ───────────────────────────────────────────────

  if (has('issues')) {
    add('github:list-issues', async (args) => {
      const parsed = parseCommandArgs(args, { valued: ['--state=', '--labels=', '--per-page=', ...REPO_FLAGS_VALUED] });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const data = await client.get(`/repos/${owner}/${repo}/issues`, {
        state: enumValue(parsed, '--state=', ['open', 'closed', 'all'], 'open')!,
        labels: parsed.values.get('--labels=') || undefined,
        per_page: optionalInt(parsed, '--per-page=', 30),
      });
      // GitHub 的 issues 端点会混入 PR，滤掉
      const issues = (data || []).filter((item: any) => !item.pull_request);
      const lines = issues.map((i: any) =>
        `  #${i.number} [${i.state}] ${i.title} — by ${i.user?.login || 'unknown'}${i.labels?.length ? ` [${i.labels.map((l: any) => l.name).join(',')}]` : ''}`
      );
      return `Issues (${issues.length}):\n${lines.join('\n') || '(none)'}`;
    });

    add('github:get-issue', async (args) => {
      const parsed = parseCommandArgs(args, { valued: REPO_FLAGS_VALUED });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const number = intArg(parsed.positionals[0], '<编号>');
      const data = await client.get(`/repos/${owner}/${repo}/issues/${number}`);
      const lines = [
        `#${data.number} [${data.state}] ${data.title}`,
        `By ${data.user?.login || 'unknown'} on ${data.created_at?.split('T')[0] || '?'}`,
        `Comments: ${data.comments}`,
      ];
      if (data.labels?.length) lines.push(`Labels: ${data.labels.map((l: any) => l.name).join(', ')}`);
      if (data.assignees?.length) lines.push(`Assignees: ${data.assignees.map((a: any) => a.login).join(', ')}`);
      if (data.body) lines.push('', truncate(data.body, 10000));
      return lines.join('\n');
    });

    add('github:search-issues', async (args) => {
      const parsed = parseCommandArgs(args, { valued: ['--per-page='] });
      const data = await client.get('/search/issues', { q: parsed.positionals[0], per_page: optionalInt(parsed, '--per-page=', 20) });
      const items = (data.items || []).map((item: any) => {
        const type = item.pull_request ? 'PR' : 'Issue';
        return `  ${type} #${item.number} [${item.state}] ${item.title} — ${item.repository_url?.split('/').slice(-2).join('/') || ''}`;
      });
      return `Found ${data.total_count} result(s):\n${items.join('\n') || '(no results)'}`;
    });

    add('github:get-issue-comments', async (args) => {
      const parsed = parseCommandArgs(args, { valued: ['--per-page=', ...REPO_FLAGS_VALUED] });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const number = intArg(parsed.positionals[0], '<编号>');
      const data = await client.get(`/repos/${owner}/${repo}/issues/${number}/comments`, {
        per_page: optionalInt(parsed, '--per-page=', 30),
      });
      const comments = (data || []).map((c: any) =>
        `  @${c.user?.login || '?'} on ${c.created_at?.split('T')[0] || '?'}:\n${truncate(c.body || '', 4000)}`
      );
      return `Comments on #${number} (${data.length}):\n\n${comments.join('\n\n') || '(none)'}`;
    });

    add('github:create-issue', async (args) => {
      const parsed = parseCommandArgs(args, { valued: ['--body=', '--labels=', '--assignees=', ...REPO_FLAGS_VALUED] });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const body: Record<string, unknown> = { title: parsed.positionals[0] };
      const bodyText = parsed.values.get('--body=');
      if (bodyText) body.body = bodyText;
      const labels = csvList(parsed, '--labels=');
      if (labels) body.labels = labels;
      const assignees = csvList(parsed, '--assignees=');
      if (assignees) body.assignees = assignees;
      const data = await client.post(`/repos/${owner}/${repo}/issues`, body);
      return `Created issue #${data.number}: ${data.title}\nURL: ${data.html_url}`;
    });

    add('github:update-issue', async (args) => {
      const parsed = parseCommandArgs(args, { valued: ['--title=', '--body=', '--state=', '--labels=', '--assignees=', '--milestone=', ...REPO_FLAGS_VALUED] });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const number = intArg(parsed.positionals[0], '<编号>');
      const body: Record<string, unknown> = {};
      const title = parsed.values.get('--title=');
      if (title) body.title = title;
      const bodyText = parsed.values.get('--body=');
      if (bodyText) body.body = bodyText;
      const state = enumValue(parsed, '--state=', ['open', 'closed']);
      if (state) body.state = state;
      const labels = csvList(parsed, '--labels=');
      if (labels) body.labels = labels;
      const assignees = csvList(parsed, '--assignees=');
      if (assignees) body.assignees = assignees;
      const milestoneRaw = parsed.values.get('--milestone=');
      if (milestoneRaw !== undefined) body.milestone = milestoneRaw === '' ? null : intArg(milestoneRaw, '--milestone=');
      const data = await client.patch(`/repos/${owner}/${repo}/issues/${number}`, body);
      return `Updated issue #${data.number}: ${data.title} [${data.state}]\nURL: ${data.html_url}`;
    });

    add('github:add-issue-comment', async (args) => {
      const usage = "add-issue-comment <编号> --body='<markdown>'";
      const parsed = parseCommandArgs(args, { valued: ['--body=', ...REPO_FLAGS_VALUED] });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const number = intArg(parsed.positionals[0], '<编号>');
      const body = requireValue(parsed, '--body=', usage);
      const data = await client.post(`/repos/${owner}/${repo}/issues/${number}/comments`, { body });
      return `Comment added to #${number}.\nURL: ${data.html_url}`;
    });
  }

  // ── pull request ─────────────────────────────────────────

  if (has('pr')) {
    add('github:list-prs', async (args) => {
      const parsed = parseCommandArgs(args, { valued: ['--state=', '--per-page=', ...REPO_FLAGS_VALUED] });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const data = await client.get(`/repos/${owner}/${repo}/pulls`, {
        state: enumValue(parsed, '--state=', ['open', 'closed', 'all'], 'open')!,
        per_page: optionalInt(parsed, '--per-page=', 30),
      });
      const lines = (data || []).map((pr: any) =>
        `  #${pr.number} [${pr.state}${pr.draft ? '/draft' : ''}] ${pr.title} — ${pr.user?.login || '?'} → ${pr.base?.ref}`
      );
      return `Pull Requests (${data.length}):\n${lines.join('\n') || '(none)'}`;
    });

    add('github:get-pr', async (args) => {
      const parsed = parseCommandArgs(args, { valued: REPO_FLAGS_VALUED });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const number = intArg(parsed.positionals[0], '<编号>');
      const [pr, files] = await Promise.all([
        client.get(`/repos/${owner}/${repo}/pulls/${number}`),
        client.get(`/repos/${owner}/${repo}/pulls/${number}/files`),
      ]);
      const fileList = (files || []).map((f: any) =>
        `  ${f.status}: ${f.filename} (+${f.additions}/-${f.deletions})`
      );
      const lines = [
        `PR #${pr.number} [${pr.state}${pr.draft ? '/draft' : ''}] ${pr.title}`,
        `By ${pr.user?.login || '?'} → ${pr.base?.ref}`,
        `Mergeable: ${pr.mergeable === null ? 'checking...' : pr.mergeable ? 'yes' : 'no'} (status: ${pr.mergeable_state || '?'})`,
        `Changes: +${pr.additions}/-${pr.deletions} in ${pr.changed_files} file(s)`,
        'Files:',
        ...fileList,
      ];
      if (pr.body) lines.push('', 'Description:', truncate(pr.body, 8000));
      return lines.join('\n');
    });

    add('github:search-prs', async (args) => {
      const parsed = parseCommandArgs(args, { valued: ['--per-page='] });
      const query = parsed.positionals[0];
      const q = query.includes('is:pr') ? query : `${query} is:pr`;
      const data = await client.get('/search/issues', { q, per_page: optionalInt(parsed, '--per-page=', 20) });
      const items = (data.items || []).map((item: any) =>
        `  PR #${item.number} [${item.state}] ${item.title} — ${item.repository_url?.split('/').slice(-2).join('/') || ''}`
      );
      return `Found ${data.total_count} PR(s):\n${items.join('\n') || '(no results)'}`;
    });

    add('github:create-pr', async (args) => {
      const usage = "create-pr '<标题>' --head=<源分支> [--base=<目标分支>] [--body=<markdown>] [--draft]";
      const parsed = parseCommandArgs(args, { plain: ['--draft'], valued: ['--head=', '--base=', '--body=', ...REPO_FLAGS_VALUED] });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const head = requireValue(parsed, '--head=', usage);
      const body: Record<string, unknown> = { title: parsed.positionals[0], head };
      const base = parsed.values.get('--base=');
      if (base) body.base = base;
      const bodyText = parsed.values.get('--body=');
      if (bodyText) body.body = bodyText;
      if (parsed.plain.has('--draft')) body.draft = true;
      const data = await client.post(`/repos/${owner}/${repo}/pulls`, body);
      return `Created PR #${data.number}: ${data.title}\nURL: ${data.html_url}`;
    });

    add('github:update-pr', async (args) => {
      const parsed = parseCommandArgs(args, { valued: ['--title=', '--body=', '--state=', '--base=', ...REPO_FLAGS_VALUED] });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const number = intArg(parsed.positionals[0], '<编号>');
      const body: Record<string, unknown> = {};
      const title = parsed.values.get('--title=');
      if (title) body.title = title;
      const bodyText = parsed.values.get('--body=');
      if (bodyText) body.body = bodyText;
      const state = enumValue(parsed, '--state=', ['open', 'closed']);
      if (state) body.state = state;
      const base = parsed.values.get('--base=');
      if (base) body.base = base;
      const data = await client.patch(`/repos/${owner}/${repo}/pulls/${number}`, body);
      return `Updated PR #${data.number}: ${data.title} [${data.state}]\nURL: ${data.html_url}`;
    });

    add('github:update-pr-branch', async (args) => {
      const parsed = parseCommandArgs(args, { valued: REPO_FLAGS_VALUED });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const number = intArg(parsed.positionals[0], '<编号>');
      const data = await client.put(`/repos/${owner}/${repo}/pulls/${number}/update-branch`, {});
      return `Update branch requested on PR #${number}: ${data.message || 'queued'}.`;
    });

    add('github:merge-pr', async (args) => {
      const parsed = parseCommandArgs(args, { valued: ['--method=', '--title=', ...REPO_FLAGS_VALUED] });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const number = intArg(parsed.positionals[0], '<编号>');
      const body: Record<string, unknown> = {};
      const method = enumValue(parsed, '--method=', ['merge', 'squash', 'rebase']);
      if (method) body.merge_method = method;
      const commitTitle = parsed.values.get('--title=');
      if (commitTitle) body.commit_title = commitTitle;
      const data = await client.put(`/repos/${owner}/${repo}/pulls/${number}/merge`, body);
      return `PR #${number} ${data.merged ? 'merged' : 'merge attempted'}: ${data.message || ''}`;
    });

    add('github:get-pr-reviews', async (args) => {
      const parsed = parseCommandArgs(args, { valued: REPO_FLAGS_VALUED });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const number = intArg(parsed.positionals[0], '<编号>');
      const data = await client.get(`/repos/${owner}/${repo}/pulls/${number}/reviews`);
      const reviews = (data || []).map((r: any) =>
        `  [${r.state}] by ${r.user?.login || '?'} on ${r.submitted_at?.split('T')[0] || '?'}${r.body ? `: ${truncate(r.body, 200)}` : ''}`
      );
      return `Reviews (${data.length}):\n${reviews.join('\n') || '(none)'}`;
    });

    add('github:get-pr-review-threads', async (args) => {
      const parsed = parseCommandArgs(args, { valued: REPO_FLAGS_VALUED });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const number = intArg(parsed.positionals[0], '<编号>');

      const query = `query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewThreads(first: 100) {
              nodes {
                id
                isResolved
                isOutdated
                path
                line
                diffSide
                resolvedBy { login }
                comments(first: 50) {
                  nodes {
                    id
                    body
                    author { login }
                    createdAt
                  }
                }
              }
            }
          }
        }
      }`;

      const data = await client.graphql(query, { owner, repo, number });
      const threads = data?.repository?.pullRequest?.reviewThreads?.nodes || [];
      const lines = threads.map((t: any) => {
        const status = [
          t.isResolved ? 'resolved' : 'open',
          t.isOutdated ? 'outdated' : 'current',
        ].join('/');
        const comments = (t.comments?.nodes || []).map((c: any) =>
          `    ${c.author?.login || '?'}: ${truncate(c.body || '', 300)}`
        ).join('\n');
        return `  [${status}] ${t.path}:${t.line || '?'} (${t.comments?.nodes?.length || 0} comment(s))\n${comments}`;
      });

      const actionable = threads.filter((t: any) => !t.isResolved && !t.isOutdated).length;
      return `Review threads (${threads.length} total, ${actionable} actionable):\n${lines.join('\n') || '(none)'}`;
    });

    add('github:create-pr-review', async (args) => {
      const usage = "create-pr-review <编号> --event=<APPROVE|REQUEST_CHANGES|COMMENT> [--body='<markdown>'] [--comments='<JSON数组>']";
      const parsed = parseCommandArgs(args, { valued: ['--event=', '--body=', '--comments=', ...REPO_FLAGS_VALUED] });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const number = intArg(parsed.positionals[0], '<编号>');
      const event = requireValue(parsed, '--event=', usage);
      if (!['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(event)) {
        throw new Error(`--event= 只允许 APPROVE|REQUEST_CHANGES|COMMENT，收到 "${event}"`);
      }
      const body: Record<string, unknown> = { event };
      const bodyText = parsed.values.get('--body=');
      if (bodyText) body.body = bodyText;

      const commentsRaw = parsed.values.get('--comments=');
      if (commentsRaw !== undefined && commentsRaw !== '') {
        let parsedComments: unknown;
        try {
          parsedComments = JSON.parse(commentsRaw);
        } catch {
          throw new Error('--comments= 必须是合法 JSON 数组（每项 path/line/side/body）');
        }
        if (!Array.isArray(parsedComments) || (parsedComments as any[]).some((c) => !c?.path || !c?.body)) {
          throw new Error('--comments= 数组每项必须包含 path 与 body（line 可选整数、side 可选 LEFT|RIGHT）');
        }
        body.comments = (parsedComments as any[]).map((c) => ({
          path: c.path,
          line: c.line,
          side: c.side || 'RIGHT',
          body: c.body,
        }));
      }

      await client.post(`/repos/${owner}/${repo}/pulls/${number}/reviews`, body);
      return `Review submitted (${event}) on PR #${number}.`;
    });

    add('github:reply-pr-comment', async (args) => {
      const usage = "reply-pr-comment <PR编号> <评论ID> --body='<markdown>'";
      const parsed = parseCommandArgs(args, { valued: ['--body=', ...REPO_FLAGS_VALUED] });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const number = intArg(parsed.positionals[0], '<PR编号>');
      const commentId = intArg(parsed.positionals[1], '<评论ID>');
      const body = requireValue(parsed, '--body=', usage);
      const data = await client.post(
        `/repos/${owner}/${repo}/pulls/${number}/comments/${commentId}/replies`,
        { body },
      );
      return `Reply posted to comment ${commentId} on PR #${number}.\nURL: ${data.html_url}`;
    });
  }

  // ── actions / CI ─────────────────────────────────────────

  if (has('actions')) {
    add('github:list-workflows', async (args) => {
      const parsed = parseCommandArgs(args, { valued: REPO_FLAGS_VALUED });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const data = await client.get(`/repos/${owner}/${repo}/actions/workflows`);
      const workflows = (data.workflows || []).map((w: any) =>
        `  ${w.id} "${w.name}" (${w.path}) [${w.state}]`
      );
      return `Workflows (${data.total_count ?? (data.workflows || []).length}):\n${workflows.join('\n') || '(none)'}`;
    });

    add('github:rerun-workflow-run', async (args) => {
      const parsed = parseCommandArgs(args, { plain: ['--failed-only'], valued: REPO_FLAGS_VALUED });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const runId = intArg(parsed.positionals[0], '<run-id>');
      const failedOnly = parsed.plain.has('--failed-only');
      await client.post(`/repos/${owner}/${repo}/actions/runs/${runId}/${failedOnly ? 'rerun-failed-jobs' : 'rerun'}`, {});
      return `Rerun requested for run ${runId}${failedOnly ? ' (failed jobs only)' : ''}.`;
    });

    add('github:cancel-workflow-run', async (args) => {
      const parsed = parseCommandArgs(args, { valued: REPO_FLAGS_VALUED });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const runId = intArg(parsed.positionals[0], '<run-id>');
      await client.post(`/repos/${owner}/${repo}/actions/runs/${runId}/cancel`, {});
      return `Cancel requested for run ${runId}.`;
    });

    add('github:list-workflow-runs', async (args) => {
      const parsed = parseCommandArgs(args, { valued: ['--branch=', '--event=', '--status=', '--per-page=', ...REPO_FLAGS_VALUED] });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const data = await client.get(`/repos/${owner}/${repo}/actions/runs`, {
        event: parsed.values.get('--event=') || undefined,
        status: parsed.values.get('--status=') || undefined,
        branch: parsed.values.get('--branch=') || undefined,
        per_page: optionalInt(parsed, '--per-page=', 20),
      });
      const runs = (data.workflow_runs || []).map((r: any) =>
        `  ${r.id} [${r.status}/${r.conclusion || '-'}] ${r.name || r.workflow_id} — ${r.head_branch} (${r.event}) ${r.html_url}`
      );
      return `Workflow runs (${data.total_count} total, showing ${runs.length}):\n${runs.join('\n') || '(none)'}`;
    });

    add('github:get-workflow-run', async (args) => {
      const parsed = parseCommandArgs(args, { valued: REPO_FLAGS_VALUED });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const runId = intArg(parsed.positionals[0], '<run-id>');
      const [run, jobsData] = await Promise.all([
        client.get(`/repos/${owner}/${repo}/actions/runs/${runId}`),
        client.get(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs`),
      ]);
      const jobs = (jobsData.jobs || []).map((j: any) =>
        `  ${j.name}: ${j.status}/${j.conclusion || '-'} (id: ${j.id})`
      );
      return [
        `Run ${run.id}: ${run.name || '?'}`,
        `Status: ${run.status}/${run.conclusion || '-'}`,
        `Event: ${run.event} | Branch: ${run.head_branch}`,
        `URL: ${run.html_url}`,
        'Jobs:',
        ...jobs,
      ].join('\n');
    });

    add('github:get-job-logs', async (args) => {
      const parsed = parseCommandArgs(args, { valued: ['--max-lines=', ...REPO_FLAGS_VALUED] });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const jobId = intArg(parsed.positionals[0], '<job-id>');
      const logText = await client.fetchRawText(`/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`);
      if (!logText) throw new Error('Job logs are empty or still pending.');
      return truncate(extractFailureSnippet(logText, optionalInt(parsed, '--max-lines=', 160)), 30000);
    });

    add('github:list-pr-checks', async (args) => {
      const parsed = parseCommandArgs(args, { valued: REPO_FLAGS_VALUED });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const data = await client.get(`/repos/${owner}/${repo}/commits/${parsed.positionals[0]}/check-runs`, {
        per_page: 100,
      });
      const checks = (data.check_runs || []).map((c: any) =>
        `  ${c.name}: ${c.status}/${c.conclusion || '-'} ${c.html_url}`
      );
      const failing = (data.check_runs || []).filter((c: any) =>
        ['failure', 'cancelled', 'timed_out', 'action_required'].includes(c.conclusion)
      );
      const lines = [
        `Check runs (${data.total_count || 0} total, ${failing.length} failing):`,
        ...checks,
      ];
      if (failing.length > 0) {
        lines.push('', 'Failing checks:');
        for (const f of failing) {
          const runId = extractRunIdFromUrl(f.details_url || f.html_url || '');
          lines.push(`  ${f.name} (conclusion: ${f.conclusion})${runId ? ` run_id: ${runId}` : ''} ${f.html_url}`);
        }
      }
      return lines.join('\n');
    });
  }

  // ── releases ─────────────────────────────────────────────

  if (has('releases')) {
    add('github:create-release', async (args) => {
      const parsed = parseCommandArgs(args, {
        plain: ['--draft', '--prerelease'],
        valued: ['--title=', '--notes=', '--notes-file=', '--target-commitish=', ...REPO_FLAGS_VALUED],
        repeatable: ['--asset='],
      });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const tag = parsed.positionals[0];

      const notesFile = parsed.values.get('--notes-file=');
      const notesInline = parsed.values.get('--notes=');
      if (notesFile !== undefined && notesInline !== undefined) {
        throw new Error('--notes-file= 与 --notes= 只能用其一');
      }
      let body: string | undefined;
      if (notesFile !== undefined && notesFile !== '') body = await readLocalText(notesFile);
      else if (notesInline !== undefined) body = notesInline;

      const payload: Record<string, unknown> = {
        tag_name: tag,
        name: parsed.values.get('--title=') || tag,
        draft: parsed.plain.has('--draft'),
        prerelease: parsed.plain.has('--prerelease'),
      };
      if (body !== undefined) payload.body = body;
      const target = parsed.values.get('--target-commitish=');
      if (target) payload.target_commitish = target;

      const release = await client.post(`/repos/${owner}/${repo}/releases`, payload);
      const lines = [
        `Release created: ${release.tag_name} "${release.name}"${payload.draft ? ' [draft]' : ''}${payload.prerelease ? ' [prerelease]' : ''}`,
        `URL: ${release.html_url}`,
      ];

      const assets = parsed.multi.get('--asset=') ?? [];
      if (!assets.length) {
        lines.push('Assets: (none)');
        return lines.join('\n');
      }
      lines.push('Assets:');
      for (const assetPath of assets) {
        const data = await readLocalBytes(assetPath);
        const name = path.basename(assetPath.replace(/\\/g, '/'));
        try {
          const uploaded = await client.uploadReleaseAsset(release.upload_url, name, data, assetContentType(name));
          lines.push(`  ${name} (${data.length} bytes) → ${uploaded?.browser_download_url || 'uploaded'}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Release ${tag} 已创建（${release.html_url}），但资产 ${name} 上传失败：${msg}`);
        }
      }
      return lines.join('\n');
    });

    add('github:get-release', async (args) => {
      const parsed = parseCommandArgs(args, { valued: REPO_FLAGS_VALUED });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const tag = parsed.positionals[0];
      const r = await client.get(`/repos/${owner}/${repo}/releases/tags/${tag}`);
      const assets = (r.assets || []).map((a: any) =>
        `  ${a.name} (${a.size} bytes, ${a.download_count} downloads) → ${a.browser_download_url}`
      );
      return [
        `${r.tag_name} "${r.name || r.tag_name}"${r.draft ? ' [draft]' : ''}${r.prerelease ? ' [prerelease]' : ''} — ${r.published_at?.split('T')[0] || '未发布'}`,
        `URL: ${r.html_url}`,
        '',
        truncate(r.body || '(no body)', 20000),
        '',
        `Assets (${r.assets?.length || 0}):`,
        ...assets,
      ].join('\n');
    });

    add('github:update-release', async (args) => {
      const usage = "update-release <tag> [--title='<标题>'] [--notes-file=<路径>|--notes='<markdown>'] [--draft=<true|false>] [--prerelease=<true|false>]";
      const parsed = parseCommandArgs(args, {
        valued: ['--title=', '--notes=', '--notes-file=', '--draft=', '--prerelease=', ...REPO_FLAGS_VALUED],
      });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const tag = parsed.positionals[0];

      const notesFile = parsed.values.get('--notes-file=');
      const notesInline = parsed.values.get('--notes=');
      if (notesFile !== undefined && notesInline !== undefined) {
        throw new Error('--notes-file= 与 --notes= 只能用其一');
      }
      let notes: string | undefined;
      if (notesFile !== undefined && notesFile !== '') notes = await readLocalText(notesFile);
      else if (notesInline !== undefined) notes = notesInline;

      const payload: Record<string, unknown> = {};
      const title = parsed.values.get('--title=');
      if (title) payload.name = title;
      if (notes !== undefined) payload.body = notes;
      const draftRaw = parsed.values.get('--draft=');
      if (draftRaw !== undefined && draftRaw !== '') payload.draft = boolValue(parsed, '--draft=', true);
      const prereleaseRaw = parsed.values.get('--prerelease=');
      if (prereleaseRaw !== undefined && prereleaseRaw !== '') payload.prerelease = boolValue(parsed, '--prerelease=', true);
      if (!Object.keys(payload).length) {
        throw new Error(`未提供任何更新字段。用法：${usage}`);
      }

      const existing = await client.get(`/repos/${owner}/${repo}/releases/tags/${tag}`);
      const data = await client.patch(`/repos/${owner}/${repo}/releases/${existing.id}`, payload);
      return `Release ${data.tag_name} updated.\nURL: ${data.html_url}`;
    });

    add('github:delete-release', async (args) => {
      const parsed = parseCommandArgs(args, { valued: REPO_FLAGS_VALUED });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const tag = parsed.positionals[0];
      const existing = await client.get(`/repos/${owner}/${repo}/releases/tags/${tag}`);
      await client.delete(`/repos/${owner}/${repo}/releases/${existing.id}`);
      return `Release ${tag} deleted (the git tag itself is kept).`;
    });

    add('github:list-releases', async (args) => {
      const parsed = parseCommandArgs(args, { valued: ['--limit=', ...REPO_FLAGS_VALUED] });
      const { owner, repo } = resolveRepo(parsed, defaults);
      const data = await client.get(`/repos/${owner}/${repo}/releases`, {
        per_page: optionalInt(parsed, '--limit=', 10),
      });
      const lines = (data || []).map((r: any) =>
        `  ${r.tag_name} "${r.name || r.tag_name}"${r.draft ? ' [draft]' : ''}${r.prerelease ? ' [prerelease]' : ''} — ${r.published_at?.split('T')[0] || '未发布'}，assets: ${r.assets?.length || 0}`
      );
      return `Releases (${data.length}):\n${lines.join('\n') || '(none)'}`;
    });
  }

  // ── notifications ────────────────────────────────────────

  if (has('notifications')) {
    add('github:list-notifications', async (args) => {
      const parsed = parseCommandArgs(args, { plain: ['--all', '--participating'], valued: ['--per-page='] });
      const data = await client.get('/notifications', {
        all: parsed.plain.has('--all') ? 'true' : undefined,
        participating: parsed.plain.has('--participating') ? 'true' : undefined,
        per_page: optionalInt(parsed, '--per-page=', 20),
      });
      const notifs = (data || []).map((n: any) =>
        `  ${n.reason}: ${n.subject?.type} "${n.subject?.title}" in ${n.repository?.full_name} (updated ${n.updated_at?.split('T')[0] || '?'})`
      );
      return `Notifications (${data.length}):\n${notifs.join('\n') || '(none)'}`;
    });

    add('github:mark-notification-read', async (args) => {
      const parsed = parseCommandArgs(args);
      const threadId = parsed.positionals[0];
      await client.patch(`/notifications/threads/${threadId}`);
      return `Notification ${threadId} marked as read.`;
    });
  }

  return adapters;
}
