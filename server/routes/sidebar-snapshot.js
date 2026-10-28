import { managedAgents, isManagedRuntimeRunning } from '../shared/agent-access.js';

// One read transaction for sidebar identity and runtime presence. This is a
// projection of existing authorities, not another thread lifecycle store.
export async function readSidebarThreads(control) {
  const [summaries, archived] = await Promise.all([
    control.core.listThreads({}), control.archive.list(),
  ]);
  return Promise.all(summaries.map(async summary => {
    const full = summary.status === 'rotating' ? await control.core.getThread(summary.threadId) : null;
    const thread = full || summary;
    return {
      threadId: thread.threadId, agentId: thread.agentId,
      headSessionId: thread.headSessionId,
      sessionIds: full ? (full.sessionChain || []).map(entry => entry.sessionId) : (summary.sessionIds || []),
      title: thread.title || '', status: thread.status, revision: thread.revision,
      archivedAt: archived[thread.threadId]?.archivedAt || null,
      deleting: thread.deleting === true,
      handoffStartedAt: full ? Number(full.pendingSuccession?.startedAt) || 0 : Number(summary.handoffStartedAt) || 0,
    };
  }));
}

function runtimeStamp() {
  return JSON.stringify([...managedAgents.values()].map(runtime => [
    runtime.key, runtime.agentId, runtime.selectedSessionId, runtime.viewerAgentId,
    isManagedRuntimeRunning(runtime), runtime.ready === true,
  ]));
}

export async function readSidebarSnapshot(control, project) {
  // Retry only when an observed authority actually changed across the read.
  // Sustained mutation is an explicit failed read, never an empty/partial frame.
  for (let attempt = 0; attempt < 3; attempt++) {
    const runtimesBefore = runtimeStamp();
    const threads = await readSidebarThreads(control);
    const result = await project(threads);
    const after = await readSidebarThreads(control);
    if (runtimesBefore === runtimeStamp() && JSON.stringify(threads) === JSON.stringify(after)) return result;
  }
  throw Object.assign(new Error('Sidebar state changed during projection'), {
    code: 'sidebar_snapshot_changed', status: 409, statusCode: 409,
  });
}
