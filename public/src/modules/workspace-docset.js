/**
 * workspace-docset.js — 域 Q: Workspace Docset & Artifacts
 *
 * 从 app-ui.js 拆出（Phase 2c-1）。
 * 提供 workspace artifacts 渲染、project docset 渲染与 chrome 更新。
 *
 * 依赖（全局作用域，运行时解析）:
 * - app-core.js: currentLanguage, getCurrentAgentRecord, getCurrentUnitUi, localizeWorkspaceValue, formatWorkspaceDate
 * - app-core.js: currentWorkspaceArtifactDetail, currentWorkspaceDocsetDetail, currentProjectDocsetPage, currentProjectDocsetOpen, currentProjectRequirementEdit
 * - app-core.js: projectDocsetToggle, projectDocsetOverlay, projectDocsetSheet (DOM refs)
 * - app-ui.js (域 O): escapeHtml, renderMarkdown
 * - app-ui.js (域 G): renderWorkspaceField
 * - app-ui.js (域 E): getWorkspaceFormDraft, saveWorkspaceFormDraft, normalizeWorkspaceStartupDraft
 * - app-ui.js (域 B): ensureUnitMode
 * - project-data.js (域 F): getAgentWorkspaceState
 */

// ── Artifacts block ──

function getWorkspaceArtifactData(agent, block) {
  const blockId = String(block?.id || '').trim();
  if (!blockId) return null;
  const workspaceData = agent?.workspace_data;
  if (!workspaceData || typeof workspaceData !== 'object') return null;
  return workspaceData[blockId] || null;
}

function getArtifactKindLabel(value) {
  const map = {
    draft: 'draft',
    plan: 'plan',
    handoff: 'handoff',
    progress: 'progress',
    decision: 'decision',
    verification: 'verification',
    'debug-report': 'debug-report',
  };
  return map[value] || value || 'artifact';
}

function buildArtifactPreview(item) {
  const payload = item?.payload && typeof item.payload === 'object' ? item.payload : {};
  const candidates = [
    payload.goal,
    payload.constraints,
    payload.planned_features,
    payload.feature_name,
    payload.agent_name,
    payload.target_user,
    payload.runtime_style,
  ];
  const matched = candidates.find((value) => typeof value === 'string' && value.trim());
  return matched ? String(matched).trim() : '';
}

function getSelectedArtifactId(agent, block) {
  if (!currentWorkspaceArtifactDetail) return '';
  if (currentWorkspaceArtifactDetail.agentId !== agent?.id) return '';
  if (currentWorkspaceArtifactDetail.blockId !== String(block?.id || '')) return '';
  return currentWorkspaceArtifactDetail.artifactId || '';
}

function renderArtifactPayloadDetails(item) {
  const payload = item?.payload && typeof item.payload === 'object' ? item.payload : {};
  const entries = Object.entries(payload)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '');

  if (entries.length === 0) {
    return '<div class="workspace-history-meta">No payload details.</div>';
  }

  return '<div class="workspace-history-list">' + entries.map(([key, value]) => {
    return [
      '<div class="workspace-history-item">',
      '<div class="workspace-history-main">',
      '<div class="workspace-history-title">' + escapeHtml(String(key)) + '</div>',
      '<div class="workspace-history-preview">' + escapeHtml(String(value)) + '</div>',
      '</div>',
      '</div>',
    ].join('');
  }).join('') + '</div>';
}

function getWorkspaceLabelFromId(value) {
  if (value === 'feature-creator') return 'Feature Creator';
  if (value === 'agent-creator') return 'Agent Creator';
  return value || 'Workspace';
}

