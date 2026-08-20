/**
 * 工作线程（thread-control）测试
 *
 * 覆盖：
 * - ThreadStore：持久化、revision 自增、乐观并发、串行锁、无变更跳写
 * - ThreadController：创建、幂等指令、head 推进事务、取消语义
 * - ThreadRuntimeBridge：休眠默认、启用后 user-turn 投递、runtime 未就绪重试
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

import {
  ThreadStore,
  ThreadNotFoundError,
  ThreadRevisionConflictError,
} from '../server/thread-control/thread-store.js';
import {
  ThreadController,
  ThreadNotFoundError as ControllerThreadNotFound,
} from '../server/thread-control/thread-controller.js';
import { ThreadRuntimeBridge } from '../server/thread-control/thread-runtime-bridge.js';
import {
  createThreadIntegration,
  THREAD_HOST_AGENT_IDS,
} from '../server/thread-control/thread-integration.js';
import { deliverUserInput } from '../server/thread-control/input-gateway.js';
import { managedAgents } from '../server/shared/agent-access.js';
import {
  pendingCommands,
  appendCommand,
  pruneCommands,
  ThreadCommandStatus,
} from '../server/thread-control/thread-inbox.js';
import { UserTurnDeliveryError, submitUserTurn } from '../server/shared/user-turn.js';

function makeTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'claw-thread-test-'));
}

function makeController(root, bridgeOptions = {}) {
  const store = new ThreadStore({ rootDir: root });
  const bridge = new ThreadRuntimeBridge(bridgeOptions);
  return { store, bridge, controller: new ThreadController({ store, bridge }) };
}

describe('ThreadStore', () => {
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
      mode: 'interactive',
      status: 'idle',
      rootSessionId: 'sess-1',
      headSessionId: 'sess-1',
      sessionChain: [
        { sessionId: 'sess-1', role: 'head', startedAt: 1, endedAt: null, endKind: null, successorSessionId: null },
      ],
      commands: [],
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
      mode: 'interactive',
      status: 'idle',
      rootSessionId: 's1',
      headSessionId: 's3',
      sessionChain: [
        { sessionId: 's1', role: 'predecessor', startedAt: 1, endedAt: 2, endKind: 'trim', successorSessionId: 's2' },
        { sessionId: 's2', role: 'predecessor', startedAt: 2, endedAt: 3, endKind: 'summary', successorSessionId: 's3' },
        { sessionId: 's3', role: 'head', startedAt: 3, endedAt: null, endKind: null, successorSessionId: null },
      ],
      commands: [],
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
      mode: 'interactive',
      status: 'idle',
      rootSessionId: 's1',
      headSessionId: 's1',
      sessionChain: [{ sessionId: 's1', role: 'head', startedAt: 1, endedAt: null, endKind: null, successorSessionId: null }],
      commands: [],
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
      mode: 'interactive',
      status: 'idle',
      rootSessionId: 's1',
      headSessionId: 's1',
      sessionChain: [{ sessionId: 's1', role: 'head', startedAt: 1, endedAt: null, endKind: null, successorSessionId: null }],
      commands: [],
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    await store.create(record);

    await Promise.all([
      store.update('wt-conc', (d) => { d.title = 'first'; return d; }),
      store.update('wt-conc', (d) => { d.mode = 'autonomous'; return d; }),
    ]);

    const final = await store.get('wt-conc');
    assert.equal(final.revision, 3);
    assert.ok(final.title === 'first' || final.mode === 'autonomous');
    // 两次串行写都不丢失
    assert.equal(final.title, 'first');
    assert.equal(final.mode, 'autonomous');
  });

  test('legacy thread statuses are normalized on read and on create', async () => {
    const store = new ThreadStore({ rootDir: root });
    const base = {
      agentId: 'a',
      workspaceId: 'a',
      title: '',
      mode: 'interactive',
      rootSessionId: 's1',
      headSessionId: 's1',
      sessionChain: [{ sessionId: 's1', role: 'head', startedAt: 1, endedAt: null, endKind: null, successorSessionId: null }],
      commands: [],
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    };

    // 盘上旧值（旧状态空间）读时归一，不允许半僵尸态流入控制器
    const cases = [
      ['wt-legacy-active', 'active', 'idle'],
      ['wt-legacy-completed', 'completed', 'closed'],
      ['wt-legacy-cancelled', 'cancelled', 'closed'],
      ['wt-legacy-blocked', 'blocked', 'failed'],
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
    assert.equal(created.status, 'idle');
    const indexEntry = (await store.list()).find((t) => t.threadId === 'wt-create-legacy');
    assert.equal(indexEntry.status, 'idle');
  });
});

describe('ThreadController', () => {
  let root;
  before(async () => {
    root = await makeTempRoot();
  });
  after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('createThread seeds root/head and chain', async () => {
    const { controller } = makeController(root);
    const thread = await controller.createThread({
      agentId: 'programming-helper',
      sessionId: 'sess-a',
      title: '修复登录',
    });
    assert.match(thread.threadId, /^wt-/);
    assert.equal(thread.headSessionId, 'sess-a');
    assert.equal(thread.rootSessionId, 'sess-a');
    assert.equal(thread.sessionChain.length, 1);
    assert.equal(thread.sessionChain[0].role, 'head');
    assert.equal(thread.mode, 'interactive');
  });

  test('createThread rejects invalid identifiers', async () => {
    const { controller } = makeController(root);
    await assert.rejects(() => controller.createThread({ agentId: '', sessionId: 's' }));
    await assert.rejects(() => controller.createThread({ agentId: 'a', sessionId: 'bad id with spaces' }));
  });

  test('recordRuntimeEvent drives idle/running/failed from the session turn stream', async () => {
    const { controller } = makeController(root);
    const thread = await controller.createThread({ agentId: 'event-agent', sessionId: 'event-session' });

    const started = await controller.recordRuntimeEvent({
      agentId: 'event-agent',
      sessionId: 'event-session',
      runtimeInstanceId: 'runtime-1',
      event: { type: 'turn.started', turn: 1 },
    });
    assert.equal(started.applied, true);
    assert.equal(started.thread.status, 'running');

    const completed = await controller.recordRuntimeEvent({
      agentId: 'event-agent',
      sessionId: 'event-session',
      runtimeInstanceId: 'runtime-1',
      event: { type: 'turn.completed', turn: 1, usage: { inputTokens: 2, outputTokens: 3 } },
    });
    assert.equal(completed.thread.status, 'idle');
    assert.equal(completed.thread.lastLifecycleEvent.type, 'turn.completed');

    const failed = await controller.recordRuntimeEvent({
      agentId: 'event-agent',
      sessionId: 'event-session',
      runtimeInstanceId: 'runtime-1',
      event: { type: 'turn.failed', turn: 2, error: { message: 'API unavailable', retryable: true } },
    });
    assert.equal(failed.thread.status, 'failed');
    assert.equal(failed.thread.lastLifecycleEvent.error.message, 'API unavailable');
    assert.equal((await controller.getThread(thread.threadId)).status, 'failed');
  });

  test('turn.cancelled is a lifecycle signal: event recorded, status unchanged', async () => {
    const { controller } = makeController(root);
    const cancelThread = await controller.createThread({ agentId: 'cancel-agent', sessionId: 'cancel-session' });
    await controller.recordRuntimeEvent({
      agentId: 'cancel-agent',
      sessionId: 'cancel-session',
      runtimeInstanceId: 'runtime-1',
      event: { type: 'turn.started', turn: 1 },
    });

    // guard 轮换打断：cancelled 不得把线程打成 failed（轮换由 context_guard_event 驱动）
    const cancelled = await controller.recordRuntimeEvent({
      agentId: 'cancel-agent',
      sessionId: 'cancel-session',
      runtimeInstanceId: 'runtime-1',
      event: { type: 'turn.cancelled', turn: 1, error: { message: 'Session blocked by the context guard', reason: 'cancelled' } },
    });
    assert.equal(cancelled.applied, true);
    assert.equal(cancelled.thread.status, 'running');

    const { events: storedEvents } = await controller.getExecutionEvents(cancelThread.threadId);
    const recorded = storedEvents.some((event) => event.type === 'turn.cancelled');
    assert.equal(recorded, true);

    // 轮换接续：head 推进到 successor，新 turn 自然完成，线程回 idle
    await controller.advanceHead({
      threadId: cancelThread.threadId,
      toSessionId: 'cancel-session-2',
      fromSessionId: 'cancel-session',
      expectedRevision: cancelled.thread.revision,
      endKind: 'context_rotation',
    });
    await controller.recordRuntimeEvent({
      agentId: 'cancel-agent',
      sessionId: 'cancel-session-2',
      runtimeInstanceId: 'runtime-2',
      event: { type: 'turn.started', turn: 2 },
    });
    const resumed = await controller.recordRuntimeEvent({
      agentId: 'cancel-agent',
      sessionId: 'cancel-session-2',
      runtimeInstanceId: 'runtime-2',
      event: { type: 'turn.completed', turn: 2 },
    });
    assert.equal(resumed.thread.status, 'idle');
  });

  test('recordRuntimeEvent ignores unsupported events and sessions outside a thread', async () => {
    const { controller } = makeController(root);
    await controller.createThread({ agentId: 'event-agent-2', sessionId: 'event-session-2' });
    assert.deepEqual(
      await controller.recordRuntimeEvent({
        agentId: 'other-agent',
        sessionId: 'unknown-session',
        event: { type: 'turn.started', turn: 1 },
      }),
      { applied: false, reason: 'no_thread_for_session' },
    );
    const itemEvent = await controller.recordRuntimeEvent({
      agentId: 'event-agent-2',
      sessionId: 'event-session-2',
      event: { type: 'item.completed', item: { type: 'agent_message' } },
    });
    assert.equal(itemEvent.applied, true);
    assert.equal(itemEvent.thread.executionEvents.length, 1);
  });

  test('appendCommand is idempotent by idempotencyKey', async () => {
    const { controller } = makeController(root);
    const thread = await controller.createThread({ agentId: 'a', sessionId: 's1' });

    const first = await controller.appendCommand({
      threadId: thread.threadId,
      text: '请继续',
      idempotencyKey: 'ui-1',
    });
    const second = await controller.appendCommand({
      threadId: thread.threadId,
      text: '请继续',
      idempotencyKey: 'ui-1',
    });

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(first.command.commandId, second.command.commandId);

    const record = await controller.getThread(thread.threadId);
    assert.equal(record.commands.length, 1);
  });

  test('appendCommand rejects empty text and unknown thread', async () => {
    const { controller } = makeController(root);
    const thread = await controller.createThread({ agentId: 'a', sessionId: 's1' });
    await assert.rejects(() => controller.appendCommand({ threadId: thread.threadId, text: '   ' }));
    await assert.rejects(
      () => controller.appendCommand({ threadId: 'wt-none', text: 'x' }),
      ControllerThreadNotFound,
    );
  });

  test('advanceHead closes old chain entry and moves head atomically', async () => {
    const { controller } = makeController(root);
    const thread = await controller.createThread({ agentId: 'a', sessionId: 's1' });

    const advanced = await controller.advanceHead({
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

  test('advanceHead guards: stale revision / wrong from / duplicate target / non-active', async () => {
    const { controller } = makeController(root);
    const thread = await controller.createThread({ agentId: 'a', sessionId: 's1' });

    await assert.rejects(
      () => controller.advanceHead({ threadId: thread.threadId, toSessionId: 's2', expectedRevision: 999 }),
      ThreadRevisionConflictError,
    );
    await assert.rejects(
      () => controller.advanceHead({ threadId: thread.threadId, toSessionId: 's2', fromSessionId: 'wrong' }),
      (err) => err.code === 'head_mismatch',
    );

    const advanced = await controller.advanceHead({ threadId: thread.threadId, toSessionId: 's2' });
    await assert.rejects(
      () => controller.advanceHead({ threadId: thread.threadId, toSessionId: 's2' }),
      (err) => err.code === 'already_head',
    );
    await assert.rejects(
      () => controller.advanceHead({ threadId: thread.threadId, toSessionId: 's1' }),
      (err) => err.code === 'duplicate_session',
    );

    await controller.closeThread(thread.threadId);
    await assert.rejects(
      () => controller.advanceHead({ threadId: thread.threadId, toSessionId: 's3' }),
      (err) => err.code === 'thread_closed',
    );
    assert.equal(advanced.status, 'idle'); // close 前的返回值不受影响
  });

  test('closeThread closes and cancels pending commands', async () => {
    const { controller } = makeController(root);
    const thread = await controller.createThread({ agentId: 'a', sessionId: 's1' });
    await controller.appendCommand({ threadId: thread.threadId, text: 'x', idempotencyKey: 'k1' });

    const closed = await controller.closeThread(thread.threadId, { reason: 'user' });
    assert.equal(closed.status, 'closed');
    assert.equal(closed.commands[0].status, ThreadCommandStatus.CANCELLED);
  });

  test('cancelCommand only affects pending', async () => {
    const { controller } = makeController(root);
    const thread = await controller.createThread({ agentId: 'a', sessionId: 's1' });
    const { command } = await controller.appendCommand({ threadId: thread.threadId, text: 'x' });

    await controller.cancelCommand(thread.threadId, command.commandId);
    await controller.cancelCommand(thread.threadId, command.commandId); // 二次取消幂等

    const record = await controller.getThread(thread.threadId);
    assert.equal(record.commands[0].status, ThreadCommandStatus.CANCELLED);
  });

  test('deliverPendingCommands with dormant bridge keeps commands pending', async () => {
    const { controller } = makeController(root); // bridge enabled=false
    const thread = await controller.createThread({ agentId: 'a', sessionId: 's1' });
    await controller.appendCommand({ threadId: thread.threadId, text: '请继续' });

    const result = await controller.deliverPendingCommands(thread.threadId);
    assert.equal(result.reason, 'bridge_disabled');
    assert.equal(result.delivered, 0);

    const record = await controller.getThread(thread.threadId);
    assert.equal(record.commands[0].status, ThreadCommandStatus.PENDING);
  });
});

describe('thread state machine (执行层契约锁死)', () => {
  let root;
  before(async () => { root = await makeTempRoot(); });
  after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  // 设计的转换矩阵。任何一行改动都是状态机语义变更，必须显式同步这里。
  const EXPECTED_TRANSITIONS = {
    idle: ['running', 'rotating', 'waiting_input', 'failed', 'closed'],
    running: ['idle', 'rotating', 'waiting_input', 'failed', 'closed'],
    rotating: ['idle', 'running', 'rotation_failed', 'closed'],
    rotation_failed: ['running', 'rotating', 'failed', 'closed', 'idle'],
    failed: ['running', 'rotating', 'closed'],
    waiting_input: ['running', 'idle', 'closed'],
    closed: [],
  };

  test('transition matrix matches the designed state space exactly', () => {
    const { controller } = makeController(root);
    const states = Object.keys(EXPECTED_TRANSITIONS);
    for (const from of states) {
      const allowed = new Set(EXPECTED_TRANSITIONS[from]);
      for (const to of states) {
        assert.equal(
          controller._canTransition(from, to),
          from === to || allowed.has(to),
          `${from} -> ${to} 违反设计矩阵`,
        );
      }
    }
  });

  test('rotation failure path: running → rotating → rotation_failed → resume → running', async () => {
    const { controller } = makeController(root);
    const thread = await controller.createThread({ agentId: 'coder', sessionId: 'rot-s1' });

    await controller.recordRuntimeEvent({ agentId: 'coder', sessionId: 'rot-s1', event: { type: 'turn.started', turn: 1 } });
    assert.equal((await controller.getThread(thread.threadId)).status, 'running');

    // guard 触发交接 → rotating（含生命周期事件与交接意图 stage）
    const begun = await controller.beginSessionHandoff({ threadId: thread.threadId, fromSessionId: 'rot-s1', reason: 'context_guard' });
    assert.equal(begun.status, 'rotating');
    assert.equal(begun.pendingSuccession.fromSessionId, 'rot-s1');
    assert.equal(begun.lastLifecycleEvent.type, 'handoff_started');

    // 压缩失败 → rotation_failed；pendingSuccession 保留供恢复收拾残局
    const failed = await controller.failSessionHandoff(thread.threadId, {
      reason: 'compact_crashed',
      stage: 'compact_or_successor',
      error: 'mirror timeout',
    });
    assert.equal(failed.status, 'rotation_failed');
    assert.equal(failed.pendingSuccession.fromSessionId, 'rot-s1', '交接意图必须保留在盘上');
    assert.equal(failed.lastLifecycleEvent.reason, 'compact_crashed');
    assert.equal(failed.lastLifecycleEvent.stage, 'compact_or_successor');

    // resume → running（回归锁：此步曾因转移表缺 running 而断裂）
    const resumed = await controller.resumeThread(thread.threadId, { source: 'cli' });
    assert.equal(resumed.status, 'running');
    assert.equal(resumed.lastLifecycleEvent.type, 'resumed');
  });

  test('resumeThread admits failed / waiting_input and rejects non-resumable states', async () => {
    const { controller, store } = makeController(root);

    // failed → running：经真实 turn.failed 进入后 resume
    const t1 = await controller.createThread({ agentId: 'a', sessionId: 'rs-s1' });
    await controller.recordRuntimeEvent({ agentId: 'a', sessionId: 'rs-s1', event: { type: 'turn.started', turn: 1 } });
    await controller.recordRuntimeEvent({ agentId: 'a', sessionId: 'rs-s1', event: { type: 'turn.failed', turn: 1, error: { message: 'api down' } } });
    assert.equal((await controller.resumeThread(t1.threadId)).status, 'running');

    // waiting_input → running（暂无事件源，直接落盘播种该状态）
    const t2 = await controller.createThread({ agentId: 'a', sessionId: 'rs-s2' });
    await store.update(t2.threadId, (draft) => { draft.status = 'waiting_input'; return draft; });
    assert.equal((await controller.resumeThread(t2.threadId)).status, 'running');

    // idle / rotating / closed 一律拒绝
    const seeds = [
      ['rs-s3', null],
      ['rs-s4', 'rotating'],
      ['rs-s5', 'closed'],
    ];
    for (const [sessionId, seed] of seeds) {
      const t = await controller.createThread({ agentId: 'a', sessionId });
      if (seed) {
        await store.update(t.threadId, (draft) => {
          draft.status = seed;
          if (seed === 'rotating') {
            draft.pendingSuccession = { fromSessionId: sessionId, reason: 'trim', startedAt: Date.now() };
          }
          return draft;
        });
      }
      await assert.rejects(
        () => controller.resumeThread(t.threadId),
        (err) => err.code === 'thread_not_resumable',
        `${seed || 'idle'} 不允许 resume`,
      );
    }
  });

  test('closed is terminal: idempotent close, no resume, no events, no handoff', async () => {
    const { controller } = makeController(root);
    const thread = await controller.createThread({ agentId: 'a', sessionId: 'cl-s1' });

    const first = await controller.closeThread(thread.threadId, { reason: 'user' });
    assert.equal(first.status, 'closed');
    assert.equal(first.closeReason, 'user');

    const second = await controller.closeThread(thread.threadId, { reason: 'again' });
    assert.equal(second.status, 'closed');
    assert.equal(second.closeReason, 'user', '重复 close 幂等，不改写首个 closeReason');

    await assert.rejects(
      () => controller.resumeThread(thread.threadId),
      (err) => err.code === 'thread_not_resumable',
    );
    assert.deepEqual(
      await controller.recordRuntimeEvent({ agentId: 'a', sessionId: 'cl-s1', event: { type: 'turn.started', turn: 1 } }),
      { applied: false, reason: 'thread_closed' },
    );
    assert.deepEqual(
      await controller.recordRuntimeEvent({ agentId: 'a', sessionId: 'cl-s1', event: { type: 'item.completed', item: { type: 'agent_message' } } }),
      { applied: false, reason: 'thread_closed' },
    );
    await assert.rejects(
      () => controller.beginSessionHandoff({ threadId: thread.threadId, fromSessionId: 'cl-s1', reason: 'trim' }),
      (err) => err.code === 'thread_closed',
    );
  });

  test('delivery is gated by every non-idle/running status with a definite reason', async () => {
    const { controller, store } = makeController(root);
    const cases = [
      ['gg-s1', 'rotating', 'handoff_in_progress'],
      ['gg-s2', 'failed', 'thread_waiting'],
      ['gg-s3', 'rotation_failed', 'thread_waiting'],
      ['gg-s4', 'waiting_input', 'thread_waiting'],
      ['gg-s5', 'closed', 'thread_closed'],
    ];
    for (const [sessionId, status, reason] of cases) {
      const thread = await controller.createThread({ agentId: 'a', sessionId });
      await store.update(thread.threadId, (draft) => {
        draft.status = status;
        if (status === 'rotating') {
          draft.pendingSuccession = { fromSessionId: sessionId, reason: 'trim', startedAt: Date.now() };
        }
        return draft;
      });
      await controller.appendCommand({ threadId: thread.threadId, text: 'x' });
      const result = await controller.deliverPendingCommands(thread.threadId);
      assert.equal(result.delivered, 0);
      assert.equal(result.reason, reason, `${status} 必须挡住投递并给出确定 reason`);
      const record = await controller.getThread(thread.threadId);
      assert.equal(record.commands[0].status, ThreadCommandStatus.PENDING);
    }
  });

  test('execution events: cursor slicing and eventId dedup', async () => {
    const { controller } = makeController(root);
    const thread = await controller.createThread({ agentId: 'a', sessionId: 'ev-s1' });

    const emit = (event) =>
      controller.recordRuntimeEvent({ agentId: 'a', sessionId: 'ev-s1', runtimeInstanceId: 'rt-1', event });
    await emit({ type: 'turn.started', turn: 1, eventId: 'e1' });
    await emit({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'hi' }, eventId: 'e2' });
    await emit({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'hi' }, eventId: 'e2' });
    await emit({ type: 'turn.completed', turn: 1, eventId: 'e3' });

    const all = await controller.getExecutionEvents(thread.threadId);
    assert.equal(all.events.length, 3, '重复 eventId 必须去重');
    assert.equal(all.cursor, 3);

    const tail = await controller.getExecutionEvents(thread.threadId, { after: 2 });
    assert.equal(tail.events.length, 1);
    assert.equal(tail.events[0].type, 'turn.completed');
  });

  test('advanceHead lands on idle with pendingSuccession cleared atomically', async () => {
    const { controller } = makeController(root);
    const thread = await controller.createThread({ agentId: 'a', sessionId: 'ah-s1' });
    await controller.beginSessionHandoff({ threadId: thread.threadId, fromSessionId: 'ah-s1', reason: 'context_guard' });

    const advanced = await controller.advanceHead({
      threadId: thread.threadId,
      toSessionId: 'ah-s2',
      fromSessionId: 'ah-s1',
      endKind: 'trim',
    });
    assert.equal(advanced.status, 'idle');
    assert.equal(advanced.pendingSuccession, null);
    assert.equal(advanced.lastLifecycleEvent.type, 'handoff_completed');
  });
});

describe('ThreadRuntimeBridge (enabled) + user-turn integration', () => {
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
    const { controller } = makeController(root, {
      enabled: true,
      resolveRuntimeViewerId: (agentId, sessionId) =>
        liveRuntimes.get(`${agentId}::${sessionId}`) || null,
      submitTurn: async (params) => {
        turns.push(params);
        return { success: true };
      },
    });

    const thread = await controller.createThread({ agentId: 'agent-x', sessionId: 'old-1' });
    const { command } = await controller.appendCommand({ threadId: thread.threadId, text: '请继续', idempotencyKey: 'k1' });

    // 旧 head 无 runtime → 指令保持 pending（等待 head 推进）
    let result = await controller.deliverPendingCommands(thread.threadId);
    assert.equal(result.delivered, 0);
    assert.equal(result.reason, 'runtime_not_accepting');
    let record = await controller.getThread(thread.threadId);
    assert.equal(record.commands[0].status, ThreadCommandStatus.PENDING);

    // head 推进到新会话且 runtime 就绪 → user-turn 投递成功
    await controller.advanceHead({ threadId: thread.threadId, toSessionId: 'head-2', fromSessionId: 'old-1' });
    liveRuntimes.set('agent-x::head-2', 'viewer-abc');
    result = await controller.deliverPendingCommands(thread.threadId);
    assert.equal(result.delivered, 1);
    assert.equal(result.reason, null);

    assert.equal(turns.length, 1);
    assert.equal(turns[0].agentId, 'viewer-abc');
    assert.equal(turns[0].text, '请继续');
    assert.equal(turns[0].source, 'thread');
    assert.equal(turns[0].sourceRef, command.commandId);

    record = await controller.getThread(thread.threadId);
    assert.equal(record.commands[0].status, ThreadCommandStatus.DELIVERED);
    assert.equal(record.commands[0].deliveryRef, 'viewer-abc');
  });

  test('non-retryable delivery failure marks command failed', async () => {
    const { controller } = makeController(root, {
      enabled: true,
      resolveRuntimeViewerId: () => 'viewer-live',
      submitTurn: async () => {
        throw new UserTurnDeliveryError('bad input', { code: 'invalid_input', status: 400, retryable: false });
      },
    });
    const thread = await controller.createThread({ agentId: 'agent-y', sessionId: 's1' });
    await controller.appendCommand({ threadId: thread.threadId, text: 'x' });

    const result = await controller.deliverPendingCommands(thread.threadId);
    assert.equal(result.delivered, 0);

    const record = await controller.getThread(thread.threadId);
    assert.equal(record.commands[0].status, ThreadCommandStatus.FAILED);
    assert.equal(record.commands[0].lastReason, 'invalid_input');
  });

  // 契约回归：bridge 传给 submitUserTurn 的参数名必须是 agentId。
  // 历史事故：bridge 传 viewerAgentId（被客户端忽略）→ agentId undefined →
  // 客户端预校验抛 invalid_input（不可重试）→ 接力指令全部被误判 failed。
  // 用真实 submitUserTurn + fetchImpl mock 而非哑 stub，参数漂移当场炸出。
  test('bridge passes contract-valid params to the real submitUserTurn client', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ success: true, delivery: 'queued' }) };
    };
    const { controller } = makeController(root, {
      enabled: true,
      resolveRuntimeViewerId: () => 'viewer-contract',
      submitTurn: (params) => submitUserTurn(params, { fetchImpl }),
    });
    const thread = await controller.createThread({ agentId: 'agent-c', sessionId: 'cs-1' });
    const { command } = await controller.appendCommand({ threadId: thread.threadId, text: '契约校验' });

    const result = await controller.deliverPendingCommands(thread.threadId);
    assert.equal(result.delivered, 1);
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /\/api\/agents\/viewer-contract\/user-turn$/);
    assert.equal(seen[0].body.text, '契约校验');
    assert.equal(seen[0].body.source, 'thread');
    assert.equal(seen[0].body.sourceRef, command.commandId);

    const record = await controller.getThread(thread.threadId);
    assert.equal(record.commands[0].status, ThreadCommandStatus.DELIVERED);
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
    const store = new ThreadStore({ rootDir: path.join(root, `it-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`) });
    const bridge = new ThreadRuntimeBridge(bridgeOptions);
    const controller = new ThreadController({ store, bridge });
    return { controller, integration: createThreadIntegration({ controller }) };
  }

  test('onSessionCreated creates thread for coder host only', async () => {
    const { integration } = makeIntegration();
    assert.ok(THREAD_HOST_AGENT_IDS.has('coder'));

    const coderThread = await integration.onSessionCreated('coder', { id: 'cs-1', title: '修复登录' });
    assert.ok(coderThread);
    assert.equal(coderThread.headSessionId, 'cs-1');
    assert.equal(coderThread.title, '修复登录');

    const phThread = await integration.onSessionCreated('programming-helper', { id: 'ph-1' });
    assert.equal(phThread, null);
  });

  test('applySessionSuccession advances head and delivers pending commands', async () => {
    const turns = [];
    const { controller, integration } = makeIntegration({
      enabled: true,
      resolveRuntimeViewerId: (agentId, sessionId) => (sessionId === 'coder-s2' ? 'viewer-s2' : null),
      submitTurn: async (params) => {
        turns.push(params);
        return { success: true };
      },
    });

    const thread = await integration.onSessionCreated('coder', { id: 'coder-s1', title: 'T' });
    await controller.appendCommand({ threadId: thread.threadId, text: '接力期间补充的指令' });

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
    const record = await controller.getThread(thread.threadId);
    assert.equal(record.sessionChain.length, 2);
    assert.equal(record.sessionChain[0].endKind, 'trim');
    assert.equal(record.sessionChain[0].successorSessionId, 'coder-s2');
  });

  // runtime-ready 补投：succession 时刻 runtime 未就绪（runtime_not_accepting）
  // 保持 pending 的指令，在 head runtime 就绪时经 handleRuntimeReady 送达。
  test('handleRuntimeReady delivers pending commands when head runtime becomes ready', async () => {
    const turns = [];
    let ready = false;
    const { controller, integration } = makeIntegration({
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
    await controller.appendCommand({ threadId: thread.threadId, text: '等 runtime 的指令' });

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

    let record = await controller.getThread(thread.threadId);
    assert.equal(record.commands[0].status, ThreadCommandStatus.PENDING);

    // runtime 就绪 → 补投送达
    ready = true;
    const readyOutcome = await integration.handleRuntimeReady('coder', 'coder-s2');
    assert.equal(readyOutcome.applied, true);
    assert.equal(readyOutcome.delivery.delivered, 1);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].text, '等 runtime 的指令');

    record = await controller.getThread(thread.threadId);
    assert.equal(record.commands[0].status, ThreadCommandStatus.DELIVERED);

    // 非线程宿主 / 就绪会话不是任何线程 head：no-op
    assert.equal((await integration.handleRuntimeReady('programming-helper', 'x')).reason, 'not_thread_host');
    assert.equal((await integration.handleRuntimeReady('coder', 'coder-s1')).reason, 'no_thread_for_session');
  });

  test('applySessionSuccession is no-op for non-host agents and non-head sessions', async () => {    const { controller, integration } = makeIntegration();

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
    const thread = await controller.getThread((await controller.listThreads({ agentId: 'coder' }))[0].threadId);
    const stale = await integration.applySessionSuccession({
      agentId: 'coder',
      fromSessionId: 'c1',
      toSessionId: 'c1', // same session → invalid
      reason: 'trim',
    });
    assert.equal(stale.applied, false);
    assert.equal(thread.headSessionId, 'c1');
  });

  test('onSessionDeleted cancels the thread when its head is deleted; no-op otherwise', async () => {
    const { controller, integration } = makeIntegration();
    const thread = await integration.onSessionCreated('coder', { id: 'del-1', title: 'A' });
    await controller.appendCommand({ threadId: thread.threadId, text: 'staged' });
    await controller.advanceHead({ threadId: thread.threadId, toSessionId: 'del-2', fromSessionId: 'del-1', endKind: 'trim' });

    // 删除非 head 棒次：不动线程
    const nonHead = await integration.onSessionDeleted('coder', 'del-1');
    assert.equal(nonHead.applied, false);
    assert.equal(nonHead.reason, 'no_thread_for_session');

    // 非线程宿主：no-op
    const nonHost = await integration.onSessionDeleted('programming-helper', 'del-2');
    assert.equal(nonHost.applied, false);
    assert.equal(nonHost.reason, 'not_thread_host');

    // 删除 head：线程取消，pending 指令一并取消
    const outcome = await integration.onSessionDeleted('coder', 'del-2');
    assert.equal(outcome.applied, true);
    assert.equal(outcome.threadId, thread.threadId);
    const record = await controller.getThread(thread.threadId);
    assert.equal(record.status, 'closed');
    assert.equal(record.closeReason, 'head_session_deleted');
    assert.equal(record.commands[0].status, ThreadCommandStatus.CANCELLED);
  });
});

describe('thread-inbox helpers', () => {
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

describe('pendingSuccession handoff guard', () => {
  let root;
  before(async () => { root = await makeTempRoot(); });
  after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  function makeFixture(bridgeOptions = {}) {
    const store = new ThreadStore({ rootDir: path.join(root, `hg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`) });
    const bridge = new ThreadRuntimeBridge(bridgeOptions);
    const controller = new ThreadController({ store, bridge });
    return { controller, integration: createThreadIntegration({ controller }) };
  }

  test('beginSessionHandoff blocks delivery; advanceHead clears atomically and resumes', async () => {
    const { controller, integration } = makeFixture({
      enabled: true,
      resolveRuntimeViewerId: (agentId, sessionId) => (sessionId === 'hd-s2' ? 'viewer-s2' : null),
      submitTurn: async ({ text }) => ({ success: true, delivery: 'delivered', text }),
    });
    const thread = await controller.createThread({ agentId: 'coder', sessionId: 'hd-s1' });
    await controller.appendCommand({ threadId: thread.threadId, text: '请继续' });

    // 交接标记：integration 入口（host + head 匹配才生效）
    const begun = await integration.beginSessionSuccession({ agentId: 'coder', sessionId: 'hd-s1', reason: 'trim' });
    assert.equal(begun.applied, true);

    const blocked = await controller.deliverPendingCommands(thread.threadId);
    assert.equal(blocked.delivered, 0);
    assert.equal(blocked.reason, 'handoff_in_progress');
    let record = await controller.getThread(thread.threadId);
    assert.equal(record.commands[0].status, ThreadCommandStatus.PENDING);
    assert.equal(record.pendingSuccession.fromSessionId, 'hd-s1');

    // head 推进：同一次落盘清除交接意图，随后投递恢复
    const outcome = await integration.applySessionSuccession({
      agentId: 'coder', fromSessionId: 'hd-s1', toSessionId: 'hd-s2', reason: 'trim',
    });
    assert.equal(outcome.applied, true);
    assert.equal(outcome.delivery.delivered, 1);

    record = await controller.getThread(thread.threadId);
    assert.equal(record.pendingSuccession, null);
    assert.equal(record.commands[0].status, ThreadCommandStatus.DELIVERED);
  });

  test('beginSessionSuccession is a no-op for non-host agents and orphan sessions', async () => {
    const { controller, integration } = makeFixture();
    const thread = await controller.createThread({ agentId: 'coder', sessionId: 'hd-a' });

    const nonHost = await integration.beginSessionSuccession({ agentId: 'programming-helper', sessionId: 'hd-a', reason: 'trim' });
    assert.equal(nonHost.applied, false);
    assert.equal(nonHost.reason, 'not_thread_host');

    const orphan = await integration.beginSessionSuccession({ agentId: 'coder', sessionId: 'hd-unknown', reason: 'trim' });
    assert.equal(orphan.applied, false);
    assert.equal(orphan.reason, 'no_thread_for_session');

    const record = await controller.getThread(thread.threadId);
    assert.equal(record.pendingSuccession, null);
  });

  test('stale handoff intent no longer blocks delivery (failure-path self-healing)', async () => {
    const { controller } = makeFixture({
      enabled: true,
      resolveRuntimeViewerId: () => 'viewer-x',
      submitTurn: async ({ text }) => ({ success: true, delivery: 'delivered', text }),
    });
    const thread = await controller.createThread({ agentId: 'coder', sessionId: 'hd-stale' });
    await controller.appendCommand({ threadId: thread.threadId, text: 'later' });

    // 直接写一个 10 分钟前的交接意图（模拟 compact 崩溃后残留）
    await controller.store.update(thread.threadId, (draft) => {
      draft.pendingSuccession = { fromSessionId: 'hd-stale', reason: 'trim', startedAt: Date.now() - 10 * 60 * 1000 };
      return draft;
    });

    const result = await controller.deliverPendingCommands(thread.threadId);
    assert.equal(result.delivered, 1);
    const record = await controller.getThread(thread.threadId);
    assert.equal(record.pendingSuccession, null); // 惰性清除落盘
  });
});

describe('InputGateway (unified user input routing)', () => {
  let root;
  before(async () => { root = await makeTempRoot(); });
  after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  function makeFixture(bridgeOptions = {}) {
    const store = new ThreadStore({ rootDir: path.join(root, `ig-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`) });
    const bridge = new ThreadRuntimeBridge(bridgeOptions);
    const controller = new ThreadController({ store, bridge });
    return { controller, integration: createThreadIntegration({ controller }) };
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
    const { controller, integration } = makeFixture();
    const thread = await controller.createThread({ agentId: 'coder', sessionId: 'ig-s1' });
    await integration.beginSessionSuccession({ agentId: 'coder', sessionId: 'ig-s1', reason: 'summary' });

    const result = await deliverUserInput(
      { viewerAgentId: 'viewer-ig-1', text: '请继续', source: 'chat-composer' },
      { integration },
    );
    assert.equal(result.delivery, 'thread_queued');
    assert.equal(result.threadId, thread.threadId);
    assert.ok(result.commandId);

    const record = await controller.getThread(thread.threadId);
    assert.equal(record.commands[0].status, ThreadCommandStatus.PENDING);
    assert.equal(record.commands[0].text, '请继续');
  });

  test('no handoff: passthrough delivery to viewer user-turn', async () => {
    const { controller, integration } = makeFixture();
    await controller.createThread({ agentId: 'coder', sessionId: 'ig-s1' });

    // direct 路径验证网关透传契约：stub fetch 模拟 viewer 原生结果
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

  test('image-only input during handoff fails explicitly instead of being lost', async () => {
    const { controller, integration } = makeFixture();
    await controller.createThread({ agentId: 'coder', sessionId: 'ig-s1' });
    await integration.beginSessionSuccession({ agentId: 'coder', sessionId: 'ig-s1', reason: 'trim' });

    await assert.rejects(
      deliverUserInput({ viewerAgentId: 'viewer-ig-1', text: ' ', images: ['/tmp/a.png'] }, { integration }),
      (err) => err.code === 'thread_handoff_images_unsupported',
    );
  });

  test('race closure: delivers immediately when succession lands between route resolution and append', async () => {
    const turns = [];
    const { controller, integration } = makeFixture({
      enabled: true,
      resolveRuntimeViewerId: (agentId, sessionId) => (sessionId === 'ig-s2' ? 'viewer-ig-2' : null),
      submitTurn: async (params) => {
        turns.push(params);
        return { success: true };
      },
    });
    const thread = await controller.createThread({ agentId: 'coder', sessionId: 'ig-s1' });
    await integration.beginSessionSuccession({ agentId: 'coder', sessionId: 'ig-s1', reason: 'trim' });

    // 模拟竞态：网关路由判定（读到 fresh 交接）之后、appendCommand 落盘
    // 之前，succession 完成（advanceHead 清挡板 + 投递过一轮空投递）。
    const realAppend = controller.appendCommand.bind(controller);
    const racingController = Object.create(controller);
    racingController.appendCommand = async (params) => {
      await controller.advanceHead({ threadId: thread.threadId, toSessionId: 'ig-s2', fromSessionId: 'ig-s1', endKind: 'trim' });
      return realAppend(params);
    };
    const racingIntegration = {
      ...integration,
      controller: racingController,
      tryDeliver: integration.tryDeliver.bind(integration),
    };

    const result = await deliverUserInput(
      { viewerAgentId: 'viewer-ig-1', text: '请继续' },
      { integration: racingIntegration },
    );

    // 无补投递时该指令会永远 pending（applySessionSuccession 已投递过，
    // 之后无人触发）；补投递后当场送达新 head。
    assert.equal(result.delivery, 'thread_queued');
    assert.equal(result.deliveryAttempt?.delivered, 1);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].agentId, 'viewer-ig-2');
    assert.equal(turns[0].text, '请继续');
    assert.equal(turns[0].sourceRef, result.commandId);

    const record = await controller.getThread(thread.threadId);
    assert.equal(record.headSessionId, 'ig-s2');
    assert.equal(record.commands[0].status, ThreadCommandStatus.DELIVERED);
  });
});
