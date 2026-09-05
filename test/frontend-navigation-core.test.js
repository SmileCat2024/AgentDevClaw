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
