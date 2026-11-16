// Real browser module/classic ordering, with a static fixture and no user data.
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
<script src="/src/modules/auth-client.js"></script>
<script type="module" src="/src/modules/agent-loader-host.js"></script>
<script>
  currentRuntimeAgentId = 'runtime-browser';
  allAgents = [{ id: 'host-browser' }];
  applySessionViewPatch({ identity: { agentId: 'host-browser', sessionId: 'picked' } });
  FEATURE_TEMPLATE_MAP = { early: '/before.js' };
  window.started = false;
  (async () => {
    await window.__clawAuthReady;
    window.started = true;
    await loadFeatureTemplateMap();
    await loadAgentDetail('host-browser');
    window.finished = true;
  })();
</script></body>`)));
app.get('/protoclaw/auth/status', (_req, res) => res.json({ enabled: false, authenticated: true }));
app.get('/api/templates/feature', (_req, res) => res.json({ browser: '/after.js' }));
app.get('/protoclaw/agent_detail', (_req, res) => res.json({ workspace_sessions: {
  sessions: [{ id: 'picked', openDirectory: '/browser-selected' }],
} }));
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
  await page.route('**/src/modules/agent-loader-host.js', async (route) => { await gate; await route.continue(); });
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`, { waitUntil: 'commit' });
  try {
    await page.waitForFunction(() => window.started === false && window.FEATURE_TEMPLATE_MAP?.early, null, { timeout: 5000 });
  } catch (error) {
    console.error({ errors, state: await page.evaluate(() => ({ ready: document.readyState, started: window.started, map: window.FEATURE_TEMPLATE_MAP })) });
    throw error;
  }
  assert.equal(await page.evaluate(() => document.readyState), 'interactive');
  assert.equal(await page.evaluate(() => window.started), false, 'auth boot must not run before the static module');
  await page.evaluate(() => { FEATURE_TEMPLATE_MAP = { latest: '/latest-early.js' }; });
  release();
  await page.waitForFunction(() => window.finished === true);
  const state = await page.evaluate(() => ({
    templates: FEATURE_TEMPLATE_MAP,
    directory: readCurrentSessionViewState().sessionMeta.openDirectory,
    loaded: loadedAgentDetailIds.has('host-browser'),
  }));
  assert.deepEqual(state, { templates: { browser: '/after.js' }, directory: '/browser-selected', loaded: true });
  assert.deepEqual(errors, []);
  console.log('PASS: delayed loader initialization preserves auth ordering and selected-session detail commits');
} finally {
  release();
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
