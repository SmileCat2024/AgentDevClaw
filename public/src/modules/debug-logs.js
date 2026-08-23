/**
 * debug-logs.js — 日志面板渲染
 *
 * 从 debug-panels.js 拆出。包含：
 *   - getLevelWeight, formatLogTimestamp, safePrettyJson
 *   - getFilteredLogs, renderLogsPanel
 *
 * safePrettyJson 被 renderLogsPanel 和 renderMcpPanel（debug-mcp.js）共用。
 * 本文件先于 debug-mcp.js 加载，全局作用域下后者可直接引用。
 *
 * 依赖（全局变量，声明于 app-core.js）：
 *   - logFilters, currentLogs, currentLogsTruncation
 *
 * 依赖（全局函数）：
 *   - escapeHtml, t (app-core.js)
 */

// ═══════════════════════════════════════════════════════════════
// 日志面板
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

// 单条结构化数据的渲染上限：invoke/envelope 类日志的 data 可达数百 KB 甚至更大，
// <details> 展开时浏览器要对整个 <pre> 的全部文本行做完整布局（max-height 只裁剪
// 视觉，不省布局），超大 JSON 是"展开/收起直接卡死页面"的根因。截断渲染即可根治。
const LOG_JSON_RENDER_CAP = 4000;

function buildJsonPreview(value) {
  const pretty = safePrettyJson(value);
  if (pretty.length <= LOG_JSON_RENDER_CAP) return pretty;
  return pretty.slice(0, LOG_JSON_RENDER_CAP)
    + '\n… ' + t('logs_json_truncated').replace('{total}', String(pretty.length));
}

function safePrettyJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (e) {
    return String(value);
  }
}

// 展开了结构化数据的日志条目（按日志 id，跨重渲染保持状态）
const _openLogJson = new Set();

// 点击行/箭头切换展开。不用原生 <details>：summary 必须是 details 首个子元素，
// JSON 会被迫排在 message 上方；click + class 切换可自由控制 DOM 阅读顺序
// （行 → message → meta → 展开的 JSON）。
window.logJsonToggle = (id, entryEl) => {
  if (!entryEl) return;
  if (_openLogJson.has(id)) {
    _openLogJson.delete(id);
    entryEl.classList.remove('json-open');
  } else {
    _openLogJson.add(id);
    entryEl.classList.add('json-open');
  }
};

// 列表改为内部滚动（.logf-list）后，body 不再滚动，
// 底部渐隐遮罩（.feature-panel.scrollable）改由列表滚动事件驱动。
// rAF 节流：滚动事件里同步读 scrollHeight/clientHeight 会强制布局，
// 大列表上逐事件触发会造成明显卡顿（折叠/展开后尤其明显）。
if (typeof featurePanelBody !== 'undefined' && featurePanelBody && !featurePanelBody.dataset.logScrollBound) {
  featurePanelBody.dataset.logScrollBound = '1';
  let _logScrollRaf = 0;
  featurePanelBody.addEventListener('scroll', (e) => {
    const list = e.target;
    if (!list.classList || !list.classList.contains('logf-list')) return;
    if (_logScrollRaf) return;
    _logScrollRaf = requestAnimationFrame(() => {
      _logScrollRaf = 0;
      const panel = list.closest('.feature-panel');
      if (!panel) return;
      const nearBottom = list.scrollTop + list.clientHeight < list.scrollHeight - 48;
      if (panel.classList.contains('scrollable') !== nearBottom) {
        panel.classList.toggle('scrollable', nearBottom);
      }
    });
  }, true);
}

// ── 增量渲染 ──────────────────────────────────────────────────────────
// 流式日志到达时不再整列表 innerHTML 重建——agent 活跃时每轮 poll 都有新日志，
// 全量重建数百条目是面板卡顿的根因。改为只 prepend 新条目 + 刷新统计。

const _seenLogIds = new Set();
let _renderedFilterKey = '';
const LOG_DOM_CAP = 260;

function logFilterRenderKey() {
  return JSON.stringify([logFilters.level, logFilters.feature, logFilters.lifecycle, logFilters.call, logFilters.search, currentLanguage]);
}

function markLogsSeen() {
  for (const entry of currentLogs) {
    if (entry.id != null) _seenLogIds.add(String(entry.id));
  }
  _renderedFilterKey = logFilterRenderKey();
}

