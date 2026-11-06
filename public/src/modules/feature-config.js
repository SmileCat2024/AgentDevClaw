/**
 * feature-config.js — Feature configuration data + manifest rendering
 *
 * Extracted from app-ui.js Phase 2b-3.
 * Provides:
 *   - Feature config CRUD (getFeatureConfig, writeFeatureConfig, updateFeatureConfigField, ...)
 *   - Feature config lookup/matching (buildFeatureConfigLookupKeys, featureConfigKeyMatches, ...)
 *   - Feature manifest resolution (resolveFeaturePackageRecord, findFeatureManifestForSelection, ...)
 *   - Feature settings UI rendering (renderFWFeatureSettings, renderFeatureConfigControl, ...)
 *   - 配置控件交互：模板声明 data-action="featureConfig.*"，处理器在文件尾部
 *     集中注册（action-dispatcher.js）；原 window.fw* 导出零外部消费面，
 *     已收敛为模块级函数
 *
 * Depends on (global scope):
 *   - getAgentWorkspaceState, updateAgentWorkspaceState (app-ui.js)
 *   - buildAutoSavedAssemblyConfigs, getSavedAssemblyConfigs, saveWorkspaceFormDraft (app-ui.js / app-main.js)
 *   - canonicalizeAssemblyFeatureSelection, parseWorkspaceListField, normalizeAssemblyDraft, getWorkspaceFormDraft (app-ui.js)
 *   - ensureFWFeatureCapabilities, requestFWFeatureCapabilities (app-ui.js)
 *   - getCurrentAgentRecord, renderCurrentMainView (app-ui.js)
 *   - escapeHtml, currentLanguage, invoke (app-core.js / app-ui.js)
 *   - shouldAnimateWorkspaceSurface (app-ui.js)
 */

// ---------------------------------------------------------------------------
// Feature Config — data-path helpers (no UI)
// ---------------------------------------------------------------------------

function getFeatureConfig(agent, featureKey) {
  const ws = getAgentWorkspaceState(agent);
  const configs = ws?.forms?.['feature-configs'];
  if (!configs || typeof configs !== 'object') return {};
  const entry = configs[featureKey];
  return entry && typeof entry === 'object' ? { ...entry } : {};
}

function normalizeFeatureConfigEntry(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  return Object.fromEntries(Object.entries(config).filter(([key, value]) => String(key || '').trim() && value !== undefined));
}

function findFeatureConfigMapEntry(configs, featureKey) {
  if (!configs || typeof configs !== 'object') return null;
  const target = String(featureKey || '').trim();
  if (!target) return null;
  if (configs[target] && typeof configs[target] === 'object' && !Array.isArray(configs[target])) {
    return { key: target, value: normalizeFeatureConfigEntry(configs[target]) };
  }
  const matched = Object.entries(configs).find(([key]) => featureConfigKeyMatches(key, target));
  if (!matched) return null;
  return { key: String(matched[0] || '').trim(), value: normalizeFeatureConfigEntry(matched[1]) };
}

function removeMatchingFeatureConfigAliases(configs, featureKey) {
  const target = String(featureKey || '').trim();
  Object.keys(configs || {}).forEach((key) => {
    if (key !== target && featureConfigKeyMatches(key, target)) {
      delete configs[key];
    }
  });
}

async function updateFeatureConfigField(agent, featureKey, field, value) {
  const ws = getAgentWorkspaceState(agent);
  const configs = { ...(ws?.forms?.['feature-configs'] || {}) };
  const entry = findFeatureConfigMapEntry(configs, featureKey);
  const current = normalizeFeatureConfigEntry(entry?.value || {});
  removeMatchingFeatureConfigAliases(configs, featureKey);
  if (value === undefined) {
    delete current[field];
  } else {
    current[field] = value;
  }
  if (Object.keys(current).length > 0) {
    configs[featureKey] = current;
  } else {
    delete configs[featureKey];
  }
  const nextForms = { ...(ws.forms || {}), 'feature-configs': configs };
  const payload = {
    forms: nextForms,
    openDirectory: typeof ws.openDirectory === 'string' ? ws.openDirectory : '',
  };
  if ((agent.id === 'agent-creator' || agent.id === 'flow-workspace') && nextForms['assembly-form']) {
    payload.assemblyConfigs = buildAutoSavedAssemblyConfigs(
      agent,
      nextForms['assembly-form'],
      Array.isArray(ws?.assemblyConfigs) ? ws.assemblyConfigs : getSavedAssemblyConfigs(agent),
      configs,
    );
  }
  const response = await fetch('/protoclaw/workspace_state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: agent.id, state: payload }),
  });
  if (!response.ok) {
    throw new Error(await response.text().catch(() => 'Failed to save feature config'));
  }
  const nextState = await response.json();
  updateAgentWorkspaceState(agent.id, nextState);
  saveWorkspaceFormDraft(agent.id, nextState.forms || {});
  return nextState;
}

