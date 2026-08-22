/**
 * feature-config-editor.js — 共享 Feature 配置编辑器（跟随 / 接管两态）
 *
 * 一个可复用组件，三个容器使用同一套路（左侧配置组导航 + 右侧字段 +
 * 可选返回头）：
 *   - Runtime 配置 workspace（scopeId='global'，占主区域）
 *   - 工作空间设置弹窗子页面（scopeId='agent'，二级页带返回）
 *   - 目录会话配置弹窗（scopeId='dir:<path>'）
 *
 * 字段两态模型（纯逻辑在 feature-setup-core.js）：
 *   - 跟随（follow）= 本层无该字段 → 控件灰显生效值（上游最近层值或
 *     manifest default），可直接编辑，一编辑即接管；
 *   - 接管（takeover）= 本层有该字段（或本次会话已改待保存）→ 值完全
 *     跟本层走，旁边"重置为跟随"一键删条目；
 *   - 保存 = diff only：以原始 sparse 为底仅套用本次碰过的字段，
 *     PUT /protoclaw/feature_config/layer。
 *
 * 实例化使用（事件委托，无全局单例，多实例互不干扰）：
 *   const editor = createFeatureConfigEditor({ host, scopeId, title, onBack });
 *   editor.open(); editor.close(); editor.hasDirty();
 */

let _fceSeq = 0;

function _fceT(zh, en) {
  return (typeof currentLanguage !== 'undefined' && currentLanguage === 'zh') ? zh : en;
}

function _fceDisplayValue(v) {
  if (v === undefined) return _fceT('（未设置）', '(unset)');
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? v.join(', ') : _fceT('（空）', '(empty)');
  if (v === '') return _fceT('（空串）', '""');
  return String(v);
}

// ── 实例工厂 ──────────────────────────────────────────────────

