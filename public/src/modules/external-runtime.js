/**
 * external-runtime.js — 外部 Runtime 关闭/重启
 * 从 app-main.js 拆出（Phase A-5）
 * 拆出日期：2026-07-03
 * ESM 化：P2 W2-6（2026-11-17）
 *
 * 依赖（ESM，装载顺序由 import 图确定）：
 *   - allAgents / loadAgentsInFlight（agent-store-state.js，live binding 引用）
 *   - 实时语言（i18n-environment-state.js 的 getCurrentLanguage；原 currentLanguage 词法）
 *   - loadAgents（agent-snapshot-loader-host.js）
 *   - markSidebarAuthoritativeMutation（sidebar-operations.js）
 *
 * 桥接期兼容面（KernelState defineKey/claim，domain: external-runtime）：
 *   refreshSidebarRuntimeAfterMutation——消费方仍是 classic 的 thread-store.js
 *   （归档后刷新）。该处迁 ESM 后改 import 并注销。右键重启/关闭入口
 *   （ctx-menu-handlers / ctx-menu-items）已直接 import，对应键已注销。
 */

import { allAgents, loadAgentsInFlight } from './agent-store-state.js';
import { getCurrentLanguage } from './i18n-environment-state.js';
import { loadAgents } from './agent-snapshot-loader-host.js';
import { markSidebarAuthoritativeMutation } from './sidebar-operations.js';

export function getExternalRuntimeAgent(agentId) {
  return allAgents.find((item) => item.id === agentId) || null;
}

export function isAssemblyExternalRuntime(agent) {
  return !!(
    agent
    && agent.source === 'external'
    && String(agent.active_workspace_session_form_id || '').trim() === 'assembly-form'
    && String(agent.active_workspace_session_id || '').trim()
  );
}

export async function closeExternalRuntime(agent) {
  if (isAssemblyExternalRuntime(agent)) {
    const sessionId = String(agent.active_workspace_session_id || '').trim();
    const response = await fetch('/protoclaw/assembly_runtime/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'stop assembly runtime failed'));
    }
    return response.json().catch(() => ({}));
  }

  const runtimeId = agent?.runtime_session_id || agent?.runtimeSessionId || agent?.id;
  const response = await fetch(`/api/agents/${encodeURIComponent(runtimeId)}`, { method: 'DELETE' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'close external runtime failed');
  }
  return payload;
}

export async function restartExternalRuntime(agent) {
  if (!isAssemblyExternalRuntime(agent)) {
    throw new Error(getCurrentLanguage() === 'zh'
      ? '当前外部 Agent 没有可用的重启宿主。'
      : 'This external agent does not expose a restart host.');
  }

  const sessionId = String(agent.active_workspace_session_id || '').trim();
  const ownerAgentId = String(agent.parent_id || 'agent-creator').trim() || 'agent-creator';

  await closeExternalRuntime(agent);

  const response = await fetch('/protoclaw/assembly_runtime/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: ownerAgentId, sessionId }),
  });
  if (!response.ok) {
    throw new Error(await response.text().catch(() => 'restart assembly runtime failed'));
  }
  return response.json().catch(() => ({}));
}

