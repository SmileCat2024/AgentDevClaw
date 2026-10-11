import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ContextGuardFeature, ContextRotationTriggerFeature } from '../src/index.js';

function makeAgent() {
  const calls: string[] = [];
  return {
    calls,
    llm: { chat: async () => ({ content: 'ok' }) },
    interrupt() { calls.push('interrupt'); },
  };
}

function makeArbiter() {
  const calls: string[] = [];
  return {
    calls,
    interruptActive(reason: string) { calls.push(`interruptActive:${reason}`); },
  };
}

describe('ContextGuardFeature (interactive shell)', () => {
  it('trips once when input tokens cross the threshold, interrupting at step finish (after tool results land)', async () => {
    const feature = new ContextGuardFeature({ contextLength: 1000, compressRatio: 80 });
    const agent = makeAgent();
    const arbiter = makeArbiter();
    feature.setCallArbiter(arbiter);

    assert.equal(feature.getStatus().armed, true);
    assert.equal(feature.observeUsage({ inputTokens: 500 }, agent), false);
    assert.equal(feature.observeUsage({ inputTokens: 800 }, agent), true);

    const status = feature.getStatus();
    assert.equal(status.armed, false);
    assert.equal(status.trip?.inputTokens, 800);
    assert.equal(status.trip?.thresholdTokens, 800);
    // 过界瞬间不打断：排队消息立即退回，interrupt 等到 StepFinish（本轮已发出的
    // 工具调用执行完、结果落地后）才触发。
    assert.deepEqual(agent.calls, []);
    assert.equal(arbiter.calls.length, 1);

    assert.equal(await feature.tripAtStepFinish({ toolCallsCount: 1 }), 'continue');
    assert.deepEqual(agent.calls, ['interrupt']);

    // fuse consumed: crossing again does nothing
    assert.equal(feature.observeUsage({ inputTokens: 900 }, agent), false);
    assert.equal(await feature.tripAtStepFinish({ toolCallsCount: 1 }), 'continue');
    assert.deepEqual(agent.calls, ['interrupt']);
  });

  it('re-arms via setArmed and trips again', async () => {
    const feature = new ContextGuardFeature({ contextLength: 1000, compressRatio: 80 });
    const agent = makeAgent();
    feature.observeUsage({ inputTokens: 800 }, agent);
    await feature.tripAtStepFinish({});
    assert.equal(feature.getStatus().armed, false);

    feature.setArmed(true);
    assert.equal(feature.getStatus().armed, true);
    assert.equal(feature.observeUsage({ inputTokens: 850 }, agent), true);
    assert.equal(await feature.tripAtStepFinish({}), 'continue');
    assert.deepEqual(agent.calls, ['interrupt', 'interrupt']);
  });

  it('resets a stale pending interrupt on the next CallStart', async () => {
    const feature = new ContextGuardFeature({ contextLength: 1000, compressRatio: 80 });
    const agent = makeAgent();
    feature.observeUsage({ inputTokens: 800 }, agent);
    // 未走到 StepFinish 本轮就异常终结：下一次 CallStart 不应补发过期打断
    await feature.installUsageGuard({ agent });
    assert.equal(await feature.tripAtStepFinish({}), 'continue');
    assert.deepEqual(agent.calls, []);
  });

  it('enabled:false starts disarmed', () => {
    const feature = new ContextGuardFeature({ enabled: false, contextLength: 1000, compressRatio: 80 });
    const agent = makeAgent();
    assert.equal(feature.getStatus().armed, false);
    assert.equal(feature.observeUsage({ inputTokens: 900 }, agent), false);
  });

  it('recomputes the threshold when the model changes', async () => {
    const feature = new ContextGuardFeature({ contextLength: 1000, compressRatio: 80 });
    const agent = makeAgent();
    assert.equal(feature.observeUsage({ inputTokens: 800 }, agent), true);

    feature.setArmed(true);
    feature.updateThreshold(10_000, 80);
    assert.equal(feature.getStatus().thresholdTokens, 8000);
    assert.equal(feature.observeUsage({ inputTokens: 800 }, agent), false);
    assert.equal(feature.observeUsage({ inputTokens: 8000 }, agent), true);
  });

  it('re-syncs the threshold from live LLM meta on every CallStart', async () => {
    // 挂载注入值来自 runtime 启动预设（1000×80%=800），但会话实际 LLM 是
    // 512×50%=256 —— 首个 CallStart 就应以活元数据为准（覆盖首轮调用前
    // 热切换模型、启动预设与会话模型不一致两类漂移）。
    const feature = new ContextGuardFeature({ contextLength: 1000, compressRatio: 80 });
    const agent = {
      ...makeAgent(),
      getLLMMeta: () => ({ contextLength: 512, compressRatio: 50 }),
    };
    await feature.installUsageGuard({ agent });
    assert.equal(feature.getStatus().thresholdTokens, 256);
    assert.equal(feature.observeUsage({ inputTokens: 300 }, agent), true);

    // swap 到大模型：下一个 CallStart 重算，阈值不再冻结在旧模型
    feature.setArmed(true);
    agent.getLLMMeta = () => ({ contextLength: 10_000, compressRatio: 80 });
    await feature.installUsageGuard({ agent });
    assert.equal(feature.getStatus().thresholdTokens, 8000);
    assert.equal(feature.observeUsage({ inputTokens: 300 }, agent), false);
  });

  it('keeps the injected threshold when live meta lacks contextLength', async () => {
    const feature = new ContextGuardFeature({ contextLength: 1000, compressRatio: 80 });
    const agent = { ...makeAgent(), getLLMMeta: () => ({}) };
    await feature.installUsageGuard({ agent });
    assert.equal(feature.getStatus().thresholdTokens, 800);
  });

  it('re-installs the usage observer on mid-turn LLM swap (no CallStart until the call ends)', async () => {
    const feature = new ContextGuardFeature({ contextLength: 1000, compressRatio: 80 });
    const agent = { ...makeAgent(), getLLMMeta: () => ({ contextLength: 1000, compressRatio: 80 }) };
    await feature.installUsageGuard({ agent });
    // mid-term swap：框架 setLLM 替换整个 llm 引用后同步触发 onLLMSwap
    const oldLLM = agent.llm;
    agent.llm = { chat: async () => ({ content: 'ok', usage: { inputTokens: 900 } }) };
    feature.onLLMSwap(agent.llm, oldLLM);
    // swap 后没有新的 CallStart（单轮 ReAct 会话），新 llm 的过界响应仍要被观察到
    await agent.llm.chat();
    assert.equal(feature.getStatus().armed, false);
    assert.equal(feature.getStatus().trip?.inputTokens, 900);
  });

  it('exposes the manifest for the runtime config panel', () => {
    const feature = new ContextGuardFeature({});
    const manifest = feature.getFeatureManifest();
    const enabled = manifest.settings.properties.enabled as { type: string; default: boolean };
    assert.equal(enabled.type, 'boolean');
    assert.equal(enabled.default, true);
  });
});

