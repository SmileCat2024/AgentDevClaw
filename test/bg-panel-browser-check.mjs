/* global window, document, innerWidth, getComputedStyle */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Isolated presentation fixture: no running Claw service or user data.
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<html><head></head><body><span id="rail-bg-badge"></span><div id="bg-panel-root"></div></body></html>');
  await page.addStyleTag({ content: await readFile(new URL('../public/styles/base.css', import.meta.url), 'utf8') });
  await page.evaluate(() => {
    window.currentRuntimeAgentId = 'fixture-runtime';
    window.focusedAgentId = 'fixture';
    window.currentLanguage = 'zh';
    window.activeFeaturePanel = 'bg';
    window.getRuntimeWorkspaceSessionId = () => 'fixture-session';
    const presentation = protocol => ({ panel: 'background', protocol, version: 1 });
    window.ClawFeatureCommunication = { listChannels: async () => [
      { featureId: 'bash', channelId: 'jobs', title: 'Bash', presentation: presentation('claw.background.process') },
      { featureId: 'pwsh', channelId: 'jobs', title: 'PowerShell', presentation: presentation('claw.background.process') },
      { featureId: 'coder', channelId: 'runs', title: 'Coder', presentation: presentation('claw.background.agent') },
    ] };
    window.streams = [];
    window.EventSource = class {
      listeners = new Map();
      constructor(url) { this.url = url; window.streams.push(this); queueMicrotask(() => this.listeners.get('open')?.({})); }
      addEventListener(type, callback) { this.listeners.set(type, callback); }
      close() {}
    };
    window.fetch = async (_url, init) => {
      const request = JSON.parse(init.body);
      return { ok: true, json: async () => ({ result: { ok: true, tasks: [request.featureId === 'coder'
        ? { id: 'same', agentId: 'coder', title: '验证协议面板', threadId: 'wt-fixture', commandId: 'cmd-fixture',
          status: 'suspended', summary: '等待真实关联工作唤醒', updatedAt: Date.now() }
        : { id: 'same', command: request.featureId + ' build', status: 'running', outputTail: 'fixture output', startedAt: Date.now() }] } }) };
    };
  });
  await page.addScriptTag({ content: await readFile(new URL('../public/src/modules/bg-panel.js', import.meta.url), 'utf8') });
  await page.evaluate(() => window.BgPanel.onOpen());
  await page.waitForFunction(() => document.querySelectorAll('.bgp-card').length === 3);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.body.dataset.theme = theme, theme);
    assert.equal(await page.locator('#bg-panel-root').count(), 1);
    assert.equal(await page.locator('.bgp-kill-btn').count(), 2);
    assert.equal(await page.locator('.bgp-report-btn').count(), 2);
    assert.equal(await page.locator('.bgp-card').filter({ hasText: '验证协议面板' }).locator('button').count(), 0);
    assert.equal(await page.locator('#rail-bg-badge').textContent(), '3');
    assert.ok(await page.locator('.bgp-card').evaluateAll(cards => cards.every(card => card.getBoundingClientRect().right <= innerWidth)));
    assert.ok(await page.locator('.bgp-result-main').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).color !== 'rgba(0, 0, 0, 0)')));
    await page.screenshot({ path: `.agentdev/temp/bg-panel-${theme}.png`, fullPage: true });
    console.log(`${theme}: three isolated cards, process-only controls, badge=3, no overflow`);
  }
  // A live event after baseline must repaint without nesting roots or erasing agent summaries.
  await page.evaluate(() => window.streams[0].listeners.get('event')({ data: JSON.stringify({ type: 'output',
    data: { id: 'same', command: 'bash build', status: 'running', outputTail: 'fresh tail', startedAt: Date.now() } }) }));
  assert.equal(await page.locator('#bg-panel-root').count(), 1);
  assert.equal(await page.locator('.bgp-card').filter({ hasText: '等待真实关联工作唤醒' }).count(), 1);
  assert.deepEqual(errors, []);
  console.log('live repaint: one root, agent summary retained, no page errors');
} finally {
  await browser.close();
}
