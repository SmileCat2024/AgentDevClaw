/**
 * ctx-menu-handlers.js
 *
 * Context menu action handlers — all addEventListener registrations for
 * agent/session/project/feature context menu actions, plus global
 * click/resize/scroll/contextmenu document-level listeners.
 *
 * Extracted from app-main.js.
 *
 * ESM 化：P2 W2-7 菜单批剩余部分（原位转换，动作与监听语义零变化）。
 * 跨文件依赖按目标现状分流（配方步 3），不再裸读 classic 词法：
 *   - 已 ESM 的菜单/会话/装配/导航/加载域 → 直接 import 命名导出
 *     （ctx-menu-items / session-ui / sidebar-operations / project-data /
 *     assembly-actions / fw-config-panel / external-runtime / session-dialogs /
 *     workspace-blocks / 各 host 适配模块与状态 owner）
 *   - 6 个待执行目标 → p2-bootstrap-context-menu.js 的 contextMenuUi（转发
 *     app-core 原 let）；DOM 引用 → p2-bootstrap-dom.js 的 domRefs；
 *     侧栏交互态（suppressSidebarRerender）→ p2-bootstrap-sidebar.js 的 sidebarUi
 *   - 仍 classic 的宿主（app-core / app-main / app-ui / sidebar-render /
 *     chat-viewport）→ 显式 window.X 晚绑定，行内标注定义域
 * 监听注册时点（R4 审计）：本文件顶层 13 个监听（8 个菜单动作元素 + 文档
 * click / keydown + 窗口 resize / scroll(capture) + 容器 contextmenu）随模块
 * 求值一次性注册。求值相 = 普通（非 async）`<script type="module">` 的 deferred
 * 执行：在 document 解析完成后、DOMContentLoaded 之前。真实启动链给出的顺序
 * 保证是：静态非 async ESM 执行完 → DOMContentLoaded → auth-client
 * initialize()（`document.addEventListener('DOMContentLoaded', initialize)`）→
 * `window.__clawAuthReady` → app-main 尾部 boot，即所有能打开菜单 / 点击条目的
 * 入口都在 boot 之后，模块监听与桥键必然先就位（不是靠「没有同步 dispatch」
 * 反证用户不可触发；下载期用户交互落在 deferred 执行之后才能被派发）。
 * openAgentActions 仍有 classic 消费方，经 kernel-state 访问器桥暴露；
 * newIdempotencyKey 不建桥（原因见文件末尾桥接块）。
 *
 * Dependencies (DOM elements from app-core.js, via p2-bootstrap-dom.js):
 *   restartAgentAction, stopAgentAction, deleteAgentAction,
 *   compactSummaryAction, compactTrimAction,
 *   compactBranchAction, deleteProjectAction, deleteFeatureAction,
 *   ctxMenu, agentContextMenu, compactContextMenu,
 *   projectContextMenu, featureRepoContextMenu, container, featurePanel
 */

import { allAgents, focusedAgentId } from './agent-store-state.js';
import { currentRuntimeAgentId, _navigationGuardEpoch } from './orchestration-state.js';
import { setLastRenderedWorkspaceHtml } from './render-entry-state.js';
import { getCurrentLanguage } from './i18n-environment-state.js';
import { getFeaturePanelWidth, setFeaturePanelWidth } from './panel-layout-state.js';
import { domRefs } from './p2-bootstrap-dom.js';
import { contextMenuUi } from './p2-bootstrap-context-menu.js';
import { sidebarUi } from './p2-bootstrap-sidebar.js';
import {
  closeAgentContextMenu,
  closeProjectContextMenu,
  closeFeatureRepoContextMenu,
  closeCompactMenu,
  openAgentContextMenu,
  openFeatureRepoContextMenu,
  openProjectContextMenu,
} from './context-menu.js';
import { getCtxMenuItems, dispatchCtxAction } from './ctx-menu-items.js';
import { resolveHostAgentId, extractRuntimeId, resolveStoppedRuntimeFallback } from './navigation-core.js';
import { getExternalRuntimeAgent, restartSidebarExternalRuntime, closeSidebarExternalRuntime, refreshSidebarRuntimeAfterMutation } from './external-runtime.js';
import { clearAgentRuntimeCache } from './runtime-view-cache-host.js';
import { loadAgents } from './agent-snapshot-loader-host.js';
import { requestSwitch } from './runtime-switch-host.js';
import { selectWorkspaceSurface } from './workspace-surface-host.js';
import { createSidebarOperationId, applySessionMutationDelta } from './sidebar-operations.js';
import { updateAgentRecord, applyManagedPrebuiltAgent, updateAgentWorkspaceState, getProgrammingHelperProjects } from './project-data.js';
import { getSavedAssemblyConfigs, deleteSavedAssemblyConfig } from './assembly-actions.js';
import { fwBackToList, fwRerender, fwOpenConfirmDialog } from './fw-config-panel.js';
import { getWorkspaceSessions } from './session-ui.js';
import { openBranchDialog } from './session-dialogs.js';
import { getRepoLocaleText } from './workspace-blocks.js';

