/**
 * GitHub Feature 工具集定义
 *
 * 每个工具通过 GitHubClient 调用 GitHub REST/GraphQL API，
 * 返回 { success: true, text: '...' } 或 { error: '...' } 格式。
 *
 * 工具按领域分组，可通过 manifest 配置选择性启用。
 */

import type { Tool } from 'agentdev';
import { GitHubClient } from './client.js';

// ── 辅助类型 ───────────────────────────────────────────────

export interface GitHubToolDefaults {
  defaultOwner?: string;
  defaultRepo?: string;
}

interface RepoArgs {
  owner?: string;
  repo?: string;
}

function resolveRepo(args: RepoArgs, defaults: GitHubToolDefaults): { owner: string; repo: string } {
  const owner = args?.owner?.trim() || defaults.defaultOwner || '';
  const repo = args?.repo?.trim() || defaults.defaultRepo || '';
  return { owner, repo };
}

function requireRepo(args: RepoArgs, defaults: GitHubToolDefaults): { owner: string; repo: string } | { error: string } {
  const { owner, repo } = resolveRepo(args, defaults);
  if (!owner || !repo) {
    return { error: 'owner and repo are required. Provide them as parameters or configure defaultOwner/defaultRepo in Runtime Config.' };
  }
  return { owner, repo };
}

function formatResult(text: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return { success: true, text, ...extra };
}

function formatError(err: unknown): Record<string, unknown> {
  const msg = err instanceof Error ? err.message : String(err);
  return { error: msg };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + `\n...(truncated, ${text.length} chars total)`;
}

// ── Context 工具 ──────────────────────────────────────────

function contextTools(client: GitHubClient): Tool[] {
  return [
    {
      name: 'gh_get_me',
      description: 'Get the authenticated GitHub user. Call this first to verify authentication and understand your permissions.',
      parameters: { type: 'object', properties: {} },
      parallelizable: true,
      execute: async () => {
        try {
          const user = await client.get('/user');
          const lines = [
            `Authenticated as: ${user.login}`,
            `Name: ${user.name || '(not set)'}`,
            `ID: ${user.id}`,
          ];
          if (user.plan?.name) lines.push(`Plan: ${user.plan.name}`);
          if (user.public_repos !== undefined) lines.push(`Public repos: ${user.public_repos}`);
          if (user.followers !== undefined) lines.push(`Followers: ${user.followers}`);
          return formatResult(lines.join('\n'), { user });
        } catch (err) {
          return formatError(err);
        }
      },
    },
  ];
}

// ── Repository 工具 ──────────────────────────────────────

