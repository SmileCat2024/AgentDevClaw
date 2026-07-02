/**
 * Session UI 模块
 * 从 app-ui.js 拆出 (workspace session 列表、标题与 token 小工具)
 *
 * 依赖全局状态 (定义在 app-core.js):
 *   allAgents, currentLanguage
 * 依赖全局函数 (定义在 app-core.js 或 app-ui.js):
 *   getCurrentAgentRecord, escapeHtml, localizeWorkspaceValue,
 *   formatWorkspaceDate, t, updateChatContextBar,
 *   getFeatureCreatorProjects, getAgentCreatorProjects, getProgrammingHelperProjects,
 *   getFeatureProjectDisplayName, getAgentProjectDisplayName,
 *   getProgrammingHelperProjectDisplayName, getAgentWorkspaceState,
 *   renderActionButton, canEnterWorkspaceChat, isAssemblySession
 * 导出全局函数:
 *   getWorkspaceSessions, getWorkspaceSessionById, isCompactedResumeSession,
 *   renderSessionResumeBadge, renderSessionTitleAiButton, getSessionContextLength,
 *   getSessionCompressRatio, renderSessionTokenBar, refreshSessionTokenCount,
 *   renderWorkspaceSessionList, window.handleSessionTitleDoubleClick,
 *   window.generateSessionTitle
 */

// ── Session Helpers ──────────────────────────────────────────────
function getWorkspaceSessions(agent = getCurrentAgentRecord()) {
  return Array.isArray(agent?.workspace_sessions?.sessions) ? agent.workspace_sessions.sessions : [];
}

function getWorkspaceSessionById(agent = getCurrentAgentRecord(), sessionId = '') {
  return getWorkspaceSessions(agent).find((session) => session.id === String(sessionId || '').trim()) || null;
}

function sortPhSessionsByMode(sessions) {
  var mode = phSessionSortMode === 'createdAt' ? 'createdAt' : 'updatedAt';
  var sorted = sessions.slice();
  sorted.sort(function (a, b) {
    // TODO sessions always sort above non-TODO sessions
    var aTodo = a?.todo === true ? 1 : 0;
    var bTodo = b?.todo === true ? 1 : 0;
    if (aTodo !== bTodo) return bTodo - aTodo;
    // Within the same TODO group, sort by the selected mode
    var primary = String(a?.[mode] || '');
    var secondaryKey = mode === 'createdAt' ? 'updatedAt' : 'createdAt';
    if (primary !== String(b?.[mode] || '')) {
      return String(b?.[mode] || '').localeCompare(primary);
    }
    var aSec = String(a?.[secondaryKey] || '');
    var bSec = String(b?.[secondaryKey] || '');
    if (aSec !== bSec) return bSec.localeCompare(aSec);
    return String(b?.id || '').localeCompare(String(a?.id || ''));
  });
  return sorted;
}

function isCompactedResumeSession(session) {
  return String(session?.metadata?.resumeMode || '').trim() === 'compacted';
}

function renderSessionResumeBadge(session) {
  return '';
}

function renderSessionArchivedBadge(session) {
  if (!session || session.archived !== true) return '';
  var isZh = currentLanguage === 'zh';
  return '<span class="workspace-history-archived">' + escapeHtml(isZh ? '已归档' : 'Archived') + '</span>';
}

function renderSessionTodoBadge(session) {
  if (!session || session.todo !== true) return '';
  var isZh = currentLanguage === 'zh';
  return '<span class="workspace-history-todo">' + escapeHtml(isZh ? '待办' : 'TODO') + '</span>';
}

function renderSessionTitleAiButton(session) {
  var isZh = currentLanguage === 'zh';
  return '<button class="session-title-ai-btn session-title-ai-btn-hidden" type="button" title="' + escapeHtml(isZh ? 'AI 生成标题' : 'AI generate title') + '" onmousedown="if(this._setGenerating)this._setGenerating(true);" onclick="event.stopPropagation();window.generateSessionTitle(\'' + escapeHtml(session.id) + '\',this)" aria-label="' + escapeHtml(isZh ? 'AI 生成标题' : 'AI generate title') + '"><span class="session-title-ai-btn-icon">✦</span><span class="session-title-ai-btn-text">' + escapeHtml(isZh ? 'AI生成' : 'AI Generate') + '</span></button>';
}

function getSessionContextLength(session, agent) {
  const cl = session?.contextLength;
  if (Number.isFinite(cl) && cl > 0) return cl;
  const fallback = agent?.workspace_sessions?.contextLength;
  if (Number.isFinite(fallback) && fallback > 0) return fallback;
  return 200000;
}

