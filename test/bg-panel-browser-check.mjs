/* global window, document, innerWidth, getComputedStyle */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Isolated presentation fixture: no running Claw service or user data.
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
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
  // Exercise the real host and bg registration: poll-driven host renders must
  // not discard scroll state retained by the panel's own event-driven updates.
  await page.evaluate(() => {
    const root = document.getElementById('bg-panel-root');
    const panel = document.createElement('aside');
    const body = document.createElement('div');
    panel.append(body);
    document.body.append(panel);
    body.append(root);
    Object.assign(window, {
      featurePanel: panel, featurePanelBody: body, featurePanelTitle: document.createElement('h2'),
      featurePanelWidth: 420, railButtons: [], featurePanels: {},
      registerFeaturePanel: (id, definition) => { window.featurePanels[id] = definition; },
    });
  });
  const ui = await readFile(new URL('../public/src/app-ui.js', import.meta.url), 'utf8');
  await page.addScriptTag({ content: ui.slice(ui.indexOf("registerFeaturePanel('bg', {"), ui.indexOf("registerFeaturePanel('monitor', {")) });
  await page.addScriptTag({ content: await readFile(new URL('../public/src/modules/debug-panel-host.js', import.meta.url), 'utf8') });
  await page.evaluate(() => window.renderFeaturePanel());
  const scrollChecks = await page.evaluate(() => {
    const stream = window.streams[0];
    const task = { id: 'same', command: 'bash build', status: 'running', startedAt: 1,
      outputTail: Array.from({ length: 60 }, (_, i) => `output line ${i}`).join('\n') };
    const emit = () => stream.listeners.get('event')({ data: JSON.stringify({ type: 'output', data: task }) });
    emit();
    const getTail = () => Array.from(document.querySelectorAll('.bgp-card'))
      .find(card => card.querySelector('.bgp-cmd').textContent === 'bash build').querySelector('.bgp-tail');
    let tail = getTail();
    tail.scrollTop = 80;
    const before = tail.scrollTop;
    task.outputTail += '\nnew output';
    emit();
    const afterEvent = getTail().scrollTop;
    window.renderFeaturePanel();
    tail = getTail();
    return { before, afterEvent, afterHost: tail.scrollTop };
  });
  assert.ok(scrollChecks.before > 0, 'fixture must have scrollable process output');
  assert.equal(scrollChecks.afterEvent, scrollChecks.before, 'live output must retain the reading position');
  assert.equal(scrollChecks.afterHost, scrollChecks.before, 'host refresh after live output must retain the reading position');
  console.log('process output: reading position survives live event followed by host refresh');

  const agentScroll = await page.evaluate(() => {
    const stream = window.streams.find(stream => stream.url.includes('featureId=coder'));
    const task = { id: 'same', agentId: 'coder', title: '验证协议面板', threadId: 'wt-fixture', commandId: 'cmd-fixture',
      status: 'executing', startedAt: 1, revision: 2, updatedAt: 1,
      summary: Array.from({ length: 60 }, (_, i) => `agent progress ${i}`).join('\n') };
    const emit = () => stream.listeners.get('event')({ data: JSON.stringify({ type: 'updated', data: task }) });
    emit();
    const card = () => Array.from(document.querySelectorAll('.bgp-card')).find(card => card.textContent.includes('验证协议面板'));
    const tail = () => card().querySelector('.bgp-tail');
    const initialTail = tail();
    tail().scrollTop = 80;
    const before = tail().scrollTop;
    task.summary += '\nnew progress';
    task.updatedAt = 2000;
    task.revision++;
    emit();
    const afterSummary = tail().scrollTop;
    const sameNode = tail() === initialTail;
    const updatedClock = card().querySelector('[data-bgp-updated]')?.textContent;
    window.renderFeaturePanel();
    const afterHost = tail().scrollTop;
    task.status = 'suspended';
    task.revision++;
    emit();
    const afterStatus = tail().scrollTop;
    card().querySelector('.bgp-head').click(); // collapse
    task.summary += '\nhidden progress';
    task.revision++;
    emit();
    card().querySelector('.bgp-head').click(); // expand
    return { before, afterSummary, afterHost, afterStatus, afterExpand: tail().scrollTop, sameNode,
      updatedClock, expectedClock: new Date(task.updatedAt).toTimeString().slice(0, 8) };
  });
  assert.ok(agentScroll.before > 0, 'fixture must have scrollable agent progress');
  assert.equal(agentScroll.sameNode, true, 'summary and timestamp updates must not rebuild the output node');
  assert.equal(agentScroll.updatedClock, agentScroll.expectedClock, 'timestamp must still update on the lightweight path');
  for (const key of ['afterSummary', 'afterHost', 'afterStatus', 'afterExpand']) {
    assert.equal(agentScroll[key], agentScroll.before, `agent ${key}: progress reading position must be retained`);
  }
  console.log('agent progress: summary, host, status and collapse/expand retain reading position');

  const followChecks = await page.evaluate(() => {
    const stream = window.streams[0];
    const task = { id: 'same', command: 'bash build', status: 'running', startedAt: 1,
      outputTail: Array.from({ length: 80 }, (_, i) => `output line ${i}`).join('\n') };
    const emit = () => stream.listeners.get('event')({ data: JSON.stringify({ type: 'output', data: task }) });
    const card = () => Array.from(document.querySelectorAll('.bgp-card')).find(card => card.querySelector('.bgp-cmd').textContent === 'bash build');
    const tail = () => card().querySelector('.bgp-tail');
    emit();
    tail().scrollTop = tail().scrollHeight;
    task.outputTail += '\nfollow new output';
    emit();
    window.renderFeaturePanel();
    const distance = () => tail().scrollHeight - tail().clientHeight - tail().scrollTop;
    const afterOutput = distance();
    task.readyFired = true; // structural status change
    emit();
    const afterStructure = distance();
    card().querySelector('.bgp-head').click();
    task.outputTail += '\nfollow hidden output';
    emit();
    card().querySelector('.bgp-head').click();
    return { afterOutput, afterStructure, afterExpand: distance() };
  });
  for (const [key, distance] of Object.entries(followChecks)) {
    assert.ok(Math.abs(distance) <= 1, `${key}: output at the bottom must keep following`);
  }
  console.log('process output: bottom-follow survives output, structure changes and collapse/expand');

  // A live event after baseline must repaint without nesting roots or erasing agent summaries.
  await page.evaluate(() => window.streams[0].listeners.get('event')({ data: JSON.stringify({ type: 'output',
    data: { id: 'same', command: 'bash build', status: 'running', outputTail: 'fresh tail', startedAt: Date.now() } }) }));
  assert.equal(await page.locator('#bg-panel-root').count(), 1);
  assert.equal(await page.locator('.bgp-card').filter({ hasText: 'agent progress 0' }).count(), 1);
  assert.deepEqual(errors, []);
  console.log('live repaint: one root, agent summary retained, no page errors');
} finally {
  await browser.close();
}
