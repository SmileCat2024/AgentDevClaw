/**
 * ctx-menu-items.js — 右键菜单项构建与分发（从 app-main.js 域 W 提取）
 * 拆出日期：2026-07-04
 *
 * 包含：
 *   - getCtxMenuItems: 菜单项声明表（runtime / session 角色）
 *   - ctxRestartAgent: 重启 Agent
 *   - ctxStopAgent: 关闭 Agent
 *   - ctxArchiveAndStopRuntime: 归档会话并关闭 runtime
 *   - ctxGenerateTitle: AI 生成标题
 *   - ctxArchiveSession: 归档/取消归档会话
 *   - archiveSessionAfterMutation: 变更后归档原会话（被 runWorkspaceAction 调用）
 *   - ctxTodoSession: 设置/取消待办
 *   - dispatchCtxAction: 菜单动作分发器
 *
 * 依赖全局状态（定义在 app-core.js）:
 *   allAgents, currentLanguage, currentRuntimeAgentId, restartingRuntimeIds,
 *   suppressSidebarRerender, lastRenderedWorkspaceHtml
 * 依赖 app-ui.js:
 *   getWorkspaceSessionById, getWorkspaceSessions, updateAgentRecord,
 *   renderCurrentMainView, selectWorkspaceSurface, resolveWorkspaceFallbackAgentId
 * 依赖 app-main.js:
 *   renderAgentList, requestSwitch, loadAgents, runWorkspaceAction (via window),
 *   switchAgent (via window), getCurrentAgentRecord
 * 依赖 external-runtime.js:
 *   getExternalRuntimeAgent, restartSidebarExternalRuntime,
 *   closeSidebarExternalRuntime, refreshSidebarRuntimeAfterMutation,
 *   clearAgentRuntimeCache
 * 依赖 context-menu.js:
 *   closeCtxMenu (via window), showCtxMenu (via window)
 * 依赖 session-dialogs.js:
 *   openTrimDialog (via window), openBranchDialog (via window)
 */
/* ══════════════════════════════════════
   Generic ctx-menu: declaration table + dispatcher
   ══════════════════════════════════════ */