async function writeFeatureConfig(agent, featureKey, config) {
  const ws = getAgentWorkspaceState(agent);
  const configs = { ...(ws?.forms?.['feature-configs'] || {}) };
  removeMatchingFeatureConfigAliases(configs, featureKey);
  const normalized = normalizeFeatureConfigEntry(config);
  if (Object.keys(normalized).length > 0) {
    configs[featureKey] = normalized;
  } else {
    delete configs[featureKey];
  }
  const nextForms = { ...(ws.forms || {}), 'feature-configs': configs };
  const payload = {
    forms: nextForms,
    openDirectory: typeof ws.openDirectory === 'string' ? ws.openDirectory : '',
  };
  if ((agent.id === 'agent-creator' || agent.id === 'flow-workspace') && nextForms['assembly-form']) {
    payload.assemblyConfigs = buildAutoSavedAssemblyConfigs(
      agent,
      nextForms['assembly-form'],
      Array.isArray(ws?.assemblyConfigs) ? ws.assemblyConfigs : getSavedAssemblyConfigs(agent),
      configs,
    );
  }
  const response = await fetch('/protoclaw/workspace_state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: agent.id, state: payload }),
  });
  if (!response.ok) {
    throw new Error(await response.text().catch(() => 'Failed to save feature config'));
  }
  const nextState = await response.json();
  updateAgentWorkspaceState(agent.id, nextState);
  saveWorkspaceFormDraft(agent.id, nextState.forms || {});
  return nextState;
}

// ---------------------------------------------------------------------------
// Feature Config — lookup/matching helpers
// ---------------------------------------------------------------------------