function repoTools(client: GitHubClient, defaults: GitHubToolDefaults): Tool[] {
  return [
    {
      name: 'gh_get_file_contents',
      description: 'Get the contents of a file or directory from a GitHub repository. Returns file content (base64-decoded for files) or directory listing.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner. Falls back to configured default.' },
          repo: { type: 'string', description: 'Repository name. Falls back to configured default.' },
          path: { type: 'string', description: 'File or directory path. Use empty string or "." for root.' },
          ref: { type: 'string', description: 'Git ref (branch, tag, or commit SHA). Defaults to the default branch.' },
        },
      },
      parallelizable: true,
      execute: async (args: any) => {
        try {
          const resolved = requireRepo(args, defaults);
          if ('error' in resolved) return resolved;
          const path = args.path || '';
          const apiPath = `/repos/${resolved.owner}/${resolved.repo}/contents/${path}`;
          const data = await client.get(apiPath, { ref: args.ref });

          if (Array.isArray(data)) {
            const listing = data.map((item: any) => `  ${item.type === 'dir' ? '[dir]' : '[file]'} ${item.name}`).join('\n');
            return formatResult(`Contents of ${path || '/'}:\n${listing || '(empty)'}`, { entries: data });
          }

          if (data.type === 'file' && data.content) {
            const content = Buffer.from(data.content, 'base64').toString('utf8');
            return formatResult(truncate(content, 30000), {
              path: data.path,
              sha: data.sha,
              size: data.size,
              encoding: data.encoding,
            });
          }

          return formatResult(JSON.stringify(data, null, 2).slice(0, 5000));
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'gh_search_code',
      description: 'Search for code across GitHub repositories. Uses GitHub code search syntax (e.g. "repo:owner/repo function hello").',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query using GitHub code search syntax.' },
          per_page: { type: 'number', description: 'Results per page (max 100). Default 20.' },
        },
        required: ['query'],
      },
      parallelizable: true,
      execute: async (args: any) => {
        try {
          const data = await client.get('/search/code', { q: args.query, per_page: args.per_page || 20 });
          const items = (data.items || []).map((item: any) => {
            const repo = item.repository?.full_name || '';
            return `  ${repo}: ${item.path} (score: ${item.score?.toFixed(2) || 'n/a'})`;
          });
          return formatResult(`Found ${data.total_count} result(s):\n${items.join('\n') || '(no results)'}`, {
            total_count: data.total_count,
            items: data.items,
          });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'gh_search_repos',
      description: 'Search for GitHub repositories.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (e.g. "language:typescript stars:>1000 agent framework").' },
          per_page: { type: 'number', description: 'Results per page (max 100). Default 20.' },
        },
        required: ['query'],
      },
      parallelizable: true,
      execute: async (args: any) => {
        try {
          const data = await client.get('/search/repositories', { q: args.query, per_page: args.per_page || 20 });
          const items = (data.items || []).map((item: any) =>
            `  ${item.full_name} (★${item.stargazers_count}) — ${item.description || '(no description)'}`
          );
          return formatResult(`Found ${data.total_count} repositor(y/ies):\n${items.join('\n') || '(no results)'}`, {
            total_count: data.total_count,
            items: data.items,
          });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'gh_list_commits',
      description: 'List commits in a repository, optionally filtered by branch/path.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner. Falls back to configured default.' },
          repo: { type: 'string', description: 'Repository name. Falls back to configured default.' },
          sha: { type: 'string', description: 'Branch or commit SHA to start listing from.' },
          path: { type: 'string', description: 'Only commits containing changes to this file path.' },
          per_page: { type: 'number', description: 'Results per page (max 100). Default 20.' },
        },
      },
      parallelizable: true,
      execute: async (args: any) => {
        try {
          const resolved = requireRepo(args, defaults);
          if ('error' in resolved) return resolved;
          const data = await client.get(`/repos/${resolved.owner}/${resolved.repo}/commits`, {
            sha: args.sha,
            path: args.path,
            per_page: args.per_page || 20,
          });
          const commits = (data || []).map((c: any) =>
            `  ${c.sha?.slice(0, 7)} ${c.commit?.message?.split('\n')[0] || '(no message)'} — ${c.commit?.author?.name || 'unknown'}`
          );
          return formatResult(`Commits (${data.length}):\n${commits.join('\n')}`, { commits: data });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'gh_get_commit',
      description: 'Get detailed information about a specific commit, including files changed and stats.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner. Falls back to configured default.' },
          repo: { type: 'string', description: 'Repository name. Falls back to configured default.' },
          ref: { type: 'string', description: 'Commit SHA, branch name, or tag.' },
        },
        required: ['ref'],
      },
      parallelizable: true,
      execute: async (args: any) => {
        try {
          const resolved = requireRepo(args, defaults);
          if ('error' in resolved) return resolved;
          const data = await client.get(`/repos/${resolved.owner}/${resolved.repo}/commits/${args.ref}`);
          const files = (data.files || []).map((f: any) =>
            `  ${f.status}: ${f.filename} (+${f.additions}/-${f.deletions})`
          );
          const lines = [
            `Commit: ${data.sha?.slice(0, 7)}`,
            `Author: ${data.commit?.author?.name || 'unknown'}`,
            `Message: ${data.commit?.message || '(none)'}`,
            `Stats: +${data.stats?.additions || 0}/-${data.stats?.deletions || 0} across ${data.files?.length || 0} file(s)`,
            'Files:',
            ...files,
          ];
          return formatResult(lines.join('\n'), { commit: data });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'gh_list_branches',
      description: 'List branches in a repository.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner. Falls back to configured default.' },
          repo: { type: 'string', description: 'Repository name. Falls back to configured default.' },
          per_page: { type: 'number', description: 'Results per page (max 100). Default 30.' },
        },
      },
      parallelizable: true,
      execute: async (args: any) => {
        try {
          const resolved = requireRepo(args, defaults);
          if ('error' in resolved) return resolved;
          const data = await client.get(`/repos/${resolved.owner}/${resolved.repo}/branches`, {
            per_page: args.per_page || 30,
          });
          const branches = (data || []).map((b: any) =>
            `  ${b.name}${b.protected ? ' (protected)' : ''} → ${b.commit?.sha?.slice(0, 7) || ''}`
          );
          return formatResult(`Branches (${data.length}):\n${branches.join('\n')}`, { branches: data });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'gh_create_branch',
      description: 'Create a new branch from an existing ref (branch, tag, or commit SHA).',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner. Falls back to configured default.' },
          repo: { type: 'string', description: 'Repository name. Falls back to configured default.' },
          branch: { type: 'string', description: 'Name of the new branch to create.' },
          from: { type: 'string', description: 'The ref to create from. Can be a branch name, tag, or commit SHA. Defaults to the repo default branch.' },
        },
        required: ['branch'],
      },
      execute: async (args: any) => {
        try {
          const resolved = requireRepo(args, defaults);
          if ('error' in resolved) return resolved;

          // Resolve the SHA to branch from
          let fromRef = args.from;
          if (!fromRef) {
            const repoInfo = await client.get(`/repos/${resolved.owner}/${resolved.repo}`);
            fromRef = repoInfo.default_branch;
          }
          const refData = await client.get(`/repos/${resolved.owner}/${resolved.repo}/git/ref/heads/${fromRef}`);
          const sha = refData.object?.sha;
          if (!sha) return { error: `Could not resolve SHA for ref "${fromRef}".` };

          const data = await client.post(`/repos/${resolved.owner}/${resolved.repo}/git/refs`, {
            ref: `refs/heads/${args.branch}`,
            sha,
          });
          return formatResult(`Created branch "${args.branch}" from "${fromRef}" (${sha.slice(0, 7)}).`, { ref: data });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'gh_create_or_update_file',
      description: 'Create or update a single file in a repository via the GitHub API. This commits directly through the API, not through local git. Requires a commit message and file content.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner. Falls back to configured default.' },
          repo: { type: 'string', description: 'Repository name. Falls back to configured default.' },
          path: { type: 'string', description: 'Path to the file in the repository.' },
          message: { type: 'string', description: 'Commit message.' },
          content: { type: 'string', description: 'New file content (plain text, will be base64-encoded by the tool).' },
          branch: { type: 'string', description: 'Target branch. Defaults to the repo default branch.' },
          sha: { type: 'string', description: 'Required when updating an existing file (the blob SHA of the file being replaced).' },
        },
        required: ['path', 'message', 'content'],
      },
      execute: async (args: any) => {
        try {
          const resolved = requireRepo(args, defaults);
          if ('error' in resolved) return resolved;
          const encodedContent = Buffer.from(args.content, 'utf8').toString('base64');
          const data = await client.put(`/repos/${resolved.owner}/${resolved.repo}/contents/${args.path}`, {
            message: args.message,
            content: encodedContent,
            branch: args.branch,
            sha: args.sha,
          });
          return formatResult(`File "${args.path}" ${args.sha ? 'updated' : 'created'} on branch "${args.branch || 'default'}". Commit: ${data.commit?.sha?.slice(0, 7) || 'unknown'}.`, {
            commit: data.commit?.sha,
            content: data.content,
          });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'gh_get_tree',
      description: 'Get the file tree of a repository. Can be recursive to list all files.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner. Falls back to configured default.' },
          repo: { type: 'string', description: 'Repository name. Falls back to configured default.' },
          tree_sha: { type: 'string', description: 'Branch name, tag, or SHA. Defaults to HEAD of default branch.' },
          recursive: { type: 'boolean', description: 'If true, returns the tree recursively. Default true.' },
        },
      },
      parallelizable: true,
      execute: async (args: any) => {
        try {
          const resolved = requireRepo(args, defaults);
          if ('error' in resolved) return resolved;
          const treeSha = args.tree_sha || 'HEAD';
          const data = await client.get(`/repos/${resolved.owner}/${resolved.repo}/git/trees/${treeSha}`, {
            recursive: args.recursive !== false ? '1' : undefined,
          });
          const entries = (data.tree || []).map((item: any) =>
            `  ${item.type === 'tree' ? '[dir]' : item.type === 'blob' ? '[file]' : `[${item.type}]`} ${item.path}`
          );
          return formatResult(truncate(`Tree (${data.tree?.length || 0} entries, truncated: ${data.truncated || false}):\n${entries.join('\n')}`, 30000), {
            truncated: data.truncated,
            tree: data.tree,
          });
        } catch (err) {
          return formatError(err);
        }
      },
    },
  ];
}

