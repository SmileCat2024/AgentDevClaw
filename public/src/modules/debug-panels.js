/**
 * debug-panels.js — Debug 面板渲染模块（从 app-ui.js 域 K-b + 域 L 提取）
 *
 * 包含：
 *   域 K-b — Usage/Token 渲染 + 日志面板 + MCP 面板 + 生命周期选择器：
 *     - formatMetricNumber, formatRate, getLatestCallSummary, getUsageBreakdown
 *     - renderTokenBar, renderRateRing, renderUsageCard, renderCacheCard, renderContextChip
 *     - setCurrentMcpInfo
 *     - getLevelWeight, formatLogTimestamp, safePrettyJson, getFilteredLogs, renderLogsPanel
 *     - renderMcpItems, renderMcpPanel
 *     - lifecycleDocs (常量)
 *     - selectOverviewLifecycle, openFeatureDetails, closeFeatureDetails
 *     - openRepositoryPackageDetails, closeRepositoryPackageDetails
 *   域 L-a — Summary + Upload：
 *     - getOrCreateSummaryOverlay, renderSummaryBodyContent, updateSummaryOverlayDOM
 *     - openSummaryPopup, closeSummaryPopup, regenerateSummary
 *     - setRepoSearchQuery, setRepoSourceFilter
 *     - openFeatureUploadDialog, closeFeatureUploadDialog, handleFeatureUploadFile, submitFeatureUpload
 *   域 L-b — 结构/监控/特性/Hook 面板：
 *     - renderStructurePanel, renderMonitorPanel, renderFeaturesPanel, renderReverseHooksPanel
 *   面板入口：
 *     - renderFeaturePanel, toggleFeaturePanel
 *
 * 依赖（全局变量，声明于 app-core.js）：
 *   - currentMcpInfo, logFilters, logPanelScope
 *   - selectedOverviewLifecycle, selectedFeatureName, selectedRepositoryPackageId
 *   - repoSearchQuery, repoSourceFilter
 *   - activeFeaturePanel, featurePanelWidth
 *   - shouldAnimateWorkspaceSurface
 *   - currentLanguage, currentMessages
 *   - currentHookInspector, currentOverviewSnapshot, currentLogs
 *   - featurePanel, featurePanelBody, featurePanelTitle, railButtons
 *
 * 依赖（全局函数）：
 *   - escapeHtml, renderMarkdown, enhanceMathInElement (markdown-utils.js)
 *   - t (app-core.js)
 *   - ClawToast (toast-notify.js)
 *   - getRuntimeAwareAgentRecord, getRuntimeAwareAgentName (app-ui.js)
 *   - getFeatureStatus, getStatusBadgeClass, getFeatureStatusLabel, shortenSourcePath (app-ui.js / overview-data.js)
 *   - getEmptyOverviewSnapshot (overview-data.js)
 *   - getFeaturePanelEmptyHtml, renderCurrentMainView (app-ui.js)
 *   - getRepoLocaleText (app-ui.js)
 *   - loadAgents, loadLogs, loadMcpInfo (app-main.js)
 *   - featurePanels (app-ui.js，运行时注册表，箭头函数延迟解析)
 */

// ═══════════════════════════════════════════════════════════════
// 模块级状态变量
// ═══════════════════════════════════════════════════════════════

let summaryPopupData = null;

// Guard token: prevents stale openSummaryPopup callbacks from updating the toast
// when a newer call for the same session has superseded them.
const _summaryGenGuard = new Map();

let featureUploadFile = null;

// ═══════════════════════════════════════════════════════════════
// 域 K-b: Usage / Token 渲染
// ═══════════════════════════════════════════════════════════════

function formatMetricNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '0';
  }
  return value.toLocaleString();
}

function formatRate(numerator, denominator) {
  if (!denominator) {
    return '0%';
  }
  return Math.round((numerator / denominator) * 100) + '%';
}

function getLatestCallSummary(overview) {
  const calls = Array.isArray(overview?.usageStats?.calls) ? overview.usageStats.calls : [];
  if (calls.length === 0) return null;
  return calls.slice().sort((a, b) => (a.callIndex || 0) - (b.callIndex || 0))[calls.length - 1];
}

function getUsageBreakdown(summary, fallbackRequests = 0) {
  const totalUsage = summary?.totalUsage || {};
  const totalTokens = totalUsage.totalTokens || 0;
  const inputTokens = totalUsage.inputTokens || 0;
  const outputTokens = totalUsage.outputTokens || 0;
  const requests = typeof summary?.stepCount === 'number'
    ? summary.stepCount
    : fallbackRequests;
  const cacheHitRequests = typeof summary?.cacheHitRequests === 'number'
    ? summary.cacheHitRequests
    : 0;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    requests,
    cacheHitRequests,
    cacheMissRequests: Math.max(0, requests - cacheHitRequests),
    cacheHitRate: formatRate(cacheHitRequests, requests),
    avgPerRequest: requests > 0 ? Math.round(totalTokens / requests) : 0,
    cacheReadTokens: totalUsage.cacheReadTokens || 0,
    cacheCreationTokens: totalUsage.cacheCreationTokens || 0,
    inputShare: totalTokens > 0 ? Math.round((inputTokens / totalTokens) * 100) : 0,
    outputShare: totalTokens > 0 ? Math.round((outputTokens / totalTokens) * 100) : 0,
  };
}

function renderTokenBar(inputTokens, outputTokens) {
  const total = inputTokens + outputTokens;
  const inputWidth = total > 0 ? (inputTokens / total) * 100 : 50;
  const outputWidth = total > 0 ? (outputTokens / total) * 100 : 50;
  return [
    '<div class="usage-bar">',
    '<div class="usage-bar-fill input" style="width:' + inputWidth + '%"></div>',
    '<div class="usage-bar-fill output" style="width:' + outputWidth + '%"></div>',
    '</div>',
  ].join('');
}

function renderRateRing(percent, label, meta) {
  const safePercent = Math.max(0, Math.min(100, percent));
  return [
    '<div class="rate-ring-card">',
    '<div class="rate-ring" style="--ring-percent:' + safePercent + ';">',
    '<div class="rate-ring-inner">',
    '<div class="rate-ring-value">' + safePercent + '%</div>',
    '<div class="rate-ring-label">' + escapeHtml(label) + '</div>',
    '</div>',
    '</div>',
    '<div class="rate-ring-meta">' + escapeHtml(meta) + '</div>',
    '</div>',
  ].join('');
}

