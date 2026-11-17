// Real runtime poll host and transitive ESM imports; controlled HTTP endpoints.
//
// Fixture contract (P2 ESM migration):
// - The classic host factories below are sliced out of app-ui / app-main because
//   the production boot IIFE must not run. The real ESM module graph is loaded via
//   kernel-entry.js, exactly as index.html loads it.
// - "Healthy SSE" is driven by a real EventSource: the fixture server publishes
//   hello + the queued-inputs snapshot the runtime would publish, and the page
//   waits for both public signals (isSseActive + ClawFW.SseClient snapshot cache)
//   before its first poll. Do not fake isSseActive with a window stub: the key is
//   an ESM-owned bridge now and a classic-phase assignment is silently dropped.
// - Classic seams are only for classic modules the fixture does not load
//   (persistent-input / input-render / chat-context-bar / app-ui render entry).
//   ESM capabilities (queue sync, loading timer, metadata commit, call states,
//   timeline timestamps, rollback state) are the real implementations.
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
<script type="module" src="/src/modules/overview-data.js"></script>
<script src="/src/modules/todo-plan.js"></script>
<script src="/src/modules/session-view-state.js"></script>
<script type="module" src="/src/modules/auto-title.js"></script>
<script src="/src/modules/runtime-status.js"></script>
<script src="/src/modules/sidebar-render.js"></script>
<script src="/src/modules/rollback-dialog.js"></script>
<script>
  ${startupHost}
  ${surfaceHost}
  ${compactHost}
  ${entryHost}
  ${navigationHost}
  ${switchHost}
  ${pollSource}
 currentRuntimeAgentId = 'rt'; focusedAgentId = 'host'; allAgents = [];
 // R2 边界：显式 identity patch 在身份变化时会调用 overview-data（ESM）的
 // setCurrentHookInspector / setCurrentOverviewSnapshot 桥键，这两个键在 overview-data
 // 求值前不存在；首屏身份因此改走 sessionMeta 推导（同一条生产数据加载路径）。
 // 生产 classic 相是否存在早于模块的身份 patch，由主助手审计收口。
 applySessionViewPatch({ sessionMeta: { sessionId: 'a' } });
 // Classic seams (classic modules not loaded by this fixture):
 // - getCurrentRuntimeRecord / getCurrentAgentRecord: app-main top-level (outside the slices)
 // - updateChatContextBar: chat-context-bar.js
 // - updateNotificationStatus: runtime-status.js implementation is classic, but the
 //   fixture only asserts committed view state, so its DOM side effects stay off.
 // - _syncPersistentActionButton / rebindQueueProjectionForRuntime /
 //   _interactiveSurfaceOccupiesInput: persistent-input.js (classic first-paint owner)
 // - notifyInputSurfaceChanged: input-render.js
 // - shouldRenderWorkspaceSurface / isChatSurfaceActive / renderCurrentMainView /
 //   appendNewMessages / updateLastMessage: app-ui.js / chat-renderer.js render entries.
 //   renderCurrentMainView is the observation channel for committed messages below.
 window.getCurrentRuntimeRecord = window.getCurrentAgentRecord = () => null;
 window.updateChatContextBar = window.updateNotificationStatus = () => {};
 window._syncPersistentActionButton = () => {};
 window.rebindQueueProjectionForRuntime = () => {};
 window._interactiveSurfaceOccupiesInput = () => false;
 window.notifyInputSurfaceChanged = () => {};
 window.shouldRenderWorkspaceSurface = window.isChatSurfaceActive = () => false;
 window.renderCurrentMainView = () => { document.getElementById('chat-container').textContent = currentMessages.map(m => m.content).join(','); };
 window.appendNewMessages = window.updateLastMessage = window.renderCurrentMainView;
 // Bridge-owned classic-phase state: app-core registers the accessors, the ESM
 // owners absorb the values when the module graph evaluates. Keep writing before
 // the modules run, exactly as the classic phase of the real boot does.
 lastAgentListRefreshAt = Date.now();
 FEATURE_TEMPLATE_MAP = { loaded: true };
 // Classic poll-maintenance host still reads this shared window slot.
 window._lastWsSessionRefreshAt = Date.now();
 window.started = false;