function renderWorkspaceArtifactsBlock(agent, block) {
  const data = getWorkspaceArtifactData(agent, block);
  const title = localizeWorkspaceValue(block.title, 'Artifacts');
  const desc = localizeWorkspaceValue(block.description, '');
  const items = Array.isArray(data?.items) ? data.items : [];
  const emptyText = localizeWorkspaceValue(block.emptyText, 'No artifacts yet.');
  const currentOpenDirectory = String(getAgentWorkspaceState(agent)?.openDirectory || '').trim();
  const scopedDesc = currentOpenDirectory
    ? ((desc ? desc + ' ' : '') + currentOpenDirectory)
    : desc;
  const selectedArtifactId = getSelectedArtifactId(agent, block);
  const selectedItem = items.find((item) => String(item?.id || '') === selectedArtifactId) || null;

  const bodyHtml = items.length > 0
    ? '<div class="workspace-docset-panel"><div class="workspace-docset-panel-body"><div class="workspace-docset-ledger">' + items.map((item) => {
        const preview = buildArtifactPreview(item);
        const kind = getArtifactKindLabel(item.kind);
        const relatedDir = String(item?.relatedTo?.openDirectory || '').trim();
        const sourceWorkspace = String(item?.source?.workspace || data?.workspaceId || '').trim();
        const openAction = escapeHtml(JSON.stringify({
          type: 'open_artifact_preview',
          blockId: String(block?.id || ''),
          artifactId: item.id,
        }));
        return [
          '<div class="workspace-docset-row">',
          '<div>',
          '<div class="workspace-docset-row-title">' + escapeHtml(item.title || item.id || kind) + '</div>',
          preview ? '<div class="workspace-docset-row-preview">' + escapeHtml(preview) + '</div>' : '',
          '<div class="workspace-docset-row-meta"><span>' + escapeHtml(kind) + '</span><span>' + escapeHtml(formatWorkspaceDate(item.updatedAt)) + '</span>' + (relatedDir ? '<span>' + escapeHtml(relatedDir) + '</span>' : '') + (sourceWorkspace ? '<span>' + escapeHtml(getWorkspaceLabelFromId(sourceWorkspace)) + '</span>' : '') + '</div>',
          '</div>',
          '<div class="workspace-actions"><button class="workspace-action secondary" type="button" data-workspace-action="' + openAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">查看</button></div>',
          '</div>',
        ].join('');
      }).join('') + '</div></div></div>'
    : '<div class="workspace-docset-panel"><div class="workspace-docset-panel-body"><div class="workspace-docset-row"><div class="workspace-docset-row-preview">' + escapeHtml(emptyText) + '</div></div></div></div>';

  const detailHtml = selectedItem
    ? [
        '<div class="workspace-docset-detail">',
        '<div class="workspace-docset-panel">',
        '<div class="workspace-docset-panel-head"><div class="workspace-docset-panel-title">' + escapeHtml(selectedItem.title || selectedItem.id || 'artifact') + '</div><div class="workspace-actions">',
        selectedItem?.source?.workspace
          ? '<button class="workspace-action" type="button" data-workspace-action="' + escapeHtml(JSON.stringify({ type: 'navigate_unit', targetAgentId: String(selectedItem.source.workspace) })) + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">进入来源工作空间</button>'
          : '',
        '<button class="workspace-action secondary" type="button" data-workspace-action="' + escapeHtml(JSON.stringify({ type: 'close_artifact_preview', blockId: String(block?.id || '') })) + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">关闭预览</button>',
        '</div></div>',
        '<div class="workspace-docset-panel-body">',
        '<div class="workspace-docset-chip-row"><span class="workspace-docset-chip">' + escapeHtml(getArtifactKindLabel(selectedItem.kind)) + '</span><span class="workspace-docset-chip">' + escapeHtml(formatWorkspaceDate(selectedItem.updatedAt)) + '</span>' + (selectedItem?.relatedTo?.openDirectory ? '<span class="workspace-docset-chip">' + escapeHtml(String(selectedItem.relatedTo.openDirectory)) + '</span>' : '') + '</div>',
        renderArtifactPayloadDetails(selectedItem),
        '</div>',
        '</div>',
      ].join('')
    : '';

  return [
    '<section class="workspace-section">',
    '<div class="workspace-section-header">',
    '<div>',
    '<div class="workspace-section-title">' + escapeHtml(title) + '</div>',
    '<div class="workspace-section-desc">' + escapeHtml(scopedDesc || (data?.artifactCount != null ? `${data.artifactCount} artifacts` : '')) + '</div>',
    '</div>',
    '</div>',
    bodyHtml,
    detailHtml,
    '</section>',
  ].join('');
}

