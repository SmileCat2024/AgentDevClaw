/* global window, document, getComputedStyle, currentRuntimeAgentId: writable, activeFeaturePanel: writable, currentLanguage: writable, renderPlanPanel, setCurrentTodoPlan */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

// Isolated presentation fixture: real Claw DOM, styles, renderer and delegated controls;
// no running session or user data is changed by this check.
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  const source = await fs.readFile('public/index.html', 'utf8');
  await page.route('http://claw.test/**', async route => {
    if (route.request().method() === 'POST') {
      requests.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    }
    // 迁出后的 ESM 模块按真实模块 URL 从 public/ 取源，走真实 import 图。
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/src/')) {
      return route.fulfill({ contentType: 'text/javascript', body: await fs.readFile(`public${pathname}`, 'utf8') });
    }
    return route.fulfill({ contentType: 'text/html', body: source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '') });
  });
  await page.goto('http://claw.test/');
  for (const name of ['base', 'layout', 'components']) {
    await page.addStyleTag({ content: await fs.readFile(`public/styles/${name}.css`, 'utf8') });
  }
  // 几何断言比较稳定布局，不比较入场过渡中的瞬时位移。
  await page.addStyleTag({ content: '.feature-panel-body { transition: none; }' });
  await page.addScriptTag({ content: await fs.readFile('node_modules/marked/lib/marked.umd.js', 'utf8') });
  await page.addScriptTag({ content: await fs.readFile('public/src/modules/kernel-state.js', 'utf8') });
  // 右栏面板唯一注册表是 ClawPanels（claw-host 的 panels 命名空间 + 旧入口包装）；
  // 渲染寻址从它读，不再有平行清单。
  await page.addScriptTag({ content: await fs.readFile('public/src/modules/claw-host.js', 'utf8') });
  await page.addScriptTag({ content: await fs.readFile('public/src/modules/right-panel-registry.js', 'utf8') });
  await page.addScriptTag({ content: await fs.readFile('public/src/modules/action-dispatcher.js', 'utf8') });
  for (const name of ['i18n', 'app-core', 'modules/markdown-bootstrap', 'modules/todo-plan']) {
    await page.addScriptTag({ content: await fs.readFile(`public/src/${name}.js`, 'utf8') });
  }
  await page.addScriptTag({ type: 'module', url: 'http://claw.test/src/modules/markdown-utils.js' });
  await page.evaluate(() => {
    window.ClawPanels.register('plan', { title: '计划', render: () => renderPlanPanel() });
  });
  await page.addScriptTag({ content: await fs.readFile('public/src/modules/debug-panel-host.js', 'utf8') });
  const tasks = [
    ...Array.from({ length: 6 }, (_, i) => ({ id: String(i + 1), subject: `已完成的准备工作 ${i + 1}`, description: `准备工作 ${i + 1} 的详细记录`, status: 'completed' })),
    { id: '7', subject: '统一计划面板的控件与视觉层次', description: '复用 Claw 现有控件，整理间距和状态呈现。\n检查深浅主题与窄面板。', status: 'in_progress' },
    { id: '8', subject: '验证长文本与交互边界', description: 'LongUnbrokenIdentifier_'.repeat(12), status: 'pending' },
    { id: '9', subject: '已取消的旧方案', description: '保留历史记录。', status: 'deleted' },
  ];
  await page.evaluate(tasks => {
    currentRuntimeAgentId = 'fixture-runtime';
    activeFeaturePanel = 'plan';
    if (!currentRuntimeAgentId || activeFeaturePanel !== 'plan') throw new Error('Plan identity missing');
    window.getCurrentControlAgentId = () => 'programming-helper';
    document.getElementById('feature-panel').classList.add('open', 'body-ready');
    setCurrentTodoPlan({ tasks });
    window.renderFeaturePanel();
  }, tasks);
  await fs.mkdir('.agentdev/temp/plan-panel-check', { recursive: true });
  const panel = page.locator('#feature-panel');
  for (const theme of ['dark', 'light']) {
    await page.locator('body').evaluate((body, theme) => { body.dataset.theme = theme; }, theme);
    for (const width of [500, 320]) {
      await page.locator('body').evaluate((body, width) => { body.style.setProperty('--feature-panel-width', `${width}px`); }, width);
      for (const language of ['zh', 'en']) {
        await page.evaluate(language => {
          currentLanguage = language;
          if (!currentLanguage) throw new Error('Language missing');
          window.renderFeaturePanel();
        }, language);
        const pending = page.locator('.status-pending');
        const before = await pending.boundingBox();
        await pending.hover();
        assert.deepEqual(await pending.boundingBox(), before, 'hover must not move or resize a task');
        assert.equal(await pending.locator('[data-todo-interrupt]').isVisible(), true, 'action must remain available without a hover-only reveal');
        const presentation = await page.locator('.plan-task').evaluateAll(rows => rows.map(row => {
          const style = getComputedStyle(row);
          return { background: style.backgroundColor, shadow: style.boxShadow };
        }));
        assert.ok(presentation.every(style => style.background === 'rgba(0, 0, 0, 0)' && style.shadow === 'none'), 'ordinary timeline rows must not be wrapped in cards, including on hover');
        assert.ok((await pending.locator('[data-todo-interrupt]').boundingBox()).height <= 28, 'run-to-here stays a compact inline action');
        assert.equal(await page.locator('.plan-panel').evaluate(el => el.scrollWidth <= el.clientWidth), true, `${theme}/${width}/${language}: no horizontal overflow`);
        await panel.screenshot({ path: `.agentdev/temp/plan-panel-check/${theme}-${width}-${language}.png` });
      }
    }
  }
  // Real click and keyboard paths: folding and detail disclosure retain their semantics.
  const fold = page.locator('[data-plan-toggle-run="0"]');
  const foldBefore = await fold.boundingBox();
  await fold.hover();
  assert.deepEqual(await fold.boundingBox(), foldBefore, 'fold hover must not change its geometry');
  await fold.click();
  assert.deepEqual(await fold.boundingBox(), foldBefore, 'expansion must leave the fold label in place');
  assert.equal(await page.locator('.status-completed').count(), 6);
  const detail = page.locator('[data-plan-task-detail="1"]');
  await detail.focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-plan-task-detail="1"]').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.getByText('准备工作 1 的详细记录', { exact: true }).isVisible(), true);
  await page.locator('[data-plan-task-detail="1"]').focus();
  await page.keyboard.press('Space');
  assert.equal(await page.locator('[data-plan-task-detail="1"]').getAttribute('aria-expanded'), 'false');
  await page.locator('[data-plan-toggle-run="0"]').click();
  assert.equal(await page.locator('.status-completed').count(), 4);
  await page.locator('[data-task-id="8"]').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  assert.notEqual(await page.locator('[data-task-id="8"]').evaluate(el => getComputedStyle(el).outlineStyle), 'none');
  const setResponse = page.waitForResponse(response => response.url().endsWith('/todo_control'));
  await page.keyboard.press('Enter');
  await setResponse;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].taskId, '8');
  assert.equal(requests[0].runtimeId, 'fixture-runtime');
  assert.equal(await page.locator('.is-interrupt-target [data-action="cancel"]').count(), 1);
  const selected = page.locator('.is-interrupt-target');
  const selectionBounds = await selected.evaluate(row => {
    const rect = row.getBoundingClientRect();
    const marker = row.querySelector('.plan-task-marker').getBoundingClientRect();
    const background = getComputedStyle(row, '::before');
    return { left: rect.left + parseFloat(background.left), markerLeft: marker.left, content: background.content };
  });
  assert.notEqual(selectionBounds.content, 'none', 'selected row must display its selection background');
  assert.ok(selectionBounds.left < selectionBounds.markerLeft, 'selection must extend to the left of the timeline node');
  const selectedBefore = await selected.boundingBox();
  await selected.hover();
  assert.deepEqual(await selected.boundingBox(), selectedBefore, 'selected row hover must keep stable geometry');
  for (const theme of ['dark', 'light']) {
    await page.locator('body').evaluate((body, theme) => { body.dataset.theme = theme; }, theme);
    await panel.screenshot({ path: `.agentdev/temp/plan-panel-check/${theme}-selected.png` });
  }
  const cancelResponse = page.waitForResponse(response => response.url().endsWith('/todo_control'));
  await page.locator('.is-interrupt-target [data-action="cancel"]').click();
  await cancelResponse;
  assert.equal(requests.length, 2);
  assert.equal(requests[1].taskId, null);
  assert.equal(await page.locator('.is-interrupt-target').count(), 0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.plan-task-spinner').evaluate(el => getComputedStyle(el).animationName), 'none');
  for (const theme of ['dark', 'light']) {
    await page.locator('body').evaluate((body, theme) => { body.dataset.theme = theme; }, theme);
    await page.evaluate(() => { setCurrentTodoPlan({ tasks: [] }); window.renderFeaturePanel(); });
    assert.equal(await page.locator('.plan-empty').isVisible(), true);
    await panel.screenshot({ path: `.agentdev/temp/plan-panel-check/${theme}-empty.png` });
  }
  assert.deepEqual(errors, []);
  console.log('PASS: deep/light themes, 320/500px panels, Chinese/English, stable hover, overflow, keyboard disclosure, fold controls, stop/cancel requests, reduced motion and empty state.');
} finally {
  await browser.close();
}
