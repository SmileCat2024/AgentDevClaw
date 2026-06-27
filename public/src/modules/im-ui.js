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
        feishu: {
          label: typeof channels?.feishu?.label === 'string' ? channels.feishu.label : '',
          note: typeof channels?.feishu?.note === 'string' ? channels.feishu.note : '',
        },
        wecom: {
          label: typeof channels?.wecom?.label === 'string' ? channels.wecom.label : '',
          note: typeof channels?.wecom?.note === 'string' ? channels.wecom.note : '',
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
    feishuConfig: {
      configured: !!raw?.feishuConfig?.configured,
      appId: typeof raw?.feishuConfig?.appId === 'string' ? raw.feishuConfig.appId : '',
      appSecret: typeof raw?.feishuConfig?.appSecret === 'string' ? raw.feishuConfig.appSecret : '',
      sourcePath: typeof raw?.feishuConfig?.sourcePath === 'string' ? raw.feishuConfig.sourcePath : '',
    },
    wecomConfig: {
      configured: !!raw?.wecomConfig?.configured,
      botId: typeof raw?.wecomConfig?.botId === 'string' ? raw.wecomConfig.botId : '',
      secret: typeof raw?.wecomConfig?.secret === 'string' ? raw.wecomConfig.secret : '',
      sourcePath: typeof raw?.wecomConfig?.sourcePath === 'string' ? raw.wecomConfig.sourcePath : '',
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
    feishu: '<svg class="im-channel-icon" xmlns="http://www.w3.org/2000/svg" viewBox="62.16 94.5 407.87 324.19"><path d="M274.18 264.785q.515-.517 1.03-1.027c.685-.688 1.372-1.258 2.056-1.945l1.37-1.372 4.118-4.113 5.598-5.601 4.8-4.797 4.575-4.457 4.796-4.688 4.344-4.344 6.059-6.054c1.14-1.145 2.285-2.29 3.543-3.317 2.168-2.054 4.457-4 6.855-5.828 2.172-1.715 4.344-3.312 6.516-4.914 3.082-2.172 6.398-4.344 9.71-6.285 3.204-1.941 6.63-3.656 10.06-5.371 3.199-1.602 6.515-2.973 9.827-4.23 1.829-.684 3.774-1.372 5.602-2.055.914-.344 1.941-.688 2.856-.914-8.57-33.715-24.227-64.575-45.258-90.86-4.114-5.14-10.399-8.113-17.028-8.113H130.754c-3.203 0-4.457 4-1.945 5.941 59.543 43.66 109.144 99.887 145.03 164.801 0-.226.227-.34.34-.457m0 0" style="fill:currentColor;"/><path d="M204.79 418.691c90.288 0 169.03-49.828 210.058-123.543 1.488-2.628 2.859-5.257 4.23-7.882q-3.087 6-6.86 11.312l-2.741 3.77c-1.141 1.488-2.399 2.972-3.657 4.457-1.03 1.144-2.058 2.285-3.086 3.316-2.058 2.172-4.343 4.227-6.629 6.172a53 53 0 0 1-3.886 3.2c-1.598 1.144-3.086 2.284-4.684 3.429-1.031.683-2.058 1.371-3.086 1.941-1.144.684-2.172 1.258-3.316 1.942a131 131 0 0 1-6.969 3.543c-2.059.918-4.117 1.828-6.289 2.515-2.285.801-4.57 1.602-6.969 2.285-3.543.914-7.086 1.715-10.742 2.286-2.629.457-5.258.687-8 .914-2.86.23-5.601.23-8.457.23-3.086 0-6.289-.23-9.488-.57a83 83 0 0 1-7.086-1.031c-2.055-.34-4.113-.801-6.168-1.258-1.031-.227-2.176-.57-3.203-.797-2.973-.8-6.055-1.602-9.028-2.516-1.488-.457-2.972-.914-4.457-1.258-2.172-.683-4.457-1.37-6.629-2.058-1.828-.57-3.656-1.14-5.37-1.711q-2.573-.86-5.145-1.715c-1.14-.344-2.285-.8-3.543-1.144-1.371-.457-2.856-1.028-4.227-1.485-1.027-.344-2.058-.687-2.972-1.027-1.942-.688-4-1.488-5.942-2.172-1.144-.457-2.285-.914-3.43-1.258-1.484-.57-3.085-1.144-4.57-1.828-1.601-.687-3.203-1.258-4.8-1.945-1.028-.457-2.06-.797-3.087-1.258-1.257-.57-2.628-1.027-3.886-1.598-1.028-.457-1.942-.8-2.969-1.258l-3.086-1.37c-.914-.344-1.832-.801-2.746-1.145a44 44 0 0 1-2.512-1.14c-.8-.345-1.715-.802-2.515-1.145-.914-.344-1.715-.801-2.512-1.141-1.031-.457-2.172-1.031-3.203-1.484-1.14-.575-2.285-1.032-3.426-1.602-1.258-.574-2.402-1.144-3.66-1.715-1.027-.457-2.055-1.027-3.082-1.484-54.172-26.973-102.172-63.086-143.09-106.746-2.055-2.172-5.71-.684-5.71 2.289l.112 154.398v12.57c0 7.317 3.543 14.06 9.598 18.172 38.172 24.801 83.773 39.543 132.914 39.543m0 0" style="fill:currentColor;"/><path d="M414.84 295.188c0 .113-.113.113-.113.226zl.8-1.489c-.343.457-.574 1.028-.8 1.488m3.793-7.05.226-.457.114-.23q-.17.513-.34.687m0 0" style="fill:currentColor;"/><path d="M470.035 201.121c-18.285-9.031-38.86-14.059-60.687-14.059-12.914 0-25.485 1.829-37.371 5.141-1.372.344-2.743.8-4.114 1.258-.914.344-1.941.574-2.855.914-1.945.688-3.774 1.375-5.602 2.059-3.316 1.257-6.629 2.742-9.828 4.23-3.43 1.598-6.742 3.426-10.058 5.371a128 128 0 0 0-9.715 6.285c-2.285 1.602-4.457 3.2-6.512 4.914a154 154 0 0 0-6.86 5.828c-1.14 1.141-2.398 2.172-3.542 3.313l-6.055 6.059-4.344 4.343-4.8 4.684-4.57 4.46-4.802 4.798-11.086 11.086c-.687.687-1.37 1.37-2.058 1.945l-1.028 1.027c-.457.457-1.027 1.028-1.601 1.485-.57.57-1.14 1.031-1.711 1.601a244.4 244.4 0 0 1-49.828 35.313c1.027.457 2.168 1.027 3.199 1.488.8.34 1.715.797 2.512 1.14.8.344 1.715.801 2.515 1.145.801.344 1.602.684 2.516 1.14.914.345 1.828.802 2.742 1.145l3.086 1.371c1.027.457 1.942.801 2.969 1.258 1.258.57 2.629 1.028 3.887 1.598 1.03.46 2.058.8 3.086 1.258 1.601.687 3.199 1.258 4.8 1.945 1.485.57 3.086 1.14 4.57 1.828 1.145.457 2.286.914 3.43 1.258 1.946.684 4 1.484 5.946 2.172a81 81 0 0 1 2.968 1.027c1.371.457 2.856 1.028 4.23 1.485 1.141.343 2.286.8 3.544 1.14q2.567.86 5.14 1.719c1.829.57 3.657 1.14 5.372 1.71 2.171.688 4.457 1.376 6.628 2.06 1.489.457 2.973.914 4.457 1.257 2.973.914 5.942 1.715 9.032 2.512 1.027.344 2.168.574 3.199.8 2.055.458 4.113.915 6.172 1.259 2.398.457 4.683.8 7.082 1.03 3.203.34 6.402.571 9.488.571 2.856 0 5.715 0 8.457-.23 2.63-.227 5.371-.457 8-.914 3.656-.57 7.2-1.371 10.742-2.286 2.399-.683 4.688-1.37 6.973-2.285 2.172-.8 4.227-1.601 6.285-2.515 2.399-1.028 4.684-2.285 6.973-3.543 1.14-.57 2.168-1.258 3.312-1.942 1.028-.687 2.059-1.257 3.086-1.945 1.602-1.027 3.2-2.168 4.684-3.426a52 52 0 0 0 3.887-3.203c2.289-1.941 4.457-4 6.628-6.168 1.032-1.031 2.06-2.172 3.086-3.316 1.258-1.485 2.516-2.969 3.657-4.457.918-1.258 1.828-2.512 2.742-3.77 2.515-3.543 4.8-7.316 6.86-11.199l2.284-4.688 21.145-42.171v.113c6.742-14.742 16.226-28.113 27.656-39.426m0 0" style="fill:currentColor;"/></svg>',
    wecom: '<svg class="im-channel-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"> <path d="M0 0h24v24H0z" fill="none" /> <path fill="currentColor" d="m17.326 8.158l-.003-.007a6.6 6.6 0 0 0-1.178-1.674c-1.266-1.307-3.067-2.19-5.102-2.417a9.3 9.3 0 0 0-2.124 0h-.001c-2.061.228-3.882 1.107-5.14 2.405a6.7 6.7 0 0 0-1.194 1.682A5.7 5.7 0 0 0 2 10.657c0 1.106.332 2.218.988 3.201l.006.01c.391.594 1.092 1.39 1.637 1.83l.983.793l-.208.875l.527-.267l.708-.358l.761.225c.467.137.955.227 1.517.29h.005q.515.06 1.026.059c.355 0 .724-.02 1.095-.06a9 9 0 0 0 1.346-.258c.095.7.43 1.337.932 1.81c-.658.208-1.352.358-2.061.436c-.442.048-.883.072-1.312.072q-.627 0-1.253-.072a10.7 10.7 0 0 1-1.861-.36l-2.84 1.438s-.29.131-.44.131c-.418 0-.702-.285-.702-.704c0-.252.067-.598.128-.84l.394-1.653c-.728-.586-1.563-1.544-2.052-2.287A7.76 7.76 0 0 1 0 10.658a7.7 7.7 0 0 1 .787-3.39a8.7 8.7 0 0 1 1.551-2.19c1.61-1.665 3.878-2.73 6.359-3.006a11.3 11.3 0 0 1 2.565 0c2.47.275 4.712 1.353 6.323 3.017a8.6 8.6 0 0 1 1.539 2.192c.466.945.769 1.937.769 2.978a3.06 3.06 0 0 0-2-.005c-.001-.644-.189-1.329-.564-2.09zm4.125 6.977l-.024-.024l-.024-.018l-.024-.018l-.096-.095a4.24 4.24 0 0 1-1.169-2.192q0-.038-.006-.075l-.006-.056l-.035-.144a1.3 1.3 0 0 0-.358-.61a1.386 1.386 0 0 0-1.957 0a1.4 1.4 0 0 0 0 1.963c.191.191.418.311.668.371c.024.012.06.012.084.012q.019 0 .041.006q.023.005.042.006a4.24 4.24 0 0 1 2.231 1.186c.048.048.096.095.131.143a.323.323 0 0 0 .466 0a.35.35 0 0 0 .036-.455m-1.05 4.37l-.025.025c-.119.096-.31.096-.453-.036a.326.326 0 0 1 0-.467c.047-.036.094-.083.141-.13l.002-.002a4.27 4.27 0 0 0 1.187-2.28q.005-.024.006-.043c0-.024 0-.06.012-.084a1.386 1.386 0 0 1 2.326-.67a1.4 1.4 0 0 1 0 1.964c-.167.18-.382.299-.608.359l-.143.036l-.057.005q-.035.006-.075.007a4.2 4.2 0 0 0-2.183 1.173l-.095.096q-.009.01-.018.024t-.018.024m-4.392-1.053l.024.024l.024.018q.015.009.024.018l.096.096a4.25 4.25 0 0 1 1.169 2.19q0 .04.006.076q.005.03.006.057l.035.143c.06.228.18.443.358.611c.537.539 1.42.539 1.957 0a1.4 1.4 0 0 0 0-1.964a1.4 1.4 0 0 0-.668-.371c-.024-.012-.06-.012-.084-.012q-.018 0-.041-.006l-.042-.006a4.25 4.25 0 0 1-2.231-1.185a1.4 1.4 0 0 1-.131-.144a.323.323 0 0 0-.466 0a.325.325 0 0 0-.036.455m1.039-4.358l.024-.024a.32.32 0 0 1 .453.035a.326.326 0 0 1 0 .467c-.047.036-.094.083-.141.13l-.002.002a4.27 4.27 0 0 0-1.187 2.281l-.006.042c0 .024 0 .06-.012.084a1.386 1.386 0 0 1-2.326.67a1.4 1.4 0 0 1 0-1.963c.166-.18.381-.3.608-.36l.143-.035q.026 0 .056-.006q.037-.005.075-.006a4.2 4.2 0 0 0 2.183-1.174l.096-.095l.018-.025z" /> </svg>',
    dingtalk: '<svg class="im-channel-icon" fill="currentColor" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"> <path d="M573.7 252.5C422.5 197.4 201.3 96.7 201.3 96.7c-15.7-4.1-17.9 11.1-17.9 11.1-5 61.1 33.6 160.5 53.6 182.8 19.9 22.3 319.1 113.7 319.1 113.7S326 357.9 270.5 341.9c-55.6-16-37.9 17.8-37.9 17.8 11.4 61.7 64.9 131.8 107.2 138.4 42.2 6.6 220.1 4 220.1 4s-35.5 4.1-93.2 11.9c-42.7 5.8-97 12.5-111.1 17.8-33.1 12.5 24 62.6 24 62.6 84.7 76.8 129.7 50.5 129.7 50.5 33.3-10.7 61.4-18.5 85.2-24.2L565 743.1h84.6L603 928l205.3-271.9H700.8l22.3-38.7c.3.5.4.8.4.8S799.8 496.1 829 433.8l.6-1h-.1c5-10.8 8.6-19.7 10-25.8 17-71.3-114.5-99.4-265.8-154.5z"/> </svg>'
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

    // Preserve open state across re-renders (e.g. after background bundle refresh)
    var dropdownKey = lineId + ':' + type;
    var shouldOpen = window._imOpenDropdownKey === dropdownKey;

    return [
      '<div class="im-dropdown im-line-' + type + (shouldOpen ? ' open' : '') + '" data-line-id="' + escapeHtml(lineId) + '" data-dropdown-type="' + escapeHtml(type) + '">',
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
      { value: 'qq', label: 'QQ', icon: '<svg class="im-channel-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673.54.065 2.103-2.472 2.103-2.472 0 1.469.756 3.387 2.394 4.771-.612.188-1.363.479-1.845.835-.434.32-.379.646-.301.778.343.578 5.883.369 7.482.189 1.6.18 7.14.389 7.483-.189.078-.132.132-.458-.301-.778-.483-.356-1.233-.646-1.846-.836 1.637-1.384 2.393-3.302 2.393-4.771 0 0 1.563 2.537 2.103 2.472.251-.03.581-1.39-.438-4.673"/></svg>' },
      { value: 'weixin', label: '微信', icon: '<svg class="im-channel-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z"/></svg>' },
      { value: 'feishu', label: '飞书', icon: '<svg class="im-channel-icon" xmlns="http://www.w3.org/2000/svg" viewBox="62.16 94.5 407.87 324.19"><path d="M274.18 264.785q.515-.517 1.03-1.027c.685-.688 1.372-1.258 2.056-1.945l1.37-1.372 4.118-4.113 5.598-5.601 4.8-4.797 4.575-4.457 4.796-4.688 4.344-4.344 6.059-6.054c1.14-1.145 2.285-2.29 3.543-3.317 2.168-2.054 4.457-4 6.855-5.828 2.172-1.715 4.344-3.312 6.516-4.914 3.082-2.172 6.398-4.344 9.71-6.285 3.204-1.941 6.63-3.656 10.06-5.371 3.199-1.602 6.515-2.973 9.827-4.23 1.829-.684 3.774-1.372 5.602-2.055.914-.344 1.941-.688 2.856-.914-8.57-33.715-24.227-64.575-45.258-90.86-4.114-5.14-10.399-8.113-17.028-8.113H130.754c-3.203 0-4.457 4-1.945 5.941 59.543 43.66 109.144 99.887 145.03 164.801 0-.226.227-.34.34-.457m0 0" style="fill:currentColor;"/><path d="M204.79 418.691c90.288 0 169.03-49.828 210.058-123.543 1.488-2.628 2.859-5.257 4.23-7.882q-3.087 6-6.86 11.312l-2.741 3.77c-1.141 1.488-2.399 2.972-3.657 4.457-1.03 1.144-2.058 2.285-3.086 3.316-2.058 2.172-4.343 4.227-6.629 6.172a53 53 0 0 1-3.886 3.2c-1.598 1.144-3.086 2.284-4.684 3.429-1.031.683-2.058 1.371-3.086 1.941-1.144.684-2.172 1.258-3.316 1.942a131 131 0 0 1-6.969 3.543c-2.059.918-4.117 1.828-6.289 2.515-2.285.801-4.57 1.602-6.969 2.285-3.543.914-7.086 1.715-10.742 2.286-2.629.457-5.258.687-8 .914-2.86.23-5.601.23-8.457.23-3.086 0-6.289-.23-9.488-.57a83 83 0 0 1-7.086-1.031c-2.055-.34-4.113-.801-6.168-1.258-1.031-.227-2.176-.57-3.203-.797-2.973-.8-6.055-1.602-9.028-2.516-1.488-.457-2.972-.914-4.457-1.258-2.172-.683-4.457-1.37-6.629-2.058-1.828-.57-3.656-1.14-5.37-1.711q-2.573-.86-5.145-1.715c-1.14-.344-2.285-.8-3.543-1.144-1.371-.457-2.856-1.028-4.227-1.485-1.027-.344-2.058-.687-2.972-1.027-1.942-.688-4-1.488-5.942-2.172-1.144-.457-2.285-.914-3.43-1.258-1.484-.57-3.085-1.144-4.57-1.828-1.601-.687-3.203-1.258-4.8-1.945-1.028-.457-2.06-.797-3.087-1.258-1.257-.57-2.628-1.027-3.886-1.598-1.028-.457-1.942-.8-2.969-1.258l-3.086-1.37c-.914-.344-1.832-.801-2.746-1.145a44 44 0 0 1-2.512-1.14c-.8-.345-1.715-.802-2.515-1.145-.914-.344-1.715-.801-2.512-1.141-1.031-.457-2.172-1.031-3.203-1.484-1.14-.575-2.285-1.032-3.426-1.602-1.258-.574-2.402-1.144-3.66-1.715-1.027-.457-2.055-1.027-3.082-1.484-54.172-26.973-102.172-63.086-143.09-106.746-2.055-2.172-5.71-.684-5.71 2.289l.112 154.398v12.57c0 7.317 3.543 14.06 9.598 18.172 38.172 24.801 83.773 39.543 132.914 39.543m0 0" style="fill:currentColor;"/><path d="M414.84 295.188c0 .113-.113.113-.113.226zl.8-1.489c-.343.457-.574 1.028-.8 1.488m3.793-7.05.226-.457.114-.23q-.17.513-.34.687m0 0" style="fill:currentColor;"/><path d="M470.035 201.121c-18.285-9.031-38.86-14.059-60.687-14.059-12.914 0-25.485 1.829-37.371 5.141-1.372.344-2.743.8-4.114 1.258-.914.344-1.941.574-2.855.914-1.945.688-3.774 1.375-5.602 2.059-3.316 1.257-6.629 2.742-9.828 4.23-3.43 1.598-6.742 3.426-10.058 5.371a128 128 0 0 0-9.715 6.285c-2.285 1.602-4.457 3.2-6.512 4.914a154 154 0 0 0-6.86 5.828c-1.14 1.141-2.398 2.172-3.542 3.313l-6.055 6.059-4.344 4.343-4.8 4.684-4.57 4.46-4.802 4.798-11.086 11.086c-.687.687-1.37 1.37-2.058 1.945l-1.028 1.027c-.457.457-1.027 1.028-1.601 1.485-.57.57-1.14 1.031-1.711 1.601a244.4 244.4 0 0 1-49.828 35.313c1.027.457 2.168 1.027 3.199 1.488.8.34 1.715.797 2.512 1.14.8.344 1.715.801 2.515 1.145.801.344 1.602.684 2.516 1.14.914.345 1.828.802 2.742 1.145l3.086 1.371c1.027.457 1.942.801 2.969 1.258 1.258.57 2.629 1.028 3.887 1.598 1.03.46 2.058.8 3.086 1.258 1.601.687 3.199 1.258 4.8 1.945 1.485.57 3.086 1.14 4.57 1.828 1.145.457 2.286.914 3.43 1.258 1.946.684 4 1.484 5.946 2.172a81 81 0 0 1 2.968 1.027c1.371.457 2.856 1.028 4.23 1.485 1.141.343 2.286.8 3.544 1.14q2.567.86 5.14 1.719c1.829.57 3.657 1.14 5.372 1.71 2.171.688 4.457 1.376 6.628 2.06 1.489.457 2.973.914 4.457 1.257 2.973.914 5.942 1.715 9.032 2.512 1.027.344 2.168.574 3.199.8 2.055.458 4.113.915 6.172 1.259 2.398.457 4.683.8 7.082 1.03 3.203.34 6.402.571 9.488.571 2.856 0 5.715 0 8.457-.23 2.63-.227 5.371-.457 8-.914 3.656-.57 7.2-1.371 10.742-2.286 2.399-.683 4.688-1.37 6.973-2.285 2.172-.8 4.227-1.601 6.285-2.515 2.399-1.028 4.684-2.285 6.973-3.543 1.14-.57 2.168-1.258 3.312-1.942 1.028-.687 2.059-1.257 3.086-1.945 1.602-1.027 3.2-2.168 4.684-3.426a52 52 0 0 0 3.887-3.203c2.289-1.941 4.457-4 6.628-6.168 1.032-1.031 2.06-2.172 3.086-3.316 1.258-1.485 2.516-2.969 3.657-4.457.918-1.258 1.828-2.512 2.742-3.77 2.515-3.543 4.8-7.316 6.86-11.199l2.284-4.688 21.145-42.171v.113c6.742-14.742 16.226-28.113 27.656-39.426m0 0" style="fill:currentColor;"/></svg>' },
      { value: 'wecom', label: '企业微信', icon: '<svg class="im-channel-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"> <path d="M0 0h24v24H0z" fill="none" /> <path fill="currentColor" d="m17.326 8.158l-.003-.007a6.6 6.6 0 0 0-1.178-1.674c-1.266-1.307-3.067-2.19-5.102-2.417a9.3 9.3 0 0 0-2.124 0h-.001c-2.061.228-3.882 1.107-5.14 2.405a6.7 6.7 0 0 0-1.194 1.682A5.7 5.7 0 0 0 2 10.657c0 1.106.332 2.218.988 3.201l.006.01c.391.594 1.092 1.39 1.637 1.83l.983.793l-.208.875l.527-.267l.708-.358l.761.225c.467.137.955.227 1.517.29h.005q.515.06 1.026.059c.355 0 .724-.02 1.095-.06a9 9 0 0 0 1.346-.258c.095.7.43 1.337.932 1.81c-.658.208-1.352.358-2.061.436c-.442.048-.883.072-1.312.072q-.627 0-1.253-.072a10.7 10.7 0 0 1-1.861-.36l-2.84 1.438s-.29.131-.44.131c-.418 0-.702-.285-.702-.704c0-.252.067-.598.128-.84l.394-1.653c-.728-.586-1.563-1.544-2.052-2.287A7.76 7.76 0 0 1 0 10.658a7.7 7.7 0 0 1 .787-3.39a8.7 8.7 0 0 1 1.551-2.19c1.61-1.665 3.878-2.73 6.359-3.006a11.3 11.3 0 0 1 2.565 0c2.47.275 4.712 1.353 6.323 3.017a8.6 8.6 0 0 1 1.539 2.192c.466.945.769 1.937.769 2.978a3.06 3.06 0 0 0-2-.005c-.001-.644-.189-1.329-.564-2.09zm4.125 6.977l-.024-.024l-.024-.018l-.024-.018l-.096-.095a4.24 4.24 0 0 1-1.169-2.192q0-.038-.006-.075l-.006-.056l-.035-.144a1.3 1.3 0 0 0-.358-.61a1.386 1.386 0 0 0-1.957 0a1.4 1.4 0 0 0 0 1.963c.191.191.418.311.668.371c.024.012.06.012.084.012q.019 0 .041.006q.023.005.042.006a4.24 4.24 0 0 1 2.231 1.186c.048.048.096.095.131.143a.323.323 0 0 0 .466 0a.35.35 0 0 0 .036-.455m-1.05 4.37l-.025.025c-.119.096-.31.096-.453-.036a.326.326 0 0 1 0-.467c.047-.036.094-.083.141-.13l.002-.002a4.27 4.27 0 0 0 1.187-2.28q.005-.024.006-.043c0-.024 0-.06.012-.084a1.386 1.386 0 0 1 2.326-.67a1.4 1.4 0 0 1 0 1.964c-.167.18-.382.299-.608.359l-.143.036l-.057.005q-.035.006-.075.007a4.2 4.2 0 0 0-2.183 1.173l-.095.096q-.009.01-.018.024t-.018.024m-4.392-1.053l.024.024l.024.018q.015.009.024.018l.096.096a4.25 4.25 0 0 1 1.169 2.19q0 .04.006.076q.005.03.006.057l.035.143c.06.228.18.443.358.611c.537.539 1.42.539 1.957 0a1.4 1.4 0 0 0 0-1.964a1.4 1.4 0 0 0-.668-.371c-.024-.012-.06-.012-.084-.012q-.018 0-.041-.006l-.042-.006a4.25 4.25 0 0 1-2.231-1.185a1.4 1.4 0 0 1-.131-.144a.323.323 0 0 0-.466 0a.325.325 0 0 0-.036.455m1.039-4.358l.024-.024a.32.32 0 0 1 .453.035a.326.326 0 0 1 0 .467c-.047.036-.094.083-.141.13l-.002.002a4.27 4.27 0 0 0-1.187 2.281l-.006.042c0 .024 0 .06-.012.084a1.386 1.386 0 0 1-2.326.67a1.4 1.4 0 0 1 0-1.963c.166-.18.381-.3.608-.36l.143-.035q.026 0 .056-.006q.037-.005.075-.006a4.2 4.2 0 0 0 2.183-1.174l.096-.095l.018-.025z" /> </svg>' },
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
  const feishuConfigured = !!(draft.feishuConfig?.configured || (draft.feishuConfig?.appId && draft.feishuConfig?.appSecret));
  const wecomConfigured = !!(draft.wecomConfig?.configured || (draft.wecomConfig?.botId && draft.wecomConfig?.secret));
  const bindingStatus = draft.binding?.status || 'idle';
  const hasQrCode = !!draft.binding?.qrcodeDataUrl;
  const lineCarriers = new Set(
    (draft.workspaceConfig?.lines || []).map(function(l) { return l.carrier; }).filter(Boolean)
  );
  const receptionistOptions = [
    { value: 'qq', label: 'QQ', icon: '<svg class="im-channel-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673.54.065 2.103-2.472 2.103-2.472 0 1.469.756 3.387 2.394 4.771-.612.188-1.363.479-1.845.835-.434.32-.379.646-.301.778.343.578 5.883.369 7.482.189 1.6.18 7.14.389 7.483-.189.078-.132.132-.458-.301-.778-.483-.356-1.233-.646-1.846-.836 1.637-1.384 2.393-3.302 2.393-4.771 0 0 1.563 2.537 2.103 2.472.251-.03.581-1.39-.438-4.673"/></svg>' },
    { value: 'weixin', label: '微信', icon: '<svg class="im-channel-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z"/></svg>' },
    { value: 'feishu', label: '飞书', icon: '<svg class="im-channel-icon" xmlns="http://www.w3.org/2000/svg" viewBox="62.16 94.5 407.87 324.19"><path d="M274.18 264.785q.515-.517 1.03-1.027c.685-.688 1.372-1.258 2.056-1.945l1.37-1.372 4.118-4.113 5.598-5.601 4.8-4.797 4.575-4.457 4.796-4.688 4.344-4.344 6.059-6.054c1.14-1.145 2.285-2.29 3.543-3.317 2.168-2.054 4.457-4 6.855-5.828 2.172-1.715 4.344-3.312 6.516-4.914 3.082-2.172 6.398-4.344 9.71-6.285 3.204-1.941 6.63-3.656 10.06-5.371 3.199-1.602 6.515-2.973 9.827-4.23 1.829-.684 3.774-1.372 5.602-2.055.914-.344 1.941-.688 2.856-.914-8.57-33.715-24.227-64.575-45.258-90.86-4.114-5.14-10.399-8.113-17.028-8.113H130.754c-3.203 0-4.457 4-1.945 5.941 59.543 43.66 109.144 99.887 145.03 164.801 0-.226.227-.34.34-.457m0 0" style="fill:currentColor;"/><path d="M204.79 418.691c90.288 0 169.03-49.828 210.058-123.543 1.488-2.628 2.859-5.257 4.23-7.882q-3.087 6-6.86 11.312l-2.741 3.77c-1.141 1.488-2.399 2.972-3.657 4.457-1.03 1.144-2.058 2.285-3.086 3.316-2.058 2.172-4.343 4.227-6.629 6.172a53 53 0 0 1-3.886 3.2c-1.598 1.144-3.086 2.284-4.684 3.429-1.031.683-2.058 1.371-3.086 1.941-1.144.684-2.172 1.258-3.316 1.942a131 131 0 0 1-6.969 3.543c-2.059.918-4.117 1.828-6.289 2.515-2.285.801-4.57 1.602-6.969 2.285-3.543.914-7.086 1.715-10.742 2.286-2.629.457-5.258.687-8 .914-2.86.23-5.601.23-8.457.23-3.086 0-6.289-.23-9.488-.57a83 83 0 0 1-7.086-1.031c-2.055-.34-4.113-.801-6.168-1.258-1.031-.227-2.176-.57-3.203-.797-2.973-.8-6.055-1.602-9.028-2.516-1.488-.457-2.972-.914-4.457-1.258-2.172-.683-4.457-1.37-6.629-2.058-1.828-.57-3.656-1.14-5.37-1.711q-2.573-.86-5.145-1.715c-1.14-.344-2.285-.8-3.543-1.144-1.371-.457-2.856-1.028-4.227-1.485-1.027-.344-2.058-.687-2.972-1.027-1.942-.688-4-1.488-5.942-2.172-1.144-.457-2.285-.914-3.43-1.258-1.484-.57-3.085-1.144-4.57-1.828-1.601-.687-3.203-1.258-4.8-1.945-1.028-.457-2.06-.797-3.087-1.258-1.257-.57-2.628-1.027-3.886-1.598-1.028-.457-1.942-.8-2.969-1.258l-3.086-1.37c-.914-.344-1.832-.801-2.746-1.145a44 44 0 0 1-2.512-1.14c-.8-.345-1.715-.802-2.515-1.145-.914-.344-1.715-.801-2.512-1.141-1.031-.457-2.172-1.031-3.203-1.484-1.14-.575-2.285-1.032-3.426-1.602-1.258-.574-2.402-1.144-3.66-1.715-1.027-.457-2.055-1.027-3.082-1.484-54.172-26.973-102.172-63.086-143.09-106.746-2.055-2.172-5.71-.684-5.71 2.289l.112 154.398v12.57c0 7.317 3.543 14.06 9.598 18.172 38.172 24.801 83.773 39.543 132.914 39.543m0 0" style="fill:currentColor;"/><path d="M414.84 295.188c0 .113-.113.113-.113.226zl.8-1.489c-.343.457-.574 1.028-.8 1.488m3.793-7.05.226-.457.114-.23q-.17.513-.34.687m0 0" style="fill:currentColor;"/><path d="M470.035 201.121c-18.285-9.031-38.86-14.059-60.687-14.059-12.914 0-25.485 1.829-37.371 5.141-1.372.344-2.743.8-4.114 1.258-.914.344-1.941.574-2.855.914-1.945.688-3.774 1.375-5.602 2.059-3.316 1.257-6.629 2.742-9.828 4.23-3.43 1.598-6.742 3.426-10.058 5.371a128 128 0 0 0-9.715 6.285c-2.285 1.602-4.457 3.2-6.512 4.914a154 154 0 0 0-6.86 5.828c-1.14 1.141-2.398 2.172-3.542 3.313l-6.055 6.059-4.344 4.343-4.8 4.684-4.57 4.46-4.802 4.798-11.086 11.086c-.687.687-1.37 1.37-2.058 1.945l-1.028 1.027c-.457.457-1.027 1.028-1.601 1.485-.57.57-1.14 1.031-1.711 1.601a244.4 244.4 0 0 1-49.828 35.313c1.027.457 2.168 1.027 3.199 1.488.8.34 1.715.797 2.512 1.14.8.344 1.715.801 2.515 1.145.801.344 1.602.684 2.516 1.14.914.345 1.828.802 2.742 1.145l3.086 1.371c1.027.457 1.942.801 2.969 1.258 1.258.57 2.629 1.028 3.887 1.598 1.03.46 2.058.8 3.086 1.258 1.601.687 3.199 1.258 4.8 1.945 1.485.57 3.086 1.14 4.57 1.828 1.145.457 2.286.914 3.43 1.258 1.946.684 4 1.484 5.946 2.172a81 81 0 0 1 2.968 1.027c1.371.457 2.856 1.028 4.23 1.485 1.141.343 2.286.8 3.544 1.14q2.567.86 5.14 1.719c1.829.57 3.657 1.14 5.372 1.71 2.171.688 4.457 1.376 6.628 2.06 1.489.457 2.973.914 4.457 1.257 2.973.914 5.942 1.715 9.032 2.512 1.027.344 2.168.574 3.199.8 2.055.458 4.113.915 6.172 1.259 2.398.457 4.683.8 7.082 1.03 3.203.34 6.402.571 9.488.571 2.856 0 5.715 0 8.457-.23 2.63-.227 5.371-.457 8-.914 3.656-.57 7.2-1.371 10.742-2.286 2.399-.683 4.688-1.37 6.973-2.285 2.172-.8 4.227-1.601 6.285-2.515 2.399-1.028 4.684-2.285 6.973-3.543 1.14-.57 2.168-1.258 3.312-1.942 1.028-.687 2.059-1.257 3.086-1.945 1.602-1.027 3.2-2.168 4.684-3.426a52 52 0 0 0 3.887-3.203c2.289-1.941 4.457-4 6.628-6.168 1.032-1.031 2.06-2.172 3.086-3.316 1.258-1.485 2.516-2.969 3.657-4.457.918-1.258 1.828-2.512 2.742-3.77 2.515-3.543 4.8-7.316 6.86-11.199l2.284-4.688 21.145-42.171v.113c6.742-14.742 16.226-28.113 27.656-39.426m0 0" style="fill:currentColor;"/></svg>' },
    { value: 'wecom', label: '企业微信', icon: '<svg class="im-channel-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"> <path d="M0 0h24v24H0z" fill="none" /> <path fill="currentColor" d="m17.326 8.158l-.003-.007a6.6 6.6 0 0 0-1.178-1.674c-1.266-1.307-3.067-2.19-5.102-2.417a9.3 9.3 0 0 0-2.124 0h-.001c-2.061.228-3.882 1.107-5.14 2.405a6.7 6.7 0 0 0-1.194 1.682A5.7 5.7 0 0 0 2 10.657c0 1.106.332 2.218.988 3.201l.006.01c.391.594 1.092 1.39 1.637 1.83l.983.793l-.208.875l.527-.267l.708-.358l.761.225c.467.137.955.227 1.517.29h.005q.515.06 1.026.059c.355 0 .724-.02 1.095-.06a9 9 0 0 0 1.346-.258c.095.7.43 1.337.932 1.81c-.658.208-1.352.358-2.061.436c-.442.048-.883.072-1.312.072q-.627 0-1.253-.072a10.7 10.7 0 0 1-1.861-.36l-2.84 1.438s-.29.131-.44.131c-.418 0-.702-.285-.702-.704c0-.252.067-.598.128-.84l.394-1.653c-.728-.586-1.563-1.544-2.052-2.287A7.76 7.76 0 0 1 0 10.658a7.7 7.7 0 0 1 .787-3.39a8.7 8.7 0 0 1 1.551-2.19c1.61-1.665 3.878-2.73 6.359-3.006a11.3 11.3 0 0 1 2.565 0c2.47.275 4.712 1.353 6.323 3.017a8.6 8.6 0 0 1 1.539 2.192c.466.945.769 1.937.769 2.978a3.06 3.06 0 0 0-2-.005c-.001-.644-.189-1.329-.564-2.09zm4.125 6.977l-.024-.024l-.024-.018l-.024-.018l-.096-.095a4.24 4.24 0 0 1-1.169-2.192q0-.038-.006-.075l-.006-.056l-.035-.144a1.3 1.3 0 0 0-.358-.61a1.386 1.386 0 0 0-1.957 0a1.4 1.4 0 0 0 0 1.963c.191.191.418.311.668.371c.024.012.06.012.084.012q.019 0 .041.006q.023.005.042.006a4.24 4.24 0 0 1 2.231 1.186c.048.048.096.095.131.143a.323.323 0 0 0 .466 0a.35.35 0 0 0 .036-.455m-1.05 4.37l-.025.025c-.119.096-.31.096-.453-.036a.326.326 0 0 1 0-.467c.047-.036.094-.083.141-.13l.002-.002a4.27 4.27 0 0 0 1.187-2.28q.005-.024.006-.043c0-.024 0-.06.012-.084a1.386 1.386 0 0 1 2.326-.67a1.4 1.4 0 0 1 0 1.964c-.167.18-.382.299-.608.359l-.143.036l-.057.005q-.035.006-.075.007a4.2 4.2 0 0 0-2.183 1.173l-.095.096q-.009.01-.018.024t-.018.024m-4.392-1.053l.024.024l.024.018q.015.009.024.018l.096.096a4.25 4.25 0 0 1 1.169 2.19q0 .04.006.076q.005.03.006.057l.035.143c.06.228.18.443.358.611c.537.539 1.42.539 1.957 0a1.4 1.4 0 0 0 0-1.964a1.4 1.4 0 0 0-.668-.371c-.024-.012-.06-.012-.084-.012q-.018 0-.041-.006l-.042-.006a4.25 4.25 0 0 1-2.231-1.185a1.4 1.4 0 0 1-.131-.144a.323.323 0 0 0-.466 0a.325.325 0 0 0-.036.455m1.039-4.358l.024-.024a.32.32 0 0 1 .453.035a.326.326 0 0 1 0 .467c-.047.036-.094.083-.141.13l-.002.002a4.27 4.27 0 0 0-1.187 2.281l-.006.042c0 .024 0 .06-.012.084a1.386 1.386 0 0 1-2.326.67a1.4 1.4 0 0 1 0-1.963c.166-.18.381-.3.608-.36l.143-.035q.026 0 .056-.006q.037-.005.075-.006a4.2 4.2 0 0 0 2.183-1.174l.096-.095l.018-.025z" /> </svg>' },
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
    renderIMChannelConfigDialog(draft, fields, qqConfigured, weixinConfigured, feishuConfigured, wecomConfigured, weixinBadge, weixinActionsHtml),
  ].join('');
}

function renderIMChannelConfigDialog(draft, fields, qqConfigured, weixinConfigured, feishuConfigured, wecomConfigured, weixinBadge, weixinActionsHtml) {
  if (!window._imChannelConfigOpen) return '';
  const isZh = currentLanguage === 'zh';
  const hasQrCode = !!draft.binding?.qrcodeDataUrl;

  // ── Detail view ──
  if (window._imChannelDetailId) {
    const ch = window._imChannelDetailId;
    const isQQ = ch === 'qq';
    const isWeixin = ch === 'weixin';
    const isFeishu = ch === 'feishu';
    const isWecom = ch === 'wecom';
    const title = isQQ ? (isZh ? 'QQ 机器人配置' : 'QQ Bot Config')
      : isWeixin ? (isZh ? '微信配置' : 'WeChat Config')
        : isFeishu ? (isZh ? '飞书配置' : 'Feishu Config')
          : isWecom ? (isZh ? '企业微信配置' : 'WeCom Config')
            : ch;
    const subtitle = isQQ ? (isZh ? '配置 QQ 机器人账号信息' : 'Configure QQ bot credentials')
      : isWeixin ? (isZh ? '配置微信账号绑定与扫码登录' : 'Configure WeChat binding & QR login')
        : isFeishu ? (isZh ? '配置飞书自建应用凭据' : 'Configure Feishu app credentials')
          : isWecom ? (isZh ? '配置企业微信智能机器人凭据' : 'Configure WeCom smart bot credentials')
            : '';

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
    } else if (isFeishu) {
      const feishuFields = [
        { name: 'appId', type: 'text', label: isZh ? 'App ID' : 'App ID' },
        { name: 'appSecret', type: 'password', label: isZh ? 'App Secret' : 'App Secret' },
      ];
      bodyHtml = '<div class="workspace-config-grid">'
        + feishuFields.map((field) => renderQQBotConfigField(field, draft.feishuConfig || {}, 'window.updateIMFeishuConfigDraft')).join('')
        + '</div>';
    } else if (isWecom) {
      const wecomFields = [
        { name: 'botId', type: 'text', label: isZh ? 'Bot ID' : 'Bot ID' },
        { name: 'secret', type: 'password', label: isZh ? 'Secret' : 'Secret' },
      ];
      bodyHtml = '<div class="workspace-config-grid">'
        + wecomFields.map((field) => renderQQBotConfigField(field, draft.wecomConfig || {}, 'window.updateIMWecomConfigDraft')).join('')
        + '</div>';
    }

    return [
      '<div class="feature-detail-overlay" onclick="window.closeIMChannelConfig()">',
      '<div class="feature-detail-window" style="max-width:480px;" onclick="event.stopPropagation()">',
      '<div class="feature-detail-head">',
      '<div>',
      '<div class="feature-detail-title">' + escapeHtml(title) + '</div>',
      '<div class="feature-detail-subtitle">' + escapeHtml(subtitle) + '</div>',
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
      icon: '<svg class="im-channel-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673.54.065 2.103-2.472 2.103-2.472 0 1.469.756 3.387 2.394 4.771-.612.188-1.363.479-1.845.835-.434.32-.379.646-.301.778.343.578 5.883.369 7.482.189 1.6.18 7.14.389 7.483-.189.078-.132.132-.458-.301-.778-.483-.356-1.233-.646-1.846-.836 1.637-1.384 2.393-3.302 2.393-4.771 0 0 1.563 2.537 2.103 2.472.251-.03.581-1.39-.438-4.673"/></svg>',
      name: isZh ? 'QQ' : 'QQ',
      desc: isZh ? 'QQ 机器人账号信息与消息收发' : 'QQ bot credentials & messaging',
      configured: qqConfigured,
      badgeText: qqConfigured ? (isZh ? '已配置' : 'Ready') : (isZh ? '未完成' : 'Incomplete'),
    },
    {
      id: 'weixin',
      icon: '<svg class="im-channel-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z"/></svg>',
      name: isZh ? '微信' : 'WeChat',
      desc: isZh ? '微信账号绑定与扫码登录' : 'WeChat binding & QR login',
      configured: weixinConfigured,
      badgeText: weixinBadge,
    },
    {
      id: 'feishu',
      icon: '<svg class="im-channel-icon" xmlns="http://www.w3.org/2000/svg" viewBox="62.16 94.5 407.87 324.19"><path d="M274.18 264.785q.515-.517 1.03-1.027c.685-.688 1.372-1.258 2.056-1.945l1.37-1.372 4.118-4.113 5.598-5.601 4.8-4.797 4.575-4.457 4.796-4.688 4.344-4.344 6.059-6.054c1.14-1.145 2.285-2.29 3.543-3.317 2.168-2.054 4.457-4 6.855-5.828 2.172-1.715 4.344-3.312 6.516-4.914 3.082-2.172 6.398-4.344 9.71-6.285 3.204-1.941 6.63-3.656 10.06-5.371 3.199-1.602 6.515-2.973 9.827-4.23 1.829-.684 3.774-1.372 5.602-2.055.914-.344 1.941-.688 2.856-.914-8.57-33.715-24.227-64.575-45.258-90.86-4.114-5.14-10.399-8.113-17.028-8.113H130.754c-3.203 0-4.457 4-1.945 5.941 59.543 43.66 109.144 99.887 145.03 164.801 0-.226.227-.34.34-.457m0 0" style="fill:currentColor;"/><path d="M204.79 418.691c90.288 0 169.03-49.828 210.058-123.543 1.488-2.628 2.859-5.257 4.23-7.882q-3.087 6-6.86 11.312l-2.741 3.77c-1.141 1.488-2.399 2.972-3.657 4.457-1.03 1.144-2.058 2.285-3.086 3.316-2.058 2.172-4.343 4.227-6.629 6.172a53 53 0 0 1-3.886 3.2c-1.598 1.144-3.086 2.284-4.684 3.429-1.031.683-2.058 1.371-3.086 1.941-1.144.684-2.172 1.258-3.316 1.942a131 131 0 0 1-6.969 3.543c-2.059.918-4.117 1.828-6.289 2.515-2.285.801-4.57 1.602-6.969 2.285-3.543.914-7.086 1.715-10.742 2.286-2.629.457-5.258.687-8 .914-2.86.23-5.601.23-8.457.23-3.086 0-6.289-.23-9.488-.57a83 83 0 0 1-7.086-1.031c-2.055-.34-4.113-.801-6.168-1.258-1.031-.227-2.176-.57-3.203-.797-2.973-.8-6.055-1.602-9.028-2.516-1.488-.457-2.972-.914-4.457-1.258-2.172-.683-4.457-1.37-6.629-2.058-1.828-.57-3.656-1.14-5.37-1.711q-2.573-.86-5.145-1.715c-1.14-.344-2.285-.8-3.543-1.144-1.371-.457-2.856-1.028-4.227-1.485-1.027-.344-2.058-.687-2.972-1.027-1.942-.688-4-1.488-5.942-2.172-1.144-.457-2.285-.914-3.43-1.258-1.484-.57-3.085-1.144-4.57-1.828-1.601-.687-3.203-1.258-4.8-1.945-1.028-.457-2.06-.797-3.087-1.258-1.257-.57-2.628-1.027-3.886-1.598-1.028-.457-1.942-.8-2.969-1.258l-3.086-1.37c-.914-.344-1.832-.801-2.746-1.145a44 44 0 0 1-2.512-1.14c-.8-.345-1.715-.802-2.515-1.145-.914-.344-1.715-.801-2.512-1.141-1.031-.457-2.172-1.031-3.203-1.484-1.14-.575-2.285-1.032-3.426-1.602-1.258-.574-2.402-1.144-3.66-1.715-1.027-.457-2.055-1.027-3.082-1.484-54.172-26.973-102.172-63.086-143.09-106.746-2.055-2.172-5.71-.684-5.71 2.289l.112 154.398v12.57c0 7.317 3.543 14.06 9.598 18.172 38.172 24.801 83.773 39.543 132.914 39.543m0 0" style="fill:currentColor;"/><path d="M414.84 295.188c0 .113-.113.113-.113.226zl.8-1.489c-.343.457-.574 1.028-.8 1.488m3.793-7.05.226-.457.114-.23q-.17.513-.34.687m0 0" style="fill:currentColor;"/><path d="M470.035 201.121c-18.285-9.031-38.86-14.059-60.687-14.059-12.914 0-25.485 1.829-37.371 5.141-1.372.344-2.743.8-4.114 1.258-.914.344-1.941.574-2.855.914-1.945.688-3.774 1.375-5.602 2.059-3.316 1.257-6.629 2.742-9.828 4.23-3.43 1.598-6.742 3.426-10.058 5.371a128 128 0 0 0-9.715 6.285c-2.285 1.602-4.457 3.2-6.512 4.914a154 154 0 0 0-6.86 5.828c-1.14 1.141-2.398 2.172-3.542 3.313l-6.055 6.059-4.344 4.343-4.8 4.684-4.57 4.46-4.802 4.798-11.086 11.086c-.687.687-1.37 1.37-2.058 1.945l-1.028 1.027c-.457.457-1.027 1.028-1.601 1.485-.57.57-1.14 1.031-1.711 1.601a244.4 244.4 0 0 1-49.828 35.313c1.027.457 2.168 1.027 3.199 1.488.8.34 1.715.797 2.512 1.14.8.344 1.715.801 2.515 1.145.801.344 1.602.684 2.516 1.14.914.345 1.828.802 2.742 1.145l3.086 1.371c1.027.457 1.942.801 2.969 1.258 1.258.57 2.629 1.028 3.887 1.598 1.03.46 2.058.8 3.086 1.258 1.601.687 3.199 1.258 4.8 1.945 1.485.57 3.086 1.14 4.57 1.828 1.145.457 2.286.914 3.43 1.258 1.946.684 4 1.484 5.946 2.172a81 81 0 0 1 2.968 1.027c1.371.457 2.856 1.028 4.23 1.485 1.141.343 2.286.8 3.544 1.14q2.567.86 5.14 1.719c1.829.57 3.657 1.14 5.372 1.71 2.171.688 4.457 1.376 6.628 2.06 1.489.457 2.973.914 4.457 1.257 2.973.914 5.942 1.715 9.032 2.512 1.027.344 2.168.574 3.199.8 2.055.458 4.113.915 6.172 1.259 2.398.457 4.683.8 7.082 1.03 3.203.34 6.402.571 9.488.571 2.856 0 5.715 0 8.457-.23 2.63-.227 5.371-.457 8-.914 3.656-.57 7.2-1.371 10.742-2.286 2.399-.683 4.688-1.37 6.973-2.285 2.172-.8 4.227-1.601 6.285-2.515 2.399-1.028 4.684-2.285 6.973-3.543 1.14-.57 2.168-1.258 3.312-1.942 1.028-.687 2.059-1.257 3.086-1.945 1.602-1.027 3.2-2.168 4.684-3.426a52 52 0 0 0 3.887-3.203c2.289-1.941 4.457-4 6.628-6.168 1.032-1.031 2.06-2.172 3.086-3.316 1.258-1.485 2.516-2.969 3.657-4.457.918-1.258 1.828-2.512 2.742-3.77 2.515-3.543 4.8-7.316 6.86-11.199l2.284-4.688 21.145-42.171v.113c6.742-14.742 16.226-28.113 27.656-39.426m0 0" style="fill:currentColor;"/></svg>',
      name: isZh ? '飞书' : 'Feishu',
      desc: isZh ? '飞书自建应用凭据配置' : 'Feishu app credentials',
      configured: feishuConfigured,
      badgeText: feishuConfigured ? (isZh ? '已配置' : 'Ready') : (isZh ? '未完成' : 'Incomplete'),
    },
    {
      id: 'wecom',
      icon: '<svg class="im-channel-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"> <path d="M0 0h24v24H0z" fill="none" /> <path fill="currentColor" d="m17.326 8.158l-.003-.007a6.6 6.6 0 0 0-1.178-1.674c-1.266-1.307-3.067-2.19-5.102-2.417a9.3 9.3 0 0 0-2.124 0h-.001c-2.061.228-3.882 1.107-5.14 2.405a6.7 6.7 0 0 0-1.194 1.682A5.7 5.7 0 0 0 2 10.657c0 1.106.332 2.218.988 3.201l.006.01c.391.594 1.092 1.39 1.637 1.83l.983.793l-.208.875l.527-.267l.708-.358l.761.225c.467.137.955.227 1.517.29h.005q.515.06 1.026.059c.355 0 .724-.02 1.095-.06a9 9 0 0 0 1.346-.258c.095.7.43 1.337.932 1.81c-.658.208-1.352.358-2.061.436c-.442.048-.883.072-1.312.072q-.627 0-1.253-.072a10.7 10.7 0 0 1-1.861-.36l-2.84 1.438s-.29.131-.44.131c-.418 0-.702-.285-.702-.704c0-.252.067-.598.128-.84l.394-1.653c-.728-.586-1.563-1.544-2.052-2.287A7.76 7.76 0 0 1 0 10.658a7.7 7.7 0 0 1 .787-3.39a8.7 8.7 0 0 1 1.551-2.19c1.61-1.665 3.878-2.73 6.359-3.006a11.3 11.3 0 0 1 2.565 0c2.47.275 4.712 1.353 6.323 3.017a8.6 8.6 0 0 1 1.539 2.192c.466.945.769 1.937.769 2.978a3.06 3.06 0 0 0-2-.005c-.001-.644-.189-1.329-.564-2.09zm4.125 6.977l-.024-.024l-.024-.018l-.024-.018l-.096-.095a4.24 4.24 0 0 1-1.169-2.192q0-.038-.006-.075l-.006-.056l-.035-.144a1.3 1.3 0 0 0-.358-.61a1.386 1.386 0 0 0-1.957 0a1.4 1.4 0 0 0 0 1.963c.191.191.418.311.668.371c.024.012.06.012.084.012q.019 0 .041.006q.023.005.042.006a4.24 4.24 0 0 1 2.231 1.186c.048.048.096.095.131.143a.323.323 0 0 0 .466 0a.35.35 0 0 0 .036-.455m-1.05 4.37l-.025.025c-.119.096-.31.096-.453-.036a.326.326 0 0 1 0-.467c.047-.036.094-.083.141-.13l.002-.002a4.27 4.27 0 0 0 1.187-2.28q.005-.024.006-.043c0-.024 0-.06.012-.084a1.386 1.386 0 0 1 2.326-.67a1.4 1.4 0 0 1 0 1.964c-.167.18-.382.299-.608.359l-.143.036l-.057.005q-.035.006-.075.007a4.2 4.2 0 0 0-2.183 1.173l-.095.096q-.009.01-.018.024t-.018.024m-4.392-1.053l.024.024l.024.018q.015.009.024.018l.096.096a4.25 4.25 0 0 1 1.169 2.19q0 .04.006.076q.005.03.006.057l.035.143c.06.228.18.443.358.611c.537.539 1.42.539 1.957 0a1.4 1.4 0 0 0 0-1.964a1.4 1.4 0 0 0-.668-.371c-.024-.012-.06-.012-.084-.012q-.018 0-.041-.006l-.042-.006a4.25 4.25 0 0 1-2.231-1.185a1.4 1.4 0 0 1-.131-.144a.323.323 0 0 0-.466 0a.325.325 0 0 0-.036.455m1.039-4.358l.024-.024a.32.32 0 0 1 .453.035a.326.326 0 0 1 0 .467c-.047.036-.094.083-.141.13l-.002.002a4.27 4.27 0 0 0-1.187 2.281l-.006.042c0 .024 0 .06-.012.084a1.386 1.386 0 0 1-2.326.67a1.4 1.4 0 0 1 0-1.963c.166-.18.381-.3.608-.36l.143-.035q.026 0 .056-.006q.037-.005.075-.006a4.2 4.2 0 0 0 2.183-1.174l.096-.095l.018-.025z" /> </svg>',
      name: isZh ? '企业微信' : 'WeCom',
      desc: isZh ? '企业微信智能机器人凭据配置' : 'WeCom smart bot credentials',
      configured: wecomConfigured,
      badgeText: wecomConfigured ? (isZh ? '已配置' : 'Ready') : (isZh ? '未完成' : 'Incomplete'),
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
