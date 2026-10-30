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
  window.ClawFW.codexConnectionView = false;
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
  // 输入中的 API Key 立即落盘（DOM 拆除前同步捕获值），不随面板关闭丢弃
  flushOpenCodeKeySave();
  window.ClawFW.settingsOpen = false;
  window.ClawFW.settingsEditing = null;
  window.ClawFW.codexConnectionView = false;
  window.ClawFW.settingsData = null;
  window.ClawFW._speechEditing = null;
  setClawSpeechPresets([]);
  const host = document.getElementById('settings-overlay-host');
  if (host) host.innerHTML = '';
}

function canonicalProviderOptions(value) {
  const canonicalize = (input) => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonicalize(input[key])]));
    }
    return input;
  };
  return JSON.stringify(canonicalize(value || {}));
}

function modelConfigMatchesPreset(modelConfig, preset) {
  if (modelConfig.model !== preset.model || modelConfig.provider !== preset.provider || modelConfig.baseUrl !== preset.baseUrl) return false;
  return canonicalProviderOptions(modelConfig.providerOptions) === canonicalProviderOptions(preset.providerOptions);
}

function isCodexPreset(preset) {
  return preset?.catalogProvider === 'codex' || preset?.authType === 'oauth-codex';
}

function selectedCodexTier(preset) {
  const tier = preset?.providerOptions?.service_tier;
  return tier === 'fast' ? 'priority' : (typeof tier === 'string' ? tier : '');
}

function getCodexServiceTiers(preset, catalogModel) {
  const tiers = Array.isArray(catalogModel?.serviceTiers)
    ? catalogModel.serviceTiers.filter((tier) => tier && tier.id)
    : Array.isArray(preset?.serviceTiers) ? preset.serviceTiers.filter((tier) => tier && tier.id) : [];
  const legacyFast = (catalogModel?.additionalSpeedTiers || preset?.additionalSpeedTiers || []).includes('fast');
  if (legacyFast && !tiers.some((tier) => tier.id === 'priority')) {
    tiers.push({ id: 'priority', name: 'Fast', description: '' });
  }
  return tiers;
}


function presetSourceLabel(preset) {
  if (!preset) return '—';
  if (preset.catalogProvider === 'codex' || preset.authType === 'oauth-codex') return 'Codex';
  if (preset.catalogProvider === 'opencode' || ['OpenCode Zen', 'OpenCode Go'].includes(preset.providerName)) return 'OpenCode';
  return preset.provider || 'Custom';
}

// 空态设计：对齐右侧面板 feature-panel-empty 的「标题 + 说明」形态
function renderCatalogEmptyState(title, detail) {
  return '<div class="settings-catalog-empty"><strong>' + escapeHtml(title) + '</strong>'
    + (detail ? '<span>' + escapeHtml(detail) + '</span>' : '') + '</div>';
}

function renderActiveModelBanner(isZh, name, detail) {
  return '<div class="settings-section"><div class="settings-active-banner"><div class="settings-active-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 1 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 1-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 1-.33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 1-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 1 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0 .33 1.82V9a1.65 1.65 0 0 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></div><div class="settings-active-info"><div class="settings-active-label">' + (isZh ? '当前选中' : 'CURRENTLY SELECTED') + '</div><div class="settings-active-name">' + escapeHtml(name) + '</div><div class="settings-active-detail">' + escapeHtml(detail) + '</div></div><span class="settings-active-badge">' + (isZh ? '生效中' : 'Active') + '</span></div></div>';
}