// ── Issues 工具 ──────────────────────────────────────────

function issueTools(client: GitHubClient, defaults: GitHubToolDefaults): Tool[] {
  return [
    {
      name: 'gh_list_issues',
      description: 'List issues in a repository. By default only open issues are returned.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner. Falls back to configured default.' },
          repo: { type: 'string', description: 'Repository name. Falls back to configured default.' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state. Default "open".' },
          labels: { type: 'string', description: 'Comma-separated list of label names to filter by.' },
          per_page: { type: 'number', description: 'Results per page (max 100). Default 30.' },
        },
      },
      parallelizable: true,
      execute: async (args: any) => {
        try {
          const resolved = requireRepo(args, defaults);
          if ('error' in resolved) return resolved;
          const data = await client.get(`/repos/${resolved.owner}/${resolved.repo}/issues`, {
            state: args.state || 'open',
            labels: args.labels,
            per_page: args.per_page || 30,
          });
          // Filter out PRs (GitHub API returns PRs in issues endpoint)
          const issues = (data || []).filter((item: any) => !item.pull_request);
          const lines = issues.map((i: any) =>
            `  #${i.number} [${i.state}] ${i.title} — by ${i.user?.login || 'unknown'}${i.labels?.length ? ` [${i.labels.map((l: any) => l.name).join(',')}]` : ''}`
          );
          return formatResult(`Issues (${issues.length}):\n${lines.join('\n') || '(none)'}`, { issues });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'gh_get_issue',
      description: 'Get detailed information about a specific issue, including body and comments count.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner. Falls back to configured default.' },
          repo: { type: 'string', description: 'Repository name. Falls back to configured default.' },
          issue_number: { type: 'number', description: 'Issue number.' },
        },
        required: ['issue_number'],
      },
      parallelizable: true,
      execute: async (args: any) => {
        try {
          const resolved = requireRepo(args, defaults);
          if ('error' in resolved) return resolved;
          const data = await client.get(`/repos/${resolved.owner}/${resolved.repo}/issues/${args.issue_number}`);
          const lines = [
            `#${data.number} [${data.state}] ${data.title}`,
            `By ${data.user?.login || 'unknown'} on ${data.created_at?.split('T')[0] || '?'}`,
            `Comments: ${data.comments}`,
          ];
          if (data.labels?.length) lines.push(`Labels: ${data.labels.map((l: any) => l.name).join(', ')}`);
          if (data.assignees?.length) lines.push(`Assignees: ${data.assignees.map((a: any) => a.login).join(', ')}`);
          if (data.body) lines.push('', truncate(data.body, 10000));
          return formatResult(lines.join('\n'), { issue: data });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'gh_search_issues',
      description: 'Search issues and pull requests across GitHub. Use "is:issue" or "is:pr" to filter, plus "repo:owner/repo" to scope to a repository.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (e.g. "repo:owner/repo is:issue is:open bug label:priority").' },
          per_page: { type: 'number', description: 'Results per page (max 100). Default 20.' },
        },
        required: ['query'],
      },
      parallelizable: true,
      execute: async (args: any) => {
        try {
          const data = await client.get('/search/issues', { q: args.query, per_page: args.per_page || 20 });
          const items = (data.items || []).map((item: any) => {
            const type = item.pull_request ? 'PR' : 'Issue';
            return `  ${type} #${item.number} [${item.state}] ${item.title} — ${item.repository_url?.split('/').slice(-2).join('/') || ''}`;
          });
          return formatResult(`Found ${data.total_count} result(s):\n${items.join('\n') || '(no results)'}`, {
            total_count: data.total_count,
            items: data.items,
          });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'gh_create_issue',
      description: 'Create a new issue in a repository.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner. Falls back to configured default.' },
          repo: { type: 'string', description: 'Repository name. Falls back to configured default.' },
          title: { type: 'string', description: 'Issue title.' },
          body: { type: 'string', description: 'Issue body (Markdown).' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Labels to assign.' },
          assignees: { type: 'array', items: { type: 'string' }, description: 'User logins to assign.' },
        },
        required: ['title'],
      },
      execute: async (args: any) => {
        try {
          const resolved = requireRepo(args, defaults);
          if ('error' in resolved) return resolved;
          const body: Record<string, unknown> = { title: args.title };
          if (args.body) body.body = args.body;
          if (Array.isArray(args.labels)) body.labels = args.labels;
          if (Array.isArray(args.assignees)) body.assignees = args.assignees;
          const data = await client.post(`/repos/${resolved.owner}/${resolved.repo}/issues`, body);
          return formatResult(`Created issue #${data.number}: ${data.title}\nURL: ${data.html_url}`, { issue: data });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'gh_update_issue',
      description: 'Update an existing issue — title, body, state, labels, assignees, or milestone.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner. Falls back to configured default.' },
          repo: { type: 'string', description: 'Repository name. Falls back to configured default.' },
          issue_number: { type: 'number', description: 'Issue number.' },
          title: { type: 'string', description: 'New title.' },
          body: { type: 'string', description: 'New body (Markdown).' },
          state: { type: 'string', enum: ['open', 'closed'], description: 'New state.' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Replace labels (pass [] to clear).' },
          assignees: { type: 'array', items: { type: 'string' }, description: 'Replace assignees (pass [] to clear).' },
          milestone: { type: 'number', description: 'Milestone number, or null to clear.' },
        },
        required: ['issue_number'],
      },
      execute: async (args: any) => {
        try {
          const resolved = requireRepo(args, defaults);
          if ('error' in resolved) return resolved;
          const body: Record<string, unknown> = {};
          for (const key of ['title', 'body', 'state', 'labels', 'assignees', 'milestone']) {
            if (args[key] !== undefined) body[key] = args[key];
          }
          const data = await client.patch(`/repos/${resolved.owner}/${resolved.repo}/issues/${args.issue_number}`, body);
          return formatResult(`Updated issue #${data.number}: ${data.title} [${data.state}]\nURL: ${data.html_url}`, { issue: data });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'gh_add_issue_comment',
      description: 'Add a comment to an issue or pull request.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner. Falls back to configured default.' },
          repo: { type: 'string', description: 'Repository name. Falls back to configured default.' },
          issue_number: { type: 'number', description: 'Issue or PR number.' },
          body: { type: 'string', description: 'Comment body (Markdown).' },
        },
        required: ['issue_number', 'body'],
      },
      execute: async (args: any) => {
        try {
          const resolved = requireRepo(args, defaults);
          if ('error' in resolved) return resolved;
          const data = await client.post(`/repos/${resolved.owner}/${resolved.repo}/issues/${args.issue_number}/comments`, {
            body: args.body,
          });
          return formatResult(`Comment added to #${args.issue_number}.\nURL: ${data.html_url}`, { comment: data });
        } catch (err) {
          return formatError(err);
        }
      },
    },
  ];
}

