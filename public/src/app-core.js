/**
 * app-core.js — 会话视图 / 编排瞬态 / 渲染入口状态与首屏宿主工厂（P4 收尾批：
 * classic → ESM，活跃域最后一件）。
 *
 * 本文件此前是 index.html 的 classic 脚本，顶层语句在**解析相**执行；迁 ESM 后改在
 * **模块相**执行，装载位置不变（index.html 中改为 `<script type="module">`，仍在
 * kernel-state 之后、其余 module 标签之前）。位置是语义的一部分，见下。
 *
 * ## 相位：本文件必须最早求值（除了一个叶子状态模块）
 *
 * 46 条 `window.KernelState.defineKey()` 是**别的域**的注册行（agent-loader /
 * agent-store / orchestration / session-view-storage / render-entry /
 * panel-layout-state / i18n-environment / call-interrupt）。kernel-state 契约里
 * 「域已认领时 defineKey 把初值经 impl.set 写进域状态」，因此注册相位必须早于
 * 那些域的 claim。迁入模块相后，这条时序由「本文件是最早求值的 module 入口」表达。
 *
 * 唯一静态依赖是 `./modules/orchestration-state.js`（纯状态 owner，无自身依赖）：
 * 本文件要写 `_pendingSessionNavigation` / `_restoredScrollTop` 并读活绑定，若走
 * `window.X =` 会新增全局状态台账。代价是 orchestration 域的 claim 提前到本文件的
 * 注册行之前——defineKey 随后把同一批初值经 impl.set 推进域状态，**终态与迁移前
 * 逐键相同**（注册初值本身就是迁移前的初值；中间没有其它写方）。
 *
 * ## 对外面：domain `app-core` 的桥键
 *
 * 迁 ESM 后，原先「顶层 function = window 属性」「顶层 let/const = 全局词法绑定」两条
 * 可达路径同时消失。仍从 window 取用本文件符号的三类消费方，按桥键唯一注册制逐键
 * 承接（文件末尾 `bridgeSlots` + 逐键 defineKey；不用循环注册——桥债门禁按文本统计
 * `KernelState.defineKey(` 调用数，循环会让整套桥面在门禁刻度里消失）：
 *
 *   1. 已迁 ESM 模块经 `window.<fn>()` / `window.<key>` 取用：app-main / app-ui /
 *      project-data / sidebar-render / p2-bootstrap-* / debug-* / ctx-menu-* / ph-* /
 *      chat-viewport / todo-plan 等 30+ 文件；
 *   2. 仍 classic 的消费方：im-ui / im-actions（悬置域，配方第四节禁改）裸读写
 *      `qqbotConfigState` / `qqbotConfigRequest` / `imWorkspaceState` /
 *      `imWorkspaceRequest` / `imWorkspaceAutoSaveTimer`；desktop-notify（R4 触线保留
 *      classic）裸调 `_recentlyFinishedRuntimes.delete()`；
 *   3. 测试夹具把其中大部分当作沙箱全局（约 60 个 test 文件）。
 *
 * 槽位语义（`bridgeSlots`）：
 *   - 函数键（fnSlot）→ 值槽：整替只改窗口面，本模块内部互调仍走模块绑定（与迁移前
 *     「改写 window 属性会连内部调用一起改」的差异是 plan P4 第十批记录的已接受边界）；
 *   - `let` 状态键（letSlot）→ 读写指向模块声明本身，不另存；
 *   - const 容器（constSlot）→ 按引用交出模块里的容器，整替只改窗口面（迁移前
 *     classic const 与同名 `window.X` 普通属性本就分叉）。
 *
 * 注销条件（逐键同口径）：第 1 类消费方改具名 import、第 3 类改经 `__esmDomain.appCore`
 * 取用后，删除 `bridgeSlots` 里对应条目与 defineKey 行（消费面 grep 归零为准）。
 * 第 2 类的 6 个状态键随悬置域重做 / desktop-notify 迁 ESM 一并注销。
 *
 * 其余零消费面符号（PREBUILT_AGENTS / loadChatProcessVisibility /
 * _interruptTargetCache / getUserCollapseStateContextKey / getUserCollapseStateForContext /
 * convertLegacyWorkspaceToUi / getLegacyActionLabel / getLegacyActionTarget）收敛为
 * 模块私有：不注册、不上桥、不导出。`MAX_CACHED_RUNTIME_VIEWS` / `POLL_*` 两个常量
 * 只经既有宿主工厂交出（`createRuntimeViewCacheHost` / `createP2BootstrapPollHost`），
 * 也不单独上桥。
 */

import {
  _navigationGuardEpoch,
  _pendingSessionNavigation,
  _chatLoadingSession,
  currentRuntimeAgentId,
  setNavigationGuardEpoch,
  setPendingSessionNavigation,
  setRestoredScrollTop,
} from './modules/orchestration-state.js';

// The const Set remains the unique classic reference until its consumers migrate.
export const loadedAgentDetailIds = new Set();
window.AgentLoaderHost = Object.freeze({ loadedAgentDetailIds });
// Template resets can occur before ESM execution; claim absorbs the latest value.
window.KernelState.defineKey('agent-loader', 'FEATURE_TEMPLATE_MAP', {});

// P4 T1 从本文件抽出的四族（owner 已在模块相，classic 侧只剩桥键）：
//   - 首屏 DOM 引用区 → modules/dom-refs.js（域 dom-refs：container / currentAgentTitle）
//   - 身份解析域     → modules/identity.js（域 identity：10 键，本文件内部经
//                      window.<fn> 调用，见各调用点注释）
//   - 传输域         → modules/transport.js（域 transport：invoke，classic 侧
//                      app-main / 悬置域 wg-* 仍经 window.invoke 调用）
//   - 展示格式化函数族 → modules/format-utils.js（域 format-utils：
//                      localizeWorkspaceValue ← 悬置域 im-ui）
// 本文件保留的是会话视图/编排/渲染入口状态与首屏渲染期仍被 classic 消费的
// 宿主工厂（createP2Bootstrap*Host）。

const PREBUILT_AGENTS = [];
export const pendingPrebuiltAgentIds = new Set();
export let suppressSidebarRerender = false;
export const restartingRuntimeIds = new Set();

window.KernelState.defineKey('agent-store', 'focusedAgentId', null);
window.KernelState.defineKey('orchestration', 'currentRuntimeAgentId', null);
window.KernelState.defineKey('agent-store', 'readOnlyMode', false);
window.KernelState.defineKey('agent-store', 'loadAgentsInFlight', null);
export const workspaceSurfaceModePreferences = {};
window.KernelState.defineKey('agent-store', 'allAgents', []);
// 追踪每个 agent 的 call 运行状态（实时更新，比 3s 轮询更快）
export const _agentCallActive = new Map();
// 中断中的 runtime：用户点击打断后，abort 生效与 call.finish 之间天然存在异步间隔。
// 这里记录的是一个粘性生命周期状态，而不是定时“抑制窗口”。只有同一 call 的终态
// （callActive:false / call.finish）、明确的请求失败，或一个更新的 callStartedAt 才能清除它。
export const _interruptSuppression = new Map();

