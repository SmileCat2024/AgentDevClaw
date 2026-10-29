import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundAccess, WorkThread, WorkThreadStore } from '@agentdevjs/core';
import { createViewerUserTurnDeliver } from '@agentdevjs/shell-feature';

/**
 * R6 网关队列化：线程域输入一律经 Thread Inbox，直投仅保留给纯 session 域。
 *
 * 路由判定不再依赖「fresh 交接挡板」与 runtime 存活性——那是窗口判定，
 * 不是域判定。域判定只有一条事实：收件会话是某活跃线程的 head。
 *   - closed 线程：硬终态，显式拒绝（thread_closed），指令不得入箱滞留；
 *   - hold / rotating / rotation_failed：入箱暂存，投递时机由 deliver 序列把关；
 *   - 纯 session（无线程 / 非 host / 解析失败）：原样直投 viewer user-turn。
 */

const { deliverUserInput, deliverThreadInput, UserTurnDeliveryError } = await import('../server/thread-control/input-gateway.js');
const { managedAgents } = await import('../server/shared/agent-access.js');
const { registerThreadHostAgents } = await import('../server/thread-control/host-agents.js');

// 宿主判定声明化（ADR-0024 可拔插）：网关路由闸按宿主集合分流线程域 /
// session 域，注册构造场景后断言语义与硬编码时代一致。
registerThreadHostAgents(['coder']);

function registerRuntime({ viewerAgentId = 'viewer-1', agentId = 'coder', sessionId = 'session-1' } = {}) {
  const runtime = {
    id: `${agentId}::${sessionId}`,
    agentId,
    viewerAgentId,
    selectedSessionId: sessionId,
    stopped: false,
    stopping: false,
    process: { exitCode: null, signalCode: null },
    startedAt: '2026-01-01T00:00:00.000Z',
  };
  managedAgents.set(runtime.id, runtime);
  return runtime;
}

function buildIntegration({ thread = null } = {}) {
  const calls = { append: [], deliver: [] };
  return {
    calls,
    core: {
      findThreadByHeadSession: async () => thread,
      findThreadBySession: async () => thread,
      isHandoffActive: () => false,
      appendCommand: async (input) => {
        calls.append.push(input);
        return { command: { commandId: `cmd-${calls.append.length}` }, duplicate: false };
      },
    },
    findThreadBySession: async () => thread,
    tryDeliver: async (threadId) => {
      calls.deliver.push(threadId);
      return { attempted: 1, delivered: 1 };
    },
  };
}

let submitted;

beforeEach(() => {
  managedAgents.clear();
  submitted = [];
});

describe('background notice identity through the thread gateway (ADR-0031)', () => {
  it('keeps successive notices distinct, deduplicates replay, and retains every work reference', async (t) => {
    const rootDir = await mkdtemp(join(tmpdir(), 'claw-notice-gateway-'));
    t.after(() => rm(rootDir, { recursive: true, force: true }));
    registerRuntime();
    const core = new WorkThread({ store: new WorkThreadStore({ rootDir }) });
    const thread = await core.start({ sessionRef: { agentId: 'coder', sessionId: 'session-1' } });
    const integration = { core };
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; managedAgents.clear(); });
    const received = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      received.push(body);
      const result = await deliverUserInput({
        viewerAgentId: 'viewer-1',
        text: body.text,
        source: body.source,
        sourceRef: body.sourceRef,
        kind: body.kind,
        turnMetadata: body.metadata,
      }, { integration, fetchImpl: async () => { throw new Error('must use the inbox'); } });
      return new Response(JSON.stringify(result));
    };
    const deliver = createViewerUserTurnDeliver('viewer-1');
    const batches = [];
    let onDelivered;
    const access = new BackgroundAccess({
      source: 'shell', sessionId: 'session-1',
      deliver: async (event) => { batches.push(event); await deliver(event); onDelivered?.(); },
    });
    t.after(() => access.dispose());
    access.registerWork({ id: 'bg-1', summary: 'build' });
    access.registerWork({ id: 'bg-2', summary: 'test' });

    async function submit(text, terminal = false) {
      let keepAlive;
      const done = new Promise((resolve, reject) => {
        onDelivered = resolve;
        // The production aggregation timer is unref'ed; bound this test's wait.
        keepAlive = setTimeout(() => reject(new Error('notice was not delivered')), 1_000);
      });
      // Wait at the injected transport, without accessing implementation state.
      access.submitNotice({ workId: 'bg-1', text, terminal });
      if (terminal) access.submitNotice({ workId: 'bg-2', text: 'test done', terminal: true });
      try { await done; } finally { clearTimeout(keepAlive); onDelivered = null; }
    }
    await submit('progress one');
    await submit('progress two');
    await submit('build done', true);
    assert.equal(new Set(received.map((body) => body.sourceRef)).size, 3);
    assert.deepEqual(received[2].metadata.shell.taskIds, ['bg-1', 'bg-2']);
    assert.equal(received[2].sessionId, 'session-1');
    await deliver(batches[2]); // Replaying one notification must not append another command.
    const saved = await core.getThread(thread.threadId);
    assert.equal(saved.commands.length, 3);
    assert.deepEqual(saved.commands.map((command) => command.originSourceRef), batches.map((event) => event.eventId));
    assert.deepEqual(saved.commands[2].metadata.shell.taskIds, ['bg-1', 'bg-2']);
  });
});

