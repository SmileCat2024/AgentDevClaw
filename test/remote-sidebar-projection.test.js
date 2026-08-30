import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCatalogAggregator } from '../server/remote-connections/catalog-aggregator.js';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function loadRemoteModule(payload) {
  let renderCount = 0;
  const ctx = createFrontendSandbox({
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => payload,
    }),
    renderAgentList: () => { renderCount += 1; },
    t: (key) => key,
    escapeHtml: (value) => String(value ?? ''),
    isRemoteNamespaceAgentId: (value) => String(value || '').startsWith('remote:'),
    currentRuntimeAgentId: null,
    allAgents: [],
  });
  ctx.loadSource('public/src/modules/remote-connections.js');
  return { ctx, getRenderCount: () => renderCount };
}

function connectedCatalog() {
  return {
    connections: [{
      connectionId: 'server-a',
      name: 'Lab-B',
      status: 'connected',
      workspaces: [{
        groupKey: 'remote:server-a:programming-helper:%2Fsrv%2Fproject-c',
        displayName: 'Lab-B：project-c',
        projectName: 'Lab-B：project-c',
        projectDir: '/srv/project-c',
        entries: [
          {
            id: 'remote:server-a:runtime-main',
            runtimeId: 'remote:server-a:runtime-main',
            agentId: 'remote:server-a:programming-helper',
            sidebarEntryId: 'programming-helper',
            sessionType: 'main',
            sessionId: 'remote:server-a:session-main',
            name: '主会话',
            kind: 'runtime',
          },
          {
            id: 'remote:server-a:runtime-coder',
            runtimeId: 'remote:server-a:runtime-coder',
            agentId: 'remote:server-a:programming-helper',
            sidebarEntryId: 'programming-helper:coder',
            sessionType: 'coder',
            sessionId: 'remote:server-a:session-coder',
            name: 'Coder 会话',
            kind: 'runtime',
          },
        ],
      }],
    }],
  };
}

function aggregatorHarness(connected) {
  const origin = 'http://127.0.0.1:22101';
  const routes = {
    [`${origin}/protoclaw/get_connected_agents`]: async () => ({
      ok: true,
      status: 200,
      json: async () => connected,
    }),
    [`${origin}/api/agents`]: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ agents: [] }),
    }),
  };
  return createCatalogAggregator({
    fetch: async (url, options) => routes[String(url)](url, options),
    listConnections: async () => [{ id: 'server-a', name: 'Lab-B', enabled: true, localPort: 22101 }],
    getStatus: () => ({ state: 'connected' }),
    logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
  });
}

describe('remote sidebar catalog round-trip', () => {
  it('passes the real aggregator output directly into the frontend projection', async () => {
    const aggregator = aggregatorHarness([
      {
        id: 'runtime-main',
        source: 'child',
        status: 'running',
        connected: true,
        parent_id: 'programming-helper',
        sessionType: 'main',
        runtime_session_id: 'runtime-main',
        open_directory: '/srv/project-c',
        active_workspace_session_id: 'session-main',
        active_workspace_session_title: '主会话',
        active_workspace_display_name: '编程小助手',
        updated_at: '2026-08-27T10:00:00.000Z',
      },
      {
        id: 'runtime-coder',
        source: 'child',
        status: 'running',
        connected: true,
        parent_id: 'programming-helper',
        sessionType: 'coder',
        runtime_session_id: 'runtime-coder',
        open_directory: '/srv/project-c',
        active_workspace_session_id: 'session-coder',
        active_workspace_session_title: 'Coder 会话',
        active_workspace_display_name: '编程小助手',
        updated_at: '2026-08-27T11:00:00.000Z',
      },
    ]);
    const catalog = await aggregator.aggregate();
    const { ctx } = loadRemoteModule(catalog);
    await ctx.window.RemoteConnections.refresh();

    const main = ctx.run('getRemoteSidebarProjection("programming-helper", "programming-helper")');
    const coder = ctx.run('getRemoteSidebarProjection("programming-helper", "programming-helper:coder")');
    assert.equal(main.length, 1);
    assert.equal(coder.length, 1);
    assert.equal(main[0].runtimeId, 'remote:server-a:runtime-main');
    assert.equal(main[0].sessionId, 'remote:server-a:session-main');
    assert.equal(coder[0].runtimeId, 'remote:server-a:runtime-coder');
    assert.equal(coder[0].sessionId, 'remote:server-a:session-coder');
    assert.equal(coder[0].sidebarEntryId, 'programming-helper:coder');
    assert.equal(coder[0].projectName, 'Lab-B：project-c');
    assert.equal(coder[0].projectKey, main[0].projectKey);
  });

  it('keeps project, identity, session, and runtime ownership through the real frontend projection', async () => {
    const { ctx, getRenderCount } = loadRemoteModule(connectedCatalog());
    await ctx.window.RemoteConnections.refresh();

    const main = ctx.run('getRemoteSidebarProjection("programming-helper", "programming-helper")');
    const coder = ctx.run('getRemoteSidebarProjection("programming-helper", "programming-helper:coder")');

    assert.equal(getRenderCount(), 1);
    assert.equal(main.length, 1);
    assert.equal(coder.length, 1);

    assert.equal(main[0].runtimeId, 'remote:server-a:runtime-main');
    assert.equal(main[0].sessionId, 'remote:server-a:session-main');
    assert.equal(main[0].ownerId, 'programming-helper');
    assert.equal(main[0].sidebarEntryId, 'programming-helper');
    assert.equal(main[0].projectKey, 'remote:server-a:programming-helper:%2Fsrv%2Fproject-c');
    assert.equal(main[0].projectName, 'Lab-B：project-c');
    assert.equal(main[0].remoteConnectionId, 'server-a');

    assert.equal(coder[0].runtimeId, 'remote:server-a:runtime-coder');
    assert.equal(coder[0].sessionId, 'remote:server-a:session-coder');
    assert.equal(coder[0].ownerId, 'programming-helper');
    assert.equal(coder[0].sidebarEntryId, 'programming-helper:coder');
    assert.equal(coder[0].sessionType, 'coder');
    assert.equal(coder[0].projectKey, main[0].projectKey);
    assert.notEqual(coder[0].runtimeId, main[0].runtimeId);
  });

  it('keeps a directoryless runtime as a direct workspace child', async () => {
    const payload = {
      connections: [{
        connectionId: 'server-a',
        name: 'Lab-B',
        status: 'connected',
        workspaces: [{
          groupKey: 'remote:server-a:no-dir:qqbot:IM%20%E6%B8%A0%E9%81%93',
          displayName: '',
          projectName: '',
          projectDir: '',
          entries: [{
            id: 'remote:server-a:runtime-qqbot',
            runtimeId: 'remote:server-a:runtime-qqbot',
            agentId: 'remote:server-a:qqbot',
            sidebarEntryId: 'qqbot',
            sessionType: 'main',
            sessionId: 'remote:server-a:session-qqbot',
            name: 'IM 渠道',
            kind: 'runtime',
          }],
        }],
      }],
    };
    const { ctx } = loadRemoteModule(payload);
    await ctx.window.RemoteConnections.refresh();

    const projection = ctx.run('getRemoteSidebarProjection("qqbot", "qqbot")');
    assert.equal(projection.length, 1);
    assert.equal(projection[0].runtimeId, 'remote:server-a:runtime-qqbot');
    assert.equal(projection[0].sessionId, 'remote:server-a:session-qqbot');
    assert.equal(projection[0].projectName, undefined);
    assert.equal(projection[0].projectKey, undefined);
  });
});

