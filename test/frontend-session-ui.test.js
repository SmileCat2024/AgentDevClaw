/**
 * Tests for public/src/modules/session-ui.js
 *
 * Covers pure and near-pure functions:
 *   - isCompactedResumeSession (session metadata check)
 *   - getWorkspaceSessions / getWorkspaceSessionById (session lookup)
 *   - sortPhSessionsByMode (TODO-priority + date sorting)
 *   - getSessionContextLength / getSessionCompressRatio (config fallback)
 *   - renderSessionArchivedBadge / renderSessionTodoBadge / renderSessionResumeBadge (badges)
 *   - renderSessionTitleAiButton (AI button HTML)
 *   - renderSessionTokenBar (token usage bar)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deepEqual as deepLoose } from 'node:assert';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * Create a sandbox with session-ui.js loaded.
 */
function loadSessionUi(overrides = {}) {
  const defaults = {
    currentLanguage: 'zh',
    getCurrentAgentRecord: () => null,
    phSessionSortMode: 'updatedAt',
  };
  const ctx = createFrontendSandbox({ ...defaults, ...overrides });
  ctx.loadSource('public/src/modules/session-ui.js');
  return ctx;
}

// ── isCompactedResumeSession ────────────────────────────────

describe('session-ui: isCompactedResumeSession', () => {
  it('compacted resumeMode → true', () => {
    const ctx = loadSessionUi();
    assert.equal(ctx.run(`isCompactedResumeSession({ metadata: { resumeMode: 'compacted' } })`), true);
  });

  it('non-compacted resumeMode → false', () => {
    const ctx = loadSessionUi();
    assert.equal(ctx.run(`isCompactedResumeSession({ metadata: { resumeMode: 'trimmed' } })`), false);
  });

  it('no metadata → false', () => {
    const ctx = loadSessionUi();
    assert.equal(ctx.run(`isCompactedResumeSession({})`), false);
  });

  it('null → false', () => {
    const ctx = loadSessionUi();
    assert.equal(ctx.run(`isCompactedResumeSession(null)`), false);
  });
});

// ── getWorkspaceSessions ────────────────────────────────────

describe('session-ui: getWorkspaceSessions', () => {
  it('null agent → []', () => {
    const ctx = loadSessionUi();
    deepLoose(ctx.run('getWorkspaceSessions(null)'), []);
  });

  it('agent with sessions → sessions array', () => {
    const ctx = loadSessionUi();
    ctx.run(`var agent = {
      workspace_sessions: { sessions: [{ id: 's1' }, { id: 's2' }] },
    }`);
    const result = ctx.run('getWorkspaceSessions(agent)');
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 's1');
  });

  it('agent without workspace_sessions → []', () => {
    const ctx = loadSessionUi();
    deepLoose(ctx.run('getWorkspaceSessions({ id: "ph" })'), []);
  });
});

// ── getWorkspaceSessionById ─────────────────────────────────

describe('session-ui: getWorkspaceSessionById', () => {
  it('matching session → session object', () => {
    const ctx = loadSessionUi();
    ctx.run(`var agent = {
      workspace_sessions: { sessions: [{ id: 's1' }, { id: 's2' }] },
    }`);
    const result = ctx.run(`getWorkspaceSessionById(agent, 's2')`);
    assert.equal(result.id, 's2');
  });

  it('no matching session → null', () => {
    const ctx = loadSessionUi();
    ctx.run(`var agent = {
      workspace_sessions: { sessions: [{ id: 's1' }] },
    }`);
    assert.equal(ctx.run(`getWorkspaceSessionById(agent, 'nonexistent')`), null);
  });

  it('null agent → null', () => {
    const ctx = loadSessionUi();
    assert.equal(ctx.run(`getWorkspaceSessionById(null, 's1')`), null);
  });
});

// ── sortPhSessionsByMode ────────────────────────────────────

