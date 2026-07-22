/**
 * fw-config-panel.js — FW 配置面板模块（从 app-ui.js 提取）
 *
 * 包含：
 *   - window.ClawFW 全局状态对象
 *   - Feature capability 缓存与请求 (getFWFeatureCapabilityState, requestFWFeatureCapabilities, ...)
 *   - Assembly drift 检测与对话框 (inspectAssemblySessionDrift, renderAssemblyDriftDialog, ...)
 *   - FW 列表/详情渲染入口 (renderProjectListBlock, fwRerender, fwEnterDetail, fwBackToList, fwSwitchSection)
 *   - Prompt Editor slash picker (fwCollectPickerItems, fwRenderPickerDropdown, 键盘交互, ...)
 *   - Feature import dialog (fwOpenFeatureImport, fwConfirmFeatureImport, fwCancelFeatureImport)
 *   - Project picker / Create / Confirm / Prompt 对话框
 *
 * 依赖（全局变量/函数，声明于 app-core.js / app-ui.js / 其他模块）：
 *   - currentLanguage, escapeHtml, t (app-core.js)
 *   - renderCurrentMainView, currentWorkspaceTab, shouldAnimateWorkspaceSurface (app-ui.js)
 *   - getCurrentAgentRecord, getWorkspaceFormDraft, saveWorkspaceFormDraft (app-core.js / 其他模块)
 *   - canonicalizeAssemblyFeatureSelection, parseWorkspaceListField (assembly-data.js)
 *   - getSavedAssemblyConfigs, getWorkspaceSessionById, isAssemblySession (assembly-data.js)
 *   - formatWorkspaceDate, formatRepoFileSize, getFeatureTypeLabel (assembly-data.js)
 *   - getAssemblyPresetLabel, getAssemblySavedConfigSummary (assembly-data.js)
 *   - persistWorkspaceState, updateAssemblyDraftWithoutRender (assembly-actions.js)
 *   - isValidAgentCreatorName, normalizeAssemblyDraft (assembly-data.js)
 *   - window.toggleWorkspaceSelection, window.commitAssemblyDraftField (assembly-actions.js)
 *   - window.loadSavedAssemblyConfig, window.resetAssemblyDraft (assembly-actions.js)
 *   - window.PromptEditorUtils (prompt editor utils)
 */

window.ClawFW = {
  mode: 'list',
  section: 'features',
  projectPickerOpen: false,
  createDialogOpen: false,
  promptEditorOpen: false,
  confirmDialog: null,
  featureImport: null,
  featureQuery: null,
  driftDialog: null,
  featureCapabilities: { key: '', loading: false, error: '', data: null },
  fwSlashPicker: { open: false, query: '', startIndex: 0, activeIndex: 0, category: 'all', formId: '' },
  settingsOpen: false,
  settingsData: null,
  settingsEditing: null,
  _modelPresets: null,
};

function getFWFeatureCapabilityState() {
  if (!window.ClawFW.featureCapabilities || typeof window.ClawFW.featureCapabilities !== 'object') {
    window.ClawFW.featureCapabilities = { key: '', loading: false, error: '', data: null };
  }
  return window.ClawFW.featureCapabilities;
}

function buildFWFeatureCapabilityKey(agent, draft = {}) {
  const selected = canonicalizeAssemblyFeatureSelection(agent, parseWorkspaceListField(draft.selected_features));
  return `${String(agent?.id || '')}|${selected.join(',')}`;
}

async function requestFWFeatureCapabilities(agent, draft = {}, options = {}) {
  if (!agent?.id) return null;
  const cache = getFWFeatureCapabilityState();
  const key = buildFWFeatureCapabilityKey(agent, draft);
  if (!options.force && cache.loading && cache.key === key) {
    return cache.data;
  }
  if (!options.force && cache.key === key && cache.data) {
    return cache.data;
  }

  cache.key = key;
  cache.loading = true;
  cache.error = '';
  try {
    const response = await fetch('/protoclaw/flow_capabilities?agentId=' + encodeURIComponent(agent.id));
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'Failed to load feature capabilities'));
    }
    const payload = await response.json();
    if (cache.key !== key) {
      return payload;
    }
    cache.data = payload && typeof payload === 'object' ? payload : {};
    cache.loading = false;
    cache.error = '';
  } catch (error) {
    if (cache.key === key) {
      cache.loading = false;
      cache.error = error?.message || String(error);
      cache.data = null;
    }
  }
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
  return cache.data;
}

function ensureFWFeatureCapabilities(agent, draft = {}) {
  const cache = getFWFeatureCapabilityState();
  const key = buildFWFeatureCapabilityKey(agent, draft);
  if (cache.key !== key && !cache.loading) {
    requestFWFeatureCapabilities(agent, draft).catch((error) => {
      console.error('Failed to load feature capabilities:', error);
    });
  }
  return cache;
}

