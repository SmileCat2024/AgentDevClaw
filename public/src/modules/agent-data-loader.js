/**
 * agent-data-loader.js
 *
 * Agent data loading and runtime status refresh.
 *
 * Extracted from app-main.js.
 *
 * Exported global functions:
 *   loadAgentData, refreshCurrentRuntimeStatus
 *
 * Dependencies (global state from app-core.js):
 *   currentRuntimeAgentId, currentAgentId, activeFeaturePanel
 */

async function loadAgentData(agentId) {
  if (isUiOnlyAgentId(agentId)) {
    currentRuntimeAgentId = null;
    applySessionViewPatch({ connected: true });
    updateNotificationStatus(null);
    resetRuntimeBackedSurfaceState();
    renderCurrentMainView();
    renderFeaturePanel();
    return;
  }
  const loadToken = captureSessionViewToken(agentId);
  try {
    currentRuntimeAgentId = agentId;
    // GenUI badge 不在主轮询管线内（自管 3s 定时器），切换 runtime 时
    // 立即触发一次 poll，让红点数字与 todo badge 一样及时出现。
    if (window.GenUIPanel) window.GenUIPanel.forceRefresh();
    // 覆盖不经 switchAgent 的加载路径（如初始化恢复）；与 switchAgent 中的
    // 调用幂等，确保旧会话状态显示不会残留到新会话。
    resetRuntimeStatusForSwitch();
    activateUserCollapseStateForContext(getRuntimeContextKey(agentId));
    _lastCallFinishTime = 0;
    _currentRecapText = '';
    _recapPendingTrigger = false;
    const [msgsRes, toolsRes, hooksRes, overviewRes, todoRes, inputRes] = await Promise.all([
      fetch(`/api/agents/${agentId}/messages`),
      fetch(`/api/agents/${agentId}/tools`),
      fetch(`/api/agents/${agentId}/hooks`),
      fetch(`/api/agents/${agentId}/overview`),
      fetch(`/api/agents/${agentId}/todo`),
      fetch(`/api/agents/${agentId}/input-requests`),
      // Ensure the host agent has full workspace_sessions (contextLength,
      // compressRatio, per-session model info) before the first render.
      // Without this, updateChatContextBar falls back to hardcoded defaults
      // because getConnectedAgents only returns light session records.
      loadAgentDetail(currentAgentId),
    ]);

    // Stale guard: if the user switched to a different agent during the
    // fetch, discard this response to prevent rendering stale data (flashback).
    if (!isSessionViewTokenCurrent(loadToken)) {
      return;
    }

    const [msgsData, tools, hookInspector, overviewSnapshot, todoPlan, inputRequests] = await Promise.all([
      msgsRes.json(),
      toolsRes.json(),
      hooksRes.json(),
      overviewRes.json(),
      todoRes.ok ? todoRes.json() : Promise.resolve(getEmptyTodoPlan()),
      inputRes.json(),
    ]);
    // Response headers may have arrived before a switch while one or more
    // bodies were still streaming/parsing. Never commit that older batch.
    if (!isSessionViewTokenCurrent(loadToken)) {
      return;
    }

    const DEFAULT_DISPLAY_NAMES = {
      // 系统工具
      run_shell_command: 'Bash',
      read_file: 'Read File',
      write_file: 'Write File',
      list_directory: 'List',
      web_fetch: 'Web',
      calculator: 'Calc',
      invoke_skill: 'Invoke Skill',
      spawn_agent: 'Spawn Agent',
      list_agents: 'List Agents',
      send_to_agent: 'Send to Agent',
      close_agent: 'Close Agent',
      // Opencode 工具
      read: 'Read',
      write: 'Write',
      edit: 'Edit',
      glob: 'Glob',
      grep: 'Grep',
      ls: 'LS',
    };

    const nextToolRenderConfigs = {};
    const nextToolNames = {};
    for (const tool of tools) {
      nextToolRenderConfigs[tool.name] = tool;
      nextToolNames[tool.name] = DEFAULT_DISPLAY_NAMES[tool.name] || tool.name;
    }

    const committed = commitSessionViewPatch(loadToken, {
      hookInspector,
      overview: overviewSnapshot,
      todoPlan,
      messages: msgsData.messages || [],
      inputRequests,
      toolRenderConfigs: nextToolRenderConfigs,
      toolNames: nextToolNames,
    }, ({ current }) => {
      recheckAutoTitleCandidate();
      // Only clear loading if messages arrived. If the runtime hasn't loaded
      // messages yet (common for freshly-created compacted resume sessions),
      // keep the spinner so the user doesn't see a premature empty welcome page.
      // The poll loop will clear it once real messages appear, and the 10s
      // timeout in beginChatLoadingSession is the ultimate fallback.
      if (current.messages.length > 0) clearChatLoadingSession();
      renderInputRequests(current.inputRequests);
      updateRollbackActionVisibility();
      renderCurrentMainView(current);
    });
    if (!committed) {
      return;
    }

    await refreshCurrentRuntimeStatus(agentId, loadToken);
    if (!isSessionViewTokenCurrent(loadToken)) {
      return;
    }
    if (activeFeaturePanel === 'logs') {
      await loadLogs(true);
      if (!isSessionViewTokenCurrent(loadToken)) {
        return;
      }
    }
    renderFeaturePanel();

    warmTemplatesInBackground(collectTemplateNames(tools), agentId);
  } catch (e) {
    console.error('Failed to load agent data:', e);
  }
}

