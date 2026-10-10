import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createThreadRotationService } from '../server/thread-control/thread-rotation.js';

function buildDeps({
  thread = null,
  compactResult = null,
  compactError = null,
  beginResult = null,
  applyResult = null,
} = {}) {
  const calls = { stop: [], begin: [], apply: [], fail: [], command: [], deliver: [], updateIndex: [] };

  const threadControl = {
    core: {
      findThreadByHeadSession: async () => thread,
      appendCommand: async (input) => {
        calls.command.push(input);
        return { commandId: 'cmd-1', status: 'pending' };
      },
    },
  };

  const threadIntegration = {
    beginSessionSuccession: async (input) => {
      calls.begin.push(input);
      return beginResult ?? { applied: true };
    },
    applySessionSuccession: async (input) => {
      calls.apply.push(input);
      return applyResult ?? { applied: true };
    },
    failSessionSuccession: async (input) => { calls.fail.push(input); return { applied: true }; },
    tryDeliver: async (threadId) => { calls.deliver.push(threadId); return { attempted: 1, delivered: 1 }; },
  };

  const service = createThreadRotationService({
    sessionApi: {
      updateSessionIndex: async (agentId, mutator) => {
        calls.updateIndex.push(agentId);
        return mutator({ sessions: [] });
      },
      compactAndResumeCurrentSession: async () => {
        if (compactError) throw compactError;
        return compactResult ?? { session: { id: 'session-next' } };
      },
    },
    stopManagedAgent: async (agentId, sessionId) => { calls.stop.push({ agentId, sessionId }); },
    threadIntegration,
    threadControl,
  });

  return { service, calls };
}

