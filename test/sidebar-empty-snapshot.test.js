/**
 * 空连接快照不降级预制 Agent 身份 — 回归测试。
 *
 * 背景：loadAgents() 曾把 get_connected_agents 的一次空响应（服务端瞬时
 * 500 被 invoke 静默转译为 []）误判为"没有任何预制 Agent"，整批把侧栏
 * 条目降级为 source:'external'，丢失 sidebar_entry_id / sessionType /
 * active_workspace_* 身份字段，标题退化为工作空间名（"外部代理"分类闪现）。
 * 空快照本身只表示身份来源暂不可用，不能证明预制身份已经消失。
 *
 * 契约：一次空的 connected 快照不能降级已确认的预制 Agent 身份。
 *  - S1 稳态空快照（上一轮有 prebuilt）：保留身份投影，仅按 viewer
 *    runtime 刷新存活状态。
 *  - S2 双源皆空（connected 与 /api/agents 同时无数据）：整体保留上一轮
 *    （与网络层 throw 的 catch 路径行为对齐）。
 *  - S3 首屏无历史（首次加载即空快照）：维持既有 external 投影（显式
 *    锚定该边界，防止将来无意识改变）。
 *
 * 手法：真实 ESM 快照加载器连接 classic 宿主适配器，
 * mock invoke / fetch 数据源，驱动真实请求、合并与诊断实现。
 */

import { describe, it as nodeIt } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentSnapshotLoader } from '../public/src/modules/agent-snapshot-loader.js';
import { sanitizeSidebarDiagnosticEvent } from '../server/shared/sidebar-diagnostics.js';
import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

/**
 * 成功路径的缺键异常守卫：console 直通宿主（不静音），用例结束后只对
 * TypeError / ReferenceError / is not a function 断言——装配缺键会以这类
 * 错误出现在真实读链里，不能被 `warn(){}` / `error(){}` 吞掉。
 */
function createConsoleGuard() {
  const host = globalThis.console;
  const lines = [];
  const format = (args) => args
    .map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)))
    .join(' ');
  const recorder = {
    ...host,
    error: (...args) => { lines.push(format(args)); host.error(...args); },
    warn: (...args) => { lines.push(format(args)); host.warn(...args); },
  };
  return {
    recorder,
    lines,
    assertClean: () => {
      const offenders = lines.filter((line) => /TypeError|ReferenceError|is not a function/.test(line));
      assert.deepEqual(offenders, [], '成功路径不应出现缺键 / 引用异常');
    },
  };
}

/**
 * 用例包装：用例内建立的每个沙箱都带一个 console 守卫，用例结束（成功路径）
 * 时统一断言没有缺键 / 引用异常。守卫直通宿主 console，不静音任何输出。
 */
const pendingGuards = [];
function it(name, fn) {
  nodeIt(name, async () => {
    try {
      await fn();
      for (const guard of pendingGuards) guard.assertClean();
    } finally {
      pendingGuards.length = 0;
    }
  });
}

const richHost = () => ({
  id: 'programming-helper',
  name: '智能编码空间',
  source: 'prebuilt',
  connected: true,
  runtime_session_id: null,
  active_workspace_session_id: 'main-session',
  active_workspace_session_title: '主会话标题',
  active_workspace_display_name: '项目会话标题',
  workspace_sessions: {
    activeSessionId: 'main-session',
    sessions: [{ id: 'main-session', title: '主会话标题', sessionType: 'main' }],
  },
});

const richChild = () => ({
  id: 'rt-main',
  name: '项目会话标题',
  source: 'child',
  connected: true,
  parent_id: 'programming-helper',
  sessionType: 'main',
  sidebar_entry_id: 'programming-helper',
  runtime_session_id: 'rt-main',
  active_workspace_session_id: 'main-session',
  active_workspace_session_title: '主会话标题',
  active_workspace_display_name: '项目会话标题',
  open_directory: 'D:/code/demo',
});

