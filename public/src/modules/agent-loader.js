// ESM owner for template-map and agent-detail requests. The host adapter is the
// narrow boundary to legacy sidebar/session state and rendering effects.
export function createAgentLoader(host) {
  const loadedAgentDetailIds = host.loadedAgentDetailIds;
  const agentDetailPayloadCache = new Map();

  async function loadFeatureTemplateMap() {
    const runtimeId = host.currentRuntimeAgentId();
    if (!runtimeId) return false;
    try {
      const response = await host.fetch(`/api/templates/feature?agentId=${encodeURIComponent(runtimeId)}`);
      if (!response.ok) return false;
      const data = await response.json().catch(() => ({}));
      if (Object.keys(data).length > 0) {
        host.setFeatureTemplateMap(data);
        return true;
      }
      return false;
    } catch (error) {
      host.warn('[Viewer] Failed to load feature templates:', error);
      return false;
    }
  }

  function getAgentDetailPayload(agentId) {
    const key = String(agentId || '').trim();
    return agentDetailPayloadCache.get(key) || null;
  }

  function extractSessionMetaFromDetail(detail, sessionId) {
    const sessions = detail?.workspace_sessions;
    const selectedSessionId = String(sessionId || '').trim();
    if (!selectedSessionId) return null;
    const list = Array.isArray(sessions?.sessions) ? sessions.sessions : [];
    const activeSession = list.find((item) => String(item?.id || '').trim() === selectedSessionId);
    if (!activeSession) return null;
    return {
      sessionId: selectedSessionId,
      sessionType: String(activeSession.sessionType || 'main').trim() || 'main',
      workspaceAgentId: activeSession.workspaceAgentId || 'main',
      createdAt: String(activeSession.createdAt || '').trim(),
      updatedAt: String(activeSession.updatedAt || '').trim(),
      openDirectory: String(activeSession.openDirectory || detail?.workspace_state?.openDirectory || '').trim(),
      messageCount: Number.isFinite(activeSession.messageCount) ? activeSession.messageCount : 0,
    };
  }

  async function loadAgentDetail(agentId) {
    if (!agentId || loadedAgentDetailIds.has(agentId)) return;
    loadedAgentDetailIds.add(agentId);
    const sidebarSnapshotToken = host.captureSidebarSnapshotToken();
    const sessionViewToken = host.captureSessionViewToken();
    let loaded = false;
    try {
      const ownership = host.getPhSessionOwnershipParams(
        host.allAgents().find((item) => item.id === agentId) || null,
      );
      const ownershipQuery = ownership.projectId
        ? '&projectId=' + encodeURIComponent(ownership.projectId)
        : (ownership.projectDir ? '&projectDir=' + encodeURIComponent(ownership.projectDir) : '');
      const response = await host.fetch(
        '/protoclaw/agent_detail?agentId=' + encodeURIComponent(agentId) + ownershipQuery,
      );
      if (!response.ok) return;
      const detail = await response.json();
      agentDetailPayloadCache.set(String(agentId).trim(), detail);
      const agent = host.allAgents().find((item) => item.id === agentId);
      if (agent) {
        const { workspace_sessions: freshSessions, ...otherDetail } = detail || {};
        Object.assign(agent, otherDetail);
        if (freshSessions) {
          agent.workspace_sessions = typeof host.mergeWorkspaceSessionSnapshots === 'function'
            ? host.mergeWorkspaceSessionSnapshots(agent.workspace_sessions || {}, freshSessions, agentId)
            : freshSessions;
        }
        if (sidebarSnapshotToken && !host.isSidebarSnapshotTokenCurrent(sidebarSnapshotToken)) {
          host.info('[SIDEBAR_OPERATION]', {
            operation: 'agent_detail', phase: 'stale_snapshot_merged', agentId,
          });
        }
      }
      const selectedIdentity = sessionViewToken?.identity;
      const sessionMeta = selectedIdentity?.agentId === String(agentId || '').trim()
        && sessionViewToken.runtimeId
        ? extractSessionMetaFromDetail(detail, selectedIdentity.sessionId)
        : null;
      if (sessionMeta) {
        host.commitSessionViewPatch(sessionViewToken, { sessionMeta }, ({ current }) => {
          host.updateChatContextBar(current);
          if (!current.messages.length) host.renderCurrentMainView(current);
        });
      }
      loaded = true;
    } catch (error) {
      host.warn('[Viewer] Failed to load agent detail:', agentId, error);
    } finally {
      if (!loaded) loadedAgentDetailIds.delete(agentId);
    }
  }

  async function reloadFeatureTemplateMap() {
    host.log('[Viewer] Reloading feature templates...');
    const success = await loadFeatureTemplateMap();
    const runtimeId = host.currentRuntimeAgentId();
    if (success && runtimeId) {
      host.warmTemplatesInBackground(
        host.collectTemplateNames(Object.values(host.toolRenderConfigs() || {})),
        runtimeId,
      );
    }
  }

  return {
    loadFeatureTemplateMap,
    reloadFeatureTemplateMap,
    loadAgentDetail,
    getAgentDetailPayload,
    extractSessionMetaFromDetail,
  };
}
