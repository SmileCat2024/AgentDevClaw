/**
 * Tests for public/src/modules/sse-client.js
 *
 * Covers（docs/sse-migration-bcd-preparation.md §5.1/§5.5/§5.6）：
 *   - URL 开关解析（?sse=0 / ?sse=1 / 缺省 auto）
 *   - hello 激活与 resynced → forceFullPollOnce
 *   - choiceAlerts toast 双入口与 _seenChoiceAlertIds 共享去重
 *   - 事件分发焦点/非焦点路由（notification/todo/overview/input-requests/
 *     queued-inputs/messages/connection）
 *   - 熔断（连续 3 次 CLOSED → 冷却不重连）与 401 探测停止
 *   - 30s 静默看门狗（forceFullPollOnce + 连接死降级）
 *   - 排队气泡乐观对账 reconcileQueuedTexts（确认 / TTL 过期 / 保留）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * mock EventSource：记录实例与监听器，测试驱动事件注入与状态翻转。
 * 静态 readyState 常量与浏览器规范一致。
 */
class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = MockEventSource.CONNECTING;
    this.listeners = new Map();
    this.onerror = null;
    this.closed = false;
    MockEventSource.instances.push(this);
  }

  addEventListener(kind, fn) {
    if (!this.listeners.has(kind)) this.listeners.set(kind, []);
    this.listeners.get(kind).push(fn);
  }

  close() {
    this.closed = true;
    this.readyState = MockEventSource.CLOSED;
  }

  /** 测试辅助：以事件帧驱动监听器 */
  emit(kind, data) {
    this.readyState = MockEventSource.OPEN;
    for (const fn of this.listeners.get(kind) || []) {
      fn({ data: JSON.stringify(data) });
    }
  }

  /** 测试辅助：触发 onerror */
  fail(readyStateAfter = MockEventSource.CLOSED) {
    this.readyState = readyStateAfter;
    if (this.onerror) this.onerror();
  }
}

/**
 * 构建加载了 sse-client.js 的沙箱。默认 window.__clawAuthReady 永不
 * resolve，阻止模块顶层的自动 boot；测试按需手动调用 bootSseClient()。
 */
function loadSseClient(overrides = {}) {
  const calls = {
    updateNotificationStatus: [],
    applyAgentCallStateFromNotification: [],
    commitMetadataUpdate: [],
    runMessagesProbeCycle: [],
    applyQueuedInputsTexts: [],
    setConnectionStatus: [],
    loadAgents: [],
    forceFullPoll: 0,
    toasts: [],
    foregroundSyncs: 0,
    tryNotifyInputRequest: [],
  };
  let switchEpoch = 1;
  const ctx = createFrontendSandbox({
    EventSource: MockEventSource,
    // 沙箱 base 缺 URLSearchParams（浏览器有）；sseModeFromUrl 依赖它解析 ?sse=
    URLSearchParams,
    currentRuntimeAgentId: 'rt-focus',
    currentLanguage: 'zh',
    allAgents: [],
    _seenChoiceAlertIds: new Set(),
    ClawToast: { show: (t) => calls.toasts.push(t) },
    _syncForegroundState: () => { calls.foregroundSyncs += 1; },
    updateNotificationStatus: (p) => calls.updateNotificationStatus.push(p),
    applyAgentCallStateFromNotification: (id, p) => calls.applyAgentCallStateFromNotification.push({ id, p }),
    commitMetadataUpdate: (token, parts) => calls.commitMetadataUpdate.push({ token, parts }),
    runMessagesProbeCycle: async (token, probe) => {
      calls.runMessagesProbeCycle.push({ token, probe });
      return 'committed';
    },
    applyQueuedInputsTexts: (id, texts, count) => calls.applyQueuedInputsTexts.push({ id, texts, count }),
    setConnectionStatus: (c) => calls.setConnectionStatus.push(c),
    loadAgents: async () => { calls.loadAgents.push(1); },
    getRuntimeRecord: () => null,
    captureSessionViewToken: (runtimeId) => ({ runtimeId: String(runtimeId || '').trim(), switchEpoch }),
    isSessionViewTokenCurrent: (t) => t && t.switchEpoch === switchEpoch,
    ...overrides,
  });
  ctx.window.__clawAuthReady = new Promise(() => {});
  ctx.window.ClawFW = ctx.window.ClawFW || {};
  ctx.window.ClawFW.forceFullPollOnce = () => { calls.forceFullPoll += 1; };
  // MockEventSource.instances 是跨测试的模块级静态——每个沙箱重置
  MockEventSource.instances.length = 0;
  ctx.loadSource('public/src/modules/sse-client.js');
  return { ctx, calls, bumpEpoch: () => { switchEpoch += 1; } };
}