function renderUsageCard(title, summaryLabel, breakdown) {
  return [
    '<div class="usage-card">',
    '<div class="usage-card-header">',
    '<div>',
    '<div class="usage-card-title">' + escapeHtml(title) + '</div>',
    '<div class="usage-card-subtitle">' + escapeHtml(summaryLabel) + '</div>',
    '</div>',
    '<div class="usage-card-total">' + formatMetricNumber(breakdown.totalTokens) + '</div>',
    '</div>',
    renderTokenBar(breakdown.inputTokens, breakdown.outputTokens),
    '<div class="usage-split-legend">',
    '<span><i class="legend-dot input"></i>' + escapeHtml(t('metric_input_tokens')) + ' ' + formatMetricNumber(breakdown.inputTokens) + '</span>',
    '<span><i class="legend-dot output"></i>' + escapeHtml(t('metric_output_tokens')) + ' ' + formatMetricNumber(breakdown.outputTokens) + '</span>',
    '</div>',
    '<div class="usage-stat-grid">',
    '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_requests')) + '</div><div class="usage-stat-cell-value">' + formatMetricNumber(breakdown.requests) + '</div></div>',
    '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_avg_per_request')) + '</div><div class="usage-stat-cell-value">' + formatMetricNumber(breakdown.avgPerRequest) + '</div></div>',
    '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_input_share')) + '</div><div class="usage-stat-cell-value">' + breakdown.inputShare + '%</div></div>',
    '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_output_share')) + '</div><div class="usage-stat-cell-value">' + breakdown.outputShare + '%</div></div>',
    '</div>',
    '</div>',
  ].join('');
}

function renderCacheCard(title, breakdown) {
  const percent = breakdown.requests > 0
    ? Math.round((breakdown.cacheHitRequests / breakdown.requests) * 100)
    : 0;
  return [
    '<div class="usage-card cache-card">',
    '<div class="usage-card-header">',
    '<div class="usage-card-title">' + escapeHtml(title) + '</div>',
    '<div class="usage-card-subtitle">' + escapeHtml(t('metric_cache_hit_rate')) + '</div>',
    '</div>',
    renderRateRing(percent, t('metric_cache_hit_rate'), breakdown.cacheHitRequests + ' / ' + breakdown.requests),
    '<div class="usage-stat-grid">',
    '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_cache_hit_requests')) + '</div><div class="usage-stat-cell-value">' + formatMetricNumber(breakdown.cacheHitRequests) + '</div></div>',
    '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_cache_miss_requests')) + '</div><div class="usage-stat-cell-value">' + formatMetricNumber(breakdown.cacheMissRequests) + '</div></div>',
    '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_cache_read')) + '</div><div class="usage-stat-cell-value">' + formatMetricNumber(breakdown.cacheReadTokens) + '</div></div>',
    '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_cache_write')) + '</div><div class="usage-stat-cell-value">' + formatMetricNumber(breakdown.cacheCreationTokens) + '</div></div>',
    '</div>',
    '</div>',
  ].join('');
}

function renderContextChip(label, value, meta) {
  return [
    '<div class="context-chip">',
    '<div class="context-chip-label">' + escapeHtml(label) + '</div>',
    '<div class="context-chip-value">' + escapeHtml(value) + '</div>',
    '<div class="context-chip-meta">' + escapeHtml(meta) + '</div>',
    '</div>',
  ].join('');
}

// ═══════════════════════════════════════════════════════════════
// 域 K-b: MCP 信息
// ═══════════════════════════════════════════════════════════════

function setCurrentMcpInfo(info) {
  currentMcpInfo = info || null;
}

// ═══════════════════════════════════════════════════════════════
// 域 K-b: 日志面板
// ═══════════════════════════════════════════════════════════════

function getLevelWeight(level) {
  const weights = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
  return weights[level] || 0;
}

function formatLogTimestamp(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
}

function safePrettyJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (e) {
    return String(value);
  }
}

function getFilteredLogs() {
  const search = logFilters.search.trim().toLowerCase();
  const minLevel = logFilters.level;
  return currentLogs.filter((entry) => {
    if (minLevel !== 'all' && getLevelWeight(entry.level) < getLevelWeight(minLevel)) {
      return false;
    }
    if (logFilters.feature !== 'all' && (entry.context?.feature || 'none') !== logFilters.feature) {
      return false;
    }
    if (logFilters.lifecycle !== 'all' && (entry.context?.lifecycle || 'none') !== logFilters.lifecycle) {
      return false;
    }
    if (search) {
      const haystack = [
        entry.message,
        entry.namespace,
        entry.context?.feature,
        entry.context?.lifecycle,
        entry.context?.hookMethod,
        entry.context?.toolName,
        entry.context?.agentName,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(search)) {
        return false;
      }
    }
    return true;
  });
}

