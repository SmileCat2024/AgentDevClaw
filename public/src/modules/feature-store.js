/**
 * feature-store.js — 插件商店与插件管理器（通用组件，类似系统相册 API）
 *
 * 两个入口（同一数据面 GET /api/feature-store/overview）：
 * - 身份商店 phOpenFeatureStore('main' | 'coder')：按身份装配，面板内不切换身份。
 * - 插件管理器 window.clawOpenPluginManager()：Claw 级插件仓库与全局装配
 *   （设置菜单 → 插件仓库与全局装配）。负责 tgz 导入及全局装配/卸载；
 *   插件参数统一从工作空间插件卡片的「设置」进入，再选择全局默认或本空间覆盖。
 *
 * 数据面：
 *   GET /api/feature-store/overview —— 包列表 + 各装配层清单（含 missing）+
 *   mounts.global（全局装配清单）+ envReady（工作空间级环境就绪）+ installing
 *   （服务端进行中的安装，关弹窗后台继续时的可见性来源）
 * 安装（repository 包）：
 *   POST /api/feature-store/install —— provision + 成功才写声明；同步等待并
 *   即时反馈（按钮三态：添加 → 安装中…Ns → 成功/失败原因）。builtin 扩展
 *   是静态装配开关、无环境概念，走纯声明瞬时写回（PUT layer）。全局装配
 *   （identity 'global'）同样瞬时：仅校验 plan 不 provision，环境由各消费
 *   身份启动链自愈。
 * 移除：纯声明操作，前端直写配置层（PUT layer，无服务端状态变更）。
 * 全局层装配的条目（layerId 'global'）在身份商店只读展示：移除入口在插件
 * 管理器。
 *
 * 外部依赖（通过全局作用域）：
 *   - escapeHtml (app-ui.js)
 *   - currentLanguage (app-core.js)
 *   - window._phRefreshMountsView (ph-settings.js，写操作后刷新工作空间插件页)
 */

const _FS_IDENTITY_SCOPES = {
  main: { agentId: 'programming-helper', layerId: 'agent', labelZh: '编程小助手', labelEn: 'Programming Helper' },
  coder: { agentId: 'coder', layerId: 'agent', labelZh: 'Coder', labelEn: 'Coder' },
};

let _fsState = {
  open: false,
  identity: 'main',
  overview: null,
  error: '',
  busy: false,          // 单飞：安装/卸载进行中禁用其他写操作
  installingPkg: null,  // 本地发起安装中的包（卡片安装中态）
  installingSince: 0,   // 安装开始时间戳（秒计时显示）
  lastFailed: null,     // 最近一次安装失败的包（错误横幅重试入口）
  category: 'all',     // 当前类型分页（类型是上级轴，装配状态是内容区内的上下区段）
};

let _fsTickTimer = null;

function _fsT(zh, en) {
  return (typeof currentLanguage !== 'undefined' && currentLanguage === 'zh') ? zh : en;
}

// install/rebuild 错误分类 → 用户文案（服务端 code 见 install-service.js）
function _fsInstallErrorText(err) {
  const code = err && err.code;
  const mapped = {
    network: _fsT('网络不可用：首次安装需要联网拉取依赖', 'Network unavailable: first-time install needs internet to fetch dependencies'),
    package_missing: _fsT('包或版本不在仓库', 'Package or version not found in repository'),
    install_busy: _fsT('另一安装正在进行中，请稍候', 'Another install is in progress, please wait'),
    npm_unavailable: _fsT('npm 不可用：安装环境异常', 'npm unavailable: broken install environment'),
    nothing_to_rebuild: _fsT('没有需要恢复的环境', 'Nothing to rebuild'),
  };
  return mapped[code] || String((err && err.message) || err);
}

function _fsRuntimeKey(packageName) {
  return packageName.replace(/^@[^/]+\//, '');
}

function _fsHost() {
  let host = document.getElementById('ph-feature-store-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ph-feature-store-host';
    document.body.appendChild(host);
  }
  return host;
}

async function _fsFetchJson(url, options) {
  const res = await fetch(url, options);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(payload.error || `${res.status} ${res.statusText}`);
    if (payload.code) error.code = payload.code;
    throw error;
  }
  return payload;
}

/** 读目标身份配置层 sparse（$mount 与配置值同层）。 */
async function _fsLoadLayerSparse(scope) {
  const data = await _fsFetchJson(`/protoclaw/feature_config/resolved?agentId=${encodeURIComponent(scope.agentId)}`);
  const layer = (data.layers || []).find((entry) => entry.id === scope.layerId);
  return (layer && typeof layer.sparse === 'object' && layer.sparse !== null) ? layer.sparse : {};
}

/** 整层写回（PUT 语义），失败抛错由调用方提示。 */
async function _fsSaveLayer(scope, content) {
  await _fsFetchJson('/protoclaw/feature_config/layer', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: scope.agentId, layerId: scope.layerId, content }),
  });
}

async function _fsReloadOverview() {
  _fsState.error = '';
  try {
    _fsState.overview = await _fsFetchJson('/api/feature-store/overview');
  } catch (err) {
    _fsState.overview = null;
    _fsState.error = String(err?.message || err);
  }
}

// ── 动作 ───────────────────────────────────────────────────────

/** 身份层的读改写（sparse 整层写回）；商店与挂载管理页共用。 */
async function _fsMutateLayer(identity, mutator) {
  const scope = _FS_IDENTITY_SCOPES[identity];
  if (!scope) throw new Error('unknown identity: ' + identity);
  const sparse = await _fsLoadLayerSparse(scope);
  await mutator(sparse);
  await _fsSaveLayer(scope, sparse);
}

async function _fsAfterChange(identity) {
  await _fsReloadOverview();
  // 当前工作空间设置页若正在展示同一身份的装配清单，同步刷新。
  if (typeof window._phRefreshMountsView === 'function') window._phRefreshMountsView(identity);
  // 右侧 Features 面板的来源分类消费同一份装配事实，强制失效缓存重拉
  const fc = window.ClawFW && window.ClawFW.featureCatalog;
  if (fc && typeof fc.refreshMountFacts === 'function') fc.refreshMountFacts();
}

// 安装计时：秒数展示（安装期间每秒重渲染，给"在动"的感知）
function _fsStartTick() {
  _fsStopTick();
  _fsTickTimer = setInterval(() => { if (_fsState.open) _fsRender(); }, 1000);
}

function _fsStopTick() {
  if (_fsTickTimer) { clearInterval(_fsTickTimer); _fsTickTimer = null; }
}

function _fsInstallSeconds() {
  return Math.max(0, Math.floor((Date.now() - _fsState.installingSince) / 1000));
}

/** 服务端进行中的安装（可能是本会话关弹窗前发起的），当前身份匹配才显示 */
function _fsServerInstalling() {
  const info = _fsState.overview?.installing;
  return (info && info.identity === _fsState.identity && info.kind === 'install')
    ? info.packageName
    : null;
}

