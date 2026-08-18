/**
 * workspace-blocks.js — Workspace Block 渲染模块（从 app-ui.js 域 G 提取）
 *
 * 包含：
 *   通用 Workspace Blocks：
 *     - shouldRenderBlock, renderActionButton, renderWorkspaceHero
 *     - renderWorkspaceActionGroup, renderWorkspaceLauncherGrid
 *     - renderWorkspaceField, renderWorkspaceForm, renderFlowEditorBlock
 *     - getDirectorySummaryData, renderDirectorySummaryPanel, renderWorkspaceStatusGrid
 *   Feature 仓库 Block：
 *     - getFeatureRepositoryData, getRepoLocaleText
 *     - parseWorkspaceListField, serializeWorkspaceListField (跨域共享工具函数)
 *     - getAssemblyPresetLabel, getAssemblyPresetDescription
 *     - ASSEMBLY_PRESET_FEATURES (常量), ASSEMBLY_BUNDLE_FEATURES (常量)
 *     - window.applyAssemblyPreset, window.setBundleFilter
 *     - getAssemblyFeaturePackageToken, getAssemblyStageLabel
 *     - formatAssemblyFeatureToken, getAssemblyFeatureLabel
 *     - buildAssemblyGeneratedPrompt, getAssemblyPromptValue
 *     - formatRepoFileSize, normalizeRepoUrl, renderRepoLink
 *     - getFeatureTypeLabel, getCompatibilityTagLabel
 *     - renderFeatureRepositoryBlock
 *   Assembly Workbench 入口：
 *     - renderAssemblyWorkbenchBlock
 *
 * 依赖（全局作用域）：
 *   app-core.js: currentLanguage, escapeHtml, t, localizeWorkspaceValue, formatWorkspaceDate,
 *                getCurrentAgentRecord, shouldAnimateWorkspaceSurface,
 *                repoSourceFilter, repoSearchQuery, selectedRepositoryPackageId
 *   project-data.js: getFeatureCreatorProjects, getAgentCreatorProjects, getWorkspaceSessions,
 *                    canEnterWorkspaceChat, getAgentWorkspaceState, updateAgentWorkspaceState
 *   im-ui.js: getIMWorkspaceDraft, isIMWorkspaceConfigEditor, renderIMWorkspaceConfigEditor
 *   app-ui.js (壳): renderCurrentMainView, renderAssemblyWorkbenchStageFlow
 *   app-ui.js (域 E): getWorkspaceFormDraft, saveWorkspaceFormDraft, persistWorkspaceState,
 *                     getFeatureCreatorOutputDirectory
 *   app-main.js: getSavedAssemblyConfigs, canonicalizeAssemblyFeatureSelection
 *   debug-overview.js: window.openRepositoryPackageDetails, window.closeRepositoryPackageDetails,
 *                    window.setRepoSourceFilter, window.setRepoSearchQuery, window.openFeatureUploadDialog
 */

// ═══════════════════════════════════════════════════════════════
// 通用 Workspace Blocks
// ═══════════════════════════════════════════════════════════════

function shouldRenderBlock(block) {
  const visibility = block?.visibility || 'always';
  if (visibility === 'home-default') {
    return currentWorkspaceTab === 'home' || !currentWorkspaceTab;
  }
  if (typeof visibility === 'string' && visibility.startsWith('tab:')) {
    return currentWorkspaceTab === visibility.slice(4);
  }
  if (visibility === 'chat-header-only') {
    return false;
  }
  if (visibility !== 'focus') return true;
  return currentWorkspaceTab === `block:${block.id}`;
}

function renderActionButton(action, options = {}) {
  const label = localizeWorkspaceValue(action?.label, '');
  const encoded = escapeHtml(JSON.stringify(action?.action || {}));
  return '<button class="workspace-action" type="button" data-workspace-action="' + encoded + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)"' + (options.disabled ? ' disabled' : '') + '>' + escapeHtml(label) + '</button>';
}

function renderWorkspaceHero(agent, block) {
  const title = localizeWorkspaceValue(block.title, agent.name || agent.id);
  const body = localizeWorkspaceValue(block.body, agent.description || '');
  const heroClass = agent?.id === 'home' ? 'workspace-hero home-shell' : 'workspace-hero';
  const isIM = agent?.id === 'qqbot';
  const actionsHtml = isIM
    ? '<div class="workspace-hero-actions"><button class="ph-banner-btn secondary im-channel-config-btn" type="button" onclick="window.openIMChannelConfig()">' + (currentLanguage === 'zh' ? '配置渠道' : 'Channel Config') + '</button></div>'
    : '';
  return [
    '<section class="' + heroClass + (isIM ? ' has-actions' : '') + '">',
    '<div class="workspace-hero-main">',
    '<div class="workspace-kicker">' + escapeHtml(localizeWorkspaceValue(block.kicker, t('workspace_kicker'))) + '</div>',
    '<div class="workspace-title">' + escapeHtml(title) + '</div>',
    '<div class="workspace-body">' + escapeHtml(body) + '</div>',
    '</div>',
    actionsHtml,
    '</section>',
  ].join('');
}

function renderWorkspaceActionGroup(block) {
  const actions = Array.isArray(block?.actions) ? block.actions : [];
  if (actions.length === 0) return '';
  return [
    '<div class="workspace-actions">',
    actions.map((action) => renderActionButton(action)).join(''),
    '</div>',
  ].join('');
}