function buildLogStatsHtml(filteredCount) {
  let errorCount = 0;
  let warnCount = 0;
  for (const entry of currentLogs) {
    if (entry.level === 'error') errorCount += 1;
    else if (entry.level === 'warn') warnCount += 1;
  }
  const badges = [
    errorCount > 0
      ? '<button type="button" class="logf-badge is-error" title="' + escapeHtml(t('logs_level_error')) + '" onclick="window.updateLogFilter(&quot;level&quot;,&quot;error&quot;)">' + String(errorCount) + ' error</button>'
      : '',
    warnCount > 0
      ? '<button type="button" class="logf-badge is-warn" title="' + escapeHtml(t('logs_level_warn')) + '" onclick="window.updateLogFilter(&quot;level&quot;,&quot;warn&quot;)">' + String(warnCount) + ' warn</button>'
      : '',
  ].filter(Boolean).join('');
  return '<span class="logf-count">' + String(filteredCount) + ' ' + escapeHtml(t('logs_total')) + '</span>' + badges;
}

// 尝试增量更新：列表已在 DOM、筛选/scope/语言未变、且全部条目带 id。
// 成功返回 true；任何不满足（首开、筛选变更等）返回 false 由调用方走全量渲染。
function tryIncrementalLogsUpdate() {
  if (activeFeaturePanel !== 'logs') return false;
  const list = featurePanelBody.querySelector('.logf-list');
  if (!list || _renderedFilterKey !== logFilterRenderKey()) return false;
  for (const entry of currentLogs) {
    if (entry.id == null) return false;
  }

  const fresh = currentLogs.filter((entry) => !_seenLogIds.has(String(entry.id)));
  if (fresh.length === 0) {
    const stats = featurePanelBody.querySelector('.logf-stats');
    if (stats) stats.innerHTML = buildLogStatsHtml(getFilteredLogs().length);
    return true;
  }

  const freshFiltered = fresh.filter(logEntryMatchesFilters);
  for (let i = freshFiltered.length - 1; i >= 0; i--) {
    list.insertAdjacentHTML('afterbegin', buildLogEntryHtml(freshFiltered[i]));
  }
  for (const entry of fresh) {
    _seenLogIds.add(String(entry.id));
  }
  const stats = featurePanelBody.querySelector('.logf-stats');
  if (stats) stats.innerHTML = buildLogStatsHtml(getFilteredLogs().length);

  // DOM 条目数封顶：移除最旧的（列表底部）
  let entries = list.querySelectorAll('.logf-entry');
  while (entries.length > LOG_DOM_CAP) {
    entries[entries.length - 1].remove();
    entries = list.querySelectorAll('.logf-entry');
  }
  return true;
}

// 单条日志条目 HTML（全量渲染与增量 prepend 共用）
function buildLogEntryHtml(entry) {
  const metaParts = [];
  if (entry.context?.feature) metaParts.push(escapeHtml(entry.context.feature));
  if (entry.context?.lifecycle) metaParts.push('hook: ' + escapeHtml(entry.context.lifecycle));
  if (entry.context?.hookMethod) metaParts.push(escapeHtml(entry.context.hookMethod) + '()');
  if (entry.context?.toolName) metaParts.push('tool: ' + escapeHtml(entry.context.toolName));
  // call/step 已升级为首行的轮次徽标（一等显示对象），meta 行不再重复
  const metaHtml = metaParts.length > 0
    ? '<div class="logf-meta">' + metaParts.join('<span class="logf-dot"> · </span>') + '</div>'
    : '';

  // 展开交互：click + class 切换（不用原生 details，见文件头 logJsonToggle 注释）。
  // DOM 阅读顺序：行 → message → meta → 展开的 JSON。
  const hasData = entry.data !== undefined;
  // 轮次徽标：调用轮次/步数是一等信息（比绝对时间更重要），进首行
  const callIdx = typeof entry.context?.callIndex === 'number' ? entry.context.callIndex : null;
  const stepIdx = typeof entry.context?.step === 'number' ? entry.context.step : null;
  const roundBadge = callIdx != null
    ? '<span class="logf-round" title="' + escapeHtml(
        stepIdx != null
          ? t('logf_round_title').replace('{call}', String(callIdx)).replace('{step}', String(stepIdx))
          : t('logf_round_only').replace('{call}', String(callIdx)),
      ) + '">R' + String(callIdx) + (stepIdx != null ? '.' + String(stepIdx) : '') + '</span>'
    : '';
  const entryId = entry.id != null ? String(entry.id) : '';
  const clickAttr = hasData && entryId
    ? ' onclick="window.logJsonToggle(&quot;' + escapeHtml(entryId) + '&quot;, this.closest(&quot;.logf-entry&quot;))"'
    : '';
  const lineInner = [
    '<span class="logf-level">' + escapeHtml(entry.level) + '</span>',
    roundBadge,
    '<span class="logf-ns" title="' + escapeHtml(entry.namespace) + '">' + escapeHtml(entry.namespace) + '</span>',
    '<span class="logf-time">' + escapeHtml(formatLogTimestamp(entry.timestamp)) + '</span>',
    hasData ? '<span class="logf-json-hint" title="' + escapeHtml(t('logs_details')) + '"><span class="logf-json-chev">▸</span></span>' : '',
  ].join('');
  const lineHtml = '<div class="logf-line"' + clickAttr + '>' + lineInner + '</div>';

  const jsonHtml = hasData
    ? '<pre class="logf-json">' + escapeHtml(buildJsonPreview(entry.data)) + '</pre>'
    : '';
  const openCls = hasData && entryId && _openLogJson.has(entryId) ? ' json-open' : '';

  return '<article class="logf-entry' + (hasData ? ' has-data' : '') + openCls + ' lv-' + escapeHtml(entry.level) + '">'
    + lineHtml
    + '<div class="logf-msg">' + escapeHtml(entry.message) + '</div>'
    + metaHtml
    + jsonHtml
    + '</article>';
}

