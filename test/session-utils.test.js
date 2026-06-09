/**
 * Tests for server.js session utility pure functions.
 *
 * Covers:
 * 1. buildSessionTitle — "对话 YYYY-MM-DD HH:MM" format generation
 * 2. getNextNewSessionTitle counter logic — "新对话N" increment
 * 3. normalizeSessionMetadata — metadata normalization and empty value filtering
 * 4. sanitizeProjectDocsetId — ID slugification
 * 5. cleanProjectDocsetPayload — payload cleaning
 * 6. normalizeProjectConversationRecord — conversation record normalization
 *
 * These mirror the actual code paths in server.js.
 * When the server code changes, these tests should be updated accordingly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Inline helpers (mirrors server.js) ──

function cleanSessionText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildSessionTitle(createdAtIso) {
  const date = new Date(createdAtIso);
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ];
  const time = [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
  ];
  return `对话 ${parts.join('-')} ${time.join(':')}`;
}

/**
 * Mirrors getNextNewSessionTitle counter logic.
 * Extracted from the server.js function to test the pure increment decision.
 */
function computeNextSessionNumber(sessions, openDirectory) {
  const normalizedDir = String(openDirectory || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const newSessionPattern = /^新对话(\d+)$/;
  let maxN = 0;
  for (const session of sessions) {
    const sessionDir = String(session?.openDirectory || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (normalizedDir && sessionDir !== normalizedDir) continue;
    const m = cleanSessionText(session?.title).match(newSessionPattern);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxN) maxN = n;
    }
  }
  return maxN + 1;
}

function normalizeSessionMetadata(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const metadata = {
    resumeMode: cleanSessionText(raw.resumeMode),
    sourceAgentId: cleanSessionText(raw.sourceAgentId),
    sourceSessionId: cleanSessionText(raw.sourceSessionId),
    handoffId: cleanSessionText(raw.handoffId),
    handoffPath: cleanSessionText(raw.handoffPath),
    handoffCreatedAt: cleanSessionText(raw.handoffCreatedAt),
    handoffSummaryKind: cleanSessionText(raw.handoffSummaryKind),
  };

  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value),
  );
}

function sanitizeProjectDocsetId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'doc';
}

function cleanProjectDocsetPayload(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(raw)
      .map(([key, value]) => [String(key), typeof value === 'string' ? value.trim() : value])
      .filter(([, value]) => value !== undefined && value !== null && !(typeof value === 'string' && value === '')),
  );
}

function normalizeProjectConversationRecord(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const timestamp = new Date().toISOString();
  return {
    sessionId: sanitizeProjectDocsetId(source.sessionId || 'session'),
    title: cleanSessionText(source.title) || 'conversation-record',
    summary: cleanSessionText(source.summary),
    currentFocus: cleanSessionText(source.currentFocus),
    keyDecisions: Array.isArray(source.keyDecisions) ? source.keyDecisions.map((value) => cleanSessionText(value)).filter(Boolean) : [],
    nextActions: Array.isArray(source.nextActions) ? source.nextActions.map((value) => cleanSessionText(value)).filter(Boolean) : [],
    openQuestions: Array.isArray(source.openQuestions) ? source.openQuestions.map((value) => cleanSessionText(value)).filter(Boolean) : [],
    relatedMaterialIds: Array.isArray(source.relatedMaterialIds) ? source.relatedMaterialIds.map((value) => sanitizeProjectDocsetId(value)).filter(Boolean) : [],
    createdAt: typeof source.createdAt === 'string' && source.createdAt ? source.createdAt : timestamp,
    updatedAt: typeof source.updatedAt === 'string' && source.updatedAt ? source.updatedAt : timestamp,
  };
}

// ── Tests ──

