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
// get_connected_agents → 数组；/api/agents → { agents: [] }。
function remoteRoutes(spec = {}) {
  const origin = `http://127.0.0.1:${spec.port}`;
  return {
    [`${origin}/protoclaw/get_connected_agents`]: spec.connected instanceof Function
      ? spec.connected
      : () => jsonResponse(spec.connected ?? []),
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
  snapshotTtlMs = 0,
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
    snapshotTtlMs,
    logger: silentLogger,
  });
  return { aggregator, calls };
}

// 远程 get_connected_agents 的 child runtime 条目：运行中会话的完整身份。
function childRuntime(overrides = {}) {
  return {
    id: 'runtime-22040',
    name: '编程小助手',
    source: 'child',
    status: 'running',
    connected: true,
    parent_id: 'programming-helper',
    sessionType: 'main',
    runtime_session_id: 'runtime-22040',
    open_directory: 'D:\\code\\project-c',
    active_workspace_session_id: 'sess-c1',
    active_workspace_session_title: '修复登录',
    active_workspace_display_name: '编程小助手',
    message_count: 5,
    ...overrides,
  };
}

// 无目录的工作空间 runtime（qqbot 等）：作为对应 workspace 下的直属会话。
function noDirChildRuntime(overrides = {}) {
  return childRuntime({
    id: 'runtime-qqbot',
    name: 'IM 渠道',
    parent_id: 'qqbot',
    runtime_session_id: 'runtime-qqbot',
    open_directory: '',
    active_workspace_session_id: 'sess-q1',
    active_workspace_session_title: '',
    active_workspace_display_name: 'IM 渠道',
    ...overrides,
  });
}

function sectionOf(result, connectionId) {
  const matched = result.connections.find((item) => item.connectionId === connectionId);
  assert.ok(matched, `缺少连接分节：${connectionId}`);
  return matched;
}

function workspaceOf(section, projectName) {
  const matched = section.workspaces.find((item) =>
    item.projectName === projectName
    || item.projectName.endsWith(`：${projectName}`)
    || item.displayName === projectName
    || item.displayName.endsWith(`：${projectName}`)
  );
  assert.ok(matched, `缺少工作空间分组：${projectName}`);
  return matched;
}

