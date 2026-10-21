/* global window, document, getComputedStyle, allAgents: writable, focusedAgentId: writable, currentRuntimeAgentId: writable, applySessionViewPatch, getEmptyStateHtml */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const source = await fs.readFile('public/index.html', 'utf8');
  await page.route('http://claw.test/**', (route) => route.fulfill({ contentType: 'text/html', body: source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '') }));
  await page.goto('http://claw.test/');
  for (const name of ['base', 'layout', 'components', 'app-chat-input']) {
    await page.addStyleTag({ content: await fs.readFile(`public/styles/${name}.css`, 'utf8') });
  }
  await page.addScriptTag({ content: await fs.readFile('node_modules/marked/lib/marked.umd.js', 'utf8') });
  for (const name of ['app-core', 'modules/markdown-utils', 'modules/session-view-state', 'modules/workspace-agents']) {
    await page.addScriptTag({ content: await fs.readFile(`public/src/${name}.js`, 'utf8') });
  }
  await page.evaluate(() => {
    window.setCurrentHookInspector = () => {};
    window.setCurrentOverviewSnapshot = () => {};
    window.setCurrentTodoPlan = () => {};
    allAgents = [{ id: 'fixture', source: 'prebuilt', name: 'Workspace', defaultAgentId: 'main', agents: [
      { id: 'main', displayName: '编程小助手' }, { id: 'reviewer', displayName: { zh: '审查助手', en: 'Reviewer' } },
    ], workspace_sessions: { activeSessionId: 'other', sessions: [{ id: 'selected', workspaceAgentId: 'main' }] } }];
    focusedAgentId = 'fixture'; currentRuntimeAgentId = 'runtime';
    if (!focusedAgentId || !currentRuntimeAgentId) throw new Error('Conversation identity missing');
    applySessionViewPatch({ identity: { agentId: 'fixture', sessionId: 'selected' } });
    document.getElementById('chat-container').innerHTML = getEmptyStateHtml();
    document.getElementById('user-input-container').innerHTML = '<div class="user-input-card persistent-input" style="pointer-events:auto;width:85%;max-width:800px;height:140px"><textarea class="user-input-textarea" aria-label="Message"></textarea></div>';
  });
  for (const theme of ['dark', 'light']) {
    await page.locator('body').evaluate((body, value) => { body.dataset.theme = value; }, theme);
    for (const [width, height] of [[1920, 1080], [1536, 864], [1366, 768], [1280, 720], [1024, 576], [800, 450], [375, 667]]) {
      await page.setViewportSize({ width, height });
      await page.locator('.empty-welcome').evaluate(async (element) => { await Promise.all(element.getAnimations().map((animation) => animation.finished)); });
      const metrics = await page.evaluate(() => {
        const container = document.getElementById('chat-container');
        const welcome = document.querySelector('.empty-welcome');
        const input = document.querySelector('.user-input-card');
        container.scrollTop = 100;
        return { scroll: container.scrollTop, overflow: container.scrollHeight - container.clientHeight,
          fits: welcome.getBoundingClientRect().bottom <= input.getBoundingClientRect().top,
          titleFits: document.querySelector('.empty-welcome-title').getBoundingClientRect().top >= container.getBoundingClientRect().top,
          rootOverflow: document.documentElement.scrollHeight - window.innerHeight,
          outside: Array.from(document.querySelectorAll('body *')).filter((element) => element.getBoundingClientRect().bottom > window.innerHeight).map((element) => [element.className, Math.round(element.getBoundingClientRect().bottom)]),
          width: document.documentElement.scrollWidth - window.innerWidth, bodyHeight: document.body.getBoundingClientRect().height };
      });
      assert.equal(metrics.scroll, 0, `${theme} ${width}x${height} must not scroll`);
      assert.ok(metrics.overflow <= 1, `${theme} ${width}x${height} content overflow: ${JSON.stringify(metrics)}`);
      assert.equal(metrics.fits, true, 'welcome must remain above composer');
      assert.equal(metrics.titleFits, true, 'title must remain visible');
      // The right rail has its own short-window overflow; this check owns the conversation column.
      console.log(`PASS ${theme} ${width}x${height}: welcome fits, no scroll`);
    }
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: '.agentdev/temp/welcome-light.png' });
  await page.locator('body').evaluate((body) => { body.dataset.theme = 'dark'; });
  await page.screenshot({ path: '.agentdev/temp/welcome-dark.png' });
  const choice = page.evaluate(() => window.ClawFW.workspaceAgents.selectForNewSession(allAgents[0], { type: 'create_session' }));
  await page.locator('#workspace-agent-picker-select').selectOption('reviewer');
  await page.locator('.workspace-agent-picker button[type="submit"]').click();
  assert.equal((await choice).workspaceAgentId, 'reviewer');
  await page.evaluate(() => {
    applySessionViewPatch({ sessionMeta: { sessionId: 'selected', workspaceAgentId: 'reviewer' } });
    document.getElementById('chat-container').innerHTML = getEmptyStateHtml();
  });
  assert.match(await page.locator('.empty-welcome-title').textContent(), /审查助手/);
  const cancelled = page.evaluate(() => window.ClawFW.workspaceAgents.selectForNewSession(allAgents[0], { type: 'create_session' }));
  await page.locator('#workspace-agent-picker-select').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await cancelled, null);
  await page.evaluate(() => { document.getElementById('chat-container').innerHTML = '<div style="min-height:2000px">Message history</div>'; });
  assert.equal(await page.locator('#user-input-container').evaluate((element) => getComputedStyle(element).position), 'absolute');
  assert.ok(await page.locator('#chat-container').evaluate((element) => { element.scrollTop = 100; return element.scrollTop > 0; }));
  assert.deepEqual(errors, []);
  console.log('PASS Agent selection, bound welcome, cancellation and normal message scrolling');
} finally {
  await browser.close();
}
