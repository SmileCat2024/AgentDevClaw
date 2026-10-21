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
    loadAgents: [],
    forceFullPoll: 0,
    toasts: [],
    foregroundSyncs: 0,
    tryNotifyInputRequest: [],
    renders: [],
  };
  let switchEpoch = 1;
  let applyResult = false;
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
    updateNotificationStatus: (p, runtimeId, token) => calls.updateNotificationStatus.push({ p, runtimeId, token }),
    applyAgentCallStateFromNotification: (id, p) => {
      calls.applyAgentCallStateFromNotification.push({ id, p });
      return applyResult;
    },
    renderAgentList: () => { calls.renders.push(1); },
    commitMetadataUpdate: (token, parts) => calls.commitMetadataUpdate.push({ token, parts }),
    runMessagesProbeCycle: async (token, probe) => {
      calls.runMessagesProbeCycle.push({ token, probe });
      return 'committed';
    },
    applyQueuedInputsTexts: (id, texts, count) => calls.applyQueuedInputsTexts.push({ id, texts, count }),
    loadAgents: async () => { calls.loadAgents.push(1); },
    getRuntimeRecord: () => null,
    commitSessionViewPatch: (token, patch, apply) => { if (token?.switchEpoch === switchEpoch) apply?.(); },
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
  return {
    ctx,
    calls,
    bumpEpoch: () => { switchEpoch += 1; },
    setApplyResult: (v) => { applyResult = v; },
  };
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

