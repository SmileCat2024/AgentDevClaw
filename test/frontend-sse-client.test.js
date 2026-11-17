/**
 * Tests for public/src/modules/sse-client.js（P2 W2-2 迁移后：真实 ESM import 路线）
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
 *
 * 加载路线（每个用例 = 一份 window + 一张 ESM 图）：
 *   - classic 相（`sandbox.loadSource`）：action-dispatcher → app-core →
 *     session-view-state → sidebar-render → runtime-status → todo-plan →
 *     rollback-dialog → app-main。这些仍是 classic 唯一实现，提供 sse-client 图内各宿主工厂
 *     （createAgentCallStatesHost / createMetadataCommitHost / createMessageProbeHost /
 *     createAgentSnapshotLoaderHost / createRuntimeNotFoundHost …）与状态容器。
 *   - ESM 相（`c.load`）：agent-data-loader（两个 host 工厂 seam）与 sse-client
 *     真实 import；其静态依赖
 *     （orchestration-state / agent-store-state / i18n-environment-state /
 *     agent-call-states-host / metadata-commit-host / message-probe-host /
 *     agent-snapshot-loader-host / runtime-not-found-host / session-view-commit-host /
 *     toast-notify）在图内真实执行并各自 claim 桥域。
 *   - 断言走公开面：命名导出、真实桥键状态（_agentCallActive /
 *     currentTodoPlan / currentInputRequests / currentMessages）、SSE 事件帧、
 *     网络请求（fetch 桩）。不再读 classic 函数被调用的计数副本。
 *   - 两个 classic 汇点按生产接缝注入：updateNotificationStatus（runtime-status
 *     的通知主逻辑，自有用例在 frontend-session-view-runtime-state.test.js）、
 *     renderAgentList（sidebar-render 侧栏渲染）——它们都是 sse-client 经
 *     window 调用、调用时点晚绑定的桥接期函数。
 *   - 排队气泡投影不再是注入口：sse-client 已具名 import
 *     applyQueuedInputsTexts，消费面经真实排队投影写入的 input-queue 状态观测。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const SSE_CLIENT = 'public/src/modules/sse-client.js';
const TOAST_NOTIFY = 'public/src/modules/toast-notify.js';
const THREAD_STORE = 'public/src/modules/thread-store.js';

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

function latestSource() {
  return MockEventSource.instances[MockEventSource.instances.length - 1] || null;
}

/** 真实 DOM 形状的元素桩（classic 宿主工厂与 toast 渲染面会读这些字段）。 */
function makeElement() {
  return {
    innerHTML: '', textContent: '', value: '', className: '', style: {}, dataset: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, insertBefore() {}, remove() {}, replaceWith() {},
    focus() {}, blur() {}, click() {}, select() {}, setSelectionRange() {}, scrollIntoView() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; },
    closest() { return null; }, matches() { return false; }, contains() { return false; },
    insertAdjacentHTML() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    getAttribute() { return null; }, setAttribute() {}, removeAttribute() {}, hasAttribute() { return false; },
    getElementsByTagName() { return []; }, getElementsByClassName() { return []; },
  };
}

function createDocumentStub() {
  const elements = new Map();
  return {
    elements,
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id);
      },
      createElement: () => makeElement(),
      createTextNode: (text) => ({ textContent: text }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {},
      getElementsByTagName: () => [], getElementsByClassName: () => [],
      body: makeElement(), head: makeElement(), documentElement: makeElement(),
      readyState: 'complete',
    },
  };
}

/**
 * app-main 顶层与宿主工厂仍依赖的 classic 全局（真实页面由更早的 classic
 * 文件提供）。`__clawAuthReady` 永不 resolve，挡住页面 boot 主链——本文件测
 * SSE 消费语义，不跑 boot。
 */
const APP_MAIN_PRELUDE = `
  getCurrentHostAgentRecord = () => ({ id: 'programming-helper', source: 'prebuilt' });
  renderCurrentMainView = () => {};
  renderFeaturePanel = () => {};
  resetRuntimeStatusForSwitch = () => {};
  applyLanguage = () => {};
  applyTheme = () => {};
  isChatSurfaceActive = () => true;
  getRuntimeAwareAgentRecord = () => null;
  notifyChatViewportMutation = () => {};
  isRemoteNamespaceAgentId = (value) => typeof value === 'string' && value.startsWith('remote:');
  getEmptyOverviewSnapshot = () => ({ empty: true });
  getEmptyTodoPlan = () => ({ tasks: [] });
  notifyInputSurfaceChanged = () => {};
  getAgentRuntimeId = (agent) => agent?.id || '';
  window.__clawAuthReady = new Promise(() => {});
`;

/**
 * classic 汇点覆盖（必须在 classic 文件加载之后执行，否则被同名函数声明覆盖）：
 *   - updateNotificationStatus：runtime-status 的通知主逻辑（本文件只关心它是否
 *     被焦点事件路由到，及其收到的 token）；
 *   - renderAgentList：侧栏渲染，用例观察边沿变化触发的渲染次数。
 */
const SINK_OVERRIDES = `
  updateNotificationStatus = (p, runtimeId, token) => window.__sinkUpdateNotificationStatus(p, runtimeId, token);
  renderAgentList = () => window.__sinkRenderAgentList();
  window.ClawFW = window.ClawFW || {};
  window.ClawFW.forceFullPollOnce = () => window.__sinkForceFullPoll();
  window._syncForegroundState = () => window.__sinkForegroundSync();
`;

/**
 * 本文件允许的既有生产诊断（逐条理由；其余任何 warn/error 一律失败）：
 *   - 【sidebar】empty connected snapshot：fixture 没有已连接 agent（connected
 *     与 viewer 两侧快照皆空）时 loadAgents 的稳态提示，不是失败。
 */