// ── Project docset block ──

function getProjectDocsetData(agent, block) {
  const blockId = String(block?.id || '').trim();
  if (!blockId) return null;
  const workspaceData = agent?.workspace_data;
  if (!workspaceData || typeof workspaceData !== 'object') return null;
  return workspaceData[blockId] || null;
}

function getCurrentProjectDocset(agent = getCurrentAgentRecord()) {
  const workspaceData = agent?.workspace_data;
  if (!workspaceData || typeof workspaceData !== 'object') return null;
  const data = workspaceData['project-docset'];
  return data && typeof data === 'object' ? data : null;
}

function getSelectedProjectDocsetDetail(agent, block) {
  if (!currentWorkspaceDocsetDetail) return null;
  if (currentWorkspaceDocsetDetail.agentId !== agent?.id) return null;
  if (currentWorkspaceDocsetDetail.blockId !== String(block?.id || '')) return null;
  return currentWorkspaceDocsetDetail;
}

function getWorkspaceUiBlock(agent, blockId) {
  const ui = getCurrentUnitUi(agent);
  const blocks = Array.isArray(ui?.home?.blocks) ? ui.home.blocks : [];
  return blocks.find((item) => String(item?.id || '') === String(blockId || '')) || null;
}

function isProjectRequirementEditing(agent) {
  return !!(currentProjectRequirementEdit && currentProjectRequirementEdit.agentId === (agent?.id || ''));
}

function getProjectRequirementDraft(agent) {
  const forms = getWorkspaceFormDraft(agent);
  const startupForm = forms?.['startup-form'];
  return startupForm && typeof startupForm === 'object' ? startupForm : {};
}

function resetProjectRequirementDraft(agent) {
  if (!agent?.id) return;
  const forms = getWorkspaceFormDraft(agent);
  const serverForm = getAgentWorkspaceState(agent)?.forms?.['startup-form'] || {};
  forms['startup-form'] = normalizeWorkspaceStartupDraft(agent, { ...serverForm });
  saveWorkspaceFormDraft(agent.id, forms);
}

function renderProjectDocsetFields(fields) {
  const entries = Object.entries(fields || {}).filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '');
  if (entries.length === 0) {
    return '<div class="workspace-docset-row-preview">当前没有可展示的字段。</div>';
  }
  return '<div class="workspace-docset-fields">' + entries.map(([key, value]) => (
    '<div class="workspace-docset-field"><div class="workspace-docset-field-label">' + escapeHtml(String(key)) + '</div><div class="workspace-docset-field-value">' + escapeHtml(String(value)) + '</div></div>'
  )).join('') + '</div>';
}

function renderProjectRequirementCards(agent, requirementBlock, draft) {
  const fields = Array.isArray(requirementBlock?.fields) ? requirementBlock.fields : [];
  const rows = fields.map((field) => {
    const key = String(field?.name || '').trim();
    if (!key) return '';
    const label = localizeWorkspaceValue(field.label, key);
    const value = draft[key];
    if (value === undefined || value === null || String(value).trim() === '') return '';
    return [
      '<div class="project-docset-requirement-row">',
      '<div class="project-docset-requirement-key">' + escapeHtml(label) + '</div>',
      '<div class="project-docset-requirement-text">' + escapeHtml(String(value)) + '</div>',
      '</div>',
    ].join('');
  }).filter(Boolean).join('');

  return rows
    ? '<div class="project-docset-requirement-stack">' + rows + '</div>'
    : '<div class="project-docset-detail-empty">当前项目还没有需求内容。先把目标、目录和约束补进去。</div>';
}

