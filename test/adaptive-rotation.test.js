import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  measureMessagesCharTotal,
  decideAdaptiveTier,
  runAdaptiveRotationHandoff,
} from '../server/context-continuity/adaptive-rotation.js';
import { resolveTrimToolBatchPolicy } from '../server/context-continuity/handoff-package.js';
import { PERMISSION_ITEMS } from '../server/shared/permission-registry.js';
import { buildTrimmedSeedMessages, normalizeExportPolicy } from '@agentdevjs/core';

/** 一批调用：一条 assistant 消息带多个 toolCall + 配对结果。 */
function pushToolBatch(messages, ids) {
  messages.push({ role: 'assistant', content: '', toolCalls: ids.map(id => ({ id, name: 'read', arguments: '{}' })) });
  for (const id of ids) {
    messages.push({ role: 'tool', toolCallId: id, content: `result-${id}` });
  }
}

function buildSnapshot(messages) {
  return { runtime: { context: { messages } } };
}

function stubExecutors() {
  const calls = { history: [], trimWithSummary: [], writeTrimWithSummary: [], summarized: [] };
  const seedSentinel = { seedMessages: [], meta: { mode: 'trim-transcript-with-summary' } };
  return {
    calls,
    seedSentinel,
    executors: {
      exportHistoryOnly: async (args) => { calls.history.push(args); return { handoff: { mode: 'trim-transcript' }, handoffPath: '/tmp/h.json' }; },
      runTrimWithSummary: async (args) => { calls.trimWithSummary.push(args); return seedSentinel; },
      writeTrimWithSummary: async (args) => { calls.writeTrimWithSummary.push(args); return { handoff: { mode: 'trim-transcript-with-summary' }, handoffPath: '/tmp/hs.json' }; },
      exportSummarized: async (args) => { calls.summarized.push(args); return { handoff: { mode: 'summarized-nine-section' }, handoffPath: '/tmp/s.json' }; },
    },
  };
}

function baseParams(sessionSnapshot, options = {}) {
  const { calls, seedSentinel, executors } = stubExecutors();
  return {
    calls,
    seedSentinel,
    params: {
      userDataRoot: '/tmp/claw',
      agentId: 'coder',
      sessionId: 'session-1',
      sessionPath: '/tmp/session-1.json',
      sourceRecord: { title: 't' },
      sessionSnapshot,
      agentRelativeDir: 'prebuilt-agents/official/coder',
      projectRoot: '/tmp/root',
      policy: {},
      options,
      executors,
    },
  };
}

describe('adaptive rotation tier decision (一次性阶梯)', () => {
  it('maps ratio bands to tiers with boundary values falling to the lower tier', () => {
    assert.equal(decideAdaptiveTier(0).tier, 'trim');
    assert.equal(decideAdaptiveTier(0.4).tier, 'trim');
    assert.equal(decideAdaptiveTier(0.400001).tier, 'trim-summary');
    assert.equal(decideAdaptiveTier(0.8).tier, 'trim-summary');
    assert.equal(decideAdaptiveTier(0.800001).tier, 'summary');
    assert.equal(decideAdaptiveTier(1).tier, 'summary');
  });

  it('treats non-finite ratios as zero (empty context falls to trim tier)', () => {
    assert.equal(decideAdaptiveTier(Number.NaN).tier, 'trim');
    assert.equal(decideAdaptiveTier(Number.POSITIVE_INFINITY).tier, 'trim');
    assert.equal(decideAdaptiveTier(Number.NEGATIVE_INFINITY).tier, 'trim');
  });

});

describe('rotation tool batch budget (最近五批工具调用)', () => {
  it('keeps every call of the last five batches, including a batch that ran several tools', () => {
    const messages = [{ role: 'user', content: 'go' }];
    for (let i = 1; i <= 6; i += 1) pushToolBatch(messages, i === 6 ? ['x1', 'x2', 'x3'] : [`c${i}`]);

    const policy = normalizeExportPolicy(resolveTrimToolBatchPolicy({ keepRecentToolBatches: 5 }, messages));
    const { seedMessages } = buildTrimmedSeedMessages(messages, policy);
    const keptResults = seedMessages.filter(m => m.role === 'tool').map(m => m.toolCallId);

    // 六批中最早的一批被折叠，其余五批（含同批三个工具）调用与结果成对保留
    assert.deepEqual(keptResults.sort(), ['c2', 'c3', 'c4', 'c5', 'x1', 'x2', 'x3']);
  });

  it('leaves the policy untouched when no batch budget is declared', () => {
    const messages = [];
    pushToolBatch(messages, ['a']);
    assert.deepEqual(resolveTrimToolBatchPolicy({ strategy: 'trim-transcript' }, messages), { strategy: 'trim-transcript' });
  });
});

describe('adaptive rotation char measurement (对称口径)', () => {
  it('counts content chars plus toolCalls JSON chars on both sides', () => {
    const toolCallChars = JSON.stringify({ id: 'tc1' }).length;
    assert.equal(
      measureMessagesCharTotal([
        { role: 'user', content: 'abc' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'tc1' }] },
        'not-a-message',
      ]),
      3 + toolCallChars,
    );
  });

  it('returns 0 for non-array input', () => {
    assert.equal(measureMessagesCharTotal(null), 0);
    assert.equal(measureMessagesCharTotal(undefined), 0);
  });
});

