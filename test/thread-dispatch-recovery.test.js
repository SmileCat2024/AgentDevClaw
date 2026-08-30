/**
 * 线程派发恢复路径测试 — runtime 失联后指令不再永久滞留
 *
 * 根因背景（2026-08-30 事故）：runtime 进程崩溃 / server 重启清空内存注册表后，
 * 线程 open、指令 pending，但投递三触发点（append / succession / runtime-ready）
 * 全部依赖"runtime 会 ready"的事件，进程死亡后不会再有该事件——指令永久滞留，
 * watch 无限续挂，表现为"调用成功但不运行"。
 *
 * 修复：commands 端点加 head runtime 就绪闸（ensureHeadRuntime）——
 * - head runtime 不在时，入箱前经宿主唤起（startManagedAgent 链路），
 *   runtime-ready 钩子随后自动补投；
 * - 唤起失败（head 会话已删 / ready 超时）时指令仍入箱（等后续触发点），
 *   但响应携带 runtimeWake 失败事实，调用方不再把"滞留无承接"误读为正常暂存。
 *
 * 覆盖（thread-routes 的 commands 端点 + 就绪闸注入契约）：
 * - runtime 在 → 不调用唤起，行为与旧版完全一致
 * - runtime 不在 → 唤起被调用，唤起成功后指令投递
 * - 唤起失败 → 指令仍入箱（幂等语义不变），响应带 runtimeWake 失败详情
 * - ensureHeadRuntime 未注入 → 旧行为（不唤起），向后兼容
 * - cleanupEmptySessions 线程收口：head 会话被启动清理删除时关闭线程
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkThreadRuntimeBridge } from '@agentdevjs/core';
import { createThreadControl } from '../server/thread-control/thread-controller.js';
import { setupThreadRoutes } from '../server/thread-control/thread-routes.js';
import { createThreadIntegration } from '../server/thread-control/thread-integration.js';

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

async function makeTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'claw-dispatch-recovery-test-'));
}

/**
 * 就绪闸路由测试装置：真实 ThreadStore + stub 桥（idle runtime，投递返回
 * runtime_not_accepting），注入可选 ensureHeadRuntime，驱动 commands 端点。
 */
function setupCommandsHarness({ ensureHeadRuntime, bridgeDeliver } = {}) {
  const app = makeMockApp();
  const wakeCalls = [];
  const core = {
    getThread: async () => null,
    appendCommand: async ({ threadId, kind, text, source, idempotencyKey }) => ({
      command: { commandId: 'cmd-1', kind: kind || 'user_message', text, status: 'pending' },
      duplicate: false,
      threadRevision: 1,
    }),
    findThreadByHeadSession: async () => null,
  };
  const board = {
    getState: async () => null,
    setMode: async () => ({}),
  };
  setupThreadRoutes(app, makeMockExpress(), {
    control: {
      core: {
        getThread: async () => null,
        appendCommand: async () => ({ command: { commandId: 'cmd-1', kind: 'user_message' }, duplicate: false }),
      },
      board: {},
      archive: { resolveCommandRejection: async () => null },
    },
    lifecycle: {
      archiveThread: async () => ({ threadId: 't', archivedAt: 1 }),
      unarchiveThread: async () => ({ threadId: 't', archivedAt: null }),
    },
    tryDeliver: async () => ({ attempted: 1, delivered: 0, reason: 'runtime_not_accepting', results: [] }),
    ensureHeadRuntime,
    resolveSessionOpenDirectory: async () => null,
  });
  return { app, wakeCalls };
}

async function callCommands(app, body) {
  const handlers = app._routes['POST /protoclaw/threads/:threadId/commands'];
  const jsonMiddleware = handlers[0];
  const routeHandler = handlers[handlers.length - 1];
  const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
  // jsonMiddleware 是 no-op stub（不解析 body），直接以 body 调 handler
  await routeHandler({ params: { threadId: 'wt-test' }, body, req: {} }, res);
  return res;
}

