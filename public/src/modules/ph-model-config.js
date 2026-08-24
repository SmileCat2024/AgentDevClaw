/**
 * ph-model-config.js — 编程小助手项目设置面板
 *
 * IDE 式布局：左侧分类列表 + 右侧配置区域
 * 分类页：模型配置、进程模式、Feature 设置（二级页：agent 层配置编辑器）
 *
 * 外部依赖（通过全局作用域）：
 *   - escapeHtml (app-ui.js)
 *   - currentLanguage (app-core.js)
 *   - createFeatureConfigEditor (feature-config-editor.js)
 *
 * 入口：window.phOpenModelConfig() → renderPhModelConfigOverlay()
 * 关闭：window.phCloseModelConfig()
 * 模型自动保存：window.phAutoSaveModelConfig()
 * 进程模式切换：window.phSetProcessMode()
 */
'use strict';

let _phSettingsTab = 'model'; // 'model' | 'process' | 'feature'
let _phFeatureEditor = null;

function _closePhFeatureEditor() {
  if (_phFeatureEditor) {
    _phFeatureEditor.close();
    _phFeatureEditor = null;
  }
}

function ensurePhModelConfigHost() {
  let host = document.getElementById('ph-model-config-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ph-model-config-host';
    document.body.appendChild(host);
  }
  return host;
}

// ── Model config content ──────────────────────────────────────

function _renderModelConfigContent(agent, presets) {
  const isZh = currentLanguage === 'zh';
  const current = agent.modelPresets || {};
  const roles = [
    { key: 'default', label: isZh ? '主代理' : 'Main Agent', desc: isZh ? '对话和编码任务' : 'Chat & coding tasks' },
    { key: 'system', label: isZh ? '系统管理' : 'System', desc: isZh ? '系统自管理能力' : 'System self-management' },
  ];

  const buildOptions = (selectedVal) => {
    return presets.map(function(p) {
      const sel = (p.name === selectedVal) ? ' selected' : '';
      return '<option value="' + escapeHtml(p.name) + '"' + sel + '>' + escapeHtml(p.name) + '</option>';
    }).join('');
  };

  const buildInfoHtml = (val) => {
    const currentPreset = presets.find(function(p) { return p.name === val; });
    return currentPreset
      ? '<span class="ph-mc-info">' + escapeHtml(currentPreset.model || '') + (currentPreset.contextLength ? ' · ' + Math.round(currentPreset.contextLength / 1000) + 'K ctx' : '') + '</span>'
      : '<span class="ph-mc-info">' + (isZh ? '跟随全局默认' : 'Follows global default') + '</span>';
  };

  const rows = roles.map(function(role) {
    const roleConfig = current[role.key] || {};
    const primaryVal = typeof roleConfig === 'string' ? roleConfig : (roleConfig.primary || '');
    const secondaryVal = typeof roleConfig === 'string' ? '' : (roleConfig.secondary || '');
    const isDefaultRole = role.key === 'default';

    const primarySelect = '<select class="ph-mc-select" data-claw-select data-preset-role="' + role.key + '" data-slot="primary" onchange="window.phAutoSaveModelConfig()">'
      + '<option value=""' + (!primaryVal ? ' selected' : '') + '>' + (isZh ? '(默认)' : '(Default)') + '</option>'
      + buildOptions(primaryVal)
      + '</select>';

    const labelCol = '<div class="ph-mc-role"><div class="ph-mc-role-name">' + escapeHtml(role.label) + '</div><div class="ph-mc-role-desc">' + escapeHtml(role.desc) + '</div></div>';

    if (isDefaultRole) {
      const secondarySelect = '<select class="ph-mc-select" data-claw-select data-preset-role="' + role.key + '" data-slot="secondary" onchange="window.phAutoSaveModelConfig()">'
        + '<option value=""' + (!secondaryVal ? ' selected' : '') + '>' + (isZh ? '(不设置)' : '(Not set)') + '</option>'
        + buildOptions(secondaryVal)
        + '</select>';

      return '<div class="ph-mc-row ph-mc-row-primary">'
        + labelCol
        + '<div class="ph-mc-control"><div class="ph-mc-slot"><div class="ph-mc-slot-label">' + (isZh ? '主模型' : 'Primary') + '</div>' + primarySelect + buildInfoHtml(primaryVal) + '</div>'
        + '<div class="ph-mc-slot"><div class="ph-mc-slot-label">' + (isZh ? '备选' : 'Secondary') + '</div>' + secondarySelect + buildInfoHtml(secondaryVal) + '</div></div>'
        + '</div>';
    } else {
      return '<div class="ph-mc-row">'
        + labelCol
        + '<div class="ph-mc-single">'
        + primarySelect
        + buildInfoHtml(primaryVal)
        + '</div>'
        + '</div>';
    }
  }).join('');

  return '<div class="ph-mc-list">' + rows + '</div>';
}

