/**
 * Tests for public/src/modules/ctx-menu-items.js
 *
 * Covers:
 *   - getCtxMenuItems (menu structure for runtime/session roles)
 *   - getSessionReplacementMutation (Map lookup)
 *   - dispatchCtxAction (action routing to window functions)
 *
 * 装载路线（P2 ESM 配方第三节）：ctx-menu-items / session-mutation /
 * session-menu-decls / assembly-data / session-ui / external-runtime 等已是 ESM，
 * 经 withP2EsmCase 的 `c.load` 真实 import（每 case 整图隔离，含静态依赖）；
 * classic 只剩首屏 bootstrap（action-dispatcher / i18n / app-core /
 * sidebar-render / session-view-state / agent-data-loader）。app-core 注册 kernel
 * 访问器桥（allAgents / currentLanguage / _navigationGuardEpoch …）并交出侧栏
 * 与调用状态宿主工厂；app-main（切换事务宿主）与其它不在链上的 classic owner
 * 以最小宿主替身注入——本文件只消费其调用契约。
 *
 * 真实边界重钉（已迁出实现不经 window 转发）：
 *   - 菜单「精简 / 分支 / 重命名 / 查看历史」现在直接调用 ESM 入口，断言钉在
 *     这些入口的真实用户可见效果上：预览/详情请求的 (agentId, sessionId)、
 *     精简页与分支对话框的 DOM 文案、重命名对话框的标题。
 *   - 右键「激活」走 ESM switchAgent，断言视图绑定到被点击的 runtime（宿主
 *     state 由被测实现写入），不再是「调用过 window.switchAgent」。
 *   - toast 文案断言钉在 ClawToast 真实渲染出的卡片 DOM（title/description/
 *     data-status），而不是注入的 toast 替身。
 */

import { describe, it as nodeIt } from 'node:test';
import assert from 'node:assert/strict';
import { deepEqual as deepLoose } from 'node:assert';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { installForegroundSyncOwner } from './p2-classic-hosts.js';

const OPS = 'public/src/modules/sidebar-operations.js';
const MUTATION = 'public/src/modules/session-mutation.js';
const CTX_MENU = 'public/src/modules/ctx-menu-items.js';

/**
 * Shared test agent data with sessions for programming-helper.
 */
const TEST_AGENT = {
  id: 'programming-helper',
  // ADR-0049：sessionOps 是声明驱动的产品事实（metadata.json），夹具镜像声明；
  // 「移动到…」同为 PH 的声明项（claw:move-session），菜单从声明合成。
  sessionOps: true,
  ui: {
    sessionMenu: {
      items: [
        { id: 'ph.move', label: { zh: '移动到…', en: 'Move to…' }, action: 'claw:move-session' },
      ],
    },
  },
  workspace_sessions: {
    activeSessionId: 'sess-active',
    sessions: [
      { id: 'sess-active', archived: false, todo: false },
      { id: 'sess-archived', archived: true, todo: false },
      { id: 'sess-todo', archived: false, todo: true },
    ],
  },
};

/* ── DOM 夹具：稳定 id 元素（模块顶层 capture）+ 创建记录（toast/对话框） ── */

function makeElement(tag = 'div') {
  return {
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    checked: false,
    type: '',
    style: {},
    dataset: {},
    attributes: {},
    children: [],
    offsetHeight: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    removeChild() {},
    insertAdjacentHTML() {},
    remove() {},
    replaceWith() {},
    focus() {},
    select() {},
    getAttribute(name) { return this.attributes[name] ?? null; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute() {},
    getBoundingClientRect() { return { right: 0, bottom: 0 }; },
    querySelector() { return makeElement(); },
    querySelectorAll() { return []; },
  };
}

function createDocumentStub() {
  const elements = new Map();
  const created = [];
  const stable = (id) => {
    if (!elements.has(id)) {
      const el = makeElement();
      el.id = id;
      elements.set(id, el);
    }
    return elements.get(id);
  };
  return {
    elements,
    created,
    document: {
      getElementById: (id) => stable(id),
      createElement: (tag) => { const el = makeElement(tag); created.push(el); return el; },
      createTextNode: (text) => ({ textContent: String(text) }),
      querySelector: () => makeElement(),
      querySelectorAll: () => [],
      addEventListener() {},
      body: makeElement('body'),
      head: makeElement('head'),
      documentElement: makeElement('html'),
      readyState: 'complete',
      execCommand: () => true,
    },
  };
}

/** 按 className 在创建记录里找一个卡片/子节点（toast 卡片结构）。 */
function findByClass(root, className) {
  const queue = [root];
  while (queue.length > 0) {
    const el = queue.shift();
    if (el.className === className) return el;
    queue.push(...(el.children || []));
  }
  return null;
}

const toastCards = (doc) => doc.created.filter((el) => el.className === 'toast-card');

/* ── classic 宿主面（本文件消费其调用契约，不含业务实现） ── */

/** classic 真源优先：只补齐 bootstrap 尚未声明的宿主全局。 */
function fillMissingGlobals(sandbox, stubs) {
  for (const [name, value] of Object.entries(stubs)) {
    if (sandbox.run(`typeof ${name} !== 'undefined'`)) continue;
    sandbox[name] = value;
  }
}

/**
 * 切换事务宿主（owner: classic app-main，本链不加载）。ESM switchAgent /
 * requestSwitch 经它调用 classic 侧的渲染、数据加载与视图绑定；这里只提供
 * 调用契约，并把「切到哪个 runtime」记在 `state.runtimeId` 与 switchCalls 上。
 */
function createRuntimeSwitchHost(sandbox, switchCalls, bindCalls) {
  return {
    state: {},
    switchAgent: (id) => { switchCalls.push(id); return Promise.resolve(); },
    bindSession: (runtimeId) => { bindCalls.push(runtimeId); },
    setTimeout: (callback, delay) => sandbox.setTimeout(callback, delay),
    hasPendingNavigation: () => false,
    bumpNavigationGuard: () => {},
    closeContextMenu: () => {},
    findAgent: (id) => (sandbox.allAgents || []).find((agent) => agent.id === id) || null,
    isWorkspaceHost: () => false,
    runtimeId: (agent) => agent?.runtime_session_id || '',
    agentRuntimeId: (agent) => agent?.runtime_session_id || '',
    isRemote: (id) => String(id || '').startsWith('remote:'),
    remote: () => sandbox.window.RemoteConnections,
    closeReadOnlySession: () => {},
    isWorkspaceSurface: () => false,
    selectWorkspace: () => {},
    storeDraft: () => {},
    saveWorkspaceScroll: () => {},
    saveCache: () => {},
    logicalId: (agent) => agent?.parent_id || agent?.id || null,
    normalize: (id) => String(id || '').trim(),
    clearFinished: () => {},
    deriveSession: () => null,
    updateThreadIndicators: () => {},
    browseOnly: () => false,
    resetSurface: () => {},
    resetScroll: () => {},
    resetStatus: () => {},
    activateCollapse: () => {},
    contextKey: () => '',
    restoreCache: () => null,
    setPendingScroll: () => {},
    render: () => {},
    renderPanel: () => {},
    patch: () => {},
    emptyOverview: () => ({}),
    emptyTodo: () => ({}),
    setFollowLatest: () => {},
    beginFollowWindows: () => {},
    renderAgents: () => {},
    fetch: (url) => sandbox.fetch(url),
    applyCalling: () => {},
    isCalling: () => false,
    syncActionButton: () => {},
    persistFocus: () => {},
    loadData: async () => {},
    loadAgents: async () => {},
    clearLoading: () => {},
    alert: (message) => sandbox.window.alert(message),
    // 切换事务里的告警直通用例 console（即 console 守卫记录器），不静音
    warn: (...args) => sandbox.console.warn(...args),
    error: (...args) => sandbox.console.error(...args),
  };
}

/* ── 用例地基 ── */

/** 当前用例的沙箱与夹具；由 it 包装器建立。 */
let activeCase = null;

/**
 * 真实 wire 的 fetch 替身：按端点回答与生产同形状的响应，让 classic `invoke`
 * （app-core 的真实实现）拿到正确类型的载荷——连接快照是数组、viewer 是
 * `{ agents }`、动作端点回执是对象。端点级差异经 `fixture.wireOverrides`
 * 覆盖，未覆盖的端点一律按真实形状回答，避免 `{}` 泄漏成 TypeError。
 */
function createWireFetch(fixture) {
  const jsonResponse = (payload) => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => '',
  });
  return async (url, options = {}) => {
    const target = String(url);
    const method = options.method || 'GET';
    fixture.fetchCalls.push({ url: target, method, body: options.body });
    for (const [prefix, handler] of fixture.wireOverrides) {
      if (!target.startsWith(prefix)) continue;
      const result = await handler({ url: target, method, body: options.body, options });
      if (result !== undefined) return result;
    }
    if (target.startsWith('/protoclaw/get_connected_agents')) return jsonResponse(fixture.connected);
    if (target.startsWith('/protoclaw/get_prebuilt_agents')) return jsonResponse([]);
    if (target === '/api/agents') return jsonResponse({ agents: fixture.viewerAgents });
    if (target.startsWith('/protoclaw/ph_project/projects')) return jsonResponse({ projects: [] });
    if (target.startsWith('/protoclaw/session_trim_preview')) return jsonResponse({ rounds: [], messages: [] });
    if (target.startsWith('/protoclaw/threads/')) return jsonResponse({ ok: true, threadId: 'wt-1', cleanup: {} });
    if (target.startsWith('/protoclaw/workspace_settings/sidebar_sessions')) return jsonResponse({ ok: true });
    return jsonResponse({ ok: true });
  };
}

