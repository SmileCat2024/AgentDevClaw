import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createCatalogAggregator } from '../server/remote-connections/catalog-aggregator.js';

const silentLogger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };

function connection(overrides = {}) {
  return {
    id: 'server-a',
    name: '开发服务器',
    enabled: true,
    mode: 'manual',
    localPort: 22101,
    ssh: null,
    remote: { appPort: 1420 },
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// 挂起端点：尊重 AbortSignal，超时触发 abort 后立即拒绝（与真实 fetch 语义一致）。
function hanging() {
  return (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
  });
}

// 远程 Claw 的目录端点组合（以真实端点返回结构为蓝本）：
// get_connected_agents / get_prebuilt_agents → 数组；/api/agents → { agents: [] }。
function remoteRoutes(spec = {}) {
  const origin = `http://127.0.0.1:${spec.port}`;
  return {
    [`${origin}/protoclaw/get_connected_agents`]: spec.connected instanceof Function
      ? spec.connected
      : () => jsonResponse(spec.connected ?? []),
    [`${origin}/protoclaw/get_prebuilt_agents`]: spec.prebuilt instanceof Function
      ? spec.prebuilt
      : () => jsonResponse(spec.prebuilt ?? []),
    [`${origin}/api/agents`]: spec.viewer instanceof Function
      ? spec.viewer
      : () => jsonResponse(spec.viewer ?? { agents: [] }),
  };
}

function createHarness({
  connections = [connection()],
  routes = {},
  healthByConnection = { 'server-a': { state: 'connected' } },
  timeoutMs = 200,
} = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(String(url));
    const handler = routes[String(url)];
    if (!handler) throw new Error(`unexpected url: ${url}`);
    return handler(new URL(String(url)), options);
  };
  const aggregator = createCatalogAggregator({
    fetch: fetchImpl,
    listConnections: async () => connections,
    getStatus: (id) => healthByConnection[id] || null,
    timeoutMs,
    logger: silentLogger,
  });
  return { aggregator, calls };
}

function phAgent(overrides = {}) {
  return {
    id: 'programming-helper',
    name: '编程小助手',
    description: 'AI 编程助手',
    icon: 'code',
    launchMode: null,
    source: 'prebuilt',
    status: 'running',
    workspace_sessions: {
      activeSessionId: 'sess-c1',
      sessions: [
        {
          id: 'sess-c1',
          title: '修复登录',
          sessionType: 'main',
          openDirectory: 'D:\\code\\project-c',
          updatedAt: '2026-08-26T10:00:00.000Z',
          messageCount: 5,
        },
        {
          id: 'sess-d1',
          title: '重构模块',
          sessionType: 'main',
          openDirectory: '/home/dev/project-d',
          updatedAt: '2026-08-26T11:00:00.000Z',
        },
      ],
    },
    ...overrides,
  };
}

function qqbotAgent() {
  return {
    id: 'qqbot',
    name: 'IM 渠道',
    source: 'prebuilt',
    status: 'stopped',
    workspace_sessions: { activeSessionId: null, sessions: [] },
  };
}

function sectionOf(result, connectionId) {
  const matched = result.connections.find((item) => item.connectionId === connectionId);
  assert.ok(matched, `缺少连接分节：${connectionId}`);
  return matched;
}

function workspaceOf(section, projectName) {
  const matched = section.workspaces.find((item) => item.projectName === projectName);
  assert.ok(matched, `缺少工作空间分组：${projectName}`);
  return matched;
}

