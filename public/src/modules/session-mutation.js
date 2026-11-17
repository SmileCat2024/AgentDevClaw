/**
 * session-mutation.js — 会话替换状态机（从 ctx-menu-items.js 提取）
 * 拆出日期：2026-07-13
 * ESM 化：P2 W2-6（2026-11-17）
 *
 * 当 summary / trim / branch 操作生成新会话并归档原会话时，
 * 这套状态机负责追踪 mutation 的生命周期，驱动侧栏渲染。
 *
 * 包含：
 *   getSessionReplacementMutation: 获取当前 mutation
 *   beginSessionReplacementMutation: 开始 mutation
 *   clearSessionReplacementMutation: 清除 mutation
 *   markSessionArchivedForMutation: 乐观归档 + 返回回滚函数
 *   archiveSessionAfterMutation: 归档原会话 + 停止 runtime
 *
 * 依赖（ESM，装载顺序由 import 图确定）：
 *   - allAgents（agent-store-state.js，live binding 引用）
 *   - setLastRenderedWorkspaceHtml（render-entry-state.js）
 *   - currentRuntimeAgentId / _navigationGuardEpoch（orchestration-state.js）
 *   - beginChatLoadingSession（chat-loading-host.js）、requestSwitch（runtime-switch-host.js）
 *   - clearAgentRuntimeCache（runtime-view-cache-host.js）
 *   - getWorkspaceSessions（session-ui.js）
 *   - sidebar-operations：beginSidebarOperation / findSidebarOperation /
 *     finishSidebarOperation / createSidebarOperationId / invalidateSidebarProjection /
 *     markPendingRuntimeStop / applySessionMutationDelta
 *   - external-runtime：refreshSidebarRuntimeAfterMutation
 *
 *   - project-data：getPathLeaf / updateAgentRecord
 *
 * 仍 classic（调用时点显式 window 晚绑定）：getParentAgentId / getActiveSessionId /
 * getRuntimeId / invoke (app-core.js)、renderCurrentMainView /
 * setPreferredUnitMode / upsertConnectedAgent (app-ui.js)、renderAgentList /
 * waitForTargetRuntimeSession (sidebar-render.js)
 *
 * 桥接期兼容面（KernelState defineKey/claim，domain: session-mutation）：见文件末尾。
 */

import { allAgents } from './agent-store-state.js';
import { setLastRenderedWorkspaceHtml } from './render-entry-state.js';
import { currentRuntimeAgentId, _navigationGuardEpoch } from './orchestration-state.js';
import { beginChatLoadingSession } from './chat-loading-host.js';
import { requestSwitch } from './runtime-switch-host.js';
import { clearAgentRuntimeCache } from './runtime-view-cache-host.js';
import { getWorkspaceSessions } from './session-ui.js';
import {
  beginSidebarOperation,
  findSidebarOperation,
  finishSidebarOperation,
  createSidebarOperationId,
  invalidateSidebarProjection,
  markPendingRuntimeStop,
  applySessionMutationDelta,
} from './sidebar-operations.js';
import { refreshSidebarRuntimeAfterMutation } from './external-runtime.js';
import { getPathLeaf, updateAgentRecord } from './project-data.js';

function getSessionReplacementMutation(agentId, sessionId) {
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
  // 桥接期：getParentAgentId / getActiveSessionId / getRuntimeId 定义于 classic app-core
  // （身份解析域收敛时改 import）
  const sourceRuntime = Array.isArray(allAgents) ? allAgents.find((item) => (
    item?.source !== 'prebuilt'
    && String(window.getParentAgentId(item) || '').trim() === String(agentId).trim()
    && String(window.getActiveSessionId(item) || '').trim() === String(sessionId).trim()
  )) : null;
  const projectDir = String(options.projectDir || session?.openDirectory || '').trim();
  return beginSidebarOperation({
    operationId: options.operationId,
    type: 'replacement',
    kind,
    phase: 'generating',
    agentId,
    sourceSessionId: sessionId,
    sourceRuntimeId: options.sourceRuntimeId || window.getRuntimeId(sourceRuntime) || '',
    projectId: String(options.projectId || session?.projectId || '').trim(),
    projectDir,
    projectName: options.projectName || (projectDir ? getPathLeaf(projectDir) : ''),
    title: session?.title || '',
  });
}

function clearSessionReplacementMutation(agentId, sessionId) {
  const current = getSessionReplacementMutation(agentId, sessionId);
  if (!current) return null;
  return finishSidebarOperation(current.operationId, 'settled');
}

// Archive success includes runtime retirement. This is presentation-only:
// discard the retired runtime cache and reconcile the sidebar, never send a
// second lifecycle command from the browser.
function reconcileArchivedSourceRuntime(agentId, sessionId, sourceRuntimeId = '') {
  if (!agentId || !sessionId) return;
  if (sourceRuntimeId) clearAgentRuntimeCache(sourceRuntimeId);
  // The server has confirmed retirement; hide any stale polling projection.
  markPendingRuntimeStop(agentId, sessionId, sourceRuntimeId);
  invalidateSidebarProjection();
  void (async () => {
    try {
      await refreshSidebarRuntimeAfterMutation();
    } catch (error) {
      console.warn('Failed to refresh archived session projection:', error);
      // A failed read cannot undo the server's successful retirement receipt.
      // Keep the intent until a later authoritative snapshot reconciles it.
    }
  })();
}

