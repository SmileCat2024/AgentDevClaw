/**
 * ph-settings.js — 编程小助手「工作空间设置」面板（UI 标题：工作空间设置）
 *
 * IDE 式布局：左侧分类列表 + 右侧配置区域。
 * 分类页：插件、Coder、模型配置、进程模式，以及 Coder 策略、通知、容器镜像。
 * 插件页内部区分装配清单与能力参数；Coder 页直接编辑 Coder 的参数。
 * 历史名 ph-model-config：面板早期只有模型选择器，职责扩张后更名，勿再回用旧名。
 *
 * 外部依赖（通过全局作用域）：
 *   - escapeHtml (app-ui.js)
 *   - currentLanguage (app-core.js)
 *   - createFeatureConfigEditor (feature-config-editor.js)
 *
 * 入口：window.phOpenSettings() → renderPhSettingsOverlay()
 * 面板内交互经 data-action="phSettings.*" 分发（action-dispatcher.js），
 * 处理器收敛在本模块局部；跨模块动作（关闭 phCloseSettings、模型槽位
 * phModelSlotChanged、进程模式 phSetProcessMode、Feature 仓库
 * phOpenFeatureStore / _fsRemoveFor）由 handler 经 window 转调，
 * 其收敛随各自模块批次处理。
 */
'use strict';

let _phSettingsTab = 'model'; // 'model' | 'process' | 'feature' | 'coder'
let _phFeatureSubTab = 'mounts'; // 当前身份页的视图：装配清单 | 参数配置
let _phFeatureEditor = null;
let _phFeatureConfigTarget = null;

function _closePhFeatureEditor() {
  if (_phFeatureEditor) {
    _phFeatureEditor.close();
    _phFeatureEditor = null;
  }
}

function ensurePhSettingsHost() {
  let host = document.getElementById('ph-settings-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ph-settings-host';
    document.body.appendChild(host);
  }
  return host;
}

// ── Model config content ──────────────────────────────────────

