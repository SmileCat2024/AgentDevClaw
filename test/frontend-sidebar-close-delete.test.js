/**
 * Tests for sidebar close/delete timing fixes (thread-driven sidebar, ADR-0032 后续).
 *
 * 覆盖（对应 scripts/diagnose-sidebar-close-delete.mjs 复现的四个根因）：
 *   - R1 delete_session 确认文案优先用会话标题，找不到记录回退 id
 *   - R2 ctx 菜单打开期间 renderAgentList 抑制全量重建；菜单关闭后下一次
 *      调用立即补上被延迟的重建（pending 标志消化）
 *   - R3 thread-delete 删除当前停靠的对话后切回工作台面（与 thread-archive
 *      同口径的选中态回退）
 *   - R4 ctxStopAgent 提交 stop 即注册乐观退场（markPendingRuntimeStop），
 *      条目不等轮询快照摘除；invoke 失败时释放注册让条目回到可见
 *
 * 装载路线（P2 ESM 配方第三节）：sidebar-render / thread-store / runtime-status 仍是
 * classic（同步首屏与侧栏），按真实顺序 loadSource；workspace-actions（本批）/
 * sidebar-operations / ctx-menu-items / project-data 等已迁 ESM 模块经
 * withP2EsmCase 的 `c.load` 真实 import（动作入口经 kernel 桥键仍可 window 直调）。
 *
 * 真实边界重钉：
 *   - R3 的「回到工作台面」现在由 ESM 导入的 selectWorkspaceSurface 真实执行，
 *     断言钉在它的宿主契约（bindWorkspace 收到该命名空间）上；
 *   - R4 的「刷新失败不撤销已确认关闭」由真实刷新链路的失败读数驱动；
 *   - child 叶子的宿主身份经真实 getExternalRuntimeAgent + resolveHostAgentId
 *     解析（agent store 里确有该 child），不再注入 NavigationCore 替身。
 */

import { describe, it as nodeIt } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { installForegroundSyncOwner } from './p2-classic-hosts.js';

const OPS = 'public/src/modules/sidebar-operations.js';
const CTX_MENU = 'public/src/modules/ctx-menu-items.js';

const flushMicrotasks = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
};

/** classic 真源优先：只补齐 bootstrap 尚未声明的宿主全局。 */
function fillMissingGlobals(sandbox, stubs) {
  for (const [name, value] of Object.entries(stubs)) {
    if (sandbox.run(`typeof ${name} !== 'undefined'`)) continue;
    sandbox[name] = value;
  }
}

