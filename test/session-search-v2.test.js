/**
 * Session search index v2 — per-message index, scope/sort/pagination and
 * message-boundary snippets.
 *
 * 数据隔离：AGENTDEV_DATA_DIR 指向临时目录，必须在任何 server 模块 import
 * 之前设置（session-access 链在模块加载时解析数据根）。不读真实用户目录。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';

const DATA_ROOT = path.join(os.tmpdir(), `agentdev-search-v2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.AGENTDEV_DATA_DIR = DATA_ROOT;

const { searchSessionsContent, loadPersistentSearchIndex, ensureSearchIndex, invalidateSearchIndex } = await import('../server/routes/session-search-index.js');
const { readSessionIndex, writeSessionIndex } = await import('../server/shared/session-access.js');
after(() => fs.rm(DATA_ROOT, { recursive: true, force: true }));

// ── Fixture helpers ───────────────────────────────────────────────

async function writeAgentFixture(agentId, sessions) {
  const dir = path.join(DATA_ROOT, 'prebuilt-sessions', agentId);
  await fs.mkdir(dir, { recursive: true });
  const index = { revision: 1, activeSessionId: null, sessions: [] };
  for (const s of sessions) {
    const file = path.join(dir, `${s.id}.json`);
    await fs.writeFile(file, JSON.stringify({ runtime: { context: { messages: s.messages } } }));
    const st = await fs.stat(file);
    index.sessions.push({
      id: s.id,
      title: s.title,
      archived: s.archived === true,
      todo: s.todo === true,
      openDirectory: s.openDirectory || 'D:/proj',
      sessionType: s.sessionType || 'main',
      updatedAt: s.updatedAt,
      createdAt: s.createdAt || s.updatedAt,
      messageCount: s.messages.length,
      fileMtimeMs: st.mtimeMs,
    });
  }
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify(index));
}

const DIR_A = 'D:\\proj';
const DIR_B = 'D:\\other';

// ── Shared fixture agents ─────────────────────────────────────────

before(async () => {
  await writeAgentFixture('search-v2-scope', [
    {
      id: 'sess-active',
      title: 'Active chat',
      updatedAt: '2026-10-01T10:00:00.000Z',
      messages: [
        { role: 'user', content: 'how to deploy the gateway widget' },
        { role: 'assistant', content: 'run deploy.sh in the widget folder' },
      ],
    },
    {
      id: 'sess-archived',
      title: 'Old chat',
      archived: true,
      updatedAt: '2026-09-01T10:00:00.000Z',
      messages: [
        { role: 'user', content: 'the widget broke again' },
      ],
    },
  ]);

  await writeAgentFixture('search-v2-sort', [
    {
      id: 'content-hit-new',
      title: 'Unrelated title',
      updatedAt: '2026-10-05T10:00:00.000Z',
      messages: [{ role: 'user', content: 'gizmo question' }],
    },
    {
      id: 'title-hit-old',
      title: 'gizmo overview',
      updatedAt: '2026-08-01T10:00:00.000Z',
      messages: [{ role: 'user', content: 'unrelated body text' }],
    },
  ]);

  await writeAgentFixture('search-v2-snippet', [
    {
      id: 'sess-snippet',
      title: 'Snippet chat',
      updatedAt: '2026-10-02T10:00:00.000Z',
      messages: [
        { role: 'user', content: 'please fix the login bug' },
        { role: 'assistant', content: 'short answer about the target keyword' },
        { role: 'user', content: 'A'.repeat(40) + '\nline with target keyword inside long text\n' + 'B'.repeat(40) },
        { role: 'assistant', content: 'target keyword appears here and target keyword appears again' },
      ],
    },
  ]);

  await writeAgentFixture('search-v2-dirs', [
    {
      id: 'sess-dir-a',
      title: 'Dir A chat',
      openDirectory: DIR_A,
      updatedAt: '2026-10-03T10:00:00.000Z',
      messages: [{ role: 'user', content: 'needle in dir a' }],
    },
    {
      id: 'sess-dir-b',
      title: 'Dir B chat',
      openDirectory: DIR_B,
      updatedAt: '2026-10-04T10:00:00.000Z',
      messages: [{ role: 'user', content: 'needle in dir b' }],
    },
  ]);

  // 30 matching sessions for pagination.
  await writeAgentFixture('search-v2-page', Array.from({ length: 30 }, (_, i) => ({
    id: `sess-page-${String(i).padStart(2, '0')}`,
    title: `Page chat ${i}`,
    updatedAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
    messages: [{ role: 'user', content: `pagination keyword ${i}` }],
  })));
});

// ── Scope filtering ───────────────────────────────────────────────

describe('searchSessionsContent scope filtering', () => {
  it('scope=all includes archived sessions by default', async () => {
    const result = await searchSessionsContent('search-v2-scope', 'widget', '', { scope: 'all' });
    assert.deepEqual(result.results.map(r => r.sessionId).sort(), ['sess-active', 'sess-archived']);
    assert.equal(result.scope, 'all');
  });

  it('scope=main excludes archived sessions', async () => {
    const result = await searchSessionsContent('search-v2-scope', 'widget', '', { scope: 'main' });
    assert.deepEqual(result.results.map(r => r.sessionId), ['sess-active']);
  });

  it('scope=archived returns only archived sessions', async () => {
    const result = await searchSessionsContent('search-v2-scope', 'widget', '', { scope: 'archived' });
    assert.deepEqual(result.results.map(r => r.sessionId), ['sess-archived']);
  });

  it('title-only matches are recalled with titleMatched and no content matches', async () => {
    const result = await searchSessionsContent('search-v2-sort', 'gizmo', '', { scope: 'all' });
    const titleOnly = result.results.find(r => r.sessionId === 'title-hit-old');
    assert.ok(titleOnly, 'title-only session must be recalled');
    assert.equal(titleOnly.titleMatched, true);
    assert.equal(titleOnly.matchCount, 0);
    assert.deepEqual(titleOnly.matches, []);
  });
});

// ── Sorting ───────────────────────────────────────────────────────

describe('searchSessionsContent sorting', () => {
  it('relevance puts title matches first, then recency', async () => {
    const result = await searchSessionsContent('search-v2-sort', 'gizmo', '', { sort: 'relevance' });
    assert.equal(result.results[0].sessionId, 'title-hit-old');
    assert.equal(result.results[0].titleMatched, true);
    assert.equal(result.results[1].sessionId, 'content-hit-new');
  });

  it('recency sorts purely by real updatedAt descending', async () => {
    const result = await searchSessionsContent('search-v2-sort', 'gizmo', '', { sort: 'recency' });
    assert.equal(result.results[0].sessionId, 'content-hit-new');
    assert.equal(result.results[1].sessionId, 'title-hit-old');
  });
});

// ── Snippets & matches ────────────────────────────────────────────

describe('searchSessionsContent match payloads', () => {
  it('produces message-boundary snippets with raw index and role, no internal tags', async () => {
    const result = await searchSessionsContent('search-v2-snippet', 'target keyword', '');
    assert.equal(result.results.length, 1);
    const r = result.results[0];
    assert.equal(r.matchCount, 3);
    assert.equal(r.matches.length, 3);
    for (const m of r.matches) {
      assert.ok(Number.isInteger(m.index), 'match.index must be the raw context index');
      assert.ok(m.role === 'user' || m.role === 'assistant');
      assert.ok(!m.snippet.includes('[user]'), 'snippet must not leak internal tags');
      assert.ok(!m.snippet.includes('[assistant]'), 'snippet must not leak internal tags');
      assert.ok(typeof m.snippet === 'string' && m.snippet.length > 0);
    }
    // The primary (first) hit is a short assistant answer → carries adjacent
    // question context from the previous user message.
    const primary = r.matches[0];
    assert.equal(primary.role, 'assistant');
    assert.equal(primary.index, 1);
    assert.ok(primary.context, 'short primary hit carries adjacent context');
    assert.equal(primary.context.relation, 'prev');
    assert.equal(primary.context.role, 'user');
    assert.ok(primary.context.snippet.includes('login bug'));
    // Occurrence counting is per matched message.
    const doubleHit = r.matches.find(m => m.occurrences === 2);
    assert.ok(doubleHit, 'double occurrence is reported');
  });

  it('keeps line structure readable in long-message snippets', async () => {
    const result = await searchSessionsContent('search-v2-snippet', 'target keyword', '');
    const longHit = result.results[0].matches.find(m => m.role === 'user');
    assert.ok(longHit);
    assert.ok(longHit.snippet.includes('\n'), 'multi-line snippet keeps newline structure');
  });

  it('recalls multimodal text parts and marks truncation in expanded excerpts', async () => {
    await writeAgentFixture('search-v2-parts', [{
      id: 'parts', title: 'Parts', updatedAt: '2026-10-02T00:00:00.000Z', messages: [
        { role: 'system', content: 'not searched' },
        { role: 'user', content: [{ type: 'image', url: 'ignored' }, { type: 'text', text: 'a'.repeat(300) + 'needle' + 'b'.repeat(900) }] },
      ],
    }]);
    const result = await searchSessionsContent('search-v2-parts', 'needle', '');
    const hit = result.results[0].matches[0];
    assert.equal(hit.index, 1);
    assert.equal(hit.excerptLeadingEllipsis, true);
    assert.equal(hit.excerptTrailingEllipsis, true);
    assert.ok(hit.excerpt.includes('needle'));
    assert.ok(!hit.excerpt.includes('ignored'));
  });

  it('still filters by openDirectory (normalized separators)', async () => {
    const result = await searchSessionsContent('search-v2-dirs', 'needle', 'd:/proj');
    assert.deepEqual(result.results.map(r => r.sessionId), ['sess-dir-a']);
  });
});

// ── Pagination ────────────────────────────────────────────────────

describe('searchSessionsContent pagination', () => {
  it('slices after filtering and reports the real total', async () => {
    const first = await searchSessionsContent('search-v2-page', 'pagination keyword', '', { limit: 20 });
    assert.equal(first.total, 30);
    assert.equal(first.results.length, 20);
    assert.equal(first.offset, 0);

    const second = await searchSessionsContent('search-v2-page', 'pagination keyword', '', { limit: 20, offset: 20 });
    assert.equal(second.total, 30);
    assert.equal(second.results.length, 10);
    assert.equal(second.offset, 20);
    // Pages must not overlap.
    const firstIds = new Set(first.results.map(r => r.sessionId));
    for (const r of second.results) assert.ok(!firstIds.has(r.sessionId));
  });

  it('caps limit at SESSION_SEARCH_MAX_RESULTS', async () => {
    const result = await searchSessionsContent('search-v2-page', 'pagination keyword', '', { limit: 500 });
    assert.equal(result.limit, 50);
    assert.equal(result.results.length, 30);
  });
});

// ── Index version & persistence invalidation ──────────────────────

describe('search index persistence', () => {
  it('does not reread sessions or rewrite the index when fileMtimeMs is absent', async () => {
    const agentId = 'search-v2-missing-mtime';
    await writeAgentFixture(agentId, [{
      id: 'empty', title: 'Empty chat', updatedAt: '2026-10-21T00:00:00.000Z', messages: [],
    }]);
    const index = await readSessionIndex(agentId);
    delete index.sessions[0].fileMtimeMs;
    await writeSessionIndex(agentId, index);
    await searchSessionsContent(agentId, 'Empty', '');
    const originalRead = fs.readFile;
    const originalWrite = fs.writeFile;
    const reads = [];
    const writes = [];
    fs.readFile = async (...args) => { reads.push(String(args[0])); return originalRead(...args); };
    fs.writeFile = async (...args) => { writes.push(String(args[0])); return originalWrite(...args); };
    try {
      const result = await searchSessionsContent(agentId, 'Empty', '');
      assert.equal(result.total, 1);
      assert.ok(!reads.some((file) => file.endsWith(`${path.sep}empty.json`)), 'unchanged session must not be reread');
      assert.equal(writes.length, 0, 'unchanged persistent index must not be rewritten');
    } finally {
      fs.readFile = originalRead;
      fs.writeFile = originalWrite;
    }
  });

  it('reuses unchanged entries but refreshes metadata, content, additions and removals', async () => {
    const agentId = 'search-v2-refresh';
    await writeAgentFixture(agentId, [{
      id: 'first', title: 'Original', updatedAt: '2026-10-01T00:00:00.000Z',
      messages: [{ role: 'user', content: 'old needle' }],
    }]);
    const cached = await ensureSearchIndex(agentId);
    assert.equal(await ensureSearchIndex(agentId), cached, 'unchanged metadata reuses the same index');
    let index = await readSessionIndex(agentId);
    Object.assign(index.sessions[0], { title: 'Renamed', archived: true, todo: true, openDirectory: 'D:/moved' });
    await writeSessionIndex(agentId, index);
    assert.notEqual(await ensureSearchIndex(agentId), cached);
    const renamed = await searchSessionsContent(agentId, 'needle', 'D:/moved', { scope: 'archived' });
    assert.equal(renamed.results[0].title, 'Renamed');
    assert.equal(renamed.results[0].todo, true);
    assert.equal((await searchSessionsContent(agentId, 'needle', 'D:/proj')).total, 0);

    const dir = path.join(DATA_ROOT, 'prebuilt-sessions', agentId);
    await fs.writeFile(path.join(dir, 'first.json'), JSON.stringify({ runtime: { context: { messages: [
      { role: 'assistant', content: 'replacement keyword' },
    ] } } }));
    index = await readSessionIndex(agentId);
    index.sessions[0].fileMtimeMs += 1000;
    await writeSessionIndex(agentId, index);
    assert.equal((await searchSessionsContent(agentId, 'old needle', '')).total, 0);
    assert.equal((await searchSessionsContent(agentId, 'replacement keyword', '')).total, 1);

    await fs.writeFile(path.join(dir, 'added.json'), JSON.stringify({ runtime: { context: { messages: [
      { role: 'user', content: 'added keyword' },
    ] } } }));
    index = await readSessionIndex(agentId);
    index.sessions.push({ id: 'added', title: 'Added', fileMtimeMs: 1 });
    await writeSessionIndex(agentId, index);
    assert.equal((await searchSessionsContent(agentId, 'added keyword', '')).total, 1);
    index.sessions = index.sessions.filter((entry) => entry.id !== 'first');
    await writeSessionIndex(agentId, index);
    assert.equal((await searchSessionsContent(agentId, 'replacement keyword', '')).total, 0);
    assert.equal((await loadPersistentSearchIndex(agentId)).first, undefined);

    const beforeInvalidation = await ensureSearchIndex(agentId);
    invalidateSearchIndex(agentId);
    assert.notEqual(await ensureSearchIndex(agentId), beforeInvalidation);
  });

  it('retries a previously unreadable session without requiring metadata changes', async () => {
    const agentId = 'search-v2-retry';
    await writeAgentFixture(agentId, [
      { id: 'late', title: 'Late', messages: [] },
      { id: 'good', title: 'Good', messages: [{ role: 'user', content: 'searchable' }] },
    ]);
    const file = path.join(DATA_ROOT, 'prebuilt-sessions', agentId, 'late.json');
    await fs.writeFile(file, '{');
    assert.equal((await searchSessionsContent(agentId, 'recovered', '')).total, 0);
    const originalWrite = fs.writeFile;
    let writes = 0;
    fs.writeFile = async (...args) => { writes += 1; return originalWrite(...args); };
    try {
      assert.equal((await searchSessionsContent(agentId, 'searchable', '')).total, 1);
      assert.equal(writes, 0, 'retrying an unreadable file must not rewrite unchanged indexed content');
    } finally {
      fs.writeFile = originalWrite;
    }
    await fs.writeFile(file, JSON.stringify({ runtime: { context: { messages: [
      { role: 'user', content: 'recovered' },
    ] } } }));
    assert.equal((await searchSessionsContent(agentId, 'recovered', '')).total, 1);
  });

  it('only builds snippets for the returned page while counting all matching messages', async () => {
    const agentId = 'search-v2-lazy-snippets';
    await writeAgentFixture(agentId, Array.from({ length: 3 }, (_, i) => ({
      id: `lazy-${i}`, title: `Lazy ${i}`, updatedAt: new Date(Date.UTC(2026, 9, i + 1)).toISOString(),
      messages: Array.from({ length: 12 }, () => ({ role: 'user', content: 'needle' })),
    })));
    const entries = await ensureSearchIndex(agentId);
    let unreturnedSnippetReads = 0;
    for (const msg of entries.get('lazy-0').msgs) {
      const text = msg.t;
      Object.defineProperty(msg, 't', { get() { unreturnedSnippetReads += 1; return text; } });
    }
    const result = await searchSessionsContent(agentId, 'needle', '', { limit: 1 });
    assert.equal(result.total, 3);
    assert.equal(result.results[0].sessionId, 'lazy-2');
    assert.equal(result.results[0].matchCount, 12);
    assert.equal(result.results[0].matches.length, 10);
    assert.equal(unreturnedSnippetReads, 12, 'off-page messages are read once for matching, never for snippets');
  });

  it('rejects a v1 persistent index and rebuilds from session files', async () => {
    const dir = path.join(DATA_ROOT, 'prebuilt-sessions', 'search-v2-legacy');
    await fs.mkdir(dir, { recursive: true });
    // Stale v1 index claiming a bogus hit for a session that does not exist.
    await fs.writeFile(path.join(dir, 'search-index.json'), JSON.stringify({
      version: 1,
      entries: {
        'ghost-session': { sessionId: 'ghost-session', title: 'ghost', text: 'legacy keyword', fileMtimeMs: 0 },
      },
    }));
    await writeAgentFixture('search-v2-legacy', [
      {
        id: 'real-session',
        title: 'Real chat',
        updatedAt: '2026-10-06T10:00:00.000Z',
        messages: [{ role: 'user', content: 'legacy keyword in real session' }],
      },
    ]);
    const loaded = await loadPersistentSearchIndex('search-v2-legacy');
    assert.equal(loaded, null, 'v1 persistent index must be rejected');
    const result = await searchSessionsContent('search-v2-legacy', 'legacy keyword', '');
    assert.deepEqual(result.results.map(r => r.sessionId), ['real-session']);
    // Rebuilt persistent index is readable again (v2).
    const reloaded = await loadPersistentSearchIndex('search-v2-legacy');
    assert.ok(reloaded && Array.isArray(reloaded['real-session'].msgs), 'v2 persistent index stores per-message records');
  });
});
