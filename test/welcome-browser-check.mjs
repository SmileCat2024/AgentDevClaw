/* global window, document, getComputedStyle, allAgents: writable, focusedAgentId: writable, currentRuntimeAgentId: writable, currentMessages: writable, applySessionViewPatch, getEmptyStateHtml, _lastCallFinishTime: writable, _runCapsuleStartAt: writable, _runCapsuleStartConfirmed: writable, _renderLastCallElapsed, resetRuntimeStatusForSwitch, updateFollowLatestButton, updateFollowLatestButtonPosition, buildComposerCard, applyComposerMode, _agentCallActive */
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
  // Geometry assertions compare settled layout, not an in-flight button transition.
  await page.addStyleTag({ content: '.follow-latest-btn { transition: none; }' });
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
  await page.evaluate(() => {
    window.t = (key) => key;
    window.isChatSurfaceActive = () => true;
    window.normalizeAgentIdentity = (value) => String(value || '').trim();
    window.setInterval = () => 0;
  });
  for (const name of ['persistent-input', 'input-composer', 'runtime-status', 'chat-viewport']) {
    await page.addScriptTag({ content: await fs.readFile(`public/src/modules/${name}.js`, 'utf8') });
  }
  // Exercise real capsule rendering and button positioning, including a late tick.
  for (const theme of ['dark', 'light']) {
    await page.locator('body').evaluate((body, value) => { body.dataset.theme = value; }, theme);
    for (const [width, height] of [[1920, 1080], [1280, 720], [800, 450], [375, 667]]) {
      await page.setViewportSize({ width, height });
      await page.locator('.empty-welcome').evaluate(async (element) => { await Promise.all(element.getAnimations().map((animation) => animation.finished)); });
      const geometry = await page.evaluate(() => {
        const measure = () => {
          updateFollowLatestButtonPosition();
          return ['.empty-welcome-title', '.user-input-card', '.follow-latest-btn'].map((selector) => {
            const rect = document.querySelector(selector).getBoundingClientRect();
            return { top: rect.top, height: rect.height };
          });
        };
        _lastCallFinishTime = Date.now() - 5000;
        _renderLastCallElapsed();
        const withCapsule = measure();
        _lastCallFinishTime = 0;
        _renderLastCallElapsed();
        const withoutCapsule = measure();
        return { withCapsule, withoutCapsule };
      });
      assert.deepEqual(geometry.withCapsule, geometry.withoutCapsule,
        `${theme} ${width}x${height}: timer visibility must not move welcome, composer or follow button`);
    }
  }
  const reset = await page.evaluate(() => {
    _lastCallFinishTime = Date.now() - 5000;
    _renderLastCallElapsed();
    _runCapsuleStartAt = Date.now() - 10000;
    _runCapsuleStartConfirmed = true;
    currentRuntimeAgentId = 'empty-runtime';
    resetRuntimeStatusForSwitch();
    const immediate = { visible: !!document.querySelector('.call-elapsed-capsule'),
      finish: _lastCallFinishTime, start: _runCapsuleStartAt, confirmed: _runCapsuleStartConfirmed };
    _renderLastCallElapsed();
    return { ...immediate, afterTick: !!document.querySelector('.call-elapsed-capsule') };
  });
  assert.deepEqual(reset, { visible: false, afterTick: false, finish: 0, start: 0, confirmed: false },
    'switch must synchronously clear timer state and DOM, before any network response or tick');
  await page.evaluate(() => {
    currentMessages = [{ role: 'system', content: 'System prompt only' }];
    updateFollowLatestButton();
  });
  assert.equal(await page.locator('.follow-latest-btn').evaluate((element) => element.classList.contains('hidden')), true,
    'system-only welcome has no history to follow');
  console.log('PASS timer-independent layout, synchronous switch reset and welcome follow visibility');
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
  await page.evaluate(() => {
    const host = document.getElementById('user-input-container');
    host.replaceChildren(buildComposerCard());
    currentMessages = [{ role: 'user', content: 'Message history' }];
    if (!currentMessages.some((message) => message.role === 'user')) throw new Error('Chat history fixture missing');
    updateFollowLatestButton();
  });
  for (const theme of ['dark', 'light']) {
    await page.locator('body').evaluate((body, value) => { body.dataset.theme = value; }, theme);
    for (const [width, height] of [[1920, 1080], [1280, 720], [800, 450], [375, 667]]) {
      await page.setViewportSize({ width, height });
      for (const panelOpen of [false, true]) {
        for (const mode of ['persistent', 'requests']) {
          const metrics = await page.evaluate(({ mode, panelOpen }) => {
            document.querySelector('.main-content').classList.toggle('panel-open', panelOpen);
            const host = document.getElementById('user-input-container');
            const card = host.querySelector('.user-input-card');
            applyComposerMode(card, mode, { requestId: 'fixture-lease', actions: [] });
            const measure = () => {
              updateFollowLatestButtonPosition();
              return [host, card, document.querySelector('.follow-latest-btn')].map((element) => {
                const rect = element.getBoundingClientRect();
                return { top: rect.top, height: rect.height };
              });
            };
            _agentCallActive.delete(currentRuntimeAgentId);
            _lastCallFinishTime = 0;
            _renderLastCallElapsed();
            const idle = measure();
            const chat = document.getElementById('chat-container');
            const history = chat.innerHTML;
            chat.innerHTML = getEmptyStateHtml();
            const welcome = measure();
            chat.innerHTML = '<div class="empty-state chat-loading">Loading</div>';
            const loading = measure();
            chat.innerHTML = history;
            const process = measure();
            _lastCallFinishTime = Date.now() - 5000;
            _renderLastCallElapsed();
            const finished = measure();
            _agentCallActive.set(currentRuntimeAgentId, true);
            _renderLastCallElapsed();
            const running = measure();
            resetRuntimeStatusForSwitch();
            _agentCallActive.delete(currentRuntimeAgentId);
            return { idle, welcome, loading, process, finished, running, reset: measure() };
          }, { mode, panelOpen });
          for (const state of ['welcome', 'loading', 'process', 'finished', 'running', 'reset']) {
            assert.deepEqual(metrics[state], metrics.idle,
              `${theme} ${width}x${height} ${mode} panel=${panelOpen} ${state}: surface and timer changes must not move input host, card or follow button`);
          }
        }
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log('PASS Agent selection, bound welcome, cancellation and normal message scrolling');
  console.log('PASS real composer persistent/requests: welcome/loading/process and idle/running/finished/reset keep host, card and follow button geometry in both themes and panel states');
  await page.setViewportSize({ width: 1280, height: 720 });
  for (const theme of ['dark', 'light']) {
    await page.locator('body').evaluate((body, value) => { body.dataset.theme = value; }, theme);
    await page.evaluate(() => {
      document.querySelector('.main-content').classList.remove('panel-open');
      _lastCallFinishTime = Date.now() - 5000;
      _renderLastCallElapsed();
      updateFollowLatestButtonPosition();
    });
    await page.screenshot({ path: `.agentdev/temp/timer-layout-${theme}.png` });
  }
} finally {
  await browser.close();
}