function bootstrapClassic(sandbox, fixture) {
  const { doc } = fixture;
  sandbox.loadSource('public/src/modules/action-dispatcher.js');
  // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
  sandbox.loadSource('public/src/app-core.js');
  // 引擎（app-main）在装载期组合 sidebar-render 的**真实**
  // createAgentCallStatesHost（读 runtime-status 的 _agentSuspended）：按生产
  // 先行脚本序装真链，不复制宿主实现。
  sandbox.loadSource('public/src/modules/runtime-status.js');
  sandbox.loadSource('public/src/modules/sidebar-render.js');
  sandbox.loadSource('public/src/modules/session-view-state.js');
  // runtime-status 的切换重置会经该视口守卫（owner: chat-viewport）：本图不驱动
  // 视口，按宿主缝合上皮。
  sandbox.runWithSuppressedChatViewportObservers = (fn) => (typeof fn === 'function' ? fn() : undefined);
  // 常驻输入 / 通知链的 classic 汇点（owner: persistent-input）：真实
  // runtime-status 的通知渲染会裸调它们，本图不断言这些控件。
  if (typeof sandbox._syncPersistentActionButton !== 'function') sandbox._syncPersistentActionButton = () => {};
  if (typeof sandbox._syncPersistentInputUi !== 'function') sandbox._syncPersistentInputUi = () => {};
  installForegroundSyncOwner(sandbox);
  // 不在本链上的 classic 宿主工厂（app-main / app-ui / 侧栏装载器 / 布局）：
  // 逐项覆盖真实工厂里 `typeof x === 'function' ? x() : …` 的调用目标，
  // 缺键会让成功路径变成 ReferenceError，因此显式提供而非依赖吞错。
  sandbox.AgentLoaderHost = { loadedAgentDetailIds: new Set() };
  // 数据加载图静态依赖（agent-data-loader → input-actions）在装载期取 app-main
  // 的轮询宿主工厂；本文件不驱动轮询。
  sandbox.createPollCoordinatorHost = () => ({});
  sandbox.createRuntimeSwitchHost = () => {
    fixture.switchHost = createRuntimeSwitchHost(sandbox, fixture.switchCalls, fixture.bindCalls);
    return fixture.switchHost;
  };
  // app-ui 的真实工厂在用例里不装载（其顶层会注册 ClawHost block 与面板），
  // 故按其宿主契约提供同形 facade：query 类读真实经典状态，副作用类转发到
  // 本 harness 的记录点。偏好/标签页读取归 app-ui，未装载时按「无偏好」空值
  // 回答（不复制 app-ui 的策略）。
  sandbox.createWorkspaceSurfaceHost = () => ({
    bumpNavigationGuard: () => sandbox.bumpNavigationGuard(),
    closeReadOnlySession: () => {},
    hasDetail: (id) => sandbox.AgentLoaderHost.loadedAgentDetailIds.has(id),
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
    bindWorkspace: (agentId) => { fixture.surfaceBindings.push([agentId]); },
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
  // app-main 的桥接全局（runtime-status-loader 的 ownerRecord 经
  // `window.getCurrentRuntimeRecord() || window.getCurrentAgentRecord()` 取当前记录，
  // 源码注释标为「定义于 app-main，编排域收敛时移除」）。app-main 末尾的启动 IIFE
  // 会拉起轮询与网络，用例里不能跑，故以同一份经典状态的投影补齐：
  //   - 宿主记录 = focusedAgentId 在 allAgents 里的身份投影（无策略分支）
  //   - 运行时记录 = app-core 真实 getRuntimeRecord(当前 runtime)，回退宿主记录
  const resolveHostRecord = () => {
    const hostId = sandbox.normalizeAgentIdentity(sandbox.focusedAgentId);
    if (!hostId) return null;
    return (sandbox.allAgents || []).find(
      (agent) => sandbox.normalizeAgentIdentity(agent?.id) === hostId,
    ) || null;
  };
  sandbox.getCurrentAgentRecord = resolveHostRecord;
  sandbox.getCurrentRuntimeRecord = () => sandbox.getRuntimeRecord(sandbox.currentRuntimeAgentId) || resolveHostRecord();
  sandbox.createCompactResumeHost = () => ({ state: {}, now: () => Date.now() });
  sandbox.window.ClawSidebarLayout = {
    isInteracting: () => false,
    signature: () => 'fixture-layout',
    load: async () => {},
    render: () => {},
    toggle: () => {},
  };
  fillMissingGlobals(sandbox, {
    renderAgentList: () => {},
    renderCurrentMainView: () => {},
    renderFeaturePanel: () => {},
    updateAgentRecord: () => {},
    runWorkspaceAction: () => {},
    closeCtxMenu: () => {},
    closeCompactMenu: () => {},
    closeProjectContextMenu: () => {},
    closeAgentContextMenu: () => {},
    alert: () => {},
    confirm: () => false,
    isRemoteNamespaceAgentId: (id) => typeof id === 'string' && id.startsWith('remote:'),
    performance: { now: () => 0 },
    setPreferredUnitMode: () => {},
    resolveFocusedAgentAfterRefresh: () => null,
    handlePrebuiltAgentClick: () => {},
    loadAgentDetail: async () => ({}),
    selectWorkspaceSurface: () => {},
    refreshAgentCallStates: async () => {},
    getVisibleRemoteEntries: () => [],
    resetRuntimeStatusForSwitch: () => {},
    patchRuntimeStatusForSwitch: () => {},
    updateRollbackActionVisibility: () => {},
    renderRollbackActions: () => {},
    applyContextGuardStatus: () => {},
    updateNotificationStatus: () => {},
  });
  sandbox.document = doc.document;
  sandbox.window.document = doc.document;
}

/**
 * console 记录器：直通宿主 console（不吞输出），按等级收集供断言。
 * 词法捕获宿主 console——用例期间 globalThis.console 就是 recorder。
 */
function createConsoleRecorder() {
  const host = globalThis.console;
  const entries = { error: [], warn: [], log: [] };
  const format = (args) => args
    .map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}\n${arg.stack}` : String(arg)))
    .join(' ');
  return {
    entries,
    recorder: {
      ...host,
      error: (...args) => { entries.error.push(format(args)); host.error(...args); },
      warn: (...args) => { entries.warn.push(format(args)); host.warn(...args); },
      log: (...args) => { entries.log.push(format(args)); host.log(...args); },
      info: (...args) => { entries.log.push(format(args)); host.info(...args); },
    },
  };
}

/**
 * 用例包装。平台全局（fetch / navigator / console / document / CSS）全部经
 * withP2EsmCase 的 `globals` 托管：用例结束时 helper 按原 descriptor 恢复，
 * 测试体不再直接写 `globalThis`。
 *
 * `options.globals` 用于用例级平台面（如 copy-id 需要的 navigator.clipboard）；
 * `options.expectConsole` 声明该用例**预期**出现的 console 行，其余任何
 * error / warn 都会让用例失败——成功路径的 TypeError / ReferenceError 不会被吞。
 */
function it(name, fn, options = {}) {
  nodeIt(name, async () => {
    const doc = createDocumentStub();
    const fixture = {
      doc,
      calls: [],
      switchCalls: [],
      bindCalls: [],
      switchHost: null,
      surfaceBindings: [],
      fetchCalls: [],
      fetchRef: { current: null },
      // wire 事实：连接快照（数组）/ viewer 存活 / 端点级覆盖
      connected: [{
        id: 'programming-helper',
        name: 'PH',
        source: 'prebuilt',
        connected: true,
        workspace_sessions: { revision: 1, activeSessionId: 'sess-active', sessions: [] },
      }],
      viewerAgents: [],
      wireOverrides: [],
    };
    fixture.fetchRef.current = createWireFetch(fixture);
    const { recorder, entries } = createConsoleRecorder();
    const { globals: extraGlobals = {}, expectConsole = [] } = options;
    await withP2EsmCase({
      classic: (sandbox) => bootstrapClassic(sandbox, fixture),
      globals: {
        document: doc.document,
        // ESM 侧以裸标识符使用（浏览器里就是 window.CSS）
        CSS: { escape: (value) => String(value) },
        console: recorder,
        fetch: (...args) => fixture.fetchRef.current(...args),
        ...extraGlobals,
      },
    }, async (c) => {
      await c.load('public/src/modules/agent-data-loader.js');
      await c.load('public/src/modules/project-data.js');
      const ops = await c.load(OPS);
      // sidebar-operations 已把 beginSidebarOperation 从 KernelState 桥注销（消费方
      // 一律具名 import）：classic 侧脚本按**模块命名空间**调用同一批 ESM 导出。
      c.expose('SidebarOps', ops);
      await c.load(MUTATION);
      await c.load(CTX_MENU);
      activeCase = { ctx: c.sandbox, ...fixture };
      try {
        const result = await fn();
        const unexpected = [...entries.error, ...entries.warn]
          .filter((line) => !expectConsole.some((pattern) => pattern.test(line)));
        assert.deepEqual(unexpected, [], '成功路径不应产生未预期的 console.error / console.warn');
        return result;
      } finally {
        activeCase = null;
      }
    });
  });
}

/**
 * 取当前用例的装载面：`overrides` 在装载后生效（状态键写经 kernel 访问器桥）。
 * 平台面（fetch / navigator / console）不在这里写主 realm：
 *   - `fetch` 经用例级代理转发（`fetchRef`），classic 与 ESM 侧看到同一实现；
 *   - `navigator` 必须由用例声明期的 `it(..., { globals })` 提供（helper 托管恢复）。
 * 返回 { ctx, calls, doc } 与迁移前一致；`doc` 是本用例的 DOM 夹具。
 */
function loadCtxMenuItems(overrides = {}) {
  if (!activeCase) throw new Error('loadCtxMenuItems 必须在用例体内调用');
  const { ctx, calls, doc, fetchRef } = activeCase;
  if (!('allAgents' in overrides)) ctx.allAgents = [TEST_AGENT];
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'navigator') {
      throw new Error('navigator 必须在用例声明期经 it(..., { globals: { navigator } }) 提供');
    }
    if (key === 'connected') {
      // 覆盖连接快照 wire（真实 invoke 直接返回 res.json()，即数组）
      activeCase.connected = value;
      continue;
    }
    if (key === 'wire') {
      // 端点级覆盖：[[前缀, handler], ...]；handler 返回 undefined 表示回落默认 wire
      activeCase.wireOverrides.push(...value);
      continue;
    }
    if (key === 'fetch') {
      fetchRef.current = value;
      ctx.fetch = value;
      continue;
    }
    ctx[key] = value;
  }
  // Window 函数 stubs with call recording（仍是 classic 消费面的那些）
  ctx.window.closeCtxMenu = () => { calls.push({ fn: 'closeCtxMenu' }); };
  ctx.window.runWorkspaceAction = (json) => { calls.push({ fn: 'runWorkspaceAction', args: [json] }); };
  ctx.window.confirm = () => false;
  ctx.window.alert = () => {};
  return { ctx, calls, doc };
}

describe('ctx-menu-items: explicit restart identity', () => {
  it('uses the clicked child session even when the runtime catalog is stale', async () => {
    const { ctx } = loadCtxMenuItems({
      // 场景事实改为「目录里确有该 child runtime」——真实 getExternalRuntimeAgent
      // 读 agent store（不再经注入的函数替身）。
      allAgents: [TEST_AGENT, {
        id: 'rt-old', source: 'child', parent_id: 'programming-helper',
        active_workspace_session_id: 'directory-session',
      }],
    });
    // 公开入口：右键「重启」动作（内部即 ctxRestartAgent 的真实身份解析）。
    // 重启提交后的续体（loadAgents 刷新）在用例内跑完，不落进下一个 case。
    await ctx.run(`(async () => {
      await dispatchCtxAction('restart', { ns: 'programming-helper', id: 'rt-old', sessionId: 'project-session', variant: 'child' });
      await new Promise((resolve) => setTimeout(resolve, 10));
    })()`);
    // 真实 IPC → HTTP：断言到达服务端的那一次重启请求（app-core invoke 的 wire）
    const restarts = activeCase.fetchCalls.filter((entry) => entry.url === '/protoclaw/restart_agent');
    assert.equal(restarts.length, 1, '恰好一次重启请求');
    assert.equal(restarts[0].method, 'POST');
    assert.deepEqual(JSON.parse(restarts[0].body), {
      agentId: 'programming-helper',
      sessionId: 'project-session',
    }, '寻址用被点击的 child session，不用陈旧的 catalog');
  });
});

// ── getCtxMenuItems: runtime role ───────────────────────────

describe('ctx-menu-items: getCtxMenuItems (runtime)', () => {
  it('runtime + programming-helper → unified conversation menu (no thread data)', () => {
    const { ctx } = loadCtxMenuItems();
    const items = ctx.run(`getCtxMenuItems('runtime', 'programming-helper', 'managed-runtime', 'rt-1')`);
    // All content-changing operations are grouped: rename parent includes AI title;
    // continuity parent includes Summary, Trim, and Branch. Declared item
    // (Move to…) appends after the builtin family (ADR-0049).
    assert.equal(items.length, 14);
    assert.equal(items[0].action, 'rename');
    assert.deepEqual(Array.from(items[0].submenu, (item) => item.action), ['generate-title']);
    assert.equal(items[1].action, 'todo-session');
    assert.equal(items[1].label, '设为待办'); // active session todo=false → set
    assert.equal(items[2].action, 'copy-id');
    assert.equal(items[3].type, 'separator');
    assert.equal(items[4].label, '会话接续');
    assert.deepEqual(Array.from(items[4].submenu, (item) => item.action), ['summary', 'trim', 'branch']);
    assert.deepEqual(Array.from(items[4].submenu, (item) => item.label), ['总结历史', '精简历史', '创建分支']);
    assert.equal(items[5].type, 'separator');
    assert.equal(items[6].action, 'archive-and-stop');
    assert.equal(items[6].label, '归档');
    assert.equal(items[7].type, 'separator');
    assert.equal(items[8].action, 'restart');
    assert.equal(items[9].action, 'stop');
    assert.equal(items[9].danger, true);
    assert.equal(items[10].type, 'separator');
    assert.equal(items[11].action, 'delete-session-runtime');
    assert.equal(items[11].danger, true);
    // 声明段：分隔线 + 「移动到…」（PH 声明项，动作带 claw: 前缀绑定）
    assert.equal(items[12].type, 'separator');
    assert.equal(items[13].action, 'claw:move-session');
    assert.equal(items[13].label, '移动到…');
    // 无线程数据时不出现线程专属动作与「停止」
    assert.ok(!items.find((i) => i.action === 'thread-archive'));
    assert.ok(!items.find((i) => i.action === 'thread-interrupt'));
    assert.ok(!items.find((i) => i.action === 'open-history'));
  });

  it('runtime with archived active session → unarchive label, no todo item', () => {
    const { ctx } = loadCtxMenuItems({
      allAgents: [{
        id: 'programming-helper',
        sessionOps: true,
        workspace_sessions: {
          activeSessionId: 'sess-archived',
          sessions: [{ id: 'sess-archived', archived: true }],
        },
      }],
    });
    const items = ctx.run(`getCtxMenuItems('runtime', 'programming-helper', 'managed-runtime', 'rt-1')`);
    const archiveItem = items.find((i) => i.action === 'archive-and-stop');
    assert.ok(archiveItem.label.includes('取消归档'));
    assert.ok(!items.find((i) => i.action === 'todo-session'));
  });

  it('runtime sessionId param resolves the targeted session for the todo label', () => {
    // Multiple runtimes coexist: the entry carries its own sessionId, which may
    // differ from the host's activeSessionId — the todo label must reflect the
    // targeted session, not the active one.
    const { ctx } = loadCtxMenuItems();
    const items = ctx.run(`getCtxMenuItems('runtime', 'programming-helper', 'managed-runtime', 'rt-1', 'sess-todo')`);
    const todoItem = items.find((i) => i.action === 'todo-session');
    assert.equal(todoItem.label, '取消待办');
  });
});

// ── getCtxMenuItems: session role ───────────────────────────

describe('ctx-menu-items: getCtxMenuItems (session)', () => {
  it('session main (not archived, not todo) → unified menu, direct transforms', () => {
    const { ctx } = loadCtxMenuItems();
    const items = ctx.run(`getCtxMenuItems('session', 'programming-helper', 'main', 'sess-active')`);
    assert.equal(items.length, 11);
    assert.equal(items[0].action, 'rename-session');
    assert.deepEqual(Array.from(items[0].submenu, (item) => item.action), ['generate-title']);
    assert.equal(items[1].action, 'todo-session'); // not todo → set
    assert.equal(items[1].label, '设为待办');
    assert.equal(items[2].action, 'copy-id');
    assert.equal(items[3].type, 'separator');
    assert.equal(items[4].label, '会话接续');
    assert.deepEqual(Array.from(items[4].submenu, (item) => item.action), ['summary', 'trim', 'branch']);
    assert.deepEqual(Array.from(items[4].submenu, (item) => item.label), ['总结历史', '精简历史', '创建分支']);
    assert.equal(items[5].type, 'separator');
    assert.equal(items[6].action, 'archive-session');
    assert.equal(items[6].label, '归档');
    assert.equal(items[7].type, 'separator');
    assert.equal(items[8].action, 'delete-session');
    assert.equal(items[8].danger, true);
    // 声明段（ADR-0049）：分隔线 + 「移动到…」
    assert.equal(items[9].type, 'separator');
    assert.equal(items[10].action, 'claw:move-session');
  });

  it('session archived → same menu shape, unarchive label, no todo', () => {
    const { ctx } = loadCtxMenuItems();
    const items = ctx.run(`getCtxMenuItems('session', 'programming-helper', 'archived', 'sess-archived')`);
    assert.equal(items.length, 10);
    const continuityItem = items.find((i) => i.label === '会话接续');
    assert.ok(continuityItem, 'archived conversations still offer continuity actions');
    assert.deepEqual(Array.from(continuityItem.submenu, (item) => item.action), ['summary', 'trim', 'branch']);
    const archiveItem = items.find((i) => i.action === 'archive-session');
    assert.ok(archiveItem.label.includes('取消归档'));
    // No todo toggle for archived
    assert.ok(!items.find((i) => i.action === 'todo-session'));
  });

  it('session with thread data → thread-semantics archive and history entry', () => {
    // 线程会话：归档动作走线程端点，归档状态以线程 lifeState 为准；
    // 有历史存档时出现「查看历史 (N)」；归档线程行不再呈现待办。
    const { ctx } = loadCtxMenuItems();
    ctx.window.getThreadForSession = (agentId, sessionId) => (sessionId === 'sess-threaded'
      ? { threadId: 'wt-1', headSessionId: 'sess-threaded', lifeState: 'open', sessionIds: ['sess-threaded', 's-old-1', 's-old-2'] }
      : null);
    const items = ctx.run(`getCtxMenuItems('session', 'programming-helper', 'main', 'sess-threaded')`);
    const archiveItem = items.find((i) => i.action === 'thread-archive');
    assert.ok(archiveItem, 'threaded conversation archives via the thread endpoint');
    assert.equal(archiveItem.label, '归档');
    const historyItem = items.find((i) => i.action === 'open-history');
    assert.ok(historyItem, 'history entry appears when archives exist');
    assert.ok(historyItem.label.includes('2'), 'history count reflects archive count');
    assert.ok(items.find((i) => i.action === 'todo-session'), 'open thread keeps todo toggle');
  });

  it('session with archived thread → unarchive via thread endpoint even if row sits in main list', () => {
    // 服务端线程归档不写 session index 的 archived 位：行可能仍在主列表，
    // 菜单必须以线程 lifeState 为准给出「取消归档」并走线程端点。
    const { ctx } = loadCtxMenuItems();
    ctx.window.getThreadForSession = () => ({ threadId: 'wt-2', headSessionId: 'sess-x', lifeState: 'archived', sessionIds: ['sess-x'] });
    const items = ctx.run(`getCtxMenuItems('session', 'programming-helper', 'main', 'sess-x')`);
    const archiveItem = items.find((i) => i.action === 'thread-unarchive');
    assert.ok(archiveItem, 'archived thread offers thread unarchive');
    assert.ok(archiveItem.label.includes('取消归档'));
    assert.ok(!items.find((i) => i.action === 'todo-session'), 'archived thread hides todo');
  });

  it('session todo=true → "取消待办" label', () => {
    const { ctx } = loadCtxMenuItems();
    const items = ctx.run(`getCtxMenuItems('session', 'programming-helper', 'main', 'sess-todo')`);
    const todoItem = items.find((i) => i.action === 'todo-session');
    assert.equal(todoItem.label, '取消待办');
  });

  it('unknown role → empty array', () => {
    const { ctx } = loadCtxMenuItems();
    deepLoose(ctx.run(`getCtxMenuItems('unknown', 'ph', 'main', 's1')`), []);
  });

  it('English labels when currentLanguage=en', () => {
    const { ctx } = loadCtxMenuItems({ currentLanguage: 'en' });
    const items = ctx.run(`getCtxMenuItems('session', 'programming-helper', 'main', 'sess-active')`);
    const del = items.find((i) => i.action === 'delete-session');
    assert.equal(del.label, 'Delete Conversation');
    const copyItem = items.find((i) => i.action === 'copy-id');
    assert.equal(copyItem.label, 'Copy ID');
  });
});

// ── getSessionReplacementMutation ───────────────────────────

describe('ctx-menu-items: getSessionReplacementMutation', () => {
  it('found → mutation object', () => {
    const { ctx } = loadCtxMenuItems();
    ctx.run(`SidebarOps.beginSidebarOperation({
      operationId: 'summary:test', type: 'replacement', agentId: 'agent1',
      sourceSessionId: 'sess1', kind: 'summary', phase: 'generating', startedAt: 12345,
    })`);
    const result = ctx.run(`getSessionReplacementMutation('agent1', 'sess1')`);
    assert.equal(result.agentId, 'agent1');
    assert.equal(result.sessionId, 'sess1');
    assert.equal(result.kind, 'summary');
  });

  it('not found → null', () => {
    const { ctx } = loadCtxMenuItems();
    assert.equal(ctx.run(`getSessionReplacementMutation('agent1', 'nonexistent')`), null);
  });

  it('empty args → null', () => {
    const { ctx } = loadCtxMenuItems();
    assert.equal(ctx.run(`getSessionReplacementMutation('', '')`), null);
  });
});

// ── dispatchCtxAction: routing ──────────────────────────────

describe('ctx-menu-items: dispatchCtxAction (routing)', () => {
  it('activate → the real switch binds the view to the clicked runtime', async () => {
    // 快照事实：被点击的 runtime 是 programming-helper 名下存活的 child
    // （真实 get_connected_agents 会把 child 作为独立条目下发，focused 因此
    // 在刷新后仍能解析到它，不会触发「焦点丢失 → 回退工作台面」分支）。
    const { ctx } = loadCtxMenuItems({
      connected: [
        {
          id: 'programming-helper',
          name: 'PH',
          source: 'prebuilt',
          connected: true,
          workspace_sessions: { revision: 1, activeSessionId: 's1', sessions: [] },
        },
        {
          id: 'rt-1',
          name: 'rt-1',
          source: 'child',
          parent_id: 'programming-helper',
          connected: true,
          active_workspace_session_id: 's1',
        },
      ],
    });
    ctx.run(`dispatchCtxAction('activate', { id: 'rt-1', ns: 'ph', sessionId: 's1' })`);
    // ESM switchAgent 同步写入宿主事务 state：视图绑定到被点击的 runtime。
    assert.equal(activeCase.switchHost.state.runtimeId, 'rt-1');
    assert.equal(activeCase.switchHost.state.focusedAgentId, 'rt-1');
    assert.deepEqual(activeCase.bindCalls, ['rt-1'], '会话绑定到被点击的 runtime');
    // 切换后续的正文加载在用例内跑完，续体不落进下一个 case。
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('summary → window.runWorkspaceAction with compactType summary', () => {
    const { ctx, calls } = loadCtxMenuItems();
    ctx.run(`dispatchCtxAction('summary', { ns: 'ph', id: 's1', sessionId: 's1' })`);
    assert.equal(calls[0].fn, 'runWorkspaceAction');
    const payload = JSON.parse(calls[0].args[0]);
    assert.equal(payload.type, 'compact_session_menu');
    assert.equal(payload.compactType, 'summary');
    assert.equal(payload.archiveOriginal, undefined, 'menu summary no longer archives the original');
  });

  it('trim → the real trim page opens for the targeted session', async () => {
    const { ctx, doc } = loadCtxMenuItems();
    ctx.run(`dispatchCtxAction('trim', { ns: 'ph', id: 's1', sessionId: 's1' })`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const previews = activeCase.fetchCalls.filter((entry) => entry.url === '/protoclaw/session_trim_preview?agentId=ph&sessionId=s1');
    assert.equal(previews.length, 1, 'trim preview requested once for ns + sessionId');
    assert.equal(activeCase.fetchCalls.length, 1, 'trim 打开只发一次预览请求');
    assert.equal(doc.elements.get('trim-page-title').textContent, '精简对话', 'trim page opened');
    assert.equal(doc.elements.get('branch-submit')?.textContent || '', '', 'branch dialog untouched');
  });

  it('branch → the real branch dialog opens for the targeted session', async () => {
    const { ctx, doc } = loadCtxMenuItems();
    ctx.run(`dispatchCtxAction('branch', { ns: 'ph', id: 's1', sessionId: 's1' })`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const previews = activeCase.fetchCalls.filter((entry) => entry.url === '/protoclaw/session_trim_preview?agentId=ph&sessionId=s1');
    assert.equal(previews.length, 1, 'branch preview requested once for ns + sessionId');
    assert.equal(activeCase.fetchCalls.length, 1, 'branch 打开只发一次预览请求');
    assert.equal(doc.elements.get('branch-submit').textContent, '创建分支', 'branch dialog opened');
    assert.equal(doc.elements.get('trim-page-title').textContent, '', 'trim page untouched');
  });

  // 归档 toast 按服务端 cleanup 事实展示：空闲归档只报结果；真的取消了
  // 排队消息才说明后果，且不得残留「指令」类内部术语。
  describe('thread-archive toast follows cleanup facts', () => {
    const archiveDispatch = async (cleanup) => {
      const { ctx, doc } = loadCtxMenuItems({
        currentRuntimeAgentId: '',
        // 只覆盖归档端点，其余端点仍按真实 wire 形状回答（连接快照保持数组）
        wire: [[
          '/protoclaw/threads/',
          async () => ({ ok: true, status: 200, json: async () => ({ ok: true, threadId: 'wt-1', cleanup }), text: async () => '' }),
        ]],
      });
      ctx.window.getThreadById = () => ({ threadId: 'wt-1', agentId: 'programming-helper', headViewerAgentId: 'rt-1' });
      ctx.window.refreshThreads = async () => ({ ok: true });
      await ctx.run(`dispatchCtxAction('thread-archive', { ns: 'programming-helper', id: 'rt-1', sessionId: 's1', threadId: 'wt-1' })`);
      // thread-archive 经 async IIFE 提交（提交回执即返回），等宏任务让 toast 落地
      await new Promise((resolve) => setTimeout(resolve, 0));
      return toastCards(doc);
    };

    it('idle archive: reports the result without inventing cancelled-message reminders', async () => {
      const cards = await archiveDispatch({ status: 'complete', commandsCancelled: 0, handoffConverged: false, inflightDrain: { count: 0 } });
      assert.equal(cards.length, 1);
      assert.equal(cards[0].attributes['data-status'], 'success');
      assert.equal(findByClass(cards[0], 'toast-title').textContent, '已归档');
      assert.equal(findByClass(cards[0], 'toast-desc'), null, 'nothing was cancelled — no description');
    });

    it('archive with cancelled commands: explains the consequence in user language', async () => {
      const cards = await archiveDispatch({ status: 'complete', commandsCancelled: 2, handoffConverged: true, inflightDrain: { count: 1 } });
      assert.equal(cards.length, 1);
      assert.equal(findByClass(cards[0], 'toast-title').textContent, '已归档');
      const description = String(findByClass(cards[0], 'toast-desc')?.textContent || '');
      assert.ok(description.includes('2 条排队中的消息已取消'), `description: ${description}`);
      assert.ok(description.includes('不会自动重新发送'), `description: ${description}`);
      assert.ok(!description.includes('指令'), 'no internal jargon in user-facing copy');
    });
  });

  it('rename-session → the real rename dialog opens for the session', () => {
    const { ctx, doc } = loadCtxMenuItems();
    ctx.run(`dispatchCtxAction('rename-session', { ns: 'programming-helper', id: 's1', sessionId: 'sess-active' })`);
    const dialogs = doc.created.filter((el) => String(el.innerHTML).includes('重命名对话'));
    assert.equal(dialogs.length, 1, 'rename dialog must open for the main-list role');
    assert.ok(String(dialogs[0].innerHTML).includes('sess-active'), 'dialog carries the targeted session title fallback');
    assert.equal(activeCase.fetchCalls.length, 0, '打开重命名对话框不发请求（保存才 PUT）');
  });

  it('open-history → the real history panel loads the resolved thread', async () => {
    const { ctx } = loadCtxMenuItems();
    ctx.window.getThreadForSession = () => ({ threadId: 'wt-hist', headSessionId: 's1', lifeState: 'open' });
    ctx.run(`dispatchCtxAction('open-history', { ns: 'ph', id: 's1', sessionId: 's1' })`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(
      activeCase.fetchCalls.filter((entry) => entry.url.includes('/protoclaw/threads/')).map((entry) => entry.url),
      ['/protoclaw/threads/wt-hist'],
      'history panel requests the resolved thread id exactly once',
    );
  });

  it('delete-session → runWorkspaceAction with delete type', () => {
    const { ctx, calls } = loadCtxMenuItems();
    ctx.run(`dispatchCtxAction('delete-session', { ns: 'ph', id: 's1', sessionId: 's1' })`);
    const closeCall = calls.find((c) => c.fn === 'closeCtxMenu');
    const wsCall = calls.find((c) => c.fn === 'runWorkspaceAction');
    assert.ok(closeCall, 'should call closeCtxMenu');
    assert.ok(wsCall, 'should call runWorkspaceAction');
    const payload = JSON.parse(wsCall.args[0]);
    assert.equal(payload.type, 'delete_session');
    assert.equal(payload.sessionId, 's1');
  });
});

// ── dispatchCtxAction: ctx* routes call closeCtxMenu ────────

describe('ctx-menu-items: dispatchCtxAction (ctx* routes)', () => {
  // ctx* 路由在 async IIFE 里提交请求；用例等其收尾，避免续体跑进下一个 case。
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  it('restart → calls closeCtxMenu', async () => {
    const { ctx, calls } = loadCtxMenuItems();
    ctx.run(`dispatchCtxAction('restart', { ns: 'ph', id: 'rt-1', sessionId: 's1' })`);
    await settle();
    assert.ok(calls.find((c) => c.fn === 'closeCtxMenu'));
  });

  it('stop → calls closeCtxMenu', async () => {
    const { ctx, calls } = loadCtxMenuItems();
    ctx.run(`dispatchCtxAction('stop', { ns: 'ph', id: 'rt-1', sessionId: 's1' })`);
    await settle();
    assert.ok(calls.find((c) => c.fn === 'closeCtxMenu'));
  });

  it('rename with ns+sessionId → calls closeCtxMenu', async () => {
    const { ctx, calls } = loadCtxMenuItems();
    ctx.run(`dispatchCtxAction('rename', { ns: 'ph', id: 'rt-1', sessionId: 's1' })`);
    await settle();
    assert.ok(calls.find((c) => c.fn === 'closeCtxMenu'));
  });
});

// ── dispatchCtxAction: edge cases ───────────────────────────

describe('ctx-menu-items: dispatchCtxAction (edge cases)', () => {
  it('unknown action → no crash', () => {
    const { ctx } = loadCtxMenuItems();
    ctx.run(`dispatchCtxAction('totally-unknown', { ns: 'ph', id: 'rt-1' })`);
    // 不抛错——落到 default 分支的 console.warn（预期日志，显式声明）
  }, { expectConsole: [/Unknown ctx-menu action/] });

  it('null action → early return (no calls)', () => {
    const { ctx, calls } = loadCtxMenuItems();
    ctx.run(`dispatchCtxAction(null, { ns: 'ph', id: 'rt-1' })`);
    assert.equal(calls.length, 0);
  });

  it('null target → early return (no calls)', () => {
    const { ctx, calls } = loadCtxMenuItems();
    ctx.run(`dispatchCtxAction('activate', null)`);
    assert.equal(calls.length, 0);
  });
});

// ── remote runtime leaves: same menu, namespaced addressing ──

const REMOTE_NS = 'remote:lab-b:programming-helper';

describe('ctx-menu-items: remote runtime leaf menu parity', () => {
  it('remote runtime leaf under an ops-allowed host gets the full local menu', () => {
    const { ctx } = loadCtxMenuItems();
    const items = ctx.run(`getCtxMenuItems('runtime', '${REMOTE_NS}', 'remote', 'remote:lab-b:rt-1')`);
    // Menu structure must be identical to the local runtime menu: the remote
    // leaf keeps restart / stop / archive-and-stop (forwarded server-side),
    // with no degraded variant. Remote sessions have no local thread data →
    // archive stays session-semantics, no thread items.
    const actions = (function flatten(list) {
      return list.flatMap((item) => [...(item.action ? [item.action] : []), ...(item.submenu ? flatten(item.submenu) : [])]);
    })(items);
    assert.ok(actions.includes('restart'), 'remote leaf keeps Restart');
    assert.ok(actions.includes('stop'), 'remote leaf keeps Stop');
    assert.ok(actions.includes('archive-and-stop'), 'remote leaf keeps Archive');
    assert.ok(actions.includes('delete-session-runtime'));
    assert.ok(actions.includes('rename'));
    assert.ok(actions.includes('generate-title'));
    assert.ok(actions.includes('copy-id'), 'remote leaf keeps Copy ID (client-side only)');
    assert.ok(actions.includes('todo-session'), 'remote leaf keeps TODO toggle (forwarded route)');
    assert.ok(!actions.includes('move-session'), 'move stays local-PH only');
    assert.ok(!actions.includes('thread-archive'), 'no local thread data → no thread endpoint action');
    assert.equal(items.filter((item) => item.type === 'separator').length, 4);
  });

  it('remote runtime leaf under an unknown host still gets no menu', () => {
    const { ctx } = loadCtxMenuItems();
    const items = ctx.run(`getCtxMenuItems('runtime', 'remote:lab-b:unknown-agent', 'remote', 'remote:lab-b:rt-1')`);
    assert.equal(items.length, 0);
  });
});

describe('ctx-menu-items: dispatchCtxAction remote variants', () => {
  function loadRemoteHarness() {
    const { ctx, calls } = loadCtxMenuItems({
      // 刷新后的权威读也要能回答（远程无本地条目 → 保留空快照外的既有投影）
      connected: [],
    });
    ctx.window.RemoteConnections = {
      refresh: () => { calls.push({ fn: 'RemoteConnections.refresh' }); },
      waitForRuntimeForSession: async (sessionId) => {
        calls.push({ fn: 'waitForRuntimeForSession', args: [sessionId] });
        return 'remote:lab-b:rt-new';
      },
      getEntryHostAgentId: () => 'programming-helper',
    };
    return { ctx, calls };
  }

  it('restart on a remote leaf invokes restart_agent with the host namespace id and re-locates the new runtime', async () => {
    const { ctx, calls } = loadRemoteHarness();
    await ctx.run(`dispatchCtxAction('restart', { ns: '${REMOTE_NS}', id: 'remote:lab-b:rt-1', sessionId: 'remote:lab-b:sess-1', variant: 'remote' })`);
    const restarts = activeCase.fetchCalls.filter((entry) => entry.url === '/protoclaw/restart_agent');
    assert.equal(restarts.length, 1, 'restart_agent must reach the server');
    assert.deepEqual(JSON.parse(restarts[0].body), {
      agentId: REMOTE_NS,
      sessionId: 'remote:lab-b:sess-1',
    }, 'agentId must be the host namespace id');
    assert.ok(calls.some((c) => c.fn === 'RemoteConnections.refresh'), 'catalog must refresh after restart');
    // 侧栏刷新是真实 loadAgents（连接快照 + viewer 读取）——真实 wire 上可见两次读
    assert.ok(
      activeCase.fetchCalls.some((entry) => entry.url.startsWith('/protoclaw/get_connected_agents')),
      'agents are re-read after the restart',
    );
    assert.ok(activeCase.fetchCalls.some((entry) => entry.url === '/api/agents'), 'viewer liveness re-read');
    const located = calls.find((c) => c.fn === 'waitForRuntimeForSession');
    assert.equal(located.args[0], 'remote:lab-b:sess-1', 'new runtime is located via the session');
    // 真实 requestSwitch 把切换意图交给宿主事务：切到的正是按会话重新定位的新 runtime
    assert.ok(activeCase.switchCalls.includes('remote:lab-b:rt-new'), 'switch targets the re-located runtime');
  });

  it('stop on a remote leaf invokes stop_agent with the host namespace id', async () => {
    const { ctx } = loadRemoteHarness();
    await ctx.run(`dispatchCtxAction('stop', { ns: '${REMOTE_NS}', id: 'remote:lab-b:rt-1', sessionId: 'remote:lab-b:sess-1', variant: 'remote' })`);
    const stops = activeCase.fetchCalls.filter((entry) => entry.url === '/protoclaw/stop_agent');
    assert.equal(stops.length, 1, 'stop_agent must reach the server');
    assert.deepEqual(JSON.parse(stops[0].body), {
      agentId: REMOTE_NS,
      sessionId: 'remote:lab-b:sess-1',
    });
  });
});

// ── child leaf: stop must address the host, not the runtime id ──

describe('ctx-menu-items: dispatchCtxAction child leaf stop addressing', () => {
  it('stop on a child leaf resolves the host id via parent_id (runtime id would be a silent no-op)', async () => {
    const childAgent = {
      id: 'rt-9',
      source: 'child',
      parent_id: 'programming-helper',
      active_workspace_session_id: 'sess-9',
    };
    const { ctx } = loadCtxMenuItems({
      allAgents: [TEST_AGENT, childAgent],
    });
    ctx.run(`dispatchCtxAction('stop', { ns: 'programming-helper', id: 'rt-9', sessionId: 'sess-9', variant: 'child' })`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stops = activeCase.fetchCalls.filter((entry) => entry.url === '/protoclaw/stop_agent');
    assert.equal(stops.length, 1, 'stop_agent must reach the server');
    const body = JSON.parse(stops[0].body);
    assert.equal(body.agentId, 'programming-helper',
      'agentId must resolve to the host via parent_id — sending the runtime id is a server-side silent no-op');
    assert.equal(body.sessionId, 'sess-9');
  });
});

// ── D1 regression: sessionOps capability gates the remote ops menu ──

describe('ctx-menu-items: sessionOps capability gating (merged integration)', () => {
  function loadWithCapability(sessionOps) {
    const { ctx } = loadCtxMenuItems();
    ctx.window.RemoteConnections = {
      capabilityFor: (agentId, action) => (action === 'sessionOps' ? sessionOps : true),
    };
    return ctx;
  }

  it('remote leaf with sessionOps capability keeps the full ops menu', () => {
    const ctx = loadWithCapability(true);
    const items = ctx.run(`getCtxMenuItems('runtime', '${REMOTE_NS}', 'remote', 'remote:lab-b:rt-1')`);
    const actions = items.flatMap((item) => [item.action, ...(item.submenu || []).map((child) => child.action)]);
    assert.ok(actions.includes('restart') && actions.includes('stop') && actions.includes('archive-and-stop'));
  });

  it('remote leaf without sessionOps capability (legacy remote) degrades to no menu', () => {
    const ctx = loadWithCapability(false);
    const items = ctx.run(`getCtxMenuItems('runtime', '${REMOTE_NS}', 'remote', 'remote:lab-b:rt-1')`);
    assert.equal(items.length, 0);
  });

  it('local agent menu is unaffected by the capability lookup', () => {
    const ctx = loadWithCapability(false);
    const items = ctx.run(`getCtxMenuItems('runtime', 'programming-helper', 'managed-runtime', 'rt-1')`);
    assert.equal(items.length, 14, 'local runtime menu keeps its grouped conversation actions');
    const actions = (function flatten(list) {
      return list.flatMap((item) => [...(item.action ? [item.action] : []), ...(item.submenu ? flatten(item.submenu) : [])]);
    })(items);
    assert.ok(actions.includes('generate-title'));
    assert.ok(actions.includes('summary') && actions.includes('trim') && actions.includes('branch'));
  });
});

// ── ADR-0049: declared items come from the agent record, not ns branches ──

describe('ctx-menu-items: declared session menu items (ADR-0049)', () => {
  it('second app declaring sessionOps without items gets the builtin menu only (no ns branches)', () => {
    const other = {
      id: 'other-app',
      sessionOps: true,
      workspace_sessions: { activeSessionId: 's-o', sessions: [{ id: 's-o', archived: false, todo: false }] },
    };
    const { ctx } = loadCtxMenuItems({ allAgents: [TEST_AGENT, other] });
    const items = ctx.run(`getCtxMenuItems('session', 'other-app', 'main', 's-o')`);
    const actions = items.filter((i) => i.action).map((i) => i.action);
    assert.ok(actions.includes('rename-session'), '内建族按 sessionOps 事实照常呈现');
    assert.ok(!actions.includes('claw:move-session'), '「移动到…」是 PH 的声明项，不得按 ns 渗入其他 APP');
  });

  it('declared item with not-archived predicate hides on archived conversations (facts wiring)', () => {
    const app = {
      id: 'pred-app',
      sessionOps: true,
      ui: { sessionMenu: { items: [{ id: 'p.clean', label: { zh: '清理', en: 'Clean' }, action: 'claw:move-session', when: ['not-archived'] }] } },
      workspace_sessions: { activeSessionId: 's-live', sessions: [{ id: 's-live', archived: false }, { id: 's-dead', archived: true }] },
    };
    const { ctx } = loadCtxMenuItems({ allAgents: [app] });
    const live = ctx.run(`getCtxMenuItems('session', 'pred-app', 'main', 's-live')`);
    assert.ok(live.find((i) => i.action === 'claw:move-session'), '未归档会话保留声明项');
    const dead = ctx.run(`getCtxMenuItems('session', 'pred-app', 'archived', 's-dead')`);
    assert.ok(!dead.find((i) => i.action === 'claw:move-session'), '归档会话按谓词隐藏声明项');
  });

  it('remote leaf hides declared items in v1 (builtin family stays)', () => {
    const { ctx } = loadCtxMenuItems();
    ctx.window.RemoteConnections = { capabilityFor: () => true };
    const items = ctx.run(`getCtxMenuItems('runtime', '${REMOTE_NS}', 'remote', 'remote:lab-b:rt-1')`);
    const actions = items.flatMap((item) => [item.action, ...(item.submenu || []).map((child) => child.action)]);
    assert.ok(actions.includes('restart'), '远程内建族不受影响');
    assert.ok(!actions.includes('claw:move-session'), '远程叶子 v1 不呈现 APP 自定义项（处理器在本机）');
  });

  it('claw: prefixed action dispatches to the builtin handler after prefix stripping', () => {
    // move-session 处理器现在直接调用 ESM 的 phOpenSessionMoveDialog（不再经 window
    // 替身），因此用该处理器的可观察前置动作钉住「恰一次命中内建 case」：
    // 进入 case 先关菜单；无当前 agent 时对话框入口静默返回（不误弹）。
    let closed = 0;
    const alerts = [];
    const { ctx } = loadCtxMenuItems();
    ctx.window.closeCtxMenu = () => { closed += 1; };
    ctx.window.alert = (message) => { alerts.push(String(message)); };
    ctx.window.getCurrentAgentRecord = () => null;
    ctx.run(`dispatchCtxAction('claw:move-session', { ns: 'programming-helper', id: 'sess-active', variant: 'session' })`);
    assert.equal(closed, 1, 'claw:move-session 恰好命中一次内建 move-session 处理器（剥前缀）');
    assert.deepEqual(alerts, [], '缺少当前 agent 时对话框入口静默返回，不猜测也不提示');

    // 未声明的 claw:* 动作不落到任何内建处理器
    ctx.run(`dispatchCtxAction('claw:unknown-action', { ns: 'programming-helper', id: 'sess-active', variant: 'session' })`);
    assert.equal(closed, 1, '未知 claw 动作不得命中 move-session 处理器');
  }, { expectConsole: [/Unknown ctx-menu action/] });
});

// ── copy-id action ──────────────────────────────────────────

describe('ctx-menu-items: copy-id action', () => {
  // navigator 由用例声明期的 globals 托管（helper 负责按原 descriptor 恢复）
  const clipboard = { copied: [] };
  const copyCaseGlobals = {
    navigator: { clipboard: { writeText: async (text) => { clipboard.copied.push(text); } } },
  };
  function loadCopyHarness() {
    clipboard.copied.length = 0;
    const { ctx, doc } = loadCtxMenuItems();
    ctx.window.isSecureContext = true;
    return { ctx, copied: clipboard.copied, doc };
  }

  it('copies the sessionId when no thread data exists', async () => {
    const { ctx, copied, doc } = loadCopyHarness();
    ctx.run(`dispatchCtxAction('copy-id', { ns: 'programming-helper', id: 'rt-1', sessionId: 'sess-abc' })`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(copied.includes('sess-abc'), 'clipboard must receive the sessionId');
    const cards = toastCards(doc);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].attributes['data-status'], 'success');
    assert.equal(findByClass(cards[0], 'toast-desc').textContent, 'sess-abc');
  }, { globals: copyCaseGlobals });

  it('copies the thread id when the session resolves to a thread', async () => {
    const { ctx, copied, doc } = loadCopyHarness();
    ctx.window.getThreadForSession = (ns, sid) => (sid === 'sess-th'
      ? { threadId: 'wt-abc', headSessionId: 'sess-th', lifeState: 'open' }
      : null);
    ctx.run(`dispatchCtxAction('copy-id', { ns: 'programming-helper', id: 'rt-1', sessionId: 'sess-th' })`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(copied.includes('wt-abc'), 'thread id wins when the conversation is threaded');
    assert.ok(!copied.includes('sess-th'), 'sessionId must not be copied for threaded rows');
    assert.equal(toastCards(doc)[0].attributes['data-status'], 'success');
  }, { globals: copyCaseGlobals });

  it('runtime leaf without explicit sessionId falls back to id', async () => {
    const { ctx, copied, doc } = loadCopyHarness();
    ctx.run(`dispatchCtxAction('copy-id', { ns: 'programming-helper', id: 'sess-fallback' })`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(copied.includes('sess-fallback'));
    assert.equal(toastCards(doc)[0].attributes['data-status'], 'success');
  }, { globals: copyCaseGlobals });
});

// ── getCtxMenuItems: workspace role（ADR-0050 工作空间条目操作面）──
// 事实选族：sidebarSessions 声明即能力，菜单项由生效策略派生（文案随
// visible/hidden 切换）；未声明 → 空菜单（右键与 ⋯ 的门控 = 菜单非空）。

const MEMO_DECLARED = { id: 'memo', sidebarSessions: 'visible' };

describe('ctx-menu-items: workspace role menu composition', () => {
  it('declared app with author default visible offers the hide action', () => {
    const { ctx } = loadCtxMenuItems({ allAgents: [TEST_AGENT, MEMO_DECLARED] });
    const items = ctx.run(`getCtxMenuItems('workspace', 'memo', 'prebuilt', 'memo')`);
    deepLoose(items, [
      { label: '隐藏对话条目', action: 'claw:toggle-sidebar-sessions' },
    ]);
  });

  it('effective policy from the wire projection wins over the author default', () => {
    const { ctx } = loadCtxMenuItems({ allAgents: [TEST_AGENT, { id: 'memo', sidebarSessions: 'visible', sidebarSessionsPolicy: 'hidden' }] });
    const items = ctx.run(`getCtxMenuItems('workspace', 'memo', 'prebuilt', 'memo')`);
    assert.equal(items[0].label, '显示对话条目');
  });

  it('labels follow the UI language', () => {
    const { ctx } = loadCtxMenuItems({ currentLanguage: 'en', allAgents: [MEMO_DECLARED] });
    const items = ctx.run(`getCtxMenuItems('workspace', 'memo', 'prebuilt', 'memo')`);
    assert.equal(items[0].label, 'Hide conversations');
  });

  it('undeclared app yields an empty menu (no entry point)', () => {
    const { ctx } = loadCtxMenuItems({ allAgents: [TEST_AGENT] });
    const items = ctx.run(`getCtxMenuItems('workspace', 'programming-helper', 'prebuilt', 'programming-helper')`);
    deepLoose(items, []);
  });
});

describe('ctx-menu-items: dispatch toggle-sidebar-sessions', () => {
  function loadToggleHarness(agentRecord) {
    // 真实 wire：PUT 回执 { ok }、连接快照按数组返回（切换后 loadAgents 会重读）
    const { ctx } = loadCtxMenuItems({
      allAgents: [agentRecord],
      connected: [agentRecord],
    });
    return { ctx, requests: activeCase.fetchCalls };
  }

  const putRequests = (requests) => requests.filter((entry) => entry.method === 'PUT');

  it('submits the inverted target policy and refreshes the wire', async () => {
    const { ctx, requests } = loadToggleHarness({ id: 'memo', sidebarSessions: 'visible', sidebarSessionsPolicy: 'visible' });
    ctx.run(`dispatchCtxAction('toggle-sidebar-sessions', { role: 'workspace', ns: 'memo', id: 'memo', variant: 'prebuilt' })`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const puts = putRequests(requests);
    assert.equal(puts.length, 1, 'exactly one PUT');
    assert.equal(puts[0].url, '/protoclaw/workspace_settings/sidebar_sessions');
    assert.deepEqual(JSON.parse(puts[0].body), { agentId: 'memo', policy: 'hidden' });
    // 真实 loadAgents 的 viewer 读取（wire 已刷新，渲染签名随之翻转）
    assert.ok(
      requests.some((entry) => entry.url === '/api/agents'),
      'wire refreshed so the render signature flips',
    );
  });

  it('hidden → visible inverts the other way', async () => {
    const { ctx, requests } = loadToggleHarness({ id: 'memo', sidebarSessions: 'visible', sidebarSessionsPolicy: 'hidden' });
    ctx.run(`dispatchCtxAction('toggle-sidebar-sessions', { role: 'workspace', ns: 'memo', id: 'memo', variant: 'prebuilt' })`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(JSON.parse(putRequests(requests)[0].body), { agentId: 'memo', policy: 'visible' });
  });
});

/* ── 主 realm 的 case 级托管：跨 case 恢复（不静音、不泄漏） ── */

describe('ctx-menu-items: case-scoped main-realm globals', () => {
  const TRACKED = ['navigator', 'console', 'fetch', 'CSS'];
  const descriptorsOf = () => Object.fromEntries(
    TRACKED.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  const probeNavigator = (tag) => ({
    tag,
    clipboard: { writeText: async () => {} },
  });

  nodeIt('restores the original descriptors after each case, including a throwing case', async () => {
    const before = descriptorsOf();
    const first = probeNavigator('first');
    const second = probeNavigator('second');

    await withP2EsmCase({ globals: { navigator: first } }, async () => {
      assert.equal(globalThis.navigator, first, '用例期间由 globals 托管 navigator');
    });
    // 逐键比对描述符：getter/setter/value/writable/enumerable/configurable 全部还原
    assert.deepEqual(descriptorsOf(), before, '第一个 case 结束后全部描述符已恢复');

    await withP2EsmCase({ globals: { navigator: second } }, async () => {
      assert.equal(globalThis.navigator, second, '第二个 case 拿到自己的托管值');
      assert.notEqual(globalThis.navigator, first, '前一个 case 的托管值没有泄漏');
    });
    assert.deepEqual(descriptorsOf(), before, '第二个 case 结束后全部描述符已恢复');

    // 用例体内抛错时 finally 仍要还原——否则后续 case 会拿到脱手的探针
    await assert.rejects(
      withP2EsmCase({ globals: { navigator: first } }, async () => {
        assert.equal(globalThis.navigator, first);
        throw new Error('case body failed');
      }),
      /case body failed/,
    );
    assert.deepEqual(descriptorsOf(), before, '抛错路径同样恢复描述符');
  });
});
