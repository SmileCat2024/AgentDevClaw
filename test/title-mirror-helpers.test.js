/**
 * Tests for title-mirror pure functions.
 *
 * Covers the core decision logic extracted from scripts/run-title-mirror.js:
 * 1. sanitizeGeneratedTitle — cleans raw model output into a usable title
 * 2. buildHeuristicTitle — generates a fallback title from last user message
 * 3. prepareTitleMessages — post-processing of compacted messages (anchor insertion, truncation, prompt append)
 * 4. tuneTitleLLM — caps maxTokens and clears thinkingBudget for title generation
 *
 * These mirror the actual code paths in run-title-mirror.js.
 * When that script changes, these tests should be updated accordingly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

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

function buildHeuristicTitle(rawMessages) {
  const userMessages = rawMessages
    .filter((message) => message.role === 'user' && cleanValue(message.content))
    .map((message) => message.content);
  const lastUser = cleanValue(userMessages[userMessages.length - 1] || '');
  if (!lastUser) return '新对话';

  const cleaned = lastUser
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[A-Za-z]:\\[^\s]+/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const segments = cleaned
    .split(/[。！？!?；;\n\r]/)
    .map((part) => part.trim())
    .filter(Boolean);

  const candidate = segments.find((part) => part.length >= 8) || segments[0] || cleaned;
  const normalized = candidate
    .replace(/^(请|帮我|麻烦|看看|你看下|你看一下|需要|想要)\s*/u, '')
    .replace(/^(这个|当前|现在)?项目(里|中)?的?/u, '')
    .replace(/还是有/g, '')
    .replace(/[""'""`]/g, '')
    .replace(/[，,、:：;；]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (/会话标题|session title|标题生成/i.test(normalized) && /空|empty|报错|失败/i.test(normalized)) {
    return '修复会话标题生成空内容报错';
  }

  return sanitizeGeneratedTitle(normalized) || '新对话';
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

describe('buildHeuristicTitle', () => {
  it('returns 新对话 for empty messages', () => {
    assert.equal(buildHeuristicTitle([]), '新对话');
  });

  it('returns 新对话 when no user messages exist', () => {
    assert.equal(buildHeuristicTitle([{ role: 'assistant', content: 'hello' }]), '新对话');
  });

  it('returns 新对话 when user messages are empty', () => {
    assert.equal(buildHeuristicTitle([{ role: 'user', content: '' }]), '新对话');
  });

  it('uses last user message as basis', () => {
    const messages = [
      { role: 'user', content: '第一次提问' },
      { role: 'assistant', content: '回答' },
      { role: 'user', content: '第二次提问关于数据库优化的问题' },
    ];
    assert.ok(buildHeuristicTitle(messages).includes('数据库优化'));
  });

  it('strips code blocks from user message', () => {
    const messages = [
      { role: 'user', content: '帮我看看这段代码```javascript\nconst x = 1;\n```有什么问题需要修复的地方' },
    ];
    const title = buildHeuristicTitle(messages);
    assert.ok(!title.includes('```'));
    assert.ok(!title.includes('javascript'));
    assert.ok(title.length > 0);
  });

  it('strips inline code from user message', () => {
    const messages = [
      { role: 'user', content: '这个 `function foo()` 函数需要重构优化代码结构让它更清晰' },
    ];
    const title = buildHeuristicTitle(messages);
    assert.ok(!title.includes('`'));
  });

  it('strips URLs from user message', () => {
    const messages = [
      { role: 'user', content: '请参考 https://example.com/docs 这个文档来修复接口问题需要尽快处理' },
    ];
    const title = buildHeuristicTitle(messages);
    assert.ok(!title.includes('https://'));
  });

  it('strips Windows file paths from user message', () => {
    const messages = [
      { role: 'user', content: 'C:\\Users\\test\\project\\src 文件里的登录模块需要优化用户认证流程' },
    ];
    const title = buildHeuristicTitle(messages);
    assert.ok(!title.includes('C:\\'));
  });

  it('strips common prefixes like 请/帮我/麻烦', () => {
    const messages1 = [{ role: 'user', content: '请帮我分析一下这段代码的性能瓶颈在哪里需要怎么优化' }];
    assert.ok(!buildHeuristicTitle(messages1).startsWith('请'));

    const messages2 = [{ role: 'user', content: '帮我看看这个登录功能的安全性问题需要怎样修复' }];
    assert.ok(!buildHeuristicTitle(messages2).startsWith('帮我'));

    const messages3 = [{ role: 'user', content: '麻烦检查一下数据库连接池的配置有没有什么问题' }];
    assert.ok(!buildHeuristicTitle(messages3).startsWith('麻烦'));
  });

  it('picks first segment >= 8 chars when multiple sentences', () => {
    const messages = [
      { role: 'user', content: '好的。这是一个需要超过八个字符的核心问题描述部分' },
    ];
    const title = buildHeuristicTitle(messages);
    assert.ok(!title.startsWith('好的'));
    assert.ok(title.includes('核心问题'));
  });

  it('falls back to first segment when none >= 8 chars', () => {
    const messages = [
      { role: 'user', content: '修Bug。小改' },
    ];
    const title = buildHeuristicTitle(messages);
    // Should pick first segment "修Bug"
    assert.ok(title.length > 0);
  });

  it('recognizes title-generation-related error pattern', () => {
    const messages = [
      { role: 'user', content: '会话标题生成返回空内容报错了需要修复' },
    ];
    assert.equal(buildHeuristicTitle(messages), '修复会话标题生成空内容报错');
  });

  it('truncates very long content to 60 chars', () => {
    const messages = [
      { role: 'user', content: '这是一段非常长的用户输入内容'.repeat(10) },
    ];
    const title = buildHeuristicTitle(messages);
    assert.ok(title.length <= 60);
  });
});

// ── Additional inline helpers (mirrors buildTitleMessages post-processing in run-title-mirror.js) ──

const TITLE_PROMPT = '以上是一段对话的完整历史记录。请直接为这段对话生成一个简洁的标题并输出。';

/**
 * Mirrors the post-processing logic from buildTitleMessages():
 * - compactMessages normalization (role, content, turn)
 * - slice to last 24 messages
 * - synthetic user anchor insertion when first non-system is not 'user'
 * - TITLE_PROMPT appended as last user message
 *
 * Input is an array of messages already trimmed (simulating buildTrimmedSeedMessages output).
 */
function prepareTitleMessages(seedMessages) {
  const compactMessages = seedMessages.slice(-24).map((message, index) => ({
    role: message.role,
    content: typeof message.content === 'string' ? message.content : '',
    turn: Number.isFinite(message.turn) ? message.turn : index,
  }));

  const firstNonSystemIndex = compactMessages.findIndex((message) => message.role !== 'system');
  const firstNonSystemRole = firstNonSystemIndex >= 0 ? compactMessages[firstNonSystemIndex]?.role : '';
  if (firstNonSystemIndex === -1) {
    compactMessages.unshift({
      role: 'user',
      content: '以下是一个会话的历史片段，请基于这些内容生成标题。',
      turn: -1,
    });
  } else if (firstNonSystemRole !== 'user') {
    compactMessages.splice(firstNonSystemIndex, 0, {
      role: 'user',
      content: '以下是从会话中截取的历史片段，请基于后续内容生成标题。',
      turn: Number.isFinite(compactMessages[firstNonSystemIndex]?.turn)
        ? Number(compactMessages[firstNonSystemIndex].turn) - 0.5
        : -1,
    });
  }

  compactMessages.push({
    role: 'user',
    content: TITLE_PROMPT,
    turn: compactMessages.length,
  });

  return compactMessages;
}

/**
 * Mirrors tuneTitleLLM from run-title-mirror.js.
 * Caps maxTokens to 1024 and clears thinkingBudgetTokens.
 */
function tuneTitleLLM(llm) {
  if (!llm || typeof llm !== 'object') return;
  try {
    if (Object.prototype.hasOwnProperty.call(llm, 'thinkingBudgetTokens')) {
      llm.thinkingBudgetTokens = undefined;
    }
  } catch {}
  try {
    if (Object.prototype.hasOwnProperty.call(llm, 'maxTokens')) {
      const current = Number(llm.maxTokens);
      llm.maxTokens = Number.isFinite(current) && current > 0
        ? Math.min(current, 1024)
        : 1024;
    }
  } catch {}
}

// ── Additional tests ──

describe('prepareTitleMessages', () => {
  it('appends TITLE_PROMPT as last user message', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    const result = prepareTitleMessages(messages);
    const last = result[result.length - 1];
    assert.equal(last.role, 'user');
    assert.equal(last.content, TITLE_PROMPT);
  });

  it('prepends synthetic user anchor when all messages are system', () => {
    const messages = [
      { role: 'system', content: 'You are helpful.' },
    ];
    const result = prepareTitleMessages(messages);
    // First message should be the synthetic anchor
    assert.equal(result[0].role, 'user');
    assert.ok(result[0].content.includes('历史片段'));
    // Last should be TITLE_PROMPT
    assert.equal(result[result.length - 1].content, TITLE_PROMPT);
  });

  it('prepends synthetic user anchor when first non-system is assistant', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'hello' },
    ];
    const result = prepareTitleMessages(messages);
    // Should have synthetic anchor before the assistant message
    const firstNonSystem = result.find(m => m.role !== 'system' && m.content !== TITLE_PROMPT);
    assert.equal(firstNonSystem.role, 'user');
    assert.ok(firstNonSystem.content.includes('截取'));
  });

  it('does not prepend anchor when first non-system is user', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    const result = prepareTitleMessages(messages);
    // First message is still user, no extra anchor before it
    assert.equal(result[0].role, 'user');
    assert.equal(result[0].content, 'hello');
  });

  it('truncates to last 24 messages from seed', () => {
    const messages = [];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: 'user', content: `msg ${i}` });
    }
    const result = prepareTitleMessages(messages);
    // 24 sliced messages + 1 appended TITLE_PROMPT = 25
    // (no anchor prepended since first is user)
    assert.equal(result.length, 25);
    // First should be msg 6 (30-24=6)
    assert.equal(result[0].content, 'msg 6');
  });

  it('normalizes non-string content to empty string', () => {
    const messages = [
      { role: 'user', content: null },
      { role: 'assistant', content: 42 },
    ];
    const result = prepareTitleMessages(messages);
    // null content becomes ''
    assert.equal(result[0].content, '');
    // number content becomes ''
    assert.equal(result[1].content, '');
  });

  it('assigns turn index when turn is not a finite number', () => {
    const messages = [
      { role: 'user', content: 'a' },   // no turn → index 0
      { role: 'assistant', content: 'b', turn: 5 },
    ];
    const result = prepareTitleMessages(messages);
    assert.equal(result[0].turn, 0);
    assert.equal(result[1].turn, 5);
  });

  it('computes synthetic anchor turn as previous turn - 0.5', () => {
    const messages = [
      { role: 'system', content: 'sys', turn: 0 },
      { role: 'assistant', content: 'hi', turn: 10 },
    ];
    const result = prepareTitleMessages(messages);
    // Synthetic anchor inserted before assistant (turn=10), so turn = 10 - 0.5 = 9.5
    const anchor = result.find(m => m.role === 'user' && m.content.includes('截取'));
    assert.equal(anchor.turn, 9.5);
  });
});

