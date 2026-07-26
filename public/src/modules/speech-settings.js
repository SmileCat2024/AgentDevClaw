/**
 * speech-settings.js — 语音模型预设管理模块（从 settings-overlay.js 拆分）
 *
 * 包含：语音模型预设的渲染、增删改、应用、持久化。
 * 依赖（全局）：escapeHtml, currentLanguage, renderSettingsOverlay
 */

function renderSpeechModelSection(isZh) {
  const sc = window.ClawFW._speechModelConfig || {};
  const presets = window.ClawFW._speechPresets || [];
  const speechEditing = window.ClawFW._speechEditing; // null = not editing, 'new' = new preset, number = edit existing
  const configured = !!(sc.baseUrl && sc.apiKey);

  // Find active preset
  const activePreset = presets.find(function(p) {
    return p.baseUrl === sc.baseUrl && p.apiKey === sc.apiKey && p.model === sc.model;
  });
  const activePresetName = activePreset ? (activePreset.name || activePreset.model || '') : '';

  // Active banner
  const activeBanner = [
    '<div class="settings-active-banner">',
    '<div class="settings-active-icon">',
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>',
    '</div>',
    '<div class="settings-active-info">',
    '<div class="settings-active-label">' + (isZh ? '当前激活' : 'ACTIVE') + '</div>',
    configured
      ? '<div class="settings-active-name">' + escapeHtml(activePresetName || sc.model || (isZh ? '自定义配置' : 'Custom Config')) + '</div>' +
        '<div class="settings-active-detail">' + escapeHtml((sc.model || '—') + (sc.language ? ' · ' + sc.language : '') + (sc.baseUrl ? ' · ' + sc.baseUrl : '')) + '</div>'
      : '<div class="settings-active-name">' + (isZh ? '未配置' : 'Not Configured') + '</div>' +
        '<div class="settings-active-detail">' + (isZh ? '请添加并激活一个语音模型预设' : 'Add and activate a speech model preset') + '</div>',
    '</div>',
    activePresetName ? '<div class="settings-active-badge">' + (isZh ? '预设' : 'Preset') + '</div>' : '',
    '</div>',
  ].join('');

  // If editing a preset, show edit form (without active banner for focus)
  if (speechEditing != null) {
    const editPreset = speechEditing === 'new'
      ? { name: '', baseUrl: '', apiKey: '', model: '', language: 'auto' }
      : (presets[speechEditing] || {});
    return { banner: '', content: renderSpeechPresetEditForm(editPreset, speechEditing, isZh) };
  }

  // Preset list
  const presetCards = presets.length
    ? presets.map(function(p, idx) {
        const isActive = p.baseUrl === sc.baseUrl && p.apiKey === sc.apiKey && p.model === sc.model;
        return [
          '<div class="settings-preset-card' + (isActive ? ' active' : '') + '" onclick="applySpeechPreset(' + idx + ')">',
          '<div class="settings-preset-dot"></div>',
          '<div class="settings-preset-info">',
          '<div class="settings-preset-name">' + escapeHtml(p.name || p.model || ('Preset ' + (idx + 1))) + '</div>',
          '<div class="settings-preset-detail">' + escapeHtml((p.model || '—') + (p.language ? ' · ' + p.language : '')) + '</div>',
          '</div>',
          '<div class="settings-preset-actions">',
          '<button class="settings-icon-btn" type="button" title="' + (isZh ? '编辑' : 'Edit') + '" onclick="event.stopPropagation();editSpeechPreset(' + idx + ')">',
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
          '</button>',
          '<button class="settings-icon-btn danger" type="button" title="' + (isZh ? '删除' : 'Delete') + '" onclick="event.stopPropagation();deleteSpeechPreset(' + idx + ')">',
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>',
          '</button>',
          '</div>',
          '</div>',
        ].join('');
      }).join('')
    : '<div style="padding:16px;text-align:center;color:var(--text-secondary);font-size:13px;">' + (isZh ? '暂无预设，点击下方按钮添加' : 'No presets yet. Click below to add one') + '</div>';

  return {
    banner: '<div class="settings-section">' + activeBanner + '</div>',
    content: '<div class="settings-section"><div class="settings-section-title">' + (isZh ? '语音预设列表' : 'Speech Presets') + '</div><div class="settings-presets-compact">' + presetCards + '</div></div>'
  };
}