function buildFeatureConfigLookupKeys(value) {
  const raw = String(value || '').trim();
  const normalized = raw.toLowerCase().replace(/^@agentdevjs\//, '').replace(/-feature$/, '');
  const keys = new Set();
  if (raw) keys.add(raw.toLowerCase());
  if (normalized) {
    keys.add(normalized);
    keys.add(`@agentdevjs/${normalized}`);
    keys.add(`@agentdevjs/${normalized}-feature`);
  }
  return keys;
}

function featureConfigKeyMatches(featureRef, configKey) {
  const left = buildFeatureConfigLookupKeys(featureRef);
  const right = buildFeatureConfigLookupKeys(configKey);
  for (const key of left) {
    if (right.has(key)) return true;
  }
  return false;
}

function normalizeFeatureConfigMap(configs) {
  if (!configs || typeof configs !== 'object') return {};
  const result = {};
  Object.entries(configs).forEach(([key, value]) => {
    const normalizedKey = String(key || '').trim();
    const normalizedValue = normalizeFeatureConfigEntry(value);
    if (!normalizedKey || !Object.keys(normalizedValue).length) return;
    result[normalizedKey] = normalizedValue;
  });
  return result;
}

// ---------------------------------------------------------------------------
// Feature Package resolution + Manifest helpers
// ---------------------------------------------------------------------------

function resolveFeaturePackageRecord(packages, token) {
  const rawToken = String(token || '').trim();
  if (!rawToken) return null;
  const rawKeys = buildFeatureConfigLookupKeys(rawToken);
  return (packages || []).find((pkg) => {
    const candidates = [
      pkg?.packageName,
      pkg?.name,
      pkg?.id,
      String(pkg?.name || '').replace(/^@agentdevjs\//, ''),
    ].filter(Boolean);
    return candidates.some((value) => {
      const keys = buildFeatureConfigLookupKeys(value);
      for (const key of keys) {
        if (rawKeys.has(key)) return true;
      }
      return false;
    });
  }) || null;
}

function findFeatureManifestForSelection(caps, token, pkg) {
  const manifests = Array.isArray(caps?.featureManifests) ? caps.featureManifests : [];
  const candidates = [
    token,
    pkg?.packageName,
    pkg?.name,
    pkg?.id,
  ].filter(Boolean);
  return manifests.find((manifest) => {
    const manifestKeys = [
      manifest?.packageName,
      manifest?.featureName,
      manifest?.featureId,
    ].filter(Boolean);
    return candidates.some((value) => manifestKeys.some((key) => featureConfigKeyMatches(value, key)));
  }) || null;
}

function getFeatureManifestPropertyEntries(manifest) {
  const properties = manifest?.settings?.properties;
  return properties && typeof properties === 'object'
    ? Object.entries(properties).filter(([key, value]) => String(key || '').trim() && value && typeof value === 'object')
    : [];
}

function getFeatureManifestDisplayName(token, pkg, manifest) {
  const raw = String(pkg?.name || manifest?.featureName || manifest?.packageName || token || '').trim();
  return raw.replace(/^@agentdevjs\//, '').replace(/-feature$/, '');
}

function formatManifestDefaultValue(property) {
  if (!property || !Object.prototype.hasOwnProperty.call(property, 'default')) return currentLanguage === 'zh' ? '无默认值' : 'No default';
  const value = property.default;
  if (property.type === 'boolean') return value ? 'true' : 'false';
  if (property.type === 'directory') {
    if (Array.isArray(value) && value.length > 0) return value.join(', ');
    return currentLanguage === 'zh' ? '空' : 'Empty';
  }
  if (value === '' || value == null) return currentLanguage === 'zh' ? '空' : 'Empty';
  return String(value);
}

function normalizeManifestComparableValue(type, value) {
  if (type === 'number') {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }
  if (type === 'boolean') {
    return value === true || value === 'true' || value === 1 || value === '1';
  }
  if (type === 'directory') {
    const dirs = Array.isArray(value) ? value : [];
    return dirs.slice().sort().join('|');
  }
  if (type === 'file' && Array.isArray(value)) {
    return value.slice().sort().join('|');
  }
  return String(value ?? '').trim();
}

function getFeatureConfigStatusMeta(manifest, config) {
  const entries = getFeatureManifestPropertyEntries(manifest);
  let overriddenCount = 0;
  entries.forEach(([field, property]) => {
    if (!Object.prototype.hasOwnProperty.call(config, field)) return;
    const currentValue = normalizeManifestComparableValue(property.type, config[field]);
    const defaultValue = normalizeManifestComparableValue(property.type, property.default);
    if (currentValue !== defaultValue) {
      overriddenCount += 1;
    }
  });
  return {
    overriddenCount,
    customized: overriddenCount > 0,
    label: overriddenCount > 0
      ? (currentLanguage === 'zh' ? `已自定义 ${overriddenCount} 项` : `${overriddenCount} override${overriddenCount > 1 ? 's' : ''}`)
      : (currentLanguage === 'zh' ? '使用默认值' : 'Using defaults'),
  };
}

function coerceFeatureManifestValue(type, rawValue) {
  if (type === 'boolean') return !!rawValue;
  if (type === 'number') {
    const text = String(rawValue ?? '').trim();
    if (!text) return undefined;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (type === 'directory') {
    if (Array.isArray(rawValue)) return rawValue.filter(Boolean);
    if (typeof rawValue === 'string') {
      const trimmed = rawValue.trim();
      return trimmed ? [trimmed] : [];
    }
    return [];
  }
  if (type === 'file' && Array.isArray(rawValue)) {
    return rawValue.map((value) => String(value || '').trim()).filter(Boolean);
  }
  const text = String(rawValue ?? '').trim();
  return text ? text : undefined;
}

function parseInlineDataValue(rawValue) {
  if (rawValue == null) return '';
  const text = String(rawValue);
  if (!text) return '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeAcceptList(accept) {
  return (Array.isArray(accept) ? accept : [accept])
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function matchesFeatureConfigAccept(pathValue, accept) {
  const pathText = String(pathValue || '').trim().toLowerCase();
  if (!pathText) return true;
  const accepts = normalizeAcceptList(accept);
  if (!accepts.length) return true;
  const extensionMatch = pathText.match(/(\.[a-z0-9]+)$/i);
  const ext = extensionMatch ? extensionMatch[1].toLowerCase() : '';
  return accepts.some((rule) => {
    if (rule.startsWith('.')) {
      return ext === rule;
    }
    if (rule === 'audio/*') {
      return ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'].includes(ext);
    }
    if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(rule)) {
      const subtype = rule.split('/')[1];
      return ext === `.${String(subtype || '').replace(/^\./, '')}`;
    }
    return false;
  });
}

function featureControlDomId(featureKey, field, suffix = '') {
  const raw = `${String(featureKey || '')}__${String(field || '')}${suffix ? `__${suffix}` : ''}`;
  return 'fw-manifest-' + raw.replace(/[^a-z0-9_-]+/gi, '-');
}

// ---------------------------------------------------------------------------
// Feature Config Control rendering
// ---------------------------------------------------------------------------

function renderFeatureConfigControl(featureKey, field, property, currentValue) {
  const serializedFeatureKey = escapeHtml(JSON.stringify(String(featureKey || '')));
  const serializedField = escapeHtml(JSON.stringify(String(field || '')));
  const type = String(property?.type || 'string');
  const displayValue = currentValue !== undefined && currentValue !== null ? String(currentValue) : '';
  if (type === 'boolean') {
    return '<label class="fw-setting-boolean"><input type="checkbox"' + (currentValue === true || currentValue === 'true' ? ' checked' : '') + ' data-action="featureConfig.commitValue" data-event="change" data-field-type="boolean" data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '"><span>' + escapeHtml(currentLanguage === 'zh' ? '启用此项' : 'Enabled') + '</span></label>';
  }
  if (type === 'select') {
    const options = Array.isArray(property?.options) ? property.options : [];
    let html = '<select class="fw-setting-select" data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '" data-action="featureConfig.commitValue" data-event="change" data-field-type="select">';
    html += '<option value="">' + escapeHtml(currentLanguage === 'zh' ? '使用默认值' : 'Use default') + '</option>';
    options.forEach((option) => {
      const optionValue = option && Object.prototype.hasOwnProperty.call(option, 'value') ? option.value : '';
      html += '<option value="' + escapeHtml(String(optionValue ?? '')) + '"' + (String(optionValue ?? '') === displayValue ? ' selected' : '') + '>' + escapeHtml(option?.label || String(optionValue ?? '')) + '</option>';
    });
    html += '</select>';
    return html;
  }
  if (type === 'number') {
    const hasRange = Number.isFinite(Number(property?.min)) || Number.isFinite(Number(property?.max));
    const min = Number.isFinite(Number(property?.min)) ? Number(property.min) : 0;
    const max = Number.isFinite(Number(property?.max)) ? Number(property.max) : 100;
    const step = Number.isFinite(Number(property?.step)) && Number(property.step) > 0 ? Number(property.step) : 1;
    if (hasRange) {
      const rangeId = featureControlDomId(featureKey, field, 'range');
      const numberId = featureControlDomId(featureKey, field, 'number');
      const rawCurrent = displayValue || String(property?.default ?? min);
      return [
        '<div class="fw-setting-range-row">',
        '<input class="fw-setting-range" id="' + escapeHtml(rangeId) + '" type="range" min="' + escapeHtml(String(min)) + '" max="' + escapeHtml(String(max)) + '" step="' + escapeHtml(String(step)) + '" value="' + escapeHtml(rawCurrent) + '"',
        ' data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '"',
        ' data-action="featureConfig.rangeChanged" data-event="input change" data-target-id="' + escapeHtml(numberId) + '">',
        '<input class="fw-setting-input fw-setting-number" id="' + escapeHtml(numberId) + '" type="number" min="' + escapeHtml(String(min)) + '" max="' + escapeHtml(String(max)) + '" step="' + escapeHtml(String(step)) + '" value="' + escapeHtml(rawCurrent) + '"',
        ' data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '"',
        ' data-action="featureConfig.rangeChanged" data-event="input change" data-target-id="' + escapeHtml(rangeId) + '">',
        '</div>',
      ].join('');
    }
  }
  if (type === 'file') {
    const acceptValue = escapeHtml(String(property?.accept ?? ''));
    const files = Array.isArray(currentValue) ? currentValue : null;
    const maxItems = Number(property?.maxItems) > 0 ? Number(property.maxItems) : 5;
    if (files) {
      let html = '<div class="fw-setting-directory-list">';
      files.forEach((filePath, index) => {
        html += '<div class="fw-setting-dir-item">';
        html += '<input class="fw-setting-input" value="' + escapeHtml(String(filePath || '')) + '" placeholder="' + escapeHtml(currentLanguage === 'zh' ? '文件路径' : 'File path') + '" data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '" data-file-index="' + index + '" data-action="featureConfig.updateFilePath" data-event="change">';
        html += '<button class="workspace-action secondary" type="button" data-action="featureConfig.pickFile" data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '" data-file-index="' + index + '" data-accept="' + acceptValue + '">' + escapeHtml(currentLanguage === 'zh' ? '选择文件' : 'Browse') + '</button>';
        html += '<button class="fw-setting-dir-remove" type="button" data-action="featureConfig.removeFile" data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '" data-file-index="' + index + '">&times;</button>';
        html += '</div>';
      });
      if (files.length < maxItems) {
        html += '<button class="fw-setting-dir-add workspace-action" type="button" data-action="featureConfig.addFile" data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '">+ ' + escapeHtml(currentLanguage === 'zh' ? '添加文件' : 'Add file') + '</button>';
      }
      html += '</div>';
      return html;
    }
    return [
      '<div class="fw-setting-file-row">',
      '<input class="fw-setting-input" value="' + escapeHtml(displayValue) + '" placeholder="' + escapeHtml(property?.placeholder || (currentLanguage === 'zh' ? '留空则使用默认路径' : 'Leave blank to use the default path')) + '" data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '" data-action="featureConfig.commitValue" data-event="change" data-field-type="file">',
      '<button class="workspace-action secondary" type="button" data-action="featureConfig.pickFile" data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '" data-accept="' + acceptValue + '">' + escapeHtml(currentLanguage === 'zh' ? '选择文件' : 'Browse') + '</button>',
      '</div>',
    ].join('');
  }
  if (type === 'directory') {
    const dirs = Array.isArray(currentValue) ? currentValue : [];
    const maxItems = Number(property?.maxItems) > 0 ? Number(property.maxItems) : 5;
    let html = '<div class="fw-setting-directory-list">';
    dirs.forEach((dir, index) => {
      html += '<div class="fw-setting-dir-item">';
      html += '<input class="fw-setting-input" value="' + escapeHtml(String(dir || '')) + '" placeholder="' + escapeHtml(currentLanguage === 'zh' ? '目录路径' : 'Directory path') + '" data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '" data-dir-index="' + index + '" data-action="featureConfig.updateDirectoryPath" data-event="change">';
      html += '<button class="workspace-action secondary" type="button" data-action="featureConfig.pickDirectory" data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '" data-dir-index="' + index + '">' + escapeHtml(currentLanguage === 'zh' ? '选择目录' : 'Browse') + '</button>';
      html += '<button class="fw-setting-dir-remove" type="button" data-action="featureConfig.removeDirectory" data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '" data-dir-index="' + index + '">&times;</button>';
      html += '</div>';
    });
    if (dirs.length < maxItems) {
      html += '<button class="fw-setting-dir-add workspace-action" type="button" data-action="featureConfig.addDirectory" data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '">+ ' + escapeHtml(currentLanguage === 'zh' ? '添加目录' : 'Add directory') + '</button>';
    }
    html += '</div>';
    return html;
  }
  return '<input class="fw-setting-input" type="' + (type === 'number' ? 'number' : 'text') + '" value="' + escapeHtml(displayValue) + '" placeholder="' + escapeHtml(property?.placeholder || (currentLanguage === 'zh' ? '留空则使用默认值' : 'Leave blank to use the default value')) + '"' + (type === 'number' && Number.isFinite(Number(property?.min)) ? ' min="' + escapeHtml(String(property.min)) + '"' : '') + (type === 'number' && Number.isFinite(Number(property?.max)) ? ' max="' + escapeHtml(String(property.max)) + '"' : '') + (type === 'number' && Number.isFinite(Number(property?.step)) ? ' step="' + escapeHtml(String(property.step)) + '"' : '') + ' data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '" data-action="featureConfig.commitValue" data-event="change" data-field-type="' + escapeHtml(type) + '">';
}

// ---------------------------------------------------------------------------
// Feature Settings panel rendering (flow-workspace config section)
// ---------------------------------------------------------------------------

function renderFWFeatureSettings(agent, draft, packages) {
  const selected = canonicalizeAssemblyFeatureSelection(agent, parseWorkspaceListField(draft.selected_features));
  const cache = ensureFWFeatureCapabilities(agent, draft);
  const caps = cache.data || {};
  const featureConfigMap = normalizeFeatureConfigMap(getAgentWorkspaceState(agent)?.forms?.['feature-configs'] || {});
  const groups = selected.map((token) => {
    const pkg = resolveFeaturePackageRecord(packages, token);
    const manifest = findFeatureManifestForSelection(caps, token, pkg);
    const featureKey = String(manifest?.packageName || pkg?.packageName || token || '').trim();
    const currentEntry = findFeatureConfigMapEntry(featureConfigMap, featureKey)
      || findFeatureConfigMapEntry(featureConfigMap, token);
    return {
      token,
      pkg,
      manifest,
      featureKey,
      name: getFeatureManifestDisplayName(token, pkg, manifest),
      currentConfig: normalizeFeatureConfigEntry(currentEntry?.value || {}),
    };
  });

  // Append built-in features with manifest that aren't already in selected
  const coveredKeys = groups.map((g) => g.featureKey).filter(Boolean);
  const isCovered = (key) => coveredKeys.some((existing) => featureConfigKeyMatches(key, existing));
  const builtInManifests = Array.isArray(caps?.featureManifests) ? caps.featureManifests : [];
  builtInManifests.forEach((manifest) => {
    const featureKey = String(manifest?.featureId || manifest?.featureName || manifest?.packageName || '').trim();
    if (!featureKey || isCovered(featureKey)) return;
    if (getFeatureManifestPropertyEntries(manifest).length === 0) return;
    const currentEntry = findFeatureConfigMapEntry(featureConfigMap, featureKey);
    groups.push({
      token: featureKey,
      pkg: null,
      manifest,
      featureKey,
      name: getFeatureManifestDisplayName(featureKey, null, manifest),
      currentConfig: normalizeFeatureConfigEntry(currentEntry?.value || {}),
    });
    coveredKeys.push(featureKey);
  });

  const configurableGroups = groups.filter((item) => getFeatureManifestPropertyEntries(item.manifest).length > 0);

  let html = '<section class="fw-settings">';

  if (!configurableGroups.length && !selected.length) {
    html += '<div class="fw-settings-empty">' + escapeHtml(currentLanguage === 'zh' ? '先在右侧启用至少一个 Feature，这里才会出现对应的配置表单。' : 'Enable at least one Feature on the right to reveal its settings here.') + '</div>';
    html += '</section>';
    return html;
  }

  if (cache.loading && !cache.data) {
    html += '<div class="fw-settings-empty">' + escapeHtml(currentLanguage === 'zh' ? '正在读取已启用 Feature 的配置契约…' : 'Loading manifests for mounted Features…') + '</div>';
    html += '</section>';
    return html;
  }

  if (cache.error && !cache.data) {
    html += '<div class="fw-settings-empty danger">' + escapeHtml((currentLanguage === 'zh' ? '读取 Feature 契约失败：' : 'Failed to load Feature manifests: ') + cache.error) + '</div>';
    html += '</section>';
    return html;
  }

  configurableGroups.forEach((group) => {
    const entries = getFeatureManifestPropertyEntries(group.manifest);
    const status = getFeatureConfigStatusMeta(group.manifest, group.currentConfig);
    html += '<div class="fw-setting-group">';
    html += '<div class="fw-setting-group-head"><div class="fw-setting-group-title">' + escapeHtml(group.name) + '</div>';
    html += '<div class="fw-setting-group-actions"><span class="fw-setting-status' + (status.customized ? ' customized' : '') + '">' + escapeHtml(status.label) + '</span><button class="workspace-action secondary" type="button" data-action="featureConfig.reset" data-feature-key="' + escapeHtml(JSON.stringify(group.featureKey)) + '">' + escapeHtml(currentLanguage === 'zh' ? '恢复默认' : 'Reset') + '</button></div></div>';
    html += '<div class="fw-setting-grid">';
    entries.forEach(([field, property]) => {
      const currentValue = Object.prototype.hasOwnProperty.call(group.currentConfig, field)
        ? group.currentConfig[field]
        : property.default;
      html += '<div class="fw-setting-row">';
      html += '<div class="fw-setting-label-row"><label>' + escapeHtml(property.title || field) + '</label></div>';
      html += renderFeatureConfigControl(group.featureKey, field, property, currentValue);
      const hintParts = [];
      if (property.description) hintParts.push(property.description);
      const defVal = formatManifestDefaultValue(property);
      if (defVal) hintParts.push((currentLanguage === 'zh' ? '默认' : 'default') + ': ' + defVal);
      if (hintParts.length) {
        html += '<div class="fw-setting-hint">' + escapeHtml(hintParts.join(' · ')) + '</div>';
      }
      html += '</div>';
    });
    html += '</div></div>';
  });

  if (!configurableGroups.length) {
    html += '<div class="fw-settings-empty">' + escapeHtml(currentLanguage === 'zh' ? '当前已挂载 Feature 还没有暴露可配置项。' : 'No mounted Feature exposes project-level settings yet.') + '</div>';
  }

  html += '</section>';
  return html;
}

// ---------------------------------------------------------------------------
// 配置控件动作（data-action="featureConfig.*"，处理器收敛在本模块局部）
// ---------------------------------------------------------------------------
// 原 window.fw* 导出全仓消费面为零（仅本模块模板的处理器字符串引用），
// 遂收敛为模块级 const；控件改为 data-action 声明后经 action-dispatcher
// 委托分发。

async function _fwRefreshFeatureCapabilities() {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = normalizeAssemblyDraft(getWorkspaceFormDraft(agent)?.['assembly-form'] || {});
  await requestFWFeatureCapabilities(agent, draft, { force: true });
  if (window.ClawFlowEditor && typeof window.ClawFlowEditor.refreshCapabilities === 'function') {
    window.ClawFlowEditor.refreshCapabilities().catch(e => console.warn(e));
  }
}

async function _fwCommitFeatureConfigValue(featureKey, field, type, rawValue) {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  try {
    const value = coerceFeatureManifestValue(type, rawValue);
    await updateFeatureConfigField(agent, String(featureKey || ''), String(field || ''), value);
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to save feature config field:', error);
    window.alert((currentLanguage === 'zh' ? '保存 Feature 配置失败：' : 'Failed to save feature config: ') + (error?.message || error));
  }
}

async function _fwResetFeatureConfig(featureKey) {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  try {
    await writeFeatureConfig(agent, String(featureKey || ''), {});
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to reset feature config:', error);
    window.alert((currentLanguage === 'zh' ? '恢复默认配置失败：' : 'Failed to reset feature config: ') + (error?.message || error));
  }
}

/** 数字区间控件与数值输入框联动：一侧输入即时同步另一侧显示值。 */
function _fwSyncManifestRange(targetId, value) {
  const target = document.getElementById(String(targetId || ''));
  if (target) {
    target.value = String(value ?? '');
  }
}

async function _fwPickFeatureConfigFile(button) {
  const agent = getCurrentAgentRecord();
  if (!agent?.id || !(button instanceof HTMLElement)) return;
  try {
    const parsedFeatureKey = parseInlineDataValue(button.dataset.featureKey);
    const parsedField = parseInlineDataValue(button.dataset.fieldName);
    const parsedAccept = parseInlineDataValue(button.dataset.accept || '');
    const fileIndex = button.dataset.fileIndex == null ? null : Number(button.dataset.fileIndex);
    button.disabled = true;
    button.textContent = currentLanguage === 'zh' ? '打开中…' : 'Opening…';
    const selected = await invoke('select_files');
    const chosenPath = Array.isArray(selected?.paths) ? String(selected.paths[0] || '').trim() : '';
    if (!chosenPath) {
      return;
    }
    if (parsedAccept && !matchesFeatureConfigAccept(chosenPath, parsedAccept)) {
      throw new Error(currentLanguage === 'zh' ? '所选文件类型不符合该配置项要求，请重新选择。' : 'The selected file type is not allowed for this setting. Please choose another file.');
    }
    if (fileIndex != null && Number.isFinite(fileIndex)) {
      const current = getFeatureConfig(agent, String(parsedFeatureKey || ''));
      const files = Array.isArray(current[parsedField]) ? [...current[parsedField]] : [];
      while (files.length <= fileIndex) files.push('');
      files[fileIndex] = chosenPath;
      current[parsedField] = files.filter(Boolean);
      await writeFeatureConfig(agent, String(parsedFeatureKey || ''), current);
    } else {
      await updateFeatureConfigField(agent, String(parsedFeatureKey || ''), String(parsedField || ''), chosenPath || undefined);
    }
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to pick feature config file:', error);
    window.alert((currentLanguage === 'zh' ? '选择配置文件失败：' : 'Failed to choose file: ') + (error?.message || error));
  } finally {
    button.disabled = false;
    button.textContent = currentLanguage === 'zh' ? '选择文件' : 'Browse';
  }
}

async function _fwAddConfigFile(featureKey, field) {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  try {
    const current = getFeatureConfig(agent, String(featureKey || ''));
    const files = Array.isArray(current[field]) ? [...current[field]] : [];
    files.push('');
    current[field] = files;
    await writeFeatureConfig(agent, String(featureKey || ''), current);
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to add config file:', error);
  }
}

async function _fwRemoveConfigFile(featureKey, field, index) {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  try {
    const current = getFeatureConfig(agent, String(featureKey || ''));
    const files = Array.isArray(current[field]) ? [...current[field]] : [];
    files.splice(index, 1);
    if (files.length > 0) {
      current[field] = files.filter(Boolean);
    } else {
      delete current[field];
    }
    await writeFeatureConfig(agent, String(featureKey || ''), current);
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to remove config file:', error);
  }
}

async function _fwUpdateConfigFilePath(featureKey, field, index, value) {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const trimmed = String(value || '').trim();
  try {
    const current = getFeatureConfig(agent, String(featureKey || ''));
    const files = Array.isArray(current[field]) ? [...current[field]] : [];
    while (files.length <= index) files.push('');
    if (trimmed) {
      files[index] = trimmed;
      current[field] = files.filter(Boolean);
    } else {
      files.splice(index, 1);
      if (files.length > 0) {
        current[field] = files.filter(Boolean);
      } else {
        delete current[field];
      }
    }
    await writeFeatureConfig(agent, String(featureKey || ''), current);
  } catch (error) {
    console.error('Failed to update config file path:', error);
  }
}

async function _fwPickFeatureConfigDirectory(button) {
  const agent = getCurrentAgentRecord();
  if (!agent?.id || !(button instanceof HTMLElement)) return;
  try {
    const parsedFeatureKey = parseInlineDataValue(button.dataset.featureKey);
    const parsedField = parseInlineDataValue(button.dataset.fieldName);
    const dirIndex = Number(button.dataset.dirIndex);
    button.disabled = true;
    button.textContent = currentLanguage === 'zh' ? '打开中…' : 'Opening…';
    const selected = await invoke('select_directory');
    const chosenPath = Array.isArray(selected?.paths) ? String(selected.paths[0] || '').trim() : (typeof selected?.path === 'string' ? selected.path.trim() : '');
    if (!chosenPath) {
      return;
    }
    const current = getFeatureConfig(agent, String(parsedFeatureKey || ''));
    const dirs = Array.isArray(current[parsedField]) ? [...current[parsedField]] : [];
    while (dirs.length <= dirIndex) dirs.push('');
    dirs[dirIndex] = chosenPath;
    current[parsedField] = dirs.filter(Boolean);
    await writeFeatureConfig(agent, String(parsedFeatureKey || ''), current);
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to pick feature config directory:', error);
    window.alert((currentLanguage === 'zh' ? '选择目录失败：' : 'Failed to choose directory: ') + (error?.message || error));
  } finally {
    button.disabled = false;
    button.textContent = currentLanguage === 'zh' ? '选择目录' : 'Browse';
  }
}

async function _fwAddConfigDirectory(featureKey, field) {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  try {
    const current = getFeatureConfig(agent, String(featureKey || ''));
    const dirs = Array.isArray(current[field]) ? [...current[field]] : [];
    dirs.push('');
    current[field] = dirs;
    await writeFeatureConfig(agent, String(featureKey || ''), current);
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to add config directory:', error);
  }
}

async function _fwRemoveConfigDirectory(featureKey, field, index) {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  try {
    const current = getFeatureConfig(agent, String(featureKey || ''));
    const dirs = Array.isArray(current[field]) ? [...current[field]] : [];
    dirs.splice(index, 1);
    if (dirs.length > 0) {
      current[field] = dirs;
    } else {
      delete current[field];
    }
    await writeFeatureConfig(agent, String(featureKey || ''), current);
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to remove config directory:', error);
  }
}

async function _fwUpdateConfigDirectoryPath(featureKey, field, index, value) {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const trimmed = String(value || '').trim();
  try {
    const current = getFeatureConfig(agent, String(featureKey || ''));
    const dirs = Array.isArray(current[field]) ? [...current[field]] : [];
    while (dirs.length <= index) dirs.push('');
    if (trimmed) {
      dirs[index] = trimmed;
      current[field] = dirs.filter(Boolean);
    } else {
      dirs.splice(index, 1);
      if (dirs.length > 0) {
        current[field] = dirs;
      } else {
        delete current[field];
      }
    }
    await writeFeatureConfig(agent, String(featureKey || ''), current);
  } catch (error) {
    console.error('Failed to update config directory path:', error);
  }
}

/** 控件的 featureKey / field 以 JSON 字符串写入 data-*（含引号，经 HTML
 *  转义），读取端统一 parseInlineDataValue 还原。 */
function _fwControlTarget(el) {
  return {
    featureKey: parseInlineDataValue(el.dataset.featureKey),
    field: parseInlineDataValue(el.dataset.fieldName),
  };
}

window.ClawFW = window.ClawFW || {};

window.ClawFW.actions.registerMany({
  'featureConfig.commitValue': (el) => {
    const { featureKey, field } = _fwControlTarget(el);
    const type = el.dataset.fieldType || 'string';
    return _fwCommitFeatureConfigValue(featureKey, field, type, type === 'boolean' ? el.checked : el.value);
  },
  // 区间滑块与数值框互为镜像：input 只同步另一侧显示（原 oninput 语义，
  // 拖动过程不落库），change 才提交（原 onchange 语义）。
  'featureConfig.rangeChanged': (el, event) => {
    if (event?.type === 'input') {
      _fwSyncManifestRange(el.dataset.targetId, el.value);
      return undefined;
    }
    const { featureKey, field } = _fwControlTarget(el);
    return _fwCommitFeatureConfigValue(featureKey, field, 'number', el.value);
  },
  'featureConfig.reset': (el) => _fwResetFeatureConfig(_fwControlTarget(el).featureKey),
  'featureConfig.pickFile': (el) => _fwPickFeatureConfigFile(el),
  'featureConfig.addFile': (el) => {
    const { featureKey, field } = _fwControlTarget(el);
    return _fwAddConfigFile(featureKey, field);
  },
  'featureConfig.removeFile': (el) => {
    const { featureKey, field } = _fwControlTarget(el);
    return _fwRemoveConfigFile(featureKey, field, Number(el.dataset.fileIndex));
  },
  'featureConfig.updateFilePath': (el) => {
    const { featureKey, field } = _fwControlTarget(el);
    return _fwUpdateConfigFilePath(featureKey, field, Number(el.dataset.fileIndex), el.value);
  },
  'featureConfig.pickDirectory': (el) => _fwPickFeatureConfigDirectory(el),
  'featureConfig.addDirectory': (el) => {
    const { featureKey, field } = _fwControlTarget(el);
    return _fwAddConfigDirectory(featureKey, field);
  },
  'featureConfig.removeDirectory': (el) => {
    const { featureKey, field } = _fwControlTarget(el);
    return _fwRemoveConfigDirectory(featureKey, field, Number(el.dataset.dirIndex));
  },
  'featureConfig.updateDirectoryPath': (el) => {
    const { featureKey, field } = _fwControlTarget(el);
    return _fwUpdateConfigDirectoryPath(featureKey, field, Number(el.dataset.dirIndex), el.value);
  },
});
