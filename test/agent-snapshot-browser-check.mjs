// Real snapshot host with delayed ESM; static fixture, no user data or runtimes.
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const app = express();
app.use(express.static('public'));
const index = await fs.readFile('public/index.html', 'utf8');
const body = index.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
app.get('/fixture', (_req, res) => res.type('html').send(body.replace('</body>', `
<script src="/src/modules/kernel-state.js"></script>
<script src="/src/app-core.js"></script>
<script src="/src/modules/action-dispatcher.js"></script>
<script src="/src/modules/overview-data.js"></script>
<script src="/src/modules/todo-plan.js"></script>
<script src="/src/modules/session-view-state.js"></script>
<script src="/src/modules/agent-data-loader.js"></script>
<script>window.updateNotificationStatus = () => {}; window.getCurrentRuntimeRecord = () => allAgents[0]; window.getCurrentAgentRecord = () => allAgents[0];</script>
<script src="/src/modules/runtime-status.js"></script>
<script src="/src/modules/sidebar-render.js"></script>
<script>
 window.started = false;
 window.connectedReads = 0;
 window.authoritative = [{ id: 'host', source: 'prebuilt', name: 'Workspace identity', runtime_session_id: 'rt' }];
 window.invoke = async () => { connectedReads++; return authoritative; };
 window.isRemoteNamespaceAgentId = () => false;
 window.isSseActive = () => true;
 window.renderAgentList = () => { document.getElementById('agent-list').textContent = allAgents.map(a => a.source + ':' + a.name).join(','); };
 window.renderFeaturePanel = () => {};
 focusedAgentId = 'host';
</script>
<script src="/src/modules/auth-client.js"></script>
<script type="module" src="/src/modules/kernel-entry.js"></script>
<script>
 (async () => { await __clawAuthReady; window.started = true; await loadAgents(); window.finished = true; })();
</script></body>`)));
app.get('/protoclaw/auth/status', (_req, res) => res.json({ enabled: false, authenticated: true }));
app.get('/api/agents/rt/notification', (_req, res) => res.json({ state: 'idle' }));
app.get('/api/agents/rt/connection', (_req, res) => res.json({ connected: false }));
app.get('/api/agents', (_req, res) => res.json({ agents: [{ id: 'rt', name: 'Viewer identity', connected: true, messageCount: 7 }] }));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
let browser;
let release;
const gate = new Promise((resolve) => { release = resolve; });
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? undefined : 'msedge',
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/src/modules/agent-snapshot-loader-host.js', async (route) => { await gate; await route.continue(); });
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`, { waitUntil: 'commit' });
  await page.waitForFunction(() => document.readyState === 'interactive' && window.started === false);
  assert.equal(await page.evaluate(() => connectedReads), 0);
  release();
  await page.waitForFunction(() => window.finished === true);
  assert.equal(await page.locator('#agent-list').textContent(), 'prebuilt:Workspace identity');
  assert.equal(await page.evaluate(() => allAgents[0].message_count), 7);
  await page.evaluate(async () => { authoritative = []; await loadAgents(); });
  assert.equal(await page.locator('#agent-list').textContent(), 'prebuilt:Workspace identity');
  assert.equal(await page.evaluate(() => loadAgentsInFlight), null);
  const status = await page.evaluate(async () => {
    currentRuntimeAgentId = 'rt';
    await refreshCurrentRuntimeStatus('rt');
    return { connected: currentRuntimeConnected, recordConnected: allAgents[0].connected };
  });
  assert.deepEqual(status, { connected: false, recordConnected: false });
  assert.deepEqual(errors, []);
  console.log('PASS: delayed snapshot module respects auth boot; authoritative identity survives Viewer merge and an empty read');
} finally {
  release();
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
