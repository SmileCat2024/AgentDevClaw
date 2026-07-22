/**
 * auto-title.js — 自动标题生成
 * 从 app-main.js 拆出（Phase A-3）
 * 拆出日期：2026-07-03
 *
 * 依赖全局状态（定义在 app-core.js）:
 *   currentRuntimeAgentId, currentAgentId, currentLanguage,
 *   allAgents, _autoTitleTriggered, _seenChoiceAlertIds, _lastChoiceAlertCheckAt
 * 依赖全局函数:
 *   getCurrentAgentRecord (app-main.js)
 *   ClawToast (modules/toast-notify.js)
 *   _tryNotifyInputRequest (modules/desktop-notify.js)
 * 导出全局函数:
 *   getAutoTitleSessionInfo, markAutoTitleCandidate, recheckAutoTitleCandidate,
 *   _messagesEqual, findFirstChangedMessageIndex, tryAutoTitleGeneration,
 *   autoGenerateSessionTitle, checkGlobalChoiceAlerts
 * 导出全局变量:
 *   _autoTitlePending
 */

// ── Auto session title generation ──────────────────────────────────────────
const _autoTitlePending = new Set();
// 衍生会话（trim/summary/branch）基线 assistant 数量。
// 首次观测到非空消息时记录，之后只有 assistant 数量超过基线才触发标题生成。
// 这样既能跳过初始 seed 注入，又不会因 currentMessages 被临时重置为 [] 而误判。
const _derivedBaseline = new Map();

function getAutoTitleSessionInfo() {
  // 当用户在查看某个 runtime 时，优先使用该 runtime agent 的 session 信息。
  // host agent 的 active_workspace_session_id 指向 "primary" runtime（通常是最近启动的），
  // 但用户可能正在查看另一个 runtime 的会话。
  const runtimeId = normalizeAgentIdentity(currentRuntimeAgentId);
  if (runtimeId) {
    const runtimeAgent = allAgents.find(function(a) {
      return normalizeAgentIdentity(a && a.id) === runtimeId;
    });
    if (runtimeAgent) {
      const sessionId = String(runtimeAgent.active_workspace_session_id || '').trim();
      if (sessionId) return { agent: runtimeAgent, sessionId: sessionId };
    }
  }
  // Fallback: 使用 host agent
  const agent = getCurrentAgentRecord();
  if (!agent) return null;
  const sessionId = String(agent.active_workspace_session_id || agent.workspace_sessions?.activeSessionId || '').trim();
  return sessionId ? { agent, sessionId } : null;
}

function markAutoTitleCandidate(previousMessages, nextMessages) {
  const info = getAutoTitleSessionInfo();
  if (!info) return;
  const currentTitle = String(info.agent.active_workspace_session_title || '').trim();
  const isDerivedSession = /^（/.test(currentTitle);
  if (currentTitle && !/^新对话\d+$/.test(currentTitle) && !isDerivedSession) return;
  const previousAssistantCount = previousMessages.filter(function(message) {
    return message && message.role === 'assistant';
  }).length;
  const nextAssistantCount = nextMessages.filter(function(message) {
    return message && message.role === 'assistant';
  }).length;
  // [DEBUG-AUTO-TITLE]
  console.log('[AutoTitle][mark] session:', info.sessionId, 'title:', JSON.stringify(currentTitle),
    'prevMsgs:', previousMessages.length, 'nextMsgs:', nextMessages.length,
    'prevAC:', previousAssistantCount, 'nextAC:', nextAssistantCount,
    'isDerived:', isDerivedSession);
  if (isDerivedSession) {
    if (!_derivedBaseline.has(info.sessionId)) {
      if (nextMessages.length > 0) {
        _derivedBaseline.set(info.sessionId, nextAssistantCount);
        console.log('[AutoTitle][mark] → recorded baseline:', nextAssistantCount);
      }
      return;
    }
    if (nextAssistantCount > _derivedBaseline.get(info.sessionId)) {
      console.log('[AutoTitle][mark] → ADD TO PENDING (derived, exceeded baseline)');
      _autoTitlePending.add(info.sessionId);
    }
  } else {
    if (previousAssistantCount === 0 && nextAssistantCount > 0) {
      const hasUserMessage = nextMessages.some(function(m) { return m && m.role === 'user'; });
      console.log('[AutoTitle][mark] → new conv 0→1 check, hasUser:', hasUserMessage);
      if (hasUserMessage) {
        console.log('[AutoTitle][mark] → ADD TO PENDING (new conv)');
        _autoTitlePending.add(info.sessionId);
      }
    }
  }
}

