/**
 * chat-context-bar.js — 上下文栏与弹窗模块（从 app-ui.js 域 C 提取）
 *
 * 包含：
 *   - updateChatContextBar: 上下文栏主渲染（模型名、token 进度条）
 *   - CCB hover popup: token 详情弹窗（hover chat-context-bar 触发）
 *   - Title hover popup: 会话元数据弹窗（hover #current-agent-name 触发）
 *
 * 依赖（全局）：
 *   - shouldRenderWorkspaceSurface, isChatSurfaceActive (app-ui.js 域 A)
 *   - notifyChatViewportMutation (app-ui.js 域 N)
 *   - getRuntimeAwareAgentRecord (app-ui.js 域 B)
 *   - getCurrentRuntimeRecord, getCurrentHostAgentRecord (app-main.js)
 *   - getSessionContextLength, getSessionCompressRatio (session-ui.js)
 *   - escapeHtml (app-ui.js 域 O)
 *   - formatRelativeTime, formatWorkspaceDate (app-core.js)
 *   - currentOverviewSnapshot, followLatestEnabled, currentLanguage, container (app-core.js 全局状态)
 */

function updateChatContextBar() {
  var bar = document.getElementById('chat-context-bar');
  if (!bar) return;
  var prevHtml = bar.innerHTML;
  var wasHidden = bar.classList.contains('hidden');

  // 跟 chat-process-toggle 同一逻辑：非聊天界面时隐藏
  if (shouldRenderWorkspaceSurface()) {
    bar.classList.add('hidden');
    if (!wasHidden && typeof notifyChatViewportMutation === 'function') {
      notifyChatViewportMutation({
        reason: 'context-bar',
        shouldFollow: false,
        preserveTop: container.scrollTop,
        forceSnap: false,
        allowChase: false,
      });
    }
    return;
  }
  bar.classList.remove('hidden');

  var agent = getRuntimeAwareAgentRecord();
  if (!agent) {
    bar.innerHTML = '';
    if ((prevHtml !== bar.innerHTML || wasHidden !== bar.classList.contains('hidden')) && typeof notifyChatViewportMutation === 'function') {
        notifyChatViewportMutation({
          reason: 'context-bar',
          shouldFollow: followLatestEnabled && isChatSurfaceActive(),
          preserveTop: followLatestEnabled ? null : container.scrollTop,
          forceSnap: false,
          allowChase: false,
          preferSmooth: false,
        });
    }
    return;
  }

  // 找到当前活跃会话
  var sessions = agent.workspace_sessions && agent.workspace_sessions.sessions || [];
  var activeId = (agent.workspace_sessions && agent.workspace_sessions.activeSessionId)
    || agent.active_workspace_session_id;
  var activeSession = activeId
    ? sessions.find(function(s) { return s.id === activeId; })
    : (sessions[0] || null);

  // token 用量：在有活跃 runtime 时始终优先使用 overview 实时数据。
  // runtime 进程始终服务于当前激活的会话（chat surface 下由
  // loadAgentData / reloadRuntimeForSessionSwitch 保证），所以 overview
  // 总是反映正确会话的用量。不再依赖 runtimeBoundToSession 判定——
  // 该判定依赖 allAgents 中异步刷新的 active_workspace_session_id，
  // 会在 poll 周期间波动，导致用量在两个值之间反复跳动。
  var used = 0;
  var isLastRequest = false;
  var runtimeRecord = typeof getCurrentRuntimeRecord === 'function' ? getCurrentRuntimeRecord() : null;

  // 模型名：有 runtime 时优先从 overview 实时取，回退到 session 元数据
  var modelName = '';
  if (runtimeRecord && currentOverviewSnapshot && currentOverviewSnapshot.modelName) {
    modelName = currentOverviewSnapshot.modelName;
  }
  if (!modelName && activeSession) {
    modelName = activeSession.modelName || '';
  }

  if (runtimeRecord) {
    var liveUsage = currentOverviewSnapshot && currentOverviewSnapshot.usageStats && currentOverviewSnapshot.usageStats.lastRequestUsage;
    if (liveUsage && liveUsage.inputTokens) {
      used = liveUsage.inputTokens;
      isLastRequest = true;
    }
  }
  if (!used && activeSession && activeSession.tokenUsage) {
    var lr = activeSession.tokenUsage.lastRequestUsage;
    if (lr && lr.inputTokens) {
      used = lr.inputTokens;
      isLastRequest = true;
    } else {
      used = activeSession.tokenUsage.totalTokens || 0;
    }
  }

  // context length
  var contextLength = getSessionContextLength(activeSession, agent);
  var compressRatio = getSessionCompressRatio(activeSession, agent);

  // 阈限占比：当前用量占压缩阈值的比例（而非全窗口）
  var thresholdTokens = contextLength > 0 ? Math.round(contextLength * compressRatio / 100) : 0;
  var thresholdPct = thresholdTokens > 0 ? Math.round((used / thresholdTokens) * 100) : 0;

  var html = '';
  if (modelName) {
    html += '<span class="ccb-model">' + escapeHtml(modelName) + '</span>';
  }
  if (contextLength > 0) {
    var pct = used > 0 ? Math.min(100, Math.round((used / contextLength) * 100)) : 0;
    // 进度条颜色按阈限占比分三段：<70% green, 70-100% amber, ≥100% red
    var tone = thresholdPct >= 100 ? 'compress' : thresholdPct >= 70 ? 'mid' : 'low';
    var label = (used > 0 && !isLastRequest)
      ? pct + '% (\u7d2f\u79ef)'
      : pct + '%';
    html += '<span class="ccb-token tone-' + tone + '">'
      + '<span class="ccb-bar"><span class="ccb-compress-zone" style="left:' + compressRatio + '%"></span><span class="ccb-fill" style="width:' + pct + '%"></span></span>'
      + '<span class="ccb-label">' + label + '</span>'
      + '</span>';
  }

  // 存储详细数据供 hover popup 使用
  var detailData = { modelName: modelName || '', used: used, contextLength: contextLength, compressRatio: compressRatio, isLastRequest: isLastRequest };
  var totalUsage = (currentOverviewSnapshot && currentOverviewSnapshot.usageStats && currentOverviewSnapshot.usageStats.totalUsage) || {};
  var lastReq = null;
  if (runtimeRecord) {
    lastReq = currentOverviewSnapshot && currentOverviewSnapshot.usageStats && currentOverviewSnapshot.usageStats.lastRequestUsage;
  }
  if (!lastReq && activeSession && activeSession.tokenUsage) {
    lastReq = activeSession.tokenUsage.lastRequestUsage || null;
  }
  detailData.totalInput = totalUsage.inputTokens || 0;
  detailData.totalOutput = totalUsage.outputTokens || 0;
  detailData.cacheCreation = totalUsage.cacheCreationTokens || 0;
  detailData.cacheRead = totalUsage.cacheReadTokens || 0;
  detailData.reasoningTokens = totalUsage.reasoningTokens || 0;
  detailData.lastRequestUsage = lastReq;
  detailData.totalRequests = (currentOverviewSnapshot && currentOverviewSnapshot.usageStats && currentOverviewSnapshot.usageStats.totalRequests) || 0;
  window._ccbDetailData = detailData;

  // 检查阈限压力等级，在等级跨越时触发 Toast 提醒
  if (activeId) {
    _checkContextPressureToast(activeId, thresholdPct);
  }

  bar.innerHTML = html;
  if ((prevHtml !== bar.innerHTML || wasHidden !== bar.classList.contains('hidden')) && typeof notifyChatViewportMutation === 'function') {
    notifyChatViewportMutation({
      reason: 'context-bar',
      shouldFollow: followLatestEnabled && isChatSurfaceActive(),
      preserveTop: followLatestEnabled ? null : container.scrollTop,
      forceSnap: false,
      allowChase: false,
      preferSmooth: false,
    });
  }
}

