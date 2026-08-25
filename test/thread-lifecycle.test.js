/**
 * Thread Lifecycle — 归档 / 恢复 编排测试（node:test）
 *
 * T004 后归档是取消性生命周期操作：seal 事务（hold + 取消 pending +
 * 收敛交接挡板，同一 store 事务原子完成）→ 停止 session runtime
 * （graceful，不预先 interrupt）→ 收尾 Board → cleanup complete/partial。
 * 恢复只恢复可调度资格，不复活 cancelled、不启动 runtime。
 *
 * 用真实 createThreadControl（真实 WorkThread + ThreadStore + Board）+
 * 注入 bridge / stopSession / interrupt，保证 seal 事务的原子性与并发
 * 行为来自真实落盘，而非桩。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkThreadRuntimeBridge } from '@agentdev/core';
import { createThreadControl } from '../server/thread-control/thread-controller.js';
import { createThreadIntegration } from '../server/thread-control/thread-integration.js';
import { createThreadLifecycleService } from '../server/thread-control/thread-lifecycle.js';
import { ThreadCommandStatus } from '../server/thread-control/thread-inbox.js';

let base = null;
let counter = 0;

function makeIdentitySource() {
  const sessions = new Map();
  return {
    register(sessionId, identity) { sessions.set(sessionId, identity); },
    identitySource: async (_agentId, sessionId) => {
      const id = String(sessionId || '').trim();
      if (!id) return null;
      const identity = sessions.get(id);
      return identity === undefined ? null : identity;
    },
  };
}

function makeEnvironment(bridgeOptions = {}) {
  const identity = makeIdentitySource();
  const stopped = [];
  const root = path.join(base, `lc-${++counter}`);
  const control = createThreadControl({
    rootDir: root,
    bridge: new WorkThreadRuntimeBridge(bridgeOptions),
    identitySource: identity.identitySource,
  });
  const integration = createThreadIntegration({ control });
  const service = createThreadLifecycleService({
    control,
    stopSession: async (agentId, sessionId) => {
      stopped.push({ agentId, sessionId });
      return { status: 'stopped' };
    },
  });
  return { identity, control, core: control.core, board: control.board, archive: control.archive, integration, service, stopped };
}

async function startCoderThread(env, rootSessionId = 's1') {
  env.identity.register(rootSessionId, 'coder');
  return env.core.start({ sessionRef: { agentId: 'programming-helper', sessionId: rootSessionId } });
}

before(async () => { base = mkdtempSync(path.join(os.tmpdir(), 'claw-lifecycle-t004-')); });
after(async () => { if (base) await fs.rm(base, { recursive: true, force: true }); });

describe('ThreadLifecycle archive (T004 cancellation semantics)', () => {
  it('seals atomically: hold + cancel pending + converge handoff in one store write', async () => {
    const env = makeEnvironment();
    const thread = await startCoderThread(env, 's1');
    // 交接进行中（pendingSuccession fresh）+ 一条 pending + 一条已下沉 in_flight
    await env.core.beginSessionHandoff({ threadId: thread.threadId, fromSessionId: 's1', reason: 'trim' });
    const { command } = await env.core.appendCommand({ threadId: thread.threadId, text: 'pending work', source: 'ui' });
    // 模拟一条已开始（in_flight）的调用：经 store 直接置位（框架 deliver 才置 delivered，
    // 这里直接构造 in_flight 事实以断言「已开始调用不被取消」）。
    await env.core.store.update(thread.threadId, (draft) => {
      draft.commands.push({
        commandId: 'cmd-inflight', threadId: thread.threadId, kind: 'user_message',
        text: 'started call', source: 'ui', idempotencyKey: '', status: 'in_flight',
        attempts: 1, envelopeId: null, lastReason: null,
        createdAt: Date.now(), updatedAt: Date.now(), deliveredAt: null,
      });
      return draft;
    });

    const result = await env.service.archiveThread(thread.threadId, { reason: 'user_archive' });

    assert.equal(result.cleanup.status, 'complete');
    assert.equal(result.cleanup.commandsCancelled, 1);
    // 已开始调用进入 inflight drain 清单，不被取消
    assert.equal(result.cleanup.inflightDrain.count, 1);
    assert.deepEqual(result.cleanup.inflightDrain.commandIds, ['cmd-inflight']);
    assert.equal(result.cleanup.handoffConverged, true);
    // 不强制中断：无 interrupt 调用（graceful stop）
    assert.equal(env.stopped.length, 1);

    const record = await env.core.getThread(thread.threadId);
    assert.equal(record.hold, true);
    assert.equal(record.pendingSuccession, null);
    assert.equal(record.status, 'open');
    const byId = Object.fromEntries(record.commands.map((c) => [c.commandId, c]));
    assert.equal(byId[command.commandId].status, ThreadCommandStatus.CANCELLED);
    assert.equal(byId[command.commandId].lastReason, 'user_archive');
    assert.ok(byId[command.commandId].updatedAt);
    assert.equal(byId['cmd-inflight'].status, 'in_flight');
  });

  it('records partial cleanup when one runtime cannot be stopped', async () => {
    const env = makeEnvironment();
    const service = createThreadLifecycleService({
      control: env.control,
      stopSession: async (_agentId, sessionId) => {
        if (sessionId === 's1') throw new Error('stop timeout');
        return { status: 'stopped' };
      },
    });
    const thread = await startCoderThread(env, 's1');

    const result = await service.archiveThread(thread.threadId);

    assert.equal(result.cleanup.status, 'partial');
    assert.deepEqual(result.cleanup.failures, [
      { stage: 'stop_runtime', sessionId: 's1', error: 'stop timeout' },
    ]);
  });

  it('cancels pending commands even if appended concurrently before the seal', async () => {
    const env = makeEnvironment();
    const thread = await startCoderThread(env, 's1');
    // 归档与追加并发：归档尚未 seal，另一路径 append 一条 pending。
    const appendPromise = env.core.appendCommand({ threadId: thread.threadId, text: 'raced', source: 'ui' });
    const archivePromise = env.service.archiveThread(thread.threadId);
    const [archiveResult, appendResult] = await Promise.all([archivePromise, appendPromise]);

    // 无论落盘先后，seal 事务遍历的是最新 draft：raced 命令最终不是 pending 可投递态。
    // seal 若先落 → raced 保持 pending 但 hold 挡投递；seal 若后落 → raced 被 cancel。
    const record = await env.core.getThread(thread.threadId);
    assert.equal(record.hold, true);
    const raced = record.commands.find((c) => c.commandId === appendResult.command.commandId);
    assert.ok(raced);
    const deliver = await env.core.deliverPendingCommands(thread.threadId);
    assert.equal(deliver.delivered, 0);
    assert.equal(deliver.reason, 'thread_held');
    assert.ok(
      raced.status === ThreadCommandStatus.CANCELLED || raced.status === ThreadCommandStatus.PENDING,
      `raced command must be cancelled or held-pending, got ${raced.status}`,
    );
    assert.equal(archiveResult.cleanup.status, 'complete');
  });

  it('unarchive restores schedulability without reviving cancelled commands or starting a runtime', async () => {
    const env = makeEnvironment();
    const thread = await startCoderThread(env, 's1');
    await env.core.appendCommand({ threadId: thread.threadId, text: 'to cancel', source: 'ui' });
    await env.service.archiveThread(thread.threadId);
    await env.board.closeBoard(thread.threadId, { reason: 'x' });

    const result = await env.service.unarchiveThread(thread.threadId);

    assert.equal(result.runtimeStarted, false);
    const record = await env.core.getThread(thread.threadId);
    assert.equal(record.hold, false);
    assert.equal(record.commands[0].status, ThreadCommandStatus.CANCELLED);
    // 看板被重开（closed → idle）
    const boardState = await env.board.getState(thread.threadId);
    assert.equal(boardState.status, 'idle');
    // 取消归档后新命令可正常投递（需 runtime 就绪），但旧 cancelled 不复活
    const fresh = await env.core.appendCommand({ threadId: thread.threadId, text: 'new work', source: 'ui' });
    assert.equal(fresh.command.status, ThreadCommandStatus.PENDING);
  });

  it('leaves main (non-thread) sessions to independent session semantics', async () => {
    // 独立 session（非线程宿主）不经过线程归档：findThreadBySession 无命中，
    // 线程层不产生归档标记 / 不触碰该 session。
    const env = makeEnvironment();
    await startCoderThread(env, 's1');
    const found = await env.service.findThreadBySession('programming-helper', 'not-a-member');
    assert.equal(found, null);
    assert.equal(await env.archive.isArchived('not-a-member'), false);
  });
});
