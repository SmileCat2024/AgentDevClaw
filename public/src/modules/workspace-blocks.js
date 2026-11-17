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
 * ESM（P2 W2-10 装配工作台与表面块批次）：语言 / 转义 / 时间格式 / 渲染与
 * 会话存储状态显式 import；批内模块（assembly-data / assembly-actions /
 * feature-config / fw-config-panel / workspace-docset）与已迁的 debug 面板族
 * （debug-overview / debug-summary-upload）与 project-data 数据面一律 import。
 * 仍为 classic 的宿主函数（app-core / app-main / app-ui / im-ui）经 window
 * 晚绑定并注明收敛批次。
 *
 * 排期边界（R1/R4 审计结论）：本文件全部渲染入口只经 app-ui 的
 * `ClawHost.blocks.registerPrimitive` 闭包调用，而闭包只有存在 agent 与
 * workspace ui 数据时才会被执行；首屏 `applyTheme/applyLanguage → applyLanguage
 * → renderCurrentMainView`（app-main 顶层）在 allAgents 为空时走空态分支，
 * 不触达这些函数。因此注册相位取 ESM 相（本模块顶层）。
 */

import { getCurrentLanguage } from './i18n-environment-state.js';
import { escapeHtml } from './markdown-utils.js';
import { formatWorkspaceDate } from './time-format-host.js';
import { currentWorkspaceTab, setShouldAnimateWorkspaceSurface } from './render-entry-state.js';
import { currentMessages } from './session-view-storage.js';
import { debugPanel } from './p2-bootstrap-debug-panel.js';
import {
  getWorkspaceFormDraft,
  saveWorkspaceFormDraft,
  persistWorkspaceState,
  getFeatureCreatorOutputDirectory,
  getAssemblyDisplayName,
} from './assembly-data.js';
import {
  canonicalizeAssemblyFeatureSelection,
  updateWorkspaceFormDraft,
  chooseWorkspaceDirectory,
  toggleWorkspaceSelection,
  saveWorkspaceForm,
  resetWorkspaceForm,
} from './assembly-actions.js';
import { getWorkspaceSessions } from './session-ui.js';
import {
  getFeatureCreatorProjects,
  getAgentCreatorProjects,
  getAgentWorkspaceState,
  canEnterWorkspaceChat,
} from './project-data.js';
import {
  setRepoSearchQuery,
  setRepoSourceFilter,
  openFeatureUploadDialog,
} from './debug-summary-upload.js';
import {
  openRepositoryPackageDetails,
  closeRepositoryPackageDetails,
} from './debug-overview.js';

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
  if (typeof visibility === 'string' && visibility.startsWith('block:')) {
    return currentWorkspaceTab === visibility;
  }
  if (visibility !== 'focus') return true;
  return currentWorkspaceTab === `block:${block.id}`;
}

function renderActionButton(action, options = {}) {
  const label = window.localizeWorkspaceValue(action?.label, '');
  const encoded = escapeHtml(JSON.stringify(action?.action || {}));
  const btnClass = options.className || 'workspace-action';
  return '<button class="' + escapeHtml(btnClass) + '" type="button" data-workspace-action="' + encoded + '" data-action="wsBlocks.workspaceAction"' + (options.disabled ? ' disabled' : '') + '>' + escapeHtml(label) + '</button>';
}

function renderWorkspaceHero(agent, block) {
  const title = window.localizeWorkspaceValue(block.title, agent.name || agent.id);
  const body = window.localizeWorkspaceValue(block.body, agent.description || '');
  // bar 变体：codex 登录卡片同款紧凑横排（左标题说明 / 右按钮组），
  // 由 CSS .workspace-hero.bar 定形；声明驱动，不按 agent id 分支
  const heroClass = agent?.id === 'home'
    ? 'workspace-hero home-shell'
    : 'workspace-hero' + (block?.variant === 'bar' ? ' bar' : '');
  const isIM = agent?.id === 'qqbot';
  const actionsHtml = isIM
    ? '<div class="workspace-hero-actions"><button class="ph-banner-btn secondary im-channel-config-btn" type="button" data-action="wsBlocks.openIMChannelConfig">' + (getCurrentLanguage() === 'zh' ? '配置渠道' : 'Channel Config') + '</button></div>'
    : (Array.isArray(block?.actions) && block.actions.length > 0
      ? '<div class="workspace-hero-actions">' + block.actions.map((action) => renderActionButton(action, {
        className: action?.className
          || (agent?.id === 'agent-studio' ? 'ph-banner-btn ph-new-chat-btn' : undefined),
      })).join('') + '</div>'
      : '');
  return [
    '<section class="' + heroClass + (actionsHtml ? ' has-actions' : '') + '">',
    '<div class="workspace-hero-main">',
    '<div class="workspace-kicker">' + escapeHtml(window.localizeWorkspaceValue(block.kicker, window.t('workspace_kicker'))) + '</div>',
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

/**
 * 宿主首页的 Coder 入口 block 已随 coder 升格独立工作空间移除
 * （ADR-0025 收尾）：coder 的呈现归侧栏 on-demand 条目与设置面板，
 * 宿主首页不再重复入口。
 */

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
      const title = window.localizeWorkspaceValue(card.title, '');
      const body = window.localizeWorkspaceValue(card.body, '');
      const note = window.localizeWorkspaceValue(card.note, '');
      const actionLabel = window.localizeWorkspaceValue(card.actionLabel, '');
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
        '<button class="workspace-action" type="button" data-workspace-action="' + action + '" data-action="wsBlocks.workspaceAction"' + (disabled ? ' disabled' : '') + '>' + escapeHtml(actionLabel) + '</button>',
        '</div>',
      ].join('');
    }).join(''),
    '</section>',
  ].join('');
}


