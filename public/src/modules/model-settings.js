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
          '<div class="settings-preset-detail">' + escapeHtml((p.provider || '—') + ' · ' + (p.model || '—')) + (p.vision ? ' · 🖼️' : '') + (p.authType === 'oauth-codex' ? ' · 🔑' : '') + '</div>',
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
  const tabProxy = activeTab === 'proxy';
  const tabBar = [
    '<div class="settings-tab-bar">',
    '<button class="settings-tab' + (tabText ? ' active' : '') + '" type="button" onclick="switchSettingsTab(\'text\')">',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>',
    (isZh ? '文本模型' : 'Text Model'),
    '</button>',
    '<button class="settings-tab' + (!tabText && !tabProxy ? ' active' : '') + '" type="button" onclick="switchSettingsTab(\'speech\')">',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>',
    (isZh ? '语音模型' : 'Speech Model'),
    '</button>',
    '<button class="settings-tab' + (tabProxy ? ' active' : '') + '" type="button" onclick="switchSettingsTab(\'proxy\')">',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>',
    (isZh ? '网络代理' : 'Proxy'),
    '</button>',
    '</div>',
  ].join('');

  // ── Tab content ──
  let tabContent = '';

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

    tabContent = [
      /* Active Config Banner (always visible) */
      '<div class="settings-section">',
      activeBanner,
      '</div>',

      /* Presets Section (hidden when editing) */
      editing === null ? [
        '<div class="settings-section">',
        '<div class="settings-section-title">' + (isZh ? '预设列表' : 'Presets') + '</div>',
        '<div class="settings-presets-grid">' + presetCards + '</div>',
        '<button class="settings-btn settings-btn-secondary" type="button" style="align-self:flex-start;margin-top:4px;" onclick="addSettingsPreset()">+ ' + (isZh ? '添加预设' : 'Add Preset') + '</button>',
        '</div>',
      ].join('') : '',

      /* Edit Form (inline) */
      editing !== null ? renderSettingsEditForm(editing, presets, isZh) : '',
    ].join('');
  } else if (tabProxy) {
    tabContent = '<div id="settings-proxy-container"></div>';
  } else {
    // Speech model tab
    tabContent = renderSpeechModelSection(isZh);
  }

  host.innerHTML = [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window" style="width:min(100%,560px);max-height:min(100%,720px);">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + (isZh ? '设置' : 'Settings') + '</div>',
    '<div class="feature-detail-subtitle">' + (isZh ? '管理模型预设与网络代理' : 'Manage model presets and network proxy') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + (isZh ? '关闭' : 'Close') + '" onclick="closeSettings()">×</button>',
    '</div>',

    tabBar,
    '<div class="settings-tab-content">',
    tabContent,
    '</div>',

    '</div>',
    '</div>',
  ].join('');

  if (tabProxy) {
    _loadProxyPanel();
  }
}

window.switchSettingsTab = function(tab) {
  window.ClawFW.settingsTab = tab;
  renderSettingsOverlay();
};