function renderOverviewContent(presets, dm, isZh) {
  const navIcons = {
    custom: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
    codex: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    opencode: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>',
    speech: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>',
  };
  // 排序与文案：订阅型供应商在前（开箱即用），自定义兜底在后；文案面向用户收益而非工程动作
  const navItems = [
    { key: 'codex', title: isZh ? '使用 Codex 模型' : 'Use Codex models', desc: isZh ? '连接 OpenAI 账户，使用 Codex 订阅支持的模型' : 'Sign in with your OpenAI account and use the models in your Codex plan' },
    { key: 'opencode', title: isZh ? '使用 OpenCode 模型' : 'Use OpenCode models', desc: isZh ? '配置 OpenCode API Key，选择全球多家精选AI模型' : 'Add an OpenCode API key and pick from curated models worldwide' },
    { key: 'custom', title: isZh ? '添加自定义模型' : 'Add a custom model', desc: isZh ? '支持 OpenAI Chat Completions、Responses 和 Anthropic Messages API' : 'Works with OpenAI Chat Completions, Responses and Anthropic Messages APIs' },
    { key: 'speech', title: isZh ? '配置语音输入' : 'Set up voice input', desc: isZh ? '选择语音识别ASR模型，将语音转换为文字' : 'Pick an ASR model to turn speech into text' },
  ];
  const cards = presets.map((p, idx) => {
    const isActive = modelConfigMatchesPreset(dm, p);
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
  return '<div class="settings-section"><div class="settings-section-title">' + (isZh ? '快速配置' : 'Quick setup') + '</div>'
      + '<div class="settings-overview-nav">' + navItems.map((item) =>
        '<button type="button" class="settings-overview-nav-item" onclick="switchSettingsTab(\'' + item.key + '\')">'
        + '<span class="settings-overview-nav-icon">' + navIcons[item.key] + '</span>'
        + '<span><span class="settings-overview-nav-title">' + item.title + '</span><div class="settings-overview-nav-desc">' + item.desc + '</div></span>'
        + '</button>').join('') + '</div></div>'
    + '<div class="settings-section"><div class="settings-section-title">' + (isZh ? '模型列表' : 'Models') + '<span class="settings-section-hint">' + (isZh ? '点击卡片将其设为当前选择' : 'Click a card to make it the current selection') + '</span></div>'
      + (cards
        ? '<div class="settings-presets-grid">' + cards + '</div>'
        : renderCatalogEmptyState(isZh ? '暂无模型' : 'No models yet', isZh ? '从上方快速配置中选择一类开始添加' : 'Pick a category in Quick setup above to add one')) + '</div>';
}

// ── 通知设置（ADR-0030 editingSurface）已迁往智能编码空间 APP 设置面板
// （ph-model-config.js 的「通知」页签：宿主集中承接自身与 coder）。
// 全局模型配置面板不承载工作空间策略。

function renderModelCatalogSettingsOverlay(host, data) {
  const isZh = currentLanguage === 'zh';
  const tab = window.ClawFW.settingsTab || 'overview';
  const presets = Array.isArray(data.presets) ? data.presets : [];
  const connections = data.connections || { opencode: { hasApiKey: false, tier: 'zen' } };
  const catalog = window.ClawFW.modelCatalogs?.[tab] || { models: [], loaded: false, loading: false, error: '' };
  const labels = { overview: isZh ? '总览' : 'Overview', custom: isZh ? '自定义模型' : 'Custom', codex: 'Codex', opencode: 'OpenCode', speech: isZh ? '语音识别' : 'Speech' };
  // 侧栏分组：核心四项直排，「其他」之下放语音识别
  const tabButton = (key) =>
    '<button class="ph-settings-tab' + (tab === key ? ' active' : '') + '" type="button" onclick="switchSettingsTab(\'' + key + '\')">'
    + '<span class="ph-settings-tab-label">' + labels[key] + '</span></button>';
  const nav = ['overview', 'codex', 'opencode', 'custom'].map(tabButton).join('')
    + '<div class="ph-settings-tab-group">' + (isZh ? '其他' : 'Other') + '</div>'
    + tabButton('speech');
  const dm = data.config?.defaultModel || {};
  const speechConfig = getClawSpeechModelConfig() || {};
  const speechPreset = getClawSpeechPresets().find((preset) => preset.baseUrl === speechConfig.baseUrl && preset.apiKey === speechConfig.apiKey && preset.model === speechConfig.model && (preset.apiType || 'chat') === (speechConfig.apiType || 'chat'));
  const editing = Number.isInteger(window.ClawFW.settingsEditing) ? window.ClawFW.settingsEditing : null;
  const speechEditing = tab === 'speech' && window.ClawFW._speechEditing != null ? window.ClawFW._speechEditing : null;

  let content = '';
  if (tab === 'overview') {
    content = renderOverviewContent(presets, dm, isZh);
  } else if (tab === 'speech') {
    const banner = speechPreset ? renderActiveModelBanner(isZh, speechPreset.name || speechPreset.model, speechApiTypeLabel(speechPreset.apiType) + ' · ' + (speechPreset.model || '—')) : '';
    const speechParts = renderSpeechModelSection(isZh);
    content = banner + speechParts.content;
  } else if (tab === 'custom') {
    const customPresets = presets.map((p, idx) => ({ p, idx })).filter(({ p }) => !p.catalogProvider && p.authType !== 'oauth-codex' && !['OpenCode Zen', 'OpenCode Go'].includes(p.providerName));
    content = '<div class="settings-section"><div class="settings-section-title">' + (isZh ? '自定义模型' : 'Custom models') + '</div>'
      + (customPresets.length
        ? '<div class="settings-presets-grid">' + customPresets.map(({ p, idx }) => modelCatalogPresetCard(p, idx, isZh, false, modelConfigMatchesPreset(dm, p))).join('') + '</div>'
        : renderCatalogEmptyState(isZh ? '尚无自定义模型' : 'No custom models', isZh ? '点击右下角「添加模型」，接入任意 OpenAI 兼容端点' : 'Hit "Add model" in the corner to connect any OpenAI-compatible endpoint'))
      + '</div>';
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
    let connectionCard;
    if (isCodex) {
      // Codex 连接：列表页只保留入口卡片，账号管理（多账号登录/切换/登出）进入专门配置页
      const cardIntro = '<div><div class="settings-connection-title">OpenAI Auth</div><div class="settings-connection-description">' + (isZh ? '通过 OpenAI 账户连接 Codex 模型目录，支持多账号切换' : 'Connect OpenAI accounts to discover Codex models; multiple accounts supported') + '</div></div>';
      if (window.ClawFW.codexConnectionView) {
        // 专门配置页：账号列表（refreshCodexAccounts 渲染）+ 登录入口；登录流程
        // 反馈仍由 #oauth-status-display 承载（轮询期间独占）
        connectionCard = '<div class="settings-section settings-connection-card settings-codex-auth">'
          + '<div class="settings-connection-row">' + cardIntro
          + '<div class="oauth-action-row"><button class="settings-btn settings-btn-primary" type="button" onclick="startOAuthLogin(\'browser\')">' + (isZh ? '添加账号 · 浏览器授权' : 'Add · Browser') + '</button><button class="settings-btn settings-btn-secondary" type="button" onclick="startOAuthLogin(\'device\')">' + (isZh ? '添加账号 · 设备码' : 'Add · Device Code') + '</button></div></div>'
          + '<div id="codex-accounts-list" class="oauth-accounts-list"></div>'
          + '<div id="oauth-status-display" class="oauth-status-text settings-codex-auth-status"></div></div>';
      } else {
        connectionCard = '<div class="settings-section settings-connection-card settings-connection-entry" role="button" tabindex="0" onclick="openCodexConnectionView()" onkeydown="if(event.key===\'Enter\'&&event.target===this)openCodexConnectionView()">'
          + '<div class="settings-connection-row">' + cardIntro
          + '<button class="settings-btn settings-btn-secondary" type="button" onclick="event.stopPropagation();openCodexConnectionView()">' + (isZh ? '管理账号' : 'Manage Accounts') + '</button>'
          + '</div></div>';
      }
    } else {
      // OpenCode 连接：标题与 API Key 输入同行，输入即自动保存；不做状态徽章提升，保存失败反馈走目录状态区
      connectionCard = '<div class="settings-section settings-connection-card"><div class="settings-connection-row"><div><div class="settings-connection-title">OpenCode</div><div class="settings-connection-description">' + (isZh ? '配置 API Key 连接以发现可用模型，输入后自动保存' : 'Configure an API key to discover models; it saves as you type') + '</div></div><div class="settings-field settings-connection-inline"><label>API Key</label><div class="settings-key-field"><input class="settings-input" id="settings-opencode-key" type="password" autocomplete="new-password" value="' + escapeHtml(connections.opencode?.apiKey || '') + '" placeholder="' + (connections.opencode?.hasApiKey ? (isZh ? '已保存，留空保持不变' : 'Saved; leave blank to keep') : 'sk-…') + '" oninput="onOpenCodeKeyInput()" onblur="flushOpenCodeKeySave()"><button class="settings-key-visibility" type="button" aria-label="' + (isZh ? '显示或隐藏 API Key' : 'Show or hide API key') + '" title="' + (isZh ? '显示或隐藏' : 'Show or hide') + '" onclick="toggleOpenCodeKeyVisibility()"><svg id="opencode-eye-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg><svg id="opencode-eye-off-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg></button></div></div></div></div>';
    }
    const addedGrid = providerPresets.length
      ? '<div class="settings-presets-grid">' + providerPresets.map(({ p, idx }) => modelCatalogPresetCard(p, idx, isZh, catalog.loaded && !catalog.models.some((m) => m.id === p.model), modelConfigMatchesPreset(dm, p))).join('') + '</div>'
      : renderCatalogEmptyState(isZh ? '尚未添加模型' : 'No models added', isZh ? '从下方可添加列表中选择模型加入' : 'Pick models from the available list below');
    // 可添加行索引寻址（inline onclick 传索引而非模型 id，避免注入与转义问题）
    window.ClawFW.modelCatalogAvailable = available.map((m) => m.id);
    const selectedCount = available.filter((m) => selected[m.id]).length;
    const modelInfoSpan = (m) => '<span class="settings-catalog-info"><strong>' + escapeHtml(m.displayName || m.id) + '</strong></span>';
    const availableHtml = available.length ? '<div class="settings-catalog-list">' + available.map((m, i) => multi
      ? '<label class="settings-catalog-model"><input type="checkbox" value="' + escapeHtml(m.id) + '" onchange="setCatalogModelSelection(this)" ' + (selected[m.id] ? 'checked' : '') + '>' + modelInfoSpan(m) + '</label>'
      : '<div class="settings-catalog-model" onclick="addCatalogModel(\'' + tab + '\', ' + i + ')">' + modelInfoSpan(m) + '<span class="settings-catalog-add"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></span></div>'
    ).join('') + '</div>'
      : renderCatalogEmptyState(
          catalog.loading ? (isZh ? '正在刷新模型目录…' : 'Refreshing catalog…') : catalog.loaded ? (isZh ? '没有可添加的模型' : 'Nothing to add') : (isZh ? '目录尚未加载' : 'Catalog not loaded'),
          catalog.loading ? '' : catalog.loaded ? (isZh ? '目录中的模型均已添加' : 'All catalog models are already added') : (isZh ? '点击上方刷新获取可添加的模型' : 'Use Refresh above to discover models'));
    const tierSelect = '<select class="settings-input settings-catalog-tier" id="settings-opencode-tier" data-claw-select data-claw-compact="true" onchange="onOpenCodeServiceChange()"><option value="zen"' + (connections.opencode?.tier !== 'go' ? ' selected' : '') + '>Zen</option><option value="go"' + (connections.opencode?.tier === 'go' ? ' selected' : '') + '>Go</option></select>';
    const toolbarActions = (!isCodex ? tierSelect : '')
      + '<button class="settings-btn settings-btn-secondary" type="button" onclick="toggleCatalogMultiSelect()">' + (multi ? (isZh ? '退出多选' : 'Exit multi-select') : (isZh ? '多选' : 'Multi-select')) + '</button>'
      + (multi ? '<button class="settings-btn settings-btn-primary" type="button" id="settings-catalog-add-selected" onclick="addSelectedCatalogModels(\'' + tab + '\')">' + (isZh ? '添加所选' + (selectedCount ? '（' + selectedCount + '）' : '') : 'Add selected' + (selectedCount ? ' (' + selectedCount + ')' : '')) + '</button>' : '')
      + '<button class="settings-btn settings-btn-secondary" type="button" onclick="refreshModelCatalog(\'' + tab + '\')">' + (isZh ? '刷新' : 'Refresh') + '</button>';
    // 间距节奏由 .settings-catalog-page 统一控制：区块间 16px，标题到内容 12px
    content = connectionCard
      + (isCodex && window.ClawFW.codexConnectionView ? '' : ''
        + '<div class="settings-section"><div class="settings-section-title">' + (isZh ? '已添加' : 'Added') + '</div>' + addedGrid + '</div>'
        + '<div class="settings-section"><div class="settings-catalog-toolbar"><div class="settings-section-title">' + (isZh ? '可添加' : 'Available') + '</div><div class="settings-catalog-status">' + statusHtml + '</div><div class="settings-actions">' + toolbarActions + '</div></div>' + availableHtml + '</div>');
  }

  const body = editing !== null ? renderSettingsEditForm(editing, presets, isZh) : content;
  let footer = '';
  if (editing !== null) {
    footer = '<div class="settings-footer"><div class="settings-actions"><button class="settings-btn settings-btn-secondary" type="button" onclick="cancelSettingsEdit()">' + (isZh ? '取消' : 'Cancel') + '</button><button class="settings-btn settings-btn-primary" type="button" onclick="saveSettingsPreset(' + editing + ')">' + (isZh ? '保存' : 'Save') + '</button></div></div>';
  } else if (tab === 'speech' && speechEditing !== null) {
    footer = '<div class="settings-footer"><div class="settings-actions"><button class="settings-btn settings-btn-secondary" type="button" onclick="cancelSpeechPresetEdit()">' + (isZh ? '取消' : 'Cancel') + '</button><button class="settings-btn settings-btn-primary" type="button" data-edit="' + speechEditing + '" onclick="saveSpeechPreset(this.dataset.edit)">' + (isZh ? '保存' : 'Save') + '</button></div></div>';
  }
  // 右下角悬浮按钮：自定义模型页「添加模型」、语音识别页「配置模型」（编辑态由 settings-footer 接管，互斥不叠加）
  const fabAction = tab === 'custom' ? { fn: 'addSettingsPreset()', label: isZh ? '添加模型' : 'Add model' }
    : tab === 'speech' ? { fn: 'addSpeechPreset()', label: isZh ? '配置模型' : 'Configure model' } : null;
  const fab = editing === null && speechEditing === null && fabAction
    ? '<button class="settings-fab" type="button" onclick="' + fabAction.fn + '"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>' + fabAction.label + '</button>'
    : '';
  // 连接卡片输入状态跨渲染保留：自动保存/目录刷新等重渲染不打断正在输入的 API Key
  const opencodeKeyEl = document.getElementById('settings-opencode-key');
  const opencodeKeySnapshot = opencodeKeyEl ? {
    value: opencodeKeyEl.value,
    visible: opencodeKeyEl.type === 'text',
    focused: document.activeElement === opencodeKeyEl,
    selStart: opencodeKeyEl.selectionStart,
    selEnd: opencodeKeyEl.selectionEnd,
  } : null;
  // 配置子页：head 左侧返回按钮（项目既有形态：feature-detail-close + 左箭头，同 ph-model-config / feature-store）
  const isCodexAuthPage = tab === 'codex' && window.ClawFW.codexConnectionView;
  const headLeftHtml = isCodexAuthPage
    ? '<div style="display:flex;align-items:center;gap:4px;">'
      + '<button class="feature-detail-close" type="button" title="' + (isZh ? '返回' : 'Back') + '" onclick="closeCodexConnectionView()" style="margin-right:8px;font-size:16px;"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"></path><path d="M19 12H5"></path></svg></button>'
      + '<div><div class="feature-detail-title">' + (isZh ? '设置 · Codex 登录' : 'Settings · Codex Login') + '</div><div class="feature-detail-subtitle">' + (isZh ? '连接 OpenAI 账户以使用 Codex 模型' : 'Connect your OpenAI account to use Codex models') + '</div></div></div>'
    : '<div><div class="feature-detail-title">' + (isZh ? '设置' : 'Settings') + '</div><div class="feature-detail-subtitle">' + (isZh ? '管理模型连接与模型' : 'Manage model connections and models') + '</div></div>';
  host.innerHTML = '<div class="feature-detail-overlay"><div class="feature-detail-window ph-settings-window">'
    + '<div class="feature-detail-head">' + headLeftHtml + '<button class="feature-detail-close" type="button" onclick="closeSettings()">×</button></div>'
    + '<div class="ph-settings-layout"><div class="ph-settings-sidebar">' + nav + '</div><div class="ph-settings-content settings-catalog-page' + (tab === 'codex' || tab === 'opencode' ? ' settings-scroll-quiet' : '') + '">' + body + '</div></div>'
    + footer
    + fab
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
      if (opencodeKeySnapshot.focused) {
        restoredKey.focus();
        try { restoredKey.setSelectionRange(opencodeKeySnapshot.selStart, opencodeKeySnapshot.selEnd); } catch (e) { /* type=password may reject on some browsers */ }
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
  // 账号页统一回填：本函数整体重建 DOM，#codex-accounts-list 随之变为空容器；
  // 目录刷新（refreshModelCatalog 前后各一次）、保存配置等任何路径触发的重渲染
  // 都必须重新拉取账号列表，否则列表悬空（表现为账号"莫名消失"）
  if (window.ClawFW.codexConnectionView && tab === 'codex' && typeof renderCodexAccountsList === 'function') {
    renderCodexAccountsList();
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
    const serviceTiers = Array.isArray(model.serviceTiers)
      ? model.serviceTiers.filter((tier) => tier && tier.id)
      : [];
    if (isCodex && !serviceTiers.some((tier) => tier.id === 'priority')
      && (model.additionalSpeedTiers || []).includes('fast')) {
      serviceTiers.push({ id: 'priority', name: 'Fast', description: '' });
    }
    const defaultServiceTier = serviceTiers.some((tier) => tier.id === model.defaultServiceTier)
      ? model.defaultServiceTier
      : '';
    const providerOptions = { ...(model.providerOptions || {}) };
    if (defaultServiceTier) providerOptions.service_tier = defaultServiceTier;
    else if (isCodex) delete providerOptions.service_tier;
    // 目录来源预设的生成参数分两类取值：
    //   Codex —— 上游 /models 回报真实能力，输出预算 0（不限）、温度 0、
    //            思考预算留空（用厂商默认）、窗口取 context_window。
    //   OpenCode —— 目录只回报 id（无窗口/能力字段），与「添加自定义模型」
    //            共用同一份通用默认值，两处不再各写一套。
    const generation = isCodex ? {
      thinkingEffort: model.thinkingEffort || null,
      thinkingBudgetTokens: null,
      maxTokens: 0,
      temperature: 0,
      vision: true,
      contextLength: model.contextLength || null,
      compressRatio: 80,
      customHeaders: [],
    } : newPresetGenerationDefaults();
    data.presets.push({
      name, providerName: isCodex ? 'OpenAI Auth' : 'OpenCode ' + ((data.connections?.opencode?.tier === 'go') ? 'Go' : 'Zen'),
      catalogProvider: provider, provider: protocolInfo.protocol, apiSurface: protocolInfo.apiSurface,
      authType: isCodex ? 'oauth-codex' : '', clientId: isCodex ? 'app_EMoamEEZ73f0CkXaXp7hrann' : '',
      model: model.id, baseUrl: isCodex ? 'https://chatgpt.com/backend-api/codex' : (data.connections?.opencode?.tier === 'go' ? OPENCODE_GO_BASE_URL : OPENCODE_ZEN_BASE_URL),
      apiKey: '',
      ...generation,
      providerOptions,
      ...(isCodex ? { serviceTiers, additionalSpeedTiers: model.additionalSpeedTiers || [] } : {}),
      starred: false,
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

let _opencodeKeySaveTimer = null;

function onOpenCodeKeyInput() {
  if (_opencodeKeySaveTimer) clearTimeout(_opencodeKeySaveTimer);
  _opencodeKeySaveTimer = setTimeout(() => {
    _opencodeKeySaveTimer = null;
    saveModelConnection({ quiet: true });
  }, 700);
}

async function flushOpenCodeKeySave() {
  if (!_opencodeKeySaveTimer) return;
  clearTimeout(_opencodeKeySaveTimer);
  _opencodeKeySaveTimer = null;
  await saveModelConnection({ quiet: true });
}

function updateOpenCodeSaveFeedback(failed, message) {
  // 状态徽章已取消：自动保存失败就地写入目录状态区（成功不打扰，下次目录刷新自然覆盖）
  if (!failed) return;
  const status = document.querySelector('.settings-catalog-status');
  if (status) { status.classList.add('error'); status.textContent = message; }
}

async function saveModelConnection(opts) {
  const quiet = opts?.quiet === true;
  const key = document.getElementById('settings-opencode-key')?.value || '';
  const tier = document.getElementById('settings-opencode-tier')?.value === 'go' ? 'go' : 'zen';
  const prev = window.ClawFW.settingsData?.connections?.opencode;
  const response = await fetch('/protoclaw/model_connections', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ opencode: { apiKey: key, tier } }),
  }).catch(() => null);
  const result = response ? await response.json().catch(() => ({})) : {};
  if (!response || !response.ok) {
    if (!quiet) alert(result.error || 'Failed to save connection');
    updateOpenCodeSaveFeedback(true, currentLanguage === 'zh' ? 'API Key 自动保存失败' : 'Auto-save failed');
    return;
  }
  // 面板可能已在请求飞行中关闭（settingsData 置空），此时无需再更新本地状态
  if (!window.ClawFW.settingsOpen) return;
  window.ClawFW.settingsData.connections = { opencode: result.opencode };
  // 自动保存成功不打扰（不重渲染，避免打断输入焦点）；显式保存走整体重渲染
  if (!quiet) renderSettingsOverlay();
  // 凭证或服务发生变化才刷新目录；输入过程中的重复保存不重复拉取
  const changed = (result.opencode?.apiKey || '') !== (prev?.apiKey || '')
    || (result.opencode?.tier === 'go') !== (prev?.tier === 'go');
  if (result.opencode?.hasApiKey && changed) refreshModelCatalog('opencode');
}

function openCodexConnectionView() {
  window.ClawFW.codexConnectionView = true;
  // 账号列表回填由 renderSettingsOverlay 统一负责（见其尾部），无需再经
  // refreshOAuthStatus 转发一次（避免双 fetch）
  renderSettingsOverlay();
  // 进入配置页时检查代理环境（未配置代理时 OpenAI 登录请求可能被地区限制拦截）
  checkOAuthProxy(currentLanguage === 'zh');
}

function closeCodexConnectionView() {
  // 返回列表页时终止未完成的登录轮询（服务端流程继续，状态以再次进入时的刷新为准）
  if (_oauthPollTimer) { clearInterval(_oauthPollTimer); _oauthPollTimer = null; }
  window.ClawFW.codexConnectionView = false;
  renderSettingsOverlay();
  refreshOAuthStatus();
}

function modelCatalogPresetCard(preset, idx, isZh, missing, isActive) {
  const providerLabel = preset.catalogProvider === 'codex' || preset.authType === 'oauth-codex' ? 'Codex' : (preset.catalogProvider === 'opencode' || ['OpenCode Zen', 'OpenCode Go'].includes(preset.providerName) ? 'OpenCode' : (preset.provider || 'Custom'));
  // 与总览/语音预设卡同构：圆点 + 名称/详情 + 编辑/删除图标按钮，整卡点击应用
  const tier = isCodexPreset(preset) ? selectedCodexTier(preset) : '';
  const tierMeta = Array.isArray(preset.serviceTiers) ? preset.serviceTiers.find((item) => item.id === tier) : null;
  const tierLabel = tier === 'priority' ? (tierMeta?.name || 'Fast') : tierMeta?.name || tier;
  return '<div class="settings-preset-card' + (isActive ? ' active' : '') + '" onclick="applySettingsPreset(' + idx + ')">'
    + '<div class="settings-preset-dot"></div>'
    + '<div class="settings-preset-info">'
    + '<div class="settings-preset-name">' + escapeHtml(preset.name || preset.model) + '</div>'
    + '<div class="settings-preset-detail">' + escapeHtml(providerLabel + ' · ' + preset.model) + (tier ? ' · ' + escapeHtml(tierLabel) : '') + (missing ? ' <span class="preset-tag">' + (isZh ? '目录中不存在' : 'Not in catalog') + '</span>' : '') + '</div>'
    + '</div>'
    + '<div class="settings-preset-actions">'
    + '<button class="settings-icon-btn" type="button" title="' + (isZh ? '编辑' : 'Edit') + '" onclick="event.stopPropagation();editSettingsPreset(' + idx + ')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></button>'
    + '<button class="settings-icon-btn danger" type="button" title="' + (isZh ? '删除' : 'Delete') + '" onclick="event.stopPropagation();deleteSettingsPreset(' + idx + ')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg></button>'
    + '</div></div>';
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

function validateProviderOptionsDraft(raw, protocolValue, apiSurfaceValue = 'chat') {
  let value;
  try {
    value = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return { valid: false, error: currentLanguage === 'zh' ? '额外请求体参数必须是有效 JSON。' : 'Additional request body parameters must be valid JSON.' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, error: currentLanguage === 'zh' ? '额外请求体参数必须是 JSON 对象。' : 'Additional request body parameters must be a JSON object.' };
  }
  if (Object.keys(value).length && !['anthropic', 'openai', 'openai-responses', 'openai-oauth', 'opencode'].includes(protocolValue)) {
    return { valid: false, error: currentLanguage === 'zh' ? '当前协议不支持额外请求体参数。' : 'Additional parameters are not supported for this protocol.' };
  }
  const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
  const isResponses = protocolValue === 'openai-responses' || protocolValue === 'openai-oauth'
    || protocolValue === 'openai' && apiSurfaceValue === 'responses';
  const reserved = protocolValue === 'anthropic'
    ? ['model', 'messages', 'tools', 'stream', 'max_tokens', 'system', 'thinking']
    : isResponses
      ? ['model', 'input', 'tools', 'tool_choice', 'stream', 'instructions', 'store', 'previous_response_id', 'max_output_tokens', 'reasoning', 'parallel_tool_calls']
      : ['model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens', 'reasoning_effort', 'parallel_tool_calls'];
  const inspect = (node, depth = 0, visited = new Set()) => {
    if (!node || typeof node !== 'object') return null;
    if (depth >= 32) return currentLanguage === 'zh' ? '参数嵌套过深。' : 'Parameter nesting is too deep.';
    if (visited.has(node)) return null;
    visited.add(node);
    for (const key of Object.getOwnPropertyNames(node)) {
      const child = node[key];
      if (dangerous.has(key)) return currentLanguage === 'zh' ? '参数中包含不安全的键：' + key : 'Unsafe parameter key: ' + key;
      const nested = inspect(child, depth + 1, visited);
      if (nested) return nested;
    }
    return null;
  };
  const unsafe = inspect(value);
  if (unsafe) return { valid: false, error: unsafe };
  const conflict = Object.keys(value).find((key) => reserved.includes(key));
  if (conflict) {
    return { valid: false, error: currentLanguage === 'zh'
      ? '字段“' + conflict + '”由运行时管理，不能放入额外请求体参数。'
      : 'The runtime manages “' + conflict + '”; it cannot be overridden here.' };
  }
  return { valid: true, value };
}

function renderSettingsEditForm(editIdx, presets, isZh) {
  const preset = presets[editIdx] || {};
  let openCodeTier = preset.providerName === 'OpenCode Go' || preset.baseUrl === OPENCODE_GO_BASE_URL ? 'go' : 'zen';
  const isCodex = isCodexPreset(preset);
  const modelCatalog = isCodex
    ? (window.ClawFW.modelCatalogs?.codex?.models || []).find((model) => model.id === preset.model)
    : null;
  const availableServiceTiers = isCodex ? getCodexServiceTiers(preset, modelCatalog) : [];
  const selectedServiceTier = isCodex ? selectedCodexTier(preset) : '';
  const unsupportedServiceTier = selectedServiceTier && !availableServiceTiers.some((tier) => tier.id === selectedServiceTier);
  let isOpenCodePreset = preset.providerName === 'OpenCode Zen' || preset.providerName === 'OpenCode Go'
    || preset.baseUrl === OPENCODE_ZEN_BASE_URL || preset.baseUrl === OPENCODE_GO_BASE_URL;
  let dropdownVal = preset.authType === 'oauth-codex' ? 'openai-oauth'
    : (isOpenCodePreset ? 'opencode'
    : (preset.provider === 'openai' && (preset.apiSurface || 'chat') === 'responses' ? 'openai-responses'
    : (preset.provider || 'anthropic')));
  let isOAuthMode = dropdownVal === 'openai-oauth';
  let isOpenCodeMode = dropdownVal === 'opencode';
  const providerOptions = preset.providerOptions && typeof preset.providerOptions === 'object' && !Array.isArray(preset.providerOptions)
    ? { ...preset.providerOptions }
    : {};
  if (isCodex) delete providerOptions.service_tier;
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
    ...(isCodex ? [
      '<div class="settings-field settings-service-tier-field">',
      '<label for="settings-preset-service-tier">' + (isZh ? '倍率模式' : 'Speed mode') + '</label>',
      '<select class="settings-input" data-claw-select id="settings-preset-service-tier">',
      '<option value=""' + (!selectedServiceTier ? ' selected' : '') + '>' + (isZh ? '标准' : 'Standard') + '</option>',
      availableServiceTiers.map((tier) => '<option value="' + escapeHtml(tier.id) + '"' + (selectedServiceTier === tier.id ? ' selected' : '') + '>'
        + escapeHtml(tier.id === 'priority' ? 'Fast' : tier.name || tier.id) + '</option>').join(''),
      ...(unsupportedServiceTier ? ['<option value="' + escapeHtml(selectedServiceTier) + '" selected>'
        + escapeHtml(selectedServiceTier) + (isZh ? '（目录未提供，请选择支持的档位）' : ' (not in catalog; choose a supported tier)') + '</option>'] : []),
      '</select>',
      !availableServiceTiers.length ? '<div class="settings-static-value">' + escapeHtml(window.ClawFW.modelCatalogs?.codex?.error || (isZh
        ? '尚无可用的加速档位信息。请在 Codex 页面刷新模型目录后重试。'
        : 'No speed tiers available. Refresh the Codex model catalog and try again.')) + '</div>' : '',
      unsupportedServiceTier ? '<div class="settings-service-tier-warning" role="alert">'
        + (isZh ? '这个模型不支持当前模式，请重新选择。' : 'This tier is not listed for the loaded model. Choose a listed tier or Standard.')
        + '</div>' : '',
      '</div>',
    ] : []),
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
    '<div class="settings-field">',
    '<label for="settings-preset-provider-options">' + (isZh ? '额外请求体参数 (JSON 对象)' : 'Additional request body parameters (JSON object)') + '</label>',
    '<textarea class="settings-input settings-provider-options" id="settings-preset-provider-options" rows="6" spellcheck="false">' + escapeHtml(JSON.stringify(providerOptions, null, 2)) + '</textarea>',

    '<div id="settings-provider-options-error" class="settings-field-warning" role="alert" style="display:none"></div>',
    '</div>',
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

/**
 * 新建模型预设的通用生成参数默认值：自定义模型与 OpenCode 目录模型共用这一份。
 * 思考/视觉默认开启，预算与上下文给常用经验值，保存后用户可在编辑表单里改。
 * Codex 目录模型不使用本函数——它的取值来自上游 /models 回报的真实能力。
 */
function newPresetGenerationDefaults() {
  return {
    thinkingEffort: 'medium',
    thinkingBudgetTokens: 32000,
    maxTokens: 96000,
    temperature: null,
    vision: true,
    contextLength: 1000000,
    compressRatio: 80,
    customHeaders: [],
  };
}

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
    ...newPresetGenerationDefaults(),
    starred: false,
  });
  window.ClawFW.settingsData = window.ClawFW.settingsData || {};
  window.ClawFW.settingsData.presets = presets;
  window.ClawFW.settingsEditing = presets.length - 1;
  renderSettingsOverlay();
}

async function editSettingsPreset(idx) {
  const preset = window.ClawFW.settingsData?.presets?.[idx];
  // Load capabilities before opening the form: an async catalog refresh must not erase edits.
  if (isCodexPreset(preset) && !window.ClawFW.modelCatalogs?.codex?.loaded) {
    await refreshModelCatalog('codex');
    if (window.ClawFW.settingsData?.presets?.[idx] !== preset) return;
  }
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
  const rawProviderOptions = el('settings-preset-provider-options')?.value;
  const protocolForOptions = isCatalogPreset
    ? (existing.authType === 'oauth-codex' ? 'openai-oauth' : existing.provider || 'anthropic')
    : (el('settings-preset-provider')?.value || existing.provider || 'anthropic');
  const apiSurfaceForOptions = existing.catalogProvider === 'codex' || protocolForOptions === 'openai-oauth'
    ? 'responses'
    : existing.apiSurface || (el('settings-preset-provider')?.value === 'openai-responses' ? 'responses' : 'chat');
  const optionsValidation = validateProviderOptionsDraft(rawProviderOptions === undefined ? JSON.stringify(existing.providerOptions || {}) : rawProviderOptions, protocolForOptions, apiSurfaceForOptions);
  const optionsError = document.getElementById('settings-provider-options-error');
  if (!optionsValidation.valid) {
    if (optionsError) {
      optionsError.textContent = optionsValidation.error;
      optionsError.style.display = '';
    }
    el('settings-preset-provider-options')?.classList.add('invalid');
    return;
  }
  if (optionsError) optionsError.style.display = 'none';
  el('settings-preset-provider-options')?.classList.remove('invalid');
  const providerOptions = { ...optionsValidation.value };
  const modelCatalog = (window.ClawFW.modelCatalogs?.codex?.models || []).find((model) => model.id === existing.model);
  if (isCodexPreset(existing)) {
     const newTier = el('settings-preset-service-tier')?.value ?? selectedCodexTier(existing);
     const availableServiceTiers = getCodexServiceTiers(existing, modelCatalog);
     if (newTier && !availableServiceTiers.some((tier) => tier.id === newTier)) {
       if (optionsError) {
         optionsError.textContent = isZh ? '这个模型不支持当前模式，请重新选择。' : 'The selected model does not support this service tier. Choose a listed tier or Standard.';
         optionsError.style.display = '';
       }
       return;
     }
     if (rawProviderOptions !== undefined && Object.hasOwn(providerOptions, 'service_tier')) {
       if (optionsError) {
         optionsError.textContent = isZh ? '请使用上方“倍率模式”选择标准或 Fast，并从高级参数中移除 service_tier。' : 'Use Speed mode above and remove service_tier from advanced parameters.';
         optionsError.style.display = '';
       }
       return;
     }
     if (newTier) providerOptions.service_tier = newTier;
     else delete providerOptions.service_tier;

  }
  const common = {
    name: (el('settings-preset-name')?.value || '').trim(),
    thinkingEffort: thinkingEffort,
    thinkingBudgetTokens: thinkingBudgetTokens,
    maxTokens: maxTokensRaw !== '' ? (Number.isFinite(parseInt(maxTokensRaw, 10)) ? parseInt(maxTokensRaw, 10) : null) : null,
    temperature: tempRaw !== '' ? (Number.isFinite(parseFloat(tempRaw)) ? parseFloat(tempRaw) : null) : null,
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
      providerOptions,
      ...(isCodexPreset(existing) ? {
        serviceTiers: modelCatalog?.serviceTiers || existing.serviceTiers || [],
        additionalSpeedTiers: modelCatalog?.additionalSpeedTiers || existing.additionalSpeedTiers || [],
      } : {}),
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
      providerOptions,
    };
  }
  presets[idx] = preset;
  window.ClawFW.settingsData.presets = presets;
  if (!keepEditing) window.ClawFW.settingsEditing = null;
  // Check if no model is currently active — auto-select the first/newly saved preset
  let config = window.ClawFW.settingsData?.config || {};
  let dm = config.defaultModel || {};
  let hasActive = presets.some(function(p) {
    return modelConfigMatchesPreset(dm, p);
  });
  const saved = await saveSettingsConfig();
  if (!saved) return;
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
    presetName: preset.name || '',
    baseUrl: preset.baseUrl || '',
    apiKey: preset.apiKey || '',
     authType: preset.authType || '',
     providerOptions: { ...(preset.providerOptions || {}) },
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
        // 元数据刷新不改变列表归属：按当前浏览目标取切片并合并，避免用
        // 目录切片整体覆盖项目列表（并把已加载的深层分页段一并保住）。
        const fresh = typeof phFetchSessionsWithOwnership === 'function'
          ? await phFetchSessionsWithOwnership(_agent || { id: logicalAgentId })
          : null;
        if (fresh && fresh.unchanged !== true && _agent) {
          _agent.workspace_sessions = typeof mergeWorkspaceSessionSnapshots === 'function'
            ? mergeWorkspaceSessionSnapshots(_agent.workspace_sessions || {}, fresh, logicalAgentId)
            : fresh;
        }
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
        // 元数据刷新不改变列表归属：按当前浏览目标取切片并合并，避免用
        // 目录切片整体覆盖项目列表（并把已加载的深层分页段一并保住）。
        const fresh = typeof phFetchSessionsWithOwnership === 'function'
          ? await phFetchSessionsWithOwnership(_agent || { id: logicalAgentId })
          : null;
        if (fresh && fresh.unchanged !== true && _agent) {
          _agent.workspace_sessions = typeof mergeWorkspaceSessionSnapshots === 'function'
            ? mergeWorkspaceSessionSnapshots(_agent.workspace_sessions || {}, fresh, logicalAgentId)
            : fresh;
        }
      } catch {}
    }
    if (typeof updateChatContextBar === 'function') { updateChatContextBar(); }
    return true;
  } catch (error) {
    console.error('Failed to save config:', error);
    return false;
  }
}

// ── window 导出 ──────────────────────────────────────────────
window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.switchSettingsTab = function(tab) {
  // 重渲染前先落盘输入中的 OpenCode API Key（同步捕获 DOM 值后再替换）
  flushOpenCodeKeySave();
  window.ClawFW.settingsTab = ['overview', 'custom', 'codex', 'opencode', 'speech'].includes(tab) ? tab : 'overview';
  window.ClawFW.settingsEditing = null;
  window.ClawFW.codexConnectionView = false;
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
window.onOpenCodeKeyInput = onOpenCodeKeyInput;
window.flushOpenCodeKeySave = flushOpenCodeKeySave;
window.saveModelConnection = saveModelConnection;
window.openCodexConnectionView = openCodexConnectionView;
window.closeCodexConnectionView = closeCodexConnectionView;
window.addSettingsPreset = addSettingsPreset;
window.editSettingsPreset = editSettingsPreset;
window.deleteSettingsPreset = deleteSettingsPreset;
window.toggleSettingsPresetStar = toggleSettingsPresetStar;
window.saveSettingsPreset = saveSettingsPreset;
window.applySettingsPreset = applySettingsPreset;
window.cancelSettingsEdit = cancelSettingsEdit;