const {
  restartAgentAction,
  stopAgentAction,
  deleteAgentAction,
  compactSummaryAction,
  compactTrimAction,
  compactBranchAction,
  deleteProjectAction,
  deleteFeatureAction,
  ctxMenu,
  agentContextMenu,
  compactContextMenu,
  projectContextMenu,
  featureRepoContextMenu,
  container,
  featurePanel,
} = domRefs;

// i18n 仍是 classic（public/src/i18n.js），与同批 ctx-menu-items /
// session-list-render 同款晚绑定转调；i18n 迁 ESM 后改 import。
const t = (...args) => window.t(...args);

// ── 幂等键（ADR-0011）：写类提交统一携带（本地忽略、远程强制）───────────
function newIdempotencyKey() {
  const cryptoObj = (typeof crypto !== 'undefined') ? crypto : null;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}


export function openAgentActions(event, agentId) {
  event.preventDefault();
  const agent = allAgents.find(item => item.id === agentId);
  if (!agent) return;
  const mode = agent.source === 'prebuilt'
    ? 'prebuilt-runtime'
    : (agent.source === 'child' || agent.source === 'managed-runtime')
      ? 'child-runtime'
    : (agent.source === 'external' && agent.connected !== false)
      ? 'external-runtime'
    : (agent.connected === false ? 'delete-only' : null);
  if (!mode) return;
  openAgentContextMenu(agentId, event.clientX, event.clientY, mode);
}

// ── External Runtime Close/Restart → modules/external-runtime.js (Phase A-5, 2026-07-03) ──

restartAgentAction.addEventListener('click', async () => {
  if (!contextMenuUi.contextMenuAgentId || (contextMenuUi.contextMenuAgentMode !== 'prebuilt-runtime' && contextMenuUi.contextMenuAgentMode !== 'external-runtime' && contextMenuUi.contextMenuAgentMode !== 'child-runtime')) return;

  try {
    window.bumpNavigationGuard(); // classic app-core（导航守卫域收敛时撤销晚绑定）
    const _restartNavGuard = _navigationGuardEpoch;
    const agent = getExternalRuntimeAgent(contextMenuUi.contextMenuAgentId);
    // Clear cached data — restart creates a fresh session
    clearAgentRuntimeCache(contextMenuUi.contextMenuAgentId);
    const runtimeItem = document.querySelector(`[data-agent-id="${CSS.escape(contextMenuUi.contextMenuAgentId)}"]`);
    if (runtimeItem) {
      runtimeItem.classList.add('restarting');
      runtimeItem.classList.remove('active', 'disconnected');
    }
    sidebarUi.suppressSidebarRerender = true;
    let result = null;
    if (contextMenuUi.contextMenuAgentMode === 'external-runtime') {
      closeAgentContextMenu();
      result = await restartSidebarExternalRuntime(agent);
    } else if (contextMenuUi.contextMenuAgentMode === 'child-runtime') {
      const hostId = resolveHostAgentId(agent, contextMenuUi.contextMenuAgentId);
      const sessionId = agent?.active_workspace_session_id || null;
      closeAgentContextMenu();
      result = await window.invoke('restart_agent', { agentId: hostId, sessionId });
    } else {
      const sessionId = agent?.active_workspace_session_id || agent?.workspace_sessions?.activeSessionId || null;
      closeAgentContextMenu();
      result = await window.invoke('restart_agent', { agentId: contextMenuUi.contextMenuAgentId, sessionId });
    }
    // Server already waits for runtime readiness (up to 10s) before responding,
    // same contract as the generic ctx-menu restart (ctxRestartAgent). No extra
    // polling — the former 20×500ms get_connected_agents loop here was both
    // redundant and the heaviest possible probe (full agent list per attempt).
    const nextRuntimeId = extractRuntimeId(result) || null;
    sidebarUi.suppressSidebarRerender = false;
    await loadAgents();
    if (nextRuntimeId && _restartNavGuard === _navigationGuardEpoch) {
      await requestSwitch(nextRuntimeId, 'restart-handler');
    }
  } catch (e) {
    sidebarUi.suppressSidebarRerender = false;
    closeAgentContextMenu();
    window.alert(t('restart_failed') + (e && e.message ? e.message : e));
  }
});

