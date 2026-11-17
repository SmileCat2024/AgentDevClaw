/**
 * R2-03 remote workspace create — capability-gated new-chat + forwarded flow.
 *
 * Covers (真实前端沙箱：classic 源 loadSource + 已迁模块真实 import，无真实网络):
 *   1. remoteOnly project view: new-chat buttons render only when the host
 *      grants 'workspaceCreate'; the create_session action carries the
 *      host-level namespace agentId (ADR-0012 identity discipline)
 *   2. capability denied → buttons stay hidden
 *   3. local project view regression: buttons render unchanged (no agentId)
 *   4. create_session flow: forwarded POST with host namespace agentId +
 *      operationId (beginSidebarOperation) + idempotency key; bare response
 *      ids namespaced via namespaceMutationResult; runtime located via
 *      waitForRuntimeForSession then requestSwitch; explicit failure with no
 *      silent retry and no switch
 *
 * capabilityFor is an integration-time contract (parallel workstream); tests
 * stub it with the agreed signature:
 *   window.RemoteConnections.capabilityFor(agentId, action) → boolean
 * Omitting the stub exercises the integration-window fallback.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withP2EsmCase } from './helpers/p2-esm-case.js';

const CATALOG = {
  connections: [{
    connectionId: 'server-a',
    name: 'Lab-B',
    status: 'connected',
    workspaces: [{
      groupKey: 'remote:server-a:programming-helper:%2Fsrv%2Fproject-c',
      displayName: 'Lab-B：project-c',
      projectName: 'Lab-B：project-c',
      projectDir: '/srv/project-c',
      entries: [{
        id: 'remote:server-a:runtime-main',
        runtimeId: 'remote:server-a:runtime-main',
        agentId: 'remote:server-a:programming-helper',
        sidebarEntryId: 'programming-helper',
        sessionType: 'main',
        sessionId: 'remote:server-a:session-running',
        name: '运行中',
        kind: 'runtime',
      }],
    }],
  }],
};

// Remote list payload as the forwarded endpoint returns it (bare ids); the
// history layer namespaces them client-side and project-data merges them into
// a remoteOnly bucket for /srv/project-c. Archived: the tab-area new-chat
// button renders in the empty-state note (active sessions replace it).
const REMOTE_HISTORY = {
  revision: 3,
  activeSessionId: 'session-running',
  sessions: [
    { id: 'session-hist-1', title: '远程历史 A', updatedAt: '2026-08-30T09:00:00.000Z', openDirectory: '/srv/project-c', messageCount: 4, archived: true },
  ],
};

// Remote create response as the forwarded endpoint returns it (bare ids).
const REMOTE_CREATE_RESULT = {
  protocolVersion: 2,
  revision: 7,
  session: { id: 'session-new', title: '远程新会话', openDirectory: '/srv/project-c' },
  targetSessionId: 'session-new',
  sessionDelta: { revision: 7, activeSessionId: 'session-new', upsert: [{ id: 'session-new' }], remove: [] },
};

const PH_AGENT = {
  id: 'programming-helper',
  source: 'prebuilt',
  modelPresets: { default: { primary: 'gpt-x' } },
  workspace_state: { openDirectory: 'D:/local-proj', forms: {}, phProjects: [] },
  workspace_sessions: {
    activeSessionId: 'session-local',
    sessions: [
      { id: 'session-local', title: '本地会话', openDirectory: 'D:/local-proj', updatedAt: '2026-08-30T12:00:00.000Z' },
    ],
  },
};

function unescapeAttr(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractWorkspaceActions(html) {
  const actions = [];
  const re = /data-workspace-action="([^"]*)"/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    actions.push(JSON.parse(unescapeAttr(match[1])));
  }
  return actions;
}

// 装载路线（ESM 迁移配方第三节）：渲染链里已迁 ESM 的四段
// （project-data / model-preset-cache / session-list-render / workspace-agents）
// 一律真实 `import`（withP2EsmCase 的 c.load，每个用例整图隔离）；同一 realm
// 内仍可做「渲染按钮 → runWorkspaceAction」的端到端断言，因为 ESM 侧对 classic
// 宿主的取用全部经 window.*（沙箱即 window），classic 侧对已迁实现的取用经
// kernel-state 桥键在调用时点解析。
// 仍是 classic 的三段继续 loadSource：action-dispatcher / remote-connections /
// workspace-actions。capabilityFor 为集成期契约，按工单签名 stub（缺省不注入）。
const REMOTE_CONNECTIONS = 'public/src/modules/remote-connections.js';
const PROJECT_DATA = 'public/src/modules/project-data.js';
const ACTION_DISPATCHER = 'public/src/modules/action-dispatcher.js';
const WORKSPACE_ACTIONS = 'public/src/modules/workspace-actions.js';
const MODEL_PRESET_CACHE = 'public/src/modules/model-preset-cache.js';
const SESSION_LIST_RENDER = 'public/src/modules/session-list-render.js';
const WORKSPACE_AGENTS = 'public/src/modules/workspace-agents.js';

/**
 * 成功路径会经真实 toast-notify（session-ui → toast-notify）弹「远程会话已创建」。
 * 它的 buildToastElement 用 createElement 造节点、再 querySelector 取子节点挂
 * 监听：默认元素桩的 querySelector 返回 null，会在无关的提示渲染上抛错。
 * 这里给 createElement 产出的节点补一个非空 querySelector（仍是纯桩，不含任何
 * 业务语义），让真实提示代码能在桩 DOM 上跑通。
 */