const _fsInstall = async function(packageName, version) {
  if (_fsState.busy) return;
  _fsState.busy = true;
  _fsState.error = '';
  _fsState.installingPkg = packageName;
  _fsState.installingSince = Date.now();
  _fsStartTick();
  _fsRender();
  try {
    await _fsFetchJson('/api/feature-store/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: _fsState.identity, packageName, version }),
    });
    await _fsAfterChange(_fsState.identity);
    // 不跳页：类型页不动，新装插件从未装配区段移入已装配区段，浏览上下文保持
  } catch (err) {
    _fsState.error = _fsInstallErrorText(err);
    _fsState.lastFailed = { packageName, version };
  } finally {
    _fsState.busy = false;
    _fsState.installingPkg = null;
    _fsStopTick();
    _fsRender();
  }
};

const _fsInstallBuiltin = async function(runtimeName) {
  if (_fsState.busy) return;
  _fsState.busy = true;
  try {
    await _fsMutateLayer(_fsState.identity, (sparse) => {
      sparse[runtimeName] = {
        ...(sparse[runtimeName] && typeof sparse[runtimeName] === 'object' ? sparse[runtimeName] : {}),
        $mount: { kind: 'builtin' },
      };
    });
    await _fsAfterChange(_fsState.identity);
  } catch (err) {
    _fsState.error = String(err?.message || err);
  } finally {
    _fsState.busy = false;
    _fsRender();
  }
};

/** 挂载管理页的移除按钮：带身份参数，不依赖商店当前的打开状态。 */
window._fsRemoveFor = async function(identity, runtimeName) {
  if (_fsState.busy) return;
  _fsState.busy = true;
  try {
    await _fsMutateLayer(identity, (sparse) => { delete sparse[runtimeName]; });
    await _fsAfterChange(identity);
  } catch (err) {
    _fsState.error = String(err?.message || err);
  } finally {
    _fsState.busy = false;
    _fsRender();
  }
};

const _fsSelectVersion = function(packageName, selectEl) {
  const card = selectEl.closest('[data-fs-package]');
  if (card) card.dataset.fsVersion = selectEl.value;
};

// ── 渲染 ───────────────────────────────────────────────────────

function _fsMountedMap() {
  const mounts = _fsState.overview?.mounts?.[_fsState.identity];
  return mounts && typeof mounts === 'object' ? mounts : {};
}

/**
 * catalog 快照（window.ClawFW.featureCatalog 与面板/挂载页共用）。
 * 未就绪返回 null（分组落待归类兜底组）；phOpenFeatureStore 打开时预加载。
 */
function _fsCatalog() {
  const fc = window.ClawFW && window.ClawFW.featureCatalog;
  return fc ? fc.getFeatureCatalogSnapshot() : null;
}

/** 商店货架卡片：复用 Features 面板 feature-card 结构；surface 有值时带声明面数量行。 */
function _fsCard(item, control, extraAttr) {
  const surfaceHtml = (window.ClawFW && window.ClawFW.phSurfaceDetail)
    ? window.ClawFW.phSurfaceDetail(item.surface) : '';
  const showId = item.displayName !== item.name;
  return '<div class="feature-card" style="cursor:default;"' + (extraAttr || '') + ' title="' + escapeHtml(item.name) + '">'
    + '<div class="feature-card-top">'
    + '<div class="feature-card-main">'
    + '<span class="feature-card-dot"></span>'
    + '<div style="min-width:0;">'
    + '<div class="feature-card-name">' + escapeHtml(item.displayName)
    + (showId ? ' <span class="feature-detail-id">' + escapeHtml(item.name) + '</span>' : '') + '</div>'
    + (item.description ? '<div class="feature-card-file">' + escapeHtml(item.description) + '</div>' : '')
    + '</div>'
    + '</div>'
    + '<div class="feature-card-badges">' + control + '</div>'
    + '</div>'
    + surfaceHtml
    + '</div>';
}

/** 已装配区段卡片：徽章与动作沿用旧清单语义（全局只读、missing、设置、移除）。 */
function _fsMountedCard(feature, builtinItems, packageNames) {
  const runtimeName = feature._mountRuntimeName;
  const mount = feature._mount;
  // 全局层装配（ADR-0046）：声明在 global 层，本身份层的移除动作对它无效，
  // 移除入口在插件管理器（设置菜单 → 插件管理）
  const isGlobal = mount.layerId === 'global';
  const globalBadge = isGlobal
    ? '<span class="feature-prov-badge">' + escapeHtml(_fsT('全局', 'global')) + '</span>'
    : '';
  // builtin 装配无 package/version（不走 tgz 仓库），徽章显示来源而非包坐标
  const status = mount.missing
    ? globalBadge + '<span class="feature-badge status-removed">' + escapeHtml(_fsT('包已不在仓库', 'missing')) + '</span>'
    : globalBadge + (mount.kind === 'builtin'
      ? '<span class="feature-prov-badge">' + escapeHtml(_fsT('扩展', 'extension')) + '</span>'
      : '<span class="feature-prov-badge">' + escapeHtml(`${mount.package}@${mount.version}`) + '</span>');
  const btn = isGlobal
    ? '<button type="button" class="fs-list-remove" disabled style="opacity:0.35;" title="' + escapeHtml(_fsT('来自全局装配，在 设置 → 插件管理 中移除', 'From global assembly; remove via Settings → Plugin Manager')) + '">&#215;</button>'
    : '<button type="button" class="fs-list-remove" title="' + escapeHtml(_fsT('移除', 'Remove')) + '" data-action="featureStore.removeMount" data-identity="' + escapeHtml(_fsState.identity) + '" data-name="' + escapeHtml(runtimeName) + '">&#215;</button>';
  // tgz 装配项的配置参数入口（ADR-0046 落地第 1 步）：就地打开设置弹窗，
  // 层 tab 提供「全局默认 | 本空间」两级编辑。builtin 的配置家在 Feature
  // 配置编辑器（官方清单面板），不在此重复提供入口。
  const settingsBtn = mount.kind !== 'builtin' && !mount.missing
    ? '<button type="button" class="fs-settings-btn" title="' + escapeHtml(_fsT('设置', 'Settings')) + '" data-action="featureStore.openSettings" data-identity="' + escapeHtml(_fsState.identity) + '" data-name="' + escapeHtml(runtimeName) + '">&#9881;</button>'
    : '';
  // displayName 与可安装区同源（builtin title / 包 displayName），查不到落回 runtime 名
  const pkg = packageNames.get(runtimeName);
  const displayName = (mount.kind === 'builtin' ? builtinItems.get(runtimeName)?.title : pkg?.displayName) || runtimeName;
  return _fsCard({
    name: runtimeName,
    displayName,
    description: '',
    surface: mount.kind === 'builtin' ? (builtinItems.get(runtimeName)?.surface || null) : null,
  }, settingsBtn + status + btn);
}

/**
 * 商店统一类型分组：已装配与可安装条目一起过 catalog 类型推导（join key =
 * runtimeName，与 Features 面板同源），类型是商店的上级轴。装配状态不参与
 * 分组——每个条目带 `_mount`（已装配）或 `_item`（可安装货架卡）标记，
 * 由渲染层在类型页内分「已装配 / 未装配」上下区段。
 */
