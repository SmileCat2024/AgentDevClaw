/**
 * debug-features-hooks.js — Features 面板 + Reverse Hooks 面板
 *
 * 从 debug-panels.js 拆出。包含：
 *   - renderFeaturesPanel
 *   - renderReverseHooksPanel
 *   - renderFeatureDetailOverlay（独立 portal，挂载于 document.body）
 *
 * 依赖（全局变量，声明于 app-core.js）：
 *   - selectedFeatureName, currentHookInspector
 *
 * 依赖（全局函数）：
 *   - escapeHtml, t (app-core.js)
 *   - getFeatureStatus, getStatusBadgeClass, getFeatureStatusLabel,
 *     shortenSourcePath (app-ui.js / overview-data.js)
 */

// ═══════════════════════════════════════════════════════════════
// Features / Reverse Hooks 面板
// ═══════════════════════════════════════════════════════════════

// 分组展开偏好（跨轮询重渲染保持状态；对齐 _lifecycleOpenPref 模式）。
const _featureGroupOpenPref = new Map();

/**
 * 分组 details ontoggle 回调：用户操作过的组按其偏好恢复。
 */
function featureGroupToggled(typeId, open) {
  _featureGroupOpenPref.set(typeId, open);
}
window.featureGroupToggled = featureGroupToggled;

// 功能类型分组头文案（能力/会话与行为/渠道与交互/系统组件；兜底组独立 key）
function featureGroupLabel(typeId) {
  return t(typeId === '_unmapped' ? 'feature_cat_unmapped' : 'feature_type_' + typeId);
}

// ── 面板头部筛选：来源分页器（全部/默认内置/已安装）+ 能力下拉 ──────

const FEATURE_FILTERS = ['all', 'bundled', 'installed'];
const FEATURE_FILTER_STORAGE_KEY = 'claw_feature_panel_filter';
let _featurePanelFilter = 'all';
try {
  const saved = localStorage.getItem(FEATURE_FILTER_STORAGE_KEY);
  if (FEATURE_FILTERS.includes(saved)) _featurePanelFilter = saved;
} catch (e) { /* localStorage 不可用时保持默认 */ }

// 能力筛选持久化：合法词表由 catalog 响应携带（前端不硬编码词表），
// 存储值过期（词表演进）时经 normalizeCapFilter 归一为 'all'，不会滤成空。
const FEATURE_CAP_STORAGE_KEY = 'claw_feature_panel_cap_filter';
let _featurePanelCapFilter = 'all';
try {
  const saved = localStorage.getItem(FEATURE_CAP_STORAGE_KEY);
  if (typeof saved === 'string' && saved) _featurePanelCapFilter = saved;
} catch (e) { /* 同上 */ }

function _persistPanelFilters() {
  try {
    localStorage.setItem(FEATURE_FILTER_STORAGE_KEY, _featurePanelFilter);
    localStorage.setItem(FEATURE_CAP_STORAGE_KEY, _featurePanelCapFilter);
  } catch (e) { /* 同上 */ }
}

function _refreshPanelAfterFilterChange() {
  // 乐观渲染：筛选是纯本地状态（数据已在 currentHookInspector 内存中），
  // 同步重渲染面板立即生效——经 _scheduleInspectorRefresh 走完整 poll
  // 周期会引入一轮网络往返的迟滞。面板未打开时无需渲染，状态已持久化，
  // 下次打开按新筛选渲染。
  if (activeFeaturePanel === 'hooks' && typeof renderFeaturePanel === 'function') {
    renderFeaturePanel();
  }
}

window.setFeaturePanelFilter = function (filter) {
  if (!FEATURE_FILTERS.includes(filter) || filter === _featurePanelFilter) return;
  _featurePanelFilter = filter;
  _persistPanelFilters();
  _refreshPanelAfterFilterChange();
};

window.setFeaturePanelCapFilter = function (cap) {
  if (typeof cap !== 'string' || !cap || cap === _featurePanelCapFilter) return;
  _featurePanelCapFilter = cap;
  _persistPanelFilters();
  _refreshPanelAfterFilterChange();
};

// ── commands 运行时信号：提供 slash 命令的 feature 名集合 ──────────
// /protoclaw/commands 的 ref 格式为 feature.command（registry 平面寻址），
// 按当前控制目标（agentId + runtimeId）拉取，键随目标变化自动失效。
// 首次到位后触发一帧面板重渲染（与 catalog 首载同模式）；不可用时
// enrichFeatureEntry 对 commands 维度回退 seed 标注。

let _commandFeatures = null;          // Map<string, number> | null（feature → slash 命令数；null = 数据不可用）
let _commandFeaturesKey = null;