function renderWorkspaceField(agent, field, draft, formId) {
  const name = String(field.name || '').trim();
  if (!name) return '';

  const label = window.localizeWorkspaceValue(field.label, name);
  const placeholder = window.localizeWorkspaceValue(field.placeholder, '');
  const value = draft[name] ?? '';
  const escapedName = escapeHtml(name);
  const escapedLabel = escapeHtml(label);
  const escapedPlaceholder = escapeHtml(placeholder);
  const escapedValue = escapeHtml(String(value));

  if (field.type === 'textarea') {
    return [
      '<label class="workspace-form-field">',
      '<span class="workspace-form-label">' + escapedLabel + '</span>',
      '<textarea class="workspace-form-textarea" placeholder="' + escapedPlaceholder + '" data-action="wsBlocks.formDraft" data-event="input" data-form-id="' + escapeHtml(formId) + '" data-field-name="' + escapedName + '">' + escapedValue + '</textarea>',
      '</label>',
    ].join('');
  }

  if (field.type === 'select') {
    const options = Array.isArray(field.options) ? field.options : [];
    const optionsHtml = options.map((option) => {
      const optionValue = typeof option === 'string' ? option : String(option?.value ?? '');
      const optionLabel = typeof option === 'string' ? option : window.localizeWorkspaceValue(option?.label, optionValue);
      const selected = String(value) === optionValue ? ' selected' : '';
      return '<option value="' + escapeHtml(optionValue) + '"' + selected + '>' + escapeHtml(optionLabel) + '</option>';
    }).join('');
    return [
      '<label class="workspace-form-field">',
      '<span class="workspace-form-label">' + escapedLabel + '</span>',
      '<select class="workspace-form-select" data-action="wsBlocks.formDraft" data-event="change" data-form-id="' + escapeHtml(formId) + '" data-field-name="' + escapedName + '">',
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
        '<input class="workspace-form-input" type="text" value="' + escapeHtml(displayedValue || window.t('workspace_directory_not_selected')) + '" readonly data-workspace-form-display="' + escapeHtml(formId + ':' + escapedName) + '">',
        '<button class="workspace-action" type="button" data-action="wsBlocks.chooseDirectory" data-form-id="' + escapeHtml(formId) + '" data-field-name="' + escapedName + '">' + escapeHtml(window.t('workspace_pick_directory')) + '</button>',
        '</div>',
        '<div class="workspace-form-note">' + escapeHtml(window.t('workspace_pick_directory_hint')) + '</div>',
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
        '<input class="workspace-form-input" type="text" value="' + escapeHtml(displayedValue || window.t('workspace_directory_not_selected')) + '" readonly data-workspace-form-display="' + escapeHtml(formId + ':' + escapedName) + '">',
        '<button class="workspace-action" type="button" data-action="wsBlocks.chooseDirectory" data-form-id="' + escapeHtml(formId) + '" data-field-name="' + escapedName + '">' + escapeHtml(window.t('workspace_pick_directory')) + '</button>',
        '</div>',
        '<div class="workspace-form-note">' + escapeHtml(window.t('workspace_pick_directory_hint')) + '</div>',
        outputDir ? '<div class="workspace-form-note" data-workspace-output-note="' + escapeHtml(formId) + '">' + escapeHtml(window.t('feature_creator_output_dir')) + ': ' + escapeHtml(outputDir) + '</div>' : '',
        '</label>',
      ].join('');
    }
    return [
      '<label class="workspace-form-field">',
      '<span class="workspace-form-label">' + escapedLabel + '</span>',
      '<input class="workspace-form-input" type="text" value="' + escapeHtml(displayedValue || window.t('workspace_directory_not_selected')) + '" readonly data-workspace-form-display="' + escapeHtml(formId + ':' + escapedName) + '">',
      '<div class="workspace-form-note">' + escapeHtml(window.t('workspace_install_mode_system')) + '</div>',
      outputDir ? '<div class="workspace-form-note" data-workspace-output-note="' + escapeHtml(formId) + '">' + escapeHtml(window.t('feature_creator_output_dir')) + ': ' + escapeHtml(outputDir) + '</div>' : '',
      '</label>',
    ].join('');
  }

  return [
    '<label class="workspace-form-field">',
    '<span class="workspace-form-label">' + escapedLabel + '</span>',
    '<input class="workspace-form-input" type="' + escapeHtml(field.type || 'text') + '" value="' + escapedValue + '" placeholder="' + escapedPlaceholder + '" data-action="wsBlocks.formDraft" data-event="input" data-form-id="' + escapeHtml(formId) + '" data-field-name="' + escapedName + '">',
    '</label>',
  ].join('');
}

