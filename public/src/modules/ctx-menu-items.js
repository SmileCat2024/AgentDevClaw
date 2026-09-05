/**
 * ctx-menu-items.js — 右键菜单项构建与分发（从 app-main.js 域 W 提取）
 * 拆出日期：2026-07-04
 *
 * 包含：
 *   - getCtxMenuItems: 菜单项声明表（runtime / session 角色）
 *   - ctxRestartAgent: 重启 Agent
 *   - ctxStopAgent: 关闭 Agent
 *   - ctxArchiveAndStopRuntime: 归档会话并关闭 runtime
 *   - ctxRenameSession: 侧栏 runtime 项内联重命名
 *   - ctxGenerateTitle: AI 生成标题
 *   - ctxArchiveSession: 归档/取消归档会话
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
 * 依赖 assembly-data.js:
 *   isAssemblySession
 */
/* ══════════════════════════════════════
   Generic ctx-menu: declaration table + dispatcher
   ══════════════════════════════════════ */

// ── 幂等键（ADR-0011）：写类提交统一携带（本地忽略、远程强制）───────────
function newIdempotencyKey() {
  const cryptoObj = (typeof crypto !== 'undefined') ? crypto : null;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// Agents whose session items get the full session-ops ctx menu
// (summary / trim / branch). Server routes are agentId-parameterized;
// this list only gates the frontend menu surface.
// coder 不是独立 workspace agent：coder 会话并按 Thread 成员关系解析到宿主
// (programming-helper)，线程视图的入口走 CoderThreadsUI（自带动作），
// 不经过此处会话 ctx 菜单——因此不把 'coder' 列作会话操作 agent。
const CTX_SESSION_OPS_AGENTS = new Set(['programming-helper', 'agent-studio']);

// 远程宿主命名空间 ns（remote:<connId>:<hostId>）的菜单放行：连接 id 不含
// 冒号（request-target 不变量），第二个冒号之后即宿主 agent id，须在本集合
// 内才与本地同一放行口径；远程叶子另受握手能力位 sessionOps 门控（ADR-0011
// 扩展：旧远程缺位时菜单降级隐藏）。
function ctxSessionOpsAllowed(ns) {
  if (CTX_SESSION_OPS_AGENTS.has(ns)) return true;
  if (typeof isRemoteNamespaceAgentId !== 'function' || !isRemoteNamespaceAgentId(ns)) return false;
  const innerId = String(ns).split(':').slice(2).join(':');
  if (!CTX_SESSION_OPS_AGENTS.has(innerId)) return false;
  if (typeof window !== 'undefined' && window.RemoteConnections && typeof window.RemoteConnections.capabilityFor === 'function') {
    return window.RemoteConnections.capabilityFor(ns, 'sessionOps') === true;
  }
  return true;
}

function getCtxMenuItems(role, ns, variant, id) {
  if (role === 'runtime' && ctxSessionOpsAllowed(ns)) {
    // 远程运行时叶子：allAgents 无记录，操作经宿主命名空间 id 转发。
    const isZh = currentLanguage === 'zh';
    const agent = allAgents.find((item) => item.id === ns) || null;
    const activeSessionId = agent?.workspace_sessions?.activeSessionId;
    const activeSession = activeSessionId ? getWorkspaceSessionById(agent, activeSessionId) : null;
    const isArchived = activeSession?.archived === true;
    // Assembly sessions (agent-studio) are excluded from summary/trim/branch.
    const isOpsExcluded = isAssemblySession(activeSession);
    const historyItems = isOpsExcluded ? [] : [
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
    ];
    return [
      { label: isZh ? '重命名' : 'Rename', action: 'rename' },
      { label: isZh ? 'AI 生成标题' : 'AI Generate Title', action: 'generate-title' },
      ...historyItems,
      { type: 'separator' },
      // restart / stop / archive-and-stop 对远程叶子同样可用：服务端按
      // ADR-0011 转发远程同名路由（agentId 用宿主命名空间 id）。
      { label: isArchived ? (isZh ? '取消归档' : 'Unarchive') : (isZh ? '归档会话' : 'Archive'), action: 'archive-and-stop' },
      { label: isZh ? '重启 Agent' : 'Restart Agent', action: 'restart' },
      { label: isZh ? '关闭 Agent' : 'Stop Agent', action: 'stop', danger: true },
      { label: isZh ? '删除会话' : 'Delete Session', action: 'delete-session-runtime', danger: true },
    ];
  }
  if (role === 'session' && ctxSessionOpsAllowed(ns)) {
    const agent = allAgents.find((item) => item.id === ns) || null;
    const session = getWorkspaceSessionById(agent, id);
    const sType = variant || 'main';
    const isArchived = sType === 'archived' || session?.archived === true;
    const isTodo = session?.todo === true;
    // Assembly sessions (agent-studio test-runtime) are excluded from summary/trim/branch.
    const isOpsExcluded = sType === 'assembly';
    const isZh = currentLanguage === 'zh';

    const items = [];

    // AI Generate Title
    items.push({ label: isZh ? 'AI 生成标题' : 'AI Generate Title', action: 'generate-title' });

    // Summary / Trim / Branch — only for main/archived sessions
    if (!isOpsExcluded) {
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

  bumpNavigationGuard();
  const _navGuard = _navigationGuardEpoch;

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
    if (variant === 'remote') {
      // 远程运行时：agentId 用宿主命名空间 id，服务端按 ADR-0011 转发到远程
      // 同名路由。重启保留会话、更换 runtime，刷新 catalog 后按会话定位新
      // runtime 再切换。
      restartingRuntimeIds.add(domId);
      suppressSidebarRerender = true;
      renderAgentList();
      try {
        await invoke('restart_agent', { agentId: ns, sessionId: sessionId || null });
        await window.RemoteConnections?.refresh?.();
      } finally {
        restartingRuntimeIds.delete(domId);
        suppressSidebarRerender = false;
      }
      await loadAgents();
      const nextRuntimeRef = window.RemoteConnections?.waitForRuntimeForSession && sessionId
        ? await window.RemoteConnections.waitForRuntimeForSession(sessionId)
        : null;
      if (nextRuntimeRef && _navGuard === _navigationGuardEpoch) {
        await requestSwitch(nextRuntimeRef, 'ctx-restart');
      }
      return;
    }
    if (variant === 'external') {
      result = await restartSidebarExternalRuntime(agent);
    } else if (variant === 'child') {
      const hostId = window.NavigationCore.resolveHostAgentId(agent, serverAgentId);
      const sId = agent?.active_workspace_session_id || null;
      result = await invoke('restart_agent', { agentId: hostId, sessionId: sId });
    } else {
      // managed-runtime / prebuilt
      const sId = sessionId || agent?.active_workspace_session_id || agent?.workspace_sessions?.activeSessionId || null;
      result = await invoke('restart_agent', { agentId: serverAgentId, sessionId: sId });
    }

    // Server already waits for runtime readiness (up to 10s), so the
    // returned result contains the connected agent. No extra polling needed.
    const nextRuntimeId = window.NavigationCore.extractRuntimeId(result) || null;

    restartingRuntimeIds.delete(domId);
    suppressSidebarRerender = false;
    await loadAgents();
    if (nextRuntimeId && _navGuard === _navigationGuardEpoch) {
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

  try {
    const serverAgentId = (variant === 'managed-runtime') ? ns : id;
    const agent = getExternalRuntimeAgent(serverAgentId);
    const affectedRuntimeId = id || getRuntimeId(agent) || null;
    // Clear cached data — runtime is being stopped
    if (affectedRuntimeId) clearAgentRuntimeCache(affectedRuntimeId);
    if (variant === 'external') {
      await closeSidebarExternalRuntime(agent);
    } else if (variant === 'remote') {
      // 远程运行时：agentId 用宿主命名空间 id，服务端按 ADR-0011 转发。
      await invoke('stop_agent', { agentId: ns, sessionId: sessionId || null });
    } else if (variant === 'child') {
      // 侧栏统一投影的 child 叶子：id 是 runtime id，服务端 stop_agent 按
      // (宿主 agentId, sessionId) 寻址——必须经 resolveHostAgentId 解析宿主，
      // 直接用 runtime id 会被服务端静默 no-op（找不到 runtime 也不报错）。
      const hostId = window.NavigationCore.resolveHostAgentId(agent, serverAgentId);
      const sId = sessionId || agent?.active_workspace_session_id || null;
      await invoke('stop_agent', { agentId: hostId, sessionId: sId });
    } else {
      // managed-runtime / prebuilt: pass sessionId to stop only the targeted runtime
      const sId = sessionId || agent?.active_workspace_session_id || null;
      await invoke('stop_agent', { agentId: serverAgentId, sessionId: sId });
    }
    await refreshSidebarRuntimeAfterMutation(500);
    if (affectedRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
      const fallbackTarget = variant === 'remote'
        ? (window.RemoteConnections?.getEntryHostAgentId?.(id) || null)
        : ((variant === 'external' || variant === 'child')
          ? window.NavigationCore.resolveStoppedRuntimeFallback(agent, resolveWorkspaceFallbackAgentId)
          : resolveWorkspaceFallbackAgentId(agent));
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
        workspace_sessions: { ...(agent?.workspace_sessions || {}), sessions: updatedSessions, activeSessionId: agent?.workspace_sessions?.activeSessionId },
      });
      lastRenderedWorkspaceHtml = '';
      renderCurrentMainView();
    }
    try {
      const response = await fetch('/protoclaw/prebuilt_sessions/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId,
          sessionId,
          archived: false,
          responseMode: 'delta',
          operationId: createSidebarOperationId('unarchive'),
        }),
      });
      if (!response.ok) {
        throw new Error(await response.text().catch(() => 'unarchive session failed'));
      }
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
      // Revert optimistic unarchive on failure
      if (agent) {
        const currentSessions = getWorkspaceSessions(agent);
        const revertedSessions = currentSessions.map((s) =>
          s.id === sessionId ? { ...s, archived: true } : s,
        );
        updateAgentRecord(agentId, {
          workspace_sessions: { ...(agent?.workspace_sessions || {}), sessions: revertedSessions, activeSessionId: agent?.workspace_sessions?.activeSessionId },
        });
        lastRenderedWorkspaceHtml = '';
        renderCurrentMainView();
      }
      window.alert((currentLanguage === 'zh' ? '取消归档失败：' : 'Failed to unarchive session: ') + (e?.message || e));
    }
    return;
  }

  const projectDir = String(currentSession?.openDirectory || '').trim();
  const archiveOperation = beginSidebarOperation({
    type: 'archive-close',
    kind: 'archive',
    phase: 'committing',
    agentId,
    sourceSessionId: sessionId,
    sourceRuntimeId: runtimeId || '',
    projectDir,
    projectName: projectDir ? getPathLeaf(projectDir) : '',
    title: currentSession?.title || sessionId,
  });

  // 1. Archive the session first (optimistic + API)
  if (agent) {
    const currentSessions = getWorkspaceSessions(agent);
    const updatedSessions = currentSessions.map((s) =>
      s.id === sessionId ? { ...s, archived: true } : s,
    );
    updateAgentRecord(agentId, {
      workspace_sessions: { ...(agent?.workspace_sessions || {}), sessions: updatedSessions, activeSessionId: agent?.workspace_sessions?.activeSessionId },
    });
    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
  }

  let result = null;
  try {
    const response = await fetch('/protoclaw/prebuilt_sessions/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
      body: JSON.stringify({
        agentId,
        sessionId,
        archived: true,
        responseMode: 'delta',
        operationId: archiveOperation.operationId,
      }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'archive session failed'));
    }
    result = await response.json();
    if (typeof applySessionMutationDelta === 'function') applySessionMutationDelta(agentId, result);
    if (result?.sessions) {
      updateAgentRecord(agentId, {
        workspace_sessions: result.sessions,
        active_workspace_session_id: result.activeSessionId || null,
      });
      lastRenderedWorkspaceHtml = '';
      renderCurrentMainView();
    }
    finishSidebarOperation(archiveOperation.operationId, 'settled', {
      serverRevision: result?.revision ?? null,
    });
    const targetSessionId = String(result?.targetSessionId || '').trim();
    if (targetSessionId) {
      await navigateToSessionMutationTarget(agentId, result, runtimeId);
    }
  } catch (e) {
    // Revert optimistic archive on failure, then alert
    if (agent) {
      const currentSessions = getWorkspaceSessions(agent);
      const revertedSessions = currentSessions.map((s) =>
        s.id === sessionId ? { ...s, archived: false } : s,
      );
      updateAgentRecord(agentId, {
      workspace_sessions: { ...(agent?.workspace_sessions || {}), sessions: revertedSessions, activeSessionId: agent?.workspace_sessions?.activeSessionId },
      });
      lastRenderedWorkspaceHtml = '';
      renderCurrentMainView();
    }
    finishSidebarOperation(archiveOperation.operationId, 'failed', { errorCode: 'archive_failed' });
    window.alert((currentLanguage === 'zh' ? '归档会话失败：' : 'Failed to archive session: ') + (e?.message || e));
    return;
  }

  // 2. Stop the agent runtime (same logic as ctxStopAgent)
  const serverAgentId = (variant === 'managed-runtime') ? agentId : runtimeId;
  const externalAgent = getExternalRuntimeAgent(serverAgentId);
  const affectedRuntimeId = runtimeId || getRuntimeId(externalAgent) || null;
  try {
    if (affectedRuntimeId) clearAgentRuntimeCache(affectedRuntimeId);
    if (variant === 'external') {
      await closeSidebarExternalRuntime(externalAgent);
    } else if (variant === 'remote') {
      // 远程运行时：关停经宿主命名空间 id 转发（与归档转发同套路）。
      await invoke('stop_agent', { agentId, sessionId: sessionId || null });
    } else if (variant === 'child') {
      const hostId = window.NavigationCore.resolveHostAgentId(externalAgent, serverAgentId);
      const sId = sessionId || externalAgent?.active_workspace_session_id || null;
      await invoke('stop_agent', { agentId: hostId, sessionId: sId });
    } else {
      const sId = sessionId || externalAgent?.active_workspace_session_id || null;
      await invoke('stop_agent', { agentId: serverAgentId, sessionId: sId });
    }
    // The archive response has already switched to the replacement session when
    // available. Only fall back to the workspace surface when no replacement
    // exists (for example, the project has no remaining active conversations).
    if (!result?.targetSessionId && affectedRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
      selectWorkspaceSurface(agentId);
    }
    refreshSidebarRuntimeAfterMutation(500).catch(e => console.warn(e));
  } catch (e) {
    // The archive itself is already committed. Runtime cleanup is independent
    // and must not retroactively mark that session mutation as failed.
    refreshSidebarRuntimeAfterMutation(500).catch(e => console.warn(e));
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
      headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
      body: JSON.stringify({ agentId: ns, sessionId }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'Failed to generate title'));
    }
    const result = await response.json();
    if (typeof applySessionMutationDelta === 'function') {
      applySessionMutationDelta(ns, result);
    }
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

