/**
 * threads/:id/commands 路由字段透传测试（node:test）
 *
 * 锁定路由层对随消息流动字段的解构与规范化：
 * - capabilityActivations：非字符串项被过滤（存量 bug 回归锁——此前路由未
 *   解构该字段，前端线程快路径的 skill 激活被静默丢弃）
 * - metadata（user-turn 自由元数据）：合法 plain object 随指令入箱并经
 *   bridge 投递转发；非法形态（数组 / 空对象）静默剔除不阻断
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkThreadRuntimeBridge } from '@agentdevjs/core';
import { createThreadControl } from '../server/thread-control/thread-controller.js';
import { setupThreadRoutes } from '../server/thread-control/thread-routes.js';

let base = null;
let counter = 0;

function makeControl(submitTurn) {
  const root = path.join(base, `routes-${++counter}`);
  const identitySource = async (_agentId, sessionId) =>
    String(sessionId || '').trim() ? 'coder' : null;
  return createThreadControl({
    rootDir: root,
    bridge: new WorkThreadRuntimeBridge({
      enabled: true,
      resolveRuntimeViewerId: () => 'viewer-routes',
      submitTurn,
    }),
    identitySource,
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

async function callRoute(app, pattern, { params, body } = {}) {
  const handlers = app.routes[`POST ${pattern}`];
  assert.ok(handlers, `route not registered: POST ${pattern}`);
  const handler = handlers[handlers.length - 1];
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
  await handler({ params, body: body ?? {}, query: {} }, res);
  return res;
}

// GET /protoclaw/threads：列表端点的挡板开始时间投影断言用。
async function callListRoute(app) {
  const handlers = app.routes['GET /protoclaw/threads'];
  assert.ok(handlers, 'route not registered: GET /protoclaw/threads');
  const handler = handlers[handlers.length - 1];
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
  await handler({ query: {} }, res);
  return res;
}

before(async () => { base = mkdtempSync(path.join(os.tmpdir(), 'claw-thread-routes-')); });
after(async () => { if (base) await fs.rm(base, { recursive: true, force: true }); });

describe('thread routes', () => {
  it('does not register a closed-state endpoint', () => {
    const control = makeControl(async () => ({ success: true }));
    const app = makeMockApp();
    setupThreadRoutes(app, { json: () => () => {} }, { control });
    assert.equal(app.routes['POST /protoclaw/threads/:threadId/close'], undefined);
  });
});

describe('GET /protoclaw/threads handoffStartedAt wire projection', () => {
  it('projects the pendingSuccession barrier start time; zero when no barrier', async () => {
    const control = makeControl(async () => ({ success: true }));
    const app = makeMockApp();
    setupThreadRoutes(app, { json: () => () => {} }, { control });

    const thread = await control.core.start({
      sessionRef: { agentId: 'programming-helper', sessionId: 'hs-w1' },
      identity: 'coder',
    });

    // 无挡板：0（前端三处消费——顶栏指示器 / 输入路由守卫 / 侧栏占位——
    // 以 >0 判定交接窗口；字段缺失会被误判为永无交接）
    const idle = await callListRoute(app);
    assert.equal(idle.body.threads[0].handoffStartedAt, 0);

    // 立挡板：投影框架 pendingSuccession.startedAt
    const { createThreadIntegration } = await import('../server/thread-control/thread-integration.js');
    const integration = createThreadIntegration({ control });
    const begun = await integration.beginSessionSuccession({
      agentId: 'programming-helper', sessionId: 'hs-w1', reason: 'trim',
    });
    assert.equal(begun.applied, true);
    const relaying = await callListRoute(app);
    assert.ok(relaying.body.threads[0].handoffStartedAt > 0, '挡板立起后 handoffStartedAt 应为正时间戳');

    // 挡板收敛（fail 路径）：归零
    await integration.failSessionSuccession({
      agentId: 'programming-helper', sessionId: 'hs-w1', reason: 'handoff_failed', stage: 'compact_or_successor',
    });
    const converged = await callListRoute(app);
    assert.equal(converged.body.threads[0].handoffStartedAt, 0);
  });
});

describe('GET /protoclaw/threads headSessionTitle wire projection', () => {
  it('projects the head session title so sidebar entries follow head rotation', async () => {
    const control = makeControl(async () => ({ success: true }));
    const app = makeMockApp();
    setupThreadRoutes(app, { json: () => () => {} }, {
      control,
      // head 会话标题解析（生产装配：findPrebuiltSessionRecordShared 取
      // 会话索引 title）。侧栏线程条目以此跟随换代（(精简)A），否则停在
      // 创建时的线程标题。
      resolveSessionTitle: async (agentId, sessionId) => (
        sessionId === 'hs-t1' ? '（精简）A' : null
      ),
    });

    await control.core.start({
      sessionRef: { agentId: 'programming-helper', sessionId: 'hs-t1' },
      identity: 'coder',
    });

    const res = await callListRoute(app);
    assert.equal(res.body.threads[0].headSessionTitle, '（精简）A',
      '线程响应应携带 head 会话标题（侧栏跟随换代的真相源）');

    // 解析缺席（会话索引无该会话）：null，前端回退线程标题
    const control2 = makeControl(async () => ({ success: true }));
    const app2 = makeMockApp();
    setupThreadRoutes(app2, { json: () => () => {} }, {
      control: control2,
      resolveSessionTitle: async () => null,
    });
    await control2.core.start({
      sessionRef: { agentId: 'programming-helper', sessionId: 'hs-t2' },
      identity: 'coder',
    });
    const res2 = await callListRoute(app2);
    assert.equal(res2.body.threads[0].headSessionTitle, null);
  });
});

describe('threads/:id/commands route field passthrough', () => {
  it('carries capabilityActivations and metadata from the route body into the command and delivery', async () => {
    const delivered = [];
    const control = makeControl(async (params) => {
      delivered.push(params);
      return { success: true };
    });
    const app = makeMockApp();
    setupThreadRoutes(app, { json: () => () => {} }, { control });

    const thread = await control.core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'rs-1' } });
    const metadata = { 'session-reference': [{ agentId: 'programming-helper', sessionId: 'session-q', title: '引用' }] };
    const res = await callRoute(app, '/protoclaw/threads/:threadId/commands', {
      params: { threadId: thread.threadId },
      body: {
        text: '带激活与引用的指令',
        source: 'ui',
        idempotencyKey: 'route-1',
        capabilityActivations: ['skill.grill-me', 42, '', 'skill.grill-with-docs'],
        metadata,
      },
    });

    assert.equal(res.statusCode, 201);
    // 路由层过滤非字符串 / 空激活，保留合法 refs
    assert.deepEqual(res.body.command.capabilityActivations, ['skill.grill-me', 'skill.grill-with-docs']);
    assert.deepEqual(res.body.command.metadata, metadata);
    // 显式投递（生产中由注入的 tryDeliver 即时触发）：bridge 投递参数原样
    // 携带（经宿主适配后进入 user-turn body）
    const delivery = await control.core.deliverPendingCommands(thread.threadId);
    assert.equal(delivery.delivered, 1);
    assert.equal(delivered.length, 1);
    assert.deepEqual(delivered[0].capabilityActivations, ['skill.grill-me', 'skill.grill-with-docs']);
    assert.deepEqual(delivered[0].metadata, metadata);
  });

  it('silently drops malformed metadata shapes instead of rejecting the command', async () => {
    const control = makeControl(async () => ({ success: true }));
    const app = makeMockApp();
    setupThreadRoutes(app, { json: () => () => {} }, { control });

    const thread = await control.core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'rs-2' } });
    const res = await callRoute(app, '/protoclaw/threads/:threadId/commands', {
      params: { threadId: thread.threadId },
      body: { text: '纯文本', metadata: ['not', 'an', 'object'] },
    });

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.command.metadata, undefined);
  });
});