// 单条日志是否命中当前筛选（增量 prepend 时逐条复用）
function logEntryMatchesFilters(entry) {
  const minLevel = logFilters.level;
  if (minLevel !== 'all' && getLevelWeight(entry.level) < getLevelWeight(minLevel)) {
    return false;
  }
  if (logFilters.feature !== 'all' && (entry.context?.feature || 'none') !== logFilters.feature) {
    return false;
  }
  if (logFilters.lifecycle !== 'all' && (entry.context?.lifecycle || 'none') !== logFilters.lifecycle) {
    return false;
  }
  if (logFilters.call !== 'all' && String(entry.context?.callIndex ?? '') !== logFilters.call) {
    return false;
  }
  const search = logFilters.search.trim().toLowerCase();
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
}

function getFilteredLogs() {
  return currentLogs.filter(logEntryMatchesFilters);
}

function renderLogsPanel() {
  const filteredLogs = getFilteredLogs().slice().reverse();
  const featureOptions = Array.from(new Set(currentLogs.map((entry) => entry.context?.feature).filter(Boolean))).sort();
  const lifecycleOptions = Array.from(new Set(currentLogs.map((entry) => entry.context?.lifecycle).filter(Boolean))).sort();
  const callOptions = Array.from(new Set(
    currentLogs.map((entry) => entry.context?.callIndex).filter((v) => typeof v === 'number'),
  )).sort((a, b) => a - b);

  const selectAttrs = ' data-claw-select data-claw-compact="true"';
  const toolbar = [
    '<section class="logf-bar">',
    '<div class="logf-row logf-row-top">',
    '<div class="logf-stats">' + buildLogStatsHtml(filteredLogs.length) + '</div>',
    '</div>',
    '<div class="logf-row logf-row-filters">',
    '<input class="logf-search" type="text" value="' + escapeHtml(logFilters.search) + '" placeholder="' + escapeHtml(t('logs_search_placeholder')) + '" oninput="window.updateLogFilter(&quot;search&quot;, this.value)">',
    '<select class="logf-select"' + selectAttrs + ' onchange="window.updateLogFilter(&quot;level&quot;, this.value)">',
    '<option value="all"' + (logFilters.level === 'all' ? ' selected' : '') + '>' + escapeHtml(t('logs_level_all')) + '</option>',
    '<option value="debug"' + (logFilters.level === 'debug' ? ' selected' : '') + '>' + escapeHtml(t('logs_level_debug')) + '</option>',
    '<option value="info"' + (logFilters.level === 'info' ? ' selected' : '') + '>' + escapeHtml(t('logs_level_info')) + '</option>',
    '<option value="warn"' + (logFilters.level === 'warn' ? ' selected' : '') + '>' + escapeHtml(t('logs_level_warn')) + '</option>',
    '<option value="error"' + (logFilters.level === 'error' ? ' selected' : '') + '>' + escapeHtml(t('logs_level_error')) + '</option>',
    '</select>',
    '<select class="logf-select"' + selectAttrs + ' onchange="window.updateLogFilter(&quot;feature&quot;, this.value)">',
    '<option value="all"' + (logFilters.feature === 'all' ? ' selected' : '') + '>' + escapeHtml(t('logs_feature_all')) + '</option>',
    featureOptions.map((feature) => '<option value="' + escapeHtml(feature) + '"' + (logFilters.feature === feature ? ' selected' : '') + '>' + escapeHtml(feature) + '</option>').join(''),
    '</select>',
    '<select class="logf-select"' + selectAttrs + ' onchange="window.updateLogFilter(&quot;lifecycle&quot;, this.value)">',
    '<option value="all"' + (logFilters.lifecycle === 'all' ? ' selected' : '') + '>' + escapeHtml(t('logs_lifecycle_all')) + '</option>',
    lifecycleOptions.map((lifecycle) => '<option value="' + escapeHtml(lifecycle) + '"' + (logFilters.lifecycle === lifecycle ? ' selected' : '') + '>' + escapeHtml(lifecycle) + '</option>').join(''),
    '</select>',
    '<select class="logf-select logf-call"' + selectAttrs + ' onchange="window.updateLogFilter(&quot;call&quot;, this.value)">',
    '<option value="all"' + (logFilters.call === 'all' ? ' selected' : '') + '>' + escapeHtml(t('logf_call_all')) + '</option>',
    callOptions.map((idx) => '<option value="' + String(idx) + '"' + (logFilters.call === String(idx) ? ' selected' : '') + '>R' + String(idx) + '</option>').join(''),
    '</select>',
    '</div>',
    '</section>',
  ].join('');

  // 标记当前数据集为已见：后续流式新增才能走增量 prepend
  markLogsSeen();

  if (filteredLogs.length === 0) {
    return '<div class="log-panel">' + toolbar + '<div class="feature-panel-empty"><div>' + escapeHtml(t('logs_empty')) + '</div></div></div>';
  }

  const rows = filteredLogs.map(buildLogEntryHtml).join('');

  const trunc = currentLogsTruncation;
  const truncHtml = (trunc && trunc.truncated)
    ? '<div class="logf-truncated">' + escapeHtml(t('logs_truncated')
        .replace('{returned}', String(trunc.returnedCount))
        .replace('{available}', String(trunc.availableCount))) + '</div>'
    : '';

  return '<div class="log-panel">' + toolbar + '<section class="logf-list">' + rows + truncHtml + '</section></div>';
}

