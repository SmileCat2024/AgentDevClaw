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
  // 容器无留白契约：字符串面板内容由宿主包在 .feature-panel-content 内容层
  assert.equal(ctx.run('featurePanelBody.innerHTML'),
    '<div class="feature-panel-content"><div data-plain></div></div>');
});

test('fullBleed 字符串面板不吃内容层包装（自带边距设计的全幅面板）', () => {
  const ctx = createSyncPanelHostSandbox();
  ctx.run(`
    window.ClawPanels.register('edge', {
      when: { surfaces: ['chat'] },
      title: () => '全幅',
      fullBleed: true,
      render: () => '<div data-edge></div>',
    });
  `);
  ctx.run('toggleFeaturePanel("edge");');
  assert.equal(ctx.run('featurePanelBody.innerHTML'), '<div data-edge></div>',
    'fullBleed 面板直接占用 body，不包 .feature-panel-content');
});

test('容器面板关闭：unmountBody 被调用，body 收回回空态', () => {
  const ctx = createSyncPanelHostSandbox();
  registerContainerPanels(ctx);
  ctx.run('toggleFeaturePanel("island"); toggleFeaturePanel("island");');
  assert.equal(ctx.run('window.__clog.join(",")'), 'mount:island,unmount');
  // 容器无留白契约：关闭后 body 由宿主空态接管（空态经内容层展示；沙箱
  // stub 的空态为空串，故 body 只余空内容层）。面板 DOM 必须清除。
  assert.equal(ctx.run('featurePanelBody.innerHTML'), '<div class="feature-panel-content"></div>',
    '关闭后宿主收回容器，body 只余空态内容层');
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
  assert.equal(ctx.run('featurePanel.classList.contains("open")'), false, '抛错后宿主仍收回容器');
  // 收回的容器可被后续面板正常接管（状态可继续流转）
  ctx.run(`
    window.ClawPanels.register('plain-after-bad', {
      when: { surfaces: ['chat'] },
      title: () => '恢复',
      render: () => '<div data-recovered-from-bad></div>',
    });
    toggleFeaturePanel('plain-after-bad');
  `);
  assert.equal(ctx.run('featurePanelBody.innerHTML'),
    '<div class="feature-panel-content"><div data-recovered-from-bad></div></div>',
    '抛错后容器仍可被后续面板接管');
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
  // 容器无留白契约：恢复渲染同样包内容层
  assert.equal(ctx.run('featurePanelBody.innerHTML'),
    '<div class="feature-panel-content"><div data-recovered></div></div>');
});

// ═══════════════════════════════════════════════════════════════
// 懒面板按需装载（ADR-0044 P3）
// ═══════════════════════════════════════════════════════════════

test('懒面板声明后 stub 立即可寻址（按钮与显隐过滤在实现装载前可用）', () => {
  const ctx = createPanelHostSandbox();
  ctx.run(`
    window.ClawHost.panels.declare('lazy-demo', {
      when: { surfaces: ['chat'] },
      title: () => '懒面板',
      icon: '<svg></svg>', order: 30,
    }, { pluginId: 'panel-lazy-demo', url: '/src/panel-plugins/lazy-demo.js' });
  `);
  assert.ok(ctx.run('window.ClawPanels.has("lazy-demo")'), 'stub 应已注册');
  const stub = ctx.run('window.ClawPanels.get("lazy-demo")');
  assert.ok(stub.stub, 'stub 条目应带 stub 标记');
  assert.equal(stub.stub.pluginId, 'panel-lazy-demo');
  assert.ok(!stub.render && !stub.mountBody, 'stub 不带实现');
  const available = ctx.run('window.ClawPanels.getAvailable({ surface: "chat" })');
  assert.ok(available.some((p) => p.id === 'lazy-demo'), 'stub 进可用面板清单（按钮可生成）');
});

test('打开懒面板显示装载占位；装载失败显式错误态且不自动重试', async () => {
  const ctx = createSyncPanelHostSandbox();
  ctx.run(`
    window.ClawHost.panels.declare('lazy-fail', {
      when: { surfaces: ['chat'] },
      title: () => '会失败',
    }, { pluginId: 'panel-lazy-fail', url: '/definitely/missing.js' });
    toggleFeaturePanel('lazy-fail');
  `);
  assert.match(ctx.run('featurePanelBody.innerHTML'), /panel_lazy_loading/,
    '打开时应显示装载占位');
  // ensurePlugin 异步落定（import 失败）→ failed；等微任务池排空
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.run('window.ClawHost.getPluginLoadState("panel-lazy-fail")'), 'failed');
  ctx.run('renderFeaturePanel();');
  assert.match(ctx.run('featurePanelBody.innerHTML'), /panel_lazy_failed/,
    '失败后重渲染应显示显式错误态');
  // 不自动重试：failed 态下 ensurePlugin 返回 false
  assert.equal(
    ctx.run('window.ClawHost.ensurePlugin("panel-lazy-fail", "/definitely/missing.js")'),
    false,
    'failed 后不得自动重试',
  );
});

