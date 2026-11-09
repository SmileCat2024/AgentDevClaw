/**
 * rail-customize.js — 右边栏面板自定义
 *
 * 功能：
 *   - 在右边栏功能按钮下方添加"自定义"按钮（三个点图标）
 *   - 点击弹出模态弹窗（样式仿照项目内 feature-detail-overlay 弹窗）
 *   - 每个面板项含拖拽手柄、图标、名称、描述、开关
 *   - 支持拖拽排序
 *   - 边栏图标本身支持拖动排序（鼠标按下移动即拖动；触摸长按后拖动），
 *     与弹窗内拖拽等价，写同一份配置
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

  var STORAGE_KEY = 'agentdev-rail-config';                 // 旧形态（迁移源，只读）
  var MIGRATED_KEY_PREFIX = 'agentdev-rail-config-migrated:'; // 按空间的迁移标记
  var HIDDEN_CLASS = 'rail-custom-hidden';
  var MODAL_ID = 'rail-cust-overlay';

  // ── 面板清单（单一真相：Claw 面板注册表） ─────────────

  // 可自定义面板 = 注册元数据带 order 的面板（order 即默认相对顺序，
  // ADR-0044 P2b 取代此前的硬编码 CUSTOMIZABLE_PANEL_ORDER）。无 order
  // 的面板（workspace / monitor / mcp / resources / viewer / threads /
  // settings 等）被彻底屏蔽：既不出现在自定义弹窗，也不出现在边栏。
  function getCustomizableIds() {
    var panels = (window.ClawPanels && typeof window.ClawPanels.getAll === 'function')
      ? window.ClawPanels.getAll()
      : [];
    return panels
      .filter(function (panel) {
        return typeof panel.order === 'number'
          && !!panel.icon
          && !!document.querySelector('.rail-button[data-panel="' + panel.id + '"]');
      })
      .sort(function (a, b) { return a.order - b.order; })
      .map(function (panel) { return panel.id; });
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

  // ── 服务端持久化（ADR-0046 决策 3：呈现配置随工作空间走） ──
  //
  // 内存态是渲染唯一依据（applyConfig / 拖拽 / 弹窗全部同步读内存），
  // 持久化异步收敛到服务端 sparse 形态（{panelId:{visible,order}}）：
  //   - 初始化：GET 拉取 → 服务端无配置且浏览器有旧值时一次性迁移
  //   - 写操作：内存先更（乐观）+ PUT 异步落盘
  //   - localStorage 旧键保留不删（回滚安全），迁移标记后不再读

  // remote.sparse 保留服务端 sparse 原文：初始 GET 可能在 chat 面板按钮
  // 渲染前返回（刷新后停在首页），一次性解析会把保存的条目全部当清单外
  // 丢弃；之后进会话按钮出现也不再重拉，表现为"刷新后自定义顺序丢失"。
  // 解析推迟到每次应用时（loadConfig 按当前清单现算），按钮集合后到也能恢复。
  var remote = { agentId: null, config: null, sparse: null }; // config = 数组形态（沿用既有消费逻辑）
  var configRevisionByAgent = Object.create(null);
  var persistQueueByAgent = Object.create(null);

  function currentUiAgentId() {
    // 聚焦工作空间（app-core 顶层 let，模块作用域链可见）
    try {
      if (typeof focusedAgentId === 'string' && focusedAgentId) {
        // 远程空间：呈现配置属于远端服务，本地不读不写（返回 null，调用方跳过请求）
        if (typeof isRemoteNamespaceAgentId === 'function' && isRemoteNamespaceAgentId(focusedAgentId)) {
          return null;
        }
        return focusedAgentId;
      }
    } catch (e) { /* 未声明（加载顺序异常）时走 fallback */ }
    // 全局首页 / 身份未落定的过渡态：home 是独立身份域（服务端按需懒建目录）。
    // 绝不回退主空间——那会让全局首页与其他过渡态界面共用编程小助手的
    // 呈现配置（跨工作空间读写，违反 ADR-0046"配置随工作空间走"）。
    return 'home';
  }

  /** 数组形态 → 服务端 sparse 形态（order = 数组下标，稳定相对序）。 */
  function arrayToSparse(config) {
    var sparse = {};
    (config || []).forEach(function (entry, index) {
      sparse[entry.id] = { visible: entry.visible !== false, order: index };
    });
    return sparse;
  }

  /** 服务端 sparse 形态 → 数组形态（order 升序；清单外条目剔除，缺失项由补齐逻辑垫默认）。 */
  function sparseToArray(sparse, customizable) {
    var entries = [];
    Object.keys(sparse || {}).forEach(function (id) {
      var item = sparse[id];
      if (!item || typeof item !== 'object') return;
      entries.push({ id: id, visible: item.visible !== false, order: typeof item.order === 'number' ? item.order : 99 });
    });
    entries.sort(function (a, b) { return a.order - b.order; });
    var known = {};
    customizable.forEach(function (id) { known[id] = true; });
    var seen = {};
    var valid = [];
    entries.forEach(function (entry) {
      if (!known[entry.id] || seen[entry.id]) return;
      seen[entry.id] = true;
      valid.push({ id: entry.id, visible: entry.visible });
    });
    customizable.forEach(function (id) {
      if (!seen[id]) valid.push({ id: id, visible: true });
    });
    return valid;
  }

  /** 读旧 localStorage（迁移源；LEGACY_ID_MAP 映射 + 清单校验后返回数组形态）。 */
  function readLegacyConfig() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) return null;
      var customizable = getCustomizableIds();
      var known = {};
      customizable.forEach(function (id) { known[id] = true; });
      var mapped = [];
      var seen = {};
      parsed.forEach(function (item) {
        if (!item || typeof item.id !== 'string') return;
        var id = LEGACY_ID_MAP[item.id] || item.id;
        if (!known[id] || seen[id]) return;
        seen[id] = true;
        mapped.push({ id: id, visible: item.visible !== false });
      });
      return mapped.length > 0 ? mapped : null;
    } catch (e) {
      return null;
    }
  }

  function fetchUiPrefs(agentId) {
    return fetch('/api/feature-ui/ui-prefs?agentId=' + encodeURIComponent(agentId))
      .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status)); })
      .then(function (body) { return (body && body.prefs) || {}; });
  }

  function persistPresentation(agentId, config) {
    var snapshot = arrayToSparse(config);
    var send = function () {
      return fetch('/api/feature-ui/ui-prefs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: agentId, presentation: snapshot }),
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
      });
    };
    // 首次写立即发出；后续写等待前一请求完成，避免网络乱序让旧顺序最后落盘。
    var previous = persistQueueByAgent[agentId];
    var write = (previous ? previous.catch(function () {}).then(send) : send()).catch(function (err) {
      // 落盘失败不回滚 UI；下一次操作重试完整快照。
      console.warn('[rail-customize] 呈现配置落盘失败（下次操作重试）：', err);
    });
    persistQueueByAgent[agentId] = write;
    return write;
  }

  /** 拉取当前空间的呈现配置；服务端无配置且浏览器有旧值时执行一次性迁移。 */
  function loadRemote(agentId) {
    return fetchUiPrefs(agentId).then(function (prefs) {
      var presentation = prefs && prefs.presentation && Object.keys(prefs.presentation).length > 0
        ? prefs.presentation
        : null;
      if (!presentation) {
        var markKey = MIGRATED_KEY_PREFIX + agentId;
        var legacy = localStorage.getItem(markKey) ? null : readLegacyConfig();
        if (legacy) {
          localStorage.setItem(markKey, '1');
          persistPresentation(agentId, legacy);
          return { sparse: arrayToSparse(legacy), config: legacy };
        }
        return { sparse: null, config: null };
      }
      // 不在这里解析成数组：解析依赖当时的面板清单，按钮未渲染时会失真
      return { sparse: presentation, config: null };
    });
  }

  /** 空间切换感知：聚焦身份变了则重拉并重放（异步，不阻塞本次 apply）。 */
  function reloadIfAgentChanged() {
    var agentId = currentUiAgentId();
    // 远程身份（null）用哨兵比对，避免与初始 null 相等而跳过清理
    var scopeKey = agentId || '(remote)';
    if (remote.agentId === scopeKey) return;
    remote.agentId = scopeKey;
    if (!agentId) {
      // 远程空间：不读本地文件，清掉上一空间的配置回默认呈现
      remote.sparse = null;
      remote.config = null;
      applyConfig();
      return;
    }
    var revision = configRevisionByAgent[agentId] || 0;
    loadRemote(agentId).then(function (loaded) {
      // GET 期间发生本地写入时，旧响应不能覆盖新顺序。
      if ((configRevisionByAgent[agentId] || 0) !== revision || remote.agentId !== agentId) return;
      remote.sparse = loaded.sparse;
      remote.config = loaded.config;
      applyConfig();
    }).catch(function (err) {
      console.warn('[rail-customize] 呈现配置拉取失败（沿用内存态）：', err);
    });
  }

  function loadConfig() {
    // sparse 存在时按当前清单现算：面板按钮集合后到（进会话）也能恢复
    // 服务端保存的顺序，而不是被 GET 时刻的空清单固化。
    if (remote.sparse) return sparseToArray(remote.sparse, getCustomizableIds());
    if (remote.config) return remote.config;
    // 服务端配置未落定（初始化竞态）：默认配置先行，落定后 applyConfig 修正
    return getDefaultConfig();
  }

  /** 插件面板可在初始偏好 GET 之后才注册；把新面板并入当前空间顺序，避免被误判为清单外。 */
  function reconcileConfigPanels(config) {
    var ids = getCustomizableIds();
    var next = (config || []).slice();
    var present = Object.create(null);
    next.forEach(function (entry) { present[entry.id] = true; });
    ids.forEach(function (id) {
      if (!present[id]) next.push({ id: id, visible: true });
    });
    return next;
  }

  function saveConfig(config) {
    var agentId = currentUiAgentId();
    remote.config = config;
    if (!agentId) {
      // 远程空间：内存态生效（当次会话内排序可用），不写本地文件
      remote.sparse = null;
      return;
    }
    remote.agentId = agentId;
    remote.sparse = arrayToSparse(config);
    configRevisionByAgent[agentId] = (configRevisionByAgent[agentId] || 0) + 1;
    persistPresentation(agentId, config);
  }

  function getPanelIconHTML(panelId) {
    // 图标来自注册元数据（ADR-0044 P2b）；旧实现从按钮 DOM 提取 SVG，
    // 按钮动态生成后元数据是唯一权威来源。
    var panel = window.ClawPanels ? window.ClawPanels.get(panelId) : null;
    return panel && typeof panel.icon === 'string' ? panel.icon : '';
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
    // 空间切换感知：身份变化时后台重拉（异步），本次仍按内存态应用
    reloadIfAgentChanged();

    var config = reconcileConfigPanels(loadConfig());
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
          '<span class="rail-cust-hint">' + (isZh ? '拖拽排序 · 点击开关切换显示 · 边栏图标可直接拖动（触屏长按）' : 'Drag to reorder · Toggle to show/hide · Drag rail icons (long-press on touch)') + '</span>' +
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
        var config = reconcileConfigPanels(loadConfig());
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

  // ── 边栏图标拖动排序 ──────────────────────────────────
  //
  // 与弹窗内拖拽排序等价：提交时写同一份配置。
  // 激活语义按指针类型分流：鼠标拖动没有滚动歧义，按下后位移超过 slop
  // 立即进入拖动态（"按下就拖"的自然手势）；触摸/笔保留长按激活（与滚动
  // 手势区分，长按前位移超过 slop 视为普通点击/滚动意图，取消计时）。
  // 松手时按最终指针位置做一次确定性归位：实时换位依赖兄弟按钮的矩形，
  // 快速甩动时矩形可能还处在 FLIP 让位动画中途，仅靠逐帧判定会漏判，
  // 漏判的松手会把拖动前的旧顺序提交落盘（表现为"拖了但没保存"）。
  // 动效分四段提示手势状态：按压缓慢放大（蓄力）→ 激活抬升脉冲 →
  // 拖拽本体 translateY 逐帧跟手、其余图标压暗并 FLIP 让位 →
  // 松手回弹滑入最终槽位；pointercancel 按已存配置恢复原状。

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
    var config = reconcileConfigPanels(loadConfig());
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
    // 顺序与可见性均未变化（visible 全部沿用 config 原值）：不落盘。
    // 亚阈值松手（未跨过相邻按钮中点）会走到这里，无效 PUT 会把
    // 旧快照写回服务端并污染文件修改时间，掩盖真实问题的取证。
    var unchanged = config.length === next.length && config.every(function (entry, i) {
      return entry.id === next[i].id && entry.visible === next[i].visible;
    });
    if (!unchanged) saveConfig(next);
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
    // 抓取点取按下时指针相对按钮的偏移，而不是激活时刻：鼠标路径在
    // 移动途中激活（指针已离开按钮原位），用激活时刻位置会让按钮
    // 视觉中心整体滞后指针，松手归位的槽位随之偏移。
    lpDrag.grabOffsetY = lpDrag.startY - rect.top;
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
    // 松手按最终指针位置做一次确定性归位：实时换位读的兄弟矩形可能处于
    // FLIP 让位动画中途，逐帧判定漏掉跨槽位时，这里兜住——否则提交的是
    // 拖动前的旧顺序（lpDrag 此刻仍指向 drag，reorderRailDrag 可用）。
    if (commit && drag.active) reorderRailDrag();
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
      pointerType: e.pointerType || '',
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
        // 位移语义按指针类型分流：鼠标按下即有拖动意图（无滚动歧义），
        // 位移越过 slop 立即激活；触摸/笔保留长按模型（区分滚动手势）。
        if (lpDrag.pointerType === 'mouse') beginRailDrag();
        else cancelLongPress();
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
  applyConfig();       // 同步先行（默认配置），服务端配置落定后修正
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
    reconcileConfigPanels: function (panels) {
      // 保持现有空间配置，只用声明顺序补充新装配面板的默认项。
      var ids = getCustomizableIds();
      var prior = loadConfig();
      var present = Object.create(null);
      prior.forEach(function (entry) { present[entry.id] = true; });
      ids.forEach(function (id) {
        if (!present[id]) prior.push({ id: id, visible: true });
      });
      return prior;
    },
    label: label,
    description: desc,
    commitRailOrder: commitRailOrder,
    // 形态互转纯函数（服务端 sparse ↔ 前端数组；测试与诊断用）
    arrayToSparse: arrayToSparse,
    sparseToArray: sparseToArray,
  };
})();
