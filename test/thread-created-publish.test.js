/**
 * 显式建线程端点的 thread.created 事件补挂（ADR-0024 PR-3）
 *
 * PR-2 时因与 SSE 线程并行改造回避的发布点：POST /protoclaw/threads 在
 * core.start（含 mode 落定）事务完成后发布 thread.created，模式与
 * thread-integration.onSessionCreated 一致（DI publishThreadEvent、
 * 事件携带权威状态事实、不带派生视图数据）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { setupThreadRoutes } from '../server/thread-control/thread-routes.js';

function makeMockApp() {
  const routes = {};
  const app = {
    get: (p, ...h) => { routes[`GET ${p}`] = h; },
    post: (p, ...h) => { routes[`POST ${p}`] = h; },
    put: (p, ...h) => { routes[`PUT ${p}`] = h; },
    delete: (p, ...h) => { routes[`DELETE ${p}`] = h; },
  };
  app._routes = routes;
  return app;
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

const CREATED_THREAD = {
  threadId: 'wt-created-1',
  agentId: 'programming-helper',
  workspaceId: 'ws-app',
  title: 'app thread',
  status: 'open',
  rootSessionId: 's-root',
  headSessionId: 's-root',
};

function makeApp({ startError = null } = {}) {
  const calls = [];
  const app = makeMockApp();
  const setModeCalls = [];
  setupThreadRoutes(app, makeMockExpress(), {
    control: {
      core: {
        getThread: async () => null,
        start: async () => {
          if (startError) throw startError;
          return { ...CREATED_THREAD };
        },
      },
      board: { setMode: async (threadId, mode) => { setModeCalls.push({ threadId, mode }); return {}; } },
      archive: { resolveCommandRejection: async () => null, list: async () => ({}) },
    },
    lifecycle: { archiveThread: async () => ({}), unarchiveThread: async () => ({}) },
    publishThreadEvent: (threadId, payload) => { calls.push({ threadId, payload }); },
  });
  return { app, calls, setModeCalls };
}

async function callCreate(app, body) {
  const handlers = app._routes['POST /protoclaw/threads'];
  assert.ok(Array.isArray(handlers), 'create route must be registered');
  const res = makeMockRes();
  await handlers[handlers.length - 1]({ body }, res);
  return res;
}

describe('POST /protoclaw/threads publishes thread.created after the transaction settles', () => {
  test('publishes exactly once with authoritative facts after core.start and mode', async () => {
    const { app, calls, setModeCalls } = makeApp();
    const res = await callCreate(app, {
      agentId: 'programming-helper',
      sessionId: 's-root',
      title: 'app thread',
      workspaceId: 'ws-app',
      mode: 'auto',
    });

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.thread.threadId, 'wt-created-1');
    // 事件在 mode 落定后发布（事务完成），且只发一次
    assert.equal(calls.length, 1);
    assert.equal(setModeCalls.length, 1);
    assert.deepEqual(calls[0], {
      threadId: 'wt-created-1',
      payload: {
        kind: 'thread.created',
        agentId: 'programming-helper',
        rootSessionId: 's-root',
        headSessionId: 's-root',
        status: 'open',
      },
    });
  });

  test('does not publish when core.start fails (no fabricated creation)', async () => {
    const { app, calls } = makeApp({ startError: Object.assign(new Error('duplicate member'), { status: 409 }) });
    const res = await callCreate(app, { agentId: 'programming-helper', sessionId: 's-x' });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.ok, false);
    assert.equal(calls.length, 0);
  });

  test('publishes also without mode (plain explicit creation)', async () => {
    const { app, calls, setModeCalls } = makeApp();
    const res = await callCreate(app, { agentId: 'programming-helper', sessionId: 's-root' });
    assert.equal(res.statusCode, 201);
    assert.equal(setModeCalls.length, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.kind, 'thread.created');
  });
});