test('实现装载后 real 替换 stub，渲染切真内容；卸载后 stub 恢复可再装载', async () => {
  const ctx = createSyncPanelHostSandbox();
  ctx.run(`
    window.ClawHost.panels.declare('lazy-ok', {
      when: { surfaces: ['chat'] },
      title: () => '懒面板',
    }, { pluginId: 'panel-lazy-ok', url: '/src/panel-plugins/lazy-ok.js' });
    toggleFeaturePanel('lazy-ok');
  `);
  assert.match(ctx.run('featurePanelBody.innerHTML'), /panel_lazy_loading/);
  // 模拟模块装载落定（activatePlugin 是 ensurePlugin 内部同一条注册路径）
  await ctx.run(`
    window.ClawHost.activatePlugin('panel-lazy-ok', {
      id: 'panel-lazy-ok',
      panels: {
        'lazy-ok': {
          when: { surfaces: ['chat'] },
          title: () => '真实面板',
          render: () => '<div data-lazy-real>已装载</div>',
        },
      },
    });
  `);
  const real = ctx.run('window.ClawPanels.get("lazy-ok")');
  assert.ok(!real.stub && typeof real.render === 'function', 'real 应替换 stub');
  assert.equal(real.owner, 'panel-lazy-ok', 'real 归属插件 owner');
  ctx.run('renderFeaturePanel();');
  assert.match(ctx.run('featurePanelBody.innerHTML'), /data-lazy-real/,
    '装载落定后渲染切真内容');
  // 卸载：real 摘除、stub 恢复、loadState 清空（可再次装载）
  await ctx.run('window.ClawHost.unloadPlugin("panel-lazy-ok");');
  const restored = ctx.run('window.ClawPanels.get("lazy-ok")');
  assert.ok(restored && restored.stub, '卸载后 stub 应回到占位态');
  assert.equal(ctx.run('window.ClawHost.getPluginLoadState("panel-lazy-ok")'), null,
    '卸载后 loadState 应清空（渲染路径可重新拉起）');
  // 再次装载成功（loadState 清空使 ensurePlugin 可再发起）
  await ctx.run(`
    window.ClawHost.activatePlugin('panel-lazy-ok', {
      id: 'panel-lazy-ok',
      panels: { 'lazy-ok': { render: () => '<div data-lazy-real-2></div>' } },
    });
  `);
  assert.ok(!ctx.run('window.ClawPanels.get("lazy-ok")').stub, 'stub 面板可再次装载');
});

test('real 之间的注册冲突保护不变（stub→real 是唯一替换路径）', () => {
  const ctx = createPanelHostSandbox();
  ctx.run(`
    window.ClawPanels.register('dup', { render: () => '' });
  `);
  assert.throws(
    () => ctx.run('window.ClawPanels.register("dup", { render: () => "" })'),
    /already registered/,
    '两个 real 抢同一面板仍是冲突',
  );
  // 声明已注册 real 的 id 为懒面板也应被拒
  assert.throws(
    () => ctx.run('window.ClawHost.panels.declare("dup", {}, { pluginId: "p", url: "/u.js" })'),
    /already registered/,
  );
});

test('过期装载落定不得污染已卸载插件的 loadState（懒面板卸载后再打开不卡死）', async () => {
  const ctx = createSyncPanelHostSandbox();
  ctx.run(`
    window.ClawHost.panels.declare('lazy-race', {
      when: { surfaces: ['chat'] },
      title: () => '竞态',
    }, { pluginId: 'panel-lazy-race', url: '/missing-race.js' });
    toggleFeaturePanel('lazy-race');
  `);
  // loading 中插件被显式装载又卸载（loadState 已清空），import 失败才姗姗来迟
  await ctx.run(`
    window.ClawHost.activatePlugin('panel-lazy-race', {
      id: 'panel-lazy-race',
      panels: { 'lazy-race': { render: () => '<div></div>' } },
    });
  `);
  await ctx.run('window.ClawHost.unloadPlugin("panel-lazy-race");');
  await new Promise((resolve) => setImmediate(resolve)); // 过期落定在此之后到达
  assert.notEqual(
    ctx.run('window.ClawHost.getPluginLoadState("panel-lazy-race")'),
    'failed',
    '卸载后的过期失败落定不得写入 failed（否则 stub 被拦截、懒面板卡死）',
  );
});

// ═══════════════════════════════════════════════════════════════
// 懒面板装载落定联动（ADR-0044 P3 / P4 迁移事故回归）
// ═══════════════════════════════════════════════════════════════
// 背景：git 面板模块导出 id:'git' 与清单 pluginId 'panel-git' 不一致——
// activatePlugin 以 mod.id 作 owner，落定回调按 owner===pluginId 匹配失败，
// 首开永远卡在 loading 占位；且 stub 期 onOpen 是 no-op，落定后无人补发。
// 下面两测试分别钉住「清单契约」与「落定链路」。

