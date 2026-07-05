function normalizeAgentIdentity(value) {
  return String(value || '').trim();
}

function getCurrentHostAgentRecord() {
  const hostId = normalizeAgentIdentity(currentAgentId);
  if (!hostId) return null;
  return allAgents.find((agent) => normalizeAgentIdentity(agent?.id) === hostId) || null;
}

function getCurrentRuntimeRecord() {
  const runtimeId = normalizeAgentIdentity(currentRuntimeAgentId);
  if (!runtimeId) return null;
  const runtimeRecord = allAgents.find((agent) => {
    const agentId = normalizeAgentIdentity(agent?.id);
    const resolvedRuntimeId = normalizeAgentIdentity(getAgentRuntimeId(agent));
    return agentId === runtimeId || resolvedRuntimeId === runtimeId;
  }) || null;
  if (runtimeRecord) {
    return runtimeRecord;
  }
  const hostRecord = getCurrentHostAgentRecord();
  const hostRuntimeId = normalizeAgentIdentity(hostRecord?.runtime_session_id || hostRecord?.runtimeSessionId);
  if (hostRecord && hostRuntimeId && hostRuntimeId === runtimeId) {
    return hostRecord;
  }
  return null;
}

function getCurrentVisualAgentTitle() {
  const runtimeRecord = getCurrentRuntimeRecord();
  const hostRecord = getCurrentHostAgentRecord();
  if (runtimeRecord && normalizeAgentIdentity(currentRuntimeAgentId)) {
    return runtimeRecord.active_workspace_display_name
      || runtimeRecord.active_workspace_agent_name
      || runtimeRecord.active_workspace_session_title
      || runtimeRecord.name
      || hostRecord?.active_workspace_display_name
      || hostRecord?.active_workspace_session_title
      || hostRecord?.name
      || currentRuntimeAgentId;
  }
  return hostRecord?.name || t('page_title');
}

function updateCurrentAgentChrome() {
  if (!currentAgentTitle || !statusBadge) return;
  const hasSelection = normalizeAgentIdentity(currentAgentId) || normalizeAgentIdentity(currentRuntimeAgentId);
  if (!hasSelection) {
    currentAgentTitle.textContent = t('page_title');
    statusBadge.textContent = t('status_no_agent');
    statusBadge.classList.add('disconnected');
    return;
  }
  currentAgentTitle.textContent = getCurrentVisualAgentTitle();
  if (!normalizeAgentIdentity(currentRuntimeAgentId)) {
    statusBadge.textContent = currentLanguage === 'zh' ? '系统空间' : 'System';
    statusBadge.classList.remove('disconnected');
    return;
  }
  const runtimeRecord = getCurrentRuntimeRecord();
  const connected = runtimeRecord ? runtimeRecord.connected !== false : true;
  statusBadge.textContent = connected ? t('status_connected') : t('status_disconnected');
  statusBadge.classList.toggle('disconnected', !connected);
}

function isAgentActive(agent) {
  const agentId = normalizeAgentIdentity(agent?.id);
  const runtimeId = normalizeAgentIdentity(currentRuntimeAgentId);
  const hostId = normalizeAgentIdentity(currentAgentId);
  if (!agentId) return false;
  if (runtimeId) {
    if (agent?.source === 'prebuilt' && agentId === hostId) {
      return false;
    }
    return agentId === runtimeId && agentId === hostId;
  }
  return agentId === hostId;
}

function getCurrentAgentRecord() {
  return getCurrentHostAgentRecord();
}

function groupConnectedAgents(agents) {
  const TOOL_AGENT_IDS = new Set(['programming-helper']);
  const WORK_GROUP_IDS = new Set(['work-group']);
  const prebuiltIds = new Set(
    agents
      .filter((agent) => agent.source === 'prebuilt')
      .map((agent) => String(agent.id || '').trim())
      .filter(Boolean)
  );
  const orphanRuntimeAgents = agents.filter((agent) => {
    if (agent.source === 'prebuilt') return false;
    const parentId = String(agent.parent_id || '').trim();
    return !parentId || !prebuiltIds.has(parentId);
  });
  const allPrebuilt = agents.filter((agent) => agent.source === 'prebuilt');
  return {
    prebuilt: allPrebuilt.filter((agent) => !TOOL_AGENT_IDS.has(String(agent.id || '').trim()) && !WORK_GROUP_IDS.has(String(agent.id || '').trim())),
    workGroup: allPrebuilt.filter((agent) => WORK_GROUP_IDS.has(String(agent.id || '').trim())),
    tool: allPrebuilt.filter((agent) => TOOL_AGENT_IDS.has(String(agent.id || '').trim())),
    external: orphanRuntimeAgents,
  };
}

function isRuntimeItemActive(runtimeId) {
  const normalizedRuntimeId = normalizeAgentIdentity(runtimeId);
  return normalizedRuntimeId !== '' && normalizeAgentIdentity(currentRuntimeAgentId) === normalizedRuntimeId;
}

function toEpochMs(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return isNaN(parsed) ? 0 : parsed;
}

function getInputSurfaceMode(requests = currentInputRequests || []) {
  const chatActive = isChatSurfaceActive();
  if (!chatActive) return 'hidden';
  if (readOnlyMode) return 'readonly';

  const hasRuntimeSelected = !!currentRuntimeAgentId;
  const hasRequests = Array.isArray(requests) && requests.length > 0;
  const hasChoiceRequest = hasRequests && requests.some(isChoiceInputRequest);
  if (hasChoiceRequest) {
    return 'requests';
  }

  const hasLocalQueuedInput = hasRuntimeSelected
    && (_localQueuedInputPending || _pendingQueuedCount > 0 || _queuedTexts.length > 0);

  if (hasLocalQueuedInput && hasRuntimeSelected) {
    return 'persistent';
  }
  if (hasRequests) {
    return 'requests';
  }
  if (hasRuntimeSelected && isRuntimeCalling(currentRuntimeAgentId)) {
    return 'persistent';
  }
  if (hasRuntimeSelected) {
    return 'persistent';
  }
  return 'hidden';
}

function renderSidebarChildItems(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  return `
    <div class="agent-runtime-list">
      ${entries.map((entry) => {
        const active = isRuntimeItemActive(entry.runtimeId);
        const disconnected = entry.status === 'disconnected';
        const calling = !disconnected && isRuntimeCalling(entry.runtimeId);
        const restarting = restartingRuntimeIds.has(entry.runtimeId);
        const justFinished = !calling && !disconnected && !restarting && _recentlyFinishedRuntimes.has(entry.runtimeId);
        const itemClass = [
          'agent-item',
          'agent-runtime-item',
          active ? 'active' : '',
          disconnected ? 'disconnected' : '',
          calling ? 'calling' : '',
          restarting ? 'restarting' : '',
          justFinished ? 'just-finished' : '',
        ].filter(Boolean).join(' ');
        return `
          <div
            class="${itemClass}"
            data-agent-id="${escapeHtml(entry.runtimeId)}"
            data-agent-prebuilt="false"
            data-agent-context-menu="${entry.contextMenuEnabled ? 'true' : 'false'}"
            data-ctx-role="runtime" data-ctx-ns="${escapeHtml(entry.ownerId || '')}" data-ctx-id="${escapeHtml(entry.runtimeId)}" data-ctx-variant="${escapeHtml(entry.source || '')}" data-ctx-session-id="${escapeHtml(entry.sessionId || '')}"
          >
            <div class="agent-line">
              <span class="agent-status-dot"></span>
              <div class="agent-name">${escapeHtml(entry.name || entry.runtimeId)}</div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

const AGENT_ICONS = {
  'home': 'home.svg',
  'flow-workspace': 'flow-workspace.svg',
  'feature-repository': 'feature-repository.svg',
  'feature-creator': 'feature-creator.svg',
  'qqbot': 'qqbot.svg',
  'dispatch-console': 'dispatch-console.svg',
  'programming-helper': 'programming-helper.svg',
  'feature-setup': 'feature-setup.svg',
  'work-group': 'work-group.svg',
};

function getAgentIconHtml(agentId) {
  const iconFile = AGENT_ICONS[agentId];
  if (!iconFile) return '<span class="agent-status-dot"></span>';
  return `<img class="agent-icon" src="images/agent-icons/${iconFile}" alt="" draggable="false" />`;
}

function renderAgentGroup(listElement, groupElement, countElement, agents, options = {}) {
  const { prebuilt = false } = options;
  groupElement.style.display = agents.length ? '' : 'none';
  countElement.textContent = String(agents.length);
  listElement.innerHTML = agents.map((agent) => {
    const active = isAgentActive(agent);
    const connected = agent.connected !== false;
    const pending = pendingPrebuiltAgentIds.has(agent.id);
    const workspaceSurface = isWorkspaceSurfaceUnit(agent);
    const idle = prebuilt && !pending && !(agent.runtime_session_id || agent.runtimeSessionId);
    const runtimeId = agent.runtime_session_id || agent.runtimeSessionId || agent.id;
    const calling = !prebuilt
      && connected
      && !pending
      && !idle
      && (isRuntimeCalling(runtimeId) || agent.callActive === true);
    const justFinished = !prebuilt && !calling && connected && !idle && _recentlyFinishedRuntimes.has(runtimeId);
    const itemClass = [
      'agent-item',
      active ? 'active' : '',
      connected || prebuilt ? '' : 'disconnected',
      pending ? 'pending' : '',
      idle ? 'idle' : '',
      calling ? 'calling' : '',
      justFinished ? 'just-finished' : '',
    ].filter(Boolean).join(' ');
    const hasRuntime = !!(agent.runtime_session_id || agent.runtimeSessionId);
    const contextMenuEnabled = prebuilt
      ? (!workspaceSurface && hasRuntime)
      : !!(agent.runtime_session_id || agent.runtimeSessionId || agent.id);
    const childEntries = prebuilt ? collectRuntimeEntriesForPrebuilt(agent, allAgents) : [];
    const hasActiveRuntime = prebuilt && childEntries.some((entry) => isRuntimeItemActive(entry.runtimeId));
    if (prebuilt) {
      const childrenHtml = renderSidebarChildItems(childEntries);
      const entryClass = ['agent-entry', hasActiveRuntime ? 'has-active-runtime' : ''].filter(Boolean).join(' ');
      return `
        <div class="${entryClass}">
          <div
            class="${itemClass}"
            data-agent-id="${escapeHtml(agent.id)}"
            data-agent-prebuilt="true"
            data-agent-context-menu="${contextMenuEnabled ? 'true' : 'false'}"
          >
            <div class="agent-line">
              ${getAgentIconHtml(agent.id)}
              <div class="agent-name">${escapeHtml(agent.name || agent.id)}</div>
            </div>
          </div>
          ${childrenHtml}
        </div>
      `;
    }
    return `
      <div
        class="${itemClass}"
        data-agent-id="${escapeHtml(agent.id)}"
        data-agent-prebuilt="false"
        data-agent-context-menu="${contextMenuEnabled ? 'true' : 'false'}"
      >
        <div class="agent-line">
          <span class="agent-status-dot"></span>
          <div class="agent-name">${escapeHtml(agent.name || agent.id)}</div>
        </div>
      </div>
    `;
  }).join('');
}

async function waitForPrebuiltRuntimeSession(agentId, attempts = 20, options = {}) {
  const expectedRuntimeId = normalizeAgentIdentity(options.previousRuntimeId);
  const expectedSessionId = String(options.expectedSessionId || '').trim();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const agents = await invoke('get_connected_agents');
    const findConnectedChild = (list) => list.find((agent) => {
      if (agent.source !== 'child' || agent.parent_id !== agentId) return false;
      const runtimeId = normalizeAgentIdentity(agent.runtime_session_id || agent.runtimeSessionId || agent.id);
      if (!runtimeId) return false;
      if (expectedRuntimeId && runtimeId === expectedRuntimeId) return false;
      // When we know the target session ID, require the child to either
      // match it or have no session set yet (still initializing).
      if (expectedSessionId) {
        const childSessionId = String(agent.active_workspace_session_id || '').trim();
        if (childSessionId && childSessionId !== expectedSessionId) return false;
      }
      return agent.connected === true;
    });
    const matched = findConnectedChild(agents);
    if (matched) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const verify = await invoke('get_connected_agents');
      const still = findConnectedChild(verify);
      if (still) {
        // Merge verify into allAgents without clobbering workspace data.
        // get_connected_agents returns empty workspace_state, workspace_data,
        // and workspace_sessions.sessions for prebuilt agents, so we must
        // preserve the rich data loaded by loadAgentDetail.
        const prevById = new Map(allAgents.map(a => [a.id, a]));
        allAgents = verify.map(agent => {
          const prev = prevById.get(agent.id);
          if (!prev) return agent;
          return {
            ...agent,
            workspace_state: prev.workspace_state || agent.workspace_state,
            workspace_data: prev.workspace_data || agent.workspace_data,
            workspace_sessions: prev.workspace_sessions || agent.workspace_sessions,
          };
        });
        return still;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for runtime session: ${agentId}`);
}

async function loadAgents() {
  if (loadAgentsInFlight) {
    return loadAgentsInFlight;
  }
  const _t0 = performance.now();
  const task = (async () => {
  try {
    const [connectedAgents, res] = await Promise.all([
      invoke('get_connected_agents'),
      fetch('/api/agents'),
    ]);
    const data = res.ok ? await res.json().catch(() => ({ agents: [], currentAgentId: null })) : { agents: [], currentAgentId: null };
    const runtimeAgents = data.agents || [];
    const runtimeById = new Map(runtimeAgents.map((agent) => [agent.id, agent]));
    const prevByAgentId = new Map(allAgents.map((a) => [a.id, a]));

    if (connectedAgents.length === 0) {
      allAgents = runtimeAgents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        description: agent.description || '',
        status: agent.connected ? 'running' : 'stopped',
        source: 'external',
        parent_id: agent.parentAgentId || null,
        connection_info: agent.connectionInfo || 'viewer://127.0.0.1:2026',
        pid: agent.pid || null,
        runtime_session_id: agent.id,
        message_count: agent.messageCount ?? 0,
        created_at: agent.createdAt || null,
        connected: agent.connected ?? false,
      }));
    } else {
      allAgents = connectedAgents.map((agent) => {
        const runtimeSessionId = agent.runtime_session_id || agent.runtimeSessionId;
        const runtimeAgent = runtimeSessionId ? runtimeById.get(runtimeSessionId) : runtimeById.get(agent.id);
        const resolvedConnected = runtimeAgent?.connected ?? agent.connected ?? false;
        const prev = prevByAgentId.get(agent.id);
        return {
          ...agent,
          status: resolvedConnected ? 'running' : (agent.status || 'stopped'),
          message_count: runtimeAgent?.messageCount ?? agent.message_count ?? 0,
          connected: resolvedConnected,
          ...(prev && loadedAgentDetailIds.has(agent.id) ? {
            workspace_data: prev.workspace_data,
            workspace_state: prev.workspace_state,
            // Preserve prev sessions (get_connected_agents always returns
            // sessions: []), but merge in any fresh activeSessionId from
            // the server so activation changes are reflected.
            workspace_sessions: {
              ...(prev.workspace_sessions || {}),
              ...(agent.workspace_sessions?.activeSessionId
                && agent.workspace_sessions.activeSessionId !== prev.workspace_sessions?.activeSessionId
                ? { activeSessionId: agent.workspace_sessions.activeSessionId }
                : {}),
            },
          } : {}),
          // 当新数据的 workspace_sessions.sessions 为空但旧数据有值时，保留旧 sessions 避免闪空
          ...(!loadedAgentDetailIds.has(agent.id) && prev?.workspace_sessions?.sessions?.length > 0
            && !(agent.workspace_sessions?.sessions?.length > 0) ? {
              workspace_sessions: prev.workspace_sessions,
            } : {}),
        };
      });
    }

    // 清理已断开 agent 的 call 状态
    const activeRuntimeIds = new Set(allAgents.filter((a) => a.connected).map((a) => a.runtime_session_id || a.runtimeSessionId || a.id));
    for (const key of _agentCallActive.keys()) {
      if (!activeRuntimeIds.has(key)) _agentCallActive.delete(key);
    }
    for (const key of Array.from(_recentlyFinishedRuntimes)) {
      if (!activeRuntimeIds.has(key)) _recentlyFinishedRuntimes.delete(key);
    }

    if (!suppressSidebarRerender) {
      renderAgentList();
      // resources/viewer/settings 面板数据独立管理，跳过以避免编辑器/输入框失焦
      if (typeof activeFeaturePanel === 'undefined' || (activeFeaturePanel !== 'resources' && activeFeaturePanel !== 'viewer' && activeFeaturePanel !== 'settings')) {
        renderFeaturePanel();
      }
    }

    await refreshAgentCallStates(allAgents, { force: true });

    if (currentAgentId && !allAgents.some((agent) => agent.id === currentAgentId || getAgentRuntimeId(agent) === currentAgentId)) {
      const fallbackId = resolveWorkspaceFallbackAgentId();
      if (fallbackId) {
        await loadAgentDetail(fallbackId);
        selectWorkspaceSurface(fallbackId, { skipFeaturePanel: true });
        return;
      }
    }

    if (!currentAgentId) {
      const homeAgent = allAgents.find((agent) => agent.id === 'home' && agent.source === 'prebuilt');
      if (homeAgent) {
        setPreferredUnitMode('home', homeAgent);
        await loadAgentDetail(homeAgent.id);
        selectWorkspaceSurface(homeAgent.id, { skipFeaturePanel: true });
        return;
      }
      if (data.currentAgentId) {
        const runtimeCurrent = allAgents.find((agent) => (
          agent.connected !== false
          && (
            agent.id === data.currentAgentId
            || normalizeAgentIdentity(agent.runtime_session_id || agent.runtimeSessionId) === normalizeAgentIdentity(data.currentAgentId)
          )
        )) || null;
        if (runtimeCurrent) {
          currentAgentId = runtimeCurrent.parent_id || runtimeCurrent.id;
          await loadAgentData(getAgentRuntimeId(runtimeCurrent));
          return;
        }
      }
    }
  } catch (e) {
    console.error('Failed to load agents:', e);
  }
  })();
  loadAgentsInFlight = task;
  try {
    return await task;
  } finally {
    if (loadAgentsInFlight === task) {
      loadAgentsInFlight = null;
      console.log(`[PERF-CLIENT] loadAgents complete (${(performance.now() - _t0).toFixed(0)}ms)`);
    }
  }
}

// Desktop notification -> modules/desktop-notify.js

let _callStatesRefreshInProgress = false;
async function refreshAgentCallStates(agents = allAgents, options = {}) {
  const { force = false } = options;
  // 互斥锁：防止 Worker 心跳与常规 poll 并发执行导致重复触发通知
  if (_callStatesRefreshInProgress) return;
  const now = Date.now();
  if (!force && now - lastCallStateRefreshAt < 1000) {
    return;
  }
  _callStatesRefreshInProgress = true;
  lastCallStateRefreshAt = now;
  try {
    const runtimeIds = Array.from(new Set(
      (Array.isArray(agents) ? agents : [])
        .filter((agent) => agent?.connected)
        .map((agent) => agent.runtime_session_id || agent.runtimeSessionId || agent.id)
        .filter(Boolean)
    ));
    if (runtimeIds.length === 0) {
      let changed = false;
      for (const key of Array.from(_agentCallActive.keys())) {
        _agentCallActive.delete(key);
        _interruptSuppression.delete(key);
        changed = true;
      }
      if (changed) {
        renderAgentList();
      }
      return;
    }

    const nextCallStates = new Map();
    await Promise.all(runtimeIds.map(async (runtimeId) => {
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(runtimeId)}/notification`);
        if (!res.ok) return;
        const notifData = await res.json();
        nextCallStates.set(runtimeId, resolveNotificationCallingState(notifData));
      } catch (error) {
      }
    }));

    let changed = false;
    for (const runtimeId of runtimeIds) {
      const backendCalling = nextCallStates.get(runtimeId) === true;
      const prevCalling = _agentCallActive.get(runtimeId) === true;
      // 中断抑制窗口内忽略 backend 的 callActive:true
      const effectiveCalling = backendCalling && !isInterruptSuppressed(runtimeId);
      if (effectiveCalling) {
        _agentCallActive.set(runtimeId, true);
      } else {
        _agentCallActive.delete(runtimeId);
      }
      if (!backendCalling) {
        clearInterruptSuppression(runtimeId);
      }
      if (prevCalling !== effectiveCalling) {
        changed = true;
      }
      // 检测调用完成：true → false 转换，标记为"刚完成"
      if (prevCalling && !effectiveCalling) {
        if (normalizeAgentIdentity(runtimeId) !== normalizeAgentIdentity(currentRuntimeAgentId)) {
          _recentlyFinishedRuntimes.add(runtimeId);
        }
        _tryNotifyAgentFinished(runtimeId);
      }
    }

    const activeRuntimeIds = new Set(runtimeIds);
    for (const key of Array.from(_agentCallActive.keys())) {
      if (!activeRuntimeIds.has(key)) {
        _agentCallActive.delete(key);
        _interruptSuppression.delete(key);
        _recentlyFinishedRuntimes.delete(key);
        changed = true;
      }
    }

    for (const agent of Array.isArray(agents) ? agents : []) {
      if (agent?.source === 'prebuilt') {
        if (agent.callActive) {
          agent.callActive = false;
          changed = true;
        }
        continue;
      }
      const runtimeId = agent.runtime_session_id || agent.runtimeSessionId || agent.id;
      if (!runtimeId) continue;
      const nextCalling = nextCallStates.get(runtimeId) === true;
      if (agent.callActive !== nextCalling) {
        agent.callActive = nextCalling;
        changed = true;
      }
    }

    if (changed) {
      renderAgentList();
    }
  } finally {
    _callStatesRefreshInProgress = false;
  }
}

