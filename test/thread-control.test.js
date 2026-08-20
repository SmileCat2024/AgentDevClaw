/**
 * 工作线程地基（thread-control）测试
 *
 * 覆盖：
 * - ThreadStore：持久化、revision 自增、乐观并发、串行锁、无变更跳写
 * - ThreadController：创建、幂等指令、head 推进事务、取消语义
 * - ThreadRuntimeBridge：休眠默认、启用后 envelope 下沉、runtime 未就绪重试
 * - CallEnvelope：threadId / commandId 透传与快照输出
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
  pendingCommands,
  appendCommand,
  pruneCommands,
  ThreadCommandStatus,
} from '../server/thread-control/thread-inbox.js';
import {
  createCallEnvelope,
  enqueueRuntimeEnvelope,
  getRuntimeInboxSnapshot,
  releaseRuntimeState,
  resetAllInboxes,
  EnvelopeSource,
} from '../server/runtime-call-envelope.js';

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

describe('ThreadRuntimeBridge (enabled) + envelope integration', () => {
  let root;
  before(async () => {
    root = await makeTempRoot();
    resetAllInboxes();
  });
  after(async () => {
    releaseRuntimeState('agent-x::head-2');
    resetAllInboxes();
    await fs.rm(root, { recursive: true, force: true });
  });

  test('delivers pending command into head runtime inbox with thread metadata', async () => {
    const accepting = new Set(['agent-x::head-2']);
    const { controller } = makeController(root, {
      enabled: true,
      isRuntimeAccepting: (key) => accepting.has(key),
    });

    const thread = await controller.createThread({ agentId: 'agent-x', sessionId: 'old-1' });
    await controller.appendCommand({ threadId: thread.threadId, text: '请继续', idempotencyKey: 'k1' });

    // 旧 head 不接收 → 指令保持 pending（等待 head 推进）
    let result = await controller.deliverPendingCommands(thread.threadId);
    assert.equal(result.delivered, 0);
    assert.equal(result.reason, 'runtime_not_accepting');
    let record = await controller.getThread(thread.threadId);
    assert.equal(record.commands[0].status, ThreadCommandStatus.PENDING);

    // head 推进到新会话后投递成功
    await controller.advanceHead({ threadId: thread.threadId, toSessionId: 'head-2', fromSessionId: 'old-1' });
    result = await controller.deliverPendingCommands(thread.threadId);
    assert.equal(result.delivered, 1);
    assert.equal(result.reason, null);

    record = await controller.getThread(thread.threadId);
    const command = record.commands[0];
    assert.equal(command.status, ThreadCommandStatus.DELIVERED);
    assert.ok(command.envelopeId);

    const snapshot = getRuntimeInboxSnapshot('agent-x::head-2');
    assert.equal(snapshot.queueLength, 1);
    assert.equal(snapshot.envelopes[0].source, EnvelopeSource.THREAD);
    assert.equal(snapshot.envelopes[0].threadId, thread.threadId);
    assert.equal(snapshot.envelopes[0].commandId, command.commandId);
  });
});

describe('CallEnvelope thread pass-through', () => {
  after(() => {
    resetAllInboxes();
  });

  test('thread fields default empty for legacy creation', () => {
    const envelope = createCallEnvelope({ runtimeKey: 'a::s', text: 'hi' });
    assert.equal(envelope.threadId, '');
    assert.equal(envelope.commandId, '');
  });

  test('thread fields carried into envelope and snapshot', () => {
    const envelope = createCallEnvelope({
      runtimeKey: 'a::s',
      text: 'hi',
      source: EnvelopeSource.THREAD,
      sourceRef: 'cmd-1',
      threadId: 'wt-1',
      commandId: 'cmd-1',
    });
    enqueueRuntimeEnvelope(envelope);
    const snapshot = getRuntimeInboxSnapshot('a::s');
    assert.equal(snapshot.envelopes[0].threadId, 'wt-1');
    assert.equal(snapshot.envelopes[0].commandId, 'cmd-1');
    releaseRuntimeState('a::s');
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
