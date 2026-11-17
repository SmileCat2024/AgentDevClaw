/* global window, document */
/**
 * P2 第二波 2 —— sse-client.js ESM 化后的连接生命周期与事件分发。
 *
 * 装载路线：sse-client 走真实 import（test/helpers/esm-module-loader.js 的
 * window/document 桩 + 其 ESM 依赖链）；**desktop-notify 以 classic 装载**
 * 到同一个 window（sandbox 即 window 对象，顶层 function 声明成为 window
 * 属性，与浏览器真实语义一致）——它保持唯一 classic 实现，ESM 侧只经既有
 * window._presentAppNotification / window._syncForegroundState 协议消费，
 * 不 import classic 文件、不复制通知业务。
 *
 * 钉住迁移不该改变的契约：
 *   - 认证启动链：__clawAuthReady 未放行前不建连；放行后单连接，hello 激活；
 *   - 连接重建：thread 订阅集变化按新 ?threads= 重建，订阅集未变不重建；
 *   - 熔断 / 401 探测：致命断开 3s 重试，连续三次进入 60s 冷却，401 停重连；
 *   - 30s 静默看门狗：判定矩阵 + 真实定时器回调触发全量对账；
 *   - 事件分发：焦点走 updateNotificationStatus（带视图 token），非焦点只更
 *     新侧栏 call 状态；app-notification 帧仍交给 desktop-notify 呈现；
 *   - 排队气泡乐观对账与快照归属（非焦点快照不写当前输入面）；
 *   - 兼容面：window.ClawFW.SseClient 命名空间 + isSseActive 桥键。
 */

import fs from 'node:fs';
import vm from 'node:vm';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';
import { loadThreadEngine } from './helpers/thread-engine.js';

/**
 * 以浏览器语义装载 classic desktop-notify：sandbox 就是 window 对象本身
 * （window === 全局 this），其顶层 function 声明因此直接成为 window 属性。
 * 装载是同步的——返回即代表「经典相同轮次」已完成。
 */
function loadClassicSource(relPath) {
  const source = fs.readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8');
  vm.runInNewContext(source, globalThis.window, { filename: relPath.split('/').pop() });
}

