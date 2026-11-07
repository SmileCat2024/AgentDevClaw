/**
 * 面板生命周期分发（ADR-0044 P2）行为钉子。
 *
 * 钉什么：toggle 打开/关闭/切换面板时，onOpen / onClose 钩子经注册表
 * 元数据（ClawPanels）分发——打开调 onOpen、关闭调 onClose、切换先旧
 * 面板 onClose 再新面板 onOpen；钩子缺失时开关不抛错；钩子抛错不中断
 * 面板状态切换。此前这些调用是 debug-panel-host 里按面板 ID 硬编码的
 * if 链 + window.XxxPanel 晚绑定，迁移到注册表后行为必须等价。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function makeClassSet() {
  const set = new Set();
  return {
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    toggle(name, force) {
      const enabled = force === undefined ? !set.has(name) : Boolean(force);
      if (enabled) set.add(name); else set.delete(name);
      return enabled;
    },
    contains: (name) => set.has(name),
  };
}

function makeElement() {
  return {
    classList: makeClassSet(),
    style: { setProperty() {} },
    dataset: {},
    children: [],
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); this.children = v ? [{}] : []; },
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    contains: () => false,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    textContent: '',
  };
}

function createPanelHostSandbox() {
  const ctx = createFrontendSandbox({
    document: { activeElement: null, querySelector: () => null, querySelectorAll: () => [] },
    activeFeaturePanel: null,
    featurePanelWidth: 320,
    featurePanel: makeElement(),
    featurePanelBody: makeElement(),
    featurePanelTitle: makeElement(),
    t: (key) => key,
    getFeaturePanelEmptyHtml: () => '',
    enhanceMathInElement: () => {},
    requestAnimationFrame: (fn) => fn(),
  });
  ctx.loadSource('public/src/modules/claw-host.js');
  ctx.loadSource('public/src/modules/right-panel-registry.js');
  ctx.loadSource('public/src/modules/debug-panel-host.js');
  return ctx;
}

/** createPanelHostSandbox 的 rAF 同步化变体：toggle 打开走 deferBody 路径时
 *  commitPanelBody（含容器型 mountBody）同步提交，body 挂载可同步断言。 */
function createSyncPanelHostSandbox() {
  const ctx = createPanelHostSandbox();
  ctx.run('window.requestAnimationFrame = (fn) => fn();');
  return ctx;
}

/** 注册带生命周期钩子的面板；调用日志挂 window.__panelCalls（按序记录）。 */
function registerTracedPanels(ctx, ids) {
  ctx.run('window.__panelCalls = [];');
  for (const id of ids) {
    ctx.run(`
      window.ClawPanels.register(${JSON.stringify(id)}, {
        when: { surfaces: ['chat'] },
        title: () => ${JSON.stringify(id)},
        render: () => '<div></div>',
        onOpen: () => window.__panelCalls.push(${JSON.stringify(id + ':onOpen')}),
        onClose: () => window.__panelCalls.push(${JSON.stringify(id + ':onClose')}),
      });
    `);
  }
}

test('toggle 打开面板时经注册表调用 onOpen，关闭时调用 onClose', () => {
  const ctx = createPanelHostSandbox();
  const calls = registerTracedPanels(ctx, ['git']);
  ctx.run('window.__panelCalls = [];');
  ctx.run('toggleFeaturePanel("git");');
  assert.deepEqual([...ctx.run('window.__panelCalls')], ['git:onOpen']);
  assert.equal(ctx.run('activeFeaturePanel'), 'git');
  ctx.run('window.__panelCalls = [];');
  ctx.run('toggleFeaturePanel("git");');
  assert.deepEqual([...ctx.run('window.__panelCalls')], ['git:onClose']);
  assert.equal(ctx.run('activeFeaturePanel'), null);
});