function renderSettingsEditForm(editIdx, presets, isZh) {
  const preset = presets[editIdx] || {};
  const isNew = preset._isNew;
  var dropdownVal = preset.authType === 'oauth-codex' ? 'openai-oauth'
    : (preset.provider === 'openai' && (preset.apiSurface || 'chat') === 'responses' ? 'openai-responses'
    : (preset.provider || 'anthropic'));
  var isOAuthMode = dropdownVal === 'openai-oauth';
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
    '<select class="settings-input" id="settings-preset-provider" onchange="onProtocolChange()">',
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
    '<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">' + (isZh ? 'OpenAI 应用注册的 client_id。使用其他 Agent 的 client_id 可伪装为该应用' : 'OpenAI application client_id. Using another agent\'s client_id impersonates that app') + '</div>',
    '</div>',
    '<div class="settings-field" id="oauth-login-area">',
    renderOAuthLoginArea(preset, isZh),
    '</div>',
    '</div>',
    '<div class="settings-row">',
    '<div class="settings-field">',
    '<label>Thinking Budget Tokens</label>',
    '<input class="settings-input" id="settings-preset-thinking" type="number" value="' + (preset.thinkingBudgetTokens ?? '') + '" placeholder="' + (isZh ? '留空使用默认值' : 'Leave empty for default') + '">',
    '</div>',
    '<div class="settings-field">',
    '<label>Max Output Tokens</label>',
    '<input class="settings-input" id="settings-preset-max-tokens" type="number" value="' + (preset.maxTokens ?? '') + '" placeholder="' + (isZh ? '留空自动计算' : 'Leave empty for auto') + '">',
    '<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">' + (isZh ? '含思考内容的总输出上限。留空时框架会根据思考预算自动推算' : 'Total output cap incl. thinking. Auto-calculated from thinking budget when empty') + '</div>',
    '</div>',
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
    '<div class="settings-actions">',
    '<button class="settings-btn settings-btn-secondary" type="button" onclick="cancelSettingsEdit()">' + (isZh ? '取消' : 'Cancel') + '</button>',
    '<button class="settings-btn settings-btn-primary" type="button" onclick="saveSettingsPreset(' + editIdx + ')">' + (isZh ? '保存' : 'Save') + '</button>',
    '</div>',
    '</div>',
  ].join('');
}

function createSettingsHeaderRowHTML(idx, key, value, mode, isZh) {
  var isDynamic = mode === 'uuid' || mode === 'random';
  var modeOptions = [
    '<option value="static"' + (mode === 'static' ? ' selected' : '') + '>' + (isZh ? '固定值' : 'Static') + '</option>',
    '<option value="uuid"' + (mode === 'uuid' ? ' selected' : '') + '>UUID v4</option>',
    '<option value="random"' + (mode === 'random' ? ' selected' : '') + '>' + (isZh ? '随机数' : 'Random') + '</option>',
  ].join('');
  return [
    '<div data-header-row style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">',
    '<input class="settings-input" data-header-key type="text" value="' + escapeHtml(key) + '" placeholder="' + (isZh ? 'Header 名' : 'Header name') + '" style="flex:1;min-width:0;">',
    '<select class="settings-input" data-header-mode style="width:90px;flex-shrink:0;" onchange="onSettingsHeaderModeChange(this)">' + modeOptions + '</select>',
    '<input class="settings-input" data-header-value type="text" value="' + escapeHtml(value) + '" placeholder="' + (isDynamic ? '(auto)' : (isZh ? 'Header 值' : 'Header value')) + '" style="flex:1;min-width:0;' + (isDynamic ? 'opacity:0.4;' : '') + '"' + (isDynamic ? ' disabled' : '') + '>',
    '<button type="button" onclick="this.closest(\'[data-header-row]\').remove()" style="background:none;border:none;cursor:pointer;padding:6px;color:var(--text-secondary);flex-shrink:0;" title="' + (isZh ? '删除' : 'Delete') + '">',
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>',
    '</button>',
    '</div>',
  ].join('');
}

window.addSettingsHeaderRow = function() {
  var container = document.getElementById('settings-headers-container');
  if (!container) return;
  var isZh = currentLanguage === 'zh';
  container.insertAdjacentHTML('beforeend', createSettingsHeaderRowHTML(container.children.length, '', '', 'static', isZh));
};