function _fsBuildTypeGroups(mountedMap, mountedByPackage) {
  const identity = _fsState.identity;
  const items = [];
  for (const item of (_fsState.overview?.builtin || [])) {
    // 已装配的不上货架（装配状态在内容区「已装配」区段呈现）
    if (mountedMap[item.runtimeName]) continue;
    if (!(item.identities || []).includes(identity)) continue;
    items.push({
      name: item.runtimeName,
      displayName: item.title || item.runtimeName,
      description: item.description || '',
      surface: item.surface || null,
      control: '<button type="button" class="fs-list-add" data-action="featureStore.installBuiltin" data-name="' + escapeHtml(item.runtimeName) + '">' + escapeHtml(_fsT('+ 添加', '+ Add')) + '</button>',
    });
  }
  for (const pkg of (_fsState.overview?.packages || [])) {
    const runtimeKey = _fsRuntimeKey(pkg.package);
    // 已装配的包不上货架
    if (mountedByPackage.has(pkg.package)) continue;
    const versionOptions = (pkg.versions || []).map((v) =>
      '<option value="' + escapeHtml(v.version) + '">' + escapeHtml(v.version) + '</option>'
    ).join('');
    const latest = pkg.versions?.[0]?.version || '';
    // 安装中卡片（本地发起或服务端后台进行）：按钮进计时态，版本选择禁用
    const busyPkg = _fsState.installingPkg || _fsServerInstalling();
    const isInstalling = busyPkg === pkg.package;
    const addButton = isInstalling
      ? '<button type="button" class="fs-list-add" disabled style="opacity:0.7;">'
        + escapeHtml(_fsT('安装中… ' + _fsInstallSeconds() + 's', 'Installing… ' + _fsInstallSeconds() + 's')) + '</button>'
      : '<button type="button" class="fs-list-add"' + (busyPkg ? ' disabled style="opacity:0.7;"' : '')
        + ' data-action="featureStore.install" data-package="' + escapeHtml(pkg.package) + '" data-version="' + escapeHtml(latest) + '">'
        + escapeHtml(_fsT('+ 添加', '+ Add')) + '</button>';
    const control = (pkg.versions?.length > 1
      ? '<select class="fs-select"' + (busyPkg ? ' disabled' : '') + ' data-action="featureStore.selectVersion" data-event="change" data-package="' + escapeHtml(pkg.package) + '">' + versionOptions + '</select>'
      : '<span style="font-size:12px;color:var(--text-secondary);">' + escapeHtml(latest) + '</span>')
      + addButton;
    items.push({
      name: runtimeKey,
      displayName: pkg.displayName || runtimeKey,
      description: pkg.description || pkg.package,
      surface: null, // 仓库包装配无声明面计数（与挂载管理页同口径）
      control,
      extraAttr: ' data-fs-package="' + escapeHtml(pkg.package) + '" data-fs-version="' + escapeHtml(pkg.versions?.[0]?.version || '') + '"',
    });
  }

  // 已装配条目（含 missing：声明仍在本层，移除后回到未装配区段）
  const builtinItems = new Map((_fsState.overview?.builtin || []).map((item) => [item.runtimeName, item]));
  const mountedFeatures = Object.entries(mountedMap).map(([runtimeName, mount]) => ({
    name: runtimeName,
    description: '',
    surface: mount.kind === 'builtin' ? (builtinItems.get(runtimeName)?.surface || null) : null,
    _mount: mount,
    _mountRuntimeName: runtimeName,
  }));

  const features = [
    ...mountedFeatures,
    ...items.map((item) => ({ name: item.name, description: item.description, surface: item.surface, _item: item })),
  ];
  if (!features.length) return [];

  const fc = window.ClawFW && window.ClawFW.featureCatalog;
  const catalog = _fsCatalog();
  // enrich 兼容形状：声明面计数喂给能力推导（商店不提供能力筛选，仅供分组一致性）
  const feed = features.map((feature) => ({
    ...feature,
    tools: [],
    toolCount: feature.surface ? feature.surface.tools : 0,
    hookCount: feature.surface ? feature.surface.hooks : 0,
    skillCount: feature.surface ? feature.surface.skills : undefined,
  }));
  const commandFeatures = new Map(
    features.filter((i) => i.surface && i.surface.commands > 0).map((i) => [i.name, i.surface.commands]),
  );
  return (fc && catalog)
    ? fc.groupFeaturesByType(feed, catalog, 'all', 'all', { commandFeatures })
    : [{ id: '_unmapped', features: feed }];
}

/**
 * 商店主体：类型是上级轴（分页器，恒显示——即便只有「全部」一档），
 * 装配状态是内容区内的上下区段（已装配在上、未装配在下）。
 * 计数语义 = "点这一档会看到几个"（该类型下已装 + 未装总数）。
 */
function _fsRenderStoreBody(mountedMap, mountedByPackage) {
  const groups = _fsBuildTypeGroups(mountedMap, mountedByPackage);
  const totalCount = groups.reduce((sum, group) => sum + group.features.length, 0);
  const validCategory = groups.some((group) => group.id === _fsState.category);
  if (_fsState.category !== 'all' && !validCategory) _fsState.category = 'all';

  const categoryTabs = [
    { id: 'all', label: _fsT('全部', 'All'), count: totalCount },
    ...groups.map((group) => ({
      id: group.id,
      label: t(group.id === '_unmapped' ? 'feature_cat_unmapped' : 'feature_type_' + group.id),
      count: group.features.length,
    })),
  ].map((tab) => '<button type="button" class="fs-category-tab' + (_fsState.category === tab.id ? ' active' : '')
    + '" data-action="featureStore.category" data-category="' + escapeHtml(tab.id) + '">'
    + escapeHtml(tab.label) + '<span class="fs-tab-count">' + tab.count + '</span></button>').join('');

  const selected = _fsState.category === 'all'
    ? groups.flatMap((group) => group.features)
    : (groups.find((group) => group.id === _fsState.category)?.features || []);
  const mountedFeatures = selected.filter((feature) => feature._mount);
  const availableFeatures = selected.filter((feature) => feature._item);

  const builtinItems = new Map((_fsState.overview?.builtin || []).map((item) => [item.runtimeName, item]));
  const packageNames = new Map((_fsState.overview?.packages || []).map((pkg) => [_fsRuntimeKey(pkg.package), pkg]));

  const mountedHtml = mountedFeatures.length
    ? '<div class="feature-grid ph-mount-grid">'
      + mountedFeatures.map((feature) => _fsMountedCard(feature, builtinItems, packageNames)).join('') + '</div>'
    : '<div class="fs-store-empty fs-store-empty-slim">' + escapeHtml(_fsT(
      '此类型暂无已装配插件。',
      'No installed plugins in this type yet.',
    )) + '</div>';
  const availableHtml = availableFeatures.length
    ? '<div class="feature-grid ph-mount-grid fs-available-grid">'
      + availableFeatures.map((feature) => _fsCard(feature._item, feature._item.control, feature._item.extraAttr)).join('') + '</div>'
    : '<div class="fs-store-empty fs-store-empty-slim">' + escapeHtml(_fsT(
      '没有可安装的插件：仓库暂无新包，或可用的都已装配。',
      'Nothing to install: the repository has no new packages, or everything available is already installed.',
    )) + '</div>';

  const section = (dotClass, label, count, cardsHtml) =>
    '<section class="fs-status-section"><div class="fs-status-section-head">'
    + '<span class="fs-status-dot ' + dotClass + '"></span>'
    + escapeHtml(label) + '<span class="fs-tab-count">' + count + '</span>'
    + '</div>' + cardsHtml + '</section>';

  return '<div class="fs-category-tabs" role="tablist">' + categoryTabs + '</div>'
    + '<div class="fs-store-panel">'
    + section('fs-status-dot-installed', _fsT('已装配', 'Installed'), mountedFeatures.length, mountedHtml)
    + section('fs-status-dot-not-installed', _fsT('未装配', 'Not installed'), availableFeatures.length, availableHtml)
    + '</div>';
}

