/**
 * Tests for title-mirror pure functions.
 *
 * Covers the core decision logic extracted from scripts/run-title-mirror.js:
 * 1. sanitizeGeneratedTitle — cleans raw model output into a usable title
 * 2. prepareTitleMessages — selects conversational context and appends the title prompt
 * 3. tuneMirrorLLM — caps output and clears configured reasoning options
 *
 * These mirror the actual code paths in run-title-mirror.js.
 * When that script changes, these tests should be updated accordingly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tuneMirrorLLM } from '../scripts/mirror-runtime.js';

// ── Inline helpers (mirrors scripts/run-title-mirror.js) ──

function cleanValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeGeneratedTitle(title) {
  const line = cleanValue(title)
    .replace(/^["""''«»]+|["""''«»]+$/g, '')
    .replace(/[。！？!?,，、:：;；]+$/g, '')
    .replace(/\s+/g, ' ')
    .split('\n')[0]
    .trim();
  if (!line) return '';
  return line.slice(0, 60);
}

// ── Tests ──

describe('sanitizeGeneratedTitle', () => {
  it('returns clean title from normal text', () => {
    assert.equal(sanitizeGeneratedTitle('用户登录功能实现'), '用户登录功能实现');
  });

  it('strips surrounding quotes', () => {
    assert.equal(sanitizeGeneratedTitle('"修复登录Bug"'), '修复登录Bug');
    assert.equal(sanitizeGeneratedTitle('\'重构数据库层\''), '重构数据库层');
    assert.equal(sanitizeGeneratedTitle('«添加单元测试»'), '添加单元测试');
  });

  it('strips trailing punctuation', () => {
    assert.equal(sanitizeGeneratedTitle('完成API接口开发。'), '完成API接口开发');
    assert.equal(sanitizeGeneratedTitle('修复了内存泄漏！'), '修复了内存泄漏');
    assert.equal(sanitizeGeneratedTitle('添加了新功能，'), '添加了新功能');
    assert.equal(sanitizeGeneratedTitle('重构完成;'), '重构完成');
  });

  it('takes only the first line', () => {
    // Note: \s+ collapse happens before split('\n'), so \n is already a space.
    // The split is a safety net for content that passes through without whitespace collapse.
    assert.equal(sanitizeGeneratedTitle('第一行标题\r\n第二行不应该出现'), '第一行标题 第二行不应该出现');
    // Multi-line without whitespace between lines
    const input = '标题部分' + '\n' + '多余内容';
    const result = sanitizeGeneratedTitle(input);
    assert.equal(result, '标题部分 多余内容');
  });

  it('collapses whitespace', () => {
    assert.equal(sanitizeGeneratedTitle('  多余   空格  '), '多余 空格');
  });

  it('truncates to 60 characters', () => {
    const long = '一'.repeat(100);
    const result = sanitizeGeneratedTitle(long);
    assert.equal(result.length, 60);
  });

  it('returns empty for empty input', () => {
    assert.equal(sanitizeGeneratedTitle(''), '');
    assert.equal(sanitizeGeneratedTitle('   '), '');
    assert.equal(sanitizeGeneratedTitle(null), '');
    assert.equal(sanitizeGeneratedTitle(undefined), '');
  });

  it('returns empty for only-punctuation input', () => {
    assert.equal(sanitizeGeneratedTitle('。。。'), '');
    assert.equal(sanitizeGeneratedTitle('!!!'), '');
  });
});

// ── Additional inline helpers (mirrors buildTitleMessages post-processing in run-title-mirror.js) ──

const TITLE_RULES = '请从整段会话中识别稳定的主任务，为它生成一个简洁准确的标题。';

/**
 * Mirrors buildTitleMessages():
 * - keep non-empty user/assistant text only
 * - preserve the first user request plus the last 32 conversational messages
 * - serialize the selected history into one user transcript message
 * - append the structured tool-output instruction
 */
function prepareTitleMessages(rawMessages) {
  const conversationalMessages = rawMessages.filter((message) => (
    (message?.role === 'user' || message?.role === 'assistant')
    && cleanValue(message?.content)
  ));
  const firstUser = conversationalMessages.find((message) => message.role === 'user');
  const recentMessages = conversationalMessages.slice(-32);
  if (firstUser && !recentMessages.includes(firstUser)) {
    recentMessages.unshift(firstUser);
  }

  const transcript = recentMessages.length > 0
    ? recentMessages.map((message, index) => {
      const speaker = message.role === 'user' ? '用户' : '助手';
      return `【${speaker} ${index + 1}】\n${cleanValue(message.content)}`;
    }).join('\n\n')
    : '（会话中没有可用的用户或助手正文）';
  return [{
    role: 'user',
    content: `以下是会话转录：\n\n${transcript}\n\n${TITLE_RULES}\n- 必须调用 record_session_title 工具提交标题，不要输出其他内容。`,
    turn: 0,
  }];
}