describe('input gateway thread-domain queueing (R6)', () => {
  it('stages thread-head input to the inbox with no handoff in progress', async () => {
    // A11 收口：无挡板时旧实现直投；队列化后线程域一律入箱 + 即时投递尝试。
    registerRuntime();
    const integration = buildIntegration({
      thread: { threadId: 'wt-1', status: 'open', headSessionId: 'session-1', hold: false, pendingSuccession: null },
    });

    const result = await deliverUserInput(
      { viewerAgentId: 'viewer-1', text: '继续', source: 'chat-composer' },
      { integration, fetchImpl: async () => { throw new Error('direct submit must not happen'); } },
    );

    assert.equal(result.delivery, 'thread_queued');
    assert.equal(result.threadId, 'wt-1');
    assert.equal(integration.calls.append.length, 1);
    assert.equal(integration.calls.append[0].kind, 'user_message');
    assert.deepEqual(integration.calls.deliver, ['wt-1']);
  });

  it('carries turn metadata into the thread command (and accepts metadata-only turns)', async () => {
    // 线程域与直投域行为一致：会话引用等 user-turn 自由元数据随指令入箱，
    // 投递时经 bridge.submitTurn 原样转发，不再在线程域被丢弃。
    registerRuntime();
    const integration = buildIntegration({
      thread: { threadId: 'wt-1', status: 'open', headSessionId: 'session-1', hold: false, pendingSuccession: null },
    });
    const turnMetadata = { 'session-reference': [{ agentId: 'programming-helper', sessionId: 'session-7', title: '引用' }] };

    await deliverUserInput(
      { viewerAgentId: 'viewer-1', text: '带引用的输入', source: 'chat-composer', turnMetadata },
      { integration, fetchImpl: async () => { throw new Error('direct submit must not happen'); } },
    );

    assert.equal(integration.calls.append.length, 1);
    assert.deepEqual(integration.calls.append[0].metadata, turnMetadata);

    // metadata-only（空文本占位）不再被网关拒绝
    await deliverUserInput(
      { viewerAgentId: 'viewer-1', text: ' ', source: 'chat-composer', turnMetadata: { ref: 1 } },
      { integration, fetchImpl: async () => { throw new Error('direct submit must not happen'); } },
    );
    assert.equal(integration.calls.append.length, 2);
    assert.deepEqual(integration.calls.append[1].metadata, { ref: 1 });
  });

  it('stages input while the thread is held or rotating (administrative states queue, not bounce)', async () => {
    registerRuntime();
    const integration = buildIntegration({
      thread: { threadId: 'wt-1', status: 'rotating', headSessionId: 'session-1', hold: true, pendingSuccession: { startedAt: Date.now() } },
    });

    const result = await deliverUserInput(
      { viewerAgentId: 'viewer-1', text: '补充需求' },
      { integration, fetchImpl: async () => { throw new Error('direct submit must not happen'); } },
    );

    assert.equal(result.delivery, 'thread_queued');
    assert.equal(integration.calls.append.length, 1);
  });

  it('stages input for a rotation_failed thread (recovery entry owns the retry)', async () => {
    registerRuntime();
    const integration = buildIntegration({
      thread: { threadId: 'wt-1', status: 'rotation_failed', headSessionId: 'session-1', hold: false, pendingSuccession: { stage: 'compact_or_successor' } },
    });

    const result = await deliverUserInput(
      { viewerAgentId: 'viewer-1', text: '再试一次' },
      { integration, fetchImpl: async () => { throw new Error('direct submit must not happen'); } },
    );

    assert.equal(result.delivery, 'thread_queued');
  });

  it('rejects input for a closed thread with an explicit thread_closed error', async () => {
    registerRuntime();
    const integration = buildIntegration({
      thread: { threadId: 'wt-1', status: 'closed', headSessionId: 'session-1', hold: false, pendingSuccession: null },
    });

    await assert.rejects(
      deliverUserInput({ viewerAgentId: 'viewer-1', text: 'late input' }, { integration }),
      (error) => error instanceof UserTurnDeliveryError
        && error.code === 'thread_closed'
        && error.status === 409,
    );
    assert.equal(integration.calls.append.length, 0);
  });

  it('rejects input for an archived thread with thread_archived (archive verdict is shared)', async () => {
    // A8 收口：归档拒收不再只挂在 HTTP 端点，网关主路径同样拦截——
    // 归档后 runtime 已停，入箱只会在 unarchive 前永久滞留。
    registerRuntime();
    const integration = buildIntegration({
      thread: { threadId: 'wt-1', status: 'open', headSessionId: 'session-1', hold: false, pendingSuccession: null },
    });
    const archived = new Set(['wt-1']);
    integration.archive = {
      resolveCommandRejection: async (threadId) => (archived.has(threadId)
        ? { code: 'thread_archived', status: 409 }
        : null),
    };

    await assert.rejects(
      deliverUserInput({ viewerAgentId: 'viewer-1', text: '归档后输入' }, { integration }),
      (error) => error instanceof UserTurnDeliveryError
        && error.code === 'thread_archived'
        && error.status === 409,
    );
    assert.equal(integration.calls.append.length, 0, '归档线程的指令不得入箱');
  });

  it('queues input when the archive verdict is clear (unarchived thread passes)', async () => {
    registerRuntime();
    const integration = buildIntegration({
      thread: { threadId: 'wt-1', status: 'open', headSessionId: 'session-1', hold: false, pendingSuccession: null },
    });
    integration.archive = { resolveCommandRejection: async () => null };

    const result = await deliverUserInput(
      { viewerAgentId: 'viewer-1', text: '正常输入' },
      { integration, fetchImpl: async () => { throw new Error('direct submit must not happen'); } },
    );
    assert.equal(result.delivery, 'thread_queued');
  });

  it('carries images into the inbox (K8: handoff windows no longer bounce image input)', async () => {
    registerRuntime();
    const integration = buildIntegration({
      thread: { threadId: 'wt-1', status: 'rotating', headSessionId: 'session-1', pendingSuccession: { startedAt: Date.now() } },
    });

    const result = await deliverUserInput(
      { viewerAgentId: 'viewer-1', text: '看这张图', images: ['/uploads/a.png'] },
      { integration, fetchImpl: async () => { throw new Error('direct submit must not happen'); } },
    );

    assert.equal(result.delivery, 'thread_queued');
    assert.deepEqual(integration.calls.append[0].images, ['/uploads/a.png']);
  });

  it('direct-routes pure session input unchanged (no thread found)', async () => {
    registerRuntime({ agentId: 'programming-helper' });
    const integration = buildIntegration({ thread: null });

    const result = await deliverUserInput(
      { viewerAgentId: 'viewer-1', text: 'hello', source: 'chat-composer' },
      {
        integration,
        fetchImpl: async (url, init) => {
          submitted.push({ url, body: JSON.parse(init.body) });
          return { ok: true, json: async () => ({ success: true, delivery: 'delivered' }) };
        },
      },
    );

    assert.equal(result.delivery, 'delivered');
    assert.equal(integration.calls.append.length, 0);
    assert.match(submitted[0].url, /\/api\/agents\/viewer-1\/user-turn$/);
    assert.equal(submitted[0].body.text, 'hello');
  });

  it('rejects writes to historical (non-head) thread members', async () => {
    registerRuntime({ sessionId: 'session-old' });
    const integration = buildIntegration({
      thread: { threadId: 'wt-1', status: 'open', headSessionId: 'session-new', hold: false, pendingSuccession: null },
    });

    await assert.rejects(
      deliverUserInput({ viewerAgentId: 'viewer-1', text: 'history write' }, { integration }),
      (error) => error instanceof UserTurnDeliveryError && error.code === 'session_not_head',
    );
    assert.equal(integration.calls.append.length, 0);
  });

  it('forwards the reminder identity on direct routes (machine notifications never impersonate users)', async () => {
    registerRuntime({ agentId: 'programming-helper' });
    const integration = buildIntegration({ thread: null });

    const result = await deliverUserInput(
      { viewerAgentId: 'viewer-1', text: '通过右侧页面「设置」执行「保存」', kind: 'reminder', source: 'generative-ui' },
      {
        integration,
        fetchImpl: async (url, init) => {
          submitted.push({ url, body: JSON.parse(init.body) });
          return { ok: true, json: async () => ({ success: true, delivery: 'queued', id: 'q-1', queueLength: 1 }) };
        },
      },
    );

    assert.equal(result.delivery, 'queued');
    assert.equal(submitted[0].body.kind, 'reminder');
  });

  it('stages reminder turns on thread routes with the command identity preserved', async () => {
    // ADR-0024 决策 3：WorkThread command 契约已有 turn 身份槽位，reminder
    // 与用户消息同享线程行政检查——入箱身份不丢失，投递时经 bridge 原样转发
    //（落地为带 source 的 system 消息，见 thread-control.test.js 链路用例）。
    registerRuntime();
    const integration = buildIntegration({
      thread: { threadId: 'wt-1', status: 'open', headSessionId: 'session-1', hold: false, pendingSuccession: null },
    });

    const result = await deliverUserInput(
      { viewerAgentId: 'viewer-1', text: '机器通报', kind: 'reminder', source: 'generative-ui' },
      { integration, fetchImpl: async () => { throw new Error('direct submit must not happen'); } },
    );

    assert.equal(result.delivery, 'thread_queued');
    assert.equal(integration.calls.append.length, 1);
    assert.equal(integration.calls.append[0].kind, 'reminder');
  });

  it('normalizes unknown input identities to plain user turns instead of rejecting', async () => {
    // 词汇归一在网关单点完成：缺失 / 'user' / 未知值一律归一为 user_message
    //（appendCommand 对未知 command kind 显式拒绝，归一必须发生在入箱前）。
    registerRuntime();
    const integration = buildIntegration({
      thread: { threadId: 'wt-1', status: 'open', headSessionId: 'session-1', hold: false, pendingSuccession: null },
    });

    const result = await deliverUserInput(
      { viewerAgentId: 'viewer-1', text: 'x', kind: 'bot' },
      { integration, fetchImpl: async () => { throw new Error('direct submit must not happen'); } },
    );

    assert.equal(result.delivery, 'thread_queued');
    assert.equal(integration.calls.append[0].kind, 'user_message');

    // 直投域同源归一：未知身份省略 kind 字段（user-turn 契约缺省即 user）
    registerRuntime({ agentId: 'programming-helper' });
    const direct = buildIntegration({ thread: null });
    const directResult = await deliverUserInput(
      { viewerAgentId: 'viewer-1', text: 'x', kind: 'bot' },
      {
        integration: direct,
        fetchImpl: async (_url, init) => {
          submitted.push(JSON.parse(init.body));
          return { ok: true, json: async () => ({ success: true, delivery: 'delivered' }) };
        },
      },
    );
    assert.equal(directResult.delivery, 'delivered');
    assert.equal(submitted[0].kind, undefined);
  });

  it('falls back to direct submit when the runtime entry is gone (A12 known window)', async () => {
    // 条目删除的毫秒级窗口：无请求体事实可依，网关如实回退直投，
    // 由 submitUserTurn 报出真实的运行时错误（不伪造线程路由）。
    const integration = buildIntegration({
      thread: { threadId: 'wt-1', status: 'open', headSessionId: 'session-1', hold: false, pendingSuccession: null },
    });

    const result = await deliverUserInput(
      { viewerAgentId: 'viewer-1', text: 'window race' },
      {
        integration,
        fetchImpl: async () => {
          submitted.push('attempted');
          return { ok: false, status: 503, json: async () => ({ success: false, code: 'delivery_unavailable' }) };
        },
      },
    ).catch((error) => error);

    assert.ok(result instanceof UserTurnDeliveryError);
    assert.deepEqual(submitted, ['attempted']);
    assert.equal(integration.calls.append.length, 0);
  });
});

