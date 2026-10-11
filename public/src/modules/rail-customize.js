/**
 * rail-customize.js — 右边栏面板自定义
 *
 * 功能：
 *   - 在右边栏功能按钮下方添加"自定义"按钮（三个点图标）
 *   - 点击弹出模态弹窗（样式仿照项目内 feature-detail-overlay 弹窗）
 *   - 每个面板项含拖拽手柄、图标、名称、描述、开关
 *   - 支持拖拽排序
 *   - 边栏图标本身支持长按后拖动排序（与弹窗内拖拽等价，写同一份配置）
 *   - 配置持久化到 localStorage
 *   - 清单外面板彻底屏蔽：不进自定义弹窗，边栏按钮强制隐藏
 *
 * 依赖（全局变量，声明于 app-core.js）：
 *   - currentLanguage
 *   - activeFeaturePanel
 * 依赖（全局函数，声明于 debug-panel-host.js）：
 *   - renderFeaturePanel()
 */
(function () {
  'use strict';

  // ── 常量 ──────────────────────────────────────────────

  var STORAGE_KEY = 'agentdev-rail-config';
  var HIDDEN_CLASS = 'rail-custom-hidden';
  var MODAL_ID = 'rail-cust-overlay';

  // ── 面板清单（单一真相：Claw 面板注册表） ─────────────

  // 产品定义的可配置面板清单（顺序即默认相对顺序）。
  // 清单外面板（workspace / monitor / mcp / settings / threads / resources /
  // viewer 等）被彻底屏蔽：既不出现在自定义弹窗，也不出现在边栏。
  var CUSTOMIZABLE_PANEL_ORDER = [
    'plan', 'session-controls', 'git', 'bg', 'genui', 'hooks', 'inspector', 'logs',
  ];

  /** 可自定义面板仅限右侧栏主面板清单，并按默认顺序排列。 */
  function getCustomizableIds() {
    var panels = (window.ClawPanels && typeof window.ClawPanels.getAll === 'function')
      ? window.ClawPanels.getAll()
      : [];
    var registered = {};
    panels.forEach(function (panel) { registered[panel.id] = true; });
    return CUSTOMIZABLE_PANEL_ORDER.filter(function (id) {
      return registered[id] && !!document.querySelector('.rail-button[data-panel="' + id + '"]');
    });
  }

  // ── 辅助函数 ──────────────────────────────────────────

  function lang() {
    return (typeof currentLanguage !== 'undefined' && currentLanguage === 'en') ? 'en' : 'zh';
  }

  function i18nMeta(id, field) {
    var panel = window.ClawPanels ? window.ClawPanels.get(id) : null;
    var meta = panel ? panel[field] : null;
    if (!meta || typeof meta !== 'object') return field === 'label' ? id : '';
    return meta[lang()] || meta.en || (field === 'label' ? id : '');
  }

  function label(id) {
    return i18nMeta(id, 'label');
  }

  function desc(id) {
    return i18nMeta(id, 'description');
  }

  function getDefaultConfig() {
    return getCustomizableIds().map(function (id) { return { id: id, visible: true }; });
  }

  /** 旧面板 ID → 新面板 ID（重命名时保留用户已有排序与可见性） */
  var LEGACY_ID_MAP = {
    'force-continuation': 'session-controls',
  };

  function loadConfig() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return getDefaultConfig();
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return getDefaultConfig();
      parsed = parsed.map(function (item) {
        if (item && LEGACY_ID_MAP[item.id]) {
          return { id: LEGACY_ID_MAP[item.id], visible: item.visible !== false };
        }
        return item;
      });
      var customizable = getCustomizableIds();
      var known = {};
      customizable.forEach(function (id) { known[id] = true; });
      var valid = [];
      var seen = {};
      parsed.forEach(function (item) {
        if (!item || !known[item.id] || seen[item.id]) return;
        seen[item.id] = true;
        valid.push({ id: item.id, visible: item.visible !== false });
      });
      customizable.forEach(function (id) {
        if (!seen[id]) valid.push({ id: id, visible: true });
      });
      return valid;
    } catch (e) {
      return getDefaultConfig();
    }
  }

  function saveConfig(config) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch (e) { /* ignore */ }
  }

  function getPanelIconHTML(panelId) {
    var btn = document.querySelector('.rail-button[data-panel="' + panelId + '"]');
    if (!btn) return '';
    var svg = btn.querySelector('svg');
    return svg ? svg.outerHTML : '';
  }

  // ── DOM 引用 ──────────────────────────────────────────

  var custBtn = null;
  var dragSrcId = null;

  // ── 构建按钮 ───────────────────────────────────────────

  function ensureButton() {
    if (custBtn && document.contains(custBtn)) return;

    custBtn = document.createElement('button');
    custBtn.className = 'rail-button';
    custBtn.id = 'rail-customize';
    custBtn.type = 'button';
    custBtn.title = lang() === 'zh' ? '自定义面板' : 'Customize Panels';
    custBtn.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none">' +
      '<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>' +
      '</svg>';
    custBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openModal();
    });

    insertButtonIntoRail();
  }

  function findAnchor(rail) {
    var customizable = getCustomizableIds();
    var children = Array.from(rail.children);
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (c.classList.contains('rail-button') &&
          c.dataset.panel &&
          customizable.indexOf(c.dataset.panel) === -1) {
        return c;
      }
    }
    for (var j = 0; j < children.length; j++) {
      if (children[j].classList.contains('rail-spacer')) return children[j];
    }
    return null;
  }

  function insertButtonIntoRail() {
    var rail = document.getElementById('right-rail');
    if (!rail || !custBtn) return;
    var anchor = findAnchor(rail);
    if (anchor) {
      rail.insertBefore(custBtn, anchor);
    } else {
      rail.appendChild(custBtn);
    }
  }

  // ── 应用配置到 DOM（排序 + 可见性） ───────────────────

  function applyConfig() {
    var rail = document.getElementById('right-rail');
    if (!rail) return;
    ensureButton();

    var config = loadConfig();
    var anchor = findAnchor(rail);
    var activeCleared = false;
    var allowed = {};
    config.forEach(function (entry) { allowed[entry.id] = true; });

    for (var i = 0; i < config.length; i++) {
      var entry = config[i];
      var btn = rail.querySelector('.rail-button[data-panel="' + entry.id + '"]');
      if (!btn) continue;

      btn.classList.toggle(HIDDEN_CLASS, !entry.visible);

      if (!entry.visible &&
          typeof activeFeaturePanel !== 'undefined' &&
          activeFeaturePanel === entry.id) {
        activeFeaturePanel = null;
        activeCleared = true;
      }

      if (anchor) {
        rail.insertBefore(btn, anchor);
      }
    }

    // 清单外面板直接屏蔽：边栏按钮强制隐藏（rail-custom-hidden 带
    // !important，压过 renderCurrentMainView 的 inline display），若正
    // 处于激活态则一并清掉。
    var panelButtons = rail.querySelectorAll('.rail-button[data-panel]');
    for (var j = 0; j < panelButtons.length; j++) {
      var blockedBtn = panelButtons[j];
      var blockedId = blockedBtn.dataset.panel;
      if (allowed[blockedId]) continue;
      blockedBtn.classList.add(HIDDEN_CLASS);
      if (typeof activeFeaturePanel !== 'undefined' &&
          activeFeaturePanel === blockedId) {
        activeFeaturePanel = null;
        activeCleared = true;
      }
    }

    if (anchor) {
      rail.insertBefore(custBtn, anchor);
    } else {
      rail.appendChild(custBtn);
    }

    if (activeCleared && typeof renderFeaturePanel === 'function') {
      renderFeaturePanel();
    }
  }

  // ── 模态弹窗 ──────────────────────────────────────────

  function openModal() {
    // 如果已存在，先移除
    closeModal();

    var overlay = document.createElement('div');
    overlay.className = 'rail-cust-overlay';
    overlay.id = MODAL_ID;

    renderModalContent(overlay);
    document.body.appendChild(overlay);

    // 点击 overlay 背景关闭
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeModal();
    });

    // Escape 关闭
    function escHandler(e) {
      if (e.key === 'Escape') {
        closeModal();
        document.removeEventListener('keydown', escHandler);
      }
    }
    document.addEventListener('keydown', escHandler);

    // 聚焦 overlay 以接收键盘事件
    overlay.tabIndex = -1;
    overlay.focus();
  }

  function closeModal() {
    var existing = document.getElementById(MODAL_ID);
    if (existing) existing.remove();
  }

  function renderModalContent(overlay) {
    var config = loadConfig();
    var isZh = lang() === 'zh';

    var items = config.map(function (entry) {
      var iconHTML = getPanelIconHTML(entry.id);
      return (
        '<div class="rail-cust-item' + (entry.visible ? '' : ' disabled') + '" draggable="true" data-panel-id="' + entry.id + '">' +
          '<div class="rail-cust-grip">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">' +
              '<circle cx="9" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/>' +
              '<circle cx="15" cy="5" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="15" cy="19" r="1.5"/>' +
            '</svg>' +
          '</div>' +
          '<div class="rail-cust-icon">' + iconHTML + '</div>' +
          '<div class="rail-cust-info">' +
            '<div class="rail-cust-name">' + label(entry.id) + '</div>' +
            '<div class="rail-cust-desc">' + desc(entry.id) + '</div>' +
          '</div>' +
          '<label class="rail-cust-toggle">' +
            '<input type="checkbox" ' + (entry.visible ? 'checked' : '') + ' data-panel-id="' + entry.id + '" />' +
            '<span class="rail-cust-slider"></span>' +
          '</label>' +
        '</div>'
      );
    }).join('');

    overlay.innerHTML =
      '<div class="rail-cust-modal">' +
        '<div class="rail-cust-modal-header">' +
          '<span class="rail-cust-modal-title">' + (isZh ? '自定义面板' : 'Customize Panels') + '</span>' +
          '<button class="rail-cust-modal-close" type="button">' +
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
              '<path d="M6 6l12 12M18 6L6 18"/>' +
            '</svg>' +
          '</button>' +
        '</div>' +
        '<div class="rail-cust-list">' + items + '</div>' +
        '<div class="rail-cust-footer">' +
          '<button class="rail-cust-reset" type="button">' + (isZh ? '恢复默认' : 'Reset to Default') + '</button>' +
          '<span class="rail-cust-hint">' + (isZh ? '拖拽排序 · 点击开关切换显示 · 边栏图标可长按拖动' : 'Drag to reorder · Toggle to show/hide · Long-press rail icons to drag') + '</span>' +
        '</div>' +
      '</div>';

    bindModalEvents(overlay);
  }

  function bindModalEvents(overlay) {
    // 关闭按钮
    overlay.querySelector('.rail-cust-modal-close').addEventListener('click', closeModal);

    // 开关切换
    var checkboxes = overlay.querySelectorAll('.rail-cust-toggle input[type="checkbox"]');
    checkboxes.forEach(function (cb) {
      cb.addEventListener('change', function () {
        var id = cb.dataset.panelId;
        var config = loadConfig();
        for (var i = 0; i < config.length; i++) {
          if (config[i].id === id) {
            config[i].visible = cb.checked;
            break;
          }
        }
        saveConfig(config);
        applyConfig();
        // 更新 item 的 disabled 样式
        var item = cb.closest('.rail-cust-item');
        if (item) item.classList.toggle('disabled', !cb.checked);
      });
    });

    // 重置
    overlay.querySelector('.rail-cust-reset').addEventListener('click', function () {
      saveConfig(getDefaultConfig());
      applyConfig();
      renderModalContent(overlay);
    });

    // 拖拽排序
    bindDragDrop(overlay);
  }

  function bindDragDrop(overlay) {
    var items = overlay.querySelectorAll('.rail-cust-item');
    items.forEach(function (item) {
      item.addEventListener('dragstart', function (e) {
        dragSrcId = item.dataset.panelId;
        item.classList.add('dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', dragSrcId); } catch (err) { /* ignore */ }
        }
      });

      item.addEventListener('dragend', function () {
        item.classList.remove('dragging');
        overlay.querySelectorAll('.rail-cust-item').forEach(function (i) {
          i.classList.remove('drag-over-top', 'drag-over-bottom');
        });
        dragSrcId = null;
      });

      item.addEventListener('dragover', function (e) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        var targetId = item.dataset.panelId;
        if (targetId === dragSrcId) return;

        // 判断鼠标在 item 的上半还是下半
        var rect = item.getBoundingClientRect();
        var isUpper = e.clientY < rect.top + rect.height / 2;

        overlay.querySelectorAll('.rail-cust-item').forEach(function (i) {
          i.classList.remove('drag-over-top', 'drag-over-bottom');
        });
        item.classList.add(isUpper ? 'drag-over-top' : 'drag-over-bottom');
      });

      item.addEventListener('dragleave', function () {
        item.classList.remove('drag-over-top', 'drag-over-bottom');
      });

      item.addEventListener('drop', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var targetId = item.dataset.panelId;
        if (!dragSrcId || dragSrcId === targetId) return;

        var rect = item.getBoundingClientRect();
        var insertAfter = e.clientY >= rect.top + rect.height / 2;

        var config = loadConfig();
        var srcIdx = -1, tgtIdx = -1;
        for (var i = 0; i < config.length; i++) {
          if (config[i].id === dragSrcId) srcIdx = i;
          if (config[i].id === targetId) tgtIdx = i;
        }
        if (srcIdx < 0 || tgtIdx < 0) return;

        var moved = config.splice(srcIdx, 1)[0];
        // splice 后 tgtIdx 可能偏移，需要重新查找
        var newTgtIdx = -1;
        for (var j = 0; j < config.length; j++) {
          if (config[j].id === targetId) { newTgtIdx = j; break; }
        }
        if (newTgtIdx < 0) newTgtIdx = config.length;
        config.splice(insertAfter ? newTgtIdx + 1 : newTgtIdx, 0, moved);

        saveConfig(config);
        applyConfig();
        renderModalContent(overlay);
      });
    });
  }

  // ── 边栏图标长按拖动排序 ──────────────────────────────
  //
  // 与弹窗内拖拽排序等价：提交时写同一份 localStorage 配置。
  // 按住可自定义面板图标 LONG_PRESS_MS 进入拖动态（此前位移超过 slop
  // 视为普通点击/滚动意图，取消计时）。动效分四段提示手势状态：
  // 按压缓慢放大（蓄力）→ 激活抬升脉冲 → 拖拽本体 translateY 逐帧跟手、
  // 其余图标压暗并 FLIP 让位 → 松手回弹滑入最终槽位；
  // pointercancel 按已存配置恢复原状。

  var LONG_PRESS_MS = 500;
  var LONG_PRESS_SLOP = 8; // px，触发前允许的位移

  var lpDrag = null; // { btn, pointerId, startX, startY, active, timer }

  function isRailDragButton(btn) {
    return !!(btn && btn.dataset && btn.dataset.panel &&
      getCustomizableIds().indexOf(btn.dataset.panel) !== -1);
  }

  /** 拖拽参照只看当前渲染出来的按钮；隐藏按钮保持原位随之顺延。 */
  function isRailButtonRendered(btn) {
    return !btn.classList.contains(HIDDEN_CLASS) && btn.style.display !== 'none';
  }

  function getRenderedRailDragButtons() {
    var rail = document.getElementById('right-rail');
    if (!rail) return [];
    return Array.prototype.filter.call(
      rail.querySelectorAll('.rail-button[data-panel]'),
      function (btn) {
        return isRailDragButton(btn) && isRailButtonRendered(btn);
      });
  }

  /** 按 DOM 当前顺序读出可自定义面板的完整顺序（含隐藏项）。 */
  function getRailOrderFromDom() {
    var rail = document.getElementById('right-rail');
    if (!rail) return [];
    var customizable = getCustomizableIds();
    return Array.prototype.map.call(
      rail.querySelectorAll('.rail-button[data-panel]'),
      function (btn) { return btn.dataset.panel; }
    ).filter(function (id) { return customizable.indexOf(id) !== -1; });
  }

  /** 提交新顺序：保留各项 visible，清单外/未渲染条目按原顺序垫底。 */
  function commitRailOrder(orderedIds) {
    var config = loadConfig();
    var byId = {};
    config.forEach(function (entry) { byId[entry.id] = entry; });
    var next = [];
    var seen = {};
    orderedIds.forEach(function (id) {
      if (seen[id]) return;
      seen[id] = true;
      next.push(byId[id] || { id: id, visible: true });
    });
    config.forEach(function (entry) {
      if (!seen[entry.id]) next.push(entry);
    });
    saveConfig(next);
    applyConfig();
  }

  function cancelLongPress() {
    if (!lpDrag) return;
    clearTimeout(lpDrag.timer);
    lpDrag.btn.classList.remove('rail-pressing');
    lpDrag = null;
  }

  function suppressTouchMove(e) { e.preventDefault(); }

  function beginRailDrag() {
    if (!lpDrag) return;
    var rect = lpDrag.btn.getBoundingClientRect();
    lpDrag.grabOffsetY = lpDrag.clientY - rect.top;
    lpDrag.height = rect.height;
    lpDrag.shiftY = 0;
    lpDrag.active = true;
    lpDrag.btn.classList.remove('rail-pressing');
    lpDrag.btn.classList.add('rail-dragging');
    if (navigator.vibrate) navigator.vibrate(10); // 触摸设备轻震，提示进入拖动
    document.body.classList.add('rail-drag-active');
    // 拖动激活后阻断触摸滚动，否则 move 会被浏览器接管
    document.addEventListener('touchmove', suppressTouchMove, { passive: false });
    applyDragTransform();
    try { lpDrag.btn.setPointerCapture(lpDrag.pointerId); } catch (e) { /* ignore */ }
  }

  function finishRailDrag(commit) {
    var drag = lpDrag;
    if (!drag) return;
    lpDrag = null;
    clearTimeout(drag.timer);
    document.removeEventListener('touchmove', suppressTouchMove);
    document.body.classList.remove('rail-drag-active');
    if (!drag.active) {
      drag.btn.classList.remove('rail-pressing', 'rail-dragging');
      return;
    }
    suppressNextRailClick();
    if (commit) {
      commitRailOrder(getRailOrderFromDom());
      settleRailDrag(drag); // 从松手位置平滑滑入最终槽位
    } else {
      drag.btn.style.transform = '';
      drag.btn.classList.remove('rail-dragging');
      applyConfig(); // pointercancel：按已存配置恢复原顺序
    }
  }

  /** 拖拽本体 1:1 跟手：相对当前 DOM 槽位平移，让按钮抓取点始终在指针下。 */
  function applyDragTransform() {
    var drag = lpDrag;
    if (!drag || !drag.active) return;
    var homeTop = drag.btn.getBoundingClientRect().top - drag.shiftY;
    drag.shiftY = drag.clientY - drag.grabOffsetY - homeTop;
    drag.btn.style.transform = 'translateY(' + drag.shiftY + 'px)';
  }

  /** 兄弟按钮让位动画（FLIP）：记录重排前位置，重排后从位移差滑回槽位。 */
  function flipReorder(dragBtn, mutate) {
    var visible = getRenderedRailDragButtons().filter(function (btn) {
      return btn !== dragBtn;
    });
    var before = visible.map(function (btn) {
      return { el: btn, top: btn.getBoundingClientRect().top };
    });
    mutate();
    before.forEach(function (item) {
      var delta = item.top - item.el.getBoundingClientRect().top;
      if (!delta) return;
      item.el.style.transition = 'none';
      item.el.style.transform = 'translateY(' + delta + 'px)';
      void item.el.offsetWidth; // 强制回流：让位起点先生效，再过渡回槽位
      item.el.style.transition = '';
      item.el.style.transform = '';
    });
  }

  /** 松手后从指针位置平滑滑入最终槽位（先按最终槽位反放位移，再过渡归零）。 */
  function settleRailDrag(drag) {
    var btn = drag.btn;
    var homeTop = btn.getBoundingClientRect().top - drag.shiftY;
    var shift = drag.clientY - drag.grabOffsetY - homeTop;
    btn.classList.remove('rail-dragging');
    if (!shift) {
      btn.style.transform = '';
      return;
    }
    btn.style.transition = 'none';
    btn.style.transform = 'translateY(' + shift + 'px)';
    void btn.offsetWidth;
    // 回弹曲线：轻微过冲再落位，强化"放下"手感
    btn.style.transition = 'transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1)';
    btn.style.transform = '';
    setTimeout(function () { btn.style.transition = ''; }, 300);
  }

  /** 拖拽松手后吞掉随溢出的那次 click，避免误开面板。 */
  function suppressNextRailClick() {
    var swallow = function (e) {
      e.stopPropagation();
      e.preventDefault();
      cleanup();
    };
    var cleanup = function () {
      document.removeEventListener('click', swallow, true);
    };
    document.addEventListener('click', swallow, true);
    setTimeout(cleanup, 600);
  }

  function reorderRailDrag() {
    var drag = lpDrag;
    if (!drag || !drag.active) return;
    var center = drag.clientY - drag.grabOffsetY + drag.height / 2; // 拖拽按钮视觉中心
    var siblings = getRenderedRailDragButtons().filter(function (btn) {
      return btn !== drag.btn;
    });
    for (var i = 0; i < siblings.length; i++) {
      var rect = siblings[i].getBoundingClientRect();
      if (center < rect.top + rect.height / 2) {
        if (siblings[i].previousElementSibling !== drag.btn) {
          var target = siblings[i];
          flipReorder(drag.btn, function () {
            target.parentNode.insertBefore(drag.btn, target);
          });
          applyDragTransform(); // 槽位变了，按新槽位重新锚定跟手位移
        }
        return;
      }
    }
    var last = siblings[siblings.length - 1];
    if (last && last.nextElementSibling !== drag.btn) {
      flipReorder(drag.btn, function () {
        last.parentNode.insertBefore(drag.btn, last.nextElementSibling);
      });
      applyDragTransform();
    }
  }

  function onRailPointerDown(e) {
    if (e.button != null && e.button !== 0) return;
    var target = e.target;
    var btn = target && target.closest ? target.closest('.rail-button[data-panel]') : null;
    if (!isRailDragButton(btn) || lpDrag) return;
    lpDrag = {
      btn: btn,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      clientY: e.clientY,
      active: false,
      timer: setTimeout(beginRailDrag, LONG_PRESS_MS),
    };
    // 按压蓄力：缓慢放大提示"继续按住可拖动"
    btn.classList.add('rail-pressing');
  }

  function onRailPointerMove(e) {
    if (!lpDrag || e.pointerId !== lpDrag.pointerId) return;
    lpDrag.clientY = e.clientY;
    if (!lpDrag.active) {
      var dx = e.clientX - lpDrag.startX;
      var dy = e.clientY - lpDrag.startY;
      if (dx * dx + dy * dy > LONG_PRESS_SLOP * LONG_PRESS_SLOP) {
        cancelLongPress();
      }
      return;
    }
    e.preventDefault();
    applyDragTransform();
    reorderRailDrag();
  }

  function onRailPointerUp(e) {
    if (!lpDrag || e.pointerId !== lpDrag.pointerId) return;
    finishRailDrag(true);
  }

  function onRailPointerCancel(e) {
    if (!lpDrag || e.pointerId !== lpDrag.pointerId) return;
    finishRailDrag(false);
  }

  function onRailContextMenu(e) {
    // 长按期间屏蔽系统右键/触摸长按菜单，避免打断拖动手势
    if (lpDrag) e.preventDefault();
  }

  function bindRailDragGesture() {
    var rail = document.getElementById('right-rail');
    if (!rail) return;
    rail.addEventListener('pointerdown', onRailPointerDown);
    rail.addEventListener('pointermove', onRailPointerMove);
    rail.addEventListener('pointerup', onRailPointerUp);
    rail.addEventListener('pointercancel', onRailPointerCancel);
    rail.addEventListener('contextmenu', onRailContextMenu);
  }

  // ── 语言更新 ──────────────────────────────────────────

  function updateLang() {
    if (custBtn) {
      custBtn.title = lang() === 'zh' ? '自定义面板' : 'Customize Panels';
    }
    var overlay = document.getElementById(MODAL_ID);
    if (overlay) {
      renderModalContent(overlay);
    }
  }

  // ── 初始化 ────────────────────────────────────────────

  ensureButton();
  applyConfig();
  bindRailDragGesture();
  updateLang();

  var langToggle = document.getElementById('language-toggle');
  if (langToggle) {
    langToggle.addEventListener('click', function () {
      setTimeout(updateLang, 0);
    });
  }

  // Public API
  window.applyRailConfig = applyConfig;
  window.closeRailCustomizeModal = closeModal;
  window.RailCustomize = {
    getCustomizableIds: getCustomizableIds,
    loadConfig: loadConfig,
    label: label,
    description: desc,
    commitRailOrder: commitRailOrder,
  };
})();
