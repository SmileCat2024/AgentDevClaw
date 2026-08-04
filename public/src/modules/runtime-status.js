/**
 * runtime-status.js — Phase B-1
 * 运行时状态 / 通知系统
 *
 * 包含：
 * - 运行时快照构建与状态推导（domain AA helpers）
 * - 通知状态更新主逻辑 updateNotificationStatus（domain Z）
 * - 通知计时器刷新
 *
 * 依赖（全局，由 app-core.js / app-main.js / 已有模块提供）：
 * - t, escapeHtml, currentLanguage (app-core.js)
 * - currentMessages, currentRuntimeAgentId, currentInputRequests,
 *   lastRenderedInputSignature, lastRenderedInputMode, _agentCallActive,
 *   isInterruptSuppressed, clearInterruptSuppression (app-core.js / app-main.js)
 * - normalizeAgentIdentity, toEpochMs, renderAgentList, renderInputRequests,
 *   getInputSurfaceMode (app-main.js)
 * - _tryNotifyAgentFinished (desktop-notify.js)
 * - _recapPendingTrigger, _maybeFetchRecap (recap-hint.js)
 * - _syncPersistentActionButton, _syncQueueFromBackend, _syncPersistentInputUi,
 *   _renderLastCallElapsed, _lastCallFinishTime, _pendingQueuedCount (persistent-input.js / app-main.js)
 */

// ─── 运行时状态变量 ───

let currentRuntimeConnected = true;
let lastNotificationStatusPayload = null;
const _runtimeStatusMemory = new Map();
let _lastRenderedNotificationRuntime = null;
let _notificationClockTimer = null;
let _contextGuardRuntimeId = '';
let _contextGuardState = null;
let _lastContextGuardToastKey = '';

function normalizeContextGuardState(raw) {
  if (!raw || typeof raw !== 'object' || raw.blocked !== true) return null;
  const thresholdTokens = Number(raw.thresholdTokens);
  const inputTokens = Number(raw.inputTokens);
  const blockedAt = Number(raw.blockedAt);
  return {
    blocked: true,
    thresholdTokens: Number.isFinite(thresholdTokens) && thresholdTokens > 0 ? Math.round(thresholdTokens) : null,
    inputTokens: Number.isFinite(inputTokens) && inputTokens > 0 ? Math.round(inputTokens) : null,
    blockedAt: Number.isFinite(blockedAt) && blockedAt > 0 ? Math.round(blockedAt) : null,
    reason: typeof raw.reason === 'string' ? raw.reason.trim() : '',
  };
}

function isCurrentContextGuardBlocked() {
  return _contextGuardState?.blocked === true
    && _contextGuardRuntimeId === normalizeAgentIdentity(currentRuntimeAgentId);
}

function getCurrentContextGuardMessage() {
  const state = _contextGuardState;
  if (!state?.blocked) return '';
  if (currentLanguage === 'zh') {
    if (state.inputTokens && state.thresholdTokens) {
      return `本轮上下文已达到限制（${state.inputTokens.toLocaleString()} / ${state.thresholdTokens.toLocaleString()} tokens），会话已被中断。`;
    }
    return '本轮上下文已达到限制，会话已被中断。';
  }
  if (state.inputTokens && state.thresholdTokens) {
    return `This session reached its context limit (${state.inputTokens.toLocaleString()} / ${state.thresholdTokens.toLocaleString()} tokens) and was interrupted.`;
  }
  return 'This session reached its context limit and was interrupted.';
}