function renderWorkspaceForm(agent, block) {
  const title = window.localizeWorkspaceValue(block.title, window.t('workspace_tab_form'));
  const desc = window.localizeWorkspaceValue(block.description, '');
  const fields = Array.isArray(block.fields) ? block.fields : [];
  const formId = block.id || 'form';
  if (fields.length === 0) {
    return '<section class="workspace-section"><div class="workspace-section-title">' + escapeHtml(window.t('workspace_form_empty')) + '</div></section>';
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
    '<button class="workspace-action" type="button" data-workspace-form-id="' + escapeHtml(formId) + '" data-workspace-submit-action="' + submitAction + '" data-action="wsBlocks.saveForm">' + escapeHtml(window.t('workspace_form_save')) + '</button>',
    '<button class="workspace-action" type="button" data-workspace-form-id="' + escapeHtml(formId) + '" data-action="wsBlocks.resetForm">' + escapeHtml(window.t('workspace_form_reset')) + '</button>',
    '</div>',
    '</div>',
    '<div class="workspace-form-note">' + escapeHtml(window.t('workspace_form_saved')) + '</div>',
    '</div>',
    '</section>',
  ].join('');
}


function renderFlowEditorBlock(agent, block) {
  if (window.ClawFlowEditor && typeof window.ClawFlowEditor.renderBlock === 'function') {
    return window.ClawFlowEditor.renderBlock(agent, block, {
      // Flow 编辑器仍为 classic（public/flow-editor.js），经注入面取宿主能力：
      // 语言给现值（原 currentLanguage 词法读取），其余 classic 函数经 window 晚绑定。
      currentLanguage: getCurrentLanguage(),
      escapeHtml,
      localizeWorkspaceValue: window.localizeWorkspaceValue, // 桥接期：定义于 app-core（i18n 域收敛）
      getCurrentAgentRecord: window.getCurrentAgentRecord,   // 桥接期：定义于 app-main（编排域收敛）
      getWorkspaceFormDraft,
      saveWorkspaceFormDraft,
      persistWorkspaceState,
      renderCurrentMainView: window.renderCurrentMainView,   // 桥接期：定义于 app-ui（渲染入口域收敛）
      updateAgentWorkspaceState,
      getAgentWorkspaceState,
    });
  }
  const title = window.localizeWorkspaceValue(block.title, getCurrentLanguage() === 'zh' ? '编排' : 'Flows');
  return [
    '<section class="assembly-intro">',
    '<div class="workspace-section-title">' + escapeHtml(title) + '</div>',
    '<div class="assembly-workbench-note">' + escapeHtml(getCurrentLanguage() === 'zh' ? 'Flow 编辑器资源正在加载。' : 'Flow editor assets are loading.') + '</div>',
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

  const title = window.localizeWorkspaceValue(block?.directorySummary?.title, '目录概览');
  const pathLabel = window.localizeWorkspaceValue(block?.directorySummary?.pathLabel, '目录路径');
  const updatedLabel = window.localizeWorkspaceValue(block?.directorySummary?.updatedLabel, '最后变更');
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
  const title = window.localizeWorkspaceValue(block.title, window.t('workspace_tab_live'));
  const desc = window.localizeWorkspaceValue(block.description, agent?.description || '');
  const sessions = getWorkspaceSessions(agent);
  const summary = sessions.find((session) => session.id === (agent?.active_workspace_session_id || agent?.workspace_sessions?.activeSessionId)) || sessions[0] || null;
  const connected = agent ? (agent.connected !== false ? window.t('status_connected') : window.t('status_disconnected')) : window.t('status_no_agent');
  const imDraft = window.getIMWorkspaceDraft();
  const directorySummary = getDirectorySummaryData(agent, block);
  const canOpenChat = canEnterWorkspaceChat(agent);
  const cardsHtml = [
    { label: window.t('workspace_live_status'), value: connected, note: agent?.status || '-' },
    { label: window.t('workspace_live_runtime'), value: agent?.runtime_session_id || agent?.runtimeSessionId || '-', note: agent?.pid ? `PID ${agent.pid}` : '-' },
    { label: window.t('workspace_live_pending'), value: String(agent?.pending_input_count ?? 0), note: String(agent?.message_count ?? currentMessages.length ?? 0) + ' ' + window.t('feature_messages') },
    { label: window.t('workspace_live_session'), value: summary ? (summary.title || summary.id || '-') : window.t('workspace_history_empty'), note: summary?.updatedAt ? formatWorkspaceDate(summary.updatedAt) : '-' },
    directorySummary
      ? {
          label: window.localizeWorkspaceValue(block?.directorySummary?.countLabel, 'Skills'),
          value: String(directorySummary.skillCount ?? 0),
          note: directorySummary.exists
            ? `${window.localizeWorkspaceValue(block?.directorySummary?.countNote, 'Entries')}: ${directorySummary.entryCount ?? 0}`
            : (directorySummary.error || 'Not ready'),
        }
      : null,
    window.isIMWorkspaceConfigEditor(block)
      ? (function () {
          // 门户渠道 = 接线员线路的 carrier（ADR-0042 决策 1）。旧实现按
          // selectedChannel 分支，该字段归一后恒不存在——卡片会永远落到
          // 「QQ」分支，无论用户实际接的是哪个渠道。
          const portalCarrier = window.imPortalCarrierOf(imDraft);
          const carrierLabel = portalCarrier
            ? (imDraft.workspaceConfig?.channels?.[portalCarrier]?.label
                || window.imChannelLabel(portalCarrier))
            : '';
          return {
            label: window.t('workspace_live_config'),
            value: portalCarrier
              ? window.imChannelConfigured(imDraft, portalCarrier)
                ? window.t('im_workspace_bound')
                : window.t('im_workspace_not_bound')
              : window.t('im_workspace_not_bound'),
            note: carrierLabel
              || imDraft.workspaceConfig?.channels?.qq?.label
              || window.t('im_workspace_qq_section'),
          };
        })()
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
    '<button class="workspace-action" type="button" data-workspace-action="{&quot;type&quot;:&quot;show_chat&quot;}" data-action="wsBlocks.workspaceAction"' + (canOpenChat ? '' : ' disabled') + '>' + escapeHtml(window.t('workspace_open_chat')) + '</button>',
    '</div>',
    '<div class="workspace-grid">' + cardsHtml + '</div>',
    directorySummary ? renderDirectorySummaryPanel(agent, block) : '',
    window.isIMWorkspaceConfigEditor(block) ? window.renderIMWorkspaceConfigEditor(block) : '',
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
  return getCurrentLanguage() === 'zh' ? zh : en;
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
    'general-chatbot': getCurrentLanguage() === 'zh' ? '通用对话助手' : 'General Chatbot',
    'tool-operator': getCurrentLanguage() === 'zh' ? '工具执行助手' : 'Tool Operator',
    'workflow-assistant': getCurrentLanguage() === 'zh' ? '工作流推进助手' : 'Workflow Assistant',
  };
  return map[value] || value || (getCurrentLanguage() === 'zh' ? '未设置' : 'Unset');
}

function getAssemblyPresetDescription(value) {
  const map = {
    'general-chatbot': getCurrentLanguage() === 'zh'
      ? '偏向通用对话体验，强调基础能力完整和上手速度。'
      : 'Optimized for a general chat experience with balanced baseline capabilities.',
    'tool-operator': getCurrentLanguage() === 'zh'
      ? '偏向联网、执行和观察类能力，适合操作型助手。'
      : 'Optimized for web, execution, and observation capabilities for operator-style assistants.',
    'workflow-assistant': getCurrentLanguage() === 'zh'
      ? '偏向任务推进、控制和过程组织，适合持续跟进型 Agent。'
      : 'Optimized for task progression, control, and process organization.',
  };
  return map[value] || '';
}

const ASSEMBLY_PRESET_FEATURES = {
  'general-chatbot': ['websearch-feature', 'memory-feature'],
  'tool-operator': ['shell-feature', 'lsp-feature', 'websearch-feature'],
  'workflow-assistant': ['memory-feature', 'plugin-compat-feature'],
};

const ASSEMBLY_BUNDLE_FEATURES = {
  'web-retrieval': ['websearch-feature', 'visual-feature'],
  'memory-copilot': ['memory-feature'],
  'dev-operator': ['shell-feature', 'lsp-feature', 'websearch-feature'],
};

function applyAssemblyPreset(formId, presetKey) {
  const agent = window.getCurrentAgentRecord();
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
  setShouldAnimateWorkspaceSurface(false);
  window.renderCurrentMainView(); // 桥接期：定义于 app-ui（渲染入口域收敛）
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

function setBundleFilter(formId, bundleKey) {
  const agent = window.getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  draft[formId] = draft[formId] || {};
  const currentFilter = draft[formId].bundle_filter || '';
  draft[formId].bundle_filter = currentFilter === bundleKey ? '' : bundleKey;
  saveWorkspaceFormDraft(agent.id, draft);
  setShouldAnimateWorkspaceSurface(false);
  window.renderCurrentMainView(); // 桥接期：定义于 app-ui（渲染入口域收敛）
};

function getAssemblyStageLabel(value) {
  const map = {
    goal: getCurrentLanguage() === 'zh' ? '定义目标 Agent' : 'Define Target Agent',
    capabilities: getCurrentLanguage() === 'zh' ? '选择能力' : 'Choose Capabilities',
    environment: getCurrentLanguage() === 'zh' ? '环境准备' : 'Environment Setup',
    review: getCurrentLanguage() === 'zh' ? '确认与启动' : 'Review And Launch',
  };
  return map[value] || value || '';
}

function formatAssemblyFeatureToken(value) {
  return String(value || '')
    .trim()
    .replace(/^@agentdevjs\//, '')
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
  const assemblyName = getAssemblyDisplayName(form) || (getCurrentLanguage() === 'zh' ? '未命名 Agent' : 'Untitled Agent');
  const preset = String(form?.preset || 'general-chatbot').trim();
  const goal = String(form?.goal || '').trim();
  const selectedFeatures = parseWorkspaceListField(form?.selected_features)
    .map((item) => getAssemblyFeatureLabel(item, packages))
    .filter(Boolean);

  const sections = [
    getCurrentLanguage() === 'zh'
      ? `你是一个已经装配完成并直接面对最终用户的聊天 Agent。\n你的名称是：${assemblyName}。`
      : `You are a chat agent that has already been assembled and now speaks directly to the end user.\nYour name is: ${assemblyName}.`,
    getCurrentLanguage() === 'zh'
      ? `预设定位：${getAssemblyPresetLabel(preset)}。${getAssemblyPresetDescription(preset)}`
      : `Preset: ${getAssemblyPresetLabel(preset)}. ${getAssemblyPresetDescription(preset)}`,
  ];

  if (goal) {
    sections.push(getCurrentLanguage() === 'zh' ? `主要目标：${goal}` : `Primary goal: ${goal}`);
  }
  if (selectedFeatures.length > 0) {
    sections.push((getCurrentLanguage() === 'zh' ? '当前已启用能力：' : 'Enabled capabilities: ') + selectedFeatures.join(getCurrentLanguage() === 'zh' ? '、' : ', '));
  }
  sections.push(getCurrentLanguage() === 'zh'
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
    ability: getRepoLocaleText('能力', 'Ability'),
    governance: getRepoLocaleText('治理', 'Governance'),
    interface: getRepoLocaleText('接口', 'Interface'),
    system: getRepoLocaleText('系统', 'System'),
  };
  return map[value] || value;
}

function getFeatureCapabilityLabel(value) {
  const map = {
    tools: 'Tools',
    policy: getRepoLocaleText('策略钩子', 'Policy hooks'),
    commands: getRepoLocaleText('命令', 'Commands'),
    skills: 'Skills',
    mcp: 'MCP',
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
  const title = window.localizeWorkspaceValue(block.title, getRepoLocaleText('插件仓库', 'Plugin Repository'));
  const desc = window.localizeWorkspaceValue(block.description, '');
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
      if (debugPanel.repoSourceFilter === 'official') return item.source === 'official';
      if (debugPanel.repoSourceFilter === 'custom') return item.source === 'custom';
      return true;
    })
    .filter((item) => {
      if (!debugPanel.repoSearchQuery) return true;
      const haystack = [
        item?.name,
        item?.id,
        item?.packageName,
        item?.description,
        ...(Array.isArray(item?.featureTypes) ? item.featureTypes : []),
        ...(Array.isArray(item?.tags) ? item.tags : []),
      ].join(' ').toLowerCase();
      return haystack.includes(debugPanel.repoSearchQuery);
    });

  const selectedPackage = packages.find((item) => item.id === debugPanel.selectedRepositoryPackageId) || null;
  if (debugPanel.selectedRepositoryPackageId && !selectedPackage) {
    debugPanel.selectedRepositoryPackageId = null;
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
      '<article class="workspace-repo-card" role="button" tabindex="0" data-feature-repo-package-id="' + escapeHtml(item.id) + '" data-action="wsBlocks.repoDetails" data-package-id="' + escapeHtml(item.id) + '" title="' + escapeHtml(getRepoLocaleText('查看详情', 'View Details')) + '">',
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
        ? '<div class="workspace-repo-actions"><button class="workspace-action' + (isSelected ? ' secondary' : '') + '" type="button" data-action="wsBlocks.toggleSelection" data-selection-form-id="' + escapeHtml(selectionFormId) + '" data-selection-field="' + escapeHtml(selectionField) + '" data-selection-token="' + escapeHtml(packageToken) + '">' + escapeHtml(isSelected ? getRepoLocaleText('停用', 'Disable') : getRepoLocaleText('启用', 'Enable')) + '</button></div>'
        : '',
      '</article>',
    ].join('');
  }).join('');

  const detailHtml = !selectedPackage ? '' : (() => {
    const versions = Array.isArray(selectedPackage.versions) ? selectedPackage.versions : [];
    const warnings = Array.isArray(selectedPackage.warnings) ? selectedPackage.warnings : [];
    const tags = Array.isArray(selectedPackage.tags) ? selectedPackage.tags : [];
    const featureTypes = Array.isArray(selectedPackage.featureTypes) ? selectedPackage.featureTypes : [];
    const capabilities = Array.isArray(selectedPackage.capabilities) ? selectedPackage.capabilities : [];
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
      '<div class="feature-detail-overlay" role="presentation" data-action="wsBlocks.repoDetailsClose">',
      '<div class="feature-detail-window" role="dialog" aria-modal="true">',
      '<div class="feature-detail-head">',
      '<div>',
      '<div class="feature-detail-title">' + escapeHtml(selectedPackage.name || selectedPackage.id) + '</div>',
      '<div class="feature-detail-subtitle">' + escapeHtml(selectedPackage.packageName || selectedPackage.id) + '</div>',
      '</div>',
      '<button class="feature-detail-close" type="button" title="' + escapeHtml(window.t('panel_close')) + '" data-action="wsBlocks.repoDetailsCloseBtn">×</button>',
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
      featureTypes.length > 0 ? '<div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('功能类型', 'Feature Type')) + '</div><div class="workspace-tag-list">' + featureTypes.map((tag) => '<span class="workspace-tag">' + escapeHtml(getFeatureTypeLabel(tag)) + '</span>').join('') + '</div></div>' : '',
      capabilities.length > 0 ? '<div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('能力', 'Capabilities')) + '</div><div class="workspace-tag-list">' + capabilities.map((tag) => '<span class="workspace-tag">' + escapeHtml(getFeatureCapabilityLabel(tag)) + '</span>').join('') + '</div></div>' : '',
      '<div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('兼容性', 'Compatibility')) + '</div><div class="workspace-tag-list">' + compatibilityTags.map((tag) => '<span class="workspace-tag">' + escapeHtml(getCompatibilityTagLabel(tag)) + '</span>').join('') + '</div></div>',
      selectedPackage.provides ? '<div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('提供内容', 'Provides')) + '</div><div class="workspace-tag-list">' + [...(selectedPackage.provides.tools || []), ...(selectedPackage.provides.skills || []), ...(selectedPackage.provides.commands || [])].map((item) => '<span class="workspace-tag">' + escapeHtml(item) + '</span>').join('') + (selectedPackage.provides.hooks ? '<span class="workspace-tag">Hooks</span>' : '') + (selectedPackage.provides.mcp ? '<span class="workspace-tag">MCP</span>' : '') + '</div></div>' : '',
      Array.isArray(selectedPackage.depends) && selectedPackage.depends.length > 0 ? '<div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('Feature 依赖', 'Feature Dependencies')) + '</div><div class="workspace-tag-list">' + selectedPackage.depends.map((dependency) => '<span class="workspace-tag">' + escapeHtml(dependency.id) + ' (' + escapeHtml(dependency.range) + ')</span>').join('') + '</div></div>' : '',
      selectedPackage.manifestPresent === false ? '<div class="workspace-repo-warning">' + escapeHtml(getRepoLocaleText('该包缺少完整 Feature 元数据；当前仅使用有限推断。', 'This package is missing complete Feature metadata; only limited inference is available.')) + '</div>' : '',
      requirementTags.length > 0 ? '<div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('依赖摘要', 'Requirements')) + '</div><div class="workspace-tag-list">' + requirementTags.map((tag) => '<span class="workspace-tag">' + escapeHtml(tag) + '</span>').join('') + '</div></div>' : '',
      tags.length > 0 ? '<div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('标签', 'Tags')) + '</div><div class="workspace-tag-list">' + tags.map((tag) => '<span class="workspace-tag">' + escapeHtml(tag) + '</span>').join('') + '</div></div>' : '',
      versions.length > 0 ? '<div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('版本', 'Versions')) + '</div><div class="workspace-tag-list">' + versions.map((version) => '<span class="workspace-tag">' + escapeHtml(`v${version.version || '-'} · ${version.fileName}`) + '</span>').join('') + '</div></div>' : '',
      warnings.length > 0 ? '<div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('警告', 'Warnings')) + '</div><div class="workspace-repo-warning">' + warnings.map((warning) => escapeHtml(warning)).join('<br>') + '</div></div>' : '',
      (selectionFormId && selectionField)
        ? '<div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('装配动作', 'Assembly Action')) + '</div><div class="workspace-repo-actions"><button class="workspace-action' + (isSelected ? ' secondary' : '') + '" type="button" data-action="wsBlocks.toggleSelection" data-selection-form-id="' + escapeHtml(selectionFormId) + '" data-selection-field="' + escapeHtml(selectionField) + '" data-selection-token="' + escapeHtml(selectedToken) + '">' + escapeHtml(isSelected ? getRepoLocaleText('从当前装配移除', 'Remove From Assembly') : getRepoLocaleText('挂到当前装配', 'Enable For Assembly')) + '</button></div></div>'
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
    '<button class="assembly-source-tab' + (debugPanel.repoSourceFilter === 'all' ? ' active' : '') + '" type="button" data-action="wsBlocks.repoFilter" data-source="all">' + escapeHtml(getRepoLocaleText('全部', 'All')) + ' (' + (officialCount + customCount) + ')</button>',
    '<button class="assembly-source-tab' + (debugPanel.repoSourceFilter === 'official' ? ' active' : '') + '" type="button" data-action="wsBlocks.repoFilter" data-source="official">' + escapeHtml(getRepoLocaleText('官方', 'Official')) + ' (' + officialCount + ')</button>',
    '<button class="assembly-source-tab' + (debugPanel.repoSourceFilter === 'custom' ? ' active' : '') + '" type="button" data-action="wsBlocks.repoFilter" data-source="custom">' + escapeHtml(getRepoLocaleText('自定义', 'Custom')) + ' (' + customCount + ')</button>',
    '</div>',
    '<div class="assembly-capability-topbar" style="margin-bottom:14px;">',
    '<input class="assembly-search-input" style="flex:1 1 280px;min-height:40px;" type="text" value="' + escapeHtml(debugPanel.repoSearchQuery) + '" placeholder="' + escapeHtml(getRepoLocaleText('按名称、说明或标签搜索', 'Search by name, description, or tags')) + '" data-action="wsBlocks.repoSearch" data-event="input keydown focusout" >',
    '<button class="workspace-action" type="button" data-action="wsBlocks.openFeatureUpload">' + escapeHtml(getRepoLocaleText('上传 tgz', 'Upload tgz')) + '</button>',
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
  return window.renderAssemblyWorkbenchStageFlow(agent, block);
}

// 工作空间表单与功能仓库动作（原内联 onclick/oninput/onchange/onblur/onkeydown，统一经分发器）。
// 跨模块函数仍经 window 转调：定义域在 app-main / app-ui / debug-overview / im-actions，
// 随各自模块的批次收敛。
window.ClawFW.actions.registerMany({
  'wsBlocks.workspaceAction': (el) => window.runWorkspaceAction(el.dataset.workspaceAction, el),
  'wsBlocks.openIMChannelConfig': () => window.openIMChannelConfig(),
  'wsBlocks.formDraft': (el) => updateWorkspaceFormDraft(el.dataset.formId, el.dataset.fieldName, el.value),
  'wsBlocks.chooseDirectory': (el) => chooseWorkspaceDirectory(el.dataset.formId, el.dataset.fieldName),
  'wsBlocks.saveForm': (el) => saveWorkspaceForm(el.dataset.workspaceFormId, el.dataset.workspaceSubmitAction),
  'wsBlocks.resetForm': (el) => resetWorkspaceForm(el.dataset.workspaceFormId),
  'wsBlocks.repoDetails': (el) => openRepositoryPackageDetails(el.dataset.packageId),
  'wsBlocks.toggleSelection': (el) => toggleWorkspaceSelection(el.dataset.selectionFormId, el.dataset.selectionField, el.dataset.selectionToken),
  'wsBlocks.repoDetailsClose': (el, event) => {
    // 原 overlay 内联守卫：仅点击背景自身时关闭，内部内容冒泡不触发。
    if (event.target === el) closeRepositoryPackageDetails();
  },
  'wsBlocks.repoDetailsCloseBtn': () => closeRepositoryPackageDetails(),
  'wsBlocks.repoFilter': (el) => setRepoSourceFilter(el.dataset.source),
  'wsBlocks.repoSearch': (el, event) => {
    // 输入即时过滤（写 app-core 全局过滤词）；Enter 与失焦提交（经 setter 触发重渲染）。
    if (event.type === 'keydown') {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      setRepoSearchQuery(el.value);
      return;
    }
    if (event.type === 'focusout') { setRepoSearchQuery(el.value); return; }
    debugPanel.repoSearchQuery = el.value.trim().toLowerCase();
  },
  'wsBlocks.openFeatureUpload': () => openFeatureUploadDialog(),
});

// ── 兼容桥（classic 消费方收敛后注销）────────────────────────────────
// 消费面（grep public/src，排除本批文件）：
//   shouldRenderBlock —— app-ui（renderWorkspaceBlock / syncAppChatInputSlot /
//     refreshVisibleWorkspacePanelData 的 block 可见性判定）
//   renderWorkspaceHero / renderWorkspaceLauncherGrid / renderWorkspaceActionGroup /
//     renderWorkspaceForm / renderWorkspaceStatusGrid / renderFlowEditorBlock /
//     renderAssemblyWorkbenchBlock / renderFeatureRepositoryBlock —— app-ui 的
//     ClawHost.blocks.registerPrimitive 闭包（按 agent 数据渲染时调用）
//   getFeatureRepositoryData —— app-ui（FW 列表/详情读取仓库块数据）、claw-host（块刷新）
//   getRepoLocaleText —— app-ui（11 处渲染文案）、debug-summary-upload、ctx-menu-handlers
//   parseWorkspaceListField —— app-ui（装配草稿列表字段解析）；批内 assembly-data /
//     assembly-actions 已改 import
//   getAssemblyPresetLabel / getAssemblyPresetDescription / getAssemblyStageLabel /
//     getAssemblyFeatureLabel / buildAssemblyGeneratedPrompt / getAssemblyPromptValue /
//     getFeatureTypeLabel —— app-ui 的装配工作台与 FW 详情渲染
//   ASSEMBLY_PRESET_FEATURES / ASSEMBLY_BUNDLE_FEATURES —— app-ui（预设与打包卡片）
//   applyAssemblyPreset / setBundleFilter —— app-ui 的 assembly.* 动作注册
// 已 ESM 的消费方（不经桥）：session-list-render 的 renderActionButton 与
// isAssemblySession 均改为直接 import；本模块的 getWorkspaceSessions 亦改为
// import session-ui（不再 window 晚绑定）。
// 收敛条件：app-ui / claw-host / ctx-menu-handlers 迁入 ESM 后改为 import 本模块，
// 逐键注销。
const bridgeState = {
  shouldRenderBlock,
  renderWorkspaceHero,
  renderWorkspaceActionGroup,
  renderWorkspaceLauncherGrid,
  renderWorkspaceForm,
  renderFlowEditorBlock,
  renderWorkspaceStatusGrid,
  getFeatureRepositoryData,
  getRepoLocaleText,
  parseWorkspaceListField,
  getAssemblyPresetLabel,
  getAssemblyPresetDescription,
  ASSEMBLY_PRESET_FEATURES,
  ASSEMBLY_BUNDLE_FEATURES,
  applyAssemblyPreset,
  setBundleFilter,
  getAssemblyStageLabel,
  getAssemblyFeatureLabel,
  buildAssemblyGeneratedPrompt,
  getAssemblyPromptValue,
  getFeatureTypeLabel,
  renderFeatureRepositoryBlock,
  renderAssemblyWorkbenchBlock,
};
for (const [key, value] of Object.entries(bridgeState)) {
  window.KernelState.defineKey('workspace-blocks', key, value);
}
window.KernelState.claim('workspace-blocks', {
  get: (key) => bridgeState[key],
  set: (key, value) => { bridgeState[key] = value; },
});

// 命名导出面：跨文件消费的键（批内 import / classic 桥键）。纯渲染 helper
//（getDirectorySummaryData / renderDirectorySummaryPanel / normalizeRepoUrl /
// renderRepoLink / formatAssemblyFeatureToken / getFeatureCapabilityLabel /
// getCompatibilityTagLabel / getAssemblyFeaturePackageToken）零跨文件消费方，
// 保持模块私有。
export {
  shouldRenderBlock,
  renderActionButton,
  renderWorkspaceHero,
  renderWorkspaceActionGroup,
  renderWorkspaceLauncherGrid,
  renderWorkspaceField,
  renderWorkspaceForm,
  renderFlowEditorBlock,
  renderWorkspaceStatusGrid,
  getFeatureRepositoryData,
  getRepoLocaleText,
  parseWorkspaceListField,
  serializeWorkspaceListField,
  getAssemblyPresetLabel,
  getAssemblyPresetDescription,
  ASSEMBLY_PRESET_FEATURES,
  ASSEMBLY_BUNDLE_FEATURES,
  applyAssemblyPreset,
  setBundleFilter,
  getAssemblyStageLabel,
  getAssemblyFeatureLabel,
  buildAssemblyGeneratedPrompt,
  getAssemblyPromptValue,
  formatRepoFileSize,
  getFeatureTypeLabel,
  renderFeatureRepositoryBlock,
  renderAssemblyWorkbenchBlock,
};
