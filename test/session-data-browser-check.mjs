// Browser integration for message-first loading through the real ESM host.
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
<script src="/src/modules/session-view-state.js"></script>
<script src="/src/modules/runtime-status.js"></script>
<script>
 focusedAgentId = 'host'; currentRuntimeAgentId = 'rt';
 allAgents = [{ id: 'host', source: 'prebuilt' }];
 // R2 边界：显式 identity patch 在身份变化时会调用 overview-data（ESM）的
 // setCurrentHookInspector / setCurrentOverviewSnapshot 桥键，这两个键在 overview-data
 // 求值前不存在；首屏身份因此改走 sessionMeta 推导（同一条生产数据加载路径）。
 // 生产 classic 相是否存在早于模块的身份 patch，由主助手审计收口。
 applySessionViewPatch({ sessionMeta: { sessionId: 'a' } });
 window.attachMessagesTimestamps = (messages) => messages;
 window.resetRuntimeStatusForSwitch = window.updateNotificationStatus = window.renderFeaturePanel =
   window.updateRollbackActionVisibility = window.clearChatLoadingSession = () => {};
 window.collectTemplateNames = () => [];
 window.warmTemplatesInBackground = () => {};
 window.renderCurrentMainView = (view) => { document.getElementById('chat-container').textContent = view.messages.map(m => m.content).join(','); };
 window.getCurrentRuntimeRecord = () => allAgents[0];
 window.getCurrentAgentRecord = () => allAgents[0];
 window.started = false;
</script>
<script src="/src/modules/auth-client.js"></script>
<script type="module" src="/src/modules/session-data-loader-host.js"></script>
<script>
 (async () => { await __clawAuthReady; window.started = true; await loadAgentData('rt'); window.finished = true; })();
</script></body>`)));
app.get('/protoclaw/auth/status', (_req, res) => res.json({ enabled: false, authenticated: true }));
app.get('/api/templates/feature', (_req, res) => res.json({}));
app.get('/protoclaw/agent_detail', (_req, res) => res.json({}));
app.get('/api/agents/rt/:endpoint', (req, res) => {
  const { endpoint } = req.params;
  const payload = { messages: { messages: [{ role: 'assistant', content: 'first body' }] },
    tools: [{ name: 'read' }], hooks: {}, overview: { modelName: 'model' }, todo: {},
    'input-requests': [], notification: { state: 'idle' }, connection: { connected: true } };
  res.json(payload[endpoint]);
});
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
  await page.route('**/api/agents/rt/tools', async (route) => { await gate; await route.continue(); });
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
  await page.waitForFunction(() => document.getElementById('chat-container').textContent === 'first body');
  assert.equal(await page.evaluate(() => window.finished), undefined, 'message paint must not await slow tools');
  await page.evaluate(() => applySessionViewPatch({ messages: [{ role: 'assistant', content: 'newer live body' }] }));
  release();
  await page.waitForFunction(() => window.finished === true);
  assert.equal(await page.evaluate(() => currentMessages[0].content), 'newer live body');
  assert.equal(await page.evaluate(() => TOOL_NAMES.read), 'Read');
  assert.equal(await page.evaluate(() => currentOverviewSnapshot.modelName), 'model');
  assert.deepEqual(errors, []);
  console.log('PASS: messages paint before slow tools; late tool configuration never restores older body content');
} finally {
  release();
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