// ── Context pressure toast trigger ──
// Per-session 压力等级：0 (安全), 1 (警告 ≥70%), 2 (超限 ≥100%)
var _ctxPressureLevel = {};

function _checkContextPressureToast(sessionId, thresholdPct) {
  if (!sessionId || typeof ClawToast === 'undefined') return;
  var newLevel = thresholdPct >= 100 ? 2 : thresholdPct >= 70 ? 1 : 0;
  var prevLevel = _ctxPressureLevel[sessionId] || 0;
  if (newLevel === prevLevel) return;

  _ctxPressureLevel[sessionId] = newLevel;

  var isZh = typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';
  var toastId = 'ctx-pressure-' + sessionId;

  if (newLevel === 1) {
    ClawToast.show({
      id: toastId,
      status: 'warning',
      title: isZh ? '上下文即将达到压缩阈值' : 'Context Approaching Compression Threshold',
      description: isZh
        ? '当前用量已达压缩阈值的 ' + thresholdPct + '%。可考虑使用 trim、summary 或 branch 接续新会话，以节省上下文开销。'
        : 'Usage at ' + thresholdPct + '% of compression threshold. Consider trim, summary, or branch to save context.',
    });
  } else if (newLevel === 2) {
    ClawToast.show({
      id: toastId,
      status: 'error',
      title: isZh ? '已超过压缩阈值' : 'Compression Threshold Exceeded',
      description: isZh
        ? '当前用量已达压缩阈值的 ' + thresholdPct + '%。强烈建议立即执行 trim、summary 或 branch，否则上下文开销将大幅增加。'
        : 'Usage at ' + thresholdPct + '% of compression threshold. Strongly recommended to trim, summary, or branch immediately.',
    });
  } else {
    // 用量回落到安全区，静默清除
    ClawToast.dismiss(toastId);
  }
}

