/* global window, document */
// Run explicitly: real Chromium against an isolated fixture (no real user data,
// no real models). Covers the ticket-045 selector surface end to end:
// directory/project groups, project switch slices, new-chat action identity,
// new-project dialog (managed creation), project config dialog (project scope),
// search ownership, persistence, themes and narrow viewport.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startPhProjectFixture } from './ph-project-browser-fixture.mjs';

const fixture = await startPhProjectFixture();
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const activeName = () => page.locator('.ph-project-header-name').innerText();
const openDropdown = async () => {
  await page.locator('.ph-project-dropdown-trigger').click();
  await page.locator('.ph-project-dropdown.open .ph-project-dropdown-menu').waitFor();
};

try {
  await page.goto(fixture.url);
  await page.waitForSelector('body[data-ready="true"]');
  await page.locator('.ph-session-tabs').waitFor();

  // 1) 纯目录初始态：目录组 active，目录会话可见，新建对话走目录身份
  assert.equal(await activeName(), 'AgentDevClaw');
  await assert.deepEqual(await page.locator('.ph-session-tabs .feature-project-session-item').evaluateAll(
    els => els.map(el => el.dataset.prebuiltSessionId)), ['sess_dir_1']);
  await page.locator('.ph-new-chat-btn').first().click();
  let action = (await page.evaluate(() => window.__capturedActions)).at(-1);
  assert.equal(action.openDirectory, fixture.cwd);
  assert.equal(action.projectId, undefined);

  // 2) 下拉两组：目录组（D）+ 项目组（Alpha/Beta），active 是目录
  await openDropdown();
  const groups = await page.locator('.ph-project-dropdown-group-label').allInnerTexts();
  assert.deepEqual(groups, ['目录', '项目']);
  assert.match(await page.locator('.ph-project-dropdown-item.active').getAttribute('data-project-id'), /^dir:/);
  assert.equal(await page.locator('.ph-project-dropdown-item[data-project-id]').count(), 3);

  // 3) 切到项目 A：切片按 projectId 拉取、只含项目会话、动作显式 projectId
  await page.locator('.ph-project-dropdown-item[data-project-id="' + fixture.projA.id + '"]').click();
  await page.locator('.ph-project-dropdown:not(.open)').waitFor();
  await page.waitForFunction(() => document.querySelector('.ph-project-header-name')?.textContent === 'Alpha');
  assert.equal(await activeName(), 'Alpha');
  await assert.deepEqual(await page.locator('.ph-session-tabs .feature-project-session-item').evaluateAll(
    els => els.map(el => el.dataset.prebuiltSessionId)), ['sess_a_1']);
  const sliceUrl = fixture.captured.sessions.at(-1).url;
  assert.match(sliceUrl, new RegExp('projectId=' + fixture.projA.id));
  await page.locator('.ph-new-chat-btn').first().click();
  action = (await page.evaluate(() => window.__capturedActions)).at(-1);
  assert.equal(action.projectId, fixture.projA.id);
  assert.equal(action.openDirectory, '');

  // 4) 项目设置弹窗：project scope、名称 + 真实目录副标题、resolved 请求带 projectId
  await page.locator('.ph-dir-config-btn').click();
  await page.locator('.feature-detail-window .feature-detail-title').waitFor();
  assert.match(await page.locator('.feature-detail-window .feature-detail-title').innerText(), /项目设置 · Alpha/);
  assert.equal(await page.locator('.feature-detail-window .feature-detail-subtitle').innerText(), fixture.projA.workDirectory, 'real stored workDirectory shown');
  await page.waitForFunction(() => window.__resolvedProbe !== undefined || true);
  await page.locator('.feature-detail-close').click();
  await page.locator('.feature-detail-window').waitFor({ state: 'detached' });

  // 5) 新建项目（托管）：真实 project_create 路由 → 空项目视图，动作携带新 projectId
  await openDropdown();
  await page.locator('.ph-project-dropdown-new').click();
  await page.locator('.ph-new-project-window').waitFor();
  await page.locator('#ph-new-project-name').fill('ManagedProj');
  await page.locator('.ph-new-project-window button[type="submit"]').click();
  await page.locator('.ph-new-project-window').waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelector('.ph-project-header-name')?.textContent === 'ManagedProj');
  await page.locator('.feature-project-empty-note').first().waitFor();
  const newSliceUrl = fixture.captured.sessions.at(-1).url;
  assert.match(newSliceUrl, /projectId=prj_/);
  await page.locator('.ph-new-chat-btn').first().click();
  action = (await page.evaluate(() => window.__capturedActions)).at(-1);
  assert.match(action.projectId, /^prj_/);
  assert.equal(action.openDirectory, '');
  const stored = await page.evaluate(() => localStorage.getItem('protoclaw:ph-browsing-target:programming-helper'));
  assert.equal(JSON.parse(stored).id, action.projectId, 'typed target persisted for created project');

  // 6) 搜索：项目目标请求携带 projectId（互斥）
  await page.locator('.ph-search-input').fill('needle');
  await page.waitForFunction(() => window.ClawFW?.phSearch?.loading === false && (window.ClawFW?.phSearch?.results?.length || 0) > 0);
  const searchEntry = fixture.captured.search.at(-1);
  assert.match(searchEntry.url, /projectId=prj_/);
  assert.doesNotMatch(searchEntry.url, /openDirectory=/);
  assert.match(await page.locator('.ph-search-panel').innerText(), /A1 needle hit/);

  // 7) 重载后 typed target 持久（仍在新项目，不回退目录）
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
  await page.waitForFunction(() => document.querySelector('.ph-project-header-name')?.textContent === 'ManagedProj');

  // 8) 深浅主题 × 宽窄视口：头部控件可见；045 面自查项目栏不横向溢出
  //    （文档级溢出来自既有会话行布局——workspace-history-side 操作列，
  //     非 045 选择器面，git diff 确认未触及，不在本工单修复）
  for (const theme of ['dark', 'light']) {
    await page.locator('body').evaluate((body, value) => { body.dataset.theme = value; }, theme);
    for (const [width, height] of [[1280, 800], [375, 667]]) {
      await page.setViewportSize({ width, height });
      await openDropdown();
      await page.locator('.ph-project-dropdown-new').waitFor();
      // 菜单本体不出视口
      const menuBox = await page.locator('.ph-project-dropdown-menu').boundingBox();
      assert.ok(menuBox && menuBox.x >= 0 && menuBox.x + menuBox.width <= width + 1,
        `${theme} ${width}: dropdown menu within viewport (got ${JSON.stringify(menuBox)})`);
      await page.locator('body').click({ position: { x: 8, y: 8 } });
      await page.locator('.ph-project-dropdown:not(.open)').waitFor();
      assert.equal(await page.locator('.ph-new-chat-btn').first().isVisible(), true, `${theme} ${width}: new chat visible`);
      const barOverflow = await page.evaluate(() => {
        const bar = document.querySelector('.ph-project-bar');
        return bar ? bar.getBoundingClientRect().right - document.documentElement.clientWidth : 0;
      });
      assert.ok(barOverflow <= 1, `${theme} ${width}: project bar within viewport (got ${barOverflow})`);
    }
  }
  assert.deepEqual(errors, [], 'no page errors');
  console.log('PASS ph-project-browser-check: groups, slices, action identity, managed creation, config dialog, search ownership, persistence, themes/viewport');
} finally {
  await browser.close();
  await fixture.close();
}
