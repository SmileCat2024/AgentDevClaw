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

  it('restricts to a single workspace when agentId is given, and blank keeps the full directory', () => {
    const input = [
      { agentId: 'programming-helper', sessions: [
        { id: 'ph-1', updatedAt: '2026-05-01T00:00:00Z' },
        { id: 'ph-2', updatedAt: '2026-04-01T00:00:00Z' },
      ] },
      { agentId: 'coder', sessions: [{ id: 'co-1', updatedAt: '2026-06-01T00:00:00Z' }] },
    ];
    // 指定 agentId：只留该工作空间的条目，其余 agent 的组整体跳过（total 同步收敛）
    const phOnly = buildSessionDirectoryEntries(input, { agentId: 'programming-helper' });
    assert.deepEqual(phOnly.map((entry) => entry.sessionId), ['ph-1', 'ph-2']);
    assert.equal(phOnly.total, 2);
    // 不传 / 空白串：跨 agent 全目录（现行为不变）
    assert.equal(buildSessionDirectoryEntries(input).total, 3);
    assert.equal(buildSessionDirectoryEntries(input, { agentId: '   ' }).total, 3);
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

  it('filters by inclusive ISO date bounds and caps results at 50 while preserving offset pagination', () => {
    const sessions = Array.from({ length: 60 }, (_, index) => ({
      id: `s${index}`,
      updatedAt: `2026-11-${String(index < 30 ? '08' : '09')}T${String(index % 24).padStart(2, '0')}:00:00Z`,
    }));
    const input = [{ agentId: 'a', sessions }];
    const inRange = buildSessionDirectoryEntries(input, { from: '2026-11-09', to: '2026-11-09' });
    assert.equal(inRange.length, 30);
    assert.ok(inRange.every((entry) => entry.updatedAt.startsWith('2026-11-09')));
    const oversized = buildSessionDirectoryEntries(input, { limit: 100 });
    assert.equal(oversized.length, 50);
    assert.equal(oversized.total, 60);
    assert.equal(oversized.limitCapped, true);
    assert.equal(buildSessionDirectoryEntries(input, { limit: 50, offset: 50 }).length, 10);
  });

  it('applies offset before limit for paging (offset=0 keeps legacy behavior)', () => {
    const input = [{
      agentId: 'a',
      sessions: [
        { id: 's1', updatedAt: '2026-03-01T00:00:00Z' },
        { id: 's2', updatedAt: '2026-02-01T00:00:00Z' },
        { id: 's3', updatedAt: '2026-01-01T00:00:00Z' },
      ],
    }];
    assert.deepEqual(
      buildSessionDirectoryEntries(input, { limit: 2, offset: 1 }).map((entry) => entry.sessionId),
      ['s2', 's3'],
    );
    // 不带 limit 时 offset 仍然生效（翻到末页）
    assert.deepEqual(
      buildSessionDirectoryEntries(input, { offset: 2 }).map((entry) => entry.sessionId),
      ['s3'],
    );
    assert.deepEqual(
      buildSessionDirectoryEntries(input, { offset: 0, limit: 2 }).map((entry) => entry.sessionId),
      ['s1', 's2'],
    );
  });

  it('skips agents without id and entries without session id', () => {
    const entries = buildSessionDirectoryEntries([
      { agentId: '', sessions: [{ id: 'x', updatedAt: '2026-01-01' }] },
      { agentId: 'ok', sessions: [null, { id: '' }, { id: 'keep', updatedAt: '2026-01-01T00:00:00Z' }] },
    ]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].sessionId, 'keep');
  });

  it('annotates thread ownership (threadId + thread title) from the thread index', () => {
    const entries = buildSessionDirectoryEntries([
      {
        agentId: 'coder',
        sessions: [
          { id: 's-head', title: 'head 代', updatedAt: '2026-10-12T01:00:00Z' },
          { id: 's-old', title: '老代', updatedAt: '2026-10-11T01:00:00Z' },
        ],
      },
      { agentId: 'ph', sessions: [{ id: 's-plain', title: '普通会话', updatedAt: '2026-10-10T01:00:00Z' }] },
    ], {
      threadIndexEntries: [
        { threadId: 'wt-abc', title: '审查最近更改', sessionIds: ['s-old', 's-head'] },
      ],
    });
    const byId = new Map(entries.map((entry) => [entry.sessionId, entry]));
    // 同一线程的多代条目共享同一归属；线程标题用线程自己的标题（任务级语义）
    assert.equal(byId.get('s-head').threadId, 'wt-abc');
    assert.equal(byId.get('s-head').threadTitle, '审查最近更改');
    assert.equal(byId.get('s-old').threadId, 'wt-abc');
    assert.equal(byId.get('s-old').threadTitle, '审查最近更改');
    // 非线程宿主条目不带归属（空串而非 undefined，消费方无需判空双形态）
    assert.equal(byId.get('s-plain').threadId, '');
    assert.equal(byId.get('s-plain').threadTitle, '');
  });

  it('keeps entries unannotated when no thread index is provided', () => {
    const entries = buildSessionDirectoryEntries([
      { agentId: 'coder', sessions: [{ id: 's-1', updatedAt: '2026-10-12T01:00:00Z' }] },
    ]);
    assert.equal(entries[0].threadId, '');
    assert.equal(entries[0].threadTitle, '');
  });

  it('resolves the first thread when a session id anomalously appears in multiple threads', () => {
    const entries = buildSessionDirectoryEntries([
      { agentId: 'coder', sessions: [{ id: 's-1', updatedAt: '2026-10-12T01:00:00Z' }] },
    ], {
      threadIndexEntries: [
        { threadId: 'wt-first', title: '一', sessionIds: ['s-1'] },
        { threadId: 'wt-second', title: '二', sessionIds: ['s-1'] },
      ],
    });
    assert.equal(entries[0].threadId, 'wt-first');
  });
});