function getCtxMenuItems(role, ns, variant, id) {
  if (role === 'runtime' && ns === 'programming-helper') {
    const isZh = currentLanguage === 'zh';
    const agent = allAgents.find((item) => item.id === ns) || null;
    const activeSessionId = agent?.workspace_sessions?.activeSessionId;
    const activeSession = activeSessionId ? getWorkspaceSessionById(agent, activeSessionId) : null;
    const isArchived = activeSession?.archived === true;
    return [
      { label: isZh ? 'AI 生成标题' : 'AI Generate Title', action: 'generate-title' },
      { label: isZh ? '总结历史（摘要）' : 'Summary', submenu: [
        { label: isZh ? '仅摘要' : 'Summary Only', action: 'summary' },
        { label: isZh ? '摘要并归档原会话' : 'Summary & Archive', action: 'summary-and-archive' },
      ]},
      { label: isZh ? '精简历史（Trim）' : 'Trim', submenu: [
        { label: isZh ? '仅精简' : 'Trim Only', action: 'trim' },
        { label: isZh ? '精简并归档原会话' : 'Trim & Archive', action: 'trim-and-archive' },
      ]},
      { label: isZh ? '创建分支' : 'Branch', submenu: [
        { label: isZh ? '仅分支' : 'Branch Only', action: 'branch' },
        { label: isZh ? '分支并归档原会话' : 'Branch & Archive', action: 'branch-and-archive' },
      ]},
      { type: 'separator' },
      { label: isArchived ? (isZh ? '取消归档' : 'Unarchive') : (isZh ? '归档会话' : 'Archive Session'), action: 'archive-and-stop' },
      { label: isZh ? '重启 Agent' : 'Restart Agent', action: 'restart' },
      { label: isZh ? '关闭 Agent' : 'Stop Agent', action: 'stop', danger: true },
    ];
  }
  if (role === 'session' && ns === 'programming-helper') {
    const agent = allAgents.find((item) => item.id === ns) || null;
    const session = getWorkspaceSessionById(agent, id);
    const sType = variant || 'main';
    const isArchived = sType === 'archived' || session?.archived === true;
    const isTodo = session?.todo === true;
    const isExplorationOrSub = sType === 'exploration' || sType === 'sub';
    const isZh = currentLanguage === 'zh';

    const items = [];

    // AI Generate Title
    items.push({ label: isZh ? 'AI 生成标题' : 'AI Generate Title', action: 'generate-title' });

    // Summary / Trim / Branch — only for main/archived sessions
    if (!isExplorationOrSub) {
      if (isArchived) {
        // Archived: no need for "archive original" option, flatten to direct items
        items.push({ label: isZh ? '总结历史（摘要）' : 'Summary', action: 'summary' });
        items.push({ label: isZh ? '精简历史（Trim）' : 'Trim', action: 'trim' });
        items.push({ label: isZh ? '创建分支' : 'Branch', action: 'branch' });
      } else {
        items.push({ label: isZh ? '总结历史（摘要）' : 'Summary', submenu: [
          { label: isZh ? '仅摘要' : 'Summary Only', action: 'summary' },
          { label: isZh ? '摘要并归档原会话' : 'Summary & Archive', action: 'summary-and-archive' },
        ]});
        items.push({ label: isZh ? '精简历史（Trim）' : 'Trim', submenu: [
          { label: isZh ? '仅精简' : 'Trim Only', action: 'trim' },
          { label: isZh ? '精简并归档原会话' : 'Trim & Archive', action: 'trim-and-archive' },
        ]});
        items.push({ label: isZh ? '创建分支' : 'Branch', submenu: [
          { label: isZh ? '仅分支' : 'Branch Only', action: 'branch' },
          { label: isZh ? '分支并归档原会话' : 'Branch & Archive', action: 'branch-and-archive' },
        ]});
      }
    }

    items.push({ type: 'separator' });

    // TODO toggle — non-archived only
    if (!isArchived) {
      items.push({ label: isTodo ? (isZh ? '取消待办' : 'Remove TODO') : (isZh ? '设为待办' : 'Set as TODO'), action: 'todo-session' });
    }

    // Archive / Unarchive
    items.push({ label: isArchived ? (isZh ? '取消归档' : 'Unarchive') : (isZh ? '归档会话' : 'Archive'), action: 'archive-session' });

    // Delete
    items.push({ label: isZh ? '删除对话' : 'Delete', action: 'delete-session', danger: true });

    return items;
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

async function ctxArchiveAndStopRuntime(target) {
  const { ns: agentId, id: runtimeId, sessionId, variant } = target;
  if (!agentId || !sessionId) return;

  // Check if session is already archived → toggle to unarchive (no stop)
  const agent = allAgents.find((item) => item.id === agentId) || null;
  const currentSession = getWorkspaceSessionById(agent, sessionId);
  const alreadyArchived = currentSession?.archived === true;

  if (alreadyArchived) {
    // Unarchive only
    if (agent) {
      const currentSessions = getWorkspaceSessions(agent);
      const updatedSessions = currentSessions.map((s) =>
        s.id === sessionId ? { ...s, archived: false } : s,
      );
      updateAgentRecord(agentId, {
        workspace_sessions: { sessions: updatedSessions, activeSessionId: agent?.workspace_sessions?.activeSessionId },
      });
    }
    try {
      const response = await fetch('/protoclaw/prebuilt_sessions/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, sessionId, archived: false }),
      });
      if (!response.ok) {
        throw new Error(await response.text().catch(() => 'unarchive session failed'));
      }
      const result = await response.json();
      if (result?.sessions) {
        updateAgentRecord(agentId, {
          workspace_sessions: result.sessions,
          active_workspace_session_id: result.activeSessionId || null,
        });
      }
    } catch (e) {
      // Revert optimistic unarchive on failure
      if (agent) {
        const currentSessions = getWorkspaceSessions(agent);
        const revertedSessions = currentSessions.map((s) =>
          s.id === sessionId ? { ...s, archived: true } : s,
        );
        updateAgentRecord(agentId, {
          workspace_sessions: { sessions: revertedSessions, activeSessionId: agent?.workspace_sessions?.activeSessionId },
        });
      }
      window.alert((currentLanguage === 'zh' ? '取消归档失败：' : 'Failed to unarchive session: ') + (e?.message || e));
    }
    return;
  }

  // 1. Archive the session first (optimistic + API)
  if (agent) {
    const currentSessions = getWorkspaceSessions(agent);
    const updatedSessions = currentSessions.map((s) =>
      s.id === sessionId ? { ...s, archived: true } : s,
    );
    updateAgentRecord(agentId, {
      workspace_sessions: { sessions: updatedSessions, activeSessionId: agent?.workspace_sessions?.activeSessionId },
    });
  }

  try {
    const response = await fetch('/protoclaw/prebuilt_sessions/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, sessionId, archived: true }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'archive session failed'));
    }
    const result = await response.json();
    if (result?.sessions) {
      updateAgentRecord(agentId, {
        workspace_sessions: result.sessions,
        active_workspace_session_id: result.activeSessionId || null,
      });
    }
  } catch (e) {
    // Revert optimistic archive on failure, then alert
    if (agent) {
      const currentSessions = getWorkspaceSessions(agent);
      const revertedSessions = currentSessions.map((s) =>
        s.id === sessionId ? { ...s, archived: false } : s,
      );
      updateAgentRecord(agentId, {
        workspace_sessions: { sessions: revertedSessions, activeSessionId: agent?.workspace_sessions?.activeSessionId },
      });
    }
    window.alert((currentLanguage === 'zh' ? '归档会话失败：' : 'Failed to archive session: ') + (e?.message || e));
    return;
  }

  // 2. Stop the agent runtime (same logic as ctxStopAgent)
  const serverAgentId = (variant === 'managed-runtime') ? agentId : runtimeId;
  const externalAgent = getExternalRuntimeAgent(serverAgentId);
  const affectedRuntimeId = runtimeId || externalAgent?.runtime_session_id || externalAgent?.runtimeSessionId || externalAgent?.id || null;
  try {
    if (affectedRuntimeId) clearAgentRuntimeCache(affectedRuntimeId);
    if (variant === 'external') {
      await closeSidebarExternalRuntime(externalAgent);
    } else if (variant === 'child') {
      const hostId = externalAgent?.parent_id || serverAgentId;
      const sId = sessionId || externalAgent?.active_workspace_session_id || null;
      await invoke('stop_agent', { agentId: hostId, sessionId: sId });
    } else {
      const sId = sessionId || externalAgent?.active_workspace_session_id || null;
      await invoke('stop_agent', { agentId: serverAgentId, sessionId: sId });
    }
    await refreshSidebarRuntimeAfterMutation(500);
    // 3. Switch to workspace surface so user sees the updated session list
    if (affectedRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
      selectWorkspaceSurface(agentId);
    }
  } catch (e) {
    // Session archived successfully but stop failed — still surface the error
    window.alert(t('close_failed') + (e && e.message ? e.message : e));
  }
}

async function ctxGenerateTitle(target) {
  const { ns, sessionId } = target;
  const isZh = currentLanguage === 'zh';
  const toastId = 'title-gen-' + sessionId;
  ClawToast.show({
    id: toastId,
    title: isZh ? '正在生成标题...' : 'Generating title...',
    status: 'loading',
  });
  try {
    const response = await fetch('/protoclaw/generate_session_title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: ns, sessionId }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'Failed to generate title'));
    }
    const result = await response.json();
    if (result.ok && result.title) {
      const agent = allAgents.find((item) => item.id === ns);
      if (agent) {
        const sessions = agent.workspace_sessions?.sessions || [];
        const targetSession = sessions.find((s) => s.id === sessionId);
        if (targetSession) targetSession.title = result.title;
        if (agent.active_workspace_session_id === sessionId) {
          updateAgentRecord(ns, { active_workspace_session_title: result.title });
        }
      }
      renderAgentList();
      ClawToast.update(toastId, {
        status: 'success',
        title: isZh ? '标题已生成' : 'Title generated',
        description: result.title,
      });
    } else {
      ClawToast.update(toastId, {
        status: 'error',
        title: isZh ? '生成标题失败' : 'Title generation failed',
        description: isZh ? '服务器未返回有效标题' : 'Server returned no valid title',
      });
    }
  } catch (error) {
    console.error('Failed to generate session title:', error);
    ClawToast.update(toastId, {
      status: 'error',
      title: isZh ? '生成标题失败' : 'Title generation failed',
      description: error.message || String(error),
    });
  }
}

async function ctxArchiveSession(target) {
  const { ns: agentId, id: sessionId } = target;
  if (!agentId || !sessionId) return;

  const agent = allAgents.find((item) => item.id === agentId) || null;
  const session = getWorkspaceSessionById(agent, sessionId);
  const nextArchived = !(session?.archived === true);

  // Optimistic update
  if (agent) {
    const currentSessions = getWorkspaceSessions(agent);
    const updatedSessions = currentSessions.map((s) =>
      s.id === sessionId ? { ...s, archived: nextArchived } : s,
    );
    updateAgentRecord(agentId, {
      workspace_sessions: { sessions: updatedSessions, activeSessionId: agent?.active_workspace_session_id },
    });
    renderCurrentMainView();
  }

  try {
    const response = await fetch('/protoclaw/prebuilt_sessions/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, sessionId, archived: nextArchived }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'archive session failed'));
    }
    const result = await response.json();
    if (result?.sessions) {
      updateAgentRecord(agentId, {
        workspace_sessions: result.sessions,
        active_workspace_session_id: result.activeSessionId || null,
      });
    }
    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
  } catch (e) {
    // Revert on failure
    if (agent) {
      const currentSessions = getWorkspaceSessions(agent);
      const revertedSessions = currentSessions.map((s) =>
        s.id === sessionId ? { ...s, archived: !nextArchived } : s,
      );
      updateAgentRecord(agentId, {
        workspace_sessions: { sessions: revertedSessions, activeSessionId: agent?.active_workspace_session_id },
      });
    }
    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
    window.alert((currentLanguage === 'zh' ? '归档会话失败：' : 'Failed to archive session: ') + (e?.message || e));
  }
}

/**
 * Archive a session (set archived=true) AND stop its runtime.
 * Used after summary/trim/branch creates a new session, to archive + close the original.
 * Silent on success, logs on failure — the primary operation already succeeded.
 */
async function archiveSessionAfterMutation(agentId, sessionId, oldRuntimeId) {
  if (!agentId || !sessionId) return;

  // 1. Archive the session (optimistic + API)
  const agent = allAgents.find((item) => item.id === agentId) || null;
  if (agent) {
    const currentSessions = getWorkspaceSessions(agent);
    const updatedSessions = currentSessions.map((s) =>
      s.id === sessionId ? { ...s, archived: true } : s,
    );
    updateAgentRecord(agentId, {
      workspace_sessions: { sessions: updatedSessions, activeSessionId: agent?.active_workspace_session_id },
    });
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
    }
  } catch (e) {
    console.error('Failed to archive session after mutation:', e);
    return; // Don't proceed to stop if archive failed
  }

  // 2. Stop the original session's runtime (same as ctxArchiveAndStopRuntime)
  try {
    if (oldRuntimeId) clearAgentRuntimeCache(oldRuntimeId);
    await invoke('stop_agent', { agentId, sessionId });
    await refreshSidebarRuntimeAfterMutation(500);
  } catch (e) {
    console.error('Failed to stop runtime after archive:', e);
  }

  lastRenderedWorkspaceHtml = '';
  renderCurrentMainView();
}