// ── Polling intervals ──────────────────────────────────────────
const POLL_INTERVAL_MS   = 1000; // 正常态轮询间隔
const POLL_FAST_INTERVAL_MS = 300; // 忙碌态/会话切换加速轮询间隔
// Keep the original const Map available to classic sidebar pruning. The ESM
// policy receives the same reference, so pruning and notification reads agree.
export function createCallInterruptHost() {
  return { pending: _interruptSuppression, now: () => Date.now() };
}
// 追踪刚完成调用的 runtimeId，用于在侧边栏显示"已完成"指示灯
export const _recentlyFinishedRuntimes = new Set();
// 全局 choice 请求提醒：跟踪已弹 toast 的 requestId，避免重复提醒
export const _seenChoiceAlertIds = new Set();
let _lastChoiceAlertCheckAt = 0;
window.KernelState.defineKey('session-view-storage', 'currentMessages', []);
window.KernelState.defineKey('session-view-storage', 'currentInputRequests', []);
window.KernelState.defineKey('session-view-storage', 'toolRenderConfigs', {});
window.KernelState.defineKey('session-view-storage', 'TOOL_NAMES', {});
export const _autoTitleTriggered = new Set();
let contextMenuAgentId = null;
let contextMenuAgentMode = null;
let contextMenuCompactAction = null;
let contextMenuProjectAgentId = null;
let contextMenuProjectId = null;
let contextMenuFeatureRepoPackageId = null;
window.KernelState.defineKey('render-entry', 'activeFeaturePanel', null);
window.KernelState.defineKey('render-entry', 'currentWorkspaceTab', null);
window.KernelState.defineKey('render-entry', 'shouldAnimateWorkspaceSurface', true);
let _workGroupEventsWired = false;
let assemblyDraftRenderTimer = null;
window.KernelState.defineKey('agent-store', 'expandedProjectIds', new Set());
let savedPhTabState = {};
let assemblyLaunchInProgress = false;
let assemblyControlPanelOpen = false;
let assemblySideRailRevealTimer = null;
window.KernelState.defineKey('render-entry', 'currentWorkspaceArtifactDetail', null);
window.KernelState.defineKey('render-entry', 'currentWorkspaceDocsetDetail', null);
window.KernelState.defineKey('render-entry', 'currentProjectDocsetOpen', false);
window.KernelState.defineKey('render-entry', 'currentProjectRequirementEdit', null);
window.KernelState.defineKey('render-entry', 'currentProjectDocsetPage', 'requirement');
window.KernelState.defineKey('panel-layout-state', 'featurePanelWidth', 460);
window.KernelState.defineKey('i18n-environment', 'currentTheme', localStorage.getItem('agentdev-theme') || 'dark');
window.KernelState.defineKey('i18n-environment', 'currentLanguage', localStorage.getItem('agentdev-language') || 'zh');
const CHAT_PROCESS_VISIBILITY_KEY = 'agentdev-chat-show-process';
function loadChatProcessVisibility() {
  try {
    return localStorage.getItem(CHAT_PROCESS_VISIBILITY_KEY) === 'true';
  } catch (error) {
    console.warn('Failed to load chat process visibility:', error);
    return false;
  }
}
let showChatProcess = loadChatProcessVisibility();
window.KernelState.defineKey('session-view-storage', 'currentHookInspector', { lifecycleOrder: [], features: [], hooks: [] });
window.KernelState.defineKey('session-view-storage', 'currentHookInspectorSignature', '');
window.KernelState.defineKey('session-view-storage', 'currentOverviewSnapshot', {
  updatedAt: 0,
  context: {
    messageCount: 0,
    charCount: 0,
    toolCallCount: 0,
    turnCount: 0,
  },
  usageStats: {
    totalUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    calls: [],
    totalRequests: 0,
    totalCacheHitRequests: 0,
  },
});
window.KernelState.defineKey('session-view-storage', 'currentOverviewSignature', '');
window.KernelState.defineKey('session-view-storage', 'currentTodoPlan', {
  feature: 'todo',
  updatedAt: 0,
  counter: 0,
  tasks: [],
  summary: { total: 0, pending: 0, inProgress: 0, completed: 0, cancelled: 0, blocked: 0 },
});
window.KernelState.defineKey('session-view-storage', 'currentTodoPlanSignature', '');
let _interruptTargetCache = new Map(); // key: runtimeContextKey, value: taskId|null
let _lastInterruptUserActionAt = 0; // timestamp of last user click on interrupt control
export function getInterruptTargetId() {
  // 桥接期：定义于 identity.js（app-main 迁 ESM 后改具名 import）。
  const key = window.getRuntimeContextKey();
  if (!key) return null;
  return _interruptTargetCache.get(key) || null;
}
export function setInterruptTargetId(taskId) {
  const key = window.getRuntimeContextKey();
  if (!key) return;
  if (taskId) {
    _interruptTargetCache.set(key, taskId);
  } else {
    _interruptTargetCache.delete(key);
  }
}
let currentLogs = [];
let currentLogsSignature = '';
let currentLogsTruncation = null;
let currentMcpInfo = null;
let lastFeatureTemplateReloadAt = 0;
window.KernelState.defineKey('agent-store', 'lastAgentListRefreshAt', 0);
window.KernelState.defineKey('agent-store', 'lastCallStateRefreshAt', 0);
let templateWarmupToken = 0;
let qqbotConfigState = {
  data: null,
  draft: null,
  loading: false,
  saving: false,
  error: '',
  sourcePath: '',
  savedAt: null,
};
let qqbotConfigRequest = null;
let imWorkspaceState = {
  data: null,
  draft: null,
  loading: false,
  saving: false,
  binding: false,
  polling: false,
  error: '',
  savedAt: null,
  weixinQrDialogOpen: false,
  // 可绑定线程清单（/protoclaw/im_routable_targets 的派生投影）。线路的
  // 目标下拉从这里取，不是配置事实；请求句柄同域存放。
  routableTargets: null,
  routableTargetsRequest: null,
};
let imWorkspaceRequest = null;
let imWorkspaceAutoSaveTimer = null;
export let logFilters = {
  search: '',
  level: 'all',
  feature: 'all',
  lifecycle: 'all',
  call: 'all',
};
let selectedOverviewLifecycle = 'StepFinish';
let selectedFeatureName = null;
let selectedRepositoryPackageId = null;
let repoSearchQuery = '';
let repoSourceFilter = 'all';
let followLatestEnabled = true;
let suppressFollowScrollEvent = false;
let lastManualScrollIntentAt = 0;
let _progScrollCooldownUntil = 0;
let followLatestEntryUntil = 0;
let chatViewportObserversReady = false;
let chatViewportObserverSuppressDepth = 0;
let chatViewportObserverQuietUntil = 0;
let chatViewportMutationObserver = null;
let chatViewportResizeObserver = null;
let chatViewportSettlementToken = 0;
let chatViewportSettlementRaf = 0;
let chatViewportSettlementTimer = null;
let chatViewportSettlementContext = null;
let chatViewportFollowRaf = 0;
let chatViewportFollowToken = 0;
let chatViewportFollowTransition = 'locked';
let prebuiltSessionSwitchInFlight = false;
window.KernelState.defineKey('orchestration', 'pendingSwitchTarget', null);   // { runtimeId, serial, source, navEpoch }
window.KernelState.defineKey('orchestration', 'pendingSwitchSerial', 0);      // monotonically increasing
// 工单 037：lastRenderedInputSignature / lastRenderedInputMode 已内化到
// input-render.js（渲染器私有去重状态），手动 reset 协议退役。
window.KernelState.defineKey('render-entry', 'unitModePreferences', {});
window.KernelState.defineKey('render-entry', 'lastRenderedWorkspaceHtml', '');
window.KernelState.defineKey('render-entry', 'lastRenderedWorkspaceScrollKey', '');
const workspaceSurfaceScrollCache = new Map();
window.KernelState.defineKey('render-entry', 'workspaceSurfaceScrollSaveRaf', 0);
window.KernelState.defineKey('render-entry', '_lastRenderedChatSig', '');
window.KernelState.defineKey('orchestration', '_restoredScrollTop', null);    // set by restoreRuntimeFromCache, consumed by switchAgent
window.KernelState.defineKey('orchestration', '_chatLoadingSession', false);  // true while waiting for a just-opened session's messages to arrive
// _chatLoadingTimeout 桥已注销：该槽无 classic 消费方，状态唯一 owner 是
// orchestration-state.js（ESM，初值 null），生产读写经 chat-loading-host 的工厂注入。
window.KernelState.defineKey('orchestration', '_switchEpoch', 0);             // monotonically increasing; used to guard stale async work from rapid switches

// A committed session can be the user's navigation target before its runtime
// exists. Keep that intent separate from currentRuntimeAgentId so the tabless
// workspace can show the chat loading surface without inventing a sidebar leaf.
window.KernelState.defineKey('orchestration', '_pendingSessionNavigation', null);

// 状态 owner 是 orchestration-state（domain orchestration，本文件只注册它的访问器）：
// 读经具名 import 的活绑定、写经该域的 setter——同一份绑定，不经 window 转发。
export function beginPendingSessionNavigation(agentId, sessionId = '', phase = 'committing') {
  const normalizedAgentId = String(agentId || '').trim();
  if (!normalizedAgentId) return null;
  setPendingSessionNavigation({
    agentId: normalizedAgentId,
    sessionId: String(sessionId || '').trim(),
    phase: String(phase || 'committing'),
    navigationEpoch: _navigationGuardEpoch,
  });
  return _pendingSessionNavigation;
}

export function updatePendingSessionNavigation(sessionId, phase = 'starting-runtime') {
  if (!_pendingSessionNavigation) return null;
  setPendingSessionNavigation({
    ..._pendingSessionNavigation,
    sessionId: String(sessionId || _pendingSessionNavigation.sessionId || '').trim(),
    phase: String(phase || _pendingSessionNavigation.phase || 'committing'),
  });
  return _pendingSessionNavigation;
}

export function clearPendingSessionNavigation() {
  setPendingSessionNavigation(null);
}

export function hasPendingSessionNavigation(agent = null) {
  if (!_pendingSessionNavigation || _pendingSessionNavigation.navigationEpoch !== _navigationGuardEpoch) {
    return false;
  }
  if (!agent) return true;
  return String(agent.id || '').trim() === _pendingSessionNavigation.agentId;
}

// ── Navigation Guard ──────────────────────────────────────────────────────
// Every user-initiated navigation (workspace switch, session switch, opening
// a new session, etc.) bumps this epoch.  Async operations that will
// eventually auto-navigate (e.g. runSessionOpen → requestSwitch) capture the
// epoch at start and check it before executing the deferred navigation.
// If the user navigated away in the meantime, the stale operation aborts
// silently instead of yanking the user back.
window.KernelState.defineKey('orchestration', '_navigationGuardEpoch', 0);

export function bumpNavigationGuard() {
  setNavigationGuardEpoch(_navigationGuardEpoch + 1);
  if (_pendingSessionNavigation) {
    setPendingSessionNavigation(null);
  }
}
let phSessionSortMode = 'updatedAt'; // 'updatedAt' | 'createdAt' — programming-helper session list sort preference
let phSearchQuery = '';              // current search query for session list
let _phSearchTimer = null;           // debounce timer for search input

// ── User expand/collapse preferences (survive full re-render) ──────────────
// Keyed by message index within the active runtime context. These override
// syncCollapseStates auto-rules.
let _userExpandedReasoning = new Set();  // reasoning blocks the user expanded
let _userCollapsedMsgs = new Set();       // messages the user explicitly collapsed
let _userExpandedMsgs = new Set();        // messages the user explicitly expanded (un-collapsed)

// ── Per-session runtime data cache (P0: optimistic render on switch) ────────
// Caches messages, toolRenderConfigs, TOOL_NAMES, hookInspector + signature,
// overviewSnapshot + signature, and connection status per runtime context.
// Full transcripts can be large; keep only recently visited views for instant return.
const MAX_CACHED_RUNTIME_VIEWS = 4;
const _agentRuntimeCache = new Map();
const _userCollapseStateByContext = new Map();

// 桥接期：currentRuntimeAgentId 的 owner 是 orchestration-state（具名 import 活绑定）；
// focusedAgentId 的 owner 是 agent-store-state（本文件只注册访问器，经 window 晚绑定）。
function getUserCollapseStateContextKey(runtimeId = currentRuntimeAgentId) {
  const runtimeKey = typeof window.getRuntimeContextKey === 'function' ? window.getRuntimeContextKey(runtimeId) : null;
  if (runtimeKey) return runtimeKey;
  const agentKey = String(window.focusedAgentId || '').trim();
  return agentKey ? `agent:${agentKey}` : 'global';
}

