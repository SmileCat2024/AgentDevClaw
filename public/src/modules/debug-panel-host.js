/**
 * debug-panel-host.js — 面板编排入口
 *
 * 从 debug-panels.js 拆出。必须在所有 debug-*.js 子模块之后加载。
 * 包含：
 *   - renderFeaturePanel（经 ClawPanels 注册表调用各面板 render）
 *   - toggleFeaturePanel
 *
 * 依赖（全局变量，声明于 app-core.js）：
 *   - activeFeaturePanel, featurePanelWidth
 *   - featurePanel, featurePanelBody, featurePanelTitle
 *   （rail 面板按钮由 syncRailButtons 动态生成，不再启动快照）
 *
 * 依赖（全局函数 / 注册表）：
 *   - t (app-core.js)
 *   - enhanceMathInElement (markdown-utils.js)
 *   - getFeaturePanelEmptyHtml (app-ui.js)
 *   - window.ClawPanels（唯一注册表：渲染寻址与可见性过滤同源）
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

/**
 * 面板自行原地更新了 body 内的部分内容（不经 renderFeaturePanel 全量替换）
 * 之后调用：重新求值当前面板的 render() 并记入签名缓存，使下一次
 * renderFeaturePanel 的内容签名对比视为"未变"而跳过 innerHTML 替换——
 * 否则滞后一拍的签名会让轮询 repaint 把面板整体重建（打断滚动/焦点）。
 * 面板未打开或 body 已归属其他面板时不做任何事。
 */