function parseWorkspaceTimeMs(value) {
  const time = value ? new Date(String(value)).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function findAssemblyConfigForSession(agent, session) {
  const projectId = String(session?.agentName || '').trim();
  if (!projectId) return null;
  return getSavedAssemblyConfigs(agent).find((item) => String(item?.id || '').trim() === projectId || String(item?.name || '').trim() === projectId) || null;
}

async function fetchAssemblyGraphSummary(projectId) {
  const normalized = String(projectId || '').trim();
  if (!normalized) return null;
  try {
    const response = await fetch('/protoclaw/flow_graphs?agentId=' + encodeURIComponent(normalized));
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    const flows = Array.isArray(payload?.flows) ? payload.flows : [];
    return flows.find((item) => String(item?.id || '') === 'agent-flow-graph') || null;
  } catch (error) {
    console.warn('Failed to fetch assembly graph summary:', error);
    return null;
  }
}

async function inspectAssemblySessionDrift(agent, sessionId) {
  const session = getWorkspaceSessionById(agent, sessionId);
  if (!session || !isAssemblySession(session) || isAssemblySessionRunning(agent, session)) {
    return null;
  }
  const sessionTime = parseWorkspaceTimeMs(session.updatedAt);
  const projectId = String(session.agentName || '').trim();
  const reasons = [];
  const savedConfig = findAssemblyConfigForSession(agent, session);
  const configTime = parseWorkspaceTimeMs(savedConfig?.updatedAt);
  if (savedConfig && ((!sessionTime && configTime) || (sessionTime && configTime > sessionTime))) {
    reasons.push({
      title: currentLanguage === 'zh' ? '能力装配已更新' : 'Assembly config changed',
      detail: currentLanguage === 'zh'
        ? '这个项目的 Feature 选择或基础配置在该对话保存之后发生过变化。'
        : 'The project feature selection or base configuration changed after this session was last saved.',
      updatedAt: savedConfig?.updatedAt || '',
    });
  }
  const graph = await fetchAssemblyGraphSummary(projectId);
  const graphTime = parseWorkspaceTimeMs(graph?.updatedAt);
  if (graph && ((!sessionTime && graphTime) || (sessionTime && graphTime > sessionTime))) {
    reasons.push({
      title: currentLanguage === 'zh' ? '编排图已更新' : 'Flow graph changed',
      detail: currentLanguage === 'zh'
        ? '该对话对应的编排图在会话保存之后被编辑过，恢复时可能出现定义与现场不一致。'
        : 'The orchestration graph was edited after this session was saved, so restoring it may resume with stale runtime state.',
      updatedAt: graph?.updatedAt || '',
    });
  }
  if (!reasons.length) return null;
  return {
    session,
    projectId,
    reasons,
  };
}

function ensureAssemblyDriftDialogHost() {
  let host = document.getElementById('assembly-drift-dialog-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'assembly-drift-dialog-host';
    document.body.appendChild(host);
  }
  return host;
}

function closeAssemblyDriftDialog() {
  window.ClawFW.driftDialog = null;
  const host = document.getElementById('assembly-drift-dialog-host');
  if (host) host.innerHTML = '';
}

async function confirmAssemblyDriftDialogProceed() {
  const pending = window.ClawFW.driftDialog;
  closeAssemblyDriftDialog();
  if (typeof pending?.onConfirm === 'function') {
    try {
      await pending.onConfirm();
    } catch (error) {
      console.error('Failed to continue after drift warning:', error);
      window.alert((currentLanguage === 'zh' ? '继续打开旧对话失败：' : 'Failed to continue opening the older conversation: ') + (error?.message || error));
    }
  }
}

function renderAssemblyDriftDialog() {
  const pending = window.ClawFW.driftDialog;
  const host = ensureAssemblyDriftDialogHost();
  if (!pending) {
    host.innerHTML = '';
    return;
  }
  const reasons = Array.isArray(pending.reasons) ? pending.reasons : [];
  host.innerHTML = [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + escapeHtml(currentLanguage === 'zh' ? '检测到项目定义已经变化' : 'Project definition changed') + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(currentLanguage === 'zh'
      ? '你正在打开一个较早保存的对话。当前项目的装配或编排图在此之后被修改过，恢复时可能继续沿用旧的运行时状态。'
      : 'You are opening an older saved conversation. The project assembly or flow graph changed after it was saved, so the resumed runtime may carry stale state.') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + escapeHtml(t('panel_close')) + '" onclick="closeAssemblyDriftDialog()">×</button>',
    '</div>',
    reasons.length ? '<div class="fw-switch-modal-list">' + reasons.map((item) => [
      '<div class="fw-switch-modal-card active" style="cursor:default;">',
      '<strong>' + escapeHtml(item.title || '') + '</strong>',
      '<span>' + escapeHtml([item.detail || '', item.updatedAt ? formatWorkspaceDate(item.updatedAt) : ''].filter(Boolean).join(' · ')) + '</span>',
      '</div>',
    ].join('')).join('') + '</div>' : '',
    '<div class="feature-detail-subtitle">' + escapeHtml(currentLanguage === 'zh'
      ? '这不是阻止项，但如果后续行为异常，优先考虑重启运行时或重置流程状态。'
      : 'This is not a blocker, but if behavior looks off, restart the runtime or reset the flow state first.') + '</div>',
    '<div class="workspace-actions" style="justify-content:flex-end;">',
    '<button class="workspace-action secondary" type="button" onclick="closeAssemblyDriftDialog()">' + escapeHtml(currentLanguage === 'zh' ? '先不打开' : 'Not now') + '</button>',
    '<button class="workspace-action" type="button" onclick="confirmAssemblyDriftDialogProceed()">' + escapeHtml(currentLanguage === 'zh' ? '继续打开旧对话' : 'Open anyway') + '</button>',
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}

async function maybeWarnAssemblySessionDrift(agent, sessionId, onConfirm) {
  const pending = await inspectAssemblySessionDrift(agent, sessionId);
  if (!pending) {
    await onConfirm();
    return;
  }
  window.ClawFW.driftDialog = {
    ...pending,
    onConfirm,
  };
  renderAssemblyDriftDialog();
}

/* ── Settings Overlay ────────────────────────────────────────────────────────── */

// settings-overlay extracted to modules/settings-overlay.js
function renderProjectListBlock(agent, block) {
  const st = window.ClawFW;
  const formId = String(block?.assemblySelection?.formId || 'assembly-form');

  if (st.mode === 'detail' && st._projectId) {
    return renderFWDetail(agent, block, formId, st);
  }
  return renderFWList(agent, block, formId);
}

function fwRerender() {
  currentWorkspaceTab = 'workspace';
  // When the prompt editor contentEditable dialog is open, skip full re-render
  // to preserve cursor position and input state.
  if (window.ClawFW.promptEditorOpen && document.querySelector('.fw-prompt-editor.fe-prompt-ce')) {
    return;
  }
  if (typeof renderCurrentMainView === 'function') renderCurrentMainView();
}

function fwEnterDetail(projectId, section) {
  const st = window.ClawFW;
  st.mode = 'detail';
  st._projectId = projectId;
  st.section = section || 'features';
  fwRerender();
}

function fwBackToList() {
  window.ClawFW.mode = 'list';
  window.ClawFW.section = 'features';
  fwRerender();
}

function fwSwitchSection(section) {
  window.ClawFW.section = section;
  const isOrchestrate = section === 'orchestrate';
  const root = document.querySelector('.fw-detail, .fw-detail-orchestrate');
  if (root) {
    root.classList.toggle('fw-detail', !isOrchestrate);
    root.classList.toggle('fw-detail-orchestrate', isOrchestrate);
  }
  const sectionOrder = ['features', 'config', 'orchestrate'];
  const activeIndex = sectionOrder.indexOf(section);
  document.querySelectorAll('.fw-detail-toggle .fw-toggle').forEach((button, index) => {
    button.classList.toggle('active', index === activeIndex);
  });
  ['features', 'config', 'orchestrate'].forEach((key) => {
    const pane = document.querySelector('.fw-pane-' + key);
    if (pane) pane.hidden = key !== section;
  });
  if (isOrchestrate) {
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }
}

function fwOpenPromptEditor() {
  const sp = window.ClawFW.fwSlashPicker;
  sp.open = false; sp.query = ''; sp.activeIndex = 0; sp.category = 'all';
  window.ClawFW.promptEditorOpen = true;
  fwRerender();
}

function fwClosePromptEditor() {
  // commit final text from contentEditable
  const ce = document.querySelector('.fw-prompt-editor.fe-prompt-ce');
  if (ce) {
    const U = window.PromptEditorUtils;
    const rawText = U ? U.htmlToPrompt(ce) : ce.innerText;
    const formId = ce.getAttribute('data-fw-form-id');
    if (formId) {
      window.updateFWPromptDraft(formId, rawText);
      window.commitAssemblyDraftField(formId, 'custom_system_prompt', rawText);
    }
  }
  window.ClawFW.promptEditorOpen = false;
  window.ClawFW.fwSlashPicker.open = false;
  window.ClawFW.fwSlashPicker.query = '';
  fwRerender();
}

// ── FW Prompt Editor: slash picker helpers ───────────────────────

const FW_PICKER_CATEGORIES = ['all', 'template', 'variable'];
const FW_PICKER_CAT_LABELS = {
  all: currentLanguage === 'zh' ? '全部' : 'All',
  template: currentLanguage === 'zh' ? '模板' : 'Templates',
  variable: currentLanguage === 'zh' ? '变量' : 'Variables',
};

function fwCollectPickerItems() {
  const U = window.PromptEditorUtils;
  if (!U) return [];
  const caps = U.getCapabilities();
  const items = [];
  const seen = new Set();
  function addItem(item) {
    const key = [item.type, item.key, item.insertText].join('::');
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  }
  (caps.variables || []).forEach(v => {
    if (!v?.key) return;
    addItem({ type: 'variable', key: String(v.key), title: String(v.title || v.key), description: String(v.description || ''), featureName: String(v.featureName || ''), insertText: '{{' + String(v.key) + '}}' });
  });
  (caps.nodeTemplates || []).forEach(t => {
    if (!t?.id || !t.prompt) return;
    addItem({ type: 'template', key: String(t.id), title: String(t.name || t.id), description: String(t.description || ''), featureName: String(t.featureName || t.packageName || ''), insertText: String(t.prompt) });
  });
  (caps.modes || []).forEach(m => {
    if (!Array.isArray(m.suggestedPromptFragments)) return;
    m.suggestedPromptFragments.forEach(f => {
      if (!f?.id) return;
      addItem({ type: 'fragment', key: String(f.id), title: String(f.title || f.id), description: String(f.description || ''), featureName: String(m.featureName || ''), insertText: String(f.template || '') });
    });
  });
  return items;
}

function fwFilterPickerItems(items, query) {
  if (!query) return items.slice(0, 60);
  const q = query.toLowerCase();
  return items.filter(item => [item.title, item.key, item.description, item.featureName].join(' ').toLowerCase().indexOf(q) >= 0).slice(0, 60);
}

function fwApplyCategoryFilter(items) {
  const cat = window.ClawFW.fwSlashPicker.category || 'all';
  if (cat === 'all') return items;
  if (cat === 'template') return items.filter(it => it.type === 'template' || it.type === 'fragment');
  if (cat === 'variable') return items.filter(it => it.type === 'variable');
  return items;
}

function fwRenderPickerDropdown() {
  const host = document.getElementById('fw-prompt-picker-host');
  if (!host) return;
  const sp = window.ClawFW.fwSlashPicker;
  if (!sp.open) { host.innerHTML = ''; return; }
  const U = window.PromptEditorUtils;
  const query = sp.query || '';
  const allItems = fwFilterPickerItems(fwCollectPickerItems(), query);
  const items = fwApplyCategoryFilter(allItems);
  let listEl = host.querySelector('.fw-picker-list');
  let searchEl = host.querySelector('.fw-picker-search');
  if (!host.querySelector('.fw-prompt-picker')) {
    host.innerHTML = '<div class="fw-prompt-picker">'
      + '<div class="fw-picker-search-wrap"><input class="fw-picker-search" value="' + escapeHtml(query) + '" placeholder="' + escapeHtml(currentLanguage === 'zh' ? '搜索变量或片段…' : 'Search…') + '" oninput="window.fwSetPickerSearch(this.value)" onkeydown="window.fwHandlePromptKeydown(event)"></div>'
      + '<div class="fw-picker-tabs"></div>'
      + '<div class="fw-picker-list"></div>'
      + '</div>';
    listEl = host.querySelector('.fw-picker-list');
    searchEl = host.querySelector('.fw-picker-search');
  }
  if (searchEl && document.activeElement !== searchEl) searchEl.value = query;
  // render tabs
  const tabsEl = host.querySelector('.fw-picker-tabs');
  if (tabsEl) {
    const curCat = sp.category || 'all';
    const tabCounts = { all: allItems.length, template: 0, variable: 0 };
    allItems.forEach(it => { if (it.type === 'variable') tabCounts.variable++; else tabCounts.template++; });
    let tabsHtml = '';
    FW_PICKER_CATEGORIES.forEach(cat => {
      tabsHtml += '<button type="button" class="fw-picker-tab' + (cat === curCat ? ' active' : '') + '" onmousedown="event.preventDefault()" onclick="window.fwSetPickerCategory(\'' + cat + '\')">'
        + FW_PICKER_CAT_LABELS[cat] + ' <span class="fw-picker-tab-count">' + tabCounts[cat] + '</span></button>';
    });
    tabsEl.innerHTML = tabsHtml;
  }
  if (!items.length) {
    if (listEl) listEl.innerHTML = '<div class="fw-picker-empty">' + escapeHtml(currentLanguage === 'zh' ? '没有匹配项' : 'No matches') + '</div>';
    return;
  }
  const grouped = {};
  items.forEach(item => { const g = U.shortFeatureName(item.featureName) || (currentLanguage === 'zh' ? '其他' : 'Other'); if (!grouped[g]) grouped[g] = []; grouped[g].push(item); });
  let html = '';
  let idx = 0;
  Object.keys(grouped).forEach(group => {
    html += '<div class="fw-picker-group-header">' + escapeHtml(group) + '</div>';
    grouped[group].forEach(item => {
      const i = idx++;
      const isVar = item.type === 'variable';
      const isTpl = item.type === 'template';
      const icon = isVar ? '{ }' : (isTpl ? '&#9638;' : '&#9998;');
      const label = isVar ? (currentLanguage === 'zh' ? '变量' : 'Var') : (isTpl ? (currentLanguage === 'zh' ? '模板' : 'Tpl') : (currentLanguage === 'zh' ? '片段' : 'Snip'));
      const titleHtml = U.highlightMatch(item.title, query);
      const descHtml = item.description ? '<div class="fw-picker-item-preview">' + U.highlightMatch(item.description, query) + '</div>' : '';
      html += '<div class="fw-picker-item' + (i === sp.activeIndex ? ' active' : '') + '" data-picker-index="' + i + '" onmousedown="event.preventDefault()" onclick="window.fwClickPickerItem(' + i + ')">'
        + '<div class="fw-picker-item-main">'
        + '<span class="fw-picker-item-icon' + (isVar ? ' var-icon' : ' frag-icon') + '">' + icon + '</span>'
        + '<div class="fw-picker-item-text"><div class="fw-picker-item-title">' + titleHtml + '</div>' + descHtml + '</div>'
        + '</div>'
        + '<span class="fw-picker-item-badge' + (isVar ? ' var-badge' : ' frag-badge') + '">' + escapeHtml(label) + '</span>'
        + '</div>';
    });
  });
  if (listEl) listEl.innerHTML = html;
  // auto-scroll active item
  if (listEl && sp.activeIndex >= 0) {
    const activeEl = listEl.querySelector('.fw-picker-item.active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
  }
}

window.fwHandlePromptInput = (e) => {
  const U = window.PromptEditorUtils;
  if (!U) return;
  const ce = e.target;
  const rawText = U.htmlToPrompt(ce);
  const formId = ce.getAttribute('data-fw-form-id');
  if (formId) window.updateFWPromptDraft(formId, rawText);
  const cursorOffset = U.getPromptCursorOffset(ce);
  const trigger = U.detectSlashTrigger(rawText, cursorOffset >= 0 ? cursorOffset : rawText.length);
  const sp = window.ClawFW.fwSlashPicker;
  sp.formId = formId;
  if (trigger) {
    sp.open = true; sp.query = trigger.query; sp.startIndex = trigger.startIndex; sp.activeIndex = 0;
  } else if (sp.open) {
    sp.open = false; sp.query = '';
  }
  fwRenderPickerDropdown();
};

window.fwHandlePromptKeydown = (e) => {
  const U = window.PromptEditorUtils;
  if (!U) return;
  const sp = window.ClawFW.fwSlashPicker;
  // Backspace: delete variable chip
  if (e.key === 'Backspace' && !sp.open) {
    const ce = document.querySelector('.fw-prompt-editor.fe-prompt-ce');
    if (ce && (document.activeElement === ce || ce.contains(document.activeElement))) {
      const chip = U.findPrevVarChip(ce);
      if (chip) {
        e.preventDefault();
        chip.remove();
        const rawText = U.htmlToPrompt(ce);
        const formId = ce.getAttribute('data-fw-form-id');
        if (formId) window.updateFWPromptDraft(formId, rawText);
        return;
      }
    }
  }
  if (sp.open) {
    const allItems = fwFilterPickerItems(fwCollectPickerItems(), sp.query);
    const items = fwApplyCategoryFilter(allItems);
    if (e.key === 'Escape') {
      e.preventDefault(); sp.open = false; sp.query = ''; fwRenderPickerDropdown(); return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      let curIdx = FW_PICKER_CATEGORIES.indexOf(sp.category || 'all');
      curIdx = e.key === 'ArrowRight' ? (curIdx + 1) % FW_PICKER_CATEGORIES.length : (curIdx - 1 + FW_PICKER_CATEGORIES.length) % FW_PICKER_CATEGORIES.length;
      sp.category = FW_PICKER_CATEGORIES[curIdx]; sp.activeIndex = 0;
      fwRenderPickerDropdown(); return;
    }
    if (items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); sp.activeIndex = (sp.activeIndex + 1) % items.length; fwRenderPickerDropdown(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); sp.activeIndex = (sp.activeIndex - 1 + items.length) % items.length; fwRenderPickerDropdown(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const item = items[sp.activeIndex];
        if (item) fwInsertPickerItem(item);
        
      }
    }
  }
};

function fwInsertPickerItem(item) {
  const U = window.PromptEditorUtils;
  if (!U) return;
  const ce = document.querySelector('.fw-prompt-editor.fe-prompt-ce');
  if (!ce) return;
  const rawText = U.htmlToPrompt(ce);
  const cursorOffset = U.getPromptCursorOffset(ce);
  const offset = cursorOffset >= 0 ? cursorOffset : rawText.length;
  const trigger = U.detectSlashTrigger(rawText, offset);
  if (!trigger) return;
  const before = rawText.substring(0, trigger.startIndex);
  const after = rawText.substring(offset);
  const newText = before + item.insertText + after;
  const formId = ce.getAttribute('data-fw-form-id');
  if (formId) window.updateFWPromptDraft(formId, newText);
  const sp = window.ClawFW.fwSlashPicker;
  sp.open = false; sp.query = '';
  const savedOffset = before.length + item.insertText.length;
  ce.innerHTML = U.promptToHTML(newText);
  U.setPromptCursorOffset(ce, savedOffset);
  fwRenderPickerDropdown();
}

window.fwClickPickerItem = (index) => {
  const sp = window.ClawFW.fwSlashPicker;
  const allItems = fwFilterPickerItems(fwCollectPickerItems(), sp.query);
  const items = fwApplyCategoryFilter(allItems);
  const item = items[index];
  if (item) fwInsertPickerItem(item);
};

window.fwSetPickerCategory = (cat) => {
  window.ClawFW.fwSlashPicker.category = cat;
  window.ClawFW.fwSlashPicker.activeIndex = 0;
  fwRenderPickerDropdown();
};

window.fwSetPickerSearch = (value) => {
  window.ClawFW.fwSlashPicker.query = value || '';
  window.ClawFW.fwSlashPicker.activeIndex = 0;
  fwRenderPickerDropdown();
};

window.updateFWPromptDraft = (formId, value) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  draft[formId] = draft[formId] || {};
  draft[formId].custom_system_prompt = value;
  saveWorkspaceFormDraft(agent.id, draft);
};

function rememberFWFeatureScroll() {
  const list = document.querySelector('.fw-feat-list');
  window.ClawFW.featureScrollTop = list ? list.scrollTop : 0;
}

function restoreFWFeatureScroll() {
  const top = Number(window.ClawFW.featureScrollTop || 0);
  requestAnimationFrame(() => {
    const list = document.querySelector('.fw-feat-list');
    if (list) list.scrollTop = top;
  });
}

async function fwToggleFeature(formId, token) {
  rememberFWFeatureScroll();
  await window.toggleWorkspaceSelection(formId, 'selected_features', token);
  restoreFWFeatureScroll();
}

function fwSetFeatureFilter(formId, value) {
  window.commitAssemblyDraftField(formId, 'feature_source_filter', value);
}

function fwSetFeatureQuery(formId, value) {
  window.ClawFW.featureQuery = String(value || '');
  fwFilterFeatureList();
}

function fwCommitFeatureQuery(formId, value) {
  const query = String(value || '');
  window.ClawFW.featureQuery = query;
  updateAssemblyDraftWithoutRender(formId, 'feature_query', query);
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  persistWorkspaceState(agent, draft).catch((error) => {
    console.error('Failed to persist feature search query:', error);
  });
}

function fwFilterFeatureList() {
  const query = String(window.ClawFW.featureQuery || '').trim().toLowerCase();
  const list = document.querySelector('.fw-feat-list');
  const head = document.querySelector('[data-fw-feature-count]');
  if (!list) return;
  let visible = 0;
  list.querySelectorAll('.fw-feat').forEach((card) => {
    const haystack = String(card.getAttribute('data-fw-feature-search') || '').toLowerCase();
    const matched = !query || haystack.includes(query);
    card.hidden = !matched;
    if (matched) visible += 1;
  });
  const empty = list.querySelector('[data-fw-feature-empty]');
  if (empty) empty.hidden = visible !== 0;
  if (head) {
    const total = Number(head.getAttribute('data-total') || 0);
    const mounted = Number(head.getAttribute('data-mounted') || 0);
    head.textContent = (currentLanguage === 'zh' ? '当前显示 ' : 'Showing ')
      + visible + ' / ' + total
      + (currentLanguage === 'zh' ? `，已挂载 ${mounted}` : `, mounted ${mounted}`);
  }
}

async function fwOpenFeatureImport(formId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.tgz';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch('/protoclaw/feature_repository/parse_upload', { method: 'POST', body: formData });
      if (!response.ok) throw new Error(await response.text().catch(() => 'parse upload failed'));
      const parsed = await response.json();
      window.ClawFW.featureImport = { ...parsed, formId };
      fwRerender();
    } catch (error) {
      window.alert((currentLanguage === 'zh' ? '解析 tgz 失败：' : 'Failed to parse tgz: ') + (error?.message || error));
    }
  };
  input.click();
}