// ── header accessor 契约（R1-09 F 项钉住） ─────────────────────────────────

describe('remote catalog header accessors', () => {
  it('getEntrySessionTitle falls back sessionTitle → name → empty string', async () => {
    const payload = {
      connections: [{
        connectionId: 'server-a',
        name: 'Lab-B',
        status: 'connected',
        workspaces: [{
          projectKey: 'k1',
          entries: [
            {
              id: 'remote:server-a:rt-titled',
              runtimeId: 'remote:server-a:rt-titled',
              agentId: 'remote:server-a:programming-helper',
              sessionTitle: '会话标题',
              name: '条目名',
            },
            {
              id: 'remote:server-a:rt-named',
              runtimeId: 'remote:server-a:rt-named',
              agentId: 'remote:server-a:programming-helper',
              name: '条目名兜底',
            },
            {
              id: 'remote:server-a:rt-bare',
              runtimeId: 'remote:server-a:rt-bare',
              agentId: 'remote:server-a:programming-helper',
            },
          ],
        }],
      }],
    };
    const { ctx } = loadRemoteModule(payload);
    await ctx.window.RemoteConnections.refresh();

    // sessionTitle 优先
    assert.equal(ctx.window.RemoteConnections.getEntrySessionTitle('remote:server-a:rt-titled'), '会话标题');
    // 无 sessionTitle → 回退 name
    assert.equal(ctx.window.RemoteConnections.getEntrySessionTitle('remote:server-a:rt-named'), '条目名兜底');
    // 两者皆无 → 空串（调用方继续回退），未知引用同样空串
    assert.equal(ctx.window.RemoteConnections.getEntrySessionTitle('remote:server-a:rt-bare'), '');
    assert.equal(ctx.window.RemoteConnections.getEntrySessionTitle('remote:ghost:rt-9'), '');
    assert.equal(ctx.window.RemoteConnections.getEntrySessionTitle(''), '');
  });

  it('getEntryRuntimeSessionId returns the namespaced session id, not the bare id', async () => {
    const { ctx } = loadRemoteModule(connectedCatalog());
    await ctx.window.RemoteConnections.refresh();

    // 已定契约（a5d54c0 复审裁决）：返回命名空间化会话 id（remote:<conn>:<sid>），
    // 不是裸 id——命名空间剥离在服务端完成，前端不做裸化。
    assert.equal(
      ctx.window.RemoteConnections.getEntryRuntimeSessionId('remote:server-a:runtime-main'),
      'remote:server-a:session-main',
    );
    assert.equal(ctx.window.RemoteConnections.getEntryRuntimeSessionId('remote:server-a:runtime-coder'), 'remote:server-a:session-coder');
    // 未命中条目 / 空 id → 空串（调用方以空串视为不可寻址）
    assert.equal(ctx.window.RemoteConnections.getEntryRuntimeSessionId('remote:ghost:rt-9'), '');
    assert.equal(ctx.window.RemoteConnections.getEntryRuntimeSessionId(''), '');
  });
});
