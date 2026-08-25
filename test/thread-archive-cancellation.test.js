/**
 * T004 — 归档取消语义与运行中调用收尾 验收测试（node:test）
 *
 * 覆盖工单验收标准：
 * 1. 归档立即拒绝新派发：routes 的 commands/deliver 端点 409
 *    thread_archived；input-gateway 新 send 显式拒绝；归档线程不再
 *    接受上下文变换派发（beginSessionSuccession → thread_archived）。
 * 2. Inbox 中尚未开始的 command 全部变为 cancelled（保留取消原因与
 *    时间），恢复后不会自动投递，也不复活。
 * 3. 已开始的调用（in_flight / delivered）不被取消，允许自然完成；
 *    归档后完成回调（runtime-ready 补投 / 显式 deliver）不再触发
 *    下一条 Inbox command（hold → thread_held）。
 * 4. 归档与接力并发不出现「归档后 successor 继续消费旧 Inbox」：
 *    确定性交错（gate Promise 控制时序，不靠 sleep）覆盖两种时序——
 *    归档先于 commit（提交点 thread_archived 冲突响应，head 不推进、
 *    不投递）与 commit 先于归档（seal 取消剩余 pending + hold 挡投递）。
 * 5. 归档清理部分失败如实返回 partial（不伪装成功）。
 * 6. main Session 的独立归档语义不受影响（非线程成员不走线程归档）。
 *
 * 用真实 createThreadControl（真实 WorkThread / ThreadStore / Board）
 * + 注入 bridge / stopSession，seal 事务与并发行为来自真实落盘。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkThreadRuntimeBridge } from '@agentdev/core';
import { createThreadControl } from '../server/thread-control/thread-controller.js';
import { createThreadIntegration } from '../server/thread-control/thread-integration.js';
import { createThreadLifecycleService } from '../server/thread-control/thread-lifecycle.js';
import { createThreadSuccessionService } from '../server/thread-control/thread-succession.js';
import { createThreadRotationService } from '../server/thread-control/thread-rotation.js';
import { setupThreadRoutes } from '../server/thread-control/thread-routes.js';
import { deliverUserInput, UserTurnDeliveryError } from '../server/thread-control/input-gateway.js';
import { managedAgents } from '../server/shared/agent-access.js';
import { ThreadCommandStatus } from '../server/thread-control/thread-inbox.js';

// ─── 夹具 ─────────────────────────────────────────────────────────

let base = null;
let counter = 0;

function makeControl(bridgeOptions = {}) {
  const root = path.join(base, `arc-${++counter}`);
  const identitySource = async (_agentId, sessionId) =>
    String(sessionId || '').trim() ? 'coder' : null;
  const control = createThreadControl({
    rootDir: root,
    bridge: new WorkThreadRuntimeBridge(bridgeOptions),
    identitySource,
  });
  return control;
}

function makeEnvironment(bridgeOptions = {}) {
  const stopped = [];
  const control = makeControl(bridgeOptions);
  const integration = createThreadIntegration({ control });
  const succession = createThreadSuccessionService({
    threadControl: control,
    threadIntegration: integration,
    stopManagedAgent: async (agentId, sessionId) => { stopped.push({ agentId, sessionId, kind: 'succession' }); },
  });
  const lifecycle = createThreadLifecycleService({
    control,
    stopSession: async (agentId, sessionId) => {
      stopped.push({ agentId, sessionId, kind: 'lifecycle' });
      return { status: 'stopped' };
    },
  });
  return { control, core: control.core, board: control.board, archive: control.archive, integration, succession, lifecycle, stopped };
}

async function startThread(env, rootSessionId = 's1') {
  return env.core.start({ sessionRef: { agentId: 'programming-helper', sessionId: rootSessionId } });
}

function commandsById(record) {
  return Object.fromEntries((record.commands || []).map((c) => [c.commandId, c]));
}

before(async () => { base = mkdtempSync(path.join(os.tmpdir(), 'claw-archive-t004-')); });
after(async () => { if (base) await fs.rm(base, { recursive: true, force: true }); });

// ─── 路由层 mock（coder-acp-routes 同源模式）─────────────────────

function makeMockApp() {
  const routes = {};
  return {
    routes,
    get: (p, ...h) => { routes[`GET ${p}`] = h; },
    post: (p, ...h) => { routes[`POST ${p}`] = h; },
  };
}

async function callRoute(app, method, pattern, { params, body } = {}) {
  const handlers = app.routes[`${method} ${pattern}`];
  assert.ok(handlers, `route not registered: ${method} ${pattern}`);
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

// ─── 1. 归档立即拒绝新派发 ────────────────────────────────────────

describe('T004: 归档立即拒绝新派发', () => {
  it('routes reject new commands and deliver attempts with thread_archived after archive', async () => {
    const env = makeEnvironment();
    const thread = await startThread(env);
    await env.core.appendCommand({ threadId: thread.threadId, text: 'before archive', source: 'ui' });

    const app = makeMockApp();
    setupThreadRoutes(app, { json: () => () => {} }, { control: env.control, lifecycle: env.lifecycle });

    await env.lifecycle.archiveThread(thread.threadId);

    const cmdRes = await callRoute(app, 'POST', '/protoclaw/threads/:threadId/commands', {
      params: { threadId: thread.threadId },
      body: { text: 'new dispatch', source: 'ui' },
    });
    assert.equal(cmdRes.statusCode, 409);
    assert.equal(cmdRes.body.code, 'thread_archived');

    const delRes = await callRoute(app, 'POST', '/protoclaw/threads/:threadId/deliver', {
      params: { threadId: thread.threadId },
    });
    assert.equal(delRes.statusCode, 409);
    assert.equal(delRes.body.code, 'thread_archived');

    // 归档线程不再接受上下文变换派发（接力入口同样被拒）
    const begin = await env.integration.beginSessionSuccession({ agentId: 'programming-helper', sessionId: 's1', reason: 'trim' });
    assert.equal(begin.applied, false);
    assert.equal(begin.reason, 'thread_archived');

    const record = await env.core.getThread(thread.threadId);
    assert.equal(record.commands.length, 1);
    assert.equal(record.commands[0].status, ThreadCommandStatus.CANCELLED);
    assert.equal(record.pendingSuccession, null);
  });

  it('input gateway rejects new send to an archived thread head', async () => {
    const env = makeEnvironment();
    const thread = await startThread(env, 'ig-s1');
    await env.lifecycle.archiveThread(thread.threadId);

    const viewerKey = 'programming-helper::ig-s1';
    managedAgents.set(viewerKey, {
      agentId: 'programming-helper',
      selectedSessionId: 'ig-s1',
      sessionType: 'coder',
      viewerAgentId: 'viewer-arc-1',
      process: null,
    });
    try {
      await assert.rejects(
        deliverUserInput({ viewerAgentId: 'viewer-arc-1', text: '归档后新输入' }, { integration: env.integration }),
        (err) => err instanceof UserTurnDeliveryError && err.code === 'thread_archived' && err.status === 409,
      );
    } finally {
      managedAgents.delete(viewerKey);
    }

    const record = await env.core.getThread(thread.threadId);
    assert.equal(record.commands.length, 0);
  });
});

// ─── 2. 尚未开始的 command 全取消；恢复不复活 ─────────────────────

describe('T004: pending 取消与恢复不复活', () => {
  it('cancels every pending command with reason and time; unarchive does not revive them', async () => {
    const env = makeEnvironment();
    const thread = await startThread(env);
    const a = await env.core.appendCommand({ threadId: thread.threadId, text: 'one', source: 'ui' });
    const b = await env.core.appendCommand({ threadId: thread.threadId, text: 'two', source: 'ui' });

    const before = Date.now();
    const result = await env.lifecycle.archiveThread(thread.threadId, { reason: 'user_archive' });
    const after = Date.now();

    assert.equal(result.cleanup.commandsCancelled, 2);
    let record = await env.core.getThread(thread.threadId);
    const byId = commandsById(record);
    for (const { command } of [{ command: a.command }, { command: b.command }]) {
      assert.equal(byId[command.commandId].status, ThreadCommandStatus.CANCELLED);
      assert.equal(byId[command.commandId].lastReason, 'user_archive');
      assert.ok(byId[command.commandId].updatedAt >= before && byId[command.commandId].updatedAt <= after);
    }

    // 恢复：只恢复可调度资格，cancelled 不复活
    await env.lifecycle.unarchiveThread(thread.threadId);
    record = await env.core.getThread(thread.threadId);
    assert.equal(record.hold, false);
    assert.equal(record.commands.filter((c) => c.status === ThreadCommandStatus.PENDING).length, 0);
    assert.ok(record.commands.every((c) => c.status !== ThreadCommandStatus.PENDING));

    // 恢复后补投递不会把 cancelled 投出去
    const delivery = await env.integration.tryDeliver(thread.threadId);
    assert.equal(delivery.delivered, 0);
  });

  it('new commands after unarchive can be delivered normally', async () => {
    const turns = [];
    const env = makeEnvironment({
      enabled: true,
      resolveRuntimeViewerId: (agentId, sessionId) => (sessionId === 's1' ? 'viewer-s1' : null),
      submitTurn: async (params) => { turns.push(params); return { success: true }; },
    });
    const thread = await startThread(env);
    await env.core.appendCommand({ threadId: thread.threadId, text: 'old', source: 'ui' });
    await env.lifecycle.archiveThread(thread.threadId);
    await env.lifecycle.unarchiveThread(thread.threadId);

    const fresh = await env.core.appendCommand({ threadId: thread.threadId, text: 'new work', source: 'ui' });
    const delivery = await env.integration.tryDeliver(thread.threadId);

    assert.equal(delivery.delivered, 1);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].text, 'new work');
    const record = await env.core.getThread(thread.threadId);
    const freshRecord = record.commands.find((c) => c.commandId === fresh.command.commandId);
    assert.equal(freshRecord.status, ThreadCommandStatus.DELIVERED);
    const old = record.commands.find((c) => c.text === 'old');
    assert.equal(old.status, ThreadCommandStatus.CANCELLED);
  });
});

// ─── 3. 运行中调用收尾（inflight drain）───────────────────────────

describe('T004: 运行中调用收尾', () => {
  it('keeps started (in_flight) calls uncancellable-to-cancelled; completion trigger no longer consumes the next command', async () => {
    const turns = [];
    const env = makeEnvironment({
      enabled: true,
      resolveRuntimeViewerId: () => 'viewer-head',
      submitTurn: async (params) => { turns.push(params); return { success: true }; },
    });
    const thread = await startThread(env);
    // 一条已开始（in_flight）+ 两条尚未开始（pending）
    await env.core.store.update(thread.threadId, (draft) => {
      draft.commands.push({
        commandId: 'cmd-started', threadId: thread.threadId, kind: 'user_message',
        text: 'started call', source: 'ui', idempotencyKey: '', status: 'in_flight',
        attempts: 1, envelopeId: null, lastReason: null,
        createdAt: Date.now(), updatedAt: Date.now(), deliveredAt: Date.now(),
      });
      return draft;
    });
    await env.core.appendCommand({ threadId: thread.threadId, text: 'pending-1', source: 'ui' });
    await env.core.appendCommand({ threadId: thread.threadId, text: 'pending-2', source: 'ui' });

    const result = await env.lifecycle.archiveThread(thread.threadId);

    // 已开始调用进入 drain 清单，不被取消；不强制中断（无 interrupt 注入）
    assert.equal(result.cleanup.inflightDrain.count, 1);
    assert.deepEqual(result.cleanup.inflightDrain.commandIds, ['cmd-started']);
    assert.equal(result.cleanup.commandsCancelled, 2);
    const record = await env.core.getThread(thread.threadId);
    const byId = commandsById(record);
    assert.equal(byId['cmd-started'].status, 'in_flight');

    // 开始调用完成后（runtime 回到就绪）的补投触发点不再消费下一条
    const readyDelivery = await env.integration.handleRuntimeReady('programming-helper', 's1');
    assert.equal(readyDelivery.delivery.delivered, 0);
    assert.equal(readyDelivery.delivery.reason, 'thread_held');
    const explicit = await env.integration.tryDeliver(thread.threadId);
    assert.equal(explicit.delivered, 0);
    assert.equal(explicit.reason, 'thread_held');
    assert.equal(turns.length, 0);
  });
});

// ─── 4. 归档 × 接力并发（确定性交错，不靠 sleep）──────────────────

function makeRotation(env, { compactGate = null, onStop = null } = {}) {
  return createThreadRotationService({
    sessionApi: {
      updateSessionIndex: async () => ({}),
      compactAndResumeCurrentSession: async () => {
        if (compactGate) await compactGate;
        // result.agent 存在 = READY 证据（successorReady: true）
        return { session: { id: 's2' }, agent: { ready: true } };
      },
    },
    stopManagedAgent: async (agentId, sessionId) => {
      if (onStop) onStop(agentId, sessionId);
      return { status: 'stopped' };
    },
    threadIntegration: env.integration,
    threadControl: env.control,
    threadSuccession: env.succession,
  });
}

describe('T004: 归档与接力并发的冲突响应', () => {
  it('archive before commit: succession commit refused, head not advanced, old Inbox not consumed', async () => {
    const turns = [];
    const env = makeEnvironment({
      enabled: true,
      resolveRuntimeViewerId: () => 'viewer-head',
      submitTurn: async (params) => { turns.push(params); return { success: true }; },
    });
    const thread = await startThread(env);
    await env.core.appendCommand({ threadId: thread.threadId, text: 'old inbox work', source: 'ui' });

    // 接力开始（挡板写入），随后归档 seal，最后 commit 到达
    await env.integration.beginSessionSuccession({ agentId: 'programming-helper', sessionId: 's1', reason: 'trim' });
    const archiveResult = await env.lifecycle.archiveThread(thread.threadId);
    const commit = await env.succession.commitSuccession({
      agentId: 'programming-helper', fromSessionId: 's1', toSessionId: 's2',
      reason: 'trim', successorReady: true,
    });

    assert.equal(commit.applied, false);
    assert.equal(commit.reason, 'thread_archived');
    assert.equal(commit.stage, 'thread_archived');

    const record = await env.core.getThread(thread.threadId);
    assert.equal(record.headSessionId, 's1'); // head 未推进
    assert.equal(record.hold, true);
    assert.equal(record.pendingSuccession, null); // 挡板已收敛
    const byId = commandsById(record);
    const old = record.commands.find((c) => c.text === 'old inbox work');
    assert.equal(old.status, ThreadCommandStatus.CANCELLED);
    // 旧 Inbox 未被消费：没有任何投递发生
    assert.equal(turns.length, 0);
    assert.equal(archiveResult.cleanup.commandsCancelled, 1);
    // 失败的 successor runtime 被退役
    assert.ok(env.stopped.some((s) => s.kind === 'succession' && s.sessionId === 's2'));
  });

  it('archive races an in-flight rotation (gate at compact): commit still refused, no old Inbox consumed', async () => {
    const turns = [];
    const env = makeEnvironment({
      enabled: true,
      resolveRuntimeViewerId: () => 'viewer-head',
      submitTurn: async (params) => { turns.push(params); return { success: true }; },
    });
    const thread = await startThread(env);
    await env.core.appendCommand({ threadId: thread.threadId, text: 'old inbox work', source: 'ui' });

    // 用 gate 把 rotation 确定性地停在「交接已开始、compact 进行中」：
    // stopManagedAgent（pre-rotation retire）返回后 rotation 即进入
    // compactAndResumeCurrentSession 并等待 gate——此后归档介入。
    let releaseCompact;
    const compactGate = new Promise((resolve) => { releaseCompact = resolve; });
    let stoppedOnce;
    const stoppedOncePromise = new Promise((resolve) => { stoppedOnce = resolve; });
    let stopFired = false;
    const rotation = makeRotation(env, {
      compactGate,
      onStop: () => { if (!stopFired) { stopFired = true; stoppedOnce(); } },
    });

    const rotPromise = rotation.handleContextGuard('programming-helper', 's1');
    await stoppedOncePromise;
    // rotation 已写入交接挡板并停在 compact 中——此刻归档
    const archiveResult = await env.lifecycle.archiveThread(thread.threadId);
    // 释放 rotation，让它到达提交点
    releaseCompact();
    const rotResult = await rotPromise;

    assert.equal(rotResult.applied, false);
    assert.equal(rotResult.reason, 'thread_archived');
    assert.equal(archiveResult.cleanup.handoffConverged, true);

    const record = await env.core.getThread(thread.threadId);
    assert.equal(record.headSessionId, 's1');
    const old = record.commands.find((c) => c.text === 'old inbox work');
    assert.equal(old.status, ThreadCommandStatus.CANCELLED);
    assert.equal(turns.length, 0);
  });

  it('commit before archive: head advances, seal cancels the pending leftover, successor cannot consume', async () => {
    const turns = [];
    // 确定性交错：新 head（s2）的 runtime 只接受第一条投递——
    // 第二条在 commit 的投递循环中被 runtime_not_accepting 挡住（retryable），
    // 保持 pending 落进归档 seal 的取消范围。
    let runtimeResolves = 0;
    const env = makeEnvironment({
      enabled: true,
      resolveRuntimeViewerId: (agentId, headSessionId) => {
        if (headSessionId !== 's2') return null;
        return runtimeResolves++ === 0 ? 'viewer-s2' : null;
      },
      submitTurn: async (params) => { turns.push(params); return { success: true }; },
    });
    const thread = await startThread(env);
    await env.core.appendCommand({ threadId: thread.threadId, text: 'started-on-old', source: 'ui' });
    await env.core.appendCommand({ threadId: thread.threadId, text: 'leftover-pending', source: 'ui' });

    // commit 先到：head 推进 s1→s2，投递循环送出第一条后停在未就绪，
    // 第二条保持 pending（归属仍在旧 Inbox）。投递顺序不依赖 createdAt
    // 微秒差（同毫秒时框架按 commandId 字典序排），故按计数断言。
    await env.integration.beginSessionSuccession({ agentId: 'programming-helper', sessionId: 's1', reason: 'trim' });
    const commit = await env.succession.commitSuccession({
      agentId: 'programming-helper', fromSessionId: 's1', toSessionId: 's2',
      reason: 'trim', successorReady: true,
    });
    assert.equal(commit.applied, true);
    assert.equal(turns.length, 1);
    let record = await env.core.getThread(thread.threadId);
    let delivered = record.commands.filter((c) => c.status === ThreadCommandStatus.DELIVERED);
    let pending = record.commands.filter((c) => c.status === ThreadCommandStatus.PENDING);
    assert.equal(delivered.length, 1);
    assert.equal(pending.length, 1);
    const leftoverCommandId = pending[0].commandId;

    // 随后归档：seal 取消剩余 pending，已开始（delivered）的进入 drain
    const archiveResult = await env.lifecycle.archiveThread(thread.threadId);
    record = await env.core.getThread(thread.threadId);
    const leftover = record.commands.find((c) => c.commandId === leftoverCommandId);
    assert.equal(leftover.status, ThreadCommandStatus.CANCELLED);
    assert.equal(archiveResult.cleanup.commandsCancelled, 1);
    assert.equal(archiveResult.cleanup.inflightDrain.count, 1);
    assert.ok(archiveResult.cleanup.inflightDrain.commandIds.includes(delivered[0].commandId));

    // 归档后 successor 无法继续消费旧 Inbox：完成回调 / 显式投递全部被 hold 挡住
    const readyDelivery = await env.integration.handleRuntimeReady('programming-helper', 's2');
    assert.equal(readyDelivery.delivery.delivered, 0);
    assert.equal(readyDelivery.delivery.reason, 'thread_held');
    const explicit = await env.integration.tryDeliver(thread.threadId);
    assert.equal(explicit.delivered, 0);
    assert.equal(explicit.reason, 'thread_held');
    // 归档后零新增投递
    assert.equal(turns.length, 1);
  });
});

// ─── 5. 清理部分失败如实返回 ─────────────────────────────────────

describe('T004: 清理结果 complete / partial 区分', () => {
  it('reports partial with the failing stage when a runtime stop fails', async () => {
    const control = makeControl();
    const integration = createThreadIntegration({ control });
    void integration;
    const lifecycle = createThreadLifecycleService({
      control,
      stopSession: async (_agentId, sessionId) => {
        if (sessionId === 's1') throw new Error('stop timeout');
        return { status: 'stopped' };
      },
    });
    const thread = await control.core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 's1' } });

    const result = await lifecycle.archiveThread(thread.threadId);

    assert.equal(result.cleanup.status, 'partial');
    assert.deepEqual(result.cleanup.failures, [
      { stage: 'stop_runtime', sessionId: 's1', error: 'stop timeout' },
    ]);
    // 部分失败不掩盖已完成的取消事实
    const record = await control.core.getThread(thread.threadId);
    assert.equal(record.hold, true);
    const entry = await control.archive.list();
    assert.equal(entry[thread.threadId]?.cleanup.status, 'partial');
  });
});

// ─── 6. main Session 独立归档语义不受影响 ─────────────────────────

describe('T004: main Session 独立归档语义', () => {
  it('session archive route redirects thread members via lifecycle target resolution', async () => {
    // 源码级契约：session 归档路由经统一目标解析（resolveLifecycleTarget），
    // Thread 成员的归档 / 恢复定位所属 Thread 执行线程语义（archiveThread /
    // unarchiveThread），非成员 Session 保持独立归档
    // （archivePrebuiltSession）——main 的独立归档语义不被线程归档接管。
    const fsSync = await import('node:fs');
    const sessionRoutes = fsSync.readFileSync(
      new URL('../server/routes/session.js', import.meta.url), 'utf8',
    );
    const start = sessionRoutes.indexOf("app.post('/protoclaw/prebuilt_sessions/archive'");
    assert.ok(start >= 0, 'session archive route must exist');
    const route = sessionRoutes.slice(start, sessionRoutes.indexOf('app.post(', start + 10));
    assert.match(route, /resolveLifecycleTarget\(\{/);
    assert.match(route, /lifecycleTarget\.actual\.type === 'thread'/);
    assert.match(route, /threadLifecycle\.archiveThread\(lifecycleTarget\.actual\.id/);
    assert.match(route, /archivePrebuiltSession\(agent\.id, sessionId, archived/);
  });

  it('non-member sessions never enter thread archive', async () => {
    const env = makeEnvironment();
    await startThread(env);
    const found = await env.lifecycle.findThreadBySession('programming-helper', 'main-session-x');
    assert.equal(found, null);
    assert.equal(await env.archive.isArchived('main-session-x'), false);
  });
});
