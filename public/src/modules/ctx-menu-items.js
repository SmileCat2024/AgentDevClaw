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
 *   - ctxRenameSession: 侧栏 runtime 项内联重命名
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
 *   openTrimPage (via window), openBranchDialog (via window)
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
// coder APP 的会话在线程视图内承接（CoderThreadsUI 自带动作），不经过
// 此处会话 ctx 菜单——不把 'coder' 列作会话操作 agent。
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

function getCtxMenuItems(role, ns, variant, id, sessionId = '', threadId = '') {
  // 线程宿主的侧栏线程叶子：自动接续 APP（coder / memo）走线程语义菜单
  // （与线程视图行动作同源——coder-threads-ui）。中断只在执行/待投递时
  // 有对象；归档任何状态都可用——生产 lifecycle（thread-lifecycle.js）
  // 归档即打断收纳（seal 取消 pending + 收敛接续挡板 + 停全链 runtime），
  // 不做 busy 拒绝（thread_busy 仅 thread-routes.js 测试兜底 lifecycle 的
  // 行为，前端不得据此置灰，否则接续中的线程无法归档）。
  // 手动接续 APP（ADR-0032，编程小助手）：会话操作菜单是既有产品面，
  // 线程化不替换——落到下方 runtime 会话菜单，线程专属项（复制
  // Thread ID / 中断线程 / 归档线程）在其中追加；删除会话在 head 上
  // 即整线程删除（服务端重定向），不另设重复项。
  if (role === 'runtime' && threadId && !ctxSessionOpsAllowed(ns)) {
    const thread = typeof window.getThreadById === 'function' ? window.getThreadById(threadId) : null;
    if (thread) {
      const isZh = currentLanguage === 'zh';
      const busy = thread.lifeState === 'executing' || thread.lifeState === 'pending-commands';
      return [
        { label: isZh ? '复制 Thread ID' : 'Copy Thread ID', action: 'copy-thread-id' },
        { type: 'separator' },
        { label: isZh ? '中断线程' : 'Interrupt Thread', action: 'thread-interrupt', disabled: !busy },
        { label: isZh ? '归档线程' : 'Archive Thread', action: 'thread-archive' },
        { type: 'separator' },
        { label: isZh ? '删除线程' : 'Delete Thread', action: 'thread-delete', danger: true },
      ];
    }
  }
  if (role === 'runtime' && ctxSessionOpsAllowed(ns)) {
    // 侧栏 runtime 叶子：优先按条目携带的 sessionId 解析目标会话（多个
    // runtime 并存时 activeSessionId 未必指向被右键的会话）。
    //
    // 菜单心智（ADR-0032 后的统一对话菜单）：一行 = 一个对话，不暴露
    // Session / Thread / Runtime 分层。线程专属项不再并列追加，语义合并：
    //   - 归档：有线程走线程归档（归档即整链收纳），无线程走会话归档；
    //   - 停止：线程执行中呈现（= 原中断线程），空闲不出现在菜单；
    //   - 复制 ID：有线程复制 thread id，无线程复制 session id；
    //   - 删除：head 上删除即整链删除（服务端重定向），文案只说「对话」。
    // 变换项（总结/精简/分支）直达执行，不再提供「并归档原会话」子项——
    // 线程化后精简是对话内接续，列表本来只有一行，该选项无对应物。
    const isZh = currentLanguage === 'zh';
    const agent = allAgents.find((item) => item.id === ns) || null;
    const targetSessionId = String(sessionId || agent?.workspace_sessions?.activeSessionId || '').trim();
    const targetSession = targetSessionId ? getWorkspaceSessionById(agent, targetSessionId) : null;
    const isArchived = targetSession?.archived === true;
    const isTodo = targetSession?.todo === true;
    // Assembly sessions (agent-studio) are excluded from summary/trim/branch.
    const isOpsExcluded = isAssemblySession(targetSession);
    // 线程解析：侧栏叶子携带 threadId 时直接取（与 coder 线程菜单同源），
    // 否则按会话归属解析（数据未就绪时 null → 会话语义，不硬造线程项）。
    const thread = (threadId && typeof window.getThreadById === 'function'
      ? window.getThreadById(threadId) : null)
      || (targetSessionId && typeof window.getThreadForSession === 'function'
        ? window.getThreadForSession(ns, targetSessionId) : null);
    const threadBusy = Boolean(thread)
      && (thread.lifeState === 'executing' || thread.lifeState === 'pending-commands');
    const threadArchived = thread?.lifeState === 'archived';
    const historyCount = typeof window.phThreadArchiveCount === 'function'
      ? window.phThreadArchiveCount(ns, targetSessionId) : 0;
    // 归档状态线程优先：有线程的行以线程 lifeState 为准（服务端线程归档
    // 不写 session index 的 archived 位）；无线程会话才读 session 标志。
    const conversationArchived = thread ? threadArchived : isArchived;

    const items = [
      {
        label: isZh ? '重命名' : 'Rename',
        action: 'rename',
        submenu: [{ label: isZh ? 'AI 生成标题' : 'AI Generate Title', action: 'generate-title' }],
      },
    ];
    // TODO toggle — non-archived only（与 session 角色菜单一致）
    if (!conversationArchived) {
      items.push({ label: isTodo ? (isZh ? '取消待办' : 'Remove TODO') : (isZh ? '设为待办' : 'Set as TODO'), action: 'todo-session' });
    }
    if (ns === 'programming-helper') {
      items.push({ label: isZh ? '移动到…' : 'Move to…', action: 'move-session' });
    }
    items.push({ label: isZh ? '复制 ID' : 'Copy ID', action: 'copy-id' });
    if (!isOpsExcluded) {
      items.push(
        { type: 'separator' },
        {
          label: isZh ? '会话接续' : 'Conversation Continuity',
          submenu: [
            { label: isZh ? '总结历史' : 'Summary', action: 'summary' },
            { label: isZh ? '精简历史' : 'Trim', action: 'trim' },
            { label: isZh ? '创建分支' : 'Branch', action: 'branch' },
          ],
        },
      );
    }
    if (historyCount > 0) {
      items.push(
        { type: 'separator' },
        { label: isZh ? `查看历史 (${historyCount})` : `History (${historyCount})`, action: 'open-history' },
      );
    }
    // restart / stop / archive 对远程叶子同样可用：服务端按
    // ADR-0011 转发远程同名路由（agentId 用宿主命名空间 id）。
    items.push(
      { type: 'separator' },
      thread
        ? {
            label: conversationArchived ? (isZh ? '取消归档' : 'Unarchive') : (isZh ? '归档' : 'Archive'),
            action: conversationArchived ? 'thread-unarchive' : 'thread-archive',
          }
        : {
            label: isArchived ? (isZh ? '取消归档' : 'Unarchive') : (isZh ? '归档' : 'Archive'),
            action: 'archive-and-stop',
          },
      { type: 'separator' },
    );
    if (threadBusy) {
      items.push({ label: isZh ? '停止' : 'Stop', action: 'thread-interrupt' });
    }
    items.push(
      { label: isZh ? '重启 Agent' : 'Restart Agent', action: 'restart' },
      { label: isZh ? '关闭 Agent' : 'Stop Agent', action: 'stop', danger: true },
      { type: 'separator' },
      { label: isZh ? '删除对话' : 'Delete Conversation', action: 'delete-session-runtime', danger: true },
    );
    return items;
  }
  if (role === 'session' && ctxSessionOpsAllowed(ns)) {
    const agent = allAgents.find((item) => item.id === ns) || null;
    const session = getWorkspaceSessionById(agent, id);
    const sType = variant || 'main';
    // Assembly sessions (agent-studio test-runtime) are excluded from summary/trim/branch.
    const isOpsExcluded = sType === 'assembly';
    const isZh = currentLanguage === 'zh';
    // 线程解析与 runtime 角色同源；远程命名空间无本地线程数据，无线程项
    // 自然退化，不伪造。
    const thread = typeof window.getThreadForSession === 'function'
      ? window.getThreadForSession(ns, id) : null;
    const threadArchived = thread?.lifeState === 'archived';
    const historyCount = typeof window.phThreadArchiveCount === 'function'
      ? window.phThreadArchiveCount(ns, id) : 0;
    // 归档状态线程优先（服务端线程归档不写 session index 的 archived 位，
    // 迁移遗留的 head archived=true 也以线程 lifeState 为准）。
    const conversationArchived = thread
      ? threadArchived
      : (sType === 'archived' || session?.archived === true);
    const isTodo = session?.todo === true;

    const items = [
      {
        label: isZh ? '重命名' : 'Rename',
        action: 'rename-session',
        submenu: [{ label: isZh ? 'AI 生成标题' : 'AI Generate Title', action: 'generate-title' }],
      },
    ];

    // TODO toggle — non-archived only
    if (!conversationArchived) {
      items.push({ label: isTodo ? (isZh ? '取消待办' : 'Remove TODO') : (isZh ? '设为待办' : 'Set as TODO'), action: 'todo-session' });
    }

    // 移动到…（本地 PH only）：归属变更走本地 sessions_move；远程命名空间
    // 不经本地移动（不伪造远程移动），不在此呈现。
    if (ns === 'programming-helper') {
      items.push({ label: isZh ? '移动到…' : 'Move to…', action: 'move-session' });
    }

    items.push({ label: isZh ? '复制 ID' : 'Copy ID', action: 'copy-id' });

    // Summary / Trim / Branch — direct execution（无归档子项，理由同 runtime 角色）
    if (!isOpsExcluded) {
      items.push(
        { type: 'separator' },
        {
          label: isZh ? '会话接续' : 'Conversation Continuity',
          submenu: [
            { label: isZh ? '总结历史' : 'Summary', action: 'summary' },
            { label: isZh ? '精简历史' : 'Trim', action: 'trim' },
            { label: isZh ? '创建分支' : 'Branch', action: 'branch' },
          ],
        },
      );
    }

    if (historyCount > 0) {
      items.push(
        { type: 'separator' },
        { label: isZh ? `查看历史 (${historyCount})` : `History (${historyCount})`, action: 'open-history' },
      );
    }

    // Archive / Unarchive（线程优先；无线程走会话归档）
    items.push(
      { type: 'separator' },
      thread
        ? {
            label: conversationArchived ? (isZh ? '取消归档' : 'Unarchive') : (isZh ? '归档' : 'Archive'),
            action: conversationArchived ? 'thread-unarchive' : 'thread-archive',
          }
        : {
            label: conversationArchived ? (isZh ? '取消归档' : 'Unarchive') : (isZh ? '归档' : 'Archive'),
            action: 'archive-session',
          },
    );

    // Danger zone
    items.push(
      { type: 'separator' },
      { label: isZh ? '删除对话' : 'Delete Conversation', action: 'delete-session', danger: true },
    );

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
      const sId = sessionId || agent?.active_workspace_session_id || null;
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

  // 与归档源清理（reconcileArchivedSourceRuntime）共用乐观退场：提交即
  // 注册隐藏，条目不等轮询快照摘除（快照一轮 ~3s，期间条目原样挂着，表现为
  // 「点关闭后卡在那儿」）。远程条目不经本地投影过滤（isRuntimeStopPending
  // 只覆盖本地投影），不注册。
  let stopRegistry = null;
  let stopConfirmed = false;
  try {
    const serverAgentId = (variant === 'managed-runtime') ? ns : id;
    const agent = getExternalRuntimeAgent(serverAgentId);
    const affectedRuntimeId = id || getRuntimeId(agent) || null;
    // Clear cached data — runtime is being stopped
    if (affectedRuntimeId) clearAgentRuntimeCache(affectedRuntimeId);
    if (variant !== 'remote' && typeof markPendingRuntimeStop === 'function') {
      if (variant === 'child') {
        const hostId = window.NavigationCore.resolveHostAgentId(agent, serverAgentId);
        const sId = sessionId || agent?.active_workspace_session_id || null;
        if (hostId && sId) stopRegistry = { agentId: hostId, sessionId: sId };
      } else if (variant === 'external') {
        if (affectedRuntimeId) stopRegistry = { agentId: '', sessionId: '', runtimeId: affectedRuntimeId };
      } else {
        stopRegistry = {
          agentId: serverAgentId,
          sessionId: sessionId || agent?.active_workspace_session_id || '',
          runtimeId: affectedRuntimeId || '',
        };
      }
      if (stopRegistry && (stopRegistry.agentId || stopRegistry.runtimeId)) {
        if (!stopRegistry.runtimeId) stopRegistry.runtimeId = affectedRuntimeId || '';
        // 注册/释放共用同一三元组（pendingRuntimeStopKey 按 runtimeId 优先），
        // 任一侧自行拼 key 都可能与另一侧不对称，导致失败后无法释放。
        markPendingRuntimeStop(
          stopRegistry.agentId || '',
          stopRegistry.sessionId || '',
          stopRegistry.runtimeId,
        );
        if (typeof invalidateSidebarProjection === 'function') invalidateSidebarProjection();
      } else {
        stopRegistry = null;
      }
    }
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
    stopConfirmed = true;
    await refreshSidebarRuntimeAfterMutation();
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
    if (stopConfirmed) {
      console.warn('Runtime closed, but sidebar refresh failed:', e);
      window.alert(t('对话已关闭，但列表刷新失败，请刷新页面。', 'Conversation closed, but the list failed to refresh. Please refresh the page.'));
      return;
    }
    // stop 未被接受：解除乐观隐藏让条目回到可见，由轮询快照恢复呈现
    // （与归档清理链路同款回滚）。
    if (stopRegistry && typeof releasePendingRuntimeStop === 'function') {
      releasePendingRuntimeStop(
        stopRegistry.runtimeId || '',
        stopRegistry.agentId || '',
        stopRegistry.sessionId || '',
      );
      if (typeof invalidateSidebarProjection === 'function') invalidateSidebarProjection();
    }
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
    // 乐观退场：归档已提交，源 runtime 的侧栏条目立即消失，不再等导航与
    // 关停链路走完。stop 仍按原有顺序执行（先导航后关停），轮询快照确认
    // runtime 消失后抑制自动解除；关停失败时下方 catch 会解除并恢复呈现。
    if (variant !== 'remote' && typeof markPendingRuntimeStop === 'function') {
      markPendingRuntimeStop(agentId, sessionId, runtimeId);
      if (typeof invalidateSidebarProjection === 'function') invalidateSidebarProjection();
    }
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
    refreshSidebarRuntimeAfterMutation().catch(e => console.warn(e));
  } catch (e) {
    // The archive itself is already committed. Runtime cleanup is independent
    // and must not retroactively mark that session mutation as failed.
    if (variant !== 'remote' && typeof releasePendingRuntimeStop === 'function') {
      releasePendingRuntimeStop(runtimeId, agentId, sessionId);
      if (typeof invalidateSidebarProjection === 'function') invalidateSidebarProjection();
    }
    refreshSidebarRuntimeAfterMutation().catch(e => console.warn(e));
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

/** 剪贴板写入 + 结果 toast（secure clipboard 优先，非安全上下文降级 execCommand） */
async function _copyTextWithToast(text, { okTitle, failTitle }) {
  const isZh = currentLanguage === 'zh';
  let ok = false;
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); ok = true; } catch { ok = false; }
  }
  if (!ok) {
    // Fallback for non-secure contexts (e.g. accessing the UI via a LAN IP)
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch { ok = false; }
  }
  ClawToast.show({
    id: 'ctx-copy-id',
    status: ok ? 'success' : 'error',
    title: ok ? okTitle : failTitle,
    description: ok ? text : undefined,
  });
}

