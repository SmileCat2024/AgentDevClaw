/* global window, document */
// Run explicitly: real Chromium against an isolated fixture (no real user data,
// no real models). Covers the dual-selector + session-move surface end to end
// against the REAL session index and REAL sessions_move route:
//   directory/org selectors, expandable directory submenu, one-click switch,
//   directory-body reset to default chats, new project (default directory),
//   bulk + single session moves (index ownership round-trip), busy 409,
//   error payload, persistence, themes and narrow viewport, screenshots.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startPhProjectFixture } from './ph-project-browser-fixture.mjs';

const SHOT_DIR = path.join(process.cwd(), '.tmp', 'dual-selector-shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const shot = (page, name) => page.screenshot({ path: path.join(SHOT_DIR, name + '.png'), fullPage: false });

const fixture = await startPhProjectFixture();
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));

const listIds = () => page.locator('.ph-session-tabs .feature-project-session-item')
  .evaluateAll(els => els.map(el => el.dataset.prebuiltSessionId));
const dirTrigger = page.locator('.ph-dir-selector .ph-project-dropdown-trigger');
const orgTrigger = page.locator('.ph-org-selector .ph-project-dropdown-trigger');
const openDirMenu = async () => {
  await dirTrigger.click();
  await page.locator('.ph-dir-selector.ph-project-dropdown.open .ph-project-dropdown-menu').waitFor();
};
const openOrgMenu = async () => {
  await orgTrigger.click();
  await page.locator('.ph-org-selector.ph-project-dropdown.open .ph-project-dropdown-menu').waitFor();
};
const closeMenus = async () => {
  await page.locator('body').click({ position: { x: 8, y: 8 } });
  await page.locator('.ph-project-dropdown.open').waitFor({ state: 'detached' });
};
const lastCapturedAction = () => page.evaluate(() => window.__capturedActions.at(-1));
const waitForListIds = async (ids) => page.waitForFunction(
  (expected) => {
    const els = document.querySelectorAll('.ph-session-tabs .feature-project-session-item');
    const got = [...els].map(el => el.dataset.prebuiltSessionId);
    return JSON.stringify(got) === JSON.stringify(expected);
  }, ids);

