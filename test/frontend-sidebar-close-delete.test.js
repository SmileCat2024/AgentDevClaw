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
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

const flushMicrotasks = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
};

/* ── ctx 菜单动作链 harness（ctx-menu-items.js + sidebar-operations.js） ── */

function menuHarness({ currentRuntimeAgentId = 'other-runtime', invokeImpl } = {}) {
  const calls = { invoke: [], fetch: [], selectWorkspaceSurface: [], confirm: [], toasts: [] };
  const ctx = createFrontendSandbox({
    currentLanguage: 'zh',
    allAgents: [],
    t: (key) => key,
    currentRuntimeAgentId,
    normalizeAgentIdentity: (value) => String(value || '').trim(),
    CSS: { escape: (value) => value },
    getExternalRuntimeAgent: () => null,
    getRuntimeId: () => null,
    clearAgentRuntimeCache: () => {},
    invoke: async (...args) => {
      calls.invoke.push(args);
      if (invokeImpl) return invokeImpl(...args);
      return {};
    },
    refreshSidebarRuntimeAfterMutation: async () => {},
    selectWorkspaceSurface: (...args) => { calls.selectWorkspaceSurface.push(args); },
    resolveWorkspaceFallbackAgentId: () => null,
    newIdempotencyKey: () => 'idem-test-1',
    ClawToast: {
      show: (toast) => { calls.toasts.push(toast); },
      error: (message) => { calls.toasts.push({ status: 'error', title: message }); },
    },
    getWorkspaceSessionById: () => null,
    getWorkspaceSessions: () => [],
    updateAgentRecord: () => {},
    renderCurrentMainView: () => {},
    renderAgentList: () => {},
    lastRenderedWorkspaceHtml: '',
    getPathLeaf: (value) => String(value || ''),
    toEpochMs: () => 0,
    pendingPrebuiltAgentIds: new Set(),
    restartingRuntimeIds: new Set(),
    _recentlyFinishedRuntimes: new Set(),
    _agentCallActive: new Map(),
  });
  ctx.window.setInterval = () => 0;
  ctx.window.confirm = (message) => { calls.confirm.push(String(message)); return true; };
  ctx.window.closeCtxMenu = () => {};
  ctx.window.refreshThreads = async () => {};
  ctx.window.getThreadById = (threadId) => ({ threadId, headViewerAgentId: 'runtime-1' });
  ctx.window.getThreadForSession = () => null;
  ctx.fetch = async (url, options) => {
    calls.fetch.push({ url, options });
    return { ok: true, json: async () => ({ ok: true, cleanup: {} }) };
  };
  ctx.loadSource('public/src/modules/sidebar-operations.js');
  ctx.loadSource('public/src/modules/ctx-menu-items.js');
  return { ctx, calls };
}

/* ── R1：删除确认文案 ── */