function renderWorkspaceLauncherGrid(agent, block) {
  const cards = Array.isArray(block?.cards) ? block.cards : [];
  const directorySummary = getDirectorySummaryData(agent, block);
  const sessionCount = getWorkspaceSessions(agent).length;
  const featureProjectCount = agent?.id === 'feature-creator' ? getFeatureCreatorProjects(agent).length : 0;
  const agentProjectCount = agent?.id === 'agent-creator' ? getAgentCreatorProjects(agent).length : 0;
  if (cards.length === 0) return '';
  const gridClass = agent?.id === 'home' ? 'workspace-launch-grid home-grid' : 'workspace-launch-grid';

  return [
    '<section class="' + gridClass + '">',
    cards.map((card, index) => {
      const title = localizeWorkspaceValue(card.title, '');
      const body = localizeWorkspaceValue(card.body, '');
      const note = localizeWorkspaceValue(card.note, '');
      const actionLabel = localizeWorkspaceValue(card.actionLabel, '');
      const action = escapeHtml(JSON.stringify(card.action || {}));
      const actionType = card?.action?.type || '';
      const disabled = (
        (actionType === 'open_latest_session' && (agent?.id === 'feature-creator'
          ? featureProjectCount === 0
          : (agent?.id === 'agent-creator' ? agentProjectCount === 0 : sessionCount === 0)))
        || (actionType === 'show_chat' && sessionCount === 0)
      );
      const shouldRenderNote = note.trim() !== '';
      const extraClass = agent?.id === 'home'
        ? (' home-card' + (index === 0 ? ' home-card-primary' : ''))
        : '';

      return [
        '<div class="workspace-launch-card' + (index === 0 ? ' primary' : '') + extraClass + (disabled ? ' disabled' : '') + '">',
        '<div class="workspace-launch-title">' + escapeHtml(title) + '</div>',
        '<div class="workspace-launch-body">' + escapeHtml(body) + '</div>',
        shouldRenderNote
          ? '<div class="workspace-launch-note">' + escapeHtml(note) + '</div>'
          : '',
        '<button class="workspace-action" type="button" data-workspace-action="' + action + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)"' + (disabled ? ' disabled' : '') + '>' + escapeHtml(actionLabel) + '</button>',
        '</div>',
      ].join('');
    }).join(''),
    '</section>',
  ].join('');
}


function renderStudioProjectsBlock(agent, block) {
  const workspaceState = getAgentWorkspaceState(agent);
  const projects = Array.isArray(workspaceState?.studioProjects) ? workspaceState.studioProjects : [];
  const title = localizeWorkspaceValue(block.title, '');
  const desc = localizeWorkspaceValue(block.description, '');
  const emptyHtml = [
    '<div class="workspace-history-list">',
    '<div class="workspace-history-item"><div>' + escapeHtml(currentLanguage === 'zh' ? '还没有沉淀的项目。在对话中初始化的项目会出现在这里。' : 'No projects yet. Projects initialized in conversation will appear here.') + '</div></div>',
    '</div>',
  ].join('');

  const bodyHtml = projects.length > 0
    ? '<div class="feature-project-list">' + projects.map((project) => {
        const continueAction = escapeHtml(JSON.stringify({
          type: 'create_session',
          projectName: String(project.name || ''),
          openDirectory: String(project.projectDir || ''),
        }));
        const projectPreview = String(project.goal || '');
        return [
          '<div class="feature-project-card">',
          '<div class="feature-project-row">',
          '<div class="feature-project-summary">',
          '<div class="feature-project-titlebar">',
          '<div class="workspace-history-title">' + escapeHtml(String(project.name || project.projectDir || '')) + '</div>',
          '</div>',
          project.updatedAt ? '<div class="feature-project-meta-line"><span>' + escapeHtml(formatWorkspaceDate(project.updatedAt)) + '</span></div>' : '',
          projectPreview ? '<div class="workspace-history-preview">' + escapeHtml(projectPreview) + '</div>' : '',
          project.projectDir ? '<div class="workspace-history-meta">' + escapeHtml(project.projectDir) + '</div>' : '',
          '</div>',
          '<div class="feature-project-side">',
          '<div class="feature-project-head-actions">',
          '<button class="workspace-action" type="button" data-workspace-action="' + continueAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + escapeHtml(currentLanguage === 'zh' ? '继续开发' : 'Continue') + '</button>',
          '</div>',
          '</div>',
          '</div>',
          '</div>',
        ].join('');
      }).join('') + '</div>'
    : emptyHtml;

  return [
    '<section class="workspace-section">',
    '<div class="workspace-section-header">',
    '<div>',
    '<div class="workspace-section-title">' + escapeHtml(title) + '</div>',
    '<div class="workspace-section-desc">' + escapeHtml(desc) + '</div>',
    '</div>',
    '</div>',
    bodyHtml,
    '</section>',
  ].join('');
}

