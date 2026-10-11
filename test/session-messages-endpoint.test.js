/**
 * /protoclaw/prebuilt_sessions/session_messages 端点契约测试。
 *
 * 接续挡板窗口（thread_handoff_in_progress）期间两代 runtime 都不可用，
 * 前端等待表面从本端点读上一棒会话文件消息。契约：
 * - 纯只读：读 runtime.context.messages（与 viewer /messages 同源同形），
 *   不启动 runtime、不改 head
 * - 缺参 400；文件缺失/无消息 → 空数组（200，等待表面降级挂 spinner）
 * - agentId 经 requireAgentLight 归一（错误 agentId 由其抛错）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupSessionRoutes } from '../server/routes/session.js';

function makeMockCtx({ snapshot, agent = { id: 'coder' } } = {}) {
  const noop = async () => {};
  return {
    activatePrebuiltSession: noop,
    archivePrebuiltSession: noop,
    buildSessionTrimPreview: noop,
    estimatePreambleCharCount: noop,
    compactAndResumeCurrentSession: noop,
    compactAndResumeFromProvidedSummary: noop,
    createCompactedResumeFromHandoff: noop,
    createPrebuiltSession: noop,
    deletePrebuiltSession: noop,
    exportContextHandoffForSession: noop,
    exportProvidedSummaryHandoff: noop,
    findSessionSummary: noop,
    findSessionSummaryPath: noop,
    listPrebuiltSessions: noop,
    requirePrebuiltAgentForRuntime: noop,
    requirePrebuiltSessionRecord: noop,
    resolvePrebuiltSessionOwner: noop,
    searchSessionsContent: noop,
    setSessionHasSummary: noop,
    tagPrebuiltSessionTodo: noop,
    readSessionSnapshotForContinuity: async () => snapshot,
    requireAgentLight: async () => agent,
    startManagedAgent: noop,
    stopManagedAgent: noop,
    waitForManagedRuntimeReady: noop,
  };
}

function makeCallableMockApp() {
  const handlers = new Map();
  const app = {
    get: (p, h) => handlers.set(`GET ${p}`, h),
    post: (p, ...h) => handlers.set(`POST ${p}`, h),
    put: (p, h) => handlers.set(`PUT ${p}`, h),
    delete: (p, h) => handlers.set(`DELETE ${p}`, h),
  };
  app.invoke = async (method, p, req) => new Promise((resolve) => {
    const handler = handlers.get(`${method} ${p}`);
    if (!handler) throw new Error(`route not registered: ${method} ${p}`);
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; resolve(this); },
    };
    const next = (error) => resolve({ error });
    handler(req, res, next);
  });
  return app;
}

function setup({ snapshot, agent } = {}) {
  const app = makeCallableMockApp();
  setupSessionRoutes(app, { json: () => [(req, res, next) => next()] }, makeMockCtx({ snapshot, agent }));
  return app;
}

test('session_messages：透传会话文件的 runtime.context.messages（与 viewer 同形）', async () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', turn: 1, content: 'do work' },
    { role: 'tool', turn: 1, toolCallId: 'call-1', content: 'ok' },
  ];
  const app = setup({ snapshot: { runtime: { context: { messages } } } });

  const res = await app.invoke('GET', '/protoclaw/prebuilt_sessions/session_messages', {
    query: { agentId: 'coder', sessionId: 'session-1' },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.agentId, 'coder');
  assert.equal(res.body.sessionId, 'session-1');
  assert.deepEqual(res.body.messages, messages);
  assert.equal(res.body.messageCount, 3);
});

test('session_messages：文件缺失或无消息 → 空数组（等待表面降级，不报错）', async () => {
  for (const snapshot of [null, {}, { runtime: {} }, { runtime: { context: {} } }]) {
    const app = setup({ snapshot });
    const res = await app.invoke('GET', '/protoclaw/prebuilt_sessions/session_messages', {
      query: { agentId: 'coder', sessionId: 'session-1' },
    });
    assert.equal(res.statusCode, 200, `snapshot=${JSON.stringify(snapshot)}`);
    assert.deepEqual(res.body.messages, []);
    assert.equal(res.body.messageCount, 0);
  }
});

test('session_messages：缺参 400', async () => {
  const app = setup({ snapshot: null });
  for (const query of [{ agentId: 'coder' }, { sessionId: 'session-1' }, {}]) {
    const res = await app.invoke('GET', '/protoclaw/prebuilt_sessions/session_messages', { query });
    assert.equal(res.statusCode, 400, `query=${JSON.stringify(query)}`);
    assert.equal(res.body.ok, false);
  }
});
