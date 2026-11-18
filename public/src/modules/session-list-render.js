/**
 * Session List Render 模块
 * 从 session-ui.js 拆出 (renderWorkspaceSessionList 按 agent 类型拆分)
 *
 * ESM 化：P2 W2-7（2026-11-17）。原位转换，渲染模板与行为零变化。
 *
 * 依赖（ESM，装载顺序由 import 图确定）：
 *   - session-ui：会话列表查询、徽标 / 标题 / token 渲染、开放会话卡片与
 *     _phOpenSessionsCache（live binding，读写同一对象）
 *   - time-format-host：相对时间 / 分组 / 紧凑时间标签
 *   - i18n-environment-state：实时语言；markdown-utils：escapeHtml
 *   - workspace-blocks：renderActionButton
 *   - model-preset-cache：getClawModelPresets；assembly-data：isAssemblySession
 *   - render-entry-state：setLastRenderedWorkspaceHtml（宿主渲染缓存失效）
 *   - session-reference-picker：SESSION_REF_MIME / setDragSource（拖拽引用源）
 *   - p2-bootstrap-ph-session：phSessionSortMode / phSearchQuery（owner 仍是
 *     app-core 的词法状态，经 classic 工厂适配）
 *
 * 已改直接 import（P2 兼容债收敛）：project-data 的项目 / 目录视图查询
 * （含 getAgentWorkspaceState / getPhBrowsingTarget / ensurePhProjectEntitiesLoaded）、
 * ph-project-actions / ph-session-list / ph-session-move 的动作入口。
 *
 * 仍 classic（调用时点显式 window 晚绑定，各域收敛时改 import）：
 *   - app-core 的 localizeWorkspaceValue；t（i18n.js）
 *   - app-ui / app-main 的 renderCurrentMainView；thread-store 的线程索引
 *   - workspace-actions 的动作入口（`window.runWorkspaceAction`）：生产方已 ESM
 *     并导出该函数，兼容桥因 classic claw-host / desktop-open 仍读而保留；ESM
 *     消费方改 import 属 workspace-actions 批的后续收敛，不在本批
 *
 * 桥接期兼容面（KernelState defineKey/claim，domain: session-list-render）：
 *   renderWorkspaceSessionList ← classic app-ui（ClawHost block 注册回调）
 *   onPhSessionDragStart        ← 本模块生成的条目内联 ondragstart 属性
 *   phConversationArchived     桥已注销（唯一消费方 workspace-actions 已验收为
 *                              ESM 并在文件头具名 import）
 *   （其余导出无 classic 消费面，只作命名导出，不上桥。）
 */

import { getCurrentLanguage } from './i18n-environment-state.js';
import { escapeHtml } from './markdown-utils.js';
import { formatWorkspaceDate, getSessionShortTime, getSessionRecencyClass, getTimeGroupLabel } from './time-format-host.js';
import {
  getWorkspaceSessions,
  sortPhSessionsByMode,
  renderSessionResumeBadge,
  renderSessionArchivedBadge,
  renderSessionTodoBadge,
  renderSessionTitleAiButton,
  renderSessionTokenBar,
  phLoadOpenSessionsCard,
  handleSessionTitleDoubleClick,
  _phOpenSessionsCache,
} from './session-ui.js';
import { renderActionButton } from './workspace-blocks.js';
import { getClawModelPresets } from './model-preset-cache.js';
import { isAssemblySession } from './assembly-data.js';
import { setLastRenderedWorkspaceHtml } from './render-entry-state.js';
import { SESSION_REF_MIME, setDragSource } from './session-reference-picker.js';
import { openThreadHistory } from './ph-thread-history.js';
import { phSessionUi } from './p2-bootstrap-ph-session.js';
import {
  phOpenSettings,
  phOpenProject,
  phLoadMoreSessions,
  phToggleProjectDropdown,
  phOpenNewProjectDialog,
  phToggleModelSlot,
  phOpenManageProjectsDialog,
  phSwitchProject,
} from './ph-project-actions.js';
import {
  phTopicPanelInnerHtml,
  switchPhSessionTab,
  phToggleSessionSort,
  _buildPhSearchPanelHtml,
  phOnSearchInput,
  phClearSearch,
  phShowSessionCtxMenu,
  getPhSurfaceViewProjectId,
  setPhSurfaceViewProjectId,
} from './ph-session-list.js';
import {
  phSessionMove,
  phSessionMoveSyncScope,
  phToggleSessionSelectMode,
  phToggleSessionSelection,
  phOpenSessionMoveDialog,
} from './ph-session-move.js';
import {
  getFeatureSessionDisplayName,
  getFeatureProjectDisplayName,
  getAgentProjectDisplayName,
  getPhDirectoryNavigationList,
  getPhCurrentDirectoryContext,
  getPhProjectsInDirectory,
  getPhProjectBoundDirectoryBucket,
  getProgrammingHelperProjects,
  getProgrammingHelperProjectDisplayName,
  getFeatureCreatorProjects,
  getAgentCreatorProjects,
  ensurePhProjectEntitiesLoaded,
  getAgentWorkspaceState,
  getPhBrowsingTarget,
} from './project-data.js';
import { localizeWorkspaceValue } from './format-utils.js';

// 桥接期：t 仍定义于 classic public/src/i18n.js（i18n 域收敛时改 import）。
// 经 window 晚绑定，不取加载期快照。
const t = (...args) => window.t(...args);

// ── Workspace Session List ───────────────────────────────────────

// ── 视图能力查询（R2-03）──────────────────────────────────────────
// UI 守卫统一经 window.RemoteConnections.capabilityFor 契约查询：
// ('write' | 'sessionOps' | 'workspaceCreate') → boolean；本地身份恒 true、
// 远程按握手能力、缺省 false。视图身份：本地 agent 用其 id；remoteOnly 项目
// 桶用会话数据层携带的宿主级命名空间 id（ADR-0012：身份来自数据层）。
// capabilityFor 未挂载（集成窗口）时退回命名空间判定——本地身份保持可见、
// 远程身份按缺省 false 隐藏；不引入伪能力位。
function viewCapabilityEnabled(identity, action) {
  const id = String(identity || '').trim();
  if (!id) return false;
  const capabilityFor = window.RemoteConnections?.capabilityFor;
  if (typeof capabilityFor === 'function') {
    return capabilityFor(id, action) === true;
  }
  return !window.isRemoteNamespaceAgentId(id);
}

// remoteOnly 项目桶的视图身份 = 桶内会话数据层携带的宿主级命名空间 id；
// 本地项目视图身份 = agent id。
function projectViewIdentity(agent, project) {
  if (project?.remoteOnly) {
    const sessions = Array.isArray(project.sessions) ? project.sessions : [];
    return String(sessions.find((session) => session?.remoteHostNsId)?.remoteHostNsId || '').trim();
  }
  return String(agent?.id || '').trim();
}

/**
 * 智能编码空间页面会话记录条目的拖拽源（→ 侧栏会话条目 / 输入框引用）：
 * dragstart 把会话身份写入 session-reference-picker 的专用 MIME。远程
 * 历史会话（remoteHostNsId，ADR-0012）渲染时不带 draggable；身份从条目
 * dataset 读取，sessionType 用 data-ref-session-type——data-session-type
 * 在归档 tab 存的是分区语义（'archived'），不是会话真实身份。
 */
function onPhSessionDragStart(event, el) {
  if (!event.dataTransfer) return;
  const sessionId = String(el?.dataset?.ctxId || '').trim();
  const agentId = String(el?.dataset?.ctxNs || '').trim();
  if (!sessionId || !agentId) { event.preventDefault(); return; }
  const titleEl = el?.querySelector?.('.workspace-history-title');
  const payload = {
    agentId,
    sessionId,
    sessionType: String(el?.dataset?.refSessionType || 'main').trim() || 'main',
    title: (titleEl?.textContent || '').trim(),
  };
  event.dataTransfer.setData(SESSION_REF_MIME, JSON.stringify(payload));
  event.dataTransfer.effectAllowed = 'copy';
  // 登记源身份：dragover 据此禁止把会话拖回它自己的侧栏条目
  setDragSource(payload);
}

function renderWorkspaceSessionList(agent, block) {
  const sessionFilters = block?.sessionList || {};
  const allowedFormIds = Array.isArray(sessionFilters.formIds)
    ? new Set(sessionFilters.formIds.map((item) => String(item || '').trim()).filter(Boolean))
    : null;
  const sessions = getWorkspaceSessions(agent).filter((session) => {
    if (!allowedFormIds) return true;
    return allowedFormIds.has(String(session?.formId || ''));
  });
  const isFeatureCreator = agent?.id === 'feature-creator';
  const isAgentCreator = agent?.id === 'agent-creator';
  const sessionListMode = String(sessionFilters.mode || '').trim();
  const activeSessionId = agent?.active_workspace_session_id || agent?.workspace_sessions?.activeSessionId || null;
  const title = localizeWorkspaceValue(block.title, t('workspace_history_current'));
  const desc = localizeWorkspaceValue(block.description, '');
  const headerAction = block?.headerAction ? renderActionButton(block.headerAction) : '';

  const ctx = { sessions, isFeatureCreator, isAgentCreator, sessionListMode, activeSessionId, title, desc, headerAction };

  if (isFeatureCreator) {
    return _renderFeatureCreatorSessionList(agent, block, ctx);
  }

  if (isAgentCreator && sessionListMode !== 'assembly') {
    return _renderAgentCreatorSessionList(agent, block, ctx);
  }

  if (agent?.id === 'programming-helper') {
    return _renderProgrammingHelperSessionList(agent, block, ctx);
  }

  return _renderGenericSessionList(agent, block, ctx);
}

