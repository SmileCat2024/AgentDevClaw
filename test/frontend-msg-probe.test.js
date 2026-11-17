/**
 * Frontend incremental message polling (ADR-0012 probe + tail) —— P2 真实 ESM 图路线。
 *
 * Locks the poll data-fetch contract introduced by ticket 08:
 *
 *   probe (rides /overview) → classify → fetch delta or skip →
 *   splice back a full array → commit through the untouched render
 *   state machine (appendNewMessages / updateLastMessage /
 *   renderCurrentMainView).
 *
 * Covered here:
 *   - four fetch paths: unchanged (zero /messages requests), append
 *     (?since=N spliced onto the known prefix), tail (?tail=1 replacing
 *     the last entry), rewrite (full refetch)
 *   - degradations to a full baseline rebuild: delta length mismatch,
 *     probe.count regression, probe missing
 *   - the probe never pollutes getOverviewSignature
 *   - dev metrics stay silent unless ?msg_metrics=1 is present
 *
 * 装载路线（相对旧版的唯一变化）：以前把 app-main.js 的轮询片段和已迁 ESM 的
 * overview-data.js 源码切片塞进 vm 执行；现在 classic 相按真实加载序跑**整份**
 * classic 源（分发器 / i18n / app-core / session-view-state / app-main），
 * ESM 侧（overview-data / auto-title / 轮询域各 factory）经
 * `withP2EsmCase` + `c.load` 真实 import。宿主工厂仍是被测的真实生产 seam
 * （app-main 的 createXxxHost），ESM factory 由它们装配——与生产同构，且每个
 * 用例一张独立模块图（probe 的 seq 基线、metrics 计数不跨用例）。
 *
 * 改写说明（无源码切片、无内部 patch）：
 *   - 旧版把 sse-client.js 源码塞进沙箱直接调私有 handleMessagesEvent；SSE 帧
 *     路径与轮询共用同一个公开入口 runMessagesProbeCycle（见 sse-client 的实现），
 *     因此并发两轮 probe cycle 即可复现同一时序，不需要 EventSource 桩。
 *   - 旧版直接断言 auto-title 私有的 _messagesEqual；现在只经其公开导出
 *     findFirstChangedMessageIndex 断言（含"完全相同内容 → -1"的等价语义对照）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { Renderer } from 'marked';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const OVERVIEW_DATA = 'public/src/modules/overview-data.js';
const AUTO_TITLE = 'public/src/modules/auto-title.js';
const POLL_COORDINATOR = 'public/src/modules/poll-coordinator.js';
const MESSAGE_PROBE = 'public/src/modules/message-probe.js';
const MESSAGE_METRICS = 'public/src/modules/message-metrics.js';
const COMMITTED_VIEW_RENDERER = 'public/src/modules/committed-view-renderer.js';
const METADATA_COMMIT = 'public/src/modules/metadata-commit.js';
const RUNTIME_POLL = 'public/src/modules/runtime-poll.js';
const POLL_CYCLE = 'public/src/modules/poll-cycle.js';
const POLL_MAINTENANCE = 'public/src/modules/poll-maintenance.js';
const RUNTIME_NOT_FOUND = 'public/src/modules/runtime-not-found.js';
const SSE_CLIENT = 'public/src/modules/sse-client.js';

/** vendor 桩：markdown-utils 在求值期需要 Renderer 与 setOptions。 */
const markedStub = { Renderer, setOptions() {} };

function msg(content) {
  return { role: 'assistant', content };
}

// Values crossing the realm boundary carry a foreign prototype, which
// deepStrictEqual rejects; round-trip through JSON before structural compares.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/** classic 相：真实加载序（分发器 → i18n → app-core → session-view-state → app-main）。 */
function loadClassicBootstrap(sandbox, { search }) {
  sandbox.marked = markedStub;
  sandbox.window.marked = markedStub;
  sandbox.run(`window.location.search = ${JSON.stringify(search || '')};`);
  // 真实先行脚本序（test/p2-classic-hosts.js）：宿主工厂是生产实现；基座自带
  // BOOT_NEUTRALIZER（applyTheme / applyLanguage 无操作、__clawAuthReady 永 pending、
  // interval / rAF 关掉），因此 app-main 的装载就绪而首屏 boot 不运行。
  prepareClassicSandbox(sandbox);
  // 主视图渲染会挂视口观察器（chat-viewport，已迁 ESM）：由 async 相 c.load 装载，
  // 桥键让 classic renderCurrentMainView 走生产实现而不是桩。
  // 主视图渲染入口：真实 app-ui 实现需要整条页面 DOM（chat-viewport → input-render →
  // app-chat-input 槽位）。本文件各用例只把「渲染」当观察面（计数 / 快照），故在真实链
  // 之后装一个转发入口：用例经 __caseRenderCurrentMainView 给定观察实现，未设时空实现。
  sandbox.renderCurrentMainView = () => {
    const impl = sandbox.__caseRenderCurrentMainView;
    if (typeof impl === 'function') impl(sandbox);
  };
}

