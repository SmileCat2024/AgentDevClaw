/**
 * ph-model-config.js — 编程小助手项目设置面板
 *
 * IDE 式布局：左侧分类列表 + 右侧配置区域
 * 分类页：模型配置（含 coder 身份行）、进程模式、Feature 设置
 * （一级：身份入口列表；二级：编程小助手 agent 层 / coder 层配置编辑器）
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

let _phSettingsTab = 'model'; // 'model' | 'process' | 'feature' | 'feature-main' | 'feature-coder'
let _phFeatureSubTab = 'config'; // 身份页内分页器：'config'（Feature 配置）| 'mounts'（挂载管理）
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
  // coder 身份（编程小助手工作空间内 sessionType=coder）的模型配置存
  // agent-configs/coder.json，与主身份分文件；打开面板时单独 fetch 缓存。
  const showCoderRow = window.phModelConfigAgentId === 'programming-helper';
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

  const rows = roles.map(function(role) {
    const roleConfig = role.roleConfig !== undefined ? role.roleConfig : (current[role.key] || {});
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

// ── Feature 设置：身份入口列表 + 二级身份页（分页器）──────────
//
// 一级页只有两个身份入口（心智：身份落点在一级确定）；
// 二级页左上角分页器切换「Feature 配置」与「挂载管理」；
// Feature 仓库选择面板是全局通用弹窗（feature-store.js），由打开处传入身份。
//
// coder 白名单与 coder-agent.js 的挂载清单对齐（有配置 manifest 的部分）：
// shell / memory / skill / lsp / github。coder 不挂 mcp、audio-feedback、
// context-guard（其上下文接力 ContextRotationTriggerFeature 为零配置装配）。
const PH_CODER_INCLUDE_FEATURES = ['shell', 'memory', 'skill', 'lsp', 'github'];

const PH_FEATURE_PAGES = {
  'feature-main': {
    identityKey: 'main',
    scopeId: 'agent',
    subtitleZh: '编程小助手整体的 Feature 配置，对所有项目目录生效；目录级配置可以覆盖',
    subtitleEn: 'Feature config for the whole Programming Helper workspace; per-directory config can override it',
  },
  'feature-coder': {
    identityKey: 'coder',
    scopeId: 'coder',
    scopeAgentId: 'coder',
    includeFeatures: PH_CODER_INCLUDE_FEATURES,
    subtitleZh: 'Coder 自主编码身份的 Feature 配置，仅含其实际挂载的 Feature',
    subtitleEn: 'Feature config for the Coder identity, limited to its mounted features',
  },
};

function _renderFeatureEntryList() {
  const isZh = currentLanguage === 'zh';
  const chevron = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-left:12px;"><path d="m9 18 6-6-6-6"></path></svg>';
  const showCoder = window.phModelConfigAgentId === 'programming-helper';

  const entries = [{
    key: 'feature-main',
    title: isZh ? '配置编程小助手' : 'Configure Programming Helper',
    desc: isZh ? 'Feature 配置与挂载管理，对所有项目目录生效' : 'Feature config and mount management; applies to all project directories',
  }];
  if (showCoder) {
    entries.push({
      key: 'feature-coder',
      title: isZh ? '配置 Coder' : 'Configure Coder',
      desc: isZh ? 'Coder 自主编码身份的 Feature 配置与挂载管理' : 'Feature config and mount management for the Coder identity',
    });
  }

  const cards = entries.map(function(entry) {
    return '<div class="ph-pm-card" onclick="window._phSwitchSettingsTab(\'' + entry.key + '\')">'
      + '<div class="ph-pm-card-body">'
      + '<div class="ph-pm-card-title">' + escapeHtml(entry.title) + '</div>'
      + '<div class="ph-pm-card-desc">' + escapeHtml(entry.desc) + '</div>'
      + '</div>'
      + '<span style="display:flex;align-items:center;color:var(--text-secondary);">' + chevron + '</span>'
      + '</div>';
  }).join('');

  return '<div class="ph-pm-body">' + cards
    + '<div class="ph-pm-intro">' + escapeHtml(isZh
      ? '按身份分别配置 Feature 参数与挂载；Coder 层覆盖同名全局配置项。'
      : 'Configure feature parameters and mounts per identity; the Coder layer overrides global values of the same keys.')
    + '</div>'
    + '</div>';
}

/**
 * 挂载管理视图（二级身份页分页之一）：默认装配 + $mount 扩展统一卡片网格。
 * 组织体系与右侧 Features 面板同源（window.ClawFW.featureCatalog）：
 * type 分组轴（能力/会话与行为/渠道与交互/系统组件）+ 能力下拉筛选；
 * 来源分页器（全部/官方内置/已安装）按装配事实过滤（默认装配 vs $mount），
 * 非 catalog 的静态 provenance 映射——与卡片徽章（默认/扩展）严格一致。
 */
