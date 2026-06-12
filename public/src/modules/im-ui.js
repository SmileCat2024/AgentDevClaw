/**
 * IM Channel Management UI 模块
 * 从 app-ui.js 拆出 (域 H: IM 渠道管理 UI + QQBot 配置)
 *
 * 依赖全局状态 (定义在 app-core.js):
 *   qqbotConfigState, qqbotConfigRequest, imWorkspaceState, imWorkspaceRequest,
 *   currentLanguage
 * 依赖全局函数 (定义在 app-ui.js):
 *   renderCurrentMainView, getCurrentAgentRecord, escapeHtml, localizeWorkspaceValue,
 *   t, formatWorkspaceDate
 * 导出全局函数:
 *   normalizeQQBotConfigData, isQQBotConfigEditor, getQQBotConfigDraft,
 *   ensureQQBotConfigLoaded, normalizeIMWorkspaceBundleData, isIMWorkspaceConfigEditor,
 *   getIMWorkspaceDraft, ensureIMWorkspaceLoaded, renderQQBotConfigField,
 *   renderIMWorkspaceTextField, renderIMWorkspaceSelectField, renderIMWorkspaceInlineSelect,
 *   renderLineConnectionSection, renderIMWorkspaceConfigEditor,
 *   renderIMChannelConfigDialog, renderWeixinQrCodeDialog
 */

function normalizeQQBotConfigData(raw = {}) {
  return {
    appId: typeof raw.appId === 'string' ? raw.appId : '',
    clientSecret: typeof raw.clientSecret === 'string' ? raw.clientSecret : '',
    accountId: typeof raw.accountId === 'string' ? raw.accountId : '',
    markdownSupport: typeof raw.markdownSupport === 'boolean' ? raw.markdownSupport : true,
  };
}

function isQQBotConfigEditor(block) {
  return block?.configEditor?.type === 'qqbot';
}

function getQQBotConfigDraft() {
  return qqbotConfigState.draft || qqbotConfigState.data || normalizeQQBotConfigData();
}

