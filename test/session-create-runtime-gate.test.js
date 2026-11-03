/**
 * 创建就绪闸门（POST /protoclaw/prebuilt_sessions 假成功修复）
 *
 * 冷 spawn 曾在进程拉起即返回 200：初始会话随后启动失败（模型解析失败 /
 * 快照损坏拒绝 READY / 崩溃）时，用户拿到"已创建但打不开"的死会话且无任何
 * 错误信号。现在 create 在响应前等待 runtime 记录落定：
 * - 进程退出 → 502 runtime_start_failed + 回滚（删除本次创建的会话记录）
 * - 超时未就绪 → 502 runtime_start_timeout + 杀掉残留进程 + 回滚
 * - 共享进程 add-session 被拒（startManagedAgent 抛错）→ 回滚但不动共享进程
 * - 就绪 → 200（会话已创建且 runtime 已就绪）
 *
 * harness 参照 session-create-coder-directory.test.js：capture handler 直接
 * 调用，ctx 最小替身；runtime 记录走真实 managedAgents 表（helper 读同一张
 * 表，键由 getManagedRuntimeKey 派生）。AGENTDEV_DATA_DIR 隔离数据目录。
 */

import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'claw-create-ready-gate-'));
process.env.AGENTDEV_DATA_DIR = DATA_ROOT;

const { setupSessionRoutes, waitForCreatedRuntimeSettled } = await import('../server/routes/session.js');
const { managedAgents, getManagedRuntimeKey } = await import('../server/shared/agent-access.js');
const { buildLocalFailureResponse } = await import('../server/shared/operation-contract.js');

after(() => {
  rmSync(DATA_ROOT, { recursive: true, force: true });
});

// 错误响应的稳定码翻译：调用方按 code/retryable 决策（调度面不会对模型解析
// 失败做无意义重试；超时未就绪允许重试）。
describe('创建闸门错误的稳定码契约', () => {
  test('runtime_start_failed → operation_rejected 且不可重试', () => {
    const body = buildLocalFailureResponse(
      Object.assign(new Error('runtime 启动失败（进程已提前退出），本次创建已回滚'), {
        statusCode: 502, code: 'runtime_start_failed',
      }),
    );
    assert.equal(body.code, 'operation_rejected');
    assert.equal(body.retryable, false);
    assert.equal(body.legacyCode, 'runtime_start_failed');
  });

  test('runtime_start_timeout → runtime_not_ready 且可重试', () => {
    const body = buildLocalFailureResponse(
      Object.assign(new Error('runtime 10000ms 内未就绪，本次创建已回滚'), {
        statusCode: 504, code: 'runtime_start_timeout',
      }),
    );
    assert.equal(body.code, 'runtime_not_ready');
    assert.equal(body.retryable, true);
    assert.equal(body.legacyCode, 'runtime_start_timeout');
  });
});

// ── fakes ─────────────────────────────────────────────────────────────────

function makeFakeProcess({ dead = false } = {}) {
  const listeners = new Map();
  const proc = {
    pid: 42421,
    exitCode: dead ? 1 : null,
    signalCode: null,
    killed: false,
    // agent-startup 的 output 处理器经 backend 挂载的 getOutputTail 读输出尾
    getOutputTail: () => '[ProtoClaw Runtime] 启动失败: Error: No model available: 启动模型解析失败且会话恢复未绑定任何模型',
    on(event, cb) {
      const arr = listeners.get(event) || [];
      arr.push(cb);
      listeners.set(event, arr);
    },
    once(event, cb) { this.on(event, cb); },
    removeListener() {},
    emit(event, ...args) {
      for (const cb of listeners.get(event) || []) cb(...args);
    },
    kill(signal = 'SIGTERM') {
      proc.killed = true;
      queueMicrotask(() => {
        proc.exitCode = null;
        proc.signalCode = signal;
        proc.emit('exit', null, signal);
      });
      return true;
    },
  };
  return proc;
}

function registerRuntime(agentId, sessionId, fields = {}) {
  const key = getManagedRuntimeKey(agentId, sessionId);
  const runtime = {
    key,
    agentId,
    id: agentId,
    startedAt: new Date().toISOString(),
    exitCode: null,
    signalCode: null,
    stopped: false,
    ready: false,
    viewerAgentId: 'viewer-1',
    selectedSessionId: sessionId,
    process: makeFakeProcess(),
    processGroupKey: null,
    ...fields,
  };
  managedAgents.set(key, runtime);
  return runtime;
}