describe('多工作空间聚合与命名空间化', () => {
  it('只以运行中 child runtime 生成叶子，按 open_directory 分组，无伪目录回退', async () => {
    const { aggregator, calls } = createHarness({
      routes: remoteRoutes({
        port: 22101,
        connected: [
          childRuntime(),
          childRuntime({ id: 'runtime-22041', runtime_session_id: 'runtime-22041', open_directory: '/home/dev/project-d', active_workspace_session_id: 'sess-d1', active_workspace_session_title: '重构模块' }),
          noDirChildRuntime(),
        ],
      }),
    });

    const result = await aggregator.aggregate();

    const section = sectionOf(result, 'server-a');
    assert.equal(section.status, 'connected');
    assert.deepEqual(section.workspaces.map((ws) => ws.projectName), [
      '',
      '开发服务器：project-c',
      '开发服务器：project-d',
    ]);
    assert.deepEqual(section.workspaces.map((ws) => ws.displayName), [
      '',
      '开发服务器：project-c',
      '开发服务器：project-d',
    ]);

    const projectC = workspaceOf(section, 'project-c');
    // 叶子 = runtime 会话；不再注入 agent 条目。
    assert.deepEqual(projectC.entries.map((entry) => entry.id), ['remote:server-a:runtime-22040']);
    const entry = projectC.entries[0];
    assert.equal(entry.kind, 'runtime');
    assert.equal(entry.agentId, 'remote:server-a:programming-helper');
    assert.equal(entry.runtimeId, 'remote:server-a:runtime-22040');
    assert.equal(entry.sessionId, 'remote:server-a:sess-c1');
    assert.equal(entry.name, '编程小助手');
    assert.equal(entry.sessionType, 'main');
    assert.equal(entry.messageCount, 5);
    // groupKey 含完整目录身份，杜绝同名叶目录跨分组串组。
    assert.ok(projectC.groupKey.startsWith('remote:server-a:programming-helper:D%3A%5Ccode%5Cproject-c'));

    // 无目录 runtime 回退到宿主 agent 组，组内叶子仍是 runtime 会话。
    const qqbot = section.workspaces.find((workspace) => workspace.projectName === '');
    assert.ok(qqbot, '缺少无目录 workspace 直属会话');
    assert.deepEqual(qqbot.entries.map((entry) => entry.id), ['remote:server-a:runtime-qqbot']);
    assert.equal(qqbot.entries[0].kind, 'runtime');
    assert.equal(qqbot.entries[0].agentId, 'remote:server-a:qqbot');

    // 每条 connected 连接拉取目录端点，经其 origin（127.0.0.1:localPort）。
    assert.deepEqual(calls.map((url) => new URL(url).pathname).sort(), [
      '/api/agents',
      '/protoclaw/get_connected_agents',
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
    const { aggregator } = createHarness({
      routes: remoteRoutes({
        port: 22101,
        connected: [
          childRuntime({ id: 'runtime-old', runtime_session_id: 'runtime-old', updated_at: '2026-08-01T00:00:00.000Z', open_directory: 'D:\\code\\project-c', active_workspace_session_id: 'sess-old' }),
          childRuntime({ id: 'runtime-new', runtime_session_id: 'runtime-new', updated_at: '2026-08-26T00:00:00.000Z', open_directory: 'D:\\code\\project-c', active_workspace_session_id: 'sess-new', sessionType: 'coder' }),
        ],
      }),
    });

    const section = sectionOf(await aggregator.aggregate(), 'server-a');
    const projectC = workspaceOf(section, 'project-c');
    assert.deepEqual(projectC.entries.map((entry) => entry.id), [
      'remote:server-a:runtime-new',
      'remote:server-a:runtime-old',
    ]);
    assert.equal(projectC.entries[0].sessionType, 'coder');
  });
});

describe('身份字段往返', () => {
  it('保留 connected 主源的身份、目录和寻址字段，不被 viewer 覆盖', async () => {
    const main = childRuntime({
      id: 'runtime-main',
      runtime_session_id: 'runtime-main',
      sidebar_entry_id: 'programming-helper',
      updated_at: '2026-08-27T10:00:00.000Z',
    });
    const coder = childRuntime({
      id: 'runtime-coder',
      runtime_session_id: 'runtime-coder',
      sessionType: 'coder',
      sidebar_entry_id: 'programming-helper:coder',
      active_workspace_session_id: 'coder-session',
      active_workspace_session_title: '自动修复',
      updated_at: '2026-08-27T11:00:00.000Z',
    });
    const { aggregator } = createHarness({
      routes: remoteRoutes({
        port: 22101,
        connected: [main, coder],
        viewer: {
          agents: [
            { id: 'runtime-main', name: 'viewer stale main', connected: true, parentAgentId: 'wrong-owner' },
            { id: 'runtime-coder', name: 'viewer stale coder', connected: true, parentAgentId: 'wrong-owner' },
          ],
        },
      }),
    });

    const section = sectionOf(await aggregator.aggregate(), 'server-a');
    const project = workspaceOf(section, 'project-c');
    const byType = new Map(project.entries.map((entry) => [entry.sessionType, entry]));

    assert.equal(byType.get('main').runtimeId, 'remote:server-a:runtime-main');
    assert.equal(byType.get('main').agentId, 'remote:server-a:programming-helper');
    assert.equal(byType.get('main').sidebarEntryId, 'programming-helper');
    assert.equal(byType.get('main').sessionId, 'remote:server-a:sess-c1');
    assert.equal(byType.get('main').openDirectory, String.raw`D:\code\project-c`);

    assert.equal(byType.get('coder').runtimeId, 'remote:server-a:runtime-coder');
    assert.equal(byType.get('coder').agentId, 'remote:server-a:programming-helper');
    assert.equal(byType.get('coder').sidebarEntryId, 'programming-helper:coder');
    assert.equal(byType.get('coder').sessionId, 'remote:server-a:coder-session');
    assert.equal(byType.get('coder').sessionTitle, '自动修复');
  });

  it('在缺少显式 sidebar_entry_id 时按 sessionType 推导并列身份入口', async () => {
    const { aggregator } = createHarness({
      routes: remoteRoutes({
        port: 22101,
        connected: [
          childRuntime({
            id: 'runtime-main-no-explicit-entry',
            runtime_session_id: 'runtime-main-no-explicit-entry',
            sidebar_entry_id: '',
          }),
          childRuntime({
            id: 'runtime-coder-no-explicit-entry',
            runtime_session_id: 'runtime-coder-no-explicit-entry',
            sessionType: 'coder',
            sidebar_entry_id: '',
          }),
        ],
      }),
    });

    const project = workspaceOf(sectionOf(await aggregator.aggregate(), 'server-a'), 'project-c');
    const byType = new Map(project.entries.map((entry) => [entry.sessionType, entry]));
    assert.equal(byType.get('main').sidebarEntryId, 'programming-helper');
    assert.equal(byType.get('coder').sidebarEntryId, 'programming-helper:coder');
  });
});

describe('同项目名跨连接不串组', () => {
  it('相同项目名在不同连接下生成不同 groupKey 与 displayName', async () => {
    const routes = {
      ...remoteRoutes({ port: 22101, connected: [childRuntime()] }),
      ...remoteRoutes({
        port: 22102,
        connected: [childRuntime({
          name: '远程编程助手',
          open_directory: '/srv/project-c',
          active_workspace_session_id: 'sess-c1',
          active_workspace_session_title: '另一台机器的会话',
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
    assert.equal(new Set(groupKeys).size, groupKeys.length);

    const a = workspaceOf(sectionOf(result, 'server-a'), 'project-c');
    const b = workspaceOf(sectionOf(result, 'server-b'), 'project-c');
    assert.equal(a.displayName, '开发服务器：project-c');
    assert.equal(b.displayName, '备份服务器：project-c');
    assert.equal(a.entries[0].id, 'remote:server-a:runtime-22040');
    assert.equal(b.entries[0].id, 'remote:server-b:runtime-22040');
  });
});

describe('连接断开语义', () => {
  it('断开连接保留分节与状态、不拉取、不伪造数据；其他连接不受影响', async () => {
    const routes = {
      ...remoteRoutes({
        port: 22101,
        connected: [
          childRuntime(),
          childRuntime({ id: 'runtime-22041', runtime_session_id: 'runtime-22041', open_directory: '/home/dev/project-d', active_workspace_session_id: 'sess-d1', active_workspace_session_title: '重构模块' }),
          noDirChildRuntime(),
        ],
      }),
      ...remoteRoutes({ port: 22102, connected: [noDirChildRuntime()] }),
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
    assert.equal(calls.length, 2);

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
        viewer: hanging(),
      }),
      ...remoteRoutes({ port: 22102, connected: [noDirChildRuntime()] }),
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
  it('connected 端点失败时以 /api/agents 在线 runtime 降级组合（无目录 → agent 回退组）', async () => {
    const { aggregator } = createHarness({
      routes: remoteRoutes({
        port: 22101,
        connected: () => jsonResponse({ error: 'boom' }, 500),
        viewer: { agents: [{ id: 'runtime-x', name: '外部 Runtime', connected: true, parentAgentId: 'external-agent' }] },
      }),
    });

    const section = sectionOf(await aggregator.aggregate(), 'server-a');
    assert.equal(section.status, 'connected');
    assert.deepEqual(section.workspaces.map((ws) => ws.groupKey), [
      'remote:server-a:no-dir:external-agent:%E5%A4%96%E9%83%A8%20Runtime',
    ]);
    assert.equal(section.workspaces[0].projectName, '');
    assert.equal(section.workspaces[0].displayName, '');
    assert.equal(section.workspaces[0].entries[0].id, 'remote:server-a:runtime-x');
    assert.equal(section.workspaces[0].entries[0].kind, 'runtime');
  });

  it('全部端点失败时连接降级为 operation_rejected', async () => {
    const { aggregator } = createHarness({
      routes: remoteRoutes({
        port: 22101,
        connected: () => jsonResponse({ error: 'boom' }, 500),
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
      routes: remoteRoutes({ port: 22101, connected: [childRuntime()] }),
    });

    const first = await aggregator.aggregate();
    assert.equal(calls.length, 2);

    const second = await aggregator.aggregate();
    assert.equal(calls.length, 4);
    assert.deepEqual(second, first);
  });
});

describe('TTL 快照模式（装配层显式启用）', () => {
  it('TTL 内复用快照，不重发远程请求', async () => {
    const { aggregator, calls } = createHarness({
      routes: remoteRoutes({ port: 22101, connected: [childRuntime()] }),
      snapshotTtlMs: 200,
    });

    const first = await aggregator.aggregate();
    assert.equal(calls.length, 2);

    const second = await aggregator.aggregate();
    assert.equal(calls.length, 2, 'TTL 内不应重拉');
    assert.equal(second, first, 'TTL 内返回同一快照引用');
  });

  it('invalidate 后立即透传重拉', async () => {
    const { aggregator, calls } = createHarness({
      routes: remoteRoutes({ port: 22101, connected: [childRuntime()] }),
      snapshotTtlMs: 200,
    });

    await aggregator.aggregate();
    assert.equal(calls.length, 2);

    aggregator.invalidate();
    await aggregator.aggregate();
    assert.equal(calls.length, 4, 'invalidate 后应重拉');
  });

  it('并发调用共享同一次在途拉取', async () => {
    const { aggregator, calls } = createHarness({
      routes: remoteRoutes({ port: 22101, connected: [childRuntime()] }),
      snapshotTtlMs: 200,
    });

    const [first, second] = await Promise.all([aggregator.aggregate(), aggregator.aggregate()]);
    assert.equal(calls.length, 2, '并发调用不应重复拉取');
    assert.equal(second, first);
  });

  it('在途拉取期间 invalidate：旧结果不回写快照，后续调用重新拉取', async () => {
    let releaseFetch;
    let markEntered;
    const entered = new Promise((resolve) => { markEntered = resolve; });
    const gate = new Promise((resolve) => { releaseFetch = resolve; });
    const { aggregator, calls } = createHarness({
      routes: remoteRoutes({
        port: 22101,
        connected: async () => { markEntered(); await gate; return [childRuntime()]; },
      }),
      timeoutMs: 2000,
      snapshotTtlMs: 10000,
    });

    const inFlight = aggregator.aggregate();
    await entered;
    aggregator.invalidate();
    releaseFetch();
    await inFlight;

    await aggregator.aggregate();
    assert.equal(calls.length, 4, '失效后的快照不得来自已作废的在途结果');
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