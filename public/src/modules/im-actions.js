/**
 * IM Channel Management Actions 模块
 * 从 app-main.js 拆出 (域 T: IM 操作 + QQBot 配置操作)
 *
 * 依赖全局状态 (定义在 app-core.js):
 *   qqbotConfigState, imWorkspaceState, imWorkspaceAutoSaveTimer, currentLanguage
 * 依赖全局函数 (定义在 app-ui.js / modules):
 *   normalizeQQBotConfigData, getQQBotConfigDraft, ensureQQBotConfigLoaded,
 *   normalizeIMWorkspaceBundleData, getIMWorkspaceDraft, renderCurrentMainView,
 *   loadAgents, ensureIMWorkspaceLoaded, ensureIMRoutableTargetsLoaded,
 *   imParseLineTargetValue
 * 依赖全局能力（thread-store.js）:
 *   refreshThreads, openConversationTarget
 * 导出全局函数 (window.*):
 *   updateQQBotConfigDraft, updateIMWorkspaceField, updateIMQQConfigDraft,
 *   updateIMFeishuConfigDraft,
 *   scheduleIMWorkspaceAutoSave, reloadIMWorkspaceConfig, saveIMWorkspaceConfig,
 *   launchOperatorConversation, handleLineCarrierChange, handleLineTargetChange,
 *   startWeixinBinding, refreshWeixinBinding,
 *   logoutWeixinBinding, showWeixinQrCodeDialog, closeWeixinQrCodeDialog,
 *   openIMChannelConfig, closeIMChannelConfig, openIMChannelDetail,
 *   closeIMChannelDetail, toggleIMDropdown, imSelectLine,
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
};

window.updateIMFeishuConfigDraft = (fieldName, value) => {
  const draft = getIMWorkspaceDraft();
  const prevFeishu = draft.feishuConfig || {};
  imWorkspaceState.draft = {
    ...draft,
    feishuConfig: {
      ...prevFeishu,
      [fieldName]: value,
      configured: !!(fieldName === 'appId' ? value : prevFeishu.appId) &&
                  !!(fieldName === 'appSecret' ? value : prevFeishu.appSecret),
    },
  };
  window.scheduleIMWorkspaceAutoSave();
};

window.updateIMWecomConfigDraft = (fieldName, value) => {
  const draft = getIMWorkspaceDraft();
  const prevWecom = draft.wecomConfig || {};
  imWorkspaceState.draft = {
    ...draft,
    wecomConfig: {
      ...prevWecom,
      [fieldName]: value,
      configured: !!(fieldName === 'botId' ? value : prevWecom.botId) &&
                  !!(fieldName === 'secret' ? value : prevWecom.secret),
    },
  };
  window.scheduleIMWorkspaceAutoSave();
};

window.updateIMRokidConfigDraft = (fieldName, value) => {
  const draft = getIMWorkspaceDraft();
  const prevRokid = draft.rokidConfig || {};
  imWorkspaceState.draft = {
    ...draft,
    rokidConfig: {
      ...prevRokid,
      [fieldName]: value,
      configured: !!(fieldName === 'linkCode' ? value : prevRokid.linkCode) &&
                  !!(fieldName === 'linkSecret' ? value : prevRokid.linkSecret),
    },
  };
  window.scheduleIMWorkspaceAutoSave();
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
  const skipRender = !!window._imChannelDetailId;
  imWorkspaceState.saving = true;
  imWorkspaceState.error = '';
  if (!skipRender) renderCurrentMainView();
  try {
    const response = await fetch('/protoclaw/im_workspace_bundle', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceConfig: getIMWorkspaceDraft().workspaceConfig,
        qqConfig: getIMWorkspaceDraft().qqConfig,
        feishuConfig: getIMWorkspaceDraft().feishuConfig,
        wecomConfig: getIMWorkspaceDraft().wecomConfig,
        rokidConfig: getIMWorkspaceDraft().rokidConfig,
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
    if (!skipRender) renderCurrentMainView();
  }
};

window._creatingReceptionistSession = false;

/**
 * 门户接线员对话入口（ADR-0042 决策 5）：start = 复用现有接线员线程
 * （必要时建首代），new = 新建一代并归档旧线程。
 *
 * 为什么不再走 create_session + 回写 receptionistSessionId：qqbot 声明了
 * threadHost，create_session 本身就会建线程，与 im_operator/conversation/*
 * 成为两套并存入口——同一次点击多造一条线程。这里统一交给服务端事务，
 * 拿到 threadId 后以线程锚导航（与 memo 首页同一条 start_app_conversation
 * 通道的导航语义）。
 */
