/**
 * 线程寻址输入端点 — POST /protoclaw/threads/:threadId/input（ADR-0024 决策 3）
 *
 * 薄入口职责：threadId → head runtime（resolveSessionViewerId）→ 统一网关
 * deliverUserInput（head 健康 → 直投；交接窗口 → Inbox 暂存；终态 → 拒绝，
 * 全部路由判定由网关复用）；head runtime 未运行时先经 ensureHeadRuntime
 * 唤起（与 commands 端点同语义）。本文件只验证入口的解析 / 唤起 / 响应
 * 形状与错误映射；网关与 bridge 的身份链路在 thread-control.test.js 与
 * input-gateway-queue.test.js。
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

function makeApp({ thread = BASE_THREAD, resolveSessionViewerId, ensureHeadRuntime, deliverInput } = {}) {
  const app = makeMockApp();
  setupThreadRoutes(app, makeMockExpress(), {
    control: {
      core: { getThread: async () => thread },
      board: {},
      archive: { resolveCommandRejection: async () => null },
      resolveSessionViewerId,
    },
    lifecycle: {
      archiveThread: async () => ({}),
      unarchiveThread: async () => ({}),
    },
    ensureHeadRuntime,
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

describe('threads/:threadId/input — 线程寻址输入端点', () => {
  test('resolves the head runtime and delegates to the gateway with full field passthrough', async () => {
    const delivered = [];
    const app = makeApp({
      resolveSessionViewerId: (agentId, sessionId) => (sessionId === 'sess-head' ? 'viewer-head' : null),
      deliverInput: async (input) => {
        delivered.push(input);
        return { success: true, delivery: 'thread_queued', threadId: 'wt-in', commandId: 'cmd-9', duplicate: false };
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
    // 返回形状沿用 gateway + head 事实
    assert.equal(res.body.delivery, 'thread_queued');
    assert.equal(res.body.commandId, 'cmd-9');
    assert.equal(res.body.threadId, 'wt-in');
    assert.equal(res.body.agentId, 'programming-helper');
    assert.equal(res.body.headSessionId, 'sess-head');
    assert.equal(res.body.headViewerAgentId, 'viewer-head');
    // 网关入参：服务端解析的 head viewer id + 全字段透传（identity / 附件 /
    // 元数据与 /api/agents/:id/user-turn 代理同形）
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].viewerAgentId, 'viewer-head');
    assert.equal(delivered[0].text, '继续');
    assert.equal(delivered[0].kind, 'reminder');
    assert.deepEqual(delivered[0].images, ['/uploads/a.png']);
    assert.equal(delivered[0].source, 'thread-stream');
    assert.equal(delivered[0].sourceRef, 'evt-1');
    assert.deepEqual(delivered[0].capabilityActivations, ['skill-a', '']);
    assert.deepEqual(delivered[0].turnMetadata, { 'session-reference': [{ sessionId: 's-7' }] });
  });

  test('wakes a missing head runtime before delivering (commands-endpoint semantics)', async () => {
    const wakeCalls = [];
    let wakeCount = 0;
    const delivered = [];
    const app = makeApp({
      // 首次解析无 runtime（server 重启后），唤起成功后可解析
      resolveSessionViewerId: () => (wakeCount > 0 ? 'viewer-woken' : null),
      ensureHeadRuntime: async (agentId, sessionId) => {
        wakeCount += 1;
        wakeCalls.push({ agentId, sessionId });
        return { ok: true };
      },
      deliverInput: async (input) => {
        delivered.push(input);
        return { success: true, delivery: 'delivered' };
      },
    });

    const res = await callInput(app, { text: 'hello' });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(wakeCalls, [{ agentId: 'programming-helper', sessionId: 'sess-head' }]);
    assert.equal(delivered[0].viewerAgentId, 'viewer-woken');
    assert.equal(res.body.delivery, 'delivered');
    assert.equal(res.body.runtimeWake, undefined, '唤起成功对调用方透明（与 commands 端点同形）');
  });

  test('wake failure surfaces as an explicit error with the runtimeWake fact (no fake thread_queued)', async () => {
    const delivered = [];
    const app = makeApp({
      resolveSessionViewerId: () => null,
      ensureHeadRuntime: async () => ({
        ok: false,
        code: 'head_session_missing',
        message: 'head session sess-head not found in session index',
      }),
      deliverInput: async (input) => {
        delivered.push(input);
        return { success: true, delivery: 'thread_queued' };
      },
    });

    const res = await callInput(app, { text: 'hello' });

    // 网关以 viewer id 反查路由：无 head runtime 即无投递承接点。commands
    // 端点此时仍入箱（appendCommand 不依赖 runtime）；本端点显式失败，
    // 不伪装暂存——thread_queued 只在网关能判定线程域事实时出现。
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, 'head_session_missing');
    assert.equal(res.body.runtimeWake.code, 'head_session_missing');
    assert.equal(delivered.length, 0, '唤起失败不得进入网关投递');
  });

  test('no ready gate injected and head runtime missing → explicit head_runtime_unavailable', async () => {
    const app = makeApp({ resolveSessionViewerId: () => null });

    const res = await callInput(app, { text: 'hello' });

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, 'head_runtime_unavailable');
    assert.equal(res.body.runtimeWake, undefined);
  });

  test('unknown thread → 404 thread_not_found', async () => {
    const app = makeApp({
      thread: null,
      resolveSessionViewerId: () => 'viewer-head',
      deliverInput: async () => { throw new Error('must not be called'); },
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
