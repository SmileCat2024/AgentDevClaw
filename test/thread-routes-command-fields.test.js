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
    setupThreadRoutes(app, { json: () => () => {} }, { control, ensureHeadRuntime: async () => ({ ok: true }) });
    assert.equal(app.routes['POST /protoclaw/threads/:threadId/close'], undefined);
  });
});

describe('GET /protoclaw/threads handoffStartedAt wire projection', () => {
  it('projects the pendingSuccession barrier start time; zero when no barrier', async () => {
    const control = makeControl(async () => ({ success: true }));
    const app = makeMockApp();
    setupThreadRoutes(app, { json: () => () => {} }, { control, ensureHeadRuntime: async () => ({ ok: true }) });

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

describe('GET /protoclaw/threads project identity', () => {
  it('returns project identity independently of the shared working directory', async () => {
    const control = makeControl(async () => ({ success: true }));
    const app = makeMockApp();
    setupThreadRoutes(app, { json: () => () => {} }, {
      control,
      resolveHeadSessionFields: async () => new Map([
        ['project', { projectId: 'prj_123456abcdef', openDirectory: '/shared', title: '项目对话' }],
        ['directory', { projectId: '', openDirectory: '/shared', title: '目录对话' }],
      ]),
    });
    for (const sessionId of ['project', 'directory']) {
      await control.core.start({ sessionRef: { agentId: 'programming-helper', sessionId }, identity: 'coder' });
    }
    const response = await callListRoute(app);
    assert.equal(response.statusCode, 200);
    const byHead = new Map(response.body.threads.map(t => [t.headSessionId, t]));
    assert.equal(byHead.get('project').headProjectId, 'prj_123456abcdef');
    assert.equal(byHead.get('directory').headProjectId, '');
    assert.equal(byHead.get('project').headProjectDir, '/shared');
    assert.equal(byHead.get('directory').headProjectDir, '/shared');
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
    setupThreadRoutes(app, { json: () => () => {} }, { control, ensureHeadRuntime: async () => ({ ok: true }) });

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
    setupThreadRoutes(app, { json: () => () => {} }, { control, ensureHeadRuntime: async () => ({ ok: true }) });

    const thread = await control.core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'rs-2' } });
    const res = await callRoute(app, '/protoclaw/threads/:threadId/commands', {
      params: { threadId: thread.threadId },
      body: { text: '纯文本', metadata: ['not', 'an', 'object'] },
    });

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.command.metadata, undefined);
  });
});

async function callGetRoute(app, pattern, { params, query } = {}) {
  const handlers = app.routes[`GET ${pattern}`];
  assert.ok(handlers, `route not registered: GET ${pattern}`);
  const handler = handlers[handlers.length - 1];
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
  await handler({ params, query: query ?? {} }, res);
  return res;
}