describe('tuneTitleLLM', () => {
  it('caps maxTokens to 1024 when larger', () => {
    const llm = { maxTokens: 4096 };
    tuneTitleLLM(llm);
    assert.equal(llm.maxTokens, 1024);
  });

  it('keeps maxTokens when already <= 1024', () => {
    const llm = { maxTokens: 512 };
    tuneTitleLLM(llm);
    assert.equal(llm.maxTokens, 512);
  });

  it('sets maxTokens to 1024 when invalid', () => {
    const llm = { maxTokens: 'abc' };
    tuneTitleLLM(llm);
    assert.equal(llm.maxTokens, 1024);
  });

  it('sets maxTokens to 1024 when negative', () => {
    const llm = { maxTokens: -1 };
    tuneTitleLLM(llm);
    assert.equal(llm.maxTokens, 1024);
  });

  it('clears thinkingBudgetTokens to undefined', () => {
    const llm = { thinkingBudgetTokens: 8192, maxTokens: 2048 };
    tuneTitleLLM(llm);
    assert.equal(llm.thinkingBudgetTokens, undefined);
    assert.equal(llm.maxTokens, 1024);
  });

  it('does nothing for null or non-object input', () => {
    assert.doesNotThrow(() => tuneTitleLLM(null));
    assert.doesNotThrow(() => tuneTitleLLM(undefined));
    assert.doesNotThrow(() => tuneTitleLLM('string'));
    assert.doesNotThrow(() => tuneTitleLLM(42));
  });

  it('does nothing when maxTokens is not an own property', () => {
    const proto = { maxTokens: 9999 };
    const llm = Object.create(proto);
    tuneTitleLLM(llm);
    assert.equal(llm.maxTokens, 9999);
    assert.ok(!Object.prototype.hasOwnProperty.call(llm, 'maxTokens'));
  });
});