const richCoderChild = () => ({
  id: 'rt-coder',
  name: 'Coder 会话',
  source: 'child',
  connected: true,
  parent_id: 'programming-helper',
  sessionType: 'coder',
  sidebar_entry_id: 'programming-helper:coder',
  runtime_session_id: 'rt-coder',
  active_workspace_session_id: 'coder-session',
  active_workspace_session_title: 'Coder 任务',
  active_workspace_display_name: 'Coder 会话',
  open_directory: 'D:/code/demo',
});

const viewerRuntime = (connected = true, id = 'rt-main') => ({
  id,
  name: id === 'rt-coder' ? 'Coder 会话' : '智能编码空间',
  connected,
  parentAgentId: 'programming-helper',
  messageCount: 3,
});

/**
 * 构造驱动生产 loadAgents() 的沙箱。
 * connectedPlan / viewerPlan 是按调用轮次出队的响应序列：
 *  - connectedPlan 项：数组 = 正常快照；null = 空快照（invoke 静默转译路径）
 *  - viewerPlan 项：数组 = /api/agents 正常返回；null = 该请求失败（ok:false）
 */
function createLoadAgentsSandbox({ connectedPlan = [], viewerPlan = [], initialAgents = null,
  focusedAgentId = 'programming-helper', currentRuntimeAgentId = 'rt-main' } = {}) {
  const renders = [];
  const diagnostics = [];
  let connectedCursor = 0;
  let viewerCursor = 0;
  let ctx;
  const guard = createConsoleGuard();
  ctx = createFrontendSandbox({
    performance: { now: () => 0 },
    console: guard.recorder,
    allAgents: initialAgents === null ? [richHost(), richChild()] : initialAgents,
    focusedAgentId,
    currentRuntimeAgentId,
    suppressSidebarRerender: false,
    loadAgentsInFlight: null,
    loadedAgentDetailIds: new Set(['programming-helper']),
    pendingPrebuiltAgentIds: new Set(),
    restartingRuntimeIds: new Set(),
    _agentCallActive: new Map(),
    _recentlyFinishedRuntimes: new Set(),
    activeFeaturePanel: undefined,
    captureSidebarSnapshotToken: () => ({}),
    isSidebarSnapshotTokenCurrent: () => true,
    invoke: async (command) => {
      if (command !== 'get_connected_agents') return [];
      const item = connectedPlan[connectedCursor++];
      return item === null ? [] : item;
    },
    fetch: async () => {
      const item = viewerPlan[viewerCursor++];
      if (item === null) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => ({ agents: item }) };
    },
    getRuntimeId: (record) => record?.runtime_session_id
      || ((record?.source === 'child' || record?.source === 'external') ? record.id : null),
    getAgentRuntimeId: (record) => record?.runtime_session_id
      || ((record?.source === 'child' || record?.source === 'external') ? record.id : ''),
    getParentAgentId: (record) => record?.parent_id || record?.parentId || null,
    getActiveSessionId: (record) => record?.workspace_sessions?.activeSessionId
      || record?.active_workspace_session_id || null,
    getLogicalAgentId: (record) => record?.parent_id || record?.id || null,
    isRemoteNamespaceAgentId: () => false,
    resolveWorkspaceFallbackAgentId: () => null,
    resolveFocusedAgentAfterRefresh: () => null,
    loadAgentDetail: async () => {},
    refreshAgentCallStates: async () => {},
    renderFeaturePanel: () => {},
    collectActiveCallRuntimeIds: () => [],
    queueSidebarDiagnosticEvent: (event) => { diagnostics.push(event); },
    renderAgentList: () => {
      renders.push(ctx.allAgents.map(({ id, source, connected, status }) => ({ id, source, connected, status })));
    },
  });
  // 真实 classic owner：app-core（身份工具）+ sidebar-render（宿主工厂本体）。
  // 宿主工厂是生产实现，不再从源码里切出片段执行。
  ctx.loadSource('public/src/app-core.js');
  ctx.loadSource('public/src/modules/sidebar-render.js');
  // 替身写在真源之后：本文件要断言的是「空快照的降级边界」这条契约，
  // 渲染记录、数据源与诊断写入点用夹具接管（其余键继续走真实实现）。
  Object.assign(ctx, {
    invoke: async (command) => {
      if (command !== 'get_connected_agents') return [];
      const item = connectedPlan[connectedCursor++];
      return item === null ? [] : item;
    },
    fetch: async () => {
      const item = viewerPlan[viewerCursor++];
      if (item === null) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => ({ agents: item }) };
    },
    resolveFocusedAgentAfterRefresh: () => null,
    loadAgentDetail: async () => {},
    refreshAgentCallStates: async () => {},
    renderFeaturePanel: () => {},
    collectActiveCallRuntimeIds: () => [],
    queueSidebarDiagnosticEvent: (event) => { diagnostics.push(event); },
    renderAgentList: () => {
      renders.push(ctx.allAgents.map(({ id, source, connected, status }) => ({ id, source, connected, status })));
    },
  });
  Object.assign(ctx, createAgentSnapshotLoader(ctx.run('createAgentSnapshotLoaderHost()')));
  ctx.__snapshots = renders;
  ctx.__diagnostics = diagnostics;
  ctx.__consoleGuard = guard;
  pendingGuards.push(guard);
  return ctx;
}

