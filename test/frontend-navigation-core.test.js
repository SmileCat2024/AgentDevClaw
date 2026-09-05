/**
 * navigation-core.js 单测（ADR-0014 Phase 1）
 *
 * 沙箱加载 public/src/modules/navigation-core.js，mock fetch 驱动
 * waitForRuntimeReady 的轮询状态机。intervalMs=0 避免真实等待。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function createNavigationSandbox() {
  const ctx = createFrontendSandbox();
  // 沙箱 context 未注入浏览器全局（生产环境天然存在）；URLSearchParams 取
  // node 同构实现，fetch 由各用例 mock。
  ctx.URLSearchParams = URLSearchParams;
  ctx.loadSource('public/src/modules/navigation-core.js');
  return ctx;
}

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

describe('navigation-core: waitForRuntimeReady', () => {
  it('returns the agent once runtime_status reports ready', async () => {
    const ctx = createNavigationSandbox();
    ctx.fetch = mockFetchWith([readyBody('agent-new-1')]);
    const agent = await ctx.window.NavigationCore.waitForRuntimeReady({
      agentId: 'programming-helper',
      sessionId: 'session-1',
      attempts: 3,
      intervalMs: 0,
    });
    assert.equal(agent.runtime_session_id, 'agent-new-1');
  });

  it('keeps polling while the bound runtime is still the excluded old one', async () => {
    const ctx = createNavigationSandbox();
    ctx.fetch = mockFetchWith([readyBody('agent-old'), readyBody('agent-old'), readyBody('agent-new')]);
    const agent = await ctx.window.NavigationCore.waitForRuntimeReady({
      agentId: 'programming-helper',
      sessionId: 'session-1',
      excludeRuntimeId: 'agent-old',
      attempts: 5,
      intervalMs: 0,
    });
    assert.equal(agent.runtime_session_id, 'agent-new');
  });

  it('keeps polling until the bound runtime matches expectRuntimeId', async () => {
    const ctx = createNavigationSandbox();
    ctx.fetch = mockFetchWith([readyBody('agent-other'), readyBody('agent-wanted')]);
    const agent = await ctx.window.NavigationCore.waitForRuntimeReady({
      agentId: 'programming-helper',
      sessionId: 'session-1',
      expectRuntimeId: 'agent-wanted',
      attempts: 5,
      intervalMs: 0,
    });
    assert.equal(agent.runtime_session_id, 'agent-wanted');
  });

  it('throws target_runtime_stopped when the runtime stops before ready', async () => {
    const ctx = createNavigationSandbox();
    ctx.fetch = mockFetchWith([{ ready: false, lifecycle: 'stopped', agent: null }]);
    await assert.rejects(
      ctx.window.NavigationCore.waitForRuntimeReady({
        agentId: 'programming-helper',
        sessionId: 'session-1',
        attempts: 3,
        intervalMs: 0,
      }),
      (error) => error.code === 'target_runtime_stopped',
    );
  });

  it('survives transient transport errors and resolves on a later poll', async () => {
    const ctx = createNavigationSandbox();
    ctx.fetch = mockFetchWith([new Error('network down'), readyBody('agent-late')]);
    const agent = await ctx.window.NavigationCore.waitForRuntimeReady({
      agentId: 'programming-helper',
      sessionId: 'session-1',
      attempts: 4,
      intervalMs: 0,
    });
    assert.equal(agent.runtime_session_id, 'agent-late');
  });

  it('returns null after exhausting attempts without readiness', async () => {
    const ctx = createNavigationSandbox();
    ctx.fetch = mockFetchWith([{ ready: false, lifecycle: 'starting', agent: null }]);
    const result = await ctx.window.NavigationCore.waitForRuntimeReady({
      agentId: 'programming-helper',
      sessionId: 'session-1',
      attempts: 2,
      intervalMs: 0,
    });
    assert.equal(result, null);
  });

  it('rejects immediately when agentId or sessionId is missing', async () => {
    const ctx = createNavigationSandbox();
    ctx.fetch = mockFetchWith([readyBody('agent-1')]);
    await assert.rejects(
      ctx.window.NavigationCore.waitForRuntimeReady({ agentId: '', sessionId: 's' }),
    );
    await assert.rejects(
      ctx.window.NavigationCore.waitForRuntimeReady({ agentId: 'a', sessionId: '' }),
    );
  });

  it('carries operationId through to the runtime_status request', async () => {
    const ctx = createNavigationSandbox();
    const fetchImpl = mockFetchWith([readyBody('agent-1')]);
    ctx.fetch = fetchImpl;
    await ctx.window.NavigationCore.waitForRuntimeReady({
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
    const ctx = createNavigationSandbox();
    ctx.window.RemoteConnections = {
      waitForRuntimeForSession: async (sessionId, attempts) => ({ sessionId, attempts }),
    };
    const ref = await ctx.window.NavigationCore.waitForRemoteRuntimeRef('remote:srv:s-1', 7);
    assert.deepEqual(ref, { sessionId: 'remote:srv:s-1', attempts: 7 });
  });

  it('returns null when RemoteConnections has no waiter (degraded catalog)', async () => {
    const ctx = createNavigationSandbox();
    const ref = await ctx.window.NavigationCore.waitForRemoteRuntimeRef('remote:srv:s-1');
    assert.equal(ref, null);
  });
});

describe('navigation-core: identity helpers (ADR-0014 Phase 2)', () => {
  it('resolveHostAgentId maps child entries to their host via parent_id', () => {
    const ctx = createNavigationSandbox();
    const { resolveHostAgentId } = ctx.window.NavigationCore;
    // child 条目：parent_id 是宿主；解析失败回退 fallbackId（2026-09-06
    // stop 事故契约：直接把 runtime id 发给服务端会被静默 no-op）。
    assert.equal(resolveHostAgentId({ parent_id: 'programming-helper', id: 'agent-1' }, 'agent-1'), 'programming-helper');
    assert.equal(resolveHostAgentId({ id: 'agent-1' }, 'programming-helper'), 'programming-helper');
    assert.equal(resolveHostAgentId(null, 'fallback-host'), 'fallback-host');
    assert.equal(resolveHostAgentId({}, ''), '');
  });

  it('extractRuntimeId unwraps restart responses (runtime wrapper first)', () => {
    const ctx = createNavigationSandbox();
    const { extractRuntimeId } = ctx.window.NavigationCore;
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
    const ctx = createNavigationSandbox();
    const { extractRuntimeId } = ctx.window.NavigationCore;
    assert.equal(
      extractRuntimeId({ agent: { runtime_session_id: 'rt-a', id: 'rt-a' } }),
      'rt-a',
    );
    assert.equal(
      extractRuntimeId({ agent: { runtimeSessionId: 'rt-b', id: 'rt-b' } }),
      'rt-b',
    );
    // 裸条目（沙箱无 getRuntimeId 时的 fallback 链）：id 兜底。
    assert.equal(extractRuntimeId({ runtime_session_id: '', id: 'rt-bare' }), 'rt-bare');
    assert.equal(extractRuntimeId(null), '');
    assert.equal(extractRuntimeId({}), '');
  });

  it('extractRuntimeId delegates to getRuntimeId when available (host records yield no runtime)', () => {
    const ctx = createNavigationSandbox();
    // 注入严格版 getRuntimeId（函数体内裸标识符在每次调用时解析，晚注入生效）：
    // 宿主条目（无 child 标记）不误取自身 id 当 runtime——这是委托权威实现
    // 相比旧手写链的语义收紧。
    ctx.getRuntimeId = (record) => (record?.source === 'child' ? String(record.id) : null);
    assert.equal(
      ctx.window.NavigationCore.extractRuntimeId({ agent: { source: 'prebuilt', id: 'host-1' } }),
      '',
    );
    assert.equal(
      ctx.window.NavigationCore.extractRuntimeId({ agent: { source: 'child', id: 'rt-child' } }),
      'rt-child',
    );
  });

  it('resolveStoppedRuntimeFallback prefers the host entry, then the workspace fallback resolver', () => {
    const ctx = createNavigationSandbox();
    const { resolveStoppedRuntimeFallback } = ctx.window.NavigationCore;
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