function _ensureCommandFeatures() {
  if (typeof getCurrentControlAgentId !== 'function' || typeof getRuntimeId !== 'function') return;
  const agentId = getCurrentControlAgentId();
  const runtimeId = getRuntimeId(currentRuntimeAgentId);
  if (!agentId || !runtimeId) return;
  const key = agentId + '::' + runtimeId;
  if (key === _commandFeaturesKey) return;
  _commandFeaturesKey = key;
  fetch('/protoclaw/commands?agentId=' + encodeURIComponent(agentId)
    + '&runtimeId=' + encodeURIComponent(runtimeId))
    .then(res => (res.ok ? res.json() : null))
    .then(data => {
      if (!data || data.ok !== true) throw new Error('commands unavailable');
      const counts = new Map();
      for (const cmd of (Array.isArray(data.commands) ? data.commands : [])) {
        const ref = typeof cmd.ref === 'string' ? cmd.ref : (typeof cmd.name === 'string' ? cmd.name : '');
        const feature = ref.split('.')[0];
        if (feature) counts.set(feature, (counts.get(feature) || 0) + 1);
      }
      _commandFeatures = counts;
      // 数据就位后修正面板（commands 筛选维度从 seed 回退切换到运行时真值）
      if (activeFeaturePanel === 'hooks' && typeof renderFeaturePanel === 'function') {
        renderFeaturePanel();
      }
    })
    .catch(() => {
      // 失败不缓存：保持 null（seed 回退），下次渲染重试
      if (_commandFeaturesKey === key) _commandFeaturesKey = null;
    });
}

// $mount 装配事实低频拉取（同 catalog 模式）：就位后修正面板来源分类
// （官方选装/用户扩展经 $mount 挂载即"已安装"，与挂载管理页同口径）。
function _ensureMountFacts() {
  const fc = window.ClawFW && window.ClawFW.featureCatalog;
  if (fc) fc.loadMountFacts().catch(err => console.warn('[feature-catalog] mount facts load failed:', err));
}

function _runtimeSignals() {
  const fc = window.ClawFW && window.ClawFW.featureCatalog;
  let mountedNames = null;
  if (fc && typeof getCurrentControlAgentId === 'function') {
    // 只对本地编程小助手会话应用 $mount 装配事实：远程会话（record 不在
    // allAgents）的装配声明不在本机 overview 里；其他宿主不在装配域。
    // 挂载事实未就绪时为 null，enrich 回退 seed 静态 group。
    const record = (typeof getCurrentAgentRecord === 'function') ? getCurrentAgentRecord() : null;
    if (record) {
      const sessionType = (typeof readCurrentSessionViewState === 'function')
        ? readCurrentSessionViewState().sessionMeta.sessionType : '';
      mountedNames = fc.resolveMountedNames(
        fc.getMountFactsSnapshot(), getCurrentControlAgentId(), sessionType);
    }
  }
  return { commandFeatures: _commandFeatures, mountedNames };
}

/**
 * 来源分页器（usage-info-segment 同款视觉配方，面板小号适配）；
 * 每档按钮附各自计数小字（语义 = "点这一档会看到几个"，随能力筛选联动）。
 * onpointerdown 为主路径：面板 body 随轮询全量 innerHTML 替换，click
 * 序列（mousedown→mouseup→click）跨过替换边界时目标已脱离 DOM、
 * onclick 属性不再执行——历史上表现为"必须双击才能切换"。pointerdown
 * 在按下瞬间同步完成切换，不受替换影响；onclick 保留键盘触发路径，
 * setter 的同值短路保证两路径幂等。
 * @param {{all:number,bundled:number,installed:number}} counts 各档计数
 */
function buildFeatureFilterSegment(counts) {
  const keys = { all: 'feature_filter_all', bundled: 'feature_filter_bundled', installed: 'feature_filter_installed' };
  return '<div class="usage-info-segment feature-src-seg" role="tablist">'
    + FEATURE_FILTERS.map(f => [
      '<button type="button" role="tab" class="' + (f === _featurePanelFilter ? 'active' : '') + '"'
        + ' onpointerdown="window.setFeaturePanelFilter(\'' + f + '\')"'
        + ' onclick="window.setFeaturePanelFilter(\'' + f + '\')">'
        + escapeHtml(t(keys[f]))
        + '<span class="feature-src-n">' + String(counts ? counts[f] : 0) + '</span>'
        + '</button>',
    ].join('')).join('')
    + '</div>';
}

