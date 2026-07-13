/**
 * session-mutation.js — 会话替换状态机（从 ctx-menu-items.js 提取）
 * 拆出日期：2026-07-13
 *
 * 当 summary / trim / branch 操作生成新会话并归档原会话时，
 * 这套状态机负责追踪 mutation 的生命周期，驱动侧栏渲染。
 *
 * 包含：
 *   - _sessionReplacementMutations: Map 状态
 *   - getSessionReplacementMutation: 获取当前 mutation
 *   - beginSessionReplacementMutation: 开始 mutation
 *   - updateSessionReplacementMutation: 更新 mutation 阶段
 *   - clearSessionReplacementMutation: 清除 mutation
 *   - settleSessionReplacementMutation: 轮询确认 runtime 已消失后清除
 *   - markSessionArchivedForMutation: 乐观归档 + 返回回滚函数
 *   - archiveSessionAfterMutation: 归档原会话 + 停止 runtime
 *
 * 依赖全局状态（定义在 app-core.js）:
 *   allAgents, lastRenderedWorkspaceHtml, lastAgentListRenderSignature
 * 依赖 app-ui.js:
 *   getWorkspaceSessions, updateAgentRecord, renderCurrentMainView
 * 依赖 app-main.js:
 *   renderAgentList, loadAgents
 * 依赖 external-runtime.js:
 *   clearAgentRuntimeCache, refreshSidebarRuntimeAfterMutation
 * 依赖 app-core.js:
 *   invoke
 */

const _sessionReplacementMutations = new Map();

function getSessionReplacementMutation(agentId, sessionId) {
  return _sessionReplacementMutations.get(`${agentId}::${sessionId}`) || null;
}

function beginSessionReplacementMutation(agentId, sessionId, kind = 'summary') {
  if (!agentId || !sessionId) return null;
  const key = `${agentId}::${sessionId}`;
  const mutation = { agentId, sessionId, kind, phase: 'generating', startedAt: Date.now() };
  _sessionReplacementMutations.set(key, mutation);
  if (typeof lastAgentListRenderSignature !== 'undefined') lastAgentListRenderSignature = '';
  if (typeof renderAgentList === 'function') renderAgentList();
  return mutation;
}

function updateSessionReplacementMutation(agentId, sessionId, updates = {}) {
  const key = `${agentId}::${sessionId}`;
  const current = _sessionReplacementMutations.get(key);
  if (!current) return;
  _sessionReplacementMutations.set(key, { ...current, ...updates });
  if (typeof lastAgentListRenderSignature !== 'undefined') lastAgentListRenderSignature = '';
  if (typeof renderAgentList === 'function') renderAgentList();
}

function clearSessionReplacementMutation(agentId, sessionId) {
  if (!_sessionReplacementMutations.delete(`${agentId}::${sessionId}`)) return;
  if (typeof lastAgentListRenderSignature !== 'undefined') lastAgentListRenderSignature = '';
  if (typeof renderAgentList === 'function') renderAgentList();
}

function settleSessionReplacementMutation(agentId, sessionId, delayMs = 500, attemptsRemaining = 10) {
  window.setTimeout(async () => {
    try { await loadAgents(); } catch {}
    const oldRuntimeStillVisible = Array.isArray(allAgents) && allAgents.some((agent) => (
      agent?.source !== 'prebuilt'
      && String(agent?.parent_id || '').trim() === String(agentId).trim()
      && String(agent?.active_workspace_session_id || '').trim() === String(sessionId).trim()
      && agent?.connected !== false
    ));
    if (oldRuntimeStillVisible && attemptsRemaining > 1) {
      settleSessionReplacementMutation(agentId, sessionId, 300, attemptsRemaining - 1);
      return;
    }
    clearSessionReplacementMutation(agentId, sessionId);
  }, Math.max(0, delayMs));
}