/**
 * Recheck whether the current session should be a title-generation candidate.
 * Called after loadAgentData / cache restore — covers the case where the
 * 0→1 assistant transition was missed because messages arrived in bulk
 * (page refresh, session switch with cached data).
 */
function recheckAutoTitleCandidate() {
  const info = getAutoTitleSessionInfo();
  if (!info) return;
  const { agent, sessionId } = info;
  const currentTitle = String(agent.active_workspace_session_title || '').trim();
  const isDerivedSession = /^（/.test(currentTitle);
  const isNewConversation = /^新对话\d+$/.test(currentTitle);
  if (!isDerivedSession && !isNewConversation) return;

  const currentAC = Array.isArray(currentMessages)
    ? currentMessages.filter(function(m) { return m && m.role === 'assistant'; }).length
    : 0;
  const currentMsgLen = Array.isArray(currentMessages) ? currentMessages.length : 0;

  // [DEBUG-AUTO-TITLE]
  console.log('[AutoTitle][recheck] session:', sessionId, 'title:', JSON.stringify(currentTitle),
    'msgLen:', currentMsgLen, 'AC:', currentAC, 'isDerived:', isDerivedSession, 'isNew:', isNewConversation);

  if (isDerivedSession) {
    if (!_derivedBaseline.has(sessionId)) {
      if (currentMsgLen > 0) {
        _derivedBaseline.set(sessionId, currentAC);
        console.log('[AutoTitle][recheck] → recorded baseline:', currentAC);
      }
      return;
    }
    if (currentAC > _derivedBaseline.get(sessionId)) {
      console.log('[AutoTitle][recheck] → ADD TO PENDING (derived, exceeded baseline)');
      _autoTitlePending.add(sessionId);
    }
    return;
  }

  const hasUserMessage = Array.isArray(currentMessages)
    && currentMessages.some(function(m) { return m && m.role === 'user'; });
  if (currentAC > 0 && hasUserMessage) {
    console.log('[AutoTitle][recheck] → ADD TO PENDING (new conv, AC>0 & hasUser)');
    _autoTitlePending.add(sessionId);
  }
}

function _messagesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.role !== b.role) return false;
  if ((a.content || '') !== (b.content || '')) return false;
  if ((a.reasoning || '') !== (b.reasoning || '')) return false;
  if ((a.toolCallId || '') !== (b.toolCallId || '')) return false;
  const ac = a.toolCalls, bc = b.toolCalls;
  const acLen = ac ? ac.length : 0;
  const bcLen = bc ? bc.length : 0;
  if (acLen !== bcLen) return false;
  for (let j = 0; j < acLen; j++) {
    if (ac[j].id !== bc[j].id) return false;
    if (ac[j].name !== bc[j].name) return false;
    if (JSON.stringify(ac[j].arguments) !== JSON.stringify(bc[j].arguments)) return false;
  }
  return true;
}

function findFirstChangedMessageIndex(nextMessages, previousMessages) {
  if (!Array.isArray(nextMessages) || !Array.isArray(previousMessages)) {
    return 0;
  }

  const length = Math.min(nextMessages.length, previousMessages.length);
  for (let i = 0; i < length; i++) {
    if (!_messagesEqual(nextMessages[i], previousMessages[i])) {
      return i;
    }
  }

  return nextMessages.length === previousMessages.length ? -1 : length;
}

/**
 * Find the agent record and session info for a given sessionId by searching allAgents.
 * Returns { agent, session, sessionId, runtimeId, title } or null if not found.
 */
function _findSessionOwner(sessionId) {
  if (!Array.isArray(allAgents)) return null;
  for (const agent of allAgents) {
    const sessions = agent && agent.workspace_sessions && agent.workspace_sessions.sessions;
    if (!Array.isArray(sessions)) continue;
    const session = sessions.find(function(s) { return s && s.id === sessionId; });
    if (session) {
      return {
        agent: agent,
        session: session,
        sessionId: sessionId,
        runtimeId: typeof getAgentRuntimeId === 'function' ? getAgentRuntimeId(agent) : (agent.runtime_session_id || agent.id),
        title: String(session.title || '').trim(),
      };
    }
  }
  return null;
}

