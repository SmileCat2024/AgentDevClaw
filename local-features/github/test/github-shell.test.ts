import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GitHubClient } from '../src/client.js';
import { GitHubClient as RealGitHubClient } from '../src/client.js';
import {
  createGitHubShellAdapters,
  createGitHubShellPolicy,
  GITHUB_TOOLSETS,
  type GitHubToolDefaults,
} from '../src/github-shell.js';
import { runCapabilityShellPipeline } from '../../capability-shell/src/tool-factory.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
  params?: unknown;
}

type HookKey = 'get' | 'post' | 'patch' | 'put' | 'delete' | 'uploadReleaseAsset';

/** 记录调用的最小 client 桩：按 method 记录 path/body/params，hook 返回预设数据。 */
function stubClient(hooks: Partial<Record<HookKey, (call: RecordedCall) => any>> = {}) {
  const calls: RecordedCall[] = [];
  const invoke = async (method: string, p: string, extra: Partial<RecordedCall>, key: HookKey) => {
    const call = { method, path: p, ...extra };
    calls.push(call);
    const hook = hooks[key];
    return hook ? hook(call) : {};
  };
  return {
    calls,
    get: (p: string, params?: unknown) => invoke('get', p, { params }, 'get'),
    post: (p: string, body?: unknown) => invoke('post', p, { body }, 'post'),
    patch: (p: string, body?: unknown) => invoke('patch', p, { body }, 'patch'),
    put: (p: string, body?: unknown) => invoke('put', p, { body }, 'put'),
    delete: (p: string) => invoke('delete', p, {}, 'delete'),
    graphql: (query: string) => invoke('post', '/graphql', { body: query }, 'post'),
    fetchRawText: (p: string) => invoke('get', p, {}, 'get'),
    uploadReleaseAsset: (url: string, name: string, data: Buffer, contentType: string) =>
      invoke('upload', url, { body: { name, size: data.length, contentType } }, 'uploadReleaseAsset'),
  } as unknown as GitHubClient & { calls: RecordedCall[] };
}

function run(command: string, client: GitHubClient & { calls: RecordedCall[] }, defaults: GitHubToolDefaults = {}) {
  const toolsets = new Set(GITHUB_TOOLSETS);
  return runCapabilityShellPipeline(createGitHubShellPolicy(toolsets), command, {
    adapters: createGitHubShellAdapters(client, defaults, toolsets),
  });
}

/**
 * fixture 的 cwd 无关相对路径（readLocalText/readLocalBytes 按 process.cwd() 解析）。
 * tsc 不拷贝非 ts 文件：dist 测试产物旁没有 fixtures，回退到源码树取。
 */
function fixtureRel(name: string): string {
  const distFixture = path.join(TEST_DIR, 'fixtures', name);
  const srcFixture = path.resolve(TEST_DIR, '../../../github/test/fixtures', name);
  const abs = existsSync(distFixture) ? distFixture : srcFixture;
  return path.relative(process.cwd(), abs).replace(/\\/g, '/');
}

test('动词面：44 个动词，新增动词全部在列，按 toolset 过滤', () => {
  const policy = createGitHubShellPolicy(new Set(GITHUB_TOOLSETS));
  assert.equal(policy.name, 'github_shell');
  assert.equal(Object.keys(policy.verbs).length, 44);
  const expected = [
    // release 域（本次新增）
    'create-release', 'get-release', 'update-release', 'delete-release', 'list-releases',
    // 补齐的领域缺口（本次新增）
    'get-issue-comments', 'update-pr-branch', 'list-workflows', 'rerun-workflow-run',
    'cancel-workflow-run', 'list-tags', 'get-repo',
    // 既有动词抽查
    'get-me', 'get-file-contents', 'create-pr', 'merge-pr', 'get-job-logs', 'list-notifications',
  ];
  for (const verb of expected) assert.ok(policy.verbs[verb], `missing verb: ${verb}`);

  const repoOnly = createGitHubShellPolicy(new Set(['repo']));
  assert.ok(repoOnly.verbs['get-repo']);
  assert.ok(!repoOnly.verbs['get-me']);
  assert.ok(!repoOnly.verbs['create-release']);
});

