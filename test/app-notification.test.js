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
  extractFinishTimestamp,
  isSuspendedFinish,
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

  it('flags suspended outcomes', () => {
    assert.equal(isSuspendedFinish({ runtime: { lastOutcome: { status: 'continued', reason: 'suspended' } } }), true);
    assert.equal(isSuspendedFinish({ event: { type: 'call.finish', data: { status: 'completed' } } }), false);
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