// ── Feature Creator ──────────────────────────────────────────────

function _renderFeatureCreatorSessionList(agent, block, ctx) {
  const { activeSessionId, title, desc, headerAction } = ctx;
  const projects = getFeatureCreatorProjects(agent);
  const emptyHtml = [
    '<div class="workspace-history-list">',
    '<div class="workspace-history-item"><div>' + escapeHtml(t('workspace_history_empty')) + '</div></div>',
    '</div>',
  ].join('');

  const bodyHtml = projects.length > 0
    ? '<div class="feature-project-list">' + projects.map((project) => {
        const newChatAction = escapeHtml(JSON.stringify({
          type: 'create_session',
          featureName: project.featureName || '',
          openDirectory: project.openDirectory || '',
          targetDir: project.targetDir || '',
        }));
        const projectPreview = project.goal || project.constraints || project.openDirectory || '';
        const sessionsHtml = project.sessions.length > 0
          ? '<div class="feature-project-session-group"><div class="feature-project-subtitle">' + escapeHtml(t('workspace_conversation_group')) + '</div><div class="feature-project-session-list">' + project.sessions.map((session) => {
              const openAction = escapeHtml(JSON.stringify({ type: 'open_session', sessionId: session.id }));
              return [
                '<div class="feature-project-session-item workspace-history-item" data-prebuilt-session-agent-id="' + escapeHtml(agent.id) + '" data-prebuilt-session-id="' + escapeHtml(session.id) + '" data-ctx-role="session" data-ctx-ns="' + escapeHtml(agent.id) + '" data-ctx-id="' + escapeHtml(session.id) + '" data-ctx-variant="' + escapeHtml(isAssemblySession(session) ? 'assembly' : 'default') + '">',
                '<div class="workspace-history-main">',
                '<div class="workspace-history-title-row">',
                '<div class="workspace-history-title" data-action="sessions.titleDblClick" title="' + escapeHtml(getCurrentLanguage() === 'zh' ? '双击编辑标题' : 'Double-click to edit title') + '">' + escapeHtml(session.title || session.id) + '</div>',
                renderSessionResumeBadge(session),
                session.id === activeSessionId ? '<span class="workspace-history-active">当前</span>' : '',
                renderSessionArchivedBadge(session),
                renderSessionTitleAiButton(session),
                '</div>',
                '<div class="workspace-history-meta">' + escapeHtml(formatWorkspaceDate(session.updatedAt)) + '</div>',
                session.preview ? '<div class="workspace-history-preview">' + escapeHtml(session.preview) + '</div>' : '',
                renderSessionTokenBar(session, agent),
                '</div>',
                '<div class="workspace-history-side">',
                '<div class="workspace-history-meta compact">' + escapeHtml(t('workspace_history_messages')) + ': ' + escapeHtml(String(session.messageCount ?? 0)) + '</div>',
                '<div class="workspace-actions stacked">',
                '<button class="workspace-action" type="button" data-workspace-action="' + openAction + '" data-action="sessions.workspaceAction">' + escapeHtml(t('workspace_open_chat')) + '</button>',
                '</div>',
                '</div>',
                '</div>',
              ].join('');
            }).join('') + '</div></div>'
          : '<div class="feature-project-session-group"><div class="feature-project-subtitle">' + escapeHtml(t('workspace_conversation_group')) + '</div><div class="feature-project-empty-note">' + escapeHtml(t('workspace_feature_no_sessions')) + '</div></div>';

        return [
          '<div class="feature-project-card" data-prebuilt-project-agent-id="' + escapeHtml(agent.id) + '" data-prebuilt-project-id="' + escapeHtml(project.id) + '">',
          '<details class="feature-project-disclosure">',
          '<summary>',
          '<div class="feature-project-row">',
          '<div class="feature-project-summary">',
          '<div class="feature-project-titlebar">',
          '<div class="workspace-history-title">' + escapeHtml(getFeatureProjectDisplayName(project)) + '</div>',
          activeSessionId && project.sessions.some(s => s.id === activeSessionId) ? '<span class="workspace-history-active">当前</span>' : '',
          '</div>',
          '<div class="feature-project-meta-line"><span>' + escapeHtml(formatWorkspaceDate(project.updatedAt)) + '</span></div>',
          projectPreview ? '<div class="workspace-history-preview">' + escapeHtml(projectPreview) + '</div>' : '',
          project.openDirectory ? '<div class="workspace-history-meta">' + escapeHtml(project.openDirectory) + '</div>' : '',
          '</div>',
          '<div class="feature-project-side">',
          '<div class="feature-project-head-actions">',
          (viewCapabilityEnabled(agent.id, 'workspaceCreate') ? '<button class="workspace-action secondary" type="button" data-workspace-action="' + newChatAction + '" data-action="sessions.workspaceActionEvent">' + escapeHtml(t('workspace_new_chat')) + '</button>' : ''),
          '</div>',
          '<div class="feature-project-toggle" data-label-collapsed="' + escapeHtml(t('workspace_expand_records')) + '" data-label-expanded="' + escapeHtml(t('workspace_collapse_records')) + '" aria-hidden="true"><span class="feature-project-count">' + escapeHtml(String(project.conversationCount || 0)) + '</span></div>',
          '</div>',
          '</div>',
          '</summary>',
          '<div class="feature-project-body">',
          sessionsHtml,
          '</div>',
          '</details>',
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
    headerAction,
    '</div>',
    bodyHtml,
    '</section>',
  ].join('');
}

// ── Agent Creator ────────────────────────────────────────────────

function _renderAgentCreatorSessionList(agent, block, ctx) {
  const { activeSessionId, title, desc, headerAction } = ctx;
  const projects = getAgentCreatorProjects(agent);
  const emptyHtml = [
    '<div class="workspace-history-list">',
    '<div class="workspace-history-item"><div>' + escapeHtml(t('workspace_history_empty')) + '</div></div>',
    '</div>',
  ].join('');

  const bodyHtml = projects.length > 0
    ? '<div class="feature-project-list">' + projects.map((project) => {
        const newChatAction = escapeHtml(JSON.stringify({
          type: 'create_session',
          agentName: project.agentName || '',
          openDirectory: project.openDirectory || '',
          targetDir: project.targetDir || '',
        }));
        const projectPreview = project.goal || project.plannedFeatures || project.constraints || project.openDirectory || '';
        const sessionsHtml = project.sessions.length > 0
          ? '<div class="feature-project-session-group"><div class="feature-project-subtitle">' + escapeHtml(t('workspace_conversation_group')) + '</div><div class="feature-project-session-list">' + project.sessions.map((session) => {
              const openAction = escapeHtml(JSON.stringify({ type: 'open_session', sessionId: session.id }));
              return [
                '<div class="feature-project-session-item workspace-history-item" data-prebuilt-session-agent-id="' + escapeHtml(agent.id) + '" data-prebuilt-session-id="' + escapeHtml(session.id) + '" data-ctx-role="session" data-ctx-ns="' + escapeHtml(agent.id) + '" data-ctx-id="' + escapeHtml(session.id) + '" data-ctx-variant="' + escapeHtml(isAssemblySession(session) ? 'assembly' : 'default') + '">',
                '<div class="workspace-history-main">',
                '<div class="workspace-history-title-row">',
                '<div class="workspace-history-title" data-action="sessions.titleDblClick" title="' + escapeHtml(getCurrentLanguage() === 'zh' ? '双击编辑标题' : 'Double-click to edit title') + '">' + escapeHtml(session.title || session.id) + '</div>',
                renderSessionResumeBadge(session),
                session.id === activeSessionId ? '<span class="workspace-history-active">当前</span>' : '',
                renderSessionArchivedBadge(session),
                renderSessionTitleAiButton(session),
                '</div>',
                '<div class="workspace-history-meta">' + escapeHtml(formatWorkspaceDate(session.updatedAt)) + '</div>',
                session.preview ? '<div class="workspace-history-preview">' + escapeHtml(session.preview) + '</div>' : '',
                renderSessionTokenBar(session, agent),
                '</div>',
                '<div class="workspace-history-side">',
                '<div class="workspace-history-meta compact">' + escapeHtml(t('workspace_history_messages')) + ': ' + escapeHtml(String(session.messageCount ?? 0)) + '</div>',
                '<div class="workspace-actions stacked">',
                '<button class="workspace-action" type="button" data-workspace-action="' + openAction + '" data-action="sessions.workspaceAction">' + escapeHtml(t('workspace_open_chat')) + '</button>',
                '</div>',
                '</div>',
                '</div>',
              ].join('');
            }).join('') + '</div></div>'
          : '<div class="feature-project-session-group"><div class="feature-project-subtitle">' + escapeHtml(t('workspace_conversation_group')) + '</div><div class="feature-project-empty-note">' + escapeHtml(t('workspace_feature_no_sessions')) + '</div></div>';

        return [
          '<div class="feature-project-card" data-prebuilt-project-agent-id="' + escapeHtml(agent.id) + '" data-prebuilt-project-id="' + escapeHtml(project.id) + '">',
          '<details class="feature-project-disclosure">',
          '<summary>',
          '<div class="feature-project-row">',
          '<div class="feature-project-summary">',
          '<div class="feature-project-titlebar">',
          '<div class="workspace-history-title">' + escapeHtml(getAgentProjectDisplayName(project)) + '</div>',
          activeSessionId && project.sessions.some(s => s.id === activeSessionId) ? '<span class="workspace-history-active">当前</span>' : '',
          '</div>',
          '<div class="feature-project-meta-line"><span>' + escapeHtml(formatWorkspaceDate(project.updatedAt)) + '</span></div>',
          projectPreview ? '<div class="workspace-history-preview">' + escapeHtml(projectPreview) + '</div>' : '',
          project.openDirectory ? '<div class="workspace-history-meta">' + escapeHtml(project.openDirectory) + '</div>' : '',
          '</div>',
          '<div class="feature-project-side">',
          '<div class="feature-project-head-actions">',
          (viewCapabilityEnabled(agent.id, 'workspaceCreate') ? '<button class="workspace-action secondary" type="button" data-workspace-action="' + newChatAction + '" data-action="sessions.workspaceActionEvent">' + escapeHtml(t('workspace_new_chat')) + '</button>' : ''),
          '</div>',
          '<div class="feature-project-toggle" data-label-collapsed="' + escapeHtml(t('workspace_expand_records')) + '" data-label-expanded="' + escapeHtml(t('workspace_collapse_records')) + '" aria-hidden="true"><span class="feature-project-count">' + escapeHtml(String(project.conversationCount || 0)) + '</span></div>',
          '</div>',
          '</div>',
          '</summary>',
          '<div class="feature-project-body">',
          sessionsHtml,
          '</div>',
          '</details>',
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
    headerAction,
    '</div>',
    bodyHtml,
    '</section>',
  ].join('');
}

// ── Programming Helper ───────────────────────────────────────────

/**
 * PH 会话条目骨架（正常列表与搜索结果共用——不维护两套会话操作实现）。
 * opts:
 *   - type: 分区语义（main/archived/会话类型，进 data-ctx-variant 与菜单）
 *   - nsId: 操作寻址身份（远程视图传宿主命名空间 id；默认 agent.id）
 *   - bodyHtml: 覆盖 preview+token bar 的正文区（搜索上下文片段用）
 *   - openActionExtra: 并入打开动作 JSON 的额外字段（如 messageIndex 定位）
 *   - extraClasses: 附加到条目根的额外 class
 */
/**
 * 对话历史存档计数（ticket 050，菜单与徽标共用的单一口径）：
 * 会话是某线程 head 时返回历史代数量，否则 0。列表接口的 thread 摘要
 * 不带 sessionChain（详情端点才带），以 sessionIds 兜底计数。
 */
function phThreadArchiveCount(agentId, sessionId) {
  if (typeof window.getThreadForSession !== 'function') return 0;
  const thread = window.getThreadForSession(agentId, sessionId);
  if (!thread || thread.headSessionId !== sessionId) return 0;
  const chain = Array.isArray(thread.sessionChain) ? thread.sessionChain : null;
  const archiveCount = chain
    ? chain.filter((entry) => entry?.sessionId !== thread.headSessionId).length
    : Math.max(0, (Array.isArray(thread.sessionIds) ? thread.sessionIds.length : 1) - 1);
  return Math.max(0, archiveCount);
}

/**
 * 对话历史徽标（ticket 050）：会话是某线程 head 且存在历史代时渲染
 * 「历史 · N」入口。用户语言：「历史」= 本对话每次精简前的完整记录
 * （ADR-0032 决策 3），不是内部代次概念。非 head 成员 / 无线程会话不
 * 渲染（归档区的历史代成员由列表过滤收敛，只经本入口可达）。线程数据
 * 未加载（getThreadForSession 缺席）时保守不渲染——轮询到位后自动补。
 */
function renderSessionThreadBadge(agentId, session) {
  const archiveCount = phThreadArchiveCount(agentId, session?.id);
  if (archiveCount <= 0) return '';
  const thread = typeof window.getThreadForSession === 'function'
    ? window.getThreadForSession(agentId, session?.id) : null;
  if (!thread) return '';
  const isZh = getCurrentLanguage() === 'zh';
  return '<button type="button" class="session-thread-badge" data-action="sessions.threadHistory" data-agent-id="' + escapeHtml(agentId) + '" data-thread-id="' + escapeHtml(thread.threadId) + '"'
    + ' title="' + escapeHtml(isZh ? '查看本对话的精简前存档' : 'View pre-trim archives of this conversation') + '">'
    + escapeHtml(isZh ? '历史 · ' + archiveCount : 'History · ' + archiveCount)
    + '</button>';
}

/**
 * 对话归档状态谓词（线程优先）：有线程的行以线程 lifeState 为准——
 * 服务端线程归档不写 session index 的 archived 位（走线程端点的归档，
 * head 不置位，行会错误留在「我的对话」）；无线程会话（存量独立会话 /
 * agent-studio）才读 session 标志。线程数据未就绪时 getThreadForSession
 * 返回 null → 按 session 标志保守渲染，数据到位后 sig 变化触发重渲染
 * 收敛（与 phIsThreadArchivedMember 同模式）。
 */
function phConversationArchived(agentId, session) {
  if (typeof window.getThreadForSession === 'function') {
    const thread = window.getThreadForSession(agentId, session?.id);
    if (thread) return thread.lifeState === 'archived';
  }
  return session?.archived === true;
}

/**
 * 归档区线程收敛谓词（ticket 050）：历史代成员（线程内非 head）不再在
 * 归档区单独成行——它们是某条对话的精简前存档，经 head 行「历史 · N」
 * 入口可达（ADR-0032 列表语义：一行 = 一段对话）。线程数据未加载时返回
 * false（保守渲染），数据到位后 sig 变化触发重渲染收敛。已归档线程的
 * head 保留为对话行（历史入口仍可用）。
 */
function phIsThreadArchivedMember(agentId, session) {
  if (typeof window.getThreadForSession !== 'function') return false;
  const thread = window.getThreadForSession(agentId, session?.id);
  return !!(thread && thread.headSessionId !== session?.id);
}

/**
 * 列表分区（一行 = 一段对话，ADR-0032）：
 *   - 我的对话：未归档对话的 head 行 + 无线程的未归档会话
 *   - 已归档：已归档线程的 head 行 + 无线程的已归档会话
 *   - 线程历史代成员（非 head）不进入任何分区——它们经 head 行的
 *     「历史 · N」入口可达（旧「精简并归档原会话」产物带会话级
 *     archived=true，线程活跃时该标志被覆盖，不能作为分区依据）
 */
function phPartitionSessions(agentId, sessions) {
  const source = Array.isArray(sessions) ? sessions : [];
  const main = [];
  const archived = [];
  for (const session of source) {
    if (phIsThreadArchivedMember(agentId, session)) continue;
    if (phConversationArchived(agentId, session)) archived.push(session);
    else main.push(session);
  }
  return { main, archived };
}

function renderPhSessionItemHtml(agent, session, opts = {}) {
  const isZh = getCurrentLanguage() === 'zh';
  const sType = opts.type || session.sessionType || 'main';
  // 远程历史会话（ADR-0012 决策 1）：操作寻址用宿主级命名空间 id——
  // 服务端会话端点按命名空间 agentId 解析远程目标并转发（裸 id）。
  const sessionNsId = opts.nsId || session.remoteHostNsId || agent.id;
  const openActionJson = {
    type: 'open_session',
    sessionId: session.id,
    ...(opts.openActionExtra || {}),
  };
  const openAction = escapeHtml(JSON.stringify(openActionJson));
  const primaryBtn = '<button class="workspace-action" type="button" data-workspace-action="' + openAction + '" data-action="sessions.workspaceAction">' + escapeHtml(t('workspace_open_chat')) + '</button>';
  const moreBtn = '<button class="workspace-action secondary session-more-btn" type="button" data-action="sessions.ctxMenu" data-ctx-ns="' + escapeHtml(sessionNsId) + '" data-session-id="' + escapeHtml(session.id) + '" data-session-type="' + escapeHtml(sType) + '"><svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><circle cx="3" cy="7" r="1.3"/><circle cx="7" cy="7" r="1.3"/><circle cx="11" cy="7" r="1.3"/></svg></button>';
  const buttonsHtml = [primaryBtn, moreBtn].join('');
  // Build compact time indicator for title-row left side (only within this week)
  let shortTime = getSessionShortTime(session.updatedAt);
  let recencyCls = getSessionRecencyClass(session.updatedAt);
  let indicatorHtml = shortTime
    ? '<span class="session-time-indicator ' + recencyCls + '"><span class="session-time-dot"></span><span class="session-time-label">' + escapeHtml(shortTime) + '</span></span>'
    : '';
  // 会话记录可拖拽（引用源）：远程历史会话禁拖（引用寻址不到远程数据）
  const dragAttrs = (session.remoteHostNsId || opts.disableDrag)
    ? ''
    : ' draggable="true" ondragstart="onPhSessionDragStart(event, this)" data-ref-session-type="' + escapeHtml(session.sessionType || 'main') + '"';
  const metaHtml = '<div class="workspace-history-meta">' + escapeHtml(formatWorkspaceDate(session.updatedAt))
    + ' · ' + escapeHtml(String(session.messageCount ?? 0)) + ' ' + escapeHtml(isZh ? '条消息' : 'messages') + '</div>';
  // 归档徽标按对话归档口径渲染（phConversationArchived，线程优先）：
  // 线程 head 行的徽标跟随线程状态——旧时代会话级 archived 标志不再让
  // 「我的对话」里的行错误显示「已归档」（徽标在搜索混排时用于辨别分区）。
  const conversationArchived = phConversationArchived(agent.id, session);
  const archivedBadgeHtml = conversationArchived
    ? renderSessionArchivedBadge({ ...session, archived: true })
    : '';
  const defaultBodyHtml = (session.preview ? '<div class="workspace-history-preview">' + escapeHtml(session.preview) + '</div>' : '')
    + renderSessionTokenBar(session, agent);
  const bodyHtml = opts.bodyHtml !== undefined ? opts.bodyHtml : defaultBodyHtml;
  // 多选模式（移动到…）：本地 PH 会话前置复选框（远程会话不进入多选）
  const selectCheckboxHtml = opts.selectMode
    ? '<label class="ph-session-select"><input type="checkbox" data-select-session-id="' + escapeHtml(session.id) + '"' + (opts.selected ? ' checked' : '') + ' data-action="sessions.toggleSelect" data-event="change"></label>'
    : '';
  return [
    '<div class="feature-project-session-item workspace-history-item' + (opts.selected ? ' ph-session-item-selected' : '') + (opts.extraClasses ? ' ' + escapeHtml(opts.extraClasses) : '') + '" data-prebuilt-session-agent-id="' + escapeHtml(sessionNsId) + '" data-prebuilt-session-id="' + escapeHtml(session.id) + '" data-session-type="' + escapeHtml(sType) + '" data-ctx-role="session" data-ctx-ns="' + escapeHtml(sessionNsId) + '" data-ctx-id="' + escapeHtml(session.id) + '" data-ctx-variant="' + escapeHtml(sType) + '"' + dragAttrs + '>',
    '<div class="workspace-history-main">',
    selectCheckboxHtml,
    '<div class="workspace-history-title-row">',
    indicatorHtml,
    '<div class="workspace-history-title" data-action="sessions.titleDblClick" title="' + escapeHtml(isZh ? '双击编辑标题' : 'Double-click to edit title') + '">' + (opts.titleHtml || escapeHtml(session.title || session.id)) + '</div>',
    renderSessionResumeBadge(session),
    renderSessionThreadBadge(agent.id, session),
    renderSessionTodoBadge(session),
    archivedBadgeHtml,
    renderSessionTitleAiButton(session),
    '</div>',
    metaHtml,
    bodyHtml,
    '</div>',
    '<div class="workspace-history-side">',
    '<div class="workspace-actions stacked">',
    buttonsHtml,
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}

// ── PH 会话空态卡（gen-ui-empty / git-empty-card 同款配方）──────────
// 虚线卡片 + 图标块 + 标题 + 描述 + 可选动作。图标走 24 viewBox stroke
// 线稿、随图标块 currentColor 着色：对话气泡取自输入区会话引用等既有先例，
// 归档盒为同线宽新绘（无既有先例）。
const _PH_EMPTY_CHAT_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const _PH_EMPTY_ARCHIVE_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>';

function renderPhSessionsEmptyCard(iconSvg, title, desc, actionHtml) {
  return [
    '<div class="ph-sessions-empty-card">',
    '<div class="ph-sessions-empty-icon" aria-hidden="true">' + iconSvg + '</div>',
    '<div class="ph-sessions-empty-title">' + escapeHtml(title) + '</div>',
    desc ? '<div class="ph-sessions-empty-desc">' + escapeHtml(desc) + '</div>' : '',
    actionHtml || '',
    '</div>',
  ].join('');
}

function _renderProgrammingHelperSessionList(agent, block, ctx) {
  const { desc } = ctx;
  // 项目实体清单按需拉取（在飞合并）；无显式项目目标时不强制重渲染——
  // 轮询自然刷新 surface，项目组随下次渲染出现（避免渲染-加载循环）。
  ensurePhProjectEntitiesLoaded();
  const projects = getProgrammingHelperProjects(agent);
  const wsState = getAgentWorkspaceState(agent);
  const currentOpenDir = String(wsState?.openDirectory || '').trim();
  const isZh = getCurrentLanguage() === 'zh';
  const agentName = isZh ? '智能编码空间' : 'Intelligent Coding Space';

  // Determine current project — typed browsing target first (ticket 045):
  // 显式项目目标 > 显式目录目标 > workspace_state.openDirectory 目录回退。
  // 轮询刷新的 workspace_state 不会覆盖显式选择；项目元数据未加载完时
  // 保持项目待定态（projectPending），不退回目录。
  const browsingTarget = getPhBrowsingTarget(agent);
  let normCurrentDir = currentOpenDir.replace(/\\/g, '/').toLowerCase();
  let currentProject = null;
  let projectPending = false;
  if (browsingTarget?.type === 'project') {
    if (browsingTarget.project) {
      currentProject = projects.find((p) => p.id === browsingTarget.id) || null;
    } else {
      projectPending = true; // 元数据加载中：不退回另一个目标（契约）
      ensurePhProjectEntitiesLoaded().then(() => {
        setLastRenderedWorkspaceHtml('');
        window.renderCurrentMainView();
      });
    }
  }
  if (!currentProject && !projectPending) {
    // 显式目录目标优先于 workspace_state.openDirectory（两者通常一致；
    // 不一致时以用户显式选择为准）
    currentProject = (browsingTarget?.type === 'dir')
      ? projects.find(p => p.id === browsingTarget.id) || null
      : null;
    // 项目绑定目录（非注册目录桶）：合成目录呈现桶——只驱动 surface 视图
    // 与目录切片，不进目录注册表、不写 workspace_state。
    if (!currentProject && browsingTarget?.type === 'dir') {
      const boundBucket = getPhProjectBoundDirectoryBucket(agent);
      if (boundBucket) {
        currentProject = { ...boundBucket, sessions: getWorkspaceSessions(agent) };
      }
    }
  }
  if (!currentProject && !projectPending) {
    currentProject = currentOpenDir
      ? projects.find(p => p.id === ('dir:' + normCurrentDir)) || null
      : (projects.length > 0 ? projects[0] : null);
  }

  // 远程独有项目视图覆盖（ADR-0012 决策 1）：view-only 选中优先于工作区目录；
  // 项目消失（断线 / 目录历史清空）时自动回落到工作区目录并清除覆盖。
  const overrideProjectId = getPhSurfaceViewProjectId() || '';
  if (!projectPending && overrideProjectId && overrideProjectId !== currentProject?.id) {
    const overrideProject = projects.find((p) => p.id === overrideProjectId && p.remoteOnly);
    if (overrideProject) {
      currentProject = overrideProject;
    } else {
      setPhSurfaceViewProjectId(null);
    }
  }

  // Open-folder icon button for the active project.
  // 目录只能经 data 属性传递，禁止内联进 onclick 的 JS 字符串字面量——
  // Windows 反斜杠路径会被字符串转义静默吞掉（\c → c），导致服务端找不到目录。
  const openFolderBtnHtml = (dir) =>
    '<button class="ph-dropdown-open-folder" type="button" title="' +
    escapeHtml(isZh ? '在文件夹中打开' : 'Open in folder') +
    '" data-open-dir="' + escapeHtml(dir) + '">' +
    '<svg width="18" height="18" viewBox="0 0 16 16" fill="none"><path d="M2 4.5C2 3.67 2.67 3 3.5 3H6.5L8 4.5H12.5C13.33 4.5 14 5.17 14 6V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' +
    '<span class="ph-dropdown-open-folder-text">' + escapeHtml(isZh ? '打开' : 'Open') + '</span>' +
    '</button>';

  // ── 顶部双选择器（目录决定位置，项目决定组织）────────────────────
  // 左：目录选择器（目录桶 + 项目绑定目录含托管，二级展开该目录项目；
  // 点目录本体进默认集合，不恢复上次项目）。右：归属胶囊（默认项目
  // + 当前同目录项目 + 新建/管理入口；项目不跨目录）。远程目录保持既有
  // 视图寻址，不伪造远程项目。
  const dirNavEntries = getPhDirectoryNavigationList(agent);
  const dirContext = projectPending ? null : getPhCurrentDirectoryContext(agent);
  const currentDirId = dirContext?.dirId || '';
  const currentDirPath = dirContext?.openDirectory || '';
  const dirEntryActive = dirNavEntries.find((e) => e.id === currentDirId) || null;

  const pendingLabel = isZh ? '加载中…' : 'Loading…';
  // 菜单项键盘可达：div 菜单项以 role=menuitem + tabindex 进入 Tab 序列，
  // Enter/Space 触发既有 onclick（与触发器原生 button 的行为对齐；展开
  // 按钮本就是 button + aria-expanded，不走此路径）。仅当事件目标就是
  // 键盘可达性：声明式（分发器 data-key-activate，仅元素自身聚焦时 Enter/Space
  // 激活并 preventDefault）——行内 button（展开/打开目录）按键冒泡到这里时
  // 不会被吞掉原生激活（Space click）。
  const menuItemKbd = ' role="menuitem" tabindex="0" data-key-activate data-event="click keydown"';
  const dirTriggerName = projectPending ? pendingLabel
    : (dirEntryActive ? dirEntryActive.name : (isZh ? '未打开目录' : 'No Directory'));
  const dirTriggerPath = projectPending ? '' : (dirEntryActive ? dirEntryActive.openDirectory : '');
  const dirAvatar = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H10l2 2h7.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M3.5 10h17"/></svg>';
  // 归属菜单行内设置钮的齿轮图标（SVG；§6.3 禁止文字符号冒充图标）
  const orgItemGearSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/></svg>';

  // 子菜单项不显示路径：面板已由目录行锚定范围，重复同一路径是噪音。
  const renderDirSubprojectItem = (entity) => [
    '<div class="ph-project-dropdown-item ph-dir-subproject-item' + (entity.id === currentProject?.id ? ' active' : '') + '" data-project-id="' + escapeHtml(entity.id) + '" data-action="sessions.switchProject"' + menuItemKbd + '>',
    '<div class="ph-project-dropdown-avatar">' + escapeHtml((entity.name || '?')[0].toUpperCase()) + '</div>',
    '<div class="ph-project-dropdown-info">',
    '<div class="ph-project-dropdown-name">' + escapeHtml(entity.name) + '</div>',
    '</div>',
    '</div>',
  ].join('');

  const dirMenuItems = [];
  // 「打开目录…」入口置顶常驻：不埋在目录清单尾部（清单可能很长）。
  // 采用轻量菜单动作行（图标 + 单行文字），避免整块卡片打断目录清单；与目录项
  // 的头像和路径双行结构仍有区分。
  const openDirEntryHtml =
    '<div class="ph-open-dir-entry" data-action="sessions.openProject"' + menuItemKbd
    + ' title="' + escapeHtml(isZh ? '选择一个本地文件夹作为工作目录' : 'Pick a local folder as the working directory') + '">'
    + '<span class="ph-open-dir-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 4.5C2 3.67 2.67 3 3.5 3H6.5L8 4.5H12.5C13.33 4.5 14 5.17 14 6V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 7v4M6 9h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></span>'
    + '<span class="ph-open-dir-label">' + (isZh ? '打开目录…' : 'Open Directory…') + '</span>'
    + '</div>';
  const viewingProject = currentProject?.type === 'project';
  const dirSubmenuItems = [];
  for (const entry of dirNavEntries) {
    const isActive = entry.id === currentDirId;
      // 悬停展开由 ph-project-actions.js 的 document 级 pointerover/pointerout/
      // focusin 委托驱动，元素上不再挂内联 mouseenter/mouseleave（历史双路径已收敛）。
      dirMenuItems.push('<div class="ph-dir-nav-group" data-dir-group="' + escapeHtml(entry.id) + '">');
    dirMenuItems.push(
      '<div class="ph-project-dropdown-item ph-dir-item' + (isActive ? ' active' : '') + '" data-dir-id="' + escapeHtml(entry.id) + '" data-project-id="' + escapeHtml(entry.id) + '" aria-haspopup="menu" aria-expanded="false" data-action="sessions.switchProject"' + menuItemKbd + '>',
      '<div class="ph-project-dropdown-avatar">' + escapeHtml((entry.name || '?')[0].toUpperCase()) + '</div>',
      '<div class="ph-project-dropdown-info">',
      '<div class="ph-project-dropdown-name">' + escapeHtml(entry.name) + '</div>',
      '<div class="ph-project-dropdown-path">' + escapeHtml(entry.openDirectory) + '</div>',
      '</div>',
      (isActive && entry.openDirectory ? openFolderBtnHtml(entry.openDirectory) : ''),
      '</div>',
      '</div>',
    );
    // 每个目录都有右侧项目面板：无项目目录的面板只含「默认项目」，
    // 悬停切换时行为统一（不会出现有的行展开、有的行不展开）。
    const defaultSubItem =
      '<div class="ph-project-dropdown-item ph-dir-subproject-item ph-dir-sub-default' + (isActive && !viewingProject ? ' active' : '') + '" data-dir-id="' + escapeHtml(entry.id) + '" data-action="sessions.switchProject"' + menuItemKbd + '>' +
      '<div class="ph-project-dropdown-avatar">&#9638;</div>' +
      '<div class="ph-project-dropdown-info">' +
      '<div class="ph-project-dropdown-name">' + (isZh ? '默认项目' : 'Default Project') + '</div>' +
      '</div>' +
      '</div>';
    // 面板由悬停的目录行锚定，不再重复目录名标题（aria-label 保留给读屏）。
    dirSubmenuItems.push('<div class="ph-dir-subprojects" role="menu" tabindex="-1" aria-label="' + escapeHtml((isZh ? '项目，目录：' : 'Projects in ') + entry.name) + '" data-subprojects-for="' + escapeHtml(entry.id) + '">'
      + defaultSubItem + entry.projects.map(renderDirSubprojectItem).join('') + '</div>');
  }
  const dirSelectorHtml = '<div class="ph-project-dropdown ph-dir-selector">' +
    '<button type="button" class="ph-project-dropdown-trigger" aria-haspopup="menu" aria-expanded="false" data-action="sessions.toggleProjectDropdown">' +
    '<div class="ph-project-header-avatar ph-dir-header-icon">' + dirAvatar + '</div>' +
    '<div class="ph-project-header-info">' +
    '<div class="ph-project-header-name">' + escapeHtml(dirTriggerName) + '</div>' +
    (dirTriggerPath ? '<div class="ph-selector-path">' + escapeHtml(dirTriggerPath) + '</div>' : '') +
    '</div>' +
    '<svg class="ph-project-dropdown-arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>' +
    '</button>' +
    '<div class="ph-project-dropdown-menu">' + openDirEntryHtml +
    '<div class="ph-dir-menu-options" role="group" tabindex="0" aria-label="' + escapeHtml(isZh ? '目录选项' : 'Directory options') + '">' + dirMenuItems.join('') + '</div>' +
    dirSubmenuItems.join('') + '</div>' +
    '</div>';

  // 右侧归属选择器：默认项目+ 当前同目录项目 + 新建/管理。
  // 项目不跨目录——跨目录导航经左侧目录树（一次切换两者）。
  const sameDirProjects = (!projectPending && currentDirPath)
    ? getPhProjectsInDirectory(currentDirPath)
    : [];
  const isOrgProject = currentProject?.type === 'project';
  const orgTriggerName = projectPending ? (isZh ? '项目加载中…' : 'Loading project…')
    : (isOrgProject ? escapeHtml(getProgrammingHelperProjectDisplayName(currentProject)) : (isZh ? '默认项目' : 'Default Project'));
  const orgAvatar = projectPending ? '·' : (isOrgProject
    ? escapeHtml((getProgrammingHelperProjectDisplayName(currentProject) || '?')[0].toUpperCase())
    : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5h16v13H4z"/><path d="M8 9h8M8 12h8M8 15h5"/></svg>');

  const renderOrgProjectItem = (entity) => [
    '<div class="ph-project-dropdown-item ph-org-item' + (entity.id === currentProject?.id ? ' active' : '') + '" data-project-id="' + escapeHtml(entity.id) + '" data-action="sessions.switchProject"' + menuItemKbd + '>',
    '<div class="ph-project-dropdown-avatar">' + escapeHtml((entity.name || '?')[0].toUpperCase()) + '</div>',
    '<div class="ph-project-dropdown-info">',
    '<div class="ph-project-dropdown-name">' + escapeHtml(entity.name) + '</div>',
    '<div class="ph-project-dropdown-path">' + (entity.directorySource === 'managed' ? escapeHtml(isZh ? '托管目录' : 'Managed directory') : escapeHtml(entity.openDirectory)) + '</div>',
    '</div>',
    // 行内设置齿轮：直达该项目的项目设置（捕获阶段委托，见 ph-project-actions.js）
    '<button class="ph-org-item-config" type="button" data-project-config="' + escapeHtml(entity.id) + '"'
      + ' title="' + escapeHtml((isZh ? '项目设置 · ' : 'Project Settings · ') + (entity.name || entity.id)) + '"'
      + ' aria-label="' + escapeHtml(isZh ? '项目设置' : 'Project Settings') + '">' + orgItemGearSvg + '</button>',
    '</div>',
  ].join('');

  const orgMenuActions = [
    // 管理动作固定显示在项目列表上方；加号按钮另作添加项目的快速入口。
    '<div class="ph-open-dir-entry ph-org-action" data-action="sessions.newProjectDialog"' + menuItemKbd + '>' +
      '<span class="ph-open-dir-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></span>' +
      '<span class="ph-open-dir-label">' + (isZh ? '添加项目' : 'Add Project') + '</span>' +
    '</div>' +
    '<div class="ph-open-dir-entry ph-org-action" data-action="sessions.manageProjects"' + menuItemKbd + '>' +
      '<span class="ph-open-dir-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 3.5h10v9H3z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M5.5 6h5M5.5 8h5M5.5 10h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></span>' +
      '<span class="ph-open-dir-label">' + (isZh ? '编辑项目' : 'Edit Projects') + '</span>' +
    '</div>',
  ];
  const orgMenuOptions = [
    // 胶囊菜单：默认项目 + 当前同目录项目（项目不跨目录）；行内齿轮直达各项设置。
    '<div class="ph-project-dropdown-item ph-org-item ph-org-directory' + (!isOrgProject && !projectPending ? ' active' : '') + '"' +
      (currentDirId ? ' data-dir-id="' + escapeHtml(currentDirId) + '" data-action="sessions.switchProject"' : '') + menuItemKbd + '>' +
    '<div class="ph-project-dropdown-avatar">&#9638;</div>' +
    '<div class="ph-project-dropdown-info">' +
    '<div class="ph-project-dropdown-name">' + (isZh ? '默认项目' : 'Default Project') + '</div>' +
    '<div class="ph-project-dropdown-path">' + escapeHtml(currentDirPath ? (isZh ? '未归类到项目的对话' : 'Chats not grouped into a project') : (isZh ? '无当前目录' : 'No current directory')) + '</div>' +
    '</div>' +
    // 默认项目的设置齿轮（dir:<path> 层，弹窗呈现为「项目设置 · 默认项目」）；
    // remoteOnly 视图无本地配置语义，不提供
    (currentDirPath && !currentProject?.remoteOnly
      ? '<button class="ph-org-item-config" type="button" data-dir-config="' + escapeHtml(currentDirPath) + '"'
        + ' title="' + escapeHtml(isZh ? '项目设置 · 默认项目' : 'Project Settings · Default Project') + '"'
        + ' aria-label="' + escapeHtml(isZh ? '项目设置' : 'Project Settings') + '">' + orgItemGearSvg + '</button>'
      : '') +
    '</div>',
    ...sameDirProjects.map(renderOrgProjectItem),
  ];

  // 归属胶囊：小徽章 + 名称，形态与目录选择器（大字标题块）根本不同——
  // 目录=位置主形态，胶囊=从属标签。无项目时显示「默认项目」。
  const orgPillBadge = projectPending ? '·' : (isOrgProject
    ? escapeHtml((getProgrammingHelperProjectDisplayName(currentProject) || '?')[0].toUpperCase())
    : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5h16v13H4z"/><path d="M8 9h8M8 12h8M8 15h5"/></svg>');
  const orgSelectorHtml = '<div class="ph-project-dropdown ph-org-selector">' +
    '<button type="button" class="ph-org-pill-trigger" aria-haspopup="menu" aria-expanded="false" data-action="sessions.toggleProjectDropdown">' +
    '<span class="ph-org-pill-badge' + (isOrgProject ? ' project' : '') + '">' + orgPillBadge + '</span>' +
    '<span class="ph-org-pill-label">' + orgTriggerName + '</span>' +
    '<svg class="ph-org-pill-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>' +
    '</button>' +
    '<div class="ph-project-dropdown-menu ph-org-menu">' +
      '<div class="ph-org-menu-actions">' + orgMenuActions.join('') + '</div>' +
      '<div class="ph-org-menu-options" role="group" tabindex="0" aria-label="' + (isZh ? '项目选项' : 'Project options') + '">' + orgMenuOptions.join('') + '</div>' +
    '</div>' +
    '</div>';

  // Banner (restored) + project bar
  const bannerHtml = [
    '<div class="ph-banner">',
    '<div>',
    '<div class="ph-banner-title">' + escapeHtml(agentName) + '</div>',
    '<div class="ph-banner-desc">' + escapeHtml(desc) + '</div>',
    '</div>',
    '<div class="ph-banner-actions">',
    '<button class="ph-banner-btn secondary" type="button" data-action="sessions.openSettings">' + (isZh ? '工作空间设置' : 'Settings') + '</button>',
    '<button class="ph-banner-btn" type="button" data-action="sessions.openProject">' + (isZh ? '打开目录' : 'Open Directory') + '</button>',
    '</div>',
    '</div>',
  ].join('');

  // 获取当前主代理模型显示
  const modelPresets = agent?.modelPresets || {};
  const defaultPreset = modelPresets.default || {};
  const primaryModel = typeof defaultPreset === 'string' ? defaultPreset : (defaultPreset.primary || '');
  const secondaryModel = typeof defaultPreset === 'string' ? '' : (defaultPreset.secondary || '');

  // 获取模型显示名称（从全局presets中查找）
  const getModelDisplayName = (modelName) => {
    if (!modelName) return '';
    const presets = getClawModelPresets();
    const preset = presets.find(p => p.name === modelName);
    if (preset) {
      // 显示模型名称，如果有contextLength则显示
      const ctx2 = preset.contextLength ? ' · ' + Math.round(preset.contextLength / 1000) + 'K' : '';
      return preset.name + ctx2;
    }
    return modelName;
  };

  const modelDisplayName = getModelDisplayName(primaryModel);
  const hasSecondary = !!secondaryModel;

  // 模型显示组件 - 简洁设计，无图标（模型预设属本地 agent 配置；远程视图按
  // 宿主 write 能力决定呈现，不可写宿主不在此呈现模型切换）。
  const viewIdentity = projectViewIdentity(agent, currentProject);
  const canWorkspaceCreate = viewCapabilityEnabled(viewIdentity, 'workspaceCreate');
  const modelSwitchHtml = currentProject && viewCapabilityEnabled(viewIdentity, 'write') && modelDisplayName ? [
    '<div class="ph-model-controls">',
    '<button type="button" class="ph-model-switch' + (hasSecondary ? ' has-secondary' : '') + '" data-action="sessions.toggleModelSlot" title="' + escapeHtml(isZh ? (hasSecondary ? '点击切换到: ' + secondaryModel : '点击配置备选模型') : (hasSecondary ? 'Click to switch to: ' + secondaryModel : 'Click to configure secondary model')) + '">',
    '<span class="ph-model-switch-name">' + escapeHtml(modelDisplayName) + '</span>',
    (hasSecondary ? '<svg class="ph-model-switch-arrow" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3l4 4-4 4"/><line x1="20" y1="7" x2="8" y2="7"/><path d="M8 21l-4-4 4-4"/><line x1="4" y1="17" x2="16" y2="17"/></svg>' : ''),
    '</button>',
    '<button type="button" class="ph-model-settings" data-action="sessions.openModelSettings" title="' + escapeHtml(isZh ? '模型配置' : 'Model settings') + '" aria-label="' + escapeHtml(isZh ? '模型配置' : 'Model settings') + '"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>',
    '</div>',
  ].join('') : '';

    // 新对话动作（R2-03 / 045）：目录目标沿用 openDirectory；项目目标显式
    // 携带稳定 projectId（服务端按项目解析工作目录，不经目录回退）。
    // remoteOnly 视图携带宿主级命名空间 agentId，服务端按命名空间分支
    // 转发到远程宿主创建；本地动作形状不变。
    const isProjectTarget = currentProject?.type === 'project';
    const newChatAction = escapeHtml(JSON.stringify({
      type: 'create_session',
      openDirectory: (!isProjectTarget && currentProject?.openDirectory) || '',
      ...(isProjectTarget ? { projectId: currentProject.id } : {}),
      ...((currentProject?.remoteOnly && viewIdentity) ? { agentId: viewIdentity } : {}),
    }));

    // + 是添加项目的快速入口；编辑项目入口位于归属菜单顶部。
    const quickAddHtml = '<div class="ph-quick-add">' +
      '<button type="button" class="ph-quick-add-btn" aria-label="' + (isZh ? '添加项目' : 'Add Project') + '" title="' + (isZh ? '添加项目' : 'Add Project') + '" data-action="sessions.newProjectDialog"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>' +
      '</div>';
    const orgControlsHtml = '<div class="ph-org-controls">' + orgSelectorHtml + quickAddHtml + '</div>';

    const headerBar = [
      '<div class="ph-project-bar">',
      '<div class="ph-project-bar-left">',
      // 左目录选择器（大字主形态）+ 右归属胶囊与 + 快速操作（形态根本
      // 不同：位置是标题，归属是标签，操作是常驻按钮）。
      dirSelectorHtml,
      orgControlsHtml,
      '</div>',
      '<div class="ph-project-bar-right">',
      modelSwitchHtml,
      // 新对话渲染查 workspaceCreate 能力（远程目录经服务端转发创建）。
      (currentProject && canWorkspaceCreate ? '<button class="ph-banner-btn ph-new-chat-btn" type="button" data-runtime-mode-entry data-workspace-action="' + newChatAction + '" data-action="sessions.workspaceActionEvent" title="' + escapeHtml(isZh ? '悬停选择运行模式（普通 / 容器）' : 'Hover to choose runtime mode (standard / container)') + '">' + (isZh ? '新建对话' : 'New Chat') + '</button>' : ''),
      '</div>',
      '</div>',
    ].join('');

  // No project state（项目元数据加载中不算空态——不退回目录/欢迎页）
  if (!currentProject && !projectPending) {
    return [
      bannerHtml,
      '<section class="workspace-section">',
      '<div class="ph-welcome">',
      '<div class="ph-welcome-icon">&#128193;</div>',
      '<div class="ph-welcome-title">' + (isZh ? '打开一个目录开始编程' : 'Open a directory to start coding') + '</div>',
      '<div class="ph-welcome-desc">' + (isZh ? '打开一个本地文件夹作为工作目录，智能编码空间将在该目录中协助你；项目可再按目录组织对话。' : 'Open a local folder as your working directory. The assistant will help you code within it; projects organize conversations by directory.') + '</div>',
      '</div>',
      '</section>',
    ].join('');
  }
  if (!currentProject && projectPending) {
    // 目标项目元数据加载中：仅项目栏 + 空列表骨架，ensure 完成后重渲染
    return [
      bannerHtml,
      headerBar,
      '<section class="workspace-section">',
      '<div class="feature-project-empty-note">' + escapeHtml(isZh ? '项目加载中…' : 'Loading project…') + '</div>',
      '</section>',
    ].join('');
  }

  // Project is active - show its sessions with tabs
  // 分区契约见 phPartitionSessions：历史代成员不进入任何分区（此前仅
  // 归档区过滤，线程未归档时历史代会漏进「我的对话」）。
  const { main: mainSessionsUnsorted, archived: archivedSessionsUnsorted } = phPartitionSessions(agent.id, currentProject.sessions);
  const mainSessions = sortPhSessionsByMode(mainSessionsUnsorted);
  const archivedSessions = sortPhSessionsByMode(archivedSessionsUnsorted);
  const needsTabs = true; // 始终显示分页器，不管每个类型有没有对话

  // 会话移动多选（本地 PH only）：远程会话不可选——移动是本地归属变更，
  // 不伪造远程移动（ADR-0012 远程目录仅保持既有视图寻址）。
  const moveState = phSessionMove;
  const selectModeOn = agent.id === 'programming-helper'
    && currentProject && !currentProject.remoteOnly
    && moveState?.selectMode === true;
  // 多选状态与当前切片和解：浏览目标/切片更换（轮询、加载更多替换）后，
  // 清理不可见的选中 id；目标漂移则整体作废（回调 reset 之外的兜底）。
  if (selectModeOn) {
    phSessionMoveSyncScope(agent.id, currentProject.id, currentProject.sessions.map((s) => s.id));
  }
  const renderPhSessionItem = (session, type) =>
    renderPhSessionItemHtml(agent, session, {
      type,
      selectMode: selectModeOn && !session.remoteHostNsId,
      selected: selectModeOn && moveState.selected.has(session.id),
    });

  // Render sessions with time-based group headers (今天 / 昨天 / 本周 / 更早)
  const renderPhSessionsWithGroups = (sessions, type) => {
    let html = '';
    let lastGroup = null;
    for (const session of sessions) {
      let group = getTimeGroupLabel(session.updatedAt);
      if (group && group !== lastGroup) {
        html += '<div class="ph-session-group-header">' + escapeHtml(group) + '</div>';
        lastGroup = group;
      }
      html += renderPhSessionItem(session, type);
    }
    return html;
  };

  let sessionsHtml = '';
  if (needsTabs) {
    const tabId = 'ph-tab-' + escapeHtml(agent.id) + '-' + escapeHtml(currentProject.id);
    // 新对话渲染查 workspaceCreate 能力（R2-03）：remoteOnly 视图按宿主握手
    // 能力放开，本地视图恒渲染。空态走 gen-ui-empty / git-empty-card 同款
    // 空态卡配方（虚线卡 + 图标块 + 标题 + 描述 + 动作）。
    const newChatBtnHtml = canWorkspaceCreate ? '<div class="ph-sessions-empty-actions"><button class="workspace-action" type="button" data-runtime-mode-entry data-workspace-action="' + newChatAction + '" data-action="sessions.workspaceActionEvent" title="' + escapeHtml(isZh ? '悬停选择运行模式（普通 / 容器）' : 'Hover to choose runtime mode (standard / container)') + '">' + escapeHtml(t('workspace_new_chat')) + '</button></div>' : '';
    const mainEmptyNote = renderPhSessionsEmptyCard(
      _PH_EMPTY_CHAT_ICON,
      isZh ? '还没有对话' : 'No conversations yet',
      isZh ? '创建第一段对话，描述需求或贴上报错即可开始。' : 'Start the first conversation — describe a task or paste an error.',
      newChatBtnHtml);
    const archivedEmptyNote = renderPhSessionsEmptyCard(
      _PH_EMPTY_ARCHIVE_ICON,
      isZh ? '还没有归档对话' : 'No archived conversations',
      isZh ? '归档的对话会收纳到这里，随时可恢复。' : 'Archived conversations are kept here and can be restored anytime.');
    const isSearching = phSessionUi.phSearchQuery.trim().length > 0;
    // 分页徽标：服务端切片携带当前项目 main/archived 真实总数（远程旧版
    // 无此字段时回退已加载数）。加载更多按整体切片进度（sessionTotal vs
    // 已加载条数），两个 tab 共用同一条追加流。
    const wsMeta = agent?.workspace_sessions || {};
    const loadedCount = Array.isArray(wsMeta.sessions) ? wsMeta.sessions.length : 0;
    const sessionTotal = Number(wsMeta.sessionTotal);
    const mainTabCount = Number.isFinite(Number(wsMeta.mainTotal)) ? Number(wsMeta.mainTotal) : mainSessions.length;
    const archivedTabCount = Number.isFinite(Number(wsMeta.archivedTotal)) ? Number(wsMeta.archivedTotal) : archivedSessions.length;
    const hasMore = Number.isFinite(sessionTotal) && loadedCount < sessionTotal;
    const loadMoreBtnHtml = hasMore
      ? '<div class="ph-load-more-wrap"><button class="workspace-action secondary ph-load-more-btn" type="button" data-action="sessions.loadMore">' + escapeHtml(isZh ? '加载更多（已显示 ' + loadedCount + ' / ' + sessionTotal + '）' : 'Load more (' + loadedCount + ' / ' + sessionTotal + ')') + '</button></div>'
      : '';
    const searchIdentity = {
      identity: viewIdentity,
      // 搜索归属（045）：项目目标按 projectId（服务端互斥），目录目标按
      // openDirectory；dataset 的 search-project-id 只在项目目标携带 prj_ id。
      openDirectory: (currentProject.type === 'project' ? '' : (currentProject.openDirectory || '')),
      remoteOnly: currentProject.remoteOnly === true,
      projectId: (currentProject.type === 'project' ? currentProject.id : ''),
    };
    const searchData = ' data-search-agent-id="' + escapeHtml(viewIdentity)
      + '" data-search-directory="' + escapeHtml(searchIdentity.openDirectory)
      + '" data-search-remote="' + String(currentProject.remoteOnly === true)
      + '" data-search-project-id="' + escapeHtml(searchIdentity.projectId)
      + '" data-search-host-id="' + escapeHtml(agent.id) + '"';
    sessionsHtml += '<div class="ph-session-tabs' + (isSearching ? ' searching' : '') + '" data-tab-group="' + tabId + '"' + searchData + '>';
    sessionsHtml += '<div class="ph-session-tab-bar">';
    sessionsHtml += '<div class="ph-session-tabs-row">';
    sessionsHtml += '<button class="ph-session-tab active" data-ph-tab="main" data-action="sessions.switchTab">' + escapeHtml(t('workspace_main_conversations')) + ' <span class="ph-tab-count">' + escapeHtml(String(mainTabCount)) + '</span></button>';
    sessionsHtml += '<button class="ph-session-tab" data-ph-tab="archived" data-action="sessions.switchTab">' + escapeHtml(t('workspace_archived_conversations')) + ' <span class="ph-tab-count">' + escapeHtml(String(archivedTabCount)) + '</span></button>';
    sessionsHtml += '<button class="ph-session-tab" data-ph-tab="topics" data-action="sessions.switchTab">' + escapeHtml(isZh ? '主题' : 'Topics') + '</button>';
    sessionsHtml += '</div>';
    sessionsHtml += '<div class="ph-session-toolbar">';
    sessionsHtml += '<div class="ph-session-search-inline">';
    sessionsHtml += '<svg class="ph-search-icon" width="13" height="13" viewBox="0 0 14 14" fill="none"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.3"/><path d="M9.5 9.5L12.5 12.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
    sessionsHtml += '<input type="text" class="ph-search-input" placeholder="' + escapeHtml(isZh ? '搜索对话内容...' : 'Search conversations...') + '" value="' + escapeHtml(phSessionUi.phSearchQuery) + '" data-action="sessions.searchInput" data-event="input keydown">';
    sessionsHtml += '<button class="ph-search-clear-btn" type="button" data-action="sessions.clearSearch" title="' + escapeHtml(isZh ? '清除搜索' : 'Clear search') + '"' + (isSearching ? '' : ' style="display:none"') + '><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>';
    sessionsHtml += '</div>';
    sessionsHtml += '<div class="ph-session-sort-toggle"><button type="button" data-action="sessions.toggleSort" title="' + escapeHtml(isZh ? '切换排序方式' : 'Toggle sort order') + '"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 2v8M3 10L1.5 8.5M3 10l1.5-1.5M9 10V2M9 2L7.5 3.5M9 2l1.5 1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' + escapeHtml(phSessionUi.phSessionSortMode === 'createdAt' ? t('workspace_sort_created') : t('workspace_sort_updated')) + '</button></div>';
    // 会话多选入口（「移动到…」批量路径，本地 PH only）
    if (agent.id === 'programming-helper' && currentProject && !currentProject.remoteOnly) {
      if (moveState?.selectMode === true) {
        const selectedIds = Array.from(moveState.selected);
        sessionsHtml += '<div class="ph-session-select-controls active">'
          + '<span class="ph-select-count">' + escapeHtml(String(selectedIds.length)) + ' ' + escapeHtml(isZh ? '已选' : 'selected') + '</span>'
          + '<button type="button" class="ph-select-move-btn" data-action="sessions.openMoveDialog">' + escapeHtml(isZh ? '移动到…' : 'Move to…') + '</button>'
          + '<button type="button" class="ph-select-exit-btn" data-action="sessions.toggleSelectMode">' + escapeHtml(isZh ? '退出多选' : 'Done') + '</button>'
          + '</div>';
      } else {
        sessionsHtml += '<div class="ph-session-select-controls">'
          + '<button type="button" class="ph-select-toggle-btn" data-action="sessions.toggleSelectMode">' + escapeHtml(isZh ? '多选' : 'Select') + '</button>'
          + '</div>';
      }
    }
    sessionsHtml += '</div>';
    sessionsHtml += '</div>';
    sessionsHtml += '<div class="ph-session-tab-panels">';
    sessionsHtml += '<div class="ph-session-tab-panel active" data-ph-panel="main"><div class="feature-project-session-list">' + (mainSessions.length > 0 ? renderPhSessionsWithGroups(mainSessions, 'main') + loadMoreBtnHtml : mainEmptyNote) + '</div></div>';
    sessionsHtml += '<div class="ph-session-tab-panel" data-ph-panel="archived"><div class="feature-project-session-list">' + (archivedSessions.length > 0 ? renderPhSessionsWithGroups(archivedSessions, 'archived') + loadMoreBtnHtml : archivedEmptyNote + (hasMore ? loadMoreBtnHtml : '')) + '</div></div>';
    // 面板初始内容按 topic 状态键取（未加载占位/在途加载中/已加载缓存卡片）：
    // 工作区 innerHTML 重建（轮询、切回）不会把已加载的数据闪回占位文案。
    const topicPanelInner = phTopicPanelInnerHtml(agent.id, searchIdentity.projectId, searchIdentity.openDirectory);
    sessionsHtml += '<div class="ph-session-tab-panel" data-ph-panel="topics"><div class="ph-topic-panel" data-topic-agent-id="' + escapeHtml(agent.id) + '" data-topic-project-id="' + escapeHtml(searchIdentity.projectId) + '" data-topic-directory="' + escapeHtml(searchIdentity.openDirectory) + '">' + topicPanelInner + '</div></div>';
    sessionsHtml += '</div>';
    sessionsHtml += '<div class="ph-search-panel">';
    sessionsHtml += _buildPhSearchPanelHtml(searchIdentity);
    sessionsHtml += '</div>';
    sessionsHtml += '</div>';
  } else {
    const emptyNote = '<div class="feature-project-empty-note">' + escapeHtml(t('workspace_feature_no_sessions')) + '</div><div class="feature-project-empty-actions"><button class="workspace-action" type="button" data-workspace-action="' + newChatAction + '" data-action="sessions.workspaceActionEvent">' + escapeHtml(t('workspace_new_chat')) + '</button></div>';
    sessionsHtml = '<div class="feature-project-session-group"><div class="feature-project-session-list">' + (mainSessions.length > 0 ? renderPhSessionsWithGroups(mainSessions, 'main') : emptyNote) + '</div></div>';
  }

  // Schedule async open-sessions recovery card（归属随目标：项目目标传
  // projectId，目录目标传目录；卡片内部按完整归属过滤）
  setTimeout(() => phLoadOpenSessionsCard(agent.id, currentProject.openDirectory, currentProject.id), 0);

  return [
    bannerHtml,
    headerBar,
    '<div id="ph-open-sessions-container">' + (_phOpenSessionsCache.html || '') + '</div>',
    '<section class="workspace-section">',
    sessionsHtml,
    '</section>',
  ].join('');
}

// ── Generic / Fallback ───────────────────────────────────────────

function _renderGenericSessionList(agent, block, ctx) {
  const { sessions, isFeatureCreator, activeSessionId, title, desc, headerAction } = ctx;

  let bodyHtml = '<div class="workspace-history-list"><div class="workspace-history-item"><div>' + escapeHtml(t('workspace_history_empty')) + '</div></div></div>';
  if (sessions.length > 0) {
    bodyHtml = '<div class="workspace-history-list">' + sessions.map((session) => {
      const openAction = escapeHtml(JSON.stringify({ type: 'open_session', sessionId: session.id }));
      const newChatAction = escapeHtml(JSON.stringify({
        type: 'create_session_from_session',
        sessionId: session.id,
        featureName: session.featureName || '',
        openDirectory: session.openDirectory || '',
      }));
      const compactedResumeAction = escapeHtml(JSON.stringify({
        type: 'compacted_resume_session',
        sessionId: session.id,
      }));
      const primaryTitle = isFeatureCreator
        ? getFeatureSessionDisplayName(session, agent)
        : (session.title || session.id);
      const isAssembly = isAssemblySession(session);
      const allowCompactedResume = !isAssembly;
      // data-ctx-* enables the declarative ctx-menu (ADR-0049): item
      // family follows the sessionOps fact, assembly variant excludes
      // continuity submenu items.
      const ctxVariant = isAssembly ? 'assembly' : 'default';
      return [
        '<div class="workspace-history-item" data-prebuilt-session-agent-id="' + escapeHtml(agent.id) + '" data-prebuilt-session-id="' + escapeHtml(session.id) + '" data-ctx-role="session" data-ctx-ns="' + escapeHtml(agent.id) + '" data-ctx-id="' + escapeHtml(session.id) + '" data-ctx-variant="' + escapeHtml(ctxVariant) + '">',
        '<div class="workspace-history-main">',
        '<div class="workspace-history-title-row">',
        '<div class="workspace-history-title" data-action="sessions.titleDblClick" title="' + escapeHtml(getCurrentLanguage() === 'zh' ? '双击编辑标题' : 'Double-click to edit title') + '">' + escapeHtml(primaryTitle) + '</div>',
        renderSessionResumeBadge(session),
        renderSessionThreadBadge(agent.id, session),
        session.id === activeSessionId ? '<span class="workspace-history-active">当前</span>' : '',
        renderSessionArchivedBadge(session),
        renderSessionTitleAiButton(session),
        '</div>',
        '<div class="workspace-history-meta">' + escapeHtml(formatWorkspaceDate(session.updatedAt)) + '</div>',
        session.preview ? '<div class="workspace-history-preview">' + escapeHtml(session.preview) + '</div>' : '',
        renderSessionTokenBar(session, agent),
        '</div>',
        '<div class="workspace-history-side">',
        '<div class="workspace-history-meta compact">',
        escapeHtml(t('workspace_history_messages')) + ': ' + escapeHtml(String(session.messageCount ?? 0)),
        (session.openDirectory ? '<br>' + escapeHtml(session.openDirectory) : ''),
        '</div>',
        '<div class="workspace-actions stacked">',
        '<button class="workspace-action" type="button" data-workspace-action="' + openAction + '" data-action="sessions.workspaceAction">' + escapeHtml(t('workspace_open_chat')) + '</button>',
        (allowCompactedResume
          ? '<button class="workspace-action secondary" type="button" data-workspace-action="' + compactedResumeAction + '" data-action="sessions.workspaceAction">' + escapeHtml(t('workspace_light_resume')) + '</button>'
          : ''),
        (isFeatureCreator && viewCapabilityEnabled(agent.id, 'workspaceCreate')
          ? '<button class="workspace-action secondary" type="button" data-workspace-action="' + newChatAction + '" data-action="sessions.workspaceAction">' + escapeHtml(t('workspace_new_chat')) + '</button>'
          : ''),
        '</div>',
        '</div>',
        '</div>',
      ].join('');
    }).join('') + '</div>';
  }

  return [
    '<section class="workspace-section">',
    '<div class="workspace-section-header">',
    '<div>',
    '<div class="workspace-section-title">' + escapeHtml(title) + '</div>',
    '<div class="workspace-section-desc">' + escapeHtml(desc) + '</div>',
    '</div>',
    headerAction,
    '</div>',
    bodyHtml,
    '</section>',
  ].join('');
}

// 会话列表动作（原内联 onclick 经分发器寻址；实现分布在各宿主模块，
// 此处只做转发——session-ui / workspace-actions / ph-thread-history /
// ph-session-list / ph-project-actions / ph-session-move / app-main）
window.ClawFW.actions.registerMany({
  'sessions.titleDblClick': (el, event) => handleSessionTitleDoubleClick(event),
  'sessions.workspaceAction': (el) => window.runWorkspaceAction(el.dataset.workspaceAction, el),
  'sessions.workspaceActionEvent': (el, event) => {
    // 原 runWorkspaceActionFromEvent：preventDefault 由 handler 返回 false 统一触发
    if (event) event.preventDefault();
    window.runWorkspaceAction(el.dataset.workspaceAction, el.closest('button[data-workspace-action]') || undefined);
    return false;
  },
  'sessions.threadHistory': (el) => openThreadHistory(el.dataset.agentId, el.dataset.threadId),
  'sessions.ctxMenu': (el, event) => phShowSessionCtxMenu(event, el, el.dataset.ctxNs, el.dataset.sessionId, el.dataset.sessionType),
  'sessions.toggleSelect': (el) => phToggleSessionSelection(el.dataset.selectSessionId, el.checked),
  'sessions.switchProject': (el) => phSwitchProject(el.dataset.projectId || el.dataset.dirId),
  'sessions.openProject': () => phOpenProject(),
  'sessions.newProjectDialog': () => phOpenNewProjectDialog(),
  'sessions.manageProjects': () => phOpenManageProjectsDialog(),
  'sessions.toggleProjectDropdown': (el, event) => phToggleProjectDropdown(event),
  'sessions.openSettings': () => phOpenSettings({ initialTab: 'feature' }),
  'sessions.openModelSettings': () => phOpenSettings({ initialTab: 'model' }),
  'sessions.toggleModelSlot': () => phToggleModelSlot(),
  'sessions.loadMore': () => phLoadMoreSessions(),
  'sessions.switchTab': (el) => switchPhSessionTab(el),
  'sessions.searchInput': (el, event) => {
    if (event.type === 'keydown') { if (event.key === 'Escape') phClearSearch(); return; }
    phOnSearchInput(el.value);
  },
  'sessions.clearSearch': () => phClearSearch(),
  'sessions.toggleSort': (el) => phToggleSessionSort(el),
  'sessions.openMoveDialog': () => phOpenSessionMoveDialog(),
  'sessions.toggleSelectMode': () => phToggleSessionSelectMode(),
});

export {
  renderWorkspaceSessionList,
  onPhSessionDragStart,
  phThreadArchiveCount,
  renderSessionThreadBadge,
  phConversationArchived,
  phIsThreadArchivedMember,
  phPartitionSessions,
  renderPhSessionItemHtml,
};

// —— 桥接期兼容面（kernel-state 访问器桥）——
// 保留原因：classic 消费方在调用时点以裸标识符 / window.* 取用；逐键证据：
//   renderWorkspaceSessionList ← classic app-ui（ClawHost.blocks.registerPrimitive
//     'session-list' 的渲染回调）
//   onPhSessionDragStart       ← 本模块条目内联 ondragstart 属性（字符串引用，
//     事件时点按裸标识符解析到 window）
// 已注销：phConversationArchived（classic 消费方归零——workspace-actions 验收为
//   ESM 后在文件头具名 import，成为唯一消费方）
// 零 classic 消费面、只作命名导出（不上桥）：renderPhSessionItemHtml
//   （ph-session-list 已改 import）、phThreadArchiveCount
//   （ctx-menu-items 本批改 import）、renderSessionThreadBadge（本模块内部）、
//   phIsThreadArchivedMember / phPartitionSessions（本模块内部；检索/分区
//   消费方迁 ESM 时直接 import）。
// 注销条件：上列 classic 消费方迁移后改 import，删除对应 defineKey 并下调
// 桥债基线。
const bridgeApi = {
  renderWorkspaceSessionList,
  onPhSessionDragStart,
};
window.KernelState.defineKey('session-list-render', 'renderWorkspaceSessionList', renderWorkspaceSessionList);
window.KernelState.defineKey('session-list-render', 'onPhSessionDragStart', onPhSessionDragStart);
window.KernelState.claim('session-list-render', {
  get: (key) => bridgeApi[key],
  set: (key, value) => { bridgeApi[key] = value; },
});