function renderLogsPanel() {
  const filteredLogs = getFilteredLogs().slice().reverse();
  const featureOptions = Array.from(new Set(currentLogs.map((entry) => entry.context?.feature).filter(Boolean))).sort();
  const lifecycleOptions = Array.from(new Set(currentLogs.map((entry) => entry.context?.lifecycle).filter(Boolean))).sort();

  const toolbar = [
    '<section class="log-toolbar">',
    '<div class="log-filter-row">',
    '<div class="log-filter-label">' + escapeHtml(t('logs_scope')) + '</div>',
    '<div class="log-chip-group">',
    '<button type="button" class="log-chip' + (logPanelScope === 'current' ? ' active' : '') + '" onclick="window.setLogPanelScope(&quot;current&quot;)">' + escapeHtml(t('logs_scope_current')) + '</button>',
    '<button type="button" class="log-chip' + (logPanelScope === 'all' ? ' active' : '') + '" onclick="window.setLogPanelScope(&quot;all&quot;)">' + escapeHtml(t('logs_scope_all')) + '</button>',
    '</div>',
    '</div>',
    '<div class="log-filter-row">',
    '<div class="log-filter-label">' + escapeHtml(t('logs_search')) + '</div>',
    '<input class="log-input" type="text" value="' + escapeHtml(logFilters.search) + '" placeholder="' + escapeHtml(t('logs_search_placeholder')) + '" oninput="window.updateLogFilter(&quot;search&quot;, this.value)">',
    '</div>',
    '<div class="log-filter-row">',
    '<div class="log-filter-label">' + escapeHtml(t('logs_level')) + '</div>',
    '<select class="log-select" onchange="window.updateLogFilter(&quot;level&quot;, this.value)">',
    '<option value="all"' + (logFilters.level === 'all' ? ' selected' : '') + '>' + escapeHtml(t('logs_level_all')) + '</option>',
    '<option value="debug"' + (logFilters.level === 'debug' ? ' selected' : '') + '>' + escapeHtml(t('logs_level_debug')) + '</option>',
    '<option value="info"' + (logFilters.level === 'info' ? ' selected' : '') + '>' + escapeHtml(t('logs_level_info')) + '</option>',
    '<option value="warn"' + (logFilters.level === 'warn' ? ' selected' : '') + '>' + escapeHtml(t('logs_level_warn')) + '</option>',
    '<option value="error"' + (logFilters.level === 'error' ? ' selected' : '') + '>' + escapeHtml(t('logs_level_error')) + '</option>',
    '</select>',
    '<select class="log-select" onchange="window.updateLogFilter(&quot;feature&quot;, this.value)">',
    '<option value="all"' + (logFilters.feature === 'all' ? ' selected' : '') + '>' + escapeHtml(t('logs_feature_all')) + '</option>',
    featureOptions.map((feature) => '<option value="' + escapeHtml(feature) + '"' + (logFilters.feature === feature ? ' selected' : '') + '>' + escapeHtml(feature) + '</option>').join(''),
    '</select>',
    '<select class="log-select" onchange="window.updateLogFilter(&quot;lifecycle&quot;, this.value)">',
    '<option value="all"' + (logFilters.lifecycle === 'all' ? ' selected' : '') + '>' + escapeHtml(t('logs_lifecycle_all')) + '</option>',
    lifecycleOptions.map((lifecycle) => '<option value="' + escapeHtml(lifecycle) + '"' + (logFilters.lifecycle === lifecycle ? ' selected' : '') + '>' + escapeHtml(lifecycle) + '</option>').join(''),
    '</select>',
    '</div>',
    '<div class="log-summary"><span>' + String(filteredLogs.length) + ' ' + escapeHtml(t('logs_total')) + '</span><span>' + escapeHtml(logPanelScope === 'current' ? getRuntimeAwareAgentName() : t('logs_scope_all')) + '</span></div>',
    '</section>',
  ].join('');

  if (filteredLogs.length === 0) {
    return '<div class="log-panel">' + toolbar + '<div class="feature-panel-empty"><div>' + escapeHtml(t('logs_empty')) + '</div></div></div>';
  }

  const rows = filteredLogs.map((entry) => {
    const metaPills = [
      entry.context?.agentName ? '<span class="log-pill">' + escapeHtml(entry.context.agentName) + '</span>' : '',
      entry.context?.feature ? '<span class="log-pill">feature:' + escapeHtml(entry.context.feature) + '</span>' : '',
      entry.context?.lifecycle ? '<span class="log-pill">hook:' + escapeHtml(entry.context.lifecycle) + '</span>' : '',
      entry.context?.hookMethod ? '<span class="log-pill">' + escapeHtml(entry.context.hookMethod) + '()</span>' : '',
      entry.context?.toolName ? '<span class="log-pill">tool:' + escapeHtml(entry.context.toolName) + '</span>' : '',
      typeof entry.context?.step === 'number' ? '<span class="log-pill">step ' + String(entry.context.step) + '</span>' : '',
      typeof entry.context?.callIndex === 'number' ? '<span class="log-pill">call ' + String(entry.context.callIndex) + '</span>' : '',
    ].filter(Boolean).join('');

    const detailBlock = entry.data !== undefined
      ? '<details class="log-details"><summary>' + escapeHtml(t('logs_details')) + '</summary><pre>' + escapeHtml(safePrettyJson(entry.data)) + '</pre></details>'
      : '';

    return [
      '<article class="log-card">',
      '<div class="log-card-head">',
      '<div class="log-card-main">',
      '<span class="log-level ' + escapeHtml(entry.level) + '">' + escapeHtml(entry.level) + '</span>',
      '<span class="log-namespace">' + escapeHtml(entry.namespace) + '</span>',
      '</div>',
      '<div class="log-timestamp">' + escapeHtml(formatLogTimestamp(entry.timestamp)) + '</div>',
      '</div>',
      '<div class="log-card-body">',
      '<div class="log-message">' + escapeHtml(entry.message) + '</div>',
      metaPills ? '<div class="log-meta">' + metaPills + '</div>' : '',
      detailBlock,
      '</div>',
      '</article>',
    ].join('');
  }).join('');

  return '<div class="log-panel">' + toolbar + '<section class="log-list">' + rows + '</section></div>';
}

// ═══════════════════════════════════════════════════════════════
// 域 K-b: MCP 面板
// ═══════════════════════════════════════════════════════════════

function renderMcpItems(items, typeLabel) {
  if (!Array.isArray(items) || items.length === 0) {
    return '<div class="feature-panel-empty"><div>' + escapeHtml(t('active_none')) + '</div></div>';
  }

  return '<div class="mcp-list">' + items.map((item) => {
    const name = item.name || item.uri || '';
    return [
    '<article class="mcp-item">',
    '<div class="mcp-item-head">',
    '<div class="mcp-item-name">' + escapeHtml(name) + '</div>',
    '<div class="mcp-item-type">' + escapeHtml(typeLabel) + '</div>',
    '</div>',
      '<div class="mcp-item-desc">' + escapeHtml(item.description || '') + '</div>',
      '</article>',
    ].join('');
  }).join('') + '</div>';
}

function renderMcpPanel() {
  if (!currentMcpInfo) {
    return '<div class="feature-panel-empty"><div>' + escapeHtml(t('mcp_loading')) + '</div></div>';
  }

  const info = currentMcpInfo;
  return [
    '<div class="mcp-panel">',
    '<section class="mcp-hero">',
    '<div class="hooks-kicker">' + escapeHtml(t('mcp_section_kicker')) + '</div>',
    '<div class="hooks-hero-title">' + escapeHtml(t('mcp_hero_title')) + '</div>',
    '<div class="hooks-hero-subtitle">' + escapeHtml(t('mcp_subtitle')) + '</div>',
    '<div class="mcp-status-pill">' + escapeHtml(info.enabled ? t('mcp_enabled') : t('mcp_disabled')) + '</div>',
    '</section>',
    '<section class="feature-panel-section">',
    '<div class="feature-panel-section-title">' + escapeHtml(t('panel_inspector')) + '</div>',
    '<div class="mcp-grid">',
    '<div class="mcp-stat"><div class="mcp-stat-label">' + escapeHtml(t('mcp_endpoint')) + '</div><div class="mcp-stat-value">' + escapeHtml(info.endpoint || '') + '</div></div>',
    '<div class="mcp-stat"><div class="mcp-stat-label">' + escapeHtml(t('mcp_transport')) + '</div><div class="mcp-stat-value">' + escapeHtml(info.transport || '') + '</div></div>',
    '<div class="mcp-stat"><div class="mcp-stat-label">' + escapeHtml(t('mcp_tools')) + '</div><div class="mcp-stat-value">' + String((info.tools || []).length) + '</div></div>',
    '<div class="mcp-stat"><div class="mcp-stat-label">' + escapeHtml(t('mcp_resources')) + '</div><div class="mcp-stat-value">' + String((info.resources || []).length) + '</div></div>',
    '</div>',
    '</section>',
    '<section class="feature-panel-section">',
    '<div class="feature-panel-section-title">' + escapeHtml(t('mcp_client_config')) + '</div>',
    '<div class="mcp-item-desc" style="margin-bottom:8px;">' + escapeHtml(t('mcp_claude_desktop')) + '</div>',
    '<pre class="mcp-code">' + escapeHtml(safePrettyJson(info.commands?.claudeDesktop?.json || {})) + '</pre>',
    '<div class="mcp-item-desc" style="margin:12px 0 8px 0;">' + escapeHtml(t('mcp_codex')) + '</div>',
    '<pre class="mcp-code">' + escapeHtml(safePrettyJson(info.commands?.codex?.json || {})) + '</pre>',
    '<div class="mcp-item-desc" style="margin:12px 0 8px 0;">' + escapeHtml(t('mcp_manual')) + '</div>',
    '<pre class="mcp-code">' + escapeHtml(info.commands?.curlInitialize || '') + '</pre>',
    '</section>',
    '<section class="feature-panel-section">',
    '<div class="feature-panel-section-title">' + escapeHtml(t('mcp_tool_list')) + '</div>',
    renderMcpItems(info.tools || [], t('mcp_item_tool')),
    '</section>',
    '<section class="feature-panel-section">',
    '<div class="feature-panel-section-title">' + escapeHtml(t('mcp_resource_list')) + '</div>',
    renderMcpItems(info.resources || [], t('mcp_item_resource')),
    '</section>',
    '<section class="feature-panel-section">',
    '<div class="feature-panel-section-title">' + escapeHtml(t('mcp_prompt_list')) + '</div>',
    renderMcpItems(info.prompts || [], t('mcp_item_prompt')),
    '</section>',
    '</div>',
  ].join('');
}

