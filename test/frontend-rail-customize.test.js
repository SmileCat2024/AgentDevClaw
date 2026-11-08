import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { createDomHarness } from './helpers/dom-harness.js';

/**
 * rail-customize 自定义面板清单必须从 ClawPanels 注册表派生，
 * 不再维护第二份硬编码面板真相（CUSTOMIZABLE_IDS/LABELS/DESCS）。
 * 清单外面板被彻底屏蔽：不进自定义弹窗，边栏按钮强制隐藏。
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
  // ClawPanels 委托给 ClawHost.panels（同一份注册表），必须先装载宿主
  ctx.loadSource('public/src/modules/claw-host.js');
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
      icon: '<svg viewBox="0 0 24 24"></svg>',
      order: 50,
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
      icon: '<svg viewBox="0 0 24 24"></svg>',
      order: 20,
    });
    window.ClawPanels.register('unlisted', {
      label: { zh: '不进入自定义清单', en: 'Not customizable' },
      render: () => '',
    });
  `);
  ctx.loadSource('public/src/modules/rail-customize.js');
  return ctx;
}

// ── 服务端呈现配置路径（fetch stub 驱动真实异步链） ────────────────

/** 等待 sandbox 内的异步链（fetch → json → remote.config 落定 → applyConfig 重放）完成。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 记录调用的 fetch stub：GET 返回预设 prefs，PUT 记录 body 到 puts。 */
function stubUiPrefsFetch({ presentation = {}, panelPrefs = {} } = {}) {
  const calls = [];
  const fetchStub = async (url, options) => {
    const method = (options && options.method) || 'GET';
    calls.push({ url: String(url), method, body: options?.body ? JSON.parse(options.body) : null });
    if (method === 'GET') {
      return { ok: true, status: 200, json: async () => ({ prefs: { presentation, panelPrefs } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  return { fetchStub, calls };
}

describe('rail customize derives its panel list from the registry', () => {
  it('lists only allowed registered panels in the defined default order', () => {
    const harness = buildRailDom(['genui', 'session-controls', 'workspace', 'unlisted', null]);
    const ctx = createRailSandbox(harness);

    assert.deepEqual(
      JSON.parse(JSON.stringify(ctx.run('window.RailCustomize.getCustomizableIds()'))),
      ['session-controls', 'genui'],
    );
  });

  it('defaults every customizable panel to visible', () => {
    const harness = buildRailDom(['workspace', 'session-controls', 'genui', 'unlisted']);
    const ctx = createRailSandbox(harness);

    assert.deepEqual(
      JSON.parse(JSON.stringify(ctx.run('window.RailCustomize.loadConfig()'))),
      [
        { id: 'session-controls', visible: true },
        { id: 'genui', visible: true },
      ],
    );
  });

  it('drops blocked and unknown ids from the server-side sparse presentation', async () => {
    const harness = buildRailDom(['workspace', 'monitor', 'genui', 'session-controls']);
    const { fetchStub } = stubUiPrefsFetch({
      presentation: {
        monitor: { visible: false, order: 0 },        // 清单外（注册无 order）
        'no-such-panel': { visible: true, order: 1 },  // 未注册面板
      },
    });
    const ctx = createRailSandbox(harness, { fetch: fetchStub });
    await settle();

    assert.deepEqual(
      JSON.parse(JSON.stringify(ctx.run('window.RailCustomize.loadConfig()'))),
      [
        { id: 'session-controls', visible: true },
        { id: 'genui', visible: true },
      ],
    );
  });

  it('migrates legacy localStorage ids onto renamed successors once per workspace', async () => {
    const harness = buildRailDom(['workspace', 'session-controls']);
    const { fetchStub, calls } = stubUiPrefsFetch({}); // 服务端无配置 → 触发迁移
    const ctx = createRailSandbox(harness, { fetch: fetchStub });
    // 初始化 GET 已同步发出、回调在 microtask 消费：此刻写入迁移源仍可被读到
    ctx.run(`localStorage.setItem('agentdev-rail-config', JSON.stringify([
      { id: 'force-continuation', visible: false },
    ]))`);
    await settle();

    const put = calls.find((c) => c.method === 'PUT');
    assert.ok(put, '迁移应 PUT 服务端');
    assert.deepEqual(put.body.presentation['session-controls'], { visible: false, order: 0 });
    assert.equal(
      ctx.run(`localStorage.getItem('agentdev-rail-config-migrated:programming-helper')`),
      '1',
      '迁移完成后打一次性标记',
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(ctx.run('window.RailCustomize.loadConfig()'))),
      [{ id: 'session-controls', visible: false }],
    );
  });

  it('hides a hidden panel button and clears the active panel through the host renderer', async () => {
    const harness = buildRailDom(['genui', 'monitor']);
    const { fetchStub } = stubUiPrefsFetch({
      presentation: { genui: { visible: false, order: 0 } },
    });
    const ctx = createRailSandbox(harness, { fetch: fetchStub });
    await settle();
    ctx.run(`
      activeFeaturePanel = 'genui';
      var _renderCalls = 0;
      renderFeaturePanel = function () { _renderCalls += 1; };
    `);

    ctx.run('window.applyRailConfig()');

    const genuiBtn = harness.document.querySelector('.rail-button[data-panel="genui"]');
    assert.ok(genuiBtn.classList.contains('rail-custom-hidden'));
    assert.equal(ctx.run('activeFeaturePanel'), null);
    assert.equal(ctx.run('_renderCalls'), 1);
  });

  it('force-hides blocked panel buttons and clears their active panel', () => {
    const harness = buildRailDom(['workspace', 'genui', 'monitor']);
    const ctx = createRailSandbox(harness);
    ctx.run(`
      activeFeaturePanel = 'workspace';
      var _renderCalls = 0;
      renderFeaturePanel = function () { _renderCalls += 1; };
    `);

    ctx.run('window.applyRailConfig()');

    const workspaceBtn = harness.document.querySelector('.rail-button[data-panel="workspace"]');
    const monitorBtn = harness.document.querySelector('.rail-button[data-panel="monitor"]');
    const genuiBtn = harness.document.querySelector('.rail-button[data-panel="genui"]');
    assert.ok(workspaceBtn.classList.contains('rail-custom-hidden'), 'workspace（清单外）被强制隐藏');
    assert.ok(monitorBtn.classList.contains('rail-custom-hidden'), 'monitor（清单外）被强制隐藏');
    assert.ok(!genuiBtn.classList.contains('rail-custom-hidden'), '清单内默认可见面板不受影响');
    assert.equal(ctx.run('activeFeaturePanel'), null, '屏蔽面板处于激活态时被清空');
    assert.equal(ctx.run('_renderCalls'), 1, '激活面板被清空后触发宿主重渲染');
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

describe('rail long-press drag reorder', () => {
  it('persists a new order through the shared rail config, keeping visibility', async () => {
    const harness = buildRailDom(['workspace', 'genui', 'session-controls', 'unlisted']);
    const { fetchStub, calls } = stubUiPrefsFetch({
      presentation: {
        'session-controls': { visible: true, order: 0 },
        genui: { visible: false, order: 1 },
      },
    });
    const ctx = createRailSandbox(harness, { fetch: fetchStub });
    await settle();

    ctx.run(`window.RailCustomize.commitRailOrder(['genui', 'session-controls'])`);

    assert.deepEqual(
      JSON.parse(JSON.stringify(ctx.run('window.RailCustomize.loadConfig()'))),
      [
        { id: 'genui', visible: false },
        { id: 'session-controls', visible: true },
      ],
    );
    const put = calls.find((c) => c.method === 'PUT');
    assert.ok(put, '顺序变更应落盘服务端');
    assert.deepEqual(put.body.presentation.genui, { visible: false, order: 0 });
    assert.deepEqual(put.body.presentation['session-controls'], { visible: true, order: 1 });
  });

  it('reorders rail buttons to the committed order, blocked panels stay after the group', () => {
    const harness = buildRailDom(['workspace', 'genui', 'session-controls', 'unlisted']);
    const ctx = createRailSandbox(harness);

    ctx.run(`window.RailCustomize.commitRailOrder(['session-controls', 'genui'])`);

    const panels = harness.document
      .querySelectorAll('.rail-button[data-panel]')
      .filter((btn) => btn.dataset.panel)
      .map((btn) => btn.dataset.panel);
    assert.deepEqual(panels, ['session-controls', 'genui', 'workspace', 'unlisted']);
  });

  it('keeps entries missing from the submitted order at the tail in their prior order', async () => {
    const harness = buildRailDom(['workspace', 'genui', 'session-controls']);
    const { fetchStub, calls } = stubUiPrefsFetch({
      presentation: {
        'session-controls': { visible: false, order: 0 },
        genui: { visible: true, order: 1 },
      },
    });
    const ctx = createRailSandbox(harness, { fetch: fetchStub });
    await settle();

    ctx.run(`window.RailCustomize.commitRailOrder(['genui'])`);

    assert.deepEqual(
      JSON.parse(JSON.stringify(ctx.run('window.RailCustomize.loadConfig()'))),
      [
        { id: 'genui', visible: true },
        { id: 'session-controls', visible: false },
      ],
    );
    assert.ok(calls.some((c) => c.method === 'PUT'), '顺序变更落盘服务端');
  });
});

describe('rail customize switches presentation with the focused workspace', () => {
  it('refetches and re-applies when the focused workspace changes', async () => {
    const harness = buildRailDom(['genui', 'session-controls']);
    const fetchStub = async (url, options) => {
      const method = (options && options.method) || 'GET';
      if (method === 'GET') {
        const agentId = String(url).endsWith('agentId=coder') ? 'coder' : 'programming-helper';
        const presentation = agentId === 'coder'
          ? { genui: { visible: true, order: 1 } }
          : { genui: { visible: false, order: 0 } };
        return { ok: true, status: 200, json: async () => ({ prefs: { presentation, panelPrefs: {} } }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    const ctx = createRailSandbox(harness, { fetch: fetchStub });
    await settle();
    // programming-helper：服务端配置 genui 隐藏
    assert.equal(
      ctx.run(`document.querySelector('.rail-button[data-panel="genui"]').classList.contains('rail-custom-hidden')`),
      true,
    );

    // 切换到 coder：重拉后 genui 恢复可见
    ctx.run('focusedAgentId = "coder"; window.applyRailConfig()');
    await settle();
    assert.equal(
      ctx.run(`document.querySelector('.rail-button[data-panel="genui"]').classList.contains('rail-custom-hidden')`),
      false,
    );
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
