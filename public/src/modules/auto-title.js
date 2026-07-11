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

function getAutoTitleSessionInfo() {
  const agent = getCurrentAgentRecord();
  if (!agent) return null;
  const sessionId = String(agent.active_workspace_session_id || agent.workspace_sessions?.activeSessionId || '').trim();
  return sessionId ? { agent, sessionId } : null;
}

function markAutoTitleCandidate(previousMessages, nextMessages) {
  const info = getAutoTitleSessionInfo();
  if (!info) return;
  // Guard: if the session already has a generated title, skip entirely.
  // This prevents false re-triggers when currentMessages is reset to []
  // (runtime hiccup, session switch without cache, agent restart) and the
  // next poll sees a bogus [] → [messages with assistant] transition.
  const currentTitle = String(info.agent.active_workspace_session_title || '').trim();
  // 衍生会话标题以 （ 开头（如 （精简）（摘要）（分支）），允许触发自动标题
  const isDerivedSession = /^（/.test(currentTitle);
  if (currentTitle && !/^新对话\d+$/.test(currentTitle) && !isDerivedSession) return;
  const previousAssistantCount = previousMessages.filter(function(message) {
    return message && message.role === 'assistant';
  }).length;
  const nextAssistantCount = nextMessages.filter(function(message) {
    return message && message.role === 'assistant';
  }).length;
  if (isDerivedSession) {
    // 衍生会话：跳过初始加载（previousMessages 为空说明是首次 poll，消息来自 seed 注入）
    if (previousMessages.length === 0) return;
    // 后续 poll：检测 assistant 数量增长（用户首次真实交互后才触发）
    if (nextAssistantCount > previousAssistantCount && nextAssistantCount > 0) {
      _autoTitlePending.add(info.sessionId);
    }
  } else {
    // 新会话：检测 0→1 assistant 转变，且要求至少有一条 user 消息（排除 runtime 初始化产生的消息）
    if (previousAssistantCount === 0 && nextAssistantCount > 0) {
      var hasUserMessage = nextMessages.some(function(m) { return m && m.role === 'user'; });
      if (hasUserMessage) {
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
  if (!/^新对话\d+$/.test(currentTitle)) return;
  // 衍生会话（标题以 （ 开头）不在加载时触发标题生成，
  // 需等用户首次真实输入后再由 markAutoTitleCandidate 检测增量触发
  if (/^（/.test(currentTitle)) return;
  const hasAssistant = Array.isArray(currentMessages)
    && currentMessages.some(function(m) { return m && m.role === 'assistant'; });
  // 要求至少有一条 user 消息，排除 runtime 初始化或会话切换残留导致的误触发
  var hasUserMessage = Array.isArray(currentMessages)
    && currentMessages.some(function(m) { return m && m.role === 'user'; });
  if (hasAssistant && hasUserMessage) {
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
  var ac = a.toolCalls, bc = b.toolCalls;
  var acLen = ac ? ac.length : 0;
  var bcLen = bc ? bc.length : 0;
  if (acLen !== bcLen) return false;
  for (var j = 0; j < acLen; j++) {
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
    return;
  }

  // For the current session, verify the latest message is a completed assistant response
  if (messages) {
    var latestMessage = messages[messages.length - 1];
    if (!latestMessage || latestMessage.role !== 'assistant' || !String(latestMessage.content || '').trim()) return;
  }

  // Prevent concurrent calls for the same session.
  // autoGenerateSessionTitle handles all retries internally.
  if (_autoTitleTriggered.has(sessionId)) return;

  _autoTitleTriggered.add(sessionId);

  // Fire and forget — don't block the poll loop
  autoGenerateSessionTitle(agent.id, sessionId);
}

function tryAutoTitleGeneration(messages) {
  if (!currentRuntimeAgentId || !currentAgentId) return;

  var info = getAutoTitleSessionInfo();

  // 1. Try the currently-viewed session
  if (info && _autoTitlePending.has(info.sessionId)) {
    var currentTitle = String(info.agent.active_workspace_session_title || '').trim();
    _tryTitleForSession(info.agent, info.sessionId, currentTitle, messages);
  }

  // 2. Scan other pending sessions whose runtimes are idle.
  //    This covers sessions the user switched away from before the title
  //    could be generated.
  var pendingIds = Array.from(_autoTitlePending);
  for (var i = 0; i < pendingIds.length; i++) {
    var pendingId = pendingIds[i];
    if (info && pendingId === info.sessionId) continue; // already handled above

    var owner = _findSessionOwner(pendingId);
    if (!owner) {
      // Session no longer exists in any agent — clean up
      _autoTitlePending.delete(pendingId);
      _autoTitleTriggered.delete(pendingId);
      continue;
    }

    // Only trigger if the owning runtime is idle (assistant finished responding)
    if (typeof isRuntimeCalling === 'function' && isRuntimeCalling(owner.runtimeId)) continue;

    _tryTitleForSession(owner.agent, pendingId, owner.title, null);
  }
}

var AUTO_TITLE_MAX_ATTEMPTS = 3;
var AUTO_TITLE_RETRY_BACKOFF_MS = 5000;
// Must exceed server's 120s child-process timeout to avoid false-abort
var AUTO_TITLE_FETCH_TIMEOUT_MS = 125000;

/**
 * Generate a session title with internal retries.
 * Shows a single loading toast for the entire operation; retries are silent.
 * Only the final success or final failure updates the toast.
 */
async function autoGenerateSessionTitle(agentId, sessionId) {
  var succeeded = false;
  var lastError = null;
  const isZh = currentLanguage === 'zh';
  const toastId = 'title-auto-' + sessionId;

  ClawToast.show({
    id: toastId,
    title: isZh ? '正在生成会话标题...' : 'Generating session title...',
    status: 'loading',
  });

  for (var attempt = 1; attempt <= AUTO_TITLE_MAX_ATTEMPTS; attempt++) {
    var controller = new AbortController();
    var fetchTimer = setTimeout(function() { controller.abort(); }, AUTO_TITLE_FETCH_TIMEOUT_MS);

    try {
      var response = await fetch('/protoclaw/generate_session_title', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: agentId, sessionId: sessionId }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }
      var result = await response.json();
      if (result.ok && result.title) {
        // Update local data
        var agent = typeof getCurrentAgentRecord === 'function' ? getCurrentAgentRecord() : null;
        if (agent) {
          var sessions = agent.workspace_sessions && agent.workspace_sessions.sessions || [];
          var target = sessions.find(function(s) { return s.id === sessionId; });
          if (target) target.title = result.title;
          if (String(agent.active_workspace_session_id || '') === String(sessionId)) {
            agent.active_workspace_session_title = result.title;
          }
        }
        console.log('[AutoTitle] title set:', result.title);
        succeeded = true;
        ClawToast.update(toastId, {
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
      var isAbort = error && error.name === 'AbortError';
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
    var isAbort = lastError && lastError.name === 'AbortError';
    ClawToast.update(toastId, {
      status: 'warning',
      title: isZh ? '标题自动生成未成功' : 'Auto title generation unsuccessful',
      description: isAbort
        ? (isZh ? '请求超时' : 'Request timed out')
        : (lastError ? (lastError.message || String(lastError)) : 'Unknown error'),
    });
  }

  _autoTitleTriggered.delete(sessionId);
  _autoTitlePending.delete(sessionId);
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