// ── Process mode content ──────────────────────────────────────

function _renderProcessModeContent(agent) {
  const isZh = currentLanguage === 'zh';
  const supportsProcessModes = agent?.id === 'programming-helper';
  const phProcessMode = agent?.processMode || 'isolated';

  if (!supportsProcessModes) {
    return '<div class="ph-settings-empty">' + escapeHtml(isZh
      ? '此工作空间不支持共享进程模式。'
      : 'This workspace does not support shared process mode.') + '</div>';
  }

  const isProjectShared = phProcessMode === 'shared-by-project';
  const isGlobalShared = phProcessMode === 'shared-global';

  const optionCard = (mode, active, title, desc) => {
    return [
      '<div class="ph-pm-card' + (active ? ' active' : '') + '" onclick="window.phSetProcessMode(\'' + mode + '\')">',
      '<div class="ph-pm-radio' + (active ? ' checked' : '') + '"></div>',
      '<div class="ph-pm-card-body">',
      '<div class="ph-pm-card-title">' + escapeHtml(title) + '</div>',
      '<div class="ph-pm-card-desc">' + escapeHtml(desc) + '</div>',
      '</div>',
      '</div>',
    ].join('');
  };

  return [
    '<div class="ph-pm-body">',
    optionCard('shared-by-project', isProjectShared,
      isZh ? '按项目共享进程' : 'Shared by Project',
      isZh ? '同一项目下的会话共享进程，内存占用更低、启动更快。'
      : 'Sessions in the same project share a process. Lower memory, faster startup.'),
    optionCard('shared-global', isGlobalShared,
      isZh ? '全局共享进程' : 'Shared Globally',
      isZh ? '所有项目的主会话共享一个进程，内存占用最低。进程异常会中断所有项目中的运行会话。'
      : 'Main sessions in all projects share one process. Lowest memory use, but a process failure interrupts every running project session.'),
    optionCard('isolated', phProcessMode === 'isolated',
      isZh ? '独立进程' : 'Isolated Process',
      isZh ? '每个会话独占进程，完全隔离、最稳定。'
      : 'Each session gets its own process. Full isolation, most stable.'),
    '<div class="ph-pm-intro">' + escapeHtml(isZh
      ? '这是编程小助手工作空间的统一配置。已运行会话会在下次重启后使用所选模式。'
      : 'This setting applies to the entire Programming Helper workspace. Running sessions use it after their next restart.') + '</div>',
    '</div>',
  ].join('');
}

// ── Main panel render ─────────────────────────────────────────

