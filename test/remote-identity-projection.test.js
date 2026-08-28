import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createConnectedAgentsQuery } from '../server/routes/agent-connected.js';
import { managedAgents } from '../server/shared/agent-access.js';

// ── Fixtures ─────────────────────────────────────────────────────────────

// getAgentsLight 条目：声明 coder 为独立侧栏身份（identities[].sidebarEntry）。
function phAgentLight() {
  return {
    id: 'programming-helper',
    name: '智能编码空间',
    kind: 'agent',
    status: { pid: null, viewerAgentId: null },
    identities: [
      { id: 'main' },
      { id: 'coder', sessionType: 'coder', sidebarEntry: true, displayName: 'Coder' },
    ],
  };
}

// CatalogAggregator 输出形状的远程目录快照：在线连接中宿主下的 coder 存活会话。
function remoteCatalog({ status = 'connected', entrySessionTypes = ['coder'] } = {}) {
  return {
    connections: [{
      connectionId: 'server-a',
      name: '开发服务器',
      status,
      workspaces: [{
        projectName: '开发服务器：proj-x',
        entries: entrySessionTypes.map((sessionType, index) => ({
          id: `remote:server-a:runtime-${index}`,
          agentId: 'remote:server-a:programming-helper',
          runtimeId: `remote:server-a:runtime-${index}`,
          sessionType,
        })),
      }],
    }],
  };
}

function createQuery({ readRemoteCatalog } = {}) {
  return createConnectedAgentsQuery({
    getAgentsLight: async () => [phAgentLight()],
    readActiveWorkspaceSessionMeta: async () => ({
      workspaceSessions: { sessions: [] },
      sessionMeta: {},
    }),
    readWorkspaceSessionMeta: async () => ({}),
    readViewerJson: async (pathname) => (pathname === '/api/agents' ? { agents: [] } : {}),
    getPendingInputCount: async () => 0,
    resolveAgentModelPresets: async () => ({}),
    ...(readRemoteCatalog ? { readRemoteCatalog } : {}),
  });
}

function projectionOf(list, id) {
  return list.find((entry) => entry.source === 'prebuilt' && entry.id === id) || null;
}

// 本地 managed coder 进程（hasLiveSession 的 managedAgents 来源）。
function spawnLocalCoderRuntime() {
  managedAgents.set('test-coder', {
    id: 'programming-helper',
    agentId: 'programming-helper',
    sessionType: 'coder',
    selectedSessionId: null,
    viewerAgentId: null,
    process: { exitCode: null, pid: 424242 },
    stopped: false,
    stopping: false,
  });
}

afterEach(() => {
  managedAgents.clear();
});

// ── 远程身份合成 ─────────────────────────────────────────────────────────

describe('get_connected_agents 投影条目的远程存活来源', () => {
  it('coder 只在远程主机运行时，投影条目由远程 catalog 快照合成', async () => {
    const { getConnectedAgents } = createQuery({
      readRemoteCatalog: async () => remoteCatalog(),
    });

    const list = await getConnectedAgents();
    const projection = projectionOf(list, 'programming-helper:coder');
    assert.ok(projection, '远程 coder 存活时应合成投影条目');
    assert.equal(projection.agentId, 'programming-helper');
    assert.equal(projection.sessionType, 'coder');
    assert.equal(projection.name, 'Coder');
    // 会话级字段不继承：投影条目是身份承载入口，不是会话镜像。
    assert.equal(projection.runtime_session_id, undefined);
    assert.equal(projection.workspace_sessions, undefined);
  });

  it('远程只有 main 会话时不合成 coder 投影条目', async () => {
    const { getConnectedAgents } = createQuery({
      readRemoteCatalog: async () => remoteCatalog({ entrySessionTypes: ['main'] }),
    });

    const list = await getConnectedAgents();
    assert.equal(projectionOf(list, 'programming-helper:coder'), null);
  });

  it('非 connected 分节的条目不作为合成依据', async () => {
    const { getConnectedAgents } = createQuery({
      readRemoteCatalog: async () => remoteCatalog({ status: 'disconnected' }),
    });

    const list = await getConnectedAgents();
    assert.equal(projectionOf(list, 'programming-helper:coder'), null);
  });

  it('远程目录读取失败时按无远程数据降级，不影响本地语义', async () => {
    const { getConnectedAgents } = createQuery({
      readRemoteCatalog: async () => {
        throw new Error('catalog unavailable');
      },
    });

    const list = await getConnectedAgents();
    assert.equal(projectionOf(list, 'programming-helper:coder'), null);
    assert.ok(list.some((entry) => entry.id === 'programming-helper'), '宿主条目不受影响');
  });

  it('未注入 readRemoteCatalog 时保持旧行为', async () => {
    const { getConnectedAgents } = createQuery();

    const list = await getConnectedAgents();
    assert.equal(projectionOf(list, 'programming-helper:coder'), null);
  });

  it('本地 coder 进程存活时合成不依赖远程目录（原路径回归）', async () => {
    spawnLocalCoderRuntime();
    const { getConnectedAgents } = createQuery();

    const list = await getConnectedAgents();
    assert.ok(projectionOf(list, 'programming-helper:coder'), '本地存活路径仍生效');
  });

  it('本地与远程同时存活时只合成一个投影条目', async () => {
    spawnLocalCoderRuntime();
    const { getConnectedAgents } = createQuery({
      readRemoteCatalog: async () => remoteCatalog(),
    });

    const list = await getConnectedAgents();
    const projections = list.filter((entry) => entry.id === 'programming-helper:coder');
    assert.equal(projections.length, 1);
  });
});