function ctxRenameSession(target) {
  const { ns: agentId, id: runtimeId, sessionId } = target;
  if (!agentId || !sessionId) return;

  const itemEl = document.querySelector(
    `[data-ctx-id="${CSS.escape(runtimeId)}"][data-ctx-role="runtime"]`,
  );
  if (!itemEl) return;

  const nameEl = itemEl.querySelector('.agent-name');
  if (!nameEl) return;

  const agent = allAgents.find((item) => item.id === agentId);
  const session = agent ? getWorkspaceSessionById(agent, sessionId) : null;
  const currentTitle = session?.title || nameEl.textContent.trim();
  const isZh = currentLanguage === 'zh';

  // Mark item as editing so click/contextmenu handlers skip it
  itemEl.classList.add('editing');

  nameEl.innerHTML = '<input type="text" class="agent-name-edit-input" value="'
    + escapeHtml(currentTitle) + '" placeholder="'
    + escapeHtml(isZh ? '输入标题' : 'Enter title') + '">';

  const input = nameEl.querySelector('input');
  input.focus();
  input.select();

  // Prevent click/mousedown from bubbling to the agent-item click handler
  ['click', 'mousedown', 'dblclick'].forEach((evt) => {
    input.addEventListener(evt, (e) => e.stopPropagation());
  });

  let saved = false;

  const finishEditing = () => {
    itemEl.classList.remove('editing');
  };

  const restore = () => {
    nameEl.textContent = currentTitle;
    finishEditing();
  };

  const saveTitle = async () => {
    if (saved) return;
    saved = true;
    const newTitle = input.value.trim();
    if (!newTitle || newTitle === currentTitle) {
      restore();
      return;
    }
    try {
      const resp = await fetch('/protoclaw/prebuilt_sessions/' + encodeURIComponent(sessionId) + '/title', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
        body: JSON.stringify({ agentId, title: newTitle }),
      });
      const result = await resp.json();
      if (typeof applySessionMutationDelta === 'function') {
        applySessionMutationDelta(agentId, result);
      }
      if (result.ok) {
        nameEl.textContent = newTitle;
        finishEditing();
        if (agent?.workspace_sessions?.sessions) {
          const s = agent.workspace_sessions.sessions.find((s2) => s2.id === sessionId);
          if (s) s.title = newTitle;
        }
        if (agent?.active_workspace_session_id === sessionId) {
          updateAgentRecord(agentId, { active_workspace_session_title: newTitle });
        }
        renderAgentList();
      } else {
        restore();
        console.error('Failed to update session title:', result.error);
      }
    } catch (error) {
      restore();
      console.error('Failed to update session title:', error);
    }
  };

  input.addEventListener('blur', saveTitle);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveTitle();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      saved = true;
      restore();
    }
  });
}

