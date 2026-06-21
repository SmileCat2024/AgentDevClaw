/**
 * IM Channel Management Actions 模块
 * 从 app-main.js 拆出 (域 T: IM 操作 + QQBot 配置操作)
 *
 * 依赖全局状态 (定义在 app-core.js):
 *   qqbotConfigState, imWorkspaceState, imWorkspaceAutoSaveTimer, currentLanguage
 * 依赖全局函数 (定义在 app-ui.js / modules):
 *   normalizeQQBotConfigData, getQQBotConfigDraft, ensureQQBotConfigLoaded,
 *   normalizeIMWorkspaceBundleData, getIMWorkspaceDraft, renderCurrentMainView,
 *   loadAgents
 * 导出全局函数 (window.*):
 *   updateQQBotConfigDraft, updateIMWorkspaceField, updateIMQQConfigDraft,
 *   scheduleIMWorkspaceAutoSave, reloadIMWorkspaceConfig, saveIMWorkspaceConfig,
 *   createReceptionistSession, handleLineCarrierChange, handleLineSessionChange,
 *   launchReceptionistSession, startWeixinBinding, refreshWeixinBinding,
 *   logoutWeixinBinding, showWeixinQrCodeDialog, closeWeixinQrCodeDialog,
 *   openIMChannelConfig, closeIMChannelConfig, openIMChannelDetail,
 *   closeIMChannelDetail, toggleIMDropdown, imSelectChannel, imSelectLine,
 *   togglePortalAgentAutostart, reloadQQBotConfig, saveQQBotConfig
 */

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


window._imOpenDropdownKey = null;

window.toggleIMDropdown = (trigger) => {
  const dropdown = trigger.closest('.im-dropdown');
  if (!dropdown) return;
  const isOpen = dropdown.classList.contains('open');
  document.querySelectorAll('.im-dropdown.open').forEach((d) => d.classList.remove('open'));

  if (isOpen) {
    window._imOpenDropdownKey = null;
    return;
  }

  dropdown.classList.add('open');

  // Track open state for re-render persistence
  const lineId = dropdown.dataset?.lineId || '';
  const dropdownType = dropdown.dataset?.dropdownType || '';
  window._imOpenDropdownKey = lineId + ':' + dropdownType;

  // When opening a session dropdown, refresh the bundle to get the latest
  // connectable sessions (new sessions, runtime state changes, etc.)
  // Use a soft fetch that doesn't clear existing data, so the dropdown
  // stays open and populated during the refresh.
  if (dropdownType === 'session') {
    fetch('/protoclaw/im_workspace_bundle')
      .then((r) => (r.ok ? r.json() : null))
      .then((payload) => {
        if (!payload) return;
        const bundle = normalizeIMWorkspaceBundleData(payload);
        imWorkspaceState.data = bundle;
        imWorkspaceState.draft = JSON.parse(JSON.stringify(bundle));
        renderCurrentMainView();
      })
      .catch((e) => console.error('Failed to refresh connectable sessions:', e));
  }
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
  window._imOpenDropdownKey = null;
  const value = item.dataset.value;
  if (type === 'carrier') {
    window.handleLineCarrierChange(lineId, value);
  } else if (type === 'session') {
    window.handleLineSessionChange(lineId, value);
  }
};

window.togglePortalAgentAutostart = async (enabled, existingScheduleId) => {
  try {
    if (enabled && !existingScheduleId) {
      const res = await fetch('/protoclaw/dispatch/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetAgentId: 'qqbot',
          targetSessionId: '__latest__',
          trigger: { type: 'on-boot' },
          action: { type: 'start_agent' },
          message: '',
        }),
      });
      if (!res.ok) throw new Error(await res.text());
    } else if (!enabled && existingScheduleId) {
      const res = await fetch('/protoclaw/dispatch/schedules/' + encodeURIComponent(existingScheduleId), {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(await res.text());
    }
    if (typeof window.refreshDispatchConsoleData === 'function') {
      await window.refreshDispatchConsoleData({ force: true });
    } else {
      await window.loadDispatchSchedules();
    }
    renderCurrentMainView();
  } catch (err) {
    console.error('Failed to toggle autostart:', err);
    if (typeof window.refreshDispatchConsoleData === 'function') {
      await window.refreshDispatchConsoleData({ force: true });
    }
    renderCurrentMainView();
  }
};

document.addEventListener('click', (e) => {
  if (!e.target.closest('.im-dropdown')) {
    document.querySelectorAll('.im-dropdown.open').forEach((d) => d.classList.remove('open'));
    window._imOpenDropdownKey = null;
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

// ── End IM Channel Management Actions ──────────────────────────────