function renderWorkspaceField(agent, field, draft, formId) {
  const name = String(field.name || '').trim();
  if (!name) return '';

  const label = localizeWorkspaceValue(field.label, name);
  const placeholder = localizeWorkspaceValue(field.placeholder, '');
  const value = draft[name] ?? '';
  const escapedName = escapeHtml(name);
  const escapedLabel = escapeHtml(label);
  const escapedPlaceholder = escapeHtml(placeholder);
  const escapedValue = escapeHtml(String(value));

  if (field.type === 'textarea') {
    return [
      '<label class="workspace-form-field">',
      '<span class="workspace-form-label">' + escapedLabel + '</span>',
      '<textarea class="workspace-form-textarea" placeholder="' + escapedPlaceholder + '" oninput="window.updateWorkspaceFormDraft(&quot;' + escapeHtml(formId) + '&quot;, &quot;' + escapedName + '&quot;, this.value)">' + escapedValue + '</textarea>',
      '</label>',
    ].join('');
  }

  if (field.type === 'select') {
    const options = Array.isArray(field.options) ? field.options : [];
    const optionsHtml = options.map((option) => {
      const optionValue = typeof option === 'string' ? option : String(option?.value ?? '');
      const optionLabel = typeof option === 'string' ? option : localizeWorkspaceValue(option?.label, optionValue);
      const selected = String(value) === optionValue ? ' selected' : '';
      return '<option value="' + escapeHtml(optionValue) + '"' + selected + '>' + escapeHtml(optionLabel) + '</option>';
    }).join('');
    return [
      '<label class="workspace-form-field">',
      '<span class="workspace-form-label">' + escapedLabel + '</span>',
      '<select class="workspace-form-select" onchange="window.updateWorkspaceFormDraft(&quot;' + escapeHtml(formId) + '&quot;, &quot;' + escapedName + '&quot;, this.value)">',
      optionsHtml,
      '</select>',
      '</label>',
    ].join('');
  }

  if (field.type === 'directory-picker') {
    if (!field.modeField) {
      const displayedValue = String(value || '');
      return [
        '<label class="workspace-form-field">',
        '<span class="workspace-form-label">' + escapedLabel + '</span>',
        '<div class="workspace-form-directory-picker">',
        '<input class="workspace-form-input" type="text" value="' + escapeHtml(displayedValue || t('workspace_directory_not_selected')) + '" readonly data-workspace-form-display="' + escapeHtml(formId + ':' + escapedName) + '">',
        '<button class="workspace-action" type="button" onclick="window.chooseWorkspaceDirectory(&quot;' + escapeHtml(formId) + '&quot;, &quot;' + escapedName + '&quot;)">' + escapeHtml(t('workspace_pick_directory')) + '</button>',
        '</div>',
        '<div class="workspace-form-note">' + escapeHtml(t('workspace_pick_directory_hint')) + '</div>',
        '</label>',
      ].join('');
    }

    const modeValue = String(draft[field.modeField || 'install_mode'] || 'system');
    const isCustomMode = modeValue === 'custom';
    const displayedValue = String(value || '');
    const outputDir = getFeatureCreatorOutputDirectory(agent, draft);
    if (isCustomMode) {
      return [
        '<label class="workspace-form-field">',
        '<span class="workspace-form-label">' + escapedLabel + '</span>',
        '<div class="workspace-form-directory-picker">',
        '<input class="workspace-form-input" type="text" value="' + escapeHtml(displayedValue || t('workspace_directory_not_selected')) + '" readonly data-workspace-form-display="' + escapeHtml(formId + ':' + escapedName) + '">',
        '<button class="workspace-action" type="button" onclick="window.chooseWorkspaceDirectory(&quot;' + escapeHtml(formId) + '&quot;, &quot;' + escapedName + '&quot;)">' + escapeHtml(t('workspace_pick_directory')) + '</button>',
        '</div>',
        '<div class="workspace-form-note">' + escapeHtml(t('workspace_pick_directory_hint')) + '</div>',
        outputDir ? '<div class="workspace-form-note" data-workspace-output-note="' + escapeHtml(formId) + '">' + escapeHtml(t('feature_creator_output_dir')) + ': ' + escapeHtml(outputDir) + '</div>' : '',
        '</label>',
      ].join('');
    }
    return [
      '<label class="workspace-form-field">',
      '<span class="workspace-form-label">' + escapedLabel + '</span>',
      '<input class="workspace-form-input" type="text" value="' + escapeHtml(displayedValue || t('workspace_directory_not_selected')) + '" readonly data-workspace-form-display="' + escapeHtml(formId + ':' + escapedName) + '">',
      '<div class="workspace-form-note">' + escapeHtml(t('workspace_install_mode_system')) + '</div>',
      outputDir ? '<div class="workspace-form-note" data-workspace-output-note="' + escapeHtml(formId) + '">' + escapeHtml(t('feature_creator_output_dir')) + ': ' + escapeHtml(outputDir) + '</div>' : '',
      '</label>',
    ].join('');
  }

  return [
    '<label class="workspace-form-field">',
    '<span class="workspace-form-label">' + escapedLabel + '</span>',
    '<input class="workspace-form-input" type="' + escapeHtml(field.type || 'text') + '" value="' + escapedValue + '" placeholder="' + escapedPlaceholder + '" oninput="window.updateWorkspaceFormDraft(&quot;' + escapeHtml(formId) + '&quot;, &quot;' + escapedName + '&quot;, this.value)">',
    '</label>',
  ].join('');
}

function renderWorkspaceForm(agent, block) {
  const title = localizeWorkspaceValue(block.title, t('workspace_tab_form'));
  const desc = localizeWorkspaceValue(block.description, '');
  const fields = Array.isArray(block.fields) ? block.fields : [];
  const formId = block.id || 'form';
  if (fields.length === 0) {
    return '<section class="workspace-section"><div class="workspace-section-title">' + escapeHtml(t('workspace_form_empty')) + '</div></section>';
  }

  const draft = getWorkspaceFormDraft(agent)[formId] || {};
  const submitAction = escapeHtml(JSON.stringify(block.submitAction || { type: 'show_chat' }));
  const backAction = block.backAction ? renderActionButton(block.backAction) : '';
  return [
    '<section class="workspace-section">',
    '<div class="workspace-section-header">',
    '<div>',
    '<div class="workspace-section-title">' + escapeHtml(title) + '</div>',
    '<div class="workspace-section-desc">' + escapeHtml(desc) + '</div>',
    '</div>',
    '</div>',
    '<div class="workspace-form">',
    fields.map((field) => renderWorkspaceField(agent, field, draft, formId)).join(''),
    '<div class="workspace-form-actions' + (backAction ? ' spread' : '') + '">',
    backAction ? '<div>' + backAction + '</div>' : '',
    '<div class="workspace-actions">',
    '<button class="workspace-action" type="button" data-workspace-form-id="' + escapeHtml(formId) + '" data-workspace-submit-action="' + submitAction + '" onclick="window.saveWorkspaceForm(this.dataset.workspaceFormId, this.dataset.workspaceSubmitAction)">' + escapeHtml(t('workspace_form_save')) + '</button>',
    '<button class="workspace-action" type="button" data-workspace-form-id="' + escapeHtml(formId) + '" onclick="window.resetWorkspaceForm(this.dataset.workspaceFormId)">' + escapeHtml(t('workspace_form_reset')) + '</button>',
    '</div>',
    '</div>',
    '<div class="workspace-form-note">' + escapeHtml(t('workspace_form_saved')) + '</div>',
    '</div>',
    '</section>',
  ].join('');
}


function renderFlowEditorBlock(agent, block) {
  if (window.ClawFlowEditor && typeof window.ClawFlowEditor.renderBlock === 'function') {
    return window.ClawFlowEditor.renderBlock(agent, block, {
      currentLanguage,
      escapeHtml,
      localizeWorkspaceValue,
      getCurrentAgentRecord,
      getWorkspaceFormDraft,
      saveWorkspaceFormDraft,
      persistWorkspaceState,
      renderCurrentMainView,
      updateAgentWorkspaceState,
      getAgentWorkspaceState,
    });
  }
  const title = localizeWorkspaceValue(block.title, currentLanguage === 'zh' ? '编排' : 'Flows');
  return [
    '<section class="assembly-intro">',
    '<div class="workspace-section-title">' + escapeHtml(title) + '</div>',
    '<div class="assembly-workbench-note">' + escapeHtml(currentLanguage === 'zh' ? 'Flow 编辑器资源正在加载。' : 'Flow editor assets are loading.') + '</div>',
    '</section>',
  ].join('');
}


// ═══════════════════════════════════════════════════════════════
// Directory Summary & Status Grid
// ═══════════════════════════════════════════════════════════════

