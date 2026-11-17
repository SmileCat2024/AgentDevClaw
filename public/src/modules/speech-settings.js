/**
 * speech-settings.js — 语音模型预设管理模块（从 settings-overlay.js 拆分）
 *
 * 包含：语音模型预设的渲染、增删改、应用、持久化。
 *
 * ESM 化（P2 消费方批次 7）：命名导出 + 显式 import（语音配置缓存、转义）。
 * 与 model-settings 互为 UI 依赖（本模块取设置面板重渲染，设置面板取本模块的
 * 语音区渲染与文案标签）：静态依赖方向为 model-settings → 本模块，反向经
 * configureSpeechSettingsHost 注入的宿主面。
 * 预设编辑态由本模块持有（getSpeechEditing / setSpeechEditing），设置面板
 * owner 经命名导出读写，不再借宿 window.ClawFW._speechEditing。
 *
 * 事件接线：模板经 data-action="speech.*" 声明，处理器集中在文件尾部注册。
 */
import { escapeHtml } from './markdown-utils.js';
import {
  getClawSpeechModelConfig,
  getClawSpeechPresets,
  setClawSpeechModelConfig,
  setClawSpeechPresets,
} from './speech-config-cache.js';
// —— 设置覆盖层宿主面（由 model-settings.js 求值末尾装配）——
// 本模块是设置覆盖层的语音子面板，增删改后需要面板 owner 重渲染；与 model-settings
// 互为 UI 依赖，依赖方向仍固定为单向：覆盖层由面板 owner（model-settings）装配，
// 子面板不反向 import 面板，需要的面板能力只经本宿主面注入——这是职责约定，
// 不宣称「互 import 必然出错」：真实 ESM 图里同一文件只有一个 URL，环不会复制
// 模块实例（早期「环会产生两份实例」的说法来自旧 unique-query 装载器的缓存切图）。
let overlayHost = null;

// 语音预设的编辑态：null = 未编辑、'new' = 新建、number = 编辑既有预设。
// owner 在本模块（预设列表与编辑表单都在这里渲染）；设置覆盖层 owner
// （model-settings）经 getSpeechEditing / setSpeechEditing 读写，不再借宿
// window.ClawFW。
let speechEditing = null;

export function getSpeechEditing() {
  return speechEditing;
}

export function setSpeechEditing(value) {
  speechEditing = value;
}

export function configureSpeechSettingsHost(host) {
  overlayHost = host;
}

function speechSettingsHost() {
  if (!overlayHost) {
    throw new Error('[speech-settings] 设置覆盖层宿主未装配（应由 model-settings 装载时注入）');
  }
  return overlayHost;
}

function speechApiTypeLabel(apiType) {
  if (apiType === 'audio') return 'Audio';
  if (apiType === 'audio-stream') return 'Stream';
  return 'Chat';
}

// 归一化 apiType：未知值一律回退 chat（与服务端 normalizeSpeechModel 同语义）
function normalizeSpeechApiTypeValue(value) {
  return value === 'audio' || value === 'audio-stream' ? value : 'chat';
}