describe('R1 delete_session confirm shows session title', () => {
  it('uses deletedSession.title when the record is loaded', async () => {
    const host = {
      id: 'programming-helper',
      workspace_sessions: {
        revision: 5,
        activeSessionId: 'session-1',
        sessions: [{ id: 'session-1', title: '修复登录 bug', archived: false }],
      },
    };
    const calls = { confirm: [] };
    const ctx = createFrontendSandbox({
      currentLanguage: 'zh',
      allAgents: [host],
      t: (key) => (key === 'workspace_session_delete_confirm'
        ? '确定要删除会话 {{id}} 吗？此操作不可撤销。'
        : key),
      getCurrentAgentRecord: () => host,
      resolveStudioSessionDirectory: async (_agent, action) => action,
      bumpNavigationGuard: () => {},
      hasWorkspaceSessions: () => true,
      markActionLoading: () => {},
      getWorkspaceSessions: (agent) => agent?.workspace_sessions?.sessions || [],
      getWorkspaceSessionById: (agent, sid) => (agent?.workspace_sessions?.sessions || []).find((s) => s.id === sid) || null,
      updateAgentRecord: () => {},
      applyManagedPrebuiltAgent: () => {},
      clearAgentRuntimeCache: () => {},
      newIdempotencyKey: () => 'idem-test-1',
      navigateToSessionMutationTarget: async () => {},
      getIMWorkspaceDraft: () => null,
      ensureIMWorkspaceLoaded: async () => {},
      renderCurrentMainView: () => {},
      loadAgents: async () => {},
      lastRenderedWorkspaceHtml: '',
      shouldAnimateWorkspaceSurface: false,
      CSS: { escape: (value) => value },
    });
    ctx.window.setInterval = () => 0;
    ctx.window.confirm = (message) => { calls.confirm.push(String(message)); return true; };
    ctx.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
    ctx.loadSource('public/src/modules/sidebar-operations.js');
    ctx.loadSource('public/src/modules/workspace-actions.js');

    ctx.run(`window.runWorkspaceAction(JSON.stringify({
      type: 'delete_session',
      sessionId: 'session-1',
    }))`);
    await flushMicrotasks();

    assert.equal(calls.confirm.length, 1, 'confirm shown exactly once');
    assert.match(calls.confirm[0], /修复登录 bug/);
    assert.doesNotMatch(calls.confirm[0], /session-1/);
  });

  it('falls back to the raw id when the record is not loaded', async () => {
    const host = {
      id: 'programming-helper',
      workspace_sessions: { revision: 5, activeSessionId: null, sessions: [] },
    };
    const calls = { confirm: [] };
    const ctx = createFrontendSandbox({
      currentLanguage: 'zh',
      allAgents: [host],
      t: (key) => (key === 'workspace_session_delete_confirm'
        ? '确定要删除会话 {{id}} 吗？此操作不可撤销。'
        : key),
      getCurrentAgentRecord: () => host,
      resolveStudioSessionDirectory: async (_agent, action) => action,
      bumpNavigationGuard: () => {},
      hasWorkspaceSessions: () => true,
      markActionLoading: () => {},
      getWorkspaceSessions: (agent) => agent?.workspace_sessions?.sessions || [],
      getWorkspaceSessionById: () => null,
      updateAgentRecord: () => {},
      applyManagedPrebuiltAgent: () => {},
      clearAgentRuntimeCache: () => {},
      newIdempotencyKey: () => 'idem-test-1',
      navigateToSessionMutationTarget: async () => {},
      getIMWorkspaceDraft: () => null,
      ensureIMWorkspaceLoaded: async () => {},
      renderCurrentMainView: () => {},
      loadAgents: async () => {},
      lastRenderedWorkspaceHtml: '',
      shouldAnimateWorkspaceSurface: false,
      CSS: { escape: (value) => value },
    });
    ctx.window.setInterval = () => 0;
    ctx.window.confirm = (message) => { calls.confirm.push(String(message)); return true; };
    ctx.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
    ctx.loadSource('public/src/modules/sidebar-operations.js');
    ctx.loadSource('public/src/modules/workspace-actions.js');

    ctx.run(`window.runWorkspaceAction(JSON.stringify({
      type: 'delete_session',
      sessionId: 'session-missing',
    }))`);
    await flushMicrotasks();

    assert.match(calls.confirm[0] || '', /session-missing/);
  });
});

/* ── R2：ctx 菜单打开期间的侧栏重渲守卫 ── */