// ADR-0047 阶段 2b：head 推进端点走框架原子事务——待判定指令缺可靠消费
// 引用时不再拦截换头，而是转 unresolved 持久并随响应携带清单；处置经
// 查询/处置端点显式完成；unreadable（瞬时读取失败）409 拒绝换头。
describe('POST /protoclaw/threads/:threadId/head atomic succession', () => {
  it('fails closed when the successor readiness gate is not configured', async () => {
    const control = makeControl(async () => ({ success: true }));
    const app = makeMockApp();
    setupThreadRoutes(app, { json: () => () => {} }, { control });
    const thread = await control.core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'ready-gate-s1' } });

    const result = await callRoute(app, '/protoclaw/threads/:threadId/head', {
      params: { threadId: thread.threadId },
      body: { toSessionId: 'ready-gate-s2', fromSessionId: 'ready-gate-s1' },
    });

    assert.equal(result.statusCode, 503);
    assert.equal(result.body.code, 'successor_runtime_unavailable');
    assert.equal((await control.core.getThread(thread.threadId)).headSessionId, 'ready-gate-s1');
  });

  it('refuses head advancement when successor readiness fails and leaves the old head authoritative', async () => {
    const control = makeControl(async () => ({ success: true }));
    const app = makeMockApp();
    setupThreadRoutes(app, { json: () => () => {} }, {
      control,
      ensureHeadRuntime: async () => ({ ok: false, code: 'runtime_ready_timeout', message: 'not ready' }),
      publishThreadEvent: async () => { throw new Error('head event must not publish'); },
    });
    const thread = await control.core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'ready-s1' } });
    const result = await callRoute(app, '/protoclaw/threads/:threadId/head', {
      params: { threadId: thread.threadId },
      body: { toSessionId: 'ready-s2', fromSessionId: 'ready-s1' },
    });
    assert.equal(result.statusCode, 409);
    assert.equal(result.body.code, 'successor_runtime_not_ready');
    assert.equal((await control.core.getThread(thread.threadId)).headSessionId, 'ready-s1');
  });

  it('rejects a closed thread before waking any successor runtime (stage 5 review P2-7)', async () => {
    // 终态拒绝不得先产生 runtime 副作用：唤起闸会真实拉起 successor
    // 并等 READY（最长 20s）——closed 线程的换头请求注定被 commit 以
    // thread_closed 拒绝，先唤起就是给调度面制造无主 runtime。
    const control = makeControl(async () => ({ success: true }));
    const app = makeMockApp();
    let wakeCalls = 0;
    setupThreadRoutes(app, { json: () => () => {} }, {
      control,
      ensureHeadRuntime: async () => { wakeCalls += 1; return { ok: true }; },
    });
    const thread = await control.core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'closed-s1' } });
    await control.core.closeThread(thread.threadId);
    const result = await callRoute(app, '/protoclaw/threads/:threadId/head', {
      params: { threadId: thread.threadId },
      body: { toSessionId: 'closed-s2', fromSessionId: 'closed-s1' },
    });
    assert.equal(result.statusCode, 409);
    assert.equal(result.body.code, 'thread_closed');
    assert.equal(wakeCalls, 0);
  });

  it('retires the old head runtime and publishes the wire-contract head-advanced event before delivery (stage 5 review P1-4/P1-5)', async () => {
    const control = makeControl(async () => ({ success: true }));
    const app = makeMockApp();
    const order = [];
    const events = [];
    setupThreadRoutes(app, { json: () => () => {} }, {
      control,
      ensureHeadRuntime: async () => ({ ok: true }),
      stopManagedAgent: async (_agentId, sessionId, opts) => { order.push(`stop:${sessionId}:${opts?.waitForPersistence === true}`); },
      publishThreadEvent: async (_threadId, payload) => { order.push('event'); events.push(payload); },
      tryDeliver: async () => { order.push('deliver'); return { attempted: 0, delivered: 0 }; },
    });
    const thread = await control.core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'retire-s1' } });
    const result = await callRoute(app, '/protoclaw/threads/:threadId/head', {
      params: { threadId: thread.threadId },
      body: { toSessionId: 'retire-s2', fromSessionId: 'retire-s1' },
    });
    assert.equal(result.statusCode, 200);
    // P1-4：事件形状 = sse-events 帧契约（前端 thread-store 要求 from/to 同场）
    assert.deepEqual(events, [{
      kind: 'thread.head-advanced',
      agentId: 'programming-helper',
      fromSessionId: 'retire-s1',
      toSessionId: 'retire-s2',
      reason: 'manual',
    }]);
    // P1-5：退役旧 head（旧 runtime 若滞留，其 Viewer 身份自洽，可继续
    // claim 队列指令——已分类 unresolved 的指令会被旧棒事后执行），且
    // 退役必须先于向新 head 的补投递。
    const stops = order.filter((entry) => entry.startsWith('stop:'));
    assert.equal(stops.length, 1);
    assert.equal(stops[0], 'stop:retire-s1:true');
    assert.ok(order.indexOf(stops[0]) < order.indexOf('deliver'));
  });

  it('advances with unresolved persisted when a delivered command lacks a consumption reference', async () => {
    const control = makeControl(async () => ({ success: true }));
    const app = makeMockApp();
    setupThreadRoutes(app, { json: () => () => {} }, { control, ensureHeadRuntime: async () => ({ ok: true }) });

    const thread = await control.core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'gate-s1' } });
    await control.core.appendCommand({ threadId: thread.threadId, text: '缺消费引用的指令' });
    await control.core.store.update(thread.threadId, (draft) => {
      for (const command of draft.commands) {
        command.status = 'delivered';
        command.deliveredAt = Date.now();
      }
      return draft;
    });

    // 窗口可见（该棒有无关联的轮次终态）而该指令缺消费引用 → unresolved：
    // 换头推进（不阻塞、不静默滞留），响应携带清单，指令保持 delivered。
    await control.board.recordRuntimeEvent({
      agentId: 'programming-helper', sessionId: 'gate-s1', runtimeInstanceId: 'r1',
      event: { type: 'turn.completed', turn: 1, sourceRef: 'cmd-other' },
    });
    const advanced = await callRoute(app, '/protoclaw/threads/:threadId/head', {
      params: { threadId: thread.threadId },
      body: { toSessionId: 'gate-s2', fromSessionId: 'gate-s1' },
    });
    assert.equal(advanced.statusCode, 200);
    assert.equal(advanced.body.ok, true);
    assert.equal(advanced.body.unresolved.length, 1);
    assert.equal(advanced.body.unresolved[0].reason, 'no_positive_reference');
    const record = await control.core.getThread(thread.threadId);
    assert.equal(record.headSessionId, 'gate-s2');
    assert.equal(record.unresolvedCommands.length, 1);
    assert.equal(record.commands[0].status, 'delivered');

    // 查询面（手动免播路径的发现入口）：open 清单可见，含处置所需字段。
    const listed = await callGetRoute(app, '/protoclaw/threads/:threadId/unresolved', {
      params: { threadId: thread.threadId },
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.body.unresolved.length, 1);
    assert.equal(listed.body.unresolved[0].unresolvedId, advanced.body.unresolved[0].unresolvedId);
  });

  it('resolve endpoint closes the loop: reissue enqueues a pending command and attempts delivery', async () => {
    const deliveredTexts = [];
    const control = makeControl(async (params) => { deliveredTexts.push(params.text); return { success: true }; });
    const app = makeMockApp();
    const deliveries = [];
    setupThreadRoutes(app, { json: () => () => {} }, {
      control,
      ensureHeadRuntime: async () => ({ ok: true }),
      tryDeliver: async (threadId) => { deliveries.push(threadId); return { attempted: 0, delivered: 0 }; },
    });

    const thread = await control.core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'gate-s1' } });
    await control.core.appendCommand({ threadId: thread.threadId, text: '需要重投的指令' });
    await control.core.store.update(thread.threadId, (draft) => {
      for (const command of draft.commands) {
        command.status = 'delivered';
        command.deliveredAt = Date.now();
      }
      return draft;
    });

    const advanced = await callRoute(app, '/protoclaw/threads/:threadId/head', {
      params: { threadId: thread.threadId },
      body: { toSessionId: 'gate-s2', fromSessionId: 'gate-s1' },
    });
    assert.equal(advanced.body.unresolved.length, 1);
    const unresolvedId = advanced.body.unresolved[0].unresolvedId;

    // 处置 reissue：新 pending 指令入箱（原载荷），投递被触发（不阻塞处置）。
    const resolved = await callRoute(app, '/protoclaw/threads/:threadId/unresolved/:unresolvedId/resolve', {
      params: { threadId: thread.threadId, unresolvedId },
      body: { resolution: 'reissue', note: 'confirmed not consumed' },
    });
    assert.equal(resolved.statusCode, 200);
    assert.equal(resolved.body.command.text, '需要重投的指令');
    assert.equal(resolved.body.command.status, 'pending');
    // head 完整编排首次尝试投递，reissue 处置再次触发投递。
    assert.equal(deliveries.length, 2);
    // 重复处置（相同方式）幂等：不重复 reissue。
    const repeat = await callRoute(app, '/protoclaw/threads/:threadId/unresolved/:unresolvedId/resolve', {
      params: { threadId: thread.threadId, unresolvedId },
      body: { resolution: 'reissue' },
    });
    assert.equal(repeat.statusCode, 200);
    assert.equal(repeat.body.command.commandId, resolved.body.command.commandId);
    const open = await callGetRoute(app, '/protoclaw/threads/:threadId/unresolved', {
      params: { threadId: thread.threadId },
    });
    assert.equal(open.body.unresolved.length, 0);
  });

  it('refuses to advance with 409 evidence_unreadable when the board read fails transiently', async () => {
    const control = makeControl(async () => ({ success: true }));
    const app = makeMockApp();
    setupThreadRoutes(app, { json: () => () => {} }, { control, ensureHeadRuntime: async () => ({ ok: true }) });

    const thread = await control.core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'gate-s1' } });
    await control.core.appendCommand({ threadId: thread.threadId, text: '待判定指令' });
    await control.core.store.update(thread.threadId, (draft) => {
      for (const command of draft.commands) {
        command.status = 'delivered';
        command.deliveredAt = Date.now();
      }
      return draft;
    });

    const originalRead = control.board.readStateDetailed;
    control.board.readStateDetailed = async () => { throw new Error('EPERM'); };
    let blocked;
    try {
      blocked = await callRoute(app, '/protoclaw/threads/:threadId/head', {
        params: { threadId: thread.threadId },
        body: { toSessionId: 'gate-s2', fromSessionId: 'gate-s1' },
      });
    } finally {
      control.board.readStateDetailed = originalRead;
    }
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.body.code, 'evidence_unreadable');
    const record = await control.core.getThread(thread.threadId);
    assert.equal(record.headSessionId, 'gate-s1');
    assert.deepEqual(record.unresolvedCommands ?? [], []);
  });

  it('proceeds without unresolved when the retiring bar has no pending-classifiable commands', async () => {
    const control = makeControl(async () => ({ success: true }));
    const app = makeMockApp();
    setupThreadRoutes(app, { json: () => () => {} }, { control, ensureHeadRuntime: async () => ({ ok: true }) });

    // 无任何指令、board 文件不存在（惰性创建前）：正常换头，unresolved 空。
    const thread = await control.core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'gate-idle-1' } });
    const res = await callRoute(app, '/protoclaw/threads/:threadId/head', {
      params: { threadId: thread.threadId },
      body: { toSessionId: 'gate-idle-2', fromSessionId: 'gate-idle-1' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.unresolved, []);
    const record = await control.core.getThread(thread.threadId);
    assert.equal(record.headSessionId, 'gate-idle-2');
  });
});