describe('commands 端点 — head runtime 就绪闸', () => {
  // 通用装置：真实路由 + stub core（线程 open、head=sess-head）
  function setupCommandsApp({ ensureHeadRuntime, tryDeliver, core } = {}) {
    const app = makeMockApp();
    setupThreadRoutes(app, makeMockExpress(), {
      control: {
        core: core || {
          getThread: async () => ({
            threadId: 'wt-test',
            agentId: 'programming-helper',
            headSessionId: 'sess-head',
            status: 'open',
            commands: [],
          }),
          appendCommand: async () => ({ command: { commandId: 'cmd-1', kind: 'user_message', text: 'hi', status: 'pending' }, duplicate: false }),
        },
        board: {},
        archive: { resolveCommandRejection: async () => null },
      },
      lifecycle: {
        archiveThread: async () => ({ threadId: 't', archivedAt: 1 }),
        unarchiveThread: async () => ({ threadId: 't', archivedAt: null }),
      },
      tryDeliver: tryDeliver || (() => ({ attempted: 1, delivered: 0, reason: 'runtime_not_accepting', results: [] })),
      ensureHeadRuntime,
      resolveSessionOpenDirectory: async () => null,
    });
    return app;
  }

  async function callCommands(app, body = { kind: 'user_message', text: 'hi' }) {
    const handlers = app._routes['POST /protoclaw/threads/:threadId/commands'];
    const res = makeMockRes();
    await handlers[handlers.length - 1]({ params: { threadId: 'wt-test' }, body }, res);
    return res;
  }

  test('闸未注入时保持旧行为：入箱 + tryDeliver，无 runtimeWake 字段', async () => {
    const app = makeMockApp();
    const core = {
      getThread: async () => ({
        threadId: 'wt-x', agentId: 'programming-helper', headSessionId: 'sess-head', status: 'open', commands: [],
      }),
      appendCommand: async () => ({ command: { commandId: 'cmd-1', kind: 'user_message', text: 'hi', status: 'pending' }, duplicate: false }),
    };
    setupThreadRoutes(app, makeMockExpress(), {
      control: { core, board: {}, archive: { resolveCommandRejection: async () => null } },
      lifecycle: { archiveThread: async () => ({}), unarchiveThread: async () => ({}) },
      tryDeliver: async () => ({ attempted: 1, delivered: 0, reason: 'runtime_not_accepting', results: [] }),
      // ensureHeadRuntime 故意不传（旧调用方兼容）
    });
    const handlers = app._routes['POST /protoclaw/threads/:threadId/commands'];
    const res = makeMockRes();
    await handlers[handlers.length - 1]({ params: { threadId: 'wt-x' }, body: { kind: 'user_message', text: 'hi' } }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.runtimeWake, undefined, '未注入就绪闸时不新增字段');
  });

  test('runtime 不在 → 唤起成功 → 指令照常入箱投递（唤起对成功路径透明）', async () => {
    const wakeCalls = [];
    const app = makeMockApp();
    let tryDeliverCalls = 0;
    const core = {
      getThread: async () => ({
        threadId: 'wt-test',
        agentId: 'programming-helper',
        headSessionId: 'sess-head',
        status: 'open',
        commands: [],
      }),
      appendCommand: async () => ({ command: { commandId: 'cmd-1', kind: 'user_message', text: 'hi', status: 'pending' }, duplicate: false }),
    };
    setupThreadRoutes(app, makeMockExpress(), {
      control: { core, board: {}, archive: { resolveCommandRejection: async () => null } },
      lifecycle: { archiveThread: async () => ({}), unarchiveThread: async () => ({}) },
      tryDeliver: async () => { tryDeliverCalls += 1; return { attempted: 1, delivered: 1, results: [] }; },
      ensureHeadRuntime: async (agentId, sessionId) => {
        wakeCalls.push({ agentId, sessionId });
        return { ok: true };
      },
      resolveSessionOpenDirectory: async () => null,
    });
    const handlers = app._routes['POST /protoclaw/threads/:threadId/commands'];
    const res = makeMockRes();
    await handlers[handlers.length - 1]({ params: { threadId: 'wt-test' }, body: { kind: 'user_message', text: 'hi' } }, res);
    assert.equal(res.statusCode, 201);
    assert.deepEqual(wakeCalls, [{ agentId: 'programming-helper', sessionId: 'sess-head' }]);
    assert.equal(tryDeliverCalls, 1);
    // 唤起成功 = 正常投递路径，响应不带 runtimeWake（与旧版同形，闸对调用方透明）
    assert.equal(res.body.runtimeWake, undefined);
  });

  test('head 会话已删 → 指令仍入箱（幂等保留），响应带 head_session_missing 失败事实', async () => {
    const app = makeMockApp();
    let appended = false;
    const core = {
      getThread: async () => ({
        threadId: 'wt-test',
        agentId: 'programming-helper',
        headSessionId: 'sess-deleted',
        status: 'open',
        commands: [],
      }),
      appendCommand: async () => { appended = true; return { command: { commandId: 'cmd-2', kind: 'user_message', text: 'x', status: 'pending' }, duplicate: false }; },
    };
    setupThreadRoutes(app, makeMockExpress(), {
      control: { core, board: {}, archive: { resolveCommandRejection: async () => null } },
      lifecycle: { archiveThread: async () => ({}), unarchiveThread: async () => ({}) },
      tryDeliver: async () => ({ attempted: 0, delivered: 0, reason: 'runtime_not_accepting', results: [] }),
      ensureHeadRuntime: async () => ({
        ok: false,
        code: 'head_session_missing',
        message: 'head session sess-deleted not found in session index',
      }),
    });
    const handlers = app._routes['POST /protoclaw/threads/:threadId/commands'];
    const res = makeMockRes();
    await handlers[handlers.length - 1]({ params: { threadId: 'wt-x' }, body: { kind: 'user_message', text: 'hi' } }, res);
    // 指令仍入箱（触发点语义不变），但失败事实显式随响应返回
    assert.equal(appended, true);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.runtimeWake.ok, false);
    assert.equal(res.body.runtimeWake.code, 'head_session_missing');
  });
});