let _phMountSrcFilter = 'all';   // 'all' | 'bundled'（默认装配）| 'installed'（$mount 扩展）
let _phMountCapFilter = 'all';   // catalog 能力词表 id
let _phMountData = null;         // 最近一次拉取的装配数据（筛选切换不重打接口）
const _phMountGroupOpenPref = new Map();

async function _phRenderMountsView(identityKey) {
  const host = document.getElementById('ph-feature-mounts-host');
  if (!host) return;
  try {
    const res = await fetch('/api/feature-store/overview');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || (res.status + ' ' + res.statusText));
    const base = data.base?.[identityKey] || [];
    const mounts = data.mounts?.[identityKey] || {};
    const builtinSurface = new Map(
      (data.builtin || []).map((item) => [item.runtimeName, item.surface]),
    );

    const entries = base.map(function(f) {
      return {
        name: f.name,
        description: f.description || '',
        surface: f.surface || null,
        origin: 'bundled',
      };
    });
    for (const [name, m] of Object.entries(mounts)) {
      entries.push({
        name,
        description: m.missing ? (m.package + '@' + m.version) : '',
        surface: m.kind === 'builtin' ? (builtinSurface.get(name) || null) : null,
        origin: 'installed',
        mount: m,
      });
    }
    _phMountData = { identityKey, entries };
    _phRenderMountsBody(host);
  } catch (err) {
    _phMountData = null;
    host.innerHTML = '<div class="ph-settings-empty" style="padding:32px 0;color:var(--danger,#e5484d);">' + escapeHtml(String(err && err.message ? err.message : err)) + '</div>';
  }
}

