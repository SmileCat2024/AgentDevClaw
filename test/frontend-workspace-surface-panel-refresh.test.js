/**
 * Tests for selectWorkspaceSurface panel revalidation — workspace navigation
 * must revalidate visible self-refreshing panels (memo overview / notes /
 * reminders).
 *
 * Bug (fixed): returning from a conversation to a workspace home page via the
 * sidebar host entry (handlePrebuiltAgentClick → selectWorkspaceSurface) only
 * re-rendered the cached panel projection. agent-side updates (notes /
 * reminders written during the chat) stayed invisible until a hard page reload,
 * because selectWorkspaceSurface never dispatched refreshVisibleWorkspacePanelData
 * (only setPreferredUnitMode did, covering tab switches but not the
 * sidebar-entry / switchAgent-to-host paths).
 *
 * 装载路线（ESM 迁移配方第三节）：
 *   - workspace-surface.js / workspace-blocks.js 已迁 ESM → 真实 `import`
 *     （withP2EsmCase 的 c.load，每 case 整图隔离）。block 可见性判定
 *     `shouldRenderBlock` 取自模块命名导出，再经 c.expose 交给 classic 侧
 *     （classic 脚本的裸标识符解析的就是沙箱全局，等价生产里 window 上的同名
 *     函数）；不再把 ESM 源码切片喂给 vm。
 *   - 导航编排 selectWorkspaceSurface 来自 ESM（workspace-surface.js，以上条
 *     真实 import 的 createWorkspaceSurface(host) 产出）。
 *   - app-ui.js 仍是 classic（首屏同步边界）→ 继续按标记取片段执行，只贡献两段
 *     classic 实现：宿主工厂 createWorkspaceSurfaceHost()（把 classic 状态与函数
 *     适配成 workspace-surface 的 host 契约）与面板刷新分发
 *     refreshVisibleWorkspacePanelData()（按 block 可见性调 ClawHost refresher）。
 *     全文装载需要 index.html 的整套脚本序，非本用例关注面。
 *   - claw-host.js 仍是 classic → loadSource（面板刷新经它的 blocks 注册表）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const WORKSPACE_SURFACE = 'public/src/modules/workspace-surface.js';
const WORKSPACE_BLOCKS = 'public/src/modules/workspace-blocks.js';

const uiSource = fs.readFileSync(new URL('../public/src/app-ui.js', import.meta.url), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `${startMarker} marker should exist`);
  assert.notEqual(end, -1, `${endMarker} marker should exist`);
  return source.slice(start, end);
}

// classic 片段一：宿主工厂（workspace-surface 的 host 契约适配），随
// selectWorkspaceSurface 的 ESM 实现一起被取用。
const selectSurfaceSource = sourceBetween(
  uiSource,
  'function createWorkspaceSurfaceHost() {',
  'function upsertConnectedAgent(',
);
// classic 片段二：面板刷新分发（按 block 可见性查 ClawHost refresher 表）。
const refresherSource = sourceBetween(
  uiSource,
  'function refreshVisibleWorkspacePanelData(agent = getCurrentAgentRecord()) {',
  'function getPassiveWorkspaceSurfaceMode(',
);

const MEMO_AGENT = {
  id: 'memo',
  source: 'prebuilt',
  kind: 'workspace',
  ui: {
    entry: 'home',
    home: { blocks: [{ type: 'memo-overview', visibility: 'home-default' }] },
  },
};

/**
 * 已迁 ESM 的宿主适配链（fw-config-panel / workspace-blocks 等）在求值时向
 * window 取 bootstrap 状态宿主。按各宿主契约给最小可读写面；真实实现留在
 * app-core / app-main / sidebar-render（classic，首屏同步边界）。
 */
