/**
 * sidebar-render.js
 *
 * Sidebar agent list rendering and data loading.
 *
 * Extracted from app-main.js.
 *
 * Exported global functions:
 *   renderSidebarChildItems, getAgentIconHtml, renderAgentGroup,
 *   waitForPrebuiltRuntimeSession, waitForTargetRuntimeSession,
 *   loadAgents, refreshAgentCallStates,
 *   getAgentListRenderSignature, renderAgentList
 *
 * Dependencies (global state from app-core.js):
 *   allAgents, currentAgentId, currentRuntimeAgentId, currentLanguage,
 *   suppressSidebarRerender, _navigationGuardEpoch, ...
 */

// Tracks collapsed state of project groups in the sidebar (programming-helper).
// Keyed by projectDir||projectName so state persists across re-renders.
const _collapsedProjectGroups = new Set();

// Tracks collapsed state of category groups in the sidebar (系统空间, 工作群, etc.).
// Keyed by the .agent-group element id so state persists across re-renders.
const _collapsedCategoryGroups = new Set();

function renderSidebarChildItems(entries, ownerAgentId) {
  if (!Array.isArray(entries) || entries.length === 0) return '';

  const renderItem = (entry) => {
    const active = isRuntimeItemActive(entry.runtimeId);
    const disconnected = isSidebarRuntimeDisconnected(entry);
    const calling = !disconnected && isRuntimeCalling(entry.runtimeId);
    const restarting = restartingRuntimeIds.has(entry.runtimeId);
    const retiring = !!entry.replacementMutation || entry.sidebarOperation?.type === 'archive-close';
    const replacementPending = entry.pendingReplacement === true;
    const operationPending = entry.pendingOperation === true;
    const deleting = entry.deleting === true;
    const operationDegraded = entry.sidebarOperation?.phase === 'degraded';
    const targetStartDegraded = operationDegraded && entry.sidebarOperation?.errorCode === 'target_runtime_stopped';
    const justFinished = !calling && !disconnected && !restarting && _recentlyFinishedRuntimes.has(entry.runtimeId);
    // 线程宿主的 replacement：源会话不是「正在关闭」，而是「正在交接」给接力会话；
    // archive-close / delete 仍是真实关闭，保持原文案。
    const isThreadRelay = retiring
      && !deleting
      && !!entry.replacementMutation
      && typeof window.isThreadHostAgentId === 'function'
      && window.isThreadHostAgentId(ownerAgentId);
    const zh = currentLanguage === 'zh';
    const retiringLabel = targetStartDegraded
      ? (isThreadRelay ? (zh ? '接力会话启动未完成' : 'Relay session start incomplete') : (zh ? '新会话启动未完成' : 'New session start incomplete'))
      : operationDegraded
        ? (isThreadRelay ? (zh ? '交接收尾未完成' : 'Relay close incomplete') : (zh ? '关闭未完成' : 'Close incomplete'))
        : (isThreadRelay ? (zh ? '正在交接' : 'Relaying') : (zh ? '正在关闭' : 'Closing'));
    const itemClass = [
      'agent-item',
      'agent-runtime-item',
      active ? 'active' : '',
      disconnected ? 'disconnected' : '',
      calling ? 'calling' : '',
      restarting ? 'restarting' : '',
      retiring ? 'retiring' : '',
      replacementPending ? 'replacement-pending' : '',
      operationPending ? 'operation-pending' : '',
      deleting ? 'retiring' : '',
      justFinished ? 'just-finished' : '',
    ].filter(Boolean).join(' ');
    return `
      <div
        class="${itemClass}"
        data-agent-id="${escapeHtml(entry.runtimeId)}"
        data-agent-disabled="${replacementPending || operationPending || deleting ? 'true' : 'false'}"
        data-agent-prebuilt="false"
        data-agent-context-menu="${entry.contextMenuEnabled ? 'true' : 'false'}"
        data-ctx-role="runtime" data-ctx-ns="${escapeHtml(entry.ownerId || '')}" data-ctx-id="${escapeHtml(entry.runtimeId)}" data-ctx-variant="${escapeHtml(entry.source || '')}" data-ctx-session-id="${escapeHtml(entry.sessionId || '')}"
      >
        <div class="agent-line">
          <span class="agent-status-dot"></span>
          <div class="agent-name">${escapeHtml(entry.name || entry.runtimeId)}${retiring ? `<span class="agent-runtime-transition-label">${escapeHtml(retiringLabel)}</span>` : deleting ? `<span class="agent-runtime-transition-label">${escapeHtml(operationDegraded ? (currentLanguage === 'zh' ? '删除未完成' : 'Delete incomplete') : (currentLanguage === 'zh' ? '正在删除' : 'Deleting'))}</span>` : ''}</div>
        </div>
      </div>
    `;
  };

  // Group entries by projectName when present (programming-helper).
  // Entries are already sorted by createdAt desc; group order follows
  // the first entry encountered, so the most recently active project appears first.
  const hasProjects = entries.some((e) => e.projectName);

  if (!hasProjects) {
    return `<div class="agent-runtime-list">${entries.map(renderItem).join('')}</div>`;
  }

  const groups = [];
  const groupIndex = new Map();
  for (const entry of entries) {
    const key = entry.projectName || '';
    if (!groupIndex.has(key)) {
      groupIndex.set(key, groups.length);
      groups.push({ projectName: key, projectDir: entry.projectDir || '', items: [] });
    }
    groups[groupIndex.get(key)].items.push(entry);
  }

  // Sort groups alphabetically by display label; items within each
  // group keep their existing (time-desc) order.
  groups.sort((a, b) => {
    const la = a.projectName || '';
    const lb = b.projectName || '';
    return la.localeCompare(lb, undefined, { sensitivity: 'base', numeric: true });
  });

  return `<div class="agent-runtime-list">${groups.map((group) => {
    const label = group.projectName || (currentLanguage === 'zh' ? '未分组' : 'Ungrouped');
    const projectKey = group.projectDir || group.projectName || label;
    const collapsed = _collapsedProjectGroups.has(projectKey);
    const enterLabel = currentLanguage === 'zh' ? '进入' : 'Enter';
    const isWorkGroup = ownerAgentId === 'work-group';
    // For work-group: enter navigates to the group chat by chatId.
    // For programming-helper: enter navigates to the workspace surface and
    // scrolls to / expands the corresponding project card.
    const enterType = isWorkGroup ? 'wg' : 'ph';
    const enterTarget = isWorkGroup ? projectKey : (group.projectDir || label);
    return `<div class="agent-runtime-project-group${collapsed ? ' collapsed' : ''}" data-project-key="${escapeHtml(projectKey)}">` +
      `<div class="agent-runtime-project-header" title="${escapeHtml(group.projectDir || label)}">` +
        `<span class="project-collapse-arrow"></span>` +
        `<span class="project-collapse-label">${escapeHtml(label)}</span>` +
        `<button class="project-enter-btn" data-enter-type="${enterType}" data-enter-target="${escapeHtml(enterTarget)}" title="${escapeHtml(enterLabel)}">${escapeHtml(enterLabel)}</button>` +
      `</div>` +
      `<div class="agent-runtime-project-items">${group.items.map(renderItem).join('')}</div>` +
    `</div>`;
  }).join('')}</div>`;
}