stopAgentAction.addEventListener('click', async () => {
  if (!contextMenuUi.contextMenuAgentId || (contextMenuUi.contextMenuAgentMode !== 'prebuilt-runtime' && contextMenuUi.contextMenuAgentMode !== 'external-runtime' && contextMenuUi.contextMenuAgentMode !== 'child-runtime')) return;

  try {
    const agent = getExternalRuntimeAgent(contextMenuUi.contextMenuAgentId);
    const affectedRuntimeId = window.getRuntimeId(agent) || null;
    // Clear cached data — runtime is being stopped
    if (affectedRuntimeId) clearAgentRuntimeCache(affectedRuntimeId);
    if (contextMenuUi.contextMenuAgentMode === 'external-runtime') {
      await closeSidebarExternalRuntime(agent);
    } else if (contextMenuUi.contextMenuAgentMode === 'child-runtime') {
      const hostId = resolveHostAgentId(agent, contextMenuUi.contextMenuAgentId);
      const sessionId = agent?.active_workspace_session_id || null;
      await window.invoke('stop_agent', { agentId: hostId, sessionId });
    } else {
      await window.invoke('stop_agent', { agentId: contextMenuUi.contextMenuAgentId });
    }
    closeAgentContextMenu();
    await refreshSidebarRuntimeAfterMutation();
    if (affectedRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
      const viaHostEntry = contextMenuUi.contextMenuAgentMode === 'external-runtime' || contextMenuUi.contextMenuAgentMode === 'child-runtime';
      const fallbackTarget = viaHostEntry
        ? resolveStoppedRuntimeFallback(agent, window.resolveWorkspaceFallbackAgentId)
        : window.resolveWorkspaceFallbackAgentId(agent);
      if (fallbackTarget) {
        selectWorkspaceSurface(fallbackTarget);
      }
    }
  } catch (e) {
    closeAgentContextMenu();
    window.alert(t('close_failed') + (e && e.message ? e.message : e));
  }
});

compactSummaryAction.addEventListener('click', async () => {
  if (!contextMenuUi.contextMenuCompactAction?.sessionId) return;
  const action = { ...contextMenuUi.contextMenuCompactAction, compactType: 'summary' };
  closeCompactMenu();
  await window.runWorkspaceAction(action);
});

compactTrimAction.addEventListener('click', async () => {
  if (!contextMenuUi.contextMenuCompactAction?.sessionId) return;
  const action = { ...contextMenuUi.contextMenuCompactAction, compactType: 'trim' };
  closeCompactMenu();
  await window.runWorkspaceAction(action);
});

compactBranchAction.addEventListener('click', () => {
  if (!contextMenuUi.contextMenuCompactAction?.sessionId) return;
  const sessionId = contextMenuUi.contextMenuCompactAction.sessionId;
  const activeAgent = window.getCurrentAgentRecord(); // classic app-main（身份解析域，晚绑定）
  if (!activeAgent?.id) return;
  closeCompactMenu();
  openBranchDialog(activeAgent.id, sessionId);
});

function isDeletedAgentFocused(agentId, focusedId, runtimeId) {
  return agentId === focusedId || agentId === runtimeId;
}

