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
import { UserTurnDeliveryError } from '../server/shared/user-turn.js';

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
      status: 'active',
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
      status: 'active',
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
      status: 'active',
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
      status: 'active',
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

    await controller.cancelThread(thread.threadId);
    await assert.rejects(
      () => controller.advanceHead({ threadId: thread.threadId, toSessionId: 's3' }),
      (err) => err.code === 'thread_not_active',
    );
    assert.equal(advanced.status, 'active'); // cancel 前的返回值不受影响
  });

  test('cancelThread cancels pending commands', async () => {
    const { controller } = makeController(root);
    const thread = await controller.createThread({ agentId: 'a', sessionId: 's1' });
    await controller.appendCommand({ threadId: thread.threadId, text: 'x', idempotencyKey: 'k1' });

    const cancelled = await controller.cancelThread(thread.threadId, { reason: 'user' });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.commands[0].status, ThreadCommandStatus.CANCELLED);
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
    assert.equal(turns[0].viewerAgentId, 'viewer-abc');
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

  test('applySessionSuccession is no-op for non-host agents and non-head sessions', async () => {
    const { controller, integration } = makeIntegration();

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
    assert.equal(record.status, 'cancelled');
    assert.equal(record.cancelReason, 'head_session_deleted');
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
    assert.equal(turns[0].viewerAgentId, 'viewer-ig-2');
    assert.equal(turns[0].text, '请继续');
    assert.equal(turns[0].sourceRef, result.commandId);

    const record = await controller.getThread(thread.threadId);
    assert.equal(record.headSessionId, 'ig-s2');
    assert.equal(record.commands[0].status, ThreadCommandStatus.DELIVERED);
  });
});