/**
 * 线程寻址输入（deliverThreadInput）：threadId 就是路由事实。
 *
 * 与 runtime 寻址的 deliverUserInput 共享同一套接受性判定与入箱实现，区别
 * 只在归属怎么证明——因此**没有 head runtime 时依然能接受输入**，这正是
 * 接续窗口（旧 head 已退役、新 head 未 ready）必备的能力。
 */
describe('thread-addressed input (deliverThreadInput)', () => {
  const OPEN_THREAD = {
    threadId: 'wt-1',
    agentId: 'coder',
    status: 'open',
    headSessionId: 'session-head',
    hold: false,
    pendingSuccession: null,
    commands: [],
  };

  function buildThreadIntegration(thread = OPEN_THREAD) {
    const calls = { append: [], deliver: [] };
    return {
      calls,
      core: {
        getThread: async () => thread,
        appendCommand: async (input) => {
          calls.append.push(input);
          return { command: { commandId: `cmd-${calls.append.length}` }, duplicate: false };
        },
      },
      tryDeliver: async (threadId) => {
        calls.deliver.push(threadId);
        return { attempted: 0, delivered: 0, reason: 'runtime_not_accepting' };
      },
    };
  }

  it('accepts input with no head runtime in place (succession window) and keeps it pending', async () => {
    // 没有任何 managed runtime 注册：runtime 寻址路径此时连归属都反查不出，
    // 线程寻址路径必须仍能判定「这是 wt-1 的输入」并把指令放进 Inbox。
    const integration = buildThreadIntegration();

    const result = await deliverThreadInput(
      { threadId: 'wt-1', text: '接续期间的输入', source: 'chat-composer' },
      { integration },
    );

    assert.equal(result.delivery, 'thread_queued');
    assert.equal(result.threadId, 'wt-1');
    assert.equal(integration.calls.append.length, 1);
    assert.equal(integration.calls.append[0].text, '接续期间的输入');
    // 投递尝试发生了，但客观门禁（无承接 runtime）拦下：送达是独立结果，
    // 不是接受的附加条件
    assert.equal(result.deliveryAttempt.delivered, 0);
    assert.deepEqual(integration.calls.deliver, ['wt-1']);
  });

  it('carries images and turn metadata into the inbox (same shape as the runtime-addressed path)', async () => {
    const integration = buildThreadIntegration();

    await deliverThreadInput(
      {
        threadId: 'wt-1',
        text: '看这张图',
        images: [{ path: '/uploads/a.png', mediaType: 'image/png' }],
        turnMetadata: { 'session-reference': [{ sessionId: 's-7' }] },
      },
      { integration },
    );

    // 对象形式的附件在入箱前转成路径数组（框架 appendCommand 只认字符串）
    assert.deepEqual(integration.calls.append[0].images, ['/uploads/a.png']);
    assert.deepEqual(integration.calls.append[0].metadata, { 'session-reference': [{ sessionId: 's-7' }] });
  });

  it('rejects a missing thread with thread_not_found instead of silently accepting', async () => {
    const integration = buildThreadIntegration(null);

    await assert.rejects(
      deliverThreadInput({ threadId: 'wt-gone', text: 'x' }, { integration }),
      (error) => error instanceof UserTurnDeliveryError && error.code === 'thread_not_found',
    );
    assert.equal(integration.calls.append.length, 0);
  });

  it('rejects input for a closed thread (terminal state has no future delivery trigger)', async () => {
    const integration = buildThreadIntegration({ ...OPEN_THREAD, status: 'closed' });

    await assert.rejects(
      deliverThreadInput({ threadId: 'wt-1', text: 'late' }, { integration }),
      (error) => error instanceof UserTurnDeliveryError && error.code === 'thread_closed',
    );
    assert.equal(integration.calls.append.length, 0);
  });

  it('rejects input while the thread is being deleted', async () => {
    const integration = buildThreadIntegration({ ...OPEN_THREAD, deleting: true });

    await assert.rejects(
      deliverThreadInput({ threadId: 'wt-1', text: 'x' }, { integration }),
      (error) => error instanceof UserTurnDeliveryError && error.code === 'thread_deleting',
    );
    assert.equal(integration.calls.append.length, 0);
  });

  it('rejects input for an archived thread through the shared archive verdict', async () => {
    const integration = buildThreadIntegration();
    integration.archive = { resolveCommandRejection: async () => ({ code: 'thread_archived', status: 409 }) };

    await assert.rejects(
      deliverThreadInput({ threadId: 'wt-1', text: 'x' }, { integration }),
      (error) => error instanceof UserTurnDeliveryError && error.code === 'thread_archived',
    );
    assert.equal(integration.calls.append.length, 0);
  });

  it('rejects empty input before appending anything', async () => {
    const integration = buildThreadIntegration();

    await assert.rejects(
      deliverThreadInput({ threadId: 'wt-1', text: '   ' }, { integration }),
      (error) => error instanceof UserTurnDeliveryError && error.code === 'invalid_input',
    );
    assert.equal(integration.calls.append.length, 0);
  });
});
