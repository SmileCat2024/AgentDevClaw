import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * R6 consumer 收编：三个投递触发点（apply 后 / runtime ready / gateway
 * append 后）统一消费 Thread Inbox，consumer 提供——
 *   - 退避：投递失败后线程级冷却，防触发点风暴下的重复失败投递；
 *   - 滞留水位告警：pending 指令滞留超阈值时告警一次（同 head 代际）；
 *   - FIFO：同线程指令严格按入箱顺序投出。
 */

const { WorkThreadRuntimeBridge } = await import('@agentdevjs/core');
const { createThreadControl } = await import('../server/thread-control/thread-controller.js');

async function makeTempRoot() {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const root = await mkdtemp(path.join(tmpdir(), 'wt-consumer-'));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function makeClock(startMs = 1_000_000) {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms) => { current += ms; },
  };
}

function makeTurnsBridge(turns, { failFirst = false } = {}) {
  let failed = false;
  return new WorkThreadRuntimeBridge({
    enabled: true,
    resolveRuntimeViewerId: (agentId, sessionId) => `viewer-${sessionId}`,
    submitTurn: async (params) => {
      if (failFirst && !failed) {
        failed = true;
        throw Object.assign(new Error('runtime not ready yet'), { retryable: true });
      }
      turns.push(params);
      return { success: true };
    },
  });
}

describe('Thread delivery consumer (R6 收编)', () => {
  let env;
  beforeEach(async () => { env = await makeTempRoot(); });

  it('delivers pending commands in FIFO order', async () => {
    const turns = [];
    const control = createThreadControl({ rootDir: env.root, bridge: makeTurnsBridge(turns) });
    const thread = await control.core.start({ sessionRef: { agentId: 'coder', sessionId: 'fifo-s1' } });
    await control.core.appendCommand({ threadId: thread.threadId, text: 'one' });
    await control.core.appendCommand({ threadId: thread.threadId, text: 'two' });
    await control.core.appendCommand({ threadId: thread.threadId, text: 'three' });

    const { createDeliveryConsumer } = await import('../server/thread-control/delivery-consumer.js');
    const consumer = createDeliveryConsumer(control.core, makeClock());
    const result = await consumer.consume(thread.threadId);

    assert.deepEqual(result.results.map((r) => r.accepted), [true, true, true]);
    assert.deepEqual(turns.map((t) => t.text), ['one', 'two', 'three']);
  });

  it('backs off after a failed delivery and retries after the window', async () => {
    const turns = [];
    const control = createThreadControl({ rootDir: env.root, bridge: makeTurnsBridge(turns, { failFirst: true }) });
    const thread = await control.core.start({ sessionRef: { agentId: 'coder', sessionId: 'backoff-s1' } });
    await control.core.advanceHead({
      threadId: thread.threadId, toSessionId: 'backoff-s2', fromSessionId: 'backoff-s1', endKind: 'trim',
    });
    await control.core.appendCommand({ threadId: thread.threadId, text: 'retry me' });

    const { createDeliveryConsumer } = await import('../server/thread-control/delivery-consumer.js');
    const clock = makeClock();
    const consumer = createDeliveryConsumer(control.core, { backoffMs: 5000, now: clock.now });

    // 首次消费：bridge 失败 → attempted 1, delivered 0 → 进入退避
    const first = await consumer.consume(thread.threadId);
    assert.equal(first.attempted, 1);
    assert.equal(first.delivered, 0);

    // 退避窗口内：不触达 bridge
    const second = await consumer.consume(thread.threadId);
    assert.equal(second.reason, 'delivery_backoff');
    assert.equal(second.attempted, 0);
    assert.equal(turns.length, 0);

    // 窗口过后：恢复投递
    clock.advance(5001);
    const third = await consumer.consume(thread.threadId);
    assert.equal(third.delivered, 1);
    assert.deepEqual(turns.map((t) => t.text), ['retry me']);
  });

  it('warns once per head generation when pending commands exceed the stale threshold', async () => {
    const warnings = [];
    const control = createThreadControl({
      rootDir: env.root,
      // bridge 保持失败：指令长期滞留 pending
      bridge: new WorkThreadRuntimeBridge({
        enabled: true,
        resolveRuntimeViewerId: () => null,
        submitTurn: async () => ({ success: true }),
      }),
    });
    const thread = await control.core.start({ sessionRef: { agentId: 'coder', sessionId: 'stale-s1' } });
    await control.core.appendCommand({ threadId: thread.threadId, text: 'stuck' });

    const { createDeliveryConsumer } = await import('../server/thread-control/delivery-consumer.js');
    // clock 起点取真实当前时间：createdAt 用真实墙钟写入，水位年龄按同
    // 一时基计算
    const clock = makeClock(Date.now());
    const logger = { warn: (msg) => warnings.push(msg) };
    const consumer = createDeliveryConsumer(control.core, { staleWarnMs: 60_000, now: clock.now, logger });

    // 未达水位：无告警
    await consumer.consume(thread.threadId);
    assert.equal(warnings.length, 0);

    // 越过水位：告警一次
    clock.advance(60_001);
    await consumer.consume(thread.threadId);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /pending.*60001ms|pending.*over|stale/);

    // 同 head 代际内不重复告警
    clock.advance(60_001);
    await consumer.consume(thread.threadId);
    assert.equal(warnings.length, 1);
  });

  it('does not back off on gated no-op results (handoff window is waiting, not failure)', async () => {
    const turns = [];
    const control = createThreadControl({ rootDir: env.root, bridge: makeTurnsBridge(turns) });
    const thread = await control.core.start({ sessionRef: { agentId: 'coder', sessionId: 'gate-s1' } });
    await control.core.beginSessionHandoff({ threadId: thread.threadId, fromSessionId: 'gate-s1', reason: 'trim' });
    await control.core.appendCommand({ threadId: thread.threadId, text: 'during handoff' });

    const { createDeliveryConsumer } = await import('../server/thread-control/delivery-consumer.js');
    const clock = makeClock();
    const consumer = createDeliveryConsumer(control.core, { backoffMs: 5000, now: clock.now });

    // 挡板期投递被拒（attempted 0）：这是等待，不是失败，不触发退避
    const first = await consumer.consume(thread.threadId);
    assert.equal(first.attempted, 0);
    assert.equal(first.reason, 'handoff_in_progress');

    // 立即再消费：不受退避影响（推进 head 后 pending 全部可投——
    // 含 R3 播种的恢复指令与本条指令，共 2 条）
    await control.core.advanceHead({
      threadId: thread.threadId, toSessionId: 'gate-s2', fromSessionId: 'gate-s1', endKind: 'trim',
    });
    const second = await consumer.consume(thread.threadId);
    assert.equal(second.delivered, 2);
    assert.ok(turns.some((t) => t.text === 'during handoff'));
  });
});
