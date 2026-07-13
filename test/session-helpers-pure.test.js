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
  extractDomainsFromText,
  buildLightPrebuiltSessionRecord,
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

// ── extractDomainsFromText ────────────────────────────────────────

describe('extractDomainsFromText', () => {
  it('extracts known technology domain keywords from text', () => {
    const text = 'This session explored the Runtime and Hook system of the Agent framework. It also touched on ToolRegistry and Session management.';
    const result = extractDomainsFromText(text);
    assert.ok(result.includes('Runtime'));
    assert.ok(result.includes('Hook'));
    assert.ok(result.includes('Agent'));
    assert.ok(result.includes('ToolRegistry'));
    assert.ok(result.includes('Session'));
  });

  it('returns empty array for null or non-string input', () => {
    assert.deepEqual(extractDomainsFromText(null), []);
    assert.deepEqual(extractDomainsFromText(undefined), []);
    assert.deepEqual(extractDomainsFromText(123), []);
    assert.deepEqual(extractDomainsFromText(''), []);
  });

  it('returns empty array when no domain keywords are found', () => {
    assert.deepEqual(extractDomainsFromText('Just some random text without keywords'), []);
  });

  it('limits results to 8 unique keywords', () => {
    const text = 'Flow Feature Hook ToolRegistry Node Edge Workflow Assembly Session Workspace Runtime Context Prompt';
    const result = extractDomainsFromText(text);
    assert.ok(result.length <= 8, `Expected at most 8, got ${result.length}`);
  });

  it('deduplicates identical keywords (exact match)', () => {
    const text = 'The Session class manages state. Each Session is independent.';
    const result = extractDomainsFromText(text);
    // "Session" (capital S) matches multiple times but Set deduplicates exact strings
    const sessionCount = result.filter(w => w === 'Session').length;
    assert.equal(sessionCount, 1, 'Session (exact case) should appear only once');
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
    assert.equal(result.contextLength, null);
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

  it('defaults sessionType to sub when metadata.resumeMode is one-shot', () => {
    const result = buildLightPrebuiltSessionRecord('programming-helper', {
      id: 's1',
      metadata: { resumeMode: 'one-shot' },
    });
    assert.equal(result.sessionType, 'sub');
  });

  it('defaults status to locked for exploration sessions', () => {
    const result = buildLightPrebuiltSessionRecord('programming-helper', {
      id: 's1',
      sessionType: 'exploration',
    });
    assert.equal(result.status, 'locked');
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
