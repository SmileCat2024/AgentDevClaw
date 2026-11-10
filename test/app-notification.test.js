/**
 * Tests for ADR-0030 notification foundation:
 * - server/shared/permission-registry.js 布尔通知项与 permissionDefaults 校验
 * - server/routes/app-notification.js 判定链、统一投递出口、事件级去重、
 *   runtime 状态感知（完成/输入请求）、POST /protoclaw/app_notifications 端点
 * - sse-events.js 的 app-notification 帧发布（模块级入口 → 实例环形缓冲）
 * - 三份 prebuilt metadata.json 的声明契约（工单"决策已定死"逐字校验）
 *
 * Uses node:test format per project convention (test/*.test.js).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

// 测试隔离：必须先固化 AGENTDEV_DATA_DIR 再动态 import server 模块——
// ESM 静态 import 会提升，模块加载先于 env 设置。auth.js / workspace-settings.js
// 的默认路径都在 USER_DATA_ROOT 下固化，不隔离会读真实用户数据目录。
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'claw-app-notification-test-'));
process.env.AGENTDEV_DATA_DIR = DATA_DIR;

const { PERMISSION_ITEMS, normalizePermissionDefaults, isValidPermissionValue } =
  await import('../server/shared/permission-registry.js');
const { createSseEventsModule } = await import('../server/routes/sse-events.js');
const {
  APP_NOTIFICATION_TYPES,
  resolveNotificationPermissionValue,
  deliverAppNotification,
  observeCallStatusSnapshot,
  observeThreadTurnFact,
  extractFinishTimestamp,
  extractCallOutcome,
  isSuspendedFinish,
  isRotationHandoffFinish,
  isFinishNews,
  setupAppNotificationRoutes,
} = await import('../server/routes/app-notification.js');
const { writeWorkspacePermissionValue } = await import('../server/routes/workspace-settings.js');
const { publishAppNotification } = await import('../server/routes/sse-events.js');

// ── SSE 装配（照 sse-events.test.js 的最小形态）─────────────────────

function makeFakeWorker() {
  let listener = null;
  return {
    onSessionEvent(cb) { listener = cb; return () => { listener = null; }; },
    listAgentStates: () => [],
    getNotificationSnapshot: () => null,
    getOverviewSnapshot: () => null,
    getTodoSnapshot: () => null,
    getInputRequestsSnapshot: () => null,
    getQueuedInputsSnapshot: () => null,
  };
}

function parseFrames(text) {
  return text.split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const frame = { id: null, event: null, data: null, comment: false };
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) { frame.comment = true; continue; }
        if (line.startsWith('id: ')) frame.id = Number(line.slice(4));
        else if (line.startsWith('event: ')) frame.event = line.slice(7);
        else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
      }
      return frame;
    });
}

const sse = {};

before(async () => {
  // 单实例注册模块级 publisher：全部用例共享（closeAll 在 after 收口）。
  sse.mod = createSseEventsModule({ viewerWorker: makeFakeWorker(), coalesceMs: 5, heartbeatMs: 25, ringSize: 64 });
  sse.app = express();
  sse.mod.setupRoutes(sse.app);
  sse.server = http.createServer(sse.app);
  await new Promise((resolve) => sse.server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${sse.server.address().port}/protoclaw/events`, {
    signal: controller.signal,
  });
  sse.streamText = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  sse.pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (value) sse.streamText += decoder.decode(value, { stream: true });
        if (done) break;
      }
    } catch { /* aborted */ }
  })();
  sse.abort = () => controller.abort();
  // 等 hello（注册 → 重放 → hello → live=true 时序；live 之前帧只进缓冲）
  const deadline = Date.now() + 1000;
  while (!sse.streamText.includes('event: hello') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3));
  }
});

after(async () => {
  sse.abort?.();
  sse.mod?.closeAll();
  sse.server?.closeAllConnections?.();
  await new Promise((resolve) => sse.server?.close(resolve));
  rmSync(DATA_DIR, { recursive: true, force: true });
});

/** 等待 app-notification 帧文本出现在流中（3ms tick，1s 超时）。 */
async function waitAppNotificationFrame(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frames = parseFrames(sse.streamText).filter((f) => f.event === 'app-notification');
    const hit = frames.find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 3));
  }
}

// ── 1. 权限项族（permission-registry）───────────────────────────────