const AGENT_ICONS = {
  'home': 'home.svg',
  'flow-workspace': 'flow-workspace.svg',
  'feature-repository': 'feature-repository.svg',
  'feature-creator': 'feature-creator.svg',
  'agent-studio': 'programming-helper.svg',
  'qqbot': 'qqbot.svg',
  'dispatch-console': 'dispatch-console.svg',
  'programming-helper': 'programming-helper.svg',
  'coder': 'programming-helper.svg',
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
      const childrenHtml = renderSidebarChildItems(childEntries, agent.id);
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

async function waitForTargetRuntimeSession(agentId, sessionId, attempts = 50, options = {}) {
  const operationId = String(options.operationId || '').trim();
  // This is a bounded navigation wait, not an operation-success verdict. The
  // session mutation has already committed before callers enter this function.
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const params = new URLSearchParams({ agentId, sessionId });
      if (operationId) params.set('operationId', operationId);
      const response = await fetch('/protoclaw/runtime_status?' + params.toString());
      if (response.ok) {
        const result = await response.json();
        if (result?.ready === true && result?.agent) return result.agent;
        if (result?.lifecycle === 'stopped' || result?.lifecycle === 'missing') {
          const error = new Error(`Runtime ${result.lifecycle} before becoming ready: ${agentId}/${sessionId}`);
          error.code = 'target_runtime_stopped';
          throw error;
        }
      }
    } catch {
      // A polling transport error is neither a session-mutation nor startup failure.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

async function loadAgents() {
  if (loadAgentsInFlight) {
    return loadAgentsInFlight;
  }
  const _t0 = performance.now();
  const sidebarSnapshotToken = typeof captureSidebarSnapshotToken === 'function'
    ? captureSidebarSnapshotToken()
    : null;
  const task = (async () => {
  try {
    const [connectedAgents, res] = await Promise.all([
      invoke('get_connected_agents'),
      fetch('/api/agents'),
    ]);
    const data = res.ok ? await res.json().catch(() => ({ agents: [], currentAgentId: null })) : { agents: [], currentAgentId: null };
    if (sidebarSnapshotToken && typeof isSidebarSnapshotTokenCurrent === 'function' && !isSidebarSnapshotTokenCurrent(sidebarSnapshotToken)) {
      window.setTimeout(() => loadAgents().catch(e => console.warn(e)), 25);
      return { stale: true };
    }
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
            workspace_state: {
              ...prev.workspace_state,
              // gcChats comes from getConnectedAgents (not agent_detail),
              // so always use the fresh value to avoid losing group chat mapping.
              ...(agent.workspace_state?.gcChats ? { gcChats: agent.workspace_state.gcChats } : {}),
            },
            // The light snapshot is authoritative for membership/status when
            // its revision is current; merge preserves rich fields by ID.
            workspace_sessions: typeof mergeWorkspaceSessionSnapshots === 'function'
              ? mergeWorkspaceSessionSnapshots(prev.workspace_sessions, agent.workspace_sessions, agent.id)
              : prev.workspace_sessions,
          } : {}),
          // 当新数据的 workspace_sessions.sessions 为空但旧数据有值时，保留旧 sessions 避免闪空
          ...(!loadedAgentDetailIds.has(agent.id) && prev?.workspace_sessions?.sessions?.length > 0
            && !(agent.workspace_sessions?.sessions?.length > 0) ? {
              workspace_sessions: prev.workspace_sessions,
            } : {}),
          // Preserve contextLength/compressRatio from prev when the light
          // getConnectedAgents snapshot doesn't include them. This prevents
          // the context bar from flashing defaults between data refreshes.
          // Only applies when loadAgentDetail hasn't run yet AND the new data
          // has sessions (if sessions are empty, the block above already
          // preserves the entire prev.workspace_sessions).
          ...(!loadedAgentDetailIds.has(agent.id)
            && agent.workspace_sessions?.sessions?.length > 0
            && prev?.workspace_sessions && (() => {
            const cur = agent.workspace_sessions;
            const curCl = cur?.contextLength;
            const curCr = cur?.compressRatio;
            const prevCl = prev.workspace_sessions.contextLength;
            const prevCr = prev.workspace_sessions.compressRatio;
            const needCl = !(Number.isFinite(curCl) && curCl > 0) && Number.isFinite(prevCl) && prevCl > 0;
            const needCr = !(Number.isFinite(curCr) && curCr > 0 && curCr <= 100) && Number.isFinite(prevCr) && prevCr > 0 && prevCr <= 100;
            if (!needCl && !needCr) return {};
            return {
              workspace_sessions: {
                ...cur,
                ...(needCl ? { contextLength: prevCl } : {}),
                ...(needCr ? { compressRatio: prevCr } : {}),
              },
            };
          })()),
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

    await refreshAgentCallStates(allAgents);

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
    const nextNotificationPayloads = new Map();
    await Promise.all(runtimeIds.map(async (runtimeId) => {
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(runtimeId)}/notification`);
        if (!res.ok) return;
        const notifData = await res.json();
        nextNotificationPayloads.set(runtimeId, notifData);
        nextCallStates.set(runtimeId, resolveNotificationCallingState(notifData));
      } catch (error) {
      }
    }));

    let changed = false;
    for (const runtimeId of runtimeIds) {
      const backendCalling = nextCallStates.get(runtimeId) === true;
      const prevCalling = _agentCallActive.get(runtimeId) === true;
      const notificationPayload = nextNotificationPayloads.get(runtimeId) || null;
      // interrupting 是粘性状态；同一 call 的旧 true 不能恢复为 running。
      const effectiveCalling = backendCalling
        && !isInterruptSuppressed(runtimeId, getNotificationCallStartedAt(notificationPayload));
      if (effectiveCalling) {
        _markAgentCallStartedForNotify(runtimeId);
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
        _tryNotifyAgentFinished(runtimeId, nextNotificationPayloads.get(runtimeId) || null);
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
      const notificationPayload = nextNotificationPayloads.get(runtimeId) || null;
      const nextCalling = nextCallStates.get(runtimeId) === true
        && !isInterruptSuppressed(runtimeId, getNotificationCallStartedAt(notificationPayload));
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
    sidebarOperationVersion: typeof getSidebarOperationVersion === 'function' ? getSidebarOperationVersion() : 0,
    sessionReplacements: typeof listSidebarOperations === 'function'
      ? listSidebarOperations().map((item) => ({ ...item }))
      : [],
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
        workspaceRevision: Number(agent?.workspace_sessions?.revision) || 0,
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
  // Handle category group collapse/expand toggle (系统空间, 工作群, etc.).
  const categoryHeader = event.target.closest('.agent-group-header');
  if (categoryHeader) {
    const groupEl = categoryHeader.closest('.agent-group');
    if (groupEl && groupEl.id) {
      if (_collapsedCategoryGroups.has(groupEl.id)) {
        _collapsedCategoryGroups.delete(groupEl.id);
        groupEl.classList.remove('collapsed');
      } else {
        _collapsedCategoryGroups.add(groupEl.id);
        groupEl.classList.add('collapsed');
      }
    }
    return;
  }

  // Handle "enter" button click on project group headers.
  const enterBtn = event.target.closest('.project-enter-btn');
  if (enterBtn) {
    const enterType = enterBtn.dataset.enterType;
    const enterTarget = enterBtn.dataset.enterTarget;
    if (enterType === 'wg') {
      await window.handlePrebuiltAgentClick('work-group');
      if (window.WorkGroupUI && typeof window.WorkGroupUI.selectChat === 'function') {
        window.WorkGroupUI.selectChat(enterTarget);
      }
    } else if (enterType === 'ph') {
      // Navigate to programming-helper workspace, then switch active project.
      const projectDir = enterTarget || '';
      await window.handlePrebuiltAgentClick('programming-helper');
      if (projectDir && typeof window.phSwitchProject === 'function') {
        const projectId = 'dir:' + projectDir.replace(/\\/g, '/').toLowerCase();
        await window.phSwitchProject(projectId);
      }
    }
    return;
  }

  // Handle project group collapse/expand toggle (programming-helper).
  const projectHeader = event.target.closest('.agent-runtime-project-header');
  if (projectHeader) {
    const groupEl = projectHeader.closest('.agent-runtime-project-group');
    if (groupEl) {
      const key = groupEl.dataset.projectKey;
      if (key) {
        if (_collapsedProjectGroups.has(key)) {
          _collapsedProjectGroups.delete(key);
          groupEl.classList.remove('collapsed');
        } else {
          _collapsedProjectGroups.add(key);
          groupEl.classList.add('collapsed');
        }
      }
    }
    return;
  }

  const item = event.target.closest('.agent-item');
  if (!item) return;
  if (item.classList.contains('editing')) return;

  const agentId = item.dataset.agentId;
  if (!agentId) return;
  if (item.dataset.agentDisabled === 'true') return;

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
