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
 *   window.handleSessionTitleDoubleClick, window.generateSessionTitle
 * 注意: renderWorkspaceSessionList 已迁移到 session-list-render.js
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

// ── Client-side model info cache ───────────────────────────────────
// getConnectedAgents returns light workspace_sessions without top-level
// contextLength/compressRatio. These only appear after loadAgentDetail or
// the 3-second prebuilt_sessions refresh. During the gap between data loss
// (loadAgents replacing allAgents) and recovery (next refresh), the context
// bar would flash hardcoded defaults. This cache bridges that gap by
// remembering the last known-good values per agentId.
var _modelInfoCache = {};

function _resolveAgentKey(agent) {
  if (!agent) return null;
  return agent.id || agent.runtime_session_id || agent.runtimeSessionId || null;
}

function getSessionContextLength(session, agent) {
  const cl = session?.contextLength;
  if (Number.isFinite(cl) && cl > 0) {
    _cacheModelInfo(agent, cl, null);
    return cl;
  }
  const fallback = agent?.workspace_sessions?.contextLength;
  if (Number.isFinite(fallback) && fallback > 0) {
    _cacheModelInfo(agent, fallback, null);
    return fallback;
  }
  // Last resort: check the persistent cache before hardcoded default
  var key = _resolveAgentKey(agent);
  if (key && _modelInfoCache[key] && Number.isFinite(_modelInfoCache[key].contextLength) && _modelInfoCache[key].contextLength > 0) {
    return _modelInfoCache[key].contextLength;
  }
  return 200000;
}

function getSessionCompressRatio(session, agent) {
  const cr = session?.compressRatio;
  if (Number.isFinite(cr) && cr > 0 && cr <= 100) {
    _cacheModelInfo(agent, null, cr);
    return cr;
  }
  const fallback = agent?.workspace_sessions?.compressRatio;
  if (Number.isFinite(fallback) && fallback > 0 && fallback <= 100) {
    _cacheModelInfo(agent, null, fallback);
    return fallback;
  }
  var key = _resolveAgentKey(agent);
  if (key && _modelInfoCache[key] && Number.isFinite(_modelInfoCache[key].compressRatio) && _modelInfoCache[key].compressRatio > 0) {
    return _modelInfoCache[key].compressRatio;
  }
  return 80;
}

