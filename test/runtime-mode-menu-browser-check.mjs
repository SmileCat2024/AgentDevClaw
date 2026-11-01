// Run explicitly: node test/runtime-mode-menu-browser-check.mjs
// 编程小助手「新建对话」长按运行模式菜单的手势级回归（真实 Chromium 指针事件，
// 非合成 DOM 事件）：短按不弹菜单且不带 runtimeMode；长按弹出菜单并注入所选
// runtimeMode 后走统一 runWorkspaceAction；移动取消 / 菜单外点击不点穿 / Esc
// 关闭 / 长按后的合成 click 被抑制。样式来自真实 components.css（菜单有实际尺寸）。
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import { chromium } from 'playwright';

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
  <div style="height:60vh"></div>
  <div id="outside-blank" style="height:20vh"></div>
  <script>
  window.currentLanguage = 'zh';
  window.escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  window.__actions = [];
  window.runWorkspaceAction = (raw, el) => { window.__actions.push({ action: JSON.parse(raw), el }); };
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
const press = async (ms) => {
  const box = await page.locator('#entry-a').boundingBox();
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
};

try {
  await page.goto(url);
  await page.waitForSelector('#entry-a');

  // 1. 短按：不弹菜单，创建不带 runtimeMode
  await press(80);
  assert.equal(await menuCount(), 0, 'short press must not open the menu');
  let acts = await actions();
  assert.equal(acts.length, 1, 'short press must create via the normal path');
  assert.equal('runtimeMode' in acts[0].action, false, 'short press action carries no runtimeMode');
  assert.equal(acts[0].action.projectId, 'p1', 'original action fields preserved');
  console.log('PASS short press keeps the default path without runtimeMode');

  // 2. 长按：弹出菜单（角色/选项/文案），样式生效（真实 CSS 下有尺寸）
  const box = await page.locator('#entry-a').boundingBox();
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(500);
  assert.equal(await menuCount(), 1, 'long press opens the menu');
  const menu = page.locator('.ph-runtime-mode-menu');
  assert.equal(await menu.getAttribute('role'), 'menu');
  const items = menu.locator('.ph-runtime-mode-item');
  assert.equal(await items.count(), 2);
  assert.deepEqual(await items.evaluateAll(els => els.map(el => el.dataset.runtimeMode)), ['standard', 'container']);
  assert.equal(await items.nth(0).textContent(), '普通模式直接在当前主机运行');
  assert.equal(await items.nth(1).textContent(), '容器模式在隔离容器中运行；环境不可用时创建失败，不回退');
  const menuBox = await menu.boundingBox();
  assert.ok(menuBox && menuBox.width > 100 && menuBox.height > 30, 'menu must render with real CSS size');
  // 长按触发后的合成 click 必须被吞掉（原地松开不创建）
  await page.mouse.up();
  await page.waitForTimeout(120);
  acts = await actions();
  assert.equal(acts.length, 1, 'synthetic click after long press must be suppressed');

  // 3. 菜单外点击：关闭且该次按压不点穿（不创建）
  await page.locator('#outside-blank').click({ position: { x: 10, y: 10 } });
  assert.equal(await menuCount(), 0, 'outside click closes the menu');
  acts = await actions();
  assert.equal(acts.length, 1, 'the closing press must not leak a creation');
  console.log('PASS long press opens a styled menu; outside click closes without click-through');

  // 4. 选择容器模式：注入 runtimeMode=container，其余字段保留
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.locator('.ph-runtime-mode-item[data-runtime-mode="container"]').click();
  assert.equal(await menuCount(), 0, 'choosing closes the menu');
  acts = await actions();
  assert.equal(acts.length, 2);
  assert.equal(acts[1].action.runtimeMode, 'container');
  assert.equal(acts[1].action.type, 'ph_new_session');
  assert.equal(acts[1].action.projectId, 'p1');
  console.log('PASS container choice injects runtimeMode=container with fields intact');

  // 5. 普通模式选项同样透传 standard
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.locator('.ph-runtime-mode-item[data-runtime-mode="standard"]').click();
  acts = await actions();
  assert.equal(acts.length, 3);
  assert.equal(acts[2].action.runtimeMode, 'standard');
  console.log('PASS standard choice injects runtimeMode=standard');

  // 6. Esc 关闭菜单，不创建
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  assert.equal(await menuCount(), 0, 'Escape closes the menu');
  acts = await actions();
  assert.equal(acts.length, 3, 'Escape must not create');
  console.log('PASS Escape closes without creating');

  // 7. 按压中移动 >8px：取消长按，松开后走普通点击创建（无菜单泄漏）
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 4 });
  await page.waitForTimeout(400);
  assert.equal(await menuCount(), 0, 'moving beyond threshold cancels the hold');
  await page.mouse.up();
  await page.waitForTimeout(120);
  acts = await actions();
  assert.equal(acts.length, 4, 'drag-cancelled press falls back to the normal click path');
  assert.equal('runtimeMode' in acts[3].action, false);
  console.log('PASS drag beyond 8px cancels the hold and keeps the normal click');

  // 8. 键盘可达性：菜单项 Enter 触发选择
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.locator('.ph-runtime-mode-item[data-runtime-mode="container"]').focus();
  await page.keyboard.press('Enter');
  acts = await actions();
  assert.equal(acts.length, 5);
  assert.equal(acts[4].action.runtimeMode, 'container');
  console.log('PASS keyboard Enter on a menu item chooses the mode');

  assert.deepEqual(errors, [], 'no page errors expected');
  console.log('ALL PASS');
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