function getUserCollapseStateForContext(contextKey = getUserCollapseStateContextKey()) {
  const key = contextKey || 'global';
  let state = _userCollapseStateByContext.get(key);
  if (!state) {
    state = {
      expandedReasoning: new Set(),
      collapsedMsgs: new Set(),
      expandedMsgs: new Set(),
    };
    _userCollapseStateByContext.set(key, state);
  }
  return state;
}

export function activateUserCollapseStateForContext(contextKey = getUserCollapseStateContextKey()) {
  const state = getUserCollapseStateForContext(contextKey);
  _userExpandedReasoning = state.expandedReasoning;
  _userCollapsedMsgs = state.collapsedMsgs;
  _userExpandedMsgs = state.expandedMsgs;
}

export function resetUserCollapseStateForContext(contextKey = getUserCollapseStateContextKey()) {
  const key = contextKey || 'global';
  _userCollapseStateByContext.delete(key);
  activateUserCollapseStateForContext(key);
}

// Temporary adapter for classic lexical state. Cache policy lives in ESM;
// these closures keep viewport/collapse initialization at its original time.
export function createRuntimeViewCacheHost() {
  return {
    cache: _agentRuntimeCache,
    capacity: MAX_CACHED_RUNTIME_VIEWS,
    contextKey: (runtimeId) => window.getRuntimeContextKey(runtimeId),
    // 以下外来键都是运行期调用，经 window 晚绑定取用（定义域见行尾）：
    readView: () => window.readCurrentSessionViewState(),              // session-view-state
    signatures: () => ({ hookInspector: window.currentHookInspectorSignature,
      overview: window.currentOverviewSignature,
      todo: typeof window.currentTodoPlanSignature !== 'undefined' ? window.currentTodoPlanSignature : undefined }),
    todoSignature: (plan) => typeof window.getTodoPlanSignature === 'function'
      ? window.getTodoPlanSignature(plan) : JSON.stringify(plan),                 // todo-plan
    emptyTodo: () => typeof window.getEmptyTodoPlan === 'function' ? window.getEmptyTodoPlan() : null, // todo-plan
    followLatest: () => followLatestEnabled,
    setFollowLatest: (value) => { followLatestEnabled = value; },
    captureAnchor: (contextKey) => typeof window.rememberChatViewportAnchorForContext === 'function'
      && typeof window.getChatViewportContextKey === 'function' && window.getChatViewportContextKey() === contextKey
      ? window.rememberChatViewportAnchorForContext(contextKey)                   // chat-viewport
      : (typeof window.getRememberedChatViewportAnchorForContext === 'function'
        ? window.getRememberedChatViewportAnchorForContext(contextKey) : null),   // chat-viewport
    // 桥接期：container 的 owner 已迁 dom-refs.js。
    scrollTop: () => window.container ? window.container.scrollTop : 0,
    activeCollapseContext: () => getUserCollapseStateContextKey(),
    forgetContext(contextKey) {
      _userCollapseStateByContext.delete(contextKey);
      if (typeof window.forgetChatViewportAnchorForContext === 'function') window.forgetChatViewportAnchorForContext(contextKey);
    },
    activateCollapse: (contextKey) => activateUserCollapseStateForContext(contextKey),
    normalizeIdentity: (identity) => typeof window.normalizeSessionViewIdentity === 'function'
      ? window.normalizeSessionViewIdentity(identity) : identity,                 // session-view-state
    patch: (patch) => window.applySessionViewPatch(patch),                        // session-view-state
    setRestoredScrollTop: (value) => { setRestoredScrollTop(value); },
    restoreAnchor: (anchor) => {
      if (typeof window.setPendingChatViewportAnchor === 'function') window.setPendingChatViewportAnchor(anchor); // chat-viewport
    },
    updatePlanBadge: () => { if (typeof window.updatePlanBadge === 'function') window.updatePlanBadge(); }, // todo-plan
  };
}

// 格式化函数族（formatPresetDisplayName / localizeWorkspaceValue / fmtPct /
// getFeatureStatus / getFeatureStatusLabel / getStatusBadgeClass）已迁
// modules/format-utils.js（P4 T1）：本文件零内部调用点，classic 消费方
// （悬置域 im-ui）经 window.localizeWorkspaceValue 桥键。

// _chatLoadingSession 经具名 import 活绑定（owner：orchestration-state）；currentLanguage
// 的 owner 是 i18n-environment、escapeHtml / t 的桥键定义于 markdown-utils / i18n-host，
// 一律经 window 晚绑定（运行期调用）。
export function getEmptyStateHtml() {
  if (_chatLoadingSession) {
    return '<div class="empty-state chat-loading"><span class="chat-loading-spinner"></span><span>'
      + window.escapeHtml(window.currentLanguage === 'zh' ? '正在加载对话…' : 'Loading conversation…')
      + '</span></div>';
  }
  let _isZh = window.currentLanguage === 'zh';
  const _displayName = window.ClawFW?.workspaceAgents?.getWelcomeName() || '';
  let _title = _displayName
    ? (_isZh ? '欢迎使用' : 'Welcome to')
    : (_isZh ? '新对话' : 'New Conversation');
  let _hint = _isZh ? '输入消息开始对话' : 'Type a message to begin';
  if (_displayName) {
    return '<div class="empty-state empty-welcome">'
      + '<div class="empty-welcome-title">' + window.escapeHtml((_isZh ? '欢迎使用 ' : 'Welcome to ') + _displayName) + '</div>'
      + '<div class="empty-welcome-deco"></div>'
      + '<div class="empty-welcome-hint">' + window.escapeHtml(_hint) + '</div>'
      + '</div>';
  }
  return '<div class="empty-state empty-welcome">'
    + '<div class="empty-welcome-title">' + window.escapeHtml(_title) + '</div>'
    + '<div class="empty-welcome-deco"></div>'
    + '<div class="empty-welcome-hint">' + window.escapeHtml(_hint) + '</div>'
    + '</div>';
}

export function getFeaturePanelEmptyHtml() {
  return '<div class="feature-panel-empty"><div>' + window.escapeHtml(window.t('panel_hint')) + '</div></div>';
}

function convertLegacyWorkspaceToUi(workspace) {
  if (!workspace || typeof workspace !== 'object') return null;

  const blocks = [];
  if (workspace.welcome) {
    blocks.push({
      id: 'hero',
      type: 'hero',
      title: workspace.welcome.title,
      body: workspace.welcome.body,
    });
  }

  const legacyActions = Array.isArray(workspace.welcome?.actions) ? workspace.welcome.actions : [];
  if (legacyActions.length > 0) {
    blocks.push({
      id: 'entry-actions',
      type: 'action-group',
      actions: legacyActions.map((action) => ({
        label: getLegacyActionLabel(action),
        action: { type: action === 'chat' ? 'show_chat' : 'show_block', target: getLegacyActionTarget(action) },
      })),
    });
  }

  if (workspace.history) {
    blocks.push({ id: 'history', type: 'session-list', visibility: 'focus', ...workspace.history });
  }
  if (workspace.form) {
    blocks.push({ id: 'form', type: 'form', visibility: 'focus', submitAction: { type: 'show_chat' }, ...workspace.form });
  }
  if (workspace.live) {
    blocks.push({ id: 'status', type: 'status-grid', ...workspace.live });
  }

  return { entry: workspace.entryView === 'chat' ? 'chat' : 'home', home: { blocks } };
}

function getLegacyActionLabel(action) {
  if (action === 'history') return { zh: '继续会话', en: 'Continue Session' };
  if (action === 'form') return { zh: '新对话', en: 'New Chat' };
  if (action === 'live') return { zh: '查看状态', en: 'View Status' };
  return { zh: '进入对话', en: 'Open Chat' };
}

function getLegacyActionTarget(action) {
  if (action === 'history') return 'history';
  if (action === 'form') return 'form';
  if (action === 'live') return 'status';
  return null;
}

// 桥接期：getCurrentAgentRecord 的桥键定义于 app-main（运行期取用）。
export function getCurrentUnitUi(agent = window.getCurrentAgentRecord()) {
  if (!agent) return null;
  if (agent.ui && typeof agent.ui === 'object') return agent.ui;
  if (agent.workspace && typeof agent.workspace === 'object') return convertLegacyWorkspaceToUi(agent.workspace);
  return null;
}

export function isUiOnlyUnit(agent) {
  return !!(agent && agent.source === 'prebuilt' && agent.launchMode === 'ui-only');
}

export function isWorkspaceHostUnit(agent) {
  if (!agent || agent.source !== 'prebuilt') return false;
  // 声明驱动：metadata `kind: "workspace"` 即工作空间（点开进首页，不经
  // start_agent 拉起 runtime）。kind 的语义是「是否有首页的工作空间」，
  // runtime 形态由 launchMode（ui-only）与各 APP 自己的事务另行表达。
  return agent.kind === 'workspace';
}

export function isTablessHostSurface(agent) {
  return isWorkspaceHostUnit(agent) && agent?.id !== 'agent-studio';
}

// PH 风格工作区（项目列表 / 会话列表首页）：编程小助手本体。Coder APP
// 不在此列——其首页是线程视图（plugins/coder 前端插件，经 ui.home blocks 渲染）。
const PH_STYLE_WORKSPACE_AGENT_IDS = new Set(['programming-helper']);

export function isPhStyleWorkspaceAgent(agent = window.getCurrentAgentRecord()) {
  return !!(agent && agent.source === 'prebuilt' && PH_STYLE_WORKSPACE_AGENT_IDS.has(agent.id));
}

export function isWorkspaceSurfaceUnit(agent) {
  return isUiOnlyUnit(agent) || isWorkspaceHostUnit(agent);
}

// 桥接期：allAgents 的 owner 是 agent-store-state（本文件只注册访问器）。
export function isUiOnlyAgentId(agentId) {
  const directAgent = window.allAgents.find((item) => item.id === agentId);
  if (directAgent) {
    return isWorkspaceSurfaceUnit(directAgent);
  }
  const runtimeAgent = window.allAgents.find((item) => !isWorkspaceSurfaceUnit(item) && window.getAgentRuntimeId(item) === agentId);
  return isWorkspaceSurfaceUnit(runtimeAgent);
}