async function fwCancelFeatureImport() {
  const uploadId = window.ClawFW.featureImport?.uploadId;
  window.ClawFW.featureImport = null;
  if (uploadId) {
    await fetch('/protoclaw/feature_repository/cancel_import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
    }).catch(() => {});
  }
  fwRerender();
}

async function fwConfirmFeatureImport(mode) {
  const pending = window.ClawFW.featureImport;
  if (!pending?.uploadId) return;
  try {
    const response = await fetch('/protoclaw/feature_repository/confirm_import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId: pending.uploadId }),
    });
    if (!response.ok) throw new Error(await response.text().catch(() => 'import failed'));
    const result = await response.json();
    const token = result?.summary?.packageName || result?.summary?.id || pending?.summary?.packageName || pending?.summary?.id || '';
    window.ClawFW.featureImport = null;
    await loadAgents().catch(() => {});
    if (mode === 'mount' && token) {
      await fwToggleFeature(pending.formId || 'assembly-form', token);
    } else {
      fwRerender();
    }
  } catch (error) {
    window.alert((currentLanguage === 'zh' ? '导入失败：' : 'Import failed: ') + (error?.message || error));
  }
}

function fwOpenProjectPicker() {
  window.ClawFW.projectPickerOpen = true;
  fwRerender();
}

