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
      '<div class="feature-tool-list">' + currentHookInspector.standaloneTools.map(tool => [
        '<div class="feature-tool-card">',
        '<div class="feature-tool-top">',
        '<div class="feature-tool-name">' + escapeHtml(tool.name) + '</div>',
        '<div class="' + getStatusBadgeClass(tool.state || 'enabled') + '">' + escapeHtml(tool.state === 'superseded' ? t('feature_tool_superseded') : tool.state === 'removed' ? t('feature_tool_removed') : tool.state === 'disabled' ? t('feature_tool_disabled') : t('feature_tool_enabled')) + '</div>',
        '</div>',
        '<div class="feature-tool-desc">' + escapeHtml(tool.description || '') + '</div>',
        tool.source ? '<div class="feature-tool-meta"><span class="feature-tool-pill">source: ' + escapeHtml(tool.source) + '</span></div>' : '',
        '</div>',
      ].join('')).join('') + '</div>',
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
    portal.innerHTML = '';
    return;
  }

  const toolRowsHtml = (feature.tools && feature.tools.length > 0)
    ? '<div class="fdetail-tool-list">' + feature.tools.map(tool => {
        const stateLabel = tool.state === 'superseded' ? t('feature_tool_superseded')
          : tool.state === 'removed' ? t('feature_tool_removed')
          : tool.state === 'disabled' || tool.enabled === false ? t('feature_tool_disabled')
          : t('feature_tool_enabled');
        const pills = [
          tool.renderCall ? '<span class="fdetail-tool-pill">call/' + escapeHtml(tool.renderCall) + '</span>' : '',
          tool.renderResult ? '<span class="fdetail-tool-pill">result/' + escapeHtml(tool.renderResult) + '</span>' : '',
        ].filter(Boolean).join('');
        return [
          '<div class="fdetail-tool-row">',
          '<div class="fdetail-tool-info">',
          '<span class="fdetail-tool-name">' + escapeHtml(tool.name) + '</span>',
          tool.description ? '<span class="fdetail-tool-desc">' + escapeHtml(tool.description) + '</span>' : '',
          pills ? '<span class="fdetail-tool-pills">' + pills + '</span>' : '',
          '</div>',
          '<span class="fdetail-tool-state ' + getStatusBadgeClass(tool.state || (tool.enabled ? 'enabled' : 'disabled')) + '">' + escapeHtml(stateLabel) + '</span>',
          '</div>',
        ].join('');
      }).join('') + '</div>'
    : '<div class="fdetail-empty">' + escapeHtml(t('panel_no_tools')) + '</div>';

  portal.innerHTML = [
    '<div class="feature-detail-overlay" onclick="window.closeFeatureDetails()">',
    '<div class="feature-detail-window" onclick="event.stopPropagation()">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + escapeHtml(feature.name) + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(feature.description || '') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + escapeHtml(t('panel_close')) + '" onclick="window.closeFeatureDetails()">×</button>',
    '</div>',
    '<div class="feature-detail-stats">',
    '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(t('feature_hooks')) + '</div><div class="feature-detail-stat-value">' + String(feature.hookCount) + '</div></div>',
    '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(t('feature_active_tools')) + '</div><div class="feature-detail-stat-value">' + String(feature.enabledToolCount) + '/' + String(feature.toolCount) + '</div></div>',
    '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(t('feature_status_label')) + '</div><div class="feature-detail-stat-value">' + escapeHtml(getFeatureStatusLabel(getFeatureStatus(feature))) + '</div></div>',
    '</div>',
    '<div class="fdetail-source">' + escapeHtml(shortenSourcePath(feature.source) || t('feature_source_missing')) + '</div>',
    '<div class="fdetail-section-title">' + escapeHtml(t('panel_loaded_tools')) + '</div>',
    toolRowsHtml,
    '</div>',
    '</div>',
  ].join('');
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
        '<div class="hook-step-kind">' + escapeHtml(entry.kind) + '</div>',
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