export function getRuntimeRecord(agentId = currentRuntimeAgentId) {
  if (!agentId) return null;
  return window.allAgents.find((item) => !isWorkspaceSurfaceUnit(item) && window.getAgentRuntimeId(item) === agentId) || null;
}

export function findAgentByIdentity(agentId) {
  if (!agentId) return null;
  return window.allAgents.find((item) =>
    item.id === agentId
    || item.runtime_session_id === agentId
    || item.runtimeSessionId === agentId
    || (!isWorkspaceSurfaceUnit(item) && window.getAgentRuntimeId(item) === agentId)
  ) || null;
}

export function resolveWorkspaceFallbackAgentId(agent = window.getCurrentAgentRecord()) {
  if (window.focusedAgentId && window.allAgents.some((item) => item.id === window.focusedAgentId)) {
    return window.focusedAgentId;
  }
  const parentId = String(agent?.parent_id || '').trim();
  if (parentId && window.allAgents.some((item) => item.id === parentId)) {
    return parentId;
  }
  if (window.allAgents.some((item) => item.id === 'agent-creator')) return 'agent-creator';
  if (window.allAgents.some((item) => item.id === 'home')) return 'home';
  return window.allAgents[0]?.id || null;
}

// ── P2 bootstrap 消费接口（classic 侧唯一实现）─────────────────────────────
// 首屏同步边界内的 classic 词法状态（顶层 let/const）没有 window 可达形态：ESM
// 消费方既不能裸读全局词法（那是门禁看不见的债务），也不能假装 window 可达。
// 下面按职责分域的 host 工厂是这些键唯一的 classic 实现入口，ESM 侧经
// modules/p2-bootstrap-*.js 适配模块取得读写接口（P1 的 createXHost 同款窄面）。
//
// 约束：
// - owner 不变：状态仍在各自 classic 声明处——初始化时点、const 只读语义、
//   Map/Set 引用身份、既有 classic 写方全部照旧。host 不持有副本，访问器实时
//   转发；禁止在此另存一份状态，也禁止把状态搬到 classic 声明之外去持有。
// - 只暴露已证实存在 P2 消费方（modules/ 下的文件）的键；新增键须附消费证据。
// - 撤除条件（P3）：该域消费方全部改为 import 已迁 ESM 的 owner 后，删除对应
//   工厂与适配模块；在此之前不得把它当作状态真相源。

/**
 * 聊天表面状态：跟随滚动开关、视口观察/结算句柄、过程可见性偏好。
 * 消费方：chat-viewport / chat-scroll / chat-renderer / chat-row-visibility /
 * lazy-tool-content / input-helpers / chat-context-bar / input-render /
 * runtime-status / app-main。
 * 注：followLatestEnabled 另经 createRuntimeViewCacheHost 供 runtime-view-cache
 * ESM 使用——两处都是同一 classic 声明的转发，不构成双存储。
 */
export function createP2BootstrapChatSurfaceHost() {
  return Object.freeze({
    CHAT_PROCESS_VISIBILITY_KEY, // 只读：localStorage 键名常量
    get showChatProcess() { return showChatProcess; },
    set showChatProcess(value) { showChatProcess = value; },
    get followLatestEnabled() { return followLatestEnabled; },
    set followLatestEnabled(value) { followLatestEnabled = value; },
    get suppressFollowScrollEvent() { return suppressFollowScrollEvent; },
    set suppressFollowScrollEvent(value) { suppressFollowScrollEvent = value; },
    get lastManualScrollIntentAt() { return lastManualScrollIntentAt; },
    set lastManualScrollIntentAt(value) { lastManualScrollIntentAt = value; },
    get _progScrollCooldownUntil() { return _progScrollCooldownUntil; },
    set _progScrollCooldownUntil(value) { _progScrollCooldownUntil = value; },
    get followLatestEntryUntil() { return followLatestEntryUntil; },
    set followLatestEntryUntil(value) { followLatestEntryUntil = value; },
    get chatViewportObserversReady() { return chatViewportObserversReady; },
    set chatViewportObserversReady(value) { chatViewportObserversReady = value; },
    get chatViewportObserverSuppressDepth() { return chatViewportObserverSuppressDepth; },
    set chatViewportObserverSuppressDepth(value) { chatViewportObserverSuppressDepth = value; },
    get chatViewportObserverQuietUntil() { return chatViewportObserverQuietUntil; },
    set chatViewportObserverQuietUntil(value) { chatViewportObserverQuietUntil = value; },
    get chatViewportMutationObserver() { return chatViewportMutationObserver; },
    set chatViewportMutationObserver(value) { chatViewportMutationObserver = value; },
    get chatViewportResizeObserver() { return chatViewportResizeObserver; },
    set chatViewportResizeObserver(value) { chatViewportResizeObserver = value; },
    get chatViewportSettlementToken() { return chatViewportSettlementToken; },
    set chatViewportSettlementToken(value) { chatViewportSettlementToken = value; },
    get chatViewportSettlementRaf() { return chatViewportSettlementRaf; },
    set chatViewportSettlementRaf(value) { chatViewportSettlementRaf = value; },
    get chatViewportSettlementTimer() { return chatViewportSettlementTimer; },
    set chatViewportSettlementTimer(value) { chatViewportSettlementTimer = value; },
    get chatViewportSettlementContext() { return chatViewportSettlementContext; },
    set chatViewportSettlementContext(value) { chatViewportSettlementContext = value; },
    get chatViewportFollowRaf() { return chatViewportFollowRaf; },
    set chatViewportFollowRaf(value) { chatViewportFollowRaf = value; },
    get chatViewportFollowToken() { return chatViewportFollowToken; },
    set chatViewportFollowToken(value) { chatViewportFollowToken = value; },
    get chatViewportFollowTransition() { return chatViewportFollowTransition; },
    set chatViewportFollowTransition(value) { chatViewportFollowTransition = value; },
    // 用户折叠偏好三兄弟（P4 T2，chat-renderer 批次的最小 host seam）：chat-renderer
    // 迁 ESM 后经 chatSurface 取用。必须是 getter/setter 而不是传值——app-core 的
    // activateUserCollapseStateForContext() 会整体重新赋值这三个绑定，传值会让渲染侧
    // 抓住旧 Set，与"切换窗口内激活目标上下文"的既有语义分叉。
    get _userExpandedReasoning() { return _userExpandedReasoning; },
    set _userExpandedReasoning(value) { _userExpandedReasoning = value; },
    get _userCollapsedMsgs() { return _userCollapsedMsgs; },
    set _userCollapsedMsgs(value) { _userCollapsedMsgs = value; },
    get _userExpandedMsgs() { return _userExpandedMsgs; },
    set _userExpandedMsgs(value) { _userExpandedMsgs = value; },
  });
}

/**
 * call 活动状态：运行中/刚完成/已提醒的 runtime 容器（const Map/Set，按引用
 * 交出，消费方沿用既有 .set/.delete/.add/.clear 语义与原引用身份）与打断动作
 * 时间戳。_lastChoiceAlertCheckAt 不在此暴露：它已由 createPollCycleHost 转发
 * 给 ESM 轮询，避免同一键出现第二个兼容面。
 * 消费方：runtime-status / persistent-input / sidebar-render / app-main /
 * input-helpers / voice-input / generative-ui-panel / remote-connections /
 * sse-client / auto-title / desktop-notify / todo-plan / app-ui。
 * 注：_agentCallActive / _recentlyFinishedRuntimes / _interruptSuppression 另经
 * createAgentCallStatesHost（sidebar-render）交给 agent-call-states-engine（模块相
 * 唯一实例），同一容器，不构成双存储。
 */
export function createP2BootstrapCallActivityHost() {
  return Object.freeze({
    _agentCallActive,            // 只读引用：Map 变异走既有方法
    _recentlyFinishedRuntimes,   // 只读引用：Set 变异走既有方法
    _seenChoiceAlertIds,         // 只读引用
    _autoTitleTriggered,         // 只读引用
    // B5（P4 T2 收尾批次）：sidebar-render 的 `createAgentCallStatesHost()` 按引用
    // 交出给 call 状态引擎（`interrupting.delete(key)` 清理孤儿键）；与
    // call-interrupt 引擎手里的 `createCallInterruptHost().pending` 是同一容器，
    // 不构成第二份状态。
    _interruptSuppression,       // 只读引用：Map 变异走既有方法
    get _lastInterruptUserActionAt() { return _lastInterruptUserActionAt; },
    set _lastInterruptUserActionAt(value) { _lastInterruptUserActionAt = value; },
  });
}

/**
 * 轮询节奏与模板重载记账（P4 T3 编排域迁移的最小 host seam）。
 *
 * 四个键的物理 owner 仍是本文件顶层声明，本工厂只转发、不另存：
 *   - POLL_INTERVAL_MS / POLL_FAST_INTERVAL_MS（const 数值）：正常 / 忙碌态轮询间隔；
 *   - _lastChoiceAlertCheckAt（let，get/set 成对）：全局 choice 提醒的节流时间戳；
 *   - lastFeatureTemplateReloadAt（let，get/set 成对）：模板映射重载的节流时间戳。
 *
 * 消费方：app-main.js（编排域迁 ESM 后，四个轮询宿主工厂与主循环都从这里取）。
 * `_lastChoiceAlertCheckAt` 原先只经 app-main 的 createPollCycleHost 转发给 ESM
 * 轮询，app-main 迁入模块相后那条转发面随之改变——本工厂成为它唯一的 classic
 * 读写入口，同一份绑定，不构成第二份状态。
 */
export function createP2BootstrapPollHost() {
  return Object.freeze({
    POLL_INTERVAL_MS,
    POLL_FAST_INTERVAL_MS,
    get lastChoiceAlertCheckAt() { return _lastChoiceAlertCheckAt; },
    set lastChoiceAlertCheckAt(value) { _lastChoiceAlertCheckAt = value; },
    get lastFeatureTemplateReloadAt() { return lastFeatureTemplateReloadAt; },
    set lastFeatureTemplateReloadAt(value) { lastFeatureTemplateReloadAt = value; },
  });
}