function _renderModelConfigContent(agent, presets) {
  const isZh = currentLanguage === 'zh';
  const current = agent.modelPresets || {};
  // coder APP（独立工作空间，ADR-0025）的模型配置存 agent-configs/coder.json，
  // 与主 APP 分文件；编程小助手面板代管展示，打开时单独 fetch 缓存。
  const showCoderRow = window.phSettingsAgentId === 'programming-helper';
  const coderCurrent = (window.ClawFW && window.ClawFW._coderModelPresets) || {};
  const roles = [
    { key: 'default', label: isZh ? '编程小助手' : 'Programming Helper', desc: isZh ? '对话和编码任务' : 'Chat & coding tasks' },
    ...(showCoderRow ? [{
      key: 'coder',
      label: 'Coder',
      desc: isZh
        ? '高效的自主编码智能体'
        : 'Efficient autonomous coding agent',
      roleConfig: coderCurrent.default,
    }] : []),
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

  const buildThinkingSelect = (roleKey, slot, presetName, roleConfig) => {
    const preset = presets.find(function(p) { return p.name === presetName; });
    const protocol = preset && (preset.provider || preset.protocol);
    const options = window.ClawFW && window.ClawFW.getThinkingEffortOptions
      ? window.ClawFW.getThinkingEffortOptions(protocol)
      : [];
    const configured = roleConfig?.thinkingEffort && roleConfig.thinkingEffort[slot];
    const selected = configured || preset?.thinkingEffort || '';
    const disabled = !preset || options.length === 0;
    const optionHtml = options.map(function(effort) {
      return '<option value="' + escapeHtml(effort) + '"' + (effort === selected ? ' selected' : '') + '>' + escapeHtml(effort) + '</option>';
    }).join('');
    return '<select class="ph-mc-effort" data-claw-select data-preset-role="' + roleKey + '" data-slot="' + slot + '"'
      + ' data-action="phSettings.autoSaveModel"' + (disabled ? ' disabled' : '') + '>'
      + '<option value="">' + escapeHtml(isZh ? '默认' : 'Default') + '</option>'
      + optionHtml
      + '</select>';
  };

  const rows = roles.map(function(role) {
    const roleConfig = role.roleConfig !== undefined ? role.roleConfig : (current[role.key] || {});
    const roleModelConfig = roleConfig && typeof roleConfig === 'object' ? roleConfig : {};
    const primaryVal = typeof roleConfig === 'string' ? roleConfig : (roleConfig.primary || '');
    const secondaryVal = typeof roleConfig === 'string' ? '' : (roleConfig.secondary || '');
    const isDefaultRole = role.key === 'default';

    const primarySelect = '<select class="ph-mc-select" data-claw-select data-preset-role="' + role.key + '" data-slot="primary" data-action="phSettings.modelSlotChanged">'
      + '<option value=""' + (!primaryVal ? ' selected' : '') + '>' + (isZh ? '(默认)' : '(Default)') + '</option>'
      + buildOptions(primaryVal)
      + '</select>';
    const primaryEffort = buildThinkingSelect(role.key, 'primary', primaryVal, roleModelConfig);

    const labelCol = '<div class="ph-mc-role"><div class="ph-mc-role-name">' + escapeHtml(role.label) + '</div><div class="ph-mc-role-desc">' + escapeHtml(role.desc) + '</div></div>';

    if (isDefaultRole) {
      const secondarySelect = '<select class="ph-mc-select" data-claw-select data-preset-role="' + role.key + '" data-slot="secondary" data-action="phSettings.modelSlotChanged">'
        + '<option value=""' + (!secondaryVal ? ' selected' : '') + '>' + (isZh ? '(不设置)' : '(Not set)') + '</option>'
        + buildOptions(secondaryVal)
        + '</select>';
      const secondaryEffort = buildThinkingSelect(role.key, 'secondary', secondaryVal, roleModelConfig);

      return '<div class="ph-mc-row ph-mc-row-primary">'
        + labelCol
        + '<div class="ph-mc-control"><div class="ph-mc-slot"><div class="ph-mc-slot-label">' + (isZh ? '主模型' : 'Primary') + '</div>'
        + '<div class="ph-mc-pickers">' + primarySelect + primaryEffort + '</div>' + buildInfoHtml(primaryVal) + '</div>'
        + '<div class="ph-mc-slot"><div class="ph-mc-slot-label">' + (isZh ? '备选' : 'Secondary') + '</div>'
        + '<div class="ph-mc-pickers">' + secondarySelect + secondaryEffort + '</div>' + buildInfoHtml(secondaryVal) + '</div></div>'
        + '</div>';
    } else {
      return '<div class="ph-mc-row">'
        + labelCol
        + '<div class="ph-mc-single">'
        + '<div class="ph-mc-pickers">' + primarySelect + primaryEffort + '</div>'
        + buildInfoHtml(primaryVal)
        + '</div>'
        + '</div>';
    }
  }).join('');

  return '<div class="ph-mc-list">' + rows + '</div>';
}

// ── 工作空间插件与 Coder 配置页 ──────────────────────────────
// 插件清单只管理用户装配的插件包与官方可选插件；内置运行时 Feature
// 仍由会话中的 Features inspector 展示。插件参数编辑保留原配置树语义。
//
// Coder 参数的 allowlist 与 coder-agent.js 的有配置项挂载清单对齐：
// shell / memory / skill / github / force-continuation。
const PH_CODER_INCLUDE_FEATURES = ['shell', 'memory', 'skill', 'github', 'force-continuation'];

const PH_FEATURE_PAGES = {
  feature: {
    identityKey: 'main',
    scopeId: 'agent',
    subtitleZh: '管理当前工作空间的插件及其能力参数',
    subtitleEn: 'Manage workspace plugins and their capability settings',
  },
  coder: {
    identityKey: 'coder',
    scopeId: 'agent',
    scopeAgentId: 'coder',
    subtitleZh: '管理 Coder 的插件装配与能力参数',
    subtitleEn: 'Manage Coder plugin assembly and capability settings',
  },
};

/**
 * 工作空间的可管理插件清单：只呈现用户装配的可选扩展，不暴露内部 Feature 清单。
 * 内置 Feature 的运行时状态仍由会话中的 Features inspector 展示。
 */
let _phMountData = null;         // 最近一次拉取的工作空间插件装配数据

async function _phRenderMountsView(identityKey) {
  const host = document.getElementById('ph-feature-mounts-host');
  if (!host) return;
  host.innerHTML = '<div class="ph-settings-empty">' + escapeHtml(currentLanguage === 'zh' ? '正在读取装配…' : 'Loading assembly…') + '</div>';
  try {
    const res = await fetch('/api/feature-store/overview');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || (res.status + ' ' + res.statusText));
    const mounts = data.mounts?.[identityKey] || {};
    const baseFeatures = data.base?.[identityKey] || [];
    const builtinByName = new Map((data.builtin || []).map((item) => [item.runtimeName, item]));
    const entriesByName = new Map();
    for (const item of baseFeatures) {
      entriesByName.set(item.name, {
        name: item.name,
        description: item.description || '',
        surface: item.surface || null,
        origin: 'official',
        mount: mounts[item.name] || null,
      });
    }
    for (const [name, mount] of Object.entries(mounts)) {
      const builtin = builtinByName.get(name);
      entriesByName.set(name, {
        name,
        description: mount.missing ? (mount.package + '@' + mount.version) : (builtin?.description || ''),
        surface: mount.kind === 'builtin' ? (builtin?.surface || null) : null,
        origin: mount.kind === 'builtin' ? 'official' : 'installed',
        mount,
      });
    }
    const entries = [...entriesByName.values()];
    _phMountData = { identityKey, entries, envReady: data.envReady?.[identityKey] || null };
    _phRenderMountsBody(host);
  } catch (err) {
    _phMountData = null;
    host.innerHTML = '<div class="ph-settings-empty" style="padding:32px 0;color:var(--danger,#e5484d);">' + escapeHtml(String(err && err.message ? err.message : err)) + '</div>';
  }
}