function renderProjectDocsetList(title, count, itemsHtml) {
  return [
    '<section class="project-docset-group">',
    '<div class="project-docset-group-head">',
    '<div class="project-docset-group-title">' + escapeHtml(title) + '</div>',
    '<div class="project-docset-group-count">' + escapeHtml(String(count)) + '</div>',
    '</div>',
    '<div class="project-docset-list">' + itemsHtml + '</div>',
    '</section>',
  ].join('');
}

function renderProjectDocsetSidebarItem(title, preview, meta, section, itemId, blockId, options = {}) {
  const active = !!options.active;
  const tag = options.tag ? '<span class="project-docset-item-tag">' + escapeHtml(options.tag) + '</span>' : '';
  const action = escapeHtml(JSON.stringify({
    type: 'open_project_docset_preview',
    blockId: String(blockId || ''),
    section,
    itemId,
  }));
  return [
    '<button class="project-docset-item' + (active ? ' active' : '') + '" type="button" data-workspace-action="' + action + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">',
    '<div class="project-docset-item-top">',
    '<div class="project-docset-item-title">' + escapeHtml(title) + '</div>',
    tag,
    '</div>',
    preview ? '<div class="project-docset-item-preview">' + escapeHtml(preview) + '</div>' : '',
    meta ? '<div class="project-docset-item-meta">' + meta.map((item) => '<span>' + escapeHtml(String(item)) + '</span>').join('') + '</div>' : '',
    '</button>',
  ].join('');
}

function renderProjectDocsetDetailList(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return '<div class="project-docset-detail-empty">这里暂时没有内容。</div>';
  }
  return '<div class="project-docset-detail-list">' + items.map((item) => (
    '<div class="project-docset-detail-list-item">' + escapeHtml(String(item)) + '</div>'
  )).join('') + '</div>';
}

function resolveProjectDocsetDetail(agent, block, data) {
  const selected = getSelectedProjectDocsetDetail(agent, block);
  const currentConversationRecord = data?.currentConversationRecord && typeof data.currentConversationRecord === 'object' ? data.currentConversationRecord : null;
  const conversationRecords = Array.isArray(data?.conversationRecords) ? data.conversationRecords : [];
  const materials = Array.isArray(data?.materials) ? data.materials : [];

  if (selected?.section === 'conversation') {
    const record = conversationRecords.find((item) => String(item.sessionId || '') === selected.itemId) || currentConversationRecord;
    if (record) return { type: 'conversation', value: record };
  }
  if (selected?.section === 'material') {
    const material = materials.find((item) => String(item.id || '') === selected.itemId);
    if (material) return { type: 'material', value: material };
  }

  if (currentConversationRecord) return { type: 'conversation', value: currentConversationRecord };
  if (materials[0]) return { type: 'material', value: materials[0] };
  return null;
}