/**
 * Attempt title generation for a single session after all guard checks pass.
 * @param agent  - agent record (must have .id)
 * @param sessionId
 * @param sessionTitle - current title string (checked against /^新对话\d+$/)
 * @param messages - current session's messages array (null for non-current sessions)
 */
function _tryTitleForSession(agent, sessionId, sessionTitle, messages) {
  // 匹配新对话 或 衍生会话前缀（（精简）（摘要）（分支）等）
  if (!/^新对话\d+$/.test(sessionTitle) && !/^（/.test(sessionTitle)) {
    _autoTitlePending.delete(sessionId);
    _derivedBaseline.delete(sessionId);
    return;
  }

  // For the current session, verify there is at least one assistant message
  // with non-empty content to generate a title from.
  // (Not necessarily the last message — tool-heavy turns may end with a tool result.)
  if (messages) {
    const hasAssistantContent = messages.some(function(m) {
      return m && m.role === 'assistant' && String(m.content || '').trim();
    });
    if (!hasAssistantContent) return;
  }

  // Prevent concurrent calls for the same session.
  // autoGenerateSessionTitle handles all retries internally.
  if (_autoTitleTriggered.has(sessionId)) return;

  _autoTitleTriggered.add(sessionId);

  // [DEBUG-AUTO-TITLE]
  console.log('[AutoTitle][FIRE] → autoGenerateSessionTitle for session:', sessionId, 'agent:', agent.id);

  // Fire and forget — don't block the poll loop
  autoGenerateSessionTitle(agent.id, sessionId, !!messages);
}

function tryAutoTitleGeneration(messages) {
  if (!currentRuntimeAgentId || !currentAgentId) return;

  // [DEBUG-AUTO-TITLE]
  if (_autoTitlePending.size > 0) {
    console.log('[AutoTitle][try] pending set:', Array.from(_autoTitlePending),
      'currentRuntime:', currentRuntimeAgentId);
  }

  const info = getAutoTitleSessionInfo();

  // 1. Try the currently-viewed session
  if (info && _autoTitlePending.has(info.sessionId)) {
    const currentTitle = String(info.agent.active_workspace_session_title || '').trim();
    _tryTitleForSession(info.agent, info.sessionId, currentTitle, messages);
  }

  // 2. Scan other pending sessions whose runtimes are idle.
  //    This covers sessions the user switched away from before the title
  //    could be generated.
  const pendingIds = Array.from(_autoTitlePending);
  for (let i = 0; i < pendingIds.length; i++) {
    const pendingId = pendingIds[i];
    if (info && pendingId === info.sessionId) continue; // already handled above

    const owner = _findSessionOwner(pendingId);
    if (!owner) {
      // Session no longer exists in any agent — clean up
      _autoTitlePending.delete(pendingId);
      _autoTitleTriggered.delete(pendingId);
      _derivedBaseline.delete(pendingId);
      continue;
    }

    // Only trigger if the owning runtime is idle (assistant finished responding)
    if (typeof isRuntimeCalling === 'function' && isRuntimeCalling(owner.runtimeId)) continue;

    _tryTitleForSession(owner.agent, pendingId, owner.title, null);
  }
}

const AUTO_TITLE_MAX_ATTEMPTS = 3;
const AUTO_TITLE_RETRY_BACKOFF_MS = 5000;
// Must exceed server's 120s child-process timeout to avoid false-abort
const AUTO_TITLE_FETCH_TIMEOUT_MS = 125000;

/**
 * Generate a session title with internal retries.
 * Shows a loading toast only for the foreground (currently-viewed) session.
 * Background sessions generate silently — only success/failure toast is shown.
 */