function applyContextGuardStatus(payload, runtimeId = currentRuntimeAgentId) {
  const normalizedRuntimeId = normalizeAgentIdentity(runtimeId);
  if (!normalizedRuntimeId || normalizedRuntimeId !== normalizeAgentIdentity(currentRuntimeAgentId)) return;
  const nextState = normalizeContextGuardState(payload?.contextGuard);
  const wasBlocked = isCurrentContextGuardBlocked();
  _contextGuardRuntimeId = normalizedRuntimeId;
  _contextGuardState = nextState;
  const isBlocked = isCurrentContextGuardBlocked();

  if (isBlocked) {
    // [临时屏蔽] 上下文保护 Toast 通知 — 需要恢复时移除此注释块
    /*
    const toastKey = `${normalizedRuntimeId}:${nextState.blockedAt || nextState.thresholdTokens || 'blocked'}`;
    if (_lastContextGuardToastKey !== toastKey) {
      _lastContextGuardToastKey = toastKey;
      window.ClawToast?.show?.({
        id: `context-guard-${normalizedRuntimeId}`,
        status: 'error',
        title: currentLanguage === 'zh' ? '上下文限制已达到，已中断会话' : 'Context limit reached — session interrupted',
        description: getCurrentContextGuardMessage(),
      });
    }
    */
  }

  if (wasBlocked !== isBlocked && typeof renderInputRequests === 'function') {
    lastRenderedInputSignature = '';
    renderInputRequests(currentInputRequests || []);
  }
}

// ─── 运行时快照构建 ───

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
    createdAt: prebuiltAgent.created_at || null,
  };
}

function buildChildRuntimeEntry(runtimeAgent) {
  const runtimeId = runtimeAgent.runtime_session_id || runtimeAgent.runtimeSessionId || runtimeAgent.id || '';
  const ownerId = String(runtimeAgent.parent_id || '').trim();
  if (!runtimeId || !ownerId) return null;
  const mutation = typeof getSessionReplacementMutation === 'function'
    ? getSessionReplacementMutation(ownerId, runtimeAgent.active_workspace_session_id || '')
    : null;
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
    createdAt: runtimeAgent.created_at || null,
    replacementMutation: mutation,
  };
}

function getSidebarOperationPendingName(operation) {
  if (operation?.kind === 'branch') {
    return currentLanguage === 'zh' ? '正在创建分支…' : 'Creating branch…';
  }
  if (operation?.kind === 'trim') {
    return currentLanguage === 'zh' ? '正在生成精简会话…' : 'Creating trimmed session…';
  }
  if (operation?.kind === 'summary') {
    return currentLanguage === 'zh' ? '正在生成摘要会话…' : 'Creating summarized session…';
  }
  return currentLanguage === 'zh' ? '正在启动新会话…' : 'Starting new session…';
}

function getSidebarOperationFailureName(operation) {
  if (operation?.kind === 'branch') {
    return currentLanguage === 'zh' ? '分支会话创建未完成' : 'Branch creation incomplete';
  }
  if (operation?.kind === 'trim') {
    return currentLanguage === 'zh' ? '精简会话创建未完成' : 'Trimmed session creation incomplete';
  }
  if (operation?.kind === 'summary') {
    return currentLanguage === 'zh' ? '摘要会话创建未完成' : 'Summarized session creation incomplete';
  }
  return currentLanguage === 'zh' ? '新会话启动未完成' : 'New session start incomplete';
}

