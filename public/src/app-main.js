function normalizeAgentIdentity(value) {
  return String(value || '').trim();
}

function getCurrentHostAgentRecord() {
  const hostId = normalizeAgentIdentity(currentAgentId);
  if (!hostId) return null;
  return allAgents.find((agent) => normalizeAgentIdentity(agent?.id) === hostId) || null;
}

function getCurrentRuntimeRecord() {
  const runtimeId = normalizeAgentIdentity(currentRuntimeAgentId);
  if (!runtimeId) return null;
  const runtimeRecord = allAgents.find((agent) => {
    const agentId = normalizeAgentIdentity(agent?.id);
    const resolvedRuntimeId = normalizeAgentIdentity(getAgentRuntimeId(agent));
    return agentId === runtimeId || resolvedRuntimeId === runtimeId;
  }) || null;
  if (runtimeRecord) {
    return runtimeRecord;
  }
  const hostRecord = getCurrentHostAgentRecord();
  const hostRuntimeId = normalizeAgentIdentity(hostRecord?.runtime_session_id || hostRecord?.runtimeSessionId);
  if (hostRecord && hostRuntimeId && hostRuntimeId === runtimeId) {
    return hostRecord;
  }
  return null;
}

function getCurrentVisualAgentTitle() {
  const runtimeRecord = getCurrentRuntimeRecord();
  const hostRecord = getCurrentHostAgentRecord();
  if (runtimeRecord && normalizeAgentIdentity(currentRuntimeAgentId)) {
    return runtimeRecord.active_workspace_display_name
      || runtimeRecord.active_workspace_agent_name
      || runtimeRecord.active_workspace_session_title
      || runtimeRecord.name
      || hostRecord?.active_workspace_display_name
      || hostRecord?.active_workspace_session_title
      || hostRecord?.name
      || currentRuntimeAgentId;
  }
  return hostRecord?.name || t('page_title');
}

function updateCurrentAgentChrome() {
  if (!currentAgentTitle || !statusBadge) return;
  const hasSelection = normalizeAgentIdentity(currentAgentId) || normalizeAgentIdentity(currentRuntimeAgentId);
  if (!hasSelection) {
    currentAgentTitle.textContent = t('page_title');
    statusBadge.textContent = t('status_no_agent');
    statusBadge.classList.add('disconnected');
    return;
  }
  currentAgentTitle.textContent = getCurrentVisualAgentTitle();
  if (!normalizeAgentIdentity(currentRuntimeAgentId)) {
    statusBadge.textContent = currentLanguage === 'zh' ? '系统空间' : 'System';
    statusBadge.classList.remove('disconnected');
    return;
  }
  const runtimeRecord = getCurrentRuntimeRecord();
  const connected = runtimeRecord ? runtimeRecord.connected !== false : true;
  statusBadge.textContent = connected ? t('status_connected') : t('status_disconnected');
  statusBadge.classList.toggle('disconnected', !connected);
}

function isAgentActive(agent) {
  const agentId = normalizeAgentIdentity(agent?.id);
  const runtimeId = normalizeAgentIdentity(currentRuntimeAgentId);
  const hostId = normalizeAgentIdentity(currentAgentId);
  if (!agentId) return false;
  if (runtimeId) {
    if (agent?.source === 'prebuilt' && agentId === hostId) {
      return false;
    }
    return agentId === runtimeId && agentId === hostId;
  }
  return agentId === hostId;
}

function getCurrentAgentRecord() {
  return getCurrentHostAgentRecord();
}

function groupConnectedAgents(agents) {
  const TOOL_AGENT_IDS = new Set(['programming-helper']);
  const prebuiltIds = new Set(
    agents
      .filter((agent) => agent.source === 'prebuilt')
      .map((agent) => String(agent.id || '').trim())
      .filter(Boolean)
  );
  const orphanRuntimeAgents = agents.filter((agent) => {
    if (agent.source === 'prebuilt') return false;
    const parentId = String(agent.parent_id || '').trim();
    return !parentId || !prebuiltIds.has(parentId);
  });
  const allPrebuilt = agents.filter((agent) => agent.source === 'prebuilt');
  return {
    prebuilt: allPrebuilt.filter((agent) => !TOOL_AGENT_IDS.has(String(agent.id || '').trim())),
    tool: allPrebuilt.filter((agent) => TOOL_AGENT_IDS.has(String(agent.id || '').trim())),
    external: orphanRuntimeAgents,
  };
}

function isRuntimeItemActive(runtimeId) {
  const normalizedRuntimeId = normalizeAgentIdentity(runtimeId);
  return normalizedRuntimeId !== '' && normalizeAgentIdentity(currentRuntimeAgentId) === normalizedRuntimeId;
}

function buildSyntheticRuntimeEntry(prebuiltAgent) {
  const runtimeId = prebuiltAgent.runtime_session_id || prebuiltAgent.runtimeSessionId || '';
  if (!runtimeId) return null;
  if (prebuiltAgent.connected === false) return null;
  return {
    id: runtimeId,
    ownerId: prebuiltAgent.id,
    runtimeId,
    sessionId: prebuiltAgent.active_workspace_session_id || '',
    name: prebuiltAgent.active_workspace_display_name
      || prebuiltAgent.active_workspace_session_title
      || `${prebuiltAgent.name || prebuiltAgent.id} Runtime`,
    metaLabel: prebuiltAgent.active_workspace_session_title || '常驻运行时',
    status: prebuiltAgent.connected === false ? 'disconnected' : 'connected',
    source: 'managed-runtime',
    contextMenuEnabled: true,
  };
}

function buildChildRuntimeEntry(runtimeAgent) {
  const runtimeId = runtimeAgent.runtime_session_id || runtimeAgent.runtimeSessionId || runtimeAgent.id || '';
  const ownerId = String(runtimeAgent.parent_id || '').trim();
  if (!runtimeId || !ownerId) return null;
  return {
    id: runtimeAgent.id || runtimeId,
    ownerId,
    runtimeId,
    sessionId: runtimeAgent.active_workspace_session_id || '',
    name: runtimeAgent.active_workspace_display_name
      || runtimeAgent.active_workspace_agent_name
      || runtimeAgent.active_workspace_session_title
      || runtimeAgent.name
      || runtimeId,
    metaLabel: runtimeAgent.active_workspace_session_title || runtimeAgent.name || '显式运行时',
    status: runtimeAgent.connected === false ? 'disconnected' : 'connected',
    source: runtimeAgent.source || 'external',
    contextMenuEnabled: true,
  };
}

function collectRuntimeEntriesForPrebuilt(prebuiltAgent, agents) {
  const entries = [];
  const seenRuntimeIds = new Set();

  const addEntry = (entry) => {
    if (!entry) return;
    if (!entry?.runtimeId) return;
    if (seenRuntimeIds.has(entry.runtimeId)) return;
    seenRuntimeIds.add(entry.runtimeId);
    entries.push(entry);
  };
  addEntry(buildSyntheticRuntimeEntry(prebuiltAgent));

  agents
    .filter((agent) => agent.source !== 'prebuilt' && String(agent.parent_id || '').trim() === String(prebuiltAgent.id || '').trim())
    .forEach((agent) => addEntry(buildChildRuntimeEntry(agent)));

  return entries;
}

function isRuntimeCalling(runtimeId) {
  return normalizeAgentIdentity(runtimeId) !== '' && _agentCallActive.get(runtimeId) === true;
}

function resolveNotificationCallingState(notifData) {
  if (notifData?.runtime && notifData.runtime.callActive !== undefined) {
    return notifData.runtime.callActive === true;
  }
  const stateType = String(notifData?.state?.type || '').trim();
  if (stateType === 'call.start') {
    return true;
  }
  if (stateType === 'call.finish') {
    return false;
  }
  if (notifData?.callActive !== undefined) {
    return notifData.callActive === true;
  }
  if (stateType === 'llm.complete') {
    return false;
  }
  return notifData?.callActive === true;
}

function normalizeNotificationRuntimeSnapshot(runtime) {
  return {
    stage: typeof runtime?.stage === 'string' ? runtime.stage : 'idle',
    callActive: runtime?.callActive === true,
    charCount: typeof runtime?.charCount === 'number' ? runtime.charCount : 0,
    thinkingChars: typeof runtime?.thinkingChars === 'number' ? runtime.thinkingChars : 0,
    contentChars: typeof runtime?.contentChars === 'number' ? runtime.contentChars : 0,
    toolCallCount: typeof runtime?.toolCallCount === 'number' ? runtime.toolCallCount : 0,
    activeToolNames: Array.isArray(runtime?.activeToolNames) ? runtime.activeToolNames.map((item) => String(item || '')).filter(Boolean) : [],
    activeToolCount: typeof runtime?.activeToolCount === 'number' ? runtime.activeToolCount : 0,
    callStartedAt: typeof runtime?.callStartedAt === 'number' ? runtime.callStartedAt : 0,
    stageStartedAt: typeof runtime?.stageStartedAt === 'number' ? runtime.stageStartedAt : 0,
    retryAttempt: typeof runtime?.retryAttempt === 'number' ? runtime.retryAttempt : undefined,
    maxRetries: typeof runtime?.maxRetries === 'number' ? runtime.maxRetries : undefined,
    nextRetryDelayMs: typeof runtime?.nextRetryDelayMs === 'number' ? runtime.nextRetryDelayMs : undefined,
    updatedAt: typeof runtime?.updatedAt === 'number' ? runtime.updatedAt : 0,
    lastErrorType: typeof runtime?.lastErrorType === 'string' ? runtime.lastErrorType : null,
    lastErrorMessage: typeof runtime?.lastErrorMessage === 'string' ? runtime.lastErrorMessage : null,
  };
}

function getRuntimeStageLabel(runtime) {
  switch (runtime.stage) {
    case 'llm_thinking':
      return t('phase_thinking');
    case 'llm_content':
      return t('phase_content');
    case 'llm_tool_call_building':
      return t('phase_tool_calling');
    case 'tool_executing':
      return t('phase_tool_executing');
    case 'retry_waiting':
      return t('phase_retry_waiting');
    case 'retry_requesting':
      return t('phase_retry_requesting');
    case 'awaiting_runtime':
      return t('phase_processing');
    case 'completed':
      return t('phase_completed');
    case 'failed':
      return t('phase_failed');
    default:
      return runtime.callActive ? t('phase_processing') : '';
  }
}

function getCompactRuntimeLabel(runtime, isConnected = true) {
  if (!isConnected) {
    return t('runtime_status_disconnected');
  }
  if (runtime.stage === 'llm_thinking') {
    return runtime.thinkingChars > 0
      ? `${currentLanguage === 'zh' ? '思考' : 'Thinking'} ${formatRuntimeCompactNumber(runtime.thinkingChars)} ${t('runtime_unit_chars')}`
      : (currentLanguage === 'zh' ? '思考中' : 'Thinking');
  }
  if (runtime.stage === 'llm_content') {
    const outputCount = runtime.contentChars || runtime.charCount;
    return outputCount > 0
      ? `${currentLanguage === 'zh' ? '生成' : 'Generating'} ${formatRuntimeCompactNumber(outputCount)} ${t('runtime_unit_chars')}`
      : (currentLanguage === 'zh' ? '生成中' : 'Generating');
  }
  if (runtime.stage === 'llm_tool_call_building') {
    return currentLanguage === 'zh' ? '准备工具' : 'Preparing Tools';
  }
  if (runtime.stage === 'tool_executing') {
    const toolSummary = summarizeRuntimeToolNames(runtime.activeToolNames);
    return toolSummary
      ? `${currentLanguage === 'zh' ? '执行工具' : 'Running Tools'} · ${toolSummary}`
      : (currentLanguage === 'zh' ? '执行工具' : 'Running Tools');
  }
  if (runtime.stage === 'retry_waiting') {
    return currentLanguage === 'zh' ? '重试等待' : 'Retry Waiting';
  }
  if (runtime.stage === 'retry_requesting') {
    return currentLanguage === 'zh' ? '重新请求' : 'Retrying';
  }
  if (runtime.stage === 'failed') {
    return currentLanguage === 'zh' ? '请求失败' : 'Failed';
  }
  if (runtime.stage === 'completed') {
    return currentLanguage === 'zh' ? '已完成' : 'Done';
  }
  if (runtime.callActive) {
    if (runtime.toolCallCount > 0 || runtime.activeToolCount > 0) {
      if (runtime.activeToolCount > 0) {
        const toolSummary = summarizeRuntimeToolNames(runtime.activeToolNames);
        return toolSummary
          ? `${currentLanguage === 'zh' ? '执行工具' : 'Running Tools'} · ${toolSummary}`
          : (currentLanguage === 'zh' ? '执行工具' : 'Running Tools');
      }
      return currentLanguage === 'zh' ? '等待工具结果' : 'Waiting for Tools';
    }
    return t('runtime_status_waiting_model');
  }
  return '';
}

function formatRuntimeCompactNumber(value) {
  if (!Number.isFinite(value)) return '0';
  return Number(value).toLocaleString();
}

function formatRuntimeDuration(ms) {
  const safeMs = Math.max(0, Number(ms) || 0);
  const totalSeconds = Math.floor(safeMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return `${hours}h ${restMinutes}m`;
}

function summarizeRuntimeToolNames(toolNames) {
  const normalized = Array.isArray(toolNames)
    ? toolNames.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (normalized.length <= 2) {
    return normalized.join(', ');
  }
  const visible = normalized.slice(0, 2).join(', ');
  const remaining = normalized.length - 2;
  return currentLanguage === 'zh'
    ? `${visible} +${remaining}个`
    : `${visible} +${remaining}`;
}

function getPendingToolCallsFromMessages(messages = currentMessages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }
  const completedToolCallIds = new Set(
    messages
      .filter((msg) => msg?.role === 'tool' && msg?.toolCallId)
      .map((msg) => String(msg.toolCallId))
  );

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const msg = messages[index];
    if (!Array.isArray(msg?.toolCalls) || msg.toolCalls.length === 0) {
      continue;
    }
    const pendingCalls = msg.toolCalls.filter((call) => !completedToolCallIds.has(String(call?.id || '')));
    if (pendingCalls.length > 0) {
      return pendingCalls;
    }
  }
  return [];
}

function getDerivedStageFromState(stateType = '', stateData = null, currentStage = 'idle') {
  if (stateType === 'call.start') return 'awaiting_runtime';
  if (stateType === 'call.finish') return 'completed';
  if (stateType === 'tool.start') return 'tool_executing';
  if (stateType === 'tool.complete') return currentStage === 'tool_executing' ? 'awaiting_runtime' : currentStage;
  if (stateType === 'llm.char_count') {
    const phase = String(stateData?.phase || '').trim();
    if (phase === 'thinking') return 'llm_thinking';
    if (phase === 'content') return 'llm_content';
    if (phase === 'tool_calling') return 'llm_tool_call_building';
  }
  if (stateType === 'llm.complete') {
    return currentStage === 'tool_executing' ? 'tool_executing' : 'awaiting_runtime';
  }
  return currentStage;
}

function getNotificationActionSource(notifData) {
  const state = notifData?.state && typeof notifData.state === 'object' ? notifData.state : null;
  const event = notifData?.event && typeof notifData.event === 'object' ? notifData.event : null;
  if (event && (!state || (Number(event.timestamp) || 0) >= (Number(state.timestamp) || 0))) {
    return event;
  }
  return state;
}

function getEffectiveRuntimeSnapshot(notifData) {
  const runtime = normalizeNotificationRuntimeSnapshot(notifData?.runtime);
  const nextCalling = resolveNotificationCallingState(notifData);
  const runtimeId = normalizeAgentIdentity(currentRuntimeAgentId) || 'none';
  const actionSource = getNotificationActionSource(notifData);
  const stateType = String(actionSource?.type || '').trim();
  const stateData = actionSource?.data && typeof actionSource.data === 'object'
    ? actionSource.data
    : null;
  const remembered = _runtimeStatusMemory.get(runtimeId) || null;

  if (nextCalling) {
    runtime.callActive = true;
  }

  if (stateType === 'llm.char_count' && stateData) {
    if (typeof stateData.charCount === 'number') {
      runtime.charCount = stateData.charCount;
    }
    if (typeof stateData.toolCallCount === 'number') {
      runtime.toolCallCount = stateData.toolCallCount;
    }
    const phase = String(stateData.phase || '').trim();
    if (phase === 'thinking' && typeof stateData.charCount === 'number') {
      runtime.thinkingChars = stateData.charCount;
    }
    if (phase === 'content' && typeof stateData.charCount === 'number') {
      runtime.contentChars = stateData.charCount;
    }
  }

  const derivedStage = getDerivedStageFromState(stateType, stateData, runtime.stage);
  const runtimeAlreadyExpressive = runtime.stage !== 'idle'
    && runtime.stage !== 'completed'
    && runtime.stage !== 'failed';
  const shouldUseDerivedStage = !runtimeAlreadyExpressive
    || runtime.stage === 'awaiting_runtime'
    || runtime.updatedAt <= 0;
  if (shouldUseDerivedStage && derivedStage && derivedStage !== 'idle') {
    runtime.stage = derivedStage;
  }

  if (runtime.callActive && (runtime.stage === 'idle' || runtime.stage === 'completed' || runtime.stage === 'failed')) {
    runtime.stage = 'awaiting_runtime';
  }

  const pendingToolCalls = getPendingToolCallsFromMessages();
  if (runtime.callActive && pendingToolCalls.length > 0) {
    runtime.toolCallCount = Math.max(runtime.toolCallCount || 0, pendingToolCalls.length);
    if (!Array.isArray(runtime.activeToolNames) || runtime.activeToolNames.length === 0) {
      runtime.activeToolNames = pendingToolCalls
        .map((call) => String(call?.name || '').trim())
        .filter(Boolean);
      runtime.activeToolCount = runtime.activeToolNames.length;
    }
    if (runtime.stage === 'awaiting_runtime' || runtime.stage === 'idle') {
      runtime.stage = runtime.activeToolCount > 0 ? 'tool_executing' : 'awaiting_runtime';
    }
  }

  // llm.complete 且无 pending tool calls：call 即将结束，不要显示 awaiting_runtime
  if (stateType === 'llm.complete' && pendingToolCalls.length === 0 && runtime.callActive) {
    runtime.stage = 'completed';
  }

  const rememberedHadToolPhase = remembered
    && (remembered.stage === 'tool_executing'
      || remembered.stage === 'llm_tool_call_building'
      || remembered.toolCallCount > 0);
  const currentHasToolSignals = runtime.toolCallCount > 0
    || runtime.activeToolCount > 0
    || runtime.stage === 'tool_executing'
    || runtime.stage === 'llm_tool_call_building';
  if (runtime.callActive
    && runtime.stage === 'awaiting_runtime'
    && (currentHasToolSignals || rememberedHadToolPhase)) {
    runtime.stage = runtime.activeToolCount > 0 ? 'tool_executing' : 'awaiting_runtime';
  }

  if (remembered && runtime.callStartedAt <= 0 && remembered.callStartedAt > 0) {
    runtime.callStartedAt = remembered.callStartedAt;
  }
  if (runtime.callActive && runtime.callStartedAt <= 0) {
    runtime.callStartedAt = remembered?.callStartedAt || runtime.updatedAt || Date.now();
  }

  if (remembered && runtime.stageStartedAt <= 0 && remembered.stage === runtime.stage && remembered.stageStartedAt > 0) {
    runtime.stageStartedAt = remembered.stageStartedAt;
  }
  if (runtime.stageStartedAt <= 0) {
    runtime.stageStartedAt = remembered?.stage === runtime.stage
      ? (remembered.stageStartedAt || runtime.updatedAt || Date.now())
      : (runtime.updatedAt || Date.now());
  }

  if (!runtime.callActive && stateType === 'call.finish') {
    runtime.stage = runtime.stage === 'failed' ? 'failed' : 'completed';
  }

  if (runtime.callActive) {
    _runtimeStatusMemory.set(runtimeId, {
      callStartedAt: runtime.callStartedAt,
      stage: runtime.stage,
      stageStartedAt: runtime.stageStartedAt,
      toolCallCount: runtime.toolCallCount,
    });
  } else if (runtime.stage === 'completed' || runtime.stage === 'failed') {
    _runtimeStatusMemory.set(runtimeId, {
      callStartedAt: runtime.callStartedAt || remembered?.callStartedAt || Date.now(),
      stage: runtime.stage,
      stageStartedAt: runtime.stageStartedAt || remembered?.stageStartedAt || Date.now(),
      toolCallCount: runtime.toolCallCount,
    });
  } else {
    _runtimeStatusMemory.delete(runtimeId);
  }
  return runtime;
}

function getRuntimeSummary(runtime, isConnected = true) {
  if (!isConnected) {
    return t('runtime_status_disconnected');
  }
  if (runtime.stage === 'llm_thinking') {
    return t('runtime_status_thinking_active');
  }
  if (runtime.stage === 'llm_content') {
    return t('runtime_status_streaming_active');
  }
  if (runtime.stage === 'llm_tool_call_building') {
    return t('runtime_status_building_tools');
  }
  if (runtime.stage === 'tool_executing') {
    const toolSummary = summarizeRuntimeToolNames(runtime.activeToolNames);
    return toolSummary
      ? `${t('runtime_status_executing_tools')} · ${toolSummary}`
      : t('runtime_status_executing_tools');
  }
  if (runtime.stage === 'retry_waiting') {
    return t('runtime_status_retry_waiting');
  }
  if (runtime.stage === 'retry_requesting') {
    return t('runtime_status_retry_requesting');
  }
  if (runtime.stage === 'failed') {
    return runtime.lastErrorMessage || t('runtime_status_failed');
  }
  if (runtime.stage === 'completed') {
    return t('runtime_status_completed');
  }
  if (runtime.callActive) {
    if ((runtime.toolCallCount > 0 || runtime.activeToolCount > 0) && runtime.activeToolCount === 0) {
      return t('runtime_status_waiting_tool_results');
    }
    if (runtime.charCount === 0 && runtime.contentChars === 0 && runtime.thinkingChars === 0) {
      return t('runtime_status_waiting_model');
    }
    const freshnessMs = runtime.updatedAt > 0 ? Math.max(0, Date.now() - runtime.updatedAt) : 0;
    if (freshnessMs >= 8000) {
      return t('runtime_status_stale');
    }
    return t('runtime_status_processing');
  }
  return '';
}

function getRuntimeTimerLabel(runtime) {
  const now = Date.now();
  if (runtime.stageStartedAt > 0) {
    return formatRuntimeDuration(now - runtime.stageStartedAt);
  }
  return '0s';
}

function renderRuntimeTimer(runtime, isConnected = true) {
  const toneClass = !isConnected || runtime.stage === 'failed' ? 'alert' : '';
  return `<span class="notification-metric ${toneClass}"><span class="notification-metric-value">${escapeHtml(getRuntimeTimerLabel(runtime))}</span></span>`;
}

function refreshNotificationTimerDisplay() {
  const statusEl = document.getElementById('notification-status');
  const metricsEl = document.getElementById('notification-metrics');
  if (!statusEl || !metricsEl) return;
  if (statusEl.style.display === 'none') return;
  if (!_lastRenderedNotificationRuntime) return;
  metricsEl.innerHTML = renderRuntimeTimer(_lastRenderedNotificationRuntime, currentRuntimeConnected);
}

function ensureNotificationClockTimer() {
  if (_notificationClockTimer) return;
  _notificationClockTimer = window.setInterval(() => {
    refreshNotificationTimerDisplay();
  }, 200);
}

function getRuntimeStageClass(runtime) {
  return `stage-${String(runtime?.stage || 'idle').replace(/[^a-z0-9_-]/gi, '-')}`;
}

function shouldShowRuntimeStatus(runtime, stateType = '') {
  if (runtime.callActive && runtime.stage !== 'idle' && runtime.stage !== 'completed' && runtime.stage !== 'failed') {
    return true;
  }
  const settledRecently = runtime.updatedAt > 0 && (Date.now() - runtime.updatedAt) < (runtime.stage === 'failed' ? 8000 : 800);
  return ((runtime.stage === 'completed' || runtime.stage === 'failed') && settledRecently)
    || stateType === 'llm.char_count';
}

function shouldStatusUseQueueSync(runtime) {
  return runtime.stage === 'llm_thinking'
    || runtime.stage === 'llm_content'
    || runtime.stage === 'llm_tool_call_building';
}

function getInputSurfaceMode(requests = currentInputRequests || []) {
  const chatActive = isChatSurfaceActive();
  if (!chatActive) return 'hidden';
  if (readOnlyMode) return 'readonly';

  const hasRuntimeSelected = !!currentRuntimeAgentId;
  const hasRequests = Array.isArray(requests) && requests.length > 0;
  const hasChoiceRequest = hasRequests && requests.some(isChoiceInputRequest);
  if (hasChoiceRequest) {
    return 'requests';
  }

  const hasLocalQueuedInput = hasRuntimeSelected
    && (_localQueuedInputPending || _pendingQueuedCount > 0 || _queuedTexts.length > 0);

  if (hasLocalQueuedInput && hasRuntimeSelected) {
    return 'persistent';
  }
  if (hasRequests) {
    return 'requests';
  }
  if (hasRuntimeSelected && isRuntimeCalling(currentRuntimeAgentId)) {
    return 'persistent';
  }
  if (hasRuntimeSelected) {
    return 'persistent';
  }
  return 'hidden';
}

