import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { createDomHarness } from './helpers/dom-harness.js';

/**
 * rail-customize 自定义面板清单必须从 ClawPanels 注册表派生，
 * 不再维护第二份硬编码面板真相（CUSTOMIZABLE_IDS/LABELS/DESCS）。
 * 清单外面板被彻底屏蔽：不进自定义弹窗，边栏按钮强制隐藏。
 *
 * 装载路线（P4 L2：rail-customize 已迁 ESM）：withP2EsmCase + 真实 import。
 * classic 相只装面板注册表宿主（claw-host / right-panel-registry）与用例的
 * 注册夹具；`window.applyRailConfig` 仍是生产桥键（app-ui / debug-panel-host
 * 的 classic 消费入口），因此用例照旧经 `ctx.run('window.applyRailConfig()')`
 * 走真实桥；清单 / 配置 API 一律调用模块命名导出。
 */

const RAIL = 'public/src/modules/rail-customize.js';
const RENDER_ENTRY = 'public/src/modules/render-entry-state.js';
const AGENT_STORE = 'public/src/modules/agent-store-state.js';
const I18N_ENV = 'public/src/modules/i18n-environment-state.js';

/** 真 setTimeout：用例的 settle 不受「可驱动计时器」夹具影响。 */
const realSetTimeout = setTimeout;
const settle = () => new Promise((resolve) => realSetTimeout(resolve, 0));

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

/** ClawPanels 委托给 ClawHost.panels（同一份注册表），夹具先装宿主再注册。 */
const PANEL_REGISTRATIONS = `
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
`;

/**
 * 一个用例 = 一份 classic 沙箱 + 一张真实 ESM 图。
 * @param {object} harness buildRailDom 的产出
 * @param {{ fetch?: Function, timers?: { scheduled: Function[] } }} options
 *   timers：把 setTimeout / clearTimeout 换成可驱动队列（拖拽手势用例需要
 *   手工触发长按计时器）。
 * @param {(env: { ctx: object, RailCustomize: object, renderEntry: object,
 *                 agentStore: object, i18nEnv: object }) => any} fn
 */
function withRailSandbox(harness, options, fn) {
  const { fetch: fetchStub, timers, seedClassic } = options || {};
  return withP2EsmCase({
    globals: {
      document: harness.document,
      ...(fetchStub ? { fetch: fetchStub } : {}),
    },
    classic: (sandbox) => {
      // 注册表宿主：claw-host 提供 ClawHost.panels，right-panel-registry 是它的
      // classic 转发壳（window.ClawPanels），两者都先于面板实现。
      sandbox.loadSource('public/src/modules/claw-host.js');
      sandbox.loadSource('public/src/modules/right-panel-registry.js');
      sandbox.run(PANEL_REGISTRATIONS);
      // 模块求值前就存在的环境（迁移源 localStorage / 预置身份等）：ESM 求值在
      // `await c.load` 之后紧接异步回调，用例体的写点已晚于首个 GET 的微任务。
      if (typeof seedClassic === 'function') seedClassic(sandbox);
    },
  }, async (c) => {
    if (timers) {
      const stubSetTimeout = (callback) => { timers.scheduled.push(callback); return timers.scheduled.length; };
      // 模块内以裸标识符调用 setTimeout：改主 realm 与沙箱两侧；用例体用
      // realSetTimeout 等待异步链，不受该夹具影响。
      c.window.setTimeout = stubSetTimeout;
      globalThis.setTimeout = stubSetTimeout;
      c.window.clearTimeout = () => {};
      globalThis.clearTimeout = () => {};
    }
    const mod = await c.load(RAIL);
    const renderEntry = await c.load(RENDER_ENTRY);
    const agentStore = await c.load(AGENT_STORE);
    const i18nEnv = await c.load(I18N_ENV);
    return fn({
      ctx: c.window,
      RailCustomize: mod.RailCustomize,
      renderEntry,
      agentStore,
      i18nEnv,
    });
  });
}

// ── 服务端呈现配置路径（fetch stub 驱动真实异步链） ────────────────

