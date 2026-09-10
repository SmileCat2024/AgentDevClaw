/**
 * parseHandoffContent 共享解析器（server/shared/handoff-payload.js）
 *
 * run-prebuilt-agent / run-one-shot 的 runtime 消费端此前各自内联一份解析，
 * 且只读 compactOutput.*——trim-transcript-with-summary 包（trim / thread
 * 接力链路）的 appendedSummary 摘要正文与 importantFiles 进不了
 * HandoffSeedFeature，属字段断链。本文件锁定三形态读取契约。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseHandoffContent } from '../server/shared/handoff-payload.js';

describe('parseHandoffContent 共享解析器', () => {
  test('trim-with-summary 包：appendedSummary 摘要正文与重要文件被读取', () => {
    const raw = JSON.stringify({
      handoffId: 'handoff-x',
      mode: 'trim-transcript-with-summary',
      sourceSessionId: 'src-1',
      sourceSummary: 'Task: 概览头', // 顶层只是 Task/Goal 概览
      seedMessages: [{ role: 'user', content: '裁剪历史', turn: 0 }],
      appendedSummary: {
        summaryText: '真实摘要',
        importantFiles: ['a.js', 'b.js'],
        importantSkills: ['deploy'],
        fileRanges: { 'a.js': [1, 10] },
      },
      featureContinuity: { states: [{ featureName: 'x' }] },
    });
    const parsed = parseHandoffContent(raw, '/fake/path.json');
    assert.equal(parsed.sourceSummary, '真实摘要');
    assert.deepEqual(parsed.importantFiles, ['a.js', 'b.js']);
    assert.deepEqual(parsed.importantSkills, ['deploy']);
    assert.deepEqual(parsed.fileRanges, { 'a.js': [1, 10] });
    assert.deepEqual(parsed.featureContinuity, { states: [{ featureName: 'x' }] });
    assert.equal(parsed.seedMessages.length, 1);
    assert.equal(parsed.mode, 'trim-transcript-with-summary');
    assert.equal(parsed.packageId, 'handoff-x');
  });

  test('nine-section 包（compact 链）：compactOutput 优先，行为不变', () => {
    const raw = JSON.stringify({
      handoffId: 'handoff-y',
      mode: 'summarized-nine-section',
      sourceSummary: '九段摘要全文',
      seedMessages: [],
      compactOutput: {
        sessionTitle: '标题',
        importantFiles: ['c.js'],
        importantSkills: [],
        fileRanges: { 'c.js': [3, 4] },
      },
    });
    const parsed = parseHandoffContent(raw, '/fake/path.json');
    assert.equal(parsed.sourceSummary, '九段摘要全文'); // 无 appendedSummary 时不受影响
    assert.deepEqual(parsed.importantFiles, ['c.js']);
    assert.deepEqual(parsed.fileRanges, { 'c.js': [3, 4] });
  });

  test('compactOutput 与 appendedSummary 并存时 compactOutput 优先（向后兼容）', () => {
    const raw = JSON.stringify({
      sourceSummary: 's',
      compactOutput: { importantFiles: ['compact.js'] },
      appendedSummary: { summaryText: '追加摘要', importantFiles: ['appended.js'] },
    });
    const parsed = parseHandoffContent(raw, '/fake/path.json');
    assert.deepEqual(parsed.importantFiles, ['compact.js']);
    // 摘要正文仍回退到 appendedSummary（compactOutput 不承载摘要正文）
    assert.equal(parsed.sourceSummary, '追加摘要');
  });

  test('纯文本 payload（宽松模式）按原文收敛为 sourceSummary', () => {
    const parsed = parseHandoffContent('不是 JSON 的摘要文本', 'PROTOCLAW_HANDOFF_PAYLOAD', { rawTextFallback: true });
    assert.equal(parsed.sourceSummary, '不是 JSON 的摘要文本');
    assert.deepEqual(parsed.seedMessages, []);
  });

  test('文件形态的损坏 JSON 抛错；非花括号文本按摘要收敛', () => {
    assert.throws(() => parseHandoffContent('{broken', '/fake/path.json'), /解析 handoff 内容失败/);
    const parsed = parseHandoffContent('手写摘要文本', '/fake/path.txt');
    assert.equal(parsed.sourceSummary, '手写摘要文本');
  });

  test('seedMessages 无效项被过滤：缺 role 或全空的消息不进 seed', () => {
    const raw = JSON.stringify({
      seedMessages: [
        { role: 'user', content: '有效', turn: 1 },
        { content: '没有 role' },
        { role: 'assistant' }, // 无内容无工具
        { role: 'assistant', content: '带工具', toolCalls: [{ id: 't1' }] },
      ],
      sourceSummary: '摘要',
    });
    const parsed = parseHandoffContent(raw, '/fake/path.json');
    // 保留：user（有内容）与 assistant（带 toolCalls）；丢弃：缺 role、全空
    assert.equal(parsed.seedMessages.length, 2);
    assert.deepEqual(parsed.seedMessages.map(m => m.role), ['user', 'assistant']);
  });
});