// ── Context bar hover popup ──
var _ccbPopup = null;
var _ccbPopupHideTimer = null;
var _ccbPopupShowTimer = null;

function _formatTokens(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function _buildCcbPopupHtml(d) {
  var isZh = currentLanguage === 'zh';
  var cr = (Number.isFinite(d.compressRatio) && d.compressRatio > 0) ? d.compressRatio : 80;
  var pct = d.contextLength > 0 ? Math.min(100, Math.round((d.used / d.contextLength) * 100)) : 0;
  var tone = pct >= cr ? 'compress' : pct < 50 ? 'low' : 'high';

  // 阈限占比：当前用量占压缩阈值的比例
  var thresholdTokens = d.contextLength > 0 ? Math.round(d.contextLength * cr / 100) : 0;
  var thresholdPct = thresholdTokens > 0 ? Math.round((d.used / thresholdTokens) * 100) : 0;
  var thresholdTone = thresholdPct >= 100 ? 'compress' : thresholdPct >= 70 ? 'mid' : 'low';

  var sections = [];

  // ── Model ──
  if (d.modelName) {
    sections.push('<div class="ccb-popup-model">' + escapeHtml(d.modelName) + '</div>');
  }

  // ── Context section ──
  var ctxRows = [];
  if (d.contextLength > 0) {
    ctxRows.push('<div class="ccb-popup-row"><span class="ccb-popup-label">' + (isZh ? '上下文窗口' : 'Context Window') + '</span><span class="ccb-popup-value">' + _formatTokens(d.contextLength) + '</span></div>');
    ctxRows.push('<div class="ccb-popup-row"><span class="ccb-popup-label">' + (isZh ? '压缩阈值' : 'Compress At') + '</span><span class="ccb-popup-value">' + cr + '% (' + _formatTokens(thresholdTokens) + ')</span></div>');
  }
  if (d.used > 0) {
    ctxRows.push('<div class="ccb-popup-row"><span class="ccb-popup-label">' + (isZh ? '当前用量' : 'Current Usage') + '</span><span class="ccb-popup-value ccb-popup-tone-' + tone + '">' + _formatTokens(d.used) + ' (' + pct + '%)</span></div>');
    if (thresholdTokens > 0) {
      ctxRows.push('<div class="ccb-popup-row"><span class="ccb-popup-label">' + (isZh ? '阈限进度' : 'Threshold Usage') + '</span><span class="ccb-popup-value ccb-popup-tone-' + thresholdTone + '">' + Math.min(999, thresholdPct) + '%</span></div>');
    }
  }
  if (ctxRows.length) {
    sections.push('<div class="ccb-popup-section">' + ctxRows.join('') + '</div>');
  }

  // ── Token details section ──
  var detailRows = [];
  if (d.lastRequestUsage) {
    var lr = d.lastRequestUsage;
    var lrParts = [];
    if (lr.inputTokens) lrParts.push((isZh ? '入 ' : 'in ') + _formatTokens(lr.inputTokens));
    if (lr.outputTokens) lrParts.push((isZh ? '出 ' : 'out ') + _formatTokens(lr.outputTokens));
    if (lr.cacheCreationTokens) lrParts.push((isZh ? '缓存写 ' : 'cw ') + _formatTokens(lr.cacheCreationTokens));
    if (lr.cacheReadTokens) lrParts.push((isZh ? '缓存读 ' : 'cr ') + _formatTokens(lr.cacheReadTokens));
    if (lrParts.length) {
      detailRows.push('<div class="ccb-popup-row"><span class="ccb-popup-label">' + (isZh ? '最近请求' : 'Last Request') + '</span><span class="ccb-popup-value ccb-popup-mono">' + escapeHtml(lrParts.join(' · ')) + '</span></div>');
    }
  }
  if (d.totalInput || d.totalOutput) {
    detailRows.push('<div class="ccb-popup-row"><span class="ccb-popup-label">' + (isZh ? '累计' : 'Total') + '</span><span class="ccb-popup-value ccb-popup-mono">' + (isZh ? '入 ' : 'in ') + _formatTokens(d.totalInput) + ' · ' + (isZh ? '出 ' : 'out ') + _formatTokens(d.totalOutput) + '</span></div>');
  }
  if (d.cacheRead) {
    detailRows.push('<div class="ccb-popup-row"><span class="ccb-popup-label">' + (isZh ? '缓存读取' : 'Cache Read') + '</span><span class="ccb-popup-value ccb-popup-mono">' + _formatTokens(d.cacheRead) + '</span></div>');
  }
  if (d.reasoningTokens) {
    detailRows.push('<div class="ccb-popup-row"><span class="ccb-popup-label">' + (isZh ? '推理' : 'Reasoning') + '</span><span class="ccb-popup-value ccb-popup-mono">' + _formatTokens(d.reasoningTokens) + '</span></div>');
  }
  if (d.totalRequests) {
    detailRows.push('<div class="ccb-popup-row"><span class="ccb-popup-label">' + (isZh ? '请求次数' : 'Requests') + '</span><span class="ccb-popup-value">' + d.totalRequests + '</span></div>');
  }
  if (detailRows.length) {
    sections.push('<div class="ccb-popup-divider"></div>');
    sections.push('<div class="ccb-popup-section">' + detailRows.join('') + '</div>');
  }

  if (!sections.length) return '';
  return '<div class="ccb-popup-inner">' + sections.join('') + '</div>';
}

function _showCcbPopup() {
  var bar = document.getElementById('chat-context-bar');
  if (!bar || bar.classList.contains('hidden') || !bar.innerHTML.trim()) return;
  var d = window._ccbDetailData;
  if (!d) return;
  var html = _buildCcbPopupHtml(d);
  if (!html) return;

  if (!_ccbPopup) {
    _ccbPopup = document.createElement('div');
    _ccbPopup.className = 'ccb-popup';
    _ccbPopup.addEventListener('mouseenter', function() {
      if (_ccbPopupHideTimer) { clearTimeout(_ccbPopupHideTimer); _ccbPopupHideTimer = null; }
    });
    _ccbPopup.addEventListener('mouseleave', function() {
      _scheduleHideCcbPopup();
    });
    document.body.appendChild(_ccbPopup);
  }
  _ccbPopup.innerHTML = html;
  var rect = bar.getBoundingClientRect();
  _ccbPopup.style.left = rect.left + 'px';
  _ccbPopup.style.top = (rect.bottom + 4) + 'px';
  _ccbPopup.classList.add('visible');
}

function _hideCcbPopup() {
  if (_ccbPopup) _ccbPopup.classList.remove('visible');
}

function _scheduleShowCcbPopup() {
  if (_ccbPopupHideTimer) { clearTimeout(_ccbPopupHideTimer); _ccbPopupHideTimer = null; }
  if (_ccbPopupShowTimer) clearTimeout(_ccbPopupShowTimer);
  _ccbPopupShowTimer = setTimeout(function() { _showCcbPopup(); _ccbPopupShowTimer = null; }, 200);
}

function _scheduleHideCcbPopup() {
  if (_ccbPopupShowTimer) { clearTimeout(_ccbPopupShowTimer); _ccbPopupShowTimer = null; }
  if (_ccbPopupHideTimer) clearTimeout(_ccbPopupHideTimer);
  _ccbPopupHideTimer = setTimeout(function() { _hideCcbPopup(); _ccbPopupHideTimer = null; }, 200);
}

function _initCcbPopup() {
  var bar = document.getElementById('chat-context-bar');
  if (!bar || bar.dataset.popupBound) return;
  bar.dataset.popupBound = '1';
  bar.addEventListener('mouseenter', function() { _scheduleShowCcbPopup(); });
  bar.addEventListener('mouseleave', function() { _scheduleHideCcbPopup(); });
}

window.addEventListener('DOMContentLoaded', _initCcbPopup);
setTimeout(_initCcbPopup, 0);


// ── Title hover popup: session metadata ───────────────────────────
var _titlePopup = null;
var _titlePopupHideTimer = null;
var _titlePopupShowTimer = null;

/**
 * Collect the active session metadata from the current agent record.
 * Uses getRuntimeAwareAgentRecord() for correct session binding —
 * same pattern as updateChatContextBar.
 */
function _collectActiveSessionMeta() {
  var agent = typeof getRuntimeAwareAgentRecord === 'function'
    ? getRuntimeAwareAgentRecord()
    : (typeof getCurrentHostAgentRecord === 'function' ? getCurrentHostAgentRecord() : null);
  if (!agent) return null;

  var activeSessionId = String(
    agent.active_workspace_session_id
    || agent.workspace_sessions?.activeSessionId
    || ''
  ).trim();

  var sessions = Array.isArray(agent.workspace_sessions?.sessions)
    ? agent.workspace_sessions.sessions
    : [];

  var session = activeSessionId
    ? sessions.find(function (s) { return s && s.id === activeSessionId; }) || null
    : null;

  return {
    session: session,
    agent: agent,
    activeSessionId: activeSessionId,
  };
}

function _buildTitlePopupHtml(meta) {
  if (!meta) return '';
  var isZh = currentLanguage === 'zh';
  var s = meta.session || {};
  var a = meta.agent || {};
  var sections = [];

  // ── Session title ──
  var fullTitle = s.title
    || a.active_workspace_session_title
    || a.active_workspace_display_name
    || a.name
    || '';
  if (fullTitle) {
    sections.push('<div class="ccb-popup-model">' + escapeHtml(fullTitle) + '</div>');
  }

  // ── Time info ──
  var timeRows = [];

  var createdAt = s.createdAt || a.created_at || null;
  if (createdAt) {
    var relCreated = formatRelativeTime(createdAt);
    var absCreated = formatWorkspaceDate(createdAt);
    timeRows.push('<div class="ccb-popup-row"><span class="ccb-popup-label">'
      + (isZh ? '创建' : 'Created')
      + '</span><span class="ccb-popup-value" title="' + escapeHtml(absCreated) + '">'
      + escapeHtml(relCreated || absCreated) + '</span></div>');
  }

  var updatedAt = s.updatedAt || null;
  if (updatedAt) {
    var relUpdated = formatRelativeTime(updatedAt);
    var absUpdated = formatWorkspaceDate(updatedAt);
    timeRows.push('<div class="ccb-popup-row"><span class="ccb-popup-label">'
      + (isZh ? '最近活动' : 'Last Active')
      + '</span><span class="ccb-popup-value" title="' + escapeHtml(absUpdated) + '">'
      + escapeHtml(relUpdated || absUpdated) + '</span></div>');
  }

  // ── Session stats ──
  var statRows = [];

  var msgCount = (typeof s.messageCount === 'number' ? s.messageCount : null)
    ?? (typeof a.message_count === 'number' ? a.message_count : null);
  if (msgCount !== null && msgCount !== undefined) {
    statRows.push('<div class="ccb-popup-row"><span class="ccb-popup-label">'
      + (isZh ? '消息数' : 'Messages')
      + '</span><span class="ccb-popup-value">' + msgCount + '</span></div>');
  }

  // Token usage
  var tu = s.tokenUsage;
  if (tu && (tu.totalTokens || tu.inputTokens || tu.outputTokens)) {
    var tokenParts = [];
    if (tu.inputTokens) tokenParts.push((isZh ? '入 ' : 'in ') + _formatTokens(tu.inputTokens));
    if (tu.outputTokens) tokenParts.push((isZh ? '出 ' : 'out ') + _formatTokens(tu.outputTokens));
    if (tokenParts.length) {
      statRows.push('<div class="ccb-popup-row"><span class="ccb-popup-label">'
        + (isZh ? '累计用量' : 'Total Tokens')
        + '</span><span class="ccb-popup-value ccb-popup-mono">' + escapeHtml(tokenParts.join(' · ')) + '</span></div>');
    }
  }

  // Session type
  var sType = s.sessionType || '';
  if (sType) {
    var typeLabels = {
      main: isZh ? '主对话' : 'Main',
      sub: isZh ? '子代理' : 'Sub-agent',
      exploration: isZh ? '探索' : 'Exploration',
      archived: isZh ? '已归档' : 'Archived',
    };
    var typeLabel = typeLabels[sType] || sType;
    statRows.push('<div class="ccb-popup-row"><span class="ccb-popup-label">'
      + (isZh ? '类型' : 'Type')
      + '</span><span class="ccb-popup-value">' + escapeHtml(typeLabel) + '</span></div>');
  }

  // Working directory
  var openDir = s.openDirectory || '';
  if (openDir) {
    statRows.push('<div class="ccb-popup-row"><span class="ccb-popup-label">'
      + (isZh ? '工作目录' : 'Directory')
      + '</span><span class="ccb-popup-value" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;" title="'
      + escapeHtml(openDir) + '">' + escapeHtml(openDir) + '</span></div>');
  }

  // Session ID (compact)
  if (meta.activeSessionId) {
    statRows.push('<div class="ccb-popup-row"><span class="ccb-popup-label">'
      + (isZh ? '会话 ID' : 'Session')
      + '</span><span class="ccb-popup-value ccb-popup-mono">' + escapeHtml(meta.activeSessionId.slice(-12)) + '</span></div>');
  }

  if (timeRows.length) {
    sections.push('<div class="ccb-popup-section">' + timeRows.join('') + '</div>');
  }
  if (statRows.length) {
    if (timeRows.length) sections.push('<div class="ccb-popup-divider"></div>');
    sections.push('<div class="ccb-popup-section">' + statRows.join('') + '</div>');
  }

  if (!sections.length) return '';
  return '<div class="ccb-popup-inner">' + sections.join('') + '</div>';
}

function _showTitlePopup() {
  var titleEl = document.getElementById('current-agent-name');
  if (!titleEl) return;
  var meta = _collectActiveSessionMeta();
  var html = _buildTitlePopupHtml(meta);
  if (!html) return;

  if (!_titlePopup) {
    _titlePopup = document.createElement('div');
    _titlePopup.className = 'ccb-popup title-hover-popup';
    _titlePopup.addEventListener('mouseenter', function () {
      if (_titlePopupHideTimer) { clearTimeout(_titlePopupHideTimer); _titlePopupHideTimer = null; }
    });
    _titlePopup.addEventListener('mouseleave', function () {
      _scheduleHideTitlePopup();
    });
    document.body.appendChild(_titlePopup);
  }
  _titlePopup.innerHTML = html;
  var rect = titleEl.getBoundingClientRect();
  _titlePopup.style.left = rect.left + 'px';
  _titlePopup.style.top = (rect.bottom + 4) + 'px';
  _titlePopup.classList.add('visible');
}

function _hideTitlePopup() {
  if (_titlePopup) _titlePopup.classList.remove('visible');
}

function _scheduleShowTitlePopup() {
  if (_titlePopupHideTimer) { clearTimeout(_titlePopupHideTimer); _titlePopupHideTimer = null; }
  if (_titlePopupShowTimer) clearTimeout(_titlePopupShowTimer);
  _titlePopupShowTimer = setTimeout(function () { _showTitlePopup(); _titlePopupShowTimer = null; }, 300);
}

function _scheduleHideTitlePopup() {
  if (_titlePopupShowTimer) { clearTimeout(_titlePopupShowTimer); _titlePopupShowTimer = null; }
  if (_titlePopupHideTimer) clearTimeout(_titlePopupHideTimer);
  _titlePopupHideTimer = setTimeout(function () { _hideTitlePopup(); _titlePopupHideTimer = null; }, 200);
}

function _initTitlePopup() {
  var titleEl = document.getElementById('current-agent-name');
  if (!titleEl || titleEl.dataset.titlePopupBound) return;
  titleEl.dataset.titlePopupBound = '1';
  titleEl.addEventListener('mouseenter', function () { _scheduleShowTitlePopup(); });
  titleEl.addEventListener('mouseleave', function () { _scheduleHideTitlePopup(); });
}

window.addEventListener('DOMContentLoaded', _initTitlePopup);
setTimeout(_initTitlePopup, 0);
