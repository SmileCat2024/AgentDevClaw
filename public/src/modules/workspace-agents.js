/* Workspace Agent presentation: the selected Session owns the binding. */
(function () {
  window.ClawFW = window.ClawFW || {};
  window.ClawFW.workspaceAgents = {
    getWelcomeName() {
      const identity = typeof getCurrentSessionViewIdentity === 'function' ? getCurrentSessionViewIdentity() : null;
      const hostId = identity?.agentId || focusedAgentId;
      const host = allAgents.find((entry) => entry.id === hostId)
        || (typeof getAgentDetailPayload === 'function' ? getAgentDetailPayload(hostId) : null);
      if (!host) return '';
      const runtime = allAgents.find((entry) => entry.id === currentRuntimeAgentId);
      const sessionId = identity?.sessionId || (currentRuntimeAgentId ? getRuntimeWorkspaceSessionId(currentRuntimeAgentId) : '');
      const remoteHost = typeof splitRemoteNamespaceId === 'function' ? splitRemoteNamespaceId(hostId) : null;
      const remoteSession = remoteHost && splitRemoteNamespaceId(sessionId);
      const detailSessionId = remoteSession?.connectionId === remoteHost?.connectionId ? remoteSession?.innerId : sessionId;
      const session = host.workspace_sessions?.sessions?.find((entry) => entry.id === sessionId || entry.id === detailSessionId);
      const meta = typeof readCurrentSessionViewState === 'function' ? readCurrentSessionViewState().sessionMeta : null;
      const runtimeMatches = runtime && getLogicalAgentId(runtime) === hostId
        && runtime.active_workspace_session_id === sessionId;
      const boundId = meta?.sessionId === sessionId && meta.workspaceAgentId ? meta.workspaceAgentId
        : session ? (session.workspaceAgentId || 'main')
          : runtimeMatches ? runtime.workspaceAgentId : '';
      if (!boundId) return '';
      if (!Array.isArray(host.agents)) return boundId === 'main' ? String(host.name || '') : '';
      const agent = host.agents.find((entry) => entry.id === boundId);
      return agent ? localizeWorkspaceValue(agent.displayName) : '';
    },

    async selectForNewSession(host, action) {
      if (action.type !== 'create_session' || action.sessionId || action.sourceSessionId
        || action.workspaceAgentId !== undefined || !Array.isArray(host?.agents)
        || host.agents.length < 2) return action;
      const selected = await new Promise((resolve) => {
        const previousFocus = document.activeElement;
        const overlay = document.createElement('div');
        const isZh = currentLanguage === 'zh';
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
    },
  };
})();
