/**
 * p2-thread-case.js — thread-store 交互域用例的装载基座（测试支撑，不是产品代码）。
 *
 * 为什么需要：交互域 `thread-store-domain.js` 是真实 ESM，它的静态依赖链
 * （runtime-switch-host / chat-loading-host / session-view-commit-host /
 * workspace-actions …）在**模块求值期**就要 classic 相提供的宿主工厂，例如
 * `createRuntimeSwitchHost`（app-main）、`createAgentSnapshotLoaderHost`
 * （sidebar-render）、`createP2Bootstrap*Host`（app-core）。手写这些工厂的
 * 同形桩会把宿主契约复制进测试，生产改动无法被用例发现——这里改为执行
 * **真实的 classic 先行脚本序**（顺序同 public/index.html，见
 * test/p2-classic-hosts.js 的 CLASSIC_BOOTSTRAP），宿主工厂就是生产实现本身。
 *
 * 刷新引擎仍是 classic（S2 拆分）：`thread-store.js` 照旧用 `sandbox.loadSource`
 * 装进同一个沙箱，ESM 与 classic 共享同一全局对象——`createThreadStoreHost()`
 * 拿到的状态与引擎是同一份，不存在第二个 ClawThreads。
 *
 * 用例侧仍要控制的东西分两类，语义不同，不要混：
 *   1. **宿主依赖桩**（THREAD_HOST_STUBS）：先行脚本序里没有、但宿主路径会
 *      裸调的 classic 全局（`_storeVisibleSessionInputDraft` /
 *      `_syncPersistentActionButton` / `getEmptyTodoPlan` …）。它们在生产由
 *      index.html 后段脚本提供，本基座按「缺失才补」装最小面。
 *   2. **用例夹具覆盖**（prepareThreadClassicSandbox 的 `overrides`）：用例要
 *      观测或替换的宿主能力（`getCurrentHostAgentRecord` /
 *      `getRuntimeWorkspaceSessionId` / `setViewerSessionBinding` /
 *      `renderAgentList` …）与状态初值。真实实现存在时**故意覆盖**——断言必须
 *      打在用例给定的夹具上，否则会变成对生产实现的间接断言。
 *
 * 与 `prepareClassicSandbox` 的差别只有两点：先行脚本序之后补宿主依赖桩，再
 * 覆盖夹具，最后装 classic 引擎。首屏 boot 与周期排程同样被关掉（用例不驱动
 * 首屏 DOM，也不需要真实轮询）。
 */
import assert from 'node:assert/strict';
import { prepareClassicSandbox } from './p2-classic-hosts.js';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const DOMAIN = 'public/src/modules/thread-store-domain.js';
const VIEW_STORAGE = 'public/src/modules/session-view-storage.js';