function renderProjectDocsetDetailPane(detail) {
  if (!detail) {
    return '<div class="project-docset-detail-empty">从左侧选择一条推进记录或资料，就会在这里展开。</div>';
  }

  if (detail.type === 'conversation') {
    const record = detail.value || {};
    const blocks = [];
    if (record.summary) {
      blocks.push('<section class="project-docset-detail-block"><div class="project-docset-detail-block-title">阶段总结</div><div class="project-docset-requirement-value">' + escapeHtml(String(record.summary)) + '</div></section>');
    }
    if (record.currentFocus) {
      blocks.push('<section class="project-docset-detail-block"><div class="project-docset-detail-block-title">当前焦点</div><div class="project-docset-requirement-value">' + escapeHtml(String(record.currentFocus)) + '</div></section>');
    }
    if (Array.isArray(record.keyDecisions) && record.keyDecisions.length > 0) {
      blocks.push('<section class="project-docset-detail-block"><div class="project-docset-detail-block-title">关键决策</div>' + renderProjectDocsetDetailList(record.keyDecisions) + '</section>');
    }
    if (Array.isArray(record.nextActions) && record.nextActions.length > 0) {
      blocks.push('<section class="project-docset-detail-block"><div class="project-docset-detail-block-title">下一步</div>' + renderProjectDocsetDetailList(record.nextActions) + '</section>');
    }
    if (Array.isArray(record.openQuestions) && record.openQuestions.length > 0) {
      blocks.push('<section class="project-docset-detail-block"><div class="project-docset-detail-block-title">待确认问题</div>' + renderProjectDocsetDetailList(record.openQuestions) + '</section>');
    }
    if ((record.relatedMaterialIds || []).length > 0) {
      blocks.push('<section class="project-docset-detail-block"><div class="project-docset-detail-block-title">关联资料</div>' + renderProjectDocsetFields({
        relatedMaterialIds: Array.isArray(record.relatedMaterialIds) ? record.relatedMaterialIds.join(', ') : '',
      }) + '</section>');
    }

    return [
      '<div class="project-docset-detail-card">',
      '<div class="project-docset-detail-head">',
      '<div>',
      '<div class="project-docset-detail-kicker">推进记录</div>',
      '<div class="project-docset-detail-title">' + escapeHtml(record.title || record.sessionId || 'Conversation') + '</div>',
      '<div class="project-docset-detail-subtitle">' + escapeHtml([record.sessionId || '', formatWorkspaceDate(record.updatedAt)].filter(Boolean).join(' · ')) + '</div>',
      '</div>',
      '</div>',
      blocks.join('') || '<div class="project-docset-detail-empty">这条推进记录还比较空，可以继续补阶段总结、关键决策和下一步。</div>',
      '</div>',
    ].join('');
  }

  if (detail.type === 'material') {
    const material = detail.value || {};
    return [
      '<div class="project-docset-detail-card">',
      '<div class="project-docset-detail-head">',
      '<div>',
      '<div class="project-docset-detail-kicker">资料</div>',
      '<div class="project-docset-detail-title">' + escapeHtml(material.title || material.id || 'Material') + '</div>',
      '<div class="project-docset-detail-subtitle">' + escapeHtml(formatWorkspaceDate(material.updatedAt)) + '</div>',
      '</div>',
      '</div>',
      ((material.sourcePath || material.path)
        ? '<section class="project-docset-detail-block"><div class="project-docset-detail-block-title">来源路径</div>' + renderProjectDocsetFields({
          sourcePath: material.sourcePath || '',
          materialPath: material.path || '',
        }) + '</section>'
        : ''),
      '<section class="project-docset-detail-block"><div class="project-docset-detail-block-title">文档正文</div><div class="feature-panel-section overview-doc"><div class="markdown-body">' + renderMarkdown(material.content || '') + '</div></div></section>',
      '</div>',
    ].join('');
  }

  return '<div class="project-docset-detail-empty">当前没有可展开的内容。</div>';
}

function getProjectDocsetPage() {
  return ['requirement', 'log', 'materials'].includes(currentProjectDocsetPage)
    ? currentProjectDocsetPage
    : 'requirement';
}

