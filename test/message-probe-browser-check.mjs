// Real message probe host + session commit; controlled HTTP races, no user data.
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const main = await fs.readFile('public/src/app-main.js', 'utf8');
// classic 宿主切片：probe 宿主与其窄 UI 适配器（仍是 classic 的唯一实现），
// 边界锚在下一个宿主工厂，不越出 app-main 的其它域。
const hostStart = main.indexOf('function createMessageProbeHost(');
const hostSource = main.slice(hostStart, main.indexOf('function createMetadataCommitHost(', hostStart));
const index = await fs.readFile('public/index.html', 'utf8');
const body = index.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const app = express();
app.use(express.static('public'));
app.get('/fixture', (_req, res) => res.type('html').send(body.replace('</body>', `<div id="body"></div>
<script src="/src/modules/kernel-state.js"></script>
<script src="/src/app-core.js"></script>
<script src="/src/modules/action-dispatcher.js"></script>
<script type="module" src="/src/modules/overview-data.js"></script>
<script src="/src/modules/todo-plan.js"></script>
<script src="/src/modules/session-view-state.js"></script>
<script src="/src/modules/runtime-status.js"></script>
<script type="module" src="/src/modules/auto-title.js"></script>
<script>
 ${hostSource}
 currentRuntimeAgentId = 'rt'; focusedAgentId = 'host';
 // R2 边界：显式 identity patch 在身份变化时会调用 overview-data（ESM）的
 // setCurrentHookInspector / setCurrentOverviewSnapshot 桥键，这两个键在 overview-data
 // 求值前不存在；首屏身份与消息基线因此改走 sessionMeta 推导（同一条生产数据加载路径）。
 // 生产 classic 相是否存在早于模块的身份 patch，由主助手审计收口。
 applySessionViewPatch({ sessionMeta: { sessionId: 'a' } });
 applySessionViewPatch({ messages: [{ role: 'assistant', content: 'before' }] });
 window.attachMessagesTimestamps = messages => messages;
 window.clearChatLoadingSession = () => {};
 window.shouldRenderWorkspaceSurface = () => false;
 window.paint = () => { document.getElementById('body').textContent = currentMessages.map(m => m.content).join(','); };
 window.renderCurrentMainView = window.appendNewMessages = window.updateLastMessage = window.paint;
 window.started = false;
</script>
<script src="/src/modules/auth-client.js"></script>
<script type="module" src="/src/modules/message-probe-host.js"></script>
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
  await page.route('**/src/modules/message-probe-host.js', async route => { await gate; await route.continue(); });
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`, { waitUntil: 'commit' });
  await page.waitForFunction(() => document.readyState === 'interactive' && window.started === false);
  release();
  await page.waitForFunction(() => window.started === true);
  let oldResponse;
  let requestCount = 0;
  await page.route('**/api/agents/rt/messages*', async route => {
    requestCount++;
    if (requestCount === 1) { oldResponse = route; return; }
    await route.fulfill({ json: { messages: [{ role: 'assistant', content: 'done' }, { role: 'user', content: 'new input' }] } });
  });
  const request = page.waitForRequest('**/api/agents/rt/messages*');
  await page.evaluate(() => { window.oldCycle = runMessagesProbeCycle(captureSessionViewToken(), { seq: 1, count: 1, changeKind: 'tail' }); });
  await request;
  await page.evaluate(() => runMessagesProbeCycle(captureSessionViewToken(), { seq: 2, count: 2, changeKind: 'append' }));
  assert.equal(await page.locator('#body').textContent(), 'done,new input');
  await oldResponse.fulfill({ json: { messages: [{ role: 'assistant', content: 'old reply' }] } });
  assert.equal(await page.evaluate(() => window.oldCycle), 'stale');
  assert.equal(await page.locator('#body').textContent(), 'done,new input');
  assert.equal(requestCount, 2);
  assert.deepEqual(errors, []);
  console.log('PASS: delayed probe initializes before auth boot; late poll cannot remove newer visible input');
} finally {
  release();
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
