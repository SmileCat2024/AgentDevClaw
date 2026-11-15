/**
 * Tests for public/src/modules/ctx-menu-items.js
 *
 * Covers:
 *   - getCtxMenuItems (menu structure for runtime/session roles)
 *   - getSessionReplacementMutation (Map lookup)
 *   - dispatchCtxAction (action routing to window functions)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deepEqual as deepLoose } from 'node:assert';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

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

/**
 * Create a sandbox with ctx-menu-items.js loaded.
 * Returns { ctx, calls } where calls records window function invocations.
 */
function loadCtxMenuItems(overrides = {}) {
  const calls = [];

  const defaults = {
    currentLanguage: 'zh',
    allAgents: [TEST_AGENT],
    t: (key) => key,
    getWorkspaceSessionById: (agent, sid) => {
      const sessions = agent?.workspace_sessions?.sessions || [];
      return sessions.find((s) => s.id === sid) || null;
    },
    getWorkspaceSessions: (agent) => agent?.workspace_sessions?.sessions || [],
    updateAgentRecord: () => {},
    renderCurrentMainView: () => {},
    renderAgentList: () => {},
    lastRenderedWorkspaceHtml: '',
    ClawToast: { show() {}, update() {} },
    escapeHtml: (text) => {
      if (text == null) return '';
      return String(text).replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[m]);
    },
    CSS: { escape: (s) => s },
    bumpNavigationGuard: () => 1,
    _navigationGuardEpoch: 0,
    getExternalRuntimeAgent: () => null,
    clearAgentRuntimeCache: () => {},
    restartingRuntimeIds: new Set(),
    suppressSidebarRerender: false,
    restartSidebarExternalRuntime: () => ({}),
    loadAgents: () => {},
    requestSwitch: () => {},
    invoke: () => ({}),
    isRemoteNamespaceAgentId: (id) => typeof id === 'string' && id.startsWith('remote:'),
  };

  const ctx = createFrontendSandbox({ ...defaults, ...overrides });

  // Window function stubs with call recording
  ctx.window.switchAgent = (id) => { calls.push({ fn: 'switchAgent', args: [id] }); };
  ctx.window.closeCtxMenu = () => { calls.push({ fn: 'closeCtxMenu' }); };
  ctx.window.runWorkspaceAction = (json) => { calls.push({ fn: 'runWorkspaceAction', args: [json] }); };
  ctx.window.openTrimPage = (ns, sid, archive) => { calls.push({ fn: 'openTrimPage', args: [ns, sid, archive] }); };
  ctx.window.openBranchDialog = (ns, sid, archive) => { calls.push({ fn: 'openBranchDialog', args: [ns, sid, archive] }); };
  ctx.window.confirm = () => false;
  ctx.window.alert = () => {};

  ctx.loadSource('public/src/modules/sidebar-operations.js');
  ctx.loadSource('public/src/modules/session-mutation.js');
  // ctx-menu-items.js 的 restart/stop/archive 动作经 NavigationCore 解析宿主
  // 身份与 runtime 引用（ADR-0014 Phase 2）——缺失会 TypeError。
  ctx.loadSource('public/src/modules/navigation-core.js');
  // ctx-menu-items.js 依赖 assembly-data.js 的 isAssemblySession（见该文件
  // 头部「依赖 assembly-data.js」注释）——缺失会导致 getCtxMenuItems 抛
  // ReferenceError: isAssemblySession is not defined。
  ctx.loadSource('public/src/modules/assembly-data.js');
  // ctx-menu-items.js 的会话操作事实（sessionOpsAllowed）来自
  // session-menu-decls.js（ADR-0049 声明驱动）——缺失会 ReferenceError。
  ctx.loadSource('public/src/modules/session-menu-decls.js');
  ctx.loadSource('public/src/modules/ctx-menu-items.js');
  return { ctx, calls };
}