// ── loadLogs (from app-main.js) ──
async function loadLogs(forceRender = false) {
  try {
    const params = new URLSearchParams({
      scope: 'current',
    });
    const runtimeId = getRuntimeId(currentRuntimeAgentId);
    if (!runtimeId) {
      if (forceRender && activeFeaturePanel === 'logs') {
        currentLogsTruncation = null;
        setCurrentLogs([]);
        renderFeaturePanel();
      }
      return;
    }
    params.set('agentId', runtimeId);

    const res = await fetch('/api/logs?' + params.toString());
    if (!res.ok) {
      throw new Error('Failed to fetch logs');
    }
    const data = await res.json();
    const nextLogs = data.logs || [];
    const nextSignature = JSON.stringify({
      count: nextLogs.length,
      last: nextLogs.length > 0 ? nextLogs[nextLogs.length - 1].id : null,
    });

    if (nextSignature !== currentLogsSignature) {
      currentLogsTruncation = data.truncation || null;
      setCurrentLogs(nextLogs);
      if (activeFeaturePanel === 'logs') {
        // 流式新增优先增量 prepend（卡顿根治的关键）；
        // 首开、筛选/scope 变更等场景由 tryIncrementalLogsUpdate 判定不满足后回退全量
        if (!tryIncrementalLogsUpdate()) {
          renderFeaturePanel();
        }
      }
    } else if (forceRender && activeFeaturePanel === 'logs') {
      currentLogsTruncation = data.truncation || null;
      renderFeaturePanel();
    }
  } catch (e) {
    if (forceRender && activeFeaturePanel === 'logs') {
      currentLogsTruncation = null;
      setCurrentLogs([]);
      renderFeaturePanel();
    }
  }
}
