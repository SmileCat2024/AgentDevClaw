import { escapeHtml } from './markdown-utils.js';
import { getCurrentLanguage } from './i18n-environment-state.js';
import { allAgents } from './agent-store-state.js';
import { getClawModelPresets } from './model-preset-cache.js';
import { createFeatureConfigEditor } from './feature-config-editor.js';
import { phOpenFeatureStore, phCloseFeatureStore, _fsRemoveFor, _fsSetDisabledFeatures, _FS_GEAR_ICON_SVG, _FS_REMOVE_ICON_SVG } from './feature-store.js';
import { registerContainerImagesHost, loadContainerImagesPanel } from './container-images.js';
import { enhanceAll } from './claw-select.js';
import { ClawToast } from './toast-notify.js';
import { getThinkingEffortOptions } from './input-model-switcher.js';
import { getFeatureCreatorProjects } from './project-data.js';
import {
  phCloseSettings,
  phModelSlotChanged,
  phAutoSaveModelConfig,
  phSetProcessMode,
} from './ph-project-actions.js';

/**
 * ph-settings.js — 编程小助手「工作空间设置」面板（UI 标题：工作空间设置）
 *
 * IDE 式布局：左侧分类列表 + 右侧配置区域。
 * 分类页：插件及配置、Coder设置、模型配置、运行环境，以及通知。
 * 插件及配置页内部区分功能配置（装配清单）与参数配置；Coder设置页
 * 另含策略分页（原「Coder 策略」独立页签并入，默认落策略）；运行环境页
 * 含本地运行设置与容器运行设置分页（原「进程模式」「容器镜像」独立页签并入，
 * 默认落本地运行设置）。历史名 ph-model-config：面板早期只有模型选择器，
 * 职责扩张后更名，勿再回用旧名。
 *
 * ESM 化：P2 W2-8（2026-11-17）。原位转换，分页记忆、装配/策略/通知读取与
 * 保存时序零变化（装载相由加载期推迟到模块执行期；本文件无加载期副作用）。
 *
 * 依赖（ESM，装载顺序由 import 图确定）:
 *   - feature-config-editor：createFeatureConfigEditor（参数配置页共享编辑器）
 *   - feature-store：phOpenFeatureStore / _fsRemoveFor（插件仓库入口）
 *   - container-images：registerContainerImagesHost / loadContainerImagesPanel
 *   - claw-select：enhanceAll（自绘下拉增强，幂等）
 *   - input-model-switcher：getThinkingEffortOptions（思考档位表）
 *   - project-data：getFeatureCreatorProjects（process mode 记忆键来源）
 *   - agent-store-state：allAgents（live binding）；model-preset-cache：getClawModelPresets
 *   - i18n-environment-state：实时语言；markdown-utils：escapeHtml
 *
 * 仍 classic / 命名空间协议（window 晚绑定）:
 *   - app-main：getCurrentAgentRecord（编排域，P3 收敛）
 *   - ClawFW._coderModelPresets（ph-project-actions 写入的 coder 预置缓存；写方属
 *     工作区动作域，本模块只读，改 import 需先由写方提供命名面）
 *
 * 与 ph-project-actions 的静态环（双向直接 import，见文件顶部 import 段）：
 *   本模块取它的 phCloseSettings / phModelSlotChanged / phAutoSaveModelConfig /
 *   phSetProcessMode，它取本模块的 renderPhSettingsOverlay / _phResetFeaturePageState
 *   等。环内两侧都只在函数体内调用对端绑定，任何一侧的顶层都不解引用对方，
 *   因此装载期无 TDZ 风险；真实整图由 p2-w2-8-project-domain 用例执行。
 *
 * 本模块持有面板身份（原 window.phSettingsAgentId）：ph-project-actions 经
 * getPhSettingsAgentId / setPhSettingsAgentId 读写，全仓无其它消费方。
 *
 * 入口：ph-project-actions 的「设置」动作 → renderPhSettingsOverlay()；面板内交互
 * 经 data-action="phSettings.*" 分发（action-dispatcher.js），处理器收敛在本模块局部。
 */
let phSettingsAgentId = '';
// 打开面板时记录当前项目（原 window._phCurrentProject）：全仓无读取方，
// 只写不读的历史状态，保持模块私有；后续清理时可直接删除。
let _phCurrentProject = null;

/** 设置面板身份（唯一持有方；ph-project-actions 经这两个导出读写）。 */
export function getPhSettingsAgentId() {
  return phSettingsAgentId;
}
export function setPhSettingsAgentId(value) {
  phSettingsAgentId = value;
}

let _phSettingsTab = 'model'; // 'model' | 'runtime' | 'feature' | 'coder'
let _phFeatureSubTab = 'mounts'; // 当前身份页的视图：策略（仅 coder）| 装配清单 | 参数配置
let _phRuntimeSubTab = 'local'; // 运行环境页视图：本地运行设置 | 容器运行设置
let _phFeatureEditor = null;
let _phFeatureConfigTarget = null;