function renderSidebarChildItems(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  return `
    <div class="agent-runtime-list">
      ${entries.map((entry) => {
        const active = isRuntimeItemActive(entry.runtimeId);
        const disconnected = entry.status === 'disconnected';
        const calling = !disconnected && isRuntimeCalling(entry.runtimeId);
        const restarting = restartingRuntimeIds.has(entry.runtimeId);
        const itemClass = [
          'agent-item',
          'agent-runtime-item',
          active ? 'active' : '',
          disconnected ? 'disconnected' : '',
          calling ? 'calling' : '',
          restarting ? 'restarting' : '',
        ].filter(Boolean).join(' ');
        return `
          <div
            class="${itemClass}"
            data-agent-id="${escapeHtml(entry.runtimeId)}"
            data-agent-prebuilt="false"
            data-agent-context-menu="${entry.contextMenuEnabled ? 'true' : 'false'}"
            data-ctx-role="runtime" data-ctx-ns="${escapeHtml(entry.ownerId || '')}" data-ctx-id="${escapeHtml(entry.runtimeId)}" data-ctx-variant="${escapeHtml(entry.source || '')}" data-ctx-session-id="${escapeHtml(entry.sessionId || '')}"
          >
            <div class="agent-line">
              <span class="agent-status-dot"></span>
              <div class="agent-name">${escapeHtml(entry.name || entry.runtimeId)}</div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

const AGENT_ICONS = {
  'home': 'home.svg',
  'flow-workspace': 'flow-workspace.svg',
  'feature-repository': 'feature-repository.svg',
  'feature-creator': 'feature-creator.svg',
  'qqbot': 'qqbot.svg',
  'dispatch-console': 'dispatch-console.svg',
  'programming-helper': 'programming-helper.svg',
  'feature-setup': 'feature-setup.svg',
};

let currentRuntimeConnected = true;
let lastNotificationStatusPayload = null;
const _runtimeStatusMemory = new Map();
let _lastRenderedNotificationRuntime = null;
let _notificationClockTimer = null;

function getAgentIconHtml(agentId) {
  const iconFile = AGENT_ICONS[agentId];
  if (!iconFile) return '<span class="agent-status-dot"></span>';
  return `<img class="agent-icon" src="images/agent-icons/${iconFile}" alt="" draggable="false" />`;
}

function renderAgentGroup(listElement, groupElement, countElement, agents, options = {}) {
  const { prebuilt = false } = options;
  groupElement.style.display = agents.length ? '' : 'none';
  countElement.textContent = String(agents.length);
  listElement.innerHTML = agents.map((agent) => {
    const active = isAgentActive(agent);
    const connected = agent.connected !== false;
    const pending = pendingPrebuiltAgentIds.has(agent.id);
    const workspaceSurface = isWorkspaceSurfaceUnit(agent);
    const idle = prebuilt && !pending && !(agent.runtime_session_id || agent.runtimeSessionId);
    const runtimeId = agent.runtime_session_id || agent.runtimeSessionId || agent.id;
    const calling = !prebuilt
      && connected
      && !pending
      && !idle
      && (isRuntimeCalling(runtimeId) || agent.callActive === true);
    const itemClass = [
      'agent-item',
      active ? 'active' : '',
      connected || prebuilt ? '' : 'disconnected',
      pending ? 'pending' : '',
      idle ? 'idle' : '',
      calling ? 'calling' : '',
    ].filter(Boolean).join(' ');
    const hasRuntime = !!(agent.runtime_session_id || agent.runtimeSessionId);
    const contextMenuEnabled = prebuilt
      ? (!workspaceSurface && hasRuntime)
      : !!(agent.runtime_session_id || agent.runtimeSessionId || agent.id);
    const childEntries = prebuilt ? collectRuntimeEntriesForPrebuilt(agent, allAgents) : [];
    const hasActiveRuntime = prebuilt && childEntries.some((entry) => isRuntimeItemActive(entry.runtimeId));
    if (prebuilt) {
      const childrenHtml = renderSidebarChildItems(childEntries);
      const entryClass = ['agent-entry', hasActiveRuntime ? 'has-active-runtime' : ''].filter(Boolean).join(' ');
      return `
        <div class="${entryClass}">
          <div
            class="${itemClass}"
            data-agent-id="${escapeHtml(agent.id)}"
            data-agent-prebuilt="true"
            data-agent-context-menu="${contextMenuEnabled ? 'true' : 'false'}"
          >
            <div class="agent-line">
              ${getAgentIconHtml(agent.id)}
              <div class="agent-name">${escapeHtml(agent.name || agent.id)}</div>
            </div>
          </div>
          ${childrenHtml}
        </div>
      `;
    }
    return `
      <div
        class="${itemClass}"
        data-agent-id="${escapeHtml(agent.id)}"
        data-agent-prebuilt="false"
        data-agent-context-menu="${contextMenuEnabled ? 'true' : 'false'}"
      >
        <div class="agent-line">
          <span class="agent-status-dot"></span>
          <div class="agent-name">${escapeHtml(agent.name || agent.id)}</div>
        </div>
      </div>
    `;
  }).join('');
}

async function waitForPrebuiltRuntimeSession(agentId, attempts = 20, options = {}) {
  const expectedRuntimeId = normalizeAgentIdentity(options.previousRuntimeId);
  const expectedSessionId = String(options.expectedSessionId || '').trim();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const agents = await invoke('get_connected_agents');
    const findConnectedChild = (list) => list.find((agent) => {
      if (agent.source !== 'child' || agent.parent_id !== agentId) return false;
      const runtimeId = normalizeAgentIdentity(agent.runtime_session_id || agent.runtimeSessionId || agent.id);
      if (!runtimeId) return false;
      if (expectedRuntimeId && runtimeId === expectedRuntimeId) return false;
      // When we know the target session ID, require the child to either
      // match it or have no session set yet (still initializing).
      if (expectedSessionId) {
        const childSessionId = String(agent.active_workspace_session_id || '').trim();
        if (childSessionId && childSessionId !== expectedSessionId) return false;
      }
      return agent.connected === true;
    });
    const matched = findConnectedChild(agents);
    if (matched) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const verify = await invoke('get_connected_agents');
      const still = findConnectedChild(verify);
      if (still) {
        // Merge verify into allAgents without clobbering workspace data.
        // get_connected_agents returns empty workspace_state, workspace_data,
        // and workspace_sessions.sessions for prebuilt agents, so we must
        // preserve the rich data loaded by loadAgentDetail.
        const prevById = new Map(allAgents.map(a => [a.id, a]));
        allAgents = verify.map(agent => {
          const prev = prevById.get(agent.id);
          if (!prev) return agent;
          return {
            ...agent,
            workspace_state: prev.workspace_state || agent.workspace_state,
            workspace_data: prev.workspace_data || agent.workspace_data,
            workspace_sessions: prev.workspace_sessions || agent.workspace_sessions,
          };
        });
        return still;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for runtime session: ${agentId}`);
}

async function loadAgents() {
  if (loadAgentsInFlight) {
    return loadAgentsInFlight;
  }
  const _t0 = performance.now();
  const task = (async () => {
  try {
    const [connectedAgents, res] = await Promise.all([
      invoke('get_connected_agents'),
      fetch('/api/agents'),
    ]);
    const data = res.ok ? await res.json().catch(() => ({ agents: [], currentAgentId: null })) : { agents: [], currentAgentId: null };
    const runtimeAgents = data.agents || [];
    const runtimeById = new Map(runtimeAgents.map((agent) => [agent.id, agent]));
    const prevByAgentId = new Map(allAgents.map((a) => [a.id, a]));

    if (connectedAgents.length === 0) {
      allAgents = runtimeAgents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        description: agent.description || '',
        status: agent.connected ? 'running' : 'stopped',
        source: 'external',
        parent_id: agent.parentAgentId || null,
        connection_info: agent.connectionInfo || 'viewer://127.0.0.1:2026',
        pid: agent.pid || null,
        runtime_session_id: agent.id,
        message_count: agent.messageCount ?? 0,
        created_at: agent.createdAt || null,
        connected: agent.connected ?? false,
      }));
    } else {
      allAgents = connectedAgents.map((agent) => {
        const runtimeSessionId = agent.runtime_session_id || agent.runtimeSessionId;
        const runtimeAgent = runtimeSessionId ? runtimeById.get(runtimeSessionId) : runtimeById.get(agent.id);
        const resolvedConnected = runtimeAgent?.connected ?? agent.connected ?? false;
        const prev = prevByAgentId.get(agent.id);
        return {
          ...agent,
          status: resolvedConnected ? 'running' : (agent.status || 'stopped'),
          message_count: runtimeAgent?.messageCount ?? agent.message_count ?? 0,
          connected: resolvedConnected,
          ...(prev && loadedAgentDetailIds.has(agent.id) ? {
            workspace_data: prev.workspace_data,
            workspace_state: prev.workspace_state,
            // Preserve prev sessions (get_connected_agents always returns
            // sessions: []), but merge in any fresh activeSessionId from
            // the server so activation changes are reflected.
            workspace_sessions: {
              ...(prev.workspace_sessions || {}),
              ...(agent.workspace_sessions?.activeSessionId
                && agent.workspace_sessions.activeSessionId !== prev.workspace_sessions?.activeSessionId
                ? { activeSessionId: agent.workspace_sessions.activeSessionId }
                : {}),
            },
          } : {}),
          // 当新数据的 workspace_sessions.sessions 为空但旧数据有值时，保留旧 sessions 避免闪空
          ...(!loadedAgentDetailIds.has(agent.id) && prev?.workspace_sessions?.sessions?.length > 0
            && !(agent.workspace_sessions?.sessions?.length > 0) ? {
              workspace_sessions: prev.workspace_sessions,
            } : {}),
        };
      });
    }

    // 清理已断开 agent 的 call 状态
    const activeRuntimeIds = new Set(allAgents.filter((a) => a.connected).map((a) => a.runtime_session_id || a.runtimeSessionId || a.id));
    for (const key of _agentCallActive.keys()) {
      if (!activeRuntimeIds.has(key)) _agentCallActive.delete(key);
    }

    if (!suppressSidebarRerender) {
      renderAgentList();
      renderFeaturePanel();
    }

    await refreshAgentCallStates(allAgents, { force: true });

    if (currentAgentId && !allAgents.some((agent) => agent.id === currentAgentId || getAgentRuntimeId(agent) === currentAgentId)) {
      const fallbackId = resolveWorkspaceFallbackAgentId();
      if (fallbackId) {
        await loadAgentDetail(fallbackId);
        selectWorkspaceSurface(fallbackId, { skipFeaturePanel: true });
        return;
      }
    }

    if (!currentAgentId) {
      const homeAgent = allAgents.find((agent) => agent.id === 'home' && agent.source === 'prebuilt');
      if (homeAgent) {
        setPreferredUnitMode('home', homeAgent);
        await loadAgentDetail(homeAgent.id);
        selectWorkspaceSurface(homeAgent.id, { skipFeaturePanel: true });
        return;
      }
      if (data.currentAgentId) {
        const runtimeCurrent = allAgents.find((agent) => (
          agent.connected !== false
          && (
            agent.id === data.currentAgentId
            || normalizeAgentIdentity(agent.runtime_session_id || agent.runtimeSessionId) === normalizeAgentIdentity(data.currentAgentId)
          )
        )) || null;
        if (runtimeCurrent) {
          currentAgentId = runtimeCurrent.parent_id || runtimeCurrent.id;
          await loadAgentData(getAgentRuntimeId(runtimeCurrent));
          return;
        }
      }
    }
  } catch (e) {
    console.error('Failed to load agents:', e);
  }
  })();
  loadAgentsInFlight = task;
  try {
    return await task;
  } finally {
    if (loadAgentsInFlight === task) {
      loadAgentsInFlight = null;
      console.log(`[PERF-CLIENT] loadAgents complete (${(performance.now() - _t0).toFixed(0)}ms)`);
    }
  }
}

async function refreshAgentCallStates(agents = allAgents, options = {}) {
  const { force = false } = options;
  const now = Date.now();
  if (!force && now - lastCallStateRefreshAt < 1000) {
    return;
  }
  lastCallStateRefreshAt = now;

  const runtimeIds = Array.from(new Set(
    (Array.isArray(agents) ? agents : [])
      .filter((agent) => agent?.connected)
      .map((agent) => agent.runtime_session_id || agent.runtimeSessionId || agent.id)
      .filter(Boolean)
  ));
  if (runtimeIds.length === 0) {
    let changed = false;
    for (const key of Array.from(_agentCallActive.keys())) {
      _agentCallActive.delete(key);
      changed = true;
    }
    if (changed) {
      renderAgentList();
    }
    return;
  }

  const nextCallStates = new Map();
  await Promise.all(runtimeIds.map(async (runtimeId) => {
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(runtimeId)}/notification`);
      if (!res.ok) return;
      const notifData = await res.json();
      nextCallStates.set(runtimeId, resolveNotificationCallingState(notifData));
    } catch (error) {
    }
  }));

  let changed = false;
  for (const runtimeId of runtimeIds) {
    const backendCalling = nextCallStates.get(runtimeId) === true;
    const prevCalling = _agentCallActive.get(runtimeId) === true;
    if (backendCalling) {
      _agentCallActive.set(runtimeId, true);
    } else {
      _agentCallActive.delete(runtimeId);
    }
    if (prevCalling !== backendCalling) {
      changed = true;
    }
  }

  const activeRuntimeIds = new Set(runtimeIds);
  for (const key of Array.from(_agentCallActive.keys())) {
    if (!activeRuntimeIds.has(key)) {
      _agentCallActive.delete(key);
      changed = true;
    }
  }

  for (const agent of Array.isArray(agents) ? agents : []) {
    if (agent?.source === 'prebuilt') {
      if (agent.callActive) {
        agent.callActive = false;
        changed = true;
      }
      continue;
    }
    const runtimeId = agent.runtime_session_id || agent.runtimeSessionId || agent.id;
    if (!runtimeId) continue;
    const nextCalling = nextCallStates.get(runtimeId) === true;
    if (agent.callActive !== nextCalling) {
      agent.callActive = nextCalling;
      changed = true;
    }
  }

  if (changed) {
    renderAgentList();
  }
}

let lastAgentListRenderSignature = '';

function getAgentListRenderSignature() {
  return JSON.stringify({
    currentAgentId: normalizeAgentIdentity(currentAgentId),
    currentRuntimeAgentId: normalizeAgentIdentity(currentRuntimeAgentId),
    pending: Array.from(pendingPrebuiltAgentIds || []).sort(),
    restarting: Array.from(restartingRuntimeIds || []).sort(),
    agents: (Array.isArray(allAgents) ? allAgents : []).map((agent) => ({
      id: normalizeAgentIdentity(agent?.id),
      runtimeId: normalizeAgentIdentity(getAgentRuntimeId(agent)),
      source: agent?.source || '',
      parentId: normalizeAgentIdentity(agent?.parent_id),
      connected: agent?.connected !== false,
      status: agent?.status || '',
      callActive: agent?.callActive === true,
      activeSessionId: normalizeAgentIdentity(agent?.active_workspace_session_id || agent?.workspace_sessions?.activeSessionId),
      displayName: agent?.active_workspace_display_name || '',
      sessionTitle: agent?.active_workspace_session_title || '',
    })),
  });
}

function renderAgentList() {
  const nextSignature = getAgentListRenderSignature();
  if (nextSignature === lastAgentListRenderSignature) {
    updateCurrentAgentChrome();
    return;
  }
  lastAgentListRenderSignature = nextSignature;
  const groups = groupConnectedAgents(allAgents);
  renderAgentGroup(prebuiltAgentList, prebuiltGroup, prebuiltCount, groups.prebuilt, { prebuilt: true });
  renderAgentGroup(toolAgentList, toolGroup, toolCount, groups.tool, { prebuilt: true });
  renderAgentGroup(externalAgentList, externalGroup, externalCount, groups.external);

  updateCurrentAgentChrome();
}

agentList.addEventListener('click', async (event) => {
  const item = event.target.closest('.agent-item');
  if (!item) return;

  const agentId = item.dataset.agentId;
  if (!agentId) return;

  if (item.dataset.agentPrebuilt === 'true') {
    await window.handlePrebuiltAgentClick(agentId);
    return;
  }

  await window.switchAgent(agentId);
});

agentList.addEventListener('contextmenu', (event) => {
  const item = event.target.closest('.agent-item');
  if (!item) return;
  if (item.dataset.agentContextMenu !== 'true') return;

  // ── Generic ctx-menu: check for data-ctx-* on runtime items ──
  const ctxEl = item.closest('[data-ctx-role]');
  if (ctxEl) {
    const role = ctxEl.dataset.ctxRole;
    const ns = ctxEl.dataset.ctxNs;
    const id = ctxEl.dataset.ctxId;
    const variant = ctxEl.dataset.ctxVariant || 'default';
    const items = getCtxMenuItems(role, ns, variant, id);
    if (items.length > 0) {
      event.preventDefault();
      window.closeCtxMenu();
      closeAgentContextMenu();
      closeSessionContextMenu();
      closeCompactMenu();
      closeProjectContextMenu();
      const sessionId = ctxEl.dataset.ctxSessionId || '';
      window.showCtxMenu(event.clientX, event.clientY, items, { role, ns, id, variant, sessionId });
      return;
    }
  }

  const agentId = item.dataset.agentId;
  if (!agentId) return;

  event.preventDefault();
  window.openAgentActions(event, agentId);
});

window.handlePrebuiltAgentClick = async (agentId) => {
  closeAgentContextMenu();
  const prebuiltAgent = allAgents.find((agent) => agent.id === agentId && agent.source === 'prebuilt');
  if (!prebuiltAgent) return;
  if (!isWorkspaceHostUnit(prebuiltAgent)) {
    setPreferredUnitMode('home', prebuiltAgent);
  }

  if (isWorkspaceHostUnit(prebuiltAgent)) {
    currentAgentId = agentId;
    renderAgentList();
    if (!loadedAgentDetailIds.has(agentId)) {
      container.innerHTML = '<div class="workspace-surface" style="display:grid;place-items:center;color:var(--text-secondary);font-size:14px;">' + escapeHtml(currentLanguage === 'zh' ? '加载中...' : 'Loading...') + '</div>';
    }
    await loadAgentDetail(prebuiltAgent.id);
    selectWorkspaceSurface(prebuiltAgent.id, { skipFeaturePanel: true });
    return;
  }

  if (isWorkspaceSurfaceUnit(prebuiltAgent)) {
    currentAgentId = agentId;
    renderAgentList();
    if (!loadedAgentDetailIds.has(agentId)) {
      container.innerHTML = '<div class="workspace-surface" style="display:grid;place-items:center;color:var(--text-secondary);font-size:14px;">' + escapeHtml(currentLanguage === 'zh' ? '加载中...' : 'Loading...') + '</div>';
    }
    await loadAgentDetail(prebuiltAgent.id);
    selectWorkspaceSurface(prebuiltAgent.id, { skipFeaturePanel: true });
    return;
  }

  const runtimeSessionId = prebuiltAgent.runtime_session_id || prebuiltAgent.runtimeSessionId;
  if (runtimeSessionId) {
    await window.switchAgent(runtimeSessionId);
    return;
  }

  if (pendingPrebuiltAgentIds.has(agentId)) {
    return;
  }

  pendingPrebuiltAgentIds.add(agentId);
  statusBadge.textContent = t('status_starting');
  statusBadge.classList.remove('disconnected');
  renderAgentList();

  try {
    await invoke('start_agent', { agentId });
    const startedAgent = await waitForPrebuiltRuntimeSession(agentId);
    pendingPrebuiltAgentIds.delete(agentId);
    renderAgentList();
    const nextRuntimeId = startedAgent.runtime_session_id || startedAgent.runtimeSessionId || startedAgent.id;
    setPreferredUnitMode('home', allAgents.find((agent) => agent.id === agentId && agent.source === 'prebuilt') || startedAgent);
    await requestSwitch(nextRuntimeId, 'prebuilt-start');
  } catch (e) {
    pendingPrebuiltAgentIds.delete(agentId);
    renderAgentList();
    console.error('Failed to start prebuilt agent:', e);
    showAgentStartError(e);
  }
};

async function openPrebuiltWorkspaceSession(agentId, rawAction) {
  const action = typeof rawAction === 'string' ? JSON.parse(rawAction) : (rawAction || {});
  const endpoint = (action.type === 'create_session' || action.type === 'create_session_from_session')
    ? '/protoclaw/prebuilt_sessions'
    : '/protoclaw/prebuilt_sessions/activate';
  const payload = (action.type === 'create_session' || action.type === 'create_session_from_session')
    ? {
        agentId,
        sourceSessionId: action.sessionId || null,
        featureName: action.featureName || '',
        agentName: action.agentName || '',
        openDirectory: action.openDirectory || '',
        targetDir: action.targetDir || '',
      }
    : { agentId, sessionId: action.sessionId };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(await response.text().catch(() => 'session operation failed'));
  }
  return response.json();
}

function applyOptimisticWorkspaceSession(agentId, session) {
  if (!agentId || !session?.id) return null;
  const hostAgent = allAgents.find((agent) => agent.id === agentId) || null;
  const existingSessions = Array.isArray(hostAgent?.workspace_sessions?.sessions)
    ? hostAgent.workspace_sessions.sessions
    : [];
  const nextSessions = [session, ...existingSessions.filter((item) => item?.id !== session.id)];
  return updateAgentRecord(agentId, {
    workspace_sessions: {
      ...(hostAgent?.workspace_sessions || {}),
      activeSessionId: session.id,
      sessions: nextSessions,
    },
    active_workspace_session_id: session.id,
    active_workspace_session_form_id: session.formId || null,
    active_workspace_session_title: session.title || '',
    active_workspace_agent_name: session.agentName || '',
    active_workspace_display_name: session.formId === 'assembly-form'
      ? (session.agentName || session.title || '')
      : (hostAgent?.active_workspace_display_name || ''),
  });
}