function renderSpeechPresetEditForm(preset, editIdx, isZh) {
  const isNew = editIdx === 'new';
  return [
    '<div class="settings-section">',
    '<div class="settings-section-title">' + (isNew ? (isZh ? '新建语音预设' : 'New Speech Preset') : (isZh ? '编辑语音预设' : 'Edit Speech Preset')) + '</div>',
    '<div class="settings-field">',
    '<label>' + (isZh ? '名称' : 'Name') + '</label>',
    '<input class="settings-input" id="speech-preset-name" type="text" value="' + escapeHtml(preset.name || '') + '" placeholder="' + (isZh ? '例如：小米 MiMo ASR' : 'e.g. MiMo ASR') + '">',
    '</div>',
    '<div class="settings-field">',
    '<label>Base URL</label>',
    '<input class="settings-input" id="speech-preset-baseurl" type="text" value="' + escapeHtml(preset.baseUrl || '') + '" placeholder="https://api.xiaomimimo.com/v1">',
    '</div>',
    '<div class="settings-field">',
    '<label>API Key</label>',
    '<div style="position:relative;display:flex;align-items:stretch;">',
    '<input class="settings-input" id="speech-preset-apikey" type="password" value="' + escapeHtml(preset.apiKey || '') + '" placeholder="sk-..." style="padding-right:40px;">',
    '<button type="button" onclick="toggleSpeechApiKeyVisibility()" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;padding:4px;display:flex;align-items:center;justify-content:center;color:var(--text-secondary);transition:color 0.2s;" onmouseover="this.style.color=\'var(--text-primary)\'" onmouseout="this.style.color=\'var(--text-secondary)\'" title="' + (isZh ? '显示/隐藏' : 'Show/Hide') + '">',
    '<svg id="speech-apikey-eye-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
    '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>',
    '<circle cx="12" cy="12" r="3"></circle>',
    '</svg>',
    '<svg id="speech-apikey-eye-off-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;">',
    '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>',
    '<line x1="1" y1="1" x2="23" y2="23"></line>',
    '</svg>',
    '</button>',
    '</div>',
    '</div>',
    '<div class="settings-row">',
    '<div class="settings-field">',
    '<label>Model</label>',
    '<input class="settings-input" id="speech-preset-model" type="text" value="' + escapeHtml(preset.model || '') + '" placeholder="model-name">',
    '</div>',
    '<div class="settings-field">',
    '<label>' + (isZh ? '语言' : 'Language') + '</label>',
    '<select class="settings-input" data-claw-select id="speech-preset-language">',
    '<option value="auto"' + ((preset.language || 'auto') === 'auto' ? ' selected' : '') + '>' + (isZh ? '自动检测' : 'Auto Detect') + '</option>',
    '<option value="zh"' + (preset.language === 'zh' ? ' selected' : '') + '>' + (isZh ? '中文' : 'Chinese') + '</option>',
    '<option value="en"' + (preset.language === 'en' ? ' selected' : '') + '>' + (isZh ? '英文' : 'English') + '</option>',
    '</select>',
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}

function toggleSpeechApiKeyVisibility() {
  const input = document.getElementById('speech-preset-apikey');
  const eyeIcon = document.getElementById('speech-apikey-eye-icon');
  const eyeOffIcon = document.getElementById('speech-apikey-eye-off-icon');

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

window.toggleSpeechApiKeyVisibility = toggleSpeechApiKeyVisibility;

window.addSpeechPreset = function() {
  window.ClawFW._speechEditing = 'new';
  renderSettingsOverlay();
};

window.editSpeechPreset = function(idx) {
  window.ClawFW._speechEditing = idx;
  renderSettingsOverlay();
};

window.cancelSpeechPresetEdit = function() {
  window.ClawFW._speechEditing = null;
  renderSettingsOverlay();
};

window.deleteSpeechPreset = async function(idx) {
  const presets = window.ClawFW._speechPresets || [];
  presets.splice(idx, 1);
  window.ClawFW._speechPresets = presets;
  window.ClawFW._speechEditing = null;
  await saveSpeechFullConfig();
};

window.applySpeechPreset = async function(idx) {
  const presets = window.ClawFW._speechPresets || [];
  const preset = presets[idx];
  if (!preset) return;
  // Set as active speech model
  window.ClawFW._speechModelConfig = {
    baseUrl: preset.baseUrl || '',
    apiKey: preset.apiKey || '',
    model: preset.model || '',
    language: preset.language || 'auto',
  };
  await saveSpeechFullConfig();
};

window.saveSpeechPreset = async function(editIdx) {
  const el = (id) => document.getElementById(id);
  const preset = {
    name: (el('speech-preset-name')?.value || '').trim(),
    baseUrl: (el('speech-preset-baseurl')?.value || '').trim(),
    apiKey: (el('speech-preset-apikey')?.value || '').trim(),
    model: (el('speech-preset-model')?.value || '').trim(),
    language: el('speech-preset-language')?.value || 'auto',
  };
  const presets = window.ClawFW._speechPresets || [];
  // Check if there's currently an active speech model
  let sc = window.ClawFW._speechModelConfig || {};
  let wasActive = !!(sc.baseUrl && sc.apiKey);
  if (editIdx === 'new') {
    presets.push(preset);
    editIdx = presets.length - 1;
  } else {
    presets[editIdx] = preset;
  }
  window.ClawFW._speechPresets = presets;
  window.ClawFW._speechEditing = null;
  await saveSpeechFullConfig();
  if (!wasActive) {
    await window.applySpeechPreset(editIdx);
  }
};

async function saveSpeechFullConfig() {
  const speechModel = window.ClawFW._speechModelConfig || { baseUrl: '', apiKey: '', model: '', language: 'auto' };
  const speechPresets = window.ClawFW._speechPresets || [];
  try {
    const resp = await fetch('/protoclaw/speech_model_config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speechModel, speechPresets }),
    });
    const result = await resp.json();
    window.ClawFW._speechModelConfig = result.speechModel;
    window.ClawFW._speechPresets = Array.isArray(result.speechPresets) ? result.speechPresets : [];
    renderSettingsOverlay();
  } catch (error) {
    console.error('Failed to save speech model config:', error);
  }
}