function _fsRender() {
  const host = _fsHost();
  if (!_fsState.open) { host.innerHTML = ''; return; }
  const scope = _FS_IDENTITY_SCOPES[_fsState.identity];

  let body;
  if (!_fsState.overview && !_fsState.error) {
    body = '<div class="ph-settings-empty" style="padding:32px 0;">' + escapeHtml(_fsT('加载中...', 'Loading...')) + '</div>';
  } else if (_fsState.error && !_fsState.overview) {
    body = '<div class="ph-settings-empty" style="padding:32px 0;color:var(--danger,#e5484d);">' + escapeHtml(_fsState.error) + '</div>';
  } else {
    const mountedMap = _fsMountedMap();
    const mountedByPackage = new Map(
      Object.entries(mountedMap).map(([runtimeName, mount]) => [mount.package, { runtimeName, mount }])
        // builtin 无 package（不走 tgz 货架）；missing 也算已装配声明（移除后可重装）
        .filter(([, v]) => v.mount.kind !== 'builtin'),
    );
    body = _fsRenderStoreBody(mountedMap, mountedByPackage);
  }

  const errorBanner = (_fsState.error && _fsState.overview)
    ? '<div class="fs-error-banner">' + escapeHtml(_fsState.error)
      + (_fsState.lastFailed
        ? ' <button type="button" class="fs-list-add" style="margin-left:8px;" data-action="featureStore.install"'
          + ' data-package="' + escapeHtml(_fsState.lastFailed.packageName) + '" data-version="' + escapeHtml(_fsState.lastFailed.version) + '">'
          + escapeHtml(_fsT('重试', 'Retry')) + '</button>'
        : '')
      + '</div>'
    : '';

  host.innerHTML = [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window ph-settings-window" style="position:relative;">',
    '<div class="feature-detail-head">',
    '<div style="display:flex;align-items:center;gap:4px;">',
    '<button class="feature-detail-close" type="button" title="' + _fsT('返回', 'Back') + '" data-action="featureStore.close" style="margin-right:8px;font-size:16px;"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"></path><path d="M19 12H5"></path></svg></button>',
    '<div>',
      '<div class="feature-detail-title">' + escapeHtml(_fsT('添加插件', 'Add Plugins')) + '</div>',
      '<div class="feature-detail-subtitle">' + escapeHtml(_fsT(
        '从插件仓库为 ' + _fsT(scope.labelZh, scope.labelEn) + ' 安装（首次需联网），对新会话生效',
        'Install plugins for ' + _fsT(scope.labelZh, scope.labelEn) + ' from the feature repository (first install needs internet); takes effect on new sessions'
      )) + '</div>',
    '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" data-action="featureStore.close">&times;</button>',
    '</div>',
    errorBanner,
    // 复用挂载管理页同款主体容器（24px 左右缘 + flex gap 14px 分组间距）
    '<div class="ph-mounts-body" style="overflow-y:auto;flex:1;">' + body + '</div>',
    '</div>',
    '</div>',
  ].join('');
}

// ── 面板开关（ph-settings 的入口卡片调用）────────────────

window.phOpenFeatureStore = async function(identity) {
  _fsState.open = true;
  // 身份由打开上下文决定（配置编辑器/挂载管理页传入）；未传时默认 main
  _fsState.identity = _FS_IDENTITY_SCOPES[identity] ? identity : 'main';
  _fsState.overview = null;
  _fsState.error = '';
  _fsState.busy = false;
  _fsState.installingPkg = null;
  _fsState.lastFailed = null;
  _fsState.category = 'all';
  _fsStopTick();
  _fsRender();
  // catalog 与 overview 并行预载；catalog 失败不阻断（分组落待归类兜底组）
  await Promise.all([
    _fsReloadOverview(),
    (window.ClawFW && window.ClawFW.featureCatalog
      ? window.ClawFW.featureCatalog.loadFeatureCatalog().catch(() => {})
      : Promise.resolve()),
  ]);
  _fsRender();
};

function phCloseFeatureStore() {
  _fsState.open = false;
  _fsState.busy = false;
  _fsState.installingPkg = null;
  _fsStopTick();
  // 本地发起的安装不中断：服务端单飞队列继续跑完，重开面板时经
  // overview.installing 显示进行中状态，完成结果由 overview 自然呈现
  _fsRender();
}

// ── 事件接线（data-action="featureStore.*"）───────────────────────
// phOpenFeatureStore / _fsRemoveFor 另被 ph-settings.js 与配置编辑器的
// 注册块经 window 转调，保留导出；其余动作的消费面仅本模块模板。

window.ClawFW.actions.registerMany({
  // 版本取卡片上的当前选择（版本下拉改动落 data-fs-version），重试按钮不在
  // 卡片内，回落到按钮自身携带的版本
  'featureStore.install': (el) => _fsInstall(
    el.dataset.package,
    el.closest('[data-fs-package]')?.dataset.fsVersion || el.dataset.version,
  ),
  'featureStore.installBuiltin': (el) => _fsInstallBuiltin(el.dataset.name),
  'featureStore.removeMount': (el) => _fsRemoveFor(el.dataset.identity, el.dataset.name),
  'featureStore.selectVersion': (el) => _fsSelectVersion(el.dataset.package, el),
  'featureStore.category': (el) => {
    _fsState.category = el.dataset.category || 'all';
    _fsRender();
  },
  'featureStore.close': () => phCloseFeatureStore(),
});

// ══ 插件管理器（全局级治理入口，ADR-0046）══════════════════════
// 与身份商店共用数据面与辅助函数（_fsT/_fsFetchJson/_fsCard/层读写）；
// 状态独立（两个弹窗可先后打开，互不抢占渲染宿主）。

// global 层写回锚点：agentId 仅用于层清单解析（global 层路径对所有身份一致）
const _PM_GLOBAL_SCOPE = { agentId: 'programming-helper', layerId: 'global' };

let _pmState = {
  open: false,
  overview: null,
  error: '',
  busy: false,          // 单飞：装配/卸载进行中禁用其他写操作（全局装配瞬时，无计时器）
  lastFailed: null,     // 最近一次装配失败的包（错误横幅重试入口）
  // tgz 上传导入的待确认状态（parse_upload 的 { uploadId, summary }）。
  // 导入只入仓库，装配仍走货架卡片——与 ADR-0045「导入与装配分离」一致
  import: null,
};