describe('多工作空间聚合与命名空间化', () => {
  it('按 openDirectory 叶段分多组，无目录会话的 agent 以自身 id 回退成组', async () => {
    const { aggregator, calls } = createHarness({
      routes: remoteRoutes({
        port: 22101,
        connected: [phAgent(), qqbotAgent()],
        prebuilt: [phAgent(), qqbotAgent()],
      }),
    });

    const result = await aggregator.aggregate();

    const section = sectionOf(result, 'server-a');
    assert.equal(section.status, 'connected');
    assert.deepEqual(section.workspaces.map((ws) => ws.groupKey), [
      'remote:server-a:project-c',
      'remote:server-a:project-d',
      'remote:server-a:qqbot',
    ]);
    assert.deepEqual(section.workspaces.map((ws) => ws.displayName), [
      '开发服务器：project-c',
      '开发服务器：project-d',
      '开发服务器：qqbot',
    ]);

    const projectC = workspaceOf(section, 'project-c');
    assert.deepEqual(projectC.entries.map((entry) => entry.id), [
      'remote:server-a:programming-helper',
      'remote:server-a:sess-c1',
    ]);
    const [agentEntry, sessionEntry] = projectC.entries;
    assert.equal(agentEntry.kind, 'agent');
    assert.equal(agentEntry.agentId, 'remote:server-a:programming-helper');
    assert.equal(agentEntry.name, '编程小助手');
    assert.equal(agentEntry.icon, 'code');
    assert.equal(agentEntry.status, 'running');
    assert.equal(sessionEntry.kind, 'session');
    assert.equal(sessionEntry.agentId, 'remote:server-a:programming-helper');
    assert.equal(sessionEntry.name, '修复登录');
    assert.equal(sessionEntry.sessionType, 'main');
    assert.equal(sessionEntry.messageCount, 5);

    // qqbot 无目录会话：回退组内是 agent 条目本身。
    const qqbot = workspaceOf(section, 'qqbot');
    assert.deepEqual(qqbot.entries.map((entry) => entry.id), ['remote:server-a:qqbot']);
    assert.equal(qqbot.entries[0].kind, 'agent');

    // 每条 connected 连接拉取三个目录端点，经其 origin（127.0.0.1:localPort）。
    assert.deepEqual(calls.map((url) => new URL(url).pathname).sort(), [
      '/api/agents',
      '/protoclaw/get_connected_agents',
      '/protoclaw/get_prebuilt_agents',
    ]);
    assert.ok(calls.every((url) => url.startsWith('http://127.0.0.1:22101/')));
    // 前端可见 ID 全部命名空间化：以 remote:server-a: 开头。
    for (const ws of section.workspaces) {
      for (const entry of ws.entries) {
        assert.ok(entry.id.startsWith('remote:server-a:'), `未命名空间化的 ID：${entry.id}`);
      }
    }
  });

  it('会话排序按 updatedAt 倒序，平局以 id 兜底', async () => {
    const agent = phAgent({
      workspace_sessions: {
        activeSessionId: null,
        sessions: [
          { id: 'sess-old', title: '旧会话', sessionType: 'main', openDirectory: 'D:\\code\\project-c', updatedAt: '2026-08-01T00:00:00.000Z' },
          { id: 'sess-new', title: '新会话', sessionType: 'coder', openDirectory: 'D:\\code\\project-c', updatedAt: '2026-08-26T00:00:00.000Z' },
        ],
      },
    });
    const { aggregator } = createHarness({
      routes: remoteRoutes({ port: 22101, connected: [agent] }),
    });

    const section = sectionOf(await aggregator.aggregate(), 'server-a');
    const projectC = workspaceOf(section, 'project-c');
    assert.deepEqual(projectC.entries.map((entry) => entry.id), [
      'remote:server-a:programming-helper',
      'remote:server-a:sess-new',
      'remote:server-a:sess-old',
    ]);
    assert.equal(projectC.entries[1].sessionType, 'coder');
  });
});