async function ensureQQBotConfigLoaded(force = false) {
  if (qqbotConfigRequest && !force) {
    return qqbotConfigRequest;
  }

  if (!force && qqbotConfigState.data && !qqbotConfigState.error) {
    return qqbotConfigState.data;
  }

  qqbotConfigState.loading = true;
  qqbotConfigState.error = '';
  if (force) {
    qqbotConfigState.data = null;
    qqbotConfigState.draft = null;
  }
  renderCurrentMainView();

  qqbotConfigRequest = fetch('/protoclaw/qqbot_config')
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(await response.text().catch(() => 'Failed to load qqbot config'));
      }
      return response.json();
    })
    .then((payload) => {
      const config = normalizeQQBotConfigData(payload?.config || {});
      qqbotConfigState.data = config;
      qqbotConfigState.draft = { ...config };
      qqbotConfigState.sourcePath = payload?.sourcePath || '';
      qqbotConfigState.error = '';
      return config;
    })
    .catch((error) => {
      qqbotConfigState.error = error && error.message ? error.message : String(error);
      throw error;
    })
    .finally(() => {
      qqbotConfigState.loading = false;
      qqbotConfigRequest = null;
      renderCurrentMainView();
    });

  return qqbotConfigRequest;
}
function normalizeIMWorkspaceBundleData(raw = {}) {
  const workspaceConfig = raw?.workspaceConfig || {};
  const channels = workspaceConfig?.channels && typeof workspaceConfig.channels === 'object'
    ? workspaceConfig.channels
    : {};
  return {
    workspaceConfig: {
      selectedChannel: typeof workspaceConfig.selectedChannel === 'string' && workspaceConfig.selectedChannel
        ? workspaceConfig.selectedChannel
        : 'qq',
      receptionistSessionId: typeof workspaceConfig.receptionistSessionId === 'string'
        ? workspaceConfig.receptionistSessionId
        : '',
      channels: {
        qq: {
          label: typeof channels?.qq?.label === 'string' ? channels.qq.label : '',
          note: typeof channels?.qq?.note === 'string' ? channels.qq.note : '',
        },
        weixin: {
          label: typeof channels?.weixin?.label === 'string' ? channels.weixin.label : '',
          note: typeof channels?.weixin?.note === 'string' ? channels.weixin.note : '',
        },
      },
      lines: Array.isArray(workspaceConfig.lines)
        ? workspaceConfig.lines.map(l => ({
            id: typeof l?.id === 'string' ? l.id : '',
            label: typeof l?.label === 'string' ? l.label : '',
            carrier: typeof l?.carrier === 'string' ? l.carrier : '',
            boundSession: l?.boundSession && typeof l.boundSession === 'object'
              ? { agentId: String(l.boundSession.agentId || ''), sessionId: String(l.boundSession.sessionId || '') }
              : null,
          }))
        : [
            { id: 'line1', label: '通道 1', carrier: '', boundSession: null },
            { id: 'line2', label: '通道 2', carrier: '', boundSession: null },
          ],
    },
    qqConfig: normalizeQQBotConfigData(raw?.qqConfig || {}),
    weixinConfig: {
      configured: !!raw?.weixinConfig?.configured,
      baseUrl: typeof raw?.weixinConfig?.baseUrl === 'string' ? raw.weixinConfig.baseUrl : '',
      loginTime: raw?.weixinConfig?.loginTime || null,
      sourcePath: typeof raw?.weixinConfig?.sourcePath === 'string' ? raw.weixinConfig.sourcePath : '',
    },
    binding: {
      pending: !!raw?.binding?.pending,
      status: typeof raw?.binding?.status === 'string' ? raw.binding.status : 'idle',
      qrcodeId: typeof raw?.binding?.qrcodeId === 'string' ? raw.binding.qrcodeId : '',
      qrcodeUrl: typeof raw?.binding?.qrcodeUrl === 'string' ? raw.binding.qrcodeUrl : '',
      qrcodeDataUrl: typeof raw?.binding?.qrcodeDataUrl === 'string' ? raw.binding.qrcodeDataUrl : '',
      error: typeof raw?.binding?.error === 'string' ? raw.binding.error : '',
      issuedAt: raw?.binding?.issuedAt || null,
      confirmedAt: raw?.binding?.confirmedAt || null,
      sourcePath: typeof raw?.binding?.sourcePath === 'string' ? raw.binding.sourcePath : '',
    },
    sessions: Array.isArray(raw?.sessions) ? raw.sessions.map((session) => ({
      id: typeof session?.id === 'string' ? session.id : '',
      title: typeof session?.title === 'string' ? session.title : (typeof session?.id === 'string' ? session.id : ''),
      updatedAt: session?.updatedAt || null,
    })).filter((session) => session.id) : [],
    receptionistSession: raw?.receptionistSession && typeof raw.receptionistSession === 'object'
      ? {
          id: typeof raw.receptionistSession.id === 'string' ? raw.receptionistSession.id : '',
          title: typeof raw.receptionistSession.title === 'string' ? raw.receptionistSession.title : '',
          updatedAt: raw.receptionistSession.updatedAt || null,
        }
      : null,
    connectableSessions: Array.isArray(raw?.connectableSessions)
      ? raw.connectableSessions.map(s => ({
          id: typeof s?.id === 'string' ? s.id : '',
          title: typeof s?.title === 'string' ? s.title : '',
          updatedAt: s?.updatedAt || null,
        })).filter(s => s.id)
      : [],
    qqSourcePath: typeof raw?.qqSourcePath === 'string' ? raw.qqSourcePath : '',
    workspaceSourcePath: typeof raw?.workspaceSourcePath === 'string' ? raw.workspaceSourcePath : '',
    savedAt: raw?.savedAt || null,
  };
}

function isIMWorkspaceConfigEditor(block) {
  return block?.configEditor?.type === 'im-workspace';
}

function getIMWorkspaceDraft() {
  return imWorkspaceState.draft || imWorkspaceState.data || normalizeIMWorkspaceBundleData();
}