function buildHarness({ onStart, runtimeReadyWaitMs } = {}) {
  const deletes = [];
  const exitWaits = [];
  let handler = null;
  setupSessionRoutes(
    {
      get: () => {},
      put: () => {},
      delete: () => {},
      post: (routePath, ...rest) => {
        if (routePath === '/protoclaw/prebuilt_sessions') handler = rest[rest.length - 1];
      },
    },
    { json: () => (_req, _res, next) => next?.() },
    {
      requireAgentLight: async (id) => ({ id }),
      createPrebuiltSession: async (_agentId) => ({
        id: 'session-new-1',
        indexRevision: 7,
        title: '新对话',
        openDirectory: 'D:/proj',
      }),
      startManagedAgent: async (agent, sessionId) => {
        if (onStart) await onStart(agent, sessionId);
        return {};
      },
      waitForProcessExit: async (child) => { exitWaits.push(child); },
      deletePrebuiltSession: async (agentId, sessionId, opts) => {
        deletes.push({ agentId, sessionId, opts });
        return { revision: 8 };
      },
      ...(runtimeReadyWaitMs !== undefined ? { runtimeReadyWaitMs } : {}),
    },
  );
  if (!handler) throw new Error('create handler not captured');
  return { handler, deletes, exitWaits };
}

function makeRes() {
  return {
    statusCode: 200,
    jsonPayload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.jsonPayload = payload; },
  };
}

async function invoke(handler, body) {
  const res = makeRes();
  let nextError = null;
  await handler({ body }, res, (e) => { nextError = e; });
  return { res, nextError };
}

// ── waitForCreatedRuntimeSettled 单元 ─────────────────────────────────────

describe('waitForCreatedRuntimeSettled', () => {
  beforeEach(() => { managedAgents.clear(); });

  test('ready 且运行中 → 立即 ok（join 路径返回前已置 ready 的形态）', async () => {
    const runtime = registerRuntime('gate-unit', 's-ready', { ready: true });
    const startedAt = Date.now();
    const settled = await waitForCreatedRuntimeSettled('gate-unit', 's-ready', 1000, 5);
    assert.equal(settled.ok, true);
    assert.equal(settled.runtime, runtime);
    assert.ok(Date.now() - startedAt < 100, 'ready 路径不得轮询等待');
  });

  test('进程存活但永不 ready → 窗口耗尽后 timedOut', async () => {
    registerRuntime('gate-unit', 's-hang', { ready: false });
    const startedAt = Date.now();
    const settled = await waitForCreatedRuntimeSettled('gate-unit', 's-hang', 80, 5);
    assert.equal(settled.ok, false);
    assert.equal(settled.timedOut, true);
    assert.ok(Date.now() - startedAt >= 75, '必须等满窗口才判超时');
  });

  test('进程已退出（stopped）→ 立即失败而非等满窗口', async () => {
    const runtime = registerRuntime('gate-unit', 's-dead', { stopped: true });
    runtime.process = makeFakeProcess({ dead: true });
    const startedAt = Date.now();
    const settled = await waitForCreatedRuntimeSettled('gate-unit', 's-dead', 5000, 5);
    assert.equal(settled.ok, false);
    assert.equal(settled.timedOut, undefined);
    assert.ok(Date.now() - startedAt < 100, '退出事实已知，不得干等');
  });

  test('记录不存在 → 立即失败，runtime 为 null', async () => {
    const settled = await waitForCreatedRuntimeSettled('gate-unit', 's-missing', 5000, 5);
    assert.equal(settled.ok, false);
    assert.equal(settled.runtime, null);
  });
});

// ── create 路由就绪闸门与回滚 ────────────────────────────────────────────