const snapshotOf = (ctx) => ctx.allAgents.map((agent) => ({
  id: agent.id,
  source: agent.source,
  parent_id: agent.parent_id,
  sessionType: agent.sessionType,
  sidebar_entry_id: agent.sidebar_entry_id,
  title: agent.active_workspace_session_title,
}));

function assertPersistableDiagnostic(event) {
  const persisted = sanitizeSidebarDiagnosticEvent(event, {
    source: 'client',
    now: () => Date.parse('2026-09-18T00:00:00.000Z'),
  });
  assert.ok(persisted, '诊断事件必须符合服务端持久化协议');
  assert.equal(persisted.kind, 'system');
  assert.equal(persisted.operation, 'sidebar_snapshot');
  assert.equal(persisted.result, 'degraded');
  return persisted;
}

/**
 * 真实 ESM 装载（sidebar-operations 已是 ESM，经 withP2EsmCase 的 `c.load`）；
 * classic 首屏 bootstrap（app-core / sidebar-render）提供模块顶层依赖的 kernel
 * 桥与渲染去重宿主工厂。
 *
 * 私有 helper 无导出面时的重钉：`flushSidebarDiagnosticEvents` 是模块私有，
 * 原用例直接调用；改用模块自身的排程 flush（250ms 定时器在沙箱里改成微任务），
 * 断言仍是「排队 → 取批 → 一次 POST」，强度不变。
 */
async function captureDiagnosticQueueRequest(event) {
  const requests = [];
  const fetchStub = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const immediateTimer = (callback) => { queueMicrotask(callback); return 0; };
  const guard = createConsoleGuard();
  return withP2EsmCase({
    classic: (sandbox) => {
      sandbox.setTimeout = immediateTimer;
      sandbox.setInterval = () => 0;
      sandbox.loadSource('public/src/app-core.js');
      // 生产加载序：runtime-status 提供调用状态宿主读的容器，session-view-state
      // 提供会话快照提交宿主；sidebar-operations → project-data 的静态图装载期
      // 会取这两个工厂（本用例只驱动诊断队列）。
      sandbox.loadSource('public/src/modules/runtime-status.js');
      sandbox.loadSource('public/src/modules/session-view-state.js');
      sandbox.loadSource('public/src/modules/sidebar-render.js');
      sandbox.renderAgentList = () => {};
      // app-ui / app-main 的渲染与编排宿主（生产同源，本用例不触达）。
      sandbox.createWorkspaceSurfaceHost = () => ({});
      sandbox.createPollCoordinatorHost = () => ({});
      sandbox.createRuntimeSwitchHost = () => ({ state: {} });
      sandbox.createCompactResumeHost = () => ({});
    },
    globals: {
      navigator: {},
      fetch: fetchStub,
      console: guard.recorder,
      // markdown-utils（经 project-data 图进入）装载期注册动作处理器
      ClawFW: { actions: { registerMany() {} } },
    },
  }, async (c) => {
    await c.load('public/src/modules/sidebar-operations.js');
    c.read(`queueSidebarDiagnosticEvent(${JSON.stringify(event)})`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 1, '诊断队列必须发送一次请求');
    assert.equal(requests[0].url, '/protoclaw/sidebar_diagnostics/events');
    guard.assertClean();
    return JSON.parse(requests[0].options.body).events[0];
  });
}

