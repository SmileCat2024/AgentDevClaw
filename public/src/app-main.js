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
    prebuilt: allPrebuilt.filter((agent) => !TOOL_AGENT_IDS.has(String(agent.id || '').trim())),
    tool: allPrebuilt.filter((agent) => TOOL_AGENT_IDS.has(String(agent.id || '').trim())),
    external: orphanRuntimeAgents,
  };
}

function isRuntimeItemActive(runtimeId) {
  const normalizedRuntimeId = normalizeAgentIdentity(runtimeId);
  return normalizedRuntimeId !== '' && normalizeAgentIdentity(currentRuntimeAgentId) === normalizedRuntimeId;
}

function buildSyntheticRuntimeEntry(prebuiltAgent) {
  const runtimeId = prebuiltAgent.runtime_session_id || prebuiltAgent.runtimeSessionId || '';
  if (!runtimeId) return null;
  if (prebuiltAgent.connected === false) return null;
  return {
    id: runtimeId,
    ownerId: prebuiltAgent.id,
    runtimeId,
    name: prebuiltAgent.active_workspace_display_name
      || prebuiltAgent.active_workspace_session_title
      || `${prebuiltAgent.name || prebuiltAgent.id} Runtime`,
    metaLabel: prebuiltAgent.active_workspace_session_title || '常驻运行时',
    status: prebuiltAgent.connected === false ? 'disconnected' : 'connected',
    source: 'managed-runtime',
    contextMenuEnabled: true,
  };
}

function buildChildRuntimeEntry(runtimeAgent) {
  const runtimeId = runtimeAgent.runtime_session_id || runtimeAgent.runtimeSessionId || runtimeAgent.id || '';
  const ownerId = String(runtimeAgent.parent_id || '').trim();
  if (!runtimeId || !ownerId) return null;
  return {
    id: runtimeAgent.id || runtimeId,
    ownerId,
    runtimeId,
    name: runtimeAgent.active_workspace_display_name
      || runtimeAgent.active_workspace_agent_name
      || runtimeAgent.active_workspace_session_title
      || runtimeAgent.name
      || runtimeId,
    metaLabel: runtimeAgent.active_workspace_session_title || runtimeAgent.name || '显式运行时',
    status: runtimeAgent.connected === false ? 'disconnected' : 'connected',
    source: runtimeAgent.source || 'external',
    contextMenuEnabled: true,
  };
}

function collectRuntimeEntriesForPrebuilt(prebuiltAgent, agents) {
  const entries = [];
  const seenRuntimeIds = new Set();

  const addEntry = (entry) => {
    if (!entry) return;
    if (!entry?.runtimeId) return;
    if (seenRuntimeIds.has(entry.runtimeId)) return;
    seenRuntimeIds.add(entry.runtimeId);
    entries.push(entry);
  };
  addEntry(buildSyntheticRuntimeEntry(prebuiltAgent));

  agents
    .filter((agent) => agent.source !== 'prebuilt' && String(agent.parent_id || '').trim() === String(prebuiltAgent.id || '').trim())
    .forEach((agent) => addEntry(buildChildRuntimeEntry(agent)));

  return entries;
}

function isRuntimeCalling(runtimeId) {
  return normalizeAgentIdentity(runtimeId) !== '' && _agentCallActive.get(runtimeId) === true;
}

function resolveNotificationCallingState(notifData) {
  const stateType = String(notifData?.state?.type || '').trim();
  if (stateType === 'call.start') {
    return true;
  }
  if (stateType === 'call.finish') {
    return false;
  }
  if (notifData?.callActive !== undefined) {
    return notifData.callActive === true;
  }
  if (stateType === 'llm.complete') {
    return false;
  }
  return notifData?.callActive === true;
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
        const itemClass = [
          'agent-item',
          'agent-runtime-item',
          active ? 'active' : '',
          disconnected ? 'disconnected' : '',
          calling ? 'calling' : '',
        ].filter(Boolean).join(' ');
        return `
          <div
            class="${itemClass}"
            data-agent-id="${escapeHtml(entry.runtimeId)}"
            data-agent-prebuilt="false"
            data-agent-context-menu="${entry.contextMenuEnabled ? 'true' : 'false'}"
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
    const itemClass = [
      'agent-item',
      active ? 'active' : '',
      connected || prebuilt ? '' : 'disconnected',
      pending ? 'pending' : '',
      idle ? 'idle' : '',
      calling ? 'calling' : '',
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
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const agents = await invoke('get_connected_agents');
    const findConnectedChild = (list) => list.find((agent) => {
      if (agent.source !== 'child' || agent.parent_id !== agentId) return false;
      const runtimeId = normalizeAgentIdentity(agent.runtime_session_id || agent.runtimeSessionId || agent.id);
      if (!runtimeId) return false;
      if (expectedRuntimeId && runtimeId === expectedRuntimeId) return false;
      return agent.connected === true;
    });
    const matched = findConnectedChild(agents);
    if (matched) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const verify = await invoke('get_connected_agents');
      const still = findConnectedChild(verify);
      if (still) {
        allAgents = verify;
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
            workspace_sessions: prev.workspace_sessions,
            workspace_state: prev.workspace_state,
          } : {}),
        };
      });
    }

    // 清理已断开 agent 的 call 状态
    const activeRuntimeIds = new Set(allAgents.filter((a) => a.connected).map((a) => a.runtime_session_id || a.runtimeSessionId || a.id));
    for (const key of _agentCallActive.keys()) {
      if (!activeRuntimeIds.has(key)) _agentCallActive.delete(key);
    }

    if (!suppressSidebarRerender) {
      renderAgentList();
      renderFeaturePanel();
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

async function refreshAgentCallStates(agents = allAgents, options = {}) {
  const { force = false } = options;
  const now = Date.now();
  if (!force && now - lastCallStateRefreshAt < 1000) {
    return;
  }
  lastCallStateRefreshAt = now;

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
    const isCalling = nextCallStates.get(runtimeId) === true;
    const prevCalling = _agentCallActive.get(runtimeId) === true;
    if (isCalling) {
      _agentCallActive.set(runtimeId, true);
    } else {
      _agentCallActive.delete(runtimeId);
    }
    if (prevCalling !== isCalling) {
      changed = true;
    }
  }

  const activeRuntimeIds = new Set(runtimeIds);
  for (const key of Array.from(_agentCallActive.keys())) {
    if (!activeRuntimeIds.has(key)) {
      _agentCallActive.delete(key);
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
}

function renderAgentList() {
  const groups = groupConnectedAgents(allAgents);
  renderAgentGroup(prebuiltAgentList, prebuiltGroup, prebuiltCount, groups.prebuilt, { prebuilt: true });
  renderAgentGroup(toolAgentList, toolGroup, toolCount, groups.tool, { prebuilt: true });
  renderAgentGroup(externalAgentList, externalGroup, externalCount, groups.external);

  updateCurrentAgentChrome();
}

agentList.addEventListener('click', async (event) => {
  const item = event.target.closest('.agent-item');
  if (!item) return;

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
  if (item.dataset.agentContextMenu !== 'true') return;

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
    await window.switchAgent(nextRuntimeId);
    setPreferredUnitMode('home', allAgents.find((agent) => agent.id === agentId && agent.source === 'prebuilt') || startedAgent);
    renderCurrentMainView();
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

  if (isLiveCurrentSession) {
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
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await loadAgents();
      const refreshed = allAgents.find((item) => String(item?.id || '').trim() === String(agentId || '').trim()) || null;
      const nextSessionId = String(refreshed?.active_workspace_session_id || refreshed?.workspace_sessions?.activeSessionId || '').trim();
      const nextRuntimeId = refreshed?.runtime_session_id || refreshed?.runtimeSessionId || null;
      if (nextSessionId && nextSessionId !== String(sessionId || '').trim() && nextRuntimeId) {
        await window.switchAgent(nextRuntimeId);
        return { scheduled: true, liveRuntime: true, switched: true };
      }
    }
    return { scheduled: true, liveRuntime: true, switched: false };
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
  tabGroup.querySelectorAll('.ph-session-tab').forEach((t) => t.classList.toggle('active', t.dataset.phTab === targetTab));
  tabGroup.querySelectorAll('.ph-session-tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.phPanel === targetTab));
  if (tabGroup.dataset.tabGroup) {
    savedPhTabState[tabGroup.dataset.tabGroup] = targetTab;
  }
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
  const hasSessions = hasWorkspaceSessions(activeAgent);
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
        await window.switchAgent(nextRuntimeId);
      } else {
        lastRenderedWorkspaceHtml = '';
        renderCurrentMainView();
      }
    } catch (error) {
      console.error('Failed to compact-resume session:', error);
      window.alert(t('workspace_compacted_resume_failed') + (error && error.message ? error.message : error));
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
    const confirmMsg = t('workspace_compact_summary_confirm');
    const confirmed = window.confirm(confirmMsg);
    if (!confirmed) {
      return;
    }

    markSessionLoading(activeAgent.id, action.sessionId);
    try {
      const result = await createCompactedResumeSession(activeAgent.id, action.sessionId, strategy);
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
        await window.switchAgent(nextRuntimeId);
      } else {
        lastRenderedWorkspaceHtml = '';
        renderCurrentMainView();
      }
    } catch (error) {
      console.error('Failed to compact session:', error);
      clearSessionLoading(activeAgent.id);
      window.alert(t('workspace_compact_failed') + (error?.message || error));
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
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();

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
      loadAgents().catch(() => {});
    } catch (error) {
      console.error('Failed to delete session:', error);
      updateAgentRecord(activeAgent.id, {
        workspace_sessions: { sessions: currentSessions, activeSessionId: targetAgent?.active_workspace_session_id },
        active_workspace_session_id: targetAgent?.active_workspace_session_id,
      });
      lastRenderedWorkspaceHtml = '';
      renderCurrentMainView();
      window.alert((currentLanguage === 'zh' ? '删除会话失败：' : 'Failed to delete session: ') + (error?.message || error));
    }
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
    const shouldMarkLoading = action.type === 'open_session' && action.sessionId;
    if (shouldMarkLoading) {
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
        const previousRuntimeId = normalizeAgentIdentity(activeAgent.runtime_session_id || activeAgent.runtimeSessionId);
        const result = await openPrebuiltWorkspaceSession(activeAgent.id, sessionAction);
        const optimisticAgent = result?.session
          ? (applyOptimisticWorkspaceSession(activeAgent.id, result.session) || activeAgent)
          : activeAgent;
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
            renderCurrentMainView();
          } else {
            await window.switchAgent(nextRuntimeId);
          }
          loadAgents().catch((error) => console.error('Failed to refresh agents after opening prebuilt session:', error));
          return;
        }
        if (result?.status?.status === 'running' && result.status.viewerAgentId) {
          const existingRuntimeId = result.status.viewerAgentId;
          if (existingRuntimeId === currentRuntimeAgentId) {
            renderCurrentMainView();
          } else {
            await loadAgents();
            await window.switchAgent(existingRuntimeId);
          }
          return;
        }
        try {
          const readyAgent = await waitForPrebuiltRuntimeSession(activeAgent.id, 30, { previousRuntimeId });
          if (!readyAgent) return;
          const nextRuntimeId = readyAgent.runtime_session_id || readyAgent.runtimeSessionId || readyAgent.id;
          if (!nextRuntimeId) return;
          if (nextRuntimeId === currentRuntimeAgentId) {
            renderCurrentMainView();
          } else {
            await window.switchAgent(nextRuntimeId);
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
      if (shouldMarkLoading) clearSessionLoading(activeAgent.id);
      else if (triggerButton) triggerButton.classList.remove('action-loading');
    }
  }

  if (action.type === 'show_chat' || action.type === 'resume_session') {
    beginFollowLatestCooldown();
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

window.updateWorkspaceFormDraft = (formId, fieldName, value) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  draft[formId] = draft[formId] || {};
  draft[formId][fieldName] = value;
  const isAssemblyDraft = (agent.id === 'agent-creator' || agent.id === 'flow-workspace') && formId === 'assembly-form';
  if ((agent.id === 'feature-creator' || agent.id === 'agent-creator') && formId === 'startup-form') {
    if (fieldName === 'install_mode' && value === 'custom') {
      draft[formId].target_dir = '';
    }
    draft[formId] = normalizeWorkspaceStartupDraft(agent, draft[formId]);
  }
  saveWorkspaceFormDraft(agent.id, draft);
  if ((agent.id === 'feature-creator' || agent.id === 'agent-creator') && formId === 'startup-form') {
    const directoryDisplay = document.querySelector('[data-workspace-form-display="startup-form:target_dir"]');
    if (directoryDisplay) {
      directoryDisplay.value = draft[formId].target_dir || t('workspace_directory_not_selected');
    }
    const outputNote = document.querySelector('[data-workspace-output-note="startup-form"]');
    if (outputNote) {
      const nextOutputDir = agent.id === 'feature-creator'
        ? getFeatureCreatorOutputDirectory(agent, draft[formId])
        : getAgentCreatorOutputDirectory(agent, draft[formId]);
      outputNote.textContent = nextOutputDir ? `${t('feature_creator_output_dir')}: ${nextOutputDir}` : '';
    }
    if (fieldName === 'install_mode') {
      shouldAnimateWorkspaceSurface = false;
      renderCurrentMainView();
    }
    return;
  }
  if (isAssemblyDraft && !['assembly_stage', 'preset', 'advanced_prompt_open'].includes(fieldName)) {
    scheduleAssemblyWorkbenchRender();
    return;
  }
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

window.toggleWorkspaceSelection = async (formId, fieldName, value) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const token = String(value || '').trim();
  if (!token) return;
  const draft = getWorkspaceFormDraft(agent);
  draft[formId] = draft[formId] || {};
  const next = parseWorkspaceListField(draft[formId][fieldName]);
  const values = new Set(next);
  if (values.has(token)) {
    values.delete(token);
  } else {
    values.add(token);
  }
  const normalizedValues = fieldName === 'selected_features'
    ? canonicalizeAssemblyFeatureSelection(agent, Array.from(values))
    : Array.from(values);
  draft[formId][fieldName] = serializeWorkspaceListField(normalizedValues);
  saveWorkspaceFormDraft(agent.id, draft);
  try {
    await persistWorkspaceState(agent, draft);
  } catch (error) {
    console.error('Failed to persist workspace selection:', error);
  }
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

window.applyWorkspaceBundle = async (formId, bundle) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  draft[formId] = draft[formId] || {};
  const featureValues = new Set(parseWorkspaceListField(draft[formId].selected_features));
  const toolkitValues = new Set(parseWorkspaceListField(draft[formId].recommended_toolkits));
  (Array.isArray(bundle?.features) ? bundle.features : []).forEach((item) => {
    const text = String(item || '').trim();
    if (text) featureValues.add(text);
  });
  (Array.isArray(bundle?.toolkits) ? bundle.toolkits : []).forEach((item) => {
    const text = String(item || '').trim();
    if (text) toolkitValues.add(text);
  });
  draft[formId].selected_features = serializeWorkspaceListField(canonicalizeAssemblyFeatureSelection(agent, Array.from(featureValues)));
  draft[formId].recommended_toolkits = serializeWorkspaceListField(Array.from(toolkitValues));
  saveWorkspaceFormDraft(agent.id, draft);
  try {
    await persistWorkspaceState(agent, draft);
  } catch (error) {
    console.error('Failed to persist workspace bundle:', error);
  }
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

window.createAssemblyEnvironment = async () => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  const form = normalizeAssemblyDraft(draft['assembly-form'] || {});
  const name = String(form.assembly_name || '').trim();
  const selectedFeatures = parseWorkspaceListField(form.selected_features);
  if (!name) {
    window.alert(currentLanguage === 'zh' ? '请先填写 Agent 名称' : 'Please provide an agent name first');
    return;
  }
  const conflicts = findAssemblyConfigConflict(agent, form);
  if (conflicts.conflictingName) {
    window.alert(currentLanguage === 'zh'
      ? `Agent 项目 "${name}" 已存在，请先加载它再配置环境。`
      : `An Agent project named "${name}" already exists. Load it before configuring the environment.`);
    return;
  }
  if (conflicts.conflictingDirectory) {
    window.alert(currentLanguage === 'zh'
      ? `当前环境目录已经被项目 "${conflicts.conflictingDirectory.name || conflicts.conflictingDirectory.id}" 占用，请先加载那个项目，或重置当前草稿。`
      : `This environment directory already belongs to "${conflicts.conflictingDirectory.name || conflicts.conflictingDirectory.id}". Load that project or reset the current draft first.`);
    return;
  }
  try {
    await syncAssemblyEnvironmentDraft(agent, draft, {
      env_status: 'creating',
      env_status_message: currentLanguage === 'zh'
        ? '正在准备用户环境目录...'
        : 'Preparing the user environment directory...',
    });
    let result;
    try {
      result = await requestAssemblyEnvironmentCreate(name, { selectedFeatures });
    } catch (error) {
      if (error?.code === 'ASSEMBLY_ENV_EXISTS') {
        const confirmed = window.confirm(currentLanguage === 'zh'
          ? `目录已存在：\n${error.directory}\n\n是否继续按当前配置重新准备这个环境？`
          : `The environment directory already exists:\n${error.directory}\n\nDo you want to reconfigure this environment with the current setup?`);
        if (!confirmed) {
          await syncAssemblyEnvironmentDraft(agent, draft, {
            env_status: 'stale',
            env_status_message: currentLanguage === 'zh'
              ? '检测到同名目录，已取消重新配置。'
              : 'An existing directory was detected, and reconfiguration was cancelled.',
          });
          return;
        }
        result = await requestAssemblyEnvironmentCreate(name, { force: true, selectedFeatures });
      } else {
        throw error;
      }
    }
    await syncAssemblyEnvironmentDraft(agent, draft, {
      env_created: '1',
      env_dir: result.directory || '',
      env_configured_name: name,
      env_configured_features: serializeWorkspaceListField(selectedFeatures),
      env_status: 'ready',
      env_status_message: result.existed
        ? (currentLanguage === 'zh' ? '已复用并确认现有环境目录。' : 'Reused and confirmed the existing environment directory.')
        : (currentLanguage === 'zh' ? '环境目录已创建完成。' : 'Environment directory created.'),
    }, {
      persist: true,
      openDirectory: result.directory || '',
    });
  } catch (error) {
    console.error('Failed to create assembly environment:', error);
    await syncAssemblyEnvironmentDraft(agent, draft, {
      env_status: 'error',
      env_status_message: (currentLanguage === 'zh' ? '环境创建失败：' : 'Environment creation failed: ') + (error?.message || error),
    }).catch(() => {});
    window.alert('Failed to create environment: ' + (error?.message || error));
  }
};

window.launchAssemblyInstance = async () => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  assemblyLaunchInProgress = true;
  const _t0 = performance.now();
  console.log(`[PERF-CLIENT] launchAssemblyInstance BEGIN assembly=${(getWorkspaceFormDraft(agent)['assembly-form'] || {}).assembly_name}`);
  const draft = getWorkspaceFormDraft(agent);
  const form = normalizeAssemblyDraft(draft['assembly-form'] || {});
  if (!isValidAgentCreatorName(form.assembly_name)) {
    assemblyLaunchInProgress = false;
    window.alert('Assembly name must use lowercase letters, numbers, and hyphens only.');
    return;
  }
  const conflicts = findAssemblyConfigConflict(agent, form);
  if (conflicts.conflictingName) {
    assemblyLaunchInProgress = false;
    window.alert(currentLanguage === 'zh'
      ? `Agent 项目 "${form.assembly_name}" 已存在，请先加载对应项目再启动。`
      : `An Agent project named "${form.assembly_name}" already exists. Load that project before launching.`);
    return;
  }
  if (conflicts.conflictingDirectory) {
    assemblyLaunchInProgress = false;
    window.alert(currentLanguage === 'zh'
      ? `当前环境目录已经被项目 "${conflicts.conflictingDirectory.name || conflicts.conflictingDirectory.id}" 占用，请先切换到那个项目。`
      : `This environment directory already belongs to "${conflicts.conflictingDirectory.name || conflicts.conflictingDirectory.id}". Switch to that project first.`);
    return;
  }
  draft['assembly-form'] = form;
  saveWorkspaceFormDraft(agent.id, draft);
  try {
    await persistWorkspaceState(agent, draft);
    console.log(`[PERF-CLIENT] launchAssemblyInstance persist #1 done (${(performance.now() - _t0).toFixed(0)}ms)`);
    const assemblyName = form.assembly_name;
    const envState = getAssemblyEnvironmentState(form);
    const shouldConfigureEnvironment = envState.needsConfiguration || !envState.configuredDir;
    const selectedFeatures = parseWorkspaceListField(form.selected_features);
    if (assemblyName) {
      if (shouldConfigureEnvironment) {
        console.log(`[PERF-CLIENT] launchAssemblyInstance env needs config, calling requestAssemblyEnvironmentCreate`);
        await syncAssemblyEnvironmentDraft(agent, draft, {
          env_status: 'installing',
          env_status_message: currentLanguage === 'zh'
            ? `正在配置环境并安装依赖${selectedFeatures.length ? `（${selectedFeatures.length} 个 Feature）` : ''}...`
            : `Preparing environment and installing dependencies${selectedFeatures.length ? ` (${selectedFeatures.length} feature(s))` : ''}...`,
        });
        try {
          const envResult = await requestAssemblyEnvironmentCreate(assemblyName, { selectedFeatures });
          console.log(`[PERF-CLIENT] launchAssemblyInstance envCreate done (${(performance.now() - _t0).toFixed(0)}ms)`);
          await syncAssemblyEnvironmentDraft(agent, draft, {
            env_created: '1',
            env_dir: envResult.directory || '',
            env_configured_name: assemblyName,
            env_configured_features: serializeWorkspaceListField(selectedFeatures),
            env_status: 'ready',
            env_status_message: envResult.existed
              ? (currentLanguage === 'zh' ? '已复用环境目录并刷新依赖。' : 'Reused the environment directory and refreshed dependencies.')
              : (currentLanguage === 'zh' ? '环境目录与依赖已准备完成。' : 'Environment directory and dependencies are ready.'),
          }, {
            persist: true,
            openDirectory: envResult.directory || '',
          });
        } catch (error) {
          if (error?.code === 'ASSEMBLY_ENV_EXISTS') {
            const envResult = await requestAssemblyEnvironmentCreate(assemblyName, { force: true, selectedFeatures });
            await syncAssemblyEnvironmentDraft(agent, draft, {
              env_created: '1',
              env_dir: envResult.directory || '',
              env_configured_name: assemblyName,
              env_configured_features: serializeWorkspaceListField(selectedFeatures),
              env_status: 'ready',
              env_status_message: currentLanguage === 'zh'
                ? '已复用环境目录并刷新依赖。'
                : 'Reused the environment directory and refreshed dependencies.',
            }, {
              persist: true,
              openDirectory: envResult.directory || '',
            });
          } else {
            throw error;
          }
        }
      } else {
        console.log(`[PERF-CLIENT] launchAssemblyInstance env already ready, skipping create (${(performance.now() - _t0).toFixed(0)}ms)`);
        await syncAssemblyEnvironmentDraft(agent, draft, {
          env_status: 'ready',
          env_status_message: currentLanguage === 'zh'
            ? '已使用当前已配置环境，直接启动实例。'
            : 'Using the existing configured environment for launch.',
        });
      }
    }
    await syncAssemblyEnvironmentDraft(agent, draft, {
      env_status: 'starting',
      env_status_message: currentLanguage === 'zh'
        ? '正在启动 Agent 测试实例...'
        : 'Starting the chatbot instance...',
    });
    console.log(`[PERF-CLIENT] launchAssemblyInstance calling /assembly_runtime/start (${(performance.now() - _t0).toFixed(0)}ms)`);
    const response = await fetch('/protoclaw/assembly_runtime/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: agent.id,
        agentName: getAssemblyDisplayName(form) || form.assembly_name,
        openDirectory: form.env_dir || envState.configuredDir || '',
        targetDir: form.target_dir || '',
      }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'Assembly runtime failed'));
    }
    await response.json();
    console.log(`[PERF-CLIENT] launchAssemblyInstance /assembly_runtime/start response received (${(performance.now() - _t0).toFixed(0)}ms)`);
    await syncAssemblyEnvironmentDraft(agent, draft, {
      env_status: 'running',
      env_status_message: currentLanguage === 'zh'
        ? 'Chatbot 已启动，运行环境位于用户目录；宿主工作目录仍保持在 Claw。'
        : 'Chatbot is running in the user environment directory while the host workdir remains in Claw.',
    }, {
      persist: true,
    });
    console.log(`[PERF-CLIENT] launchAssemblyInstance persist running done (${(performance.now() - _t0).toFixed(0)}ms)`);
    assemblyLaunchInProgress = false;
    await loadAgents();
    console.log(`[PERF-CLIENT] launchAssemblyInstance loadAgents done (${(performance.now() - _t0).toFixed(0)}ms)`);
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();
    console.log(`[PERF-CLIENT] launchAssemblyInstance COMPLETE (${(performance.now() - _t0).toFixed(0)}ms total)`);
  } catch (error) {
    console.error('Failed to launch assembly runtime:', error);
    assemblyLaunchInProgress = false;
    await syncAssemblyEnvironmentDraft(agent, draft, {
      env_status: 'error',
      env_status_message: (currentLanguage === 'zh' ? '启动失败：' : 'Launch failed: ') + (error && error.message ? error.message : error),
    }, {
      persist: true,
    }).catch(() => {});
    window.alert('Assembly runtime failed: ' + (error && error.message ? error.message : error));
  }
};