async function ensureIMWorkspaceLoaded(force = false) {
  if (imWorkspaceRequest && !force) {
    return imWorkspaceRequest;
  }

  if (!force && imWorkspaceState.data && !imWorkspaceState.error) {
    return imWorkspaceState.data;
  }

  imWorkspaceState.loading = true;
  imWorkspaceState.error = '';
  if (force) {
    imWorkspaceState.data = null;
    imWorkspaceState.draft = null;
  }
  renderCurrentMainView();

  imWorkspaceRequest = fetch('/protoclaw/im_workspace_bundle')
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(await response.text().catch(() => 'Failed to load IM workspace config'));
      }
      return response.json();
    })
    .then((payload) => {
      const bundle = normalizeIMWorkspaceBundleData(payload || {});
      imWorkspaceState.data = bundle;
      imWorkspaceState.draft = JSON.parse(JSON.stringify(bundle));
      imWorkspaceState.savedAt = bundle.savedAt || null;
      imWorkspaceState.error = '';
      var schedPromise = Promise.resolve();
      if (!window._dispatchSchedulesLoaded && typeof window.loadDispatchSchedules === 'function') {
        // Await the actual fetch - loadDispatchSchedules resolves only after data is loaded
        schedPromise = window.loadDispatchSchedules().catch(() => {});
      } else if (typeof window.refreshDispatchConsoleData === 'function') {
        // Already loaded; fire-and-forget staleness refresh with render:true
        window.refreshDispatchConsoleData({ force: false, render: true }).catch(() => {});
      }
      return schedPromise.then(() => bundle);
    })
    .catch((error) => {
      imWorkspaceState.error = error && error.message ? error.message : String(error);
      throw error;
    })
    .finally(() => {
      imWorkspaceState.loading = false;
      imWorkspaceRequest = null;
      renderCurrentMainView();
    });

  return imWorkspaceRequest;
}
function renderQQBotConfigField(field, draft, updateHandler = 'window.updateQQBotConfigDraft') {
  const name = String(field?.name || '').trim();
  if (!name) return '';

  const label = localizeWorkspaceValue(field.label, name);
  const value = draft[name];

  if (field.type === 'checkbox') {
    return [
      '<label class="workspace-config-field checkbox">',
      '<span class="workspace-config-label">' + escapeHtml(label) + '</span>',
      '<span class="workspace-config-checkbox">',
      '<input type="checkbox" ' + (value ? 'checked ' : '') + 'onchange="' + updateHandler + '(&quot;' + escapeHtml(name) + '&quot;, this.checked)">',
      '<span>' + escapeHtml(label) + '</span>',
      '</span>',
      '</label>',
    ].join('');
  }

  return [
    '<label class="workspace-config-field">',
    '<span class="workspace-config-label">' + escapeHtml(label) + '</span>',
    '<input class="workspace-config-input" type="' + escapeHtml(field.type || 'text') + '" value="' + escapeHtml(String(value ?? '')) + '" oninput="' + updateHandler + '(&quot;' + escapeHtml(name) + '&quot;, this.value)">',
    '</label>',
  ].join('');
}

function renderIMWorkspaceTextField(label, value, onInput) {
  return [
    '<label class="workspace-config-field">',
    '<span class="workspace-config-label">' + escapeHtml(label) + '</span>',
    '<input class="workspace-config-input" type="text" value="' + escapeHtml(String(value ?? '')) + '" oninput="' + onInput + '">',
    '</label>',
  ].join('');
}

function renderIMWorkspaceSelectField(label, value, options, onChange) {
  const optionsHtml = options.map((option) => {
    const optionValue = String(option?.value ?? '');
    const optionLabel = String(option?.label ?? optionValue);
    const selected = String(value || '') === optionValue ? ' selected' : '';
    return '<option value="' + escapeHtml(optionValue) + '"' + selected + '>' + escapeHtml(optionLabel) + '</option>';
  }).join('');

  return [
    '<label class="workspace-config-field">',
    '<span class="workspace-config-label">' + escapeHtml(label) + '</span>',
    '<select class="workspace-form-select" onchange="' + onChange + '">',
    optionsHtml,
    '</select>',
    '</label>',
  ].join('');
}

