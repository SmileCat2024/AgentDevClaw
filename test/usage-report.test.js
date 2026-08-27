import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCallUsageEvents } from '../scripts/usage-report.js';

const baseArgs = () => ({
  agentId: 'programming-helper',
  sessionId: 'sess-1',
  runtimeInstanceId: 'rt-1',
  callIndex: 3,
  llmMeta: {},
  context: { contextInputTokens: 900, messageCount: 12 },
});

test('有 modelSegments 时按段拆分事件', () => {
  const events = buildCallUsageEvents({
    ...baseArgs(),
    callSummary: {
      callIndex: 3,
      totalUsage: { inputTokens: 300, outputTokens: 30, totalTokens: 330 },
      stepCount: 3,
      cacheHitRequests: 1,
      startTime: 1000,
      endTime: 2000,
      modelSegments: [
        {
          modelName: 'strong-model',
          presetName: 'DeepSeek-V4-Pro',
          usage: { inputTokens: 200, outputTokens: 20, totalTokens: 220 },
          requests: 2,
          cacheHitRequests: 1,
        },
        {
          modelName: 'cheap-model',
          presetName: 'DeepSeek-V4-flash',
          usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
          requests: 1,
          cacheHitRequests: 0,
        },
      ],
    },
  });

  assert.equal(events.length, 2);

  const [strong, cheap] = events;
  assert.equal(strong.source, 'agent-call');
  assert.equal(strong.callIndex, 3);
  assert.equal(strong.model.presetName, 'DeepSeek-V4-Pro');
  assert.equal(strong.model.modelName, 'strong-model');
  assert.equal(strong.requestCount, 2);
  assert.equal(strong.cacheHitRequests, 1);
  assert.equal(strong.usage.totalTokens, 220);
  assert.equal(cheap.model.presetName, 'DeepSeek-V4-flash');
  assert.equal(cheap.requestCount, 1);
  assert.equal(cheap.usage.totalTokens, 110);

  // 各事件独立、同 call 同时间戳、eventId 含段键可去重
  const ids = new Set(events.map((e) => e.eventId));
  assert.equal(ids.size, 2);
  for (const event of events) {
    assert.equal(event.timestamp, 2000);
    assert.ok(event.eventId.includes(':sess-1:'), 'eventId 含 sessionId');
    assert.ok(
      event.eventId.endsWith(event.model.presetName),
      `eventId 以段键结尾: ${event.eventId}`,
    );
  }
});

test('旧框架包无分段数据时回退整 call 单事件（按 agent meta 归因）', () => {
  const events = buildCallUsageEvents({
    ...baseArgs(),
    callSummary: {
      callIndex: 3,
      totalUsage: { inputTokens: 500, outputTokens: 50, totalTokens: 550 },
      stepCount: 4,
      cacheHitRequests: 2,
      startTime: 1000,
      endTime: 3000,
      // 无 modelSegments 字段
    },
    llmMeta: { modelName: 'final-model', presetName: 'Final-Preset' },
  });

  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.eventId.endsWith('Final-Preset'), true);
  assert.equal(event.timestamp, 3000);
  assert.equal(event.requestCount, 4);
  assert.equal(event.cacheHitRequests, 2);
  assert.equal(event.usage.totalTokens, 550);
  // 回退路径使用当前 meta 的归因，segment 段数据缺省字段照常生成
  assert.equal(event.model.modelName, 'final-model');
});

test('无效输入返回空数组：缺 totalUsage 或 callIndex 为 null', () => {
  assert.deepEqual(buildCallUsageEvents({ ...baseArgs(), callSummary: { stepCount: 1 } }), []);
  assert.deepEqual(buildCallUsageEvents({ ...baseArgs(), callIndex: null, callSummary: { totalUsage: { inputTokens: 1 } } }), []);
});

test('分段缺名字时长事件以 default 作段键', () => {
  const events = buildCallUsageEvents({
    ...baseArgs(),
    callSummary: {
      totalUsage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
      stepCount: 1,
      endTime: 5000,
      modelSegments: [{ usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 }, requests: 1 }],
    },
  });
  assert.equal(events.length, 1);
  assert.ok(events[0].eventId.endsWith(':default'));
});