function getDirectorySummaryData(agent, block) {
  const blockId = String(block?.id || '').trim();
  if (!blockId) return null;
  const workspaceData = agent?.workspace_data;
  if (!workspaceData || typeof workspaceData !== 'object') return null;
  return workspaceData[blockId] || null;
}

function renderDirectorySummaryPanel(agent, block) {
  const summary = getDirectorySummaryData(agent, block);
  if (!summary) return '';

  const title = localizeWorkspaceValue(block?.directorySummary?.title, '目录概览');
  const pathLabel = localizeWorkspaceValue(block?.directorySummary?.pathLabel, '目录路径');
  const updatedLabel = localizeWorkspaceValue(block?.directorySummary?.updatedLabel, '最后变更');
  const names = Array.isArray(summary.sampleNames) ? summary.sampleNames : [];

  return [
    '<div class="workspace-note-panel">',
    '<div class="workspace-note-title">' + escapeHtml(title) + '</div>',
    '<div class="workspace-note-row">' + escapeHtml(pathLabel) + ': ' + escapeHtml(summary.path || '-') + '</div>',
    '<div class="workspace-note-row">' + escapeHtml(updatedLabel) + ': ' + escapeHtml(summary.updatedAt ? formatWorkspaceDate(summary.updatedAt) : '-') + '</div>',
    names.length > 0
      ? '<div class="workspace-tag-list">' + names.map((name) => '<span class="workspace-tag">' + escapeHtml(name) + '</span>').join('') + '</div>'
      : '',
    summary.error ? '<div class="workspace-note-row">' + escapeHtml(summary.error) + '</div>' : '',
    '</div>',
  ].join('');
}

function renderWorkspaceStatusGrid(agent, block) {
  const title = localizeWorkspaceValue(block.title, t('workspace_tab_live'));
  const desc = localizeWorkspaceValue(block.description, agent?.description || '');
  const sessions = getWorkspaceSessions(agent);
  const summary = sessions.find((session) => session.id === (agent?.active_workspace_session_id || agent?.workspace_sessions?.activeSessionId)) || sessions[0] || null;
  const connected = agent ? (agent.connected !== false ? t('status_connected') : t('status_disconnected')) : t('status_no_agent');
  const imDraft = getIMWorkspaceDraft();
  const directorySummary = getDirectorySummaryData(agent, block);
  const canOpenChat = canEnterWorkspaceChat(agent);
  const cardsHtml = [
    { label: t('workspace_live_status'), value: connected, note: agent?.status || '-' },
    { label: t('workspace_live_runtime'), value: agent?.runtime_session_id || agent?.runtimeSessionId || '-', note: agent?.pid ? `PID ${agent.pid}` : '-' },
    { label: t('workspace_live_pending'), value: String(agent?.pending_input_count ?? 0), note: String(agent?.message_count ?? currentMessages.length ?? 0) + ' ' + t('feature_messages') },
    { label: t('workspace_live_session'), value: summary ? (summary.title || summary.id || '-') : t('workspace_history_empty'), note: summary?.updatedAt ? formatWorkspaceDate(summary.updatedAt) : '-' },
    directorySummary
      ? {
          label: localizeWorkspaceValue(block?.directorySummary?.countLabel, 'Skills'),
          value: String(directorySummary.skillCount ?? 0),
          note: directorySummary.exists
            ? `${localizeWorkspaceValue(block?.directorySummary?.countNote, 'Entries')}: ${directorySummary.entryCount ?? 0}`
            : (directorySummary.error || 'Not ready'),
        }
      : null,
    isIMWorkspaceConfigEditor(block)
      ? {
          label: t('workspace_live_config'),
          value: imDraft.workspaceConfig?.selectedChannel === 'weixin'
            ? (imDraft.weixinConfig?.configured ? t('im_workspace_bound') : t('im_workspace_not_bound'))
            : imDraft.workspaceConfig?.selectedChannel === 'feishu'
              ? (imDraft.feishuConfig?.configured ? t('im_workspace_bound') : t('im_workspace_not_bound'))
              : imDraft.workspaceConfig?.selectedChannel === 'wecom'
                ? (imDraft.wecomConfig?.configured ? t('im_workspace_bound') : t('im_workspace_not_bound'))
                : imDraft.workspaceConfig?.selectedChannel === 'rokid'
                  ? (imDraft.rokidConfig?.configured ? t('im_workspace_bound') : t('im_workspace_not_bound'))
                  : (imDraft.qqConfig?.appId && imDraft.qqConfig?.clientSecret ? t('qqbot_config_ready') : t('qqbot_config_incomplete')),
          note: imDraft.workspaceConfig?.selectedChannel === 'weixin'
            ? (imDraft.workspaceConfig?.channels?.weixin?.label || t('im_workspace_weixin_section'))
            : imDraft.workspaceConfig?.selectedChannel === 'feishu'
              ? (imDraft.workspaceConfig?.channels?.feishu?.label || '飞书')
              : imDraft.workspaceConfig?.selectedChannel === 'wecom'
                ? (imDraft.workspaceConfig?.channels?.wecom?.label || '企业微信')
                : imDraft.workspaceConfig?.selectedChannel === 'rokid'
                  ? (imDraft.workspaceConfig?.channels?.rokid?.label || 'Rokid 眼镜')
                  : (imDraft.workspaceConfig?.channels?.qq?.label || t('im_workspace_qq_section')),
        }
      : null,
  ].filter(Boolean).map((card) => (
    '<div class="workspace-card"><div class="workspace-card-label">' + escapeHtml(card.label) + '</div><div class="workspace-card-value">' + escapeHtml(card.value) + '</div><div class="workspace-card-note">' + escapeHtml(card.note) + '</div></div>'
  )).join('');

  const sectionHtml = [
    '<section class="workspace-section">',
    '<div class="workspace-section-header">',
    '<div>',
    '<div class="workspace-section-title">' + escapeHtml(title) + '</div>',
    '<div class="workspace-section-desc">' + escapeHtml(desc) + '</div>',
    '</div>',
    '<button class="workspace-action" type="button" data-workspace-action="{&quot;type&quot;:&quot;show_chat&quot;}" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)"' + (canOpenChat ? '' : ' disabled') + '>' + escapeHtml(t('workspace_open_chat')) + '</button>',
    '</div>',
    '<div class="workspace-grid">' + cardsHtml + '</div>',
    directorySummary ? renderDirectorySummaryPanel(agent, block) : '',
    isIMWorkspaceConfigEditor(block) ? renderIMWorkspaceConfigEditor(block) : '',
    '</section>',
  ].join('');

  return sectionHtml;
}