export function _closePhFeatureEditor() {
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
  const isZh = getCurrentLanguage() === 'zh';
  const current = agent.modelPresets || {};
  // coder APP（独立工作空间，ADR-0025）的模型配置存 agent-configs/coder.json，
  // 与主 APP 分文件；编程小助手面板代管展示，打开时单独 fetch 缓存。
  const showCoderRow = getPhSettingsAgentId() === 'programming-helper';
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
    const options = getThinkingEffortOptions(protocol);
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
    // 页内含「策略」分页（原 Coder 策略一级页签并入）；进入默认落策略
    policy: true,
    defaultSubTab: 'policy',
    subtitleZh: '管理 Coder 智能体的运行策略、插件装配与能力参数',
    subtitleEn: 'Manage the Coder agent: runtime policy, plugin assembly and capability settings',
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
  host.innerHTML = '<div class="ph-settings-empty">' + escapeHtml(getCurrentLanguage() === 'zh' ? '正在读取装配…' : 'Loading assembly…') + '</div>';
  try {
    const res = await fetch('/api/feature-store/overview');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || (res.status + ' ' + res.statusText));
    const mounts = data.mounts?.[identityKey] || {};
    const baseFeatures = data.base?.[identityKey] || [];
    const builtinByName = new Map((data.builtin || []).map((item) => [item.runtimeName, item]));
    // 仓库包的展示名与描述（货架同源）。身份页 identityKey → agentId：
    // main 是 programming-helper 的历史兼容键（与商店 _FS_IDENTITY_SCOPES 同口径）
    const scopeAgentId = PH_FEATURE_PAGES[identityKey]?.scopeAgentId
      || (identityKey === 'main' ? 'programming-helper' : identityKey);
    const packageByName = new Map();
    for (const pkg of (data.packages || [])) {
      // 空间私有包只对该空间展示；同包全局与私有并存时私有优先（后写覆盖）
      if (pkg.scopeAgentId && pkg.scopeAgentId !== scopeAgentId) continue;
      packageByName.set(String(pkg.package || '').replace(/^@[^/]+\//, ''), pkg);
    }
    const entriesByName = new Map();
    for (const item of baseFeatures) {
      entriesByName.set(item.name, {
        name: item.name,
        displayName: item.displayName || item.name,
        description: item.description || '',
        surface: item.surface || null,
        origin: 'official',
        mount: mounts[item.name] || null,
      });
    }
    for (const [name, mount] of Object.entries(mounts)) {
      const builtin = builtinByName.get(name);
      const pkg = mount.kind === 'repository' ? packageByName.get(name) : null;
      // 仓库包的描述取 manifest 摘要；缺失（包已不在仓库）时退回包坐标
      const description = mount.missing
        ? (mount.package + '@' + mount.version)
        : (mount.kind === 'builtin' ? (builtin?.description || '') : (pkg?.description || ''));
      entriesByName.set(name, {
        name,
        displayName: mount.kind === 'builtin'
          ? (builtin?.title || name)
          : (pkg?.displayName || name),
        description,
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

/** 功能配置分页 banner：复用模型设置连接卡配方（settings-connection-card），
 *  承载「+ 添加插件」入口与页面说明。banner 是分页器上方的页面级元素，
 *  与策略分页同位置渲染（见 _phCoderPolicyBannerHtml）。 */
function _phMountBannerHtml(identityKey) {
  const isZh = getCurrentLanguage() === 'zh';
  return '<div class="settings-connection-card ph-feature-banner">'
    + '<div class="settings-connection-row">'
    + '<div>'
    + '<div class="settings-connection-title">' + (isZh ? '插件与内置能力' : 'Plugins & Built-in Capabilities') + '</div>'
    + '<div class="settings-connection-description">' + escapeHtml(isZh
      ? '插件来自全局库存或本空间私有仓库，可按包装配、禁用、卸载；内置能力随产品提供。'
      : 'Plugins come from the global stock or this workspace\'s private repository — assemble, disable or remove per package; built-in capabilities ship with the product.') + '</div>'
    + '</div>'
    + '<button type="button" class="settings-btn settings-btn-secondary" data-action="phSettings.openFeatureStore" data-identity="' + escapeHtml(identityKey) + '">'
    + escapeHtml(isZh ? '+ 添加插件' : '+ Add Plugins') + '</button>'
    + '</div>'
    + '</div>';
}

/** 策略分页 banner：与功能配置分页同位置同形态的页头说明（无操作按钮），
 *  分页切换时 banner 不跳出/消失。 */
function _phCoderPolicyBannerHtml() {
  const isZh = getCurrentLanguage() === 'zh';
  return '<div class="settings-connection-card ph-feature-banner">'
    + '<div class="settings-connection-row">'
    + '<div>'
    + '<div class="settings-connection-title">' + (isZh ? 'Coder 运行策略' : 'Coder Runtime Policy') + '</div>'
    + '<div class="settings-connection-description">' + escapeHtml(isZh
      ? '配置 Coder 智能体的线程并发上限、任务运行模式与上下文接续策略。'
      : 'Configure Coder\'s thread concurrency limit, task execution mode, and context rotation strategy.') + '</div>'
    + '</div>'
    + '</div>'
    + '</div>';
}

/** 纯渲染（数据取 _phMountData 缓存）：筛选切换与 catalog 就绪后的重渲染入口。 */
function _phRenderMountsBody(host) {
  const isZh = getCurrentLanguage() === 'zh';
  const entries = _phMountData.entries;
  const features = entries.map(function(e) {
    return { name: e.name, description: e.description, _entry: e };
  });

  const buildCard = function(f) {
    const e = f._entry;
    const mount = e.mount;
    const isOfficial = e.origin === 'official';
    const provenance = isOfficial
      ? '<span class="feature-prov-badge">' + escapeHtml(isZh ? '官方' : 'Official') + '</span>'
      : '<span class="feature-prov-badge" title="' + escapeHtml((mount?.package || '') + '@' + (mount?.version || '')) + '">'
        + escapeHtml(isZh ? '扩展' : 'Extension') + '</span>';
    const configBtn = '<button type="button" class="settings-icon-btn" title="' + escapeHtml(isZh ? '配置参数' : 'Configure') + '"'
      + ' data-action="phSettings.openFeatureConfig" data-name="' + escapeHtml(f.name) + '">' + _FS_GEAR_ICON_SVG + '</button>';
    const removeBtn = mount
      ? '<button type="button" class="settings-icon-btn danger" title="' + escapeHtml(isZh ? '移除插件' : 'Remove plugin') + '"'
        + ' data-action="phSettings.removeMountFeature" data-identity="' + escapeHtml(_phMountData.identityKey) + '" data-name="' + escapeHtml(f.name) + '">' + _FS_REMOVE_ICON_SVG + '</button>'
      : '';
    const missing = mount?.missing
      ? '<span class="feature-badge status-removed">' + escapeHtml(isZh ? '包已不在仓库' : 'Missing package') + '</span>'
      : '';
    // 多 feature 包：卡片下方列出各 feature，可逐个启用/禁用（包本身仍装配）
    const featureList = (() => {
      const list = Array.isArray(mount?.features) ? mount.features : [];
      if (!list.length) return '';
      const chips = list.map((item) => '<button type="button" class="ph-mount-feature-chip'
        + (item.disabled ? ' is-disabled' : '') + '"'
        + ' data-action="phSettings.toggleMountFeature"'
        + ' data-identity="' + escapeHtml(_phMountData.identityKey) + '"'
        + ' data-mount="' + escapeHtml(f.name) + '"'
        + ' data-feature="' + escapeHtml(item.name) + '"'
        + ' title="' + escapeHtml(item.disabled
          ? (isZh ? '已禁用，点击启用（下次会话生效）' : 'Disabled; click to enable (next session)')
          : (isZh ? '已启用，点击禁用（下次会话生效）' : 'Enabled; click to disable (next session)')) + '">'
        + escapeHtml(item.name) + (item.disabled ? (isZh ? ' · 已禁用' : ' · disabled') : '') + '</button>').join('');
      return '<div class="ph-mount-features">' + chips + '</div>';
    })();
    // 参数序：name / displayName / description / 来源徽章 / 动作徽章 / 详情
    return _phMountCard(f.name, e.displayName || f.name, e.description || '', provenance, missing + configBtn + removeBtn, featureList);
  };

  // 分层：可处置插件（builtin 可选 + tgz 仓库包）/ 内置能力（agent.js 静态
  // 装配的产品本体，随宿主升级，不参与插件的装/卸/禁用）。
  const isPluginEntry = (entry) => Boolean(entry.mount
    && (entry.mount.kind === 'builtin' || entry.mount.kind === 'repository'));
  const pluginFeatures = features.filter((feature) => isPluginEntry(feature._entry));
  const builtinFeatures = features.filter((feature) => !isPluginEntry(feature._entry));

  const renderSection = (dotClass, title, list, emptyText) =>
    '<section class="fs-status-section"><div class="fs-status-section-head">'
    + '<span class="fs-status-dot ' + dotClass + '"></span>'
    + escapeHtml(title) + '<span class="fs-tab-count">' + list.length + '</span>'
    + '</div>'
    + (list.length
      ? '<div class="ph-mount-list">' + list.map(buildCard).join('') + '</div>'
      : '<div class="ph-mount-empty-cta"><div class="ph-mount-empty-desc">' + escapeHtml(emptyText) + '</div></div>')
    + '</section>';

  host.innerHTML = '<div class="ph-mounts-body">'
    + _phEnvNoticeHtml()
    + renderSection(
      'fs-status-dot-installed',
      isZh ? '插件' : 'Plugins',
      pluginFeatures,
      isZh ? '尚未装配插件，点击上方「+ 添加插件」。' : 'No plugins assembled yet; use “+ Add Plugins” above.',
    )
    + renderSection(
      'fs-status-dot-not-installed',
      isZh ? '内置能力' : 'Built-in Capabilities',
      builtinFeatures,
      isZh ? '没有内置能力。' : 'No built-in capabilities.',
    )
    + '</div>';
}

/** 多 feature 包的 feature 级启用/禁用：改 $mount.disabledFeatures（包仍装配）。 */
const _phToggleMountFeature = async function(identity, mountRuntimeName, featureName) {
  if (!identity || !mountRuntimeName || !featureName) return;
  const entry = (_phMountData?.entries || []).find((item) => item.name === mountRuntimeName);
  const features = Array.isArray(entry?.mount?.features) ? entry.mount.features : [];
  const current = features.filter((item) => item.disabled).map((item) => item.name);
  const next = current.includes(featureName)
    ? current.filter((name) => name !== featureName)
    : [...current, featureName];
  try {
    await _fsSetDisabledFeatures(identity, mountRuntimeName, next);
    await _phRenderMountsView(identity);
  } catch (err) {
    window.alert((getCurrentLanguage() === 'zh' ? '切换失败：' : 'Toggle failed: ') + (err?.message || err));
  }
};

let _phRebuildBusy = false;

/** 环境缺失轻警告（Q3=C：可点击立即恢复；下次启动自愈兜底保留）。 */
function _phEnvNoticeHtml() {
  const isZh = getCurrentLanguage() === 'zh';
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
export const _phRefreshMountsView = (identityKey) => {
  const page = PH_FEATURE_PAGES[_phSettingsTab];
  if (page && page.identityKey === (identityKey || page.identityKey) && _phFeatureSubTab === 'mounts') {
    _phRenderMountsView(page.identityKey);
  }
};

// 关闭弹窗时清理本页的临时数据；设置弹窗记忆当前一级页签。
export const _phResetFeaturePageState = () => {
  _phMountData = null;
  _phFeatureSubTab = PH_FEATURE_PAGES[_phSettingsTab]?.defaultSubTab || 'mounts';
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
  const isZh = getCurrentLanguage() === 'zh';
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

// ── Coder 策略（Coder设置页「策略」分页）：关联工作空间配置面 ────

async function _phLoadCoderPolicy() {
  const host = document.getElementById('ph-coder-policy-host');
  if (!host) return;
  const isZh = getCurrentLanguage() === 'zh';
  try {
    const response = await fetch('/protoclaw/workspace_settings');
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    if (!document.getElementById('ph-coder-policy-host') || _phSettingsTab !== 'coder' || _phFeatureSubTab !== 'policy') return;
    const limit = data?.resourcePolicy?.coder?.maxLiveThreads;
    const value = Number.isInteger(limit) && limit > 0 ? String(limit) : '';
    const live = Number.isInteger(data?.liveRuntimes?.coder) ? data.liveRuntimes.coder : 0;
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
        ? 'Coder 同时运行的 runtime 数量上限，超出时才拒绝拉起新的 runtime（共享 runtime 承载的新线程不占新名额）'
        : 'Maximum concurrently running Coder runtime processes; only a new runtime spawn is rejected at the limit (threads joining an existing runtime do not consume another slot)') + '</div>',
      (live > 0 ? '<div class="ph-mc-role-desc">' + (isZh ? '当前 ' + live + ' 个运行中 runtime' : live + ' running runtimes') + '</div>' : ''),
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
          ? '默认。先精简并保留最近五批工具调用（同批调用及其结果一起留）；压缩不足时逐级升级——仍超 40% 追加摘要，超 80% 只保留摘要。'
          : 'Default. Trim first, keeping the last five tool-call batches (all calls in a batch and their results); escalate only when compression falls short: above 40% appends a summary, above 80% keeps the summary only.'),
      optionCard('trim', strategy === 'trim',
        isZh ? '精简优先' : 'Trim first',
        isZh
          ? '折叠工具活动，保留对话文本与最近五批工具调用（含配对结果）；不生成摘要，无额外模型开销。'
          : 'Fold tool activity, keep dialogue plus the last five tool-call batches (with paired results). No summary, no extra LLM cost.'),
      optionCard('summary', strategy === 'summary',
        isZh ? '摘要优先' : 'Summary first',
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
  const isZh = getCurrentLanguage() === 'zh';
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
  const isZh = getCurrentLanguage() === 'zh';
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
  const isZh = getCurrentLanguage() === 'zh';
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

// ── 通知：编程小助手系统通知的集中配置（ADR-0030 editingSurface）───

// 场景组（信息层级：APP 分区 → 场景（显式启用开关）→ 子场景三元模式）。
// 文案分工：场景层说「什么时候提醒」，子项层只说「怎么提醒」——单子项
// 场景不重复场景语义。开关是派生态（组内任一子项生效值非 off 即启用），
// 不新增存储字段：关闭 = 子项全写 'off'，开启 = 写 enabledDefaults 建议
// 档（与作者默认同值；coder 作者默认整体 off，开启动作即越过它写
// persistent）。声明制渲染：场景仅在目标 agent 在册（source prebuilt）
// 且声明对应权限项时出现。生效值判定链与 server 同源：用户覆盖
// （resourcePolicy）> 作者默认（permissionDefaults）> 'off'；历史布尔
// 就地归一（true→auto、false→off）；PH 任务完成存在存量单键覆盖时，三
// 子键未逐项覆盖则回落单键值（与 server 判定链回落同语义）。写入 PUT
// /protoclaw/workspace_settings/resource_policy（与全局「工作空间设置」
// 的只读审计是同一份数据）。
const PH_NOTIFY_MODES = ['off', 'auto', 'persistent'];
const PH_NOTIFY_APP_SECTIONS = [
  {
    agentId: 'programming-helper',
    nameZh: '编程小助手', nameEn: 'Programming Helper',
    scenes: [
      {
        nameZh: '任务完成时', nameEn: 'Task finished',
        descZh: '运行结束后提醒你',
        descEn: 'Notify me when a run ends',
        legacyFallbackPermissionId: 'notifications.finish',
        enabledDefaults: {
          'notifications.finish.focused': 'off',
          'notifications.finish.elsewhere': 'auto',
          'notifications.finish.background': 'persistent',
        },
        items: [
          {
            permissionId: 'notifications.finish.focused',
            nameZh: '在当前对话', nameEn: 'In this chat',
            descZh: '结果已经可见', descEn: 'Result already on screen',
          },
          {
            permissionId: 'notifications.finish.elsewhere',
            nameZh: '在别的对话或页面', nameEn: 'In other chats or pages',
            descZh: 'Claw 在前台', descEn: 'Claw in foreground',
          },
          {
            permissionId: 'notifications.finish.background',
            nameZh: 'Claw 在后台', nameEn: 'Claw in background',
            descZh: '最小化或切到其他应用', descEn: 'Minimized or switched away',
          },
        ],
      },
      {
        nameZh: '需要你决策时', nameEn: 'Decision needed',
        descZh: '出现选择题、等待你选择时',
        descEn: 'When a choice is waiting for you',
        enabledDefaults: { 'notifications.input': 'persistent' },
        items: [
          {
            permissionId: 'notifications.input',
            nameZh: '提醒方式', nameEn: 'How to notify',
          },
        ],
      },
    ],
  },
  {
    agentId: 'coder',
    nameZh: 'Coder', nameEn: 'Coder',
    scenes: [
      {
        nameZh: '任务完成时', nameEn: 'Task finished',
        descZh: '线程轮次完成或失败时',
        descEn: 'When a thread turn completes or fails',
        enabledDefaults: { 'notifications.finish': 'persistent' },
        items: [
          {
            permissionId: 'notifications.finish',
            nameZh: '提醒方式', nameEn: 'How to notify',
          },
        ],
      },
    ],
  },
];

// 下拉选项文案：三档名词短语，语义靠场景语境，不带解释后缀
const _phNotifyModeOptionLabel = (mode, isZh) => ({
  off: isZh ? '不通知' : 'Off',
  auto: isZh ? '短通知' : 'Brief',
  persistent: isZh ? '常驻通知' : 'Persistent',
}[mode] || mode);

/** 历史布尔 → 模式归一（与 server 判定链同语义）；非法值视为未配置。 */
function _phNormalizeNotifyMode(value) {
  if (value === true) return 'auto';
  if (value === false) return 'off';
  return PH_NOTIFY_MODES.includes(value) ? value : null;
}

function _phNotifySceneOptions(effective, isZh) {
  return PH_NOTIFY_MODES.map((mode) => '<option value="' + mode + '"'
    + (mode === effective ? ' selected' : '') + '>'
    + escapeHtml(_phNotifyModeOptionLabel(mode, isZh)) + '</option>').join('');
}

async function _phLoadNotificationSettings() {
  const host = document.getElementById('ph-notification-host');
  if (!host) return;
  const isZh = getCurrentLanguage() === 'zh';
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
  const agentOf = (agentId) => agents.find((a) => a.id === agentId && a.source === 'prebuilt');
  // 生效值与 server 判定链同源：子键用户覆盖 > 子键作者默认 > 'off'；
  // 焦点细分组三子键均无用户覆盖时，回落存量单键覆盖（旧值复制三键）
  const effectiveModeOf = (scene, agent, userPolicy, item) => {
    const defaults = agent?.permissionDefaults && typeof agent.permissionDefaults === 'object' ? agent.permissionDefaults : {};
    let effective = _phNormalizeNotifyMode(userPolicy[item.permissionId])
      || _phNormalizeNotifyMode(defaults[item.permissionId]) || 'off';
    if (scene.legacyFallbackPermissionId) {
      const legacyUser = _phNormalizeNotifyMode(userPolicy[scene.legacyFallbackPermissionId]);
      const hasOverride = scene.items.some((it) => _phNormalizeNotifyMode(userPolicy[it.permissionId]) !== null);
      if (legacyUser && !hasOverride) effective = legacyUser;
    }
    return effective;
  };
  const sections = PH_NOTIFY_APP_SECTIONS
    .map((section) => {
      const agent = agentOf(section.agentId);
      if (!agent || !Array.isArray(agent.permissions)) return null;
      const userPolicy = resourcePolicy[section.agentId] || {};
      const scenes = section.scenes
        .map((scene) => {
          const items = scene.items.filter((item) => agent.permissions.includes(item.permissionId));
          return items.length > 0 ? { scene, items } : null;
        })
        .filter(Boolean);
      return scenes.length > 0 ? { section, agent, userPolicy, scenes } : null;
    })
    .filter(Boolean);
  if (sections.length === 0) {
    host.innerHTML = '<div class="ph-settings-empty">' + escapeHtml(isZh ? '暂无可配置的通知项。' : 'No notifications to configure.') + '</div>';
    return;
  }
  const html = sections.map(({ section, agent, userPolicy, scenes }) => {
    const sceneRows = scenes.map(({ scene, items }) => {
      // 开关派生态：组内任一子项生效值非 off。场景关闭时子配置不渲染
      const enabled = items.some((item) => effectiveModeOf(scene, agent, userPolicy, item) !== 'off');
      const sceneIdx = section.scenes.indexOf(scene);
      const head = [
        '<div class="ph-mc-row' + (enabled ? ' ph-notify-scene-row' : '') + '">',
        '<div class="ph-mc-role">',
        '<div class="ph-mc-role-name">' + escapeHtml(isZh ? scene.nameZh : scene.nameEn) + '</div>',
        '<div class="ph-mc-role-desc">' + escapeHtml(isZh ? scene.descZh : scene.descEn) + '</div>',
        '</div>',
        '<div class="ph-mc-single ph-notify-scene-toggle">',
        '<label class="proxy-switch" title="' + escapeHtml(isZh ? '启用/关闭这一场景' : 'Enable/disable this scene') + '">',
        '<input type="checkbox"' + (enabled ? ' checked' : '')
        + ' data-action="phSettings.setNotifySceneEnabled" data-event="change"'
        + ' data-args=\'[' + JSON.stringify(section.agentId) + ', ' + sceneIdx + ']\' />',
        '<span class="proxy-switch-slider"></span>',
        '</label>',
        '</div>',
        '</div>',
      ].join('');
      const subrows = enabled ? [
        '<div class="ph-notify-subrows">',
        ...items.map((item) => {
          const effective = effectiveModeOf(scene, agent, userPolicy, item);
          const desc = isZh ? item.descZh : item.descEn;
          return [
            '<div class="ph-mc-row">',
            '<div class="ph-mc-role">',
            '<div class="ph-mc-role-name">' + escapeHtml(isZh ? item.nameZh : item.nameEn) + '</div>',
            ...(desc ? ['<div class="ph-mc-role-desc">' + escapeHtml(desc) + '</div>'] : []),
            '</div>',
            '<div class="ph-mc-single">',
            '<div class="ph-mc-pickers">',
            '<select class="ph-mc-select" data-claw-select'
            + ' data-action="phSettings.setNotifySceneMode" data-event="change"'
            + ' data-agent="' + escapeHtml(section.agentId) + '" data-permission="' + escapeHtml(item.permissionId) + '">'
            + _phNotifySceneOptions(effective, isZh),
            '</select>',
            '</div>',
            '</div>',
            '</div>',
          ].join('');
        }),
        '</div>',
      ].join('') : '';
      return head + subrows;
    }).join('');
    return [
      '<div class="settings-section">',
      '<div class="settings-section-title">' + escapeHtml(isZh ? section.nameZh : section.nameEn) + '</div>',
      '<div class="ph-mc-list" style="border-top:1px solid var(--border-color);">',
      sceneRows,
      '</div>',
      '</div>',
    ].join('');
  }).join('');
  host.innerHTML = [
    '<div class="ph-notify-root">',
    html,
    '</div>',
    '<div id="ph-notification-status" style="margin:0 24px;"></div>',
  ].join('');
  // 下拉在 innerHTML 后插入，这里手动做增强（renderPhSettingsOverlay 的
  // enhanceAll 走 rAF，可能先于本次异步渲染执行）
  enhanceAll(host);
}

/** 写单个场景的呈现模式；失败抛错由调用方呈现状态。 */
async function _phWriteNotifySceneMode(agentId, permissionId, value) {
  const response = await fetch('/protoclaw/workspace_settings/resource_policy', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, permissionId, value }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data?.error || 'HTTP ' + response.status);
  }
}

const _phSetNotifySceneMode = async function(agentId, permissionId, mode) {
  if (!PH_NOTIFY_MODES.includes(mode)) return;
  const isZh = getCurrentLanguage() === 'zh';
  const status = document.getElementById('ph-notification-status');
  const setStatus = (message) => { if (status) status.textContent = message; };
  try {
    await _phWriteNotifySceneMode(agentId, permissionId, mode);
    setStatus(isZh ? '已保存' : 'Saved');
  } catch (error) {
    setStatus((isZh ? '保存失败：' : 'Save failed: ') + (error?.message || error));
  }
  // 重取渲染：成功时与服务器态收敛一致，失败时选择回滚到服务器真值
  await _phLoadNotificationSettings();
};

/** 场景级启用/关闭（派生开关写穿到子项）：关 = 子项全写 'off'；开 = 写
 *  场景建议档（enabledDefaults，PH 任务完成 = 关/短/持久的作者默认组合）。
 *  串行 PUT，任一失败中断并整体回读服务器真值（部分写入会被回读覆盖提示，
 *  用户可重试）。 */
const _phSetNotifySceneEnabled = async function(agentId, sceneIdx, checked) {
  const isZh = getCurrentLanguage() === 'zh';
  const status = document.getElementById('ph-notification-status');
  const setStatus = (message) => { if (status) status.textContent = message; };
  const section = PH_NOTIFY_APP_SECTIONS.find((s) => s.agentId === agentId);
  const scene = section?.scenes[Number(sceneIdx)];
  if (!scene) return;
  try {
    for (const item of scene.items) {
      const value = checked ? (scene.enabledDefaults?.[item.permissionId] || 'auto') : 'off';
      await _phWriteNotifySceneMode(agentId, item.permissionId, value);
    }
    setStatus(isZh ? '已保存' : 'Saved');
  } catch (error) {
    setStatus((isZh ? '保存失败：' : 'Save failed: ') + (error?.message || error));
  }
  await _phLoadNotificationSettings();
};

// ── Main panel render ─────────────────────────────────────────

export function renderPhSettingsOverlay(agent, presets, { initialTab } = {}) {
  if (initialTab && (initialTab === 'model' || initialTab === 'feature' || initialTab === 'coder')) {
    _phSettingsTab = initialTab;
    if (PH_FEATURE_PAGES[initialTab]) {
      _phFeatureSubTab = PH_FEATURE_PAGES[initialTab].defaultSubTab || 'mounts';
      _phFeatureConfigTarget = null;
    }
  }
  const host = ensurePhSettingsHost();
  if (!agent) { host.innerHTML = ''; _closePhFeatureEditor(); return; }
  // 旧版「Coder 策略」独立页签的记忆值归一到 Coder设置页的策略分页
  if (_phSettingsTab === 'coder-policy') {
    _phSettingsTab = 'coder';
    _phFeatureSubTab = 'policy';
  }
  // 旧版「进程模式」「容器镜像」独立页签的记忆值归一到运行环境页对应分页
  if (_phSettingsTab === 'process') {
    _phSettingsTab = 'runtime';
    _phRuntimeSubTab = 'local';
  }
  if (_phSettingsTab === 'container-images') {
    _phSettingsTab = 'runtime';
    _phRuntimeSubTab = 'container';
  }
  if (_phSettingsTab === 'notification' && getPhSettingsAgentId() !== 'programming-helper') {
    _phSettingsTab = 'model';
  }
  // 容器运行设置分页仅编程小助手域可见；他域记忆值回退本地运行设置
  if (_phSettingsTab === 'runtime' && _phRuntimeSubTab === 'container' && getPhSettingsAgentId() !== 'programming-helper') {
    _phRuntimeSubTab = 'local';
  }
  const isZh = getCurrentLanguage() === 'zh';

  // Store current project for process mode key
  const projects = getFeatureCreatorProjects(agent);
  _phCurrentProject = projects.find(p => p.openDirectory === agent?.workspace_state?.openDirectory) || projects[0] || null;

  const featurePage = PH_FEATURE_PAGES[_phSettingsTab];
  _closePhFeatureEditor();

  const tabs = [
    ...(getPhSettingsAgentId() === 'programming-helper' ? [
      { key: 'feature', label: isZh ? '插件及配置' : 'Plugins & Config', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/></svg>' },
      { key: 'coder', label: isZh ? 'Coder设置' : 'Coder Settings', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 4l-4 16"/></svg>' },
    ] : []),
    { key: 'model', label: isZh ? '模型配置' : 'Model Config', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>' },
    { key: 'runtime', label: isZh ? '运行环境' : 'Runtime Environment', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>' },
    ...(getPhSettingsAgentId() === 'programming-helper' ? [{
      key: 'notification',
      label: isZh ? '通知' : 'Notifications',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
    }] : []),
  ];

  const tabItems = tabs.map(t => {
    const active = _phSettingsTab === t.key;
    return '<div class="ph-settings-tab' + (active ? ' active' : '') + '" data-action="phSettings.switchTab" data-tab="' + escapeHtml(t.key) + '">'
      + '<span class="ph-settings-tab-icon">' + t.icon + '</span>'
      + '<span class="ph-settings-tab-label">' + escapeHtml(t.label) + '</span>'
      + '</div>';
  }).join('');

  // 参数配置是独立子页（整页替换），不是页内分页器的一块显示区：
  // 这样参数编辑区拿到整个窗口宽度，返回按钮回到本页的「功能配置」。
  const isConfigSubPage = !!featurePage && _phFeatureSubTab === 'config';

  let contentHtml;
  if (_phSettingsTab === 'model') {
    contentHtml = _renderModelConfigContent(agent, presets);
  } else if (isConfigSubPage) {
    contentHtml = '<div class="ph-settings-feature-page" data-identity="' + escapeHtml(featurePage.identityKey) + '">'
      + '<div class="ph-settings-feature-wrap" id="ph-feature-config-host"></div>'
      + '</div>';
  } else if (featurePage) {
    const identityKey = featurePage.identityKey;
    const featureSubTabs = [
      ...(featurePage.policy ? [{ key: 'policy', label: isZh ? '策略' : 'Policy' }] : []),
      { key: 'mounts', label: isZh ? '功能配置' : 'Features' },
      { key: 'config', label: isZh ? '参数配置' : 'Parameters' },
    ].map((item) => '<button type="button" class="ph-session-tab' + (_phFeatureSubTab === item.key ? ' active' : '')
      + '" data-action="phSettings.switchFeatureSubTab" data-sub="' + item.key + '">' + item.label + '</button>').join('');
    const bodyHtml = _phFeatureSubTab === 'policy'
      // 策略分页与装配分页共用滚动容器契约；行式内容仍走 ph-mc-list
      ? '<div class="ph-settings-feature-mounts" id="ph-coder-policy-host"><div class="ph-settings-empty">'
        + escapeHtml(isZh ? '正在读取 Coder 策略…' : 'Loading Coder policy…') + '</div></div>'
      : '<div class="ph-settings-feature-mounts" id="ph-feature-mounts-host"><div class="ph-settings-empty">'
        + escapeHtml(isZh ? '正在读取装配…' : 'Loading assembly…') + '</div></div>';
    contentHtml = '<div class="ph-settings-feature-page" data-identity="' + escapeHtml(identityKey) + '">'
      // banner 是分页器上方的页面级元素：策略/功能配置两分页同位置渲染，
      // 切页不跳出；功能配置承载「+ 添加插件」，策略为页头说明
      + (_phFeatureSubTab === 'policy' ? _phCoderPolicyBannerHtml() : _phMountBannerHtml(identityKey))
      + '<div class="ph-settings-feature-tabs">' + featureSubTabs + '</div>'
      + bodyHtml
      + '</div>';
  } else if (_phSettingsTab === 'notification') {
    contentHtml = '<div class="ph-mc-list" id="ph-notification-host">'
      + '<div class="ph-settings-empty">' + escapeHtml(isZh ? '正在读取通知设置…' : 'Loading notifications…') + '</div>'
      + '</div>';
  } else if (_phSettingsTab === 'runtime') {
    // 运行环境页：本地运行设置（原进程模式页）/ 容器运行设置（原容器镜像页）
    // 两分页内容原样平移；容器分页对非编程小助手域不显示。
    const runtimeSubTabs = [
      { key: 'local', label: isZh ? '本地运行设置' : 'Local Runtime' },
      ...(getPhSettingsAgentId() === 'programming-helper'
        ? [{ key: 'container', label: isZh ? '容器运行设置' : 'Container Runtime' }] : []),
    ].map((item) => '<button type="button" class="ph-session-tab' + (_phRuntimeSubTab === item.key ? ' active' : '')
      + '" data-action="phSettings.switchRuntimeSubTab" data-sub="' + item.key + '">' + item.label + '</button>').join('');
    const runtimeBody = _phRuntimeSubTab === 'container'
      // 观测页：环境状态卡与镜像/容器列表用页级容器（分区间距 16、内容缘 24）；
      // mounts 只提供滚动，自身无 padding，不与 ci-page 双重缘距
      ? '<div class="ph-settings-feature-mounts"><div class="ci-page" id="ph-container-images-host">'
        + '<div class="ph-settings-empty">' + escapeHtml(isZh ? '正在读取容器镜像信息…' : 'Loading container images…') + '</div>'
        + '</div></div>'
      // 本地运行设置：单选卡片自持 24px 侧距（ph-pm-body），容器只提供滚动
      : '<div class="ph-settings-feature-mounts">' + _renderProcessModeContent(agent) + '</div>';
    contentHtml = '<div class="ph-settings-feature-page">'
      + '<div class="ph-settings-feature-tabs">' + runtimeSubTabs + '</div>'
      + runtimeBody
      + '</div>';
  }

  const subtitle = _phSettingsTab === 'model'
    ? (isZh ? '为主代理设置主模型和备选模型，其他角色设置单个模型' : 'Set primary and secondary models for main agent, single model for other roles')
    : featurePage
      ? (isZh ? featurePage.subtitleZh : featurePage.subtitleEn)
      : _phSettingsTab === 'notification'
          ? (isZh ? '编程小助手的系统通知：任务完成、等待选择与 Coder 交付，可按场景选择提醒方式' : 'Programming Helper toasts — finished tasks, choices, and Coder deliveries; pick a style per scenario')
          : (isZh ? '设置会话在本地或容器中的运行方式' : 'Configure how sessions run locally or in containers');

  // 子页头部：返回按钮回到本页「功能配置」（项目既有形态：圆形钮 + 左箭头）
  const headHtml = isConfigSubPage
    ? '<div class="feature-detail-head-left">'
      + '<button class="feature-detail-close feature-skill-back" type="button" title="' + escapeHtml(isZh ? '返回' : 'Back') + '"'
      + ' data-action="phSettings.switchFeatureSubTab" data-sub="mounts">'
      + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"></path><path d="M19 12H5"></path></svg>'
      + '</button>'
      + '<div>'
      + '<div class="feature-detail-title">' + escapeHtml(isZh ? '参数配置' : 'Parameters') + '</div>'
      + '<div class="feature-detail-subtitle">' + escapeHtml(isZh
        ? '改动即时保存；「重置」把该字段恢复为上级配置'
        : 'Changes save immediately; Reset restores the field to the upstream layer') + '</div>'
      + '</div>'
      + '</div>'
    : '<div>'
      + '<div class="feature-detail-title">' + (isZh ? '工作空间设置' : 'Workspace Settings') + '</div>'
      + '<div class="feature-detail-subtitle">' + escapeHtml(subtitle) + '</div>'
      + '</div>';

  host.innerHTML = [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window ph-settings-window">',
    '<div class="feature-detail-head">',
    headHtml,
    '<button class="feature-detail-close" type="button" data-action="phSettings.close">&times;</button>',
    '</div>',
    '<div class="ph-settings-layout">',
    // 子页不渲染左栏：参数编辑区拿满窗口宽度
    isConfigSubPage ? '' : '<div class="ph-settings-sidebar">' + tabItems + '</div>',
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
  if (featurePage && _phFeatureSubTab === 'config') {
    const target = _phFeatureConfigTarget;
    _phFeatureEditor = createFeatureConfigEditor({
      host: document.getElementById('ph-feature-config-host'),
      scopeId: featurePage.scopeId,
      ...(featurePage.scopeAgentId ? { scopeAgentId: featurePage.scopeAgentId } : {}),
      ...(target?.identityKey === featurePage.identityKey ? { initialFeature: target.name } : {}),
    });
    _phFeatureEditor.open();
  }
  if (featurePage && featurePage.policy && _phFeatureSubTab === 'policy') _phLoadCoderPolicy();
  if (_phSettingsTab === 'runtime' && _phRuntimeSubTab === 'container') {
    // 容器运行设置分页：声明域宿主（服务端按名册 host 关系圈定本工作空间 + 子应用），
    // 模块内部以 host 元素是否在 DOM 判断活跃
    registerContainerImagesHost('ph-container-images-host', getPhSettingsAgentId() || 'programming-helper');
    loadContainerImagesPanel();
  }
  if (_phSettingsTab === 'notification') _phLoadNotificationSettings();

  // Enhance native selects with custom dropdown
  requestAnimationFrame(function() {
    enhanceAll(host);
  });
}
const _phSwitchSettingsTab = (tab) => {
  // 插件清单与能力参数只属于主工作空间插件页；Coder 使用独立配置页；
  // 各页进入时回到自己的默认分页（Coder设置默认落策略、运行环境默认落本地）。
  if (PH_FEATURE_PAGES[tab]) {
    _phFeatureSubTab = PH_FEATURE_PAGES[tab].defaultSubTab || 'mounts';
    _phFeatureConfigTarget = null;
  }
  if (tab === 'runtime') _phRuntimeSubTab = 'local';
  _phSettingsTab = tab;
  const agent = (typeof window.getCurrentAgentRecord === 'function') ? window.getCurrentAgentRecord() : null;
  if (agent) {
    const presets = getClawModelPresets();
    renderPhSettingsOverlay(agent, presets);
  }
};

const _phSwitchFeatureSubTab = (sub) => {
  const page = PH_FEATURE_PAGES[_phSettingsTab];
  if (!page) return;
  // 策略分页仅 Coder设置页持有
  if (sub !== 'config' && sub !== 'mounts' && !(sub === 'policy' && page.policy)) return;
  if (sub !== 'config') _phFeatureConfigTarget = null;
  _phFeatureSubTab = sub;
  const agent = (typeof window.getCurrentAgentRecord === 'function') ? window.getCurrentAgentRecord() : null;
  if (agent) {
    const presets = getClawModelPresets();
    renderPhSettingsOverlay(agent, presets);
  }
};

const _phSwitchRuntimeSubTab = (sub) => {
  // 容器运行设置分页仅编程小助手域持有
  if (sub !== 'local' && sub !== 'container') return;
  if (sub === 'container' && getPhSettingsAgentId() !== 'programming-helper') return;
  _phRuntimeSubTab = sub;
  const agent = (typeof window.getCurrentAgentRecord === 'function') ? window.getCurrentAgentRecord() : null;
  if (agent) {
    const presets = getClawModelPresets();
    renderPhSettingsOverlay(agent, presets);
  }
};

/**
 * 打开某能力的参数页。两个入口汇到这里：
 *   - 工作空间设置 → 功能配置 清单卡片的齿轮（当前页，无 identity）
 *   - 插件商店卡片 / 功能配置 卡片（带 identity）：先收起商店，再切到该空间的
 *     「参数配置」并选中该项 —— 同一工作空间的参数只有这一个编辑面。
 */
/**
 * 该身份已装配项里「真正有可配置参数」的名字集合（featureName 与 mountName
 * 两个键都登记）。判定口径与编辑器一致：顶层 properties 或 sections 任一声明
 * 了字段才算可配。请求失败返回 null —— 未知时不拦路，交给编辑器自己报空态。
 */
async function _phConfigurableNames(page) {
  const agentId = page.scopeAgentId || (page.identityKey === 'main' ? 'programming-helper' : page.identityKey);
  try {
    const res = await fetch(`/protoclaw/system_feature_manifests?agentId=${encodeURIComponent(agentId)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const names = new Set();
    for (const entry of data.features || []) {
      const settings = entry?.manifest?.settings || {};
      const hasProps = Object.keys(settings.properties || {}).length > 0;
      const hasSections = Array.isArray(settings.sections)
        && settings.sections.some((section) => (section?.properties || []).length > 0);
      if (!hasProps && !hasSections) continue;
      if (entry.featureName) names.add(entry.featureName);
      if (entry.mountName) names.add(entry.mountName);
    }
    return names;
  } catch {
    return null;
  }
}

const _phOpenFeatureConfig = async (el) => {
  const storeIdentity = el.dataset.identity || '';
  const targetTab = storeIdentity ? (storeIdentity === 'coder' ? 'coder' : 'feature') : _phSettingsTab;
  const page = PH_FEATURE_PAGES[targetTab];
  if (!page) return;
  const name = String(el.dataset.name || '');
  // 没有可配置参数就不跳转：否则用户会进到一个空页面，还得自己返回
  const configurable = await _phConfigurableNames(page);
  if (configurable && !configurable.has(name)) {
    const isZh = getCurrentLanguage() === 'zh';
    ClawToast.show({
      id: `feature-config-empty-${name}`,
      status: 'warning',
      title: isZh ? '没有可配置的参数' : 'No configurable parameters',
      description: isZh ? `${name} 未声明参数，无需配置` : `${name} declares no settings`,
      autoDismiss: 3500,
    });
    return;
  }
  if (storeIdentity) {
    phCloseFeatureStore();
    _phSettingsTab = targetTab;
  }
  _phFeatureConfigTarget = { identityKey: page.identityKey, name };
  _phSwitchFeatureSubTab('config');
};

// details 的 toggle 不冒泡，分发器必须以 capture 绑定（与 debug-features-hooks
// 各自声明，bindEventType 幂等，不依赖加载顺序）。
window.ClawFW.actions.bindEventType('toggle', { capture: true });

window.ClawFW.actions.registerMany({
  'phSettings.autoSaveModel': () => phAutoSaveModelConfig(),
  'phSettings.modelSlotChanged': (el) => phModelSlotChanged(el),
  'phSettings.switchTab': (el) => _phSwitchSettingsTab(el.dataset.tab),
  'phSettings.openFeatureStore': (el) => phOpenFeatureStore(el.dataset.identity),
  'phSettings.removeMountFeature': (el) => _fsRemoveFor(el.dataset.identity, el.dataset.name),
  'phSettings.toggleMountFeature': (el) => _phToggleMountFeature(el.dataset.identity, el.dataset.mount, el.dataset.feature),
  'phSettings.rebuildEnv': () => _phRebuildEnv(),
  'phSettings.setProcessMode': (el) => phSetProcessMode(el.dataset.mode),
  'phSettings.setCoderRotationStrategy': (el) => phSetCoderRotationStrategy(el.dataset.mode),
  'phSettings.setCoderRuntimeMode': (el) => phSetCoderRuntimeMode(el.dataset.mode),
  'phSettings.saveCoderThreadLimit': (el) => phSaveCoderThreadLimit(el.value),
  'phSettings.setNotifySceneMode': (el) => _phSetNotifySceneMode(el.dataset.agent, el.dataset.permission, el.value),
  'phSettings.setNotifySceneEnabled': (el, _event, agentId, sceneIdx) => _phSetNotifySceneEnabled(agentId, sceneIdx, el.checked),
  'phSettings.switchFeatureSubTab': (el) => _phSwitchFeatureSubTab(el.dataset.sub),
  'phSettings.switchRuntimeSubTab': (el) => _phSwitchRuntimeSubTab(el.dataset.sub),
  'phSettings.openFeatureConfig': (el) => _phOpenFeatureConfig(el),
  'phSettings.close': () => phCloseSettings(),
});

// —— 兼容面 ——
// 桥已注销（本域零 window 消费方）：_phRefreshMountsView 由 feature-store 直接
//   import；与 feature-store 互为静态依赖（两侧顶层都不读对方绑定）。
// 已改 direct import（不再经 window）：ph-project-actions 的四个动作入口
//   （phAutoSaveModelConfig / phModelSlotChanged / phCloseSettings / phSetProcessMode）、
//   createFeatureConfigEditor、phOpenFeatureStore / _fsRemoveFor、
//   registerContainerImagesHost / loadContainerImagesPanel、getFeatureCreatorProjects。
// 命名导出但不上桥：renderPhSettingsOverlay —— 唯一调用方 ph-project-actions 已 import。
// 模块状态收回（原 window 键）：phSettingsAgentId → 本模块 get/set 导出；
//   _phCurrentProject 零外部消费 → 模块私有；_phResetFeaturePageState 由
//   ph-project-actions import。