async function refreshCurrentRuntimeStatus(
  runtimeId = currentRuntimeAgentId,
  viewToken = captureSessionViewToken(runtimeId),
) {
  const expectedRuntimeId = normalizeAgentIdentity(runtimeId);
  if (!expectedRuntimeId) return null;

  try {
    const guardOwnerRecord = getCurrentRuntimeRecord() || getCurrentAgentRecord();
    const guardAgentId = String(guardOwnerRecord?.parent_id || currentAgentId || guardOwnerRecord?.id || '').trim();
    const guardSessionId = String(guardOwnerRecord?.active_workspace_session_id || getActiveWorkspaceSessionId(guardOwnerRecord) || '').trim();
    const guardStatusUrl = guardAgentId && guardSessionId
      ? `/protoclaw/context_guard_status?agentId=${encodeURIComponent(guardAgentId)}&sessionId=${encodeURIComponent(guardSessionId)}`
      : null;
    const [notifRes, connectionRes, guardRes] = await Promise.all([
      fetch(`/api/agents/${expectedRuntimeId}/notification`),
      fetch(`/api/agents/${expectedRuntimeId}/connection`),
      guardStatusUrl ? fetch(guardStatusUrl).catch(() => null) : Promise.resolve(null),
    ]);

    if (!isSessionViewTokenCurrent(viewToken)) {
      return null;
    }
    if (!notifRes.ok || !connectionRes.ok) {
      return null;
    }

    const [notifData, connectionData, guardData] = await Promise.all([
      notifRes.json(),
      connectionRes.json(),
      guardRes?.ok ? guardRes.json() : Promise.resolve(null),
    ]);

    if (!isSessionViewTokenCurrent(viewToken)) {
      return null;
    }

    const committed = commitSessionViewPatch(viewToken, {
      connected: connectionData?.connected !== false,
    }, ({ current }) => {
      const runtimeRecord = getRuntimeRecord(expectedRuntimeId);
      if (runtimeRecord) {
        runtimeRecord.connected = current.connected;
      }
      setConnectionStatus(current.connected);
      if (typeof applyContextGuardStatus === 'function') {
        applyContextGuardStatus(guardData, expectedRuntimeId);
      }
      updateNotificationStatus(notifData);
    });
    return committed ? { notifData, connectionData } : null;
  } catch (error) {
    console.warn('Failed to refresh runtime status:', error);
    return null;
  }
}