describe('session-ui: sortPhSessionsByMode', () => {
  it('TODO sessions sort above non-TODO', () => {
    const ctx = loadSessionUi();
    ctx.run(`var sessions = [
      { id: 'a', updatedAt: '2025-03-01', createdAt: '2025-01-01', todo: false },
      { id: 'b', updatedAt: '2025-01-01', createdAt: '2025-01-01', todo: true },
    ];`);
    const sorted = ctx.run('sortPhSessionsByMode(sessions)');
    assert.equal(sorted[0].id, 'b'); // TODO first
    assert.equal(sorted[1].id, 'a');
  });

  it('updatedAt mode (default) → most recent first', () => {
    const ctx = loadSessionUi();
    ctx.run(`var sessions = [
      { id: 'old', updatedAt: '2025-01-01', createdAt: '2025-01-01' },
      { id: 'new', updatedAt: '2025-03-01', createdAt: '2025-02-01' },
    ];`);
    const sorted = ctx.run('sortPhSessionsByMode(sessions)');
    assert.equal(sorted[0].id, 'new');
    assert.equal(sorted[1].id, 'old');
  });

  it('createdAt mode → most recently created first', () => {
    const ctx = loadSessionUi({ phSessionSortMode: 'createdAt' });
    ctx.run(`var sessions = [
      { id: 'old', updatedAt: '2025-03-01', createdAt: '2025-01-01' },
      { id: 'new', updatedAt: '2025-01-01', createdAt: '2025-03-01' },
    ];`);
    const sorted = ctx.run('sortPhSessionsByMode(sessions)');
    assert.equal(sorted[0].id, 'new');
    assert.equal(sorted[1].id, 'old');
  });

  it('does not mutate original array', () => {
    const ctx = loadSessionUi();
    ctx.run(`var sessions = [
      { id: 'a', updatedAt: '2025-01-01', createdAt: '2025-01-01' },
      { id: 'b', updatedAt: '2025-03-01', createdAt: '2025-03-01' },
    ];`);
    ctx.run('sortPhSessionsByMode(sessions)');
    assert.equal(ctx.run('sessions[0].id'), 'a'); // original order preserved
  });
});

// ── getSessionContextLength ─────────────────────────────────

describe('session-ui: getSessionContextLength', () => {
  it('session contextLength → session value', () => {
    const ctx = loadSessionUi();
    assert.equal(ctx.run(`getSessionContextLength({ contextLength: 128000 }, {})`), 128000);
  });

  it('agent fallback → agent value', () => {
    const ctx = loadSessionUi();
    assert.equal(ctx.run(`getSessionContextLength({}, { workspace_sessions: { contextLength: 64000 } })`), 64000);
  });

  it('no explicit → default 200000', () => {
    const ctx = loadSessionUi();
    assert.equal(ctx.run(`getSessionContextLength({}, {})`), 200000);
  });

  it('invalid session value (≤0) → fallback', () => {
    const ctx = loadSessionUi();
    assert.equal(ctx.run(`getSessionContextLength({ contextLength: 0 }, { workspace_sessions: { contextLength: 128000 } })`), 128000);
  });
});

// ── getSessionCompressRatio ─────────────────────────────────

describe('session-ui: getSessionCompressRatio', () => {
  it('session compressRatio → session value', () => {
    const ctx = loadSessionUi();
    assert.equal(ctx.run(`getSessionCompressRatio({ compressRatio: 60 }, {})`), 60);
  });

  it('agent fallback → agent value', () => {
    const ctx = loadSessionUi();
    assert.equal(ctx.run(`getSessionCompressRatio({}, { workspace_sessions: { compressRatio: 70 } })`), 70);
  });

  it('no explicit → default 80', () => {
    const ctx = loadSessionUi();
    assert.equal(ctx.run(`getSessionCompressRatio({}, {})`), 80);
  });

  it('invalid (>100) → fallback', () => {
    const ctx = loadSessionUi();
    assert.equal(ctx.run(`getSessionCompressRatio({ compressRatio: 150 }, {})`), 80);
  });

  it('invalid (≤0) → fallback', () => {
    const ctx = loadSessionUi();
    assert.equal(ctx.run(`getSessionCompressRatio({ compressRatio: -5 }, {})`), 80);
  });
});

// ── renderSessionArchivedBadge ──────────────────────────────

describe('session-ui: renderSessionArchivedBadge', () => {
  it('archived true (zh) → badge HTML', () => {
    const ctx = loadSessionUi();
    const result = ctx.run(`renderSessionArchivedBadge({ archived: true })`);
    assert.ok(result.includes('workspace-history-archived'));
    assert.ok(result.includes('已归档'));
  });

  it('archived false → empty string', () => {
    const ctx = loadSessionUi();
    assert.equal(ctx.run(`renderSessionArchivedBadge({ archived: false })`), '');
  });

  it('null → empty string', () => {
    const ctx = loadSessionUi();
    assert.equal(ctx.run(`renderSessionArchivedBadge(null)`), '');
  });

  it('archived true (en) → English label', () => {
    const ctx = loadSessionUi({ currentLanguage: 'en' });
    const result = ctx.run(`renderSessionArchivedBadge({ archived: true })`);
    assert.ok(result.includes('Archived'));
  });
});