/**
 * 能力下拉（多值包含筛选）：第一项"全部"，后续项由 catalog 响应的
 * capabilities 词表驱动，label 复用详情弹窗的 feature_cap_* 词条
 * （弹窗与下拉措辞一致，用户不会看到两套叫法）。
 * data-claw-select + compact：debug-panel-host 渲染后自动做 ClawSelect
 * 增强（git 仓库/分支下拉同款视觉）；data-claw-no-scroll：选项少，
 * 弹出面板放开 max-height 不出滚动条。
 * catalog 未就绪时返回空串（首帧不渲染，catalog 到位后的刷新帧补上）。
 */
function buildFeatureCapSelect(catalog) {
  const fc = window.ClawFW && window.ClawFW.featureCatalog;
  if (!fc || !catalog || !Array.isArray(catalog.capabilities) || catalog.capabilities.length === 0) return '';
  const current = fc.normalizeCapFilter(_featurePanelCapFilter, catalog);
  const options = ['all'].concat(catalog.capabilities.map(c => (typeof c === 'string' ? c : c.id)));
  return '<select class="feature-cap-select" data-claw-select data-claw-compact="true" data-claw-no-scroll="true"'
    + ' onchange="window.setFeaturePanelCapFilter(this.value)">'
    + options.map(id => '<option value="' + escapeHtml(id) + '"' + (id === current ? ' selected' : '') + '>'
      + escapeHtml(t(id === 'all' ? 'feature_filter_all' : 'feature_cap_' + id)) + '</option>').join('')
    + '</select>';
}

