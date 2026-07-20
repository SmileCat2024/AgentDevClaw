import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function createArchiveSandbox() {
  const ctx = createFrontendSandbox({ renderCount: 0, currentLanguage: 'zh' });
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

  it('does not hide a target-readiness failure merely because the source stopped', async () => {
    const ctx = createArchiveSandbox();
    ctx.fetch = async () => ({
      ok: true,
      json: async () => ({ lifecycle: 'missing', viewerConnected: false }),
    });
    ctx.loadAgents = async () => {};
    ctx.window.setTimeout = (callback) => {
      Promise.resolve().then(callback);
      return 1;
    };
    ctx.run(`
      allAgents = [{
        id: 'programming-helper',
        workspace_sessions: { activeSessionId: 'session-1', sessions: [{ id: 'session-1' }] }
      }];
      beginSessionReplacementMutation('programming-helper', 'session-1', 'summary');
      updateSessionReplacementMutation('programming-helper', 'session-1', {
        phase: 'source-stopping',
        targetSessionId: 'session-2',
        errorCode: 'target_runtime_not_ready'
      });
      settleSessionReplacementMutation('programming-helper', 'session-1', 0, 1);
    `);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const operation = ctx.run(`getSessionReplacementMutation('programming-helper', 'session-1')`);
    assert.equal(operation.phase, 'degraded');
    assert.equal(operation.errorCode, 'target_runtime_not_ready');
  });
});