function getSavedAssemblyConfigs(agent = getCurrentAgentRecord()) {
  const configs = Array.isArray(getAgentWorkspaceState(agent)?.assemblyConfigs)
    ? getAgentWorkspaceState(agent).assemblyConfigs
    : [];
  return configs
    .map((item) => ({
      id: String(item?.id || '').trim(),
      name: String(item?.name || '').trim(),
      displayName: String(item?.displayName || '').trim(),
      preset: String(item?.preset || '').trim(),
      goal: String(item?.goal || '').trim(),
      targetUser: String(item?.targetUser || '').trim(),
      features: Array.isArray(item?.features) ? item.features.map((value) => String(value || '').trim()).filter(Boolean) : [],
      toolkits: Array.isArray(item?.toolkits) ? item.toolkits.map((value) => String(value || '').trim()).filter(Boolean) : [],
      constraints: String(item?.constraints || '').trim(),
      customSystemPrompt: String(item?.customSystemPrompt || '').trim(),
      envDir: String(item?.envDir || '').trim(),
      envConfiguredName: String(item?.envConfiguredName || '').trim(),
      envConfiguredFeatures: Array.isArray(item?.envConfiguredFeatures) ? item.envConfiguredFeatures.map((value) => String(value || '').trim()).filter(Boolean) : [],
      envStatus: String(item?.envStatus || '').trim(),
      envStatusMessage: String(item?.envStatusMessage || '').trim(),
      modelPreset: String(item?.modelPreset || '').trim(),
      workdir: String(item?.workdir || '').trim(),
      featureConfigs: normalizeFeatureConfigMap(item?.featureConfigs),
      updatedAt: String(item?.updatedAt || '').trim(),
    }))
    .filter((item) => item.id)
    .reduce((acc, item) => {
      if (!acc.some((existing) => existing.id === item.id)) {
        acc.push(item);
      }
      return acc;
    }, [])
    .sort((left, right) => String(right?.updatedAt || '').localeCompare(String(left?.updatedAt || '')));
}

function canonicalizeAssemblyFeatureSelection(agent, values) {
  const packages = Array.isArray(agent?.workspace_data?.['assembly-workbench']?.packages)
    ? agent.workspace_data['assembly-workbench'].packages
    : [];
  const aliasMap = new Map();
  packages.forEach((item) => {
    const packageName = String(item?.packageName || '').trim();
    const id = String(item?.id || '').trim();
    const canonical = packageName || id;
    if (!canonical) return;
    [packageName, id].filter(Boolean).forEach((key) => {
      const normalized = key.toLowerCase();
      if (!aliasMap.has(normalized)) {
        aliasMap.set(normalized, canonical);
      }
    });
  });
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .map((value) => aliasMap.get(value.toLowerCase()) || value)));
}

window.saveCurrentAssemblyConfig = async () => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  const form = normalizeAssemblyDraft(draft['assembly-form'] || {});
  const name = String(form.assembly_name || '').trim();
  const editingId = String(form.editing_config_id || '').trim();
  if (!isValidAgentCreatorName(name)) {
    window.alert('Assembly name must use lowercase letters, numbers, and hyphens only.');
    return;
  }
  const currentState = getAgentWorkspaceState(agent);
  const allConfigs = getSavedAssemblyConfigs(agent);
  const conflicts = findAssemblyConfigConflict(agent, form);
  if (conflicts.conflictingName) {
    window.alert(currentLanguage === 'zh'
      ? `Agent 项目 "${name}" 已存在，请换一个名字，或先加载它再编辑。`
      : `An Agent project named "${name}" already exists. Choose another name or load it before editing.`);
    return;
  }
  if (conflicts.conflictingDirectory) {
    window.alert(currentLanguage === 'zh'
      ? `当前环境目录已经被项目 "${conflicts.conflictingDirectory.name || conflicts.conflictingDirectory.id}" 占用，请先切换到那个项目，或重新配置当前项目的环境。`
      : `This environment directory already belongs to "${conflicts.conflictingDirectory.name || conflicts.conflictingDirectory.id}". Load that project or reconfigure the current environment first.`);
    return;
  }
  if (window.ClawFlowEditor && typeof window.ClawFlowEditor.save === 'function') {
    try {
      await window.ClawFlowEditor.save();
    } catch (error) {
      console.error('Failed to save flow graph before saving assembly config:', error);
    }
  }
  const existing = allConfigs.filter((item) => item.id !== name && item.id !== editingId);
  const hasEnvTrace = !!(String(form.env_dir || '').trim() || form.env_created === '1' || String(form.env_configured_name || '').trim());
  const normalizedFeatures = canonicalizeAssemblyFeatureSelection(agent, parseWorkspaceListField(form.selected_features));
  const normalizedToolkits = parseWorkspaceListField(form.recommended_toolkits);
  const normalizedConfiguredFeatures = canonicalizeAssemblyFeatureSelection(agent, parseWorkspaceListField(form.env_configured_features));
  const projectFeatureConfigs = collectAssemblyProjectFeatureConfigs(agent, form, currentState?.forms?.['feature-configs'] || {});
  const nextConfigs = [
    {
      id: name,
      name,
      preset: String(form.preset || '').trim(),
      goal: String(form.goal || '').trim(),
      targetUser: String(form.target_user || '').trim(),
      features: normalizedFeatures,
      toolkits: normalizedToolkits,
      constraints: String(form.constraints || '').trim(),
      customSystemPrompt: String(form.custom_system_prompt || '').trim(),
      envDir: String(form.env_dir || '').trim(),
      envConfiguredName: hasEnvTrace ? (String(form.env_configured_name || '').trim() || name) : '',
      envConfiguredFeatures: normalizedConfiguredFeatures,
      envStatus: String(form.env_status || '').trim(),
      envStatusMessage: String(form.env_status_message || '').trim(),
      featureConfigs: projectFeatureConfigs,
      updatedAt: new Date().toISOString(),
    },
    ...existing,
  ];
  draft['assembly-form'] = normalizeAssemblyDraft({
    ...form,
    editing_config_id: name,
    selected_features: serializeWorkspaceListField(normalizedFeatures),
    recommended_toolkits: serializeWorkspaceListField(normalizedToolkits),
    env_configured_features: serializeWorkspaceListField(normalizedConfiguredFeatures),
    env_configured_name: hasEnvTrace ? (String(form.env_configured_name || '').trim() || name) : '',
  });
  const payload = {
    forms: draft,
    openDirectory: currentState?.openDirectory || '',
    assemblyConfigs: nextConfigs,
  };
  const response = await fetch('/protoclaw/workspace_state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: agent.id, state: payload }),
  });
  if (!response.ok) {
    window.alert('Failed to save assembly config.');
    return;
  }
  const nextState = await response.json();
  updateAgentWorkspaceState(agent.id, nextState);
  saveWorkspaceFormDraft(agent.id, nextState.forms || {});
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

window.resetAssemblyDraft = async () => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  draft['assembly-form'] = normalizeAssemblyDraft({
    assembly_stage: 'goal',
    preset: 'general-chatbot',
    editing_config_id: '',
    display_name: '',
    env_created: '0',
    env_status: '',
    env_status_message: '',
    env_dir: '',
    env_configured_name: '',
  });
  draft['feature-configs'] = {};
  saveWorkspaceFormDraft(agent.id, draft);
  await persistWorkspaceState(agent, draft, { openDirectory: '' }).catch((error) => {
    console.error('Failed to reset assembly draft:', error);
  });
  setPreferredUnitMode('assembly', agent);
  if (agent?.id === 'flow-workspace' && window.ClawFW?.mode === 'detail') {
    currentWorkspaceTab = 'workspace';
  } else {
    currentWorkspaceTab = 'assembly';
  }
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

window.switchAssemblyEditingTarget = async (target) => {
  const normalized = String(target || '').trim();
  if (!normalized || normalized === '__new__') {
    await window.resetAssemblyDraft();
    return;
  }
  await window.loadSavedAssemblyConfig(normalized);
};

window.toggleAssemblyControlPanel = () => {
  assemblyControlPanelOpen = !assemblyControlPanelOpen;
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

window.jumpAssemblyStage = (stageKey) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  window.updateWorkspaceFormDraft('assembly-form', 'assembly_stage', stageKey);
};

window.loadSavedAssemblyConfig = async (configId) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const config = getSavedAssemblyConfigs(agent).find((item) => item.id === String(configId || '').trim());
  if (!config) return;
  const draft = getWorkspaceFormDraft(agent);
  const previousForm = normalizeAssemblyDraft(draft['assembly-form'] || {});
  const previousMatchesConfig = String(previousForm.assembly_name || '').trim() === String(config.id || '').trim();
  const knownEnvDir = String(config.envDir || (previousMatchesConfig ? previousForm.env_dir : '') || '').trim();
  const knownConfiguredFeatures = Array.isArray(config.envConfiguredFeatures) && config.envConfiguredFeatures.length
    ? config.envConfiguredFeatures
    : (previousMatchesConfig && parseWorkspaceListField(previousForm.env_configured_features).length
      ? parseWorkspaceListField(previousForm.env_configured_features)
      : (knownEnvDir ? config.features : []));
  draft['assembly-form'] = normalizeAssemblyDraft({
    assembly_name: config.id,
    display_name: String(config.displayName || '').trim(),
    editing_config_id: config.id,
    preset: config.preset,
    target_user: config.targetUser,
    goal: config.goal,
    selected_features: serializeWorkspaceListField(config.features),
    recommended_toolkits: serializeWorkspaceListField(config.toolkits),
    constraints: config.constraints,
    custom_system_prompt: config.customSystemPrompt,
    assembly_stage: 'review',
    env_created: knownEnvDir ? '1' : '0',
    env_dir: knownEnvDir,
    env_configured_name: config.envConfiguredName || (previousMatchesConfig ? previousForm.env_configured_name : '') || (knownEnvDir ? config.id : ''),
    env_configured_features: serializeWorkspaceListField(knownConfiguredFeatures),
    env_status: config.envStatus || (previousMatchesConfig ? previousForm.env_status : '') || (knownEnvDir ? 'ready' : ''),
    env_status_message: knownEnvDir
      ? (currentLanguage === 'zh'
        ? (config.envStatus === 'stale' ? '已载入配置；环境需要按当前能力重新配置。' : '已载入配置，可继续修改或重新启动实例。')
        : (config.envStatus === 'stale' ? 'Setup loaded. Reconfigure the environment for the current capabilities.' : 'Setup loaded. You can keep editing or launch a new instance.'))
      : (currentLanguage === 'zh'
        ? '已载入配置；如果这是首次启动，请先配置环境目录。'
        : 'Setup loaded. Configure the environment directory before the first launch.'),
    model_preset: config.modelPreset || '',
    workdir: config.workdir || '',
  });
  draft['feature-configs'] = normalizeFeatureConfigMap(config.featureConfigs);
  saveWorkspaceFormDraft(agent.id, draft);
  try {
    await persistWorkspaceState(agent, draft, { openDirectory: knownEnvDir });
  } catch (error) {
    console.error('Failed to load assembly config:', error);
  }
  setPreferredUnitMode('assembly', agent);
  if (agent?.id === 'flow-workspace' && window.ClawFW?.mode === 'detail') {
    currentWorkspaceTab = 'workspace';
  } else {
    currentWorkspaceTab = 'assembly';
  }
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

window.launchAssemblyConfig = async (configId) => {
  const _t0 = performance.now();
  console.log(`[PERF-CLIENT] launchAssemblyConfig BEGIN configId=${configId}`);
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const config = getSavedAssemblyConfigs(agent).find((item) => item.id === String(configId || '').trim());
  if (!config) return;
  const envDir = String(config.envDir || '').trim();
  const draft = getWorkspaceFormDraft(agent);
  draft['assembly-form'] = {
    assembly_name: config.id,
    display_name: String(config.displayName || '').trim(),
    editing_config_id: config.id,
    preset: config.preset,
    target_user: config.targetUser,
    goal: config.goal,
    selected_features: serializeWorkspaceListField(config.features),
    recommended_toolkits: serializeWorkspaceListField(config.toolkits),
    constraints: config.constraints,
    custom_system_prompt: config.customSystemPrompt,
    assembly_stage: 'review',
    env_created: envDir ? '1' : '0',
    env_dir: envDir,
    env_configured_name: config.envConfiguredName || (envDir ? config.id : ''),
    env_configured_features: serializeWorkspaceListField(config.envConfiguredFeatures || []),
    env_status: config.envStatus || (envDir ? 'ready' : ''),
    env_status_message: '',
  };
  draft['feature-configs'] = normalizeFeatureConfigMap(config.featureConfigs);
  saveWorkspaceFormDraft(agent.id, draft);
  try {
    await persistWorkspaceState(agent, draft, { openDirectory: envDir });
    console.log(`[PERF-CLIENT] launchAssemblyConfig persist done (${(performance.now() - _t0).toFixed(0)}ms)`);
  } catch (error) {
    console.error('Failed to stage assembly config for launch:', error);
  }
  console.log(`[PERF-CLIENT] launchAssemblyConfig calling launchAssemblyInstance (${(performance.now() - _t0).toFixed(0)}ms)`);
  await window.launchAssemblyInstance();
};

