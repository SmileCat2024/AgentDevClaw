/**
 * R2-03 remote workspace create — capability-gated new-chat + forwarded flow.
 *
 * Covers (vm sandbox, no real network):
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

// 统一沙箱：渲染链（remote-connections → project-data → session-list-render）
// + workspace-actions，同一 realm 内可做渲染按钮 → runWorkspaceAction 的
// 端到端断言。capabilityFor 为集成期契约，按工单签名 stub（缺省不注入）。
function createSandbox({
  requests = [],
  capabilityCalls = [],
  capabilityFor = null,
  createOk = true,
  createStatus = 200,
  createBody = REMOTE_CREATE_RESULT,
} = {}) {
  const ctx = createFrontendSandbox({
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      const path = String(url).split('?')[0];
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
    },
    renderAgentList: () => {},
    t: (key) => key,
    isRemoteNamespaceAgentId: (value) => String(value || '').startsWith('remote:'),
    currentRuntimeAgentId: null,
    allAgents: [],
  });
  ctx.loadSource('public/src/modules/remote-connections.js');
  if (capabilityFor) {
    ctx.window.RemoteConnections.capabilityFor = capabilityFor;
  }
  // project-data.js 依赖以最小替身注入（与 remote-session-history.test.js 同型）。
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
  // session-list-render.js 渲染依赖。
  ctx.run(`
    var localizeWorkspaceValue = function (value, fallback) {
      if (value && typeof value === 'object') {
        return String((currentLanguage === 'zh' ? value.zh : value.en) || fallback || '');
      }
      return (typeof value === 'string' && value) ? value : String(fallback || '');
    };
    var renderActionButton = function () { return ''; };
    var sortPhSessionsByMode = function (sessions) { return (sessions || []).slice(); };
    var renderSessionResumeBadge = function () { return ''; };
    var renderSessionArchivedBadge = function () { return ''; };
    var renderSessionTodoBadge = function () { return ''; };
    var renderSessionTitleAiButton = function () { return ''; };
    var renderSessionTokenBar = function () { return ''; };
    var formatWorkspaceDate = function () { return ''; };
    var getSessionShortTime = function () { return ''; };
    var getSessionRecencyClass = function () { return ''; };
    var getTimeGroupLabel = function () { return ''; };
    var phSearchQuery = '';
    var phSessionSortMode = 'updatedAt';
    var _phOpenSessionsCache = {};
    window.phLoadOpenSessionsCard = function () {};
  `);
  ctx.loadSource('public/src/modules/session-list-render.js');
  // workspace-actions.js 依赖（远程 create 分支触达的以记录替身注入）。
  ctx.run(`
    var bumpNavigationGuard = function () {};
    var saveCurrentWorkspaceSurfaceScroll = function () {};
    var hasWorkspaceSessions = function () { return true; };
    var getWorkspaceSessionById = function () { return null; };
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
    var renderCurrentMainView = function () {};
    var updateAgentRecord = function () {};
    var navigateToSessionMutationTarget = async function () {};
    var beginSidebarOperation = function (raw) {
      window.__calls.push({ fn: 'beginSidebarOperation', args: [raw] });
      return { operationId: 'op-create-1' };
    };
    var updateSidebarOperation = function (id, updates) {
      window.__calls.push({ fn: 'updateSidebarOperation', args: [id, updates] });
    };
    var finishSidebarOperation = function (id, phase, fields) {
      window.__calls.push({ fn: 'finishSidebarOperation', args: [id, phase, fields] });
    };
    var requestSwitch = async function (id, reason) {
      window.__calls.push({ fn: 'requestSwitch', args: [id, reason] });
    };
    var loadAgents = async function () {
      window.__calls.push({ fn: 'loadAgents' });
    };
    window.alert = function (msg) { window.__calls.push({ fn: 'alert', args: [String(msg)] }); };
    window.__calls = [];
  `);
  ctx.loadSource('public/src/modules/workspace-actions.js');
  ctx.run(`var __phAgent = ${JSON.stringify(PH_AGENT)};`);
  return ctx;
}

// 拉起目录 + 远程历史（remoteOnly 桶由 project-data 合并产生），渲染 workspace surface。
async function renderSurface(ctx, { viewProjectId = null } = {}) {
  await ctx.window.RemoteConnections.refresh();
  await ctx.run('window.RemoteConnections.maybeRefreshRemoteHistory()');
  await new Promise((resolve) => setTimeout(resolve, 0));
  ctx.run(`window.ClawFW = { phSurfaceViewProjectId: ${JSON.stringify(viewProjectId)} };`);
  return ctx.run('renderWorkspaceSessionList(__phAgent, {})');
}

function callsOf(ctx, fn) {
  return JSON.parse(
    ctx.run(`JSON.stringify(window.__calls.filter((c) => c.fn === ${JSON.stringify(fn)}))`),
  );
}

// ── render gating ────────────────────────────────────────────

describe('remoteOnly new-chat render gating (R2-03)', () => {
  it('renders new-chat for a remoteOnly project granted workspaceCreate; action carries the host namespace agentId', async () => {
    const requests = [];
    const capabilityCalls = [];
    const ctx = createSandbox({
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
    });
    const html = await renderSurface(ctx, { viewProjectId: 'dir:/srv/project-c' });

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

  it('hides new-chat when workspaceCreate is not granted', async () => {
    const ctx = createSandbox({
      capabilityFor: (identity) => !String(identity).startsWith('remote:'),
    });
    const html = await renderSurface(ctx, { viewProjectId: 'dir:/srv/project-c' });
    const createActions = extractWorkspaceActions(html).filter((a) => a.type === 'create_session');
    assert.equal(createActions.length, 0, 'denied host keeps the new-chat buttons hidden');
  });

  it('local project view regression: new-chat renders with unchanged bare action shape', async () => {
    const capabilityCalls = [];
    const ctx = createSandbox({
      capabilityFor: (identity, action) => {
        capabilityCalls.push({ identity: String(identity), action: String(action) });
        return true; // 本地身份恒 true（契约）
      },
    });
    const html = await renderSurface(ctx);
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

  it('capabilityFor not yet mounted (integration window): local view visible, remote view hidden', async () => {
    const ctx = createSandbox(); // 不注入 capabilityFor
    const remoteHtml = await renderSurface(ctx, { viewProjectId: 'dir:/srv/project-c' });
    assert.equal(
      extractWorkspaceActions(remoteHtml).filter((a) => a.type === 'create_session').length,
      0,
      'remote identity falls back to the contract default (false)',
    );
    const localHtml = await renderSurface(ctx, { viewProjectId: null });
    assert.ok(
      extractWorkspaceActions(localHtml).filter((a) => a.type === 'create_session').length >= 1,
      'local identity stays visible',
    );
  });
});

// ── create_session flow ──────────────────────────────────────

describe('remote create_session flow (R2-03)', () => {
  it('rendered remote action flows through runWorkspaceAction: forwarded POST, namespaced target, switch', async () => {
    const requests = [];
    const ctx = createSandbox({
      requests,
      capabilityFor: (identity, action) => (
        String(identity).startsWith('remote:')
          ? (action === 'workspaceCreate' || action === 'sessionOps')
          : true
      ),
    });
    const html = await renderSurface(ctx, { viewProjectId: 'dir:/srv/project-c' });
    const rendered = extractWorkspaceActions(html).find((a) => a.type === 'create_session');
    assert.ok(rendered, 'button rendered');

    // 就绪观察按集成期契约 stub（真实目录轮询为 50×400ms 的生产语义，
    // 参照 remote-session-history.test.js R2-02 的 stub 方式）。
    ctx.run(`window.RemoteConnections.waitForRuntimeForSession = function (sessionId, attempts) {
      window.__calls.push({ fn: 'waitForRuntimeForSession', args: [String(sessionId), attempts] });
      return Promise.resolve('remote:server-a:runtime-new');
    };`);
    await ctx.run(`window.runWorkspaceAction(JSON.stringify(${JSON.stringify(rendered)}))`);

    const postCalls = requests.filter((r) => r.url === '/protoclaw/prebuilt_sessions' && r.init?.method === 'POST');
    assert.equal(postCalls.length, 1, 'exactly one forwarded create call');
    assert.equal(postCalls[0].init.method, 'POST');
    assert.ok(String(postCalls[0].init.headers['x-idempotency-key'] || ''), 'create carries an idempotency key');
    assert.deepEqual(JSON.parse(postCalls[0].init.body), {
      agentId: 'remote:server-a:programming-helper',
      openDirectory: '/srv/project-c',
      responseMode: 'delta',
      operationId: 'op-create-1',
    });

    const begins = callsOf(ctx, 'beginSidebarOperation');
    assert.equal(begins.length, 1);
    assert.equal(begins[0].args[0].agentId, 'remote:server-a:programming-helper');
    assert.equal(begins[0].args[0].kind, 'create');
    assert.equal(begins[0].args[0].projectDir, '/srv/project-c');

    // namespaceMutationResult（真实现）把响应裸 id 归一化为命名空间 id。
    const updates = callsOf(ctx, 'updateSidebarOperation');
    const starting = updates.find((c) => c.args[1].phase === 'target-starting');
    assert.equal(starting.args[1].targetSessionId, 'remote:server-a:session-new');
    assert.equal(starting.args[1].serverRevision, 7);

    const waited = callsOf(ctx, 'waitForRuntimeForSession');
    assert.equal(waited.length, 1);
    assert.equal(waited[0].args[0], 'remote:server-a:session-new', 'runtime located via the namespaced session id');

    const ready = updates.find((c) => c.args[1].phase === 'target-ready');
    assert.equal(ready.args[1].targetRuntimeId, 'remote:server-a:runtime-new');

    const switches = callsOf(ctx, 'requestSwitch');
    assert.equal(switches.length, 1);
    assert.equal(switches[0].args[0], 'remote:server-a:runtime-new');

    const finished = callsOf(ctx, 'finishSidebarOperation');
    assert.equal(finished.length, 1);
    assert.equal(finished[0].args[0], 'op-create-1');
    assert.equal(finished[0].args[1], 'settled');
  });

  it('create failure surfaces explicitly: alert + failed operation, no switch, no retry', async () => {
    const requests = [];
    const ctx = createSandbox({ requests, createOk: false, createStatus: 403 });
    await ctx.run(`window.runWorkspaceAction(JSON.stringify({
      type: 'create_session',
      openDirectory: '/srv/project-c',
      agentId: 'remote:server-a:programming-helper',
    }))`);

    const postCalls = requests.filter((r) => r.init?.method === 'POST');
    assert.equal(postCalls.length, 1, 'single attempt — no silent retry');

    const alerts = callsOf(ctx, 'alert');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].args[0], 'Session failed: workspace_create_denied');

    const finished = callsOf(ctx, 'finishSidebarOperation');
    assert.equal(finished.length, 1);
    assert.equal(finished[0].args[0], 'op-create-1');
    assert.equal(finished[0].args[1], 'failed');
    assert.equal(finished[0].args[2].errorCode, 'session_create_failed');
    assert.equal(callsOf(ctx, 'requestSwitch').length, 0, 'no switch after failure');
  });

  it('missing project directory fails explicitly before any request', async () => {
    const requests = [];
    const ctx = createSandbox({ requests });
    await ctx.run(`window.runWorkspaceAction(JSON.stringify({
      type: 'create_session',
      agentId: 'remote:server-a:programming-helper',
    }))`);

    assert.equal(requests.filter((r) => r.init?.method === 'POST').length, 0, 'no request without a directory identity');
    const alerts = callsOf(ctx, 'alert');
    assert.equal(alerts.length, 1);
    assert.ok(alerts[0].args[0].includes('缺少创建会话所需的项目目录'));
    assert.equal(callsOf(ctx, 'beginSidebarOperation').length, 0);
    assert.equal(callsOf(ctx, 'finishSidebarOperation').length, 0);
  });
});