// ── Pull Request 工具 ────────────────────────────────────

function prTools(client: GitHubClient, defaults: GitHubToolDefaults): Tool[] {
  return [
    {
      name: 'gh_list_prs',
      description: 'List pull requests in a repository.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner. Falls back to configured default.' },
          repo: { type: 'string', description: 'Repository name. Falls back to configured default.' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state. Default "open".' },
          per_page: { type: 'number', description: 'Results per page (max 100). Default 30.' },
        },
      },
      parallelizable: true,
      execute: async (args: any) => {
        try {
          const resolved = requireRepo(args, defaults);
          if ('error' in resolved) return resolved;
          const data = await client.get(`/repos/${resolved.owner}/${resolved.repo}/pulls`, {
            state: args.state || 'open',
            per_page: args.per_page || 30,
          });
          const lines = (data || []).map((pr: any) =>
            `  #${pr.number} [${pr.state}${pr.draft ? '/draft' : ''}] ${pr.title} — ${pr.user?.login || '?'} → ${pr.base?.ref}`
          );
          return formatResult(`Pull Requests (${data.length}):\n${lines.join('\n') || '(none)'}`, { pull_requests: data });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'gh_get_pr',
      description: 'Get detailed information about a pull request, including metadata, body, and changed files with diffs.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner. Falls back to configured default.' },
          repo: { type: 'string', description: 'Repository name. Falls back to configured default.' },
          pull_number: { type: 'number', description: 'Pull request number.' },
        },
        required: ['pull_number'],
      },
      parallelizable: true,
      execute: async (args: any) => {
        try {
          const resolved = requireRepo(args, defaults);
          if ('error' in resolved) return resolved;
          const [pr, files] = await Promise.all([
            client.get(`/repos/${resolved.owner}/${resolved.repo}/pulls/${args.pull_number}`),
            client.get(`/repos/${resolved.owner}/${resolved.repo}/pulls/${args.pull_number}/files`),
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
          return formatResult(lines.join('\n'), { pull_request: pr, files });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'gh_search_prs',
      description: 'Search for pull requests across GitHub. Equivalent to search_issues with "is:pr" implied.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query. "is:pr" is automatically appended.' },
          per_page: { type: 'number', description: 'Results per page (max 100). Default 20.' },
        },
        required: ['query'],
      },
      parallelizable: true,
      execute: async (args: any) => {
        try {
          const q = args.query.includes('is:pr') ? args.query : `${args.query} is:pr`;
          const data = await client.get('/search/issues', { q, per_page: args.per_page || 20 });
          const items = (data.items || []).map((item: any) =>
            `  PR #${item.number} [${item.state}] ${item.title} — ${item.repository_url?.split('/').slice(-2).join('/') || ''}`
          );
          return formatResult(`Found ${data.total_count} PR(s):\n${items.join('\n') || '(no results)'}`, {
            total_count: data.total_count,
            items: data.items,
          });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'gh_create_pr',
      description: 'Create a new pull request.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner. Falls back to configured default.' },
          repo: { type: 'string', description: 'Repository name. Falls back to configured default.' },
          title: { type: 'string', description: 'PR title.' },
          head: { type: 'string', description: 'The name of the source branch.' },
          base: { type: 'string', description: 'The name of the target branch. Defaults to the repo default branch.' },
          body: { type: 'string', description: 'PR description (Markdown).' },
          draft: { type: 'boolean', description: 'Create as draft PR. Default false.' },
        },
        required: ['title', 'head'],
      },
      execute: async (args: any) => {
        try {
          const resolved = requireRepo(args, defaults);
          if ('error' in resolved) return resolved;
          const body: Record<string, unknown> = { title: args.title, head: args.head };
          if (args.base) body.base = args.base;
          if (args.body) body.body = args.body;
          if (args.draft !== undefined) body.draft = args.draft;
          const data = await client.post(`/repos/${resolved.owner}/${resolved.repo}/pulls`, body);
          return formatResult(`Created PR #${data.number}: ${data.title}\nURL: ${data.html_url}`, { pull_request: data });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'gh_update_pr',
      description: 'Update a pull request — title, body, state, or draft status.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner. Falls back to configured default.' },
          repo: { type: 'string', description: 'Repository name. Falls back to configured default.' },
          pull_number: { type: 'number', description: 'Pull request number.' },
          title: { type: 'string', description: 'New title.' },
          body: { type: 'string', description: 'New body (Markdown).' },
          state: { type: 'string', enum: ['open', 'closed'], description: 'New state.' },
          base: { type: 'string', description: 'New target branch.' },
        },
        required: ['pull_number'],
      },
      execute: async (args: any) => {
        try {
          const resolved = requireRepo(args, defaults);
          if ('error' in resolved) return resolved;
          const body: Record<string, unknown> = {};
          for (const key of ['title', 'body', 'state', 'base']) {
            if (args[key] !== undefined) body[key] = args[key];
          }
          const data = await client.patch(`/repos/${resolved.owner}/${resolved.repo}/pulls/${args.pull_number}`, body);
          return formatResult(`Updated PR #${data.number}: ${data.title} [${data.state}]\nURL: ${data.html_url}`, { pull_request: data });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'gh_merge_pr',
      description: 'Merge a pull request.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner. Falls back to configured default.' },
          repo: { type: 'string', description: 'Repository name. Falls back to configured default.' },
          pull_number: { type: 'number', description: 'Pull request number.' },
          commit_title: { type: 'string', description: 'Title for the merge commit.' },
          merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Merge method. Default "merge".' },
        },
        required: ['pull_number'],
      },
      execute: async (args: any) => {
        try {
          const resolved = requireRepo(args, defaults);
          if ('error' in resolved) return resolved;
          const body: Record<string, unknown> = {};
          if (args.commit_title) body.commit_title = args.commit_title;
          if (args.merge_method) body.merge_method = args.merge_method;
          const data = await client.put(`/repos/${resolved.owner}/${resolved.repo}/pulls/${args.pull_number}/merge`, body);
          return formatResult(`PR #${args.pull_number} ${data.merged ? 'merged' : 'merge attempted'}: ${data.message || ''}`, { result: data });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'gh_get_pr_reviews',
      description: 'List all reviews submitted on a pull request.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner. Falls back to configured default.' },
          repo: { type: 'string', description: 'Repository name. Falls back to configured default.' },
          pull_number: { type: 'number', description: 'Pull request number.' },
        },
        required: ['pull_number'],
      },
      parallelizable: true,
      execute: async (args: any) => {
        try {
          const resolved = requireRepo(args, defaults);
          if ('error' in resolved) return resolved;
          const data = await client.get(`/repos/${resolved.owner}/${resolved.repo}/pulls/${args.pull_number}/reviews`);
          const reviews = (data || []).map((r: any) =>
            `  [${r.state}] by ${r.user?.login || '?'} on ${r.submitted_at?.split('T')[0] || '?'}${r.body ? `: ${truncate(r.body, 200)}` : ''}`
          );
          return formatResult(`Reviews (${data.length}):\n${reviews.join('\n') || '(none)'}`, { reviews: data });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'gh_get_pr_review_threads',
      description: 'Get inline review threads on a pull request with resolution and outdated status. Uses GraphQL for thread-level data not available in REST. This is the key tool for addressing review comments — filter by isResolved=false and isOutdated=false to find actionable threads.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner. Falls back to configured default.' },
          repo: { type: 'string', description: 'Repository name. Falls back to configured default.' },
          pull_number: { type: 'number', description: 'Pull request number.' },
        },
        required: ['pull_number'],
      },
      parallelizable: true,
      execute: async (args: any) => {
        try {
          const resolved = requireRepo(args, defaults);
          if ('error' in resolved) return resolved;

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

          const data = await client.graphql(query, {
            owner: resolved.owner,
            repo: resolved.repo,
            number: args.pull_number,
          });

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
          return formatResult(
            `Review threads (${threads.length} total, ${actionable} actionable):\n${lines.join('\n') || '(none)'}`,
            { threads, actionableCount: actionable }
          );
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'gh_create_pr_review',
      description: 'Submit a review on a pull request. event can be "APPROVE", "REQUEST_CHANGES", or "COMMENT". For line-specific comments, use the comments array with path, line, body, and optionally side.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner. Falls back to configured default.' },
          repo: { type: 'string', description: 'Repository name. Falls back to configured default.' },
          pull_number: { type: 'number', description: 'Pull request number.' },
          event: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'], description: 'Review action.' },
          body: { type: 'string', description: 'Review body text (Markdown).' },
          comments: {
            type: 'array',
            description: 'Inline review comments.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'File path relative to repo root.' },
                line: { type: 'number', description: 'Line number to comment on (in the diff).' },
                side: { type: 'string', enum: ['LEFT', 'RIGHT'], description: 'Side of the diff. Default RIGHT.' },
                body: { type: 'string', description: 'Comment body.' },
              },
            },
          },
        },
        required: ['pull_number', 'event'],
      },
      execute: async (args: any) => {
        try {
          const resolved = requireRepo(args, defaults);
          if ('error' in resolved) return resolved;
          const body: Record<string, unknown> = { event: args.event };
          if (args.body) body.body = args.body;
          if (Array.isArray(args.comments) && args.comments.length > 0) {
            body.comments = args.comments.map((c: any) => ({
              path: c.path,
              line: c.line,
              side: c.side || 'RIGHT',
              body: c.body,
            }));
          }
          const data = await client.post(`/repos/${resolved.owner}/${resolved.repo}/pulls/${args.pull_number}/reviews`, body);
          return formatResult(`Review submitted (${args.event}) on PR #${args.pull_number}.`, { review: data });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'gh_reply_pr_comment',
      description: 'Reply to a specific pull request review comment (inline thread reply). Requires in_reply_to comment ID from the review comment.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner. Falls back to configured default.' },
          repo: { type: 'string', description: 'Repository name. Falls back to configured default.' },
          pull_number: { type: 'number', description: 'Pull request number.' },
          comment_id: { type: 'number', description: 'The ID of the review comment to reply to.' },
          body: { type: 'string', description: 'Reply body (Markdown).' },
        },
        required: ['pull_number', 'comment_id', 'body'],
      },
      execute: async (args: any) => {
        try {
          const resolved = requireRepo(args, defaults);
          if ('error' in resolved) return resolved;
          const data = await client.post(
            `/repos/${resolved.owner}/${resolved.repo}/pulls/${args.pull_number}/comments/${args.comment_id}/replies`,
            { body: args.body }
          );
          return formatResult(`Reply posted to comment ${args.comment_id} on PR #${args.pull_number}.\nURL: ${data.html_url}`, { comment: data });
        } catch (err) {
          return formatError(err);
        }
      },
    },
  ];
}