/** 纯渲染（数据取 _phMountData 缓存）：筛选切换与 catalog 就绪后的重渲染入口。 */
function _phRenderMountsBody(host) {
  const isZh = currentLanguage === 'zh';
  const fc = window.ClawFW && window.ClawFW.featureCatalog;
  // catalog 未就绪：首帧按 _unmapped 兜底渲染，加载完成后重渲染修正分组
  if (fc && !fc.getFeatureCatalogSnapshot()) {
    fc.loadFeatureCatalog().then(function() {
      if (document.getElementById('ph-feature-mounts-host') === host) _phRenderMountsBody(host);
    }).catch(function() { /* catalog 不可用：保持兜底分组 */ });
  }
  const catalog = fc ? fc.getFeatureCatalogSnapshot() : null;
  const capFilter = fc ? fc.normalizeCapFilter(_phMountCapFilter, catalog) : 'all';

  const entries = _phMountData.entries;
  const srcFiltered = _phMountSrcFilter === 'all'
    ? entries
    : entries.filter(function(e) { return e.origin === _phMountSrcFilter; });
  // enrich 兼容形状：声明面计数喂给运行时能力推导（tools/policy/skills/commands）
  const features = srcFiltered.map(function(e) {
    return {
      name: e.name,
      description: e.description,
      tools: [],
      toolCount: e.surface ? e.surface.tools : 0,
      hookCount: e.surface ? e.surface.hooks : 0,
      skillCount: e.surface ? e.surface.skills : undefined,
      _entry: e,
    };
  });
  // 声明面 commands 信号（surface.commands > 0 的名字集）走 enrich 的
  // 运行时判定路径（commandFeatures.has），能力筛选的 commands 档用真值
  const commandFeatures = new Map();
  for (const e of entries) {
    if (e.surface && e.surface.commands > 0) commandFeatures.set(e.name, e.surface.commands);
  }
  const groups = (fc && catalog)
    ? fc.groupFeaturesByType(features, catalog, 'all', capFilter, { commandFeatures })
    : (features.length ? [{ id: '_unmapped', features }] : []);

  // 来源分页器（面板同款视觉配方）：各档计数按装配事实
  const srcCounts = {
    all: entries.length,
    bundled: entries.filter(function(e) { return e.origin === 'bundled'; }).length,
    installed: entries.filter(function(e) { return e.origin === 'installed'; }).length,
  };
  const srcKeys = { all: 'feature_filter_all', bundled: 'feature_filter_bundled', installed: 'feature_filter_installed' };
  const seg = '<div class="usage-info-segment feature-src-seg" role="tablist">'
    + ['all', 'bundled', 'installed'].map(function(f) {
      return '<button type="button" role="tab" class="' + (f === _phMountSrcFilter ? 'active' : '') + '"'
        + ' onpointerdown="window._phSetMountSrcFilter(\'' + f + '\')"'
        + ' onclick="window._phSetMountSrcFilter(\'' + f + '\')">'
        + escapeHtml(t(srcKeys[f])) + '<span class="feature-src-n">' + String(srcCounts[f]) + '</span></button>';
    }).join('')
    + '</div>';

  const capSelect = (fc && catalog && Array.isArray(catalog.capabilities) && catalog.capabilities.length > 0)
    ? '<select class="feature-cap-select" data-claw-select data-claw-compact="true" data-claw-no-scroll="true"'
      + ' onchange="window._phSetMountCapFilter(this.value)">'
      + ['all'].concat(catalog.capabilities.map(function(c) { return typeof c === 'string' ? c : c.id; }))
        .map(function(id) {
          return '<option value="' + escapeHtml(id) + '"' + (id === capFilter ? ' selected' : '') + '>'
            + escapeHtml(t(id === 'all' ? 'feature_filter_all' : 'feature_cap_' + id)) + '</option>';
        }).join('')
      + '</select>'
    : '';

  const addButton = '<button type="button" class="ph-mount-add" style="margin-left:auto;" onclick="window.phOpenFeatureStore(\'' + escapeHtml(_phMountData.identityKey) + '\')">'
    + escapeHtml(isZh ? '+ 添加 Feature' : '+ Add Feature') + '</button>';

  const buildCard = function(f) {
    const e = f._entry;
    let provHtml = '';
    let badgesHtml = '';
    if (e.origin === 'bundled') {
      provHtml = '<span class="feature-prov-badge">' + escapeHtml(isZh ? '默认' : 'default') + '</span>';
    } else if (e.mount) {
      const removeBtn = '<button type="button" class="fs-list-remove" title="' + escapeHtml(isZh ? '移除' : 'Remove') + '"'
        + ' onclick="window._fsRemoveFor(\'' + escapeHtml(_phMountData.identityKey) + '\', \'' + escapeHtml(f.name) + '\')">&#215;</button>';
      if (e.mount.missing) {
        badgesHtml = '<span class="feature-badge status-removed">' + escapeHtml(isZh ? '包已不在仓库' : 'missing') + '</span>' + removeBtn;
      } else {
        provHtml = '<span class="feature-prov-badge" title="' + escapeHtml(e.mount.package + '@' + e.mount.version) + '">'
          + escapeHtml(isZh ? '扩展' : 'extension') + '</span>';
        badgesHtml = removeBtn;
      }
    }
    const displayName = fc ? fc.resolveDisplayName(f, currentLanguage) : f.name;
    return _phMountCard(f.name, displayName, e.description, provHtml, badgesHtml, _phSurfaceDetail(e.surface));
  };

  // 单一非兜底组时不渲染组头（面板同款）；折叠偏好挂载页自持
  const suppressHeaders = groups.length === 1 && groups[0].id !== '_unmapped';
  const buildGroup = function(group) {
    const grid = '<div class="feature-grid ph-mount-grid">' + group.features.map(buildCard).join('') + '</div>';
    if (suppressHeaders) return grid;
    const isOpen = _phMountGroupOpenPref.has(group.id)
      ? _phMountGroupOpenPref.get(group.id)
      : !(fc && fc.typeCollapsedByDefault(group.id, catalog));
    return '<details class="feature-group"' + (isOpen ? ' open' : '')
      + ' ontoggle="window._phMountGroupToggled(&quot;' + escapeHtml(group.id) + '&quot;, this.open)">'
      + '<summary class="feature-group-bar">'
      + '<span class="feature-group-chev" aria-hidden="true"></span>'
      + '<span class="feature-group-title">' + escapeHtml(t(group.id === '_unmapped' ? 'feature_cat_unmapped' : 'feature_type_' + group.id)) + '</span>'
      + '<span class="feature-group-count">' + String(group.features.length) + '</span>'
      + '</summary>'
      + grid
      + '</details>';
  };

  // 空态：能力筛选受限或非"已安装"视图保持纯文案；"已安装"视图为空时
  // 渲染空态卡片（取「交互页面」空态同款视觉配方：虚线卡片 + 图标块 +
  // 标题 + 描述），添加入口由工具栏按钮承担
  let emptyHtml;
  if (capFilter !== 'all' || _phMountSrcFilter !== 'installed') {
    emptyHtml = '<div class="feature-filter-empty">' + escapeHtml(t(
      capFilter !== 'all' ? 'feature_filter_empty_cap' : 'feature_filter_empty'
    )) + '</div>';
  } else {
    emptyHtml = '<div class="ph-mount-empty-cta">'
      + '<div class="ph-mount-empty-icon" aria-hidden="true">'
      + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">'
      + '<rect x="3" y="3" width="18" height="18" rx="2"></rect>'
      + '<path d="M12 8v8"></path>'
      + '<path d="M8 12h8"></path>'
      + '</svg></div>'
      + '<div class="ph-mount-empty-title">' + escapeHtml(t('feature_filter_empty_installed')) + '</div>'
      + '<div class="ph-mount-empty-desc">' + escapeHtml(isZh
        ? '从 Feature 商店为该身份装配扩展，对新会话生效。'
        : 'Install extensions for this identity from the feature store; takes effect on new sessions.')
      + '</div>'
      + '</div>';
  }
  const groupsHtml = groups.map(buildGroup).join('') || emptyHtml;

  host.innerHTML = '<div class="ph-mounts-body">'
    + '<div class="hooks-section-header feature-panel-head">'
    + seg + capSelect + addButton
    + '</div>'
    + groupsHtml
    + '</div>';
  // select 是 innerHTML 异步渲染后插入的，手动做 ClawSelect 增强
  if (window.ClawSelect) window.ClawSelect.enhanceAll(host);
}

