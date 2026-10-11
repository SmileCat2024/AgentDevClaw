import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createThreadRotationService } from '../server/thread-control/thread-rotation.js';

function createHarness({ stopResult = 'success' } = {}) {
  let releaseStop;
  let stopCalls = 0;
  let snapshotReads = 0;
  let failCalls = 0;
  let applyCalls = 0;
  const stopGate = new Promise((resolve, reject) => {
    releaseStop = () => stopResult instanceof Error ? reject(stopResult) : resolve();
  });
  const thread = { threadId: 'thread-1', status: 'active' };
  const service = createThreadRotationService({
    sessionApi: {
      updateSessionIndex: async () => {},
      compactAndResumeCurrentSession: async () => {
        snapshotReads += 1;
        return { session: { id: 'successor-1' }, agent: { ready: true } };
      },
    },
    stopManagedAgent: async (_agentId, _sessionId, options) => {
      stopCalls += 1;
      assert.deepEqual(options, { waitForPersistence: true });
      return stopGate;
    },
    threadIntegration: {
      beginSessionSuccession: async () => ({ applied: true, threadId: thread.threadId }),
      applySessionSuccession: async () => { applyCalls += 1; return { applied: true }; },
      tryDeliver: async () => {},
      failSessionSuccession: async () => { failCalls += 1; },
    },
    threadControl: {
      core: { findThreadByHeadSession: async () => thread },
    },
  });
  return {
    service,
    releaseStop,
    get stopCalls() { return stopCalls; },
    get snapshotReads() { return snapshotReads; },
    get failCalls() { return failCalls; },
    get applyCalls() { return applyCalls; },
  };
}

describe('thread rotation session save barrier', () => {
  it('does not read the old snapshot until save confirmation succeeds', async () => {
    const harness = createHarness();
    const rotating = harness.service.handleContextGuard('coder', 'head-1');
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(harness.stopCalls, 1);
    assert.equal(harness.snapshotReads, 0, 'snapshot read must stay behind the persistence barrier');
    harness.releaseStop();

    assert.deepEqual(await rotating, {
      applied: true,
      threadId: 'thread-1',
      headSessionId: 'successor-1',
    });
    assert.equal(harness.snapshotReads, 1);
    assert.equal(harness.applyCalls, 1);
    assert.equal(harness.failCalls, 0);
  });

  for (const scenario of [
    { name: 'save failure', outcome: 'failure' },
    { name: 'acknowledgement timeout', outcome: 'timeout' },
    { name: 'process exit before acknowledgement', outcome: 'process-exit' },
    { name: 'non-zero process exit', outcome: 'non-zero-exit' },
  ]) {
    it(`fails without reading the snapshot after ${scenario.name}`, async () => {
      const error = new Error(`${scenario.outcome}: persistence not confirmed`);
      const harness = createHarness({ stopResult: error });
      const rotating = harness.service.handleContextGuard('coder', 'head-1');
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(harness.snapshotReads, 0);
      harness.releaseStop();

      const result = await rotating;
      assert.equal(result.applied, false);
      assert.match(result.error, /persistence not confirmed/);
      assert.equal(harness.snapshotReads, 0);
      assert.equal(harness.applyCalls, 0);
      assert.equal(harness.failCalls, 1);
    });
  }

  it('coalesces repeated rotation requests while retirement is in progress', async () => {
    const harness = createHarness();
    const first = harness.service.handleContextGuard('coder', 'head-1');
    const duplicate = harness.service.handleContextGuard('coder', 'head-1');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(harness.stopCalls, 1);
    assert.equal(harness.snapshotReads, 0);

    harness.releaseStop();
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    assert.deepEqual(duplicateResult, {
      applied: true,
      threadId: 'thread-1',
      headSessionId: 'successor-1',
    });
    assert.deepEqual(firstResult, duplicateResult);
    assert.equal(harness.snapshotReads, 1);
  });

  it('treats an already-completed retirement without confirmation as a failed barrier', async () => {
    const harness = createHarness({
      stopResult: new Error('Session runtime is unavailable before persistence confirmation'),
    });
    const rotating = harness.service.handleContextGuard('coder', 'head-1');
    await Promise.resolve();
    await Promise.resolve();
    harness.releaseStop();
    const result = await rotating;
    assert.equal(result.applied, false);
    assert.equal(harness.snapshotReads, 0);
    assert.equal(harness.applyCalls, 0);
    assert.equal(harness.failCalls, 1);
  });

  it('runtime closes a session single-flight: concurrent close calls share one outcome and one notification', async () => {
    // 审核发现的并发关闭竞态：remove-session 与输入循环结束并发关闭同一
    // 会话时，第二次调用曾因 remove() 的 disposed 守卫立即返回 false，在
    // 首次保存仍在途时提前发出 persisted:false 的 session-exited，把正在
    // 成功的保存误判为失败、击穿保存屏障。closeHostedSession 不可导出，
    // 这里以源码级结构断言锁定单飞（与前端 wiring 测试同款手法）。
    const source = fs.readFileSync(new URL('../scripts/run-prebuilt-agent.js', import.meta.url), 'utf8');
    const closeStart = source.indexOf('const closingSessions = new Map()');
    const closeEnd = source.indexOf('// ── Process-level signal handlers', closeStart);
    assert.notEqual(closeStart, -1, 'closeHostedSession 单飞结构应存在');
    assert.notEqual(closeEnd, -1, '关闭段结束标记应存在');
    const closeBlock = source.slice(closeStart, closeEnd);
    assert.ok(closeBlock.includes('closingSessions.get(sessionId)'),
      '并发关闭必须复用在途关闭 Promise，不得走第二次 remove()');
    assert.ok(closeBlock.includes('closingSessions.delete(sessionId)'),
      '关闭完成后必须清理单飞登记，不阻塞后续顺序关闭');
    // 通知必须只发一次：session-exited 只能出现在共享的关闭 Promise 内。
    const notifyCount = (closeBlock.match(/type: 'session-exited'/g) || []).length;
    assert.equal(notifyCount, 1, 'session-exited 通知只能在共享关闭路径上发出一次');
  });
});