// ── 插件设置弹窗（ADR-0046 落地第 1 步：配置入口从 Feature 配置编辑器归位）──
//
// 服务对象是 tgz 仓库包装配项（如 agentero 的 vaultPath）：配置参数在插件
// 卡片就地打开，层 tab 提供「全局默认 | 本空间」两级编辑（数据面全复用
// resolved API + PUT layer，两态语义复用 feature-setup-core 的跟随/接管
// 模型，与 Feature 配置编辑器同源）。builtin（官方可选插件）的配置面板
// 本就是 Feature 配置编辑器的官方清单，语义无错位，不在此重复提供入口。
let _fsSettings = {
  open: false,
  busy: false,
  runtimeName: '',
  displayName: '',
  manifest: null,   // { settings: { properties } } | null（无配置参数）
  resolved: null,   // resolved API 缓存（layers + merged）
  scopeId: 'global', // 'global' | 'agent'
  agentId: '',       // scope agentId（resolved/PUT 寻址用）
  hasIdentity: false, // true = 商店卡片（有身份上下文，显示两层 tab）
  error: '',
};

/**
 * 设置弹窗的字段行视图数据（纯函数，测试锚点）。
 * manifestEntry 形如 system_feature_manifests 的 { featureName, manifest }；
 * resolved 为 resolved API 响应；scopeId 为当前编辑层。返回行数组：
 * { key, prop, state, controlValue, showReset, upstreamLabel, groupLabel }。
 */
function _fsSettingsRows(manifestEntry, resolved, scopeId) {
  const properties = manifestEntry?.manifest?.settings?.properties;
  if (!properties || typeof properties !== 'object') return null;
  const sections = [{ featureName: manifestEntry.featureName, props: properties, propKeys: Object.keys(properties) }];
  const layers = Array.isArray(resolved?.layers) ? resolved.layers : [];
  const states = fsFieldStates(sections, layers, scopeId);
  const rows = [];
  for (const [key, prop] of Object.entries(properties)) {
    if (prop?.type === 'group') {
      for (const [subKey, subProp] of Object.entries(prop.properties || {})) {
        const fullKey = `${manifestEntry.featureName}.${key}.${subKey}`;
        rows.push(_fsSettingsRow(fullKey, subProp, states.get(fullKey), scopeId, key));
      }
      continue;
    }
    const fullKey = `${manifestEntry.featureName}.${key}`;
    rows.push(_fsSettingsRow(fullKey, prop, states.get(fullKey), scopeId, null));
  }
  return rows;
}

/** 单行组装：控件值（接管→本层；跟随→上游最近层值，无则 manifest 默认）。 */
function _fsSettingsRow(fullKey, prop, state, scopeId, groupLabel) {
  return {
    key: fullKey,
    prop,
    state: state || { status: 'follow', upstream: { kind: 'default' } },
    controlValue: fsControlValue(state, prop),
    showReset: fsShowReset(scopeId, state, prop),
    upstreamLabel: state?.upstream?.kind === 'layer'
      ? (state.upstream.label || '') + (state.status === 'takeover' ? '' : '')
      : '',
    groupLabel: groupLabel || null,
  };
}

function _pmHost() {
  let host = document.getElementById('claw-plugin-manager-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'claw-plugin-manager-host';
    document.body.appendChild(host);
  }
  return host;
}

async function _pmReloadOverview() {
  _pmState.error = '';
  try {
    _pmState.overview = await _fsFetchJson('/api/feature-store/overview');
  } catch (err) {
    _pmState.overview = null;
    _pmState.error = String(err?.message || err);
  }
}

/** 全局卸载：global 层 sparse 读改写（删除 $mount 声明键） */
const _pmRemoveGlobal = async function(runtimeName) {
  if (_pmState.busy) return;
  _pmState.busy = true;
  try {
    const sparse = await _fsLoadLayerSparse(_PM_GLOBAL_SCOPE);
    delete sparse[runtimeName];
    await _fsSaveLayer(_PM_GLOBAL_SCOPE, sparse);
    await _fsAfterChange();
    await _pmReloadOverview();
  } catch (err) {
    _pmState.error = String(err?.message || err);
  } finally {
    _pmState.busy = false;
    _pmRender();
  }
};

/** 全局装配：identity='global' 瞬时（仅校验 plan），无计时态 */
const _pmInstallGlobal = async function(packageName, version) {
  if (_pmState.busy) return;
  _pmState.busy = true;
  _pmState.error = '';
  _pmRender();
  try {
    await _fsFetchJson('/api/feature-store/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: 'global', packageName, version }),
    });
    await _fsAfterChange();
    await _pmReloadOverview();
  } catch (err) {
    _pmState.error = _fsInstallErrorText(err);
    _pmState.lastFailed = { packageName, version };
  } finally {
    _pmState.busy = false;
    _pmRender();
  }
};

const _pmSelectVersion = function(packageName, selectEl) {
  const card = selectEl.closest('[data-pm-package]');
  if (card) card.dataset.pmVersion = selectEl.value;
};

// ── tgz 上传导入（parse → 确认 → 入仓库；装配走货架卡片）────────────

function _pmOpenUpload() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.tgz';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const formData = new FormData();
      formData.append('file', file);
      const resp = await fetch('/protoclaw/feature_repository/parse_upload', { method: 'POST', body: formData });
      if (!resp.ok) throw new Error(await resp.text().catch(() => 'parse upload failed'));
      _pmState.import = await resp.json();
      _pmRender();
    } catch (error) {
      window.alert((currentLanguage === 'zh' ? '解析 tgz 失败：' : 'Failed to parse tgz: ') + (error?.message || error));
    }
  };
  input.click();
}

async function _pmCancelImport() {
  const uploadId = _pmState.import?.uploadId;
  _pmState.import = null;
  _pmRender();
  if (uploadId) {
    await fetch('/protoclaw/feature_repository/cancel_import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
    }).catch(e => console.warn(e));
  }
}

async function _pmConfirmImport() {
  const pending = _pmState.import;
  if (!pending?.uploadId) return;
  try {
    const resp = await fetch('/protoclaw/feature_repository/confirm_import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId: pending.uploadId }),
    });
    if (!resp.ok) throw new Error(await resp.text().catch(() => 'import failed'));
    _pmState.import = null;
    await _fsAfterChange();
    await _pmReloadOverview();
  } catch (error) {
    window.alert((currentLanguage === 'zh' ? '导入失败：' : 'Import failed: ') + (error?.message || error));
  } finally {
    _pmRender();
  }
}