function fwCloseProjectPicker() {
  window.ClawFW.projectPickerOpen = false;
  fwRerender();
}

function fwSelectProject(projectId) {
  window.ClawFW.projectPickerOpen = false;
  window.loadSavedAssemblyConfig(projectId).then(function() { fwEnterDetail(projectId, window.ClawFW.section || 'features'); });
}

window.fwCreateNewAgent = function() {
  fwOpenCreateDialog();
};

window.fwOpenProjectDetail = async function(projectId) {
  await window.loadSavedAssemblyConfig(projectId);
  fwEnterDetail(projectId, 'features');
};

function renderFWSwitchProjectDialog(agent, currentName) {
  if (!window.ClawFW.projectPickerOpen) return '';
  const configs = getSavedAssemblyConfigs(agent);
  const cards = configs.length
    ? configs.map(item => {
      const active = item.id === currentName;
      return [
        '<button class="fw-switch-modal-card' + (active ? ' active' : '') + '" type="button" onclick="fwSelectProject(\'' + escapeHtml(item.id) + '\')">',
        '<strong>' + escapeHtml(item.name || item.id) + '</strong>',
        '<span>' + escapeHtml([item.features.length + (currentLanguage === 'zh' ? ' 个 Feature' : ' Features'), item.goal || getAssemblyPresetLabel(item.preset) || ''].filter(Boolean).join(' · ')) + '</span>',
        '</button>',
      ].join('');
    }).join('')
    : '<div class="feature-detail-subtitle">' + escapeHtml(currentLanguage === 'zh' ? '还没有可切换的项目。' : 'No saved projects yet.') + '</div>';
  return [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + escapeHtml(currentLanguage === 'zh' ? '切换 Agent 项目' : 'Switch Agent Project') + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(currentLanguage === 'zh' ? '选择一个项目继续配置能力或编辑编排图。' : 'Choose a project to configure capabilities or edit its graph.') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + escapeHtml(t('panel_close')) + '" onclick="fwCloseProjectPicker()">×</button>',
    '</div>',
    '<div class="fw-switch-modal-list">' + cards + '</div>',
    '</div>',
    '</div>',
  ].join('');
}