function renderFeaturesPanel() {
  if (currentHookInspector.features.length === 0) {
    return '<div class="feature-panel-empty"><div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(t('panel_no_features')) + '</div><div>' + escapeHtml(t('panel_no_feature_data')) + '</div></div></div>';
  }

  // catalog 低频拉取：首帧未就绪时全部落 _unmapped 组，
  // loadFeatureCatalog resolve 后主动触发一帧刷新修正（见 feature-catalog.js）。
  // commands 信号同模式（见 _ensureCommandFeatures）；$mount 装配事实同模式
  // （就位前来源分类回退 seed 静态 group，见 _ensureMountFacts）。
  _ensureCommandFeatures();
  _ensureMountFacts();
  const fc = window.ClawFW && window.ClawFW.featureCatalog;
  if (fc) fc.loadFeatureCatalog().catch(err => console.warn('[feature-catalog] load failed:', err));
  const catalog = fc ? fc.getFeatureCatalogSnapshot() : null;
  const runtime = _runtimeSignals();
  const capFilter = fc ? fc.normalizeCapFilter(_featurePanelCapFilter, catalog) : 'all';
  const srcCounts = fc
    ? fc.countFeaturesBySource(currentHookInspector.features, catalog, capFilter, runtime)
    : { all: currentHookInspector.features.length, bundled: 0, installed: 0 };
  const groups = fc
    ? fc.groupFeaturesByType(currentHookInspector.features, catalog, _featurePanelFilter, capFilter, runtime)
    : [{ id: '_unmapped', features: currentHookInspector.features }];

  const allEnriched = groups.flatMap(g => g.features);
  const selectedFeature = allEnriched.find(feature => feature.name === selectedFeatureName) || null;

  // 单一非兜底组时不渲染组头（组头无信息量）；
  // 出现第二个组或兜底组（seed 缺口信号）时组头自动出现。
  const suppressHeaders = groups.length === 1 && groups[0].id !== '_unmapped';

  const buildFeatureCard = (feature) => {
    const status = getFeatureStatus(feature);
    const displayName = fc ? fc.resolveDisplayName(feature, currentLanguage) : feature.name;
    // slash 命令数：_commandFeatures 为 null（数据不可用）时省略该项，不显示误导性的 0
    const commandCount = _commandFeatures ? (_commandFeatures.get(feature.name) || 0) : null;
    return [
      '<div class="feature-card" role="button" tabindex="0" onclick="window.openFeatureDetails(&quot;' + escapeHtml(feature.name) + '&quot;)" title="' + escapeHtml(feature.name) + '">',
      '<div class="feature-card-top">',
      '<div class="feature-card-main">',
      '<span class="feature-card-dot"></span>',
      '<div style="min-width:0;">',
      '<div class="feature-card-name">' + escapeHtml(displayName) + '</div>',
      '<div class="feature-card-file">' + escapeHtml(shortenSourcePath(feature.source) || t('feature_source_missing')) + '</div>',
      '</div>',
      '</div>',
      '<div class="' + getStatusBadgeClass(status) + '">' + escapeHtml(getFeatureStatusLabel(status)) + '</div>',
      '</div>',
      '<div class="feature-card-detail">',
      '<span>' + String(feature.hookCount) + ' ' + escapeHtml(t('feature_hooks')) + '</span>',
      '<span>' + String(feature.enabledToolCount) + '/' + String(feature.toolCount) + ' ' + escapeHtml(t('feature_tools')) + '</span>',
      '<span>' + String(feature.skillCount || 0) + ' ' + escapeHtml(t('feature_skills')) + '</span>',
      commandCount !== null ? '<span>' + String(commandCount) + ' ' + escapeHtml(t('feature_commands')) + '</span>' : '',
      feature.description ? '<span>' + escapeHtml(feature.description) + '</span>' : '',
      '</div>',
      '</div>',
    ].join('');
  };

  const buildGroup = (group) => {
    const grid = '<div class="feature-grid">' + group.features.map(buildFeatureCard).join('') + '</div>';
    if (suppressHeaders) return grid;
    // 用户操作过的组按偏好恢复；未操作过的按词表默认折叠态
    const isOpen = _featureGroupOpenPref.has(group.id)
      ? _featureGroupOpenPref.get(group.id)
      : !(fc && fc.typeCollapsedByDefault(group.id, catalog));
    return [
      '<details class="feature-group"' + (isOpen ? ' open' : '')
        + ' ontoggle="window.featureGroupToggled(&quot;' + escapeHtml(group.id) + '&quot;, this.open)">',
      '<summary class="feature-group-bar">',
      '<span class="feature-group-chev" aria-hidden="true"></span>',
      '<span class="feature-group-title">' + escapeHtml(featureGroupLabel(group.id)) + '</span>',
      '<span class="feature-group-count">' + String(group.features.length) + '</span>',
      '</summary>',
      grid,
      '</details>',
    ].join('');
  };

  const groupsHtml = groups.map(buildGroup).join('')
    || '<div class="feature-filter-empty">' + escapeHtml(t(
      capFilter !== 'all' ? 'feature_filter_empty_cap'
        : _featurePanelFilter === 'installed' ? 'feature_filter_empty_installed' : 'feature_filter_empty'
    )) + '</div>';

  // 弹窗通过独立 portal 渲染到 document.body，不嵌入 panel body（避免 transform 降级 fixed）
  renderFeatureDetailOverlay(selectedFeature);

  const standaloneSection = (currentHookInspector.standaloneTools && currentHookInspector.standaloneTools.length > 0)
    ? [
      '<section class="hooks-section">',
      '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('standalone_tools_title')) + '</div><div class="hooks-section-meta">' + String(currentHookInspector.standaloneTools.length) + '</div></div>',
      '<div class="feature-tool-list">' + currentHookInspector.standaloneTools.map(tool => {
        const isSuper = tool.state === 'superseded';
        const actionHtml = isSuper
          ? '<div class="' + getStatusBadgeClass(tool.state || 'enabled') + '">' + escapeHtml(t('feature_tool_superseded')) + '</div>'
          : buildToolToggleHtml('tool', tool.name, tool.state === 'enabled');
        return [
        '<div class="feature-tool-card">',
        '<div class="feature-tool-top">',
        '<div class="feature-tool-name">' + escapeHtml(tool.name) + '</div>',
        '<div class="feature-tool-actions">',
        actionHtml,
        '</div>',
        '</div>',
        '<div class="feature-tool-desc">' + escapeHtml(tool.description || '') + '</div>',
        tool.source ? '<div class="feature-tool-meta"><span class="feature-tool-pill">source: ' + escapeHtml(tool.source) + '</span></div>' : '',
        '</div>',
      ].join('')}).join('') + '</div>',
      '</section>',
    ].join('')
    : '';

  return [
    '<div class="hooks-panel feature-detail-shell">',
    '<section class="hooks-section">',
    '<div class="hooks-section-header feature-panel-head">',
    buildFeatureFilterSegment(srcCounts),
    buildFeatureCapSelect(catalog),
    '</div>',
    groupsHtml,
    '</section>',
    standaloneSection,
    '</div>',
  ].join('');
}

// ═══════════════════════════════════════════════════════════════
// Feature 详情弹窗 — 独立 portal（挂载于 document.body）
// 避免被 feature-panel-body 的 transform 降级为 containing block
// ═══════════════════════════════════════════════════════════════

const FEATURE_DETAIL_PORTAL_ID = 'feature-detail-portal';

const SVG_TOOL_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:0.6;"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';

// 记录已展开 schema 的工具（跨轮询重渲染保持状态）
const _expandedToolNames = new Set();
// 上次渲染签名，避免轮询时无谓的 innerHTML 全量替换导致滚动卡顿
let _lastDetailSignature = '';