function _cacheModelInfo(agent, contextLength, compressRatio) {
  var key = _resolveAgentKey(agent);
  if (!key) return;
  if (!_modelInfoCache[key]) _modelInfoCache[key] = {};
  if (Number.isFinite(contextLength) && contextLength > 0) {
    _modelInfoCache[key].contextLength = contextLength;
  }
  if (Number.isFinite(compressRatio) && compressRatio > 0 && compressRatio <= 100) {
    _modelInfoCache[key].compressRatio = compressRatio;
  }
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
// renderWorkspaceSessionList 已迁移到 session-list-render.js

// ── Open Sessions Recovery Card ──────────────────────────────────

/**
 * Module-level cache for the open-sessions card.
 *
 * The workspace surface HTML is rebuilt on every poll when any session data
 * changes (token usage, relative timestamps, etc.).  Because the
 * #ph-open-sessions-container div lives inside that HTML string, it is
 * destroyed and recreated empty on every rebuild.  Previously the dedup
 * signature was stored on the DOM element, so it was lost on every rebuild
 * — the card vanished then reappeared after fetch, causing visible flicker.
 *
 * By keeping both the signature and the rendered HTML here (module scope),
 * we survive DOM rebuilds: the cached HTML is baked directly into the
 * workspace string so the card is present immediately after rebuild, and
 * the async fetch only fires when data actually changes.
 */
var _phOpenSessionsCache = { sig: null, html: '' };

window.phLoadOpenSessionsCard = async function(agentId, openDirectory) {
  const container = document.getElementById('ph-open-sessions-container');
  if (!container) return;

  try {
    const resp = await fetch('/protoclaw/open_sessions?agentId=' + encodeURIComponent(agentId));
    if (!resp.ok) return;
    const data = await resp.json();
    const allOpen = Array.isArray(data.sessions) ? data.sessions : [];

    // Filter by current project's openDirectory (normalized comparison)
    const normDir = String(openDirectory || '').replace(/\\/g, '/').toLowerCase();
    const projectSessions = allOpen.filter((s) => {
      const sDir = String(s.openDirectory || '').replace(/\\/g, '/').toLowerCase();
      return sDir === normDir;
    });

    // Exclude sessions that already have a running runtime
    const runningSessionIds = new Set(
      (allAgents || [])
        .filter((a) => a.runtime_session_id && a.connected)
        .map((a) => String(a.runtime_session_id))
    );
    const toRestore = projectSessions.filter((s) => !runningSessionIds.has(String(s.sessionId)));

    // Dedup via module-level signature (survives DOM rebuilds)
    const isZh = currentLanguage === 'zh';
    const sig = isZh + '|' + toRestore.map((s) => s.sessionId + ':' + (s.title || '') + ':' + (s.updatedAt || '')).sort().join(',');
    if (_phOpenSessionsCache.sig === sig) return; // data unchanged
    _phOpenSessionsCache.sig = sig;

    if (toRestore.length === 0) {
      _phOpenSessionsCache.html = '';
      if (container.innerHTML) container.innerHTML = '';
      return;
    }

    _phOpenSessionsCache.html = window._buildPhOpenSessionsCardHtml(toRestore, isZh, agentId);
    container.innerHTML = _phOpenSessionsCache.html;
  } catch {
    _phOpenSessionsCache.sig = null;
    _phOpenSessionsCache.html = '';
    if (container.innerHTML) container.innerHTML = '';
  }
};

window._buildPhOpenSessionsCardHtml = function(sessions, isZh, agentId) {
  const itemsHtml = sessions.map((s) => {
    const timeStr = s.updatedAt ? formatWorkspaceDate(s.updatedAt) : '';
    const title = s.title || s.sessionId;
    return [
      '<div class="ph-open-session-item" data-session-id="' + escapeHtml(s.sessionId) + '">',
      '<div class="ph-open-session-dot"></div>',
      '<div class="ph-open-session-info">',
      '<div class="ph-open-session-title">' + escapeHtml(title) + '</div>',
      (timeStr ? '<div class="ph-open-session-meta">' + escapeHtml(timeStr) + '</div>' : ''),
      '</div>',
      '<button class="ph-open-session-enter" type="button" onclick="window.phRestoreOneOpenSession(\'' + escapeHtml(agentId) + '\', \'' + escapeHtml(s.sessionId) + '\', this)">' + escapeHtml(isZh ? '进入对话' : 'Open') + '</button>',
      '</div>',
    ].join('');
  }).join('');

  const count = sessions.length;
  const allIds = sessions.map((s) => s.sessionId);
  return [
    '<div class="ph-open-sessions-card">',
    '<div class="ph-open-sessions-header">',
    '<div class="ph-open-sessions-title">',
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM8 4v4l2.5 2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    '<span>' + escapeHtml(isZh ? '上次未关闭的会话 (' + count + ')' : 'Unclosed sessions (' + count + ')') + '</span>',
    '</div>',
    '<div class="ph-open-sessions-actions">',
    (count > 1 ? '<button class="ph-open-sessions-restore-all" type="button" onclick="window.phRestoreAllOpenSessions(\'' + escapeHtml(agentId) + '\', ' + escapeHtml(JSON.stringify(allIds)) + ', this)">' + escapeHtml(isZh ? '全部恢复' : 'Restore All') + '</button>' : ''),
    '<button class="ph-open-sessions-dismiss" type="button" title="' + escapeHtml(isZh ? '关闭' : 'Dismiss') + '" onclick="window.phDismissOpenSessions(\'' + escapeHtml(agentId) + '\', this)"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>',
    '</div>',
    '</div>',
    '<div class="ph-open-sessions-body">',
    itemsHtml,
    '</div>',
    '</div>',
  ].join('');
};

window.phRestoreOneOpenSession = async function(agentId, sessionId, btnEl) {
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = '...';
  }
  try {
    // Use existing open_session action to activate + start runtime
    window.runWorkspaceAction(JSON.stringify({ type: 'open_session', sessionId }), btnEl);
    // Remove the item from the card
    const item = btnEl?.closest('.ph-open-session-item');
    if (item) item.remove();
    // If no more items, hide the card
    const card = document.querySelector('.ph-open-sessions-card');
    if (card && !card.querySelector('.ph-open-session-item')) {
      card.style.display = 'none';
    }
    // Sync cache: capture remaining DOM state, force next fetch to verify
    var container = document.getElementById('ph-open-sessions-container');
    _phOpenSessionsCache.html = (container && container.querySelector('.ph-open-session-item')) ? container.innerHTML : '';
    _phOpenSessionsCache.sig = null;
  } catch (err) {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = currentLanguage === 'zh' ? '进入对话' : 'Open';
    }
  }
};

window.phRestoreAllOpenSessions = async function(agentId, sessionIds, btnEl) {
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = currentLanguage === 'zh' ? '恢复中...' : 'Restoring...';
  }
  try {
    const resp = await fetch('/protoclaw/open_sessions/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, sessionIds }),
    });
    const data = await resp.json();
    // Reload agent data to reflect newly started runtimes
    if (typeof loadAgents === 'function') {
      await loadAgents();
    }
    // Hide the card
    const card = document.querySelector('.ph-open-sessions-card');
    if (card) card.style.display = 'none';
    // Clear cache so workspace rebuilds don't bring the card back
    _phOpenSessionsCache.html = '';
    _phOpenSessionsCache.sig = null;
  } catch (err) {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = currentLanguage === 'zh' ? '全部恢复' : 'Restore All';
    }
  }
};

window.phDismissOpenSessions = async function(agentId, btnEl) {
  try {
    await fetch('/protoclaw/open_sessions/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId }),
    });
  } catch { /* non-critical */ }
  const card = btnEl?.closest('.ph-open-sessions-card');
  if (card) card.remove();
  // Clear cache so workspace rebuilds don't bring the card back
  _phOpenSessionsCache.html = '';
  _phOpenSessionsCache.sig = null;
};
