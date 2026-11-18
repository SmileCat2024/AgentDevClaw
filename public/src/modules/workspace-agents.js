/* Workspace Agent presentation: the selected Session owns the binding.
 *
 * ESM 化（P2 W1-4 会话弹窗与精简浏览批次）：状态、语言、转义与 agent 详情
 * 载荷（agent-loader 宿主）显式 import；仍为 classic 的解析函数经 window
 * 晚绑定（行内标注定义域与收敛批次）。
 * classic 消费方（app-core 欢迎态、workspace-actions 建会话）继续经既有公开
 * 命名空间 window.ClawFW.workspaceAgents 调用，namespace 协议不新增散装键。
 */

import { allAgents, focusedAgentId } from './agent-store-state.js';
import { currentRuntimeAgentId } from './orchestration-state.js';
import { getCurrentLanguage } from './i18n-environment-state.js';
import { escapeHtml } from './markdown-utils.js';
import { getAgentDetailPayload } from './agent-loader-host.js';
import { getLogicalAgentId, getRuntimeWorkspaceSessionId } from './identity.js';
import { localizeWorkspaceValue } from './format-utils.js';

export function getWelcomeName() {
  // 桥接期：定义于 session-view-state（会话视图域收敛时改 import）
  const identity = typeof window.getCurrentSessionViewIdentity === 'function' ? window.getCurrentSessionViewIdentity() : null;
  const hostId = identity?.agentId || focusedAgentId;
  // 远程宿主的详情载荷来自 agent-loader（ESM 宿主，直接 import）
  const host = allAgents.find((entry) => entry.id === hostId)
    || getAgentDetailPayload(hostId);
  if (!host) return '';
  const runtime = allAgents.find((entry) => entry.id === currentRuntimeAgentId);
  // 会话身份来自 identity 域（P4 T1 起具名 import）
  const sessionId = identity?.sessionId || (currentRuntimeAgentId ? getRuntimeWorkspaceSessionId(currentRuntimeAgentId) : '');
  // 桥接期：定义于 remote-connections（远程域收敛时改 import）
  const remoteHost = typeof window.splitRemoteNamespaceId === 'function' ? window.splitRemoteNamespaceId(hostId) : null;
  const remoteSession = remoteHost && window.splitRemoteNamespaceId(sessionId);
  const detailSessionId = remoteSession?.connectionId === remoteHost?.connectionId ? remoteSession?.innerId : sessionId;
  const session = host.workspace_sessions?.sessions?.find((entry) => entry.id === sessionId || entry.id === detailSessionId);
  // 桥接期：定义于 session-view-state（会话视图域收敛时改 import）
  const meta = typeof window.readCurrentSessionViewState === 'function' ? window.readCurrentSessionViewState().sessionMeta : null;
  const runtimeMatches = runtime && getLogicalAgentId(runtime) === hostId
    && runtime.active_workspace_session_id === sessionId;
  const boundId = meta?.sessionId === sessionId && meta.workspaceAgentId ? meta.workspaceAgentId
    : session ? (session.workspaceAgentId || 'main')
      : runtimeMatches ? runtime.workspaceAgentId : '';
  if (!boundId) return '';
  if (!Array.isArray(host.agents)) return boundId === 'main' ? String(host.name || '') : '';
  const agent = host.agents.find((entry) => entry.id === boundId);
  return agent ? localizeWorkspaceValue(agent.displayName) : '';
}

export async function selectForNewSession(host, action) {
  if (action.type !== 'create_session' || action.sessionId || action.sourceSessionId
    || action.workspaceAgentId !== undefined || !Array.isArray(host?.agents)
    || host.agents.length < 2) return action;
  const selected = await new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const overlay = document.createElement('div');
    const isZh = getCurrentLanguage() === 'zh';
    overlay.className = 'feature-detail-overlay';
    overlay.innerHTML = '<form class="feature-detail-window workspace-agent-picker" role="dialog" aria-modal="true" aria-labelledby="workspace-agent-picker-title">'
      + '<h2 id="workspace-agent-picker-title">' + (isZh ? '选择对话 Agent' : 'Choose conversation Agent') + '</h2>'
      + '<p>' + (isZh ? '此对话将固定使用所选 Agent，恢复、分支和接续时保持不变。' : 'This conversation keeps the selected Agent when resumed, branched or continued.') + '</p>'
      + '<label for="workspace-agent-picker-select">Agent</label>'
      + '<select id="workspace-agent-picker-select" class="workspace-form-select">'
      + host.agents.map((agent) => '<option value="' + escapeHtml(agent.id) + '"'
        + (agent.id === host.defaultAgentId ? ' selected' : '') + '>'
        + escapeHtml(localizeWorkspaceValue(agent.displayName)) + '</option>').join('')
      + '</select><div class="workspace-agent-picker-actions">'
      + '<button type="button" class="settings-btn settings-btn-secondary">' + (isZh ? '取消' : 'Cancel') + '</button>'
      + '<button type="submit" class="settings-btn settings-btn-primary">' + (isZh ? '创建对话' : 'Create conversation') + '</button></div></form>';
    const finish = (id) => {
      overlay.remove();
      document.removeEventListener('keydown', keydown);
      if (previousFocus?.isConnected) previousFocus.focus();
      resolve(id);
    };
    const keydown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); finish(null); }
      if (event.key === 'Tab') {
        const controls = Array.from(overlay.querySelectorAll('select, button'));
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    overlay.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      finish(overlay.querySelector('select').value);
    });
    overlay.querySelector('button[type="button"]').addEventListener('click', () => finish(null));
    overlay.addEventListener('click', (event) => { if (event.target === overlay) finish(null); });
    document.addEventListener('keydown', keydown);
    document.body.appendChild(overlay);
    overlay.querySelector('select').focus();
  });
  return selected ? { ...action, workspaceAgentId: selected } : null;
}

// 既有公开命名空间协议：classic 消费方 app-core（欢迎态）与 workspace-actions
// （建会话选择）经 window.ClawFW.workspaceAgents 调用；workspace-actions 迁 ESM
// 后改为直接 import 上面两个命名导出。
window.ClawFW = window.ClawFW || {};
window.ClawFW.workspaceAgents = { getWelcomeName, selectForNewSession };