function renderProjectDocsetContent(agent, block, data) {
  const requirementForm = data?.requirementForm?.payload && typeof data.requirementForm.payload === 'object' ? data.requirementForm.payload : {};
  const currentConversationRecord = data?.currentConversationRecord && typeof data.currentConversationRecord === 'object' ? data.currentConversationRecord : null;
  const conversationRecords = Array.isArray(data?.conversationRecords) ? data.conversationRecords : [];
  const materials = Array.isArray(data?.materials) ? data.materials : [];
  const selected = getSelectedProjectDocsetDetail(agent, block);
  const requirementBlock = getWorkspaceUiBlock(agent, 'startup-form');
  const requirementDraft = getProjectRequirementDraft(agent);
  const editingRequirement = isProjectRequirementEditing(agent);
  const effectiveRequirement = editingRequirement ? requirementDraft : { ...requirementForm, ...requirementDraft };
  const currentSessionId = String(data?.currentSessionId || 'workspace');
  const page = getProjectDocsetPage();
  const combinedConversations = [
    ...(currentConversationRecord ? [{ ...currentConversationRecord, __current: true }] : []),
    ...conversationRecords.filter((item) => String(item?.sessionId || '') !== String(currentConversationRecord?.sessionId || '')),
  ];
  const activeSection = selected?.section || '';
  const activeItemId = selected?.itemId || '';
  const hasExplicitSelection = Boolean(activeSection && activeItemId);
  const detail = resolveProjectDocsetDetail(agent, block, data);

  const conversationItemsHtml = combinedConversations.length > 0
    ? combinedConversations.map((item) => renderProjectDocsetSidebarItem(
        item.title || item.sessionId || 'Conversation',
        item.summary || item.currentFocus || '这条推进记录还没有明确摘要。',
        [item.__current ? '当前对话' : (item.sessionId || ''), formatWorkspaceDate(item.updatedAt)].filter(Boolean),
        'conversation',
        item.sessionId || currentSessionId,
        String(block?.id || ''),
        {
          active: hasExplicitSelection
            ? (activeSection === 'conversation' && activeItemId === String(item.sessionId || ''))
            : !!item.__current,
          tag: item.__current ? 'Now' : 'Log',
        },
      )).join('')
    : '<div class="project-docset-detail-empty">当前项目还没有推进记录。先把这次对话的阶段结论写进去。</div>';

  const materialItemsHtml = materials.length > 0
    ? materials.map((item) => renderProjectDocsetSidebarItem(
        item.title || item.id || 'Material',
        item.sourcePath || item.path || item.preview || '这份资料还没有摘要。',
        [item.sourcePath || item.path || '', formatWorkspaceDate(item.updatedAt)].filter(Boolean),
        'material',
        item.id,
        String(block?.id || ''),
        {
          active: hasExplicitSelection
            ? (activeSection === 'material' && activeItemId === String(item.id || ''))
            : (!currentConversationRecord && materials[0] && materials[0].id === item.id),
          tag: 'Doc',
        },
      )).join('')
    : '<div class="project-docset-detail-empty">当前还没有资料。AI 方案、外部文档和参考说明都可以放在这里。</div>';

  const requirementTitle = agent?.id === 'agent-creator' ? 'Agent 需求' : '用户需求';
  const requirementSummary = effectiveRequirement.goal || effectiveRequirement.agent_goal || effectiveRequirement.agent_name || effectiveRequirement.feature_name || '当前还没有明确目标。';
  const requirementBody = editingRequirement
    ? [
        '<div class="project-docset-requirement-form">',
        (Array.isArray(requirementBlock?.fields) ? requirementBlock.fields : []).map((field) => renderWorkspaceField(agent, field, requirementDraft, 'startup-form')).join(''),
        '</div>',
        '<div class="project-docset-requirement-actions">',
        '<button class="workspace-action secondary" type="button" onclick="window.cancelProjectRequirementEdit()">取消</button>',
        '<button class="workspace-action" type="button" onclick="window.saveProjectRequirementForm()">保存需求</button>',
        '</div>',
      ].join('')
    : renderProjectRequirementCards(agent, requirementBlock, effectiveRequirement);

  const pagerHtml = [
    { id: 'requirement', label: '需求' },
    { id: 'log', label: '推进记录' },
    { id: 'materials', label: '资料' },
  ].map((item) => (
    '<button class="project-docset-tab' + (page === item.id ? ' active' : '') + '" type="button" onclick="window.setProjectDocsetPage(&quot;' + escapeHtml(item.id) + '&quot;)">' + escapeHtml(item.label) + '</button>'
  )).join('');

  const requirementPageHtml = [
    '<div class="project-docset-page requirement-page">',
    '<div class="project-docset-requirement">',
    '<div class="project-docset-requirement-head">',
    '<div>',
    '<div class="project-docset-requirement-title">' + escapeHtml(requirementTitle) + '</div>',
    '<div class="project-docset-requirement-subtitle">这里保存项目目标、约束和上下文，是后续所有对话共享的起点。</div>',
    '</div>',
    '<div class="workspace-actions">' + (
      editingRequirement
        ? '<button class="workspace-action secondary" type="button" onclick="window.cancelProjectRequirementEdit()">退出编辑</button>'
        : '<button class="workspace-action secondary" type="button" onclick="window.startProjectRequirementEdit()">编辑需求</button>'
    ) + '</div>',
    '</div>',
    requirementBody,
    '</div>',
    '</div>',
  ].join('');

  const logPageHtml = [
    '<div class="project-docset-page">',
    '<div class="project-docset-browser">',
    '<aside class="project-docset-browser-list">',
    renderProjectDocsetList('推进记录', combinedConversations.length, conversationItemsHtml),
    '</aside>',
    '<section class="project-docset-browser-detail">' + renderProjectDocsetDetailPane(detail && detail.type === 'conversation' ? detail : (combinedConversations.length > 0 ? { type: 'conversation', value: combinedConversations[0] } : null)) + '</section>',
    '</div>',
    '</div>',
  ].join('');

  const materialsPageHtml = [
    '<div class="project-docset-page">',
    '<div class="project-docset-page-head">',
    '<div class="project-docset-page-note">这里放可复用的资料引用：AI 方案书、外部文档、参考目录或本地文件路径。</div>',
    '<div class="workspace-actions">',
    '<button class="workspace-action secondary" type="button" onclick="window.openProjectMaterialImport(&quot;files&quot;)">导入文件</button>',
    '<button class="workspace-action secondary" type="button" onclick="window.openProjectMaterialImport(&quot;folder&quot;)">导入文件夹</button>',
    '</div>',
    '</div>',
    '<div class="project-docset-browser">',
    '<aside class="project-docset-browser-list">',
    renderProjectDocsetList('资料', materials.length, materialItemsHtml),
    '</aside>',
    '<section class="project-docset-browser-detail">' + renderProjectDocsetDetailPane(detail && detail.type === 'material' ? detail : (materials.length > 0 ? { type: 'material', value: materials[0] } : null)) + '</section>',
    '</div>',
    '</div>',
  ].join('');

  const pageBody = page === 'requirement'
    ? requirementPageHtml
    : (page === 'log' ? logPageHtml : materialsPageHtml);

  return [
    '<div class="project-docset-shell-v2">',
    '<div class="project-docset-topbar">',
    '<div class="project-docset-tabs">' + pagerHtml + '</div>',
    '</div>',
    pageBody,
    '</div>',
  ].join('');
}