function bootstrapClassic(sandbox, fixture) {
  sandbox.currentLanguage = 'zh';
  sandbox.setInterval = () => 0;
  sandbox.loadSource('public/src/modules/action-dispatcher.js');
  // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
  sandbox.loadSource('public/src/app-core.js');
  sandbox.loadSource('public/src/modules/runtime-status.js');
  sandbox.loadSource('public/src/modules/session-view-state.js');
  sandbox.loadSource('public/src/modules/sidebar-render.js');
  // app-main 的 classic 同步引擎（唯一 owner）：装载期组合真实 host 并注册
  // sidebar-render 轮询/裁剪路径消费的两个桥键。
  installForegroundSyncOwner(sandbox);
  sandbox.AgentLoaderHost = { loadedAgentDetailIds: new Set() };

  // 壳层桥接入口（app-main / input-helpers / runtime-status 的 window.* 桥）：
  // 真实 loadAgentData → 正文/输入/运行时状态三条刷新链都会在成功路径上调用
  // 它们，缺键会变成 TypeError（不是被测契约）。身份类按同一份经典状态投影，
  // 呈现类给空实现——本文件的断言不落在这些渲染上。
  const bridgeHostRecord = () => {
    const hostId = sandbox.normalizeAgentIdentity(sandbox.focusedAgentId);
    if (!hostId) return null;
    return (sandbox.allAgents || []).find(
      (agent) => sandbox.normalizeAgentIdentity(agent?.id) === hostId,
    ) || null;
  };
  if (typeof sandbox.getCurrentAgentRecord !== 'function') {
    sandbox.getCurrentAgentRecord = bridgeHostRecord;
  }
  if (typeof sandbox.getCurrentRuntimeRecord !== 'function') {
    sandbox.getCurrentRuntimeRecord = () => (sandbox.currentRuntimeAgentId
      && typeof sandbox.getRuntimeRecord === 'function'
      ? sandbox.getRuntimeRecord(sandbox.currentRuntimeAgentId) : null) || bridgeHostRecord();
  }
  if (typeof sandbox.updateRollbackActionVisibility !== 'function') {
    sandbox.updateRollbackActionVisibility = () => {};
  }
  if (typeof sandbox.renderRollbackActions !== 'function') {
    sandbox.renderRollbackActions = () => {};
  }
  // 常驻输入的动作按钮同步（owner: classic persistent-input 的
  // _syncPersistentActionButton）：运行时状态刷新链会裸调用它，缺键即
  // ReferenceError。本文件不断言该按钮，作为壳层缝给空实现。
  if (typeof sandbox._syncPersistentActionButton !== 'function') {
    sandbox._syncPersistentActionButton = () => {};
  }
  // 调用状态宿主的 remoteEntries 在 app-main 里取「在线远程条目」；本链没有
  // 远程连接，按空世界委托（缺键会让真实 refreshAgentCallStates 抛 TypeError）。
  // 调用状态宿主由 app-main 的 classic 同步引擎组合真实
  // createAgentCallStatesHost，本文件不再合成第二份宿主实现。
  // 面板渲染入口（classic app-ui 的 renderFeaturePanel）不在本链：作为宿主
  // 缝显式提供空实现，避免真实快照 loader 的 renderPanel 抛 ReferenceError。
  sandbox.renderFeaturePanel = () => {};
  sandbox.createCompactResumeHost = () => ({ state: {}, now: () => Date.now() });
  sandbox.createRuntimeSwitchHost = () => ({ state: {} });
  // 预制 agent 入口与轮询协调者宿主（owner: classic app-main，本链不加载）：
  // workspace-actions 的 ESM import 链在求值期读取这两个工厂。
  sandbox.createWorkspaceEntryHost = () => ({});
  sandbox.createPollCoordinatorHost = () => ({
    run: () => {},
    fastInterval: () => 0,
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (id) => clearTimeout(id),
  });
  // 工作空间表面宿主（owner: classic app-ui，本链不加载）：记录「切到哪个
  // 命名空间」，即 selectWorkspaceSurface 的真实外部效果。
  sandbox.createWorkspaceSurfaceHost = () => ({
    bumpNavigationGuard: () => {},
    closeReadOnlySession: () => {},
    hasDetail: () => true,
    loadDetail: async () => {},
    render: () => {},
    refreshPanels: () => {},
    findAgent: (id) => (sandbox.allAgents || []).find((agent) => agent.id === id) || null,
    currentAgent: () => null,
    preferenceKey: () => '',
    tabs: () => [{ id: 'chat' }],
    surfacePreference: () => null,
    defaultMode: () => 'chat',
    ui: () => ({}),
    focusedAgentId: () => sandbox.focusedAgentId || null,
    runtimeId: () => null,
    contextKey: () => '',
    saveScroll: () => {},
    readOnlyMode: () => false,
    saveCache: () => {},
    bindWorkspace: (agentId) => { fixture.selectWorkspaceSurface.push([agentId]); },
    setFollowLatest: () => {},
    resetRuntimeState: () => {},
    beginPending: () => {},
    setTab: () => {},
    beginLoading: () => {},
    clearPending: () => {},
    renderAgents: () => {},
    renderPanel: () => {},
  });
  sandbox.performance = { now: () => 0 };
  fillMissingGlobals(sandbox, {
    CSS: { escape: (value) => String(value) },
    isRemoteNamespaceAgentId: (id) => typeof id === 'string' && id.startsWith('remote:'),
    setPreferredUnitMode: () => {},
    resolveFocusedAgentAfterRefresh: () => null,
    handlePrebuiltAgentClick: () => {},
    loadAgentDetail: async () => ({}),
    closeAgentContextMenu: () => {},
    closeCompactMenu: () => {},
    closeProjectContextMenu: () => {},
    groupConnectedAgents: () => ({ external: [] }),
    agentList: { addEventListener() {} },
    externalAgentList: {}, externalGroup: { style: {} }, externalCount: {},
    updateCurrentAgentChrome: () => {},
    pendingPrebuiltAgentIds: new Set(),
    _recentlyFinishedRuntimes: new Set(),
    getAgentRuntimeId: (agent) => agent.runtime_session_id || '',
    getParentAgentId: (agent) => agent.parent_id,
    getActiveSessionId: (agent) => agent.active_workspace_session_id,
    isRuntimeItemActive: () => false,
    // 真实 wire 形状：连接快照是数组（.some/.map），其余命令回执是对象。
    invoke: async (command) => (command === 'get_connected_agents' ? [] : {}),
  });
  // 侧栏布局宿主（owner: classic app-main 的 ClawSidebarLayout）：
  // renderAgentList 的门控与落点都经它，缺省会打断 stop/删除链路。
  sandbox.window.ClawSidebarLayout = {
    isInteracting: () => false,
    signature: () => 'fixture-layout',
    load: async () => {},
    render: () => {},
    toggle: () => {},
  };
  // renderAgentList 是 classic sidebar-render 的真实实现（R2 直接测它）；
  // renderCurrentMainView 的渲染入口不在本链，补最小替身。
  fillMissingGlobals(sandbox, {
    renderAgentList: () => {},
    renderCurrentMainView: () => {},
  });
}