window._phSetMountSrcFilter = function(f) {
  if (['all', 'bundled', 'installed'].indexOf(f) === -1 || f === _phMountSrcFilter) return;
  _phMountSrcFilter = f;
  const host = document.getElementById('ph-feature-mounts-host');
  if (_phMountData && host) _phRenderMountsBody(host);
};

window._phSetMountCapFilter = function(v) {
  if (typeof v !== 'string' || !v || v === _phMountCapFilter) return;
  _phMountCapFilter = v;
  const host = document.getElementById('ph-feature-mounts-host');
  if (_phMountData && host) _phRenderMountsBody(host);
};

window._phMountGroupToggled = function(groupId, open) {
  _phMountGroupOpenPref.set(groupId, open);
};

// 商店写操作后的刷新钩子：当前挂载管理页可见时重拉（feature-store.js 调用）
window._phRefreshMountsView = function() {
  const page = PH_FEATURE_PAGES[_phSettingsTab];
  if (page && _phFeatureSubTab === 'mounts') {
    _phRenderMountsView(page.identityKey);
  }
};

// 关闭弹窗时重置页内细节态（身份落点/二级页签/筛选/分组折叠/数据缓存）。
// 设置弹窗只记忆一级分页（模型配置/进程模式/Feature 设置，_phSettingsTab）。
window._phResetFeaturePageState = function() {
  if (PH_FEATURE_PAGES[_phSettingsTab]) _phSettingsTab = 'feature';
  _phFeatureSubTab = 'config';
  _phMountSrcFilter = 'all';
  _phMountCapFilter = 'all';
  _phMountGroupOpenPref.clear();
  _phMountData = null;
};

/**
 * 声明面数量行：与 Features 面板卡片的 feature-card-detail 同结构。
 * tools 为同步声明面计数（运行时连接的外部工具如 mcp 不在声明面）；
 * surface 为空（仓库包装配，无静态计数）时不渲染。
 */