/** 导入确认对话框：三面摘要（工具类型 / 面板 / 数据服务）如实展示 */
function _pmRenderImportDialog() {
  const pending = _pmState.import;
  if (!pending) return '';
  const s = pending.summary || {};
  const warnings = Array.isArray(s.warnings) ? s.warnings : [];
  const featureTypes = Array.isArray(s.featureTypes) ? s.featureTypes : [];
  const panels = Array.isArray(s.ui?.panels) ? s.ui.panels : [];
  const serverPrefix = typeof s.server?.prefix === 'string' ? s.server.prefix : '';
  const sizeText = typeof s.size === 'number' ? (s.size > 1048576 ? (s.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(s.size / 1024)) + ' KB') : '';
  return [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + escapeHtml(_fsT('解析插件包', 'Parsed Plugin Package')) + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(_fsT('确认解析结果后导入到仓库；导入后可在下方货架安装。', 'Review the parsed metadata, then import to the repository; install from the shelf below.')) + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" data-action="pluginManager.cancelImport">&times;</button>',
    '</div>',
    '<div class="fw-import-result">',
    '<div class="fw-import-card">',
    '<div class="fw-import-title">' + escapeHtml(s.name || s.id || s.fileName || '-') + '</div>',
    '<div class="fw-import-meta">' + escapeHtml([s.packageName, s.version, s.fileName, sizeText].filter(Boolean).join(' · ')) + '</div>',
    s.description ? '<div class="fw-import-meta">' + escapeHtml(s.description) + '</div>' : '',
    '<div class="workspace-tag-list">'
    + featureTypes.map((type) => '<span class="workspace-tag">' + escapeHtml(type) + '</span>').join('')
    + (panels.length ? '<span class="workspace-tag">' + escapeHtml(_fsT('面板 × ' + panels.length, 'UI panels × ' + panels.length)) + '</span>' : '')
    + (serverPrefix ? '<span class="workspace-tag">' + escapeHtml(_fsT('数据服务 /' + serverPrefix, 'data service /' + serverPrefix)) + '</span>' : '')
    + '</div>',
    '</div>',
    warnings.length ? '<div class="fw-import-warning">' + warnings.map((item) => escapeHtml(item)).join('<br>') + '</div>' : '',
    '<div class="workspace-actions" style="justify-content:flex-end;">',
    '<button class="workspace-action secondary" type="button" data-action="pluginManager.cancelImport">' + escapeHtml(_fsT('取消', 'Cancel')) + '</button>',
    '<button class="workspace-action" type="button" data-action="pluginManager.confirmImport">' + escapeHtml(_fsT('导入到仓库', 'Import to Repository')) + '</button>',
    '</div>',
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}

// ── 插件管理器渲染 ─────────────────────────────────────────────

function _pmGlobalMountedMap() {
  const mounts = _pmState.overview?.mounts?.global;
  return mounts && typeof mounts === 'object' ? mounts : {};
}

/** 已装配（全局级）区：mounts.global 卡片 */
function _pmRenderGlobalSection(mountedMap) {
  const entries = Object.entries(mountedMap);
  if (!entries.length) {
    return '<div class="fs-section-title">' + escapeHtml(_fsT('全局装配', 'Global Assembly')) + '</div>'
      + '<div class="ph-settings-empty" style="padding:16px 0;">' + escapeHtml(_fsT(
        '暂无全局装配的插件。全局装配对所有插件化工作空间生效。',
        'No globally installed plugins. Global assembly applies to all plugin-enabled workspaces.'
      )) + '</div>';
  }
  const packageNames = new Map(
    (_pmState.overview?.packages || []).map((pkg) => [_fsRuntimeKey(pkg.package), pkg]),
  );
  const items = entries.map(([runtimeName, mount]) => {
    const status = mount.missing
      ? '<span class="feature-badge status-removed">' + escapeHtml(_fsT('包已不在仓库', 'missing')) + '</span>'
      : '<span class="feature-prov-badge">' + escapeHtml(`${mount.package}@${mount.version}`) + '</span>';
    const btn = '<button type="button" class="fs-list-remove" title="' + escapeHtml(_fsT('移除全局装配', 'Remove global assembly')) + '" data-action="pluginManager.removeGlobal" data-name="' + escapeHtml(runtimeName) + '">&#215;</button>';
    const pkg = packageNames.get(runtimeName);
    return _fsCard({
      name: runtimeName,
      displayName: pkg?.displayName || runtimeName,
      description: pkg?.description || '',
    }, status + btn);
  }).join('');
  return '<div class="fs-mounted-section"><div class="fs-section-title">' + escapeHtml(_fsT('全局装配', 'Global Assembly')) + '</div>'
    + '<div class="feature-grid ph-mount-grid">' + items + '</div></div>';
}

/** 仓库货架：用户仓库包（已全局装配的不重复列出），版本选择 + 全局装配按钮 */
function _pmRenderPackageSections(mountedMap) {
  const mountedByPackage = new Set(
    Object.values(mountedMap).map((mount) => mount.package).filter(Boolean),
  );
  const items = [];
  for (const pkg of (_pmState.overview?.packages || [])) {
    if (mountedByPackage.has(pkg.package)) continue;
    const runtimeKey = _fsRuntimeKey(pkg.package);
    const versionOptions = (pkg.versions || []).map((v) =>
      '<option value="' + escapeHtml(v.version) + '">' + escapeHtml(v.version) + '</option>'
    ).join('');
    const latest = pkg.versions?.[0]?.version || '';
    const addButton = _pmState.busy
      ? '<button type="button" class="fs-list-add" disabled style="opacity:0.7;">' + escapeHtml(_fsT('装配中…', 'Installing…')) + '</button>'
      : '<button type="button" class="fs-list-add" data-action="pluginManager.installGlobal" data-package="' + escapeHtml(pkg.package) + '" data-version="' + escapeHtml(latest) + '">'
        + escapeHtml(_fsT('+ 全局装配', '+ Add Global')) + '</button>';
    const control = (pkg.versions?.length > 1
      ? '<select class="fs-select"' + (_pmState.busy ? ' disabled' : '') + ' data-action="pluginManager.selectVersion" data-event="change" data-package="' + escapeHtml(pkg.package) + '">' + versionOptions + '</select>'
      : '<span style="font-size:12px;color:var(--text-secondary);">' + escapeHtml(latest) + '</span>')
      + addButton;
    items.push({
      name: runtimeKey,
      displayName: pkg.displayName || runtimeKey,
      description: pkg.description || pkg.package,
      control,
      extraAttr: ' data-pm-package="' + escapeHtml(pkg.package) + '" data-pm-version="' + escapeHtml(latest) + '"',
    });
  }
  if (!items.length) {
    return '<div class="fs-section-title">' + escapeHtml(_fsT('仓库插件', 'Repository Plugins')) + '</div>'
      + '<div class="ph-settings-empty" style="padding:16px 0;">' + escapeHtml(_fsT(
        '仓库暂无可全局装配的插件，可上传 tgz 导入。',
        'No plugins available for global assembly; upload a tgz to import one.'
      )) + '</div>';
  }
  return '<div class="fs-section-title">' + escapeHtml(_fsT('仓库插件', 'Repository Plugins')) + '</div>'
    + '<div class="feature-grid ph-mount-grid">'
    + items.map((item) => _fsCard(item, item.control, item.extraAttr)).join('')
    + '</div>';
}

function _pmRender() {
  const host = _pmHost();
  if (!_pmState.open) { host.innerHTML = ''; return; }

  let body;
  if (!_pmState.overview && !_pmState.error) {
    body = '<div class="ph-settings-empty" style="padding:32px 0;">' + escapeHtml(_fsT('加载中...', 'Loading...')) + '</div>';
  } else if (_pmState.error && !_pmState.overview) {
    body = '<div class="ph-settings-empty" style="padding:32px 0;color:var(--danger,#e5484d);">' + escapeHtml(_pmState.error) + '</div>';
  } else {
    const mountedMap = _pmGlobalMountedMap();
    body = _pmRenderGlobalSection(mountedMap) + _pmRenderPackageSections(mountedMap);
  }

  const errorBanner = (_pmState.error && _pmState.overview)
    ? '<div class="fs-error-banner">' + escapeHtml(_pmState.error)
      + (_pmState.lastFailed
        ? ' <button type="button" class="fs-list-add" style="margin-left:8px;" data-action="pluginManager.installGlobal"'
          + ' data-package="' + escapeHtml(_pmState.lastFailed.packageName) + '" data-version="' + escapeHtml(_pmState.lastFailed.version) + '">'
          + escapeHtml(_fsT('重试', 'Retry')) + '</button>'
        : '')
      + '</div>'
    : '';

  host.innerHTML = [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window ph-settings-window" style="position:relative;">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + escapeHtml(_fsT('插件管理', 'Plugin Manager')) + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(_fsT(
      '管理插件仓库与全局装配：全局装配对所有插件化工作空间生效；工作空间级装配在各工作空间的设置内操作。',
      'Manage the plugin repository and global assembly: global assembly applies to all plugin-enabled workspaces; per-workspace assembly lives in each workspace\'s settings.'
    )) + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" style="font-size:13px;padding:6px 12px;border-radius:6px;border:1px solid var(--border-color,#3a3a3a);" title="' + _fsT('从本地 tgz 文件导入插件包到仓库', 'Import a plugin package (.tgz) from local file into the repository') + '" data-action="pluginManager.openUpload">' + _fsT('上传 tgz', 'Upload tgz') + '</button>',
    '<button class="feature-detail-close" type="button" data-action="pluginManager.close">&times;</button>',
    '</div>',
    errorBanner,
    // 复用挂载管理页同款主体容器
    '<div class="ph-mounts-body" style="overflow-y:auto;flex:1;">' + body + '</div>',
    '</div>',
    '</div>',
    _pmRenderImportDialog(),
  ].join('');
}