function renderSpeechModelSection(isZh) {
  const sc = getClawSpeechModelConfig() || {};
  const presets = getClawSpeechPresets();
  const configured = !!(sc.baseUrl && sc.apiKey);

  // Find active preset (apiType participates: presets differing only in
  // upstream format must not collapse onto the same active card)
  const activePreset = presets.find(function(p) {
    return p.baseUrl === sc.baseUrl && p.apiKey === sc.apiKey && p.model === sc.model
      && (p.apiType || 'chat') === (sc.apiType || 'chat');
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
        '<div class="settings-active-detail">' + escapeHtml(speechApiTypeLabel(sc.apiType) + ' · ' + (sc.model || '—') + (sc.language ? ' · ' + sc.language : '') + (sc.baseUrl ? ' · ' + sc.baseUrl : '')) + '</div>'
      : '<div class="settings-active-name">' + (isZh ? '未配置' : 'Not Configured') + '</div>' +
        '<div class="settings-active-detail">' + (isZh ? '请添加并激活一个语音模型预设' : 'Add and activate a speech model preset') + '</div>',
    '</div>',
    activePresetName ? '<div class="settings-active-badge">' + (isZh ? '预设' : 'Preset') + '</div>' : '',
    '</div>',
  ].join('');

  // If editing a preset, show edit form (without active banner for focus)
  // （speechEditing：null = 未编辑、'new' = 新建、number = 编辑既有预设）
  if (speechEditing != null) {
    const editPreset = speechEditing === 'new'
      ? { name: '', baseUrl: '', apiKey: '', model: '', language: 'auto', apiType: 'chat' }
      : (presets[speechEditing] || {});
    return { banner: '', content: renderSpeechPresetEditForm(editPreset, speechEditing, isZh) };
  }

  // Preset list
  const presetCards = presets.length
    ? presets.map(function(p, idx) {
        const isActive = p.baseUrl === sc.baseUrl && p.apiKey === sc.apiKey && p.model === sc.model
          && (p.apiType || 'chat') === (sc.apiType || 'chat');
        return [
          '<div class="settings-preset-card' + (isActive ? ' active' : '') + '" data-action="speech.applyPreset" data-args="[' + idx + ']">',
          '<div class="settings-preset-dot"></div>',
          '<div class="settings-preset-info">',
          '<div class="settings-preset-name">' + escapeHtml(p.name || p.model || ('Preset ' + (idx + 1))) + '</div>',
          '<div class="settings-preset-detail">' + escapeHtml(speechApiTypeLabel(p.apiType) + ' · ' + (p.model || '—') + (p.language ? ' · ' + p.language : '')) + '</div>',
          '</div>',
          '<div class="settings-preset-actions">',
          '<button class="settings-icon-btn" type="button" title="' + (isZh ? '编辑' : 'Edit') + '" data-action="speech.editPreset" data-args="[' + idx + ']">',
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
          '</button>',
          '<button class="settings-icon-btn danger" type="button" title="' + (isZh ? '删除' : 'Delete') + '" data-action="speech.deletePreset" data-args="[' + idx + ']">',
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>',
          '</button>',
          '</div>',
          '</div>',
        ].join('');
      }).join('')
    : '<div style="padding:16px;text-align:center;color:var(--text-secondary);font-size:13px;">' + (isZh ? '暂无预设，点击下方按钮添加' : 'No presets yet. Click below to add one') + '</div>';

  return {
    banner: '<div class="settings-section">' + activeBanner + '</div>',
    content: '<div class="settings-section"><div class="settings-section-title">' + (isZh ? '语音预设列表' : 'Speech Presets') + '</div><div class="settings-presets-grid settings-presets-compact">' + presetCards + '</div></div>'
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
    '<label>' + (isZh ? '接口格式' : 'API Format') + '</label>',
    '<select class="settings-input" data-claw-select id="speech-preset-apitype">',
    '<option value="chat"' + ((preset.apiType || 'chat') === 'chat' ? ' selected' : '') + '>' + (isZh ? 'Chat Completions（音频输入扩展）' : 'Chat Completions (audio input)') + '</option>',
    '<option value="audio"' + (preset.apiType === 'audio' ? ' selected' : '') + '>' + (isZh ? 'Audio Transcriptions（语音转写）' : 'Audio Transcriptions') + '</option>',
    '<option value="audio-stream"' + (preset.apiType === 'audio-stream' ? ' selected' : '') + '>' + (isZh ? 'Audio Transcriptions（流式，边说边出字）' : 'Audio Transcriptions (streaming)') + '</option>',
    '</select>',
    '</div>',
    '<div class="settings-field">',
    '<label>API Key</label>',
    '<div style="position:relative;display:flex;align-items:stretch;">',
    '<input class="settings-input" id="speech-preset-apikey" type="password" value="' + escapeHtml(preset.apiKey || '') + '" placeholder="sk-..." style="padding-right:40px;">',
    '<button type="button" class="settings-key-toggle" data-action="speech.toggleApiKeyVisibility" title="' + (isZh ? '显示/隐藏' : 'Show/Hide') + '">',
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

export function addSpeechPreset() {
  speechEditing = 'new';
  speechSettingsHost().renderSettingsOverlay();
}

function editSpeechPreset(idx) {
  speechEditing = idx;
  speechSettingsHost().renderSettingsOverlay();
}

export function cancelSpeechPresetEdit() {
  speechEditing = null;
  speechSettingsHost().renderSettingsOverlay();
}

async function deleteSpeechPreset(idx) {
  const presets = getClawSpeechPresets();
  presets.splice(idx, 1);
  setClawSpeechPresets(presets);
  speechEditing = null;
  await saveSpeechFullConfig();
}

async function applySpeechPreset(idx) {
  const presets = getClawSpeechPresets();
  const preset = presets[idx];
  if (!preset) return;
  // Set as active speech model
  setClawSpeechModelConfig({
    baseUrl: preset.baseUrl || '',
    apiKey: preset.apiKey || '',
    model: preset.model || '',
    language: preset.language || 'auto',
    apiType: normalizeSpeechApiTypeValue(preset.apiType),
  });
  await saveSpeechFullConfig();
}

export async function saveSpeechPreset(editIdx) {
  const el = (id) => document.getElementById(id);
  const preset = {
    name: (el('speech-preset-name')?.value || '').trim(),
    baseUrl: (el('speech-preset-baseurl')?.value || '').trim(),
    apiKey: (el('speech-preset-apikey')?.value || '').trim(),
    model: (el('speech-preset-model')?.value || '').trim(),
    language: el('speech-preset-language')?.value || 'auto',
    apiType: normalizeSpeechApiTypeValue(el('speech-preset-apitype')?.value),
  };
  const presets = getClawSpeechPresets();
  // Check if there's currently an active speech model
  let sc = getClawSpeechModelConfig() || {};
  let wasActive = !!(sc.baseUrl && sc.apiKey);
  if (editIdx === 'new') {
    presets.push(preset);
    editIdx = presets.length - 1;
  } else {
    presets[editIdx] = preset;
  }
  setClawSpeechPresets(presets);
  speechEditing = null;
  await saveSpeechFullConfig();
  if (!wasActive) {
    await applySpeechPreset(editIdx);
  }
}

async function saveSpeechFullConfig() {
  const speechModel = getClawSpeechModelConfig() || { baseUrl: '', apiKey: '', model: '', language: 'auto', apiType: 'chat' };
  const speechPresets = getClawSpeechPresets();
  try {
    const resp = await fetch('/protoclaw/speech_model_config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speechModel, speechPresets }),
    });
    const result = await resp.json();
    setClawSpeechModelConfig(result.speechModel);
    setClawSpeechPresets(Array.isArray(result.speechPresets) ? result.speechPresets : []);
    speechSettingsHost().renderSettingsOverlay();
  } catch (error) {
    console.error('Failed to save speech model config:', error);
  }
}

// ── 导出面（model-settings 消费）─────────────────────────────────
export { renderSpeechModelSection, speechApiTypeLabel };

// ── 事件接线（data-action="speech.*"）─────────────────────────────

window.ClawFW.actions.registerMany({
  'speech.applyPreset': (el, event, idx) => applySpeechPreset(idx),
  'speech.editPreset': (el, event, idx) => editSpeechPreset(idx),
  'speech.deletePreset': (el, event, idx) => deleteSpeechPreset(idx),
  'speech.toggleApiKeyVisibility': () => toggleSpeechApiKeyVisibility(),
});