/** 纯渲染（数据取 _phMountData 缓存）：筛选切换与 catalog 就绪后的重渲染入口。 */
function _phRenderMountsBody(host) {
  const isZh = currentLanguage === 'zh';
  const entries = _phMountData.entries;
  const features = entries.map(function(e) {
    return { name: e.name, description: e.description, _entry: e };
  });

  const addButton = '<button type="button" class="ph-mount-add" style="margin-left:auto;" data-action="phSettings.openFeatureStore" data-identity="' + escapeHtml(_phMountData.identityKey) + '">'
    + escapeHtml(isZh ? '+ 添加插件' : '+ Add Plugins') + '</button>';

  const buildCard = function(f) {
    const e = f._entry;
    const mount = e.mount;
    const isOfficial = e.origin === 'official';
    const provenance = isOfficial
      ? '<span class="feature-prov-badge">' + escapeHtml(isZh ? '官方' : 'Official') + '</span>'
      : '<span class="feature-prov-badge" title="' + escapeHtml((mount?.package || '') + '@' + (mount?.version || '')) + '">'
        + escapeHtml(isZh ? '扩展' : 'Extension') + '</span>';
    const configBtn = '<button type="button" class="fs-settings-btn" title="' + escapeHtml(isZh ? '配置参数' : 'Configure') + '"'
      + ' data-action="phSettings.openFeatureConfig" data-name="' + escapeHtml(f.name) + '">&#9881;</button>';
    const removeBtn = mount
      ? '<button type="button" class="fs-list-remove" title="' + escapeHtml(isZh ? '移除插件' : 'Remove plugin') + '"'
        + ' data-action="phSettings.removeMountFeature" data-identity="' + escapeHtml(_phMountData.identityKey) + '" data-name="' + escapeHtml(f.name) + '">&#215;</button>'
      : '';
    const missing = mount?.missing
      ? '<span class="feature-badge status-removed">' + escapeHtml(isZh ? '包已不在仓库' : 'Missing package') + '</span>'
      : '';
    return _phMountCard(f.name, f.name, missing, provenance, configBtn + removeBtn, null);
  };

  const cardsHtml = features.map(buildCard).join('');
  const emptyHtml = '<div class="ph-mount-empty-cta">'
    + '<div class="ph-mount-empty-title">' + escapeHtml(isZh ? '暂无可配置的 Feature' : 'No configurable features') + '</div>'
    + '<div class="ph-mount-empty-desc">' + escapeHtml(isZh
      ? '此身份当前没有已装配的可选插件。'
      : 'No optional plugins are currently assembled for this identity.') + '</div></div>';

  host.innerHTML = '<div class="ph-mounts-body">'
    + _phEnvNoticeHtml()
    + '<div class="ph-mount-toolbar"><div><div class="ph-mount-toolbar-title">'
    + escapeHtml(isZh ? '已装配能力' : 'Assembled capabilities') + '</div><div class="ph-mount-toolbar-hint">'
    + escapeHtml(isZh ? '官方内置能力与已添加插件均可直接进入参数设置。' : 'Configure official capabilities and installed plugins here.')
    + '</div></div>' + addButton + '</div>'
    + '<div class="ph-mount-list">' + (cardsHtml || emptyHtml) + '</div>'
    + '</div>';
}

let _phRebuildBusy = false;

/** 环境缺失轻警告（Q3=C：可点击立即恢复；下次启动自愈兜底保留）。 */
function _phEnvNoticeHtml() {
  const isZh = currentLanguage === 'zh';
  const env = _phMountData?.envReady;
  if (!env || !env.hasEnv || env.ready) return '';
  if (_phRebuildBusy) {
    return '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;margin-bottom:10px;'
      + 'border:1px solid var(--border,#ddd);border-radius:8px;font-size:12px;color:var(--text-secondary);">'
      + escapeHtml(isZh ? '正在恢复插件环境…' : 'Restoring plugin environment…') + '</div>';
  }
  return '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;margin-bottom:10px;'
    + 'border:1px solid #e8c35a;background:rgba(232,195,90,0.08);border-radius:8px;font-size:12px;">'
    + '<span style="color:#c79420;">&#9888;</span>'
    + '<span style="flex:1;color:var(--text-secondary);">' + escapeHtml(isZh
      ? '插件环境需要恢复：下次启动时自动完成，不影响已装配声明。'
      : 'Plugin environment needs restoring: it will be rebuilt automatically on next launch.') + '</span>'
    + '<button type="button" class="fs-list-add" data-action="phSettings.rebuildEnv">'
    + escapeHtml(isZh ? '立即恢复' : 'Restore now') + '</button>'
    + '</div>';
}

const _phRebuildEnv = async function() {
  if (_phRebuildBusy || !_phMountData) return;
  _phRebuildBusy = true;
  const host = document.getElementById('ph-feature-mounts-host');
  if (host && _phMountData) _phRenderMountsBody(host);
  try {
    const res = await fetch('/api/feature-store/rebuild', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: _phMountData.identityKey }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || (res.status + ' ' + res.statusText));
    await _phRenderMountsView(_phMountData.identityKey);
  } catch (err) {
    if (host && _phMountData) {
      host.innerHTML = '<div class="ph-settings-empty" style="padding:32px 0;color:var(--danger,#e5484d);">'
        + escapeHtml(String(err && err.message ? err.message : err)) + '</div>';
    }
  } finally {
    _phRebuildBusy = false;
  }
};

// 商店写操作后的刷新钩子：插件页当前显示清单时重拉。
window._phRefreshMountsView = function(identityKey) {
  const page = PH_FEATURE_PAGES[_phSettingsTab];
  if (page && page.identityKey === (identityKey || page.identityKey) && _phFeatureSubTab === 'mounts') {
    _phRenderMountsView(page.identityKey);
  }
};

