// Real metadata bridge + session commit; delayed ESM and stale-input browser check.
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const main = await fs.readFile('public/src/app-main.js', 'utf8');
const start = main.indexOf('function createMetadataCommitHost()');
const adapter = main.slice(start, main.indexOf('/**', start));
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
<script>
 ${adapter}
 currentRuntimeAgentId = 'rt'; focusedAgentId = 'host';
 applySessionViewPatch({ identity: { agentId: 'host', sessionId: 'a' } });
 window.updateChatContextBar = window.updateInputModelSwitcher = window.updateThinkingEffortSwitcher =
   window.updateRollbackActionVisibility = window._syncPersistentInputUi = () => {};
 window.isChatSurfaceActive = () => false;
 window._partialCompactInFlight = false;
 window.started = false;
</script>
<script src="/src/modules/auth-client.js"></script>
<script type="module" src="/src/modules/metadata-commit-host.js"></script>
<script>(async () => { await __clawAuthReady; window.started = true; })();</script>
</body>`)));
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
  await page.route('**/src/modules/metadata-commit-host.js', async route => { await gate; await route.continue(); });
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`, { waitUntil: 'commit' });
  await page.waitForFunction(() => document.readyState === 'interactive' && window.started === false);
  release();
  await page.waitForFunction(() => window.started === true);
  const result = await page.evaluate(() => {
    const older = captureSessionViewToken();
    commitMetadataUpdate(captureSessionViewToken(), { inputRequestsRaw: [{ requestId: 'live' }] });
    commitMetadataUpdate(older, { inputRequestsRaw: [], overviewJson: { modelName: 'current' } });
    const live = currentInputRequests.map(request => request.requestId);
    const model = currentOverviewSnapshot.modelName;
    const departed = captureSessionViewToken();
    _switchEpoch++;
    const accepted = commitMetadataUpdate(departed, { overviewJson: { modelName: 'stale' } });
    return { live, model, accepted, finalModel: currentOverviewSnapshot.modelName };
  });
  assert.deepEqual(result, { live: ['live'], model: 'current', accepted: false, finalModel: 'current' });
  assert.deepEqual(errors, []);
  console.log('PASS: real metadata host preserves newer input in mixed commits and rejects departed views');
} finally {
  release();
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