window.clawOpenPluginManager = async function() {
  _pmState.open = true;
  _pmState.overview = null;
  _pmState.error = '';
  _pmState.busy = false;
  _pmState.lastFailed = null;
  _pmState.import = null;
  _pmRender();
  await _pmReloadOverview();
  _pmRender();
};

function _pmClosePluginManager() {
  _pmState.open = false;
  _pmState.busy = false;
  // 待确认导入留在 pending（服务端 10 分钟过期）；关面板不取消，重新打开可继续确认
  _pmRender();
}

window.ClawFW.actions.registerMany({
  // 版本取卡片上的当前选择（版本下拉改动落 data-pm-version），重试按钮不在
  // 卡片内，回落到按钮自身携带的版本
  'pluginManager.installGlobal': (el) => _pmInstallGlobal(
    el.dataset.package,
    el.closest('[data-pm-package]')?.dataset.pmVersion || el.dataset.version,
  ),
  'pluginManager.removeGlobal': (el) => _pmRemoveGlobal(el.dataset.name),
  'pluginManager.selectVersion': (el) => _pmSelectVersion(el.dataset.package, el),
  'pluginManager.openUpload': () => _pmOpenUpload(),
  'pluginManager.cancelImport': () => _pmCancelImport(),
  'pluginManager.confirmImport': () => _pmConfirmImport(),
  'pluginManager.close': () => _pmClosePluginManager(),
});

// ── 插件设置弹窗：打开 / 渲染 / 写入 ──────────────────────────────

/**
 * 打开设置弹窗。runtimeName 为 $mount 声明键；identityContext 传身份键
 * （'main' | 'coder'）时提供「全局默认 | 本空间」两层 tab，插件管理器的
 * 全局装配卡片无身份上下文（不传），只编辑全局默认层。
 */
window._fsOpenSettings = async function(runtimeName, identityContext, options = {}) {
  const scope = identityContext && _FS_IDENTITY_SCOPES[identityContext];
  const requestedScope = options.initialScope;
  const initialScope = scope && requestedScope !== 'global' ? 'agent' : 'global';
  _fsSettings = {
    open: true,
    busy: true,
    runtimeName: String(runtimeName || ''),
    displayName: String(runtimeName || ''),
    manifest: null,
    resolved: null,
    scopeId: initialScope,
    agentId: scope ? scope.agentId : 'programming-helper',
    hasIdentity: !!scope,
    identityLabel: scope ? (currentLanguage === 'zh' ? scope.labelZh : scope.labelEn) : '',
    error: '',
  };
  _fsSettingsRender();
  try {
    const agentId = encodeURIComponent(_fsSettings.agentId);
    const [manifestsRes, resolvedRes] = await Promise.all([
      _fsFetchJson(`/protoclaw/system_feature_manifests?agentId=${agentId}`),
      _fsFetchJson(`/protoclaw/feature_config/resolved?agentId=${agentId}`),
    ]);
    const entry = (manifestsRes.features || []).find((f) => f.featureName === runtimeName) || null;
    // resolved 无 layers 视为加载失败（两态判定依赖层队列）
    if (!Array.isArray(resolvedRes?.layers)) throw new Error(_fsT('配置层读取失败', 'failed to load config layers'));
    _fsSettings.manifest = entry;
    _fsSettings.resolved = resolvedRes;
    _fsSettings.displayName = entry?.manifest?.name || runtimeName;
  } catch (err) {
    _fsSettings.error = String(err?.message || err);
  } finally {
    _fsSettings.busy = false;
    _fsSettingsRender();
  }
};

/** 弹窗宿主：挂在 body 下的独立 overlay（叠加在商店/插件管理器弹窗之上）。 */
function _fsSettingsHost() {
  let host = document.getElementById('ph-plugin-settings-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ph-plugin-settings-host';
    document.body.appendChild(host);
  }
  return host;
}

/** 当前编辑层的 sparse（resolved 缓存中取，PUT 整层写回的基底）。 */
function _fsSettingsTargetSparse() {
  const layer = (_fsSettings.resolved?.layers || []).find((l) => l.id === _fsSettings.scopeId);
  return layer?.sparse && typeof layer.sparse === 'object' ? layer.sparse : {};
}

