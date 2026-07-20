/**
 * session-mutation.js — 会话替换状态机（从 ctx-menu-items.js 提取）
 * 拆出日期：2026-07-13
 *
 * 当 summary / trim / branch 操作生成新会话并归档原会话时，
 * 这套状态机负责追踪 mutation 的生命周期，驱动侧栏渲染。
 *
 * 包含：
 *   - _sidebarOperations: 统一侧栏操作状态
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

function getSessionReplacementMutation(agentId, sessionId) {
  if (typeof findSidebarOperation !== 'function') return null;
  return findSidebarOperation((operation) => (
    operation.type === 'replacement'
    && operation.agentId === String(agentId || '').trim()
    && operation.sourceSessionId === String(sessionId || '').trim()
  ));
}

function beginSessionReplacementMutation(agentId, sessionId, kind = 'summary', options = {}) {
  if (!agentId || !sessionId) return null;
  const existing = getSessionReplacementMutation(agentId, sessionId);
  if (existing) finishSidebarOperation(existing.operationId, 'superseded');
  const agent = Array.isArray(allAgents) ? allAgents.find((item) => item.id === agentId) : null;
  const session = Array.isArray(agent?.workspace_sessions?.sessions)
    ? agent.workspace_sessions.sessions.find((item) => item.id === sessionId)
    : null;
  const sourceRuntime = Array.isArray(allAgents) ? allAgents.find((item) => (
    item?.source !== 'prebuilt'
    && String(item?.parent_id || '').trim() === String(agentId).trim()
    && String(item?.active_workspace_session_id || '').trim() === String(sessionId).trim()
  )) : null;
  const projectDir = String(options.projectDir || session?.openDirectory || '').trim();
  return beginSidebarOperation({
    operationId: options.operationId,
    type: 'replacement',
    kind,
    phase: 'generating',
    agentId,
    sourceSessionId: sessionId,
    sourceRuntimeId: options.sourceRuntimeId || sourceRuntime?.runtime_session_id || sourceRuntime?.runtimeSessionId || sourceRuntime?.id || '',
    projectDir,
    projectName: options.projectName || (projectDir && typeof getPathLeaf === 'function' ? getPathLeaf(projectDir) : ''),
    title: session?.title || '',
  });
}

function updateSessionReplacementMutation(agentId, sessionId, updates = {}) {
  const current = getSessionReplacementMutation(agentId, sessionId);
  if (!current) return null;
  return updateSidebarOperation(current.operationId, updates);
}

function clearSessionReplacementMutation(agentId, sessionId) {
  const current = getSessionReplacementMutation(agentId, sessionId);
  if (!current) return null;
  return finishSidebarOperation(current.operationId, 'settled');
}

function settleSessionReplacementMutation(agentId, sessionId, delayMs = 300, attemptsRemaining = 20) {
  const current = getSessionReplacementMutation(agentId, sessionId);
  if (!current) return;
  window.setTimeout(() => {
    void settleSidebarSourceOperation(current.operationId, {
      agentId,
      sessionId,
      attempts: Math.max(1, Number(attemptsRemaining) || 20),
      intervalMs: 300,
      lateReconcileAttempts: 1,
      lateReconcileDelayMs: 5000,
    });
  }, Math.max(0, delayMs));
}

function markSessionArchivedForMutation(agentId, sessionId, kind = 'summary') {
  if (!agentId || !sessionId) return;

  const agent = allAgents.find((item) => item.id === agentId) || null;
  if (!agent) return null;

  const currentSessions = getWorkspaceSessions(agent);
  const original = currentSessions.find((s) => s.id === sessionId) || null;
  if (!original) return null;

  const mutation = beginSessionReplacementMutation(agentId, sessionId, kind);

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

  const rollback = () => {
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
  rollback.operationId = mutation?.operationId || '';
  return rollback;
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
    const mutation = getSessionReplacementMutation(agentId, sessionId);
    const response = await fetch('/protoclaw/prebuilt_sessions/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId,
        sessionId,
        archived: true,
        responseMode: 'delta',
        operationId: mutation?.operationId || createSidebarOperationId('archive'),
      }),
    });
    if (!response.ok) throw new Error(await response.text().catch(() => 'archive session failed'));
    const result = await response.json();
    if (typeof applySessionMutationDelta === 'function') applySessionMutationDelta(agentId, result);
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
