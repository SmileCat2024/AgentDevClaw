/**
 * external-runtime.js — 外部 Runtime 关闭/重启
 * 从 app-main.js 拆出（Phase A-5）
 * 拆出日期：2026-07-03
 *
 * 依赖全局状态（定义在 app-core.js）:
 *   allAgents, currentLanguage
 * 依赖全局函数:
 *   loadAgents (app-main.js)
 * 导出全局函数:
 *   getExternalRuntimeAgent, isAssemblyExternalRuntime,
 *   closeExternalRuntime, restartExternalRuntime,
 *   resolveSidebarAssemblyRuntimeTarget, closeSidebarExternalRuntime,
 *   restartSidebarExternalRuntime, refreshSidebarRuntimeAfterMutation
 */

function getExternalRuntimeAgent(agentId) {
  return allAgents.find((item) => item.id === agentId) || null;
}

function isAssemblyExternalRuntime(agent) {
  return !!(
    agent
    && agent.source === 'external'
    && String(agent.active_workspace_session_form_id || '').trim() === 'assembly-form'
    && String(agent.active_workspace_session_id || '').trim()
  );
}

async function closeExternalRuntime(agent) {
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

async function restartExternalRuntime(agent) {
  if (!isAssemblyExternalRuntime(agent)) {
    throw new Error(currentLanguage === 'zh'
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

async function resolveSidebarAssemblyRuntimeTarget(agent) {
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

async function closeSidebarExternalRuntime(agent) {
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

  throw new Error(currentLanguage === 'zh'
    ? '当前这个外部 Agent 还没有可用的关闭通道。'
    : 'This external agent does not currently expose a supported stop channel.');
}

async function restartSidebarExternalRuntime(agent) {
  const assemblyTarget = await resolveSidebarAssemblyRuntimeTarget(agent);
  if (!assemblyTarget?.sessionId) {
    throw new Error(currentLanguage === 'zh'
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

async function refreshSidebarRuntimeAfterMutation(delayMs = 0) {
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  await loadAgents();
}