let lastAgentListRenderSignature = '';

function getAgentListRenderSignature() {
  return JSON.stringify({
    currentAgentId: normalizeAgentIdentity(currentAgentId),
    currentRuntimeAgentId: normalizeAgentIdentity(currentRuntimeAgentId),
    pending: Array.from(pendingPrebuiltAgentIds || []).sort(),
    restarting: Array.from(restartingRuntimeIds || []).sort(),
    recentlyFinished: Array.from(_recentlyFinishedRuntimes).sort(),
    agents: (Array.isArray(allAgents) ? allAgents : []).map((agent) => {
      const rid = normalizeAgentIdentity(getAgentRuntimeId(agent));
      return {
        id: normalizeAgentIdentity(agent?.id),
        runtimeId: rid,
        source: agent?.source || '',
        parentId: normalizeAgentIdentity(agent?.parent_id),
        connected: agent?.connected !== false,
        status: agent?.status || '',
        callActive: agent?.callActive === true,
        calling: rid !== '' && _agentCallActive.get(rid) === true,
        activeSessionId: normalizeAgentIdentity(agent?.active_workspace_session_id || agent?.workspace_sessions?.activeSessionId),
        displayName: agent?.active_workspace_display_name || '',
        sessionTitle: agent?.active_workspace_session_title || '',
      };
    }),
  });
}

function renderAgentList() {
  const nextSignature = getAgentListRenderSignature();
  if (nextSignature === lastAgentListRenderSignature) {
    updateCurrentAgentChrome();
    return;
  }
  lastAgentListRenderSignature = nextSignature;
  const groups = groupConnectedAgents(allAgents);
  renderAgentGroup(prebuiltAgentList, prebuiltGroup, prebuiltCount, groups.prebuilt, { prebuilt: true });
  renderAgentGroup(workGroupAgentList, workGroupGroup, workGroupCount, groups.workGroup, { prebuilt: true });
  renderAgentGroup(toolAgentList, toolGroup, toolCount, groups.tool, { prebuilt: true });
  renderAgentGroup(externalAgentList, externalGroup, externalCount, groups.external);

  updateCurrentAgentChrome();
}

agentList.addEventListener('click', async (event) => {
  const item = event.target.closest('.agent-item');
  if (!item) return;
  if (item.classList.contains('editing')) return;

  const agentId = item.dataset.agentId;
  if (!agentId) return;

  if (item.dataset.agentPrebuilt === 'true') {
    await window.handlePrebuiltAgentClick(agentId);
    return;
  }

  await window.switchAgent(agentId);
});

agentList.addEventListener('contextmenu', (event) => {
  const item = event.target.closest('.agent-item');
  if (!item) return;
  if (item.classList.contains('editing')) return;
  if (item.dataset.agentContextMenu !== 'true') return;

  // ── Generic ctx-menu: check for data-ctx-* on runtime items ──
  const ctxEl = item.closest('[data-ctx-role]');
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
      closeSessionContextMenu();
      closeCompactMenu();
      closeProjectContextMenu();
      const sessionId = ctxEl.dataset.ctxSessionId || '';
      window.showCtxMenu(event.clientX, event.clientY, items, { role, ns, id, variant, sessionId });
      return;
    }
  }

  const agentId = item.dataset.agentId;
  if (!agentId) return;

  event.preventDefault();
  window.openAgentActions(event, agentId);
});

window.handlePrebuiltAgentClick = async (agentId) => {
  closeAgentContextMenu();
  const prebuiltAgent = allAgents.find((agent) => agent.id === agentId && agent.source === 'prebuilt');
  if (!prebuiltAgent) return;
  if (!isWorkspaceHostUnit(prebuiltAgent)) {
    setPreferredUnitMode('home', prebuiltAgent);
  }

  if (isWorkspaceHostUnit(prebuiltAgent)) {
    currentAgentId = agentId;
    renderAgentList();
    if (!loadedAgentDetailIds.has(agentId)) {
      container.innerHTML = '<div class="workspace-surface" style="display:grid;place-items:center;color:var(--text-secondary);font-size:14px;">' + escapeHtml(currentLanguage === 'zh' ? '加载中...' : 'Loading...') + '</div>';
    }
    await loadAgentDetail(prebuiltAgent.id);
    selectWorkspaceSurface(prebuiltAgent.id, { skipFeaturePanel: true });
    return;
  }

  if (isWorkspaceSurfaceUnit(prebuiltAgent)) {
    currentAgentId = agentId;
    renderAgentList();
    if (!loadedAgentDetailIds.has(agentId)) {
      container.innerHTML = '<div class="workspace-surface" style="display:grid;place-items:center;color:var(--text-secondary);font-size:14px;">' + escapeHtml(currentLanguage === 'zh' ? '加载中...' : 'Loading...') + '</div>';
    }
    await loadAgentDetail(prebuiltAgent.id);
    selectWorkspaceSurface(prebuiltAgent.id, { skipFeaturePanel: true });
    return;
  }

  const runtimeSessionId = prebuiltAgent.runtime_session_id || prebuiltAgent.runtimeSessionId;
  if (runtimeSessionId) {
    await window.switchAgent(runtimeSessionId);
    return;
  }

  if (pendingPrebuiltAgentIds.has(agentId)) {
    return;
  }

  pendingPrebuiltAgentIds.add(agentId);
  statusBadge.textContent = t('status_starting');
  statusBadge.classList.remove('disconnected');
  renderAgentList();

  try {
    await invoke('start_agent', { agentId });
    const startedAgent = await waitForPrebuiltRuntimeSession(agentId);
    pendingPrebuiltAgentIds.delete(agentId);
    renderAgentList();
    const nextRuntimeId = startedAgent.runtime_session_id || startedAgent.runtimeSessionId || startedAgent.id;
    setPreferredUnitMode('home', allAgents.find((agent) => agent.id === agentId && agent.source === 'prebuilt') || startedAgent);
    await requestSwitch(nextRuntimeId, 'prebuilt-start');
  } catch (e) {
    pendingPrebuiltAgentIds.delete(agentId);
    renderAgentList();
    console.error('Failed to start prebuilt agent:', e);
    showAgentStartError(e);
  }
};

async function openPrebuiltWorkspaceSession(agentId, rawAction) {
  const action = typeof rawAction === 'string' ? JSON.parse(rawAction) : (rawAction || {});
  const endpoint = (action.type === 'create_session' || action.type === 'create_session_from_session')
    ? '/protoclaw/prebuilt_sessions'
    : '/protoclaw/prebuilt_sessions/activate';
  const payload = (action.type === 'create_session' || action.type === 'create_session_from_session')
    ? {
        agentId,
        sourceSessionId: action.sessionId || null,
        featureName: action.featureName || '',
        agentName: action.agentName || '',
        openDirectory: action.openDirectory || '',
        targetDir: action.targetDir || '',
      }
    : { agentId, sessionId: action.sessionId };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(await response.text().catch(() => 'session operation failed'));
  }
  return response.json();
}

function applyOptimisticWorkspaceSession(agentId, session) {
  if (!agentId || !session?.id) return null;
  const hostAgent = allAgents.find((agent) => agent.id === agentId) || null;
  const existingSessions = Array.isArray(hostAgent?.workspace_sessions?.sessions)
    ? hostAgent.workspace_sessions.sessions
    : [];
  const nextSessions = [session, ...existingSessions.filter((item) => item?.id !== session.id)];
  return updateAgentRecord(agentId, {
    workspace_sessions: {
      ...(hostAgent?.workspace_sessions || {}),
      activeSessionId: session.id,
      sessions: nextSessions,
    },
    active_workspace_session_id: session.id,
    active_workspace_session_form_id: session.formId || null,
    active_workspace_session_title: session.title || '',
    active_workspace_agent_name: session.agentName || '',
    active_workspace_display_name: session.formId === 'assembly-form'
      ? (session.agentName || session.title || '')
      : (hostAgent?.active_workspace_display_name || ''),
  });
}

