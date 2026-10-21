import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeWorkspaceAgents, resolveWorkspaceAgent, resolveNewSessionAgent, resolveWorkspaceAgentClass } from '../server/shared/workspace-agents.js';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

const metadata = { id: 'programming-helper', name: '工作空间', defaultAgentId: 'main', agents: [
  { id: 'main', displayName: '编程小助手' }, { id: 'reviewer', displayName: { zh: '审查助手', en: 'Reviewer' } },
] };

test('validates declarations and preserves the explicit legacy main contract', () => {
  assert.equal(normalizeWorkspaceAgents({ name: '旧应用' }).agents[0].displayName, '旧应用');
  assert.equal(resolveWorkspaceAgent(metadata).id, 'main');
  assert.equal(resolveWorkspaceAgent(metadata, 'reviewer').displayName.en, 'Reviewer');
  for (const input of [
    { agents: [] }, { agents: metadata.agents },
    { ...metadata, defaultAgentId: 'missing' },
    { ...metadata, agents: [metadata.agents[0], metadata.agents[0]] },
    { agents: [{ id: '../evil', displayName: 'A' }] },
    { agents: [{ id: 'main', displayName: '' }] }, { defaultAgentId: 'reviewer' },
  ]) assert.throws(() => normalizeWorkspaceAgents(input), { code: 'invalid_workspace_agent' });
  for (const id of ['', null, 1, 'missing']) assert.throws(() => resolveWorkspaceAgent(metadata, id));
});

test('derived sessions retain their Agent even when the default changes', () => {
  const changed = { ...metadata, defaultAgentId: 'reviewer' };
  assert.equal(resolveNewSessionAgent(changed), 'reviewer');
  assert.equal(resolveNewSessionAgent(changed, {}, {}), 'main');
  assert.equal(resolveNewSessionAgent(changed, {}, { workspaceAgentId: 'reviewer' }), 'reviewer');
  assert.throws(() => resolveNewSessionAgent(metadata, { workspaceAgentId: 'main' }, { workspaceAgentId: 'reviewer' }));
});

test('each session selects its own assembly, missing exports fail explicitly', () => {
  class Main {} class Reviewer {}
  const module = { default: Main, agents: { reviewer: Reviewer } };
  assert.ok(new (resolveWorkspaceAgentClass(module, 'main'))() instanceof Main);
  assert.ok(new (resolveWorkspaceAgentClass(module, 'reviewer'))() instanceof Reviewer);
  assert.throws(() => resolveWorkspaceAgentClass({ default: Main }, 'reviewer'));
  assert.equal(resolveWorkspaceAgentClass({ Main }, 'main'), Main);
  assert.throws(() => resolveWorkspaceAgentClass({ Main, Reviewer }, 'main'));
});

function welcomeSandbox() {
  const ctx = createFrontendSandbox();
  ctx.loadSource('public/src/app-core.js');
  ctx.loadSource('public/src/modules/session-view-state.js');
  ctx.loadSource('public/src/modules/workspace-agents.js');
  ctx.run(`allAgents = [${JSON.stringify({ ...metadata, source: 'prebuilt', workspace_sessions: { activeSessionId: 'other', sessions: [{ id: 's1', workspaceAgentId: 'main' }, { id: 's2', workspaceAgentId: 'reviewer' }] } })}]; focusedAgentId = 'programming-helper'; currentRuntimeAgentId = 'r1';`);
  return ctx;
}

test('welcome follows the selected Session, not workspace active/title/default; handles language and unknown identity', () => {
  const ctx = welcomeSandbox();
  ctx.run(`applySessionViewPatch({identity: {agentId: 'programming-helper', sessionId: 's2'}})`);
  assert.match(ctx.run('getEmptyStateHtml()'), /欢迎使用 审查助手/);
  ctx.run(`currentLanguage = 'en'`);
  assert.match(ctx.run('getEmptyStateHtml()'), /Welcome to Reviewer/);
  ctx.run(`applySessionViewPatch({identity: {agentId: 'programming-helper', sessionId: 's1'}})`);
  assert.match(ctx.run('getEmptyStateHtml()'), /编程小助手/);
  ctx.run(`applySessionViewPatch({identity: {agentId: 'programming-helper', sessionId: 'unknown'}})`);
  assert.match(ctx.run('getEmptyStateHtml()'), /New Conversation/);
  assert.doesNotMatch(ctx.run('getEmptyStateHtml()'), /编程小助手|审查助手|工作空间/);
});

test('bound metadata survives view normalization and overrides stale catalog; stale view commits cannot change it', () => {
  const ctx = welcomeSandbox();
  ctx.run(`applySessionViewPatch({identity: {agentId: 'programming-helper', sessionId: 's1'}});
    applySessionViewPatch({sessionMeta: {sessionId: 's1', workspaceAgentId: 'reviewer'}});
    var oldToken = captureSessionViewToken();`);
  assert.match(ctx.run('getEmptyStateHtml()'), /审查助手/);
  ctx.run(`applySessionViewPatch({identity: {agentId: 'programming-helper', sessionId: 's2'}})`);
  assert.equal(ctx.run(`commitSessionViewPatch(oldToken, {sessionMeta: {sessionId: 's1', workspaceAgentId: 'main'}})`), false);
  assert.match(ctx.run('getEmptyStateHtml()'), /审查助手/);
});

