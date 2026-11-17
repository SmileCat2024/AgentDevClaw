/* global window, document */
// Run explicitly: real Chromium against an isolated fixture (no real user data,
// no real models). Covers the dual-selector + session-move surface end to end
// against the REAL session index and REAL sessions_move route:
//   directory/org selectors, expandable directory submenu, one-click switch,
//   directory-body reset to default chats, ownership menu actions (add / edit
//   projects) and inline per-project settings gears, `+` opening the new-project
//   dialog directly (the retired `.ph-quick-menu` is gone), new project (default
//   directory), bulk + single session moves (index ownership round-trip), busy
//   409, error payload, search attribution, persistence, themes and narrow
//   viewport, screenshots.
// Search state is asserted through the visible panel DOM and the real ESM
// module (`_phSearch`) imported at the same URL — `window.ClawFW.phSearch` was
// privatized and is intentionally not restored for tests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startPhProjectFixture } from './ph-project-browser-fixture.mjs';

const SHOT_DIR = path.join(process.cwd(), '.tmp', 'dual-selector-shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const shot = (page, name) => page.screenshot({ path: path.join(SHOT_DIR, name + '.png'), fullPage: false });

let fixture = null;
let browser = null;
const errors = [];

try {
  // 资源获取必须在 try 内：fixture 已起、browser/newPage 任一失败时，
  // finally 按实际获取到的资源回收，不泄漏端口/临时数据目录/浏览器进程。
  fixture = await startPhProjectFixture();
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {});
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));

  const listIds = () => page.locator('.ph-session-tabs .feature-project-session-item')
    .evaluateAll(els => els.map(el => el.dataset.prebuiltSessionId));
  const dirTrigger = page.locator('.ph-dir-selector > .ph-project-dropdown-trigger');
  const orgTrigger = page.locator('.ph-org-selector .ph-org-pill-trigger');
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
  // 响应式前置态：生产 app-ui 在 ≤860px 把侧栏切成浮层抽屉并自动收起；
  // fixture 复用了真实外壳但有意不装 app-ui 全应用 bootstrap，所以窄视口下
  // 抽屉会盖住主内容并拦截指针。这里按同一响应式不变量收/放抽屉——只切布局
  // 前置态，不涉及任何业务结果。每个视口当作独立布局态（宽屏恢复展开）。
  const syncNarrowDrawer = (width) => page.evaluate((narrow) => {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    sidebar.classList.toggle('collapsed', narrow);
  }, width <= 860);
  // fixture 自己的动作捕获数组（fixture-owned 观察面），不是业务 / ESM 桥。
  const lastCapturedAction = () => page.evaluate(() => window.__capturedActions.at(-1));
  // 搜索状态真实来源：ph-session-list 的 `_phSearch` 命名导出（同一模块 URL 的
  // dynamic import 命中的是页面已装载的同一实例）。旧 `window.ClawFW.phSearch`
  // 已随 ESM 化私有化，不恢复全局来迁就测试。
  const readSearchModuleState = () => page.evaluate(async () => {
    const mod = await import('/src/modules/ph-session-list.js');
    return { loading: mod._phSearch.loading, total: mod._phSearch.total, results: mod._phSearch.results.map(r => r.sessionId) };
  });
  const waitForListIds = async (ids) => page.waitForFunction(
    (expected) => {
      const els = document.querySelectorAll('.ph-session-tabs .feature-project-session-item');
      const got = [...els].map(el => el.dataset.prebuiltSessionId);
      return JSON.stringify(got) === JSON.stringify(expected);
    }, ids);

  await page.goto(fixture.url);
  await page.waitForSelector('body[data-ready="true"]');
  await page.locator('.ph-session-tabs').waitFor();

  // 1) 初始态：目录视图。目录选择器=大字目录名（主形态），归属胶囊=「默认项目」
  assert.equal(await page.locator('.ph-dir-selector > .ph-project-dropdown-trigger .ph-project-header-name').innerText(), 'AgentDevClaw');
  assert.ok((await page.locator('.ph-dir-selector > .ph-project-dropdown-trigger .ph-selector-path').innerText()).includes(fixture.cwd.split('/').pop()), 'directory path shown small under the name');
  assert.equal(await page.locator('.ph-org-selector .ph-org-pill-label').innerText(), '默认项目');
  assert.equal(await page.locator('.ph-quick-add-btn').count(), 1, 'quick-add button always visible');
  await assert.deepEqual(await listIds(), ['sess_dir_1']);
  await page.locator('.ph-new-chat-btn').first().click();
  let action = await lastCapturedAction();
  assert.equal(action.openDirectory, fixture.cwd);
  assert.equal(action.projectId, undefined);

  // 2) 归属胶囊菜单：顶部「添加项目 / 编辑项目」动作 + 每行行内项目设置齿轮；
  //    项目选择仍只在此菜单（旧快速菜单已退役，见下）。
  await openOrgMenu();
  const orgEntries = await page.locator('.ph-org-selector .ph-project-dropdown-item')
    .evaluateAll(els => els.map(el => el.textContent.trim().replace(/\s+/g, ' ')));
  const orgActionLabels = await page.locator('.ph-org-selector .ph-org-action .ph-open-dir-label')
    .evaluateAll(els => els.map(el => el.textContent.trim()));
  assert.deepEqual(orgActionLabels, ['添加项目', '编辑项目'], 'org menu hosts add/edit project actions');
  assert.equal(await page.locator('.ph-org-selector .ph-org-action[data-action="sessions.newProjectDialog"]').count(), 1, 'add-project action is wired');
  assert.equal(await page.locator('.ph-org-selector .ph-org-action[data-action="sessions.manageProjects"]').count(), 1, 'edit-projects action is wired');
  assert.ok(orgEntries.some(t => t.includes('默认项目')), 'org menu lists directory default');
  assert.equal(await page.locator('.ph-org-selector .ph-org-item').count(), 3, 'default + Alpha + Beta only');
  assert.equal(await page.locator('.ph-org-selector .ph-org-item.active').count(), 1);
  assert.equal(await page.locator('.ph-org-selector .ph-org-item .ph-org-item-config').count(), 3,
    'every ownership row exposes an inline project-settings gear');
  await closeMenus();

  // + 按钮直达新建项目弹窗：旧 `.ph-quick-menu` 于 2026-10-24 退役，不是
  // 本轮 ESM 行为变化。当前契约是单击即开弹窗，不展开下拉。
  await page.locator('.ph-quick-add-btn').click();
  await page.locator('.ph-new-project-window').waitFor();
  assert.equal(await page.locator('.ph-quick-menu').count(), 0, 'legacy quick menu no longer exists');
  assert.equal(await page.locator('.ph-project-dropdown.open').count(), 0, '+ opens the dialog directly instead of a dropdown');
  assert.ok((await page.locator('.ph-new-project-window .feature-detail-title').innerText()).includes('新建项目'), 'add button opens the new-project dialog');
  await page.locator('.ph-new-project-window .ph-new-project-cancel').first().click();
  await page.locator('.ph-new-project-window').waitFor({ state: 'detached' });

  // 3) 胶囊切项目 Alpha：目录不动，切片按 projectId，动作带项目身份
  await openOrgMenu();
  await page.locator('.ph-org-selector .ph-org-item[data-project-id="' + fixture.projA.id + '"]').click();
  await page.locator('.ph-org-selector.ph-project-dropdown:not(.open)').waitFor();
  await waitForListIds(['sess_a_1']);
  assert.equal(await page.locator('.ph-org-selector .ph-org-pill-label').innerText(), 'Alpha');
  assert.equal(await page.locator('.ph-dir-selector > .ph-project-dropdown-trigger .ph-project-header-name').innerText(), 'AgentDevClaw', 'directory unchanged when switching org');
  assert.match(fixture.captured.sessions.at(-1).url, new RegExp('projectId=' + fixture.projA.id));
  await page.locator('.ph-new-chat-btn').first().click();
  action = await lastCapturedAction();
  assert.equal(action.projectId, fixture.projA.id);
  // 项目目标：归属菜单该行的行内齿轮直达「项目设置 · Alpha」（原快速菜单设置项）
  await openOrgMenu();
  await page.locator('.ph-org-selector .ph-org-item[data-project-id="' + fixture.projA.id + '"] .ph-org-item-config').click();
  await page.locator('.ph-settings-window').waitFor();
  let settingsTitle = await page.locator('.ph-settings-window .feature-detail-title').innerText();
  assert.ok(settingsTitle.includes('项目设置') && settingsTitle.includes('Alpha'), 'inline gear opens project settings for that project');
  await page.locator('.ph-settings-window .feature-detail-close').click();
  await page.locator('.ph-settings-window').waitFor({ state: 'detached' });
  // 默认项目行的齿轮打开目录层设置（原快速菜单「目录设置」入口）
  await openOrgMenu();
  await page.locator('.ph-org-selector .ph-org-item.ph-org-directory .ph-org-item-config').click();
  await page.locator('.ph-settings-window').waitFor();
  settingsTitle = await page.locator('.ph-settings-window .feature-detail-title').innerText();
  assert.ok(settingsTitle.includes('项目设置') && settingsTitle.includes('默认项目'), 'default-project gear opens the directory-layer project settings');
  await page.locator('.ph-settings-window .feature-detail-close').click();
  await page.locator('.ph-settings-window').waitFor({ state: 'detached' });
  // 「编辑项目」菜单动作 → 管理项目弹窗（归档 / 改绑入口）
  await openOrgMenu();
  await page.locator('.ph-org-selector .ph-org-action[data-action="sessions.manageProjects"]').click();
  await page.locator('.ph-manage-projects-window').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.ph-manage-projects-window .ph-manage-project-row').length >= 2);
  const manageText = await page.locator('.ph-manage-projects-window').innerText();
  assert.ok(manageText.includes('管理项目') && manageText.includes('Alpha') && manageText.includes('Beta'), 'edit-projects entry lists real projects');
  await page.locator('.ph-manage-projects-window .ph-manage-projects-cancel').first().click();
  await page.locator('.ph-manage-projects-window').waitFor({ state: 'detached' });

  // 4) 悬停目录行即在右侧打开项目面板；无箭头按钮，目录行仍可点击回默认集合。
  //    无项目的目录同样展开（面板仅含默认项目），悬停切换时旧面板收起。
  await openDirMenu();
  assert.equal(await page.locator('.ph-dir-selector .ph-project-dropdown-menu > .ph-open-dir-entry').count(), 1, 'open-directory entry sits on top of the directory menu');
  assert.ok((await page.locator('.ph-dir-selector .ph-open-dir-entry .ph-open-dir-label').innerText()).includes('打开目录'), 'open-directory entry label');
  // 滚动条隐藏契约落在目录选项区（菜单容器给动作区留固定位置，仅选项区自滚）
  const scrollHidden = await page.evaluate(() => {
    const options = document.querySelector('.ph-dir-selector .ph-dir-menu-options');
    return options ? window.getComputedStyle(options).scrollbarWidth : '';
  });
  assert.equal(scrollHidden, 'none', 'directory options area hides its scrollbar');
  const directoryRow = page.locator('.ph-dir-selector .ph-dir-item[data-dir-id="dir:' + fixture.cwd.toLowerCase() + '"]');
  // 当前契约：目录行自己声明 menu popup，悬停/聚焦展开面板；没有独立展开箭头控件
  assert.equal(await page.locator('.ph-dir-selector .ph-dir-item[aria-haspopup="menu"]').count(),
    await page.locator('.ph-dir-selector .ph-dir-item').count(), 'directory rows declare the hover-opened project panel');
  assert.equal(await page.locator('.ph-dir-expand').count(), 0, 'no explicit expand-arrow control');
  await directoryRow.hover();
  const floatingSubmenu = page.locator('body > .ph-dir-subprojects.open');
  await floatingSubmenu.waitFor();
  const mainMenuBox = await page.locator('.ph-dir-selector .ph-project-dropdown-menu').boundingBox();
  let submenuBox = await floatingSubmenu.boundingBox();
  assert.equal(Math.round(submenuBox.x), Math.round(mainMenuBox.x + mainMenuBox.width - 1), 'panels meet edge-to-edge without a gap');
  assert.ok(submenuBox.y >= 0 && submenuBox.y + submenuBox.height <= 667, 'floating submenu stays within viewport');
  let submenuProjects = await floatingSubmenu.locator('.ph-dir-subproject-item[data-project-id]').count();
  assert.equal(submenuProjects, 2, 'submenu lists same-directory projects');
  await shot(page, '01a-directory-project-submenu-open');
  // 悬停到无项目的 plain 目录：面板切换（旧面板收起），内容仅默认项目
  const plainRow = page.locator('.ph-dir-selector .ph-dir-item[data-dir-id="dir:' + fixture.plainDir.toLowerCase() + '"]');
  await plainRow.hover();
  await page.waitForFunction(() => {
    const open = document.querySelector('body > .ph-dir-subprojects.open');
    return open && open.querySelectorAll('.ph-dir-subproject-item[data-project-id]').length === 0;
  });
  assert.equal(await page.locator('body > .ph-dir-subprojects.open').count(), 1, 'previous panel collapsed, exactly one open');
  const plainPanelText = await page.locator('body > .ph-dir-subprojects.open').innerText();
  assert.ok(plainPanelText.includes('默认项目'), 'project-less dir panel offers directory default');
  await shot(page, '01b-plain-dir-submenu-default-only');
  // 悬停回含项目目录 → 面板切回（2 个项目）
  await directoryRow.hover();
  await page.waitForFunction(() => {
    const open = document.querySelector('body > .ph-dir-subprojects.open');
    return open && open.querySelectorAll('.ph-dir-subproject-item[data-project-id]').length === 2;
  });
  await page.locator('body > .ph-dir-subprojects.open .ph-dir-subproject-item[data-project-id="' + fixture.projB.id + '"]').click();
  await page.locator('.ph-dir-selector.ph-project-dropdown:not(.open)').waitFor();
  await waitForListIds(['sess_b_1']);
  assert.equal(await page.locator('.ph-org-selector .ph-org-pill-label').innerText(), 'Beta', 'submenu click switches both selectors');
  await shot(page, '01-dir-submenu-switch-beta');

  // 目录本体点击 → 默认集合（不恢复上次项目）
  await openDirMenu();
  await page.locator('.ph-dir-selector .ph-dir-item.active').click();
  await page.locator('.ph-dir-selector.ph-project-dropdown:not(.open)').waitFor();
  await waitForListIds(['sess_dir_1']);
  assert.equal(await page.locator('.ph-org-selector .ph-org-pill-label').innerText(), '默认项目');

  // 4b) 键盘可达：菜单项（div role=menuitem）Enter/Space 触发；
  //     聚焦目录行即展开右侧项目面板（focusin 契约，无独立展开按钮）
  await openOrgMenu();
  const alphaItem = page.locator('.ph-org-selector .ph-org-item[data-project-id="' + fixture.projA.id + '"]');
  await alphaItem.focus();
  await page.keyboard.press('Enter');
  await page.locator('.ph-org-selector.ph-project-dropdown:not(.open)').waitFor();
  await waitForListIds(['sess_a_1']);
  assert.equal(await page.locator('.ph-org-selector .ph-org-pill-label').innerText(), 'Alpha', 'Enter on org menuitem switches project');
  await page.waitForFunction(() => document.querySelectorAll('.ph-dir-selector .ph-dir-item').length > 0);
  await openDirMenu();
  const firstDirectory = page.locator('.ph-dir-selector .ph-dir-item').first();
  await firstDirectory.focus();
  await page.locator('body > .ph-dir-subprojects.open .ph-dir-sub-default').waitFor();
  assert.equal(await firstDirectory.getAttribute('aria-expanded'), 'true', 'focusing a directory row expands its submenu');
  const defaultItem = page.locator('body > .ph-dir-subprojects.open .ph-dir-sub-default');
  await defaultItem.focus();
  await page.keyboard.press('Enter');
  await page.locator('.ph-dir-selector.ph-project-dropdown:not(.open)').waitFor();
  await waitForListIds(['sess_dir_1']);
  assert.equal(await page.locator('.ph-org-selector .ph-org-pill-label').innerText(), '默认项目', 'Enter on submenu default item returns to directory chats');

  // 5) 新建项目（+ 直达弹窗）：默认当前目录；创建后两选择器同步、动作带新 projectId
  // 目录切换的完成条件：列表已换成目录切片、胶囊已回默认、下拉已收起。
  // 不靠固定超时拖时序；按钮在重渲染中被替换时由 Playwright actionability 重试。
  await page.locator('.ph-project-dropdown.open').waitFor({ state: 'detached' });
  await page.locator('.ph-quick-add-btn').waitFor({ state: 'visible' });
  await page.locator('.ph-quick-add-btn').click();
  await page.locator('.ph-new-project-window').waitFor();
  assert.ok((await page.locator('.ph-new-project-window').innerText()).includes(fixture.cwd), 'current directory preselected');
  await page.locator('#ph-new-project-name').fill('ManagedProj');
  await page.locator('.ph-new-project-window button[type="submit"]').click();
  await page.locator('.ph-new-project-window').waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelector('.ph-org-selector .ph-org-pill-label')?.textContent === 'ManagedProj');
  // 空项目可见：当前空态是会话空态卡（旧 .feature-project-empty-note 只在非分页列表分支）
  await page.locator('.ph-sessions-empty-card').first().waitFor();
  assert.ok((await page.locator('.ph-sessions-empty-card').first().innerText()).includes('还没有对话'), 'created project shows the empty-chat card');
  assert.equal(await page.locator('.ph-dir-selector > .ph-project-dropdown-trigger .ph-project-header-name').innerText(), 'AgentDevClaw', 'creation keeps current directory');
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
  assert.ok(moveText.includes('默认项目'), 'directory default is a target');
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

  // 7) 单条移动：sess_dir_1（现属 Beta）→ 默认项目
  // 入口走真实公开 ESM 导出：同 URL 的 dynamic import 命中页面已装载的同一
  // 模块实例（ph-session-move.js 在 fixture 里以静态 ESM 装载）。
  // 原 `window.phOpenSessionMoveDialog` 桥正按消费面撤除，不恢复全局迁就测试。
  await page.evaluate(async () => {
    const mod = await import('/src/modules/ph-session-move.js');
    await mod.phOpenSessionMoveDialog(['sess_dir_1']);
  });
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
  // 可见 DOM 是主证据：搜索面板渲染真实结果行与总数文案
  await page.locator('.ph-search-panel .ph-search-result-item').first().waitFor();
  assert.equal(await page.locator('.ph-search-panel .ph-search-result-item').count(), 1, 'one rendered search result');
  assert.ok((await page.locator('.ph-search-panel .ph-search-status').first().innerText()).includes('共 1 个结果'), 'search panel reports the real total');
  // 状态取真实 ESM 导出（同一 URL 的模块实例），不恢复已私有化的全局
  const searchState = await readSearchModuleState();
  assert.equal(searchState.loading, false, 'search state settled');
  assert.deepEqual(searchState.results, ['sess_a_1'], 'module state matches the rendered result');
  assert.equal(searchState.total, 1);
  assert.match(fixture.captured.search.at(-1).url, /projectId=prj_/);
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
  await page.waitForFunction(() => document.querySelector('.ph-org-selector .ph-org-pill-label')?.textContent === 'Alpha');

  // 11) 深浅主题 × 宽窄视口：两选择器菜单不出视口，控制不溢出
  for (const theme of ['dark', 'light']) {
    await page.locator('body').evaluate((body, value) => { body.dataset.theme = value; }, theme);
    for (const [width, height] of [[1280, 800], [375, 667]]) {
      await page.setViewportSize({ width, height });
      await syncNarrowDrawer(width);
      for (const open of [openDirMenu, openOrgMenu]) {
        await open();
        const menuBox = await page.locator('.ph-project-dropdown.open .ph-project-dropdown-menu').first().boundingBox();
        assert.ok(menuBox && menuBox.x >= 0 && menuBox.x + menuBox.width <= width + 1,
          `${theme} ${width}: dropdown menu within viewport (got ${JSON.stringify(menuBox)})`);
        if (open === openDirMenu) {
          const desktop = width > 640;
          if (desktop) {
            // 桌面：悬停目录行即在右侧展开面板
            await page.locator('.ph-dir-selector .ph-dir-item').first().hover();
          } else {
            // 窄屏：抽屉菜单占满容器宽，悬停展开的浮层面板会盖住菜单行本身，
            // 指针停在行上会被面板真实遮挡（不是测试桩问题）。改用同一模块
            // 的 focusin 展开契约（步骤 4b 已覆盖其键盘语义），不靠坐标绕开遮挡。
            await page.locator('.ph-dir-selector .ph-dir-item').first().focus();
          }
          const submenu = page.locator('body > .ph-dir-subprojects.open');
          await submenu.waitFor();
          const submenuBox = await submenu.boundingBox();
          assert.ok(submenuBox && submenuBox.x >= 0 && submenuBox.x + submenuBox.width <= width + 1,
            `${theme} ${width}: separate submenu within viewport (got ${JSON.stringify(submenuBox)})`);
          assert.ok(submenuBox.y >= 0 && submenuBox.y + submenuBox.height <= height + 1,
            `${theme} ${width}: separate submenu height within viewport (got ${JSON.stringify(submenuBox)})`);
          if (desktop) {
            assert.ok(submenuBox.x >= menuBox.x + menuBox.width - 4, 'desktop submenu opens to the right');
            // 悬停离开目录行（进入菜单顶部「打开目录…」非目录行区域）→ 面板收起
            await page.locator('.ph-dir-selector .ph-open-dir-entry').first().hover();
          } else {
            assert.equal(Math.round(submenuBox.x), Math.round(menuBox.x), 'narrow submenu aligns with directory menu left edge');
            // 窄屏用模块已声明的 Escape 收起面板（只关面板，不关宿主下拉）
            await page.keyboard.press('Escape');
          }
          await page.locator('body > .ph-dir-subprojects.open').waitFor({ state: 'detached' });
        }
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
  console.log('PASS ph-project-browser-check: big-name dir selector, pill org selector with add/edit actions + inline project-setting gears, direct new-project dialog from +, hover submenu (project-less dirs included) with auto-swap, hidden scrollbar, real-index moves, busy 409, error payload, search attribution via real ESM state, persistence, themes/viewport; screenshots in ' + SHOT_DIR);
} catch (error) {
  console.error('FAIL ph-project-browser-check:', error?.message);
  console.error('page errors so far:', errors);
  console.error('captured actions:', (fixture?.captured?.actions || []).map(a => JSON.stringify(a)).slice(-5));
  throw error;
} finally {
  if (browser) await browser.close();
  if (fixture) await fixture.close();
}
