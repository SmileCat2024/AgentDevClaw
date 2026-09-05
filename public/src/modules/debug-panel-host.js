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

let featurePanelRenderVersion = 0;

// 顶部渐隐遮罩：面板 body 向上滚动（上方有滚走的内容）时显示，与底部
// scrollable 渐隐对称。程序设置 scrollTop 同样触发 scroll 事件，class 自动同步。
featurePanelBody.addEventListener('scroll', () => {
  featurePanel.classList.toggle('scrolled', featurePanelBody.scrollTop > 4);
}, { passive: true });

// 面板内容签名缓存：panelId → 上次提交的 HTML。
// 轮询携带相同数据时跳过 innerHTML 替换，保住滚动位置、details 展开、
// ClawSelect 增强层与输入焦点（防打断的关键）。
const _panelBodyHtmlCache = new Map();

function runAfterPanelOpenFrame(callback) {
  const raf = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame.bind(window)
    : (fn) => setTimeout(fn, 0);
  raf(() => raf(callback));
}

function renderFeaturePanel(options = {}) {
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
    featurePanelRenderVersion += 1;
    _panelBodyHtmlCache.clear();
    featurePanel.classList.remove('open');
    featurePanel.classList.remove('body-ready');
    document.querySelector('.main-content')?.classList.remove('panel-open');
    featurePanelTitle.textContent = t('panel_structure');
    featurePanelBody.innerHTML = getFeaturePanelEmptyHtml();
    railButtons.forEach(button => button.classList.remove('active'));
    // 清理可能残留的 Feature 详情弹窗 portal
    if (typeof renderFeatureDetailOverlay === 'function') {
      renderFeatureDetailOverlay(null);
    }
    return;
  }

  const panel = featurePanels[activeFeaturePanel];
  const panelId = activeFeaturePanel;
  // 切换到非 hooks 面板时，清理 Feature 详情弹窗
  if (panelId !== 'hooks' && typeof renderFeatureDetailOverlay === 'function') {
    renderFeatureDetailOverlay(null);
  }
  const prevPanelId = featurePanelBody.dataset.panel;
  featurePanelBody.dataset.panel = panelId;
  const renderVersion = featurePanelRenderVersion + 1;
  featurePanelRenderVersion = renderVersion;
  // 仅在面板打开转换时同步宽度变量：打开状态下的重渲染（如 poll 数据更新）
  // 不得覆写宽度，否则拖动调整中会被闪回全局 featurePanelWidth（尤其收回区拖动）。
  const wasOpen = featurePanel.classList.contains('open');
  featurePanel.classList.add('open');
  document.querySelector('.main-content')?.classList.add('panel-open');
  if (!wasOpen) {
    featurePanel.style.setProperty('--feature-panel-width', featurePanelWidth + 'px');
  }
  featurePanelTitle.textContent = typeof panel.title === 'function' ? panel.title() : panel.title;
  railButtons.forEach(button => {
    button.classList.toggle('active', button.dataset.panel === activeFeaturePanel);
  });

  const commitPanelBody = () => {
    if (renderVersion !== featurePanelRenderVersion || activeFeaturePanel !== panelId) {
      return;
    }

    // 面板声明 preserveOnReRender 时，如果当前 body 已经属于该面板且有内容，
    // 跳过 innerHTML 替换以保留交互状态（事件监听器、输入焦点等）。
    // 注意：必须用 prevPanelId 判断，因为 dataset.panel 已经被设为新值。
    // 切换面板时 prevPanelId !== panelId，不会跳过首次渲染。
    if (panel.preserveOnReRender && prevPanelId === panelId && featurePanelBody.children.length > 0) {
      featurePanel.classList.add('body-ready');
      return;
    }

    // ── 滚动位置保持：innerHTML 替换会重置所有 scrollTop ──
    // 日志面板等使用内部滚动容器（.logf-list）的面板，body 本身不滚，
    // 必须一并保存/恢复内层滚动位置，否则全量重建后视图跳回顶部。
    const _savedBodyScrollTop = featurePanelBody.scrollTop;
    const _prevInnerScroll = featurePanelBody.querySelector('.logf-list');
    const _savedInnerScrollTop = _prevInnerScroll ? _prevInnerScroll.scrollTop : null;

    const nextHtml = panel.render();

    // 内容签名去重：同面板、HTML 未变且 body 非空时跳过 DOM 替换。
    // 面板切换（prevPanelId !== panelId）与 deferBody 清空（children 为 0）不适用。
    if (prevPanelId === panelId && featurePanelBody.children.length > 0 && _panelBodyHtmlCache.get(panelId) === nextHtml) {
      featurePanel.classList.add('body-ready');
      return;
    }
    _panelBodyHtmlCache.set(panelId, nextHtml);

    featurePanelBody.innerHTML = nextHtml;
    if (featurePanelBody.querySelector('.markdown-body')) {
      enhanceMathInElement(featurePanelBody);
    }

    // ClawSelect 增强：渲染后接管 data-claw-select 下拉
    if (window.ClawSelect && featurePanelBody.querySelector('select[data-claw-select]')) {
      window.ClawSelect.enhanceAll(featurePanelBody);
    }

    // 恢复滚动位置
    featurePanelBody.scrollTop = _savedBodyScrollTop;
    if (_savedInnerScrollTop != null) {
      const innerScroll = featurePanelBody.querySelector('.logf-list');
      if (innerScroll) innerScroll.scrollTop = _savedInnerScrollTop;
    }

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

    featurePanel.classList.add('body-ready');

    // 底部渐变：内容溢出时显示渐隐遮罩。
    // 日志面板使用内部滚动容器（.logf-list），body 本身不再溢出，需一并检查内层。
    const innerScroll = featurePanelBody.querySelector('.logf-list');
    featurePanel.classList.toggle('scrollable',
      featurePanelBody.scrollHeight > featurePanelBody.clientHeight + 4
      || (innerScroll && innerScroll.scrollHeight > innerScroll.clientHeight + 4));
  };

  if (options.deferBody === true) {
    featurePanel.classList.remove('body-ready');
    featurePanelBody.innerHTML = '';
    runAfterPanelOpenFrame(commitPanelBody);
    return;
  }

  commitPanelBody();
}