async function createCompactedResumeSession(agentId, sessionId, strategy = 'summarized-nine-section', keepRecentTurns = null, fullPreserveFromTurn = null, extraPolicy = null) {
  const currentAgent = getCurrentAgentRecord();
  const activeSessionId = String(currentAgent?.active_workspace_session_id || currentAgent?.workspace_sessions?.activeSessionId || '').trim();
  const runtimeAgentId = currentRuntimeAgentId || currentAgent?.runtime_session_id || currentAgent?.runtimeSessionId || '';
  const isLiveCurrentSession = !!runtimeAgentId
    && String(currentAgent?.id || '').trim() === String(agentId || '').trim()
    && activeSessionId
    && activeSessionId === String(sessionId || '').trim();

  // Only use live-runtime shortcut for summary; trim (empty strategy) goes server-side
  if (isLiveCurrentSession && strategy) {
    const inputReqRes = await fetch(`/api/agents/${encodeURIComponent(runtimeAgentId)}/input-requests`);
    const inputRequests = inputReqRes.ok ? await inputReqRes.json().catch(() => []) : [];
    const primaryRequest = Array.isArray(inputRequests) ? inputRequests[0] : null;
    if (!primaryRequest?.requestId) {
      throw new Error('当前运行中的对话没有可用输入槽位，无法触发压缩续接');
    }
    const submitRes = await fetch(`/api/agents/${encodeURIComponent(runtimeAgentId)}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: primaryRequest.requestId,
        input: '/compact-summary-resume',
        response: {
          kind: 'text',
          text: '/compact-summary-resume',
        },
      }),
    });
    if (!submitRes.ok) {
      throw new Error(await submitRes.text().catch(() => 'failed to submit compact summary command'));
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await loadAgents();
      const refreshed = allAgents.find((item) => String(item?.id || '').trim() === String(agentId || '').trim()) || null;
      const nextSessionId = String(refreshed?.active_workspace_session_id || refreshed?.workspace_sessions?.activeSessionId || '').trim();
      const nextRuntimeId = refreshed?.runtime_session_id || refreshed?.runtimeSessionId || null;
      if (nextSessionId && nextSessionId !== String(sessionId || '').trim() && nextRuntimeId) {
        await requestSwitch(nextRuntimeId, 'compact-resume-live');
        return { scheduled: true, liveRuntime: true, switched: true };
      }
    }
    return { scheduled: true, liveRuntime: true, switched: false };
  }

  const policy = strategy ? { strategy } : {};
  if (keepRecentTurns != null && keepRecentTurns >= 1) {
    policy.keepRecentTurns = keepRecentTurns;
  }
  if (fullPreserveFromTurn != null && fullPreserveFromTurn >= 0) {
    policy.fullPreserveFromTurn = fullPreserveFromTurn;
  }
  if (extraPolicy && typeof extraPolicy === 'object') {
    Object.assign(policy, extraPolicy);
  }
  const resumeResponse = await fetch('/protoclaw/context_handoffs/compact_and_resume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId,
      sessionId,
      detached: false,
      policy,
    }),
  });
  if (!resumeResponse.ok) {
    throw new Error(await resumeResponse.text().catch(() => 'compacted resume failed'));
  }

  return resumeResponse.json();
}

window.switchPhSessionTab = (btn) => {
  const tabGroup = btn.closest('.ph-session-tabs');
  if (!tabGroup) return;
  const targetTab = btn.dataset.phTab;
  tabGroup.querySelectorAll('.ph-session-tab').forEach((t) => t.classList.toggle('active', t.dataset.phTab === targetTab));
  tabGroup.querySelectorAll('.ph-session-tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.phPanel === targetTab));
  if (tabGroup.dataset.tabGroup) {
    savedPhTabState[tabGroup.dataset.tabGroup] = targetTab;
  }
};

window.runWorkspaceAction = async (rawAction, triggerButton = undefined) => {
  let action = rawAction || {};
  if (typeof rawAction === 'string') {
    try {
      action = JSON.parse(rawAction);
    } catch {
      action = {};
    }
  }

  const activeAgent = getCurrentAgentRecord();
  const hasSessions = hasWorkspaceSessions(activeAgent);
  if (action.type === 'open_latest_session') {
    if (activeAgent?.id === 'feature-creator') {
      const projects = getFeatureCreatorProjects(activeAgent);
      const latestProject = projects[0] || null;
      if (!latestProject) {
        return;
      }
      action = latestProject.latestSessionId
        ? { type: 'open_session', sessionId: latestProject.latestSessionId }
        : {
            type: 'create_session',
            featureName: latestProject.featureName || '',
            openDirectory: latestProject.openDirectory || '',
            targetDir: latestProject.targetDir || '',
          };
    } else if (activeAgent?.id === 'agent-creator') {
      const projects = getAgentCreatorProjects(activeAgent);
      const latestProject = projects[0] || null;
      if (!latestProject) {
        return;
      }
      action = latestProject.latestSessionId
        ? { type: 'open_session', sessionId: latestProject.latestSessionId }
        : {
            type: 'create_session',
            agentName: latestProject.agentName || '',
            openDirectory: latestProject.openDirectory || '',
            targetDir: latestProject.targetDir || '',
          };
    } else {
      const sessions = getWorkspaceSessions(activeAgent);
      if (sessions.length > 0) {
        action = { type: 'open_session', sessionId: sessions[0].id };
      } else {
        return;
      }
    }
  }

  if (action.type === 'navigate_unit' && action.targetAgentId) {
    await window.handlePrebuiltAgentClick(action.targetAgentId);
    return;
  }

  if (action.type === 'prime_workspace_form') {
    const formId = String(action.formId || '');
    const values = action.values && typeof action.values === 'object' ? action.values : {};
    if (activeAgent?.id) {
      const draft = getWorkspaceFormDraft(activeAgent);
      draft[formId] = normalizeWorkspaceStartupDraft(activeAgent, {
        ...(draft[formId] || {}),
        ...values,
      });
      saveWorkspaceFormDraft(activeAgent.id, draft);
    }
    setPreferredUnitMode(action.target ? `block:${String(action.target)}` : `block:${formId}`, activeAgent);
    renderCurrentMainView();
    return;
  }

  if (action.type === 'open_artifact_preview') {
    currentWorkspaceArtifactDetail = {
      agentId: activeAgent?.id || '',
      blockId: String(action.blockId || ''),
      artifactId: String(action.artifactId || ''),
    };
    renderCurrentMainView();
    return;
  }

  if (action.type === 'close_artifact_preview') {
    if (currentWorkspaceArtifactDetail && currentWorkspaceArtifactDetail.agentId === (activeAgent?.id || '') && currentWorkspaceArtifactDetail.blockId === String(action.blockId || '')) {
      currentWorkspaceArtifactDetail = null;
    }
    renderCurrentMainView();
    return;
  }

  if (action.type === 'open_project_docset_preview') {
    currentWorkspaceDocsetDetail = {
      agentId: activeAgent?.id || '',
      blockId: String(action.blockId || ''),
      section: String(action.section || ''),
      itemId: String(action.itemId || ''),
    };
    renderCurrentMainView();
    return;
  }

  if (action.type === 'close_project_docset_preview') {
    if (currentWorkspaceDocsetDetail && currentWorkspaceDocsetDetail.agentId === (activeAgent?.id || '') && currentWorkspaceDocsetDetail.blockId === String(action.blockId || '')) {
      currentWorkspaceDocsetDetail = null;
    }
    renderCurrentMainView();
    return;
  }

  if (action.type === 'apply_workspace_bundle') {
    await window.applyWorkspaceBundle(action.formId || 'assembly-form', action.bundle || {});
    return;
  }

  if (action.type === 'launch_assembly_instance') {
    await window.launchAssemblyInstance();
    return;
  }

  if (action.type === 'compacted_resume_session') {
    if (!activeAgent?.id || !action.sessionId) return;
    const confirmed = window.confirm(t('workspace_compacted_resume_confirm'));
    if (!confirmed) {
      return;
    }

    try {
      const result = await createCompactedResumeSession(activeAgent.id, action.sessionId);
      if (result?.agent) {
        applyManagedPrebuiltAgent(activeAgent.id, result.agent);
      }
      await loadAgents();
      const nextRuntimeId =
        result?.agent?.runtime_session_id
        || result?.agent?.runtimeSessionId
        || null;
      if (nextRuntimeId) {
        setPreferredUnitMode('chat', allAgents.find((agent) => agent.id === activeAgent.id) || activeAgent);
        await requestSwitch(nextRuntimeId, 'compact-resume');
      } else {
        lastRenderedWorkspaceHtml = '';
        renderCurrentMainView();
      }
    } catch (error) {
      console.error('Failed to compact-resume session:', error);
      window.alert(t('workspace_compacted_resume_failed') + (error && error.message ? error.message : error));
    }
    return;
  }

  if (action.type === 'compact_session_menu') {
    if (!activeAgent?.id || !action.sessionId) return;
    const compactType = action.compactType || 'summary';

    if (compactType === 'trim') {
      window.openTrimDialog(activeAgent.id, action.sessionId);
      return;
    }

    const strategy = 'summarized-nine-section';
    const confirmMsg = t('workspace_compact_summary_confirm');
    const confirmed = window.confirm(confirmMsg);
    if (!confirmed) {
      return;
    }

    markSessionLoading(activeAgent.id, action.sessionId);
    try {
      const result = await createCompactedResumeSession(activeAgent.id, action.sessionId, strategy);
      if (result?.agent) {
        applyManagedPrebuiltAgent(activeAgent.id, result.agent);
      }
      await loadAgents();
      const nextRuntimeId =
        result?.agent?.runtime_session_id
        || result?.agent?.runtimeSessionId
        || null;
      if (nextRuntimeId) {
        setPreferredUnitMode('chat', allAgents.find((agent) => agent.id === activeAgent.id) || activeAgent);
        await requestSwitch(nextRuntimeId, 'compact-summary');
      } else {
        lastRenderedWorkspaceHtml = '';
        renderCurrentMainView();
      }
    } catch (error) {
      console.error('Failed to compact session:', error);
      clearSessionLoading(activeAgent.id);
      window.alert(t('workspace_compact_failed') + (error?.message || error));
    }
    return;
  }

  if (action.type === 'view_session_record') {
    if (!action.agentId || !action.sessionId) return;
    readOnlyMode = true;
    const agentId = action.agentId;
    const sessionId = action.sessionId;
    try {
      const res = await fetch('/protoclaw/session_record?agentId=' + encodeURIComponent(agentId) + '&sessionId=' + encodeURIComponent(sessionId));
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      currentMessages = (data.messages || []).map(m => ({
        role: m.role,
        content: m.content,
      }));
      currentInputRequests = [];
      lastRenderedInputSignature = '';
      setPreferredUnitMode('chat', allAgents.find(a => a.id === agentId) || activeAgent);
      renderCurrentMainView();
    } catch (error) {
      console.error('Failed to load session record:', error);
      window.alert('Failed to load session record: ' + (error?.message || error));
      readOnlyMode = false;
    }
    return;
  }

  if (action.type === 'open_summary') {
    if (!action.agentId || !action.sessionId) return;
    window.openSummaryPopup(action.agentId, action.sessionId);
    return;
  }

  if (action.type === 'generate_summary') {
    if (!action.agentId || !action.sessionId) return;
    window.openSummaryPopup(action.agentId, action.sessionId);
    return;
  }

  if (action.type === 'delete_session') {
    if (!activeAgent?.id || !action.sessionId) return;
    const sessionTitle = action.sessionId;
    const confirmMsg = t('workspace_session_delete_confirm').replace('{{id}}', sessionTitle);
    const confirmed = window.confirm(confirmMsg);
    if (!confirmed) {
      return;
    }

    const targetAgent = allAgents.find((item) => item.id === activeAgent.id) || null;
    const affectedRuntimeId = targetAgent?.runtime_session_id || targetAgent?.runtimeSessionId || null;
    const deletedWasActive = action.sessionId === (targetAgent?.active_workspace_session_id || targetAgent?.workspace_sessions?.activeSessionId || null);
    const currentSessions = getWorkspaceSessions(targetAgent);

    if (deletedWasActive) {
      applyManagedPrebuiltAgent(activeAgent.id, null);
    }
    const remainingSessions = currentSessions.filter((s) => s.id !== action.sessionId);
    const nextActiveId = remainingSessions.length > 0
      ? (targetAgent?.active_workspace_session_id === action.sessionId ? remainingSessions[0].id : targetAgent?.active_workspace_session_id)
      : null;
    updateAgentRecord(activeAgent.id, {
      workspace_sessions: { sessions: remainingSessions, activeSessionId: nextActiveId },
      active_workspace_session_id: nextActiveId,
    });

    // Precise DOM removal for IM workspace sessions — avoid full re-render
    const imDraft = getIMWorkspaceDraft ? getIMWorkspaceDraft() : null;
    const isIMSession = Array.isArray(imDraft?.sessions);
    if (isIMSession) {
      const idx = imDraft.sessions.findIndex((s) => s.id === action.sessionId);
      if (idx !== -1) imDraft.sessions.splice(idx, 1);
      if (String(imDraft.workspaceConfig?.receptionistSessionId) === String(action.sessionId)) {
        imDraft.workspaceConfig.receptionistSessionId = '';
      }
      const el = document.querySelector('[data-prebuilt-session-id="' + CSS.escape(action.sessionId) + '"]');
      if (el) {
        el.style.transition = 'opacity 0.2s, transform 0.2s';
        el.style.opacity = '0';
        el.style.transform = 'translateX(-10px)';
        setTimeout(() => el.remove(), 200);
      }
    } else {
      shouldAnimateWorkspaceSurface = false;
      renderCurrentMainView();
    }

    try {
      const response = await fetch('/protoclaw/prebuilt_sessions/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: activeAgent.id,
          sessionId: action.sessionId,
        }),
      });
      if (!response.ok) {
        throw new Error(await response.text().catch(() => 'delete session failed'));
      }
      const result = await response.json();
      if (result?.deleted?.sessions) {
        updateAgentRecord(activeAgent.id, {
          workspace_sessions: result.deleted.sessions,
          active_workspace_session_id: result.deleted.activeSessionId || null,
        });
      }
      if (result?.agent) {
        applyManagedPrebuiltAgent(activeAgent.id, result.agent);
      }
      // Refresh IM workspace draft in background — no re-render needed if DOM already updated
      if (isIMSession) {
        ensureIMWorkspaceLoaded(true).catch(() => {});
      } else {
        loadAgents().catch(() => {});
      }
    } catch (error) {
      console.error('Failed to delete session:', error);
      updateAgentRecord(activeAgent.id, {
        workspace_sessions: { sessions: currentSessions, activeSessionId: targetAgent?.active_workspace_session_id },
        active_workspace_session_id: targetAgent?.active_workspace_session_id,
      });
      // Restore IM draft and re-render on failure
      if (isIMSession) {
        ensureIMWorkspaceLoaded(true).catch(() => {});
      }
      lastRenderedWorkspaceHtml = '';
      renderCurrentMainView();
      window.alert((currentLanguage === 'zh' ? '删除会话失败：' : 'Failed to delete session: ') + (error?.message || error));
    }
    return;
  }

  if ((action.type === 'show_chat' || action.type === 'resume_session') && !hasSessions) {
    return;
  }

  const needsManagedSession =
    activeAgent?.source === 'prebuilt'
    && (
      action.type === 'create_session'
      || action.type === 'create_session_from_session'
      || action.type === 'open_session'
    );

  if (needsManagedSession) {
    const shouldMarkLoading = action.type === 'open_session' && action.sessionId;
    if (shouldMarkLoading) {
      markSessionLoading(activeAgent.id, action.sessionId);
    }
    if (triggerButton) markActionLoading(triggerButton);
    try {
      prebuiltSessionSwitchInFlight = true;
      const sessionAction = action.type === 'open_session'
        ? { type: 'open_session', sessionId: action.sessionId }
        : {
            type: action.type,
            sessionId: action.sessionId,
            formId: action.formId,
            featureName: action.featureName,
            agentName: action.agentName,
            openDirectory: action.openDirectory,
            targetDir: action.targetDir,
      };
      const runSessionOpen = async () => {
        const previousRuntimeId = normalizeAgentIdentity(activeAgent.runtime_session_id || activeAgent.runtimeSessionId || currentRuntimeAgentId);
        _storeVisibleSessionInputDraft();
        if (previousRuntimeId) {
          saveCurrentRuntimeToCache(previousRuntimeId, getRuntimeContextKey(previousRuntimeId, activeAgent));
        }
        const result = await openPrebuiltWorkspaceSession(activeAgent.id, sessionAction);
        const optimisticAgent = result?.session
          ? (applyOptimisticWorkspaceSession(activeAgent.id, result.session) || activeAgent)
          : activeAgent;
        // Immediately render the workspace surface so the user sees the new
        // session appear in the list without waiting for the runtime to start.
        if (!currentRuntimeAgentId) {
          lastRenderedWorkspaceHtml = '';
          renderCurrentMainView();
        }
        const isAssemblyLaunch =
          activeAgent?.id === 'agent-creator'
          && action.type === 'create_session'
          && String(action.formId || '') === 'assembly-form';
        const nextAgent = result?.agent ? (upsertConnectedAgent(result.agent) || result.agent) : null;
        if (isAssemblyLaunch) {
          setPreferredUnitMode('assembly', activeAgent);
          loadAgents().catch((error) => console.error('Failed to refresh agents after assembly launch:', error));
          renderCurrentMainView();
          return;
        }
        if (nextAgent?.runtime_session_id || nextAgent?.runtimeSessionId) {
          setPreferredUnitMode('chat', nextAgent);
          const nextRuntimeId = nextAgent.runtime_session_id || nextAgent.runtimeSessionId || nextAgent.id;
          if (nextRuntimeId === currentRuntimeAgentId) {
            beginFollowLatestEntryWindow();
            renderCurrentMainView();
          } else {
            await requestSwitch(nextRuntimeId, 'session-open');
          }
          loadAgents().catch((error) => console.error('Failed to refresh agents after opening prebuilt session:', error));
          return;
        }
        if (result?.status?.status === 'running' && result.status.viewerAgentId) {
          const existingRuntimeId = result.status.viewerAgentId;
          if (existingRuntimeId === currentRuntimeAgentId) {
            beginFollowLatestEntryWindow();
            renderCurrentMainView();
          } else {
            await loadAgents();
            await requestSwitch(existingRuntimeId, 'session-open-existing');
          }
          return;
        }
        try {
          const readyAgent = await waitForPrebuiltRuntimeSession(activeAgent.id, 30, {
            previousRuntimeId,
            expectedSessionId: result?.session?.id || '',
          });
          if (!readyAgent) return;
          const nextRuntimeId = readyAgent.runtime_session_id || readyAgent.runtimeSessionId || readyAgent.id;
          if (!nextRuntimeId) return;
          setPreferredUnitMode('chat', activeAgent);
          if (nextRuntimeId === currentRuntimeAgentId) {
            beginFollowLatestEntryWindow();
            renderCurrentMainView();
          } else {
            await requestSwitch(nextRuntimeId, 'session-open-wait');
          }
        } catch (error) {
          console.error('Failed while waiting for prebuilt runtime session:', error);
        } finally {
          loadAgents().catch((error) => console.error('Failed to refresh agents after waiting for prebuilt runtime:', error));
        }
      };
      const targetSession = sessionAction.type === 'open_session'
        ? getWorkspaceSessionById(activeAgent, sessionAction.sessionId)
        : null;
      const needsAssemblyDriftWarning = !!(
        targetSession
        && isAssemblySession(targetSession)
        && !isAssemblySessionRunning(activeAgent, targetSession)
        && (activeAgent?.id === 'flow-workspace' || activeAgent?.id === 'agent-creator')
      );
      if (needsAssemblyDriftWarning) {
        await maybeWarnAssemblySessionDrift(activeAgent, sessionAction.sessionId, runSessionOpen);
      } else {
        await runSessionOpen();
      }
    } catch (error) {
      console.error('Failed to open prebuilt session:', error);
      window.alert(`Session failed: ${error && error.message ? error.message : error}`);
      return;
    } finally {
      prebuiltSessionSwitchInFlight = false;
      if (shouldMarkLoading) clearSessionLoading(activeAgent.id);
      else if (triggerButton) triggerButton.classList.remove('action-loading');
    }
  }

  if (action.type === 'show_chat' || action.type === 'resume_session') {
    beginFollowLatestCooldown();
    beginFollowLatestEntryWindow();
    setPreferredUnitMode('chat', activeAgent);
  } else if (action.type === 'show_home') {
    setPreferredUnitMode('home', activeAgent);
  } else if (action.type === 'show_workspace_tab' && action.tab) {
    setPreferredUnitMode(String(action.tab), activeAgent);
  } else if (action.type === 'show_block' && action.target) {
    setPreferredUnitMode(`block:${action.target}`, activeAgent);
  }
  renderCurrentMainView();
};

window.toggleProjectDocsetOverlay = (force) => {
  if (typeof force === 'boolean') {
    currentProjectDocsetOpen = force;
  } else {
    currentProjectDocsetOpen = !currentProjectDocsetOpen;
  }
  updateProjectDocsetChrome(getCurrentAgentRecord());
};

window.setProjectDocsetPage = (page) => {
  currentProjectDocsetPage = ['requirement', 'log', 'materials'].includes(page) ? page : 'requirement';
  renderCurrentMainView();
};

window.startProjectRequirementEdit = () => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  currentProjectDocsetPage = 'requirement';
  currentProjectRequirementEdit = { agentId: agent.id };
  renderCurrentMainView();
};

window.cancelProjectRequirementEdit = () => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  resetProjectRequirementDraft(agent);
  currentProjectRequirementEdit = null;
  renderCurrentMainView();
};

window.saveProjectRequirementForm = async () => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const forms = getWorkspaceFormDraft(agent);
  try {
    await persistWorkspaceState(agent, forms, {
      openDirectory: getAgentWorkspaceState(agent)?.openDirectory || '',
    });
    currentProjectRequirementEdit = null;
    await loadAgents();
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to save project requirement form:', error);
  }
};

window.openProjectMaterialImport = (mode = 'files') => {
  window.importProjectMaterialsByPath(mode).catch((error) => {
    console.error('Failed to open project material import:', error);
  });
};

window.importProjectMaterialsByPath = async (mode = 'files') => {
  const agent = getCurrentAgentRecord();
  const docset = getCurrentProjectDocset(agent);
  if (!agent?.id || !docset?.projectDir) return;

  try {
    let materials = [];
    if (mode === 'folder') {
      const selected = await invoke('select_directory');
      if (!selected || selected.cancelled || !selected.path) return;
      materials = [{
        name: getPathLeaf(selected.path) || selected.path,
        sourcePath: selected.path,
        sourceKind: 'directory',
      }];
    } else {
      const selected = await invoke('select_files');
      const paths = Array.isArray(selected?.paths) ? selected.paths.filter(Boolean) : [];
      if (!paths.length) return;
      materials = paths.map((sourcePath) => ({
        name: getPathLeaf(sourcePath) || sourcePath,
        sourcePath,
        sourceKind: 'file',
      }));
    }

    const response = await fetch('/protoclaw/project_docset/import_materials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: agent.id,
        projectDir: docset.projectDir,
        mode,
        materials,
      }),
    });

    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'Failed to import materials'));
    }

    await loadAgents();
    currentProjectDocsetPage = 'materials';
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to import project materials:', error);
  }
};

window.runWorkspaceActionFromEvent = async (event, rawAction) => {
  const btn = event?.target instanceof Element ? event.target.closest('button[data-workspace-action]') : null;
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  await window.runWorkspaceAction(rawAction, btn || undefined);
};

document.addEventListener('click', (event) => {
  const actionButton = event.target instanceof Element
    ? event.target.closest('button[data-workspace-action]')
    : null;
  if (!actionButton) return;
  if (actionButton.classList.contains('compact-trigger')) return;
  event.preventDefault();
  event.stopPropagation();
  if (typeof event.stopImmediatePropagation === 'function') {
    event.stopImmediatePropagation();
  }
  const rawAction = actionButton.dataset?.workspaceAction || '';
  window.runWorkspaceAction(rawAction, actionButton).catch((error) => {
    console.error('Failed to handle delegated workspace action:', error);
  });
}, true);

window.updateWorkspaceFormDraft = (formId, fieldName, value) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  draft[formId] = draft[formId] || {};
  draft[formId][fieldName] = value;
  const isAssemblyDraft = (agent.id === 'agent-creator' || agent.id === 'flow-workspace') && formId === 'assembly-form';
  if ((agent.id === 'feature-creator' || agent.id === 'agent-creator') && formId === 'startup-form') {
    if (fieldName === 'install_mode' && value === 'custom') {
      draft[formId].target_dir = '';
    }
    draft[formId] = normalizeWorkspaceStartupDraft(agent, draft[formId]);
  }
  saveWorkspaceFormDraft(agent.id, draft);
  if ((agent.id === 'feature-creator' || agent.id === 'agent-creator') && formId === 'startup-form') {
    const directoryDisplay = document.querySelector('[data-workspace-form-display="startup-form:target_dir"]');
    if (directoryDisplay) {
      directoryDisplay.value = draft[formId].target_dir || t('workspace_directory_not_selected');
    }
    const outputNote = document.querySelector('[data-workspace-output-note="startup-form"]');
    if (outputNote) {
      const nextOutputDir = agent.id === 'feature-creator'
        ? getFeatureCreatorOutputDirectory(agent, draft[formId])
        : getAgentCreatorOutputDirectory(agent, draft[formId]);
      outputNote.textContent = nextOutputDir ? `${t('feature_creator_output_dir')}: ${nextOutputDir}` : '';
    }
    if (fieldName === 'install_mode') {
      shouldAnimateWorkspaceSurface = false;
      renderCurrentMainView();
    }
    return;
  }
  if (isAssemblyDraft && !['assembly_stage', 'preset', 'advanced_prompt_open'].includes(fieldName)) {
    scheduleAssemblyWorkbenchRender();
    return;
  }
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

window.toggleWorkspaceSelection = async (formId, fieldName, value) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const token = String(value || '').trim();
  if (!token) return;
  const draft = getWorkspaceFormDraft(agent);
  draft[formId] = draft[formId] || {};
  const next = parseWorkspaceListField(draft[formId][fieldName]);
  const values = new Set(next);
  if (values.has(token)) {
    values.delete(token);
  } else {
    values.add(token);
  }
  const normalizedValues = fieldName === 'selected_features'
    ? canonicalizeAssemblyFeatureSelection(agent, Array.from(values))
    : Array.from(values);
  draft[formId][fieldName] = serializeWorkspaceListField(normalizedValues);
  saveWorkspaceFormDraft(agent.id, draft);
  try {
    await persistWorkspaceState(agent, draft);
  } catch (error) {
    console.error('Failed to persist workspace selection:', error);
  }
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

window.applyWorkspaceBundle = async (formId, bundle) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  draft[formId] = draft[formId] || {};
  const featureValues = new Set(parseWorkspaceListField(draft[formId].selected_features));
  const toolkitValues = new Set(parseWorkspaceListField(draft[formId].recommended_toolkits));
  (Array.isArray(bundle?.features) ? bundle.features : []).forEach((item) => {
    const text = String(item || '').trim();
    if (text) featureValues.add(text);
  });
  (Array.isArray(bundle?.toolkits) ? bundle.toolkits : []).forEach((item) => {
    const text = String(item || '').trim();
    if (text) toolkitValues.add(text);
  });
  draft[formId].selected_features = serializeWorkspaceListField(canonicalizeAssemblyFeatureSelection(agent, Array.from(featureValues)));
  draft[formId].recommended_toolkits = serializeWorkspaceListField(Array.from(toolkitValues));
  saveWorkspaceFormDraft(agent.id, draft);
  try {
    await persistWorkspaceState(agent, draft);
  } catch (error) {
    console.error('Failed to persist workspace bundle:', error);
  }
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

window.createAssemblyEnvironment = async () => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  const form = normalizeAssemblyDraft(draft['assembly-form'] || {});
  const name = String(form.assembly_name || '').trim();
  const selectedFeatures = parseWorkspaceListField(form.selected_features);
  if (!name) {
    window.alert(currentLanguage === 'zh' ? '请先填写 Agent 名称' : 'Please provide an agent name first');
    return;
  }
  const conflicts = findAssemblyConfigConflict(agent, form);
  if (conflicts.conflictingName) {
    window.alert(currentLanguage === 'zh'
      ? `Agent 项目 "${name}" 已存在，请先加载它再配置环境。`
      : `An Agent project named "${name}" already exists. Load it before configuring the environment.`);
    return;
  }
  if (conflicts.conflictingDirectory) {
    window.alert(currentLanguage === 'zh'
      ? `当前环境目录已经被项目 "${conflicts.conflictingDirectory.name || conflicts.conflictingDirectory.id}" 占用，请先加载那个项目，或重置当前草稿。`
      : `This environment directory already belongs to "${conflicts.conflictingDirectory.name || conflicts.conflictingDirectory.id}". Load that project or reset the current draft first.`);
    return;
  }
  try {
    await syncAssemblyEnvironmentDraft(agent, draft, {
      env_status: 'creating',
      env_status_message: currentLanguage === 'zh'
        ? '正在准备用户环境目录...'
        : 'Preparing the user environment directory...',
    });
    let result;
    try {
      result = await requestAssemblyEnvironmentCreate(name, { selectedFeatures });
    } catch (error) {
      if (error?.code === 'ASSEMBLY_ENV_EXISTS') {
        const confirmed = window.confirm(currentLanguage === 'zh'
          ? `目录已存在：\n${error.directory}\n\n是否继续按当前配置重新准备这个环境？`
          : `The environment directory already exists:\n${error.directory}\n\nDo you want to reconfigure this environment with the current setup?`);
        if (!confirmed) {
          await syncAssemblyEnvironmentDraft(agent, draft, {
            env_status: 'stale',
            env_status_message: currentLanguage === 'zh'
              ? '检测到同名目录，已取消重新配置。'
              : 'An existing directory was detected, and reconfiguration was cancelled.',
          });
          return;
        }
        result = await requestAssemblyEnvironmentCreate(name, { force: true, selectedFeatures });
      } else {
        throw error;
      }
    }
    await syncAssemblyEnvironmentDraft(agent, draft, {
      env_created: '1',
      env_dir: result.directory || '',
      env_configured_name: name,
      env_configured_features: serializeWorkspaceListField(selectedFeatures),
      env_status: 'ready',
      env_status_message: result.existed
        ? (currentLanguage === 'zh' ? '已复用并确认现有环境目录。' : 'Reused and confirmed the existing environment directory.')
        : (currentLanguage === 'zh' ? '环境目录已创建完成。' : 'Environment directory created.'),
    }, {
      persist: true,
      openDirectory: result.directory || '',
    });
  } catch (error) {
    console.error('Failed to create assembly environment:', error);
    await syncAssemblyEnvironmentDraft(agent, draft, {
      env_status: 'error',
      env_status_message: (currentLanguage === 'zh' ? '环境创建失败：' : 'Environment creation failed: ') + (error?.message || error),
    }).catch(() => {});
    window.alert('Failed to create environment: ' + (error?.message || error));
  }
};

window.launchAssemblyInstance = async () => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  assemblyLaunchInProgress = true;
  const _t0 = performance.now();
  console.log(`[PERF-CLIENT] launchAssemblyInstance BEGIN assembly=${(getWorkspaceFormDraft(agent)['assembly-form'] || {}).assembly_name}`);
  const draft = getWorkspaceFormDraft(agent);
  const form = normalizeAssemblyDraft(draft['assembly-form'] || {});
  if (!isValidAgentCreatorName(form.assembly_name)) {
    assemblyLaunchInProgress = false;
    window.alert('Assembly name must use lowercase letters, numbers, and hyphens only.');
    return;
  }
  const conflicts = findAssemblyConfigConflict(agent, form);
  if (conflicts.conflictingName) {
    assemblyLaunchInProgress = false;
    window.alert(currentLanguage === 'zh'
      ? `Agent 项目 "${form.assembly_name}" 已存在，请先加载对应项目再启动。`
      : `An Agent project named "${form.assembly_name}" already exists. Load that project before launching.`);
    return;
  }
  if (conflicts.conflictingDirectory) {
    assemblyLaunchInProgress = false;
    window.alert(currentLanguage === 'zh'
      ? `当前环境目录已经被项目 "${conflicts.conflictingDirectory.name || conflicts.conflictingDirectory.id}" 占用，请先切换到那个项目。`
      : `This environment directory already belongs to "${conflicts.conflictingDirectory.name || conflicts.conflictingDirectory.id}". Switch to that project first.`);
    return;
  }
  draft['assembly-form'] = form;
  saveWorkspaceFormDraft(agent.id, draft);
  try {
    await persistWorkspaceState(agent, draft);
    console.log(`[PERF-CLIENT] launchAssemblyInstance persist #1 done (${(performance.now() - _t0).toFixed(0)}ms)`);
    const assemblyName = form.assembly_name;
    const envState = getAssemblyEnvironmentState(form);
    const shouldConfigureEnvironment = envState.needsConfiguration || !envState.configuredDir;
    const selectedFeatures = parseWorkspaceListField(form.selected_features);
    if (assemblyName) {
      if (shouldConfigureEnvironment) {
        console.log(`[PERF-CLIENT] launchAssemblyInstance env needs config, calling requestAssemblyEnvironmentCreate`);
        await syncAssemblyEnvironmentDraft(agent, draft, {
          env_status: 'installing',
          env_status_message: currentLanguage === 'zh'
            ? `正在配置环境并安装依赖${selectedFeatures.length ? `（${selectedFeatures.length} 个 Feature）` : ''}...`
            : `Preparing environment and installing dependencies${selectedFeatures.length ? ` (${selectedFeatures.length} feature(s))` : ''}...`,
        });
        try {
          const envResult = await requestAssemblyEnvironmentCreate(assemblyName, { selectedFeatures });
          console.log(`[PERF-CLIENT] launchAssemblyInstance envCreate done (${(performance.now() - _t0).toFixed(0)}ms)`);
          await syncAssemblyEnvironmentDraft(agent, draft, {
            env_created: '1',
            env_dir: envResult.directory || '',
            env_configured_name: assemblyName,
            env_configured_features: serializeWorkspaceListField(selectedFeatures),
            env_status: 'ready',
            env_status_message: envResult.existed
              ? (currentLanguage === 'zh' ? '已复用环境目录并刷新依赖。' : 'Reused the environment directory and refreshed dependencies.')
              : (currentLanguage === 'zh' ? '环境目录与依赖已准备完成。' : 'Environment directory and dependencies are ready.'),
          }, {
            persist: true,
            openDirectory: envResult.directory || '',
          });
        } catch (error) {
          if (error?.code === 'ASSEMBLY_ENV_EXISTS') {
            const envResult = await requestAssemblyEnvironmentCreate(assemblyName, { force: true, selectedFeatures });
            await syncAssemblyEnvironmentDraft(agent, draft, {
              env_created: '1',
              env_dir: envResult.directory || '',
              env_configured_name: assemblyName,
              env_configured_features: serializeWorkspaceListField(selectedFeatures),
              env_status: 'ready',
              env_status_message: currentLanguage === 'zh'
                ? '已复用环境目录并刷新依赖。'
                : 'Reused the environment directory and refreshed dependencies.',
            }, {
              persist: true,
              openDirectory: envResult.directory || '',
            });
          } else {
            throw error;
          }
        }
      } else {
        console.log(`[PERF-CLIENT] launchAssemblyInstance env already ready, skipping create (${(performance.now() - _t0).toFixed(0)}ms)`);
        await syncAssemblyEnvironmentDraft(agent, draft, {
          env_status: 'ready',
          env_status_message: currentLanguage === 'zh'
            ? '已使用当前已配置环境，直接启动实例。'
            : 'Using the existing configured environment for launch.',
        });
      }
    }
    await syncAssemblyEnvironmentDraft(agent, draft, {
      env_status: 'starting',
      env_status_message: currentLanguage === 'zh'
        ? '正在启动 Agent 测试实例...'
        : 'Starting the chatbot instance...',
    });
    console.log(`[PERF-CLIENT] launchAssemblyInstance calling /assembly_runtime/start (${(performance.now() - _t0).toFixed(0)}ms)`);
    const response = await fetch('/protoclaw/assembly_runtime/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: agent.id,
        agentName: getAssemblyDisplayName(form) || form.assembly_name,
        openDirectory: form.env_dir || envState.configuredDir || '',
        targetDir: form.target_dir || '',
      }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'Assembly runtime failed'));
    }
    await response.json();
    console.log(`[PERF-CLIENT] launchAssemblyInstance /assembly_runtime/start response received (${(performance.now() - _t0).toFixed(0)}ms)`);
    await syncAssemblyEnvironmentDraft(agent, draft, {
      env_status: 'running',
      env_status_message: currentLanguage === 'zh'
        ? 'Chatbot 已启动，运行环境位于用户目录；宿主工作目录仍保持在 Claw。'
        : 'Chatbot is running in the user environment directory while the host workdir remains in Claw.',
    }, {
      persist: true,
    });
    console.log(`[PERF-CLIENT] launchAssemblyInstance persist running done (${(performance.now() - _t0).toFixed(0)}ms)`);
    assemblyLaunchInProgress = false;
    await loadAgents();
    console.log(`[PERF-CLIENT] launchAssemblyInstance loadAgents done (${(performance.now() - _t0).toFixed(0)}ms)`);
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();
    console.log(`[PERF-CLIENT] launchAssemblyInstance COMPLETE (${(performance.now() - _t0).toFixed(0)}ms total)`);
  } catch (error) {
    console.error('Failed to launch assembly runtime:', error);
    assemblyLaunchInProgress = false;
    await syncAssemblyEnvironmentDraft(agent, draft, {
      env_status: 'error',
      env_status_message: (currentLanguage === 'zh' ? '启动失败：' : 'Launch failed: ') + (error && error.message ? error.message : error),
    }, {
      persist: true,
    }).catch(() => {});
    window.alert('Assembly runtime failed: ' + (error && error.message ? error.message : error));
  }
};

function getSavedAssemblyConfigs(agent = getCurrentAgentRecord()) {
  const configs = Array.isArray(getAgentWorkspaceState(agent)?.assemblyConfigs)
    ? getAgentWorkspaceState(agent).assemblyConfigs
    : [];
  return configs
    .map((item) => ({
      id: String(item?.id || '').trim(),
      name: String(item?.name || '').trim(),
      displayName: String(item?.displayName || '').trim(),
      preset: String(item?.preset || '').trim(),
      goal: String(item?.goal || '').trim(),
      targetUser: String(item?.targetUser || '').trim(),
      features: Array.isArray(item?.features) ? item.features.map((value) => String(value || '').trim()).filter(Boolean) : [],
      toolkits: Array.isArray(item?.toolkits) ? item.toolkits.map((value) => String(value || '').trim()).filter(Boolean) : [],
      constraints: String(item?.constraints || '').trim(),
      customSystemPrompt: String(item?.customSystemPrompt || '').trim(),
      envDir: String(item?.envDir || '').trim(),
      envConfiguredName: String(item?.envConfiguredName || '').trim(),
      envConfiguredFeatures: Array.isArray(item?.envConfiguredFeatures) ? item.envConfiguredFeatures.map((value) => String(value || '').trim()).filter(Boolean) : [],
      envStatus: String(item?.envStatus || '').trim(),
      envStatusMessage: String(item?.envStatusMessage || '').trim(),
      modelPreset: String(item?.modelPreset || '').trim(),
      workdir: String(item?.workdir || '').trim(),
      featureConfigs: normalizeFeatureConfigMap(item?.featureConfigs),
      updatedAt: String(item?.updatedAt || '').trim(),
    }))
    .filter((item) => item.id)
    .reduce((acc, item) => {
      if (!acc.some((existing) => existing.id === item.id)) {
        acc.push(item);
      }
      return acc;
    }, [])
    .sort((left, right) => String(right?.updatedAt || '').localeCompare(String(left?.updatedAt || '')));
}

function canonicalizeAssemblyFeatureSelection(agent, values) {
  const packages = Array.isArray(agent?.workspace_data?.['assembly-workbench']?.packages)
    ? agent.workspace_data['assembly-workbench'].packages
    : [];
  const aliasMap = new Map();
  packages.forEach((item) => {
    const packageName = String(item?.packageName || '').trim();
    const id = String(item?.id || '').trim();
    const canonical = packageName || id;
    if (!canonical) return;
    [packageName, id].filter(Boolean).forEach((key) => {
      const normalized = key.toLowerCase();
      if (!aliasMap.has(normalized)) {
        aliasMap.set(normalized, canonical);
      }
    });
  });
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .map((value) => aliasMap.get(value.toLowerCase()) || value)));
}

window.saveCurrentAssemblyConfig = async () => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  const form = normalizeAssemblyDraft(draft['assembly-form'] || {});
  const name = String(form.assembly_name || '').trim();
  const editingId = String(form.editing_config_id || '').trim();
  if (!isValidAgentCreatorName(name)) {
    window.alert('Assembly name must use lowercase letters, numbers, and hyphens only.');
    return;
  }
  const currentState = getAgentWorkspaceState(agent);
  const allConfigs = getSavedAssemblyConfigs(agent);
  const conflicts = findAssemblyConfigConflict(agent, form);
  if (conflicts.conflictingName) {
    window.alert(currentLanguage === 'zh'
      ? `Agent 项目 "${name}" 已存在，请换一个名字，或先加载它再编辑。`
      : `An Agent project named "${name}" already exists. Choose another name or load it before editing.`);
    return;
  }
  if (conflicts.conflictingDirectory) {
    window.alert(currentLanguage === 'zh'
      ? `当前环境目录已经被项目 "${conflicts.conflictingDirectory.name || conflicts.conflictingDirectory.id}" 占用，请先切换到那个项目，或重新配置当前项目的环境。`
      : `This environment directory already belongs to "${conflicts.conflictingDirectory.name || conflicts.conflictingDirectory.id}". Load that project or reconfigure the current environment first.`);
    return;
  }
  if (window.ClawFlowEditor && typeof window.ClawFlowEditor.save === 'function') {
    try {
      await window.ClawFlowEditor.save();
    } catch (error) {
      console.error('Failed to save flow graph before saving assembly config:', error);
    }
  }
  const existing = allConfigs.filter((item) => item.id !== name && item.id !== editingId);
  const hasEnvTrace = !!(String(form.env_dir || '').trim() || form.env_created === '1' || String(form.env_configured_name || '').trim());
  const normalizedFeatures = canonicalizeAssemblyFeatureSelection(agent, parseWorkspaceListField(form.selected_features));
  const normalizedToolkits = parseWorkspaceListField(form.recommended_toolkits);
  const normalizedConfiguredFeatures = canonicalizeAssemblyFeatureSelection(agent, parseWorkspaceListField(form.env_configured_features));
  const projectFeatureConfigs = collectAssemblyProjectFeatureConfigs(agent, form, currentState?.forms?.['feature-configs'] || {});
  const nextConfigs = [
    {
      id: name,
      name,
      preset: String(form.preset || '').trim(),
      goal: String(form.goal || '').trim(),
      targetUser: String(form.target_user || '').trim(),
      features: normalizedFeatures,
      toolkits: normalizedToolkits,
      constraints: String(form.constraints || '').trim(),
      customSystemPrompt: String(form.custom_system_prompt || '').trim(),
      envDir: String(form.env_dir || '').trim(),
      envConfiguredName: hasEnvTrace ? (String(form.env_configured_name || '').trim() || name) : '',
      envConfiguredFeatures: normalizedConfiguredFeatures,
      envStatus: String(form.env_status || '').trim(),
      envStatusMessage: String(form.env_status_message || '').trim(),
      featureConfigs: projectFeatureConfigs,
      updatedAt: new Date().toISOString(),
    },
    ...existing,
  ];
  draft['assembly-form'] = normalizeAssemblyDraft({
    ...form,
    editing_config_id: name,
    selected_features: serializeWorkspaceListField(normalizedFeatures),
    recommended_toolkits: serializeWorkspaceListField(normalizedToolkits),
    env_configured_features: serializeWorkspaceListField(normalizedConfiguredFeatures),
    env_configured_name: hasEnvTrace ? (String(form.env_configured_name || '').trim() || name) : '',
  });
  const payload = {
    forms: draft,
    openDirectory: currentState?.openDirectory || '',
    assemblyConfigs: nextConfigs,
  };
  const response = await fetch('/protoclaw/workspace_state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: agent.id, state: payload }),
  });
  if (!response.ok) {
    window.alert('Failed to save assembly config.');
    return;
  }
  const nextState = await response.json();
  updateAgentWorkspaceState(agent.id, nextState);
  saveWorkspaceFormDraft(agent.id, nextState.forms || {});
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

window.resetAssemblyDraft = async () => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  draft['assembly-form'] = normalizeAssemblyDraft({
    assembly_stage: 'goal',
    preset: 'general-chatbot',
    editing_config_id: '',
    display_name: '',
    env_created: '0',
    env_status: '',
    env_status_message: '',
    env_dir: '',
    env_configured_name: '',
  });
  draft['feature-configs'] = {};
  saveWorkspaceFormDraft(agent.id, draft);
  await persistWorkspaceState(agent, draft, { openDirectory: '' }).catch((error) => {
    console.error('Failed to reset assembly draft:', error);
  });
  setPreferredUnitMode('assembly', agent);
  if (agent?.id === 'flow-workspace' && window.ClawFW?.mode === 'detail') {
    currentWorkspaceTab = 'workspace';
  } else {
    currentWorkspaceTab = 'assembly';
  }
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

window.switchAssemblyEditingTarget = async (target) => {
  const normalized = String(target || '').trim();
  if (!normalized || normalized === '__new__') {
    await window.resetAssemblyDraft();
    return;
  }
  await window.loadSavedAssemblyConfig(normalized);
};