/** 宿主路径会裸调的先行脚本序之外全局（生产由 index.html 后段脚本提供）。 */
export const THREAD_HOST_STUBS = {
  _storeVisibleSessionInputDraft: () => {},
  _syncPersistentActionButton: () => {},
  _interactiveSurfaceOccupiesInput: () => false,
  rebindQueueProjectionForRuntime: () => {},
  saveCurrentWorkspaceSurfaceScroll: () => {},
  closeAgentContextMenu: () => {},
  hasPendingSessionNavigation: () => false,
  resetRuntimeBackedSurfaceState: () => {},
  setPendingChatViewportAnchor: () => {},
  setPendingChatScrollRestore: () => {},
  getReadOnlySessionTarget: () => null,
  closeReadOnlySession: () => {},
  activateUserCollapseStateForContext: () => {},
  resetRuntimeStatusForSwitch: () => {},
  updateNotificationStatus: () => {},
  notifyInputSurfaceChanged: () => {},
  // P4 批次后 ESM 图（input-render）反向触达这两个 classic 全局：生产由
  // input-composer / voice-input 提供（首屏后段脚本），本基座按最小面补。
  resolveInputSurfaceMode: () => 'chat',
  readInputSurfaceModeState: () => ({ requests: [] }),
  syncPersistentComposerSessionCard: () => {},
  hidePersistentComposerCard: () => {},
  detachTransientInputContent: () => {},
  _getSessionInputCacheKey: () => '',
  runWithSuppressedChatViewportObservers: (fn) => (typeof fn === 'function' ? fn() : undefined),
  _injectPendingVoiceResult: () => {},
  notifyChatViewportMutation: () => {},
  captureChatViewportAnchor: () => null,
  applyChatViewportAnchor: () => {},
  suppressChatViewportObservers: () => {},
  resumeChatViewportObservers: () => {},
  scheduleFollowLatestSettlePass: () => {},
  registerManualScrollIntent: () => {},
  isNearBottom: () => true,
  hasRecentManualScrollIntent: () => false,
  setFollowLatest: () => {},
  autoResize: () => {},
  isChoiceInputRequest: () => false,
  getChoiceInteractionSignature: () => '',
  renderChoiceInputRequest: () => {},
  renderPersistentInput: () => {},
  updateChatProcessToggle: () => {},
  toggleChatProcessVisibility: () => {},
  _renderRecapHint: () => {},
  _markAgentCallStartedForNotify: () => {},
  _syncQueueFromBackend: async () => {},
  poll: async () => {},
  updateChatContextBar: () => {},
  _cancelVoiceRecording: () => {},
  stopVoiceRecording: () => {},
  insertTransientInputCard: () => {},
  _renderLastCallElapsed: () => {},
  rebindQueueProjectionForRuntime: () => {},
  _shouldPreserveVoiceInputForRender: () => false,
  renderFeaturePanel: () => {},
  isUiOnlyAgentId: () => false,
  getPhSessionOwnershipParams: () => ({}),
  getEmptyTodoPlan: () => ({ tasks: [] }),
  getEmptyOverview: () => ({}),
  getEmptyHookInspector: () => ({ lifecycleOrder: [], features: [], hooks: [] }),
  setFollowLatest: () => {},
  refreshVisibleWorkspacePanelData: () => {},
  beginFollowLatestCooldown: () => {},
  beginFollowLatestEntryWindow: () => {},
  requestFollowLatest: () => {},
  updateProjectDocsetChrome: () => {},
  isRemoteNamespaceAgentId: () => false,
  splitRemoteNamespaceId: () => null,
};

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

/**
 * 用例的平台全局面：ESM 模块的裸引用（fetch / 观察者 / performance）与浏览器
 * 一致。`invoke` 默认回答空集（`get_connected_agents` 走它），使真实
 * `loadAgents` 链路在无服务端时也能干净收敛——用例要观测网络时自行覆盖。
 */
export function threadCaseOptions({ classic, fetch: fetchImpl, globals = {}, label = '' } = {}) {
  return {
    label,
    globals: {
      fetch: fetchImpl || (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, agents: [], connected: [], threads: [], sessions: [], logs: [] }),
        text: async () => '',
      })),
      MutationObserver: NoopObserver,
      ResizeObserver: NoopObserver,
      IntersectionObserver: NoopObserver,
      performance: globalThis.performance,
      // 浏览器平台全局：渲染链里用于属性选择器的转义（Node 没有）。
      CSS: { escape: (value) => String(value), supports: () => false },
      ...globals,
    },
    classic,
  };
}

/**
 * 在给定沙箱里装 classic 相：真实先行脚本序 → 宿主依赖桩（缺失才补）→
 * 用例夹具覆盖（无条件）→ classic 刷新引擎。
 *
 * @param {{ run: Function, loadSource: Function }} sandbox
 * @param {object} [overrides] 用例夹具（宿主能力覆盖与状态初值）
 */
export function prepareThreadClassicSandbox(sandbox, overrides = {}) {
  prepareClassicSandbox(sandbox);
  // 真实 invoke（app-core）会走网络；默认回答空集，避免把 /protoclaw/invoke
  // 的形状当成用例前提。
  // 工作空间宿主快照：真实 loadAgents 链路需要一条「已连接条目」，否则会按
  // 「空快照」降级告警（那是服务端异常的诊断路径，不是用例前提）。
  sandbox.invoke = async (type) => (type === 'get_connected_agents'
    ? [{ id: 'coder', source: 'prebuilt', kind: 'workspace' }]
    : {});
  for (const [name, value] of Object.entries(THREAD_HOST_STUBS)) {
    if (sandbox.run(`typeof ${name} !== 'undefined'`)) continue;
    sandbox[name] = value;
  }
  // thread-store 已迁 ESM（P4 T3）：不再由 classic 相 loadSource。它由生产图
  // （kernel-entry → p4-entry）带入；不装载整图的用例在 withThreadCaseEnv 里被
  // 显式求值一次，桥键因此在测试体开始前就可读写。
  //
  // classic 相仍需要 window.ClawThreads 可供用例播种线程事实，因此放一个占位对象，
  // 求值 thread-store 之后由 withThreadCaseEnv 把写入整体回放到真实状态。
  if (sandbox.run('typeof window.ClawThreads') === 'undefined') {
    sandbox.run('window.ClawThreads = { threads: [], byId: {}, sessionIndex: {}, activeConversation: null };'
      + ' window.__classicThreadFacts = window.ClawThreads;');
  }
  // 夹具覆盖放在引擎之后：引擎自己会用 `window.refreshThreads = ...` 这类赋值
  // 注册刷新入口，用例要观察/替换的正是这些最终面（放在前面会被引擎覆盖掉）。
  for (const [name, value] of Object.entries(overrides)) {
    sandbox[name] = value;
  }
  return sandbox;
}

