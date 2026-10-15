/**
 * model-settings.js — 文本模型预设管理 + 设置覆盖层主编排（从 settings-overlay.js 拆分）
 *
 * 包含：overlay host 管理、模型设置覆盖层主渲染、文本模型预设增删改、API Key 可视性切换。
 * 依赖（全局）：escapeHtml, currentLanguage, getCurrentAgentRecord, updateChatContextBar
 * 依赖（跨文件）：renderSpeechModelSection（speech-settings.js）、
 *   refreshOAuthStatus / renderOAuthLoginArea / resolveOpenCodeProtocolClient / _oauthPollTimer（oauth-flow.js）
 */

function ensureSettingsHost() {
  let host = document.getElementById('settings-overlay-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'settings-overlay-host';
    document.body.appendChild(host);
  }
  return host;
}

async function openSettings() {
  window.ClawFW.settingsOpen = true;
  if (!['overview', 'custom', 'codex', 'opencode', 'speech'].includes(window.ClawFW.settingsTab)) window.ClawFW.settingsTab = 'overview';
  window.ClawFW.settingsEditing = null;
  window.ClawFW.settingsData = null;
  setClawSpeechModelConfig(null);
  setClawSpeechPresets([]);
  renderSettingsOverlay();
  try {
    const [modelResp, speechResp] = await Promise.all([
      fetch('/protoclaw/model_config'),
      fetch('/protoclaw/speech_model_config'),
    ]);
    const data = await modelResp.json();
    const connectionsResp = await fetch('/protoclaw/model_connections');
    if (connectionsResp.ok) data.connections = await connectionsResp.json();
    window.ClawFW.settingsData = data;
    setClawModelPresets(Array.isArray(data?.presets) ? data.presets : []);
    try {
      const speechData = await speechResp.json();
      setClawSpeechModelConfig(speechData?.speechModel || null);
      setClawSpeechPresets(Array.isArray(speechData?.speechPresets) ? speechData.speechPresets : []);
    } catch (e) { /* speech config may not exist yet */ }
    renderSettingsOverlay();
    if (window.ClawFW.settingsTab === 'codex') {
      refreshOAuthStatus();
      refreshModelCatalog('codex');
    }
    if (window.ClawFW.settingsTab === 'opencode') refreshModelCatalog('opencode');
  } catch (error) {
    console.error('Failed to load model config:', error);
  }
}

function closeSettings() {
  if (_oauthPollTimer) { clearInterval(_oauthPollTimer); _oauthPollTimer = null; }
  window.ClawFW.settingsOpen = false;
  window.ClawFW.settingsEditing = null;
  window.ClawFW.settingsData = null;
  window.ClawFW._speechEditing = null;
  setClawSpeechPresets([]);
  const host = document.getElementById('settings-overlay-host');
  if (host) host.innerHTML = '';
}

function presetSourceLabel(preset) {
  if (!preset) return '—';
  if (preset.catalogProvider === 'codex' || preset.authType === 'oauth-codex') return 'Codex';
  if (preset.catalogProvider === 'opencode' || ['OpenCode Zen', 'OpenCode Go'].includes(preset.providerName)) return 'OpenCode';
  return preset.provider || 'Custom';
}

function renderActiveModelBanner(isZh, name, detail) {
  return '<div class="settings-section"><div class="settings-active-banner"><div class="settings-active-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 1 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 1-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 1-.33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 1-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 1 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0 .33 1.82V9a1.65 1.65 0 0 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></div><div class="settings-active-info"><div class="settings-active-label">' + (isZh ? '当前选中' : 'CURRENTLY SELECTED') + '</div><div class="settings-active-name">' + escapeHtml(name) + '</div><div class="settings-active-detail">' + escapeHtml(detail) + '</div></div><span class="settings-active-badge">' + (isZh ? '生效中' : 'Active') + '</span></div></div>';
}

function renderOverviewContent(presets, dm, currentPreset, isZh) {
  const navIcons = {
    custom: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
    codex: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    opencode: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>',
    speech: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>',
  };
  const navItems = [
    { key: 'custom', title: isZh ? '自定义模型' : 'Custom Models', desc: isZh ? '添加和管理自定义 API 模型' : 'Add and manage custom API models' },
    { key: 'codex', title: 'Codex', desc: isZh ? '连接 OpenAI 账户，添加 Codex 模型' : 'Connect your OpenAI account to add Codex models' },
    { key: 'opencode', title: 'OpenCode', desc: isZh ? '配置 Zen / Go 连接，添加 OpenCode 模型' : 'Configure Zen / Go to add OpenCode models' },
    { key: 'speech', title: isZh ? '语音模型' : 'Speech Model', desc: isZh ? '配置语音输入使用的模型' : 'Configure the model used for speech input' },
  ];
  const bannerName = currentPreset ? (currentPreset.name || currentPreset.model) : (dm.model || (isZh ? '未选择模型' : 'No model selected'));
  const bannerDetail = (currentPreset ? presetSourceLabel(currentPreset) : (dm.provider || '—')) + ' · ' + (dm.model || '—');
  const cards = presets.map((p, idx) => {
    const isActive = dm.model === p.model && dm.provider === p.provider && dm.baseUrl === p.baseUrl;
    return [
      '<div class="settings-preset-card' + (isActive ? ' active' : '') + '" onclick="applySettingsPreset(' + idx + ')">',
      '<div class="settings-preset-dot"></div>',
      '<div class="settings-preset-info">',
      '<div class="settings-preset-name">' + escapeHtml(p.name || p.model || ('Preset ' + (idx + 1))) + '</div>',
      '<div class="settings-preset-detail">' + escapeHtml(presetSourceLabel(p) + ' · ' + (p.model || '—'))
        + (p.vision ? ' <span class="preset-tag preset-tag-vision">' + (isZh ? '视觉' : 'Vision') + '</span>' : '')
        + (p.authType === 'oauth-codex' ? ' <span class="preset-tag preset-tag-oauth">OAuth</span>' : '')
        + (p.providerName === 'OpenCode Zen' || p.providerName === 'OpenCode Go' ? ' <span class="preset-tag preset-tag-opencode">' + (p.providerName === 'OpenCode Go' ? 'Go' : 'OpenCode') + '</span>' : '')
        + '</div>',
      '</div>',
      '<div class="settings-preset-actions">',
      '<button class="settings-icon-btn star-btn' + (p.starred ? ' starred' : '') + '" type="button" title="' + (isZh ? (p.starred ? '取消星标' : '设为星标') : (p.starred ? 'Unstar' : 'Star')) + '" onclick="event.stopPropagation();toggleSettingsPresetStar(' + idx + ')">',
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="' + (p.starred ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
      '</button>',
      '<button class="settings-icon-btn" type="button" title="' + (isZh ? '编辑' : 'Edit') + '" onclick="event.stopPropagation();editSettingsPreset(' + idx + ')">',
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
      '</button>',
      '<button class="settings-icon-btn danger" type="button" title="' + (isZh ? '删除' : 'Delete') + '" onclick="event.stopPropagation();deleteSettingsPreset(' + idx + ')">',
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>',
      '</button>',
      '</div>',
      '</div>',
    ].join('');
  }).join('');
  return renderActiveModelBanner(isZh, bannerName, bannerDetail)
    + '<div class="settings-section"><div class="settings-section-title">' + (isZh ? '快速配置' : 'Quick setup') + '</div>'
      + '<div class="settings-overview-nav">' + navItems.map((item) =>
        '<button type="button" class="settings-overview-nav-item" onclick="switchSettingsTab(\'' + item.key + '\')">'
        + '<span class="settings-overview-nav-icon">' + navIcons[item.key] + '</span>'
        + '<span><span class="settings-overview-nav-title">' + item.title + '</span><div class="settings-overview-nav-desc">' + item.desc + '</div></span>'
        + '</button>').join('') + '</div></div>'
    + '<div class="settings-section"><div class="settings-section-title">' + (isZh ? '模型列表' : 'Models') + '<span class="settings-section-hint">' + (isZh ? '点击卡片将其设为当前选择' : 'Click a card to make it the current selection') + '</span></div>'
      + '<div class="settings-presets-grid">' + (cards || '<div class="ph-settings-empty">' + (isZh ? '暂无模型，先从上方添加' : 'No models yet — add one above') + '</div>') + '</div></div>';
}

