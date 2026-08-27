import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * R6 网关队列化：线程域输入一律经 Thread Inbox，直投仅保留给纯 session 域。
 *
 * 路由判定不再依赖「fresh 交接挡板」与 runtime 存活性——那是窗口判定，
 * 不是域判定。域判定只有一条事实：收件会话是某活跃线程的 head。
 *   - closed 线程：硬终态，显式拒绝（thread_closed），指令不得入箱滞留；
 *   - hold / rotating / rotation_failed：入箱暂存，投递时机由 deliver 序列把关；
 *   - 纯 session（无线程 / 非 host / 解析失败）：原样直投 viewer user-turn。
 */

const { deliverUserInput, UserTurnDeliveryError } = await import('../server/thread-control/input-gateway.js');
const { managedAgents } = await import('../server/shared/agent-access.js');

function registerRuntime({ viewerAgentId = 'viewer-1', agentId = 'programming-helper', sessionId = 'session-1', sessionType = 'coder' } = {}) {
  const runtime = {
    id: `${agentId}::${sessionId}`,
    agentId,
    viewerAgentId,
    selectedSessionId: sessionId,
    sessionType,
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
    registerRuntime({ sessionType: 'main' });
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
