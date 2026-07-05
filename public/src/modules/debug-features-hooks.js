/**
 * debug-features-hooks.js — Features 面板 + Reverse Hooks 面板
 *
 * 从 debug-panels.js 拆出。包含：
 *   - renderFeaturesPanel
 *   - renderReverseHooksPanel
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

  const detailOverlay = selectedFeature ? [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + escapeHtml(selectedFeature.name) + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(selectedFeature.description || '') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + escapeHtml(t('panel_close')) + '" onclick="window.closeFeatureDetails()">×</button>',
    '</div>',
    '<div class="feature-detail-stats">',
    '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(t('feature_hooks')) + '</div><div class="feature-detail-stat-value">' + String(selectedFeature.hookCount) + '</div></div>',
    '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(t('feature_active_tools')) + '</div><div class="feature-detail-stat-value">' + String(selectedFeature.enabledToolCount) + '/' + String(selectedFeature.toolCount) + '</div></div>',
    '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(t('feature_status_label')) + '</div><div class="feature-detail-stat-value">' + escapeHtml(getFeatureStatusLabel(getFeatureStatus(selectedFeature))) + '</div></div>',
    '</div>',
    '<div class="feature-panel-section">',
    '<div class="feature-panel-section-title">' + escapeHtml(t('panel_feature_details')) + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(shortenSourcePath(selectedFeature.source) || t('feature_source_missing')) + '</div>',
    '</div>',
    '<div class="feature-panel-section">',
    '<div class="feature-panel-section-title">' + escapeHtml(t('panel_loaded_tools')) + '</div>',
    selectedFeature.tools && selectedFeature.tools.length > 0
      ? '<div class="feature-tool-list">' + selectedFeature.tools.map(tool => [
          '<div class="feature-tool-card">',
          '<div class="feature-tool-top">',
          '<div class="feature-tool-name">' + escapeHtml(tool.name) + '</div>',
          '<div class="' + getStatusBadgeClass(tool.state || (tool.enabled ? 'enabled' : 'disabled')) + '">' + escapeHtml(tool.state === 'superseded' ? t('feature_tool_superseded') : tool.state === 'removed' ? t('feature_tool_removed') : tool.state === 'disabled' || tool.enabled === false ? t('feature_tool_disabled') : t('feature_tool_enabled')) + '</div>',
          '</div>',
          '<div class="feature-tool-desc">' + escapeHtml(tool.description || '') + '</div>',
          '<div class="feature-tool-meta">',
          tool.renderCall ? '<span class="feature-tool-pill">' + escapeHtml(t('feature_tool_render')) + ': call/' + escapeHtml(tool.renderCall) + '</span>' : '',
          tool.renderResult ? '<span class="feature-tool-pill">' + escapeHtml(t('feature_tool_render')) + ': result/' + escapeHtml(tool.renderResult) + '</span>' : '',
          '</div>',
          '</div>',
        ].join('')).join('') + '</div>'
      : '<div class="feature-detail-subtitle">' + escapeHtml(t('panel_no_tools')) + '</div>',
    '</div>',
    '</div>',
    '</div>',
  ].join('') : '';

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
    detailOverlay,
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
