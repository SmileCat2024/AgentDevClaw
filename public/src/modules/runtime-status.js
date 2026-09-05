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
 * - currentMessages, currentRuntimeAgentId, _agentCallActive,
 *   _agentCallActive, isInterruptSuppressed, clearInterruptSuppression
 *   (app-core.js / app-main.js)
 * - normalizeAgentIdentity, toEpochMs, renderAgentList (app-main.js)
 *   工单 037：calling 翻转不再手动戳输入面——calling 不进入显示模式矩阵，
 *   模式翻转由真正的状态写入（patch / 队列同步）声明，此前的三处
 *   reset+render 配对为死路径，已删除。
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
let _contextGuardToastKey = '';
const _contextGuardPageLoadedAt = Date.now();

/**
 * 消费 /protoclaw/context_guard_status（session IPC）的返回体。保险丝的
 * 拦截动作（打断 + 退回排队消息）发生在 runtime 内；前端唯一的职责是在
 * trip 发生时给出一次 toast 提醒。输入框不禁用——过界后继续发送的开销
 * 由用户自负。
 */
function applyContextGuardStatus(payload, runtimeId = currentRuntimeAgentId) {
  const normalizedRuntimeId = normalizeAgentIdentity(runtimeId);
  if (!normalizedRuntimeId || normalizedRuntimeId !== normalizeAgentIdentity(currentRuntimeAgentId)) return;
  const trip = payload && typeof payload === 'object' && payload.status && typeof payload.status === 'object'
    ? payload.status.trip : null;
  if (!trip || typeof trip !== 'object') return;
  // 只提醒页面加载之后发生的 trip：刷新页面或切回已触发过的会话不再打扰。
  const tripAt = Number(trip.at);
  if (Number.isFinite(tripAt) && tripAt > 0 && tripAt < _contextGuardPageLoadedAt) return;
  const toastKey = `${normalizedRuntimeId}:${Number.isFinite(tripAt) && tripAt > 0 ? Math.round(tripAt) : 'trip'}`;
  if (_contextGuardToastKey === toastKey) return;
  _contextGuardToastKey = toastKey;

  const inputTokens = Number(trip.inputTokens);
  const thresholdTokens = Number(trip.thresholdTokens);
  const zh = currentLanguage === 'zh';
  const usage = Number.isFinite(inputTokens) && inputTokens > 0 && Number.isFinite(thresholdTokens) && thresholdTokens > 0
    ? `${inputTokens.toLocaleString()} / ${thresholdTokens.toLocaleString()} tokens`
    : '';
  window.ClawToast?.show?.({
    id: `context-guard-${normalizedRuntimeId}`,
    status: 'warning',
    title: zh ? '上下文已超过阈值，本轮已打断' : 'Context threshold exceeded — turn interrupted',
    description: zh
      ? `用量 ${usage}。建议通过精简 / 摘要 / 分支降低上下文后继续；也可以直接继续发送（开销自负）。`
      : `Usage ${usage}. Consider trimming, summarizing, or branching before continuing; sending anyway is at your own cost.`,
    autoDismiss: 8000,
  });
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
    sessionType: String(runtimeAgent.sessionType || 'main'),
    sidebarEntryId: String(runtimeAgent.sidebar_entry_id || '').trim()
      || (String(runtimeAgent.sessionType || 'main').trim() === 'main'
        ? ownerId
        : `${ownerId}:${String(runtimeAgent.sessionType || 'main').trim()}`),
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
    // 会话绑定的项目目录（server 从 session index 附带）。投影条目（coder）
    // 不继承宿主 workspace_sessions，靠此字段参与目录分组。
    openDirectory: String(runtimeAgent.open_directory || '').trim(),
  };
}