describe('POST /protoclaw/prebuilt_sessions 创建就绪闸门', () => {
  beforeEach(() => { managedAgents.clear(); });

  test('冷 spawn 启动失败（进程退出）→ 502 runtime_start_failed + 回滚会话记录', async () => {
    const { handler, deletes, exitWaits } = buildHarness({
      onStart: (agent, sessionId) => {
        // spawn 完成即崩溃：exit 处理器语义（stopped + 进程退出）
        const runtime = registerRuntime(agent.id, sessionId);
        runtime.process = makeFakeProcess({ dead: true });
        runtime.stopped = true;
      },
    });
    const { res, nextError } = await invoke(handler, { agentId: 'programming-helper', title: 'x' });
    assert.ok(nextError, '失败必须经 next(error) 上抛，不得伪装 200');
    assert.equal(nextError.statusCode, 502);
    assert.equal(nextError.code, 'runtime_start_failed');
    assert.match(nextError.message, /已回滚/);
    assert.match(nextError.message, /进程已提前退出/);
    assert.match(nextError.message, /No model available/, '错误信息带 runtime 输出尾部供诊断');
    assert.equal(deletes.length, 1, '会话记录必须回滚删除');
    assert.equal(deletes[0].sessionId, 'session-new-1');
    assert.equal(deletes[0].opts.includeSessions, false);
    assert.equal(exitWaits.length, 0, '进程已死，无需 kill/等待退出');
    assert.equal(res.jsonPayload, null, '不得写出成功响应');
  });

  test('冷 spawn 超时未就绪 → 502 runtime_start_timeout + kill 残留进程 + 回滚', async () => {
    const { handler, deletes, exitWaits } = buildHarness({
      runtimeReadyWaitMs: 150,
      onStart: (agent, sessionId) => {
        // 挂死进程：一直活着的冷 spawn 记录（无 processGroupKey）
        registerRuntime(agent.id, sessionId, { ready: false });
      },
    });
    const { nextError } = await invoke(handler, { agentId: 'programming-helper', title: 'x' });
    assert.ok(nextError);
    assert.equal(nextError.statusCode, 502);
    assert.equal(nextError.code, 'runtime_start_timeout');
    assert.match(nextError.message, /未就绪/);
    assert.match(nextError.message, /已回滚/);
    assert.equal(deletes.length, 1);
    const runtime = managedAgents.get(getManagedRuntimeKey('programming-helper', 'session-new-1'));
    assert.ok(runtime, 'kill 分支的记录收敛归 exit 处理器（此处为替身，保留原记录）');
    assert.equal(runtime.process.killed, true, '未就绪的残留进程必须被杀');
    assert.equal(runtime.stopped, true, 'kill 前先标 stopped（人为停止语义）');
    assert.equal(exitWaits.length, 1, 'kill 后必须等待退出');
    assert.equal(exitWaits[0], runtime.process);
  });

  test('共享进程 add-session 被拒（startManagedAgent 抛错）→ 回滚但不动共享进程', async () => {
    let joinProcess = null;
    const { handler, deletes, exitWaits } = buildHarness({
      onStart: (agent, sessionId) => {
        // join 失败形态：join 分支 catch 已自删记录，此处还原"记录仍在"的
        // 最坏时序，验证回滚只删记录、不杀共享进程
        const runtime = registerRuntime(agent.id, sessionId, {
          ready: false,
          processGroupKey: 'programming-helper::d:/proj',
        });
        joinProcess = runtime.process;
        throw new Error('add-session timeout after 10000ms');
      },
    });
    const { nextError } = await invoke(handler, { agentId: 'programming-helper', title: 'x' });
    assert.ok(nextError);
    assert.match(nextError.message, /add-session timeout/, '原始错误原样上抛');
    assert.equal(deletes.length, 1, '会话记录必须回滚');
    const key = getManagedRuntimeKey('programming-helper', 'session-new-1');
    assert.equal(managedAgents.has(key), false, 'join 记录从本侧收敛删除');
    assert.equal(joinProcess?.killed, false, '共享进程不得被杀（兄弟会话不受牵连）');
    assert.equal(exitWaits.length, 0, '无进程退出等待');
  });

  test('runtime 就绪 → 200，响应携带就绪后的完整 status', async () => {
    const { handler, deletes } = buildHarness({
      onStart: (agent, sessionId) => {
        registerRuntime(agent.id, sessionId, { ready: true });
      },
    });
    const { res, nextError } = await invoke(handler, { agentId: 'programming-helper', title: 'x' });
    assert.equal(nextError, null);
    assert.equal(res.statusCode, 200);
    assert.equal(res.jsonPayload.protocolVersion, 2);
    assert.equal(res.jsonPayload.session.id, 'session-new-1');
    assert.equal(res.jsonPayload.revision, 7);
    assert.equal(res.jsonPayload.threadId, null, '非线程宿主 no-op');
    assert.equal(res.jsonPayload.status.status, 'running');
    assert.equal(res.jsonPayload.status.viewerAgentId, 'viewer-1', 'status 在就绪后重读，含 viewerAgentId');
    assert.equal(deletes.length, 0, '成功路径不得回滚');
  });
});
