import assert from 'node:assert/strict';
import test from 'node:test';
import { createPollMaintenance } from '../public/src/modules/poll-maintenance.js';

function fixture(overrides = {}) {
  let now = 10000, lastWorkspace = 0, lastAgents = now;
  let fresh = { revision: 7, sessions: [{ id: 'a', archived: false }], contextLength: null, compressRatio: null };
  const record = { id: 'host', workspace_sessions: { sessions: [{ id: 'a', archived: true }], contextLength: 1000, compressRatio: 50 } };
  const requests = [], effects = [];
  const host = {
    agents: () => [record], focused: () => 'host', now: () => now,
    isPh: () => true, browsingTarget: () => ({ type: 'project', id: 'project' }),
    workspaceState: () => ({ openDirectory: 'wrong-dir' }),
    fetch: async url => { requests.push(url); return { ok: true, json: async () => fresh }; },
    isWorkspace: () => true, detailLoaded: () => true,
    lastWorkspaceRefresh: () => lastWorkspace, setWorkspaceRefresh: v => { lastWorkspace = v; },
    lastAgentRefresh: () => lastAgents, setAgentRefresh: v => { lastAgents = v; },
    sseActive: () => true, loadAgents: async () => effects.push('agents'), refreshCalls: async () => {},
    isCurrent: () => true, apply: () => {}, notify: () => {}, merge: (_old, value) => value,
    renderWorkspace: (value, soft) => effects.push({ sessions: value.workspace_sessions, soft }),
    updateComposer: () => {}, panel: () => null, loadLogs: async () => {},
    normalizeHooks: value => value, hookSignature: JSON.stringify, currentHookSignature: () => '',
    patch: (_token, _patch, effect) => { effect(); return true; },
    commit: (_token, effect) => { effect(); return true; },
    saveCache: id => effects.push(['cache', id]), trackRecap: () => effects.push('recap'),
    ...overrides,
  };
  return { ...createPollMaintenance(host), record, requests, effects,
    advance: () => { now += 4000; }, fresh: value => { fresh = value; } };
}

test('conditional reads retain project ownership, range and revision, but unchanged reads publish nothing', async () => {
  const f = fixture();
  const result = await f.fetchWorkspaceSessionsForPoll('host');
  assert.equal(result.revision, 7);
  let params = new URL(f.requests[0], 'http://test').searchParams;
  assert.equal(params.get('projectId'), 'project');
  assert.equal(params.has('projectDir'), false);
  assert.equal(params.get('limit'), '60');
  f.fresh({ unchanged: true });
  assert.equal(await f.fetchWorkspaceSessionsForPoll('host'), null);
  params = new URL(f.requests[1], 'http://test').searchParams;
  assert.equal(params.get('sinceRevision'), '7');
});

test('runtime refresh preserves optimistic archive and known model parameters before cache capture', async () => {
  const f = fixture();
  assert.equal(await f._runPollTailLowFrequency({ runtimeId: 'rt' }), true);
  assert.deepEqual(f.record.workspace_sessions.sessions, [{ id: 'a', archived: true, todo: false }]);
  assert.equal(f.record.workspace_sessions.contextLength, 1000);
  assert.equal(f.record.workspace_sessions.compressRatio, 50);
  assert.equal(f.effects[0].soft, false);
  assert.deepEqual(f.effects.slice(1), [['cache', 'rt'], 'recap']);
});

test('departed runtime cannot merge or render a completed workspace refresh or capture its cache', async () => {
  const f = fixture({ isCurrent: () => false });
  assert.equal(await f._runPollTailLowFrequency({ runtimeId: 'old' }), false);
  assert.equal(f.record.workspace_sessions.contextLength, 1000);
  assert.deepEqual(f.effects, []);
});

test('workspace-only refresh retains its soft-render contract and suppresses unchanged revisions', async () => {
  const f = fixture();
  await f.refreshUnfocusedPoll();
  assert.equal(f.effects[0].soft, true);
  assert.equal(f.record.workspace_sessions.sessions[0].archived, true);
  f.advance();
  f.fresh({ unchanged: true });
  await f.refreshUnfocusedPoll();
  assert.equal(f.effects.filter(e => typeof e === 'object' && !Array.isArray(e)).length, 1);
});

test('self-managed panels do not fetch hooks, while a stale hooks commit cannot write cache', async () => {
  const independent = fixture({ panel: () => 'session-controls', lastWorkspaceRefresh: () => 10000 });
  await independent._runPollTailLowFrequency({ runtimeId: 'rt' });
  assert.deepEqual(independent.requests, []);
  const stale = fixture({ panel: () => 'features', lastWorkspaceRefresh: () => 10000, patch: () => false });
  assert.equal(await stale._runPollTailLowFrequency({ runtimeId: 'rt' }), false);
  assert.deepEqual(stale.requests, ['/api/agents/rt/hooks']);
  assert.deepEqual(stale.effects, []);
});