// ═══════════════════════════════════════════════════════════════
// Feature 仓库 Block
// ═══════════════════════════════════════════════════════════════

function getFeatureRepositoryData(agent, block) {
  const blockId = String(block?.id || '').trim();
  if (!blockId) return null;
  const workspaceData = agent?.workspace_data;
  if (!workspaceData || typeof workspaceData !== 'object') return null;
  return workspaceData[blockId] || null;
}

function getRepoLocaleText(zh, en) {
  return currentLanguage === 'zh' ? zh : en;
}

function parseWorkspaceListField(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function serializeWorkspaceListField(items) {
  return Array.from(new Set((Array.isArray(items) ? items : []).map((item) => String(item || '').trim()).filter(Boolean))).join('\n');
}

function getAssemblyPresetLabel(value) {
  const map = {
    'general-chatbot': currentLanguage === 'zh' ? '通用对话助手' : 'General Chatbot',
    'tool-operator': currentLanguage === 'zh' ? '工具执行助手' : 'Tool Operator',
    'workflow-assistant': currentLanguage === 'zh' ? '工作流推进助手' : 'Workflow Assistant',
  };
  return map[value] || value || (currentLanguage === 'zh' ? '未设置' : 'Unset');
}

function getAssemblyPresetDescription(value) {
  const map = {
    'general-chatbot': currentLanguage === 'zh'
      ? '偏向通用对话体验，强调基础能力完整和上手速度。'
      : 'Optimized for a general chat experience with balanced baseline capabilities.',
    'tool-operator': currentLanguage === 'zh'
      ? '偏向联网、执行和观察类能力，适合操作型助手。'
      : 'Optimized for web, execution, and observation capabilities for operator-style assistants.',
    'workflow-assistant': currentLanguage === 'zh'
      ? '偏向任务推进、控制和过程组织，适合持续跟进型 Agent。'
      : 'Optimized for task progression, control, and process organization.',
  };
  return map[value] || '';
}

const ASSEMBLY_PRESET_FEATURES = {
  'general-chatbot': ['websearch-feature', 'audit-feature', 'memory-feature'],
  'tool-operator': ['shell-feature', 'lsp-feature', 'websearch-feature'],
  'workflow-assistant': ['memory-feature', 'audit-feature', 'plugin-compat-feature'],
};

const ASSEMBLY_BUNDLE_FEATURES = {
  'web-retrieval': ['websearch-feature', 'visual-feature', 'audit-feature'],
  'memory-copilot': ['memory-feature', 'audit-feature'],
  'dev-operator': ['shell-feature', 'lsp-feature', 'websearch-feature'],
};

window.applyAssemblyPreset = (formId, presetKey) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  draft[formId] = draft[formId] || {};
  draft[formId].preset = presetKey;
  const features = ASSEMBLY_PRESET_FEATURES[presetKey] || [];
  const featureTokens = [];
  features.forEach((token) => {
    const match = getAssemblyFeaturePackageToken(token, agent);
    if (match) featureTokens.push(match);
  });
  draft[formId].selected_features = serializeWorkspaceListField(canonicalizeAssemblyFeatureSelection(agent, featureTokens));
  saveWorkspaceFormDraft(agent.id, draft);
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

function getAssemblyFeaturePackageToken(featureRef, agentOrPackages) {
  const pkgs = Array.isArray(agentOrPackages?.workspace_data?.['assembly-workbench']?.packages)
    ? agentOrPackages.workspace_data['assembly-workbench'].packages
    : (Array.isArray(agentOrPackages) ? agentOrPackages : []);
  for (const p of pkgs) {
    const id = (p.id || '').toLowerCase();
    const pn = (p.packageName || '').toLowerCase();
    const ref = featureRef.toLowerCase().replace(/-feature$/, '');
    if (id.includes(ref) || pn.includes(ref)) return p.id || p.packageName || featureRef;
  }
  return featureRef;
}

window.setBundleFilter = (formId, bundleKey) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  draft[formId] = draft[formId] || {};
  const currentFilter = draft[formId].bundle_filter || '';
  draft[formId].bundle_filter = currentFilter === bundleKey ? '' : bundleKey;
  saveWorkspaceFormDraft(agent.id, draft);
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

function getAssemblyStageLabel(value) {
  const map = {
    goal: currentLanguage === 'zh' ? '定义目标 Agent' : 'Define Target Agent',
    capabilities: currentLanguage === 'zh' ? '选择能力' : 'Choose Capabilities',
    environment: currentLanguage === 'zh' ? '环境准备' : 'Environment Setup',
    review: currentLanguage === 'zh' ? '确认与启动' : 'Review And Launch',
  };
  return map[value] || value || '';
}

function formatAssemblyFeatureToken(value) {
  return String(value || '')
    .trim()
    .replace(/^@agentdev\//, '')
    .replace(/-feature$/, '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getAssemblyFeatureLabel(token, packages = []) {
  const normalized = String(token || '').trim();
  if (!normalized) return '';
  const matched = packages.find((item) => {
    const candidates = [
      item?.id,
      item?.packageName,
      item?.name,
    ].map((entry) => String(entry || '').trim()).filter(Boolean);
    return candidates.includes(normalized);
  });
  return matched?.name || formatAssemblyFeatureToken(normalized) || normalized;
}

function buildAssemblyGeneratedPrompt(form, packages = []) {
  const assemblyName = getAssemblyDisplayName(form) || (currentLanguage === 'zh' ? '未命名 Agent' : 'Untitled Agent');
  const preset = String(form?.preset || 'general-chatbot').trim();
  const goal = String(form?.goal || '').trim();
  const selectedFeatures = parseWorkspaceListField(form?.selected_features)
    .map((item) => getAssemblyFeatureLabel(item, packages))
    .filter(Boolean);

  const sections = [
    currentLanguage === 'zh'
      ? `你是一个已经装配完成并直接面对最终用户的聊天 Agent。\n你的名称是：${assemblyName}。`
      : `You are a chat agent that has already been assembled and now speaks directly to the end user.\nYour name is: ${assemblyName}.`,
    currentLanguage === 'zh'
      ? `预设定位：${getAssemblyPresetLabel(preset)}。${getAssemblyPresetDescription(preset)}`
      : `Preset: ${getAssemblyPresetLabel(preset)}. ${getAssemblyPresetDescription(preset)}`,
  ];

  if (goal) {
    sections.push(currentLanguage === 'zh' ? `主要目标：${goal}` : `Primary goal: ${goal}`);
  }
  if (selectedFeatures.length > 0) {
    sections.push((currentLanguage === 'zh' ? '当前已启用能力：' : 'Enabled capabilities: ') + selectedFeatures.join(currentLanguage === 'zh' ? '、' : ', '));
  }
  sections.push(currentLanguage === 'zh'
    ? '直接以目标 Agent 身份与用户对话，不要提及 Agent Creator、装配过程或工作空间内部机制。没有挂载的能力不要假装拥有。'
    : 'Speak directly as the target agent. Do not mention Agent Creator, the assembly workflow, or workspace internals. Never pretend to have capabilities that are not enabled.');

  return sections.join('\n\n');
}

function getAssemblyPromptValue(form, packages = []) {
  const custom = String(form?.custom_system_prompt || '').trim();
  return custom || buildAssemblyGeneratedPrompt(form, packages);
}

function formatRepoFileSize(size) {
  const value = Number(size || 0);
  if (!Number.isFinite(value) || value <= 0) return '-';
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function normalizeRepoUrl(value) {
  if (!value || typeof value !== 'string') return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {}
  return '';
}

function renderRepoLink(url, label) {
  const safeUrl = normalizeRepoUrl(url);
  if (!safeUrl) return '';
  return '<a class="workspace-action secondary workspace-link-button" href="' + escapeHtml(safeUrl) + '" target="_blank" rel="noreferrer">' + escapeHtml(label) + '</a>';
}

function getFeatureTypeLabel(value) {
  const map = {
    tools: 'tools',
    mcp: 'mcp',
    hooks: 'hooks',
    control: 'control',
    rollback: 'rollback',
  };
  return map[value] || value;
}

function getCompatibilityTagLabel(value) {
  const map = {
    'supports-rollback': getRepoLocaleText('支持 rollback', 'supports rollback'),
    'no-rollback': getRepoLocaleText('不支持 rollback', 'no rollback'),
  };
  return map[value] || value;
}

function renderFeatureRepositoryBlock(agent, block) {
  const title = localizeWorkspaceValue(block.title, getRepoLocaleText('Feature 仓库', 'Feature Repository'));
  const desc = localizeWorkspaceValue(block.description, '');
  const repository = getFeatureRepositoryData(agent, block);
  const packages = Array.isArray(repository?.packages) ? repository.packages : [];
  const assemblySelection = block?.assemblySelection || null;
  const selectionFormId = typeof assemblySelection?.formId === 'string' ? assemblySelection.formId : '';
  const selectionField = typeof assemblySelection?.featureField === 'string' ? assemblySelection.featureField : '';
  const selectedValues = selectionFormId && selectionField
    ? new Set(parseWorkspaceListField(getWorkspaceFormDraft(agent)?.[selectionFormId]?.[selectionField]))
    : null;
  const officialCount = packages.filter((item) => item.source === 'official').length;
  const customCount = packages.filter((item) => item.source === 'custom').length;

  if (!repository || repository.error) {
    return [
      '<section class="workspace-section">',
      '<div class="workspace-section-header">',
      '<div>',
      '<div class="workspace-section-title">' + escapeHtml(title) + '</div>',
      '<div class="workspace-section-desc">' + escapeHtml(desc) + '</div>',
      '</div>',
      '</div>',
      '<div class="workspace-repo-warning">' + escapeHtml(repository?.error || getRepoLocaleText('仓库数据暂不可用。', 'Repository data is unavailable.')) + '</div>',
      '</section>',
    ].join('');
  }

  if (packages.length === 0) {
    return [
      '<section class="workspace-section">',
      '<div class="workspace-section-header">',
      '<div>',
      '<div class="workspace-section-title">' + escapeHtml(title) + '</div>',
      '<div class="workspace-section-desc">' + escapeHtml(desc) + '</div>',
      '</div>',
      '</div>',
      '<div class="workspace-history-item"><div>' + escapeHtml(getRepoLocaleText('当前仓库中还没有 tgz 包。', 'No tgz packages were found in the repository.')) + '</div></div>',
      '</section>',
    ].join('');
  }

  const summaryHtml = [
    {
      label: getRepoLocaleText('Feature', 'Features'),
      value: String(repository.packageCount ?? packages.length),
      note: getRepoLocaleText('按包名聚合后的条目数', 'Grouped package entries'),
    },
    {
      label: getRepoLocaleText('归档', 'Archives'),
      value: String(repository.archiveCount ?? 0),
      note: getRepoLocaleText('resources/features 中的 tgz 数量', 'tgz archives under resources/features'),
    },
    {
      label: getRepoLocaleText('缺失元数据', 'Missing Metadata'),
      value: String(repository.missingManifestCount ?? 0),
      note: getRepoLocaleText('没有 agentdev-feature.json 的归档', 'Archives without agentdev-feature.json'),
    },
  ].map((card) => [
    '<div class="workspace-card">',
    '<div class="workspace-card-label">' + escapeHtml(card.label) + '</div>',
    '<div class="workspace-card-value">' + escapeHtml(card.value) + '</div>',
    '<div class="workspace-card-note">' + escapeHtml(card.note) + '</div>',
    '</div>',
  ].join('')).join('');

  const filteredPackages = packages
    .filter((item) => {
      if (repoSourceFilter === 'official') return item.source === 'official';
      if (repoSourceFilter === 'custom') return item.source === 'custom';
      return true;
    })
    .filter((item) => {
      if (!repoSearchQuery) return true;
      const haystack = [
        item?.name,
        item?.id,
        item?.packageName,
        item?.description,
        ...(Array.isArray(item?.featureTypes) ? item.featureTypes : []),
        ...(Array.isArray(item?.tags) ? item.tags : []),
      ].join(' ').toLowerCase();
      return haystack.includes(repoSearchQuery);
    });

  const selectedPackage = packages.find((item) => item.id === selectedRepositoryPackageId) || null;
  if (selectedRepositoryPackageId && !selectedPackage) {
    selectedRepositoryPackageId = null;
  }

  const packagesHtml = filteredPackages.length === 0
    ? '<div class="workspace-history-item"><div>' + escapeHtml(getRepoLocaleText('没有匹配当前搜索的 Feature。', 'No features matched the current search.')) + '</div></div>'
    : filteredPackages.map((item) => {
    const versions = Array.isArray(item.versions) ? item.versions : [];
    const warnings = Array.isArray(item.warnings) ? item.warnings : [];
    const featureTypes = Array.isArray(item.featureTypes) ? item.featureTypes : [];
    const compatibilityTags = Array.isArray(item.compatibility?.tags) ? item.compatibility.tags : [];
    const packageToken = item.id || item.name || item.packageName || '';
    const isSelected = selectedValues ? selectedValues.has(packageToken) || selectedValues.has(item.packageName || '') : false;
    const previewTags = [
      ...featureTypes.map(getFeatureTypeLabel),
      ...compatibilityTags.map(getCompatibilityTagLabel),
    ];

    return [
      '<article class="workspace-repo-card" role="button" tabindex="0" data-feature-repo-package-id="' + escapeHtml(item.id) + '" onclick="window.openRepositoryPackageDetails(&quot;' + escapeHtml(item.id) + '&quot;)" title="' + escapeHtml(getRepoLocaleText('查看详情', 'View Details')) + '">',
      '<div class="workspace-repo-head">',
      '<div class="workspace-repo-title-wrap">',
      '<div class="workspace-repo-title">' + escapeHtml(item.name || item.id) + '</div>',
      '<div class="workspace-repo-subtitle">' + escapeHtml(item.packageName || item.id) + '</div>',
      '</div>',
      '<div class="workspace-repo-badges">',
      '<span class="workspace-repo-badge ready">v' + escapeHtml(item.latestVersion || '-') + '</span>',
      item.source === 'official'
        ? '<span class="workspace-repo-badge ready">' + escapeHtml(getRepoLocaleText('官方', 'Official')) + '</span>'
        : '<span class="workspace-repo-badge" style="background:var(--surface);color:var(--text-secondary);">' + escapeHtml(getRepoLocaleText('自定义', 'Custom')) + '</span>',
      isSelected ? '<span class="workspace-repo-badge ready">' + escapeHtml(getRepoLocaleText('已挂载', 'Enabled')) + '</span>' : '',
      warnings.length > 0 ? '<span class="workspace-repo-badge warn">' + escapeHtml(getRepoLocaleText('存在警告', 'Warnings')) + '</span>' : '',
      '</div>',
      '</div>',
      item.description ? '<div class="workspace-repo-desc">' + escapeHtml(item.description) + '</div>' : '',
      '<div class="workspace-repo-preview">' + escapeHtml(getRepoLocaleText('归档', 'Archives')) + ': ' + escapeHtml(String(item.archiveCount || versions.length || 0)) + ' · ' + escapeHtml(getRepoLocaleText('更新', 'Updated')) + ': ' + escapeHtml(formatWorkspaceDate(item.updatedAt)) + '</div>',
      previewTags.length > 0 ? '<div class="workspace-tag-list">' + previewTags.map((tag) => '<span class="workspace-tag">' + escapeHtml(tag) + '</span>').join('') + '</div>' : '',
      (selectionFormId && selectionField)
        ? '<div class="workspace-repo-actions"><button class="workspace-action' + (isSelected ? ' secondary' : '') + '" type="button" onclick="event.stopPropagation(); window.toggleWorkspaceSelection(&quot;' + escapeHtml(selectionFormId) + '&quot;, &quot;' + escapeHtml(selectionField) + '&quot;, &quot;' + escapeHtml(packageToken) + '&quot;)">' + escapeHtml(isSelected ? getRepoLocaleText('停用', 'Disable') : getRepoLocaleText('启用', 'Enable')) + '</button></div>'
        : '',
      '</article>',
    ].join('');
  }).join('');

  const detailHtml = !selectedPackage ? '' : (() => {
    const versions = Array.isArray(selectedPackage.versions) ? selectedPackage.versions : [];
    const warnings = Array.isArray(selectedPackage.warnings) ? selectedPackage.warnings : [];
    const tags = Array.isArray(selectedPackage.tags) ? selectedPackage.tags : [];
    const featureTypes = Array.isArray(selectedPackage.featureTypes) ? selectedPackage.featureTypes : [];
    const compatibilityTags = Array.isArray(selectedPackage.compatibility?.tags) ? selectedPackage.compatibility.tags : [];
    const requirements = selectedPackage.requirements || {};
    const requirementTags = [
      ...(Array.isArray(requirements.platforms) ? requirements.platforms.map((value) => `${getRepoLocaleText('平台', 'Platform')}: ${value}`) : []),
      ...(requirements.node ? [`Node: ${requirements.node}`] : []),
      ...(Array.isArray(requirements.external) ? requirements.external.map((value) => `${getRepoLocaleText('外部资源', 'External')}: ${value}`) : []),
      ...(Array.isArray(requirements.services) ? requirements.services.map((value) => `${getRepoLocaleText('服务', 'Service')}: ${value}`) : []),
    ];
    const agentdevCompat = selectedPackage.agentdev && typeof selectedPackage.agentdev.compatible === 'string'
      ? selectedPackage.agentdev.compatible
      : '';
    const linksHtml = [
      renderRepoLink(selectedPackage.homepage, getRepoLocaleText('主页', 'Homepage')),
      renderRepoLink(selectedPackage.repository, getRepoLocaleText('仓库', 'Repository')),
    ].filter(Boolean).join('');
    const selectedToken = selectedPackage.id || selectedPackage.name || selectedPackage.packageName || '';
    const isSelected = selectedValues ? selectedValues.has(selectedToken) || selectedValues.has(selectedPackage.packageName || '') : false;

    return [
      '<div class="feature-detail-overlay">',
      '<div class="feature-detail-window">',
      '<div class="feature-detail-head">',
      '<div>',
      '<div class="feature-detail-title">' + escapeHtml(selectedPackage.name || selectedPackage.id) + '</div>',
      '<div class="feature-detail-subtitle">' + escapeHtml(selectedPackage.packageName || selectedPackage.id) + '</div>',
      '</div>',
      '<button class="feature-detail-close" type="button" title="' + escapeHtml(t('panel_close')) + '" onclick="window.closeRepositoryPackageDetails()">×</button>',
      '</div>',
      '<div class="feature-detail-stats">',
      '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(getRepoLocaleText('来源', 'Source')) + '</div><div class="feature-detail-stat-value">' + escapeHtml(selectedPackage.source === 'official' ? getRepoLocaleText('官方', 'Official') : getRepoLocaleText('自定义', 'Custom')) + '</div></div>',
      '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(getRepoLocaleText('最新版本', 'Latest')) + '</div><div class="feature-detail-stat-value">' + escapeHtml(selectedPackage.latestVersion || '-') + '</div></div>',
      '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(getRepoLocaleText('归档数', 'Archives')) + '</div><div class="feature-detail-stat-value">' + escapeHtml(String(selectedPackage.archiveCount || versions.length || 0)) + '</div></div>',
      '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(getRepoLocaleText('更新时间', 'Updated')) + '</div><div class="feature-detail-stat-value">' + escapeHtml(formatWorkspaceDate(selectedPackage.updatedAt)) + '</div></div>',
      '</div>',
      '<div class="feature-panel-section">',
      '<div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('详情', 'Details')) + '</div>',
      selectedPackage.description ? '<div class="feature-detail-subtitle">' + escapeHtml(selectedPackage.description) + '</div>' : '',
      agentdevCompat ? '<div class="workspace-form-note">AgentDev: ' + escapeHtml(agentdevCompat) + '</div>' : '',
      '</div>',
      featureTypes.length > 0 ? '<div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('Feature 类型', 'Feature Types')) + '</div><div class="workspace-tag-list">' + featureTypes.map((tag) => '<span class="workspace-tag">' + escapeHtml(getFeatureTypeLabel(tag)) + '</span>').join('') + '</div></div>' : '',
      '<div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('兼容性', 'Compatibility')) + '</div><div class="workspace-tag-list">' + compatibilityTags.map((tag) => '<span class="workspace-tag">' + escapeHtml(getCompatibilityTagLabel(tag)) + '</span>').join('') + '</div></div>',
      requirementTags.length > 0 ? '<div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('依赖摘要', 'Requirements')) + '</div><div class="workspace-tag-list">' + requirementTags.map((tag) => '<span class="workspace-tag">' + escapeHtml(tag) + '</span>').join('') + '</div></div>' : '',
      tags.length > 0 ? '<div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('标签', 'Tags')) + '</div><div class="workspace-tag-list">' + tags.map((tag) => '<span class="workspace-tag">' + escapeHtml(tag) + '</span>').join('') + '</div></div>' : '',
      versions.length > 0 ? '<div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('版本', 'Versions')) + '</div><div class="workspace-tag-list">' + versions.map((version) => '<span class="workspace-tag">' + escapeHtml(`v${version.version || '-'} · ${version.fileName}`) + '</span>').join('') + '</div></div>' : '',
      warnings.length > 0 ? '<div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('警告', 'Warnings')) + '</div><div class="workspace-repo-warning">' + warnings.map((warning) => escapeHtml(warning)).join('<br>') + '</div></div>' : '',
      (selectionFormId && selectionField)
        ? '<div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('装配动作', 'Assembly Action')) + '</div><div class="workspace-repo-actions"><button class="workspace-action' + (isSelected ? ' secondary' : '') + '" type="button" onclick="window.toggleWorkspaceSelection(&quot;' + escapeHtml(selectionFormId) + '&quot;, &quot;' + escapeHtml(selectionField) + '&quot;, &quot;' + escapeHtml(selectedToken) + '&quot;)">' + escapeHtml(isSelected ? getRepoLocaleText('从当前装配移除', 'Remove From Assembly') : getRepoLocaleText('挂到当前装配', 'Enable For Assembly')) + '</button></div></div>'
        : '',
      linksHtml ? '<div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('链接', 'Links')) + '</div><div class="workspace-repo-actions">' + linksHtml + '</div></div>' : '',
      '</div>',
      '</div>',
    ].join('');
  })();

  return [
    '<section class="workspace-section">',
    '<div class="workspace-section-header">',
    '<div>',
    '<div class="workspace-section-title">' + escapeHtml(title) + '</div>',
    '<div class="workspace-section-desc">' + escapeHtml(desc) + '</div>',
    '</div>',
    '</div>',
    '<div class="workspace-repo-summary">' + summaryHtml + '</div>',
    '<div class="assembly-source-tabs">',
    '<button class="assembly-source-tab' + (repoSourceFilter === 'all' ? ' active' : '') + '" type="button" onclick="window.setRepoSourceFilter(&quot;all&quot;)">' + escapeHtml(getRepoLocaleText('全部', 'All')) + ' (' + (officialCount + customCount) + ')</button>',
    '<button class="assembly-source-tab' + (repoSourceFilter === 'official' ? ' active' : '') + '" type="button" onclick="window.setRepoSourceFilter(&quot;official&quot;)">' + escapeHtml(getRepoLocaleText('官方', 'Official')) + ' (' + officialCount + ')</button>',
    '<button class="assembly-source-tab' + (repoSourceFilter === 'custom' ? ' active' : '') + '" type="button" onclick="window.setRepoSourceFilter(&quot;custom&quot;)">' + escapeHtml(getRepoLocaleText('自定义', 'Custom')) + ' (' + customCount + ')</button>',
    '</div>',
    '<div class="assembly-capability-topbar" style="margin-bottom:14px;">',
    '<input class="assembly-search-input" style="flex:1 1 280px;min-height:40px;" type="text" value="' + escapeHtml(repoSearchQuery) + '" placeholder="' + escapeHtml(getRepoLocaleText('按名称、说明或标签搜索', 'Search by name, description, or tags')) + '" oninput="repoSearchQuery=this.value.trim().toLowerCase()" onblur="window.setRepoSearchQuery(this.value)" onkeydown="if(event.key===&quot;Enter&quot;){event.preventDefault();window.setRepoSearchQuery(this.value);}" >',
    '<button class="workspace-action" type="button" onclick="window.openFeatureUploadDialog()">' + escapeHtml(getRepoLocaleText('上传 tgz', 'Upload tgz')) + '</button>',
    '</div>',
    '<div class="workspace-repo-list">' + packagesHtml + '</div>',
    detailHtml,
    '</section>',
  ].join('');
}

// ═══════════════════════════════════════════════════════════════
// Assembly Workbench 入口
// ═══════════════════════════════════════════════════════════════

function renderAssemblyWorkbenchBlock(agent, block) {
  return renderAssemblyWorkbenchStageFlow(agent, block);
}
