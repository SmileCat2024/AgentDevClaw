/**
 * model-settings.js — 文本模型预设管理 + 设置覆盖层主编排（从 settings-overlay.js 拆分）
 *
 * 包含：overlay host 管理、模型设置覆盖层主渲染、文本模型预设增删改、API Key 可视性切换。
 * 依赖（全局）：escapeHtml, currentLanguage, getCurrentAgentRecord, updateChatContextBar
 * 依赖（跨文件）：renderSpeechModelSection（speech-settings.js）
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
            + '</div>',
          '</div>',
          '<div class="settings-preset-actions">',
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

  // ── Tab bar ──
  const tabText = activeTab === 'text';
  const tabBar = [
    '<div class="settings-tab-bar">',
    '<button class="settings-tab' + (tabText ? ' active' : '') + '" type="button" onclick="switchSettingsTab(\'text\')">',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>',
    (isZh ? '文本模型' : 'Text Model'),
    '</button>',
    '<button class="settings-tab' + (!tabText ? ' active' : '') + '" type="button" onclick="switchSettingsTab(\'speech\')">',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>',
    (isZh ? '语音模型' : 'Speech Model'),
    '</button>',
    '</div>',
  ].join('');

  // ── Tab content: split into fixed banner + scrollable content ──
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
    '<div class="feature-detail-window" style="width:min(100%,560px);height:min(100%,640px);overflow:hidden;">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + (isZh ? '设置' : 'Settings') + '</div>',
    '<div class="feature-detail-subtitle">' + (isZh ? '管理模型预设' : 'Manage model presets') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + (isZh ? '关闭' : 'Close') + '" onclick="closeSettings()">×</button>',
    '</div>',

    tabBar,
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

window.switchSettingsTab = function(tab) {
  window.ClawFW.settingsTab = tab;
  renderSettingsOverlay();
};

function renderSettingsEditForm(editIdx, presets, isZh) {
  const preset = presets[editIdx] || {};
  const isNew = preset._isNew;
  let dropdownVal = preset.authType === 'oauth-codex' ? 'openai-oauth'
    : (preset.provider === 'openai' && (preset.apiSurface || 'chat') === 'responses' ? 'openai-responses'
    : (preset.provider || 'anthropic'));
  let isOAuthMode = dropdownVal === 'openai-oauth';
  return [
    '<div class="settings-section">',
    '<div class="settings-section-title">' + (isNew ? (isZh ? '新建预设' : 'New Preset') : (isZh ? '编辑预设' : 'Edit Preset')) + '</div>',
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
    '<input class="settings-input" id="settings-preset-baseurl" type="text" value="' + escapeHtml(preset.baseUrl || (isOAuthMode ? 'https://chatgpt.com/backend-api/codex' : '')) + '" placeholder="https://open.bigmodel.cn/api/anthropic">',
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
    '<div class="settings-field">',
    '<div class="settings-checkbox">',
    '<input type="checkbox" id="settings-preset-thinking-enabled" ' + (preset.thinkingEffort && preset.thinkingEffort !== 'none' && preset.thinkingEffort !== '' ? 'checked' : '') + ' onchange="onThinkingToggleChange()">',
    '<label for="settings-preset-thinking-enabled">' + (isZh ? '启用思考' : 'Enable Thinking') + '</label>',
    '</div>',
    '</div>',
    '<div id="settings-thinking-config"' + (preset.thinkingEffort && preset.thinkingEffort !== 'none' && preset.thinkingEffort !== '' ? '' : ' style="display:none;"') + '>',
    '<div class="settings-row">',
    '<div class="settings-field">',
    '<label>' + (isZh ? '默认思考强度' : 'Default Thinking Effort') + '</label>',
    renderThinkingEffortSelect(preset, isZh),
    '</div>',
    '<div class="settings-field">',
    '<label>' + (isZh ? '思考预算 (tokens)' : 'Thinking Budget (tokens)') + '</label>',
    '<input class="settings-input" id="settings-preset-thinking-budget" type="number" min="512" value="' + (preset.thinkingBudgetTokens || '') + '" placeholder="' + (isZh ? '如 16000' : 'e.g. 16000') + '" oninput="onThinkingBudgetInput()">',
    '<div id="settings-thinking-budget-error" style="font-size:11px;color:#e57373;margin-top:2px;display:none;"></div>',
    '</div>',
    '</div>',
    '</div>',
    '<div class="settings-field">',
    '<label>Max Output Tokens</label>',
    '<input class="settings-input" id="settings-preset-max-tokens" type="number" value="' + (preset.maxTokens ?? '') + '" placeholder="' + (isZh ? '留空自动计算' : 'Leave empty for auto') + '">',
    '</div>',
    '<div class="settings-row">',
    '<div class="settings-field">',
    '<label>Temperature</label>',
    '<input class="settings-input" id="settings-preset-temperature" type="number" step="0.1" min="0" max="2" value="' + (preset.temperature ?? '') + '" placeholder="' + (isZh ? '留空使用默认值' : 'Leave empty for default') + '">',
    '</div>',
    '<div class="settings-field">',
    '<label>' + (isZh ? '视觉模式' : 'Vision mode') + '</label>',
    '<div class="settings-checkbox">',
    '<input type="checkbox" id="settings-preset-vision" ' + (preset.vision ? 'checked' : '') + '>',
    '<label for="settings-preset-vision">' + (isZh ? '启用多模态图片输入' : 'Enable multimodal image input') + '</label>',
    '</div>',
    '</div>',
    '</div>',
    '<div class="settings-row">',
    '<div class="settings-field">',
    '<label>' + (isZh ? '上下文长度' : 'Context Length') + '</label>',
    '<input class="settings-input" id="settings-preset-context-length" type="number" value="' + (preset.contextLength ?? '') + '" placeholder="200000">',
    '</div>',
    '<div class="settings-field">',
    '<label>' + (isZh ? '压缩阈值' : 'Compress Threshold') + '</label>',
    '<input class="settings-input" id="settings-preset-compress-ratio" type="number" min="1" max="100" value="' + (preset.compressRatio ?? 80) + '" placeholder="80">',
    '<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">' + (isZh ? '上下文占用达到此比例时触发压缩 (1-100%)' : 'Trigger compression at this context usage (1-100%)') + '</div>',
    '</div>',
    '</div>',
    '<div class="settings-field">',
    '<label>' + (isZh ? 'Count Token 路径' : 'Count Token Path') + '</label>',
    '<input class="settings-input" id="settings-preset-count-token-path" type="text" value="' + escapeHtml(preset.countTokenPath || '') + '" placeholder="/v1/messages/count_tokens">',
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
    thinkingEffort: null,
    thinkingBudgetTokens: null,
    maxTokens: null,
    temperature: null,
    vision: false,
    contextLength: null,
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

async function saveSettingsPreset(idx) {
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
    const budgetVal = parseInt(budgetRaw, 10);
    if (isNaN(budgetVal) || budgetVal < 512) {
      let errEl = document.getElementById('settings-thinking-budget-error');
      let budgetInput = document.getElementById('settings-preset-thinking-budget');
      if (errEl) {
        errEl.textContent = isZh ? '思考预算至少为 512 tokens' : 'Thinking budget must be at least 512 tokens';
        errEl.style.display = '';
      }
      if (budgetInput) budgetInput.classList.add('invalid');
      return;
    }
    thinkingBudgetTokens = budgetVal;
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
  const clientIdRaw = el('settings-preset-clientid')?.value?.trim() || '';
  const preset = {
    name: (el('settings-preset-name')?.value || '').trim(),
    providerName: presets[idx]?.providerName || '',
    provider: isOAuth ? 'openai' : protocolRaw.replace(/^openai-responses$/, 'openai'),
    apiSurface: (protocolRaw === 'openai-responses' || isOAuth) ? 'responses' : 'chat',
    authType: isOAuth ? 'oauth-codex' : '',
    clientId: isOAuth ? clientIdRaw : '',
    model: (el('settings-preset-model')?.value || '').trim(),
    baseUrl: (el('settings-preset-baseurl')?.value || '').trim(),
    apiKey: isOAuth ? '' : (el('settings-preset-apikey')?.value || '').trim(),
    thinkingEffort: thinkingEffort,
    thinkingBudgetTokens: thinkingBudgetTokens,
    maxTokens: maxTokensRaw !== '' ? parseInt(maxTokensRaw, 10) || null : null,
    temperature: tempRaw !== '' ? parseFloat(tempRaw) || null : null,
    vision: el('settings-preset-vision')?.checked === true,
    contextLength: contextLengthRaw !== '' ? parseInt(contextLengthRaw, 10) || null : null,
    compressRatio: compressRatioRaw !== '' ? Math.max(1, Math.min(100, parseInt(compressRatioRaw, 10) || 80)) : 80,
    countTokenPath: countTokenPathRaw || null,
    customHeaders,
  };
  presets[idx] = preset;
  window.ClawFW.settingsData.presets = presets;
  window.ClawFW.settingsEditing = null;
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
    if (_agent && _agent.id) {
      try {
        let freshRes = await fetch('/protoclaw/prebuilt_sessions?agentId=' + encodeURIComponent(_agent.id));
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
    if (_agent && _agent.id) {
      try {
        let freshRes = await fetch('/protoclaw/prebuilt_sessions?agentId=' + encodeURIComponent(_agent.id));
        if (freshRes.ok) { _agent.workspace_sessions = await freshRes.json(); }
      } catch {}
    }
    if (typeof updateChatContextBar === 'function') { updateChatContextBar(); }
  } catch (error) {
    console.error('Failed to save config:', error);
  }
}

// ── OAuth helper functions ───────────────────────────────────────

function checkOAuthProxy(isZh) {
  fetch('/protoclaw/oauth/codex/defaults')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.proxyConfigured) {
        let display = document.getElementById('oauth-status-display');
        if (display) {
          display.innerHTML = '<div style="color:#e8a847;font-size:12px;padding:4px 0;">'
            + (isZh
              ? '⚠ 未检测到代理 (HTTPS_PROXY)。OpenAI 设备码请求可能被地区限制拦截，请确保已设置环境变量并重启服务'
              : '⚠ No proxy (HTTPS_PROXY) detected. OpenAI device-code requests may be blocked by region restrictions. Ensure the env var is set and restart the server')
            + '</div>';
        }
      }
    })
    .catch(e => console.warn(e));
}

function renderOAuthLoginArea(preset, isZh) {
  let providerName = preset.providerName || '';
  if (!providerName) {
    return '<div class="oauth-status-text" style="color:var(--text-secondary);padding:4px 0;">'
      + (isZh ? '请先保存预设，再登录 OpenAI 账号' : 'Save the preset first, then login with OpenAI')
      + '</div>';
  }
  return [
    '<div id="oauth-status-display" class="oauth-status-text" style="padding:2px 0;"></div>',
    '<div class="oauth-action-row">',
    '<button class="settings-btn settings-btn-primary" type="button" onclick="startOAuthLogin()">'
      + (isZh ? '登录 OpenAI' : 'Login with OpenAI') + '</button>',
    '<button class="settings-btn settings-btn-secondary" type="button" onclick="logoutOAuth()">'
      + (isZh ? '登出' : 'Logout') + '</button>',
    '</div>',
  ].join('');
}

window.onProtocolChange = function() {
  let select = document.getElementById('settings-preset-provider');
  if (!select) return;
  let val = select.value;
  let apiKeySection = document.getElementById('api-key-section');
  let oauthSection = document.getElementById('oauth-section');
  let baseUrlInput = document.getElementById('settings-preset-baseurl');
  let isZh = currentLanguage === 'zh';

  if (typeof window.onProviderChangeUpdateThinking === 'function') window.onProviderChangeUpdateThinking();

  if (val === 'openai-oauth') {
    if (apiKeySection) apiKeySection.style.display = 'none';
    if (oauthSection) oauthSection.style.display = '';
    // Auto-fill Codex base URL if empty or still default anthropic placeholder
    if (baseUrlInput && (!baseUrlInput.value || baseUrlInput.value.indexOf('bigmodel') >= 0)) {
      baseUrlInput.value = 'https://chatgpt.com/backend-api/codex';
    }
    // Auto-fill client_id default
    let cidInput = document.getElementById('settings-preset-clientid');
    if (cidInput && !cidInput.value) cidInput.value = 'app_EMoamEEZ73f0CkXaXp7hrann';
    // Check proxy status and warn if not configured
    checkOAuthProxy(isZh);
    // Load OAuth status
    refreshOAuthStatus();
  } else {
    if (apiKeySection) apiKeySection.style.display = '';
    if (oauthSection) oauthSection.style.display = 'none';
    // Clear Codex base URL if it was auto-filled
    if (baseUrlInput && baseUrlInput.value === 'https://chatgpt.com/backend-api/codex') {
      baseUrlInput.value = '';
    }
  }
};

function getEditingProviderName() {
  let editing = window.ClawFW.settingsEditing;
  if (editing === null) return '';
  let presets = window.ClawFW.settingsData?.presets || [];
  return presets[editing]?.providerName || '';
}

window.startOAuthLogin = function() {
  let providerName = getEditingProviderName();
  if (!providerName) {
    alert(currentLanguage === 'zh' ? '请先保存预设，然后再登录' : 'Please save the preset first, then login');
    return;
  }
  let cidInput = document.getElementById('settings-preset-clientid');
  let clientId = cidInput ? cidInput.value.trim() : '';
  let isZh = currentLanguage === 'zh';

  let display = document.getElementById('oauth-status-display');
  if (display) display.innerHTML = '<span class="oauth-status-text" style="color:var(--text-secondary);">' + (isZh ? '正在请求设备码...' : 'Requesting device code...') + '</span>';

  fetch('/protoclaw/oauth/codex/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerName: providerName, clientId: clientId }),
  })
    .then(async function(r) {
      let data = await r.json().catch(function() { return {}; });
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      return data;
    })
    .then(function(data) {
      if (data.error) throw new Error(data.error);
      pollOAuthLogin(data.sessionId);
    })
    .catch(function(err) {
      if (display) display.innerHTML = '<span class="oauth-status-text" style="color:#e57373;">' + escapeHtml(err.message) + '</span>';
    });
};

var _oauthPollTimer = null;

function pollOAuthLogin(sessionId) {
  if (_oauthPollTimer) clearInterval(_oauthPollTimer);
  let isZh = currentLanguage === 'zh';
  let display = document.getElementById('oauth-status-display');

  let poll = function() {
    fetch('/protoclaw/oauth/codex/status/' + sessionId)
      .then(function(r) {
        if (!r.ok) throw new Error('Session not found');
        return r.json();
      })
      .then(function(sess) {
        if (sess.status === 'pending' || sess.status === 'initiating') {
          let codeHtml = sess.userCode
            ? '<div class="oauth-user-code">' + escapeHtml(sess.userCode) + '</div>'
              + '<div class="oauth-status-text" style="color:var(--text-secondary);">' + (isZh ? '在浏览器打开 ' : 'Open ') + '<a href="' + escapeHtml(sess.verificationUrl) + '" target="_blank">' + escapeHtml(sess.verificationUrl) + '</a>' + (isZh ? ' 并输入上方代码' : ' and enter the code') + '</div>'
            : '<span class="oauth-status-text" style="color:var(--text-secondary);">' + (isZh ? '正在请求设备码...' : 'Requesting device code...') + '</span>';
          if (display) display.innerHTML = codeHtml;
        } else if (sess.status === 'approved') {
          if (_oauthPollTimer) { clearInterval(_oauthPollTimer); _oauthPollTimer = null; }
          if (display) display.innerHTML = '<span class="oauth-status-text" style="color:#81c784;">✓ ' + (isZh ? '登录成功！令牌已保存' : 'Login successful! Token saved.') + '</span>';
        } else if (sess.status === 'expired') {
          if (_oauthPollTimer) { clearInterval(_oauthPollTimer); _oauthPollTimer = null; }
          if (display) display.innerHTML = '<span class="oauth-status-text" style="color:#e57373;">' + (isZh ? '设备码已过期，请重试' : 'Device code expired. Please try again.') + '</span>';
        } else if (sess.status === 'error') {
          if (_oauthPollTimer) { clearInterval(_oauthPollTimer); _oauthPollTimer = null; }
          if (display) display.innerHTML = '<span class="oauth-status-text" style="color:#e57373;">' + escapeHtml(sess.errorMessage || 'Login failed') + '</span>';
        }
      })
      .catch(function(err) {
        // A status read can fail transiently while the background OAuth flow is
        // still healthy. Keep polling instead of abandoning an approved login.
        if (display) {
          display.innerHTML = '<span class="oauth-status-text" style="color:#ffb74d;">'
            + escapeHtml(isZh ? '状态读取失败，正在重试…' : 'Status check failed, retrying…')
            + '<br><small>' + escapeHtml(err && err.message ? err.message : String(err)) + '</small></span>';
        }
      });
  };

  poll();
  _oauthPollTimer = setInterval(poll, 3000);
}

window.logoutOAuth = function() {
  let providerName = getEditingProviderName();
  if (!providerName) return;
  fetch('/protoclaw/oauth/codex/tokens/' + encodeURIComponent(providerName), { method: 'DELETE' })
    .then(function() { refreshOAuthStatus(); });
};

function refreshOAuthStatus() {
  let providerName = getEditingProviderName();
  if (!providerName) return;
  let display = document.getElementById('oauth-status-display');
  if (!display) return;
  let isZh = currentLanguage === 'zh';

  fetch('/protoclaw/oauth/codex/tokens/' + encodeURIComponent(providerName))
    .then(function(r) { return r.json(); })
    .then(function(status) {
      if (status.loggedIn) {
        let expiryStr = status.expiresAt ? new Date(status.expiresAt).toLocaleString() : '';
        let color = status.isExpiring ? '#ffb74d' : '#81c784';
        let icon = status.isExpiring ? '⚠' : '✓';
        let label = status.isExpiring ? (isZh ? '即将过期' : 'Expiring soon') : (isZh ? '已登录' : 'Logged in');
        display.innerHTML = '<span class="oauth-status-text" style="color:' + color + ';">' + icon + ' ' + label
          + (expiryStr ? ' · ' + (isZh ? '过期: ' : 'Expires: ') + escapeHtml(expiryStr) : '') + '</span>';
      } else {
        display.innerHTML = '<span class="oauth-status-text" style="color:var(--text-secondary);">' + (isZh ? '未登录' : 'Not logged in') + '</span>';
      }
    })
    .catch(function() {
      display.innerHTML = '<span class="oauth-status-text" style="color:var(--text-secondary);">' + (isZh ? '未登录' : 'Not logged in') + '</span>';
    });
}

// ── Proxy overlay (independent) ──────────────────────────────────────────────

window._proxyData = null;

function ensureProxyHost() {
  let host = document.getElementById('proxy-overlay-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'proxy-overlay-host';
    document.body.appendChild(host);
  }
  return host;
}

function openProxySettings() {
  window.ClawFW.proxyOverlayOpen = true;
  renderProxyOverlay();
  _loadProxyPanel();
}

function closeProxySettings() {
  window.ClawFW.proxyOverlayOpen = false;
  let host = document.getElementById('proxy-overlay-host');
  if (host) host.innerHTML = '';
}

function renderProxyOverlay() {
  let host = ensureProxyHost();
  if (!window.ClawFW.proxyOverlayOpen) {
    host.innerHTML = '';
    return;
  }
  let isZh = currentLanguage === 'zh';
  host.innerHTML = [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window" style="width:min(100%,520px);max-height:min(100%,640px);">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + (isZh ? '网络代理' : 'Network Proxy') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + (isZh ? '关闭' : 'Close') + '" onclick="closeProxySettings()">×</button>',
    '</div>',
    '<div id="settings-proxy-container" class="settings-tab-content"></div>',
    '</div>',
    '</div>',
  ].join('');
}

async function _loadProxyPanel() {
  let container = document.getElementById('settings-proxy-container');
  if (!container) return;
  let isZh = currentLanguage === 'zh';

  container.innerHTML = '<div class="proxy-info-text">' + (isZh ? '加载中...' : 'Loading...') + '</div>';

  try {
    let res = await fetch('/protoclaw/proxy_config');
    window._proxyData = await res.json();
  } catch {
    window._proxyData = { config: { enabled: false, url: '' }, detected: { url: null, source: 'none' }, active: { url: null, applied: false } };
  }

  let d = window._proxyData;

  // Detected proxy info — clickable card that auto-fills URL + enables
  let detectedHtml = '';
  if (d.detected && d.detected.url) {
    detectedHtml = '<div class="proxy-detected-box proxy-detected-clickable" id="settings-proxy-detected">'
      + '<div class="proxy-detected-icon">◎</div>'
      + '<div class="proxy-detected-info">'
      + '<div class="proxy-detected-label">' + (isZh ? '检测到系统代理，点击使用' : 'System proxy detected — click to use') + '</div>'
      + '<div class="proxy-detected-url"><code>' + escapeHtml(d.detected.url) + '</code></div>'
      + '</div></div>';
  } else {
    detectedHtml = '<div class="proxy-detected-box proxy-detected-none">'
      + '<div class="proxy-detected-icon">○</div>'
      + '<div class="proxy-detected-info">'
      + '<div class="proxy-detected-label">' + (isZh ? '未检测到系统代理' : 'No system proxy detected') + '</div>'
      + '</div></div>';
  }

  // Active status banner
  let activeHtml = '';
  if (d.active && d.active.applied && d.active.url) {
    activeHtml = '<div class="proxy-active-banner">'
      + '<div class="proxy-active-banner-icon">✓</div>'
      + '<div class="proxy-active-banner-text">'
      + (isZh ? '代理已生效' : 'Proxy active')
      + '</div>'
      + '<code class="proxy-active-banner-url">' + escapeHtml(d.active.url) + '</code>'
      + '</div>';
  } else if (d.config.enabled) {
    activeHtml = '<div class="proxy-active-banner proxy-active-pending">'
      + '<div class="proxy-active-banner-icon">◐</div>'
      + '<div class="proxy-active-banner-text">'
      + (isZh ? '代理已启用，等待应用（需重启 Agent 子进程）' : 'Proxy enabled, pending apply (restart agent child processes)')
      + '</div>'
      + '</div>';
  }

  container.innerHTML = [
    // Description
    '<div class="proxy-info-text">',
    isZh ? '为服务端所有网络请求和 Agent 子进程启用全局代理。' : 'Enable a global proxy for all server-side HTTP requests and agent child processes.',
    '</div>',

    // Detected proxy
    detectedHtml,

    // Active banner
    activeHtml,

    // Enable toggle
    '<div class="proxy-toggle-row">',
    '<div class="proxy-toggle-label">' + (isZh ? '启用代理' : 'Enable Proxy') + '</div>',
    '<label class="proxy-switch">',
    '<input type="checkbox" id="settings-proxy-enabled" ' + (d.config.enabled ? 'checked' : '') + ' />',
    '<span class="proxy-switch-slider"></span>',
    '</label>',
    '</div>',

    // Proxy URL
    '<div class="settings-field">',
    '<label>' + (isZh ? '代理地址' : 'Proxy URL') + '</label>',
    '<input type="text" id="settings-proxy-url" class="settings-input" placeholder="http://127.0.0.1:7890" value="' + escapeHtml(d.config.url || '') + '" />',
    '</div>',

    // Buttons
    '<div class="proxy-btn-row">',
    '<button class="settings-btn settings-btn-secondary" type="button" id="settings-proxy-test">' + (isZh ? '测试连通性' : 'Test') + '</button>',
    '<button class="settings-btn settings-btn-primary" type="button" id="settings-proxy-save" style="margin-left:auto;">' + (isZh ? '保存并应用' : 'Save & Apply') + '</button>',
    '</div>',

    // Status
    '<div id="settings-proxy-status"></div>',
  ].join('');

  // Wire events
  let detectedCard = document.getElementById('settings-proxy-detected');
  if (detectedCard) {
    detectedCard.onclick = function() {
      if (d.detected && d.detected.url) {
        document.getElementById('settings-proxy-url').value = d.detected.url;
        document.getElementById('settings-proxy-enabled').checked = true;
      }
    };
  }
  document.getElementById('settings-proxy-save').onclick = _saveProxy;
  document.getElementById('settings-proxy-test').onclick = _testProxy;
}

async function _saveProxy() {
  let isZh = currentLanguage === 'zh';
  let enabled = document.getElementById('settings-proxy-enabled').checked;
  let url = document.getElementById('settings-proxy-url').value.trim();

  if (enabled && !url) {
    _proxyStatus('error', isZh ? '代理地址不能为空' : 'Proxy URL is required');
    return;
  }

  _proxyStatus('loading', isZh ? '正在保存...' : 'Saving...');
  try {
    let res = await fetch('/protoclaw/proxy_config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enabled, url: url }),
    });
    let data = await res.json();
    if (res.ok) {
      window._proxyData = data;
      let msg = data.active && data.active.applied
        ? (isZh ? '已保存并应用: ' : 'Saved & Applied: ') + (data.active.url || '')
        : (isZh ? '已保存（代理已禁用）' : 'Saved (proxy disabled)');
      _proxyStatus('ok', msg);
    } else {
      _proxyStatus('error', data.error || 'Failed');
    }
  } catch (err) {
    _proxyStatus('error', err.message);
  }
}

async function _testProxy() {
  let isZh = currentLanguage === 'zh';
  _proxyStatus('loading', isZh ? '正在测试...' : 'Testing...');

  try {
    let res = await fetch('/protoclaw/proxy_test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    let data = await res.json();
    if (data.ok) {
      _proxyStatus('ok',
        isZh ? '连接成功 (HTTP ' + data.statusCode + ')' : 'Connected (HTTP ' + data.statusCode + ')',
        data.durationMs + 'ms');
    } else {
      _proxyStatus('error',
        isZh ? '连接失败' : 'Connection failed',
        [data.phase, data.errorCode, data.error].filter(Boolean).join(' · '));
    }
  } catch (err) {
    _proxyStatus('error', isZh ? '测试失败' : 'Test failed', err.message);
  }
}

function _proxyStatus(type, text, detail) {
  let el = document.getElementById('settings-proxy-status');
  if (!el) return;

  let icons = { ok: '✓', error: '✕', loading: '◐' };
  let cls = type === 'ok' ? 'proxy-status-ok' : type === 'error' ? 'proxy-status-error' : 'proxy-status-loading';

  el.innerHTML = '<div class="proxy-status-row ' + cls + '">'
    + '<span class="proxy-status-icon">' + (icons[type] || '') + '</span>'
    + '<span class="proxy-status-text">' + escapeHtml(text) + '</span>'
    + (detail ? '<span class="proxy-status-detail">' + escapeHtml(detail) + '</span>' : '')
    + '</div>';
}

// ── window 导出 ──────────────────────────────────────────────
window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.openProxySettings = openProxySettings;
window.closeProxySettings = closeProxySettings;
window.addSettingsPreset = addSettingsPreset;
window.editSettingsPreset = editSettingsPreset;
window.deleteSettingsPreset = deleteSettingsPreset;
window.saveSettingsPreset = saveSettingsPreset;
window.applySettingsPreset = applySettingsPreset;
window.cancelSettingsEdit = cancelSettingsEdit;
