/**
 * 侧栏快照时效（loadAgents / 线程事实 / 提交边界）——P2 装载路线。
 *
 * sidebar-render / runtime-status / thread-store / project-data 仍是 classic
 * （同步首屏与渲染宿主），按真实顺序 loadSource；sidebar-operations /
 * ctx-menu-items / session-ui 已迁 ESM，经 withP2EsmCase 的 `c.load` 真实
 * import（每 case 整图隔离）。classic 侧经 kernel 访问器桥读取同一份状态与实现。
 *
 * 真实边界重钉：`invalidateSidebarProjection` / `ctxRenameSession`（ESM 导出，
 * 零 classic 消费面）与撤桥后的 `markPendingRuntimeStop` / `applySessionMutationDelta`
 * 都不再是 window 全局，用例一律改调真实命名导出——不恢复同名 window 桥。
 * 仍走经典消费面的键（loadAgents / reconcilePendingRuntimeStops，classic
 * sidebar-render 内部经桥取用）保持原样。
 */

import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { installForegroundSyncOwner } from './p2-classic-hosts.js';

const SESSION_UI = 'public/src/modules/session-ui.js';
const OPS = 'public/src/modules/sidebar-operations.js';
const CTX_MENU = 'public/src/modules/ctx-menu-items.js';

/** classic 真源优先：只补齐 bootstrap 尚未声明的宿主全局。 */
function fillMissingGlobals(sandbox, stubs) {
  for (const [name, value] of Object.entries(stubs)) {
    if (sandbox.run(`typeof ${name} !== 'undefined'`)) continue;
    sandbox[name] = value;
  }
}