async function ctxTodoSession(target) {
  const { ns: agentId, id: sessionId } = target;
  if (!agentId || !sessionId) return;

  const agent = allAgents.find((item) => item.id === agentId) || null;
  const session = getWorkspaceSessionById(agent, sessionId);
  const nextTodo = !(session?.todo === true);

  // Optimistic update
  if (agent) {
    const currentSessions = getWorkspaceSessions(agent);
    const updatedSessions = currentSessions.map((s) =>
      s.id === sessionId ? { ...s, todo: nextTodo } : s,
    );
    updateAgentRecord(agentId, {
      workspace_sessions: { sessions: updatedSessions, activeSessionId: agent?.active_workspace_session_id },
    });
    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
  }

  try {
    const response = await fetch('/protoclaw/prebuilt_sessions/todo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, sessionId, todo: nextTodo }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'todo session failed'));
    }
    const result = await response.json();
    if (result?.sessions) {
      updateAgentRecord(agentId, {
        workspace_sessions: result.sessions,
        active_workspace_session_id: result.activeSessionId || null,
      });
    }
    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
  } catch (e) {
    // Revert on failure
    if (agent) {
      const currentSessions = getWorkspaceSessions(agent);
      const revertedSessions = currentSessions.map((s) =>
        s.id === sessionId ? { ...s, todo: !nextTodo } : s,
      );
      updateAgentRecord(agentId, {
        workspace_sessions: { sessions: revertedSessions, activeSessionId: agent?.active_workspace_session_id },
      });
    }
    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
    window.alert((currentLanguage === 'zh' ? '设置待办失败：' : 'Failed to set todo: ') + (e?.message || e));
  }
}

