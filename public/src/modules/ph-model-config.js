/**
 * ph-model-config.js — 编程小助手模型配置覆层（从 app-ui.js 域 D 提取）
 *
 * 包含：
 *   - ensurePhModelConfigHost: 覆层宿主元素获取/创建
 *   - renderPhModelConfigOverlay: 模型配置覆层渲染（主代理双槽位 + 其他角色单槽位）
 *
 * 外部依赖（通过全局作用域）：
 *   - escapeHtml (app-ui.js)
 *   - currentLanguage (app-core.js)
 *
 * 被 app-main.js 通过 window.phOpenModelConfig → renderPhModelConfigOverlay 调用。
 * onchange 调用 window.phAutoSaveModelConfig（定义在 ph-project-actions.js）。
 * 关闭按钮调用 window.phCloseModelConfig（定义在 ph-project-actions.js）。
 */
'use strict';

function ensurePhModelConfigHost() {
  let host = document.getElementById('ph-model-config-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ph-model-config-host';
    document.body.appendChild(host);
  }
  return host;
}

function renderPhModelConfigOverlay(agent, presets) {
  const host = ensurePhModelConfigHost();
  if (!agent) { host.innerHTML = ''; return; }
  const isZh = currentLanguage === 'zh';
  const current = agent.modelPresets || {};
  const roles = [
    { key: 'default', label: isZh ? '主代理' : 'Main Agent', desc: isZh ? '对话和编码任务' : 'Chat & coding tasks' },
    { key: 'exploration', label: isZh ? '探索代理' : 'Explorer', desc: isZh ? '代码探索与调研' : 'Code exploration & research' },
    { key: 'sub', label: isZh ? '子代理' : 'Sub Agent', desc: isZh ? '派生执行子任务' : 'Spawned task execution' },
    { key: 'system', label: isZh ? '系统管理' : 'System', desc: isZh ? '系统自管理能力' : 'System self-management' },
  ];
  const rows = roles.map(function(role) {
    // 支持双槽位格式：{ primary: 'model1', secondary: 'model2' } 或旧格式字符串
    const roleConfig = current[role.key] || {};
    const primaryVal = typeof roleConfig === 'string' ? roleConfig : (roleConfig.primary || '');
    const secondaryVal = typeof roleConfig === 'string' ? '' : (roleConfig.secondary || '');
    const isDefaultRole = role.key === 'default'; // 只有主代理有双槽位

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

    // 主代理显示双槽位，其他角色只显示单槽位
    if (isDefaultRole) {
      const primarySelect = '<select class="ph-mc-select" data-preset-role="' + role.key + '" data-slot="primary" onchange="window.phAutoSaveModelConfig()">'
        + '<option value=""' + (!primaryVal ? ' selected' : '') + '>' + (isZh ? '(默认)' : '(Default)') + '</option>'
        + buildOptions(primaryVal)
        + '</select>';

      const secondarySelect = '<select class="ph-mc-select" data-preset-role="' + role.key + '" data-slot="secondary" onchange="window.phAutoSaveModelConfig()">'
        + '<option value=""' + (!secondaryVal ? ' selected' : '') + '>' + (isZh ? '(不设置)' : '(Not set)') + '</option>'
        + buildOptions(secondaryVal)
        + '</select>';

      return '<div class="ph-mc-row ph-mc-row-primary">'
        + '<div class="ph-mc-role"><div class="ph-mc-role-name">' + escapeHtml(role.label) + '</div><div class="ph-mc-role-desc">' + escapeHtml(role.desc) + '</div></div>'
        + '<div class="ph-mc-control">'
        + '<div class="ph-mc-slots">'
        + '<div class="ph-mc-slot">'
        + '<div class="ph-mc-slot-label">' + (isZh ? '主模型' : 'Primary') + '</div>'
        + primarySelect
        + buildInfoHtml(primaryVal)
        + '</div>'
        + '<div class="ph-mc-slot">'
        + '<div class="ph-mc-slot-label">' + (isZh ? '备选模型' : 'Secondary') + '</div>'
        + secondarySelect
        + buildInfoHtml(secondaryVal)
        + '</div>'
        + '</div>'
        + '</div>'
        + '</div>';
    } else {
      // 其他角色只显示单槽位
      const selectHtml = '<select class="ph-mc-select" data-preset-role="' + role.key + '" data-slot="primary" onchange="window.phAutoSaveModelConfig()">'
        + '<option value=""' + (!primaryVal ? ' selected' : '') + '>' + (isZh ? '(默认)' : '(Default)') + '</option>'
        + buildOptions(primaryVal)
        + '</select>';

      return '<div class="ph-mc-row">'
        + '<div class="ph-mc-role"><div class="ph-mc-role-name">' + escapeHtml(role.label) + '</div><div class="ph-mc-role-desc">' + escapeHtml(role.desc) + '</div></div>'
        + '<div class="ph-mc-control">'
        + selectHtml
        + buildInfoHtml(primaryVal)
        + '</div>'
        + '</div>';
    }
  }).join('');

  host.innerHTML = [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window" style="max-width:680px;">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + (isZh ? '模型配置' : 'Model Config') + '</div>',
    '<div class="feature-detail-subtitle">' + (isZh ? '为主代理设置主模型和备选模型，其他角色设置单个模型' : 'Set primary and secondary models for main agent, single model for other roles') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" onclick="window.phCloseModelConfig()">×</button>',
    '</div>',
    '<div class="ph-mc-body">',
    rows,
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}