function toggleToolSchema(toolKey) {
  if (_expandedToolNames.has(toolKey)) {
    _expandedToolNames.delete(toolKey);
  } else {
    _expandedToolNames.add(toolKey);
  }
  // 签名已变，强制重渲染
  _lastDetailSignature = '';
  const selectedFeature = currentHookInspector.features.find(f => f.name === selectedFeatureName) || null;
  renderFeatureDetailOverlay(selectedFeature);
}

window.toggleToolSchema = toggleToolSchema;

// ═══════════════════════════════════════════════════════════════
// Tool / Feature enable-disable toggle
// ═══════════════════════════════════════════════════════════════

/**
 * 发送 enable/disable IPC 请求到 agent 子进程。
 * checkbox.checked 决定 action — checked=enable, unchecked=disable。
 * 轮询会在下一周期自动刷新 inspector 显示新状态。
 */
async function toggleToolState(scope, name, checkbox) {
  const action = checkbox.checked ? 'enable' : 'disable';
  const body = { agentId: getCurrentControlAgentId(), scope, name, action };
  const runtimeId = getRuntimeId(currentRuntimeAgentId);
  if (runtimeId) body.runtimeId = runtimeId;
  try {
    const resp = await fetch('/protoclaw/agent/tool_state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.warn('[toggleToolState] request failed:', resp.status);
      // Revert checkbox on failure
      checkbox.checked = !checkbox.checked;
      return;
    }
    // Trigger inspector refresh — give the agent subprocess a moment to process
    // the IPC message and push the updated snapshot.
    if (window._scheduleInspectorRefresh) window._scheduleInspectorRefresh(300);
  } catch (err) {
    console.error('[toggleToolState] error:', err);
    checkbox.checked = !checkbox.checked;
  }
}
window.toggleToolState = toggleToolState;

/**
 * 发送 hook enable/disable IPC 请求。
 */
async function toggleHookState(lifecycle, featureName, methodName, checkbox) {
  const action = checkbox.checked ? 'enable' : 'disable';
  const body = { agentId: getCurrentControlAgentId(), scope: 'hook', lifecycle, featureName, methodName, action };
  const runtimeId = getRuntimeId(currentRuntimeAgentId);
  if (runtimeId) body.runtimeId = runtimeId;
  try {
    const resp = await fetch('/protoclaw/agent/tool_state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.warn('[toggleHookState] request failed:', resp.status);
      checkbox.checked = !checkbox.checked;
      return;
    }
    if (window._scheduleInspectorRefresh) window._scheduleInspectorRefresh(300);
  } catch (err) {
    console.error('[toggleHookState] error:', err);
    checkbox.checked = !checkbox.checked;
  }
}
window.toggleHookState = toggleHookState;

/**
 * 生成 toggle switch HTML。
 * @param scope 'tool' | 'feature'
 * @param name 工具名或 feature 名
 * @paramisChecked boolean — 当前是否启用
 * @returns HTML string（空字符串如果不适用）
 */
function buildToolToggleHtml(scope, name, isChecked) {
  return '<label class="tool-toggle" onclick="event.stopPropagation()" title="' + escapeHtml(t('feature_toggle_hint')) + '">'
    + '<input type="checkbox" class="tool-toggle-input"'
    + (isChecked ? ' checked' : '')
    + ' onchange="window.toggleToolState(&quot;' + scope + '&quot;,&quot;' + escapeHtml(name) + '&quot;,this)" />'
    + '<span class="tool-toggle-slider"></span>'
    + '</label>';
}

/**
 * 生成 hook toggle switch HTML。
 * data 属性编码在 onchange 回调字符串中。
 */
function buildHookToggleHtml(lifecycle, featureName, methodName, isChecked) {
  return '<label class="tool-toggle" onclick="event.stopPropagation()" title="' + escapeHtml(t('feature_toggle_hint')) + '">'
    + '<input type="checkbox" class="tool-toggle-input"'
    + (isChecked ? ' checked' : '')
    + ' onchange="window.toggleHookState(&quot;' + escapeHtml(lifecycle) + '&quot;,&quot;' + escapeHtml(featureName) + '&quot;,&quot;' + escapeHtml(methodName) + '&quot;,this)" />'
    + '<span class="tool-toggle-slider"></span>'
    + '</label>';
}

function ensureFeatureDetailPortal() {
  let el = document.getElementById(FEATURE_DETAIL_PORTAL_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = FEATURE_DETAIL_PORTAL_ID;
    document.body.appendChild(el);
  }
  return el;
}