function dispatchCtxAction(action, target) {
  if (!action || !target) return;
  const { ns, id, sessionId, variant } = target;
  // For session role, sessionId may not be set — fall back to id
  const sid = sessionId || id;

  switch (action) {
    case 'activate':
      window.switchAgent(id);
      break;

    case 'generate-title':
      window.closeCtxMenu();
      if (ns && sid) {
        ctxGenerateTitle({ ...target, sessionId: sid });
      }
      break;

    case 'summary':
      if (ns && sid) {
        window.runWorkspaceAction(JSON.stringify({ type: 'compact_session_menu', sessionId: sid, compactType: 'summary' }));
      }
      break;

    case 'summary-and-archive':
      if (ns && sid) {
        window.runWorkspaceAction(JSON.stringify({ type: 'compact_session_menu', sessionId: sid, compactType: 'summary', archiveOriginal: true }));
      }
      break;

    case 'trim':
      if (ns && sid) {
        window.openTrimDialog(ns, sid);
      }
      break;

    case 'trim-and-archive':
      if (ns && sid) {
        window.openTrimDialog(ns, sid, true);
      }
      break;

    case 'branch':
      if (ns && sid) {
        window.openBranchDialog(ns, sid);
      }
      break;

    case 'branch-and-archive':
      if (ns && sid) {
        window.openBranchDialog(ns, sid, true);
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

    case 'archive-session':
      window.closeCtxMenu();
      ctxArchiveSession(target);
      break;

    case 'archive-and-stop':
      window.closeCtxMenu();
      ctxArchiveAndStopRuntime(target);
      break;

    case 'todo-session':
      window.closeCtxMenu();
      ctxTodoSession(target);
      break;

    default:
      console.warn('Unknown ctx-menu action:', action, target);
  }
}
