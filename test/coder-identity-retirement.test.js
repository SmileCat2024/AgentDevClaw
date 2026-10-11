// server/routes/coder-identity-retirement.js 的遗弃搬移测试（ADR-0025 决策 5）。
// 显式注入数据根，不触碰真实用户数据目录。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const { runCoderIdentityRetirement } = await import('../server/routes/coder-identity-retirement.js');

const RETIRED_DIR_NAME = 'coder-identity-20261011';

const roots = [];

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'coder-retirement-test-'));
  roots.push(root);
  return root;
}

after(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 造一套完整的事实面：threads 三类归属 + 归档 + boards + ph 会话三类 + 遗留树。 */
async function seedFullFixture(root) {
  // threads：coder 遗留 / ph+identity=coder / ph 无 identity / 非 coder 工作空间
  const liveThreads = [
    { threadId: 'wt-aug-legacy', workspaceId: 'coder' },
    { threadId: 'wt-merged-identity', workspaceId: 'programming-helper', identity: 'coder' },
    { threadId: 'wt-merged-early', workspaceId: 'programming-helper' },
    { threadId: 'wt-other-ws', workspaceId: 'qqbot' },
  ];
  await writeJson(path.join(root, 'threads', 'index.json'), { revision: 7, threads: liveThreads });
  const recordsDir = path.join(root, 'threads', 'threads');
  for (const entry of liveThreads) {
    await writeJson(path.join(recordsDir, `${entry.threadId}.json`), { ...entry, status: 'open' });
  }
  // 归档：一条 coder 侧（记录文件在库）、一条非 coder 侧
  const archivedIdCoder = 'wt-archived-coder';
  const archivedIdOther = 'wt-archived-other';
  await writeJson(path.join(recordsDir, `${archivedIdCoder}.json`), { threadId: archivedIdCoder, workspaceId: 'programming-helper', identity: 'coder', status: 'closed' });
  await writeJson(path.join(recordsDir, `${archivedIdOther}.json`), { threadId: archivedIdOther, workspaceId: 'qqbot', status: 'closed' });
  await writeJson(path.join(root, 'threads', 'archive-index.json'), {
    version: 1,
    threads: {
      [archivedIdCoder]: { archivedAt: 1787555391433 },
      [archivedIdOther]: { archivedAt: 1787555391690 },
    },
  });
  // boards：线程看板 + help 看板（非线程，保留）
  const boardsDir = path.join(root, 'threads', 'boards');
  for (const id of ['wt-aug-legacy', 'wt-merged-identity', 'wt-other-ws', archivedIdCoder, archivedIdOther]) {
    await writeJson(path.join(boardsDir, `${id}.board.json`), { workThreadId: id });
  }
  await writeJson(path.join(boardsDir, 'help.board.json'), { workThreadId: '--help' });

  // ph 会话：main / coder / exploration（exploration 不是 coder 侧，保留）
  const phSessionsDir = path.join(root, 'workspaces', 'programming-helper', 'sessions');
  await writeJson(path.join(phSessionsDir, 'index.json'), {
    revision: 3,
    activeSessionId: 's-main-1',
    sessions: [
      { id: 's-main-1', sessionType: 'main', title: 'main 会话' },
      { id: 's-coder-1', sessionType: 'coder', title: 'coder 会话' },
      { id: 's-coder-2', sessionType: 'coder', title: 'coder 会话 2' },
      { id: 's-expl-1', sessionType: 'exploration', title: '历史探索' },
    ],
  });
  for (const id of ['s-main-1', 's-coder-1', 's-coder-2', 's-expl-1']) {
    await writeJson(path.join(phSessionsDir, `${id}.json`), { id });
  }
  await writeJson(path.join(root, 'workspaces', 'programming-helper', 'open-sessions.json'), {
    updatedAt: '2026-10-10T00:00:00.000Z',
    sessions: [
      { sessionId: 's-main-1', title: 'main 会话' },
      { sessionId: 's-coder-1', title: 'coder 会话' },
    ],
  });

  // 8 月独立工作空间遗留树
  await writeJson(path.join(root, 'workspaces', 'coder', 'sessions', 'index.json'), {
    revision: 1,
    sessions: [{ id: 's-legacy', sessionType: 'main' }],
  });
  await writeJson(path.join(root, 'workspaces', 'coder', 'demo-tickets', '01.json'), { title: 'demo' });
}

test('retires all coder-side data while preserving main-side facts', async () => {
  const root = await makeRoot();
  await seedFullFixture(root);

  const result = await runCoderIdentityRetirement(root);
  assert.equal(result.skipped, false);
  assert.equal(result.counts.threads.liveThreads, 3);
  assert.equal(result.counts.threads.archivedEntries, 1);
  assert.equal(result.counts.phSessions.sessions, 2);
  assert.equal(result.counts.phSessions.openSessionEntries, 1);
  assert.equal(result.counts.legacyWorkspace, true);

  // 活动库：threads 只剩非 coder 条目，记录/看板只剩对应文件
  const threadsIndex = await readJson(path.join(root, 'threads', 'index.json'));
  assert.deepEqual(threadsIndex.threads.map((t) => t.threadId), ['wt-other-ws']);
  assert.equal(threadsIndex.revision, 8);
  const recordsDir = path.join(root, 'threads', 'threads');
  assert.deepEqual((await fs.readdir(recordsDir)).sort(), ['wt-archived-other.json', 'wt-other-ws.json']);
  const boardsDir = path.join(root, 'threads', 'boards');
  assert.deepEqual((await fs.readdir(boardsDir)).sort(), ['help.board.json', 'wt-archived-other.board.json', 'wt-other-ws.board.json']);
  const archiveIndex = await readJson(path.join(root, 'threads', 'archive-index.json'));
  assert.deepEqual(Object.keys(archiveIndex.threads), ['wt-archived-other']);

  // 活动库：ph 会话只剩 main + exploration，open-sessions 只剩 main
  const phIndex = await readJson(path.join(root, 'workspaces', 'programming-helper', 'sessions', 'index.json'));
  assert.deepEqual(phIndex.sessions.map((s) => s.id), ['s-main-1', 's-expl-1']);
  assert.equal(await exists(path.join(root, 'workspaces', 'programming-helper', 'sessions', 's-coder-1.json')), false);
  assert.equal(await exists(path.join(root, 'workspaces', 'programming-helper', 'sessions', 's-coder-2.json')), false);
  const openSessions = await readJson(path.join(root, 'workspaces', 'programming-helper', 'open-sessions.json'));
  assert.deepEqual(openSessions.sessions.map((s) => s.sessionId), ['s-main-1']);

  // 活动库：遗留 coder 工作空间整树消失
  assert.equal(await exists(path.join(root, 'workspaces', 'coder')), false);

  // 遗弃目录：结构完整 + 完成标记
  const retired = path.join(root, 'retired', RETIRED_DIR_NAME);
  assert.equal(await exists(path.join(retired, 'MIGRATED.json')), true);
  assert.equal(await exists(path.join(retired, 'threads', 'index.json')), true);
  assert.equal(await exists(path.join(retired, 'threads', 'archive-index.json')), true);
  assert.equal(await exists(path.join(retired, 'threads', 'threads', 'wt-aug-legacy.json')), true);
  assert.equal(await exists(path.join(retired, 'threads', 'boards', 'wt-merged-identity.board.json')), true);
  assert.equal(await exists(path.join(retired, 'workspaces', 'coder', 'sessions', 'index.json')), true);
  assert.equal(await exists(path.join(retired, 'workspaces', 'programming-helper', 'sessions', 's-coder-1.json')), true);
  assert.equal(await exists(path.join(retired, 'workspaces', 'programming-helper', 'open-sessions.json')), true);
  // 遗弃的索引快照保留搬移前原貌（4 条线程全量）
  const retiredIndexSnapshot = await readJson(path.join(retired, 'threads', 'index.json'));
  assert.equal(retiredIndexSnapshot.threads.length, 4);
});

test('second run is a no-op (MIGRATED marker)', async () => {
  const root = await makeRoot();
  await seedFullFixture(root);
  await runCoderIdentityRetirement(root);
  const result = await runCoderIdentityRetirement(root);
  assert.equal(result.skipped, true);
});

test('half-migrated directory without marker refuses startup (fail-hard)', async () => {
  const root = await makeRoot();
  await seedFullFixture(root);
  await fs.mkdir(path.join(root, 'retired', RETIRED_DIR_NAME), { recursive: true });
  await assert.rejects(runCoderIdentityRetirement(root), /完成标记/);
});

test('fresh data root migrates trivially and writes the marker', async () => {
  const root = await makeRoot();
  const result = await runCoderIdentityRetirement(root);
  assert.equal(result.skipped, false);
  assert.equal(result.counts.threads.liveThreads, 0);
  assert.equal(result.counts.phSessions.sessions, 0);
  assert.equal(result.counts.legacyWorkspace, false);
  assert.equal(await exists(path.join(root, 'retired', RETIRED_DIR_NAME, 'MIGRATED.json')), true);
  const second = await runCoderIdentityRetirement(root);
  assert.equal(second.skipped, true);
});