async function createCompactedResumeSession(agentId, sessionId, strategy = 'summarized-nine-section', keepRecentTurns = null, fullPreserveFromTurn = null, extraPolicy = null) {
  const currentAgent = getCurrentAgentRecord();
  const activeSessionId = String(currentAgent?.active_workspace_session_id || currentAgent?.workspace_sessions?.activeSessionId || '').trim();
  const runtimeAgentId = currentRuntimeAgentId || currentAgent?.runtime_session_id || currentAgent?.runtimeSessionId || '';
  const isLiveCurrentSession = !!runtimeAgentId
    && String(currentAgent?.id || '').trim() === String(agentId || '').trim()
    && activeSessionId
    && activeSessionId === String(sessionId || '').trim();

  // Only use live-runtime shortcut for summary; trim (empty strategy) goes server-side
  if (isLiveCurrentSession && strategy) {
    const inputReqRes = await fetch(`/api/agents/${encodeURIComponent(runtimeAgentId)}/input-requests`);
    const inputRequests = inputReqRes.ok ? await inputReqRes.json().catch(() => []) : [];
    const primaryRequest = Array.isArray(inputRequests) ? inputRequests[0] : null;
    if (!primaryRequest?.requestId) {
      throw new Error('当前运行中的对话没有可用输入槽位，无法触发压缩续接');
    }
    const submitRes = await fetch(`/api/agents/${encodeURIComponent(runtimeAgentId)}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: primaryRequest.requestId,
        input: '/compact-summary-resume',
        response: {
          kind: 'text',
          text: '/compact-summary-resume',
        },
      }),
    });
    if (!submitRes.ok) {
      throw new Error(await submitRes.text().catch(() => 'failed to submit compact summary command'));
    }
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await loadAgents();
      const refreshed = allAgents.find((item) => String(item?.id || '').trim() === String(agentId || '').trim()) || null;
      const nextSessionId = String(refreshed?.active_workspace_session_id || refreshed?.workspace_sessions?.activeSessionId || '').trim();
      const nextRuntimeId = refreshed?.runtime_session_id || refreshed?.runtimeSessionId || null;
      if (nextSessionId && nextSessionId !== String(sessionId || '').trim() && nextRuntimeId) {
        beginChatLoadingSession();
        await requestSwitch(nextRuntimeId, 'compact-resume-live');
        return { scheduled: true, liveRuntime: true, switched: true };
      }
    }
    throw new Error(currentLanguage === 'zh'
      ? '摘要压缩超时：新会话在 120 秒内未创建成功。摘要可能仍在后台运行，请稍后在会话列表中检查，或重试。'
      : 'Summary compaction timed out: new session was not created within 120 seconds. The summary may still be running in the background — check the session list later or retry.');
  }

  const policy = strategy ? { strategy } : {};
  if (keepRecentTurns != null && keepRecentTurns >= 1) {
    policy.keepRecentTurns = keepRecentTurns;
  }
  if (fullPreserveFromTurn != null && fullPreserveFromTurn >= 0) {
    policy.fullPreserveFromTurn = fullPreserveFromTurn;
  }
  if (extraPolicy && typeof extraPolicy === 'object') {
    Object.assign(policy, extraPolicy);
  }
  const resumeResponse = await fetch('/protoclaw/context_handoffs/compact_and_resume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId,
      sessionId,
      detached: false,
      policy,
    }),
  });
  if (!resumeResponse.ok) {
    throw new Error(await resumeResponse.text().catch(() => 'compacted resume failed'));
  }

  return resumeResponse.json();
}

window.switchPhSessionTab = (btn) => {
  const tabGroup = btn.closest('.ph-session-tabs');
  if (!tabGroup) return;
  const targetTab = btn.dataset.phTab;
  // Update active tab indicator (visible when search is cleared later)
  tabGroup.querySelectorAll('.ph-session-tab').forEach((t) => t.classList.toggle('active', t.dataset.phTab === targetTab));
  if (tabGroup.dataset.tabGroup) {
    savedPhTabState[tabGroup.dataset.tabGroup] = targetTab;
  }
  // If currently searching, update tab filter and re-render search panel
  if (phSearchQuery.trim()) {
    phSearchTab = targetTab;
    const activeAgent = getCurrentAgentRecord();
    _updatePhSearchPanelDom(activeAgent?.id || 'programming-helper');
    return;
  }
  tabGroup.querySelectorAll('.ph-session-tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.phPanel === targetTab));
};

window.phToggleSessionSort = () => {
  phSessionSortMode = phSessionSortMode === 'createdAt' ? 'updatedAt' : 'createdAt';
  renderCurrentMainView();
};

window._buildPhSearchPanelHtml = (agentId) => {
  const isZh = currentLanguage === 'zh';
  if (!phSearchQuery.trim()) return '';
  if (phSearchLoading) {
    return '<div class="ph-search-status">' + escapeHtml(isZh ? '搜索中...' : 'Searching...') + '</div>';
  }
  if (phSearchResults === null) {
    return '<div class="ph-search-status">' + escapeHtml(isZh ? '正在构建搜索索引...' : 'Building search index...') + '</div>';
  }
  // Filter results by current tab
  const filtered = phSearchResults.filter((r) => {
    const st = r.sessionType || 'main';
    const isArchived = r.archived === true;
    if (phSearchTab === 'archived') return isArchived;
    if (phSearchTab === 'exploration') return st === 'exploration' && !isArchived;
    if (phSearchTab === 'sub') return st === 'sub' && !isArchived;
    // 'main' tab: non-archived, non-exploration, non-sub
    return !isArchived && st !== 'exploration' && st !== 'sub';
  });
  if (filtered.length === 0) {
    return '<div class="ph-search-status">' + escapeHtml(isZh ? '未找到匹配的对话' : 'No matching conversations found') + '</div>';
  }
  const queryEscaped = escapeHtml(phSearchQuery.trim());
  let html = '<div class="ph-search-status">' + escapeHtml((isZh ? '找到 ' : 'Found ') + filtered.length + (isZh ? ' 个结果' : ' results')) + '</div>';
  html += '<div class="feature-project-session-list">';
  html += filtered.map((r) => {
    const openAction = escapeHtml(JSON.stringify({ type: 'open_session', sessionId: r.sessionId }));
    let snippetHtml = escapeHtml(r.snippet);
    if (queryEscaped) {
      const safePattern = queryEscaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try {
        snippetHtml = snippetHtml.replace(new RegExp('(' + safePattern + ')', 'gi'), '<mark class="search-highlight">$1</mark>');
      } catch {}
    }
    const roleLabel = r.matchRole === 'user' ? (isZh ? '用户' : 'User') : r.matchRole === 'assistant' ? (isZh ? '助手' : 'Assistant') : '';
    return [
      '<div class="feature-project-session-item workspace-history-item ph-search-result-item" data-prebuilt-session-agent-id="' + escapeHtml(agentId) + '" data-prebuilt-session-id="' + escapeHtml(r.sessionId) + '">',
      '<div class="workspace-history-main">',
      '<div class="workspace-history-title-row">',
      '<div class="workspace-history-title">' + escapeHtml(r.title || r.sessionId) + '</div>',
      roleLabel ? '<span class="ph-search-role-badge">' + escapeHtml(roleLabel) + '</span>' : '',
      '</div>',
      '<div class="ph-search-snippet">' + snippetHtml + '</div>',
      '</div>',
      '<div class="workspace-history-side">',
      '<div class="workspace-actions stacked">',
      '<button class="workspace-action" type="button" data-workspace-action="' + openAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + escapeHtml(t('workspace_open_chat')) + '</button>',
      '</div>',
      '</div>',
      '</div>',
    ].join('');
  }).join('');
  html += '</div>';
  return html;
};

function _updatePhSearchPanelDom(agentId) {
  const panel = document.querySelector('.ph-search-panel');
  if (panel) panel.innerHTML = window._buildPhSearchPanelHtml(agentId);
}

window.phOnSearchInput = (value) => {
  phSearchQuery = value || '';
  if (_phSearchTimer) {
    clearTimeout(_phSearchTimer);
    _phSearchTimer = null;
  }
  const trimmed = phSearchQuery.trim();
  const activeAgent = getCurrentAgentRecord();
  const agentId = activeAgent?.id || 'programming-helper';

  // Update clear button visibility
  const clearBtn = document.querySelector('.ph-search-clear-btn');
  if (clearBtn) clearBtn.style.display = trimmed ? 'flex' : 'none';

  if (!trimmed) {
    // Clear search via DOM toggle — no full re-render
    phSearchResults = null;
    phSearchLoading = false;
    const tabsContainer = document.querySelector('.ph-session-tabs');
    if (tabsContainer) tabsContainer.classList.remove('searching');
    return;
  }

  // Switch to searching mode via CSS class — no full re-render
  const tabsContainer = document.querySelector('.ph-session-tabs');
  if (tabsContainer) tabsContainer.classList.add('searching');

  // Debounce the API call
  _phSearchTimer = setTimeout(async () => {
    const wsState = getAgentWorkspaceState(activeAgent);
    const openDirectory = String(wsState?.openDirectory || '').trim();
    // Show loading state in search panel
    phSearchLoading = true;
    phSearchResults = null;
    _updatePhSearchPanelDom(agentId);
    try {
      const params = new URLSearchParams({ agentId, q: trimmed, openDirectory });
      const resp = await fetch('/protoclaw/search_sessions?' + params.toString());
      if (!resp.ok) throw new Error('search failed');
      const data = await resp.json();
      // Guard against stale results
      if (phSearchQuery.trim() !== trimmed) return;
      phSearchResults = data.results || [];
      phSearchLoading = false;
      _updatePhSearchPanelDom(agentId);
    } catch (err) {
      if (phSearchQuery.trim() !== trimmed) return;
      phSearchResults = [];
      phSearchLoading = false;
      _updatePhSearchPanelDom(agentId);
    }
  }, 300);
};

window.phClearSearch = () => {
  phSearchQuery = '';
  phSearchResults = null;
  phSearchLoading = false;
  if (_phSearchTimer) { clearTimeout(_phSearchTimer); _phSearchTimer = null; }
  const input = document.querySelector('.ph-search-input');
  if (input) input.value = '';
  const clearBtn = document.querySelector('.ph-search-clear-btn');
  if (clearBtn) clearBtn.style.display = 'none';
  const tabsContainer = document.querySelector('.ph-session-tabs');
  if (tabsContainer) tabsContainer.classList.remove('searching');
  const panel = document.querySelector('.ph-search-panel');
  if (panel) panel.innerHTML = '';
};

/**
 * Open the unified ctx-menu for a session list item (triggered by ⋯ button).
 * Equivalent to right-clicking the session item — both use getCtxMenuItems('session', ...).
 */
window.phShowSessionCtxMenu = (event, button, agentId, sessionId, variant) => {
  if (event) { event.stopPropagation(); }
  const items = getCtxMenuItems('session', agentId, variant, sessionId);
  if (items.length === 0) return;
  const rect = button.getBoundingClientRect();
  window.closeCtxMenu();
  closeAgentContextMenu();
  closeSessionContextMenu();
  closeCompactMenu();
  closeProjectContextMenu();
  window.showCtxMenu(rect.right, rect.bottom, items, { role: 'session', ns: agentId, id: sessionId, variant, sessionId });
};

window.runWorkspaceAction = async (rawAction, triggerButton = undefined) => {
  let action = rawAction || {};
  if (typeof rawAction === 'string') {
    try {
      action = JSON.parse(rawAction);
    } catch {
      action = {};
    }
  }

  const activeAgent = getCurrentAgentRecord();
  if (typeof saveCurrentWorkspaceSurfaceScroll === 'function') {
    saveCurrentWorkspaceSurfaceScroll();
  }
  const hasSessions = hasWorkspaceSessions(activeAgent);
  const shouldMarkLoading = !!(
    activeAgent?.id
    && (
      action.type === 'show_chat'
      || action.type === 'resume_session'
      || action.type === 'open_session'
      || action.type === 'open_latest_session'
      || action.type === 'create_session'
      || action.type === 'create_session_from_session'
    )
  );
  if (action.type === 'open_latest_session') {
    if (activeAgent?.id === 'feature-creator') {
      const projects = getFeatureCreatorProjects(activeAgent);
      const latestProject = projects[0] || null;
      if (!latestProject) {
        return;
      }
      action = latestProject.latestSessionId
        ? { type: 'open_session', sessionId: latestProject.latestSessionId }
        : {
            type: 'create_session',
            featureName: latestProject.featureName || '',
            openDirectory: latestProject.openDirectory || '',
            targetDir: latestProject.targetDir || '',
          };
    } else if (activeAgent?.id === 'agent-creator') {
      const projects = getAgentCreatorProjects(activeAgent);
      const latestProject = projects[0] || null;
      if (!latestProject) {
        return;
      }
      action = latestProject.latestSessionId
        ? { type: 'open_session', sessionId: latestProject.latestSessionId }
        : {
            type: 'create_session',
            agentName: latestProject.agentName || '',
            openDirectory: latestProject.openDirectory || '',
            targetDir: latestProject.targetDir || '',
          };
    } else {
      const sessions = getWorkspaceSessions(activeAgent);
      if (sessions.length > 0) {
        action = { type: 'open_session', sessionId: sessions[0].id };
      } else {
        return;
      }
    }
  }

  if (action.type === 'navigate_unit' && action.targetAgentId) {
    await window.handlePrebuiltAgentClick(action.targetAgentId);
    return;
  }

  if (action.type === 'prime_workspace_form') {
    const formId = String(action.formId || '');
    const values = action.values && typeof action.values === 'object' ? action.values : {};
    if (activeAgent?.id) {
      const draft = getWorkspaceFormDraft(activeAgent);
      draft[formId] = normalizeWorkspaceStartupDraft(activeAgent, {
        ...(draft[formId] || {}),
        ...values,
      });
      saveWorkspaceFormDraft(activeAgent.id, draft);
    }
    setPreferredUnitMode(action.target ? `block:${String(action.target)}` : `block:${formId}`, activeAgent);
    renderCurrentMainView();
    return;
  }

  if (action.type === 'open_artifact_preview') {
    currentWorkspaceArtifactDetail = {
      agentId: activeAgent?.id || '',
      blockId: String(action.blockId || ''),
      artifactId: String(action.artifactId || ''),
    };
    renderCurrentMainView();
    return;
  }

  if (action.type === 'close_artifact_preview') {
    if (currentWorkspaceArtifactDetail && currentWorkspaceArtifactDetail.agentId === (activeAgent?.id || '') && currentWorkspaceArtifactDetail.blockId === String(action.blockId || '')) {
      currentWorkspaceArtifactDetail = null;
    }
    renderCurrentMainView();
    return;
  }

  if (action.type === 'open_project_docset_preview') {
    currentWorkspaceDocsetDetail = {
      agentId: activeAgent?.id || '',
      blockId: String(action.blockId || ''),
      section: String(action.section || ''),
      itemId: String(action.itemId || ''),
    };
    renderCurrentMainView();
    return;
  }

  if (action.type === 'close_project_docset_preview') {
    if (currentWorkspaceDocsetDetail && currentWorkspaceDocsetDetail.agentId === (activeAgent?.id || '') && currentWorkspaceDocsetDetail.blockId === String(action.blockId || '')) {
      currentWorkspaceDocsetDetail = null;
    }
    renderCurrentMainView();
    return;
  }

  if (action.type === 'apply_workspace_bundle') {
    await window.applyWorkspaceBundle(action.formId || 'assembly-form', action.bundle || {});
    return;
  }

  if (action.type === 'launch_assembly_instance') {
    await window.launchAssemblyInstance();
    return;
  }

  if (action.type === 'compacted_resume_session') {
    if (!activeAgent?.id || !action.sessionId) return;
    const confirmed = window.confirm(t('workspace_compacted_resume_confirm'));
    if (!confirmed) {
      return;
    }

    const isZh = currentLanguage === 'zh';
    const toastId = 'compact-resume-' + action.sessionId;
    ClawToast.show({
      id: toastId,
      title: isZh ? '正在创建轻量继续会话...' : 'Creating compacted resume session...',
      status: 'loading',
    });
    try {
      const result = await createCompactedResumeSession(activeAgent.id, action.sessionId);
      if (result?.agent) {
        applyManagedPrebuiltAgent(activeAgent.id, result.agent);
      }
      await loadAgents();
      const nextRuntimeId =
        result?.agent?.runtime_session_id
        || result?.agent?.runtimeSessionId
        || null;
      if (nextRuntimeId) {
        setPreferredUnitMode('chat', allAgents.find((agent) => agent.id === activeAgent.id) || activeAgent);
        beginChatLoadingSession();
        await requestSwitch(nextRuntimeId, 'compact-resume');
        ClawToast.update(toastId, {
          status: 'success',
          title: isZh ? '轻量继续会话已创建' : 'Compacted resume session created',
        });
      } else {
        lastRenderedWorkspaceHtml = '';
        renderCurrentMainView();
        ClawToast.update(toastId, {
          status: 'success',
          title: isZh ? '轻量继续会话已创建' : 'Compacted resume session created',
        });
      }
    } catch (error) {
      console.error('Failed to compact-resume session:', error);
      clearChatLoadingSession();
      ClawToast.update(toastId, {
        status: 'error',
        title: isZh ? '轻量继续失败' : 'Compacted resume failed',
        description: (error && error.message ? error.message : String(error)),
      });
    }
    return;
  }

  if (action.type === 'compact_session_menu') {
    if (!activeAgent?.id || !action.sessionId) return;
    const compactType = action.compactType || 'summary';

    if (compactType === 'trim') {
      window.openTrimDialog(activeAgent.id, action.sessionId);
      return;
    }

    const strategy = 'summarized-nine-section';
    const _csIsZh2 = currentLanguage === 'zh';
    const confirmMsg = action.archiveOriginal
      ? (_csIsZh2 ? '确定要总结当前会话历史并创建新会话？\n\n原会话将被自动归档。' : 'Summarize session history and create a new session?\n\nThe original session will be archived.')
      : t('workspace_compact_summary_confirm');
    const confirmed = window.confirm(confirmMsg);
    if (!confirmed) {
      return;
    }

    markSessionLoading(activeAgent.id, action.sessionId);
    const _csOldRuntimeId = currentRuntimeAgentId;
    const _csIsZh = currentLanguage === 'zh';
    const _csToastId = 'compact-summary-' + action.sessionId;
    ClawToast.show({
      id: _csToastId,
      title: _csIsZh ? '正在总结会话历史...' : 'Summarizing session history...',
      status: 'loading',
    });
    try {
      const result = await createCompactedResumeSession(activeAgent.id, action.sessionId, strategy);
      if (result?.liveRuntime && result?.switched) {
        // Live-runtime shortcut path: session switch was already handled
        // inside createCompactedResumeSession — skip normal agent/runtime logic
        await loadAgents();
        clearSessionLoading(activeAgent.id);
        ClawToast.update(_csToastId, {
          status: 'success',
          title: _csIsZh ? '会话总结完成' : 'Session summary completed',
        });
        if (action.archiveOriginal) {
          await archiveSessionAfterMutation(activeAgent.id, action.sessionId, _csOldRuntimeId);
        }
        return;
      }
      if (result?.agent) {
        applyManagedPrebuiltAgent(activeAgent.id, result.agent);
      }
      await loadAgents();
      const nextRuntimeId =
        result?.agent?.runtime_session_id
        || result?.agent?.runtimeSessionId
        || null;
      if (nextRuntimeId) {
        setPreferredUnitMode('chat', allAgents.find((agent) => agent.id === activeAgent.id) || activeAgent);
        beginChatLoadingSession();
        await requestSwitch(nextRuntimeId, 'compact-summary');
      } else {
        lastRenderedWorkspaceHtml = '';
        renderCurrentMainView();
      }
      ClawToast.update(_csToastId, {
        status: 'success',
        title: _csIsZh ? '会话总结完成' : 'Session summary completed',
      });
      if (action.archiveOriginal) {
        await archiveSessionAfterMutation(activeAgent.id, action.sessionId, _csOldRuntimeId);
      }
    } catch (error) {
      console.error('Failed to compact session:', error);
      clearSessionLoading(activeAgent.id);
      clearChatLoadingSession();
      ClawToast.update(_csToastId, {
        status: 'error',
        title: _csIsZh ? '总结失败' : 'Summary failed',
        description: (error?.message || String(error)),
      });
    }
    return;
  }

  if (action.type === 'view_session_record') {
    if (!action.agentId || !action.sessionId) return;
    readOnlyMode = true;
    const agentId = action.agentId;
    const sessionId = action.sessionId;
    try {
      const res = await fetch('/protoclaw/session_record?agentId=' + encodeURIComponent(agentId) + '&sessionId=' + encodeURIComponent(sessionId));
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      currentMessages = (data.messages || []).map(m => ({
        role: m.role,
        content: m.content,
      }));
      currentInputRequests = [];
      lastRenderedInputSignature = '';
      setPreferredUnitMode('chat', allAgents.find(a => a.id === agentId) || activeAgent);
      renderCurrentMainView();
    } catch (error) {
      console.error('Failed to load session record:', error);
      window.alert('Failed to load session record: ' + (error?.message || error));
      readOnlyMode = false;
    }
    return;
  }

  if (action.type === 'open_summary') {
    if (!action.agentId || !action.sessionId) return;
    window.openSummaryPopup(action.agentId, action.sessionId);
    return;
  }

  if (action.type === 'generate_summary') {
    if (!action.agentId || !action.sessionId) return;
    window.openSummaryPopup(action.agentId, action.sessionId);
    return;
  }

  if (action.type === 'delete_session') {
    if (!activeAgent?.id || !action.sessionId) return;
    const sessionTitle = action.sessionId;
    const confirmMsg = t('workspace_session_delete_confirm').replace('{{id}}', sessionTitle);
    const confirmed = window.confirm(confirmMsg);
    if (!confirmed) {
      return;
    }

    const targetAgent = allAgents.find((item) => item.id === activeAgent.id) || null;
    const affectedRuntimeId = targetAgent?.runtime_session_id || targetAgent?.runtimeSessionId || null;
    const deletedWasActive = action.sessionId === (targetAgent?.active_workspace_session_id || targetAgent?.workspace_sessions?.activeSessionId || null);
    const currentSessions = getWorkspaceSessions(targetAgent);

    if (deletedWasActive) {
      applyManagedPrebuiltAgent(activeAgent.id, null);
    }
    const remainingSessions = currentSessions.filter((s) => s.id !== action.sessionId);
    const nextActiveId = remainingSessions.length > 0
      ? (targetAgent?.active_workspace_session_id === action.sessionId ? remainingSessions[0].id : targetAgent?.active_workspace_session_id)
      : null;
    updateAgentRecord(activeAgent.id, {
      workspace_sessions: { sessions: remainingSessions, activeSessionId: nextActiveId },
      active_workspace_session_id: nextActiveId,
    });

    // Precise DOM removal for IM workspace sessions — avoid full re-render
    const imDraft = getIMWorkspaceDraft ? getIMWorkspaceDraft() : null;
    const isIMSession = Array.isArray(imDraft?.sessions);
    if (isIMSession) {
      const idx = imDraft.sessions.findIndex((s) => s.id === action.sessionId);
      if (idx !== -1) imDraft.sessions.splice(idx, 1);
      if (String(imDraft.workspaceConfig?.receptionistSessionId) === String(action.sessionId)) {
        imDraft.workspaceConfig.receptionistSessionId = '';
      }
      const el = document.querySelector('[data-prebuilt-session-id="' + CSS.escape(action.sessionId) + '"]');
      if (el) {
        el.style.transition = 'opacity 0.2s, transform 0.2s';
        el.style.opacity = '0';
        el.style.transform = 'translateX(-10px)';
        setTimeout(() => el.remove(), 200);
      }
    } else {
      shouldAnimateWorkspaceSurface = false;
      renderCurrentMainView();
    }

    try {
      const response = await fetch('/protoclaw/prebuilt_sessions/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: activeAgent.id,
          sessionId: action.sessionId,
        }),
      });
      if (!response.ok) {
        throw new Error(await response.text().catch(() => 'delete session failed'));
      }
      const result = await response.json();
      if (result?.deleted?.sessions) {
        updateAgentRecord(activeAgent.id, {
          workspace_sessions: result.deleted.sessions,
          active_workspace_session_id: result.deleted.activeSessionId || null,
        });
      }
      if (result?.agent) {
        applyManagedPrebuiltAgent(activeAgent.id, result.agent);
      }
      // Refresh IM workspace draft in background — no re-render needed if DOM already updated
      if (isIMSession) {
        ensureIMWorkspaceLoaded(true).catch(() => {});
      } else {
        loadAgents().catch(() => {});
      }
    } catch (error) {
      console.error('Failed to delete session:', error);
      updateAgentRecord(activeAgent.id, {
        workspace_sessions: { sessions: currentSessions, activeSessionId: targetAgent?.active_workspace_session_id },
        active_workspace_session_id: targetAgent?.active_workspace_session_id,
      });
      // Restore IM draft and re-render on failure
      if (isIMSession) {
        ensureIMWorkspaceLoaded(true).catch(() => {});
      }
      lastRenderedWorkspaceHtml = '';
      renderCurrentMainView();
      window.alert((currentLanguage === 'zh' ? '删除会话失败：' : 'Failed to delete session: ') + (error?.message || error));
    }
    return;
  }

  if (action.type === 'unarchive_session') {
    if (!activeAgent?.id || !action.sessionId) return;
    // Delegate to ctxArchiveSession which handles optimistic update + API + re-render
    ctxArchiveSession({ ns: activeAgent.id, id: action.sessionId });
    return;
  }

  if ((action.type === 'show_chat' || action.type === 'resume_session') && !hasSessions) {
    return;
  }

  const needsManagedSession =
    activeAgent?.source === 'prebuilt'
    && (
      action.type === 'create_session'
      || action.type === 'create_session_from_session'
      || action.type === 'open_session'
    );

  if (needsManagedSession) {
    beginChatLoadingSession();
    if (action.type === 'open_session' && action.sessionId) {
      markSessionLoading(activeAgent.id, action.sessionId);
    }
    if (triggerButton) markActionLoading(triggerButton);
    try {
      prebuiltSessionSwitchInFlight = true;
      const sessionAction = action.type === 'open_session'
        ? { type: 'open_session', sessionId: action.sessionId }
        : {
            type: action.type,
            sessionId: action.sessionId,
            formId: action.formId,
            featureName: action.featureName,
            agentName: action.agentName,
            openDirectory: action.openDirectory,
            targetDir: action.targetDir,
      };
      const runSessionOpen = async () => {
        const previousRuntimeId = normalizeAgentIdentity(activeAgent.runtime_session_id || activeAgent.runtimeSessionId || currentRuntimeAgentId);
        _storeVisibleSessionInputDraft();
        if (previousRuntimeId) {
          saveCurrentRuntimeToCache(previousRuntimeId, getRuntimeContextKey(previousRuntimeId, activeAgent));
        }
        const result = await openPrebuiltWorkspaceSession(activeAgent.id, sessionAction);
        const optimisticAgent = result?.session
          ? (applyOptimisticWorkspaceSession(activeAgent.id, result.session) || activeAgent)
          : activeAgent;
        // Immediately render the workspace surface so the user sees the new
        // session appear in the list without waiting for the runtime to start.
        if (!currentRuntimeAgentId) {
          lastRenderedWorkspaceHtml = '';
          renderCurrentMainView();
        }
        const isAssemblyLaunch =
          activeAgent?.id === 'agent-creator'
          && action.type === 'create_session'
          && String(action.formId || '') === 'assembly-form';
        const nextAgent = result?.agent ? (upsertConnectedAgent(result.agent) || result.agent) : null;
        if (isAssemblyLaunch) {
          setPreferredUnitMode('assembly', activeAgent);
          loadAgents().catch((error) => console.error('Failed to refresh agents after assembly launch:', error));
          renderCurrentMainView();
          return;
        }
        if (nextAgent?.runtime_session_id || nextAgent?.runtimeSessionId) {
          setPreferredUnitMode('chat', nextAgent);
          const nextRuntimeId = nextAgent.runtime_session_id || nextAgent.runtimeSessionId || nextAgent.id;
          if (nextRuntimeId === currentRuntimeAgentId) {
            beginFollowLatestEntryWindow();
            renderCurrentMainView();
          } else {
            await requestSwitch(nextRuntimeId, 'session-open');
          }
          loadAgents().catch((error) => console.error('Failed to refresh agents after opening prebuilt session:', error));
          return;
        }
        if (result?.status?.status === 'running' && result.status.viewerAgentId) {
          const existingRuntimeId = result.status.viewerAgentId;
          if (existingRuntimeId === currentRuntimeAgentId) {
            beginFollowLatestEntryWindow();
            renderCurrentMainView();
          } else {
            await loadAgents();
            await requestSwitch(existingRuntimeId, 'session-open-existing');
          }
          return;
        }
        try {
          const readyAgent = await waitForPrebuiltRuntimeSession(activeAgent.id, 30, {
            previousRuntimeId,
            expectedSessionId: result?.session?.id || '',
          });
          if (!readyAgent) return;
          const nextRuntimeId = readyAgent.runtime_session_id || readyAgent.runtimeSessionId || readyAgent.id;
          if (!nextRuntimeId) return;
          setPreferredUnitMode('chat', activeAgent);
          if (nextRuntimeId === currentRuntimeAgentId) {
            beginFollowLatestEntryWindow();
            renderCurrentMainView();
          } else {
            await requestSwitch(nextRuntimeId, 'session-open-wait');
          }
        } catch (error) {
          console.error('Failed while waiting for prebuilt runtime session:', error);
        } finally {
          loadAgents().catch((error) => console.error('Failed to refresh agents after waiting for prebuilt runtime:', error));
        }
      };
      const targetSession = sessionAction.type === 'open_session'
        ? getWorkspaceSessionById(activeAgent, sessionAction.sessionId)
        : null;
      const needsAssemblyDriftWarning = !!(
        targetSession
        && isAssemblySession(targetSession)
        && !isAssemblySessionRunning(activeAgent, targetSession)
        && (activeAgent?.id === 'flow-workspace' || activeAgent?.id === 'agent-creator')
      );
      if (needsAssemblyDriftWarning) {
        await maybeWarnAssemblySessionDrift(activeAgent, sessionAction.sessionId, runSessionOpen);
      } else {
        await runSessionOpen();
      }
    } catch (error) {
      console.error('Failed to open prebuilt session:', error);
      window.alert(`Session failed: ${error && error.message ? error.message : error}`);
      return;
    } finally {
      prebuiltSessionSwitchInFlight = false;
      // For create_session, the new session legitimately has 0 messages.
      // loadAgentData only clears loading when messages arrive, so clear
      // it here to avoid a 10s spinner on an intentionally empty session.
      if (action.type === 'create_session' || action.type === 'create_session_from_session') {
        clearChatLoadingSession();
        renderCurrentMainView();
      }
      if (shouldMarkLoading) clearSessionLoading(activeAgent.id);
      else if (triggerButton) triggerButton.classList.remove('action-loading');
    }
  }

  if (action.type === 'show_chat' || action.type === 'resume_session') {
    beginFollowLatestCooldown();
    beginFollowLatestEntryWindow();
    setPreferredUnitMode('chat', activeAgent);
  } else if (action.type === 'show_home') {
    setPreferredUnitMode('home', activeAgent);
  } else if (action.type === 'show_workspace_tab' && action.tab) {
    setPreferredUnitMode(String(action.tab), activeAgent);
  } else if (action.type === 'show_block' && action.target) {
    setPreferredUnitMode(`block:${action.target}`, activeAgent);
  }
  renderCurrentMainView();
};

window.toggleProjectDocsetOverlay = (force) => {
  if (typeof force === 'boolean') {
    currentProjectDocsetOpen = force;
  } else {
    currentProjectDocsetOpen = !currentProjectDocsetOpen;
  }
  updateProjectDocsetChrome(getCurrentAgentRecord());
};

window.setProjectDocsetPage = (page) => {
  currentProjectDocsetPage = ['requirement', 'log', 'materials'].includes(page) ? page : 'requirement';
  renderCurrentMainView();
};

window.startProjectRequirementEdit = () => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  currentProjectDocsetPage = 'requirement';
  currentProjectRequirementEdit = { agentId: agent.id };
  renderCurrentMainView();
};

window.cancelProjectRequirementEdit = () => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  resetProjectRequirementDraft(agent);
  currentProjectRequirementEdit = null;
  renderCurrentMainView();
};

window.saveProjectRequirementForm = async () => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const forms = getWorkspaceFormDraft(agent);
  try {
    await persistWorkspaceState(agent, forms, {
      openDirectory: getAgentWorkspaceState(agent)?.openDirectory || '',
    });
    currentProjectRequirementEdit = null;
    await loadAgents();
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to save project requirement form:', error);
  }
};

window.openProjectMaterialImport = (mode = 'files') => {
  window.importProjectMaterialsByPath(mode).catch((error) => {
    console.error('Failed to open project material import:', error);
  });
};

window.importProjectMaterialsByPath = async (mode = 'files') => {
  const agent = getCurrentAgentRecord();
  const docset = getCurrentProjectDocset(agent);
  if (!agent?.id || !docset?.projectDir) return;

  try {
    let materials = [];
    if (mode === 'folder') {
      const selected = await invoke('select_directory');
      if (!selected || selected.cancelled || !selected.path) return;
      materials = [{
        name: getPathLeaf(selected.path) || selected.path,
        sourcePath: selected.path,
        sourceKind: 'directory',
      }];
    } else {
      const selected = await invoke('select_files');
      const paths = Array.isArray(selected?.paths) ? selected.paths.filter(Boolean) : [];
      if (!paths.length) return;
      materials = paths.map((sourcePath) => ({
        name: getPathLeaf(sourcePath) || sourcePath,
        sourcePath,
        sourceKind: 'file',
      }));
    }

    const response = await fetch('/protoclaw/project_docset/import_materials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: agent.id,
        projectDir: docset.projectDir,
        mode,
        materials,
      }),
    });

    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'Failed to import materials'));
    }

    await loadAgents();
    currentProjectDocsetPage = 'materials';
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to import project materials:', error);
  }
};

window.runWorkspaceActionFromEvent = async (event, rawAction) => {
  const btn = event?.target instanceof Element ? event.target.closest('button[data-workspace-action]') : null;
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  await window.runWorkspaceAction(rawAction, btn || undefined);
};

document.addEventListener('click', (event) => {
  const actionButton = event.target instanceof Element
    ? event.target.closest('button[data-workspace-action]')
    : null;
  if (!actionButton) return;
  if (actionButton.classList.contains('compact-trigger')) return;
  event.preventDefault();
  event.stopPropagation();
  if (typeof event.stopImmediatePropagation === 'function') {
    event.stopImmediatePropagation();
  }
  const rawAction = actionButton.dataset?.workspaceAction || '';
  window.runWorkspaceAction(rawAction, actionButton).catch((error) => {
    console.error('Failed to handle delegated workspace action:', error);
  });
}, true);

// ── assembly actions → modules/assembly-actions.js (Phase C, 2026-07-04) ──


// ── PH 项目操作 / Model Config → modules/ph-project-actions.js (Phase A-4, 2026-07-03) ──

// ── ctx-menu items / dispatcher → modules/ctx-menu-items.js (Phase B-2, 2026-07-04) ──

window.showCompactMenu = (event, buttonElement) => {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  const rawAction = buttonElement?.dataset?.workspaceAction;
  let action = {};
  try {
    action = typeof rawAction === 'string' ? JSON.parse(rawAction) : rawAction;
  } catch {
    return;
  }

  if (!action.sessionId) return;

  const rect = buttonElement.getBoundingClientRect();
  openCompactMenu(action, rect.left, rect.bottom + 4);
};


function markSessionLoading(agentId, sessionId) {
  const el = document.querySelector(
    `.workspace-history-item[data-prebuilt-session-agent-id="${CSS.escape(agentId)}"][data-prebuilt-session-id="${CSS.escape(sessionId)}"]`
  );
  if (el) el.classList.add('session-loading');
}

function markActionLoading(buttonEl) {
  if (buttonEl) buttonEl.classList.add('action-loading');
}

function clearSessionLoading(agentId) {
  document.querySelectorAll(`.workspace-history-item.session-loading[data-prebuilt-session-agent-id="${CSS.escape(agentId)}"]`)
    .forEach(el => el.classList.remove('session-loading'));
  document.querySelectorAll('.workspace-action.action-loading')
    .forEach(el => el.classList.remove('action-loading'));
}

 // ── assembly session operations → modules/assembly-actions.js (Phase C, 2026-07-04) ──


/**
 * Flush the pending switch slot: if the serial still matches, execute the
 * actual switchAgent call and clear the slot.  Only the most recent
 * requestSwitch() call wins; stale flushes are silently discarded.
 */
function flushPendingSwitch(serial, resolve) {
  if (!pendingSwitchTarget || pendingSwitchTarget.serial !== serial) {
    resolve({ switched: false, reason: 'superseded' });
    return;
  }
  const runtimeId = pendingSwitchTarget.runtimeId;
  pendingSwitchTarget = null;
  window.switchAgent(runtimeId).then(
    () => resolve({ switched: true }),
    (e) => resolve({ switched: false, reason: e?.message }),
  );
}

/**
 * Request a deferred agent switch.  The call-site is an async operation
 * that has just completed (B-class).  The target is written to the
 * "pending switch slot"; only the most recent caller's serial wins.
 *
 * Returns a Promise so callers can still `await` it; resolves with
 * { switched: true } or { switched: false, reason }.
 *
 * @param {string} runtimeId  The runtime agent id to switch to.
 * @param {string} source     A short label for debugging (e.g. 'launch', 'restart').
 */
function requestSwitch(runtimeId, source) {
  pendingSwitchSerial += 1;
  const serial = pendingSwitchSerial;
  pendingSwitchTarget = { runtimeId, serial, source };
  return new Promise((resolve) => {
    setTimeout(() => flushPendingSwitch(serial, resolve), 0);
  });
}

window.switchAgent = async (newAgentId) => {
  // A-class (direct) calls cancel any pending deferred switch.
  pendingSwitchTarget = null;
  const epoch = ++_switchEpoch;
  closeAgentContextMenu();
  const targetAgent = findAgentByIdentity(newAgentId);
  const requestedRuntimeOfWorkspaceHost = !!(
    targetAgent
    && isWorkspaceHostUnit(targetAgent)
    && newAgentId
    && newAgentId !== targetAgent.id
    && (targetAgent.runtime_session_id === newAgentId || targetAgent.runtimeSessionId === newAgentId)
  );
  const runtimeAgentId = requestedRuntimeOfWorkspaceHost
    ? newAgentId
    : (targetAgent ? getAgentRuntimeId(targetAgent) : newAgentId);
  if (!runtimeAgentId) return;
  if (isWorkspaceSurfaceUnit(targetAgent) && !requestedRuntimeOfWorkspaceHost) {
    if (targetAgent?.id === currentAgentId && !currentRuntimeAgentId) return;
    selectWorkspaceSurface(targetAgent.id);
    return;
  }
  if (targetAgent?.id === currentAgentId && runtimeAgentId === currentRuntimeAgentId) return;
  _storeVisibleSessionInputDraft();
  if (typeof saveCurrentWorkspaceSurfaceScroll === 'function') {
    saveCurrentWorkspaceSurfaceScroll();
  }
  if (currentRuntimeAgentId && !readOnlyMode) {
    saveCurrentRuntimeToCache(currentRuntimeAgentId);
  }
  try {
    // Set global state and do optimistic render IMMEDIATELY — before the PUT.
    // This lets the user see cached data without waiting for a network round trip.
    currentAgentId = targetAgent?.parent_id || targetAgent?.id || runtimeAgentId;
    currentRuntimeAgentId = runtimeAgentId;
    _recentlyFinishedRuntimes.delete(runtimeAgentId);
    readOnlyMode = false;
    currentWorkspaceArtifactDetail = null;
    currentWorkspaceDocsetDetail = null;
    currentProjectDocsetOpen = false;
    currentProjectRequirementEdit = null;
    currentProjectDocsetPage = 'requirement';
    currentWorkspaceTab = 'chat';
    // Clear chat render dedup so the new agent's messages always rebuild the DOM
    _lastRenderedChatSig = '';
    activateUserCollapseStateForContext(getRuntimeContextKey(runtimeAgentId));
    // Optimistic restore: show cached data immediately if available
    const _restored = restoreRuntimeFromCache(runtimeAgentId);
    if (_restored) {
      lastRenderedWorkspaceHtml = '';
      // Restore scroll position from cache before render so render() can preserve it
      if (_restoredScrollTop != null) {
        container.scrollTop = _restoredScrollTop;
      }
      _restoredScrollTop = null;
      renderCurrentMainView();
      renderFeaturePanel();
    } else {
      // No cache: clear stale messages to prevent poll race mixing old/new agent content
      setCurrentOverviewSnapshot(getEmptyOverviewSnapshot());
      setCurrentTodoPlan(getEmptyTodoPlan());
      currentMessages = [];
      renderCurrentMainView();
      setFollowLatest(true);
    }
    beginFollowLatestCooldown();
    beginFollowLatestEntryWindow();
    renderAgentList();

    // Pre-warm calling status for the new runtime in parallel with PUT + loadAgentData.
    // For dispatched agents not yet tracked by refreshAgentCallStates, this eliminates
    // the window where the send button incorrectly shows because _agentCallActive has
    // no entry for this runtime yet.
    fetch(`/api/agents/${encodeURIComponent(runtimeAgentId)}/notification`)
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (!data) return;
        if (normalizeAgentIdentity(currentRuntimeAgentId) !== normalizeAgentIdentity(runtimeAgentId)) return;
        const isCalling = resolveNotificationCallingState(data);
        if (isCalling) {
          _agentCallActive.set(runtimeAgentId, true);
        } else {
          _agentCallActive.delete(runtimeAgentId);
        }
        _syncPersistentActionButton();
        renderAgentList();
      })
      .catch(() => {});

    // Fire PUT in parallel with loadAgentData — loadAgentData uses explicit
    // agentId in all fetch URLs, so it doesn't depend on the PUT completing.
    const _putPromise = fetch('/api/agents/current', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: runtimeAgentId })
    }).then((res) => {
      if (!res.ok && res.status !== 404) {
        console.warn(`Switch PUT returned ${res.status} ${res.statusText}`);
      }
    }).catch((e) => {
      console.warn('Switch PUT failed:', e?.message || e);
    });

    await loadAgentData(runtimeAgentId);
    await _putPromise;
    // Only refresh the agent list if no newer switch has happened — a stale
    // switchAgent continuation could otherwise trigger loadAgentData for the
    // wrong agent via the loadAgents() initialization path (PUT race).
    if (epoch === _switchEpoch) {
      loadAgents().catch((error) => console.error('Failed to refresh agents after switch:', error));
    }
  } catch (e) {
    console.error('Failed to switch agent:', e);
    window.alert(`Switch failed: ${e && e.message ? e.message : e}`);
  }
};

window.openAgentActions = (event, agentId) => {
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
};

// ── External Runtime Close/Restart → modules/external-runtime.js (Phase A-5, 2026-07-03) ──

restartAgentAction.addEventListener('click', async () => {
  if (!contextMenuAgentId || (contextMenuAgentMode !== 'prebuilt-runtime' && contextMenuAgentMode !== 'external-runtime' && contextMenuAgentMode !== 'child-runtime')) return;
  const confirmed = window.confirm(t('restart_prebuilt_confirm'));
  if (!confirmed) {
    closeAgentContextMenu();
    return;
  }

  try {
    const agent = getExternalRuntimeAgent(contextMenuAgentId);
    // Clear cached data — restart creates a fresh session
    clearAgentRuntimeCache(contextMenuAgentId);
    const runtimeItem = document.querySelector(`[data-agent-id="${CSS.escape(contextMenuAgentId)}"]`);
    if (runtimeItem) {
      runtimeItem.classList.add('restarting');
      runtimeItem.classList.remove('active', 'disconnected');
    }
    suppressSidebarRerender = true;
    let result = null;
    if (contextMenuAgentMode === 'external-runtime') {
      closeAgentContextMenu();
      result = await restartSidebarExternalRuntime(agent);
    } else if (contextMenuAgentMode === 'child-runtime') {
      const hostId = agent?.parent_id || contextMenuAgentId;
      const sessionId = agent?.active_workspace_session_id || null;
      closeAgentContextMenu();
      result = await invoke('restart_agent', { agentId: hostId, sessionId });
    } else {
      const sessionId = agent?.active_workspace_session_id || agent?.workspace_sessions?.activeSessionId || null;
      closeAgentContextMenu();
      result = await invoke('restart_agent', { agentId: contextMenuAgentId, sessionId });
    }
    const nextRuntimeId =
      result?.runtime?.id
      || result?.runtime?.viewerAgentId
      || result?.agent?.runtime_session_id
      || result?.agent?.runtimeSessionId
      || null;
    if (nextRuntimeId) {
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const agents = await invoke('get_connected_agents');
          const found = agents.find((a) => a.runtime_session_id === nextRuntimeId || a.id === nextRuntimeId);
          if (found && found.connected !== false) break;
        } catch (_) { /* ignore */ }
      }
    }
    suppressSidebarRerender = false;
    await loadAgents();
    if (nextRuntimeId) {
      await requestSwitch(nextRuntimeId, 'restart-handler');
    }
  } catch (e) {
    suppressSidebarRerender = false;
    closeAgentContextMenu();
    window.alert(t('restart_failed') + (e && e.message ? e.message : e));
  }
});

stopAgentAction.addEventListener('click', async () => {
  if (!contextMenuAgentId || (contextMenuAgentMode !== 'prebuilt-runtime' && contextMenuAgentMode !== 'external-runtime' && contextMenuAgentMode !== 'child-runtime')) return;
  const confirmed = window.confirm(t('close_prebuilt_confirm'));
  if (!confirmed) {
    closeAgentContextMenu();
    return;
  }

  try {
    const agent = getExternalRuntimeAgent(contextMenuAgentId);
    const affectedRuntimeId = agent?.runtime_session_id || agent?.runtimeSessionId || agent?.id || null;
    // Clear cached data — runtime is being stopped
    if (affectedRuntimeId) clearAgentRuntimeCache(affectedRuntimeId);
    if (contextMenuAgentMode === 'external-runtime') {
      await closeSidebarExternalRuntime(agent);
    } else if (contextMenuAgentMode === 'child-runtime') {
      const hostId = agent?.parent_id || contextMenuAgentId;
      const sessionId = agent?.active_workspace_session_id || null;
      await invoke('stop_agent', { agentId: hostId, sessionId });
    } else {
      await invoke('stop_agent', { agentId: contextMenuAgentId });
    }
    closeAgentContextMenu();
    await refreshSidebarRuntimeAfterMutation(500);
    if (affectedRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
      const fallbackTarget = contextMenuAgentMode === 'external-runtime'
        ? (agent?.parent_id || resolveWorkspaceFallbackAgentId(agent))
        : contextMenuAgentMode === 'child-runtime'
          ? (agent?.parent_id || resolveWorkspaceFallbackAgentId(agent))
          : resolveWorkspaceFallbackAgentId(agent);
      if (fallbackTarget) {
        selectWorkspaceSurface(fallbackTarget);
      }
    }
  } catch (e) {
    closeAgentContextMenu();
    window.alert(t('close_failed') + (e && e.message ? e.message : e));
  }
});

openSessionAction.addEventListener('click', async () => {
  if (!contextMenuSessionAgentId || !contextMenuSessionId) return;
  const sessionId = contextMenuSessionId;
  const mode = contextMenuSessionMode;
  closeSessionContextMenu();
  if (mode === 'assembly') {
    await window.launchSavedAssemblyRun(sessionId);
  } else {
    await window.runWorkspaceAction(JSON.stringify({ type: 'open_session', sessionId }));
  }
});

compactedResumeSessionAction.addEventListener('click', async () => {
  if (!contextMenuSessionAgentId || !contextMenuSessionId) return;
  if (contextMenuSessionMode === 'assembly') {
    closeSessionContextMenu();
    return;
  }
  const sessionId = contextMenuSessionId;
  closeSessionContextMenu();
  await window.runWorkspaceAction(JSON.stringify({
    type: 'compacted_resume_session',
    sessionId,
  }));
});

compactSummaryAction.addEventListener('click', async () => {
  if (!contextMenuCompactAction?.sessionId) return;
  const action = { ...contextMenuCompactAction, compactType: 'summary' };
  closeCompactMenu();
  await window.runWorkspaceAction(action);
});

compactTrimAction.addEventListener('click', async () => {
  if (!contextMenuCompactAction?.sessionId) return;
  const action = { ...contextMenuCompactAction, compactType: 'trim' };
  closeCompactMenu();
  await window.runWorkspaceAction(action);
});

compactBranchAction.addEventListener('click', () => {
  if (!contextMenuCompactAction?.sessionId) return;
  const sessionId = contextMenuCompactAction.sessionId;
  const activeAgent = getCurrentAgentRecord();
  if (!activeAgent?.id) return;
  closeCompactMenu();
  window.openBranchDialog(activeAgent.id, sessionId);
});

deleteAgentAction.addEventListener('click', async () => {
  if (!contextMenuAgentId || contextMenuAgentMode !== 'delete-only') return;

  const agent = allAgents.find(item => item.id === contextMenuAgentId);
  if (!agent || agent.connected !== false) {
    closeAgentContextMenu();
    return;
  }

  try {
    const res = await fetch(`/api/agents/${contextMenuAgentId}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || t('delete_failed_generic'));
    }

    closeAgentContextMenu();
    await loadAgents();

    if (currentAgentId === contextMenuAgentId || currentRuntimeAgentId === contextMenuAgentId) {
      const fallbackId = resolveWorkspaceFallbackAgentId(agent);
      if (fallbackId) {
        selectWorkspaceSurface(fallbackId, { skipFeaturePanel: true });
      }
    } else if (!data.currentAgentId) {
      currentAgentId = null;
      currentRuntimeAgentId = null;
      currentWorkspaceTab = null;
      currentMessages = [];
      window.lastInputRequests = [];
      renderInputRequests([]);
      setCurrentLogs([]);
      setCurrentHookInspector({ lifecycleOrder: [], features: [], hooks: [] });
      setCurrentOverviewSnapshot(getEmptyOverviewSnapshot());
      setCurrentTodoPlan(getEmptyTodoPlan());
      renderCurrentMainView();
      setFollowLatest(true);
      currentAgentTitle.textContent = t('page_title');
    }
  } catch (e) {
    closeAgentContextMenu();
    window.alert(t('delete_failed') + (e && e.message ? e.message : e));
  }
});

