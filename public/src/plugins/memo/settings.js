/**
 * settings.js — memo 设置弹窗（原 modules/memo-settings.js）
 *
 * 形态：单列设置区（不分左右栏），首个区块为模型设置。与智能编码空间
 * （ph-settings.js）的差异是刻意的——memo 只配一个模型（无备选模型、
 * 无身份分层），设置区按区块纵向追加，不引入左侧分页导航。
 * 「通知」区块承接 ADR-0030 notifications.reminder（到点提醒系统通知）。
 *
 * 数据面复用通用接口，服务端零改动：
 *   GET/PUT /protoclaw/agent_model_presets?agentId=memo
 * 落盘 用户数据目录 agent-configs/memo.json；runtime 启动时经
 * resolveAgentModelLLM 把该文件合并进 metadata 的 modelPresets，
 * 因此配置对新建会话生效（与 PH 面板同语义）。
 *
 * 入口注册：mount 时写 window.ClawFW.appSettingsPanels.memo（unmount 摘除）
 * ——首页 hero 的「设置」按钮声明通用 action type 'open_app_settings' +
 * settings: 'memo'，公共分发器查注册表调用，不按 APP ID 分支（可拔插约束）。
 *
 * 宿主能力经 mount(presenter) 注入（presenter 由插件 index.js 收敛）：
 *   escapeHtml / getLanguage / workspace.agentById / modelPresets.get,set /
 *   getThinkingEffortOptions / enhanceSelect,enhanceSelectAll
 * 控件事件走 data-action 分发（memoSettings.*），无内联 onclick/onchange。
 */

let pluginHost = null;