describe('同项目名跨连接不串组', () => {
  it('相同 projectName 在不同连接下生成不同 groupKey 与 displayName', async () => {
    const routes = {
      ...remoteRoutes({ port: 22101, connected: [phAgent()] }),
      ...remoteRoutes({
        port: 22102,
        connected: [phAgent({
          name: '远程编程助手',
          workspace_sessions: {
            activeSessionId: 'sess-c1',
            sessions: [{ id: 'sess-c1', title: '另一台机器的会话', sessionType: 'main', openDirectory: '/srv/project-c', updatedAt: '2026-08-26T12:00:00.000Z' }],
          },
        })],
      }),
    };
    const { aggregator } = createHarness({
      connections: [connection(), connection({ id: 'server-b', name: '备份服务器', localPort: 22102 })],
      healthByConnection: {
        'server-a': { state: 'connected' },
        'server-b': { state: 'connected' },
      },
      routes,
    });

    const result = await aggregator.aggregate();
    const groupKeys = result.connections.flatMap((section) => section.workspaces.map((ws) => ws.groupKey));
    assert.deepEqual(groupKeys.sort(), [
      'remote:server-a:project-c',
      'remote:server-a:project-d',
      'remote:server-b:project-c',
    ]);
    assert.equal(new Set(groupKeys).size, groupKeys.length);

    const a = workspaceOf(sectionOf(result, 'server-a'), 'project-c');
    const b = workspaceOf(sectionOf(result, 'server-b'), 'project-c');
    assert.equal(a.displayName, '开发服务器：project-c');
    assert.equal(b.displayName, '备份服务器：project-c');
    assert.equal(a.entries[1].id, 'remote:server-a:sess-c1');
    assert.equal(b.entries[1].id, 'remote:server-b:sess-c1');
  });
});

describe('连接断开语义', () => {
  it('断开连接保留分节与状态、不拉取、不伪造数据；其他连接不受影响', async () => {
    const routes = {
      ...remoteRoutes({
        port: 22101,
        connected: [phAgent(), qqbotAgent()],
        prebuilt: [phAgent(), qqbotAgent()],
      }),
      ...remoteRoutes({ port: 22102, connected: [qqbotAgent()] }),
    };
    const { aggregator, calls } = createHarness({
      connections: [connection(), connection({ id: 'server-b', name: '备份服务器', localPort: 22102 })],
      healthByConnection: {
        'server-a': { state: 'connected' },
        'server-b': {
          state: 'disconnected',
          error: { code: 'transport_unavailable', message: '隧道/网络不可达（ECONNREFUSED）', retryable: true },
        },
      },
      routes,
    });

    const result = await aggregator.aggregate();

    const b = sectionOf(result, 'server-b');
    assert.equal(b.status, 'disconnected');
    assert.deepEqual(b.workspaces, []);
    assert.deepEqual(b.error, { code: 'transport_unavailable', message: '隧道/网络不可达（ECONNREFUSED）', retryable: true });

    // 断开连接不发起任何远程请求；健康连接照常拉取。
    assert.ok(calls.every((url) => !url.startsWith('http://127.0.0.1:22102/')));
    assert.equal(calls.length, 3);

    const a = sectionOf(result, 'server-a');
    assert.equal(a.status, 'connected');
    assert.equal(a.workspaces.length, 3);
  });

  it('健康状态未知（尚未跟踪）的连接标记 configured，不拉取', async () => {
    const { aggregator, calls } = createHarness({
      healthByConnection: {},
      routes: remoteRoutes({ port: 22101 }),
    });

    const section = sectionOf(await aggregator.aggregate(), 'server-a');
    assert.equal(section.status, 'configured');
    assert.deepEqual(section.workspaces, []);
    assert.equal(calls.length, 0);
  });
});

describe('单连接超时降级', () => {
  it('挂起连接在独立超时后降级返回，不阻塞其他连接', async () => {
    const routes = {
      ...remoteRoutes({
        port: 22101,
        connected: hanging(),
        prebuilt: hanging(),
        viewer: hanging(),
      }),
      ...remoteRoutes({ port: 22102, connected: [qqbotAgent()] }),
    };
    const { aggregator } = createHarness({
      connections: [connection(), connection({ id: 'server-b', name: '备份服务器', localPort: 22102 })],
      healthByConnection: {
        'server-a': { state: 'connected' },
        'server-b': { state: 'connected' },
      },
      routes,
      timeoutMs: 60,
    });

    const startedAt = Date.now();
    const result = await aggregator.aggregate();
    const elapsed = Date.now() - startedAt;

    const a = sectionOf(result, 'server-a');
    assert.equal(a.status, 'degraded');
    assert.deepEqual(a.workspaces, []);
    assert.equal(a.error.code, 'request_timeout');
    assert.equal(a.error.retryable, true);

    const b = sectionOf(result, 'server-b');
    assert.equal(b.status, 'connected');
    assert.equal(b.workspaces.length, 1);

    // 整体响应被该连接的独立超时所界定（放宽 slack 防 CI 抖动）。
    assert.ok(elapsed < 600, `整体响应耗时 ${elapsed}ms 超出独立超时量级`);
  });
});

