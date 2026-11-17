/**
 * 面板生命周期分发（ADR-0044 P2）行为钉子 —— P4 T2 批次后走真实 import 路线。
 *
 * 钉什么：toggle 打开/关闭/切换面板时，onOpen / onClose 钩子经注册表
 * 元数据（ClawPanels）分发——打开调 onOpen、关闭调 onClose、切换先旧
 * 面板 onClose 再新面板 onOpen；钩子缺失时开关不抛错；钩子抛错不中断
 * 面板状态切换。
 *
 * 装载路线（debug-panel-host 已转 ESM）：一个用例 = 一份真实 classic 沙箱
 * （action-dispatcher / claw-host / right-panel-registry / app-core）+
 * 真实 import 的 debug-panel-host。面板 body 与 rail 元素由
 * dom-harness 的真实节点树提供（DOM 引用在 app-core 装载期被捕获）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Renderer } from 'marked';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { createDomHarness } from './helpers/dom-harness.js';

const PANEL_HOST = 'public/src/modules/debug-panel-host.js';
const markedStub = { Renderer, setOptions() {} };

/** 面板宿主用到的 DOM 引用（id 与 index.html 一致）+ rail 容器。 */
function createDocumentHarness() {
  const harness = createDomHarness();
  const document = harness.document;
  const nodes = new Map();
  for (const id of ['feature-panel', 'feature-panel-title', 'feature-panel-body', 'right-rail']) {
    const el = document.createElement('div');
    el.id = id;
    document.body.appendChild(el);
    nodes.set(id, el);
  }
  // dom-harness 的 style 是普通对象：面板宿主经 setProperty 写面板宽度变量。
  for (const el of nodes.values()) el.style.setProperty = () => {};
  // dom-harness 的 innerHTML 只记录空串（它的用例断言子节点树）。面板宿主的
  // 字符串面板路径以 innerHTML 为渲染出口，这里给面板 / body / 标题三个节点
  // 装可读写的 innerHTML（子节点只做一个占位，供「body 非空」判定使用）。
  for (const id of ['feature-panel', 'feature-panel-title', 'feature-panel-body']) {
    const el = nodes.get(id);
    Object.defineProperty(el, 'innerHTML', {
      configurable: true,
      get() { return this._html ?? ''; },
      set(value) {
        this._html = String(value ?? '');
        this.children = this._html ? [{ children: [], dataset: {}, classList: { contains: () => false } }] : [];
      },
    });
  }
  const spacer = document.createElement('div');
  spacer.className = 'rail-spacer';
  nodes.get('right-rail').appendChild(spacer);
  return { harness, document, nodes };
}

/**
 * 一个用例 = 一份 classic 沙箱 + 真实 import 的面板宿主。
 * `classic` 钩子在标准先行链之后追加用例专用装载（如 rail-customize 替身）。
 */
async function withPanelHost(fn, { beforeModules } = {}) {
  const dom = createDocumentHarness();
  return withP2EsmCase({
    globals: {
      marked: markedStub,
      hljs: { getLanguage: () => null },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      document: dom.document,
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      requestAnimationFrame: (callback) => { callback(); return 0; },
    },
    classic: (sandbox) => {
      sandbox.window.marked = markedStub;
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      sandbox.loadSource('public/src/modules/claw-host.js');
      sandbox.loadSource('public/src/modules/right-panel-registry.js');
      sandbox.loadSource('public/src/modules/session-view-state.js');
      sandbox.loadSource('public/src/app-core.js');
      // 打开面板的 deferBody 路径经双 rAF 提交：本文件同步化 rAF，body 挂载可同步断言。
      sandbox.requestAnimationFrame = (callback) => { callback(); return 0; };
      sandbox.window.requestAnimationFrame = sandbox.requestAnimationFrame;
      if (typeof beforeModules === 'function') beforeModules(sandbox);
    },
  }, async (c) => {
    const mod = await c.load(PANEL_HOST);
    return fn({
      c,
      mod,
      window: c.window,
      panel: dom.nodes.get('feature-panel'),
      panelBody: dom.nodes.get('feature-panel-body'),
      panelTitle: dom.nodes.get('feature-panel-title'),
      rail: dom.nodes.get('right-rail'),
      document: dom.document,
    });
  });
}