const NOISE_ALLOWED = [/^warn: \[sidebar\] empty connected snapshot/];

/**
 * 用例级控制台噪音捕获：production 的 `host.warn` / `promise.catch` 会把失败
 * 降级成 warn（sse-client 的 probe `.catch`、轮询 catch），测试若不看输出就会
 * 带着 ReferenceError 变绿。case 内接管 console.warn / console.error，用例结束
 * 断言为空——不吞错、不靠捕获让测试绿。
 */
function captureConsoleNoise(allowed = []) {
  const entries = [];
  const original = { warn: console.warn, error: console.error };
  const record = (level) => (...args) => {
    const line = `${level}: ${args.map((value) => (value instanceof Error ? value.message : String(value))).join(' ')}`;
    entries.push(line);
  };
  console.warn = record('warn');
  console.error = record('error');
  return {
    entries,
    restore() {
      console.warn = original.warn;
      console.error = original.error;
    },
    assertClean(label) {
      const unexpected = entries.filter((line) => !allowed.some((pattern) => pattern.test(line)));
      assert.deepEqual(unexpected, [],
        `${label} 不得出现非预期 warn/error 输出：\n${unexpected.join('\n')}`);
    },
  };
}

/** 在「非预期 warn/error 必须为空」的守卫下跑一个 case（失败也要还原 console）。 */
async function withNoiseClean(label, fn) {
  const noise = captureConsoleNoise(NOISE_ALLOWED);
  try {
    const result = await fn();
    noise.assertClean(label);
    return result;
  } finally {
    noise.restore();
  }
}

/**
 * 建立一个用例的完整加载链，并把 classic 汇点接到记录器上。
 *
 * @param {object} [opts]
 * @param {Function} [opts.fetch] 网络桩（默认全部空成功响应）
 * @param {object} [opts.globals] 额外注入的全局
 */
async function withSseCase(opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  const { fetch, globals: extraGlobals = {} } = opts || {};
  const calls = {
    updateNotificationStatus: [],
    renders: [],
    forceFullPoll: 0,
    foregroundSyncs: 0,
    fetches: [],
  };
  const { document } = createDocumentStub();
  const jsonResponse = (body, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
  });
  const fetchStub = async (url) => {
    const target = String(url);
    calls.fetches.push(target);
    // 用例自定义端点优先；返回 undefined 表示「用链路默认桩」
    if (fetch) {
      const custom = await fetch(target, { calls, document });
      if (custom !== undefined) return custom;
    }
    if (target === '/api/agents') return jsonResponse({ agents: [], connected: [] });
    if (target.includes('/protoclaw/get_connected_agents')) return jsonResponse([]);
    if (target.includes('/protoclaw/threads')) return jsonResponse({ threads: [] });
    return jsonResponse({});
  };

  MockEventSource.instances.length = 0;

  return withP2EsmCase({
    classic: (sandbox) => {
      // 真实先行脚本序（test/p2-classic-hosts.js）：宿主工厂（runtime-switch / poll /
      // workspace-surface / 侧栏 call 状态）都是生产实现，首屏 boot 与周期排程由基座
      // 关掉。基座之外按 index.html 顺序补真实 classic：todo 归一 / partial compact 状态 /
      // 输入面经典边界（排队投影经 window 直调这四支实现并共享同域状态键）。
      prepareClassicSandbox(sandbox);
      // 用例的窄行为观察面（真源之后覆盖：app-main / app-ui 会定义同名入口）：
      // 本文件只关心 SSE 事件路由与状态提交，渲染与 UI 落点用记录器。
      sandbox.run(APP_MAIN_PRELUDE);
      // todo-plan 已迁 ESM（P4 L1）：classic 相只补它装载期要用的 vendor 面与
      // markdown-utils 的 classic 实现（escapeHtml / renderer），模块本体在 async 相 c.load。
      sandbox.loadSource('public/src/modules/markdown-bootstrap.js');
      // rollback-dialog 已迁 ESM（P4 T2）：注册壳改由 async 相 c.load 装载。
      sandbox.loadSource('public/src/modules/persistent-input.js');
      // 观察面（真源之后覆盖）：本例只验证 SSE 事件路由与提交语义，不驱动主视图 /
      // 聊天的 DOM 落地。
      sandbox.run(SINK_OVERRIDES);
      // 线程暂存文本经交互域取自 classic 刷新引擎：按生产顺序装真实引擎，不复制宿主契约。
      sandbox.loadSource('public/src/modules/thread-store.js');
    },
    globals: {
      document,
      EventSource: MockEventSource,
      URLSearchParams,
      ClawToast: { show() {} },
      // vendor 解析器 / 高亮库：markdown-bootstrap 装载期构造 Renderer 并查 hljs。
      marked: { Renderer: class { constructor() {} }, setOptions() {}, parse: () => '' },
      hljs: { getLanguage: () => null, highlight: () => ({ value: '' }) },
      // 以下 classic 汇点不属于本文件的验收面（SSE 事件路由与提交语义），
      // 按既有注入面提供：desktop-notify 的调用起点埋点，以及 metadata commit
      // 渲染链上的 UI 落点（输入面同步 / 回退按钮 / 上下文栏 / 模型切换器）。
      _markAgentCallStartedForNotify: () => {},
      _syncPersistentInputUi: () => {},
      // 工作区表面判定（app-ui）与聊天 DOM 渲染落点（chat-renderer / app-ui）：
      // 本文件验证 SSE 事件路由与状态提交语义，不驱动主视图 DOM 渲染——真实
      // 聊天渲染链的端到端断言在 frontend-rollback-edit-buttons-race.test.js。
      // false =「当前是对话表面」，与该文件一致。
      shouldRenderWorkspaceSurface: () => false,
      renderCurrentMainView: () => {},
      appendNewMessages: () => {},
      updateLastMessage: () => {},
      updateRollbackActionVisibility: () => {},
      updateChatContextBar: () => {},
      updateInputModelSwitcher: () => {},
      updateThinkingEffortSwitcher: () => {},
      // 浏览器平台全局：sidebar-render 的宿主工厂用它给快照打时间戳
      performance: { now: () => Date.now() },
      fetch: fetchStub,
      __sinkUpdateNotificationStatus: (p, runtimeId, token) => {
        calls.updateNotificationStatus.push({ p, runtimeId, token });
      },
      __sinkRenderAgentList: () => { calls.renders.push(1); },
      __sinkForceFullPoll: () => { calls.forceFullPoll += 1; },
      __sinkForegroundSync: () => { calls.foregroundSyncs += 1; },
      ...extraGlobals,
    },
  }, async (c) => withNoiseClean('sse-client 用例', async () => {
    // 回退 / 压缩域状态键注册壳（已迁 ESM，P4 T2）：真实 import，桥键由模块自身注册。
    await c.load('public/src/modules/rollback-dialog.js');
    // plan 快照归一 / 成对签名（已迁 ESM，P4 L1）：经典侧经桥键调用它的命名导出。
    await c.load('public/src/modules/todo-plan.js');
    // 焦点 runtime：生产由切换链写入 orchestration owner
    const orchestration = await c.load('public/src/modules/orchestration-state.js');
    orchestration.setCurrentRuntimeAgentId('rt-focus');

    // message-timeline 的 ESM owner：app-main 的 message-probe 宿主经桥键调用
    // attachMessagesTimestamps（probe 周期落地时间戳）
    // agent-data-loader（已迁 ESM）：session-data-loader / runtime-status-loader 的
    // host 工厂 seam，必须先于消费它们的 host 模块求值
    await c.load('public/src/modules/agent-data-loader.js');
    await c.load('public/src/modules/message-timeline.js');
    // overview 归一/签名（metadata commit 的 overview normalizer）
    await c.load('public/src/modules/overview-data.js');
    // 标题候选/首个变更行判定（提交后渲染选路）：app-main 的 renderer host 经桥键调用
    await c.load('public/src/modules/auto-title.js');
    const sse = await c.load(SSE_CLIENT);
    // 真实 toast 模块对象：用例只把它的 show 换成记录器（DOM 渲染面不在本文件
    // 的验收范围），case 结束在 finally 里还原。
    const toastModule = await c.load(TOAST_NOTIFY);
    const realShow = toastModule.ClawToast.show;
    const toasts = [];
    toastModule.ClawToast.show = (spec) => { toasts.push(spec); };
    try {
      return await fn({
        c,
        sse,
        calls,
        toasts,
        document,
        // 焦点 runtime 的真实写入口（桥键访问器 → ESM owner 双向转发）
        setFocus: (runtimeId) => { c.read(`currentRuntimeAgentId = ${JSON.stringify(runtimeId)}`); },
      });
    } finally {
      toastModule.ClawToast.show = realShow;
    }
  }));
}