function collectRuntimeEntriesForPrebuilt(prebuiltAgent, agents) {
  const entries = [];
  const seenRuntimeIds = new Set();

  // Build sessionId → openDirectory map for project grouping (programming-helper).
  // Each runtime entry carries a sessionId; we resolve it to the session's
  // openDirectory so the sidebar can group runtimes by project.
  // We also cross-reference phProjects to pick up the correct-cased directory
  // path (sessions may store a lowercased path on Windows).
  const sessionDirMap = new Map();
  if (String(prebuiltAgent?.id || '').trim() === 'programming-helper') {
    const phProjects = Array.isArray(prebuiltAgent?.workspace_state?.phProjects)
      ? prebuiltAgent.workspace_state.phProjects
      : [];
    const projectIdToDir = new Map();
    for (const project of phProjects) {
      const pid = String(project?.id || '').trim();
      const pdir = String(project?.openDirectory || '').trim();
      if (pid && pdir) projectIdToDir.set(pid, pdir);
    }
    const sessions = Array.isArray(prebuiltAgent?.workspace_sessions?.sessions)
      ? prebuiltAgent.workspace_sessions.sessions
      : [];
    for (const session of sessions) {
      const sid = String(session?.id || '').trim();
      const rawDir = String(session?.openDirectory || '').trim();
      if (!sid || !rawDir) continue;
      const projectId = 'dir:' + rawDir.replace(/\\/g, '/').toLowerCase();
      sessionDirMap.set(sid, projectIdToDir.get(projectId) || rawDir);
    }
  }

  const isWorkGroup = String(prebuiltAgent?.id || '').trim() === 'work-group';

  // Work-group: build sessionId → {chatId, chatName} map from workspace_state.gcChats.
  // Each group chat stores its admin's sessionId; we reverse-map so that when
  // we encounter a child runtime with that sessionId, we can group it under
  // the correct group chat.
  const wgSessionToChat = new Map();
  if (isWorkGroup) {
    const gcChats = Array.isArray(prebuiltAgent?.workspace_state?.gcChats)
      ? prebuiltAgent.workspace_state.gcChats
      : [];
    for (const chat of gcChats) {
      const sid = String(chat?.adminSessionId || '').trim();
      if (sid) {
        wgSessionToChat.set(sid, { chatId: chat.id, chatName: chat.name || chat.id });
      }
    }
  }

  const addEntry = (entry) => {
    if (!entry) return;
    if (!entry?.runtimeId) return;
    if (seenRuntimeIds.has(entry.runtimeId)) return;
    seenRuntimeIds.add(entry.runtimeId);
    if (sessionDirMap.size > 0) {
      const dir = entry.sessionId ? (sessionDirMap.get(entry.sessionId) || '') : '';
      entry.projectDir = dir;
      entry.projectName = dir ? getPathLeaf(dir) : '';
    }
    if (typeof findSidebarOperation === 'function') {
      const operation = findSidebarOperation((item) => (
        item.agentId === String(prebuiltAgent?.id || '').trim()
        && !['settled', 'failed'].includes(item.phase)
        && ((item.targetRuntimeId && item.targetRuntimeId === entry.runtimeId)
          || (item.targetSessionId && item.targetSessionId === entry.sessionId)
          || (['replacement', 'delete', 'archive-close'].includes(item.type)
            && ((item.sourceRuntimeId && item.sourceRuntimeId === entry.runtimeId)
              || (item.sourceSessionId && item.sourceSessionId === entry.sessionId))))
      ));
      if (operation) {
        entry.sidebarOperation = operation;
        if (!entry.projectDir && operation.projectDir) {
          entry.projectDir = operation.projectDir;
          entry.projectName = operation.projectName || getPathLeaf(operation.projectDir);
        }
      }
    }
    // Work-group: group by group chat via sessionId → chat mapping.
    if (isWorkGroup && !entry.projectName && entry.sessionId) {
      const chat = wgSessionToChat.get(entry.sessionId);
      if (chat) {
        entry.projectName = chat.chatName;
        entry.projectDir = chat.chatId;
      }
    }
    entries.push(entry);
  };

  // Add child entries first — they carry accurate createdAt from the viewer.
  // The synthetic entry is added last so that when it shares a runtimeId with
  // a child entry (which happens when pickPrimaryAgentRuntime selects the same
  // runtime as the prebuilt's primary), the child entry wins and its createdAt
  // is preserved instead of being shadowed by the synthetic's null createdAt.
  agents
    .filter((agent) => agent.source !== 'prebuilt' && String(agent.parent_id || '').trim() === String(prebuiltAgent.id || '').trim())
    .forEach((agent) => addEntry(buildChildRuntimeEntry(agent)));

  addEntry(buildSyntheticRuntimeEntry(prebuiltAgent));

  const operations = typeof listSidebarOperations === 'function'
    ? listSidebarOperations((operation) => operation.agentId === prebuiltAgent.id)
    : [];
  for (const operation of operations) {
    if (['settled', 'failed'].includes(operation.phase)) continue;
    const sourceEntry = entries.find((entry) => (
      (operation.sourceRuntimeId && entry.runtimeId === operation.sourceRuntimeId)
      || (operation.sourceSessionId && entry.sessionId === operation.sourceSessionId)
    ));
    if (sourceEntry && operation.type === 'replacement' && ['source-stopping', 'degraded'].includes(operation.phase)) {
      sourceEntry.replacementMutation = operation;
      sourceEntry.sidebarOperation = operation;
    }

    if (operation.type === 'delete' || operation.type === 'archive-close') {
      if (sourceEntry) {
        sourceEntry.deleting = operation.type === 'delete';
        sourceEntry.sidebarOperation = operation;
        sourceEntry.contextMenuEnabled = false;
        if (!sourceEntry.projectDir && operation.projectDir) {
          sourceEntry.projectDir = operation.projectDir;
          sourceEntry.projectName = operation.projectName || getPathLeaf(operation.projectDir);
        }
      } else if (operation.sourceRuntimeId && !['degraded'].includes(operation.phase)) {
        addEntry({
          id: `operation:${operation.operationId}`,
          ownerId: prebuiltAgent.id,
          runtimeId: operation.sourceRuntimeId,
          sessionId: operation.sourceSessionId,
          name: operation.title || operation.sourceSessionId,
          status: 'pending',
          source: 'operation-tombstone',
          contextMenuEnabled: false,
          deleting: operation.type === 'delete',
          sidebarOperation: operation,
          projectDir: operation.projectDir,
          projectName: operation.projectName,
          createdAt: new Date(operation.startedAt).toISOString(),
        });
      }
      continue;
    }

    if (operation.phase === 'degraded' && (!sourceEntry || operation.type !== 'replacement')) {
      addEntry({
        id: `operation:${operation.operationId}`,
        ownerId: prebuiltAgent.id,
        runtimeId: `operation:${operation.operationId}`,
        sessionId: operation.targetSessionId || operation.sourceSessionId,
        name: getSidebarOperationFailureName(operation),
        status: 'disconnected',
        source: 'operation-degraded',
        contextMenuEnabled: false,
        pendingOperation: true,
        sidebarOperation: operation,
        projectDir: operation.projectDir,
        projectName: operation.projectName,
        createdAt: new Date(operation.startedAt).toISOString(),
      });
      continue;
    }

    const pendingPhase = ['requested', 'committing', 'generating', 'target-starting'].includes(operation.phase);
    if (!pendingPhase) continue;
    const isReplacement = operation.type === 'replacement';
    const pendingName = getSidebarOperationPendingName(operation);
    addEntry({
      id: `operation:${operation.operationId}`,
      ownerId: prebuiltAgent.id,
      runtimeId: `operation:${operation.operationId}`,
      sessionId: operation.targetSessionId || operation.sourceSessionId,
      name: pendingName,
      status: 'pending',
      source: 'operation-pending',
      contextMenuEnabled: false,
      pendingReplacement: isReplacement,
      pendingOperation: true,
      sidebarOperation: operation,
      projectDir: operation.projectDir,
      projectName: operation.projectName,
      createdAt: new Date(operation.startedAt).toISOString(),
    });
  }

  entries.sort((a, b) => toEpochMs(b.createdAt) - toEpochMs(a.createdAt));

  return entries;
}

