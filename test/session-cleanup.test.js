/**
 * Tests for empty session cleanup decision logic.
 *
 * Covers the core selection logic extracted from cleanupEmptySessions():
 * 1. selectEmptySessions — identifies sessions eligible for cleanup
 * 2. resolvePostCleanupState — computes updated index after removal
 *
 * Cleanup runs once at server startup only, never during normal operation.
 * This prevents new-but-not-yet-used sessions from being deleted mid-run.
 *
 * These tests import the real code from session-helpers.js.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { selectEmptySessions, resolvePostCleanupState } from '../server/routes/session-helpers.js';

// ── Tests ──

describe('selectEmptySessions', () => {
  it('selects empty session still in placeholder title state', () => {
    const sessions = [
      { id: 's1', title: '新对话1', titleState: 'placeholder' },
    ];
    const counts = new Map([
      ['s1', { messageCount: 0, fileExists: true }],
    ]);
    assert.deepEqual(selectEmptySessions(sessions, counts), ['s1']);
  });

  it('skips session with messages even if still placeholder', () => {
    const sessions = [
      { id: 's1', title: '新对话1', titleState: 'placeholder' },
    ];
    const counts = new Map([
      ['s1', { messageCount: 5, fileExists: true }],
    ]);
    assert.deepEqual(selectEmptySessions(sessions, counts), []);
  });

  it('skips session whose title was set by the user', () => {
    const sessions = [
      { id: 's1', title: '数据库优化', titleState: 'user' },
    ];
    const counts = new Map([
      ['s1', { messageCount: 0, fileExists: true }],
    ]);
    assert.deepEqual(selectEmptySessions(sessions, counts), []);
  });

  it('skips session with a generated title', () => {
    const sessions = [
      { id: 's1', title: '重构标题生成', titleState: 'auto' },
    ];
    const counts = new Map([
      ['s1', { messageCount: 0, fileExists: true }],
    ]);
    assert.deepEqual(selectEmptySessions(sessions, counts), []);
  });

  it('selects placeholder session when file is missing', () => {
    const sessions = [
      { id: 's1', title: '新对话1', titleState: 'placeholder' },
    ];
    // No entry in counts → file missing
    assert.deepEqual(selectEmptySessions(sessions, new Map()), ['s1']);
  });

  it('selects only matching sessions from mixed set', () => {
    const sessions = [
      { id: 's1', title: '新对话1', titleState: 'placeholder' }, // empty → delete
      { id: 's2', title: '新对话2', titleState: 'placeholder' }, // has messages → keep
      { id: 's3', title: 'API重构', titleState: 'user' },         // user named → keep
      { id: 's4', title: '新对话3', titleState: 'placeholder' }, // empty → delete
    ];
    const counts = new Map([
      ['s1', { messageCount: 0, fileExists: true }],
      ['s2', { messageCount: 3, fileExists: true }],
      ['s3', { messageCount: 0, fileExists: true }],
      ['s4', { messageCount: 0, fileExists: true }],
    ]);
    assert.deepEqual(selectEmptySessions(sessions, counts), ['s1', 's4']);
  });

  it('does not treat placeholder-looking text as state when the field is missing', () => {
    // 升级前的历史记录没有 titleState：来源未知，不猜它是占位标题——
    // 否则这里会把用户手写的「新对话」误删。
    const sessions = [
      { id: 's1', title: '新对话1' },
      { id: 's2', title: '新对话' },
      { id: 's3', title: '' },
    ];
    const counts = new Map([
      ['s1', { messageCount: 0, fileExists: true }],
      ['s2', { messageCount: 0, fileExists: true }],
      ['s3', { messageCount: 0, fileExists: true }],
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