function latestSource() {
  return MockEventSource.instances[MockEventSource.instances.length - 1] || null;
}

describe('sse-client: URL 开关', () => {
  it('?sse=0 禁用：boot 不建连，isSseActive 恒 false', () => {
    const { ctx } = loadSseClient();
    ctx.window.location = { search: '?sse=0', href: 'http://x/?sse=0' };
    ctx.location = ctx.window.location;
    ctx.run('bootSseClient()');
    assert.equal(MockEventSource.instances.length, 0);
    assert.equal(ctx.run('isSseActive()'), false);
  });

  it('缺省 auto：boot 建连，hello 后激活', () => {
    const { ctx } = loadSseClient();
    ctx.window.location = { search: '', href: 'http://x/' };
    ctx.location = ctx.window.location;
    ctx.run('bootSseClient()');
    const src = latestSource();
    assert.ok(src);
    assert.equal(src.url, '/protoclaw/events');
    assert.equal(ctx.run('isSseActive()'), false);
    src.emit('hello', { hello: true });
    assert.equal(ctx.run('isSseActive()'), true);
  });
});

describe('sse-client: hello 帧', () => {
  it('resynced 触发一次全量对账', () => {
    const { ctx, calls } = loadSseClient();
    ctx.run('bootSseClient()');
    latestSource().emit('hello', { hello: true, resynced: true });
    assert.equal(calls.forceFullPoll, 1);
  });

  it('choiceAlerts 首连扫描出 toast，且与 _seenChoiceAlertIds 共享去重', () => {
    const { ctx, calls } = loadSseClient();
    ctx.run('bootSseClient()');
    latestSource().emit('hello', {
      hello: true,
      choiceAlerts: [{ requestId: 'req-1', agentId: 'rt-other', agentName: 'Other' }],
    });
    assert.equal(calls.toasts.length, 1);
    assert.equal(calls.toasts[0].id, 'choice-alert-req-1');
    // 同一 requestId 不再 toast（事件再发也跳过）
    latestSource().emit('input-requests', {
      kind: 'input-requests', agentId: 'rt-other',
      data: [{ requestId: 'req-1', mode: 'choices' }],
    });
    assert.equal(calls.toasts.length, 1);
  });
});