function createDomElement() {
  const element = {
    style: {}, dataset: {}, classList: {
      add() {}, remove() {}, toggle() {}, contains() { return false; },
    },
    children: [], innerHTML: '', textContent: '', title: '', className: '', type: '',
    scrollTop: 0, scrollHeight: 0, offsetHeight: 0, clientHeight: 0, isConnected: true,
    appendChild(child) { this.children.push(child); return child; },
    insertBefore(child) { this.children.push(child); return child; },
    removeChild() {}, remove() {},
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    querySelector() { return createDomElement(); },
    querySelectorAll() { return []; },
    focus() {}, blur() {},
  };
  return element;
}

/**
 * 已迁 ESM 的宿主适配链在求值时向 window 取 bootstrap 状态宿主。按各宿主契约
 * 给最小可读写面（真实实现留在 app-core / app-main / sidebar-render）。
 * ph-session 宿主用成对 get/set 复刻 app-core 的 Object.freeze 槽位语义。
 */
function createBootstrapHosts(sandbox) {
  const phSessionState = { phSessionSortMode: 'updatedAt', phSearchQuery: '', _phSearchTimer: null };
  return {
    // 调用活跃态与预构建会话切换的 classic 槽位（真实实现是 app-core 的
    // Object.freeze 宿主：Map/Set 只读引用 + 成对 get/set；此处按契约给最小面）。
    createP2BootstrapCallActivityHost: () => ({
      _agentCallActive: new Map(),
      _recentlyFinishedRuntimes: new Set(),
      _seenChoiceAlertIds: new Set(),
      _autoTitleTriggered: new Set(),
      _lastInterruptUserActionAt: 0,
    }),
    createP2BootstrapSessionSwitchHost: () => ({
      templateWarmupToken: null,
      prebuiltSessionSwitchInFlight: false,
    }),
    createP2BootstrapPhSessionHost: () => ({
      get phSessionSortMode() { return phSessionState.phSessionSortMode; },
      set phSessionSortMode(value) { phSessionState.phSessionSortMode = value; },
      get phSearchQuery() { return phSessionState.phSearchQuery; },
      set phSearchQuery(value) { phSessionState.phSearchQuery = value; },
      get _phSearchTimer() { return phSessionState._phSearchTimer; },
      set _phSearchTimer(value) { phSessionState._phSearchTimer = value; },
      savedPhTabState: {},
    }),
    createP2BootstrapAssemblyHost: () => ({
      assemblyControlPanelOpen: false, assemblyDraftRenderTimer: null,
      assemblyLaunchInProgress: false, assemblySideRailRevealTimer: null,
    }),
    createP2BootstrapDebugPanelHost: () => ({
      currentLogs: [], currentLogsSignature: '', currentLogsTruncation: null, logFilters: {},
      currentMcpInfo: null, selectedOverviewLifecycle: 'StepFinish', selectedFeatureName: null,
      selectedRepositoryPackageId: null, repoSearchQuery: '', repoSourceFilter: 'all',
    }),
    createP2BootstrapDomHost: () => ({
      projectDocsetToggle: null, projectDocsetOverlay: null, projectDocsetSheet: null,
    }),
    // 上下文菜单待执行目标（生产由 app-core 的冻结宿主提供同样的读写转发面）
    createP2BootstrapContextMenuHost: () => {
      const target = { agentId: null, agentMode: null, compactAction: null, projectAgentId: null, projectId: null, featureRepoPackageId: null };
      return {
        get contextMenuAgentId() { return target.agentId; },
        set contextMenuAgentId(value) { target.agentId = value; },
        get contextMenuAgentMode() { return target.agentMode; },
        set contextMenuAgentMode(value) { target.agentMode = value; },
        get contextMenuCompactAction() { return target.compactAction; },
        set contextMenuCompactAction(value) { target.compactAction = value; },
        get contextMenuProjectAgentId() { return target.projectAgentId; },
        set contextMenuProjectAgentId(value) { target.projectAgentId = value; },
        get contextMenuProjectId() { return target.projectId; },
        set contextMenuProjectId(value) { target.projectId = value; },
        get contextMenuFeatureRepoPackageId() { return target.featureRepoPackageId; },
        set contextMenuFeatureRepoPackageId(value) { target.featureRepoPackageId = value; },
      };
    },
    createP2BootstrapSidebarHost: () => ({ restartingRuntimeIds: new Set(), suppressSidebarRerender: false }),
    createP2BootstrapSidebarRenderHost: () => ({ lastAgentListRenderSignature: '' }),
    AgentLoaderHost: { loadedAgentDetailIds: new Set() },
    createCallInterruptHost: () => ({ pending: new Map(), now: () => 0 }),
    createSessionViewCommitHost: () => ({
      identity: () => null, read: () => ({}), apply() {}, normalizeModel: (value) => value || {},
    }),
    createRuntimeViewCacheHost: () => ({
      cache: new Map(), capacity: 20, contextKey: () => '', readView: () => ({}), signatures: () => ({}),
      todoSignature: (plan) => JSON.stringify(plan || {}), emptyTodo: () => ({}), followLatest: () => false,
      captureAnchor: () => null, scrollTop: () => 0, activeCollapseContext: () => '',
      forgetContext() {}, activateCollapse() {}, normalizeIdentity: (identity) => identity, patch() {},
      setRestoredScrollTop() {}, restoreAnchor() {}, updatePlanBadge() {},
    }),
    createAgentCallStatesHost: () => ({
      calling: new Map(), suspended: new Set(), interrupting: new Map(), finished: new Set(),
      agents: () => [], currentRuntimeId: () => null, runtimeId: () => '', remoteEntries: () => [],
      normalize: (value) => value, resolveCalling: () => false, isSuspended: () => false,
      markStarted() {}, syncActionButton() {}, isSseActive: () => false, isRemote: () => false,
      fetch: (...args) => globalThis.fetch(...args), now: () => 0, lastRefresh: () => 0,
      setLastRefresh() {}, render() {},
    }),
    createSessionDataLoaderHost: () => ({ now: () => 0, warn() {} }),
    createRuntimeStatusLoaderHost: () => ({ now: () => 0, warn() {} }),
    createAgentSnapshotLoaderHost: () => ({
      state: {}, detailIds: new Set(), now: () => 0, captureToken: () => null, isTokenCurrent: () => true,
      ownership: () => ({}), connected: async () => [],
      viewer: async () => ({ ok: false, json: async () => ({ agents: [] }) }),
      loadLayout: async () => {}, loadProjects: async () => {}, schedule: () => {}, diagnostic() {},
      runtimeId: (agent) => agent?.id || '', agentRuntimeId: (agent) => agent?.id || '',
      logicalId: (agent) => agent?.id || '', mergeSessions: (previous) => previous,
      reconcileStops() {}, pruneCallStates() {}, renderList() {}, renderPanel() {}, refreshCalls() {},
      isRemote: () => false, fallback: () => null, loadDetail: async () => {}, selectSurface() {},
      preferHome() {}, resolveFocus: () => null, clickPrebuilt() {}, loadData: async () => {},
      warn() {}, error() {}, log() {},
    }),
    createRuntimeSwitchHost: () => ({
      state: {}, now: () => 0, warn() {}, setSurface() {}, renderPanel() {}, renderList() {},
      renderCurrentMainView() {}, beginLoading() {}, clearLoading() {}, navigate() {},
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (timerId) => clearTimeout(timerId),
      // 真实 requestSwitch 的落地动作是切到目标 runtime（生产 = classic switchAgent）。
      switchAgent: (runtimeId) => {
        sandbox.__calls.push({ fn: 'requestSwitch', args: [String(runtimeId)] });
        return Promise.resolve();
      },
    }),
    createWorkspaceSurfaceHost: () => ({
      state: {}, now: () => 0, warn() {}, renderPanel() {}, renderList() {}, renderCurrentMainView() {},
      saveScroll() {}, applyPatch() {}, setFollowLatest() {}, resetSurface() {},
      beginNavigation() {}, clearNavigation() {}, beginLoading() {}, clearLoading() {},
    }),
    // session-list-render 的 ESM 依赖链经 ctx-menu-items 触达 trim-page →
    // compact-resume-host；该 host 在生产由 app-main 提供，此处按同形转发到
    // 沙箱里的桥键实现（不改变被测路径的行为）。
    createWorkspaceEntryHost: () => ({}),
    createPollCoordinatorHost: () => ({
      run: () => {}, fastInterval: () => 0,
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (timerId) => clearTimeout(timerId),
    }),
    createCompactResumeHost: () => ({
      isRemote: (id) => typeof sandbox.isRemoteNamespaceAgentId === 'function' && sandbox.isRemoteNamespaceAgentId(id),
      remote: () => sandbox.RemoteConnections,
      createOperationId: (reason) => sandbox.createSidebarOperationId(reason),
      now: () => sandbox.sidebarDiagnosticNow(),
      observe: (id) => sandbox.beginSidebarOperationMainThreadObservation(id),
      checkpoint: (...args) => sandbox.recordSidebarOperationCheckpoint(...args),
      fetch: (...args) => sandbox.fetch(...args),
      idempotencyKey: () => sandbox.newIdempotencyKey(),
      refreshThreads: () => {},
    }),
  };
}

