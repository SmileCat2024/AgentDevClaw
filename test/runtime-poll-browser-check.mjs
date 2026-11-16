// Real runtime poll host and transitive ESM imports; controlled HTTP endpoints.
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const main = await fs.readFile('public/src/app-main.js', 'utf8');
const pollSource = main.slice(main.indexOf('// ── Runtime poll coordinator'), main.indexOf('// ── Input request rendering'));
const index = await fs.readFile('public/index.html', 'utf8');
const body = index.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const app = express();
app.use(express.static('public'));
app.get('/fixture', (_req, res) => res.type('html').send(body.replace('</body>', `
<script src="/src/modules/kernel-state.js"></script>
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
 window._runPollTailLowFrequency = async () => true;
 window.started = false;
</script>
<script src="/src/modules/auth-client.js"></script>
<script type="module" src="/src/modules/runtime-poll-host.js"></script>
<script>(async () => { await __clawAuthReady; window.started = true; await runRuntimePoll(); window.lightDone = true; })();</script>
</body>`)));
app.get('/protoclaw/auth/status', (_req, res) => res.json({ enabled: false, authenticated: true }));
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
  await page.evaluate(async () => { _forceFullPollNextCycle = true; await runRuntimePoll(); });
  assert.equal(await page.locator('#chat-container').textContent(), 'live body');
  assert.deepEqual(await page.evaluate(() => ({ input: currentInputRequests.map(r => r.requestId), model: currentOverviewSnapshot.modelName })),
    { input: ['live'], model: 'new-model' });
  assert.deepEqual(requests.slice().sort(), ['connection', 'input-requests', 'messages', 'notification', 'overview', 'todo']);
  await page.evaluate(async () => { await runRuntimePoll(); schedulePoll(60000); });
  assert.equal(requests.length, 6, 'one-shot full flag is consumed, next cycle is light again');
  assert.deepEqual(errors, []);
  console.log('PASS: real ESM poll host keeps SSE light, performs one full reconciliation and publishes consistent view data');
} finally {
  release();
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
