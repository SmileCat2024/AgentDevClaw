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
 * 加载链与 test/frontend-sidebar-freshness.test.js 相同（sidebar-render 的
 * 模块依赖为真实依赖）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function harness({ isRuntimeItemActive = () => false } = {}) {
  const ctx = createFrontendSandbox({
    setTimeout: () => 0,
    setInterval: () => 0,
    t: (key) => key,
    normalizeAgentIdentity: (value) => String(value || '').trim(),
    toEpochMs: (value) => Date.parse(value || '') || 0,
    pendingPrebuiltAgentIds: new Set(),
    restartingRuntimeIds: new Set(),
    _recentlyFinishedRuntimes: new Set(),
    _agentCallActive: new Map(),
    getAgentRuntimeId: (agent) => agent.runtime_session_id || '',
    getParentAgentId: (agent) => agent.parent_id,
    getActiveSessionId: (agent) => agent.active_workspace_session_id,
    isRuntimeItemActive,
    isAgentActive: () => false,
    isRuntimeCalling: () => false,
    updateCurrentAgentChrome() {},
    groupConnectedAgents: () => ({ external: [] }),
    agentList: { addEventListener() {} },
    externalAgentList: {}, externalGroup: { style: {} }, externalCount: {},
    renderCurrentMainView() {},
    CSS: { escape: (value) => value },
    lastRenderedWorkspaceHtml: '',
    // context-menu.js 不入链（其 DOM 面与本文件无关）；onSidebarSessionCtxMenu
    // 收尾调用的三个关闭函数以空实现满足引用。
    closeAgentContextMenu: () => {},
    closeCompactMenu: () => {},
    closeProjectContextMenu: () => {},
  });
  ctx.window.setInterval = () => 0;
  ctx.loadSource('public/src/modules/action-dispatcher.js');
  ctx.loadSource('public/src/modules/project-data.js');
  ctx.loadSource('public/src/modules/session-ui.js');
  ctx.loadSource('public/src/modules/sidebar-operations.js');
  ctx.loadSource('public/src/modules/runtime-status.js');
  ctx.loadSource('public/src/modules/thread-store.js');
  ctx.loadSource('public/src/modules/session-menu-decls.js');
  ctx.loadSource('public/src/modules/sidebar-render.js');
  ctx.loadSource('public/src/modules/ctx-menu-items.js');
  return ctx;
}

test('declared app entry carries the workspace ctx identity, menu gate and ⋯ button', () => {
  const ctx = harness();
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

test('undeclared app entry has no menu entry points', () => {
  const ctx = harness();
  ctx.allAgents = [{ id: 'programming-helper', name: '智能编码空间', source: 'prebuilt' }];
  const html = ctx.run(`renderAgentItems([{ id: 'programming-helper', name: '智能编码空间', source: 'prebuilt' }], { prebuilt: true })`);
  assert.match(html, /data-agent-context-menu="false"/, 'no capability declaration → no entry, browser default menu');
  assert.doesNotMatch(html, /agent-runtime-more/);
});

test('gate retirement is prebuilt-only: non-prebuilt runtime items keep the static-menu path', () => {
  const ctx = harness();
  const html = ctx.run(`renderAgentItems([{ id: 'rt-1', name: 'External', runtime_session_id: 'rt-1' }], { prebuilt: false })`);
  assert.match(html, /data-agent-context-menu="true"/);
  assert.doesNotMatch(html, /data-ctx-role/, 'no ctx dataset → contextmenu delegation falls through to the static agent menu');
});

test('⋯ entry routes the workspace role through the shared session ctx-menu opener', () => {
  const ctx = harness();
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

test('effective policy hidden suppresses the whole session subtree; the app entry itself stays', () => {
  const { memoEntry, childRuntime } = sessionsTreeFixture('hidden');
  const ctx = harness();
  ctx.allAgents = [memoEntry, childRuntime];
  const html = ctx.run(`renderAgentItems(${JSON.stringify([memoEntry])}, { prebuilt: true })`);
  assert.match(html, /data-agent-id="memo"/, 'app entry itself is rendered (only the sessions subtree is hidden)');
  assert.doesNotMatch(html, /data-agent-id="rt-1"/, 'hidden policy suppresses child runtime entries');

  // 同一夹具在 visible 生效值下渲染出子条目——证明上一断言是策略的因果，
  // 不是夹具本身收集不到 child。
  const visible = sessionsTreeFixture('visible');
  const ctx2 = harness();
  ctx2.allAgents = [visible.memoEntry, visible.childRuntime];
  const html2 = ctx2.run(`renderAgentItems(${JSON.stringify([visible.memoEntry])}, { prebuilt: true })`);
  assert.match(html2, /data-agent-id="rt-1"/, 'visible policy renders the same fixture subtree');
});

test('hidden policy also suppresses the has-active-runtime highlight class', () => {
  const { memoEntry, childRuntime } = sessionsTreeFixture('hidden');
  // active 高亮事实成立（stub 恒真）但子树被隐藏：条目不得残留高亮 class
  const ctx = harness({ isRuntimeItemActive: () => true });
  ctx.allAgents = [memoEntry, childRuntime];
  const html = ctx.run(`renderAgentItems(${JSON.stringify([memoEntry])}, { prebuilt: true })`);
  assert.doesNotMatch(html, /has-active-runtime/);
});

test('render signature tracks sidebarSessionsPolicy so visibility flips re-render', () => {
  const ctx = harness();
  const sigOf = (policy) => {
    ctx.allAgents = [{ id: 'memo', name: 'Memo', source: 'prebuilt', sidebarSessionsPolicy: policy }];
    return ctx.run('getAgentListRenderSignature()');
  };
  assert.notEqual(sigOf('visible'), sigOf('hidden'), 'policy flip must change the render signature');
  assert.equal(sigOf('hidden'), sigOf('hidden'), 'same policy keeps a stable signature');
});