/**
 * 编程小助手会话列表 UI 状态：排序偏好、检索词、检索防抖句柄、页签回放。
 * 消费方：ph-session-list / ph-project-actions / session-list-render /
 * ph-search-locate / ph-session-move / session-ui / app-ui。
 * savedPhTabState 只读引用：classic 侧按 tabGroup 键就地改写（不整体替换）。
 */
export function createP2BootstrapPhSessionHost() {
  return Object.freeze({
    get phSessionSortMode() { return phSessionSortMode; },
    set phSessionSortMode(value) { phSessionSortMode = value; },
    get phSearchQuery() { return phSearchQuery; },
    set phSearchQuery(value) { phSearchQuery = value; },
    get _phSearchTimer() { return _phSearchTimer; },
    set _phSearchTimer(value) { _phSearchTimer = value; },
    savedPhTabState,
  });
}

/**
 * 右栏 debug 面板状态：日志 / MCP / overview 生命周期选择 / feature 与仓库检索。
 * 消费方：debug-logs / overview-data / debug-mcp / debug-overview /
 * debug-features-hooks / workspace-blocks / debug-summary-upload。
 * logFilters 只读引用：classic 侧按字段就地赋值（updateLogFilter）。
 */
export function createP2BootstrapDebugPanelHost() {
  return Object.freeze({
    get currentLogs() { return currentLogs; },
    set currentLogs(value) { currentLogs = value; },
    get currentLogsSignature() { return currentLogsSignature; },
    set currentLogsSignature(value) { currentLogsSignature = value; },
    get currentLogsTruncation() { return currentLogsTruncation; },
    set currentLogsTruncation(value) { currentLogsTruncation = value; },
    logFilters,
    get currentMcpInfo() { return currentMcpInfo; },
    set currentMcpInfo(value) { currentMcpInfo = value; },
    get selectedOverviewLifecycle() { return selectedOverviewLifecycle; },
    set selectedOverviewLifecycle(value) { selectedOverviewLifecycle = value; },
    get selectedFeatureName() { return selectedFeatureName; },
    set selectedFeatureName(value) { selectedFeatureName = value; },
    get selectedRepositoryPackageId() { return selectedRepositoryPackageId; },
    set selectedRepositoryPackageId(value) { selectedRepositoryPackageId = value; },
    get repoSearchQuery() { return repoSearchQuery; },
    set repoSearchQuery(value) { repoSearchQuery = value; },
    get repoSourceFilter() { return repoSourceFilter; },
    set repoSourceFilter(value) { repoSourceFilter = value; },
  });
}

/**
 * 日志快照写入：日志集与其轮询签名成对更新（签名用于 loadLogs 去重）。
 *
 * 唯一实现，物理 owner 是本文件顶层的 currentLogs / currentLogsSignature。
 * 消费方全是 classic：debug-logs（加载 / 刷新 / 清空）、app-ui
 * （resetRuntimeBackedSurfaceState）。日志面板的 onOpen 入口在首屏 classic 相
 * 就可点（rail-logs），因此该写入口必须在 classic 相同步可用——它不能住在
 * ESM 域（原在 overview-data，模块相才可达，早期点击会 ReferenceError）。
 */
export function setCurrentLogs(logs) {
  const nextLogs = Array.isArray(logs) ? logs : [];
  currentLogs = nextLogs;
  currentLogsSignature = JSON.stringify({
    count: nextLogs.length,
    last: nextLogs.length > 0 ? nextLogs[nextLogs.length - 1].id : null,
  });
}

/**
 * assembly 工作台 UI 状态：控制面板开合、草稿重渲染句柄、启动在飞标志、
 * 侧栏渐显句柄。消费方：assembly-actions / assembly-data / chat-viewport / app-ui。
 */
export function createP2BootstrapAssemblyHost() {
  return Object.freeze({
    get assemblyControlPanelOpen() { return assemblyControlPanelOpen; },
    set assemblyControlPanelOpen(value) { assemblyControlPanelOpen = value; },
    get assemblyDraftRenderTimer() { return assemblyDraftRenderTimer; },
    set assemblyDraftRenderTimer(value) { assemblyDraftRenderTimer = value; },
    get assemblyLaunchInProgress() { return assemblyLaunchInProgress; },
    set assemblyLaunchInProgress(value) { assemblyLaunchInProgress = value; },
    get assemblySideRailRevealTimer() { return assemblySideRailRevealTimer; },
    set assemblySideRailRevealTimer(value) { assemblySideRailRevealTimer = value; },
  });
}

/**
 * 侧栏交互态：重启中的 runtime 集合、待启动 prebuilt 集合（均 const Set，按引用
 * 交出）与菜单期间抑制全量重建标志。消费方：ctx-menu-handlers / ctx-menu-items /
 * app-main；sidebar-render（ESM）经 modules/p2-bootstrap-sidebar.js 的 sidebarUi
 * 取用（渲染签名仍在 sidebar-render 自己的 host 里）。渲染签名（lastAgentListRenderSignature）在 sidebar-render.js
 * 自己的 host 里，见 createP2BootstrapSidebarRenderHost。
 */
export function createP2BootstrapSidebarHost() {
  return Object.freeze({
    restartingRuntimeIds,        // 只读引用：Set 变异走既有方法
    // B6（P4 T2 收尾批次）：待启动的 prebuilt 条目集合。sidebar-render 的
    // `renderAgentItems`（`has()`）与渲染签名（`Array.from()`）需要它的 read-only
    // 引用；写方仍是 app-main 的 workspace 宿主面（markPending / clearPending）。
    pendingPrebuiltAgentIds,     // 只读引用：Set 变异走既有方法
    get suppressSidebarRerender() { return suppressSidebarRerender; },
    set suppressSidebarRerender(value) { suppressSidebarRerender = value; },
  });
}

/**
 * 预制工作空间会话切换引导标志：模板预热代次（template-engine 递增并比较）、
 * 会话切换在飞。消费方：template-engine / workspace-actions / app-main。
 */
export function createP2BootstrapSessionSwitchHost() {
  return Object.freeze({
    get templateWarmupToken() { return templateWarmupToken; },
    set templateWarmupToken(value) { templateWarmupToken = value; },
    get prebuiltSessionSwitchInFlight() { return prebuiltSessionSwitchInFlight; },
    set prebuiltSessionSwitchInFlight(value) { prebuiltSessionSwitchInFlight = value; },
  });
}

/**
 * 上下文菜单待执行目标（6 个顶层 let）：打开菜单时写入、关闭时清空、动作
 * handler 读取后执行。消费方：context-menu / ctx-menu-handlers——这对文件是
 * 该 6 键当前唯一的读写方；菜单用到的 DOM 引用在 dom-refs.js（经 p2-bootstrap-dom
 * 适配模块的 domRefs 取用）。
 * 6 键都可写，因此 get/set 成对转发到原声明。
 */
export function createP2BootstrapContextMenuHost() {
  return Object.freeze({
    get contextMenuAgentId() { return contextMenuAgentId; },
    set contextMenuAgentId(value) { contextMenuAgentId = value; },
    get contextMenuAgentMode() { return contextMenuAgentMode; },
    set contextMenuAgentMode(value) { contextMenuAgentMode = value; },
    get contextMenuCompactAction() { return contextMenuCompactAction; },
    set contextMenuCompactAction(value) { contextMenuCompactAction = value; },
    get contextMenuProjectAgentId() { return contextMenuProjectAgentId; },
    set contextMenuProjectAgentId(value) { contextMenuProjectAgentId = value; },
    get contextMenuProjectId() { return contextMenuProjectId; },
    set contextMenuProjectId(value) { contextMenuProjectId = value; },
    get contextMenuFeatureRepoPackageId() { return contextMenuFeatureRepoPackageId; },
    set contextMenuFeatureRepoPackageId(value) { contextMenuFeatureRepoPackageId = value; },
  });
}

/**
 * app-ui 迁移残留的 classic 状态（P4 T2 末件的最小 host seam；B 表风格）。
 *
 * 三个键的物理 owner 仍是本文件顶层声明，本工厂只转发、不减不增：
 *   - workspaceSurfaceModePreferences（const 对象，按引用交出）：每个工作空间单元
 *     上次停留的 surface 模式；app-ui 读 + 就地改写键值（从不整体替换）。
 *   - workspaceSurfaceScrollCache（const Map，按引用交出）：surface 列表滚动位置
 *     缓存；app-ui 沿用既有 .set / .get 语义。
 *   - _workGroupEventsWired（let，get/set 成对）：工作群事件委托的搭线闸，写一次、
 *     读一次，唯一消费方是 app-ui 的 _ensureWorkGroupEventDelegation。
 * 三者零跨文件消费面（grep public/ 仅 app-ui），因此不在 app-ui 侧另建存储、也不
 * 搬移 owner：app-ui 迁 ESM 后按本工厂取用同一份状态。
 * 收敛条件：工作空间 surface 域状态整体迁入 ESM owner（render-entry-state）时，
 * 这三个键随搬迁注销本工厂。
 */
export function createP2BootstrapAppUiStateHost() {
  return Object.freeze({
    workspaceSurfaceModePreferences,
    workspaceSurfaceScrollCache,
    get _workGroupEventsWired() { return _workGroupEventsWired; },
    set _workGroupEventsWired(value) { _workGroupEventsWired = value; },
  });
}

