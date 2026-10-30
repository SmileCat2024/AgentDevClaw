import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentDiscoveryModule } from '../server/routes/agent-discovery.js';
import { createConnectedAgentsQuery } from '../server/routes/agent-connected.js';

// ── In-process ViewerWorker snapshot wiring (ga-slow fix 2026-10-29) ──
// 契约：注入快照函数后 per-runtime 查询不再走 HTTP self-fetch；
// null 语义与 fetch 失败路径对齐；未注入时保持 fetch 回退。

function buildDiscovery({ snapshot } = {}) {
  const api = createAgentDiscoveryModule({
    sessionApi: {},
    ...(snapshot !== undefined ? { getInputRequestsSnapshot: snapshot } : {}),
  });
  return api;
}

test('getPendingInputCount uses in-process snapshot when provided', async () => {
  const calls = [];
  const api = buildDiscovery({
    snapshot: (id) => { calls.push(id); return [{ id: 'lease-1' }, { id: 'lease-2' }]; },
  });
  const count = await api.getPendingInputCount('agent-1');
  assert.equal(count, 2);
  assert.deepEqual(calls, ['agent-1']);
});

test('getPendingInputCount null snapshot aligns with fetch failure semantics', async () => {
  const api = buildDiscovery({ snapshot: () => null });
  assert.equal(await api.getPendingInputCount('missing-agent'), null);
});

test('getPendingInputCount snapshot throw aligns with fetch failure semantics', async () => {
  const api = buildDiscovery({ snapshot: () => { throw new Error('boom'); } });
  assert.equal(await api.getPendingInputCount('agent-1'), null);
});

test('notification callActive flows through getRuntimeNotification', async () => {
  let viewerFetched = false;
  const snapshotCalls = [];
  const runtimeAgent = { id: 'running-agent', name: 'R', connected: true };
  const { getConnectedAgents } = createConnectedAgentsQuery({
    getAgentsLight: async () => [{ id: 'demo-agent', name: 'Demo', description: '', status: {} }],
    readActiveWorkspaceSessionMeta: async () => ({
      workspaceSessions: { activeSessionId: null, sessions: [] },
      sessionMeta: {},
    }),
    readWorkspaceSessionMeta: async () => ({}),
    readViewerJson: async (pathname) => {
      if (pathname === '/api/agents') return { agents: [runtimeAgent] };
      viewerFetched = true;
      return {};
    },
    getPendingInputCount: async () => 0,
    resolveAgentModelPresets: async () => [],
    getRuntimeNotification: (id) => {
      snapshotCalls.push(id);
      return { callActive: true };
    },
    resolveThreadControl: () => ({
      core: { listThreads: async () => [] },
      archive: { list: async () => ({}) },
    }),
  });
  const agents = await getConnectedAgents();
  const child = agents.find((a) => a.id === 'running-agent');
  assert.ok(child, 'viewer-only runtime projected');
  assert.equal(child.callActive, true, 'callActive from in-process snapshot');
  assert.deepEqual(snapshotCalls, ['running-agent']);
  assert.equal(viewerFetched, false, 'notification must not go through HTTP fetch');
});

test('notification falls back to readViewerJson fetch when snapshot absent', async () => {
  const fetched = [];
  const runtimeAgent = { id: 'running-agent', name: 'R', connected: true };
  const { getConnectedAgents } = createConnectedAgentsQuery({
    getAgentsLight: async () => [{ id: 'demo-agent', name: 'Demo', description: '', status: {} }],
    readActiveWorkspaceSessionMeta: async () => ({
      workspaceSessions: { activeSessionId: null, sessions: [] },
      sessionMeta: {},
    }),
    readWorkspaceSessionMeta: async () => ({}),
    readViewerJson: async (pathname) => {
      if (pathname === '/api/agents') return { agents: [runtimeAgent] };
      fetched.push(pathname);
      return { callActive: true };
    },
    getPendingInputCount: async () => 0,
    resolveAgentModelPresets: async () => [],
    resolveThreadControl: () => ({
      core: { listThreads: async () => [] },
      archive: { list: async () => ({}) },
    }),
  });
  const agents = await getConnectedAgents();
  const child = agents.find((a) => a.id === 'running-agent');
  assert.ok(child, 'viewer-only runtime projected');
  assert.equal(child.callActive, true);
  assert.ok(fetched.some((p) => p.includes('/notification')), 'fetch fallback used');
});