/** 当前用例的 classic 沙箱：`globals` 里的宿主 seam 需要它做晚绑定。 */
let caseSandbox = null;

/**
 * 用例包装：p2 case 结束后断开模块级沙箱引用（宿主桩晚绑定用，不承担状态），
 * 避免跨用例残留。
 */
async function withCaseSandbox(options, fn) {
  try {
    return await withP2EsmCase(options, fn);
  } finally {
    caseSandbox = null;
  }
}

/**
 * 一个用例 = 一张独立模块图。classic 相装配真实宿主工厂；ESM 相装载轮询域并
 * 用真实 factory 组装（与生产 run-prebuilt 时的装配顺序一致）。
 */
async function withPollHarness({ initialMessages = [], overview = {}, messagesResponder, search = '', sse = false } = {}, fn) {
  const fetchCalls = [];
  const sseSources = [];

  /** 真实 `window.EventSource` 面：记录连接实例，测试按帧类型注入事件。 */
  class EventSourceStub {
    constructor(url) {
      this.url = String(url);
      this.readyState = 0;
      this.listeners = new Map();
      this.onerror = null;
      sseSources.push(this);
    }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
    }
    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener);
    }
    close() { this.readyState = 2; }
    /** 服务端帧 → 浏览器语义：同名监听器逐个收到 { data } 事件对象。 */
    emit(type, payload) {
      const event = { type, data: JSON.stringify(payload) };
      for (const listener of this.listeners.get(type) || []) listener(event);
    }
  }
  const consoleRecords = { debug: [], warn: [], error: [] };
  const renders = { append: [], updateLast: [], fullRender: 0 };

  const fetchStub = async (url) => {
    const path = String(url);
    fetchCalls.push(path);
    const respond = (body, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(JSON.stringify(body)),
    });
    if (path.endsWith('/input-requests')) return respond([]);
    if (path.endsWith('/todo')) return respond({}, 500);
    if (path.endsWith('/overview')) return respond(overview);
    if (path.includes('/messages')) {
      const result = messagesResponder
        ? messagesResponder(path)
        : { status: 200, body: { messages: JSON.parse(JSON.stringify(initialMessages)) } };
      return respond(result.body, result.status);
    }
    return respond({});
  };

  await withCaseSandbox({
    globals: {
      console: {
        debug: (...args) => consoleRecords.debug.push(args),
        warn: (...args) => consoleRecords.warn.push(args),
        error: (...args) => consoleRecords.error.push(args),
        log: () => {},
      },
      fetch: fetchStub,
      URLSearchParams,
      TextEncoder,
      EventSource: EventSourceStub,
      // ── 未装载模块的宿主 seam（保持旧版注入面）──────────────────────
      attachMessagesTimestamps: (messages) => messages,
      reloadFeatureTemplateMap: async () => {},
      updateNotificationStatus: () => {},
      loadAgents: async () => {},
      refreshAgentCallStates: async () => {},
      refreshCurrentRuntimeStatus: async () => {},
      clearPartialCompactState: () => {},
      selectWorkspaceSurface: () => {},
      getEmptyTodoPlan: () => ({ state: {} }),
      // 主视图渲染的观察面（真实链末尾的转发入口会调用它，见 loadClassicBootstrap）。
      __caseRenderCurrentMainView: () => { renders.fullRender += 1; },
      renderInputRequests: () => {},
      markAutoTitleCandidate: () => {},
      tryAutoTitleGeneration: () => {},
      recheckAutoTitleCandidate: () => {},
      shouldRenderWorkspaceSurface: () => false,
      appendNewMessages: (newMessages) => { renders.append.push(newMessages); },
      updateLastMessage: (message) => { renders.updateLast.push(message); },
      _syncPersistentActionButton: () => {},
      _syncPersistentInputUi: () => {},
      // 主视图渲染会顺带同步输入面（classic input-render 的 notifyInputSurfaceChanged）：
      // 本文件验收面是消息探针的增量/重建与字节计量，不渲染输入面 → 观察面为空实现。
      notifyInputSurfaceChanged: () => {},
      normalizeTodoPlan: (value) => value,
      getTodoPlanSignature: (value) => JSON.stringify(value),
      setCurrentTodoPlan: (value) => { caseSandbox.currentTodoPlan = value; caseSandbox.currentTodoPlanSignature = JSON.stringify(value); },
      getTodoForceContinue: () => null,
      setTodoForceContinue: () => {},
      updatePlanBadge: () => {},
      renderFeaturePanel: () => {},
      isChatSurfaceActive: () => true,
      updateRollbackActionVisibility: () => {},
      isRuntimeCalling: () => false,
      loadLogs: async () => {},
      saveCurrentRuntimeToCache: () => {},
      _trackRecapSessionPresence: () => {},
    },
    classic: (sandbox) => {
      caseSandbox = sandbox;
      // 轮询原语不落真实定时器：本文件的所有周期都由 __poll() 显式驱动。
      sandbox.setTimeout = () => 0;
      sandbox.clearTimeout = () => {};
      sandbox.window.setTimeout = sandbox.setTimeout;
      sandbox.window.clearTimeout = sandbox.clearTimeout;
      loadClassicBootstrap(sandbox, { search });
    },
  }, async (c) => {
    // 刷新引擎（P4 T3 起是真实 ESM）：交互域在**装载期**取它的窄宿主 createThreadStoreHost，
// 必须先于 thread-store-domain 进入同一张图。
    await c.load('public/src/modules/thread-store.js');
    // 视口域先装载（桥键 + container 滚动监听），早于首屏渲染链的调用点。
    await c.load('public/src/modules/chat-viewport.js');
    await c.load(OVERVIEW_DATA);
    const autoTitle = await c.load(AUTO_TITLE);
    const coordinatorMod = await c.load(POLL_COORDINATOR);
    const probeMod = await c.load(MESSAGE_PROBE);
    const metricsMod = await c.load(MESSAGE_METRICS);
    const rendererMod = await c.load(COMMITTED_VIEW_RENDERER);
    const metadataMod = await c.load(METADATA_COMMIT);
    const runtimePollMod = await c.load(RUNTIME_POLL);
    const pollCycleMod = await c.load(POLL_CYCLE);
    const pollMaintenanceMod = await c.load(POLL_MAINTENANCE);
    const runtimeNotFoundMod = await c.load(RUNTIME_NOT_FOUND);

    c.window.createCommittedViewRenderer = rendererMod.createCommittedViewRenderer;
    c.window.createMessageMetrics = metricsMod.createMessageMetrics;
    c.window.computeSerializedBytes = metricsMod.computeSerializedBytes;

    Object.assign(c.window, coordinatorMod.createPollCoordinator(c.read('createPollCoordinatorHost()')));
    Object.assign(c.window, probeMod.createMessageProbe(
      c.read('createMessageProbeHost(createCommittedViewRenderer, createMessageMetrics, computeSerializedBytes)'),
    ));
    Object.assign(c.window, metadataMod.createMetadataCommit(c.read('createMetadataCommitHost(createCommittedViewRenderer)')));
    Object.assign(c.window, runtimePollMod.createRuntimePoll(c.read('createRuntimePollHost()')));
    Object.assign(c.window, pollCycleMod.createPollCycle(c.read('createPollCycleHost()')));
    Object.assign(c.window, pollMaintenanceMod.createPollMaintenance(c.read('createPollMaintenanceHost()')));
    Object.assign(c.window, runtimeNotFoundMod.createRuntimeNotFound(c.read('createRuntimeNotFoundHost()')));
    c.window.__poll = c.window.poll;

    c.window.__caseSeed = { initialMessages };
    c.read(`
      prebuiltSessionSwitchInFlight = false;
      _switchEpoch = 1;
      _lastChoiceAlertCheckAt = Date.now();
      lastFeatureTemplateReloadAt = Date.now();
      FEATURE_TEMPLATE_MAP = { loaded: true };
      currentRuntimeAgentId = 'rt';
      focusedAgentId = 'programming-helper';
      currentRuntimeConnected = true;
      currentWorkspaceTab = null;
      currentMessages = __caseSeed.initialMessages;
      currentInputRequests = [];
      toolRenderConfigs = {};
      TOOL_NAMES = {};
      currentOverviewSnapshot = {};
      currentOverviewSignature = '';
      currentTodoPlan = {};
      currentTodoPlanSignature = '';
      currentHookInspector = {};
      currentHookInspectorSignature = '';
      selectedFeatureName = null;
      activeFeaturePanel = null;
      logPanelScope = 'current';
      lastAgentListRefreshAt = Date.now();
      allAgents = [];
      _partialCompactInFlight = false;
      _partialCompactRuntimeId = null;
      _lastInterruptUserActionAt = Date.now();
      _lastTodoForceContinueUserActionAt = Date.now();
      suppressSidebarRerender = false;
      _localQueuedInputPending = false;
      window.lastInputRequests = [];
      window._lastWsSessionRefreshAt = Date.now();
    `);

    /**
     * 真实 SSE 自举：加载 sse-client 并调用其 bootSseClient()，经 window.EventSource
     * 建立连接（其 loader host 依赖由 ESM 图静态解析，无需预装载）。返回按类型
     * 注入服务端帧的句柄（当前连接）。
     */
    const openSse = async () => {
      const sseMod = await c.load(SSE_CLIENT);
      sseMod.bootSseClient();
      const source = sseSources.at(-1);
      assert.ok(source, 'bootSseClient 应经 window.EventSource 建立连接');
      return { emit: (type, payload) => source.emit(type, payload), source };
    };

    return fn({
      sandbox: c.window,
      autoTitle,
      openSse,
      fetchCalls,
      consoleRecords,
      renders,
    });
  });
}