// ── renderSessionTodoBadge ──────────────────────────────────

describe('session-ui: renderSessionTodoBadge', () => {
  it('todo true (zh) → badge HTML', () => {
    const ctx = loadSessionUi();
    const result = ctx.run(`renderSessionTodoBadge({ todo: true })`);
    assert.ok(result.includes('workspace-history-todo'));
    assert.ok(result.includes('待办'));
  });

  it('todo false → empty string', () => {
    const ctx = loadSessionUi();
    assert.equal(ctx.run(`renderSessionTodoBadge({ todo: false })`), '');
  });

  it('null → empty string', () => {
    const ctx = loadSessionUi();
    assert.equal(ctx.run(`renderSessionTodoBadge(null)`), '');
  });
});

// ── renderSessionResumeBadge ────────────────────────────────

describe('session-ui: renderSessionResumeBadge', () => {
  it('always returns empty string', () => {
    const ctx = loadSessionUi();
    assert.equal(ctx.run(`renderSessionResumeBadge({})`), '');
    assert.equal(ctx.run(`renderSessionResumeBadge(null)`), '');
  });
});

// ── renderSessionTitleAiButton ──────────────────────────────

describe('session-ui: renderSessionTitleAiButton', () => {
  it('(zh) → button HTML with Chinese labels', () => {
    const ctx = loadSessionUi();
    const result = ctx.run(`renderSessionTitleAiButton({ id: 's1' })`);
    assert.ok(result.includes('session-title-ai-btn'));
    assert.ok(result.includes('AI 生成标题'));
    assert.ok(result.includes('AI生成'));
  });

  it('(en) → button HTML with English labels', () => {
    const ctx = loadSessionUi({ currentLanguage: 'en' });
    const result = ctx.run(`renderSessionTitleAiButton({ id: 's1' })`);
    assert.ok(result.includes('AI generate title'));
    assert.ok(result.includes('AI Generate'));
  });

  it('includes session.id in onclick', () => {
    const ctx = loadSessionUi();
    const result = ctx.run(`renderSessionTitleAiButton({ id: 'sess-abc' })`);
    assert.ok(result.includes('sess-abc'));
  });
});

// ── renderSessionTokenBar ───────────────────────────────────

describe('session-ui: renderSessionTokenBar', () => {
  it('no token usage → empty string', () => {
    const ctx = loadSessionUi();
    assert.equal(ctx.run(`renderSessionTokenBar({}, {})`), '');
  });

  it('zero tokens → empty string', () => {
    const ctx = loadSessionUi();
    assert.equal(ctx.run(`renderSessionTokenBar({ tokenUsage: { totalTokens: 0 } }, {})`), '');
  });

  it('low usage → tone-low', () => {
    const ctx = loadSessionUi();
    const result = ctx.run(`renderSessionTokenBar({ tokenUsage: { lastRequestUsage: { inputTokens: 10000 } } }, {})`);
    assert.ok(result.includes('tone-low'));
    assert.ok(result.includes('5%')); // 10000/200000 = 5%
  });

  it('high usage → tone-compress', () => {
    const ctx = loadSessionUi();
    const result = ctx.run(`renderSessionTokenBar({ tokenUsage: { lastRequestUsage: { inputTokens: 170000 } } }, {})`);
    assert.ok(result.includes('tone-compress'));
    assert.ok(result.includes('85%')); // 170000/200000 = 85
  });

  it('mid usage → tone-mid', () => {
    const ctx = loadSessionUi();
    const result = ctx.run(`renderSessionTokenBar({ tokenUsage: { lastRequestUsage: { inputTokens: 100000 } }, contextLength: 200000 }, {})`);
    assert.ok(result.includes('tone-mid'));
    assert.ok(result.includes('50%'));
  });

  it('includes compress zone marker', () => {
    const ctx = loadSessionUi();
    const result = ctx.run(`renderSessionTokenBar({ tokenUsage: { lastRequestUsage: { inputTokens: 50000 } } }, {})`);
    assert.ok(result.includes('session-token-compress-zone'));
    assert.ok(result.includes('left:80%'));
  });
});