function renderFeatureDetailOverlay(feature) {
  const portal = ensureFeatureDetailPortal();

  if (!feature) {
    if (portal.innerHTML) portal.innerHTML = '';
    _lastDetailSignature = '';
    return;
  }

  // 来源标签 + 能力标签：均由 catalog 响应携带，词表外不展示
  const fc = window.ClawFW && window.ClawFW.featureCatalog;
  const catalog = fc ? fc.getFeatureCatalogSnapshot() : null;
  const provKey = fc && feature.provenance ? fc.provenanceI18nKey(feature.provenance, catalog && catalog.provenances) : null;
  const capsHtml = (fc && Array.isArray(feature.capabilities) && catalog && Array.isArray(catalog.capabilities))
    ? feature.capabilities
      .filter(cap => catalog.capabilities.some(c => c.id === cap))
      .map(cap => '<span class="feature-cap-badge">' + escapeHtml(t('feature_cap_' + cap)) + '</span>')
      .join('')
    : '';
  const capsBlock = capsHtml
    ? '<div class="feature-detail-caps">' + capsHtml + '</div>'
    : '';
  const provHtml = provKey
    ? '<span class="feature-prov-badge">' + escapeHtml(t(provKey)) + '</span>'
    : '';

  // 计算签名：feature 名 + 工具数据 + 展开状态 + 语言 + catalog 派生 displayName/provenance/capabilities
  // （catalog 后到时 signature 变化，弹窗标题与标签随之修正）
  // 如果签名未变则跳过 innerHTML 替换，避免轮询导致的滚动卡顿
  const displayName = (fc && feature.mapped) ? fc.resolveDisplayName(feature, currentLanguage) : feature.name;
  const signature = feature.name + '|'
    + (feature.tools || []).map(t => t.name + ':' + t.state + ':' + (t.enabled ? 1 : 0)).join(',')
    + '|exp:' + Array.from(_expandedToolNames).sort().join(',')
    + '|lang:' + currentLanguage
    + '|dn:' + displayName
    + '|pv:' + (provKey || '')
    + '|caps:' + (Array.isArray(feature.capabilities) ? feature.capabilities.join(',') : '');
  if (signature === _lastDetailSignature && portal.innerHTML) return;
  _lastDetailSignature = signature;

  const toolRowsHtml = (feature.tools && feature.tools.length > 0)
    ? '<div class="gateway-tool-grid">' + feature.tools.map(tool => {
        const metaPills = [
          tool.renderCall ? '<span class="feature-tool-pill">call/' + escapeHtml(tool.renderCall) + '</span>' : '',
          tool.renderResult ? '<span class="feature-tool-pill">result/' + escapeHtml(tool.renderResult) + '</span>' : '',
        ].filter(Boolean).join('');
        const props = tool.parameters?.properties ? Object.keys(tool.parameters.properties) : [];
        const hasSchema = tool.parameters && Object.keys(tool.parameters).length > 0;
        const toolKey = feature.name + ':' + tool.name;
        const isExpanded = _expandedToolNames.has(toolKey);
        const paramsHtml = props.length > 0
          ? '<div class="gateway-tool-params">' + props.map(p => '<span class="gateway-tool-tag">' + escapeHtml(p) + '</span>').join('') + '</div>'
          : '';
        const toggleHtml = hasSchema
          ? '<div class="fdetail-schema-toggle" onclick="event.stopPropagation();window.toggleToolSchema(&quot;' + escapeHtml(toolKey) + '&quot;)">'
            + (isExpanded ? '▾ ' : '▸ ') + escapeHtml(t(isExpanded ? 'feature_tool_schema_expanded' : 'feature_tool_schema')) + '</div>'
          : '';
        const schemaHtml = (hasSchema && isExpanded)
          ? '<div class="fdetail-schema-block"><pre>' + escapeHtml(JSON.stringify(tool.parameters, null, 2)) + '</pre></div>'
          : '';
        const isSuper = tool.state === 'superseded';
        const actionHtml = isSuper
          ? '<div class="' + getStatusBadgeClass('superseded') + '">' + escapeHtml(t('feature_tool_superseded')) + '</div>'
          : buildToolToggleHtml('tool', tool.name, tool.state === 'enabled');
        return [
          '<div class="feature-tool-card">',
          '<div class="feature-tool-top">',
          '<div class="feature-tool-name">' + SVG_TOOL_ICON + escapeHtml(tool.name) + '</div>',
          '<div class="feature-tool-actions">',
          actionHtml,
          '</div>',
          '</div>',
          tool.description ? '<div class="feature-tool-desc">' + escapeHtml(tool.description) + '</div>' : '',
          paramsHtml,
          metaPills ? '<div class="feature-tool-meta">' + metaPills + '</div>' : '',
          toggleHtml,
          schemaHtml,
          '</div>',
        ].join('');
      }).join('') + '</div>'
    : '<div class="gateway-list-empty">' + escapeHtml(t('panel_no_tools')) + '</div>';

  // 保存滚动位置（settings-tab-content 是滚动容器）
  const prevScroll = portal.querySelector('.settings-tab-content');
  const savedScroll = prevScroll ? prevScroll.scrollTop : 0;

  const showNameId = feature.mapped && displayName !== feature.name;

  portal.innerHTML = [
    '<div class="feature-detail-overlay" onclick="window.closeFeatureDetails()">',
    '<div class="feature-detail-window" onclick="event.stopPropagation()" style="width:min(100%,600px);height:min(100%,660px);overflow:hidden;display:flex;flex-direction:column;">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + escapeHtml(displayName)
      + (showNameId ? ' <span class="feature-detail-id">' + escapeHtml(feature.name) + '</span>' : '')
      + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(feature.description || '') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + escapeHtml(t('panel_close')) + '" onclick="window.closeFeatureDetails()">×</button>',
    '</div>',
    '<div class="settings-tab-content">',
    '<div class="feature-detail-stats">',
    '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(t('feature_hooks')) + '</div><div class="feature-detail-stat-value">' + String(feature.hookCount) + '</div></div>',
    '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(t('feature_active_tools')) + '</div><div class="feature-detail-stat-value">' + String(feature.enabledToolCount) + '/' + String(feature.toolCount) + '</div></div>',
    '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(t('feature_status_label')) + '</div><div class="feature-detail-stat-value">' + escapeHtml(getFeatureStatusLabel(getFeatureStatus(feature))) + '</div></div>',
    '</div>',
    '<div class="feature-detail-source">' + escapeHtml(shortenSourcePath(feature.source) || t('feature_source_missing')) + provHtml + '</div>',
    capsBlock,
    '<div class="settings-section">',
    '<div class="settings-section-title">' + escapeHtml(t('panel_loaded_tools')) + ' (' + String(feature.tools?.length || 0) + ')</div>',
    toolRowsHtml,
    '</div>',
    '</div>',
    '</div>',
    '</div>',
  ].join('');

  // 恢复滚动位置
  const newScroll = portal.querySelector('.settings-tab-content');
  if (newScroll) newScroll.scrollTop = savedScroll;
}