window.toggleAssemblyControlPanel = () => {
  assemblyControlPanelOpen = !assemblyControlPanelOpen;
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

window.jumpAssemblyStage = (stageKey) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  window.updateWorkspaceFormDraft('assembly-form', 'assembly_stage', stageKey);
};

window.loadSavedAssemblyConfig = async (configId) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const config = getSavedAssemblyConfigs(agent).find((item) => item.id === String(configId || '').trim());
  if (!config) return;
  const draft = getWorkspaceFormDraft(agent);
  const previousForm = normalizeAssemblyDraft(draft['assembly-form'] || {});
  const previousMatchesConfig = String(previousForm.assembly_name || '').trim() === String(config.id || '').trim();
  const knownEnvDir = String(config.envDir || (previousMatchesConfig ? previousForm.env_dir : '') || '').trim();
  const knownConfiguredFeatures = Array.isArray(config.envConfiguredFeatures) && config.envConfiguredFeatures.length
    ? config.envConfiguredFeatures
    : (previousMatchesConfig && parseWorkspaceListField(previousForm.env_configured_features).length
      ? parseWorkspaceListField(previousForm.env_configured_features)
      : (knownEnvDir ? config.features : []));
  draft['assembly-form'] = normalizeAssemblyDraft({
    assembly_name: config.id,
    display_name: String(config.displayName || '').trim(),
    editing_config_id: config.id,
    preset: config.preset,
    target_user: config.targetUser,
    goal: config.goal,
    selected_features: serializeWorkspaceListField(config.features),
    recommended_toolkits: serializeWorkspaceListField(config.toolkits),
    constraints: config.constraints,
    custom_system_prompt: config.customSystemPrompt,
    assembly_stage: 'review',
    env_created: knownEnvDir ? '1' : '0',
    env_dir: knownEnvDir,
    env_configured_name: config.envConfiguredName || (previousMatchesConfig ? previousForm.env_configured_name : '') || (knownEnvDir ? config.id : ''),
    env_configured_features: serializeWorkspaceListField(knownConfiguredFeatures),
    env_status: config.envStatus || (previousMatchesConfig ? previousForm.env_status : '') || (knownEnvDir ? 'ready' : ''),
    env_status_message: knownEnvDir
      ? (currentLanguage === 'zh'
        ? (config.envStatus === 'stale' ? '已载入配置；环境需要按当前能力重新配置。' : '已载入配置，可继续修改或重新启动实例。')
        : (config.envStatus === 'stale' ? 'Setup loaded. Reconfigure the environment for the current capabilities.' : 'Setup loaded. You can keep editing or launch a new instance.'))
      : (currentLanguage === 'zh'
        ? '已载入配置；如果这是首次启动，请先配置环境目录。'
        : 'Setup loaded. Configure the environment directory before the first launch.'),
    model_preset: config.modelPreset || '',
    workdir: config.workdir || '',
  });
  draft['feature-configs'] = normalizeFeatureConfigMap(config.featureConfigs);
  saveWorkspaceFormDraft(agent.id, draft);
  try {
    await persistWorkspaceState(agent, draft, { openDirectory: knownEnvDir });
  } catch (error) {
    console.error('Failed to load assembly config:', error);
  }
  setPreferredUnitMode('assembly', agent);
  if (agent?.id === 'flow-workspace' && window.ClawFW?.mode === 'detail') {
    currentWorkspaceTab = 'workspace';
  } else {
    currentWorkspaceTab = 'assembly';
  }
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

window.launchAssemblyConfig = async (configId) => {
  const _t0 = performance.now();
  console.log(`[PERF-CLIENT] launchAssemblyConfig BEGIN configId=${configId}`);
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const config = getSavedAssemblyConfigs(agent).find((item) => item.id === String(configId || '').trim());
  if (!config) return;
  const envDir = String(config.envDir || '').trim();
  const draft = getWorkspaceFormDraft(agent);
  draft['assembly-form'] = {
    assembly_name: config.id,
    display_name: String(config.displayName || '').trim(),
    editing_config_id: config.id,
    preset: config.preset,
    target_user: config.targetUser,
    goal: config.goal,
    selected_features: serializeWorkspaceListField(config.features),
    recommended_toolkits: serializeWorkspaceListField(config.toolkits),
    constraints: config.constraints,
    custom_system_prompt: config.customSystemPrompt,
    assembly_stage: 'review',
    env_created: envDir ? '1' : '0',
    env_dir: envDir,
    env_configured_name: config.envConfiguredName || (envDir ? config.id : ''),
    env_configured_features: serializeWorkspaceListField(config.envConfiguredFeatures || []),
    env_status: config.envStatus || (envDir ? 'ready' : ''),
    env_status_message: '',
  };
  draft['feature-configs'] = normalizeFeatureConfigMap(config.featureConfigs);
  saveWorkspaceFormDraft(agent.id, draft);
  try {
    await persistWorkspaceState(agent, draft, { openDirectory: envDir });
    console.log(`[PERF-CLIENT] launchAssemblyConfig persist done (${(performance.now() - _t0).toFixed(0)}ms)`);
  } catch (error) {
    console.error('Failed to stage assembly config for launch:', error);
  }
  console.log(`[PERF-CLIENT] launchAssemblyConfig calling launchAssemblyInstance (${(performance.now() - _t0).toFixed(0)}ms)`);
  await window.launchAssemblyInstance();
};

window.deleteSavedAssemblyConfig = async (configId) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const normalizedId = String(configId || '').trim();
  const keep = getSavedAssemblyConfigs(agent).filter((item) => item.id !== normalizedId);
  const currentState = getAgentWorkspaceState(agent);
  const draft = getWorkspaceFormDraft(agent);
  const currentForm = normalizeAssemblyDraft(draft['assembly-form'] || {});
  if (String(currentForm.editing_config_id || '').trim() === normalizedId || String(currentForm.assembly_name || '').trim() === normalizedId) {
    draft['assembly-form'] = normalizeAssemblyDraft({
      assembly_stage: 'goal',
      preset: 'general-chatbot',
      editing_config_id: '',
      env_created: '0',
      env_status: '',
      env_status_message: '',
      env_dir: '',
      env_configured_name: '',
      env_configured_features: '',
    });
    draft['feature-configs'] = {};
  }
  const response = await fetch('/protoclaw/workspace_state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: agent.id,
      state: {
        forms: draft,
        openDirectory: currentState?.openDirectory || '',
        assemblyConfigs: keep,
      },
    }),
  });
  if (!response.ok) {
    window.alert('Failed to delete assembly config.');
    return;
  }
  const nextState = await response.json();
  updateAgentWorkspaceState(agent.id, nextState);
  saveWorkspaceFormDraft(agent.id, nextState.forms || {});
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

window.launchSavedAssemblyRun = async (sessionId) => {
  const _t0 = performance.now();
  console.log(`[PERF-CLIENT] launchSavedAssemblyRun BEGIN sessionId=${sessionId}`);
  try {
    const currentAgent = getCurrentAgentRecord();
    const session = getWorkspaceSessionById(currentAgent, sessionId);
    if (session && isAssemblySessionRunning(currentAgent, session)) {
      const liveRuntime = allAgents.find((item) => (
        item?.source === 'prebuilt'
        && String(item?.active_workspace_session_form_id || '') === 'assembly-form'
        && String(item?.active_workspace_session_id || item?.workspace_sessions?.activeSessionId || '').trim() === String(sessionId).trim()
        && (item.runtime_session_id || item.runtimeSessionId || item.id)
      )) || null;
      const liveRuntimeId = liveRuntime?.runtime_session_id || liveRuntime?.runtimeSessionId || liveRuntime?.id || currentAgent?.runtime_session_id || currentAgent?.runtimeSessionId || null;
      if (liveRuntimeId) {
        console.log(`[PERF-CLIENT] launchSavedAssemblyRun already running, switching (${(performance.now() - _t0).toFixed(0)}ms)`);
        await requestSwitch(liveRuntimeId, 'assembly-resume');
        return;
      }
    }
    const launchRuntime = async () => {
      console.log(`[PERF-CLIENT] launchSavedAssemblyRun calling /assembly_runtime/start (${(performance.now() - _t0).toFixed(0)}ms)`);
      const response = await fetch('/protoclaw/assembly_runtime/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: currentAgent?.id || 'agent-creator', sessionId }),
      });
      if (!response.ok) {
        throw new Error(await response.text().catch(() => 'Assembly runtime failed'));
      }
      const payload = await response.json();
      console.log(`[PERF-CLIENT] launchSavedAssemblyRun /assembly_runtime/start response (${(performance.now() - _t0).toFixed(0)}ms)`);
      await loadAgents();
      console.log(`[PERF-CLIENT] launchSavedAssemblyRun loadAgents done (${(performance.now() - _t0).toFixed(0)}ms)`);
      const nextRuntimeId = payload?.runtime?.id || payload?.runtime?.viewerAgentId || null;
      if (nextRuntimeId) {
        await requestSwitch(nextRuntimeId, 'assembly-launch');
        console.log(`[PERF-CLIENT] launchSavedAssemblyRun switchAgent done (${(performance.now() - _t0).toFixed(0)}ms)`);
        return;
      }
      selectWorkspaceSurface('agent-creator', { skipFeaturePanel: true });
      shouldAnimateWorkspaceSurface = false;
      renderCurrentMainView();
    };
    await maybeWarnAssemblySessionDrift(currentAgent, sessionId, launchRuntime);
  } catch (error) {
    console.error('Failed to relaunch assembly runtime:', error);
    window.alert('Assembly runtime failed: ' + (error && error.message ? error.message : error));
  }
};

window.fwLaunchConfig = async (configId, btn) => {
  if (btn) { btn.classList.add('fw-btn-busy'); btn.disabled = true; btn.textContent = currentLanguage === 'zh' ? '启动中...' : 'Launching...'; }
  assemblyLaunchInProgress = true;
  const _t0 = performance.now();
  console.log(`[PERF-CLIENT] fwLaunchConfig BEGIN configId=${configId}`);
  try {
    await window.launchAssemblyConfig(configId);
    console.log(`[PERF-CLIENT] fwLaunchConfig COMPLETE (${(performance.now() - _t0).toFixed(0)}ms)`);
  } catch (e) {
    console.error(`[PERF-CLIENT] fwLaunchConfig FAILED (${(performance.now() - _t0).toFixed(0)}ms)`, e);
    if (btn) { btn.classList.remove('fw-btn-busy'); btn.disabled = false; btn.textContent = currentLanguage === 'zh' ? '启动' : 'Launch'; }
  } finally {
    assemblyLaunchInProgress = false;
  }
};

window.fwResumeRun = async (sessionId, btn) => {
  if (btn) { btn.classList.add('fw-btn-busy'); btn.disabled = true; btn.textContent = currentLanguage === 'zh' ? '启动中...' : 'Launching...'; }
  assemblyLaunchInProgress = true;
  const _t0 = performance.now();
  console.log(`[PERF-CLIENT] fwResumeRun BEGIN sessionId=${sessionId}`);
  try {
    await window.launchSavedAssemblyRun(sessionId);
    console.log(`[PERF-CLIENT] fwResumeRun COMPLETE (${(performance.now() - _t0).toFixed(0)}ms)`);
  } catch (e) {
    console.error(`[PERF-CLIENT] fwResumeRun FAILED (${(performance.now() - _t0).toFixed(0)}ms)`, e);
    if (btn) { btn.classList.remove('fw-btn-busy'); btn.disabled = false; btn.textContent = currentLanguage === 'zh' ? '继续' : 'Continue'; }
  } finally {
    assemblyLaunchInProgress = false;
  }
};

window.phOpenModelConfig = async () => {
  const agent = getCurrentAgentRecord();
  if (!agent) return;
  let presets = window.ClawFW?._modelPresets || [];
  if (!presets.length) {
    try {
      const resp = await fetch('/protoclaw/model_config');
      const data = await resp.json();
      presets = Array.isArray(data?.presets) ? data.presets : [];
      if (window.ClawFW) window.ClawFW._modelPresets = presets;
    } catch (e) {
      console.error('Failed to load presets:', e);
    }
  }
  window.phModelConfigAgentId = agent.id;
  renderPhModelConfigOverlay(agent, presets);
};

window.phCloseModelConfig = () => {
  const host = document.getElementById('ph-model-config-host');
  if (host) host.innerHTML = '';
};

window.phSaveModelConfig = async () => {
  const agentId = window.phModelConfigAgentId;
  if (!agentId) return;
  const selects = document.querySelectorAll('#ph-model-config-host .ph-mc-select');
  const modelPresets = { default: null, exploration: null, sub: null, system: null };
  selects.forEach(function(sel) {
    const role = sel.dataset.presetRole;
    if (role && modelPresets.hasOwnProperty(role)) {
      modelPresets[role] = sel.value || null;
    }
  });
  try {
    const resp = await fetch('/protoclaw/agent_model_presets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, modelPresets }),
    });
    const result = await resp.json();
    if (result.ok) {
      const agent = getCurrentAgentRecord();
      if (agent) agent.modelPresets = modelPresets;
      window.phCloseModelConfig();
      try {
        const freshRes = await fetch('/protoclaw/prebuilt_sessions?agentId=' + encodeURIComponent(agentId));
        if (freshRes.ok) {
          const fresh = await freshRes.json();
          updateAgentRecord(agentId, {
            workspace_sessions: fresh,
            active_workspace_session_id: fresh?.activeSessionId || null,
          });
        }
      } catch (e) { /* ignore refresh error */ }
      renderCurrentMainView();
    }
  } catch (e) {
    console.error('Failed to save model preset:', e);
  }
};

window.phOpenProject = async () => {
  const currentAgent = getCurrentAgentRecord();
  if (!currentAgent || currentAgent.id !== 'programming-helper') {
    console.error('Not in programming-helper workspace');
    return;
  }

  try {
    const result = await invoke('select_directory');
    const chosenPath = Array.isArray(result?.paths) ? String(result.paths[0] || '').trim() : (typeof result?.path === 'string' ? result.path.trim() : '');
    if (!chosenPath) {
      return;
    }

    // Open project: add + set as active in one call
    const openRes = await fetch('/protoclaw/ph_project/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openDirectory: chosenPath }),
    });
    if (!openRes.ok) {
      throw new Error(await openRes.text().catch(() => 'Failed to open project'));
    }

    const openResult = await openRes.json();
    // Use returned state directly — no extra fetch
    const freshState = openResult.state || await (await fetch('/protoclaw/workspace_state?agentId=' + encodeURIComponent('programming-helper'))).json();
    updateAgentWorkspaceState('programming-helper', freshState);

    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to open project:', error);
    window.alert((currentLanguage === 'zh' ? '打开项目失败：' : 'Failed to open project: ') + (error?.message || error));
    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
  }
};

window.phSwitchProject = async (projectId) => {
  const currentAgent = getCurrentAgentRecord();
  if (!currentAgent || currentAgent.id !== 'programming-helper') {
    return;
  }

  try {
    const switchRes = await fetch('/protoclaw/ph_project/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
    if (!switchRes.ok) {
      throw new Error(await switchRes.text().catch(() => 'Failed to switch project'));
    }

    const switchResult = await switchRes.json();
    // Use returned state directly — no extra fetch
    const freshState = switchResult.state || await (await fetch('/protoclaw/workspace_state?agentId=' + encodeURIComponent('programming-helper'))).json();
    updateAgentWorkspaceState('programming-helper', freshState);

    // Close dropdown
    const dropdown = document.querySelector('.ph-project-dropdown');
    if (dropdown) dropdown.classList.remove('open');

    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to switch project:', error);
    window.alert((currentLanguage === 'zh' ? '切换项目失败：' : 'Failed to switch project: ') + (error?.message || error));
  }
};

window.phToggleProjectDropdown = (event) => {
  event.stopPropagation();
  const dropdown = document.querySelector('.ph-project-dropdown');
  if (!dropdown) return;
  dropdown.classList.toggle('open');
};

// Close dropdown on outside click
document.addEventListener('click', (e) => {
  const dropdown = document.querySelector('.ph-project-dropdown');
  if (dropdown && !dropdown.contains(e.target)) {
    dropdown.classList.remove('open');
  }
});

window.phOpenInExplorer = async (dirPath) => {
  if (!dirPath) return;
  try {
    await fetch('/protoclaw/ph_project/open_in_explorer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dirPath }),
    });
  } catch (e) {
    console.error('Failed to open in explorer:', e);
  }
};

/* ══════════════════════════════════════
   Generic ctx-menu: declaration table + dispatcher
   ══════════════════════════════════════ */

function getCtxMenuItems(role, ns, variant, id) {
  if (role === 'runtime' && ns === 'programming-helper') {
    return [
      { label: currentLanguage === 'zh' ? '总结历史（摘要）' : 'Summary', action: 'summary' },
      { label: currentLanguage === 'zh' ? '精简历史（Trim）' : 'Trim', action: 'trim' },
      { label: currentLanguage === 'zh' ? '创建分支' : 'Branch', action: 'branch' },
      { type: 'separator' },
      { label: currentLanguage === 'zh' ? '重启 Agent' : 'Restart Agent', action: 'restart' },
      { label: currentLanguage === 'zh' ? '关闭 Agent' : 'Stop Agent', action: 'stop', danger: true },
    ];
  }
  if (role === 'session' && ns === 'programming-helper') {
    return [
      { label: currentLanguage === 'zh' ? '删除对话' : 'Delete', action: 'delete-session', danger: true },
    ];
  }
  return [];
}

async function ctxRestartAgent(target) {
  const { ns, id, sessionId, variant } = target;
  const confirmed = window.confirm(t('restart_prebuilt_confirm'));
  if (!confirmed) return;

  try {
    // serverAgentId: prebuilt agent ID for invoke('restart_agent')
    // domId: runtime ID matching data-agent-id in sidebar DOM
    const serverAgentId = (variant === 'managed-runtime') ? ns : id;
    const domId = id;
    const agent = getExternalRuntimeAgent(serverAgentId);

    // Clear cached runtime data — restart creates a fresh session
    clearAgentRuntimeCache(domId);

    // Track the restarting state in a Set so that any sidebar re-render
    // (e.g. from switching agents during restart) preserves the yellow dot.
    restartingRuntimeIds.add(domId);
    suppressSidebarRerender = true;
    renderAgentList();

    let result = null;
    if (variant === 'external') {
      result = await restartSidebarExternalRuntime(agent);
    } else if (variant === 'child') {
      const hostId = agent?.parent_id || serverAgentId;
      const sId = agent?.active_workspace_session_id || null;
      result = await invoke('restart_agent', { agentId: hostId, sessionId: sId });
    } else {
      // managed-runtime / prebuilt
      const sId = sessionId || agent?.active_workspace_session_id || agent?.workspace_sessions?.activeSessionId || null;
      result = await invoke('restart_agent', { agentId: serverAgentId, sessionId: sId });
    }

    // Server already waits for runtime readiness (up to 10s), so the
    // returned result contains the connected agent. No extra polling needed.
    const nextRuntimeId =
      result?.runtime?.id
      || result?.runtime?.viewerAgentId
      || result?.agent?.runtime_session_id
      || result?.agent?.runtimeSessionId
      || null;

    restartingRuntimeIds.delete(domId);
    suppressSidebarRerender = false;
    await loadAgents();
    if (nextRuntimeId) {
      await requestSwitch(nextRuntimeId, 'ctx-restart');
    }
  } catch (e) {
    restartingRuntimeIds.delete(id);
    suppressSidebarRerender = false;
    renderAgentList();
    window.alert(t('restart_failed') + (e && e.message ? e.message : e));
  }
}

async function ctxStopAgent(target) {
  const { ns, id, sessionId, variant } = target;
  const confirmed = window.confirm(t('close_prebuilt_confirm'));
  if (!confirmed) return;

  try {
    const serverAgentId = (variant === 'managed-runtime') ? ns : id;
    const agent = getExternalRuntimeAgent(serverAgentId);
    const affectedRuntimeId = id || agent?.runtime_session_id || agent?.runtimeSessionId || agent?.id || null;
    // Clear cached data — runtime is being stopped
    if (affectedRuntimeId) clearAgentRuntimeCache(affectedRuntimeId);
    if (variant === 'external') {
      await closeSidebarExternalRuntime(agent);
    } else if (variant === 'child') {
      const hostId = agent?.parent_id || serverAgentId;
      const sId = agent?.active_workspace_session_id || null;
      await invoke('stop_agent', { agentId: hostId, sessionId: sId });
    } else {
      // managed-runtime / prebuilt: pass sessionId to stop only the targeted runtime
      const sId = sessionId || agent?.active_workspace_session_id || null;
      await invoke('stop_agent', { agentId: serverAgentId, sessionId: sId });
    }
    await refreshSidebarRuntimeAfterMutation(500);
    if (affectedRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
      const fallbackTarget = (variant === 'external' || variant === 'child')
        ? (agent?.parent_id || resolveWorkspaceFallbackAgentId(agent))
        : resolveWorkspaceFallbackAgentId(agent);
      if (fallbackTarget) {
        selectWorkspaceSurface(fallbackTarget);
      }
    }
  } catch (e) {
    window.alert(t('close_failed') + (e && e.message ? e.message : e));
  }
}

function dispatchCtxAction(action, target) {
  if (!action || !target) return;
  const { ns, id, sessionId, variant } = target;

  switch (action) {
    case 'activate':
      window.switchAgent(id);
      break;

    case 'summary':
      if (ns && sessionId) {
        window.runWorkspaceAction(JSON.stringify({ type: 'compact_session_menu', sessionId, compactType: 'summary' }));
      }
      break;

    case 'trim':
      if (ns && sessionId) {
        window.openTrimDialog(ns, sessionId);
      }
      break;

    case 'branch':
      if (ns && sessionId) {
        window.openBranchDialog(ns, sessionId);
      }
      break;

    case 'restart':
      window.closeCtxMenu();
      ctxRestartAgent(target);
      break;

    case 'stop':
      window.closeCtxMenu();
      ctxStopAgent(target);
      break;

    case 'delete-session':
      window.closeCtxMenu();
      window.runWorkspaceAction(JSON.stringify({ type: 'delete_session', sessionId: id }));
      break;

    default:
      console.warn('Unknown ctx-menu action:', action, target);
  }
}

window.showCompactMenu = (event, buttonElement) => {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  const rawAction = buttonElement?.dataset?.workspaceAction;
  let action = {};
  try {
    action = typeof rawAction === 'string' ? JSON.parse(rawAction) : rawAction;
  } catch {
    return;
  }

  if (!action.sessionId) return;

  const rect = buttonElement.getBoundingClientRect();
  openCompactMenu(action, rect.left, rect.bottom + 4);
};


function markSessionLoading(agentId, sessionId) {
  const el = document.querySelector(
    `.workspace-history-item[data-prebuilt-session-agent-id="${CSS.escape(agentId)}"][data-prebuilt-session-id="${CSS.escape(sessionId)}"]`
  );
  if (el) el.classList.add('session-loading');
}

function markActionLoading(buttonEl) {
  if (buttonEl) buttonEl.classList.add('action-loading');
}

function clearSessionLoading(agentId) {
  document.querySelectorAll(`.workspace-history-item.session-loading[data-prebuilt-session-agent-id="${CSS.escape(agentId)}"]`)
    .forEach(el => el.classList.remove('session-loading'));
  document.querySelectorAll('.workspace-action.action-loading')
    .forEach(el => el.classList.remove('action-loading'));
}

window.deleteAssemblySessionRecord = async (sessionId) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const session = getWorkspaceSessionById(agent, sessionId);
  const confirmed = window.confirm(currentLanguage === 'zh'
    ? `确认删除这个实例记录？\n${session?.agentName || sessionId}`
    : `Delete this instance record?\n${session?.agentName || sessionId}`);
  if (!confirmed) return;

  try {
    const affectedRuntimeId = agent?.runtime_session_id || agent?.runtimeSessionId || null;
    const deletedWasActive = sessionId === (agent?.active_workspace_session_id || agent?.workspace_sessions?.activeSessionId || null);
    const response = await fetch('/protoclaw/prebuilt_sessions/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: agent.id,
        sessionId,
      }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'delete session failed'));
    }
    const result = await response.json();
    if (result?.assemblyRuntime?.status === 'stopped' || result?.assemblyRuntime?.status === 'stopping') {
      await loadAgents();
      if (currentRuntimeAgentId) {
        selectWorkspaceSurface(agent.id, { skipFeaturePanel: true });
      }
    }
    if (result?.deleted?.sessions) {
      updateAgentRecord(agent.id, {
        workspace_sessions: result.deleted.sessions,
        active_workspace_session_id: result.deleted.activeSessionId || null,
      });
    }
    if (result?.agent) {
      applyManagedPrebuiltAgent(agent.id, result.agent);
    } else if (deletedWasActive) {
      applyManagedPrebuiltAgent(agent.id, null);
    }
    renderAgentList();
    renderCurrentMainView();

    const nextRuntimeId = result?.agent?.runtime_session_id || result?.agent?.runtimeSessionId || null;
    if (nextRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
      await requestSwitch(nextRuntimeId, 'session-delete');
    } else if (affectedRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
      selectWorkspaceSurface(agent.id, { skipFeaturePanel: true });
    }
  } catch (error) {
    console.error('Failed to delete assembly session record:', error);
    window.alert((currentLanguage === 'zh' ? '删除实例记录失败：' : 'Failed to delete instance record: ') + (error?.message || error));
  }
};

window.loadAssemblySessionIntoDraft = async (sessionId) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const session = getWorkspaceSessionById(agent, sessionId);
  if (!session) return;
  const savedConfig = getSavedAssemblyConfigs(agent).find((item) => item.id === String(session.agentName || '').trim()) || null;
  const currentDraft = getWorkspaceFormDraft(agent);

  if (savedConfig) {
    await window.loadSavedAssemblyConfig(savedConfig.id);
  } else {
    currentDraft['assembly-form'] = normalizeAssemblyDraft({
      ...(currentDraft['assembly-form'] || {}),
      assembly_name: String(session.agentName || '').trim(),
      editing_config_id: '',
      assembly_stage: 'review',
      env_created: session.openDirectory ? '1' : '0',
      env_dir: String(session.openDirectory || '').trim(),
      env_configured_name: String(session.agentName || '').trim(),
      env_status: isAssemblySessionRunning(agent, session) ? 'running' : 'ready',
      env_status_message: isAssemblySessionRunning(agent, session)
        ? (currentLanguage === 'zh' ? '这个实例当前正在运行。' : 'This chatbot instance is currently running.')
        : (currentLanguage === 'zh' ? '已从历史实例恢复基础信息。' : 'Restored base information from the previous instance.'),
    });
    saveWorkspaceFormDraft(agent.id, currentDraft);
    await persistWorkspaceState(agent, currentDraft, {
      openDirectory: String(session.openDirectory || '').trim(),
    });
  }

  setPreferredUnitMode('assembly', agent);
  if (agent?.id === 'flow-workspace' && window.ClawFW?.mode === 'detail') {
    currentWorkspaceTab = 'workspace';
  } else {
    currentWorkspaceTab = 'assembly';
  }
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

window.stopAssemblySessionRuntime = async (sessionId) => {
  try {
    const response = await fetch('/protoclaw/assembly_runtime/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'stop assembly runtime failed'));
    }
    await response.json();
    const currentAgent = getCurrentAgentRecord();
    if (currentAgent?.id === 'agent-creator') {
      const draft = getWorkspaceFormDraft(currentAgent);
      const form = normalizeAssemblyDraft(draft['assembly-form'] || {});
      const session = getWorkspaceSessionById(currentAgent, sessionId);
      if (session && String(form.assembly_name || '').trim() === String(session.agentName || '').trim()) {
        await syncAssemblyEnvironmentDraft(currentAgent, draft, {
          env_status: 'ready',
          env_status_message: currentLanguage === 'zh'
            ? '实例已关闭，配置仍可继续编辑或重新启动。'
            : 'Instance stopped. The setup remains available for editing or relaunching.',
        }, {
          persist: true,
        }).catch(() => {});
      }
    }
    await loadAgents();
    if (currentRuntimeAgentId && !allAgents.some((item) => item.id === currentRuntimeAgentId)) {
      selectWorkspaceSurface('agent-creator', { skipFeaturePanel: true });
    }
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to stop assembly runtime:', error);
    window.alert((currentLanguage === 'zh' ? '关闭实例失败：' : 'Failed to stop instance: ') + (error?.message || error));
  }
};

window.chooseWorkspaceDirectory = async (formId, fieldName) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  try {
    const useExistingDirectory = agent.id === 'programming-helper';
    const selected = await invoke(useExistingDirectory ? 'select_directory' : 'select_empty_directory');
    if (selected?.cancelled || !selected?.path) {
      return;
    }
    const draft = getWorkspaceFormDraft(agent);
    draft[formId] = draft[formId] || {};
    draft[formId][fieldName] = selected?.path || '';
    saveWorkspaceFormDraft(agent.id, draft);
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();
    persistWorkspaceState(agent, draft).catch((error) => {
      console.error('Failed to persist directory selection:', error);
    });
  } catch (error) {
    window.alert(t('workspace_pick_directory_failed') + (error && error.message ? error.message : error));
  }
};

window.saveWorkspaceForm = async (formId, rawAction) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  let openDirectoryOverride = null;
  if (agent.id === 'feature-creator' && formId === 'startup-form') {
    const startupDraft = normalizeWorkspaceStartupDraft(agent, draft[formId] || {});
    draft[formId] = startupDraft;
    if (!isValidFeatureCreatorName(startupDraft.feature_name)) {
      window.alert(t('feature_creator_invalid_name'));
      return;
    }
    if (startupDraft.install_mode === 'custom' && !startupDraft.target_dir) {
      window.alert(t('workspace_pick_directory_hint'));
      return;
    }
    if (rawAction) {
      try {
        const response = await fetch('/protoclaw/feature_creator/initialize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            featureName: startupDraft.feature_name,
            parentDir: startupDraft.target_dir,
          }),
        });
        if (!response.ok) {
          throw new Error(await response.text().catch(() => 'Feature initialization failed'));
        }
        const result = await response.json();
        openDirectoryOverride = result?.outputDir || getFeatureCreatorOutputDirectory(agent, startupDraft);
      } catch (error) {
        window.alert(t('feature_creator_init_failed') + (error && error.message ? error.message : error));
        return;
      }
    }
  } else if (agent.id === 'agent-creator' && formId === 'startup-form') {
    const startupDraft = normalizeWorkspaceStartupDraft(agent, draft[formId] || {});
    draft[formId] = startupDraft;
    if (!isValidAgentCreatorName(startupDraft.agent_name)) {
      window.alert('Agent name must use lowercase letters, numbers, and hyphens only.');
      return;
    }
    if (startupDraft.install_mode === 'custom' && !startupDraft.target_dir) {
      window.alert(t('workspace_pick_directory_hint'));
      return;
    }
    if (rawAction) {
      try {
        const response = await fetch('/protoclaw/agent_creator/initialize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentName: startupDraft.agent_name,
            parentDir: startupDraft.target_dir,
            goal: startupDraft.goal || '',
          }),
        });
        if (!response.ok) {
          throw new Error(await response.text().catch(() => 'Agent initialization failed'));
        }
        const result = await response.json();
        openDirectoryOverride = result?.outputDir || getAgentCreatorOutputDirectory(agent, startupDraft);
      } catch (error) {
        window.alert('Agent initialization failed: ' + (error && error.message ? error.message : error));
        return;
      }
    }
  } else if (agent.id === 'agent-creator' && formId === 'assembly-form') {
    const assemblyDraft = { ...(draft[formId] || {}) };
    if (!isValidAgentCreatorName(assemblyDraft.assembly_name)) {
      window.alert('Assembly name must use lowercase letters, numbers, and hyphens only.');
      return;
    }
    draft[formId] = assemblyDraft;
  }
  saveWorkspaceFormDraft(agent.id, draft);
  try {
    await persistWorkspaceState(agent, draft, { openDirectory: openDirectoryOverride });
  } catch (error) {
    console.error('Failed to persist workspace form:', error);
    window.alert(`Workspace save failed: ${error && error.message ? error.message : error}`);
    return;
  }
  if (rawAction) {
    await window.runWorkspaceAction(rawAction);
    return;
  }
  renderCurrentMainView();
};