// ── Actions / CI 工具 ────────────────────────────────────

function actionsTools(client: GitHubClient, defaults: GitHubToolDefaults): Tool[] {
  return [
    {
      name: 'gh_list_workflow_runs',
      description: 'List GitHub Actions workflow runs in a repository, optionally filtered by event, status, or branch.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner. Falls back to configured default.' },
          repo: { type: 'string', description: 'Repository name. Falls back to configured default.' },
          event: { type: 'string', description: 'Filter by event type (e.g. "push", "pull_request").' },
          status: { type: 'string', description: 'Filter by status (e.g. "queued", "in_progress", "completed"). For conclusion filtering use "success", "failure", etc."' },
          branch: { type: 'string', description: 'Filter by branch name.' },
          per_page: { type: 'number', description: 'Results per page (max 100). Default 20.' },
        },
      },
      parallelizable: true,
      execute: async (args: any) => {
        try {
          const resolved = requireRepo(args, defaults);
          if ('error' in resolved) return resolved;
          const data = await client.get(`/repos/${resolved.owner}/${resolved.repo}/actions/runs`, {
            event: args.event,
            status: args.status,
            branch: args.branch,
            per_page: args.per_page || 20,
          });
          const runs = (data.workflow_runs || []).map((r: any) =>
            `  ${r.id} [${r.status}/${r.conclusion || '-'}] ${r.name || r.workflow_id} — ${r.head_branch} (${r.event}) ${r.html_url}`
          );
          return formatResult(`Workflow runs (${data.total_count} total, showing ${runs.length}):\n${runs.join('\n') || '(none)'}`, {
            total_count: data.total_count,
            workflow_runs: data.workflow_runs,
          });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'gh_get_workflow_run',
      description: 'Get details of a specific workflow run, including jobs and their statuses.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner. Falls back to configured default.' },
          repo: { type: 'string', description: 'Repository name. Falls back to configured default.' },
          run_id: { type: 'number', description: 'Workflow run ID.' },
        },
        required: ['run_id'],
      },
      parallelizable: true,
      execute: async (args: any) => {
        try {
          const resolved = requireRepo(args, defaults);
          if ('error' in resolved) return resolved;
          const [run, jobsData] = await Promise.all([
            client.get(`/repos/${resolved.owner}/${resolved.repo}/actions/runs/${args.run_id}`),
            client.get(`/repos/${resolved.owner}/${resolved.repo}/actions/runs/${args.run_id}/jobs`),
          ]);
          const jobs = (jobsData.jobs || []).map((j: any) =>
            `  ${j.name}: ${j.status}/${j.conclusion || '-'} (id: ${j.id})`
          );
          const lines = [
            `Run ${run.id}: ${run.name || '?'}`,
            `Status: ${run.status}/${run.conclusion || '-'}`,
            `Event: ${run.event} | Branch: ${run.head_branch}`,
            `URL: ${run.html_url}`,
            'Jobs:',
            ...jobs,
          ];
          return formatResult(lines.join('\n'), { run, jobs: jobsData.jobs });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'gh_get_job_logs',
      description: 'Get the logs for a specific job in a GitHub Actions run. Returns a snippet around failure markers. The job_id can be obtained from gh_get_workflow_run.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner. Falls back to configured default.' },
          repo: { type: 'string', description: 'Repository name. Falls back to configured default.' },
          job_id: { type: 'number', description: 'Job ID from the workflow run.' },
          max_lines: { type: 'number', description: 'Maximum lines to return in the snippet. Default 160.' },
        },
        required: ['job_id'],
      },
      execute: async (args: any) => {
        try {
          const resolved = requireRepo(args, defaults);
          if ('error' in resolved) return resolved;

          // Fetch logs — the API returns a redirect to a zip URL or raw logs
          const logPath = `/repos/${resolved.owner}/${resolved.repo}/actions/jobs/${args.job_id}/logs`;
          let logText: string;
          try {
            logText = await client.fetchRawText(logPath);
          } catch (fetchErr) {
            return formatError(fetchErr);
          }
          if (!logText) return { error: 'Job logs are empty or still pending.' };

          // Extract failure snippet
          const maxLines = args.max_lines || 160;
          const snippet = extractFailureSnippet(logText, maxLines);
          return formatResult(truncate(snippet, 30000), {
            job_id: args.job_id,
            log_size: logText.length,
          });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'gh_list_pr_checks',
      description: 'List check run statuses for a specific commit ref (typically the head SHA of a PR). Useful for diagnosing CI failures.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner. Falls back to configured default.' },
          repo: { type: 'string', description: 'Repository name. Falls back to configured default.' },
          ref: { type: 'string', description: 'Commit SHA, branch name, or tag. For a PR, use the head SHA.' },
        },
        required: ['ref'],
      },
      parallelizable: true,
      execute: async (args: any) => {
        try {
          const resolved = requireRepo(args, defaults);
          if ('error' in resolved) return resolved;
          const data = await client.get(`/repos/${resolved.owner}/${resolved.repo}/commits/${args.ref}/check-runs`, {
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
          return formatResult(lines.join('\n'), {
            total: data.total_count,
            check_runs: data.check_runs,
            failing: failing.length,
          });
        } catch (err) {
          return formatError(err);
        }
      },
    },
  ];
}