function fwOpenCreateDialog() {
  window.ClawFW.createDialogOpen = true;
  fwRerender();
  requestAnimationFrame(() => {
    const input = document.getElementById('fw-create-folder-name');
    if (input) input.focus();
  });
}

function fwCloseCreateDialog() {
  window.ClawFW.createDialogOpen = false;
  fwRerender();
}

window.fwConfirmCreateAgent = async function() {
  const folderInput = document.getElementById('fw-create-folder-name');
  const displayInput = document.getElementById('fw-create-display-name');
  const folderName = String(folderInput?.value || '').trim();
  const displayName = String(displayInput?.value || '').trim();
  if (!isValidAgentCreatorName(folderName)) {
    window.alert(currentLanguage === 'zh' ? '项目标识必须以小写字母开头，只允许小写字母、数字和连字符。' : 'Project ID must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens.');
    return;
  }
  const agent = getCurrentAgentRecord();
  if (agent) {
    const configs = getSavedAssemblyConfigs(agent);
    if (configs.some(c => c.id === folderName)) {
      window.alert(currentLanguage === 'zh' ? `项目 "${folderName}" 已存在，请使用其他标识。` : `Project "${folderName}" already exists. Choose a different ID.`);
      return;
    }
  }
  window.ClawFW.createDialogOpen = false;
  await window.resetAssemblyDraft();
  const draft = getWorkspaceFormDraft(getCurrentAgentRecord());
  draft['assembly-form'] = normalizeAssemblyDraft({
    ...(draft['assembly-form'] || {}),
    assembly_name: folderName,
    display_name: displayName,
    editing_config_id: folderName,
  });
  saveWorkspaceFormDraft(getCurrentAgentRecord().id, draft);
  try {
    await persistWorkspaceState(getCurrentAgentRecord(), draft);
  } catch (error) {
    console.error('Failed to save new project:', error);
  }
  fwEnterDetail(folderName, 'features');
};

