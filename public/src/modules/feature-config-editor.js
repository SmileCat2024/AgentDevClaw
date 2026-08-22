/**
 * feature-config-editor.js — 共享 Feature 配置编辑器（即时保存）
 *
 * 一个可复用组件，三个容器使用同一套路（工作空间设置页的
 * ph-settings 布局：左侧分类导航 + 右侧配置区）：
 *   - Runtime 配置 workspace（scopeId='global'，占主区域）
 *   - 工作空间设置弹窗子页面（scopeId='agent'，带返回）
 *   - 目录会话配置弹窗（scopeId='dir:<path>'）
 *
 * 交互模型（对齐模型配置页的自动保存范式，无保存按钮 / 无表单感）：
 *   - 跟随 = 本层无该字段 → 控件半透明显示生效值，直接编辑即接管；
 *   - 接管 = 本层有该字段 → 控件正常显示，旁有一个小重置按钮（↺），
 *     点击删除本层条目回到跟随；
 *   - 所有改动即时保存（input 防抖 / change 立即），失败仅行内红边。
 *
 * 实例化使用（事件委托，多实例互不干扰）：
 *   const editor = createFeatureConfigEditor({ host, scopeId });
 *   editor.open(); editor.close();
 */

let _fceSeq = 0;

const _FCE_GEAR_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

function _fceT(zh, en) {
  return (typeof currentLanguage !== 'undefined' && currentLanguage === 'zh') ? zh : en;
}

// ── 实例工厂 ──────────────────────────────────────────────────

