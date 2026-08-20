/* coder-settings-ui.js — coder 工作空间设置：模型配置（default + 压缩摘要 system） */

window.CoderSettingsUI = (() => {
  let presets = [];
  let currentPreset = '';
  let systemPreset = '';
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

  function readRolePreset(modelPresets, role) {
    const configured = modelPresets?.[role];
    return typeof configured === 'string'
      ? configured
      : (configured?.primary || '');
  }

  async function fetchCurrent() {
    const response = await fetch('/protoclaw/agent_model_presets?agentId=coder');
    if (!response.ok) throw new Error('Failed to load current preset');
    const payload = await response.json();
    currentPreset = readRolePreset(payload?.modelPresets, 'default');
    systemPreset = readRolePreset(payload?.modelPresets, 'system');
  }

  function presetOptions(selected) {
    const zh = currentLanguage === 'zh';
    return presets.map((preset) => {
      const label = preset.name + (preset.model ? ` (${preset.model})` : '');
      const isSelected = preset.name === selected ? ' selected' : '';
      return `<option value="${escapeHtml(preset.name)}"${isSelected}>${escapeHtml(label)}</option>`;
    }).join('')
      + `<option value=""${selected ? '' : ' selected'}>（${zh ? '未设置 · 回退默认模型' : 'Not set · falls back to default'}）</option>`;
  }

  function render() {
    if (!loaded && !loading) refresh();
    const zh = currentLanguage === 'zh';
    const title = zh ? '设置' : 'Settings';
    const description = zh
      ? '配置保存到本地 agent 配置文件；对之后新建的线程会话生效，正在执行的会话不受影响。'
      : 'Saved to the local agent config; applies to newly created thread sessions. Running sessions are not affected.';

    return [
      '<section class="coder-settings">',
      '<div class="coder-panel-heading"><div><div class="coder-panel-kicker">24H CODER</div><h2>' + title + '</h2><p>' + description + '</p></div></div>',
      '<div class="coder-settings-card">',
      '<h3>' + (zh ? '模型' : 'Model') + '</h3>',
      '<div class="coder-settings-row">',
      '<select id="coder-settings-model">',
      presets.length === 0 ? `<option value="">${zh ? '（无可用预设）' : '(no presets)'}</option>` : presetOptions(currentPreset),
      '</select>',
      '<button class="coder-btn" type="button" onclick="window.CoderSettingsUI.save()">' + (zh ? '保存' : 'Save') + '</button>',
      '</div>',
      '<p class="coder-settings-hint">',
      loading && !loaded ? (zh ? '正在读取…' : 'Loading…')
        : presets.length === 0 ? (zh ? '没有模型预设。先在全局「模型预设」里创建。' : 'No presets. Create one in global model presets first.')
        : currentPreset ? (zh ? '当前：' : 'Current: ') + escapeHtml(currentPreset)
        : (zh ? '未配置 —— coder 目前回退到 agent 默认模型，建议选择一个。' : 'Not set — coder falls back to the agent default. Pick one.'),
      '</p>',
      '</div>',
      '<div class="coder-settings-card">',
      '<h3>' + (zh ? '压缩摘要模型' : 'Compaction Model') + '</h3>',
      '<div class="coder-settings-row">',
      '<select id="coder-settings-compact-model">',
      presets.length === 0 ? `<option value="">${zh ? '（无可用预设）' : '(no presets)'}</option>` : presetOptions(systemPreset),
      '</select>',
      '</div>',
      '<p class="coder-settings-hint">',
      zh
        ? '上下文到达压缩阈值后，自动精简接力（trim + 摘要）用这个模型生成摘要。'
          + (systemPreset ? '当前：' + escapeHtml(systemPreset) : '未设置 —— 摘要回退使用上面的默认模型；默认模型很小时建议单独配置一个更强的。')
        : 'Used to generate the summary during automatic trim+summary context rotation. '
          + (systemPreset ? 'Current: ' + escapeHtml(systemPreset) : 'Not set — falls back to the default model above. A stronger model is recommended when the default is small.'),
      '</p>',
      '</div>',
      '</section>',
    ].join('');
  }

  async function save() {
    const zh = currentLanguage === 'zh';
    const presetName = (document.getElementById('coder-settings-model')?.value || '').trim();
    const compactPresetName = (document.getElementById('coder-settings-compact-model')?.value || '').trim();
    if (!presetName) {
      if (typeof ClawToast !== 'undefined') ClawToast.error(zh ? '请选择一个模型预设' : 'Pick a preset first');
      return;
    }
    try {
      const response = await fetch('/protoclaw/agent_model_presets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: 'coder',
          modelPresets: {
            default: presetName,
            // 空值不落 system 键：resolver 回退 default，语义与“未设置”一致
            ...(compactPresetName ? { system: compactPresetName } : {}),
          },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Save failed');
      currentPreset = presetName;
      systemPreset = compactPresetName;
      if (typeof ClawToast !== 'undefined') ClawToast.success(zh ? '已保存' : 'Saved');
      if (typeof renderCurrentMainView === 'function') renderCurrentMainView();
    } catch (error) {
      if (typeof ClawToast !== 'undefined') ClawToast.error(error.message || 'Save failed');
    }
  }

  return { render, refresh, save };
})();
