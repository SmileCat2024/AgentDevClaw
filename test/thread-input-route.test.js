/**
 * 线程寻址输入端点 — POST /protoclaw/threads/:threadId/input（ADR-0024 决策 3）
 *
 * 契约：threadId 就是路由事实，端点把它交给统一网关（deliverThreadInput）
 * 完成接受性判定与入箱；**head runtime 是否存在不参与接受判定**。接续窗口
 * 里旧 head 已退役、新 head 未 ready 是正常状态，此时输入必须被接住并留在
 * Thread Inbox，等 runtime-ready / head 推进 / 显式 deliver 触发点补投。
 *
 * head runtime 的唤起与补投是接受之后的承接点保障：失败作为 runtimeWake
 * 事实回报，绝不把「已接住」变回失败（旧实现在这里 503，导致接续期间完全
 * 无法发送）。
 *
 * 网关自身的接受性判定与入箱在 input-gateway-queue.test.js 覆盖；本文件只
 * 验证端点编排（顺序、唤起条件、响应形状、错误映射）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { setupThreadRoutes } from '../server/thread-control/thread-routes.js';
import { UserTurnDeliveryError } from '../server/shared/user-turn.js';

function makeMockApp() {
  const routes = {};
  const mockApp = {
    get: (path, ...handlers) => { routes[`GET ${path}`] = handlers; },
    post: (path, ...handlers) => { routes[`POST ${path}`] = handlers; },
    put: (path, ...handlers) => { routes[`PUT ${path}`] = handlers; },
    delete: (path, ...handlers) => { routes[`DELETE ${path}`] = handlers; },
  };
  mockApp._routes = routes;
  return mockApp;
}

function makeMockExpress() {
  return { json: () => (_req, _res, next) => next?.() };
}

function makeMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
}

const BASE_THREAD = {
  threadId: 'wt-in',
  agentId: 'programming-helper',
  headSessionId: 'sess-head',
  status: 'open',
  commands: [],
};

function makeApp({
  thread = BASE_THREAD,
  resolveSessionViewerId,
  ensureHeadRuntime,
  tryDeliver,
  deliverInput,
  archiveRejection = null,
  getThread,
} = {}) {
  const app = makeMockApp();
  setupThreadRoutes(app, makeMockExpress(), {
    control: {
      core: { getThread: getThread || (async () => thread) },
      board: {},
      archive: { resolveCommandRejection: async () => archiveRejection },
      resolveSessionViewerId,
    },
    lifecycle: {
      archiveThread: async () => ({}),
      unarchiveThread: async () => ({}),
    },
    ensureHeadRuntime,
    tryDeliver,
    deliverInput,
    resolveSessionOpenDirectory: async () => null,
  });
  return app;
}

async function callInput(app, body, threadId = 'wt-in') {
  const handlers = app._routes['POST /protoclaw/threads/:threadId/input'];
  assert.ok(Array.isArray(handlers), 'input route must be registered');
  const res = makeMockRes();
  await handlers[handlers.length - 1]({ params: { threadId }, body }, res);
  return res;
}

const INBOX_RESULT = {
  success: true,
  delivery: 'thread_queued',
  threadId: 'wt-in',
  commandId: 'cmd-9',
  duplicate: false,
};

describe('threads/:threadId/input — 线程寻址输入端点', () => {
  test('hands threadId to the gateway with full field passthrough', async () => {
    const delivered = [];
    const app = makeApp({
      resolveSessionViewerId: () => 'viewer-head',
      deliverInput: async (input) => {
        delivered.push(input);
        return { ...INBOX_RESULT, deliveryAttempt: { attempted: 1, delivered: 1 } };
      },
    });

    const res = await callInput(app, {
      text: '继续',
      kind: 'reminder',
      images: ['/uploads/a.png'],
      source: 'thread-stream',
      sourceRef: 'evt-1',
      capabilityActivations: ['skill-a', 42, ''],
      metadata: { 'session-reference': [{ sessionId: 's-7' }] },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.delivery, 'thread_queued');
    assert.equal(res.body.commandId, 'cmd-9');
    assert.equal(res.body.threadId, 'wt-in');
    assert.equal(res.body.agentId, 'programming-helper');
    assert.equal(res.body.headSessionId, 'sess-head');
    assert.equal(res.body.headViewerAgentId, 'viewer-head');
    // 网关入参：路由事实是 threadId（不是 viewer id），全字段透传
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].threadId, 'wt-in');
    assert.equal(delivered[0].viewerAgentId, undefined, '不接受判定的路径不再需要 viewer id');
    assert.equal(delivered[0].text, '继续');
    assert.equal(delivered[0].kind, 'reminder');
    assert.deepEqual(delivered[0].images, ['/uploads/a.png']);
    assert.equal(delivered[0].source, 'thread-stream');
    assert.equal(delivered[0].sourceRef, 'evt-1');
    assert.deepEqual(delivered[0].capabilityActivations, ['skill-a', '']);
    assert.deepEqual(delivered[0].turnMetadata, { 'session-reference': [{ sessionId: 's-7' }] });
  });

  test('accepts input while the head runtime is absent (succession window) without blocking on the wake', async () => {
    const wakeCalls = [];
    let resolveWake;
    const wakeGate = new Promise((resolve) => { resolveWake = resolve; });
    const app = makeApp({
      resolveSessionViewerId: () => null,
      // 唤起可能等满 20s（runtime READY 等待）：端点不得同步等它，否则输入框
      // 一直转圈、消息气泡挂住——输入其实早已被接住。
      ensureHeadRuntime: async (agentId, sessionId) => {
        wakeCalls.push({ agentId, sessionId });
        await wakeGate;
        return { ok: true };
      },
      deliverInput: async () => ({
        ...INBOX_RESULT,
        // 没有 runtime 承接：投递尝试被客观门禁拦下，指令留在 Inbox
        deliveryAttempt: { attempted: 0, delivered: 0, reason: 'runtime_not_accepting' },
      }),
    });

    const res = await callInput(app, { text: '接续期间的输入' });

    // 输入已被接住：这是成功，不是失败。旧实现在这里返回 503，导致接续期间
    // 完全无法发送（暂存等接续的能力在最需要它时失效）。
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.delivery, 'thread_queued');
    assert.equal(res.body.deliveryAttempt.delivered, 0);
    // 唤起在后台推进，回应不等它
    await Promise.resolve();
    assert.deepEqual(wakeCalls, [{ agentId: 'programming-helper', sessionId: 'sess-head' }]);
    resolveWake();
  });

  test('does not wake the head runtime when the input already landed', async () => {
    const wakeCalls = [];
    const app = makeApp({
      resolveSessionViewerId: () => 'viewer-head',
      ensureHeadRuntime: async () => { wakeCalls.push('wake'); return { ok: true }; },
      deliverInput: async () => ({ ...INBOX_RESULT, deliveryAttempt: { attempted: 1, delivered: 1 } }),
    });

    const res = await callInput(app, { text: 'hello' });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.deliveryAttempt.delivered, 1);
    assert.deepEqual(wakeCalls, []);
  });

  test('skips the wake while the thread is rotating (the succession transaction owns the runtime swap)', async () => {
    const wakeCalls = [];
    const app = makeApp({
      thread: { ...BASE_THREAD, status: 'rotating' },
      resolveSessionViewerId: () => null,
      ensureHeadRuntime: async () => { wakeCalls.push('wake'); return { ok: true }; },
      deliverInput: async () => ({ ...INBOX_RESULT, deliveryAttempt: { attempted: 0, delivered: 0 } }),
    });

    const res = await callInput(app, { text: '交接中' });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.delivery, 'thread_queued');
    assert.deepEqual(wakeCalls, [], '交接中不外部拉起旧 head，避免产生即将退役的实例');
  });

  test('unknown thread → 404 thread_not_found (gateway owns the verdict)', async () => {
    const app = makeApp({
      deliverInput: async () => {
        throw new UserTurnDeliveryError('Thread wt-missing not found', {
          code: 'thread_not_found',
          status: 404,
          retryable: false,
        });
      },
    });

    const res = await callInput(app, { text: 'hello' }, 'wt-missing');

    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, 'thread_not_found');
  });

  test('gateway verdicts pass through unchanged (thread_closed → 409)', async () => {
    const app = makeApp({
      resolveSessionViewerId: () => 'viewer-head',
      deliverInput: async () => {
        throw new UserTurnDeliveryError('This thread is closed; start a new session to continue the work', {
          code: 'thread_closed',
          status: 409,
          retryable: false,
        });
      },
    });

    const res = await callInput(app, { text: 'late input' });

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, 'thread_closed');
  });
});
