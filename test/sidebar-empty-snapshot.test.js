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
import { prepareSidebarDomain } from './p2-classic-hosts.js';

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
/**
 * 驱动生产 loadAgents()：真实 ESM 装载器宿主（agent-snapshot-loader-host）+ 真实
 * 侧栏域（sidebar-render / runtime-status）在同一个 case 图里求值，classic 相只给
 * app-core 的桥初值与数据源替身——`invoke` / `fetch` / 诊断与渲染落点在模块相之后
 * 经桥 setter 覆盖（本用例断言的正是「空快照的降级边界」，数据源必须由用例决定）。
 *
 * connectedPlan / viewerPlan 是按调用轮次出队的响应序列：
 *  - connectedPlan 项：数组 = 正常快照；null = 空快照（invoke 静默转译路径）
 *  - viewerPlan 项：数组 = /api/agents 正常返回；null = 该请求失败（ok:false）
 */
async function withLoadAgentsCase({ connectedPlan = [], viewerPlan = [], initialAgents = null,
  focusedAgentId = 'programming-helper', currentRuntimeAgentId = 'rt-main' } = {}, fn) {
  const renders = [];
  let connectedCursor = 0;
  // 一轮 loadAgents 会多次读 viewer 快照（真实链路 Promise.all 之后还有追加载），
  // 计划按「与连线查询同轮」对齐，而不是按 viewer 调用次数出队。
  let roundCursor = 0;
  const guard = createConsoleGuard();
  pendingGuards.push(guard);
  const connectedNext = (command) => {
    if (command !== 'get_connected_agents') return [];
    roundCursor = connectedCursor + 1;
    const item = connectedPlan[connectedCursor++];
    return item === null ? [] : item;
  };
  const viewerNext = async () => {
    const index = Math.max(0, Math.min(roundCursor - 1, roundCursor ? viewerPlan.length - 1 : 0));
    const item = viewerPlan[index];
    if (item === null) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, json: async () => ({ agents: item }) };
  };
  return withP2EsmCase({
    classic: (sandbox) => {
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      sandbox.loadSource('public/src/app-core.js');
      // 会话快照提交宿主的 classic 实现（侧栏域装载期取用，生产同源）
      sandbox.loadSource('public/src/modules/session-view-state.js');
      // 桥初值与身份工具：生产由 app-core 的 defineKey 提供，这里按生产语义写出
      // 同一批键（accessors 由 app-core 注册，赋值经 setter 落到 owner）。
      sandbox.allAgents = initialAgents === null ? [richHost(), richChild()] : initialAgents;
      sandbox.focusedAgentId = focusedAgentId;
      sandbox.currentRuntimeAgentId = currentRuntimeAgentId;
      sandbox.suppressSidebarRerender = false;
      sandbox.AgentLoaderHost = { loadedAgentDetailIds: new Set(['programming-helper']) };
      sandbox.pendingPrebuiltAgentIds = new Set();
      sandbox.restartingRuntimeIds = new Set();
      sandbox.captureSidebarSnapshotToken = () => ({});
      sandbox.isSidebarSnapshotTokenCurrent = () => true;
      sandbox.getRuntimeId = (record) => record?.runtime_session_id
        || ((record?.source === 'child' || record?.source === 'external') ? record.id : null);
      sandbox.getAgentRuntimeId = (record) => record?.runtime_session_id
        || ((record?.source === 'child' || record?.source === 'external') ? record.id : '');
      sandbox.getParentAgentId = (record) => record?.parent_id || record?.parentId || null;
      sandbox.getActiveSessionId = (record) => record?.workspace_sessions?.activeSessionId
        || record?.active_workspace_session_id || null;
      sandbox.getLogicalAgentId = (record) => record?.parent_id || record?.id || null;
      sandbox.isRemoteNamespaceAgentId = () => false;
      sandbox.resolveWorkspaceFallbackAgentId = () => null;
      sandbox.loadAgentDetail = async () => {};
      sandbox.collectActiveCallRuntimeIds = () => [];
      sandbox.renderFeaturePanel = () => {};
      // 首屏主视图重绘与当前记录（生产 app-ui / app-main 的实现）：本文件只驱动
      // loadAgents 的快照合并与诊断，绘制面按空实现。
      sandbox.renderCurrentMainView = () => {};
      sandbox.getCurrentRuntimeRecord = () => null;
      sandbox.getCurrentAgentRecord = () => null;
      sandbox.loadAgentData = async () => {};
      // 输入面 / 队列同步入口（生产 persistent-input 与排队投影的桥键）：本文件
      // 不装载这两个域，按调用契约给空实现。
      sandbox._syncPersistentActionButton = () => {};
      sandbox._syncPersistentInputUi = () => {};
      sandbox._syncQueueFromBackend = () => {};
      // classic 宿主工厂（生产由 app-main / app-ui 提供）：侧栏域装载期取用，
      // 本文件不驱动轮询与工作区表面。
      sandbox.createPollCoordinatorHost = () => ({
        run: async () => {}, fastInterval: () => 1000, setTimeout: () => 0, clearTimeout: () => {},
      });
      sandbox.createWorkspaceSurfaceHost = () => ({ state: {} });
      sandbox.createRuntimeSwitchHost = () => ({ state: {} });
      sandbox.createCompactResumeHost = () => ({ state: {}, now: () => Date.now() });
      sandbox.createAgentCallStatesHost = () => ({ state: {} });
      // 侧栏域模块相（runtime-status / sidebar-render / call 状态引擎）
      prepareSidebarDomain(sandbox);
    },
    globals: {
      performance: { now: () => 0 },
      console: guard.recorder,
      // 模块在宿主 realm 求值，viewer 快照走裸 fetch：同一份替身必须注入两个 realm。
      // 单一份 viewer 替身（按调用轮次出队）：不额外经 ctx.fetch 再装一遍，
      // 否则每轮 loadAgents 会消费两份计划。
      fetch: () => viewerNext(),
    },
  }, async (c) => {
    const ctx = c.window;
    // 模块相之后的观测面 / 数据源覆盖（桥键访问器此时已在位）
    ctx.invoke = async (command) => connectedNext(command);
    ctx.renderAgentList = () => {
      renders.push(ctx.allAgents.map(({ id, source, connected, status }) => ({ id, source, connected, status })));
    };
    // 生产装载入口：注册 loadAgents 桥键（同一实例，不另建第二份装载器）
    await c.load('public/src/modules/agent-snapshot-loader-host.js');
    ctx.__snapshots = renders;
    // 降级诊断的观测面：装载器宿主与生产一致地把诊断同时写进 console（warn 文案
    // 带 phase）。事件协议形状由 `captureDiagnosticQueueRequest` 用例覆盖；这里用
    // 同一次调用的文案断言「哪条降级分支被走到」。
    ctx.__consoleLines = guard.lines;
    ctx.__consoleGuard = guard;
    return fn(ctx);
  });
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
      sandbox.loadSource('public/src/modules/session-view-state.js');
      // 侧栏域（runtime-status / sidebar-render / call 状态引擎）自 P4 T2 起是 ESM：
      // 经 prepareSidebarDomain 在 classic 之后进模块相。
      prepareSidebarDomain(sandbox);
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
    await withLoadAgentsCase({
      connectedPlan: [[richHost(), richChild()], null],
      viewerPlan: [[viewerRuntime()], [viewerRuntime()]],
    }, async (ctx) => {
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
      assert.ok(ctx.__consoleLines.some((line) => line.includes('[sidebar] empty connected snapshot (preserved-identity)')),
        '空快照须走「保留身份」降级诊断');
    });
  });

  it('S1 后恢复轮: 身份投影完整复原', async () => {
    await withLoadAgentsCase({
      connectedPlan: [[richHost(), richChild()], null, [richHost(), richChild()]],
      viewerPlan: [[viewerRuntime()], [viewerRuntime()], [viewerRuntime()]],
    }, async (ctx) => {
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
  });

  it('S2: 双源皆空时整体保留上一轮', async () => {
    await withLoadAgentsCase({
      connectedPlan: [[richHost(), richChild()], null],
      viewerPlan: [[viewerRuntime()], null],
    }, async (ctx) => {
      await ctx.run('loadAgents()');
      // JSON 往返归一化：vm realm 与 node realm 的对象原型不同，
      // deepStrictEqual 会拒绝跨 realm 的同内容空对象比较。
      const normalize = (agents) => JSON.parse(JSON.stringify(agents));
      const before = normalize(ctx.allAgents);
      await ctx.run('loadAgents()');

      assert.deepEqual(normalize(ctx.allAgents), before, '双空快照不得改动 allAgents');
      assert.ok(ctx.__consoleLines.some((line) => line.includes('[sidebar] empty connected snapshot (both-sources-empty)')),
        '双空快照须走 both-sources-empty 降级诊断');
    });
  });

  it('S3: 首屏无历史时维持既有 external 投影（锚定现状）', async () => {
    await withLoadAgentsCase({
      connectedPlan: [null],
      viewerPlan: [[viewerRuntime()]],
      initialAgents: [],
      focusedAgentId: null,
      currentRuntimeAgentId: null,
    }, async (ctx) => {
      await ctx.run('loadAgents()');

      assert.equal(ctx.allAgents.length, 1);
      const entry = ctx.allAgents[0];
      assert.equal(entry.source, 'external');
      assert.equal(entry.id, 'rt-main');
      assert.ok(ctx.__consoleLines.some((line) => line.includes('[sidebar] empty connected snapshot (external-fallback-no-history)')),
        '首屏空快照须走 external-fallback 降级诊断');
    });
  });

  it('S1: 空快照期间按 viewer runtime 刷新存活状态', async () => {
    await withLoadAgentsCase({
      connectedPlan: [[richHost(), richChild()], null],
      viewerPlan: [[viewerRuntime(true)], [viewerRuntime(false)]],
    }, async (ctx) => {
      await ctx.run('loadAgents()');
      await ctx.run('loadAgents()');

      const child = ctx.allAgents.find((a) => a.id === 'rt-main');
      assert.equal(child.source, 'child', '身份不降级');
      assert.equal(child.connected, false, 'viewer 报断开时刷新为未连接');
      assert.equal(child.status, 'stopped');
    });
  });

  it('S1: coder 投影保留 sessionType 与 sidebar_entry_id', async () => {
    await withLoadAgentsCase({
      connectedPlan: [[richHost(), richChild(), richCoderChild()], null],
      viewerPlan: [[viewerRuntime(true), viewerRuntime(true, 'rt-coder')],
        [viewerRuntime(true), viewerRuntime(true, 'rt-coder')]],
    }, async (ctx) => {
      await ctx.run('loadAgents()');
      await ctx.run('loadAgents()');

      const coder = ctx.allAgents.find((agent) => agent.id === 'rt-coder');
      assert.equal(coder.source, 'child');
      assert.equal(coder.sessionType, 'coder');
      assert.equal(coder.sidebar_entry_id, 'programming-helper:coder');
      assert.equal(coder.parent_id, 'programming-helper');
    });
  });
});