deleteSessionAction.addEventListener('click', async () => {
  if (!contextMenuSessionAgentId || !contextMenuSessionId) return;

  const pendingAgentId = contextMenuSessionAgentId;
  const pendingSessionId = contextMenuSessionId;

  closeSessionContextMenu();

  const targetAgent = allAgents.find((item) => item.id === pendingAgentId) || null;
  const affectedRuntimeId = targetAgent?.runtime_session_id || targetAgent?.runtimeSessionId || null;
  // Clear cached data for the deleted session's runtime
  if (affectedRuntimeId) clearAgentRuntimeCache(affectedRuntimeId);
  const deletedWasActive = pendingSessionId === (targetAgent?.active_workspace_session_id || targetAgent?.workspace_sessions?.activeSessionId || null);

  if (deletedWasActive) {
    applyManagedPrebuiltAgent(pendingAgentId, null);
  }
  const currentSessions = getWorkspaceSessions(targetAgent);
  const remainingSessions = currentSessions.filter((s) => s.id !== pendingSessionId);
  const nextActiveId = remainingSessions.length > 0 ? (targetAgent?.active_workspace_session_id === pendingSessionId ? remainingSessions[0].id : targetAgent?.active_workspace_session_id) : null;
  updateAgentRecord(pendingAgentId, {
    workspace_sessions: { sessions: remainingSessions, activeSessionId: nextActiveId },
    active_workspace_session_id: nextActiveId,
  });

  if (pendingAgentId === 'flow-workspace' && window.ClawFW?.mode === 'detail') {
    fwBackToList();
    renderAgentList();
  } else if (pendingAgentId === 'flow-workspace') {
    renderAgentList();
  }
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();

  try {
    const response = await fetch('/protoclaw/prebuilt_sessions/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: pendingAgentId,
        sessionId: pendingSessionId,
      }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'delete session failed'));
    }
    const result = await response.json();

    if (result?.deleted?.sessions) {
      updateAgentRecord(pendingAgentId, {
        workspace_sessions: result.deleted.sessions,
        active_workspace_session_id: result.deleted.activeSessionId || null,
      });
    }
    if (result?.agent) {
      applyManagedPrebuiltAgent(pendingAgentId, result.agent);
    }

    const nextRuntimeId = result?.agent?.runtime_session_id || result?.agent?.runtimeSessionId || null;
    if (nextRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
      await requestSwitch(nextRuntimeId, 'stop-handler');
    } else if (affectedRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
      const fallbackAgent = applyManagedPrebuiltAgent(pendingAgentId, null, { uiOnlyWhenStopped: true });
      setPreferredUnitMode('home', fallbackAgent || targetAgent || { id: pendingAgentId, source: 'prebuilt' });
      selectWorkspaceSurface(pendingAgentId);
    }


    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
  } catch (e) {
    updateAgentRecord(pendingAgentId, {
      workspace_sessions: { sessions: currentSessions, activeSessionId: targetAgent?.active_workspace_session_id },
      active_workspace_session_id: targetAgent?.active_workspace_session_id,
    });
    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
    window.alert(t('delete_session_failed') + (e && e.message ? e.message : e));
  }
});

