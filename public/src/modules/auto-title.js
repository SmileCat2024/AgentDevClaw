/**
 * auto-title.js — 壳层自动标题（历史实现，已硬屏蔽）＋ 会话视图工具
 * 从 app-main.js 拆出（Phase A-3）
 * 拆出日期：2026-07-03
 *
 * 本文件现在包含两类内容，命运不同：
 *
 *   1. 会话视图工具 —— 仍在用。`_messagesEqual`、`findFirstChangedMessageIndex`
 *      服务于消息增量渲染；`checkGlobalChoiceAlerts` 服务于跨会话选择告警。
 *   2. 自动标题生成 —— 历史实现，被 isShellTitleTriggerDisabled() 硬屏蔽，
 *      入口不可达。**标题由应用自己的 AutoTitlePolicyFeature 生成**（ADR-0041）。
 *
 * 依赖全局状态（定义在 app-core.js）:
 *   currentRuntimeAgentId, focusedAgentId, currentLanguage,
 *   allAgents, _autoTitleTriggered, _seenChoiceAlertIds, _lastChoiceAlertCheckAt
 *   getLogicalAgentId (app-core.js)
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
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 重要：本文件下半部分的「自动标题生成」是 ADR-0041 之前的历史实现，已被
 * 硬屏蔽（hard-disabled）。代码保留只作为历史行为参照，不参与运行。
 *
 * 现行归属：标题策略属于应用。应用在 metadata 声明 `titlePolicy: 'app'`，
 * 并在 agent.js 装配 AutoTitlePolicyFeature 订阅轮次事件，自行决定何时、
 * 用什么提示词、选什么模型。壳层若同时触发，同一会话会被两条链路各起一次名。
 *
 * 所有对外入口都在产生任何副作用之前返回，判定见
 * isShellTitleTriggerDisabled()。不要为了「让某个应用也能自动命名」而改
 * 那里的开关——正确做法是给该应用装配 AutoTitlePolicyFeature
 * （local-features/auto-title-policy）。契约由
 * test/frontend-auto-title-legacy-disabled.test.js 守住。
 * ══════════════════════════════════════════════════════════════════════════
 */