describe('permission registry: notification boolean items', () => {
  it('registers the three notification items as boolean', () => {
    for (const id of ['notifications.finish', 'notifications.reminder', 'notifications.input']) {
      assert.equal(PERMISSION_ITEMS[id]?.valueType, 'boolean', id);
      assert.equal(typeof PERMISSION_ITEMS[id]?.validate, 'function', id);
      assert.equal(isValidPermissionValue(id, true), true, id);
      assert.equal(isValidPermissionValue(id, false), true, id);
      assert.equal(isValidPermissionValue(id, 'true'), false, id);
      assert.equal(isValidPermissionValue(id, 1), false, id);
      assert.equal(isValidPermissionValue(id, null), false, id);
    }
  });

  it('keeps maxLiveThreads intact alongside the new items', () => {
    assert.equal(PERMISSION_ITEMS.maxLiveThreads?.valueType, 'positive-integer');
    assert.equal(isValidPermissionValue('maxLiveThreads', 3), true);
    assert.equal(isValidPermissionValue('maxLiveThreads', true), false);
  });

  it('normalizes permissionDefaults: undefined -> {}, valid projection', () => {
    assert.deepEqual(normalizePermissionDefaults(undefined, ['notifications.finish']), {});
    assert.deepEqual(
      normalizePermissionDefaults({ 'notifications.finish': true }, ['notifications.finish']),
      { 'notifications.finish': true },
    );
  });

  it('rejects permissionDefaults with undeclared keys', () => {
    assert.throws(
      () => normalizePermissionDefaults({ 'notifications.input': true }, ['notifications.finish']),
      /未声明/,
    );
    assert.throws(
      () => normalizePermissionDefaults({ 'maxLiveThreads': 2 }, ['notifications.finish']),
      /未声明/,
    );
  });

  it('rejects permissionDefaults with unknown ids or invalid values', () => {
    assert.throws(
      () => normalizePermissionDefaults({ 'notifications.finish': 'yes' }, ['notifications.finish']),
      /值非法/,
    );
    assert.throws(() => normalizePermissionDefaults('nope', ['notifications.finish']), /必须是对象/);
    assert.throws(() => normalizePermissionDefaults([], ['notifications.finish']), /必须是对象/);
  });
});

// ── 2. 三层判定链 ────────────────────────────────────────────────────

describe('resolveNotificationPermissionValue: override > default > false', () => {
  it('user override wins over author default (both directions)', () => {
    assert.equal(resolveNotificationPermissionValue({ userValue: false, authorDefault: true }), false);
    assert.equal(resolveNotificationPermissionValue({ userValue: true, authorDefault: false }), true);
  });
  it('author default applies when unset; fallback is false', () => {
    assert.equal(resolveNotificationPermissionValue({ userValue: undefined, authorDefault: true }), true);
    assert.equal(resolveNotificationPermissionValue({ userValue: undefined, authorDefault: false }), false);
    assert.equal(resolveNotificationPermissionValue({ userValue: undefined, authorDefault: undefined }), false);
    assert.equal(resolveNotificationPermissionValue({}), false);
  });
});

// ── 3. metadata 声明契约（工单"决策已定死"逐字）─────────────────────

describe('prebuilt metadata permission contracts', () => {
  const root = path.resolve('prebuilt-agents/official');

  async function readMetadata(agentId) {
    return JSON.parse(await readFile(path.join(root, agentId, 'metadata.json'), 'utf8'));
  }

  it('programming-helper: finish=true, input=true, both declared', async () => {
    const meta = await readMetadata('programming-helper');
    assert.deepEqual(meta.permissions, ['notifications.finish', 'notifications.input']);
    assert.deepEqual(normalizePermissionDefaults(meta.permissionDefaults, meta.permissions), {
      'notifications.finish': true,
      'notifications.input': true,
    });
  });

  it('coder: finish=false declared, maxLiveThreads kept for the quota gate, rotation strategy defaults adaptive', async () => {
    const meta = await readMetadata('coder');
    assert.ok(meta.permissions.includes('maxLiveThreads'), 'quota gate depends on this declaration');
    assert.deepEqual(normalizePermissionDefaults(meta.permissionDefaults, meta.permissions), {
      'notifications.finish': false,
      contextRotationStrategy: 'adaptive',
      runtimeExecutionMode: 'standard',
    });
  });

  it('memo: reminder=true, input=true, both declared', async () => {
    const meta = await readMetadata('memo');
    assert.deepEqual(meta.permissions, ['notifications.reminder', 'notifications.input']);
    assert.deepEqual(normalizePermissionDefaults(meta.permissionDefaults, meta.permissions), {
      'notifications.reminder': true,
      'notifications.input': true,
    });
  });
});

// ── 4. 统一投递出口：判定 + 去重 + 帧发布 ───────────────────────────

