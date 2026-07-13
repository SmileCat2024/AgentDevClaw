/**
 * Tests for the dispatch engine (fire logic + boot recovery).
 *
 * These functions currently live in server/routes/dispatch.js and will be
 * extracted to server/routes/dispatch-engine.js.
 *
 * Focus areas:
 * 1. fireSingleTarget — new session creation, existing session restart, __latest__ resolution, onlyActiveSessions guard
 * 2. fireDispatchNow — send_message status transitions, envelope creation, watchdog timer, start_agent path
 * 3. restoreDispatchSchedulesOnBoot — fired timeout, fired recovery, timer restore, expired timer fire, on-boot counting
 * 4. fireBootSchedules — on-boot fire, skip non-on-boot, skip completed
 *
 * Uses node:test format per project convention.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

import {
  fireSingleTarget,
  fireDispatchNow,
  restoreDispatchSchedulesOnBoot,
  fireBootSchedules,
} from '../server/routes/dispatch-engine.js';

import {
  resetDispatchState,
  setSchedulesPath,
  setDispatchCtx,
  getDispatchState,
  registerProjectAdapter,
} from '../server/routes/dispatch.js';

import { resetAllInboxes } from '../server/runtime-call-envelope.js';

// ── Test helpers (mirrors dispatch-routes.test.js helpers) ─────────

function makeMockCtx(overrides = {}) {
  const calls = {};
  const ctx = {
    readWorkspaceState: async (agentId) => {
      calls.readWorkspaceState = calls.readWorkspaceState || [];
      calls.readWorkspaceState.push(agentId);
      return overrides.readWorkspaceState?.(agentId) ?? { openDirectory: null };
    },
    writeWorkspaceState: async () => {},
    readProjectIMWorkspaceConfig: async () => {
      calls.readProjectIMWorkspaceConfig = (calls.readProjectIMWorkspaceConfig || 0) + 1;
      return overrides.readProjectIMWorkspaceConfig?.() ?? { selectedChannel: null };
    },
    listPrebuiltSessions: async (agentId) => {
      calls.listPrebuiltSessions = calls.listPrebuiltSessions || [];
      calls.listPrebuiltSessions.push(agentId);
      return overrides.listPrebuiltSessions?.(agentId) ?? { sessions: [] };
    },
    requirePrebuiltAgentForRuntime: async (agentId) => {
      calls.requirePrebuiltAgentForRuntime = calls.requirePrebuiltAgentForRuntime || [];
      calls.requirePrebuiltAgentForRuntime.push(agentId);
      return { id: agentId };
    },
    createPrebuiltSession: async (agentId, opts) => {
      calls.createPrebuiltSession = calls.createPrebuiltSession || [];
      calls.createPrebuiltSession.push({ agentId, opts });
      return { id: 'new-sess-1', sessionType: opts?.sessionType || 'main' };
    },
    startManagedAgent: async (agent, sessionId, opts) => {
      calls.startManagedAgent = calls.startManagedAgent || [];
      calls.startManagedAgent.push({ agent, sessionId, opts });
    },
    waitForManagedRuntimeReady: async () => true,
    activatePrebuiltSession: async (agentId, sessionId) => {
      calls.activatePrebuiltSession = calls.activatePrebuiltSession || [];
      calls.activatePrebuiltSession.push({ agentId, sessionId });
    },
  };
  ctx._calls = calls;
  return ctx;
}

function makePendingSchedule(overrides = {}) {
  return {
    id: `sched-engine-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    fireAt: new Date(Date.now() + 60000).toISOString(),
    targetAgentId: 'test-agent',
    targetSessionId: null,
    newSessionType: null,
    projectId: null,
    trigger: null,
    action: null,
    targets: null,
    repeatInterval: null,
    loopMaxCount: null,
    loopEndTime: null,
    loopFiredCount: 0,
    onlyActiveSessions: false,
    message: 'test message',
    status: 'pending',
    createdAt: new Date().toISOString(),
    firedAt: null,
    result: null,
    ...overrides,
  };
}

let _tmpDir = null;

function engineSetup(extraCtxOverrides = {}) {
  resetDispatchState();
  resetAllInboxes();
  _tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-engine-test-'));
  setSchedulesPath(join(_tmpDir, 'dispatch-schedules.json'));
  setDispatchCtx(makeMockCtx(extraCtxOverrides));
}

function engineTeardown() {
  resetDispatchState();
  resetAllInboxes();
  if (_tmpDir) {
    rmSync(_tmpDir, { recursive: true, force: true });
    _tmpDir = null;
  }
}

// ── fireSingleTarget ──────────────────────────────────────────────

describe('Dispatch engine — fireSingleTarget', () => {
  let ctx;

  beforeEach(() => {
    ctx = makeMockCtx();
    engineSetup();
    setDispatchCtx(ctx);
  });
  afterEach(() => engineTeardown());

  it('creates new session when sessionId is null and fires message', async () => {
    const s = makePendingSchedule({
      id: 'fst-engine-1',
      targetAgentId: 'ph',
      targetSessionId: null,
      message: 'create and fire',
    });

    await fireSingleTarget(s, { agentId: 'ph', sessionId: null });

    assert.ok(ctx._calls.createPrebuiltSession, 'should call createPrebuiltSession');
    assert.equal(ctx._calls.createPrebuiltSession[0].agentId, 'ph');
    assert.ok(s.awaitingResponseSince, 'should set awaitingResponseSince');
    assert.ok(s.envelopeId, 'should create envelope');
    // message should be queued
    const queues = Array.from(getDispatchState().dispatchQueue.values());
    assert.ok(queues.some(q => q.some(m => m.scheduleId === s.id)), 'message should be queued');
  });

  it('starts runtime when session exists but is not running', async () => {
    const s = makePendingSchedule({
      id: 'fst-engine-2',
      targetAgentId: 'ph',
      targetSessionId: 'existing-sess',
      message: 'restart me',
    });

    await fireSingleTarget(s, { agentId: 'ph', sessionId: 'existing-sess' });

    assert.ok(ctx._calls.requirePrebuiltAgentForRuntime?.includes('ph'));
    assert.ok(ctx._calls.activatePrebuiltSession?.some(c => c.sessionId === 'existing-sess'));
    assert.ok(ctx._calls.startManagedAgent, 'should call startManagedAgent');
  });

  it('skips when onlyActiveSessions and runtime is not active', async () => {
    const s = makePendingSchedule({
      id: 'fst-engine-3',
      targetAgentId: 'ph',
      targetSessionId: 'dead-sess',
      onlyActiveSessions: true,
      message: 'should be skipped',
    });

    await fireSingleTarget(s, { agentId: 'ph', sessionId: 'dead-sess' });

    assert.ok(!ctx._calls.createPrebuiltSession, 'should NOT create session');
    assert.ok(!s.envelopeId, 'should NOT create envelope');
    assert.ok(!s.awaitingResponseSince, 'should NOT set awaitingResponseSince');
  });

  it('resolves __latest__ to the most recent session', async () => {
    ctx = makeMockCtx({
      listPrebuiltSessions: async () => ({
        sessions: [
          { id: 'latest-sess', updatedAt: '2024-12-01' },
          { id: 'older-sess', updatedAt: '2024-01-01' },
        ],
      }),
    });
    setDispatchCtx(ctx);

    const s = makePendingSchedule({
      id: 'fst-engine-4',
      targetAgentId: 'ph',
      targetSessionId: '__latest__',
      message: 'go latest',
    });

    await fireSingleTarget(s, { agentId: 'ph', sessionId: '__latest__' });

    // listPrebuiltSessions should have been called
    assert.ok(ctx._calls.listPrebuiltSessions?.includes('ph'));
    // envelope should be created with resolved session
    assert.ok(s.envelopeId);
  });

  it('skips __latest__ when no sessions exist', async () => {
    ctx = makeMockCtx({
      listPrebuiltSessions: async () => ({ sessions: [] }),
    });
    setDispatchCtx(ctx);

    const s = makePendingSchedule({
      id: 'fst-engine-5',
      targetAgentId: 'ph',
      targetSessionId: '__latest__',
      message: 'no sessions',
    });

    await fireSingleTarget(s, { agentId: 'ph', sessionId: '__latest__' });

    assert.ok(!s.envelopeId, 'should NOT create envelope');
    assert.ok(!s.awaitingResponseSince, 'should NOT set awaitingResponseSince');
  });

  it('writes back resolved target to schedule when no targets array', async () => {
    const s = makePendingSchedule({
      id: 'fst-engine-6',
      targetAgentId: 'ph',
      targetSessionId: 'sess-writeback',
      message: 'writeback test',
    });

    await fireSingleTarget(s, { agentId: 'ph', sessionId: 'sess-writeback' });

    assert.equal(s.resolvedTargetSessionId, 'sess-writeback');
    assert.ok(s.resolvedRuntimeKey);
  });
});

// ── fireDispatchNow ───────────────────────────────────────────────

describe('Dispatch engine — fireDispatchNow', () => {
  let ctx;

  beforeEach(() => {
    ctx = makeMockCtx();
    engineSetup();
    setDispatchCtx(ctx);
  });
  afterEach(() => engineTeardown());

  it('skips non-pending schedule', async () => {
    const s = makePendingSchedule({
      id: 'fdn-engine-1',
      status: 'completed',
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    await fireDispatchNow(s);
    assert.equal(s.status, 'completed');
  });

  it('send_message: sets status fired, creates watchdog and envelope', async () => {
    const s = makePendingSchedule({
      id: 'fdn-engine-2',
      targetAgentId: 'ph',
      targetSessionId: 'sess-1',
      message: 'fire me',
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    await fireDispatchNow(s);

    assert.equal(s.status, 'fired');
    assert.ok(s.firedAt);
    assert.ok(s.awaitingResponseSince);
    // watchdog timer should exist
    assert.ok(getDispatchState().dispatchTimers.has(`__watchdog_${s.id}`));
  });

  it('start_agent: calls requirePrebuiltAgentForRuntime and marks completed for non-boot', async () => {
    ctx = makeMockCtx({
      readProjectIMWorkspaceConfig: async () => ({ selectedChannel: 'qq' }),
    });
    setDispatchCtx(ctx);

    const s = makePendingSchedule({
      id: 'fdn-engine-3',
      targetAgentId: 'ph',
      targetSessionId: 'sess-start',
      trigger: { type: 'timer' },
      action: { type: 'start_agent' },
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    await fireDispatchNow(s);

    assert.ok(ctx._calls.requirePrebuiltAgentForRuntime?.includes('ph'));
    assert.ok(ctx._calls.startManagedAgent?.some(c => c.agent?.id === 'ph'));
    assert.equal(s.status, 'completed');
  });

  it('start_agent with on-boot trigger stays pending', async () => {
    ctx = makeMockCtx({
      readProjectIMWorkspaceConfig: async () => ({ selectedChannel: 'qq' }),
    });
    setDispatchCtx(ctx);

    const s = makePendingSchedule({
      id: 'fdn-engine-4',
      targetAgentId: 'ph',
      trigger: { type: 'on-boot' },
      action: { type: 'start_agent' },
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    await fireDispatchNow(s);
    assert.equal(s.status, 'pending');
  });

  it('start_agent for qqbot skips when no IM channel selected', async () => {
    ctx = makeMockCtx({
      readProjectIMWorkspaceConfig: async () => ({ selectedChannel: null }),
    });
    setDispatchCtx(ctx);

    const s = makePendingSchedule({
      id: 'fdn-engine-5',
      targetAgentId: 'qqbot',
      trigger: { type: 'timer' },
      action: { type: 'start_agent' },
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    await fireDispatchNow(s);

    assert.ok(!ctx._calls.startManagedAgent, 'should NOT start agent');
    assert.equal(s.status, 'completed');
  });

  it('send_message with multi-target fires all targets', async () => {
    const s = makePendingSchedule({
      id: 'fdn-engine-6',
      message: 'multi fire',
      targets: [
        { agentId: 'agent-a', sessionId: 'sess-a' },
        { agentId: 'agent-b', sessionId: 'sess-b' },
      ],
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    await fireDispatchNow(s);

    assert.equal(s.status, 'fired');
    assert.ok(ctx._calls.requirePrebuiltAgentForRuntime?.includes('agent-a'));
    assert.ok(ctx._calls.requirePrebuiltAgentForRuntime?.includes('agent-b'));
  });
});

// ── restoreDispatchSchedulesOnBoot ────────────────────────────────

describe('Dispatch engine — restoreDispatchSchedulesOnBoot', () => {
  beforeEach(() => engineSetup());
  afterEach(() => engineTeardown());

  it('marks fired schedules as failed when timed out', () => {
    const s = makePendingSchedule({
      id: 'restore-engine-1',
      status: 'fired',
      firedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      awaitingResponseSince: Date.now() - 10 * 60 * 1000,
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    restoreDispatchSchedulesOnBoot();

    assert.equal(s.status, 'failed');
    assert.ok(s.result);
    assert.ok(s.completedAt);
  });

  it('keeps recently fired schedules and installs watchdog', () => {
    const s = makePendingSchedule({
      id: 'restore-engine-2',
      status: 'fired',
      firedAt: new Date().toISOString(),
      awaitingResponseSince: Date.now(),
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    restoreDispatchSchedulesOnBoot();

    assert.equal(s.status, 'fired');
    assert.ok(getDispatchState().dispatchTimers.has(`__watchdog_${s.id}`), 'should install watchdog');
  });

  it('restores future timer schedules', () => {
    const s = makePendingSchedule({
      id: 'restore-engine-3',
      trigger: { type: 'timer' },
      fireAt: new Date(Date.now() + 3600000).toISOString(),
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    restoreDispatchSchedulesOnBoot();

    assert.ok(getDispatchState().dispatchTimers.has('restore-engine-3'));
  });

  it('fires expired timer schedules immediately', async () => {
    const s = makePendingSchedule({
      id: 'restore-engine-4',
      trigger: { type: 'timer' },
      fireAt: new Date(Date.now() - 60000).toISOString(),
      targetAgentId: 'ph',
      targetSessionId: 'sess-1',
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    restoreDispatchSchedulesOnBoot();
    // fireDispatchNow is async — let it settle before teardown deletes temp dir
    await new Promise(r => setTimeout(r, 50));

    assert.notEqual(s.status, 'pending');
  });

  it('counts on-boot schedules without firing them', () => {
    const s = makePendingSchedule({
      id: 'restore-engine-5',
      trigger: { type: 'on-boot' },
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    restoreDispatchSchedulesOnBoot();

    assert.equal(s.status, 'pending');
  });

  it('handles empty schedule set without error', () => {
    // should not throw
    restoreDispatchSchedulesOnBoot();
    assert.ok(true);
  });

  it('marks failed schedule with envelope status update', () => {
    const s = makePendingSchedule({
      id: 'restore-engine-6',
      status: 'fired',
      firedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      awaitingResponseSince: Date.now() - 20 * 60 * 1000,
      envelopeId: 'env-test-1',
      resolvedRuntimeKey: 'ph::sess-1',
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    restoreDispatchSchedulesOnBoot();

    assert.equal(s.status, 'failed');
    assert.ok(s.lastError);
  });
});

// ── fireBootSchedules ─────────────────────────────────────────────

describe('Dispatch engine — fireBootSchedules', () => {
  let ctx;

  beforeEach(() => {
    ctx = makeMockCtx();
    engineSetup();
    setDispatchCtx(ctx);
  });
  afterEach(() => engineTeardown());

  it('fires pending on-boot schedules', async () => {
    const s = makePendingSchedule({
      id: 'boot-engine-1',
      targetAgentId: 'ph',
      targetSessionId: 'sess-1',
      trigger: { type: 'on-boot' },
      action: { type: 'start_agent' },
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    await fireBootSchedules();

    // on-boot start_agent stays pending but triggers agent start
    assert.equal(s.status, 'pending');
    assert.ok(ctx._calls.startManagedAgent?.some(c => c.agent?.id === 'ph'));
  });

  it('does not fire non-on-boot schedules', async () => {
    const s = makePendingSchedule({
      id: 'boot-engine-2',
      trigger: { type: 'timer' },
      fireAt: new Date(Date.now() + 3600000).toISOString(),
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    await fireBootSchedules();

    assert.equal(s.status, 'pending');
  });

  it('does not fire already-completed on-boot schedules', async () => {
    const s = makePendingSchedule({
      id: 'boot-engine-3',
      status: 'completed',
      trigger: { type: 'on-boot' },
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    await fireBootSchedules();

    assert.equal(s.status, 'completed');
  });

  it('handles empty schedule set', async () => {
    await fireBootSchedules();
    assert.ok(true);
  });
});
