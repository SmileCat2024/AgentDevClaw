import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ThreadStore } from '../server/thread-control/thread-store.js';
import { applyPreview, writePreview } from '../scripts/migrate-ph-threads.mjs';
import { buildPhThreadMigrationPlan, materializeThreadRecord } from '../scripts/ph-thread-migration.js';

const session = (id, metadata = {}, createdAt = '2026-01-01T00:00:00.000Z') => ({
  id, title: `title-${id}`, createdAt, workspaceAgentId: 'main', metadata,
});

function deterministicPlan(sessions) {
  let next = 0;
  return buildPhThreadMigrationPlan({ revision: 7, sessions }, { makeThreadId: () => `wt-test-${++next}` });
}

test('plan merges a linear compacted lineage and assigns singleton sessions', () => {
  const plan = deterministicPlan([
    session('a'),
    session('b', { resumeMode: 'compacted', sourceSessionId: 'a', handoffSummaryKind: 'summary' }),
    session('c', { resumeMode: 'compacted', sourceSessionId: 'b' }),
    session('solo'),
  ]);
  assert.deepEqual(plan.groups.map((group) => group.sessionIds), [['a', 'b', 'c'], ['solo']]);
  assert.deepEqual(plan.summary, {
    threadCount: 2, memberCount: 4, singletonCount: 1, multiSessionThreadCount: 1,
    ambiguousComponentCount: 0, danglingEdgeCount: 0,
  });
});

test('branch sessions are separate threads and branch lineage remains in preview provenance', () => {
  const plan = deterministicPlan([
    session('root'),
    session('branch-a', { branchSourceSessionId: 'root' }),
  ]);
  assert.deepEqual(plan.groups.map((group) => group.sessionIds), [['root'], ['branch-a']]);
  assert.deepEqual(plan.branchOrigins, [{ sourceSessionId: 'root', sessionId: 'branch-a', sourcePresent: true }]);
});

test('multiple compacted successors are ambiguous and held for review', () => {
  const plan = deterministicPlan([
    session('root'),
    session('next-a', { resumeMode: 'compacted', sourceSessionId: 'root' }),
    session('next-b', { resumeMode: 'compacted', sourceSessionId: 'root' }),
  ]);
  assert.equal(plan.groups.length, 0);
  assert.deepEqual(plan.ambiguous[0].reasons, ['multiple_successors']);
});

test('duplicate session ids hold the affected lineage component for review', () => {
  const plan = deterministicPlan([
    session('root'),
    session('dup', { resumeMode: 'compacted', sourceSessionId: 'root' }),
    session('dup', { title: 'different duplicate' }),
  ]);
  assert.ok(plan.ambiguous.some((item) => item.sessionIds.includes('root') && item.sessionIds.includes('dup') && item.reasons.includes('duplicate_session_id')));
  assert.ok(!plan.groups.some((group) => group.sessionIds.includes('root') || group.sessionIds.includes('dup')));
});

test('dangling lineage and cycles are held for review', () => {
  const dangling = deterministicPlan([session('orphan-successor', { resumeMode: 'compacted', sourceSessionId: 'missing' })]);
  assert.equal(dangling.groups.length, 0);
  assert.ok(dangling.ambiguous[0].reasons.includes('dangling_source'));
  const cycle = deterministicPlan([
    session('x', { resumeMode: 'compacted', sourceSessionId: 'y' }),
    session('y', { resumeMode: 'compacted', sourceSessionId: 'x' }),
  ]);
  assert.equal(cycle.groups.length, 0);
  assert.ok(cycle.ambiguous[0].reasons.includes('cycle'));
  const missingSource = deterministicPlan([session('bad-successor', { resumeMode: 'compacted' })]);
  assert.ok(missingSource.ambiguous[0].reasons.includes('compacted_missing_source'));
});

test('one-shot child sessions are excluded; materialized records preserve lineage roles and reasons', () => {
  const index = { sessions: [session('a'), session('b', { resumeMode: 'compacted', sourceSessionId: 'a', handoffSummaryKind: 'nine-section' }), session('child', { resumeMode: 'one-shot' })] };
  const plan = deterministicPlan(index.sessions);
  assert.deepEqual(plan.excludedOneShotSessionIds, ['child']);
  const record = materializeThreadRecord(plan.groups[0], index, { now: () => 1234 });
  assert.equal(record.agentId, 'programming-helper');
  assert.equal(record.rootSessionId, 'a');
  assert.equal(record.headSessionId, 'b');
  assert.equal(record.identity, null);
  assert.deepEqual(record.sessionChain.map((entry) => [entry.sessionId, entry.role, entry.endKind]), [
    ['a', 'predecessor', 'trim'], ['b', 'head', null],
  ]);
});