function toggleFeaturePanel(panelId) {
  // 捕获滚动锚点：panel 开/关是一次重大宽度突变，需要在布局应用后
  // 恢复阅读位置（跟随模式锁底 / 非跟随锚定到正在读的行）。
  const _anchor = (typeof captureChatViewportAnchor === 'function')
    ? captureChatViewportAnchor() : null;
  let _suppressApplied = false;
  if (_anchor && typeof suppressChatViewportObservers === 'function') {
    suppressChatViewportObservers(500);
    _suppressApplied = true;
  }

  const wasOpen = activeFeaturePanel === panelId;
  const shouldDeferBody = !activeFeaturePanel && !wasOpen;
  const previousPanel = activeFeaturePanel;

  // Lifecycle: close previous panel
  if (previousPanel && previousPanel !== panelId && window.GenUIPanel && previousPanel === 'genui') {
    window.GenUIPanel.onClose();
  }

  activeFeaturePanel = wasOpen ? null : panelId;
  renderFeaturePanel({ deferBody: shouldDeferBody });

  // 面板打开使中央区低于阈值时做级联适配（收左栏 → 缩右栏）。
  // 纯动作：复用 toggle 开头捕获的 _anchor，在下方 rAF 中一并恢复滚动。
  if (typeof _cascadeCentralWidth === 'function') {
    _cascadeCentralWidth();
  }

  // Lifecycle: open new panel
  if (!wasOpen && panelId === 'genui' && window.GenUIPanel) {
    window.GenUIPanel.onOpen();
  }

  // Lifecycle: close when toggling off
  if (wasOpen && panelId === 'genui' && window.GenUIPanel) {
    window.GenUIPanel.onClose();
  }

  // 初始化钩子：settings 面板首次打开时加载异步数据
  if (!wasOpen && panelId === 'settings' && window._wgSettingsInit) {
    window._wgSettingsInit();
  }
  // 初始化钩子：threads 面板首次打开时拉取数据
  if (!wasOpen && panelId === 'threads' && window._wgThreadsInit) {
    window._wgThreadsInit();
  }
  // 初始化钩子：git 面板每次打开时刷新当前会话目录的仓库状态
  if (!wasOpen && panelId === 'git' && window.GitPanel) {
    window.GitPanel.onOpen();
  }

  // 面板 class 已切换（宽度变化写入样式），下一帧布局应用新宽度后恢复滚动位置。
  if (_anchor && typeof applyChatViewportAnchor === 'function') {
    requestAnimationFrame(() => {
      applyChatViewportAnchor(_anchor);
      if (_suppressApplied && typeof resumeChatViewportObservers === 'function') {
        resumeChatViewportObservers();
      }
      if (_anchor.mode === 'follow' && typeof scheduleFollowLatestSettlePass === 'function') {
        scheduleFollowLatestSettlePass();
      }
    });
  }
}
