/**
 * Feature Setup UI 模块
 * VS Code 风格双栏布局：左侧按 section 粒度导航，右侧只显示当前 section 内容，仅右侧可滚动。
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
      <nav class="fs-nav" id="fs-nav"><div class="fs-nav-loading">...</div></nav>
      <main class="fs-main" id="fs-main">
        <div class="fs-spinner-wrap"><div class="fs-spinner"></div></div>
      </main>
    </div>
  `;
}

// ── State ────────────────────────────────────────────────────

window._featureSetupData = { manifests: null, config: null, loading: false, sections: [], activeId: null };

window._loadFeatureSetupData = async function () {
  if (window._featureSetupData.loading) return;
  window._featureSetupData.loading = true;
  try {
    const [mRes, cRes] = await Promise.all([
      fetch('/protoclaw/system_feature_manifests'),
      fetch('/protoclaw/system_feature_config'),
    ]);
    window._featureSetupData.manifests = (await mRes.json()).features || [];
    window._featureSetupData.config = await cRes.json();
    _buildSections();
  } catch (err) {
    console.error('Failed to load feature setup data:', err);
    const el = document.getElementById('fs-main');
    if (el) el.innerHTML = '<div class="fs-main-error">Failed to load</div>';
  } finally {
    window._featureSetupData.loading = false;
  }
};

// ── Build section-level nav items ────────────────────────────

function _buildSections() {
  const { manifests, config } = window._featureSetupData;
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
          featureConfig: config[featureName] || {},
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
        featureConfig: config[featureName] || {},
      });
    }
  }

  window._featureSetupData.sections = sections;
  _renderNav(sections);
  if (sections.length) window._fsSelect(sections[0].id);
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

// ── Select section → render right panel ──────────────────────

window._fsSelect = function (id) {
  const { sections } = window._featureSetupData;

  // Sync current page values back to memory config before switching
  _syncCurrentPageToConfig();

  window._featureSetupData.activeId = id;

  document.querySelectorAll('.fs-nav-item').forEach(el =>
    el.classList.toggle('active', el.getAttribute('data-id') === id)
  );

  const sec = sections.find(s => s.id === id);
  if (!sec) return;

  const mainEl = document.getElementById('fs-main');
  if (!mainEl) return;

  // Always read from live config, not the stale snapshot
  const liveFeatureConfig = window._featureSetupData.config[sec.featureName] || {};

  let cardsHtml = '';
  for (const key of sec.propKeys) {
    const prop = sec.props[key];
    if (!prop) continue;
    if (prop.type === 'group') {
      cardsHtml += _renderGroupCard(key, prop, liveFeatureConfig[key] || {}, `${sec.featureName}.${key}`);
    } else {
      cardsHtml += _renderSingleCard(key, prop, liveFeatureConfig[key], `${sec.featureName}.${key}`);
    }
  }

  mainEl.innerHTML = `
    <div class="fs-content">
      <div class="fs-cards">${cardsHtml}</div>
    </div>
    <div class="fs-auto-save-status" id="fs-auto-save-status"></div>
  `;
  mainEl.scrollTop = 0;
  _attachShowWhenListeners(mainEl);
  _attachAutoSave(mainEl);
};

// ── Group card (e.g. a server with mode/binary/runtime) ──────

function _renderGroupCard(key, prop, groupValue, scopePrefix) {
  const subProps = prop.properties || {};
  let rowsHtml = '';
  for (const [sk, sp] of Object.entries(subProps)) {
    rowsHtml += _renderRow(sp, groupValue[sk], `${scopePrefix}.${sk}`, scopePrefix);
  }
  return `
    <div class="fs-card">
      <div class="fs-card-header">${escapeHtml(prop.title || key)}</div>
      ${rowsHtml}
    </div>
  `;
}

// ── Single property card ─────────────────────────────────────

function _renderSingleCard(key, prop, value, fullKey) {
  return `
    <div class="fs-card">
      ${_renderRow(prop, value, fullKey, fullKey.includes('.') ? fullKey.substring(0, fullKey.lastIndexOf('.')) : '')}
    </div>
  `;
}

// ── Row: title+desc | control ────────────────────────────────

function _renderRow(prop, value, fullKey, scopePrefix) {
  const sw = prop.showWhen ? ` style="display:none;" data-showwhen='${JSON.stringify(prop.showWhen)}'` : '';
  return `
    <div class="fs-row"${sw} data-prop-key="${escapeHtml(fullKey)}">
      <div class="fs-row-main">
        <div class="fs-row-title">${escapeHtml(prop.title || '')}</div>
        ${prop.description ? `<div class="fs-row-desc">${escapeHtml(prop.description)}</div>` : ''}
      </div>
      <div class="fs-row-ctrl">${_renderInput(fullKey, prop, value)}</div>
    </div>
  `;
}

// ── Input controls ───────────────────────────────────────────

function _renderInput(fullKey, prop, value) {
  const id = `fsp-${_cssid(fullKey)}`;
  const val = value != null ? String(value) : (prop.default != null ? String(prop.default) : '');

  switch (prop.type) {
    case 'select': {
      let h = `<select id="${id}" class="fs-select" data-config-key="${escapeHtml(fullKey)}">`;
      if (prop.options) {
        for (const o of prop.options) {
          h += `<option value="${escapeHtml(String(o.value))}"${String(o.value) === val ? ' selected' : ''}>${escapeHtml(o.label)}</option>`;
        }
      }
      return h + `</select>`;
    }
    case 'file':
      return `<input type="text" id="${id}" class="fs-input" data-config-key="${escapeHtml(fullKey)}" value="${escapeHtml(val)}" placeholder="${escapeHtml(prop.placeholder || '')}" />`;
    case 'boolean':
      return `<input type="checkbox" id="${id}" class="fs-checkbox" data-config-key="${escapeHtml(fullKey)}" ${val === 'true' ? 'checked' : ''} />`;
    case 'number':
      return `<input type="number" id="${id}" class="fs-input" data-config-key="${escapeHtml(fullKey)}" value="${escapeHtml(val)}" ${prop.min != null ? `min="${prop.min}"` : ''} ${prop.max != null ? `max="${prop.max}"` : ''} ${prop.step != null ? `step="${prop.step}"` : ''} />`;
    default:
      return `<input type="text" id="${id}" class="fs-input" data-config-key="${escapeHtml(fullKey)}" value="${escapeHtml(val)}" placeholder="${escapeHtml(prop.placeholder || '')}" />`;
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

// ── Auto-save ────────────────────────────────────────────────

let _autoSaveTimer = null;

/** Read current DOM inputs and sync to in-memory config (no server call) */
function _syncCurrentPageToConfig() {
  const { config } = window._featureSetupData;
  if (!config) return;
  for (const input of document.querySelectorAll('#fs-main [data-config-key]')) {
    const key = input.getAttribute('data-config-key');
    if (!key) continue;
    let val;
    if (input.type === 'checkbox') val = input.checked;
    else if (input.type === 'number') val = input.value ? Number(input.value) : '';
    else val = input.value.trim();
    _setNestedValue(config, key.split('.'), val);
  }
}