/**
 * 成功路径的缺键异常守卫：用例期间的 console 交给记录器（直通宿主，不静音），
 * 用例结束（成功路径）时只对 TypeError / ReferenceError / is not a function
 * 断言——装配缺键会以这类错误出现在真实调用链里，不能静默通过。
 */
function createConsoleGuard() {
  const host = globalThis.console; // 词法捕获：用例期间 globalThis.console 已是记录器
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
let activeCase = null;

function it(name, fn) {
  nodeIt(name, async () => {
    const guard = createConsoleGuard();
    const fixture = { fetchCalls: [], selectWorkspaceSurface: [], confirm: [], invoke: [], alerts: [], toasts: [] };
    const fetchStub = async (url, options) => {
      fixture.fetchCalls.push({ url: String(url), options });
      return { ok: true, json: async () => ({ ok: true, cleanup: {} }), text: async () => '' };
    };
    await withP2EsmCase({
      classic: (sandbox) => bootstrapClassic(sandbox, fixture),
      globals: {
        navigator: undefined,
        fetch: fetchStub,
        CSS: { escape: (value) => String(value) },
        console: guard.recorder,
      },
    }, async (c) => {
      // 刷新引擎（P4 T3 起是真实 ESM）：交互域在**装载期**取它的窄宿主 createThreadStoreHost，
// 必须先于 thread-store-domain 进入同一张图。
      await c.load('public/src/modules/thread-store.js');
      await c.load('public/src/modules/agent-data-loader.js');
      await c.load('public/src/modules/project-data.js');
      await c.load(OPS);
      await c.load(CTX_MENU);
      activeCase = { c, ctx: c.sandbox, fixture, fetchStub };
      try {
        const result = await fn(c.sandbox, fixture);
        guard.assertClean();
        return result;
      } finally {
        activeCase = null;
      }
    });
  });
}

/* ── R1：删除确认文案 ── */

describe('R1 delete_session confirm shows session title', () => {
  // workspace-actions 已迁 ESM（P2 本批）：真实 import，动作入口经 kernel 桥键
  // 仍是 window.runWorkspaceAction。会话查询 / 更新、幂等键、会话变更导航全由
  // 真实模块提供——只用真实宿主缝（确认框 / 当前 agent）驱动，不再用替身顶替。
  const workspaceActionCtx = async (fixture, host) => {
    const ctx = activeCase.ctx;
    await activeCase.c.load('public/src/modules/workspace-actions.js');
    Object.assign(ctx, {
      allAgents: [host],
      getCurrentAgentRecord: () => host,
      markActionLoading: () => {},
      getIMWorkspaceDraft: () => null,
      ensureIMWorkspaceLoaded: async () => {},
    });
    // 删除成功后动作入口会刷新 agent 列表（真实 loadAgents）。它读的连接快照
    // 是 IPC 回执：本用例不关心快照内容，按真实 wire 形状（数组）回答，
    // 其余命令回执给空对象——这不是被测契约，只是宿主 IO 边界。
    ctx.window.invoke = async (command) => (command === 'get_connected_agents' ? [] : {});
    ctx.t = (key) => (key === 'workspace_session_delete_confirm'
      ? '确定要删除会话 {{id}} 吗？此操作不可撤销。'
      : key);
    ctx.window.confirm = (message) => { fixture.confirm.push(String(message)); return true; };
    ctx.window.closeCtxMenu = () => {};
    return ctx;
  };

  it('uses deletedSession.title when the record is loaded', async () => {
    const host = {
      id: 'programming-helper',
      workspace_sessions: {
        revision: 5,
        activeSessionId: 'session-1',
        sessions: [{ id: 'session-1', title: '修复登录 bug', archived: false }],
      },
    };
    const ctx = await workspaceActionCtx(activeCase.fixture, host);

    ctx.run(`window.runWorkspaceAction(JSON.stringify({
      type: 'delete_session',
      sessionId: 'session-1',
    }))`);
    await flushMicrotasks();

    assert.equal(activeCase.fixture.confirm.length, 1, 'confirm shown exactly once');
    assert.match(activeCase.fixture.confirm[0], /修复登录 bug/);
    assert.doesNotMatch(activeCase.fixture.confirm[0], /session-1/);
  });

  it('falls back to the raw id when the record is not loaded', async () => {
    const host = {
      id: 'programming-helper',
      workspace_sessions: { revision: 5, activeSessionId: null, sessions: [] },
    };
    // 宿主记录里没有该会话（列表滞后 / 竞态）：真实查询自然返回 null。
    const ctx = await workspaceActionCtx(activeCase.fixture, host);

    ctx.run(`window.runWorkspaceAction(JSON.stringify({
      type: 'delete_session',
      sessionId: 'session-missing',
    }))`);
    await flushMicrotasks();

    assert.match(activeCase.fixture.confirm[0] || '', /session-missing/);
  });
});

/* ── R2：ctx 菜单打开期间的侧栏重渲守卫 ── */

describe('R2 renderAgentList guard while context menus are open', () => {
  function sidebarHarness() {
    const ctx = activeCase.ctx;
    const host = {
      id: 'programming-helper', source: 'prebuilt',
      workspace_sessions: { revision: 1, sessions: [{ id: 's1', title: '新对话1' }] },
    };
    const child = {
      id: 'runtime-1', runtime_session_id: 'runtime-1', source: 'child', parent_id: 'programming-helper',
      active_workspace_session_id: 's1', active_workspace_session_title: '新对话1', connected: true,
    };
    Object.assign(ctx, {
      allAgents: [host, child],
      t: (key) => key,
      setTimeout: () => 0,
      normalizeAgentIdentity: (value) => String(value || '').trim(),
      toEpochMs: () => 0,
      pendingPrebuiltAgentIds: new Set(),
      _recentlyFinishedRuntimes: new Set(),
      getAgentRuntimeId: (agent) => agent.runtime_session_id || '',
      getParentAgentId: (agent) => agent.parent_id,
      getActiveSessionId: (agent) => agent.active_workspace_session_id,
      isRuntimeItemActive: () => false,
      updateCurrentAgentChrome() {},
      groupConnectedAgents: () => ({ external: [] }),
      agentList: { addEventListener() {} },
      externalAgentList: {}, externalGroup: { style: {} }, externalCount: {},
      renderCurrentMainView() {},
    });
    const state = { renders: 0, menuOpen: false };
    ctx.window.ClawSidebarLayout = {
      isInteracting: () => false,
      signature: () => 'fixture-layout',
      load: async () => {},
      render() { state.renders += 1; },
    };
    const originalGetElementById = ctx.document.getElementById.bind(ctx.document);
    ctx.document.getElementById = (id) => {
      if (id === 'ctx-menu') {
        return { classList: { contains: (cls) => cls === 'open' && state.menuOpen } };
      }
      return originalGetElementById(id);
    };
    ctx.fetch = async () => ({ ok: true, json: async () => ({ threads: [] }) });
    return { ctx, host, child, state };
  }

  it('suppresses full rebuild while the menu is open, then catches up on the next call', () => {
    const h = sidebarHarness();
    h.ctx.run('renderAgentList()');
    assert.equal(h.state.renders, 1);

    // 菜单打开：签名变化（title 更新）不得触发全量重建。
    h.state.menuOpen = true;
    h.host.workspace_sessions.sessions[0].title = '新对话1（AI 标题）';
    h.child.active_workspace_session_title = '新对话1（AI 标题）';
    h.ctx.run('renderAgentList()');
    assert.equal(h.state.renders, 1, 'no rebuild while ctx menu is open');

    // 菜单关闭：下一次调用（轮询 tick / SSE）立即补上被延迟的重建。
    h.state.menuOpen = false;
    h.ctx.run('renderAgentList()');
    assert.equal(h.state.renders, 2, 'deferred rebuild catches up once the menu closes');
  });

  it('keeps ordinary re-renders working when no menu is open', () => {
    const h = sidebarHarness();
    h.ctx.run('renderAgentList()');
    h.host.workspace_sessions.sessions[0].title = '改名';
    h.child.active_workspace_session_title = '改名';
    h.ctx.run('renderAgentList()');
    assert.equal(h.state.renders, 2, 'signature change still triggers rebuild');
  });
});

/* ── R3：thread-delete 选中态回退 ── */

describe('R3 thread-delete falls back from the removed conversation', () => {
  const menuHarness = ({ currentRuntimeAgentId = 'other-runtime', invokeImpl } = {}) => {
    const fixture = activeCase.fixture;
    const ctx = activeCase.ctx;
    Object.assign(ctx, {
      t: (key) => key,
      currentRuntimeAgentId,
      normalizeAgentIdentity: (value) => String(value || '').trim(),
      getRuntimeId: () => null,
      clearAgentRuntimeCache: () => {},
      invoke: async (...args) => {
        fixture.invoke.push(args);
        if (invokeImpl) return invokeImpl(...args);
        return args[0] === 'get_connected_agents' ? [] : {};
      },
      newIdempotencyKey: () => 'idem-test-1',
    });
    ctx.window.confirm = (message) => { fixture.confirm.push(String(message)); return true; };
    ctx.window.closeCtxMenu = () => {};
    ctx.window.refreshThreads = async () => {};
    ctx.window.getThreadById = (threadId) => ({ threadId, headViewerAgentId: 'runtime-1' });
    ctx.window.getThreadForSession = () => null;
    return { ctx, fixture };
  };

  it('returns to the workspace surface when the deleted runtime was docked', async () => {
    const h = menuHarness({ currentRuntimeAgentId: 'runtime-1' });
    await h.ctx.run(`dispatchCtxAction('thread-delete', {
      ns: 'programming-helper', id: 'runtime-1', sessionId: 's1', threadId: 'wt-1',
    })`);
    await flushMicrotasks();

    assert.ok(
      h.fixture.fetchCalls.some((entry) => String(entry.url).includes('/threads/wt-1/delete')),
      'delete request reaches the server',
    );
    // ESM selectWorkspaceSurface 的真实外部效果：把该命名空间绑定为当前表面
    assert.deepEqual(h.fixture.selectWorkspaceSurface, [['programming-helper']]);
  });

  it('does not navigate away when another conversation is docked', async () => {
    const h = menuHarness({ currentRuntimeAgentId: 'other-runtime' });
    await h.ctx.run(`dispatchCtxAction('thread-delete', {
      ns: 'programming-helper', id: 'runtime-1', sessionId: 's1', threadId: 'wt-1',
    })`);
    await flushMicrotasks();

    assert.equal(h.fixture.selectWorkspaceSurface.length, 0);
  });
});

/* ── R4：关闭（stop）乐观退场 ── */

describe('R4 ctxStopAgent optimistic runtime retirement', () => {
  const stopHarness = ({ currentRuntimeAgentId = 'other-runtime', invokeImpl, allAgents } = {}) => {
    const fixture = activeCase.fixture;
    const ctx = activeCase.ctx;
    ctx.allAgents = allAgents || [];
    Object.assign(ctx, {
      currentRuntimeAgentId,
      normalizeAgentIdentity: (value) => String(value || '').trim(),
      getRuntimeId: (agent) => agent?.runtime_session_id || agent?.id || null,
      clearAgentRuntimeCache: () => {},
      invoke: async (...args) => {
        fixture.invoke.push(args);
        if (invokeImpl) return invokeImpl(...args);
        return args[0] === 'get_connected_agents' ? [] : {};
      },
    });
    ctx.window.closeCtxMenu = () => {};
    ctx.window.getThreadById = (threadId) => ({ threadId, headViewerAgentId: 'runtime-1' });
    ctx.window.getThreadForSession = () => null;
    return { ctx, fixture };
  };

  it('registers pending stop so the leaf hides before the next poll', async () => {
    const h = stopHarness();
    await h.ctx.run(`dispatchCtxAction('stop', {
      ns: 'programming-helper', id: 'runtime-1', sessionId: 's1', variant: 'managed-runtime',
    })`);
    await flushMicrotasks();

    assert.ok(
      h.fixture.invoke.some((args) => args[0] === 'stop_agent'),
      'stop_agent dispatched',
    );
    assert.equal(
      h.ctx.run(`isRuntimeStopPending('programming-helper', 's1', 'runtime-1')`),
      true,
      'leaf hidden optimistically',
    );
  });

  it('releases the registration when stop is rejected so the leaf returns', async () => {
    const h = stopHarness({ invokeImpl: async () => { throw new Error('stop rejected'); } });
    await h.ctx.run(`dispatchCtxAction('stop', {
      ns: 'programming-helper', id: 'runtime-1', sessionId: 's1', variant: 'managed-runtime',
    })`);
    await flushMicrotasks();

    assert.equal(
      h.ctx.run(`isRuntimeStopPending('programming-helper', 's1', 'runtime-1')`),
      false,
      'registration released after a rejected stop',
    );
  });

  it('does not undo a successful stop when the following refresh fails', async () => {
    // 真实刷新链路的失败读数：stop 已确认（invoke 成功），随后的侧栏刷新读请求失败。
    const h = stopHarness();
    h.ctx.window.alert = (message) => { h.fixture.alerts.push(String(message)); };
    const inFlight = Promise.withResolvers();
    h.ctx.loadAgentsInFlight = inFlight.promise;
    h.ctx.run(`dispatchCtxAction('stop', { ns: 'programming-helper', id: 'runtime-1', sessionId: 's1', variant: 'managed-runtime' })`);
    // 让 stop 请求结算、刷新链路挂上这个在飞读之后再让它失败（不留未处理拒绝）
    await new Promise((resolve) => setImmediate(resolve));
    inFlight.reject(new Error('offline'));
    await new Promise((resolve) => setImmediate(resolve));
    // 失败分支的用户可见面：确认已关闭 + 提示列表刷新失败（不回滚乐观退场）
    assert.equal(h.fixture.alerts.length, 1);
    assert.match(h.fixture.alerts[0], /列表刷新失败/);
    assert.equal(h.ctx.run(`isRuntimeStopPending('programming-helper', 's1', 'runtime-1')`), true);
  });

  it('does not register for remote entries (outside the local projection filter)', async () => {
    const h = stopHarness();
    await h.ctx.run(`dispatchCtxAction('stop', {
      ns: 'remote-ns', id: 'runtime-1', sessionId: 's1', variant: 'remote',
    })`);
    await flushMicrotasks();

    assert.ok(h.fixture.invoke.some((args) => args[0] === 'stop_agent'));
    assert.equal(h.ctx.run(`isRuntimeStopPending('remote-ns', 's1', 'runtime-1')`), false);
  });

  it('resolves the host agent for child leaves before registering', async () => {
    const h = stopHarness({
      // agent store 里确有该 child：真实 getExternalRuntimeAgent 取到它，
      // resolveHostAgentId 由此解析出宿主 id（不再注入 NavigationCore 替身）。
      allAgents: [{
        id: 'runtime-1', source: 'child', parent_id: 'programming-helper',
        runtime_session_id: 'runtime-1', active_workspace_session_id: 's1',
      }],
    });
    await h.ctx.run(`dispatchCtxAction('stop', {
      ns: 'programming-helper', id: 'runtime-1', sessionId: 's1', variant: 'child',
    })`);
    await flushMicrotasks();

    assert.ok(
      h.fixture.invoke.some((args) => args[0] === 'stop_agent' && args[1]?.agentId === 'programming-helper'),
      'stop_agent addressed to the host agent',
    );
    assert.equal(h.ctx.run(`isRuntimeStopPending('programming-helper', 's1', 'runtime-1')`), true);
  });
});