function renderIMWorkspaceInlineSelect(value, options, onChange) {
  const hasIcons = options.some((o) => o.icon);

  if (!hasIcons) {
    const optionsHtml = options.map((option) => {
      const optionValue = String(option?.value ?? '');
      const optionLabel = String(option?.label ?? optionValue);
      const selected = String(value || '') === optionValue ? ' selected' : '';
      return '<option value="' + escapeHtml(optionValue) + '"' + selected + '>' + escapeHtml(optionLabel) + '</option>';
    }).join('');
    return '<select class="workspace-form-select im-inline-select" onchange="' + onChange + '">' + optionsHtml + '</select>';
  }

  // Custom dropdown with icons
  const itemsHtml = options.map((option) => {
    const optionValue = String(option?.value ?? '');
    const optionLabel = String(option?.label ?? optionValue);
    const isActive = String(value || '') === optionValue;
    return '<div class="im-dropdown-item' + (isActive ? ' active' : '') + '" data-value="' + escapeHtml(optionValue) + '" onclick="window.imSelectChannel(this, &quot;' + escapeHtml(optionValue) + '&quot;)">' + (option.icon || '') + '<span>' + escapeHtml(optionLabel) + '</span></div>';
  }).join('');

  const current = options.find((o) => String(o.value) === String(value || '')) || options[0];
  const currentLabel = String(current?.label ?? '');
  const currentIcon = current?.icon || '';

  return [
    '<div class="im-dropdown" data-onchange="' + escapeHtml(onChange) + '">',
    '<div class="im-dropdown-trigger" onclick="window.toggleIMDropdown(this)">',
    currentIcon + '<span>' + escapeHtml(currentLabel) + '</span>',
    '<svg class="im-dropdown-arrow" viewBox="0 0 12 12" fill="currentColor"><path d="M2 4l4 4 4-4"/></svg>',
    '</div>',
    '<div class="im-dropdown-menu">' + itemsHtml + '</div>',
    '</div>',
  ].join('');
}
function renderLineConnectionSection(draft) {
  const lines = draft.workspaceConfig?.lines || [];
  const sessions = draft.connectableSessions || [];
  const portalCarrier = draft.workspaceConfig?.selectedChannel || 'qq';

  const carrierIconMap = {
    qq: '<svg class="im-channel-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673.54.065 2.103-2.472 2.103-2.472 0 1.469.756 3.387 2.394 4.771-.612.188-1.363.479-1.845.835-.434.32-.379.646-.301.778.343.578 5.883.369 7.482.189 1.6.18 7.14.389 7.483-.189.078-.132.132-.458-.301-.778-.483-.356-1.233-.646-1.846-.836 1.637-1.384 2.393-3.302 2.393-4.771 0 0 1.563 2.537 2.103 2.472.251-.03.581-1.39-.438-4.673"/></svg>',
    weixin: '<svg class="im-channel-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z"/></svg>',
  };

  function renderLineDropdown(line, lineId, type, options, currentVal) {
    var hasIcons = options.some(function(o) { return !!o.icon; });
    var itemsHtml = options.map(function(opt) {
      var optVal = String(opt.value);
      var optLabel = String(opt.label);
      var isActive = String(currentVal) === optVal;
      return '<div class="im-dropdown-item' + (isActive ? ' active' : '') + '" data-value="' + escapeHtml(optVal) + '" onclick="window.imSelectLine(this, \'' + escapeHtml(type) + '\', \'' + escapeHtml(lineId) + '\')">' + (opt.icon || '') + '<span>' + escapeHtml(optLabel) + '</span></div>';
    }).join('');

    var current = options.find(function(o) { return String(o.value) === String(currentVal); }) || options[0];
    var currentLabel = String(current.label);
    var currentIcon = current.icon || '';

    return [
      '<div class="im-dropdown im-line-' + type + '">',
      '<div class="im-dropdown-trigger' + (type === 'session' && !line.carrier ? ' im-dropdown-disabled' : '') + '" onclick="window.toggleIMDropdown(this)">',
      currentIcon + '<span>' + escapeHtml(currentLabel) + '</span>',
      '<svg class="im-dropdown-arrow" viewBox="0 0 12 12" fill="currentColor"><path d="M2 4l4 4 4-4"/></svg>',
      '</div>',
      '<div class="im-dropdown-menu">' + itemsHtml + '</div>',
      '</div>',
    ].join('');
  }

  function renderLineRow(line) {
    var otherCarrier = lines.find(function(l) { return l.id !== line.id && l.carrier; });
    var otherCarrierValue = otherCarrier ? otherCarrier.carrier : '';
    var carrierOptions = [
      { value: '', label: '-- 未使用 --' },
      { value: 'qq', label: 'QQ', icon: carrierIconMap.qq },
      { value: 'weixin', label: '微信', icon: carrierIconMap.weixin },
    ].filter(function(o) {
      if (o.value === '') return true;
      if (o.value === line.carrier) return true;
      if (o.value === portalCarrier) return false;
      if (o.value === otherCarrierValue) return false;
      return true;
    });

    var hasCarrier = !!line.carrier;

    var sessionOptions = hasCarrier
      ? [{ value: '', label: '-- 未连接对话 --' }].concat(
          sessions.map(function(s) {
            return { value: s.id, label: s.title || s.id };
          })
        )
      : [{ value: '', label: '请先选择渠道' }];

    var statusHtml = line.boundSession
      ? '<span class="im-binding-status bound">已连接</span>'
      : hasCarrier
        ? '<span class="im-binding-status idle">已绑定渠道</span>'
        : '<span class="im-binding-status unbound">未使用</span>';

    var carrierDropdown = renderLineDropdown(
      line, line.id, 'carrier', carrierOptions, line.carrier || ''
    );

    var sessionDropdown = renderLineDropdown(
      line, line.id, 'session', sessionOptions, (line.boundSession && line.boundSession.sessionId) || ''
    );

    return [
      '<div class="im-line-row">',
      '<div class="im-line-row-header">',
      '<span class="im-line-label">' + escapeHtml(line.label || line.id) + '</span>',
      statusHtml,
      '</div>',
      '<div class="im-line-row-controls">',
      carrierDropdown,
      sessionDropdown,
      '</div>',
      '</div>',
    ].join('');
  }

  return [
    '<section class="workspace-section im-line-connection-section">',
    '<div class="workspace-section-header">',
    '<div>',
    '<div class="workspace-section-title">通道配置</div>',
    '<div class="workspace-section-desc">每个通道绑定一个 IM 渠道，并可连接到编程小助手的活跃对话。</div>',
    '</div>',
    '</div>',
    '<div class="im-line-grid">',
    ...lines.map(l => renderLineRow(l)),
    '</div>',
    '</section>',
  ].join('');
}