function renderProjectDocsetBlock(agent, block) {
  const data = getProjectDocsetData(agent, block);
  const title = localizeWorkspaceValue(block.title, 'Project Docset');
  const desc = localizeWorkspaceValue(block.description, '');
  const emptyText = localizeWorkspaceValue(block.emptyText, 'No project docset yet.');

  if (!data?.exists) {
    return [
      '<section class="workspace-section">',
      '<div class="workspace-section-header"><div><div class="workspace-section-title">' + escapeHtml(title) + '</div><div class="workspace-section-desc">' + escapeHtml(desc) + '</div></div></div>',
      '<div class="workspace-history-list"><div class="workspace-history-item"><div>' + escapeHtml(emptyText) + '</div></div></div>',
      '</section>',
    ].join('');
  }

  return [
    '<section class="workspace-section workspace-docset-shell">',
    '<div class="workspace-section-header"><div><div class="workspace-section-title">' + escapeHtml(title) + '</div><div class="workspace-section-desc">' + escapeHtml(desc || (data?.projectDir || '')) + '</div></div></div>',
    renderProjectDocsetContent(agent, block, data),
    '</section>',
  ].join('');
}

// ── Chrome update ──

function updateProjectDocsetChrome(agent = getCurrentAgentRecord()) {
  if (!projectDocsetToggle || !projectDocsetOverlay || !projectDocsetSheet) return;
  const docset = getCurrentProjectDocset(agent);
  const canShowButton = Boolean(docset?.exists) && ensureUnitMode(agent) === 'chat';
  projectDocsetToggle.classList.toggle('hidden', !canShowButton);
  projectDocsetToggle.classList.toggle('active', canShowButton && currentProjectDocsetOpen);
  projectDocsetToggle.textContent = currentLanguage === 'zh' ? '项目文档' : 'Project Docs';

  if (!canShowButton) {
    currentProjectDocsetOpen = false;
    currentProjectRequirementEdit = null;
  }

  projectDocsetOverlay.classList.toggle('hidden', !(canShowButton && currentProjectDocsetOpen));
  if (!(canShowButton && currentProjectDocsetOpen)) {
    projectDocsetSheet.innerHTML = '';
    return;
  }

  const block = {
    id: 'project-docset',
    title: { zh: '项目文档集', en: 'Project Docset' },
    description: { zh: '当前项目的实时文档状态。', en: 'Live project documentation for the current conversation.' },
  };

  projectDocsetSheet.innerHTML = [
    '<div class="project-docset-sheet-head">',
    '<div>',
    '<div class="project-docset-sheet-title">' + escapeHtml(localizeWorkspaceValue(block.title, 'Project Docset')) + '</div>',
    '<div class="project-docset-sheet-subtitle">' + escapeHtml(String(docset?.projectDir || '')) + '</div>',
    '</div>',
    '<div class="workspace-actions"><button class="workspace-action secondary" type="button" onclick="window.toggleProjectDocsetOverlay(false)">关闭</button></div>',
    '</div>',
    '<div class="project-docset-sheet-body">',
    renderProjectDocsetContent(agent, block, docset),
    '</div>',
  ].join('');
}

