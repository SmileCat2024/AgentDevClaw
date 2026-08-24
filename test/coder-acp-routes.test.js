/**
 * Tests for server/routes/acp.js + thread-routes events additive fields (ticket 018)
 *
 * Covers:
 * 1. POST /protoclaw/acp/coder/sessions
 *    - agentId guard: the external contract still only accepts "coder"; the internal
 *      implementation now targets programming-helper sessions with sessionType=coder
 *    - cwd validation: non-absolute / nonexistent / file → 400, zero side effects
 *    - happy path returns { clawSessionId, threadId, viewerAgentId, cwd }
 *    - CLAW_ACP_READY_TIMEOUT_MS is honoured
 *    - rollback ladder on three injection points (READY timeout / runtime start
 *      failure / thread missing): full ladder executes, no orphan objects
 *    - rollback failures are not masked: step statuses + leftover IDs reported
 * 2. POST /protoclaw/acp/coder/sessions/:clawSessionId/interrupt
 *    - resolves the session's exact runtime viewerAgentId (never other sessions)
 *    - 404 when no running runtime is bound to the session
 *    - 502 on viewer unreachable / viewer non-ok
 * 3. GET /protoclaw/threads/:threadId/events
 *    - per-event additive eventId / receivedAt coexist with legacy fields
 *
 * Uses node:test per project convention; no real model, no real server process.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

import {
  setupAcpRoutes,
  validateAcpCwd,
  resolveSessionViewerAgentId,
  resolveAcpReadyTimeoutMs,
  ACP_READY_TIMEOUT_DEFAULT_MS,
} from '../server/routes/acp.js';
import { setupThreadRoutes } from '../server/thread-control/thread-routes.js';
import { managedAgents } from '../server/shared/agent-access.js';
import { VIEWER_ORIGIN } from '../server/shared/constants.js';

// ── Test helpers (mock app / express / req / res, per dispatch-routes pattern) ──

function makeMockApp() {
  const routes = {};
  const mockApp = {
    get: (path, ...handlers) => { routes[`GET ${path}`] = handlers; },
    post: (path, ...handlers) => { routes[`POST ${path}`] = handlers; },
    put: (path, ...handlers) => { routes[`PUT ${path}`] = handlers; },
    delete: (path, ...handlers) => { routes[`DELETE ${path}`] = handlers; },
  };
  mockApp._routes = routes;
  return mockApp;
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

function makeMockCtx(overrides = {}) {
  const calls = {};
  const record = (name, value) => {
    calls[name] = calls[name] || [];
    calls[name].push(value);
    return value;
  };
  const ctx = {
    requireAgentLight: async (agentId) => {
      if (agentId !== 'programming-helper') {
        const error = new Error(`Unknown agent: ${agentId}`);
        error.statusCode = 404;
        throw error;
      }
      return { id: 'programming-helper' };
    },
    createPrebuiltSession: async (agentId, opts) => {
      record('createPrebuiltSession', { agentId, opts });
      if (overrides.createPrebuiltSession) return overrides.createPrebuiltSession(agentId, opts);
      return { id: 'sess-acp-1', sessionType: opts?.sessionType, openDirectory: opts?.openDirectory };
    },
    deletePrebuiltSession: async (agentId, sessionId, opts) => {
      record('deletePrebuiltSession', { agentId, sessionId, opts });
      if (overrides.deletePrebuiltSessionThrow) throw new Error(overrides.deletePrebuiltSessionThrow);
      return { deletedSessionId: sessionId };
    },
    startManagedAgent: async (agent, sessionId) => {
      record('startManagedAgent', { agentId: agent?.id, sessionId });
      if (overrides.startManagedAgentThrow) throw new Error(overrides.startManagedAgentThrow);
      return { status: 'running' };
    },
    stopManagedAgent: async (agentId, sessionId) => {
      record('stopManagedAgent', { agentId, sessionId });
      if (overrides.stopManagedAgentThrow) throw new Error(overrides.stopManagedAgentThrow);
      return { status: 'stopped' };
    },
    waitForManagedRuntimeReady: async (agentId, timeoutMs, sessionId) => {
      record('waitForManagedRuntimeReady', { agentId, timeoutMs, sessionId });
      if ('readyResult' in overrides) return overrides.readyResult;
      return { id: 'viewer-acp-1' };
    },
    threadIntegration: {
      onSessionCreated: async (agentId, session) => {
        record('onSessionCreated', { agentId, sessionId: session?.id });
        if ('onSessionCreatedResult' in overrides) return overrides.onSessionCreatedResult;
        return { threadId: 'thread-acp-1', headSessionId: session?.id };
      },
    },
    threadControl: {
      core: {
        findThreadByHeadSession: async (agentId, sessionId) => {
          record('findThreadByHeadSession', { agentId, sessionId });
          if ('findThreadResult' in overrides) return overrides.findThreadResult;
          return { threadId: 'thread-acp-1', headSessionId: sessionId, status: 'open' };
        },
        closeThread: async (threadId, opts) => {
          record('closeThread', { threadId, opts });
          if (overrides.closeThreadThrow) throw new Error(overrides.closeThreadThrow);
          return { threadId, status: 'closed' };
        },
      },
    },
  };
  ctx._calls = calls;
  return ctx;
}

function setupAcpHarness(overrides = {}) {
  const ctx = makeMockCtx(overrides);
  const app = makeMockApp();
  setupAcpRoutes(app, makeMockExpress(), ctx);
  return { ctx, app };
}

async function callCreate(app, body) {
  const handlers = app._routes['POST /protoclaw/acp/coder/sessions'];
  const main = handlers[handlers.length - 1];
  const res = makeMockRes();
  await main({ body }, res);
  return res;
}

async function callInterrupt(app, clawSessionId) {
  const handlers = app._routes['POST /protoclaw/acp/coder/sessions/:clawSessionId/interrupt'];
  const main = handlers[handlers.length - 1];
  const res = makeMockRes();
  await main({ params: { clawSessionId }, body: {} }, res);
  return res;
}

function seedRuntime({ agentId = 'programming-helper', sessionId, viewerAgentId, running = true }) {
  const runtime = {
    key: `${agentId}::${sessionId}`,
    agentId,
    id: agentId,
    process: running
      ? { exitCode: null, signalCode: null, pid: 4242 }
      : { exitCode: 1, signalCode: null },
    stopped: !running,
    viewerAgentId,
    selectedSessionId: sessionId,
  };
  managedAgents.set(runtime.key, runtime);
  return runtime;
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(url, init);
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

const okViewerResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({ success: true }),
});

// ── Shared fixture: a real temp directory as valid cwd ──

let tmpDir = null;
function validCwd() {
  return tmpDir;
}

beforeEach(() => {
  managedAgents.clear();
  tmpDir = mkdtempSync(join(tmpdir(), 'coder-acp-routes-'));
});

afterEach(() => {
  managedAgents.clear();
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

// ── Route registration ────────────────────────────────────────────

describe('ACP routes — registration', () => {
  it('registers the create + interrupt endpoints', () => {
    const { app } = setupAcpHarness();
    assert.ok(app._routes['POST /protoclaw/acp/coder/sessions']);
    assert.ok(app._routes['POST /protoclaw/acp/coder/sessions/:clawSessionId/interrupt']);
  });
});

// ── agentId guard ─────────────────────────────────────────────────

describe('ACP create — agentId guard', () => {
  it('rejects non-coder agentId with zero side effects', async () => {
    const { ctx, app } = setupAcpHarness();
    const res = await callCreate(app, { agentId: 'programming-helper', cwd: validCwd() });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, 'agent_not_supported');
    assert.equal(ctx._calls.createPrebuiltSession, undefined);
    assert.equal(ctx._calls.startManagedAgent, undefined);
    assert.equal(ctx._calls.onSessionCreated, undefined);
    assert.equal(ctx._calls.stopManagedAgent, undefined);
    assert.equal(ctx._calls.closeThread, undefined);
    assert.equal(ctx._calls.deletePrebuiltSession, undefined);
  });

  it('rejects missing agentId', async () => {
    const { ctx, app } = setupAcpHarness();
    const res = await callCreate(app, { cwd: validCwd() });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'agent_not_supported');
    assert.equal(ctx._calls.createPrebuiltSession, undefined);
  });
});

// ── cwd validation ────────────────────────────────────────────────

describe('ACP create — cwd validation', () => {
  const invalidCases = [
    ['non-absolute path', () => join('relative', 'somewhere')],
    ['nonexistent path', () => join(validCwd(), 'no-such-dir')],
    ['path is a file', () => {
      const filePath = join(validCwd(), 'plain-file.txt');
      writeFileSync(filePath, 'x', 'utf8');
      return filePath;
    }],
  ];

  for (const [label, buildCwd] of invalidCases) {
    it(`rejects cwd: ${label} (400, zero side effects)`, async () => {
      const { ctx, app } = setupAcpHarness();
      const res = await callCreate(app, { agentId: 'coder', cwd: buildCwd() });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.code, 'invalid_cwd');
      // 零副作用：编排链路完全没有启动
      assert.equal(ctx._calls.createPrebuiltSession, undefined);
      assert.equal(ctx._calls.startManagedAgent, undefined);
      assert.equal(ctx._calls.onSessionCreated, undefined);
      assert.equal(ctx._calls.stopManagedAgent, undefined);
      assert.equal(ctx._calls.closeThread, undefined);
      assert.equal(ctx._calls.deletePrebuiltSession, undefined);
    });
  }

  it('rejects non-string cwd', async () => {
    const { app } = setupAcpHarness();
    const res = await callCreate(app, { agentId: 'coder', cwd: 12345 });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'invalid_cwd');
  });

  it('validateAcpCwd returns the normalized absolute path for a real directory', async () => {
    const normalized = await validateAcpCwd(validCwd());
    assert.equal(normalized, validCwd());
  });
});

// ── happy path ────────────────────────────────────────────────────

describe('ACP create — happy path', () => {
  it('creates session + runtime + thread and returns the full id bundle', async () => {
    seedRuntime({ sessionId: 'sess-acp-1', viewerAgentId: 'viewer-acp-1' });
    const { ctx, app } = setupAcpHarness();
    const res = await callCreate(app, { agentId: 'coder', cwd: validCwd() });

    assert.equal(res.statusCode, 201);
    assert.deepEqual(
      { ok: res.body.ok, clawSessionId: res.body.clawSessionId, threadId: res.body.threadId, viewerAgentId: res.body.viewerAgentId, cwd: res.body.cwd },
      { ok: true, clawSessionId: 'sess-acp-1', threadId: 'thread-acp-1', viewerAgentId: 'viewer-acp-1', cwd: validCwd() },
    );

    // session 以 main 类型 + 校验后的 cwd 创建
    const created = ctx._calls.createPrebuiltSession[0];
    assert.equal(created.agentId, 'programming-helper');
    assert.equal(created.opts.sessionType, 'coder');
    assert.equal(created.opts.openDirectory, validCwd());

    // runtime 以精确 session 启动并等待 READY（默认超时）
    assert.equal(ctx._calls.startManagedAgent[0].sessionId, 'sess-acp-1');
    assert.deepEqual(
      ctx._calls.waitForManagedRuntimeReady[0],
      { agentId: 'programming-helper', timeoutMs: ACP_READY_TIMEOUT_DEFAULT_MS, sessionId: 'sess-acp-1' },
    );

    // thread 经宿主钩子建立，并按 headSessionId 从 store 解析
    assert.equal(ctx._calls.onSessionCreated[0].sessionId, 'sess-acp-1');
    assert.equal(ctx._calls.findThreadByHeadSession[0].sessionId, 'sess-acp-1');

    // 成功路径不触发任何回滚动作
    assert.equal(ctx._calls.stopManagedAgent, undefined);
    assert.equal(ctx._calls.closeThread, undefined);
    assert.equal(ctx._calls.deletePrebuiltSession, undefined);
  });

  it('honours CLAW_ACP_READY_TIMEOUT_MS', async () => {
    seedRuntime({ sessionId: 'sess-acp-1', viewerAgentId: 'viewer-acp-1' });
    const prev = process.env.CLAW_ACP_READY_TIMEOUT_MS;
    process.env.CLAW_ACP_READY_TIMEOUT_MS = '1500';
    try {
      assert.equal(resolveAcpReadyTimeoutMs(), 1500);
      const { ctx, app } = setupAcpHarness();
      const res = await callCreate(app, { agentId: 'coder', cwd: validCwd() });
      assert.equal(res.statusCode, 201);
      assert.equal(ctx._calls.waitForManagedRuntimeReady[0].timeoutMs, 1500);
    } finally {
      if (prev === undefined) delete process.env.CLAW_ACP_READY_TIMEOUT_MS;
      else process.env.CLAW_ACP_READY_TIMEOUT_MS = prev;
    }
  });

  it('falls back to the default timeout for invalid CLAW_ACP_READY_TIMEOUT_MS', () => {
    const prev = process.env.CLAW_ACP_READY_TIMEOUT_MS;
    process.env.CLAW_ACP_READY_TIMEOUT_MS = 'not-a-number';
    try {
      assert.equal(resolveAcpReadyTimeoutMs(), ACP_READY_TIMEOUT_DEFAULT_MS);
    } finally {
      if (prev === undefined) delete process.env.CLAW_ACP_READY_TIMEOUT_MS;
      else process.env.CLAW_ACP_READY_TIMEOUT_MS = prev;
    }
  });
});

// ── rollback ladder injections ────────────────────────────────────

function stepStatuses(rollback) {
  return rollback.steps.map((step) => `${step.step}:${step.status}`).sort();
}

describe('ACP create — rollback ladder', () => {
  it('READY timeout → full ladder: stop runtime, close thread, delete session', async () => {
    seedRuntime({ sessionId: 'sess-acp-1', viewerAgentId: 'viewer-acp-1' });
    const { ctx, app } = setupAcpHarness({ readyResult: null });
    const res = await callCreate(app, { agentId: 'coder', cwd: validCwd() });

    assert.equal(res.statusCode, 504);
    assert.equal(res.body.code, 'runtime_ready_timeout');

    // 回滚阶梯完整执行且全部成功（无孤儿对象）
    assert.deepEqual(stepStatuses(res.body.rollback), ['close_thread:ok', 'delete_session:ok', 'stop_runtime:ok']);
    assert.deepEqual(res.body.rollback.leftover, {});

    // runtime 精确 stop（agentId + sessionId，不扩大范围）
    assert.deepEqual(ctx._calls.stopManagedAgent[0], { agentId: 'programming-helper', sessionId: 'sess-acp-1' });
    // thread 按 headSessionId 重新解析后关闭（兜底中间态），带回滚原因
    assert.equal(ctx._calls.closeThread[0].threadId, 'thread-acp-1');
    assert.equal(ctx._calls.closeThread[0].opts.reason, 'acp_session_creation_rollback');
    // session 从 index 删除
    assert.equal(ctx._calls.deletePrebuiltSession[0].sessionId, 'sess-acp-1');
  });

  it('runtime start failure → ladder skips thread close (hook never ran, no thread exists)', async () => {
    const { ctx, app } = setupAcpHarness({
      startManagedAgentThrow: 'spawn exploded',
      findThreadResult: null, // 现实：thread 钩子未执行，store 中无线程
    });
    const res = await callCreate(app, { agentId: 'coder', cwd: validCwd() });

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.code, 'acp_session_creation_failed');

    // start 已尝试 → 仍精确 stop（进程可能已 spawn）；无 thread → skipped；session 删除
    assert.deepEqual(stepStatuses(res.body.rollback), ['close_thread:skipped', 'delete_session:ok', 'stop_runtime:ok']);
    assert.equal(ctx._calls.onSessionCreated, undefined);
    assert.equal(ctx._calls.closeThread, undefined);
    assert.equal(ctx._calls.deletePrebuiltSession[0].sessionId, 'sess-acp-1');
    assert.deepEqual(res.body.rollback.leftover, {});
  });

  it('thread missing after READY → ladder stops runtime and deletes session', async () => {
    seedRuntime({ sessionId: 'sess-acp-1', viewerAgentId: 'viewer-acp-1' });
    const { ctx, app } = setupAcpHarness({
      onSessionCreatedResult: null,
      findThreadResult: null,
    });
    const res = await callCreate(app, { agentId: 'coder', cwd: validCwd() });

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.code, 'thread_missing');
    assert.deepEqual(stepStatuses(res.body.rollback), ['close_thread:skipped', 'delete_session:ok', 'stop_runtime:ok']);
    assert.equal(ctx._calls.stopManagedAgent[0].sessionId, 'sess-acp-1');
    assert.equal(ctx._calls.deletePrebuiltSession[0].sessionId, 'sess-acp-1');
    assert.deepEqual(res.body.rollback.leftover, {});
  });

  it('rollback failures are not masked: step statuses + leftover IDs reported', async () => {
    seedRuntime({ sessionId: 'sess-acp-1', viewerAgentId: 'viewer-acp-1' });
    const { app } = setupAcpHarness({
      readyResult: null,
      stopManagedAgentThrow: 'stop refused',
      closeThreadThrow: 'close refused',
      deletePrebuiltSessionThrow: 'delete refused',
    });
    const res = await callCreate(app, { agentId: 'coder', cwd: validCwd() });

    assert.equal(res.statusCode, 504);
    const rollback = res.body.rollback;
    assert.deepEqual(stepStatuses(rollback), ['close_thread:failed', 'delete_session:failed', 'stop_runtime:failed']);
    // 遗留对象 ID 全部如实上报，供手动清理
    assert.equal(rollback.leftover.viewerAgentId, 'viewer-acp-1');
    assert.equal(rollback.leftover.threadId, 'thread-acp-1');
    assert.equal(rollback.leftover.clawSessionId, 'sess-acp-1');
  });
});

// ── interrupt precision ───────────────────────────────────────────

describe('ACP interrupt', () => {
  it('targets the exact session runtime viewerAgentId, never sibling sessions', async () => {
    seedRuntime({ sessionId: 'sess-a', viewerAgentId: 'viewer-A' });
    seedRuntime({ sessionId: 'sess-b', viewerAgentId: 'viewer-B' });
    const { app } = setupAcpHarness();
    const fetchStub = stubFetch(okViewerResponse);
    try {
      const res = await callInterrupt(app, 'sess-a');
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body, { ok: true, clawSessionId: 'sess-a', viewerAgentId: 'viewer-A' });

      assert.equal(fetchStub.calls.length, 1);
      assert.equal(fetchStub.calls[0].url, `${VIEWER_ORIGIN}/api/agents/viewer-A/interrupt`);
      assert.equal(fetchStub.calls[0].init.method, 'POST');
    } finally {
      fetchStub.restore();
    }
  });

  it('returns 404 when no runtime is bound to the session (fetch untouched)', async () => {
    seedRuntime({ sessionId: 'sess-a', viewerAgentId: 'viewer-A' });
    const { app } = setupAcpHarness();
    const fetchStub = stubFetch(okViewerResponse);
    try {
      const res = await callInterrupt(app, 'sess-unknown');
      assert.equal(res.statusCode, 404);
      assert.equal(res.body.code, 'runtime_not_found');
      assert.equal(fetchStub.calls.length, 0);
    } finally {
      fetchStub.restore();
    }
  });

  it('returns 404 when the session runtime already exited', async () => {
    seedRuntime({ sessionId: 'sess-a', viewerAgentId: 'viewer-A', running: false });
    const { app } = setupAcpHarness();
    const fetchStub = stubFetch(okViewerResponse);
    try {
      const res = await callInterrupt(app, 'sess-a');
      assert.equal(res.statusCode, 404);
      assert.equal(fetchStub.calls.length, 0);
    } finally {
      fetchStub.restore();
    }
  });

  it('returns 502 when the ViewerWorker interrupt chain is unreachable', async () => {
    seedRuntime({ sessionId: 'sess-a', viewerAgentId: 'viewer-A' });
    const { app } = setupAcpHarness();
    const fetchStub = stubFetch(() => { throw new Error('ECONNREFUSED'); });
    try {
      const res = await callInterrupt(app, 'sess-a');
      assert.equal(res.statusCode, 502);
      assert.equal(res.body.code, 'viewer_unreachable');
    } finally {
      fetchStub.restore();
    }
  });

  it('returns 502 when the ViewerWorker interrupt endpoint errors', async () => {
    seedRuntime({ sessionId: 'sess-a', viewerAgentId: 'viewer-A' });
    const { app } = setupAcpHarness();
    const fetchStub = stubFetch(() => ({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Agent not found' }),
    }));
    try {
      const res = await callInterrupt(app, 'sess-a');
      assert.equal(res.statusCode, 502);
      assert.equal(res.body.code, 'viewer_interrupt_failed');
      assert.equal(res.body.viewerBody.error, 'Agent not found');
    } finally {
      fetchStub.restore();
    }
  });

  it('resolveSessionViewerAgentId falls back to selectedSessionId scan (shared-process key drift)', () => {
    // 注册键与请求键不同（shared-by-project 漂移），但 selectedSessionId 是绑定事实
    managedAgents.set('coder::other-key', {
      agentId: 'programming-helper',
      id: 'programming-helper',
      process: { exitCode: null, signalCode: null },
      stopped: false,
      viewerAgentId: 'viewer-drifted',
      selectedSessionId: 'sess-a',
    });
    assert.equal(resolveSessionViewerAgentId('programming-helper', 'sess-a'), 'viewer-drifted');
  });
});

// ── thread events: additive envelope fields ──────────────────────

describe('thread events — additive eventId / receivedAt', () => {
  function makeBoardState(entries, baseOffset = 0) {
    return {
      executionEvents: entries,
      executionEventBaseOffset: baseOffset,
    };
  }

  function setupEventsRoute(state) {
    const app = makeMockApp();
    const board = {
      getState: async () => state,
      recordRuntimeEvent: async () => ({ applied: true }),
    };
    setupThreadRoutes(app, makeMockExpress(), {
      control: {
        core: {},
        board,
        archive: { list: async () => ({}), isArchived: async () => false, archive: async () => ({ archivedAt: 1 }), unarchive: async () => null },
      },
    });
    return app;
  }

  async function callEvents(app, threadId, query = {}) {
    const handlers = app._routes['GET /protoclaw/threads/:threadId/events'];
    const res = makeMockRes();
    await handlers[handlers.length - 1]({ params: { threadId }, query }, res);
    return res;
  }

  const entries = [
    { eventId: 'ev-1', receivedAt: 111, event: { type: 'turn.started', turn: 1 } },
    { eventId: 'ev-2', receivedAt: 222, event: { type: 'item.completed', turn: 1, item: { id: 'i1' } } },
  ];

  it('attaches eventId / receivedAt per event while legacy fields remain', async () => {
    const app = setupEventsRoute(makeBoardState(entries));
    const res = await callEvents(app, 't1', { after: '0' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.cursor, 2);
    assert.deepEqual(
      res.body.events[0],
      { type: 'turn.started', turn: 1, eventId: 'ev-1', receivedAt: 111 },
    );
    assert.deepEqual(
      res.body.events[1],
      { type: 'item.completed', turn: 1, item: { id: 'i1' }, eventId: 'ev-2', receivedAt: 222 },
    );
  });

  it('honours the absolute cursor window (after slicing, baseOffset clamp)', async () => {
    // baseOffset=5：窗口内 3 条（绝对序号 5/6/7）
    const windowed = [0, 1, 2].map((i) => ({
      eventId: `ev-${i + 1}`,
      receivedAt: 100 + i,
      event: { type: 'turn.started', turn: i + 1 },
    }));
    const app = setupEventsRoute(makeBoardState(windowed, 5));

    // after=6 → 从窗口下标 1 开始（绝对序号 6、7）
    const sliced = await callEvents(app, 't1', { after: '6' });
    assert.equal(sliced.body.cursor, 8);
    assert.deepEqual(sliced.body.events.map((e) => e.eventId), ['ev-2', 'ev-3']);

    // after=2（落后于窗口起点 5）→ clamp 到 0，从头返回可用窗口
    const clamped = await callEvents(app, 't1', { after: '2' });
    assert.equal(clamped.body.cursor, 8);
    assert.deepEqual(clamped.body.events.map((e) => e.eventId), ['ev-1', 'ev-2', 'ev-3']);
  });

  it('keeps the legacy response shape for unknown threads', async () => {
    const app = setupEventsRoute(null);
    const res = await callEvents(app, 'missing', { after: '0' });
    assert.deepEqual(res.body, { ok: true, events: [], cursor: 0 });
  });
});