test('切换面板时先关旧面板 onClose，再开新面板 onOpen', () => {
  const ctx = createPanelHostSandbox();
  registerTracedPanels(ctx, ['bg', 'genui']);
  ctx.run('window.__panelCalls = [];');
  ctx.run('toggleFeaturePanel("bg");');
  ctx.run('window.__panelCalls = [];');
  ctx.run('toggleFeaturePanel("genui");');
  // 顺序是承诺：先 bg:onClose（旧面板收尾，如断开订阅）再 genui:onOpen
  assert.deepEqual([...ctx.run('window.__panelCalls')], ['bg:onClose', 'genui:onOpen']);
  assert.equal(ctx.run('activeFeaturePanel'), 'genui');
});

test('无生命周期钩子的面板正常开关，不抛错', () => {
  const ctx = createPanelHostSandbox();
  ctx.run(`
    window.ClawPanels.register('plain', {
      when: { surfaces: ['chat'] },
      title: () => 'plain',
      render: () => '<div></div>',
    });
  `);
  ctx.run('toggleFeaturePanel("plain");');
  assert.equal(ctx.run('activeFeaturePanel'), 'plain');
  ctx.run('toggleFeaturePanel("plain");');
  assert.equal(ctx.run('activeFeaturePanel'), null);
});

test('生命周期钩子抛错不中断面板状态切换', () => {
  const ctx = createPanelHostSandbox();
  const errors = [];
  const origError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    ctx.run(`
      window.ClawPanels.register('boom', {
        when: { surfaces: ['chat'] },
        title: () => 'boom',
        render: () => '<div></div>',
        onOpen: () => { throw new Error('boom-onOpen'); },
      });
    `);
    ctx.run('toggleFeaturePanel("boom");');
    assert.equal(ctx.run('activeFeaturePanel'), 'boom', 'onOpen 抛错后面板仍应打开');
    assert.ok(errors.length >= 1, '钩子异常应被记录');
  } finally {
    console.error = origError;
  }
});

// ═══════════════════════════════════════════════════════════════
// syncRailButtons（ADR-0044 P2b）：rail 按钮从注册表派生
// ═══════════════════════════════════════════════════════════════

import { createDomHarness } from './helpers/dom-harness.js';

function createRailHostSandbox() {
  const harness = createDomHarness();
  const rail = harness.document.createElement('aside');
  rail.id = 'right-rail';
  const spacer = harness.document.createElement('div');
  spacer.className = 'rail-spacer';
  rail.appendChild(spacer);
  harness.document.body.appendChild(rail);
  const ctx = createFrontendSandbox({
    document: harness.document,
    activeFeaturePanel: null,
    featurePanelWidth: 320,
    featurePanel: makeElement(),
    featurePanelBody: makeElement(),
    featurePanelTitle: makeElement(),
    t: (key) => key,
    getFeaturePanelEmptyHtml: () => '',
    enhanceMathInElement: () => {},
    requestAnimationFrame: (fn) => fn(),
  });
  ctx.loadSource('public/src/modules/claw-host.js');
  ctx.loadSource('public/src/modules/right-panel-registry.js');
  ctx.loadSource('public/src/modules/debug-panel-host.js');
  return { ctx, rail };
}

test('syncRailButtons 为带 icon 的注册面板生成按钮，无 icon 的不生成', () => {
  const { ctx, rail } = createRailHostSandbox();
  ctx.run(`
    window.ClawPanels.register('git', {
      when: { surfaces: ['chat'] },
      label: { zh: '源代码管理', en: 'Source Control' },
      title: () => '源代码管理',
      render: () => '',
      icon: '<svg viewBox="0 0 24 24"></svg>',
      order: 30,
      badge: true,
    });
    window.ClawPanels.register('preflight', {
      when: { surfaces: ['chat'] },
      title: () => '装配预检',
      render: () => '',
    });
  `);
  ctx.run('syncRailButtons();');
  const gitBtn = ctx.run(`document.getElementById('rail-git')`);
  assert.ok(gitBtn, '带 icon 的面板应生成按钮');
  assert.equal(gitBtn.dataset.panel, 'git');
  assert.equal(gitBtn.title, '源代码管理', 'title 从 label 派生（zh）');
  assert.ok(!ctx.run(`document.getElementById('rail-preflight')`), '无 icon 的面板不生成按钮');
  // 注：按钮 HTML 内容（icon SVG / badge span）不经本沙箱断言——dom-harness
  // 的 innerHTML setter 不解析子树；视觉内容归浏览器冒烟验证。
});