describe('ctx-menu-items: explicit restart identity', () => {
  it('uses the clicked child session even when the runtime catalog is stale', async () => {
    const requests = [];
    const { ctx } = loadCtxMenuItems({
      getExternalRuntimeAgent: () => ({ id: 'rt-old', parent_id: 'programming-helper', active_workspace_session_id: 'directory-session' }),
      invoke: async (command, payload) => { requests.push({ command, ...payload }); return {}; },
    });
    await ctx.run(`ctxRestartAgent({ ns: 'programming-helper', id: 'rt-old', sessionId: 'project-session', variant: 'child' })`);
    assert.deepEqual(requests, [{ command: 'restart_agent', agentId: 'programming-helper', sessionId: 'project-session' }]);
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
    ctx.window.phThreadArchiveCount = (agentId, sessionId) => (sessionId === 'sess-threaded' ? 2 : 0);
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
    ctx.window.phThreadArchiveCount = () => 0;
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
    ctx.run(`beginSidebarOperation({
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
  it('activate → window.switchAgent(id)', () => {
    const { ctx, calls } = loadCtxMenuItems();
    ctx.run(`dispatchCtxAction('activate', { id: 'rt-1', ns: 'ph', sessionId: 's1' })`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fn, 'switchAgent');
    assert.equal(calls[0].args[0], 'rt-1');
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

  it('trim → window.openTrimPage(ns, sid)', () => {
    const { ctx, calls } = loadCtxMenuItems();
    ctx.run(`dispatchCtxAction('trim', { ns: 'ph', id: 's1', sessionId: 's1' })`);
    assert.equal(calls[0].fn, 'openTrimPage');
    assert.equal(calls[0].args[0], 'ph');
    assert.equal(calls[0].args[1], 's1');
  });

  it('branch → window.openBranchDialog(ns, sid)', () => {
    const { ctx, calls } = loadCtxMenuItems();
    ctx.run(`dispatchCtxAction('branch', { ns: 'ph', id: 's1', sessionId: 's1' })`);
    assert.equal(calls[0].fn, 'openBranchDialog');
    assert.equal(calls[0].args[0], 'ph');
    assert.equal(calls[0].args[1], 's1');
  });

  // 归档 toast 按服务端 cleanup 事实展示：空闲归档只报结果；真的取消了
  // 排队消息才说明后果，且不得残留「指令」类内部术语。
  describe('thread-archive toast follows cleanup facts', () => {
    const archiveDispatch = async (cleanup) => {
      const toasts = [];
      const { ctx } = loadCtxMenuItems({
        currentRuntimeAgentId: '',
        ClawToast: { show: (opts) => toasts.push(opts), update() {} },
        fetch: async () => ({
          ok: true,
          json: async () => ({ ok: true, threadId: 'wt-1', cleanup }),
        }),
      });
      ctx.window.getThreadById = () => ({ threadId: 'wt-1', agentId: 'programming-helper', headViewerAgentId: 'rt-1' });
      ctx.window.refreshThreads = async () => ({ ok: true });
      await ctx.run(`dispatchCtxAction('thread-archive', { ns: 'programming-helper', id: 'rt-1', sessionId: 's1', threadId: 'wt-1' })`);
      // thread-archive 经 async IIFE 提交（提交回执即返回），等宏任务让 toast 落地
      await new Promise((resolve) => setTimeout(resolve, 0));
      return toasts.filter((t) => String(t.id || '').startsWith('ctx-thread-archive'));
    };

    it('idle archive: reports the result without inventing cancelled-message reminders', async () => {
      const toasts = await archiveDispatch({ status: 'complete', commandsCancelled: 0, handoffConverged: false, inflightDrain: { count: 0 } });
      assert.equal(toasts.length, 1);
      assert.equal(toasts[0].title, '已归档');
      assert.equal(toasts[0].description, undefined, 'nothing was cancelled — no description');
    });

    it('archive with cancelled commands: explains the consequence in user language', async () => {
      const toasts = await archiveDispatch({ status: 'complete', commandsCancelled: 2, handoffConverged: true, inflightDrain: { count: 1 } });
      assert.equal(toasts.length, 1);
      assert.equal(toasts[0].title, '已归档');
      assert.ok(toasts[0].description.includes('2 条排队中的消息已取消'), `description: ${toasts[0].description}`);
      assert.ok(toasts[0].description.includes('不会自动重新发送'), `description: ${toasts[0].description}`);
      assert.ok(!toasts[0].description.includes('指令'), 'no internal jargon in user-facing copy');
    });
  });

  it('rename-session → window.phOpenRenameDialog(ns, sid)', () => {
    const { ctx, calls } = loadCtxMenuItems();
    ctx.window.phOpenRenameDialog = (ns, sid) => { calls.push({ fn: 'phOpenRenameDialog', args: [ns, sid] }); };
    ctx.run(`dispatchCtxAction('rename-session', { ns: 'ph', id: 's1', sessionId: 's1' })`);
    const renameCall = calls.find((c) => c.fn === 'phOpenRenameDialog');
    assert.ok(renameCall, 'rename dialog must open for the main-list role');
    assert.deepEqual(renameCall.args, ['ph', 's1']);
  });

  it('open-history → phOpenThreadHistory with the resolved thread id', () => {
    const { ctx, calls } = loadCtxMenuItems();
    ctx.window.getThreadForSession = () => ({ threadId: 'wt-hist', headSessionId: 's1', lifeState: 'open' });
    ctx.window.phOpenThreadHistory = (ns, tid) => { calls.push({ fn: 'phOpenThreadHistory', args: [ns, tid] }); };
    ctx.run(`dispatchCtxAction('open-history', { ns: 'ph', id: 's1', sessionId: 's1' })`);
    const historyCall = calls.find((c) => c.fn === 'phOpenThreadHistory');
    assert.ok(historyCall, 'history panel must open');
    assert.deepEqual(historyCall.args, ['ph', 'wt-hist']);
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
  it('restart → calls closeCtxMenu', () => {
    const { ctx, calls } = loadCtxMenuItems();
    ctx.run(`dispatchCtxAction('restart', { ns: 'ph', id: 'rt-1', sessionId: 's1' })`);
    assert.ok(calls.find((c) => c.fn === 'closeCtxMenu'));
  });

  it('stop → calls closeCtxMenu', () => {
    const { ctx, calls } = loadCtxMenuItems();
    ctx.run(`dispatchCtxAction('stop', { ns: 'ph', id: 'rt-1', sessionId: 's1' })`);
    assert.ok(calls.find((c) => c.fn === 'closeCtxMenu'));
  });

  it('rename with ns+sessionId → calls closeCtxMenu', () => {
    const { ctx, calls } = loadCtxMenuItems();
    ctx.run(`dispatchCtxAction('rename', { ns: 'ph', id: 'rt-1', sessionId: 's1' })`);
    assert.ok(calls.find((c) => c.fn === 'closeCtxMenu'));
  });
});

// ── dispatchCtxAction: edge cases ───────────────────────────

describe('ctx-menu-items: dispatchCtxAction (edge cases)', () => {
  it('unknown action → no crash', () => {
    const { ctx } = loadCtxMenuItems();
    ctx.run(`dispatchCtxAction('totally-unknown', { ns: 'ph', id: 'rt-1' })`);
    // Should not throw — falls to default case with console.warn
  });

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
      invoke: (command, payload) => {
        calls.push({ fn: 'invoke', args: [command, payload] });
        return {};
      },
      loadAgents: () => {
        calls.push({ fn: 'loadAgents' });
      },
      requestSwitch: (id) => {
        calls.push({ fn: 'requestSwitch', args: [id] });
      },
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

  async function settle(ctx) {
    await ctx.run(`new Promise((resolve) => setTimeout(resolve, 10))`);
  }

  it('restart on a remote leaf invokes restart_agent with the host namespace id and re-locates the new runtime', async () => {
    const { ctx, calls } = loadRemoteHarness();
    ctx.run(`dispatchCtxAction('restart', { ns: '${REMOTE_NS}', id: 'remote:lab-b:rt-1', sessionId: 'remote:lab-b:sess-1', variant: 'remote' })`);
    await settle(ctx);
    const invokeCall = calls.find((c) => c.fn === 'invoke');
    assert.ok(invokeCall, 'restart_agent must go through invoke');
    assert.equal(invokeCall.args[0], 'restart_agent');
    assert.equal(invokeCall.args[1].agentId, REMOTE_NS, 'agentId must be the host namespace id');
    assert.equal(invokeCall.args[1].sessionId, 'remote:lab-b:sess-1');
    assert.ok(calls.some((c) => c.fn === 'RemoteConnections.refresh'), 'catalog must refresh after restart');
    assert.ok(calls.some((c) => c.fn === 'loadAgents'));
    const located = calls.find((c) => c.fn === 'waitForRuntimeForSession');
    assert.equal(located.args[0], 'remote:lab-b:sess-1', 'new runtime is located via the session');
    const switched = calls.find((c) => c.fn === 'requestSwitch');
    assert.equal(switched.args[0], 'remote:lab-b:rt-new');
  });

  it('stop on a remote leaf invokes stop_agent with the host namespace id', async () => {
    const { ctx, calls } = loadRemoteHarness();
    ctx.run(`dispatchCtxAction('stop', { ns: '${REMOTE_NS}', id: 'remote:lab-b:rt-1', sessionId: 'remote:lab-b:sess-1', variant: 'remote' })`);
    await settle(ctx);
    const invokeCall = calls.find((c) => c.fn === 'invoke');
    assert.ok(invokeCall, 'stop_agent must go through invoke');
    assert.equal(invokeCall.args[0], 'stop_agent');
    assert.equal(invokeCall.args[1].agentId, REMOTE_NS);
    assert.equal(invokeCall.args[1].sessionId, 'remote:lab-b:sess-1');
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
    const { ctx, calls } = loadCtxMenuItems({
      allAgents: [TEST_AGENT, childAgent],
      getExternalRuntimeAgent: (id) => [TEST_AGENT, childAgent].find((a) => a.id === id) || null,
      invoke: (command, payload) => {
        calls.push({ fn: 'invoke', args: [command, payload] });
        return {};
      },
      refreshSidebarRuntimeAfterMutation: () => Promise.resolve(),
    });
    ctx.run(`dispatchCtxAction('stop', { ns: 'programming-helper', id: 'rt-9', sessionId: 'sess-9', variant: 'child' })`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const invokeCall = calls.find((c) => c.fn === 'invoke');
    assert.ok(invokeCall, 'stop_agent must go through invoke');
    assert.equal(invokeCall.args[0], 'stop_agent');
    assert.equal(invokeCall.args[1].agentId, 'programming-helper',
      'agentId must resolve to the host via parent_id — sending the runtime id is a server-side silent no-op');
    assert.equal(invokeCall.args[1].sessionId, 'sess-9');
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
    const moved = [];
    const { ctx } = loadCtxMenuItems();
    ctx.window.phOpenSessionMoveDialog = (ids) => { moved.push(ids); };
    ctx.run(`dispatchCtxAction('claw:move-session', { ns: 'programming-helper', id: 'sess-active', variant: 'session' })`);
    assert.equal(moved.length, 1, 'claw:move-session 恰好触发一次移动对话框');
    assert.equal(moved[0][0], 'sess-active', 'claw:move-session 剥前缀后命中既有 move-session 处理器');
  });
});

// ── copy-id action ──────────────────────────────────────────

describe('ctx-menu-items: copy-id action', () => {
  function loadCopyHarness() {
    const copied = [];
    const toasts = [];
    const { ctx } = loadCtxMenuItems({
      navigator: { clipboard: { writeText: async (text) => { copied.push(text); } } },
      ClawToast: {
        show: (opts) => { toasts.push(opts); },
        update() {},
      },
    });
    ctx.window.isSecureContext = true;
    return { ctx, copied, toasts };
  }

  it('copies the sessionId when no thread data exists', async () => {
    const { ctx, copied, toasts } = loadCopyHarness();
    ctx.run(`dispatchCtxAction('copy-id', { ns: 'programming-helper', id: 'rt-1', sessionId: 'sess-abc' })`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(copied.includes('sess-abc'), 'clipboard must receive the sessionId');
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].status, 'success');
    assert.equal(toasts[0].description, 'sess-abc');
  });

  it('copies the thread id when the session resolves to a thread', async () => {
    const { ctx, copied, toasts } = loadCopyHarness();
    ctx.window.getThreadForSession = (ns, sid) => (sid === 'sess-th'
      ? { threadId: 'wt-abc', headSessionId: 'sess-th', lifeState: 'open' }
      : null);
    ctx.run(`dispatchCtxAction('copy-id', { ns: 'programming-helper', id: 'rt-1', sessionId: 'sess-th' })`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(copied.includes('wt-abc'), 'thread id wins when the conversation is threaded');
    assert.ok(!copied.includes('sess-th'), 'sessionId must not be copied for threaded rows');
    assert.equal(toasts[0].status, 'success');
  });

  it('runtime leaf without explicit sessionId falls back to id', async () => {
    const { ctx, copied, toasts } = loadCopyHarness();
    ctx.run(`dispatchCtxAction('copy-id', { ns: 'programming-helper', id: 'sess-fallback' })`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(copied.includes('sess-fallback'));
    assert.equal(toasts[0].status, 'success');
  });
});
