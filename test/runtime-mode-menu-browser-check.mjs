// Run explicitly: node test/runtime-mode-menu-browser-check.mjs
// 编程小助手「新建对话」悬停运行模式菜单的手势级回归（真实 Chromium 指针
// 事件）：悬停约 120ms 展开菜单（中文文案，验证 currentLanguage 裸引用共享
// 而非 window）；点击入口仍是普通创建（不带 runtimeMode）；移入菜单选择
// 注入所选 runtimeMode 后走统一 runWorkspaceAction；离开联合区收起；Esc
// 收起；菜单外点击自然收起且不吞事件。样式来自真实 components.css。
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import { chromium } from 'playwright';

const OPEN = 120;   // 与模块 OPEN_DELAY_MS 一致
const CLOSE = 250;  // 与模块 CLOSE_DELAY_MS 一致

const app = express();
app.use(express.static(path.join(process.cwd(), 'public')));
app.get('/fixture', (_req, res) => res.type('html').send(`<!doctype html><html><head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="/styles/components.css">
  <style>body{margin:0;font-family:sans-serif;padding:40px;background:#1e1e24}</style>
  </head><body data-theme="dark">
  <button id="entry-a" class="ph-banner-btn" type="button"
    data-runtime-mode-entry
    data-workspace-action='{"type":"ph_new_session","projectId":"p1","openDirectory":"D:/x"}'
    onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">新建对话</button>
  <button id="other-btn" type="button" onclick="window.__otherClicks.push(1)">别处</button>
  <div style="height:50vh"></div>
  <div id="outside-blank" style="height:20vh"></div>
  <script>
  let currentLanguage = 'zh'; // 与 app-core 同形：顶层 let，不挂 window
  function escapeHtml(s){ return String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  window.__actions = [];
  window.__otherClicks = [];
  function runWorkspaceAction(raw, el) { window.__actions.push({ action: JSON.parse(raw), el }); }
  </script>
  <script src="/src/modules/runtime-mode-menu.js"></script>
  </body></html>`));
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}/fixture`;

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const actions = () => page.evaluate(() => window.__actions);
const menuCount = () => page.locator('.ph-runtime-mode-menu').count();
const hoverEntry = async () => {
  // 先移出再移入：上一轮点击/选择后鼠标可能仍停在按钮上，同坐标移动
  // 不产生 pointerover，菜单不会重新展开。
  await page.mouse.move(20, 20);
  const box = await page.locator('#entry-a').boundingBox();
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
};

try {
  await page.goto(url);
  await page.waitForSelector('#entry-a');

  // 1. 悬停展开：中文文案（裸 currentLanguage 共享，非 window）、真实 CSS 尺寸
  await hoverEntry();
  assert.equal(await menuCount(), 0, 'no menu before hover delay elapses');
  await page.waitForTimeout(OPEN + 80);
  assert.equal(await menuCount(), 1, 'hover opens the menu after the enter delay');
  const menu = page.locator('.ph-runtime-mode-menu');
  assert.equal(await menu.getAttribute('role'), 'menu');
  const items = menu.locator('.ph-runtime-mode-item');
  assert.equal(await items.count(), 2);
  assert.deepEqual(await items.evaluateAll(els => els.map(el => el.dataset.runtimeMode)), ['standard', 'container']);
  assert.equal(await items.nth(0).textContent(), '普通模式直接在当前主机运行');
  assert.equal(await items.nth(1).textContent(), '容器模式在隔离容器中运行；有本地会话运行时需先停止');
  const menuBox = await menu.boundingBox();
  assert.ok(menuBox && menuBox.width > 100 && menuBox.height > 30, 'menu must render with real CSS size');
  console.log('PASS hover opens a styled menu with zh copy');

  // 2. 悬停后点击入口本身：普通创建（无 runtimeMode），菜单收起
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(60);
  let acts = await actions();
  assert.equal(acts.length, 1, 'clicking the entry creates via the normal path');
  assert.equal('runtimeMode' in acts[0].action, false, 'entry click carries no runtimeMode');
  assert.equal(acts[0].action.projectId, 'p1', 'original action fields preserved');
  assert.equal(await menuCount(), 0, 'menu closed after entry click');
  console.log('PASS entry click keeps the default path without runtimeMode');

  // 3. 悬停 → 移入菜单 → 选容器：注入 runtimeMode=container，字段保留
  await hoverEntry();
  await page.waitForTimeout(OPEN + 80);
  await page.locator('.ph-runtime-mode-item[data-runtime-mode="container"]').click();
  assert.equal(await menuCount(), 0, 'choosing closes the menu');
  acts = await actions();
  assert.equal(acts.length, 2);
  assert.equal(acts[1].action.runtimeMode, 'container');
  assert.equal(acts[1].action.type, 'ph_new_session');
  assert.equal(acts[1].action.projectId, 'p1');
  console.log('PASS container choice injects runtimeMode=container with fields intact');

  // 4. 普通模式选项同样透传 standard
  await hoverEntry();
  await page.waitForTimeout(OPEN + 80);
  await page.locator('.ph-runtime-mode-item[data-runtime-mode="standard"]').click();
  acts = await actions();
  assert.equal(acts.length, 3);
  assert.equal(acts[2].action.runtimeMode, 'standard');
  console.log('PASS standard choice injects runtimeMode=standard');

  // 5. 离开联合区（入口与菜单之外）超过容忍窗口：收起
  await hoverEntry();
  await page.waitForTimeout(OPEN + 80);
  await page.mouse.move(20, 400, { steps: 8 }); // 移出按钮与菜单的联合区域
  await page.waitForTimeout(CLOSE + 120);
  assert.equal(await menuCount(), 0, 'leaving the union area closes the menu');
  acts = await actions();
  assert.equal(acts.length, 3, 'closing must not create anything');
  console.log('PASS leaving the union area closes without creating');

  // 6. Esc 关闭
  await hoverEntry();
  await page.waitForTimeout(OPEN + 80);
  await page.keyboard.press('Escape');
  assert.equal(await menuCount(), 0, 'Escape closes the menu');
  console.log('PASS Escape closes the menu');

  // 7. 菜单展开时点击页面其他控件：菜单收起且不吞事件
  await hoverEntry();
  await page.waitForTimeout(OPEN + 80);
  await page.locator('#other-btn').click();
  assert.equal(await menuCount(), 0, 'outside click closes the menu');
  assert.equal(await page.evaluate(() => window.__otherClicks.length), 1, 'outside click must not be swallowed');
  console.log('PASS outside click closes without swallowing the event');

  // 8. 键盘可达性：菜单项 Enter 触发选择
  await hoverEntry();
  await page.waitForTimeout(OPEN + 80);
  await page.locator('.ph-runtime-mode-item[data-runtime-mode="container"]').focus();
  await page.keyboard.press('Enter');
  acts = await actions();
  assert.equal(acts.length, 4);
  assert.equal(acts[3].action.runtimeMode, 'container');
  console.log('PASS keyboard Enter on a menu item chooses the mode');

  assert.deepEqual(errors, [], 'no page errors expected');
  console.log('ALL PASS');
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