// ── call-interrupt 同步引擎（唯一实例）─────────────────────────────
// 前台 visibilitychange 在 ESM 模块求值前就会触达 call 状态链路；本引擎必须
// 在 classic 相可用。ESM host（call-interrupt-host.js）只做 late-bound 转发，
// 不初始化、不 claim、不注册第二套桥。工厂/解析 helper 全部在 IIFE 词法内部：
// classic 顶层 function 属性不可配置，同名 KernelState.defineKey 会 TypeError。
(function bootstrapCallInterrupt() {
  function getNotificationCallStartedAt(payload) {
    const value = payload?.runtime?.callStartedAt ?? payload?.callStartedAt;
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
  }

  function createCallInterruptState(pending, now = () => Date.now()) {
    function markInterruptPending(runtimeId, callStartedAt = 0) {
      if (!runtimeId) return;
      const normalized = Number(callStartedAt);
      pending.set(runtimeId, {
        requestedAt: now(),
        callStartedAt: Number.isFinite(normalized) && normalized > 0 ? normalized : 0,
      });
    }

    function isInterruptSuppressed(runtimeId, observedCallStartedAt = 0) {
      if (!runtimeId) return false;
      const interrupted = pending.get(runtimeId);
      if (!interrupted) return false;
      // Only a newer call may release an active observation. Missing identities
      // remain sticky until a terminal event or explicit request failure clears it.
      const interruptedAt = Number(interrupted.callStartedAt);
      const observed = Number(observedCallStartedAt);
      if (Number.isFinite(interruptedAt) && interruptedAt > 0
        && Number.isFinite(observed) && observed > interruptedAt) {
        pending.delete(runtimeId);
        return false;
      }
      return true;
    }

    function clearInterruptSuppression(runtimeId) {
      if (runtimeId) pending.delete(runtimeId);
    }

    return { getNotificationCallStartedAt, markInterruptPending, isInterruptSuppressed, clearInterruptSuppression };
  }

  const host = createCallInterruptHost();
  const policy = createCallInterruptState(host.pending, host.now);
  window.KernelState.defineKey('call-interrupt', 'getNotificationCallStartedAt', policy.getNotificationCallStartedAt);
  window.KernelState.defineKey('call-interrupt', 'markInterruptPending', policy.markInterruptPending);
  window.KernelState.defineKey('call-interrupt', 'isInterruptSuppressed', policy.isInterruptSuppressed);
  window.KernelState.defineKey('call-interrupt', 'clearInterruptSuppression', policy.clearInterruptSuppression);
})();

// ── 对外面：domain `app-core` 的桥键（P4 收尾批）──────────────────────────
// 逐键清单与注销条件见文件头注「对外面」一节。
//
// 两类槽：
//   - 函数键 → `fnSlot`：槽里放模块实现，classic / 夹具整替某个函数时只改槽，
//     因此 window 读到的仍是替换值；本模块**内部**互调仍走模块绑定（与迁移前
//     "改写 window 属性连内部调用一起改"的差异是已接受的边界，见 plan P4 第十批）。
//   - 状态键 → `letSlot` / `constSlot`：绑定槽（let 的读写直连模块声明，不另存）；
//     const 容器按引用交出（数组 / Map / Set 变异照旧），整替只改窗口面。
const fnSlot = (initial) => {
  let value = initial;
  return { get: () => value, set: (next) => { value = next; } };
};
/** let 绑定槽：读写都落在模块声明本身（不另存）。 */
const letSlot = (read, write) => ({ get: read, set: write });
/**
 * const 容器槽：按引用交出模块里的容器；无论桥读还是 claim，模块内部继续持有原容器。
 * 整替只改**窗口面**的值——与迁移前「classic 顶层 const 是词法绑定、同名
 * `window.X = …` 只是另一个普通属性」的分叉语义一致，不新增也不收窄。
 * 实现与 `fnSlot` 同为值槽；名字分开是为了让桥键清单能区分「函数键 / 容器键」，
 * 两者的消费面与注销条件不同。
 */
const constSlot = (initial) => {
  let value = initial;
  return { get: () => value, set: (next) => { value = next; } };
};

/** 本域对外面：函数键（值槽）+ 状态键（绑定槽）。注销条件见文件头注。 */
const bridgeSlots = {
  createCallInterruptHost: fnSlot(createCallInterruptHost),
  getInterruptTargetId: fnSlot(getInterruptTargetId),
  setInterruptTargetId: fnSlot(setInterruptTargetId),
  beginPendingSessionNavigation: fnSlot(beginPendingSessionNavigation),
  updatePendingSessionNavigation: fnSlot(updatePendingSessionNavigation),
  clearPendingSessionNavigation: fnSlot(clearPendingSessionNavigation),
  hasPendingSessionNavigation: fnSlot(hasPendingSessionNavigation),
  bumpNavigationGuard: fnSlot(bumpNavigationGuard),
  activateUserCollapseStateForContext: fnSlot(activateUserCollapseStateForContext),
  resetUserCollapseStateForContext: fnSlot(resetUserCollapseStateForContext),
  createRuntimeViewCacheHost: fnSlot(createRuntimeViewCacheHost),
  getEmptyStateHtml: fnSlot(getEmptyStateHtml),
  getFeaturePanelEmptyHtml: fnSlot(getFeaturePanelEmptyHtml),
  getCurrentUnitUi: fnSlot(getCurrentUnitUi),
  isUiOnlyUnit: fnSlot(isUiOnlyUnit),
  isWorkspaceHostUnit: fnSlot(isWorkspaceHostUnit),
  isTablessHostSurface: fnSlot(isTablessHostSurface),
  isPhStyleWorkspaceAgent: fnSlot(isPhStyleWorkspaceAgent),
  isWorkspaceSurfaceUnit: fnSlot(isWorkspaceSurfaceUnit),
  isUiOnlyAgentId: fnSlot(isUiOnlyAgentId),
  getRuntimeRecord: fnSlot(getRuntimeRecord),
  findAgentByIdentity: fnSlot(findAgentByIdentity),
  resolveWorkspaceFallbackAgentId: fnSlot(resolveWorkspaceFallbackAgentId),
  setCurrentLogs: fnSlot(setCurrentLogs),
  createP2BootstrapChatSurfaceHost: fnSlot(createP2BootstrapChatSurfaceHost),
  createP2BootstrapCallActivityHost: fnSlot(createP2BootstrapCallActivityHost),
  createP2BootstrapPollHost: fnSlot(createP2BootstrapPollHost),
  createP2BootstrapPhSessionHost: fnSlot(createP2BootstrapPhSessionHost),
  createP2BootstrapDebugPanelHost: fnSlot(createP2BootstrapDebugPanelHost),
  createP2BootstrapAssemblyHost: fnSlot(createP2BootstrapAssemblyHost),
  createP2BootstrapSidebarHost: fnSlot(createP2BootstrapSidebarHost),
  createP2BootstrapSessionSwitchHost: fnSlot(createP2BootstrapSessionSwitchHost),
  createP2BootstrapContextMenuHost: fnSlot(createP2BootstrapContextMenuHost),
  createP2BootstrapAppUiStateHost: fnSlot(createP2BootstrapAppUiStateHost),
  _agentCallActive: constSlot(_agentCallActive),
  _interruptSuppression: constSlot(_interruptSuppression),
  _recentlyFinishedRuntimes: constSlot(_recentlyFinishedRuntimes),
  _seenChoiceAlertIds: constSlot(_seenChoiceAlertIds),
  _autoTitleTriggered: constSlot(_autoTitleTriggered),
  loadedAgentDetailIds: constSlot(loadedAgentDetailIds),
  restartingRuntimeIds: constSlot(restartingRuntimeIds),
  followLatestEnabled: letSlot(() => followLatestEnabled, (value) => { followLatestEnabled = value; }),
  suppressFollowScrollEvent: letSlot(() => suppressFollowScrollEvent, (value) => { suppressFollowScrollEvent = value; }),
  suppressSidebarRerender: letSlot(() => suppressSidebarRerender, (value) => { suppressSidebarRerender = value; }),
  lastManualScrollIntentAt: letSlot(() => lastManualScrollIntentAt, (value) => { lastManualScrollIntentAt = value; }),
  showChatProcess: letSlot(() => showChatProcess, (value) => { showChatProcess = value; }),
  chatViewportObserversReady: letSlot(() => chatViewportObserversReady, (value) => { chatViewportObserversReady = value; }),
  chatViewportObserverSuppressDepth: letSlot(() => chatViewportObserverSuppressDepth, (value) => { chatViewportObserverSuppressDepth = value; }),
  chatViewportObserverQuietUntil: letSlot(() => chatViewportObserverQuietUntil, (value) => { chatViewportObserverQuietUntil = value; }),
  chatViewportSettlementToken: letSlot(() => chatViewportSettlementToken, (value) => { chatViewportSettlementToken = value; }),
  chatViewportSettlementTimer: letSlot(() => chatViewportSettlementTimer, (value) => { chatViewportSettlementTimer = value; }),
  chatViewportSettlementContext: letSlot(() => chatViewportSettlementContext, (value) => { chatViewportSettlementContext = value; }),
  chatViewportFollowTransition: letSlot(() => chatViewportFollowTransition, (value) => { chatViewportFollowTransition = value; }),
  prebuiltSessionSwitchInFlight: letSlot(() => prebuiltSessionSwitchInFlight, (value) => { prebuiltSessionSwitchInFlight = value; }),
  templateWarmupToken: letSlot(() => templateWarmupToken, (value) => { templateWarmupToken = value; }),
  phSessionSortMode: letSlot(() => phSessionSortMode, (value) => { phSessionSortMode = value; }),
  phSearchQuery: letSlot(() => phSearchQuery, (value) => { phSearchQuery = value; }),
  _phSearchTimer: letSlot(() => _phSearchTimer, (value) => { _phSearchTimer = value; }),
  savedPhTabState: letSlot(() => savedPhTabState, (value) => { savedPhTabState = value; }),
  contextMenuAgentId: letSlot(() => contextMenuAgentId, (value) => { contextMenuAgentId = value; }),
  contextMenuAgentMode: letSlot(() => contextMenuAgentMode, (value) => { contextMenuAgentMode = value; }),
  contextMenuCompactAction: letSlot(() => contextMenuCompactAction, (value) => { contextMenuCompactAction = value; }),
  contextMenuProjectAgentId: letSlot(() => contextMenuProjectAgentId, (value) => { contextMenuProjectAgentId = value; }),
  contextMenuProjectId: letSlot(() => contextMenuProjectId, (value) => { contextMenuProjectId = value; }),
  contextMenuFeatureRepoPackageId: letSlot(() => contextMenuFeatureRepoPackageId, (value) => { contextMenuFeatureRepoPackageId = value; }),
  assemblyLaunchInProgress: letSlot(() => assemblyLaunchInProgress, (value) => { assemblyLaunchInProgress = value; }),
  assemblyControlPanelOpen: letSlot(() => assemblyControlPanelOpen, (value) => { assemblyControlPanelOpen = value; }),
  currentLogs: letSlot(() => currentLogs, (value) => { currentLogs = value; }),
  currentLogsSignature: letSlot(() => currentLogsSignature, (value) => { currentLogsSignature = value; }),
  _lastInterruptUserActionAt: letSlot(() => _lastInterruptUserActionAt, (value) => { _lastInterruptUserActionAt = value; }),
  logFilters: letSlot(() => logFilters, (value) => { logFilters = value; }),
  selectedFeatureName: letSlot(() => selectedFeatureName, (value) => { selectedFeatureName = value; }),
  _userCollapsedMsgs: letSlot(() => _userCollapsedMsgs, (value) => { _userCollapsedMsgs = value; }),
  _userExpandedMsgs: letSlot(() => _userExpandedMsgs, (value) => { _userExpandedMsgs = value; }),
  _userCollapseStateByContext: constSlot(_userCollapseStateByContext),
  _agentRuntimeCache: constSlot(_agentRuntimeCache),
  qqbotConfigState: letSlot(() => qqbotConfigState, (value) => { qqbotConfigState = value; }),
  qqbotConfigRequest: letSlot(() => qqbotConfigRequest, (value) => { qqbotConfigRequest = value; }),
  imWorkspaceState: letSlot(() => imWorkspaceState, (value) => { imWorkspaceState = value; }),
  imWorkspaceRequest: letSlot(() => imWorkspaceRequest, (value) => { imWorkspaceRequest = value; }),
  imWorkspaceAutoSaveTimer: letSlot(() => imWorkspaceAutoSaveTimer, (value) => { imWorkspaceAutoSaveTimer = value; }),
  pendingPrebuiltAgentIds: constSlot(pendingPrebuiltAgentIds),
  workspaceSurfaceModePreferences: constSlot(workspaceSurfaceModePreferences),
  _lastChoiceAlertCheckAt: letSlot(() => _lastChoiceAlertCheckAt, (value) => { _lastChoiceAlertCheckAt = value; }),
  _workGroupEventsWired: letSlot(() => _workGroupEventsWired, (value) => { _workGroupEventsWired = value; }),
  assemblyDraftRenderTimer: letSlot(() => assemblyDraftRenderTimer, (value) => { assemblyDraftRenderTimer = value; }),
  assemblySideRailRevealTimer: letSlot(() => assemblySideRailRevealTimer, (value) => { assemblySideRailRevealTimer = value; }),
  CHAT_PROCESS_VISIBILITY_KEY: constSlot(CHAT_PROCESS_VISIBILITY_KEY),
  currentLogsTruncation: letSlot(() => currentLogsTruncation, (value) => { currentLogsTruncation = value; }),
  currentMcpInfo: letSlot(() => currentMcpInfo, (value) => { currentMcpInfo = value; }),
  lastFeatureTemplateReloadAt: letSlot(() => lastFeatureTemplateReloadAt, (value) => { lastFeatureTemplateReloadAt = value; }),
  selectedOverviewLifecycle: letSlot(() => selectedOverviewLifecycle, (value) => { selectedOverviewLifecycle = value; }),
  selectedRepositoryPackageId: letSlot(() => selectedRepositoryPackageId, (value) => { selectedRepositoryPackageId = value; }),
  repoSearchQuery: letSlot(() => repoSearchQuery, (value) => { repoSearchQuery = value; }),
  repoSourceFilter: letSlot(() => repoSourceFilter, (value) => { repoSourceFilter = value; }),
  _progScrollCooldownUntil: letSlot(() => _progScrollCooldownUntil, (value) => { _progScrollCooldownUntil = value; }),
  followLatestEntryUntil: letSlot(() => followLatestEntryUntil, (value) => { followLatestEntryUntil = value; }),
  chatViewportMutationObserver: letSlot(() => chatViewportMutationObserver, (value) => { chatViewportMutationObserver = value; }),
  chatViewportResizeObserver: letSlot(() => chatViewportResizeObserver, (value) => { chatViewportResizeObserver = value; }),
  chatViewportSettlementRaf: letSlot(() => chatViewportSettlementRaf, (value) => { chatViewportSettlementRaf = value; }),
  chatViewportFollowRaf: letSlot(() => chatViewportFollowRaf, (value) => { chatViewportFollowRaf = value; }),
  chatViewportFollowToken: letSlot(() => chatViewportFollowToken, (value) => { chatViewportFollowToken = value; }),
  workspaceSurfaceScrollCache: constSlot(workspaceSurfaceScrollCache),
  _userExpandedReasoning: letSlot(() => _userExpandedReasoning, (value) => { _userExpandedReasoning = value; }),
  PH_STYLE_WORKSPACE_AGENT_IDS: constSlot(PH_STYLE_WORKSPACE_AGENT_IDS),
};

