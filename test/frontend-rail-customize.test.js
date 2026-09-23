import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { createDomHarness } from './helpers/dom-harness.js';

/**
 * rail-customize 自定义面板清单必须从 ClawPanels 注册表派生，
 * 不再维护第二份硬编码面板真相（CUSTOMIZABLE_IDS/LABELS/DESCS）。
 */

function buildRailDom(panelIds) {
  const harness = createDomHarness();
  const rail = harness.document.createElement('aside');
  rail.id = 'right-rail';
  for (const id of panelIds) {
    const btn = harness.document.createElement('button');
    btn.className = 'rail-button';
    if (id) btn.dataset.panel = id;
    rail.appendChild(btn);
  }
  const spacer = harness.document.createElement('div');
  spacer.className = 'rail-spacer';
  rail.appendChild(spacer);
  harness.document.body.appendChild(rail);
  return harness;
}

function createRailSandbox(harness, overrides = {}) {
  const ctx = createFrontendSandbox({ document: harness.document, ...overrides });
  ctx.loadSource('public/src/modules/right-panel-registry.js');
  ctx.run(`
    window.ClawPanels.register('workspace', {
      when: { surfaces: ['chat'] },
      label: { zh: '文件结构', en: 'Structure' },
      description: { zh: '项目文件树', en: 'Project file tree' },
      render: () => '',
    });
    window.ClawPanels.register('monitor', {
      when: { surfaces: ['chat'] },
      label: { zh: '监控', en: 'Monitor' },
      description: { zh: '运行状态监控', en: 'Runtime status monitor' },
      render: () => '',
    });
    window.ClawPanels.register('genui', {
      when: { surfaces: ['chat'] },
      label: { zh: '交互页面', en: 'Interactive Pages' },
      description: { zh: 'UI 交互页面', en: 'Interactive UI pages' },
      render: () => '',
    });
    window.ClawPanels.register('preflight', {
      // 已注册但没有 rail 按钮的面板（程序化打开），不进入自定义清单
      when: { surfaces: ['chat'] },
      label: { zh: '装配预检', en: 'Preflight' },
      render: () => '',
    });
    window.ClawPanels.register('session-controls', {
      when: { surfaces: ['chat'] },
      label: { zh: '会话控制', en: 'Session Controls' },
      render: () => '',
    });
  `);
  ctx.loadSource('public/src/modules/rail-customize.js');
  return ctx;
}

describe('rail customize derives its panel list from the registry', () => {
  it('lists registered panels that have a rail button, in registration order', () => {
    const harness = buildRailDom(['workspace', 'monitor', 'genui', null]);
    const ctx = createRailSandbox(harness);

    assert.deepEqual(
      JSON.parse(JSON.stringify(ctx.run('window.RailCustomize.getCustomizableIds()'))),
      ['workspace', 'monitor', 'genui'],
    );
  });

  it('keeps unknown ids out and appends missing panels when loading a legacy config', () => {
    const harness = buildRailDom(['workspace', 'monitor', 'genui']);
    const ctx = createRailSandbox(harness);
    ctx.run(`localStorage.setItem('agentdev-rail-config', JSON.stringify([
      { id: 'monitor', visible: false },
      { id: 'no-such-panel', visible: true },
    ]))`);

    assert.deepEqual(
      JSON.parse(JSON.stringify(ctx.run('window.RailCustomize.loadConfig()'))),
      [
        { id: 'monitor', visible: false },
        { id: 'workspace', visible: true },
        { id: 'genui', visible: true },
      ],
    );
  });

  it('maps legacy panel ids onto their renamed successors', () => {
    const harness = buildRailDom(['workspace', 'session-controls']);
    const ctx = createRailSandbox(harness);
    ctx.run(`localStorage.setItem('agentdev-rail-config', JSON.stringify([
      { id: 'force-continuation', visible: false },
    ]))`);

    assert.deepEqual(
      JSON.parse(JSON.stringify(ctx.run('window.RailCustomize.loadConfig()'))),
      [
        { id: 'session-controls', visible: false },
        { id: 'workspace', visible: true },
      ],
    );
  });

  it('hides a hidden panel button and clears the active panel through the host renderer', () => {
    const harness = buildRailDom(['workspace', 'monitor']);
    const ctx = createRailSandbox(harness);
    ctx.run(`localStorage.setItem('agentdev-rail-config', JSON.stringify([
      { id: 'monitor', visible: false },
    ]))`);
    ctx.run(`
      activeFeaturePanel = 'monitor';
      var _renderCalls = 0;
      renderFeaturePanel = function () { _renderCalls += 1; };
    `);

    ctx.run('window.applyRailConfig()');

    const monitorBtn = harness.document.querySelector('.rail-button[data-panel="monitor"]');
    assert.ok(monitorBtn.classList.contains('rail-custom-hidden'));
    assert.equal(ctx.run('activeFeaturePanel'), null);
    assert.equal(ctx.run('_renderCalls'), 1);
  });

  it('reads labels and descriptions from registered panel metadata', () => {
    const harness = buildRailDom(['workspace']);
    const ctx = createRailSandbox(harness);

    assert.equal(ctx.run('window.RailCustomize.label("workspace")'), '文件结构');
    assert.equal(ctx.run('window.RailCustomize.description("workspace")'), '项目文件树');
    ctx.run('currentLanguage = "en"');
    assert.equal(ctx.run('window.RailCustomize.label("workspace")'), 'Structure');
    assert.equal(ctx.run('window.RailCustomize.description("workspace")'), 'Project file tree');
    ctx.run('currentLanguage = "zh"');
    assert.equal(ctx.run('window.RailCustomize.label("unregistered")'), 'unregistered');
  });
});

describe('rail customize keeps a single source of panel truth', () => {
  it('no longer hardcodes panel ids, labels, or descriptions', () => {
    const source = fs.readFileSync(new URL('../public/src/modules/rail-customize.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /CUSTOMIZABLE_IDS/);
    assert.doesNotMatch(source, /var LABELS/);
    assert.doesNotMatch(source, /var DESCS/);
  });

  it('loads after all panel contributors register (registry, app-ui, resources-viewer)', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    const order = (src) => html.indexOf(`src="${src}"`);
    assert.ok(order('./src/modules/rail-customize.js') > order('./src/modules/right-panel-registry.js'));
    assert.ok(order('./src/modules/rail-customize.js') > order('./src/app-ui.js'));
    assert.ok(order('./src/modules/rail-customize.js') > order('./src/modules/resources-viewer.js'));
  });

  it('registers panel label and description metadata at the registration sites', () => {
    const appUi = fs.readFileSync(new URL('../public/src/app-ui.js', import.meta.url), 'utf8');
    assert.match(appUi, /label:\s*\{\s*zh:\s*'文件结构'/);
    assert.match(appUi, /label:\s*\{\s*zh:\s*'群聊设置'/);
    const resourcesViewer = fs.readFileSync(new URL('../public/src/modules/resources-viewer.js', import.meta.url), 'utf8');
    assert.match(resourcesViewer, /label:\s*\{\s*zh:\s*'资料'/);
    assert.match(resourcesViewer, /label:\s*\{\s*zh:\s*'文档'/);
  });
});