function markSessionArchivedForMutation(agentId, sessionId, kind = 'summary') {
  if (!agentId || !sessionId) return;

  const agent = allAgents.find((item) => item.id === agentId) || null;
  if (!agent) return null;

  const currentSessions = getWorkspaceSessions(agent);
  const original = currentSessions.find((s) => s.id === sessionId) || null;
  if (!original) return null;

  beginSessionReplacementMutation(agentId, sessionId, kind);

  const nextSessions = currentSessions.map((s) =>
    s.id === sessionId ? { ...s, archived: true, todo: false } : s,
  );
  updateAgentRecord(agentId, {
    workspace_sessions: {
      ...(agent?.workspace_sessions || {}),
      sessions: nextSessions,
      activeSessionId: agent?.workspace_sessions?.activeSessionId || agent?.active_workspace_session_id || null,
    },
  });
  lastRenderedWorkspaceHtml = '';
  renderCurrentMainView();

  return () => {
    clearSessionReplacementMutation(agentId, sessionId);
    const latestAgent = allAgents.find((item) => item.id === agentId) || null;
    if (!latestAgent) return;
    const latestSessions = getWorkspaceSessions(latestAgent);
    const revertedSessions = latestSessions.map((s) =>
      s.id === sessionId ? { ...s, archived: original.archived === true, todo: original.todo === true } : s,
    );
    updateAgentRecord(agentId, {
      workspace_sessions: {
        ...(latestAgent?.workspace_sessions || {}),
        sessions: revertedSessions,
        activeSessionId: latestAgent?.workspace_sessions?.activeSessionId || latestAgent?.active_workspace_session_id || null,
      },
    });
    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
  };
}

/**
 * Archive a session (set archived=true) AND stop its runtime.
 * Used after summary/trim/branch creates a new session, to archive + close the original.
 * Silent on success, logs on failure — the primary operation already succeeded.
 */
async function archiveSessionAfterMutation(agentId, sessionId, oldRuntimeId, options = {}) {
  if (!agentId || !sessionId) return;

  // 1. Archive the session (optimistic + API)
  const agent = allAgents.find((item) => item.id === agentId) || null;
  const archiveRollback = typeof options.rollback === 'function'
    ? options.rollback
    : (!options.skipOptimisticArchive ? markSessionArchivedForMutation(agentId, sessionId) : null);
  if (options.skipOptimisticArchive && agent) {
    const currentSessions = getWorkspaceSessions(agent);
    const updatedSessions = currentSessions.map((s) =>
      s.id === sessionId ? { ...s, archived: true, todo: false } : s,
    );
    updateAgentRecord(agentId, {
      workspace_sessions: {
        ...(agent?.workspace_sessions || {}),
        sessions: updatedSessions,
        activeSessionId: agent?.workspace_sessions?.activeSessionId || agent?.active_workspace_session_id || null,
      },
    });
    // Render immediately so the user sees the archive without waiting for the
    // runtime stop + agent reload chain below.
    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
  }
  try {
    const response = await fetch('/protoclaw/prebuilt_sessions/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, sessionId, archived: true }),
    });
    if (!response.ok) throw new Error(await response.text().catch(() => 'archive session failed'));
    const result = await response.json();
    if (result?.sessions) {
      updateAgentRecord(agentId, {
        workspace_sessions: result.sessions,
        active_workspace_session_id: result.activeSessionId || null,
      });
      lastRenderedWorkspaceHtml = '';
      renderCurrentMainView();
    }
  } catch (e) {
    console.error('Failed to archive session after mutation:', e);
    // Revert optimistic update so the UI matches the server state.
    if (archiveRollback) {
      archiveRollback();
    } else if (agent) {
      const currentSessions = getWorkspaceSessions(agent);
      const revertedSessions = currentSessions.map((s) =>
        s.id === sessionId ? { ...s, archived: false } : s,
      );
      updateAgentRecord(agentId, {
        workspace_sessions: { ...(agent?.workspace_sessions || {}), sessions: revertedSessions, activeSessionId: agent?.workspace_sessions?.activeSessionId || agent?.active_workspace_session_id || null },
      });
      lastRenderedWorkspaceHtml = '';
      renderCurrentMainView();
    }
    return false; // Don't proceed to stop if archive failed
  }

  // 2. Stop the original session's runtime.
  //    The stop_agent API call is awaited (to ensure SIGTERM is sent), but the
  //    500ms blind delay + loadAgents refresh is fired in the background — the
  //    poll loop (300ms interval) will pick up the disconnected runtime status.
  //    This was previously a blocking await that caused visible UI lag after
  //    compact/trim/branch operations.
  try {
    if (oldRuntimeId) clearAgentRuntimeCache(oldRuntimeId);
    await invoke('stop_agent', { agentId, sessionId });
    refreshSidebarRuntimeAfterMutation();
  } catch (e) {
    console.error('Failed to stop runtime after archive:', e);
  }
  return true;
}