test('remote welcome resolves a namespaced Session against the remote detail payload', () => {
  const ctx = welcomeSandbox();
  ctx.run(`function splitRemoteNamespaceId(value) { const match = /^remote:([^:]+):(.*)$/.exec(value); return match ? {connectionId: match[1], innerId: match[2]} : null; }
    _agentDetailPayloadCache.set('remote:host:workspace', { agents: [{id: 'reviewer', displayName: '远程审查助手'}], workspace_sessions: {sessions: [{id: 'remote-session', workspaceAgentId: 'reviewer'}]} });
    applySessionViewPatch({identity: {agentId: 'remote:host:workspace', sessionId: 'remote:host:remote-session'}});`);
  assert.match(ctx.run('getEmptyStateHtml()'), /远程审查助手/);
});

test('single Agent and derived sessions need no selection dialog', async () => {
  const ctx = welcomeSandbox();
  const action = { type: 'create_session' };
  assert.equal(await ctx.window.ClawFW.workspaceAgents.selectForNewSession({ agents: [metadata.agents[0]] }, action), action);
  const derived = { type: 'create_session', sessionId: 'source' };
  assert.equal(await ctx.window.ClawFW.workspaceAgents.selectForNewSession(metadata, derived), derived);
});

const root = await mkdtemp(join(tmpdir(), 'claw-workspace-agents-'));
process.env.AGENTDEV_DATA_DIR = root;
after(() => rm(root, { recursive: true, force: true }));
const { createSessionHelpers } = await import('../server/routes/session-helpers.js');
const { readSessionIndex } = await import('../server/shared/session-access.js');
const { buildLightPrebuiltSessionRecord, sessionRecordToWorkspaceMeta, buildChildRuntimeAgent } = await import('../server/routes/session-helpers-pure.js');

test('real session creation persists, restores, derives and projects the binding without changing OS addressing', async () => {
  const api = createSessionHelpers({
    discoverAgents: async () => [metadata],
    enrichAgent: async (agent) => agent,
    readWorkspaceState: async () => ({ forms: {}, openDirectory: '' }),
    writeWorkspaceState: async () => {},
  });
  const create = (options) => api.createPrebuiltSession(metadata.id, { returnSummary: false, ...options });
  const first = await create({ workspaceAgentId: 'reviewer' });
  const second = await create({});
  const derived = await create({ sourceSessionId: first.id });
  assert.equal(first.workspaceAgentId, 'reviewer');
  assert.equal(second.workspaceAgentId, 'main');
  assert.equal(derived.workspaceAgentId, 'reviewer');
  await assert.rejects(create({ workspaceAgentId: 'missing' }), { code: 'invalid_workspace_agent' });
  await assert.rejects(create({ sourceSessionId: first.id, workspaceAgentId: 'main' }));
  const restored = await api.activatePrebuiltSession(metadata.id, first.id, { returnSummary: false });
  assert.equal(restored.workspaceAgentId, 'reviewer');
  const index = await readSessionIndex(metadata.id);
  assert.equal(index.sessions.find((entry) => entry.id === first.id).workspaceAgentId, 'reviewer');
  const light = buildLightPrebuiltSessionRecord(metadata.id, first);
  assert.equal(light.workspaceAgentId, 'reviewer');
  const child = buildChildRuntimeAgent({ id: 'runtime', connected: true }, { agentId: metadata.id, sessionId: first.id, sessionMeta: sessionRecordToWorkspaceMeta(first) });
  assert.equal(child.workspaceAgentId, 'reviewer');
  assert.equal(child.parent_id, metadata.id);
  assert.equal(child.active_workspace_session_id, first.id);

  const { getPrebuiltSessionFilePath, updateSessionIndex } = await import('../server/shared/session-access.js');
  const { exportHistoryOnlyHandoffPackage } = await import('../server/context-continuity/handoff-package.js');
  const { writeSummarizedHandoffPackage } = await import('../server/context-continuity/summarized-handoff.js');
  const snapshotPath = getPrebuiltSessionFilePath(metadata.id, first.id);
  await writeFile(snapshotPath, JSON.stringify({ runtime: { context: { messages: [{ role: 'user', content: 'Hello', turn: 0 }] } } }));
  for (const exportHandoff of [
    () => exportHistoryOnlyHandoffPackage({ userDataRoot: root, agentId: metadata.id, sessionId: first.id, sessionPath: snapshotPath, sourceRecord: first }),
    () => writeSummarizedHandoffPackage({ userDataRoot: root, agentId: metadata.id, sessionId: first.id, sourceRecord: first, summaryText: 'Continue the task.' }),
  ]) {
    const exported = await exportHandoff();
    assert.equal(exported.handoff.sourceRecord.workspaceAgentId, 'reviewer');
    const resumed = await api.createCompactedResumeFromHandoff({ preferredAgentId: metadata.id, handoffPath: exported.handoffPath, startRuntime: false });
    assert.equal(resumed.session.workspaceAgentId, 'reviewer');
  }

  const { setupSessionRoutes } = await import('../server/routes/session.js');
  let branchHandler;
  setupSessionRoutes({ get() {}, put() {}, delete() {}, post(route, ...handlers) { if (route === '/protoclaw/sessions/branch') branchHandler = handlers.at(-1); } },
    { json: () => () => {} }, { ...api, requireAgentLight: async () => metadata, readSessionIndex, updateSessionIndex, startManagedAgent: async () => {}, waitForManagedRuntimeReady: async () => null });
  let branchResult;
  await branchHandler({ body: { agentId: metadata.id, sourceSessionId: first.id, cutMsgIndexEnd: 0 } },
    { json(value) { branchResult = value; }, status() { return this; } }, (error) => { throw error; });
  assert.equal(branchResult.ok, true);
  assert.equal(branchResult.sessionDelta.upsert[0].workspaceAgentId, 'reviewer');
});