function _phSurfaceDetail(surface) {
  if (!surface) return '';
  return '<div class="feature-card-detail">'
    + '<span>' + String(surface.hooks) + ' hooks</span>'
    + '<span>' + String(surface.tools) + ' tools</span>'
    + '<span>' + String(surface.skills) + ' skills</span>'
    + '<span>' + String(surface.commands) + ' commands</span>'
    + '</div>';
}
// 商店面板（feature-store.js）共用声明面数量行渲染（跨模块经 CLAWFW 命名空间）
window.ClawFW = window.ClawFW || {};
window.ClawFW.phSurfaceDetail = _phSurfaceDetail;

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

  // ── Feature 设置二级页：按身份进入，页内分页器切换配置/挂载 ──
  const featurePage = PH_FEATURE_PAGES[_phSettingsTab];
  if (featurePage) {
    if (typeof createFeatureConfigEditor !== 'function') {
      _phSettingsTab = 'model';
    } else {
      _closePhFeatureEditor();
      // 返回一级页（head 左侧返回按钮）
      window._phFeatureBack = () => {
        _closePhFeatureEditor();
        _phSettingsTab = 'feature';
        renderPhModelConfigOverlay(agent, presets);
      };

      const identityLabel = featurePage.identityKey === 'coder'
        ? (isZh ? 'Coder' : 'Coder')
        : (isZh ? '编程小助手' : 'Programming Helper');
      const pageName = 'Feature';

      // 页内分页器（左上角）：复用会话列表同款 ph-session-tab 样式
      const subTabs = [
        { key: 'config', label: isZh ? 'Feature 配置' : 'Feature Config' },
        { key: 'mounts', label: isZh ? '挂载管理' : 'Mounts' },
      ];
      const subTabItems = subTabs.map((t) =>
        '<button type="button" class="ph-session-tab' + (_phFeatureSubTab === t.key ? ' active' : '') + '" onclick="window._phSwitchFeatureSubTab(\'' + t.key + '\')">' + escapeHtml(t.label) + '</button>'
      ).join('');

      let bodyHtml;
      if (_phFeatureSubTab === 'mounts') {
        bodyHtml = '<div style="overflow-y:auto;flex:1;" id="ph-feature-mounts-host">'
          + '<div class="ph-settings-empty" style="padding:32px 24px;">...</div>'
          + '</div>';
      } else {
        bodyHtml = '<div class="ph-settings-feature-wrap" id="ph-feature-config-host"></div>';
      }

      host.innerHTML = [
        '<div class="feature-detail-overlay">',
        '<div class="feature-detail-window ph-settings-window">',
        '<div class="feature-detail-head">',
        '<div style="display:flex;align-items:center;gap:4px;">',
        '<button class="feature-detail-close" type="button" title="' + (isZh ? '返回' : 'Back') + '" onclick="window._phFeatureBack()" style="margin-right:8px;font-size:16px;"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"></path><path d="M19 12H5"></path></svg></button>',
        '<div>',
        '<div class="feature-detail-title">' + escapeHtml((isZh ? '工作空间设置 · ' : 'Workspace Settings · ') + identityLabel + ' ' + pageName) + '</div>',
        '<div class="feature-detail-subtitle">' + escapeHtml(_phFeatureSubTab === 'mounts'
          ? (isZh ? '当前身份挂载的全部 Feature：默认装配与扩展，统一管理' : 'All mounted features for this identity: defaults and extensions in one view')
          : (isZh ? featurePage.subtitleZh : featurePage.subtitleEn)) + '</div>',
        '</div>',
        '</div>',
        '<button class="feature-detail-close" type="button" onclick="window.phCloseModelConfig()">&times;</button>',
        '</div>',
        // 行左右 10px + tab 自身 14px 内边距 = 文字与正文 24px 左右缘对齐
        '<div style="display:flex;align-items:flex-end;padding:0 10px;border-bottom:1px solid var(--border-color,#2a2a35);">' + subTabItems + '</div>',
        bodyHtml,
        '</div>',
        '</div>',
      ].join('');

      if (_phFeatureSubTab === 'mounts') {
        _phRenderMountsView(featurePage.identityKey);
      } else {
        _phFeatureEditor = createFeatureConfigEditor({
          host: document.getElementById('ph-feature-config-host'),
          scopeId: featurePage.scopeId,
          ...(featurePage.scopeAgentId ? { scopeAgentId: featurePage.scopeAgentId } : {}),
          ...(featurePage.includeFeatures ? { includeFeatures: featurePage.includeFeatures } : {}),
        });
        _phFeatureEditor.open();
      }
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
  } else if (_phSettingsTab === 'feature') {
    contentHtml = _renderFeatureEntryList();
  } else {
    contentHtml = _renderProcessModeContent(agent);
  }

  const subtitle = _phSettingsTab === 'model'
    ? (isZh ? '为主代理设置主模型和备选模型，其他角色设置单个模型' : 'Set primary and secondary models for main agent, single model for other roles')
    : _phSettingsTab === 'feature'
      ? (isZh ? '选择身份的 Feature 配置层' : 'Choose the feature config layer for an identity')
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
  // 进入身份页时重置页内分页器（身份落点变化，回到默认页）
  if (PH_FEATURE_PAGES[tab]) _phFeatureSubTab = 'config';
  _phSettingsTab = tab;
  const agent = (typeof getCurrentAgentRecord === 'function') ? getCurrentAgentRecord() : null;
  if (agent) {
    const presets = window.ClawFW?._modelPresets || [];
    renderPhModelConfigOverlay(agent, presets);
  }
};

window._phSwitchFeatureSubTab = (sub) => {
  if (sub !== 'config' && sub !== 'mounts') return;
  _phFeatureSubTab = sub;
  const agent = (typeof getCurrentAgentRecord === 'function') ? getCurrentAgentRecord() : null;
  if (agent) {
    const presets = window.ClawFW?._modelPresets || [];
    renderPhModelConfigOverlay(agent, presets);
  }
};