// ── Docset & material action handlers (from app-main.js) ──
window.toggleProjectDocsetOverlay = (force) => {
  if (typeof force === 'boolean') {
    currentProjectDocsetOpen = force;
  } else {
    currentProjectDocsetOpen = !currentProjectDocsetOpen;
  }
  updateProjectDocsetChrome(getCurrentAgentRecord());
};

window.setProjectDocsetPage = (page) => {
  currentProjectDocsetPage = ['requirement', 'log', 'materials'].includes(page) ? page : 'requirement';
  renderCurrentMainView();
};

window.startProjectRequirementEdit = () => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  currentProjectDocsetPage = 'requirement';
  currentProjectRequirementEdit = { agentId: agent.id };
  renderCurrentMainView();
};

window.cancelProjectRequirementEdit = () => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  resetProjectRequirementDraft(agent);
  currentProjectRequirementEdit = null;
  renderCurrentMainView();
};

window.saveProjectRequirementForm = async () => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const forms = getWorkspaceFormDraft(agent);
  try {
    await persistWorkspaceState(agent, forms, {
      openDirectory: getAgentWorkspaceState(agent)?.openDirectory || '',
    });
    currentProjectRequirementEdit = null;
    await loadAgents();
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to save project requirement form:', error);
  }
};

window.openProjectMaterialImport = (mode = 'files') => {
  window.importProjectMaterialsByPath(mode).catch((error) => {
    console.error('Failed to open project material import:', error);
  });
};

window.importProjectMaterialsByPath = async (mode = 'files') => {
  const agent = getCurrentAgentRecord();
  const docset = getCurrentProjectDocset(agent);
  if (!agent?.id || !docset?.projectDir) return;

  try {
    let materials = [];
    if (mode === 'folder') {
      const selected = await invoke('select_directory');
      if (!selected || selected.cancelled || !selected.path) return;
      materials = [{
        name: getPathLeaf(selected.path) || selected.path,
        sourcePath: selected.path,
        sourceKind: 'directory',
      }];
    } else {
      const selected = await invoke('select_files');
      const paths = Array.isArray(selected?.paths) ? selected.paths.filter(Boolean) : [];
      if (!paths.length) return;
      materials = paths.map((sourcePath) => ({
        name: getPathLeaf(sourcePath) || sourcePath,
        sourcePath,
        sourceKind: 'file',
      }));
    }

    const response = await fetch('/protoclaw/project_docset/import_materials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: agent.id,
        projectDir: docset.projectDir,
        mode,
        materials,
      }),
    });

    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'Failed to import materials'));
    }

    await loadAgents();
    currentProjectDocsetPage = 'materials';
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to import project materials:', error);
  }
};
