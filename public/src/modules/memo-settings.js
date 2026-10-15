/**
 * memo-settings.js — Memo 工作空间设置弹窗
 *
 * 形态：单列设置区（不分左右栏），首个区块为模型设置。与智能编码空间
 * （ph-model-config.js）的差异是刻意的——memo 只配一个模型（无备选模型、
 * 无身份分层），设置区按区块纵向追加，不引入左侧分页导航。
 *
 * 数据面复用通用接口，服务端零改动：
 *   GET/PUT /protoclaw/agent_model_presets?agentId=memo
 * 落盘 用户数据目录 agent-configs/memo.json；runtime 启动时经
 * resolveAgentModelLLM 把该文件合并进 metadata 的 modelPresets，
 * 因此配置对新建会话生效（与 PH 面板同语义）。
 *
 * 入口注册：window.ClawFW.appSettingsPanels.memo —— 首页 hero 的
 * 「设置」按钮声明通用 action type 'open_app_settings' + settings: 'memo'，
 * 公共分发器查注册表调用，不按 APP ID 分支（可拔插约束）。
 *
 * 依赖全局（运行时调用，加载顺序无关）：
 *   - escapeHtml, currentLanguage, getCurrentAgentRecord (app-core.js / app-main.js)
 *   - getClawModelPresets, setClawModelPresets (model-preset-cache.js)
 *   - window.ClawFW.getThinkingEffortOptions (input-model-switcher.js)
 *   - window.ClawSelect (claw-select.js)
 */

window.ClawFW = window.ClawFW || {};

const MEMO_SETTINGS_AGENT_ID = 'memo';

let _memoSettingsOpen = false;
// agent-configs/memo.json 的 modelPresets.default（{ primary, thinkingEffort } 或 null）
let _memoDefaultPreset = null;
let _memoSettingsLoaded = false;

function _memoIsZh() {
  return typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';
}