function createFeatureConfigEditor(options = {}) {
  const instanceId = `fce-${++_fceSeq}`;
  const host = options.host;
  if (!host || typeof host.querySelector !== 'function') {
    throw new Error('createFeatureConfigEditor: host element required');
  }
  const scopeId = String(options.scopeId || 'global');
  const onBack = typeof options.onBack === 'function' ? options.onBack : null;
  const title = options.title || '';

  const FS_SCOPE_AGENT_ID = 'programming-helper';

  const state = {
    manifests: null,
    shellAvailability: null,
    sections: [],
    activeId: null,
    resolved: null,
    resolvedError: null,
    dirty: new Map(),
    loading: false,
    destroyed: false,
  };

  // ── 数据加载 ────────────────────────────────────────────────

  async function fetchResolved() {
    const params = new URLSearchParams({ agentId: FS_SCOPE_AGENT_ID });
    if (scopeId.startsWith('dir:')) params.set('dir', scopeId.slice(4));
    const res = await fetch(`/protoclaw/feature_config/resolved?${params.toString()}`);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status}: ${text || res.statusText}`);
    }
    return res.json();
  }

  async function loadStaticData() {
    const [mRes, saRes] = await Promise.all([
      fetch('/protoclaw/system_feature_manifests'),
      fetch('/protoclaw/shell_availability').catch(() => null),
    ]);
    state.manifests = (await mRes.json()).features || [];
    try {
      state.shellAvailability = saRes && saRes.ok ? await saRes.json() : null;
    } catch {
      state.shellAvailability = null;
    }
  }

  async function reloadResolved() {
    state.resolved = null;
    state.resolvedError = null;
    try {
      state.resolved = await fetchResolved();
    } catch (err) {
      state.resolvedError = String(err?.message || err);
    }
  }

  // ── section 构建（manifest → 左侧导航项）────────────────────

  function buildSections() {
    const sections = [];
    for (const feature of state.manifests) {
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
    state.sections = sections;
  }

  // ── 两态表（判定数据全部来自 resolved，前端不自算合并）──────

  function layers() {
    const arr = state.resolved?.layers;
    return Array.isArray(arr) ? arr : [];
  }

  function effectiveStates() {
    const base = fsFieldStates(state.sections, layers(), scopeId);
    return fsApplyDirty(base, state.dirty);
  }

  // ── 渲染 ────────────────────────────────────────────────────

  function renderShell() {
    const backBtn = onBack
      ? `<button type="button" class="fs-back-btn" data-fce-action="back">← ${_fceT('返回', 'Back')}</button>`
      : '';
    const headRow = (onBack || title)
      ? `<div class="fs-editor-head">${backBtn}${title ? `<span class="fs-editor-title">${escapeHtml(title)}</span>` : ''}</div>`
      : '';
    host.innerHTML = `
      ${headRow}
      <div class="fs-app">
        <div class="fs-side">
          <nav class="fs-nav" data-fce-nav><div class="fs-nav-loading">...</div></nav>
        </div>
        <main class="fs-main" data-fce-main>
          <div class="fs-spinner-wrap"><div class="fs-spinner"></div></div>
        </main>
      </div>
    `;
    renderNav();
  }

  function renderNav() {
    const navEl = host.querySelector('[data-fce-nav]');
    if (!navEl) return;
    navEl.innerHTML = state.sections.map(s =>
      `<div class="fs-nav-item" data-fce-action="nav" data-id="${escapeHtml(s.id)}">
        <span class="fs-nav-icon">${s.icon}</span>
        <span class="fs-nav-text">${escapeHtml(s.title)}</span>
      </div>`
    ).join('');
  }

  function selectSection(id) {
    state.activeId = id;
    host.querySelectorAll('.fs-nav-item').forEach(el =>
      el.classList.toggle('active', el.getAttribute('data-id') === id)
    );
    const sec = state.sections.find(s => s.id === id);
    if (!sec) return;

    const mainEl = host.querySelector('[data-fce-main]');
    if (!mainEl) return;

    const states = effectiveStates();
    const disabled = !!state.resolvedError || !state.resolved;

    let cardsHtml = '';
    for (const key of sec.propKeys) {
      const prop = sec.props[key];
      if (!prop) continue;
      if (prop.type === 'group') {
        cardsHtml += renderGroupCard(key, prop, sec.featureName, states, disabled);
      } else {
        cardsHtml += renderSingleCard(key, prop, sec.featureName, states, disabled);
      }
    }

    const warnings = Array.isArray(state.resolved?.warnings) ? state.resolved.warnings : [];
    const warnHtml = warnings.length
      ? `<div class="fs-warnings">${warnings.map(w =>
          `<div class="fs-warning-item">${escapeHtml(String(w?.message || w?.fieldPath || w))}</div>`
        ).join('')}</div>`
      : '';
    const errHtml = state.resolvedError
      ? `<div class="fs-error-banner">${_fceT('读取配置层失败', 'Failed to load config layers')}: ${escapeHtml(state.resolvedError)}</div>`
      : '';

    mainEl.innerHTML = `
      <div class="fs-content">
        ${errHtml}
        ${warnHtml}
        <div class="fs-cards">${cardsHtml}</div>
        <div class="fs-savebar">
          <span class="fs-save-count"></span>
          <button type="button" class="fs-save-btn" data-fce-action="save"${disabled ? ' disabled' : ''}>${_fceT('保存', 'Save')}</button>
        </div>
      </div>
      <div class="fs-auto-save-status"></div>
    `;
    mainEl.scrollTop = 0;
    attachShowWhen(mainEl);
    updateSaveBar();
    applyShellAvailability();
  }

  // ── 卡片与字段行（两态）─────────────────────────────────────

  function renderGroupCard(key, prop, featureName, states, disabled) {
    const subProps = prop.properties || {};
    let rowsHtml = '';
    for (const [sk, sp] of Object.entries(subProps)) {
      const fullKey = `${featureName}.${key}.${sk}`;
      rowsHtml += renderRow(sp, fullKey, states.get(fullKey), disabled);
    }
    return `
      <div class="fs-group">
        <div class="fs-group-title">${escapeHtml(prop.title || key)}</div>
        <div class="fs-card">${rowsHtml}</div>
      </div>
    `;
  }

  function renderSingleCard(key, prop, featureName, states, disabled) {
    const fullKey = `${featureName}.${key}`;
    return `<div class="fs-card">${renderRow(prop, fullKey, states.get(fullKey), disabled)}</div>`;
  }

  function renderRow(prop, fullKey, rowState, disabled) {
    const sw = prop.showWhen ? ` style="display:none;" data-showwhen='${JSON.stringify(prop.showWhen)}'` : '';
    const status = rowState?.status === 'takeover' ? 'takeover' : 'follow';
    const value = fsControlValue(rowState, prop);

    // 跟随态：小字显示当前生效值（透明度，不标注来源层）；
    // 接管态：标记点 + 一键重置为跟随。
    let noteHtml;
    if (status === 'takeover') {
      noteHtml = `
        <div class="fs-state-note fs-note-takeover">
          <span class="fs-takeover-dot"></span>${_fceT('本层接管', 'Managed here')}
          <button type="button" class="fs-reset-btn" data-fce-action="reset" data-key="${escapeHtml(fullKey)}">${_fceT('重置为跟随', 'Reset to follow')}</button>
        </div>
      `;
    } else {
      noteHtml = `<div class="fs-state-note fs-note-follow">${_fceT('当前生效', 'Effective')}: ${escapeHtml(_fceDisplayValue(value))}</div>`;
    }

    return `
      <div class="fs-row fs-state-${status}"${sw} data-prop-key="${escapeHtml(fullKey)}">
        <div class="fs-row-main">
          <div class="fs-row-title">${escapeHtml(prop.title || '')}</div>
          ${prop.description ? `<div class="fs-row-desc">${escapeHtml(prop.description)}</div>` : ''}
          ${noteHtml}
        </div>
        <div class="fs-row-ctrl">${renderInput(fullKey, prop, value, disabled)}</div>
      </div>
    `;
  }

  // ── 控件 ────────────────────────────────────────────────────

  function isListType(prop) {
    return prop.type === 'directory'
      || (prop.type === 'file' && (Array.isArray(prop.default) || prop.maxItems != null));
  }

  function renderListInput(fullKey, prop, value, dis) {
    const items = Array.isArray(value) ? value.filter(v => v != null && String(v).trim() !== '') : [];
    const maxItems = prop.maxItems || 99;
    const placeholder = prop.placeholder || _fceT('输入路径...', 'Enter path...');
    const showBrowse = prop.type === 'directory';

    function itemHtml(val) {
      return `<div class="fs-list-item">`
        + `<input type="text" class="fs-input fs-list-input" data-config-key="${escapeHtml(fullKey)}" value="${escapeHtml(String(val))}" placeholder="${escapeHtml(placeholder)}"${dis} />`
        + (showBrowse ? `<button type="button" class="fs-list-browse" data-fce-action="browse" title="${_fceT('浏览...', 'Browse...')}">...</button>` : '')
        + `<button type="button" class="fs-list-remove" data-fce-action="list-remove" title="${_fceT('移除', 'Remove')}">&times;</button>`
        + `</div>`;
    }

    return `
      <div class="fs-list" data-list-key="${escapeHtml(fullKey)}" data-list-max="${maxItems}">
        ${items.map(itemHtml).join('')}
        <button type="button" class="fs-list-add" ${items.length >= maxItems ? 'disabled' : ''} data-fce-action="list-add">+ ${_fceT('添加', 'Add')}</button>
      </div>
    `;
  }

  function renderInput(fullKey, prop, value, disabled) {
    const dis = disabled ? ' disabled' : '';
    if (isListType(prop)) return renderListInput(fullKey, prop, value, dis);

    const val = value != null ? String(value) : '';
    switch (prop.type) {
      case 'select': {
        let h = `<select class="fs-select" data-config-key="${escapeHtml(fullKey)}"${dis}>`;
        if (prop.options) {
          for (const o of prop.options) {
            h += `<option value="${escapeHtml(String(o.value))}"${String(o.value) === val ? ' selected' : ''}>${escapeHtml(o.label)}</option>`;
          }
        }
        return h + `</select>`;
      }
      case 'file':
        return `<input type="text" class="fs-input" data-config-key="${escapeHtml(fullKey)}" value="${escapeHtml(val)}" placeholder="${escapeHtml(prop.placeholder || '')}"${dis} />`;
      case 'boolean':
        return `<input type="checkbox" class="fs-checkbox" data-config-key="${escapeHtml(fullKey)}" ${val === 'true' ? 'checked' : ''}${dis} />`;
      case 'number':
        return `<input type="number" class="fs-input" data-config-key="${escapeHtml(fullKey)}" value="${escapeHtml(val)}" ${prop.min != null ? `min="${prop.min}"` : ''} ${prop.max != null ? `max="${prop.max}"` : ''} ${prop.step != null ? `step="${prop.step}"` : ''}${dis} />`;
      default:
        return `<input type="text" class="fs-input" data-config-key="${escapeHtml(fullKey)}" value="${escapeHtml(val)}" placeholder="${escapeHtml(prop.placeholder || '')}"${dis} />`;
    }
  }

  // ── showWhen 联动 ────────────────────────────────────────────

  function attachShowWhen(container) {
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

  // ── dirty 跟踪（碰过 = 改过值 / 显式点了重置）────────────────

  function markDirty(fullKey, value) {
    state.dirty.set(fullKey, { value });
    updateSaveBar();
  }

  function readInputValue(input) {
    if (input.type === 'checkbox') return input.checked;
    if (input.type === 'number') return input.value ? Number(input.value) : '';
    return input.value.trim();
  }

  function collectListValue(listEl, key) {
    const values = [];
    for (const input of listEl.querySelectorAll(`.fs-list-input[data-config-key="${CSS.escape(key)}"]`)) {
      const v = input.value.trim();
      if (v) values.push(v);
    }
    return values;
  }

  function markDirtyFromInput(input) {
    const key = input.getAttribute('data-config-key');
    if (!key) return;
    if (input.classList.contains('fs-list-input')) {
      const listEl = input.closest('.fs-list');
      if (listEl) markDirty(key, collectListValue(listEl, key));
    } else {
      markDirty(key, readInputValue(input));
    }
    // 一编辑即接管：行视觉立刻切换（不重渲染，避免打断输入焦点）
    const row = input.closest('.fs-row');
    if (row) {
      row.classList.remove('fs-state-follow');
      row.classList.add('fs-state-takeover');
      const note = row.querySelector('.fs-note-follow');
      if (note) note.remove();
    }
  }

  function updateSaveBar() {
    const bar = host.querySelector('.fs-savebar');
    const cnt = host.querySelector('.fs-save-count');
    const n = state.dirty.size;
    if (bar) bar.classList.toggle('visible', n > 0);
    if (cnt) {
      cnt.textContent = n > 0
        ? _fceT(`未保存修改 ${n} 项`, `${n} unsaved change${n > 1 ? 's' : ''}`)
        : '';
    }
  }

  // ── 保存（diff only：以原始 sparse 为底套用 dirty）────────────

  async function save() {
    if (!state.resolved || !state.dirty.size) return;
    const content = fsBuildLayerContent(layers(), scopeId, state.dirty);
    if (!content) return;

    const statusEl = host.querySelector('.fs-auto-save-status');
    const saveBtn = host.querySelector('.fs-save-btn');
    if (saveBtn) saveBtn.disabled = true;
    if (statusEl) { statusEl.textContent = _fceT('Saving...', 'Saving...'); statusEl.classList.add('visible'); }

    try {
      const res = await fetch('/protoclaw/feature_config/layer', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: FS_SCOPE_AGENT_ID, layerId: scopeId, content }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || `${res.status} ${res.statusText}`);

      state.dirty = new Map();
      if (statusEl) statusEl.textContent = _fceT('Saved', 'Saved');
      await refreshShellAvailability();
      await reloadResolved();
      selectSection(state.activeId);
    } catch (err) {
      if (saveBtn) saveBtn.disabled = false;
      if (statusEl) statusEl.textContent = _fceT('Failed', 'Failed');
      window.alert(_fceT('保存失败：', 'Failed to save: ') + (err?.message || err));
    }

    setTimeout(() => {
      if (statusEl && !state.destroyed) statusEl.classList.remove('visible');
    }, 1500);
  }

  // ── 列表项增删 / 目录选择器 ──────────────────────────────────

  function listAdd(btn) {
    const container = btn.closest('.fs-list');
    if (!container) return;
    const max = parseInt(container.getAttribute('data-list-max')) || 99;
    if (container.querySelectorAll('.fs-list-item').length >= max) return;

    const fullKey = container.getAttribute('data-list-key') || '';
    const placeholder = container.querySelector('.fs-list-input')?.getAttribute('placeholder') || '';
    const hasBrowse = !!container.querySelector('.fs-list-browse');

    const item = document.createElement('div');
    item.className = 'fs-list-item';
    item.innerHTML =
      `<input type="text" class="fs-input fs-list-input" data-config-key="${escapeHtml(fullKey)}" value="" placeholder="${escapeHtml(placeholder)}" />`
      + (hasBrowse ? `<button type="button" class="fs-list-browse" data-fce-action="browse" title="${_fceT('浏览...', 'Browse...')}">...</button>` : '')
      + `<button type="button" class="fs-list-remove" data-fce-action="list-remove" title="${_fceT('移除', 'Remove')}">&times;</button>`;

    container.insertBefore(item, btn);
    const newInput = item.querySelector('input');
    newInput.focus();
    markDirty(fullKey, collectListValue(container, fullKey));
    if (container.querySelectorAll('.fs-list-item').length >= max) btn.disabled = true;
  }

  function listRemove(btn) {
    const item = btn.closest('.fs-list-item');
    const container = btn.closest('.fs-list');
    if (!item || !container) return;
    const fullKey = container.getAttribute('data-list-key') || '';
    item.remove();
    const addBtn = container.querySelector('.fs-list-add');
    if (addBtn) addBtn.disabled = false;
    markDirty(fullKey, collectListValue(container, fullKey));
  }

  function browseDir(btn) {
    const item = btn.closest('.fs-list-item');
    const input = item?.querySelector('.fs-list-input');
    if (!input) return;
    openDirPicker(input.value || '', (selectedPath) => {
      input.value = selectedPath;
      markDirtyFromInput(input);
    });
  }

  function openDirPicker(initialPath, onSelect) {
    const overlay = document.createElement('div');
    overlay.className = 'fs-dir-picker-overlay';
    overlay.innerHTML = `
      <div class="fs-dir-picker">
        <div class="fs-dir-picker-header">
          <span>${_fceT('选择目录', 'Select Directory')}</span>
          <button class="fs-dir-picker-close">&times;</button>
        </div>
        <div class="fs-dir-picker-toolbar">
          <button class="fs-dir-picker-up" title="${_fceT('上一级', 'Parent')}">&#8593;</button>
          <input type="text" class="fs-dir-picker-path" value="" />
        </div>
        <div class="fs-dir-picker-drives"></div>
        <div class="fs-dir-picker-body"><div class="fs-dir-picker-spinner"></div></div>
        <div class="fs-dir-picker-footer">
          <button class="fs-dir-picker-cancel">${_fceT('取消', 'Cancel')}</button>
          <button class="fs-dir-picker-select">${_fceT('选择此目录', 'Select')}</button>
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
          body.innerHTML = `<div class="fs-dir-picker-error">${_fceT('无法读取此目录', 'Cannot read this directory')}</div>`;
          return;
        }
        const data = await res.json();
        currentPath = data.currentPath;
        pathInput.value = currentPath;
        upBtn.disabled = !data.parent;
        upBtn.onclick = () => { if (data.parent) loadDir(data.parent); };

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
          body.innerHTML = `<div class="fs-dir-picker-empty">${_fceT('(空目录)', '(empty)')}</div>`;
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
        body.innerHTML = `<div class="fs-dir-picker-error">${_fceT('加载失败', 'Failed to load')}</div>`;
      }
    }

    overlay.querySelector('.fs-dir-picker-path').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        loadDir(e.target.value);
      }
    });
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

  // ── Shell 可用性标识 ─────────────────────────────────────────

  function applyShellAvailability() {
    const avail = state.shellAvailability;
    if (!avail) return;
    const shells = [
      { key: 'bashEnabled', pathKey: 'bashPath', info: avail.bash, label: 'Bash' },
      { key: 'powershellEnabled', pathKey: 'powershellPath', info: avail.powershell, label: 'PowerShell' },
    ];
    for (const s of shells) {
      const fullKey = `shell.${s.key}`;
      const row = host.querySelector(`[data-prop-key="${CSS.escape(fullKey)}"]`);
      if (!row) continue;
      const titleEl = row.querySelector('.fs-row-title');
      if (!titleEl) continue;

      const oldBadge = titleEl.querySelector('.fs-shell-badge');
      if (oldBadge) oldBadge.remove();

      if (s.info.available) {
        const shortPath = s.info.path && s.info.path.length > 50
          ? '…' + s.info.path.slice(-48)
          : (s.info.path || '');
        const badge = document.createElement('span');
        badge.className = 'fs-shell-badge fs-shell-ok';
        badge.textContent = _fceT(`已检测到 · ${shortPath}`, `Detected · ${shortPath}`);
        badge.title = s.info.path || '';
        titleEl.appendChild(badge);
        const cb = row.querySelector('.fs-checkbox');
        if (cb && !state.resolvedError) cb.disabled = false;
      } else {
        const badge = document.createElement('span');
        badge.className = 'fs-shell-badge fs-shell-none';
        badge.textContent = _fceT('未检测到', 'Not found');
        titleEl.appendChild(badge);
        const cb = row.querySelector('.fs-checkbox');
        if (cb) { cb.disabled = true; cb.checked = false; }
        row.classList.add('fs-row-unavailable');
      }
    }

    for (const s of shells) {
      const pathInput = host.querySelector(`[data-config-key="shell.${s.pathKey}"]`);
      if (pathInput && !pathInput.dataset.shellWatch) {
        pathInput.dataset.shellWatch = '1';
        pathInput.addEventListener('input', () => {
          clearTimeout(pathInput._shellTimer);
          pathInput._shellTimer = setTimeout(refreshShellAvailability, 500);
        });
      }
    }
  }

  async function refreshShellAvailability() {
    try {
      const res = await fetch('/protoclaw/shell_availability');
      state.shellAvailability = await res.json();
      applyShellAvailability();
    } catch {
      // 可用性探测失败不阻塞编辑流程
    }
  }

  // ── 事件委托 ─────────────────────────────────────────────────

  function onHostInput(e) {
    const input = e.target.closest('[data-config-key]');
    if (input) markDirtyFromInput(input);
  }

  function onHostClick(e) {
    const actionEl = e.target.closest('[data-fce-action]');
    if (!actionEl) return;
    const action = actionEl.getAttribute('data-fce-action');
    switch (action) {
      case 'nav':
        selectSection(actionEl.getAttribute('data-id'));
        break;
      case 'save':
        save();
        break;
      case 'reset': {
        const fullKey = actionEl.getAttribute('data-key');
        markDirty(fullKey, null);
        selectSection(state.activeId);
        break;
      }
      case 'list-add':
        listAdd(actionEl);
        break;
      case 'list-remove':
        listRemove(actionEl);
        break;
      case 'browse':
        browseDir(actionEl);
        break;
      case 'back':
        if (onBack) onBack();
        break;
    }
  }

  host.addEventListener('input', onHostInput);
  host.addEventListener('change', onHostInput);
  host.addEventListener('click', onHostClick);

  // ── 生命周期 ─────────────────────────────────────────────────

  async function open() {
    state.destroyed = false;
    state.loading = true;
    renderShell();
    try {
      await loadStaticData();
      buildSections();
      renderNav();
      await reloadResolved();
      selectSection(state.sections[0]?.id || null);
    } catch (err) {
      const mainEl = host.querySelector('[data-fce-main]');
      if (mainEl) mainEl.innerHTML = `<div class="fs-main-error">${_fceT('加载失败', 'Failed to load')}: ${escapeHtml(String(err?.message || err))}</div>`;
    } finally {
      state.loading = false;
    }
  }

  function close() {
    state.destroyed = true;
    host.removeEventListener('input', onHostInput);
    host.removeEventListener('change', onHostInput);
    host.removeEventListener('click', onHostClick);
    host.innerHTML = '';
  }

  function hasDirty() {
    return state.dirty.size > 0;
  }

  return { open, close, hasDirty, instanceId };
}