describe('buildSessionTitle', () => {
  it('formats date to "对话 YYYY-MM-DD HH:MM" pattern', () => {
    // Use local-time ISO string to avoid timezone issues across environments
    const result = buildSessionTitle('2026-06-09T14:30:00');
    assert.ok(/^对话 2026-06-\d{2} \d{2}:\d{2}$/.test(result), `unexpected: ${result}`);
    // The date part should contain June and the time should contain valid hour/minute
    assert.ok(result.includes('对话'));
    assert.ok(result.includes(':'));
  });

  it('pads single-digit months, days, hours, minutes', () => {
    // Use local-time string to avoid TZ offset: Jan 5 at 09:05 local
    const result = buildSessionTitle(new Date(2026, 0, 5, 9, 5, 0).toISOString());
    // Just verify format structure; exact values depend on TZ
    assert.ok(/^对话 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(result));
  });

  it('produces consistent output for same input', () => {
    const iso = new Date(2026, 5, 9, 14, 30, 0).toISOString();
    assert.equal(buildSessionTitle(iso), buildSessionTitle(iso));
  });

  it('contains date and time parts separated by space', () => {
    const result = buildSessionTitle(new Date().toISOString());
    const parts = result.split(' ');
    // "对话" + "YYYY-MM-DD" + "HH:MM"
    assert.equal(parts.length, 3);
    assert.equal(parts[0], '对话');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(parts[1]));
    assert.ok(/^\d{2}:\d{2}$/.test(parts[2]));
  });
});

describe('getNextNewSessionTitle counter logic', () => {
  it('returns 1 when no sessions exist', () => {
    assert.equal(computeNextSessionNumber([], '/project'), 1);
  });

  it('returns max+1 from existing 新对话N titles', () => {
    const sessions = [
      { title: '新对话1', openDirectory: '/project' },
      { title: '新对话2', openDirectory: '/project' },
    ];
    assert.equal(computeNextSessionNumber(sessions, '/project'), 3);
  });

  it('ignores non-default titles', () => {
    const sessions = [
      { title: '新对话1', openDirectory: '/project' },
      { title: '数据库优化', openDirectory: '/project' },
      { title: '新对话5', openDirectory: '/project' },
    ];
    assert.equal(computeNextSessionNumber(sessions, '/project'), 6);
  });

  it('only counts sessions with matching openDirectory', () => {
    const sessions = [
      { title: '新对话1', openDirectory: '/project-a' },
      { title: '新对话2', openDirectory: '/project-b' },
      { title: '新对话3', openDirectory: '/project-a' },
    ];
    assert.equal(computeNextSessionNumber(sessions, '/project-a'), 4);
    assert.equal(computeNextSessionNumber(sessions, '/project-b'), 3);
  });

  it('counts all sessions when openDirectory is empty', () => {
    const sessions = [
      { title: '新对话1', openDirectory: '/project-a' },
      { title: '新对话2', openDirectory: '/project-b' },
    ];
    assert.equal(computeNextSessionNumber(sessions, ''), 3);
  });

  it('normalizes backslashes in directory comparison', () => {
    const sessions = [
      { title: '新对话1', openDirectory: 'C:\\Users\\test\\project' },
    ];
    assert.equal(computeNextSessionNumber(sessions, 'C:/Users/test/project'), 2);
  });
});

describe('normalizeSessionMetadata', () => {
  it('returns empty object for null input', () => {
    assert.deepEqual(normalizeSessionMetadata(null), {});
  });

  it('returns empty object for array input', () => {
    assert.deepEqual(normalizeSessionMetadata([1, 2, 3]), {});
  });

  it('returns empty object for string input', () => {
    assert.deepEqual(normalizeSessionMetadata('hello'), {});
  });

  it('preserves valid fields', () => {
    const result = normalizeSessionMetadata({
      resumeMode: 'compacted',
      sourceAgentId: 'agent-1',
      sourceSessionId: 'sess-1',
    });
    assert.equal(result.resumeMode, 'compacted');
    assert.equal(result.sourceAgentId, 'agent-1');
    assert.equal(result.sourceSessionId, 'sess-1');
  });

  it('trims whitespace from field values', () => {
    const result = normalizeSessionMetadata({
      resumeMode: '  compacted  ',
    });
    assert.equal(result.resumeMode, 'compacted');
  });

  it('filters out empty string values', () => {
    const result = normalizeSessionMetadata({
      resumeMode: 'compacted',
      sourceAgentId: '',
      sourceSessionId: '   ',
      handoffId: undefined,
    });
    assert.ok(!('sourceAgentId' in result));
    assert.ok(!('sourceSessionId' in result));
    assert.ok(!('handoffId' in result));
    assert.equal(result.resumeMode, 'compacted');
  });

  it('returns empty object when all fields are empty', () => {
    assert.deepEqual(normalizeSessionMetadata({ resumeMode: '', sourceAgentId: '' }), {});
  });
});