// ── 幂等键（ADR-0011）：写类提交统一携带（本地忽略、远程强制）───────────
function newIdempotencyKey() {
  const cryptoObj = (typeof crypto !== 'undefined') ? crypto : null;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── Auto session title generation ──────────────────────────────────────────

/**
 * 壳层自动标题的**硬屏蔽开关**（ADR-0041）。
 *
 * 值恒为 true。它不是配置项、不是 feature flag：没有环境变量、没有 window
 * 开关、没有 metadata 声明可以让它变回 false。要恢复壳层触发必须是显式改动
 * 这里的返回值——那是一次可见的代码改动，而不是一次「配置一下就悄悄回来了」。
 *
 * 三个导出入口（markAutoTitleCandidate / recheckAutoTitleCandidate /
 * tryAutoTitleGeneration）以及真正产生副作用的 autoGenerateSessionTitle，
 * 都在任何副作用之前调用它并直接返回，因此即便有调用方残留或新增，也不会
 * 登记候选、不会发请求、不会写标题。
 */
function isShellTitleTriggerDisabled() {
  return true;
}

const _autoTitlePending = new Set();

/**
 * 标题候选判定（ADR-0041）：是否还需要起名，只看结构化 titleState，不再匹配
 * 标题文案。三种情况必须区分，混为一谈会造成两类错误：
 *
 *   placeholder           — 占位，等应用策略起名 → 候选
 *   auto / user           — 已有标题（生成 / 用户改名）→ 不再自动生成
 *   字段在、值未知        — 改造前的历史记录，来源无法判定 → 不生成（不猜文案）
 *   连索引记录都还没拿到  — 快照暂缺，不代表会话没有状态 → 保留候选，等下一轮
 *
 * 最后一种只是观测时机问题：connected-agents 快照可能在 head 创建/接续时暂缺
 * 该会话的索引投影。此时按"未知"直接判否会让新会话永久拿不到标题，因此延后
 * 判定而不是放弃。
 */
function isPlaceholderTitleState(titleState) {
  return String(titleState || '').trim() === 'placeholder';
}

/**
 * 候选三态判定：'candidate' | 'settled' | 'unknown'。
 *   candidate — 占位，等待生成
 *   settled   — 已有标题或来源未知，不再自动生成
 *   unknown   — 快照里还没有该会话记录，保持待判，下一轮再试
 */
function titleCandidateState(sessionKnown, titleState) {
  if (!sessionKnown) return 'unknown';
  return isPlaceholderTitleState(titleState) ? 'candidate' : 'settled';
}

function getAutoTitleSessionInfo() {
  // 线程会话的标题真源是 head Session 索引记录。connected-agents 快照在
  // head 创建/接续时可能暂缺 active_workspace_session_title；使用 host 的
  // session index 记录标题与 titleState（正文不用它做判定，仅供展示），不让
  // 空 runtime 投影屏蔽占位会话的候选判断。
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
      if (sessionId) {
        // Runtime child records own the live session projection, but server
        // session routes are scoped by the logical workspace agent.
        const logicalAgentId = typeof getLogicalAgentId === 'function'
          ? getLogicalAgentId(runtimeAgent)
          : String(runtimeAgent.parent_id || '').trim();
        const hostAgent = allAgents.find(function(a) {
          return normalizeAgentIdentity(a && a.id) === logicalAgentId;
        }) || null;
        const session = hostAgent?.workspace_sessions?.sessions?.find(function(s) {
          return s && String(s.id || '').trim() === sessionId;
        });
        const title = String(runtimeAgent.active_workspace_session_title || session?.title || '').trim();
        return {
          agent: runtimeAgent,
          agentId: logicalAgentId || runtimeAgent.id,
          sessionId,
          title,
          // sessionKnown=false 表示快照里还没有该会话的索引记录（标题与状态都
          // 未知），与"记录在但 titleState 缺失"是两回事，调用方要分开处理。
          sessionKnown: !!session,
          titleState: session?.titleState || '',
        };
      }
    }
  }
  // Fallback: 使用 host agent
  const agent = getCurrentAgentRecord();
  if (!agent) return null;
  const sessionId = String(agent.active_workspace_session_id || agent.workspace_sessions?.activeSessionId || '').trim();
  if (!sessionId) return null;
  const hostSessions = agent.workspace_sessions?.sessions;
  const hostSession = Array.isArray(hostSessions)
    ? hostSessions.find(function(s) { return s && String(s.id || '').trim() === sessionId; })
    : null;
  return {
    agent,
    agentId: agent.id,
    sessionId,
    title: String(agent.active_workspace_session_title || hostSession?.title || '').trim(),
    sessionKnown: !!hostSession,
    titleState: hostSession?.titleState || '',
  };
}

/**
 * 该应用是否已自行接管标题策略（ADR-0041）—— **历史实现，已不参与运行**。
 *
 * 曾用于让壳层对已声明 `titlePolicy: 'app'` 的应用让位。现在壳层整体硬屏蔽
 * （见 isShellTitleTriggerDisabled），本判定与 isValidTitleEvent 都不可达，
 * 保留仅为理解迁移过程。
 *
 * 不要用「只对未声明应用生效」的方式复活这段逻辑：迁移已全部完成，
 * 三个对话型应用都装配了 AutoTitlePolicyFeature；新应用应同样装配，
 * 而不是回落到壳层触发。
 */
function isAppOwnedTitlePolicy(agentRecord) {
  if (!agentRecord || typeof agentRecord !== 'object') return false;
  return String(agentRecord.titlePolicy || '').trim() === 'app';
}

function isValidTitleEvent(info) {
  const agentRecord = (info && info.agent) || {};
  const hostAgent = allAgents.find(function(a) {
    return normalizeAgentIdentity(a && a.id) === normalizeAgentIdentity(info.agentId);
  });
  return !isAppOwnedTitlePolicy(agentRecord) && !isAppOwnedTitlePolicy(hostAgent);
}