/** 线程事实入索引（byId / sessionIndex），与引擎 `_rebuildIndexes` 同形。 */
export function seedThreadFacts(sandbox, threads) {
  sandbox.run(`window.ClawThreads.threads = ${JSON.stringify(threads)};
    (function () {
      const s = window.ClawThreads;
      s.byId = {};
      s.sessionIndex = {};
      for (const t of s.threads) {
        s.byId[t.threadId] = t;
        for (const sid of (t.sessionIds || [])) s.sessionIndex[t.agentId + '::' + sid] = t;
      }
    })();`);
}

/**
 * 播种线程事实（`ClawThreads.threads[]` + byId/sessionIndex 索引）。
 *
 * thread-store 迁 ESM 后 classic 相没有真实的 window.ClawThreads；prepareThreadClassicSandbox
 * 会放一个占位对象（`__classicThreadFacts`），written 值由 withThreadCaseEnv 在求值
 * 该模块后整体回放。因此调用方在 classic 相与模块相都可以直接播种。
 */

/** 让宿主后台链（switchAgent 的 loadAgents 等 fire-and-forget 工作）在本 case 内收敛。 */
async function settleCase() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 一个用例 = 一份沙箱 + 一张真实 ESM 图：classic 相装真实先行脚本序 + 引擎，
 * ESM 相真实 import 交互域。
 *
 * @param {object} options
 * @param {object} [options.fixtures] classic 夹具覆盖（宿主能力与状态初值）
 * @param {Array} [options.threads] 线程事实（写入 ClawThreads 索引）
 * @param {Function} [options.fetch] 网络夹具
 * @param {string} [options.label]
 */
export async function withThreadDomainCase(options, fn) {
  const { fixtures = {}, threads = [], fetch: fetchImpl, label = '', endpoints = [] } = options || {};
  return withThreadCaseEnv({
    label,
    endpoints,
    fetch: fetchImpl,
    classic: (sandbox) => {
      prepareThreadClassicSandbox(sandbox, fixtures);
      if (threads.length) seedThreadFacts(sandbox, threads);
    },
  }, async ({ c, requests }) => {
    const domain = await c.load(DOMAIN);
    const view = await c.load(VIEW_STORAGE);
    return fn({ c, domain, view, requests });
  });
}

/**
 * 交互域用例默认允许的网络端点（"已登记端点"）：线程事实、activate、会话消息
 * 只读出口、运行时快照与通知预热、以及工作空间动作 open_session 会走到的宿主
 * 查询。用例可再补 `endpoints`；不在表内的请求一律判红——用来抓"新增了一条
 * 没人登记的外部依赖"，而不是把网络面当黑盒。
 */
export const THREAD_BASE_ENDPOINTS = [
  /^\/protoclaw\/threads$/,
  /^\/protoclaw\/threads\/[^/]+\/(input|head)$/,
  /^\/protoclaw\/prebuilt_sessions\/activate$/,
  /^\/protoclaw\/prebuilt_sessions\/session_messages\?/,
  /^\/protoclaw\/prebuilt_sessions(\/|$)/,
  /^\/protoclaw\/get_connected_agents$/,
  /^\/protoclaw\/agent_detail/,
  /^\/protoclaw\/workspace_settings\/sidebar_layout$/,
  /^\/protoclaw\/remote_catalog$/,
  /^\/protoclaw\/ph_project\/projects$/,
  /^\/protoclaw\/app_info$/,
  /^\/protoclaw\/auth\/status$/,
  /^\/protoclaw\/invoke(\?|$)/,
  /^\/api\/agents$/,
  // 运行时数据加载链（真实 switchAgent → loadAgentData）读的同一组端点：
  // 会话、消息、工具、钩子、overview、todo、输入请求与通知预热。
  /^\/api\/agents\/[^/]+\/(notification|queued-inputs|user-turn|detail)$/,
  /^\/api\/agents\/[^/]+\/(sessions|messages|tools|hooks|overview|todo|input-requests|connection)/,
  /^\/api\/templates\/feature(\?|$)/,
  /^\/api\/mcp-info$/,
  /^\/api\/logs$/,
  // 语音提示音是静态资产（voice-input 迁 ESM 后在模块求值期预载），不是 API。
  /^\/sounds\//,
  // ui-prefs 带 agentId 查询参数（debug-panel-host 的 rail 偏好拉取，P4 T2 后随
  // 该模块进入 ESM 图），端点相同、查询串不同，允许 pattern 需放行 query。
  /^\/api\/feature-ui\/(ui-prefs|declarations)(\?|$)/,
];

