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
  // 渲染。用量读数在聊天界面常驻：数据未到位时以空态占位呈现，避免加载
  // 期间顶栏元素出现/消失的布局跳动。
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

  // 模型名：swap 回执（ack 即生效）优先——overview 帧经 SSE/轮询通道送达，
  // 广域链路下可能滞后 ack 数秒；其次 overview 实时，回退到 session 元数据。
  // getter（window.ClawFW.getActiveModelSwapReceipt，input-model-switcher.js）
  // 内部完成退役判定，无回执时返回 null 走原链路。
  let modelName = '';
  let swapReceipt = (window.ClawFW && typeof window.ClawFW.getActiveModelSwapReceipt === 'function')
    ? window.ClawFW.getActiveModelSwapReceipt()
    : null;
  if (swapReceipt && swapReceipt.modelName) {
    modelName = swapReceipt.modelName;
  }
  if (!modelName && overview.modelName) {
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
  // 是历史上 context bar 显示不匹配的根源。overview 无 contextLength 时渲染空态占位。
  let contextLength = (overview.contextLength != null && overview.contextLength > 0)
    ? overview.contextLength
    : 0;
  let compressRatio = (overview.compressRatio != null && overview.compressRatio > 0)
    ? overview.compressRatio
    : 80;

  // 阈限占比：当前用量占压缩阈值的比例（而非全窗口）
  let thresholdTokens = contextLength > 0 ? Math.round(contextLength * compressRatio / 100) : 0;
  let thresholdPct = thresholdTokens > 0 ? Math.round((used / thresholdTokens) * 100) : 0;

  // 超阈值自动打断 badge（ContextGuardToggle，进度条组内嵌）：同一阈值的
  // 读数与守卫放在一起。未挂载 / 状态未到位返回空串，占位不影响布局。
  let guardBadge = window.ContextGuardToggle?.renderBadge?.() || '';

  let html = '';
  if (modelName) {
    html += '<span class="ccb-model" data-ccb-trigger="1">' + escapeHtml(modelName) + '</span>';
  }
  if (contextLength > 0) {
    let pct = used > 0 ? Math.min(100, Math.round((used / contextLength) * 100)) : 0;
    // 进度条颜色按阈限占比分三段：<70% green, 70-100% amber, ≥100% red
    let tone = thresholdPct >= 100 ? 'compress' : thresholdPct >= 70 ? 'mid' : 'low';
    let label = (used > 0 && !isLastRequest)
      ? pct + '% (\u7d2f\u79ef)'
      : pct + '%';
    html += '<span class="ccb-token tone-' + tone + '">'
      + '<span class="ccb-bar" data-ccb-trigger="1"><span class="ccb-compress-zone" style="left:' + compressRatio + '%"></span><span class="ccb-fill" style="width:' + pct + '%"></span></span>'
      + '<span class="ccb-label" data-ccb-trigger="1">' + label + '</span>'
      + guardBadge
      + '</span>';
  } else {
    // 常驻空态：数据未到位（加载中 / runtime 未上报 contextLength）时占位，
    // 与左侧模型名的呈现保持稳定，不隐藏。
    html += '<span class="ccb-token ccb-token-empty">'
      + '<span class="ccb-bar" data-ccb-trigger="1"></span>'
      + '<span class="ccb-label" data-ccb-trigger="1">—</span>'
      + guardBadge
      + '</span>';
  }

  // 存储详细数据供 hover popup 使用
  let detailData = { modelName: modelName || '', used: used, contextLength: contextLength, compressRatio: compressRatio, isLastRequest: isLastRequest };
  detailData.guard = window.ContextGuardToggle?.getDetail?.() || null;
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
  // 超阈值自动打断：badge 的只读详情（开关在进度条组末端的盾牌图标）
  if (d.guard) {
    ctxRows.push('<div class="ccb-popup-row"><span class="ccb-popup-label">' + (isZh ? '超阈值自动打断' : 'Auto-interrupt') + '</span><span class="ccb-popup-value">' + (d.guard.armed ? (isZh ? '开' : 'On') : (isZh ? '关' : 'Off')) + '</span></div>');
    if (d.guard.trip && d.guard.trip.inputTokens && d.guard.trip.thresholdTokens) {
      ctxRows.push('<div class="ccb-popup-row"><span class="ccb-popup-label">' + (isZh ? '最近触发' : 'Last trigger') + '</span><span class="ccb-popup-value ccb-popup-mono">' + _formatTokens(d.guard.trip.inputTokens) + ' / ' + _formatTokens(d.guard.trip.thresholdTokens) + '</span></div>');
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
  // 左缘左偏 12px：badge 使 bar 右端有内容后，弹窗与触发区整体更协调
  // （bar 位于 header 右侧，左偏不会触到视口左缘）
  _ccbPopup.style.left = (rect.left - 12) + 'px';
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
  // 白名单正向触发：只有模型名 / 进度条 / 百分比（data-ccb-trigger）是
  // 详情弹窗的触发区。badge 与 bar 其余区域（含缝隙）一律按离开处理——
  // 清掉待显示定时器并调度隐藏。不存在"触发后再压制"的补丁分支。
  bar.addEventListener('mouseover', function(e) {
    if (e.target && e.target.closest && e.target.closest('[data-ccb-trigger]')) {
      _scheduleShowCcbPopup();
    } else {
      _scheduleHideCcbPopup();
    }
  });
  bar.addEventListener('mouseout', function(e) {
    let to = e.relatedTarget;
    if (!to || !bar.contains(to)) _scheduleHideCcbPopup();
  });
  bar.addEventListener('click', function(e) {
    let btn = e.target && e.target.closest ? e.target.closest('[data-guard-toggle]') : null;
    if (btn && !btn.disabled) window.ContextGuardToggle?.toggleGuard?.();
  });
}

window.addEventListener('DOMContentLoaded', _initCcbPopup);
setTimeout(_initCcbPopup, 0);


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

    // 导出寻址用宿主 agent id（会话文件按宿主目录落盘）。视图身份的 agentId
    // 恒为宿主 id（session-view-state 归一化保证），比 runtime 记录的 .id 可靠。
    let viewIdentity = typeof readCurrentSessionViewState === 'function'
      ? (readCurrentSessionViewState() || {}).identity || null
      : null;
    let hostAgentId = String(viewIdentity && viewIdentity.agentId || agent.id || '').trim();

    return {
      session: session,
      agent: agent,
      activeSessionId: activeSessionId,
      agentId: hostAgentId,
      isRemote: false,
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
    // 远程会话不在本机落盘，渲染链路（render_conversation 读本地会话文件）
    // 不可用——导出按钮不显示（grill 共识：v1 本地会话限定）。
    isRemote: true,
  };
}

function _buildTitlePopupHtml(meta) {
  if (!meta) return '';
  let isZh = currentLanguage === 'zh';
  let s = meta.session || {};
  let a = meta.agent || {};
  let sections = [];

  // ── Session title（本地会话右侧带导出按钮，远程会话不显示）──
  let fullTitle = s.title
    || a.active_workspace_session_title
    || a.active_workspace_display_name
    || a.name
    || '';
  if (fullTitle) {
    let canExport = !meta.isRemote && meta.agentId && meta.activeSessionId;
    let exportLabel = isZh ? '导出对话' : 'Export conversation';
    sections.push('<div class="ccb-popup-title-row">'
      + '<div class="ccb-popup-model">' + escapeHtml(fullTitle) + '</div>'
      + (canExport
        ? '<button type="button" class="ccb-popup-export-btn" data-agent-id="' + escapeHtml(meta.agentId)
          + '" data-session-id="' + escapeHtml(meta.activeSessionId)
          + '" data-session-title="' + escapeHtml(fullTitle)
          + '" title="' + exportLabel + '" aria-label="' + exportLabel + '">' + _CCB_ICON_EXPORT + '</button>'
        : '')
      + '</div>');
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

  // Session ID (compact) + copy full id
  if (meta.activeSessionId) {
    let copyLabel = isZh ? '复制完整 ID' : 'Copy full ID';
    statRows.push('<div class="ccb-popup-row"><span class="ccb-popup-label">'
      + (isZh ? '会话 ID' : 'Session')
      + '</span><span class="ccb-popup-value ccb-popup-mono ccb-popup-id-value" title="'
      + escapeHtml(meta.activeSessionId) + '">'
      + escapeHtml(meta.activeSessionId.slice(-12))
      + '<button type="button" class="ccb-popup-copy-btn" data-session-id="' + escapeHtml(meta.activeSessionId)
      + '" title="' + copyLabel + '" aria-label="' + copyLabel + '">'
      + _CCB_ICON_COPY + '</button></span></div>');
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

let _CCB_ICON_COPY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
  + '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>'
  + '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
let _CCB_ICON_CHECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">'
  + '<polyline points="20 6 9 17 4 12"/></svg>';
let _CCB_ICON_EXPORT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>'
  + '<polyline points="7 10 12 15 17 10"/>'
  + '<line x1="12" y1="15" x2="12" y2="3"/></svg>';

async function _copyPopupSessionId(btn) {
  let sessionId = btn?.dataset?.sessionId || '';
  if (!sessionId) return;
  let isZh = typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';
  let ok = false;
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(sessionId); ok = true; } catch (e) { ok = false; }
  }
  if (!ok) {
    // Fallback for non-secure contexts (e.g. accessing the UI via a LAN IP)
    try {
      let ta = document.createElement('textarea');
      ta.value = sessionId;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { ok = false; }
  }
  if (!ok) {
    if (typeof ClawToast !== 'undefined') {
      ClawToast.show({ id: 'ccb-copy-session-id', status: 'error', title: isZh ? '复制会话 ID 失败' : 'Failed to copy session ID' });
    }
    return;
  }
  btn.innerHTML = _CCB_ICON_CHECK;
  btn.classList.add('ccb-popup-copy-done');
  if (btn._copyResetTimer) clearTimeout(btn._copyResetTimer);
  btn._copyResetTimer = setTimeout(function () {
    btn.innerHTML = _CCB_ICON_COPY;
    btn.classList.remove('ccb-popup-copy-done');
    btn._copyResetTimer = null;
  }, 1200);
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
    _titlePopup.addEventListener('click', function (e) {
      let btn = e.target && e.target.closest ? e.target.closest('.ccb-popup-copy-btn') : null;
      if (btn) _copyPopupSessionId(btn);
      let exportBtn = e.target && e.target.closest ? e.target.closest('.ccb-popup-export-btn') : null;
      if (exportBtn) {
        _hideTitlePopup();
        if (typeof window.openConversationExportDialog === 'function') {
          window.openConversationExportDialog({
            agentId: exportBtn.dataset.agentId || '',
            sessionId: exportBtn.dataset.sessionId || '',
            title: exportBtn.dataset.sessionTitle || '',
          });
        }
      }
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