</script>
<script src="/src/modules/auth-client.js"></script>
<script type="module" src="/src/modules/kernel-entry.js"></script>
<script>(async () => {
  await __clawAuthReady;
  window.started = true;
  // Real SSE: hello activates the event channel, queued-inputs primes the queue
  // snapshot cache. Both are public runtime state (SseClient namespace), so the
  // first cycle runs in the same shape as a live page with an event-fed queue.
  const sseReady = () => typeof window.isSseActive === 'function' && window.isSseActive()
    && !!window.ClawFW?.SseClient?.getLastQueuedSnapshot?.('rt');
  for (let i = 0; i < 250 && !sseReady(); i += 1) await new Promise(resolve => setTimeout(resolve, 20));
  window.sseReady = sseReady();
  await runPollCycle();
  window.lightDone = true;
})();</script>
</body>`)));
app.get('/protoclaw/auth/status', (_req, res) => res.json({ enabled: false, authenticated: true }));
app.get('/protoclaw/app_info', (_req, res) => res.json({ ok: true, version: 'fixture', repositories: [] }));
app.get('/api/feature-ui/declarations', (_req, res) => res.json({ ok: true, declarations: [] }));
app.get('/protoclaw/agent_detail', (_req, res) => res.json({ workspace_sessions: { sessions: [] } }));
app.post('/protoclaw/context_handoffs/compact_and_resume', express.json(), (req, res) => res.json({ sessionId: 'compacted', request: req.body }));
app.post('/protoclaw/prebuilt_sessions/activate', (_req, res) => res.status(409).json({
  code: 'thread_handoff_in_progress', threadId: 'handoff-thread', headSessionId: 'handoff-session',
}));
// Long-lived SSE stream: hello flips isSseActive, queued-inputs fills the snapshot
// cache so the first poll does not fall back to a queue HTTP fetch.
app.get('/protoclaw/events', (_req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('event: hello\ndata: {"choiceAlerts":[]}\n\n');
  res.write('event: queued-inputs\ndata: {"agentId":"rt","data":[]}\n\n');
});
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
  // No filtering: page errors and console errors are asserted below. Every
  // /api or /protoclaw path is recorded so unknown endpoints fail the test
  // instead of silently resolving through the fixture server's 404.
  const consoleErrors = [];
  const httpPaths = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const location = message.location();
    consoleErrors.push({ text: message.text(), url: location?.url || '' });
  });
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (/^\/(api|protoclaw)\//.test(pathname)) httpPaths.push(pathname);
  });
  await page.route('**/src/modules/runtime-poll-host.js', async route => { await gate; await route.continue(); });
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`, { waitUntil: 'commit' });
  try {
    await page.waitForFunction(() => document.readyState === 'interactive' && window.started === false, null, { timeout: 5000 });
  } catch (error) {
    console.error({ errors, state: await page.evaluate(() => ({ ready: document.readyState, started: window.started })) });
    throw error;
  }
  release();
  try {
    await page.waitForFunction(() => window.lightDone === true, null, { timeout: 5000 });
  } catch (error) {
    console.error({ errors, consoleErrors, state: await page.evaluate(() => ({
      started: window.started, ready: document.readyState, sseReady: window.sseReady,
      sseActive: window.isSseActive?.(), queuedSnapshot: !!window.ClawFW?.SseClient?.getLastQueuedSnapshot?.('rt'),
    })) });
    throw error;
  }
  assert.equal(await page.evaluate(() => window.sseReady), true,
    'fixture SSE stream is healthy and has published a queued-inputs snapshot before the first poll');
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
    selectWorkspaceSurface('next', { awaitSession: 'waiting', skipFeaturePanel: true });
    return { focus: focusedAgentId, runtime: currentRuntimeAgentId, tab: currentWorkspaceTab,
      pending: _pendingSessionNavigation.sessionId, identity: getCurrentSessionViewIdentity() };
  });
  assert.deepEqual(waiting, { focus: 'next', runtime: null, tab: 'chat', pending: 'waiting',
    identity: { agentId: 'next', sessionId: '' } });
  const loadingLifecycle = await page.evaluate(async () => {
    const loading = await import('/src/modules/chat-loading-host.js');
    // 计时槽无桥：经 ESM owner（orchestration-state）的实时绑定读状态。
    const state = await import('/src/modules/orchestration-state.js');
    loading.beginChatLoadingSession();
    const before = { loading: state._chatLoadingSession, timer: state._chatLoadingTimeout !== null };
    loading.clearChatLoadingSession();
    return { before, after: { loading: state._chatLoadingSession, timer: state._chatLoadingTimeout } };
  });
  assert.deepEqual(loadingLifecycle, { before: { loading: true, timer: true }, after: { loading: false, timer: null } });
  assert.deepEqual(errors, []);
  // The handoff path intentionally answers 409 (thread_handoff_in_progress);
  // Chromium logs that one network failure as a console error. Assert it is the
  // only console error instead of filtering console errors away.
  assert.deepEqual(consoleErrors.map(entry => (entry.url ? new URL(entry.url).pathname : 'unknown')),
    ['/protoclaw/prebuilt_sessions/activate'], 'no unexpected console errors');
  assert.deepEqual([...new Set(httpPaths)].sort(), [
    '/api/agents/rt/connection',
    '/api/agents/rt/input-requests',
    '/api/agents/rt/messages',
    '/api/agents/rt/notification',
    '/api/agents/rt/overview',
    '/api/agents/rt/todo',
    '/api/feature-ui/declarations',
    '/protoclaw/agent_detail',
    '/protoclaw/app_info',
    '/protoclaw/auth/status',
    '/protoclaw/context_handoffs/compact_and_resume',
    '/protoclaw/events',
    '/protoclaw/prebuilt_sessions/activate',
  ], 'no unknown HTTP endpoints');
  console.log('PASS: production kernel preserves handoff views, workspace navigation, session requests and deferred switch guards');
} finally {
  release();
  try {
    if (browser) await browser.close();
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
