/**
 * feature-store.js — Feature 仓库选择面板（通用组件，类似系统相册 API）
 *
 * 身份由打开上下文决定（phOpenFeatureStore('main' | 'coder')），面板内不切换身份。
 * 选择/移除后写回对应身份配置层的 $mount 声明；新会话生效（runtime 创建时挂载）。
 *
 * 数据面：
 *   GET /api/feature-store/overview —— 包列表 + 两身份已装配清单（含 missing）
 * 写回复用配置层通道（$mount 与配置值同层同文件）：
 *   GET /protoclaw/feature_config/resolved → 定位层 sparse → diff → PUT layer
 *
 * 外部依赖（通过全局作用域）：
 *   - escapeHtml (app-ui.js)
 *   - currentLanguage (app-core.js)
 *   - window._phRefreshMountsView (ph-model-config.js，写操作后刷新挂载管理页)
 */

const _FS_IDENTITY_SCOPES = {
  main: { agentId: 'programming-helper', layerId: 'agent', labelZh: '编程小助手', labelEn: 'Programming Helper' },
  coder: { agentId: 'coder', layerId: 'coder', labelZh: 'Coder', labelEn: 'Coder' },
};

let _fsState = {
  open: false,
  identity: 'main',
  overview: null,
  error: '',
  busy: false, // 单飞：安装/卸载进行中禁用操作按钮
};

function _fsT(zh, en) {
  return (typeof currentLanguage !== 'undefined' && currentLanguage === 'zh') ? zh : en;
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
  if (!res.ok) throw new Error(payload.error || `${res.status} ${res.statusText}`);
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

// ── 动作（inline onclick 入口）─────────────────────────────────

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
  // 底层挂载管理页若开着，同步刷新（写操作可能来自商店外的移除按钮）
  if (typeof window._phRefreshMountsView === 'function') window._phRefreshMountsView();
  // 右侧 Features 面板的来源分类消费同一份装配事实，强制失效缓存重拉
  const fc = window.ClawFW && window.ClawFW.featureCatalog;
  if (fc && typeof fc.refreshMountFacts === 'function') fc.refreshMountFacts();
}

// 写操作共用单飞 + 完成后一次重渲染：busy 只防重入/并发写竞态，
// 不做中途渲染（按钮不闪烁、无"处理中"浮层）。
window._fsInstall = async function(packageName, version) {
  if (_fsState.busy) return;
  _fsState.busy = true;
  try {
    await _fsMutateLayer(_fsState.identity, (sparse) => {
      const runtimeKey = _fsRuntimeKey(packageName);
      sparse[runtimeKey] = {
        ...(sparse[runtimeKey] && typeof sparse[runtimeKey] === 'object' ? sparse[runtimeKey] : {}),
        $mount: { package: packageName, version },
      };
    });
    await _fsAfterChange();
  } catch (err) {
    _fsState.error = String(err?.message || err);
  } finally {
    _fsState.busy = false;
    _fsRender();
  }
};

window._fsInstallBuiltin = async function(runtimeName) {
  if (_fsState.busy) return;
  _fsState.busy = true;
  try {
    await _fsMutateLayer(_fsState.identity, (sparse) => {
      sparse[runtimeName] = {
        ...(sparse[runtimeName] && typeof sparse[runtimeName] === 'object' ? sparse[runtimeName] : {}),
        $mount: { kind: 'builtin' },
      };
    });
    await _fsAfterChange();
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
    await _fsAfterChange();
  } catch (err) {
    _fsState.error = String(err?.message || err);
  } finally {
    _fsState.busy = false;
    _fsRender();
  }
};