/** 记录调用的 fetch stub：GET 返回预设 prefs，PUT 记录 body 到 calls。 */
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
  it('lists only allowed registered panels in the defined default order', async () => {
    const harness = buildRailDom(['genui', 'session-controls', 'workspace', 'unlisted', null]);
    await withRailSandbox(harness, {}, ({ RailCustomize }) => {
      assert.deepEqual(
        JSON.parse(JSON.stringify(RailCustomize.getCustomizableIds())),
        ['session-controls', 'genui'],
      );
    });
  });

  it('defaults every customizable panel to visible', async () => {
    const harness = buildRailDom(['workspace', 'session-controls', 'genui', 'unlisted']);
    await withRailSandbox(harness, {}, ({ RailCustomize }) => {
      assert.deepEqual(
        JSON.parse(JSON.stringify(RailCustomize.loadConfig())),
        [
          { id: 'session-controls', visible: true },
          { id: 'genui', visible: true },
        ],
      );
    });
  });

  it('drops blocked and unknown ids from the server-side sparse presentation', async () => {
    const harness = buildRailDom(['workspace', 'monitor', 'genui', 'session-controls']);
    const { fetchStub } = stubUiPrefsFetch({
      presentation: {
        monitor: { visible: false, order: 0 },        // 清单外（注册无 order）
        'no-such-panel': { visible: true, order: 1 },  // 未注册面板
      },
    });
    await withRailSandbox(harness, { fetch: fetchStub }, async ({ RailCustomize }) => {
      await settle();

      assert.deepEqual(
        JSON.parse(JSON.stringify(RailCustomize.loadConfig())),
        [
          { id: 'session-controls', visible: true },
          { id: 'genui', visible: true },
        ],
      );
    });
  });

  it('migrates legacy localStorage ids onto renamed successors once per workspace', async () => {
    const harness = buildRailDom(['workspace', 'session-controls']);
    const { fetchStub, calls } = stubUiPrefsFetch({}); // 服务端无配置 → 触发迁移
    await withRailSandbox(harness, {
      fetch: fetchStub,
      // 迁移源是页面加载前就存在的浏览器存储：在模块求值前种下（ESM 相里
      // 模块求值后紧跟首个 GET 的微任务，用例体写点已晚于该回调）。
      seedClassic: (sandbox) => sandbox.run(`localStorage.setItem('agentdev-rail-config', JSON.stringify([
        { id: 'force-continuation', visible: false },
      ]))`),
    }, async ({ ctx, RailCustomize }) => {
      await settle();

      const put = calls.find((c) => c.method === 'PUT');
      assert.ok(put, '迁移应 PUT 服务端');
      assert.equal(put.body.agentId, 'home', '无聚焦时迁移落 home 身份域（不落主空间）');
      assert.deepEqual(put.body.presentation['session-controls'], { visible: false, order: 0 });
      assert.equal(
        ctx.run(`localStorage.getItem('agentdev-rail-config-migrated:home')`),
        '1',
        '迁移完成后打一次性标记',
      );
      assert.deepEqual(
        JSON.parse(JSON.stringify(RailCustomize.loadConfig())),
        [{ id: 'session-controls', visible: false }],
      );
    });
  });

  it('hides a hidden panel button and clears the active panel through the host renderer', async () => {
    const harness = buildRailDom(['genui', 'monitor']);
    const { fetchStub } = stubUiPrefsFetch({
      presentation: { genui: { visible: false, order: 0 } },
    });
    await withRailSandbox(harness, { fetch: fetchStub }, async ({ ctx, renderEntry }) => {
      await settle();
      renderEntry.setActiveFeaturePanel('genui');
      ctx.run(`
        var _renderCalls = 0;
        renderFeaturePanel = function () { _renderCalls += 1; };
      `);

      ctx.run('window.applyRailConfig()');

      const genuiBtn = harness.document.querySelector('.rail-button[data-panel="genui"]');
      assert.ok(genuiBtn.classList.contains('rail-custom-hidden'));
      assert.equal(renderEntry.activeFeaturePanel, null);
      assert.equal(ctx.run('_renderCalls'), 1);
    });
  });

  it('force-hides blocked panel buttons and clears their active panel', async () => {
    const harness = buildRailDom(['workspace', 'genui', 'monitor']);
    await withRailSandbox(harness, {}, ({ ctx, renderEntry }) => {
      renderEntry.setActiveFeaturePanel('workspace');
      ctx.run(`
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
      assert.equal(renderEntry.activeFeaturePanel, null, '屏蔽面板处于激活态时被清空');
      assert.equal(ctx.run('_renderCalls'), 1, '激活面板被清空后触发宿主重渲染');
    });
  });

  it('reads labels and descriptions from registered panel metadata', async () => {
    const harness = buildRailDom(['workspace']);
    await withRailSandbox(harness, {}, ({ RailCustomize, i18nEnv }) => {
      assert.equal(RailCustomize.label('workspace'), '文件结构');
      assert.equal(RailCustomize.description('workspace'), '项目文件树');
      i18nEnv.setCurrentLanguage('en');
      assert.equal(RailCustomize.label('workspace'), 'Structure');
      assert.equal(RailCustomize.description('workspace'), 'Project file tree');
      i18nEnv.setCurrentLanguage('zh');
      assert.equal(RailCustomize.label('unregistered'), 'unregistered');
    });
  });
});

describe('rail drag reorder (mouse immediate, touch long-press)', () => {
  it('persists a new order through the shared rail config, keeping visibility', async () => {
    const harness = buildRailDom(['workspace', 'genui', 'session-controls', 'unlisted']);
    const { fetchStub, calls } = stubUiPrefsFetch({
      presentation: {
        'session-controls': { visible: true, order: 0 },
        genui: { visible: false, order: 1 },
      },
    });
    await withRailSandbox(harness, { fetch: fetchStub }, async ({ RailCustomize }) => {
      await settle();

      RailCustomize.commitRailOrder(['genui', 'session-controls']);

      assert.deepEqual(
        JSON.parse(JSON.stringify(RailCustomize.loadConfig())),
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
  });

  it('reorders rail buttons to the committed order, blocked panels stay after the group', async () => {
    const harness = buildRailDom(['workspace', 'genui', 'session-controls', 'unlisted']);
    await withRailSandbox(harness, {}, ({ RailCustomize }) => {
      RailCustomize.commitRailOrder(['session-controls', 'genui']);

      const panels = harness.document
        .querySelectorAll('.rail-button[data-panel]')
        .filter((btn) => btn.dataset.panel)
        .map((btn) => btn.dataset.panel);
      assert.deepEqual(panels, ['session-controls', 'genui', 'workspace', 'unlisted']);
    });
  });

  it('keeps entries missing from the submitted order at the tail in their prior order', async () => {
    const harness = buildRailDom(['workspace', 'genui', 'session-controls']);
    const { fetchStub, calls } = stubUiPrefsFetch({
      presentation: {
        'session-controls': { visible: false, order: 0 },
        genui: { visible: true, order: 1 },
      },
    });
    await withRailSandbox(harness, { fetch: fetchStub }, async ({ RailCustomize }) => {
      await settle();

      RailCustomize.commitRailOrder(['genui']);

      assert.deepEqual(
        JSON.parse(JSON.stringify(RailCustomize.loadConfig())),
        [
          { id: 'genui', visible: true },
          { id: 'session-controls', visible: false },
        ],
      );
      assert.ok(calls.some((c) => c.method === 'PUT'), '顺序变更落盘服务端');
    });
  });

  it('a real rail pointer drag submits the DOM order to PUT', async () => {
    const harness = buildRailDom(['workspace', 'session-controls', 'genui']);
    const { fetchStub, calls } = stubUiPrefsFetch({
      presentation: {
        'session-controls': { visible: true, order: 0 },
        genui: { visible: true, order: 1 },
      },
    });
    const timers = { scheduled: [] };
    await withRailSandbox(harness, { fetch: fetchStub, timers }, async () => {
      await settle();

      const rail = harness.document.getElementById('right-rail');
      const draggedButton = harness.document.querySelector('.rail-button[data-panel="genui"]');
      draggedButton.dispatch('pointerdown', { button: 0, pointerId: 7, clientX: 10, clientY: 80 });
      const longPress = timers.scheduled.find((callback) => typeof callback === 'function');
      assert.ok(longPress, 'pointerdown 应启动长按拖拽计时器');
      longPress();
      rail.dispatch('pointermove', { pointerId: 7, clientX: 10, clientY: 0 });
      rail.dispatch('pointerup', { pointerId: 7, clientX: 10, clientY: 0 });
      await settle();

      const put = calls.find((call) => call.method === 'PUT');
      assert.ok(put, '真实 pointer 拖动应发出持久化 PUT');
      assert.deepEqual(put.body.presentation['genui'], { visible: true, order: 0 });
      assert.deepEqual(put.body.presentation['session-controls'], { visible: true, order: 1 });
    });
  });

  it('restores the order after a fresh page reads the server response', async () => {
    const persisted = { presentation: {}, panelPrefs: {} };
    const fetchStub = async (_url, options) => {
      if ((options?.method || 'GET') === 'GET') {
        return { ok: true, status: 200, json: async () => ({ prefs: persisted }) };
      }
      persisted.presentation = JSON.parse(options.body).presentation;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    const firstHarness = buildRailDom(['workspace', 'session-controls', 'genui']);
    const timers = { scheduled: [] };
    await withRailSandbox(firstHarness, { fetch: fetchStub, timers }, async () => {
      await settle();
      const rail = firstHarness.document.getElementById('right-rail');
      const draggedButton = firstHarness.document.querySelector('.rail-button[data-panel="genui"]');
      draggedButton.dispatch('pointerdown', { button: 0, pointerId: 8, clientX: 10, clientY: 80 });
      timers.scheduled[0]();
      rail.dispatch('pointermove', { pointerId: 8, clientX: 10, clientY: 0 });
      rail.dispatch('pointerup', { pointerId: 8, clientX: 10, clientY: 0 });
      await settle();

      assert.deepEqual(
        Object.entries(persisted.presentation).sort((a, b) => a[1].order - b[1].order).map(([id]) => id),
        ['genui', 'session-controls'],
        '拖动结果应经 PUT 写入可回读的服务端状态',
      );
    });

    // 新页面：另起一份沙箱 + 模块图（withP2EsmCase 不支持嵌套；先后两个用例体
    // 等价于先后两个页面），按服务端保存的顺序恢复。
    const reloadedHarness = buildRailDom(['workspace', 'session-controls', 'genui']);
    await withRailSandbox(reloadedHarness, { fetch: fetchStub }, async () => {
      await settle();
      assert.deepEqual(
        reloadedHarness.document.getElementById('right-rail').children
          .filter((element) => element.dataset.panel)
          .map((element) => element.dataset.panel),
        ['genui', 'session-controls', 'workspace'],
        '新页面应按服务端保存的顺序恢复面板按钮',
      );
    });
  });

  it('a mouse drag activates immediately on movement past the slop, no long-press needed', async () => {
    const harness = buildRailDom(['workspace', 'session-controls', 'genui']);
    const { fetchStub, calls } = stubUiPrefsFetch({
      presentation: {
        'session-controls': { visible: true, order: 0 },
        genui: { visible: true, order: 1 },
      },
    });
    const timers = { scheduled: [] };
    await withRailSandbox(harness, { fetch: fetchStub, timers }, async () => {
      await settle();
      const rail = harness.document.getElementById('right-rail');
      const draggedButton = harness.document.querySelector('.rail-button[data-panel="genui"]');

      // 自然手势：按下后直接移动，不等长按计时器
      draggedButton.dispatch('pointerdown', { button: 0, pointerId: 9, pointerType: 'mouse', clientX: 10, clientY: 80 });
      rail.dispatch('pointermove', { pointerId: 9, clientX: 10, clientY: 60 });
      assert.ok(
        draggedButton.classList.contains('rail-dragging'),
        '鼠标位移越过 slop 应立即进入拖动态（无需长按）',
      );
      rail.dispatch('pointermove', { pointerId: 9, clientX: 10, clientY: 0 });
      rail.dispatch('pointerup', { pointerId: 9, clientX: 10, clientY: 0 });
      await settle();

      const put = calls.find((call) => call.method === 'PUT');
      assert.ok(put, '自然拖动应发出持久化 PUT');
      assert.deepEqual(put.body.presentation.genui, { visible: true, order: 0 });
      assert.deepEqual(put.body.presentation['session-controls'], { visible: true, order: 1 });
    });
  });

  it('touch pointers keep the long-press gate: moving past the slop cancels instead of dragging', async () => {
    const harness = buildRailDom(['workspace', 'session-controls', 'genui']);
    const { fetchStub, calls } = stubUiPrefsFetch({
      presentation: {
        'session-controls': { visible: true, order: 0 },
        genui: { visible: true, order: 1 },
      },
    });
    const timers = { scheduled: [] };
    await withRailSandbox(harness, { fetch: fetchStub, timers }, async () => {
      await settle();
      const rail = harness.document.getElementById('right-rail');
      const draggedButton = harness.document.querySelector('.rail-button[data-panel="genui"]');

      draggedButton.dispatch('pointerdown', { button: 0, pointerId: 11, pointerType: 'touch', clientX: 10, clientY: 80 });
      rail.dispatch('pointermove', { pointerId: 11, clientX: 10, clientY: 0 });
      assert.ok(!draggedButton.classList.contains('rail-dragging'), '触屏长按前移动应取消（区分滚动手势）');
      rail.dispatch('pointerup', { pointerId: 11, clientX: 10, clientY: 0 });
      await settle();

      assert.ok(!calls.some((call) => call.method === 'PUT'), '未激活的触摸滑动不应落盘');
    });
  });

  it('releasing below the crossing threshold keeps the slot and issues no PUT', async () => {
    const harness = buildRailDom(['workspace', 'session-controls', 'genui']);
    const { fetchStub, calls } = stubUiPrefsFetch({
      presentation: {
        'session-controls': { visible: true, order: 0 },
        genui: { visible: true, order: 1 },
      },
    });
    const timers = { scheduled: [] };
    await withRailSandbox(harness, { fetch: fetchStub, timers }, async () => {
      await settle();
      const rail = harness.document.getElementById('right-rail');
      const draggedButton = harness.document.querySelector('.rail-button[data-panel="genui"]');

      draggedButton.dispatch('pointerdown', { button: 0, pointerId: 12, pointerType: 'mouse', clientX: 10, clientY: 80 });
      timers.scheduled[0](); // 长按激活（grabOffsetY=40）
      rail.dispatch('pointermove', { pointerId: 12, clientX: 10, clientY: 70 }); // 上移 10px，未跨过相邻按钮中点
      rail.dispatch('pointerup', { pointerId: 12, clientX: 10, clientY: 70 });
      await settle();

      const order = rail.children.filter((el) => el.dataset && el.dataset.panel).map((el) => el.dataset.panel);
      assert.deepEqual(order.slice(0, 2), ['session-controls', 'genui'], '槽位保持不变');
      assert.ok(!calls.some((call) => call.method === 'PUT'), '顺序未变化的松手不应发起无效 PUT');
    });
  });

  it('release commits the final pointer position when live reorder missed the crossing', async () => {
    const harness = buildRailDom(['workspace', 'session-controls', 'genui']);
    const { fetchStub, calls } = stubUiPrefsFetch({
      presentation: {
        'session-controls': { visible: true, order: 0 },
        genui: { visible: true, order: 1 },
      },
    });
    const timers = { scheduled: [] };
    await withRailSandbox(harness, { fetch: fetchStub, timers }, async () => {
      await settle();
      const rail = harness.document.getElementById('right-rail');
      const draggedButton = harness.document.querySelector('.rail-button[data-panel="genui"]');
      const sibling = harness.document.querySelector('.rail-button[data-panel="session-controls"]');

      draggedButton.dispatch('pointerdown', { button: 0, pointerId: 13, pointerType: 'mouse', clientX: 10, clientY: 80 });
      timers.scheduled[0](); // 长按激活（grabOffsetY=40）
      // 模拟实时换位漏判：让位动画中途，兄弟按钮的矩形还是过期的（远在上方）
      sibling.getBoundingClientRect = () => ({ top: -400, bottom: -360, height: 40, left: 0, right: 40, width: 40 });
      rail.dispatch('pointermove', { pointerId: 13, clientX: 10, clientY: 0 }); // 实际已跨过中点，但读到的过期矩形错过了
      // 松手前矩形恢复真实值（动画收敛）
      delete sibling.getBoundingClientRect;
      rail.dispatch('pointerup', { pointerId: 13, clientX: 10, clientY: 0 });
      await settle();

      const put = calls.find((call) => call.method === 'PUT');
      assert.ok(put, '松手应按最终指针位置补上漏判的换位并落盘');
      assert.deepEqual(put.body.presentation.genui, { visible: true, order: 0 });
      assert.deepEqual(put.body.presentation['session-controls'], { visible: true, order: 1 });
    });
  });

  it('a drag activated mid-movement anchors to the press point, not the activation point', async () => {
    const harness = buildRailDom(['workspace', 'session-controls', 'beta', 'genui']);
    const { fetchStub, calls } = stubUiPrefsFetch({});
    const timers = { scheduled: [] };
    await withRailSandbox(harness, { fetch: fetchStub, timers }, async ({ ctx, RailCustomize }) => {
      await settle();
      // 第三个可自定义面板按需注册，再排出 [session-controls, beta, genui] 初始序
      ctx.run(`
        window.ClawPanels.register('beta', {
          when: { surfaces: ['chat'] },
          label: { zh: '贝塔', en: 'Beta' },
          render: () => '',
          icon: '<svg viewBox="0 0 24 24"></svg>',
          order: 30,
        });
      `);
      RailCustomize.commitRailOrder(['session-controls', 'beta', 'genui']);
      await settle();
      const rail = harness.document.getElementById('right-rail');
      const draggedButton = harness.document.querySelector('.rail-button[data-panel="genui"]');

      // 按下 genui（clientY 100）→ 途中激活（clientY 60，指针已上移 40px）
      // → 松手位置 30：按"按下点"抓取应归位到 beta 之前；按"激活点"抓取
      // 视觉中心滞后 40px，会留在原位。用户直觉是按钮跟在按下的位置。
      draggedButton.dispatch('pointerdown', { button: 0, pointerId: 14, pointerType: 'mouse', clientX: 10, clientY: 100 });
      rail.dispatch('pointermove', { pointerId: 14, clientX: 10, clientY: 60 });
      rail.dispatch('pointermove', { pointerId: 14, clientX: 10, clientY: 30 });
      rail.dispatch('pointerup', { pointerId: 14, clientX: 10, clientY: 30 });
      await settle();

      const puts = calls.filter((call) => call.method === 'PUT');
      const last = puts[puts.length - 1];
      assert.ok(last, '松手应提交归位后的顺序');
      assert.equal(last.body.presentation.genui.order, 1, 'genui 归位到 beta 之前');
      assert.equal(last.body.presentation.beta.order, 2, 'beta 顺延到 genui 之后');
    });
  });

  it('recovers the saved order when panel buttons render after the initial GET resolved', async () => {
    // 复现真实竞态：页面刷新后停在首页时 GET 返回，此刻 chat 面板按钮
    // 尚未渲染（清单为空）；随后进入会话按钮出现并 applyRailConfig。
    // 保存的顺序必须恢复，否则表现为"刷新后排序丢失"。
    const harness = buildRailDom(['workspace']);
    const { fetchStub } = stubUiPrefsFetch({
      presentation: {
        // 与注册表默认序（session-controls order 20 → genui order 50）相反：
        // 必须是"自定义"顺序，否则 reconcile 的默认补齐会掩盖丢失。
        genui: { visible: true, order: 0 },
        'session-controls': { visible: true, order: 1 },
      },
    });
    await withRailSandbox(harness, { fetch: fetchStub }, async ({ ctx }) => {
      await settle(); // 初始 GET 已解析（此刻清单里没有任何 chat 按钮）

      // 进入会话：chat 面板按钮随后渲染进右栏
      const rail = harness.document.getElementById('right-rail');
      for (const id of ['session-controls', 'genui']) {
        const btn = harness.document.createElement('button');
        btn.className = 'rail-button';
        btn.dataset.panel = id;
        rail.appendChild(btn);
      }
      ctx.run('window.applyRailConfig()');

      const order = rail.children
        .filter((el) => el.dataset && el.dataset.panel)
        .map((el) => el.dataset.panel);
      assert.deepEqual(
        order.slice(0, 2),
        ['genui', 'session-controls'],
        '按钮渲染后重放应恢复服务端保存的自定义顺序，而不是注册表默认序',
      );
    });
  });

  it('a first drag during initial GET is not overwritten by the stale response', async () => {
    const harness = buildRailDom(['workspace', 'genui', 'session-controls']);
    let resolveGet;
    const stored = { presentation: {}, panelPrefs: {} };
    const calls = [];
    const fetchStub = (url, options) => {
      const method = options?.method || 'GET';
      calls.push({ method, body: options?.body ? JSON.parse(options.body) : null });
      if (method === 'GET') {
        return new Promise((resolve) => { resolveGet = () => resolve({ ok: true, json: async () => ({ prefs: stored }) }); });
      }
      stored.presentation = JSON.parse(options.body).presentation;
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    };
    await withRailSandbox(harness, { fetch: fetchStub }, async ({ RailCustomize }) => {
      RailCustomize.commitRailOrder(['genui', 'session-controls']);
      await settle();
      resolveGet();
      await settle();

      assert.deepEqual(
        JSON.parse(JSON.stringify(RailCustomize.loadConfig())).map((entry) => entry.id),
        ['genui', 'session-controls'],
        '旧 GET 返回不得覆盖用户刚提交的顺序',
      );
      assert.equal(calls.filter((call) => call.method === 'PUT').length, 1);
      assert.deepEqual(stored.presentation.genui, { visible: true, order: 0 });
      assert.deepEqual(stored.presentation['session-controls'], { visible: true, order: 1 });
    });
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
    await withRailSandbox(harness, { fetch: fetchStub }, async ({ ctx, agentStore }) => {
      agentStore.setFocusedAgentId('programming-helper');
      ctx.run('window.applyRailConfig()');
      await settle();
      // programming-helper：服务端配置 genui 隐藏
      assert.equal(
        ctx.run(`document.querySelector('.rail-button[data-panel="genui"]').classList.contains('rail-custom-hidden')`),
        true,
      );

      // 切换到 coder：重拉后 genui 恢复可见
      agentStore.setFocusedAgentId('coder');
      ctx.run('window.applyRailConfig()');
      await settle();
      assert.equal(
        ctx.run(`document.querySelector('.rail-button[data-panel="genui"]').classList.contains('rail-custom-hidden')`),
        false,
      );
    });
  });
});

describe('rail customize scopes presentation to the real workspace identity', () => {
  // ADR-0046：呈现配置随工作空间走。全局首页（无聚焦）与各工作空间互不共用，
  // 尤其不允许回退主空间把编程小助手的配置套到别的界面上。
  function createIdentitySandbox(presentationByAgent = {}, fn) {
    const harness = buildRailDom(['genui', 'session-controls']);
    const calls = [];
    const fetchStub = async (url, options) => {
      const method = (options && options.method) || 'GET';
      calls.push({ url: String(url), method, body: options?.body ? JSON.parse(options.body) : null });
      if (method === 'GET') {
        const agentId = decodeURIComponent(String(url).split('agentId=')[1] || '');
        const presentation = presentationByAgent[agentId] || {};
        return { ok: true, status: 200, json: async () => ({ prefs: { presentation, panelPrefs: {} } }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    return withRailSandbox(harness, { fetch: fetchStub }, async (env) => {
      env.ctx.run(`
        function isRemoteNamespaceAgentId(id) {
          return typeof id === 'string' && id.indexOf('remote:') === 0;
        }
      `);
      return fn({ ...env, calls });
    });
  }

  it('falls back to home (not the primary workspace) when no workspace is focused', async () => {
    await createIdentitySandbox({
      'programming-helper': { genui: { visible: false, order: 0 } },
    }, async ({ ctx, calls }) => {
      // 初始即无聚焦（全局首页）：GET home，且不应用主空间配置
      await settle();
      const getCalls = calls.filter((call) => call.method === 'GET');
      assert.ok(getCalls.every((call) => call.url.includes('agentId=home')), JSON.stringify(getCalls));
      assert.equal(
        ctx.run(`document.querySelector('.rail-button[data-panel="genui"]').classList.contains('rail-custom-hidden')`),
        false,
        '首页不得套用编程小助手的隐藏配置',
      );
    });
  });

  it('reads and writes each workspace under its own identity', async () => {
    await createIdentitySandbox({}, async ({ ctx, calls, RailCustomize, agentStore }) => {
      agentStore.setFocusedAgentId('memo');
      ctx.run('window.applyRailConfig()');
      await settle();
      RailCustomize.commitRailOrder(['genui', 'session-controls']);
      await settle();
      const puts = calls.filter((call) => call.method === 'PUT');
      assert.equal(puts.length, 1);
      assert.equal(puts[0].body.agentId, 'memo', 'memo 内的拖动必须写 memo，不落主空间');
      assert.ok(calls.every((call) => !call.url.includes('programming-helper') && !call.url.includes('agentId=programming-helper')));
    });
  });

  it('skips local reads and writes for remote workspaces', async () => {
    await createIdentitySandbox({
      'programming-helper': { genui: { visible: false, order: 0 } },
    }, async ({ ctx, calls, RailCustomize, agentStore }) => {
      // 先进入本地主空间建立已应用的配置
      agentStore.setFocusedAgentId('programming-helper');
      ctx.run('window.applyRailConfig()');
      await settle();
      const getsBeforeRemote = calls.filter((call) => call.method === 'GET').length;
      assert.ok(getsBeforeRemote >= 1);
      // 切到远程空间：不发 GET，清空上一空间配置（genui 恢复默认可见）
      agentStore.setFocusedAgentId('remote:server-a:programming-helper');
      ctx.run('window.applyRailConfig()');
      await settle();
      assert.equal(calls.filter((call) => call.method === 'GET').length, getsBeforeRemote, '远程身份不得发本地 GET');
      assert.equal(
        ctx.run(`document.querySelector('.rail-button[data-panel="genui"]').classList.contains('rail-custom-hidden')`),
        false,
        '远程空间应回默认呈现，不残留本地空间配置',
      );
      // 远程空间内拖动：不落盘
      RailCustomize.commitRailOrder(['genui', 'session-controls']);
      await settle();
      assert.equal(calls.filter((call) => call.method === 'PUT').length, 0, '远程身份不得发本地 PUT');
    });
  });
});

describe('rail customize keeps a single source of panel truth', () => {
  it('no longer hardcodes panel ids, labels, or descriptions', () => {
    const source = fs.readFileSync(new URL('../public/src/modules/rail-customize.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /CUSTOMIZABLE_IDS/);
    assert.doesNotMatch(source, /var LABELS/);
    assert.doesNotMatch(source, /var DESCS/);
  });

  it('offers the config replay through the kernel bridge to classic renderers', () => {
    // P4 L2 之后的时序保证是结构性的：classic script 全部先于模块求值，模块入口
    // （p4-entry）在 boot 之前装载，因此 rail 首次重放配置必然晚于注册表 /
    // app-ui / resources-viewer 的注册。这里钉住「谁通过桥重放」——两个 classic
    // 消费方都必须经 window.applyRailConfig 调用。
    for (const consumer of ['public/src/app-ui.js', 'public/src/modules/debug-panel-host.js']) {
      const source = fs.readFileSync(new URL(`../${consumer}`, import.meta.url), 'utf8');
      assert.match(source, /window\.applyRailConfig\s*\(/, `${consumer} 必须经桥重放 rail 配置`);
    }
  });

  it('replays rail presentation on every main view render (workspace identity switch point)', () => {
    // 进会话/切空间/回首页都经过 renderCurrentMainView；身份切换后的配置重拉
    // 挂在这里（syncRailButtons 只在按钮集合变化时重放，覆盖不了身份变化）。
    const appUi = fs.readFileSync(new URL('../public/src/app-ui.js', import.meta.url), 'utf8');
    const render = appUi.slice(appUi.indexOf('function renderCurrentMainView'));
    assert.match(render, /window\.applyRailConfig\s*\(/, 'renderCurrentMainView 必须调用 applyRailConfig');
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