const MemoSettingsUI = (() => {
  const AGENT_ID = 'memo';

  let open = false;
  // agent-configs/memo.json 的 modelPresets.default（{ primary, thinkingEffort } 或 null）
  let defaultPreset = null;
  let loaded = false;
  // 提醒通知权限态（ADR-0030 notifications.reminder）：null = 未加载；
  // { userValue: boolean|undefined, authorDefault: boolean } = 已解析判定链输入
  let reminderState = null;

  function isZh() {
    return pluginHost.getLanguage() === 'zh';
  }

  function esc(value) {
    if (typeof pluginHost.escapeHtml === 'function') return pluginHost.escapeHtml(value);
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function ensureHost() {
    let host = document.getElementById('memo-settings-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'memo-settings-host';
      document.body.appendChild(host);
    }
    return host;
  }

  /** 模型预设列表：缓存未就绪时拉一次全局配置（与 PH 面板同源）。 */
  async function ensurePresets() {
    const cached = pluginHost.modelPresets.get();
    if (cached.length > 0) return cached;
    try {
      const resp = await fetch('/protoclaw/model_config');
      const data = await resp.json();
      const list = Array.isArray(data?.presets) ? data.presets : [];
      return pluginHost.modelPresets.set(list);
    } catch (error) {
      console.error('[memo-settings] failed to load model presets:', error);
      return pluginHost.modelPresets.get();
    }
  }

  async function loadDefaultPreset() {
    try {
      const resp = await fetch('/protoclaw/agent_model_presets?agentId=' + encodeURIComponent(AGENT_ID));
      if (!resp.ok) {
        defaultPreset = null;
        return;
      }
      const data = await resp.json();
      const preset = data?.modelPresets?.default;
      defaultPreset = preset && typeof preset === 'object' ? preset : null;
    } catch (error) {
      console.error('[memo-settings] failed to load agent presets:', error);
      defaultPreset = null;
    }
  }

  // ── 模型设置区块 ────────────────────────────────────────────────

  function renderModelSection(presets) {
    const zh = isZh();
    const primary = String(defaultPreset?.primary || '');
    const effort = String(defaultPreset?.thinkingEffort?.primary || '');

    const buildOptions = (selected) => presets.map((p) => {
      const name = String(p?.name || '');
      return '<option value="' + esc(name) + '"' + (name === selected ? ' selected' : '') + '>'
        + esc(name) + '</option>';
    }).join('');

    const modelSelect = '<select class="ph-mc-select" data-claw-select data-memo-slot="model"'
      + ' data-action="memoSettings.modelChanged">'
      + '<option value=""' + (!primary ? ' selected' : '') + '>'
      + esc(zh ? '(默认)' : '(Default)') + '</option>'
      + buildOptions(primary)
      + '</select>';

    const currentPreset = presets.find((p) => String(p?.name || '') === primary) || null;
    const protocol = currentPreset && (currentPreset.provider || currentPreset.protocol);
    const effortOptions = pluginHost.getThinkingEffortOptions(protocol) || [];
    const effortSelect = '<select class="ph-mc-effort" data-claw-select data-memo-slot="effort"'
      + ' data-action="memoSettings.autoSave"' + (effortOptions.length === 0 ? ' disabled' : '') + '>'
      + '<option value="">' + esc(zh ? '默认' : 'Default') + '</option>'
      + effortOptions.map((value) => '<option value="' + esc(value) + '"'
        + (value === effort ? ' selected' : '') + '>' + esc(value) + '</option>').join('')
      + '</select>';

    const infoHtml = currentPreset
      ? '<span class="ph-mc-info">' + esc(currentPreset.model || '')
        + (currentPreset.contextLength ? ' · ' + Math.round(currentPreset.contextLength / 1000) + 'K ctx' : '')
        + '</span>'
      : '<span class="ph-mc-info">' + esc(zh ? '跟随全局默认' : 'Follows global default') + '</span>';

    return [
      '<div class="ph-mc-list">',
      '<div class="ph-mc-row">',
      '<div class="ph-mc-role">',
      '<div class="ph-mc-role-name">' + esc(zh ? 'Memo' : 'Memo') + '</div>',
      '<div class="ph-mc-role-desc">' + esc(zh ? '对话与备忘记录' : 'Chat and notes') + '</div>',
      '</div>',
      '<div class="ph-mc-single">',
      '<div class="ph-mc-pickers">' + modelSelect + effortSelect + '</div>',
      infoHtml,
      '</div>',
      '</div>',
      '</div>',
    ].join('');
  }

  /** 提醒通知开关区（ADR-0030：memo 设置页承接 notifications.reminder）。 */
  function renderNotificationSection() {
    const zh = isZh();
    if (!reminderState) return '';
    const { userValue, authorDefault } = reminderState;
    const effective = typeof userValue === 'boolean' ? userValue : authorDefault;
    const toggleRow = [
      '<div class="ph-mc-list">',
      '<div class="ph-mc-row">',
      '<div class="ph-mc-role">',
      '<div class="ph-mc-role-name">' + esc(zh ? '到点提醒' : 'Reminders') + '</div>',
      '</div>',
      '<div style="display:flex;justify-content:flex-end;align-items:center;padding-top:7px;">',
      '<label class="proxy-switch">',
      '<input type="checkbox" ' + (effective ? 'checked' : '') + ' data-action="memoSettings.toggleReminder" />',
      '<span class="proxy-switch-slider"></span>',
      '</label>',
      '</div>',
      '</div>',
      '</div>',
    ].join('');
    return [
      '<section class="memo-settings-section">',
      '<div class="memo-settings-section-head">',
      '<div class="memo-settings-section-title">' + esc(zh ? '通知' : 'Notifications') + '</div>',
      '</div>',
      toggleRow,
      '</section>',
    ].join('');
  }

  function renderBody(presets) {
    const zh = isZh();
    return [
      '<section class="memo-settings-section">',
      '<div class="memo-settings-section-head">',
      '<div class="memo-settings-section-title">' + esc(zh ? '模型' : 'Model') + '</div>',
      '<div class="memo-settings-section-desc">' + esc(zh
        ? 'Memo 使用的模型；留空则跟随全局默认。修改对新会话生效。'
        : 'The model Memo uses. Leave empty to follow the global default. Changes apply to new conversations.') + '</div>',
      '</div>',
      renderModelSection(presets),
      '</section>',
      renderNotificationSection(),
    ].join('');
  }

  function renderOverlay(presets) {
    const host = ensureHost();
    if (!open) {
      host.innerHTML = '';
      return;
    }
    const zh = isZh();
    const body = loaded
      ? renderBody(presets)
      : '<div class="ph-settings-empty">' + esc(zh ? '加载中…' : 'Loading…') + '</div>';

    host.innerHTML = [
      '<div class="feature-detail-overlay">',
      '<div class="feature-detail-window memo-settings-window">',
      '<div class="feature-detail-head">',
      '<div>',
      '<div class="feature-detail-title">' + esc(zh ? '设置' : 'Settings') + '</div>',
      '<div class="feature-detail-subtitle">' + esc(zh ? 'Memo 的模型与偏好' : 'Model and preferences for Memo') + '</div>',
      '</div>',
      '<button class="feature-detail-close" type="button" title="' + esc(zh ? '关闭' : 'Close') + '"'
      + ' data-action="memoSettings.close">&times;</button>',
      '</div>',
      '<div class="memo-settings-body">' + body + '</div>',
      '<div id="memo-settings-status"></div>',
      '</div>',
      '</div>',
    ].join('');

    // select 是 innerHTML 异步渲染后插入的，手动做 ClawSelect 增强
    pluginHost.enhanceSelectAll(host);
  }

  /** 拉取提醒通知权限判定链输入：用户覆盖（resourcePolicy）+ 作者默认（metadata permissionDefaults）。 */
  async function loadReminderState() {
    reminderState = null;
    try {
      const resp = await fetch('/protoclaw/workspace_settings');
      const data = resp.ok ? await resp.json().catch(() => null) : null;
      const memo = pluginHost.workspace.agentById(AGENT_ID);
      const defaults = memo && memo.source === 'prebuilt' && memo.permissionDefaults
        && typeof memo.permissionDefaults === 'object' ? memo.permissionDefaults : {};
      const authorDefault = typeof defaults['notifications.reminder'] === 'boolean'
        ? defaults['notifications.reminder'] : false;
      const userValue = data?.resourcePolicy?.[AGENT_ID]?.['notifications.reminder'];
      reminderState = {
        userValue: typeof userValue === 'boolean' ? userValue : undefined,
        authorDefault,
      };
    } catch {
      // 读取失败按作者默认渲染（开关仍可用，保存走同端点）
      reminderState = { userValue: undefined, authorDefault: true };
    }
  }

  async function openPanel() {
    open = true;
    loaded = false;
    defaultPreset = null;
    reminderState = null;
    renderOverlay([]);
    const [presets] = await Promise.all([ensurePresets(), loadReminderState()]);
    await loadDefaultPreset();
    if (!open) return;
    loaded = true;
    renderOverlay(presets);
  }

  function closePanel() {
    open = false;
    defaultPreset = null;
    loaded = false;
    reminderState = null;
    const host = document.getElementById('memo-settings-host');
    if (host) host.innerHTML = '';
  }

  // ── 保存与控件动作（经 index.js 的 actions 表以 data-action 分发） ──

  function setStatus(text, isError) {
    const el = document.getElementById('memo-settings-status');
    if (!el) return;
    el.innerHTML = text
      ? '<div class="memo-settings-status' + (isError ? ' error' : '') + '">' + esc(text) + '</div>'
      : '';
  }

  async function toggleReminder(el) {
    const checked = el?.checked === true;
    const zh = isZh();
    try {
      const resp = await fetch('/protoclaw/workspace_settings/resource_policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: AGENT_ID,
          permissionId: 'notifications.reminder',
          value: checked,
        }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data?.error || ('HTTP ' + resp.status));
      }
      if (reminderState) reminderState.userValue = checked;
      setStatus(zh ? '已保存' : 'Saved', false);
    } catch (error) {
      console.error('[memo-settings] reminder toggle failed:', error);
      setStatus((zh ? '保存失败：' : 'Save failed: ') + (error?.message || error), true);
    }
    // 重取真值后重渲染：成功 = 新值收敛，失败 = 开关回滚服务器态
    if (open) {
      await loadReminderState();
      renderOverlay(pluginHost.modelPresets.get());
    }
  }

  /** 切换模型后同步思考强度下拉的可选项（各协议档位不同），随后自动保存。 */
  function modelChanged(el) {
    const zh = isZh();
    const presets = pluginHost.modelPresets.get();
    const preset = presets.find((p) => String(p?.name || '') === String(el?.value || '')) || null;
    const effortSelect = document.querySelector('#memo-settings-host .ph-mc-effort');
    if (effortSelect) {
      const options = (preset && pluginHost.getThinkingEffortOptions(preset.provider || preset.protocol)) || [];
      const selectedEffort = String(preset?.thinkingEffort || '');
      effortSelect.innerHTML = '<option value="">' + esc(zh ? '默认' : 'Default') + '</option>'
        + options.map((value) => '<option value="' + esc(value) + '"'
          + (value === selectedEffort ? ' selected' : '') + '>' + esc(value) + '</option>').join('');
      effortSelect.value = selectedEffort;
      effortSelect.disabled = options.length === 0;
      pluginHost.enhanceSelect(effortSelect);
    }
    autoSave();
  }

  async function autoSave() {
    const zh = isZh();
    const modelSelect = document.querySelector('#memo-settings-host .ph-mc-select[data-memo-slot="model"]');
    const effortSelect = document.querySelector('#memo-settings-host .ph-mc-effort[data-memo-slot="effort"]');
    const primary = String(modelSelect?.value || '');
    const thinkingEffort = String(effortSelect?.value || '');
    // 单槽位：两个控件都空 = 未配置，写 null 回落全局默认
    const next = (primary || thinkingEffort)
      ? { primary: primary || null, thinkingEffort: { primary: thinkingEffort || null } }
      : null;

    setStatus(zh ? '正在保存…' : 'Saving…', false);
    try {
      const resp = await fetch('/protoclaw/agent_model_presets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: AGENT_ID,
          modelPresets: { default: next },
        }),
      });
      const result = await resp.json().catch(() => null);
      if (!resp.ok || !result?.ok) {
        throw new Error(result?.error || ('HTTP ' + resp.status));
      }
      defaultPreset = next;
      setStatus(zh ? '已保存' : 'Saved', false);
    } catch (error) {
      console.error('[memo-settings] save failed:', error);
      setStatus((zh ? '保存失败：' : 'Save failed: ') + (error?.message || error), true);
    }
  }

  return {
    open: openPanel,
    close: closePanel,
    modelChanged,
    autoSave,
    toggleReminder,
  };
})();

export default {
  mount(presenter) {
    pluginHost = presenter;
    // 设置面板注册表：首页 action 'open_app_settings' 经公共分发器查表调用
    window.ClawFW = window.ClawFW || {};
    window.ClawFW.appSettingsPanels = window.ClawFW.appSettingsPanels || {};
    window.ClawFW.appSettingsPanels.memo = {
      open: () => MemoSettingsUI.open(),
      close: () => MemoSettingsUI.close(),
    };
  },

  unmount() {
    MemoSettingsUI.close();
    if (window.ClawFW?.appSettingsPanels) {
      delete window.ClawFW.appSettingsPanels.memo;
    }
    pluginHost = null;
  },
};

export { MemoSettingsUI };