async function autoGenerateSessionTitle(agentId, sessionId, isForeground) {
  let succeeded = false;
  let lastError = null;
  const isZh = currentLanguage === 'zh';
  const toastId = 'title-auto-' + sessionId;

  // 查找会话当前标题，用于 Toast 展示
  const owner = _findSessionOwner(sessionId);
  const sessionLabel = owner ? owner.title : '';

  // 只为前台会话（用户当前正在看的）显示 loading toast，
  // 后台会话静默生成，避免用户在查看新会话时被其他会话的 toast 干扰。
  if (isForeground) {
    ClawToast.show({
      id: toastId,
      title: isZh ? '正在生成会话标题...' : 'Generating session title...',
      description: sessionLabel || undefined,
      status: 'loading',
    });
  }

  for (let attempt = 1; attempt <= AUTO_TITLE_MAX_ATTEMPTS; attempt++) {
    let controller = new AbortController();
    const fetchTimer = setTimeout(function() { controller.abort(); }, AUTO_TITLE_FETCH_TIMEOUT_MS);

    try {
      const response = await fetch('/protoclaw/generate_session_title', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: agentId, sessionId: sessionId }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }
      const result = await response.json();
      if (typeof applySessionMutationDelta === 'function') {
        applySessionMutationDelta(agentId, result);
      }
      if (result.ok && result.title) {
        // Update local data
        const agent = typeof getCurrentAgentRecord === 'function' ? getCurrentAgentRecord() : null;
        if (agent) {
          const sessions = agent.workspace_sessions && agent.workspace_sessions.sessions || [];
          const target = sessions.find(function(s) { return s.id === sessionId; });
          if (target) target.title = result.title;
          if (String(agent.active_workspace_session_id || '') === String(sessionId)) {
            agent.active_workspace_session_title = result.title;
          }
        }
        console.log('[AutoTitle] title set:', result.title);
        succeeded = true;
        ClawToast.show({
          id: toastId,
          status: 'success',
          title: isZh ? '标题已生成' : 'Title generated',
          description: result.title,
        });
        break;
      } else {
        throw new Error(isZh ? '未返回有效标题' : 'No valid title returned');
      }
    } catch (error) {
      lastError = error;
      const isAbort = error && error.name === 'AbortError';
      console.warn('[AutoTitle] attempt ' + attempt + '/' + AUTO_TITLE_MAX_ATTEMPTS +
        (isAbort ? ' timed out' : ' failed') + ':', error.message || error);
      // Silent retry — only show error on the last attempt
      if (attempt < AUTO_TITLE_MAX_ATTEMPTS) {
        clearTimeout(fetchTimer);
        await new Promise(function(r) { setTimeout(r, AUTO_TITLE_RETRY_BACKOFF_MS); });
        continue;
      }
    } finally {
      clearTimeout(fetchTimer);
    }
  }

  if (!succeeded) {
    const isAbort = lastError && lastError.name === 'AbortError';
    ClawToast.show({
      id: toastId,
      status: 'warning',
      title: isZh ? '标题自动生成未成功' : 'Auto title generation unsuccessful',
      description: isAbort
        ? (isZh ? '请求超时' : 'Request timed out')
        : (lastError ? (lastError.message || String(lastError)) : 'Unknown error'),
    });
  }

  _autoTitleTriggered.delete(sessionId);
  _autoTitlePending.delete(sessionId);
  _derivedBaseline.delete(sessionId);
}

/**
 * Global choice-request alert check: polls the server for choice-type
 * input requests across ALL connected agents (not just the focused one).
 * Shows a ClawToast warning for each newly discovered request so the user
 * is alerted even when viewing a different conversation.
 *
 * Note: Desktop notifications for choice requests are handled independently
 * by refreshChoiceAlertStates() in desktop-notify.js (called from the worker
 * heartbeat when backgrounded). This separation is intentional — see the
 * comment on refreshChoiceAlertStates for details.
 */
async function checkGlobalChoiceAlerts() {
  try {
    const res = await fetch('/protoclaw/choice_alerts');
    if (!res.ok) return;
    const data = await res.json();
    const alerts = Array.isArray(data.alerts) ? data.alerts : [];
    for (const alert of alerts) {
      if (!_seenChoiceAlertIds.has(alert.requestId)) {
        if (_seenChoiceAlertIds.size > 500) _seenChoiceAlertIds.clear();
        _seenChoiceAlertIds.add(alert.requestId);
        // Try to find a richer display name from allAgents
        const matched = allAgents.find(
          (a) => (a.runtime_session_id || a.runtimeSessionId) === alert.agentId
        );
        const displayName = matched?.active_workspace_display_name
          || matched?.active_workspace_session_title
          || matched?.name
          || alert.agentName
          || alert.agentId;
        const isZh = currentLanguage === 'zh';
        ClawToast.show({
          id: 'choice-alert-' + alert.requestId,
          title: isZh ? '等待用户选择' : 'Waiting for user choice',
          description: (isZh ? '会话：' : 'Session: ') + displayName,
          status: 'warning',
        });
      }
    }
  } catch { /* non-critical */ }
}