function renderModelCatalogSettingsOverlay(host, data) {
  const isZh = currentLanguage === 'zh';
  const tab = window.ClawFW.settingsTab || 'overview';
  const presets = Array.isArray(data.presets) ? data.presets : [];
  const connections = data.connections || { opencode: { hasApiKey: false, tier: 'zen' } };
  const catalog = window.ClawFW.modelCatalogs?.[tab] || { models: [], loaded: false, loading: false, error: '' };
  const labels = { overview: isZh ? '总览' : 'Overview', custom: isZh ? '自定义' : 'Custom', codex: 'Codex', opencode: 'OpenCode', speech: isZh ? '语音模型' : 'Speech Model' };
  const nav = ['overview', 'custom', 'codex', 'opencode', 'speech'].map((key) =>
    '<button class="ph-settings-tab' + (tab === key ? ' active' : '') + '" type="button" onclick="switchSettingsTab(\'' + key + '\')">'
      + '<span class="ph-settings-tab-label">' + labels[key] + '</span></button>'
  ).join('');
  const dm = data.config?.defaultModel || {};
  const currentPreset = presets.find((preset) => dm.model === preset.model && dm.provider === preset.provider && dm.baseUrl === preset.baseUrl);
  const speechConfig = getClawSpeechModelConfig() || {};
  const speechPreset = getClawSpeechPresets().find((preset) => preset.baseUrl === speechConfig.baseUrl && preset.apiKey === speechConfig.apiKey && preset.model === speechConfig.model && (preset.apiType || 'chat') === (speechConfig.apiType || 'chat'));
  const editing = Number.isInteger(window.ClawFW.settingsEditing) ? window.ClawFW.settingsEditing : null;
  const speechEditing = tab === 'speech' && window.ClawFW._speechEditing != null ? window.ClawFW._speechEditing : null;

  let content = '';
  if (tab === 'overview') {
    content = renderOverviewContent(presets, dm, currentPreset, isZh);
  } else if (tab === 'speech') {
    const banner = speechPreset ? renderActiveModelBanner(isZh, speechPreset.name || speechPreset.model, speechApiTypeLabel(speechPreset.apiType) + ' · ' + (speechPreset.model || '—')) : '';
    const speechParts = renderSpeechModelSection(isZh);
    content = banner + speechParts.content + (speechEditing === null ? '<div class="settings-actions settings-speech-add"><button class="settings-btn settings-btn-primary" type="button" onclick="addSpeechPreset()">+ ' + (isZh ? '添加预设' : 'Add preset') + '</button></div>' : '');
  } else if (tab === 'custom') {
    const customPresets = presets.map((p, idx) => ({ p, idx })).filter(({ p }) => !p.catalogProvider && p.authType !== 'oauth-codex' && !['OpenCode Zen', 'OpenCode Go'].includes(p.providerName));
    content = '<div class="settings-section"><div class="settings-section-title">' + (isZh ? '自定义模型' : 'Custom models') + '</div>'
      + '<div class="settings-presets-grid">' + (customPresets.length ? customPresets.map(({ p, idx }) => modelCatalogPresetCard(p, idx, isZh, false)).join('') : '<div class="ph-settings-empty">' + (isZh ? '尚无自定义模型' : 'No custom models yet') + '</div>') + '</div>'
      + '<div class="settings-actions"><button class="settings-btn settings-btn-primary" type="button" onclick="addSettingsPreset()">+ ' + (isZh ? '添加自定义模型' : 'Add custom model') + '</button></div></div>';
  } else {
    const isCodex = tab === 'codex';
    const selected = window.ClawFW.modelCatalogSelection || {};
    const multi = window.ClawFW.modelCatalogMulti === true;
    const providerPresets = presets.map((p, idx) => ({ p, idx })).filter(({ p }) => p.catalogProvider === tab || (isCodex && p.authType === 'oauth-codex') || (!isCodex && ['OpenCode Zen', 'OpenCode Go'].includes(p.providerName)));
    const addedIds = new Set(providerPresets.map(({ p }) => p.model));
    const available = catalog.models.filter((model) => !addedIds.has(model.id));
    const statusHtml = catalog.error
      ? '<div class="settings-catalog-status error">' + escapeHtml(catalog.error) + '</div>'
      : catalog.loading ? '<div class="settings-catalog-status">' + (isZh ? '正在刷新模型目录…' : 'Refreshing model catalog…') + '</div>'
      : catalog.loaded ? '<div class="settings-catalog-status">' + (isZh ? '目录已更新' : 'Catalog refreshed') + '</div>' : '';
    const connectionStatus = window.ClawFW.oauthConnectionStatus || 'unknown';
    const connectionCard = isCodex
      ? '<div class="settings-section settings-connection-card"><div class="settings-connection-head"><div><div class="settings-connection-title">OpenAI Auth</div><div class="settings-connection-description">' + (isZh ? '通过 OpenAI 账户连接 Codex 模型目录' : 'Connect your OpenAI account to discover Codex models') + '</div></div><span class="settings-connection-status ' + (connectionStatus === 'connected' ? 'connected' : '') + '">' + (connectionStatus === 'connected' ? (isZh ? '已连接' : 'Connected') : (isZh ? '连接状态' : 'Connection')) + '</span></div><div id="oauth-status-display" class="oauth-status-text"></div><div class="oauth-action-row"><button class="settings-btn settings-btn-primary" type="button" onclick="startOAuthLogin(\'browser\')">' + (isZh ? '浏览器授权登录' : 'Login in Browser') + '</button><button class="settings-btn settings-btn-secondary" type="button" onclick="startOAuthLogin(\'device\')">' + (isZh ? '设备码登录' : 'Device Code Login') + '</button><button class="settings-btn settings-btn-secondary settings-btn-quiet" type="button" onclick="logoutOAuth()">' + (isZh ? '登出' : 'Logout') + '</button></div></div>'
      : '<div class="settings-section settings-connection-card"><div class="settings-connection-head"><div><div class="settings-connection-title">OpenCode</div><div class="settings-connection-description">' + (isZh ? '配置 API Key 连接以发现可用模型' : 'Configure an API key to discover models') + '</div></div><span class="settings-connection-status ' + (connections.opencode?.hasApiKey ? 'connected' : '') + '">' + (connections.opencode?.hasApiKey ? (isZh ? '已配置' : 'Configured') : (isZh ? '未配置' : 'Not configured')) + '</span></div><div class="settings-connection-fields"><div class="settings-field"><label>API Key</label><div class="settings-key-field"><input class="settings-input" id="settings-opencode-key" type="password" autocomplete="new-password" value="' + escapeHtml(connections.opencode?.apiKey || '') + '" placeholder="' + (connections.opencode?.hasApiKey ? (isZh ? '已保存，留空保持不变' : 'Saved; leave blank to keep') : 'sk-…') + '"><button class="settings-key-visibility" type="button" aria-label="' + (isZh ? '显示或隐藏 API Key' : 'Show or hide API key') + '" title="' + (isZh ? '显示或隐藏' : 'Show or hide') + '" onclick="toggleOpenCodeKeyVisibility()"><svg id="opencode-eye-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg><svg id="opencode-eye-off-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg></button></div></div><button class="settings-btn settings-btn-primary" type="button" onclick="saveModelConnection()">' + (isZh ? '保存连接' : 'Save connection') + '</button></div></div>';
    const addedGrid = providerPresets.length ? providerPresets.map(({ p, idx }) => modelCatalogPresetCard(p, idx, isZh, catalog.loaded && !catalog.models.some((m) => m.id === p.model))).join('') : '<div class="ph-settings-empty">' + (isZh ? '尚未添加模型' : 'No models added') + '</div>';
    // 可添加行索引寻址（inline onclick 传索引而非模型 id，避免注入与转义问题）
    window.ClawFW.modelCatalogAvailable = available.map((m) => m.id);
    const selectedCount = available.filter((m) => selected[m.id]).length;
    const modelInfoSpan = (m) => '<span class="settings-catalog-info"><strong>' + escapeHtml(m.displayName || m.id) + '</strong><small>' + escapeHtml(m.id) + '</small></span>';
    const availableHtml = available.length ? available.map((m, i) => multi
      ? '<label class="settings-catalog-model"><input type="checkbox" value="' + escapeHtml(m.id) + '" onchange="setCatalogModelSelection(this)" ' + (selected[m.id] ? 'checked' : '') + '>' + modelInfoSpan(m) + '</label>'
      : '<div class="settings-catalog-model" onclick="addCatalogModel(\'' + tab + '\', ' + i + ')">' + modelInfoSpan(m) + '<span class="settings-catalog-add">+</span></div>'
    ).join('') : '<div class="ph-settings-empty">' + (catalog.loaded ? (isZh ? '没有可添加的模型' : 'No models available to add') : (isZh ? '刷新目录以查找模型' : 'Refresh the catalog to discover models')) + '</div>';
    const tierSelect = '<select class="settings-input settings-catalog-tier" id="settings-opencode-tier" data-claw-select data-claw-compact="true" onchange="onOpenCodeServiceChange()"><option value="zen"' + (connections.opencode?.tier !== 'go' ? ' selected' : '') + '>Zen</option><option value="go"' + (connections.opencode?.tier === 'go' ? ' selected' : '') + '>Go</option></select>';
    const toolbarActions = (!isCodex ? tierSelect : '')
      + '<button class="settings-btn settings-btn-secondary" type="button" onclick="toggleCatalogMultiSelect()">' + (multi ? (isZh ? '退出多选' : 'Exit multi-select') : (isZh ? '多选' : 'Multi-select')) + '</button>'
      + (multi ? '<button class="settings-btn settings-btn-primary" type="button" id="settings-catalog-add-selected" onclick="addSelectedCatalogModels(\'' + tab + '\')">' + (isZh ? '添加所选' + (selectedCount ? '（' + selectedCount + '）' : '') : 'Add selected' + (selectedCount ? ' (' + selectedCount + ')' : '')) + '</button>' : '')
      + '<button class="settings-btn settings-btn-secondary" type="button" onclick="refreshModelCatalog(\'' + tab + '\')">' + (isZh ? '刷新' : 'Refresh') + '</button>';
    content = connectionCard
      + '<div class="settings-section"><div class="settings-section-title">' + (isZh ? '已添加' : 'Added') + '</div><div class="settings-presets-grid">' + addedGrid + '</div></div>'
      + '<div class="settings-section"><div class="settings-catalog-toolbar"><div class="settings-section-title">' + (isZh ? '可添加' : 'Available') + '</div><div class="settings-catalog-status">' + statusHtml + '</div><div class="settings-actions">' + toolbarActions + '</div></div><div class="settings-catalog-list">' + availableHtml + '</div></div>';
  }

  const body = editing !== null ? renderSettingsEditForm(editing, presets, isZh) : content;
  let footer = '';
  if (editing !== null) {
    footer = '<div class="settings-footer"><div class="settings-actions"><button class="settings-btn settings-btn-secondary" type="button" onclick="cancelSettingsEdit()">' + (isZh ? '取消' : 'Cancel') + '</button><button class="settings-btn settings-btn-primary" type="button" onclick="saveSettingsPreset(' + editing + ')">' + (isZh ? '保存' : 'Save') + '</button></div></div>';
  } else if (tab === 'speech' && speechEditing !== null) {
    footer = '<div class="settings-footer"><div class="settings-actions"><button class="settings-btn settings-btn-secondary" type="button" onclick="cancelSpeechPresetEdit()">' + (isZh ? '取消' : 'Cancel') + '</button><button class="settings-btn settings-btn-primary" type="button" data-edit="' + speechEditing + '" onclick="saveSpeechPreset(this.dataset.edit)">' + (isZh ? '保存' : 'Save') + '</button></div></div>';
  }
  // 连接卡片输入状态跨渲染保留：目录刷新等重渲染不清空正在编辑的 API Key 与显隐状态
  const opencodeKeyEl = document.getElementById('settings-opencode-key');
  const opencodeKeySnapshot = opencodeKeyEl ? { value: opencodeKeyEl.value, visible: opencodeKeyEl.type === 'text' } : null;
  host.innerHTML = '<div class="feature-detail-overlay"><div class="feature-detail-window ph-settings-window">'
    + '<div class="feature-detail-head"><div><div class="feature-detail-title">' + (isZh ? '设置' : 'Settings') + '</div><div class="feature-detail-subtitle">' + (isZh ? '管理模型连接与模型' : 'Manage model connections and models') + '</div></div><button class="feature-detail-close" type="button" onclick="closeSettings()">×</button></div>'
    + '<div class="ph-settings-layout"><div class="ph-settings-sidebar">' + nav + '</div><div class="ph-settings-content settings-catalog-page">' + body + '</div></div>'
    + footer
    + '</div></div>';
  if (opencodeKeySnapshot) {
    const restoredKey = document.getElementById('settings-opencode-key');
    if (restoredKey) {
      restoredKey.value = opencodeKeySnapshot.value;
      if (opencodeKeySnapshot.visible) {
        restoredKey.type = 'text';
        const eyeOn = document.getElementById('opencode-eye-icon');
        const eyeOff = document.getElementById('opencode-eye-off-icon');
        if (eyeOn) eyeOn.style.display = 'none';
        if (eyeOff) eyeOff.style.display = 'block';
      }
    }
  }
  // 编辑表单：先填充思考强度选项，再交给 ClawSelect 增强原生下拉
  if (editing !== null && typeof window.populateThinkingEffortOptions === 'function') window.populateThinkingEffortOptions();
  if (window.ClawSelect) window.ClawSelect.enhanceAll(host);
  if (editing !== null) {
    const protocolSelect = document.getElementById('settings-preset-provider');
    const baseUrlInput = document.getElementById('settings-preset-baseurl');
    if (protocolSelect && baseUrlInput) {
      protocolSelect.addEventListener('change', syncBaseEndpointBadge);
      baseUrlInput.addEventListener('input', syncBaseEndpointBadge);
      document.getElementById('settings-preset-model')?.addEventListener('input', syncBaseEndpointBadge);
      syncBaseEndpointBadge();
    }
    if (presets[editing]?.authType === 'oauth-codex') refreshOAuthStatus();
  }
}