async function navigateToSessionMutationTarget(agentId, result, sourceRuntimeId) {
  const targetSessionId = String(result?.targetSessionId || '').trim();
  if (!agentId || !targetSessionId || (sourceRuntimeId && currentRuntimeAgentId !== sourceRuntimeId)) {
    return false;
  }

  const navigationEpoch = _navigationGuardEpoch;
  // 桥接期：waitForTargetRuntimeSession 定义于 classic sidebar-render（侧栏渲染域收敛时移除）
  const targetAgent = await window.waitForTargetRuntimeSession(agentId, targetSessionId, 50, {
    operationId: result?.operationId || '',
  });
  if (!targetAgent || navigationEpoch !== _navigationGuardEpoch || (sourceRuntimeId && currentRuntimeAgentId !== sourceRuntimeId)) {
    return false;
  }

  // 桥接期：upsertConnectedAgent / setPreferredUnitMode / renderCurrentMainView 定义于
  // classic app-ui（渲染入口域收敛时改 import）
  const connectedTarget = window.upsertConnectedAgent(targetAgent) || targetAgent;
  const targetRuntimeId = window.getRuntimeId(connectedTarget);
  if (!targetRuntimeId) {
    return false;
  }

  window.setPreferredUnitMode('chat', connectedTarget);
  beginChatLoadingSession();
  await requestSwitch(targetRuntimeId, 'session-mutation-target');
  return true;
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
  // 桥接期：getActiveSessionId 定义于 classic app-core（编排域收敛时改 import）
  updateAgentRecord(agentId, {
    workspace_sessions: {
      ...(agent?.workspace_sessions || {}),
      sessions: nextSessions,
      activeSessionId: window.getActiveSessionId(agent),
    },
  });
  setLastRenderedWorkspaceHtml('');
  window.renderCurrentMainView();

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
        activeSessionId: window.getActiveSessionId(latestAgent),
      },
    });
    setLastRenderedWorkspaceHtml('');
    window.renderCurrentMainView();
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
        activeSessionId: window.getActiveSessionId(agent),
      },
    });
    // Render immediately so the user sees the archive without waiting for the
    // runtime stop + agent reload chain below.
    setLastRenderedWorkspaceHtml('');
    window.renderCurrentMainView();
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
    applySessionMutationDelta(agentId, result);
    if (result?.sessions) {
      updateAgentRecord(agentId, {
        workspace_sessions: result.sessions,
        active_workspace_session_id: result.activeSessionId || null,
      });
      setLastRenderedWorkspaceHtml('');
      window.renderCurrentMainView();
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
        workspace_sessions: { ...(agent?.workspace_sessions || {}), sessions: revertedSessions, activeSessionId: window.getActiveSessionId(agent) },
      });
      setLastRenderedWorkspaceHtml('');
      window.renderCurrentMainView();
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
    // 桥接期：invoke 定义于 classic app-core（会话切换/控制域收敛时改 import）
    await window.invoke('stop_agent', { agentId, sessionId });
    refreshSidebarRuntimeAfterMutation();
  } catch (e) {
    console.error('Failed to stop runtime after archive:', e);
  }
  return true;
}

export {
  getSessionReplacementMutation,
  beginSessionReplacementMutation,
  clearSessionReplacementMutation,
  reconcileArchivedSourceRuntime,
  navigateToSessionMutationTarget,
  markSessionArchivedForMutation,
  archiveSessionAfterMutation,
};

// —— 桥接期兼容面（kernel-state 访问器桥）——
// 保留原因：唯一仍有 classic 消费面的入口是 runtime-status（渲染时按 runtime 反查
// 替换记录，`typeof … === 'function'` 可选调用）：
//   getSessionReplacementMutation ← classic runtime-status
// 注销条件：runtime-status 迁移后改 import，删除对应 defineKey 并下调桥债基线。
// 已注销（消费方全部改具名 import，classic 侧零消费面，只保留命名导出）：
//   markSessionArchivedForMutation  ← ESM trim-page / session-dialogs / workspace-actions
//   navigateToSessionMutationTarget ← ESM ctx-menu-items / workspace-actions
//   reconcileArchivedSourceRuntime  ← ESM trim-page / session-dialogs / workspace-actions
// beginSessionReplacementMutation / clearSessionReplacementMutation /
// archiveSessionAfterMutation 消费面为零（本文件内部使用），只作命名导出，不上桥。
const bridgeApi = {
  getSessionReplacementMutation,
};
window.KernelState.defineKey('session-mutation', 'getSessionReplacementMutation', getSessionReplacementMutation);
window.KernelState.claim('session-mutation', {
  get: (key) => bridgeApi[key],
  set: (key, value) => { bridgeApi[key] = value; },
});
