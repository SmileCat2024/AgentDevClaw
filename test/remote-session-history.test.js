/**
 * R2-01 remote session history — frontend merge render + activation request shape.
 *
 * Covers (vm sandbox, no real network):
 *   1. getRemoteHistorySessions: directory-bucketed merge from forwarded lists
 *   2. getProgrammingHelperProjects: remote history merged into the local
 *      project bucket (mixed recency sort, no source partition, no badge)
 *   3. open_session activation request shape (host-namespace agentId +
 *      namespaced sessionId + idempotency key) and explicit failure when the
 *      catalog has no entry for the session
 *
 * Identity discipline (ADR-0012): ids flow from the data layer; the render
 * layer carries no remote-branch UI logic.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFrontendSandbox } from './helpers/frontend-vm.js';

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

// Remote list payload as the forwarded endpoint returns it (bare ids from the
// remote host); the history layer namespaces them client-side.
const REMOTE_HISTORY = {
  revision: 3,
  activeSessionId: 'session-running',
  sessions: [
    { id: 'session-hist-1', title: '远程历史 A', updatedAt: '2026-08-30T09:00:00.000Z', openDirectory: '/srv/project-c', messageCount: 4 },
    { id: 'session-hist-2', title: '远程历史 B', updatedAt: '2026-08-29T10:00:00.000Z', openDirectory: '/srv/project-c' },
    { id: 'session-nodir', title: '无目录会话', openDirectory: '' },
    { id: 'session-other-dir', title: '其他目录', openDirectory: 'D:/elsewhere' },
  ],
};

// workspace-actions.js 的全局依赖以最小替身注入（激活分支在本地动作处理之前
// 短路，本地依赖不会被触达）。
function loadWorkspaceActions(ctx) {
  ctx.run(`
    var bumpNavigationGuard = function () {};
    var saveCurrentWorkspaceSurfaceScroll = function () {};
    var hasWorkspaceSessions = function () { return true; };
    var getWorkspaceSessions = function () { return []; };
    var getWorkspaceSessionById = function () { return null; };
    var requestSwitch = async function () {};
    var loadAgents = async function () {};
    var markSessionLoading = function () {};
    var clearSessionLoading = function () {};
    var markActionLoading = function () {};
    var beginChatLoadingSession = function () {};
    var clearChatLoadingSession = function () {};
    var beginFollowLatestCooldown = function () {};
    var beginFollowLatestEntryWindow = function () {};
    var normalizeAgentIdentity = function (v) { return v || ''; };
    var saveCurrentRuntimeToCache = function () {};
    var getRuntimeContextKey = function () { return ''; };
    var _storeVisibleSessionInputDraft = function () {};
    var openPrebuiltWorkspaceSession = async function () {};
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
    var renderCurrentMainView = function () {};
    var updateAgentRecord = function () {};
    var beginSidebarOperation = function (o) { return { operationId: 'op-test' }; };
    var finishSidebarOperation = function () {};
    var updateSidebarOperation = function () {};
    var beginSidebarOperationMainThreadObservation = function () { return function () {}; };
    var recordSidebarOperationCheckpoint = function () {};
    var navigateToSessionMutationTarget = async function () {};
    var currentLanguage = 'zh';
    var lastRenderedWorkspaceHtml = '';
    var prebuiltSessionSwitchInFlight = false;
    var shouldAnimateWorkspaceSurface = false;
  `);
  ctx.loadSource('public/src/modules/workspace-actions.js');
}

function historySandbox({ catalog = CATALOG, history = REMOTE_HISTORY, requests = [] } = {}) {
  const ctx = createFrontendSandbox({
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      const path = String(url).split('?')[0];
      if (path === '/protoclaw/remote_catalog') {
        return { ok: true, status: 200, json: async () => catalog };
      }
      if (path === '/protoclaw/prebuilt_sessions') {
        return { ok: true, status: 200, json: async () => history };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
    renderAgentList: () => {},
    t: (key) => key,
    escapeHtml: (value) => String(value ?? ''),
    isRemoteNamespaceAgentId: (value) => String(value || '').startsWith('remote:'),
    currentRuntimeAgentId: null,
    allAgents: [],
  });
  ctx.loadSource('public/src/modules/remote-connections.js');
  return { ctx, requests };
}

describe('remote session history merge (R2-01)', () => {
  it('fetches forwarded lists per connected host and buckets them by directory', async () => {
    const { ctx, requests } = historySandbox();
    await ctx.window.RemoteConnections.refresh();
    await ctx.run('window.RemoteConnections.maybeRefreshRemoteHistory()');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const historyCalls = requests.filter((r) => r.url.startsWith('/protoclaw/prebuilt_sessions'));
    assert.equal(historyCalls.length, 1, 'exactly one forwarded list fetch');
    assert.equal(
      historyCalls[0].url,
      '/protoclaw/prebuilt_sessions?agentId=remote%3Aserver-a%3Aprogramming-helper',
      'forwarded list uses the host-level namespace id',
    );

    // Directory-matching sessions merge; directoryless and other-directory
    // host sessions stay out (ADR-0010: 无目录会话不并入列表).
    // JSON 往返规避 VM realm 与测试 realm 的原型差异。
    const mergedIds = JSON.parse(ctx.run(
      'JSON.stringify(getRemoteHistorySessions("/srv/project-c").map((s) => s.id).sort())',
    ));
    assert.deepEqual(mergedIds, [
      'remote:server-a:session-hist-1',
      'remote:server-a:session-hist-2',
    ]);
    const merged = JSON.parse(ctx.run(
      'JSON.stringify(getRemoteHistorySessions("/srv/project-c"))',
    ));
    assert.equal(merged[0].remoteConnectionId, 'server-a');
    assert.ok(!merged.some((s) => s.id.includes('session-nodir')), 'directoryless host session stays out');
    assert.ok(!merged.some((s) => s.id === 'remote:server-a:session-other-dir'), 'other-directory session not merged');
  });

  it('keeps remote history buckets empty after a failed fetch (no fabricated data)', async () => {
    const ctx = createFrontendSandbox({
      fetch: async (url) => {
        const path = String(url).split('?')[0];
        if (path === '/protoclaw/remote_catalog') {
          return { ok: true, status: 200, json: async () => CATALOG };
        }
        return { ok: false, status: 503, json: async () => null };
      },
      renderAgentList: () => {},
      t: (key) => key,
      escapeHtml: (value) => String(value ?? ''),
      isRemoteNamespaceAgentId: (value) => String(value || '').startsWith('remote:'),
      currentRuntimeAgentId: null,
      allAgents: [],
    });
    ctx.loadSource('public/src/modules/remote-connections.js');
    await ctx.window.RemoteConnections.refresh();
    await ctx.run('window.RemoteConnections.maybeRefreshRemoteHistory()');
    const merged = ctx.run('getRemoteHistorySessions("/srv/project-c")');
    assert.equal(merged.length, 0);
  });

  it('mixed merge: local and remote ids share the project bucket, no badge fields', async () => {
    const { ctx } = historySandbox();
    await ctx.window.RemoteConnections.refresh();
    await ctx.run('window.RemoteConnections.maybeRefreshRemoteHistory()');

    // project-data.js merge needs these PH project-builder dependencies.
    ctx.run(`
      var getWorkspaceSessions = function (agent) {
        return Array.isArray(agent?.workspace_sessions?.sessions) ? agent.workspace_sessions.sessions : [];
      };
      var getAgentWorkspaceState = function (agent) {
        return agent?.workspace_state && typeof agent.workspace_state === 'object'
          ? agent.workspace_state
          : { forms: {}, openDirectory: '', updatedAt: null };
      };
      function getPathLeaf(value) {
        const text = String(value || '').trim();
        const parts = text.split(/[\\\\/]+/).filter(Boolean);
        return parts.length > 0 ? parts[parts.length - 1] : text;
      }
      function isPhStyleWorkspaceAgent(agent) {
        return !!(agent && agent.source === 'prebuilt' && agent.id === 'programming-helper');
      }
    `);
    ctx.loadSource('public/src/modules/project-data.js');
    ctx.run(`
      var __phAgent = {
        id: 'programming-helper',
        source: 'prebuilt',
        workspace_state: { openDirectory: '/srv/project-c', forms: {}, phProjects: [] },
        workspace_sessions: { activeSessionId: 'session-local', sessions: [
          { id: 'session-local', title: '本地会话', openDirectory: '/srv/project-c', updatedAt: '2026-08-30T12:00:00.000Z' },
        ] },
      };
    `);
    const projects = JSON.parse(ctx.run(
      'JSON.stringify(getProgrammingHelperProjects(__phAgent).map((p) => ({ id: p.id, sessions: p.sessions })))',
    ));
    const project = projects.find((p) => p.id === 'dir:/srv/project-c');
    assert.ok(project, 'local project bucket exists');
    const ids = project.sessions.map((s) => s.id);
    // Mixed, no source partition: local and remote ids live in the same array.
    assert.ok(ids.includes('session-local'), 'local session present');
    assert.ok(ids.includes('remote:server-a:session-hist-1'), 'remote history merged');
    assert.ok(!ids.includes('remote:server-a:session-other-dir'), 'unmatched directory not merged');
    // The merge never fabricates remote markers — presentation stays identical.
    const remoteSession = project.sessions.find((s) => s.id === 'remote:server-a:session-hist-1');
    assert.ok(remoteSession);
    assert.equal(remoteSession.remoteBadge, undefined);
    assert.equal(remoteSession.isRemote, undefined);
  });

  it('open_session activation posts to the activate endpoint with host namespace id and idempotency key', async () => {
    const requests = [];
    const { ctx } = historySandbox({ requests });
    loadWorkspaceActions(ctx);
    ctx.run(`
      window.RemoteConnections.getEntryHostNamespaceId = function (id) {
        return id === 'remote:server-a:session-hist-1' ? 'remote:server-a:programming-helper' : null;
      };
      window.RemoteConnections.resolveRuntimeRef = function () { return null; };
      window.switchAgent = async () => {};
    `);
    await ctx.run(
      `window.runWorkspaceAction(JSON.stringify({ type: 'open_session', sessionId: 'remote:server-a:session-hist-1' }))`,
    );
    const activateCalls = requests.filter((r) => r.url === '/protoclaw/prebuilt_sessions/activate');
    assert.equal(activateCalls.length, 1, 'exactly one activate call');
    const call = activateCalls[0];
    assert.equal(call.init.method, 'POST');
    assert.ok(String(call.init.headers['x-idempotency-key'] || ''), 'activation carries an idempotency key');
    assert.deepEqual(JSON.parse(call.init.body), {
      agentId: 'remote:server-a:programming-helper',
      sessionId: 'remote:server-a:session-hist-1',
      responseMode: 'delta',
    });
  });

  it('open_session fails explicitly when the catalog has no entry for the session', async () => {
    const requests = [];
    const { ctx } = historySandbox({ requests });
    loadWorkspaceActions(ctx);
    await ctx.window.RemoteConnections.refresh();
    ctx.run('window.RemoteConnections.getEntryHostNamespaceId = function () { return null; };');
    await ctx.run(`window.runWorkspaceAction(JSON.stringify({ type: 'open_session', sessionId: 'remote:server-a:session-ghost' }))`);
    assert.equal(requests.filter((r) => String(r.url).includes('activate')).length, 0, 'no request when host unresolvable');
  });
});
