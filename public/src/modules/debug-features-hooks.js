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
          '<div class="rh-row">',
          '<span class="rh-method" title="' + escapeHtml(methodTip) + '">' + escapeHtml(entry.methodName) + '()</span>',
          '<span class="rh-feature" title="' + escapeHtml(rhLoc('提供该处理函数的 Feature', 'Feature providing this handler')) + '">' + escapeHtml(entry.featureName) + '</span>',
          '<span class="rh-kind k-' + escapeHtml(entry.kind) + '" title="' + escapeHtml(rhKindHint(entry.kind)) + '">' + escapeHtml(kindLabel) + '</span>',
          '<span class="rh-toggle">' + buildHookToggleHtml(group.lifecycle, entry.featureName, entry.methodName, entry.enabled !== false) + '</span>',
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