describe('R2 renderAgentList guard while context menus are open', () => {
  function sidebarHarness() {
    const host = {
      id: 'programming-helper', source: 'prebuilt',
      workspace_sessions: { revision: 1, sessions: [{ id: 's1', title: '新对话1' }] },
    };
    const child = {
      id: 'runtime-1', runtime_session_id: 'runtime-1', source: 'child', parent_id: 'programming-helper',
      active_workspace_session_id: 's1', active_workspace_session_title: '新对话1', connected: true,
    };
    const ctx = createFrontendSandbox({
      currentLanguage: 'zh',
      allAgents: [host, child],
      t: (key) => key,
      setTimeout: () => 0,
      // thread-store.js 顶层有裸 setInterval（周期刷新）：vm 内裸标识符解析
      // 到 context 属性，不覆盖会驻留真实 Node 句柄，node --test 挂死。
      setInterval: () => 0,
      normalizeAgentIdentity: (value) => String(value || '').trim(),
      toEpochMs: () => 0,
      pendingPrebuiltAgentIds: new Set(),
      restartingRuntimeIds: new Set(),
      _recentlyFinishedRuntimes: new Set(),
      _agentCallActive: new Map(),
      getAgentRuntimeId: (agent) => agent.runtime_session_id || '',
      getParentAgentId: (agent) => agent.parent_id,
      getActiveSessionId: (agent) => agent.active_workspace_session_id,
      isRuntimeItemActive: () => false,
      updateCurrentAgentChrome() {},
      groupConnectedAgents: () => ({ external: [] }),
      agentList: { addEventListener() {} },
      externalAgentList: {}, externalGroup: { style: {} }, externalCount: {},
      renderCurrentMainView() {},
      CSS: { escape: (value) => value },
      lastRenderedWorkspaceHtml: '',
    });
    ctx.window.setInterval = () => 0;
    const state = { renders: 0, menuOpen: false };
    ctx.window.ClawSidebarLayout = {
      isInteracting: () => false,
      signature: () => 'fixture-layout',
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
    ctx.loadSource('public/src/modules/project-data.js');
    ctx.loadSource('public/src/modules/session-ui.js');
    ctx.loadSource('public/src/modules/sidebar-operations.js');
    ctx.loadSource('public/src/modules/runtime-status.js');
    ctx.loadSource('public/src/modules/thread-store.js');
    ctx.loadSource('public/src/modules/sidebar-render.js');
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
  it('returns to the workspace surface when the deleted runtime was docked', async () => {
    const h = menuHarness({ currentRuntimeAgentId: 'runtime-1' });
    await h.ctx.run(`dispatchCtxAction('thread-delete', {
      ns: 'programming-helper', id: 'runtime-1', sessionId: 's1', threadId: 'wt-1',
    })`);
    await flushMicrotasks();

    assert.ok(
      h.calls.fetch.some((entry) => String(entry.url).includes('/threads/wt-1/delete')),
      'delete request reaches the server',
    );
    assert.deepEqual(h.calls.selectWorkspaceSurface, [['programming-helper']]);
  });

  it('does not navigate away when another conversation is docked', async () => {
    const h = menuHarness({ currentRuntimeAgentId: 'other-runtime' });
    await h.ctx.run(`dispatchCtxAction('thread-delete', {
      ns: 'programming-helper', id: 'runtime-1', sessionId: 's1', threadId: 'wt-1',
    })`);
    await flushMicrotasks();

    assert.equal(h.calls.selectWorkspaceSurface.length, 0);
  });
});

/* ── R4：关闭（stop）乐观退场 ── */

describe('R4 ctxStopAgent optimistic runtime retirement', () => {
  it('registers pending stop so the leaf hides before the next poll', async () => {
    const h = menuHarness({ currentRuntimeAgentId: 'other-runtime' });
    await h.ctx.run(`ctxStopAgent({
      ns: 'programming-helper', id: 'runtime-1', sessionId: 's1', variant: 'managed-runtime',
    })`);
    await flushMicrotasks();

    assert.ok(
      h.calls.invoke.some((args) => args[0] === 'stop_agent'),
      'stop_agent dispatched',
    );
    assert.equal(
      h.ctx.run(`isRuntimeStopPending('programming-helper', 's1', 'runtime-1')`),
      true,
      'leaf hidden optimistically',
    );
  });

  it('releases the registration when stop is rejected so the leaf returns', async () => {
    const h = menuHarness({
      currentRuntimeAgentId: 'other-runtime',
      invokeImpl: async () => { throw new Error('stop rejected'); },
    });
    await h.ctx.run(`ctxStopAgent({
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
    const h = menuHarness();
    h.ctx.refreshSidebarRuntimeAfterMutation = async () => { throw new Error('offline'); };
    h.ctx.console = { ...console, warn() {} };
    await h.ctx.run(`ctxStopAgent({ ns: 'programming-helper', id: 'runtime-1', sessionId: 's1', variant: 'managed-runtime' })`);
    assert.equal(h.ctx.run(`isRuntimeStopPending('programming-helper', 's1', 'runtime-1')`), true);
  });

  it('does not register for remote entries (outside the local projection filter)', async () => {
    const h = menuHarness({ currentRuntimeAgentId: 'other-runtime' });
    await h.ctx.run(`ctxStopAgent({
      ns: 'remote-ns', id: 'runtime-1', sessionId: 's1', variant: 'remote',
    })`);
    await flushMicrotasks();

    assert.ok(h.calls.invoke.some((args) => args[0] === 'stop_agent'));
    assert.equal(h.ctx.run(`isRuntimeStopPending('remote-ns', 's1', 'runtime-1')`), false);
  });

  it('resolves the host agent for child leaves before registering', async () => {
    const h = menuHarness({ currentRuntimeAgentId: 'other-runtime' });
    h.ctx.window.NavigationCore = {
      resolveHostAgentId: () => 'programming-helper',
    };
    await h.ctx.run(`ctxStopAgent({
      ns: 'programming-helper', id: 'runtime-1', sessionId: 's1', variant: 'child',
    })`);
    await flushMicrotasks();

    assert.ok(
      h.calls.invoke.some((args) => args[0] === 'stop_agent' && args[1]?.agentId === 'programming-helper'),
      'stop_agent addressed to the host agent',
    );
    assert.equal(h.ctx.run(`isRuntimeStopPending('programming-helper', 's1', 'runtime-1')`), true);
  });
});
