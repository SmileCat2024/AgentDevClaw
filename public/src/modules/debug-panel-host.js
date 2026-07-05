/**
 * debug-panel-host.js — 面板编排入口
 *
 * 从 debug-panels.js 拆出。必须在所有 debug-*.js 子模块之后加载。
 * 包含：
 *   - renderFeaturePanel（通过 featurePanels 注册表调用各面板 render）
 *   - toggleFeaturePanel
 *
 * 依赖（全局变量，声明于 app-core.js）：
 *   - activeFeaturePanel, featurePanelWidth
 *   - featurePanel, featurePanelBody, featurePanelTitle, railButtons
 *
 * 依赖（全局函数 / 注册表）：
 *   - t (app-core.js)
 *   - enhanceMathInElement (markdown-utils.js)
 *   - getFeaturePanelEmptyHtml (app-ui.js)
 *   - featurePanels (app-ui.js，运行时注册表，箭头函数延迟解析)
 */

// ═══════════════════════════════════════════════════════════════
// 面板入口
// ═══════════════════════════════════════════════════════════════

function renderFeaturePanel() {
  // ── 泛化焦点保持：任何 featurePanelBody 内的 input/textarea 都保护 ──
  const activeElement = document.activeElement;
  let focusRestore = null;
  if (activeElement && featurePanelBody.contains(activeElement)) {
    const tag = activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      // 构建 CSS 选择器，在 innerHTML 替换后重新定位元素
      let selector = tag.toLowerCase();
      const role = activeElement.getAttribute('data-files-role');
      const id = activeElement.id;
      const cls = typeof activeElement.className === 'string' ? activeElement.className.trim() : '';
      if (role) {
        selector += `[data-files-role="${role}"]`;
      } else if (id) {
        selector += `#${id}`;
      } else if (cls) {
        selector += '.' + cls.split(/\s+/).join('.');
      }
      focusRestore = {
        selector,
        value: activeElement.value,
        selectionStart: typeof activeElement.selectionStart === 'number' ? activeElement.selectionStart : null,
        selectionEnd: typeof activeElement.selectionEnd === 'number' ? activeElement.selectionEnd : null,
      };
    }
  }

  if (!activeFeaturePanel || !featurePanels[activeFeaturePanel]) {
    featurePanel.classList.remove('open');
    featurePanelTitle.textContent = t('panel_structure');
    featurePanelBody.innerHTML = getFeaturePanelEmptyHtml();
    railButtons.forEach(button => button.classList.remove('active'));
    return;
  }

  const panel = featurePanels[activeFeaturePanel];
  featurePanel.classList.add('open');
  featurePanel.style.setProperty('--feature-panel-width', featurePanelWidth + 'px');
  featurePanelTitle.textContent = typeof panel.title === 'function' ? panel.title() : panel.title;

  // ── 滚动位置保持：innerHTML 替换会重置所有 scrollTop ──
  const _savedBodyScrollTop = featurePanelBody.scrollTop;
  // .feature-detail-window 是 Feature 详情弹窗的独立滚动容器
  const _oldDetailWindow = featurePanelBody.querySelector('.feature-detail-window');
  const _savedDetailScrollTop = _oldDetailWindow ? _oldDetailWindow.scrollTop : 0;

  featurePanelBody.innerHTML = panel.render();
  enhanceMathInElement(featurePanelBody);
  railButtons.forEach(button => {
    button.classList.toggle('active', button.dataset.panel === activeFeaturePanel);
  });

  // 恢复滚动位置
  featurePanelBody.scrollTop = _savedBodyScrollTop;
  const _newDetailWindow = featurePanelBody.querySelector('.feature-detail-window');
  if (_newDetailWindow) _newDetailWindow.scrollTop = _savedDetailScrollTop;

  if (focusRestore) {
    const el = featurePanelBody.querySelector(focusRestore.selector);
    if (el) {
      // 恢复用户正在输入的值（重新渲染的 HTML 可能带有过期值）
      if (focusRestore.value != null && el.value !== focusRestore.value) {
        el.value = focusRestore.value;
      }
      el.focus();
      if (focusRestore.selectionStart != null && focusRestore.selectionEnd != null && typeof el.setSelectionRange === 'function') {
        el.setSelectionRange(focusRestore.selectionStart, focusRestore.selectionEnd);
      }
    }
  }
}

function toggleFeaturePanel(panelId) {
  const wasOpen = activeFeaturePanel === panelId;
  activeFeaturePanel = wasOpen ? null : panelId;
  renderFeaturePanel();
  // 初始化钩子：settings 面板首次打开时加载异步数据
  if (!wasOpen && panelId === 'settings' && window._wgSettingsInit) {
    window._wgSettingsInit();
  }
}
