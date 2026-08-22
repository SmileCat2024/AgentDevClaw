/**
 * Feature Setup UI 模块
 *
 * Ticket 06：多作用域三态配置编辑器（VS Code Settings 范式）。
 * - 作用域选择器：全局 + 编程小助手各目录（来自 resolved API 的 layers 与 phProjects）
 * - 数据源：GET /protoclaw/feature_config/resolved?agentId=...&dir=...
 *   （layers[].sparse / merged / provenance / warnings / sensitiveFields，ticket 05）
 * - 三态判定（每字段，前端不自算合并）：
 *     覆盖   = 本层 sparse 存在该字段（存在即覆盖，D8）
 *     继承   = 本层无 + 上游层有 → 显示上游生效值 + "继承自 <层名>"
 *     出厂默认 = 本层无 + 上游无 → 灰显，值取 manifest default（虚拟第 0 层）
 * - 保存 = diff only（D9）：只提交本次会话碰过的字段（含显式重置）构成的
 *   该层稀疏内容，PUT /protoclaw/feature_config/layer。未碰字段绝不写入。
 * - 值同提示（D8）：改出的值 == 上游生效值时，保存前二选一
 *   "清除本层覆盖（继承）" / "保留锁定（pin）"
 * - warnings 透出：面板顶部提示条
 *
 * 三态分类 / dirty 叠加 / 保存 payload / 值同判定等纯逻辑提取在
 * feature-setup-core.js（先于本文件加载，测试见 test/feature-setup-core.test.js）。
 *
 * 导出: isSystemFeatureConfigBlock, renderSystemFeatureConfigBlock
 */

// ── Block detection ──────────────────────────────────────────

function isSystemFeatureConfigBlock(block) {
  return getCurrentAgentRecord()?.id === 'feature-setup' && block?.type === 'system-feature-config';
}

// ── Main render ──────────────────────────────────────────────

function renderSystemFeatureConfigBlock(_block) {
  window._loadFeatureSetupData();
  return `
    <div class="fs-app">
      <div class="fs-side">
        <div class="fs-scopebar" id="fs-scopebar"><div class="fs-nav-loading">...</div></div>
        <nav class="fs-nav" id="fs-nav"><div class="fs-nav-loading">...</div></nav>
      </div>
      <main class="fs-main" id="fs-main">
        <div class="fs-spinner-wrap"><div class="fs-spinner"></div></div>
      </main>
    </div>
  `;
}

// ── State ────────────────────────────────────────────────────
//
// dirty: Map<fullKey, { value }> — 本次会话碰过的字段。
//   value === null 表示"重置为继承"（从本层稀疏内容删除该字段）；
//   其余为用户改出的新值。保存时以原始 sparse 为底，仅套用 dirty。

window._featureSetupData = {
  manifests: null,
  loading: false,
  sections: [],
  activeId: null,
  shellAvailability: null,
  resolved: null,
  resolvedError: null,
  scopes: [],
  activeScopeId: 'global',
  dirty: new Map(),
};

const FS_SCOPE_AGENT_ID = 'programming-helper';

function _fsT(zh, en) {
  return (typeof currentLanguage !== 'undefined' && currentLanguage === 'zh') ? zh : en;
}

// ── Data loading ─────────────────────────────────────────────

window._loadFeatureSetupData = async function () {
  if (window._featureSetupData.loading) return;
  window._featureSetupData.loading = true;
  try {
    const [mRes, saRes] = await Promise.all([
      fetch('/protoclaw/system_feature_manifests'),
      fetch('/protoclaw/shell_availability'),
    ]);
    window._featureSetupData.manifests = (await mRes.json()).features || [];
    try { window._featureSetupData.shellAvailability = await saRes.json(); } catch { window._featureSetupData.shellAvailability = null; }
    _buildSections();
    await _fsSwitchScope(window._featureSetupData.activeScopeId || 'global', { force: true });
  } catch (err) {
    console.error('Failed to load feature setup data:', err);
    const el = document.getElementById('fs-main');
    if (el) el.innerHTML = `<div class="fs-main-error">${_fsT('加载失败', 'Failed to load')}: ${escapeHtml(String(err?.message || err))}</div>`;
  } finally {
    window._featureSetupData.loading = false;
  }
};

