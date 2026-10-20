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
    // GenUI / 后台任务徽标都不在主轮询管线内（自管 3s 定时器），切换
    // runtime 时立即触发一次 poll，让红点数字与 todo badge 一样及时出现。
    if (window.GenUIPanel) window.GenUIPanel.forceRefresh();
    if (window.BgPanel) window.BgPanel.refreshBadge();
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
    // 各数据域独立提交：正文不等待详情/面板/输入请求，任一辅助请求失败也不
    // 丢弃已就绪的消息。所有生产者仍绑定同一次进入的 token。
    const loadPart = async (name, work) => {
      try {
        await work();
      } catch (error) {
        console.error(`Failed to load agent ${name}:`, error);
      }
    };
    const fetchJson = async (endpoint) => {
      const response = await fetch(`/api/agents/${agentId}/${endpoint}`);
      if (endpoint === 'todo' && !response.ok) return getEmptyTodoPlan();
      return response.json();
    };
    const messagesTask = loadPart('messages', async () => {
      const data = await fetchJson('messages');
      // 同会话的 SSE/poll 可能先提交更新；较早的全量响应不得回退正文。
      if (!isSessionViewTokenCurrent(loadToken) || !isSessionViewMessagesCurrent(loadToken)) return;
      commitSessionViewPatch(loadToken, {
        messages: attachMessagesTimestamps(data.messages || [], data.timestamps),
      }, ({ current }) => {
        recheckAutoTitleCandidate();
        if (current.messages.length > 0) clearChatLoadingSession();
        updateRollbackActionVisibility();
        renderCurrentMainView(current);
      });
    });

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
      batch_replace: 'Batch Replace',
      glob: 'Glob',
      grep: 'Grep',
      ls: 'LS',
    };

    const toolsTask = loadPart('tools', async () => {
      const tools = await fetchJson('tools');
      const toolList = Array.isArray(tools) ? tools : [];
      const nextToolRenderConfigs = {};
      const nextToolNames = {};
      for (const tool of toolList) {
        nextToolRenderConfigs[tool.name] = tool;
        nextToolNames[tool.name] = DEFAULT_DISPLAY_NAMES[tool.name] || tool.name;
      }
      commitSessionViewPatch(loadToken, {
        toolRenderConfigs: nextToolRenderConfigs,
        toolNames: nextToolNames,
      }, ({ previous, current }) => {
        // 工具配置决定历史卡片呈现。配置变更才重绘，消息不写回旧快照。
        if (current.messages.some((message) => message.role === 'tool' || message.toolCalls?.length > 0)
          && JSON.stringify(previous.toolRenderConfigs) !== JSON.stringify(current.toolRenderConfigs)) {
          renderCurrentMainView(current);
        }
        warmTemplatesInBackground(collectTemplateNames(toolList), agentId);
      });
    });
    const hooksTask = loadPart('hooks', async () => {
      const hookInspector = await fetchJson('hooks');
      commitSessionViewPatch(loadToken, { hookInspector }, () => renderFeaturePanel());
    });
    const overviewTask = loadPart('overview', async () => {
      const overview = await fetchJson('overview');
      commitSessionViewPatch(loadToken, { overview }, ({ current }) => {
        if (typeof updateChatContextBar === 'function') updateChatContextBar(current);
        if (typeof updateInputModelSwitcher === 'function') updateInputModelSwitcher();
        if (typeof updateThinkingEffortSwitcher === 'function') updateThinkingEffortSwitcher();
        if (activeFeaturePanel === 'workspace') renderFeaturePanel();
      });
    });
    const todoTask = loadPart('todo', async () => {
      const todoPlan = await fetchJson('todo');
      commitSessionViewPatch(loadToken, { todoPlan }, () => {
        if (typeof updatePlanBadge === 'function') updatePlanBadge();
        if (activeFeaturePanel === 'plan') renderFeaturePanel();
      });
    });
    const inputTask = loadPart('input requests', async () => {
      const inputRequests = await fetchJson('input-requests');
      commitSessionViewPatch(loadToken, {
        inputRequests: Array.isArray(inputRequests) ? inputRequests : [],
      }, () => updateRollbackActionVisibility());
    });
    const detailTask = loadPart('workspace detail', () => loadAgentDetail(focusedAgentId));
    const statusTask = loadPart('runtime status', async () => {
      await refreshCurrentRuntimeStatus(agentId, loadToken);
      if (!isSessionViewTokenCurrent(loadToken)) return;
      if (activeFeaturePanel === 'logs') {
        await loadLogs(true);
        if (!isSessionViewTokenCurrent(loadToken)) return;
      }
      renderFeaturePanel();
    });
    await Promise.all([messagesTask, toolsTask, hooksTask, overviewTask, todoTask, inputTask, detailTask, statusTask]);
  } catch (e) {
    console.error('Failed to load agent data:', e);
  }
}

/**
 * refreshCurrentRuntimeStatus 的 guard-only 轻量形态（SSE 激活时 poll 主循环
 * 调用）：notification/connection 由事件供数，本函数只拉 context_guard_status
 * （Claw 侧自持端点，不在 ViewerWorker 事件源内）。guard 不可用时为纯 no-op。
 */
async function refreshContextGuardStatus(
  runtimeId = currentRuntimeAgentId,
  viewToken = captureSessionViewToken(runtimeId),
) {
  const expectedRuntimeId = normalizeAgentIdentity(runtimeId);
  if (!expectedRuntimeId) return null;
  const guardSupported = window.ContextGuardToggle?.isAvailable?.() === true;
  if (!guardSupported) return null;
  const guardOwnerRecord = getCurrentRuntimeRecord() || getCurrentAgentRecord();
  const guardAgentId = String(getLogicalAgentId(guardOwnerRecord) || '').trim();
  const guardSessionId = String(getActiveSessionId(guardOwnerRecord) || '').trim();
  if (!guardAgentId || !guardSessionId) return null;
  try {
    const guardStatusUrl = `/protoclaw/context_guard_status?agentId=${encodeURIComponent(guardAgentId)}&sessionId=${encodeURIComponent(guardSessionId)}`;
    const guardRes = await fetch(guardStatusUrl).catch(() => null);
    if (!isSessionViewTokenCurrent(viewToken)) return null;
    const guardData = guardRes?.ok ? await guardRes.json() : null;
    if (!isSessionViewTokenCurrent(viewToken)) return null;
    commitSessionViewState(viewToken, () => {
      if (typeof applyContextGuardStatus === 'function') {
        applyContextGuardStatus(guardData, expectedRuntimeId);
      }
    });
    return guardData;
  } catch (error) {
    console.warn('Failed to refresh context guard status:', error);
    return null;
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
    const guardSupported = window.ContextGuardToggle?.isAvailable?.() === true;
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
      if (typeof applyContextGuardStatus === 'function') {
        applyContextGuardStatus(guardData, expectedRuntimeId);
      }
      updateNotificationStatus(notifData, expectedRuntimeId, viewToken);
    });
    return committed ? { notifData, connectionData } : null;
  } catch (error) {
    console.warn('Failed to refresh runtime status:', error);
    return null;
  }
}