function _attachAutoSave(container) {
  const inputs = container.querySelectorAll('[data-config-key]');
  for (const input of inputs) {
    const tag = input.tagName.toLowerCase();
    const evt = (tag === 'select' || input.type === 'checkbox') ? 'change' : 'input';
    input.addEventListener(evt, () => {
      clearTimeout(_autoSaveTimer);
      _autoSaveTimer = setTimeout(_doAutoSave, 600);
    });
  }
}

async function _doAutoSave() {
  const { config } = window._featureSetupData;
  const statusEl = document.getElementById('fs-auto-save-status');

  // Sync DOM → memory first
  _syncCurrentPageToConfig();
  const newConfig = JSON.parse(JSON.stringify(config || {}));

  if (newConfig.runtimes) {
    for (const [k, v] of Object.entries(newConfig.runtimes)) {
      if (v === '') delete newConfig.runtimes[k];
    }
    if (!Object.keys(newConfig.runtimes).length) delete newConfig.runtimes;
  }

  if (statusEl) { statusEl.textContent = 'Saving...'; statusEl.classList.add('visible'); }

  try {
    const res = await fetch('/protoclaw/system_feature_config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newConfig),
    });
    if (res.ok) {
      window._featureSetupData.config = newConfig;
      if (statusEl) statusEl.textContent = 'Saved';
    } else {
      if (statusEl) statusEl.textContent = 'Failed';
    }
  } catch {
    if (statusEl) statusEl.textContent = 'Failed';
  }

  setTimeout(() => {
    if (statusEl) statusEl.classList.remove('visible');
  }, 1500);
}

// ── Helpers ──────────────────────────────────────────────────

function _cssid(key) { return key.replace(/[^a-zA-Z0-9-]/g, '-'); }

function _setNestedValue(obj, parts, value) {
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}
