// Delayed ESM must preserve first-paint reads and reject stale async commits.
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
<script type="module" src="/src/modules/overview-data.js"></script>
<script src="/src/modules/todo-plan.js"></script>
<script src="/src/modules/runtime-status.js"></script>
<script src="/src/modules/session-view-state.js"></script>
<script>
 currentRuntimeAgentId = 'rt'; focusedAgentId = 'host';
 // R2 边界：显式 identity patch 在身份变化时会调用 overview-data（ESM）的
 // setCurrentHookInspector / setCurrentOverviewSnapshot 桥键，这两个键在 overview-data
 // 求值前不存在；首屏身份因此改走 sessionMeta 推导（同一条生产数据加载路径），
 // classic 相即可落地会话视图身份与 token。生产 classic 相的早触达审计由主助手收口。
 applySessionViewPatch({ sessionMeta: { sessionId: 'a' } });
 applySessionViewPatch({ messages: [{content: 'first paint'}] });
 window.beforeModule = captureSessionViewToken();
 document.getElementById('chat-container').textContent = readCurrentSessionViewState().messages[0].content;
 window.started = false;
</script>
<script src="/src/modules/auth-client.js"></script>
<script type="module" src="/src/modules/session-view-commit-host.js"></script>
<script>
 (async () => { await __clawAuthReady; window.started = true; })();
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
  await page.route('**/src/modules/session-view-commit-host.js', async (route) => { await gate; await route.continue(); });
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`, { waitUntil: 'commit' });
  try {
    await page.waitForFunction(() => document.readyState === 'interactive' && window.started === false, null, { timeout: 5000 });
  } catch (error) {
    console.error({ errors, state: await page.evaluate(() => ({ ready: document.readyState, started: window.started, paint: document.getElementById('chat-container').textContent })) });
    throw error;
  }
  assert.equal(await page.locator('#chat-container').textContent(), 'first paint');
  release();
  await page.waitForFunction(() => window.started === true);
  const outcome = await page.evaluate(() => {
    let callbacks = 0;
    const accepted = commitSessionViewPatch(beforeModule, { messages: [{ content: 'accepted' }] }, () => callbacks++);
    const old = captureSessionViewToken();
    applySessionViewPatch({ identity: { agentId: 'host', sessionId: 'b' } });
    applySessionViewPatch({ identity: { agentId: 'host', sessionId: 'a' } });
    const rejected = commitSessionViewPatch(old, { messages: [{ content: 'stale' }] }, () => callbacks++);
    const token = captureSessionViewToken();
    applySessionViewPatch({ inputRequests: [{ requestId: 'new' }] });
    const mixed = commitSessionViewPatch(token, { messages: [{ content: 'fresh' }], inputRequests: [{ requestId: 'old' }] });
    return { accepted, rejected, mixed, callbacks, message: currentMessages[0].content, request: currentInputRequests[0].requestId };
  });
  assert.deepEqual(outcome, { accepted: true, rejected: false, mixed: true, callbacks: 1, message: 'fresh', request: 'new' });
  assert.deepEqual(errors, []);
  console.log('PASS: first-paint read survives delayed ESM; stale revisit has no effects; newer input lease survives mixed commit');
} finally {
  release();
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
