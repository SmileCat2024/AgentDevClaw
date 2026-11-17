/**
 * 工作空间条目操作面的侧栏呈现（ADR-0050 回归锚）。
 *
 *   - 门控：声明 sidebarSessions 的 APP 条目带 workspace ctx 身份与 ⋯ 按钮
 *     （右键与 ⋯ 同一门控 = 菜单非空）；未声明 APP 无入口，浏览器默认右键。
 *   - 门控退役只作用 prebuilt 分支：非 prebuilt（orphan / external runtime）
 *     条目仍走静态 agent-context-menu（无 data-ctx-*）。
 *   - ⋯ 入口复用会话条目的 onSidebarSessionCtxMenu：workspace 角色同样经
 *     getCtxMenuItems 合成并 showCtxMenu。
 *
 * 装载路线（P2 ESM 配方第三节）：渲染与菜单门控的实现方 sidebar-render.js /
 * runtime-status.js / thread-store.js / project-data.js 仍是 classic，按真实
 * 顺序 loadSource；菜单合成（ctx-menu-items）、会话操作（sidebar-operations）、
 * 会话列表数据面（session-ui）与声明驱动事实（session-menu-decls）已迁 ESM，
 * 经 withP2EsmCase 的 `c.load` 真实 import。classic 侧读菜单走 kernel 访问器桥，
 * 两侧共享同一实现；context-menu.js 不入链，showCtxMenu 以记录替身注入。
 */

import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const SESSION_UI = 'public/src/modules/session-ui.js';
const OPS = 'public/src/modules/sidebar-operations.js';
const DECLS = 'public/src/modules/session-menu-decls.js';
const CTX_MENU = 'public/src/modules/ctx-menu-items.js';

/** classic 真源优先：只补齐 bootstrap 尚未声明的宿主全局。 */
function fillMissingGlobals(sandbox, stubs) {
  for (const [name, value] of Object.entries(stubs)) {
    if (sandbox.run(`typeof ${name} !== 'undefined'`)) continue;
    sandbox[name] = value;
  }
}