window.onSettingsHeaderModeChange = function(select) {
  var row = select.closest('[data-header-row]');
  var valueInput = row ? row.querySelector('[data-header-value]') : null;
  if (!valueInput) return;
  var isDynamic = select.value === 'uuid' || select.value === 'random';
  var isZh = currentLanguage === 'zh';
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
  const thinkingRaw = el('settings-preset-thinking')?.value?.trim();
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
    thinkingBudgetTokens: thinkingRaw !== '' ? parseInt(thinkingRaw, 10) || null : null,
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
  await saveSettingsConfig();
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
    const result = await resp.json();
    window.ClawFW.settingsData.config = result.config;
    window.ClawFW.settingsData.presets = result.presets;
    window.ClawFW._modelPresets = Array.isArray(result?.presets) ? result.presets : [];
    renderSettingsOverlay();
    // Refresh session data to reflect updated model config
    var _agent = typeof getCurrentAgentRecord === 'function' ? getCurrentAgentRecord() : null;
    if (_agent && _agent.id) {
      try {
        var freshRes = await fetch('/protoclaw/prebuilt_sessions?agentId=' + encodeURIComponent(_agent.id));
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
    const result = await resp.json();
    window.ClawFW.settingsData.config = result.config;
    window.ClawFW.settingsData.presets = result.presets;
    window.ClawFW._modelPresets = Array.isArray(result?.presets) ? result.presets : [];
    renderSettingsOverlay();
    // Refresh session data to reflect updated model config
    var _agent = typeof getCurrentAgentRecord === 'function' ? getCurrentAgentRecord() : null;
    if (_agent && _agent.id) {
      try {
        var freshRes = await fetch('/protoclaw/prebuilt_sessions?agentId=' + encodeURIComponent(_agent.id));
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
        var display = document.getElementById('oauth-status-display');
        if (display) {
          display.innerHTML = '<div style="color:#e8a847;font-size:12px;padding:4px 0;">'
            + (isZh
              ? '⚠ 未检测到代理 (HTTPS_PROXY)。OpenAI 设备码请求可能被地区限制拦截，请确保已设置环境变量并重启服务'
              : '⚠ No proxy (HTTPS_PROXY) detected. OpenAI device-code requests may be blocked by region restrictions. Ensure the env var is set and restart the server')
            + '</div>';
        }
      }
    })
    .catch(function() {});
}

function renderOAuthLoginArea(preset, isZh) {
  var providerName = preset.providerName || '';
  if (!providerName) {
    return '<div class="oauth-status-text" style="color:var(--text-secondary);padding:6px 0;">'
      + (isZh ? '请先保存预设，再登录 OpenAI 账号' : 'Save the preset first, then login with OpenAI')
      + '</div>';
  }
  return [
    '<div class="oauth-login-box">',
    '<div id="oauth-status-display" class="oauth-status-text" style="margin-bottom:6px;"></div>',
    '<div class="oauth-btn-row">',
    '<button class="oauth-btn" type="button" onclick="startOAuthLogin()">'
      + (isZh ? '🔑 登录 OpenAI' : '🔑 Login with OpenAI') + '</button>',
    '<button class="oauth-btn" type="button" onclick="logoutOAuth()">'
      + (isZh ? '登出' : 'Logout') + '</button>',
    '</div>',
    '</div>',
  ].join('');
}

window.onProtocolChange = function() {
  var select = document.getElementById('settings-preset-provider');
  if (!select) return;
  var val = select.value;
  var apiKeySection = document.getElementById('api-key-section');
  var oauthSection = document.getElementById('oauth-section');
  var baseUrlInput = document.getElementById('settings-preset-baseurl');
  var isZh = currentLanguage === 'zh';

  if (val === 'openai-oauth') {
    if (apiKeySection) apiKeySection.style.display = 'none';
    if (oauthSection) oauthSection.style.display = '';
    // Auto-fill Codex base URL if empty or still default anthropic placeholder
    if (baseUrlInput && (!baseUrlInput.value || baseUrlInput.value.indexOf('bigmodel') >= 0)) {
      baseUrlInput.value = 'https://chatgpt.com/backend-api/codex';
    }
    // Auto-fill client_id default
    var cidInput = document.getElementById('settings-preset-clientid');
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
  var editing = window.ClawFW.settingsEditing;
  if (editing === null) return '';
  var presets = window.ClawFW.settingsData?.presets || [];
  return presets[editing]?.providerName || '';
}

window.startOAuthLogin = function() {
  var providerName = getEditingProviderName();
  if (!providerName) {
    alert(currentLanguage === 'zh' ? '请先保存预设，然后再登录' : 'Please save the preset first, then login');
    return;
  }
  var cidInput = document.getElementById('settings-preset-clientid');
  var clientId = cidInput ? cidInput.value.trim() : '';
  var isZh = currentLanguage === 'zh';

  var display = document.getElementById('oauth-status-display');
  if (display) display.innerHTML = '<span class="oauth-status-text" style="color:var(--text-secondary);">' + (isZh ? '正在请求设备码...' : 'Requesting device code...') + '</span>';

  fetch('/protoclaw/oauth/codex/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerName: providerName, clientId: clientId }),
  })
    .then(async function(r) {
      var data = await r.json().catch(function() { return {}; });
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
  var isZh = currentLanguage === 'zh';
  var display = document.getElementById('oauth-status-display');

  var poll = function() {
    fetch('/protoclaw/oauth/codex/status/' + sessionId)
      .then(function(r) {
        if (!r.ok) throw new Error('Session not found');
        return r.json();
      })
      .then(function(sess) {
        if (sess.status === 'pending' || sess.status === 'initiating') {
          var codeHtml = sess.userCode
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
  var providerName = getEditingProviderName();
  if (!providerName) return;
  fetch('/protoclaw/oauth/codex/tokens/' + encodeURIComponent(providerName), { method: 'DELETE' })
    .then(function() { refreshOAuthStatus(); });
};

function refreshOAuthStatus() {
  var providerName = getEditingProviderName();
  if (!providerName) return;
  var display = document.getElementById('oauth-status-display');
  if (!display) return;
  var isZh = currentLanguage === 'zh';

  fetch('/protoclaw/oauth/codex/tokens/' + encodeURIComponent(providerName))
    .then(function(r) { return r.json(); })
    .then(function(status) {
      if (status.loggedIn) {
        var expiryStr = status.expiresAt ? new Date(status.expiresAt).toLocaleString() : '';
        var color = status.isExpiring ? '#ffb74d' : '#81c784';
        var icon = status.isExpiring ? '⚠' : '✓';
        var label = status.isExpiring ? (isZh ? '即将过期' : 'Expiring soon') : (isZh ? '已登录' : 'Logged in');
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

// ── Proxy panel ─────────────────────────────────────────────────

window._proxyData = null;

async function _loadProxyPanel() {
  var container = document.getElementById('settings-proxy-container');
  if (!container) return;
  var isZh = currentLanguage === 'zh';

  container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-secondary);">' + (isZh ? '加载中...' : 'Loading...') + '</div>';

  try {
    var res = await fetch('/protoclaw/proxy_config');
    window._proxyData = await res.json();
  } catch {
    window._proxyData = { config: { enabled: false, url: '' }, detected: { url: null, source: 'none' }, active: { url: null, applied: false } };
  }

  var d = window._proxyData;
  var detectedHint = '';
  var detectedBtnText = '';
  if (d.detected && d.detected.url) {
    detectedHint = isZh
      ? '检测到系统代理: ' + d.detected.url + ' (' + (d.detected.source === 'registry' ? '注册表' : '环境变量') + ')'
      : 'System proxy detected: ' + d.detected.url + ' (' + d.detected.source + ')';
    detectedBtnText = isZh ? '使用检测到的代理' : 'Use Detected';
  } else {
    detectedHint = isZh ? '未检测到系统代理' : 'No system proxy detected';
  }

  var activeHtml = '';
  if (d.active && d.active.applied && d.active.url) {
    activeHtml = '<div style="margin-top:8px;padding:8px 12px;background:rgba(129,199,132,0.1);border-radius:6px;font-size:13px;">'
      + (isZh ? '代理已生效: ' : 'Proxy active: ') + '<code>' + escapeHtml(d.active.url) + '</code></div>';
  }

  container.innerHTML = [
    '<div style="padding:16px 4px;">',
    // Description
    '<div style="margin-bottom:16px;font-size:13px;color:var(--text-secondary);line-height:1.5;">',
    isZh ? '为服务端所有网络请求和 Agent 子进程启用代理。Node.js 不会自动读取系统代理，需要在此手动配置。' : 'Enable proxy for all server-side HTTP requests and agent child processes. Node.js does not read system proxy settings automatically.',
    '</div>',

    // Enable toggle
    '<div class="settings-row">',
    '<div style="flex:1;">',
    '<div style="font-weight:500;font-size:14px;margin-bottom:2px;">' + (isZh ? '启用代理' : 'Enable Proxy') + '</div>',
    '</div>',
    '<input type="checkbox" id="settings-proxy-enabled" class="settings-toggle" ' + (d.config.enabled ? 'checked' : '') + ' />',
    '</div>',

    // Proxy URL
    '<div style="margin-top:12px;">',
    '<label style="font-size:13px;font-weight:500;display:block;margin-bottom:4px;">' + (isZh ? '代理地址' : 'Proxy URL') + '</label>',
    '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">' + escapeHtml(detectedHint) + '</div>',
    '<input type="text" id="settings-proxy-url" class="settings-input" placeholder="http://127.0.0.1:7890" value="' + escapeHtml(d.config.url || '') + '" />',
    '</div>',

    // Buttons
    '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">',
    detectedBtnText ? '<button class="settings-btn settings-btn-secondary" type="button" id="settings-proxy-use-detected">' + escapeHtml(detectedBtnText) + '</button>' : '',
    '<button class="settings-btn settings-btn-primary" type="button" id="settings-proxy-save">' + (isZh ? '保存并应用' : 'Save & Apply') + '</button>',
    '<button class="settings-btn settings-btn-secondary" type="button" id="settings-proxy-test">' + (isZh ? '测试连通性' : 'Test') + '</button>',
    '</div>',

    // Status
    '<div id="settings-proxy-status" style="margin-top:12px;"></div>',

    // Active state
    activeHtml,
    '</div>',
  ].join('');

  // Wire events
  var detectedBtn = document.getElementById('settings-proxy-use-detected');
  if (detectedBtn) {
    detectedBtn.onclick = function() {
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
  var isZh = currentLanguage === 'zh';
  var enabled = document.getElementById('settings-proxy-enabled').checked;
  var url = document.getElementById('settings-proxy-url').value.trim();

  if (enabled && !url) {
    _proxyStatus('error', isZh ? '代理地址不能为空' : 'Proxy URL is required');
    return;
  }

  _proxyStatus('loading', isZh ? '正在保存...' : 'Saving...');
  try {
    var res = await fetch('/protoclaw/proxy_config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enabled, url: url }),
    });
    var data = await res.json();
    if (res.ok) {
      window._proxyData = data;
      var msg = data.active && data.active.applied
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
  var isZh = currentLanguage === 'zh';
  _proxyStatus('loading', isZh ? '正在测试...' : 'Testing...');

  try {
    var res = await fetch('/protoclaw/proxy_test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    var data = await res.json();
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
  var el = document.getElementById('settings-proxy-status');
  if (!el) return;

  var colors = { ok: '#81c784', error: '#e57373', loading: 'var(--text-secondary)' };
  var icons = { ok: '✓', error: '✕', loading: '◐' };

  el.innerHTML = '<div style="padding:8px 12px;border-radius:6px;font-size:13px;display:flex;align-items:center;gap:6px;background:'
    + (type === 'ok' ? 'rgba(129,199,132,0.1)' : type === 'error' ? 'rgba(229,115,115,0.1)' : 'rgba(128,128,128,0.08)')
    + ';">'
    + '<span style="color:' + (colors[type] || 'inherit') + ';font-weight:bold;">' + (icons[type] || '') + '</span>'
    + '<span style="color:' + (colors[type] || 'inherit') + ';">' + escapeHtml(text) + '</span>'
    + (detail ? '<span style="color:var(--text-secondary);font-size:12px;margin-left:auto;">' + escapeHtml(detail) + '</span>' : '')
    + '</div>';
}

// ── window 导出 ──────────────────────────────────────────────
window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.addSettingsPreset = addSettingsPreset;
window.editSettingsPreset = editSettingsPreset;
window.deleteSettingsPreset = deleteSettingsPreset;
window.saveSettingsPreset = saveSettingsPreset;
window.applySettingsPreset = applySettingsPreset;
window.cancelSettingsEdit = cancelSettingsEdit;