function createFeatureConfigEditor(options = {}) {
  const instanceId = `fce-${++_fceSeq}`;
  const host = options.host;
  if (!host || typeof host.querySelector !== 'function') {
    throw new Error('createFeatureConfigEditor: host element required');
  }
  const scopeId = String(options.scopeId || 'global');

  const FS_SCOPE_AGENT_ID = 'programming-helper';
  const SAVE_DEBOUNCE_MS = 500;

  const state = {
    manifests: null,
    shellAvailability: null,
    sections: [],
    activeId: null,
    resolved: null,
    resolvedError: null,
    pending: new Map(), // fullKey -> value | null（null = 重置为跟随）
    saving: false,
    flushQueued: false,
    destroyed: false,
  };
  let _saveTimer = null;

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
            featureName,
            propKeys: sec.properties,
            props,
          });
        }
      } else {
        sections.push({
          id: featureName,
          title: featureName,
          featureName,
          propKeys: Object.keys(props),
          props,
        });
      }
    }
    state.sections = sections;
  }

  // ── 层访问与两态表（判定数据全部来自 resolved）──────────────

  function layers() {
    const arr = state.resolved?.layers;
    return Array.isArray(arr) ? arr : [];
  }

  function targetSparse() {
    const own = layers().find((l) => l.id === scopeId);
    return own?.sparse || {};
  }

  function effectiveStates() {
    return fsFieldStates(state.sections, layers(), scopeId);
  }

  // ── 渲染（复用工作空间设置页 ph-settings 布局类）────────────

  function renderShell() {
    host.innerHTML = `
      <div class="ph-settings-layout fs-editor-body">
        <div class="ph-settings-sidebar" data-fce-nav><div class="fs-nav-loading">...</div></div>
        <div class="ph-settings-content" data-fce-main>
          <div class="fs-spinner-wrap"><div class="fs-spinner"></div></div>
        </div>
      </div>
    `;
    renderNav();
  }

  function renderNav() {
    const navEl = host.querySelector('[data-fce-nav]');
    if (!navEl) return;
    navEl.innerHTML = state.sections.map(s =>
      `<div class="ph-settings-tab" data-fce-action="nav" data-id="${escapeHtml(s.id)}">
        <span class="ph-settings-tab-icon">${_FCE_GEAR_SVG}</span>
        <span class="ph-settings-tab-label">${escapeHtml(s.title)}</span>
      </div>`
    ).join('');
  }

  function selectSection(id) {
    state.activeId = id;
    host.querySelectorAll('.ph-settings-tab[data-fce-action="nav"]').forEach(el =>
      el.classList.toggle('active', el.getAttribute('data-id') === id)
    );
    const sec = state.sections.find(s => s.id === id);
    if (!sec) return;

    const mainEl = host.querySelector('[data-fce-main]');
    if (!mainEl) return;

    const states = effectiveStates();
    const disabled = !!state.resolvedError || !state.resolved;

    let rowsHtml = '';
    for (const key of sec.propKeys) {
      const prop = sec.props[key];
      if (!prop) continue;
      if (prop.type === 'group') {
        for (const sk of Object.keys(prop.properties || {})) {
          const fullKey = `${sec.featureName}.${key}.${sk}`;
          rowsHtml += renderRow(prop.properties[sk], fullKey, states.get(fullKey), disabled);
        }
      } else {
        const fullKey = `${sec.featureName}.${key}`;
        rowsHtml += renderRow(prop, fullKey, states.get(fullKey), disabled);
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
      <div class="ph-settings-content-header">${escapeHtml(sec.title)}</div>
      ${errHtml}
      ${warnHtml}
      <div class="ph-mc-list">${rowsHtml}</div>
    `;
    mainEl.scrollTop = 0;
    attachShowWhen(mainEl);
    applyShellAvailability();
  }

  // ── 字段行（ph-mc-row 套路：左标题列 + 右控件列）────────────

  // 重置按钮语义按层区分：全局层=恢复默认值；agent/目录层=恢复为上级配置
  function resetBtnHtml(fullKey) {
    const title = scopeId === 'global'
      ? _fceT('恢复默认值', 'Reset to default')
      : _fceT('恢复为上级配置', 'Reset to upstream value');
    return `<button type="button" class="fs-reset-btn" data-fce-action="reset" data-key="${escapeHtml(fullKey)}" title="${title}">&#8634;</button>`;
  }

  function renderRow(prop, fullKey, rowState, disabled) {
    const sw = prop.showWhen ? ` style="display:none;" data-showwhen='${JSON.stringify(prop.showWhen)}'` : '';
    const status = rowState?.status === 'takeover' ? 'takeover' : 'follow';
    const value = fsControlValue(rowState, prop);
    const showReset = fsShowReset(scopeId, rowState, prop);

    return `
      <div class="ph-mc-row fs-row fs-state-${status}"${sw} data-prop-key="${escapeHtml(fullKey)}">
        <div class="ph-mc-role">
          <div class="ph-mc-role-name">${escapeHtml(prop.title || '')}</div>
          ${prop.description ? `<div class="ph-mc-role-desc">${escapeHtml(prop.description)}</div>` : ''}
        </div>
        <div class="fs-row-ctrl">
          ${renderInput(fullKey, prop, value, disabled)}
          ${showReset ? resetBtnHtml(fullKey) : ''}
        </div>
      </div>
    `;
  }

  // 局部重建单个字段行（重置为跟随后调用，避免全量重渲染打断输入）
  function rerenderRow(fullKey) {
    const row = host.querySelector(`[data-prop-key="${CSS.escape(fullKey)}"]`);
    const prop = fsPropFor(state.sections, fullKey);
    if (!row || !prop) return;
    const states = effectiveStates();
    const disabled = !!state.resolvedError || !state.resolved;
    const tmp = document.createElement('div');
    tmp.innerHTML = renderRow(prop, fullKey, states.get(fullKey), disabled);
    row.replaceWith(tmp.firstElementChild);
    attachShowWhen(host.querySelector('[data-fce-main]'));
    applyShellAvailability();
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
    const fields = container.querySelectorAll('[data-showwhen]:not([data-sw-bound])');
    if (!fields.length) return;
    const watchMap = new Map();
    for (const field of fields) {
      field.dataset.swBound = '1';
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

  // ── 即时保存管道（防抖合并，失败行内红边）────────────────────

  function scheduleSave() {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }

  async function flushSave() {
    clearTimeout(_saveTimer);
    if (state.saving) { state.flushQueued = true; return; }
    if (!state.pending.size || !state.resolved || state.destroyed) return;

    const batch = state.pending;
    state.pending = new Map();
    state.saving = true;
    try {
      let content = targetSparse();
      for (const [k, v] of batch) content = fsWithField(content, k, v);
      const res = await fetch('/protoclaw/feature_config/layer', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: FS_SCOPE_AGENT_ID, layerId: scopeId, content }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || `${res.status} ${res.statusText}`);
      // 静默刷新基底，不重渲染（不打断输入）
      await reloadResolved();
    } catch (err) {
      // 失败：pending 回填（保留未保存语义），行标红提示
      for (const [k, v] of batch) if (!state.pending.has(k)) state.pending.set(k, v);
      for (const k of batch.keys()) markRowError(k);
      console.error('[feature-config-editor] save failed:', err);
    } finally {
      state.saving = false;
      if (state.flushQueued) {
        state.flushQueued = false;
        flushSave();
      }
    }
  }

  function markRowError(fullKey) {
    const row = host.querySelector(`[data-prop-key="${CSS.escape(fullKey)}"]`);
    if (!row) return;
    row.classList.add('fs-save-error');
    setTimeout(() => row.classList.remove('fs-save-error'), 3000);
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

  function recordChange(input) {
    const key = input.getAttribute('data-config-key');
    if (!key) return;
    if (input.classList.contains('fs-list-input')) {
      const listEl = input.closest('.fs-list');
      if (listEl) state.pending.set(key, collectListValue(listEl, key));
    } else {
      state.pending.set(key, readInputValue(input));
    }
    rowTakeover(key);
  }

  // 编辑即接管：行视觉立刻切换（局部 DOM，不重渲染，不打断输入）
  function rowTakeover(fullKey) {
    const row = host.querySelector(`[data-prop-key="${CSS.escape(fullKey)}"]`);
    if (!row || row.classList.contains('fs-state-takeover')) return;
    row.classList.remove('fs-state-follow');
    row.classList.add('fs-state-takeover');
    const ctrl = row.querySelector('.fs-row-ctrl');
    if (ctrl) ctrl.insertAdjacentHTML('beforeend', resetBtnHtml(fullKey));
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
    item.querySelector('input').focus();
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
    state.pending.set(fullKey, collectListValue(container, fullKey));
    rowTakeover(fullKey);
    scheduleSave();
  }

  function browseDir(btn) {
    const item = btn.closest('.fs-list-item');
    const input = item?.querySelector('.fs-list-input');
    if (!input) return;
    openDirPicker(input.value || '', (selectedPath) => {
      input.value = selectedPath;
      recordChange(input);
      scheduleSave();
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
      const titleEl = row.querySelector('.ph-mc-role-name');
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
    if (input) {
      recordChange(input);
      scheduleSave();
    }
  }

  function onHostChange(e) {
    const input = e.target.closest('[data-config-key]');
    if (input) {
      recordChange(input);
      flushSave(); // change（选中/勾选/失焦）立即落盘
    }
  }

  function onHostClick(e) {
    const actionEl = e.target.closest('[data-fce-action]');
    if (!actionEl) return;
    const action = actionEl.getAttribute('data-fce-action');
    switch (action) {
      case 'nav':
        selectSection(actionEl.getAttribute('data-id'));
        break;
      case 'reset': {
        const fullKey = actionEl.getAttribute('data-key');
        state.pending.set(fullKey, null);
        // 保存完成（层 sparse 已刷新）后再重渲染行，避免闪回旧接管态
        flushSave().then(() => rerenderRow(fullKey));
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
    }
  }

  host.addEventListener('input', onHostInput);
  host.addEventListener('change', onHostChange);
  host.addEventListener('click', onHostClick);

  // ── 生命周期 ─────────────────────────────────────────────────

  async function open() {
    state.destroyed = false;
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
    }
  }

  function close() {
    state.destroyed = true;
    clearTimeout(_saveTimer);
    // 未落盘的改动直接发起保存（fire-and-forget），不阻塞关闭
    if (state.pending.size && state.resolved) {
      const batch = state.pending;
      state.pending = new Map();
      let content = targetSparse();
      for (const [k, v] of batch) content = fsWithField(content, k, v);
      fetch('/protoclaw/feature_config/layer', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: FS_SCOPE_AGENT_ID, layerId: scopeId, content }),
      }).catch((err) => console.error('[feature-config-editor] save on close failed:', err));
    }
    host.removeEventListener('input', onHostInput);
    host.removeEventListener('change', onHostChange);
    host.removeEventListener('click', onHostClick);
    host.innerHTML = '';
  }

  return { open, close, instanceId };
}
