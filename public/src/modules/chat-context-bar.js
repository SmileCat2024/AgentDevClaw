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
 *   - getCurrentHostAgentRecord (app-main.js)
 *   - escapeHtml (app-ui.js 域 O)
 *   - formatRelativeTime, formatWorkspaceDate (app-core.js)
 *   - readCurrentSessionViewState (session-view-state.js)
 *   - followLatestEnabled, currentLanguage, container (app-core.js 全局状态)
 *   - loadAgents (sidebar-render.js), updateInputModelSwitcher (persistent-input.js)
 */

function updateChatContextBar(viewState = readCurrentSessionViewState()) {
  let bar = document.getElementById('chat-context-bar');
  if (!bar) return;
  let prevHtml = bar.innerHTML;
  let wasHidden = bar.classList.contains('hidden');

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

  // Gate 与数据源解耦（T21-E）：agent record 缺失（远程会话不在 allAgents）
  // 不再清空整条 bar——overview 活源数据已进 viewState，模型名/用量应照常
  // 渲染。是否真无数据的判定推迟到渲染前：仅当模型名、用量全空且
  // contextLength 为 0 时才维持空态呈现。
  let agent = getRuntimeAwareAgentRecord();

  // 找到当前活跃会话（agent 可能为 null——远程会话不在 allAgents，读取需 null 安全）
  let sessions = agent && agent.workspace_sessions && agent.workspace_sessions.sessions || [];
  let activeId = (agent && agent.workspace_sessions && agent.workspace_sessions.activeSessionId)
    || (agent && agent.active_workspace_session_id);
  let activeSession = activeId
    ? sessions.find(function(s) { return s.id === activeId; })
    : (sessions[0] || null);

  // token 用量：在有活跃 runtime 时始终优先使用 overview 实时数据。
  // runtime 进程始终服务于当前激活的会话（chat surface 下由
  // loadAgentData / reloadRuntimeForSessionSwitch 保证），所以 overview
  // 总是反映正确会话的用量。不再依赖 runtimeBoundToSession 判定——
  // 该判定依赖 allAgents 中异步刷新的 active_workspace_session_id，
  // 会在 poll 周期间波动，导致用量在两个值之间反复跳动。
  let used = 0;
  let isLastRequest = false;
  let overview = viewState && viewState.overview || {};

  // 模型名：overview 实时优先，回退到 session 元数据
  let modelName = '';
  if (overview.modelName) {
    modelName = overview.modelName;
  }
  if (!modelName && activeSession) {
    modelName = activeSession.modelName || '';
  }

  let liveUsage = overview.usageStats && overview.usageStats.lastRequestUsage;
  if (liveUsage && liveUsage.inputTokens) {
    used = liveUsage.inputTokens;
    isLastRequest = true;
  }
  if (!used && activeSession && activeSession.tokenUsage) {
    let lr = activeSession.tokenUsage.lastRequestUsage;
    if (lr && lr.inputTokens) {
      used = lr.inputTokens;
      isLastRequest = true;
    } else {
      used = activeSession.tokenUsage.totalTokens || 0;
    }
  }

  // contextLength / compressRatio 只走 overview 实时链路（模型热切换后立即反映）。
  // 不回退到 session 元数据——该旁路读取的是会话创建时写入的旧值，热切换后不更新，
  // 是历史上 context bar 显示不匹配的根源。overview 无 contextLength 时进度条不渲染。
  let contextLength = (overview.contextLength != null && overview.contextLength > 0)
    ? overview.contextLength
    : 0;
  let compressRatio = (overview.compressRatio != null && overview.compressRatio > 0)
    ? overview.compressRatio
    : 80;

  // 阈限占比：当前用量占压缩阈值的比例（而非全窗口）
  let thresholdTokens = contextLength > 0 ? Math.round(contextLength * compressRatio / 100) : 0;
  let thresholdPct = thresholdTokens > 0 ? Math.round((used / thresholdTokens) * 100) : 0;

  // 过界提示 chip（压力驱动：≥100% 出现，回落消失），与下方进度条同源。
  if (typeof syncContextPressureChip === 'function') syncContextPressureChip(thresholdPct);

  let html = '';
  if (modelName) {
    html += '<span class="ccb-model">' + escapeHtml(modelName) + '</span>';
  }
  if (contextLength > 0) {
    let pct = used > 0 ? Math.min(100, Math.round((used / contextLength) * 100)) : 0;
    // 进度条颜色按阈限占比分三段：<70% green, 70-100% amber, ≥100% red
    let tone = thresholdPct >= 100 ? 'compress' : thresholdPct >= 70 ? 'mid' : 'low';
    let label = (used > 0 && !isLastRequest)
      ? pct + '% (\u7d2f\u79ef)'
      : pct + '%';
    html += '<span class="ccb-token tone-' + tone + '">'
      + '<span class="ccb-bar"><span class="ccb-compress-zone" style="left:' + compressRatio + '%"></span><span class="ccb-fill" style="width:' + pct + '%"></span></span>'
      + '<span class="ccb-label">' + label + '</span>'
      + '</span>';
  }

  // 存储详细数据供 hover popup 使用
  let detailData = { modelName: modelName || '', used: used, contextLength: contextLength, compressRatio: compressRatio, isLastRequest: isLastRequest };
  let totalUsage = (overview.usageStats && overview.usageStats.totalUsage) || {};
  let lastReq = overview.usageStats && overview.usageStats.lastRequestUsage || null;
  if (!lastReq && activeSession && activeSession.tokenUsage) {
    lastReq = activeSession.tokenUsage.lastRequestUsage || null;
  }
  detailData.totalInput = totalUsage.inputTokens || 0;
  detailData.totalOutput = totalUsage.outputTokens || 0;
  detailData.cacheCreation = totalUsage.cacheCreationTokens || 0;
  detailData.cacheRead = totalUsage.cacheReadTokens || 0;
  detailData.reasoningTokens = totalUsage.reasoningTokens || 0;
  detailData.lastRequestUsage = lastReq;
  detailData.totalRequests = (overview.usageStats && overview.usageStats.totalRequests) || 0;
  window._ccbDetailData = detailData;

  // 检查阈限压力等级，在等级跨越时触发 Toast 提醒
  if (activeId) {
    _checkContextPressureToast(activeId, thresholdPct);
  }

  // 真·空数据 gate（T21-E）：模型名与用量全空且 contextLength 为 0 才清空
  // bar（与既有空态呈现一致）；否则 overview 活源已足够渲染。
  if (!modelName && !used && contextLength === 0) {
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
let _ctxPressureLevel = {};

function _checkContextPressureToast(sessionId, thresholdPct) {
  // [临时屏蔽] 用量压力 Toast 通知 — 需要恢复时改为 true
  var _ctxPressureToastEnabled = false;
  if (!_ctxPressureToastEnabled) return;
  if (!sessionId || typeof ClawToast === 'undefined') return;
  let newLevel = thresholdPct >= 100 ? 2 : thresholdPct >= 70 ? 1 : 0;
  let prevLevel = _ctxPressureLevel[sessionId] || 0;
  if (newLevel === prevLevel) return;

  _ctxPressureLevel[sessionId] = newLevel;

  let isZh = typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';
  let toastId = 'ctx-pressure-' + sessionId;

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
let _ccbPopup = null;
let _ccbPopupHideTimer = null;
let _ccbPopupShowTimer = null;

function _formatTokens(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function _buildCcbPopupHtml(d) {
  let isZh = currentLanguage === 'zh';
  let cr = (Number.isFinite(d.compressRatio) && d.compressRatio > 0) ? d.compressRatio : 80;
  let pct = d.contextLength > 0 ? Math.min(100, Math.round((d.used / d.contextLength) * 100)) : 0;
  let tone = pct >= cr ? 'compress' : pct < 50 ? 'low' : 'high';

  // 阈限占比：当前用量占压缩阈值的比例
  let thresholdTokens = d.contextLength > 0 ? Math.round(d.contextLength * cr / 100) : 0;
  let thresholdPct = thresholdTokens > 0 ? Math.round((d.used / thresholdTokens) * 100) : 0;
  let thresholdTone = thresholdPct >= 100 ? 'compress' : thresholdPct >= 70 ? 'mid' : 'low';

  let sections = [];

  // ── Model ──
  if (d.modelName) {
    sections.push('<div class="ccb-popup-model">' + escapeHtml(d.modelName) + '</div>');
  }

  // ── Context section ──
  let ctxRows = [];
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
  let detailRows = [];
  if (d.lastRequestUsage) {
    let lr = d.lastRequestUsage;
    let lrParts = [];
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
  let bar = document.getElementById('chat-context-bar');
  if (!bar || bar.classList.contains('hidden') || !bar.innerHTML.trim()) return;
  let d = window._ccbDetailData;
  if (!d) return;
  let html = _buildCcbPopupHtml(d);
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
  let rect = bar.getBoundingClientRect();
  _ccbPopup.style.left = rect.left + 'px';
  _ccbPopup.style.top = (rect.bottom + 8) + 'px';
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
  let bar = document.getElementById('chat-context-bar');
  if (!bar || bar.dataset.popupBound) return;
  bar.dataset.popupBound = '1';
  bar.addEventListener('mouseenter', function() { _scheduleShowCcbPopup(); });
  bar.addEventListener('mouseleave', function() { _scheduleHideCcbPopup(); });
  bar.addEventListener('click', function(e) {
    // Click on context bar → open model preset dropdown instead of hover popup
    e.preventDefault();
    e.stopPropagation();
    // Cancel hover popup
    if (_ccbPopupShowTimer) { clearTimeout(_ccbPopupShowTimer); _ccbPopupShowTimer = null; }
    _hideCcbPopup();
    _toggleModelDropdown();
  });
}

window.addEventListener('DOMContentLoaded', _initCcbPopup);
setTimeout(_initCcbPopup, 0);


// ── Model preset dropdown (click to swap) ────────────────────────
let _modelDropdown = null;

function _closeModelDropdown() {
  if (_modelDropdown) {
    _modelDropdown.classList.remove('visible');
    setTimeout(function() {
      if (_modelDropdown) { _modelDropdown.remove(); _modelDropdown = null; }
    }, 150);
  }
}

function _getCurrentAgentIdForSwap() {
  // Model swap is keyed on the HOST agent ID (e.g. 'programming-helper'),
  // not the ViewerWorker child UUID. Config file and IPC delivery both
  // use the host ID. See _getInputAgentId() for full rationale.
  if (typeof focusedAgentId !== 'undefined' && focusedAgentId) return focusedAgentId;
  if (typeof getCurrentHostAgentRecord === 'function') {
    let host = getCurrentHostAgentRecord();
    if (host && host.id) return host.id;
  }
  if (typeof getCurrentAgentRecord === 'function') {
    let agent = getCurrentAgentRecord();
    if (agent && agent.id) return agent.id;
  }
  return null;
}

function _getCurrentDefaultPresetName() {
  let agent = typeof getRuntimeAwareAgentRecord === 'function'
    ? getRuntimeAwareAgentRecord()
    : null;
  if (!agent) return '';
  let modelPresets = agent.modelPresets || {};
  let defaultCfg = modelPresets.default || {};
  if (typeof defaultCfg === 'string') return defaultCfg;
  return (defaultCfg && defaultCfg.primary) || '';
}

// preset 列表按会话命名空间拉取（ADR-0011）：agentId 始终携带当前会话身份，
// 远程会话返回远程自己的 preset 列表；缓存按会话身份失效，防切换串列表。
function _presetCacheMatchesCurrentSession() {
  let runtimeId = (typeof currentRuntimeAgentId !== 'undefined' && currentRuntimeAgentId) || '';
  return typeof window.ClawFW === 'object' && window.ClawFW
    && Array.isArray(window.ClawFW._modelPresets)
    && window.ClawFW._modelPresets.length > 0
    && window.ClawFW._modelPresetsRuntimeId === runtimeId;
}

async function _fetchPresetsForCurrentSession() {
  let runtimeId = (typeof currentRuntimeAgentId !== 'undefined' && currentRuntimeAgentId) || '';
  const resp = await fetch('/protoclaw/model_config' + (runtimeId ? '?agentId=' + encodeURIComponent(runtimeId) : ''));
  const data = await resp.json();
  const presets = Array.isArray(data && data.presets) ? data.presets : [];
  if (typeof window.ClawFW === 'object' && window.ClawFW) {
    window.ClawFW._modelPresets = presets;
    window.ClawFW._modelPresetsRuntimeId = runtimeId;
  }
  return presets;
}

async function _toggleModelDropdown() {
  // If already open, close
  if (_modelDropdown) {
    _closeModelDropdown();
    return;
  }

  let bar = document.getElementById('chat-context-bar');
  if (!bar) return;

  let agentId = _getCurrentAgentIdForSwap();
  if (!agentId) return;

  // Fetch presets
  let presets = _presetCacheMatchesCurrentSession() ? window.ClawFW._modelPresets : [];
  if (!presets.length) {
    try {
      presets = await _fetchPresetsForCurrentSession();
    } catch (e) {
      console.error('[ModelDropdown] Failed to load presets:', e);
      return;
    }
  }
  if (!presets.length) return;

  let currentPreset = _getCurrentDefaultPresetName();
  let isZh = typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';

  // Build dropdown
  _modelDropdown = document.createElement('div');
  _modelDropdown.className = 'ccb-model-dropdown';

  let html = '<div class="ccb-model-dropdown-list">';
  presets.forEach(function(p) {
    let name = p.name || p.model || '';
    let isActive = name === currentPreset;
    let visionIcon = p.vision === true
      ? '<svg class="ccb-md-vision" title="' + (isZh ? '支持视觉' : 'Vision') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>'
      : '';
    let ctxText = p.contextLength && p.contextLength > 0
      ? Math.round(p.contextLength / 1000) + 'K'
      : '';
    html += '<div class="ccb-md-item' + (isActive ? ' active' : '') + '" data-preset="' + escapeHtml(name) + '">'
      + '<span class="ccb-md-left">'
      + '<span class="ccb-md-name">' + escapeHtml(name) + '</span>'
      + visionIcon
      + '</span>'
      + '<span class="ccb-md-right">'
      + (ctxText ? '<span class="ccb-md-ctx">' + ctxText + '</span>' : '')
      + '</span>'
      + '</div>';
  });
  html += '</div>';
  _modelDropdown.innerHTML = html;

  // Position
  let rect = bar.getBoundingClientRect();
  _modelDropdown.style.left = rect.left + 'px';
  _modelDropdown.style.top = (rect.bottom + 8) + 'px';

  // Item click
  _modelDropdown.addEventListener('click', function(e) {
    let item = e.target.closest('.ccb-md-item');
    if (!item) return;
    let presetName = item.dataset.preset;
    _closeModelDropdown();
    _performModelSwap(agentId, presetName);
  });

  document.body.appendChild(_modelDropdown);
  // Trigger transition
  requestAnimationFrame(function() { _modelDropdown.classList.add('visible'); });

  // Close on outside click
  setTimeout(function() {
    document.addEventListener('click', _modelDropdownOutsideClick, { once: true });
  }, 0);
}

function _modelDropdownOutsideClick(e) {
  if (_modelDropdown && !_modelDropdown.contains(e.target)) {
    let bar = document.getElementById('chat-context-bar');
    if (!bar || !bar.contains(e.target)) {
      _closeModelDropdown();
    }
  } else if (_modelDropdown) {
    // Clicked inside dropdown but not on an item — re-register
    document.addEventListener('click', _modelDropdownOutsideClick, { once: true });
  }
}

async function _performModelSwap(agentId, presetName) {
  let isZh = typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';
  let toastId = 'model-hot-swap';

  ClawToast.show({
    id: toastId,
    title: isZh ? '正在切换模型...' : 'Switching model...',
    status: 'loading',
    closable: false,
  });

  try {
    let sessionId = typeof getActiveWorkspaceSessionId === 'function'
      ? getActiveWorkspaceSessionId()
      : '';
    let runtimeId = (typeof currentRuntimeAgentId !== 'undefined' && currentRuntimeAgentId) || '';
    const resp = await fetch('/protoclaw/swap_model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, presetName, sessionId: sessionId || undefined, runtimeId: runtimeId || undefined }),
    });
    const result = await resp.json();
    if (result.ok) {
      let swapDesc = presetName;
      if (presetName === '__default__' && result?.meta?.modelName) swapDesc = result.meta.modelName;
      else if (typeof formatPresetDisplayName === 'function') swapDesc = formatPresetDisplayName(presetName);
      ClawToast.update(toastId, {
        status: 'success',
        title: isZh ? '模型已切换' : 'Model switched',
        description: swapDesc,
        autoDismiss: 3000,
      });
      // Context bar model name comes from overview poll — just refresh.
      // Input box needs immediate update too.
      if (typeof updateInputModelSwitcher === 'function') updateInputModelSwitcher();
      if (typeof updateChatContextBar === 'function') updateChatContextBar();
    } else {
      throw new Error(result.error || 'Unknown error');
    }
  } catch (e) {
    console.error('[ModelDropdown] Swap failed:', e);
    ClawToast.update(toastId, {
      status: 'error',
      title: isZh ? '切换失败' : 'Switch failed',
      description: e?.message || String(e),
      closable: true,
      autoDismiss: 8000,
    });
  }
}


// ── Title hover popup: session metadata ───────────────────────────
let _titlePopup = null;
let _titlePopupHideTimer = null;
let _titlePopupShowTimer = null;

/**
 * Collect the active session metadata from the current agent record.
 * Uses getRuntimeAwareAgentRecord() for correct session binding —
 * same pattern as updateChatContextBar.
 */
function _collectActiveSessionMeta() {
  let agent = typeof getRuntimeAwareAgentRecord === 'function'
    ? getRuntimeAwareAgentRecord()
    : (typeof getCurrentHostAgentRecord === 'function' ? getCurrentHostAgentRecord() : null);
  if (agent) {
    let activeSessionId = String(
      agent.active_workspace_session_id
      || agent.workspace_sessions?.activeSessionId
      || ''
    ).trim();

    let sessions = Array.isArray(agent.workspace_sessions?.sessions)
      ? agent.workspace_sessions.sessions
      : [];

    let session = activeSessionId
      ? sessions.find(function (s) { return s && s.id === activeSessionId; }) || null
      : null;

    return {
      session: session,
      agent: agent,
      activeSessionId: activeSessionId,
    };
  }

  // 远程分支（T21-E）：agent record 落空（远程会话不在 allAgents）时，
  // 从远程目录 accessor 与 sessionMeta 留档组装弹窗元数据。返回结构与本地
  // 分支保持一致（session / agent / activeSessionId 三键），_buildTitlePopupHtml
  // 无感知差异；agent 槽位用标题回退链值做最小呈现，不伪造在线状态字段。
  let runtimeRef = typeof currentRuntimeAgentId !== 'undefined' ? currentRuntimeAgentId : '';
  if (!runtimeRef) return null;
  let rc = typeof window !== 'undefined' ? window.RemoteConnections : null;
  if (!rc) return null;

  let activeSessionId = typeof rc.getEntryRuntimeSessionId === 'function'
    ? rc.getEntryRuntimeSessionId(runtimeRef)
    : '';
  let title = typeof rc.getEntrySessionTitle === 'function'
    ? rc.getEntrySessionTitle(runtimeRef)
    : '';

  let viewState = typeof readCurrentSessionViewState === 'function'
    ? readCurrentSessionViewState()
    : null;
  let sessionMeta = viewState && viewState.sessionMeta || {};

  let session = {};
  if (sessionMeta.createdAt) session.createdAt = sessionMeta.createdAt;
  if (sessionMeta.updatedAt) session.updatedAt = sessionMeta.updatedAt;
  if (sessionMeta.openDirectory) session.openDirectory = sessionMeta.openDirectory;
  if (sessionMeta.messageCount) session.messageCount = sessionMeta.messageCount;
  if (sessionMeta.sessionType) session.sessionType = sessionMeta.sessionType;
  if (title) session.title = title;

  let agentShim = { name: title };
  if (activeSessionId) {
    agentShim.active_workspace_session_id = activeSessionId;
  }

  return {
    session: session,
    agent: agentShim,
    activeSessionId: activeSessionId,
  };
}

function _buildTitlePopupHtml(meta) {
  if (!meta) return '';
  let isZh = currentLanguage === 'zh';
  let s = meta.session || {};
  let a = meta.agent || {};
  let sections = [];

  // ── Session title ──
  let fullTitle = s.title
    || a.active_workspace_session_title
    || a.active_workspace_display_name
    || a.name
    || '';
  if (fullTitle) {
    sections.push('<div class="ccb-popup-model">' + escapeHtml(fullTitle) + '</div>');
  }

  // ── Time info ──
  let timeRows = [];

  let createdAt = s.createdAt || a.created_at || null;
  if (createdAt) {
    let relCreated = formatRelativeTime(createdAt);
    let absCreated = formatWorkspaceDate(createdAt);
    timeRows.push('<div class="ccb-popup-row"><span class="ccb-popup-label">'
      + (isZh ? '创建' : 'Created')
      + '</span><span class="ccb-popup-value" title="' + escapeHtml(absCreated) + '">'
      + escapeHtml(relCreated || absCreated) + '</span></div>');
  }

  let updatedAt = s.updatedAt || null;
  if (updatedAt) {
    let relUpdated = formatRelativeTime(updatedAt);
    let absUpdated = formatWorkspaceDate(updatedAt);
    timeRows.push('<div class="ccb-popup-row"><span class="ccb-popup-label">'
      + (isZh ? '最近活动' : 'Last Active')
      + '</span><span class="ccb-popup-value" title="' + escapeHtml(absUpdated) + '">'
      + escapeHtml(relUpdated || absUpdated) + '</span></div>');
  }

  // ── Session stats ──
  let statRows = [];

  let msgCount = (typeof s.messageCount === 'number' ? s.messageCount : null)
    ?? (typeof a.message_count === 'number' ? a.message_count : null);
  if (msgCount !== null && msgCount !== undefined) {
    statRows.push('<div class="ccb-popup-row"><span class="ccb-popup-label">'
      + (isZh ? '消息数' : 'Messages')
      + '</span><span class="ccb-popup-value">' + msgCount + '</span></div>');
  }

  // Token usage
  let tu = s.tokenUsage;
  if (tu && (tu.totalTokens || tu.inputTokens || tu.outputTokens)) {
    let tokenParts = [];
    if (tu.inputTokens) tokenParts.push((isZh ? '入 ' : 'in ') + _formatTokens(tu.inputTokens));
    if (tu.outputTokens) tokenParts.push((isZh ? '出 ' : 'out ') + _formatTokens(tu.outputTokens));
    if (tokenParts.length) {
      statRows.push('<div class="ccb-popup-row"><span class="ccb-popup-label">'
        + (isZh ? '累计用量' : 'Total Tokens')
        + '</span><span class="ccb-popup-value ccb-popup-mono">' + escapeHtml(tokenParts.join(' · ')) + '</span></div>');
    }
  }

  // Session type
  let sType = s.sessionType || '';
  if (sType) {
    let typeLabels = {
      main: isZh ? '主对话' : 'Main',
      archived: isZh ? '已归档' : 'Archived',
    };
    let typeLabel = typeLabels[sType] || sType;
    statRows.push('<div class="ccb-popup-row"><span class="ccb-popup-label">'
      + (isZh ? '类型' : 'Type')
      + '</span><span class="ccb-popup-value">' + escapeHtml(typeLabel) + '</span></div>');
  }

  // Working directory
  let openDir = s.openDirectory || '';
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
  let titleEl = document.getElementById('current-agent-name');
  if (!titleEl) return;
  let meta = _collectActiveSessionMeta();
  let html = _buildTitlePopupHtml(meta);
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
  let rect = titleEl.getBoundingClientRect();
  _titlePopup.style.left = rect.left + 'px';
  _titlePopup.style.top = (rect.bottom + 8) + 'px';
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
  let titleEl = document.getElementById('current-agent-name');
  if (!titleEl || titleEl.dataset.titlePopupBound) return;
  titleEl.dataset.titlePopupBound = '1';
  titleEl.addEventListener('mouseenter', function () { _scheduleShowTitlePopup(); });
  titleEl.addEventListener('mouseleave', function () { _scheduleHideTitlePopup(); });
}

window.addEventListener('DOMContentLoaded', _initTitlePopup);
setTimeout(_initTitlePopup, 0);
