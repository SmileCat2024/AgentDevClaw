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
  };

  const ctx = createFrontendSandbox({ ...defaults, ...overrides });

  // Window function stubs with call recording
  ctx.window.switchAgent = (id) => { calls.push({ fn: 'switchAgent', args: [id] }); };
  ctx.window.closeCtxMenu = () => { calls.push({ fn: 'closeCtxMenu' }); };
  ctx.window.runWorkspaceAction = (json) => { calls.push({ fn: 'runWorkspaceAction', args: [json] }); };
  ctx.window.openTrimDialog = (ns, sid, archive) => { calls.push({ fn: 'openTrimDialog', args: [ns, sid, archive] }); };
  ctx.window.openBranchDialog = (ns, sid, archive) => { calls.push({ fn: 'openBranchDialog', args: [ns, sid, archive] }); };
  ctx.window.confirm = () => false;
  ctx.window.alert = () => {};

  ctx.loadSource('public/src/modules/sidebar-operations.js');
  ctx.loadSource('public/src/modules/session-mutation.js');
  ctx.loadSource('public/src/modules/ctx-menu-items.js');
  return { ctx, calls };
}

// ── getCtxMenuItems: runtime role ───────────────────────────

describe('ctx-menu-items: getCtxMenuItems (runtime)', () => {
  it('runtime + programming-helper → full menu with submenus', () => {
    const { ctx } = loadCtxMenuItems();
    const items = ctx.run(`getCtxMenuItems('runtime', 'programming-helper', 'managed-runtime', 'rt-1')`);
    // Expected: rename, generate-title, summary submenu, trim submenu, branch submenu,
    //           separator, archive-and-stop, restart, stop, delete-session-runtime
    assert.equal(items.length, 10);
    assert.equal(items[0].action, 'rename');
    assert.equal(items[1].action, 'generate-title');
    assert.ok(items[2].submenu, 'summary should have submenu');
    assert.equal(items[2].submenu[0].action, 'summary');
    assert.equal(items[2].submenu[1].action, 'summary-and-archive');
    assert.ok(items[3].submenu, 'trim should have submenu');
    assert.ok(items[4].submenu, 'branch should have submenu');
    assert.equal(items[5].type, 'separator');
    assert.equal(items[6].action, 'archive-and-stop');
    assert.equal(items[7].action, 'restart');
    assert.equal(items[8].action, 'stop');
    assert.equal(items[8].danger, true);
    assert.equal(items[9].action, 'delete-session-runtime');
    assert.equal(items[9].danger, true);
  });

  it('runtime with archived active session → unarchive label', () => {
    const { ctx } = loadCtxMenuItems({
      allAgents: [{
        id: 'programming-helper',
        workspace_sessions: {
          activeSessionId: 'sess-archived',
          sessions: [{ id: 'sess-archived', archived: true }],
        },
      }],
    });
    const items = ctx.run(`getCtxMenuItems('runtime', 'programming-helper', 'managed-runtime', 'rt-1')`);
    const archiveItem = items.find((i) => i.action === 'archive-and-stop');
    assert.ok(archiveItem.label.includes('取消归档'));
  });
});

// ── getCtxMenuItems: session role ───────────────────────────

describe('ctx-menu-items: getCtxMenuItems (session)', () => {
  it('session main (not archived, not todo) → full menu with submenus', () => {
    const { ctx } = loadCtxMenuItems();
    const items = ctx.run(`getCtxMenuItems('session', 'programming-helper', 'main', 'sess-active')`);
    // Expected: generate-title, summary submenu, trim submenu, branch submenu,
    //           separator, todo-session, archive-session, delete-session
    assert.equal(items.length, 8);
    assert.equal(items[0].action, 'generate-title');
    assert.ok(items[1].submenu, 'summary should have submenu');
    assert.ok(items[2].submenu, 'trim should have submenu');
    assert.ok(items[3].submenu, 'branch should have submenu');
    assert.equal(items[4].type, 'separator');
    assert.equal(items[5].action, 'todo-session');
    assert.equal(items[5].label, '设为待办'); // not todo → set
    assert.equal(items[6].action, 'archive-session');
    assert.equal(items[7].action, 'delete-session');
    assert.equal(items[7].danger, true);
  });

  it('session archived → flattened items, no submenus, no todo', () => {
    const { ctx } = loadCtxMenuItems();
    const items = ctx.run(`getCtxMenuItems('session', 'programming-helper', 'archived', 'sess-archived')`);
    // Expected: generate-title, summary (flat), trim (flat), branch (flat),
    //           separator, archive-session (unarchive), delete-session
    assert.equal(items.length, 7);
    assert.equal(items[1].action, 'summary');
    assert.ok(!items[1].submenu, 'archived: summary should be flat');
    assert.equal(items[2].action, 'trim');
    assert.ok(!items[2].submenu);
    assert.equal(items[3].action, 'branch');
    assert.ok(!items[3].submenu);
    // No todo toggle for archived
    assert.ok(!items.find((i) => i.action === 'todo-session'));
  });

  it('session exploration → no summary/trim/branch', () => {
    const { ctx } = loadCtxMenuItems();
    const items = ctx.run(`getCtxMenuItems('session', 'programming-helper', 'exploration', 'sess-active')`);
    // Expected: generate-title, separator, todo-session, archive-session, delete-session
    assert.equal(items.length, 5);
    assert.equal(items[0].action, 'generate-title');
    assert.ok(!items.find((i) => i.action === 'summary'));
    assert.ok(!items.find((i) => i.action === 'trim'));
    assert.ok(!items.find((i) => i.action === 'branch'));
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
    assert.equal(del.label, 'Delete');
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
  });

  it('summary-and-archive → includes archiveOriginal', () => {
    const { ctx, calls } = loadCtxMenuItems();
    ctx.run(`dispatchCtxAction('summary-and-archive', { ns: 'ph', id: 's1', sessionId: 's1' })`);
    const payload = JSON.parse(calls[0].args[0]);
    assert.equal(payload.archiveOriginal, true);
  });

  it('trim → window.openTrimDialog(ns, sid)', () => {
    const { ctx, calls } = loadCtxMenuItems();
    ctx.run(`dispatchCtxAction('trim', { ns: 'ph', id: 's1', sessionId: 's1' })`);
    assert.equal(calls[0].fn, 'openTrimDialog');
    assert.equal(calls[0].args[0], 'ph');
    assert.equal(calls[0].args[1], 's1');
  });

  it('trim-and-archive → openTrimDialog with archive=true', () => {
    const { ctx, calls } = loadCtxMenuItems();
    ctx.run(`dispatchCtxAction('trim-and-archive', { ns: 'ph', id: 's1', sessionId: 's1' })`);
    assert.equal(calls[0].args[2], true);
  });

  it('branch → window.openBranchDialog(ns, sid)', () => {
    const { ctx, calls } = loadCtxMenuItems();
    ctx.run(`dispatchCtxAction('branch', { ns: 'ph', id: 's1', sessionId: 's1' })`);
    assert.equal(calls[0].fn, 'openBranchDialog');
    assert.equal(calls[0].args[0], 'ph');
    assert.equal(calls[0].args[1], 's1');
  });

  it('branch-and-archive → openBranchDialog with archive=true', () => {
    const { ctx, calls } = loadCtxMenuItems();
    ctx.run(`dispatchCtxAction('branch-and-archive', { ns: 'ph', id: 's1', sessionId: 's1' })`);
    assert.equal(calls[0].args[2], true);
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
