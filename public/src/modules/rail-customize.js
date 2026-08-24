/**
 * rail-customize.js — 右边栏面板自定义
 *
 * 功能：
 *   - 在右边栏功能按钮下方添加"自定义"按钮（三个点图标）
 *   - 点击弹出模态弹窗（样式仿照项目内 feature-detail-overlay 弹窗）
 *   - 每个面板项含拖拽手柄、图标、名称、描述、开关
 *   - 支持拖拽排序
 *   - 配置持久化到 localStorage
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

  /** 可自定义的面板 ID（顺序 = 默认顺序） */
  var CUSTOMIZABLE_IDS = [
    'workspace', 'monitor', 'plan', 'hooks',
    'inspector', 'session-controls', 'logs', 'mcp', 'genui',
  ];

  /** 面板名称（i18n） */
  var LABELS = {
    workspace: { zh: '文件结构',  en: 'Structure' },
    monitor:   { zh: '监控',      en: 'Monitor' },
    plan:      { zh: '计划',      en: 'Plan' },
    hooks:     { zh: '功能',      en: 'Features' },
    inspector: { zh: '反向钩子',  en: 'Reverse Hooks' },
    'session-controls': { zh: '会话控制', en: 'Session Controls' },
    logs:      { zh: '日志',      en: 'Logs' },
    mcp:       { zh: 'MCP',       en: 'MCP' },
    genui:     { zh: '交互页面',  en: 'Interactive Pages' },
  };

  /** 面板描述（i18n） */
  var DESCS = {
    workspace: { zh: '项目文件树',       en: 'Project file tree' },
    monitor:   { zh: '运行状态监控',     en: 'Runtime status monitor' },
    plan:      { zh: '任务与计划列表',   en: 'Tasks and plan list' },
    hooks:     { zh: 'Feature 功能面板', en: 'Feature panel' },
    inspector: { zh: 'Hook 检查器',      en: 'Hook inspector' },
    'session-controls': { zh: '自动接续与上下文拦截', en: 'Auto-resume and context intercept' },
    logs:      { zh: '运行日志',         en: 'Runtime logs' },
    mcp:       { zh: 'MCP 服务端',       en: 'MCP servers' },
    genui:     { zh: 'UI 交互页面',      en: 'Interactive UI pages' },
  };

  // ── 辅助函数 ──────────────────────────────────────────

  function lang() {
    return (typeof currentLanguage !== 'undefined' && currentLanguage === 'en') ? 'en' : 'zh';
  }

  function label(id) {
    var e = LABELS[id];
    return e ? (e[lang()] || e.en) : id;
  }

  function desc(id) {
    var e = DESCS[id];
    return e ? (e[lang()] || e.en) : '';
  }

  function getDefaultConfig() {
    return CUSTOMIZABLE_IDS.map(function (id) { return { id: id, visible: true }; });
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
      var known = {};
      CUSTOMIZABLE_IDS.forEach(function (id) { known[id] = true; });
      var valid = [];
      var seen = {};
      parsed.forEach(function (item) {
        if (!item || !known[item.id] || seen[item.id]) return;
        seen[item.id] = true;
        valid.push({ id: item.id, visible: item.visible !== false });
      });
      CUSTOMIZABLE_IDS.forEach(function (id) {
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
    var children = Array.from(rail.children);
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (c.classList.contains('rail-button') &&
          c.dataset.panel &&
          CUSTOMIZABLE_IDS.indexOf(c.dataset.panel) === -1) {
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
          '<span class="rail-cust-hint">' + (isZh ? '拖拽排序 · 点击开关切换显示' : 'Drag to reorder · Toggle to show/hide') + '</span>' +
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
})();