window.resetWorkspaceForm = async (formId) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  if (formId) {
    delete draft[formId];
    saveWorkspaceFormDraft(agent.id, draft);
  } else {
    resetWorkspaceFormDraft(agent.id);
  }
  try {
    await persistWorkspaceState(agent, formId ? draft : {});
  } catch (error) {
    console.error('Failed to reset workspace form state:', error);
  }
  renderCurrentMainView();
};

/**
 * Flush the pending switch slot: if the serial still matches, execute the
 * actual switchAgent call and clear the slot.  Only the most recent
 * requestSwitch() call wins; stale flushes are silently discarded.
 */
function flushPendingSwitch(serial, resolve) {
  if (!pendingSwitchTarget || pendingSwitchTarget.serial !== serial) {
    resolve({ switched: false, reason: 'superseded' });
    return;
  }
  const runtimeId = pendingSwitchTarget.runtimeId;
  pendingSwitchTarget = null;
  window.switchAgent(runtimeId).then(
    () => resolve({ switched: true }),
    (e) => resolve({ switched: false, reason: e?.message }),
  );
}

/**
 * Request a deferred agent switch.  The call-site is an async operation
 * that has just completed (B-class).  The target is written to the
 * "pending switch slot"; only the most recent caller's serial wins.
 *
 * Returns a Promise so callers can still `await` it; resolves with
 * { switched: true } or { switched: false, reason }.
 *
 * @param {string} runtimeId  The runtime agent id to switch to.
 * @param {string} source     A short label for debugging (e.g. 'launch', 'restart').
 */
function requestSwitch(runtimeId, source) {
  pendingSwitchSerial += 1;
  const serial = pendingSwitchSerial;
  pendingSwitchTarget = { runtimeId, serial, source };
  return new Promise((resolve) => {
    setTimeout(() => flushPendingSwitch(serial, resolve), 0);
  });
}

window.switchAgent = async (newAgentId) => {
  // A-class (direct) calls cancel any pending deferred switch.
  pendingSwitchTarget = null;
  const epoch = ++_switchEpoch;
  closeAgentContextMenu();
  const targetAgent = findAgentByIdentity(newAgentId);
  const requestedRuntimeOfWorkspaceHost = !!(
    targetAgent
    && isWorkspaceHostUnit(targetAgent)
    && newAgentId
    && newAgentId !== targetAgent.id
    && (targetAgent.runtime_session_id === newAgentId || targetAgent.runtimeSessionId === newAgentId)
  );
  const runtimeAgentId = requestedRuntimeOfWorkspaceHost
    ? newAgentId
    : (targetAgent ? getAgentRuntimeId(targetAgent) : newAgentId);
  if (!runtimeAgentId) return;
  if (isWorkspaceSurfaceUnit(targetAgent) && !requestedRuntimeOfWorkspaceHost) {
    if (targetAgent?.id === currentAgentId && !currentRuntimeAgentId) return;
    selectWorkspaceSurface(targetAgent.id);
    return;
  }
  if (targetAgent?.id === currentAgentId && runtimeAgentId === currentRuntimeAgentId) return;
  _storeVisibleSessionInputDraft();
  if (currentRuntimeAgentId && !readOnlyMode) {
    saveCurrentRuntimeToCache(currentRuntimeAgentId);
  }
  try {
    // Set global state and do optimistic render IMMEDIATELY — before the PUT.
    // This lets the user see cached data without waiting for a network round trip.
    currentAgentId = targetAgent?.parent_id || targetAgent?.id || runtimeAgentId;
    currentRuntimeAgentId = runtimeAgentId;
    readOnlyMode = false;
    currentWorkspaceArtifactDetail = null;
    currentWorkspaceDocsetDetail = null;
    currentProjectDocsetOpen = false;
    currentProjectRequirementEdit = null;
    currentProjectDocsetPage = 'requirement';
    currentWorkspaceTab = 'chat';
    // Optimistic restore: show cached data immediately if available
    const _restored = restoreRuntimeFromCache(runtimeAgentId);
    if (_restored) {
      lastRenderedWorkspaceHtml = '';
      renderCurrentMainView();
      renderFeaturePanel();
    } else {
      // No cache: clear overview to avoid stale display
      setCurrentOverviewSnapshot(getEmptyOverviewSnapshot());
    }
    beginFollowLatestCooldown();
    beginFollowLatestEntryWindow();
    setFollowLatest(true);
    renderAgentList();

    // Fire PUT in parallel with loadAgentData — loadAgentData uses explicit
    // agentId in all fetch URLs, so it doesn't depend on the PUT completing.
    const _putPromise = fetch('/api/agents/current', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: runtimeAgentId })
    }).then((res) => {
      if (!res.ok && res.status !== 404) {
        console.warn(`Switch PUT returned ${res.status} ${res.statusText}`);
      }
    }).catch((e) => {
      console.warn('Switch PUT failed:', e?.message || e);
    });

    await loadAgentData(runtimeAgentId);
    await _putPromise;
    // Only refresh the agent list if no newer switch has happened — a stale
    // switchAgent continuation could otherwise trigger loadAgentData for the
    // wrong agent via the loadAgents() initialization path (PUT race).
    if (epoch === _switchEpoch) {
      loadAgents().catch((error) => console.error('Failed to refresh agents after switch:', error));
    }
  } catch (e) {
    console.error('Failed to switch agent:', e);
    window.alert(`Switch failed: ${e && e.message ? e.message : e}`);
  }
};

window.openAgentActions = (event, agentId) => {
  event.preventDefault();
  const agent = allAgents.find(item => item.id === agentId);
  if (!agent) return;
  const mode = agent.source === 'prebuilt'
    ? 'prebuilt-runtime'
    : (agent.source === 'child' || agent.source === 'managed-runtime')
      ? 'child-runtime'
    : (agent.source === 'external' && agent.connected !== false)
      ? 'external-runtime'
    : (agent.connected === false ? 'delete-only' : null);
  if (!mode) return;
  openAgentContextMenu(agentId, event.clientX, event.clientY, mode);
};

function getExternalRuntimeAgent(agentId) {
  return allAgents.find((item) => item.id === agentId) || null;
}

function isAssemblyExternalRuntime(agent) {
  return !!(
    agent
    && agent.source === 'external'
    && String(agent.active_workspace_session_form_id || '').trim() === 'assembly-form'
    && String(agent.active_workspace_session_id || '').trim()
  );
}

async function closeExternalRuntime(agent) {
  if (isAssemblyExternalRuntime(agent)) {
    const sessionId = String(agent.active_workspace_session_id || '').trim();
    const response = await fetch('/protoclaw/assembly_runtime/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'stop assembly runtime failed'));
    }
    return response.json().catch(() => ({}));
  }

  const runtimeId = agent?.runtime_session_id || agent?.runtimeSessionId || agent?.id;
  const response = await fetch(`/api/agents/${encodeURIComponent(runtimeId)}`, { method: 'DELETE' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'close external runtime failed');
  }
  return payload;
}

async function restartExternalRuntime(agent) {
  if (!isAssemblyExternalRuntime(agent)) {
    throw new Error(currentLanguage === 'zh'
      ? '当前外部 Agent 没有可用的重启宿主。'
      : 'This external agent does not expose a restart host.');
  }

  const sessionId = String(agent.active_workspace_session_id || '').trim();
  const ownerAgentId = String(agent.parent_id || 'agent-creator').trim() || 'agent-creator';

  await closeExternalRuntime(agent);

  const response = await fetch('/protoclaw/assembly_runtime/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: ownerAgentId, sessionId }),
  });
  if (!response.ok) {
    throw new Error(await response.text().catch(() => 'restart assembly runtime failed'));
  }
  return response.json().catch(() => ({}));
}

async function resolveSidebarAssemblyRuntimeTarget(agent) {
  if (!agent || agent.source !== 'external') return null;

  const explicitSessionId = String(agent.active_workspace_session_id || '').trim();
  if (String(agent.active_workspace_session_form_id || '').trim() === 'assembly-form' && explicitSessionId) {
    return {
      ownerAgentId: String(agent.parent_id || 'flow-workspace').trim() || 'flow-workspace',
      sessionId: explicitSessionId,
    };
  }

  const runtimeName = String(agent.name || '').trim();
  if (!runtimeName) return null;

  const ownerCandidates = ['flow-workspace', 'agent-creator'];
  for (const ownerAgentId of ownerCandidates) {
    try {
      const response = await fetch(`/protoclaw/prebuilt_sessions?agentId=${encodeURIComponent(ownerAgentId)}`);
      if (!response.ok) continue;
      const data = await response.json().catch(() => null);
      const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
      const assemblyMatches = sessions.filter((session) =>
        String(session?.formId || '').trim() === 'assembly-form'
        && String(session?.agentName || '').trim() === runtimeName
      );
      if (!assemblyMatches.length) continue;

      const activeSessionId = String(data?.activeSessionId || '').trim();
      const activeMatch = assemblyMatches.find((session) => String(session?.id || '').trim() === activeSessionId);
      const chosen = activeMatch || assemblyMatches[0];
      const chosenId = String(chosen?.id || '').trim();
      if (chosenId) {
        return { ownerAgentId, sessionId: chosenId };
      }
    } catch (error) {
      console.warn('Failed to resolve sidebar assembly runtime target:', ownerAgentId, error);
    }
  }

  return null;
}

async function closeSidebarExternalRuntime(agent) {
  const assemblyTarget = await resolveSidebarAssemblyRuntimeTarget(agent);
  if (assemblyTarget?.sessionId) {
    const response = await fetch('/protoclaw/assembly_runtime/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: assemblyTarget.sessionId }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'stop assembly runtime failed'));
    }
    return response.json().catch(() => ({}));
  }

  throw new Error(currentLanguage === 'zh'
    ? '当前这个外部 Agent 还没有可用的关闭通道。'
    : 'This external agent does not currently expose a supported stop channel.');
}

async function restartSidebarExternalRuntime(agent) {
  const assemblyTarget = await resolveSidebarAssemblyRuntimeTarget(agent);
  if (!assemblyTarget?.sessionId) {
    throw new Error(currentLanguage === 'zh'
      ? '当前这个外部 Agent 还没有可用的重启通道。'
      : 'This external agent does not expose a restart host.');
  }

  await closeSidebarExternalRuntime(agent);
  const ownerAgentId = String(assemblyTarget.ownerAgentId || agent?.parent_id || 'flow-workspace').trim() || 'flow-workspace';

  const response = await fetch('/protoclaw/assembly_runtime/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: ownerAgentId, sessionId: assemblyTarget.sessionId }),
  });
  if (!response.ok) {
    throw new Error(await response.text().catch(() => 'restart assembly runtime failed'));
  }
  return response.json().catch(() => ({}));
}

async function refreshSidebarRuntimeAfterMutation(delayMs = 0) {
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  await loadAgents();
}

restartAgentAction.addEventListener('click', async () => {
  if (!contextMenuAgentId || (contextMenuAgentMode !== 'prebuilt-runtime' && contextMenuAgentMode !== 'external-runtime' && contextMenuAgentMode !== 'child-runtime')) return;
  const confirmed = window.confirm(t('restart_prebuilt_confirm'));
  if (!confirmed) {
    closeAgentContextMenu();
    return;
  }

  try {
    const agent = getExternalRuntimeAgent(contextMenuAgentId);
    // Clear cached data — restart creates a fresh session
    clearAgentRuntimeCache(contextMenuAgentId);
    const runtimeItem = document.querySelector(`[data-agent-id="${CSS.escape(contextMenuAgentId)}"]`);
    if (runtimeItem) {
      runtimeItem.classList.add('restarting');
      runtimeItem.classList.remove('active', 'disconnected');
    }
    suppressSidebarRerender = true;
    let result = null;
    if (contextMenuAgentMode === 'external-runtime') {
      closeAgentContextMenu();
      result = await restartSidebarExternalRuntime(agent);
    } else if (contextMenuAgentMode === 'child-runtime') {
      const hostId = agent?.parent_id || contextMenuAgentId;
      const sessionId = agent?.active_workspace_session_id || null;
      closeAgentContextMenu();
      result = await invoke('restart_agent', { agentId: hostId, sessionId });
    } else {
      const sessionId = agent?.active_workspace_session_id || agent?.workspace_sessions?.activeSessionId || null;
      closeAgentContextMenu();
      result = await invoke('restart_agent', { agentId: contextMenuAgentId, sessionId });
    }
    const nextRuntimeId =
      result?.runtime?.id
      || result?.runtime?.viewerAgentId
      || result?.agent?.runtime_session_id
      || result?.agent?.runtimeSessionId
      || null;
    if (nextRuntimeId) {
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const agents = await invoke('get_connected_agents');
          const found = agents.find((a) => a.runtime_session_id === nextRuntimeId || a.id === nextRuntimeId);
          if (found && found.connected !== false) break;
        } catch (_) { /* ignore */ }
      }
    }
    suppressSidebarRerender = false;
    await loadAgents();
    if (nextRuntimeId) {
      await requestSwitch(nextRuntimeId, 'restart-handler');
    }
  } catch (e) {
    suppressSidebarRerender = false;
    closeAgentContextMenu();
    window.alert(t('restart_failed') + (e && e.message ? e.message : e));
  }
});

stopAgentAction.addEventListener('click', async () => {
  if (!contextMenuAgentId || (contextMenuAgentMode !== 'prebuilt-runtime' && contextMenuAgentMode !== 'external-runtime' && contextMenuAgentMode !== 'child-runtime')) return;
  const confirmed = window.confirm(t('close_prebuilt_confirm'));
  if (!confirmed) {
    closeAgentContextMenu();
    return;
  }

  try {
    const agent = getExternalRuntimeAgent(contextMenuAgentId);
    const affectedRuntimeId = agent?.runtime_session_id || agent?.runtimeSessionId || agent?.id || null;
    // Clear cached data — runtime is being stopped
    if (affectedRuntimeId) clearAgentRuntimeCache(affectedRuntimeId);
    if (contextMenuAgentMode === 'external-runtime') {
      await closeSidebarExternalRuntime(agent);
    } else if (contextMenuAgentMode === 'child-runtime') {
      const hostId = agent?.parent_id || contextMenuAgentId;
      const sessionId = agent?.active_workspace_session_id || null;
      await invoke('stop_agent', { agentId: hostId, sessionId });
    } else {
      await invoke('stop_agent', { agentId: contextMenuAgentId });
    }
    closeAgentContextMenu();
    await refreshSidebarRuntimeAfterMutation(500);
    if (affectedRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
      const fallbackTarget = contextMenuAgentMode === 'external-runtime'
        ? (agent?.parent_id || resolveWorkspaceFallbackAgentId(agent))
        : contextMenuAgentMode === 'child-runtime'
          ? (agent?.parent_id || resolveWorkspaceFallbackAgentId(agent))
          : resolveWorkspaceFallbackAgentId(agent);
      if (fallbackTarget) {
        selectWorkspaceSurface(fallbackTarget);
      }
    }
  } catch (e) {
    closeAgentContextMenu();
    window.alert(t('close_failed') + (e && e.message ? e.message : e));
  }
});

openSessionAction.addEventListener('click', async () => {
  if (!contextMenuSessionAgentId || !contextMenuSessionId) return;
  const sessionId = contextMenuSessionId;
  const mode = contextMenuSessionMode;
  closeSessionContextMenu();
  if (mode === 'assembly') {
    await window.launchSavedAssemblyRun(sessionId);
  } else {
    await window.runWorkspaceAction(JSON.stringify({ type: 'open_session', sessionId }));
  }
});

compactedResumeSessionAction.addEventListener('click', async () => {
  if (!contextMenuSessionAgentId || !contextMenuSessionId) return;
  if (contextMenuSessionMode === 'assembly') {
    closeSessionContextMenu();
    return;
  }
  const sessionId = contextMenuSessionId;
  closeSessionContextMenu();
  await window.runWorkspaceAction(JSON.stringify({
    type: 'compacted_resume_session',
    sessionId,
  }));
});

compactSummaryAction.addEventListener('click', async () => {
  if (!contextMenuCompactAction?.sessionId) return;
  const action = { ...contextMenuCompactAction, compactType: 'summary' };
  closeCompactMenu();
  await window.runWorkspaceAction(action);
});

compactTrimAction.addEventListener('click', async () => {
  if (!contextMenuCompactAction?.sessionId) return;
  const action = { ...contextMenuCompactAction, compactType: 'trim' };
  closeCompactMenu();
  await window.runWorkspaceAction(action);
});

compactBranchAction.addEventListener('click', () => {
  if (!contextMenuCompactAction?.sessionId) return;
  const sessionId = contextMenuCompactAction.sessionId;
  const activeAgent = getCurrentAgentRecord();
  if (!activeAgent?.id) return;
  closeCompactMenu();
  window.openBranchDialog(activeAgent.id, sessionId);
});

