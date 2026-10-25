import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ThreadStore } from '../server/thread-control/thread-store.js';
import { runPhLegacyThreadMigration, runPhThreadArchiveBackfill } from '../server/thread-control/ph-legacy-migration.js';

const record = (id, metadata = {}) => ({
  id, title: `Session ${id}`, createdAt: '2026-10-01T00:00:00.000Z', metadata,
});

async function fixture(t, sessions) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'ph-startup-migration-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const indexPath = path.join(dataRoot, 'workspaces', 'programming-helper', 'sessions', 'index.json');
  const threadsRoot = path.join(dataRoot, 'threads');
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(indexPath, JSON.stringify({ revision: 1, sessions }));
  return { dataRoot, indexPath, threadsRoot };
}

test('startup migration applies only unambiguous groups and records an idempotent completion marker', async (t) => {
  const fx = await fixture(t, [
    record('clean-root'),
    record('clean-head', { resumeMode: 'compacted', sourceSessionId: 'clean-root' }),
    record('fork-a', { resumeMode: 'compacted', sourceSessionId: 'amb-root' }),
    record('fork-b', { resumeMode: 'compacted', sourceSessionId: 'amb-root' }),
    record('amb-root'),
  ]);

  const first = await runPhLegacyThreadMigration(fx);
  assert.equal(first.skipped, false);
  assert.equal(first.summary.createdThreadCount, 1);
  assert.equal(first.summary.ambiguousComponentCount, 1);
  const store = new ThreadStore({ rootDir: fx.threadsRoot });
  const threads = await Promise.all((await store.list()).map((item) => store.get(item.threadId)));
  assert.deepEqual(threads.map((thread) => thread.sessionChain.map((item) => item.sessionId)), [['clean-root', 'clean-head']]);
  const marker = JSON.parse(await readFile(path.join(fx.dataRoot, 'migrations', 'ph-thread-legacy-v1', 'completed.json'), 'utf8'));
  assert.equal(marker.planHash, first.planHash);

  const second = await runPhLegacyThreadMigration(fx);
  assert.equal(second.skipped, true);
  assert.equal(second.planHash, undefined);
  assert.equal((await store.list()).length, 1);
});

test('startup migration skips a fresh data root without a PH session index', async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'ph-startup-empty-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const result = await runPhLegacyThreadMigration({
    dataRoot,
    indexPath: path.join(dataRoot, 'workspaces', 'programming-helper', 'sessions', 'index.json'),
    threadsRoot: path.join(dataRoot, 'threads'),
  });
  assert.deepEqual(result, { skipped: true, reason: 'session-index-not-found' });
});

// v2 归档补记（ADR-0032「已归档 = 线程归档」）：v1 建线未映射 head 的
// session.archived 标志，v2 补写归档索引。
async function backfillFixture(t, { sessions, threads, archiveEntries = {} }) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'ph-archive-backfill-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const indexPath = path.join(dataRoot, 'workspaces', 'programming-helper', 'sessions', 'index.json');
  const threadsRoot = path.join(dataRoot, 'threads');
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(indexPath, JSON.stringify({ revision: 1, sessions }));
  await mkdir(threadsRoot, { recursive: true });
  await writeFile(path.join(threadsRoot, 'index.json'), JSON.stringify({ threads }));
  await writeFile(path.join(threadsRoot, 'archive-index.json'), JSON.stringify({ threads: archiveEntries }));
  return { dataRoot, indexPath, threadsRoot };
}

test('archive backfill writes archive entries for archived heads and is idempotent', async (t) => {
  const fx = await backfillFixture(t, {
    sessions: [
      { id: 'head-archived', archived: true, updatedAt: 1790000000000 },
      { id: 'head-active', archived: false, updatedAt: 1790000000001 },
      { id: 'head-archived-done', archived: true, updatedAt: 1790000000002 },
      { id: 'legacy-no-thread', archived: true, updatedAt: 1790000000003 },
    ],
    threads: [
      { threadId: 'wt-a', agentId: 'programming-helper', headSessionId: 'head-archived', sessionIds: ['head-archived'] },
      { threadId: 'wt-b', agentId: 'programming-helper', headSessionId: 'head-active', sessionIds: ['head-active'] },
      { threadId: 'wt-c', agentId: 'programming-helper', headSessionId: 'head-archived-done', sessionIds: ['head-archived-done'] },
      { threadId: 'wt-x', agentId: 'coder', headSessionId: 'head-archived', sessionIds: ['head-archived'] },
    ],
    archiveEntries: { 'wt-c': { archivedAt: 1790000000099 } },
  });

  const first = await runPhThreadArchiveBackfill(fx);
  assert.equal(first.skipped, false);
  assert.deepEqual(first.summary, { archivedHeadThreads: 1, alreadyArchivedSkipped: 1 });
  const archiveIndex = JSON.parse(await readFile(path.join(fx.threadsRoot, 'archive-index.json'), 'utf8'));
  assert.equal(archiveIndex.threads['wt-a'].archivedAt, 1790000000000, 'archivedAt 取 head 会话 updatedAt');
  assert.equal(archiveIndex.threads['wt-c'].archivedAt, 1790000000099, '已归档条目不被覆盖（幂等）');
  assert.equal(archiveIndex.threads['wt-b'], undefined, '未归档 head 不动');
  assert.equal(archiveIndex.threads['wt-x'], undefined, '非 PH agentId 不在补记范围');
  assert.equal(archiveIndex.threads['legacy-no-thread'], undefined, '无线程存量会话不经本迁移（列表按会话标志分桶）');

  const second = await runPhThreadArchiveBackfill(fx);
  assert.equal(second.skipped, true, 'marker 存在时跳过');
});