// ═══════════════════════════════════════════════════════════════
// 域 K-b: 生命周期文档常量
// ═══════════════════════════════════════════════════════════════

const lifecycleDocs = {
  AgentInitiate: {
    title: { zh: 'Agent 初始化阶段', en: 'Agent initialization phase' },
    body: {
      zh: [
      '这个时机只会在 agent 第一次真正进入工作状态时触发一次，适合做长生命周期资源的准备工作，比如启动后台服务、建立连接、预热缓存，或者把框架级能力挂进运行环境。',
      '',
      '~~~ts',
      '@AgentInitiate',
      'async boot(ctx) {',
      '  await this.indexWorkspace();',
      '  await this.startObserver();',
      '}',
      '~~~',
      '',
      '如果某个 feature 要在整个会话期间维持状态，这里通常是它最稳妥的切入点。相比 CallStart，它不会被每次用户输入重复触发。',
    ].join('\n'),
      en: [
      'This moment fires only once when the agent truly enters its working state. It is the right place for long-lived setup such as booting background services, opening connections, warming caches, or mounting framework-level helpers.',
      '',
      '~~~ts',
      '@AgentInitiate',
      'async boot(ctx) {',
      '  await this.indexWorkspace();',
      '  await this.startObserver();',
      '}',
      '~~~',
      '',
      'If a feature needs to hold state across the whole session, this is usually the safest insertion point. Unlike CallStart, it is not repeated on every user request.',
    ].join('\n'),
    },
  },
  AgentDestroy: {
    title: { zh: 'Agent 销毁阶段', en: 'Agent destroy phase' },
    body: { zh: [
      '这是 agent 生命周期的收尾点，用来释放外部资源、停止后台线程、断开连接，以及把调试信息或缓存安全落盘。',
      '',
      '~~~ts',
      '@AgentDestroy',
      'async cleanup() {',
      '  await this.workerPool.stop();',
      '  await this.cache.flush();',
      '}',
      '~~~',
      '',
      '如果一个 feature 在 AgentInitiate 做了重量级初始化，就应该在这里成对地清理掉。',
    ].join('\n'),
      en: [
      'This is the closing stage of the agent lifecycle. Use it to release external resources, stop workers, close connections, and flush traces or caches safely to disk.',
      '',
      '~~~ts',
      '@AgentDestroy',
      'async cleanup() {',
      '  await this.workerPool.stop();',
      '  await this.cache.flush();',
      '}',
      '~~~',
      '',
      'If a feature performs heavyweight setup in AgentInitiate, it should usually tear that work down here.',
    ].join('\n') },
  },
  CallStart: {
    title: { zh: 'Call 开始前', en: 'Before call start' },
    body: { zh: [
      '这个时机发生在系统提示词之后、用户输入正式写入上下文之前。它非常适合做输入重写、前置注入和会话级别的轻量整理。',
      '',
      '~~~ts',
      '@CallStart',
      'async rewriteInput(ctx) {',
      '  const raw = ctx.agent?.getUserInput() ?? ctx.input;',
      '  ctx.agent?.setUserInput(raw.trim());',
      '}',
      '~~~',
      '',
      '如果你想观察 feature 如何"提前影响"一次调用，这里通常是最有解释力的节点。',
    ].join('\n'),
      en: [
      'This timing happens after the system prompt is ready but before the user input is committed into context. It is ideal for input rewriting, pre-injection, and lightweight call-level normalization.',
      '',
      '~~~ts',
      '@CallStart',
      'async rewriteInput(ctx) {',
      '  const raw = ctx.agent?.getUserInput() ?? ctx.input;',
      '  ctx.agent?.setUserInput(raw.trim());',
      '}',
      '~~~',
      '',
      'If you want to explain how a feature affects a call before the model sees it, this is usually the clearest node.',
    ].join('\n') },
  },
  CallFinish: {
    title: { zh: 'Call 结束后', en: 'After call finish' },
    body: { zh: [
      '这是一次完整调用结束后的结算点。适合做摘要、记录、指标更新、落日志，而不适合决定下一轮 ReAct 要不要继续。',
      '',
      '~~~ts',
      '@CallFinish',
      'async afterCall(ctx) {',
      '  this.metrics.track(ctx.completed, ctx.steps);',
      '}',
      '~~~',
      '',
      '它更像"回合总结"，而不是流程控制点。',
    ].join('\n'),
      en: [
      'This is the settlement point after a full call completes. It fits summarization, logging, and metrics updates, but it is not the place to decide whether the next ReAct turn should continue.',
      '',
      '~~~ts',
      '@CallFinish',
      'async afterCall(ctx) {',
      '  this.metrics.track(ctx.completed, ctx.steps);',
      '}',
      '~~~',
      '',
      'It behaves more like an end-of-call summary than a flow-control decision point.',
    ].join('\n') },
  },
  StepStart: {
    title: { zh: 'Step 开始前', en: 'Before step start' },
    body: { zh: [
      '每轮 ReAct 循环刚开始时都会进入这里。适合做上下文补丁、提醒注入、局部状态同步。这类钩子往往会高频出现。',
      '',
      '~~~ts',
      '@StepStart',
      'async injectReminder(ctx) {',
      '  if (this.shouldRemind()) {',
      '    ctx.context.add({ role: "system", content: this.reminder });',
      '  }',
      '}',
      '~~~',
      '',
      '因为它会在每一轮执行，所以调试器里把它单独看出来很重要，否则很难解释某些系统消息为什么总会出现。',
    ].join('\n'),
      en: [
      'Every ReAct iteration enters here right at the beginning. It is useful for context patching, reminder injection, and local state synchronization. These hooks often run at high frequency.',
      '',
      '~~~ts',
      '@StepStart',
      'async injectReminder(ctx) {',
      '  if (this.shouldRemind()) {',
      '    ctx.context.add({ role: "system", content: this.reminder });',
      '  }',
      '}',
      '~~~',
      '',
      'Because it runs every round, surfacing it clearly in the debugger is important; otherwise it is hard to explain why some system messages keep appearing.',
    ].join('\n') },
  },
  StepFinish: {
    title: { zh: 'Step 结束决策点', en: 'Step finish decision point' },
    body: { zh: [
      '这是 ReAct 循环里最关键的控制点之一。模型和工具都跑完后，feature 可以在这里决定"继续下一轮"还是"就地结束"。',
      '',
      '~~~ts',
      '@StepFinish',
      'async decide(ctx) {',
      '  if (this.hasPendingDelegates()) {',
      '    return Decision.Approve;',
      '  }',
      '  return Decision.Continue;',
      '}',
      '~~~',
      '',
      '如果某个 feature 能把 agent 的循环强行维持住，通常就是在这里介入。它解释的是"为什么这轮已经看起来结束了，但系统还在继续跑"。',
    ].join('\n'),
      en: [
      'This is one of the most important control points in the ReAct loop. After the model and tools finish, a feature can decide whether the loop should continue or end right away.',
      '',
      '~~~ts',
      '@StepFinish',
      'async decide(ctx) {',
      '  if (this.hasPendingDelegates()) {',
      '    return Decision.Approve;',
      '  }',
      '  return Decision.Continue;',
      '}',
      '~~~',
      '',
      'If a feature can keep the agent alive beyond what looks like a natural stopping point, it is usually intervening here.',
    ].join('\n') },
  },
  ToolUse: {
    title: { zh: '工具执行前决策点', en: 'Before tool execution decision point' },
    body: { zh: [
      '这是另一个高价值观察位点。工具真正执行前，feature 可以在这里批准、拒绝或者放行。所有安全策略、危险操作拦截都很适合在这里实现。',
      '',
      '~~~ts',
      '@ToolUse',
      'async guard(ctx) {',
      '  if (ctx.call.name === "run_shell_command") {',
      '    return Decision.Deny;',
      '  }',
      '  return Decision.Continue;',
      '}',
      '~~~',
      '',
      '调试器里只要看清楚这里挂了谁，很多"为什么工具没执行"或者"为什么执行路径被改写"就能直接定位。',
    ].join('\n'),
      en: [
      'This is another high-value inspection point. Before a tool actually runs, a feature can approve, deny, or pass it through. Security policy and dangerous-operation guards fit naturally here.',
      '',
      '~~~ts',
      '@ToolUse',
      'async guard(ctx) {',
      '  if (ctx.call.name === "run_shell_command") {',
      '    return Decision.Deny;',
      '  }',
      '  return Decision.Continue;',
      '}',
      '~~~',
      '',
      'As soon as you can see who is attached here, many "why did the tool not run?" questions become much easier to answer.',
    ].join('\n') },
  },
  ToolFinished: {
    title: { zh: '工具执行后通知点', en: 'After tool finished notify point' },
    body: { zh: [
      '工具已经返回结果以后，这里会收到纯通知。适合做后处理、索引、同步外部状态、记录审计信息，但不会改变刚刚那次工具调用本身的结果。',
      '',
      '~~~ts',
      '@ToolFinished',
      'async record(ctx) {',
      '  this.auditTrail.push({',
      '    tool: ctx.toolName,',
      '    duration: ctx.duration,',
      '  });',
      '}',
      '~~~',
      '',
      '这类钩子更偏"旁路观察"和"后续整理"，所以通常适合完整展开给开发者查链路。',
    ].join('\n'),
      en: [
      'Once a tool returns its result, this point receives a pure notification. It suits post-processing, indexing, external state sync, and audit recording, but it does not change the result of the tool call that already happened.',
      '',
      '~~~ts',
      '@ToolFinished',
      'async record(ctx) {',
      '  this.auditTrail.push({',
      '    tool: ctx.toolName,',
      '    duration: ctx.duration,',
      '  });',
      '}',
      '~~~',
      '',
      'These hooks are more about side-channel observation and cleanup, so they are usually worth showing in full detail to developers.',
    ].join('\n') },
  },
};

