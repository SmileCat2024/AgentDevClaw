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
 *   currentRuntimeAgentId, focusedAgentId, activeFeaturePanel
 */

// 上一次已加载模板映射的 runtime id（焦点切换时触发按 agent 重载）
let _lastTemplateRuntimeId = null;

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
    // 模板映射按 runtime agent 区分（URL 携带 ?agent= 编码）：焦点 runtime
    // 变化时清空映射与模板缓存并按新 agent 重载，避免上一个 agent 的
    // projectRoot 模板串染到当前 agent 的渲染。
    if (agentId !== _lastTemplateRuntimeId) {
      _lastTemplateRuntimeId = agentId;
      FEATURE_TEMPLATE_MAP = {};
      if (typeof clearFeatureTemplateCache === 'function') {
        clearFeatureTemplateCache();
      }
      loadFeatureTemplateMap().catch((e) => console.warn('[Viewer] Template map reload on switch failed:', e));
    }
    // GenUI badge 不在主轮询管线内（自管 3s 定时器），切换 runtime 时
    // 立即触发一次 poll，让红点数字与 todo badge 一样及时出现。
    if (window.GenUIPanel) window.GenUIPanel.forceRefresh();
    // 覆盖不经 switchAgent 的加载路径（如初始化恢复）；与 switchAgent 中的
    // 调用幂等，确保旧会话状态显示不会残留到新会话。
    resetRuntimeStatusForSwitch();
    activateUserCollapseStateForContext(getRuntimeContextKey(agentId));
    _lastCallFinishTime = 0;
    // 运行胶囊的计时起点是会话级数据，必须随切换清零：残留的旧会话起点
    // 会让新会话显示错误时长，且 confirmed 标志会拒绝更早的正确快照值，
    // 导致错误时长一直无法纠正。
    _runCapsuleStartAt = 0;
    _runCapsuleStartConfirmed = false;
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
      loadAgentDetail(focusedAgentId),
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
    // 目标不可用（远程条目未运行、转发失败等）时端点返回错误对象而非数组；
    // 归一化为空集合，避免下游迭代崩溃污染整个加载流程。
    const toolList = Array.isArray(tools) ? tools : [];
    const inputRequestList = Array.isArray(inputRequests) ? inputRequests : [];
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
    for (const tool of toolList) {
      nextToolRenderConfigs[tool.name] = tool;
      nextToolNames[tool.name] = DEFAULT_DISPLAY_NAMES[tool.name] || tool.name;
    }

    const committed = commitSessionViewPatch(loadToken, {
      hookInspector,
      overview: overviewSnapshot,
      todoPlan,
      messages: msgsData.messages || [],
      inputRequests: inputRequestList,
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
    // 上下文拦截状态拉取（session IPC）：仅在挂载了 ContextGuard 的工作空间
    // 进行，否则每个 poll 都会对不支持的 runtime 产生 503 噪音。
    const guardSupported = window.SessionControlsPanel?.isGuardAvailable?.() === true;
    const guardOwnerRecord = getCurrentRuntimeRecord() || getCurrentAgentRecord();
    const guardAgentId = String(getLogicalAgentId(guardOwnerRecord) || '').trim();
    const guardSessionId = String(getActiveSessionId(guardOwnerRecord) || '').trim();
    const guardStatusUrl = guardSupported && guardAgentId && guardSessionId
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
