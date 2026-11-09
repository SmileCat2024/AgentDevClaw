import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { buildThreadDirectoryEntries, setupThreadDirectoryRoute } from '../server/routes/thread-directory.js';

test('thread directory applies head update date range, agent and archive filters before 50-item pagination', () => {
  const threads = Array.from({ length: 60 }, (_, index) => ({
    threadId: `wt-${index}`,
    agentId: index % 2 ? 'a' : 'b',
    title: `thread ${index}`,
    headSessionId: `s-${index}`,
    createdAt: '2026-10-01T00:00:00.000Z',
    sessionIds: [`s-${index}`],
  }));
  const sessionIndexes = ['a', 'b'].map((agentId) => ({
    agentId,
    sessions: threads.filter((thread) => thread.agentId === agentId).map((thread, index) => ({
      id: thread.headSessionId,
      title: thread.title,
      updatedAt: `2026-11-${String(index % 9 + 1).padStart(2, '0')}T12:00:00.000Z`,
    })),
  }));
  const result = buildThreadDirectoryEntries(threads, {
    sessionIndexes,
    archivedThreadIds: new Set(['wt-4']),
    includeArchived: true,
    from: '2026-11-03',
    to: '2026-11-05',
    limit: 100,
  });
  assert.equal(result.entries.length, 20);
  assert.ok(result.entries.every((entry) => entry.updatedAt >= '2026-11-03' && entry.updatedAt <= '2026-11-05T23:59:59.999Z'));
  assert.equal(result.entries.some((entry) => entry.updatedAt.startsWith('2026-11-05')), true);
  assert.equal(result.entries.some((entry) => entry.threadId === 'wt-4' && entry.archived), true);
  const defaultScope = buildThreadDirectoryEntries(threads, { sessionIndexes, archivedThreadIds: new Set(['wt-4']) });
  assert.equal(defaultScope.entries.some((entry) => entry.threadId === 'wt-4'), false);
  const capped = buildThreadDirectoryEntries(threads, { sessionIndexes, limit: 100 });
  assert.equal(capped.entries.length, 50);
  assert.equal(capped.limitCapped, true);
  assert.equal(capped.total, 60);
});

test('thread directory rejects invalid and reversed date ranges with a caller-visible error', () => {
  assert.throws(() => buildThreadDirectoryEntries([], { from: 'not-a-date' }), /valid ISO date/);
  assert.throws(() => buildThreadDirectoryEntries([], { from: '2026-11-10', to: '2026-11-09' }), /not be later/);
});

test('thread directory route reads persisted archive records and applies agent filter', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'thread-directory-'));
  try {
    await fs.mkdir(path.join(root, 'threads'));
    await fs.writeFile(path.join(root, 'index.json'), JSON.stringify({ threads: [
      { threadId: 'wt-live-a', agentId: 'a', title: 'live a', headSessionId: 's1', sessionIds: ['s1'], updatedAt: '2026-11-09T00:00:00Z' },
      { threadId: 'wt-live-b', agentId: 'b', title: 'live b', headSessionId: 's2', sessionIds: ['s2'], updatedAt: '2026-11-09T00:00:00Z' },
    ] }));
    await fs.writeFile(path.join(root, 'archive-index.json'), JSON.stringify({ threads: { 'wt-old-a': { archivedAt: Date.now() } } }));
    await fs.writeFile(path.join(root, 'threads', 'wt-old-a.json'), JSON.stringify({
      threadId: 'wt-old-a', agentId: 'a', title: 'old a', headSessionId: 's0', sessionIds: ['s0'], updatedAt: '2026-11-08T00:00:00Z',
    }));
    const routes = new Map();
    setupThreadDirectoryRoute({ get: (url, handler) => routes.set(url, handler) }, {
      threadsRoot: root,
      discoverAgents: async () => [{ id: 'a' }, { id: 'b' }],
      readSessionIndex: async (agentId) => ({ sessions: [{ id: agentId === 'a' ? 's1' : 's2', title: `head-${agentId}`, updatedAt: '2026-11-09T00:00:00Z' }] }),
    });
    const invoke = async (query) => {
      let body;
      const res = { json(value) { body = value; } };
      await routes.get('/protoclaw/thread_directory')({ query }, res, (error) => { throw error; });
      return body;
    };
    const live = await invoke({ agentId: 'a' });
    assert.deepEqual(live.threads.map((thread) => thread.threadId), ['wt-live-a']);
    const withArchived = await invoke({ agentId: 'a', includeArchived: '1' });
    assert.deepEqual(withArchived.threads.map((thread) => thread.threadId), ['wt-live-a', 'wt-old-a']);
    assert.equal(withArchived.threads[1].archived, true);
    const oversized = await invoke({ agentId: 'a', limit: '100' });
    assert.equal(oversized.requestedLimit, 100);
    assert.equal(oversized.maxResults, 50);
    assert.equal(oversized.limitCapped, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