// ═══════════════════════════════════════════════════════════════
// 域 K-b: 生命周期选择器
// ═══════════════════════════════════════════════════════════════

function selectOverviewLifecycle(lifecycle) {
  selectedOverviewLifecycle = lifecycle;
  if (activeFeaturePanel === 'workspace') {
    renderFeaturePanel();
  }
}

window.selectOverviewLifecycle = selectOverviewLifecycle;

function openFeatureDetails(featureName) {
  selectedFeatureName = featureName;
  if (activeFeaturePanel === 'hooks') {
    renderFeaturePanel();
  }
}

function closeFeatureDetails() {
  selectedFeatureName = null;
  if (activeFeaturePanel === 'hooks') {
    renderFeaturePanel();
  }
}

window.openFeatureDetails = openFeatureDetails;
window.closeFeatureDetails = closeFeatureDetails;

function openRepositoryPackageDetails(packageId) {
  selectedRepositoryPackageId = packageId;
  renderCurrentMainView();
}

function closeRepositoryPackageDetails() {
  selectedRepositoryPackageId = null;
  renderCurrentMainView();
}

window.openRepositoryPackageDetails = openRepositoryPackageDetails;
window.closeRepositoryPackageDetails = closeRepositoryPackageDetails;

// ═══════════════════════════════════════════════════════════════
// 域 L-a: Summary 弹窗
// ═══════════════════════════════════════════════════════════════

function getOrCreateSummaryOverlay() {
  let overlay = document.getElementById('summary-popup-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'summary-popup-overlay';
    const mainContent = document.querySelector('.main-content');
    if (mainContent) {
      mainContent.appendChild(overlay);
    } else {
      document.body.appendChild(overlay);
    }
  }
  return overlay;
}

function renderSummaryBodyContent(data) {
  const { loading, generating, data: summaryData, error } = data;
  if (loading) {
    const msg = generating ? t('workspace_summary_generating') : t('workspace_summary_loading');
    return '<div class="summary-loading-state">' +
      '<div class="summary-spinner"></div>' +
      '<span>' + escapeHtml(msg) + '</span>' +
      '</div>';
  }
  if (error) {
    return '<div class="summary-error-state">' + escapeHtml(error) + '</div>';
  }
  if (!summaryData) return '';
  let bodyContent = '';

  // Session title & meta header
  const title = summaryData.sessionTitle || '';
  const createdAt = summaryData.createdAt ? new Date(summaryData.createdAt) : null;
  const timeStr = createdAt ? createdAt.toLocaleString(currentLanguage === 'zh' ? 'zh-CN' : 'en-US') : '';
  if (title || timeStr) {
    bodyContent += '<div class="summary-header">';
    if (title) bodyContent += '<div class="summary-title">' + escapeHtml(title) + '</div>';
    if (timeStr) bodyContent += '<div class="summary-time">' + escapeHtml(timeStr) + '</div>';
    bodyContent += '</div>';
  }

  // Summary body — rendered as markdown
  const summaryText = summaryData.summaryText || t('workspace_no_summary_content');
  bodyContent += '<div class="summary-body markdown-body">' + renderMarkdown(summaryText) + '</div>';

  // Important files — no icons, clean mono list
  if (summaryData.importantFiles && summaryData.importantFiles.length > 0) {
    bodyContent += '<div class="summary-section">';
    bodyContent += '<div class="summary-section-title">' + escapeHtml(t('workspace_important_files')) + '</div>';
    bodyContent += '<div class="summary-file-list">' + summaryData.importantFiles.map(f =>
      '<div class="summary-file-item">' + escapeHtml(f) + '</div>'
    ).join('') + '</div>';
    bodyContent += '</div>';
  }

  // Important skills
  if (summaryData.importantSkills && summaryData.importantSkills.length > 0) {
    bodyContent += '<div class="summary-section">';
    bodyContent += '<div class="summary-section-title">' + escapeHtml(t('workspace_important_skills')) + '</div>';
    bodyContent += '<div class="summary-tag-list">' + summaryData.importantSkills.map(s => '<span class="summary-tag">' + escapeHtml(s) + '</span>').join('') + '</div>';
    bodyContent += '</div>';
  }

  return bodyContent;
}