function renderPhModelConfigOverlay(agent, presets) {
  const host = ensurePhModelConfigHost();
  if (!agent) { host.innerHTML = ''; _closePhFeatureEditor(); return; }
  const isZh = currentLanguage === 'zh';

  // Store current project for process mode key
  const projects = (typeof getFeatureCreatorProjects === 'function')
    ? getFeatureCreatorProjects(agent) : [];
  window._phCurrentProject = projects.find(p => p.openDirectory === agent?.workspace_state?.openDirectory) || projects[0] || null;

  // ── Feature 设置二级页：共享配置编辑器（agent 层）──────────
  if (_phSettingsTab === 'feature') {
    if (typeof createFeatureConfigEditor !== 'function') {
      _phSettingsTab = 'model';
    } else {
      _closePhFeatureEditor();
      // 返回一级页（head 左侧返回按钮）
      window._phFeatureBack = () => {
        _closePhFeatureEditor();
        _phSettingsTab = 'model';
        renderPhModelConfigOverlay(agent, presets);
      };
      host.innerHTML = [
        '<div class="feature-detail-overlay">',
        '<div class="feature-detail-window ph-settings-window">',
        '<div class="feature-detail-head">',
        '<div style="display:flex;align-items:center;gap:4px;">',
        '<button class="feature-detail-close" type="button" title="' + (isZh ? '返回' : 'Back') + '" onclick="window._phFeatureBack()" style="margin-right:8px;font-size:16px;"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"></path><path d="M19 12H5"></path></svg></button>',
        '<div>',
        '<div class="feature-detail-title">' + escapeHtml(isZh ? '工作空间设置 · Feature' : 'Workspace Settings · Feature') + '</div>',
        '<div class="feature-detail-subtitle">' + escapeHtml(isZh
          ? '编程小助手整体的 Feature 配置，对所有项目目录生效'
          : 'Feature config for the whole Programming Helper workspace') + '</div>',
        '</div>',
        '</div>',
        '<button class="feature-detail-close" type="button" onclick="window.phCloseModelConfig()">&times;</button>',
        '</div>',
        '<div class="ph-settings-feature-wrap" id="ph-feature-config-host"></div>',
        '</div>',
        '</div>',
      ].join('');
      _phFeatureEditor = createFeatureConfigEditor({
        host: document.getElementById('ph-feature-config-host'),
        scopeId: 'agent',
      });
      _phFeatureEditor.open();
      return;
    }
  }
  _closePhFeatureEditor();

  const tabs = [
    { key: 'model', label: isZh ? '模型配置' : 'Model Config', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>' },
    { key: 'process', label: isZh ? '进程模式' : 'Process Mode', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>' },
    { key: 'feature', label: isZh ? 'Feature 设置' : 'Feature Config', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M2 14h4"/><path d="M10 8h4"/><path d="M18 16h4"/></svg>' },
  ];

  const tabItems = tabs.map(t => {
    const active = _phSettingsTab === t.key;
    return '<div class="ph-settings-tab' + (active ? ' active' : '') + '" onclick="window._phSwitchSettingsTab(\'' + t.key + '\')">'
      + '<span class="ph-settings-tab-icon">' + t.icon + '</span>'
      + '<span class="ph-settings-tab-label">' + escapeHtml(t.label) + '</span>'
      + '</div>';
  }).join('');

  let contentHtml;
  if (_phSettingsTab === 'model') {
    contentHtml = _renderModelConfigContent(agent, presets);
  } else {
    contentHtml = _renderProcessModeContent(agent);
  }

  const subtitle = _phSettingsTab === 'model'
    ? (isZh ? '为主代理设置主模型和备选模型，其他角色设置单个模型' : 'Set primary and secondary models for main agent, single model for other roles')
    : (isZh ? '选择新会话的进程运行方式' : 'Choose how new sessions run');

  host.innerHTML = [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window ph-settings-window">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + (isZh ? '工作空间设置' : 'Workspace Settings') + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(subtitle) + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" onclick="window.phCloseModelConfig()">&times;</button>',
    '</div>',
    '<div class="ph-settings-layout">',
    '<div class="ph-settings-sidebar">',
    tabItems,
    '</div>',
    '<div class="ph-settings-content">',
    contentHtml,
    '</div>',
    '</div>',
    '</div>',
    '</div>',
  ].join('');

  // Enhance native selects with custom dropdown
  if (window.ClawSelect) {
    requestAnimationFrame(function() {
      window.ClawSelect.enhanceAll(host);
    });
  }
}
window._phSwitchSettingsTab = (tab) => {
  _phSettingsTab = tab;
  const agent = (typeof getCurrentAgentRecord === 'function') ? getCurrentAgentRecord() : null;
  if (agent) {
    const presets = window.ClawFW?._modelPresets || [];
    renderPhModelConfigOverlay(agent, presets);
  }
};
