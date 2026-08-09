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

function renderFeaturesPanel() {
  if (currentHookInspector.features.length === 0) {
    return '<div class="feature-panel-empty"><div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(t('panel_no_features')) + '</div><div>' + escapeHtml(t('panel_no_feature_data')) + '</div></div></div>';
  }

  const selectedFeature = currentHookInspector.features.find(feature => feature.name === selectedFeatureName) || null;
  const featureCards = currentHookInspector.features
    .map(feature => {
      const status = getFeatureStatus(feature);
      return [
      '<div class="feature-card" role="button" tabindex="0" onclick="window.openFeatureDetails(&quot;' + escapeHtml(feature.name) + '&quot;)" title="' + escapeHtml(t('feature_open_details')) + '">',
      '<div class="feature-card-top">',
      '<div class="feature-card-main">',
      '<span class="feature-card-dot"></span>',
      '<div style="min-width:0;">',
      '<div class="feature-card-name">' + escapeHtml(feature.name) + '</div>',
      '<div class="feature-card-file">' + escapeHtml(shortenSourcePath(feature.source) || t('feature_source_missing')) + '</div>',
      '</div>',
      '</div>',
      '<div class="' + getStatusBadgeClass(status) + '">' + escapeHtml(getFeatureStatusLabel(status)) + '</div>',
      '</div>',
      '<div class="feature-card-detail">',
      '<span>' + String(feature.hookCount) + ' ' + escapeHtml(t('feature_hooks')) + '</span>',
      '<span>' + String(feature.enabledToolCount) + '/' + String(feature.toolCount) + ' ' + escapeHtml(t('feature_tools')) + '</span>',
      feature.description ? '<span>' + escapeHtml(feature.description) + '</span>' : '',
      '</div>',
      '</div>',
    ].join('');
    })
    .join('');

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
    '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('panel_all_features')) + '</div><div class="hooks-section-meta">' + String(currentHookInspector.features.length) + ' ' + escapeHtml(t('panel_registered')) + '</div></div>',
    '<div class="feature-grid">' + featureCards + '</div>',
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
  const body = { agentId: currentAgentId, scope, name, action };
  if (currentRuntimeAgentId) body.runtimeId = currentRuntimeAgentId;
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
  const body = { agentId: currentAgentId, scope: 'hook', lifecycle, featureName, methodName, action };
  if (currentRuntimeAgentId) body.runtimeId = currentRuntimeAgentId;
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

  // 计算签名：feature 名 + 工具数据 + 展开状态 + 语言
  // 如果签名未变则跳过 innerHTML 替换，避免轮询导致的滚动卡顿
  const signature = feature.name + '|'
    + (feature.tools || []).map(t => t.name + ':' + t.state + ':' + (t.enabled ? 1 : 0)).join(',')
    + '|exp:' + Array.from(_expandedToolNames).sort().join(',')
    + '|lang:' + currentLanguage;
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

  portal.innerHTML = [
    '<div class="feature-detail-overlay" onclick="window.closeFeatureDetails()">',
    '<div class="feature-detail-window" onclick="event.stopPropagation()" style="width:min(100%,600px);height:min(100%,660px);overflow:hidden;display:flex;flex-direction:column;">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + escapeHtml(feature.name) + '</div>',
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
    '<div class="feature-detail-source">' + escapeHtml(shortenSourcePath(feature.source) || t('feature_source_missing')) + '</div>',
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

function renderReverseHooksPanel() {
  const hookIcons = {
    AgentInitiate: 'A',
    AgentDestroy: 'D',
    CallStart: 'C',
    CallFinish: 'C',
    StepStart: 'S',
    StepFinish: 'R',
    ToolUse: 'T',
    ToolFinished: 'F',
  };

  const lifecycleCards = currentHookInspector.hooks
    .map(group => {
      const entriesHtml = group.entries.map((entry, index) => [
        '<div class="hook-step">',
        '<div class="hook-step-order">' + String(index + 1) + '</div>',
        '<div class="hook-step-card">',
        '<div class="hook-step-row">',
        '<div class="hook-step-feature">' + escapeHtml(entry.featureName) + '</div>',
        '<div class="hook-step-actions">',
        '<div class="hook-step-kind">' + escapeHtml(entry.kind) + '</div>',
        buildHookToggleHtml(group.lifecycle, entry.featureName, entry.methodName, entry.enabled !== false),
        '</div>',
        '</div>',
        '<div class="hook-step-method">' + escapeHtml(entry.methodName) + '()</div>',
        entry.source && entry.source.display ? '<div class="hook-step-location">' + escapeHtml(shortenSourcePath(entry.source.display)) + '</div>' : '',
        entry.description ? '<div class="hook-step-notes">' + escapeHtml(entry.description) + '</div>' : '',
        '</div>',
        '</div>',
      ].join('')).join('');

      return [
        '<section class="hook-lifecycle-card">',
        '<div class="hook-lifecycle-head">',
      '<div class="hook-lifecycle-name">',
      '<span class="hook-lifecycle-icon">' + escapeHtml(hookIcons[group.lifecycle] || 'H') + '</span>',
      '<div>',
      '<div>' + escapeHtml(group.lifecycle) + '</div>',
      '<div class="hook-lifecycle-type">' + escapeHtml(group.kind) + ' ' + escapeHtml(t('hook_kind')) + '</div>',
      '</div>',
      '</div>',
        '<div style="display:flex;align-items:center;gap:12px;">',
        '<div class="hooks-section-meta">' + String(group.entries.length) + ' ' + escapeHtml(t('panel_attached')) + '</div>',
        '</div>',
        '</div>',
        '<div class="hook-call-chain">',
        entriesHtml || '<div class="hooks-section-meta">' + escapeHtml(t('panel_no_handlers')) + '</div>',
        '</div>',
        '</section>',
      ].join('');
    })
    .join('');

  if (currentHookInspector.hooks.length === 0) {
    return '<div class="feature-panel-empty"><div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(t('panel_no_hook_data')) + '</div><div>' + escapeHtml(t('panel_no_hook_data_desc')) + '</div></div></div>';
  }

  return [
    '<div class="hooks-panel">',
    '<section class="hooks-section">',
    '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('panel_reverse_hooks')) + '</div><div class="hooks-section-meta">' + escapeHtml(t('panel_all_lifecycle_slots')) + '</div></div>',
    '<div class="hook-lifecycle-list">' + lifecycleCards + '</div>',
    '</section>',
    '</div>',
  ].join('');
}