describe('deliverAppNotification', () => {
  const settingsPath = () => path.join(mkdtempSync(path.join(tmpdir(), 'claw-appnotif-ws-')), 'workspace-settings.json');
  const requireAgent = async (agentId) => ({
    id: agentId,
    permissionDefaults: { 'notifications.finish': true, 'notifications.input': true, 'notifications.reminder': true },
  });

  it('blocks delivery when neither override nor default allows it', async () => {
    const delivered = await deliverAppNotification({
      agentId: 'no-defaults', type: 'reminder', title: 'x',
      requireAgent: async () => ({ permissionDefaults: {} }),
      settingsPath: settingsPath(),
    });
    assert.equal(delivered, false);
  });

  it('delivers via author default and emits an app-notification frame', async () => {
    const agentId = 'default-allowed';
    const ok = await deliverAppNotification({
      agentId, type: 'finish', finishTs: 1710000000000,
      dedupeKey: `${agentId}:1710000000000`,
      requireAgent, settingsPath: settingsPath(),
    });
    assert.equal(ok, true);
    const frame = await waitAppNotificationFrame((f) => f.data.agentId === agentId);
    assert.ok(frame, 'expected an app-notification frame');
    assert.equal(frame.data.type, 'finish');
    assert.equal(frame.data.finishTs, 1710000000000);
    assert.equal(frame.data.kind, 'app-notification');
  });

  it('user override false beats author default true; true beats false', async () => {
    const sp = settingsPath();
    await writeWorkspacePermissionValue('override-agent', 'notifications.finish', false, { settingsPath: sp });
    assert.equal(await deliverAppNotification({
      agentId: 'override-agent', type: 'finish', finishTs: 1,
      dedupeKey: 'override-agent:1', requireAgent, settingsPath: sp,
    }), false);
    await writeWorkspacePermissionValue('override-agent2', 'notifications.finish', true, { settingsPath: sp });
    assert.equal(await deliverAppNotification({
      agentId: 'override-agent2', type: 'finish', finishTs: 2,
      dedupeKey: 'override-agent2:2', requireAgent, settingsPath: sp,
    }), true);
  });

  it('dedupes at event level: same fact key delivers once', async () => {
    const agentId = 'dedupe-agent';
    const base = { agentId, type: 'finish', finishTs: 555, requireAgent, settingsPath: settingsPath() };
    assert.equal(await deliverAppNotification({ ...base, dedupeKey: `${agentId}:555` }), true);
    assert.equal(await deliverAppNotification({ ...base, dedupeKey: `${agentId}:555` }), false);
    // 不同事实（新 finishTs）照常投递
    assert.equal(await deliverAppNotification({ ...base, finishTs: 556, dedupeKey: `${agentId}:556` }), true);
  });

  it('rejects unknown types and blank agentIds', async () => {
    assert.equal(await deliverAppNotification({ agentId: 'a', type: 'party', requireAgent }), false);
    assert.equal(await deliverAppNotification({ agentId: '', type: 'finish', requireAgent }), false);
    assert.deepEqual(Object.keys(APP_NOTIFICATION_TYPES).sort(), ['finish', 'input', 'reminder']);
  });
});

// ── 5. runtime 状态感知（完成 / 输入请求）───────────────────────────