function getSessionCompressRatio(session, agent) {
  const cr = session?.compressRatio;
  if (Number.isFinite(cr) && cr > 0 && cr <= 100) return cr;
  const fallback = agent?.workspace_sessions?.compressRatio;
  if (Number.isFinite(fallback) && fallback > 0 && fallback <= 100) return fallback;
  return 80;
}

function renderSessionTokenBar(session, agent) {
  // 优先使用最后一次请求的用量，如果不存在则回退到累积值
  const lastRequest = session?.tokenUsage?.lastRequestUsage;
  const used = (lastRequest?.inputTokens || session?.tokenUsage?.totalTokens || 0);
  if (!used) return '';
  const hasExplicitCL = Number.isFinite(session?.contextLength) && session.contextLength > 0
    || Number.isFinite(agent?.workspace_sessions?.contextLength) && agent.workspace_sessions.contextLength > 0;
  if (!hasExplicitCL && !used) return '';
  const max = getSessionContextLength(session, agent);
  const pct = Math.min(100, Math.round((used / max) * 100));
  const compressRatio = getSessionCompressRatio(session, agent);
  const isCompressed = pct >= compressRatio;
  const tone = isCompressed ? 'compress' : pct < 50 ? 'low' : pct < compressRatio ? 'mid' : 'high';
  const modelLabel = session?.modelName ? ' · ' + session.modelName : '';
  // 如果使用的是累积值（没有lastRequestUsage），添加标注
  const dataSource = lastRequest ? '' : ' (累积)';
  // 刷新按钮已移除：用量信息现在在运行过程中实时更新，不再依赖手动刷新
  return '<span class="session-token-inline tone-' + tone + '">'
    + '<span class="session-token-bar"><span class="session-token-compress-zone" style="left:' + compressRatio + '%"></span><span class="session-token-bar-fill" style="width:' + pct + '%"></span></span>'
    + '<span class="session-token-pct">' + pct + '%' + modelLabel + dataSource + '</span>'
    + '</span>';
}

// ── Session Token / Title Actions ─────────────────────────────────
async function refreshSessionTokenCount(sessionId, agentId, btnElement) {
  if (!btnElement) return;
  const originalContent = btnElement.innerHTML;
  btnElement.innerHTML = '⟳';
  btnElement.classList.add('loading');
  btnElement.disabled = true;
  
  try {
    const response = await fetch('/protoclaw/refresh_session_token_count', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, agentId }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText || 'Failed to refresh token count');
    }
    
    const result = await response.json();
    
    if (result.success) {
      // 局部更新：只刷新 token 用量显示，不触发全量渲染（避免滚动位置丢失）
      var agent = typeof getCurrentAgentRecord === 'function' ? getCurrentAgentRecord() : null;
      if (agent) {
        var sessions = agent.workspace_sessions && agent.workspace_sessions.sessions || [];
        var target = sessions.find(function(s) { return s.id === sessionId; });
        if (target) {
          if (!target.tokenUsage) target.tokenUsage = {};
          target.tokenUsage.lastRequestUsage = {
            inputTokens: result.tokenCount,
            totalTokens: result.tokenCount,
          };
        }
      }
      // 更新顶部 context bar
      if (typeof updateChatContextBar === 'function') {
        updateChatContextBar();
      }
      // 更新 workspace surface 中的 session token bar（局部替换）
      var tokenBarEl = btnElement && btnElement.closest('.session-token-inline');
      if (agent && tokenBarEl) {
        var sessions2 = agent.workspace_sessions && agent.workspace_sessions.sessions || [];
        var activeId = (agent.workspace_sessions && agent.workspace_sessions.activeSessionId)
          || agent.active_workspace_session_id;
        var sess = sessionId ? sessions2.find(function(s) { return s.id === sessionId; }) : null;
        if (sess && typeof renderSessionTokenBar === 'function') {
          var newBar = renderSessionTokenBar(sess, agent);
          if (newBar) {
            var temp = document.createElement('span');
            temp.innerHTML = newBar;
            var replacement = temp.firstElementChild;
            if (replacement) tokenBarEl.replaceWith(replacement);
          }
        }
      }
    } else {
      // 显示错误信息
      window.alert(result.error || (currentLanguage === 'zh' ? '刷新失败' : 'Refresh failed'));
    }
  } catch (error) {
    console.error('Failed to refresh token count:', error);
    window.alert((currentLanguage === 'zh' ? '刷新 Token 计数失败: ' : 'Failed to refresh token count: ') + error.message);
  } finally {
    // 恢复按钮状态
    btnElement.innerHTML = originalContent;
    btnElement.classList.remove('loading');
    btnElement.disabled = false;
  }
}