describe('adaptive rotation dispatch (三档复用既有产物路径)', () => {
  it('tool-heavy context (low ratio) stays on the trim tier via history-only export', async () => {
    // 10 批调用，每批 1 个：前 5 批大结果被折叠，后 5 批小结果原样保留。
    const messages = [{ role: 'user', content: 'hello' }];
    for (let i = 1; i <= 10; i += 1) {
      const resultSize = i <= 5 ? 10000 : 5;
      messages.push({ role: 'assistant', content: '', toolCalls: [{ id: `tc${i}`, name: 'read', arguments: `{"filePath":"f${i}.js"}` }] });
      messages.push({ role: 'tool', toolCallId: `tc${i}`, content: 'x'.repeat(resultSize) });
    }
    messages.push({ role: 'assistant', content: 'done' });
    const { calls, params } = baseParams(buildSnapshot(messages));
    const result = await runAdaptiveRotationHandoff(params);

    assert.equal(result.adaptive.tier, 'trim');
    assert.ok(result.adaptive.ratio < 0.4);
    assert.equal(calls.history.length, 1);
    assert.equal(calls.trimWithSummary.length, 0);
    assert.equal(calls.summarized.length, 0);
    assert.equal(calls.history[0].agentId, 'coder');
  });

  it('the tier ratio uses the batch policy, not the old per-call budget', async () => {
    // 六批、每批三个 read：前四批结果很大，后两批很小。
    // 按调用留 5 个 → seed 几乎只剩小结果，ratio 极低（trim 档）；
    // 按批留 5 批 → b2..b6 的大结果一起留在 seed 里，ratio 升到追加摘要档。
    const messages = [{ role: 'user', content: 'go' }];
    for (let batch = 1; batch <= 6; batch += 1) {
      const ids = [1, 2, 3].map((i) => `b${batch}-t${i}`);
      messages.push({ role: 'assistant', content: '', toolCalls: ids.map((id) => ({ id, name: 'read', arguments: '{}' })) });
      for (const id of ids) {
        messages.push({ role: 'tool', toolCallId: id, content: 'x'.repeat(batch <= 4 ? 4000 : 10) });
      }
    }
    const { calls, params } = baseParams(buildSnapshot(messages));
    const result = await runAdaptiveRotationHandoff(params);

    assert.equal(result.adaptive.tier, 'trim-summary', 'tier follows the five-batch probe ratio');
    assert.ok(result.adaptive.ratio > 0.4, `ratio came from the batch policy, got ${result.adaptive.ratio}`);
    assert.equal(calls.trimWithSummary.length, 1);
    assert.equal(calls.history.length, 0);
  });

  it('middle band escalates to the official trim+summary combined path', async () => {
    const sessionSnapshot = buildSnapshot([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'tc1', name: 'read', arguments: '{"filePath":"a.js"}' }] },
      { role: 'tool', toolCallId: 'tc1', content: 'x'.repeat(400) },
      { role: 'assistant', content: 'done' },
    ]);
    // 阈值测试缝：强制任意非零比例落入追加摘要档
    const { calls, seedSentinel, params } = baseParams(sessionSnapshot, { appendSummaryRatio: 0, pureSummaryRatio: 2 });
    const result = await runAdaptiveRotationHandoff(params);

    assert.equal(result.adaptive.tier, 'trim-summary');
    assert.equal(calls.history.length, 0);
    assert.equal(calls.trimWithSummary.length, 1);
    assert.equal(calls.writeTrimWithSummary.length, 1);
    assert.equal(calls.summarized.length, 0);
    assert.equal(calls.writeTrimWithSummary[0].seed, seedSentinel, 'combined seed flows from the official transform into the handoff writer');
  });

  it('ratio above the pure-summary threshold discards the trim probe and summarizes', async () => {
    const sessionSnapshot = buildSnapshot([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);
    const { calls, params } = baseParams(sessionSnapshot, { pureSummaryRatio: 0.1 });
    const result = await runAdaptiveRotationHandoff(params);

    assert.equal(result.adaptive.tier, 'summary');
    assert.equal(calls.history.length, 0);
    assert.equal(calls.trimWithSummary.length, 0);
    assert.equal(calls.summarized.length, 1);
    assert.equal(calls.summarized[0].agentRelativeDir, 'prebuilt-agents/official/coder');
  });

  it('empty context (ratio 0) degrades to the trim tier instead of throwing', async () => {
    const { calls, params } = baseParams(buildSnapshot([]));
    const result = await runAdaptiveRotationHandoff(params);
    assert.equal(result.adaptive.tier, 'trim');
    assert.equal(calls.history.length, 1);
  });
});

describe('contextRotationStrategy permission item', () => {
  it('validates enum values only', () => {
    const item = PERMISSION_ITEMS.contextRotationStrategy;
    assert.ok(item);
    for (const value of ['adaptive', 'trim', 'summary']) {
      assert.equal(item.validate(value), true, `${value} should be valid`);
    }
    for (const value of ['bogus', '', 1, null, undefined]) {
      assert.equal(item.validate(value), false, `${String(value)} should be invalid`);
    }
  });
});
