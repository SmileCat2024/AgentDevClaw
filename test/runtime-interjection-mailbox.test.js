/**
 * Tests for the interjection mailbox re-post (scripts/runtime-interjection-mailbox.js).
 *
 * Regression coverage for the 2026-11-05 interjection timing bug: while a
 * call started by a non-lease source (rotation continuation / IM dispatch)
 * was running, the input loop's armed text lease captured user messages and
 * turned them into next-call envelopes serialized behind the active call —
 * messages landed only after the call ended. The fix re-posts such lease
 * answers to the ViewerWorker mailbox so react-loop's step-boundary drain
 * injects them mid-call. These tests pin the helper's addressing, payload,
 * auth and failure contract; the busy-routing decision lives in
 * run-prebuilt-agent's input loop and is verified live.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  postUserTurnToViewerMailbox,
  waitForArbiterIdle,
} from '../scripts/runtime-interjection-mailbox.js';

function createFetchMock({ respond } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return respond ? respond(url, init) : { ok: true, status: 200, json: async () => ({ success: true, delivery: 'queued' }) };
  };
  return { fetchImpl, calls };
}

describe('postUserTurnToViewerMailbox', () => {
  const ORIGIN = 'http://127.0.0.1:9999';
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.AGENTDEV_VIEWER_ORIGIN;
    delete process.env.PROTOCLAW_INTERNAL_TOKEN;
    delete process.env.AGENTDEV_VIEWER_PORT;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('posts the turn payload to the viewer user-turn endpoint and reports ok on queued', async () => {
    const { fetchImpl, calls } = createFetchMock();
    const result = await postUserTurnToViewerMailbox({
      agentId: 'agent-13-58848',
      viewerOrigin: ORIGIN,
      turn: { text: '插话内容', source: 'viewer-input', sourceRef: 'sr-1', images: [{ path: 'a.png' }] },
      fetchImpl,
    });
    assert.equal(result.ok, true);
    assert.equal(result.delivery, 'queued');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${ORIGIN}/api/agents/agent-13-58848/user-turn`);
    assert.equal(calls[0].init.method, 'POST');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.text, '插话内容');
    assert.equal(body.source, 'viewer-input');
    assert.equal(body.sourceRef, 'sr-1');
    assert.deepEqual(body.images, [{ path: 'a.png' }]);
  });

  it('carries the internal bearer token when configured', async () => {
    process.env.PROTOCLAW_INTERNAL_TOKEN = 'tok-123';
    const { fetchImpl, calls } = createFetchMock();
    const result = await postUserTurnToViewerMailbox({ agentId: 'a1', viewerOrigin: ORIGIN, turn: { text: 'x' }, fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-123');
  });

  it('falls back to loopback + AGENTDEV_VIEWER_PORT when no origin given', async () => {
    process.env.AGENTDEV_VIEWER_PORT = '3456';
    const { fetchImpl, calls } = createFetchMock();
    await postUserTurnToViewerMailbox({ agentId: 'a1', turn: { text: 'x' }, fetchImpl });
    assert.equal(calls[0].url, 'http://127.0.0.1:3456/api/agents/a1/user-turn');
  });

  it('prefers the injected viewerPort over env fallback', async () => {
    const { fetchImpl, calls } = createFetchMock();
    await postUserTurnToViewerMailbox({ agentId: 'a1', viewerPort: 7777, turn: { text: 'x' }, fetchImpl });
    assert.equal(calls[0].url, 'http://127.0.0.1:7777/api/agents/a1/user-turn');
  });

  it('reports not-ok on HTTP failure so the caller can fall back to the envelope path', async () => {
    const { fetchImpl } = createFetchMock({ respond: () => ({ ok: false, status: 503, json: async () => ({}) }) });
    const result = await postUserTurnToViewerMailbox({ agentId: 'a1', viewerOrigin: ORIGIN, turn: { text: 'x' }, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
  });

  it('reports not-ok on viewer rejection (success:false) without throwing', async () => {
    const { fetchImpl } = createFetchMock({
      respond: () => ({ ok: true, status: 200, json: async () => ({ success: false, code: 'runtime_not_accepting_input' }) }),
    });
    const result = await postUserTurnToViewerMailbox({ agentId: 'a1', viewerOrigin: ORIGIN, turn: { text: 'x' }, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'viewer_rejected');
  });

  it('reports not-ok on network error so the message is not silently dropped', async () => {
    const { fetchImpl } = createFetchMock({ respond: async () => { throw new Error('ECONNREFUSED'); } });
    const result = await postUserTurnToViewerMailbox({ agentId: 'a1', viewerOrigin: ORIGIN, turn: { text: 'x' }, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.error.message, 'ECONNREFUSED');
  });

  it('rejects a missing agentId without issuing a request', async () => {
    const { fetchImpl, calls } = createFetchMock();
    const result = await postUserTurnToViewerMailbox({ turn: { text: 'x' }, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'missing_agent_id');
    assert.equal(calls.length, 0);
  });
});

describe('waitForArbiterIdle', () => {
  // 承诺来自输入循环接线契约（插话时序修复 v2）：
  // - arbiter idle 时零延迟放行（空闲会话的 lease 不得被门禁拖慢）；
  // - busy 期间绝不放行、按给定间隔轮询（放行即热循环回归）；
  // - 取消条件成立时立即返回 cancelled，且优先于 idle 判定
  //   （已退役的循环不得再武装 lease）。

  function createSleepRecorder() {
    const sleeps = [];
    const sleepImpl = async (ms) => { sleeps.push(ms); };
    return { sleeps, sleepImpl };
  }

  it('returns idle immediately without polling when the arbiter is idle', async () => {
    const { sleeps, sleepImpl } = createSleepRecorder();
    const result = await waitForArbiterIdle({
      getStatus: () => ({ status: 'idle' }),
      isCancelled: () => false,
      sleepImpl,
    });
    assert.equal(result, 'idle');
    assert.equal(sleeps.length, 0);
  });

  it('keeps polling at the interval while busy and resolves once idle', async () => {
    const { sleeps, sleepImpl } = createSleepRecorder();
    const statuses = ['running', 'queued', 'idle'];
    const result = await waitForArbiterIdle({
      getStatus: () => ({ status: statuses.shift() }),
      isCancelled: () => false,
      pollIntervalMs: 50,
      sleepImpl,
    });
    assert.equal(result, 'idle');
    // 忙两拍 → 恰好两次间隔等待：不多（无自旋）也不少（未提前放行）
    assert.deepEqual(sleeps, [50, 50]);
  });

  it('returns cancelled promptly when the loop is retired while busy', async () => {
    const { sleeps, sleepImpl } = createSleepRecorder();
    const boundedSleep = async (ms) => {
      if (sleeps.length >= 10) throw new Error('waitForArbiterIdle 未响应取消条件，疑似挂死');
      await sleepImpl(ms);
    };
    // 取消条件在首个轮询间隔后成立：期望一个间隔内退出
    const result = await waitForArbiterIdle({
      getStatus: () => ({ status: 'running' }),
      isCancelled: () => sleeps.length >= 1,
      pollIntervalMs: 10,
      sleepImpl: boundedSleep,
    });
    assert.equal(result, 'cancelled');
    assert.equal(sleeps.length, 1);
  });

  it('prefers cancelled over idle (a retired loop must not arm a lease)', async () => {
    const { sleeps, sleepImpl } = createSleepRecorder();
    const result = await waitForArbiterIdle({
      getStatus: () => ({ status: 'idle' }),
      isCancelled: () => true,
      sleepImpl,
    });
    assert.equal(result, 'cancelled');
    assert.equal(sleeps.length, 0);
  });

  it('treats a throwing getStatus as busy and keeps waiting', async () => {
    const { sleeps, sleepImpl } = createSleepRecorder();
    let calls = 0;
    const result = await waitForArbiterIdle({
      getStatus: () => {
        calls += 1;
        if (calls < 3) throw new Error('transient');
        return { status: 'idle' };
      },
      isCancelled: () => false,
      sleepImpl,
    });
    assert.equal(result, 'idle');
    assert.equal(sleeps.length, 2);
  });
});