window.generateSessionTitle = async function(sessionId, btnElement) {
  if (!btnElement) return;
  
  var isZh = currentLanguage === 'zh';
  var generated = false;
  var originalContent = btnElement.innerHTML;
  var toastId = 'title-gen-' + sessionId;
  btnElement.innerHTML = '<span class="session-title-ai-btn-icon">✦</span><span class="session-title-ai-btn-text">' + (isZh ? '生成中...' : 'Generating...') + '</span>';
  btnElement.classList.add('loading');
  btnElement.disabled = true;
  ClawToast.show({
    id: toastId,
    title: isZh ? '正在生成标题...' : 'Generating title...',
    status: 'loading',
  });
  
  // Set generating flag to prevent closing
  if (btnElement._setGenerating) {
    btnElement._setGenerating(true);
  }

  try {
    var sessionItem = btnElement.closest('[data-prebuilt-session-agent-id]');
    var agentId = sessionItem ? sessionItem.dataset.prebuiltSessionAgentId : '';
    if (!agentId) throw new Error('Agent ID not found');

    var response = await fetch('/protoclaw/generate_session_title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, sessionId }),
    });

    if (!response.ok) {
      var errorText = await response.text();
      throw new Error(errorText || 'Failed to generate title');
    }

    var result = await response.json();
    if (result.ok && result.title) {
      var titleRow = btnElement.closest('.workspace-history-title-row');
      if (titleRow) {
        var titleEl = titleRow.querySelector('.workspace-history-title');
        if (titleEl) titleEl.textContent = result.title;
        // Exit edit mode: restore the input to plain text div
        var input = titleRow.querySelector('.session-title-edit-input');
        if (input) {
          var titleDiv = input.closest('.workspace-history-title');
          if (titleDiv) titleDiv.textContent = result.title;
        }
      }
      var agent = typeof getCurrentAgentRecord === 'function' ? getCurrentAgentRecord() : null;
      if (agent) {
        var sessions = agent.workspace_sessions && agent.workspace_sessions.sessions || [];
        var target = sessions.find(function(s) { return s.id === sessionId; });
        if (target) target.title = result.title;
      }
      generated = true;
      ClawToast.update(toastId, {
        status: 'success',
        title: isZh ? '标题已生成' : 'Title generated',
        description: result.title,
      });
    } else {
      ClawToast.update(toastId, {
        status: 'error',
        title: isZh ? '生成标题失败' : 'Title generation failed',
        description: isZh ? '未返回有效标题' : 'No valid title returned',
      });
    }
  } catch (error) {
    console.error('Failed to generate session title:', error);
    ClawToast.update(toastId, {
      status: 'error',
      title: isZh ? '生成标题失败' : 'Title generation failed',
      description: error.message || String(error),
    });
  } finally {
    btnElement.innerHTML = originalContent;
    btnElement.classList.remove('loading');
    btnElement.disabled = false;
    // Reset generating flag
    if (btnElement._setGenerating) {
      btnElement._setGenerating(false);
    }
    if (generated) {
      btnElement.classList.add('session-title-ai-btn-hidden');
    }
  }
};

// ── Session Title Double-Click Edit ──────────────────────────────────────────