function createBootstrapHosts() {
  // ph-session 宿主用成对 get/set 复刻 app-core 的 Object.freeze 槽位语义。
  const phSessionState = { phSessionSortMode: 'updatedAt', phSearchQuery: '', _phSearchTimer: null };
  return {
    createP2BootstrapAssemblyHost: () => ({
      assemblyControlPanelOpen: false,
      assemblyDraftRenderTimer: null,
      assemblyLaunchInProgress: false,
      assemblySideRailRevealTimer: null,
    }),
    createP2BootstrapDebugPanelHost: () => ({
      currentLogs: [],
      currentLogsSignature: '',
      currentLogsTruncation: null,
      logFilters: {},
      currentMcpInfo: null,
      selectedOverviewLifecycle: 'StepFinish',
      selectedFeatureName: null,
      selectedRepositoryPackageId: null,
      repoSearchQuery: '',
      repoSourceFilter: 'all',
    }),
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
    createP2BootstrapSidebarHost: () => ({
      restartingRuntimeIds: new Set(),
      suppressSidebarRerender: false,
    }),
    createP2BootstrapSidebarRenderHost: () => ({ lastAgentListRenderSignature: '' }),
    // 跨批静态边（P2 输入面）：agent-data-loader → input-actions → p2-bootstrap-dom /
    // poll-coordinator-host。两个 classic 工厂的真实实现在 app-core / app-main；
    // 本文件只驱动面板刷新回执，按契约给最小面。
    createP2BootstrapDomHost: () => ({ container: {}, ctxMenu: {}, compactContextMenu: {}, agentContextMenu: {}, projectContextMenu: {}, featureRepoContextMenu: {} }),
    createPollCoordinatorHost: () => ({
      run: async () => {}, fastInterval: () => 1000, setTimeout: () => 0, clearTimeout: () => {},
    }),
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
      switchAgent: () => Promise.resolve(),
    }),
    createWorkspaceSurfaceHost: () => ({
      state: {}, now: () => 0, warn() {}, renderPanel() {}, renderList() {}, renderCurrentMainView() {},
      saveScroll() {}, applyPatch() {}, setFollowLatest() {}, resetSurface() {},
      beginNavigation() {}, clearNavigation() {}, beginLoading() {}, clearLoading() {},
    }),
  };
}

/**
 * 一个用例 = 一份沙箱 + 一张真实 ESM 图。classic 相按真实加载序装好
 * 动作分发器（workspace-blocks 顶层注册动作）、内核桥键的 classic 侧
 * （生产由 app-core 的 defineKey 注册，ESM 装载时 claim 吸收）、claw-host，
 * 再执行 app-ui 的导航编排片段。
 */
