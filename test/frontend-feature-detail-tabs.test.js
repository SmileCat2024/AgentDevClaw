import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * 页签条节点替身：只实现复用路径真正用到的表面（dataset / 子按钮 / 属性写）。
 */
function createTabBar(featureName, { buttonCount = 3 } = {}) {
  const buttons = ['tools', 'skills', 'hooks'].slice(0, buttonCount).map(key => {
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

function createOverlayHarness(existingTabBar) {
  const placeholder = { replacedWith: null, replaceWith(node) { this.replacedWith = node; } };
  const panel = { replaceWith() {} };
  const created = [];
  const portal = {
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(value) { this._html = value; },
    querySelector(selector) {
      if (selector === '[role="tablist"][aria-label]') return existingTabBar;
      if (selector === '.feature-detail-tabs-placeholder') return placeholder;
      if (selector === '[role="tabpanel"]') return panel;
      return null;
    },
    querySelectorAll() { return existingTabBar ? existingTabBar.buttons : []; },
  };
  const document = {
    getElementById(id) { return id === 'feature-detail-portal' ? portal : null; },
    createElement() {
      const wrapper = {
        firstElementChild: { outerHTML: '', dataset: {}, attributes: {}, children: [] },
        set innerHTML(value) { wrapper.firstElementChild.outerHTML = value; },
      };
      created.push(wrapper);
      return wrapper;
    },
  };
  return { document, portal, placeholder, created };
}

function loadModule(document) {
  return createFrontendSandbox({
    document,
    window: { document },
    selectedFeatureName: null,
    activeFeaturePanel: 'hooks',
    currentRuntimeAgentId: 'runtime-1',
    currentHookInspector: { features: [], hooks: [] },
    t(key) { return key; },
    shortenSourcePath(value) { return value; },
    getFeatureStatus() { return 'enabled'; },
    getFeatureStatusLabel() { return 'enabled'; },
    getStatusBadgeClass() { return ''; },
    renderMarkdown(value) { return value; },
  });
}

describe('Feature detail tab bar identity', () => {
  it('does not reuse another feature\'s tab bar when switching features', () => {
    // 页签条上的 onclick 与 data-feature-detail-tabs-for 都绑定 featureName。
    // 跨 Feature 复用会让新弹窗沿用旧回调：setFeatureDetailTab 的归属校验
    // 会静默拒绝，用户看到的就是"分页器在那儿但点了不动"。
    const otherBar = createTabBar('previous-feature');
    const harness = createOverlayHarness(otherBar);
    const ctx = loadModule(harness.document);
    ctx.loadSource('public/src/modules/debug-features-hooks.js');

    ctx.run(`renderFeatureDetailOverlay({
      name: 'next-feature',
      tools: [],
      skills: [{ name: 'guide', description: 'Help', root: 0, path: 'skills/guide/SKILL.md' }],
      hookCount: 0,
      toolCount: 0,
      enabledToolCount: 0,
      description: '',
      source: 'src/index.js',
    })`);

    const replaced = harness.placeholder.replacedWith;
    assert.ok(replaced, 'placeholder must be filled with a tab bar');
    assert.notEqual(replaced, otherBar, 'tab bar of another feature must not be reused');
    assert.match(replaced.outerHTML, /data-feature-detail-tabs-for="next-feature"/);
    // 单引号在 HTML 属性里成为 &#39;，浏览器解析属性值时会解回 '，
    // 因此断言编码后的形态即可代表"浏览器实际拿到的回调"。
    assert.match(replaced.outerHTML, /setFeatureDetailTab\(&#39;skills&#39;,&#39;next-feature&#39;\)/);
  });

  it('keeps the same tab bar node when re-rendering the same feature', () => {
    // 轮询重绘（同一 Feature）必须保住按钮节点：按下到 click 之间节点脱离
    // DOM 会让浏览器取消整串点击事件。
    const sameBar = createTabBar('same-feature');
    const harness = createOverlayHarness(sameBar);
    const ctx = loadModule(harness.document);
    ctx.loadSource('public/src/modules/debug-features-hooks.js');

    ctx.run(`renderFeatureDetailOverlay({
      name: 'same-feature',
      tools: [{ name: 'run', state: 'enabled', enabled: true }],
      skills: [{ name: 'guide', description: 'Help', root: 0, path: 'skills/guide/SKILL.md' }],
      hookCount: 0,
      toolCount: 1,
      enabledToolCount: 1,
      description: '',
      source: 'src/index.js',
    })`);

    assert.equal(harness.placeholder.replacedWith, sameBar, 'same-feature refresh must reuse the live tab bar');
    // 复用路径同样要刷新计数：工具数从 0 变成 1
    assert.equal(sameBar.buttons[0].querySelector('.ph-tab-count').textContent, '1');
  });
});

describe('featureDetailTabOnclick', () => {
  it('escapes quotes so the attribute value survives round-tripping', () => {
    const ctx = loadModule(createOverlayHarness(null).document);
    ctx.loadSource('public/src/modules/debug-features-hooks.js');
    const value = ctx.run(`featureDetailTabOnclick('skills', "a'b")`);
    assert.equal(value, "window.setFeatureDetailTab('skills','a\\'b')");
  });
});

describe('window.setFeatureDetailTab', () => {
  it('switches the visible panel in place without rebuilding the tab bar', () => {
    const buttons = ['tools', 'skills', 'hooks'].map(key => ({
      dataset: { featureDetailTab: key },
      selected: key === 'tools',
      classList: {
        add(name) { if (name === 'active') this.owner.selected = true; },
        remove(name) { if (name === 'active') this.owner.selected = false; },
        owner: null,
      },
      setAttribute(name, value) { if (name === 'aria-selected') this.selected = value === 'true'; },
    }));
    for (const button of buttons) button.classList.owner = button;

    const panel = { replaceWith(next) { this.replacedBy = next; } };
    let innerHTMLWrites = 0;
    const portal = {
      _html: '<dialog></dialog>',
      get innerHTML() { return this._html; },
      set innerHTML(value) { this._html = value; innerHTMLWrites += 1; },
      querySelector(selector) { return selector === '[role="tabpanel"]' ? panel : null; },
      querySelectorAll(selector) { return selector === '[data-feature-detail-tab]' ? buttons : []; },
    };
    const document = {
      getElementById(id) { return id === 'feature-detail-portal' ? portal : null; },
      createElement() {
        const wrapper = {
          firstElementChild: { outerHTML: '' },
          set innerHTML(value) { wrapper.firstElementChild.outerHTML = value; },
        };
        return wrapper;
      },
    };
    portal.innerHTML = '<dialog></dialog>';
    const writesBeforeSwitch = innerHTMLWrites;
    const ctx = createFrontendSandbox({
      document,
      window: { document },
      selectedFeatureName: 'with-skills',
      activeFeaturePanel: 'hooks',
      currentRuntimeAgentId: 'runtime-1',
      currentHookInspector: {
        features: [{
          name: 'with-skills',
          tools: [],
          skills: [{ name: 'guide', description: 'Help', root: 0, path: 'skills/guide/SKILL.md' }],
          hookCount: 0,
        }],
        hooks: [],
      },
      t(key) { return key; },
      shortenSourcePath(value) { return value; },
      getFeatureStatus() { return 'enabled'; },
      getFeatureStatusLabel() { return 'enabled'; },
      getStatusBadgeClass() { return ''; },
      renderMarkdown(value) { return value; },
    });
    ctx.loadSource('public/src/modules/debug-features-hooks.js');

    ctx.run('window.setFeatureDetailTab("skills", "with-skills")');

    assert.equal(innerHTMLWrites, writesBeforeSwitch, 'tab switching must not rebuild the portal');
    assert.match(panel.replacedBy.outerHTML, /feature-skill-list/, 'skills tab must replace the visible content panel');
    assert.equal(buttons.find(button => button.dataset.featureDetailTab === 'skills').selected, true);
    assert.equal(buttons.find(button => button.dataset.featureDetailTab === 'tools').selected, false);
  });
});

describe('renderFeatureDetailContent hooks tab', () => {
  function renderHooksTab() {
    const ctx = createFrontendSandbox({
      document: { getElementById() { return null; }, createElement() { return {}; } },
      window: {},
      selectedFeatureName: 'shell',
      activeFeaturePanel: 'hooks',
      currentRuntimeAgentId: 'runtime-1',
      currentHookInspector: {
        features: [{ name: 'shell', tools: [], skills: [], hookCount: 2 }],
        hooks: [{
          lifecycle: 'CallStart',
          entries: [{ featureName: 'shell', methodName: 'registerPendingWorkOnCallStart', kind: 'observe', enabled: true, description: '注册待办' }],
        }, {
          lifecycle: 'StepFinish',
          entries: [{ featureName: 'shell', methodName: 'endTurnOnStandby', kind: 'guard', enabled: true }],
        }],
      },
      t(key) { return key; },
      shortenSourcePath(value) { return value; },
      getFeatureStatus() { return 'enabled'; },
      getFeatureStatusLabel() { return 'enabled'; },
      getStatusBadgeClass() { return ''; },
      renderMarkdown(value) { return value; },
    });
    ctx.loadSource('public/src/modules/debug-features-hooks.js');
    // 分页状态是模块私有变量，经公开入口切换到钩子分页再取内容。
    return ctx.run(`(() => {
      const feature = { name: 'shell', tools: [], skills: [], hookCount: 2, toolCount: 0, enabledToolCount: 0 };
      ensureFeatureDetailTabOwner('shell');
      window.setFeatureDetailTab('hooks', 'shell');
      return renderFeatureDetailContent(feature);
    })()`);
  }

  it('renders each handler on its own row instead of the panel timeline item', () => {
    // .rh-item 的负外边距（-13px/-15px）会把条目撑到比弹窗内容区还宽，
    // 再叠加 .settings-tab-content 的横向滚动，整个弹窗被拖出滚动条。
    const html = renderHooksTab();
    assert.doesNotMatch(html, /class="rh-item"/, 'must not reuse the panel timeline item');
    assert.doesNotMatch(html, /class="rh-ord"/, 'lifecycle name must not be squeezed into the 15px dot');
    assert.equal((html.match(/class="feature-hook-item"/g) || []).length, 2);
  });

  it('gives the lifecycle name its own dedicated element', () => {
    // 旧写法把 lifecycle 塞进 15px 圆点，界面只显示成 "lStart"/"pFinis"。
    // 只断言文本存在不够——旧结构里文本也在，差别在于它没有承载元素。
    const html = renderHooksTab();
    assert.equal((html.match(/class="feature-hook-lifecycle"/g) || []).length, 2);
    assert.match(html, /class="feature-hook-lifecycle"[^>]*>CallStart</);
    assert.match(html, /class="feature-hook-lifecycle"[^>]*>StepFinish</);
  });
});