window.handleSessionTitleDoubleClick = function(event) {
  event.preventDefault();
  event.stopPropagation();

  const titleDiv = event.currentTarget;
  const sessionItem = titleDiv.closest('[data-prebuilt-session-id]');
  if (!sessionItem) return;

  const sessionId = sessionItem.dataset.prebuiltSessionId;
  const agentId = sessionItem.dataset.prebuiltSessionAgentId;
  if (!sessionId || !agentId) return;

  const currentTitle = titleDiv.textContent.trim();
  const isSessionId = currentTitle.startsWith('session-');

  // Show AI generate button when entering edit mode
  const titleRow = titleDiv.closest('.workspace-history-title-row');
  const aiButton = titleRow ? titleRow.querySelector('.session-title-ai-btn') : null;
  if (aiButton) {
    aiButton.classList.remove('session-title-ai-btn-hidden');
  }

  titleDiv.innerHTML = '<input type="text" class="session-title-edit-input" value="' + escapeHtml(isSessionId ? '' : currentTitle) + '" placeholder="' + escapeHtml(currentLanguage === 'zh' ? '输入对话标题' : 'Enter session title') + '">';

  const input = titleDiv.querySelector('input');
  input.focus();
  input.select();

  let saved = false;
  let isGeneratingTitle = false;
  
  const saveTitle = async () => {
    if (saved || isGeneratingTitle) return;
    saved = true;
    const newTitle = input.value.trim();
    if (!newTitle || newTitle === currentTitle) {
      titleDiv.textContent = currentTitle || sessionId;
      // Hide AI button when exiting edit mode
      if (aiButton) {
        aiButton.classList.add('session-title-ai-btn-hidden');
      }
      return;
    }
    try {
      const resp = await fetch('/protoclaw/prebuilt_sessions/' + encodeURIComponent(sessionId) + '/title', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, title: newTitle }),
      });
      const result = await resp.json();
      if (result.ok) {
        titleDiv.textContent = newTitle;
        const agent = allAgents.find(a => a.id === agentId);
        if (agent?.workspace_sessions?.sessions) {
          const session = agent.workspace_sessions.sessions.find(s => s.id === sessionId);
          if (session) session.title = newTitle;
        }
      } else {
        titleDiv.textContent = currentTitle || sessionId;
        console.error('Failed to update session title:', result.error);
      }
      // Hide AI button when exiting edit mode
      if (aiButton) {
        aiButton.classList.add('session-title-ai-btn-hidden');
      }
    } catch (error) {
      titleDiv.textContent = currentTitle || sessionId;
      console.error('Failed to update session title:', error);
      // Hide AI button when exiting edit mode
      if (aiButton) {
        aiButton.classList.add('session-title-ai-btn-hidden');
      }
    }
  };

  // Store the generating flag on the button for access from generateSessionTitle
  if (aiButton) {
    aiButton._isGeneratingTitle = false;
    aiButton._setGenerating = function(generating) {
      isGeneratingTitle = generating;
      aiButton._isGeneratingTitle = generating;
    };
  }

  input.addEventListener('blur', saveTitle);
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveTitle();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (isGeneratingTitle) return; // Don't close while generating
      saved = true;
      titleDiv.textContent = currentTitle || sessionId;
      // Hide AI button when exiting edit mode
      if (aiButton) {
        aiButton.classList.add('session-title-ai-btn-hidden');
      }
    }
  });
};