function renderIMWorkspaceConfigEditor(block) {
  const editor = block?.configEditor || {};
  const draft = getIMWorkspaceDraft();
  const selectedChannel = draft.workspaceConfig?.selectedChannel || 'qq';
  const qqConfigured = !!(draft.qqConfig?.appId && draft.qqConfig?.clientSecret);
  const weixinConfigured = !!draft.weixinConfig?.configured;
  const bindingStatus = draft.binding?.status || 'idle';
  const hasQrCode = !!draft.binding?.qrcodeDataUrl;
  const lineCarriers = new Set(
    (draft.workspaceConfig?.lines || []).map(function(l) { return l.carrier; }).filter(Boolean)
  );
  const receptionistOptions = [
    { value: 'qq', label: 'QQ', icon: '<svg class="im-channel-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673.54.065 2.103-2.472 2.103-2.472 0 1.469.756 3.387 2.394 4.771-.612.188-1.363.479-1.845.835-.434.32-.379.646-.301.778.343.578 5.883.369 7.482.189 1.6.18 7.14.389 7.483-.189.078-.132.132-.458-.301-.778-.483-.356-1.233-.646-1.846-.836 1.637-1.384 2.393-3.302 2.393-4.771 0 0 1.563 2.537 2.103 2.472.251-.03.581-1.39-.438-4.673"/></svg>' },
    { value: 'weixin', label: '微信', icon: '<svg class="im-channel-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z"/></svg>' },
  ].filter(function(o) {
    if (o.value === selectedChannel) return true;
    if (lineCarriers.has(o.value)) return false;
    return true;
  });
  const fields = Array.isArray(editor.fields) ? editor.fields : [];

  if (!imWorkspaceState.data && !imWorkspaceState.loading && !imWorkspaceState.error) {
    ensureIMWorkspaceLoaded().catch((error) => {
      console.error('Failed to load IM workspace config:', error);
    });
  }

  const weixinBadge = weixinConfigured
    ? t('im_workspace_bound')
    : bindingStatus === 'pending'
      ? t('im_workspace_pending')
      : bindingStatus === 'expired'
        ? t('im_workspace_expired')
        : t('im_workspace_not_bound');

  const weixinActionsHtml = (() => {
    const actions = [];
    const secondary = [];
    if (weixinConfigured) {
      secondary.push('<button class="workspace-action secondary" type="button" onclick="window.logoutWeixinBinding()">' + escapeHtml(t('im_workspace_logout_weixin')) + '</button>');
    }
    secondary.push('<button class="workspace-action secondary" type="button" onclick="window.refreshWeixinBinding()">' + escapeHtml(t('im_workspace_refresh_weixin_bind')) + '</button>');
    actions.push('<div class="im-card-action-row"><button class="workspace-action" type="button" onclick="window.startWeixinBinding()">' + escapeHtml(t('im_workspace_start_weixin_bind')) + '</button></div>');
    if (secondary.length) {
      actions.push('<div class="im-card-action-row">' + secondary.join('') + '</div>');
    }
    if (hasQrCode) {
      actions.push('<div class="im-workspace-qrcode-hint">' + escapeHtml(t('im_workspace_weixin_qrcode_hint')) + '</div>');
    }
    return actions.join('');
  })();

  const activeAgent = getCurrentAgentRecord();
  const sessionsHtml = draft.sessions.length > 0
    ? '<div class="workspace-history-list">' + draft.sessions.map((session) => {
        const isActive = String(draft.workspaceConfig?.receptionistSessionId || '') === String(session.id);
        const openAction = escapeHtml(JSON.stringify({ type: 'open_session', sessionId: session.id }));
        const deleteAction = escapeHtml(JSON.stringify({ type: 'delete_session', sessionId: session.id }));
        return [
          '<div class="workspace-history-item' + (isActive ? ' active' : '') + '" data-prebuilt-session-agent-id="' + escapeHtml(activeAgent?.id || '') + '" data-prebuilt-session-id="' + escapeHtml(session.id) + '">',
          '<div class="workspace-history-main">',
          '<div class="workspace-history-title-row">',
          '<div class="workspace-history-title">' + escapeHtml(session.title || session.id) + '</div>',
          (isActive ? '<span class="workspace-history-active">当前</span>' : ''),
          '</div>',
          '<div class="workspace-history-meta">' + escapeHtml(session.updatedAt ? formatWorkspaceDate(session.updatedAt) : session.id) + '</div>',
          '</div>',
          '<div class="workspace-history-side">',
          '<div class="workspace-actions stacked">',
          '<button class="workspace-action" type="button" data-workspace-action="' + openAction + '" onclick="window.launchReceptionistSession(&quot;' + escapeHtml(session.id) + '&quot;, this)">' + escapeHtml(t('workspace_open_chat')) + '</button>',
          '<button class="workspace-action secondary delete-trigger" type="button" data-workspace-action="' + deleteAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + escapeHtml(t('workspace_session_delete')) + '</button>',
          '</div>',
          '</div>',
          '</div>',
        ].join('');
      }).join('') + '</div>'
    : '<div class="workspace-form-note">' + escapeHtml(t('im_workspace_no_session')) + '</div>';

  const isZh = currentLanguage === 'zh';

  // Fire a background staleness refresh (no render:true — the checkbox uses
  // whatever data is already available and never blocks on this fetch).
  if (typeof window.refreshDispatchConsoleData === 'function') {
    window.refreshDispatchConsoleData({ force: false, render: false }).then(function(changed) {
      if (changed) { renderCurrentMainView(); }
    }).catch(function() {});
  }

  var autostartSchedules = (window._dispatchSchedules || []).filter(function(sc) {
    return sc.trigger?.type === 'on-boot'
      && sc.action?.type === 'start_agent'
      && sc.targetAgentId === 'qqbot'
      && sc.status === 'pending';
  });
  var autostartChecked = autostartSchedules.length > 0;
  var autostartCheckboxHtml = '<label class="workspace-config-field checkbox im-portal-autostart">'
    + '<span class="workspace-config-label">' + (isZh ? 'Claw 启动时自启' : 'Auto-start with Claw') + '</span>'
    + '<span class="workspace-config-checkbox">'
    + '<input type="checkbox" ' + (autostartChecked ? 'checked ' : '')
    + 'data-autostart-schedule-id="' + (autostartSchedules[0]?.id || '') + '" '
    + 'onchange="window.togglePortalAgentAutostart(this.checked, this.dataset.autostartScheduleId)">'
    + '<span>' + (isZh ? '自启' : 'Auto-start') + '</span>'
    + '</span></label>';

  return [
    '<div class="im-dual-layout">',
    '<section class="workspace-section im-portal-card">',
    '<div class="workspace-section-header">',
    '<div>',
    '<div class="workspace-section-title">' + (isZh ? '门户代理' : 'Portal Agent') + '</div>',
    '<div class="workspace-section-desc">' + (isZh ? '选择渠道并创建或进入对话' : 'Select channel and start or enter a conversation') + '</div>',
    '</div>',
    '</div>',
    '<div class="im-portal-body">',
    '<div class="im-portal-field">',
    '<span class="im-portal-label">' + (isZh ? '当前渠道' : 'Channel') + '</span>',
    renderIMWorkspaceInlineSelect(
      selectedChannel,
      receptionistOptions,
      'window.updateIMWorkspaceField(&quot;workspaceConfig.selectedChannel&quot;, this.value)',
    ),
    '</div>',
    autostartCheckboxHtml,
    '<button class="workspace-action im-new-chat-btn' + (window._creatingReceptionistSession ? ' action-loading' : '') + '" type="button" onclick="window.createReceptionistSession(this)">' + escapeHtml(t('im_workspace_new_chat')) + '</button>',
    '</div>',
    '</section>',
    renderLineConnectionSection(draft),
    '</div>',
    '<section class="workspace-section">',
    '<div class="workspace-section-header">',
    '<div>',
    '<div class="workspace-section-title">' + (isZh ? '门户对话记录' : 'Portal Sessions') + '</div>',
    '<div class="workspace-section-desc">' + (isZh ? '门户代理的历史对话' : 'Portal agent conversation history') + '</div>',
    '</div>',
    '</div>',
    sessionsHtml,
    '</section>',
    renderIMChannelConfigDialog(draft, fields, qqConfigured, weixinConfigured, weixinBadge, weixinActionsHtml),
  ].join('');
}

