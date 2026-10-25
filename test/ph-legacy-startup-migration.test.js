import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ThreadStore } from '../server/thread-control/thread-store.js';
import { runPhLegacyThreadMigration } from '../server/thread-control/ph-legacy-migration.js';

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