/** 线程生命周期动作（侧栏右键 → 与 coder-threads-ui 行动作同一组端点） */
async function ctxThreadRequest(threadId, path) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.message || payload.error || `Request failed (${response.status})`);
  }
  return payload;
}

async function afterThreadMutation() {
  if (typeof window.refreshThreads === 'function') await window.refreshThreads(true).catch(() => {});
  if (typeof renderAgentList === 'function') renderAgentList();
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
    renderAgentList();
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
      if (resp.ok && result.ok) {
        nameEl.textContent = result.title || newTitle;
        finishEditing();
        applySessionMutationDelta(agentId, result);
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

async function ctxTodoSession(target, explicit = {}) {
  const { ns: agentId, id: sessionId } = target;
  if (!agentId || !sessionId) return;

  const agent = allAgents.find((item) => item.id === agentId) || null;
  const session = getWorkspaceSessionById(agent, sessionId);
  const nextTodo = typeof explicit.todo === 'boolean' ? explicit.todo : !(session?.todo === true);
  const nextColor = typeof explicit.color === 'string' && window.SIDEBAR_TODO_COLORS.has(explicit.color)
    ? explicit.color : 'white';

  // Optimistic update
  if (agent) {
    const currentSessions = getWorkspaceSessions(agent);
    const updatedSessions = currentSessions.map((s) =>
      s.id === sessionId ? { ...s, todo: nextTodo, todoColor: nextTodo ? nextColor : null } : s,
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
      body: JSON.stringify({ agentId, sessionId, todo: nextTodo, color: nextColor, responseMode: 'delta' }),
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
    // Revert on failure（恢复请求前的真实状态，而非简单取反——颜色要一并还原）
    if (agent) {
      const previousTodo = session?.todo === true;
      const previousColor = previousTodo
        ? (window.SIDEBAR_TODO_COLORS.has(session?.todoColor) ? session.todoColor : 'white')
        : null;
      const currentSessions = getWorkspaceSessions(agent);
      const revertedSessions = currentSessions.map((s) =>
        s.id === sessionId ? { ...s, todo: previousTodo, todoColor: previousColor } : s,
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
  const { ns, id, sessionId, variant, threadId } = target;
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

    case 'trim':
      if (ns && sid) {
        window.openTrimPage(ns, sid);
      }
      break;

    case 'branch':
      if (ns && sid) {
        window.openBranchDialog(ns, sid);
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

    case 'move-session':
      window.closeCtxMenu();
      // 本地 PH 单条移动入口（批量入口在会话列表工具条多选）
      if (ns === 'programming-helper' && sid && typeof window.phOpenSessionMoveDialog === 'function') {
        window.phOpenSessionMoveDialog([sid]);
      }
      break;

    case 'todo-session':
      window.closeCtxMenu();
      // ctxTodoSession 以 id 取 sessionId；runtime 角色的 id 是 runtimeId，
      // 必须回填真实 sessionId（本地条目 id 即 runtimeId 的场景）。
      if (ns && sid) {
        ctxTodoSession({ ...target, id: sid });
      }
      break;

    // 统一「复制 ID」：有线程复制 thread id（定位整条对话），否则 session id
    case 'copy-id': {
      window.closeCtxMenu();
      const threadForId = (sid && typeof window.getThreadForSession === 'function')
        ? window.getThreadForSession(ns, sid) : null;
      const valueToCopy = String(threadForId?.threadId || sid || id || '').trim();
      if (!valueToCopy) break;
      const isZh = currentLanguage === 'zh';
      _copyTextWithToast(valueToCopy, {
        okTitle: isZh ? 'ID 已复制' : 'ID copied',
        failTitle: isZh ? '复制 ID 失败' : 'Failed to copy ID',
      });
      break;
    }

    // 「查看历史 (N)」：与行内徽标同一入口（050 历史存档面板）
    case 'open-history': {
      window.closeCtxMenu();
      const threadForHistory = (sid && typeof window.getThreadForSession === 'function')
        ? window.getThreadForSession(ns, sid) : null;
      if (threadForHistory?.threadId && typeof window.phOpenThreadHistory === 'function') {
        window.phOpenThreadHistory(ns, threadForHistory.threadId);
      }
      break;
    }

    // 主列表行「重命名」对话框（侧栏叶子保持内联编辑 'rename'）
    case 'rename-session':
      window.closeCtxMenu();
      if (ns && sid && typeof window.phOpenRenameDialog === 'function') {
        window.phOpenRenameDialog(ns, sid);
      }
      break;

    // ── 线程宿主叶子（coder 等）：线程语义动作 ──
    // PH 统一菜单的归档/停止/取消归档同样落到这组端点；threadId 优先取
    // target 携带值（coder 线程叶子），缺省经会话归属解析（PH 会话叶子/
    // 主列表行——target 不带 threadId）。
    function _resolveCtxThread() {
      if (threadId && typeof window.getThreadById === 'function') {
        const byId = window.getThreadById(threadId);
        if (byId) return byId;
      }
      return (sid && typeof window.getThreadForSession === 'function')
        ? window.getThreadForSession(ns, sid) : null;
    }

    case 'copy-thread-id': {
      window.closeCtxMenu();
      const tid = String(threadId || '').trim();
      if (!tid) break;
      const isZh = currentLanguage === 'zh';
      _copyTextWithToast(tid, {
        okTitle: isZh ? 'Thread ID 已复制' : 'Thread ID copied',
        failTitle: isZh ? '复制 Thread ID 失败' : 'Failed to copy Thread ID',
      });
      break;
    }

    // 「停止」（PH 统一菜单）/「中断线程」（coder 线程菜单）同一端点
    case 'thread-interrupt': {
      window.closeCtxMenu();
      const isZh = currentLanguage === 'zh';
      const threadToInterrupt = _resolveCtxThread();
      (async () => {
        try {
          if (!threadToInterrupt?.headViewerAgentId) {
            throw new Error(isZh ? 'head 会话 runtime 未运行' : 'head runtime is not running');
          }
          const response = await fetch('/api/agents/' + encodeURIComponent(threadToInterrupt.headViewerAgentId) + '/interrupt', {
            method: 'POST',
            headers: { 'x-idempotency-key': newIdempotencyKey() },
          });
          if (!response.ok) throw new Error(isZh ? `中断请求失败 (${response.status})` : `interrupt failed (${response.status})`);
          await afterThreadMutation();
        } catch (error) {
          ClawToast.error(error?.message || 'Thread interrupt failed');
        }
      })();
      break;
    }

    case 'thread-archive': {
      window.closeCtxMenu();
      const isZh = currentLanguage === 'zh';
      const threadToArchive = _resolveCtxThread();
      if (!threadToArchive?.threadId) break;
      (async () => {
        try {
          const payload = await ctxThreadRequest(threadToArchive.threadId, '/protoclaw/threads/' + encodeURIComponent(threadToArchive.threadId) + '/archive');
          // 文案按归档事务实际发生的事实展示：只有真的取消了排队中的消息
          // 才说明后果；空闲归档只报结果，避免「什么指令」式的无来由提醒。
          const cleanup = payload?.cleanup;
          const cancelled = Number(cleanup?.commandsCancelled) || 0;
          const partial = cleanup?.status === 'partial';
          ClawToast.show({
            id: 'ctx-thread-archive-' + threadToArchive.threadId,
            status: partial ? 'warning' : 'success',
            title: isZh
              ? (partial ? '已归档（部分收尾未确认）' : '已归档')
              : (partial ? 'Archived (partial cleanup unconfirmed)' : 'Archived'),
            description: cancelled > 0
              ? (isZh
                ? `${cancelled} 条排队中的消息已取消，取消归档后不会自动重新发送。`
                : `${cancelled} queued message(s) cancelled; unarchiving won't resend them.`)
              : undefined,
          });
          await afterThreadMutation();
          // 归档事务停掉整链 runtime：若被归档会话正停靠在前台，切回
          // 工作台面，避免停留在一个已无 runtime 的对话上。
          if (id && currentRuntimeAgentId === id) {
            selectWorkspaceSurface(ns);
          }
        } catch (error) {
          ClawToast.error(error?.message || 'Thread archive failed');
        }
      })();
      break;
    }

    case 'thread-unarchive': {
      window.closeCtxMenu();
      const isZh = currentLanguage === 'zh';
      const threadToRestore = _resolveCtxThread();
      if (!threadToRestore?.threadId) break;
      (async () => {
        try {
          await ctxThreadRequest(threadToRestore.threadId, '/protoclaw/threads/' + encodeURIComponent(threadToRestore.threadId) + '/unarchive');
          ClawToast.show({
            id: 'ctx-thread-unarchive-' + threadToRestore.threadId,
            status: 'success',
            title: isZh ? '已取消归档' : 'Unarchived',
          });
          await afterThreadMutation();
        } catch (error) {
          ClawToast.error(error?.message || 'Thread unarchive failed');
        }
      })();
      break;
    }

    case 'thread-delete': {
      window.closeCtxMenu();
      const isZh = currentLanguage === 'zh';
      const confirmed = window.confirm(isZh
        ? '确定要删除该线程吗？其全部成员会话、交接记录与执行记录将一并删除，不可撤销。'
        : 'Delete this thread? All member sessions, handoff and execution records will be removed. This cannot be undone.');
      if (!confirmed) break;
      (async () => {
        try {
          await ctxThreadRequest(threadId, '/protoclaw/threads/' + encodeURIComponent(threadId) + '/delete');
          await afterThreadMutation();
          // 与 thread-archive 同口径：删除事务停掉整链 runtime，若被删会话
          // 正停靠在前台，切回工作台面，避免停留在一个已无 runtime 的对话上。
          if (id && currentRuntimeAgentId === id) {
            selectWorkspaceSurface(ns);
          }
        } catch (error) {
          ClawToast.error(error?.message || 'Thread delete failed');
        }
      })();
      break;
    }

    default:
      console.warn('Unknown ctx-menu action:', action, target);
  }
}