// ── Additional tests ──

describe('prepareTitleMessages', () => {
  it('returns one user message containing transcript and title rules', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    const result = prepareTitleMessages(messages);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'user');
    assert.ok(result[0].content.includes('【用户 1】\nhello'));
    assert.ok(result[0].content.includes('【助手 2】\nhi'));
    assert.ok(result[0].content.includes(TITLE_RULES));
  });

  it('uses an empty-transcript marker when no conversational text exists', () => {
    const messages = [
      { role: 'system', content: 'You are helpful.' },
    ];
    const result = prepareTitleMessages(messages);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'user');
    assert.ok(result[0].content.includes('没有可用的用户或助手正文'));
  });

  it('supports assistant-only transcript without invalid role ordering', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: 'hi there' },
    ];
    const result = prepareTitleMessages(messages);
    assert.equal(result.length, 1);
    assert.ok(result[0].content.includes('【助手 1】\nhi there'));
  });

  it('preserves the first user request plus the last 32 messages', () => {
    const messages = [];
    for (let i = 0; i < 40; i++) {
      messages.push({ role: 'user', content: `msg ${i}` });
    }
    const result = prepareTitleMessages(messages);
    assert.equal(result.length, 1);
    assert.ok(result[0].content.includes('msg 0'));
    assert.ok(result[0].content.includes('msg 8'));
    assert.ok(!result[0].content.includes('msg 7\n'));
  });

  it('filters non-string and tool content', () => {
    const messages = [
      { role: 'user', content: null },
      { role: 'tool', content: 'tool output' },
      { role: 'assistant', content: 'final answer' },
    ];
    const result = prepareTitleMessages(messages);
    assert.equal(result.length, 1);
    assert.ok(result[0].content.includes('final answer'));
    assert.ok(!result[0].content.includes('tool output'));
  });

  it('collapses consecutive assistant messages into a valid single-user request', () => {
    const messages = [
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'step one' },
      { role: 'assistant', content: 'step two' },
    ];
    const result = prepareTitleMessages(messages);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'user');
    assert.ok(result[0].content.includes('step one'));
    assert.ok(result[0].content.includes('step two'));
  });
});

describe('tuneTitleLLM', () => {
  it('caps maxTokens to 1024 when larger', () => {
    const llm = { maxTokens: 4096 };
    tuneMirrorLLM(llm, 1024);
    assert.equal(llm.maxTokens, 1024);
  });

  it('keeps maxTokens when already <= 1024', () => {
    const llm = { maxTokens: 512 };
    tuneMirrorLLM(llm, 1024);
    assert.equal(llm.maxTokens, 512);
  });

  it('sets maxTokens to 1024 when invalid', () => {
    const llm = { maxTokens: 'abc' };
    tuneMirrorLLM(llm, 1024);
    assert.equal(llm.maxTokens, 1024);
  });

  it('sets maxTokens to 1024 when negative', () => {
    const llm = { maxTokens: -1 };
    tuneMirrorLLM(llm, 1024);
    assert.equal(llm.maxTokens, 1024);
  });

  it('clears configured reasoning options', () => {
    const llm = {
      thinkingBudgetTokens: 8192,
      thinkingKeepTurns: 5,
      maxTokens: 2048,
      providerOptions: {
        reasoning: { enabled: true },
        reasoning_effort: 'high',
        thinking: { type: 'enabled' },
        temperature: 0,
      },
    };
    tuneMirrorLLM(llm, 1024);
    assert.equal(llm.thinkingBudgetTokens, undefined);
    assert.equal(llm.thinkingKeepTurns, 0);
    assert.equal(llm.maxTokens, 1024);
    assert.deepEqual(llm.providerOptions, { temperature: 0 });
  });

  it('does nothing for null or non-object input', () => {
    assert.doesNotThrow(() => tuneMirrorLLM(null, 1024));
    assert.doesNotThrow(() => tuneMirrorLLM(undefined, 1024));
    assert.doesNotThrow(() => tuneMirrorLLM('string', 1024));
    assert.doesNotThrow(() => tuneMirrorLLM(42, 1024));
  });

  it('does nothing when maxTokens is not an own property', () => {
    const proto = { maxTokens: 9999 };
    const llm = Object.create(proto);
    tuneMirrorLLM(llm, 1024);
    assert.equal(llm.maxTokens, 9999);
    assert.ok(!Object.prototype.hasOwnProperty.call(llm, 'maxTokens'));
  });
});