function renderIMChannelConfigDialog(draft, fields, qqConfigured, weixinConfigured, weixinBadge, weixinActionsHtml) {
  if (!window._imChannelConfigOpen) return '';
  const isZh = currentLanguage === 'zh';
  const hasQrCode = !!draft.binding?.qrcodeDataUrl;

  // ── Detail view ──
  if (window._imChannelDetailId) {
    const ch = window._imChannelDetailId;
    const isQQ = ch === 'qq';
    const isWeixin = ch === 'weixin';
    const title = isQQ ? (isZh ? 'QQ 机器人配置' : 'QQ Bot Config')
      : isWeixin ? (isZh ? '微信配置' : 'WeChat Config') : ch;

    let bodyHtml = '';
    if (isQQ) {
      bodyHtml = '<div class="workspace-config-grid">'
        + fields.map((field) => renderQQBotConfigField(field, draft.qqConfig || {}, 'window.updateIMQQConfigDraft')).join('')
        + '</div>';
    } else if (isWeixin) {
      bodyHtml = weixinActionsHtml || '';
      if (hasQrCode) {
        bodyHtml += '<div class="im-qrcode-inline">'
          + '<div class="im-qrcode-inline-img"><img src="' + escapeHtml(draft.binding.qrcodeDataUrl) + '" alt="Weixin QR"></div>'
          + '<div class="im-qrcode-inline-hint">' + escapeHtml(t('im_workspace_weixin_qrcode_hint')) + '</div>'
          + '</div>';
      }
    }

    return [
      '<div class="feature-detail-overlay" onclick="window.closeIMChannelConfig()">',
      '<div class="feature-detail-window" style="max-width:480px;" onclick="event.stopPropagation()">',
      '<div class="feature-detail-head">',
      '<div>',
      '<div class="feature-detail-title">' + escapeHtml(title) + '</div>',
      '<div class="feature-detail-subtitle">' + (isQQ ? (isZh ? '配置 QQ 机器人账号信息' : 'Configure QQ bot credentials') : isZh ? '配置微信账号绑定与扫码登录' : 'Configure WeChat binding & QR login') + '</div>',
      '</div>',
      '<button class="feature-detail-close" type="button" onclick="window.closeIMChannelDetail()">×</button>',
      '</div>',
      '<div class="ph-mc-body">',
      bodyHtml,
      '</div>',
      '</div>',
      '</div>',
    ].join('');
  }

  // ── Channel list view ──
  const channels = [
    {
      id: 'qq',
      icon: '<svg class="im-ch-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673.54.065 2.103-2.472 2.103-2.472 0 1.469.756 3.387 2.394 4.771-.612.188-1.363.479-1.845.835-.434.32-.379.646-.301.778.343.578 5.883.369 7.482.189 1.6.18 7.14.389 7.483-.189.078-.132.132-.458-.301-.778-.483-.356-1.233-.646-1.846-.836 1.637-1.384 2.393-3.302 2.393-4.771 0 0 1.563 2.537 2.103 2.472.251-.03.581-1.39-.438-4.673"/></svg>',
      name: isZh ? 'QQ' : 'QQ',
      desc: isZh ? 'QQ 机器人账号信息与消息收发' : 'QQ bot credentials & messaging',
      configured: qqConfigured,
      badgeText: qqConfigured ? (isZh ? '已配置' : 'Ready') : (isZh ? '未完成' : 'Incomplete'),
    },
    {
      id: 'weixin',
      icon: '<svg class="im-ch-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z"/></svg>',
      name: isZh ? '微信' : 'WeChat',
      desc: isZh ? '微信账号绑定与扫码登录' : 'WeChat binding & QR login',
      configured: weixinConfigured,
      badgeText: weixinBadge,
    },
  ];

  const rows = channels.map(ch => {
    return '<div class="ph-mc-row im-ch-row" onclick="window.openIMChannelDetail(\'' + ch.id + '\')">'
      + '<div class="im-ch-info">'
      + '<div class="im-ch-icon-wrap">' + ch.icon + '</div>'
      + '<div class="im-ch-text"><div class="im-ch-name">' + escapeHtml(ch.name) + '</div><div class="im-ch-desc">' + escapeHtml(ch.desc) + '</div></div>'
      + '</div>'
      + '<span class="workspace-config-badge ' + (ch.configured ? 'ready' : 'warn') + '">' + escapeHtml(ch.badgeText) + '</span>'
      + '</div>';
  }).join('');

  return [
    '<div class="feature-detail-overlay" onclick="window.closeIMChannelConfig()">',
    '<div class="feature-detail-window" style="max-width:520px;" onclick="event.stopPropagation()">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + (isZh ? '渠道配置' : 'Channel Config') + '</div>',
    '<div class="feature-detail-subtitle">' + (isZh ? '选择一个渠道查看或修改配置' : 'Select a channel to view or edit config') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" onclick="window.closeIMChannelConfig()">×</button>',
    '</div>',
    '<div class="ph-mc-body">',
    rows,
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}

function renderWeixinQrCodeDialog() {
  if (!imWorkspaceState.weixinQrDialogOpen) return '';
  const draft = getIMWorkspaceDraft();
  const hasQrCode = !!draft.binding?.qrcodeDataUrl;
  if (!hasQrCode) return '';
  return [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window" style="width:min(100%,420px);">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + escapeHtml(t('im_workspace_weixin_qrcode_dialog_title')) + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(t('im_workspace_weixin_qrcode_dialog_desc')) + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" onclick="window.closeWeixinQrCodeDialog()">×</button>',
    '</div>',
    '<div class="im-qrcode-dialog-body">',
    '<div class="im-qrcode-dialog-img-wrap">',
    '<img src="' + escapeHtml(draft.binding.qrcodeDataUrl) + '" alt="Weixin QR code">',
    '</div>',
    '<div class="im-qrcode-dialog-hint">' + escapeHtml(t('im_workspace_weixin_qrcode_hint')) + '</div>',
    '<div class="workspace-actions" style="justify-content:center;">',
    '<button class="workspace-action" type="button" onclick="window.refreshWeixinBinding()">' + escapeHtml(t('im_workspace_refresh_weixin_bind')) + '</button>',
    '</div>',
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}

// ── End IM Channel Management UI ──────────────────────────────────