async function surfaceCase({
  agent = MEMO_AGENT,
  detailLoaded = true,
  currentRuntimeAgentId = 'memo-runtime-1',
  options = {},
} = {}, fn) {
  const refreshCalls = [];
  const loadedDetailIds = new Set(detailLoaded ? [agent.id] : []);
  const allAgents = detailLoaded ? [agent] : [{ ...agent, ui: undefined }];
  return withP2EsmCase({
    classic: (sandbox) => {
      // 状态（导航编排读写）。currentWorkspaceTab 走真实桥：classic 侧写入经
      // 访问器转发进 render-entry 状态 owner，ESM 侧读到同一个值。
      sandbox.KernelState.defineKey('render-entry', 'currentWorkspaceTab', 'chat');
      sandbox.focusedAgentId = agent.id;
      sandbox.currentRuntimeAgentId = currentRuntimeAgentId;
      sandbox.readOnlyMode = false;
      sandbox.currentWorkspaceArtifactDetail = null;
      sandbox.currentWorkspaceDocsetDetail = null;
      sandbox.currentProjectDocsetOpen = false;
      sandbox.currentProjectRequirementEdit = null;
      sandbox.currentProjectDocsetPage = 'requirement';
      sandbox.shouldAnimateWorkspaceSurface = false;
      sandbox.unitModePreferences = {};
      sandbox.workspaceSurfaceModePreferences = {};
      sandbox.loadedAgentDetailIds = loadedDetailIds;
      sandbox.allAgents = allAgents;
      sandbox._recentlyFinishedRuntimes = new Set();
      // 刷新分发经 ClawHost 注册表：加载时登记 refresher，渲染路径按 block type 查表调用。
      // 编排依赖 stub：本测试关注 selectWorkspaceSurface 的导航编排与
      // refreshVisibleWorkspacePanelData 的分发（均为真实源码），其余按
      // 最小语义打桩。
      sandbox.bumpNavigationGuard = () => {};
      sandbox.getUnitPreferenceKey = (record) => record?.id || null;
      sandbox.getUnitTabs = () => [{ id: 'home' }, { id: 'chat' }];
      sandbox.getDefaultUnitMode = () => 'home';
      sandbox.getCurrentUnitUi = (record) => record?.ui || null;
      sandbox.getCurrentAgentRecord = () => agent;
      sandbox.saveCurrentWorkspaceSurfaceScroll = () => {};
      sandbox.getRuntimeContextKey = () => 'rk';
      sandbox.saveCurrentRuntimeToCache = () => {};
      sandbox.applySessionViewPatch = () => {};
      sandbox.setFollowLatest = () => {};
      sandbox.resetRuntimeBackedSurfaceState = () => {};
      sandbox.beginPendingSessionNavigation = () => {};
      sandbox.beginChatLoadingSession = () => {};
      sandbox.clearPendingSessionNavigation = () => {};
      sandbox.renderAgentList = () => {};
      sandbox.renderCurrentMainView = () => {};
      sandbox.renderFeaturePanel = () => {};

      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      Object.assign(sandbox, createBootstrapHosts());
      // 真实 ClawHost 注册表：refreshVisibleWorkspacePanelData 经它查 table_type → refresher。
      sandbox.loadSource('public/src/modules/claw-host.js');
      sandbox.window.ClawHost.blocks.registerRefresher('memo-overview', () => refreshCalls.push('memo-overview'), 'memo');
      sandbox.window.ClawHost.blocks.registerRefresher('memo-notes', () => refreshCalls.push('memo-notes'), 'memo');
      sandbox.window.ClawHost.blocks.registerRefresher('memo-reminders', () => refreshCalls.push('memo-reminders'), 'memo');
      sandbox.run(`${refresherSource}\n${selectSurfaceSource}`);
    },
  }, async (c) => {
    const { createWorkspaceSurface } = await c.load(WORKSPACE_SURFACE);
    const { shouldRenderBlock } = await c.load(WORKSPACE_BLOCKS);
    // classic 片段的裸标识符 shouldRenderBlock 解析到沙箱全局：交给真实命名导出。
    c.expose('shouldRenderBlock', shouldRenderBlock);
    // 详情加载的宿主入口是内核桥键 loadAgentDetail（agent-loader 域，已迁 ESM）。
    // 真实实现要打 Viewer/agent 列表，这里经同一桥键换成确定性实现：详情落地
    // 后把 ui 挂到 allAgents 记录上，即真实 loadAgentDetail 的可见效果。
    c.window.loadAgentDetail = (agentId) => new Promise((resolve) => {
      queueMicrotask(() => {
        const index = allAgents.findIndex((item) => item.id === agentId);
        if (index >= 0) allAgents[index] = agent;
        resolve();
      });
    });
    Object.assign(c.window, createWorkspaceSurface(c.read('createWorkspaceSurfaceHost()')));
    return fn({
      sandbox: c.window,
      refreshCalls,
      select: () => c.window.selectWorkspaceSurface(agent.id, options),
    });
  });
}

test('sidebar entry into workspace home revalidates visible panels (regression)', async () => {
  // 从会话切回首页：currentRuntimeAgentId 被清空，tab 落 'home'，可见的
  // memo-overview 面板必须后台重取——修复前此路径只重投影旧缓存。
  await surfaceCase({}, async ({ select, refreshCalls }) => {
    await select();
    assert.deepEqual(refreshCalls, ['memo-overview']);
  });
});

test('awaitSession surface does not revalidate panels (tab stays chat)', async () => {
  // 接续等待表面：currentWorkspaceTab 冻结在 'chat'，home-default block
  // 不可见，刷新分发空转（面板也不可见，无谓请求）。
  await surfaceCase({ options: { awaitSession: 'sess-1' } }, async ({ select, refreshCalls }) => {
    await select();
    assert.deepEqual(refreshCalls, []);
  });
});

test('cold detail load revalidates panels once detail lands', async () => {
  // detail 未加载分支：同步末尾的调用因 ui 未挂而空转，loadAgentDetail
  // 就绪后必须补发刷新（blocks 届时才可用）。
  await surfaceCase({ detailLoaded: false }, async ({ select, refreshCalls, sandbox }) => {
    await select();
    await new Promise((resolve) => setImmediate(resolve)); // 等 then 链落定
    assert.equal(sandbox.currentWorkspaceTab, 'home');
    assert.deepEqual(refreshCalls, ['memo-overview']);
  });
});