function updateSummaryOverlayDOM(data) {
  const overlay = getOrCreateSummaryOverlay();
  overlay.className = 'feature-detail-overlay';
  const hasData = data && data.data && !data.loading && !data.error;
  overlay.innerHTML =
    '<div class="feature-detail-window summary-popup-window">' +
    '<div class="feature-detail-head">' +
    '<div><div class="feature-detail-title">' + escapeHtml(t('workspace_summary_title')) + '</div></div>' +
    '<button class="feature-detail-close" type="button" onclick="window.closeSummaryPopup()">×</button>' +
    '</div>' +
    '<div class="summary-popup-body">' +
    renderSummaryBodyContent(data) +
    '</div>' +
    (hasData ? '<div class="summary-popup-footer"><button class="summary-regenerate-btn" type="button" onclick="window.regenerateSummary()">' + escapeHtml(t('workspace_regenerate_summary')) + '</button></div>' : '') +
    '</div>';
  // Post-render: enhance math in summary markdown
  if (hasData) {
    requestAnimationFrame(() => {
      const md = overlay.querySelector('.summary-body.markdown-body');
      if (md) enhanceMathInElement(md);
    });
  }
}

function openSummaryPopup(agentId, sessionId) {
  const _isZh = currentLanguage === 'zh';
  const _toastId = 'summary-' + sessionId;
  const _token = {};
  _summaryGenGuard.set(sessionId, _token);
  summaryPopupData = { agentId, sessionId, loading: true, generating: false, data: null, error: null };
  updateSummaryOverlayDOM(summaryPopupData);
  fetch('/protoclaw/session_summary?agentId=' + encodeURIComponent(agentId) + '&sessionId=' + encodeURIComponent(sessionId))
    .then(r => {
      if (r.status === 404) {
        if (summaryPopupData && summaryPopupData.agentId === agentId && summaryPopupData.sessionId === sessionId) {
          summaryPopupData.generating = true;
          updateSummaryOverlayDOM(summaryPopupData);
        }
        ClawToast.show({
          id: _toastId,
          title: _isZh ? '正在生成会话摘要...' : 'Generating session summary...',
          status: 'loading',
        });
        return fetch('/protoclaw/session_generate_summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId, sessionId }),
        }).then(r2 => {
          if (!r2.ok) throw new Error('Generation failed');
          return r2.json();
        }).then(() => {
          return fetch('/protoclaw/session_summary?agentId=' + encodeURIComponent(agentId) + '&sessionId=' + encodeURIComponent(sessionId));
        }).then(r3 => {
          if (!r3.ok) throw new Error('Summary not found after generation');
          return r3.json();
        });
      }
      if (!r.ok) throw new Error(r.status);
      return r.json();
    })
    .then(data => {
      // Stale check: a newer openSummaryPopup call for the same session has superseded this one.
      if (_summaryGenGuard.get(sessionId) !== _token) return;
      if (summaryPopupData && summaryPopupData.agentId === agentId && summaryPopupData.sessionId === sessionId) {
        summaryPopupData.loading = false;
        summaryPopupData.generating = false;
        summaryPopupData.data = data;
        updateSummaryOverlayDOM(summaryPopupData);
      }
      loadAgents().catch(() => {});
      ClawToast.update(_toastId, {
        status: 'success',
        title: _isZh ? '摘要已生成' : 'Summary generated',
      });
    })
    .catch(err => {
      // Stale check: a newer openSummaryPopup call for the same session has superseded this one.
      if (_summaryGenGuard.get(sessionId) !== _token) return;
      if (summaryPopupData && summaryPopupData.agentId === agentId && summaryPopupData.sessionId === sessionId) {
        summaryPopupData.loading = false;
        summaryPopupData.generating = false;
        summaryPopupData.error = err.message;
        updateSummaryOverlayDOM(summaryPopupData);
      }
      ClawToast.update(_toastId, {
        status: 'error',
        title: _isZh ? '摘要生成失败' : 'Summary generation failed',
        description: err.message || String(err),
      });
    });
}

function closeSummaryPopup() {
  summaryPopupData = null;
  const overlay = document.getElementById('summary-popup-overlay');
  if (overlay) overlay.remove();
}

window.openSummaryPopup = openSummaryPopup;
window.closeSummaryPopup = closeSummaryPopup;

function regenerateSummary() {
  if (!summaryPopupData) return;
  const { agentId, sessionId } = summaryPopupData;
  const _isZh = currentLanguage === 'zh';
  const _toastId = 'summary-regen-' + sessionId;
  summaryPopupData = { agentId, sessionId, loading: true, generating: true, data: null, error: null };
  updateSummaryOverlayDOM(summaryPopupData);
  ClawToast.show({
    id: _toastId,
    title: _isZh ? '正在重新生成摘要...' : 'Regenerating summary...',
    status: 'loading',
  });
  fetch('/protoclaw/session_generate_summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, sessionId, force: true }),
  })
    .then(r => { if (!r.ok) throw new Error('Generation failed'); return r.json(); })
    .then(() => fetch('/protoclaw/session_summary?agentId=' + encodeURIComponent(agentId) + '&sessionId=' + encodeURIComponent(sessionId)))
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(data => {
      if (summaryPopupData && summaryPopupData.agentId === agentId && summaryPopupData.sessionId === sessionId) {
        summaryPopupData.loading = false;
        summaryPopupData.generating = false;
        summaryPopupData.data = data;
        updateSummaryOverlayDOM(summaryPopupData);
      }
      loadAgents().catch(() => {});
      ClawToast.update(_toastId, {
        status: 'success',
        title: _isZh ? '摘要已重新生成' : 'Summary regenerated',
      });
    })
    .catch(err => {
      if (summaryPopupData && summaryPopupData.agentId === agentId && summaryPopupData.sessionId === sessionId) {
        summaryPopupData.loading = false;
        summaryPopupData.generating = false;
        summaryPopupData.error = err.message;
        updateSummaryOverlayDOM(summaryPopupData);
      }
      ClawToast.update(_toastId, {
        status: 'error',
        title: _isZh ? '摘要生成失败' : 'Summary generation failed',
        description: err.message || String(err),
      });
    });
}