window.deleteSavedAssemblyConfig = async (configId) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const normalizedId = String(configId || '').trim();
  const keep = getSavedAssemblyConfigs(agent).filter((item) => item.id !== normalizedId);
  const currentState = getAgentWorkspaceState(agent);
  const draft = getWorkspaceFormDraft(agent);
  const currentForm = normalizeAssemblyDraft(draft['assembly-form'] || {});
  if (String(currentForm.editing_config_id || '').trim() === normalizedId || String(currentForm.assembly_name || '').trim() === normalizedId) {
    draft['assembly-form'] = normalizeAssemblyDraft({
      assembly_stage: 'goal',
      preset: 'general-chatbot',
      editing_config_id: '',
      env_created: '0',
      env_status: '',
      env_status_message: '',
      env_dir: '',
      env_configured_name: '',
      env_configured_features: '',
    });
    draft['feature-configs'] = {};
  }
  const response = await fetch('/protoclaw/workspace_state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: agent.id,
      state: {
        forms: draft,
        openDirectory: currentState?.openDirectory || '',
        assemblyConfigs: keep,
      },
    }),
  });
  if (!response.ok) {
    window.alert('Failed to delete assembly config.');
    return;
  }
  const nextState = await response.json();
  updateAgentWorkspaceState(agent.id, nextState);
  saveWorkspaceFormDraft(agent.id, nextState.forms || {});
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

window.launchSavedAssemblyRun = async (sessionId) => {
  const _t0 = performance.now();
  console.log(`[PERF-CLIENT] launchSavedAssemblyRun BEGIN sessionId=${sessionId}`);
  try {
    const currentAgent = getCurrentAgentRecord();
    const session = getWorkspaceSessionById(currentAgent, sessionId);
    if (session && isAssemblySessionRunning(currentAgent, session)) {
      const liveRuntime = allAgents.find((item) => (
        item?.source === 'prebuilt'
        && String(item?.active_workspace_session_form_id || '') === 'assembly-form'
        && String(item?.active_workspace_session_id || item?.workspace_sessions?.activeSessionId || '').trim() === String(sessionId).trim()
        && (item.runtime_session_id || item.runtimeSessionId || item.id)
      )) || null;
      const liveRuntimeId = liveRuntime?.runtime_session_id || liveRuntime?.runtimeSessionId || liveRuntime?.id || currentAgent?.runtime_session_id || currentAgent?.runtimeSessionId || null;
      if (liveRuntimeId) {
        console.log(`[PERF-CLIENT] launchSavedAssemblyRun already running, switching (${(performance.now() - _t0).toFixed(0)}ms)`);
        await window.switchAgent(liveRuntimeId);
        return;
      }
    }
    const launchRuntime = async () => {
      console.log(`[PERF-CLIENT] launchSavedAssemblyRun calling /assembly_runtime/start (${(performance.now() - _t0).toFixed(0)}ms)`);
      const response = await fetch('/protoclaw/assembly_runtime/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: currentAgent?.id || 'agent-creator', sessionId }),
      });
      if (!response.ok) {
        throw new Error(await response.text().catch(() => 'Assembly runtime failed'));
      }
      const payload = await response.json();
      console.log(`[PERF-CLIENT] launchSavedAssemblyRun /assembly_runtime/start response (${(performance.now() - _t0).toFixed(0)}ms)`);
      await loadAgents();
      console.log(`[PERF-CLIENT] launchSavedAssemblyRun loadAgents done (${(performance.now() - _t0).toFixed(0)}ms)`);
      const nextRuntimeId = payload?.runtime?.id || payload?.runtime?.viewerAgentId || null;
      if (nextRuntimeId) {
        await window.switchAgent(nextRuntimeId);
        console.log(`[PERF-CLIENT] launchSavedAssemblyRun switchAgent done (${(performance.now() - _t0).toFixed(0)}ms)`);
        return;
      }
      selectWorkspaceSurface('agent-creator', { skipFeaturePanel: true });
      shouldAnimateWorkspaceSurface = false;
      renderCurrentMainView();
    };
    await maybeWarnAssemblySessionDrift(currentAgent, sessionId, launchRuntime);
  } catch (error) {
    console.error('Failed to relaunch assembly runtime:', error);
    window.alert('Assembly runtime failed: ' + (error && error.message ? error.message : error));
  }
};

window.fwLaunchConfig = async (configId, btn) => {
  if (btn) { btn.classList.add('fw-btn-busy'); btn.disabled = true; btn.textContent = currentLanguage === 'zh' ? '启动中...' : 'Launching...'; }
  assemblyLaunchInProgress = true;
  const _t0 = performance.now();
  console.log(`[PERF-CLIENT] fwLaunchConfig BEGIN configId=${configId}`);
  try {
    await window.launchAssemblyConfig(configId);
    console.log(`[PERF-CLIENT] fwLaunchConfig COMPLETE (${(performance.now() - _t0).toFixed(0)}ms)`);
  } catch (e) {
    console.error(`[PERF-CLIENT] fwLaunchConfig FAILED (${(performance.now() - _t0).toFixed(0)}ms)`, e);
    if (btn) { btn.classList.remove('fw-btn-busy'); btn.disabled = false; btn.textContent = currentLanguage === 'zh' ? '启动' : 'Launch'; }
  } finally {
    assemblyLaunchInProgress = false;
  }
};

window.fwResumeRun = async (sessionId, btn) => {
  if (btn) { btn.classList.add('fw-btn-busy'); btn.disabled = true; btn.textContent = currentLanguage === 'zh' ? '启动中...' : 'Launching...'; }
  assemblyLaunchInProgress = true;
  const _t0 = performance.now();
  console.log(`[PERF-CLIENT] fwResumeRun BEGIN sessionId=${sessionId}`);
  try {
    await window.launchSavedAssemblyRun(sessionId);
    console.log(`[PERF-CLIENT] fwResumeRun COMPLETE (${(performance.now() - _t0).toFixed(0)}ms)`);
  } catch (e) {
    console.error(`[PERF-CLIENT] fwResumeRun FAILED (${(performance.now() - _t0).toFixed(0)}ms)`, e);
    if (btn) { btn.classList.remove('fw-btn-busy'); btn.disabled = false; btn.textContent = currentLanguage === 'zh' ? '继续' : 'Continue'; }
  } finally {
    assemblyLaunchInProgress = false;
  }
};

window.phOpenModelConfig = async () => {
  const agent = getCurrentAgentRecord();
  if (!agent) return;
  let presets = window.ClawFW?._modelPresets || [];
  if (!presets.length) {
    try {
      const resp = await fetch('/protoclaw/model_config');
      const data = await resp.json();
      presets = Array.isArray(data?.presets) ? data.presets : [];
      if (window.ClawFW) window.ClawFW._modelPresets = presets;
    } catch (e) {
      console.error('Failed to load presets:', e);
    }
  }
  window.phModelConfigAgentId = agent.id;
  renderPhModelConfigOverlay(agent, presets);
};

window.phCloseModelConfig = () => {
  const host = document.getElementById('ph-model-config-host');
  if (host) host.innerHTML = '';
};

window.phSaveModelConfig = async () => {
  const agentId = window.phModelConfigAgentId;
  if (!agentId) return;
  const selects = document.querySelectorAll('#ph-model-config-host .ph-mc-select');
  const modelPresets = { default: null, exploration: null, sub: null, system: null };
  selects.forEach(function(sel) {
    const role = sel.dataset.presetRole;
    if (role && modelPresets.hasOwnProperty(role)) {
      modelPresets[role] = sel.value || null;
    }
  });
  try {
    const resp = await fetch('/protoclaw/agent_model_presets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, modelPresets }),
    });
    const result = await resp.json();
    if (result.ok) {
      const agent = getCurrentAgentRecord();
      if (agent) agent.modelPresets = modelPresets;
      window.phCloseModelConfig();
      try {
        const freshRes = await fetch('/protoclaw/prebuilt_sessions?agentId=' + encodeURIComponent(agentId));
        if (freshRes.ok) {
          const fresh = await freshRes.json();
          updateAgentRecord(agentId, {
            workspace_sessions: fresh,
            active_workspace_session_id: fresh?.activeSessionId || null,
          });
        }
      } catch (e) { /* ignore refresh error */ }
      renderCurrentMainView();
    }
  } catch (e) {
    console.error('Failed to save model preset:', e);
  }
};

window.phSelectDirectoryAndCreateSession = async () => {
  const currentAgent = getCurrentAgentRecord();
  if (!currentAgent || currentAgent.id !== 'programming-helper') {
    console.error('Not in programming-helper workspace');
    return;
  }

  try {
    const result = await invoke('select_directory');
    const chosenPath = Array.isArray(result?.paths) ? String(result.paths[0] || '').trim() : (typeof result?.path === 'string' ? result.path.trim() : '');
    if (!chosenPath) {
      return;
    }

    const addRes = await fetch('/protoclaw/ph_project/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openDirectory: chosenPath }),
    });
    if (!addRes.ok) {
      throw new Error(await addRes.text().catch(() => 'Failed to add project'));
    }

    const stateRes = await fetch('/protoclaw/workspace_state?agentId=' + encodeURIComponent('programming-helper'));
    if (stateRes.ok) {
      const nextState = await stateRes.json();
      updateAgentWorkspaceState('programming-helper', nextState);
    }

    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to add project:', error);
    window.alert((currentLanguage === 'zh' ? '添加项目失败：' : 'Failed to add project: ') + (error?.message || error));
    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
  }
};

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

/* ── Trim dialog state ── */
let trimDialogState = { agentId: '', sessionId: '', rounds: [], loading: false, keepSkillInvokes: 5 };
const trimDialog = document.getElementById('trim-dialog');
const trimRoundList = document.getElementById('trim-round-list');
const trimFooterInfo = document.getElementById('trim-footer-info');
const trimKeepSkillToggle = document.getElementById('trim-keep-skill-toggle');
const trimKeepSkillControl = document.getElementById('trim-keep-skill-control');
const trimKeepSkillValue = document.getElementById('trim-keep-skill-value');
const trimKeepSkillDec = document.getElementById('trim-keep-skill-dec');
const trimKeepSkillInc = document.getElementById('trim-keep-skill-inc');

const SKILL_INVOKE_STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, Infinity];

function getSkillStepIndex(value) {
  const idx = SKILL_INVOKE_STEPS.indexOf(value);
  return idx >= 0 ? idx : 4; // default 5
}

function renderSkillStepper() {
  const enabled = trimKeepSkillToggle.checked;
  trimKeepSkillControl.classList.toggle('disabled', !enabled);
  const value = trimDialogState.keepSkillInvokes;
  trimKeepSkillValue.textContent = value === Infinity ? '∞' : String(value);
}

trimKeepSkillToggle.addEventListener('change', () => {
  if (trimKeepSkillToggle.checked) {
    trimDialogState.keepSkillInvokes = SKILL_INVOKE_STEPS[4]; // reset to 5
  } else {
    trimDialogState.keepSkillInvokes = null;
  }
  renderSkillStepper();
});

trimKeepSkillDec.addEventListener('click', () => {
  const cur = getSkillStepIndex(trimDialogState.keepSkillInvokes);
  if (cur > 0) {
    trimDialogState.keepSkillInvokes = SKILL_INVOKE_STEPS[cur - 1];
    renderSkillStepper();
  }
});

trimKeepSkillInc.addEventListener('click', () => {
  const cur = getSkillStepIndex(trimDialogState.keepSkillInvokes);
  if (cur < SKILL_INVOKE_STEPS.length - 1) {
    trimDialogState.keepSkillInvokes = SKILL_INVOKE_STEPS[cur + 1];
    renderSkillStepper();
  }
});

window.openTrimDialog = async (agentId, sessionId) => {
  trimDialogState = { agentId, sessionId, rounds: [], loading: true, keepSkillInvokes: 5 };
  trimKeepSkillToggle.checked = true;
  renderSkillStepper();
  closeCompactMenu();
  trimDialog.style.display = '';
  document.getElementById('trim-submit').disabled = true;
  trimRoundList.innerHTML = '<div class="trim-loading">加载中...</div>';
  trimFooterInfo.textContent = '';

  try {
    const res = await fetch('/protoclaw/session_trim_preview?agentId=' + encodeURIComponent(agentId) + '&sessionId=' + encodeURIComponent(sessionId));
    if (!res.ok) throw new Error(await res.text().catch(() => 'failed'));
    const data = await res.json();
    trimDialogState.rounds = data.rounds || [];
    trimDialogState.loading = false;
    if (trimDialogState.rounds.length === 0) {
      trimRoundList.innerHTML = '<div class="trim-loading">无可用轮次</div>';
      trimFooterInfo.textContent = '';
      return;
    }
    document.getElementById('trim-submit').disabled = false;
    renderTrimRoundList();
  } catch (err) {
    trimRoundList.innerHTML = '<div class="trim-loading">加载失败：' + escapeHtml(err.message || err) + '</div>';
    trimFooterInfo.textContent = '';
  }
};

window.closeTrimDialog = () => {
  trimDialog.style.display = 'none';
  trimDialogState = { agentId: '', sessionId: '', rounds: [], loading: false, keepSkillInvokes: 5 };
};

function renderTrimRoundList() {
  const rounds = trimDialogState.rounds;
  if (!rounds.length) {
    trimRoundList.innerHTML = '<div class="trim-loading">无可用轮次</div>';
    return;
  }

  trimRoundList.innerHTML = rounds.map((r, idx) => {
    const checked = r.suggestedTrim ? ' checked' : '';
    const trimmedClass = r.suggestedTrim ? ' trimmed' : '';

    return [
      `<div class="trim-round-item${trimmedClass}" data-trim-index="${idx}">`,
      `<input type="checkbox" class="trim-checkbox" data-trim-index="${idx}"${checked} />`,
      `<div class="trim-round-content">`,
      `<div class="trim-round-index">第 ${idx + 1} 轮${r.messageCount ? ' · ' + r.messageCount + ' 条消息' : ''}${r.toolCalls && r.toolCalls.length ? ' · <span class="trim-tool-count">' + r.toolCalls.length + ' 次调用</span>' : ''}</div>`,
      r.userPreview ? `<div class="trim-round-preview">${escapeHtml(r.userPreview)}</div>` : '',
      `</div>`,
      `<button class="trim-to-here-btn" type="button" data-trim-to="${idx}">精简到此处</button>`,
      `</div>`,
    ].join('');
  }).join('');

  updateTrimFooterInfo();
}

function handleTrimCheckboxChange(event) {
  const cb = event.target;
  if (!cb.classList.contains('trim-checkbox')) return;
  const idx = parseInt(cb.dataset.trimIndex, 10);
  const item = cb.closest('.trim-round-item');
  if (cb.checked) {
    item.classList.add('trimmed');
  } else {
    item.classList.remove('trimmed');
  }
  trimDialogState.rounds[idx].suggestedTrim = cb.checked;
  updateTrimFooterInfo();
}

function handleTrimToHere(event) {
  const btn = event.target.closest('.trim-to-here-btn');
  if (!btn) return;
  const targetIdx = parseInt(btn.dataset.trimTo, 10);
  const rounds = trimDialogState.rounds;
  for (let i = 0; i < rounds.length; i++) {
    const shouldTrim = i <= targetIdx;
    rounds[i].suggestedTrim = shouldTrim;
  }
  trimRoundList.querySelectorAll('.trim-round-item').forEach((item, idx) => {
    const cb = item.querySelector('.trim-checkbox');
    if (rounds[idx].suggestedTrim) {
      item.classList.add('trimmed');
      cb.checked = true;
    } else {
      item.classList.remove('trimmed');
      cb.checked = false;
    }
  });
  updateTrimFooterInfo();
}

function updateTrimFooterInfo() {
  const rounds = trimDialogState.rounds;
  const trimmed = rounds.filter(r => r.suggestedTrim).length;
  const kept = rounds.length - trimmed;
  trimFooterInfo.textContent = currentLanguage === 'zh'
    ? `共 ${rounds.length} 轮，精简 ${trimmed} 轮，保留 ${kept} 轮`
    : `${rounds.length} rounds, trim ${trimmed}, keep ${kept}`;
}

trimRoundList.addEventListener('change', handleTrimCheckboxChange);
trimRoundList.addEventListener('click', handleTrimToHere);

window.submitTrimCompact = async () => {
  const { agentId, sessionId, rounds, keepSkillInvokes } = trimDialogState;
  if (!agentId || !sessionId || !rounds.length) return;

  let fullPreserveFromTurn = null;
  const firstKeptIndex = rounds.findIndex(r => !r.suggestedTrim);
  if (firstKeptIndex >= 0) {
    fullPreserveFromTurn = rounds[firstKeptIndex].turnStart;
  }

  const policy = {};
  if (keepSkillInvokes != null && keepSkillInvokes > 0) {
    policy.keepRecentSkillInvokes = keepSkillInvokes;
  }

  window.closeTrimDialog();
  markSessionLoading(agentId, sessionId);

  try {
    const result = await createCompactedResumeSession(agentId, sessionId, '', null, fullPreserveFromTurn, policy);
    if (result?.agent) {
      applyManagedPrebuiltAgent(agentId, result.agent);
    }
    await loadAgents();
    const nextRuntimeId =
      result?.agent?.runtime_session_id
      || result?.agent?.runtimeSessionId
      || null;
    if (nextRuntimeId) {
      setPreferredUnitMode('chat', allAgents.find((agent) => agent.id === agentId) || getCurrentAgentRecord());
      await window.switchAgent(nextRuntimeId);
    } else {
      lastRenderedWorkspaceHtml = '';
      renderCurrentMainView();
    }
  } catch (error) {
    console.error('Failed to trim compact session:', error);
    clearSessionLoading(agentId);
    window.alert((currentLanguage === 'zh' ? '精简失败：' : 'Trim failed: ') + (error?.message || error));
  }
};

/* ── Branch dialog state ── */
let branchDialogState = { agentId: '', sessionId: '', rounds: [], selectedIdx: -1 };
const branchDialog = document.getElementById('branch-dialog');
const branchRoundList = document.getElementById('branch-round-list');
const branchFooterInfo = document.getElementById('branch-footer-info');