/** 只影响建连模式解析（?sse=0 / ?sse=1 / 缺省），用例内晚绑定到 window.location。 */
const setLocation = (c, search) => {
  c.window.location = { search, href: `http://x/${search}` };
};

describe('sse-client: URL 开关', () => {
  it('?sse=0 禁用：boot 不建连，isSseActive 恒 false', async () => {
    await withSseCase(async ({ c, sse }) => {
      setLocation(c, '?sse=0');
      sse.bootSseClient();
      assert.equal(MockEventSource.instances.length, 0);
      assert.equal(sse.isSseActive(), false);
      assert.equal(c.read('isSseActive()'), false);
    });
  });

  it('缺省 auto：boot 建连，hello 后激活', async () => {
    await withSseCase(async ({ c, sse }) => {
      setLocation(c, '');
      sse.bootSseClient();
      const src = latestSource();
      assert.ok(src);
      assert.equal(src.url, '/protoclaw/events');
      assert.equal(sse.isSseActive(), false);
      src.emit('hello', { hello: true });
      assert.equal(sse.isSseActive(), true);
      assert.equal(c.read('isSseActive()'), true, '桥键（app-main / persistent-input 裸标识符消费）同步激活');
    });
  });
});

describe('sse-client: thread subscriptions', () => {
  it('keeps sidebar discovery URL constant with a large history and discovers new threads', async () => {
    let threads = Array.from({ length: 1000 }, (_, i) => ({
      threadId: `wt-${String(i).padStart(36, '0')}`, agentId: 'coder', sessionIds: [],
    }));
    await withSseCase({
      fetch: async (target) => {
        if (target.includes('/protoclaw/threads')) {
          return { ok: true, status: 200, json: async () => ({ threads }) };
        }
        // 真实 thread-store 的刷新链会顺带触发 loadAgents：权威连接快照按生产
        // 形状回答（get_connected_agents 是数组，/api/agents 是 { agents }）。
        if (target.includes('/protoclaw/get_connected_agents')) {
          return { ok: true, status: 200, json: async () => [] };
        }
        return { ok: true, status: 200, json: async () => ({ agents: [], connected: [] }) };
      },
    }, async ({ c, sse, calls }) => {
      sse.bootSseClient();
      // 真实 thread-store（classic）已在 classic 相装载：它经 window.ClawFW.SseClient
      // 订阅 thread 事件；此处不重复装载（同一沙箱二次求值会重复声明顶层 const）。
      const textsUrlCount = () => calls.fetches.filter((u) => u.includes('/protoclaw/threads')).length;

      await c.window.refreshThreads(true);
      const source = latestSource();
      assert.equal(source.url, '/protoclaw/events?threads=*');
      const connections = MockEventSource.instances.length;
      threads = [...threads, { threadId: 'brand-new', agentId: 'coder', sessionIds: [] }];
      source.emit('thread.created', { threadId: 'brand-new' });
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(textsUrlCount() >= 2);
      assert.ok(c.window.ClawThreads.byId['brand-new']);
      assert.equal(MockEventSource.instances.length, connections, 'history changes must not rebuild the stream');
    });
  });

  it('combines wildcard and targeted handlers without duplicate delivery and releases subscriptions', async () => {
    await withSseCase(async ({ c, sse }) => {
      sse.bootSseClient();
      const calls = [];
      const shared = (event) => calls.push(event.threadId);
      const subscribe = c.window.ClawFW.SseClient.subscribeThreadEvents;
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
});

describe('sse-client: hello 帧', () => {
  it('resynced 触发一次全量对账', async () => {
    await withSseCase(async ({ sse, calls }) => {
      sse.bootSseClient();
      latestSource().emit('hello', { hello: true, resynced: true });
      assert.equal(calls.forceFullPoll, 1);
    });
  });

  it('choiceAlerts 首连扫描出 toast，且与 _seenChoiceAlertIds 共享去重', async () => {
    await withSseCase(async ({ c, sse, toasts }) => {
      sse.bootSseClient();
      latestSource().emit('hello', {
        hello: true,
        choiceAlerts: [{ requestId: 'req-1', agentId: 'rt-other', agentName: 'Other' }],
      });
      assert.equal(toasts.length, 1);
      assert.equal(toasts[0].id, 'choice-alert-req-1');
      // 去重容器是 app-core 的真实 classic Set（经 bootstrap 适配对象按引用交出）
      assert.equal(c.read('_seenChoiceAlertIds.has("req-1")'), true);
      // 同一 requestId 不再 toast（事件再发也跳过）
      latestSource().emit('input-requests', {
        kind: 'input-requests', agentId: 'rt-other',
        data: [{ requestId: 'req-1', mode: 'choices' }],
      });
      assert.equal(toasts.length, 1);
    });
  });
});

describe('sse-client: 事件分发焦点路由', () => {
  it('notification 焦点 → updateNotificationStatus；非焦点 → applyAgentCallStateFromNotification', async () => {
    await withSseCase(async ({ c, sse, calls }) => {
      sse.bootSseClient();
      latestSource().emit('hello', { hello: true });
      const payload = { callActive: true, state: null };
      latestSource().emit('notification', { kind: 'notification', agentId: 'rt-focus', data: payload });
      assert.equal(calls.updateNotificationStatus.length, 1);
      // dispatch 经 JSON 往返（事件帧 data），断言内容而非引用
      assert.deepEqual(calls.updateNotificationStatus[0].p, payload);
      assert.equal(calls.updateNotificationStatus[0].runtimeId, 'rt-focus');
      assert.equal(calls.updateNotificationStatus[0].token.runtimeId, 'rt-focus');
      // 非焦点路径改走真实 agent-call-states ESM：共享的调用状态容器被写入
      assert.equal(c.read('_agentCallActive.has("rt-other")'), false);
      // 事件到达顺带刷新前台时钟（§5.4 时钟源钩子）
      assert.ok(calls.foregroundSyncs >= 1);

      latestSource().emit('notification', { kind: 'notification', agentId: 'rt-other', data: payload });
      assert.equal(calls.updateNotificationStatus.length, 1);
      assert.equal(c.read('_agentCallActive.get("rt-other")'), true,
        '非焦点通知经真实 applyAgentCallStateFromNotification 落到共享调用状态');
    });
  });

  it('ADR-0019 非焦点边沿变化 → apply 返回 true → 即时 renderAgentList（唤醒轮转圈/挂起绿灯显形）', async () => {
    await withSseCase(async ({ c, sse, calls }) => {
      sse.bootSseClient();
      latestSource().emit('hello', { hello: true });
      const payload = { callActive: true, state: null };
      // 边沿变化（calling 由「无」翻到 true）：真实 applyAgentCallState 返回 true → 渲染
      latestSource().emit('notification', { kind: 'notification', agentId: 'rt-other', data: payload });
      assert.equal(c.read('_agentCallActive.get("rt-other")'), true);
      assert.equal(calls.renders.length, 1, '边沿变化即时渲染，不依赖其他渲染事件');
      // 无边沿变化（幂等 apply）：不渲染
      latestSource().emit('notification', { kind: 'notification', agentId: 'rt-other', data: payload });
      assert.equal(c.read('_agentCallActive.get("rt-other")'), true);
      assert.equal(calls.renders.length, 1, '幂等事件不重复渲染');
    });
  });

  it('todo / overview 事件只消费焦点，走 commitMetadataUpdate', async () => {
    await withSseCase(async ({ c, sse }) => {
      sse.bootSseClient();
      latestSource().emit('hello', { hello: true });
      c.read(`applySessionViewPatch({ identity: { agentId: 'agent-1', sessionId: 'session-a' } })`);
      const todoBefore = c.read('JSON.stringify(currentTodoPlan)');
      const overviewBefore = c.read('JSON.stringify(currentOverviewSnapshot)');

      // 焦点 todo：断言归一后的具体内容（字段、计数、摘要），不只证明「变了」
      latestSource().emit('todo', {
        kind: 'todo', agentId: 'rt-focus',
        data: { tasks: [{ id: 't1', subject: '归一后仍在', status: 'in_progress' }] },
      });
      const todo = JSON.parse(c.read('JSON.stringify(currentTodoPlan)'));
      assert.deepEqual(
        todo.tasks.map((task) => ({ id: task.id, subject: task.subject, status: task.status })),
        [{ id: 't1', subject: '归一后仍在', status: 'in_progress' }],
        '焦点 todo 归一后逐条落地',
      );
      assert.equal(todo.counter, 1);
      assert.deepEqual(todo.summary, { total: 1, pending: 0, inProgress: 1, completed: 0, cancelled: 0 });
      assert.equal(c.read('JSON.stringify(currentOverviewSnapshot)'), overviewBefore,
        'todo 帧只提交 todo 维度，不污染 overview');

      // overview 帧带可观测差异（updatedAt / usageStats）：归一后签名改变才会提交
      latestSource().emit('overview', {
        kind: 'overview', agentId: 'rt-focus',
        data: { updatedAt: 1791509161407, usageStats: { totalRequests: 3 } },
      });
      assert.equal(c.read('currentOverviewSnapshot.usageStats.totalRequests'), 3);
      assert.equal(c.read('currentOverviewSnapshot.updatedAt'), 1791509161407);
      assert.deepEqual(JSON.parse(c.read('JSON.stringify(currentTodoPlan)')), todo,
        'overview 帧不得回头改写已提交的 todo 维度');

      // 非焦点 todo：当前视图逐字段不变（不是只比字符串快照）
      latestSource().emit('todo', {
        kind: 'todo', agentId: 'rt-other',
        data: { tasks: [{ id: 'other-1', subject: '不应进入当前视图' }] },
      });
      assert.deepEqual(JSON.parse(c.read('JSON.stringify(currentTodoPlan)')), todo,
        '非焦点 todo 不提交到当前视图');
    });
  });

  it('input-requests 焦点 → commitMetadataUpdate；非焦点 → choice toast', async () => {
    await withSseCase(async ({ c, sse, toasts }) => {
      sse.bootSseClient();
      latestSource().emit('hello', { hello: true });
      latestSource().emit('input-requests', {
        kind: 'input-requests', agentId: 'rt-focus',
        data: [{ requestId: 'req-f', mode: 'choices' }],
      });
      assert.deepEqual(JSON.parse(c.read('JSON.stringify(currentInputRequests)')),
        [{ requestId: 'req-f', mode: 'choices' }], '焦点租约经真实 commit 落地');
      latestSource().emit('input-requests', {
        kind: 'input-requests', agentId: 'rt-other',
        data: [{ requestId: 'req-x', mode: 'choices', questions: ['继续吗'] }],
      });
      assert.equal(toasts.length, 1);
      assert.equal(toasts[0].id, 'choice-alert-req-x');
      assert.deepEqual(JSON.parse(c.read('JSON.stringify(currentInputRequests)')),
        [{ requestId: 'req-f', mode: 'choices' }], '非焦点租约不改当前视图');
    });
  });

  it('input-requests 帧不触发桌面通知（ADR-0030：通知由 server app-notification 帧驱动）', async () => {
    const notified = [];
    await withSseCase({
      globals: { _presentAppNotification: (frame) => notified.push(frame) },
    }, async ({ sse }) => {
      sse.bootSseClient();
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
  });

  it('app-notification 帧分发给 _presentAppNotification（全局帧，不按焦点分流）', async () => {
    const notified = [];
    await withSseCase({
      globals: { _presentAppNotification: (frame) => notified.push(frame) },
    }, async ({ sse }) => {
      sse.bootSseClient();
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
  });

  it('非焦点 input-requests 非 choices 租约不 toast（F1：文本输入请求不误报等待选择）', async () => {
    await withSseCase(async ({ sse, toasts }) => {
      sse.bootSseClient();
      latestSource().emit('hello', { hello: true });
      latestSource().emit('input-requests', {
        kind: 'input-requests', agentId: 'rt-other',
        data: [
          { requestId: 'req-text', mode: 'text' },
          { requestId: 'req-empty', mode: 'choices', questions: [] },
        ],
      });
      assert.equal(toasts.length, 0);
    });
  });

  it('非焦点 choice 帧 toast 照常，桌面通知不经此路径（ADR-0030）', async () => {
    const notified = [];
    await withSseCase({
      globals: { _presentAppNotification: (frame) => notified.push(frame) },
    }, async ({ sse, toasts }) => {
      sse.bootSseClient();
      latestSource().emit('hello', { hello: true });
      latestSource().emit('input-requests', {
        kind: 'input-requests', agentId: 'rt-other',
        data: [{ requestId: 'req-nf', mode: 'choices', questions: ['继续吗'] }],
      });
      // toast 保留（回前台可见）；桌面通知由 server 统一出口的
      // app-notification 帧驱动，input-requests 帧不触发
      assert.equal(toasts.length, 1);
      assert.equal(notified.length, 0);
      // 同 requestId 重复帧：_seenChoiceAlertIds 去重，toast 不重触发
      latestSource().emit('input-requests', {
        kind: 'input-requests', agentId: 'rt-other',
        data: [{ requestId: 'req-nf', mode: 'choices', questions: ['继续吗'] }],
      });
      assert.equal(toasts.length, 1);
    });
  });

  it('messages probe 返回 handled404 → 触发 runtime 消失处理（F3）', async () => {
    await withSseCase({
      fetch: async (target) => {
        if (target.includes('/messages')) return { ok: false, status: 404, json: async () => ({}) };
        if (target === '/api/agents') return { ok: true, status: 200, json: async () => ({ agents: [] }) };
        if (target.includes('/protoclaw/get_connected_agents')) return { ok: true, status: 200, json: async () => [] };
        return { ok: true, status: 200, json: async () => ({}) };
      },
    }, async ({ c, sse, calls }) => {
      sse.bootSseClient();
      latestSource().emit('hello', { hello: true });
      c.read(`applySessionViewPatch({ identity: { agentId: 'agent-1', sessionId: 'session-a' } })`);
      c.read('currentMessages = [{ role: "user", content: "old" }]');
      latestSource().emit('messages', { kind: 'messages', agentId: 'rt-focus', probe: { seq: 1 } });
      await new Promise((resolve) => setTimeout(resolve, 10));
      // token.runtimeId 是 rt-focus：消息探针只打该 runtime 的端点
      assert.ok(calls.fetches.some((u) => u === '/api/agents/rt-focus/messages'),
        `实际请求: ${calls.fetches.join(', ')}`);
      // runtime 消失处理：视图被清空 + 触发一次侧栏全量刷新
      assert.deepEqual(JSON.parse(c.read('JSON.stringify(currentMessages)')), []);
      assert.ok(calls.fetches.filter((u) => u === '/api/agents').length >= 1,
        'runtime 消失后必须重载 agent 列表');
    });
  });

  it('queued-inputs 事件更新快照缓存并消费文本', async () => {
    await withSseCase(async ({ c, sse }) => {
      sse.bootSseClient();
      latestSource().emit('hello', { hello: true });
      latestSource().emit('queued-inputs', {
        kind: 'queued-inputs', agentId: 'rt-focus',
        data: [{ id: 'q-1', text: '排队A' }],
      });
      // 消费面是真实排队投影（sse-client 已具名 import applyQueuedInputsTexts）：
      // 看它写入的排队气泡 state（KernelState 桥键读的就是 owner 的活绑定）。
      assert.deepEqual(JSON.parse(c.read('JSON.stringify(_queuedTexts)')), ['排队A']);
      assert.equal(c.read('_pendingQueuedCount'), 1);
      const snap = sse.getLastQueuedSnapshot('rt-focus');
      assert.equal(snap.items.length, 1);
      // runtime 不匹配时无缓存
      assert.equal(sse.getLastQueuedSnapshot('rt-other'), null);
    });
  });

  it('非焦点 runtime 的队列消费事件更新缓存，切回时不复用过期气泡', async () => {
    await withSseCase(async ({ c, sse, setFocus }) => {
      sse.bootSseClient();
      latestSource().emit('hello', { hello: true });

      latestSource().emit('queued-inputs', {
        kind: 'queued-inputs', agentId: 'rt-focus',
        data: [{ id: 'q-1', text: '已送达的消息' }],
      });
      setFocus('rt-other');
      latestSource().emit('queued-inputs', {
        kind: 'queued-inputs', agentId: 'rt-focus', data: [],
      });

      assert.deepEqual(JSON.parse(c.read('JSON.stringify(_queuedTexts)')), ['已送达的消息'],
        '非焦点队列快照不能直接改当前输入框');
      setFocus('rt-focus');
      const snapshot = sse.getLastQueuedSnapshot('rt-focus');
      assert.deepEqual(snapshot.items, [],
        '切回 runtime 时应取得离开期间最新的空队列，而不是旧的排队消息');
    });
  });

  it('queued-inputs 事件按身份过滤：reminder 不进气泡文本与待发送计数', async () => {
    await withSseCase(async ({ c, sse }) => {
      sse.bootSseClient();
      latestSource().emit('hello', { hello: true });
      latestSource().emit('queued-inputs', {
        kind: 'queued-inputs', agentId: 'rt-focus',
        data: [
          { id: 'q-1', text: '用户消息' },
          { id: 'q-2', text: '面板动作通报', kind: 'reminder' },
          { id: 'q-3', text: '下一条用户消息' },
        ],
      });
      assert.deepEqual(JSON.parse(c.read('JSON.stringify(_queuedTexts)')), ['用户消息', '下一条用户消息']);
      assert.equal(c.read('_pendingQueuedCount'), 2);
      // 快照缓存保留全量（对账/调试事实），过滤只发生在展示层
      const snap = sse.getLastQueuedSnapshot('rt-focus');
      assert.equal(snap.items.length, 3);
    });
  });

  it('messages 事件携带 probe 走 runMessagesProbeCycle（仅焦点）', async () => {
    const probe = { seq: 7, count: 3, changeKind: 'append', sinceIndex: 0, fakeFullBytes: 128 };
    await withSseCase({
      fetch: async (target) => {
        if (target.includes('/messages')) {
          return { ok: true, status: 200, json: async () => ({ messages: [{ role: 'user' }, { role: 'assistant' }, { role: 'user' }], timestamps: [] }) };
        }
        return { ok: true, status: 200, json: async () => ({ agents: [] }) };
      },
    }, async ({ c, sse, calls }) => {
      sse.bootSseClient();
      latestSource().emit('hello', { hello: true });
      c.read(`applySessionViewPatch({ identity: { agentId: 'agent-1', sessionId: 'session-a' } })`);
      const messageCalls = () => calls.fetches.filter((u) => u.includes('/messages'));

      latestSource().emit('messages', { kind: 'messages', agentId: 'rt-other', probe });
      assert.equal(messageCalls().length, 0, '非焦点 runtime 的 probe 不取数');

      latestSource().emit('messages', { kind: 'messages', agentId: 'rt-focus', probe });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(messageCalls().length, 1);
      assert.ok(messageCalls()[0].startsWith('/api/agents/rt-focus/messages'),
        `token.runtimeId 必须是焦点 runtime：${messageCalls()[0]}`);
      assert.equal(JSON.parse(c.read('JSON.stringify(currentMessages)')).length, 3,
        'probe 周期的取数结果经真实 commit 落地');
    });
  });

  it('connection 事件 → loadAgents；reconnected → 全量对账', async () => {
    await withSseCase(async ({ sse, calls }) => {
      sse.bootSseClient();
      latestSource().emit('hello', { hello: true });
      const agentListLoads = () => calls.fetches.filter((u) => u === '/api/agents').length;
      latestSource().emit('connection', { kind: 'connection', agentId: 'rt-focus', connected: false });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(agentListLoads(), 1);
      latestSource().emit('connection', { kind: 'connection', agentId: 'rt-1', connected: true, reconnected: true });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(calls.forceFullPoll, 1);
      assert.equal(agentListLoads(), 2);
    });
  });

  it('shutdown 帧立即降级（isSseActive=false）', async () => {
    await withSseCase(async ({ sse }) => {
      sse.bootSseClient();
      latestSource().emit('hello', { hello: true });
      latestSource().emit('shutdown', {});
      assert.equal(sse.isSseActive(), false);
    });
  });
});

describe('sse-client: 熔断与 401 闭环', () => {
  it('连续 3 次 CLOSED 失败进入冷却：期间不再建连', async () => {
    // retry 的 setTimeout 注入为受控回调队列：fail 后手动 flush 即时重连，
    // 不等真实 3s（测试预算）
    const retryQueue = [];
    await withSseCase({
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    }, async ({ c, sse }) => {
      // 生产代码经 window.setTimeout 排重试：换成受控队列（case 内晚绑定）
      c.window.setTimeout = (fn) => { retryQueue.push(fn); return retryQueue.length; };
      sse.bootSseClient();
      for (let i = 0; i < 3; i++) {
        latestSource().fail(MockEventSource.CLOSED);
        // probeAuthThenRetry 的 fetch 是 microtask：让出一拍后 flush 重试回调
        await new Promise((resolve) => setTimeout(resolve, 5));
        retryQueue.splice(0).forEach((fn) => fn());
      }
      // 第 3 次失败进入冷却：scheduleRetry(60s) 入队但不 flush
      const countAfterFailures = MockEventSource.instances.length;
      assert.ok(countAfterFailures >= 3, '应有多次尝试');
      // 冷却期（60s）内 bootSseClient 不再建连
      sse.bootSseClient();
      assert.equal(MockEventSource.instances.length, countAfterFailures);
      assert.equal(sse.isSseActive(), false);
    });
  });

  it('致命失败探测到 401 → 停止重连', async () => {
    await withSseCase({
      fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    }, async ({ sse }) => {
      sse.bootSseClient();
      const src = latestSource();
      src.fail(MockEventSource.CLOSED);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const countAfter401 = MockEventSource.instances.length;
      sse.bootSseClient();
      assert.equal(MockEventSource.instances.length, countAfter401);
    });
  });

  it('CONNECTING 态 onerror 不清算连接（浏览器自动重连中）', async () => {
    await withSseCase(async ({ sse }) => {
      sse.bootSseClient();
      const src = latestSource();
      src.emit('hello', { hello: true });
      src.fail(MockEventSource.CONNECTING);
      assert.equal(sse.isSseActive(), true, '自动重连期间保持激活');
    });
  });
});

describe('sse-client: 30s 静默看门狗（watchdogDecide）', () => {
  // 判定矩阵直测（产品代码已抽为纯函数命名导出；真实 interval 粒度 5s 无分支，不测）。
  it('未激活（无 hello / 已断连）：无事可做', async () => {
    await withSseCase(async ({ sse }) => {
      assert.deepEqual(sse.watchdogDecide(false, 0, 100000, 1), { poll: false, deactivate: false });
    });
  });

  it('静默未超阈值：空闲 agent 正常态，不扰动', async () => {
    await withSseCase(async ({ sse }) => {
      assert.deepEqual(sse.watchdogDecide(true, 80000, 100000, 1), { poll: false, deactivate: false });
    });
  });

  it('静默超阈值且连接健康：只触发全量对账', async () => {
    await withSseCase(async ({ sse }) => {
      assert.deepEqual(sse.watchdogDecide(true, 0, 31000, 1), { poll: true, deactivate: false });
    });
  });

  it('静默超阈值且连接死（半开态）：先降级再对账', async () => {
    await withSseCase(async ({ sse }) => {
      for (const readyState of [0, 2, -1]) {
        assert.deepEqual(
          sse.watchdogDecide(true, 0, 31000, readyState),
          { poll: true, deactivate: true },
          `readyState=${readyState}`,
        );
      }
    });
  });
});

describe('sse-client: 排队气泡乐观对账（reconcileQueuedTexts）', () => {
  it('快照含乐观 id → 确认（后续快照不再重复保留）', async () => {
    await withSseCase(async ({ sse }) => {
      sse.noteQueuedOptimistic('q-1', '排队A');
      const first = sse.reconcileQueuedTexts([{ id: 'q-1', text: '排队A' }]);
      assert.deepEqual(first, ['排队A']);
      // 已确认：空快照不残留
      const second = sse.reconcileQueuedTexts([]);
      assert.deepEqual(second, []);
    });
  });

  it('排队与消费事件先于 POST 回执到达：迟到回执不能复活已发送气泡', async () => {
    await withSseCase(async ({ sse }) => {
      // 真实公开入口：SSE queued-inputs 帧（handleQueuedInputsEvent 是其消费者）
      sse.bootSseClient();
      latestSource().emit('hello', { hello: true });
      latestSource().emit('queued-inputs', { agentId: 'rt-focus', data: [{ id: 'q-fast', text: '已发送' }] });
      latestSource().emit('queued-inputs', { agentId: 'rt-focus', data: [] });
      sse.noteQueuedOptimistic('q-fast', '已发送', 'rt-focus');
      assert.deepEqual(
        sse.reconcileQueuedTexts(sse.getLastQueuedSnapshot('rt-focus').items), [],
        'the consumed message must not remain staged until TTL or page refresh',
      );
    });
  });

  it('快照不含乐观 id 且未超 TTL → 乐观文本保留追加', async () => {
    await withSseCase(async ({ sse }) => {
      sse.noteQueuedOptimistic('q-9', '还在等');
      const out = sse.reconcileQueuedTexts([{ id: 'q-1', text: '先来的' }]);
      assert.deepEqual(out, ['先来的', '还在等']);
    });
  });

  it('快照不含乐观 id 且超 TTL（10s）→ 移除', async () => {
    await withSseCase(async ({ sse }) => {
      sse.noteQueuedOptimistic('q-old', '过期的');
      const out = sse.reconcileQueuedTexts([], Date.now() + 11000);
      assert.deepEqual(out, []);
    });
  });

  it('图片项与空文本项的文本归一（🖼）', async () => {
    await withSseCase(async ({ sse }) => {
      const out = sse.reconcileQueuedTexts([
        { id: 'q-i', images: [{}, {}] },
        { id: 'q-e', text: '   ' },
        { id: 'q-t', text: ' ok ' },
      ]);
      assert.deepEqual(out, ['🖼', 'ok']);
    });
  });

  it('reminder 项不产生气泡文本（用户输入按身份展示）', async () => {
    await withSseCase(async ({ sse }) => {
      const out = sse.reconcileQueuedTexts([
        { id: 'q-1', text: '用户消息' },
        { id: 'q-2', text: '面板动作通报', kind: 'reminder' },
        { id: 'q-3', images: [{}], kind: 'reminder' },
      ]);
      assert.deepEqual(out, ['用户消息']);
    });
  });

  it('跨会话隔离：其他 runtime 的乐观锚点不拼入本会话快照', async () => {
    await withSseCase(async ({ sse }) => {
      // 会话 A 提交排队后切走：锚点归属 rt-a
      sse.noteQueuedOptimistic('q-a', '会话A的排队', 'rt-a');

      // 会话 B 的快照对账：A 的乐观文本不冒进 B 的排队气泡
      assert.deepEqual(sse.reconcileQueuedTexts([], Date.now(), 'rt-b'), []);

      // 会话 A 的快照对账：乐观文本保留
      assert.deepEqual(sse.reconcileQueuedTexts([], Date.now(), 'rt-a'), ['会话A的排队']);

      // A 的排队项出现在自己的快照里 → 确认清除；B 的对账不受影响
      const confirmed = sse.reconcileQueuedTexts([{ id: 'q-a', text: '会话A的排队' }], Date.now(), 'rt-a');
      assert.deepEqual(confirmed, ['会话A的排队']);
      assert.deepEqual(
        sse.reconcileQueuedTexts([], Date.now(), 'rt-a'),
        [],
        '确认后的锚点不再保留',
      );
    });
  });

  // 已 claim（inputLease）的 durable 命令：claim 不移除、ack 才移除是
  // ADR-0047 状态机语义；claim→ack 窗口内快照仍含该项。空闲发送时该窗口
  // 由消费+快照落盘决定（可达数百毫秒），把它渲染成排队气泡就是
  // 「先卡一下再发出去」的观感来源——展示层如实区分「待领取」与
  // 「执行中」。
  it('已 claim（inputLease）的项不产生排队气泡文本', async () => {
    await withSseCase(async ({ sse }) => {
      const out = sse.reconcileQueuedTexts([
        { id: 'q-claimed', text: '执行中的消息', inputLease: { leaseId: 'l-1' } },
        { id: 'q-waiting', text: '真正在排队的' },
      ]);
      assert.deepEqual(out, ['真正在排队的']);
    });
  });

  it('已 claim 的项仍确认乐观锚点（服务端已收到 ≠ 待展示）', async () => {
    await withSseCase(async ({ sse }) => {
      // POST 回执先到（注册乐观锚点），随后快照显示该项已被 claim：
      // 文本不展示，但「项在快照中」即确认锚点——后续空快照不得残留
      sse.noteQueuedOptimistic('q-c', '被领取了', 'rt-focus');
      const out = sse.reconcileQueuedTexts(
        [{ id: 'q-c', text: '被领取了', inputLease: { leaseId: 'l-2' } }], Date.now(), 'rt-focus');
      assert.deepEqual(out, [], 'claim 中的项不渲染');
      const after = sse.reconcileQueuedTexts([], Date.now(), 'rt-focus');
      assert.deepEqual(after, [], '锚点已被 claim 快照确认，不再保留到 TTL');
    });
  });

  it('已 claim 的项不复活迟到 POST 回执的乐观气泡', async () => {
    await withSseCase(async ({ sse }) => {
      // 排队→claim 事件都早于 POST 回执（消费提速后的常态）
      sse.bootSseClient();
      latestSource().emit('hello', { hello: true });
      latestSource().emit('queued-inputs', {
        agentId: 'rt-focus', data: [{ id: 'q-fast', text: '已发送', inputLease: { leaseId: 'l-3' } }],
      });
      latestSource().emit('queued-inputs', { agentId: 'rt-focus', data: [] });
      sse.noteQueuedOptimistic('q-fast', '已发送', 'rt-focus');
      assert.deepEqual(
        sse.reconcileQueuedTexts(sse.getLastQueuedSnapshot('rt-focus').items), [],
        '已领取的消息不得因迟到回执复活排队气泡',
      );
    });
  });
});
