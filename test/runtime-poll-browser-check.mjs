// Real runtime poll host and transitive ESM imports; controlled HTTP endpoints.
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const ui = await fs.readFile('public/src/app-ui.js', 'utf8');
const surfaceHost = ui.slice(ui.indexOf('function createWorkspaceSurfaceHost()'), ui.indexOf('function upsertConnectedAgent('));
const main = await fs.readFile('public/src/app-main.js', 'utf8');
const startupHost = main.slice(main.indexOf('function createApplicationStartupHost()'), main.lastIndexOf('(async () => {'));
const compactHost = main.slice(main.indexOf('function createCompactResumeHost()'), main.indexOf('// PH session list helpers'));
const entryHost = main.slice(main.indexOf('function createWorkspaceEntryHost()'), main.indexOf('function applyOptimisticWorkspaceSession'));
const navigationHost = main.slice(main.indexOf('function createWorkspaceSessionNavigationHost()'), main.indexOf('// ── Docset & material actions'));
const switchHost = main.slice(main.indexOf('function createRuntimeSwitchHost()'), main.indexOf('// ── Context menu action handlers'));
const pollSource = main.slice(main.indexOf('// ── Runtime poll coordinator'), main.indexOf('// ── Input request rendering'));
const index = await fs.readFile('public/index.html', 'utf8');
const body = index.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const app = express();
app.use('/vendor/marked', express.static('node_modules/marked'));
app.use(express.static('public'));
app.get('/fixture', (_req, res) => res.type('html').send(body.replace('</body>', `
<script src="/src/modules/kernel-state.js"></script>
<script src="/vendor/marked/lib/marked.umd.js"></script>
<script src="/src/modules/markdown-bootstrap.js"></script>
<script src="/src/app-core.js"></script>
<script src="/src/modules/action-dispatcher.js"></script>
<script src="/src/modules/overview-data.js"></script>
<script src="/src/modules/todo-plan.js"></script>
<script src="/src/modules/session-view-state.js"></script>
<script src="/src/modules/auto-title.js"></script>
<script src="/src/modules/agent-data-loader.js"></script>
<script src="/src/modules/runtime-status.js"></script>
<script src="/src/modules/sidebar-render.js"></script>
<script>
  ${startupHost}
  ${surfaceHost}
  ${compactHost}
  ${entryHost}
  ${navigationHost}
  ${switchHost}
  ${pollSource}
 currentRuntimeAgentId = 'rt'; focusedAgentId = 'host'; allAgents = [];
 applySessionViewPatch({ identity: { agentId: 'host', sessionId: 'a' } });
 window.isSseActive = () => true;
 window.getCurrentRuntimeRecord = window.getCurrentAgentRecord = () => null;
 window.updateChatContextBar = window.updateInputModelSwitcher = window.updateThinkingEffortSwitcher =
   window.updateRollbackActionVisibility = window._syncPersistentInputUi = window._syncPersistentActionButton =
   window.updateNotificationStatus = window.clearChatLoadingSession = () => {};
 window.attachMessagesTimestamps = messages => messages;
 window.shouldRenderWorkspaceSurface = window.isChatSurfaceActive = () => false;
 window.renderCurrentMainView = () => { document.getElementById('chat-container').textContent = currentMessages.map(m => m.content).join(','); };
 window.appendNewMessages = window.updateLastMessage = window.renderCurrentMainView;
 window._partialCompactInFlight = false;
 lastAgentListRefreshAt = Date.now();
 window._lastWsSessionRefreshAt = Date.now();
 window._trackRecapSessionPresence = () => {};
 FEATURE_TEMPLATE_MAP = { loaded: true };
  window.__startupStages = [];
  window.waitForViewerReady = async () => { window.__startupStages.push('viewer'); return true; };
  window.loadMcpInfo = async force => window.__startupStages.push(['mcp', force]);
  window.ClawDesktopOpen = { consumeBootOpenRequest: async () => window.__startupStages.push('desktop') };
  window.started = false;
</script>
<script src="/src/modules/auth-client.js"></script>
<script type="module" src="/src/modules/kernel-entry.js"></script>
<script>(async () => { await __clawAuthReady; window.started = true; await runPollCycle(); window.lightDone = true; })();</script>
</body>`)));
app.get('/protoclaw/auth/status', (_req, res) => res.json({ enabled: false, authenticated: true }));
app.get('/protoclaw/agent_detail', (_req, res) => res.json({ workspace_sessions: { sessions: [] } }));
app.post('/protoclaw/context_handoffs/compact_and_resume', express.json(), (req, res) => res.json({ sessionId: 'compacted', request: req.body }));
app.post('/protoclaw/prebuilt_sessions/activate', (_req, res) => res.status(409).json({
  code: 'thread_handoff_in_progress', threadId: 'handoff-thread', headSessionId: 'handoff-session',
}));
const requests = [];
app.get('/api/agents/rt/:endpoint', (req, res) => {
  requests.push(req.params.endpoint);
  res.json({ notification: { state: 'idle' }, connection: { connected: true },
    overview: { modelName: 'new-model', messagesProbe: { seq: 1, count: 1, changeKind: 'rewrite' } },
    messages: { messages: [{ role: 'assistant', content: 'live body' }] },
    todo: { tasks: [] }, 'input-requests': [{ requestId: 'live' }],
  }[req.params.endpoint]);
});
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
let browser;
let release;
const gate = new Promise(resolve => { release = resolve; });
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? undefined : 'msedge',
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/src/modules/runtime-poll-host.js', async route => { await gate; await route.continue(); });
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`, { waitUntil: 'commit' });
  await page.waitForFunction(() => document.readyState === 'interactive' && window.started === false);
  release();
  try {
    await page.waitForFunction(() => window.lightDone === true, null, { timeout: 5000 });
  } catch (error) {
    console.error({ errors, state: await page.evaluate(() => ({ started: window.started, ready: document.readyState })) });
    throw error;
  }
  assert.deepEqual(requests, [], 'healthy SSE does not poll message or metadata endpoints');
  await page.evaluate(async () => { _forceFullPollNextCycle = true; await runPollCycle(); });
  assert.equal(await page.locator('#chat-container').textContent(), 'live body');
  assert.deepEqual(await page.evaluate(() => ({ input: currentInputRequests.map(r => r.requestId), model: currentOverviewSnapshot.modelName })),
    { input: ['live'], model: 'new-model' });
  assert.deepEqual(requests.slice().sort(), ['connection', 'input-requests', 'messages', 'notification', 'overview', 'todo']);
  await page.evaluate(async () => { await runPollCycle(); schedulePoll(60000); });
  assert.equal(requests.length, 6, 'one-shot full flag is consumed, next cycle is light again');
  const preserved = await page.evaluate(async () => {
    window.getRuntimeWorkspaceSessionId = () => 'a';
    window.getCurrentHostAgentRecord = () => ({ id: 'host' });
    window.getThreadForSession = () => ({ threadId: 'thread', status: 'rotating', headSessionId: 'a' });
    await handleCoreResponsesNotFound(captureSessionViewToken());
    const runtime = currentRuntimeAgentId;
    window.getThreadForSession = () => ({ threadId: 'thread', status: 'open', headSessionId: 'b' });
    window.refreshThreads = async () => {};
    window.ClawThreads = { activeConversation: { threadId: 'thread', sessionId: 'a', wasHead: true } };
    await handleCoreResponsesNotFound(captureSessionViewToken());
    schedulePoll(60000);
    return { runtime, reboundRuntime: currentRuntimeAgentId, body: currentMessages[0].content };
  });
  assert.deepEqual(preserved, { runtime: 'rt', reboundRuntime: 'rt', body: 'live body' });
  const navigation = await page.evaluate(async () => {
    const selected = [];
    window.findAgentByIdentity = () => ({ id: 'coder', source: 'prebuilt' });
    window.isWorkspaceHostUnit = window.isWorkspaceSurfaceUnit = () => true;
    window.closeAgentContextMenu = () => {};
    window.selectWorkspaceSurface = (id, options) => selected.push({ id, ...options });
    window.hasPendingSessionNavigation = () => false;
    await switchAgent('coder', { awaitSessionId: 'next' });
    const pending = requestSwitch('stale', 'restart');
    bumpNavigationGuard();
    return { selected, pending: await pending };
  });
  assert.deepEqual(navigation, { selected: [{ id: 'coder', awaitSession: 'next' }],
    pending: { switched: false, reason: 'nav-guard-stale' } });
  const crossWorkspace = await page.evaluate(async () => {
    const actions = [];
    window.runWorkspaceAction = async action => actions.push(JSON.parse(action));
    await navigateToWorkspaceSession('host', 'archive', { actionOverride: { type: 'view_session_record', sessionId: 'archive' } });
    return actions;
  });
  assert.deepEqual(crossWorkspace, [{ type: 'view_session_record', sessionId: 'archive' }]);
  const navigated = await page.evaluate(async () => {
    const actions = [];
    allAgents = [{ id: 'next', source: 'prebuilt' }];
    window.runWorkspaceAction = async raw => actions.push({ action: JSON.parse(raw), focus: focusedAgentId,
      runtime: currentRuntimeAgentId, body: container.textContent });
    window.resetRuntimeBackedSurfaceState = window.renderAgentList = () => {};
    currentRuntimeAgentId = null;
    await navigateToWorkspaceSession('next', 'selected-session');
    return actions;
  });
  assert.equal(navigated.length, 1);
  assert.deepEqual(navigated[0].action, { type: 'open_session', sessionId: 'selected-session' });
  assert.equal(navigated[0].focus, 'next');
  assert.equal(navigated[0].runtime, null);
  assert.match(navigated[0].body, /加载中|Loading/);
  const entry = await page.evaluate(async () => {
    const surfaces = [];
    window.selectWorkspaceSurface = (id, options) => surfaces.push({ id, ...options });
    await handlePrebuiltAgentClick('next');
    const handoff = await openPrebuiltWorkspaceSession('next', { type: 'open_session', sessionId: 'old' })
      .then(() => null, error => error.handoff);
    return { surfaces, remembered: localStorage.getItem('claw:lastFocusedEntryId'), handoff };
  });
  assert.deepEqual(entry, { surfaces: [{ id: 'next', skipFeaturePanel: true }], remembered: 'next',
    handoff: { threadId: 'handoff-thread', sessionId: 'handoff-session' } });
  const compacted = await page.evaluate(async () => {
    window.createSidebarOperationId = () => 'compact-op';
    window.sidebarDiagnosticNow = () => performance.now();
    window.beginSidebarOperationMainThreadObservation = () => () => {};
    window.recordSidebarOperationCheckpoint = () => {};
    window.newIdempotencyKey = () => 'compact-key';
    window.isRemoteNamespaceAgentId = () => false;
    return createCompactedResumeSession('next', 'source', 'trim', 2, null, null, { reason: 'trim', archiveOriginal: true });
  });
  assert.equal(compacted.sessionId, 'compacted');
  assert.equal(compacted.request.agentId, 'next');
  assert.equal(compacted.request.archiveOriginal, true);
  assert.deepEqual(compacted.request.policy, { strategy: 'trim', keepRecentTurns: 2 });
  const waiting = await page.evaluate(async () => {
    const { selectWorkspaceSurface } = await import('/src/modules/workspace-surface-host.js');
    window.getUnitPreferenceKey = agent => agent?.id;
    window.getUnitTabs = () => [{ id: 'home' }, { id: 'chat' }];
    window.getDefaultUnitMode = () => 'home';
    window.refreshVisibleWorkspacePanelData = () => {};
    window.saveCurrentWorkspaceSurfaceScroll = () => {};
    window.setFollowLatest = () => {};
    window.beginChatLoadingSession = () => {};
    window.renderFeaturePanel = () => {};
    window._recentlyFinishedRuntimes = new Set();
    selectWorkspaceSurface('next', { awaitSession: 'waiting', skipFeaturePanel: true });
    return { focus: focusedAgentId, runtime: currentRuntimeAgentId, tab: currentWorkspaceTab,
      pending: _pendingSessionNavigation.sessionId, identity: getCurrentSessionViewIdentity() };
  });
  assert.deepEqual(waiting, { focus: 'next', runtime: null, tab: 'chat', pending: 'waiting',
    identity: { agentId: 'next', sessionId: '' } });
  const loadingLifecycle = await page.evaluate(async () => {
    const loading = await import('/src/modules/chat-loading-host.js');
    loading.beginChatLoadingSession();
    const before = { loading: _chatLoadingSession, timer: _chatLoadingTimeout !== null };
    loading.clearChatLoadingSession();
    return { before, after: { loading: _chatLoadingSession, timer: _chatLoadingTimeout } };
  });
  assert.deepEqual(loadingLifecycle, { before: { loading: true, timer: true }, after: { loading: false, timer: null } });
  assert.deepEqual(errors, []);
  console.log('PASS: production kernel preserves handoff views, workspace navigation, session requests and deferred switch guards');
} finally {
  release();
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