window.launchOperatorConversation = async (isNew, triggerButton) => {
  if (window._creatingReceptionistSession) return;
  window._creatingReceptionistSession = true;
  if (triggerButton) markActionLoading(triggerButton);
  renderCurrentMainView();
  try {
    const endpoint = isNew
      ? '/protoclaw/im_operator/conversation/new'
      : '/protoclaw/im_operator/conversation/start';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.ok || !result.threadId) {
      throw new Error(result?.message || result?.code || `HTTP ${response.status}`);
    }

    // 线程事实与 agent 投影先行刷新：openConversationTarget 从 allAgents
    // 解析 runtime 绑定，新建会话的 child 条目此刻往往尚未被轮询拉到。
    if (typeof window.refreshThreads === 'function') {
      await window.refreshThreads(true).catch(() => {});
    }
    if (typeof loadAgents === 'function') {
      await loadAgents().catch(() => {});
    }
    // 接线员线程引用可能刚被服务端改写（首代建立 / 换代），重新拉 bundle
    // 让门户卡与线路显示立即反映新引用。
    await ensureIMWorkspaceLoaded(true).catch(() => {});

    const opened = await window.openConversationTarget({
      agentId: String(result.thread?.agentId || 'qqbot').trim(),
      threadId: result.threadId,
    });
    if (!opened?.ok) throw new Error(opened?.reason || 'navigation_failed');
  } catch (error) {
    console.error('Failed to launch operator conversation:', error);
    window.alert((currentLanguage === 'zh' ? '对话启动失败：' : 'Failed to start conversation: ')
      + (error?.message || error));
  } finally {
    window._creatingReceptionistSession = false;
    if (triggerButton) triggerButton.classList.remove('action-loading');
    renderCurrentMainView();
  }
};

window.handleLineCarrierChange = async (lineId, carrier) => {
  if (!lineId) return;

  // 渠道变更必须连带现有绑定一起提交：im_line_transfer 在「只给 carrier
  // 不给 agentId/threadId」时会把 boundTarget 清成 null，用户换个渠道就
  // 静默丢绑定。这里把当前绑定原样带上，让服务端只改 carrier。
  const draft = getIMWorkspaceDraft();
  const line = (draft.workspaceConfig?.lines || []).find(l => l.id === lineId);
  const bound = carrier ? (line?.boundTarget || null) : null;

  imWorkspaceState.saving = true;
  renderCurrentMainView();
  try {
    const response = await fetch('/protoclaw/im_line_transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineId,
        carrier: carrier || '',
        ...(bound ? { agentId: bound.agentId, threadId: bound.threadId } : {}),
      }),
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

/**
 * 线路目标变更（ADR-0042 决策 1）：目标是一条线程，寻址为
 * (agentId, threadId)。空值 = 断开绑定。
 *
 * 旧实现把目标当会话（固定 agentId=programming-helper + sessionId），
 * 服务端要求 agentId + threadId 成对，于是绑定必然 400。
 */
window.handleLineTargetChange = async (lineId, targetValue) => {
  if (!lineId) return;

  const draft = getIMWorkspaceDraft();
  const line = (draft.workspaceConfig?.lines || []).find(l => l.id === lineId);
  const carrier = line?.carrier || '';
  if (!carrier) return;

  const { agentId, threadId } = imParseLineTargetValue(targetValue);

  imWorkspaceState.saving = true;
  renderCurrentMainView();
  try {
    const request = (!agentId || !threadId)
      ? fetch('/protoclaw/im_line_disconnect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lineId }),
        })
      : fetch('/protoclaw/im_line_transfer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lineId, carrier, agentId, threadId }),
        });
    const response = await request;
    if (!response.ok) {
      // 服务端在这里会给出可读原因（线程已归档 / 不属于该工作空间等），
      // 直接透出，不用笼统文案盖掉。
      const detail = await response.json().catch(() => null);
      throw new Error(detail?.error || detail?.message || `HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (payload.bundle) {
      const bundle = normalizeIMWorkspaceBundleData(payload.bundle);
      imWorkspaceState.data = bundle;
      imWorkspaceState.draft = JSON.parse(JSON.stringify(bundle));
    }
    // 绑定变更会影响后续可绑清单的运行时状态标注，刷新一次。
    await ensureIMRoutableTargetsLoaded(true).catch(() => {});
  } catch (error) {
    console.error('Failed to update line target:', error);
    imWorkspaceState.error = error && error.message ? error.message : String(error);
  } finally {
    imWorkspaceState.saving = false;
    renderCurrentMainView();
  }
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

window.toggleIMMoreChannels = () => {
  window._imMoreChannelsOpen = !window._imMoreChannelsOpen;
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

// When opening a target dropdown, refresh the routable thread list so new
// threads and runtime state changes show up. Use a soft fetch that keeps the
// existing draft, so the dropdown stays open and populated during the refresh.
  if (dropdownType === 'target') {
    ensureIMRoutableTargetsLoaded(true)
      .then(() => renderCurrentMainView())
      .catch((e) => console.error('Failed to refresh routable targets:', e));
  }
};

window.imSelectLine = (item, type, lineId) => {
  const dropdown = item.closest('.im-dropdown');
  if (!dropdown) return;
  dropdown.classList.remove('open');
  window._imOpenDropdownKey = null;
  const value = item.dataset.value;
  if (type === 'carrier') {
    window.handleLineCarrierChange(lineId, value);
  } else if (type === 'target') {
    window.handleLineTargetChange(lineId, value);
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
