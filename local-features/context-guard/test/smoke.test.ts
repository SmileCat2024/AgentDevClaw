import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ContextGuardFeature, ContextRotationTriggerFeature } from '../src/index.js';

function makeAgent() {
  const calls: string[] = [];
  return {
    calls,
    llm: { chat: async () => ({ content: 'ok' }) },
    interrupt(cause?: string) { calls.push(cause ? `interrupt:${cause}` : 'interrupt'); },
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

  it('trips at the threshold, interrupting at step finish (after tool results land); mode stays on', async () => {
    const feature = new ContextGuardFeature({ contextLength: 1000, compressRatio: 80 });
    const agent = makeAgent();
    const arbiter = makeArbiter();
    feature.setCallArbiter(arbiter);

    assert.equal(feature.getStatus().mode, 'interrupt');
    assert.equal(feature.observeUsage({ inputTokens: 500 }, agent), false);
    assert.equal(feature.observeUsage({ inputTokens: 800 }, agent), true);

    const status = feature.getStatus();
    // 触发不消耗 mode：badge 恒显示用户选择，只有用户点击才切换
    assert.equal(status.mode, 'interrupt');
    assert.equal(status.trip?.inputTokens, 800);
    assert.equal(status.trip?.thresholdTokens, 800);
    // 过界瞬间不打断：排队消息立即退回，interrupt 等到 StepFinish（本轮已发出的
    // 工具调用执行完、结果落地后）才触发。
    assert.deepEqual(agent.calls, []);
    assert.equal(arbiter.calls.length, 1);

    assert.equal(await feature.tripAtStepFinish({ toolCallsCount: 1 }), 'continue');
    assert.deepEqual(agent.calls, ['interrupt']);

    // 同一越界事件已尽职：再次过界观测不重复触发（等待人工或回落）
    assert.equal(feature.observeUsage({ inputTokens: 900 }, agent), false);
    assert.equal(await feature.tripAtStepFinish({ toolCallsCount: 1 }), 'continue');
    assert.deepEqual(agent.calls, ['interrupt']);
    // interrupt 态不上报接续事件
    await feature.reportRotationOnCallFinish({});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(posted.length, 0);
  });

  it('re-trips only after usage falls back below the threshold (new overage episode)', async () => {
    const feature = new ContextGuardFeature({ contextLength: 1000, compressRatio: 80 });
    const agent = makeAgent();
    const arbiter = makeArbiter();
    feature.setCallArbiter(arbiter);

    feature.observeUsage({ inputTokens: 800 }, agent);
    await feature.tripAtStepFinish({});
    // 人工输入 = 批准继续：解除拦截
    assert.equal(await feature.admitAfterTrip({ options: { kind: 'user' } }), 'continue');
    // 批准后本次越界期间维持不拦截：继续越界不再触发
    assert.equal(feature.observeUsage({ inputTokens: 900 }, agent), false);
    // 无读数的观测没有新事实，不得复位闩锁：随后的越界观测仍不触发
    assert.equal(feature.observeUsage({}, agent), false);
    assert.equal(feature.observeUsage({ inputTokens: 950 }, agent), false);

    // 用量回落阈值下方：本次越界事件结束
    assert.equal(feature.observeUsage({ inputTokens: 400 }, agent), false);
    // 新的越界事件重新触发完整尽职
    assert.equal(feature.observeUsage({ inputTokens: 850 }, agent), true);
    await feature.tripAtStepFinish({});
    assert.deepEqual(agent.calls, ['interrupt', 'interrupt']);
    // 新一轮尽职包含拦截机器唤醒
    assert.equal(await feature.admitAfterTrip({ options: { kind: 'reminder' } }), 'deny');
  });

  it('manual toggle stays authoritative: off stops everything, interrupt re-arms even while still over', async () => {
    const feature = new ContextGuardFeature({ contextLength: 1000, compressRatio: 80 });
    const agent = makeAgent();

    feature.observeUsage({ inputTokens: 800 }, agent);
    // 手动关闭 = 全停：解除拦截，且不再触发
    feature.setMode('off');
    assert.equal(feature.getStatus().mode, 'off');
    assert.equal(await feature.admitAfterTrip({ options: { kind: 'reminder' } }), 'continue');
    assert.equal(feature.observeUsage({ inputTokens: 900 }, agent), false);

    // 手动切回自动打断 = 重新武装：仍越界时下一次过界观测立即再触发
    feature.setMode('interrupt');
    assert.equal(feature.getStatus().mode, 'interrupt');
    assert.equal(feature.observeUsage({ inputTokens: 850 }, agent), true);
    await feature.tripAtStepFinish({});
    assert.deepEqual(agent.calls, ['interrupt']);
  });

  it('holds reminders after trip and releases the hold on human input', async () => {
    const feature = new ContextGuardFeature({ contextLength: 1000, compressRatio: 80 });
    const agent = makeAgent();
    feature.observeUsage({ inputTokens: 800 }, agent);

    assert.equal(await feature.admitAfterTrip({ options: { kind: 'reminder' } }), 'deny');
    // 触发不改变 mode：badge 仍显示自动打断
    assert.equal(feature.getStatus().mode, 'interrupt');

    assert.equal(await feature.admitAfterTrip({ options: { kind: 'user' } }), 'continue');
    assert.equal(await feature.admitAfterTrip({ options: { kind: 'reminder' } }), 'continue');

    // 手动重新武装（复位事件闩锁）后再越界，重新进入尽职拦截
    feature.setMode('interrupt');
    feature.observeUsage({ inputTokens: 900 }, agent);
    assert.equal(await feature.admitAfterTrip({ options: { kind: 'reminder' } }), 'deny');
  });

  it('rotate mode: interrupt at step finish, report at call finish with session strategy; hold covers the window', async () => {
    const feature = new ContextGuardFeature({
      mode: 'rotate',
      allowRotation: true,
      strategy: 'summary',
      contextLength: 1000,
      compressRatio: 80,
      agentId: 'programming-helper',
      sessionId: 's1',
      serverOrigin: 'http://127.0.0.1:1420',
    });
    const agent = makeAgent();
    const arbiter = makeArbiter();
    feature.setCallArbiter(arbiter);

    assert.equal(feature.observeUsage({ inputTokens: 800 }, agent), true);
    // 接力窗口内机器唤醒仍被拦截（接力成功则 runtime 被换代，拦截自然终结）
    assert.equal(await feature.admitAfterTrip({ options: { kind: 'reminder' } }), 'deny');
    // 过界瞬间不上报：等本轮完全结束
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(posted.length, 0);

    assert.equal(await feature.tripAtStepFinish({ toolCallsCount: 1 }), 'continue');
    // rotate 态打断申报接续原因：轮次终态携带 interruptedBy 供通知出口分类
    // （interrupt 态是等待人工的暂停，不申报——见首个用例的 ['interrupt'] 断言）
    assert.deepEqual(agent.calls, ['interrupt:context_rotation']);

    await feature.reportRotationOnCallFinish({});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(posted.length, 1);
    assert.equal(posted[0].url, 'http://127.0.0.1:1420/protoclaw/context_guard_event');
    assert.equal(posted[0].body.agentId, 'programming-helper');
    // 会话级策略随事件载荷送达：thread-rotation 有载荷用载荷
    assert.equal(posted[0].body.strategy, 'summary');
    assert.equal(posted[0].body.contextGuard.blocked, true);

    // 同一越界事件只尽职一次：不再触发、不再上报
    assert.equal(feature.observeUsage({ inputTokens: 900 }, agent), false);
    await feature.reportRotationOnCallFinish({});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(posted.length, 1);
  });

  it('rotate mode: switching modes mid-flight clears the pending report', async () => {
    const feature = new ContextGuardFeature({
      mode: 'rotate',
      allowRotation: true,
      contextLength: 1000,
      compressRatio: 80,
      agentId: 'programming-helper',
      sessionId: 's1',
      serverOrigin: 'http://127.0.0.1:1420',
    });
    const agent = makeAgent();
    feature.setCallArbiter(makeArbiter());
    feature.observeUsage({ inputTokens: 800 }, agent);
    // 触发后、上报前用户切回自动打断：模式切换即复位尽职状态，不再上报
    feature.setMode('interrupt');
    await feature.reportRotationOnCallFinish({});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(posted.length, 0);
  });

  it('rotate requires assembly capability: clamped at construction, rejected on control, clamped on restore', async () => {
    const feature = new ContextGuardFeature({ mode: 'rotate', contextLength: 1000, compressRatio: 80 });
    assert.equal(feature.getStatus().mode, 'interrupt');
    assert.equal(feature.getStatus().allowRotation, false);

    const denied = await feature.onHostRequest('set', { mode: 'rotate' });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'rotation_unavailable');

    // continuity 恢复同样被能力钳制（能力是装配事实，快照不能越权）
    await feature.restoreState({ schemaVersion: 1, mode: 'rotate', strategy: 'summary' });
    assert.equal(feature.getStatus().mode, 'interrupt');
    assert.equal(feature.getStatus().strategy, 'summary');
  });

  it('continuity whitelist: only mode and strategy migrate (capture/restore)', async () => {
    const feature = new ContextGuardFeature({
      allowRotation: true,
      contextLength: 1000,
      compressRatio: 80,
    });
    const agent = makeAgent();
    feature.setCallArbiter(makeArbiter());
    await feature.onHostRequest('set', { strategy: 'summary' });
    feature.observeUsage({ inputTokens: 800 }, agent); // trip 发生：尽职状态进入迁移禁区
    await feature.onHostRequest('set', { mode: 'rotate', strategy: 'trim' });

    const snapshot = feature.captureState() as Record<string, unknown>;
    // declareContinuity 包装会附加 __agentdev_continuity__ 描述符（continuity
    // 信封，非 feature 状态）；白名单断言只看语义字段：mode/strategy 迁移，
    // 触发事实（trip）与尽职状态不进快照。
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.mode, 'rotate');
    assert.equal(snapshot.strategy, 'trim');
    assert.equal('trip' in snapshot, false);

    // successor：restore 只入账 mode/strategy，尽职状态天然全新一轮
    const successor = new ContextGuardFeature({ allowRotation: true, contextLength: 1000, compressRatio: 80 });
    await successor.restoreState(snapshot);
    assert.equal(successor.getStatus().mode, 'rotate');
    assert.equal(successor.getStatus().strategy, 'trim');
    assert.equal(successor.getStatus().trip, null);
    // 新 runtime 的越界观测会重新触发（闩锁未迁移）
    assert.equal(successor.observeUsage({ inputTokens: 900 }, makeAgent()), true);

    // rollback 保留当前值（ADR-0034 决策 2）
    const rollbackTarget = new ContextGuardFeature({ allowRotation: true, contextLength: 1000, compressRatio: 80 });
    rollbackTarget.setMode('off');
    await rollbackTarget.restoreState({ schemaVersion: 1, mode: 'rotate', strategy: 'summary' }, { origin: { kind: 'rollback' } });
    assert.equal(rollbackTarget.getStatus().mode, 'off');

    // 坏快照防御：非法字段保持当前值，不抛错
    const defensive = new ContextGuardFeature({ allowRotation: true });
    await defensive.restoreState({ mode: 'nonsense', strategy: 42 });
    assert.equal(defensive.getStatus().mode, 'rotate');
    assert.equal(defensive.getStatus().strategy, 'adaptive');
  });

  it('legacy enabled boolean maps to modes; explicit mode wins; default follows assembly capability', () => {
    assert.equal(new ContextGuardFeature({ enabled: false }).getStatus().mode, 'off');
    assert.equal(new ContextGuardFeature({ enabled: true }).getStatus().mode, 'interrupt');
    assert.equal(new ContextGuardFeature({}).getStatus().mode, 'interrupt');
    assert.equal(new ContextGuardFeature({ enabled: false, mode: 'interrupt' }).getStatus().mode, 'interrupt');
    assert.equal(new ContextGuardFeature({ mode: 'rotate', allowRotation: true }).getStatus().mode, 'rotate');
    // 缺省档随装配能力：线程宿主（allowRotation）新对话默认自动接续，
    // 旧布尔 enabled: true 在线程宿主语境同样落到 rotate（开守卫即接续）
    assert.equal(new ContextGuardFeature({ allowRotation: true }).getStatus().mode, 'rotate');
    assert.equal(new ContextGuardFeature({ allowRotation: true, enabled: true }).getStatus().mode, 'rotate');
    assert.equal(new ContextGuardFeature({ allowRotation: true, enabled: false }).getStatus().mode, 'off');
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
    assert.equal(feature.getStatus().mode, 'off');
    assert.equal(feature.observeUsage({ inputTokens: 900 }, agent), false);
  });

  it('recomputes the threshold when the model changes', async () => {
    const feature = new ContextGuardFeature({ contextLength: 1000, compressRatio: 80 });
    const agent = makeAgent();
    assert.equal(feature.observeUsage({ inputTokens: 800 }, agent), true);

    feature.setMode('interrupt');
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
    feature.setMode('interrupt');
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
    // 触发被观察到；mode 保持用户选择
    assert.equal(feature.getStatus().mode, 'interrupt');
    assert.equal(feature.getStatus().trip?.inputTokens, 900);
  });

  it('exposes the manifest for the runtime config panel (capability-aware select)', () => {
    const plain = new ContextGuardFeature({}).getFeatureManifest();
    const plainMode = plain.settings.properties.mode as {
      type: string; default: string; options: Array<{ value: string }>;
    };
    assert.equal(plainMode.type, 'select');
    assert.equal(plainMode.default, 'interrupt');
    assert.deepEqual(plainMode.options.map((option) => option.value), ['off', 'interrupt']);
    assert.equal(plain.settings.properties.strategy, undefined);

    const rotating = new ContextGuardFeature({ allowRotation: true }).getFeatureManifest();
    const rotatingMode = rotating.settings.properties.mode as {
      default: string; options: Array<{ value: string }>;
    };
    assert.equal(rotatingMode.default, 'rotate');
    assert.deepEqual(rotatingMode.options.map((option) => option.value), ['off', 'interrupt', 'rotate']);
    const strategy = rotating.settings.properties.strategy as {
      type: string; default: string; options: Array<{ value: string }>;
      showWhen: { property: string; values: string[] };
    };
    assert.equal(strategy.type, 'select');
    assert.equal(strategy.default, 'adaptive');
    assert.deepEqual(strategy.options.map((option) => option.value), ['adaptive', 'trim', 'summary']);
    assert.deepEqual(strategy.showWhen, { property: 'mode', values: ['rotate'] });
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

    // 工具结果落地（StepFinish）→ 打断本轮（申报接续原因，供通知出口分类）
    assert.equal(await feature.tripAtStepFinish({ toolCallsCount: 1 }), 'continue');
    assert.deepEqual(agent.calls, ['interrupt:context_rotation']);

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
    assert.deepEqual(agent.calls, ['interrupt:context_rotation']);
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
    assert.deepEqual(agent.calls, ['interrupt:context_rotation']);
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

describe('onHostRequest surface (feature-comms)', () => {
  it('status reports live mode/strategy/trip state', async () => {
    const feature = new ContextGuardFeature({ contextLength: 1000, compressRatio: 80 });
    const agent = makeAgent();
    feature.observeUsage({ inputTokens: 900 }, agent); // 越界触发，mode 保持用户选择
    const result = await feature.onHostRequest('status', {});
    assert.equal(result.ok, true);
    const status = result.status as {
      mode: string; strategy: string; allowRotation: boolean; trip: { inputTokens: number } | null;
    };
    assert.equal(status.mode, 'interrupt');
    assert.equal(status.strategy, 'adaptive');
    assert.equal(status.allowRotation, false);
    assert.equal(status.trip?.inputTokens, 900);
  });

  it('set switches mode and strategy, reports the resulting state, and resets duty state', async () => {
    const feature = new ContextGuardFeature({
      allowRotation: true,
      contextLength: 1000,
      compressRatio: 80,
    });
    const agent = makeAgent();
    feature.observeUsage({ inputTokens: 900 }, agent); // 触发（mode 不变，事件闩锁已置）

    const rotate = await feature.onHostRequest('set', { mode: 'rotate', strategy: 'summary' });
    assert.equal(rotate.ok, true);
    assert.equal(feature.getStatus().mode, 'rotate');
    assert.equal(feature.getStatus().strategy, 'summary');
    // 手动切换复位事件闩锁：仍越界时下一次过界观测会再触发
    assert.equal(feature.observeUsage({ inputTokens: 950 }, agent), true);

    const off = await feature.onHostRequest('set', { mode: 'off' });
    assert.equal(off.ok, true);
    assert.equal(feature.getStatus().mode, 'off');
    assert.equal(feature.observeUsage({ inputTokens: 950 }, agent), false);
  });

  it('rejects invalid payloads and unknown request types without changing state', async () => {
    const feature = new ContextGuardFeature({ allowRotation: true, contextLength: 1000, compressRatio: 80 });
    for (const payload of [{}, { mode: 'yes' }, { strategy: 'fast' }, { mode: null }]) {
      const result = await feature.onHostRequest('set', payload);
      assert.equal(result.ok, false, JSON.stringify(payload));
      assert.equal(result.code, 'invalid_payload');
    }
    assert.equal(feature.getStatus().mode, 'rotate', '非法载荷不得改变模式');
    const unknown = await feature.onHostRequest('nope', {});
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, 'operation_unavailable');
  });
});