describe('sse-client: thread subscriptions', () => {
  it('keeps sidebar discovery URL constant with a large history and discovers new threads', async () => {
    const { ctx } = loadSseClient({ setTimeout: () => 0, setInterval: () => 0 });
    ctx.run('bootSseClient()');
    ctx.loadSource('public/src/modules/thread-store.js');
    let threads = Array.from({ length: 1000 }, (_, i) => ({
      threadId: `wt-${String(i).padStart(36, '0')}`, agentId: 'coder', sessionIds: [],
    }));
    let reads = 0;
    ctx.fetch = async () => {
      reads += 1;
      return { ok: true, json: async () => ({ threads }) };
    };
    await ctx.window.refreshThreads(true);
    const source = latestSource();
    assert.equal(source.url, '/protoclaw/events?threads=*');
    const connections = MockEventSource.instances.length;
    threads = [...threads, { threadId: 'brand-new', agentId: 'coder', sessionIds: [] }];
    source.emit('thread.created', { threadId: 'brand-new' });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(reads >= 2);
    assert.ok(ctx.window.ClawThreads.byId['brand-new']);
    assert.equal(MockEventSource.instances.length, connections, 'history changes must not rebuild the stream');
  });

  it('combines wildcard and targeted handlers without duplicate delivery and releases subscriptions', () => {
    const { ctx } = loadSseClient();
    ctx.run('bootSseClient()');
    const calls = [];
    const shared = event => calls.push(event.threadId);
    const subscribe = ctx.window.ClawFW.SseClient.subscribeThreadEvents;
    const offTarget = subscribe('t1', shared);
    const offAll = subscribe('*', shared);
    assert.equal(latestSource().url, '/protoclaw/events?threads=*');
    latestSource().emit('thread.created', { threadId: 't1' });
    latestSource().emit('thread.created', { threadId: 't2' });
    assert.deepEqual(calls, ['t1', 't2']);
    offAll();
    assert.equal(latestSource().url, '/protoclaw/events?threads=t1');
    latestSource().emit('thread.created', { threadId: 't2' });
    assert.deepEqual(calls, ['t1', 't2']);
    offTarget();
    assert.equal(latestSource().url, '/protoclaw/events');
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
    assert.deepEqual(calls.updateNotificationStatus[0].p, payload);
    assert.equal(calls.updateNotificationStatus[0].runtimeId, 'rt-focus');
    assert.equal(calls.updateNotificationStatus[0].token.runtimeId, 'rt-focus');
    assert.equal(calls.applyAgentCallStateFromNotification.length, 0);
    // 事件到达顺带刷新前台时钟（§5.4 时钟源钩子）
    assert.ok(calls.foregroundSyncs >= 1);

    latestSource().emit('notification', { kind: 'notification', agentId: 'rt-other', data: payload });
    assert.equal(calls.updateNotificationStatus.length, 1);
    assert.equal(calls.applyAgentCallStateFromNotification.length, 1);
    assert.equal(calls.applyAgentCallStateFromNotification[0].id, 'rt-other');
  });

  it('ADR-0019 非焦点边沿变化 → apply 返回 true → 即时 renderAgentList（唤醒轮转圈/挂起绿灯显形）', () => {
    const { calls, setApplyResult } = activeClient();
    const payload = { callActive: true, state: null };
    // 边沿变化（calling true / suspended 置位）：apply 返回 true → 渲染
    setApplyResult(true);
    latestSource().emit('notification', { kind: 'notification', agentId: 'rt-other', data: payload });
    assert.equal(calls.applyAgentCallStateFromNotification.length, 1);
    assert.equal(calls.renders.length, 1, '边沿变化即时渲染，不依赖其他渲染事件');
    // 无边沿变化（幂等 apply）：不渲染
    setApplyResult(false);
    latestSource().emit('notification', { kind: 'notification', agentId: 'rt-other', data: payload });
    assert.equal(calls.applyAgentCallStateFromNotification.length, 2);
    assert.equal(calls.renders.length, 1, '幂等事件不重复渲染');
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

  it('input-requests 焦点 → commitMetadataUpdate；非焦点 → choice toast', () => {
    const { calls } = activeClient();
    latestSource().emit('input-requests', {
      kind: 'input-requests', agentId: 'rt-focus',
      data: [{ requestId: 'req-f', mode: 'choices' }],
    });
    assert.equal(calls.commitMetadataUpdate.length, 1);
    assert.equal(calls.tryNotifyInputRequest.length, 0); // stub 未接线时不炸
    latestSource().emit('input-requests', {
      kind: 'input-requests', agentId: 'rt-other',
      data: [{ requestId: 'req-x', mode: 'choices', questions: ['继续吗'] }],
    });
    assert.equal(calls.toasts.length, 1);
    assert.equal(calls.toasts[0].id, 'choice-alert-req-x');
  });

  it('input-requests 帧不触发桌面通知（ADR-0030：通知由 server app-notification 帧驱动）', () => {
    const notified = [];
    const { ctx } = loadSseClient({ _presentAppNotification: (frame) => notified.push(frame) });
    ctx.run('bootSseClient()');
    latestSource().emit('hello', { hello: true });
    latestSource().emit('input-requests', {
      kind: 'input-requests', agentId: 'rt-focus',
      data: [{ requestId: 'req-text', mode: 'text' }],
    });
    latestSource().emit('input-requests', {
      kind: 'input-requests', agentId: 'rt-focus',
      data: [{ requestId: 'req-real', mode: 'choices', questions: ['继续吗'] }],
    });
    assert.equal(notified.length, 0);
  });

  it('app-notification 帧分发给 _presentAppNotification（全局帧，不按焦点分流）', () => {
    const notified = [];
    const { ctx } = loadSseClient({ _presentAppNotification: (frame) => notified.push(frame) });
    ctx.run('bootSseClient()');
    latestSource().emit('hello', { hello: true });
    latestSource().emit('app-notification', {
      type: 'reminder', agentId: 'memo', title: '到点了', body: '该开会了', threadId: 'wt-1',
    });
    latestSource().emit('app-notification', {
      type: 'finish', agentId: 'rt-focus', finishTs: 1791509161407,
    });
    assert.equal(notified.length, 2);
    assert.equal(notified[0].type, 'reminder');
    assert.equal(notified[1].agentId, 'rt-focus');
    // 非法帧（缺 agentId / 非 JSON）静默丢弃不炸
    latestSource().emit('app-notification', { title: 'no-agent' });
    assert.equal(notified.length, 2);
  });

  it('非焦点 input-requests 非 choices 租约不 toast（F1：文本输入请求不误报等待选择）', () => {
    const { calls } = activeClient();
    latestSource().emit('input-requests', {
      kind: 'input-requests', agentId: 'rt-other',
      data: [
        { requestId: 'req-text', mode: 'text' },
        { requestId: 'req-empty', mode: 'choices', questions: [] },
      ],
    });
    assert.equal(calls.toasts.length, 0);
  });

  it('非焦点 choice 帧 toast 照常，桌面通知不经此路径（ADR-0030）', () => {
    const notified = [];
    const { ctx, calls } = loadSseClient({
      _presentAppNotification: (frame) => notified.push(frame),
    });
    ctx.run('bootSseClient()');
    latestSource().emit('hello', { hello: true });
    latestSource().emit('input-requests', {
      kind: 'input-requests', agentId: 'rt-other',
      data: [{ requestId: 'req-nf', mode: 'choices', questions: ['继续吗'] }],
    });
    // toast 保留（回前台可见）；桌面通知由 server 统一出口的
    // app-notification 帧驱动，input-requests 帧不触发
    assert.equal(calls.toasts.length, 1);
    assert.equal(notified.length, 0);
    // 同 requestId 重复帧：_seenChoiceAlertIds 去重，toast 不重触发
    latestSource().emit('input-requests', {
      kind: 'input-requests', agentId: 'rt-other',
      data: [{ requestId: 'req-nf', mode: 'choices', questions: ['继续吗'] }],
    });
    assert.equal(calls.toasts.length, 1);
  });

  it('messages probe 返回 handled404 → 触发 runtime 消失处理（F3）', async () => {
    const handled404 = [];
    const { ctx } = loadSseClient({
      runMessagesProbeCycle: async () => 'handled404',
      handleCoreResponsesNotFound: (token) => { handled404.push(token); return true; },
    });
    ctx.run('bootSseClient()');
    latestSource().emit('hello', { hello: true });
    latestSource().emit('messages', { kind: 'messages', agentId: 'rt-focus', probe: { seq: 1 } });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(handled404.length, 1);
    assert.equal(handled404[0].runtimeId, 'rt-focus');
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

  it('非焦点 runtime 的队列消费事件更新缓存，切回时不复用过期气泡', () => {
    const { ctx, calls } = loadSseClient();
    ctx.run('bootSseClient()');
    latestSource().emit('hello', { hello: true });

    latestSource().emit('queued-inputs', {
      kind: 'queued-inputs', agentId: 'rt-focus',
      data: [{ id: 'q-1', text: '已送达的消息' }],
    });
    ctx.currentRuntimeAgentId = 'rt-other';
    latestSource().emit('queued-inputs', {
      kind: 'queued-inputs', agentId: 'rt-focus', data: [],
    });

    assert.equal(calls.applyQueuedInputsTexts.length, 1,
      '非焦点队列快照不能直接改当前输入框');
    ctx.currentRuntimeAgentId = 'rt-focus';
    const snapshot = ctx.run('window.ClawFW.SseClient.getLastQueuedSnapshot("rt-focus")');
    assert.deepEqual(snapshot.items, [],
      '切回 runtime 时应取得离开期间最新的空队列，而不是旧的排队消息');
  });

  it('queued-inputs 事件按身份过滤：reminder 不进气泡文本与待发送计数', () => {
    const { ctx, calls } = loadSseClient();
    ctx.run('bootSseClient()');
    latestSource().emit('hello', { hello: true });
    latestSource().emit('queued-inputs', {
      kind: 'queued-inputs', agentId: 'rt-focus',
      data: [
        { id: 'q-1', text: '用户消息' },
        { id: 'q-2', text: '面板动作通报', kind: 'reminder' },
        { id: 'q-3', text: '下一条用户消息' },
      ],
    });
    assert.equal(calls.applyQueuedInputsTexts.length, 1);
    assert.deepEqual(
      JSON.parse(JSON.stringify(calls.applyQueuedInputsTexts[0].texts)),
      ['用户消息', '下一条用户消息'],
    );
    assert.equal(calls.applyQueuedInputsTexts[0].count, 2);
    // 快照缓存保留全量（对账/调试事实），过滤只发生在展示层
    const snap = ctx.run('window.ClawFW.SseClient.getLastQueuedSnapshot("rt-focus")');
    assert.equal(snap.items.length, 3);
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

  it('connection 事件 → loadAgents；reconnected → 全量对账', () => {
    const { calls } = activeClient();
    latestSource().emit('connection', { kind: 'connection', agentId: 'rt-focus', connected: false });
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

  it('排队与消费事件先于 POST 回执到达：迟到回执不能复活已发送气泡', () => {
    const ctx = fresh();
    ctx.run(`handleQueuedInputsEvent({ agentId: 'rt-focus', data: [{ id: 'q-fast', text: '已发送' }] });
      handleQueuedInputsEvent({ agentId: 'rt-focus', data: [] });
      noteQueuedOptimistic('q-fast', '已发送', 'rt-focus');`);
    assert.deepEqual(runJson(ctx, `reconcileQueuedTexts(getLastQueuedSnapshot('rt-focus').items)`), [],
      'the consumed message must not remain staged until TTL or page refresh');
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

  it('reminder 项不产生气泡文本（用户输入按身份展示）', () => {
    const ctx = fresh();
    const out = runJson(ctx, `window.ClawFW.SseClient.reconcileQueuedTexts([
      { id: 'q-1', text: '用户消息' },
      { id: 'q-2', text: '面板动作通报', kind: 'reminder' },
      { id: 'q-3', images: [{}], kind: 'reminder' },
    ])`);
    assert.deepEqual(out, ['用户消息']);
  });

  it('跨会话隔离：其他 runtime 的乐观锚点不拼入本会话快照', () => {
    const ctx = fresh();
    // 会话 A 提交排队后切走：锚点归属 rt-a
    ctx.run('window.ClawFW.SseClient.noteQueuedOptimistic("q-a", "会话A的排队", "rt-a")');

    // 会话 B 的快照对账：A 的乐观文本不冒进 B 的排队气泡
    const forB = runJson(ctx, 'window.ClawFW.SseClient.reconcileQueuedTexts([], Date.now(), "rt-b")');
    assert.deepEqual(forB, []);

    // 会话 A 的快照对账：乐观文本保留
    const forA = runJson(ctx, 'window.ClawFW.SseClient.reconcileQueuedTexts([], Date.now(), "rt-a")');
    assert.deepEqual(forA, ['会话A的排队']);

    // A 的排队项出现在自己的快照里 → 确认清除；B 的对账不受影响
    const confirmed = runJson(ctx,
      'window.ClawFW.SseClient.reconcileQueuedTexts([{ id: "q-a", text: "会话A的排队" }], Date.now(), "rt-a")');
    assert.deepEqual(confirmed, ['会话A的排队']);
    assert.deepEqual(
      runJson(ctx, 'window.ClawFW.SseClient.reconcileQueuedTexts([], Date.now(), "rt-a")'),
      [],
      '确认后的锚点不再保留',
    );
  });
});