test('清单声明的 pluginId 必须与实现模块 default export 的 id 一致', () => {
  const manifest = fs.readFileSync(
    new URL('../public/src/modules/panel-plugins.js', import.meta.url), 'utf8');
  const entries = [...manifest.matchAll(/pluginId:\s*'([^']+)'\s*,\s*url:\s*'([^']+)'/g)];
  assert.ok(entries.length >= 2, '至少应有两个已迁移的懒面板声明');
  for (const [, pluginId, url] of entries) {
    // 只核对手写实现模块（panel-plugins/）；React 等构建产物是打包格式，
    // 模块 id 无法用源码字面量核对，其一致性由装载后的运行行为保证
    if (!url.startsWith('/src/panel-plugins/')) continue;
    const filePath = new URL('../public' + url, import.meta.url);
    const src = fs.readFileSync(filePath, 'utf8');
    const decl = src.indexOf('export default {');
    assert.ok(decl >= 0, `${url} 应有 default export 声明块`);
    const head = src.slice(decl, decl + 600);
    const idMatch = head.match(/id:\s*'([^']+)'/);
    assert.ok(idMatch, `${url} default export 应声明 id`);
    assert.equal(idMatch[1], pluginId,
      `${url} 模块 id '${idMatch[1]}' 与清单 pluginId '${pluginId}' 不一致`
      + '——owner 匹配失败会让懒面板首开卡在 loading 占位');
  }
});

/** 打开懒面板并同步激活真实现：vm 里动态 import 必然失败（Node 门禁），
 *  但 toggle 的 import 拒绝只挂在微任务队列——在其落定前同步 activatePlugin
 *  注册 real（loaded 表就位），落定（catch 分支）驱动同一条
 *  notifyLoadSettled → 编排层回调链。回调对 then/catch 落定无分支差异，
 *  成功装载的真实链路在此等价驱动。moduleId 与 pluginId 不一致即事故形态。 */
function openLazyPanelWithRealModule(ctx, { pluginId, panelId, moduleId, realHtml, onOpen }) {
  ctx.run(`
    window.__panelCalls = [];
    window.ClawHost.panels.declare(${JSON.stringify(panelId)}, {
      when: { surfaces: ['chat'] },
      title: () => '懒面板',
    }, { pluginId: ${JSON.stringify(pluginId)}, url: '/src/panel-plugins/${panelId}.js' });
    toggleFeaturePanel(${JSON.stringify(panelId)});
    window.ClawHost.activatePlugin(${JSON.stringify(pluginId)}, {
      id: ${JSON.stringify(moduleId)},
      panels: {
        ${JSON.stringify(panelId)}: {
          when: { surfaces: ['chat'] },
          title: () => '真实面板',
          render: () => ${JSON.stringify(realHtml)},${onOpen ? `
          onOpen: () => window.__panelCalls.push(${JSON.stringify(panelId + ':onOpen')}),` : ''}
        },
      },
    });
  `);
  // activatePlugin 是异步函数但 happy path 无 await：同步段内完成 stub→real
}

test('装载落定自动切真内容并补发 onOpen（owner 匹配是重渲染前提）', async () => {
  const ctx = createSyncPanelHostSandbox();
  openLazyPanelWithRealModule(ctx, {
    pluginId: 'panel-lazy-live', panelId: 'lazy-live', moduleId: 'panel-lazy-live',
    realHtml: '<div data-lazy-live-real>已装载</div>', onOpen: true,
  });
  // toggle 打开：stub 无 onOpen 钩子，此时不得有生命周期调用
  assert.match(ctx.run('featurePanelBody.innerHTML'), /panel_lazy_loading/);
  assert.deepEqual([...ctx.run('window.__panelCalls')], [],
    'stub 期 onOpen 落在占位元数据上，必须是 no-op');
  // 装载落定（微任务排空后 notifyLoadSettled → 编排层回调）
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(ctx.run('featurePanelBody.innerHTML'), /data-lazy-live-real/,
    '落定后无需再 toggle，回调应自动把占位换成真内容（首开卡占位回归）');
  assert.deepEqual([...ctx.run('window.__panelCalls')], ['lazy-live:onOpen'],
    'stub→real 落定应补发一次 onOpen（auto-refresh 等随打开启动的资源）');
});

test('模块 id 与 pluginId 不一致时落定回调不认领（该形态被清单契约测试拦截）', async () => {
  const ctx = createSyncPanelHostSandbox();
  openLazyPanelWithRealModule(ctx, {
    pluginId: 'panel-lazy-wrong', panelId: 'lazy-wrong', moduleId: 'wrong-owner',
    realHtml: '<div data-lazy-wrong-real></div>',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(ctx.run('featurePanelBody.innerHTML'), /panel_lazy_loading/,
    'owner 不匹配时回调不重渲染——占位滞留即首开卡死形态');
});