describe('sanitizeProjectDocsetId', () => {
  it('lowercases input', () => {
    assert.equal(sanitizeProjectDocsetId('MyProject'), 'myproject');
  });

  it('replaces non-alphanumeric chars with hyphens', () => {
    assert.equal(sanitizeProjectDocsetId('hello world test'), 'hello-world-test');
  });

  it('collapses multiple hyphens', () => {
    assert.equal(sanitizeProjectDocsetId('a---b'), 'a-b');
  });

  it('strips leading and trailing hyphens', () => {
    assert.equal(sanitizeProjectDocsetId('-hello-'), 'hello');
  });

  it('allows underscores and hyphens', () => {
    assert.equal(sanitizeProjectDocsetId('my_project-v2'), 'my_project-v2');
  });

  it('returns "doc" for empty input', () => {
    assert.equal(sanitizeProjectDocsetId(''), 'doc');
    assert.equal(sanitizeProjectDocsetId('---'), 'doc');
    assert.equal(sanitizeProjectDocsetId(null), 'doc');
  });
});

describe('cleanProjectDocsetPayload', () => {
  it('returns empty object for null input', () => {
    assert.deepEqual(cleanProjectDocsetPayload(null), {});
  });

  it('returns empty object for array input', () => {
    assert.deepEqual(cleanProjectDocsetPayload([1, 2]), {});
  });

  it('preserves non-empty string values', () => {
    const result = cleanProjectDocsetPayload({ name: 'test', value: 42 });
    assert.equal(result.name, 'test');
    assert.equal(result.value, 42);
  });

  it('trims string values', () => {
    const result = cleanProjectDocsetPayload({ name: '  test  ' });
    assert.equal(result.name, 'test');
  });

  it('removes entries with undefined or null values', () => {
    const result = cleanProjectDocsetPayload({ a: undefined, b: null, c: 'keep' });
    assert.ok(!('a' in result));
    assert.ok(!('b' in result));
    assert.equal(result.c, 'keep');
  });

  it('removes entries with empty string values', () => {
    const result = cleanProjectDocsetPayload({ a: '', b: 'keep' });
    assert.ok(!('a' in result));
    assert.equal(result.b, 'keep');
  });

  it('preserves boolean and numeric values including 0 and false', () => {
    const result = cleanProjectDocsetPayload({ flag: false, count: 0, name: 'x' });
    assert.equal(result.flag, false);
    assert.equal(result.count, 0);
    assert.equal(result.name, 'x');
  });
});

describe('normalizeProjectConversationRecord', () => {
  it('returns defaults for empty input', () => {
    const result = normalizeProjectConversationRecord({});
    assert.equal(result.sessionId, 'session');
    assert.equal(result.title, 'conversation-record');
    assert.deepEqual(result.keyDecisions, []);
    assert.deepEqual(result.nextActions, []);
    assert.deepEqual(result.openQuestions, []);
    assert.deepEqual(result.relatedMaterialIds, []);
    assert.ok(result.createdAt);
    assert.ok(result.updatedAt);
  });

  it('normalizes sessionId through sanitizeProjectDocsetId', () => {
    const result = normalizeProjectConversationRecord({ sessionId: 'My Session ID' });
    assert.equal(result.sessionId, 'my-session-id');
  });

  it('cleans string arrays', () => {
    const result = normalizeProjectConversationRecord({
      keyDecisions: ['  decision A  ', 'decision B', ''],
      nextActions: ['action 1'],
    });
    assert.deepEqual(result.keyDecisions, ['decision A', 'decision B']);
    assert.deepEqual(result.nextActions, ['action 1']);
  });

  it('replaces invalid arrays with empty arrays', () => {
    const result = normalizeProjectConversationRecord({
      keyDecisions: 'not an array',
      nextActions: null,
    });
    assert.deepEqual(result.keyDecisions, []);
    assert.deepEqual(result.nextActions, []);
  });

  it('preserves valid createdAt/updatedAt', () => {
    const result = normalizeProjectConversationRecord({
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-06-09T12:00:00.000Z',
    });
    assert.equal(result.createdAt, '2026-01-01T00:00:00.000Z');
    assert.equal(result.updatedAt, '2026-06-09T12:00:00.000Z');
  });

  it('uses current timestamp for invalid createdAt', () => {
    const before = new Date().toISOString();
    const result = normalizeProjectConversationRecord({ createdAt: '' });
    const after = new Date().toISOString();
    assert.ok(result.createdAt >= before);
    assert.ok(result.createdAt <= after);
  });
});