function syncPanelBodyHtmlCache() {
  const panelId = activeFeaturePanel;
  const panel = panelId && window.ClawPanels.get(panelId);
  if (!panel || featurePanelBody.dataset.panel !== panelId) return;
  try {
    _panelBodyHtmlCache.set(panelId, panel.render());
  } catch (_) { /* 求值失败保留旧签名，下一次 repaint 全量替换自愈 */ }
}

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

  if (!activeFeaturePanel || !window.ClawPanels.get(activeFeaturePanel)) {
    featurePanelRenderVersion += 1;
    _panelBodyHtmlCache.clear();
    featurePanel.classList.remove('open');
    featurePanel.classList.remove('body-ready');
    document.querySelector('.main-content')?.classList.remove('panel-open');
    featurePanelTitle.textContent = t('panel_structure');
    featurePanelBody.innerHTML = getFeaturePanelEmptyHtml();
    document.querySelectorAll('.rail-button[data-panel]').forEach(button => button.classList.remove('active'));
    // 清理可能残留的 Feature 详情弹窗 portal
    if (typeof renderFeatureDetailOverlay === 'function') {
      renderFeatureDetailOverlay(null);
    }
    return;
  }

  const panel = window.ClawPanels.get(activeFeaturePanel);
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
  document.querySelectorAll('.rail-button[data-panel]').forEach(button => {
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

/**
 * 面板生命周期统一经注册表元数据分发（ADR-0044 P2）：onOpen / onClose
 * 声明在 panels.register 的元数据上，编排层按事件名取钩子调用。
 * 钩子抛错只记录不中断——面板生命周期的失败不应拖垮开关面板本身。
 */
function notifyPanelLifecycle(panelId, hookName) {
  if (!panelId) return;
  const meta = window.ClawPanels.get(panelId);
  const hook = meta && typeof meta[hookName] === 'function' ? meta[hookName] : null;
  if (!hook) return;
  try {
    hook();
  } catch (err) {
    console.error(`[panel:${panelId}] ${hookName} failed`, err);
  }
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

  // Lifecycle: 切换面板时关闭前一个面板
  if (previousPanel && previousPanel !== panelId) {
    notifyPanelLifecycle(previousPanel, 'onClose');
  }

  activeFeaturePanel = wasOpen ? null : panelId;
  renderFeaturePanel({ deferBody: shouldDeferBody });

  // 面板打开使中央区低于阈值时做级联适配（收左栏 → 缩右栏）。
  // 纯动作：复用 toggle 开头捕获的 _anchor，在下方 rAF 中一并恢复滚动。
  if (typeof _cascadeCentralWidth === 'function') {
    _cascadeCentralWidth();
  }

  // Lifecycle: 打开新面板 / 关闭当前面板
  if (!wasOpen) {
    notifyPanelLifecycle(panelId, 'onOpen');
  } else {
    notifyPanelLifecycle(panelId, 'onClose');
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

// ═══════════════════════════════════════════════════════════════
// rail 按钮注册表派生（ADR-0044 P2b）
// ═══════════════════════════════════════════════════════════════
//
// 右栏按钮不再手写于 index.html：注册元数据带 icon 的面板在此生成按钮。
// id 约定 rail-<panelId>、徽标 rail-<panelId>-badge（todo-plan / bg-panel /
// generative-ui-panel 经 getElementById 引用，不可破坏）。order 字段标记
// 可自定义面板（进自定义弹窗、可拖拽排序），无 order 的面板按钮生成但由
// rail-customize 强制隐藏（行为等价此前的 CUSTOMIZABLE_PANEL_ORDER 屏蔽）。

function railButtonTitle(panel) {
  const lang = (typeof currentLanguage !== 'undefined' && currentLanguage === 'en') ? 'en' : 'zh';
  const meta = panel.label;
  if (meta && typeof meta === 'object') return meta[lang] || meta.en || panel.id;
  return typeof panel.title === 'function' ? panel.title() : panel.title;
}

function createRailButton(panel) {
  const btn = document.createElement('button');
  btn.className = 'rail-button';
  btn.id = 'rail-' + panel.id;
  btn.type = 'button';
  btn.title = railButtonTitle(panel);
  btn.dataset.panel = panel.id;
  btn.innerHTML = panel.icon + (panel.badge
    ? '<span class="rail-badge" id="rail-' + panel.id + '-badge"></span>'
    : '');
  btn.addEventListener('click', () => toggleFeaturePanel(panel.id));
  return btn;
}

/**
 * 按注册表同步 rail 按钮（幂等，轻量，可高频调用）：
 *   - 注册面板带 icon 且按钮缺席 → 生成并按序插入（customizable 的 order
 *     在前，其余按注册序垫底，统一插到 rail-spacer 之前）
 *   - 按钮指向的面板已不在注册表（或不再有 icon）→ 移除按钮
 * 面板可用性（when 过滤）不在此处管——renderCurrentMainView 对按钮
 * display 的控制照旧。语言切换后 title 重算经再次调用本函数完成。
 */
function syncRailButtons() {
  const rail = document.getElementById('right-rail');
  if (!rail) return;
  const panels = window.ClawPanels.getAll().filter((p) => p.icon);
  const panelById = new Map(panels.map((p) => [p.id, p]));

  // 孤儿按钮清理：面板被摘除（如插件卸载）时按钮随之消失
  rail.querySelectorAll('.rail-button[data-panel]').forEach((btn) => {
    const meta = panelById.get(btn.dataset.panel);
    if (!meta || btn.id !== 'rail-' + meta.id) btn.remove();
  });

  const anchor = rail.querySelector('.rail-spacer');
  const insertAt = (el) => rail.insertBefore(el, anchor || null);

  // 生成序：order 升序（customizable），无 order 的按注册序垫底
  const ordered = [...panels].sort((a, b) =>
    (a.order ?? Infinity) - (b.order ?? Infinity) || 0);
  for (const panel of ordered) {
    let btn = document.getElementById('rail-' + panel.id);
    if (!btn || !rail.contains(btn)) {
      btn = createRailButton(panel);
      insertAt(btn);
      continue;
    }
    // 已存在的按钮刷新 title（语言切换）
    btn.title = railButtonTitle(panel);
  }
}

// ═══════════════════════════════════════════════════════════════
// 面板摘除联动（ADR-0044 效果归属）
// ═══════════════════════════════════════════════════════════════

// 面板从注册表被摘除（如所属插件卸载）时，若它正打开，走空面板渲染把
// body 清空、open class 撤下、按钮 active 态复位。注册表不知道打开状态，
// 这层清理只能由编排层完成，经 setPanelTeardownHook 注入给 claw-host。
if (window.ClawHost && typeof window.ClawHost.setPanelTeardownHook === 'function') {
  window.ClawHost.setPanelTeardownHook((panelId) => {
    if (activeFeaturePanel !== panelId) return;
    activeFeaturePanel = null;
    renderFeaturePanel();
  });
}

window.syncRailButtons = syncRailButtons;
