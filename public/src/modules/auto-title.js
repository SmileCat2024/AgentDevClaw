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
 * 导出全局函数:
 *   getAutoTitleSessionInfo, markAutoTitleCandidate, _messagesEqual,
 *   findFirstChangedMessageIndex, tryAutoTitleGeneration,
 *   autoGenerateSessionTitle, checkGlobalChoiceAlerts
 * 导出全局变量:
 *   _autoTitlePending, _autoTitleAttempts, _autoTitleRetryAt
 */

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
  const isZh = currentLanguage === 'zh';
  const toastId = 'title-auto-' + sessionId;
  ClawToast.show({
    id: toastId,
    title: isZh ? '正在生成会话标题...' : 'Generating session title...',
    status: 'loading',
  });
  try {
    var response = await fetch('/protoclaw/generate_session_title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: agentId, sessionId: sessionId }),
    });
    if (!response.ok) {
      console.warn('[AutoTitle] generation failed:', response.status);
      ClawToast.update(toastId, {
        status: 'error',
        title: isZh ? '标题生成失败' : 'Title generation failed',
        description: isZh ? ('HTTP ' + response.status) : ('HTTP ' + response.status),
      });
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
      ClawToast.update(toastId, {
        status: 'success',
        title: isZh ? '标题已生成' : 'Title generated',
        description: result.title,
      });
    } else {
      ClawToast.update(toastId, {
        status: 'error',
        title: isZh ? '标题生成失败' : 'Title generation failed',
        description: isZh ? '未返回有效标题' : 'No valid title returned',
      });
    }
  } catch (error) {
    console.warn('[AutoTitle] error:', error.message || error);
    ClawToast.update(toastId, {
      status: 'error',
      title: isZh ? '标题生成失败' : 'Title generation failed',
      description: error.message || String(error),
    });
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

/**
 * Global choice-request alert check: polls the server for choice-type
 * input requests across ALL connected agents (not just the focused one).
 * Shows a ClawToast warning for each newly discovered request so the user
 * is alerted even when viewing a different conversation.
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