function _memoEsc(value) {
  if (typeof escapeHtml === 'function') return escapeHtml(value);
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function ensureMemoSettingsHost() {
  let host = document.getElementById('memo-settings-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'memo-settings-host';
    document.body.appendChild(host);
  }
  return host;
}

/** 模型预设列表：缓存未就绪时拉一次全局配置（与 PH 面板同源）。 */
async function _memoEnsurePresets() {
  if (typeof getClawModelPresets === 'function' && getClawModelPresets().length > 0) {
    return getClawModelPresets();
  }
  try {
    const resp = await fetch('/protoclaw/model_config');
    const data = await resp.json();
    const list = Array.isArray(data?.presets) ? data.presets : [];
    if (typeof setClawModelPresets === 'function') return setClawModelPresets(list);
    return list;
  } catch (error) {
    console.error('[memo-settings] failed to load model presets:', error);
    return typeof getClawModelPresets === 'function' ? getClawModelPresets() : [];
  }
}

async function _memoLoadDefaultPreset() {
  try {
    const resp = await fetch('/protoclaw/agent_model_presets?agentId=' + encodeURIComponent(MEMO_SETTINGS_AGENT_ID));
    if (!resp.ok) {
      _memoDefaultPreset = null;
      return;
    }
    const data = await resp.json();
    const preset = data?.modelPresets?.default;
    _memoDefaultPreset = preset && typeof preset === 'object' ? preset : null;
  } catch (error) {
    console.error('[memo-settings] failed to load agent presets:', error);
    _memoDefaultPreset = null;
  }
}

// ── 模型设置区块 ────────────────────────────────────────────────

function _memoRenderModelSection(presets) {
  const isZh = _memoIsZh();
  const primary = String(_memoDefaultPreset?.primary || '');
  const effort = String(_memoDefaultPreset?.thinkingEffort?.primary || '');

  const buildOptions = (selected) => presets.map((p) => {
    const name = String(p?.name || '');
    return '<option value="' + _memoEsc(name) + '"' + (name === selected ? ' selected' : '') + '>'
      + _memoEsc(name) + '</option>';
  }).join('');

  const modelSelect = '<select class="ph-mc-select" data-claw-select data-memo-slot="model"'
    + ' onchange="window.memoModelSlotChanged(this)">'
    + '<option value=""' + (!primary ? ' selected' : '') + '>'
    + _memoEsc(isZh ? '(默认)' : '(Default)') + '</option>'
    + buildOptions(primary)
    + '</select>';

  const currentPreset = presets.find((p) => String(p?.name || '') === primary) || null;
  const protocol = currentPreset && (currentPreset.provider || currentPreset.protocol);
  const effortOptions = (window.ClawFW?.getThinkingEffortOptions?.(protocol)) || [];
  const effortSelect = '<select class="ph-mc-effort" data-claw-select data-memo-slot="effort"'
    + ' onchange="window.memoAutoSaveModel()"' + (effortOptions.length === 0 ? ' disabled' : '') + '>'
    + '<option value="">' + _memoEsc(isZh ? '默认' : 'Default') + '</option>'
    + effortOptions.map((value) => '<option value="' + _memoEsc(value) + '"'
      + (value === effort ? ' selected' : '') + '>' + _memoEsc(value) + '</option>').join('')
    + '</select>';

  const infoHtml = currentPreset
    ? '<span class="ph-mc-info">' + _memoEsc(currentPreset.model || '')
      + (currentPreset.contextLength ? ' · ' + Math.round(currentPreset.contextLength / 1000) + 'K ctx' : '')
      + '</span>'
    : '<span class="ph-mc-info">' + _memoEsc(isZh ? '跟随全局默认' : 'Follows global default') + '</span>';

  return [
    '<div class="ph-mc-list">',
    '<div class="ph-mc-row">',
    '<div class="ph-mc-role">',
    '<div class="ph-mc-role-name">' + _memoEsc(isZh ? 'Memo' : 'Memo') + '</div>',
    '<div class="ph-mc-role-desc">' + _memoEsc(isZh ? '对话与备忘记录' : 'Chat and notes') + '</div>',
    '</div>',
    '<div class="ph-mc-single">',
    '<div class="ph-mc-pickers">' + modelSelect + effortSelect + '</div>',
    infoHtml,
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}

function _memoRenderBody(presets) {
  const isZh = _memoIsZh();
  return [
    '<section class="memo-settings-section">',
    '<div class="memo-settings-section-head">',
    '<div class="memo-settings-section-title">' + _memoEsc(isZh ? '模型' : 'Model') + '</div>',
    '<div class="memo-settings-section-desc">' + _memoEsc(isZh
      ? 'Memo 使用的模型；留空则跟随全局默认。修改对新会话生效。'
      : 'The model Memo uses. Leave empty to follow the global default. Changes apply to new conversations.') + '</div>',
    '</div>',
    _memoRenderModelSection(presets),
    '</section>',
  ].join('');
}

function _memoRenderOverlay(presets) {
  const host = ensureMemoSettingsHost();
  if (!_memoSettingsOpen) {
    host.innerHTML = '';
    return;
  }
  const isZh = _memoIsZh();
  const body = _memoSettingsLoaded
    ? _memoRenderBody(presets)
    : '<div class="ph-settings-empty">' + _memoEsc(isZh ? '加载中…' : 'Loading…') + '</div>';

  host.innerHTML = [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window memo-settings-window">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + _memoEsc(isZh ? '设置' : 'Settings') + '</div>',
    '<div class="feature-detail-subtitle">' + _memoEsc(isZh ? 'Memo 的模型与偏好' : 'Model and preferences for Memo') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + _memoEsc(isZh ? '关闭' : 'Close') + '"'
    + ' onclick="window.closeMemoSettings()">&times;</button>',
    '</div>',
    '<div class="memo-settings-body">' + body + '</div>',
    '<div id="memo-settings-status"></div>',
    '</div>',
    '</div>',
  ].join('');

  // select 是 innerHTML 异步渲染后插入的，手动做 ClawSelect 增强
  if (window.ClawSelect) {
    requestAnimationFrame(() => window.ClawSelect.enhanceAll(host));
  }
}

async function openMemoSettings() {
  _memoSettingsOpen = true;
  _memoSettingsLoaded = false;
  _memoDefaultPreset = null;
  _memoRenderOverlay([]);
  const presets = await _memoEnsurePresets();
  await _memoLoadDefaultPreset();
  if (!_memoSettingsOpen) return;
  _memoSettingsLoaded = true;
  _memoRenderOverlay(presets);
}

function closeMemoSettings() {
  _memoSettingsOpen = false;
  _memoDefaultPreset = null;
  _memoSettingsLoaded = false;
  const host = document.getElementById('memo-settings-host');
  if (host) host.innerHTML = '';
}

// ── 保存 ────────────────────────────────────────────────────────

function _memoSetStatus(text, isError) {
  const el = document.getElementById('memo-settings-status');
  if (!el) return;
  el.innerHTML = text
    ? '<div class="memo-settings-status' + (isError ? ' error' : '') + '">' + _memoEsc(text) + '</div>'
    : '';
}

/** 切换模型后同步思考强度下拉的可选项（各协议档位不同）。 */
window.memoModelSlotChanged = function(select) {
  const isZh = _memoIsZh();
  const presets = typeof getClawModelPresets === 'function' ? getClawModelPresets() : [];
  const preset = presets.find((p) => String(p?.name || '') === String(select?.value || '')) || null;
  const effortSelect = document.querySelector('#memo-settings-host .ph-mc-effort');
  if (effortSelect) {
    const options = (preset && window.ClawFW?.getThinkingEffortOptions?.(preset.provider || preset.protocol)) || [];
    const selectedEffort = String(preset?.thinkingEffort || '');
    effortSelect.innerHTML = '<option value="">' + _memoEsc(isZh ? '默认' : 'Default') + '</option>'
      + options.map((value) => '<option value="' + _memoEsc(value) + '"'
        + (value === selectedEffort ? ' selected' : '') + '>' + _memoEsc(value) + '</option>').join('');
    effortSelect.value = selectedEffort;
    effortSelect.disabled = options.length === 0;
    if (window.ClawSelect) window.ClawSelect.enhance(effortSelect);
  }
  window.memoAutoSaveModel();
};

window.memoAutoSaveModel = async function() {
  const isZh = _memoIsZh();
  const modelSelect = document.querySelector('#memo-settings-host .ph-mc-select[data-memo-slot="model"]');
  const effortSelect = document.querySelector('#memo-settings-host .ph-mc-effort[data-memo-slot="effort"]');
  const primary = String(modelSelect?.value || '');
  const thinkingEffort = String(effortSelect?.value || '');
  // 单槽位：两个控件都空 = 未配置，写 null 回落全局默认
  const defaultPreset = (primary || thinkingEffort)
    ? { primary: primary || null, thinkingEffort: { primary: thinkingEffort || null } }
    : null;

  _memoSetStatus(isZh ? '正在保存…' : 'Saving…', false);
  try {
    const resp = await fetch('/protoclaw/agent_model_presets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: MEMO_SETTINGS_AGENT_ID,
        modelPresets: { default: defaultPreset },
      }),
    });
    const result = await resp.json().catch(() => null);
    if (!resp.ok || !result?.ok) {
      throw new Error(result?.error || ('HTTP ' + resp.status));
    }
    _memoDefaultPreset = defaultPreset;
    _memoSetStatus(isZh ? '已保存' : 'Saved', false);
  } catch (error) {
    console.error('[memo-settings] save failed:', error);
    _memoSetStatus((isZh ? '保存失败：' : 'Save failed: ') + (error?.message || error), true);
  }
};

// ── window 导出与注册表 ─────────────────────────────────────────

window.openMemoSettings = openMemoSettings;
window.closeMemoSettings = closeMemoSettings;

// 设置面板注册表：首页 action 'open_app_settings' 经公共分发器查表调用
window.ClawFW.appSettingsPanels = window.ClawFW.appSettingsPanels || {};
window.ClawFW.appSettingsPanels[MEMO_SETTINGS_AGENT_ID] = {
  open: openMemoSettings,
  close: closeMemoSettings,
};