function markAutoTitleCandidate(previousMessages, nextMessages) {
  // ADR-0041：壳层自动标题已硬屏蔽，不再登记任何候选。
  if (isShellTitleTriggerDisabled()) return;
  const info = getAutoTitleSessionInfo();
  if (!info) return;
  if (!isValidTitleEvent(info)) return;
  // 状态未知（快照暂缺记录）时也登记候选：待下一轮标题状态可见再定去留，
  // 否则新会话会因一次投影延迟永久失去自动标题。
  if (titleCandidateState(info.sessionKnown, info.titleState) === 'settled') return;
  const previousAssistantCount = previousMessages.filter(function(message) {
    return message && message.role === 'assistant';
  }).length;
  const nextAssistantCount = nextMessages.filter(function(message) {
    return message && message.role === 'assistant';
  }).length;
  if (previousAssistantCount === 0 && nextAssistantCount > 0) {
    const hasUserMessage = nextMessages.some(function(m) { return m && m.role === 'user'; });
    if (hasUserMessage) {
      _autoTitlePending.add(info.sessionId);
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
  // ADR-0041：壳层自动标题已硬屏蔽，不再登记任何候选。
  if (isShellTitleTriggerDisabled()) return;
  const info = getAutoTitleSessionInfo();
  if (!info) return;
  if (!isValidTitleEvent(info)) return;
  if (titleCandidateState(info.sessionKnown, info.titleState) === 'settled') return;
  const { sessionId } = info;

  const currentAC = Array.isArray(currentMessages)
    ? currentMessages.filter(function(m) { return m && m.role === 'assistant'; }).length
    : 0;

  const hasUserMessage = Array.isArray(currentMessages)
    && currentMessages.some(function(m) { return m && m.role === 'user'; });
  if (currentAC > 0 && hasUserMessage) {
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
  if (JSON.stringify(a.images || []) !== JSON.stringify(b.images || [])) return false;
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
        titleState: session.titleState || '',
      };
    }
  }
  return null;
}

/**
 * Attempt title generation for a single session after all guard checks pass.
 * @param agent  - agent record (must have .id)
 * @param sessionId
 * @param sessionTitle - current title text (display only, never a condition)
 * @param titleState - structured title state from the session index (ADR-0041)
 * @param messages - current session's messages array (null for non-current sessions)
 */
function _tryTitleForSession(agent, sessionId, sessionTitle, titleState, sessionKnown, messages) {
  const state = titleCandidateState(sessionKnown, titleState);
  if (state === 'settled') {
    _autoTitlePending.delete(sessionId);
    return;
  }
  // 'unknown' 时保留候选，等索引投影到达后由下一轮 tryAutoTitleGeneration 处理。
  if (state !== 'candidate') return;

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

  // Fire and forget — don't block the poll loop
  const logicalAgentId = typeof getLogicalAgentId === 'function'
    ? getLogicalAgentId(agent)
    : String(agent.parent_id || '').trim();
  autoGenerateSessionTitle(logicalAgentId || agent.id, sessionId, !!messages);
}

function tryAutoTitleGeneration(messages) {
  // ADR-0041：壳层自动标题已硬屏蔽——不扫候选、不发请求。
  // 应用自行装配 AutoTitlePolicyFeature 决定何时生成。
  if (isShellTitleTriggerDisabled()) return;
  if (!currentRuntimeAgentId || !focusedAgentId) return;

  const info = getAutoTitleSessionInfo();

  // 已自行接管标题策略的应用（metadata `titlePolicy: 'app'`）由它自己的
  // Feature 触发生成，壳层不再介入；这里也清掉可能残留的候选登记。
  if (info && !isValidTitleEvent(info)) {
    _autoTitlePending.delete(info.sessionId);
    _autoTitleTriggered.delete(info.sessionId);
    return;
  }

  // 1. Try the currently-viewed session
  if (info && _autoTitlePending.has(info.sessionId)) {
    const currentTitle = info.title || String(info.agent.active_workspace_session_title || '').trim();
    _tryTitleForSession(info.agent, info.sessionId, currentTitle, info.titleState, info.sessionKnown, messages);
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
      continue;
    }

    // Only trigger if the owning runtime is idle (assistant finished responding)
    if (typeof isRuntimeCalling === 'function' && isRuntimeCalling(owner.runtimeId)) continue;

    _tryTitleForSession(owner.agent, pendingId, owner.title, owner.titleState, true, null);
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
  // ADR-0041：真正的副作用（网络请求 + 标题落盘）在这里，同样硬屏蔽。
  // 三个上游入口已返回，这里是第二道闸，覆盖直接调用本函数的情况。
  if (isShellTitleTriggerDisabled()) return;
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
        headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
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
          if (target) {
            target.title = result.title;
            // 服务端拒绝覆盖用户改名时回传用户的名字，此时状态仍是 user。
            target.titleState = result.titleUnchanged === true ? 'user' : 'auto';
          }
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
}

/**
 * Global choice-request alert check: polls the server for choice-type
 * input requests across ALL connected agents (not just the focused one).
 * Shows a ClawToast warning for each newly discovered request so the user
 * is alerted even when viewing a different conversation.
 *
 * Note: Desktop notifications for choice requests are driven by the server's
 * app-notification SSE frame (unified notification outlet, ADR-0030;
 * presented by desktop-notify.js). This separation is intentional.
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