/** 字段行 HTML：label/description 双语取 manifest 声明，控件按 type 分发。 */
function _fsSettingsRowHtml(row) {
  const prop = row.prop || {};
  const isZh = currentLanguage === 'zh';
  const label = (prop.label && (isZh ? prop.label.zh : prop.label.en)) || row.key.split('.').pop();
  const desc = prop.description && (isZh ? prop.description.zh : prop.description.en);
  const takeover = row.state?.status === 'takeover';
  const controlValue = row.controlValue == null ? '' : String(row.controlValue);
  let control = '';
  if (prop.type === 'boolean') {
    control = '<input type="checkbox" data-action="featureStore.settingsField" data-event="change" data-key="'
      + escapeHtml(row.key) + '"' + (row.controlValue ? ' checked' : '') + '>';
  } else if (prop.type === 'number') {
    control = '<input type="number" class="fs-settings-input" data-action="featureStore.settingsField" data-event="change" data-key="'
      + escapeHtml(row.key) + '" value="' + escapeHtml(controlValue) + '">';
  } else {
    control = '<input type="text" class="fs-settings-input" data-action="featureStore.settingsField" data-event="change" data-key="'
      + escapeHtml(row.key) + '" value="' + escapeHtml(controlValue) + '">';
  }
  const followHint = takeover
    ? '<span class="fs-settings-state">' + escapeHtml(_fsT('本层已接管', 'overridden here')) + '</span>'
    : (row.upstreamLabel
      ? '<span class="fs-settings-state fs-settings-follow">' + escapeHtml(_fsT('跟随 ', 'follows ') + row.upstreamLabel) + '</span>'
      : '<span class="fs-settings-state fs-settings-follow">' + escapeHtml(_fsT('默认值', 'default')) + '</span>');
  const resetBtn = row.showReset
    ? '<button type="button" class="fs-settings-reset" data-action="featureStore.settingsReset" data-key="'
      + escapeHtml(row.key) + '" title="' + escapeHtml(_fsT('恢复为上级配置', 'Reset to upstream value')) + '">'
      + escapeHtml(_fsT('重置', 'Reset')) + '</button>'
    : '';
  return '<div class="fs-settings-row' + (takeover ? ' fs-settings-row-takeover' : '') + '">'
    + '<div class="fs-settings-row-label">'
    + '<div class="fs-settings-name">' + escapeHtml(label) + '</div>'
    + (desc ? '<div class="fs-settings-desc">' + escapeHtml(desc) + '</div>' : '')
    + '</div>'
    + '<div class="fs-settings-row-control">' + control + followHint + resetBtn + '</div>'
    + '</div>';
}

function _fsSettingsRender() {
  const host = _fsSettingsHost();
  if (!_fsSettings.open) { host.innerHTML = ''; return; }
  const rows = _fsSettings.manifest ? _fsSettingsRows(_fsSettings.manifest, _fsSettings.resolved, _fsSettings.scopeId) : null;
  const tabs = _fsSettings.hasIdentity
    ? '<div class="fs-settings-tabs">'
      + '<button type="button" class="fs-settings-tab' + (_fsSettings.scopeId === 'global' ? ' active' : '') + '" data-action="featureStore.settingsTab" data-scope="global">' + escapeHtml(_fsT('全局默认', 'Global default')) + '</button>'
      + '<button type="button" class="fs-settings-tab' + (_fsSettings.scopeId === 'agent' ? ' active' : '') + '" data-action="featureStore.settingsTab" data-scope="agent">' + escapeHtml(_fsT('本空间（' + _fsSettings.identityLabel + '）', 'This workspace (' + _fsSettings.identityLabel + ')')) + '</button>'
      + '</div>'
    : '<div class="fs-settings-hint">' + escapeHtml(_fsT('全局默认配置，对所有工作空间生效；单个工作空间的覆盖在对应空间的插件商店卡片中设置', 'Global defaults for all workspaces; per-workspace overrides are edited in that workspace\'s plugin store')) + '</div>';
  let bodyHtml = '';
  if (_fsSettings.busy) {
    bodyHtml = '<div class="fs-spinner-wrap"><div class="fs-spinner"></div></div>';
  } else if (_fsSettings.error) {
    bodyHtml = '<div class="fs-error-banner">' + escapeHtml(_fsSettings.error) + '</div>';
  } else if (_fsSettings.manifest == null) {
    bodyHtml = '<div class="fs-settings-empty">' + escapeHtml(_fsT('该插件没有声明可配置参数', 'This plugin declares no configurable settings')) + '</div>';
  } else if (!rows || !rows.length) {
    bodyHtml = '<div class="fs-settings-empty">' + escapeHtml(_fsT('该插件没有声明可配置参数', 'This plugin declares no configurable settings')) + '</div>';
  } else {
    bodyHtml = rows.map(_fsSettingsRowHtml).join('');
  }
  host.innerHTML = '<div class="feature-detail-overlay" data-fs-settings-overlay>'
    + '<div class="feature-detail-window ph-settings-window" style="position:relative;max-width:560px;">'
    + '<div class="ph-settings-header">'
    + '<div class="ph-settings-title">' + escapeHtml(_fsSettings.displayName)
    + ' <span class="feature-detail-id">' + escapeHtml(_fsSettings.runtimeName) + '</span></div>'
    + '<button type="button" class="ph-settings-close" data-action="featureStore.closeSettings" title="' + escapeHtml(_fsT('关闭', 'Close')) + '">&#215;</button>'
    + '</div>'
    + tabs
    + '<div class="fs-settings-body">' + bodyHtml + '</div>'
    + '</div>'
    + '</div>';
}

/** 层 tab 切换：重渲染（resolved 已缓存，无网络往返）。 */
function _fsSettingsSwitchTab(scopeId) {
  if (scopeId !== 'global' && scopeId !== 'agent') return;
  if (scopeId === 'agent' && !_fsSettings.hasIdentity) return;
  _fsSettings.scopeId = scopeId;
  _fsSettingsRender();
}

/**
 * 即时保存（与 Feature 配置编辑器同模型）：单字段写入 → 以当前层 sparse
 * 为底构造整层内容 → PUT layer → 重拉 resolved（上游状态变化会联动其他行）。
 * value === null 为重置（删除本层字段，恢复跟随）。
 */
const _fsSettingsSave = async function(fullKey, value) {
  const content = fsWithField(_fsSettingsTargetSparse(), fullKey, value);
  try {
    const res = await fetch('/protoclaw/feature_config/layer', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: _fsSettings.agentId, layerId: _fsSettings.scopeId, content }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || `${res.status} ${res.statusText}`);
    const agentId = encodeURIComponent(_fsSettings.agentId);
    _fsSettings.resolved = await _fsFetchJson(`/protoclaw/feature_config/resolved?agentId=${agentId}`);
  } catch (err) {
    _fsSettings.error = String(err?.message || err);
  }
  _fsSettingsRender();
};

window._fsCloseSettings = function() {
  _fsSettings.open = false;
  _fsSettingsRender();
};

window.ClawFW.actions.registerMany({
  'featureStore.openSettings': (el) => window._fsOpenSettings(el.dataset.name, el.dataset.identity || null, { initialScope: el.dataset.scope }),
  'featureStore.closeSettings': () => window._fsCloseSettings(),
  'featureStore.settingsTab': (el) => _fsSettingsSwitchTab(el.dataset.scope),
  'featureStore.settingsReset': (el) => _fsSettingsSave(el.dataset.key, null),
  'featureStore.settingsField': (el) => {
    let value;
    if (el.type === 'checkbox') value = !!el.checked;
    else if (el.type === 'number') value = el.value === '' ? null : Number(el.value);
    else value = el.value;
    if (value === null) { el.classList.add('fs-input-error'); return; }
    _fsSettingsSave(el.dataset.key, value);
  },
});
