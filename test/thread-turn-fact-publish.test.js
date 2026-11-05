/**
 * 轮次终态事实发布测试（ADR-0042 决策 4，node:test）
 *
 * 锁定 POST /protoclaw/thread_events 落板后的两类可观察输出：
 * - SSE 事实帧 thread.turn-completed / turn-failed / turn-cancelled：
 *   只对终态事件、只对看板归并成功（applied）的事件发布，帧携带线程
 *   身份与交付文本（resultText）——订阅方（前端线程面板、IM relay）
 *   依赖的形状；
 * - onTurnTerminalFact 订阅钩子：与 SSE 帧同一事实（OS 通知的接入点），
 *   订阅方抛错不得打断上报响应（上报是 runtime 的观测链，不是通知链）。
 *
 * 真实路径：createThreadControl 真实落盘 + 真实 board.recordRuntimeEvent
 * （含 session→thread 归并与看板状态迁移）；仅注入 SSE 发布器与订阅钩子
 * 作为观察点（两者本就是 setupThreadRoutes 的 DI 缝）。同文件内正例
 * （有线程会话产帧）与负例（无线程会话零帧）对照，证明观察点接通。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkThreadRuntimeBridge } from '@agentdevjs/core';
import { createThreadControl } from '../server/thread-control/thread-controller.js';
import { setupThreadRoutes } from '../server/thread-control/thread-routes.js';

const AGENT = 'coder';

let base = null;
let counter = 0;

function makeControl() {
  return createThreadControl({
    rootDir: path.join(base, `turn-fact-${++counter}`),
    bridge: new WorkThreadRuntimeBridge(),
  });
}

function makeMockApp() {
  const routes = {};
  return {
    routes,
    get: (p, ...h) => { routes[`GET ${p}`] = h; },
    post: (p, ...h) => { routes[`POST ${p}`] = h; },
  };
}

async function callThreadEvents(app, body) {
  const handlers = app.routes['POST /protoclaw/thread_events'];
  assert.ok(handlers, 'route not registered: POST /protoclaw/thread_events');
  const handler = handlers[handlers.length - 1];
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
  await handler({ params: {}, body }, res);
  return res;
}

before(async () => { base = mkdtempSync(path.join(os.tmpdir(), 'claw-turn-fact-')); });
after(async () => { if (base) await fs.rm(base, { recursive: true, force: true }); });

describe('thread turn fact publish (POST /protoclaw/thread_events)', () => {
  it('completed turn on a thread session publishes frame and fact with resultText', async () => {
    const control = makeControl();
    const thread = await control.core.start({ sessionRef: { agentId: AGENT, sessionId: 'tf-s1' } });

    const frames = [];
    const facts = [];
    const app = makeMockApp();
    setupThreadRoutes(app, expressStub(), {
      control,
      publishThreadEvent: (threadId, payload) => { frames.push({ threadId, payload }); },
      onTurnTerminalFact: (fact) => { facts.push(fact); },
    });

    const res = await callThreadEvents(app, {
      agentId: AGENT,
      sessionId: 'tf-s1',
      runtimeInstanceId: 'rt-1',
      event: { type: 'turn.completed', turn: 3, source: 'qq', sourceRef: 'msg-42', resultText: '修复完成' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.applied, true);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].threadId, thread.threadId);
    assert.equal(frames[0].payload.kind, 'thread.turn-completed');
    assert.equal(frames[0].payload.resultText, '修复完成');
    assert.equal(frames[0].payload.agentId, AGENT);
    assert.equal(frames[0].payload.turn, 3);
    assert.equal(frames[0].payload.source, 'qq');
    assert.equal(frames[0].payload.sourceRef, 'msg-42');

    // 订阅钩子与 SSE 帧是同一事实（OS 通知 / IM relay 的接入点）
    assert.equal(facts.length, 1);
    assert.equal(facts[0].threadId, thread.threadId);
    assert.equal(facts[0].status, 'completed');
    assert.equal(facts[0].resultText, '修复完成');
    assert.equal(facts[0].sessionId, 'tf-s1');
  });

  it('failed turn publishes turn-failed frame with structured error', async () => {
    const control = makeControl();
    await control.core.start({ sessionRef: { agentId: AGENT, sessionId: 'tf-f1' } });

    const frames = [];
    const app = makeMockApp();
    setupThreadRoutes(app, expressStub(), {
      control,
      publishThreadEvent: (threadId, payload) => { frames.push({ threadId, payload }); },
    });

    const res = await callThreadEvents(app, {
      agentId: AGENT,
      sessionId: 'tf-f1',
      event: { type: 'turn.failed', turn: 1, error: { message: 'provider down', reason: 'network', category: 'runtime', retryable: true } },
    });
    assert.equal(res.body.applied, true);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].payload.kind, 'thread.turn-failed');
    assert.deepEqual(frames[0].payload.error, {
      message: 'provider down', reason: 'network', category: 'runtime', retryable: true,
    });
  });

  it('terminal-only surface: turn.started and item events publish nothing', async () => {
    const control = makeControl();
    await control.core.start({ sessionRef: { agentId: AGENT, sessionId: 'tf-t1' } });

    const frames = [];
    const facts = [];
    const app = makeMockApp();
    setupThreadRoutes(app, expressStub(), {
      control,
      publishThreadEvent: (threadId, payload) => { frames.push({ threadId, payload }); },
      onTurnTerminalFact: (fact) => { facts.push(fact); },
    });

    for (const event of [
      { type: 'turn.started', turn: 0 },
      { type: 'item.started', turn: 0, item: { id: 'i1', type: 'tool_call' } },
      { type: 'item.completed', turn: 0, item: { id: 'i1', type: 'tool_call', status: 'completed' } },
    ]) {
      const res = await callThreadEvents(app, { agentId: AGENT, sessionId: 'tf-t1', event });
      assert.equal(res.body.applied, true, `${event.type} should still land on the board`);
    }
    assert.equal(frames.length, 0);
    assert.equal(facts.length, 0);
  });

  it('session without thread (applied:false) publishes nothing', async () => {
    const control = makeControl();
    const frames = [];
    const facts = [];
    const app = makeMockApp();
    setupThreadRoutes(app, expressStub(), {
      control,
      publishThreadEvent: (threadId, payload) => { frames.push({ threadId, payload }); },
      onTurnTerminalFact: (fact) => { facts.push(fact); },
    });

    const res = await callThreadEvents(app, {
      agentId: AGENT,
      sessionId: 'no-thread-session',
      event: { type: 'turn.completed', turn: 0, resultText: 'x' },
    });
    assert.equal(res.body.applied, false);
    assert.equal(frames.length, 0);
    assert.equal(facts.length, 0);
  });

  it('subscriber hook throwing must not break the report response or the SSE frame', async () => {
    const control = makeControl();
    await control.core.start({ sessionRef: { agentId: AGENT, sessionId: 'tf-e1' } });

    const frames = [];
    const app = makeMockApp();
    setupThreadRoutes(app, expressStub(), {
      control,
      publishThreadEvent: (threadId, payload) => { frames.push({ threadId, payload }); },
      onTurnTerminalFact: () => { throw new Error('subscriber exploded'); },
    });

    const res = await callThreadEvents(app, {
      agentId: AGENT,
      sessionId: 'tf-e1',
      event: { type: 'turn.completed', turn: 2, resultText: 'ok' },
    });
    // 上报语义不被订阅方故障改变：响应 ok，帧照发
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].payload.kind, 'thread.turn-completed');
  });
});

/** mock app 模式不需要真实 express.json（body 直传），只需占位中间件签名。 */
function expressStub() {
  return { json: () => (req, res, next) => next() };
}