async function _fsFetchResolved(scopeId) {
  const params = new URLSearchParams({ agentId: FS_SCOPE_AGENT_ID });
  if (typeof scopeId === 'string' && scopeId.startsWith('dir:')) {
    params.set('dir', scopeId.slice(4));
  }
  const res = await fetch(`/protoclaw/feature_config/resolved?${params.toString()}`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

// ── Scope list (全局 + 编程小助手各目录) ──────────────────────

function _fsGetAgentRecord() {
  return typeof getCurrentAgentRecord === 'function' ? getCurrentAgentRecord() : null;
}

/** 收集编程小助手的目录列表（phProjects / openDirectory / 会话索引），去重保序。 */
function _fsCollectDirs() {
  const dirs = new Map(); // normKey -> 原始目录串
  const add = (dir) => {
    const v = String(dir || '').trim();
    if (!v) return;
    const key = v.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (!dirs.has(key)) dirs.set(key, v);
  };
  const rec = _fsGetAgentRecord();
  if (rec?.id === FS_SCOPE_AGENT_ID) {
    add(rec.workspace_state?.openDirectory);
    const phProjects = Array.isArray(rec.workspace_state?.phProjects) ? rec.workspace_state.phProjects : [];
    for (const p of phProjects) add(p?.openDirectory);
    const sessions = Array.isArray(rec.workspace_sessions?.sessions) ? rec.workspace_sessions.sessions : [];
    for (const s of sessions) add(s?.openDirectory);
  }
  return [...dirs.values()].sort((a, b) => a.localeCompare(b));
}

function _fsBuildScopes(resolved) {
  return fsBuildScopes(resolved, _fsCollectDirs(), _fsT);
}

// ── Scope switch ─────────────────────────────────────────────

window._fsSwitchScope = async function (scopeId, opts) {
  const st = window._featureSetupData;
  if (!opts?.force && scopeId === st.activeScopeId && st.resolved) return;
  if (!st.loading && _fsHasDirty() && scopeId !== st.activeScopeId) {
    if (!window.confirm(_fsT(
      '当前作用域有未保存的修改，切换将丢弃这些修改。确定切换吗？',
      'The current scope has unsaved changes. Switching will discard them. Continue?'
    ))) return;
  }
  st.activeScopeId = scopeId;
  st.dirty = new Map();
  st.resolved = null;
  st.resolvedError = null;
  try {
    st.resolved = await _fsFetchResolved(scopeId);
  } catch (err) {
    st.resolvedError = String(err?.message || err);
  }
  st.scopes = _fsBuildScopes(st.resolved);
  _renderScopeBar();
  if (st.sections.length) window._fsSelect(st.activeId || st.sections[0].id);
};

function _renderScopeBar() {
  const el = document.getElementById('fs-scopebar');
  if (!el) return;
  const st = window._featureSetupData;
  const options = st.scopes.map((s) =>
    `<option value="${escapeHtml(s.id)}"${s.id === st.activeScopeId ? ' selected' : ''}>${escapeHtml(s.label)}</option>`
  ).join('');
  el.innerHTML = `
    <div class="fs-scopebar-label">${_fsT('作用域', 'Scope')}</div>
    <select class="fs-scope-select" id="fs-scope-select" onchange="window._fsSwitchScope(this.value)">${options}</select>
    <div class="fs-scopebar-hint" id="fs-scope-hint"></div>
  `;
  const hint = document.getElementById('fs-scope-hint');
  if (hint) {
    const scope = st.scopes.find((s) => s.id === st.activeScopeId);
    hint.textContent = scope?.dir
      ? scope.dir
      : _fsT('所有工作空间共用的基础层', 'Base layer shared by all workspaces');
  }
}

// ── Build section-level nav items ────────────────────────────

function _buildSections() {
  const { manifests } = window._featureSetupData;
  const sections = [];

  for (const feature of manifests) {
    const featureName = feature.featureName;
    const manifest = feature.manifest;
    const props = manifest.settings?.properties || {};
    const manifestSections = manifest.settings?.sections;

    if (manifestSections) {
      for (const sec of manifestSections) {
        sections.push({
          id: `${featureName}__${sec.id}`,
          title: sec.title,
          icon: sec.id === 'runtimes' ? '⚙' : '▣',
          featureName,
          propKeys: sec.properties,
          props,
        });
      }
    } else {
      sections.push({
        id: featureName,
        title: featureName,
        icon: '⚙',
        featureName,
        propKeys: Object.keys(props),
        props,
      });
    }
  }

  window._featureSetupData.sections = sections;
  _renderNav(sections);
}

// ── Render nav ───────────────────────────────────────────────

function _renderNav(sections) {
  const navEl = document.getElementById('fs-nav');
  if (!navEl) return;
  navEl.innerHTML = sections.map(s =>
    `<div class="fs-nav-item" data-id="${escapeHtml(s.id)}" onclick="window._fsSelect('${s.id}')">
      <span class="fs-nav-icon">${s.icon}</span>
      <span class="fs-nav-text">${escapeHtml(s.title)}</span>
    </div>`
  ).join('');
}

// ── Three-state classification（判定数据全部来自 resolved，前端不自算合并）──
// 纯逻辑在 feature-setup-core.js（fsClassifyField / fsFieldStates / fsApplyDirty）。

function _fsLayers() {
  const layers = window._featureSetupData.resolved?.layers;
  return Array.isArray(layers) ? layers : [];
}

/** 全部 manifest 字段的三态表（不含 dirty）。 */
function _fsFieldStates() {
  const st = window._featureSetupData;
  return fsFieldStates(st.sections, _fsLayers(), st.activeScopeId);
}

/** 叠加本次会话 dirty 后的渲染用三态表。 */
function _fsEffectiveStates() {
  return fsApplyDirty(_fsFieldStates(), window._featureSetupData.dirty);
}

// ── Select section → render right panel ──────────────────────

window._fsSelect = function (id) {
  const st = window._featureSetupData;

  st.activeId = id;

  document.querySelectorAll('.fs-nav-item').forEach(el =>
    el.classList.toggle('active', el.getAttribute('data-id') === id)
  );

  const sec = st.sections.find(s => s.id === id);
  if (!sec) return;

  const mainEl = document.getElementById('fs-main');
  if (!mainEl) return;

  const states = _fsEffectiveStates();
  const disabled = !!st.resolvedError || !st.resolved;

  let cardsHtml = '';
  for (const key of sec.propKeys) {
    const prop = sec.props[key];
    if (!prop) continue;
    if (prop.type === 'group') {
      cardsHtml += _renderGroupCard(key, prop, sec.featureName, states, disabled);
    } else {
      cardsHtml += _renderSingleCard(key, prop, sec.featureName, states, disabled);
    }
  }

  const warnings = Array.isArray(st.resolved?.warnings) ? st.resolved.warnings : [];
  const warnHtml = warnings.length
    ? `<div class="fs-warnings">${warnings.map(w =>
        `<div class="fs-warning-item">${escapeHtml(String(w?.message || w?.fieldPath || w))}</div>`
      ).join('')}</div>`
    : '';
  const errHtml = st.resolvedError
    ? `<div class="fs-error-banner">${_fsT('读取配置层失败', 'Failed to load config layers')}: ${escapeHtml(st.resolvedError)}</div>`
    : '';

  mainEl.innerHTML = `
    <div class="fs-content">
      ${errHtml}
      ${warnHtml}
      <div class="fs-cards">${cardsHtml}</div>
      <div class="fs-savebar" id="fs-savebar">
        <span class="fs-save-count" id="fs-save-count"></span>
        <button type="button" class="fs-save-btn" id="fs-save-btn" onclick="window._fsSave()"${disabled ? ' disabled' : ''}>${_fsT('保存', 'Save')}</button>
      </div>
    </div>
    <div class="fs-auto-save-status" id="fs-auto-save-status"></div>
  `;
  mainEl.scrollTop = 0;
  _attachShowWhenListeners(mainEl);
  _attachChangeListeners(mainEl);
  _fsUpdateSaveBar();

  // Shell-specific: apply availability indicators
  if (sec.featureName === 'shell') {
    _applyShellAvailability();
  }
};

// ── Group card (e.g. a server with mode/binary/runtime) ──────

function _renderGroupCard(key, prop, featureName, states, disabled) {
  const subProps = prop.properties || {};
  let rowsHtml = '';
  for (const [sk, sp] of Object.entries(subProps)) {
    const fullKey = `${featureName}.${key}.${sk}`;
    rowsHtml += _renderRow(sp, fullKey, states.get(fullKey), disabled);
  }
  return `
    <div class="fs-group">
      <div class="fs-group-title">${escapeHtml(prop.title || key)}</div>
      <div class="fs-card">
        ${rowsHtml}
      </div>
    </div>
  `;
}

// ── Single property card ─────────────────────────────────────

function _renderSingleCard(key, prop, featureName, states, disabled) {
  const fullKey = `${featureName}.${key}`;
  return `
    <div class="fs-card">
      ${_renderRow(prop, fullKey, states.get(fullKey), disabled)}
    </div>
  `;
}

// ── Row: title+desc | control，含三态标注 ─────────────────────

function _fsDisplayValue(v) {
  if (v === undefined) return _fsT('（无默认值）', '(no default)');
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? v.join(', ') : _fsT('（空）', '(empty)');
  if (v === '') return _fsT('（空串）', '""');
  return String(v);
}

function _renderRow(prop, fullKey, state, disabled) {
  const sw = prop.showWhen ? ` style="display:none;" data-showwhen='${JSON.stringify(prop.showWhen)}'` : '';
  const status = state?.status || 'default';
  const value = fsControlValue(state, prop);

  let noteHtml;
  if (status === 'inherit') {
    const from = state.upstream?.label || '';
    noteHtml = `<div class="fs-state-note fs-note-inherit">${_fsT('继承自', 'Inherited from')} ${escapeHtml(from)} = ${escapeHtml(_fsDisplayValue(state.upstream?.value))}</div>`;
  } else if (status === 'override') {
    const up = state.upstream;
    const upLabel = up?.kind === 'layer' ? up.label : _fsT('出厂默认', 'factory default');
    const upVal = up?.kind === 'layer' ? up.value : prop.default;
    const hover = `${_fsT('上游生效值', 'Upstream value')} (${upLabel}): ${_fsDisplayValue(upVal)}`;
    noteHtml = `
      <div class="fs-state-note fs-note-override" title="${escapeHtml(hover)}">
        ${_fsT('已覆盖', 'Overridden')} · ${_fsT('上游', 'upstream')}: ${escapeHtml(upLabel)} = ${escapeHtml(_fsDisplayValue(upVal))}
        <button type="button" class="fs-reset-btn" onclick="window._fsResetField('${escapeHtml(fullKey)}')">${_fsT('重置为继承', 'Reset to inherit')}</button>
      </div>
    `;
  } else {
    noteHtml = `<div class="fs-state-note fs-note-default">${_fsT('出厂默认', 'Factory default')} = ${escapeHtml(_fsDisplayValue(prop.default))}</div>`;
  }

  return `
    <div class="fs-row fs-state-${status}"${sw} data-prop-key="${escapeHtml(fullKey)}">
      <div class="fs-row-main">
        <div class="fs-row-title">${escapeHtml(prop.title || '')}</div>
        ${prop.description ? `<div class="fs-row-desc">${escapeHtml(prop.description)}</div>` : ''}
        ${noteHtml}
      </div>
      <div class="fs-row-ctrl">${_renderInput(fullKey, prop, value, disabled)}</div>
    </div>
  `;
}

// ── Input controls ───────────────────────────────────────────

function _isListType(prop) {
  return prop.type === 'directory'
    || (prop.type === 'file' && (Array.isArray(prop.default) || prop.maxItems != null));
}

function _renderListInput(fullKey, prop, value, dis) {
  const items = Array.isArray(value)
    ? value.filter(v => v != null && String(v).trim() !== '')
    : [];
  const maxItems = prop.maxItems || 99;
  const placeholder = prop.placeholder || _fsT('输入路径...', 'Enter path...');
  const addLabel = _fsT('添加', 'Add');
  const removeLabel = _fsT('移除', 'Remove');
  const browseLabel = _fsT('浏览...', 'Browse...');
  const showBrowse = prop.type === 'directory';

  function _listItemHtml(val) {
    return `<div class="fs-list-item">`
      + `<input type="text" class="fs-input fs-list-input" data-config-key="${escapeHtml(fullKey)}" value="${escapeHtml(String(val))}" placeholder="${escapeHtml(placeholder)}"${dis} />`
      + (showBrowse ? `<button type="button" class="fs-list-browse" title="${escapeHtml(browseLabel)}" onclick="window._fsBrowseDir(this)">&#128193;</button>` : '')
      + `<button type="button" class="fs-list-remove" title="${escapeHtml(removeLabel)}" onclick="window._fsListRemoveItem(this)">&#215;</button>`
      + `</div>`;
  }

  const itemsHtml = items.map(_listItemHtml).join('');

  return `
    <div class="fs-list" data-list-key="${escapeHtml(fullKey)}" data-list-max="${maxItems}" data-list-placeholder="${escapeHtml(placeholder)}" data-list-type="${escapeHtml(prop.type || '')}">
      ${itemsHtml}
      <button type="button" class="fs-list-add" ${items.length >= maxItems ? 'disabled' : ''} onclick="window._fsListAddItem(this)">+ ${escapeHtml(addLabel)}</button>
    </div>
  `;
}

function _renderInput(fullKey, prop, value, disabled) {
  const dis = disabled ? ' disabled' : '';
  if (_isListType(prop)) {
    return _renderListInput(fullKey, prop, value, dis);
  }

  const id = `fsp-${_cssid(fullKey)}`;
  const val = value != null ? String(value) : (prop.default != null ? String(prop.default) : '');

  switch (prop.type) {
    case 'select': {
      let h = `<select id="${id}" class="fs-select" data-config-key="${escapeHtml(fullKey)}"${dis}>`;
      if (prop.options) {
        for (const o of prop.options) {
          h += `<option value="${escapeHtml(String(o.value))}"${String(o.value) === val ? ' selected' : ''}>${escapeHtml(o.label)}</option>`;
        }
      }
      return h + `</select>`;
    }
    case 'file':
      return `<input type="text" id="${id}" class="fs-input" data-config-key="${escapeHtml(fullKey)}" value="${escapeHtml(val)}" placeholder="${escapeHtml(prop.placeholder || '')}"${dis} />`;
    case 'boolean':
      return `<input type="checkbox" id="${id}" class="fs-checkbox" data-config-key="${escapeHtml(fullKey)}" ${val === 'true' ? 'checked' : ''}${dis} />`;
    case 'number':
      return `<input type="number" id="${id}" class="fs-input" data-config-key="${escapeHtml(fullKey)}" value="${escapeHtml(val)}" ${prop.min != null ? `min="${prop.min}"` : ''} ${prop.max != null ? `max="${prop.max}"` : ''} ${prop.step != null ? `step="${prop.step}"` : ''}${dis} />`;
    default:
      return `<input type="text" id="${id}" class="fs-input" data-config-key="${escapeHtml(fullKey)}" value="${escapeHtml(val)}" placeholder="${escapeHtml(prop.placeholder || '')}"${dis} />`;
  }
}

// ── showWhen ─────────────────────────────────────────────────

function _attachShowWhenListeners(container) {
  const fields = container.querySelectorAll('[data-showwhen]');
  if (!fields.length) return;

  const watchMap = new Map();
  for (const field of fields) {
    const sw = JSON.parse(field.getAttribute('data-showwhen'));
    if (!sw?.property) continue;
    const fk = field.getAttribute('data-prop-key');
    const scope = fk?.includes('.') ? fk.substring(0, fk.lastIndexOf('.')) : '';
    const ck = scope ? `${scope}.${sw.property}` : sw.property;
    if (!watchMap.has(ck)) watchMap.set(ck, new Set());
    watchMap.get(ck).add({ el: field, values: sw.values });
  }

  for (const [ck, deps] of watchMap) {
    const ctrl = container.querySelector(`[data-config-key="${CSS.escape(ck)}"]`);
    if (!ctrl) continue;
    const update = () => {
      const cv = ctrl.value || (ctrl.checked ? 'true' : 'false');
      for (const d of deps) d.el.style.display = d.values.includes(cv) ? '' : 'none';
    };
    ctrl.addEventListener('change', update);
    update();
  }
}

// ── Dirty tracking（碰过 = 改过值 / 显式点了重置）────────────

function _fsHasDirty() {
  return window._featureSetupData.dirty.size > 0;
}

function _fsMarkDirty(fullKey, value) {
  window._featureSetupData.dirty.set(fullKey, { value });
  _fsUpdateSaveBar();
}

function _fsReadInputValue(input) {
  if (input.type === 'checkbox') return input.checked;
  if (input.type === 'number') return input.value ? Number(input.value) : '';
  return input.value.trim();
}

function _fsCollectListValue(container, key) {
  const values = [];
  for (const input of container.querySelectorAll(`.fs-list-input[data-config-key="${CSS.escape(key)}"]`)) {
    const v = input.value.trim();
    if (v) values.push(v);
  }
  return values;
}

function _fsMarkDirtyFromInput(input) {
  const key = input.getAttribute('data-config-key');
  if (!key) return;
  if (input.classList.contains('fs-list-input')) {
    const listEl = input.closest('.fs-list');
    if (listEl) _fsMarkDirty(key, _fsCollectListValue(listEl, key));
  } else {
    _fsMarkDirty(key, _fsReadInputValue(input));
  }
}

function _attachChangeListeners(container) {
  const inputs = container.querySelectorAll('[data-config-key]');
  for (const input of inputs) {
    const tag = input.tagName.toLowerCase();
    const evt = (tag === 'select' || input.type === 'checkbox') ? 'change' : 'input';
    input.addEventListener(evt, () => _fsMarkDirtyFromInput(input));
  }
}

function _fsUpdateSaveBar() {
  const bar = document.getElementById('fs-savebar');
  const cnt = document.getElementById('fs-save-count');
  const n = window._featureSetupData.dirty.size;
  if (bar) bar.classList.toggle('visible', n > 0);
  if (cnt) {
    cnt.textContent = n > 0
      ? _fsT(`未保存修改 ${n} 项`, `${n} unsaved change${n > 1 ? 's' : ''}`)
      : '';
  }
}

// ── 重置为继承（单字段）：从本层稀疏内容删除该字段 ─────────────

window._fsResetField = function (fullKey) {
  const st = window._featureSetupData;
  _fsMarkDirty(fullKey, null);
  // 立即按继承/出厂默认态重渲染（保存前层文件尚未变化，显示由 dirty 修正）
  window._fsSelect(st.activeId);
};

// ── Save = diff only（D9）：套用 dirty 到原始 sparse 后整层提交 ──
// payload 构造在 feature-setup-core.js（fsBuildLayerContent / fsValuesEqual）。

/** 该层稀疏内容 = 原始 sparse 为底，仅套用本次会话碰过的字段。 */
function _fsBuildLayerContent() {
  const st = window._featureSetupData;
  return fsBuildLayerContent(_fsLayers(), st.activeScopeId, st.dirty);
}

window._fsSave = async function () {
  const st = window._featureSetupData;
  if (!st.resolved || !st.dirty.size) return;
  const layerId = st.activeScopeId;
  const content = _fsBuildLayerContent();
  if (!content) return;

  // ── 值同提示（D8）：改出的值 == 上游生效值 → 二选一 ──
  const baseStates = _fsFieldStates();
  const sameKeys = [];
  for (const [fullKey, entry] of st.dirty) {
    if (entry.value === null) continue; // 重置无需检测
    const state = baseStates.get(fullKey);
    if (!state) continue;
    const prop = fsPropFor(st.sections, fullKey);
    let upstreamVal;
    let upstreamLabel;
    if (state.upstream?.kind === 'layer') {
      upstreamVal = state.upstream.value;
      upstreamLabel = state.upstream.label;
    } else {
      upstreamVal = prop ? prop.default : undefined;
      upstreamLabel = _fsT('出厂默认', 'factory default');
    }
    if (fsValuesEqual(entry.value, upstreamVal)) {
      sameKeys.push({ fullKey, upstreamLabel, upstreamVal });
    }
  }
  if (sameKeys.length) {
    const lines = sameKeys.map((k) =>
      `  ${k.fullKey} = ${_fsDisplayValue(k.upstreamVal)}${_fsT('（上游：', ' (upstream: ')}${k.upstreamLabel}${_fsT('）', ')')}`
    ).join('\n');
    const msg = _fsT(
      `以下字段的值与上游生效值相同：\n${lines}\n\n输入 1 = 清除本层覆盖（继承上游）\n输入 2 = 保留锁定（pin）\n取消 = 中止保存`,
      `The following fields now equal their effective upstream value:\n${lines}\n\nType 1 = remove this layer's override (inherit)\nType 2 = keep pinned\nCancel = abort save`
    );
    const choice = window.prompt(msg, '1');
    if (choice == null) return; // 中止
    if (choice.trim() === '1' || choice.trim() === '清' || /^inherit$/i.test(choice.trim())) {
      for (const k of sameKeys) st.dirty.set(k.fullKey, { value: null });
    }
    // 其他输入一律视为 pin（保留锁定）
  }

  const statusEl = document.getElementById('fs-auto-save-status');
  const saveBtn = document.getElementById('fs-save-btn');
  if (saveBtn) saveBtn.disabled = true;
  if (statusEl) { statusEl.textContent = _fsT('Saving...', 'Saving...'); statusEl.classList.add('visible'); }

  try {
    const res = await fetch('/protoclaw/feature_config/layer', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: FS_SCOPE_AGENT_ID, layerId, content }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || `${res.status} ${res.statusText}`);

    st.dirty = new Map();
    if (statusEl) statusEl.textContent = _fsT('Saved', 'Saved');
    // 保存生效后刷新 shell 可用性（路径等配置已落盘）
    _refreshShellAvailability();
    await _fsSwitchScope(st.activeScopeId, { force: true });
  } catch (err) {
    console.error('Failed to save feature config layer:', err);
    if (saveBtn) saveBtn.disabled = false;
    if (statusEl) statusEl.textContent = _fsT('Failed', 'Failed');
    window.alert(_fsT('保存失败：', 'Failed to save: ') + (err?.message || err));
  }

  setTimeout(() => {
    if (statusEl) statusEl.classList.remove('visible');
  }, 1500);
};

// ── List item add/remove（改动进入 dirty，不再自动保存）──────

window._fsListAddItem = function (btn) {
  const container = btn.closest('.fs-list');
  if (!container) return;
  const max = parseInt(container.getAttribute('data-list-max')) || 99;
  if (container.querySelectorAll('.fs-list-item').length >= max) return;

  const fullKey = container.getAttribute('data-list-key') || '';
  const placeholder = container.getAttribute('data-list-placeholder') || '';
  const listType = container.getAttribute('data-list-type') || '';
  const removeLabel = _fsT('移除', 'Remove');
  const browseLabel = _fsT('浏览...', 'Browse...');
  const dis = window._featureSetupData.resolvedError ? ' disabled' : '';

  const item = document.createElement('div');
  item.className = 'fs-list-item';
  item.innerHTML =
    `<input type="text" class="fs-input fs-list-input" data-config-key="${escapeHtml(fullKey)}" value="" placeholder="${escapeHtml(placeholder)}"${dis} />`
    + (listType === 'directory' ? `<button type="button" class="fs-list-browse" title="${escapeHtml(browseLabel)}" onclick="window._fsBrowseDir(this)">&#128193;</button>` : '')
    + `<button type="button" class="fs-list-remove" title="${escapeHtml(removeLabel)}" onclick="window._fsListRemoveItem(this)">&#215;</button>`;

  container.insertBefore(item, btn);

  // Attach change listener to the dynamically created input
  const newInput = item.querySelector('input');
  newInput.addEventListener('input', () => _fsMarkDirtyFromInput(newInput));

  if (container.querySelectorAll('.fs-list-item').length >= max) {
    btn.disabled = true;
  }

  newInput.focus();
  _fsMarkDirty(fullKey, _fsCollectListValue(container, fullKey));
};

window._fsListRemoveItem = function (btn) {
  const item = btn.closest('.fs-list-item');
  const container = btn.closest('.fs-list');
  if (!item || !container) return;

  const fullKey = container.getAttribute('data-list-key') || '';
  item.remove();

  const addBtn = container.querySelector('.fs-list-add');
  if (addBtn) addBtn.disabled = false;

  _fsMarkDirty(fullKey, _fsCollectListValue(container, fullKey));
};

// ── Directory picker ────────────────────────────────────────

window._fsBrowseDir = function (btn) {
  const item = btn.closest('.fs-list-item');
  const input = item?.querySelector('.fs-list-input');
  if (!input) return;
  _openDirPicker(input.value || '', (selectedPath) => {
    input.value = selectedPath;
    _fsMarkDirtyFromInput(input);
  });
};

function _openDirPicker(initialPath, onSelect) {
  const isZh = typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';
  const overlay = document.createElement('div');
  overlay.className = 'fs-dir-picker-overlay';
  overlay.innerHTML = `
    <div class="fs-dir-picker">
      <div class="fs-dir-picker-header">
        <span>${isZh ? '选择目录' : 'Select Directory'}</span>
        <button class="fs-dir-picker-close">&times;</button>
      </div>
      <div class="fs-dir-picker-toolbar">
        <button class="fs-dir-picker-up" title="${isZh ? '上一级' : 'Parent'}">&#8593;</button>
        <input type="text" class="fs-dir-picker-path" value="" />
      </div>
      <div class="fs-dir-picker-drives"></div>
      <div class="fs-dir-picker-body"><div class="fs-dir-picker-spinner"></div></div>
      <div class="fs-dir-picker-footer">
        <button class="fs-dir-picker-cancel">${isZh ? '取消' : 'Cancel'}</button>
        <button class="fs-dir-picker-select">${isZh ? '选择此目录' : 'Select'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  let currentPath = '';

  async function loadDir(targetPath) {
    const body = overlay.querySelector('.fs-dir-picker-body');
    const pathInput = overlay.querySelector('.fs-dir-picker-path');
    const upBtn = overlay.querySelector('.fs-dir-picker-up');
    const drivesEl = overlay.querySelector('.fs-dir-picker-drives');
    body.innerHTML = '<div class="fs-dir-picker-spinner"></div>';

    try {
      const res = await fetch(`/protoclaw/browse_dirs?path=${encodeURIComponent(targetPath)}`);
      if (!res.ok) {
        body.innerHTML = `<div class="fs-dir-picker-error">${isZh ? '无法读取此目录' : 'Cannot read this directory'}</div>`;
        return;
      }
      const data = await res.json();
      currentPath = data.currentPath;
      pathInput.value = currentPath;
      upBtn.disabled = !data.parent;
      upBtn.onclick = () => { if (data.parent) loadDir(data.parent); };

      // Drive letters
      if (data.drives && data.drives.length > 1) {
        drivesEl.innerHTML = data.drives.map(d =>
          `<button class="fs-dir-picker-drive ${d.path === currentPath ? 'active' : ''}" data-path="${escapeHtml(d.path)}">${escapeHtml(d.label)}</button>`
        ).join('');
        drivesEl.querySelectorAll('.fs-dir-picker-drive').forEach(b => {
          b.onclick = () => loadDir(b.getAttribute('data-path'));
        });
        drivesEl.style.display = '';
      } else {
        drivesEl.style.display = 'none';
      }

      if (data.entries.length === 0) {
        body.innerHTML = `<div class="fs-dir-picker-empty">${isZh ? '(空目录)' : '(empty)'}</div>`;
      } else {
        body.innerHTML = data.entries.map(e =>
          `<div class="fs-dir-entry" data-path="${escapeHtml(e.path)}">&#128193; ${escapeHtml(e.name)}</div>`
        ).join('');
        body.querySelectorAll('.fs-dir-entry').forEach(el => {
          el.ondblclick = () => loadDir(el.getAttribute('data-path'));
          el.onclick = () => {
            body.querySelectorAll('.fs-dir-entry').forEach(e2 => e2.classList.remove('selected'));
            el.classList.add('selected');
          };
        });
      }
    } catch {
      body.innerHTML = `<div class="fs-dir-picker-error">${isZh ? '加载失败' : 'Failed to load'}</div>`;
    }
  }

  // Path input: Enter to navigate
  overlay.querySelector('.fs-dir-picker-path').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      loadDir(e.target.value);
    }
  });

  // Select / Cancel / Close
  overlay.querySelector('.fs-dir-picker-select').onclick = () => {
    if (currentPath) {
      onSelect(currentPath);
      overlay.remove();
    }
  };
  const close = () => overlay.remove();
  overlay.querySelector('.fs-dir-picker-cancel').onclick = close;
  overlay.querySelector('.fs-dir-picker-close').onclick = close;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  loadDir(initialPath || '');
}