deleteProjectAction.addEventListener('click', () => {
  if (!contextMenuProjectAgentId || !contextMenuProjectId) return;

  const pendingAgentId = contextMenuProjectAgentId;
  const pendingProjectId = contextMenuProjectId;
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
      currentLanguage === 'zh'
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
          body: JSON.stringify({ agentId: pendingAgentId, projectId: pendingProjectId }),
        });
        if (!response.ok) {
          throw new Error(await response.text().catch(() => 'delete project failed'));
        }
        const result = await response.json();
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
        lastRenderedWorkspaceHtml = '';
        renderAgentList();
        renderCurrentMainView();
        const nextRuntimeId = result?.agent?.runtime_session_id || result?.agent?.runtimeSessionId || null;
        if (nextRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
          await requestSwitch(nextRuntimeId, 'stop-handler');
        } else if (affectedRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
          const fallbackAgent = applyManagedPrebuiltAgent(pendingAgentId, null, { uiOnlyWhenStopped: true });
          setPreferredUnitMode('home', fallbackAgent || agent || { id: pendingAgentId, source: 'prebuilt' });
          selectWorkspaceSurface(pendingAgentId);
        }
      } catch (error) {
        console.error('Failed to delete programming-helper project:', error);
        window.alert((currentLanguage === 'zh' ? '删除项目失败：' : 'Failed to delete project: ') + (error?.message || error));
      }
    })();
    return;
  }

  fwOpenConfirmDialog({
    title: currentLanguage === 'zh' ? '删除项目' : 'Delete Project',
    message: currentLanguage === 'zh'
      ? '确定要删除项目「' + projectName + '」吗？该项目下的所有对话记录将一并删除，此操作不可撤销。'
      : 'Delete project "' + projectName + '"? All conversations under this project will also be deleted. This cannot be undone.',
    confirmLabel: currentLanguage === 'zh' ? '删除' : 'Delete',
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
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ agentId: pendingAgentId, sessionId: run.id }),
            }).catch(() => {});
          }
          await window.deleteSavedAssemblyConfig(pendingProjectId);
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
            lastRenderedWorkspaceHtml = '';
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
          }),
        });
        if (!response.ok) {
          throw new Error(await response.text().catch(() => 'delete project failed'));
        }
        const result = await response.json();
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
        lastRenderedWorkspaceHtml = '';
        renderAgentList();
        renderCurrentMainView();

        const nextRuntimeId = result?.agent?.runtime_session_id || result?.agent?.runtimeSessionId || null;
        if (nextRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
          await requestSwitch(nextRuntimeId, 'stop-handler');
        } else if (affectedRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
          const fallbackAgent = applyManagedPrebuiltAgent(pendingAgentId, null, { uiOnlyWhenStopped: true });
          setPreferredUnitMode('home', fallbackAgent || targetAgent || { id: pendingAgentId, source: 'prebuilt' });
          selectWorkspaceSurface(pendingAgentId);
        }
      } catch (e) {
        window.alert(t('delete_project_failed') + (e && e.message ? e.message : e));
      }
    },
  });
});