describe('以远程实际返回为准组合', () => {
  it('部分端点失败时按其余返回继续组合，连接不降级', async () => {
    const { aggregator } = createHarness({
      routes: remoteRoutes({
        port: 22101,
        connected: [phAgent()],
        prebuilt: () => jsonResponse({ error: 'boom' }, 500),
      }),
    });

    const section = sectionOf(await aggregator.aggregate(), 'server-a');
    assert.equal(section.status, 'connected');
    assert.equal(section.workspaces.length, 2);
    // 元数据端点失败时，agent 条目以 connected 返回的名称为准。
    const projectC = workspaceOf(section, 'project-c');
    assert.equal(projectC.entries[0].name, '编程小助手');
    assert.equal(projectC.entries[0].icon, undefined);
  });

  it('protoclaw 目录端点均失败时以 /api/agents 降级组合', async () => {
    const { aggregator } = createHarness({
      routes: remoteRoutes({
        port: 22101,
        connected: () => jsonResponse({ error: 'boom' }, 500),
        prebuilt: () => jsonResponse({ error: 'boom' }, 500),
        viewer: { agents: [{ id: 'runtime-x', name: '外部 Runtime', connected: true }] },
      }),
    });

    const section = sectionOf(await aggregator.aggregate(), 'server-a');
    assert.equal(section.status, 'connected');
    assert.deepEqual(section.workspaces.map((ws) => ws.groupKey), ['remote:server-a:runtime-x']);
    assert.equal(section.workspaces[0].entries[0].id, 'remote:server-a:runtime-x');
    assert.equal(section.workspaces[0].entries[0].status, 'running');
  });

  it('全部端点失败时连接降级为 operation_rejected', async () => {
    const { aggregator } = createHarness({
      routes: remoteRoutes({
        port: 22101,
        connected: () => jsonResponse({ error: 'boom' }, 500),
        prebuilt: () => jsonResponse({ error: 'boom' }, 500),
        viewer: () => jsonResponse({ error: 'boom' }, 500),
      }),
    });

    const section = sectionOf(await aggregator.aggregate(), 'server-a');
    assert.equal(section.status, 'degraded');
    assert.deepEqual(section.workspaces, []);
    assert.equal(section.error.code, 'operation_rejected');
  });
});

describe('不缓存远程目录数据', () => {
  it('每次聚合都重新拉取远程真值', async () => {
    const { aggregator, calls } = createHarness({
      routes: remoteRoutes({ port: 22101, connected: [phAgent()] }),
    });

    const first = await aggregator.aggregate();
    assert.equal(calls.length, 3);

    const second = await aggregator.aggregate();
    assert.equal(calls.length, 6);
    assert.deepEqual(second, first);
  });
});

describe('disabled 连接与空列表', () => {
  it('enabled=false 的连接不进入聚合结果', async () => {
    const { aggregator, calls } = createHarness({
      connections: [connection({ enabled: false })],
      routes: remoteRoutes({ port: 22101 }),
    });

    const result = await aggregator.aggregate();
    assert.deepEqual(result.connections, []);
    assert.equal(calls.length, 0);
  });

  it('无连接时返回空列表', async () => {
    const { aggregator } = createHarness({ connections: [] });
    assert.deepEqual(await aggregator.aggregate(), { connections: [] });
  });
});