deleteAgentAction.addEventListener('click', async () => {
  if (!contextMenuAgentId || contextMenuAgentMode !== 'delete-only') return;

  const agent = allAgents.find(item => item.id === contextMenuAgentId);
  if (!agent || agent.connected !== false) {
    closeAgentContextMenu();
    return;
  }

  try {
    const res = await fetch(`/api/agents/${contextMenuAgentId}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || t('delete_failed_generic'));
    }

    closeAgentContextMenu();
    await loadAgents();

    if (currentAgentId === contextMenuAgentId || currentRuntimeAgentId === contextMenuAgentId) {
      const fallbackId = resolveWorkspaceFallbackAgentId(agent);
      if (fallbackId) {
        selectWorkspaceSurface(fallbackId, { skipFeaturePanel: true });
      }
    } else if (!data.currentAgentId) {
      currentAgentId = null;
      currentRuntimeAgentId = null;
      currentWorkspaceTab = null;
      currentMessages = [];
      window.lastInputRequests = [];
      renderInputRequests([]);
      setCurrentLogs([]);
      setCurrentHookInspector({ lifecycleOrder: [], features: [], hooks: [] });
      setCurrentOverviewSnapshot(getEmptyOverviewSnapshot());
      renderCurrentMainView();
      setFollowLatest(true);
      currentAgentTitle.textContent = t('page_title');
    }
  } catch (e) {
    closeAgentContextMenu();
    window.alert(t('delete_failed') + (e && e.message ? e.message : e));
  }
});

deleteSessionAction.addEventListener('click', async () => {
  if (!contextMenuSessionAgentId || !contextMenuSessionId) return;

  const pendingAgentId = contextMenuSessionAgentId;
  const pendingSessionId = contextMenuSessionId;

  closeSessionContextMenu();

  const targetAgent = allAgents.find((item) => item.id === pendingAgentId) || null;
  const affectedRuntimeId = targetAgent?.runtime_session_id || targetAgent?.runtimeSessionId || null;
  // Clear cached data for the deleted session's runtime
  if (affectedRuntimeId) clearAgentRuntimeCache(affectedRuntimeId);
  const deletedWasActive = pendingSessionId === (targetAgent?.active_workspace_session_id || targetAgent?.workspace_sessions?.activeSessionId || null);

  if (deletedWasActive) {
    applyManagedPrebuiltAgent(pendingAgentId, null);
  }
  const currentSessions = getWorkspaceSessions(targetAgent);
  const remainingSessions = currentSessions.filter((s) => s.id !== pendingSessionId);
  const nextActiveId = remainingSessions.length > 0 ? (targetAgent?.active_workspace_session_id === pendingSessionId ? remainingSessions[0].id : targetAgent?.active_workspace_session_id) : null;
  updateAgentRecord(pendingAgentId, {
    workspace_sessions: { sessions: remainingSessions, activeSessionId: nextActiveId },
    active_workspace_session_id: nextActiveId,
  });

  if (pendingAgentId === 'flow-workspace' && window.ClawFW?.mode === 'detail') {
    fwBackToList();
    renderAgentList();
  } else if (pendingAgentId === 'flow-workspace') {
    renderAgentList();
  }
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();

  try {
    const response = await fetch('/protoclaw/prebuilt_sessions/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: pendingAgentId,
        sessionId: pendingSessionId,
      }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'delete session failed'));
    }
    const result = await response.json();

    if (result?.deleted?.sessions) {
      updateAgentRecord(pendingAgentId, {
        workspace_sessions: result.deleted.sessions,
        active_workspace_session_id: result.deleted.activeSessionId || null,
      });
    }
    if (result?.agent) {
      applyManagedPrebuiltAgent(pendingAgentId, result.agent);
    }

    const nextRuntimeId = result?.agent?.runtime_session_id || result?.agent?.runtimeSessionId || null;
    if (nextRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
      await requestSwitch(nextRuntimeId, 'stop-handler');
    } else if (affectedRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
      const fallbackAgent = applyManagedPrebuiltAgent(pendingAgentId, null, { uiOnlyWhenStopped: true });
      setPreferredUnitMode('home', fallbackAgent || targetAgent || { id: pendingAgentId, source: 'prebuilt' });
      selectWorkspaceSurface(pendingAgentId);
    }


    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
  } catch (e) {
    updateAgentRecord(pendingAgentId, {
      workspace_sessions: { sessions: currentSessions, activeSessionId: targetAgent?.active_workspace_session_id },
      active_workspace_session_id: targetAgent?.active_workspace_session_id,
    });
    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
    window.alert(t('delete_session_failed') + (e && e.message ? e.message : e));
  }
});

deleteProjectAction.addEventListener('click', () => {
  if (!contextMenuProjectAgentId || !contextMenuProjectId) return;

  const pendingAgentId = contextMenuProjectAgentId;
  const pendingProjectId = contextMenuProjectId;
  closeProjectContextMenu();

  const projectName = (() => {
    if (pendingAgentId === 'flow-workspace') {
      const agent = allAgents.find(a => a.id === pendingAgentId);
      const config = getSavedAssemblyConfigs(agent).find(c => c.id === pendingProjectId);
      return config?.name || config?.id || pendingProjectId;
    }
    if (pendingAgentId === 'programming-helper') {
      const agent = allAgents.find(a => a.id === pendingAgentId);
      const project = getProgrammingHelperProjects(agent).find(p => p.id === pendingProjectId);
      return project?.name || project?.openDirectory || pendingProjectId;
    }
    return pendingProjectId;
  })();

  if (pendingAgentId === 'programming-helper') {
    const confirmed = window.confirm(
      currentLanguage === 'zh'
        ? '确定要删除项目「' + projectName + '」吗？该项目下的所有对话记录将一并删除，此操作不可撤销。'
        : 'Delete project "' + projectName + '"? All conversations under this project will also be deleted. This cannot be undone.'
    );
    if (!confirmed) return;
    (async () => {
      try {
        const agent = allAgents.find(a => a.id === pendingAgentId);
        const affectedRuntimeId = agent?.runtime_session_id || agent?.runtimeSessionId || null;
        const activeSessionId = agent?.active_workspace_session_id || agent?.workspace_sessions?.activeSessionId || null;
        const response = await fetch('/protoclaw/prebuilt_project/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: pendingAgentId, projectId: pendingProjectId }),
        });
        if (!response.ok) {
          throw new Error(await response.text().catch(() => 'delete project failed'));
        }
        const result = await response.json();
        if (result?.deleted?.sessions) {
          updateAgentRecord(pendingAgentId, {
            workspace_sessions: result.deleted.sessions,
            active_workspace_session_id: result.deleted.activeSessionId || null,
          });
        }
        const deletedContainedActive = result?.deleted?.deletedSessionIds?.includes(activeSessionId);
        if (result?.agent) {
          applyManagedPrebuiltAgent(pendingAgentId, result.agent);
        } else if (deletedContainedActive) {
          applyManagedPrebuiltAgent(pendingAgentId, null);
        }
        const stateRes = await fetch('/protoclaw/workspace_state?agentId=' + encodeURIComponent(pendingAgentId));
        if (stateRes.ok) {
          const nextState = await stateRes.json();
          updateAgentWorkspaceState(pendingAgentId, nextState);
        }
        lastRenderedWorkspaceHtml = '';
        renderAgentList();
        renderCurrentMainView();
        const nextRuntimeId = result?.agent?.runtime_session_id || result?.agent?.runtimeSessionId || null;
        if (nextRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
          await requestSwitch(nextRuntimeId, 'stop-handler');
        } else if (affectedRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
          const fallbackAgent = applyManagedPrebuiltAgent(pendingAgentId, null, { uiOnlyWhenStopped: true });
          setPreferredUnitMode('home', fallbackAgent || agent || { id: pendingAgentId, source: 'prebuilt' });
          selectWorkspaceSurface(pendingAgentId);
        }
      } catch (error) {
        console.error('Failed to delete programming-helper project:', error);
        window.alert((currentLanguage === 'zh' ? '删除项目失败：' : 'Failed to delete project: ') + (error?.message || error));
      }
    })();
    return;
  }

  fwOpenConfirmDialog({
    title: currentLanguage === 'zh' ? '删除项目' : 'Delete Project',
    message: currentLanguage === 'zh'
      ? '确定要删除项目「' + projectName + '」吗？该项目下的所有对话记录将一并删除，此操作不可撤销。'
      : 'Delete project "' + projectName + '"? All conversations under this project will also be deleted. This cannot be undone.',
    confirmLabel: currentLanguage === 'zh' ? '删除' : 'Delete',
    danger: true,
    onConfirm: async () => {
      try {
        if (pendingAgentId === 'flow-workspace') {
          const agent = allAgents.find(a => a.id === pendingAgentId);
          const config = getSavedAssemblyConfigs(agent).find(c => c.id === pendingProjectId);
          const matchNames = new Set([pendingProjectId]);
          if (config) {
            if (config.name) matchNames.add(String(config.name).trim());
            if (config.displayName) matchNames.add(String(config.displayName).trim());
          }
          const relatedRuns = getWorkspaceSessions(agent).filter(s => {
            const name = String(s?.agentName || s?.assemblyName || '').trim();
            return matchNames.has(name);
          });
          // Delete sessions first, then config — avoids intermediate render showing orphaned sessions
          for (const run of relatedRuns) {
            await fetch('/protoclaw/prebuilt_sessions/delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ agentId: pendingAgentId, sessionId: run.id }),
            }).catch(() => {});
          }
          await window.deleteSavedAssemblyConfig(pendingProjectId);
          // Refresh session data after both deletions
          const sessionsRes = await fetch('/protoclaw/prebuilt_sessions?agentId=' + encodeURIComponent(pendingAgentId));
          if (sessionsRes.ok) {
            const fresh = await sessionsRes.json();
            updateAgentRecord(pendingAgentId, {
              workspace_sessions: fresh,
              active_workspace_session_id: fresh?.activeSessionId || null,
            });
          }
          if (window.ClawFW?.mode === 'detail' && window.ClawFW?._projectId === pendingProjectId) {
            fwBackToList();
          } else {
            lastRenderedWorkspaceHtml = '';
            fwRerender();
          }
          return;
        }
        const targetAgent = allAgents.find((item) => item.id === pendingAgentId) || null;
        const affectedRuntimeId = targetAgent?.runtime_session_id || targetAgent?.runtimeSessionId || null;
        const activeSessionId = targetAgent?.active_workspace_session_id || targetAgent?.workspace_sessions?.activeSessionId || null;
        const response = await fetch('/protoclaw/prebuilt_project/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: pendingAgentId,
            projectId: pendingProjectId,
          }),
        });
        if (!response.ok) {
          throw new Error(await response.text().catch(() => 'delete project failed'));
        }
        const result = await response.json();
        if (result?.deleted?.sessions) {
          updateAgentRecord(pendingAgentId, {
            workspace_sessions: result.deleted.sessions,
            active_workspace_session_id: result.deleted.activeSessionId || null,
          });
        }
        const deletedContainedActive = result?.deleted?.deletedSessionIds?.includes(activeSessionId);
        if (result?.agent) {
          applyManagedPrebuiltAgent(pendingAgentId, result.agent);
        } else if (deletedContainedActive) {
          applyManagedPrebuiltAgent(pendingAgentId, null);
        }
        lastRenderedWorkspaceHtml = '';
        renderAgentList();
        renderCurrentMainView();

        const nextRuntimeId = result?.agent?.runtime_session_id || result?.agent?.runtimeSessionId || null;
        if (nextRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
          await requestSwitch(nextRuntimeId, 'stop-handler');
        } else if (affectedRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
          const fallbackAgent = applyManagedPrebuiltAgent(pendingAgentId, null, { uiOnlyWhenStopped: true });
          setPreferredUnitMode('home', fallbackAgent || targetAgent || { id: pendingAgentId, source: 'prebuilt' });
          selectWorkspaceSurface(pendingAgentId);
        }
      } catch (e) {
        window.alert(t('delete_project_failed') + (e && e.message ? e.message : e));
      }
    },
  });
});

deleteFeatureAction.addEventListener('click', async () => {
  if (!contextMenuFeatureRepoPackageId) return;

  const confirmed = window.confirm(getRepoLocaleText('确定要删除这个 Feature 吗？', 'Are you sure you want to delete this feature?'));
  if (!confirmed) {
    closeFeatureRepoContextMenu();
    return;
  }

  try {
    const response = await fetch('/protoclaw/feature_repository/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        packageId: contextMenuFeatureRepoPackageId,
      }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'delete feature failed'));
    }
    closeFeatureRepoContextMenu();
    renderCurrentMainView();
  } catch (e) {
    closeFeatureRepoContextMenu();
    window.alert(getRepoLocaleText('删除 Feature 失败: ', 'Delete feature failed: ') + (e && e.message ? e.message : e));
  }
});

document.addEventListener('click', (event) => {
  // ── Generic ctx-menu action handling ──
  const ctxBtn = event.target.closest('#ctx-menu button.ctx-menu-item[data-ctx-action]');
  if (ctxBtn && ctxMenu.classList.contains('open')) {
    const action = ctxBtn.dataset.ctxAction;
    if (action && window._ctxTarget) {
      dispatchCtxAction(action, window._ctxTarget);
    }
    window.closeCtxMenu();
    return;
  }
  // Close ctx-menu on outside click
  if (!ctxMenu.contains(event.target)) {
    window.closeCtxMenu();
  }

  if (!agentContextMenu.contains(event.target)) {
    closeAgentContextMenu();
  }
  if (!sessionContextMenu.contains(event.target)) {
    closeSessionContextMenu();
  }
  if (!compactContextMenu.contains(event.target)) {
    closeCompactMenu();
  }
  if (!projectContextMenu.contains(event.target)) {
    closeProjectContextMenu();
  }
  if (!featureRepoContextMenu.contains(event.target)) {
    closeFeatureRepoContextMenu();
  }
});

window.addEventListener('resize', () => {
  window.closeCtxMenu();
  closeAgentContextMenu();
  closeCompactMenu();
  closeProjectContextMenu();
  closeFeatureRepoContextMenu();
  featurePanelWidth = Math.max(400, Math.min(750, featurePanelWidth));
  if (featurePanel.classList.contains('open')) {
    featurePanel.style.setProperty('--feature-panel-width', featurePanelWidth + 'px');
  }
  requestAnimationFrame(updateAssemblySideRailPosition);
});
window.addEventListener('scroll', () => {
  closeAgentContextMenu();
  closeSessionContextMenu();
  closeCompactMenu();
  closeProjectContextMenu();
  requestAnimationFrame(updateAssemblySideRailPosition);
}, true);
container.addEventListener('wheel', () => registerManualScrollIntent({ interrupt: true }), { passive: true });
container.addEventListener('wheel', () => window.closeCtxMenu(), { passive: true });
container.addEventListener('touchmove', () => registerManualScrollIntent({ interrupt: true }), { passive: true });
container.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'mouse' || event.pointerType === 'touch' || event.pointerType === 'pen') {
    registerManualScrollIntent();
  }
}, { passive: true });
container.addEventListener('contextmenu', (event) => {
  // ── Generic ctx-menu for workspace sessions ──
  const ctxEl = event.target.closest('[data-ctx-role]');
  if (ctxEl) {
    const role = ctxEl.dataset.ctxRole;
    const ns = ctxEl.dataset.ctxNs;
    const id = ctxEl.dataset.ctxId;
    const variant = ctxEl.dataset.ctxVariant || 'default';
    const items = getCtxMenuItems(role, ns, variant, id);
    if (items.length > 0) {
      event.preventDefault();
      window.closeCtxMenu();
      closeAgentContextMenu();
      closeSessionContextMenu();
      closeCompactMenu();
      closeProjectContextMenu();
      window.showCtxMenu(event.clientX, event.clientY, items, { role, ns, id, variant });
      return;
    }
  }

  const featureRepoItem = event.target.closest('.workspace-repo-card[data-feature-repo-package-id]');
  if (featureRepoItem) {
    event.preventDefault();
    openFeatureRepoContextMenu(
      featureRepoItem.dataset.featureRepoPackageId,
      event.clientX,
      event.clientY,
    );
    return;
  }
  const projectItem = event.target.closest('[data-prebuilt-project-id]');
  if (projectItem) {
    event.preventDefault();
    openProjectContextMenu(
      projectItem.dataset.prebuiltProjectAgentId,
      projectItem.dataset.prebuiltProjectId,
      event.clientX,
      event.clientY,
    );
    return;
  }
  const item = event.target.closest('[data-prebuilt-session-id]');
  if (!item) return;
  event.preventDefault();
  openSessionContextMenu(
    item.dataset.prebuiltSessionAgentId,
    item.dataset.prebuiltSessionId,
    event.clientX,
    event.clientY,
  );
});
container.addEventListener('keydown', (event) => {
  if (['ArrowUp', 'PageUp', 'Home', ' '].includes(event.key)) {
    registerManualScrollIntent({ interrupt: true });
  }
});
container.addEventListener('scroll', () => {
  if (suppressFollowScrollEvent || !followLatestEnabled) {
    return;
  }
  if (!isNearBottom() && hasRecentManualScrollIntent()) {
    setFollowLatest(false);
  }
});
followLatestButton.addEventListener('click', () => {
  setFollowLatest(true, { scroll: true, behavior: 'smooth' });
});

ensureNotificationClockTimer();

async function loadLogs(forceRender = false) {
  try {
    const params = new URLSearchParams({
      scope: logPanelScope,
    });
    if (currentRuntimeAgentId) {
      params.set('agentId', currentRuntimeAgentId);
    }

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
      setCurrentLogs(nextLogs);
      if (activeFeaturePanel === 'logs') {
        renderFeaturePanel();
      }
    } else if (forceRender && activeFeaturePanel === 'logs') {
      renderFeaturePanel();
    }
  } catch (e) {
    if (forceRender && activeFeaturePanel === 'logs') {
      setCurrentLogs([]);
      renderFeaturePanel();
    }
  }
}

async function loadMcpInfo(forceRender = false) {
  try {
    const res = await fetch('/api/mcp-info');
    if (!res.ok) {
      setCurrentMcpInfo(null);
      return;
    }
    const data = await res.json();
    setCurrentMcpInfo(data);
    if (forceRender && activeFeaturePanel === 'mcp') {
      renderFeaturePanel();
    }
  } catch (e) {
    console.error('Failed to load MCP info:', e);
    if (forceRender && activeFeaturePanel === 'mcp') {
      renderFeaturePanel();
    }
  }
}

async function loadAgentData(agentId) {
  if (isUiOnlyAgentId(agentId)) {
    currentRuntimeAgentId = null;
    currentRuntimeConnected = true;
    updateNotificationStatus(null);
    resetRuntimeBackedSurfaceState();
    renderCurrentMainView();
    renderFeaturePanel();
    return;
  }
  try {
    currentRuntimeAgentId = agentId;
    const [msgsRes, toolsRes, hooksRes, overviewRes, inputRes] = await Promise.all([
      fetch(`/api/agents/${agentId}/messages`),
      fetch(`/api/agents/${agentId}/tools`),
      fetch(`/api/agents/${agentId}/hooks`),
      fetch(`/api/agents/${agentId}/overview`),
      fetch(`/api/agents/${agentId}/input-requests`)
    ]);

    // Stale guard: if the user switched to a different agent during the
    // fetch, discard this response to prevent rendering stale data (flashback).
    if (normalizeAgentIdentity(currentRuntimeAgentId) !== normalizeAgentIdentity(agentId)) {
      return;
    }

    const msgsData = await msgsRes.json();
    const tools = await toolsRes.json();
    setCurrentHookInspector(await hooksRes.json());
    setCurrentOverviewSnapshot(await overviewRes.json());
    const inputRequests = await inputRes.json();

    currentMessages = msgsData.messages || [];
    window.lastInputRequests = inputRequests;
    renderInputRequests(inputRequests);
    updateRollbackActionVisibility();
    toolRenderConfigs = {};
    TOOL_NAMES = {};

    const DEFAULT_DISPLAY_NAMES = {
      // 系统工具
      run_shell_command: 'Bash',
      read_file: 'Read File',
      write_file: 'Write File',
      list_directory: 'List',
      web_fetch: 'Web',
      calculator: 'Calc',
      invoke_skill: 'Invoke Skill',
      spawn_agent: 'Spawn Agent',
      list_agents: 'List Agents',
      send_to_agent: 'Send to Agent',
      close_agent: 'Close Agent',
      // Opencode 工具
      read: 'Read',
      write: 'Write',
      edit: 'Edit',
      glob: 'Glob',
      grep: 'Grep',
      ls: 'LS',
    };

    for (const tool of tools) {
      toolRenderConfigs[tool.name] = tool;
      TOOL_NAMES[tool.name] = DEFAULT_DISPLAY_NAMES[tool.name] || tool.name;
    }

    renderCurrentMainView();
    await refreshCurrentRuntimeStatus(agentId);
    if (activeFeaturePanel === 'logs') {
      await loadLogs(true);
    }
    renderFeaturePanel();

    warmTemplatesInBackground(collectTemplateNames(tools), agentId);
  } catch (e) {
    console.error('Failed to load agent data:', e);
  }
}

async function refreshCurrentRuntimeStatus(runtimeId = currentRuntimeAgentId) {
  const expectedRuntimeId = normalizeAgentIdentity(runtimeId);
  if (!expectedRuntimeId) return null;

  try {
    const [notifRes, connectionRes] = await Promise.all([
      fetch(`/api/agents/${expectedRuntimeId}/notification`),
      fetch(`/api/agents/${expectedRuntimeId}/connection`),
    ]);

    if (normalizeAgentIdentity(currentRuntimeAgentId) !== expectedRuntimeId) {
      return null;
    }
    if (!notifRes.ok || !connectionRes.ok) {
      return null;
    }

    const [notifData, connectionData] = await Promise.all([
      notifRes.json(),
      connectionRes.json(),
    ]);

    if (normalizeAgentIdentity(currentRuntimeAgentId) !== expectedRuntimeId) {
      return null;
    }

    currentRuntimeConnected = connectionData?.connected !== false;
    const runtimeRecord = getRuntimeRecord(expectedRuntimeId);
    if (runtimeRecord) {
      runtimeRecord.connected = currentRuntimeConnected;
    }
    setConnectionStatus(currentRuntimeConnected);
    updateNotificationStatus(notifData);
    return { notifData, connectionData };
  } catch (error) {
    console.warn('Failed to refresh runtime status:', error);
    return null;
  }
}

// ── Auto session title generation ──────────────────────────────────────────
const _autoTitlePending = new Set();
const _autoTitleAttempts = new Map();
const _autoTitleRetryAt = new Map();

function getAutoTitleSessionInfo() {
  const agent = getCurrentAgentRecord();
  if (!agent) return null;
  const sessionId = String(agent.active_workspace_session_id || agent.workspace_sessions?.activeSessionId || '').trim();
  return sessionId ? { agent, sessionId } : null;
}

function markAutoTitleCandidate(previousMessages, nextMessages) {
  const info = getAutoTitleSessionInfo();
  if (!info) return;
  const previousAssistantCount = previousMessages.filter(function(message) {
    return message && message.role === 'assistant';
  }).length;
  const nextAssistantCount = nextMessages.filter(function(message) {
    return message && message.role === 'assistant';
  }).length;
  if (previousAssistantCount === 0 && nextAssistantCount > 0) {
    _autoTitlePending.add(info.sessionId);
  }
}

function tryAutoTitleGeneration(messages) {
  if (!currentRuntimeAgentId || !currentAgentId) return;

  const info = getAutoTitleSessionInfo();
  if (!info) return;
  const { agent, sessionId } = info;
  if (!_autoTitlePending.has(sessionId)) return;

  const latestMessage = messages[messages.length - 1];
  if (!latestMessage || latestMessage.role !== 'assistant' || !String(latestMessage.content || '').trim()) return;

  // Only auto-generate for default "新对话N" titles
  const currentTitle = String(agent.active_workspace_session_title || '').trim();
  if (!/^新对话\d+$/.test(currentTitle)) {
    _autoTitlePending.delete(sessionId);
    return;
  }

  if (_autoTitleTriggered.has(sessionId)) return;
  const attempts = _autoTitleAttempts.get(sessionId) || 0;
  if (attempts >= 3) {
    _autoTitlePending.delete(sessionId);
    _autoTitleRetryAt.delete(sessionId);
    return;
  }
  if (Date.now() < (_autoTitleRetryAt.get(sessionId) || 0)) return;

  _autoTitleTriggered.add(sessionId);
  _autoTitleAttempts.set(sessionId, attempts + 1);

  // Fire and forget — don't block the poll loop
  autoGenerateSessionTitle(agent.id, sessionId);
}

async function autoGenerateSessionTitle(agentId, sessionId) {
  let succeeded = false;
  try {
    var response = await fetch('/protoclaw/generate_session_title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: agentId, sessionId: sessionId }),
    });
    if (!response.ok) {
      console.warn('[AutoTitle] generation failed:', response.status);
      return;
    }
    var result = await response.json();
    if (result.ok && result.title) {
      // Update local data
      var agent = typeof getCurrentAgentRecord === 'function' ? getCurrentAgentRecord() : null;
      if (agent) {
        var sessions = agent.workspace_sessions && agent.workspace_sessions.sessions || [];
        var target = sessions.find(function(s) { return s.id === sessionId; });
        if (target) target.title = result.title;
      }
      console.log('[AutoTitle] title set:', result.title);
      succeeded = true;
    }
  } catch (error) {
    console.warn('[AutoTitle] error:', error.message || error);
  } finally {
    _autoTitleTriggered.delete(sessionId);
    if (succeeded) {
      _autoTitlePending.delete(sessionId);
      _autoTitleAttempts.delete(sessionId);
      _autoTitleRetryAt.delete(sessionId);
    } else {
      _autoTitleRetryAt.set(sessionId, Date.now() + 15000);
    }
  }
}

async function poll() {
  try {
    if (prebuiltSessionSwitchInFlight) {
      setTimeout(poll, 300);
      return;
    }

    // 定期检查并重新加载 Feature 模板映射（如果为空）
    if (Object.keys(FEATURE_TEMPLATE_MAP).length === 0 && Date.now() - lastFeatureTemplateReloadAt > 3000) {
      lastFeatureTemplateReloadAt = Date.now();
      await reloadFeatureTemplateMap();
    }

    if (!currentRuntimeAgentId) {
      currentRuntimeConnected = true;
      updateNotificationStatus(null);
      await loadAgents();
      await refreshAgentCallStates(allAgents);
      // Incrementally refresh workspace session data when viewing workspace surface.
      if (Date.now() - (window._lastWsSessionRefreshAt || 0) > 3000) {
        const wsHostAgent = allAgents.find((a) => a.id === currentAgentId && isWorkspaceHostUnit(a));
        if (wsHostAgent && loadedAgentDetailIds.has(wsHostAgent.id)) {
          window._lastWsSessionRefreshAt = Date.now();
          try {
            const freshRes = await fetch('/protoclaw/prebuilt_sessions?agentId=' + encodeURIComponent(wsHostAgent.id));
            if (freshRes.ok) {
              const freshSessions = await freshRes.json();
              const prevSig = JSON.stringify(wsHostAgent.workspace_sessions || {});
              const nextSig = JSON.stringify(freshSessions);
              if (prevSig !== nextSig) {
                wsHostAgent.workspace_sessions = freshSessions;
                lastRenderedWorkspaceHtml = '';
                if (typeof shouldRenderWorkspaceSurface === 'function' && shouldRenderWorkspaceSurface(wsHostAgent)) {
                  renderCurrentMainView();
                } else {
                  // Chat mode: only refresh context bar, avoid full re-render that resets scroll
                  if (typeof updateChatContextBar === 'function') {
                    updateChatContextBar();
                  }
                }
              }
            }
          } catch {}
        }
      }
      if (activeFeaturePanel === 'logs' && logPanelScope === 'all') {
        await loadLogs();
      }
      setTimeout(poll, 1000);
      return;
    }

    // 先单独刷新轻量运行态，再并行请求较重的数据，避免状态栏被慢接口拖住
    const pollRuntimeId = currentRuntimeAgentId;
    const statusTask = refreshCurrentRuntimeStatus(pollRuntimeId);

    const [msgsRes, inputRes, overviewRes] = await Promise.all([
      fetch(`/api/agents/${pollRuntimeId}/messages`),
      fetch(`/api/agents/${pollRuntimeId}/input-requests`),
      fetch(`/api/agents/${pollRuntimeId}/overview`),
    ]);

    // 如果在 fetch 期间已经切换了 agent，丢弃过时的响应，避免旧数据覆盖新会话
    if (normalizeAgentIdentity(currentRuntimeAgentId) !== normalizeAgentIdentity(pollRuntimeId)) {
      setTimeout(poll, 300);
      return;
    }

    const coreResponses = [msgsRes, inputRes, overviewRes];
    if (coreResponses.some(res => res.status === 404)) {
      if (prebuiltSessionSwitchInFlight || suppressSidebarRerender) {
        setTimeout(poll, 300);
        return;
      }
      const failedRuntimeId = currentRuntimeAgentId;
      const failedRuntimeRecord = getRuntimeRecord(failedRuntimeId);
      if (failedRuntimeId) {
        _agentCallActive.delete(failedRuntimeId);
      }
      if (failedRuntimeRecord) {
        failedRuntimeRecord.callActive = false;
        failedRuntimeRecord.connected = false;
      }
      currentRuntimeAgentId = null;
      const fallbackId = resolveWorkspaceFallbackAgentId(failedRuntimeRecord);
      if (fallbackId) {
        selectWorkspaceSurface(fallbackId, { skipFeaturePanel: true });
      } else {
        currentAgentId = null;
        currentWorkspaceTab = null;
        currentMessages = [];
        currentInputRequests = [];
        window.lastInputRequests = [];
        renderCurrentMainView();
        renderInputRequests([]);
      }
      await loadAgents();
      setTimeout(poll, 1000);
      return;
    }

    const data = await msgsRes.json();
    const messages = data.messages || [];

    // Render messages immediately — before non-critical async ops
    // (status refresh, call states, queue sync) that add visible latency.
    const previousMessages = currentMessages;
    markAutoTitleCandidate(previousMessages, messages);
    if (messages.length !== currentMessages.length) {
      if (messages.length > currentMessages.length) {
        // 有新消息：只追加新的
        const newMessages = messages.slice(currentMessages.length);
        currentMessages = messages;
        if (shouldRenderWorkspaceSurface()) {
          renderCurrentMainView();
        } else {
          appendNewMessages(newMessages, currentMessages.length - newMessages.length);
        }
      } else if (messages.length < currentMessages.length) {
        // 消息减少：完全重建（极少情况）
        currentMessages = messages;
        renderCurrentMainView();
      }
    } else {
      const lastMsgChanged = messages.length > 0 &&
        JSON.stringify(messages[messages.length - 1]) !== JSON.stringify(currentMessages[currentMessages.length - 1]);
      if (lastMsgChanged) {
        // 最后一条消息变化：替换最后一条（避免滚动重置）
        currentMessages = messages;
        if (shouldRenderWorkspaceSurface()) {
          renderCurrentMainView();
        } else {
          updateLastMessage(messages[messages.length - 1]);
        }
      }
    }

    await statusTask;
    await refreshAgentCallStates(allAgents);
    _syncPersistentActionButton();
    _syncPersistentInputUi(currentRuntimeAgentId);

    const nextOverview = normalizeOverviewSnapshot(await overviewRes.json());
    const nextOverviewSignature = getOverviewSignature(nextOverview);
    if (nextOverviewSignature !== currentOverviewSignature) {
      currentOverviewSnapshot = nextOverview;
      currentOverviewSignature = nextOverviewSignature;
      if (activeFeaturePanel === 'workspace') {
        renderFeaturePanel();
      }
      if (typeof updateChatContextBar === 'function') {
        updateChatContextBar();
      }
    }

    // 处理输入请求（只在变化时重新渲染）
    const inputRequestsRaw = await inputRes.json();
    const inputRequests = Array.isArray(inputRequestsRaw) ? inputRequestsRaw : [];
    if (JSON.stringify(inputRequests) !== JSON.stringify(window.lastInputRequests || [])) {
      window.lastInputRequests = inputRequests;
      renderInputRequests(inputRequests);
      updateRollbackActionVisibility();
    } else if (isChatSurfaceActive()) {
      _syncPersistentInputUi(currentRuntimeAgentId);
    }

    // Generate only after this session's first assistant response was newly observed and completed.
    if (currentRuntimeAgentId && !isRuntimeCalling(currentRuntimeAgentId)) {
      tryAutoTitleGeneration(currentMessages);
    }

    // Refresh the Claw-composed agent list occasionally.
    // Do not overwrite `allAgents` with the raw viewer session list,
    // otherwise prebuilt/managed grouping disappears.
    if (Date.now() - lastAgentListRefreshAt > 3000) {
       lastAgentListRefreshAt = Date.now();
       await loadAgents();
       if (typeof updateChatContextBar === 'function') {
         updateChatContextBar();
       }
    }

    // Incrementally refresh workspace session data for the active workspace host.
    // This keeps the UI in sync when sessions are created/deleted via CLI.
    if (Date.now() - (window._lastWsSessionRefreshAt || 0) > 3000) {
      const wsHostAgent = allAgents.find((a) => a.id === currentAgentId && isWorkspaceHostUnit(a));
      if (wsHostAgent && loadedAgentDetailIds.has(wsHostAgent.id)) {
        window._lastWsSessionRefreshAt = Date.now();
        try {
          const freshRes = await fetch('/protoclaw/prebuilt_sessions?agentId=' + encodeURIComponent(wsHostAgent.id));
          if (freshRes.ok) {
            const freshSessions = await freshRes.json();
            const prevSig = JSON.stringify(wsHostAgent.workspace_sessions || {});
            const nextSig = JSON.stringify(freshSessions);
            if (prevSig !== nextSig) {
              wsHostAgent.workspace_sessions = freshSessions;
              lastRenderedWorkspaceHtml = '';
              if (typeof shouldRenderWorkspaceSurface === 'function' && shouldRenderWorkspaceSurface(wsHostAgent)) {
                renderCurrentMainView();
              } else {
                // Chat mode: only refresh context bar, avoid full re-render that resets scroll
                if (typeof updateChatContextBar === 'function') {
                  updateChatContextBar();
                }
              }
            }
          }
        } catch {}
      }
    }

    if (activeFeaturePanel) {
      if (activeFeaturePanel === 'logs') {
        await loadLogs();
      } else {
        const hooksRes = await fetch(`/api/agents/${currentRuntimeAgentId}/hooks`);
        const nextHookInspector = normalizeHookInspector(await hooksRes.json());
        const nextSignature = getHookInspectorSignature(nextHookInspector);
        if (nextSignature !== currentHookInspectorSignature) {
          currentHookInspector = nextHookInspector;
          currentHookInspectorSignature = nextSignature;
          renderFeaturePanel();
        } else if (activeFeaturePanel === 'inspector') {
          renderFeaturePanel();
        }
      }
    }

    // Write-through: keep cache fresh so switching back is instant
    if (currentRuntimeAgentId) {
      saveCurrentRuntimeToCache(currentRuntimeAgentId);
    }

  } catch (e) {
    console.warn('Polling failed, keeping last known connection state:', e);
    setTimeout(poll, 1000);
    return;
  }
  setTimeout(poll, 300);
}

// 通知状态更新
function updateNotificationStatus(notifData) {
  const payload = (notifData && typeof notifData === 'object') ? notifData : {};
  const statusEl = document.getElementById('notification-status');
  const phaseEl = document.getElementById('notification-phase');
  const summaryEl = document.getElementById('notification-summary');
  const metricsEl = document.getElementById('notification-metrics');
  lastNotificationStatusPayload = payload;
  const runtime = getEffectiveRuntimeSnapshot(payload);

  let callingStateChanged = false;
  const actionSource = getNotificationActionSource(payload);
  // `callActive` is tracked independently from the transient `state` payload.
  // Some notification responses may only carry the call flag, so update it
  // before any early return based on `state`.
  if (payload.callActive !== undefined) {
    const runtimeId = currentRuntimeAgentId;
    if (runtimeId) {
      const prev = _agentCallActive.get(runtimeId);
      let nextCalling = resolveNotificationCallingState(payload);
      if (nextCalling) {
        _agentCallActive.set(runtimeId, true);
      } else {
        _agentCallActive.delete(runtimeId);
      }
      callingStateChanged = (prev === true) !== nextCalling;
      if (callingStateChanged) {
        renderAgentList();
      }
    }
  }

  const stateType = String(actionSource?.type || '').trim();
  const shouldShowStatus = !currentRuntimeConnected || shouldShowRuntimeStatus(runtime, stateType);
  if (currentRuntimeAgentId && payload.callActive === undefined) {
    if (stateType === 'call.start') {
      if (!isRuntimeCalling(currentRuntimeAgentId)) {
        _agentCallActive.set(currentRuntimeAgentId, true);
        callingStateChanged = true;
        renderAgentList();
      }
    } else if (stateType === 'call.finish') {
      if (isRuntimeCalling(currentRuntimeAgentId)) {
        _agentCallActive.delete(currentRuntimeAgentId);
        callingStateChanged = true;
        renderAgentList();
      }
    }
  }

  if (shouldShowStatus) {
    statusEl.style.display = 'flex';
    statusEl.className = `notification-status active ${getRuntimeStageClass(runtime)}${currentRuntimeConnected ? '' : ' is-disconnected'}`;
    phaseEl.textContent = getCompactRuntimeLabel(runtime, currentRuntimeConnected);
    summaryEl.textContent = '';
    _lastRenderedNotificationRuntime = { ...runtime };
    metricsEl.innerHTML = renderRuntimeTimer(runtime, currentRuntimeConnected);
    _syncPersistentActionButton();
    if (shouldStatusUseQueueSync(runtime)) {
      _syncQueueFromBackend();
    }
    if (!payload.state) {
      if (callingStateChanged && getInputSurfaceMode(currentInputRequests || []) !== lastRenderedInputMode) {
        lastRenderedInputSignature = '';
        renderInputRequests(currentInputRequests || []);
      }
      return;
    }
  } else if (!payload.state) {
    statusEl.style.display = 'none';
    statusEl.className = 'notification-status';
    phaseEl.textContent = '';
    summaryEl.textContent = '';
    metricsEl.innerHTML = '';
    _lastRenderedNotificationRuntime = null;
    _syncPersistentActionButton();
    return;
  }

  const { type, data } = actionSource || {};

  if (!type) {
    if (callingStateChanged && getInputSurfaceMode(currentInputRequests || []) !== lastRenderedInputMode) {
      lastRenderedInputSignature = '';
      renderInputRequests(currentInputRequests || []);
    }
    return;
  }

  if (type === 'call.start') {
    _syncPersistentActionButton();
    return;
  }

  if (type === 'call.finish') {
    if (currentRuntimeAgentId) {
      _agentCallActive.delete(currentRuntimeAgentId);
      renderAgentList();
    }
    _syncPersistentActionButton();
    _syncPersistentInputUi();
    if (!shouldShowRuntimeStatus(runtime, type)) {
      statusEl.style.display = 'none';
      statusEl.className = 'notification-status';
      phaseEl.textContent = '';
      summaryEl.textContent = '';
      metricsEl.innerHTML = '';
      _lastRenderedNotificationRuntime = null;
    }
    return;
  }

  if (!runtime.callActive && type === 'llm.char_count') {
    statusEl.style.display = 'flex';
    statusEl.className = 'notification-status active';

    const phaseNames = {
      'thinking': t('phase_thinking'),
      'content': t('phase_content'),
      'tool_calling': t('phase_tool_calling')
    };
    phaseEl.textContent = phaseNames[data.phase] || data.phase;
    summaryEl.textContent = '';
    _lastRenderedNotificationRuntime = { ...runtime };
    metricsEl.innerHTML = renderRuntimeTimer(runtime, currentRuntimeConnected);

    // 新语义下改为根据 runtime 调用状态同步按钮
    _syncPersistentActionButton();
    // 新 step 开始，agent 已在上一步结束时 dequeue 了消息，同步气泡
    _syncQueueFromBackend();
  } else if (!runtime.callActive && type === 'llm.complete') {
    statusEl.style.display = 'none';
    statusEl.className = 'notification-status';
    phaseEl.textContent = '';
    summaryEl.textContent = '';
    metricsEl.innerHTML = '';
    _lastRenderedNotificationRuntime = null;
    _syncPersistentActionButton();
    // 不在这里清空 _queuedTexts — 后端队列可能仍有消息待消费
    // 队列显示由 _syncQueueFromBackend() 在每轮 step_start 时统一管理
    _pendingQueuedCount = 0;
    _syncPersistentInputUi();
  } else if (!runtime.callActive) {
    statusEl.style.display = 'none';
    statusEl.className = 'notification-status';
    phaseEl.textContent = '';
    summaryEl.textContent = '';
    metricsEl.innerHTML = '';
    _lastRenderedNotificationRuntime = null;
  } else if (!shouldShowStatus) {
    // callActive 为 true 但 shouldShowStatus 为 false（如 llm.complete + 无 pending tools 的收尾窗口）
    statusEl.style.display = 'none';
    statusEl.className = 'notification-status';
    phaseEl.textContent = '';
    summaryEl.textContent = '';
    metricsEl.innerHTML = '';
    _lastRenderedNotificationRuntime = null;
    _syncPersistentActionButton();
  }

  if (callingStateChanged && getInputSurfaceMode(currentInputRequests || []) !== lastRenderedInputMode) {
    lastRenderedInputSignature = '';
    renderInputRequests(currentInputRequests || []);
  }
}

// 渲染输入请求
function getInputRenderSignature(requests, renderMode) {
  const runtimeId = currentRuntimeAgentId || 'none';
  if (renderMode === 'persistent') {
    const contextKey = getRuntimeContextKey(runtimeId) || `runtime:${runtimeId}`;
    return `persistent|${contextKey}|${readOnlyMode ? 'ro' : 'rw'}`;
  }
  if (renderMode === 'requests') {
    const contextKey = getRuntimeContextKey(runtimeId) || `runtime:${runtimeId}`;
    return `requests|${contextKey}|${JSON.stringify(requests || [])}`;
  }
  return `${renderMode}|${runtimeId}`;
}

function renderInputRequests(requests) {
  const inputContainer = document.getElementById('user-input-container');
  if (!inputContainer) return;
  const chatViewportTopBefore = container.scrollTop;
  currentInputRequests = requests;
  const chatActive = isChatSurfaceActive();
  const renderMode = getInputSurfaceMode(requests);
  const signature = getInputRenderSignature(requests, renderMode);
  const hasChoiceRequest = Array.isArray(requests) && requests.some(isChoiceInputRequest);

  if (signature === lastRenderedInputSignature && renderMode === lastRenderedInputMode) {
    return;
  }

  lastRenderedInputSignature = signature;
  lastRenderedInputMode = renderMode;

  // 取消活跃录音 / 重置转写状态，避免 DOM 销毁后状态残留
  // 注意：不重置 _voiceTranscribing 期间的 in-flight ASR 请求，
  // 那些请求完成后会自行存入 _pendingVoiceResults，待切回时注入。
  if (_voiceRecording) {
    _cancelVoiceRecording();
  }
  // 仅重置 flag 以解除新会话的 UI 限制，不中断进行中的 ASR fetch
  _voiceTranscribing = false;

  _storeVisibleSessionInputDraft(inputContainer);

  // 清空现有内容
  runWithSuppressedChatViewportObservers(() => {
    inputContainer.innerHTML = '';
    inputContainer.classList.toggle('choice-input-active', hasChoiceRequest);
    inputContainer.classList.remove('choice-collapsed');
    inputContainer.onclick = hasChoiceRequest
      ? function(event) {
          if (event.target === inputContainer) {
            collapsePrimaryChoiceRequest();
          }
        }
      : null;
  });

  if (!chatActive || renderMode === 'hidden') {
    inputContainer.classList.remove('choice-input-active', 'choice-collapsed');
    notifyChatViewportMutation({
      reason: 'input-render',
      shouldFollow: followLatestEnabled && chatActive,
      preserveTop: followLatestEnabled ? null : chatViewportTopBefore,
      forceSnap: followLatestEnabled,
      allowChase: false,
    });
    return;
  }

  if (renderMode === 'readonly') {
    inputContainer.classList.remove('choice-input-active', 'choice-collapsed');
    const card = document.createElement('div');
    card.className = 'user-input-card';
    card.innerHTML = `
      <textarea class="user-input-textarea" rows="1" disabled
        placeholder="${escapeHtml(t('workspace_readonly_mode'))}"
        style="opacity:0.5;cursor:not-allowed;"></textarea>
    `;
    runWithSuppressedChatViewportObservers(() => {
      inputContainer.appendChild(card);
    });
    notifyChatViewportMutation({
      reason: 'input-render',
      shouldFollow: followLatestEnabled && chatActive,
      preserveTop: followLatestEnabled ? null : chatViewportTopBefore,
      forceSnap: followLatestEnabled,
      allowChase: false,
    });
    return;
  }

  // 常驻输入框的显示条件一直是“当前正在查看某个 runtime 聊天面板”，
  // 而不是“runtime 此刻一定处于执行中”。
  const hasRequests = Array.isArray(requests) && requests.length > 0;
  const hasRuntimeSelected = !!currentRuntimeAgentId && chatActive;

  // 如果有 pending requests，正常渲染
  // 如果没有 pending requests 但当前有 runtime 聊天上下文，渲染常驻输入框（队列模式）
  if (renderMode === 'requests' && hasRequests) {
    for (const req of requests) {
      if (isChoiceInputRequest(req)) {
        renderChoiceInputRequest(inputContainer, req);
        continue;
      }

      const card = document.createElement('div');
      card.className = 'user-input-card';
      const visibleActions = Array.isArray(req.actions)
        ? req.actions.filter(action => action && action.id !== 'rollback_to_call')
        : [];
      const actionsHtml = visibleActions.length > 0
        ? '<div class="user-input-actions">' + visibleActions.map(action =>
            '<button class="user-input-action ' + escapeHtml(action.variant || 'secondary') + '" onclick="submitInputAction(\'' + req.requestId + '\', \'' + escapeHtml(action.id) + '\')">' + escapeHtml(action.label) + '</button>'
          ).join('') + '</div>'
        : '';
      card.innerHTML = `
        <div class="persistent-input-row">
          <textarea class="user-input-textarea" rows="1" id="input-${req.requestId}"
            onkeydown="handleInputKey(event, '${req.requestId}')"
            oninput="autoResize(this); _cacheSessionInput(this)"
            placeholder="${escapeHtml(req.placeholder || t('input_placeholder'))}"></textarea>
          <button class="voice-input-btn" data-target="input-${req.requestId}" onclick="toggleVoiceRecording(this)" title="${currentLanguage === 'zh' ? '语音输入' : 'Voice Input'}">
            <svg class="icon-mic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>
          </button>
          <button class="persistent-action-btn" onclick="submitInput('${req.requestId}')" title="Send">
            <svg class="icon-send" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
          </button>
        </div>
        ${actionsHtml ? `<div class="user-input-footer">${actionsHtml}</div>` : ''}
      `;
      runWithSuppressedChatViewportObservers(() => {
        inputContainer.appendChild(card);
      });

      const requestTextarea = document.getElementById(`input-${req.requestId}`);
      const requestCacheKey = _getSessionInputCacheKey();
      if (requestTextarea) {
        requestTextarea.dataset.sessionKey = requestCacheKey || '';
        _restoreSessionInputDraft(requestTextarea, requestCacheKey);
      }

      // Auto-focus
      setTimeout(() => {
        const el = document.getElementById(`input-${req.requestId}`);
        if(el) {
           const hasCachedDraft = !!(el.dataset.sessionKey && _sessionInputCache[el.dataset.sessionKey]);
           if (!hasCachedDraft && !el.value && typeof req.initialValue === 'string' && req.initialValue.length > 0) {
             el.value = req.initialValue;
             _cacheSessionInput(el);
           }
           el.focus();
           const end = el.value.length;
           if (typeof el.setSelectionRange === 'function') {
             el.setSelectionRange(end, end);
           }
           autoResize(el);
        }
      }, 50);
    }
  } else if (renderMode === 'persistent' && hasRuntimeSelected && !readOnlyMode) {
    // 常驻输入框：当前正在查看 runtime 聊天，但没有 pending input request
    renderPersistentInput(inputContainer);
  }

  // Inject any pending voice ASR result that arrived while viewing another session
  _injectPendingVoiceResult();

  notifyChatViewportMutation({
    reason: 'input-render',
    shouldFollow: followLatestEnabled && chatActive,
    preserveTop: followLatestEnabled ? null : chatViewportTopBefore,
    forceSnap: followLatestEnabled,
    allowChase: false,
  });
}

// 渲染常驻输入框（agent 运行期间始终可见）
let _pendingQueuedCount = 0;
let _queuedTexts = []; // 仅用于气泡展示
let _persistentUiSyncInFlight = false;
let _localQueuedInputPending = false;
let _lastQueueBubbleSignature = '';

function renderPersistentInput(container) {
  // 先渲染队列气泡
  _renderQueueBubbles(container);

  const card = document.createElement('div');
  card.className = 'user-input-card persistent-input';
  card.innerHTML = `
    <div class="persistent-input-row">
      <textarea class="user-input-textarea" rows="1" id="input-persistent"\n        onkeydown="handlePersistentInputKey(event)"\n        oninput="autoResize(this); _cacheSessionInput(this)"\n        placeholder="${escapeHtml(t('input_placeholder'))}"></textarea>
      <button class="voice-input-btn" data-target="input-persistent" onclick="toggleVoiceRecording(this)" title="${currentLanguage === 'zh' ? '语音输入' : 'Voice Input'}">
        <svg class="icon-mic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>
      </button>
      <button class="persistent-action-btn" id="persistent-action-btn" onclick="onPersistentBtnClick()">
        <svg class="icon-send" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
        <svg class="icon-stop" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="display:none"><rect x="4" y="4" width="16" height="16" rx="3"></rect></svg>
      </button>
    </div>
  `;
  container.appendChild(card);
  // 在 textarea 上标记所属会话，供销毁前 save 使用（不依赖全局 currentRuntimeAgentId 时序）
  const ta = document.getElementById('input-persistent');
  if (ta) {
    const cacheKey = _getSessionInputCacheKey();
    ta.dataset.sessionKey = cacheKey || '';
    _restoreSessionInputDraft(ta, cacheKey);
  }
  _syncPersistentInputUi();
}

function onPersistentBtnClick() {
  const btn = document.getElementById('persistent-action-btn');
  if (!btn) return;
  if (_voiceTranscribing) return;
  if (_voiceRecording) {
    _voicePendingSend = true;
    stopVoiceRecording();
    return;
  }
  if (btn.classList.contains('is-stop')) {
    interruptAgent();
  } else {
    submitQueuedInput();
  }
}

function _setActionBtnStop() {
  const btn = document.getElementById('persistent-action-btn');
  if (!btn) return;
  btn.classList.add('is-stop');
  const iconSend = btn.querySelector('.icon-send');
  const iconStop = btn.querySelector('.icon-stop');
  if (iconSend) iconSend.style.display = 'none';
  if (iconStop) iconStop.style.display = '';
}

function _setActionBtnSend() {
  const btn = document.getElementById('persistent-action-btn');
  if (!btn) return;
  btn.classList.remove('is-stop');
  const iconSend = btn.querySelector('.icon-send');
  const iconStop = btn.querySelector('.icon-stop');
  if (iconSend) iconSend.style.display = '';
  if (iconStop) iconStop.style.display = 'none';
}

function _syncPersistentActionButton() {
  if (currentRuntimeAgentId && isRuntimeCalling(currentRuntimeAgentId)) {
    _setActionBtnStop();
  } else {
    _setActionBtnSend();
  }
}

function _renderQueueBubbles(container) {
  const signature = JSON.stringify(_queuedTexts);
  const existingStack = container.querySelector('.queue-bubbles-stack');
  if (signature === _lastQueueBubbleSignature && (
    (_queuedTexts.length === 0 && !existingStack)
    || (_queuedTexts.length > 0 && existingStack)
  )) {
    return;
  }
  _lastQueueBubbleSignature = signature;

  container.querySelectorAll('.queue-bubbles-stack').forEach(el => el.remove());
  if (_queuedTexts.length === 0) return;

  const stack = document.createElement('div');
  stack.className = 'queue-bubbles-stack';
  for (const txt of _queuedTexts) {
    const b = document.createElement('div');
    b.className = 'queue-bubble';
    b.textContent = txt.length > 80 ? txt.substring(0, 80) + '...' : txt;
    b.title = txt;
    stack.appendChild(b);
  }

  const card = container.querySelector('.user-input-card');
  if (card) container.insertBefore(stack, card);
  else container.appendChild(stack);
}

// 查询后端真实队列余量，移除已被消费的气泡
async function _syncQueueFromBackend() {
  await _syncPersistentInputUi();
}

function handlePersistentInputKey(event) {
  if (event.key === 'Enter') {
    if (event.ctrlKey || event.shiftKey) {
      return;
    }
    if (_voiceTranscribing) return;
    if (_voiceRecording) {
      _voicePendingSend = true;
      stopVoiceRecording();
      return;
    }
    event.preventDefault();
    submitQueuedInput();
  }
}

async function submitQueuedInput() {
  const textarea = document.getElementById('input-persistent');
  if (!textarea) return;
  const text = textarea.value.trim();
  if (!text) return;
  const targetRuntimeId = currentRuntimeAgentId;
  const targetCacheKey = textarea.dataset.sessionKey || _getSessionInputCacheKey();

  try {
    const res = await fetch(`/api/agents/${targetRuntimeId}/queue-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (res.ok) {
      textarea.value = '';
      autoResize(textarea);
      if (targetCacheKey) delete _sessionInputCache[targetCacheKey];
      beginFollowLatestEntryWindow();
      requestFollowLatest({ forceEnable: true, behavior: 'auto' });
      // 只有当 agent 正在 calling 时才显示排队气泡。
      // agent 空闲时后端会立即消费输入，不需要排队指示。
      if (isRuntimeCalling(targetRuntimeId)) {
        _localQueuedInputPending = true;
        _pendingQueuedCount++;
        _queuedTexts.push(text);
        updateQueueIndicator();
      }
      const nextMode = getInputSurfaceMode(currentInputRequests || []);
      if (nextMode !== lastRenderedInputMode) {
        lastRenderedInputSignature = '';
        renderInputRequests(currentInputRequests || []);
      }
    }
  } catch (e) {
    console.error('排队输入提交失败:', e);
  }
}

function updateQueueIndicator() {
  const container = document.getElementById('user-input-container');
  if (container) _renderQueueBubbles(container);
}

async function _syncPersistentInputUi(runtimeId = currentRuntimeAgentId) {
  if (_persistentUiSyncInFlight) return;
  _persistentUiSyncInFlight = true;
  const prevMode = getInputSurfaceMode(currentInputRequests || []);
  const prevQueueSignature = JSON.stringify(_queuedTexts);
  try {
    if (!runtimeId) {
      _queuedTexts = [];
      _pendingQueuedCount = 0;
      updateQueueIndicator();
      _syncPersistentActionButton();
      return;
    }

    const expectedRuntimeId = runtimeId;
    _syncPersistentActionButton();

    const res = await fetch(`/api/agents/${expectedRuntimeId}/queued-inputs`);
    if (!res.ok || expectedRuntimeId !== currentRuntimeAgentId) return;
    const data = await res.json();
    const queue = Array.isArray(data) ? data : (Array.isArray(data.inputs) ? data.inputs : []);
    const viewerQueueTexts = queue
      .map((item) => typeof item?.text === 'string' ? item.text.trim() : '')
      .filter(Boolean);

    _queuedTexts = viewerQueueTexts.slice();
    _pendingQueuedCount = _queuedTexts.length;
    if (_queuedTexts.length === 0 && !isRuntimeCalling(expectedRuntimeId)) {
      _localQueuedInputPending = false;
    }
    if (JSON.stringify(_queuedTexts) !== prevQueueSignature) {
      updateQueueIndicator();
    }
  } catch (e) {
    // ignore transient queue sync failures
  } finally {
    _persistentUiSyncInFlight = false;
  }
  const nextMode = getInputSurfaceMode(currentInputRequests || []);
  if (nextMode !== prevMode) {
    lastRenderedInputSignature = '';
    renderInputRequests(currentInputRequests || []);
  }
}

async function interruptAgent() {
  if (!currentRuntimeAgentId) return;

  // 乐观 UI 更新：立即清空 calling 状态、切换按钮、清空队列，
  // 不等 POST 返回，让用户瞬间看到反馈。
  // 框架层已支持真正的无延迟中断（tool execution race + LLM stream abort），
  // 后端会在毫秒级完成 abort，因此前端不需要伪抑制窗口。
  _agentCallActive.delete(currentRuntimeAgentId);
  _localQueuedInputPending = false;
  _pendingQueuedCount = 0;
  _queuedTexts = [];
  _lastQueueBubbleSignature = '';
  updateQueueIndicator();
  _setActionBtnSend();
  // 立即隐藏状态栏
  const statusEl = document.getElementById('notification-status');
  if (statusEl) {
    statusEl.style.display = 'none';
    statusEl.className = 'notification-status';
    const phaseEl = document.getElementById('notification-phase');
    const summaryEl = document.getElementById('notification-summary');
    const metricsEl = document.getElementById('notification-metrics');
    if (phaseEl) phaseEl.textContent = '';
    if (summaryEl) summaryEl.textContent = '';
    if (metricsEl) metricsEl.innerHTML = '';
  }
  _lastRenderedNotificationRuntime = null;
  renderAgentList();

  console.log(`[Interrupt] sending POST /api/agents/${currentRuntimeAgentId}/interrupt`);
  try {
    const res = await fetch(`/api/agents/${currentRuntimeAgentId}/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    console.log(`[Interrupt] response:`, res.status, data);
    lastRenderedInputSignature = '';
    renderInputRequests(currentInputRequests || []);
  } catch (e) {
    console.error('[Interrupt] request failed:', e);
  }
}

function isChoiceInputRequest(req) {
  return !!req && req.mode === 'choices' && Array.isArray(req.questions) && req.questions.length > 0;
}

function getChoiceRequestById(requestId) {
  return (currentInputRequests || []).find(req => req.requestId === requestId) || null;
}

function getChoiceState(requestId) {
  if (!choiceInputState[requestId]) {
    choiceInputState[requestId] = {
      questionIndex: 0,
      answers: [],
      selectedIndex: 0,
      selectedIndexByQuestion: {},
      customTextByQuestion: {},
      collapsed: false,
    };
  }
  return choiceInputState[requestId];
}

function getChoiceOptionCount(question) {
  const optionCount = Array.isArray(question?.options) ? Math.min(question.options.length, 4) : 0;
  return optionCount + (question?.allowCustom ? 1 : 0);
}

function buildChoiceAnswer(req, state, questionIndex) {
  const question = req?.questions?.[questionIndex] || {};
  const options = Array.isArray(question.options) ? question.options.slice(0, 4) : [];
  const selectedIndex = state.selectedIndexByQuestion?.[question.id] ?? (questionIndex === state.questionIndex ? state.selectedIndex : 0);
  const isCustom = question.allowCustom && selectedIndex >= options.length;
  return isCustom
    ? {
        questionId: question.id,
        customText: (state.customTextByQuestion[question.id] || '').trim(),
      }
    : {
        questionId: question.id,
        optionId: options[selectedIndex]?.id,
      };
}

function rememberCurrentChoice(req, state) {
  const question = req?.questions?.[state.questionIndex] || {};
  if (!question.id) return;
  state.selectedIndexByQuestion[question.id] = state.selectedIndex || 0;
  state.answers[state.questionIndex] = buildChoiceAnswer(req, state, state.questionIndex);
}

function renderChoiceInputRequest(container, req) {
  const state = getChoiceState(req.requestId);
  const questions = Array.isArray(req.questions) ? req.questions : [];
  if (state.collapsed) {
    container.classList.add('choice-collapsed');
    const mini = document.createElement('button');
    mini.className = 'user-choice-mini';
    mini.type = 'button';
    mini.setAttribute('onclick', `expandChoiceRequest('${req.requestId}')`);
    mini.innerHTML = `
      <span class="user-choice-mini-title">${escapeHtml(req.prompt || '等待你的选择')}</span>
      <span class="user-choice-mini-meta">${Math.min((state.questionIndex || 0) + 1, questions.length)} / ${questions.length}</span>
    `;
    container.appendChild(mini);
    return;
  }

  container.classList.remove('choice-collapsed');
  const questionIndex = Math.max(0, Math.min(state.questionIndex || 0, questions.length - 1));
  state.questionIndex = questionIndex;
  const question = questions[questionIndex] || {};
  const options = Array.isArray(question.options) ? question.options.slice(0, 4) : [];
  const hasCustom = !!question.allowCustom;
  const optionCount = options.length + (hasCustom ? 1 : 0);
  state.selectedIndex = Math.max(0, Math.min(state.selectedIndexByQuestion?.[question.id] ?? state.selectedIndex ?? 0, Math.max(0, optionCount - 1)));

  const card = document.createElement('div');
  card.className = 'user-input-card user-choice-card';
  card.tabIndex = 0;
  card.dataset.requestId = req.requestId;
  card.setAttribute('onkeydown', `handleChoiceKey(event, '${req.requestId}')`);

  const optionHtml = options.map((option, index) => `
    <button class="user-choice-option ${index === state.selectedIndex ? 'active' : ''}" type="button" onclick="selectChoiceOption('${req.requestId}', ${index})">
      <span class="user-choice-key">${index + 1}</span>
      <span>
        <span class="user-choice-label">${escapeHtml(option.label || option.id || ('选项 ' + (index + 1)))}</span>
        ${option.description ? `<span class="user-choice-description">${escapeHtml(option.description)}</span>` : ''}
      </span>
    </button>
  `).join('');

  const customIndex = options.length;
  const customActive = hasCustom && state.selectedIndex === customIndex;
  const customText = state.customTextByQuestion[question.id] || '';
  const customHtml = hasCustom ? `
    <button class="user-choice-option ${customActive ? 'active' : ''}" type="button" onclick="selectChoiceOption('${req.requestId}', ${customIndex})">
      <span class="user-choice-key">${customIndex + 1}</span>
      <span>
        <span class="user-choice-label">${escapeHtml(question.customLabel || '其他，我想补充')}</span>
        <span class="user-choice-description">选择后可以直接输入想说的话</span>
      </span>
    </button>
    <div class="user-choice-custom ${customActive ? 'active' : ''}">
      <textarea id="choice-custom-${req.requestId}" rows="2"
        oninput="updateChoiceCustomText('${req.requestId}', this.value); autoResize(this)"
        onkeydown="handleChoiceCustomKey(event, '${req.requestId}')"
        placeholder="${escapeHtml(question.customPlaceholder || '输入你的补充内容')}">${escapeHtml(customText)}</textarea>
    </div>
  ` : '';

  card.innerHTML = `
    <div class="user-choice-topline">
      <div class="user-choice-title">${escapeHtml(req.prompt || '需要你做个选择')}</div>
      <div class="user-choice-progress">${questionIndex + 1} / ${questions.length}</div>
      <button class="user-choice-close" type="button" title="临时收起" onclick="collapseChoiceRequest('${req.requestId}')">×</button>
    </div>
    <div class="user-choice-question">${escapeHtml(question.question || '')}</div>
    <div class="user-choice-options">
      ${optionHtml}
      ${customHtml}
    </div>
    <div class="user-choice-footer">
      <span>↑↓ 选项，←→ 题目，Enter 确认</span>
      <button class="user-choice-submit" type="button" onclick="confirmChoiceQuestion('${req.requestId}')">${questionIndex + 1 === questions.length ? '提交' : '下一题'}</button>
    </div>
  `;

  container.appendChild(card);
  setTimeout(() => {
    const customInput = customActive ? document.getElementById(`choice-custom-${req.requestId}`) : null;
    const target = customInput || card;
    target.focus();
    if (customInput) {
      const end = customInput.value.length;
      customInput.setSelectionRange(end, end);
      autoResize(customInput);
    }
  }, 30);
}

function rerenderChoiceRequest(requestId) {
  lastRenderedInputSignature = '';
  const container = document.getElementById('user-input-container');
  if (!container) return;
  renderInputRequests(currentInputRequests || []);
}

window.selectChoiceOption = function(requestId, optionIndex) {
  const req = getChoiceRequestById(requestId);
  const state = getChoiceState(requestId);
  state.selectedIndex = optionIndex;
  const question = req?.questions?.[state.questionIndex];
  if (question?.id) {
    state.selectedIndexByQuestion[question.id] = optionIndex;
  }
  rerenderChoiceRequest(requestId);
};

window.collapseChoiceRequest = function(requestId) {
  const state = getChoiceState(requestId);
  const req = getChoiceRequestById(requestId);
  rememberCurrentChoice(req, state);
  state.collapsed = true;
  rerenderChoiceRequest(requestId);
};

window.expandChoiceRequest = function(requestId) {
  const state = getChoiceState(requestId);
  state.collapsed = false;
  rerenderChoiceRequest(requestId);
};

function collapsePrimaryChoiceRequest() {
  const request = (currentInputRequests || []).find(isChoiceInputRequest);
  if (request) {
    window.collapseChoiceRequest(request.requestId);
  }
}

window.updateChoiceCustomText = function(requestId, value) {
  const req = getChoiceRequestById(requestId);
  const state = getChoiceState(requestId);
  const question = req?.questions?.[state.questionIndex];
  if (question?.id) {
    state.customTextByQuestion[question.id] = value;
  }
};

window.handleChoiceKey = function(event, requestId) {
  const req = getChoiceRequestById(requestId);
  if (!req) return;
  const state = getChoiceState(requestId);
  const question = req.questions[state.questionIndex] || {};
  const optionCount = getChoiceOptionCount(question);
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    state.selectedIndex = Math.min(optionCount - 1, (state.selectedIndex || 0) + 1);
    if (question.id) state.selectedIndexByQuestion[question.id] = state.selectedIndex;
    rerenderChoiceRequest(requestId);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    state.selectedIndex = Math.max(0, (state.selectedIndex || 0) - 1);
    if (question.id) state.selectedIndexByQuestion[question.id] = state.selectedIndex;
    rerenderChoiceRequest(requestId);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    rememberCurrentChoice(req, state);
    state.questionIndex = Math.min(req.questions.length - 1, state.questionIndex + 1);
    state.selectedIndex = state.selectedIndexByQuestion[req.questions[state.questionIndex]?.id] ?? 0;
    rerenderChoiceRequest(requestId);
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    rememberCurrentChoice(req, state);
    state.questionIndex = Math.max(0, state.questionIndex - 1);
    state.selectedIndex = state.selectedIndexByQuestion[req.questions[state.questionIndex]?.id] ?? 0;
    rerenderChoiceRequest(requestId);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    confirmChoiceQuestion(requestId);
  }
};

window.handleChoiceCustomKey = function(event, requestId) {
  if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey) {
    event.preventDefault();
    confirmChoiceQuestion(requestId);
  }
};

window.confirmChoiceQuestion = async function(requestId) {
  const req = getChoiceRequestById(requestId);
  if (!req) return;
  const state = getChoiceState(requestId);
  const questions = req.questions || [];
  rememberCurrentChoice(req, state);

  if (state.questionIndex < questions.length - 1) {
    state.questionIndex += 1;
    state.selectedIndex = state.selectedIndexByQuestion[questions[state.questionIndex]?.id] ?? 0;
    rerenderChoiceRequest(requestId);
    return;
  }

  const finalAnswers = questions.map((_, index) => state.answers[index] || buildChoiceAnswer(req, state, index));
  const summary = finalAnswers.map((item, index) => {
    const q = questions[index] || {};
    if (item.customText) return `${q.question || item.questionId}: ${item.customText}`;
    const option = (q.options || []).find(candidate => candidate.id === item.optionId);
    return `${q.question || item.questionId}: ${option?.label || item.optionId || ''}`;
  }).join('\n');

  try {
    const res = await fetch(`/api/agents/${currentRuntimeAgentId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId,
        input: summary,
        response: {
          kind: 'choices',
          choices: finalAnswers,
          text: summary,
        },
      }),
    });
    if (res.ok) {
      delete choiceInputState[requestId];
      poll();
    }
  } catch (e) {
    console.error('提交选择失败:', e);
  }
};