describe('sse-client: 事件分发焦点路由', () => {
  function activeClient() {
    const bundle = loadSseClient();
    bundle.ctx.run('bootSseClient()');
    latestSource().emit('hello', { hello: true });
    return bundle;
  }

  it('notification 焦点 → updateNotificationStatus；非焦点 → applyAgentCallStateFromNotification', () => {
    const { calls } = activeClient();
    const payload = { callActive: true, state: null };
    latestSource().emit('notification', { kind: 'notification', agentId: 'rt-focus', data: payload });
    assert.equal(calls.updateNotificationStatus.length, 1);
    // dispatch 经 JSON 往返（事件帧 data），断言内容而非引用
    assert.deepEqual(calls.updateNotificationStatus[0], payload);
    assert.equal(calls.applyAgentCallStateFromNotification.length, 0);
    // 事件到达顺带刷新前台时钟（§5.4 时钟源钩子）
    assert.ok(calls.foregroundSyncs >= 1);

    latestSource().emit('notification', { kind: 'notification', agentId: 'rt-other', data: payload });
    assert.equal(calls.updateNotificationStatus.length, 1);
    assert.equal(calls.applyAgentCallStateFromNotification.length, 1);
    assert.equal(calls.applyAgentCallStateFromNotification[0].id, 'rt-other');
  });

  it('todo / overview 事件只消费焦点，走 commitMetadataUpdate', () => {
    const { calls } = activeClient();
    latestSource().emit('todo', { kind: 'todo', agentId: 'rt-focus', data: { tasks: [] } });
    latestSource().emit('overview', { kind: 'overview', agentId: 'rt-focus', data: { usage: 1 } });
    latestSource().emit('todo', { kind: 'todo', agentId: 'rt-other', data: { tasks: [] } });
    assert.equal(calls.commitMetadataUpdate.length, 2);
    assert.deepEqual(Object.keys(calls.commitMetadataUpdate[0].parts), ['todoRaw']);
    assert.deepEqual(Object.keys(calls.commitMetadataUpdate[1].parts), ['overviewJson']);
  });

  it('input-requests 焦点 → commitMetadataUpdate + 通知；非焦点 → choice toast', () => {
    const { calls } = activeClient();
    latestSource().emit('input-requests', {
      kind: 'input-requests', agentId: 'rt-focus',
      data: [{ requestId: 'req-f', mode: 'choices' }],
    });
    assert.equal(calls.commitMetadataUpdate.length, 1);
    assert.equal(calls.tryNotifyInputRequest.length, 0); // stub 未接线时不炸
    latestSource().emit('input-requests', {
      kind: 'input-requests', agentId: 'rt-other',
      data: [{ requestId: 'req-x', mode: 'choices' }],
    });
    assert.equal(calls.toasts.length, 1);
    assert.equal(calls.toasts[0].id, 'choice-alert-req-x');
  });

  it('queued-inputs 事件更新快照缓存并消费文本', () => {
    const { ctx, calls } = loadSseClient();
    ctx.run('bootSseClient()');
    latestSource().emit('hello', { hello: true });
    latestSource().emit('queued-inputs', {
      kind: 'queued-inputs', agentId: 'rt-focus',
      data: [{ id: 'q-1', text: '排队A' }],
    });
    assert.equal(calls.applyQueuedInputsTexts.length, 1);
    // vm 数组原型属沙箱 realm，JSON 往返后比较
    assert.deepEqual(JSON.parse(JSON.stringify(calls.applyQueuedInputsTexts[0].texts)), ['排队A']);
    const snap = ctx.run('window.ClawFW.SseClient.getLastQueuedSnapshot("rt-focus")');
    assert.equal(snap.items.length, 1);
    // runtime 不匹配时无缓存
    assert.equal(ctx.run('window.ClawFW.SseClient.getLastQueuedSnapshot("rt-other")'), null);
  });

  it('messages 事件携带 probe 走 runMessagesProbeCycle（仅焦点）', () => {
    const { calls } = activeClient();
    const probe = { seq: 7, count: 3, changeKind: 'append', sinceIndex: 0, fakeFullBytes: 128 };
    latestSource().emit('messages', { kind: 'messages', agentId: 'rt-other', probe });
    assert.equal(calls.runMessagesProbeCycle.length, 0);
    latestSource().emit('messages', { kind: 'messages', agentId: 'rt-focus', probe });
    assert.equal(calls.runMessagesProbeCycle.length, 1);
    assert.equal(calls.runMessagesProbeCycle[0].probe.seq, 7);
    assert.equal(calls.runMessagesProbeCycle[0].token.runtimeId, 'rt-focus');
  });

  it('connection 事件 → setConnectionStatus + loadAgents；reconnected → 全量对账', () => {
    const { calls } = activeClient();
    latestSource().emit('connection', { kind: 'connection', agentId: 'rt-focus', connected: false });
    assert.deepEqual(calls.setConnectionStatus, [false]);
    assert.equal(calls.loadAgents.length, 1);
    latestSource().emit('connection', { kind: 'connection', agentId: 'rt-1', connected: true, reconnected: true });
    assert.equal(calls.forceFullPoll, 1);
    assert.equal(calls.loadAgents.length, 2);
  });

  it('shutdown 帧立即降级（isSseActive=false）', () => {
    const { ctx } = activeClient();
    latestSource().emit('shutdown', {});
    assert.equal(ctx.run('isSseActive()'), false);
  });
});

describe('sse-client: 熔断与 401 闭环', () => {
  it('连续 3 次 CLOSED 失败进入冷却：期间不再建连', async () => {
    // retry 的 setTimeout 注入为受控回调队列：fail 后手动 flush 即时重连，
    // 不等真实 3s（测试预算）
    const retryQueue = [];
    const { ctx } = loadSseClient({
      fetch: async () => ({ ok: true, status: 200 }),
      setTimeout: (fn) => { retryQueue.push(fn); return retryQueue.length; },
      clearTimeout: () => {},
    });
    ctx.run('bootSseClient()');
    for (let i = 0; i < 3; i++) {
      latestSource().fail(MockEventSource.CLOSED);
      // probeAuthThenRetry 的 fetch 是 microtask：让出一拍后 flush 重试回调
      await new Promise((r) => setTimeout(r, 5));
      retryQueue.splice(0).forEach((fn) => fn());
    }
    // 第 3 次失败进入冷却：scheduleRetry(60s) 入队但不 flush
    const countAfterFailures = MockEventSource.instances.length;
    assert.ok(countAfterFailures >= 3, '应有多次尝试');
    // 冷却期（60s）内 bootSseClient 不再建连
    ctx.run('bootSseClient()');
    assert.equal(MockEventSource.instances.length, countAfterFailures);
    assert.equal(ctx.run('isSseActive()'), false);
  });

  it('致命失败探测到 401 → 停止重连', async () => {
    const { ctx } = loadSseClient({
      fetch: async () => ({ ok: false, status: 401 }),
    });
    ctx.run('bootSseClient()');
    const src = latestSource();
    src.fail(MockEventSource.CLOSED);
    await new Promise((r) => setTimeout(r, 10));
    const countAfter401 = MockEventSource.instances.length;
    ctx.run('bootSseClient()');
    assert.equal(MockEventSource.instances.length, countAfter401);
  });

  it('CONNECTING 态 onerror 不清算连接（浏览器自动重连中）', () => {
    const { ctx } = loadSseClient();
    ctx.run('bootSseClient()');
    const src = latestSource();
    src.emit('hello', { hello: true });
    src.fail(MockEventSource.CONNECTING);
    assert.equal(ctx.run('isSseActive()'), true, '自动重连期间保持激活');
  });
});