window.regenerateSummary = regenerateSummary;

// ═══════════════════════════════════════════════════════════════
// 域 L-a: Repo 搜索/过滤
// ═══════════════════════════════════════════════════════════════

function setRepoSearchQuery(value) {
  repoSearchQuery = String(value || '').trim().toLowerCase();
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
}

function setRepoSourceFilter(value) {
  repoSourceFilter = String(value || 'all');
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
}

window.setRepoSearchQuery = setRepoSearchQuery;
window.setRepoSourceFilter = setRepoSourceFilter;

// ═══════════════════════════════════════════════════════════════
// 域 L-a: Feature Upload
// ═══════════════════════════════════════════════════════════════

function openFeatureUploadDialog() {
  const dialog = document.getElementById('feature-upload-dialog');
  const input = document.getElementById('feature-upload-input');
  const status = document.getElementById('feature-upload-status');
  const submitBtn = document.getElementById('feature-upload-submit');
  const dropzone = document.getElementById('feature-upload-dropzone');
  
  dialog.style.display = 'flex';
  input.value = '';
  status.style.display = 'none';
  status.className = 'feature-upload-status';
  submitBtn.disabled = true;
  featureUploadFile = null;

  // 点击上传区域选择文件
  dropzone.onclick = () => input.click();
  
  // 文件选择变化
  input.onchange = (e) => {
    const file = e.target.files?.[0];
    handleFeatureUploadFile(file);
  };

  // 拖拽上传
  dropzone.ondragover = (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  };

  dropzone.ondragleave = () => {
    dropzone.classList.remove('dragover');
  };

  dropzone.ondrop = (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const file = e.dataTransfer?.files?.[0];
    handleFeatureUploadFile(file);
  };
}

function closeFeatureUploadDialog() {
  const dialog = document.getElementById('feature-upload-dialog');
  dialog.style.display = 'none';
  featureUploadFile = null;
}

function handleFeatureUploadFile(file) {
  const status = document.getElementById('feature-upload-status');
  const submitBtn = document.getElementById('feature-upload-submit');
  
  if (!file) {
    status.style.display = 'none';
    submitBtn.disabled = true;
    featureUploadFile = null;
    return;
  }

  if (!file.name.toLowerCase().endsWith('.tgz')) {
    status.textContent = getRepoLocaleText('请选择 .tgz 格式的文件', 'Please select a .tgz file');
    status.className = 'feature-upload-status error';
    status.style.display = 'block';
    submitBtn.disabled = true;
    featureUploadFile = null;
    return;
  }

  featureUploadFile = file;
  status.textContent = getRepoLocaleText(`已选择: ${file.name}`, `Selected: ${file.name}`);
  status.className = 'feature-upload-status success';
  status.style.display = 'block';
  submitBtn.disabled = false;
}

async function submitFeatureUpload() {
  if (!featureUploadFile) return;

  const status = document.getElementById('feature-upload-status');
  const submitBtn = document.getElementById('feature-upload-submit');
  
  submitBtn.disabled = true;
  status.textContent = getRepoLocaleText('上传中...', 'Uploading...');
  status.className = 'feature-upload-status';
  status.style.display = 'block';

  try {
    const formData = new FormData();
    formData.append('file', featureUploadFile);

    const response = await fetch('/protoclaw/feature_repository/upload', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'upload failed'));
    }

    status.textContent = getRepoLocaleText('上传成功!', 'Upload successful!');
    status.className = 'feature-upload-status success';
    
    setTimeout(() => {
      closeFeatureUploadDialog();
      renderCurrentMainView();
    }, 1000);
  } catch (e) {
    status.textContent = getRepoLocaleText('上传失败: ', 'Upload failed: ') + (e && e.message ? e.message : e);
    status.className = 'feature-upload-status error';
    submitBtn.disabled = false;
  }
}

window.openFeatureUploadDialog = openFeatureUploadDialog;
window.closeFeatureUploadDialog = closeFeatureUploadDialog;
window.submitFeatureUpload = submitFeatureUpload;

// ═══════════════════════════════════════════════════════════════
// 域 L-b: 结构/监控/特性/Hook 面板
// ═══════════════════════════════════════════════════════════════