async function refreshModelCatalog(provider) {
  const catalogs = window.ClawFW.modelCatalogs || (window.ClawFW.modelCatalogs = {});
  const current = catalogs[provider] || { models: [], loaded: false, loading: false, error: '' };
  if (current.loading) return;
  catalogs[provider] = { ...current, loading: true, error: '' };
  renderSettingsOverlay();
  try {
    const response = await fetch('/protoclaw/model_catalog/' + encodeURIComponent(provider), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
    catalogs[provider] = { models: Array.isArray(data.models) ? data.models : [], loaded: true, loading: false, error: '' };
  } catch (error) {
    catalogs[provider] = { ...current, loading: false, error: error.message || String(error) };
  }
  renderSettingsOverlay();
}

function setCatalogModelSelection(input) {
  const selected = window.ClawFW.modelCatalogSelection || (window.ClawFW.modelCatalogSelection = {});
  if (input.checked) selected[input.value] = true;
  else delete selected[input.value];
  // 就地更新按钮计数，不整体重渲染（避免勾选时列表跳动）
  const addBtn = document.getElementById('settings-catalog-add-selected');
  if (addBtn) {
    const count = document.querySelectorAll('.settings-catalog-list input[type="checkbox"]:checked').length;
    const isZh = currentLanguage === 'zh';
    addBtn.textContent = isZh ? '添加所选' + (count ? '（' + count + '）' : '') : 'Add selected' + (count ? ' (' + count + ')' : '');
  }
}

function toggleOpenCodeKeyVisibility() {
  const input = document.getElementById('settings-opencode-key');
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  const eyeOn = document.getElementById('opencode-eye-icon');
  const eyeOff = document.getElementById('opencode-eye-off-icon');
  if (eyeOn) eyeOn.style.display = show ? 'none' : 'block';
  if (eyeOff) eyeOff.style.display = show ? 'block' : 'none';
}

function toggleCatalogMultiSelect() {
  window.ClawFW.modelCatalogMulti = window.ClawFW.modelCatalogMulti !== true;
  window.ClawFW.modelCatalogSelection = {};
  renderSettingsOverlay();
}

async function onOpenCodeServiceChange() {
  // 切换 Zen/Go 即保存连接（空 Key 时服务端保留现有值）并按新服务刷新目录
  await saveModelConnection();
}

async function addCatalogModels(provider, ids) {
  const data = window.ClawFW.settingsData;
  const catalog = window.ClawFW.modelCatalogs?.[provider];
  if (!data || !catalog || !ids.length) return;
  const chosen = new Set(ids);
  for (const model of catalog.models) {
    if (!chosen.has(model.id)) continue;
    const isCodex = provider === 'codex';
    const protocolInfo = isCodex ? { protocol: 'openai', apiSurface: 'responses' } : resolveOpenCodeProtocolClient(model.id);
    const name = (isCodex ? 'Codex ' : 'OpenCode ') + model.id;
    if (data.presets.some((preset) => preset.catalogProvider === provider && preset.model === model.id)) continue;
    data.presets.push({
      name, providerName: isCodex ? 'OpenAI Auth' : 'OpenCode ' + ((data.connections?.opencode?.tier === 'go') ? 'Go' : 'Zen'),
      catalogProvider: provider, provider: protocolInfo.protocol, apiSurface: protocolInfo.apiSurface,
      authType: isCodex ? 'oauth-codex' : '', clientId: isCodex ? 'app_EMoamEEZ73f0CkXaXp7hrann' : '',
      model: model.id, baseUrl: isCodex ? 'https://chatgpt.com/backend-api/codex' : (data.connections?.opencode?.tier === 'go' ? OPENCODE_GO_BASE_URL : OPENCODE_ZEN_BASE_URL),
      apiKey: '', thinkingEffort: isCodex ? (model.thinkingEffort || null) : null,
      thinkingBudgetTokens: null, maxTokens: null, temperature: null, vision: false, starred: false,
      contextLength: model.contextLength || (isCodex ? null : 200000), compressRatio: 80, customHeaders: [],
    });
  }
  window.ClawFW.modelCatalogSelection = {};
  await saveSettingsConfig();
}

async function addCatalogModel(provider, rowIdx) {
  const modelId = (window.ClawFW.modelCatalogAvailable || [])[rowIdx];
  if (!modelId) return;
  await addCatalogModels(provider, [modelId]);
}

async function addSelectedCatalogModels(provider) {
  const checks = document.querySelectorAll('.settings-catalog-list input[type="checkbox"]:checked');
  await addCatalogModels(provider, Array.from(checks, (input) => input.value));
}

async function saveModelConnection() {
  const key = document.getElementById('settings-opencode-key')?.value || '';
  const tier = document.getElementById('settings-opencode-tier')?.value === 'go' ? 'go' : 'zen';
  const response = await fetch('/protoclaw/model_connections', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ opencode: { apiKey: key, tier } }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) { alert(result.error || 'Failed to save connection'); return; }
  window.ClawFW.settingsData.connections = { opencode: result.opencode };
  renderSettingsOverlay();
  if (result.opencode?.hasApiKey) refreshModelCatalog('opencode');
}