window._fsSelectVersion = function(packageName, selectEl) {
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

function _fsRenderMountedSection(mountedMap) {
  const entries = Object.entries(mountedMap);
  if (!entries.length) return '';
  const builtinItems = new Map(
    (_fsState.overview?.builtin || []).map((item) => [item.runtimeName, item]),
  );
  const packageNames = new Map(
    (_fsState.overview?.packages || []).map((pkg) => [_fsRuntimeKey(pkg.package), pkg]),
  );
  const items = entries.map(([runtimeName, mount]) => {
    // builtin 装配无 package/version（不走 tgz 仓库），徽章显示来源而非包坐标
    const status = mount.missing
      ? '<span class="feature-badge status-removed">' + escapeHtml(_fsT('包已不在仓库', 'missing')) + '</span>'
      : (mount.kind === 'builtin'
        ? '<span class="feature-prov-badge">' + escapeHtml(_fsT('扩展', 'extension')) + '</span>'
        : '<span class="feature-prov-badge">' + escapeHtml(`${mount.package}@${mount.version}`) + '</span>');
    const btn = '<button type="button" class="fs-list-remove" title="' + escapeHtml(_fsT('移除', 'Remove')) + '" onclick="window._fsRemoveFor(\'' + escapeHtml(_fsState.identity) + '\', \'' + escapeHtml(runtimeName) + '\')">&#215;</button>';
    // displayName 与可安装区同源（builtin title / 包 displayName），查不到落回 runtime 名
    const pkg = packageNames.get(runtimeName);
    const displayName = (mount.kind === 'builtin' ? builtinItems.get(runtimeName)?.title : pkg?.displayName) || runtimeName;
    return _fsCard({
      name: runtimeName,
      displayName,
      description: '',
      surface: mount.kind === 'builtin' ? (builtinItems.get(runtimeName)?.surface || null) : null,
    }, status + btn);
  }).join('');
  return '<div class="fs-mounted-section"><div class="fs-section-title">' + escapeHtml(_fsT('已装配', 'Installed')) + '</div>'
    + '<div class="feature-grid ph-mount-grid">' + items + '</div></div>';
}

/**
 * 可安装区：builtin 扩展 + tgz 包合并为统一 item，按 catalog 功能类型分组
 * （能力/会话与行为/渠道与交互/系统组件），组织与挂载管理页同源。
 * 分组折叠默认态由 catalog 词表携带（system 折叠）；商店弹窗生命周期短，
 * 折叠偏好的跨重渲染记忆省略（busy 切换重渲染会重置折叠态）。
 */
function _fsRenderInstallSections(mountedMap, mountedByPackage) {
  const identity = _fsState.identity;
  const items = [];
  for (const item of (_fsState.overview?.builtin || [])) {
    // 已装配的不再进入可安装货架（装配状态见上方"已装配"区）
    if (mountedMap[item.runtimeName]) continue;
    if (!(item.identities || []).includes(identity)) continue;
    items.push({
      name: item.runtimeName,
      displayName: item.title || item.runtimeName,
      description: item.description || '',
      surface: item.surface || null,
      control: '<button type="button" class="fs-list-add" onclick="window._fsInstallBuiltin(\'' + escapeHtml(item.runtimeName) + '\')">' + escapeHtml(_fsT('+ 添加', '+ Add')) + '</button>',
    });
  }
  for (const pkg of (_fsState.overview?.packages || [])) {
    const runtimeKey = _fsRuntimeKey(pkg.package);
    // 已装配的包不再进入可安装货架
    if (mountedByPackage.has(pkg.package)) continue;
    const versionOptions = (pkg.versions || []).map((v) =>
      '<option value="' + escapeHtml(v.version) + '">' + escapeHtml(v.version) + '</option>'
    ).join('');
    const latest = pkg.versions?.[0]?.version || '';
    const control = (pkg.versions?.length > 1
      ? '<select class="fs-select" onchange="window._fsSelectVersion(\'' + escapeHtml(pkg.package) + '\', this)">' + versionOptions + '</select>'
      : '<span style="font-size:12px;color:var(--text-secondary);">' + escapeHtml(latest) + '</span>')
      + '<button type="button" class="fs-list-add" onclick="window._fsInstall(\'' + escapeHtml(pkg.package) + '\', (this.closest(\'[data-fs-package]\')?.dataset.fsVersion || \'' + escapeHtml(latest) + '\'))">' + escapeHtml(_fsT('+ 添加', '+ Add')) + '</button>';
    items.push({
      name: runtimeKey,
      displayName: pkg.displayName || runtimeKey,
      description: pkg.description || pkg.package,
      surface: null, // 仓库包装配无声明面计数（与挂载管理页同口径）
      control,
      extraAttr: ' data-fs-package="' + escapeHtml(pkg.package) + '" data-fs-version="' + escapeHtml(pkg.versions?.[0]?.version || '') + '"',
    });
  }
  if (!items.length) {
    return '<div class="ph-settings-empty" style="padding:24px 0;">' + escapeHtml(_fsT(
      '没有可安装的插件：仓库暂无新包，或可用的都已装配。',
      'Nothing to install: the repository has no new packages, or everything available is already installed.'
    )) + '</div>';
  }

  const fc = window.ClawFW && window.ClawFW.featureCatalog;
  const catalog = _fsCatalog();
  // enrich 兼容形状：声明面计数喂给能力推导（商店不提供能力筛选，仅供分组一致性）
  const features = items.map((item) => ({
    name: item.name,
    description: item.description,
    tools: [],
    toolCount: item.surface ? item.surface.tools : 0,
    hookCount: item.surface ? item.surface.hooks : 0,
    skillCount: item.surface ? item.surface.skills : undefined,
    _item: item,
  }));
  const commandFeatures = new Map(
    items.filter((i) => i.surface && i.surface.commands > 0).map((i) => [i.name, i.surface.commands]),
  );
  const groups = (fc && catalog)
    ? fc.groupFeaturesByType(features, catalog, 'all', 'all', { commandFeatures })
    : (features.length ? [{ id: '_unmapped', features }] : []);

  // 单一非兜底组时不渲染组头（面板同款）
  const suppressHeaders = groups.length === 1 && groups[0].id !== '_unmapped';
  const buildCard = function(f) {
    return _fsCard(f._item, f._item.control, f._item.extraAttr);
  };
  const buildGroup = function(group) {
    const grid = '<div class="feature-grid ph-mount-grid">' + group.features.map(buildCard).join('') + '</div>';
    if (suppressHeaders) return grid;
    const isOpen = !(fc && fc.typeCollapsedByDefault(group.id, catalog));
    return '<details class="feature-group"' + (isOpen ? ' open' : '') + '>'
      + '<summary class="feature-group-bar">'
      + '<span class="feature-group-chev" aria-hidden="true"></span>'
      + '<span class="feature-group-title">' + escapeHtml(t(group.id === '_unmapped' ? 'feature_cat_unmapped' : 'feature_type_' + group.id)) + '</span>'
      + '<span class="feature-group-count">' + String(group.features.length) + '</span>'
      + '</summary>'
      + grid
      + '</details>';
  };
  return '<div class="fs-section-title">' + escapeHtml(_fsT('可安装', 'Available')) + '</div>'
    + groups.map(buildGroup).join('');
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
    body = _fsRenderMountedSection(mountedMap) + _fsRenderInstallSections(mountedMap, mountedByPackage);
  }

  const errorBanner = (_fsState.error && _fsState.overview)
    ? '<div class="fs-error-banner">' + escapeHtml(_fsState.error) + '</div>'
    : '';

  host.innerHTML = [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window ph-settings-window" style="position:relative;">',
    '<div class="feature-detail-head">',
    '<div style="display:flex;align-items:center;gap:4px;">',
    '<button class="feature-detail-close" type="button" title="' + _fsT('返回', 'Back') + '" onclick="window.phCloseFeatureStore()" style="margin-right:8px;font-size:16px;"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"></path><path d="M19 12H5"></path></svg></button>',
    '<div>',
    '<div class="feature-detail-title">' + escapeHtml(_fsT('添加 Feature', 'Add Feature')) + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(_fsT(
      '从 Feature 仓库为 ' + _fsT(scope.labelZh, scope.labelEn) + ' 装配插件；对新会话生效',
      'Install plugins for ' + _fsT(scope.labelZh, scope.labelEn) + ' from the feature repository; takes effect on new sessions',
    )) + '</div>',
    '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" onclick="window.phCloseFeatureStore()">&times;</button>',
    '</div>',
    errorBanner,
    // 复用挂载管理页同款主体容器（24px 左右缘 + flex gap 14px 分组间距）
    '<div class="ph-mounts-body" style="overflow-y:auto;flex:1;">' + body + '</div>',
    '</div>',
    '</div>',
  ].join('');
}

// ── 面板开关（ph-model-config 的入口卡片调用）────────────────

window.phOpenFeatureStore = async function(identity) {
  _fsState.open = true;
  // 身份由打开上下文决定（配置编辑器/挂载管理页传入）；未传时默认 main
  _fsState.identity = _FS_IDENTITY_SCOPES[identity] ? identity : 'main';
  _fsState.overview = null;
  _fsState.error = '';
  _fsState.busy = false;
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

window.phCloseFeatureStore = function() {
  _fsState.open = false;
  _fsState.busy = false;
  _fsRender();
};