test('位置参数与 flag：get-pr 42 --owner=acme --repo=app', async () => {
  const client = stubClient({
    get: (call) => call.path.endsWith('/pulls/42')
      ? { number: 42, state: 'open', title: 'Fix login', user: { login: 'u' }, base: { ref: 'main' }, mergeable: true, mergeable_state: 'clean', additions: 1, deletions: 2, changed_files: 1, body: 'desc' }
      : [{ status: 'modified', filename: 'a.ts', additions: 1, deletions: 2 }],
  });
  const result = await run('get-pr 42 --owner=acme --repo=app', client);
  assert.equal(result.ok, true);
  assert.match(result.output, /PR #42/);
  assert.equal(client.calls.find((c) => c.method === 'get' && c.path.endsWith('/pulls/42'))?.path, '/repos/acme/app/pulls/42');
});

test('默认仓库兜底与缺失报错', async () => {
  const client = stubClient({
    get: () => ({ number: 7, state: 'open', title: 'T', user: { login: 'u' }, created_at: '2026-01-01T00:00:00Z', comments: 0, body: 'x' }),
  });
  const ok = await run('get-issue 7', client, { defaultOwner: 'acme', defaultRepo: 'app' });
  assert.equal(ok.ok, true);
  assert.equal(client.calls[0].path, '/repos/acme/app/issues/7');

  const missing = await run('get-issue 7', stubClient());
  assert.equal(missing.ok, false);
  assert.match(missing.output, /--owner= 与 --repo=/);
});

test('create-release：tag 位置参数 + --notes-file + --asset 上传 + --draft', async () => {
  const client = stubClient({
    post: (call) => call.path.endsWith('/releases')
      ? { tag_name: 'v1.2.3', name: 'v1.2.3', html_url: 'https://github.com/acme/app/releases/tag/v1.2.3', upload_url: 'https://uploads.github.com/repos/acme/app/releases/1/assets{?name,label}' }
      : {},
    uploadReleaseAsset: () => ({ browser_download_url: 'https://github.com/acme/app/releases/download/v1.2.3/asset.txt' }),
  });
  const result = await run(
    `create-release v1.2.3 --owner=acme --repo=app --notes-file=${fixtureRel('release-notes.md')} --asset=${fixtureRel('asset.txt')} --draft`,
    client,
  );
  assert.equal(result.ok, true);
  const post = client.calls.find((c) => c.method === 'post' && c.path.endsWith('/releases'));
  assert.deepEqual(post?.body, { tag_name: 'v1.2.3', name: 'v1.2.3', draft: true, prerelease: false, body: '# v1.2.3\n\n- 修复了 A\n' });
  const upload = client.calls.find((c) => c.method === 'upload');
  // adapter 层契约：透传 GitHub 返回的 upload_url 模板，剥离发生在真实 client 内部
  assert.equal(upload?.path, 'https://uploads.github.com/repos/acme/app/releases/1/assets{?name,label}');
  assert.deepEqual(upload?.body, { name: 'asset.txt', size: 11, contentType: 'application/octet-stream' });
  assert.match(result.output, /Release created: v1\.2\.3/);
  assert.match(result.output, /asset\.txt/);
});

test('update-release：按 tag 定位 id 后 PATCH 指定字段；无字段时拒绝', async () => {
  const client = stubClient({
    get: () => ({ id: 321, tag_name: 'v1.2.3' }),
    patch: () => ({ tag_name: 'v1.2.3', html_url: 'https://github.com/acme/app/releases/tag/v1.2.3' }),
  });
  const result = await run("update-release v1.2.3 --owner=acme --repo=app --title='v1.2.3（修订）' --draft=false", client);
  assert.equal(result.ok, true);
  assert.equal(client.calls.find((c) => c.method === 'get')?.path, '/repos/acme/app/releases/tags/v1.2.3');
  const patchCall = client.calls.find((c) => c.method === 'patch');
  assert.equal(patchCall?.path, '/repos/acme/app/releases/321');
  assert.deepEqual(patchCall?.body, { name: 'v1.2.3（修订）', draft: false });

  const empty = await run('update-release v1.2.3 --owner=acme --repo=app', stubClient());
  assert.equal(empty.ok, false);
  assert.match(empty.output, /未提供任何更新字段/);
});

test('rerun-workflow-run --failed-only 分流到 rerun-failed-jobs', async () => {
  const client = stubClient({ post: () => ({}) });
  const result = await run('rerun-workflow-run 999 --failed-only --owner=acme --repo=app', client);
  assert.equal(result.ok, true);
  assert.equal(client.calls.find((c) => c.method === 'post')?.path, '/repos/acme/app/actions/runs/999/rerun-failed-jobs');
});

test('adapter 抛错中断 && 链，后续段跳过', async () => {
  let getCount = 0;
  const client = stubClient({
    get: () => { getCount++; throw new Error('boom'); },
  });
  const result = await run('get-me && get-me', client);
  assert.equal(result.ok, false);
  assert.equal(getCount, 1);
  assert.equal(result.commands?.[1]?.status, 'skipped');
});

test('client.uploadReleaseAsset：剥模板段、追加 ?name=、二进制 POST', async () => {
  const originalFetch = globalThis.fetch;
  const seen: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ name: 'asset.txt', browser_download_url: 'x/asset.txt' }), { status: 201 });
  }) as typeof fetch;
  try {
    const client = new RealGitHubClient({ token: 't' });
    const asset = await client.uploadReleaseAsset(
      'https://uploads.github.com/repos/acme/app/releases/1/assets{?name,label}',
      'asset.txt',
      Buffer.from('asset-bytes'),
      'application/octet-stream',
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://uploads.github.com/repos/acme/app/releases/1/assets?name=asset.txt');
    assert.equal(seen[0].init.method, 'POST');
    assert.equal((seen[0].init.headers as Record<string, string>)['Content-Type'], 'application/octet-stream');
    assert.equal(asset.browser_download_url, 'x/asset.txt');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('未知动词与未声明 flag 拒绝', async () => {
  const unknown = await run('api repos/acme/project', stubClient());
  assert.equal(unknown.ok, false);
  assert.match(unknown.output, /不是 github_shell 的可用动词/);

  // 未声明的 -- 前缀 token 计入位置参数：get-me 期望 0 个参数
  const badFlag = await run('get-me --token=secret', stubClient());
  assert.equal(badFlag.ok, false);
  assert.match(badFlag.output, /期望 0 个参数/);
});