function bootstrapClassic(sandbox) {
  sandbox.loadSource('public/src/modules/action-dispatcher.js');
  // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
  sandbox.loadSource('public/src/app-core.js');
  sandbox.loadSource('public/src/modules/runtime-status.js');
  sandbox.loadSource('public/src/modules/session-view-state.js');
  sandbox.loadSource('public/src/modules/sidebar-render.js');
  // app-main 的 classic 同步引擎（唯一 owner）：在装载期组合真实 host 并注册
  // sidebar-render 轮询/裁剪路径消费的两个桥键。boot 体挂在永不 resolve 的
  // __clawAuthReady 上。
  sandbox.AgentLoaderHost = { loadedAgentDetailIds: new Set() };
  // 数据加载图静态依赖（agent-data-loader → input-actions）在装载期取 app-main
  // 的轮询宿主工厂；本文件不驱动轮询。
  sandbox.createPollCoordinatorHost = () => ({});

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
  // 调用状态宿主由 app-main 的 classic 同步引擎组合真实
  // createAgentCallStatesHost（容器 = app-core / runtime-status 的 Map/Set），
  // 本文件不再合成第二份宿主实现。
  // 面板渲染入口（classic app-ui 的 renderFeaturePanel）不在本链：作为宿主
  // 缝显式提供空实现，避免真实快照 loader 的 renderPanel 抛 ReferenceError。
  sandbox.renderFeaturePanel = () => {};
  sandbox.createRuntimeSwitchHost = () => ({ state: {} });
  // 表面宿主：app-ui 的真实工厂在用例里不装载（其顶层注册 ClawHost block），
  // 按其宿主契约给同形 facade——查询走真实经典状态，副作用落到本用例的记录点。
  // 偏好/标签页读取归 app-ui，未装载时按「无偏好」空值回答。
  sandbox.createWorkspaceSurfaceHost = () => ({
    bumpNavigationGuard: () => sandbox.bumpNavigationGuard(),
    closeReadOnlySession: () => {},
    hasDetail: (id) => sandbox.loadedAgentDetailIds?.has?.(id) === true,
    loadDetail: (id) => sandbox.loadAgentDetail(id),
    findAgent: (id) => (sandbox.allAgents || []).find((item) => item.id === id) || null,
    currentAgent: () => sandbox.getCurrentAgentRecord(),
    preferenceKey: () => '',
    tabs: () => [],
    surfacePreference: () => null,
    defaultMode: () => 'home',
    ui: (agent) => sandbox.getCurrentUnitUi(agent),
    focusedAgentId: () => sandbox.focusedAgentId,
    runtimeId: () => sandbox.currentRuntimeAgentId,
    contextKey: (id) => sandbox.getRuntimeContextKey(id),
    saveScroll: () => {},
    readOnlyMode: () => sandbox.readOnlyMode === true,
    saveCache: () => {},
    bindWorkspace: () => {},
    setFollowLatest: () => {},
    resetRuntimeState: () => {},
    beginPending: () => {},
    setTab: (tab) => { sandbox.currentWorkspaceTab = tab; },
    beginLoading: () => {},
    clearPending: () => {},
    renderAgents: () => {},
    render: () => {},
    renderPanel: () => {},
    refreshPanels: () => {},
  });
  sandbox.createCompactResumeHost = () => ({ state: {}, now: () => Date.now() });
  fillMissingGlobals(sandbox, {
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
    CSS: { escape: (value) => String(value) },
    closeAgentContextMenu: () => {},
    closeCompactMenu: () => {},
    closeProjectContextMenu: () => {},
    isRemoteNamespaceAgentId: (id) => typeof id === 'string' && id.startsWith('remote:'),
    setPreferredUnitMode: () => {},
    resolveFocusedAgentAfterRefresh: () => null,
    handlePrebuiltAgentClick: () => {},
    loadAgentDetail: async () => ({}),
    invoke: async () => [],
  });
  // 最后装载：引擎读到的宿主/渲染入口均已就位（仍指向真实 classic 实现）。
  installForegroundSyncOwner(sandbox);
  // 本夹具的经典基座刻意不含 app-main 的 boot/身份层（文件头装载路线的前提）。
  // 引擎装载会一并带来 app-main 的 getCurrentHostAgentRecord，使
  // _currentActiveSession 能解析出宿主会话、线程指向被重建——那属于另一条
  // 链的事实。按原前提把身份解析保持为「无宿主记录」（与本文件其余 seam
  // 同口径），不是给被测逻辑造替代实现。
  sandbox.getCurrentHostAgentRecord = () => null;
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
async function withFreshnessCase(agentId, fn) {
  // 沙箱 fetch 与 ESM 侧裸 `fetch` 指向同一份可变实现：用例体替换
  // `ctx.fetch` 时，已迁模块的请求也走新实现（不产生两份网络桩）。
  const fetchRef = { current: null };
  const guard = createConsoleGuard();
  return withP2EsmCase({
    classic: bootstrapClassic,
    globals: {
      navigator: undefined,
      // ctx-menu-items 的 ESM 侧以裸标识符使用（浏览器里就是 window.CSS）
      CSS: { escape: (value) => String(value) },
      fetch: (...args) => fetchRef.current(...args),
      console: guard.recorder,
    },
  }, async (c) => {
    // 刷新引擎（P4 T3 起是真实 ESM）：交互域在**装载期**取它的窄宿主 createThreadStoreHost，
// 必须先于 thread-store-domain 进入同一张图。
    await c.load('public/src/modules/thread-store.js');
    // classic 装配 seam 已迁 ESM（W2-4 二段）：必须先求值，后续 host 模块在
    // 自己的模块求值期 spread 它注册的工厂。
    await c.load('public/src/modules/agent-data-loader.js');
    await c.load('public/src/modules/project-data.js');
    await c.load(SESSION_UI);
    const ops = await c.load(OPS);
    const items = await c.load(CTX_MENU);
    const result = await fn(harness(c, agentId, fetchRef), ops, items);
    guard.assertClean();
    return result;
  });
}

/** 在已装载的用例沙箱上装配侧栏夹具（与迁移前的沙箱注入等价）。 */
function harness(c, agentId = 'coder', fetchRef = { current: null }) {
  const ctx = c.sandbox;
  const handlers = new Map();
  let threads = [];
  let html = '';
  let renders = 0;

  Object.assign(ctx, {
    setTimeout: () => 0,
    setInterval: () => 0,
    t: (key) => key,
    normalizeAgentIdentity: (value) => String(value || '').trim(),
    toEpochMs: (value) => Date.parse(value || '') || 0,
    performance: { now: () => 0 },
    renderCurrentMainView() {},
  });
  // fetch 是唯一被 ESM 侧以裸标识符调用的平台能力：访问器 + 代理保证
  // 「用例替换 ctx.fetch」对 classic 与 ESM 同时生效。
  // 默认 wire 按端点回答真实形状：连接快照是数组、viewer 是 { agents }、
  // 线程快照是 { threads }。形状错了会让 loadAgents 抛 connected.some 一类
  // TypeError（不是被测契约，而是夹具接线错误）。
  let currentFetch = async (url = '') => {
    const target = String(url);
    if (target.startsWith('/protoclaw/get_connected_agents')) {
      return { ok: true, json: async () => ctx.allAgents };
    }
    if (target === '/api/agents') return { ok: true, json: async () => ({ agents: [] }) };
    return { ok: true, json: async () => ({ threads }) };
  };
  Object.defineProperty(ctx, 'fetch', {
    configurable: true,
    enumerable: true,
    get: () => currentFetch,
    set: (value) => { currentFetch = value; },
  });
  fetchRef.current = () => currentFetch();
  const host = {
    id: agentId, source: 'prebuilt',
    workspace_sessions: { revision: 1, sessions: [{ id: 's1', title: 'Old' }] },
  };
  const child = {
    id: 'r1', runtime_session_id: 'r1', source: 'child', parent_id: agentId,
    active_workspace_session_id: 's1', active_workspace_session_title: 'Old', connected: true,
  };
  ctx.allAgents = [host, child];

  ctx.window.ClawSidebarLayout = {
    isInteracting: () => false,
    signature: () => 'fixture',
    load: async () => {},
    render() {
      renders += 1;
      html = ctx.run('renderSidebarChildItems(collectRuntimeEntriesForPrebuilt(allAgents[0], allAgents), allAgents[0].id)');
    },
  };
  ctx.window.ClawFW = {
    ...ctx.window.ClawFW,
    SseClient: { subscribeThreadEvents(ids, handler) {
      const keys = Array.isArray(ids) ? ids : [ids];
      keys.forEach((id) => handlers.set(id, handler));
      return () => keys.forEach((id) => handlers.delete(id));
    } },
  };

  return {
    ctx, host, child, handlers,
    get html() { return html; },
    get renders() { return renders; },
    async threads(value) {
      threads = value;
      host.sidebar_threads = structuredClone(value);
      await ctx.window.refreshThreads(true);
    },
    setThreads(value) { threads = value; host.sidebar_threads = structuredClone(value); },
  };
}

nodeTest('a failed authoritative read preserves the entire sidebar frame despite conflicting Viewer data', async () => {
  await withFreshnessCase('programming-helper', async (h) => {
    Object.assign(h.ctx, { loadAgentsInFlight: null, performance: { now: () => 0 }, ensurePhProjectEntitiesLoaded: async () => {} });
    h.ctx.window.ClawSidebarLayout.load = async () => {};
    const failed = [];
    Object.defineProperty(failed, '__sidebarDiagnostic', { value: { errorCode: 'connected-agents-http-409' } });
    h.ctx.invoke = async () => failed;
    h.ctx.fetch = async () => ({ ok: true, json: async () => ({ agents: [{ id: 'r1', connected: false }] }) });
    const before = h.ctx.allAgents;
    await h.ctx.run('loadAgents()');
    assert.equal(h.ctx.allAgents, before);
    assert.equal(h.ctx.allAgents[1].connected, true);
  });
});

nodeTest('post-close refresh rejects an old in-flight poll and fetches a post-commit snapshot', async () => {
  await withFreshnessCase('programming-helper', async (h) => {
    h.ctx.window.setTimeout = () => 0;
    h.ctx.getRuntimeId = agent => agent.runtime_session_id || '';
    h.ctx.performance = { now: () => 0 };
    h.ctx.suppressSidebarRerender = false;
    h.ctx.loadAgentsInFlight = null;
    h.ctx.loadedAgentDetailIds = new Set();
    h.ctx.focusedAgentId = 'programming-helper';
    h.ctx.isRemoteNamespaceAgentId = () => false;
    h.ctx.refreshAgentCallStates = async () => {};
    h.ctx.renderFeaturePanel = () => {};
    h.ctx.ensurePhProjectEntitiesLoaded = async () => {};
    h.ctx.fetch = async () => ({ ok: true, json: async () => ({ agents: [] }) });
    const oldRead = Promise.withResolvers();
    let reads = 0;
    h.ctx.invoke = () => ++reads === 1 ? oldRead.promise : Promise.resolve([h.host]);
    const before = h.ctx.run('loadAgents()');
    const after = h.ctx.run('refreshSidebarRuntimeAfterMutation()');
    oldRead.resolve([h.host, h.child]);
    await Promise.all([before, after]);
    assert.equal(reads, 2, 'joining a pre-close poll is not a post-close refresh');
    assert.equal(h.html, '', 'late pre-close data must not recreate the closed leaf');
    assert.equal(h.ctx.allAgents.length, 1);
  });
});

nodeTest('closed runtime stays absent while the independent thread snapshot still says running', async () => {
  await withFreshnessCase('programming-helper', async (h, ops) => {
    await h.threads([thread({ agentId: 'programming-helper' })]);
    h.ctx.run('renderAgentList()');
    assert.match(h.html, /data-thread-id="t1"/);
    ops.markPendingRuntimeStop('programming-helper', 's1', 'r1');
    // ESM 导出（消费方已改直引，不再上桥）
    ops.invalidateSidebarProjection();
    assert.equal(h.html, '');
    // The runtime poll confirms retirement before the slower thread poll arrives.
    h.ctx.allAgents = [h.host];
    h.ctx.run('reconcilePendingRuntimeStops(allAgents); renderAgentList()');
    assert.equal(h.html, '', 'a stale thread observation must not recreate a disconnected runtime');
    await h.threads([thread({ agentId: 'programming-helper', lifeState: 'idle', headRuntimeRunning: false })]);
    assert.equal(h.html, '');
  });
});

nodeTest('thread refresh retires a ghost without a click or another render trigger', async () => {
  await withFreshnessCase('coder', async (h) => {
    await h.threads([thread()]);
    h.ctx.run('renderAgentList()');
    h.ctx.allAgents = [h.host];
    h.ctx.run('renderAgentList()');
    assert.equal(h.html, '', 'missing runtimes are not reconstructed from stale thread activity');
    await h.threads([thread({ lifeState: 'archived', archivedAt: 1, headRuntimeRunning: false })]);
    assert.equal(h.html, '');
  });
});

nodeTest('archived thread cannot reappear as a plain runtime while the agents snapshot lags', async () => {
  await withFreshnessCase('coder', async (h) => {
    await h.threads([thread({ lifeState: 'archived', archivedAt: 1, headRuntimeRunning: false })]);
    h.ctx.run('renderAgentList()');
    assert.equal(h.html, '');
  });
});

nodeTest('background thread archive and deletion events refresh facts without changing the selected view', async () => {
  await withFreshnessCase('coder', async (h) => {
    await h.threads([thread()]);
    assert.ok(h.handlers.has('*'), 'all background threads must be subscribed');
    h.ctx.focusedAgentId = 'programming-helper';
    h.setThreads([thread({ lifeState: 'archived', archivedAt: 1, headRuntimeRunning: false })]);
    await h.handlers.get('*')({ type: 'thread.archived', threadId: 't1' });
    assert.equal(h.html, '');
    assert.equal(h.ctx.focusedAgentId, 'programming-helper');
    await h.threads([thread()]);
    h.ctx.allAgents = [h.host];
    h.ctx.run('renderAgentList()');
    h.setThreads([]);
    await h.handlers.get('*')({ type: 'thread.deleted', threadId: 't1' });
    assert.equal(h.html, '');
    assert.ok(h.handlers.has('*'), 'discovery survives deletion and can observe newly created threads');
  });
});

nodeTest('session delta updates ordinary and threaded sidebar titles at the commit boundary', async () => {
  for (const agentId of ['programming-helper', 'coder']) {
    // 每个 agentId 一份 window + 一张 ESM 图（用例内串行两代，不共享状态）
    await withFreshnessCase(agentId, async (h, ops) => {
      if (agentId === 'coder') await h.threads([thread()]);
      h.ctx.run('renderAgentList()');
      const payload = delta();
      // 撤桥后 applySessionMutationDelta 只经命名导出可达（不恢复 window 桥）
      ops.applySessionMutationDelta(h.ctx.allAgents[0].id, payload);
      assert.match(h.html, />New<\//, agentId);
      // A later render must not restore a stale runtime or thread summary title.
      h.ctx.run('renderAgentList()');
      assert.match(h.html, />New<\//, agentId);
      ops.applySessionMutationDelta(h.ctx.allAgents[0].id, delta('Older response', 1));
      assert.match(h.html, />New<\//, 'older revision cannot roll the title back');
    });
  }
});

nodeTest('Enter rename keeps the saved title after the real sidebar redraw', async () => {
  await withFreshnessCase('programming-helper', async (h, ops, items) => {
    const listeners = {};
    h.ctx.run('renderAgentList()');
    const input = { value: '', focus() {}, select() {}, addEventListener: (name, fn) => { listeners[name] = fn; } };
    const name = { textContent: 'Old', querySelector: () => input };
    const item = { classList: { add() {}, remove() {} }, querySelector: () => name };
    h.ctx.document.querySelector = (selector) => selector.includes('data-ctx-id') ? item : null;
    h.ctx.fetch = async () => ({ ok: true, json: async () => delta() });
    // 真实命名导出（零 classic 消费面，不上桥）
    items.ctxRenameSession({ ns: 'programming-helper', id: 'r1', sessionId: 's1' });
    input.value = 'New';
    listeners.keydown({ key: 'Enter', preventDefault() {} });
    await listeners.blur();
    // Drain the asynchronous event handler without advancing a polling timer.
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(h.html, />New<\//);
  });
});

nodeTest('title-only thread refresh is rendered, while identical snapshots remain deduplicated', async () => {
  await withFreshnessCase('coder', async (h) => {
    h.host.workspace_sessions.sessions = [];
    await h.threads([thread()]);
    h.ctx.run('renderAgentList()');
    await h.threads([thread({ headSessionTitle: 'Renamed' })]);
    assert.match(h.html, />Renamed<\//);
    const baseline = h.renders;
    await h.threads([thread({ headSessionTitle: 'Renamed' })]);
    assert.equal(h.renders, baseline);
  });
});

nodeTest('multiple background threads share one subscription without selecting a conversation', async () => {
  await withFreshnessCase('coder', async (h) => {
    await h.threads([thread(), thread({ threadId: 't2', headSessionId: 's2', sessionIds: ['s2'] })]);
    assert.deepEqual([...h.handlers.keys()], ['*']);
    assert.equal(h.ctx.window.ClawThreads.activeConversation, null);
    h.setThreads([thread(), thread({ threadId: 't2', headSessionId: 's2', sessionIds: ['s2'], archivedAt: 1, lifeState: 'archived' })]);
    await h.handlers.get('*')({ type: 'thread.archived', threadId: 't2' });
    assert.equal(h.ctx.window.ClawThreads.byId.t2.lifeState, 'archived');
    assert.equal(h.ctx.window.ClawThreads.activeConversation, null);
    assert.match(h.html, /data-thread-id="t1"/);
  });
});

nodeTest('archival also hides a stale host synthetic runtime', async () => {
  await withFreshnessCase('coder', async (h) => {
    h.ctx.allAgents = [h.host];
    h.host.runtime_session_id = 'r1';
    h.host.active_workspace_session_id = 's1';
    await h.threads([thread({ lifeState: 'archived', archivedAt: 1, headRuntimeRunning: false })]);
    assert.equal(h.html, '');
  });
});

nodeTest('background rendering waits for inline editing and consumes the latest facts afterwards', async () => {
  await withFreshnessCase('programming-helper', async (h) => {
    h.ctx.run('renderAgentList()');
    h.ctx.document.querySelector = () => ({});
    h.host.workspace_sessions.sessions[0].title = 'Changed elsewhere';
    h.ctx.run('renderAgentList()');
    assert.match(h.html, />Old<\//);
    h.ctx.document.querySelector = () => null;
    h.ctx.run('renderAgentList()');
    assert.match(h.html, />Changed elsewhere<\//);
  });
});

nodeTest('assembly runtime retains its agent display name when the session title changes', async () => {
  await withFreshnessCase('agent-studio', async (h) => {
    h.host.workspace_sessions.sessions[0] = { id: 's1', title: 'New', formId: 'assembly-form', agentName: 'My Agent' };
    h.child.active_workspace_display_name = 'My Agent';
    h.ctx.run('renderAgentList()');
    assert.match(h.html, />My Agent<\//);
  });
});

function thread(patch = {}) {
  return {
    agentId: 'coder', threadId: 't1', headSessionId: 's1', sessionIds: ['s1'],
    title: 'Thread', headSessionTitle: 'Old', status: 'open', lifeState: 'executing',
    headRuntimeRunning: true, ...patch,
  };
}

function delta(title = 'New', revision = 2) {
  return { ok: true, sessionDelta: { revision, upsert: [{ id: 's1', title }] } };
}
