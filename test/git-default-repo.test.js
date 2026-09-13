/**
 * 默认仓库偏好端点（POST /protoclaw/git/default_repo + discover 下发）
 *
 * 行为契约：目录 → 默认查看的子仓库根，存 workspace state 的
 * gitDefaultRepos（归一化目录键）；repoRoot 空串 = 清除；repoRoot 必须
 * 是 dir 之下的 git 仓库。discover 响应顺带下发 defaultRepo，与仓库
 * 列表一次请求对齐。
 *
 * harness 参照 session-create-coder-directory.test.js：capture handler
 * 直接调用，res 最小替身。AGENTDEV_DATA_DIR 隔离数据目录（workspace.js
 * 模块链在 import 时解析数据根）。
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'claw-git-default-repo-'));
process.env.AGENTDEV_DATA_DIR = DATA_ROOT;

const { setupGitRoutes, discoverGitRepos } = await import('../server/routes/git.js');
const { normalizeGitDefaultReposKey } = await import('../server/routes/workspace.js');

after(() => {
  rmSync(DATA_ROOT, { recursive: true, force: true });
});

// 非 PH agentId，避开 readWorkspaceState 的 phProjects 回填分支
const AGENT_ID = 'git-default-repo-test-agent';

function captureHandlers() {
  const handlers = {};
  setupGitRoutes(
    { post: (routePath, ...rest) => { handlers[routePath] = rest[rest.length - 1]; } },
    { json: () => (_req, _res, next) => next?.() },
  );
  return handlers;
}

function makeRes() {
  return {
    statusCode: 200,
    jsonPayload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.jsonPayload = payload; },
  };
}

async function call(handler, body) {
  const res = makeRes();
  await handler({ body }, res, () => {});
  return res;
}

describe('POST /protoclaw/git/default_repo + discover 下发', () => {
  const handlers = captureHandlers();
  const defaultRepoHandler = handlers['/protoclaw/git/default_repo'];
  const discoverHandler = handlers['/protoclaw/git/discover'];

  // 场景目录：root（非仓库）下有 repo-a / repo-b 两个仓库与 plain 普通目录
  const root = mkdtempSync(join(DATA_ROOT, 'session-dir-'));
  const repoA = join(root, 'repo-a');
  const repoB = join(root, 'repo-b');
  const plain = join(root, 'plain');
  for (const dir of [repoA, repoB, plain]) {
    mkdirSync(dir);
  }
  mkdirSync(join(repoA, '.git'));
  mkdirSync(join(repoB, '.git'));

  test('写入 → discover 下发 defaultRepo；清除 → 回空串', async () => {
    let res = await call(defaultRepoHandler, { agentId: AGENT_ID, dir: root, repoRoot: repoB });
    assert.equal(res.statusCode, 200);
    assert.equal(res.jsonPayload.ok, true);
    assert.equal(res.jsonPayload.repoRoot, repoB);

    res = await call(discoverHandler, { agentId: AGENT_ID, dir: root, force: true });
    assert.equal(res.statusCode, 200);
    assert.equal(res.jsonPayload.defaultRepo, repoB, 'discover 应下发持久化的默认仓库');
    assert.ok(res.jsonPayload.repos.some((r) => r.root === repoB));

    res = await call(defaultRepoHandler, { agentId: AGENT_ID, dir: root, repoRoot: '' });
    assert.equal(res.statusCode, 200);
    res = await call(discoverHandler, { agentId: AGENT_ID, dir: root, force: true });
    assert.equal(res.jsonPayload.defaultRepo, '', '清除后 discover 下发空串');
  });

  test('repoRoot 在 dir 之外 → 400，不落盘', async () => {
    const outside = mkdtempSync(join(DATA_ROOT, 'outside-'));
    mkdirSync(join(outside, '.git'));
    const res = await call(defaultRepoHandler, { agentId: AGENT_ID, dir: root, repoRoot: outside });
    assert.equal(res.statusCode, 400);
    assert.match(res.jsonPayload.error, /subdirectory/);
  });

  test('repoRoot 不是 git 仓库 → 400', async () => {
    const res = await call(defaultRepoHandler, { agentId: AGENT_ID, dir: root, repoRoot: plain });
    assert.equal(res.statusCode, 400);
    assert.match(res.jsonPayload.error, /not a git repository/);
  });

  test('agentId 缺省：default_repo 400；discover 仍工作且 defaultRepo 为空串', async () => {
    let res = await call(defaultRepoHandler, { dir: root, repoRoot: repoA });
    assert.equal(res.statusCode, 400);
    res = await call(discoverHandler, { dir: root, force: true });
    assert.equal(res.statusCode, 200);
    assert.equal(res.jsonPayload.defaultRepo, '');
    assert.equal(res.jsonPayload.repos.length, 2);
  });
});

describe('normalizeGitDefaultReposKey', () => {
  test('小写 + 反斜杠归一化，与项目目录键约定一致', () => {
    assert.equal(normalizeGitDefaultReposKey('D:\\Code\\Demo'), 'd:/code/demo');
    assert.equal(normalizeGitDefaultReposKey('  /home/dev/x '), '/home/dev/x');
    assert.equal(normalizeGitDefaultReposKey(''), '');
  });
});

describe('discoverGitRepos 缓存与端点 force 联动（回归）', () => {
  test('端点 force 透传：绕过缓存重扫', async () => {
    const handlers = captureHandlers();
    const root2 = mkdtempSync(join(DATA_ROOT, 'force-dir-'));
    let res = await call(handlers['/protoclaw/git/discover'], { agentId: AGENT_ID, dir: root2, force: true });
    assert.equal(res.statusCode, 200);
    assert.equal(res.jsonPayload.repos.length, 0);
    // 缓存层直接调用（同一模块实例缓存）：未 force 且命中负 TTL
    const cached = await discoverGitRepos(root2);
    assert.equal(cached.length, 0);
  });
});