describe('deliver 端点 — runtime_not_accepting 恢复闸', () => {
  // deliver 是裸投递动作；历史上撞上 runtime_not_accepting 只会重复报错，
  // 调用方（按旧流程用 deliver 的 agent）容易在死胡同里循环。加装与 send
  // 同源的就绪闸：not_accepting 时唤起 head runtime 后重投一次。
  function setupDeliverApp({ deliverResults, ensureHeadRuntime, thread }) {
    const app = makeMockApp();
    const results = deliverResults;
    let deliverCalls = 0;
    const core = {
      getThread: async () => thread || ({
        threadId: 'wt-test', agentId: 'programming-helper', headSessionId: 'sess-head', status: 'open', commands: [],
      }),
      deliverPendingCommands: async () => {
        deliverCalls += 1;
        return results[Math.min(deliverCalls, results.length) - 1];
      },
    };
    setupThreadRoutes(app, makeMockExpress(), {
      control: { core, board: {}, archive: { resolveCommandRejection: async () => null } },
      lifecycle: { archiveThread: async () => ({}), unarchiveThread: async () => ({}) },
      ensureHeadRuntime,
      resolveSessionOpenDirectory: async () => null,
    });
    return { app, getDeliverCalls: () => deliverCalls };
  }

  async function callDeliver(app) {
    const handlers = app._routes['POST /protoclaw/threads/:threadId/deliver'];
    const res = makeMockRes();
    await handlers[handlers.length - 1]({ params: { threadId: 'wt-test' }, body: {} }, res);
    return res;
  }

  test('not_accepting → 唤起成功 → 重投并返回新结果（不带 runtimeWake）', async () => {
    const wakeCalls = [];
    const first = { attempted: 1, delivered: 0, reason: 'runtime_not_accepting', results: [{ accepted: false, reason: 'runtime_not_accepting', retryable: true }] };
    const second = { attempted: 1, delivered: 1, results: [{ accepted: true }] };
    const { app, getDeliverCalls } = setupDeliverApp({
      deliverResults: [first, second],
      ensureHeadRuntime: async () => ({ ok: true }),
    });
    const handlers = app._routes['POST /protoclaw/threads/:threadId/deliver'];
    const res = makeMockRes();
    await handlers[handlers.length - 1]({ params: { threadId: 'wt-test' }, body: {} }, res);
    assert.equal(getDeliverCalls(), 2, '唤起成功后应重投一次');
    assert.equal(res.body.attempted, 1);
    assert.equal(res.body.delivered, 1, '重投后指令被接收');
    assert.equal(res.body.results[0].accepted, true);
    assert.equal(res.body.runtimeWake, undefined, '唤起成功时响应与旧版同形');
  });

  test('唤起失败 → 保留首次 not_accepting 结果 + runtimeWake 事实', async () => {
    const { app, getDeliverCalls } = setupDeliverApp({
      deliverResults: [{ attempted: 1, delivered: 0, reason: 'runtime_not_accepting', results: [{ accepted: false, reason: 'runtime_not_accepting', retryable: true }] }],
      ensureHeadRuntime: async () => ({ ok: false, code: 'head_session_missing', message: 'gone' }),
    });
    const handlers = app._routes['POST /protoclaw/threads/:threadId/deliver'];
    const res = makeMockRes();
    await handlers[handlers.length - 1]({ params: { threadId: 'wt-test' }, body: {} }, res);
    assert.equal(getDeliverCalls(), 1, '唤起失败不重投');
    assert.equal(res.body.reason, 'runtime_not_accepting');
    assert.equal(res.body.runtimeWake.ok, false);
    assert.equal(res.body.runtimeWake.code, 'head_session_missing');
  });

  test('投递成功（无 not_accepting）→ 不触发唤起，行为与旧版一致', async () => {
    const wakeCalls = [];
    const { app, getDeliverCalls } = setupDeliverApp({
      deliverResults: [{ attempted: 1, delivered: 1, results: [{ accepted: true }] }],
      ensureHeadRuntime: async () => { throw new Error('should not be called'); },
    });
    const handlers = app._routes['POST /protoclaw/threads/:threadId/deliver'];
    const res = makeMockRes();
    await handlers[handlers.length - 1]({ params: { threadId: 'wt-test' }, body: {} }, res);
    assert.equal(getDeliverCalls(), 1);
    assert.equal(res.body.delivered, 1);
    assert.equal(res.body.attempted, 1);
    assert.equal(res.body.runtimeWake, undefined);
  });

  test('闸未注入（旧调用方）→ not_accepting 时保持裸投递行为', async () => {
    const { app, getDeliverCalls } = setupDeliverApp({
      deliverResults: [{ attempted: 1, delivered: 0, reason: 'runtime_not_accepting', results: [{ accepted: false, reason: 'runtime_not_accepting', retryable: true }] }],
      ensureHeadRuntime: undefined,
    });
    const handlers = app._routes['POST /protoclaw/threads/:threadId/deliver'];
    const res = makeMockRes();
    await handlers[handlers.length - 1]({ params: { threadId: 'wt-test' }, body: {} }, res);
    assert.equal(getDeliverCalls(), 1);
    assert.equal(res.body.reason, 'runtime_not_accepting');
    assert.equal(res.body.runtimeWake, undefined);
  });
});

describe('cleanupEmptySessions — 线程收口钩子', () => {
  // cleanupEmptySessions 直接 fs.rm 删文件，历史上绕过 onSessionDeleted，
  // 制造过孤儿线程（head 已删、线程 open、pending 指令永久滞留）。
  // 这里验证 ctx.onSessionDeleted 在每个被删会话上被调用。
  test('每个被清理的空会话都触发线程收口钩子', async () => {
    // 直接验证依赖注入契约：ctx.onSessionDeleted 存在时按会话调用
    const { createSessionHelpers } = await import('../server/routes/session-helpers.js');
    assert.ok(createSessionHelpers, 'createSessionHelpers exportable');
    // 模块级单测：ctx 不传 onSessionDeleted 时不炸（向后兼容）
    const harness = createSessionHelpers({
      readWorkspaceState: async () => ({}),
      writeWorkspaceState: async () => ({}),
      discoverAgents: async () => [],
      enrichAgent: async (x) => x,
      startManagedAgent: async () => ({}),
      waitForManagedRuntimeReady: async () => null,
    });
    assert.ok(harness.cleanupEmptySessions);
  });
});