window.openBranchDialog = async (agentId, sessionId) => {
  branchDialogState = { agentId, sessionId, rounds: [], selectedIdx: -1 };
  closeCompactMenu();
  branchDialog.style.display = '';
  document.getElementById('branch-submit').disabled = true;
  branchRoundList.innerHTML = '<div class="trim-loading">加载中...</div>';
  branchFooterInfo.textContent = '';

  try {
    const res = await fetch('/protoclaw/session_trim_preview?agentId=' + encodeURIComponent(agentId) + '&sessionId=' + encodeURIComponent(sessionId));
    if (!res.ok) throw new Error(await res.text().catch(() => 'failed'));
    const data = await res.json();
    branchDialogState.rounds = data.rounds || [];
    if (branchDialogState.rounds.length === 0) {
      branchRoundList.innerHTML = '<div class="trim-loading">无可用轮次</div>';
      branchFooterInfo.textContent = '';
      return;
    }
    renderBranchRoundList();
  } catch (err) {
    branchRoundList.innerHTML = '<div class="trim-loading">加载失败：' + escapeHtml(err.message || err) + '</div>';
    branchFooterInfo.textContent = '';
  }
};

window.closeBranchDialog = () => {
  branchDialog.style.display = 'none';
  branchDialogState = { agentId: '', sessionId: '', rounds: [], selectedIdx: -1 };
};

function renderBranchRoundList() {
  const rounds = branchDialogState.rounds;
  if (!rounds.length) {
    branchRoundList.innerHTML = '<div class="trim-loading">无可用轮次</div>';
    return;
  }

  branchRoundList.innerHTML = rounds.map((r, idx) => {
    return [
      `<div class="trim-round-item branch-selectable" data-branch-index="${idx}">`,
      `<div class="trim-round-content">`,
      `<div class="trim-round-index">第 ${idx + 1} 轮${r.messageCount ? ' · ' + r.messageCount + ' 条消息' : ''}${r.toolCalls && r.toolCalls.length ? ' · <span class="trim-tool-count">' + r.toolCalls.length + ' 次调用</span>' : ''}</div>`,
      r.userPreview ? `<div class="trim-round-preview">${escapeHtml(r.userPreview)}</div>` : '',
      `</div>`,
      `</div>`,
    ].join('');
  }).join('');

  updateBranchFooterInfo();
}

function handleBranchRoundClick(event) {
  const item = event.target.closest('.trim-round-item[data-branch-index]');
  if (!item) return;
  const idx = parseInt(item.dataset.branchIndex, 10);
  if (isNaN(idx)) return;
  branchDialogState.selectedIdx = idx;
  document.getElementById('branch-submit').disabled = false;

  const items = branchRoundList.querySelectorAll('.trim-round-item[data-branch-index]');
  items.forEach((el, i) => {
    el.classList.remove('branch-kept', 'branch-cut', 'branch-dimmed');
    if (i <= idx) {
      el.classList.add('branch-kept');
    } else {
      el.classList.add('branch-dimmed');
    }
    if (i === idx) {
      el.classList.add('branch-cut');
    }
  });
  updateBranchFooterInfo();
}

function updateBranchFooterInfo() {
  const rounds = branchDialogState.rounds;
  const idx = branchDialogState.selectedIdx;
  if (idx < 0 || !rounds.length) {
    branchFooterInfo.textContent = currentLanguage === 'zh'
      ? `共 ${rounds.length} 轮，点击选择分支点`
      : `${rounds.length} rounds, click to select branch point`;
    return;
  }
  const kept = idx + 1;
  const cut = rounds.length - kept;
  branchFooterInfo.textContent = currentLanguage === 'zh'
    ? `共 ${rounds.length} 轮，保留 ${kept} 轮，截断 ${cut} 轮`
    : `${rounds.length} rounds, keep ${kept}, cut ${cut}`;
}

branchRoundList.addEventListener('click', handleBranchRoundClick);

window.submitBranch = async () => {
  const { agentId, sessionId, rounds, selectedIdx } = branchDialogState;
  if (!agentId || !sessionId || selectedIdx < 0 || !rounds.length) return;

  const cutMsgIndexEnd = rounds[selectedIdx].msgIndexEnd;

  window.closeBranchDialog();
  markSessionLoading(agentId, sessionId);

  try {
    const res = await fetch('/protoclaw/sessions/branch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, sourceSessionId: sessionId, cutMsgIndexEnd }),
    });
    if (!res.ok) throw new Error(await res.text().catch(() => 'failed'));
    const result = await res.json();

    if (result?.agent) {
      applyManagedPrebuiltAgent(agentId, result.agent);
    }
    await loadAgents();
    const nextRuntimeId =
      result?.agent?.runtime_session_id
      || result?.agent?.runtimeSessionId
      || null;
    if (nextRuntimeId) {
      setPreferredUnitMode('chat', allAgents.find((agent) => agent.id === agentId) || getCurrentAgentRecord());
      await window.switchAgent(nextRuntimeId);
    } else {
      lastRenderedWorkspaceHtml = '';
      renderCurrentMainView();
    }
  } catch (error) {
    console.error('Failed to branch session:', error);
    clearSessionLoading(agentId);
    window.alert((currentLanguage === 'zh' ? '分支失败：' : 'Branch failed: ') + (error?.message || error));
  }
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

window.deleteAssemblySessionRecord = async (sessionId) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const session = getWorkspaceSessionById(agent, sessionId);
  const confirmed = window.confirm(currentLanguage === 'zh'
    ? `确认删除这个实例记录？\n${session?.agentName || sessionId}`
    : `Delete this instance record?\n${session?.agentName || sessionId}`);
  if (!confirmed) return;

  try {
    const affectedRuntimeId = agent?.runtime_session_id || agent?.runtimeSessionId || null;
    const deletedWasActive = sessionId === (agent?.active_workspace_session_id || agent?.workspace_sessions?.activeSessionId || null);
    const response = await fetch('/protoclaw/prebuilt_sessions/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: agent.id,
        sessionId,
      }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'delete session failed'));
    }
    const result = await response.json();
    if (result?.assemblyRuntime?.status === 'stopped' || result?.assemblyRuntime?.status === 'stopping') {
      await loadAgents();
      if (currentRuntimeAgentId) {
        selectWorkspaceSurface(agent.id, { skipFeaturePanel: true });
      }
    }
    if (result?.deleted?.sessions) {
      updateAgentRecord(agent.id, {
        workspace_sessions: result.deleted.sessions,
        active_workspace_session_id: result.deleted.activeSessionId || null,
      });
    }
    if (result?.agent) {
      applyManagedPrebuiltAgent(agent.id, result.agent);
    } else if (deletedWasActive) {
      applyManagedPrebuiltAgent(agent.id, null);
    }
    renderAgentList();
    renderCurrentMainView();

    const nextRuntimeId = result?.agent?.runtime_session_id || result?.agent?.runtimeSessionId || null;
    if (nextRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
      await window.switchAgent(nextRuntimeId);
    } else if (affectedRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
      selectWorkspaceSurface(agent.id, { skipFeaturePanel: true });
    }
  } catch (error) {
    console.error('Failed to delete assembly session record:', error);
    window.alert((currentLanguage === 'zh' ? '删除实例记录失败：' : 'Failed to delete instance record: ') + (error?.message || error));
  }
};

window.loadAssemblySessionIntoDraft = async (sessionId) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const session = getWorkspaceSessionById(agent, sessionId);
  if (!session) return;
  const savedConfig = getSavedAssemblyConfigs(agent).find((item) => item.id === String(session.agentName || '').trim()) || null;
  const currentDraft = getWorkspaceFormDraft(agent);

  if (savedConfig) {
    await window.loadSavedAssemblyConfig(savedConfig.id);
  } else {
    currentDraft['assembly-form'] = normalizeAssemblyDraft({
      ...(currentDraft['assembly-form'] || {}),
      assembly_name: String(session.agentName || '').trim(),
      editing_config_id: '',
      assembly_stage: 'review',
      env_created: session.openDirectory ? '1' : '0',
      env_dir: String(session.openDirectory || '').trim(),
      env_configured_name: String(session.agentName || '').trim(),
      env_status: isAssemblySessionRunning(agent, session) ? 'running' : 'ready',
      env_status_message: isAssemblySessionRunning(agent, session)
        ? (currentLanguage === 'zh' ? '这个实例当前正在运行。' : 'This chatbot instance is currently running.')
        : (currentLanguage === 'zh' ? '已从历史实例恢复基础信息。' : 'Restored base information from the previous instance.'),
    });
    saveWorkspaceFormDraft(agent.id, currentDraft);
    await persistWorkspaceState(agent, currentDraft, {
      openDirectory: String(session.openDirectory || '').trim(),
    });
  }

  setPreferredUnitMode('assembly', agent);
  if (agent?.id === 'flow-workspace' && window.ClawFW?.mode === 'detail') {
    currentWorkspaceTab = 'workspace';
  } else {
    currentWorkspaceTab = 'assembly';
  }
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

window.stopAssemblySessionRuntime = async (sessionId) => {
  try {
    const response = await fetch('/protoclaw/assembly_runtime/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'stop assembly runtime failed'));
    }
    await response.json();
    const currentAgent = getCurrentAgentRecord();
    if (currentAgent?.id === 'agent-creator') {
      const draft = getWorkspaceFormDraft(currentAgent);
      const form = normalizeAssemblyDraft(draft['assembly-form'] || {});
      const session = getWorkspaceSessionById(currentAgent, sessionId);
      if (session && String(form.assembly_name || '').trim() === String(session.agentName || '').trim()) {
        await syncAssemblyEnvironmentDraft(currentAgent, draft, {
          env_status: 'ready',
          env_status_message: currentLanguage === 'zh'
            ? '实例已关闭，配置仍可继续编辑或重新启动。'
            : 'Instance stopped. The setup remains available for editing or relaunching.',
        }, {
          persist: true,
        }).catch(() => {});
      }
    }
    await loadAgents();
    if (currentRuntimeAgentId && !allAgents.some((item) => item.id === currentRuntimeAgentId)) {
      selectWorkspaceSurface('agent-creator', { skipFeaturePanel: true });
    }
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to stop assembly runtime:', error);
    window.alert((currentLanguage === 'zh' ? '关闭实例失败：' : 'Failed to stop instance: ') + (error?.message || error));
  }
};

window.chooseWorkspaceDirectory = async (formId, fieldName) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  try {
    const useExistingDirectory = agent.id === 'programming-helper';
    const selected = await invoke(useExistingDirectory ? 'select_directory' : 'select_empty_directory');
    if (selected?.cancelled || !selected?.path) {
      return;
    }
    const draft = getWorkspaceFormDraft(agent);
    draft[formId] = draft[formId] || {};
    draft[formId][fieldName] = selected?.path || '';
    saveWorkspaceFormDraft(agent.id, draft);
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();
    persistWorkspaceState(agent, draft).catch((error) => {
      console.error('Failed to persist directory selection:', error);
    });
  } catch (error) {
    window.alert(t('workspace_pick_directory_failed') + (error && error.message ? error.message : error));
  }
};

window.saveWorkspaceForm = async (formId, rawAction) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  let openDirectoryOverride = null;
  if (agent.id === 'feature-creator' && formId === 'startup-form') {
    const startupDraft = normalizeWorkspaceStartupDraft(agent, draft[formId] || {});
    draft[formId] = startupDraft;
    if (!isValidFeatureCreatorName(startupDraft.feature_name)) {
      window.alert(t('feature_creator_invalid_name'));
      return;
    }
    if (startupDraft.install_mode === 'custom' && !startupDraft.target_dir) {
      window.alert(t('workspace_pick_directory_hint'));
      return;
    }
    if (rawAction) {
      try {
        const response = await fetch('/protoclaw/feature_creator/initialize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            featureName: startupDraft.feature_name,
            parentDir: startupDraft.target_dir,
          }),
        });
        if (!response.ok) {
          throw new Error(await response.text().catch(() => 'Feature initialization failed'));
        }
        const result = await response.json();
        openDirectoryOverride = result?.outputDir || getFeatureCreatorOutputDirectory(agent, startupDraft);
      } catch (error) {
        window.alert(t('feature_creator_init_failed') + (error && error.message ? error.message : error));
        return;
      }
    }
  } else if (agent.id === 'agent-creator' && formId === 'startup-form') {
    const startupDraft = normalizeWorkspaceStartupDraft(agent, draft[formId] || {});
    draft[formId] = startupDraft;
    if (!isValidAgentCreatorName(startupDraft.agent_name)) {
      window.alert('Agent name must use lowercase letters, numbers, and hyphens only.');
      return;
    }
    if (startupDraft.install_mode === 'custom' && !startupDraft.target_dir) {
      window.alert(t('workspace_pick_directory_hint'));
      return;
    }
    if (rawAction) {
      try {
        const response = await fetch('/protoclaw/agent_creator/initialize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentName: startupDraft.agent_name,
            parentDir: startupDraft.target_dir,
            goal: startupDraft.goal || '',
          }),
        });
        if (!response.ok) {
          throw new Error(await response.text().catch(() => 'Agent initialization failed'));
        }
        const result = await response.json();
        openDirectoryOverride = result?.outputDir || getAgentCreatorOutputDirectory(agent, startupDraft);
      } catch (error) {
        window.alert('Agent initialization failed: ' + (error && error.message ? error.message : error));
        return;
      }
    }
  } else if (agent.id === 'agent-creator' && formId === 'assembly-form') {
    const assemblyDraft = { ...(draft[formId] || {}) };
    if (!isValidAgentCreatorName(assemblyDraft.assembly_name)) {
      window.alert('Assembly name must use lowercase letters, numbers, and hyphens only.');
      return;
    }
    draft[formId] = assemblyDraft;
  }
  saveWorkspaceFormDraft(agent.id, draft);
  try {
    await persistWorkspaceState(agent, draft, { openDirectory: openDirectoryOverride });
  } catch (error) {
    console.error('Failed to persist workspace form:', error);
    window.alert(`Workspace save failed: ${error && error.message ? error.message : error}`);
    return;
  }
  if (rawAction) {
    await window.runWorkspaceAction(rawAction);
    return;
  }
  renderCurrentMainView();
};

window.resetWorkspaceForm = async (formId) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  if (formId) {
    delete draft[formId];
    saveWorkspaceFormDraft(agent.id, draft);
  } else {
    resetWorkspaceFormDraft(agent.id);
  }
  try {
    await persistWorkspaceState(agent, formId ? draft : {});
  } catch (error) {
    console.error('Failed to reset workspace form state:', error);
  }
  renderCurrentMainView();
};

window.updateQQBotConfigDraft = (fieldName, value) => {
  qqbotConfigState.draft = normalizeQQBotConfigData({
    ...getQQBotConfigDraft(),
    [fieldName]: value,
  });
};

window.updateIMWorkspaceField = (fieldPath, value) => {
  const draft = getIMWorkspaceDraft();
  const nextDraft = JSON.parse(JSON.stringify(draft));
  const segments = String(fieldPath || '').split('.').filter(Boolean);
  let cursor = nextDraft;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = segments[index];
    if (!cursor[key] || typeof cursor[key] !== 'object') {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  if (segments.length > 0) {
    cursor[segments[segments.length - 1]] = value;
  }
  imWorkspaceState.draft = nextDraft;
  window.scheduleIMWorkspaceAutoSave();
  renderCurrentMainView();
};

window.updateIMQQConfigDraft = (fieldName, value) => {
  const draft = getIMWorkspaceDraft();
  imWorkspaceState.draft = {
    ...draft,
    qqConfig: normalizeQQBotConfigData({
      ...(draft.qqConfig || {}),
      [fieldName]: value,
    }),
  };
  window.scheduleIMWorkspaceAutoSave();
  renderCurrentMainView();
};

window.scheduleIMWorkspaceAutoSave = () => {
  if (imWorkspaceAutoSaveTimer) {
    clearTimeout(imWorkspaceAutoSaveTimer);
  }
  imWorkspaceAutoSaveTimer = setTimeout(() => {
    window.saveIMWorkspaceConfig().catch((error) => {
      console.error('Failed to auto-save IM workspace config:', error);
    });
  }, 250);
};

window.reloadIMWorkspaceConfig = async () => {
  try {
    await ensureIMWorkspaceLoaded(true);
  } catch (error) {
    console.error('Failed to reload IM workspace config:', error);
  }
};

window.saveIMWorkspaceConfig = async () => {
  if (imWorkspaceAutoSaveTimer) {
    clearTimeout(imWorkspaceAutoSaveTimer);
    imWorkspaceAutoSaveTimer = null;
  }
  imWorkspaceState.saving = true;
  imWorkspaceState.error = '';
  renderCurrentMainView();
  try {
    const response = await fetch('/protoclaw/im_workspace_bundle', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceConfig: getIMWorkspaceDraft().workspaceConfig,
        qqConfig: getIMWorkspaceDraft().qqConfig,
      }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'Failed to save IM workspace config'));
    }
    const payload = await response.json();
    const bundle = normalizeIMWorkspaceBundleData(payload || {});
    imWorkspaceState.data = bundle;
    imWorkspaceState.draft = JSON.parse(JSON.stringify(bundle));
    imWorkspaceState.savedAt = payload?.savedAt || new Date().toISOString();
    if (payload?.portalRestarted) {
      loadAgents().catch((e) => console.error('Failed to refresh agents after portal restart:', e));
    }
  } catch (error) {
    imWorkspaceState.error = error && error.message ? error.message : String(error);
    console.error('Failed to save IM workspace config:', error);
  } finally {
    imWorkspaceState.saving = false;
    renderCurrentMainView();
  }
};

window._creatingReceptionistSession = false;

window.createReceptionistSession = async (triggerButton) => {
  window._creatingReceptionistSession = true;
  if (triggerButton) markActionLoading(triggerButton);
  try {
    await window.saveIMWorkspaceConfig();
    const agent = getCurrentAgentRecord();
    await window.runWorkspaceAction(JSON.stringify({ type: 'create_session' }), triggerButton);
    // Update receptionistSessionId to the newly created session
    if (agent?.id) {
      const updated = allAgents.find(a => a.id === agent.id);
      const newActiveId = updated?.active_workspace_session_id || updated?.workspace_sessions?.activeSessionId;
      if (newActiveId) {
        window.updateIMWorkspaceField('workspaceConfig.receptionistSessionId', newActiveId);
        window.saveIMWorkspaceConfig().catch(() => {});
      }
    }
  } finally {
    window._creatingReceptionistSession = false;
    const btn = document.querySelector('.im-new-chat-btn');
    if (btn) btn.classList.remove('action-loading');
  }
};

window.handleLineCarrierChange = async (lineId, carrier) => {
  if (!lineId) return;

  imWorkspaceState.saving = true;
  renderCurrentMainView();
  try {
    const response = await fetch('/protoclaw/im_line_transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineId, carrier: carrier || '' }),
    });
    if (!response.ok) throw new Error(await response.text().catch(() => 'Line update failed'));
    const payload = await response.json();
    if (payload.bundle) {
      const bundle = normalizeIMWorkspaceBundleData(payload.bundle);
      imWorkspaceState.data = bundle;
      imWorkspaceState.draft = JSON.parse(JSON.stringify(bundle));
    }
  } catch (error) {
    console.error('Failed to update line carrier:', error);
    imWorkspaceState.error = error && error.message ? error.message : String(error);
  } finally {
    imWorkspaceState.saving = false;
    renderCurrentMainView();
  }
};

