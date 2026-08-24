import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function createArchiveSandbox() {
  const ctx = createFrontendSandbox({
    renderCount: 0,
    currentLanguage: 'zh',
    URLSearchParams,
    // app-core.js 资源身份 helper（tickets 026-032 引入）：session-mutation.js
    // 直接调用这些 helper，而本测试仅加载 session-mutation.js 不加载 app-core.js
    getParentAgentId: (record) => record?.parent_id || record?.parentId || null,
    getRuntimeId: (record) => (record && (record.source === 'child' || record.source === 'external') ? record.id : null) || null,
    getActiveSessionId: (record) =>
      record?.workspace_sessions?.activeSessionId
      ?? record?.active_workspace_session_id
      ?? record?.sessionId
      ?? null,
  });
  ctx.console = { ...console, error() {} };
  ctx.getWorkspaceSessions = (agent) => (
    Array.isArray(agent?.workspace_sessions?.sessions) ? agent.workspace_sessions.sessions : []
  );
  ctx.updateAgentRecord = (agentId, updates = {}) => {
    let matched = null;
    ctx.allAgents = ctx.allAgents.map((agent) => {
      if (agent.id !== agentId) return agent;
      matched = { ...agent, ...updates };
      return matched;
    });
    return matched;
  };
  ctx.renderCurrentMainView = () => {
    ctx.renderCount += 1;
  };
  ctx.loadSource('public/src/modules/sidebar-operations.js');
  ctx.loadSource('public/src/modules/session-mutation.js');
  ctx.loadSource('public/src/modules/ctx-menu-items.js');
  return ctx;
}

describe('session archive optimistic helper', () => {
  it('marks a session archived immediately and clears todo', () => {
    const ctx = createArchiveSandbox();
    ctx.run(`
      allAgents = [{
        id: 'programming-helper',
        active_workspace_session_id: 'session-1',
        workspace_sessions: {
          activeSessionId: 'session-1',
          sessions: [
            { id: 'session-1', title: 'Old', archived: false, todo: true },
            { id: 'session-2', title: 'Other', archived: false }
          ]
        }
      }];
      lastRenderedWorkspaceHtml = 'cached';
      rollback = markSessionArchivedForMutation('programming-helper', 'session-1');
    `);

    const session = ctx.run(`allAgents[0].workspace_sessions.sessions.find((s) => s.id === 'session-1')`);
    assert.equal(session.archived, true);
    assert.equal(session.todo, false);
    assert.equal(ctx.run('allAgents[0].workspace_sessions.activeSessionId'), 'session-1');
    assert.equal(ctx.run('lastRenderedWorkspaceHtml'), '');
    assert.equal(ctx.renderCount, 1);
    assert.equal(ctx.run(`getSessionReplacementMutation('programming-helper', 'session-1').kind`), 'summary');
  });

  it('returns a rollback that restores the previous archive and todo state', () => {
    const ctx = createArchiveSandbox();
    ctx.run(`
      allAgents = [{
        id: 'programming-helper',
        active_workspace_session_id: 'session-1',
        workspace_sessions: {
          activeSessionId: 'session-1',
          sessions: [
            { id: 'session-1', title: 'Old', archived: false, todo: true }
          ]
        }
      }];
      rollback = markSessionArchivedForMutation('programming-helper', 'session-1');
      rollback();
    `);

    const session = ctx.run(`allAgents[0].workspace_sessions.sessions[0]`);
    assert.equal(session.archived, false);
    assert.equal(session.todo, true);
    assert.equal(ctx.renderCount, 2);
  });

  it('uses the rollback when final archive confirmation fails', async () => {
    const ctx = createArchiveSandbox();
    ctx.fetch = async () => ({ ok: false, text: async () => 'archive failed' });
    ctx.invoke = async () => {
      throw new Error('runtime stop should not run');
    };
    ctx.clearAgentRuntimeCache = () => {};
    ctx.refreshSidebarRuntimeAfterMutation = () => {};

    const result = await ctx.run(`
      (async () => {
        allAgents = [{
          id: 'programming-helper',
          active_workspace_session_id: 'session-1',
          workspace_sessions: {
            activeSessionId: 'session-1',
            sessions: [
              { id: 'session-1', title: 'Old', archived: false, todo: true }
            ]
          }
        }];
        const rollback = markSessionArchivedForMutation('programming-helper', 'session-1');
        const ok = await archiveSessionAfterMutation('programming-helper', 'session-1', 'runtime-1', {
          skipOptimisticArchive: true,
          rollback,
        });
        return { ok, session: allAgents[0].workspace_sessions.sessions[0] };
      })()
    `);

    assert.equal(result.ok, false);
    assert.equal(result.session.archived, false);
    assert.equal(result.session.todo, true);
    assert.equal(ctx.run(`getSessionReplacementMutation('programming-helper', 'session-1')`), null);
  });

  it('separates archived source cleanup from the committed replacement operation', async () => {
    const ctx = createArchiveSandbox();
    let stopCalls = 0;
    ctx.invoke = async (command, payload) => {
      stopCalls += 1;
      assert.equal(command, 'stop_agent');
      assert.equal(payload.agentId, 'programming-helper');
      assert.equal(payload.sessionId, 'session-1');
    };
    ctx.clearAgentRuntimeCache = () => {};
    ctx.refreshSidebarRuntimeAfterMutation = async () => {};
    ctx.run(`
      allAgents = [{
        id: 'programming-helper',
        workspace_sessions: { activeSessionId: 'session-1', sessions: [{ id: 'session-1' }] }
      }];
      beginSessionReplacementMutation('programming-helper', 'session-1', 'summary');
      finishSidebarOperation(getSessionReplacementMutation('programming-helper', 'session-1').operationId, 'settled');
      requestArchivedSourceRuntimeCleanup('programming-helper', 'session-1', 'runtime-1');
    `);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(stopCalls, 1);
    assert.equal(ctx.run(`getSessionReplacementMutation('programming-helper', 'session-1')`), null);
  });
});