deleteAgentAction.addEventListener('click', async () => {
  if (!contextMenuUi.contextMenuAgentId || contextMenuUi.contextMenuAgentMode !== 'delete-only') return;

  const agent = allAgents.find(item => item.id === contextMenuUi.contextMenuAgentId);
  if (!agent || agent.connected !== false) {
    closeAgentContextMenu();
    return;
  }

  try {
    const res = await fetch(`/api/agents/${contextMenuUi.contextMenuAgentId}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || t('delete_failed_generic'));
    }

    closeAgentContextMenu();
    await loadAgents();

    if (isDeletedAgentFocused(contextMenuUi.contextMenuAgentId, focusedAgentId, currentRuntimeAgentId)) {
      const fallbackId = window.resolveWorkspaceFallbackAgentId(agent);
      if (fallbackId) {
        selectWorkspaceSurface(fallbackId, { skipFeaturePanel: true });
      }
    }
    // 非焦点 agent 被删除时无需视图操作：服务端 current agent 语义已移除，
    // 旧代码据此重置视图的补偿分支随之删除。
  } catch (e) {
    closeAgentContextMenu();
    window.alert(t('delete_failed') + (e && e.message ? e.message : e));
  }
});

deleteProjectAction.addEventListener('click', () => {
  if (!contextMenuUi.contextMenuProjectAgentId || !contextMenuUi.contextMenuProjectId) return;

  const pendingAgentId = contextMenuUi.contextMenuProjectAgentId;
  const pendingProjectId = contextMenuUi.contextMenuProjectId;
  closeProjectContextMenu();

  const projectName = (() => {
    if (pendingAgentId === 'flow-workspace') {
      const agent = allAgents.find(a => a.id === pendingAgentId);
      const config = getSavedAssemblyConfigs(agent).find(c => c.id === pendingProjectId);
      return config?.name || config?.id || pendingProjectId;
    }
    if (pendingAgentId === 'programming-helper') {
      const agent = allAgents.find(a => a.id === pendingAgentId);
      const project = getProgrammingHelperProjects(agent).find(p => p.id === pendingProjectId);
      return project?.name || project?.openDirectory || pendingProjectId;
    }
    return pendingProjectId;
  })();

  if (pendingAgentId === 'programming-helper') {
    const confirmed = window.confirm(
      getCurrentLanguage() === 'zh'
        ? '确定要删除项目「' + projectName + '」吗？该项目下的所有对话记录将一并删除，此操作不可撤销。'
        : 'Delete project "' + projectName + '"? All conversations under this project will also be deleted. This cannot be undone.'
    );
    if (!confirmed) return;
    (async () => {
      try {
        const agent = allAgents.find(a => a.id === pendingAgentId);
        const affectedRuntimeId = agent?.runtime_session_id || agent?.runtimeSessionId || null;
        const activeSessionId = agent?.active_workspace_session_id || agent?.workspace_sessions?.activeSessionId || null;
        const response = await fetch('/protoclaw/prebuilt_project/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: pendingAgentId,
            projectId: pendingProjectId,
            responseMode: 'delta',
            operationId: createSidebarOperationId('delete-project'),
          }),
        });
        if (!response.ok) {
          throw new Error(await response.text().catch(() => 'delete project failed'));
        }
        const result = await response.json();
        applySessionMutationDelta(pendingAgentId, result?.deleted || result);
        if (result?.deleted?.sessions) {
          updateAgentRecord(pendingAgentId, {
            workspace_sessions: result.deleted.sessions,
            active_workspace_session_id: result.deleted.activeSessionId || null,
          });
        }
        const deletedContainedActive = result?.deleted?.deletedSessionIds?.includes(activeSessionId);
        if (result?.agent) {
          applyManagedPrebuiltAgent(pendingAgentId, result.agent);
        } else if (deletedContainedActive) {
          applyManagedPrebuiltAgent(pendingAgentId, null);
        }
        const stateRes = await fetch('/protoclaw/workspace_state?agentId=' + encodeURIComponent(pendingAgentId));
        if (stateRes.ok) {
          const nextState = await stateRes.json();
          updateAgentWorkspaceState(pendingAgentId, nextState);
        }
        setLastRenderedWorkspaceHtml('');
        window.renderAgentList(); // classic sidebar-render（侧栏渲染域，晚绑定）
        window.renderCurrentMainView(); // classic app-ui（渲染入口域，晚绑定）
        const nextRuntimeId = result?.agent?.runtime_session_id || result?.agent?.runtimeSessionId || null;
        if (nextRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
          await requestSwitch(nextRuntimeId, 'stop-handler');
        } else if (affectedRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
          const fallbackAgent = applyManagedPrebuiltAgent(pendingAgentId, null, { uiOnlyWhenStopped: true });
          window.setPreferredUnitMode('home', fallbackAgent || agent || { id: pendingAgentId, source: 'prebuilt' });
          selectWorkspaceSurface(pendingAgentId);
        }
      } catch (error) {
        console.error('Failed to delete programming-helper project:', error);
        window.alert((getCurrentLanguage() === 'zh' ? '删除项目失败：' : 'Failed to delete project: ') + (error?.message || error));
      }
    })();
    return;
  }

  // 确认对话框打开函数：fw-config-panel 的具名导出（classic 相靠顶层 function
  // 声明隐式挂在 window 上，ESM 后那层隐式发布消失，故收为真实导出并 import）。
  fwOpenConfirmDialog({
    title: getCurrentLanguage() === 'zh' ? '删除项目' : 'Delete Project',
    message: getCurrentLanguage() === 'zh'
      ? '确定要删除项目「' + projectName + '」吗？该项目下的所有对话记录将一并删除，此操作不可撤销。'
      : 'Delete project "' + projectName + '"? All conversations under this project will also be deleted. This cannot be undone.',
    confirmLabel: getCurrentLanguage() === 'zh' ? '删除' : 'Delete',
    danger: true,
    onConfirm: async () => {
      try {
        if (pendingAgentId === 'flow-workspace') {
          const agent = allAgents.find(a => a.id === pendingAgentId);
          const config = getSavedAssemblyConfigs(agent).find(c => c.id === pendingProjectId);
          const matchNames = new Set([pendingProjectId]);
          if (config) {
            if (config.name) matchNames.add(String(config.name).trim());
            if (config.displayName) matchNames.add(String(config.displayName).trim());
          }
          const relatedRuns = getWorkspaceSessions(agent).filter(s => {
            const name = String(s?.agentName || s?.assemblyName || '').trim();
            return matchNames.has(name);
          });
          // Delete sessions first, then config — avoids intermediate render showing orphaned sessions
          for (const run of relatedRuns) {
            await fetch('/protoclaw/prebuilt_sessions/delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
              body: JSON.stringify({ agentId: pendingAgentId, sessionId: run.id, responseMode: 'delta' }),
            }).catch(e => console.warn(e));
          }
          await deleteSavedAssemblyConfig(pendingProjectId);
          // Refresh session data after both deletions
          const sessionsRes = await fetch('/protoclaw/prebuilt_sessions?agentId=' + encodeURIComponent(pendingAgentId));
          if (sessionsRes.ok) {
            const fresh = await sessionsRes.json();
            updateAgentRecord(pendingAgentId, {
              workspace_sessions: fresh,
              active_workspace_session_id: fresh?.activeSessionId || null,
            });
          }
          if (window.ClawFW?.mode === 'detail' && window.ClawFW?._projectId === pendingProjectId) {
            fwBackToList();
          } else {
            setLastRenderedWorkspaceHtml('');
            fwRerender();
          }
          return;
        }
        const targetAgent = allAgents.find((item) => item.id === pendingAgentId) || null;
        const affectedRuntimeId = targetAgent?.runtime_session_id || targetAgent?.runtimeSessionId || null;
        const activeSessionId = targetAgent?.active_workspace_session_id || targetAgent?.workspace_sessions?.activeSessionId || null;
        const response = await fetch('/protoclaw/prebuilt_project/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: pendingAgentId,
            projectId: pendingProjectId,
            responseMode: 'delta',
            operationId: createSidebarOperationId('delete-project'),
          }),
        });
        if (!response.ok) {
          throw new Error(await response.text().catch(() => 'delete project failed'));
        }
        const result = await response.json();
        applySessionMutationDelta(pendingAgentId, result?.deleted || result);
        if (result?.deleted?.sessions) {
          updateAgentRecord(pendingAgentId, {
            workspace_sessions: result.deleted.sessions,
            active_workspace_session_id: result.deleted.activeSessionId || null,
          });
        }
        const deletedContainedActive = result?.deleted?.deletedSessionIds?.includes(activeSessionId);
        if (result?.agent) {
          applyManagedPrebuiltAgent(pendingAgentId, result.agent);
        } else if (deletedContainedActive) {
          applyManagedPrebuiltAgent(pendingAgentId, null);
        }
        setLastRenderedWorkspaceHtml('');
        window.renderAgentList();
        window.renderCurrentMainView();

        const nextRuntimeId = result?.agent?.runtime_session_id || result?.agent?.runtimeSessionId || null;
        if (nextRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
          await requestSwitch(nextRuntimeId, 'stop-handler');
        } else if (affectedRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
          const fallbackAgent = applyManagedPrebuiltAgent(pendingAgentId, null, { uiOnlyWhenStopped: true });
          window.setPreferredUnitMode('home', fallbackAgent || targetAgent || { id: pendingAgentId, source: 'prebuilt' });
          selectWorkspaceSurface(pendingAgentId);
        }
      } catch (e) {
        window.alert(t('delete_project_failed') + (e && e.message ? e.message : e));
      }
    },
  });
});

deleteFeatureAction.addEventListener('click', async () => {
  if (!contextMenuUi.contextMenuFeatureRepoPackageId) return;

  const confirmed = window.confirm(getRepoLocaleText('确定要删除这个 Feature 吗？', 'Are you sure you want to delete this feature?'));
  if (!confirmed) {
    closeFeatureRepoContextMenu();
    return;
  }

  try {
    const response = await fetch('/protoclaw/feature_repository/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        packageId: contextMenuUi.contextMenuFeatureRepoPackageId,
      }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'delete feature failed'));
    }
    closeFeatureRepoContextMenu();
    window.renderCurrentMainView();
  } catch (e) {
    closeFeatureRepoContextMenu();
    window.alert(getRepoLocaleText('删除 Feature 失败: ', 'Delete feature failed: ') + (e && e.message ? e.message : e));
  }
});

document.addEventListener('keydown', (event) => {
  const item = event.target.closest('#ctx-menu [data-ctx-action][role="menuitem"]');
  if (!item || !ctxMenu.classList.contains('open')) return;
  if (event.key === 'ArrowRight' && item.classList.contains('has-submenu')) {
    const firstAction = item.querySelector('.ctx-sub [data-ctx-action]');
    if (firstAction) {
      event.preventDefault();
      firstAction.focus();
    }
    return;
  }
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  const action = item.dataset.ctxAction;
  if (action && window._ctxTarget) dispatchCtxAction(action, window._ctxTarget);
  window.closeCtxMenu(); // classic app-ui（ctx-menu 打开/关闭入口，晚绑定）
});

document.addEventListener('click', (event) => {
  // ── Generic ctx-menu action handling ──
  const ctxBtn = event.target.closest('#ctx-menu [data-ctx-action]');
  if (ctxBtn && ctxMenu.classList.contains('open')) {
    if (!ctxBtn.classList.contains('disabled')) {
      const action = ctxBtn.dataset.ctxAction;
      if (action && window._ctxTarget) {
        dispatchCtxAction(action, window._ctxTarget);
      }
    }
    window.closeCtxMenu();
    return;
  }
  // Close ctx-menu on outside click
  if (!ctxMenu.contains(event.target)) {
    window.closeCtxMenu();
  }

  if (!agentContextMenu.contains(event.target)) {
    closeAgentContextMenu();
  }
  if (!compactContextMenu.contains(event.target)) {
    closeCompactMenu();
  }
  if (!projectContextMenu.contains(event.target)) {
    closeProjectContextMenu();
  }
  if (!featureRepoContextMenu.contains(event.target)) {
    closeFeatureRepoContextMenu();
  }
  // Close settings flyout on outside click
  const settingsMenuWrapper = document.getElementById('settings-menu-wrapper');
  if (settingsMenuWrapper && !settingsMenuWrapper.contains(event.target)) {
    const sf = document.getElementById('settings-flyout-menu');
    if (sf) sf.classList.remove('open');
  }
});

window.addEventListener('resize', () => {
  window.closeCtxMenu();
  closeAgentContextMenu();
  closeCompactMenu();
  closeProjectContextMenu();
  closeFeatureRepoContextMenu();
  const _minPw = window.innerWidth <= 1100 ? 300 : 400;
  const nextFeaturePanelWidth = Math.max(_minPw, Math.min(750, getFeaturePanelWidth()));
  setFeaturePanelWidth(nextFeaturePanelWidth);
  if (featurePanel.classList.contains('open')) {
    featurePanel.style.setProperty('--feature-panel-width', nextFeaturePanelWidth + 'px');
  }
  requestAnimationFrame(() => window.updateAssemblySideRailPosition()); // classic chat-viewport（视口域，晚绑定）
});
window.addEventListener('scroll', () => {
  closeAgentContextMenu();
  closeCompactMenu();
  closeProjectContextMenu();
  requestAnimationFrame(() => window.updateAssemblySideRailPosition());
}, true);

container.addEventListener('contextmenu', (event) => {
  // ── Generic ctx-menu for workspace sessions ──
  const ctxEl = event.target.closest('[data-ctx-role]');
  if (ctxEl) {
    const role = ctxEl.dataset.ctxRole;
    const ns = ctxEl.dataset.ctxNs;
    const id = ctxEl.dataset.ctxId;
    const variant = ctxEl.dataset.ctxVariant || 'default';
    const items = getCtxMenuItems(role, ns, variant, id);
    if (items.length > 0) {
      event.preventDefault();
      window.closeCtxMenu();
      closeAgentContextMenu();
      closeCompactMenu();
      closeProjectContextMenu();
      const ctxTarget = { role, ns, id, variant };
      if (role === 'session') ctxTarget.sessionId = id;
      window.showCtxMenu(event.clientX, event.clientY, items, ctxTarget); // classic app-ui（渲染入口域，晚绑定）
      return;
    }
  }

  const featureRepoItem = event.target.closest('.workspace-repo-card[data-feature-repo-package-id]');
  if (featureRepoItem) {
    event.preventDefault();
    openFeatureRepoContextMenu(
      featureRepoItem.dataset.featureRepoPackageId,
      event.clientX,
      event.clientY,
    );
    return;
  }
  const projectItem = event.target.closest('[data-prebuilt-project-id]');
  if (projectItem) {
    event.preventDefault();
    openProjectContextMenu(
      projectItem.dataset.prebuiltProjectAgentId,
      projectItem.dataset.prebuiltProjectId,
      event.clientX,
      event.clientY,
    );
  }
  // 会话右键统一走 data-ctx-role 声明式菜单（ADR-0049）；
  // 未声明 role 的会话发射器不再有 legacy 静态菜单兜底。
});

// —— 桥接期兼容面（kernel-state 访问器桥）——
// 保留原因：唯一入口仍有 classic 消费方在调用时点取用；调用点在事件回调内，
// 无 classic 顶层调用（R1 零触线）。逐键证据：
//   openAgentActions ← classic sidebar-render（agent 条目点击 / 右键委托，
//                      `window.openAgentActions(event, agentId)`）；该名字原来
//                      是本文件的 `window.openAgentActions = …` 赋值（可配置
//                      属性），不存在同名 classic 顶层声明，defineKey 安全。
// 注销条件：sidebar-render 改用 import 后删除 defineKey 并下调桥债基线。
//
// 不建桥（同名覆盖会破坏求值）— newIdempotencyKey：
//   classic 全局赢家是 app-main.js 的顶层 `function newIdempotencyKey()`
//   （index.html :554 的 classic 标签在 ctx-menu-handlers 原位 :544 之后），
//   classic 顶层函数声明在浏览器里是 **non-configurable** 的 window 属性，
//   KernelState.defineKey 的 Object.defineProperty 在真实 Chromium 抛
//   `TypeError: Cannot redefine property: newIdempotencyKey` —— 整个模块求值
//   失败。因此本文件只在内部使用自己的私有副本（幂等请求头），外部消费方
//   （claw-host 的 typeof 兜底 / persistent-input / choice-input 裸调用 /
//   ESM context-guard-toggle 的 window.newIdempotencyKey）继续取 app-main 的
//   classic 实现（两份实现逐字相同，行为零变化）。app-main 日后迁 ESM 时由
//   该批一并处理同名不可配置约束与消费面。
// 本文件其余函数（isDeletedAgentFocused）零跨文件消费方，保持模块私有、不上桥。
const bridgeApi = { openAgentActions };
window.KernelState.defineKey('ctx-menu-handlers', 'openAgentActions', openAgentActions);
window.KernelState.claim('ctx-menu-handlers', {
  get: (key) => bridgeApi[key],
  set: (key, value) => { bridgeApi[key] = value; },
});