function renderStructurePanel() {
  const activeAgent = getRuntimeAwareAgentRecord();
  const connected = activeAgent ? (activeAgent.connected !== false ? t('status_connected') : t('status_disconnected')) : t('status_no_agent');
  const totalHooks = currentHookInspector.hooks.reduce((sum, group) => sum + group.entries.length, 0);
  const decisionHooks = currentHookInspector.hooks.reduce(
    (sum, group) => sum + group.entries.filter(entry => entry.kind === 'decision').length,
    0
  );
  const featureStatusCounts = currentHookInspector.features.reduce((acc, feature) => {
    const status = getFeatureStatus(feature);
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, { enabled: 0, partial: 0, disabled: 0, removed: 0 });
  const selectedDoc = lifecycleDocs[selectedOverviewLifecycle] || lifecycleDocs.StepFinish;
  const flowChips = currentHookInspector.lifecycleOrder
    .map(name => '<button class="hooks-chip' + (name === selectedOverviewLifecycle ? ' active' : '') + '" type="button" onclick="window.selectOverviewLifecycle(&quot;' + escapeHtml(name) + '&quot;)"><strong>' + escapeHtml(name) + '</strong></button>')
    .join('');
  return [
    '<div class="hooks-panel">',
    '<section class="hooks-hero">',
    '<div class="hooks-kicker">' + escapeHtml(t('structure_kicker')) + '</div>',
    '<div class="hooks-hero-title">' + escapeHtml(t('structure_hero_title')) + '</div>',
    '<div class="hooks-hero-subtitle">' + escapeHtml(t('structure_subtitle')) + '</div>',
    '<div class="hooks-stats">',
    '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('stat_active_agent')) + '</div><div class="hooks-stat-value">' + escapeHtml(getRuntimeAwareAgentName()) + '</div></div>',
    '<div class="hooks-stat"><div class="hooks-stat-label">Hooks</div><div class="hooks-stat-value">' + String(totalHooks) + '</div></div>',
    '<div class="hooks-stat"><div class="hooks-stat-label">Decision</div><div class="hooks-stat-value">' + String(decisionHooks) + '</div></div>',
    '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('panel_features_label')) + '</div><div class="hooks-stat-value">' + String(currentHookInspector.features.length) + '</div></div>',
    '</div>',
    '</section>',
    '<section class="hooks-section">',
    '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('panel_inspector')) + '</div><div class="hooks-section-meta">' + escapeHtml(connected) + '</div></div>',
    '<div class="feature-grid">',
    '<div class="feature-card"><div class="feature-card-name">' + escapeHtml(t('panel_connection')) + '</div><div class="feature-card-detail"><span>' + escapeHtml(connected) + '</span><span>' + String(currentMessages.length) + ' ' + escapeHtml(t('feature_messages')) + '</span></div></div>',
    '<div class="feature-card"><div class="feature-card-name">' + escapeHtml(t('panel_features_label')) + '</div><div class="feature-card-detail"><span>' + String(currentHookInspector.features.length) + ' ' + escapeHtml(t('panel_total')) + '</span><span>' + String(featureStatusCounts.enabled) + ' ' + escapeHtml(t('panel_enabled')) + '</span><span>' + String(featureStatusCounts.partial) + ' ' + escapeHtml(t('panel_partial')) + '</span><span>' + String(featureStatusCounts.disabled) + ' ' + escapeHtml(t('panel_disabled')) + '</span><span>' + String(featureStatusCounts.removed) + ' ' + escapeHtml(t('panel_removed')) + '</span></div></div>',
    '</div>',
    '</section>',
    '<section class="hooks-section">',
    '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('panel_loop_flow')) + '</div><div class="hooks-section-meta">' + escapeHtml(t('panel_select_lifecycle')) + '</div></div>',
    '<div class="hooks-strip">' + flowChips + '</div>',
    '</section>',
    '<section class="hooks-section">',
    '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(selectedOverviewLifecycle) + '</div><div class="hooks-section-meta">' + escapeHtml(selectedDoc.title[currentLanguage] || selectedDoc.title.zh) + '</div></div>',
    '<div class="feature-panel-section overview-doc"><div class="markdown-body">' + renderMarkdown(selectedDoc.body[currentLanguage] || selectedDoc.body.zh) + '</div></div>',
    '</section>',
    '</div>',
  ].join('');
}

function renderMonitorPanel() {
  const activeAgent = getRuntimeAwareAgentRecord();
  const connected = activeAgent ? (activeAgent.connected !== false ? t('status_connected') : t('status_disconnected')) : t('status_no_agent');
  const overview = currentOverviewSnapshot || getEmptyOverviewSnapshot();
  const totalUsage = overview.usageStats?.totalUsage || {};
  const latestCall = getLatestCallSummary(overview);
  const currentBreakdown = getUsageBreakdown(latestCall, 0);
  const totalBreakdown = getUsageBreakdown({
    totalUsage,
    stepCount: overview.usageStats.totalRequests || 0,
    cacheHitRequests: overview.usageStats.totalCacheHitRequests || 0,
  }, overview.usageStats.totalRequests || 0);
  const contextLengthLabel = formatMetricNumber(overview.context.charCount) + ' chars';
  const latestTurnLabel = latestCall ? formatMetricNumber(currentBreakdown.totalTokens) : t('metric_no_calls');
  return [
    '<div class="hooks-panel">',
    '<section class="hooks-hero">',
    '<div class="hooks-kicker">' + escapeHtml(t('overview_kicker')) + '</div>',
    '<div class="hooks-hero-title">' + escapeHtml(t('overview_hero_title')) + '</div>',
    '<div class="hooks-hero-subtitle">' + escapeHtml(t('overview_subtitle')) + '</div>',
    '<div class="hooks-stats">',
    '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('stat_active_agent')) + '</div><div class="hooks-stat-value">' + escapeHtml(getRuntimeAwareAgentName()) + '</div></div>',
    '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('stat_context_length')) + '</div><div class="hooks-stat-value">' + escapeHtml(contextLengthLabel) + '</div></div>',
    '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('stat_turn_tokens')) + '</div><div class="hooks-stat-value">' + escapeHtml(latestTurnLabel) + '</div></div>',
    '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('stat_cache_hit_rate')) + '</div><div class="hooks-stat-value">' + escapeHtml(totalBreakdown.cacheHitRate) + '</div></div>',
    '</div>',
    '</section>',
    '<section class="hooks-section">',
    '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('panel_runtime')) + '</div><div class="hooks-section-meta">' + escapeHtml(connected) + '</div></div>',
    '<div class="overview-usage-grid">',
    renderUsageCard(t('panel_current_turn'), latestCall ? t('metric_latest_turn') : t('metric_no_calls'), currentBreakdown),
    renderCacheCard(t('panel_current_turn'), currentBreakdown),
    renderUsageCard(t('panel_session_total'), t('metric_session_total'), totalBreakdown),
    renderCacheCard(t('panel_session_total'), totalBreakdown),
    '</div>',
    '</section>',
    '<section class="hooks-section">',
    '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('panel_context')) + '</div><div class="hooks-section-meta">' + escapeHtml(t('panel_connection')) + ': ' + escapeHtml(connected) + '</div></div>',
    '<div class="context-chip-grid">',
    renderContextChip(t('metric_messages'), formatMetricNumber(overview.context.messageCount), t('panel_context')),
    renderContextChip(t('metric_chars'), formatMetricNumber(overview.context.charCount), t('stat_context_length')),
    renderContextChip(t('metric_turns'), formatMetricNumber(overview.context.turnCount), t('metric_session_total')),
    renderContextChip(t('metric_tool_calls'), formatMetricNumber(overview.context.toolCallCount), t('metric_latest_turn')),
    '</div>',
    '</section>',
    '</div>',
  ].join('');
}

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

// ═══════════════════════════════════════════════════════════════
// 面板入口
// ═══════════════════════════════════════════════════════════════

function renderFeaturePanel() {
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
    featurePanel.classList.remove('open');
    featurePanelTitle.textContent = t('panel_structure');
    featurePanelBody.innerHTML = getFeaturePanelEmptyHtml();
    railButtons.forEach(button => button.classList.remove('active'));
    return;
  }

  const panel = featurePanels[activeFeaturePanel];
  featurePanel.classList.add('open');
  featurePanel.style.setProperty('--feature-panel-width', featurePanelWidth + 'px');
  featurePanelTitle.textContent = typeof panel.title === 'function' ? panel.title() : panel.title;

  // ── 滚动位置保持：innerHTML 替换会重置所有 scrollTop ──
  const _savedBodyScrollTop = featurePanelBody.scrollTop;
  // .feature-detail-window 是 Feature 详情弹窗的独立滚动容器
  const _oldDetailWindow = featurePanelBody.querySelector('.feature-detail-window');
  const _savedDetailScrollTop = _oldDetailWindow ? _oldDetailWindow.scrollTop : 0;

  featurePanelBody.innerHTML = panel.render();
  enhanceMathInElement(featurePanelBody);
  railButtons.forEach(button => {
    button.classList.toggle('active', button.dataset.panel === activeFeaturePanel);
  });

  // 恢复滚动位置
  featurePanelBody.scrollTop = _savedBodyScrollTop;
  const _newDetailWindow = featurePanelBody.querySelector('.feature-detail-window');
  if (_newDetailWindow) _newDetailWindow.scrollTop = _savedDetailScrollTop;

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
}

function toggleFeaturePanel(panelId) {
  const wasOpen = activeFeaturePanel === panelId;
  activeFeaturePanel = wasOpen ? null : panelId;
  renderFeaturePanel();
  // 初始化钩子：settings 面板首次打开时加载异步数据
  if (!wasOpen && panelId === 'settings' && window._wgSettingsInit) {
    window._wgSettingsInit();
  }
}
