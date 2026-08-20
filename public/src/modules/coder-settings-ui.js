/* coder-settings-ui.js — coder 工作空间设置：模型配置 */

window.CoderSettingsUI = (() => {
  let presets = [];
  let currentPreset = '';
  let loading = false;
  let loaded = false;

  function refresh() {
    if (loading) return;
    loading = true;
    Promise.allSettled([fetchPresets(), fetchCurrent()])
      .finally(() => {
        loading = false;
        loaded = true;
        if (typeof renderCurrentMainView === 'function') renderCurrentMainView();
      });
  }

  async function fetchPresets() {
    const response = await fetch('/protoclaw/model_config');
    if (!response.ok) throw new Error('Failed to load model presets');
    const payload = await response.json();
    presets = Array.isArray(payload?.presets) ? payload.presets : [];
  }

  async function fetchCurrent() {
    const response = await fetch('/protoclaw/agent_model_presets?agentId=coder');
    if (!response.ok) throw new Error('Failed to load current preset');
    const payload = await response.json();
    const configured = payload?.modelPresets?.default;
    currentPreset = typeof configured === 'string'
      ? configured
      : (configured?.primary || '');
  }

  function render() {
    if (!loaded && !loading) refresh();
    const zh = currentLanguage === 'zh';
    const title = zh ? '设置' : 'Settings';
    const description = zh
      ? '配置保存到本地 agent 配置文件；对之后派发与新建的工单会话生效，正在执行的会话不受影响。'
      : 'Saved to the local agent config; applies to tickets dispatched afterwards. Running sessions are not affected.';

    const options = presets.map((preset) => {
      const label = preset.name + (preset.model ? ` (${preset.model})` : '');
      const selected = preset.name === currentPreset ? ' selected' : '';
      return `<option value="${escapeHtml(preset.name)}"${selected}>${escapeHtml(label)}</option>`;
    }).join('');

    return [
      '<section class="coder-settings">',
      '<div class="coder-ticket-heading"><div><div class="coder-ticket-kicker">24H CODER</div><h2>' + title + '</h2><p>' + description + '</p></div></div>',
      '<div class="coder-settings-card">',
      '<h3>' + (zh ? '模型' : 'Model') + '</h3>',
      '<div class="coder-settings-row">',
      '<select id="coder-settings-model">',
      presets.length === 0 ? `<option value="">${zh ? '（无可用预设）' : '(no presets)'}</option>` : options,
      '</select>',
      '<button class="coder-ticket-btn" type="button" onclick="window.CoderSettingsUI.save()">' + (zh ? '保存' : 'Save') + '</button>',
      '</div>',
      '<p class="coder-settings-hint">',
      loading && !loaded ? (zh ? '正在读取…' : 'Loading…')
        : presets.length === 0 ? (zh ? '没有模型预设。先在全局「模型预设」里创建。' : 'No presets. Create one in global model presets first.')
        : currentPreset ? (zh ? '当前：' : 'Current: ') + escapeHtml(currentPreset)
        : (zh ? '未配置 —— coder 目前回退到 agent 默认模型，建议选择一个。' : 'Not set — coder falls back to the agent default. Pick one.'),
      '</p>',
      '</div>',
      '</section>',
    ].join('');
  }

  async function save() {
    const zh = currentLanguage === 'zh';
    const presetName = (document.getElementById('coder-settings-model')?.value || '').trim();
    if (!presetName) {
      if (typeof ClawToast !== 'undefined') ClawToast.error(zh ? '请选择一个模型预设' : 'Pick a preset first');
      return;
    }
    try {
      const response = await fetch('/protoclaw/agent_model_presets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'coder', modelPresets: { default: presetName } }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Save failed');
      currentPreset = presetName;
      if (typeof ClawToast !== 'undefined') ClawToast.success(zh ? '已保存' : 'Saved');
      if (typeof renderCurrentMainView === 'function') renderCurrentMainView();
    } catch (error) {
      if (typeof ClawToast !== 'undefined') ClawToast.error(error.message || 'Save failed');
    }
  }

  return { render, refresh, save };
})();
