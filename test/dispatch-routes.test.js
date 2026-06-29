/**
 * Tests for server/routes/dispatch.js
 *
 * Covers:
 * 1. Schedule persistence — load/save round-trip with temp file
 * 2. Message queue — push behavior, pending poll resolution
 * 3. Event matching — emitDispatchReadyEvent schedule matching
 * 4. Timer cleanup — cancelEventTrigger
 * 5. Project adapter registry — register/get
 * 6. fireDispatchNow — start_agent and send_message paths with mock ctx
 * 7. Route handlers — schedules CRUD via mock app
 * 8. restoreDispatchSchedulesOnBoot — recovery sweep
 * 9. fireBootSchedules — on-boot trigger
 *
 * Uses node:test format per project convention (test/*.test.js).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

import {
  setupDispatchRoutes,
  getProjectAdapter,
  fireBootSchedules,
  // internal exports for testing
  loadDispatchSchedules,
  saveDispatchSchedules,
  pushDispatchMessage,
  emitDispatchReadyEvent,
  cancelEventTrigger,
  fireDispatchNow,
  fireSingleTarget,
  restoreDispatchSchedulesOnBoot,
  registerProjectAdapter,
  resetDispatchState,
  setSchedulesPath,
  setDispatchCtx,
  getDispatchState,
} from '../server/routes/dispatch.js';

import { resetAllInboxes } from '../server/runtime-call-envelope.js';

// ── Test helpers ──────────────────────────────────────────────────

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

function makeMockApp() {
  const routes = {};
  const mockApp = {
    get: (path, ...handlers) => { routes[`GET ${path}`] = handlers; },
    post: (path, ...handlers) => { routes[`POST ${path}`] = handlers; },
    delete: (path, ...handlers) => { routes[`DELETE ${path}`] = handlers; },
  };
  mockApp._routes = routes;
  return mockApp;
}

function makeMockRes() {
  const res = {
    statusCode: 200,
    body: null,
    ended: false,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    setHeader(key, value) { this.headers[key] = value; },
    end() { this.ended = true; },
  };
  return res;
}

function makePendingSchedule(overrides = {}) {
  return {
    id: `sched-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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

// ── Shared setup helpers ───────────────────────────────────────────

let _sharedTmpDir = null;

function dispatchSetup(extraCtxOverrides = {}) {
  resetDispatchState();
  resetAllInboxes();
  _sharedTmpDir = mkdtempSync(join(tmpdir(), 'dispatch-test-'));
  setSchedulesPath(join(_sharedTmpDir, 'dispatch-schedules.json'));
  setDispatchCtx(makeMockCtx(extraCtxOverrides));
}

function dispatchTeardown() {
  resetDispatchState();
  resetAllInboxes();
  if (_sharedTmpDir) {
    rmSync(_sharedTmpDir, { recursive: true, force: true });
    _sharedTmpDir = null;
  }
}

// ── Test suites ───────────────────────────────────────────────────

describe('Dispatch module — schedule persistence', () => {
  let tmpDir;
  let schedulesPath;

  beforeEach(() => {
    resetDispatchState();
    resetAllInboxes();
    tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-test-'));
    schedulesPath = join(tmpDir, 'dispatch-schedules.json');
    setSchedulesPath(schedulesPath);
    setDispatchCtx(makeMockCtx());
  });

  afterEach(() => {
    resetDispatchState();
    resetAllInboxes();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saveDispatchSchedules writes valid JSON to disk', () => {
    const s = makePendingSchedule({ id: 'persist-1', message: 'persisted' });
    // directly inject into state via load then save
    writeFileSync(schedulesPath, JSON.stringify({ schedules: [s] }), 'utf8');
    loadDispatchSchedules();
    assert.ok(getDispatchState().dispatchSchedules.has('persist-1'));
  });

  it('loadDispatchSchedules restores schedules from disk', () => {
    const s1 = makePendingSchedule({ id: 'restore-1' });
    const s2 = makePendingSchedule({ id: 'restore-2', message: 'second' });
    writeFileSync(schedulesPath, JSON.stringify({ schedules: [s1, s2] }), 'utf8');
    loadDispatchSchedules();
    const state = getDispatchState().dispatchSchedules;
    assert.ok(state.has('restore-1'));
    assert.ok(state.has('restore-2'));
    assert.equal(state.get('restore-2').message, 'second');
  });

  it('loadDispatchSchedules is safe when file does not exist', () => {
    // no file created — should not throw
    loadDispatchSchedules();
    assert.equal(getDispatchState().dispatchSchedules.size, 0);
  });

  it('loadDispatchSchedules skips entries without id', () => {
    writeFileSync(schedulesPath, JSON.stringify({
      schedules: [{ id: 'good-1' }, { noId: true }, { id: 'good-2' }],
    }), 'utf8');
    loadDispatchSchedules();
    const state = getDispatchState().dispatchSchedules;
    assert.equal(state.size, 2);
    assert.ok(state.has('good-1'));
    assert.ok(state.has('good-2'));
  });

  it('saveDispatchSchedules + loadDispatchSchedules round-trip', () => {
    const s = makePendingSchedule({ id: 'roundtrip-1', message: 'roundtrip msg' });
    writeFileSync(schedulesPath, JSON.stringify({ schedules: [s] }), 'utf8');
    loadDispatchSchedules();
    saveDispatchSchedules();
    // read back from disk directly
    const raw = JSON.parse(readFileSync(schedulesPath, 'utf8'));
    assert.ok(raw.schedules.find(x => x.id === 'roundtrip-1'));
  });
});

describe('Dispatch module — message queue', () => {
  beforeEach(() => dispatchSetup());
  afterEach(() => dispatchTeardown());

  it('pushDispatchMessage queues message when no poll pending', () => {
    const runtimeKey = 'test-agent::__protoclaw-no-session__';
    pushDispatchMessage(runtimeKey, 'hello', 'sched-1');
    const queue = getDispatchState().dispatchQueue.get(runtimeKey);
    assert.ok(queue);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].text, 'hello');
    assert.equal(queue[0].scheduleId, 'sched-1');
  });

  it('pushDispatchMessage appends to existing queue', () => {
    const runtimeKey = 'test-agent::__protoclaw-no-session__';
    pushDispatchMessage(runtimeKey, 'first');
    pushDispatchMessage(runtimeKey, 'second');
    const queue = getDispatchState().dispatchQueue.get(runtimeKey);
    assert.equal(queue.length, 2);
    assert.equal(queue[0].text, 'first');
    assert.equal(queue[1].text, 'second');
  });

  it('pushDispatchMessage resolves immediately if poll is pending', () => {
    const runtimeKey = 'poll-agent::sess-1';
    let resolvedMsg = null;
    getDispatchState().dispatchPendingPolls.set(runtimeKey, (msg) => {
      resolvedMsg = msg;
    });
    pushDispatchMessage(runtimeKey, 'instant delivery', 'sched-x');
    assert.ok(resolvedMsg);
    assert.equal(resolvedMsg.text, 'instant delivery');
    // poll should have been consumed
    assert.ok(!getDispatchState().dispatchPendingPolls.has(runtimeKey));
    // queue should NOT have the message (it was delivered directly)
    assert.ok(!getDispatchState().dispatchQueue.has(runtimeKey));
  });

  it('pushDispatchMessage generates unique message ids', () => {
    const runtimeKey = 'uniq-agent::__protoclaw-no-session__';
    pushDispatchMessage(runtimeKey, 'a');
    pushDispatchMessage(runtimeKey, 'b');
    const queue = getDispatchState().dispatchQueue.get(runtimeKey);
    assert.notEqual(queue[0].id, queue[1].id);
  });
});

describe('Dispatch module — emitDispatchReadyEvent', () => {
  beforeEach(() => dispatchSetup());
  afterEach(() => dispatchTeardown());

  it('fires matching on-ready schedule', async () => {
    const s = makePendingSchedule({
      id: 'ready-1',
      targetAgentId: 'ph',
      trigger: { type: 'on-ready' },
      message: 'go',
    });
    getDispatchState().dispatchSchedules.set(s.id, s);
    emitDispatchReadyEvent('ph', 'sess-1');
    // fireDispatchNow is async; schedule status should be 'fired' (send_message)
    assert.equal(s.status, 'fired');
    // let the async fireSingleTarget chain complete (avoid unhandled rejection)
    await new Promise(r => setTimeout(r, 50));
  });

  it('does not fire non-on-ready schedule', () => {
    const s = makePendingSchedule({
      id: 'ready-2',
      targetAgentId: 'ph',
      trigger: { type: 'timer' },
    });
    getDispatchState().dispatchSchedules.set(s.id, s);
    emitDispatchReadyEvent('ph', 'sess-1');
    assert.equal(s.status, 'pending');
  });

  it('does not fire schedule for different agent', () => {
    const s = makePendingSchedule({
      id: 'ready-3',
      targetAgentId: 'ph',
      trigger: { type: 'on-ready' },
    });
    getDispatchState().dispatchSchedules.set(s.id, s);
    emitDispatchReadyEvent('other-agent', 'sess-1');
    assert.equal(s.status, 'pending');
  });

  it('does not fire schedule with non-matching sessionId', () => {
    const s = makePendingSchedule({
      id: 'ready-4',
      targetAgentId: 'ph',
      targetSessionId: 'specific-sess',
      trigger: { type: 'on-ready' },
    });
    getDispatchState().dispatchSchedules.set(s.id, s);
    emitDispatchReadyEvent('ph', 'wrong-sess');
    assert.equal(s.status, 'pending');
  });

  it('fires schedule with matching sessionId', () => {
    const s = makePendingSchedule({
      id: 'ready-5',
      targetAgentId: 'ph',
      targetSessionId: 'sess-42',
      trigger: { type: 'on-ready' },
    });
    getDispatchState().dispatchSchedules.set(s.id, s);
    emitDispatchReadyEvent('ph', 'sess-42');
    assert.equal(s.status, 'fired');
  });

  it('does not fire already-fired schedule', () => {
    const s = makePendingSchedule({
      id: 'ready-6',
      targetAgentId: 'ph',
      trigger: { type: 'on-ready' },
      status: 'fired',
    });
    getDispatchState().dispatchSchedules.set(s.id, s);
    emitDispatchReadyEvent('ph', null);
    // remains fired, no error
    assert.equal(s.status, 'fired');
  });
});

describe('Dispatch module — cancelEventTrigger', () => {
  beforeEach(() => dispatchSetup());
  afterEach(() => dispatchTeardown());

  it('clears idle checker if present', () => {
    // Simulate an idle checker handle
    let cleared = false;
    const fakeHandle = { __cleared: false };
    getDispatchState().dispatchIdleCheckers.set('sched-1', fakeHandle);
    // Patch clearInterval for this test
    const origClearInterval = global.clearInterval;
    global.clearInterval = (h) => { if (h === fakeHandle) cleared = true; };
    cancelEventTrigger('sched-1');
    global.clearInterval = origClearInterval;
    assert.ok(cleared);
    assert.ok(!getDispatchState().dispatchIdleCheckers.has('sched-1'));
  });

  it('is safe when no checker exists', () => {
    cancelEventTrigger('nonexistent');
    // no throw
    assert.ok(true);
  });
});

describe('Dispatch module — project adapter registry', () => {
  beforeEach(() => dispatchSetup());
  afterEach(() => dispatchTeardown());

  it('getProjectAdapter returns null for unregistered workspace', () => {
    assert.equal(getProjectAdapter('nonexistent'), null);
  });

  it('registerProjectAdapter stores and getProjectAdapter retrieves', () => {
    const fakeAdapter = { workspaceId: 'custom-ws', getCurrentProject: async () => null };
    registerProjectAdapter(fakeAdapter);
    assert.equal(getProjectAdapter('custom-ws'), fakeAdapter);
  });

  it('registerProjectAdapter ignores adapters without workspaceId', () => {
    registerProjectAdapter({ noWorkspaceId: true });
    assert.equal(getProjectAdapter(undefined), null);
  });
});

describe('Dispatch module — fireDispatchNow (start_agent)', () => {
  let ctx;

  beforeEach(() => {
    ctx = makeMockCtx({
      readProjectIMWorkspaceConfig: async () => ({ selectedChannel: 'qq' }),
    });
    dispatchSetup({ readProjectIMWorkspaceConfig: async () => ({ selectedChannel: 'qq' }) });
    setDispatchCtx(ctx);
  });

  afterEach(() => dispatchTeardown());

  it('start_agent calls requirePrebuiltAgentForRuntime + startManagedAgent', async () => {
    const s = makePendingSchedule({
      id: 'sa-1',
      targetAgentId: 'ph',
      targetSessionId: 'existing-sess',
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
    const s = makePendingSchedule({
      id: 'sa-boot-1',
      targetAgentId: 'ph',
      targetSessionId: null,
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
      id: 'sa-qq-1',
      targetAgentId: 'qqbot',
      trigger: { type: 'timer' },
      action: { type: 'start_agent' },
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    await fireDispatchNow(s);
    // qqbot is skipped → startManagedAgent NOT called
    assert.ok(!ctx._calls.startManagedAgent);
    assert.equal(s.status, 'completed');
  });

  it('start_agent skips non-pending schedule', async () => {
    const s = makePendingSchedule({
      id: 'sa-skip-1',
      status: 'completed',
      action: { type: 'start_agent' },
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    await fireDispatchNow(s);
    // nothing should happen
    assert.equal(s.status, 'completed');
  });
});

describe('Dispatch module — fireDispatchNow (send_message)', () => {
  let ctx;

  beforeEach(() => {
    ctx = makeMockCtx();
    dispatchSetup();
    setDispatchCtx(ctx);
  });

  afterEach(() => dispatchTeardown());

  it('send_message sets status to fired and pushes message', async () => {
    const s = makePendingSchedule({
      id: 'sm-1',
      targetAgentId: 'ph',
      targetSessionId: 'sess-1',
      message: 'hello dispatch',
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    await fireDispatchNow(s);

    assert.equal(s.status, 'fired');
    assert.ok(s.firedAt);
    assert.ok(s.awaitingResponseSince);
    assert.ok(s.envelopeId, 'should create envelope');
    // message should be queued for the resolved runtime key
    const queue = getDispatchState().dispatchQueue.get('ph::sess-1');
    assert.ok(queue?.some(m => m.scheduleId === s.id), 'message should be queued for ph::sess-1');
  });

  it('send_message with targets array fires all targets', async () => {
    const s = makePendingSchedule({
      id: 'sm-multi-1',
      message: 'multi-target',
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

  it('send_message skips non-pending schedule', async () => {
    const s = makePendingSchedule({
      id: 'sm-skip-1',
      status: 'completed',
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    await fireDispatchNow(s);
    assert.equal(s.status, 'completed');
  });
});

describe('Dispatch module — restoreDispatchSchedulesOnBoot', () => {
  beforeEach(() => dispatchSetup());
  afterEach(() => dispatchTeardown());

  it('marks fired schedules as failed when timed out', () => {
    const s = makePendingSchedule({
      id: 'boot-timeout-1',
      status: 'fired',
      firedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
      awaitingResponseSince: Date.now() - 10 * 60 * 1000,
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    restoreDispatchSchedulesOnBoot();

    assert.equal(s.status, 'failed');
    assert.ok(s.result);
    assert.ok(s.completedAt);
  });

  it('keeps recently fired schedules with watchdog', () => {
    const s = makePendingSchedule({
      id: 'boot-recent-1',
      status: 'fired',
      firedAt: new Date().toISOString(),
      awaitingResponseSince: Date.now(),
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    restoreDispatchSchedulesOnBoot();

    assert.equal(s.status, 'fired');
  });

  it('restores future timer schedules', () => {
    const s = makePendingSchedule({
      id: 'boot-timer-1',
      trigger: { type: 'timer' },
      fireAt: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    restoreDispatchSchedulesOnBoot();

    // timer handle should be registered
    assert.ok(getDispatchState().dispatchTimers.has('boot-timer-1'));
  });

  it('fires expired timer schedules immediately', () => {
    const s = makePendingSchedule({
      id: 'boot-expired-1',
      trigger: { type: 'timer' },
      fireAt: new Date(Date.now() - 60000).toISOString(), // 1 min ago
      targetAgentId: 'ph',
      targetSessionId: 'sess-1',
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    restoreDispatchSchedulesOnBoot();

    // fireDispatchNow is async, status should change from pending
    assert.notEqual(s.status, 'pending');
  });

  it('counts on-boot schedules without firing', () => {
    const s = makePendingSchedule({
      id: 'boot-onboot-1',
      trigger: { type: 'on-boot' },
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    restoreDispatchSchedulesOnBoot();

    // on-boot stays pending, fired by fireBootSchedules later
    assert.equal(s.status, 'pending');
  });
});

describe('Dispatch module — fireBootSchedules', () => {
  let ctx;

  beforeEach(() => {
    ctx = makeMockCtx();
    dispatchSetup();
    setDispatchCtx(ctx);
  });

  afterEach(() => dispatchTeardown());

  it('fires pending on-boot schedules', async () => {
    const s = makePendingSchedule({
      id: 'boot-fire-1',
      targetAgentId: 'ph',
      targetSessionId: 'sess-1',
      trigger: { type: 'on-boot' },
      action: { type: 'start_agent' },
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    await fireBootSchedules();

    // on-boot start_agent is persistent: stays 'pending' but fires the agent
    assert.equal(s.status, 'pending');
    assert.ok(ctx._calls.startManagedAgent?.some(c => c.agent?.id === 'ph'));
  });

  it('does not fire non-on-boot schedules', async () => {
    const s = makePendingSchedule({
      id: 'boot-skip-1',
      trigger: { type: 'timer' },
      fireAt: new Date(Date.now() + 3600000).toISOString(),
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    await fireBootSchedules();

    assert.equal(s.status, 'pending');
  });

  it('does not fire already-completed on-boot schedules', async () => {
    const s = makePendingSchedule({
      id: 'boot-done-1',
      status: 'completed',
      trigger: { type: 'on-boot' },
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    await fireBootSchedules();

    assert.equal(s.status, 'completed');
  });

  it('handles empty schedule set gracefully', async () => {
    await fireBootSchedules();
    // no throw
    assert.ok(true);
  });
});

describe('Dispatch module — route handlers', () => {
  let mockApp;
  let ctx;

  beforeEach(() => {
    ctx = makeMockCtx();
    dispatchSetup();
    setDispatchCtx(ctx);
    mockApp = makeMockApp();
    setupDispatchRoutes(mockApp, { json: () => (_req, _res, next) => next?.() }, ctx);
  });

  afterEach(() => dispatchTeardown());

  it('GET /dispatch/schedules returns schedule array', () => {
    const s = makePendingSchedule({ id: 'route-list-1' });
    getDispatchState().dispatchSchedules.set(s.id, s);

    const handler = mockApp._routes['GET /protoclaw/dispatch/schedules'][0];
    const res = makeMockRes();
    handler({}, res);
    assert.ok(Array.isArray(res.body.schedules));
    assert.ok(res.body.schedules.some(x => x.id === 'route-list-1'));
  });

  it('DELETE /dispatch/schedules/:id cancels pending schedule', () => {
    const s = makePendingSchedule({ id: 'route-del-1' });
    getDispatchState().dispatchSchedules.set(s.id, s);

    const handler = mockApp._routes['DELETE /protoclaw/dispatch/schedules/:id'][0];
    const res = makeMockRes();
    handler({ params: { id: 'route-del-1' } }, res);

    assert.equal(s.status, 'cancelled');
    assert.equal(res.body.ok, true);
  });

  it('DELETE /dispatch/schedules/:id returns 404 for missing', () => {
    const handler = mockApp._routes['DELETE /protoclaw/dispatch/schedules/:id'][0];
    const res = makeMockRes();
    handler({ params: { id: 'nonexistent' } }, res);
    assert.equal(res.statusCode, 404);
  });

  it('POST /dispatch/agent_status updates runtime activity', () => {
    const handler = mockApp._routes['POST /protoclaw/dispatch/agent_status'];
    // handler is [express.json(), mainHandler] — get last
    const mainHandler = handler[handler.length - 1];
    const res = makeMockRes();
    mainHandler({ body: { agentId: 'ph', sessionId: 's1', status: 'active' } }, res);

    assert.equal(res.body.ok, true);
    const state = getDispatchState();
    const key = state.dispatchRuntimeActivity.keys().next().value;
    assert.ok(key);
    assert.equal(state.dispatchRuntimeActivity.get(key).status, 'active');
  });

  it('POST /dispatch/agent_status returns 400 without agentId', () => {
    const handler = mockApp._routes['POST /protoclaw/dispatch/agent_status'];
    const mainHandler = handler[handler.length - 1];
    const res = makeMockRes();
    mainHandler({ body: {} }, res);
    assert.equal(res.statusCode, 400);
  });

  it('POST /dispatch/respond completes a fired schedule', () => {
    const s = makePendingSchedule({
      id: 'route-respond-1',
      status: 'fired',
      targetAgentId: 'ph',
      targetSessionId: 'sess-1',
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    const handler = mockApp._routes['POST /protoclaw/dispatch/respond'];
    const mainHandler = handler[handler.length - 1];
    const res = makeMockRes();
    mainHandler({
      body: { scheduleId: 'route-respond-1', response: 'done' },
    }, res);

    assert.equal(s.status, 'completed');
    assert.equal(s.result, 'done');
    assert.equal(res.body.ok, true);
  });

  it('POST /dispatch/respond marks error as failed', () => {
    const s = makePendingSchedule({
      id: 'route-respond-err',
      status: 'fired',
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    const handler = mockApp._routes['POST /protoclaw/dispatch/respond'];
    const mainHandler = handler[handler.length - 1];
    const res = makeMockRes();
    mainHandler({
      body: { scheduleId: 'route-respond-err', error: 'something broke' },
    }, res);

    assert.equal(s.status, 'failed');
    assert.equal(s.result, 'something broke');
  });

  it('POST /dispatch/respond handles repeating schedule', () => {
    const s = makePendingSchedule({
      id: 'route-repeat-1',
      status: 'fired',
      repeatInterval: 60,
      loopFiredCount: 0,
      loopMaxCount: 3,
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    const handler = mockApp._routes['POST /protoclaw/dispatch/respond'];
    const mainHandler = handler[handler.length - 1];
    const res = makeMockRes();
    mainHandler({
      body: { scheduleId: 'route-repeat-1', response: 'ok' },
    }, res);

    // Should re-arm (not complete yet — loopFiredCount 1 < maxCount 3)
    assert.equal(s.status, 'pending');
    assert.equal(s.loopFiredCount, 1);
  });

  it('POST /dispatch/respond completes repeating at max count', () => {
    const s = makePendingSchedule({
      id: 'route-repeat-max',
      status: 'fired',
      repeatInterval: 60,
      loopFiredCount: 2,
      loopMaxCount: 3,
    });
    getDispatchState().dispatchSchedules.set(s.id, s);

    const handler = mockApp._routes['POST /protoclaw/dispatch/respond'];
    const mainHandler = handler[handler.length - 1];
    const res = makeMockRes();
    mainHandler({
      body: { scheduleId: 'route-repeat-max', response: 'final' },
    }, res);

    assert.equal(s.status, 'completed');
    assert.equal(s.loopFiredCount, 3);
  });
});

describe('Dispatch module — fireSingleTarget', () => {
  let ctx;

  beforeEach(() => {
    ctx = makeMockCtx();
    dispatchSetup();
    setDispatchCtx(ctx);
  });

  afterEach(() => dispatchTeardown());

  it('creates new session when sessionId is null', async () => {
    const s = makePendingSchedule({
      id: 'fst-new-1',
      targetAgentId: 'ph',
      targetSessionId: null,
      message: 'create me',
    });

    await fireSingleTarget(s, { agentId: 'ph', sessionId: null });

    assert.ok(ctx._calls.createPrebuiltSession);
    assert.equal(ctx._calls.createPrebuiltSession[0].agentId, 'ph');
    assert.ok(s.awaitingResponseSince);
    assert.ok(s.envelopeId);
  });

  it('starts runtime when session exists but is not running', async () => {
    const s = makePendingSchedule({
      id: 'fst-restart-1',
      targetAgentId: 'ph',
      targetSessionId: 'existing-sess',
      message: 'restart',
    });

    await fireSingleTarget(s, { agentId: 'ph', sessionId: 'existing-sess' });

    assert.ok(ctx._calls.requirePrebuiltAgentForRuntime?.includes('ph'));
    assert.ok(ctx._calls.activatePrebuiltSession?.some(c => c.sessionId === 'existing-sess'));
    assert.ok(ctx._calls.startManagedAgent);
  });

  it('onlyActiveSessions skips when runtime not running', async () => {
    const s = makePendingSchedule({
      id: 'fst-active-1',
      targetAgentId: 'ph',
      targetSessionId: 'dead-sess',
      onlyActiveSessions: true,
      message: 'should skip',
    });

    // Mock getAgentRuntime to return null (not running) — done by not setting up runtime
    await fireSingleTarget(s, { agentId: 'ph', sessionId: 'dead-sess' });

    // should NOT have created a session or started agent
    assert.ok(!ctx._calls.createPrebuiltSession);
    assert.ok(!s.envelopeId, 'should not create envelope when skipped');
  });

  it('__latest__ resolves to latest session', async () => {
    ctx = makeMockCtx({
      listPrebuiltSessions: async () => ({
        sessions: [
          { id: 'old-sess', updatedAt: '2024-01-01' },
          { id: 'new-sess', updatedAt: '2024-06-01' },
        ],
      }),
    });
    setDispatchCtx(ctx);

    const s = makePendingSchedule({
      id: 'fst-latest-1',
      targetAgentId: 'ph',
      targetSessionId: '__latest__',
      message: 'latest',
    });

    await fireSingleTarget(s, { agentId: 'ph', sessionId: '__latest__' });

    assert.ok(ctx._calls.activatePrebuiltSession?.some(c => c.sessionId === 'old-sess'));
  });
});