// ── Notifications 工具 ───────────────────────────────────

function notificationTools(client: GitHubClient): Tool[] {
  return [
    {
      name: 'gh_list_notifications',
      description: 'List the authenticated user\'s GitHub notifications.',
      parameters: {
        type: 'object',
        properties: {
          all: { type: 'boolean', description: 'If true, show notifications marked as read. Default false.' },
          participating: { type: 'boolean', description: 'If true, only show notifications the user is directly participating in.' },
          per_page: { type: 'number', description: 'Results per page (max 50). Default 20.' },
        },
      },
      parallelizable: true,
      execute: async (args: any) => {
        try {
          const data = await client.get('/notifications', {
            all: args.all ? 'true' : undefined,
            participating: args.participating ? 'true' : undefined,
            per_page: args.per_page || 20,
          });
          const notifs = (data || []).map((n: any) =>
            `  ${n.reason}: ${n.subject?.type} "${n.subject?.title}" in ${n.repository?.full_name} (updated ${n.updated_at?.split('T')[0] || '?'})`
          );
          return formatResult(`Notifications (${data.length}):\n${notifs.join('\n') || '(none)'}`, { notifications: data });
        } catch (err) {
          return formatError(err);
        }
      },
    },
    {
      name: 'gh_mark_notification_read',
      description: 'Mark a specific notification as read.',
      parameters: {
        type: 'object',
        properties: {
          thread_id: { type: 'string', description: 'Notification thread ID.' },
        },
        required: ['thread_id'],
      },
      execute: async (args: any) => {
        try {
          await client.patch(`/notifications/threads/${args.thread_id}`);
          return formatResult(`Notification ${args.thread_id} marked as read.`);
        } catch (err) {
          return formatError(err);
        }
      },
    },
  ];
}