test('面板从注册表摘除后按钮消失，语言切换后 title 重算', () => {
  const { ctx } = createRailHostSandbox();
  ctx.run(`
    window.ClawPanels.register('git', {
      when: { surfaces: ['chat'] },
      label: { zh: '源代码管理', en: 'Source Control' },
      title: () => '源代码管理',
      render: () => '',
      icon: '<svg></svg>',
      order: 30,
    });
    syncRailButtons();
  `);
  // 语言切换：currentLanguage 影响标题派生
  ctx.run('currentLanguage = "en"; syncRailButtons();');
  assert.equal(ctx.run(`document.getElementById('rail-git').title`), 'Source Control');
  // 摘除面板（模拟插件卸载）：unregister 后 sync，按钮应消失
  ctx.run('window.ClawHost.panels.unregister("git"); syncRailButtons();');
  assert.ok(!ctx.run(`document.getElementById('rail-git')`), '面板摘除后其 rail 按钮应被清理');
});

test('syncRailButtons 按钮集合变化后重放 rail-customize 配置，无变化不重放', () => {
  // 回归锚：按钮动态化后，rail-customize 的初始化早于首次按钮生成，
  // 用户自定义排序/可见性与 custBtn 归位若不重放，会出现「用户隐藏的
  // 面板重新显示」「自定义面板按钮滞留 rail 顶部」两类回归。
  const { ctx } = createRailHostSandbox();
  ctx.run(`
    window.__applyCalls = 0;
    window.applyRailConfig = () => { window.__applyCalls++; };
    window.ClawPanels.register('git', {
      when: { surfaces: ['chat'] },
      label: { zh: '源代码管理', en: 'Source Control' },
      title: () => '源代码管理',
      render: () => '',
      icon: '<svg></svg>',
      order: 30,
    });
  `);
  ctx.run('syncRailButtons();');
  assert.equal(ctx.run('window.__applyCalls'), 1, '首次生成按钮（集合变化）应重放 rail 配置');
  ctx.run('syncRailButtons(); syncRailButtons();');
  assert.equal(ctx.run('window.__applyCalls'), 1, '集合无变化（幂等调用）不应重放');
  ctx.run('window.ClawHost.panels.unregister("git"); syncRailButtons();');
  assert.equal(ctx.run('window.__applyCalls'), 2, '按钮摘除（集合变化）应再次重放');
});

// ── 容器型面板（ADR-0044 P2c）──────────────────────────────────────
// 钉什么：mountBody 型面板的 body 渲染权移交——打开挂载、轮询重渲染
// no-op、切换/关闭卸载且 unmountBody 必被调用、innerHTML 路径不触碰
// 其 DOM；卸载回调抛错不阻断容器收回。这是 React 类插件进右栏的通道。

function registerContainerPanels(ctx) {
  ctx.run('window.__clog = [];');
  ctx.run(`
    window.ClawPanels.register('island', {
      when: { surfaces: ['chat'] },
      title: () => '容器面板',
      // 注意：无 render —— 容器型面板不提供 HTML 字符串
      mountBody(bodyEl, ctxInfo) {
        window.__clog.push('mount:' + ctxInfo.panelId);
        bodyEl.innerHTML = '<div data-island></div>';
      },
      unmountBody() { window.__clog.push('unmount'); },
    });
    window.ClawPanels.register('plain', {
      when: { surfaces: ['chat'] },
      title: () => '字符串面板',
      render: () => '<div data-plain></div>',
    });
  `);
}