// ── Shell availability indicators ─────────────────────────────

/**
 * Apply shell availability badges and toggle states to the shell config section.
 * - Available: subtle green badge with detected path
 * - Not available: muted gray badge, checkbox disabled + unchecked
 */
function _applyShellAvailability() {
  const avail = window._featureSetupData.shellAvailability;
  if (!avail) return;

  const isZh = typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';
  const shells = [
    { key: 'bashEnabled', pathKey: 'bashPath', info: avail.bash, label: 'Bash' },
    { key: 'powershellEnabled', pathKey: 'powershellPath', info: avail.powershell, label: 'PowerShell' },
  ];

  for (const s of shells) {
    const fullKey = `shell.${s.key}`;
    const row = document.querySelector(`[data-prop-key="${CSS.escape(fullKey)}"]`);
    if (!row) continue;

    const titleEl = row.querySelector('.fs-row-title');
    if (!titleEl) continue;

    // Remove any previous badge
    const oldBadge = titleEl.querySelector('.fs-shell-badge');
    if (oldBadge) oldBadge.remove();

    if (s.info.available) {
      const shortPath = s.info.path && s.info.path.length > 50
        ? '…' + s.info.path.slice(-48)
        : (s.info.path || '');
      const badge = document.createElement('span');
      badge.className = 'fs-shell-badge fs-shell-ok';
      badge.textContent = isZh ? `已检测到 · ${shortPath}` : `Detected · ${shortPath}`;
      badge.title = s.info.path || '';
      titleEl.appendChild(badge);

      // Ensure checkbox is enabled (unless the whole panel is in error state)
      const cb = row.querySelector('.fs-checkbox');
      if (cb && !window._featureSetupData.resolvedError) cb.disabled = false;
    } else {
      const badge = document.createElement('span');
      badge.className = 'fs-shell-badge fs-shell-none';
      badge.textContent = isZh ? '未检测到' : 'Not found';
      titleEl.appendChild(badge);

      // Disable and uncheck
      const cb = row.querySelector('.fs-checkbox');
      if (cb) { cb.disabled = true; cb.checked = false; }
      row.classList.add('fs-row-unavailable');
    }
  }

  // Re-check availability when path inputs change (debounced)
  for (const s of shells) {
    const pathInput = document.querySelector(`[data-config-key="shell.${s.pathKey}"]`);
    if (pathInput && !pathInput.dataset.shellWatch) {
      pathInput.dataset.shellWatch = '1';
      pathInput.addEventListener('input', () => {
        clearTimeout(pathInput._shellTimer);
        pathInput._shellTimer = setTimeout(_refreshShellAvailability, 500);
      });
    }
  }
}

/**
 * 重新查询 shell 可用性（服务端按已保存的配置检测）。
 * 旧版这里会先全量 PUT 配置让服务端看到新路径；diff-only 保存模型下不再
 * 允许全量 dump，未保存的路径改动会在保存生效后的自动刷新中体现。
 */
async function _refreshShellAvailability() {
  try {
    const res = await fetch('/protoclaw/shell_availability');
    window._featureSetupData.shellAvailability = await res.json();
    _applyShellAvailability();
  } catch (err) {
    console.error('Failed to refresh shell availability:', err);
  }
}

// ── Helpers ──────────────────────────────────────────────────

function _cssid(key) { return key.replace(/[^a-zA-Z0-9-]/g, '-'); }
