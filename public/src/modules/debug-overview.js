/**
 * debug-overview.js — Overview / Monitor 渲染 + lifecycleDocs + 选择器 + Structure/Monitor 面板
 *
 * 从 debug-panels.js 拆出。包含：
 *   - Usage/Token 渲染: formatMetricNumber, formatRate, getLatestCallSummary,
 *     getUsageBreakdown, renderTokenBar, renderRateRing, renderUsageCard,
 *     renderCacheCard, renderContextChip
 *   - lifecycleDocs 常量（生命周期文档）
 *   - 选择器函数: selectOverviewLifecycle, openFeatureDetails, closeFeatureDetails,
 *     openRepositoryPackageDetails, closeRepositoryPackageDetails
 *   - 面板渲染: renderStructurePanel, renderMonitorPanel
 *
 * 依赖（全局变量，声明于 app-core.js）：
 *   - selectedOverviewLifecycle, selectedFeatureName, selectedRepositoryPackageId
 *   - activeFeaturePanel, currentLanguage, currentMessages
 *   - currentHookInspector, currentOverviewSnapshot
 *
 * 依赖（全局函数）：
 *   - escapeHtml, renderMarkdown, enhanceMathInElement (markdown-utils.js)
 *   - t (app-core.js)
 *   - getRuntimeAwareAgentRecord, getRuntimeAwareAgentName (app-ui.js)
 *   - getFeatureStatus (app-ui.js / overview-data.js)
 *   - getEmptyOverviewSnapshot (overview-data.js)
 *   - renderFeaturePanel (debug-panel-host.js, 运行时调用)
 *   - renderCurrentMainView (app-ui.js)
 */

// ═══════════════════════════════════════════════════════════════
// Usage / Token 渲染
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
// 生命周期文档常量
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
// 生命周期选择器
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
// 结构/监控 面板
// ═══════════════════════════════════════════════════════════════

function renderStructurePanel() {
  const activeAgent = getRuntimeAwareAgentRecord();
  const connected = activeAgent ? (activeAgent.connected !== false ? t('status_connected') : t('status_disconnected')) : t('status_no_agent');
  const totalHooks = currentHookInspector.hooks.reduce((sum, group) => sum + group.entries.length, 0);
  const decisionHooks = currentHookInspector.hooks.reduce(
    (sum, group) => sum + group.entries.filter(entry => entry.kind === 'guard').length,
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