describe('sse-client: 30s 静默看门狗（watchdogDecide）', () => {
  // 判定矩阵直测（产品代码已抽为纯函数；真实 interval 粒度 5s 无分支，不测）。
  // vm 返回对象经 JSON 序列化规避沙箱 realm 原型差异。
  function decide(ctx, expr) {
    return JSON.parse(ctx.run(`JSON.stringify(${expr})`));
  }

  it('未激活（无 hello / 已断连）：无事可做', () => {
    const { ctx } = loadSseClient();
    assert.deepEqual(decide(ctx, 'watchdogDecide(false, 0, 100000, 1)'), { poll: false, deactivate: false });
  });

  it('静默未超阈值：空闲 agent 正常态，不扰动', () => {
    const { ctx } = loadSseClient();
    assert.deepEqual(decide(ctx, 'watchdogDecide(true, 80000, 100000, 1)'), { poll: false, deactivate: false });
  });

  it('静默超阈值且连接健康：只触发全量对账', () => {
    const { ctx } = loadSseClient();
    assert.deepEqual(decide(ctx, 'watchdogDecide(true, 0, 31000, 1)'), { poll: true, deactivate: false });
  });

  it('静默超阈值且连接死（半开态）：先降级再对账', () => {
    const { ctx } = loadSseClient();
    for (const rs of [0, 2, -1]) {
      assert.deepEqual(
        decide(ctx, `watchdogDecide(true, 0, 31000, ${rs})`),
        { poll: true, deactivate: true },
        `readyState=${rs}`,
      );
    }
  });
});

describe('sse-client: 排队气泡乐观对账（reconcileQueuedTexts）', () => {
  // vm 沙箱返回的数组原型属沙箱 realm，deepStrictEqual 的原型检查会
  // 误报：统一经 JSON 序列化后在主 realm 比较
  function runJson(ctx, expr) {
    return JSON.parse(ctx.run(`JSON.stringify(${expr})`));
  }

  function fresh() {
    const { ctx } = loadSseClient();
    return ctx;
  }

  it('快照含乐观 id → 确认（后续快照不再重复保留）', () => {
    const ctx = fresh();
    ctx.run('window.ClawFW.SseClient.noteQueuedOptimistic("q-1", "排队A")');
    const first = runJson(ctx, 'window.ClawFW.SseClient.reconcileQueuedTexts([{ id: "q-1", text: "排队A" }])');
    assert.deepEqual(first, ['排队A']);
    // 已确认：空快照不残留
    const second = runJson(ctx, 'window.ClawFW.SseClient.reconcileQueuedTexts([])');
    assert.deepEqual(second, []);
  });

  it('快照不含乐观 id 且未超 TTL → 乐观文本保留追加', () => {
    const ctx = fresh();
    ctx.run('window.ClawFW.SseClient.noteQueuedOptimistic("q-9", "还在等")');
    const out = runJson(ctx, `window.ClawFW.SseClient.reconcileQueuedTexts([{ id: "q-1", text: "先来的" }])`);
    assert.deepEqual(out, ['先来的', '还在等']);
  });

  it('快照不含乐观 id 且超 TTL（10s）→ 移除', () => {
    const ctx = fresh();
    ctx.run('window.ClawFW.SseClient.noteQueuedOptimistic("q-old", "过期的")');
    const out = runJson(ctx, 'window.ClawFW.SseClient.reconcileQueuedTexts([], Date.now() + 11000)');
    assert.deepEqual(out, []);
  });

  it('图片项与空文本项的文本归一（🖼）', () => {
    const ctx = fresh();
    const out = runJson(ctx, `window.ClawFW.SseClient.reconcileQueuedTexts([
      { id: 'q-i', images: [{}, {}] },
      { id: 'q-e', text: '   ' },
      { id: 'q-t', text: ' ok ' },
    ])`);
    assert.deepEqual(out, ['🖼', 'ok']);
  });
});