function renderFWCreateDialog() {
  if (!window.ClawFW.createDialogOpen) return '';
  return [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window" style="width:min(100%,480px);">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + escapeHtml(currentLanguage === 'zh' ? '创建新 Agent 项目' : 'Create New Agent Project') + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(currentLanguage === 'zh' ? '设置项目标识和显示名称后进入配置界面。标识创建后不可修改。' : 'Set the project ID and display name before entering the editor. The ID cannot be changed after creation.') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + escapeHtml(t('panel_close')) + '" onclick="fwCloseCreateDialog()">×</button>',
    '</div>',
    '<div class="fw-create-fields">',
    '<div class="fw-field">',
    '<label>' + escapeHtml(currentLanguage === 'zh' ? '项目标识' : 'Project ID') + '</label>',
    '<input id="fw-create-folder-name" class="fw-input" placeholder="my-agent" pattern="[a-z][a-z0-9-]*" onkeydown="if(event.key===\'Enter\')window.fwConfirmCreateAgent()">',
    '<span class="fw-name-lock-hint">' + escapeHtml(currentLanguage === 'zh' ? '用于文件夹名和环境绑定，创建后不可修改' : 'Used for directory and environment binding. Cannot be changed.') + '</span>',
    '</div>',
    '<div class="fw-field">',
    '<label>' + escapeHtml(currentLanguage === 'zh' ? '显示名称' : 'Display Name') + '</label>',
    '<input id="fw-create-display-name" class="fw-input" placeholder="My Agent" onkeydown="if(event.key===\'Enter\')window.fwConfirmCreateAgent()">',
    '<span class="fw-name-lock-hint">' + escapeHtml(currentLanguage === 'zh' ? '在对话和界面中展示，可随时修改' : 'Shown in conversations and UI. Can be changed anytime.') + '</span>',
    '</div>',
    '</div>',
    '<div class="workspace-actions" style="margin-top:16px;justify-content:flex-end;">',
    '<button class="workspace-action secondary" type="button" onclick="fwCloseCreateDialog()">' + escapeHtml(currentLanguage === 'zh' ? '取消' : 'Cancel') + '</button>',
    '<button class="workspace-action" type="button" onclick="window.fwConfirmCreateAgent()">' + escapeHtml(currentLanguage === 'zh' ? '创建并继续' : 'Create & Continue') + '</button>',
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}

function fwOpenConfirmDialog(opts) {
  window.ClawFW.confirmDialog = {
    title: opts.title || '',
    message: opts.message || '',
    confirmLabel: opts.confirmLabel || (currentLanguage === 'zh' ? '确认' : 'Confirm'),
    cancelLabel: opts.cancelLabel || (currentLanguage === 'zh' ? '取消' : 'Cancel'),
    danger: !!opts.danger,
    onConfirm: opts.onConfirm || null,
  };
  fwRerender();
}

function fwCloseConfirmDialog() {
  window.ClawFW.confirmDialog = null;
  fwRerender();
}

function fwHandleConfirm() {
  const dialog = window.ClawFW.confirmDialog;
  const callback = dialog?.onConfirm || null;
  window.ClawFW.confirmDialog = null;
  fwRerender();
  if (typeof callback === 'function') callback();
}

function renderFWConfirmDialog() {
  const dialog = window.ClawFW.confirmDialog;
  if (!dialog) return '';
  return [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window" style="width:min(100%,420px);">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + escapeHtml(dialog.title) + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(dialog.message) + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + escapeHtml(t('panel_close')) + '" onclick="fwCloseConfirmDialog()">×</button>',
    '</div>',
    '<div class="workspace-actions" style="margin-top:16px;justify-content:flex-end;">',
    '<button class="workspace-action secondary" type="button" onclick="fwCloseConfirmDialog()">' + escapeHtml(dialog.cancelLabel) + '</button>',
    '<button class="' + (dialog.danger ? 'workspace-action danger' : 'workspace-action') + '" type="button" onclick="fwHandleConfirm()">' + escapeHtml(dialog.confirmLabel) + '</button>',
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}

function renderFWPromptDialog(agent, formId, draft) {
  if (!window.ClawFW.promptEditorOpen) return '';
  const U = window.PromptEditorUtils;
  if (!U) return '';
  const caps = U.getCapabilities();
  const vars = Array.isArray(caps.variables) ? caps.variables : [];
  const templates = Array.isArray(caps.nodeTemplates) ? caps.nodeTemplates : [];
  const modes = Array.isArray(caps.modes) ? caps.modes : [];
  const fragCount = modes.reduce((s, m) => s + (Array.isArray(m.suggestedPromptFragments) ? m.suggestedPromptFragments.length : 0), 0);
  const varCount = vars.length;
  const tplCount = templates.length + fragCount;
  const rawText = String(draft.custom_system_prompt || '');
  const htmlContent = U.promptToHTML(rawText);
  return [
    '<div class="feature-detail-overlay" onkeydown="event.stopPropagation()">',
    '<div class="feature-detail-window" style="width:min(100%,780px);max-height:min(100%,780px);">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + escapeHtml(currentLanguage === 'zh' ? '编辑系统提示词' : 'Edit System Prompt') + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(currentLanguage === 'zh' ? '输入 / 插入变量或模板片段。变量以块显示，模板与片段插入后展开为纯文本。' : 'Type / to insert variables or template fragments. Variables appear as blocks, templates expand to plain text.') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + escapeHtml(t('panel_close')) + '" onclick="fwClosePromptEditor()">×</button>',
    '</div>',
    '<div class="fw-prompt-editor-wrap">',
    '<div class="fw-prompt-editor fe-prompt-ce" contenteditable="true" autofocus data-fw-form-id="' + escapeHtml(formId) + '" oninput="window.fwHandlePromptInput(event)" onkeydown="window.fwHandlePromptKeydown(event)">' + htmlContent + '</div>',
    '<div id="fw-prompt-picker-host"></div>',
    '</div>',
    '<div class="fe-prompt-footer">',
    '<div class="fe-prompt-footer-hint">',
    '<span>' + escapeHtml(currentLanguage === 'zh' ? '输入 / 可插入 ' : 'Type / to insert ') + '</span><span class="fe-prompt-footer-count">' + varCount + '</span><span>' + escapeHtml(currentLanguage === 'zh' ? ' 个变量' : ' variables') + '</span>',
    '<span class="fe-prompt-footer-sep">·</span>',
    '<span class="fe-prompt-footer-count">' + tplCount + '</span><span>' + escapeHtml(currentLanguage === 'zh' ? ' 个模板/片段' : ' templates/fragments') + '</span>',
    '</div>',
    '<button class="fe-prompt-footer-done" type="button" onclick="fwClosePromptEditor()">' + escapeHtml(currentLanguage === 'zh' ? '完成编辑' : 'Done') + '</button>',
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}

function renderFWFeatureImportDialog() {
  const pending = window.ClawFW.featureImport;
  if (!pending) return '';
  const summary = pending.summary || {};
  const warnings = Array.isArray(summary.warnings) ? summary.warnings : [];
  const featureTypes = Array.isArray(summary.featureTypes) ? summary.featureTypes : [];
  return [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + escapeHtml(currentLanguage === 'zh' ? '解析 Feature 包' : 'Parsed Feature Package') + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(currentLanguage === 'zh' ? '确认解析结果后再决定是否导入。' : 'Review the parsed metadata before importing.') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + escapeHtml(t('panel_close')) + '" onclick="fwCancelFeatureImport()">×</button>',
    '</div>',
    '<div class="fw-import-result">',
    '<div class="fw-import-card">',
    '<div class="fw-import-title">' + escapeHtml(summary.name || summary.id || summary.fileName || '-') + '</div>',
    '<div class="fw-import-meta">' + escapeHtml([summary.packageName, summary.latestVersion || summary.version, summary.fileName, formatRepoFileSize(summary.size)].filter(Boolean).join(' · ')) + '</div>',
    summary.description ? '<div class="fw-import-meta">' + escapeHtml(summary.description) + '</div>' : '',
    featureTypes.length ? '<div class="workspace-tag-list">' + featureTypes.map(type => '<span class="workspace-tag">' + escapeHtml(getFeatureTypeLabel(type)) + '</span>').join('') + '</div>' : '',
    '</div>',
    warnings.length ? '<div class="fw-import-warning">' + warnings.map(item => escapeHtml(item)).join('<br>') + '</div>' : '',
    '<div class="workspace-actions" style="justify-content:flex-end;">',
    '<button class="workspace-action secondary" type="button" onclick="fwCancelFeatureImport()">' + escapeHtml(currentLanguage === 'zh' ? '取消' : 'Cancel') + '</button>',
    '<button class="workspace-action" type="button" onclick="fwConfirmFeatureImport(\'mount\')">' + escapeHtml(currentLanguage === 'zh' ? '导入' : 'Import') + '</button>',
    '<button class="workspace-action secondary" type="button" onclick="fwConfirmFeatureImport(\'repo\')">' + escapeHtml(currentLanguage === 'zh' ? '导入并添加到仓库' : 'Import to Repository') + '</button>',
    '</div>',
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}