window.handleLineSessionChange = async (lineId, sessionId) => {
  if (!lineId) return;

  const draft = getIMWorkspaceDraft();
  const line = (draft.workspaceConfig?.lines || []).find(l => l.id === lineId);
  const carrier = line?.carrier || '';
  if (!carrier) return;

  imWorkspaceState.saving = true;
  renderCurrentMainView();
  try {
    if (!sessionId) {
      // Disconnect session from line
      const response = await fetch('/protoclaw/im_line_disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineId }),
      });
      if (!response.ok) throw new Error(await response.text().catch(() => 'Disconnect failed'));
      const payload = await response.json();
      if (payload.bundle) {
        const bundle = normalizeIMWorkspaceBundleData(payload.bundle);
        imWorkspaceState.data = bundle;
        imWorkspaceState.draft = JSON.parse(JSON.stringify(bundle));
      }
    } else {
      // Transfer line to session
      const response = await fetch('/protoclaw/im_line_transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineId, carrier, agentId: 'programming-helper', sessionId }),
      });
      if (!response.ok) throw new Error(await response.text().catch(() => 'Transfer failed'));
      const payload = await response.json();
      if (payload.bundle) {
        const bundle = normalizeIMWorkspaceBundleData(payload.bundle);
        imWorkspaceState.data = bundle;
        imWorkspaceState.draft = JSON.parse(JSON.stringify(bundle));
      }
    }
  } catch (error) {
    console.error('Failed to update line session:', error);
    imWorkspaceState.error = error && error.message ? error.message : String(error);
  } finally {
    imWorkspaceState.saving = false;
    renderCurrentMainView();
  }
};

window.launchReceptionistSession = async (sessionId, triggerButton) => {
  window.updateIMWorkspaceField('workspaceConfig.receptionistSessionId', sessionId);
  await window.saveIMWorkspaceConfig();
  await window.runWorkspaceAction(JSON.stringify({ type: 'open_session', sessionId }), triggerButton);
};

window.startWeixinBinding = async () => {
  imWorkspaceState.binding = true;
  imWorkspaceState.error = '';
  renderCurrentMainView();
  try {
    const response = await fetch('/protoclaw/im_workspace_bundle/weixin_bind/start', { method: 'POST' });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'Failed to start Weixin binding'));
    }
    const payload = await response.json();
    const bundle = normalizeIMWorkspaceBundleData(payload || {});
    imWorkspaceState.data = bundle;
    imWorkspaceState.draft = JSON.parse(JSON.stringify(bundle));
    if (bundle.binding?.qrcodeDataUrl) {
      window._imChannelDetailId = 'weixin';
      if (!window._imChannelConfigOpen) window._imChannelConfigOpen = true;
    }
  } catch (error) {
    imWorkspaceState.error = error && error.message ? error.message : String(error);
    console.error('Failed to start Weixin binding:', error);
  } finally {
    imWorkspaceState.binding = false;
    renderCurrentMainView();
  }
};

window.refreshWeixinBinding = async () => {
  imWorkspaceState.polling = true;
  imWorkspaceState.error = '';
  renderCurrentMainView();
  try {
    const response = await fetch('/protoclaw/im_workspace_bundle/weixin_bind/status');
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'Failed to refresh Weixin binding status'));
    }
    const payload = await response.json();
    const bundle = normalizeIMWorkspaceBundleData(payload || {});
    imWorkspaceState.data = bundle;
    imWorkspaceState.draft = JSON.parse(JSON.stringify(bundle));
  } catch (error) {
    imWorkspaceState.error = error && error.message ? error.message : String(error);
    console.error('Failed to refresh Weixin binding status:', error);
  } finally {
    imWorkspaceState.polling = false;
    renderCurrentMainView();
  }
};

window.logoutWeixinBinding = async () => {
  imWorkspaceState.polling = true;
  imWorkspaceState.error = '';
  renderCurrentMainView();
  try {
    const response = await fetch('/protoclaw/im_workspace_bundle/weixin_logout', { method: 'POST' });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'Failed to unbind Weixin'));
    }
    const payload = await response.json();
    const bundle = normalizeIMWorkspaceBundleData(payload || {});
    imWorkspaceState.data = bundle;
    imWorkspaceState.draft = JSON.parse(JSON.stringify(bundle));
  } catch (error) {
    imWorkspaceState.error = error && error.message ? error.message : String(error);
    console.error('Failed to unbind Weixin:', error);
  } finally {
    imWorkspaceState.polling = false;
    renderCurrentMainView();
  }
};

window.showWeixinQrCodeDialog = () => {
  imWorkspaceState.weixinQrDialogOpen = true;
  renderCurrentMainView();
};

window.closeWeixinQrCodeDialog = () => {
  imWorkspaceState.weixinQrDialogOpen = false;
  renderCurrentMainView();
};

// ── IM Channel Config Dialog ──────────────────────────────────────
window._imChannelConfigOpen = false;
window._imChannelDetailId = null;

window.openIMChannelConfig = () => {
  window._imChannelConfigOpen = true;
  window._imChannelDetailId = null;
  renderCurrentMainView();
};

window.closeIMChannelConfig = () => {
  window._imChannelConfigOpen = false;
  window._imChannelDetailId = null;
  renderCurrentMainView();
};

window.openIMChannelDetail = (channelId) => {
  window._imChannelDetailId = channelId;
  renderCurrentMainView();
};

window.closeIMChannelDetail = () => {
  window._imChannelDetailId = null;
  renderCurrentMainView();
};

// ── Dispatch Console ──────────────────────────────────────────────
window._dispatchSchedules = [];
window._dispatchAgents = [];
window._dispatchSessions = [];
window._dispatchProjects = [];
window._dispatchSelectedAgent = null;
window._dispatchTriggerType = 'timer';
window._dispatchMode = 'continue';
window._dispatchSchedulesLoaded = false;
window._dispatchAgentsLoaded = false;
window._dispatchListTab = 'pending';

window.loadDispatchSchedules = async () => {
  try {
    const res = await fetch('/protoclaw/dispatch/schedules');
    const data = await res.json();
    window._dispatchSchedules = Array.isArray(data?.schedules) ? data.schedules : [];
  } catch (e) {
    console.error('Failed to load dispatch schedules:', e);
  }
};

window.loadDispatchAgents = async () => {
  try {
    const res = await fetch('/protoclaw/get_prebuilt_agents');
    const agents = await res.json();
    const list = Array.isArray(agents) ? agents : [];
    window._dispatchAgents = list.map(a => ({
      id: a.id,
      name: a.name || a.id,
      description: a.description || '',
      icon: a.icon || 'terminal',
      sessions: a.workspace_sessions?.sessions || [],
      activeSessionId: a.workspace_sessions?.activeSessionId || null,
    }));
    if (!window._dispatchSelectedAgent && window._dispatchAgents.length > 0) {
      window._dispatchSelectedAgent = window._dispatchAgents[0].id;
    }
  } catch (e) {
    console.error('Failed to load dispatch agents:', e);
    window._dispatchAgents = [];
  }
};

window.selectDispatchAgent = (agentId) => {
  window._dispatchSelectedAgent = agentId;
};

window.openDispatchModalFor = async (agentId) => {
  window._dispatchModalAgent = agentId;
  window._dispatchSelectedAgent = agentId;
  window._dispatchShowModal = true;
  window._dispatchTriggerType = 'timer';
  window._dispatchMode = 'continue';
  // Render modal immediately (shows loading state), then load data in background
  window._dispatchSessions = [];
  window._dispatchProjects = [];
  renderCurrentMainView();
  // Defer data loading so modal opens instantly
  const [sessRes, projRes] = await Promise.all([
    fetch('/protoclaw/prebuilt_sessions?agentId=' + encodeURIComponent(agentId)).then(r => r.json()).catch(() => ({ sessions: [] })),
    fetch('/protoclaw/dispatch/projects?agentId=' + encodeURIComponent(agentId)).then(r => r.json()).catch(() => ({ projects: [] })),
  ]);
  const sessions = Array.isArray(sessRes?.sessions) ? sessRes.sessions : [];
  window._dispatchSessions = sessions.map(s => {
    const openDir = s.openDirectory || '';
    const projectId = openDir ? 'dir:' + openDir.replace(/\\/g, '/').toLowerCase() : '';
    return {
      id: s.id,
      title: s.title || s.taskTitle || '',
      sessionType: s.sessionType || 'main',
      projectId,
    };
  });
  const projects = Array.isArray(projRes?.projects) ? projRes.projects : [];
  window._dispatchProjects = projects;
  // Only re-render if modal is still open
  if (window._dispatchShowModal) {
    renderCurrentMainView();
  }
};

window.openDispatchModal = async () => {
  const agentId = window._dispatchSelectedAgent;
  if (!agentId) return;
  window._dispatchModalAgent = agentId;
  window._dispatchShowModal = true;
  renderCurrentMainView();
};

window.closeDispatchModal = () => {
  window._dispatchShowModal = false;
  window._dispatchModalAgent = null;
  renderCurrentMainView();
};

window.loadDispatchSessionsForAgent = async (agentId) => {
  try {
    const res = await fetch('/protoclaw/prebuilt_sessions?agentId=' + encodeURIComponent(agentId));
    const data = await res.json();
    const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    window._dispatchSessions = sessions.map(s => {
      const openDir = s.openDirectory || '';
      const projectId = openDir ? 'dir:' + openDir.replace(/\\/g, '/').toLowerCase() : '';
      return {
        id: s.id,
        title: s.title || s.taskTitle || '',
        sessionType: s.sessionType || 'main',
        projectId,
      };
    });
  } catch (e) {
    console.error('Failed to load sessions:', e);
    window._dispatchSessions = [];
  }
};

window.loadDispatchProjectsForAgent = async (agentId) => {
  try {
    const res = await fetch('/protoclaw/dispatch/projects?agentId=' + encodeURIComponent(agentId));
    const data = await res.json();
    window._dispatchProjects = Array.isArray(data?.projects) ? data.projects : [];
  } catch (e) {
    console.error('Failed to load projects:', e);
    window._dispatchProjects = [];
  }
};

window.onDispatchProjectChange = () => {
  const el = document.getElementById('dispatch-project');
  if (el) window._dispatchContinueProject = el.value;
  renderCurrentMainView();
};

window.selectDispatchEndPreset = (el, seconds) => {
  const target = new Date(Date.now() + seconds * 1000);
  const hidden = document.getElementById('dispatch-loop-end-ts');
  if (hidden) hidden.value = target.getTime();
  document.querySelectorAll('.dispatch-end-preset').forEach(e => e.classList.remove('active'));
  el.classList.add('active');
  const yEl = document.getElementById('dispatch-end-year');
  const mEl = document.getElementById('dispatch-end-month');
  const dEl = document.getElementById('dispatch-end-day');
  const hEl = document.getElementById('dispatch-end-hour');
  const minEl = document.getElementById('dispatch-end-min');
  if (yEl) yEl.value = target.getFullYear();
  if (mEl) mEl.value = target.getMonth() + 1;
  if (dEl) dEl.value = target.getDate();
  if (hEl) hEl.value = target.getHours();
  if (minEl) minEl.value = target.getMinutes();
};

window.updateDispatchEndTime = () => {
  const yEl = document.getElementById('dispatch-end-year');
  const mEl = document.getElementById('dispatch-end-month');
  const dEl = document.getElementById('dispatch-end-day');
  const hEl = document.getElementById('dispatch-end-hour');
  const minEl = document.getElementById('dispatch-end-min');
  const year = Math.max(2024, parseInt(yEl?.value || '2026', 10) || 2026);
  const month = Math.max(1, Math.min(12, parseInt(mEl?.value || '1', 10) || 1));
  const day = Math.max(1, Math.min(31, parseInt(dEl?.value || '1', 10) || 1));
  const hour = Math.max(0, Math.min(23, parseInt(hEl?.value || '0', 10) || 0));
  const minute = Math.max(0, Math.min(59, parseInt(minEl?.value || '0', 10) || 0));
  const target = new Date(year, month - 1, day, hour, minute, 0, 0);
  const hidden = document.getElementById('dispatch-loop-end-ts');
  if (hidden) hidden.value = target.getTime();
  document.querySelectorAll('.dispatch-end-preset').forEach(e => e.classList.remove('active'));
};

window.selectDispatchTrigger = (type) => {
  window._dispatchTriggerType = type;
  renderCurrentMainView();
};

window.selectDispatchMode = (mode) => {
  window._dispatchMode = mode;
  const TRIGGER_AVAIL = {
    'continue':        ['timer', 'on-idle'],
    'new-main':        ['timer', 'on-ready'],
    'new-exploration': ['timer', 'on-ready'],
  };
  const available = TRIGGER_AVAIL[mode] || ['timer'];
  if (!available.includes(window._dispatchTriggerType)) {
    window._dispatchTriggerType = available[0];
  }
  renderCurrentMainView();
};

window.loadDispatchPHSessions = async () => {
  const agentId = window._dispatchSelectedAgent || 'programming-helper';
  return window.loadDispatchSessionsForAgent(agentId);
};

window.loadDispatchPHProjects = async () => {
  const agentId = window._dispatchSelectedAgent || 'programming-helper';
  return window.loadDispatchProjectsForAgent(agentId);
};

window.createDispatchSchedule = async () => {
  const messageEl = document.getElementById('dispatch-message');
  const sessionEl = document.getElementById('dispatch-session');
  const projectEl = document.getElementById('dispatch-project');
  const secondsEl = document.getElementById('dispatch-seconds');
  const idleEl = document.getElementById('dispatch-idle-threshold');
  const loopEnableEl = document.getElementById('dispatch-loop-enable');
  const repeatEl = document.getElementById('dispatch-repeat');
  const loopMaxEl = document.getElementById('dispatch-loop-max');
  const loopEndTsEl = document.getElementById('dispatch-loop-end-ts');
  const loopActiveOnlyEl = document.getElementById('dispatch-loop-active-only');

  if (!messageEl) { console.warn('[Dispatch] messageEl not found'); return; }
  const message = messageEl.value.trim();
  if (!message) {
    alert(currentLanguage === 'zh' ? '请输入要发送的消息' : 'Please enter a message');
    return;
  }

  const agentId = window._dispatchSelectedAgent || 'programming-helper';
  const triggerType = window._dispatchTriggerType || 'timer';
  const mode = window._dispatchMode || 'continue';

  const body = {
    targetAgentId: agentId,
    message,
  };

  // ── Trigger config ──
  if (triggerType === 'timer') {
    const seconds = secondsEl ? Number(secondsEl.value) : 30;
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    body.secondsFromNow = seconds;
    body.trigger = { type: 'timer' };
  } else if (triggerType === 'on-idle') {
    const threshold = idleEl ? Number(idleEl.value) : 300;
    body.trigger = { type: 'on-idle', idleThreshold: threshold > 0 ? threshold : 300 };
  } else if (triggerType === 'on-ready') {
    body.trigger = { type: 'on-ready' };
  }

  // ── Loop config (timer + on-idle) ──
  const loopEnabled = loopEnableEl ? loopEnableEl.checked : false;
  if (loopEnabled && (triggerType === 'timer' || triggerType === 'on-idle')) {
    // For timer: repeatInterval is the loop interval; for on-idle: need to read the interval field
    let repeatVal = 0;
    if (triggerType === 'timer') {
      // timer loop interval defaults to the same as delay
      repeatVal = secondsEl ? Number(secondsEl.value) : 30;
    } else {
      // on-idle loop interval
      repeatVal = repeatEl ? Number(repeatEl.value) : 300;
    }
    if (Number.isFinite(repeatVal) && repeatVal > 0) {
      body.repeatInterval = repeatVal;
    }
    // Max count
    const maxCount = loopMaxEl ? Number(loopMaxEl.value) : 0;
    if (Number.isFinite(maxCount) && maxCount > 0) {
      body.loopMaxCount = maxCount;
    }
    // End time (absolute timestamp)
    const endTs = loopEndTsEl ? Number(loopEndTsEl.value) : 0;
    if (Number.isFinite(endTs) && endTs > Date.now()) {
      body.loopEndTime = endTs;
    }
    // Only active sessions
    const activeOnly = loopActiveOnlyEl ? loopActiveOnlyEl.checked : false;
    if (activeOnly) {
      body.onlyActiveSessions = true;
    }
  }

  // ── Mode-specific target config ──
  if (mode === 'continue') {
    const sessionVal = sessionEl ? sessionEl.value : '';
    if (sessionVal === '__latest__') {
      body.targetSessionId = '__latest__';
      // Also pass project context so server can resolve latest within project
      const projectVal = projectEl ? projectEl.value : '';
      if (projectVal) body.projectId = projectVal;
    } else if (sessionVal) {
      body.targetSessionId = sessionVal;
    }
  } else if (mode === 'new-exploration') {
    body.newSessionType = 'exploration';
    body.targetSessionId = null;
    const projectVal = projectEl ? projectEl.value : '';
    if (projectVal) body.projectId = projectVal;
  } else if (mode === 'new-main') {
    body.newSessionType = null;
    body.targetSessionId = null;
    const projectVal = projectEl ? projectEl.value : '';
    if (projectVal) body.projectId = projectVal;
  }

  console.log('[Dispatch] creating schedule:', JSON.stringify(body, null, 2));
  try {
    const res = await fetch('/protoclaw/dispatch/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('Failed to create schedule:', err, 'body was:', body);
      alert('创建失败: ' + (err.error || res.status));
      return;
    }
    await window.loadDispatchSchedules();
    messageEl.value = '';
    window._dispatchShowModal = false;
    window._dispatchModalAgent = null;
    renderCurrentMainView();
  } catch (e) {
    console.error('Failed to create dispatch schedule:', e, 'body was:', body);
    alert('创建失败: ' + e.message);
  }
};

window.cancelDispatchSchedule = async (scheduleId) => {
  try {
    await fetch('/protoclaw/dispatch/schedules/' + encodeURIComponent(scheduleId), { method: 'DELETE' });
    if (window._dispatchDetailId === scheduleId) window._dispatchDetailId = null;
    await window.loadDispatchSchedules();
    renderCurrentMainView();
  } catch (e) {
    console.error('Failed to cancel schedule:', e);
  }
};

window.showDispatchDetail = (scheduleId) => {
  window._dispatchDetailId = scheduleId;
  renderCurrentMainView();
};

window.closeDispatchDetail = () => {
  window._dispatchDetailId = null;
  renderCurrentMainView();
};
// ── End Dispatch Console ──────────────────────────────────────────

window.toggleIMDropdown = (trigger) => {
  const dropdown = trigger.closest('.im-dropdown');
  if (!dropdown) return;
  const isOpen = dropdown.classList.contains('open');
  document.querySelectorAll('.im-dropdown.open').forEach((d) => d.classList.remove('open'));
  if (!isOpen) dropdown.classList.add('open');
};

window.imSelectChannel = (item, value) => {
  const dropdown = item.closest('.im-dropdown');
  if (!dropdown) return;
  dropdown.classList.remove('open');
  window.updateIMWorkspaceField('workspaceConfig.selectedChannel', value);
};