function syncRollbackActionButtons() {
  const allowRollback = !!getRollbackInputRequest();
  const rows = container.querySelectorAll('.message-row');

  rows.forEach((row, index) => {
    const msg = currentMessages[index];
    const meta = row.querySelector('.message-meta');
    if (!meta) return;

    const existingButton = meta.querySelector('.message-action');
    const shouldShow = allowRollback && !!msg && msg.role === 'user';

    if (!shouldShow) {
      if (existingButton) {
        existingButton.remove();
      }
      return;
    }

    if (existingButton) {
      existingButton.setAttribute('onclick', 'requestRollbackEdit(' + index + ')');
      existingButton.style.display = '';
      return;
    }

    const button = document.createElement('button');
    button.className = 'message-action';
    button.type = 'button';
    button.textContent = '编辑此轮';
    button.setAttribute('onclick', 'requestRollbackEdit(' + index + ')');
    meta.appendChild(button);
  });
}

function updateRollbackActionVisibility() {
  syncRollbackActionButtons();
}

function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
}

function handleInputKey(event, requestId) {
  if (event.key === 'Enter') {
    if (event.ctrlKey || event.shiftKey) {
      // Ctrl+Enter or Shift+Enter for new line
      // default behavior is new line, but we might want to ensure it works
      return; 
    } else {
      // Enter for submit
      event.preventDefault();
      submitInput(requestId);
    }
  }
}

// 提交输入
async function submitInput(requestId) {
  if (_voiceTranscribing) return;
  if (_voiceRecording) {
    _voicePendingSend = true;
    stopVoiceRecording();
    return;
  }
  const textarea = document.getElementById(`input-${requestId}`);
  const input = textarea ? textarea.value : '';
  const targetCacheKey = textarea?.dataset?.sessionKey || _getSessionInputCacheKey();

  try {
    const res = await fetch(`/api/agents/${currentRuntimeAgentId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId,
        input,
        response: {
          kind: 'text',
          text: input,
        },
      })
    });
    if (res.ok) {
      if (textarea) {
        textarea.value = '';
        autoResize(textarea);
      }
      if (targetCacheKey) delete _sessionInputCache[targetCacheKey];
      beginFollowLatestEntryWindow();
      requestFollowLatest({ forceEnable: true, behavior: 'auto' });
      // 乐观清空输入请求并立即重渲染，避免等待下一轮 poll 才归位
      currentInputRequests = [];
      window.lastInputRequests = [];
      lastRenderedInputSignature = '';
      renderInputRequests([]);
      // 乐观标记 agent 进入 calling 状态，使 action button 立即切换为 stop
      if (currentRuntimeAgentId) {
        _agentCallActive.set(currentRuntimeAgentId, true);
        _syncPersistentActionButton();
      }
      // 后台刷新
      poll();
    }
  } catch (e) {
    console.error('提交输入失败:', e);
  }
}

function getPrimaryInputRequest() {
  return Array.isArray(currentInputRequests) && currentInputRequests.length > 0
    ? currentInputRequests[0]
    : null;
}

function requestSupportsAction(request, actionId) {
  return Array.isArray(request?.actions)
    && request.actions.some((action) => action && action.id === actionId);
}

function getRollbackInputRequest() {
  if (!Array.isArray(currentInputRequests)) {
    return null;
  }
  return currentInputRequests.find((request) => requestSupportsAction(request, 'rollback_to_call')) || null;
}

function canRollbackMessage(msg) {
  return !!getRollbackInputRequest() && !!msg && msg.role === 'user';
}

function saveChatProcessVisibility() {
  try {
    localStorage.setItem(CHAT_PROCESS_VISIBILITY_KEY, showChatProcess ? 'true' : 'false');
  } catch (error) {
    console.warn('Failed to persist chat process visibility:', error);
  }
}

function hasConversationProcessContent(messages = []) {
  return messages.some((msg) =>
    msg?.role === 'system'
    || msg?.role === 'tool'
    || (msg?.role === 'assistant' && !!msg.reasoning)
    || (Array.isArray(msg?.toolCalls) && msg.toolCalls.length > 0)
  );
}

function updateChatProcessToggle() {
  if (!chatProcessToggle) return;
  const hasProcess = hasConversationProcessContent(currentMessages) && !shouldRenderWorkspaceSurface();
  chatProcessToggle.classList.toggle('hidden', !hasProcess);
  if (!hasProcess) return;
  chatProcessToggle.classList.toggle('active', showChatProcess);
  chatProcessToggle.textContent = showChatProcess ? t('hide_process') : t('show_process');
}

function syncAssistantProcessOnlyRows(root = container) {
  root.querySelectorAll('.message-row.assistant').forEach((row) => {
    const content = row.querySelector('.message-content');
    if (!content) return;

    const visibleContent = Array.from(content.children).some((child) => {
      if (child.classList.contains('markdown-body')) {
        return String(child.textContent || '').trim().length > 0;
      }
      if (child.classList.contains('reasoning-block')) {
        return !child.classList.contains('process-hidden');
      }
      if (child.classList.contains('tool-call-container')) {
        return !child.classList.contains('process-hidden');
      }
      return child.offsetParent !== null;
    });

    row.classList.toggle('process-hidden-empty', !visibleContent);
  });
}

function applyConversationProcessState(root = container) {
  root.querySelectorAll('.message-row.system').forEach((row) => {
    row.classList.toggle('process-hidden', !showChatProcess);
  });

  root.querySelectorAll('.reasoning-block').forEach((block) => {
    block.classList.toggle('process-hidden', !showChatProcess);
  });

  root.querySelectorAll('.message-row.assistant .tool-call-container').forEach((block) => {
    block.classList.toggle('process-hidden', !showChatProcess);
  });

  root.querySelectorAll('.message-row.tool').forEach((row) => {
    row.classList.toggle('process-hidden', !showChatProcess);
  });

  syncAssistantProcessOnlyRows(root);
  syncCollapseStates(root);
  updateChatProcessToggle();
};

window.toggleChatProcessVisibility = function() {
  const chatViewportTopBefore = container.scrollTop;
  showChatProcess = !showChatProcess;
  saveChatProcessVisibility();
  applyConversationProcessState(container);
  notifyChatViewportMutation({
    reason: 'process-toggle',
    shouldFollow: followLatestEnabled && isChatSurfaceActive(),
    preserveTop: followLatestEnabled ? null : chatViewportTopBefore,
    forceSnap: true,
    allowChase: false,
  });
};

async function submitInputAction(requestId, actionId, payload = {}) {
  try {
    const res = await fetch(`/api/agents/${currentRuntimeAgentId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId,
        input: '',
        response: {
          kind: 'action',
          actionId,
          payload,
        },
      }),
    });
    if (res.ok) {
      beginFollowLatestEntryWindow();
      requestFollowLatest({ forceEnable: true, behavior: 'auto' });
      // 乐观清空输入请求并立即重渲染
      currentInputRequests = [];
      window.lastInputRequests = [];
      lastRenderedInputSignature = '';
      renderInputRequests([]);
      if (currentRuntimeAgentId) {
        _agentCallActive.set(currentRuntimeAgentId, true);
        _syncPersistentActionButton();
      }
      poll();
    }
  } catch (e) {
    console.error('提交动作失败:', e);
  }
}