/** 注册带生命周期钩子的面板；调用日志按序记在 case 数组里。 */
function registerTracedPanels(c, calls, ids) {
  for (const id of ids) {
    c.window.ClawPanels.register(id, {
      when: { surfaces: ['chat'] },
      title: () => id,
      render: () => '<div></div>',
      onOpen: () => calls.push(id + ':onOpen'),
      onClose: () => calls.push(id + ':onClose'),
    });
  }
}

test('toggle 打开面板时经注册表调用 onOpen，关闭时调用 onClose', async () => {
  await withPanelHost(async ({ c, mod }) => {
    const calls = [];
    registerTracedPanels(c, calls, ['git']);
    mod.toggleFeaturePanel('git');
    assert.deepEqual(calls, ['git:onOpen']);
    assert.equal(c.window.activeFeaturePanel, 'git');
    calls.length = 0;
    mod.toggleFeaturePanel('git');
    assert.deepEqual(calls, ['git:onClose']);
    assert.equal(c.window.activeFeaturePanel, null);
  });
});

test('切换面板时先关旧面板 onClose，再开新面板 onOpen', async () => {
  await withPanelHost(async ({ c, mod }) => {
    const calls = [];
    registerTracedPanels(c, calls, ['bg', 'genui']);
    mod.toggleFeaturePanel('bg');
    calls.length = 0;
    mod.toggleFeaturePanel('genui');
    // 顺序是承诺：先 bg:onClose（旧面板收尾，如断开订阅）再 genui:onOpen
    assert.deepEqual(calls, ['bg:onClose', 'genui:onOpen']);
    assert.equal(c.window.activeFeaturePanel, 'genui');
  });
});

test('无生命周期钩子的面板正常开关，不抛错', async () => {
  await withPanelHost(async ({ c, mod }) => {
    c.window.ClawPanels.register('plain', {
      when: { surfaces: ['chat'] },
      title: () => 'plain',
      render: () => '<div></div>',
    });
    mod.toggleFeaturePanel('plain');
    assert.equal(c.window.activeFeaturePanel, 'plain');
    mod.toggleFeaturePanel('plain');
    assert.equal(c.window.activeFeaturePanel, null);
  });
});