/**
 * 侧栏操作观察面（迁移后口径）：workspace-actions 直接 import 侧栏操作登记表，
 * 包一层 window 访问器已经拦不到调用。改为在**真实登记表**的公开读面上取值
 * （listSidebarOperations / getSidebarOperation）：
 *   - 请求发出时快照 → 在飞操作仍在登记表里，agentId / kind / projectDir / phase
 *     与迁移前 spy 记录的 begin 字段同源；
 *   - 就绪等待点快照 → 目标会话已提交、runtime 未就绪，phase 应为 target-starting
 *     且带命名空间化 targetSessionId 与服务端 revision；
 *   - 运行结束后登记表里不得残留该操作（settled / failed 都收口，无滞留占位）。
 */
const SIDEBAR_OPERATIONS = 'public/src/modules/sidebar-operations.js';
const OPERATION_FIELDS = ['operationId', 'agentId', 'kind', 'type', 'phase', 'projectDir', 'title', 'targetSessionId', 'serverRevision'];

function snapshotOperations(operations) {
  return operations.listSidebarOperations().map((op) => {
    const picked = {};
    for (const key of OPERATION_FIELDS) picked[key] = op[key];
    return picked;
  });
}

async function createSandbox({
  requests = [],
  capabilityCalls = [],
  capabilityFor = null,
  createOk = true,
  createStatus = 200,
  createBody = REMOTE_CREATE_RESULT,
} = {}, fn) {
  const hooks = { onCreateRequest: null };
  const fetchStub = async (url, init) => {
    requests.push({ url: String(url), init });
    const path = String(url).split('?')[0];
    if (path === '/protoclaw/prebuilt_sessions' && init?.method === 'POST'
      && typeof hooks.onCreateRequest === 'function') {
      hooks.onCreateRequest();
    }
    if (path === '/protoclaw/remote_catalog') {
      return { ok: true, status: 200, json: async () => CATALOG };
    }
    if (path === '/protoclaw/prebuilt_sessions' && init?.method === 'POST') {
      return {
        ok: createOk,
        status: createStatus,
        json: async () => (createOk ? createBody : { error: 'workspace_create_denied' }),
        text: async () => (createOk ? '' : 'workspace_create_denied'),
      };
    }
    if (path === '/protoclaw/prebuilt_sessions') {
      return { ok: true, status: 200, json: async () => REMOTE_HISTORY };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  return withP2EsmCase({
    classic: (sandbox) => {
      // 内核桥键的 classic 侧（生产由 app-core 的 defineKey 注册初值、ESM 装载时
      // claim 吸收）：列表与焦点是 workspace-agents 读取的状态 owner；切换代次与
      // 在飞目标（pendingSwitchSerial 等）是 runtime-switch 的真实状态槽位，
      // 缺初值会让 ++serial 变成 NaN、切换被判 superseded。
      sandbox.KernelState.defineKey('agent-store', 'allAgents', []);
      sandbox.KernelState.defineKey('agent-store', 'focusedAgentId', null);
      sandbox.KernelState.defineKey('agent-store', 'readOnlyMode', false);
      sandbox.KernelState.defineKey('orchestration', 'currentRuntimeAgentId', null);
      sandbox.KernelState.defineKey('orchestration', 'pendingSwitchTarget', null);
      sandbox.KernelState.defineKey('orchestration', 'pendingSwitchSerial', 0);
      sandbox.KernelState.defineKey('orchestration', '_switchEpoch', 0);
      sandbox.KernelState.defineKey('orchestration', '_navigationGuardEpoch', 0);
      sandbox.KernelState.defineKey('orchestration', '_restoredScrollTop', null);
      sandbox.KernelState.defineKey('render-entry', 'lastRenderedWorkspaceHtml', '');
      // 语言初值与生产同源（app-core 在 classic 相 defineKey，ESM i18n owner
      // 认领时吸收）：本文件断言中文动作文案。
      sandbox.KernelState.defineKey('i18n-environment', 'currentLanguage', 'zh');
      sandbox.fetch = fetchStub;
      sandbox.document = {
        ...sandbox.document,
        createElement: () => createDomElement(),
        createElementNS: (_namespace, _tag) => createDomElement(),
        createTextNode: (text) => ({ textContent: String(text) }),
      };
      sandbox.t = (key) => key;
      sandbox.isRemoteNamespaceAgentId = (value) => String(value || '').startsWith('remote:');
      sandbox.renderAgentList = () => {};
      Object.assign(sandbox, createBootstrapHosts(sandbox));
      sandbox.loadSource(ACTION_DISPATCHER);
      sandbox.loadSource(REMOTE_CONNECTIONS);
  // workspace-actions 的 import 链现在含线程交互域（thread-store-domain），
  // 它在模块求值期取 classic 引擎的窄宿主 createThreadStoreHost()。装真实引擎
  // 而不是写同形桩：宿主契约（状态引用 + 内部操作）只有一份实现。
  sandbox.loadSource('public/src/modules/thread-store.js');

      if (capabilityFor) {
        sandbox.window.RemoteConnections.capabilityFor = capabilityFor;
      }
      // project-data 已迁 ESM（真实 import 见用例体）：它自己的桥键
      // （getAgentWorkspaceState / getPathLeaf / hasWorkspaceSessions /
      // getFeatureCreatorProjects / getAgentCreatorProjects / updateAgentRecord /
      // applyManagedPrebuiltAgent）与 session-ui 的 getWorkspaceSessions 都由
      // 真实 owner 提供，这里不再放替身；只有仍是 classic 的宿主函数需要注入。
      sandbox.run(`
        function isPhStyleWorkspaceAgent(agent) {
          return !!(agent && agent.source === 'prebuilt' && agent.id === 'programming-helper');
        }
        // session-list-render 经 window 晚绑定取用的渲染依赖
        var localizeWorkspaceValue = function (value, fallback) {
          if (value && typeof value === 'object') {
            return String((currentLanguage === 'zh' ? value.zh : value.en) || fallback || '');
          }
          return (typeof value === 'string' && value) ? value : String(fallback || '');
        };
      `);
      // workspace-actions.js 已迁 ESM（P2 本批）：真实 import 见用例体。仍 classic
      // 的宿主函数（app-main / app-ui / app-core 的首屏与编排实现）按调用时点
      // 晚绑定，这里按宿主缝注入最小面；侧栏操作登记表 / 切换入口 / 加载入口
      // 已是 ESM owner，由真实模块提供，不再放替身。
      sandbox.run(`
        var bumpNavigationGuard = function () {};
        // 当前 agent 记录（owner: classic app-main 的编排状态投影）：ESM 侧
        // project-data / session-list-render 的默认参数会读它；沙箱里按被测
        // 世界返回已在用例体里声明的 __phAgent。
        window.getCurrentAgentRecord = function () { return null; };
        var saveCurrentWorkspaceSurfaceScroll = function () {};
        var markSessionLoading = function () {};
        var clearSessionLoading = function () {};
        var markActionLoading = function () {};
        var beginFollowLatestCooldown = function () {};
        var beginFollowLatestEntryWindow = function () {};
        var normalizeAgentIdentity = function (v) { return v || ''; };
        var getRuntimeContextKey = function () { return ''; };
        var _storeVisibleSessionInputDraft = function () {};
        var applyOptimisticWorkspaceSession = function () {};
        var upsertConnectedAgent = function () {};
        var setPreferredUnitMode = function () {};
        var renderCurrentMainView = function () {};
        window.alert = function (msg) { window.__calls.push({ fn: 'alert', args: [String(msg)] }); };
        window.__calls = [];
      `);
    },
  }, async (c) => {
    // 生产顺序：owner 模块先于使用方装载（classic workspace-actions 与
    // session-list-render 在调用时点经桥键 / window 读到 project-data 的实现）。
    await c.load(PROJECT_DATA);
    await c.load(MODEL_PRESET_CACHE);
    const sessionList = await c.load(SESSION_LIST_RENDER);
    const phSessionList = await c.load('public/src/modules/ph-session-list.js');
    await c.load(WORKSPACE_AGENTS);
    const operations = await c.load(SIDEBAR_OPERATIONS);
    await c.load(WORKSPACE_ACTIONS);
    // 沙箱侧读取真实登记表（fetch 桩 / 就绪等待桩在动作流内部取快照）。
    c.expose('__sidebarOpsSnapshot', () => snapshotOperations(operations));
    c.window.run(`var __phAgent = ${JSON.stringify(PH_AGENT)};`);
    const run = (code) => c.window.run(code);
    // 拉起目录 + 远程历史（remoteOnly 桶由 project-data 合并产生），渲染 workspace surface。
    const renderSurface = async ({ viewProjectId = null } = {}) => {
      await c.window.RemoteConnections.refresh();
      await run('window.RemoteConnections.maybeRefreshRemoteHistory()');
      await new Promise((resolve) => setTimeout(resolve, 0));
      // 视图项目身份的唯一 owner 是 ph-session-list（命名导出，渲染侧直接 import
      // 消费；不再经 window.ClawFW 副本）。
      phSessionList.setPhSurfaceViewProjectId(viewProjectId);
      return sessionList.renderWorkspaceSessionList(run('__phAgent'), {});
    };
    const callsOf = (fn) => JSON.parse(
      run(`JSON.stringify(window.__calls.filter((c) => c.fn === ${JSON.stringify(fn)}))`),
    );
    return fn({ window: c.window, run, renderSurface, callsOf, hooks, operations });
  });
}

// ── render gating ────────────────────────────────────────────

describe('remoteOnly new-chat render gating (R2-03)', () => {
  it('renders new-chat for a remoteOnly project granted workspaceCreate; action carries the host namespace agentId', async () => {
    const requests = [];
    const capabilityCalls = [];
    await createSandbox({
      requests,
      capabilityCalls,
      capabilityFor: (identity, action) => {
        capabilityCalls.push({ identity: String(identity), action: String(action) });
        if (String(identity).startsWith('remote:')) {
          // 宿主握手：可建会话、可会话操作；write 未授予（模型切换隐藏）。
          return action === 'workspaceCreate' || action === 'sessionOps';
        }
        return true; // 本地身份恒 true（契约）
      },
    }, async ({ renderSurface }) => {
      const html = await renderSurface({ viewProjectId: 'dir:/srv/project-c' });

      const createActions = extractWorkspaceActions(html).filter((a) => a.type === 'create_session');
      assert.equal(createActions.length, 2, 'header + tab-area new-chat buttons render');
      for (const action of createActions) {
        assert.equal(action.agentId, 'remote:server-a:programming-helper', 'host-level namespace id flows from the data layer');
        assert.equal(action.openDirectory, '/srv/project-c');
      }
      assert.ok(
        capabilityCalls.some((c) => c.identity === 'remote:server-a:programming-helper' && c.action === 'workspaceCreate'),
        'new-chat gating queries workspaceCreate with the view identity',
      );
      assert.ok(
        capabilityCalls.some((c) => c.identity === 'remote:server-a:programming-helper' && c.action === 'write'),
        'model switch gating queries write with the view identity',
      );
      assert.ok(!html.includes('ph-model-switch'), 'write not granted → model switch hidden');
    });
  });

  it('hides new-chat when workspaceCreate is not granted', async () => {
    await createSandbox({
      capabilityFor: (identity) => !String(identity).startsWith('remote:'),
    }, async ({ renderSurface }) => {
      const html = await renderSurface({ viewProjectId: 'dir:/srv/project-c' });
      const createActions = extractWorkspaceActions(html).filter((a) => a.type === 'create_session');
      assert.equal(createActions.length, 0, 'denied host keeps the new-chat buttons hidden');
    });
  });

  it('local project view regression: new-chat renders with unchanged bare action shape', async () => {
    const capabilityCalls = [];
    await createSandbox({
      capabilityFor: (identity, action) => {
        capabilityCalls.push({ identity: String(identity), action: String(action) });
        return true; // 本地身份恒 true（契约）
      },
    }, async ({ renderSurface }) => {
      const html = await renderSurface();
      const createActions = extractWorkspaceActions(html).filter((a) => a.type === 'create_session');
      assert.ok(createActions.length >= 1, 'local project keeps the new-chat button');
      for (const action of createActions) {
        assert.equal(action.agentId, undefined, 'local action stays bare (no host namespace id)');
        assert.equal(action.openDirectory, 'D:/local-proj');
      }
      assert.ok(
        capabilityCalls.some((c) => c.identity === 'programming-helper' && c.action === 'workspaceCreate'),
      );
      assert.ok(html.includes('ph-model-switch'), 'local model switch keeps rendering');
    });
  });

  it('capabilityFor not yet mounted (integration window): local view visible, remote view hidden', async () => {
    await createSandbox({}, async ({ renderSurface }) => { // 不注入 capabilityFor
      const remoteHtml = await renderSurface({ viewProjectId: 'dir:/srv/project-c' });
      assert.equal(
        extractWorkspaceActions(remoteHtml).filter((a) => a.type === 'create_session').length,
        0,
        'remote identity falls back to the contract default (false)',
      );
      const localHtml = await renderSurface({ viewProjectId: null });
      assert.ok(
        extractWorkspaceActions(localHtml).filter((a) => a.type === 'create_session').length >= 1,
        'local identity stays visible',
      );
    });
  });
});

// ── create_session flow ──────────────────────────────────────

describe('remote create_session flow (R2-03)', () => {
  it('rendered remote action flows through runWorkspaceAction: forwarded POST, namespaced target, switch', async () => {
    const requests = [];
    let pendingAtCreate = null;
    let pendingAtWait = null;
    await createSandbox({
      requests,
      capabilityFor: (identity, action) => (
        String(identity).startsWith('remote:')
          ? (action === 'workspaceCreate' || action === 'sessionOps')
          : true
      ),
    }, async ({ run, renderSurface, callsOf, hooks, operations }) => {
      const html = await renderSurface({ viewProjectId: 'dir:/srv/project-c' });
      const rendered = extractWorkspaceActions(html).find((a) => a.type === 'create_session');
      assert.ok(rendered, 'button rendered');

      // 请求发出瞬间快照真实登记表：占位操作此刻在飞，字段即迁移前 spy 记录的
      // begin 入参（同一份操作记录）。
      hooks.onCreateRequest = () => { pendingAtCreate = snapshotOperations(operations); };

      // 就绪观察按集成期契约 stub（真实目录轮询为 50×400ms 的生产语义，
      // 参照 remote-session-history.test.js R2-02 的 stub 方式）。等待点快照：
      // 目标会话已提交、runtime 未就绪 → phase 应为 target-starting。
      run(`window.RemoteConnections.waitForRuntimeForSession = function (sessionId, attempts) {
        window.__calls.push({ fn: 'waitForRuntimeForSession', args: [String(sessionId), attempts] });
        globalThis.__pendingAtWait = window.__sidebarOpsSnapshot();
        return Promise.resolve('remote:server-a:runtime-new');
      };`);
      await run(`window.runWorkspaceAction(JSON.stringify(${JSON.stringify(rendered)}))`);
      pendingAtWait = JSON.parse(run('JSON.stringify(globalThis.__pendingAtWait || [])'));

      const postCalls = requests.filter((r) => r.url === '/protoclaw/prebuilt_sessions' && r.init?.method === 'POST');
      assert.equal(postCalls.length, 1, 'exactly one forwarded create call');
      assert.equal(postCalls[0].init.method, 'POST');
      assert.ok(String(postCalls[0].init.headers['x-idempotency-key'] || ''), 'create carries an idempotency key');

      assert.equal(pendingAtCreate.length, 1, '侧栏占位操作恰好一条');
      const begin = pendingAtCreate[0];
      // 请求体里的 operationId 就是真实登记表那条操作的身份
      assert.deepEqual(JSON.parse(postCalls[0].init.body), {
        agentId: 'remote:server-a:programming-helper',
        openDirectory: '/srv/project-c',
        responseMode: 'delta',
        operationId: begin.operationId,
      });
      assert.equal(begin.agentId, 'remote:server-a:programming-helper');
      assert.equal(begin.kind, 'create');
      assert.equal(begin.projectDir, '/srv/project-c');

      // namespaceMutationResult（真实现）把响应裸 id 归一化为命名空间 id：
      // 等待点的在飞操作已进入 target-starting 并带服务端 revision。
      assert.equal(pendingAtWait.length, 1);
      assert.equal(pendingAtWait[0].phase, 'target-starting');
      assert.equal(pendingAtWait[0].targetSessionId, 'remote:server-a:session-new');
      assert.equal(pendingAtWait[0].serverRevision, 7);

      const waited = callsOf('waitForRuntimeForSession');
      assert.equal(waited.length, 1);
      assert.equal(waited[0].args[0], 'remote:server-a:session-new', 'runtime located via the namespaced session id');

      const switches = callsOf('requestSwitch');
      assert.equal(switches.length, 1);
      assert.equal(switches[0].args[0], 'remote:server-a:runtime-new');

      // 收口：成功路径零 alert（failed 分支必弹），登记表无滞留占位。
      assert.equal(callsOf('alert').length, 0, '成功路径不弹失败提示');
      assert.deepEqual(snapshotOperations(operations), [], 'settled 后无滞留侧栏操作');
    });
  });

  it('create failure surfaces explicitly: alert + failed operation, no switch, no retry', async () => {
    const requests = [];
    let pendingAtCreate = null;
    await createSandbox({ requests, createOk: false, createStatus: 403 }, async ({ run, callsOf, hooks, operations }) => {
      hooks.onCreateRequest = () => { pendingAtCreate = snapshotOperations(operations); };
      await run(`window.runWorkspaceAction(JSON.stringify({
        type: 'create_session',
        openDirectory: '/srv/project-c',
        agentId: 'remote:server-a:programming-helper',
      }))`);

      const postCalls = requests.filter((r) => r.init?.method === 'POST');
      assert.equal(postCalls.length, 1, 'single attempt — no silent retry');

      const alerts = callsOf('alert');
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].args[0], 'Session failed: workspace_create_denied');

      // 失败也要收口：同一条在飞操作（请求体身份即它）已离开登记表。
      assert.equal(pendingAtCreate.length, 1);
      assert.equal(
        JSON.parse(postCalls[0].init.body).operationId,
        pendingAtCreate[0].operationId,
        '失败路径操作身份与请求一致',
      );
      assert.deepEqual(snapshotOperations(operations), [], 'failed 后无滞留侧栏操作');
      assert.equal(callsOf('requestSwitch').length, 0, 'no switch after failure');
    });
  });

  it('missing project directory fails explicitly before any request', async () => {
    const requests = [];
    await createSandbox({ requests }, async ({ run, callsOf, operations }) => {
      await run(`window.runWorkspaceAction(JSON.stringify({
        type: 'create_session',
        agentId: 'remote:server-a:programming-helper',
      }))`);

      assert.equal(requests.filter((r) => r.init?.method === 'POST').length, 0, 'no request without a directory identity');
      const alerts = callsOf('alert');
      assert.equal(alerts.length, 1);
      assert.ok(alerts[0].args[0].includes('缺少创建会话所需的项目目录'));
      assert.deepEqual(snapshotOperations(operations), [], '无目录时不开侧栏操作');
    });
  });
});
