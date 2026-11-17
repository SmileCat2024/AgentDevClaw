/**
 * Feature 详情弹窗（页签 / 技能列表与阅读页 / 空态 / 钩子行）行为钉子。
 *
 * P4 T2 批次把 debug-features-hooks 转为 ESM 后，本文件改走**真实 import 路线**
 * （withP2EsmCase + c.load）：断言面从「classic 全局函数 + 模块私有变量」改为
 * 公开入口——`renderFeatureDetailOverlay`（弹窗渲染）与 `features.*`
 * data-action（分发器注册表）；页签内容经 portal 的 `[role="tabpanel"]`
 * 替换节点观测，阅读页正文经 portal.innerHTML 观测。
 *
 * 装载路线：一个用例 = 一份真实 classic 沙箱（action-dispatcher / app-core /
 * markdown-bootstrap / session-view-state）+ 真实 import 的 features 模块与其
 * 状态 owner（session-view-storage / render-entry-state / orchestration-state /
 * p2-bootstrap-debug-panel）。`t` 与 markdown 走生产实现。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from 'marked';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const FEATURES = 'public/src/modules/debug-features-hooks.js';
const DEBUG_PANEL = 'public/src/modules/p2-bootstrap-debug-panel.js';
const SESSION_VIEW = 'public/src/modules/session-view-storage.js';
const RENDER_ENTRY = 'public/src/modules/render-entry-state.js';
const ORCHESTRATION = 'public/src/modules/orchestration-state.js';

const markedStub = { Renderer, setOptions() {}, parse: (source) => 'MD:' + source };

/** 通用元素桩（模块会在它上面读写 textContent / class / dataset / 属性）。 */
function createNode(extra = {}) {
  const classes = new Set();
  return {
    tagName: 'DIV',
    dataset: {},
    style: { setProperty() {} },
    children: [],
    attributes: {},
    className: '',
    value: '',
    textContent: '',
    classList: {
      add(...names) { names.forEach((name) => classes.add(name)); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
      toggle(name, force) {
        const next = force === undefined ? !classes.has(name) : Boolean(force);
        if (next) classes.add(name); else classes.delete(name);
        return next;
      },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((item) => item !== child); },
    insertAdjacentHTML() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
    closest() { return null; },
    focus() {},
    blur() {},
    remove() {},
    ...extra,
  };
}

/** `document.createElement` 的包装节点语义：feature 详情用它把 HTML 转成节点。 */
function createWrapperNode() {
  const first = createNode({ outerHTML: '' });
  const wrapper = createNode();
  Object.defineProperty(wrapper, 'firstElementChild', { value: first, configurable: true });
  Object.defineProperty(wrapper, 'innerHTML', {
    configurable: true,
    get() { return first.outerHTML; },
    set(value) { first.outerHTML = String(value ?? ''); },
  });
  return wrapper;
}

/**
 * 弹窗 portal 替身：`innerHTML` 记录整窗 HTML；`querySelector` 提供详情页签
 * 复用路径需要的四个选择器；`querySelectorAll` 返回活页签按钮（若给）。
 */
function createPortal({ existingTabBar = null } = {}) {
  const placeholder = { replacedWith: null, replaceWith(node) { this.replacedWith = node; } };
  const panel = { replacedBy: null, replaceWith(node) { this.replacedBy = node; } };
  const scroll = { scrollTop: 0 };
  const state = { html: '', writes: 0 };
  const portal = {
    id: 'feature-detail-portal',
    get innerHTML() { return state.html; },
    set innerHTML(value) {
      state.html = String(value ?? '');
      state.writes += 1;
    },
    writes: () => state.writes,
    querySelector(selector) {
      if (selector === '[role="tablist"][aria-label]') return existingTabBar;
      if (selector === '.feature-detail-tabs-placeholder') return placeholder;
      if (selector === '.settings-tab-content') return scroll;
      if (selector === '[role="tabpanel"]') return panel;
      return null;
    },
    querySelectorAll(selector) {
      return selector === '[data-feature-detail-tab]' && existingTabBar ? existingTabBar.buttons : [];
    },
  };
  return { portal, panel, placeholder, scroll, state };
}

/** 页签条节点替身：只实现复用路径真正用到的表面。 */
function createTabBar(featureName, { buttonCount = 3 } = {}) {
  const buttons = ['tools', 'skills', 'hooks'].slice(0, buttonCount).map((key) => {
    const labelNode = { nodeType: 3, nodeValue: key };
    const countNode = { textContent: '0' };
    return {
      dataset: { featureDetailTab: key },
      childNodes: [labelNode],
      attributes: {},
      classList: { toggle() {} },
      querySelector(selector) { return selector === '.ph-tab-count' ? countNode : null; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return this.attributes[name] ?? null; },
    };
  });
  return {
    dataset: { featureDetailTabsFor: featureName },
    buttons,
    querySelectorAll(selector) {
      return selector === '[data-feature-detail-tab]' ? buttons : [];
    },
    setAttribute(name, value) { this.attributes = { ...(this.attributes || {}), [name]: String(value) }; },
  };
}

/** 每个用例的 window / document 与真实 ESM 模块。 */
async function withFeatureDetailCase(fn, { portalHarness, fetchImpl } = {}) {
  const harness = portalHarness || createPortal();
  const nodes = new Map();
  const document = {
    activeElement: null,
    readyState: 'complete',
    body: createNode(),
    head: createNode(),
    documentElement: createNode(),
    getElementById(id) {
      if (id === 'feature-detail-portal') return harness.portal;
      if (!nodes.has(id)) nodes.set(id, createNode());
      return nodes.get(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return createWrapperNode(); },
    createTextNode(text) { return { textContent: String(text), nodeType: 3 }; },
    addEventListener() {},
    removeEventListener() {},
    createTreeWalker() { return { nextNode: () => null }; },
  };
  return withP2EsmCase({
    globals: {
      marked: markedStub,
      hljs: { getLanguage: () => null },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      document,
      console: { ...console, log() {}, info() {}, debug() {} },
      fetch: fetchImpl || (async () => ({ ok: true, status: 200, text: async () => '# Skill body' })),
    },
    classic: (sandbox) => {
      sandbox.window.marked = markedStub;
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      sandbox.loadSource('public/src/app-core.js');
      sandbox.loadSource('public/src/modules/markdown-bootstrap.js');
      sandbox.loadSource('public/src/modules/session-view-state.js');
    },
  }, async (c) => {
    const features = await c.load(FEATURES);
    const state = {
      features,
      debugPanel: (await c.load(DEBUG_PANEL)).debugPanel,
      sessionView: await c.load(SESSION_VIEW),
      renderEntry: await c.load(RENDER_ENTRY),
      orchestration: await c.load(ORCHESTRATION),
      harness,
      window: c.window,
      actions: c.window.ClawFW.actions,
    };
    state.renderEntry.setActiveFeaturePanel('hooks');
    state.orchestration.setCurrentRuntimeAgentId('runtime-1');
    return fn(state);
  });
}

/** 模板动作：生产路径（分发器注册表），不是直接调内部函数。 */
function invokeAction(state, name, dataset) {
  return state.actions.invoke(name, { dataset });
}

/** 打开详情并切到指定页签；返回该页签的内容节点。 */
function openDetailTab(state, feature, tab) {
  state.debugPanel.selectedFeatureName = feature.name;
  state.sessionView.setCurrentHookInspector({
    lifecycleOrder: [],
    features: [feature],
    hooks: [],
  });
  state.features.renderFeatureDetailOverlay(feature);
  // 页签状态是模块私有的：先切到另一个页签，再切目标页签（同值短路会直接返回）。
  const pivot = ['hooks', 'skills', 'tools'].find((key) => key !== tab);
  invokeAction(state, 'features.setDetailTab', { tabKey: pivot, featureName: feature.name });
  invokeAction(state, 'features.setDetailTab', { tabKey: tab, featureName: feature.name });
  return state.harness.panel.replacedBy;
}

function baseFeature(extra = {}) {
  return {
    name: 'shell',
    tools: [],
    skills: [],
    hookCount: 0,
    toolCount: 0,
    enabledToolCount: 0,
    description: '',
    source: 'src/index.js',
    mapped: false,
    ...extra,
  };
}

describe('Feature detail tab bar identity', () => {
  it('does not reuse another feature\'s tab bar when switching features', async () => {
    // 页签条上的 data-action 参数与 data-feature-detail-tabs-for 都绑定 featureName。
    // 跨 Feature 复用会让新弹窗沿用旧回调（归属校验静默拒绝 → 分页器点了不动）。
    const otherBar = createTabBar('previous-feature');
    const portalHarness = createPortal({ existingTabBar: otherBar });
    await withFeatureDetailCase(async ({ features, harness }) => {
      features.renderFeatureDetailOverlay(baseFeature({
        name: 'next-feature',
        skills: [{ name: 'guide', description: 'Help', root: 0, path: 'skills/guide/SKILL.md' }],
      }));

      const replaced = harness.placeholder.replacedWith;
      assert.ok(replaced, 'placeholder must be filled with a tab bar');
      assert.notEqual(replaced, otherBar, 'tab bar of another feature must not be reused');
      assert.match(replaced.outerHTML, /data-feature-detail-tabs-for="next-feature"/);
      assert.match(replaced.outerHTML, /data-tab-key="skills" data-feature-name="next-feature"/);
    }, { portalHarness });
  });

  it('keeps the same tab bar node when re-rendering the same feature', async () => {
    // 轮询重绘（同一 Feature）必须保住按钮节点：按下到 click 之间节点脱离
    // DOM 会让浏览器取消整串点击事件。
    const sameBar = createTabBar('same-feature');
    const portalHarness = createPortal({ existingTabBar: sameBar });
    await withFeatureDetailCase(async ({ features, harness }) => {
      features.renderFeatureDetailOverlay(baseFeature({
        name: 'same-feature',
        tools: [{ name: 'run', state: 'enabled', enabled: true }],
        skills: [{ name: 'guide', description: 'Help', root: 0, path: 'skills/guide/SKILL.md' }],
        toolCount: 1,
        enabledToolCount: 1,
      }));

      assert.equal(harness.placeholder.replacedWith, sameBar,
        'same-feature refresh must reuse the live tab bar');
      // 复用路径同样要刷新计数：工具数从 0 变成 1
      assert.equal(sameBar.buttons[0].querySelector('.ph-tab-count').textContent, '1');
    }, { portalHarness });
  });
});

describe('features.setDetailTab action', () => {
  it('switches the visible panel in place without rebuilding the tab bar', async () => {
    // 活页签条替身：active 类与 aria-selected 分别记账，节点身份用同一批按钮对象
    // 证明（生产代码走 querySelectorAll 取活页签，不重建整条）。
    const makeLiveTabButton = (key) => {
      const state = { active: key === 'tools', ariaSelected: key === 'tools' ? 'true' : 'false' };
      return {
        dataset: { featureDetailTab: key },
        get active() { return state.active; },
        get ariaSelected() { return state.ariaSelected; },
        classList: {
          add(name) { if (name === 'active') state.active = true; },
          remove(name) { if (name === 'active') state.active = false; },
          toggle(name, force) {
            if (name !== 'active') return Boolean(force);
            state.active = force === undefined ? !state.active : Boolean(force);
            return state.active;
          },
        },
        setAttribute(name, value) { if (name === 'aria-selected') state.ariaSelected = String(value); },
      };
    };
    const buttons = ['tools', 'skills', 'hooks'].map(makeLiveTabButton);
    const liveBarReads = [];
    const portalHarness = createPortal({ existingTabBar: createTabBar('with-skills') });
    portalHarness.portal.querySelectorAll = (selector) => {
      if (selector !== '[data-feature-detail-tab]') return [];
      liveBarReads.push(buttons);
      return buttons;
    };

    await withFeatureDetailCase(async (state) => {
      const feature = baseFeature({
        name: 'with-skills',
        skills: [{ name: 'guide', description: 'Help', root: 0, path: 'skills/guide/SKILL.md' }],
      });
      state.debugPanel.selectedFeatureName = 'with-skills';
      state.sessionView.setCurrentHookInspector({ lifecycleOrder: [], features: [feature], hooks: [] });
      state.features.renderFeatureDetailOverlay(feature);
      const writesBeforeSwitch = portalHarness.state.writes;

      invokeAction(state, 'features.setDetailTab', { tabKey: 'skills', featureName: 'with-skills' });

      assert.equal(portalHarness.state.writes, writesBeforeSwitch,
        'tab switching must not rebuild the portal');
      assert.match(portalHarness.panel.replacedBy.outerHTML, /feature-skill-list/,
        'skills tab must replace the visible content panel');
      // 节点身份：动作分发后读到/改到的仍是同一批活页签节点，没有整条重建。
      assert.equal(liveBarReads.length >= 1, true, 'action must reuse the live tab bar');
      // active 类与 aria-selected 成对更新：目标页签选中，原页签取消。
      assert.equal(buttons[1].active, true, 'skills tab must be the active one');
      assert.equal(buttons[0].active, false, 'tools tab must be deactivated');
      assert.equal(buttons[1].ariaSelected, 'true');
      assert.equal(buttons[0].ariaSelected, 'false');
    }, { portalHarness });
  });
});

describe('skills tab: cards + reader sub-page', () => {
  const SKILLS = [
    { name: 'grill-me', description: 'Grill the plan', root: 0, path: 'skills/grill-me/SKILL.md' },
    { name: 'claw-help', description: 'Usage help', root: 0, path: 'skills/claw-help/SKILL.md' },
  ];
  const FEATURE = baseFeature({ name: 'shell', skills: SKILLS });

  it('renders one card per skill carrying only name and description', async () => {
    // 列表页只呈现描述摘要，完整文档进阅读页——整份 SKILL.md 铺进列表会把
    // 技能分页撑成一篇长文，多个技能叠在一起几乎无法浏览。
    await withFeatureDetailCase(async (state) => {
      const content = openDetailTab(state, FEATURE, 'skills');
      const html = content.outerHTML;
      assert.equal((html.match(/class="feature-skill-card is-clickable"/g) || []).length, 2);
      assert.match(html, /Grill the plan/);
      assert.match(html, /Usage help/);
      assert.doesNotMatch(html, /feature-skill-markdown/, 'list must not embed the document body');
      assert.doesNotMatch(html, /feature-skill-loading/, 'list must not prefetch document bodies');
    });
  });

  it('makes each card open the reader for that skill', async () => {
    await withFeatureDetailCase(async (state) => {
      const html = openDetailTab(state, FEATURE, 'skills').outerHTML;
      assert.match(html, /data-action="features.openSkill" data-feature-name="shell" data-skill-name="grill-me"/);
      assert.match(html, /data-action="features.openSkill" data-feature-name="shell" data-skill-name="claw-help"/);
    });
  });

  it('shows the document only in the reader, and only after it is fetched', async () => {
    const portalHarness = createPortal();
    let releaseFetch;
    const fetchImpl = () => new Promise((resolve) => {
      releaseFetch = () => resolve({ ok: true, status: 200, text: async () => '# Grill' });
    });
    await withFeatureDetailCase(async (state) => {
      openDetailTab(state, FEATURE, 'skills');
      invokeAction(state, 'features.openSkill', { featureName: 'shell', skillName: 'grill-me' });

      const pending = portalHarness.portal.innerHTML;
      assert.match(pending, /feature-skill-reader/);
      assert.match(pending, /正在读取技能文档/, 'reader shows the loading state first');
      assert.doesNotMatch(pending, /feature-skill-list/, 'reader replaces the list, it does not append to it');

      releaseFetch();
      for (let i = 0; i < 50 && !/MD:# Grill/.test(portalHarness.portal.innerHTML); i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.match(portalHarness.portal.innerHTML, /MD:# Grill/, 'fetched body renders into the reader');
    }, { portalHarness, fetchImpl });
  });

  it('leaves the reader when switching tabs or features', async () => {
    // 否则下次回到技能分页会直接落在上一份文档上，且阅读页归属已对不上。
    const portalHarness = createPortal();
    await withFeatureDetailCase(async (state) => {
      openDetailTab(state, FEATURE, 'skills');
      invokeAction(state, 'features.openSkill', { featureName: 'shell', skillName: 'grill-me' });
      for (let i = 0; i < 50 && !/feature-skill-markdown/.test(portalHarness.portal.innerHTML); i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.match(portalHarness.portal.innerHTML, /feature-skill-reader/);

      invokeAction(state, 'features.setDetailTab', { tabKey: 'tools', featureName: 'shell' });
      invokeAction(state, 'features.setDetailTab', { tabKey: 'skills', featureName: 'shell' });
      const backToSkills = portalHarness.panel.replacedBy.outerHTML;
      assert.match(backToSkills, /feature-skill-list/, 'leaving the skills tab must close the reader');
      assert.doesNotMatch(backToSkills, /feature-skill-reader/);

      // 切 Feature 同样退出阅读页：再次打开 reader 后换 Feature 身份
      invokeAction(state, 'features.openSkill', { featureName: 'shell', skillName: 'grill-me' });
      state.debugPanel.selectedFeatureName = 'other-feature';
      state.sessionView.setCurrentHookInspector({
        lifecycleOrder: [], features: [baseFeature({ name: 'other-feature' })], hooks: [],
      });
      state.features.renderFeatureDetailOverlay(baseFeature({ name: 'other-feature' }));
      invokeAction(state, 'features.setDetailTab', { tabKey: 'skills', featureName: 'other-feature' });
      assert.doesNotMatch(portalHarness.panel.replacedBy.outerHTML, /feature-skill-reader/,
        'switching feature must close the reader');
    }, { portalHarness });
  });
});

describe('feature detail empty states', () => {
  // 详情分页的空态不再是一行灰字（.gateway-list-empty），而是项目统一的
  // 「交互页面」空态卡族：虚线卡 + 图标块 + 标题 + 描述。
  for (const tab of ['tools', 'skills', 'hooks']) {
    it(`${tab} tab renders the shared empty card when there is nothing to show`, async () => {
      await withFeatureDetailCase(async (state) => {
        const html = openDetailTab(state, baseFeature({ name: 'bare' }), tab).outerHTML;
        assert.match(html, /class="gen-ui-empty"/, 'empty state must reuse the project empty-card recipe');
        assert.match(html, /class="gen-ui-empty-icon"/);
        assert.match(html, /class="gen-ui-empty-title"/);
        assert.match(html, /class="gen-ui-empty-description"/);
        assert.doesNotMatch(html, /gateway-list-empty/, 'the single grey line must be gone');
      });
    });
  }

  it('drops the redundant tools section heading and its count', async () => {
    // 「已加载工具 (N)」既重复分页器上的计数，也是页内多余的一级标题。
    await withFeatureDetailCase(async (state) => {
      const feature = baseFeature({
        name: 'with-tools',
        tools: [{ name: 'run', state: 'enabled', enabled: true }],
        toolCount: 1,
        enabledToolCount: 1,
      });
      const html = openDetailTab(state, feature, 'tools').outerHTML;
      assert.doesNotMatch(html, /settings-section-title/, 'tools tab must not repeat a heading');
      assert.match(html, /gateway-tool-grid/);
    });
  });

  it('drops the skill list hint line', async () => {
    await withFeatureDetailCase(async (state) => {
      const feature = baseFeature({
        name: 'sk',
        skills: [{ name: 'a', description: 'A', root: 0, path: 'skills/a/SKILL.md' }],
      });
      const html = openDetailTab(state, feature, 'skills').outerHTML;
      assert.doesNotMatch(html, /feature-skill-hint/, 'the hint line above the cards must be gone');
    });
  });
});

describe('skill reader states', () => {
  const FEATURE = baseFeature({
    name: 'shell',
    skills: [{ name: 'guide', description: 'Guide', root: 0, path: 'skills/guide/SKILL.md' }],
  });

  it('uses the spinner variant of the empty card while the document loads', async () => {
    const portalHarness = createPortal();
    const fetchImpl = () => new Promise(() => {}); // 永不落定：停在加载态
    await withFeatureDetailCase(async (state) => {
      openDetailTab(state, FEATURE, 'skills');
      invokeAction(state, 'features.openSkill', { featureName: 'shell', skillName: 'guide' });
      const html = portalHarness.portal.innerHTML;
      assert.match(html, /class="gen-ui-empty"/);
      assert.match(html, /gen-ui-spinner/);
      assert.match(html, /正在读取技能文档/);
      assert.doesNotMatch(html, /feature-skill-loading/, 'the bare loading line must be gone');
    }, { portalHarness, fetchImpl });
  });

  it('offers retry inside the card when the document fails to load', async () => {
    const portalHarness = createPortal();
    const fetchImpl = async () => ({ ok: false, status: 500, text: async () => '' });
    await withFeatureDetailCase(async (state) => {
      openDetailTab(state, FEATURE, 'skills');
      invokeAction(state, 'features.openSkill', { featureName: 'shell', skillName: 'guide' });
      for (let i = 0; i < 50 && !/feature-detail-empty-actions/.test(portalHarness.portal.innerHTML); i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const html = portalHarness.portal.innerHTML;
      assert.match(html, /class="gen-ui-empty"/);
      assert.match(html, /feature-detail-empty-actions/);
      assert.match(html, /settings-btn settings-btn-secondary/);
      assert.match(html, /data-action="features.retrySkill" data-feature-name="shell" data-skill-name="guide"/);
      assert.doesNotMatch(html, /feature-skill-retry/, 'the bare retry button style must be gone');
    }, { portalHarness, fetchImpl });
  });
});

describe('renderFeatureDetailContent hooks tab', () => {
  function renderHooksTab(state) {
    const feature = baseFeature({ name: 'shell', hookCount: 2 });
    state.debugPanel.selectedFeatureName = 'shell';
    state.sessionView.setCurrentHookInspector({
      lifecycleOrder: [],
      features: [feature],
      hooks: [
        {
          lifecycle: 'CallStart',
          entries: [{
            featureName: 'shell',
            methodName: 'registerPendingWorkOnCallStart',
            kind: 'observe',
            enabled: true,
            description: '注册待办',
          }],
        },
        {
          lifecycle: 'StepFinish',
          entries: [{
            featureName: 'shell',
            methodName: 'endTurnOnStandby',
            kind: 'guard',
            enabled: true,
          }],
        },
      ],
    });
    state.features.renderFeatureDetailOverlay(feature);
    invokeAction(state, 'features.setDetailTab', { tabKey: 'hooks', featureName: 'shell' });
    return state.harness.panel.replacedBy.outerHTML;
  }

  it('renders each handler on its own row instead of the panel timeline item', async () => {
    // .rh-item 的负外边距（-13px/-15px）会把条目撑到比弹窗内容区还宽，
    // 再叠加 .settings-tab-content 的横向滚动，整个弹窗被拖出滚动条。
    await withFeatureDetailCase(async (state) => {
      const html = renderHooksTab(state);
      assert.doesNotMatch(html, /class="rh-item"/, 'must not reuse the panel timeline item');
      assert.doesNotMatch(html, /class="rh-ord"/, 'lifecycle name must not be squeezed into the 15px dot');
      assert.equal((html.match(/class="feature-hook-item"/g) || []).length, 2);
    });
  });

  it('gives the lifecycle name its own dedicated element', async () => {
    // 旧写法把 lifecycle 塞进 15px 圆点，界面只显示成 "lStart"/"pFinis"。
    // 只断言文本存在不够——旧结构里文本也在，差别在于它没有承载元素。
    await withFeatureDetailCase(async (state) => {
      const html = renderHooksTab(state);
      assert.equal((html.match(/class="feature-hook-lifecycle"/g) || []).length, 2);
      assert.match(html, /class="feature-hook-lifecycle"[^>]*>CallStart</);
      assert.match(html, /class="feature-hook-lifecycle"[^>]*>StepFinish</);
    });
  });
});