window.requestRollbackEdit = async function(messageIndex) {
  const request = getRollbackInputRequest();
  if (!request) {
    console.warn('No rollback-capable input request available');
    return;
  }

  const msg = currentMessages[messageIndex];
  if (!msg || msg.role !== 'user') {
    return;
  }

  const fallbackCallIndex = currentMessages
    .slice(0, messageIndex + 1)
    .filter(entry => entry.role === 'user')
    .length - 1;
  const callIndex = typeof msg.turn === 'number' ? msg.turn : fallbackCallIndex;

  await submitInputAction(request.requestId, 'rollback_to_call', {
    callIndex,
    draftInput: msg.content,
  });
};

// 生成单条消息的 HTML
function renderMessage(msg, index) {
  const role = msg.role;
  const msgId = `msg-${index}`;
  let contentHtml = '';
  let metaHtml = `<div class="role-badge">${role}</div>`;
  if (canRollbackMessage(msg)) {
    metaHtml += `<button class="message-action" onclick="requestRollbackEdit(${index})">编辑此轮</button>`;
  }

  if (role === 'user' || role === 'system') {
    let style = '';
    let rowClass = role;
    if (role === 'system') {
       const isLong = msg.content.includes('\n') || msg.content.length > 60;
       if (isLong) {
         style = 'text-align: left !important;';
         rowClass += ' long-content';
       }
       contentHtml = `<div class="message-content markdown-body" id="${msgId}" style="${style}">${renderMarkdown(msg.content)}</div>`;
    } else {
      contentHtml = `<div class="message-content markdown-body" id="${msgId}">${renderMarkdown(msg.content)}</div>`;
    }

    if (role === 'system') {
       return `
        <div class="message-row ${rowClass}">
          <div class="message-meta">
            ${metaHtml}
          </div>
          ${contentHtml}
        </div>
      `;
    }
    return `
      <div class="message-row ${role}">
        <div class="message-meta">
          ${metaHtml}
        </div>
        ${contentHtml}
      </div>
    `;
  } else if (role === 'assistant') {
    let innerContent = '';

    if (msg.reasoning) {
      innerContent += `
        <div class="reasoning-block" id="reasoning-${msgId}">
            <div class="reasoning-header" onclick="toggleReasoning('reasoning-${msgId}')">
              <svg class="reasoning-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"></path></svg>
            <span>${escapeHtml(t('thinking_process'))}</span>
          </div>
          <div class="reasoning-content markdown-body">
            ${renderMarkdown(msg.reasoning)}
          </div>
        </div>
      `;
    }

    // 检测子代理完成消息，使用 tool-call-container 风格渲染（类似 glob）
    const agentCompletePattern = /^[\s\S]*\[子代理\s+(\S+)\s+执行完成\]:[\s\S]*$/;
    const agentCompleteMatch = msg.content.match(agentCompletePattern);
    if (agentCompleteMatch) {
      const agentName = agentCompleteMatch[1];
      // 查找子代理对应的 agentId（使用前端的 allAgents 数组）
      const subAgent = allAgents.find(a => a.name === agentName);
      const subAgentId = subAgent ? subAgent.id : null;
      const clickAttr = subAgentId ? `onclick="switchAgent('${subAgentId}')"` : '';
      const linkHtml = subAgentId
        ? `<div style="font-size:11px; color:var(--text-secondary); margin-left:4px; cursor:pointer;" ${clickAttr}>${escapeHtml(t('subagent_view_messages'))}</div>`
        : '';

      innerContent += `
          <div class="tool-call-container">
            <div class="tool-header">
              <span class="tool-header-name">${escapeHtml(t('subagent_done'))}</span>
            </div>
            <div class="tool-content">
              <div class="bash-command">【${escapeHtml(agentName)}】${escapeHtml(t('subagent_done'))}</div>
              ${linkHtml}
            </div>
          </div>
      `;
    } else if (msg.content && (msg.content.startsWith('[Error:') || msg.content.startsWith('[API Error:'))) {
      // 错误消息使用红色样式
      innerContent += `<div class="tool-error">${escapeHtml(msg.content)}</div>`;
    } else {
      innerContent += `<div class="markdown-body">${renderMarkdown(msg.content)}</div>`;
    }

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      const toolsHtml = msg.toolCalls.map(call => {
        const displayName = getToolDisplayName(call.name);
        const template = getToolRenderTemplate(call.name);
        let innerHtml;

        if (template.call) {
          innerHtml = applyTemplate(template.call, call.arguments);
        } else {
          innerHtml = renderJsonHighlight(call.arguments);
        }

        return `
          <div class="tool-call-container">
            <div class="tool-header">
              <span class="tool-header-name">${displayName}</span>
            </div>
            <div class="tool-content">${innerHtml}</div>
          </div>
        `;
      }).join('');
      innerContent += toolsHtml;
    }

    contentHtml = `<div class="message-content" id="${msgId}">${innerContent}</div>`;

  } else if (role === 'tool') {
    const toolCallId = msg.toolCallId;
    let toolName = null;
    let toolArgs = {};

    // 查找对应的工具调用（需要传入完整消息列表）
    return '';  // 这个需要在完整上下文中处理，暂时返回空
  }

  return `
    <div class="message-row ${role}">
      <div class="message-meta">
        ${metaHtml}
      </div>
      ${contentHtml}
    </div>
  `;
}

// 追加新消息（保持现有 DOM 状态）
function appendNewMessages(newMessages, startIndex) {
  const shouldFollowAfterMutation = followLatestEnabled && isChatSurfaceActive();
  // 移除空状态
  const emptyState = container.querySelector('.empty-state');
  runWithSuppressedChatViewportObservers(() => {
    if (emptyState) emptyState.remove();
  });

  // 获取当前消息数量
  const currentCount = container.querySelectorAll('.message-row').length;

  newMessages.forEach((msg, i) => {
    const index = startIndex + i;
    const msgId = `msg-${index}`;
    let html = '';

    if (msg.role === 'user' || msg.role === 'system' || msg.role === 'assistant') {
      html = renderMessage(msg, index);
    } else if (msg.role === 'tool') {
      // tool 需要特殊处理，查找对应的 toolCall
      let toolName = null;
      let toolArgs = {};
      const messages = currentMessages;
      const toolCallId = msg.toolCallId;

      for (const m of messages) {
        if (m.toolCalls) {
          const found = m.toolCalls.find(c => c.id === toolCallId);
          if (found) {
            toolName = found.name;
            toolArgs = found.arguments;
            break;
          }
        }
      }

      const { success, data } = parseToolResult(msg.content);
      const displayName = getToolDisplayName(toolName);
      const template = getToolRenderTemplate(toolName);

      let bodyHtml;
      if (template.result) {
         bodyHtml = applyTemplate(template.result, data, success, toolArgs);
      } else {
         bodyHtml = renderJsonHighlight(data);
      }

      html = `
        <div class="message-row ${msg.role}" data-tool-success="${success ? 'true' : 'false'}">
          <div class="message-meta">
            <div class="role-badge">${msg.role}</div>
          </div>
          <div class="message-content" id="${msgId}" style="padding:0; overflow:hidden;">
            <div class="tool-result-header">
              <span class="status-dot ${success ? 'success' : 'error'}"></span>
              <span>${displayName}</span>
            </div>
            <div class="tool-result-body">${bodyHtml}</div>
          </div>
        </div>
      `;
    }

    // 追加到容器
    runWithSuppressedChatViewportObservers(() => {
      container.insertAdjacentHTML('beforeend', html);
      const appendedRow = container.lastElementChild;
      if (appendedRow) {
        enhanceMathInElement(appendedRow);
      }
    });
  });

  // 对新消息应用折叠逻辑
  applyCollapseLogic(container, startIndex);
  updateRollbackActionVisibility();
  applyConversationProcessState(container);
  updateFollowLatestButton();
  notifyChatViewportMutation({
    reason: 'append',
    shouldFollow: shouldFollowAfterMutation,
    allowChase: false,
    preferSmooth: false,
    forceSnap: false,
  });
}

// 更新最后一条消息
function updateLastMessage(msg) {
  const shouldFollowAfterMutation = followLatestEnabled && isChatSurfaceActive();
  const lastIndex = currentMessages.length - 1;
  const lastRow = container.querySelectorAll('.message-row')[lastIndex];
  if (!lastRow) {
    renderCurrentMainView();
    return;
  }

  const msgId = `msg-${lastIndex}`;

  if (msg.role === 'tool') {
    // tool 消息更新：重建 tool-result-body
    const toolCallId = msg.toolCallId;
    let toolName = null;
    let toolArgs = {};

    for (const m of currentMessages) {
      if (m.toolCalls) {
        const found = m.toolCalls.find(c => c.id === toolCallId);
        if (found) {
          toolName = found.name;
          toolArgs = found.arguments;
          break;
        }
      }
    }

    const { success, data } = parseToolResult(msg.content);
    const displayName = getToolDisplayName(toolName);
    const template = getToolRenderTemplate(toolName);

    let bodyHtml;
    if (template.result) {
       bodyHtml = applyTemplate(template.result, data, success, toolArgs);
    } else {
       bodyHtml = renderJsonHighlight(data);
    }

    const toolResultBody = lastRow.querySelector('.tool-result-body');
    if (toolResultBody) {
      runWithSuppressedChatViewportObservers(() => {
        toolResultBody.innerHTML = bodyHtml;
      });
    }
    lastRow.dataset.toolSuccess = success ? 'true' : 'false';
    enhanceMathInElement(lastRow);
  } else if (msg.role === 'assistant') {
    // 流式更新：重建 assistant 消息的正文内容
    const contentEl = lastRow.querySelector('.markdown-body:not(.reasoning-content)');
    if (contentEl) {
      runWithSuppressedChatViewportObservers(() => {
        contentEl.innerHTML = renderMarkdown(msg.content || '');
      });
    }
    enhanceMathInElement(lastRow);
  } else {
    enhanceMathInElement(lastRow);
  }

  updateRollbackActionVisibility();
  applyConversationProcessState(container);
  updateFollowLatestButton();
  notifyChatViewportMutation({
    reason: 'patch-last',
    shouldFollow: shouldFollowAfterMutation,
    allowChase: false,
    preferSmooth: false,
    forceSnap: false,
  });
}

function getCollapseThresholdForRow(row) {
  if (row.classList.contains('assistant')) {
    return 220;
  }
  return 160;
}

function syncRowCollapseState(row) {
  const el = row.querySelector('.message-content');
  if (!el) return;

  const btnBar = row.querySelector('.expand-toggle-bar');
  if (row.classList.contains('process-hidden') || row.classList.contains('process-hidden-empty')) {
    el.classList.remove('collapsed');
    if (btnBar) btnBar.remove();
    return;
  }

  const collapseThreshold = getCollapseThresholdForRow(row);
  const isCollapsible = el.scrollHeight > collapseThreshold;
  const isSystem = row.classList.contains('system');
  const toolName = row.querySelector('.tool-result-header span:last-child')?.textContent || '';
  const isReadOrEdit = toolName === 'Read' || toolName === 'Edit';
  const shouldCollapse = isCollapsible && (isSystem || isReadOrEdit);

  if (!isCollapsible) {
    el.classList.remove('collapsed');
    if (btnBar) btnBar.remove();
    const toggle = row.querySelector('.collapse-toggle');
    if (toggle) toggle.style.display = 'none';
    return;
  }

  if (shouldCollapse) {
    el.classList.add('collapsed');
    const meta = row.querySelector('.message-meta .collapse-toggle svg');
    if (meta) meta.style.transform = 'rotate(-90deg)';
  } else {
    el.classList.remove('collapsed');
    const meta = row.querySelector('.message-meta .collapse-toggle svg');
    if (meta) meta.style.transform = 'rotate(0deg)';
  }

  let nextBtnBar = btnBar;
  if (!nextBtnBar) {
    nextBtnBar = document.createElement('div');
    nextBtnBar.className = 'expand-toggle-bar';
    row.appendChild(nextBtnBar);
  }

  const isCollapsed = el.classList.contains('collapsed');
  nextBtnBar.innerHTML = '<button class="expand-toggle-btn" onclick="toggleMessage(&quot;' + el.id + '&quot;)">' + getToggleButtonLabel(isCollapsed) + '</button>';
}

function syncCollapseStates(containerElement, startIndex = 0) {
  const rows = containerElement.querySelectorAll('.message-row');
  rows.forEach((row, idx) => {
    if (idx < startIndex) return;
    syncRowCollapseState(row);
  });
}

// 应用折叠逻辑（只处理指定索引后的消息）
function applyCollapseLogic(containerElement, startIndex = 0) {
  syncCollapseStates(containerElement, startIndex);
}

function render(messages) {
  if (messages.length === 0) {
    _lastRenderedChatSig = '';
    cancelChatScrollSettlement();
    container.innerHTML = getEmptyStateHtml();
    updateFollowLatestButton();
    return;
  }

  // Dedup: skip the expensive full HTML generation + DOM rebuild when the
  // message list and tool count haven't changed since the last render.
  // This avoids a redundant container.innerHTML replacement after
  // optimistic cache render → loadAgentData render with identical data.
  const _sig = messages.length + ':'
    + messages[messages.length - 1].role + ':'
    + (messages[messages.length - 1].content || '').length + ':'
    + Object.keys(toolRenderConfigs).length;
  if (_sig === _lastRenderedChatSig && container.querySelector('.message-row')) {
    return;
  }
  _lastRenderedChatSig = _sig;

  const shouldFollowAfterMutation = followLatestEnabled && isChatSurfaceActive();
  const html = messages.map((msg, index) => {
    const role = msg.role;
    const msgId = `msg-${index}`;
    let contentHtml = '';
    let rowAttrs = '';
    let metaHtml = `<div class="role-badge">${role}</div>`;
    if (canRollbackMessage(msg)) {
      metaHtml += `<button class="message-action" onclick="requestRollbackEdit(${index})">编辑此轮</button>`;
    }

    if (role === 'user' || role === 'system') {
      let style = '';
      let rowClass = role;
      if (role === 'system') {
         const isLong = msg.content.includes('\n') || msg.content.length > 60;
         if (isLong) {
           style = 'text-align: left !important;';
           rowClass += ' long-content';
         }
         contentHtml = `<div class="message-content markdown-body" id="${msgId}" style="${style}">${renderMarkdown(msg.content)}</div>`;
      } else {
        contentHtml = `<div class="message-content markdown-body" id="${msgId}">${renderMarkdown(msg.content)}</div>`;
      }
      
      if (role === 'system') {
         return `
          <div class="message-row ${rowClass}">
            <div class="message-meta">
              ${metaHtml}
            </div>
            ${contentHtml}
          </div>
        `;
      }
    } else if (role === 'assistant') {
      let innerContent = '';

      if (msg.reasoning) {
        innerContent += `
          <div class="reasoning-block" id="reasoning-${msgId}">
            <div class="reasoning-header" onclick="toggleReasoning('reasoning-${msgId}')">
              <svg class="reasoning-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"></path></svg>
              <span>${escapeHtml(t('thinking_process'))}</span>
            </div>
            <div class="reasoning-content markdown-body">
              ${renderMarkdown(msg.reasoning)}
            </div>
          </div>
        `;
      }

      // 检测子代理完成消息，使用 tool-call-container 风格渲染（类似 glob）
      const agentCompletePattern = /^[\s\S]*\[子代理\s+(\S+)\s+执行完成\]:[\s\S]*$/;
      const agentCompleteMatch = msg.content.match(agentCompletePattern);
      if (agentCompleteMatch) {
        const agentName = agentCompleteMatch[1];
        // 查找子代理对应的 agentId（使用前端的 allAgents 数组）
        const subAgent = allAgents.find(a => a.name === agentName);
        const subAgentId = subAgent ? subAgent.id : null;
        const clickAttr = subAgentId ? `onclick="switchAgent('${subAgentId}')"` : '';
        const linkHtml = subAgentId
          ? `<div style="font-size:11px; color:var(--text-secondary); margin-left:4px; cursor:pointer;" ${clickAttr}>${escapeHtml(t('subagent_view_messages'))}</div>`
          : '';

        innerContent += `
          <div class="tool-call-container">
            <div class="tool-header">
              <span class="tool-header-name">${escapeHtml(t('subagent'))}</span>
            </div>
            <div class="tool-content">
              <div class="bash-command">${escapeHtml(agentName)} ${escapeHtml(t('subagent_done'))}</div>
              ${linkHtml}
            </div>
          </div>
        `;
      } else {
        innerContent += `<div class="markdown-body">${renderMarkdown(msg.content)}</div>`;
      }

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const toolsHtml = msg.toolCalls.map(call => {
          const displayName = getToolDisplayName(call.name);
          const template = getToolRenderTemplate(call.name);
          let innerHtml;

          if (template.call) {
            innerHtml = applyTemplate(template.call, call.arguments);
          } else {
            innerHtml = renderJsonHighlight(call.arguments);
          }

          return `
            <div class="tool-call-container">
              <div class="tool-header">
                <span class="tool-header-name">${displayName}</span>
              </div>
              <div class="tool-content">${innerHtml}</div>
            </div>
          `;
        }).join('');
        innerContent += toolsHtml;
      }

      contentHtml = `<div class="message-content" id="${msgId}">${innerContent}</div>`;

    } else if (role === 'tool') {
      const toolCallId = msg.toolCallId;
      let toolName = null;
      let toolArgs = {};
      
      for (const m of messages) {
        if (m.toolCalls) {
          const found = m.toolCalls.find(c => c.id === toolCallId);
          if (found) { 
            toolName = found.name;
            toolArgs = found.arguments;
            break; 
          }
        }
      }

      const { success, data } = parseToolResult(msg.content);
      rowAttrs = ` data-tool-success="${success ? 'true' : 'false'}"`;
      const displayName = getToolDisplayName(toolName);
      const template = getToolRenderTemplate(toolName);
      
      let bodyHtml;
      if (template.result) {
         bodyHtml = applyTemplate(template.result, data, success, toolArgs);
      } else {
         bodyHtml = renderJsonHighlight(data);
      }

      rowAttrs = ` data-tool-success="${success ? 'true' : 'false'}"`;
      contentHtml = `
        <div class="message-content" id="${msgId}" style="padding:0; overflow:hidden;">
          <div class="tool-result-header">
            <span class="status-dot ${success ? 'success' : 'error'}"></span>
            <span>${displayName}</span>
          </div>
          <div class="tool-result-body">${bodyHtml}</div>
        </div>`;
    }

    return `
      <div class="message-row ${role}"${rowAttrs}>
        <div class="message-meta">
          ${metaHtml}
        </div>
        ${contentHtml}
      </div>
    `;
  }).join('');

  const savedScrollTop = container.scrollTop;
  runWithSuppressedChatViewportObservers(() => {
    container.innerHTML = html;
    enhanceMathInElement(container);
  }, 220);

  syncCollapseStates(container);

  updateRollbackActionVisibility();
  applyConversationProcessState(container);
  updateFollowLatestButton();
  notifyChatViewportMutation({
    reason: 'render-full',
    shouldFollow: shouldFollowAfterMutation,
    preserveTop: shouldFollowAfterMutation ? null : savedScrollTop,
    forceSnap: shouldFollowAfterMutation,
    allowChase: false,
  });
}

window.toggleMessage = function(id) {
  const el = document.getElementById(id);
  if (el) {
    const chatViewportTopBefore = container.scrollTop;
    el.classList.toggle('collapsed');
    const row = el.closest('.message-row');
    const isCollapsed = el.classList.contains('collapsed');

    // Update meta icon
    const meta = row.querySelector('.message-meta .collapse-toggle svg');
    if (meta) {
       meta.style.transform = isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)'; // meta uses transform
       // Fix: meta.transform in previous code was wrong, it's meta.style.transform
    }
    
    // Update bottom button
    const btn = row.querySelector('.expand-toggle-btn');
    if (btn) {
      btn.innerHTML = getToggleButtonLabel(isCollapsed);
    }

    notifyChatViewportMutation({
      reason: 'message-toggle',
      shouldFollow: followLatestEnabled && isChatSurfaceActive(),
      preserveTop: followLatestEnabled ? null : chatViewportTopBefore,
      forceSnap: false,
      allowChase: false,
      preferSmooth: false,
    });
  }
};

window.toggleReasoning = function(id) {
  const el = document.getElementById(id);
  if (el) {
    const chatViewportTopBefore = container.scrollTop;
    el.classList.toggle('expanded');
    notifyChatViewportMutation({
      reason: 'reasoning-toggle',
      shouldFollow: followLatestEnabled && isChatSurfaceActive(),
      preserveTop: followLatestEnabled ? null : chatViewportTopBefore,
      forceSnap: false,
      allowChase: false,
      preferSmooth: false,
    });
  }
};

// ── Voice Input / ASR ──────────────────────────────────────────────────────

let _voiceRecording = false;
let _voiceTranscribing = false;
let _voiceMediaRecorder = null;
let _voiceAudioChunks = [];
let _voiceTargetBtn = null;
let _voiceCancelled = false;
let _voicePendingSend = false;      // 录音期间点了发送：停止录音后，转写完成自动发送
let _voiceAgentId = null;           // 录音发起时的 runtime agent ID（用于 API 调用）
let _voiceCacheKey = null;          // 录音发起时的 session cache key（用于检测会话切换）
let _pendingVoiceResults = {};      // { agentId: text } — ASR 结果在会话切换后暂存，待切回时注入
let _sessionInputCache = {};        // { cacheKey: text } — 每个会话 persistent 输入框内容缓存

// Use the same immutable runtime-context identity as rendering and optimistic data.
function _getSessionInputCacheKey() {
  return getRuntimeContextKey();
}

// Sync send-button disabled state and voice-button spinner to current flags.
// During recording the send button stays clickable (clicking it stops the recording
// and auto-sends after transcription). Only during transcription is it disabled.
function _updateVoiceUI() {
  const btn = _voiceTargetBtn;
  if (!btn || !btn.isConnected) return;
  const row = btn.parentElement;
  if (!row) return;
  const sendBtn = row.querySelector('.persistent-action-btn');
  if (sendBtn) sendBtn.classList.toggle('voice-disabled', _voiceTranscribing);
  btn.classList.toggle('transcribing', _voiceTranscribing);
}

async function toggleVoiceRecording(btn) {
  if (_voiceRecording) {
    stopVoiceRecording();
  } else if (!_voiceTranscribing) {
    await startVoiceRecording(btn);
  }
}

async function startVoiceRecording(btn) {
  // Check speech config
  let speechConfig = window.ClawFW?._speechModelConfig;
  if (!speechConfig || !speechConfig.baseUrl || !speechConfig.apiKey) {
    try {
      const resp = await fetch('/protoclaw/speech_model_config');
      const data = await resp.json();
      speechConfig = data?.speechModel;
      if (window.ClawFW) window.ClawFW._speechModelConfig = speechConfig;
    } catch (e) { /* ignore */ }
  }
  if (!speechConfig || !speechConfig.baseUrl || !speechConfig.apiKey) {
    alert(currentLanguage === 'zh' ? '语音模型未配置，请在设置中配置 ASR 模型' : 'Speech model not configured. Please configure it in Settings.');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    _voiceTargetBtn = btn;
    _voiceAudioChunks = [];
    _voiceAgentId = currentRuntimeAgentId;
    _voiceCacheKey = _getSessionInputCacheKey();
    _voicePendingSend = false;

    // Determine best supported MIME type
    const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', ''];
    let selectedMime = '';
    for (const mt of mimeTypes) {
      if (!mt || MediaRecorder.isTypeSupported(mt)) {
        selectedMime = mt;
        break;
      }
    }

    const options = selectedMime ? { mimeType: selectedMime } : {};
    _voiceMediaRecorder = new MediaRecorder(stream, options);

    _voiceMediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        _voiceAudioChunks.push(e.data);
      }
    };

    _voiceMediaRecorder.onstop = async () => {
      // Stop all tracks
      stream.getTracks().forEach(t => t.stop());
      btn.classList.remove('recording');
      _voiceRecording = false;

      if (_voiceCancelled) {
        _voiceCancelled = false;
        _voiceAudioChunks = [];
        _updateVoiceUI();
        return;
      }

      if (_voiceAudioChunks.length === 0) {
        _updateVoiceUI();
        return;
      }

      const mimeType = _voiceMediaRecorder.mimeType || 'audio/webm';
      const blob = new Blob(_voiceAudioChunks, { type: mimeType });
      _voiceAudioChunks = [];

      _voiceTranscribing = true;
      _updateVoiceUI();
      try {
        await sendAudioToASR(blob, btn);
      } finally {
        _voiceTranscribing = false;
        _updateVoiceUI();
      }

      // Auto-send if user pressed send while recording
      if (_voicePendingSend) {
        _voicePendingSend = false;
        const targetId = btn.dataset.target;
        if (targetId === 'input-persistent') {
          const _currentCacheKey = _getSessionInputCacheKey();
          if (_currentCacheKey === _voiceCacheKey) {
            // Same session — text already in textarea, submit normally
            submitQueuedInput();
          } else {
            // Session switched — auto-submit directly to original agent
            let fullText = _pendingVoiceResults[_voiceCacheKey] || '';
            delete _pendingVoiceResults[_voiceCacheKey];
            // Also include any cached typed text from the original session
            const cachedInput = _sessionInputCache[_voiceCacheKey] || '';
            delete _sessionInputCache[_voiceCacheKey];
            fullText = cachedInput + fullText;
            if (fullText.trim()) {
              fetch(`/api/agents/${_voiceAgentId}/queue-input`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: fullText })
              }).catch(e => console.error('[VoiceInput] cross-session auto-send failed:', e));
            }
          }
        } else if (targetId.startsWith('input-')) {
          // Non-persistent request — only auto-send if still on same session
          if (_getSessionInputCacheKey() === _voiceCacheKey) {
            submitInput(targetId.slice('input-'.length));
          }
          // If session switched, leave result in _pendingVoiceResults for manual injection
        }
      }
    };

    _voiceMediaRecorder.start(1000); // collect chunks every 1s
    _voiceRecording = true;
    btn.classList.add('recording');
    _updateVoiceUI();
  } catch (err) {
    console.error('[VoiceInput] Failed to start recording:', err);
    alert(currentLanguage === 'zh' ? '无法访问麦克风：' + err.message : 'Cannot access microphone: ' + err.message);
  }
}

function stopVoiceRecording() {
  if (_voiceMediaRecorder && _voiceMediaRecorder.state === 'recording') {
    _voiceMediaRecorder.stop();
  }
}

function _cancelVoiceRecording() {
  _voiceCancelled = true;
  _voicePendingSend = false;
  stopVoiceRecording();
}

async function sendAudioToASR(blob, btn) {
  const targetId = btn.dataset.target;

  try {
    const resp = await fetch('/protoclaw/speech_to_text', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/webm' },
      body: blob,
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: 'Unknown error' }));
      console.error('[VoiceInput] ASR error:', err);
      alert(err.error || 'ASR request failed');
      return;
    }

    // Non-streaming JSON response
    const data = await resp.json();
    const text = data?.text || '';
    if (text) {
      const textarea = document.getElementById(targetId);
      // Only inject if we're still on the same session that started the recording.
      const _currentCacheKey = _getSessionInputCacheKey();
      if (textarea && _currentCacheKey === _voiceCacheKey) {
        insertTextAtCursor(textarea, text);
        autoResize(textarea);
        _cacheSessionInput(textarea);
      } else if (_voiceCacheKey) {
        // Session switched while transcribing — store for later injection
        _pendingVoiceResults[_voiceCacheKey] = (_pendingVoiceResults[_voiceCacheKey] || '') + text;
      }
    }

  } catch (err) {
    console.error('[VoiceInput] ASR request failed:', err);
    alert(currentLanguage === 'zh' ? '语音识别失败：' + err.message : 'ASR failed: ' + err.message);
  }
}

function insertTextAtCursor(textarea, text) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  textarea.value = value.slice(0, start) + text + value.slice(end);
  const newPos = start + text.length;
  textarea.setSelectionRange(newPos, newPos);
}

// Real-time cache shared by persistent and request text inputs per session.
function _cacheSessionInput(textarea) {
  const key = textarea?.dataset?.sessionKey || _getSessionInputCacheKey();
  if (!key) return;
  if (textarea.value) _sessionInputCache[key] = textarea.value;
  else delete _sessionInputCache[key];
}

function _restoreSessionInputDraft(textarea, key = textarea?.dataset?.sessionKey || _getSessionInputCacheKey()) {
  if (!textarea || !key) return false;
  const cached = _sessionInputCache[key];
  if (typeof cached !== 'string' || cached.length === 0) return false;
  textarea.value = cached;
  autoResize(textarea);
  return true;
}

function _storeSessionInputDraft(textarea) {
  if (!textarea) return;
  const key = textarea.dataset?.sessionKey || _getSessionInputCacheKey();
  if (!key) return;
  if (textarea.value) {
    _sessionInputCache[key] = textarea.value;
  } else {
    delete _sessionInputCache[key];
  }
}

function _storeVisibleSessionInputDraft(root = document) {
  const textareas = root.querySelectorAll
    ? Array.from(root.querySelectorAll('.user-input-textarea:not([disabled])'))
    : [];
  if (textareas.length === 0) return;
  const focused = textareas.find((textarea) => textarea === document.activeElement);
  const populated = textareas.find((textarea) => textarea.value);
  _storeSessionInputDraft(focused || populated || textareas[0]);
}

// Inject pending voice ASR result for the current session into whichever textarea is visible
function _injectPendingVoiceResult() {
  const key = _getSessionInputCacheKey();
  if (!key) return;
  const text = _pendingVoiceResults[key];
  if (!text) return;
  delete _pendingVoiceResults[key];
  const textarea = document.getElementById('input-persistent')
    || document.querySelector('.user-input-textarea[id^="input-"]');
  if (textarea) {
    insertTextAtCursor(textarea, text);
    autoResize(textarea);
    _cacheSessionInput(textarea);
    textarea.focus();
  }
}

applyTheme(currentTheme);
applyLanguage();

(async () => {
  await waitForViewerReady();
  const success = await loadFeatureTemplateMap();
  await loadAgents();
  if (!success) {
    console.log('[Viewer] Retrying to load feature templates after agent loaded...');
    await reloadFeatureTemplateMap();
  }
  await loadMcpInfo(false);
  poll();
})();