try {
  await page.goto(fixture.url);
  await page.waitForSelector('body[data-ready="true"]');
  await page.locator('.ph-session-tabs').waitFor();

  // 1) 初始态：目录视图（左=目录 cwd，右=目录对话默认），列表只有目录会话
  assert.equal(await page.locator('.ph-dir-selector .ph-project-header-name').innerText(), 'AgentDevClaw');
  assert.equal(await page.locator('.ph-org-selector .ph-project-header-name').innerText(), '目录对话');
  await assert.deepEqual(await listIds(), ['sess_dir_1']);
  await page.locator('.ph-new-chat-btn').first().click();
  let action = await lastCapturedAction();
  assert.equal(action.openDirectory, fixture.cwd);
  assert.equal(action.projectId, undefined);

  // 2) 右侧归属选择器：置顶新建/管理入口 + 目录对话默认 + 同目录项目（无跨目录组）
  await openOrgMenu();
  const orgEntries = await page.locator('.ph-org-selector .ph-project-dropdown-item, .ph-org-selector .ph-project-dropdown-new')
    .evaluateAll(els => els.map(el => el.textContent.trim().replace(/\s+/g, ' ')));
  assert.ok(orgEntries.some(t => t.includes('新建项目')), 'org menu leads with new project');
  assert.ok(orgEntries.some(t => t.includes('管理项目')), 'org menu offers manage entry');
  assert.ok(orgEntries.some(t => t.includes('目录对话（默认）')), 'org menu lists directory default');
  assert.equal(await page.locator('.ph-org-selector .ph-org-item').count(), 3, 'default + Alpha + Beta only');
  assert.equal(await page.locator('.ph-org-selector .ph-org-item.active').count(), 1);

  // 3) 右侧切项目 Alpha：目录不动，切片按 projectId，动作带项目身份
  await page.locator('.ph-org-selector .ph-org-item[data-project-id="' + fixture.projA.id + '"]').click();
  await page.locator('.ph-org-selector.ph-project-dropdown:not(.open)').waitFor();
  await waitForListIds(['sess_a_1']);
  assert.equal(await page.locator('.ph-org-selector .ph-project-header-name').innerText(), 'Alpha');
  assert.equal(await page.locator('.ph-dir-selector .ph-project-header-name').innerText(), 'AgentDevClaw', 'directory unchanged when switching org');
  assert.match(fixture.captured.sessions.at(-1).url, new RegExp('projectId=' + fixture.projA.id));
  await page.locator('.ph-new-chat-btn').first().click();
  action = await lastCapturedAction();
  assert.equal(action.projectId, fixture.projA.id);

  // 4) 左侧目录选择器：展开子菜单一次切换两者；目录本体点击回默认集合
  await openDirMenu();
  assert.ok((await page.locator('.ph-dir-selector .ph-project-dropdown-new').innerText()).includes('打开目录'), 'open-directory entry on top');
  await page.locator('.ph-dir-selector .ph-dir-expand').first().click();
  await page.locator('.ph-dir-selector .ph-dir-subprojects .ph-dir-sub-default').waitFor();
  const submenuProjects = await page.locator('.ph-dir-selector .ph-dir-subproject-item[data-project-id]').count();
  assert.equal(submenuProjects, 2, 'submenu lists same-directory projects');
  await page.locator('.ph-dir-selector .ph-dir-subproject-item[data-project-id="' + fixture.projB.id + '"]').click();
  await page.locator('.ph-dir-selector.ph-project-dropdown:not(.open)').waitFor();
  await waitForListIds(['sess_b_1']);
  assert.equal(await page.locator('.ph-org-selector .ph-project-header-name').innerText(), 'Beta', 'submenu click switches both selectors');
  await shot(page, '01-dir-submenu-switch-beta');

  // 目录本体点击 → 默认集合（不恢复上次项目）
  await openDirMenu();
  await page.locator('.ph-dir-selector .ph-dir-item.active').click();
  await page.locator('.ph-dir-selector.ph-project-dropdown:not(.open)').waitFor();
  await waitForListIds(['sess_dir_1']);
  assert.equal(await page.locator('.ph-org-selector .ph-project-header-name').innerText(), '目录对话');

  // 4b) 键盘可达：菜单项（div role=menuitem）Tab 序列 + Enter/Space 触发；
  //     展开按钮为原生 button 且 aria-expanded 随折叠态翻转
  await openOrgMenu();
  const alphaItem = page.locator('.ph-org-selector .ph-org-item[data-project-id="' + fixture.projA.id + '"]');
  await alphaItem.focus();
  await page.keyboard.press('Enter');
  await page.locator('.ph-org-selector.ph-project-dropdown:not(.open)').waitFor();
  await waitForListIds(['sess_a_1']);
  assert.equal(await page.locator('.ph-org-selector .ph-project-header-name').innerText(), 'Alpha', 'Enter on org menuitem switches project');
  await openDirMenu();
  const expandBtn = page.locator('.ph-dir-selector .ph-dir-expand').first();
  assert.equal(await expandBtn.getAttribute('aria-expanded'), 'false');
  await expandBtn.focus();
  await page.keyboard.press(' '); // Space 展开目录子菜单
  await page.locator('.ph-dir-selector .ph-dir-subprojects .ph-dir-sub-default').waitFor();
  assert.equal(await expandBtn.getAttribute('aria-expanded'), 'true', 'expand button aria-expanded flips');
  const defaultItem = page.locator('.ph-dir-selector .ph-dir-sub-default');
  await defaultItem.focus();
  await page.keyboard.press('Enter');
  await page.locator('.ph-dir-selector.ph-project-dropdown:not(.open)').waitFor();
  await waitForListIds(['sess_dir_1']);
  assert.equal(await page.locator('.ph-org-selector .ph-project-header-name').innerText(), '目录对话', 'Enter on submenu default item returns to directory chats');

  // 5) 新建项目：默认当前目录；创建后两选择器同步、动作带新 projectId
  await page.waitForTimeout(300); // 目录切换重渲染落定后再开菜单
  await openOrgMenu();
  await page.locator('.ph-org-selector .ph-project-dropdown-new', { hasText: '新建项目' }).click();
  await page.locator('.ph-new-project-window').waitFor();
  assert.ok((await page.locator('.ph-new-project-window').innerText()).includes(fixture.cwd), 'current directory preselected');
  await page.locator('#ph-new-project-name').fill('ManagedProj');
  await page.locator('.ph-new-project-window button[type="submit"]').click();
  await page.locator('.ph-new-project-window').waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelector('.ph-org-selector .ph-project-header-name')?.textContent === 'ManagedProj');
  await page.locator('.feature-project-empty-note').first().waitFor();
  assert.equal(await page.locator('.ph-dir-selector .ph-project-header-name').innerText(), 'AgentDevClaw', 'creation keeps current directory');
  await page.locator('.ph-new-chat-btn').first().click();
  action = await lastCapturedAction();
  assert.match(action.projectId, /^prj_/);
  const stored = await page.evaluate(() => localStorage.getItem('protoclaw:ph-browsing-target:programming-helper'));
  assert.equal(JSON.parse(stored).id, action.projectId, 'typed target persisted for created project');

  // 6) 批量移动：目录会话 sess_dir_1 → Beta（真实 sessions_move + 真实索引）
  await openOrgMenu();
  await page.locator('.ph-org-selector .ph-org-directory').click();
  await waitForListIds(['sess_dir_1']);
  await page.locator('.ph-select-toggle-btn').click();
  await page.locator('.ph-session-select input[data-select-session-id="sess_dir_1"]').check();
  await shot(page, '02-bulk-select-mode');
  await page.locator('.ph-select-move-btn').click();
  await page.locator('.ph-move-window').waitFor();
  const moveText = await page.locator('.ph-move-window').innerText();
  assert.ok(moveText.includes('目录对话（默认）'), 'directory default is a target');
  assert.ok(moveText.includes('Alpha') && moveText.includes('Beta'), 'same-directory projects are targets');
  assert.ok(moveText.includes('跨目录'), 'cross-directory unsupported copy is shown');
  assert.ok(await page.locator('.ph-move-target-item.disabled input[type="radio"][value="0"]').isDisabled(),
    'current ownership (directory default) disabled');
  await page.locator('.ph-move-window input[type="radio"][value="' + (await page.locator('.ph-move-target-item input[type="radio"]').evaluateAll(
    radios => String(radios.findIndex(r => !r.disabled && r.closest('.ph-move-target-item').textContent.includes('Beta'))))) + '"]').check();
  await shot(page, '03-move-dialog');
  await page.locator('.ph-move-window button[type="submit"]').click();
  await page.locator('.ph-move-window').waitFor({ state: 'detached' });
  await waitForListIds([]);
  // 真实索引验证：归属已改写为 Beta
  let index = await fixture.readIndex();
  let moved = (index.sessions || []).find(s => s.id === 'sess_dir_1');
  assert.equal(moved.projectId, fixture.projB.id, 'real index ownership rewritten to Beta');
  const normDir = (dir) => String(dir || '').replaceAll(String.fromCharCode(92), '/').toLowerCase();
  assert.equal(normDir(moved.openDirectory), normDir(fixture.cwd), 'moved record retains the same working directory');
  // 目标视图能看到它（updatedAt 降序：B1 在前）
  await openOrgMenu();
  await page.locator('.ph-org-selector .ph-org-item[data-project-id="' + fixture.projB.id + '"]').click();
  await waitForListIds(['sess_b_1', 'sess_dir_1']);
  await shot(page, '04-after-bulk-move-beta');

  // 7) 单条移动：sess_dir_1（现属 Beta）→ 目录对话（默认）
  await page.evaluate(() => window.phOpenSessionMoveDialog(['sess_dir_1']));
  await page.locator('.ph-move-window').waitFor();
  // 当前归属 Beta → 默认目录是有效目标（value 0）
  await page.locator('.ph-move-window input[type="radio"][value="0"]').check();
  await page.locator('.ph-move-window button[type="submit"]').click();
  await page.locator('.ph-move-window').waitFor({ state: 'detached' });
  index = await fixture.readIndex();
  moved = (index.sessions || []).find(s => s.id === 'sess_dir_1');
  assert.ok(!moved.projectId, 'single move back to directory ownership');

  // 8) busy 409：执行中轮次拒绝且索引零变化
  fixture.setBusy('sess_dir_1');
  await openOrgMenu();
  await page.locator('.ph-org-selector .ph-org-directory').click();
  await waitForListIds(['sess_dir_1']);
  await page.locator('.ph-select-toggle-btn').click();
  await page.locator('.ph-session-select input[data-select-session-id="sess_dir_1"]').check();
  await page.locator('.ph-select-move-btn').click();
  await page.locator('.ph-move-window').waitFor();
  await page.locator('.ph-move-window input[type="radio"]:not([disabled])').first().check();
  await page.locator('.ph-move-window button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('.ph-move-window .ph-move-error')?.hidden);
  const busyText = await page.locator('.ph-move-error').innerText();
  assert.ok(busyText.includes('正在执行') && busyText.includes('未做任何改动'), 'readable busy message, no fake success');
  await shot(page, '05-busy-409');
  index = await fixture.readIndex();
  moved = (index.sessions || []).find(s => s.id === 'sess_dir_1');
  assert.ok(!moved.projectId, 'index untouched on busy rejection');
  await page.locator('.ph-move-window .ph-move-cancel').first().click();
  fixture.clearBusy();

  // 9) 服务端错误契约（浏览器内直接发）：unknown session → 404 + payload.error
  //（target 用真实项目：Invalid projectId 400 在 session 校验之前，测不到 404）
  const errorPayload = await page.evaluate(async (projectId) => {
    const res = await fetch('/protoclaw/ph_project/sessions_move', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'programming-helper', sessionIds: ['ghost'], target: { type: 'project', id: projectId } }),
    });
    return { status: res.status, body: await res.json() };
  }, fixture.projA.id);
  assert.equal(errorPayload.status, 404);
  assert.ok(errorPayload.body.error, 'payload.error present');

  // 10) 搜索归属 + 持久化（重载后仍在新项目）
  await openOrgMenu();
  await page.locator('.ph-org-selector .ph-org-item[data-project-id="' + fixture.projA.id + '"]').click();
  await waitForListIds(['sess_a_1']);
  await page.locator('.ph-search-input').fill('needle');
  await page.waitForFunction(() => window.ClawFW?.phSearch?.loading === false && (window.ClawFW?.phSearch?.results?.length || 0) > 0);
  assert.match(fixture.captured.search.at(-1).url, /projectId=prj_/);
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
  await page.waitForFunction(() => document.querySelector('.ph-org-selector .ph-project-header-name')?.textContent === 'Alpha');

  // 11) 深浅主题 × 宽窄视口：两选择器菜单不出视口，控制不溢出
  for (const theme of ['dark', 'light']) {
    await page.locator('body').evaluate((body, value) => { body.dataset.theme = value; }, theme);
    for (const [width, height] of [[1280, 800], [375, 667]]) {
      await page.setViewportSize({ width, height });
      for (const open of [openDirMenu, openOrgMenu]) {
        await open();
        const menuBox = await page.locator('.ph-project-dropdown.open .ph-project-dropdown-menu').boundingBox();
        assert.ok(menuBox && menuBox.x >= 0 && menuBox.x + menuBox.width <= width + 1,
          `${theme} ${width}: dropdown menu within viewport (got ${JSON.stringify(menuBox)})`);
        await closeMenus();
      }
      assert.equal(await page.locator('.ph-new-chat-btn').first().isVisible(), true, `${theme} ${width}: new chat visible`);
      const barOverflow = await page.evaluate(() => {
        const bar = document.querySelector('.ph-project-bar');
        return bar ? bar.getBoundingClientRect().right - document.documentElement.clientWidth : 0;
      });
      assert.ok(barOverflow <= 1, `${theme} ${width}: project bar within viewport (got ${barOverflow})`);
      await shot(page, `06-${theme}-${width}`);
    }
  }
  assert.deepEqual(errors, [], 'no page errors');
  console.log('PASS ph-project-browser-check: dual selectors, expand submenu, one-click switch, directory reset, managed creation default dir, bulk/single real-index moves, busy 409, error payload, persistence, themes/viewport; screenshots in ' + SHOT_DIR);
} catch (error) {
  console.error('FAIL ph-project-browser-check:', error?.message);
  console.error('page errors so far:', errors);
  console.error('captured actions:', fixture.captured.actions.map(a => JSON.stringify(a)).slice(-5));
  throw error;
} finally {
  await browser.close();
  await fixture.close();
}
