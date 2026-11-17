/**
 * navigation-core.js 单测（ADR-0014 Phase 1）
 *
 * ESM 迁移后走真实 import 路线（test/helpers/esm-module-loader.js）：模块
 * 无内部状态，`fetch` 由各用例 mock，intervalMs=0 避免真实等待。
 * 兼容面断言钉住 window.NavigationCore 命名空间（三个 classic 消费方仍经它调用）。
 */

import { test, describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

let navigationCore;
let cleanupGlobals;
const originalFetch = globalThis.fetch;

before(async () => {
  cleanupGlobals = installBrowserStubs();
  const loaded = await loadModuleOnce('public/src/modules/navigation-core.js', { installGlobals: false });
  navigationCore = loaded.module;
});

after(() => {
  globalThis.fetch = originalFetch;
  cleanupGlobals();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete window.RemoteConnections;
  delete window.getRuntimeId;
});

/** 构造 runtime_status 响应序列的 fetch mock；每项为一个响应或 Error。 */
function mockFetchWith(responses) {
  let call = 0;
  const seenUrls = [];
  const fetchImpl = async (url) => {
    seenUrls.push(String(url));
    const item = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (item instanceof Error) throw item;
    return {
      ok: true,
      json: async () => item,
    };
  };
  fetchImpl.seenUrls = seenUrls;
  return fetchImpl;
}

const readyBody = (runtimeId) => ({
  ready: true,
  lifecycle: 'ready',
  agent: { id: runtimeId, runtime_session_id: runtimeId, source: 'child', connected: true },
});

test('navigation-core: 命名导出面完整（import 侧契约）', () => {
  for (const name of [
    'waitForRuntimeReady',
    'waitForRemoteRuntimeRef',
    'resolveHostAgentId',
    'extractRuntimeId',
    'resolveStoppedRuntimeFallback',
  ]) {
    assert.equal(typeof navigationCore[name], 'function', `缺少命名导出 ${name}`);
  }
});

describe('navigation-core: waitForRuntimeReady', () => {
  it('returns the agent once runtime_status reports ready', async () => {
    globalThis.fetch = mockFetchWith([readyBody('agent-new-1')]);
    const agent = await navigationCore.waitForRuntimeReady({
      agentId: 'programming-helper',
      sessionId: 'session-1',
      attempts: 3,
      intervalMs: 0,
    });
    assert.equal(agent.runtime_session_id, 'agent-new-1');
  });

  it('keeps polling while the bound runtime is still the excluded old one', async () => {
    globalThis.fetch = mockFetchWith([readyBody('agent-old'), readyBody('agent-old'), readyBody('agent-new')]);
    const agent = await navigationCore.waitForRuntimeReady({
      agentId: 'programming-helper',
      sessionId: 'session-1',
      excludeRuntimeId: 'agent-old',
      attempts: 5,
      intervalMs: 0,
    });
    assert.equal(agent.runtime_session_id, 'agent-new');
  });

  it('keeps polling until the bound runtime matches expectRuntimeId', async () => {
    globalThis.fetch = mockFetchWith([readyBody('agent-other'), readyBody('agent-wanted')]);
    const agent = await navigationCore.waitForRuntimeReady({
      agentId: 'programming-helper',
      sessionId: 'session-1',
      expectRuntimeId: 'agent-wanted',
      attempts: 5,
      intervalMs: 0,
    });
    assert.equal(agent.runtime_session_id, 'agent-wanted');
  });

  it('throws target_runtime_stopped when the runtime stops before ready', async () => {
    globalThis.fetch = mockFetchWith([{ ready: false, lifecycle: 'stopped', agent: null }]);
    await assert.rejects(
      navigationCore.waitForRuntimeReady({
        agentId: 'programming-helper',
        sessionId: 'session-1',
        attempts: 3,
        intervalMs: 0,
      }),
      (error) => error.code === 'target_runtime_stopped',
    );
  });

  it('survives transient transport errors and resolves on a later poll', async () => {
    globalThis.fetch = mockFetchWith([new Error('network down'), readyBody('agent-late')]);
    const agent = await navigationCore.waitForRuntimeReady({
      agentId: 'programming-helper',
      sessionId: 'session-1',
      attempts: 4,
      intervalMs: 0,
    });
    assert.equal(agent.runtime_session_id, 'agent-late');
  });

  it('returns null after exhausting attempts without readiness (slow-start budget disabled)', async () => {
    globalThis.fetch = mockFetchWith([{ ready: false, lifecycle: 'starting', agent: null }]);
    const result = await navigationCore.waitForRuntimeReady({
      agentId: 'programming-helper',
      sessionId: 'session-1',
      attempts: 2,
      intervalMs: 0,
      slowAttempts: 0,
    });
    assert.equal(result, null);
  });

  it('extends waiting into the slow-start budget when the runtime is confirmed starting', async () => {
    // 2026-11-13 桌面版冷启动事故：首次 open 基础预算（10s）耗尽放弃导航，
    // runtime 随后 ready、第二次点击 1.3s 进入。观察到 lifecycle=starting
    // （服务端确证进程存活仍在启动）时必须追加等待而不是按失败回退。
    // 基础预算 2 次耗尽时仍 starting，追加段第 2 次探测转 ready。
    globalThis.fetch = mockFetchWith([
      { ready: false, lifecycle: 'starting', agent: null },
      { ready: false, lifecycle: 'starting', agent: null },
      { ready: false, lifecycle: 'starting', agent: null },
      readyBody('agent-slow-start'),
    ]);
    const agent = await navigationCore.waitForRuntimeReady({
      agentId: 'programming-helper',
      sessionId: 'session-1',
      attempts: 2,
      intervalMs: 0,
      slowAttempts: 5,
      slowIntervalMs: 0,
    });
    assert.equal(agent.runtime_session_id, 'agent-slow-start');
  });

  it('does not grant the slow-start budget without evidence of a starting runtime', async () => {
    // 持续传输错误（无 lifecycle 证据）不触发追加段：轮询次数仍由基础
    // 预算限定，慢启动资格只在服务端确证 starting 时授予。
    const fetchImpl = mockFetchWith([new Error('network down')]);
    globalThis.fetch = fetchImpl;
    const result = await navigationCore.waitForRuntimeReady({
      agentId: 'programming-helper',
      sessionId: 'session-1',
      attempts: 2,
      intervalMs: 0,
      slowAttempts: 5,
      slowIntervalMs: 0,
    });
    assert.equal(result, null);
    assert.equal(fetchImpl.seenUrls.length, 2);
  });

  it('throws target_runtime_stopped when a starting runtime later stops (incl. slow-start phase)', async () => {
    globalThis.fetch = mockFetchWith([
      { ready: false, lifecycle: 'starting', agent: null },
      { ready: false, lifecycle: 'stopped', agent: null },
    ]);
    await assert.rejects(
      navigationCore.waitForRuntimeReady({
        agentId: 'programming-helper',
        sessionId: 'session-1',
        attempts: 1,
        intervalMs: 0,
        slowAttempts: 3,
        slowIntervalMs: 0,
      }),
      (error) => error.code === 'target_runtime_stopped',
    );
  });

  it('returns null when the slow-start budget is also exhausted', async () => {
    const fetchImpl = mockFetchWith([{ ready: false, lifecycle: 'starting', agent: null }]);
    globalThis.fetch = fetchImpl;
    const result = await navigationCore.waitForRuntimeReady({
      agentId: 'programming-helper',
      sessionId: 'session-1',
      attempts: 1,
      intervalMs: 0,
      slowAttempts: 2,
      slowIntervalMs: 0,
    });
    assert.equal(result, null);
    assert.equal(fetchImpl.seenUrls.length, 3);
  });

  it('rejects immediately when agentId or sessionId is missing', async () => {
    globalThis.fetch = mockFetchWith([readyBody('agent-1')]);
    await assert.rejects(
      navigationCore.waitForRuntimeReady({ agentId: '', sessionId: 's' }),
    );
    await assert.rejects(
      navigationCore.waitForRuntimeReady({ agentId: 'a', sessionId: '' }),
    );
  });

  it('carries operationId through to the runtime_status request', async () => {
    const fetchImpl = mockFetchWith([readyBody('agent-1')]);
    globalThis.fetch = fetchImpl;
    await navigationCore.waitForRuntimeReady({
      agentId: 'programming-helper',
      sessionId: 'session-1',
      operationId: 'op-42',
      attempts: 1,
      intervalMs: 0,
    });
    assert.ok(fetchImpl.seenUrls[0].includes('operationId=op-42'));
    assert.ok(fetchImpl.seenUrls[0].includes('agentId=programming-helper'));
    assert.ok(fetchImpl.seenUrls[0].includes('sessionId=session-1'));
  });
});

describe('navigation-core: waitForRemoteRuntimeRef', () => {
  it('delegates to RemoteConnections.waitForRuntimeForSession', async () => {
    window.RemoteConnections = {
      waitForRuntimeForSession: async (sessionId, attempts) => ({ sessionId, attempts }),
    };
    const ref = await navigationCore.waitForRemoteRuntimeRef('remote:srv:s-1', 7);
    assert.deepEqual(ref, { sessionId: 'remote:srv:s-1', attempts: 7 });
  });

  it('returns null when RemoteConnections has no waiter (degraded catalog)', async () => {
    const ref = await navigationCore.waitForRemoteRuntimeRef('remote:srv:s-1');
    assert.equal(ref, null);
  });
});

describe('navigation-core: identity helpers (ADR-0014 Phase 2)', () => {
  it('resolveHostAgentId maps child entries to their host via parent_id', () => {
    const { resolveHostAgentId } = navigationCore;
    // child 条目：parent_id 是宿主；解析失败回退 fallbackId（2026-09-06
    // stop 事故契约：直接把 runtime id 发给服务端会被静默 no-op）。
    assert.equal(resolveHostAgentId({ parent_id: 'programming-helper', id: 'agent-1' }, 'agent-1'), 'programming-helper');
    assert.equal(resolveHostAgentId({ id: 'agent-1' }, 'programming-helper'), 'programming-helper');
    assert.equal(resolveHostAgentId(null, 'fallback-host'), 'fallback-host');
    assert.equal(resolveHostAgentId({}, ''), '');
  });

  it('extractRuntimeId unwraps restart responses (runtime wrapper first)', () => {
    const { extractRuntimeId } = navigationCore;
    assert.equal(
      extractRuntimeId({ runtime: { id: 'rt-new' }, agent: { runtime_session_id: 'rt-other' } }),
      'rt-new',
    );
    assert.equal(
      extractRuntimeId({ runtime: { viewerAgentId: 'rt-v' } }),
      'rt-v',
    );
  });

  it('extractRuntimeId falls through to the agent entry alias chain', () => {
    const { extractRuntimeId } = navigationCore;
    assert.equal(
      extractRuntimeId({ agent: { runtime_session_id: 'rt-a', id: 'rt-a' } }),
      'rt-a',
    );
    assert.equal(
      extractRuntimeId({ agent: { runtimeSessionId: 'rt-b', id: 'rt-b' } }),
      'rt-b',
    );
    // 裸条目（无 window.getRuntimeId 时的 fallback 链）：id 兜底。
    assert.equal(extractRuntimeId({ runtime_session_id: '', id: 'rt-bare' }), 'rt-bare');
    assert.equal(extractRuntimeId(null), '');
    assert.equal(extractRuntimeId({}), '');
  });

  it('extractRuntimeId delegates to getRuntimeId when available (host records yield no runtime)', () => {
    // 注入严格版 getRuntimeId（module 内每次调用时经 window 解析，晚注入生效）：
    // 宿主条目（无 child 标记）不误取自身 id 当 runtime——这是委托权威实现
    // 相比旧手写链的语义收紧。
    window.getRuntimeId = (record) => (record?.source === 'child' ? String(record.id) : null);
    assert.equal(
      navigationCore.extractRuntimeId({ agent: { source: 'prebuilt', id: 'host-1' } }),
      '',
    );
    assert.equal(
      navigationCore.extractRuntimeId({ agent: { source: 'child', id: 'rt-child' } }),
      'rt-child',
    );
  });

  it('resolveStoppedRuntimeFallback prefers the host entry, then the workspace fallback resolver', () => {
    const { resolveStoppedRuntimeFallback } = navigationCore;
    const resolver = (entry) => `ws-fallback:${entry?.id || 'none'}`;
    assert.equal(
      resolveStoppedRuntimeFallback({ parent_id: 'programming-helper', id: 'agent-1' }, resolver),
      'programming-helper',
    );
    assert.equal(
      resolveStoppedRuntimeFallback({ id: 'agent-1' }, resolver),
      'ws-fallback:agent-1',
    );
    assert.equal(resolveStoppedRuntimeFallback(null, resolver), 'ws-fallback:none');
    assert.equal(resolveStoppedRuntimeFallback({ parent_id: 'host' }, null), 'host');
  });
});

describe('navigation-core: 兼容面', () => {
  it('window.NavigationCore 是同一组实现的既有命名空间协议', () => {
    assert.equal(typeof window.NavigationCore, 'object');
    assert.equal(typeof window.NavigationCore.waitForRuntimeReady, 'function');
    assert.equal(window.NavigationCore.waitForRuntimeReady, navigationCore.waitForRuntimeReady);
    assert.equal(window.NavigationCore.waitForRemoteRuntimeRef, navigationCore.waitForRemoteRuntimeRef);
    assert.equal(window.NavigationCore.resolveHostAgentId, navigationCore.resolveHostAgentId);
    assert.equal(window.NavigationCore.extractRuntimeId, navigationCore.extractRuntimeId);
    assert.equal(window.NavigationCore.resolveStoppedRuntimeFallback, navigationCore.resolveStoppedRuntimeFallback);
  });
});