describe('loadAgents 空连接快照行为契约', () => {
  it('空快照诊断经过真实客户端队列后仍符合服务端协议', async () => {
    const event = {
      kind: 'system',
      operation: 'sidebar_snapshot',
      phase: 'empty-connected-preserved-identity',
      errorCode: 'empty-connected-snapshot',
      result: 'degraded',
      agentCount: 2,
      runtimeCount: 1,
    };
    const sent = await captureDiagnosticQueueRequest(event);
    assert.deepEqual(assertPersistableDiagnostic(sent), assertPersistableDiagnostic(event));
  });

  it('invoke 在 HTTP 失败时保留数组兼容性并传递非枚举诊断元数据', async () => {
    const diagnostics = [];
    const guard = createConsoleGuard();
    pendingGuards.push(guard);
    const ctx = createFrontendSandbox({
      console: guard.recorder,
      fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
      queueSidebarDiagnosticEvent: (event) => diagnostics.push(event),
    });
    ctx.window.location.protocol = 'http:';
    ctx.window.location.port = '1420';
    ctx.loadSource('public/src/app-core.js');

    const result = await ctx.run('invoke("get_connected_agents")');
    assert.deepEqual(Array.from(result), []);
    assert.deepEqual(Object.keys(result), [], '诊断元数据不得改变数组快照形状');
    assert.deepEqual(diagnostics, [], '源错误由 loadAgents 统一归并上报');
    assert.deepEqual(JSON.parse(JSON.stringify(result.__sidebarDiagnostic)), {
      errorCode: 'connected-agents-http-503',
      phase: 'connected-http-error',
    });
  });

  it('S1: 稳态空快照保留预制身份，不降级为 external', async () => {
    const ctx = createLoadAgentsSandbox({
      connectedPlan: [[richHost(), richChild()], null],
      viewerPlan: [[viewerRuntime()], [viewerRuntime()]],
    });
    await ctx.run('loadAgents()');
    await ctx.run('loadAgents()');

    const snap = snapshotOf(ctx);
    assert.equal(snap.length, 2, '宿主与子条目均保留');
    assert.deepEqual(snap.map((a) => a.id).sort(), ['programming-helper', 'rt-main']);
    const host = snap.find((a) => a.id === 'programming-helper');
    const child = snap.find((a) => a.id === 'rt-main');
    assert.equal(host.source, 'prebuilt');
    assert.equal(child.source, 'child', '子 runtime 不得降级为 external');
    assert.equal(child.parent_id, 'programming-helper');
    assert.equal(child.sessionType, 'main');
    assert.equal(child.sidebar_entry_id, 'programming-helper');
    assert.equal(child.title, '主会话标题', '会话标题字段不丢失');
    const diagnostic = ctx.__diagnostics.find((e) => e.errorCode === 'empty-connected-snapshot');
    assert.ok(diagnostic, '空快照须产生诊断事件');
    assertPersistableDiagnostic(diagnostic);
  });

  it('S1 后恢复轮: 身份投影完整复原', async () => {
    const ctx = createLoadAgentsSandbox({
      connectedPlan: [[richHost(), richChild()], null, [richHost(), richChild()]],
      viewerPlan: [[viewerRuntime()], [viewerRuntime()], [viewerRuntime()]],
    });
    await ctx.run('loadAgents()');
    await ctx.run('loadAgents()');
    await ctx.run('loadAgents()');

    const snap = snapshotOf(ctx);
    assert.equal(snap.length, 2);
    const child = snap.find((a) => a.id === 'rt-main');
    assert.equal(child.source, 'child');
    assert.equal(child.sidebar_entry_id, 'programming-helper');
    assert.equal(child.title, '主会话标题');
  });

  it('S2: 双源皆空时整体保留上一轮', async () => {
    const ctx = createLoadAgentsSandbox({
      connectedPlan: [[richHost(), richChild()], null],
      viewerPlan: [[viewerRuntime()], null],
    });
    await ctx.run('loadAgents()');
    // JSON 往返归一化：vm realm 与 node realm 的对象原型不同，
    // deepStrictEqual 会拒绝跨 realm 的同内容空对象比较。
    const normalize = (agents) => JSON.parse(JSON.stringify(agents));
    const before = normalize(ctx.allAgents);
    await ctx.run('loadAgents()');

    assert.deepEqual(normalize(ctx.allAgents), before, '双空快照不得改动 allAgents');
    const diagnostic = ctx.__diagnostics.find((e) => e.errorCode === 'empty-connected-snapshot');
    assert.ok(diagnostic, '双空快照须产生诊断事件');
    assertPersistableDiagnostic(diagnostic);
  });

  it('S3: 首屏无历史时维持既有 external 投影（锚定现状）', async () => {
    const ctx = createLoadAgentsSandbox({
      connectedPlan: [null],
      viewerPlan: [[viewerRuntime()]],
      initialAgents: [],
      focusedAgentId: null,
      currentRuntimeAgentId: null,
    });
    await ctx.run('loadAgents()');

    assert.equal(ctx.allAgents.length, 1);
    const entry = ctx.allAgents[0];
    assert.equal(entry.source, 'external');
    assert.equal(entry.id, 'rt-main');
    const diagnostic = ctx.__diagnostics.find((e) => e.errorCode === 'empty-connected-snapshot');
    assert.ok(diagnostic, '首屏空快照须产生诊断事件');
    assertPersistableDiagnostic(diagnostic);
  });

  it('S1: 空快照期间按 viewer runtime 刷新存活状态', async () => {
    const ctx = createLoadAgentsSandbox({
      connectedPlan: [[richHost(), richChild()], null],
      viewerPlan: [[viewerRuntime(true)], [viewerRuntime(false)]],
    });
    await ctx.run('loadAgents()');
    await ctx.run('loadAgents()');

    const child = ctx.allAgents.find((a) => a.id === 'rt-main');
    assert.equal(child.source, 'child', '身份不降级');
    assert.equal(child.connected, false, 'viewer 报断开时刷新为未连接');
    assert.equal(child.status, 'stopped');
  });

  it('S1: coder 投影保留 sessionType 与 sidebar_entry_id', async () => {
    const ctx = createLoadAgentsSandbox({
      connectedPlan: [[richHost(), richChild(), richCoderChild()], null],
      viewerPlan: [[viewerRuntime(true), viewerRuntime(true, 'rt-coder')],
        [viewerRuntime(true), viewerRuntime(true, 'rt-coder')]],
    });
    await ctx.run('loadAgents()');
    await ctx.run('loadAgents()');

    const coder = ctx.allAgents.find((agent) => agent.id === 'rt-coder');
    assert.equal(coder.source, 'child');
    assert.equal(coder.sessionType, 'coder');
    assert.equal(coder.sidebar_entry_id, 'programming-helper:coder');
    assert.equal(coder.parent_id, 'programming-helper');
  });
});
