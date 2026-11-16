// Static browser fixture: real classic adapter, ESM bridge and auth ordering.
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const main = await fs.readFile('public/src/app-main.js', 'utf8');
const adapter = main.slice(main.indexOf('function createPollCoordinatorHost()'), main.indexOf('// Message sequence baselines'));
const app = express();
app.use(express.static('public'));
app.get('/fixture', (_req, res) => res.type('html').send(`<!doctype html><html><body>
<script src="/src/modules/kernel-state.js"></script>
<script>
 const POLL_FAST_INTERVAL_MS = 1000;
 window.calls = 0; window.started = false;
 window.barrier = new Promise(resolve => { window.releaseCycle = resolve; });
 async function runPollCycle() { window.calls++; if (window.calls === 1) await window.barrier; }
 ${adapter}
</script>
<script src="/src/modules/action-dispatcher.js"></script>
<script src="/src/modules/auth-client.js"></script>
<script type="module" src="/src/modules/poll-coordinator-host.js"></script>
<script>(async () => { await window.__clawAuthReady; window.started = true; await poll(); window.finished = true; })();</script>
</body></html>`));
app.get('/protoclaw/auth/status', (_req, res) => res.json({ enabled: false, authenticated: true }));
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
  await page.route('**/src/modules/poll-coordinator-host.js', async route => { await gate; await route.continue(); });
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`, { waitUntil: 'commit' });
  await page.waitForFunction(() => document.readyState === 'interactive' && window.started === false);
  assert.equal(await page.evaluate(() => window.calls), 0, 'auth boot must not run before ESM scheduling is ready');
  release();
  await page.waitForFunction(() => window.started && window.calls === 1);
  await page.evaluate(() => {
    window.pending = Promise.all([poll(), poll(), poll()]);
    schedulePoll(60000);
  });
  assert.equal(await page.evaluate(() => window.calls), 1, 'refresh requests cannot overlap the active cycle');
  await page.evaluate(async () => { window.releaseCycle(); await window.pending; });
  await page.waitForFunction(() => window.calls === 2 && window.finished);
  assert.equal(await page.evaluate(() => window.calls), 2, 'coalesced requests produce one immediate follow-up');
  assert.deepEqual(errors, []);
  console.log('PASS: auth waits for delayed coordinator; repeated refreshes coalesce and replace the pending timer');
} finally {
  release();
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