function isRuntimeCalling(runtimeId) {
  return normalizeAgentIdentity(runtimeId) !== '' && _agentCallActive.get(runtimeId) === true;
}

function isSidebarRuntimeDisconnected(entry) {
  // A degraded sidebar operation can describe cleanup of a different runtime
  // (for example, the archived source of a ready replacement). Transport state
  // must come from the entry itself, not from the attached operation.
  return entry?.status === 'disconnected';
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
    streamToolNames: Array.isArray(runtime?.streamToolNames) ? runtime.streamToolNames.map((item) => String(item || '')).filter(Boolean) : [],
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
    const toolSummary = summarizeRuntimeToolNames(runtime.streamToolNames || []);
    if (toolSummary) {
      return `${currentLanguage === 'zh' ? '准备工具' : 'Preparing Tools'} · ${toolSummary}`;
    }
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

function getEffectiveRuntimeSnapshot(notifData, options = {}) {
  const suppressCalling = options?.suppressCalling === true;
  const runtime = normalizeNotificationRuntimeSnapshot(notifData?.runtime);
  const nextCalling = suppressCalling ? false : resolveNotificationCallingState(notifData);
  const runtimeId = normalizeAgentIdentity(currentRuntimeAgentId) || 'none';
  const actionSource = getNotificationActionSource(notifData);
  const stateType = String(actionSource?.type || '').trim();
  const stateData = actionSource?.data && typeof actionSource.data === 'object'
    ? actionSource.data
    : null;
  const remembered = _runtimeStatusMemory.get(runtimeId) || null;

  if (suppressCalling) {
    runtime.callActive = false;
  }

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
    if (Array.isArray(stateData.streamToolNames)) {
      runtime.streamToolNames = stateData.streamToolNames.map((n) => String(n || '')).filter(Boolean);
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
    const toolSummary = summarizeRuntimeToolNames(runtime.streamToolNames || []);
    return toolSummary
      ? `${t('runtime_status_building_tools')} · ${toolSummary}`
      : t('runtime_status_building_tools');
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
    // 同步对话区域临时状态块（处理 early-return 路径和耗时刷新）
    if (typeof ensureChatRuntimeIndicator === 'function') ensureChatRuntimeIndicator();
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

// ─── 通知状态更新主逻辑 ───

// 通知状态更新
function updateNotificationStatus(notifData) {
  const payload = (notifData && typeof notifData === 'object') ? notifData : {};
  if (!notifData) _lastCallFinishTime = 0;
  const statusEl = document.getElementById('notification-status');
  const phaseEl = document.getElementById('notification-phase');
  const summaryEl = document.getElementById('notification-summary');
  const metricsEl = document.getElementById('notification-metrics');
  lastNotificationStatusPayload = payload;
  const runtimeIdForSuppression = normalizeAgentIdentity(currentRuntimeAgentId);
  const actionSource = getNotificationActionSource(payload);
  // call.finish is authoritative even if a coalesced runtime snapshot still
  // carries the previous callActive:true value.
  if (runtimeIdForSuppression && String(actionSource?.type || '').trim() === 'call.finish') {
    clearInterruptSuppression(runtimeIdForSuppression);
  }
  const payloadCalling = resolveNotificationCallingState(payload);
  const observedCallStartedAt = getNotificationCallStartedAt(payload);
  const suppressingInterrupt = runtimeIdForSuppression
    && payloadCalling
    && isInterruptSuppressed(runtimeIdForSuppression, observedCallStartedAt);
  const runtime = getEffectiveRuntimeSnapshot(payload, { suppressCalling: suppressingInterrupt });

  let callingStateChanged = false;
  // `callActive` is tracked independently from the transient `state` payload.
  // Some notification responses may only carry the call flag, so update it
  // before any early return based on `state`.
  if (payload.callActive !== undefined) {
    const runtimeId = currentRuntimeAgentId;
    if (runtimeId) {
      const prev = _agentCallActive.get(runtimeId);
      let nextCalling = resolveNotificationCallingState(payload);
      if (nextCalling) {
        // interrupting 期间同一 call 的 true 只是排空状态；只有更新的
        // callStartedAt 才代表真正的新 call，可以离开 interrupting。
        if (!isInterruptSuppressed(runtimeId, observedCallStartedAt)) {
          _markAgentCallStartedForNotify(runtimeId);
          _agentCallActive.set(runtimeId, true);
        } else {
          nextCalling = false;
        }
      } else {
        _agentCallActive.delete(runtimeId);
        clearInterruptSuppression(runtimeId);
        if (prev === true) _tryNotifyAgentFinished(runtimeId, payload);
      }
      callingStateChanged = (prev === true) !== nextCalling;
      if (callingStateChanged) {
        renderAgentList();
      }
    }
  }

  // Capture last call finish time for elapsed display
  if (payload.state && typeof payload.state === 'object' && payload.state.type === 'call.finish') {
    _lastCallFinishTime = typeof payload.state.timestamp === 'number'
      ? payload.state.timestamp
      : (runtime.updatedAt || Date.now());
    _renderLastCallElapsed();
    // Trigger deferred recap if user was away while AI was generating
    if (_recapPendingTrigger) {
      _recapPendingTrigger = false;
      _maybeFetchRecap();
    }
  }

  if (suppressingInterrupt) {
    statusEl.style.display = 'flex';
    statusEl.className = 'notification-status active is-interrupting';
    phaseEl.textContent = currentLanguage === 'zh' ? '正在停止…' : 'Stopping…';
    summaryEl.textContent = currentLanguage === 'zh'
      ? '等待当前步骤安全退出'
      : 'Waiting for the current step to exit safely';
    metricsEl.innerHTML = '';
    _lastRenderedNotificationRuntime = null;
    _syncPersistentActionButton();
    return;
  }

  const stateType = String(actionSource?.type || '').trim();
  const shouldShowStatus = !currentRuntimeConnected
    || (!suppressingInterrupt && shouldShowRuntimeStatus(runtime, stateType));
  if (currentRuntimeAgentId && payload.callActive === undefined) {
    if (stateType === 'call.start') {
      if (!isRuntimeCalling(currentRuntimeAgentId)
        && !isInterruptSuppressed(currentRuntimeAgentId, observedCallStartedAt)) {
        _markAgentCallStartedForNotify(currentRuntimeAgentId);
        _agentCallActive.set(currentRuntimeAgentId, true);
        callingStateChanged = true;
        renderAgentList();
      }
    } else if (stateType === 'call.finish') {
      if (isRuntimeCalling(currentRuntimeAgentId)) {
        _agentCallActive.delete(currentRuntimeAgentId);
        callingStateChanged = true;
        renderAgentList();
        _tryNotifyAgentFinished(currentRuntimeAgentId, payload);
      }
      clearInterruptSuppression(currentRuntimeAgentId);
    }
  }

  if (shouldShowStatus) {
    statusEl.style.display = 'flex';
    statusEl.className = `notification-status active ${getRuntimeStageClass(runtime)}${currentRuntimeConnected ? '' : ' is-disconnected'}`;
    phaseEl.textContent = getCompactRuntimeLabel(runtime, currentRuntimeConnected);
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
      clearInterruptSuppression(currentRuntimeAgentId);
      renderAgentList();
      _tryNotifyAgentFinished(currentRuntimeAgentId, payload);
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

  // 同步对话区域临时状态块
  ensureChatRuntimeIndicator();
}

// ─── 对话区域临时运行状态块 ───

/**
 * 从 tool call arguments 中提取人类可读的摘要。
 * 不同工具展示不同关键参数。
 */
function summarizeToolCall(call) {
  if (!call || !call.name) return '';
  const name = String(call.name);
  const args = (call.arguments && typeof call.arguments === 'object') ? call.arguments : {};

  // 提取第一行 / 截断长文本
  function truncate(str, max) {
    const s = String(str || '').trim();
    if (s.length <= max) return s;
    return s.slice(0, max) + '…';
  }

  switch (name) {
    case 'bash':
    case 'powershell':
      return truncate(args.command, 80);
    case 'read':
      return truncate(args.filePath, 100);
    case 'edit':
      return truncate(args.filePath, 100);
    case 'write':
      return truncate(args.filePath, 100);
    case 'grep':
      return args.pattern ? `"${truncate(args.pattern, 40)}"` + (args.searchPath ? ` in ${truncate(args.searchPath, 50)}` : '') : '';
    case 'glob':
      return truncate(args.pattern, 80);
    case 'ls':
      return truncate(args.dirPath, 100);
    case 'web_fetch':
    case 'mcp_playwright_browser_navigate':
      return truncate(args.url, 100);
    case 'task_create':
    case 'task_update':
      return truncate(args.subject, 80);
    case 'mcp_playwright_browser_click':
    case 'mcp_playwright_browser_type':
      return truncate(args.element || args.text, 60);
    case 'mcp_playwright_browser_snapshot':
    case 'mcp_playwright_browser_take_screenshot':
      return '';
    default: {
      // 通用回退：尝试常见参数名
      const keys = ['filePath', 'path', 'command', 'query', 'url', 'pattern', 'name', 'subject', 'message'];
      for (const k of keys) {
        if (args[k]) return truncate(args[k], 80);
      }
      return '';
    }
  }
}

/**
 * 构建临时状态块的结构化内容。
 * 返回 { main: string, details: string[] } 或 null。
 */
function buildRuntimeIndicatorContent(runtime) {
  const isZh = currentLanguage === 'zh';
  const stage = runtime.stage;
  let mainText = '';
  const details = [];

  // 主行：阶段标签 + 字符数
  if (stage === 'llm_thinking') {
    const chars = runtime.thinkingChars || runtime.charCount;
    mainText = isZh
      ? `模型正在思考${chars > 0 ? ' · ' + formatRuntimeCompactNumber(chars) + ' 字' : '…'}`
      : `Thinking${chars > 0 ? ' · ' + formatRuntimeCompactNumber(chars) + ' chars' : '…'}`;
  } else if (stage === 'llm_content') {
    const chars = runtime.contentChars || runtime.charCount;
    mainText = isZh
      ? `正在生成回复${chars > 0 ? ' · ' + formatRuntimeCompactNumber(chars) + ' 字' : '…'}`
      : `Generating${chars > 0 ? ' · ' + formatRuntimeCompactNumber(chars) + ' chars' : '…'}`;
  } else if (stage === 'llm_tool_call_building') {
    const toolNames = runtime.streamToolNames || [];
    if (toolNames.length > 0) {
      mainText = isZh ? `正在准备工具调用 · ${toolNames.join(', ')}` : `Preparing tools · ${toolNames.join(', ')}`;
    } else {
      mainText = isZh ? '正在准备工具调用…' : 'Preparing tools…';
    }
  } else if (stage === 'tool_executing') {
    const pending = getPendingToolCallsFromMessages();
    if (pending.length > 0) {
      mainText = isZh ? `正在执行 ${pending.length} 个工具` : `Running ${pending.length} tool${pending.length > 1 ? 's' : ''}`;
      pending.forEach(function(call) {
        const summary = summarizeToolCall(call);
        const display = getToolDisplayName(call.name) || call.name;
        details.push(summary ? `${display}: ${summary}` : display);
      });
    } else {
      const toolNames = runtime.activeToolNames || [];
      if (toolNames.length > 0) {
        mainText = isZh ? `正在执行工具 · ${toolNames.join(', ')}` : `Running tools · ${toolNames.join(', ')}`;
      } else {
        mainText = isZh ? '正在执行工具…' : 'Running tools…';
      }
    }
  } else if (stage === 'awaiting_runtime') {
    const pending = getPendingToolCallsFromMessages();
    if (pending.length > 0) {
      mainText = isZh ? `等待 ${pending.length} 个工具返回` : `Waiting for ${pending.length} tool${pending.length > 1 ? 's' : ''}`;
    } else {
      mainText = isZh ? '等待响应…' : 'Waiting…';
    }
  } else if (stage === 'retry_waiting') {
    mainText = isZh ? '等待重试…' : 'Waiting to retry…';
  } else if (stage === 'retry_requesting') {
    mainText = isZh ? '正在重新请求…' : 'Retrying…';
  } else if (stage === 'failed') {
    mainText = isZh ? '请求失败' : 'Failed';
  } else {
    if (runtime.callActive) {
      mainText = isZh ? '处理中…' : 'Working…';
    }
  }

  if (!mainText) return null;

  // 耗时（inline 追加到主行末尾）
  const elapsed = runtime.callStartedAt > 0
    ? formatRuntimeDuration(Date.now() - runtime.callStartedAt)
    : '';
  if (elapsed) mainText += ' · ' + elapsed;

  return { main: mainText, details: details };
}

/**
 * 创建 / 更新 / 移除对话区域临时状态块。
 * 在隐藏过程模式下，Agent 活跃时显示，完成后消失。
 * 使用 DOM diff 更新文本，避免重建元素导致 CSS 动画重置。
 */
function ensureChatRuntimeIndicator() {
  const chatContainer = document.getElementById('chat-container');
  if (!chatContainer) return;

  const INDICATOR_ID = 'runtime-indicator-row';
  let existing = chatContainer.querySelector('#' + INDICATOR_ID);

  // 判断是否应该显示
  const shouldShow = typeof showChatProcess !== 'undefined' && !showChatProcess
    && _lastRenderedNotificationRuntime
    && _lastRenderedNotificationRuntime.callActive
    && _lastRenderedNotificationRuntime.stage !== 'idle'
    && _lastRenderedNotificationRuntime.stage !== 'completed'
    && _lastRenderedNotificationRuntime.stage !== 'failed';

  if (!shouldShow) {
    if (existing) existing.remove();
    return;
  }

  // 构建内容
  const content = buildRuntimeIndicatorContent(_lastRenderedNotificationRuntime);
  if (!content) {
    if (existing) existing.remove();
    return;
  }

  if (!existing) {
    existing = document.createElement('div');
    existing.id = INDICATOR_ID;
    existing.className = 'runtime-indicator-row';
    runWithSuppressedChatViewportObservers(function() {
      chatContainer.appendChild(existing);
    });
  }

  // 更新主行（textContent 而非 innerHTML，保持 CSS 动画连续）
  let mainEl = existing.querySelector('.runtime-indicator-main');
  if (!mainEl) {
    mainEl = document.createElement('div');
    mainEl.className = 'runtime-indicator-main';
    existing.appendChild(mainEl);
  }
  if (mainEl.textContent !== content.main) {
    mainEl.textContent = content.main;
  }

  // 更新详情行：增删改，不重建已有元素
  let detailEls = existing.querySelectorAll('.runtime-indicator-detail');
  // 移除多余的
  for (let i = detailEls.length - 1; i >= content.details.length; i--) {
    detailEls[i].remove();
  }
  // 更新或新增
  for (let i = 0; i < content.details.length; i++) {
    detailEls = existing.querySelectorAll('.runtime-indicator-detail');
    let el = detailEls[i];
    if (!el) {
      el = document.createElement('div');
      el.className = 'runtime-indicator-detail';
      existing.appendChild(el);
    }
    if (el.textContent !== content.details[i]) {
      el.textContent = content.details[i];
    }
  }

  // 确保始终在容器最末尾
  if (chatContainer.lastElementChild !== existing) {
    runWithSuppressedChatViewportObservers(function() {
      chatContainer.appendChild(existing);
    });
  }
}

// ─── 启动通知计时器 ───

ensureNotificationClockTimer();