// 生命周期分组的展开偏好（跨轮询重渲染保持状态）。
// 未记录时按内容决定默认态：有挂载 → 展开，零挂载 → 折叠。
const _lifecycleOpenPref = new Map();

/**
 * details ontoggle 回调：无论 open 来自用户点击还是重渲染，
 * 都同步到 Map，下一次渲染按 Map 恢复。
 */
function rhGroupToggled(lifecycle, open) {
  _lifecycleOpenPref.set(lifecycle, open);
}
window.rhGroupToggled = rhGroupToggled;

// 双语短文案（currentLanguage 声明于 app-core.js）
function rhLoc(zh, en) {
  return (typeof currentLanguage !== 'undefined' && currentLanguage === 'zh') ? zh : en;
}

// 生命周期槽位速查（措辞对齐框架 DebugHub 的生命周期文档）
const RH_LIFECYCLE_HINTS = {
  AgentInitiate: ['Agent 初始化阶段：agent 首次进入工作状态时触发一次，适合准备长生命周期资源', 'Agent initialization: fires once when the agent enters working state; suited for long-lived setup'],
  AgentDestroy: ['Agent 销毁阶段：agent 生命周期收尾，释放外部资源、停止后台任务', 'Agent destroy: closing stage for releasing resources and stopping background tasks'],
  CallStart: ['Call 开始前：每次用户请求开始时触发，可准备或改写本次调用上下文', 'Before call start: fires on every user request; can prepare or rewrite the call context'],
  CallFinish: ['Call 结束后：一次调用完成后触发，适合记录与清理', 'After call finish: fires when a call completes; suited for logging and cleanup'],
  StepStart: ['Step 开始前：模型每个推理步开始时触发', 'Before step start: fires at the beginning of each model reasoning step'],
  StepFinish: ['Step 结束决策点：每个推理步结束后触发，守卫可在此影响后续走向', 'Step finish decision point: guards may influence what happens next'],
  ToolUse: ['工具执行前决策点：工具调用前触发，守卫可否决或改写调用', 'Before tool execution: guards may veto or rewrite tool calls'],
  ToolFinished: ['工具执行后通知点：工具调用完成后触发，适合记录结果', 'After tool finished: fires after a tool call completes; suited for recording results'],
};