test('生命周期钩子抛错不中断面板状态切换', async () => {
  await withPanelHost(async ({ c, mod }) => {
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args);
    try {
      c.window.ClawPanels.register('boom', {
        when: { surfaces: ['chat'] },
        title: () => 'boom',
        render: () => '<div></div>',
        onOpen: () => { throw new Error('boom-onOpen'); },
      });
      mod.toggleFeaturePanel('boom');
      assert.equal(c.window.activeFeaturePanel, 'boom', 'onOpen 抛错后面板仍应打开');
      assert.ok(errors.length >= 1, '钩子异常应被记录');
    } finally {
      console.error = origError;
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// syncRailButtons（ADR-0044 P2b）：rail 按钮从注册表派生
// ═══════════════════════════════════════════════════════════════

test('syncRailButtons 为带 icon 的注册面板生成按钮，无 icon 的不生成', async () => {
  await withPanelHost(async ({ c, mod, document }) => {
    c.window.ClawPanels.register('git', {
      when: { surfaces: ['chat'] },
      label: { zh: '源代码管理', en: 'Source Control' },
      title: () => '源代码管理',
      render: () => '',
      icon: '<svg viewBox="0 0 24 24"></svg>',
      order: 30,
      badge: true,
    });
    c.window.ClawPanels.register('preflight', {
      when: { surfaces: ['chat'] },
      title: () => '装配预检',
      render: () => '',
    });
    mod.syncRailButtons();
    const gitBtn = document.getElementById('rail-git');
    assert.ok(gitBtn, '带 icon 的面板应生成按钮');
    assert.equal(gitBtn.dataset.panel, 'git');
    assert.equal(gitBtn.title, '源代码管理', 'title 从 label 派生（zh）');
    assert.ok(!document.getElementById('rail-preflight'), '无 icon 的面板不生成按钮');
    // 注：按钮 HTML 内容（icon SVG / badge span）不经本沙箱断言——dom-harness
    // 的 innerHTML setter 不解析子树；视觉内容归浏览器冒烟验证。
  });
});

test('面板从注册表摘除后按钮消失，语言切换后 title 重算', async () => {
  await withPanelHost(async ({ c, mod, document }) => {
    c.window.ClawPanels.register('git', {
      when: { surfaces: ['chat'] },
      label: { zh: '源代码管理', en: 'Source Control' },
      title: () => '源代码管理',
      render: () => '',
      icon: '<svg></svg>',
      order: 30,
    });
    mod.syncRailButtons();
    // 语言切换：currentLanguage 影响标题派生（app-core 注册的桥键 → 语言域状态）
    c.window.currentLanguage = 'en';
    mod.syncRailButtons();
    assert.equal(document.getElementById('rail-git').title, 'Source Control');
    // 摘除面板（模拟插件卸载）：unregister 后 sync，按钮应消失
    c.window.ClawHost.panels.unregister('git');
    mod.syncRailButtons();
    assert.ok(!document.getElementById('rail-git'), '面板摘除后其 rail 按钮应被清理');
  });
});

test('syncRailButtons 按钮集合变化后重放 rail-customize 配置，无变化不重放', async () => {
  await withPanelHost(async ({ c, mod }) => {
    // 回归锚：按钮动态化后，rail-customize 的初始化早于首次按钮生成，
    // 用户自定义排序/可见性与 custBtn 归位若不重放，会出现「用户隐藏的
    // 面板重新显示」「自定义面板按钮滞留 rail 顶部」两类回归。
    let applyCalls = 0;
    // rail-customize 仍是 classic（配置重放的唯一实现），此处按契约给替身。
    c.window.applyRailConfig = () => { applyCalls += 1; };
    c.window.ClawPanels.register('git', {
      when: { surfaces: ['chat'] },
      label: { zh: '源代码管理', en: 'Source Control' },
      title: () => '源代码管理',
      render: () => '',
      icon: '<svg></svg>',
      order: 30,
    });
    mod.syncRailButtons();
    assert.equal(applyCalls, 1, '首次生成按钮（集合变化）应重放 rail 配置');
    mod.syncRailButtons();
    mod.syncRailButtons();
    assert.equal(applyCalls, 1, '集合无变化（幂等调用）不应重放');
    c.window.ClawHost.panels.unregister('git');
    mod.syncRailButtons();
    assert.equal(applyCalls, 2, '按钮摘除（集合变化）应再次重放');
  });
});

// ── 容器型面板（ADR-0044 P2c）──────────────────────────────────────
// 钉什么：mountBody 型面板的 body 渲染权移交——打开挂载、轮询重渲染
// no-op、切换/关闭卸载且 unmountBody 必被调用、innerHTML 路径不触碰
// 其 DOM；卸载回调抛错不阻断容器收回。这是 React 类插件进右栏的通道。

function registerContainerPanels(c, log) {
  c.window.ClawPanels.register('island', {
    when: { surfaces: ['chat'] },
    title: () => '容器面板',
    // 注意：无 render —— 容器型面板不提供 HTML 字符串
    mountBody(bodyEl, ctxInfo) {
      log.push('mount:' + ctxInfo.panelId);
      bodyEl.innerHTML = '<div data-island></div>';
    },
    unmountBody() { log.push('unmount'); },
  });
  c.window.ClawPanels.register('plain', {
    when: { surfaces: ['chat'] },
    title: () => '字符串面板',
    render: () => '<div data-plain></div>',
  });
}

test('容器面板打开时 mountBody 收到 body 容器与 panelId，轮询重渲染不重复挂载', async () => {
  await withPanelHost(async ({ c, mod, panelBody }) => {
    const log = [];
    registerContainerPanels(c, log);
    mod.toggleFeaturePanel('island');
    assert.equal(log.join(','), 'mount:island');
    assert.equal(panelBody.innerHTML, '<div data-island></div>',
      'body DOM 由 mountBody 全权构建');
    // 轮询触发的重渲染（同面板）：mountBody 不再调用，DOM 不被触碰
    mod.renderFeaturePanel();
    mod.renderFeaturePanel();
    assert.equal(log.join(','), 'mount:island', '重渲染不得重复挂载或卸载');
    assert.equal(panelBody.innerHTML, '<div data-island></div>',
      '重渲染不得触碰容器面板的 DOM');
  });
});

test('容器面板切换到字符串面板：unmountBody 先清理，body 随后被 render HTML 接管', async () => {
  await withPanelHost(async ({ c, mod, panelBody }) => {
    const log = [];
    registerContainerPanels(c, log);
    mod.toggleFeaturePanel('island');
    mod.toggleFeaturePanel('plain');
    assert.equal(log.join(','), 'mount:island,unmount',
      '切换时容器面板必须收到 unmountBody（innerHTML 路径会销毁其 DOM，先给清理机会）');
    // 容器无留白契约：字符串面板内容由宿主包在 .feature-panel-content 内容层
    assert.equal(panelBody.innerHTML,
      '<div class="feature-panel-content"><div data-plain></div></div>');
  });
});

test('fullBleed 字符串面板不吃内容层包装（自带边距设计的全幅面板）', async () => {
  await withPanelHost(async ({ c, mod, panelBody }) => {
    c.window.ClawPanels.register('edge', {
      when: { surfaces: ['chat'] },
      title: () => '全幅',
      fullBleed: true,
      render: () => '<div data-edge></div>',
    });
    mod.toggleFeaturePanel('edge');
    assert.equal(panelBody.innerHTML, '<div data-edge></div>',
      'fullBleed 面板直接占用 body，不包 .feature-panel-content');
  });
});

test('容器面板关闭：unmountBody 被调用，body 收回回空态', async () => {
  await withPanelHost(async ({ c, mod, panelBody, panel }) => {
    const log = [];
    registerContainerPanels(c, log);
    mod.toggleFeaturePanel('island');
    mod.toggleFeaturePanel('island');
    assert.equal(log.join(','), 'mount:island,unmount');
    // 容器无留白契约：关闭后 body 由宿主空态接管（空态经内容层展示）。
    // 面板 DOM 必须清除。
    assert.match(panelBody.innerHTML, /^<div class="feature-panel-content">/,
      '关闭后宿主收回容器，body 只余空态内容层');
    assert.equal(panelBody.innerHTML.includes('data-island'), false, '容器面板 DOM 必须被清除');
    assert.equal(panel.classList.contains('open'), false);
  });
});

test('unmountBody 抛错不阻断容器收回与后续面板状态', async () => {
  await withPanelHost(async ({ c, mod, panelBody, panel }) => {
    const log = [];
    c.window.ClawPanels.register('bad', {
      when: { surfaces: ['chat'] },
      title: () => '坏面板',
      mountBody(bodyEl) { log.push('mount'); bodyEl.innerHTML = '<div></div>'; },
      unmountBody() { log.push('unmount-throw'); throw new Error('cleanup boom'); },
    });
    mod.toggleFeaturePanel('bad');
    const origError = console.error;
    console.error = () => {};
    try {
      assert.doesNotThrow(() => mod.toggleFeaturePanel('bad'), '卸载回调抛错不得炸面板编排');
    } finally {
      console.error = origError;
    }
    assert.equal(log.join(','), 'mount,unmount-throw');
    assert.equal(panel.classList.contains('open'), false, '抛错后宿主仍收回容器');
    // 收回的容器可被后续面板正常接管（状态可继续流转）
    c.window.ClawPanels.register('plain-after-bad', {
      when: { surfaces: ['chat'] },
      title: () => '恢复',
      render: () => '<div data-recovered-from-bad></div>',
    });
    mod.toggleFeaturePanel('plain-after-bad');
    assert.equal(panelBody.innerHTML,
      '<div class="feature-panel-content"><div data-recovered-from-bad></div></div>',
      '抛错后容器仍可被后续面板接管');
  });
});

test('mountBody 抛错不僵尸化：不挂幽灵 unmount，面板状态可继续流转', async () => {
  await withPanelHost(async ({ c, mod, panelBody }) => {
    const log = [];
    c.window.ClawPanels.register('boom', {
      when: { surfaces: ['chat'] },
      title: () => '挂载失败',
      mountBody() { log.push('mount-throw'); throw new Error('mount boom'); },
      unmountBody() { log.push('unmount-should-not-run'); },
    });
    const origError = console.error;
    console.error = () => {};
    try {
      mod.toggleFeaturePanel('boom');
    } finally {
      console.error = origError;
    }
    assert.equal(log.join(','), 'mount-throw', '挂载失败后不得调幽灵 unmount');
    // 状态可继续流转：切到字符串面板正常渲染
    c.window.ClawPanels.register('plain2', {
      when: { surfaces: ['chat'] },
      title: () => '恢复',
      render: () => '<div data-recovered></div>',
    });
    mod.toggleFeaturePanel('plain2');
    // 容器无留白契约：恢复渲染同样包内容层
    assert.equal(panelBody.innerHTML,
      '<div class="feature-panel-content"><div data-recovered></div></div>');
  });
});

// ═══════════════════════════════════════════════════════════════
// 懒面板按需装载（ADR-0044 P3）
// ═══════════════════════════════════════════════════════════════

test('懒面板声明后 stub 立即可寻址（按钮与显隐过滤在实现装载前可用）', async () => {
  await withPanelHost(async ({ c }) => {
    c.window.ClawHost.panels.declare('lazy-demo', {
      when: { surfaces: ['chat'] },
      title: () => '懒面板',
      icon: '<svg></svg>', order: 30,
    }, { pluginId: 'panel-lazy-demo', url: '/src/panel-plugins/lazy-demo.js' });
    assert.ok(c.window.ClawPanels.has('lazy-demo'), 'stub 应已注册');
    const stub = c.window.ClawPanels.get('lazy-demo');
    assert.ok(stub.stub, 'stub 条目应带 stub 标记');
    assert.equal(stub.stub.pluginId, 'panel-lazy-demo');
    assert.ok(!stub.render && !stub.mountBody, 'stub 不带实现');
    const available = c.window.ClawPanels.getAvailable({ surface: 'chat' });
    assert.ok(available.some((p) => p.id === 'lazy-demo'), 'stub 进可用面板清单（按钮可生成）');
  });
});

test('打开懒面板显示装载占位；装载失败显式错误态且不自动重试', async () => {
  await withPanelHost(async ({ c, mod, panelBody }) => {
    c.window.ClawHost.panels.declare('lazy-fail', {
      when: { surfaces: ['chat'] },
      title: () => '会失败',
    }, { pluginId: 'panel-lazy-fail', url: '/definitely/missing.js' });
    mod.toggleFeaturePanel('lazy-fail');
    assert.match(panelBody.innerHTML, /面板加载中/,
      '打开时应显示装载占位');
    // ensurePlugin 异步落定（import 失败）→ failed；等微任务池排空
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(c.window.ClawHost.getPluginLoadState('panel-lazy-fail'), 'failed');
    mod.renderFeaturePanel();
    assert.match(panelBody.innerHTML, /面板模块装载失败/,
      '失败后重渲染应显示显式错误态');
    // 不自动重试：failed 态下 ensurePlugin 返回 false
    assert.equal(
      c.window.ClawHost.ensurePlugin('panel-lazy-fail', '/definitely/missing.js'),
      false,
      'failed 后不得自动重试',
    );
  });
});

test('实现装载后 real 替换 stub，渲染切真内容；卸载后 stub 恢复可再装载', async () => {
  await withPanelHost(async ({ c, mod, panelBody }) => {
    c.window.ClawHost.panels.declare('lazy-ok', {
      when: { surfaces: ['chat'] },
      title: () => '懒面板',
    }, { pluginId: 'panel-lazy-ok', url: '/src/panel-plugins/lazy-ok.js' });
    mod.toggleFeaturePanel('lazy-ok');
    assert.match(panelBody.innerHTML, /面板加载中/);
    // 模拟模块装载落定（activatePlugin 是 ensurePlugin 内部同一条注册路径）
    await c.window.ClawHost.activatePlugin('panel-lazy-ok', {
      id: 'panel-lazy-ok',
      panels: {
        'lazy-ok': {
          when: { surfaces: ['chat'] },
          title: () => '真实面板',
          render: () => '<div data-lazy-real>已装载</div>',
        },
      },
    });
    const real = c.window.ClawPanels.get('lazy-ok');
    assert.ok(!real.stub && typeof real.render === 'function', 'real 应替换 stub');
    assert.equal(real.owner, 'panel-lazy-ok', 'real 归属插件 owner');
    mod.renderFeaturePanel();
    assert.match(panelBody.innerHTML, /data-lazy-real/,
      '装载落定后渲染切真内容');
    // 卸载：real 摘除、stub 恢复、loadState 清空（可再次装载）
    await c.window.ClawHost.unloadPlugin('panel-lazy-ok');
    const restored = c.window.ClawPanels.get('lazy-ok');
    assert.ok(restored && restored.stub, '卸载后 stub 应回到占位态');
    assert.equal(c.window.ClawHost.getPluginLoadState('panel-lazy-ok'), null,
      '卸载后 loadState 应清空（渲染路径可重新拉起）');
    // 再次装载成功（loadState 清空使 ensurePlugin 可再发起）
    await c.window.ClawHost.activatePlugin('panel-lazy-ok', {
      id: 'panel-lazy-ok',
      panels: { 'lazy-ok': { render: () => '<div data-lazy-real-2></div>' } },
    });
    assert.ok(!c.window.ClawPanels.get('lazy-ok').stub, 'stub 面板可再次装载');
  });
});

test('real 之间的注册冲突保护不变（stub→real 是唯一替换路径）', async () => {
  await withPanelHost(async ({ c }) => {
    c.window.ClawPanels.register('dup', { render: () => '' });
    assert.throws(
      () => c.window.ClawPanels.register('dup', { render: () => '' }),
      /already registered/,
      '两个 real 抢同一面板仍是冲突',
    );
    // 声明已注册 real 的 id 为懒面板也应被拒
    assert.throws(
      () => c.window.ClawHost.panels.declare('dup', {}, { pluginId: 'p', url: '/u.js' }),
      /already registered/,
    );
  });
});

test('过期装载落定不得污染已卸载插件的 loadState（懒面板卸载后再打开不卡死）', async () => {
  await withPanelHost(async ({ c, mod }) => {
    c.window.ClawHost.panels.declare('lazy-race', {
      when: { surfaces: ['chat'] },
      title: () => '竞态',
    }, { pluginId: 'panel-lazy-race', url: '/missing-race.js' });
    mod.toggleFeaturePanel('lazy-race');
    // loading 中插件被显式装载又卸载（loadState 已清空），import 失败才姗姗来迟
    await c.window.ClawHost.activatePlugin('panel-lazy-race', {
      id: 'panel-lazy-race',
      panels: { 'lazy-race': { render: () => '<div></div>' } },
    });
    await c.window.ClawHost.unloadPlugin('panel-lazy-race');
    await new Promise((resolve) => setImmediate(resolve)); // 过期落定在此之后到达
    assert.notEqual(
      c.window.ClawHost.getPluginLoadState('panel-lazy-race'),
      'failed',
      '卸载后的过期失败落定不得写入 failed（否则 stub 被拦截、懒面板卡死）',
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 懒面板装载落定联动（ADR-0044 P3 / P4 迁移事故回归）
// ═══════════════════════════════════════════════════════════════
// 背景：git 面板模块导出 id:'git' 与清单 pluginId 'panel-git' 不一致——
// activatePlugin 以 mod.id 作 owner，落定回调按 owner===pluginId 匹配失败，
// 首开永远卡在 loading 占位；且 stub 期 onOpen 是 no-op，落定后无人补发。
// 下面两测试分别钉住「清单契约」与「落定链路」。

test('panel-plugins 已迁 ESM（P4 L1）：求值即注册懒面板声明，stub 立即可寻址', async () => {
  await withP2EsmCase({
    globals: {
      requestAnimationFrame: (callback) => { callback(); return 0; },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    },
    classic: (sandbox) => {
      // 面板注册表：claw-host 的宿主注册表 + 其 classic 转发壳（right-panel-registry）。
      sandbox.loadSource('public/src/modules/claw-host.js');
      sandbox.loadSource('public/src/modules/right-panel-registry.js');
    },
  }, async (c) => {
    await c.load('public/src/modules/panel-plugins.js');
    for (const [panelId, pluginId, url] of [
      ['session-controls', 'panel-session-controls', '/src/panel-plugins/session-controls.js'],
      ['git', 'panel-git', '/src/panel-plugins/git.js'],
    ]) {
      assert.equal(c.window.ClawPanels.has(panelId), true,
        `${panelId} 声明后 stub 应立即可寻址`);
      const entry = c.window.ClawPanels.get(panelId);
      assert.equal(entry.stub.pluginId, pluginId);
      assert.equal(entry.stub.url, url);
      // 元数据 title 是函数：语言经 i18n-environment-state 命名导出读取
      assert.equal(typeof entry.title(), 'string');
    }
  });
});

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
function openLazyPanelWithRealModule({ c, mod, calls }, { pluginId, panelId, moduleId, realHtml, onOpen }) {
  c.window.ClawHost.panels.declare(panelId, {
    when: { surfaces: ['chat'] },
    title: () => '懒面板',
  }, { pluginId, url: '/src/panel-plugins/' + panelId + '.js' });
  mod.toggleFeaturePanel(panelId);
  c.window.ClawHost.activatePlugin(pluginId, {
    id: moduleId,
    panels: {
      [panelId]: {
        when: { surfaces: ['chat'] },
        title: () => '真实面板',
        render: () => realHtml,
        ...(onOpen ? { onOpen: () => calls.push(panelId + ':onOpen') } : {}),
      },
    },
  });
  // activatePlugin 是异步函数但 happy path 无 await：同步段内完成 stub→real
}

test('装载落定自动切真内容并补发 onOpen（owner 匹配是重渲染前提）', async () => {
  await withPanelHost(async ({ c, mod, panelBody }) => {
    const calls = [];
    openLazyPanelWithRealModule({ c, mod, calls }, {
      pluginId: 'panel-lazy-live', panelId: 'lazy-live', moduleId: 'panel-lazy-live',
      realHtml: '<div data-lazy-live-real>已装载</div>', onOpen: true,
    });
    // toggle 打开：stub 无 onOpen 钩子，此时不得有生命周期调用
    assert.match(panelBody.innerHTML, /面板加载中/);
    assert.deepEqual(calls, [], 'stub 期 onOpen 落在占位元数据上，必须是 no-op');
    // 装载落定（微任务排空后 notifyLoadSettled → 编排层回调）
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(panelBody.innerHTML, /data-lazy-live-real/,
      '落定后无需再 toggle，回调应自动把占位换成真内容（首开卡占位回归）');
    assert.deepEqual(calls, ['lazy-live:onOpen'],
      'stub→real 落定应补发一次 onOpen（auto-refresh 等随打开启动的资源）');
  });
});

test('模块 id 与 pluginId 不一致时落定回调不认领（该形态被清单契约测试拦截）', async () => {
  await withPanelHost(async ({ c, mod, panelBody }) => {
    const calls = [];
    openLazyPanelWithRealModule({ c, mod, calls }, {
      pluginId: 'panel-lazy-wrong', panelId: 'lazy-wrong', moduleId: 'wrong-owner',
      realHtml: '<div data-lazy-wrong-real></div>',
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(panelBody.innerHTML, /面板加载中/,
      'owner 不匹配时回调不重渲染——占位滞留即首开卡死形态');
  });
});
