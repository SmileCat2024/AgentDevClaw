/**
 * Direct unit tests for pure functions in server/routes/session-helpers.js.
 *
 * These functions were moved to module level and exported specifically for
 * testability. No mocking required — just import and assert.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractTokenUsage,
  extractLastMessagePreview,
  extractToolCallLabel,
  buildSessionTrimPreview,
  estimatePreambleCharCount,
  buildLightPrebuiltSessionRecord,
  compareSidebarSessionReadModels,
  SIDEBAR_SESSION_META_VERSION,
  isSidebarSessionReadModelReady,
  sortSidebarSessions,
  trimSessionRecordForWire,
  sliceSessionsForWire,
} from '../server/routes/session-helpers-pure.js';

// ── extractToolCallLabel ──────────────────────────────────────────

describe('extractToolCallLabel', () => {
  it('extracts file name for read tool with Unix path', () => {
    assert.equal(
      extractToolCallLabel('read', { filePath: '/foo/bar/baz.ts' }),
      'read baz.ts',
    );
  });

  it('extracts file name for edit tool with Windows path', () => {
    assert.equal(
      extractToolCallLabel('edit', { filePath: 'D:\\code\\file.js' }),
      'edit file.js',
    );
  });

  it('extracts file name for write tool', () => {
    assert.equal(
      extractToolCallLabel('write', { filePath: '/tmp/output.txt' }),
      'write output.txt',
    );
  });

  it('returns null for unknown tool name', () => {
    assert.equal(extractToolCallLabel('unknown', { filePath: '/test.js' }), null);
    assert.equal(extractToolCallLabel('bash', { command: 'ls' }), null);
  });

  it('returns null when args is not an object', () => {
    assert.equal(extractToolCallLabel('read', null), null);
    assert.equal(extractToolCallLabel('read', undefined), null);
    assert.equal(extractToolCallLabel('read', 'string'), null);
    assert.equal(extractToolCallLabel('read', 42), null);
  });

  it('extracts skill name for invoke_skill', () => {
    assert.equal(
      extractToolCallLabel('invoke_skill', { skill: 'claw-cli' }),
      'invoke_skill claw-cli',
    );
    assert.equal(
      extractToolCallLabel('invoke_skill', { skill: 'documents' }),
      'invoke_skill documents',
    );
  });

  it('returns null for read/edit/write when filePath is missing or empty', () => {
    assert.equal(extractToolCallLabel('read', {}), null);
    assert.equal(extractToolCallLabel('read', { filePath: '' }), null);
    assert.equal(extractToolCallLabel('edit', { filePath: null }), null);
  });

  it('returns null for invoke_skill when skill is missing or empty', () => {
    assert.equal(extractToolCallLabel('invoke_skill', {}), null);
    assert.equal(extractToolCallLabel('invoke_skill', { skill: '' }), null);
  });
});

// ── buildSessionTrimPreview ───────────────────────────────────────

describe('buildSessionTrimPreview', () => {
  it('builds rounds from user-assistant message pairs', () => {
    const messages = [
      { role: 'user', content: 'Hello', turn: 1 },
      { role: 'assistant', content: 'Hi there', turn: 1 },
      { role: 'user', content: 'How are you?', turn: 2 },
      { role: 'assistant', content: 'Good', turn: 2 },
    ];
    const rounds = buildSessionTrimPreview(messages);
    assert.equal(rounds.length, 2);
    assert.equal(rounds[0].userPreview, 'Hello');
    assert.equal(rounds[0].assistantPreview, 'Hi there');
    assert.equal(rounds[0].suggestedTrim, false); // only 2 rounds → nothing trimmed
    assert.equal(rounds[1].suggestedTrim, false);
  });

  it('marks older rounds as suggestedTrim when there are more than 2', () => {
    const messages = [
      { role: 'user', content: 'Round 1', turn: 1 },
      { role: 'assistant', content: 'Reply 1', turn: 1 },
      { role: 'user', content: 'Round 2', turn: 2 },
      { role: 'assistant', content: 'Reply 2', turn: 2 },
      { role: 'user', content: 'Round 3', turn: 3 },
      { role: 'assistant', content: 'Reply 3', turn: 3 },
    ];
    const rounds = buildSessionTrimPreview(messages);
    assert.equal(rounds.length, 3);
    assert.equal(rounds[0].suggestedTrim, true);  // oldest → trim
    assert.equal(rounds[1].suggestedTrim, false); // recent 2 → keep
    assert.equal(rounds[2].suggestedTrim, false);
  });

  it('returns empty array for empty messages', () => {
    assert.deepEqual(buildSessionTrimPreview([]), []);
  });

  it('captures tool call labels in assistant messages', () => {
    const messages = [
      { role: 'user', content: 'Read file', turn: 1 },
      {
        role: 'assistant',
        content: 'Reading',
        turn: 1,
        toolCalls: [{ name: 'read', args: { filePath: '/test.js' } }],
      },
    ];
    const rounds = buildSessionTrimPreview(messages);
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0].toolCalls.length, 1);
    assert.equal(rounds[0].toolCalls[0].name, 'read');
    assert.equal(rounds[0].toolCalls[0].summary, 'read test.js');
  });

  it('handles toolCalls with string args (JSON)', () => {
    const messages = [
      { role: 'user', content: 'Do something', turn: 1 },
      {
        role: 'assistant',
        content: 'Working',
        turn: 1,
        toolCalls: [
          { name: 'read', arguments: '{"filePath":"/src/app.js"}' },
        ],
      },
    ];
    const rounds = buildSessionTrimPreview(messages);
    assert.equal(rounds[0].toolCalls[0].summary, 'read app.js');
  });

  it('falls back to tool name when label extraction returns null', () => {
    const messages = [
      { role: 'user', content: 'Run command', turn: 1 },
      {
        role: 'assistant',
        content: 'Done',
        turn: 1,
        toolCalls: [{ name: 'bash', args: { command: 'ls -la' } }],
      },
    ];
    const rounds = buildSessionTrimPreview(messages);
    assert.equal(rounds[0].toolCalls[0].summary, 'bash');
  });

  it('handles messages without turn property (falls back to index)', () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ];
    const rounds = buildSessionTrimPreview(messages);
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0].turnStart, 0); // user msg index 0
    assert.equal(rounds[0].turnEnd, 0);   // assistant has no turn → keeps user's value
    assert.equal(rounds[0].msgIndexStart, 0);
    assert.equal(rounds[0].msgIndexEnd, 1);
  });

  it('ignores leading non-user messages before first user message', () => {
    const messages = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Hello', turn: 1 },
      { role: 'assistant', content: 'Hi', turn: 1 },
    ];
    const rounds = buildSessionTrimPreview(messages);
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0].messageCount, 2);
  });

  it('computes charCount, charPercent and cumulativePercent per round', () => {
    const messages = [
      { role: 'user', content: 'AAAA', turn: 1 },
      { role: 'assistant', content: 'BB', turn: 1 },
      { role: 'user', content: 'CCCCCC', turn: 2 },
      { role: 'assistant', content: 'DD', turn: 2 },
    ];
    const rounds = buildSessionTrimPreview(messages);
    assert.equal(rounds.length, 2);
    // round 0: 4+2=6 chars, round 1: 6+2=8 chars, total=14
    assert.equal(rounds[0].charCount, 6);
    assert.equal(rounds[1].charCount, 8);
    assert.equal(rounds[0].cumulativeCharCount, 6);
    assert.equal(rounds[1].cumulativeCharCount, 14);
    assert.ok(Math.abs(rounds[0].charPercent - 6/14) < 1e-9);
    assert.ok(Math.abs(rounds[1].cumulativePercent - 1) < 1e-9);
  });

  it('includes preamble chars in percentage denominator', () => {
    const messages = [
      { role: 'system', content: 'SYSPROMPT' }, // 9 chars preamble
      { role: 'user', content: 'AB', turn: 1 },
      { role: 'assistant', content: 'CD', turn: 1 },
    ];
    const rounds = buildSessionTrimPreview(messages);
    assert.equal(rounds.length, 1);
    // total = 9 (preamble) + 4 (round) = 13
    // round percent = 4/13
    assert.ok(Math.abs(rounds[0].charPercent - 4/13) < 1e-9);
    // cumulative of the only round = 4/13 (not 100%)
    assert.ok(rounds[0].cumulativePercent < 1);
  });
});

// ── estimatePreambleCharCount ─────────────────────────────────────

describe('estimatePreambleCharCount', () => {
  it('counts chars before first user message', () => {
    const messages = [
      { role: 'system', content: 'abc' },
      { role: 'system', content: 'de' },
      { role: 'user', content: 'Hello' },
    ];
    assert.equal(estimatePreambleCharCount(messages), 5);
  });

  it('returns 0 when first message is user', () => {
    const messages = [{ role: 'user', content: 'Hello' }];
    assert.equal(estimatePreambleCharCount(messages), 0);
  });

  it('counts all messages when no user message exists', () => {
    const messages = [
      { role: 'system', content: 'abc' },
      { role: 'system', content: 'def' },
    ];
    assert.equal(estimatePreambleCharCount(messages), 6);
  });

  it('counts tool calls in preamble messages', () => {
    const messages = [
      { role: 'system', content: 'ab', toolCalls: [{ name: 'read', args: { filePath: '/x.js' } }] },
      { role: 'user', content: 'Hi' },
    ];
    // 2 (content) + 4 (read) + len(JSON.stringify({filePath:"/x.js"}))
    const expected = 2 + 4 + JSON.stringify({ filePath: '/x.js' }).length;
    assert.equal(estimatePreambleCharCount(messages), expected);
  });
});

// ── extractTokenUsage ─────────────────────────────────────────────

describe('extractTokenUsage', () => {
  it('extracts token usage from parsed session with runtime.usageStats', () => {
    const parsed = {
      runtime: {
        usageStats: {
          totalUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          lastRequestUsage: { inputTokens: 10, outputTokens: 5 },
        },
      },
    };
    const result = extractTokenUsage(parsed);
    assert.equal(result.inputTokens, 100);
    assert.equal(result.outputTokens, 50);
    assert.equal(result.totalTokens, 150);
    assert.deepEqual(result.lastRequestUsage, { inputTokens: 10, outputTokens: 5 });
  });

  it('returns zeros when runtime or usageStats is missing', () => {
    assert.deepEqual(extractTokenUsage({}), {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      lastRequestUsage: null,
    });
    assert.deepEqual(extractTokenUsage(null), {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      lastRequestUsage: null,
    });
    assert.deepEqual(extractTokenUsage({ runtime: {} }), {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      lastRequestUsage: null,
    });
  });

  it('handles partial usageStats (missing lastRequestUsage)', () => {
    const parsed = {
      runtime: {
        usageStats: {
          totalUsage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
        },
      },
    };
    const result = extractTokenUsage(parsed);
    assert.equal(result.totalTokens, 300);
    assert.equal(result.lastRequestUsage, null);
  });
});

// ── extractLastMessagePreview ─────────────────────────────────────

describe('extractLastMessagePreview', () => {
  it('extracts preview from the last non-system message', () => {
    const messages = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Hello world' },
      { role: 'assistant', content: 'Hi there, how can I help?' },
    ];
    assert.equal(extractLastMessagePreview(messages), 'Hi there, how can I help?');
  });

  it('collapses whitespace and truncates to 140 characters', () => {
    const longContent = 'A'.repeat(200);
    // Whitespace collapsed but not trimmed (function uses replace, not trim)
    const userOnly = extractLastMessagePreview([
      { role: 'user', content: '   lots\n\n  of   spaces   ' },
    ]);
    assert.equal(userOnly, ' lots of spaces ');

    // Truncation
    const longResult = extractLastMessagePreview([{ role: 'assistant', content: longContent }]);
    assert.equal(longResult.length, 140);
  });

  it('returns empty string for empty or invalid input', () => {
    assert.equal(extractLastMessagePreview([]), '');
    assert.equal(extractLastMessagePreview(null), '');
    assert.equal(extractLastMessagePreview(undefined), '');
    assert.equal(extractLastMessagePreview('not an array'), '');
  });

  it('skips messages with non-string content', () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: null },
      { role: 'assistant', content: { nested: 'object' } },
    ];
    assert.equal(extractLastMessagePreview(messages), 'Hello');
  });
});

// ── buildLightPrebuiltSessionRecord ───────────────────────────────

describe('buildLightPrebuiltSessionRecord', () => {
  it('builds a complete record from a well-formed index entry', () => {
    const record = {
      id: 'session-abc',
      title: 'Test Session',
      featureName: 'MyFeature',
      agentName: 'TestAgent',
      taskTitle: 'Fix bug',
      sessionType: 'main',
      status: '',
      formId: 'startup-form',
      openDirectory: '/project/dir',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-02T00:00:00.000Z',
      fileSize: 4096,
      messageCount: 10,
      preview: 'Hello world',
      modelName: 'gpt-4',
      contextLength: 200000,
      compressRatio: 75,
    };
    const result = buildLightPrebuiltSessionRecord('programming-helper', record);
    assert.equal(result.id, 'session-abc');
    assert.equal(result.title, 'Test Session');
    assert.equal(result.featureName, 'MyFeature');
    assert.equal(result.agentName, 'TestAgent');
    assert.equal(result.taskTitle, 'Fix bug');
    assert.equal(result.sessionType, 'main');
    assert.equal(result.formId, 'startup-form');
    assert.equal(result.openDirectory, '/project/dir');
    assert.equal(result.createdAt, '2025-01-01T00:00:00.000Z');
    assert.equal(result.updatedAt, '2025-01-02T00:00:00.000Z');
    assert.equal(result.exists, true);
    assert.equal(result.bytes, 4096);
    assert.equal(result.messageCount, 10);
    assert.equal(result.preview, 'Hello world');
    assert.equal(result.hasSummary, false);
    assert.equal(result.modelName, 'gpt-4');
    assert.equal(result.contextLength, 200000);
    assert.equal(result.compressRatio, 75);
    assert.ok(typeof result.path === 'string' && result.path.length > 0);
  });

  it('handles null/undefined record gracefully', () => {
    const result = buildLightPrebuiltSessionRecord('programming-helper', null);
    assert.equal(result.id, '');
    assert.equal(result.title, '');
    assert.equal(result.sessionType, 'main');
    assert.equal(result.formId, '');
    assert.equal(result.exists, true);
    assert.equal(result.messageCount, 0);
    assert.equal(result.bytes, 0);
    assert.equal(result.hasSummary, false);
    assert.equal(result.tokenUsage.inputTokens, 0);
  });

  it('fills createdAt/updatedAt with current time when missing', () => {
    const before = new Date().toISOString();
    const result = buildLightPrebuiltSessionRecord('programming-helper', {
      id: 's1',
    });
    const after = new Date().toISOString();
    assert.ok(result.createdAt >= before && result.createdAt <= after,
      'createdAt should be ~now');
    assert.ok(result.updatedAt >= before && result.updatedAt <= after,
      'updatedAt should be ~now');
  });
});

describe('compareSidebarSessionReadModels', () => {
  it('reports only aggregate compatibility counts', () => {
    const comparison = compareSidebarSessionReadModels(
      [
        { id: 'same', title: 'Same', messageCount: 1 },
        { id: 'changed', title: 'Light title', messageCount: 2 },
        { id: 'extra', title: 'Extra' },
      ],
      [
        { id: 'same', title: 'Same', messageCount: 1 },
        { id: 'changed', title: 'Rich title', messageCount: 2 },
        { id: 'missing', title: 'Missing' },
      ],
    );
    assert.equal(comparison.lightCount, 3);
    assert.equal(comparison.authoritativeCount, 3);
    assert.equal(comparison.missingCount, 1);
    assert.equal(comparison.extraCount, 1);
    assert.equal(comparison.exactSessionCount, 1);
    assert.equal(comparison.mismatchedSessionCount, 1);
    assert.equal(comparison.fieldMismatchCount, 1);
    assert.equal(JSON.stringify(comparison).includes('Light title'), false);
  });
});

describe('sidebar production read model', () => {
  const completeRecord = {
    id: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    archived: false,
    todo: false,
    hasSummary: true,
    messageCount: 3,
    preview: '',
    tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    modelName: '',
    contextLength: null,
    compressRatio: 80,
    sidebarMetaVersion: SIDEBAR_SESSION_META_VERSION,
  };

  it('requires every field that would otherwise regress sidebar presentation', () => {
    assert.equal(isSidebarSessionReadModelReady(completeRecord), true);
    for (const field of ['archived', 'todo', 'hasSummary', 'messageCount', 'preview', 'tokenUsage', 'modelName', 'compressRatio']) {
      const incomplete = { ...completeRecord };
      delete incomplete[field];
      assert.equal(isSidebarSessionReadModelReady(incomplete), false, `${field} must be required`);
    }
  });

  it('preserves valid empty model values and rejects an old schema version', () => {
    assert.equal(isSidebarSessionReadModelReady(completeRecord), true);
    assert.equal(isSidebarSessionReadModelReady({ ...completeRecord, sidebarMetaVersion: 0 }), false);
  });

  it('sorts by updatedAt, createdAt, then id without mutating input', () => {
    const input = [
      { id: 'a', updatedAt: '2026-01-01', createdAt: '2026-01-01' },
      { id: 'c', updatedAt: '2026-01-02', createdAt: '2026-01-01' },
      { id: 'b', updatedAt: '2026-01-02', createdAt: '2026-01-01' },
    ];
    assert.deepEqual(sortSidebarSessions(input).map((item) => item.id), ['c', 'b', 'a']);
    assert.deepEqual(input.map((item) => item.id), ['a', 'c', 'b']);
  });

  it('projects archive, todo and summary flags from the index', () => {
    const result = buildLightPrebuiltSessionRecord('programming-helper', {
      ...completeRecord,
      archived: true,
      todo: true,
      hasSummary: true,
    });
    assert.equal(result.archived, true);
    assert.equal(result.todo, true);
    assert.equal(result.hasSummary, true);
  });
});

describe('wire session projection', () => {
  const record = (id, overrides = {}) => ({
    id,
    title: `Session ${id}`,
    openDirectory: 'D:\\code\\Alpha',
    archived: false,
    metadata: { resumeMode: 'compacted', source: 'legacy', foo: 'bar' },
    path: `C:/data/sessions/${id}.json`,
    tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  });

  it('trims path and reduces metadata to resumeMode only', () => {
    const trimmed = trimSessionRecordForWire(record('s1'));
    assert.equal('path' in trimmed, false);
    assert.deepEqual(trimmed.metadata, { resumeMode: 'compacted' });
    assert.deepEqual(trimmed.tokenUsage, { inputTokens: 1, outputTokens: 2, totalTokens: 3 });
    // 输入不可变：原记录保持原样
    const original = record('s1');
    trimSessionRecordForWire(original);
    assert.equal(original.path, 'C:/data/sessions/s1.json');
    assert.equal(original.metadata.source, 'legacy');
  });

  it('drops metadata entirely when resumeMode is absent', () => {
    const trimmed = trimSessionRecordForWire(record('s2', { metadata: { source: 'x' } }));
    assert.deepEqual(trimmed.metadata, {});
  });

  it('filters by project directory with separator and case normalization', () => {
    const sessions = [
      record('a', { openDirectory: 'D:\\code\\Alpha' }),
      record('b', { openDirectory: 'd:/CODE/alpha/' }),
      record('c', { openDirectory: 'D:\\code\\Beta' }),
    ];
    const page = sliceSessionsForWire(sessions, { projectDir: 'D:/code/alpha' });
    assert.deepEqual(page.slice.map((s) => s.id), ['a', 'b']);
    assert.equal(page.total, 2);
  });

  it('applies archived filter while keeping true main/archived totals', () => {
    const sessions = [
      record('a'),
      record('b', { archived: true }),
      record('c', { archived: true }),
    ];
    const mainPage = sliceSessionsForWire(sessions, { archived: 'main' });
    assert.deepEqual(mainPage.slice.map((s) => s.id), ['a']);
    assert.deepEqual([mainPage.mainTotal, mainPage.archivedTotal], [1, 2]);
    const archivedPage = sliceSessionsForWire(sessions, { archived: 'archived' });
    assert.deepEqual(archivedPage.slice.map((s) => s.id), ['b', 'c']);
    // 总数不受 archived 过滤影响
    assert.deepEqual([archivedPage.mainTotal, archivedPage.archivedTotal], [1, 2]);
  });

  it('matches query against title and directory, case-insensitive', () => {
    const sessions = [
      record('a', { title: 'Fix login bug' }),
      record('b', { title: 'Other', openDirectory: 'D:\\code\\LoginFeature' }),
      record('c', { title: 'Unrelated' }),
    ];
    const page = sliceSessionsForWire(sessions, { query: 'login' });
    assert.deepEqual(page.slice.map((s) => s.id), ['a', 'b']);
  });

  it('slices by offset and limit and reports totals', () => {
    const sessions = ['a', 'b', 'c', 'd', 'e'].map((id) => record(id));
    const page = sliceSessionsForWire(sessions, { offset: 2, limit: 2 });
    assert.deepEqual(page.slice.map((s) => s.id), ['c', 'd']);
    assert.equal(page.total, 5);
    assert.equal(page.offset, 2);
    // 无 limit 时从 offset 返回到末尾
    const tail = sliceSessionsForWire(sessions, { offset: 3 });
    assert.deepEqual(tail.slice.map((s) => s.id), ['d', 'e']);
    // 无分页参数 → 全量
    const all = sliceSessionsForWire(sessions, {});
    assert.equal(all.total, 5);
    assert.equal(all.slice.length, 5);
  });

  it('excludes session types and scopes badge totals to the project', () => {
    const sessions = [
      record('a', { openDirectory: 'D:\\code\\Alpha' }),
      record('b', { openDirectory: 'D:\\code\\Alpha', sessionType: 'coder' }),
      record('c', { openDirectory: 'D:\\code\\Alpha', archived: true }),
      record('d', { openDirectory: 'D:\\code\\Beta' }),
    ];
    const page = sliceSessionsForWire(sessions, {
      projectDir: 'D:/code/alpha',
      excludeSessionTypes: ['coder'],
    });
    // coder 不进切片；其他项目不计入徽标
    assert.deepEqual(page.slice.map((s) => s.id), ['a', 'c']);
    assert.equal(page.total, 2);
    assert.deepEqual([page.mainTotal, page.archivedTotal], [1, 1]);
  });
});
