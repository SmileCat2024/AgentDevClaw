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
 * Loads the real selectWorkspaceSurface + WORKSPACE_PANEL_REFRESHERS +
 * refreshVisibleWorkspacePanelData sources from app-ui.js into a vm sandbox,
 * and the real shouldRenderBlock from workspace-blocks.js, mirroring the
 * harness style of frontend-sidebar-runtime-active.test.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const uiSource = fs.readFileSync(new URL('../public/src/app-ui.js', import.meta.url), 'utf8');
const blocksSource = fs.readFileSync(new URL('../public/src/modules/workspace-blocks.js', import.meta.url), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `${startMarker} marker should exist`);
  assert.notEqual(end, -1, `${endMarker} marker should exist`);
  return source.slice(start, end);
}

const selectSurfaceSource = sourceBetween(
  uiSource,
  'function selectWorkspaceSurface(agentId, options = {}) {',
  'function upsertConnectedAgent(',
);
const refresherSource = sourceBetween(
  uiSource,
  'const WORKSPACE_PANEL_REFRESHERS = {',
  'function getPassiveWorkspaceSurfaceMode(',
);
const shouldRenderBlockSource = sourceBetween(
  blocksSource,
  'function shouldRenderBlock(block) {',
  'function renderActionButton(',
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

function createHarness({
  agent = MEMO_AGENT,
  detailLoaded = true,
  currentRuntimeAgentId = 'memo-runtime-1',
  options = {},
} = {}) {
  const refreshCalls = [];
  const loadedDetailIds = new Set(detailLoaded ? [agent.id] : []);
  const allAgents = detailLoaded ? [agent] : [{ ...agent, ui: undefined }];
  const sandbox = {
    // 状态（selectWorkspaceSurface 读写）
    focusedAgentId: agent.id,
    currentRuntimeAgentId,
    readOnlyMode: false,
    currentWorkspaceTab: 'chat',
    currentWorkspaceArtifactDetail: null,
    currentWorkspaceDocsetDetail: null,
    currentProjectDocsetOpen: false,
    currentProjectRequirementEdit: null,
    currentProjectDocsetPage: 'requirement',
    shouldAnimateWorkspaceSurface: false,
    unitModePreferences: {},
    workspaceSurfaceModePreferences: {},
    loadedAgentDetailIds: loadedDetailIds,
    allAgents,
    _recentlyFinishedRuntimes: new Set(),
    window: {
      MemoOverviewUI: { refresh: () => refreshCalls.push('memo-overview') },
      MemoNotesUI: { refresh: () => refreshCalls.push('memo-notes') },
      MemoRemindersUI: { refresh: () => refreshCalls.push('memo-reminders') },
    },
    // 编排依赖 stub：本测试关注 selectWorkspaceSurface 的导航编排与
    // refreshVisibleWorkspacePanelData 的分发（均为真实源码），其余按
    // 最小语义打桩。
    bumpNavigationGuard: () => {},
    loadAgentDetail: (agentId) => new Promise((resolve) => {
      // 模拟真实时序：detail 经网络异步落定后才把带 ui 声明的条目写回
      // allAgents（同步执行段 ui 仍缺席，同步末尾的刷新调用应空转）。
      queueMicrotask(() => {
        const index = allAgents.findIndex((item) => item.id === agentId);
        if (index >= 0) allAgents[index] = agent;
        resolve();
      });
    }),
    getUnitPreferenceKey: (a) => a?.id || null,
    getUnitTabs: () => [{ id: 'home' }, { id: 'chat' }],
    getDefaultUnitMode: () => 'home',
    getCurrentUnitUi: (a) => a?.ui || null,
    getCurrentAgentRecord: () => agent,
    saveCurrentWorkspaceSurfaceScroll: () => {},
    getRuntimeContextKey: () => 'rk',
    saveCurrentRuntimeToCache: () => {},
    applySessionViewPatch: () => {},
    setFollowLatest: () => {},
    resetRuntimeBackedSurfaceState: () => {},
    beginPendingSessionNavigation: () => {},
    beginChatLoadingSession: () => {},
    clearPendingSessionNavigation: () => {},
    renderAgentList: () => {},
    renderCurrentMainView: () => {},
    renderFeaturePanel: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${shouldRenderBlockSource}\n${refresherSource}\n${selectSurfaceSource}`,
    sandbox,
  );
  return {
    sandbox,
    refreshCalls,
    select: () => sandbox.selectWorkspaceSurface(agent.id, options),
  };
}

test('sidebar entry into workspace home revalidates visible panels (regression)', async () => {
  // 从会话切回首页：currentRuntimeAgentId 被清空，tab 落 'home'，可见的
  // memo-overview 面板必须后台重取——修复前此路径只重投影旧缓存。
  const { select, refreshCalls } = createHarness();
  await select();
  assert.deepEqual(refreshCalls, ['memo-overview']);
});

test('awaitSession surface does not revalidate panels (tab stays chat)', async () => {
  // 接续等待表面：currentWorkspaceTab 冻结在 'chat'，home-default block
  // 不可见，刷新分发空转（面板也不可见，无谓请求）。
  const { select, refreshCalls } = createHarness({ options: { awaitSession: 'sess-1' } });
  await select();
  assert.deepEqual(refreshCalls, []);
});

test('cold detail load revalidates panels once detail lands', async () => {
  // detail 未加载分支：同步末尾的调用因 ui 未挂而空转，loadAgentDetail
  // 就绪后必须补发刷新（blocks 届时才可用）。
  const { select, refreshCalls, sandbox } = createHarness({ detailLoaded: false });
  await select();
  await new Promise((resolve) => setImmediate(resolve)); // 等 then 链落定
  assert.equal(sandbox.currentWorkspaceTab, 'home');
  assert.deepEqual(refreshCalls, ['memo-overview']);
});