function modelCatalogPresetCard(preset, idx, isZh, missing) {
  const providerLabel = preset.catalogProvider === 'codex' || preset.authType === 'oauth-codex' ? 'Codex' : (preset.catalogProvider === 'opencode' || ['OpenCode Zen', 'OpenCode Go'].includes(preset.providerName) ? 'OpenCode' : (preset.provider || 'Custom'));
  return '<div class="settings-preset-card"><div class="settings-preset-info" onclick="editSettingsPreset(' + idx + ')"><div class="settings-preset-name">' + escapeHtml(preset.name || preset.model) + '</div><div class="settings-preset-detail">' + escapeHtml(providerLabel + ' · ' + preset.model) + (missing ? ' <span class="preset-tag">' + (isZh ? '目录中不存在' : 'Not in catalog') + '</span>' : '') + '</div></div><div class="settings-preset-actions"><button class="settings-icon-btn" type="button" title="' + (isZh ? '详情' : 'Details') + '" onclick="editSettingsPreset(' + idx + ')">›</button><button class="settings-icon-btn danger" type="button" title="' + (isZh ? '移除' : 'Remove') + '" onclick="deleteSettingsPreset(' + idx + ')">×</button></div></div>';
}

function renderSettingsOverlay() {
  const host = ensureSettingsHost();
  if (!window.ClawFW.settingsOpen) {
    host.innerHTML = '';
    return;
  }
  const data = window.ClawFW.settingsData;
  if (data) {
    renderModelCatalogSettingsOverlay(host, data);
    return;
  }
  const isZh = currentLanguage === 'zh';
  host.innerHTML = '<div class="feature-detail-overlay"><div class="feature-detail-window ph-settings-window">'
    + '<div class="feature-detail-head"><div><div class="feature-detail-title">' + (isZh ? '设置' : 'Settings') + '</div><div class="feature-detail-subtitle">' + (isZh ? '管理模型连接与模型' : 'Manage model connections and models') + '</div></div><button class="feature-detail-close" type="button" onclick="closeSettings()">×</button></div>'
    + '<div class="ph-settings-empty">' + (isZh ? '正在加载…' : 'Loading…') + '</div>'
    + '</div></div>';
}

const OPENAI_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const ANTHROPIC_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

function renderThinkingEffortSelect(preset, isZh) {
  const current = preset.thinkingEffort || '';
  return '<select class="settings-input" data-claw-select id="settings-preset-thinking-effort" '
    + 'data-provider="' + (preset.provider || 'anthropic') + '" '
    + 'data-current="' + current + '">'
    + '</select>';
}

window.onThinkingToggleChange = function() {
  let cb = document.getElementById('settings-preset-thinking-enabled');
  let config = document.getElementById('settings-thinking-config');
  if (!cb || !config) return;
  config.style.display = cb.checked ? '' : 'none';
  let errEl = document.getElementById('settings-thinking-budget-error');
  if (errEl) errEl.style.display = 'none';
};

window.onThinkingBudgetInput = function() {
  let input = document.getElementById('settings-preset-thinking-budget');
  let errEl = document.getElementById('settings-thinking-budget-error');
  if (!input || !errEl) return;
  let isZh = currentLanguage === 'zh';
  let raw = input.value.trim();
  if (raw !== '') {
    let val = parseInt(raw, 10);
    if (isNaN(val) || val < 512) {
      errEl.textContent = isZh ? '思考预算至少为 512 tokens' : 'Thinking budget must be at least 512 tokens';
      errEl.style.display = '';
      input.classList.add('invalid');
    } else {
      errEl.style.display = 'none';
      input.classList.remove('invalid');
    }
  } else {
    errEl.style.display = 'none';
    input.classList.remove('invalid');
  }
};

window.populateThinkingEffortOptions = function() {
  const select = document.getElementById('settings-preset-thinking-effort');
  if (!select) return;
  const provider = select.dataset.provider || 'anthropic';
  const selectedValue = select.dataset.current || select.value || '';
  const isZh = currentLanguage === 'zh';
  const efforts = provider === 'openai' ? OPENAI_EFFORTS : ANTHROPIC_EFFORTS;
  let html = '<option value="" ' + (selectedValue === '' ? 'selected' : '') + '>'
    + (isZh ? '默认（厂商决定）' : 'Default (vendor decides)') + '</option>';
  for (const effort of efforts) {
    html += '<option value="' + effort + '" ' + (selectedValue === effort ? 'selected' : '') + '>' + effort + '</option>';
  }
  select.innerHTML = html;
  select.dataset.current = '';
};

window.onProviderChangeUpdateThinking = function() {
  const select = document.getElementById('settings-preset-thinking-effort');
  if (!select) return;
  const providerEl = document.getElementById('settings-preset-provider');
  const raw = providerEl?.value || 'anthropic';
  select.dataset.provider = raw.startsWith('openai') ? 'openai' : 'anthropic';
  const selectedValue = select.value || '';
  select.dataset.current = selectedValue;
  if (typeof window.populateThinkingEffortOptions === 'function') window.populateThinkingEffortOptions();
};

function syncBaseEndpointBadge() {
  const protocolSelect = document.getElementById('settings-preset-provider');
  const baseUrlInput = document.getElementById('settings-preset-baseurl');
  const modelInput = document.getElementById('settings-preset-model');
  const suffixBadge = document.querySelector('.base-url-combo .base-url-suffix');
  const combo = document.querySelector('.base-url-combo');
  if (!protocolSelect || !baseUrlInput || !suffixBadge || !combo) return;
  const isZh = currentLanguage === 'zh';
  const raw = baseUrlInput.value.trim();
  const normalized = normalizeModelBaseUrl(raw);
  const duplicate = !!raw && normalized !== raw.replace(/\/+$/, '');
  const suffix = getModelEndpointSuffix(protocolSelect.value, modelInput?.value || '', normalized);
  combo.classList.toggle('base-url-duplicate', duplicate);
  suffixBadge.classList.toggle('base-url-suffix-duplicate', duplicate);
  suffixBadge.title = duplicate
    ? (isZh ? '该路径由服务自动拼接，保存时会移除重复部分' : 'This path is appended automatically and duplicated input is removed when saved')
    : (isZh ? '服务自动追加' : 'Added automatically');
  suffixBadge.innerHTML = '<span class="base-url-plus">+</span>' + escapeHtml(suffix);
}
// Exposed for oauth-flow.js: its protocol/tier/model handlers mutate the Base
// URL and Model fields programmatically, which fires no input events.
window.syncBaseEndpointBadge = syncBaseEndpointBadge;

