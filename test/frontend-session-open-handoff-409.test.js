// 接续挡板 409 在 open_session 消费端的处理契约（workspace-actions）：
//   1. 侧栏操作必须结算——409 表示本次 activate 不会成立，滞留的 operation
//      会一直渲染成「正在启动新会话…」占位；
//   2. 不得经 openConversationTarget 再走一轮——那条路径会重新读本地线程
//      缓存判挡板并再次发起 activate，与服务端 409 构成循环（现象：点一次
//      线程条目就冒出大量「正在启动新会话…」占位）；
//   3. 直接进入等待表面，挂上服务端 409 指明的目标线程。
//
// 链路真实性：openPrebuiltWorkspaceSession 取 app-main.js 的真实实现（含
// 409 → error.handoff 的结构化解析），workspace-actions 亦为真实源码，
// 只有宿主全局与观察点用替身。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createFrontendSandbox, sourceBetween } from './helpers/frontend-vm.js';

const appMainSource = fs.readFileSync(new URL('../public/src/app-main.js', import.meta.url), 'utf8');
const openSessionSource = sourceBetween(
  appMainSource,
  'async function openPrebuiltWorkspaceSession(agentId, rawAction) {',
  'function applyOptimisticWorkspaceSession(agentId, session) {',
);

function createActionsSandbox() {
  const requests = [];
  const events = { awaitSurface: [], openConversationTarget: 0, alerts: [] };
  const host = {
    id: 'coder',
    source: 'prebuilt',
    runtime_session_id: '',
    active_workspace_session_id: 'sess-head',
    workspace_sessions: {
      revision: 1,
      activeSessionId: 'sess-head',
      sessions: [{ id: 'sess-head', title: 'T' }],
    },
  };
  const ctx = createFrontendSandbox({
    fetch: async (url) => {
      requests.push({ url: String(url) });
      if (String(url).includes('/protoclaw/prebuilt_sessions/activate')) {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            ok: false,
            code: 'thread_handoff_in_progress',
            message: 'Thread wt-1 正在接续，挂载已拒绝',
            threadId: 'wt-1',
            headSessionId: 'sess-head',
          }),
          text: async () => 'conflict',
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, messages: [] }), text: async () => '' };
    },
    renderAgentList: () => {},
    t: (key) => key,
    escapeHtml: (value) => String(value ?? ''),
    currentRuntimeAgentId: null,
    allAgents: [host],
    markActionLoading: () => {},
    loadAgents: async () => {},
    renderCurrentMainView: () => {},
    getCurrentAgentRecord: () => host,
    resolveStudioSessionDirectory: async (_agent, action) => action,
    hasWorkspaceSessions: () => true,
    getWorkspaceSessions: () => host.workspace_sessions.sessions,
    getWorkspaceSessionById: (_agent, sid) => host.workspace_sessions.sessions.find((s) => s.id === sid) || null,
    applySessionViewPatch: () => {},
  });
  ctx.window.alert = (msg) => { events.alerts.push(String(msg)); };
  ctx.loadSource('public/src/modules/sidebar-operations.js');
  ctx.run(`
    var bumpNavigationGuard = function () {};
    var _navigationGuardEpoch = 0;
    var isRemoteNamespaceAgentId = function () { return false; };
    var getPathLeaf = function (v) { return String(v || '').split(/[\\\\/]/).pop() || ''; };
    var saveCurrentWorkspaceSurfaceScroll = function () {};
    var requestSwitch = async function () { return { switched: true }; };
    var markSessionLoading = function () {};
    var clearSessionLoading = function () {};
    var beginChatLoadingSession = function () {};
    var clearChatLoadingSession = function () {};
    var beginFollowLatestCooldown = function () {};
    var beginFollowLatestEntryWindow = function () {};
    var normalizeAgentIdentity = function (v) { return v || ''; };
    var saveCurrentRuntimeToCache = function () {};
    var getRuntimeContextKey = function () { return ''; };
    var _storeVisibleSessionInputDraft = function () {};
    var applyOptimisticWorkspaceSession = function () {};
    var upsertConnectedAgent = function () {};
    var createCompactedResumeSession = async function () {};
    var applyManagedPrebuiltAgent = function () {};
    var getWorkspaceFormDraft = function () { return {}; };
    var saveWorkspaceFormDraft = function () {};
    var setPreferredUnitMode = function () {};
    var getFeatureCreatorProjects = function () { return []; };
    var getAgentCreatorProjects = function () { return []; };
    var isAssemblySession = function () { return false; };
    var getAgentWorkspaceState = function () { return {}; };
    var updateAgentRecord = function () {};
    var navigateToSessionMutationTarget = async function () {};
    var lastRenderedWorkspaceHtml = '';
    var prebuiltSessionSwitchInFlight = false;
    var shouldAnimateWorkspaceSurface = false;
    var clearPendingSessionNavigation = function () {};
    var updatePendingSessionNavigation = function () {};
    var beginPendingSessionNavigation = function () {};
    var hasPendingSessionNavigation = function () { return false; };
    var resetRuntimeBackedSurfaceState = function () {};
    var currentWorkspaceTab = 'chat';
  `);
  // 真实 activate 调用链（含 409 → error.handoff 解析），不用替身绕开。
  ctx.run(openSessionSource);
  ctx.loadSource('public/src/modules/workspace-actions.js');
  // 宿主插件：本地分支 selectForNewSession 只做透传。
  ctx.run('window.ClawFW = window.ClawFW || {};'
    + ' window.ClawFW.workspaceAgents = { selectForNewSession: function (agent, action) { return action; } };');
  ctx.window.refreshThreads = async () => {};
  // 观察点：等待表面入口（应被调用一次）与「再走一轮」入口（应零次）。
  ctx.window.enterThreadAwaitView = async (target) => {
    events.awaitSurface.push({ ...target });
    return { ok: true };
  };
  ctx.window.openConversationTarget = async () => {
    events.openConversationTarget += 1;
    return { ok: true };
  };
  // 结算观察：包一层真实 finishSidebarOperation 记录调用。
  ctx.run(`
    globalThis.__finishedOps = [];
    const __realFinish = finishSidebarOperation;
    finishSidebarOperation = function (operationId, phase, fields) {
      globalThis.__finishedOps.push({ operationId: String(operationId || ''), phase: String(phase || '') });
      return __realFinish(operationId, phase, fields);
    };
  `);
  return { ctx, requests, events };
}

test('409 挡板：结算侧栏操作、只发起一次 activate、直接进等待表面', async () => {
  const { ctx, requests, events } = createActionsSandbox();

  await ctx.run(`window.runWorkspaceAction(${JSON.stringify({ type: 'open_session', sessionId: 'sess-head' })}, null)`);

  const activates = requests.filter((r) => r.url.includes('/activate'));
  assert.equal(activates.length, 1, '409 后不得再次发起 activate（旧实现会循环）');
  assert.equal(events.openConversationTarget, 0, '不得经 openConversationTarget 二次进入');
  assert.equal(events.awaitSurface.length, 1, '进入等待表面恰好一次');
  assert.equal(events.awaitSurface[0].threadId, 'wt-1', '等待目标是服务端 409 指明的线程');
  assert.equal(events.awaitSurface[0].sessionId, 'sess-head');
  const settled = ctx.run('globalThis.__finishedOps');
  assert.ok(settled.some((op) => op.phase === 'settled'), '侧栏操作必须结算，否则占位滞留');
  assert.equal(events.alerts.length, 0, '挡板不是失败，不得弹 alert');
});