async function fixture(t, sessions) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ph-thread-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const indexPath = path.join(root, 'sessions', 'index.json');
  await mkdir(path.dirname(indexPath), { recursive: true });
  const index = { revision: 11, activeSessionId: sessions.at(-1)?.id || null, sessions };
  await writeFile(indexPath, JSON.stringify(index));
  let threadCounter = 0;
  const plan = buildPhThreadMigrationPlan(index, { makeThreadId: () => `wt-test-${++threadCounter}` });
  const planPath = path.join(root, 'preview.json');
  await writeFile(planPath, JSON.stringify(plan));
  const cliPlanPath = path.join(root, 'cli-preview.json');
  return { root, indexPath, index, plan, planPath, cliPlanPath, threadsRoot: path.join(root, 'threads'), backupRoot: path.join(root, 'backup') };
}

test('apply backs up the source index, writes readable ThreadStore records, preserves archived heads, and is idempotent on retry', async (t) => {
  const fx = await fixture(t, [session('root', {}, '2026-01-01T00:00:00.000Z'), { ...session('next', { resumeMode: 'compacted', sourceSessionId: 'root' }), archived: true }]);
  const options = { indexPath: fx.indexPath, planPath: fx.planPath, threadsRoot: fx.threadsRoot, backupRoot: fx.backupRoot, confirmHash: fx.plan.planHash };
  const first = await applyPreview(options);
  assert.deepEqual(first.createdThreadIds, ['wt-test-1']);
  assert.deepEqual(JSON.parse(await readFile(path.join(fx.backupRoot, 'sessions-index.json'), 'utf8')), fx.index);
  const store = new ThreadStore({ rootDir: fx.threadsRoot });
  const persisted = await store.get('wt-test-1');
  assert.deepEqual(persisted.sessionChain.map((entry) => entry.sessionId), ['root', 'next']);
  assert.deepEqual((await store.list()).map((entry) => entry.threadId), ['wt-test-1']);
  assert.ok(JSON.parse(await readFile(path.join(fx.threadsRoot, 'archive-index.json'), 'utf8')).threads['wt-test-1']);
  assert.equal(await readFile(path.join(fx.backupRoot, 'archive-index.absent'), 'utf8'), 'absent\n');
  const retry = await applyPreview(options);
  assert.equal(retry.alreadyApplied, true);
  assert.deepEqual((await store.list()).map((entry) => entry.threadId), ['wt-test-1']);
});

test('CLI preview writes a fixed plan once and does not overwrite a prior operator preview', async (t) => {
  const fx = await fixture(t, [session('only')]);
  const first = await writePreview(fx.indexPath, fx.cliPlanPath);
  const saved = await readFile(fx.cliPlanPath, 'utf8');
  assert.equal(JSON.parse(saved).planHash, first.planHash);
  await assert.rejects(writePreview(fx.indexPath, fx.cliPlanPath), { code: 'EEXIST' });
  assert.equal(await readFile(fx.cliPlanPath, 'utf8'), saved);
});

test('apply refuses backup paths inside the thread store before any write', async (t) => {
  const fx = await fixture(t, [session('only')]);
  await assert.rejects(applyPreview({
    indexPath: fx.indexPath, planPath: fx.planPath, threadsRoot: fx.threadsRoot,
    backupRoot: path.join(fx.threadsRoot, 'backup'), confirmHash: fx.plan.planHash,
  }), /outside the thread store/);
  assert.deepEqual(await (new ThreadStore({ rootDir: fx.threadsRoot })).list(), []);
});

test('apply can resume an interrupted same-plan write without duplicating threads', async (t) => {
  const fx = await fixture(t, [session('root'), session('next', { resumeMode: 'compacted', sourceSessionId: 'root' }), session('solo')]);
  const store = new ThreadStore({ rootDir: fx.threadsRoot });
  await store.create(materializeThreadRecord(fx.plan.groups[0], fx.index, { now: () => 777 }));
  await store.create(materializeThreadRecord(fx.plan.groups[1], fx.index, { now: () => 888 }));
  const result = await applyPreview({
    indexPath: fx.indexPath, planPath: fx.planPath, threadsRoot: fx.threadsRoot,
    backupRoot: fx.backupRoot, confirmHash: fx.plan.planHash,
  });
  const records = await Promise.all((await store.list()).map((entry) => store.get(entry.threadId)));
  assert.equal(records.length, fx.plan.groups.length);
  assert.deepEqual(new Set(records.flatMap((record) => record.sessionChain.map((entry) => entry.sessionId))), new Set(['root', 'next', 'solo']));
  assert.equal(result.createdThreadIds.length, fx.plan.groups.length);
});