function messageCalls(fetchCalls) {
  return fetchCalls.filter((url) => url.includes('/messages'));
}

test('message change detection treats tool image attachments as message changes', async () => {
  await withPollHarness({}, async ({ autoTitle }) => {
    const previous = { role: 'tool', toolCallId: 'call-1', content: '{"success":true}' };
    const next = {
      ...previous,
      images: [{ path: 'C:/managed-images/image.png', mediaType: 'image/png' }],
    };
    // 图片附件是消息内容的一部分：必须报"有变化"（索引 0）
    assert.equal(autoTitle.findFirstChangedMessageIndex([next], [previous]), 0);
    // 对照：内容完全相同的两份副本 → 无变化（-1），证明上面的 0 不是恒真
    assert.equal(autoTitle.findFirstChangedMessageIndex([{ ...next }], [next]), -1);
  });
});

test('late message response cannot hide a user message already delivered by SSE', async () => {
  await withPollHarness({ sse: true, initialMessages: [msg('previous reply')] }, async ({ sandbox, openSse }) => {
    const pending = [];
    sandbox.fetch = () => new Promise((resolve) => pending.push(resolve));
    const user = { role: 'user', content: 'new user input' };
    const rendered = [];
    sandbox.appendNewMessages = (messages) => rendered.push(...messages);
    sandbox.renderCurrentMainView = () => { rendered.splice(0, rendered.length, ...sandbox.currentMessages); };

    // 真实自举：sse-client 经 window.EventSource 建立连接，服务端帧按类型注入。
    const sse = await openSse();

    // 旧的在途 tail 周期（DB 里还没有用户消息）
    const old = sandbox.runMessagesProbeCycle(sandbox.captureSessionViewToken(), {
      seq: 1, count: 1, changeKind: 'tail',
    });
    // 真实 messages 帧（与浏览器同形：{ agentId, probe }），走 sse-client 的
    // handleMessagesEvent → runMessagesProbeCycle（与轮询共用同一入口）。
    sse.emit('messages', { agentId: 'rt', probe: { seq: 2, count: 2, changeKind: 'append' } });
    assert.equal(pending.length, 2, 'SSE 帧必须触发一次 probe 取数');
    pending[1]({ status: 200, json: async () => ({ messages: [msg('previous reply updated'), user] }) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(rendered.some((message) => message.content === user.content));
    pending[0]({ status: 200, json: async () => ({ messages: [msg('previous reply updated')] }) });
    await old;
    assert.ok(sandbox.currentMessages.some((message) => message.content === user.content),
      'an older response must not remove the newly visible user message');
    assert.ok(rendered.some((message) => message.content === user.content),
      'the user message must remain visible without a page refresh');
  });
});

test('worker seq reset rebuilds messages instead of rejecting all future probes', async () => {
  await withPollHarness({ initialMessages: [msg('old runtime data')] }, async ({ sandbox }) => {
    sandbox.fetch = async () => ({ status: 200, json: async () => ({ messages: [msg('baseline')] }) });
    await sandbox.runMessagesProbeCycle(sandbox.captureSessionViewToken(), { seq: 50, count: 1, changeKind: 'rewrite' });
    sandbox.fetch = async () => ({ status: 200, json: async () => ({ messages: [] }) });
    assert.equal(await sandbox.runMessagesProbeCycle(sandbox.captureSessionViewToken(), {
      seq: 0, count: 0, changeKind: 'rewrite',
    }), 'committed');
    assert.deepEqual(plain(sandbox.currentMessages), []);
  });
});

for (const finishNewFirst of [false, true]) {
  test(`concurrent tail and append keep the updated prefix (new first=${finishNewFirst})`, async () => {
    await withPollHarness({ initialMessages: [msg('streaming')] }, async ({ sandbox }) => {
      const pending = [];
      sandbox.fetch = (url) => new Promise((resolve) => pending.push({ url, resolve }));
      const token = sandbox.captureSessionViewToken();
      const older = sandbox.runMessagesProbeCycle(token, { seq: 1, count: 1, changeKind: 'tail' });
      const newer = sandbox.runMessagesProbeCycle(token, { seq: 2, count: 2, changeKind: 'append' });
      const reply = (index, messages) => pending[index].resolve({ status: 200, json: async () => ({ messages }) });
      if (finishNewFirst) {
        // seq=2 follows an unapplied tail change: fetching just the append delta
        // would keep the stale prefix even though the latest seq is marked applied.
        assert.ok(pending[1].url.endsWith('/messages'), 'a skipped seq needs a full baseline');
        reply(1, [msg('done'), msg('next')]);
        await newer;
        reply(0, [msg('done')]);
      } else {
        reply(0, [msg('done')]);
        await older;
        reply(1, [msg('next')]);
        await new Promise((resolve) => setImmediate(resolve));
        reply(2, [msg('next')]);
      }
      await Promise.all([older, newer]);
      assert.deepEqual(plain(sandbox.currentMessages), [msg('done'), msg('next')]);
    });
  });
}

// ── Four fetch paths ──────────────────────────────────────────

test('unchanged probe skips the /messages request and reuses the known array', async () => {
  const initial = [msg('m1'), msg('m2')];
  await withPollHarness({
    initialMessages: initial,
    overview: {
      modelName: 'model-a',
      _messagesProbe: { count: 2, changeKind: null, sinceIndex: 2, fakeFullBytes: 500 },
    },
  }, async (harness) => {
    await harness.sandbox.__poll();

    assert.equal(messageCalls(harness.fetchCalls).length, 0, 'unchanged cycle must not fetch /messages');
    assert.deepEqual(plain(harness.sandbox.currentMessages), [msg('m1'), msg('m2')]);
    assert.deepEqual(harness.renders.append, []);
    assert.deepEqual(harness.renders.updateLast, []);
    assert.equal(harness.renders.fullRender, 0, 'unchanged cycle must not repaint the transcript');
  });
});

test('append fetches ?since=<known count> and splices onto the known prefix', async () => {
  const m3 = msg('m3');
  await withPollHarness({
    initialMessages: [msg('m1'), msg('m2')],
    overview: {
      modelName: 'model-a',
      _messagesProbe: { seq: 1, count: 3, changeKind: 'append', sinceIndex: 2, fakeFullBytes: 600 },
    },
    messagesResponder: (path) => {
      assert.ok(path.endsWith('/messages?since=2'), `unexpected messages url: ${path}`);
      return { status: 200, body: { messages: [m3], baseCount: 2 } };
    },
  }, async (harness) => {
    await harness.sandbox.__poll();

    assert.equal(messageCalls(harness.fetchCalls).length, 1);
    assert.deepEqual(plain(harness.sandbox.currentMessages), [msg('m1'), msg('m2'), m3]);
    assert.deepEqual(plain(harness.renders.append), [[m3]], 'render state machine must take the append branch');
    assert.deepEqual(harness.renders.updateLast, []);
    assert.equal(harness.renders.fullRender, 0);
  });
});

test('tail fetches ?tail=1 and replaces only the last entry', async () => {
  const m2v2 = msg('m2-streamed');
  await withPollHarness({
    initialMessages: [msg('m1'), msg('m2-streaming')],
    overview: {
      modelName: 'model-a',
      _messagesProbe: { seq: 1, count: 2, changeKind: 'tail', sinceIndex: 1, fakeFullBytes: 700 },
    },
    messagesResponder: (path) => {
      assert.ok(path.endsWith('/messages?tail=1'), `unexpected messages url: ${path}`);
      return { status: 200, body: { messages: [m2v2] } };
    },
  }, async (harness) => {
    await harness.sandbox.__poll();

    assert.equal(messageCalls(harness.fetchCalls).length, 1);
    assert.deepEqual(plain(harness.sandbox.currentMessages), [msg('m1'), m2v2]);
    assert.deepEqual(plain(harness.renders.updateLast), [m2v2], 'render state machine must take the update-last branch');
    assert.deepEqual(harness.renders.append, []);
    assert.equal(harness.renders.fullRender, 0);
  });
});

test('rewrite falls back to a full fetch and rebuilds the array', async () => {
  const rewritten = [msg('r1'), msg('r2')];
  await withPollHarness({
    initialMessages: [msg('m1'), msg('m2'), msg('m3')],
    overview: {
      modelName: 'model-a',
      _messagesProbe: { seq: 1, count: 2, changeKind: 'rewrite', sinceIndex: 0, fakeFullBytes: 800 },
    },
    messagesResponder: (path) => {
      assert.ok(path.endsWith('/messages'), `rewrite must fetch without query: ${path}`);
      return { status: 200, body: { agentId: 'rt', messages: rewritten } };
    },
  }, async (harness) => {
    await harness.sandbox.__poll();

    assert.equal(messageCalls(harness.fetchCalls).length, 1);
    assert.deepEqual(plain(harness.sandbox.currentMessages), rewritten);
    assert.equal(harness.renders.fullRender, 1, 'render state machine must take the full rebuild branch');
  });
});

// ── Degradation: full fetch rebuilds the baseline ─────────────

test('append delta length mismatch degrades to a full fetch and rebuilds the baseline', async () => {
  const full = [msg('f1'), msg('f2'), msg('f3')];
  await withPollHarness({
    initialMessages: [msg('m1'), msg('m2')],
    overview: {
      modelName: 'model-a',
      _messagesProbe: { seq: 1, count: 4, changeKind: 'append', sinceIndex: 2, fakeFullBytes: 900 },
    },
    messagesResponder: (path) => {
      if (path.endsWith('/messages?since=2')) {
        // Server classified append but returned fewer deltas than promised.
        return { status: 200, body: { messages: [msg('m3')], baseCount: 2 } };
      }
      assert.ok(path.endsWith('/messages'), `degradation must fetch full: ${path}`);
      return { status: 200, body: { messages: full } };
    },
  }, async (harness) => {
    await harness.sandbox.__poll();

    assert.deepEqual(
      messageCalls(harness.fetchCalls),
      ['/api/agents/rt/messages?since=2', '/api/agents/rt/messages'],
      'cycle must fetch the delta, fail validation, then fetch full',
    );
    assert.deepEqual(plain(harness.sandbox.currentMessages), full);
  });
});

test('probe.count regression skips the delta fetch and rebuilds the baseline', async () => {
  const full = [msg('f1')];
  await withPollHarness({
    initialMessages: [msg('m1'), msg('m2'), msg('m3')],
    overview: {
      modelName: 'model-a',
      _messagesProbe: { seq: 1, count: 1, changeKind: 'append', sinceIndex: 0, fakeFullBytes: 100 },
    },
    messagesResponder: (path) => {
      assert.ok(path.endsWith('/messages'), `count regression must fetch full directly: ${path}`);
      return { status: 200, body: { messages: full } };
    },
  }, async (harness) => {
    await harness.sandbox.__poll();

    assert.deepEqual(messageCalls(harness.fetchCalls), ['/api/agents/rt/messages']);
    assert.deepEqual(plain(harness.sandbox.currentMessages), full);
  });
});

test('missing probe keeps the legacy full-fetch path', async () => {
  const full = [msg('m1'), msg('m2')];
  await withPollHarness({
    initialMessages: [],
    overview: { modelName: 'model-a' },
    messagesResponder: (path) => {
      assert.ok(path.endsWith('/messages'), `probe-less cycle must fetch full: ${path}`);
      return { status: 200, body: { messages: full } };
    },
  }, async (harness) => {
    await harness.sandbox.__poll();

    assert.deepEqual(messageCalls(harness.fetchCalls), ['/api/agents/rt/messages']);
    assert.deepEqual(plain(harness.sandbox.currentMessages), full);
  });
});

// ── Probe isolation from the overview signature ───────────────

test('probe fields are stripped from the snapshot and do not change the signature', () => {
  // 纯函数面：overview-data 的规范化与签名（生产唯一实现，classic 消费方经桥键调同一份）。
  return withP2EsmCase({
    classic: (sandbox) => {
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
      sandbox.loadSource('public/src/app-core.js');
      sandbox.loadSource('public/src/modules/session-view-state.js');
    },
  }, async (c) => {
    const overviewData = await c.load(OVERVIEW_DATA);
    const base = { modelName: 'model-a', updatedAt: 1, context: { messageCount: 3 } };
    const withProbe = {
      ...base,
      _messagesProbe: { seq: 2, count: 3, changeKind: 'tail', sinceIndex: 2, fakeFullBytes: 4321 },
    };

    const sigWithout = overviewData.getOverviewSignature(base);
    const sigWith = overviewData.getOverviewSignature(withProbe);
    assert.equal(sigWith, sigWithout, 'probe must not pollute the overview signature');

    const normalized = overviewData.normalizeOverviewSnapshot(withProbe);
    assert.equal(
      Object.prototype.hasOwnProperty.call(normalized, '_messagesProbe'),
      false,
      'probe must not enter the view snapshot',
    );
  });
});

test('extractMessagesProbe validates fields and returns null when unusable', () => {
  return withP2EsmCase({
    classic: (sandbox) => {
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
      sandbox.loadSource('public/src/app-core.js');
      sandbox.loadSource('public/src/modules/session-view-state.js');
    },
  }, async (c) => {
    const { extractMessagesProbe } = await c.load(OVERVIEW_DATA);

    assert.deepEqual(extractMessagesProbe({ _messagesProbe: { seq: 5, count: 3, changeKind: 'tail', sinceIndex: 2, fakeFullBytes: 12 } }), {
      seq: 5,
      count: 3,
      changeKind: 'tail',
      sinceIndex: 2,
      fakeFullBytes: 12,
    });
    assert.deepEqual(extractMessagesProbe({ _messagesProbe: { seq: 0, count: 0, changeKind: null, fakeFullBytes: 0 } }), {
      seq: 0,
      count: 0,
      changeKind: null,
      sinceIndex: null,
      fakeFullBytes: 0,
    });
    assert.equal(extractMessagesProbe({}), null, 'absent probe must read as unavailable');
    assert.equal(extractMessagesProbe(null), null);
    assert.equal(extractMessagesProbe({ _messagesProbe: { count: -1, changeKind: 'append' } }), null,
      'negative count must read as unavailable');
    assert.equal(extractMessagesProbe({ _messagesProbe: { count: 2, changeKind: 'bogus' } }), null,
      'unknown changeKind must read as unavailable');
  });
});

// ── Dev metrics ───────────────────────────────────────────────

test('metrics stay silent when the URL switch is off', async () => {
  await withPollHarness({
    initialMessages: [msg('m1')],
    overview: {
      modelName: 'model-a',
      _messagesProbe: { count: 1, changeKind: null, sinceIndex: 1, fakeFullBytes: 100 },
    },
    search: '',
  }, async (harness) => {
    await harness.sandbox.__poll();

    assert.equal(harness.consoleRecords.debug.length, 0, 'no [msg-metrics] output without ?msg_metrics=1');
  });
});

test('metrics emit actual/fake bytes, savedRatio, changeKind and downgraded flag', async () => {
  await withPollHarness({
    initialMessages: [msg('m1'), msg('m2')],
    overview: {
      modelName: 'model-a',
      _messagesProbe: { count: 2, changeKind: null, sinceIndex: 2, fakeFullBytes: 500 },
    },
    search: '?msg_metrics=1',
  }, async (harness) => {
    await harness.sandbox.__poll();

    assert.equal(harness.consoleRecords.debug.length, 1);
    const [tag, payload] = harness.consoleRecords.debug[0];
    assert.equal(tag, '[msg-metrics]');
    assert.deepEqual(plain(payload), {
      actualBytes: 0, // zero-request cycle
      fakeFullBytes: 500,
      savedRatio: 1,
      changeKind: null,
      downgraded: false,
    });
  });
});

test('metrics record a downgraded cycle with accumulated bytes from both fetches', async () => {
  await withPollHarness({
    initialMessages: [msg('m1'), msg('m2')],
    overview: {
      modelName: 'model-a',
      _messagesProbe: { seq: 1, count: 4, changeKind: 'append', sinceIndex: 2, fakeFullBytes: 1000 },
    },
    search: '?msg_metrics=1',
    messagesResponder: (path) => {
      if (path.endsWith('/messages?since=2')) {
        return { status: 200, body: { messages: [msg('m3')], baseCount: 2 } };
      }
      return { status: 200, body: { messages: [msg('f1'), msg('f2'), msg('f3')] } };
    },
  }, async (harness) => {
    await harness.sandbox.__poll();

    assert.equal(harness.consoleRecords.debug.length, 1);
    const [, payload] = harness.consoleRecords.debug[0];
    assert.equal(payload.downgraded, true);
    assert.equal(payload.changeKind, 'append');
    assert.ok(payload.actualBytes > 0, 'bytes from both the delta and the full fetch must be counted');
    assert.ok(payload.savedRatio < 1, 'a downgraded cycle cannot claim savings');
  });
});

// ── Seq reconciliation (ADR-0012 v2) ──────────────────────────
// probe.seq is the sync version number; changeKind is only a fetch-strategy
// hint for the LAST real change. These tests lock the fix for the
// first-message-delay regression: a no-op push after the user message enters
// the transcript must NOT hide the pending change from the frontend.

test('seq advance triggers the delta fetch even when changeKind is null', async () => {
  // Regression shape: user message landed (append, seq=1), then a no-op push
  // (old viewer cleared changeKind to null). The seq gate must still see the
  // pending change because count advanced past the known baseline.
  const m3 = msg('m3');
  await withPollHarness({
    initialMessages: [msg('m1'), msg('m2')],
    overview: {
      modelName: 'model-a',
      // changeKind null = the no-op push overwrote the classification hint
      _messagesProbe: { seq: 1, count: 3, changeKind: null, sinceIndex: 3, fakeFullBytes: 600 },
    },
    messagesResponder: (path) => {
      assert.ok(path.endsWith('/messages?since=2'), `unexpected messages url: ${path}`);
      return { status: 200, body: { messages: [m3], baseCount: 2 } };
    },
  }, async (harness) => {
    await harness.sandbox.__poll();

    assert.equal(messageCalls(harness.fetchCalls).length, 1, 'count advance with stale hint must still fetch');
    assert.deepEqual(plain(harness.sandbox.currentMessages), [msg('m1'), msg('m2'), m3]);
    assert.deepEqual(plain(harness.renders.append), [[m3]]);
  });
});

test('same count with equal seq skips the fetch even when changeKind lingers', async () => {
  // changeKind is a last-real-change hint, not a sync signal: an applied
  // append (seq already consumed) must not re-fetch on every cycle.
  await withPollHarness({
    initialMessages: [msg('m1'), msg('m2')],
    overview: {
      modelName: 'model-a',
      _messagesProbe: { seq: 1, count: 2, changeKind: 'append', sinceIndex: 1, fakeFullBytes: 500 },
    },
  }, async (harness) => {
    // First cycle: baseline never applied for this seq → full fetch is expected
    // via the prevKnownCount===0 gate? No — initialMessages pre-populates the
    // array, and this harness starts with no applied seq, so the first cycle
    // sees seq advance (0 → 1) with equal count and changeKind append. The
    // since-fetch validation (delta.length === count - since) fails → full.
    await harness.sandbox.__poll();
    const firstCycleCalls = messageCalls(harness.fetchCalls).length;
    assert.ok(firstCycleCalls >= 1, 'first cycle must reconcile the unseen seq');

    // Second cycle: seq already applied → zero /messages requests.
    harness.fetchCalls.length = 0;
    await harness.sandbox.__poll();
    assert.equal(messageCalls(harness.fetchCalls).length, 0,
      'applied seq with unchanged count must skip /messages entirely');
  });
});

test('same count with advanced seq and tail hint takes the tail path once', async () => {
  // rewrite/tail with unchanged count: the seq gate ensures the change is
  // applied exactly once, then subsequent cycles skip.
  const m2v2 = msg('m2-streamed');
  let tailServed = 0;
  await withPollHarness({
    initialMessages: [msg('m1'), msg('m2-streaming')],
    overview: {
      modelName: 'model-a',
      _messagesProbe: { seq: 1, count: 2, changeKind: 'tail', sinceIndex: 1, fakeFullBytes: 700 },
    },
    messagesResponder: (path) => {
      assert.ok(path.endsWith('/messages?tail=1'), `unexpected messages url: ${path}`);
      tailServed += 1;
      return { status: 200, body: { messages: [m2v2] } };
    },
  }, async (harness) => {
    await harness.sandbox.__poll();
    assert.equal(tailServed, 1);
    assert.deepEqual(plain(harness.sandbox.currentMessages), [msg('m1'), m2v2]);

    // Next cycle: seq consumed → no fetch, applied tail stays.
    harness.fetchCalls.length = 0;
    await harness.sandbox.__poll();
    assert.equal(messageCalls(harness.fetchCalls).length, 0, 'applied tail must not refetch');
    assert.deepEqual(plain(harness.sandbox.currentMessages), [msg('m1'), m2v2]);
  });
});

test('count equal but seq advanced without a usable hint degrades to full once', async () => {
  // count unchanged, seq advanced, changeKind null (hint overwritten by a
  // no-op): content changed somewhere unknown → full fetch to stay correct.
  const full = [msg('m1'), msg('m2-REPLACED')];
  await withPollHarness({
    initialMessages: [msg('m1'), msg('m2')],
    overview: {
      modelName: 'model-a',
      _messagesProbe: { seq: 1, count: 2, changeKind: null, sinceIndex: 2, fakeFullBytes: 500 },
    },
    messagesResponder: (path) => {
      assert.ok(path.endsWith('/messages'), `unknown-content change must fetch full: ${path}`);
      return { status: 200, body: { messages: full } };
    },
  }, async (harness) => {
    await harness.sandbox.__poll();

    assert.deepEqual(messageCalls(harness.fetchCalls), ['/api/agents/rt/messages']);
    assert.deepEqual(plain(harness.sandbox.currentMessages), full);

    // Applied → subsequent cycles skip.
    harness.fetchCalls.length = 0;
    await harness.sandbox.__poll();
    assert.equal(messageCalls(harness.fetchCalls).length, 0);
  });
});
