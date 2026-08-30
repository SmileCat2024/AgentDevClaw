/**
 * remoteOnly 守卫迁移到能力矩阵（batch9/r2-guard-migration）。
 *
 * Covers (vm sandbox, no real network):
 *   1. phSwitchProject 门控迁移：视图切换 / 本地工作区切换的路由由项目
 *      本地宿主身份 + window.RemoteConnections.capabilityFor（签名
 *      (agentId, action) → boolean）决定
 *   2. 语义保持（ADR-0012 决策 1）：remoteOnly 桶（目录仅存在于远程主机）
 *      无论握手能力与否都只做 surface 视图切换，不触发本地
 *      ph_project/switch——本地切换写的是本机工作区，真本地事实优先于能力位
 *   3. 本地回归：本地项目照常本地切换；集成期无 capabilityFor 时行为不变；
 *      未知项目 id 保持既有 fall-through 路由
 *
 * Identity discipline (ADR-0012): 集成期依赖——capabilityFor 以 stub 注入；
 * remoteOnly 桶由真实 remote-connections.js + project-data.js 数据层合成，
 * 不在测试里手造标记。
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
  activeSessionId: null,
  sessions: [
    { id: 'session-hist-1', title: '远程历史 A', updatedAt: '2026-08-30T09:00:00.000Z', openDirectory: '/srv/project-c' },
    { id: 'session-hist-2', title: '远程历史 B', updatedAt: '2026-08-29T10:00:00.000Z', openDirectory: '/srv/project-c' },
  ],
};

const LOCAL_PROJECT_ID = 'dir:d:/proj-a';
const REMOTE_ONLY_PROJECT_ID = 'dir:/srv/project-c';

function guardSandbox({ requests = [] } = {}) {
  const ctx = createFrontendSandbox({
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      const path = String(url).split('?')[0];
      if (path === '/protoclaw/remote_catalog') {
        return { ok: true, status: 200, json: async () => CATALOG };
      }
      if (path === '/protoclaw/prebuilt_sessions') {
        return { ok: true, status: 200, json: async () => REMOTE_HISTORY };
      }
      if (path === '/protoclaw/ph_project/switch') {
        return { ok: true, status: 200, json: async () => ({ state: { openDirectory: 'D:/proj-a', forms: {} } }) };
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
  // ph-project-actions.js / project-data.js 的全局依赖以最小替身注入。
  ctx.run(`
    var currentLanguage = 'zh';
    var lastRenderedWorkspaceHtml = '';
    var phSearchQuery = '';
    var phSearchResults = null;
    var phSearchLoading = false;
    var _phSearchTimer = null;
    var renderCurrentMainView = function () {};
    var __phAgent = {
      id: 'programming-helper',
      source: 'prebuilt',
      workspace_state: { openDirectory: 'D:/proj-a', forms: {}, phProjects: [] },
      workspace_sessions: { activeSessionId: 'session-local', sessions: [
        { id: 'session-local', title: '本地会话', openDirectory: 'D:/proj-a', updatedAt: '2026-08-30T12:00:00.000Z' },
      ] },
    };
    var getCurrentAgentRecord = function () { return __phAgent; };
    function isPhStyleWorkspaceAgent(agent) {
      return !!(agent && agent.source === 'prebuilt' && agent.id === 'programming-helper');
    }
    var getWorkspaceSessions = function (agent) {
      return Array.isArray(agent?.workspace_sessions?.sessions) ? agent.workspace_sessions.sessions : [];
    };
    var getAgentWorkspaceState = function (agent) {
      return agent?.workspace_state && typeof agent.workspace_state === 'object'
        ? agent.workspace_state
        : { forms: {}, openDirectory: '', updatedAt: null };
    };
  `);
  ctx.loadSource('public/src/modules/project-data.js');
  ctx.loadSource('public/src/modules/ph-project-actions.js');
  return { ctx, requests };
}

async function refreshRemoteHistory(ctx) {
  await ctx.window.RemoteConnections.refresh();
  await ctx.run('window.RemoteConnections.maybeRefreshRemoteHistory()');
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// 集成期依赖：capabilityFor 由并行工单在 remote-connections.js 实现，
// 测试按契约签名 (agentId, action) → boolean stub。
function stubCapability(ctx, result) {
  ctx.run(`
    window.__capabilityCalls = [];
    window.__capabilityResult = ${result};
    window.RemoteConnections.capabilityFor = function (agentId, action) {
      window.__capabilityCalls.push({ agentId: agentId, action: action });
      return window.__capabilityResult;
    };
  `);
}

function switchCalls(requests) {
  return requests.filter((r) => r.url === '/protoclaw/ph_project/switch');
}

describe('phSwitchProject capability guard migration (remoteOnly → capabilityFor)', () => {
  it('remoteOnly bucket stays view-only even when the handshake grants write', async () => {
    const requests = [];
    const { ctx } = guardSandbox({ requests });
    await refreshRemoteHistory(ctx);
    stubCapability(ctx, 'true');

    await ctx.run(`window.phSwitchProject('${REMOTE_ONLY_PROJECT_ID}')`);

    // 本地 ph_project/switch 会把本机工作区切到远程路径（错误语义）——
    // 宿主写能力为 true 也不改变视图切换路由（真本地事实，非能力位）。
    assert.equal(switchCalls(requests).length, 0, 'no local workspace switch for remote-only bucket');
    assert.equal(
      ctx.run('window.ClawFW.phSurfaceViewProjectId'),
      REMOTE_ONLY_PROJECT_ID,
      'surface view override marks the remote-only bucket',
    );
  });

  it('remoteOnly bucket stays view-only when the write capability is denied', async () => {
    const requests = [];
    const { ctx } = guardSandbox({ requests });
    await refreshRemoteHistory(ctx);
    stubCapability(ctx, 'false');

    await ctx.run(`window.phSwitchProject('${REMOTE_ONLY_PROJECT_ID}')`);

    assert.equal(switchCalls(requests).length, 0, 'no local workspace switch for remote-only bucket');
    assert.equal(ctx.run('window.ClawFW.phSurfaceViewProjectId'), REMOTE_ONLY_PROJECT_ID);
  });

  it('local project switches the local workspace when the host write capability is available', async () => {
    const requests = [];
    const { ctx } = guardSandbox({ requests });
    await refreshRemoteHistory(ctx);
    stubCapability(ctx, 'true');

    await ctx.run(`window.phSwitchProject('${LOCAL_PROJECT_ID}')`);

    const calls = switchCalls(requests);
    assert.equal(calls.length, 1, 'exactly one local workspace switch');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      agentId: 'programming-helper',
      projectId: LOCAL_PROJECT_ID,
    });
    assert.equal(ctx.run('window.ClawFW ? window.ClawFW.phSurfaceViewProjectId : null'), null, 'no view override for local project');
    // 门控查询按契约签名走本地宿主身份。
    const capabilityCalls = JSON.parse(ctx.run('JSON.stringify(window.__capabilityCalls)'));
    assert.deepEqual(capabilityCalls, [{ agentId: 'programming-helper', action: 'write' }]);
  });

  it('legacy parity: without RemoteConnections.capabilityFor local switching still works and remoteOnly stays view-only', async () => {
    const requests = [];
    const { ctx } = guardSandbox({ requests });
    await refreshRemoteHistory(ctx);
    // 不 stub capabilityFor（集成期前模块未提供该函数）。

    await ctx.run(`window.phSwitchProject('${LOCAL_PROJECT_ID}')`);
    assert.equal(switchCalls(requests).length, 1, 'local project keeps switching locally');

    await ctx.run(`window.phSwitchProject('${REMOTE_ONLY_PROJECT_ID}')`);
    assert.equal(switchCalls(requests).length, 1, 'remote-only bucket never reaches the local switch');
    assert.equal(ctx.run('window.ClawFW.phSurfaceViewProjectId'), REMOTE_ONLY_PROJECT_ID);
  });

  it('unknown project id keeps the legacy fall-through to the local switch endpoint', async () => {
    const requests = [];
    const { ctx } = guardSandbox({ requests });
    await refreshRemoteHistory(ctx);
    stubCapability(ctx, 'true');

    await ctx.run(`window.phSwitchProject('dir:/nowhere')`);

    const calls = switchCalls(requests);
    assert.equal(calls.length, 1, 'unknown id falls through to the switch endpoint (server rejects)');
    assert.equal(JSON.parse(calls[0].init.body).projectId, 'dir:/nowhere');
    assert.equal(ctx.run('window.ClawFW ? window.ClawFW.phSurfaceViewProjectId : null'), null);
  });
});