// ── 失败日志辅助函数（源自 Codex inspect_pr_checks.py）────

const FAILURE_MARKERS = ['error', 'fail', 'failed', 'traceback', 'exception', 'assert', 'panic', 'fatal', 'timeout', 'segmentation fault'];

function extractFailureSnippet(logText: string, maxLines: number): string {
  const lines = logText.split('\n');
  if (!lines.length) return '';

  let markerIndex: number | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const lowered = lines[i].toLowerCase();
    if (FAILURE_MARKERS.some(m => lowered.includes(m))) {
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

// ── 统一构建入口 ─────────────────────────────────────────

export function createGitHubTools(
  client: GitHubClient,
  defaults: GitHubToolDefaults,
  enabledToolsets: Set<string>,
): Tool[] {
  const tools: Tool[] = [];

  if (enabledToolsets.has('context')) tools.push(...contextTools(client));
  if (enabledToolsets.has('repo')) tools.push(...repoTools(client, defaults));
  if (enabledToolsets.has('issues')) tools.push(...issueTools(client, defaults));
  if (enabledToolsets.has('pr')) tools.push(...prTools(client, defaults));
  if (enabledToolsets.has('actions')) tools.push(...actionsTools(client, defaults));
  if (enabledToolsets.has('notifications')) tools.push(...notificationTools(client));

  return tools;
}