const MODEL_ENDPOINT_SUFFIXES = ['/chat/completions', '/responses', '/messages'];

function stripModelEndpointSuffix(rawUrl) {
  const url = String(rawUrl || '').trim().replace(/\/+$/, '');
  if (!url) return '';
  const lower = url.toLowerCase();
  const suffix = MODEL_ENDPOINT_SUFFIXES.find(item => lower.endsWith(item));
  if (!suffix) return url;
  return url.slice(0, url.length - suffix.length).replace(/\/+$/, '');
}

function normalizeModelBaseUrl(rawUrl) {
  return stripModelEndpointSuffix(rawUrl);
}

const OPENCODE_ZEN_BASE_URL = 'https://opencode.ai/zen/v1';
const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1';

function getModelEndpointSuffix(protocolValue, modelId, baseUrl) {
  if (protocolValue === 'anthropic') {
    return /\/v\d+$/i.test(String(baseUrl || '').replace(/\/+$/, '')) ? '/messages' : '/v1/messages';
  }
  if (protocolValue === 'openai-responses' || protocolValue === 'openai-oauth') {
    return '/responses';
  }
  if (protocolValue === 'opencode') {
    const model = String(modelId || '').trim().toLowerCase();
    if (model.startsWith('claude-')) return '/v1/messages';
    if (model.startsWith('gpt-') || model.startsWith('grok-')) return '/responses';
    return '/chat/completions';
  }
  return '/chat/completions';
}

function renderBaseEndpointField(preset, protocolValue, baseUrl, isZh) {
  const raw = String(baseUrl || '').trim();
  const normalized = normalizeModelBaseUrl(raw);
  const duplicate = !!raw && normalized !== raw.replace(/\/+$/, '');
  const inputClass = 'settings-input base-url-input';
  const suffixClass = duplicate ? 'base-url-suffix base-url-suffix-duplicate' : 'base-url-suffix';
  const comboClass = duplicate ? 'base-url-combo base-url-duplicate' : 'base-url-combo';
  const suffixTitle = duplicate
    ? (isZh ? '该路径由服务自动拼接，保存时会移除重复部分' : 'This path is appended automatically and duplicated input is removed when saved')
    : (isZh ? '服务自动追加' : 'Added automatically');
  const suffix = getModelEndpointSuffix(protocolValue, preset.model || '', normalized);
  const inputValue = escapeHtml(raw);
  return [
    '<div class="settings-field">',
    '<label>Base URL</label>',
    '<div class="' + comboClass + '" role="group" aria-label="Base URL">',
    '<input class="' + inputClass + '" id="settings-preset-baseurl" type="text" value="' + inputValue + '" placeholder="' + escapeHtml(protocolValue === 'anthropic' ? 'https://open.bigmodel.cn/api/anthropic' : 'https://api.example.com/v1') + '"' + (protocolValue === 'opencode' ? ' readonly' : '') + '>',
    '<span class="' + suffixClass + '" title="' + escapeHtml(suffixTitle) + '"><span class="base-url-plus">+</span>' + escapeHtml(suffix) + '</span>',
    '</div>',
    '</div>',
  ].join('');
}