function bootstrapClassic(sandbox) {
  sandbox.t = (key) => key;
  sandbox.setTimeout = () => 0;
  sandbox.setInterval = () => 0;
  sandbox.loadSource('public/src/modules/action-dispatcher.js');
  // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
  sandbox.loadSource('public/src/app-core.js');
  sandbox.loadSource('public/src/modules/runtime-status.js');
  sandbox.loadSource('public/src/modules/session-view-state.js');
  sandbox.loadSource('public/src/modules/sidebar-render.js');
  sandbox.AgentLoaderHost = { loadedAgentDetailIds: new Set() };
  // 数据加载图静态依赖（agent-data-loader → input-actions）在装载期取 app-main
  // 的轮询宿主工厂；本文件不驱动轮询。
  sandbox.createPollCoordinatorHost = () => ({});
  // 调用状态宿主：owner 是 classic sidebar-render 的 createAgentCallStatesHost，
  // 但它引用 app-main 的词法容器与未定义的通知钩子（_markAgentCallStartedForNotify）。
  // 这里按它的键集合给等价实现：容器取真实 owner 的那一份（app-core /
  // runtime-status 的 Map/Set），读操作委托真实函数，副作用只保留渲染入口。
  let callStateRefreshAt = Date.now();
  const callStatesSlot = (expression, fallback) => {
    try { return sandbox.run(expression); } catch { return fallback; }
  };
  sandbox.createAgentCallStatesHost = () => ({
    calling: callStatesSlot('_agentCallActive', new Map()),
    suspended: callStatesSlot('_agentSuspended', new Map()),
    interrupting: callStatesSlot('_interruptSuppression', new Map()),
    finished: callStatesSlot('_recentlyFinishedRuntimes', new Set()),
    agents: () => sandbox.allAgents,
    currentRuntimeId: () => sandbox.currentRuntimeAgentId,
    runtimeId: (agent) => sandbox.getAgentRuntimeId(agent),
    remoteEntries: () => (typeof sandbox.getVisibleRemoteEntries === 'function'
      ? sandbox.getVisibleRemoteEntries() : []),
    normalize: (value) => sandbox.normalizeAgentIdentity(value),
    resolveCalling: (payload) => sandbox.resolveNotificationCallingState?.(payload) === true,
    isSuspended: (payload) => sandbox.isSuspendedNotificationPayload?.(payload) === true,
    markStarted: () => {},
    syncActionButton: () => {},
    isSseActive: () => (typeof sandbox.isSseActive === 'function' ? sandbox.isSseActive() === true : true),
    isRemote: (id) => typeof sandbox.isRemoteNamespaceAgentId === 'function'
      && sandbox.isRemoteNamespaceAgentId(id) === true,
    fetch: (...args) => sandbox.fetch(...args),
    now: () => Date.now(),
    lastRefresh: () => callStateRefreshAt,
    setLastRefresh: (value) => { callStateRefreshAt = value; },
    render: () => sandbox.renderAgentList(),
  });
  sandbox.createRuntimeSwitchHost = () => ({ state: {} });
  sandbox.createWorkspaceSurfaceHost = () => ({});
  sandbox.createCompactResumeHost = () => ({ state: {}, now: () => Date.now() });
  sandbox.performance = { now: () => 0 };
  sandbox.pendingPrebuiltAgentIds = new Set();
  sandbox._recentlyFinishedRuntimes = new Set();
  fillMissingGlobals(sandbox, {
    normalizeAgentIdentity: (value) => String(value || '').trim(),
    toEpochMs: (value) => Date.parse(value || '') || 0,
    getAgentRuntimeId: (agent) => agent.runtime_session_id || '',
    getParentAgentId: (agent) => agent.parent_id,
    getActiveSessionId: (agent) => agent.active_workspace_session_id,
    isRuntimeItemActive: () => false,
    isAgentActive: () => false,
    isRuntimeCalling: () => false,
    updateCurrentAgentChrome() {},
    groupConnectedAgents: () => ({ external: [] }),
    agentList: { addEventListener() {} },
    externalAgentList: {}, externalGroup: { style: {} }, externalCount: {},
    renderCurrentMainView() {},
    renderAgentList() {},
    CSS: { escape: (value) => String(value) },
    closeAgentContextMenu: () => {},
    closeCompactMenu: () => {},
    closeProjectContextMenu: () => {},
    isRemoteNamespaceAgentId: (id) => typeof id === 'string' && id.startsWith('remote:'),
    setPreferredUnitMode: () => {},
    resolveFocusedAgentAfterRefresh: () => null,
    handlePrebuiltAgentClick: () => {},
    loadAgentDetail: async () => ({}),
    invoke: async () => ({}),
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
function harnessCase({ isRuntimeItemActive = () => false } = {}, fn) {
  const guard = createConsoleGuard();
  return withP2EsmCase({
    classic: (sandbox) => {
      bootstrapClassic(sandbox);
      sandbox.isRuntimeItemActive = isRuntimeItemActive;
    },
    globals: { navigator: undefined, console: guard.recorder },
  }, async (c) => {
    // 刷新引擎（P4 T3 起是真实 ESM）：交互域在**装载期**取它的窄宿主 createThreadStoreHost，
// 必须先于 thread-store-domain 进入同一张图。
    await c.load('public/src/modules/thread-store.js');
    await c.load('public/src/modules/agent-data-loader.js');
    await c.load('public/src/modules/project-data.js');
    await c.load(SESSION_UI);
    await c.load(OPS);
    await c.load(DECLS);
    await c.load(CTX_MENU);
    const result = await fn(c.sandbox);
    guard.assertClean();
    return result;
  });
}

/** 每个用例一次真实装载；`fn(ctx)` 里的 ctx 就是那份 classic + ESM 合流沙箱。 */
function test(name, fn, options) {
  nodeTest(name, () => harnessCase(options, fn));
}

test('declared app entry carries the workspace ctx identity, menu gate and ⋯ button', (ctx) => {
  ctx.allAgents = [{ id: 'memo', name: 'Memo', source: 'prebuilt', sidebarSessions: 'visible' }];
  const html = ctx.run(`renderAgentItems([{ id: 'memo', name: 'Memo', source: 'prebuilt', sidebarSessions: 'visible' }], { prebuilt: true })`);
  assert.match(html, /data-agent-context-menu="true"/, 'gate opens when the workspace menu is non-empty');
  assert.match(html, /data-ctx-role="workspace"/);
  assert.match(html, /data-ctx-ns="memo"/);
  assert.match(html, /class="agent-runtime-more"/, '⋯ button is the visible entry, same gate as right-click');
  // 内联 ratchet 只许降不许升：⋯ 打开走 capture 容器委托（agentList 层），
  // 模板只留标记属性；打开行为由真实界面验收（P3）覆盖。
  assert.match(html, /data-workspace-more="1"/);
  assert.doesNotMatch(html, /onclick=/);
  assert.doesNotMatch(html, /onpointermove=/, 'hover fade is pure CSS, no JS proximity driver');
});

test('undeclared app entry has no menu entry points', (ctx) => {
  ctx.allAgents = [{ id: 'programming-helper', name: '智能编码空间', source: 'prebuilt' }];
  const html = ctx.run(`renderAgentItems([{ id: 'programming-helper', name: '智能编码空间', source: 'prebuilt' }], { prebuilt: true })`);
  assert.match(html, /data-agent-context-menu="false"/, 'no capability declaration → no entry, browser default menu');
  assert.doesNotMatch(html, /agent-runtime-more/);
});

test('gate retirement is prebuilt-only: non-prebuilt runtime items keep the static-menu path', (ctx) => {
  const html = ctx.run(`renderAgentItems([{ id: 'rt-1', name: 'External', runtime_session_id: 'rt-1' }], { prebuilt: false })`);
  assert.match(html, /data-agent-context-menu="true"/);
  assert.doesNotMatch(html, /data-ctx-role/, 'no ctx dataset → contextmenu delegation falls through to the static agent menu');
});

test('⋯ entry routes the workspace role through the shared session ctx-menu opener', (ctx) => {
  ctx.allAgents = [{ id: 'memo', name: 'Memo', source: 'prebuilt', sidebarSessions: 'hidden', sidebarSessionsPolicy: 'hidden' }];
  const shown = [];
  ctx.window.showCtxMenu = (x, y, items, target) => shown.push({ items, target });
  ctx.window.closeCtxMenu = () => {};
  ctx.run(`
    const item = {
      dataset: { ctxRole: 'workspace', ctxNs: 'memo', ctxId: 'memo', ctxVariant: 'prebuilt', ctxSessionId: '', ctxThreadId: '' },
    };
    item.closest = () => item;
    const button = { closest: () => item, getBoundingClientRect: () => ({ right: 8, bottom: 9 }) };
    window.onSidebarSessionCtxMenu({ stopPropagation() {} }, button);
  `);
  assert.equal(shown.length, 1, 'menu opens exactly once');
  assert.equal(shown[0].target.role, 'workspace');
  assert.equal(shown[0].target.ns, 'memo');
  assert.equal(shown[0].items.length, 1);
  assert.equal(shown[0].items[0].action, 'claw:toggle-sidebar-sessions');
  assert.equal(shown[0].items[0].label, '显示对话条目', 'label follows the effective policy');
});

// ── 会话子树呈现过滤（ADR-0050 P2）：生效值 hidden 时整棵会话子树不渲染 ──

function sessionsTreeFixture(policy) {
  const memoEntry = { id: 'memo', name: 'Memo', source: 'prebuilt', sidebarSessions: 'visible', ...(policy ? { sidebarSessionsPolicy: policy } : {}) };
  const childRuntime = { id: 'rt-1', name: 'Child', source: 'child', parent_id: 'memo', runtime_session_id: 'rt-1', connected: true };
  return { memoEntry, childRuntime };
}

test('effective policy hidden suppresses the whole session subtree; the app entry itself stays', (ctx) => {
  const hidden = sessionsTreeFixture('hidden');
  ctx.allAgents = [hidden.memoEntry, hidden.childRuntime];
  const html = ctx.run(`renderAgentItems(${JSON.stringify([hidden.memoEntry])}, { prebuilt: true })`);
  assert.match(html, /data-agent-id="memo"/, 'app entry itself is rendered (only the sessions subtree is hidden)');
  assert.doesNotMatch(html, /data-agent-id="rt-1"/, 'hidden policy suppresses child runtime entries');

  // 同一夹具在 visible 生效值下渲染出子条目——证明上一断言是策略的因果，
  // 不是夹具本身收集不到 child。
  const visible = sessionsTreeFixture('visible');
  ctx.allAgents = [visible.memoEntry, visible.childRuntime];
  const html2 = ctx.run(`renderAgentItems(${JSON.stringify([visible.memoEntry])}, { prebuilt: true })`);
  assert.match(html2, /data-agent-id="rt-1"/, 'visible policy renders the same fixture subtree');
});

test('hidden policy also suppresses the has-active-runtime highlight class', (ctx) => {
  const { memoEntry, childRuntime } = sessionsTreeFixture('hidden');
  // active 高亮事实成立（stub 恒真）但子树被隐藏：条目不得残留高亮 class
  ctx.allAgents = [memoEntry, childRuntime];
  const html = ctx.run(`renderAgentItems(${JSON.stringify([memoEntry])}, { prebuilt: true })`);
  assert.doesNotMatch(html, /has-active-runtime/);
}, { isRuntimeItemActive: () => true });

test('render signature tracks sidebarSessionsPolicy so visibility flips re-render', (ctx) => {
  const sigOf = (policy) => {
    ctx.allAgents = [{ id: 'memo', name: 'Memo', source: 'prebuilt', sidebarSessionsPolicy: policy }];
    return ctx.run('getAgentListRenderSignature()');
  };
  assert.notEqual(sigOf('visible'), sigOf('hidden'), 'policy flip must change the render signature');
  assert.equal(sigOf('hidden'), sigOf('hidden'), 'same policy keeps a stable signature');
});
