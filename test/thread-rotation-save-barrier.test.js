import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createThreadRotationService } from '../server/thread-control/thread-rotation.js';

function createHarness({ stopResult = 'success', retireError = null } = {}) {
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
      if (options?.waitForPersistence) {
        assert.deepEqual(options, { waitForPersistence: true });
        return stopGate;
      }
      // 无屏障退役路径（retireRuntime）：可注入失败
      if (retireError) throw retireError;
      return 'stopped';
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

  it('logs when retiring the over-threshold runtime fails instead of swallowing silently', async () => {
    // wt-58471cd9 链的僵尸 head 来源：退役失败曾被 .catch(() => {}) 静默
    // 吞掉，旧 runtime 存活继续接收注定超限/前提为假的投递，且无从排查。
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.map(String).join(' '));
    try {
      const harness = createHarness({
        stopResult: new Error('persistence not confirmed'),
        retireError: new Error('kill failed'),
      });
      const rotating = harness.service.handleContextGuard('coder', 'head-1');
      await Promise.resolve();
      await Promise.resolve();
      harness.releaseStop();
      const result = await rotating;

      assert.equal(result.applied, false);
      const retireLog = errors.find((line) => line.includes('failed to retire over-threshold runtime'));
      assert.ok(retireLog, '退役失败必须留痕（僵尸 head 可排查）');
      assert.ok(retireLog.includes('kill failed'), '留痕包含失败原因');
    } finally {
      console.error = originalError;
    }
  });

  it('host removal waits for execution, host mutations and final save before disposing', async () => {
    // Execute the production class in a sandbox: omit executable CLI startup,
    // replace only external resources, not the removal implementation.
    const source = fs.readFileSync(new URL('../scripts/run-prebuilt-agent.js', import.meta.url), 'utf8');
    const start = source.indexOf('class SessionLifecycle');
    const end = source.indexOf('// 会话关闭单飞', start);
    const Host = vm.runInNewContext(`${source.slice(start, end)}; SessionLifecycle`, {
      console: { error() {}, warn() {} }, clearTimeout, sessionStore: {},
    });
    for (const saveFails of [false, true]) {
      const quiesced = Promise.withResolvers();
      const mutation = Promise.withResolvers();
      const session = Object.create(Host.prototype);
      const effects = [];
      Object.assign(session, {
        sessionId: 'target', _hostRequests: new Set([mutation.promise]),
        _commsSaveChain: Promise.resolve(),
        callArbiter: { close: () => quiesced.promise },
        agent: {
          async saveSession() { effects.push('saved'); if (saveFails) throw new Error('disk full'); },
          async dispose() { effects.push('disposed'); throw new Error('cleanup failure'); },
        },
      });
      const first = session.remove();
      assert.equal(session.remove(), first, 'concurrent removal must share its actual result');
      await Promise.resolve();
      assert.deepEqual(effects, []);
      quiesced.resolve();
      await Promise.resolve();
      assert.deepEqual(effects, [], 'in-flight mutations must finish before snapshot');
      mutation.resolve();
      assert.equal(await first, !saveFails);
      assert.deepEqual(effects, ['saved', 'disposed']);
    }
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

  it('persistence report reflects the save outcome only, not dispose failures', async () => {
    // 伪失败路径之二：remove() 曾把 agent.dispose() 的失败翻成 persisted:false，
    // 把已成功落盘的保存误报给服务端屏障（10-17/10-18 事故的候选签名）。
    // persisted 的语义是"快照落盘确认"，dispose 只释放资源、失败仅记日志。
    // remove() 不可导出，源码级断言锁定 catch 块不得否定保存事实。
    const source = fs.readFileSync(new URL('../scripts/run-prebuilt-agent.js', import.meta.url), 'utf8');
    const removeStart = source.indexOf('async removeInternal() {');
    const removeEnd = source.indexOf('// 会话关闭单飞', removeStart);
    assert.notEqual(removeStart, -1, 'remove() 应存在');
    assert.notEqual(removeEnd, -1, 'remove() 结束标记应存在');
    const removeBlock = source.slice(removeStart, removeEnd);
    const disposeSection = removeBlock.slice(removeBlock.indexOf('await this.agent.dispose()'));
    assert.ok(disposeSection.includes('释放资源失败'), 'dispose 失败应记日志');
    const persistedFlips = (disposeSection.match(/persisted = false/g) || []).length;
    assert.equal(persistedFlips, 0, 'dispose 失败不得翻 persisted:false（保存事实不受释放失败影响）');
    // saveSession 失败仍然必须否定 persisted（真失败语义不变）。
    assert.ok(removeBlock.includes('保存会话失败'), 'saveSession 失败日志应存在');
    const saveSection = removeBlock.slice(0, removeBlock.indexOf('await this.agent.dispose()'));
    assert.ok(saveSection.includes('persisted = false'), '保存失败仍必须翻 persisted:false');
  });
});