function renderSettingsEditForm(editIdx, presets, isZh) {
  const preset = presets[editIdx] || {};
  let openCodeTier = preset.providerName === 'OpenCode Go' || preset.baseUrl === OPENCODE_GO_BASE_URL ? 'go' : 'zen';
  let isOpenCodePreset = preset.providerName === 'OpenCode Zen' || preset.providerName === 'OpenCode Go'
    || preset.baseUrl === OPENCODE_ZEN_BASE_URL || preset.baseUrl === OPENCODE_GO_BASE_URL;
  let dropdownVal = preset.authType === 'oauth-codex' ? 'openai-oauth'
    : (isOpenCodePreset ? 'opencode'
    : (preset.provider === 'openai' && (preset.apiSurface || 'chat') === 'responses' ? 'openai-responses'
    : (preset.provider || 'anthropic')));
  let isOAuthMode = dropdownVal === 'openai-oauth';
  let isOpenCodeMode = dropdownVal === 'opencode';
  const resolvedBaseUrl = preset.baseUrl || (isOAuthMode ? 'https://chatgpt.com/backend-api/codex' : (isOpenCodeMode ? (openCodeTier === 'go' ? OPENCODE_GO_BASE_URL : OPENCODE_ZEN_BASE_URL) : ''));
  // 目录来源（Codex / OpenCode）预设：连接身份只读展示，不提供 API 类型切换
  const isCatalogPreset = preset.catalogProvider === 'codex' || preset.catalogProvider === 'opencode' || isOAuthMode || isOpenCodePreset;
  const connectionHtml = isCatalogPreset ? [
    '<div class="settings-field">',
    '<label>' + (isZh ? '名称' : 'Name') + '</label>',
    '<input class="settings-input" id="settings-preset-name" type="text" value="' + escapeHtml(preset.name || '') + '" placeholder="' + (isZh ? '例如：智谱 GLM-5' : 'e.g. ZhiPu GLM-5') + '">',
    '</div>',
    '<div class="settings-row">',
    '<div class="settings-field">',
    '<label>' + (isZh ? '来源' : 'Source') + '</label>',
    '<div class="settings-static-value">' + escapeHtml(preset.catalogProvider === 'codex' || preset.authType === 'oauth-codex' ? 'Codex · OpenAI Auth' : 'OpenCode · ' + (openCodeTier === 'go' ? 'Go' : 'Zen')) + '</div>',
    '</div>',
    '<div class="settings-field">',
    '<label>Model</label>',
    '<div class="settings-static-value">' + escapeHtml(preset.model || '—') + '</div>',
    '</div>',
    '</div>',
  ].join('') : [
    '<div class="settings-field">',
    '<label>' + (isZh ? '名称' : 'Name') + '</label>',
    '<input class="settings-input" id="settings-preset-name" type="text" value="' + escapeHtml(preset.name || '') + '" placeholder="' + (isZh ? '例如：智谱 GLM-5' : 'e.g. ZhiPu GLM-5') + '">',
    '</div>',
    '<div class="settings-row">',
    '<div class="settings-field">',
    '<label>' + (isZh ? '接口协议' : 'Protocol') + '</label>',
    '<select class="settings-input" data-claw-select id="settings-preset-provider" onchange="onProtocolChange()">',
    '<option value="anthropic"' + (dropdownVal === 'anthropic' ? ' selected' : '') + '>Anthropic</option>',
    '<option value="openai"' + (dropdownVal === 'openai' ? ' selected' : '') + '>OpenAI Chat</option>',
    '<option value="openai-responses"' + (dropdownVal === 'openai-responses' ? ' selected' : '') + '>OpenAI Responses</option>',
    '<option value="opencode"' + (dropdownVal === 'opencode' ? ' selected' : '') + '>OpenCode</option>',
    '<option value="openai-oauth"' + (dropdownVal === 'openai-oauth' ? ' selected' : '') + '>' + (isZh ? 'OpenAI Auth (OAuth 设备码登录)' : 'OpenAI Auth (OAuth Device Login)') + '</option>',
    '</select>',
    '</div>',
    '<div class="settings-field">',
    '<label>Model</label>',
    '<input class="settings-input" id="settings-preset-model" type="text" value="' + escapeHtml(preset.model || '') + '" placeholder="glm-5-turbo">',
    '</div>',
    '</div>',
    renderBaseEndpointField(preset, dropdownVal, resolvedBaseUrl, isZh),
    /* API Key section (hidden in OAuth mode) */
    '<div id="api-key-section"' + (isOAuthMode ? ' style="display:none;"' : '') + '>',
    '<div class="settings-field">',
    '<label>API Key</label>',
    '<div style="position:relative;display:flex;align-items:stretch;">',
    '<input class="settings-input" id="settings-preset-apikey" type="password" value="' + escapeHtml(preset.apiKey || '') + '" placeholder="sk-..." style="padding-right:40px;">',
    '<button type="button" onclick="toggleApiKeyVisibility()" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;padding:4px;display:flex;align-items:center;justify-content:center;color:var(--text-secondary);transition:color 0.2s;" onmouseover="this.style.color=\'var(--text-primary)\'" onmouseout="this.style.color=\'var(--text-secondary)\'" title="' + (isZh ? '显示/隐藏' : 'Show/Hide') + '">',
    '<svg id="apikey-eye-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
    '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>',
    '<circle cx="12" cy="12" r="3"></circle>',
    '</svg>',
    '<svg id="apikey-eye-off-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;">',
    '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>',
    '<line x1="1" y1="1" x2="23" y2="23"></line>',
    '</svg>',
    '</button>',
    '</div>',
    '</div>',
    '</div>',
    /* OAuth section (hidden in API Key mode) */
    '<div id="oauth-section"' + (isOAuthMode ? '' : ' style="display:none;"') + '>',
    '<div class="settings-field">',
    '<label>Client ID</label>',
    '<input class="settings-input" id="settings-preset-clientid" type="text" value="' + escapeHtml(preset.clientId || 'app_EMoamEEZ73f0CkXaXp7hrann') + '" placeholder="app_EMoamEEZ73f0CkXaXp7hrann">',
    '<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">' + (isZh ? 'OpenAI 应用注册的 client_id' : 'OpenAI application client_id') + '</div>',
    '</div>',
    '<div class="settings-field" id="oauth-login-area">',
    renderOAuthLoginArea(preset, isZh),
    '</div>',
    '</div>',
    /* OpenCode section (visible only in OpenCode mode) */
    '<div id="opencode-section"' + (isOpenCodeMode ? '' : ' style="display:none;"') + '>',
    '<div class="settings-field">',
    '<label>' + (isZh ? 'OpenCode 服务' : 'OpenCode service') + '</label>',
    '<select class="settings-input" data-claw-select id="settings-preset-opencode-tier" onchange="onOpenCodeTierChange()">',
    '<option value="zen"' + (openCodeTier === 'zen' ? ' selected' : '') + '>Zen</option>',
    '<option value="go"' + (openCodeTier === 'go' ? ' selected' : '') + '>Go</option>',
    '</select>',
    '</div>',
    '<div class="settings-field">',
    '<label>' + (isZh ? 'OpenCode 模型' : 'OpenCode model') + '</label>',
    '<div style="display:flex;gap:6px;align-items:flex-start;">',
    '<select class="settings-input" data-claw-select id="settings-preset-opencode-model" style="flex:1;min-width:0;" onchange="onOpenCodeModelSelect()">',
    '<option value="">' + (isZh ? '— 点击加载模型列表 —' : '— Click Load Models —') + '</option>',
    (preset.model ? '<option value="' + escapeHtml(preset.model) + '" selected>' + escapeHtml(preset.model) + '</option>' : ''),
    '</select>',
    '<button class="settings-btn settings-btn-secondary" type="button" style="flex-shrink:0;" onclick="fetchOpenCodeModels()">' + (isZh ? '加载' : 'Load') + '</button>',
    '</div>',
    '<div style="font-size:11px;color:var(--text-secondary);margin-top:4px;">' + (isZh
      ? '在 OpenCode Console 创建 API Key；Go 订阅及其额度由 OpenCode 官方管理。'
      : 'Create an API key in the OpenCode Console. OpenCode manages Go subscriptions and limits.') + '</div>',
    '</div>',
    '</div>',
  ].join('');

  return [
    '<div class="settings-section">',

    connectionHtml,

    // ── 模型能力 ──
    '<div class="settings-divider"></div>',
    '<div class="settings-subsection-label">' + (isZh ? '模型能力' : 'Capabilities') + '</div>',
    '<div class="settings-row">',
    '<div class="settings-field">',
    '<div class="settings-checkbox">',
    '<input type="checkbox" id="settings-preset-thinking-enabled" ' + (preset.thinkingEffort && preset.thinkingEffort !== 'none' && preset.thinkingEffort !== '' ? 'checked' : '') + ' onchange="onThinkingToggleChange()">',
    '<label for="settings-preset-thinking-enabled">' + (isZh ? '启用思考' : 'Enable Thinking') + '</label>',
    '</div>',
    '</div>',
    '<div class="settings-field">',
    '<div class="settings-checkbox">',
    '<input type="checkbox" id="settings-preset-vision" ' + (preset.vision ? 'checked' : '') + '>',
    '<label for="settings-preset-vision">' + (isZh ? '启用视觉输入' : 'Enable Vision Input') + '</label>',
    '</div>',
    '</div>',
    '</div>',
    '<div id="settings-thinking-config"' + (preset.thinkingEffort && preset.thinkingEffort !== 'none' && preset.thinkingEffort !== '' ? '' : ' style="display:none;"') + ' class="settings-sub-config">',
    '<div class="settings-row">',
    '<div class="settings-field">',
    '<label>' + (isZh ? '思考强度' : 'Thinking Effort') + '</label>',
    renderThinkingEffortSelect(preset, isZh),
    '</div>',
    '<div class="settings-field">',
    '<label>' + (isZh ? '思考预算 (tokens)' : 'Thinking Budget (tokens)') + '</label>',
    '<input class="settings-input" id="settings-preset-thinking-budget" type="number" min="512" value="' + (preset.thinkingBudgetTokens || '') + '" placeholder="' + (isZh ? '留空自动分配' : 'Leave empty for auto') + '" oninput="onThinkingBudgetInput()">',
    '<div id="settings-thinking-budget-error" style="font-size:11px;color:#e57373;margin-top:2px;display:none;"></div>',
    '</div>',
    '</div>',
    '</div>',

    // ── 生成参数 ──
    '<div class="settings-divider"></div>',
    '<div class="settings-subsection-label">' + (isZh ? '生成参数' : 'Generation') + '</div>',
    '<div class="settings-row">',
    '<div class="settings-field">',
    '<label>' + (isZh ? '上下文长度' : 'Context Length') + '</label>',
    '<input class="settings-input" id="settings-preset-context-length" type="number" value="' + (preset.contextLength ?? '') + '" placeholder="200000">',
    '</div>',
    '<div class="settings-field">',
    '<label>' + (isZh ? '压缩阈值' : 'Compress Threshold') + '</label>',
    '<input class="settings-input" id="settings-preset-compress-ratio" type="number" min="1" max="100" value="' + (preset.compressRatio ?? 80) + '" placeholder="80">',
    '</div>',
    '</div>',
    '<div class="settings-row">',
    '<div class="settings-field">',
    '<label>Max Output Tokens</label>',
    '<input class="settings-input" id="settings-preset-max-tokens" type="number" value="' + (preset.maxTokens ?? '') + '" placeholder="' + (isZh ? '留空自动计算' : 'Leave empty for auto') + '">',
    '</div>',
    '<div class="settings-field">',
    '<label>Temperature</label>',
    '<input class="settings-input" id="settings-preset-temperature" type="number" step="0.1" min="0" max="2" value="' + (preset.temperature ?? '') + '" placeholder="' + (isZh ? '留空使用默认值' : 'Leave empty for default') + '">',
    '</div>',
    '</div>',

    // ── 高级 ──
    '<div class="settings-divider"></div>',
    '<div class="settings-subsection-label">' + (isZh ? '高级' : 'Advanced') + '</div>',
    /* Custom Headers Section */
    '<div class="settings-field">',
    '<label>' + (isZh ? '自定义请求头' : 'Custom Headers') + '</label>',
    '<div id="settings-headers-container">',
    (Array.isArray(preset.customHeaders) ? preset.customHeaders : []).map(function(h, i) {
      return createSettingsHeaderRowHTML(i, h.key || '', h.value || '', h.valueMode || 'static', isZh);
    }).join(''),
    '</div>',
    '<button class="settings-btn settings-btn-secondary" type="button" style="align-self:flex-start;margin-top:4px;" onclick="addSettingsHeaderRow()">+ ' + (isZh ? '添加 Header' : 'Add Header') + '</button>',
    '<div style="font-size:11px;color:var(--text-secondary);margin-top:4px;">' + (isZh ?
      'UUID v4 / 随机数模式会在每次 API 请求时自动生成新值' :
      'UUID v4 / random mode generates a new value on each API request') + '</div>',
    '</div>',
    '</div>',
  ].join('');
}