function loadClassicDesktopNotify() {
  const source = fs.readFileSync(new URL('../public/src/modules/desktop-notify.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, globalThis.window, { filename: 'desktop-notify.js' });
}

// ── EventSource mock（与浏览器规范的 readyState 常量一致）──────────────

// 装载期按 id 取控件的 ESM 模块（trim-page / session-dialogs，迁移中）所需节点。
const LOAD_TIME_DOM_ELEMENT_IDS = [
  'trim-page', 'trim-page-title', 'trim-page-mode', 'trim-page-list', 'trim-page-readout',
  'trim-page-submit', 'trim-page-ratio-input', 'trim-page-ratio-slider', 'trim-page-ratio-config',
  'trim-page-manual-config', 'trim-page-archive-row', 'trim-page-archive-toggle',
  'trim-page-summary-toggle', 'trim-page-keep-skill-control', 'trim-page-keep-skill-toggle',
  'trim-page-keep-skill-value', 'trim-page-keep-skill-dec', 'trim-page-keep-skill-inc',
  'branch-dialog', 'branch-round-list', 'branch-submit', 'branch-footer-info',
];
const LOAD_TIME_DOM_ELEMENTS = new Map();

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

  emit(kind, data) {
    this.readyState = MockEventSource.OPEN;
    for (const fn of this.listeners.get(kind) || []) fn({ data: JSON.stringify(data) });
  }

  fail(readyStateAfter = MockEventSource.CLOSED) {
    this.readyState = readyStateAfter;
    if (this.onerror) this.onerror();
  }
}

// ── 桩面 ──────────────────────────────────────────────────────────────

const calls = {
  updateNotificationStatus: [],
  metadataRenders: [],
  markStarted: [],
  syncActionButton: 0,
  renders: [],
  forceFullPoll: 0,
  timers: [],
  notifications: [],
};

/** 事件帧处理中的异步分支（probe 取数 / 通知呈现）收敛用。 */
async function flush() {
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const callActivity = {
  _agentCallActive: new Map(),
  _recentlyFinishedRuntimes: new Set(),
  _seenChoiceAlertIds: new Set(),
  _autoTitleTriggered: new Set(),
  _lastInterruptUserActionAt: 0,
};

/**
 * agent-call-states 同步引擎的**宿主 seam**（不是引擎实现）：引擎由同一 window 里
 * 真实 app-main 的 classic IIFE 创建，本对象只提供它读取的容器与下游 sink。
 * 容器取 classic 侧同一份（callActivity 的 Map/Set；interrupting 走 app-core 的
 * createCallInterruptHost() 交出 `_interruptSuppression`），观测点接到 `calls`。
 */
const callStatesHost = {
  calling: callActivity._agentCallActive,
  suspended: new Map(),
  get interrupting() { return globalThis.window.createCallInterruptHost().pending; },
  finished: callActivity._recentlyFinishedRuntimes,
  agents: () => [],
  currentRuntimeId: () => globalThis.window.currentRuntimeAgentId,
  runtimeId: (agent) => String(agent?.runtime_session_id || agent?.runtimeSessionId || agent?.id || '').trim(),
  remoteEntries: () => [],
  normalize: (value) => String(value || '').trim(),
  resolveCalling: (payload) => (payload?.callActive === undefined
    ? String(payload?.state?.type || '') === 'call.start'
    : payload.callActive === true),
  isSuspended: () => false,
  markStarted: (id) => { calls.markStarted.push(id); },
  syncActionButton: () => { calls.syncActionButton += 1; },
  isSseActive: () => false,
  isRemote: () => false,
  fetch: (url) => fetchImpl(url),
  now: () => Date.now(),
  lastRefresh: () => 0,
  setLastRefresh: () => {},
  render: () => { calls.renders.push(1); },
};

function createElementStub() {
  return {
    id: '', className: '', innerHTML: '', textContent: '', title: '',
    style: {}, dataset: {}, children: [],
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    removeChild() {}, insertBefore() {}, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, focus() {}, blur() {}, offsetHeight: 0,
  };
}

let fetchImpl = async (url) => (String(url) === '/protoclaw/choice_alerts'
  ? { ok: true, status: 200 }
  : { ok: true, status: 200, json: async () => ({}) });

let authReadyResolve;
const authReady = new Promise((resolve) => { authReadyResolve = resolve; });

let cleanupGlobals;
let orchestration;
let agentStore;
let sessionStorage;
let sessionIdentity;
let sse;

before(async () => {
  // 同一 window 的 classic 相（app-core/app-main）会在装载期声明同名工厂：
  // 这份宿主 seam 记录在变量里，链装载后原样恢复（ESM 图看到的仍是本文件声明的
  // 精确面，引擎已经用真实实现建好）。
  const windowSeams = {
      location: { search: '' },
      __clawAuthReady: authReady,
      escapeHtml: (text) => String(text ?? ''),
      renderer: {},
      marked: { parse: () => '', setOptions() {}, use() {}, Renderer: class {} },
      // action-dispatcher 的公开面（生产见 public/src/modules/action-dispatcher.js）：
      // 图内 ESM 模块在装载期注册动作并绑定事件类型。
      ClawFW: { actions: { registerMany() {}, register() {}, bindEventType() {} } },
      EventSource: MockEventSource,
      createP2BootstrapCallActivityHost: () => callActivity,
      createAgentCallStatesHost: () => callStatesHost,
      createMetadataCommitHost: () => ({
        normalizeOverview: (value) => value,
        overviewSignature: () => 'overview-sig',
        normalizeTodo: (value) => value,
        todoSignature: () => 'todo-sig',
        interruptTarget: () => null,
        now: () => 0,
        lastInterruptAction: () => 0,
        setInterruptTarget: () => {},
        render: (meta) => { calls.metadataRenders.push(meta); },
      }),
      // 本文件不驱动 messages / connection 帧；工厂只需可构造（形状同
      // test/p2-w1-3-batch3-esm-compat.test.js 的生产形态最小桩）
      createMessageProbeHost: () => ({}),
      createAgentSnapshotLoaderHost: () => ({ state: { suppressRender: true } }),
      createAgentLoaderHost: () => ({ state: {}, detail: {}, render: () => {} }),
      AgentLoaderHost: { loadedAgentDetailIds: new Set() },
      createSessionDataLoaderHost: () => ({ state: {}, ui: {}, render: () => {} }),
      createRuntimeStatusLoaderHost: () => ({ state: {}, ui: {}, render: () => {} }),
      createCommittedViewRenderer: () => ({}),
      createRuntimeNotFoundHost: () => ({}),
      // 排队投影（sse-client 的双向环对端）静态图取的 classic 侧栏宿主工厂：
      // 本文件不驱动侧栏/host，只要求装载期可解析。
      createP2BootstrapSidebarHost: () => ({}),
      createP2BootstrapSidebarRenderHost: () => ({}),
      createP2BootstrapSessionSwitchHost: () => ({}),
      createP2BootstrapDomHost: () => ({}),
      createPollCoordinatorHost: () => ({}),
      createSessionDataLoaderHost: () => ({}),
      createRuntimeStatusLoaderHost: () => ({}),
      createAgentSnapshotLoaderHost: () => ({ state: { suppressRender: true } }),
      createSessionViewCommitHost: () => ({
        identity: () => ({ agentId: 'agent-a', sessionId: 'session-a' }),
        read: () => ({ runtimeId: orchestration.currentRuntimeAgentId, overview: { modelRevision: null } }),
        apply: () => {},
        normalizeModel: (value) => ({ modelRevision: null, ...(value || {}) }),
        modelRuntimeId: () => null,
      }),
      createPollCoordinatorHost: () => ({
        fastInterval: () => 1000,
        setTimeout: () => 0,
        clearTimeout: () => {},
        run: async () => {},
      }),
      localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
      // 视图 token 的 switchEpoch / generation 取真实 ESM 状态（session-view-commit-host
      // 的 host 面就是这些 live binding）
      captureSessionViewToken: (runtimeId) => ({
        runtimeId: String(runtimeId || '').trim(),
        switchEpoch: orchestration._switchEpoch,
        generation: sessionIdentity._sessionViewGeneration,
      }),
      getRuntimeRecord: () => null,
      // 排队投影已由 sse-client 具名 import（applyQueuedInputsTexts）：它的
      // classic 直调依赖按生产签名供桩，投影状态经 input-queue owner 模块读取。
      rebindQueueProjectionForRuntime: () => {},
      _interactiveSurfaceOccupiesInput: () => false,
      _syncPersistentActionButton: () => {},
      notifyInputSurfaceChanged: () => {},
      renderAgentList: () => { calls.renders.push(1); },
      commitSessionViewPatch: () => true,
      updateNotificationStatus: (payload, runtimeId, token) => {
        calls.updateNotificationStatus.push({ payload, runtimeId, token });
      },
      normalizeAgentIdentity: (value) => String(value || '').trim(),
      Notification: Object.assign(
        function NotificationStub(title, options) {
          calls.notifications.push({ title, options });
          return { close() {} };
        },
        { permission: 'granted', requestPermission: async () => 'granted' },
      ),
      setInterval: (fn, ms) => { calls.timers.push({ kind: 'interval', fn, ms }); return calls.timers.length; },
      setTimeout: (fn, ms) => { calls.timers.push({ kind: 'timeout', fn, ms }); return calls.timers.length; },
      clearInterval: () => {},
      clearTimeout: () => {},
      requestAnimationFrame: () => 1,
      Worker: class WorkerStub { constructor() { this.onmessage = null; } },
      focus() {},
      fetch: (url) => fetchImpl(url),
    };
  cleanupGlobals = installBrowserStubs({
    window: windowSeams,
    document: {
      hidden: true,
      hasFocus: () => false,
      // 图内 trim-page / session-dialogs（两批正在 ESM 化）在装载期按 id 取控件并
      // 注册监听：生产由 index.html 的静态标记提供，这里按同一批 id 预置最小节点。
      getElementById: (id) => {
        if (LOAD_TIME_DOM_ELEMENTS.has(id)) return LOAD_TIME_DOM_ELEMENTS.get(id);
        if (!LOAD_TIME_DOM_ELEMENT_IDS.includes(id)) return null;
        const el = createElementStub();
        LOAD_TIME_DOM_ELEMENTS.set(id, el);
        return el;
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => createElementStub(),
      createTextNode: (text) => ({ textContent: text }),
      addEventListener() {},
      removeEventListener() {},
      body: createElementStub(),
      documentElement: createElementStub(),
      activeElement: null,
      readyState: 'complete',
    },
  });

  await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
  // 这五组桥键由后面装载的真实 app-core 注册（唯一注册制，不能重复 defineKey）；
  // 装载后按本文件的场景把值显式写回（rt-focus / zh / dark）。

  await import('../public/src/modules/i18n-environment-state.js');
  orchestration = await import('../public/src/modules/orchestration-state.js');
  agentStore = await import('../public/src/modules/agent-store-state.js');
  sessionStorage = await import('../public/src/modules/session-view-storage.js');
  sessionIdentity = await import('../public/src/modules/session-view-identity-state.js');
  sessionIdentity.setSessionViewGeneration(0);
  orchestration.setSwitchEpoch(0);

  // ── 浏览器语义的 window：classic 装载与 ESM 消费共享同一对象 ──
  const win = globalThis.window;
  win.window = win;                        // window.window === window
  win.document = globalThis.document;      // classic 代码里的裸 document
  win.console = console;
  win.Blob = class BlobStub {};
  win.URL = { createObjectURL: () => 'blob:probe', revokeObjectURL() {} };
  // app-core 的 classic 顶层 const Set：经典代码按裸标识符解析到它。测试用同一
  // 引用暴露（生产由 app-core 的词法绑定提供），语义等价。
  win._recentlyFinishedRuntimes = callActivity._recentlyFinishedRuntimes;
  win._seenChoiceAlertIds = callActivity._seenChoiceAlertIds;
  // 另一批的 ESM 消费方（template-engine → p2-bootstrap-session-switch）在模块
  // 求值时就取 app-core 的 classic 工厂；本用例不装 app-core，按该工厂契约
  // （两个引导标志的成对 get/set）就地提供等价实现。
  let templateWarmupToken = 0;
  let prebuiltSessionSwitchInFlight = false;
  win.createP2BootstrapSessionSwitchHost = () => Object.freeze({
    get templateWarmupToken() { return templateWarmupToken; },
    set templateWarmupToken(value) { templateWarmupToken = value; },
    get prebuiltSessionSwitchInFlight() { return prebuiltSessionSwitchInFlight; },
    set prebuiltSessionSwitchInFlight(value) { prebuiltSessionSwitchInFlight = value; },
  });
  loadClassicDesktopNotify();
  // 刷新引擎（P4 T3 起是真实 ESM）：交互域在**装载期**取它的窄宿主
  // createThreadStoreHost，必须先把引擎装进同一个 window（不复制宿主契约）。
  // 装载期注册的三条同步调度由 helper 记账丢弃（不落到本文件的真实计时器上）。
  await loadThreadEngine();
  // 装载期宿主面：本文件 classic 相只有 desktop-notify（+ 上面 installBrowserStubs
  // 里逐支给出的精确面）。图内还需下列工厂，按生产 owner 与读取面分组说明：
  //   app-core.js（成对 get/set 访问器袋；成员只在函数体内读取，本图不触达这些域）：
  //     createApplicationStartupHost / createP2BootstrapAssemblyHost /
  //     createP2BootstrapChatSurfaceHost / createP2BootstrapContextMenuHost /
  //     createP2BootstrapDebugPanelHost / createP2BootstrapPhSessionHost
  //   app-core.js：createRuntimeViewCacheHost（runtime-view-cache 读 host.cache(Map)/capacity）
  //   app-main.js（闭包宿主；本图不启动轮询 / 断点续跑 / 工作区导航）：
  //     createCompactResumeHost / createPollCycleHost / createPollMaintenanceHost /
  //     createRuntimePollHost / createViewerReadinessHost / createWorkspaceEntryHost /
  //     createWorkspaceSessionNavigationHost
  //   app-main.js：createRuntimeSwitchHost（runtime-switch-host 顶层对 host.state 做 defineProperties）
  //   app-ui.js（只 spread 注入，本图不驱动工作区表面）：createWorkspaceSurfaceHost
  // app-core / app-main 在下面以 **同一个 window** 的 classic 相装载（真实
  // call-interrupt 访问器 + 真实 call-states 同步引擎）；app-ui 不装载：它的
  // renderCurrentMainView 会把用例带进主视图 DOM 渲染链，超出 SSE 连接生命周期
  // 与事件分发的验收面。装载链覆盖的同名工厂由 windowSeams 原样恢复。
  const HOST_SEAMS = {
    createApplicationStartupHost: () => ({}),
    createP2BootstrapAssemblyHost: () => ({}),
    createP2BootstrapChatSurfaceHost: () => ({}),
    createP2BootstrapContextMenuHost: () => ({}),
    createP2BootstrapDebugPanelHost: () => ({}),
    createP2BootstrapPhSessionHost: () => ({}),
    createRuntimeViewCacheHost: () => ({ cache: new Map(), capacity: 0 }),
    createCompactResumeHost: () => ({}),
    createPollCycleHost: () => ({}),
    createPollMaintenanceHost: () => ({}),
    createRuntimePollHost: () => ({}),
    createViewerReadinessHost: () => ({}),
    createWorkspaceEntryHost: () => ({}),
    createWorkspaceSessionNavigationHost: () => ({}),
    createRuntimeSwitchHost: () => ({ state: {} }),
    createWorkspaceSurfaceHost: () => ({}),
  };
  for (const [name, factory] of Object.entries(HOST_SEAMS)) {
    if (typeof win[name] !== 'function') win[name] = factory;
  }
  if (!win.AgentLoaderHost) win.AgentLoaderHost = { loadedAgentDetailIds: new Set() };


  // 真实 classic 同步 owner，装进**同一个 window**（沙箱即 window）：
  //   app-core.js  → call-interrupt 四个桥键（真实 `_interruptSuppression`）
  //   app-main.js  → agent-call-states 引擎（装载期组合上面的 callStatesHost seam）
  // boot 体挂在临时的不 resolve 的 __clawAuthReady 上，装载后恢复本文件的
  // authReady（sse-client 的建连闸仍是本测试控制的那一个）。
  const authReadyForSse = win.__clawAuthReady;
  win.__clawAuthReady = new Promise(() => {});
  if (typeof win.applyTheme !== 'function') win.applyTheme = () => {};
  if (typeof win.applyLanguage !== 'function') win.applyLanguage = () => {};
  loadClassicSource('public/src/app-core.js');
  // app-core 的函数声明覆盖了本文件声明的宿主 seam：先恢复，再装 app-main，
  // 保证引擎拿到的就是 callStatesHost（容器/观测点与本文件断言一致）。
  Object.assign(win, windowSeams, HOST_SEAMS);
  win.AgentLoaderHost = win.AgentLoaderHost || { loadedAgentDetailIds: new Set() };
  win.__clawAuthReady = new Promise(() => {});   // windowSeams 里是 authReady，重新门控
  loadClassicSource('public/src/app-main.js');
  win.__clawAuthReady = authReadyForSse;
  // app-main 又声明了一批同名工厂：ESM 图仍使用本文件声明的精确 seam。
  Object.assign(win, windowSeams, HOST_SEAMS);
  win.AgentLoaderHost = win.AgentLoaderHost || { loadedAgentDetailIds: new Set() };
  // 场景值写回（app-core 注册桥键时用的是默认初值）。
  win.currentRuntimeAgentId = 'rt-focus';
  win.currentLanguage = 'zh';
  win.currentTheme = 'dark';
  assert.equal(typeof win.ClawFW.CallStates.refreshAgentCallStates, 'function',
    '同一 window 上必须存在真实 classic 同步引擎');
  assert.equal(win.refreshAgentCallStates, win.ClawFW.CallStates.refreshAgentCallStates,
    'classic 桥键与 ESM 适配器读到的是同一个引擎函数（同一 window）');

  // 规范 URL 装载：sse-client 的静态 import 解析到同一实例
  sse = await import('../public/src/modules/sse-client.js');
});

after(() => {
  cleanupGlobals();
});

function setFetch(fn) {
  fetchImpl = fn;
}

function latestSource() {
  return MockEventSource.instances[MockEventSource.instances.length - 1] || null;
}

function lastTimeout() {
  for (let i = calls.timers.length - 1; i >= 0; i -= 1) {
    if (calls.timers[i].kind === 'timeout') return calls.timers[i];
  }
  return null;
}

// ── 认证启动链 ────────────────────────────────────────────────────────

test('sse-client：认证未放行前不建连，放行后单连接并 hello 激活', async () => {
  assert.equal(MockEventSource.instances.length, 0, 'auth ready 之前不得建连');
  assert.equal(sse.isSseActive(), false);
  assert.equal(window.isSseActive, sse.isSseActive, 'isSseActive 桥键与命名导出同源');

  authReadyResolve();
  await flush();
  assert.equal(MockEventSource.instances.length, 1, '放行后建立单条聚合流');
  assert.equal(latestSource().url, '/protoclaw/events', '未订阅 thread 时不带 ?threads=');
  assert.equal(sse.isSseActive(), false, 'hello 之前不算激活');

  latestSource().emit('hello', { ok: true, choiceAlerts: [] });
  assert.equal(sse.isSseActive(), true, 'hello 激活');
  assert.equal(window.isSseActive(), true, '桥键读到激活态');
  assert.equal(MockEventSource.instances.length, 1, 'hello 不重建连接');

  latestSource().emit('shutdown', {});
  assert.equal(sse.isSseActive(), false, '服务端收口即降级轮询');

  latestSource().emit('hello', { ok: true });
  assert.equal(sse.isSseActive(), true, '浏览器自动重连后的 hello 重新激活');
});

test('sse-client：hello 的 choiceAlerts 走与轮询共享的已提醒集合', () => {
  callActivity._seenChoiceAlertIds.clear();
  const shown = [];
  const originalShow = window.ClawToast.show;
  window.ClawToast.show = (toast) => { shown.push(toast); };
  try {
    const alert = { requestId: 'req-1', agentId: 'rt-focus', agentName: 'Agent' };
    latestSource().emit('hello', { ok: true, choiceAlerts: [alert] });
    latestSource().emit('hello', { ok: true, choiceAlerts: [alert] });
  } finally {
    window.ClawToast.show = originalShow;
  }
  assert.deepEqual(shown.map((toast) => toast.id), ['choice-alert-req-1'], '同一 requestId 只提醒一次');
  assert.equal(callActivity._seenChoiceAlertIds.has('req-1'), true, '复用 classic 的已提醒容器');
});

// ── 连接重建（thread 订阅）────────────────────────────────────────────

test('sse-client：thread 订阅集变化按新 ?threads= 重建，未变不重建', () => {
  const startCount = MockEventSource.instances.length;
  const unsubA = sse.subscribeThreadEvents(['th-a'], () => {});
  assert.equal(MockEventSource.instances.length, startCount + 1, '订阅新线程触发重建');
  assert.equal(latestSource().url, '/protoclaw/events?threads=th-a');
  assert.equal(MockEventSource.instances[startCount - 1].closed, true, '旧连接显式关闭');

  const unsubSecond = sse.subscribeThreadEvents(['th-a'], () => {});
  assert.equal(MockEventSource.instances.length, startCount + 1, '订阅集不变不重建');

  const unsubStar = sse.subscribeThreadEvents('*', () => {});
  assert.equal(latestSource().url, '/protoclaw/events?threads=*');

  unsubStar();
  assert.equal(latestSource().url, '/protoclaw/events?threads=th-a', '取消通配后回到剩余订阅');
  unsubSecond();
  assert.equal(latestSource().url, '/protoclaw/events?threads=th-a', '同一 threadId 仍有订阅者');
  unsubA();
  assert.equal(latestSource().url, '/protoclaw/events', '订阅归零后不再带参数');
});

test('sse-client：thread 事件按 threadId 派发', () => {
  const received = [];
  const unsub = sse.subscribeThreadEvents(['th-x'], (evt) => received.push(evt));
  latestSource().emit('thread.head-advanced', { threadId: 'th-x', headSessionId: 's-2' });
  latestSource().emit('thread.archived', { threadId: 'th-y' });
  assert.equal(received.length, 1, '只派发给命中 threadId 的订阅者');
  assert.equal(received[0].type, 'thread.head-advanced');
  assert.equal(received[0].threadId, 'th-x');
  assert.equal(received[0].payload.headSessionId, 's-2');
  unsub();
});

// ── 熔断 / 401 探测 ──────────────────────────────────────────────────

test('sse-client：CONNECTING 期不干预，致命断开按 3s 重试，连续三次进入 60s 冷却', async () => {
  latestSource().emit('hello', { ok: true });
  const beforeConnecting = MockEventSource.instances.length;
  latestSource().fail(MockEventSource.CONNECTING);
  assert.equal(MockEventSource.instances.length, beforeConnecting, 'CONNECTING 交给浏览器自动重连');
  assert.equal(sse.isSseActive(), true, 'CONNECTING 期不降级');

  setFetch(async (url) => (String(url) === '/protoclaw/choice_alerts'
    ? { ok: false, status: 500 }
    : { ok: true, status: 200, json: async () => ({}) }));

  // 前两次致命失败：3s 重试重建连接
  for (let attempt = 0; attempt < 2; attempt += 1) {
    latestSource().fail(MockEventSource.CLOSED);
    await flush();
    assert.equal(sse.isSseActive(), false, '致命断开即降级');
    const retry = lastTimeout();
    assert.equal(retry.ms, 3000, '重试节奏 3s');
    retry.fn();
    assert.equal(latestSource().readyState, MockEventSource.CONNECTING, '重试重建连接');
  }
  // 第三次致命失败：进入 60s 冷却
  latestSource().fail(MockEventSource.CLOSED);
  await flush();
  assert.equal(lastTimeout().ms, 60000, '连续三次致命失败进入 60s 冷却');
});

test('sse-client：401 探测后停止重连（等登录流程）', async () => {
  // 跳过冷却：把时钟推到冷却结束，跑一次冷却定时器重建连接
  const realNow = Date.now;
  Date.now = () => realNow() + 61000;
  try {
    lastTimeout().fn();
  } finally {
    Date.now = realNow;
  }
  const connected = latestSource();
  assert.equal(connected.readyState, MockEventSource.CONNECTING, '冷却结束后重建');

  setFetch(async (url) => (String(url) === '/protoclaw/choice_alerts'
    ? { ok: false, status: 401 }
    : { ok: true, status: 200, json: async () => ({}) }));
  connected.fail(MockEventSource.CLOSED);
  await flush();
  const countAfter401 = MockEventSource.instances.length;
  sse.bootSseClient();
  assert.equal(MockEventSource.instances.length, countAfter401, '401 之后不再重连');
  assert.equal(sse.isSseActive(), false);
});

// ── 30s 静默看门狗 ───────────────────────────────────────────────────

test('sse-client：看门狗判定矩阵与真实回调触发全量对账', () => {
  assert.deepEqual(sse.watchdogDecide(false, 0, 60000, 1), { poll: false, deactivate: false });
  assert.deepEqual(sse.watchdogDecide(true, 50000, 60000, 1), { poll: false, deactivate: false }, '静默未超阈值不扰动');
  assert.deepEqual(sse.watchdogDecide(true, 10000, 60000, 1), { poll: true, deactivate: false }, '健康连接静默超阈值只对账');
  assert.deepEqual(sse.watchdogDecide(true, 10000, 60000, -1), { poll: true, deactivate: true }, '半开连接先降级再对账');

  window.ClawFW.forceFullPollOnce = () => { calls.forceFullPoll += 1; };
  // 看门狗只在连接已激活时工作：先放行 hello（同时刷新 lastFrameAt）
  latestSource().emit('hello', { ok: true });
  const watchdog = calls.timers.find((timer) => timer.kind === 'interval' && timer.ms === 5000);
  assert.ok(watchdog, '启动时装上 5s 粒度的看门狗');
  const realNow = Date.now;
  Date.now = () => realNow() + 31000;
  try {
    watchdog.fn();
  } finally {
    Date.now = realNow;
  }
  assert.equal(calls.forceFullPoll, 1, '静默超阈值触发一次全量对账');
});

// ── 事件分发 ─────────────────────────────────────────────────────────

test('sse-client：焦点会话的 notification 帧带视图 token 走 updateNotificationStatus', () => {
  orchestration.setCurrentRuntimeAgentId('rt-focus');
  calls.updateNotificationStatus.length = 0;
  latestSource().emit('notification', { agentId: 'rt-focus', data: { callActive: true, state: { type: 'call.start' } } });
  assert.equal(calls.updateNotificationStatus.length, 1);
  assert.equal(calls.updateNotificationStatus[0].runtimeId, 'rt-focus');
  assert.equal(calls.updateNotificationStatus[0].payload.state.type, 'call.start');
  assert.deepEqual(calls.updateNotificationStatus[0].token, { runtimeId: 'rt-focus', switchEpoch: 0, generation: 0 },
    'token 在事件抵达时捕获，用于提交期 stale 判定');
});

test('sse-client：非焦点会话只更新侧栏 call 状态，边沿变化才重绘', () => {
  orchestration.setCurrentRuntimeAgentId('rt-focus');
  calls.updateNotificationStatus.length = 0;
  calls.markStarted.length = 0;
  calls.renders.length = 0;

  latestSource().emit('notification', { agentId: 'rt-other', data: { callActive: true } });
  assert.equal(calls.updateNotificationStatus.length, 0, '非焦点不得改主视图状态');
  assert.deepEqual(calls.markStarted, ['rt-other'], '非焦点的 call.start 仍标记新 call');
  assert.equal(calls.renders.length, 1, 'calling 边沿变化即时重绘侧栏');

  latestSource().emit('notification', { agentId: 'rt-other', data: { callActive: true } });
  assert.equal(calls.renders.length, 1, '无状态变化不重复重绘');
});

test('sse-client：todo / overview 帧按视图 token 提交元数据；无焦点时忽略', () => {
  orchestration.setCurrentRuntimeAgentId('rt-focus');
  calls.metadataRenders.length = 0;
  latestSource().emit('todo', { agentId: 'rt-focus', data: { tasks: [] } });
  latestSource().emit('overview', { agentId: 'rt-focus', data: { sections: [] } });
  latestSource().emit('todo', { agentId: 'rt-other', data: { tasks: [] } });
  assert.equal(calls.metadataRenders.length, 2, '只有焦点会话的元数据帧提交');
  assert.equal(calls.metadataRenders[0].todoChanged, true, 'todo 帧提交 todoPlan');
  assert.equal(calls.metadataRenders[1].overviewChanged, true, 'overview 帧提交 overview');
});

test('sse-client：queued-inputs 帧按 runtime 归属缓存与投影（非焦点不串会话）', async () => {
  orchestration.setCurrentRuntimeAgentId('rt-focus');
  // 与 sse-client 图内同一实例（规范 URL 装载）：owner 的 claim 只发生一次
  const queueState = await import('../public/src/modules/p2-w2-3a-input-queue-state.js');

  latestSource().emit('queued-inputs', {
    agentId: 'rt-focus',
    data: [
      { id: 'q1', kind: 'user', text: 'hello' },
      { id: 'q2', kind: 'reminder', text: 'machine note' },
      { id: 'q3', kind: 'user', text: 'claimed', inputLease: { leaseId: 'l1' } },
    ],
  });
  assert.deepEqual([...queueState.queuedTexts], ['hello']);
  assert.equal(queueState.pendingQueuedCount, 1, 'reminder 与已领取项不进待发送计数');

  latestSource().emit('queued-inputs', { agentId: 'rt-other', data: [{ id: 'q9', kind: 'user', text: 'other' }] });
  assert.deepEqual([...queueState.queuedTexts], ['hello'], '非焦点快照不得写当前输入面');
  const cached = sse.getLastQueuedSnapshot('rt-other');
  assert.deepEqual(cached.items.map((item) => item.id), ['q9'], '快照按 runtime 缓存供切回恢复');
});

test('sse-client：app-notification 帧仍交给 desktop-notify 呈现（呈现级去重）', async () => {
  orchestration.setCurrentRuntimeAgentId('rt-focus');
  agentStore.setAllAgents([{ id: 'agent-a', name: 'Agent A', runtime_session_id: 'rt-other' }]);
  document.hidden = true;
  calls.notifications.length = 0;
  setFetch(async () => ({ ok: true, status: 200, json: async () => ({ messages: [] }) }));

  const frame = { type: 'finish', agentId: 'agent-a', runtimeAgentId: 'rt-other', finishTs: 777, outcomeStatus: 'completed', body: 'x' };
  latestSource().emit('app-notification', frame);
  await flush();
  latestSource().emit('app-notification', frame);
  await flush();
  assert.equal(calls.notifications.length, 1, 'SSE 重放同一 finish 帧只呈现一次');
  agentStore.setAllAgents([]);
  setFetch(async (url) => (String(url) === '/protoclaw/choice_alerts'
    ? { ok: true, status: 200 }
    : { ok: true, status: 200, json: async () => ({}) }));
});

// ── 排队气泡乐观对账 + 公开命名空间 ─────────────────────────────────

test('sse-client：乐观锚点确认 / TTL 过期 / 快照文本在前', () => {
  const runtimeId = 'rt-focus';
  orchestration.setCurrentRuntimeAgentId(runtimeId);
  const now = Date.now();

  // POST 回执先到、快照尚未包含 → 乐观文本追加在权威快照之后
  assert.equal(sse.noteQueuedOptimistic('o1', 'optimistic', runtimeId), true);
  assert.deepEqual(
    sse.reconcileQueuedTexts([{ id: 'q-a', kind: 'user', text: 'snapshot' }], now, runtimeId),
    ['snapshot', 'optimistic'],
    '未确认的乐观文本追加在权威快照之后',
  );

  // 快照出现该 id → 确认（不重复追加），且该排队身份进入已观察集
  assert.deepEqual(
    sse.reconcileQueuedTexts(
      [{ id: 'q-a', kind: 'user', text: 'snapshot' }, { id: 'o1', kind: 'user', text: 'optimistic' }],
      now,
      runtimeId,
    ),
    ['snapshot', 'optimistic'],
    '快照含该 id 即确认（不重复追加）',
  );
  assert.equal(sse.noteQueuedOptimistic('o1', 'optimistic', runtimeId), false, '已观察到的排队身份不再登记乐观锚点');

  // 连续快照不含且超 TTL → 回收
  assert.equal(sse.noteQueuedOptimistic('o2', 'stale', runtimeId), true);
  // 超出 TTL（10s）且快照不含 → 回收：用充足余量避开用例内的时钟跳变
  assert.deepEqual(sse.reconcileQueuedTexts([], now + 20000, runtimeId), [], '超出 TTL 且快照不含 → 回收');
});

test('sse-client：不 import classic 模块，通知面只经既有 window 函数协议消费', () => {
  const source = fs.readFileSync(new URL('../public/src/modules/sse-client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from '\.\/desktop-notify\.js'/, 'desktop-notify 是 classic，ESM 侧不得 import 它');
  assert.match(source, /window\._presentAppNotification/, 'app-notification 帧经既有 window 函数协议投递');
  assert.match(source, /window\._syncForegroundState/, '前台时钟经既有 window 函数协议刷新');
});

test('sse-client：window.ClawFW.SseClient 命名空间与命名导出同源，私有 helper 不上桥', () => {
  const ns = window.ClawFW.SseClient;
  assert.ok(ns, '既有公开命名空间协议保留');
  for (const key of ['isSseActive', 'noteQueuedOptimistic', 'getLastQueuedSnapshot',
    'reconcileQueuedTexts', 'subscribeThreadEvents']) {
    assert.equal(ns[key], sse[key], `${key} 必须指向同一实现`);
  }
  for (const key of ['handleNotificationEvent', 'watchdogDecide', 'bootSseClient', 'connect']) {
    assert.equal(window[key], undefined, `${key} 不应挂在 window 上`);
  }
  // 同批模块：desktop-notify 的两个 classic 入口仍在桥上
  // desktop-notify 保持 classic：其顶层函数是 window 属性（既有函数协议），
  // SSE 经该协议消费，未新增桥键、未复制通知业务。
  assert.equal(typeof window._presentAppNotification, 'function');
  assert.equal(typeof window._syncForegroundState, 'function');
  assert.equal(typeof window.__clawConsumeNotificationActivation, 'function',
    '壳原生激活入口由 classic 模块在同一轮次注册');
});