/**
 * 非预期 warn/error 守卫：`info` / `log`（正常诊断）不要求为零，`warn` / `error`
 * 一律判红——它们是"链路里出现了本该没有的缺口"的信号，不能靠过滤放行。
 */
export function createThreadConsoleGuard() {
  const host = globalThis.console;
  const entries = [];
  const format = (args) => args
    .map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)))
    .join(' ');
  const recorder = {
    ...host,
    warn: (...args) => { entries.push({ level: 'warn', text: format(args) }); host.warn(...args); },
    error: (...args) => { entries.push({ level: 'error', text: format(args) }); host.error(...args); },
  };
  return {
    recorder,
    entries,
    assertClean(label = '') {
      assert.deepEqual(
        entries,
        [],
        `${label ? `${label}：` : ''}不得出现非预期 warn/error\n${entries.map((e) => `[${e.level}] ${e.text}`).join('\n')}`,
      );
    },
  };
}

/** 未登记端点断言：`requests` 里每个 URL 都要被某个允许模式命中。 */
export function assertRegisteredEndpoints(requests, patterns, label = '') {
  const unregistered = requests.filter((url) => !patterns.some((pattern) => pattern.test(url)));
  assert.deepEqual(
    unregistered,
    [],
    `${label ? `${label}：` : ''}出现未登记端点（新增外部依赖必须显式登记）\n${unregistered.join('\n')}`,
  );
}

/**
 * 交互域用例外壳：一个 case = 真实 classic 链 + 真实 ESM 图 + 非预期
 * warn/error 守卫 + 端点登记断言。网络请求统一记录（用例自带 fetch 时在其之上
 * 再记一层），宿主后台链在本 case 内收敛后再判定。
 *
 * @param {object} options 透传给 threadCaseOptions（classic / fetch / globals / label），
 *   另接受 `endpoints`（在 THREAD_BASE_ENDPOINTS 之外追加允许项）
 */
export async function withThreadCaseEnv(options, fn) {
  const { endpoints = [], fetch: fetchImpl, globals = {}, ...rest } = options || {};
  const guard = createThreadConsoleGuard();
  const requests = [];
  const baseFetch = fetchImpl || (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, agents: [], connected: [], threads: [], sessions: [], logs: [] }),
    text: async () => '',
  }));
  const fetch = async (url, init) => {
    requests.push(String(url));
    return baseFetch(url, init);
  };
  return withP2EsmCase(threadCaseOptions({
    ...rest,
    fetch,
    globals: { ...globals, console: guard.recorder },
  }), async (c) => {
    // thread-store 迁 ESM 后，classic 相不再提供 window.ClawThreads / refreshThreads；
    // 用例体开始前先求值该模块一次（整图用例里 p4-entry 已带入，这里是同一实例）。
    await c.load('public/src/modules/thread-store.js');
    // classic 相播下的线程事实回放到真实 owner（桥键是活绑定，回放后即同一状态）。
    c.sandbox.run(`(function () {
      const pending = window.__classicThreadFacts;
      const live = window.ClawThreads;
      if (!pending || !live || pending === live) return;
      live.threads = pending.threads;
      live.byId = pending.byId;
      live.sessionIndex = pending.sessionIndex;
      if (pending.activeConversation != null) live.activeConversation = pending.activeConversation;
      delete window.__classicThreadFacts;
    })()`);
    const result = await fn({ c, requests });
    await settleCase();
    return result;
  }).then((result) => {
    const label = rest.label || '';
    guard.assertClean(label);
    assertRegisteredEndpoints(requests, [...THREAD_BASE_ENDPOINTS, ...endpoints], label);
    return result;
  });
}
