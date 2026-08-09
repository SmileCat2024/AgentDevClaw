/**
 * ClawSelect — 轻量自定义下拉增强器
 *
 * 将原生 <select> 增强为自定义下拉组件，保留原生元素在 DOM 中
 * （value 读取、onchange 派发均不受影响），仅替换视觉层。
 *
 * 视觉语言对齐 ccb-model-dropdown：
 *   - 弹出面板使用 var(--panel-bg) 底色
 *   - 选中项使用 var(--accent-bg) 紫色高亮
 *   - 6px 滚动条
 *
 * 用法：
 *   ClawSelect.enhance(selectEl)            — 增强单个 select
 *   ClawSelect.enhanceAll(container, sel)   — 批量增强
 *   ClawSelect.closeAll()                   — 关闭当前打开的面板
 */
(function () {
  'use strict';

  var CHEVRON_SVG =
    '<svg class="claw-select-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none"' +
    ' stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<polyline points="6 9 12 15 18 9"></polyline></svg>';

  // ── 全局状态 ──
  var _openCtx = null; // { panel, wrapper, select }

  // ── 辅助函数 ──

  function _getSelectedLabel(select) {
    var opt = select.options[select.selectedIndex];
    return opt ? opt.textContent : '';
  }

  function _buildTrigger(select) {
    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'claw-select-trigger';
    trigger.innerHTML =
      '<span class="claw-select-label">' + escapeHtml(_getSelectedLabel(select)) + '</span>' +
      CHEVRON_SVG;
    trigger.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      _toggle(select);
    });
    return trigger;
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function _updateLabel(wrapper, select) {
    var label = wrapper.querySelector('.claw-select-label');
    if (label) label.textContent = _getSelectedLabel(select);
  }

  // ── 面板构建 & 定位 ──

  function _buildPanel(select) {
    var panel = document.createElement('div');
    panel.className = 'claw-select-panel';

    // 继承紫色系变体标记
    var wrapper = select.closest('.claw-select');
    if (wrapper && wrapper.classList.contains('var-accent')) {
      panel.classList.add('accent');
    }

    var inner = document.createElement('div');
    inner.className = 'claw-select-panel-inner';

    for (var i = 0; i < select.options.length; i++) {
      var opt = select.options[i];
      var item = document.createElement('div');
      item.className = 'claw-select-item' + (opt.selected ? ' active' : '');
      item.textContent = opt.textContent;
      (function (val) {
        item.addEventListener('click', function (e) {
          e.stopPropagation();
          _selectOption(select, val);
          _close();
        });
      })(opt.value);
      inner.appendChild(item);
    }

    panel.appendChild(inner);
    return panel;
  }

  function _positionPanel(panel, trigger) {
    var rect = trigger.getBoundingClientRect();
    panel.style.minWidth = Math.max(rect.width, 180) + 'px';
    panel.style.left = rect.left + 'px';

    // 测量高度后决定向上还是向下展开
    var panelH = panel.offsetHeight;
    var spaceBelow = window.innerHeight - rect.bottom;
    if (panelH > spaceBelow && rect.top > spaceBelow) {
      panel.style.top = rect.top - panelH - 4 + 'px';
    } else {
      panel.style.top = rect.bottom + 4 + 'px';
    }
  }

  // ── 开关逻辑 ──

  function _toggle(select) {
    var wrapper = select.closest('.claw-select');
    if (!wrapper) return;
    if (wrapper.classList.contains('open')) {
      _close();
      return;
    }
    _close(); // 先关掉已有的

    if (!select.options.length) return;

    var panel = _buildPanel(select);
    document.body.appendChild(panel);
    _positionPanel(panel, wrapper.querySelector('.claw-select-trigger'));

    wrapper.classList.add('open');
    panel.classList.add('visible');

    _openCtx = { panel: panel, wrapper: wrapper, select: select };

    // 延迟注册，防止当前 click 冒泡触发立即关闭
    setTimeout(function () {
      document.addEventListener('click', _outsideClick, { once: true });
      document.addEventListener('scroll', _onScrollClose, { once: true, capture: true });
    }, 0);
  }

  function _close() {
    if (!_openCtx) return;
    var ctx = _openCtx;
    _openCtx = null;
    ctx.panel.remove();
    ctx.wrapper.classList.remove('open');
  }

  function _outsideClick(e) {
    if (!_openCtx) return;
    if (_openCtx.panel.contains(e.target)) {
      document.addEventListener('click', _outsideClick, { once: true });
      return;
    }
    var trigger = _openCtx.wrapper.querySelector('.claw-select-trigger');
    if (trigger && trigger.contains(e.target)) {
      // 点击了同一触发器 —— 交给 trigger click 处理
      return;
    }
    _close();
  }

  function _onScrollClose(e) {
    if (!_openCtx) return;
    // Don't close if scrolling inside the dropdown panel itself
    if (_openCtx.panel.contains(e.target)) {
      document.addEventListener('scroll', _onScrollClose, { once: true, capture: true });
      return;
    }
    _close();
  }

  // ── 选项选择 ──

  function _selectOption(select, value) {
    select.value = value;
    var wrapper = select.closest('.claw-select');
    if (wrapper) _updateLabel(wrapper, select);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ── 公开 API ──

  /**
   * 增强单个 <select> 元素。
   * 在原生 select 外包裹 .claw-select 容器，插入自定义触发器。
   * 原生 select 保留在 DOM 中但视觉隐藏。
   */
  function enhance(select) {
    if (!select || select.tagName !== 'SELECT') return null;
    if (select.dataset.clawEnhanced === 'true') return null;
    select.dataset.clawEnhanced = 'true';

    var wrapper = document.createElement('div');
    wrapper.className = 'claw-select';

    // compact 变体
    if (select.dataset.clawCompact === 'true') {
      wrapper.classList.add('compact');
    }

    // 紫色系变体（第一优先级 UI）
    if (select.dataset.clawAccent === 'true') {
      wrapper.classList.add('var-accent');
    }

    // 将原生 select 的 inline 布局样式转移到 wrapper
    var inlineStyle = select.getAttribute('style');
    if (inlineStyle) {
      wrapper.setAttribute('style', inlineStyle);
      select.removeAttribute('style');
    }

    // 插入 wrapper
    select.parentNode.insertBefore(wrapper, select);

    // 构建触发器
    var trigger = _buildTrigger(select);
    wrapper.appendChild(trigger);

    // 移动原生 select 到 wrapper（视觉隐藏）
    select.classList.add('claw-select-native');
    wrapper.appendChild(select);

    // 监听 options 变更 & value 变化（外部程序修改）
    if (window.MutationObserver) {
      var observer = new MutationObserver(function () {
        _updateLabel(wrapper, select);
      });
      observer.observe(select, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['selected'],
      });
      // 存储 observer 引用，防止 GC（select 存活期间 observer 存活）
      select._clawObserver = observer;
    }

    return wrapper;
  }

  /**
   * 批量增强容器内所有匹配的 <select>。
   * @param {Element|Document} container — 搜索容器
   * @param {string} selector — CSS 选择器，默认 'select[data-claw-select]'
   */
  function enhanceAll(container, selector) {
    if (!container) container = document;
    if (!selector) selector = 'select[data-claw-select]';
    var selects = container.querySelectorAll(selector);
    var count = 0;
    for (var i = 0; i < selects.length; i++) {
      if (enhance(selects[i])) count++;
    }
    return count;
  }

  window.ClawSelect = {
    enhance: enhance,
    enhanceAll: enhanceAll,
    closeAll: _close,
  };
})();
