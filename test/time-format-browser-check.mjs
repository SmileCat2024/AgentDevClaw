// Real classic/ESM ordering and session-row consumer; no service or user data.
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const app = express();
app.use(express.static('public'));
app.get('/marked-fixture.js', (_req, res) => res.sendFile('node_modules/marked/lib/marked.umd.js', { root: process.cwd() }));
const index = await fs.readFile('public/index.html', 'utf8');
const body = index.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
app.get('/fixture', (_req, res) => res.type('html').send(body.replace('</body>', `
<script src="/src/modules/kernel-state.js"></script>
<script src="/src/app-core.js"></script>
<script src="/src/modules/action-dispatcher.js"></script>
<script src="/marked-fixture.js"></script>
<script src="/src/modules/markdown-bootstrap.js"></script>
<script src="/src/modules/session-list-render.js"></script>
<script src="/src/modules/auth-client.js"></script>
<script type="module" src="/src/modules/time-format-host.js"></script>
<script>
  window.started = false;
  window.t = (key) => key;
  window.renderSessionResumeBadge = window.renderSessionTodoBadge =
    window.renderSessionTitleAiButton = window.renderSessionTokenBar = () => '';
  window.drawRow = () => {
    document.getElementById('chat-container').innerHTML = renderPhSessionItemHtml(
      { id: 'host' }, { id: 'session', title: '<unsafe>', updatedAt: new Date().toISOString(), messageCount: 2 });
  };
  (async () => {
    await window.__clawAuthReady;
    window.started = true;
    drawRow();
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
  await page.route('**/src/modules/time-format-host.js', async (route) => { await gate; await route.continue(); });
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`, { waitUntil: 'commit' });
  await page.waitForFunction(() => document.readyState === 'interactive' && window.started === false);
  await page.evaluate(() => { currentLanguage = 'zh'; });
  release();
  await page.waitForFunction(() => window.started === true);
  assert.equal(await page.locator('.session-time-label').textContent(), '刚刚');
  assert.equal(await page.locator('.workspace-history-title').textContent(), '<unsafe>');
  assert.equal(await page.locator('unsafe').count(), 0);
  await page.evaluate(() => { currentLanguage = 'en'; drawRow(); });
  assert.equal(await page.locator('.session-time-label').textContent(), 'now');
  assert.match(await page.locator('.workspace-history-meta').textContent(), /2 messages/);
  assert.deepEqual(errors, []);
  console.log('PASS: delayed time module preserves auth ordering, live language and escaped session rows');
} finally {
  release();
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
