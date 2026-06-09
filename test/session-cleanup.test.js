/**
 * Tests for empty session cleanup decision logic.
 *
 * Covers the core selection logic extracted from cleanupEmptySessions() in server.js:
 * 1. selectEmptySessions — identifies sessions eligible for cleanup
 * 2. resolvePostCleanupState — computes updated index after removal
 *
 * These mirror the actual code paths in server.js.
 * When the server code changes, these tests should be updated accordingly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Inline helpers (mirrors server.js cleanupEmptySessions logic) ──

function cleanSessionText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Determine which sessions are eligible for cleanup.
 * Mirrors the loop in cleanupEmptySessions().
 *
 * @param {Array} sessions - session index records
 * @param {Map} sessionMessageCounts - Map<sessionId, {messageCount, fileExists}>
 * @returns {string[]} session IDs to delete
 */
function selectEmptySessions(sessions, sessionMessageCounts) {
  const toDelete = [];
  for (const record of sessions) {
    // Only target default "新对话N" titled sessions
    if (!/^新对话\d+$/.test(cleanSessionText(record.title))) continue;
    const info = sessionMessageCounts.get(record.id);
    if (!info) {
      // Session file missing or unreadable — clean up
      toDelete.push(record.id);
      continue;
    }
    // Empty session: no messages at all (never had user input)
    if (info.messageCount === 0) {
      toDelete.push(record.id);
    }
  }
  return toDelete;
}

/**
 * Compute the updated index state after removing sessions.
 * Mirrors the post-loop logic in cleanupEmptySessions().
 *
 * @param {object} index - { activeSessionId, sessions }
 * @param {string[]} toDelete - session IDs to remove
 * @returns {object} updated { activeSessionId, sessions }
 */
function resolvePostCleanupState(index, toDelete) {
  if (toDelete.length === 0) return index;

  const deleteSet = new Set(toDelete);
  let nextActiveId = index.activeSessionId;
  const remaining = index.sessions.filter((s) => !deleteSet.has(s.id));
  if (deleteSet.has(nextActiveId)) {
    nextActiveId = remaining[0]?.id ?? null;
  }
  return { activeSessionId: nextActiveId, sessions: remaining };
}

// ── Tests ──

describe('selectEmptySessions', () => {
  it('selects empty session with default title', () => {
    const sessions = [
      { id: 's1', title: '新对话1' },
    ];
    const counts = new Map([
      ['s1', { messageCount: 0, fileExists: true }],
    ]);
    assert.deepEqual(selectEmptySessions(sessions, counts), ['s1']);
  });

  it('skips session with messages even if default title', () => {
    const sessions = [
      { id: 's1', title: '新对话1' },
    ];
    const counts = new Map([
      ['s1', { messageCount: 5, fileExists: true }],
    ]);
    assert.deepEqual(selectEmptySessions(sessions, counts), []);
  });

  it('skips session with custom title even if empty', () => {
    const sessions = [
      { id: 's1', title: '数据库优化' },
    ];
    const counts = new Map([
      ['s1', { messageCount: 0, fileExists: true }],
    ]);
    assert.deepEqual(selectEmptySessions(sessions, counts), []);
  });

  it('selects session when file is missing', () => {
    const sessions = [
      { id: 's1', title: '新对话1' },
    ];
    // No entry in counts → file missing
    assert.deepEqual(selectEmptySessions(sessions, new Map()), ['s1']);
  });

  it('selects only matching sessions from mixed set', () => {
    const sessions = [
      { id: 's1', title: '新对话1' },       // default title, empty → delete
      { id: 's2', title: '新对话2' },       // default title, has messages → keep
      { id: 's3', title: 'API重构' },        // custom title, empty → keep
      { id: 's4', title: '新对话3' },       // default title, empty → delete
    ];
    const counts = new Map([
      ['s1', { messageCount: 0, fileExists: true }],
      ['s2', { messageCount: 3, fileExists: true }],
      ['s3', { messageCount: 0, fileExists: true }],
      ['s4', { messageCount: 0, fileExists: true }],
    ]);
    assert.deepEqual(selectEmptySessions(sessions, counts), ['s1', 's4']);
  });

  it('does not match non-default title patterns', () => {
    const sessions = [
      { id: 's1', title: '新对话' },         // no number suffix → skip
      { id: 's2', title: '新对话abc' },      // not a number → skip
      { id: 's3', title: '对话1' },           // wrong prefix → skip
      { id: 's4', title: '' },                // empty title → skip
    ];
    const counts = new Map([
      ['s1', { messageCount: 0, fileExists: true }],
      ['s2', { messageCount: 0, fileExists: true }],
      ['s3', { messageCount: 0, fileExists: true }],
      ['s4', { messageCount: 0, fileExists: true }],
    ]);
    assert.deepEqual(selectEmptySessions(sessions, counts), []);
  });
});

describe('resolvePostCleanupState', () => {
  it('returns unchanged index when nothing to delete', () => {
    const index = {
      activeSessionId: 's1',
      sessions: [{ id: 's1', title: '数据库优化' }],
    };
    const result = resolvePostCleanupState(index, []);
    assert.equal(result.activeSessionId, 's1');
    assert.equal(result.sessions.length, 1);
  });

  it('removes targeted sessions', () => {
    const index = {
      activeSessionId: 's2',
      sessions: [
        { id: 's1', title: '新对话1' },
        { id: 's2', title: '数据库优化' },
        { id: 's3', title: '新对话2' },
      ],
    };
    const result = resolvePostCleanupState(index, ['s1', 's3']);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].id, 's2');
  });

  it('shifts activeSessionId when active is deleted', () => {
    const index = {
      activeSessionId: 's1',
      sessions: [
        { id: 's1', title: '新对话1' },
        { id: 's2', title: '数据库优化' },
      ],
    };
    const result = resolvePostCleanupState(index, ['s1']);
    assert.equal(result.activeSessionId, 's2');
  });

  it('sets activeSessionId to null when all sessions deleted', () => {
    const index = {
      activeSessionId: 's1',
      sessions: [
        { id: 's1', title: '新对话1' },
      ],
    };
    const result = resolvePostCleanupState(index, ['s1']);
    assert.equal(result.activeSessionId, null);
    assert.equal(result.sessions.length, 0);
  });

  it('keeps activeSessionId when deleting non-active sessions', () => {
    const index = {
      activeSessionId: 's2',
      sessions: [
        { id: 's1', title: '新对话1' },
        { id: 's2', title: '数据库优化' },
      ],
    };
    const result = resolvePostCleanupState(index, ['s1']);
    assert.equal(result.activeSessionId, 's2');
  });

  it('handles deletion of first remaining becoming active', () => {
    const index = {
      activeSessionId: 's1',
      sessions: [
        { id: 's1', title: '新对话1' },
        { id: 's2', title: '新对话2' },
        { id: 's3', title: 'API重构' },
      ],
    };
    // Delete both s1 (active) and s2
    const result = resolvePostCleanupState(index, ['s1', 's2']);
    assert.equal(result.activeSessionId, 's3');
    assert.equal(result.sessions.length, 1);
  });
});
