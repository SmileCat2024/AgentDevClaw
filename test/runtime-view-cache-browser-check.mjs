// Static fixture: real classic/ESM ordering, no Claw service or user data.
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
<script src="/src/modules/runtime-status.js"></script>
<script src="/src/modules/sidebar-render.js"></script>
<script src="/src/modules/auth-client.js"></script>
<script type="module" src="/src/modules/runtime-view-cache-host.js"></script>
<script>
  window.started = false;
  (async () => {
    await window.__clawAuthReady;
    window.started = true;
    currentRuntimeAgentId = 'runtime'; focusedAgentId = 'host';
    applySessionViewPatch({ identity: { agentId: 'host', sessionId: 'a' } });
    applySessionViewPatch({ messages: [{ role: 'assistant', content: 'cached A' }], inputRequests: [{ requestId: 'a' }] });
    followLatestEnabled = false;
    saveCurrentRuntimeToCache('runtime', 'host:host|session:a');
    applySessionViewPatch({ identity: { agentId: 'host', sessionId: 'b' } });
    followLatestEnabled = true;
    window.restoreResult = restoreRuntimeFromCache('runtime', 'host:host|session:a');
    window.finished = true;
  })();
</script></body>`)));
app.get('/protoclaw/auth/status', (_req, res) => res.json({ enabled: false, authenticated: true }));
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
  await page.route('**/src/modules/runtime-view-cache-host.js', async (route) => { await gate; await route.continue(); });
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.started === false && document.readyState === 'interactive');
  assert.equal(await page.evaluate(() => window.started), false);
  release();
  try {
    await page.waitForFunction(() => window.finished === true, null, { timeout: 5000 });
  } catch (error) {
    console.error({ errors, state: await page.evaluate(() => ({ started: window.started, ready: document.readyState,
      restore: typeof window.restoreRuntimeFromCache })) });
    throw error;
  }
  assert.deepEqual(await page.evaluate(() => ({
    restored: window.restoreResult,
    identity: readCurrentSessionViewState().identity,
    content: currentMessages[0]?.content,
    request: currentInputRequests[0]?.requestId,
    follow: followLatestEnabled,
  })), { restored: true, identity: { agentId: 'host', sessionId: 'a' }, content: 'cached A', request: 'a', follow: false });
  await page.evaluate(() => clearAgentRuntimeCache('runtime'));
  assert.equal(await page.evaluate(() => restoreRuntimeFromCache('runtime', 'host:host|session:a')), false);
  assert.deepEqual(errors, []);
  console.log('PASS: delayed ESM cache preserves auth ordering, synchronous identity/content restore and invalidation');
} finally {
  release();
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