// 关闭弹窗时清理本页的临时数据；设置弹窗记忆当前一级页签。
window._phResetFeaturePageState = function() {
  _phMountData = null;
  _phFeatureSubTab = 'mounts';
  _phFeatureConfigTarget = null;
};

/**
 * 复用 Features 面板 feature-card 结构；displayName 为 catalog 解析的展示名
 * （缺失回退 name，title 悬浮携带 runtime name），provHtml 为来源 pill
 * （原样插入，调用方负责转义），badgesHtml 为附加徽章/按钮，detailHtml 为数量行。
 */
function _phMountCard(name, displayName, description, provHtml, badgesHtml, detailHtml) {
  return '<div class="feature-card" style="cursor:default;" title="' + escapeHtml(name) + '">'
    + '<div class="feature-card-top">'
    + '<div class="feature-card-main">'
    + '<span class="feature-card-dot"></span>'
    + '<div style="min-width:0;">'
    + '<div class="feature-card-name">' + escapeHtml(displayName)
    + (displayName !== name ? ' <span class="feature-detail-id">' + escapeHtml(name) + '</span>' : '') + '</div>'
    + (description ? '<div class="feature-card-file">' + escapeHtml(description) + '</div>' : '')
    + '</div>'
    + '</div>'
    + '<div class="feature-card-badges">'
    + (provHtml || '')
    + (badgesHtml || '')
    + '</div>'
    + '</div>'
    + (detailHtml || '')
    + '</div>';
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
      '<div class="ph-pm-card' + (active ? ' active' : '') + '" data-action="phSettings.setProcessMode" data-mode="' + mode + '">',
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

// ── Coder 策略：关联工作空间配置面 ────────────────────────────

async function _phLoadCoderPolicy() {
  const host = document.getElementById('ph-coder-policy-host');
  if (!host) return;
  const isZh = currentLanguage === 'zh';
  try {
    const response = await fetch('/protoclaw/workspace_settings');
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    if (!document.getElementById('ph-coder-policy-host') || _phSettingsTab !== 'coder-policy') return;
    const limit = data?.resourcePolicy?.coder?.maxLiveThreads;
    const value = Number.isInteger(limit) && limit > 0 ? String(limit) : '';
    const live = Number.isInteger(data?.liveThreads?.coder) ? data.liveThreads.coder : 0;
    // 接续策略生效值判定链与通知设置同构：用户覆盖（resourcePolicy）>
    // 作者默认（coder metadata permissionDefaults）> 'adaptive'。
    const coderAgent = (Array.isArray(allAgents) ? allAgents : []).find((a) => a?.id === 'coder');
    const authorDefault = coderAgent?.permissionDefaults?.contextRotationStrategy;
    const strategyOverride = data?.resourcePolicy?.coder?.contextRotationStrategy;
    const strategy = typeof strategyOverride === 'string' && strategyOverride
      ? strategyOverride
      : (typeof authorDefault === 'string' && authorDefault ? authorDefault : 'adaptive');
    const runtimeMode = data?.resourcePolicy?.coder?.runtimeExecutionMode || 'standard';
    // 卡片形态照进程模式页（ph-pm-card 单选卡片），不另造控件。
    const optionCard = (mode, active, title, desc, action = 'setCoderRotationStrategy') => {
      return [
        '<div class="ph-pm-card' + (active ? ' active' : '') + '" data-action="phSettings.' + action + '" data-mode="' + mode + '">',
        '<div class="ph-pm-radio' + (active ? ' checked' : '') + '"></div>',
        '<div class="ph-pm-card-body">',
        '<div class="ph-pm-card-title">' + escapeHtml(title) + '</div>',
        '<div class="ph-pm-card-desc">' + escapeHtml(desc) + '</div>',
        '</div>',
        '</div>',
      ].join('');
    };
    host.innerHTML = [
      // 行式布局照模型配置页（ph-mc-row）：左标题列（名称 + 解释副标题）+
      // 右定宽控件列，避免 settings-input 满宽拉伸（width:100%）在 flex
      // 行里被拉成通栏。
      '<section class="ph-coder-policy-section">',
      '<div class="ph-mc-row">',
      '<div class="ph-mc-role">',
      '<div class="ph-mc-role-name">' + (isZh ? '线程并发上限' : 'Thread concurrency limit') + '</div>',
      '<div class="ph-mc-role-desc">' + (isZh
        ? 'Coder 未归档线程的数量上限，超出时新建线程被拒（已有线程不受影响，归档后释放名额）'
        : 'Maximum live (unarchived) Coder threads; new thread creation is rejected beyond this limit (existing threads unaffected; archiving frees a slot)') + '</div>',
      (live > 0 ? '<div class="ph-mc-role-desc">' + (isZh ? '当前 ' + live + ' 条未归档线程' : live + ' live threads') + '</div>' : ''),
      '</div>',
      '<div style="flex:0 0 140px;display:flex;justify-content:flex-end;padding-top:7px;">',
      '<input id="ph-coder-thread-limit" type="number" min="1" step="1" class="settings-input" placeholder="' + (isZh ? '不限制' : 'Unlimited') + '" value="' + value + '" data-action="phSettings.saveCoderThreadLimit">',
      '</div>',
      '</div>',
      '</section>',
      '<section class="ph-coder-policy-section">',
      '<div class="ph-mc-row"><div class="ph-mc-role"><div class="ph-mc-role-name">' + (isZh ? '运行模式' : 'Runtime mode') + '</div><div class="ph-mc-role-desc">' + (isZh ? '选择任务运行的位置。' : 'Choose where Coder tasks run.') + '</div></div></div>',
      '<div class="ph-pm-body ph-coder-runtime-options">',
      optionCard('standard', runtimeMode === 'standard', isZh ? '标准模式' : 'Standard', isZh ? '直接在本机运行。' : 'Run directly on this machine.', 'setCoderRuntimeMode'),
      optionCard('container', runtimeMode === 'container', isZh ? '容器模式' : 'Container', isZh ? '在容器环境中运行。' : 'Run in a container environment.', 'setCoderRuntimeMode'),
      optionCard('agent-choice', runtimeMode === 'agent-choice', isZh ? '让 Agent 自主选择' : 'Agent chooses', isZh ? '每次创建任务时选择标准模式或容器模式。' : 'Choose standard or container each time a task is created.', 'setCoderRuntimeMode'),
      '</div>',
      '</section>',
      '<section class="ph-coder-policy-section">',
      // 接续策略行与并发上限行同形态（ph-mc-row + role 名称/解释），
      // 策略卡片区随行展开。
      '<div class="ph-mc-row">',
      '<div class="ph-mc-role">',
      '<div class="ph-mc-role-name">' + (isZh ? '接续策略' : 'Rotation strategy') + '</div>',
      '<div class="ph-mc-role-desc">' + (isZh
        ? '上下文接近上限时，Coder 自动接续新会话所采用的精简方式'
        : 'How Coder compacts context when rotating to a new session near the limit') + '</div>',
      '</div>',
      '</div>',
      '<div class="ph-pm-body">',
      optionCard('adaptive', strategy === 'adaptive',
        isZh ? '自适应' : 'Adaptive',
        isZh
          ? '默认。先精简并保留最近 5 次工具调用；压缩不足时逐级升级——仍超 50% 追加摘要，超 80% 转为纯摘要。'
          : 'Default. Trim first, keeping the last 5 tool calls; escalate only when compression falls short: above 50% appends a summary, above 80% switches to pure summary.'),
      optionCard('trim', strategy === 'trim',
        isZh ? '纯精简' : 'Trim Only',
        isZh
          ? '折叠工具活动，保留对话文本与最近 5 次工具调用；不生成摘要，无额外模型开销。'
          : 'Fold tool activity, keep dialogue plus the last 5 tool calls. No summary, no extra LLM cost.'),
      optionCard('summary', strategy === 'summary',
        isZh ? '纯摘要' : 'Summary Only',
        isZh
          ? '将整个会话浓缩为一份九段式摘要；上下文最小，保留细节最少。'
          : 'Condense the whole session into one nine-section summary. Smallest context, least detail.'),
      '</div>',
      '</section>',
      '<div id="ph-coder-policy-status" style="margin:12px 24px 0;"></div>',
    ].join('');
  } catch (error) {
    host.innerHTML = '<div class="ph-settings-empty">' + escapeHtml((isZh ? '读取 Coder 策略失败：' : 'Could not load Coder policy: ') + (error?.message || error)) + '</div>';
  }
}

const phSetCoderRuntimeMode = async function(mode) {
  if (!['standard', 'container', 'agent-choice'].includes(mode)) return;
  const isZh = currentLanguage === 'zh';
  const status = document.getElementById('ph-coder-policy-status');
  try {
    const response = await fetch('/protoclaw/workspace_settings/resource_policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'coder', permissionId: 'runtimeExecutionMode', value: mode }),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    if (status) status.textContent = isZh ? '已保存' : 'Saved';
    await _phLoadCoderPolicy();
  } catch (error) {
    if (status) status.textContent = (isZh ? '保存失败：' : 'Save failed: ') + (error?.message || error);
  }
};

const phSetCoderRotationStrategy = async function(strategy) {
  const isZh = currentLanguage === 'zh';
  const status = document.getElementById('ph-coder-policy-status');
  const setStatus = (message) => { if (status) status.textContent = message; };
  if (strategy !== 'adaptive' && strategy !== 'trim' && strategy !== 'summary') return;
  setStatus(isZh ? '正在保存…' : 'Saving…');
  try {
    const response = await fetch('/protoclaw/workspace_settings/resource_policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'coder', permissionId: 'contextRotationStrategy', value: strategy }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data?.error || 'HTTP ' + response.status);
    }
    setStatus(isZh ? '已保存' : 'Saved');
    await _phLoadCoderPolicy();
  } catch (error) {
    setStatus((isZh ? '保存失败：' : 'Save failed: ') + (error?.message || error));
  }
};

const phSaveCoderThreadLimit = async function(rawValue) {
  const isZh = currentLanguage === 'zh';
  const status = document.getElementById('ph-coder-policy-status');
  const setStatus = (message) => { if (status) status.textContent = message; };
  const trimmed = String(rawValue || '').trim();
  let maxLiveThreads = null;
  if (trimmed !== '') {
    maxLiveThreads = Number(trimmed);
    if (!Number.isInteger(maxLiveThreads) || maxLiveThreads <= 0) {
      setStatus(isZh ? '并发上限须为正整数，未保存。' : 'Limit must be a positive integer; not saved.');
      return;
    }
  }
  setStatus(isZh ? '正在保存…' : 'Saving…');
  try {
    const response = await fetch('/protoclaw/workspace_settings/resource_policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'coder', permissionId: 'maxLiveThreads', value: maxLiveThreads }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data?.error || 'HTTP ' + response.status);
    }
    setStatus(isZh ? '已保存' : 'Saved');
    await _phLoadCoderPolicy();
  } catch (error) {
    setStatus((isZh ? '保存失败：' : 'Save failed: ') + (error?.message || error));
  }
};

// ── 通知：本工作空间与 Coder 完成通知的集中承接（ADR-0030 editingSurface）───

// 声明制渲染：只显示 metadata 声明了 notifications.finish 的工作空间开关
// （宿主配置自己 + coder）。生效值判定链：resourcePolicy 用户覆盖 >
// permissionDefaults 作者默认 > false；写入 PUT
// /protoclaw/workspace_settings/resource_policy（与全局「工作空间设置」
// 的只读审计是同一份数据）。
async function _phLoadNotificationSettings() {
  const host = document.getElementById('ph-notification-host');
  if (!host) return;
  const isZh = currentLanguage === 'zh';
  let resourcePolicy = {};
  try {
    const response = await fetch('/protoclaw/workspace_settings');
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    resourcePolicy = data?.resourcePolicy && typeof data.resourcePolicy === 'object' ? data.resourcePolicy : {};
  } catch (error) {
    if (!document.getElementById('ph-notification-host') || _phSettingsTab !== 'notification') return;
    host.innerHTML = '<div class="ph-settings-empty">' + escapeHtml((isZh ? '读取通知设置失败：' : 'Could not load notifications: ') + (error?.message || error)) + '</div>';
    return;
  }
  if (!document.getElementById('ph-notification-host') || _phSettingsTab !== 'notification') return;
  const agents = Array.isArray(allAgents) ? allAgents : [];
  const targets = ['programming-helper', 'coder']
    .map((agentId) => agents.find((a) => a.id === agentId && a.source === 'prebuilt'))
    .filter((a) => a && Array.isArray(a.permissions) && a.permissions.includes('notifications.finish'));
  if (targets.length === 0) {
    host.innerHTML = '<div class="ph-settings-empty">' + escapeHtml(isZh ? '暂无可配置的通知项。' : 'No notifications to configure.') + '</div>';
    return;
  }
  const rows = targets.map((a) => {
    const userValue = resourcePolicy[a.id]?.['notifications.finish'];
    const defaults = a.permissionDefaults && typeof a.permissionDefaults === 'object' ? a.permissionDefaults : {};
    const authorDefault = typeof defaults['notifications.finish'] === 'boolean' ? defaults['notifications.finish'] : false;
    const effective = typeof userValue === 'boolean' ? userValue : authorDefault;
    // 行式布局照模型配置页（ph-mc-row）：左标题列 + 右开关
    return [
      '<div class="ph-mc-row">',
      '<div class="ph-mc-role">',
      '<div class="ph-mc-role-name">' + escapeHtml(a.name || a.id) + '</div>',
      '<div class="ph-mc-role-desc">' + (isZh ? '焦点不在本页面时，完成即弹通知' : 'Toast on finish while you are away') + '</div>',
      '</div>',
      '<div style="display:flex;justify-content:flex-end;align-items:center;padding-top:7px;">',
      '<label class="proxy-switch">',
      '<input type="checkbox" ' + (effective ? 'checked' : '') + ' data-action="phSettings.toggleNotifyFinish" data-agent="' + escapeHtml(a.id) + '" />',
      '<span class="proxy-switch-slider"></span>',
      '</label>',
      '</div>',
      '</div>',
    ].join('');
  }).join('');
  host.innerHTML = [
    rows,
    '<div id="ph-notification-status" style="margin:0 24px;"></div>',
  ].join('');
}

const _phToggleNotificationFinish = async function(agentId, checked) {
  const isZh = currentLanguage === 'zh';
  const status = document.getElementById('ph-notification-status');
  const setStatus = (message) => { if (status) status.textContent = message; };
  try {
    const response = await fetch('/protoclaw/workspace_settings/resource_policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, permissionId: 'notifications.finish', value: checked === true }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data?.error || 'HTTP ' + response.status);
    }
    setStatus(isZh ? '已保存' : 'Saved');
  } catch (error) {
    setStatus((isZh ? '保存失败：' : 'Save failed: ') + (error?.message || error));
  }
  // 重取渲染：成功时与服务器态收敛一致，失败时开关回滚到服务器真值
  await _phLoadNotificationSettings();
};

// ── Main panel render ─────────────────────────────────────────

function renderPhSettingsOverlay(agent, presets, { initialTab } = {}) {
  if (initialTab && (initialTab === 'model' || initialTab === 'feature' || initialTab === 'coder')) {
    _phSettingsTab = initialTab;
    if (PH_FEATURE_PAGES[initialTab]) { _phFeatureSubTab = 'mounts'; _phFeatureConfigTarget = null; }
  }
  const host = ensurePhSettingsHost();
  if (!agent) { host.innerHTML = ''; _closePhFeatureEditor(); return; }
  if (_phSettingsTab === 'coder-policy' && window.phSettingsAgentId !== 'programming-helper') {
    _phSettingsTab = 'model';
  }
  if (_phSettingsTab === 'notification' && window.phSettingsAgentId !== 'programming-helper') {
    _phSettingsTab = 'model';
  }
  if (_phSettingsTab === 'container-images' && window.phSettingsAgentId !== 'programming-helper') {
    _phSettingsTab = 'model';
  }
  const isZh = currentLanguage === 'zh';

  // Store current project for process mode key
  const projects = (typeof getFeatureCreatorProjects === 'function')
    ? getFeatureCreatorProjects(agent) : [];
  window._phCurrentProject = projects.find(p => p.openDirectory === agent?.workspace_state?.openDirectory) || projects[0] || null;

  const featurePage = PH_FEATURE_PAGES[_phSettingsTab];
  _closePhFeatureEditor();

  const tabs = [
    ...(window.phSettingsAgentId === 'programming-helper' ? [
      { key: 'feature', label: isZh ? '插件' : 'Plugins', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/></svg>' },
      { key: 'coder', label: 'Coder', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 4l-4 16"/></svg>' },
    ] : []),
    { key: 'model', label: isZh ? '模型配置' : 'Model Config', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>' },
    { key: 'process', label: isZh ? '进程模式' : 'Process Mode', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>' },
    ...(window.phSettingsAgentId === 'programming-helper' ? [{
      key: 'coder-policy',
      label: isZh ? 'Coder 策略' : 'Coder Policy',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="10" cy="18" r="2"/></svg>',
    }, {
      key: 'notification',
      label: isZh ? '通知' : 'Notifications',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
    }, {
      key: 'container-images',
      label: isZh ? '容器镜像' : 'Container Images',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>',
    }] : []),
  ];

  const tabItems = tabs.map(t => {
    const active = _phSettingsTab === t.key;
    return '<div class="ph-settings-tab' + (active ? ' active' : '') + '" data-action="phSettings.switchTab" data-tab="' + escapeHtml(t.key) + '">'
      + '<span class="ph-settings-tab-icon">' + t.icon + '</span>'
      + '<span class="ph-settings-tab-label">' + escapeHtml(t.label) + '</span>'
      + '</div>';
  }).join('');

  let contentHtml;
  if (_phSettingsTab === 'model') {
    contentHtml = _renderModelConfigContent(agent, presets);
  } else if (featurePage) {
    const identityKey = featurePage.identityKey;
    const featureSubTabs = [
      { key: 'mounts', label: isZh ? '装配' : 'Assembly' },
      { key: 'config', label: isZh ? '参数' : 'Settings' },
    ].map((item) => '<button type="button" class="ph-session-tab' + (_phFeatureSubTab === item.key ? ' active' : '')
      + '" data-action="phSettings.switchFeatureSubTab" data-sub="' + item.key + '">' + item.label + '</button>').join('');
    contentHtml = '<div class="ph-settings-feature-page" data-identity="' + escapeHtml(identityKey) + '">'
      + '<div class="ph-settings-feature-tabs">' + featureSubTabs + '</div>'
      + (_phFeatureSubTab === 'config'
        ? '<div class="ph-settings-feature-wrap" id="ph-feature-config-host"></div>'
        : '<div class="ph-settings-feature-mounts" id="ph-feature-mounts-host"><div class="ph-settings-empty">'
          + escapeHtml(isZh ? '正在读取装配…' : 'Loading assembly…') + '</div></div>')
      + '</div>';
  } else if (_phSettingsTab === 'coder-policy') {
    contentHtml = '<div class="ph-mc-list" id="ph-coder-policy-host">'
      + '<div class="ph-settings-empty">' + escapeHtml(isZh ? '正在读取 Coder 策略…' : 'Loading Coder policy…') + '</div>'
      + '</div>';
  } else if (_phSettingsTab === 'notification') {
    contentHtml = '<div class="ph-mc-list" id="ph-notification-host">'
      + '<div class="ph-settings-empty">' + escapeHtml(isZh ? '正在读取通知设置…' : 'Loading notifications…') + '</div>'
      + '</div>';
  } else if (_phSettingsTab === 'container-images') {
    // 观测页：主体是环境状态卡与镜像/容器列表，不是配置行，故用页级容器
    // （分区间距 16、内容缘 24，见 settings-catalog-page 同一节奏）
    contentHtml = '<div class="ci-page" id="ph-container-images-host">'
      + '<div class="ph-settings-empty">' + escapeHtml(isZh ? '正在读取容器镜像信息…' : 'Loading container images…') + '</div>'
      + '</div>';
  } else {
    contentHtml = _renderProcessModeContent(agent);
  }

  const subtitle = _phSettingsTab === 'model'
    ? (isZh ? '为主代理设置主模型和备选模型，其他角色设置单个模型' : 'Set primary and secondary models for main agent, single model for other roles')
    : featurePage
      ? (isZh ? featurePage.subtitleZh : featurePage.subtitleEn)
      : _phSettingsTab === 'coder-policy'
        ? (isZh ? '配置关联工作空间 Coder 的运行数量与接续策略' : 'Configure concurrency and rotation strategy for the linked Coder workspace')
        : _phSettingsTab === 'notification'
          ? (isZh ? '编程小助手与 Coder 运行完成时是否弹出系统通知' : 'Run-finished toasts for Programming Helper and Coder')
          : _phSettingsTab === 'container-images'
            ? (isZh ? '容器运行环境连接检查与按 agent 的镜像管理' : 'Docker connection & per-agent image management')
            : (isZh ? '选择新会话的进程运行方式' : 'Choose how new sessions run');

  host.innerHTML = [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window ph-settings-window">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + (isZh ? '工作空间设置' : 'Workspace Settings') + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(subtitle) + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" data-action="phSettings.close">&times;</button>',
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

  if (featurePage && _phFeatureSubTab === 'mounts') {
    _phRenderMountsView(featurePage.identityKey);
  }
  if (featurePage && _phFeatureSubTab === 'config' && typeof createFeatureConfigEditor === 'function') {
    const target = _phFeatureConfigTarget;
    _phFeatureEditor = createFeatureConfigEditor({
      host: document.getElementById('ph-feature-config-host'),
      scopeId: featurePage.scopeId,
      ...(featurePage.scopeAgentId ? { scopeAgentId: featurePage.scopeAgentId } : {}),
      ...(target?.identityKey === featurePage.identityKey ? { initialFeature: target.name } : {}),
    });
    _phFeatureEditor.open();
  }
  if (_phSettingsTab === 'coder-policy') _phLoadCoderPolicy();
  if (_phSettingsTab === 'container-images') {
    // 容器镜像页：声明域宿主（服务端按名册 host 关系圈定本工作空间 + 子应用），
    // 模块内部以 host 元素是否在 DOM 判断活跃
    window.registerContainerImagesHost?.('ph-container-images-host', window.phSettingsAgentId || 'programming-helper');
    window.loadContainerImagesPanel?.();
  }
  if (_phSettingsTab === 'notification') _phLoadNotificationSettings();

  // Enhance native selects with custom dropdown
  if (window.ClawSelect) {
    requestAnimationFrame(function() {
      window.ClawSelect.enhanceAll(host);
    });
  }
}
const _phSwitchSettingsTab = (tab) => {
  // 插件清单与能力参数只属于主工作空间插件页；Coder 使用独立配置页。
  if (PH_FEATURE_PAGES[tab]) { _phFeatureSubTab = 'mounts'; _phFeatureConfigTarget = null; }
  _phSettingsTab = tab;
  const agent = (typeof getCurrentAgentRecord === 'function') ? getCurrentAgentRecord() : null;
  if (agent) {
    const presets = getClawModelPresets();
    renderPhSettingsOverlay(agent, presets);
  }
};

const _phSwitchFeatureSubTab = (sub) => {
  if (sub !== 'config' && sub !== 'mounts') return;
  if (sub === 'mounts') _phFeatureConfigTarget = null;
  _phFeatureSubTab = sub;
  const agent = (typeof getCurrentAgentRecord === 'function') ? getCurrentAgentRecord() : null;
  if (agent) {
    const presets = getClawModelPresets();
    renderPhSettingsOverlay(agent, presets);
  }
};

const _phOpenFeatureConfig = (el) => {
  const page = PH_FEATURE_PAGES[_phSettingsTab];
  if (!page) return;
  _phFeatureConfigTarget = { identityKey: page.identityKey, name: el.dataset.name };
  _phSwitchFeatureSubTab('config');
};

// details 的 toggle 不冒泡，分发器必须以 capture 绑定（与 debug-features-hooks
// 各自声明，bindEventType 幂等，不依赖加载顺序）。
window.ClawFW.actions.bindEventType('toggle', { capture: true });

window.ClawFW.actions.registerMany({
  'phSettings.autoSaveModel': () => window.phAutoSaveModelConfig(),
  'phSettings.modelSlotChanged': (el) => window.phModelSlotChanged(el),
  'phSettings.switchTab': (el) => _phSwitchSettingsTab(el.dataset.tab),
  'phSettings.openFeatureStore': (el) => window.phOpenFeatureStore(el.dataset.identity),
  'phSettings.removeMountFeature': (el) => window._fsRemoveFor(el.dataset.identity, el.dataset.name),
  'phSettings.rebuildEnv': () => _phRebuildEnv(),
  'phSettings.setProcessMode': (el) => window.phSetProcessMode(el.dataset.mode),
  'phSettings.setCoderRotationStrategy': (el) => phSetCoderRotationStrategy(el.dataset.mode),
  'phSettings.setCoderRuntimeMode': (el) => phSetCoderRuntimeMode(el.dataset.mode),
  'phSettings.saveCoderThreadLimit': (el) => phSaveCoderThreadLimit(el.value),
  'phSettings.toggleNotifyFinish': (el) => _phToggleNotificationFinish(el.dataset.agent, el.checked),
  'phSettings.switchFeatureSubTab': (el) => _phSwitchFeatureSubTab(el.dataset.sub),
  'phSettings.openFeatureConfig': (el) => _phOpenFeatureConfig(el),
  'phSettings.close': () => window.phCloseSettings(),
});
