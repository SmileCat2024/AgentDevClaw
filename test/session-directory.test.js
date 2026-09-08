/**
 * buildSessionDirectoryEntries（/protoclaw/session_directory 聚合逻辑）单测。
 * 纯函数：过滤 archived、跨 agent 扁平化、updatedAt 倒序、limit 截断。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildSessionDirectoryEntries } from '../server/routes/session-helpers-pure.js';

function agentEntry(agentId, sessions, agentName) {
  return { agentId, agentName, sessions };
}

describe('buildSessionDirectoryEntries', () => {
  it('flattens sessions across agents with cleaned fields', () => {
    const entries = buildSessionDirectoryEntries([
      {
        agentId: 'programming-helper',
        agentName: '编程小助手',
        sessions: [
          { id: 's1', title: '修 bug', preview: '先看目录', openDirectory: '/repo', sessionType: 'main', updatedAt: '2026-09-01T10:00:00Z', messageCount: 42 },
        ],
      },
      {
        agentId: 'qqbot',
        sessions: [
          { id: 's2', title: 'IM 线路', updatedAt: '2026-09-02T10:00:00Z', createdAt: '2026-09-02T09:00:00Z' },
        ],
      },
    ]);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].agentId, 'qqbot');
    assert.equal(entries[0].agentName, '');
    assert.equal(entries[0].createdAt, '2026-09-02T09:00:00Z');
    assert.equal(entries[0].updatedAt, '2026-09-02T10:00:00Z');
    assert.equal(entries[1].agentName, '编程小助手');
    assert.equal(entries[1].messageCount, 42);
    assert.equal(entries[1].sessionType, 'main');
  });

  it('excludes archived sessions by default and includes them on request', () => {
    const input = [
      {
        agentId: 'a',
        sessions: [
          { id: 'live', archived: false, updatedAt: '2026-01-02' },
          { id: 'archived', archived: true, updatedAt: '2026-01-03' },
        ],
      },
    ];
    assert.deepEqual(
      buildSessionDirectoryEntries(input).map((entry) => entry.sessionId),
      ['live'],
    );
    assert.deepEqual(
      buildSessionDirectoryEntries(input, { includeArchived: true }).map((entry) => entry.sessionId),
      ['archived', 'live'],
    );
  });

  it('sorts by updatedAt descending across agents', () => {
    const entries = buildSessionDirectoryEntries([
      { agentId: 'old', sessions: [{ id: 's-old', updatedAt: '2026-01-01T00:00:00Z' }] },
      { agentId: 'new', sessions: [{ id: 's-new', updatedAt: '2026-06-01T00:00:00Z' }] },
    ]);
    assert.deepEqual(entries.map((entry) => entry.sessionId), ['s-new', 's-old']);
  });

  it('applies limit after sorting', () => {
    const entries = buildSessionDirectoryEntries([
      {
        agentId: 'a',
        sessions: [
          { id: 's1', updatedAt: '2026-03-01T00:00:00Z' },
          { id: 's2', updatedAt: '2026-02-01T00:00:00Z' },
          { id: 's3', updatedAt: '2026-01-01T00:00:00Z' },
        ],
      },
    ], { limit: 2 });
    assert.deepEqual(entries.map((entry) => entry.sessionId), ['s1', 's2']);
  });

  it('skips agents without id and entries without session id', () => {
    const entries = buildSessionDirectoryEntries([
      { agentId: '', sessions: [{ id: 'x', updatedAt: '2026-01-01' }] },
      { agentId: 'ok', sessions: [null, { id: '' }, { id: 'keep', updatedAt: '2026-01-01T00:00:00Z' }] },
    ]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].sessionId, 'keep');
  });
});