describe('ContextRotationTriggerFeature (automation shell)', () => {
  let originalFetch: any;
  let posted: Array<{ url: string, body: any }>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    posted = [];
    globalThis.fetch = (async (url: any, init: any) => {
      posted.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({}) };
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fires once: interrupt deferred to step finish, report deferred to call finish', async () => {
    const feature = new ContextRotationTriggerFeature({
      contextLength: 1000,
      compressRatio: 80,
      agentId: 'coder',
      sessionId: 's1',
      serverOrigin: 'http://127.0.0.1:1420',
    });
    const agent = makeAgent();
    const arbiter = makeArbiter();
    feature.setCallArbiter(arbiter);

    assert.equal(feature.observeUsage({ inputTokens: 900 }, agent), true);
    // 过界瞬间：只退回排队消息，不打断、不上报
    assert.deepEqual(agent.calls, []);
    assert.equal(arbiter.calls.length, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(posted.length, 0);

    // 工具结果落地（StepFinish）→ 打断本轮
    assert.equal(await feature.tripAtStepFinish({ toolCallsCount: 1 }), 'continue');
    assert.deepEqual(agent.calls, ['interrupt']);

    // 本轮完全结束（CallFinish）→ 上报接力事件
    await feature.reportRotationOnCallFinish({});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(posted.length, 1);
    assert.equal(posted[0].url, 'http://127.0.0.1:1420/protoclaw/context_guard_event');
    assert.equal(posted[0].body.agentId, 'coder');
    assert.equal(posted[0].body.contextGuard.blocked, true);

    // one-shot lock: no further triggers, interrupts, or reports
    assert.equal(feature.observeUsage({ inputTokens: 950 }, agent), false);
    assert.equal(await feature.tripAtStepFinish({}), 'continue');
    assert.deepEqual(agent.calls, ['interrupt']);
    await feature.reportRotationOnCallFinish({});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(posted.length, 1);
  });

  it('re-syncs the threshold from live LLM meta on CallStart', async () => {
    const feature = new ContextRotationTriggerFeature({ contextLength: 1000, compressRatio: 80 });
    const agent = { ...makeAgent(), getLLMMeta: () => ({ contextLength: 512, compressRatio: 50 }) };
    await feature.installUsageObserver({ agent });
    assert.equal(feature.observeUsage({ inputTokens: 300 }, agent), true);
  });

  it('re-installs the usage observer on mid-turn LLM swap (single-call ReAct sessions)', async () => {
    const feature = new ContextRotationTriggerFeature({ contextLength: 1000, compressRatio: 80 });
    const agent = { ...makeAgent(), getLLMMeta: () => ({ contextLength: 1000, compressRatio: 80 }) };
    const arbiter = makeArbiter();
    feature.setCallArbiter(arbiter);
    await feature.installUsageObserver({ agent });
    // mid-turn swap：替换整个 llm 引用后同步触发 onLLMSwap，observer 必须重装
    const oldLLM = agent.llm;
    agent.llm = { chat: async () => ({ content: 'ok', usage: { inputTokens: 900 } }) };
    feature.onLLMSwap(agent.llm, oldLLM);
    await agent.llm.chat();
    // 过界被观察到：排队消息立即退回，打断延后到 StepFinish
    assert.equal(arbiter.calls.length, 1);
    assert.equal(await feature.tripAtStepFinish({ toolCallsCount: 1 }), 'continue');
    assert.deepEqual(agent.calls, ['interrupt']);
  });

  it('invokes the local onTrip callback at call finish without breaking the HTTP report', async () => {
    const trips: Array<{ inputTokens: number, reason: string }> = [];
    const feature = new ContextRotationTriggerFeature({
      contextLength: 1000,
      compressRatio: 80,
      agentId: 'plain-agent',
      sessionId: 's1',
      serverOrigin: 'http://127.0.0.1:1420',
      onTrip: (trip) => {
        trips.push({ inputTokens: trip.inputTokens, reason: trip.reason });
      },
    });
    const agent = makeAgent();
    feature.setCallArbiter(makeArbiter());

    assert.equal(feature.observeUsage({ inputTokens: 900 }, agent), true);
    assert.equal(trips.length, 0);
    await feature.reportRotationOnCallFinish({});
    assert.equal(trips.length, 1);
    assert.equal(trips[0].inputTokens, 900);
    assert.match(trips[0].reason, /Context threshold reached/);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(posted.length, 1);

    // 回调抛错不影响一次性锁与 HTTP 上报
    const throwing = new ContextRotationTriggerFeature({
      contextLength: 1000,
      compressRatio: 80,
      agentId: 'plain-agent',
      sessionId: 's1',
      serverOrigin: 'http://127.0.0.1:1420',
      onTrip: () => {
        throw new Error('host failure');
      },
    });
    const agent2 = makeAgent();
    assert.equal(throwing.observeUsage({ inputTokens: 900 }, agent2), true);
    await throwing.reportRotationOnCallFinish({});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(posted.length, 2);
  });
});