test('容器面板打开时 mountBody 收到 body 容器与 panelId，轮询重渲染不重复挂载', () => {
  const ctx = createSyncPanelHostSandbox();
  registerContainerPanels(ctx);
  ctx.run('toggleFeaturePanel("island");');
  assert.equal(ctx.run('window.__clog.join(",")'), 'mount:island');
  assert.equal(ctx.run('featurePanelBody.innerHTML'), '<div data-island></div>',
    'body DOM 由 mountBody 全权构建');
  // 轮询触发的重渲染（同面板）：mountBody 不再调用，DOM 不被触碰
  ctx.run('renderFeaturePanel(); renderFeaturePanel();');
  assert.equal(ctx.run('window.__clog.join(",")'), 'mount:island', '重渲染不得重复挂载或卸载');
  assert.equal(ctx.run('featurePanelBody.innerHTML'), '<div data-island></div>',
    '重渲染不得触碰容器面板的 DOM');
});

test('容器面板切换到字符串面板：unmountBody 先清理，body 随后被 render HTML 接管', () => {
  const ctx = createSyncPanelHostSandbox();
  registerContainerPanels(ctx);
  ctx.run('toggleFeaturePanel("island"); toggleFeaturePanel("plain");');
  assert.equal(ctx.run('window.__clog.join(",")'), 'mount:island,unmount',
    '切换时容器面板必须收到 unmountBody（innerHTML 路径会销毁其 DOM，先给清理机会）');
  assert.equal(ctx.run('featurePanelBody.innerHTML'), '<div data-plain></div>');
});

test('容器面板关闭：unmountBody 被调用，body 收回回空态', () => {
  const ctx = createSyncPanelHostSandbox();
  registerContainerPanels(ctx);
  ctx.run('toggleFeaturePanel("island"); toggleFeaturePanel("island");');
  assert.equal(ctx.run('window.__clog.join(",")'), 'mount:island,unmount');
  assert.equal(ctx.run('featurePanelBody.innerHTML'), '', '关闭后宿主收回容器');
  assert.equal(ctx.run('featurePanel.classList.contains("open")'), false);
});

test('unmountBody 抛错不阻断容器收回与后续面板状态', () => {
  const ctx = createSyncPanelHostSandbox();
  ctx.run(`
    window.__clog = [];
    window.ClawPanels.register('bad', {
      when: { surfaces: ['chat'] },
      title: () => '坏面板',
      mountBody(bodyEl) { window.__clog.push('mount'); bodyEl.innerHTML = '<div></div>'; },
      unmountBody() { window.__clog.push('unmount-throw'); throw new Error('cleanup boom'); },
    });
  `);
  ctx.run('toggleFeaturePanel("bad");');
  assert.doesNotThrow(() => ctx.run('toggleFeaturePanel("bad");'), '卸载回调抛错不得炸面板编排');
  assert.equal(ctx.run('window.__clog.join(",")'), 'mount,unmount-throw');
  assert.equal(ctx.run('featurePanelBody.innerHTML'), '', '抛错后宿主仍收回容器');
});

test('mountBody 抛错不僵尸化：不挂幽灵 unmount，面板状态可继续流转', () => {
  const ctx = createSyncPanelHostSandbox();
  ctx.run(`
    window.__clog = [];
    window.ClawPanels.register('boom', {
      when: { surfaces: ['chat'] },
      title: () => '挂载失败',
      mountBody() { window.__clog.push('mount-throw'); throw new Error('mount boom'); },
      unmountBody() { window.__clog.push('unmount-should-not-run'); },
    });
  `);
  ctx.run('toggleFeaturePanel("boom");');
  assert.equal(ctx.run('window.__clog.join(",")'), 'mount-throw', '挂载失败后不得调幽灵 unmount');
  // 状态可继续流转：切到字符串面板正常渲染
  ctx.run(`
    window.ClawPanels.register('plain2', {
      when: { surfaces: ['chat'] },
      title: () => '恢复',
      render: () => '<div data-recovered></div>',
    });
    toggleFeaturePanel('plain2');
  `);
  assert.equal(ctx.run('featurePanelBody.innerHTML'), '<div data-recovered></div>');
});