function getSidebarOperationPendingName(operation) {
  // 线程宿主会话（coder）：trim / summary 是线程内上下文接力，不是「创建新会话」
  const isThreadHost = typeof window.isThreadHostAgentId === 'function'
    && window.isThreadHostAgentId(operation?.agentId, operation?.sessionId);
  if (operation?.kind === 'branch') {
    return currentLanguage === 'zh' ? '正在创建分支…' : 'Creating branch…';
  }
  if (operation?.kind === 'trim') {
    if (isThreadHost) return currentLanguage === 'zh' ? '上下文接力中 · 精简…' : 'Relaying context · trim…';
    return currentLanguage === 'zh' ? '正在生成精简会话…' : 'Creating trimmed session…';
  }
  if (operation?.kind === 'summary') {
    if (isThreadHost) return currentLanguage === 'zh' ? '上下文接力中 · 摘要…' : 'Relaying context · summary…';
    return currentLanguage === 'zh' ? '正在生成摘要会话…' : 'Creating summarized session…';
  }
  return currentLanguage === 'zh' ? '正在启动新会话…' : 'Starting new session…';
}

function getSidebarOperationFailureName(operation) {
  // A degraded target operation is reached only after the session mutation has
  // committed. Its failure describes the runtime startup, never session creation.
  const isThreadHost = typeof window.isThreadHostAgentId === 'function'
    && window.isThreadHostAgentId(operation?.agentId, operation?.sessionId);
  if (operation?.kind === 'branch') {
    return currentLanguage === 'zh' ? '分支会话启动失败' : 'Branch session failed to start';
  }
  if (operation?.kind === 'trim') {
    if (isThreadHost) return currentLanguage === 'zh' ? '接力会话启动失败' : 'Relay session failed to start';
    return currentLanguage === 'zh' ? '精简会话启动失败' : 'Trimmed session failed to start';
  }
  if (operation?.kind === 'summary') {
    if (isThreadHost) return currentLanguage === 'zh' ? '接力会话启动失败' : 'Relay session failed to start';
    return currentLanguage === 'zh' ? '摘要会话启动失败' : 'Summarized session failed to start';
  }
  return currentLanguage === 'zh' ? '新会话启动失败' : 'New session failed to start';
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
  const hostAgentId = String(prebuiltAgent?.agentId || prebuiltAgent?.id || '').trim();
  if (hostAgentId === 'programming-helper') {
    // 投影条目（coder）被服务端剥离会话级字段，目录映射改从全局列表中的
    // 宿主记录读取——宿主的 workspace_sessions 覆盖工作空间全部会话身份。
    // 无宿主记录可用时（极端时序/测试沙箱）映射为空，退回 open_directory 兜底。
    const hostRecord = String(prebuiltAgent?.id || '').trim() === hostAgentId
      ? prebuiltAgent
      : (typeof allAgents !== 'undefined' && Array.isArray(allAgents)
        ? allAgents.find((item) => item?.id === hostAgentId) || null
        : null);
    const phProjects = Array.isArray(hostRecord?.workspace_state?.phProjects)
      ? hostRecord.workspace_state.phProjects
      : [];
    const projectIdToDir = new Map();
    for (const project of phProjects) {
      const pid = String(project?.id || '').trim();
      const pdir = String(project?.openDirectory || '').trim();
      if (pid && pdir) projectIdToDir.set(pid, pdir);
    }
    const sessions = Array.isArray(hostRecord?.workspace_sessions?.sessions)
      ? hostRecord.workspace_sessions.sessions
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
    if (!entry.projectDir) {
      // PH 宿主走 workspace_sessions 映射（大小写已校正）；其余条目
      // （coder 投影等）用 server 附带的 open_directory 兜底。
      let dir = entry.openDirectory || '';
      if (sessionDirMap.size > 0 && entry.sessionId) {
        dir = sessionDirMap.get(entry.sessionId) || dir;
      }
      if (dir) {
        entry.projectDir = dir;
        entry.projectName = getPathLeaf(dir);
      }
    }
    if (typeof findSidebarOperation === 'function') {
      const operation = findSidebarOperation((item) => (
        item.agentId === hostAgentId
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
  //
  // 会话级身份路由：投影条目（agentId ≠ id，如 programming-helper:coder）只收集
  // sessionType='coder' 的子项，且不合成镜像条目（宿主 runtime 是 main 会话的）；
  // 宿主条目排除 coder 会话子项（它们归投影条目）。
  const isProjectionEntry = String(prebuiltAgent?.agentId || '').trim()
    && String(prebuiltAgent.agentId).trim() !== String(prebuiltAgent.id || '').trim();
  const childSessionType = isProjectionEntry
    ? String(prebuiltAgent.sessionType || '').trim() || 'main'
    : null;
  const childRuntimeIds = new Set();
  // Session ids already presented by a live child runtime. A pending
  // sidebar operation for the same target session hands over to that
  // child entry in place instead of rendering a second placeholder.
  const childCoveredSessionIds = new Set();
  const expectedSidebarEntryId = String(prebuiltAgent?.id || '').trim();
  agents
    .filter((agent) => {
      if (agent.source === 'prebuilt') return false;
      if (String(agent.parent_id || '').trim() !== hostAgentId) return false;
      // sidebar_entry_id is the explicit presentation owner. Keep the
      // sessionType fallback for older runtime snapshots during a refresh.
      const sidebarEntryId = String(agent.sidebar_entry_id || '').trim();
      if (sidebarEntryId && sidebarEntryId !== expectedSidebarEntryId) return false;
      if (childSessionType && String(agent.sessionType || 'main') !== childSessionType) return false;
      if (!childSessionType && String(agent.sessionType || '') === 'coder') return false;
      return true;
    })
    .forEach((agent) => {
      const runtimeId = String(agent.runtime_session_id || agent.runtimeSessionId || agent.id || '').trim();
      if (runtimeId) childRuntimeIds.add(runtimeId);
      const coveredSessionId = String(agent.active_workspace_session_id || '').trim();
      if (coveredSessionId) childCoveredSessionIds.add(coveredSessionId);
      addEntry(buildChildRuntimeEntry(agent));
    });

  // The host snapshot may point at whichever session was most recently started.
  // If that runtime is already represented by a child entry, do not synthesize it
  // again under the host row; otherwise a coder runtime appears as a PH mirror.
  if (!isProjectionEntry) {
    const syntheticRuntimeId = String(
      prebuiltAgent.runtime_session_id || prebuiltAgent.runtimeSessionId || ''
    ).trim();
    if (!syntheticRuntimeId || !childRuntimeIds.has(syntheticRuntimeId)) {
      addEntry(buildSyntheticRuntimeEntry(prebuiltAgent));
    }
  }

  // 会话身份路由：宿主与投影条目共享 hostAgentId，operation 必须再按
  // sessionType 分流——宿主条目只收 main 会话的 operation，投影条目只收
  // 自身份（coder）的。否则同一占位会在两个条目下镜像。
  const expectedOperationSessionType = isProjectionEntry ? (childSessionType || 'main') : 'main';
  const operations = typeof listSidebarOperations === 'function'
    ? listSidebarOperations((operation) => (
      operation.agentId === hostAgentId
      && String(operation.sessionType || 'main') === expectedOperationSessionType
    ))
    : [];
  for (const operation of operations) {
    if (['settled', 'failed'].includes(operation.phase)) continue;
    const sourceEntry = entries.find((entry) => (
      (operation.sourceRuntimeId && entry.runtimeId === operation.sourceRuntimeId)
      || (operation.sourceSessionId && entry.sessionId === operation.sourceSessionId)
    ));
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
          ownerId: hostAgentId,
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

    // Only operations that can create or start a target runtime get a synthetic
    // sidebar item. Archive, unarchive, and history-only delete operations mutate
    // existing records; rendering them as pending runtimes creates phantom sessions.
    const createsTargetRuntime = operation.type === 'replacement' || operation.type === 'create' || operation.type === 'activate';
    if (!createsTargetRuntime) continue;
    // Programming-helper groups every runtime by project. Its operation creator
    // must provide this identity explicitly; never infer it from a current or
    // historical session, because either can belong to another project.
    // Guard by hostAgentId so the coder projection entry is covered too.
    if (hostAgentId === 'programming-helper' && !operation.projectDir) continue;

    if (operation.phase === 'degraded' && (!sourceEntry || operation.type !== 'replacement')) {
      addEntry({
        id: `operation:${operation.operationId}`,
        ownerId: hostAgentId,
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
    // In-place handover: a live child runtime already presenting the target
    // session replaces the placeholder. Without this check the echo frame
    // renders both entries; with an early settle it renders neither.
    const coveredTargetSessionId = String(operation.targetSessionId || '').trim();
    if (coveredTargetSessionId && childCoveredSessionIds.has(coveredTargetSessionId)) continue;
    const isReplacement = operation.type === 'replacement';
    const pendingName = getSidebarOperationPendingName(operation);
    addEntry({
      id: `operation:${operation.operationId}`,
      ownerId: hostAgentId,
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
    lastOutcome: runtime?.lastOutcome && typeof runtime.lastOutcome === 'object' ? runtime.lastOutcome : null,
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
    case 'cancelled':
      return t('phase_cancelled');
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
  if (runtime.stage === 'cancelled') {
    return currentLanguage === 'zh' ? '已停止' : 'Stopped';
  }
  if (runtime.stage === 'completed') {
    return currentLanguage === 'zh' ? '已完成' : 'Done';
  }
  if (runtime.callActive) {
    // 判定与对话区指示器（buildRuntimeIndicatorContent）保持同一数据源：
    // 只有消息视角确有未完成的 tool call 才显示"等待工具结果"。
    // toolCallCount 是整个 call 期间的累计值（工具全部完成后也不清零），
    // 用它判定会把"等下一轮模型响应"误显示为"等待工具结果"。
    if (runtime.activeToolCount > 0) {
      const toolSummary = summarizeRuntimeToolNames(runtime.activeToolNames);
      return toolSummary
        ? `${currentLanguage === 'zh' ? '执行工具' : 'Running Tools'} · ${toolSummary}`
        : (currentLanguage === 'zh' ? '执行工具' : 'Running Tools');
    }
    if (getPendingToolCallsFromMessages().length > 0) {
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

// 中文语境下的口语化时长（"12 秒" / "1 分 5 秒" / "1 小时 5 分"）
function formatRuntimeDurationZh(ms) {
  const totalSeconds = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return `${minutes} 分 ${seconds} 秒`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

/**
 * 当前步骤的用时（基于 stageStartedAt，与顶栏计时同口径）。
 * 主行文案已包含阶段描述（思考/生成/执行…），这里只返回时长本身，避免重复。
 */
function getRuntimeStepElapsedLabel(runtime) {
  if (!runtime || runtime.stageStartedAt <= 0) return '';
  const elapsedMs = Date.now() - runtime.stageStartedAt;
  return currentLanguage === 'zh'
    ? formatRuntimeDurationZh(elapsedMs)
    : formatRuntimeDuration(elapsedMs);
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
  if (stateType === 'call.finish') {
    // 结构化终态：failed / cancelled / completed（continued 由续接机制继续跑）
    const status = String(stateData?.status || '').trim();
    if (status === 'failed') return 'failed';
    if (status === 'cancelled') return 'cancelled';
    return 'completed';
  }
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
    && runtime.stage !== 'failed'
    && runtime.stage !== 'cancelled';
  const shouldUseDerivedStage = !runtimeAlreadyExpressive
    || runtime.stage === 'awaiting_runtime'
    || runtime.updatedAt <= 0;
  if (shouldUseDerivedStage && derivedStage && derivedStage !== 'idle') {
    runtime.stage = derivedStage;
  }

  if (runtime.callActive && (runtime.stage === 'idle' || runtime.stage === 'completed' || runtime.stage === 'failed' || runtime.stage === 'cancelled')) {
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
    // 结构化终态为权威事实：按 outcome.status 落定，而非默认 completed
    const status = String(stateData?.status || '').trim();
    runtime.stage = status === 'failed' || status === 'cancelled' ? status : 'completed';
  }

  if (runtime.callActive) {
    _runtimeStatusMemory.set(runtimeId, {
      callStartedAt: runtime.callStartedAt,
      stage: runtime.stage,
      stageStartedAt: runtime.stageStartedAt,
      toolCallCount: runtime.toolCallCount,
    });
  } else if (runtime.stage === 'completed' || runtime.stage === 'failed' || runtime.stage === 'cancelled') {
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
  if (runtime.stage === 'cancelled') {
    return t('runtime_status_cancelled');
  }
  if (runtime.stage === 'completed') {
    return t('runtime_status_completed');
  }
  if (runtime.callActive) {
    // 与 getCompactRuntimeLabel / buildRuntimeIndicatorContent 相同的判定源：
    // 消息视角确有未完成的 tool call 才算"等待工具结果"。
    if (runtime.activeToolCount === 0 && getPendingToolCallsFromMessages().length > 0) {
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
    // 工具进度卡片走秒刷新（ticket 025）：startedAt 本地插值，两次 poll 之间平滑增长
    if (typeof syncToolProgressDom === 'function') syncToolProgressDom();
  }, 200);
}

function getRuntimeStageClass(runtime) {
  return `stage-${String(runtime?.stage || 'idle').replace(/[^a-z0-9_-]/gi, '-')}`;
}

function shouldShowRuntimeStatus(runtime, stateType = '') {
  if (runtime.callActive && runtime.stage !== 'idle' && runtime.stage !== 'completed' && runtime.stage !== 'failed' && runtime.stage !== 'cancelled') {
    return true;
  }
  const settledRecently = runtime.updatedAt > 0 && (Date.now() - runtime.updatedAt) < (runtime.stage === 'failed' || runtime.stage === 'cancelled' ? 8000 : 800);
  return ((runtime.stage === 'completed' || runtime.stage === 'failed' || runtime.stage === 'cancelled') && settledRecently)
    || stateType === 'llm.char_count';
}

function shouldStatusUseQueueSync(runtime) {
  return runtime.stage === 'llm_thinking'
    || runtime.stage === 'llm_content'
    || runtime.stage === 'llm_tool_call_building';
}

// ─── 通知状态更新主逻辑 ───

/**
 * 会话 / 运行时切换时立即清空运行状态显示。
 *
 * 旧会话的快照（_lastRenderedNotificationRuntime）与顶栏 DOM 在新会话的
 * notification 数据到达前仍然存活（loadAgentData 需要等多个 fetch 完成），
 * 期间 chat-renderer 每次渲染都会用旧快照重建对话区指示块，导致新会话里
 * 残留上一会话的"模型正在思考…"文案，随后才被新数据替换/移除，并伴随
 * 指示块出现/消失带来的高度抖动。切换瞬间直接清空，等新数据到达后再渲染。
 */
function resetRuntimeStatusForSwitch() {
  _lastRenderedNotificationRuntime = null;
  lastNotificationStatusPayload = null;
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
  const chatContainer = document.getElementById('chat-container');
  const existing = chatContainer ? chatContainer.querySelector('#runtime-indicator-row') : null;
  if (existing) {
    runWithSuppressedChatViewportObservers(function() {
      existing.remove();
    });
  }
  // 工具进度卡片随会话/运行时切换整体复位（ticket 025）
  if (typeof clearToolProgressState === 'function') clearToolProgressState();
}

// 通知状态更新
function updateNotificationStatus(notifData) {
  const payload = (notifData && typeof notifData === 'object') ? notifData : {};
  if (!notifData) _lastCallFinishTime = 0;
  // 工具执行中进度（ticket 025）：tool.progress 入表 / 终态信号清除
  if (typeof applyToolProgressNotification === 'function') {
    applyToolProgressNotification(payload);
  }
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
    // 快照已清空，对话区指示块需同 tick 移除，不等 200ms 时钟
    ensureChatRuntimeIndicator();
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
      ensureChatRuntimeIndicator();
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
    ensureChatRuntimeIndicator();
    return;
  }

  const { type, data } = actionSource || {};

  if (!type) {
    ensureChatRuntimeIndicator();
    return;
  }

  if (type === 'call.start') {
    _syncPersistentActionButton();
    ensureChatRuntimeIndicator();
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
    ensureChatRuntimeIndicator();
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

  // calling 翻转不触发输入面渲染（工单 037）：calling 不进入显示模式矩阵
  // （§3 级 8 calling/idle 同为 persistent），三态按钮由 _syncPersistentActionButton
  // 同步；模式翻转由真正的状态写入方声明。

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
  } else if (stage === 'cancelled') {
    mainText = isZh ? '已停止' : 'Stopped';
  } else {
    if (runtime.callActive) {
      mainText = isZh ? '处理中…' : 'Working…';
    }
  }

  if (!mainText) return null;

  // 耗时（当前步骤用时，与顶栏计时同口径；不再显示整轮总时长）
  const stepElapsed = getRuntimeStepElapsedLabel(runtime);
  if (stepElapsed) mainText += ' · ' + stepElapsed;

  return { main: mainText, details: details };
}

/**
 * 创建 / 更新 / 移除对话区域临时状态块。
 * Agent 活跃时显示，完成后消失（无论过程处于显示还是隐藏模式）。
 * 使用 DOM diff 更新文本，避免重建元素导致 CSS 动画重置。
 */
function ensureChatRuntimeIndicator() {
  const chatContainer = document.getElementById('chat-container');
  if (!chatContainer) return;

  const INDICATOR_ID = 'runtime-indicator-row';
  let existing = chatContainer.querySelector('#' + INDICATOR_ID);

  // 判断是否应该显示
  // 断连时上栏显示"已断开连接"，此处同步隐藏，避免继续展示过时的阶段文案
  const shouldShow = currentRuntimeConnected
    && _lastRenderedNotificationRuntime
    && _lastRenderedNotificationRuntime.callActive
    && _lastRenderedNotificationRuntime.stage !== 'idle'
    && _lastRenderedNotificationRuntime.stage !== 'completed'
    && _lastRenderedNotificationRuntime.stage !== 'failed';

  if (!shouldShow) {
    if (existing) {
      runWithSuppressedChatViewportObservers(function() {
        existing.remove();
      });
    }
    return;
  }

  // 构建内容
  const content = buildRuntimeIndicatorContent(_lastRenderedNotificationRuntime);
  if (!content) {
    if (existing) {
      runWithSuppressedChatViewportObservers(function() {
        existing.remove();
      });
    }
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
  // 所有子元素的创建和文本更新都包裹在 runWithSuppressedChatViewportObservers 中，
  // 避免触发 MutationObserver → notifyChatViewportMutation → lockChatViewportToBottomNow，
  // 后者会在 followLatestEnabled 时强制将视口锁定到最底部。
  runWithSuppressedChatViewportObservers(function() {
    let mainEl = existing.querySelector('.runtime-indicator-main');
    if (!mainEl) {
      mainEl = document.createElement('div');
      mainEl.className = 'runtime-indicator-main';
      existing.appendChild(mainEl);
    }
    // 确保 dot + text 子结构存在
    let dotEl = mainEl.querySelector('.runtime-indicator-dot');
    if (!dotEl) {
      dotEl = document.createElement('span');
      dotEl.className = 'runtime-indicator-dot';
      mainEl.appendChild(dotEl);
    }
    let textEl = mainEl.querySelector('.runtime-indicator-text');
    if (!textEl) {
      textEl = document.createElement('span');
      textEl.className = 'runtime-indicator-text';
      mainEl.appendChild(textEl);
    }
    if (textEl.textContent !== content.main) {
      textEl.textContent = content.main;
    }

    // 更新详情行：增删改，不重建已有元素（最多显示 5 行，避免悬挂区侵入过大）
    var MAX_DETAIL_ROWS = 5;
    var visibleDetails = content.details.slice(0, MAX_DETAIL_ROWS);
    let detailEls = existing.querySelectorAll('.runtime-indicator-detail');
    // 移除多余的
    for (let i = detailEls.length - 1; i >= visibleDetails.length; i--) {
      detailEls[i].remove();
    }
    // 更新或新增
    for (let i = 0; i < visibleDetails.length; i++) {
      detailEls = existing.querySelectorAll('.runtime-indicator-detail');
      let el = detailEls[i];
      if (!el) {
        el = document.createElement('div');
        el.className = 'runtime-indicator-detail';
        existing.appendChild(el);
      }
      if (el.textContent !== visibleDetails[i]) {
        el.textContent = visibleDetails[i];
      }
    }

    // 确保始终在容器最末尾
    if (chatContainer.lastElementChild !== existing) {
      chatContainer.appendChild(existing);
    }

    // 动态负 margin 补偿：抵消指示块对 scrollHeight 的贡献
    // （自身高度 + flex gap），使其随内容滚动但不影响滚动高度，
    // 彻底消除出现/消失/高度变化时的抖动。
    var flexGap = parseFloat(getComputedStyle(chatContainer).gap) || 24;
    var indicatorHeight = existing.offsetHeight;
    existing.style.marginBottom = (-indicatorHeight - flexGap) + 'px';
  });
}

// ─── 启动通知计时器 ───

ensureNotificationClockTimer();