// 钩子三原语说明（kind 取值见 AgentDev src/core/types.ts）
const RH_KIND_HINTS = {
  observe: ['observe（观察）：只读取上下文，不改变流程', 'observe: reads context without altering the flow'],
  guard: ['guard（守卫）：可拦截或改写决策，例如否决工具调用', 'guard: may intercept or rewrite decisions, e.g. vetoing tool calls'],
  transform: ['transform（变换）：可改写流经该生命周期阶段的数据', 'transform: rewrites data flowing through this lifecycle stage'],
};

function rhLifecycleHint(lifecycle) {
  const hint = RH_LIFECYCLE_HINTS[lifecycle];
  return hint
    ? rhLoc(hint[0], hint[1])
    : rhLoc('反向钩子生命周期槽位：挂载的处理函数按序号顺序执行', 'Reverse-hook lifecycle slot: attached handlers run in numbered order');
}

function rhKindHint(kind) {
  const hint = RH_KIND_HINTS[kind];
  return hint ? rhLoc(hint[0], hint[1]) : String(kind);
}

/**
 * 反向钩子面板 — 单层分组卡 + 时间线行式条目。
 * 分组卡只承担折叠职责；条目不再嵌套卡片。
 */
function renderReverseHooksPanel() {
  if (currentHookInspector.hooks.length === 0) {
    return '<div class="feature-panel-empty"><div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(t('panel_no_hook_data')) + '</div><div>' + escapeHtml(t('panel_no_hook_data_desc')) + '</div></div></div>';
  }

  const lifecycleCards = currentHookInspector.hooks
    .map(group => {
      const entriesHtml = group.entries.map((entry, index) => {
        const subParts = [
          entry.source && entry.source.display ? escapeHtml(shortenSourcePath(entry.source.display)) : '',
          entry.description ? escapeHtml(entry.description) : '',
        ].filter(Boolean).join(' · ');
        // tooltip 携带完整源码路径与描述（rh-sub 中的路径是截短版）
        const methodTip = [
          entry.source && entry.source.display ? entry.source.display : '',
          entry.description || '',
        ].filter(Boolean).join('\n');
        const kindLabel = entry.role ? entry.kind + ' · ' + entry.role : entry.kind;
        return [
          '<div class="rh-item">',
          '<span class="rh-ord">' + String(index + 1) + '</span>',
          '<div class="rh-main">',
          '<div class="rh-row-main">',
          '<span class="rh-method" title="' + escapeHtml(methodTip) + '">' + escapeHtml(entry.methodName) + '()</span>',
          '<span class="rh-toggle">' + buildHookToggleHtml(group.lifecycle, entry.featureName, entry.methodName, entry.enabled !== false) + '</span>',
          '</div>',
          '<div class="rh-row-meta">',
          '<span class="rh-feature" title="' + escapeHtml(rhLoc('提供该处理函数的 Feature', 'Feature providing this handler')) + '">' + escapeHtml(entry.featureName) + '</span>',
          '<span class="rh-kind k-' + escapeHtml(entry.kind) + '" title="' + escapeHtml(rhKindHint(entry.kind)) + '">' + escapeHtml(kindLabel) + '</span>',
          '</div>',
          subParts ? '<div class="rh-sub">' + subParts + '</div>' : '',
          '</div>',
          '</div>',
        ].join('');
      }).join('');

      const isEmpty = group.entries.length === 0;
      // 默认态：有挂载展开，零挂载折叠；用户操作过的分组按其偏好恢复
      const isOpen = _lifecycleOpenPref.has(group.lifecycle)
        ? _lifecycleOpenPref.get(group.lifecycle)
        : !isEmpty;
      return [
        '<details class="rh-group' + (isEmpty ? ' is-empty' : '') + '"' + (isOpen ? ' open' : '')
          + ' ontoggle="window.rhGroupToggled(&quot;' + escapeHtml(group.lifecycle) + '&quot;, this.open)">',
        '<summary class="rh-head">',
        '<span class="rh-name" title="' + escapeHtml(rhLifecycleHint(group.lifecycle)) + '">' + escapeHtml(group.lifecycle) + '</span>',
        '<span class="rh-count" title="' + escapeHtml(rhLoc('同一生命周期内按注册顺序执行，序号即执行顺序', 'Handlers run in registration order within a lifecycle')) + '">' + String(group.entries.length) + ' ' + escapeHtml(t('panel_attached')) + '</span>',
        '<span class="rh-chev">▸</span>',
        '</summary>',
        '<div class="rh-chain">',
        entriesHtml || '<div class="rh-empty">' + escapeHtml(t('panel_no_handlers')) + '</div>',
        '</div>',
        '</details>',
      ].join('');
    })
    .join('');

  // 面板标题栏已标注"反向钩子"，正文直接呈现分组列表，不再重复大标题
  return '<div class="hooks-panel"><div class="rh-list">' + lifecycleCards + '</div></div>';
}