export async function resolveSidebarAssemblyRuntimeTarget(agent) {
  if (!agent || agent.source !== 'external') return null;

  const explicitSessionId = String(agent.active_workspace_session_id || '').trim();
  if (String(agent.active_workspace_session_form_id || '').trim() === 'assembly-form' && explicitSessionId) {
    return {
      ownerAgentId: String(agent.parent_id || 'flow-workspace').trim() || 'flow-workspace',
      sessionId: explicitSessionId,
    };
  }

  const runtimeName = String(agent.name || '').trim();
  if (!runtimeName) return null;

  const ownerCandidates = ['flow-workspace', 'agent-creator'];
  for (const ownerAgentId of ownerCandidates) {
    try {
      const response = await fetch(`/protoclaw/prebuilt_sessions?agentId=${encodeURIComponent(ownerAgentId)}`);
      if (!response.ok) continue;
      const data = await response.json().catch(() => null);
      const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
      const assemblyMatches = sessions.filter((session) =>
        String(session?.formId || '').trim() === 'assembly-form'
        && String(session?.agentName || '').trim() === runtimeName
      );
      if (!assemblyMatches.length) continue;

      const activeSessionId = String(data?.activeSessionId || '').trim();
      const activeMatch = assemblyMatches.find((session) => String(session?.id || '').trim() === activeSessionId);
      const chosen = activeMatch || assemblyMatches[0];
      const chosenId = String(chosen?.id || '').trim();
      if (chosenId) {
        return { ownerAgentId, sessionId: chosenId };
      }
    } catch (error) {
      console.warn('Failed to resolve sidebar assembly runtime target:', ownerAgentId, error);
    }
  }

  return null;
}

export async function closeSidebarExternalRuntime(agent) {
  const assemblyTarget = await resolveSidebarAssemblyRuntimeTarget(agent);
  if (assemblyTarget?.sessionId) {
    const response = await fetch('/protoclaw/assembly_runtime/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: assemblyTarget.sessionId }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'stop assembly runtime failed'));
    }
    return response.json().catch(() => ({}));
  }

  // 平台注册的外部 runtime（ADR-0037 注册协议）：停止指令经 server →
  // ViewerWorker 连接下发，runtime 自行优雅退出。
  if (agent?.external_registered === true) {
    const runtimeId = agent?.runtime_session_id || agent?.id;
    const response = await fetch('/protoclaw/external_runtime/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runtimeId }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || 'stop external runtime failed');
    }
    return payload;
  }

  throw new Error(getCurrentLanguage() === 'zh'
    ? '当前这个外部 Agent 还没有可用的关闭通道。'
    : 'This external agent does not currently expose a supported stop channel.');
}

export async function restartSidebarExternalRuntime(agent) {
  const assemblyTarget = await resolveSidebarAssemblyRuntimeTarget(agent);
  if (!assemblyTarget?.sessionId) {
    throw new Error(getCurrentLanguage() === 'zh'
      ? '当前这个外部 Agent 还没有可用的重启通道。'
      : 'This external agent does not expose a restart host.');
  }

  await closeSidebarExternalRuntime(agent);
  const ownerAgentId = String(assemblyTarget.ownerAgentId || agent?.parent_id || 'flow-workspace').trim() || 'flow-workspace';

  const response = await fetch('/protoclaw/assembly_runtime/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: ownerAgentId, sessionId: assemblyTarget.sessionId }),
  });
  if (!response.ok) {
    throw new Error(await response.text().catch(() => 'restart assembly runtime failed'));
  }
  return response.json().catch(() => ({}));
}

export async function refreshSidebarRuntimeAfterMutation() {
  // A completed mutation invalidates reads started before its receipt. Joining
  // the old in-flight poll is not a refresh; follow it with a post-commit read.
  markSidebarAuthoritativeMutation();
  if (loadAgentsInFlight) await loadAgentsInFlight;
  await loadAgents();
}

// —— 桥接期兼容面（kernel-state 访问器桥）——
// 保留原因：线程承接 thread-store.js 仍是 classic 文件，在调用时点经裸标识符
// （即 window 属性）取用。注销条件：thread-store 迁 ESM 后改 import。
// 右键菜单的两个入口（ctx-menu-handlers / ctx-menu-items）已直接 import，
// 对应 defineKey 已注销。
const bridgeApi = {
  refreshSidebarRuntimeAfterMutation,
};
window.KernelState.defineKey('external-runtime', 'refreshSidebarRuntimeAfterMutation', refreshSidebarRuntimeAfterMutation);
window.KernelState.claim('external-runtime', {
  get: (key) => bridgeApi[key],
  set: (key, value) => { bridgeApi[key] = value; },
});