function createSettingsHeaderRowHTML(idx, key, value, mode, isZh) {
  let isDynamic = mode === 'uuid' || mode === 'random';
  let modeOptions = [
    '<option value="static"' + (mode === 'static' ? ' selected' : '') + '>' + (isZh ? '固定值' : 'Static') + '</option>',
    '<option value="uuid"' + (mode === 'uuid' ? ' selected' : '') + '>UUID v4</option>',
    '<option value="random"' + (mode === 'random' ? ' selected' : '') + '>' + (isZh ? '随机数' : 'Random') + '</option>',
  ].join('');
  return [
    '<div data-header-row style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">',
    '<input class="settings-input" data-header-key type="text" value="' + escapeHtml(key) + '" placeholder="' + (isZh ? 'Header 名' : 'Header name') + '" style="flex:1;min-width:0;">',
    '<select class="settings-input" data-claw-select data-claw-compact="true" data-header-mode style="width:90px;flex-shrink:0;" onchange="onSettingsHeaderModeChange(this)">' + modeOptions + '</select>',
    '<input class="settings-input" data-header-value type="text" value="' + escapeHtml(value) + '" placeholder="' + (isDynamic ? '(auto)' : (isZh ? 'Header 值' : 'Header value')) + '" style="flex:1;min-width:0;' + (isDynamic ? 'opacity:0.4;' : '') + '"' + (isDynamic ? ' disabled' : '') + '>',
    '<button type="button" onclick="this.closest(\'[data-header-row]\').remove()" style="background:none;border:none;cursor:pointer;padding:6px;color:var(--text-secondary);flex-shrink:0;" title="' + (isZh ? '删除' : 'Delete') + '">',
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>',
    '</button>',
    '</div>',
  ].join('');
}

window.addSettingsHeaderRow = function() {
  let container = document.getElementById('settings-headers-container');
  if (!container) return;
  let isZh = currentLanguage === 'zh';
  container.insertAdjacentHTML('beforeend', createSettingsHeaderRowHTML(container.children.length, '', '', 'static', isZh));
  // Enhance newly added select
  if (window.ClawSelect) window.ClawSelect.enhanceAll(container);
};

window.onSettingsHeaderModeChange = function(select) {
  let row = select.closest('[data-header-row]');
  let valueInput = row ? row.querySelector('[data-header-value]') : null;
  if (!valueInput) return;
  let isDynamic = select.value === 'uuid' || select.value === 'random';
  let isZh = currentLanguage === 'zh';
  valueInput.disabled = isDynamic;
  valueInput.placeholder = isDynamic ? '(auto)' : (isZh ? 'Header 值' : 'Header value');
  valueInput.style.opacity = isDynamic ? '0.4' : '';
};

function addSettingsPreset() {
  const presets = window.ClawFW.settingsData?.presets || [];
  presets.push({
    _isNew: true,
    name: '',
    provider: 'anthropic',
    apiSurface: 'chat',
    authType: '',
    clientId: '',
    model: '',
    baseUrl: '',
    apiKey: '',
    thinkingEffort: 'medium',
    thinkingBudgetTokens: null,
    maxTokens: null,
    temperature: null,
    vision: false,
    starred: false,
    contextLength: 200000,
    compressRatio: 80,
    customHeaders: [],
  });
  window.ClawFW.settingsData = window.ClawFW.settingsData || {};
  window.ClawFW.settingsData.presets = presets;
  window.ClawFW.settingsEditing = presets.length - 1;
  renderSettingsOverlay();
}

function editSettingsPreset(idx) {
  window.ClawFW.settingsEditing = idx;
  renderSettingsOverlay();
}

function cancelSettingsEdit() {
  if (_oauthPollTimer) { clearInterval(_oauthPollTimer); _oauthPollTimer = null; }
  const presets = window.ClawFW.settingsData?.presets || [];
  const editing = window.ClawFW.settingsEditing;
  if (editing !== null && presets[editing]?._isNew) {
    presets.splice(editing, 1);
  }
  window.ClawFW.settingsEditing = null;
  renderSettingsOverlay();
}

async function deleteSettingsPreset(idx) {
  const presets = window.ClawFW.settingsData?.presets || [];
  presets.splice(idx, 1);
  window.ClawFW.settingsData.presets = presets;
  window.ClawFW.settingsEditing = null;
  await saveSettingsConfig();
}

async function toggleSettingsPresetStar(idx) {
  const presets = window.ClawFW.settingsData?.presets || [];
  const preset = presets[idx];
  if (!preset) return;
  preset.starred = preset.starred !== true;
  window.ClawFW.settingsData.presets = presets;
  await saveSettingsConfig();
}

function toggleApiKeyVisibility() {
  const input = document.getElementById('settings-preset-apikey');
  const eyeIcon = document.getElementById('apikey-eye-icon');
  const eyeOffIcon = document.getElementById('apikey-eye-off-icon');

  if (!input) return;

  if (input.type === 'password') {
    input.type = 'text';
    if (eyeIcon) eyeIcon.style.display = 'none';
    if (eyeOffIcon) eyeOffIcon.style.display = 'block';
  } else {
    input.type = 'password';
    if (eyeIcon) eyeIcon.style.display = 'block';
    if (eyeOffIcon) eyeOffIcon.style.display = 'none';
  }
}

async function saveSettingsPreset(idx, opts) {
  const keepEditing = opts?.keepEditing === true;
  if (_oauthPollTimer) { clearInterval(_oauthPollTimer); _oauthPollTimer = null; }
  const presets = window.ClawFW.settingsData?.presets || [];
  const el = (id) => document.getElementById(id);
  const isZh = currentLanguage === 'zh';

  // ── Thinking config ──
  const thinkingEnabled = el('settings-preset-thinking-enabled')?.checked === true;
  let thinkingEffort = null;
  let thinkingBudgetTokens = 0;
  if (thinkingEnabled) {
    thinkingEffort = el('settings-preset-thinking-effort')?.value || null;
    if (!thinkingEffort || thinkingEffort === 'none') {
      thinkingEffort = el('settings-preset-thinking-effort')?.querySelectorAll('option[value]:not([value=""]):not([value="none"])')?.[0]?.value || null;
    }
    const budgetRaw = el('settings-preset-thinking-budget')?.value?.trim();
    if (budgetRaw !== '') {
      const budgetVal = parseInt(budgetRaw, 10);
      if (isNaN(budgetVal) || budgetVal < 512) {
        let errEl = document.getElementById('settings-thinking-budget-error');
        let budgetInput = document.getElementById('settings-preset-thinking-budget');
        if (errEl) {
          errEl.textContent = isZh ? '思考预算至少为 512 tokens' : 'Thinking budget must be at least 512 tokens';
          errEl.style.display = '';
        }
        if (budgetInput) budgetInput.classList.add('invalid');
        return '';
      }
      thinkingBudgetTokens = budgetVal;
    } else {
      thinkingBudgetTokens = null;
    }
  }

  const maxTokensRaw = el('settings-preset-max-tokens')?.value?.trim();
  const tempRaw = el('settings-preset-temperature')?.value?.trim();
  const contextLengthRaw = el('settings-preset-context-length')?.value?.trim();
  const compressRatioRaw = el('settings-preset-compress-ratio')?.value?.trim();
  // 收集自定义请求头
  const customHeaders = [];
  const headerContainer = document.getElementById('settings-headers-container');
  if (headerContainer) {
    headerContainer.querySelectorAll('[data-header-row]').forEach(function(row) {
      const key = row.querySelector('[data-header-key]')?.value?.trim();
      const value = row.querySelector('[data-header-value]')?.value?.trim();
      const mode = row.querySelector('[data-header-mode]')?.value || 'static';
      if (key) customHeaders.push({ key, value: value || '', valueMode: mode });
    });
  }
  const existing = presets[idx] || {};
  const isCatalogPreset = existing.catalogProvider === 'codex' || existing.catalogProvider === 'opencode'
    || existing.authType === 'oauth-codex' || existing.providerName === 'OpenCode Zen' || existing.providerName === 'OpenCode Go';
  const common = {
    name: (el('settings-preset-name')?.value || '').trim(),
    thinkingEffort: thinkingEffort,
    thinkingBudgetTokens: thinkingBudgetTokens,
    maxTokens: maxTokensRaw !== '' ? parseInt(maxTokensRaw, 10) || null : null,
    temperature: tempRaw !== '' ? parseFloat(tempRaw) || null : null,
    vision: el('settings-preset-vision')?.checked === true,
    starred: existing.starred === true,
    contextLength: contextLengthRaw !== '' ? parseInt(contextLengthRaw, 10) || null : null,
    compressRatio: compressRatioRaw !== '' ? Math.max(1, Math.min(100, parseInt(compressRatioRaw, 10) || 80)) : 80,
    countTokenPath: existing.countTokenPath ?? null,
    customHeaders,
  };
  let preset;
  if (isCatalogPreset) {
    // 目录来源预设：连接身份（协议 / 模型 / 端点 / 凭证）不可编辑，原样保留
    preset = {
      ...common,
      providerName: existing.providerName || '',
      provider: existing.provider || 'anthropic',
      apiSurface: existing.apiSurface || 'chat',
      authType: existing.authType || '',
      clientId: existing.clientId || '',
      model: existing.model || '',
      baseUrl: existing.baseUrl || '',
      apiKey: existing.apiKey || '',
      catalogProvider: existing.catalogProvider || '',
    };
  } else {
    const protocolRaw = (el('settings-preset-provider')?.value || 'anthropic').trim();
    const isOAuth = protocolRaw === 'openai-oauth';
    const isOpenCode = protocolRaw === 'opencode';
    const clientIdRaw = el('settings-preset-clientid')?.value?.trim() || '';
    const openCodeTier = el('settings-preset-opencode-tier')?.value === 'go' ? 'go' : 'zen';
    // In OpenCode mode, the model may come from its catalogue or the text input.
    const openCodeModelVal = (el('settings-preset-opencode-model')?.value || '').trim();
    const textModelVal = (el('settings-preset-model')?.value || '').trim();
    const modelVal = isOpenCode ? (openCodeModelVal || textModelVal) : textModelVal;
    const openCodeResolved = isOpenCode ? resolveOpenCodeProtocolClient(modelVal) : null;
    preset = {
      ...common,
      providerName: isOpenCode ? (openCodeTier === 'go' ? 'OpenCode Go' : 'OpenCode Zen') : (existing.providerName || ''),
      provider: isOAuth ? 'openai' : (isOpenCode ? openCodeResolved.protocol : protocolRaw.replace(/^openai-(responses|zen)$/, 'openai')),
      apiSurface: isOAuth ? 'responses' : (isOpenCode ? openCodeResolved.apiSurface : (protocolRaw === 'openai-responses' ? 'responses' : 'chat')),
      authType: isOAuth ? 'oauth-codex' : '',
      clientId: isOAuth ? clientIdRaw : '',
      model: modelVal,
      baseUrl: isOpenCode
        ? (openCodeTier === 'go' ? OPENCODE_GO_BASE_URL : OPENCODE_ZEN_BASE_URL)
        : normalizeModelBaseUrl(el('settings-preset-baseurl')?.value || ''),
      apiKey: isOAuth ? '' : (el('settings-preset-apikey')?.value || '').trim(),
    };
  }
  presets[idx] = preset;
  window.ClawFW.settingsData.presets = presets;
  if (!keepEditing) window.ClawFW.settingsEditing = null;
  // Check if no model is currently active — auto-select the first/newly saved preset
  let config = window.ClawFW.settingsData?.config || {};
  let dm = config.defaultModel || {};
  let hasActive = presets.some(function(p) {
    return dm.model === p.model && dm.provider === p.provider && dm.baseUrl === p.baseUrl;
  });
  await saveSettingsConfig();
  if (!hasActive) {
    await applySettingsPreset(idx);
  }
  if (keepEditing) {
    // Server round-trip refreshed settingsData; surface the assigned provider name
    return window.ClawFW.settingsData?.presets?.[idx]?.providerName || '';
  }
}