window.imSelectLine = (item, type, lineId) => {
  const dropdown = item.closest('.im-dropdown');
  if (!dropdown) return;
  dropdown.classList.remove('open');
  const value = item.dataset.value;
  if (type === 'carrier') {
    window.handleLineCarrierChange(lineId, value);
  } else if (type === 'session') {
    window.handleLineSessionChange(lineId, value);
  }
};

document.addEventListener('click', (e) => {
  if (!e.target.closest('.im-dropdown')) {
    document.querySelectorAll('.im-dropdown.open').forEach((d) => d.classList.remove('open'));
  }
});

window.reloadQQBotConfig = async () => {
  try {
    await ensureQQBotConfigLoaded(true);
  } catch (error) {
    console.error('Failed to reload qqbot config:', error);
  }
};

window.saveQQBotConfig = async () => {
  qqbotConfigState.saving = true;
  qqbotConfigState.error = '';
  renderCurrentMainView();
  try {
    const response = await fetch('/protoclaw/qqbot_config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(getQQBotConfigDraft()),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'Failed to save qqbot config'));
    }
    const payload = await response.json();
    const config = normalizeQQBotConfigData(payload?.config || {});
    qqbotConfigState.data = config;
    qqbotConfigState.draft = { ...config };
    qqbotConfigState.sourcePath = payload?.sourcePath || qqbotConfigState.sourcePath;
    qqbotConfigState.savedAt = payload?.savedAt || new Date().toISOString();
  } catch (error) {
    qqbotConfigState.error = error && error.message ? error.message : String(error);
    console.error('Failed to save qqbot config:', error);
  } finally {
    qqbotConfigState.saving = false;
    renderCurrentMainView();
  }
};

window.switchAgent = async (newAgentId) => {
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
  try {
    const res = await fetch('/api/agents/current', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: runtimeAgentId })
    });
    if (!res.ok && res.status !== 404) {
      const errorText = await res.text().catch(() => '');
      throw new Error(`Switch failed: ${res.status} ${res.statusText} ${errorText}`);
    }

    currentAgentId = targetAgent?.parent_id || targetAgent?.id || runtimeAgentId;
    currentRuntimeAgentId = runtimeAgentId;
    readOnlyMode = false;
    currentWorkspaceArtifactDetail = null;
    currentWorkspaceDocsetDetail = null;
    currentProjectDocsetOpen = false;
    currentProjectRequirementEdit = null;
    currentProjectDocsetPage = 'requirement';
    currentWorkspaceTab = 'chat';
    beginFollowLatestCooldown();
    setFollowLatest(true);
    renderAgentList();
    await loadAgentData(runtimeAgentId);
    loadAgents().catch((error) => console.error('Failed to refresh agents after switch:', error));
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