deleteFeatureAction.addEventListener('click', async () => {
  if (!contextMenuFeatureRepoPackageId) return;

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
        packageId: contextMenuFeatureRepoPackageId,
      }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'delete feature failed'));
    }
    closeFeatureRepoContextMenu();
    renderCurrentMainView();
  } catch (e) {
    closeFeatureRepoContextMenu();
    window.alert(getRepoLocaleText('删除 Feature 失败: ', 'Delete feature failed: ') + (e && e.message ? e.message : e));
  }
});

document.addEventListener('click', (event) => {
  // ── Generic ctx-menu action handling ──
  const ctxBtn = event.target.closest('#ctx-menu button.ctx-menu-item[data-ctx-action]');
  if (ctxBtn && ctxMenu.classList.contains('open')) {
    const action = ctxBtn.dataset.ctxAction;
    if (action && window._ctxTarget) {
      dispatchCtxAction(action, window._ctxTarget);
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
  if (!sessionContextMenu.contains(event.target)) {
    closeSessionContextMenu();
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
  featurePanelWidth = Math.max(400, Math.min(750, featurePanelWidth));
  if (featurePanel.classList.contains('open')) {
    featurePanel.style.setProperty('--feature-panel-width', featurePanelWidth + 'px');
  }
  requestAnimationFrame(updateAssemblySideRailPosition);
});
window.addEventListener('scroll', () => {
  closeAgentContextMenu();
  closeSessionContextMenu();
  closeCompactMenu();
  closeProjectContextMenu();
  requestAnimationFrame(updateAssemblySideRailPosition);
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
      closeSessionContextMenu();
      closeCompactMenu();
      closeProjectContextMenu();
      const ctxTarget = { role, ns, id, variant };
      if (role === 'session') ctxTarget.sessionId = id;
      window.showCtxMenu(event.clientX, event.clientY, items, ctxTarget);
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
    return;
  }
  const item = event.target.closest('[data-prebuilt-session-id]');
  if (!item) return;
  event.preventDefault();
  openSessionContextMenu(
    item.dataset.prebuiltSessionAgentId,
    item.dataset.prebuiltSessionId,
    event.clientX,
    event.clientY,
  );
});

async function loadLogs(forceRender = false) {
  try {
    const params = new URLSearchParams({
      scope: logPanelScope,
    });
    if (currentRuntimeAgentId) {
      params.set('agentId', currentRuntimeAgentId);
    }

    const res = await fetch('/api/logs?' + params.toString());
    if (!res.ok) {
      throw new Error('Failed to fetch logs');
    }
    const data = await res.json();
    const nextLogs = data.logs || [];
    const nextSignature = JSON.stringify({
      count: nextLogs.length,
      last: nextLogs.length > 0 ? nextLogs[nextLogs.length - 1].id : null,
    });

    if (nextSignature !== currentLogsSignature) {
      setCurrentLogs(nextLogs);
      if (activeFeaturePanel === 'logs') {
        renderFeaturePanel();
      }
    } else if (forceRender && activeFeaturePanel === 'logs') {
      renderFeaturePanel();
    }
  } catch (e) {
    if (forceRender && activeFeaturePanel === 'logs') {
      setCurrentLogs([]);
      renderFeaturePanel();
    }
  }
}

async function loadMcpInfo(forceRender = false) {
  try {
    const res = await fetch('/api/mcp-info');
    if (!res.ok) {
      setCurrentMcpInfo(null);
      return;
    }
    const data = await res.json();
    setCurrentMcpInfo(data);
    if (forceRender && activeFeaturePanel === 'mcp') {
      renderFeaturePanel();
    }
  } catch (e) {
    console.error('Failed to load MCP info:', e);
    if (forceRender && activeFeaturePanel === 'mcp') {
      renderFeaturePanel();
    }
  }
}

async function loadAgentData(agentId) {
  if (isUiOnlyAgentId(agentId)) {
    currentRuntimeAgentId = null;
    currentRuntimeConnected = true;
    updateNotificationStatus(null);
    resetRuntimeBackedSurfaceState();
    renderCurrentMainView();
    renderFeaturePanel();
    return;
  }
  try {
    currentRuntimeAgentId = agentId;
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
    if (normalizeAgentIdentity(currentRuntimeAgentId) !== normalizeAgentIdentity(agentId)) {
      return;
    }

    const msgsData = await msgsRes.json();
    const tools = await toolsRes.json();
    setCurrentHookInspector(await hooksRes.json());
    setCurrentOverviewSnapshot(await overviewRes.json());
    setCurrentTodoPlan(todoRes.ok ? await todoRes.json() : getEmptyTodoPlan());
    const inputRequests = await inputRes.json();

    currentMessages = msgsData.messages || [];
    recheckAutoTitleCandidate();
    // Only clear loading if messages arrived. If the runtime hasn't loaded
    // messages yet (common for freshly-created compacted resume sessions),
    // keep the spinner so the user doesn't see a premature empty welcome page.
    // The poll loop will clear it once real messages appear, and the 10s
    // timeout in beginChatLoadingSession is the ultimate fallback.
    if (currentMessages.length > 0) clearChatLoadingSession();
    window.lastInputRequests = inputRequests;
    renderInputRequests(inputRequests);
    updateRollbackActionVisibility();
    toolRenderConfigs = {};
    TOOL_NAMES = {};

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

    for (const tool of tools) {
      toolRenderConfigs[tool.name] = tool;
      TOOL_NAMES[tool.name] = DEFAULT_DISPLAY_NAMES[tool.name] || tool.name;
    }

    renderCurrentMainView();
    await refreshCurrentRuntimeStatus(agentId);
    if (activeFeaturePanel === 'logs') {
      await loadLogs(true);
    }
    renderFeaturePanel();

    warmTemplatesInBackground(collectTemplateNames(tools), agentId);
  } catch (e) {
    console.error('Failed to load agent data:', e);
  }
}

async function refreshCurrentRuntimeStatus(runtimeId = currentRuntimeAgentId) {
  const expectedRuntimeId = normalizeAgentIdentity(runtimeId);
  if (!expectedRuntimeId) return null;

  try {
    const [notifRes, connectionRes] = await Promise.all([
      fetch(`/api/agents/${expectedRuntimeId}/notification`),
      fetch(`/api/agents/${expectedRuntimeId}/connection`),
    ]);

    if (normalizeAgentIdentity(currentRuntimeAgentId) !== expectedRuntimeId) {
      return null;
    }
    if (!notifRes.ok || !connectionRes.ok) {
      return null;
    }

    const [notifData, connectionData] = await Promise.all([
      notifRes.json(),
      connectionRes.json(),
    ]);

    if (normalizeAgentIdentity(currentRuntimeAgentId) !== expectedRuntimeId) {
      return null;
    }

    currentRuntimeConnected = connectionData?.connected !== false;
    const runtimeRecord = getRuntimeRecord(expectedRuntimeId);
    if (runtimeRecord) {
      runtimeRecord.connected = currentRuntimeConnected;
    }
    setConnectionStatus(currentRuntimeConnected);
    updateNotificationStatus(notifData);
    return { notifData, connectionData };
  } catch (error) {
    console.warn('Failed to refresh runtime status:', error);
    return null;
  }
}

// ── Auto session title generation + Choice alerts → modules/auto-title.js (Phase A-3, 2026-07-03) ──

async function poll() {
  try {
    if (prebuiltSessionSwitchInFlight) {
      setTimeout(poll, 300);
      return;
    }

    // 全局 choice 请求提醒（跨所有 agent，不限于当前焦点）
    if (Date.now() - _lastChoiceAlertCheckAt > 3000) {
      _lastChoiceAlertCheckAt = Date.now();
      checkGlobalChoiceAlerts().catch(() => {});
    }

    // 定期检查并重新加载 Feature 模板映射（如果为空）
    if (Object.keys(FEATURE_TEMPLATE_MAP).length === 0 && Date.now() - lastFeatureTemplateReloadAt > 3000) {
      lastFeatureTemplateReloadAt = Date.now();
      await reloadFeatureTemplateMap();
    }

    if (!currentRuntimeAgentId) {
      currentRuntimeConnected = true;
      updateNotificationStatus(null);
      await loadAgents();
      await refreshAgentCallStates(allAgents);
      // Incrementally refresh workspace session data when viewing workspace surface.
      if (Date.now() - (window._lastWsSessionRefreshAt || 0) > 3000) {
        const wsHostAgent = allAgents.find((a) => a.id === currentAgentId && isWorkspaceHostUnit(a));
        if (wsHostAgent && loadedAgentDetailIds.has(wsHostAgent.id)) {
          window._lastWsSessionRefreshAt = Date.now();
          try {
            const freshRes = await fetch('/protoclaw/prebuilt_sessions?agentId=' + encodeURIComponent(wsHostAgent.id));
            if (freshRes.ok) {
              const freshSessions = await freshRes.json();
              const prevSig = JSON.stringify(wsHostAgent.workspace_sessions || {});
              const nextSig = JSON.stringify(freshSessions);
              if (prevSig !== nextSig) {
                wsHostAgent.workspace_sessions = freshSessions;
                if (typeof shouldRenderWorkspaceSurface === 'function' && shouldRenderWorkspaceSurface(wsHostAgent)) {
                  // 群聊工作空间：避免整个 workspace DOM 重建导致输入框失焦/内容丢失，
                  // 改用轻量刷新（只更新左侧群聊列表）
                  if (wsHostAgent.id === 'work-group' && window.WorkGroupUI?.softRefresh) {
                    window.WorkGroupUI.softRefresh();
                  } else {
                    renderCurrentMainView();
                  }
                } else {
                  // Chat mode: only refresh context bar, avoid full re-render that resets scroll
                  if (typeof updateChatContextBar === 'function') {
                    updateChatContextBar();
                  }
                }
              }
            }
          } catch {}
        }
      }
      if (activeFeaturePanel === 'logs' && logPanelScope === 'all') {
        await loadLogs();
      }
      setTimeout(poll, 1000);
      return;
    }

    // 先单独刷新轻量运行态，再并行请求较重的数据，避免状态栏被慢接口拖住
    const pollRuntimeId = currentRuntimeAgentId;
    const statusTask = refreshCurrentRuntimeStatus(pollRuntimeId);

    const [msgsRes, inputRes, overviewRes, todoRes] = await Promise.all([
      fetch(`/api/agents/${pollRuntimeId}/messages`),
      fetch(`/api/agents/${pollRuntimeId}/input-requests`),
      fetch(`/api/agents/${pollRuntimeId}/overview`),
      fetch(`/api/agents/${pollRuntimeId}/todo`),
    ]);

    // 如果在 fetch 期间已经切换了 agent，丢弃过时的响应，避免旧数据覆盖新会话
    if (normalizeAgentIdentity(currentRuntimeAgentId) !== normalizeAgentIdentity(pollRuntimeId)) {
      setTimeout(poll, 300);
      return;
    }

    const coreResponses = [msgsRes, inputRes, overviewRes];
    if (coreResponses.some(res => res.status === 404)) {
      // In-session partial compact doesn't create a new session, so if we get 404
      // while compact is in flight, just clear the flag and fall through to normal handling
      if (_partialCompactInFlight && normalizeAgentIdentity(pollRuntimeId) === normalizeAgentIdentity(_partialCompactRuntimeId)) {
        clearPartialCompactState();
      }
      if (prebuiltSessionSwitchInFlight || suppressSidebarRerender) {
        setTimeout(poll, 300);
        return;
      }
      const failedRuntimeId = currentRuntimeAgentId;
      const failedRuntimeRecord = getRuntimeRecord(failedRuntimeId);
      if (failedRuntimeId) {
        _agentCallActive.delete(failedRuntimeId);
        clearInterruptSuppression(failedRuntimeId);
      }
      if (failedRuntimeRecord) {
        failedRuntimeRecord.callActive = false;
        failedRuntimeRecord.connected = false;
      }
      currentRuntimeAgentId = null;
      const fallbackId = resolveWorkspaceFallbackAgentId(failedRuntimeRecord);
      if (fallbackId) {
        selectWorkspaceSurface(fallbackId, { skipFeaturePanel: true });
      } else {
        currentAgentId = null;
        currentWorkspaceTab = null;
        currentMessages = [];
        currentInputRequests = [];
        window.lastInputRequests = [];
        setCurrentTodoPlan(getEmptyTodoPlan());
        renderCurrentMainView();
        renderInputRequests([]);
      }
      await loadAgents();
      setTimeout(poll, 1000);
      return;
    }

    const data = await msgsRes.json();
    const messages = data.messages || [];

    // Clear session loading indicator once messages are available
    if (messages.length > 0) clearChatLoadingSession();

    // Render messages immediately — before non-critical async ops
    // (status refresh, call states, queue sync) that add visible latency.
    const previousMessages = currentMessages;
    markAutoTitleCandidate(previousMessages, messages);
    const firstChangedIndex = findFirstChangedMessageIndex(messages, currentMessages);
    if (messages.length !== currentMessages.length) {
      if (messages.length > currentMessages.length && firstChangedIndex === currentMessages.length) {
        // 有新消息：只追加新的
        const newMessages = messages.slice(currentMessages.length);
        currentMessages = messages;
        if (shouldRenderWorkspaceSurface()) {
          renderCurrentMainView();
        } else {
          appendNewMessages(newMessages, currentMessages.length - newMessages.length);
        }
      } else {
        // 消息减少，或消息变多但前缀已变化：完全重建。
        currentMessages = messages;
        renderCurrentMainView();
      }
    } else {
      if (firstChangedIndex >= 0) {
        currentMessages = messages;
        // Rollback + partial compact can replace the middle of the transcript while
        // keeping the same length after the summary reminder is inserted.
        if (shouldRenderWorkspaceSurface() || firstChangedIndex < messages.length - 1) {
          renderCurrentMainView();
        } else {
          // 最后一条消息变化：替换最后一条（避免滚动重置）
          updateLastMessage(messages[messages.length - 1]);
        }
      }
    }

    await statusTask;
    await refreshAgentCallStates(allAgents);
    _syncPersistentActionButton();
    _syncPersistentInputUi(currentRuntimeAgentId);

    const nextOverview = normalizeOverviewSnapshot(await overviewRes.json());
    const nextOverviewSignature = getOverviewSignature(nextOverview);
    if (nextOverviewSignature !== currentOverviewSignature) {
      currentOverviewSnapshot = nextOverview;
      currentOverviewSignature = nextOverviewSignature;
      if (activeFeaturePanel === 'workspace') {
        renderFeaturePanel();
      }
      if (typeof updateChatContextBar === 'function') {
        updateChatContextBar();
      }
    }

    if (todoRes.ok) {
      const nextTodoPlan = normalizeTodoPlan(await todoRes.json());
      const nextTodoSignature = getTodoPlanSignature(nextTodoPlan);
      // 当目标任务进入终态时，自动清除中断标记
      let interruptCleared = false;
      const currentInterruptTarget = getInterruptTargetId();
      if (currentInterruptTarget) {
        const target = nextTodoPlan.tasks.find(tk => tk.id === currentInterruptTarget);
        if (target && (target.status === 'completed' || target.status === 'deleted')) {
          setInterruptTargetId(null);
          interruptCleared = true;
        }
      }
      if (nextTodoSignature !== currentTodoPlanSignature) {
        currentTodoPlan = nextTodoPlan;
        currentTodoPlanSignature = nextTodoSignature;
        if (activeFeaturePanel === 'plan') {
          renderFeaturePanel();
        }
        updatePlanBadge();
      } else if (interruptCleared && activeFeaturePanel === 'plan') {
        renderFeaturePanel();
      }
    }

    // 处理输入请求（只在变化时重新渲染）
    const inputRequestsRaw = await inputRes.json();
    const inputRequests = Array.isArray(inputRequestsRaw) ? inputRequestsRaw : [];
    // If partial compact was in flight but runtime is back to accepting input,
    // compact is done (or failed) — clear the flag so normal input is shown.
    if (
      _partialCompactInFlight
      && normalizeAgentIdentity(pollRuntimeId) === normalizeAgentIdentity(_partialCompactRuntimeId)
      && inputRequests.length > 0
    ) {
      clearPartialCompactState();
    }
    if (JSON.stringify(inputRequests) !== JSON.stringify(window.lastInputRequests || [])) {
      window.lastInputRequests = inputRequests;
      renderInputRequests(inputRequests);
      updateRollbackActionVisibility();
    } else if (isChatSurfaceActive()) {
      _syncPersistentInputUi(currentRuntimeAgentId);
    }

    // Generate only after this session's first assistant response was newly observed and completed.
    if (currentRuntimeAgentId && !isRuntimeCalling(currentRuntimeAgentId)) {
      tryAutoTitleGeneration(currentMessages);
    }

    // Refresh the Claw-composed agent list occasionally.
    // Do not overwrite `allAgents` with the raw viewer session list,
    // otherwise prebuilt/managed grouping disappears.
    if (Date.now() - lastAgentListRefreshAt > 3000) {
       lastAgentListRefreshAt = Date.now();
       await loadAgents();
       if (typeof updateChatContextBar === 'function') {
         updateChatContextBar();
       }
    }

    // Incrementally refresh workspace session data for the active workspace host.
    // This keeps the UI in sync when sessions are created/deleted via CLI.
    if (Date.now() - (window._lastWsSessionRefreshAt || 0) > 3000) {
      const wsHostAgent = allAgents.find((a) => a.id === currentAgentId && isWorkspaceHostUnit(a));
      if (wsHostAgent && loadedAgentDetailIds.has(wsHostAgent.id)) {
        window._lastWsSessionRefreshAt = Date.now();
        try {
          const freshRes = await fetch('/protoclaw/prebuilt_sessions?agentId=' + encodeURIComponent(wsHostAgent.id));
          if (freshRes.ok) {
            const freshSessions = await freshRes.json();
            const prevSig = JSON.stringify(wsHostAgent.workspace_sessions || {});
            const nextSig = JSON.stringify(freshSessions);
            if (prevSig !== nextSig) {
              wsHostAgent.workspace_sessions = freshSessions;
              if (typeof shouldRenderWorkspaceSurface === 'function' && shouldRenderWorkspaceSurface(wsHostAgent)) {
                renderCurrentMainView();
              } else {
                // Chat mode: only refresh context bar, avoid full re-render that resets scroll
                if (typeof updateChatContextBar === 'function') {
                  updateChatContextBar();
                }
              }
            }
          }
        } catch {}
      }
    }

    if (activeFeaturePanel) {
      if (activeFeaturePanel === 'logs') {
        await loadLogs();
      } else if (activeFeaturePanel !== 'resources' && activeFeaturePanel !== 'viewer' && activeFeaturePanel !== 'settings' && activeFeaturePanel !== 'plan') {
        // resources/viewer 面板数据独立管理，不需要 hooks 数据，跳过以避免无谓渲染
        const hooksRes = await fetch(`/api/agents/${currentRuntimeAgentId}/hooks`);
        const nextHookInspector = normalizeHookInspector(await hooksRes.json());
        const nextSignature = getHookInspectorSignature(nextHookInspector);
        if (nextSignature !== currentHookInspectorSignature) {
          currentHookInspector = nextHookInspector;
          currentHookInspectorSignature = nextSignature;
          renderFeaturePanel();
        } else if (activeFeaturePanel === 'inspector') {
          renderFeaturePanel();
        }
      }
    }

    // Write-through: keep cache fresh so switching back is instant
    if (currentRuntimeAgentId) {
      saveCurrentRuntimeToCache(currentRuntimeAgentId);
    }

    // Track recap session presence (detects "return after absence")
    _trackRecapSessionPresence();

  } catch (e) {
    console.warn('Polling failed, keeping last known connection state:', e);
    setTimeout(poll, 1000);
    return;
  }
  setTimeout(poll, 300);
}

// 渲染输入请求
function getInputRenderSignature(requests, renderMode) {
  const runtimeId = currentRuntimeAgentId || 'none';
  if (renderMode === 'persistent') {
    const contextKey = getRuntimeContextKey(runtimeId) || `runtime:${runtimeId}`;
    return `persistent|${contextKey}|${readOnlyMode ? 'ro' : 'rw'}`;
  }
  if (renderMode === 'requests') {
    const contextKey = getRuntimeContextKey(runtimeId) || `runtime:${runtimeId}`;
    return `requests|${contextKey}|${JSON.stringify(requests || [])}`;
  }
  return `${renderMode}|${runtimeId}`;
}

function renderInputRequests(requests) {
  const inputContainer = document.getElementById('user-input-container');
  if (!inputContainer) return;

  // Don't re-render while the rollback action dialog is open
  if (_rollbackDialogOpen) return;

  const chatViewportTopBefore = container.scrollTop;
  currentInputRequests = requests;
  const chatActive = isChatSurfaceActive();
  const renderMode = getInputSurfaceMode(requests);
  const signature = getInputRenderSignature(requests, renderMode);
  const hasChoiceRequest = Array.isArray(requests) && requests.some(isChoiceInputRequest);

  if (signature === lastRenderedInputSignature && renderMode === lastRenderedInputMode) {
    return;
  }

  lastRenderedInputSignature = signature;
  lastRenderedInputMode = renderMode;

  // 当持久输入框在同一会话内重渲染时（如 call 状态变化触发的重建），
  // 保留正在进行的语音录音。MediaRecorder 不依赖 DOM，重建后只需将
  // 按钮引用重新指向新元素即可。仅在输入面真正切换时才取消录音。
  const _preserveVoiceRecording = _voiceRecording
    && renderMode === 'persistent'
    && lastRenderedInputMode === 'persistent';

  if (_voiceRecording && !_preserveVoiceRecording) {
    if (_voicePendingSend) {
      // User already pressed send — preserve auto-send intent.
      // Just stop the recording; onstop will run ASR and auto-send normally.
      stopVoiceRecording();
    } else {
      _cancelVoiceRecording();
    }
  }
  // 仅在非保留场景下重置 flag；保留时不影响进行中的 ASR fetch
  if (!_preserveVoiceRecording) {
    _voiceTranscribing = false;
  }

  _storeVisibleSessionInputDraft(inputContainer);

  // 清空现有内容
  runWithSuppressedChatViewportObservers(() => {
    inputContainer.innerHTML = '';
    inputContainer.classList.toggle('choice-input-active', hasChoiceRequest);
    inputContainer.classList.remove('choice-collapsed');
    inputContainer.onclick = hasChoiceRequest
      ? function(event) {
          if (event.target === inputContainer) {
            collapsePrimaryChoiceRequest();
          }
        }
      : null;
  });

  if (!chatActive || renderMode === 'hidden') {
    inputContainer.classList.remove('choice-input-active', 'choice-collapsed');
    notifyChatViewportMutation({
      reason: 'input-render',
      shouldFollow: followLatestEnabled && chatActive,
      preserveTop: followLatestEnabled ? null : chatViewportTopBefore,
      forceSnap: followLatestEnabled,
      allowChase: false,
    });
    return;
  }

  if (renderMode === 'readonly') {
    inputContainer.classList.remove('choice-input-active', 'choice-collapsed');
    const card = document.createElement('div');
    card.className = 'user-input-card';
    card.innerHTML = `
      <textarea class="user-input-textarea" rows="1" disabled
        placeholder="${escapeHtml(t('workspace_readonly_mode'))}"
        style="opacity:0.5;cursor:not-allowed;"></textarea>
    `;
    runWithSuppressedChatViewportObservers(() => {
      inputContainer.appendChild(card);
    });
    notifyChatViewportMutation({
      reason: 'input-render',
      shouldFollow: followLatestEnabled && chatActive,
      preserveTop: followLatestEnabled ? null : chatViewportTopBefore,
      forceSnap: followLatestEnabled,
      allowChase: false,
    });
    return;
  }

  // 常驻输入框的显示条件一直是"当前正在查看某个 runtime 聊天面板"，
  // 而不是"runtime 此刻一定处于执行中"。
  const hasRequests = Array.isArray(requests) && requests.length > 0;
  const hasRuntimeSelected = !!currentRuntimeAgentId && chatActive;

  // 部分压缩进行中：显示压缩状态，禁止输入
  // 仅对发起压缩的 runtime 生效，不污染其他 runtime
  if (_partialCompactInFlight && hasRuntimeSelected && currentRuntimeAgentId === _partialCompactRuntimeId) {
    inputContainer.classList.remove('choice-input-active', 'choice-collapsed');
    const card = document.createElement('div');
    card.className = 'user-input-card partial-compact-card';
    const compactContextKey = _partialCompactContextKey || _getSessionInputCacheKey();
    let compactStart = readPartialCompactStartedAt(compactContextKey);
    if (!Number.isFinite(compactStart)) {
      compactStart = Date.now();
      writePartialCompactStartedAt(compactStart, compactContextKey);
    }
    card.innerHTML = `
      <div class="partial-compact-status" aria-live="polite">
        <span class="partial-compact-spinner" aria-hidden="true"></span>
        <span class="partial-compact-copy">
          <span class="partial-compact-title">${currentLanguage === 'zh' ? '压缩中' : 'Compacting'}</span>
          <span class="partial-compact-elapsed" id="partial-compact-elapsed">${currentLanguage === 'zh' ? '已用时 0s' : 'Elapsed 0s'}</span>
        </span>
      </div>
    `;
    runWithSuppressedChatViewportObservers(() => {
      inputContainer.appendChild(card);
    });
    // Start elapsed timer
    const elapsedEl = card.querySelector('#partial-compact-elapsed');
    const updateCompactTimer = () => {
      if (!elapsedEl || !document.body.contains(elapsedEl)) {
        clearInterval(_compactTimerInterval);
        _compactTimerInterval = null;
        return;
      }
      const elapsed = Math.floor((Date.now() - compactStart) / 1000);
      elapsedEl.textContent = currentLanguage === 'zh'
        ? `已用时 ${elapsed}s`
        : `Elapsed ${elapsed}s`;
    };
    updateCompactTimer();
    if (_compactTimerInterval) clearInterval(_compactTimerInterval);
    _compactTimerInterval = setInterval(updateCompactTimer, 1000);
    notifyChatViewportMutation({
      reason: 'input-render',
      shouldFollow: followLatestEnabled && chatActive,
      preserveTop: followLatestEnabled ? null : chatViewportTopBefore,
      forceSnap: followLatestEnabled,
      allowChase: false,
    });
    return;
  }

  // 如果有 pending requests，正常渲染
  // 如果没有 pending requests 但当前有 runtime 聊天上下文，渲染常驻输入框（队列模式）
  if (renderMode === 'requests' && hasRequests) {
    for (const req of requests) {
      if (isChoiceInputRequest(req)) {
        renderChoiceInputRequest(inputContainer, req);
        continue;
      }

      const card = document.createElement('div');
      card.className = 'user-input-card';
      const visibleActions = Array.isArray(req.actions)
        ? req.actions.filter(action => action && action.id !== 'rollback_to_call' && action.id !== 'compact_from_call')
        : [];
      const actionsHtml = visibleActions.length > 0
        ? '<div class="user-input-actions">' + visibleActions.map(action =>
            '<button class="user-input-action ' + escapeHtml(action.variant || 'secondary') + '" onclick="submitInputAction(\'' + req.requestId + '\', \'' + escapeHtml(action.id) + '\')">' + escapeHtml(action.label) + '</button>'
          ).join('') + '</div>'
        : '';
      card.innerHTML = `
        <div class="persistent-input-row">
          <textarea class="user-input-textarea" rows="1" id="input-${req.requestId}"
            onkeydown="handleInputKey(event, '${req.requestId}')"
            oninput="autoResize(this); _cacheSessionInput(this)"
            placeholder="${escapeHtml(req.placeholder || t('input_placeholder'))}"></textarea>
          <button class="voice-input-btn" data-target="input-${req.requestId}" onclick="toggleVoiceRecording(this)" title="${currentLanguage === 'zh' ? '语音输入' : 'Voice Input'}">
            <svg class="icon-mic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>
          </button>
          <button class="persistent-action-btn" onclick="submitInput('${req.requestId}')" title="Send">
            <svg class="icon-send" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
          </button>
        </div>
        ${actionsHtml ? `<div class="user-input-footer">${actionsHtml}</div>` : ''}
      `;
      runWithSuppressedChatViewportObservers(() => {
        inputContainer.appendChild(card);
      });

      const requestTextarea = document.getElementById(`input-${req.requestId}`);
      const requestCacheKey = _getSessionInputCacheKey();
      if (requestTextarea) {
        requestTextarea.dataset.sessionKey = requestCacheKey || '';
        _restoreSessionInputDraft(requestTextarea, requestCacheKey);
      }

      // Auto-focus
      setTimeout(() => {
        const el = document.getElementById(`input-${req.requestId}`);
        if(el) {
           const hasCachedDraft = !!(el.dataset.sessionKey && Object.prototype.hasOwnProperty.call(_sessionInputCache, el.dataset.sessionKey));
           if (!hasCachedDraft && !el.value && typeof req.initialValue === 'string' && req.initialValue.length > 0) {
             el.value = req.initialValue;
             _cacheSessionInput(el);
           }
           el.focus();
           const end = el.value.length;
           if (typeof el.setSelectionRange === 'function') {
             el.setSelectionRange(end, end);
           }
           autoResize(el);
        }
      }, 50);
    }
  } else if (renderMode === 'persistent' && hasRuntimeSelected && !readOnlyMode) {
    // 常驻输入框：当前正在查看 runtime 聊天，但没有 pending input request
    renderPersistentInput(inputContainer);
    // 跨 DOM 重建保留了录音时，将按钮引用重新指向新元素
    if (_preserveVoiceRecording) {
      const newBtn = inputContainer.querySelector('.voice-input-btn');
      if (newBtn) {
        _voiceTargetBtn = newBtn;
        newBtn.classList.add('recording');
        _updateVoiceUI();
      }
    }
  }

  // Inject any pending voice ASR result that arrived while viewing another session
  _injectPendingVoiceResult();

  _renderLastCallElapsed();
  _renderRecapHint();

  notifyChatViewportMutation({
    reason: 'input-render',
    shouldFollow: followLatestEnabled && chatActive,
    preserveTop: followLatestEnabled ? null : chatViewportTopBefore,
    forceSnap: followLatestEnabled,
    allowChase: false,
  });
}

// ── Persistent Input (常驻输入框/队列) → modules/persistent-input.js (Phase B-4, 2026-07-04) ──

// ── Choice Input 卡片交互 → modules/choice-input.js (Phase A-2, 2026-07-03) ──

// ── Input helpers (rollback/process/submit) → modules/input-helpers.js (Phase B-5, 2026-07-04) ──

// ── Partial Compact / Rollback Dialog → modules/rollback-dialog.js (Phase A-6, 2026-07-03) ──

// ── Chat Message Rendering → modules/chat-renderer.js (Phase D, 2026-07-05) ──

// ── Voice Input / ASR → modules/voice-input.js (Phase A-1, 2026-07-03) ──

// _getSessionInputCacheKey retained here — shared by many domains (poll, renderInputRequests, etc.)
// Use the same immutable runtime-context identity as rendering and optimistic data.
function _getSessionInputCacheKey() {
  return getRuntimeContextKey();
}

applyTheme(currentTheme);
applyLanguage();

// When the page returns to foreground after being in a background tab,
// browser timer throttling may have caused us to miss state transitions.
// Force a full refresh to catch up.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  // Re-sync all agent calling states immediately
  refreshAgentCallStates(allAgents, { force: true });
  // Re-sync current runtime's notification status (button, status bar)
  if (currentRuntimeAgentId) {
    refreshCurrentRuntimeStatus(currentRuntimeAgentId);
  }
});

(async () => {
  await waitForViewerReady();
  const success = await loadFeatureTemplateMap();
  await loadAgents();
  if (!success) {
    console.log('[Viewer] Retrying to load feature templates after agent loaded...');
    await reloadFeatureTemplateMap();
  }
  await loadMcpInfo(false);
  poll();
})();
