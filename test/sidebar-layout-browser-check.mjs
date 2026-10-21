/* global window, document, MutationObserver, getComputedStyle */
// Run explicitly: this exercises real pointer gestures and HTTP persistence in Chromium.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { startSidebarFixture } from './sidebar-layout-browser-fixture.mjs';

const fixture = await startSidebarFixture();
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const app = id => page.locator(`[data-layout-handle="app:${id}"]`);
const folder = id => page.locator(`#${id} > .agent-group-header`);
const waitSaved = () => page.waitForFunction(() => !JSON.parse(window.ClawSidebarLayout.signature()).saving);
async function drag(source, destination, fraction = .5, xInset = 60) {
  const from = await source.boundingBox();
  const to = await destination.boundingBox();
  await page.mouse.move(from.x + 50, from.y + from.height / 2);
  await page.mouse.down();
  await page.waitForFunction(() => document.getElementById('agent-list').classList.contains('layout-arranging'));
  await page.mouse.move(to.x + xInset, to.y + to.height * fraction, { steps: 5 });
  await page.mouse.up();
  await waitSaved();
}
try {
  await page.goto(fixture.url);
  await page.waitForSelector('body[data-ready="true"]');
  const settingsPath = path.join(fixture.dataDir, 'workspace-settings.json');
  await assert.rejects(fs.access(settingsPath), { code: 'ENOENT' });
  assert.deepEqual(await page.evaluate(() => JSON.parse(window.ClawSidebarLayout.signature())), { layout: null, loaded: true, saving: false });
  assert.deepEqual(await page.locator('#prebuilt-agent-list [data-layout-handle]').evaluateAll(els => els.map(el => el.dataset.agentId)), ['qqbot', 'memo']);
  assert.deepEqual(await page.locator('#tool-agent-list [data-layout-handle]').evaluateAll(els => els.map(el => el.dataset.agentId)), ['programming-helper', 'coder']);
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
  await assert.rejects(fs.access(settingsPath), { code: 'ENOENT' });
  assert.equal(await page.locator('#sidebar-layout-status').isVisible(), false);
  console.log('PASS upgrade without settings file renders defaults across reload without writing');
  const legacySettings = { version: 1, workspaceVisibility: { coder: 'always' }, resourcePolicy: { coder: { maxLiveThreads: 3 } } };
  await fs.writeFile(settingsPath, JSON.stringify(legacySettings));
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
  assert.equal(await page.evaluate(() => JSON.parse(window.ClawSidebarLayout.signature()).layout), null);
  assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, 'utf8')), legacySettings);
  assert.equal(await folder('prebuilt-group').getAttribute('aria-expanded'), 'true');
  assert.equal(await folder('tool-group').getAttribute('aria-expanded'), 'true');
  console.log('PASS upgrade with existing settings but no layout uses expanded defaults without rewriting settings');
  assert.equal(await page.locator('#work-group-group').count(), 0);
  // Drag feedback must follow stable layout slots, not whichever descendant is hit.
  const start = await app('coder').boundingBox();
  const rootBefore = await page.locator('#agent-list').boundingBox();
  await page.mouse.move(start.x + 60, start.y + start.height / 2);
  await page.mouse.down();
  await page.waitForSelector('.layout-arranging');
  const rootDuring = await page.locator('#agent-list').boundingBox();
  assert.equal(await page.locator('#sidebar-layout-status').isVisible(), false, 'starting a drag shows no bottom instructions');
  const feedback = () => page.locator('.layout-drop-before, .layout-drop-after, .layout-drop-inside').evaluateAll(els => els.map(el => ({
    id: el.dataset.layoutHandle || el.dataset.layoutId || el.id,
    inside: el.classList.contains('layout-drop-inside'),
  })));
  const memoBox = await app('memo').boundingBox();
  const qqBox = await app('qqbot').boundingBox();
  await page.mouse.move(memoBox.x + 60, memoBox.y - 1);
  const gapFeedback = await feedback();
  await page.mouse.move(memoBox.x + 60, memoBox.y + 1);
  const rowFeedback = await feedback();
  await page.mouse.move(start.x + 60, start.y + start.height / 2);
  const selfFeedback = await feedback();
  const header = await folder('prebuilt-group').boundingBox();
  await page.mouse.move(header.x + 60, header.y + header.height - 1);
  const headerEdgeFeedback = await feedback();
  assert.deepEqual(headerEdgeFeedback, [{ id: 'folder:prebuilt-group', inside: true }], 'folder destination highlights the whole container');
  assert.equal(await folder('prebuilt-group').evaluate(el => el.classList.contains('layout-drop-inside')), false, 'header is not outlined separately');
  const highlightedFolder = await page.locator('#prebuilt-group.layout-drop-inside').boundingBox();
  assert.ok(highlightedFolder.y + highlightedFolder.height >= memoBox.y + memoBox.height, 'folder outline encloses its last application');
  for (let y = header.y + 1; y < header.y + header.height; y++) {
    await page.mouse.move(header.x + 60, y);
    assert.equal((await feedback())[0]?.inside, true, 'entire folder header offers one consistent action');
    assert.equal(await page.locator('#sidebar-layout-status').isVisible(), false, 'folder destination shows no bottom instructions');
  }
  await page.screenshot({ path: '.tmp/sidebar-drag-folder-dark.png' });
  await page.locator('#theme').dispatchEvent('click');
  await page.screenshot({ path: '.tmp/sidebar-drag-folder-light.png' });
  await page.locator('#theme').dispatchEvent('click');
  assert.ok(qqBox.y + qqBox.height <= memoBox.y, 'fixture apps establish an actual gap to sweep');
  for (let y = qqBox.y + qqBox.height - 2; y <= memoBox.y + 2; y++) {
    await page.mouse.move(qqBox.x + 60, y);
    const marks = await feedback();
    assert.equal(marks.length, 1);
    assert.equal(marks[0].inside, false, 'application gap remains an insertion line');
    assert.equal(marks[0].id, 'app:memo', 'one logical slot keeps one visual anchor');
    assert.equal(await page.locator('#sidebar-layout-status').isVisible(), false, 'insertion destination shows no bottom instructions');
  }
  await page.screenshot({ path: '.tmp/sidebar-drag-insertion-dark.png' });
  await page.locator('#theme').dispatchEvent('click');
  await page.screenshot({ path: '.tmp/sidebar-drag-insertion-light.png' });
  await page.locator('#theme').dispatchEvent('click');
  await page.mouse.move(qqBox.x + 60, qqBox.y + qqBox.height / 2);
  await page.evaluate(() => {
    window.feedbackMutations = 0;
    window.feedbackObserver = new MutationObserver(records => { window.feedbackMutations += records.length; });
    window.feedbackObserver.observe(document.getElementById('agent-list'), { subtree: true, attributes: true, attributeFilter: ['class'] });
  });
  await page.mouse.move(qqBox.x + 61, qqBox.y + qqBox.height / 2);
  const sameSlotMutations = await page.evaluate(() => { window.feedbackObserver.disconnect(); return window.feedbackMutations; });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal(rootDuring.height, rootBefore.height, 'arranging instructions must not resize the hit-test area');
  assert.deepEqual(gapFeedback, rowFeedback, 'crossing an item gap must not switch insertion line to folder title');
  assert.deepEqual(selfFeedback, [], 'hovering the dragged item must not offer to append it to its own folder');
  assert.equal(headerEdgeFeedback[0]?.inside, true, 'folder header lower edge stays a folder destination, not a line at the whole folder bottom');
  assert.equal(sameSlotMutations, 0, 'remaining in one slot must not remove and re-add feedback classes');
  console.log('PASS stable drag geometry, gaps, source exclusion and unchanged-slot feedback');

  await app('coder').focus();
  await page.keyboard.press('Space');
  for (let index = 0; index < 10 && await page.locator('.layout-drop-inside').count() === 0; index++) {
    await page.keyboard.press('ArrowDown');
  }
  assert.equal(await page.locator('#prebuilt-group.layout-drop-inside').count(), 1, 'keyboard uses the same whole-folder outline');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.layout-drop-inside').count(), 0, 'cancel removes the whole-folder outline');
  console.log('PASS pointer and keyboard folder destinations outline title and content together');

  // Reproduce a destination containing the current session, not just unselected apps.
  await page.evaluate(() => window.fixtureSelectRuntime('session-demo'));
  const selectedSession = page.locator('.agent-runtime-item.active');
  assert.equal(await selectedSession.count(), 1);
  const selectedBackground = await selectedSession.evaluate(el => getComputedStyle(el).backgroundColor);
  const sourceBox = await app('memo').boundingBox();
  const targetBox = await folder('tool-group').boundingBox();
  await page.mouse.move(sourceBox.x + 60, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.waitForSelector('.layout-arranging');
  await page.mouse.move(targetBox.x + 60, targetBox.y + targetBox.height / 2);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(value => { document.body.dataset.theme = value; }, theme);
    const appearance = await page.locator('#tool-group').evaluate(el => {
      const style = getComputedStyle(el);
      const frame = getComputedStyle(el, '::after');
      const selected = el.querySelector('.agent-runtime-item.active');
      return { background: style.backgroundColor, frameContent: frame.content, frameZ: frame.zIndex,
        framePointerEvents: frame.pointerEvents, frameInset: frame.inset,
        selectedBackground: getComputedStyle(selected).backgroundColor };
    });
    assert.equal(appearance.background, 'rgba(0, 0, 0, 0)', 'folder destination must not tint the selected card surroundings');
    assert.equal(appearance.frameContent, '""', 'folder frame is drawn separately above the cards');
    assert.ok(Number(appearance.frameZ) > 0);
    assert.equal(appearance.framePointerEvents, 'none');
    assert.equal(appearance.frameInset, '0px');
    assert.equal(await selectedSession.count(), 1, 'current session identity remains selected');
    assert.notEqual(appearance.selectedBackground, 'rgba(0, 0, 0, 0)', 'current session keeps its own selection background');
    await page.screenshot({ path: `.tmp/sidebar-drag-selected-${theme}.png` });
  }
  await page.evaluate(() => { document.body.dataset.theme = 'dark'; });
  assert.equal(await selectedSession.evaluate(el => getComputedStyle(el).backgroundColor), selectedBackground);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal(await selectedSession.count(), 1);
  console.log('PASS whole-folder frame and current-session selection coexist in both themes');

  await app('memo').click();
  assert.equal(await page.locator('#navigation').textContent(), 'memo');
  await folder('prebuilt-group').click();
  await waitSaved();
  const firstSavedSettings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  assert.deepEqual(firstSavedSettings.workspaceVisibility, legacySettings.workspaceVisibility);
  assert.deepEqual(firstSavedSettings.resourcePolicy, legacySettings.resourcePolicy);
  const firstSavedLayout = firstSavedSettings.sidebarLayout;
  assert.equal(firstSavedLayout.folders.find(item => item.id === 'prebuilt-group').collapsed, true);
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
  assert.equal(await folder('prebuilt-group').getAttribute('aria-expanded'), 'false');
  await folder('prebuilt-group').click();
  await waitSaved();
  console.log('PASS short click/navigation and collapse survives page reload');

  await drag(app('coder'), folder('prebuilt-group'));
  assert.equal(await page.locator('#prebuilt-agent-list [data-agent-id="coder"]').count(), 1);
  await drag(app('coder'), folder('tool-group'), .5, 8);
  assert.equal(await page.locator('#agent-list > .sidebar-root-app [data-agent-id="coder"]').count(), 1);
  await drag(folder('tool-group'), folder('prebuilt-group'), .05);
  assert.equal(await page.locator('#agent-list > [data-layout-id]').first().getAttribute('id'), 'tool-group');
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
  assert.equal(await page.locator('#agent-list > .sidebar-root-app [data-agent-id="coder"]').count(), 1);
  console.log('PASS pointer cross-folder, top-level, folder reorder and reload');

  const valueBefore = await page.evaluate(() => JSON.parse(window.ClawSidebarLayout.signature()).layout);
  const from = await app('memo').boundingBox();
  await page.mouse.move(from.x + 60, from.y + 15);
  await page.mouse.down();
  await page.waitForFunction(() => document.getElementById('agent-list').classList.contains('layout-arranging'));
  await page.locator('#refresh').dispatchEvent('click');
  assert.equal(await page.locator('.layout-picked').count(), 1);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => JSON.parse(window.ClawSidebarLayout.signature()).layout), valueBefore);
  assert.equal(await page.locator('.layout-arranging').count(), 0);
  console.log('PASS background refresh preserves gesture and Escape cancels without saving');

  await page.request.post(fixture.url.replace('/fixture', '/fixture/fail-save/true'));
  await folder('prebuilt-group').click();
  await waitSaved();
  assert.equal(await folder('prebuilt-group').getAttribute('aria-expanded'), 'true');
  assert.match(await page.locator('#sidebar-layout-status').textContent(), /保存失败/);
  await page.request.post(fixture.url.replace('/fixture', '/fixture/fail-save/false'));
  console.log('PASS failed save visibly rolls back');

  await app('memo').focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await waitSaved();
  assert.equal(await page.locator('#agent-list > .sidebar-root-app [data-agent-id="memo"]').count(), 1);
  console.log('PASS keyboard arranging');

  const second = await browser.newPage();
  await second.goto(fixture.url);
  await second.waitForSelector('body[data-ready="true"]');
  assert.deepEqual(await second.evaluate(() => JSON.parse(window.ClawSidebarLayout.signature()).layout), await page.evaluate(() => JSON.parse(window.ClawSidebarLayout.signature()).layout));
  await second.close();
  console.log('PASS independent browser page reads shared server layout');

  const touchContext = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const touchPage = await touchContext.newPage();
  await touchPage.goto(fixture.url);
  await touchPage.waitForSelector('body[data-ready="true"]');
  const touchSource = await touchPage.locator('[data-layout-handle="app:memo"]').boundingBox();
  const touchTarget = await touchPage.locator('#tool-group > .agent-group-header').boundingBox();
  const cdp = await touchContext.newCDPSession(touchPage);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchSource.x + 60, y: touchSource.y + 15 }] });
  await touchPage.waitForFunction(() => document.getElementById('agent-list').classList.contains('layout-arranging'));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touchTarget.x + 60, y: touchTarget.y + touchTarget.height / 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touchPage.waitForFunction(() => !JSON.parse(window.ClawSidebarLayout.signature()).saving);
  assert.equal(await touchPage.locator('#tool-agent-list [data-agent-id="memo"]').count(), 1);
  await touchContext.close();
  console.log('PASS touch long-press cross-folder drag');

  assert.equal(await page.locator('.agent-runtime-item').getAttribute('draggable'), 'true');
  await page.mouse.move(700, 500);
  await page.screenshot({ path: '.tmp/sidebar-layout-dark.png' });
  await page.locator('#theme').click();
  await page.screenshot({ path: '.tmp/sidebar-layout-light.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.tmp/sidebar-layout-narrow.png' });
  assert.deepEqual(errors, []);
  console.log('PASS dark/light/narrow screenshots and no browser exceptions');
} finally {
  await browser.close();
  await fixture.close();
}