describe('observeCallStatusSnapshot', () => {
  const settingsPath = () => path.join(mkdtempSync(path.join(tmpdir(), 'claw-appnotif-ob-')), 'workspace-settings.json');
  const requireAgent = async (agentId) => ({
    id: agentId,
    permissionDefaults: { 'notifications.finish': true, 'notifications.input': true },
  });

  const finishSnapshot = (ts) => ({
    state: { type: 'call.start', timestamp: ts - 100 },
    event: { type: 'call.finish', timestamp: ts, data: { status: 'completed' } },
    runtime: { callActive: false, stage: 'completed', updatedAt: ts },
  });

  it('publishes finish for call.finish snapshots with the event timestamp', async () => {
    const agentId = 'observe-finish';
    await observeCallStatusSnapshot('notification', agentId, finishSnapshot(1710000000777), { requireAgent, settingsPath: settingsPath() });
    const frame = await waitAppNotificationFrame((f) => f.data.agentId === agentId && f.data.type === 'finish');
    assert.ok(frame);
    assert.equal(frame.data.finishTs, 1710000000777);
    assert.equal(frame.data.outcomeStatus, 'completed');
  });

  it('publishes failed outcome and error details without changing the notification type', async () => {
    const agentId = 'observe-failed';
    const snapshot = {
      event: {
        type: 'call.finish', timestamp: 1710000000780,
        data: { status: 'failed', reason: 'error', error: { message: 'provider disconnected' } },
      },
    };
    await observeCallStatusSnapshot('notification', agentId, snapshot, { requireAgent, settingsPath: settingsPath() });
    const frame = await waitAppNotificationFrame((f) => f.data.agentId === agentId && f.data.type === 'finish');
    assert.ok(frame);
    assert.equal(frame.data.outcomeStatus, 'failed');
    assert.equal(frame.data.outcomeReason, 'error');
    assert.equal(frame.data.errorMessage, 'provider disconnected');
  });

  it('normalizes runtime-form agentId via resolveAgentId before permission checks', async () => {
    // SSE 快照的 agentId 是 runtime 形态（agent-<n>-<pid>），权限表与
    // metadata 按 prebuilt id 键控：归一后才应命中作者默认并发布（回归：
    // 上线期感知路径因 ID 形态断裂全部静默拒绝）。
    const runtimeId = 'agent-1-23188';
    const prebuiltId = 'observe-runtime-map';
    await observeCallStatusSnapshot('notification', runtimeId, finishSnapshot(1710000000888), {
      requireAgent, settingsPath: settingsPath(),
      resolveAgentId: (id) => (id === runtimeId ? prebuiltId : id),
    });
    const frame = await waitAppNotificationFrame((f) => f.data.agentId === prebuiltId && f.data.type === 'finish');
    assert.ok(frame);
    assert.equal(frame.data.finishTs, 1710000000888);
    // 会话粒度定位必须透传（多会话工作空间的焦点判定依据，丢失即误杀兄弟会话）
    assert.equal(frame.data.runtimeAgentId, runtimeId);
  });

  it('passes agentId through when resolveAgentId misses or is absent', async () => {
    const agentId = 'observe-passthrough';
    await observeCallStatusSnapshot('notification', agentId, finishSnapshot(1710000000999), {
      requireAgent, settingsPath: settingsPath(),
      resolveAgentId: () => null, // 未命中：透传原值
    });
    const frame = await waitAppNotificationFrame((f) => f.data.agentId === agentId && f.data.type === 'finish');
    assert.ok(frame);
  });

  it('does not publish for suspended finishes (ADR-0019)', async () => {
    const agentId = 'observe-suspended';
    const snapshot = finishSnapshot(1710000000778);
    snapshot.event.data = { status: 'continued', reason: 'suspended' };
    snapshot.runtime.lastOutcome = { status: 'continued', reason: 'suspended' };
    const before = parseFrames(sse.streamText).filter((f) => f.event === 'app-notification').length;
    await observeCallStatusSnapshot('notification', agentId, snapshot, { requireAgent, settingsPath: settingsPath() });
    await new Promise((r) => setTimeout(r, 20));
    const frames = parseFrames(sse.streamText).filter((f) => f.event === 'app-notification');
    assert.equal(frames.filter((f) => f.data.agentId === agentId).length, 0);
    assert.ok(parseFrames(sse.streamText).filter((f) => f.event === 'app-notification').length >= before);
  });

  it('does not publish for rotation-handoff interrupts (cancelled + interruptedBy cause)', async () => {
    // 自动接续过界打断的轮次：工作移交 successor 继续，本会话的「已取消」
    // 对用户是误导（历史 bug：桌面通知在接续时弹「已取消」）
    const agentId = 'observe-rotation-handoff';
    const snapshot = finishSnapshot(1710000000666);
    snapshot.event.data = { status: 'cancelled', reason: 'cancelled', interruptedBy: 'context_rotation' };
    snapshot.runtime.lastOutcome = { status: 'cancelled', reason: 'cancelled', interruptedBy: 'context_rotation' };
    snapshot.runtime.stage = 'cancelled';
    const before = parseFrames(sse.streamText).filter((f) => f.event === 'app-notification').length;
    await observeCallStatusSnapshot('notification', agentId, snapshot, { requireAgent, settingsPath: settingsPath() });
    await new Promise((r) => setTimeout(r, 20));
    const frames = parseFrames(sse.streamText).filter((f) => f.event === 'app-notification');
    assert.equal(frames.filter((f) => f.data.agentId === agentId).length, 0);
    assert.ok(frames.length >= before);
  });

  it('still publishes cancelled finishes without a rotation cause (user interrupts keep feedback)', async () => {
    const agentId = 'observe-cancelled-plain';
    const snapshot = finishSnapshot(1710000000555);
    snapshot.event.data = { status: 'cancelled', reason: 'cancelled' };
    snapshot.runtime.lastOutcome = { status: 'cancelled', reason: 'cancelled' };
    snapshot.runtime.stage = 'cancelled';
    await observeCallStatusSnapshot('notification', agentId, snapshot, { requireAgent, settingsPath: settingsPath() });
    const frame = await waitAppNotificationFrame((f) => f.data.agentId === agentId && f.data.type === 'finish');
    assert.ok(frame);
    assert.equal(frame.data.outcomeStatus, 'cancelled');
  });

  it('ignores non-finish snapshots (call.start / calling state)', async () => {
    assert.equal(extractFinishTimestamp({ state: { type: 'call.start', timestamp: 9 } }), 0);
    assert.equal(extractFinishTimestamp(null), 0);
    const agentId = 'observe-start';
    const before = parseFrames(sse.streamText).filter((f) => f.event === 'app-notification').length;
    await observeCallStatusSnapshot('notification', agentId, { state: { type: 'call.start', timestamp: 999 } }, { requireAgent, settingsPath: settingsPath() });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(parseFrames(sse.streamText).filter((f) => f.event === 'app-notification' && f.data.agentId === agentId).length, 0);
    assert.ok(parseFrames(sse.streamText).filter((f) => f.event === 'app-notification').length >= before);
  });

  it('extracts finish timestamps from settled runtime snapshots', () => {
    assert.equal(extractFinishTimestamp({
      runtime: { callActive: false, stage: 'failed', updatedAt: 1710000000123 },
    }), 1710000000123);
    assert.equal(extractFinishTimestamp({
      runtime: { callActive: false, stage: 'running', updatedAt: 1710000000123 },
    }), 0);
    assert.equal(extractFinishTimestamp({
      state: null,
      event: { type: 'call.finish', timestamp: 1710000000 },
    }), 1710000000000, 'seconds are normalized to ms');
  });

  it('preserves explicit terminal outcome for the notification consumer', () => {
    assert.deepEqual(extractCallOutcome(finishSnapshot(1710000000123)), {
      outcomeStatus: 'completed',
    });
    assert.deepEqual(extractCallOutcome({
      event: { type: 'call.finish', timestamp: 1710000000124, data: {
        status: 'failed', reason: 'error', error: { message: 'provider disconnected' },
      } },
    }), {
      outcomeStatus: 'failed',
      outcomeReason: 'error',
      errorMessage: 'provider disconnected',
    });
    assert.deepEqual(extractCallOutcome({
      runtime: { lastOutcome: { status: 'cancelled', reason: 'cancelled' } },
    }), {
      outcomeStatus: 'cancelled',
      outcomeReason: 'cancelled',
    });
    assert.equal(extractCallOutcome({
      runtime: { callActive: false, stage: 'failed' },
    }), null, '运行结束状态不包含 CallOutcome 时不得推测结果');
  });

  it('flags suspended outcomes', () => {
    assert.equal(isSuspendedFinish({ runtime: { lastOutcome: { status: 'continued', reason: 'suspended' } } }), true);
    assert.equal(isSuspendedFinish({ event: { type: 'call.finish', data: { status: 'completed' } } }), false);
  });

  it('isFinishNews: suspended / rotation-handoff are not news; other terminals are', () => {
    // 单一权威判定（两路归一后共用）：挂起与接续移交不投递，用户手动
    // 打断（cancelled 无移交）与 completed / failed 照常——与快照路径
    // 既有行为对齐（cancelled 在快照路径投递「已取消」，线程事实路径
    // 在上游整体跳过，均不受本谓词改变）。
    assert.equal(isFinishNews({ status: 'completed', suspended: true }), false, '挂起（等后台任务）不是完成新闻');
    assert.equal(isFinishNews({ status: 'cancelled', rotationHandoff: true }), false, '接续移交不是完成新闻');
    assert.equal(isFinishNews({ status: 'completed' }), true);
    assert.equal(isFinishNews({ status: 'failed' }), true);
    assert.equal(isFinishNews({ status: 'cancelled' }), true, '用户手动打断仍通知「已取消」');
    assert.equal(isFinishNews({}), true, '无挂起/移交事实的终态默认是新闻');
  });

  it('flags rotation-handoff finishes (cancelled + interruptedBy, both snapshot paths)', () => {
    // 字面量 'context_rotation' 是跨层词汇（守卫申报 → CallOutcome 携带 →
    // 出口匹配），测试用字面量锁定线上值：改名时此处强制两侧同步
    assert.equal(isRotationHandoffFinish({
      runtime: { lastOutcome: { status: 'cancelled', reason: 'cancelled', interruptedBy: 'context_rotation' } },
    }), true);
    assert.equal(isRotationHandoffFinish({
      event: { type: 'call.finish', data: { status: 'cancelled', reason: 'cancelled', interruptedBy: 'context_rotation' } },
    }), true);
    // 用户手动打断（无申报原因）与 completed 自然收尾都不是接续移交
    assert.equal(isRotationHandoffFinish({
      runtime: { lastOutcome: { status: 'cancelled', reason: 'cancelled' } },
    }), false);
    assert.equal(isRotationHandoffFinish({
      event: { type: 'call.finish', data: { status: 'completed', interruptedBy: 'context_rotation' } },
    }), false);
  });

  it('publishes input notifications for choice leases only, dedup by requestId', async () => {
    const agentId = 'observe-input';
    const sp = settingsPath();
    const leases = [
      { requestId: 'req-1', mode: 'choices', questions: [{ prompt: 'pick' }] },
      { requestId: 'req-plain', mode: 'text' },
    ];
    await observeCallStatusSnapshot('input-requests', agentId, leases, { requireAgent, settingsPath: sp });
    const frame = await waitAppNotificationFrame((f) => f.data.agentId === agentId && f.data.type === 'input');
    assert.ok(frame);
    assert.equal(frame.data.requestId, 'req-1');
    // 重放同快照：requestId 事件级去重，不再发帧
    const before = parseFrames(sse.streamText).filter((f) => f.event === 'app-notification').length;
    await observeCallStatusSnapshot('input-requests', agentId, leases, { requireAgent, settingsPath: sp });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(parseFrames(sse.streamText).filter((f) => f.event === 'app-notification').length, before);
  });

  it('yields finish to thread-turn facts for thread-host agents; input requests unaffected (ADR-0042)', async () => {
    // 线程宿主（coder / qqbot 接线员等）的完成事实由 observeThreadTurnFact
    // 承载（带线程身份与交付文本）；快照路径对 host 的 finish 让位，避免
    // 同一轮次双通知。选择请求（input）不经轮次事实，照常投递。
    const hostId = 'coder';
    const isThreadHostAgentId = (id) => id === 'coder';
    const sp = settingsPath();

    // host 的 finish 快照：不发帧
    await observeCallStatusSnapshot('notification', hostId, finishSnapshot(1710000000111), {
      requireAgent, settingsPath: sp, isThreadHostAgentId,
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(parseFrames(sse.streamText)
      .filter((f) => f.event === 'app-notification' && f.data.agentId === hostId && f.data.type === 'finish').length, 0);

    // 非 host 的 finish 快照：照常发帧（让位只作用于线程宿主）
    const plainId = 'observe-nonhost';
    await observeCallStatusSnapshot('notification', plainId, finishSnapshot(1710000000222), {
      requireAgent, settingsPath: sp, isThreadHostAgentId,
    });
    const plainFrame = await waitAppNotificationFrame((f) => f.data.agentId === plainId && f.data.type === 'finish');
    assert.ok(plainFrame);

    // host 的 choice 请求：仍走快照路径（轮次事实不覆盖输入请求）
    await observeCallStatusSnapshot('input-requests', hostId, [
      { requestId: 'req-host-1', mode: 'choices', questions: [{ prompt: 'pick' }] },
    ], { requireAgent, settingsPath: sp, isThreadHostAgentId });
    const hostInputFrame = await waitAppNotificationFrame((f) => f.data.agentId === hostId && f.data.type === 'input');
    assert.ok(hostInputFrame);
    assert.equal(hostInputFrame.data.requestId, 'req-host-1');
  });
});

// ── 5b. 线程轮次终态事实感知（ADR-0042 决策 4 非 IM 首订阅者）────────

describe('observeThreadTurnFact', () => {
  const settingsPath = () => path.join(mkdtempSync(path.join(tmpdir(), 'claw-appnotif-tt-')), 'workspace-settings.json');
  const requireAgent = async (agentId) => ({
    id: agentId,
    permissionDefaults: { 'notifications.finish': true },
  });

  it('delivers finish with thread identity and delivery excerpt for completed turns', async () => {
    const fact = {
      threadId: 'wt-abc', agentId: 'coder', sessionId: 's1', status: 'completed',
      turn: 7, resultText: '修复完成：新增 3 条测试',
    };
    await observeThreadTurnFact(fact, { requireAgent, settingsPath: settingsPath() });
    const frame = await waitAppNotificationFrame((f) => f.data.agentId === 'coder' && f.data.type === 'finish');
    assert.ok(frame);
    assert.equal(frame.data.threadId, 'wt-abc');
    assert.equal(frame.data.outcomeStatus, 'completed');
    assert.equal(frame.data.body, '修复完成：新增 3 条测试');
  });

  it('caps the delivery excerpt at 200 chars (frame payload sanity)', async () => {
    const longText = 'x'.repeat(300);
    await observeThreadTurnFact({
      threadId: 'wt-long', agentId: 'tt-long', sessionId: 's1', status: 'completed',
      turn: 1, resultText: longText,
    }, { requireAgent, settingsPath: settingsPath() });
    const frame = await waitAppNotificationFrame((f) => f.data.agentId === 'tt-long' && f.data.type === 'finish');
    assert.ok(frame);
    assert.equal(frame.data.body.length, 200);
  });

  it('delivers failed turns with error message; skips cancelled (not finish news)', async () => {
    await observeThreadTurnFact({
      threadId: 'wt-f', agentId: 'tt-failed', sessionId: 's1', status: 'failed',
      turn: 2, error: { message: 'provider disconnected', reason: 'error', category: 'runtime' },
    }, { requireAgent, settingsPath: settingsPath() });
    const frame = await waitAppNotificationFrame((f) => f.data.agentId === 'tt-failed' && f.data.type === 'finish');
    assert.ok(frame);
    assert.equal(frame.data.outcomeStatus, 'failed');
    assert.equal(frame.data.errorMessage, 'provider disconnected');

    // 用户/宿主自己打断的轮次不是完成新闻：不投递
    const before = parseFrames(sse.streamText).filter((f) => f.event === 'app-notification').length;
    await observeThreadTurnFact({
      threadId: 'wt-c', agentId: 'tt-cancelled', sessionId: 's1', status: 'cancelled', turn: 3,
    }, { requireAgent, settingsPath: settingsPath() });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(parseFrames(sse.streamText)
      .filter((f) => f.event === 'app-notification' && f.data.agentId === 'tt-cancelled').length, 0);
    assert.ok(parseFrames(sse.streamText).filter((f) => f.event === 'app-notification').length >= before);
  });

  it('skips suspended turns: waiting on background work is not finish news (ADR-0019)', async () => {
    // 线程宿主（编程小助手等）的轮次挂起（等后台任务唤醒）不是完成事实：
    // 判定经 isFinishNews 单一权威，与快照路径同口径（历史回归：2026-11-10
    // 事实路径漏检挂起，等后台任务的轮次结束被弹成「已完成」）。
    const frames = () => parseFrames(sse.streamText)
      .filter((f) => f.event === 'app-notification' && f.data.agentId === 'tt-suspended');
    const before = frames().length;
    await observeThreadTurnFact({
      threadId: 'wt-s', agentId: 'tt-suspended', sessionId: 's1', status: 'completed',
      turn: 4, suspended: true, pendingWakeups: [{ source: 'shell', id: 'bg-1', summary: 'npm test' }],
    }, { requireAgent, settingsPath: settingsPath() });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(frames().length, before);
  });

  it('dedupes per turn fact: same thread+turn+status delivers once', async () => {
    const fact = {
      threadId: 'wt-d', agentId: 'tt-dedupe', sessionId: 's1', status: 'completed', turn: 9,
    };
    const base = { requireAgent, settingsPath: settingsPath() };
    await observeThreadTurnFact(fact, base);
    const frame = await waitAppNotificationFrame((f) => f.data.agentId === 'tt-dedupe' && f.data.type === 'finish');
    assert.ok(frame);
    const before = parseFrames(sse.streamText).filter((f) => f.event === 'app-notification').length;
    await observeThreadTurnFact(fact, base); // 同一轮次事实重放：不再发帧
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(parseFrames(sse.streamText).filter((f) => f.event === 'app-notification').length, before);
  });

  it('enriches fact frames with session-granularity material (runtimeAgentId / title / finishTs)', async () => {
    // 帧只带工作空间粒度 agentId 会把「哪个会话完成」抹平成「哪个工作空间
    // 完成」（2026-11-05 回归：PH 完成通知只剩兜底文案）。resolve 注入把
    // fact.sessionId 解析回会话粒度：runtimeAgentId（前端焦点判定 / 条目
    // 查找 / messages 预览 / 导航）+ title（降级时的会话标题）+ finishTs
    // （前端事件级去重键：不同轮次不同帧，重放同帧同值）。
    const fact = {
      threadId: 'wt-enrich', agentId: 'tt-enrich', sessionId: 's-42', status: 'completed', turn: 1,
      resultText: '修复完成',
    };
    await observeThreadTurnFact(fact, {
      requireAgent, settingsPath: settingsPath(),
      resolveRuntimeAgentId: async () => 'agent-7-9000',
      resolveSessionTitle: async () => '修复登录超时',
    });
    const frame = await waitAppNotificationFrame((f) => f.data.agentId === 'tt-enrich' && f.data.type === 'finish');
    assert.ok(frame);
    assert.equal(frame.data.runtimeAgentId, 'agent-7-9000');
    assert.equal(frame.data.title, '修复登录超时');
    assert.ok(Number.isFinite(frame.data.finishTs) && frame.data.finishTs > 0);
  });

  it('delivers degraded frames when resolvers miss or throw (body/threadId still present)', async () => {
    await observeThreadTurnFact({
      threadId: 'wt-deg', agentId: 'tt-degraded', sessionId: 's-404', status: 'completed', turn: 2,
      resultText: '部分交付文本',
    }, {
      requireAgent, settingsPath: settingsPath(),
      resolveRuntimeAgentId: async () => { throw new Error('registry miss'); },
      resolveSessionTitle: async () => null,
    });
    const frame = await waitAppNotificationFrame((f) => f.data.agentId === 'tt-degraded' && f.data.type === 'finish');
    assert.ok(frame);
    assert.equal('runtimeAgentId' in frame.data, false);
    assert.equal('title' in frame.data, false);
    assert.equal(frame.data.body, '部分交付文本');
    assert.equal(frame.data.threadId, 'wt-deg');
    assert.ok(frame.data.finishTs > 0);
  });

  it('silently skips when the permission gate blocks (thread facts follow the same gate)', async () => {
    const strictRequire = async (agentId) => ({ id: agentId, permissionDefaults: {} });
    await observeThreadTurnFact({
      threadId: 'wt-np', agentId: 'tt-noperm', sessionId: 's1', status: 'completed', turn: 1,
    }, { requireAgent: strictRequire, settingsPath: settingsPath() });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(parseFrames(sse.streamText)
      .filter((f) => f.event === 'app-notification' && f.data.agentId === 'tt-noperm').length, 0);
  });
});

// ── 6. POST /protoclaw/app_notifications ────────────────────────────

describe('POST /protoclaw/app_notifications', () => {
  const app = express();
  const requireAgent = async (agentId) => {
    if (agentId === 'ghost-agent') throw Object.assign(new Error('Unknown agent'), { statusCode: 404 });
    if (agentId === 'no-perm-agent') return { id: agentId, permissionDefaults: {} };
    return { id: agentId, permissionDefaults: { 'notifications.reminder': true, 'notifications.input': true } };
  };
  setupAppNotificationRoutes(app, express, { requireAgent });
  const server = http.createServer(app);

  before(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });
  after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  const url = () => `http://127.0.0.1:${server.address().port}/protoclaw/app_notifications`;
  // auth.js 在模块加载时把 serviceToken 写入该 env（AGENTDEV_DATA_DIR 已隔离）
  const token = () => process.env.PROTOCLAW_INTERNAL_TOKEN;
  const post = (body, headers = {}) => fetch(url(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  it('rejects without internal auth (403 internal_only)', async () => {
    const res = await post({ agentId: 'memo', type: 'reminder', title: 'hi' });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'internal_only');
  });

  it('rejects a wrong bearer token', async () => {
    const res = await post({ agentId: 'memo', type: 'reminder' }, { authorization: 'Bearer wrong-token' });
    assert.equal(res.status, 403);
  });

  it('404s for unknown agents', async () => {
    const res = await post({ agentId: 'ghost-agent', type: 'reminder' }, { authorization: `Bearer ${token()}` });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, 'unknown_agent');
  });

  it('400s for out-of-enum types and missing agentId', async () => {
    const auth = { authorization: `Bearer ${token()}` };
    const badType = await post({ agentId: 'memo', type: 'newsletter' }, auth);
    assert.equal(badType.status, 400);
    const noAgent = await post({ type: 'reminder' }, auth);
    assert.equal(noAgent.status, 400);
  });

  it('delivers a reminder for an allowed agent (200, delivered:true)', async () => {
    const res = await post({ agentId: 'memo', type: 'reminder', title: '到点了', body: '喝水', threadId: 't1' }, { authorization: `Bearer ${token()}` });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, delivered: true });
    const frame = await waitAppNotificationFrame((f) => f.data.agentId === 'memo' && f.data.type === 'reminder');
    assert.ok(frame);
    assert.equal(frame.data.title, '到点了');
    assert.equal(frame.data.threadId, 't1');
  });

  it('reports delivered:false (not an error) when the permission gate blocks', async () => {
    const res = await post({ agentId: 'no-perm-agent', type: 'reminder' }, { authorization: `Bearer ${token()}` });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, delivered: false });
  });
});