async function ctxArchiveSession(target) {
  const { ns: agentId, id: sessionId } = target;
  if (!agentId || !sessionId) return;

  const agent = allAgents.find((item) => item.id === agentId) || null;
  const session = getWorkspaceSessionById(agent, sessionId);
  const sourceRuntimeId = currentRuntimeAgentId;
  const nextArchived = !(session?.archived === true);
  const archiveOperation = beginSidebarOperation({
    type: nextArchived ? 'archive' : 'unarchive',
    kind: nextArchived ? 'archive' : 'unarchive',
    phase: 'committing',
    agentId,
    sourceSessionId: sessionId,
    projectDir: session?.openDirectory || '',
    projectName: session?.openDirectory ? getPathLeaf(session.openDirectory) : '',
    title: session?.title || sessionId,
  });

  // Optimistic update
  if (agent) {
    const currentSessions = getWorkspaceSessions(agent);
    const updatedSessions = currentSessions.map((s) =>
      s.id === sessionId ? { ...s, archived: nextArchived } : s,
    );
    updateAgentRecord(agentId, {
      workspace_sessions: { ...(agent?.workspace_sessions || {}), sessions: updatedSessions, activeSessionId: agent?.active_workspace_session_id },
    });
    renderCurrentMainView();
  }

  try {
    const response = await fetch('/protoclaw/prebuilt_sessions/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
      body: JSON.stringify({
        agentId,
        sessionId,
        archived: nextArchived,
        responseMode: 'delta',
        operationId: archiveOperation.operationId,
      }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'archive session failed'));
    }
    const result = await response.json();
    if (typeof applySessionMutationDelta === 'function') applySessionMutationDelta(agentId, result);
    if (result?.sessions) {
      updateAgentRecord(agentId, {
        workspace_sessions: result.sessions,
        active_workspace_session_id: result.activeSessionId || null,
      });
    }
    const targetSessionId = String(result?.targetSessionId || '').trim();
    if (targetSessionId) {
      await navigateToSessionMutationTarget(agentId, result, sourceRuntimeId);
    }
    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
    finishSidebarOperation(archiveOperation.operationId, 'settled');
  } catch (e) {
    // Revert on failure
    if (agent) {
      const currentSessions = getWorkspaceSessions(agent);
      const revertedSessions = currentSessions.map((s) =>
        s.id === sessionId ? { ...s, archived: !nextArchived } : s,
      );
      updateAgentRecord(agentId, {
      workspace_sessions: { ...(agent?.workspace_sessions || {}), sessions: revertedSessions, activeSessionId: agent?.active_workspace_session_id },
      });
    }
    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
    finishSidebarOperation(archiveOperation.operationId, 'failed', { errorCode: nextArchived ? 'archive_failed' : 'unarchive_failed' });
    window.alert((currentLanguage === 'zh' ? '归档会话失败：' : 'Failed to archive session: ') + (e?.message || e));
  }
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
      workspace_sessions: { ...(agent?.workspace_sessions || {}), sessions: updatedSessions, activeSessionId: agent?.active_workspace_session_id },
    });
    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
  }

  try {
    const response = await fetch('/protoclaw/prebuilt_sessions/todo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
      body: JSON.stringify({ agentId, sessionId, todo: nextTodo, responseMode: 'delta' }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'todo session failed'));
    }
    const result = await response.json();
    if (typeof applySessionMutationDelta === 'function') {
      applySessionMutationDelta(agentId, result);
    }
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
        workspace_sessions: { ...(agent?.workspace_sessions || {}), sessions: revertedSessions, activeSessionId: agent?.active_workspace_session_id },
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

    case 'rename':
      window.closeCtxMenu();
      if (ns && sessionId) {
        ctxRenameSession(target);
      }
      break;

    case 'generate-title':
      window.closeCtxMenu();
      if (ns && sid) {
        ctxGenerateTitle({ ...target, sessionId: sid });
      }
      break;

    case 'summary':
      if (ns && sid) {
        window.runWorkspaceAction(JSON.stringify({ type: 'compact_session_menu', agentId: ns, sessionId: sid, compactType: 'summary' }));
      }
      break;

    case 'summary-and-archive':
      if (ns && sid) {
        window.runWorkspaceAction(JSON.stringify({ type: 'compact_session_menu', agentId: ns, sessionId: sid, compactType: 'summary', archiveOriginal: true }));
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

    case 'delete-session-runtime':
      window.closeCtxMenu();
      window.runWorkspaceAction(JSON.stringify({ type: 'delete_session', sessionId: sid }));
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