restartAgentAction.addEventListener('click', async () => {
  if (!contextMenuAgentId || (contextMenuAgentMode !== 'prebuilt-runtime' && contextMenuAgentMode !== 'external-runtime' && contextMenuAgentMode !== 'child-runtime')) return;
  const confirmed = window.confirm(t('restart_prebuilt_confirm'));
  if (!confirmed) {
    closeAgentContextMenu();
    return;
  }

  try {
    const agent = getExternalRuntimeAgent(contextMenuAgentId);
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
      await window.switchAgent(nextRuntimeId);
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
      await window.switchAgent(nextRuntimeId);
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
          await window.switchAgent(nextRuntimeId);
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
          await window.switchAgent(nextRuntimeId);
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
});

window.addEventListener('resize', () => {
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
container.addEventListener('wheel', markManualScrollIntent, { passive: true });
container.addEventListener('touchstart', markManualScrollIntent, { passive: true });
container.addEventListener('contextmenu', (event) => {
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
container.addEventListener('keydown', (event) => {
  if (['ArrowUp', 'PageUp', 'Home', ' '].includes(event.key)) {
    markManualScrollIntent();
  }
});
container.addEventListener('scroll', () => {
  if (suppressFollowScrollEvent || !followLatestEnabled) {
    return;
  }
  if (!isNearBottom() && hasRecentManualScrollIntent()) {
    setFollowLatest(false);
  }
});
followLatestButton.addEventListener('click', () => {
  setFollowLatest(true, { scroll: true, behavior: 'smooth' });
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
    resetRuntimeBackedSurfaceState();
    renderCurrentMainView();
    renderFeaturePanel();
    return;
  }
  try {
    currentRuntimeAgentId = agentId;
    const [msgsRes, toolsRes, hooksRes, overviewRes, inputRes] = await Promise.all([
      fetch(`/api/agents/${agentId}/messages`),
      fetch(`/api/agents/${agentId}/tools`),
      fetch(`/api/agents/${agentId}/hooks`),
      fetch(`/api/agents/${agentId}/overview`),
      fetch(`/api/agents/${agentId}/input-requests`)
    ]);

    const msgsData = await msgsRes.json();
    const tools = await toolsRes.json();
    setCurrentHookInspector(await hooksRes.json());
    setCurrentOverviewSnapshot(await overviewRes.json());
    const inputRequests = await inputRes.json();

    currentMessages = msgsData.messages || [];
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
    if (activeFeaturePanel === 'logs') {
      await loadLogs(true);
    }
    renderFeaturePanel();

    warmTemplatesInBackground(collectTemplateNames(tools), agentId);
  } catch (e) {
    console.error('Failed to load agent data:', e);
  }
}

async function poll() {
  try {
    if (prebuiltSessionSwitchInFlight) {
      setTimeout(poll, 300);
      return;
    }

    // 定期检查并重新加载 Feature 模板映射（如果为空）
    if (Object.keys(FEATURE_TEMPLATE_MAP).length === 0 && Date.now() - lastFeatureTemplateReloadAt > 3000) {
      lastFeatureTemplateReloadAt = Date.now();
      await reloadFeatureTemplateMap();
    }

    if (!currentRuntimeAgentId) {
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
                lastRenderedWorkspaceHtml = '';
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
      if (activeFeaturePanel === 'logs' && logPanelScope === 'all') {
        await loadLogs();
      }
      setTimeout(poll, 1000);
      return;
    }

    // 并行请求消息、通知和输入请求
    const [msgsRes, notifRes, connectionRes, inputRes, overviewRes] = await Promise.all([
      fetch(`/api/agents/${currentRuntimeAgentId}/messages`),
      fetch(`/api/agents/${currentRuntimeAgentId}/notification`),
      fetch(`/api/agents/${currentRuntimeAgentId}/connection`),
      fetch(`/api/agents/${currentRuntimeAgentId}/input-requests`),
      fetch(`/api/agents/${currentRuntimeAgentId}/overview`),
    ]);

    const coreResponses = [msgsRes, notifRes, connectionRes, inputRes, overviewRes];
    if (coreResponses.some(res => res.status === 404)) {
      if (prebuiltSessionSwitchInFlight || suppressSidebarRerender) {
        setTimeout(poll, 300);
        return;
      }
      const failedRuntimeId = currentRuntimeAgentId;
      const failedRuntimeRecord = getRuntimeRecord(failedRuntimeId);
      if (failedRuntimeId) {
        _agentCallActive.delete(failedRuntimeId);
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
        renderCurrentMainView();
        renderInputRequests([]);
      }
      await loadAgents();
      setTimeout(poll, 1000);
      return;
    }

    const connectionData = await connectionRes.json();
    setConnectionStatus(!!connectionData.connected);

    const data = await msgsRes.json();
    const messages = data.messages || [];

    // 处理通知状态
    const notifData = await notifRes.json();
    updateNotificationStatus(notifData);
    await refreshAgentCallStates(allAgents);
    _syncPersistentInputUi(currentRuntimeAgentId);

    const nextOverview = normalizeOverviewSnapshot(await overviewRes.json());
    const nextOverviewSignature = getOverviewSignature(nextOverview);
    if (nextOverviewSignature !== currentOverviewSignature) {
      currentOverviewSnapshot = nextOverview;
      currentOverviewSignature = nextOverviewSignature;
      if (activeFeaturePanel === 'workspace') {
        renderFeaturePanel();
      }
    }

    // 处理输入请求（只在变化时重新渲染）
    const inputRequestsRaw = await inputRes.json();
    const inputRequests = Array.isArray(inputRequestsRaw) ? inputRequestsRaw : [];
    if (JSON.stringify(inputRequests) !== JSON.stringify(window.lastInputRequests || [])) {
      window.lastInputRequests = inputRequests;
      renderInputRequests(inputRequests);
      updateRollbackActionVisibility();
    } else if (isChatSurfaceActive()) {
      _syncPersistentInputUi(currentRuntimeAgentId);
    }

    if (messages.length !== currentMessages.length) {
      if (messages.length > currentMessages.length) {
        // 有新消息：只追加新的
        const newMessages = messages.slice(currentMessages.length);
        currentMessages = messages;
        if (shouldRenderWorkspaceSurface()) {
          renderCurrentMainView();
        } else {
          appendNewMessages(newMessages, currentMessages.length - newMessages.length);
        }
      } else if (messages.length < currentMessages.length) {
        // 消息减少：完全重建（极少情况）
        currentMessages = messages;
        renderCurrentMainView();
      }
    } else {
      const lastMsgChanged = messages.length > 0 &&
        JSON.stringify(messages[messages.length - 1]) !== JSON.stringify(currentMessages[currentMessages.length - 1]);
      if (lastMsgChanged) {
        // 最后一条消息变化：替换最后一条（避免滚动重置）
        currentMessages = messages;
        if (shouldRenderWorkspaceSurface()) {
          renderCurrentMainView();
        } else {
          updateLastMessage(messages[messages.length - 1]);
        }
      }
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
              lastRenderedWorkspaceHtml = '';
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
      } else {
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

  } catch (e) {
    console.warn('Polling failed, keeping last known connection state:', e);
    setTimeout(poll, 1000);
    return;
  }
  setTimeout(poll, 300);
}

// 通知状态更新
function updateNotificationStatus(notifData) {
  const statusEl = document.getElementById('notification-status');
  const phaseEl = document.getElementById('notification-phase');
  const charCountEl = document.getElementById('notification-char-count');
  let callingStateChanged = false;
  // `callActive` is tracked independently from the transient `state` payload.
  // Some notification responses may only carry the call flag, so update it
  // before any early return based on `state`.
  if (notifData.callActive !== undefined) {
    const runtimeId = currentRuntimeAgentId;
    if (runtimeId) {
      const prev = _agentCallActive.get(runtimeId);
      const nextCalling = resolveNotificationCallingState(notifData);
      if (nextCalling) {
        _agentCallActive.set(runtimeId, true);
      } else {
        _agentCallActive.delete(runtimeId);
      }
      callingStateChanged = (prev === true) !== nextCalling;
      if (callingStateChanged) {
        renderAgentList();
      }
    }
  }

  const stateType = String(notifData?.state?.type || '').trim();
  if (currentRuntimeAgentId && notifData.callActive === undefined) {
    if (stateType === 'call.start') {
      if (!isRuntimeCalling(currentRuntimeAgentId)) {
        _agentCallActive.set(currentRuntimeAgentId, true);
        callingStateChanged = true;
        renderAgentList();
      }
    } else if (stateType === 'call.finish') {
      if (isRuntimeCalling(currentRuntimeAgentId)) {
        _agentCallActive.delete(currentRuntimeAgentId);
        callingStateChanged = true;
        renderAgentList();
      }
    }
  }

  if (!notifData.state) {
    statusEl.style.display = 'none';
    _syncPersistentActionButton();
    return;
  }

  const { type, data } = notifData.state;

  if (type === 'call.start') {
    statusEl.style.display = 'none';
    _syncPersistentActionButton();
    return;
  }

  if (type === 'call.finish') {
    statusEl.style.display = 'none';
    statusEl.classList.remove('active');
    if (currentRuntimeAgentId) {
      _agentCallActive.delete(currentRuntimeAgentId);
      renderAgentList();
    }
    _syncPersistentActionButton();
    _syncPersistentInputUi();
    return;
  }

  if (type === 'llm.char_count') {
    statusEl.style.display = 'flex';
    statusEl.classList.add('active');

    const phaseNames = {
      'thinking': t('phase_thinking'),
      'content': t('phase_content'),
      'tool_calling': t('phase_tool_calling')
    };
    phaseEl.textContent = phaseNames[data.phase] || data.phase;
    charCountEl.textContent = data.charCount.toLocaleString();

    // 新语义下改为根据 runtime 调用状态同步按钮
    _syncPersistentActionButton();
    // 新 step 开始，agent 已在上一步结束时 dequeue 了消息，同步气泡
    _syncQueueFromBackend();
  } else if (type === 'llm.complete') {
    statusEl.style.display = 'none';
    statusEl.classList.remove('active');
    _syncPersistentActionButton();
    // 不在这里清空 _queuedTexts — 后端队列可能仍有消息待消费
    // 队列显示由 _syncQueueFromBackend() 在每轮 step_start 时统一管理
    _pendingQueuedCount = 0;
    _syncPersistentInputUi();
  } else {
    statusEl.style.display = 'none';
  }

  if (callingStateChanged && getInputSurfaceMode(currentInputRequests || []) !== lastRenderedInputMode) {
    lastRenderedInputSignature = '';
    renderInputRequests(currentInputRequests || []);
  }
}

// 渲染输入请求
function getInputRenderSignature(requests, renderMode) {
  const runtimeId = currentRuntimeAgentId || 'none';
  if (renderMode === 'persistent') {
    return `persistent|${runtimeId}|${readOnlyMode ? 'ro' : 'rw'}`;
  }
  if (renderMode === 'requests') {
    return `requests|${runtimeId}|${JSON.stringify(requests || [])}`;
  }
  return `${renderMode}|${runtimeId}`;
}

function renderInputRequests(requests) {
  const container = document.getElementById('user-input-container');
  if (!container) return;
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

  // 清空现有内容
  container.innerHTML = '';
  container.classList.toggle('choice-input-active', hasChoiceRequest);
  container.classList.remove('choice-collapsed');
  container.onclick = hasChoiceRequest
    ? function(event) {
        if (event.target === container) {
          collapsePrimaryChoiceRequest();
        }
      }
    : null;

  if (!chatActive || renderMode === 'hidden') {
    container.classList.remove('choice-input-active', 'choice-collapsed');
    return;
  }

  if (renderMode === 'readonly') {
    container.classList.remove('choice-input-active', 'choice-collapsed');
    const card = document.createElement('div');
    card.className = 'user-input-card';
    card.innerHTML = `
      <textarea class="user-input-textarea" rows="1" disabled
        placeholder="${escapeHtml(t('workspace_readonly_mode'))}"
        style="opacity:0.5;cursor:not-allowed;"></textarea>
    `;
    container.appendChild(card);
    return;
  }

  // 常驻输入框的显示条件一直是“当前正在查看某个 runtime 聊天面板”，
  // 而不是“runtime 此刻一定处于执行中”。
  const hasRequests = Array.isArray(requests) && requests.length > 0;
  const hasRuntimeSelected = !!currentRuntimeAgentId && chatActive;

  // 如果有 pending requests，正常渲染
  // 如果没有 pending requests 但当前有 runtime 聊天上下文，渲染常驻输入框（队列模式）
  if (renderMode === 'requests' && hasRequests) {
    for (const req of requests) {
      if (isChoiceInputRequest(req)) {
        renderChoiceInputRequest(container, req);
        continue;
      }

      const card = document.createElement('div');
      card.className = 'user-input-card';
      const visibleActions = Array.isArray(req.actions)
        ? req.actions.filter(action => action && action.id !== 'rollback_to_call')
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
            oninput="autoResize(this)"
            placeholder="${escapeHtml(req.placeholder || t('input_placeholder'))}"></textarea>
          <button class="persistent-action-btn" onclick="submitInput('${req.requestId}')" title="Send">
            <svg class="icon-send" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
          </button>
        </div>
        ${actionsHtml ? `<div class="user-input-footer">${actionsHtml}</div>` : ''}
      `;
      container.appendChild(card);
      
      // Auto-focus
      setTimeout(() => {
        const el = document.getElementById(`input-${req.requestId}`);
        if(el) {
           if (typeof req.initialValue === 'string' && req.initialValue.length > 0) {
             el.value = req.initialValue;
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
    renderPersistentInput(container);
  }
}

// 渲染常驻输入框（agent 运行期间始终可见）
let _pendingQueuedCount = 0;
let _queuedTexts = []; // 仅用于气泡展示
let _persistentUiSyncInFlight = false;
let _localQueuedInputPending = false;
let _lastQueueBubbleSignature = '';

function renderPersistentInput(container) {
  // 先渲染队列气泡
  _renderQueueBubbles(container);

  const card = document.createElement('div');
  card.className = 'user-input-card persistent-input';
  card.innerHTML = `
    <div class="persistent-input-row">
      <textarea class="user-input-textarea" rows="1" id="input-persistent"
        onkeydown="handlePersistentInputKey(event)"
        oninput="autoResize(this)"
        placeholder="${escapeHtml(t('input_placeholder'))}"></textarea>
      <button class="persistent-action-btn" id="persistent-action-btn" onclick="onPersistentBtnClick()">
        <svg class="icon-send" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
        <svg class="icon-stop" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="display:none"><rect x="4" y="4" width="16" height="16" rx="3"></rect></svg>
      </button>
    </div>
  `;
  container.appendChild(card);
  _syncPersistentInputUi();
}

function onPersistentBtnClick() {
  const btn = document.getElementById('persistent-action-btn');
  if (!btn) return;
  if (btn.classList.contains('is-stop')) {
    interruptAgent();
  } else {
    submitQueuedInput();
  }
}

function _setActionBtnStop() {
  const btn = document.getElementById('persistent-action-btn');
  if (!btn) return;
  btn.classList.add('is-stop');
  const iconSend = btn.querySelector('.icon-send');
  const iconStop = btn.querySelector('.icon-stop');
  if (iconSend) iconSend.style.display = 'none';
  if (iconStop) iconStop.style.display = '';
}

function _setActionBtnSend() {
  const btn = document.getElementById('persistent-action-btn');
  if (!btn) return;
  btn.classList.remove('is-stop');
  const iconSend = btn.querySelector('.icon-send');
  const iconStop = btn.querySelector('.icon-stop');
  if (iconSend) iconSend.style.display = '';
  if (iconStop) iconStop.style.display = 'none';
}

function _syncPersistentActionButton() {
  if (currentRuntimeAgentId && isRuntimeCalling(currentRuntimeAgentId)) {
    _setActionBtnStop();
  } else {
    _setActionBtnSend();
  }
}

function _renderQueueBubbles(container) {
  const signature = JSON.stringify(_queuedTexts);
  const existingStack = container.querySelector('.queue-bubbles-stack');
  if (signature === _lastQueueBubbleSignature && (
    (_queuedTexts.length === 0 && !existingStack)
    || (_queuedTexts.length > 0 && existingStack)
  )) {
    return;
  }
  _lastQueueBubbleSignature = signature;

  container.querySelectorAll('.queue-bubbles-stack').forEach(el => el.remove());
  if (_queuedTexts.length === 0) return;

  const stack = document.createElement('div');
  stack.className = 'queue-bubbles-stack';
  for (const txt of _queuedTexts) {
    const b = document.createElement('div');
    b.className = 'queue-bubble';
    b.textContent = txt.length > 80 ? txt.substring(0, 80) + '...' : txt;
    b.title = txt;
    stack.appendChild(b);
  }

  const card = container.querySelector('.user-input-card');
  if (card) container.insertBefore(stack, card);
  else container.appendChild(stack);
}

// 查询后端真实队列余量，移除已被消费的气泡
async function _syncQueueFromBackend() {
  await _syncPersistentInputUi();
}

function handlePersistentInputKey(event) {
  if (event.key === 'Enter') {
    if (event.ctrlKey || event.shiftKey) {
      return;
    }
    event.preventDefault();
    submitQueuedInput();
  }
}

async function submitQueuedInput() {
  const textarea = document.getElementById('input-persistent');
  if (!textarea) return;
  const text = textarea.value.trim();
  if (!text) return;

  try {
    const res = await fetch(`/api/agents/${currentRuntimeAgentId}/queue-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (res.ok) {
      textarea.value = '';
      autoResize(textarea);
      _localQueuedInputPending = true;
      _pendingQueuedCount++;
      _queuedTexts.push(text);
      updateQueueIndicator();
      const nextMode = getInputSurfaceMode(currentInputRequests || []);
      if (nextMode !== lastRenderedInputMode) {
        lastRenderedInputSignature = '';
        renderInputRequests(currentInputRequests || []);
      }
    }
  } catch (e) {
    console.error('排队输入提交失败:', e);
  }
}

function updateQueueIndicator() {
  const container = document.getElementById('user-input-container');
  if (container) _renderQueueBubbles(container);
}

async function _syncPersistentInputUi(runtimeId = currentRuntimeAgentId) {
  if (_persistentUiSyncInFlight) return;
  _persistentUiSyncInFlight = true;
  const prevMode = getInputSurfaceMode(currentInputRequests || []);
  const prevQueueSignature = JSON.stringify(_queuedTexts);
  try {
    if (!runtimeId) {
      _queuedTexts = [];
      _pendingQueuedCount = 0;
      updateQueueIndicator();
      _syncPersistentActionButton();
      return;
    }

    const expectedRuntimeId = runtimeId;
    _syncPersistentActionButton();

    const res = await fetch(`/api/agents/${expectedRuntimeId}/queued-inputs`);
    if (!res.ok || expectedRuntimeId !== currentRuntimeAgentId) return;
    const data = await res.json();
    const queue = Array.isArray(data) ? data : (Array.isArray(data.inputs) ? data.inputs : []);
    const viewerQueueTexts = queue
      .map((item) => typeof item?.text === 'string' ? item.text.trim() : '')
      .filter(Boolean);

    _queuedTexts = viewerQueueTexts.slice();
    _pendingQueuedCount = _queuedTexts.length;
    if (_queuedTexts.length === 0 && !isRuntimeCalling(expectedRuntimeId)) {
      _localQueuedInputPending = false;
    }
    if (JSON.stringify(_queuedTexts) !== prevQueueSignature) {
      updateQueueIndicator();
    }
  } catch (e) {
    // ignore transient queue sync failures
  } finally {
    _persistentUiSyncInFlight = false;
  }
  const nextMode = getInputSurfaceMode(currentInputRequests || []);
  if (nextMode !== prevMode) {
    lastRenderedInputSignature = '';
    renderInputRequests(currentInputRequests || []);
  }
}

async function interruptAgent() {
  if (!currentRuntimeAgentId) { console.log('[Interrupt] no currentRuntimeAgentId, skip'); return; }
  console.log(`[Interrupt] sending POST /api/agents/${currentRuntimeAgentId}/interrupt`);
  try {
    const res = await fetch(`/api/agents/${currentRuntimeAgentId}/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    console.log(`[Interrupt] response:`, res.status, data);
    _localQueuedInputPending = false;
    _pendingQueuedCount = 0;
    _queuedTexts = [];
    _lastQueueBubbleSignature = '';
    updateQueueIndicator();
    lastRenderedInputSignature = '';
    renderInputRequests(currentInputRequests || []);
  } catch (e) {
    console.error('[Interrupt] request failed:', e);
  }
}

function isChoiceInputRequest(req) {
  return !!req && req.mode === 'choices' && Array.isArray(req.questions) && req.questions.length > 0;
}

function getChoiceRequestById(requestId) {
  return (currentInputRequests || []).find(req => req.requestId === requestId) || null;
}

function getChoiceState(requestId) {
  if (!choiceInputState[requestId]) {
    choiceInputState[requestId] = {
      questionIndex: 0,
      answers: [],
      selectedIndex: 0,
      selectedIndexByQuestion: {},
      customTextByQuestion: {},
      collapsed: false,
    };
  }
  return choiceInputState[requestId];
}

function getChoiceOptionCount(question) {
  const optionCount = Array.isArray(question?.options) ? Math.min(question.options.length, 4) : 0;
  return optionCount + (question?.allowCustom ? 1 : 0);
}

function buildChoiceAnswer(req, state, questionIndex) {
  const question = req?.questions?.[questionIndex] || {};
  const options = Array.isArray(question.options) ? question.options.slice(0, 4) : [];
  const selectedIndex = state.selectedIndexByQuestion?.[question.id] ?? (questionIndex === state.questionIndex ? state.selectedIndex : 0);
  const isCustom = question.allowCustom && selectedIndex >= options.length;
  return isCustom
    ? {
        questionId: question.id,
        customText: (state.customTextByQuestion[question.id] || '').trim(),
      }
    : {
        questionId: question.id,
        optionId: options[selectedIndex]?.id,
      };
}

function rememberCurrentChoice(req, state) {
  const question = req?.questions?.[state.questionIndex] || {};
  if (!question.id) return;
  state.selectedIndexByQuestion[question.id] = state.selectedIndex || 0;
  state.answers[state.questionIndex] = buildChoiceAnswer(req, state, state.questionIndex);
}

function renderChoiceInputRequest(container, req) {
  const state = getChoiceState(req.requestId);
  const questions = Array.isArray(req.questions) ? req.questions : [];
  if (state.collapsed) {
    container.classList.add('choice-collapsed');
    const mini = document.createElement('button');
    mini.className = 'user-choice-mini';
    mini.type = 'button';
    mini.setAttribute('onclick', `expandChoiceRequest('${req.requestId}')`);
    mini.innerHTML = `
      <span class="user-choice-mini-title">${escapeHtml(req.prompt || '等待你的选择')}</span>
      <span class="user-choice-mini-meta">${Math.min((state.questionIndex || 0) + 1, questions.length)} / ${questions.length}</span>
    `;
    container.appendChild(mini);
    return;
  }

  container.classList.remove('choice-collapsed');
  const questionIndex = Math.max(0, Math.min(state.questionIndex || 0, questions.length - 1));
  state.questionIndex = questionIndex;
  const question = questions[questionIndex] || {};
  const options = Array.isArray(question.options) ? question.options.slice(0, 4) : [];
  const hasCustom = !!question.allowCustom;
  const optionCount = options.length + (hasCustom ? 1 : 0);
  state.selectedIndex = Math.max(0, Math.min(state.selectedIndexByQuestion?.[question.id] ?? state.selectedIndex ?? 0, Math.max(0, optionCount - 1)));

  const card = document.createElement('div');
  card.className = 'user-input-card user-choice-card';
  card.tabIndex = 0;
  card.dataset.requestId = req.requestId;
  card.setAttribute('onkeydown', `handleChoiceKey(event, '${req.requestId}')`);

  const optionHtml = options.map((option, index) => `
    <button class="user-choice-option ${index === state.selectedIndex ? 'active' : ''}" type="button" onclick="selectChoiceOption('${req.requestId}', ${index})">
      <span class="user-choice-key">${index + 1}</span>
      <span>
        <span class="user-choice-label">${escapeHtml(option.label || option.id || ('选项 ' + (index + 1)))}</span>
        ${option.description ? `<span class="user-choice-description">${escapeHtml(option.description)}</span>` : ''}
      </span>
    </button>
  `).join('');

  const customIndex = options.length;
  const customActive = hasCustom && state.selectedIndex === customIndex;
  const customText = state.customTextByQuestion[question.id] || '';
  const customHtml = hasCustom ? `
    <button class="user-choice-option ${customActive ? 'active' : ''}" type="button" onclick="selectChoiceOption('${req.requestId}', ${customIndex})">
      <span class="user-choice-key">${customIndex + 1}</span>
      <span>
        <span class="user-choice-label">${escapeHtml(question.customLabel || '其他，我想补充')}</span>
        <span class="user-choice-description">选择后可以直接输入想说的话</span>
      </span>
    </button>
    <div class="user-choice-custom ${customActive ? 'active' : ''}">
      <textarea id="choice-custom-${req.requestId}" rows="2"
        oninput="updateChoiceCustomText('${req.requestId}', this.value); autoResize(this)"
        onkeydown="handleChoiceCustomKey(event, '${req.requestId}')"
        placeholder="${escapeHtml(question.customPlaceholder || '输入你的补充内容')}">${escapeHtml(customText)}</textarea>
    </div>
  ` : '';

  card.innerHTML = `
    <div class="user-choice-topline">
      <div class="user-choice-title">${escapeHtml(req.prompt || '需要你做个选择')}</div>
      <div class="user-choice-progress">${questionIndex + 1} / ${questions.length}</div>
      <button class="user-choice-close" type="button" title="临时收起" onclick="collapseChoiceRequest('${req.requestId}')">×</button>
    </div>
    <div class="user-choice-question">${escapeHtml(question.question || '')}</div>
    <div class="user-choice-options">
      ${optionHtml}
      ${customHtml}
    </div>
    <div class="user-choice-footer">
      <span>↑↓ 选项，←→ 题目，Enter 确认</span>
      <button class="user-choice-submit" type="button" onclick="confirmChoiceQuestion('${req.requestId}')">${questionIndex + 1 === questions.length ? '提交' : '下一题'}</button>
    </div>
  `;

  container.appendChild(card);
  setTimeout(() => {
    const customInput = customActive ? document.getElementById(`choice-custom-${req.requestId}`) : null;
    const target = customInput || card;
    target.focus();
    if (customInput) {
      const end = customInput.value.length;
      customInput.setSelectionRange(end, end);
      autoResize(customInput);
    }
  }, 30);
}

function rerenderChoiceRequest(requestId) {
  lastRenderedInputSignature = '';
  const container = document.getElementById('user-input-container');
  if (!container) return;
  renderInputRequests(currentInputRequests || []);
}

window.selectChoiceOption = function(requestId, optionIndex) {
  const req = getChoiceRequestById(requestId);
  const state = getChoiceState(requestId);
  state.selectedIndex = optionIndex;
  const question = req?.questions?.[state.questionIndex];
  if (question?.id) {
    state.selectedIndexByQuestion[question.id] = optionIndex;
  }
  rerenderChoiceRequest(requestId);
};

window.collapseChoiceRequest = function(requestId) {
  const state = getChoiceState(requestId);
  const req = getChoiceRequestById(requestId);
  rememberCurrentChoice(req, state);
  state.collapsed = true;
  rerenderChoiceRequest(requestId);
};

window.expandChoiceRequest = function(requestId) {
  const state = getChoiceState(requestId);
  state.collapsed = false;
  rerenderChoiceRequest(requestId);
};

function collapsePrimaryChoiceRequest() {
  const request = (currentInputRequests || []).find(isChoiceInputRequest);
  if (request) {
    window.collapseChoiceRequest(request.requestId);
  }
}

window.updateChoiceCustomText = function(requestId, value) {
  const req = getChoiceRequestById(requestId);
  const state = getChoiceState(requestId);
  const question = req?.questions?.[state.questionIndex];
  if (question?.id) {
    state.customTextByQuestion[question.id] = value;
  }
};

window.handleChoiceKey = function(event, requestId) {
  const req = getChoiceRequestById(requestId);
  if (!req) return;
  const state = getChoiceState(requestId);
  const question = req.questions[state.questionIndex] || {};
  const optionCount = getChoiceOptionCount(question);
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    state.selectedIndex = Math.min(optionCount - 1, (state.selectedIndex || 0) + 1);
    if (question.id) state.selectedIndexByQuestion[question.id] = state.selectedIndex;
    rerenderChoiceRequest(requestId);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    state.selectedIndex = Math.max(0, (state.selectedIndex || 0) - 1);
    if (question.id) state.selectedIndexByQuestion[question.id] = state.selectedIndex;
    rerenderChoiceRequest(requestId);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    rememberCurrentChoice(req, state);
    state.questionIndex = Math.min(req.questions.length - 1, state.questionIndex + 1);
    state.selectedIndex = state.selectedIndexByQuestion[req.questions[state.questionIndex]?.id] ?? 0;
    rerenderChoiceRequest(requestId);
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    rememberCurrentChoice(req, state);
    state.questionIndex = Math.max(0, state.questionIndex - 1);
    state.selectedIndex = state.selectedIndexByQuestion[req.questions[state.questionIndex]?.id] ?? 0;
    rerenderChoiceRequest(requestId);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    confirmChoiceQuestion(requestId);
  }
};

window.handleChoiceCustomKey = function(event, requestId) {
  if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey) {
    event.preventDefault();
    confirmChoiceQuestion(requestId);
  }
};

window.confirmChoiceQuestion = async function(requestId) {
  const req = getChoiceRequestById(requestId);
  if (!req) return;
  const state = getChoiceState(requestId);
  const questions = req.questions || [];
  rememberCurrentChoice(req, state);

  if (state.questionIndex < questions.length - 1) {
    state.questionIndex += 1;
    state.selectedIndex = state.selectedIndexByQuestion[questions[state.questionIndex]?.id] ?? 0;
    rerenderChoiceRequest(requestId);
    return;
  }

  const finalAnswers = questions.map((_, index) => state.answers[index] || buildChoiceAnswer(req, state, index));
  const summary = finalAnswers.map((item, index) => {
    const q = questions[index] || {};
    if (item.customText) return `${q.question || item.questionId}: ${item.customText}`;
    const option = (q.options || []).find(candidate => candidate.id === item.optionId);
    return `${q.question || item.questionId}: ${option?.label || item.optionId || ''}`;
  }).join('\n');

  try {
    const res = await fetch(`/api/agents/${currentRuntimeAgentId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId,
        input: summary,
        response: {
          kind: 'choices',
          choices: finalAnswers,
          text: summary,
        },
      }),
    });
    if (res.ok) {
      delete choiceInputState[requestId];
      poll();
    }
  } catch (e) {
    console.error('提交选择失败:', e);
  }
};

function syncRollbackActionButtons() {
  const allowRollback = !!getRollbackInputRequest();
  const rows = container.querySelectorAll('.message-row');

  rows.forEach((row, index) => {
    const msg = currentMessages[index];
    const meta = row.querySelector('.message-meta');
    if (!meta) return;

    const existingButton = meta.querySelector('.message-action');
    const shouldShow = allowRollback && !!msg && msg.role === 'user';

    if (!shouldShow) {
      if (existingButton) {
        existingButton.remove();
      }
      return;
    }

    if (existingButton) {
      existingButton.setAttribute('onclick', 'requestRollbackEdit(' + index + ')');
      existingButton.style.display = '';
      return;
    }

    const button = document.createElement('button');
    button.className = 'message-action';
    button.type = 'button';
    button.textContent = '编辑此轮';
    button.setAttribute('onclick', 'requestRollbackEdit(' + index + ')');
    meta.appendChild(button);
  });
}

function updateRollbackActionVisibility() {
  syncRollbackActionButtons();
}

function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
}

function handleInputKey(event, requestId) {
  if (event.key === 'Enter') {
    if (event.ctrlKey || event.shiftKey) {
      // Ctrl+Enter or Shift+Enter for new line
      // default behavior is new line, but we might want to ensure it works
      return; 
    } else {
      // Enter for submit
      event.preventDefault();
      submitInput(requestId);
    }
  }
}

// 提交输入
async function submitInput(requestId) {
  const textarea = document.getElementById(`input-${requestId}`);
  const input = textarea ? textarea.value : '';

  try {
    const res = await fetch(`/api/agents/${currentRuntimeAgentId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId,
        input,
        response: {
          kind: 'text',
          text: input,
        },
      })
    });
    if (res.ok) {
      setFollowLatest(true);
      // 刷新输入请求列表
      poll();
    }
  } catch (e) {
    console.error('提交输入失败:', e);
  }
}

function getPrimaryInputRequest() {
  return Array.isArray(currentInputRequests) && currentInputRequests.length > 0
    ? currentInputRequests[0]
    : null;
}

function requestSupportsAction(request, actionId) {
  return Array.isArray(request?.actions)
    && request.actions.some((action) => action && action.id === actionId);
}

function getRollbackInputRequest() {
  if (!Array.isArray(currentInputRequests)) {
    return null;
  }
  return currentInputRequests.find((request) => requestSupportsAction(request, 'rollback_to_call')) || null;
}

function canRollbackMessage(msg) {
  return !!getRollbackInputRequest() && !!msg && msg.role === 'user';
}

function saveChatProcessVisibility() {
  try {
    localStorage.setItem(CHAT_PROCESS_VISIBILITY_KEY, showChatProcess ? 'true' : 'false');
  } catch (error) {
    console.warn('Failed to persist chat process visibility:', error);
  }
}

function hasConversationProcessContent(messages = []) {
  return messages.some((msg) =>
    msg?.role === 'system'
    || msg?.role === 'tool'
    || (msg?.role === 'assistant' && !!msg.reasoning)
    || (Array.isArray(msg?.toolCalls) && msg.toolCalls.length > 0)
  );
}

function updateChatProcessToggle() {
  if (!chatProcessToggle) return;
  const hasProcess = hasConversationProcessContent(currentMessages) && !shouldRenderWorkspaceSurface();
  chatProcessToggle.classList.toggle('hidden', !hasProcess);
  if (!hasProcess) return;
  chatProcessToggle.classList.toggle('active', showChatProcess);
  chatProcessToggle.textContent = showChatProcess ? t('hide_process') : t('show_process');
}

function syncAssistantProcessOnlyRows(root = container) {
  root.querySelectorAll('.message-row.assistant').forEach((row) => {
    const content = row.querySelector('.message-content');
    if (!content) return;

    const visibleContent = Array.from(content.children).some((child) => {
      if (child.classList.contains('markdown-body')) {
        return String(child.textContent || '').trim().length > 0;
      }
      if (child.classList.contains('reasoning-block')) {
        return !child.classList.contains('process-hidden');
      }
      if (child.classList.contains('tool-call-container')) {
        return !child.classList.contains('process-hidden');
      }
      return child.offsetParent !== null;
    });

    row.classList.toggle('process-hidden-empty', !visibleContent);
  });
}

function applyConversationProcessState(root = container) {
  root.querySelectorAll('.message-row.system').forEach((row) => {
    row.classList.toggle('process-hidden', !showChatProcess);
  });

  root.querySelectorAll('.reasoning-block').forEach((block) => {
    block.classList.toggle('process-hidden', !showChatProcess);
  });

  root.querySelectorAll('.message-row.assistant .tool-call-container').forEach((block) => {
    block.classList.toggle('process-hidden', !showChatProcess);
  });

  root.querySelectorAll('.message-row.tool').forEach((row) => {
    row.classList.toggle('process-hidden', !showChatProcess);
  });

  syncAssistantProcessOnlyRows(root);
  syncCollapseStates(root);
  updateChatProcessToggle();
};

window.toggleChatProcessVisibility = function() {
  showChatProcess = !showChatProcess;
  saveChatProcessVisibility();
  applyConversationProcessState(container);
};

async function submitInputAction(requestId, actionId, payload = {}) {
  try {
    const res = await fetch(`/api/agents/${currentRuntimeAgentId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId,
        input: '',
        response: {
          kind: 'action',
          actionId,
          payload,
        },
      }),
    });
    if (res.ok) {
      poll();
    }
  } catch (e) {
    console.error('提交动作失败:', e);
  }
}

window.requestRollbackEdit = async function(messageIndex) {
  const request = getRollbackInputRequest();
  if (!request) {
    console.warn('No rollback-capable input request available');
    return;
  }

  const msg = currentMessages[messageIndex];
  if (!msg || msg.role !== 'user') {
    return;
  }

  const fallbackCallIndex = currentMessages
    .slice(0, messageIndex + 1)
    .filter(entry => entry.role === 'user')
    .length - 1;
  const callIndex = typeof msg.turn === 'number' ? msg.turn : fallbackCallIndex;

  await submitInputAction(request.requestId, 'rollback_to_call', {
    callIndex,
    draftInput: msg.content,
  });
};

// 生成单条消息的 HTML
function renderMessage(msg, index) {
  const role = msg.role;
  const msgId = `msg-${index}`;
  let contentHtml = '';
  let metaHtml = `<div class="role-badge">${role}</div>`;
  if (canRollbackMessage(msg)) {
    metaHtml += `<button class="message-action" onclick="requestRollbackEdit(${index})">编辑此轮</button>`;
  }

  if (role === 'user' || role === 'system') {
    let style = '';
    let rowClass = role;
    if (role === 'system') {
       const isLong = msg.content.includes('\n') || msg.content.length > 60;
       if (isLong) {
         style = 'text-align: left !important;';
         rowClass += ' long-content';
       }
       contentHtml = `<div class="message-content markdown-body" id="${msgId}" style="${style}">${renderMarkdown(msg.content)}</div>`;
    } else {
      contentHtml = `<div class="message-content markdown-body" id="${msgId}">${renderMarkdown(msg.content)}</div>`;
    }

    if (role === 'system') {
       return `
        <div class="message-row ${rowClass}">
          <div class="message-meta">
            ${metaHtml}
          </div>
          ${contentHtml}
        </div>
      `;
    }
    return `
      <div class="message-row ${role}">
        <div class="message-meta">
          ${metaHtml}
        </div>
        ${contentHtml}
      </div>
    `;
  } else if (role === 'assistant') {
    let innerContent = '';

    if (msg.reasoning) {
      innerContent += `
        <div class="reasoning-block" id="reasoning-${msgId}">
            <div class="reasoning-header" onclick="toggleReasoning('reasoning-${msgId}')">
              <svg class="reasoning-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"></path></svg>
            <span>${escapeHtml(t('thinking_process'))}</span>
          </div>
          <div class="reasoning-content markdown-body">
            ${renderMarkdown(msg.reasoning)}
          </div>
        </div>
      `;
    }

    // 检测子代理完成消息，使用 tool-call-container 风格渲染（类似 glob）
    const agentCompletePattern = /^[\s\S]*\[子代理\s+(\S+)\s+执行完成\]:[\s\S]*$/;
    const agentCompleteMatch = msg.content.match(agentCompletePattern);
    if (agentCompleteMatch) {
      const agentName = agentCompleteMatch[1];
      // 查找子代理对应的 agentId（使用前端的 allAgents 数组）
      const subAgent = allAgents.find(a => a.name === agentName);
      const subAgentId = subAgent ? subAgent.id : null;
      const clickAttr = subAgentId ? `onclick="switchAgent('${subAgentId}')"` : '';
      const linkHtml = subAgentId
        ? `<div style="font-size:11px; color:var(--text-secondary); margin-left:4px; cursor:pointer;" ${clickAttr}>${escapeHtml(t('subagent_view_messages'))}</div>`
        : '';

      innerContent += `
          <div class="tool-call-container">
            <div class="tool-header">
              <span class="tool-header-name">${escapeHtml(t('subagent_done'))}</span>
            </div>
            <div class="tool-content">
              <div class="bash-command">【${escapeHtml(agentName)}】${escapeHtml(t('subagent_done'))}</div>
              ${linkHtml}
            </div>
          </div>
      `;
    } else if (msg.content && msg.content.startsWith('[Error:')) {
      // 错误消息使用红色样式
      innerContent += `<div class="tool-error">${escapeHtml(msg.content)}</div>`;
    } else {
      innerContent += `<div class="markdown-body">${renderMarkdown(msg.content)}</div>`;
    }

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      const toolsHtml = msg.toolCalls.map(call => {
        const displayName = getToolDisplayName(call.name);
        const template = getToolRenderTemplate(call.name);
        let innerHtml;

        if (template.call) {
          innerHtml = applyTemplate(template.call, call.arguments);
        } else {
          innerHtml = renderJsonHighlight(call.arguments);
        }

        return `
          <div class="tool-call-container">
            <div class="tool-header">
              <span class="tool-header-name">${displayName}</span>
            </div>
            <div class="tool-content">${innerHtml}</div>
          </div>
        `;
      }).join('');
      innerContent += toolsHtml;
    }

    contentHtml = `<div class="message-content" id="${msgId}">${innerContent}</div>`;

  } else if (role === 'tool') {
    const toolCallId = msg.toolCallId;
    let toolName = null;
    let toolArgs = {};

    // 查找对应的工具调用（需要传入完整消息列表）
    return '';  // 这个需要在完整上下文中处理，暂时返回空
  }

  return `
    <div class="message-row ${role}">
      <div class="message-meta">
        ${metaHtml}
      </div>
      ${contentHtml}
    </div>
  `;
}

// 追加新消息（保持现有 DOM 状态）
function appendNewMessages(newMessages, startIndex) {
  // 移除空状态
  const emptyState = container.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  // 获取当前消息数量
  const currentCount = container.querySelectorAll('.message-row').length;

  newMessages.forEach((msg, i) => {
    const index = startIndex + i;
    const msgId = `msg-${index}`;
    let html = '';

    if (msg.role === 'user' || msg.role === 'system' || msg.role === 'assistant') {
      html = renderMessage(msg, index);
    } else if (msg.role === 'tool') {
      // tool 需要特殊处理，查找对应的 toolCall
      let toolName = null;
      let toolArgs = {};
      const messages = currentMessages;
      const toolCallId = msg.toolCallId;

      for (const m of messages) {
        if (m.toolCalls) {
          const found = m.toolCalls.find(c => c.id === toolCallId);
          if (found) {
            toolName = found.name;
            toolArgs = found.arguments;
            break;
          }
        }
      }

      const { success, data } = parseToolResult(msg.content);
      const displayName = getToolDisplayName(toolName);
      const template = getToolRenderTemplate(toolName);

      let bodyHtml;
      if (template.result) {
         bodyHtml = applyTemplate(template.result, data, success, toolArgs);
      } else {
         bodyHtml = renderJsonHighlight(data);
      }

      html = `
        <div class="message-row ${msg.role}" data-tool-success="${success ? 'true' : 'false'}">
          <div class="message-meta">
            <div class="role-badge">${msg.role}</div>
          </div>
          <div class="message-content" id="${msgId}" style="padding:0; overflow:hidden;">
            <div class="tool-result-header">
              <span class="status-dot ${success ? 'success' : 'error'}"></span>
              <span>${displayName}</span>
            </div>
            <div class="tool-result-body">${bodyHtml}</div>
          </div>
        </div>
      `;
    }

    // 追加到容器
    container.insertAdjacentHTML('beforeend', html);
    const appendedRow = container.lastElementChild;
    if (appendedRow) {
      enhanceMathInElement(appendedRow);
    }
  });

  // 对新消息应用折叠逻辑
  applyCollapseLogic(container, startIndex);
  updateRollbackActionVisibility();
  applyConversationProcessState(container);
  updateFollowLatestButton();
  if (followLatestEnabled) {
    scheduleScrollToLatest('smooth');
  }
}

// 更新最后一条消息
function updateLastMessage(msg) {
  const lastIndex = currentMessages.length - 1;
  const lastRow = container.querySelectorAll('.message-row')[lastIndex];
  if (!lastRow) {
    renderCurrentMainView();
    return;
  }

  const msgId = `msg-${lastIndex}`;

  if (msg.role === 'tool') {
    // tool 消息更新：重建 tool-result-body
    const toolCallId = msg.toolCallId;
    let toolName = null;
    let toolArgs = {};

    for (const m of currentMessages) {
      if (m.toolCalls) {
        const found = m.toolCalls.find(c => c.id === toolCallId);
        if (found) {
          toolName = found.name;
          toolArgs = found.arguments;
          break;
        }
      }
    }

    const { success, data } = parseToolResult(msg.content);
    const displayName = getToolDisplayName(toolName);
    const template = getToolRenderTemplate(toolName);

    let bodyHtml;
    if (template.result) {
       bodyHtml = applyTemplate(template.result, data, success, toolArgs);
    } else {
       bodyHtml = renderJsonHighlight(data);
    }

    const toolResultBody = lastRow.querySelector('.tool-result-body');
    if (toolResultBody) {
      toolResultBody.innerHTML = bodyHtml;
    }
    lastRow.dataset.toolSuccess = success ? 'true' : 'false';
    enhanceMathInElement(lastRow);
  } else {
    enhanceMathInElement(lastRow);
  }

  updateRollbackActionVisibility();
  applyConversationProcessState(container);
  updateFollowLatestButton();
  if (followLatestEnabled) {
    scheduleScrollToLatest('smooth');
  }
}

function getCollapseThresholdForRow(row) {
  if (row.classList.contains('assistant')) {
    return 220;
  }
  return 160;
}

function syncRowCollapseState(row) {
  const el = row.querySelector('.message-content');
  if (!el) return;

  const btnBar = row.querySelector('.expand-toggle-bar');
  if (row.classList.contains('process-hidden') || row.classList.contains('process-hidden-empty')) {
    el.classList.remove('collapsed');
    if (btnBar) btnBar.remove();
    return;
  }

  const collapseThreshold = getCollapseThresholdForRow(row);
  const isCollapsible = el.scrollHeight > collapseThreshold;
  const isSystem = row.classList.contains('system');
  const toolName = row.querySelector('.tool-result-header span:last-child')?.textContent || '';
  const isReadOrEdit = toolName === 'Read' || toolName === 'Edit';
  const shouldCollapse = isCollapsible && (isSystem || isReadOrEdit);

  if (!isCollapsible) {
    el.classList.remove('collapsed');
    if (btnBar) btnBar.remove();
    const toggle = row.querySelector('.collapse-toggle');
    if (toggle) toggle.style.display = 'none';
    return;
  }

  if (shouldCollapse) {
    el.classList.add('collapsed');
    const meta = row.querySelector('.message-meta .collapse-toggle svg');
    if (meta) meta.style.transform = 'rotate(-90deg)';
  } else {
    el.classList.remove('collapsed');
    const meta = row.querySelector('.message-meta .collapse-toggle svg');
    if (meta) meta.style.transform = 'rotate(0deg)';
  }

  let nextBtnBar = btnBar;
  if (!nextBtnBar) {
    nextBtnBar = document.createElement('div');
    nextBtnBar.className = 'expand-toggle-bar';
    row.appendChild(nextBtnBar);
  }

  const isCollapsed = el.classList.contains('collapsed');
  nextBtnBar.innerHTML = '<button class="expand-toggle-btn" onclick="toggleMessage(&quot;' + el.id + '&quot;)">' + getToggleButtonLabel(isCollapsed) + '</button>';
}

function syncCollapseStates(containerElement, startIndex = 0) {
  const rows = containerElement.querySelectorAll('.message-row');
  rows.forEach((row, idx) => {
    if (idx < startIndex) return;
    syncRowCollapseState(row);
  });
}

// 应用折叠逻辑（只处理指定索引后的消息）
function applyCollapseLogic(containerElement, startIndex = 0) {
  syncCollapseStates(containerElement, startIndex);
}

function render(messages) {
  if (messages.length === 0) {
    container.innerHTML = getEmptyStateHtml();
    updateFollowLatestButton();
    return;
  }

  const html = messages.map((msg, index) => {
    const role = msg.role;
    const msgId = `msg-${index}`;
    let contentHtml = '';
    let rowAttrs = '';
    let metaHtml = `<div class="role-badge">${role}</div>`;
    if (canRollbackMessage(msg)) {
      metaHtml += `<button class="message-action" onclick="requestRollbackEdit(${index})">编辑此轮</button>`;
    }

    if (role === 'user' || role === 'system') {
      let style = '';
      let rowClass = role;
      if (role === 'system') {
         const isLong = msg.content.includes('\n') || msg.content.length > 60;
         if (isLong) {
           style = 'text-align: left !important;';
           rowClass += ' long-content';
         }
         contentHtml = `<div class="message-content markdown-body" id="${msgId}" style="${style}">${renderMarkdown(msg.content)}</div>`;
      } else {
        contentHtml = `<div class="message-content markdown-body" id="${msgId}">${renderMarkdown(msg.content)}</div>`;
      }
      
      if (role === 'system') {
         return `
          <div class="message-row ${rowClass}">
            <div class="message-meta">
              ${metaHtml}
            </div>
            ${contentHtml}
          </div>
        `;
      }
    } else if (role === 'assistant') {
      let innerContent = '';

      if (msg.reasoning) {
        innerContent += `
          <div class="reasoning-block" id="reasoning-${msgId}">
            <div class="reasoning-header" onclick="toggleReasoning('reasoning-${msgId}')">
              <svg class="reasoning-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"></path></svg>
              <span>${escapeHtml(t('thinking_process'))}</span>
            </div>
            <div class="reasoning-content markdown-body">
              ${renderMarkdown(msg.reasoning)}
            </div>
          </div>
        `;
      }

      // 检测子代理完成消息，使用 tool-call-container 风格渲染（类似 glob）
      const agentCompletePattern = /^[\s\S]*\[子代理\s+(\S+)\s+执行完成\]:[\s\S]*$/;
      const agentCompleteMatch = msg.content.match(agentCompletePattern);
      if (agentCompleteMatch) {
        const agentName = agentCompleteMatch[1];
        // 查找子代理对应的 agentId（使用前端的 allAgents 数组）
        const subAgent = allAgents.find(a => a.name === agentName);
        const subAgentId = subAgent ? subAgent.id : null;
        const clickAttr = subAgentId ? `onclick="switchAgent('${subAgentId}')"` : '';
        const linkHtml = subAgentId
          ? `<div style="font-size:11px; color:var(--text-secondary); margin-left:4px; cursor:pointer;" ${clickAttr}>${escapeHtml(t('subagent_view_messages'))}</div>`
          : '';

        innerContent += `
          <div class="tool-call-container">
            <div class="tool-header">
              <span class="tool-header-name">${escapeHtml(t('subagent'))}</span>
            </div>
            <div class="tool-content">
              <div class="bash-command">${escapeHtml(agentName)} ${escapeHtml(t('subagent_done'))}</div>
              ${linkHtml}
            </div>
          </div>
        `;
      } else {
        innerContent += `<div class="markdown-body">${renderMarkdown(msg.content)}</div>`;
      }

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const toolsHtml = msg.toolCalls.map(call => {
          const displayName = getToolDisplayName(call.name);
          const template = getToolRenderTemplate(call.name);
          let innerHtml;

          if (template.call) {
            innerHtml = applyTemplate(template.call, call.arguments);
          } else {
            innerHtml = renderJsonHighlight(call.arguments);
          }

          return `
            <div class="tool-call-container">
              <div class="tool-header">
                <span class="tool-header-name">${displayName}</span>
              </div>
              <div class="tool-content">${innerHtml}</div>
            </div>
          `;
        }).join('');
        innerContent += toolsHtml;
      }

      contentHtml = `<div class="message-content" id="${msgId}">${innerContent}</div>`;

    } else if (role === 'tool') {
      const toolCallId = msg.toolCallId;
      let toolName = null;
      let toolArgs = {};
      
      for (const m of messages) {
        if (m.toolCalls) {
          const found = m.toolCalls.find(c => c.id === toolCallId);
          if (found) { 
            toolName = found.name;
            toolArgs = found.arguments;
            break; 
          }
        }
      }

      const { success, data } = parseToolResult(msg.content);
      rowAttrs = ` data-tool-success="${success ? 'true' : 'false'}"`;
      const displayName = getToolDisplayName(toolName);
      const template = getToolRenderTemplate(toolName);
      
      let bodyHtml;
      if (template.result) {
         bodyHtml = applyTemplate(template.result, data, success, toolArgs);
      } else {
         bodyHtml = renderJsonHighlight(data);
      }

      rowAttrs = ` data-tool-success="${success ? 'true' : 'false'}"`;
      contentHtml = `
        <div class="message-content" id="${msgId}" style="padding:0; overflow:hidden;">
          <div class="tool-result-header">
            <span class="status-dot ${success ? 'success' : 'error'}"></span>
            <span>${displayName}</span>
          </div>
          <div class="tool-result-body">${bodyHtml}</div>
        </div>`;
    }

    return `
      <div class="message-row ${role}"${rowAttrs}>
        <div class="message-meta">
          ${metaHtml}
        </div>
        ${contentHtml}
      </div>
    `;
  }).join('');

  const savedScrollTop = container.scrollTop;
  container.innerHTML = html;
  enhanceMathInElement(container);

  syncCollapseStates(container);

  updateRollbackActionVisibility();
  applyConversationProcessState(container);
  updateFollowLatestButton();
  if (followLatestEnabled) {
    scheduleScrollToLatest('auto');
  } else {
    container.scrollTop = savedScrollTop;
  }
}

window.toggleMessage = function(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.toggle('collapsed');
    const row = el.closest('.message-row');
    const isCollapsed = el.classList.contains('collapsed');

    // Update meta icon
    const meta = row.querySelector('.message-meta .collapse-toggle svg');
    if (meta) {
       meta.style.transform = isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)'; // meta uses transform
       // Fix: meta.transform in previous code was wrong, it's meta.style.transform
    }
    
    // Update bottom button
    const btn = row.querySelector('.expand-toggle-btn');
    if (btn) {
      btn.innerHTML = getToggleButtonLabel(isCollapsed);
    }
  }
};

window.toggleReasoning = function(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.toggle('expanded');
  }
};

applyTheme(currentTheme);
applyLanguage();

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