test('apply refuses stale plans before creating records or backup', async (t) => {
  const fx = await fixture(t, [session('only')]);
  await writeFile(fx.indexPath, JSON.stringify({ ...fx.index, revision: 12 }));
  await assert.rejects(applyPreview({
    indexPath: fx.indexPath, planPath: fx.planPath, threadsRoot: fx.threadsRoot,
    backupRoot: fx.backupRoot, confirmHash: fx.plan.planHash,
  }), /Session index changed after preview/);
  assert.deepEqual(await (new ThreadStore({ rootDir: fx.threadsRoot })).list(), []);
  await assert.rejects(readFile(path.join(fx.backupRoot, 'sessions-index.json')));
});

test('apply migrates clean groups while ambiguous components stay untouched', async (t) => {
  const fx = await fixture(t, [
    session('clean-root'),
    session('clean-next', { resumeMode: 'compacted', sourceSessionId: 'clean-root' }),
    session('fork-a', { resumeMode: 'compacted', sourceSessionId: 'amb-root' }),
    session('fork-b', { resumeMode: 'compacted', sourceSessionId: 'amb-root' }),
    session('amb-root'),
  ]);
  assert.deepEqual(fx.plan.groups.map((group) => group.sessionIds), [['clean-root', 'clean-next']]);
  assert.equal(fx.plan.ambiguous.length, 1);
  const result = await applyPreview({
    indexPath: fx.indexPath, planPath: fx.planPath, threadsRoot: fx.threadsRoot,
    backupRoot: fx.backupRoot, confirmHash: fx.plan.planHash,
  });
  assert.deepEqual(result.createdThreadIds, ['wt-test-1']);
  const store = new ThreadStore({ rootDir: fx.threadsRoot });
  const records = await Promise.all((await store.list()).map((entry) => store.get(entry.threadId)));
  const migratedMembers = records.flatMap((record) => record.sessionChain.map((entry) => entry.sessionId));
  assert.deepEqual(migratedMembers, ['clean-root', 'clean-next']);
  for (const sessionId of ['amb-root', 'fork-a', 'fork-b']) {
    assert.ok(!migratedMembers.includes(sessionId), `${sessionId} must not be written into any thread`);
  }
});

test('apply migrates alongside pre-existing threads and leaves them untouched', async (t) => {
  const sessions = [
    session('existing-head'),
    session('clean-root'),
    session('clean-next', { resumeMode: 'compacted', sourceSessionId: 'clean-root' }),
  ];
  const index = { revision: 3, activeSessionId: null, sessions };
  const fx = await fixture(t, sessions);
  await writeFile(fx.indexPath, JSON.stringify(index));
  const store = new ThreadStore({ rootDir: fx.threadsRoot });
  const existingRecord = materializeThreadRecord(
    { threadId: 'wt-preexisting', sessionIds: ['existing-head'], edges: [] },
    index, { now: () => 555 },
  );
  await store.create(existingRecord);

  const plan = await writePreview(fx.indexPath, fx.cliPlanPath, { threadsRoot: fx.threadsRoot });
  assert.deepEqual(plan.skippedAlreadyThreadedSessionIds, ['existing-head']);
  const result = await applyPreview({
    indexPath: fx.indexPath, planPath: fx.cliPlanPath, threadsRoot: fx.threadsRoot,
    backupRoot: fx.backupRoot, confirmHash: plan.planHash,
  });
  assert.deepEqual(result.createdThreadIds, plan.groups.map((group) => group.threadId));
  const records = await Promise.all((await store.list()).map((entry) => store.get(entry.threadId)));
  const existing = records.find((record) => record.threadId === 'wt-preexisting');
  assert.deepEqual(existing, existingRecord);
  const migratedMembers = records.filter((record) => record.threadId !== 'wt-preexisting')
    .flatMap((record) => record.sessionChain.map((entry) => entry.sessionId));
  assert.deepEqual(migratedMembers.sort(), ['clean-next', 'clean-root']);
});

test('apply requires explicit matching plan hash and rejects ambiguous lineage without writes', async (t) => {
  const fx = await fixture(t, [session('root'), session('next-a', { resumeMode: 'compacted', sourceSessionId: 'root' }), session('next-b', { resumeMode: 'compacted', sourceSessionId: 'root' })]);
  const options = { indexPath: fx.indexPath, planPath: fx.planPath, threadsRoot: fx.threadsRoot, backupRoot: fx.backupRoot };
  await assert.rejects(applyPreview({ ...options, confirmHash: 'wrong' }), /Confirmation hash/);
  await assert.rejects(applyPreview({ ...options, confirmHash: fx.plan.planHash }), /no unambiguous groups/);
  assert.deepEqual(await (new ThreadStore({ rootDir: fx.threadsRoot })).list(), []);
  await assert.rejects(readFile(path.join(fx.backupRoot, 'sessions-index.json')));
});