/** 只按引用交出、不接受整替的 const 容器键；测试支撑面据此跳过整替回放。 */
export const CONST_BRIDGE_KEYS = new Set(['_agentCallActive', '_interruptSuppression', '_recentlyFinishedRuntimes', '_seenChoiceAlertIds', '_autoTitleTriggered', 'loadedAgentDetailIds', 'restartingRuntimeIds', '_userCollapseStateByContext', '_agentRuntimeCache']);

// 逐键显式注册（不用循环）：桥债门禁按文本统计 `KernelState.defineKey(` 调用数，
// 循环会把整套桥面压缩成一次调用，使债务在门禁刻度里消失。
window.KernelState.defineKey('app-core', 'createCallInterruptHost', bridgeSlots.createCallInterruptHost.get());
window.KernelState.defineKey('app-core', 'getInterruptTargetId', bridgeSlots.getInterruptTargetId.get());
window.KernelState.defineKey('app-core', 'setInterruptTargetId', bridgeSlots.setInterruptTargetId.get());
window.KernelState.defineKey('app-core', 'beginPendingSessionNavigation', bridgeSlots.beginPendingSessionNavigation.get());
window.KernelState.defineKey('app-core', 'updatePendingSessionNavigation', bridgeSlots.updatePendingSessionNavigation.get());
window.KernelState.defineKey('app-core', 'clearPendingSessionNavigation', bridgeSlots.clearPendingSessionNavigation.get());
window.KernelState.defineKey('app-core', 'hasPendingSessionNavigation', bridgeSlots.hasPendingSessionNavigation.get());
window.KernelState.defineKey('app-core', 'bumpNavigationGuard', bridgeSlots.bumpNavigationGuard.get());
window.KernelState.defineKey('app-core', 'activateUserCollapseStateForContext', bridgeSlots.activateUserCollapseStateForContext.get());
window.KernelState.defineKey('app-core', 'resetUserCollapseStateForContext', bridgeSlots.resetUserCollapseStateForContext.get());
window.KernelState.defineKey('app-core', 'createRuntimeViewCacheHost', bridgeSlots.createRuntimeViewCacheHost.get());
window.KernelState.defineKey('app-core', 'getEmptyStateHtml', bridgeSlots.getEmptyStateHtml.get());
window.KernelState.defineKey('app-core', 'getFeaturePanelEmptyHtml', bridgeSlots.getFeaturePanelEmptyHtml.get());
window.KernelState.defineKey('app-core', 'getCurrentUnitUi', bridgeSlots.getCurrentUnitUi.get());
window.KernelState.defineKey('app-core', 'isUiOnlyUnit', bridgeSlots.isUiOnlyUnit.get());
window.KernelState.defineKey('app-core', 'isWorkspaceHostUnit', bridgeSlots.isWorkspaceHostUnit.get());
window.KernelState.defineKey('app-core', 'isTablessHostSurface', bridgeSlots.isTablessHostSurface.get());
window.KernelState.defineKey('app-core', 'isPhStyleWorkspaceAgent', bridgeSlots.isPhStyleWorkspaceAgent.get());
window.KernelState.defineKey('app-core', 'isWorkspaceSurfaceUnit', bridgeSlots.isWorkspaceSurfaceUnit.get());
window.KernelState.defineKey('app-core', 'isUiOnlyAgentId', bridgeSlots.isUiOnlyAgentId.get());
window.KernelState.defineKey('app-core', 'getRuntimeRecord', bridgeSlots.getRuntimeRecord.get());
window.KernelState.defineKey('app-core', 'findAgentByIdentity', bridgeSlots.findAgentByIdentity.get());
window.KernelState.defineKey('app-core', 'resolveWorkspaceFallbackAgentId', bridgeSlots.resolveWorkspaceFallbackAgentId.get());
window.KernelState.defineKey('app-core', 'setCurrentLogs', bridgeSlots.setCurrentLogs.get());
window.KernelState.defineKey('app-core', 'createP2BootstrapChatSurfaceHost', bridgeSlots.createP2BootstrapChatSurfaceHost.get());
window.KernelState.defineKey('app-core', 'createP2BootstrapCallActivityHost', bridgeSlots.createP2BootstrapCallActivityHost.get());
window.KernelState.defineKey('app-core', 'createP2BootstrapPollHost', bridgeSlots.createP2BootstrapPollHost.get());
window.KernelState.defineKey('app-core', 'createP2BootstrapPhSessionHost', bridgeSlots.createP2BootstrapPhSessionHost.get());
window.KernelState.defineKey('app-core', 'createP2BootstrapDebugPanelHost', bridgeSlots.createP2BootstrapDebugPanelHost.get());
window.KernelState.defineKey('app-core', 'createP2BootstrapAssemblyHost', bridgeSlots.createP2BootstrapAssemblyHost.get());
window.KernelState.defineKey('app-core', 'createP2BootstrapSidebarHost', bridgeSlots.createP2BootstrapSidebarHost.get());
window.KernelState.defineKey('app-core', 'createP2BootstrapSessionSwitchHost', bridgeSlots.createP2BootstrapSessionSwitchHost.get());
window.KernelState.defineKey('app-core', 'createP2BootstrapContextMenuHost', bridgeSlots.createP2BootstrapContextMenuHost.get());
window.KernelState.defineKey('app-core', 'createP2BootstrapAppUiStateHost', bridgeSlots.createP2BootstrapAppUiStateHost.get());
window.KernelState.defineKey('app-core', '_agentCallActive', bridgeSlots._agentCallActive.get());
window.KernelState.defineKey('app-core', '_interruptSuppression', bridgeSlots._interruptSuppression.get());
window.KernelState.defineKey('app-core', '_recentlyFinishedRuntimes', bridgeSlots._recentlyFinishedRuntimes.get());
window.KernelState.defineKey('app-core', '_seenChoiceAlertIds', bridgeSlots._seenChoiceAlertIds.get());
window.KernelState.defineKey('app-core', '_autoTitleTriggered', bridgeSlots._autoTitleTriggered.get());
window.KernelState.defineKey('app-core', 'loadedAgentDetailIds', bridgeSlots.loadedAgentDetailIds.get());
window.KernelState.defineKey('app-core', 'restartingRuntimeIds', bridgeSlots.restartingRuntimeIds.get());
window.KernelState.defineKey('app-core', 'followLatestEnabled', bridgeSlots.followLatestEnabled.get());
window.KernelState.defineKey('app-core', 'suppressFollowScrollEvent', bridgeSlots.suppressFollowScrollEvent.get());
window.KernelState.defineKey('app-core', 'suppressSidebarRerender', bridgeSlots.suppressSidebarRerender.get());
window.KernelState.defineKey('app-core', 'lastManualScrollIntentAt', bridgeSlots.lastManualScrollIntentAt.get());
window.KernelState.defineKey('app-core', 'showChatProcess', bridgeSlots.showChatProcess.get());
window.KernelState.defineKey('app-core', 'chatViewportObserversReady', bridgeSlots.chatViewportObserversReady.get());
window.KernelState.defineKey('app-core', 'chatViewportObserverSuppressDepth', bridgeSlots.chatViewportObserverSuppressDepth.get());
window.KernelState.defineKey('app-core', 'chatViewportObserverQuietUntil', bridgeSlots.chatViewportObserverQuietUntil.get());
window.KernelState.defineKey('app-core', 'chatViewportSettlementToken', bridgeSlots.chatViewportSettlementToken.get());
window.KernelState.defineKey('app-core', 'chatViewportSettlementTimer', bridgeSlots.chatViewportSettlementTimer.get());
window.KernelState.defineKey('app-core', 'chatViewportSettlementContext', bridgeSlots.chatViewportSettlementContext.get());
window.KernelState.defineKey('app-core', 'chatViewportFollowTransition', bridgeSlots.chatViewportFollowTransition.get());
window.KernelState.defineKey('app-core', 'prebuiltSessionSwitchInFlight', bridgeSlots.prebuiltSessionSwitchInFlight.get());
window.KernelState.defineKey('app-core', 'templateWarmupToken', bridgeSlots.templateWarmupToken.get());
window.KernelState.defineKey('app-core', 'phSessionSortMode', bridgeSlots.phSessionSortMode.get());
window.KernelState.defineKey('app-core', 'phSearchQuery', bridgeSlots.phSearchQuery.get());
window.KernelState.defineKey('app-core', '_phSearchTimer', bridgeSlots._phSearchTimer.get());
window.KernelState.defineKey('app-core', 'savedPhTabState', bridgeSlots.savedPhTabState.get());
window.KernelState.defineKey('app-core', 'contextMenuAgentId', bridgeSlots.contextMenuAgentId.get());
window.KernelState.defineKey('app-core', 'contextMenuAgentMode', bridgeSlots.contextMenuAgentMode.get());
window.KernelState.defineKey('app-core', 'contextMenuCompactAction', bridgeSlots.contextMenuCompactAction.get());
window.KernelState.defineKey('app-core', 'contextMenuProjectAgentId', bridgeSlots.contextMenuProjectAgentId.get());
window.KernelState.defineKey('app-core', 'contextMenuProjectId', bridgeSlots.contextMenuProjectId.get());
window.KernelState.defineKey('app-core', 'contextMenuFeatureRepoPackageId', bridgeSlots.contextMenuFeatureRepoPackageId.get());
window.KernelState.defineKey('app-core', 'assemblyLaunchInProgress', bridgeSlots.assemblyLaunchInProgress.get());
window.KernelState.defineKey('app-core', 'assemblyControlPanelOpen', bridgeSlots.assemblyControlPanelOpen.get());
window.KernelState.defineKey('app-core', 'currentLogs', bridgeSlots.currentLogs.get());
window.KernelState.defineKey('app-core', 'currentLogsSignature', bridgeSlots.currentLogsSignature.get());
window.KernelState.defineKey('app-core', '_lastInterruptUserActionAt', bridgeSlots._lastInterruptUserActionAt.get());
window.KernelState.defineKey('app-core', 'logFilters', bridgeSlots.logFilters.get());
window.KernelState.defineKey('app-core', 'selectedFeatureName', bridgeSlots.selectedFeatureName.get());
window.KernelState.defineKey('app-core', '_userCollapsedMsgs', bridgeSlots._userCollapsedMsgs.get());
window.KernelState.defineKey('app-core', '_userExpandedMsgs', bridgeSlots._userExpandedMsgs.get());
window.KernelState.defineKey('app-core', '_userCollapseStateByContext', bridgeSlots._userCollapseStateByContext.get());
window.KernelState.defineKey('app-core', '_agentRuntimeCache', bridgeSlots._agentRuntimeCache.get());
window.KernelState.defineKey('app-core', 'qqbotConfigState', bridgeSlots.qqbotConfigState.get());
window.KernelState.defineKey('app-core', 'qqbotConfigRequest', bridgeSlots.qqbotConfigRequest.get());
window.KernelState.defineKey('app-core', 'imWorkspaceState', bridgeSlots.imWorkspaceState.get());
window.KernelState.defineKey('app-core', 'imWorkspaceRequest', bridgeSlots.imWorkspaceRequest.get());
window.KernelState.defineKey('app-core', 'imWorkspaceAutoSaveTimer', bridgeSlots.imWorkspaceAutoSaveTimer.get());
window.KernelState.defineKey('app-core', 'pendingPrebuiltAgentIds', bridgeSlots.pendingPrebuiltAgentIds.get());
window.KernelState.defineKey('app-core', 'workspaceSurfaceModePreferences', bridgeSlots.workspaceSurfaceModePreferences.get());
window.KernelState.defineKey('app-core', '_lastChoiceAlertCheckAt', bridgeSlots._lastChoiceAlertCheckAt.get());
window.KernelState.defineKey('app-core', '_workGroupEventsWired', bridgeSlots._workGroupEventsWired.get());
window.KernelState.defineKey('app-core', 'assemblyDraftRenderTimer', bridgeSlots.assemblyDraftRenderTimer.get());
window.KernelState.defineKey('app-core', 'assemblySideRailRevealTimer', bridgeSlots.assemblySideRailRevealTimer.get());
window.KernelState.defineKey('app-core', 'CHAT_PROCESS_VISIBILITY_KEY', bridgeSlots.CHAT_PROCESS_VISIBILITY_KEY.get());
window.KernelState.defineKey('app-core', 'currentLogsTruncation', bridgeSlots.currentLogsTruncation.get());
window.KernelState.defineKey('app-core', 'currentMcpInfo', bridgeSlots.currentMcpInfo.get());
window.KernelState.defineKey('app-core', 'lastFeatureTemplateReloadAt', bridgeSlots.lastFeatureTemplateReloadAt.get());
window.KernelState.defineKey('app-core', 'selectedOverviewLifecycle', bridgeSlots.selectedOverviewLifecycle.get());
window.KernelState.defineKey('app-core', 'selectedRepositoryPackageId', bridgeSlots.selectedRepositoryPackageId.get());
window.KernelState.defineKey('app-core', 'repoSearchQuery', bridgeSlots.repoSearchQuery.get());
window.KernelState.defineKey('app-core', 'repoSourceFilter', bridgeSlots.repoSourceFilter.get());
window.KernelState.defineKey('app-core', '_progScrollCooldownUntil', bridgeSlots._progScrollCooldownUntil.get());
window.KernelState.defineKey('app-core', 'followLatestEntryUntil', bridgeSlots.followLatestEntryUntil.get());
window.KernelState.defineKey('app-core', 'chatViewportMutationObserver', bridgeSlots.chatViewportMutationObserver.get());
window.KernelState.defineKey('app-core', 'chatViewportResizeObserver', bridgeSlots.chatViewportResizeObserver.get());
window.KernelState.defineKey('app-core', 'chatViewportSettlementRaf', bridgeSlots.chatViewportSettlementRaf.get());
window.KernelState.defineKey('app-core', 'chatViewportFollowRaf', bridgeSlots.chatViewportFollowRaf.get());
window.KernelState.defineKey('app-core', 'chatViewportFollowToken', bridgeSlots.chatViewportFollowToken.get());
window.KernelState.defineKey('app-core', 'workspaceSurfaceScrollCache', bridgeSlots.workspaceSurfaceScrollCache.get());
window.KernelState.defineKey('app-core', '_userExpandedReasoning', bridgeSlots._userExpandedReasoning.get());
window.KernelState.defineKey('app-core', 'PH_STYLE_WORKSPACE_AGENT_IDS', bridgeSlots.PH_STYLE_WORKSPACE_AGENT_IDS.get());
window.KernelState.claim('app-core', {
  get: (key) => bridgeSlots[key].get(),
  set: (key, value) => bridgeSlots[key].set(value),
});