describe('thread rotation (context guard relay)', () => {
  it('no-ops for pure session environments (blocked session has no thread)', async () => {
    const { service, calls } = buildDeps();
    const result = await service.handleContextGuard('programming-helper', 'session-1');
    assert.equal(result, null);
    assert.equal(calls.begin.length, 0);
  });

  it('no-ops when the blocked session has no thread', async () => {
    const { service, calls } = buildDeps({ thread: null });
    const result = await service.handleContextGuard('coder', 'session-1');
    assert.equal(result, null);
    assert.equal(calls.begin.length, 0);
  });

  it('rotates a thread-head session regardless of host workspace whitelist', async () => {
    // 判定基准是会话的线程归属，不是 agentId 白名单：任何工作空间的会话
    // 只要是活跃线程的 head，guard 触发即接力（白名单只管线程环境的创建）。
    const { service, calls } = buildDeps({
      thread: { threadId: 'wt-1', status: 'running', headSessionId: 'session-1' },
    });

    const result = await service.handleContextGuard('programming-helper', 'session-1');

    assert.deepEqual(result, { applied: true, threadId: 'wt-1', headSessionId: 'session-next' });
    assert.equal(calls.begin.length, 1);
    assert.equal(calls.apply.length, 1);
    assert.equal(calls.fail.length, 0);
  });

  it('runs the full succession pipeline for a blocked head session', async () => {
    const { service, calls } = buildDeps({
      thread: { threadId: 'wt-1', status: 'running', headSessionId: 'session-1' },
    });

    const result = await service.handleContextGuard('coder', 'session-1');

    assert.deepEqual(result, { applied: true, threadId: 'wt-1', headSessionId: 'session-next' });
    assert.deepEqual(calls.begin, [{ agentId: 'coder', sessionId: 'session-1', reason: 'trim' }]);
    // pre-rotation retire happens exactly once on success
    assert.equal(calls.stop.length, 1);
    assert.deepEqual(calls.apply, [{
      agentId: 'coder', fromSessionId: 'session-1', toSessionId: 'session-next', reason: 'trim',
    }]);
    // R3：恢复指令随 begin 挡板由框架原子播种（source=thread-succession），
    // rotation 不再在 apply 后手动追加。
    assert.equal(calls.command.length, 0);
    assert.deepEqual(calls.deliver, ['wt-1']);
    assert.equal(calls.fail.length, 0);
  });

  it('aborts with zero side effects when the begin gate rejects the succession', async () => {
    // K11/A9：挡板未立（closed/held/在办移交/head 换代/存储失败）时，
    // 本流程零副作用退出——不退役 runtime（归在办移交或归档事务属主）、
    // 不写 rotation_failed（K3 守卫语义在宿主侧的消费面）。
    const { service, calls } = buildDeps({
      thread: { threadId: 'wt-1', status: 'running', headSessionId: 'session-1' },
      beginResult: { applied: false, reason: 'error', error: 'thread held (administrative freeze)' },
    });

    const result = await service.handleContextGuard('coder', 'session-1');

    assert.equal(result.applied, false);
    assert.equal(result.reason, 'begin_rejected');
    assert.equal(result.error, 'thread held (administrative freeze)');
    assert.equal(calls.stop.length, 0);
    assert.equal(calls.fail.length, 0);
    assert.equal(calls.command.length, 0);
    assert.equal(calls.deliver.length, 0);
  });

  it('retires the runtime and reports failure when apply reports failure', async () => {
    // apply 的 applied:false（advanceHead 失败 / head 已被并发推进）已由
    // integration 侧落 rotation_failed；rotation 只退役旧 runtime（触发器
    // 已消耗）并如实上报，不重复写失败记录。
    const { service, calls } = buildDeps({
      thread: { threadId: 'wt-1', status: 'running', headSessionId: 'session-1' },
      applyResult: { applied: false, reason: 'handoff_failed', error: 'head_mismatch' },
    });

    const result = await service.handleContextGuard('coder', 'session-1');

    assert.equal(result.applied, false);
    assert.equal(result.error, 'head_mismatch');
    assert.equal(calls.stop.length, 2);
    assert.equal(calls.fail.length, 0);
    assert.equal(calls.command.length, 0);
    assert.equal(calls.deliver.length, 0);
  });

  it('marks rotation_failed and retires the runtime when compaction fails', async () => {
    const { service, calls } = buildDeps({
      thread: { threadId: 'wt-1', status: 'running', headSessionId: 'session-1' },
      compactError: new Error('mirror timeout'),
    });

    const result = await service.handleContextGuard('coder', 'session-1');

    assert.equal(result.applied, false);
    assert.equal(result.error, 'mirror timeout');
    // retire once before compaction, once more in the failure path
    assert.equal(calls.stop.length, 2);
    assert.equal(calls.fail.length, 1);
    assert.equal(calls.fail[0].reason, 'context_rotation_failed');
    assert.equal(calls.fail[0].stage, 'compact_or_successor');
    assert.equal(calls.command.length, 0);
    assert.equal(calls.deliver.length, 0);
  });

  it('deduplicates concurrent guard events for the same session', async () => {
    let releaseCompact;
    const gate = new Promise((resolve) => { releaseCompact = resolve; });

    const threadControl = {
      core: {
        findThreadByHeadSession: async () => ({ threadId: 'wt-1', status: 'running', headSessionId: 'session-1' }),
        appendCommand: async () => ({}),
      },
    };
    const beginCalls = [];
    const service = createThreadRotationService({
      sessionApi: {
        updateSessionIndex: async () => ({}),
        compactAndResumeCurrentSession: async () => {
          await gate;
          return { session: { id: 'session-next' } };
        },
      },
      stopManagedAgent: async () => {},
      threadIntegration: {
        beginSessionSuccession: async (input) => { beginCalls.push(input); return { applied: true }; },
        applySessionSuccession: async () => ({ applied: true }),
        failSessionSuccession: async () => ({ applied: true }),
        tryDeliver: async () => ({}),
      },
      threadControl,
    });

    const first = service.handleContextGuard('coder', 'session-1');
    const second = service.handleContextGuard('coder', 'session-1');
    releaseCompact();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.deepEqual(firstResult, secondResult);
    assert.equal(beginCalls.length, 1);
  });
});