async function applySettingsPreset(idx) {
  const presets = window.ClawFW.settingsData?.presets || [];
  const preset = presets[idx];
  if (!preset) return;
  const config = window.ClawFW.settingsData?.config || { defaultModel: {}, agent: {} };
  const defaultModel = {
    provider: preset.provider || 'anthropic',
    apiSurface: preset.apiSurface || 'chat',
    model: preset.model || '',
    baseUrl: preset.baseUrl || '',
    apiKey: preset.apiKey || '',
    authType: preset.authType || '',
  };
  if (preset.thinkingEffort) {
    defaultModel.thinkingEffort = preset.thinkingEffort;
  }
  if (preset.thinkingBudgetTokens != null) {
    defaultModel.thinkingBudgetTokens = preset.thinkingBudgetTokens;
  }
  if (preset.maxTokens != null) {
    defaultModel.maxTokens = preset.maxTokens;
  }
  defaultModel.vision = preset.vision === true;
  config.defaultModel = defaultModel;
  if (preset.temperature != null) {
    config.agent = config.agent || {};
    config.agent.temperature = preset.temperature;
  }
  try {
    const resp = await fetch('/protoclaw/model_config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, presets }),
    });
    if (!resp.ok) {
      const errResult = await resp.json().catch(() => ({}));
      const msg = errResult.details?.length ? errResult.details.join('\n') : (errResult.error || '保存失败');
      alert(msg);
      return;
    }
    const result = await resp.json();
    window.ClawFW.settingsData.config = result.config;
    window.ClawFW.settingsData.presets = result.presets;
    setClawModelPresets(Array.isArray(result?.presets) ? result.presets : []);
    renderSettingsOverlay();
    // Refresh session data to reflect updated model config
    let _agent = typeof getCurrentAgentRecord === 'function' ? getCurrentAgentRecord() : null;
    const logicalAgentId = typeof getLogicalAgentId === 'function' ? getLogicalAgentId(_agent) : _agent?.id;
    if (logicalAgentId) {
      try {
        let freshRes = await fetch('/protoclaw/prebuilt_sessions?agentId=' + encodeURIComponent(logicalAgentId));
        if (freshRes.ok) { _agent.workspace_sessions = await freshRes.json(); }
      } catch {}
    }
    if (typeof updateChatContextBar === 'function') { updateChatContextBar(); }
  } catch (error) {
    console.error('Failed to save model config:', error);
  }
}

async function saveSettingsConfig() {
  const config = window.ClawFW.settingsData?.config || { defaultModel: {}, agent: {} };
  const presets = window.ClawFW.settingsData?.presets || [];
  try {
    const resp = await fetch('/protoclaw/model_config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, presets }),
    });
    if (!resp.ok) {
      const errResult = await resp.json().catch(() => ({}));
      const msg = errResult.details?.length ? errResult.details.join('\n') : (errResult.error || '保存失败');
      alert(msg);
      return;
    }
    const result = await resp.json();
    window.ClawFW.settingsData.config = result.config;
    window.ClawFW.settingsData.presets = result.presets;
    setClawModelPresets(Array.isArray(result?.presets) ? result.presets : []);
    renderSettingsOverlay();
    // Refresh session data to reflect updated model config
    let _agent = typeof getCurrentAgentRecord === 'function' ? getCurrentAgentRecord() : null;
    const logicalAgentId = typeof getLogicalAgentId === 'function' ? getLogicalAgentId(_agent) : _agent?.id;
    if (logicalAgentId) {
      try {
        let freshRes = await fetch('/protoclaw/prebuilt_sessions?agentId=' + encodeURIComponent(logicalAgentId));
        if (freshRes.ok) { _agent.workspace_sessions = await freshRes.json(); }
      } catch {}
    }
    if (typeof updateChatContextBar === 'function') { updateChatContextBar(); }
  } catch (error) {
    console.error('Failed to save config:', error);
  }
}

// ── window 导出 ──────────────────────────────────────────────
window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.switchSettingsTab = function(tab) {
  window.ClawFW.settingsTab = ['overview', 'custom', 'codex', 'opencode', 'speech'].includes(tab) ? tab : 'overview';
  window.ClawFW.settingsEditing = null;
  if (tab === 'speech') window.ClawFW._speechEditing = null;
  renderSettingsOverlay();
  if (tab === 'codex') {
    refreshOAuthStatus();
    refreshModelCatalog('codex');
  } else if (tab === 'opencode') {
    refreshModelCatalog('opencode');
  }
};
window.refreshModelCatalog = refreshModelCatalog;
window.addSelectedCatalogModels = addSelectedCatalogModels;
window.addCatalogModel = addCatalogModel;
window.toggleCatalogMultiSelect = toggleCatalogMultiSelect;
window.onOpenCodeServiceChange = onOpenCodeServiceChange;
window.toggleOpenCodeKeyVisibility = toggleOpenCodeKeyVisibility;
window.saveModelConnection = saveModelConnection;
window.addSettingsPreset = addSettingsPreset;
window.editSettingsPreset = editSettingsPreset;
window.deleteSettingsPreset = deleteSettingsPreset;
window.toggleSettingsPresetStar = toggleSettingsPresetStar;
window.saveSettingsPreset = saveSettingsPreset;
window.applySettingsPreset = applySettingsPreset;
window.cancelSettingsEdit = cancelSettingsEdit;
