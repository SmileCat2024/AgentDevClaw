/**
 * 工作线程（thread-control）测试 — 框架 WorkThread + WorkThreadBoard 装配（ticket 008）
 *
 * 覆盖：
 * - ThreadStore 薄壳：持久化、revision 自增、乐观并发、串行锁、无变更跳写、
 *   历史状态词汇读时归一（古老空间 + 切换前 Claw 词汇）
 * - 装配（core=WorkThread）：创建、幂等指令、head 推进事务、取消语义
 * - 看板（board=WorkThreadBoard）：turn 事件流状态机、resume、executionEvents
 * - WorkThreadRuntimeBridge：休眠默认、启用后 user-turn 投递、runtime 未就绪重试
 * - ThreadIntegration：coder 宿主建线程（含 branch）/ 接力推进 / 删除善后，
 *   非宿主 no-op
 * - InputGateway：交接窗口转 Thread Inbox、纯图片显式拒绝、
 *   append 后竞态闭合补投递
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkThreadRuntimeBridge, WorkThreadNotFoundError } from '@agentdevjs/core';
import {
  ThreadStore,
  ThreadNotFoundError,
  ThreadRevisionConflictError,
} from '../server/thread-control/thread-store.js';
import { createThreadControl, bridgeParamsToSubmitTurnArgs } from '../server/thread-control/thread-controller.js';
import {
  createThreadIntegration,
  isThreadHostSession,
  isSuccessionGateFailure,
} from '../server/thread-control/thread-integration.js';
import { registerThreadHostAgents } from '../server/thread-control/host-agents.js';
// 宿主集合声明化（ADR-0024 可拔插）：生产由 server 启动时按 metadata
// threadHost 声明注册；测试注册 ['coder'] 模拟该事实，保持既有断言语义。
registerThreadHostAgents(['coder']);
import { deliverUserInput } from '../server/thread-control/input-gateway.js';
import { managedAgents } from '../server/shared/agent-access.js';
import {
  pendingCommands,
  appendCommand,
  pruneCommands,
  WorkThreadCommandStatus as ThreadCommandStatus,
} from '@agentdevjs/core';
import { UserTurnDeliveryError, submitUserTurn } from '../server/shared/user-turn.js';

function makeTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'claw-thread-test-'));
}

function makeControl(root, bridgeOptions = {}, sub = `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`) {
  // 每个 control 独立子目录：线程成员全库唯一（T001 成员不变量）意味着
  // 跨 control 复用 session id 会被成员守卫拦截，子目录隔离保证各用例的
  // 数据互不干扰。
  return createThreadControl({
    rootDir: path.join(root, sub),
    bridge: new WorkThreadRuntimeBridge(bridgeOptions),
  });
}

test('production assembly (no injected bridge) constructs without reference errors', async () => {
  // thread-control 测试全部注入 bridge stub，曾让生产装配路径里的
  // 未定义标识符（resolveRuntimeViewerId 重命名漏改）溜过全量回归。
  // 这里走真实装配：createThreadControl 不带 bridge。
  const root = await makeTempRoot();
  try {
    const control = createThreadControl({ rootDir: root });
    assert.equal(typeof control.resolveSessionViewerId, 'function');
    assert.equal(typeof control.archive.isArchived, 'function');
    assert.equal(control.resolveSessionViewerId('no-such-agent', 'no-such-session'), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('ThreadStore (framework WorkThreadStore + Claw legacy shell)', () => {
  let root;
  before(async () => {
    root = await makeTempRoot();
  });
  after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('create / get / list roundtrip with index summary', async () => {
    const store = new ThreadStore({ rootDir: root });
    const record = {
      threadId: 'wt-test-alpha',
      agentId: 'programming-helper',
      workspaceId: 'programming-helper',
      title: 'demo',
      status: 'open',
      rootSessionId: 'sess-1',
      headSessionId: 'sess-1',
      sessionChain: [
        { sessionId: 'sess-1', role: 'head', startedAt: 1, endedAt: null, endKind: null, successorSessionId: null },
      ],
      commands: [],
      hold: false,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    await store.create(record);

    const loaded = await store.get('wt-test-alpha');
    assert.equal(loaded.headSessionId, 'sess-1');

    const list = await store.list();
    const entry = list.find((t) => t.threadId === 'wt-test-alpha');
    assert.ok(entry, 'index entry exists');
    assert.deepEqual(entry.sessionIds, ['sess-1']);
    assert.equal(entry.headSessionId, 'sess-1');
    // root 棒无接力边
    assert.deepEqual(entry.chainEdges, []);
  });

  test('index summary exposes relay edges for non-root legs', async () => {
    const store = new ThreadStore({ rootDir: root });
    const record = {
      threadId: 'wt-relay',
      agentId: 'coder',
      workspaceId: 'coder',
      title: '',
      status: 'open',
      rootSessionId: 's1',
      headSessionId: 's3',
      sessionChain: [
        { sessionId: 's1', role: 'predecessor', startedAt: 1, endedAt: 2, endKind: 'trim', successorSessionId: 's2' },
        { sessionId: 's2', role: 'predecessor', startedAt: 2, endedAt: 3, endKind: 'summary', successorSessionId: 's3' },
        { sessionId: 's3', role: 'head', startedAt: 3, endedAt: null, endKind: null, successorSessionId: null },
      ],
      commands: [],
      hold: false,
      revision: 3,
      createdAt: 1,
      updatedAt: 3,
    };
    await store.create(record);

    const list = await store.list();
    const entry = list.find((t) => t.threadId === 'wt-relay');
    assert.ok(entry, 'index entry exists');
    // 非 root 棒各带来源与方式（前端接力分隔条数据源）
    assert.deepEqual(entry.chainEdges, [
      { sessionId: 's2', fromSessionId: 's1', relayKind: 'trim' },
      { sessionId: 's3', fromSessionId: 's2', relayKind: 'summary' },
    ]);
  });

  test('update bumps revision and persists mutation', async () => {
    const store = new ThreadStore({ rootDir: root });
    const record = {
      threadId: 'wt-rev',
      agentId: 'a',
      workspaceId: 'a',
      title: '',
      status: 'open',
      rootSessionId: 's1',
      headSessionId: 's1',
      sessionChain: [{ sessionId: 's1', role: 'head', startedAt: 1, endedAt: null, endKind: null, successorSessionId: null }],
      commands: [],
      hold: false,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    await store.create(record);

    const { record: updated, changed } = await store.update('wt-rev', (draft) => {
      draft.title = 'renamed';
      return draft;
    });
    assert.equal(changed, true);
    assert.equal(updated.revision, 2);

    const reloaded = await store.get('wt-rev');
    assert.equal(reloaded.title, 'renamed');
    assert.equal(reloaded.revision, 2);
  });

  test('no-op mutation is skipped (changed: false, revision unchanged)', async () => {
    const store = new ThreadStore({ rootDir: root });
    const before = await store.get('wt-rev');
    const { record, changed } = await store.update('wt-rev', (draft) => draft);
    assert.equal(changed, false);
    assert.equal(record.revision, before.revision);
  });

  test('expectedRevision mismatch raises conflict', async () => {
    const store = new ThreadStore({ rootDir: root });
    await assert.rejects(
      () => store.update('wt-rev', (draft) => draft, { expectedRevision: 999 }),
      ThreadRevisionConflictError,
    );
  });

  test('missing thread raises ThreadNotFoundError', async () => {
    const store = new ThreadStore({ rootDir: root });
    await assert.rejects(() => store.update('wt-missing', (d) => d), ThreadNotFoundError);
  });

  test('concurrent updates serialize without lost writes', async () => {
    const store = new ThreadStore({ rootDir: root });
    const record = {
      threadId: 'wt-conc',
      agentId: 'a',
      workspaceId: 'a',
      title: '',
      status: 'open',
      rootSessionId: 's1',
      headSessionId: 's1',
      sessionChain: [{ sessionId: 's1', role: 'head', startedAt: 1, endedAt: null, endKind: null, successorSessionId: null }],
      commands: [],
      hold: false,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    await store.create(record);

    await Promise.all([
      store.update('wt-conc', (d) => { d.title = 'first'; return d; }),
      store.update('wt-conc', (d) => { d.hold = true; return d; }),
    ]);

    const final = await store.get('wt-conc');
    assert.equal(final.revision, 3);
    // 两次串行写都不丢失
    assert.equal(final.title, 'first');
    assert.equal(final.hold, true);
  });

  test('legacy thread statuses are normalized on read and on create', async () => {
    const store = new ThreadStore({ rootDir: root });
    const base = {
      agentId: 'a',
      workspaceId: 'a',
      title: '',
      rootSessionId: 's1',
      headSessionId: 's1',
      sessionChain: [{ sessionId: 's1', role: 'head', startedAt: 1, endedAt: null, endKind: null, successorSessionId: null }],
      commands: [],
      hold: false,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    };

    // 盘上旧值读时归一，不允许半僵尸态流入控制器：
    // 古老状态空间由框架 LEGACY_STATUS_MAP 归一；
    // 切换前 Claw 自持状态机词汇（idle/running/waiting_input/failed）
    // 由本壳归一到锚点域 open（ticket 008，历史线程原地兼容）。
    const cases = [
      ['wt-legacy-active', 'active', 'open'],
      ['wt-legacy-completed', 'completed', 'closed'],
      ['wt-legacy-cancelled', 'cancelled', 'closed'],
      ['wt-legacy-blocked', 'blocked', 'open'],
      ['wt-legacy-idle', 'idle', 'open'],
      ['wt-legacy-running', 'running', 'open'],
      ['wt-legacy-waiting', 'waiting_input', 'open'],
      ['wt-legacy-failed', 'failed', 'open'],
    ];
    for (const [threadId, written, expected] of cases) {
      await fs.mkdir(path.join(root, 'threads'), { recursive: true });
      await fs.writeFile(
        path.join(root, 'threads', `${threadId}.json`),
        JSON.stringify({ ...base, threadId, status: written }),
        'utf8',
      );
      assert.equal((await store.get(threadId)).status, expected);
    }

    // create 入口同样归一：旧值不落新盘、不进 index
    await store.create({ ...base, threadId: 'wt-create-legacy', status: 'active' });
    const created = await store.get('wt-create-legacy');
    assert.equal(created.status, 'open');
    const indexEntry = (await store.list()).find((t) => t.threadId === 'wt-create-legacy');
    assert.equal(indexEntry.status, 'open');
  });
});

describe('thread control assembly (core = WorkThread)', () => {
  let root;
  before(async () => {
    root = await makeTempRoot();
  });
  after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('core.start seeds root/head and chain', async () => {
    const { core } = makeControl(root);
    const thread = await core.start({
      sessionRef: { agentId: 'programming-helper', sessionId: 'sess-a' },
      title: '修复登录',
    });
    assert.match(thread.threadId, /^wt-/);
    assert.equal(thread.headSessionId, 'sess-a');
    assert.equal(thread.rootSessionId, 'sess-a');
    assert.equal(thread.sessionChain.length, 1);
    assert.equal(thread.sessionChain[0].role, 'head');
    assert.equal(thread.status, 'open');
    assert.equal(thread.hold, false);
  });

  test('core.start rejects invalid identifiers', async () => {
    const { core } = makeControl(root);
    await assert.rejects(() => core.start({ sessionRef: { agentId: '', sessionId: 's' } }));
    await assert.rejects(() => core.start({ sessionRef: { agentId: 'a', sessionId: 'bad id with spaces' } }));
  });

  test('appendCommand is idempotent by idempotencyKey', async () => {
    const { core } = makeControl(root);
    const thread = await core.start({ sessionRef: { agentId: 'a', sessionId: 's1' } });

    const first = await core.appendCommand({
      threadId: thread.threadId,
      text: '请继续',
      idempotencyKey: 'ui-1',
    });
    const second = await core.appendCommand({
      threadId: thread.threadId,
      text: '请继续',
      idempotencyKey: 'ui-1',
    });

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(first.command.commandId, second.command.commandId);

    const record = await core.getThread(thread.threadId);
    assert.equal(record.commands.length, 1);
  });

  test('appendCommand rejects empty text and unknown thread', async () => {
    const { core } = makeControl(root);
    const thread = await core.start({ sessionRef: { agentId: 'a', sessionId: 's1' } });
    await assert.rejects(() => core.appendCommand({ threadId: thread.threadId, text: '   ' }));
    await assert.rejects(
      () => core.appendCommand({ threadId: 'wt-none', text: 'x' }),
      WorkThreadNotFoundError,
    );
  });

  test('advanceHead closes old chain entry and moves head atomically', async () => {
    const { core } = makeControl(root);
    const thread = await core.start({ sessionRef: { agentId: 'a', sessionId: 's1' } });

    const advanced = await core.advanceHead({
      threadId: thread.threadId,
      toSessionId: 's2',
      fromSessionId: 's1',
      expectedRevision: thread.revision,
      endKind: 'context_rotation',
    });

    assert.equal(advanced.headSessionId, 's2');
    assert.equal(advanced.sessionChain.length, 2);
    const oldHead = advanced.sessionChain[0];
    assert.equal(oldHead.role, 'predecessor');
    assert.equal(oldHead.endKind, 'context_rotation');
    assert.equal(oldHead.successorSessionId, 's2');
    assert.equal(advanced.sessionChain[1].role, 'head');
  });

  test('advanceHead guards: stale revision / wrong from / duplicate target / closed', async () => {
    const { core } = makeControl(root);
    const thread = await core.start({ sessionRef: { agentId: 'a', sessionId: 's1' } });

    // K23：fromSessionId 必填——不携带来源指认的推进直接 400
    await assert.rejects(
      () => core.advanceHead({ threadId: thread.threadId, toSessionId: 's2' }),
      (err) => err.code === 'invalid_request',
    );
    await assert.rejects(
      () => core.advanceHead({ threadId: thread.threadId, toSessionId: 's2', fromSessionId: 's1', expectedRevision: 999 }),
      ThreadRevisionConflictError,
    );
    await assert.rejects(
      () => core.advanceHead({ threadId: thread.threadId, toSessionId: 's2', fromSessionId: 'wrong' }),
      (err) => err.code === 'head_mismatch',
    );

    const advanced = await core.advanceHead({ threadId: thread.threadId, toSessionId: 's2', fromSessionId: 's1' });
    await assert.rejects(
      () => core.advanceHead({ threadId: thread.threadId, toSessionId: 's2', fromSessionId: 's2' }),
      (err) => err.code === 'already_head',
    );
    await assert.rejects(
      () => core.advanceHead({ threadId: thread.threadId, toSessionId: 's1', fromSessionId: 's2' }),
      (err) => err.code === 'duplicate_session',
    );

    await core.closeThread(thread.threadId);
    await assert.rejects(
      () => core.advanceHead({ threadId: thread.threadId, toSessionId: 's3', fromSessionId: 's2' }),
      (err) => err.code === 'thread_closed',
    );
    assert.equal(advanced.status, 'open'); // close 前的返回值不受影响
  });

  test('closeThread closes and cancels pending commands', async () => {
    const { core } = makeControl(root);
    const thread = await core.start({ sessionRef: { agentId: 'a', sessionId: 's1' } });
    await core.appendCommand({ threadId: thread.threadId, text: 'x', idempotencyKey: 'k1' });

    const closed = await core.closeThread(thread.threadId, { reason: 'user' });
    assert.equal(closed.status, 'closed');
    assert.equal(closed.commands[0].status, ThreadCommandStatus.CANCELLED);
  });

  test('cancelCommand only affects pending', async () => {
    const { core } = makeControl(root);
    const thread = await core.start({ sessionRef: { agentId: 'a', sessionId: 's1' } });
    const { command } = await core.appendCommand({ threadId: thread.threadId, text: 'x' });

    await core.cancelCommand(thread.threadId, command.commandId);
    await core.cancelCommand(thread.threadId, command.commandId); // 二次取消幂等

    const record = await core.getThread(thread.threadId);
    assert.equal(record.commands[0].status, ThreadCommandStatus.CANCELLED);
  });

  test('deliverPendingCommands with dormant bridge keeps commands pending', async () => {
    const { core } = makeControl(root); // bridge enabled=false
    const thread = await core.start({ sessionRef: { agentId: 'a', sessionId: 's1' } });
    await core.appendCommand({ threadId: thread.threadId, text: '请继续' });

    const result = await core.deliverPendingCommands(thread.threadId);
    assert.equal(result.reason, 'bridge_disabled');
    assert.equal(result.delivered, 0);

    const record = await core.getThread(thread.threadId);
    assert.equal(record.commands[0].status, ThreadCommandStatus.PENDING);
  });
});

describe('board (WorkThreadBoard 执行看板)', () => {
  let root;
  before(async () => { root = await makeTempRoot(); });
  after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  test('recordRuntimeEvent drives idle/running/failed from the session turn stream', async () => {
    const { core, board } = makeControl(root);
    const thread = await core.start({ sessionRef: { agentId: 'event-agent', sessionId: 'event-session' } });

    const started = await board.recordRuntimeEvent({
      agentId: 'event-agent',
      sessionId: 'event-session',
      runtimeInstanceId: 'runtime-1',
      event: { type: 'turn.started', turn: 1 },
    });
    assert.equal(started.applied, true);
    assert.equal(started.state.status, 'running');

    const completed = await board.recordRuntimeEvent({
      agentId: 'event-agent',
      sessionId: 'event-session',
      runtimeInstanceId: 'runtime-1',
      event: { type: 'turn.completed', turn: 1, usage: { inputTokens: 2, outputTokens: 3 } },
    });
    assert.equal(completed.state.status, 'idle');
    assert.equal(completed.state.lastLifecycleEvent.type, 'turn.completed');

    const failed = await board.recordRuntimeEvent({
      agentId: 'event-agent',
      sessionId: 'event-session',
      runtimeInstanceId: 'runtime-1',
      event: { type: 'turn.failed', turn: 2, error: { message: 'API unavailable', retryable: true } },
    });
    assert.equal(failed.state.status, 'failed');
    assert.equal(failed.state.lastLifecycleEvent.error.message, 'API unavailable');
    assert.equal((await board.getState(thread.threadId)).status, 'failed');
  });

  test('turn.cancelled converges board to idle (deliberate stop semantics), never failed', async () => {
    const { core, board } = makeControl(root);
    const cancelThread = await core.start({ sessionRef: { agentId: 'cancel-agent', sessionId: 'cancel-session' } });
    await board.recordRuntimeEvent({
      agentId: 'cancel-agent',
      sessionId: 'cancel-session',
      runtimeInstanceId: 'runtime-1',
      event: { type: 'turn.started', turn: 1 },
    });

    // guard 轮换打断：cancelled 不得把看板打成 failed（轮换由 context_guard_event 驱动）；
    // F1 语义：手动中断/生命周期打断把看板收敛为 idle，与意外中断（running 残留）区分。
    const cancelled = await board.recordRuntimeEvent({
      agentId: 'cancel-agent',
      sessionId: 'cancel-session',
      runtimeInstanceId: 'runtime-1',
      event: { type: 'turn.cancelled', turn: 1, error: { message: 'Session blocked by the context guard', reason: 'cancelled' } },
    });
    assert.equal(cancelled.applied, true);
    assert.equal(cancelled.state.status, 'idle');

    const { events: storedEvents } = await board.getExecutionEvents(cancelThread.threadId);
    const recorded = storedEvents.some((event) => event.type === 'turn.cancelled');
    assert.equal(recorded, true);

    // 轮换接续：head 推进到 successor，新 turn 自然完成，看板回 idle
    await core.advanceHead({
      threadId: cancelThread.threadId,
      toSessionId: 'cancel-session-2',
      fromSessionId: 'cancel-session',
      expectedRevision: (await core.getThread(cancelThread.threadId)).revision,
      endKind: 'context_rotation',
    });
    await board.recordRuntimeEvent({
      agentId: 'cancel-agent',
      sessionId: 'cancel-session-2',
      runtimeInstanceId: 'runtime-2',
      event: { type: 'turn.started', turn: 2 },
    });
    const resumed = await board.recordRuntimeEvent({
      agentId: 'cancel-agent',
      sessionId: 'cancel-session-2',
      runtimeInstanceId: 'runtime-2',
      event: { type: 'turn.completed', turn: 2 },
    });
    assert.equal(resumed.state.status, 'idle');
  });

  test('recordRuntimeEvent ignores unsupported events and sessions outside a thread', async () => {
    const { core, board } = makeControl(root);
    await core.start({ sessionRef: { agentId: 'event-agent-2', sessionId: 'event-session-2' } });
    assert.deepEqual(
      await board.recordRuntimeEvent({
        agentId: 'other-agent',
        sessionId: 'unknown-session',
        event: { type: 'turn.started', turn: 1 },
      }),
      { applied: false, reason: 'no_thread_for_session' },
    );
    const itemEvent = await board.recordRuntimeEvent({
      agentId: 'event-agent-2',
      sessionId: 'event-session-2',
      event: { type: 'item.completed', item: { type: 'agent_message' } },
    });
    assert.equal(itemEvent.applied, true);
    assert.equal(itemEvent.state.executionEvents.length, 1);
  });

  test('execution events: cursor slicing and eventId dedup', async () => {
    const { core, board } = makeControl(root);
    const thread = await core.start({ sessionRef: { agentId: 'a', sessionId: 'ev-s1' } });

    const emit = (event) =>
      board.recordRuntimeEvent({ agentId: 'a', sessionId: 'ev-s1', runtimeInstanceId: 'rt-1', event });
    await emit({ type: 'turn.started', turn: 1, eventId: 'e1' });
    await emit({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'hi' }, eventId: 'e2' });
    await emit({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'hi' }, eventId: 'e2' });
    await emit({ type: 'turn.completed', turn: 1, eventId: 'e3' });

    const all = await board.getExecutionEvents(thread.threadId);
    assert.equal(all.events.length, 3, '重复 eventId 必须去重');
    assert.equal(all.cursor, 3);

    const tail = await board.getExecutionEvents(thread.threadId, { after: 2 });
    assert.equal(tail.events.length, 1);
    assert.equal(tail.events[0].type, 'turn.completed');
  });

  test('resume admits failed / waiting_input and rejects non-resumable board states', async () => {
    const { core, board } = makeControl(root);

    // failed → running：经真实 turn.failed 进入后 resume
    const t1 = await core.start({ sessionRef: { agentId: 'a', sessionId: 'rs-s1' } });
    await board.recordRuntimeEvent({ agentId: 'a', sessionId: 'rs-s1', event: { type: 'turn.started', turn: 1 } });
    await board.recordRuntimeEvent({ agentId: 'a', sessionId: 'rs-s1', event: { type: 'turn.failed', turn: 1, error: { message: 'api down' } } });
    const resumed = await board.resume(t1.threadId);
    assert.equal(resumed.status, 'running');
    assert.equal(resumed.lastLifecycleEvent.type, 'resumed');

    // waiting_input → running（无事件源场景，看板手动播种后 resume）
    const t2 = await core.start({ sessionRef: { agentId: 'a', sessionId: 'rs-s2' } });
    await board.setStatus(t2.threadId, 'waiting_input');
    assert.equal((await board.resume(t2.threadId)).status, 'running');

    // idle（未观测到任何事件）/ running / closed 一律拒绝
    const t3 = await core.start({ sessionRef: { agentId: 'a', sessionId: 'rs-s3' } });
    await assert.rejects(
      () => board.resume(t3.threadId),
      (err) => err.code === 'board_not_resumable',
      'idle 不允许 resume',
    );

    const t4 = await core.start({ sessionRef: { agentId: 'a', sessionId: 'rs-s4' } });
    await board.recordRuntimeEvent({ agentId: 'a', sessionId: 'rs-s4', event: { type: 'turn.started', turn: 1 } });
    await assert.rejects(
      () => board.resume(t4.threadId),
      (err) => err.code === 'board_not_resumable',
      'running 不允许 resume',
    );

    const t5 = await core.start({ sessionRef: { agentId: 'a', sessionId: 'rs-s5' } });
    await board.closeBoard(t5.threadId);
    await assert.rejects(
      () => board.resume(t5.threadId),
      (err) => err.code === 'thread_closed',
    );
  });

  test('closed anchor is terminal: idempotent close, no events, no handoff', async () => {
    const { core, board } = makeControl(root);
    const thread = await core.start({ sessionRef: { agentId: 'a', sessionId: 'cl-s1' } });

    const first = await core.closeThread(thread.threadId, { reason: 'user' });
    assert.equal(first.status, 'closed');
    assert.equal(first.closeReason, 'user');

    const second = await core.closeThread(thread.threadId, { reason: 'again' });
    assert.equal(second.status, 'closed');
    assert.equal(second.closeReason, 'user', '重复 close 幂等，不改写首个 closeReason');

    assert.deepEqual(
      await board.recordRuntimeEvent({ agentId: 'a', sessionId: 'cl-s1', event: { type: 'turn.started', turn: 1 } }),
      { applied: false, reason: 'thread_closed' },
    );
    assert.deepEqual(
      await board.recordRuntimeEvent({ agentId: 'a', sessionId: 'cl-s1', event: { type: 'item.completed', item: { type: 'agent_message' } } }),
      { applied: false, reason: 'thread_closed' },
    );
    await assert.rejects(
      () => core.beginSessionHandoff({ threadId: thread.threadId, fromSessionId: 'cl-s1', reason: 'trim' }),
      (err) => err.code === 'thread_closed',
    );
  });
});

describe('anchor handoff orchestration (锚点接续编排)', () => {
  let root;
  before(async () => { root = await makeTempRoot(); });
  after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  test('rotation failure path: rotating → rotation_failed 保留交接意图；advanceHead 恢复 open', async () => {
    const { core } = makeControl(root);
    const thread = await core.start({ sessionRef: { agentId: 'coder', sessionId: 'rot-s1' } });

    // guard 触发交接 → rotating（含生命周期事件与交接意图 stage）
    const begun = await core.beginSessionHandoff({ threadId: thread.threadId, fromSessionId: 'rot-s1', reason: 'context_guard' });
    assert.equal(begun.status, 'rotating');
    assert.equal(begun.pendingSuccession.fromSessionId, 'rot-s1');
    assert.equal(begun.lastLifecycleEvent.type, 'handoff_started');

    // 压缩失败 → rotation_failed；pendingSuccession 保留供恢复收拾残局
    const failed = await core.failSessionHandoff(thread.threadId, {
      reason: 'compact_crashed',
      stage: 'compact_or_successor',
      error: 'mirror timeout',
    });
    assert.equal(failed.status, 'rotation_failed');
    assert.equal(failed.pendingSuccession.fromSessionId, 'rot-s1', '交接意图必须保留在盘上');
    assert.equal(failed.pendingSuccession.stage, 'compact_or_successor');
    assert.equal(failed.lastLifecycleEvent.reason, 'compact_crashed');

    // 残局收拾：宿主推进 head（清挡板）后锚点回 open、可继续投递
    const advanced = await core.advanceHead({
      threadId: thread.threadId,
      toSessionId: 'rot-s2',
      fromSessionId: 'rot-s1',
      endKind: 'manual_recovery',
    });
    assert.equal(advanced.status, 'open');
    assert.equal(advanced.pendingSuccession, null);
    assert.equal(advanced.lastLifecycleEvent.type, 'handoff_completed');
  });

  test('delivery is gated by closed / fresh handoff / hold with definite reasons', async () => {
    const { core } = makeControl(root);

    // fresh 交接 → handoff_in_progress
    const t1 = await core.start({ sessionRef: { agentId: 'a', sessionId: 'gg-s1' } });
    await core.beginSessionHandoff({ threadId: t1.threadId, fromSessionId: 'gg-s1', reason: 'trim' });
    await core.appendCommand({ threadId: t1.threadId, text: 'x' });
    const r1 = await core.deliverPendingCommands(t1.threadId);
    assert.equal(r1.delivered, 0);
    assert.equal(r1.reason, 'handoff_in_progress');
    assert.equal((await core.getThread(t1.threadId)).commands[0].status, ThreadCommandStatus.PENDING);

    // closed → thread_closed（pending 指令随关闭取消）
    const t2 = await core.start({ sessionRef: { agentId: 'a', sessionId: 'gg-s2' } });
    await core.appendCommand({ threadId: t2.threadId, text: 'x' });
    await core.closeThread(t2.threadId);
    const r2 = await core.deliverPendingCommands(t2.threadId);
    assert.equal(r2.reason, 'thread_closed');
    assert.equal((await core.getThread(t2.threadId)).commands[0].status, ThreadCommandStatus.CANCELLED);

    // hold（宿主级暂停投递开关）→ thread_held；解除后恢复
    const t3 = await core.start({ sessionRef: { agentId: 'a', sessionId: 'gg-s3' } });
    await core.appendCommand({ threadId: t3.threadId, text: 'x' });
    await core.setHold(t3.threadId, true);
    const r3 = await core.deliverPendingCommands(t3.threadId);
    assert.equal(r3.reason, 'thread_held');
    await core.setHold(t3.threadId, false);
    const r4 = await core.deliverPendingCommands(t3.threadId);
    assert.equal(r4.reason, 'bridge_disabled', 'hold 解除后投递能力恢复（此处桥休眠）');
  });

  test('stale handoff intent no longer blocks delivery (failure-path self-healing)', async () => {
    const { core } = makeControl(root, {
      enabled: true,
      resolveRuntimeViewerId: () => 'viewer-x',
      submitTurn: async ({ text }) => ({ success: true, delivery: 'delivered', text }),
    });
    const thread = await core.start({ sessionRef: { agentId: 'coder', sessionId: 'hd-stale' } });
    await core.appendCommand({ threadId: thread.threadId, text: 'later' });

    // 直接写一个 10 分钟前的交接意图（模拟 compact 崩溃后残留）
    await core.store.update(thread.threadId, (draft) => {
      draft.pendingSuccession = { fromSessionId: 'hd-stale', reason: 'trim', stage: 'started', startedAt: Date.now() - 10 * 60 * 1000 };
      return draft;
    });

    const result = await core.deliverPendingCommands(thread.threadId);
    assert.equal(result.delivered, 1);
    const record = await core.getThread(thread.threadId);
    assert.equal(record.pendingSuccession, null); // 惰性清除落盘
  });

  test('advanceHead lands on open with pendingSuccession cleared atomically', async () => {
    const { core } = makeControl(root);
    const thread = await core.start({ sessionRef: { agentId: 'a', sessionId: 'ah-s1' } });
    await core.beginSessionHandoff({ threadId: thread.threadId, fromSessionId: 'ah-s1', reason: 'context_guard' });

    const advanced = await core.advanceHead({
      threadId: thread.threadId,
      toSessionId: 'ah-s2',
      fromSessionId: 'ah-s1',
      endKind: 'trim',
    });
    assert.equal(advanced.status, 'open');
    assert.equal(advanced.pendingSuccession, null);
    assert.equal(advanced.lastLifecycleEvent.type, 'handoff_completed');
  });
});

describe('WorkThreadRuntimeBridge (enabled) + user-turn integration', () => {
  let root;
  before(async () => {
    root = await makeTempRoot();
  });
  after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('delivers pending command to head runtime via user-turn after head advance', async () => {
    const liveRuntimes = new Map(); // `${agentId}::${sessionId}` -> viewerAgentId
    const turns = [];
    const { core } = makeControl(root, {
      enabled: true,
      resolveRuntimeViewerId: (agentId, sessionId) =>
        liveRuntimes.get(`${agentId}::${sessionId}`) || null,
      submitTurn: async (params) => {
        turns.push(params);
        return { success: true };
      },
    });

    const thread = await core.start({ sessionRef: { agentId: 'agent-x', sessionId: 'old-1' } });
    const { command } = await core.appendCommand({ threadId: thread.threadId, text: '请继续', idempotencyKey: 'k1' });

    // 旧 head 无 runtime → 指令保持 pending（等待 head 推进）
    let result = await core.deliverPendingCommands(thread.threadId);
    assert.equal(result.delivered, 0);
    assert.equal(result.reason, 'runtime_not_accepting');
    let record = await core.getThread(thread.threadId);
    assert.equal(record.commands[0].status, ThreadCommandStatus.PENDING);

    // head 推进到新会话且 runtime 就绪 → user-turn 投递成功
    await core.advanceHead({ threadId: thread.threadId, toSessionId: 'head-2', fromSessionId: 'old-1' });
    liveRuntimes.set('agent-x::head-2', 'viewer-abc');
    result = await core.deliverPendingCommands(thread.threadId);
    assert.equal(result.delivered, 1);
    assert.equal(result.reason, undefined);

    assert.equal(turns.length, 1);
    assert.equal(turns[0].agentId, 'viewer-abc');
    assert.equal(turns[0].text, '请继续');
    assert.equal(turns[0].source, 'thread');
    assert.equal(turns[0].sourceRef, command.commandId);

    record = await core.getThread(thread.threadId);
    assert.equal(record.commands[0].status, ThreadCommandStatus.DELIVERED);
    assert.equal(record.commands[0].deliveryRef, 'viewer-abc');
  });

  test('non-retryable delivery failure marks command failed', async () => {
    const { core } = makeControl(root, {
      enabled: true,
      resolveRuntimeViewerId: () => 'viewer-live',
      submitTurn: async () => {
        throw new UserTurnDeliveryError('bad input', { code: 'invalid_input', status: 400, retryable: false });
      },
    });
    const thread = await core.start({ sessionRef: { agentId: 'agent-y', sessionId: 's1' } });
    await core.appendCommand({ threadId: thread.threadId, text: 'x' });

    const result = await core.deliverPendingCommands(thread.threadId);
    assert.equal(result.delivered, 0);

    const record = await core.getThread(thread.threadId);
    assert.equal(record.commands[0].status, ThreadCommandStatus.FAILED);
    assert.equal(record.commands[0].lastReason, 'invalid_input');
  });

  // 契约回归：bridge 传给 submitUserTurn 的参数名必须是 agentId。
  // 历史事故：bridge 传 viewerAgentId（被客户端忽略）→ agentId undefined →
  // 客户端预校验抛 invalid_input（不可重试）→ 接力指令全部被误判 failed。
  // 用真实 submitUserTurn + fetchImpl mock 而非哑 stub，参数漂移当场炸出。
  // 经生产适配器 bridgeParamsToSubmitTurnArgs（框架 bridge 的 metadata 键 →
  // submitUserTurn 的 turnMetadata 形参）：历史事故二——直连丢 metadata 且
  // 指令误标 DELIVERED。
  test('bridge passes contract-valid params to the real submitUserTurn client', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ success: true, delivery: 'queued' }) };
    };
    const { core } = makeControl(root, {
      enabled: true,
      resolveRuntimeViewerId: () => 'viewer-contract',
      submitTurn: (params) => submitUserTurn(bridgeParamsToSubmitTurnArgs(params), { fetchImpl }),
    });
    const thread = await core.start({ sessionRef: { agentId: 'agent-c', sessionId: 'cs-1' } });
    const metadata = { 'session-reference': [{ agentId: 'programming-helper', sessionId: 'session-r', title: '引用' }] };
    const { command } = await core.appendCommand({ threadId: thread.threadId, text: '契约校验', metadata });

    const result = await core.deliverPendingCommands(thread.threadId);
    assert.equal(result.delivered, 1);
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /\/api\/agents\/viewer-contract\/user-turn$/);
    assert.equal(seen[0].body.text, '契约校验');
    assert.equal(seen[0].body.source, 'thread');
    assert.equal(seen[0].body.sourceRef, command.commandId);
    // metadata 经适配后进入 user-turn body（P0 回归锁：键名漂移即丢字段）
    assert.deepEqual(seen[0].body.metadata, metadata);

    const record = await core.getThread(thread.threadId);
    assert.equal(record.commands[0].status, ThreadCommandStatus.DELIVERED);
  });

  // ADR-0024 决策 3：command kind 'reminder'（turn 身份槽位）经生产适配器
  // 原样进入 user-turn body——"reminder 落地为带 source 的 system 消息"的
  // Claw 侧边界即在此（system 消息渲染属 viewer 契约侧）。词汇表不同名
  //（user_message vs user），映射缺失会静默丢身份——回归锁。
  test('bridge adapter forwards the reminder turn identity into the user-turn body', async () => {
    const seen = [];
    const fetchImpl = async (_url, init) => {
      seen.push({ body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ success: true, delivery: 'queued' }) };
    };
    const { core } = makeControl(root, {
      enabled: true,
      resolveRuntimeViewerId: () => 'viewer-reminder',
      submitTurn: (params) => submitUserTurn(bridgeParamsToSubmitTurnArgs(params), { fetchImpl }),
    });
    const thread = await core.start({ sessionRef: { agentId: 'agent-r', sessionId: 'rs-1' } });
    await core.appendCommand({ threadId: thread.threadId, text: '到点提醒', kind: 'reminder' });

    const result = await core.deliverPendingCommands(thread.threadId);
    assert.equal(result.delivered, 1);
    assert.equal(seen[0].body.kind, 'reminder');
    assert.equal(seen[0].body.source, 'thread');

    // 接续恢复指令（system_continuation）同为机器通报：经适配器映射为
    // reminder 身份——落地为带 source 的 system 消息而非冒充用户发言
    await core.appendCommand({ threadId: thread.threadId, text: '上下文已精简接续……', kind: 'system_continuation' });
    await core.deliverPendingCommands(thread.threadId);
    assert.equal(seen[1].body.kind, 'reminder');

    // 存量 / 缺省指令（user_message、external 等）不携带 kind 字段：
    // user-turn 契约缺省即普通用户消息（行为与身份槽位引入前一致）
    await core.appendCommand({ threadId: thread.threadId, text: '普通指令' });
    await core.deliverPendingCommands(thread.threadId);
    assert.equal(seen[2].body.kind, undefined);
  });

  // H1 回归锁：appendCommand 允许 metadata-only 的空文本指令（' ' 占位），
  // 适配层必须把它规范化为 viewer 契约可接受的形态——入箱必可投。
  test('bridge adapter normalizes metadata-only empty-text commands to a deliverable form', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ success: true, delivery: 'queued' }) };
    };
    const { core } = makeControl(root, {
      enabled: true,
      resolveRuntimeViewerId: () => 'viewer-normalize',
      submitTurn: (params) => submitUserTurn(bridgeParamsToSubmitTurnArgs(params), { fetchImpl }),
    });
    const thread = await core.start({ sessionRef: { agentId: 'agent-n', sessionId: 'ns-1' } });
    await core.appendCommand({ threadId: thread.threadId, text: '', metadata: { 'session-reference': [{}] } });

    const result = await core.deliverPendingCommands(thread.threadId);
    assert.equal(result.delivered, 1, 'metadata-only 空文本指令必须投递成功，不得落 FAILED');
    assert.equal(seen[0].body.text, ' ');
  });
});

describe('ThreadIntegration (coder host gating)', () => {
  let root;
  before(async () => {
    root = await makeTempRoot();
  });
  after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function makeIntegration(bridgeOptions = {}) {
    const control = makeControl(
      path.join(root, `it-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
      bridgeOptions,
    );
    return { control, core: control.core, integration: createThreadIntegration({ control }) };
  }

  test('onSessionCreated creates thread for host app sessions only', async () => {
    const { integration } = makeIntegration();
    // 宿主判定是 APP 级的（ADR-0025）：coder APP 的新会话自动建线程，
    // 其余 APP 均为 no-op——会话自身字段不参与判定。
    assert.ok(isThreadHostSession('coder'));
    assert.equal(isThreadHostSession('programming-helper'), false);
    assert.equal(isThreadHostSession('agent-studio'), false);

    const coderThread = await integration.onSessionCreated('coder', { id: 'cs-1', title: '修复登录' });
    assert.ok(coderThread);
    assert.equal(coderThread.headSessionId, 'cs-1');
    assert.equal(coderThread.title, '修复登录');

    const phThread = await integration.onSessionCreated('programming-helper', { id: 'ph-1' });
    assert.equal(phThread, null);
  });

  test('applySessionSuccession advances head and delivers pending commands', async () => {
    const turns = [];
    const { core, integration } = makeIntegration({
      enabled: true,
      resolveRuntimeViewerId: (agentId, sessionId) => (sessionId === 'coder-s2' ? 'viewer-s2' : null),
      submitTurn: async (params) => {
        turns.push(params);
        return { success: true };
      },
    });

    const thread = await integration.onSessionCreated('coder', { id: 'coder-s1', title: 'T' });
    await core.appendCommand({ threadId: thread.threadId, text: '接力期间补充的指令' });

    const outcome = await integration.applySessionSuccession({
      agentId: 'coder',
      fromSessionId: 'coder-s1',
      toSessionId: 'coder-s2',
      reason: 'trim',
    });
    assert.equal(outcome.applied, true);
    assert.equal(outcome.thread.headSessionId, 'coder-s2');
    assert.equal(outcome.delivery.delivered, 1);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].text, '接力期间补充的指令');

    // 链结构：旧 head 转 predecessor，记录 endKind 与 successor
    const record = await core.getThread(thread.threadId);
    assert.equal(record.sessionChain.length, 2);
    assert.equal(record.sessionChain[0].endKind, 'trim');
    assert.equal(record.sessionChain[0].successorSessionId, 'coder-s2');
  });

  // runtime-ready 补投：succession 时刻 runtime 未就绪（runtime_not_accepting）
  // 保持 pending 的指令，在 head runtime 就绪时经 handleRuntimeReady 送达。
  test('handleRuntimeReady delivers pending commands when head runtime becomes ready', async () => {
    const turns = [];
    let ready = false;
    const { core, integration } = makeIntegration({
      enabled: true,
      // succession 时刻新 head 的 runtime 尚未就绪
      resolveRuntimeViewerId: (agentId, sessionId) =>
        (ready && sessionId === 'coder-s2' ? 'viewer-s2' : null),
      submitTurn: async (params) => {
        turns.push(params);
        return { success: true };
      },
    });

    const thread = await integration.onSessionCreated('coder', { id: 'coder-s1', title: 'T' });
    await core.appendCommand({ threadId: thread.threadId, text: '等 runtime 的指令' });

    const outcome = await integration.applySessionSuccession({
      agentId: 'coder',
      fromSessionId: 'coder-s1',
      toSessionId: 'coder-s2',
      reason: 'summary',
    });
    assert.equal(outcome.applied, true);
    assert.equal(outcome.delivery.delivered, 0);
    assert.equal(outcome.delivery.reason, 'runtime_not_accepting');
    assert.equal(turns.length, 0);

    let record = await core.getThread(thread.threadId);
    assert.equal(record.commands[0].status, ThreadCommandStatus.PENDING);

    // runtime 就绪 → 补投送达
    ready = true;
    const readyOutcome = await integration.handleRuntimeReady('coder', 'coder-s2');
    assert.equal(readyOutcome.applied, true);
    assert.equal(readyOutcome.delivery.delivered, 1);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].text, '等 runtime 的指令');

    record = await core.getThread(thread.threadId);
    assert.equal(record.commands[0].status, ThreadCommandStatus.DELIVERED);

    // 就绪会话不是任何线程 head（纯 session，含非宿主 APP）：no-op
    assert.equal((await integration.handleRuntimeReady('coder', 'x')).reason, 'no_thread_for_session');
    assert.equal((await integration.handleRuntimeReady('coder', 'coder-s1')).reason, 'no_thread_for_session');
    assert.equal((await integration.handleRuntimeReady('programming-helper', 'coder-s2')).reason, 'no_thread_for_session');
  });

  test('applySessionSuccession is no-op for non-host agents and non-head sessions', async () => {    const { core, integration } = makeIntegration();

    const phOutcome = await integration.applySessionSuccession({
      agentId: 'programming-helper',
      fromSessionId: 'a',
      toSessionId: 'b',
      reason: 'trim',
    });
    assert.equal(phOutcome.applied, false);

    await integration.onSessionCreated('coder', { id: 'c1' });
    const noThread = await integration.applySessionSuccession({
      agentId: 'coder',
      fromSessionId: 'unknown-session',
      toSessionId: 'c2',
      reason: 'trim',
    });
    assert.equal(noThread.applied, false);
    assert.equal(noThread.reason, 'no_thread_for_session');

    // head 不匹配（from 不是当前 head）时不动线程
    const thread = await core.getThread((await core.listThreads({ agentId: 'coder' }))[0].threadId);
    const stale = await integration.applySessionSuccession({
      agentId: 'coder',
      fromSessionId: 'c1',
      toSessionId: 'c1', // same session → invalid
      reason: 'trim',
    });
    assert.equal(stale.applied, false);
    assert.equal(thread.headSessionId, 'c1');
  });

  test('assertSessionDeletable rejects deleting a thread head session; no-op otherwise', async () => {
    const { core, integration } = makeIntegration();
    const thread = await integration.onSessionCreated('coder', { id: 'del-1', title: 'A' });
    await core.appendCommand({ threadId: thread.threadId, text: 'staged' });
    await core.advanceHead({ threadId: thread.threadId, toSessionId: 'del-2', fromSessionId: 'del-1', endKind: 'trim' });

    // 删除非 head 棒次：不动线程
    const nonHead = await integration.assertSessionDeletable('coder', 'del-1');
    assert.equal(nonHead.applied, false);
    assert.equal(nonHead.reason, 'no_thread_for_session');

    // 纯 session 会话（无线程，含非宿主 APP）：no-op
    const nonHost = await integration.assertSessionDeletable('programming-helper', 'not-in-any-thread');
    assert.equal(nonHost.applied, false);
    assert.equal(nonHost.reason, 'no_thread_for_session');

    // 删除 head 会明确失败，不改动线程或 pending 指令
    await assert.rejects(
      integration.assertSessionDeletable('coder', 'del-2'),
      (error) => error.code === 'thread_head_session_cannot_be_deleted'
        && error.status === 409
        && error.message.includes(thread.threadId)
        && error.message.includes('head'),
    );
    const record = await core.getThread(thread.threadId);
    assert.equal(record.status, 'open');
    assert.equal(record.headSessionId, 'del-2');
    assert.equal(record.commands[0].status, ThreadCommandStatus.PENDING);
  });
});

describe('WorkThread inbox helpers (framework @agentdevjs/core)', () => {
  test('pendingCommands sorts by createdAt then commandId', () => {
    const record = {
      commands: [
        { commandId: 'b', createdAt: 2, status: 'pending' },
        { commandId: 'a', createdAt: 1, status: 'pending' },
        { commandId: 'c', createdAt: 1, status: 'delivered' },
      ],
    };
    const pending = pendingCommands(record);
    assert.deepEqual(pending.map((c) => c.commandId), ['a', 'b']);
  });

  test('pruneCommands drops oldest terminal commands beyond retention', () => {
    const commands = [];
    for (let i = 0; i < 12; i++) {
      commands.push({
        commandId: `cmd-${i}`,
        status: ThreadCommandStatus.DELIVERED,
        createdAt: i,
        updatedAt: i,
      });
    }
    commands.push({ commandId: 'keep-me', status: ThreadCommandStatus.PENDING, createdAt: 99, updatedAt: 99 });

    const record = { commands };
    const changed = pruneCommands(record, 5);
    assert.equal(changed, true);
    assert.equal(record.commands.length, 6); // 5 terminal + 1 pending
    assert.ok(record.commands.some((c) => c.commandId === 'keep-me'));
    assert.ok(!record.commands.some((c) => c.commandId === 'cmd-0')); // 最旧被裁
  });

  test('appendCommand without idempotencyKey always appends', () => {
    const record = { commands: [] };
    const c1 = { commandId: 'c1', idempotencyKey: '', status: 'pending', createdAt: 1 };
    const c2 = { commandId: 'c2', idempotencyKey: '', status: 'pending', createdAt: 2 };
    assert.equal(appendCommand(record, c1).duplicate, false);
    assert.equal(appendCommand(record, c2).duplicate, false);
    assert.equal(record.commands.length, 2);
  });
});

describe('isSuccessionGateFailure (交接挡板失败判定)', () => {
  test('only applied=false + reason=error counts as failure', () => {
    assert.equal(isSuccessionGateFailure({ applied: false, reason: 'error', error: 'disk full' }), true);
    // 合法 no-op 不是失败
    assert.equal(isSuccessionGateFailure({ applied: false, reason: 'no_thread_for_session' }), false);
    assert.equal(isSuccessionGateFailure({ applied: false, reason: 'invalid_session' }), false);
    assert.equal(isSuccessionGateFailure({ applied: true, threadId: 't1' }), false);
    // 异常形态防御
    assert.equal(isSuccessionGateFailure(null), false);
    assert.equal(isSuccessionGateFailure(undefined), false);
  });
});

describe('pendingSuccession handoff guard', () => {
  let root;
  before(async () => { root = await makeTempRoot(); });
  after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  function makeFixture(bridgeOptions = {}) {
    const control = makeControl(
      path.join(root, `hg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
      bridgeOptions,
    );
    return { control, core: control.core, integration: createThreadIntegration({ control }) };
  }

  test('beginSessionHandoff blocks delivery; advanceHead clears atomically and resumes', async () => {
    const { core, integration } = makeFixture({
      enabled: true,
      resolveRuntimeViewerId: (agentId, sessionId) => (sessionId === 'hd-s2' ? 'viewer-s2' : null),
      submitTurn: async ({ text }) => ({ success: true, delivery: 'delivered', text }),
    });
    const thread = await core.start({ sessionRef: { agentId: 'coder', sessionId: 'hd-s1' } });
    await core.appendCommand({ threadId: thread.threadId, text: '请继续' });

    // 交接标记：integration 入口（host + head 匹配才生效）
    const begun = await integration.beginSessionSuccession({ agentId: 'coder', sessionId: 'hd-s1', reason: 'trim' });
    assert.equal(begun.applied, true);

    const blocked = await core.deliverPendingCommands(thread.threadId);
    assert.equal(blocked.delivered, 0);
    assert.equal(blocked.reason, 'handoff_in_progress');
    let record = await core.getThread(thread.threadId);
    // R3：begin 挡板事务内播种接续恢复指令；本用例用户指令先于 begin 落入，
    // 故播种指令排其后
    assert.equal(record.commands[0].source, 'ui');
    assert.equal(record.commands[1].source, 'thread-succession');
    assert.equal(record.commands[0].status, ThreadCommandStatus.PENDING);
    assert.equal(record.pendingSuccession.fromSessionId, 'hd-s1');

    // head 推进：同一次落盘清除交接意图，随后投递恢复（用户指令 + 播种指令）
    const outcome = await integration.applySessionSuccession({
      agentId: 'coder', fromSessionId: 'hd-s1', toSessionId: 'hd-s2', reason: 'trim',
    });
    assert.equal(outcome.applied, true);
    assert.equal(outcome.delivery.delivered, 2);

    record = await core.getThread(thread.threadId);
    assert.equal(record.pendingSuccession, null);
    assert.equal(record.commands[0].status, ThreadCommandStatus.DELIVERED);
    assert.equal(record.commands[1].status, ThreadCommandStatus.DELIVERED);
  });

  test('failSessionSuccession converges the succession barrier (old head stays authoritative)', async () => {
    const { core, integration } = makeFixture({});
    await core.start({ sessionRef: { agentId: 'coder', sessionId: 'hf-s1' } });

    const begun = await integration.beginSessionSuccession({ agentId: 'coder', sessionId: 'hf-s1', reason: 'trim' });
    assert.equal(begun.applied, true);
    assert.ok((await core.getThread(begun.threadId)).pendingSuccession, '挡板已立起');

    const failed = await integration.failSessionSuccession({
      agentId: 'coder', sessionId: 'hf-s1', reason: 'handoff_failed', stage: 'compact_or_successor',
    });
    assert.equal(failed.applied, true);
    // 挡板显式收敛：pendingSuccession 清空、失败事实落 lifecycleEvents，
    // 旧 head 继续承接后续投递（ADR-001 §2）。
    const record = await core.getThread(failed.threadId);
    assert.equal(record.pendingSuccession, null);
    assert.ok(record.lifecycleEvents.some((e) => e.type === 'handoff_failed'));
    assert.equal(record.headSessionId, 'hf-s1');
  });

  test('beginSessionSuccession publishes thread.handoff-started when the barrier lands', async () => {
    const control = makeControl(
      path.join(root, `hs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
      {},
    );
    const published = [];
    const integration = createThreadIntegration({
      control,
      publishThreadEvent: (threadId, payload) => published.push([threadId, payload]),
    });
    const thread = await control.core.start({ sessionRef: { agentId: 'coder', sessionId: 'hs-s1' } });

    const begun = await integration.beginSessionSuccession({ agentId: 'coder', sessionId: 'hs-s1', reason: 'trim' });
    assert.equal(begun.applied, true);
    assert.equal(published.length, 1);
    assert.equal(published[0][0], thread.threadId);
    assert.deepEqual(
      { ...published[0][1] },
      {
        kind: 'thread.handoff-started',
        agentId: 'coder',
        fromSessionId: 'hs-s1',
        reason: 'trim',
      },
    );

    // no-op 路径（无线程归属）不发布
    const orphan = await integration.beginSessionSuccession({ agentId: 'coder', sessionId: 'hs-none', reason: 'trim' });
    assert.equal(orphan.applied, false);
    assert.equal(published.length, 1);
  });

  test('beginSessionSuccession is a no-op for non-host agents and orphan sessions', async () => {
    const { core, integration } = makeFixture();
    const thread = await core.start({ sessionRef: { agentId: 'coder', sessionId: 'hd-a' } });

    const nonHost = await integration.beginSessionSuccession({ agentId: 'programming-helper', sessionId: 'hd-a', reason: 'trim' });
    assert.equal(nonHost.applied, false);
    assert.equal(nonHost.reason, 'no_thread_for_session');

    const orphan = await integration.beginSessionSuccession({ agentId: 'coder', sessionId: 'hd-unknown', reason: 'trim' });
    assert.equal(orphan.applied, false);
    assert.equal(orphan.reason, 'no_thread_for_session');

    const record = await core.getThread(thread.threadId);
    assert.equal(record.pendingSuccession, null);
  });
});

describe('InputGateway (unified user input routing)', () => {
  let root;
  before(async () => { root = await makeTempRoot(); });
  after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  function makeFixture(bridgeOptions = {}) {
    const control = makeControl(
      path.join(root, `ig-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
      bridgeOptions,
    );
    return { control, core: control.core, integration: createThreadIntegration({ control }) };
  }

  const VIEWER_KEY = 'coder::ig-s1';
  before(async () => {
    managedAgents.set(VIEWER_KEY, {
      agentId: 'coder',
      selectedSessionId: 'ig-s1',
      viewerAgentId: 'viewer-ig-1',
      process: null,
    });
  });
  after(async () => {
    managedAgents.delete(VIEWER_KEY);
  });

  test('handoff in progress reroutes to Thread Inbox with explicit thread_queued result', async () => {
    const { core, integration } = makeFixture();
    const thread = await core.start({ sessionRef: { agentId: 'coder', sessionId: 'ig-s1' } });
    await integration.beginSessionSuccession({ agentId: 'coder', sessionId: 'ig-s1', reason: 'summary' });

    const result = await deliverUserInput(
      { viewerAgentId: 'viewer-ig-1', text: '请继续', source: 'chat-composer' },
      { integration },
    );
    assert.equal(result.delivery, 'thread_queued');
    assert.equal(result.threadId, thread.threadId);
    assert.ok(result.commandId);

    const record = await core.getThread(thread.threadId);
    // R3：播种的恢复指令在 commands[0]，用户指令在其后
    const userCommand = record.commands.find((c) => c.text === '请继续');
    assert.equal(userCommand.status, ThreadCommandStatus.PENDING);
  });

  test('no thread found: passthrough delivery to viewer user-turn', async () => {
    const { integration } = makeFixture();

    // direct 路径验证网关透传契约：stub fetch 模拟 viewer 原生结果。
    // R6 后线程域一律入箱，direct 仅保留给纯 session（无线程 / 非 host）。
    const fetchImpl = async (_url, init) => ({
      ok: true,
      json: async () => ({
        success: true,
        delivery: 'delivered',
        text: JSON.parse(init.body).text,
      }),
    });
    const result = await deliverUserInput(
      { viewerAgentId: 'viewer-ig-1', text: 'hello' },
      { integration, fetchImpl },
    );
    assert.equal(result.delivery, 'delivered');
    assert.equal(result.text, 'hello');
  });

  test('historical thread sessions reject writes instead of silently targeting the head', async () => {
    const { core, integration } = makeFixture();
    await core.start({ sessionRef: { agentId: 'coder', sessionId: 'ig-s1' } });
    await core.advanceHead({ threadId: (await core.findThreadByHeadSession('coder', 'ig-s1')).threadId, toSessionId: 'ig-s2', fromSessionId: 'ig-s1', endKind: 'trim' });

    await assert.rejects(
      deliverUserInput({ viewerAgentId: 'viewer-ig-1', text: '不要写入历史分片' }, { integration }),
      (err) => err.code === 'session_not_head' && err.status === 409,
    );
  });

  test('image input during handoff is carried into the inbox (K8)', async () => {
    const { core, integration } = makeFixture();
    const thread = await core.start({ sessionRef: { agentId: 'coder', sessionId: 'ig-s1' } });
    await integration.beginSessionSuccession({ agentId: 'coder', sessionId: 'ig-s1', reason: 'trim' });

    // R6/K8：交接窗口的图片随指令入箱，投递时经 bridge 转给 user-turn。
    const result = await deliverUserInput(
      { viewerAgentId: 'viewer-ig-1', text: ' ', images: ['/tmp/a.png'] },
      { integration },
    );
    assert.equal(result.delivery, 'thread_queued');
    const record = await core.getThread(thread.threadId);
    const imageCommand = record.commands.find((c) => Array.isArray(c.images) && c.images.length > 0);
    assert.ok(imageCommand);
    assert.deepEqual(imageCommand.images, ['/tmp/a.png']);
  });

  test('reminder identity survives the inbox and lands via bridge submitTurn (no-handoff path)', async () => {
    // ADR-0024 决策 3：reminder（机器通报）与用户消息同享线程行政检查。
    // 线程域无交接窗口时入箱 + 即时投递——身份经 gateway 归一 → command
    // kind → bridge → user-turn body 全链不丢（落地为带 source 的 system
    // 消息，Claw 侧边界到 body 为止）。
    const seen = [];
    const fetchImpl = async (_url, init) => {
      seen.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ success: true, delivery: 'delivered' }) };
    };
    const { core, integration } = makeFixture({
      enabled: true,
      resolveRuntimeViewerId: () => 'viewer-ig-1',
      submitTurn: (params) => submitUserTurn(bridgeParamsToSubmitTurnArgs(params), { fetchImpl }),
    });
    const thread = await core.start({ sessionRef: { agentId: 'coder', sessionId: 'ig-s1' } });

    const result = await deliverUserInput(
      { viewerAgentId: 'viewer-ig-1', text: '到点提醒', kind: 'reminder', source: 'schedule-app' },
      { integration },
    );

    assert.equal(result.delivery, 'thread_queued');
    const record = await core.getThread(thread.threadId);
    const reminderCommand = record.commands.find((c) => c.text === '到点提醒');
    assert.equal(reminderCommand.kind, 'reminder');
    assert.equal(reminderCommand.status, ThreadCommandStatus.DELIVERED);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].kind, 'reminder');
    assert.equal(seen[0].source, 'thread');
  });

  test('reminder staged during handoff is delivered to the new head after advance (identity intact)', async () => {
    // 交接窗口内输入暂存、advance 后补投（既有用例扩展）：reminder 身份在
    // 暂存与补投两条 hop 上都不被改写，最终落到新 head 的 user-turn body。
    const seen = [];
    const fetchImpl = async (_url, init) => {
      seen.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ success: true, delivery: 'delivered' }) };
    };
    const { core, integration } = makeFixture({
      enabled: true,
      resolveRuntimeViewerId: (agentId, sessionId) => (sessionId === 'ig-s2' ? 'viewer-ig-2' : null),
      submitTurn: (params) => submitUserTurn(bridgeParamsToSubmitTurnArgs(params), { fetchImpl }),
    });
    const thread = await core.start({ sessionRef: { agentId: 'coder', sessionId: 'ig-s1' } });
    await integration.beginSessionSuccession({ agentId: 'coder', sessionId: 'ig-s1', reason: 'trim' });

    const result = await deliverUserInput(
      { viewerAgentId: 'viewer-ig-1', text: '交接窗口内的提醒', kind: 'reminder' },
      { integration },
    );
    assert.equal(result.delivery, 'thread_queued');
    let record = await core.getThread(thread.threadId);
    let reminderCommand = record.commands.find((c) => c.text === '交接窗口内的提醒');
    assert.equal(reminderCommand.kind, 'reminder');
    assert.equal(reminderCommand.status, ThreadCommandStatus.PENDING);
    assert.equal(seen.length, 0, '交接挡板期间不投递');

    const outcome = await integration.applySessionSuccession({
      agentId: 'coder', fromSessionId: 'ig-s1', toSessionId: 'ig-s2', reason: 'trim',
    });
    assert.equal(outcome.applied, true);
    record = await core.getThread(thread.threadId);
    reminderCommand = record.commands.find((c) => c.text === '交接窗口内的提醒');
    assert.equal(reminderCommand.status, ThreadCommandStatus.DELIVERED);
    const reminderBody = seen.find((b) => b.text === '交接窗口内的提醒');
    assert.ok(reminderBody, 'reminder 经 bridge 补投到新 head');
    assert.equal(reminderBody.kind, 'reminder');
    assert.equal(reminderBody.source, 'thread');
  });

  test('race closure: delivers immediately when succession lands between route resolution and append', async () => {
    const turns = [];
    const { core, integration } = makeFixture({
      enabled: true,
      resolveRuntimeViewerId: (agentId, sessionId) => (sessionId === 'ig-s2' ? 'viewer-ig-2' : null),
      submitTurn: async (params) => {
        turns.push(params);
        return { success: true };
      },
    });
    const thread = await core.start({ sessionRef: { agentId: 'coder', sessionId: 'ig-s1' } });
    await integration.beginSessionSuccession({ agentId: 'coder', sessionId: 'ig-s1', reason: 'trim' });

    // 模拟竞态：网关路由判定（读到 fresh 交接）之后、appendCommand 落盘
    // 之前，succession 完成（advanceHead 清挡板 + 投递过一轮空投递）。
    const realAppend = core.appendCommand.bind(core);
    const racingCore = Object.create(core);
    racingCore.appendCommand = async (params) => {
      await core.advanceHead({ threadId: thread.threadId, toSessionId: 'ig-s2', fromSessionId: 'ig-s1', endKind: 'trim' });
      return realAppend(params);
    };
    const racingIntegration = {
      ...integration,
      core: racingCore,
      tryDeliver: integration.tryDeliver.bind(integration),
    };

    const result = await deliverUserInput(
      { viewerAgentId: 'viewer-ig-1', text: '请继续' },
      { integration: racingIntegration },
    );

    // 无补投递时该指令会永远 pending（applySessionSuccession 已投递过，
    // 之后无人触发）；补投递后当场送达新 head。
    assert.equal(result.delivery, 'thread_queued');
    // R3 播种指令已在 advanceHead 清挡板时投出；补投递把竞态期间落入的
    // 用户指令和播种指令一并送出（两条 pending）。
    assert.equal(result.deliveryAttempt?.delivered, 2);
    assert.equal(turns.length, 2);
    const userTurn = turns.find((t) => t.text === '请继续');
    assert.equal(userTurn.agentId, 'viewer-ig-2');
    assert.equal(userTurn.sourceRef, result.commandId);

    const record = await core.getThread(thread.threadId);
    assert.equal(record.headSessionId, 'ig-s2');
    assert.equal(record.commands.filter((c) => c.status === ThreadCommandStatus.DELIVERED).length, 2);
  });
});
