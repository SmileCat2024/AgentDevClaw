import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = await mkdtemp(path.join(tmpdir(), 'claw-sidebar-thread-'));
process.env.AGENTDEV_DATA_DIR = root;
const { createConnectedAgentsQuery } = await import('../server/routes/agent-connected.js');
const { managedAgents } = await import('../server/shared/agent-access.js');
after(() => rm(root, { recursive: true, force: true }));
import { createFrontendSandbox } from './helpers/frontend-vm.js';

const { readSidebarSnapshot } = await import('../server/routes/sidebar-snapshot.js');
test('unstable sidebar reads fail explicitly rather than publish a partial frame', async () => {
  let head = 0;
  const control = { core: { listThreads: async () => [{ threadId: 't', agentId: 'custom', headSessionId: String(head), status: 'open' }] },
    archive: { list: async () => ({}) } };
  await assert.rejects(readSidebarSnapshot(control, async () => { head++; return []; }), { code: 'sidebar_snapshot_changed' });
});

// Same production query -> production renderer for any host; the independently
// polled thread board is deliberately wrong throughout this sequence.
for (const agentId of ['programming-helper', 'coder', 'memo', 'custom-thread-host']) {
  test(`${agentId}: one thread leaf across handoff, commit during query, and close`, async () => {
    let thread = { threadId: 't1', agentId, headSessionId: 'old', sessionIds: ['old'], title: 'work', status: 'open' };
    let viewer = [];
    let archived = {};
    let duringMeta = null;
    const meta = sid => ({ active_workspace_session_id: sid, active_workspace_session_title: sid,
      active_workspace_display_name: sid, open_directory: '/project', source_session_id: sid === 'new' ? 'old' : '' });
    const control = { core: {
      listThreads: async () => [structuredClone(thread)],
      getThread: async () => ({ ...structuredClone(thread), sessionChain: thread.sessionIds.map(sessionId => ({ sessionId })),
        pendingSuccession: thread.status === 'rotating' ? { startedAt: 1 } : null }),
    }, archive: { list: async () => structuredClone(archived) } };
    const query = createConnectedAgentsQuery({
      getAgentsLight: async () => [{ id: agentId, name: agentId, status: {}, visibility: 'on-demand' }],
      readActiveWorkspaceSessionMeta: async () => ({ workspaceSessions: { sessions: [] }, sessionMeta: {} }),
      readWorkspaceSessionMeta: async (_id, sid) => { const action = duringMeta; duringMeta = null; action?.(); return meta(sid); },
      readViewerJson: async url => url === '/api/agents' ? { agents: viewer } : {},
      getPendingInputCount: async () => 0, resolveAgentModelPresets: async () => [],
      readVisibilityOverrides: async () => ({}), resolveThreadControl: () => control,
    });
    const ctx = createFrontendSandbox({ t: x => x, currentLanguage: 'zh', normalizeAgentIdentity: x => x || '',
      toEpochMs: x => Date.parse(x) || 0, getWorkspaceSessions: a => a.workspace_sessions?.sessions || [],
      getParentAgentId: a => a.parent_id, getRuntimeId: a => a.runtime_session_id,
      getActiveSessionId: a => a.active_workspace_session_id, getPathLeaf: x => x.split('/').pop() });
    ctx.window.setInterval = () => 0;
    ctx.window.ClawThreads = { threads: [{ ...thread, headSessionId: 'wrong', lifeState: 'executing', headRuntimeRunning: true }] };
    ctx.loadSource('public/src/modules/runtime-status.js');
    const runtime = sid => ({ key: `${agentId}::${sid}`, agentId, selectedSessionId: sid,
      viewerAgentId: `r-${sid}`, ready: true, process: { exitCode: null, pid: 1 } });
    const old = runtime('old');
    managedAgents.set(old.key, old);
    viewer = [{ id: 'r-old', connected: true }];
    const frame = async expected => {
      const agents = await query.getConnectedAgents();
      ctx.agents = agents;
      const entries = ctx.run('collectRuntimeEntriesForPrebuilt(agents[0], agents)');
      assert.equal(entries.length, expected ? 1 : 0);
      if (expected) { assert.equal(entries[0].threadId, 't1'); assert.equal(entries[0].sessionId, expected); }
      return entries;
    };
    try {
      await frame('old');
      thread = { ...thread, status: 'rotating', handoffStartedAt: 1 };
      old.stopped = true;
      await frame('old'); // explicit handoff, even with an old timestamp (no UI TTL)
      const next = runtime('new');
      managedAgents.set(next.key, next);
      await frame('old'); // ready successor before head commit must not be a second leaf
      duringMeta = () => { thread = { ...thread, status: 'open', headSessionId: 'new', sessionIds: ['old', 'new'], handoffStartedAt: 0 }; };
      await frame('new'); // query straddles commit; Viewer still only has the old runtime
      next.stopped = true;
      await frame(null); // stale thread board + stale Viewer cannot recreate a leaf
      ctx.run('_threadSidebarEntries.clear()');
      await frame(null); // cold cache / reload
      thread = { ...thread, status: 'rotating', handoffStartedAt: 1 };
      await frame('new');
      thread = { ...thread, status: 'rotation_failed', handoffStartedAt: 0 };
      await frame(null); // failed handoff has no leftover placeholder
      next.stopped = false;
      await frame('new'); // restart opens the same logical conversation again
      duringMeta = () => { archived = { t1: { archivedAt: 10 } }; };
      await frame(null); // archive committed during projection rejects the old frame
    } finally { managedAgents.clear(); }
  });
}
