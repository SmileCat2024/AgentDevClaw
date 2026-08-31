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
  window.ClawFW.settingsEditing = null;
  window.ClawFW.settingsData = null;
  window.ClawFW._speechModelConfig = null;
  window.ClawFW._speechPresets = [];
  renderSettingsOverlay();
  try {
    const [modelResp, speechResp] = await Promise.all([
      fetch('/protoclaw/model_config'),
      fetch('/protoclaw/speech_model_config'),
    ]);
    const data = await modelResp.json();
    window.ClawFW.settingsData = data;
    window.ClawFW._modelPresets = Array.isArray(data?.presets) ? data.presets : [];
    try {
      const speechData = await speechResp.json();
      window.ClawFW._speechModelConfig = speechData?.speechModel || null;
      window.ClawFW._speechPresets = Array.isArray(speechData?.speechPresets) ? speechData.speechPresets : [];
    } catch (e) { /* speech config may not exist yet */ }
    renderSettingsOverlay();
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
  window.ClawFW._speechPresets = [];
  const host = document.getElementById('settings-overlay-host');
  if (host) host.innerHTML = '';
}

function renderSettingsOverlay() {
  const host = ensureSettingsHost();
  if (!window.ClawFW.settingsOpen) {
    host.innerHTML = '';
    return;
  }
  const data = window.ClawFW.settingsData;
  const config = data?.config || { defaultModel: {}, agent: {} };
  const presets = Array.isArray(data?.presets) ? data.presets : [];
  const dm = config.defaultModel || {};
  const ag = config.agent || {};
  const editing = window.ClawFW.settingsEditing;
  const isZh = currentLanguage === 'zh';
  const activeTab = window.ClawFW.settingsTab || 'text';

  // ── Find active preset name ──
  const activePreset = presets.find(function(p) {
    return dm.model === p.model && dm.provider === p.provider && dm.baseUrl === p.baseUrl;
  });
  const activePresetName = activePreset
    ? (activePreset.name || activePreset.model || '')
    : '';

  const presetCards = presets.length
    ? presets.map((p, idx) => {
        const isActive = dm.model === p.model && dm.provider === p.provider && dm.baseUrl === p.baseUrl;
        return [
          '<div class="settings-preset-card' + (isActive ? ' active' : '') + '" onclick="applySettingsPreset(' + idx + ')">',
          '<div class="settings-preset-dot"></div>',
          '<div class="settings-preset-info">',
          '<div class="settings-preset-name">' + escapeHtml(p.name || p.model || ('Preset ' + (idx + 1))) + '</div>',
          '<div class="settings-preset-detail">' + escapeHtml((p.provider || '—') + ' · ' + (p.model || '—'))
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
      }).join('')
    : '<div style="padding:16px;text-align:center;color:var(--text-secondary);font-size:13px;">' + (isZh ? '暂无预设，点击下方按钮添加' : 'No presets yet. Click the button below to add one') + '</div>';

  // ── Tab content: split into fixed banner + scrollable content ──
  const tabText = activeTab === 'text';
  const tabBar = [
    '<div class="settings-tab-bar">',
    '<button class="settings-tab' + (tabText ? ' active' : '') + '" type="button" onclick="switchSettingsTab(\'text\')">',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 2 0 0 1 2 2z"></path></svg>',
    (isZh ? '文本模型' : 'Text Model'),
    '</button>',
    '<button class="settings-tab' + (!tabText ? ' active' : '') + '" type="button" data-settings-tab="speech" onclick="switchSettingsTab(this.dataset.settingsTab)">',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>',
    (isZh ? '语音模型' : 'Speech Model'),
    '</button>',
    '</div>',
  ].join('');
  let fixedBanner = '';
  let scrollContent = '';

  if (tabText) {
    // Text model tab
    const activeBanner = [
      '<div class="settings-active-banner">',
      '<div class="settings-active-icon">',
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>',
      '</div>',
      '<div class="settings-active-info">',
      '<div class="settings-active-label">' + (isZh ? '当前激活' : 'ACTIVE') + '</div>',
      '<div class="settings-active-name">' + escapeHtml(activePresetName || dm.model || (isZh ? '未选择预设' : 'No preset selected')) + '</div>',
      '<div class="settings-active-detail">' + escapeHtml((dm.provider || '—') + (dm.model ? ' · ' + dm.model : '') + (dm.baseUrl ? ' · ' + dm.baseUrl : '')) + '</div>',
      '</div>',
      activePresetName ? '<div class="settings-active-badge">' + (isZh ? '预设' : 'Preset') + '</div>' : '',
      '</div>',
    ].join('');

    if (editing === null) {
      // List mode: banner fixed, preset list scrolls
      fixedBanner = '<div class="settings-section">' + activeBanner + '</div>';
      scrollContent = [
        '<div class="settings-section">',
        '<div class="settings-section-title">' + (isZh ? '预设列表' : 'Presets') + '</div>',
        '<div class="settings-presets-grid">' + presetCards + '</div>',
        '</div>',
      ].join('');
    } else {
      // Edit mode: form scrolls, no banner
      scrollContent = renderSettingsEditForm(editing, presets, isZh);
    }
  } else {
    // Speech model tab
    const speechParts = renderSpeechModelSection(isZh);
    fixedBanner = speechParts.banner;
    scrollContent = speechParts.content;
  }

  // ── Compute footer buttons for mask bar ──
  let footerButtons = '';
  if (tabText) {
    if (editing !== null) {
      footerButtons = [
        '<div class="settings-actions">',
        '<button class="settings-btn settings-btn-secondary" type="button" onclick="cancelSettingsEdit()">' + (isZh ? '取消' : 'Cancel') + '</button>',
        '<button class="settings-btn settings-btn-primary" type="button" onclick="saveSettingsPreset(' + editing + ')">' + (isZh ? '保存' : 'Save') + '</button>',
        '</div>',
      ].join('');
    } else {
      footerButtons = '<div class="settings-actions"><button class="settings-btn settings-btn-secondary" type="button" onclick="addSettingsPreset()">+ ' + (isZh ? '添加预设' : 'Add Preset') + '</button></div>';
    }
  } else {
    if (window.ClawFW._speechEditing != null) {
      const speechEditIdx = window.ClawFW._speechEditing;
      footerButtons = [
        '<div class="settings-actions">',
        '<button class="settings-btn settings-btn-secondary" type="button" onclick="cancelSpeechPresetEdit()">' + (isZh ? '取消' : 'Cancel') + '</button>',
        '<button class="settings-btn settings-btn-primary" type="button" onclick="saveSpeechPreset(\'' + speechEditIdx + '\')">' + (isZh ? '保存' : 'Save') + '</button>',
        '</div>',
      ].join('');
    } else {
      footerButtons = '<div class="settings-actions"><button class="settings-btn settings-btn-secondary" type="button" onclick="addSpeechPreset()">+ ' + (isZh ? '添加预设' : 'Add Preset') + '</button></div>';
    }
  }

  host.innerHTML = [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window" style="width:min(100%,600px);height:min(100%,660px);overflow:hidden;">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + (isZh ? '设置' : 'Settings') + '</div>',
    '<div class="feature-detail-subtitle">' + (isZh ? '管理模型预设' : 'Manage model presets') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + (isZh ? '关闭' : 'Close') + '" onclick="closeSettings()">×</button>',
    '</div>',

    editing === null && window.ClawFW._speechEditing == null ? tabBar : '',
    fixedBanner ? '<div style="flex-shrink:0;">' + fixedBanner + '</div>' : '',
    '<div class="settings-tab-content">',
    scrollContent,
    '</div>',
    '<div class="settings-footer">',
    footerButtons,
    '</div>',

    '</div>',
    '</div>',
  ].join('');

  if (typeof window.populateThinkingEffortOptions === 'function') window.populateThinkingEffortOptions();

  // Enhance native <select> elements with custom dropdown
  if (window.ClawSelect) window.ClawSelect.enhanceAll(host);

  // Show the saved OAuth login state as soon as an OAuth preset's edit form opens
  if (tabText && editing !== null && presets[editing]?.authType === 'oauth-codex') refreshOAuthStatus();
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
  const isZh = (typeof currentLanguage === 'function' ? currentLanguage() : window.ClawFW?.lang) === 'zh';
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

const OPENCODE_ZEN_BASE_URL = 'https://opencode.ai/zen/v1';
const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1';

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
  return [
    '<div class="settings-section">',

    // ── 连接配置 ──
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
    '<div class="settings-field">',
    '<label>Base URL</label>',
    '<input class="settings-input" id="settings-preset-baseurl" type="text" value="' + escapeHtml(preset.baseUrl || (isOAuthMode ? 'https://chatgpt.com/backend-api/codex' : (isOpenCodeMode ? (openCodeTier === 'go' ? OPENCODE_GO_BASE_URL : OPENCODE_ZEN_BASE_URL) : ''))) + '" placeholder="https://open.bigmodel.cn/api/anthropic"' + (isOpenCodeMode ? ' readonly' : '') + '>',
    '</div>',
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
  const countTokenPathRaw = el('settings-preset-count-token-path')?.value?.trim();
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
  const preset = {
    name: (el('settings-preset-name')?.value || '').trim(),
    providerName: isOpenCode ? (openCodeTier === 'go' ? 'OpenCode Go' : 'OpenCode Zen') : (presets[idx]?.providerName || ''),
    provider: isOAuth ? 'openai' : (isOpenCode ? openCodeResolved.protocol : protocolRaw.replace(/^openai-(responses|zen)$/, 'openai')),
    apiSurface: isOAuth ? 'responses' : (isOpenCode ? openCodeResolved.apiSurface : (protocolRaw === 'openai-responses' ? 'responses' : 'chat')),
    authType: isOAuth ? 'oauth-codex' : '',
    clientId: isOAuth ? clientIdRaw : '',
    model: modelVal,
    baseUrl: isOpenCode
      ? (openCodeTier === 'go' ? OPENCODE_GO_BASE_URL : OPENCODE_ZEN_BASE_URL)
      : (el('settings-preset-baseurl')?.value || '').trim(),
    apiKey: isOAuth ? '' : (el('settings-preset-apikey')?.value || '').trim(),
    thinkingEffort: thinkingEffort,
    thinkingBudgetTokens: thinkingBudgetTokens,
    maxTokens: maxTokensRaw !== '' ? parseInt(maxTokensRaw, 10) || null : null,
    temperature: tempRaw !== '' ? parseFloat(tempRaw) || null : null,
    vision: el('settings-preset-vision')?.checked === true,
    starred: presets[idx]?.starred === true,
    contextLength: contextLengthRaw !== '' ? parseInt(contextLengthRaw, 10) || null : null,
    compressRatio: compressRatioRaw !== '' ? Math.max(1, Math.min(100, parseInt(compressRatioRaw, 10) || 80)) : 80,
    countTokenPath: countTokenPathRaw || null,
    customHeaders,
  };
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
    window.ClawFW._modelPresets = Array.isArray(result?.presets) ? result.presets : [];
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
    window.ClawFW._modelPresets = Array.isArray(result?.presets) ? result.presets : [];
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
window.addSettingsPreset = addSettingsPreset;
window.editSettingsPreset = editSettingsPreset;
window.deleteSettingsPreset = deleteSettingsPreset;
window.toggleSettingsPresetStar = toggleSettingsPresetStar;
window.saveSettingsPreset = saveSettingsPreset;
window.applySettingsPreset = applySettingsPreset;
window.cancelSettingsEdit = cancelSettingsEdit;