// ── Workspace Session List ───────────────────────────────────────
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

  if (isFeatureCreator) {
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
                  '<div class="feature-project-session-item workspace-history-item" data-prebuilt-session-agent-id="' + escapeHtml(agent.id) + '" data-prebuilt-session-id="' + escapeHtml(session.id) + '">',
                  '<div class="workspace-history-main">',
                  '<div class="workspace-history-title-row">',
                  '<div class="workspace-history-title" ondblclick="window.handleSessionTitleDoubleClick(event)" title="' + escapeHtml(currentLanguage === 'zh' ? '双击编辑标题' : 'Double-click to edit title') + '">' + escapeHtml(session.title || session.id) + '</div>',
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
                  '<button class="workspace-action" type="button" data-workspace-action="' + openAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + escapeHtml(t('workspace_open_chat')) + '</button>',
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
            '<button class="workspace-action secondary" type="button" data-workspace-action="' + newChatAction + '" onclick="window.runWorkspaceActionFromEvent(event, this.dataset.workspaceAction)">' + escapeHtml(t('workspace_new_chat')) + '</button>',
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

  if (isAgentCreator && sessionListMode !== 'assembly') {
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
                  '<div class="feature-project-session-item workspace-history-item" data-prebuilt-session-agent-id="' + escapeHtml(agent.id) + '" data-prebuilt-session-id="' + escapeHtml(session.id) + '">',
                  '<div class="workspace-history-main">',
                  '<div class="workspace-history-title-row">',
                  '<div class="workspace-history-title" ondblclick="window.handleSessionTitleDoubleClick(event)" title="' + escapeHtml(currentLanguage === 'zh' ? '双击编辑标题' : 'Double-click to edit title') + '">' + escapeHtml(session.title || session.id) + '</div>',
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
                  '<button class="workspace-action" type="button" data-workspace-action="' + openAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + escapeHtml(t('workspace_open_chat')) + '</button>',
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
            '<button class="workspace-action secondary" type="button" data-workspace-action="' + newChatAction + '" onclick="window.runWorkspaceActionFromEvent(event, this.dataset.workspaceAction)">' + escapeHtml(t('workspace_new_chat')) + '</button>',
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

  if (agent?.id === 'programming-helper') {
    const projects = getProgrammingHelperProjects(agent);
    const wsState = getAgentWorkspaceState(agent);
    const currentOpenDir = String(wsState?.openDirectory || '').trim();
    const isZh = currentLanguage === 'zh';
    const agentName = isZh ? '编程小助手' : 'Programming Helper';

    // Determine current project — match by normalized id, not raw openDirectory,
    // because workspace_state.openDirectory and project.openDirectory may use
    // different path separators (backslash vs forward slash) or case.
    var normCurrentDir = currentOpenDir.replace(/\\/g, '/').toLowerCase();
    const currentProject = currentOpenDir
      ? projects.find(p => p.id === ('dir:' + normCurrentDir)) || null
      : (projects.length > 0 ? projects[0] : null);

    // Project header avatar
    const headerAvatar = currentProject
      ? escapeHtml((getProgrammingHelperProjectDisplayName(currentProject) || '?')[0].toUpperCase())
      : '?';
    const headerName = currentProject
      ? escapeHtml(getProgrammingHelperProjectDisplayName(currentProject))
      : (isZh ? '未打开项目' : 'No Project');

    // Dropdown items for recent projects
    const dropdownItems = projects.map((p) => {
      const pName = getProgrammingHelperProjectDisplayName(p);
      const pAvatar = escapeHtml((pName || '?')[0].toUpperCase());
      const isActive = p.id === (currentProject?.id || '');
      return [
        '<div class="ph-project-dropdown-item' + (isActive ? ' active' : '') + '" data-project-id="' + escapeHtml(p.id) + '" onclick="window.phSwitchProject(\'' + escapeHtml(p.id) + '\')">',
        '<div class="ph-project-dropdown-avatar">' + pAvatar + '</div>',
        '<div class="ph-project-dropdown-info">',
        '<div class="ph-project-dropdown-name">' + escapeHtml(pName) + '</div>',
        '<div class="ph-project-dropdown-path">' + escapeHtml(p.openDirectory) + '</div>',
        '</div>',
        '</div>',
      ].join('');
    }).join('');

    const dropdownHtml = projects.length > 1
      ? '<div class="ph-project-dropdown">' +
        '<div class="ph-project-dropdown-trigger" onclick="window.phToggleProjectDropdown(event)">' +
        '<div class="ph-project-header-avatar">' + headerAvatar + '</div>' +
        '<div class="ph-project-header-info">' +
        '<div class="ph-project-header-name">' + headerName + '</div>' +
        '</div>' +
        '<svg class="ph-project-dropdown-arrow" width="12" height="12" viewBox="0 0 12 12"><path d="M3 5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' +
        '</div>' +
        '<div class="ph-project-dropdown-menu">' + dropdownItems + '</div>' +
        '</div>'
      : '<div class="ph-project-header-static">' +
        '<div class="ph-project-header-avatar">' + headerAvatar + '</div>' +
        '<div class="ph-project-header-info">' +
        '<div class="ph-project-header-name">' + headerName + '</div>' +
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
      '<button class="ph-banner-btn secondary" type="button" onclick="window.phOpenModelConfig()">' + (isZh ? '配置模型' : 'Model Config') + '</button>',
      '<button class="ph-banner-btn" type="button" onclick="window.phOpenProject()">' + (isZh ? '打开项目' : 'Open Project') + '</button>',
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
      const presets = window.ClawFW?._modelPresets || [];
      const preset = presets.find(p => p.name === modelName);
      if (preset) {
        // 显示模型名称，如果有contextLength则显示
        const ctx = preset.contextLength ? ' · ' + Math.round(preset.contextLength / 1000) + 'K' : '';
        return preset.name + ctx;
      }
      return modelName;
    };
    
    const modelDisplayName = getModelDisplayName(primaryModel);
    const hasSecondary = !!secondaryModel;
    
    // 模型显示组件 - 简洁设计，无图标
    const modelSwitchHtml = currentProject && modelDisplayName ? [
      '<div class="ph-model-switch' + (hasSecondary ? ' has-secondary' : '') + '" onclick="window.phToggleModelSlot()" title="' + escapeHtml(isZh ? (hasSecondary ? '点击切换到: ' + secondaryModel : '点击配置备选模型') : (hasSecondary ? 'Click to switch to: ' + secondaryModel : 'Click to configure secondary model')) + '">',
      '<span class="ph-model-switch-name">' + escapeHtml(modelDisplayName) + '</span>',
      (hasSecondary ? '<svg class="ph-model-switch-arrow" width="10" height="10" viewBox="0 0 10 10"><path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' : ''),
      '</div>',
    ].join('') : '';
    
    const headerBar = [
      '<div class="ph-project-bar">',
      '<div class="ph-project-bar-left">',
      dropdownHtml,
      '</div>',
      '<div class="ph-project-bar-right">',
      modelSwitchHtml,
      (currentProject ? '<div class="ph-project-bar-path" title="' + escapeHtml(isZh ? '点击在文件管理器中打开' : 'Click to open in file explorer') + '" data-path="' + escapeHtml(currentProject.openDirectory) + '" onclick="window.phOpenInExplorer(this.dataset.path)">' + escapeHtml(currentProject.openDirectory) + '</div>' : ''),
      (currentProject ? '<button class="ph-banner-btn" type="button" data-workspace-action="' + escapeHtml(JSON.stringify({ type: 'create_session', openDirectory: currentProject.openDirectory || '' })) + '" onclick="window.runWorkspaceActionFromEvent(event, this.dataset.workspaceAction)">' + (isZh ? '新对话' : 'New Chat') + '</button>' : ''),
      '</div>',
      '</div>',
    ].join('');

    // No project state
    if (!currentProject) {
      return [
        bannerHtml,
        '<section class="workspace-section">',
        '<div class="ph-welcome">',
        '<div class="ph-welcome-icon">&#128193;</div>',
        '<div class="ph-welcome-title">' + (isZh ? '打开一个项目开始编程' : 'Open a project to start coding') + '</div>',
        '<div class="ph-welcome-desc">' + (isZh ? '选择一个本地文件夹作为工作目录，编程小助手将在该项目中协助你。' : 'Select a local folder as your workspace. The assistant will help you code within the project.') + '</div>',
        '</div>',
        '</section>',
      ].join('');
    }

    // Project is active - show its sessions with tabs
    const mainSessions = sortPhSessionsByMode(currentProject.sessions.filter(s => s.sessionType !== 'exploration' && s.sessionType !== 'sub' && s.archived !== true));
    const archivedSessions = sortPhSessionsByMode(currentProject.sessions.filter(s => s.archived === true));
    const explorationSessions = sortPhSessionsByMode(currentProject.sessions.filter(s => s.sessionType === 'exploration'));
    const subSessions = sortPhSessionsByMode(currentProject.sessions.filter(s => s.sessionType === 'sub'));
    const needsTabs = true; // 始终显示分页器，不管每个类型有没有对话
    const newChatAction = escapeHtml(JSON.stringify({
      type: 'create_session',
      openDirectory: currentProject.openDirectory || '',
    }));

    const renderPhSessionItem = (session, type) => {
      const sType = type || session.sessionType || 'main';
      const isExplorationOrSub = sType === 'exploration' || sType === 'sub';
      // Primary action button + ⋯ more menu button (equivalent to right-click ctx-menu)
      let primaryBtn = '';
      if (isExplorationOrSub) {
        const viewAction = escapeHtml(JSON.stringify({ type: 'view_session_record', sessionId: session.id, agentId: agent.id, sessionType: sType }));
        primaryBtn = '<button class="workspace-action" type="button" data-workspace-action="' + viewAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + escapeHtml(t('workspace_view_record')) + '</button>';
      } else {
        const openAction = escapeHtml(JSON.stringify({ type: 'open_session', sessionId: session.id }));
        primaryBtn = '<button class="workspace-action" type="button" data-workspace-action="' + openAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + escapeHtml(t('workspace_open_chat')) + '</button>';
      }
      const moreBtn = '<button class="workspace-action secondary session-more-btn" type="button" onclick="window.phShowSessionCtxMenu(event, this, \'' + escapeHtml(agent.id) + '\', \'' + escapeHtml(session.id) + '\', \'' + escapeHtml(sType) + '\')"><svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><circle cx="3" cy="7" r="1.3"/><circle cx="7" cy="7" r="1.3"/><circle cx="11" cy="7" r="1.3"/></svg></button>';
      const buttonsHtml = [primaryBtn, moreBtn].join('');
      return [
        '<div class="feature-project-session-item workspace-history-item" data-prebuilt-session-agent-id="' + escapeHtml(agent.id) + '" data-prebuilt-session-id="' + escapeHtml(session.id) + '" data-session-type="' + escapeHtml(sType) + '" data-ctx-role="session" data-ctx-ns="' + escapeHtml(agent.id) + '" data-ctx-id="' + escapeHtml(session.id) + '" data-ctx-variant="' + escapeHtml(sType) + '">',
        '<div class="workspace-history-main">',
        '<div class="workspace-history-title-row">',
        '<div class="workspace-history-title" ondblclick="window.handleSessionTitleDoubleClick(event)" title="' + escapeHtml(isZh ? '双击编辑标题' : 'Double-click to edit title') + '">' + escapeHtml(session.title || session.id) + '</div>',
        renderSessionResumeBadge(session),
        renderSessionTodoBadge(session),
        renderSessionArchivedBadge(session),
        renderSessionTitleAiButton(session),
        '</div>',
        '<div class="workspace-history-meta">' + escapeHtml(formatWorkspaceDate(session.updatedAt)) + '</div>',
        sType !== 'exploration' && session.preview ? '<div class="workspace-history-preview">' + escapeHtml(session.preview) + '</div>' : '',
        renderSessionTokenBar(session, agent),
        '</div>',
        '<div class="workspace-history-side">',
        '<div class="workspace-history-meta compact">' + escapeHtml(t('workspace_history_messages')) + ': ' + escapeHtml(String(session.messageCount ?? 0)) + '</div>',
        '<div class="workspace-actions stacked">',
        buttonsHtml,
        '</div>',
        '</div>',
        '</div>',
      ].join('');
    };

    let sessionsHtml = '';
    if (needsTabs) {
      const tabId = 'ph-tab-' + escapeHtml(agent.id) + '-' + escapeHtml(currentProject.id);
      const mainEmptyNote = '<div class="feature-project-empty-note">' + escapeHtml(t('workspace_feature_no_sessions')) + '</div><div class="feature-project-empty-actions"><button class="workspace-action" type="button" data-workspace-action="' + newChatAction + '" onclick="window.runWorkspaceActionFromEvent(event, this.dataset.workspaceAction)">' + escapeHtml(t('workspace_new_chat')) + '</button></div>';
      const isSearching = phSearchQuery.trim().length > 0;
      sessionsHtml += '<div class="ph-session-tabs' + (isSearching ? ' searching' : '') + '" data-tab-group="' + tabId + '">';
      sessionsHtml += '<div class="ph-session-tab-bar">';
      sessionsHtml += '<button class="ph-session-tab' + (isSearching ? '' : ' active') + '" data-ph-tab="main" onclick="window.switchPhSessionTab(this)">' + escapeHtml(t('workspace_main_conversations')) + ' <span class="ph-tab-count">' + escapeHtml(String(mainSessions.length)) + '</span></button>';
      sessionsHtml += '<button class="ph-session-tab" data-ph-tab="archived" onclick="window.switchPhSessionTab(this)">' + escapeHtml(t('workspace_archived_conversations')) + ' <span class="ph-tab-count">' + escapeHtml(String(archivedSessions.length)) + '</span></button>';
      sessionsHtml += '<button class="ph-session-tab" data-ph-tab="exploration" onclick="window.switchPhSessionTab(this)">' + escapeHtml(t('workspace_exploration_conversations')) + ' <span class="ph-tab-count">' + escapeHtml(String(explorationSessions.length)) + '</span></button>';
      sessionsHtml += '<button class="ph-session-tab" data-ph-tab="sub" onclick="window.switchPhSessionTab(this)">' + escapeHtml(t('workspace_sub_conversations')) + ' <span class="ph-tab-count">' + escapeHtml(String(subSessions.length)) + '</span></button>';
      sessionsHtml += '<div class="ph-session-toolbar">';
      sessionsHtml += '<div class="ph-session-search-inline">';
      sessionsHtml += '<svg class="ph-search-icon" width="13" height="13" viewBox="0 0 14 14" fill="none"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.3"/><path d="M9.5 9.5L12.5 12.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
      sessionsHtml += '<input type="text" class="ph-search-input" placeholder="' + escapeHtml(isZh ? '搜索对话内容...' : 'Search conversations...') + '" value="' + escapeHtml(phSearchQuery) + '" oninput="window.phOnSearchInput(this.value)" onkeydown="if(event.key===\'Escape\'){window.phClearSearch()}">';
      sessionsHtml += '<button class="ph-search-clear-btn" type="button" onclick="window.phClearSearch()" title="' + escapeHtml(isZh ? '清除搜索' : 'Clear search') + '"' + (isSearching ? '' : ' style="display:none"') + '><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>';
      sessionsHtml += '</div>';
      sessionsHtml += '<div class="ph-session-sort-toggle"><button type="button" onclick="window.phToggleSessionSort(this)" title="' + escapeHtml(isZh ? '切换排序方式' : 'Toggle sort order') + '"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 2v8M3 10L1.5 8.5M3 10l1.5-1.5M9 10V2M9 2L7.5 3.5M9 2l1.5 1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' + escapeHtml(phSessionSortMode === 'createdAt' ? t('workspace_sort_created') : t('workspace_sort_updated')) + '</button></div>';
      sessionsHtml += '</div>';
      sessionsHtml += '</div>';
      sessionsHtml += '<div class="ph-session-tab-panels">';
      sessionsHtml += '<div class="ph-session-tab-panel active" data-ph-panel="main"><div class="feature-project-session-list">' + (mainSessions.length > 0 ? mainSessions.map(s => renderPhSessionItem(s, 'main')).join('') : mainEmptyNote) + '</div></div>';
      sessionsHtml += '<div class="ph-session-tab-panel" data-ph-panel="archived"><div class="feature-project-session-list">' + (archivedSessions.length > 0 ? archivedSessions.map(s => renderPhSessionItem(s, 'archived')).join('') : '<div class="feature-project-empty-note">' + escapeHtml(t('workspace_feature_no_sessions')) + '</div>') + '</div></div>';
      sessionsHtml += '<div class="ph-session-tab-panel" data-ph-panel="exploration"><div class="feature-project-session-list">' + (explorationSessions.length > 0 ? explorationSessions.map(s => renderPhSessionItem(s, 'exploration')).join('') : '<div class="feature-project-empty-note">' + escapeHtml(t('workspace_feature_no_sessions')) + '</div>') + '</div></div>';
      sessionsHtml += '<div class="ph-session-tab-panel" data-ph-panel="sub"><div class="feature-project-session-list">' + (subSessions.length > 0 ? subSessions.map(s => renderPhSessionItem(s, 'sub')).join('') : '<div class="feature-project-empty-note">' + escapeHtml(t('workspace_feature_no_sessions')) + '</div>') + '</div></div>';
      sessionsHtml += '</div>';
      sessionsHtml += '<div class="ph-search-panel">';
      sessionsHtml += (typeof window._buildPhSearchPanelHtml === 'function' ? window._buildPhSearchPanelHtml(agent.id) : '');
      sessionsHtml += '</div>';
      sessionsHtml += '</div>';
    } else {
      const emptyNote = '<div class="feature-project-empty-note">' + escapeHtml(t('workspace_feature_no_sessions')) + '</div><div class="feature-project-empty-actions"><button class="workspace-action" type="button" data-workspace-action="' + newChatAction + '" onclick="window.runWorkspaceActionFromEvent(event, this.dataset.workspaceAction)">' + escapeHtml(t('workspace_new_chat')) + '</button></div>';
      sessionsHtml = '<div class="feature-project-session-group"><div class="feature-project-session-list">' + (mainSessions.length > 0 ? mainSessions.map(s => renderPhSessionItem(s, 'main')).join('') : emptyNote) + '</div></div>';
    }

    return [
      bannerHtml,
      headerBar,
      '<section class="workspace-section">',
      sessionsHtml,
      '</section>',
    ].join('');
  }

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
      const allowCompactedResume = !isAssemblySession(session);
      return [
        '<div class="workspace-history-item" data-prebuilt-session-agent-id="' + escapeHtml(agent.id) + '" data-prebuilt-session-id="' + escapeHtml(session.id) + '">',
        '<div class="workspace-history-main">',
        '<div class="workspace-history-title-row">',
        '<div class="workspace-history-title" ondblclick="window.handleSessionTitleDoubleClick(event)" title="' + escapeHtml(currentLanguage === 'zh' ? '双击编辑标题' : 'Double-click to edit title') + '">' + escapeHtml(primaryTitle) + '</div>',
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
        '<div class="workspace-history-meta compact">',
        escapeHtml(t('workspace_history_messages')) + ': ' + escapeHtml(String(session.messageCount ?? 0)),
        (session.openDirectory ? '<br>' + escapeHtml(session.openDirectory) : ''),
        '</div>',
        '<div class="workspace-actions stacked">',
        '<button class="workspace-action" type="button" data-workspace-action="' + openAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + escapeHtml(t('workspace_open_chat')) + '</button>',
        (allowCompactedResume
          ? '<button class="workspace-action secondary" type="button" data-workspace-action="' + compactedResumeAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + escapeHtml(t('workspace_light_resume')) + '</button>'
          : ''),
        (isFeatureCreator
          ? '<button class="workspace-action secondary" type="button" data-workspace-action="' + newChatAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + escapeHtml(t('workspace_new_chat')) + '</button>'
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
