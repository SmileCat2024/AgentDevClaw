/**
 * ph-session-list.js — PH 会话列表 UI 交互
 * 从 app-main.js 拆出（S+A3）
 * 拆出日期：2026-07-13
 *
 * 依赖全局状态（定义在 app-core.js）:
 *   currentLanguage
 *   phSearchQuery, phSearchResults, phSearchLoading, phSearchTab
 *   _phSearchTimer, savedPhTabState, phSessionSortMode
 * 依赖全局函数:
 *   getCurrentAgentRecord (app-main.js)
 *   renderCurrentMainView (app-ui.js)
 *   escapeHtml, t (app-core.js)
 *   getAgentWorkspaceState (app-ui.js)
 *   getCtxMenuItems (modules/ctx-menu-items.js)
 *   closeCtxMenu, showCtxMenu (modules/context-menu.js)
 *   closeAgentContextMenu, closeSessionContextMenu,
 *   closeCompactMenu, closeProjectContextMenu (app-ui.js)
 * window 函数:
 *   switchPhSessionTab, phToggleSessionSort,
 *   _buildPhSearchPanelHtml, _updatePhSearchPanelDom,
 *   phOnSearchInput, phClearSearch, phShowSessionCtxMenu
 * HTML onclick 引用:
 *   onclick="window.switchPhSessionTab(this)"
 *   onclick="window.phToggleSessionSort(this)"
 *   oninput="window.phOnSearchInput(this.value)"
 *   onclick="window.phClearSearch()"
 *   onclick="window.phShowSessionCtxMenu(event, this, ...)"
 */

window.switchPhSessionTab = (btn) => {
  const tabGroup = btn.closest('.ph-session-tabs');
  if (!tabGroup) return;
  const targetTab = btn.dataset.phTab;
  // Update active tab indicator (visible when search is cleared later)
  tabGroup.querySelectorAll('.ph-session-tab').forEach((t) => t.classList.toggle('active', t.dataset.phTab === targetTab));
  if (tabGroup.dataset.tabGroup) {
    savedPhTabState[tabGroup.dataset.tabGroup] = targetTab;
  }
  // If currently searching, update tab filter and re-render search panel
  if (phSearchQuery.trim()) {
    phSearchTab = targetTab;
    const activeAgent = getCurrentAgentRecord();
    _updatePhSearchPanelDom(activeAgent?.id || 'programming-helper');
    return;
  }
  tabGroup.querySelectorAll('.ph-session-tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.phPanel === targetTab));
};

window.phToggleSessionSort = () => {
  phSessionSortMode = phSessionSortMode === 'createdAt' ? 'updatedAt' : 'createdAt';
  renderCurrentMainView();
};

window._buildPhSearchPanelHtml = (agentId) => {
  const isZh = currentLanguage === 'zh';
  if (!phSearchQuery.trim()) return '';
  if (phSearchLoading) {
    return '<div class="ph-search-status">' + escapeHtml(isZh ? '搜索中...' : 'Searching...') + '</div>';
  }
  if (phSearchResults === null) {
    return '<div class="ph-search-status">' + escapeHtml(isZh ? '正在构建搜索索引...' : 'Building search index...') + '</div>';
  }
  // Filter results by current tab
  const filtered = phSearchResults.filter((r) => {
    const st = r.sessionType || 'main';
    const isArchived = r.archived === true;
    if (phSearchTab === 'archived') return isArchived;
    if (phSearchTab === 'exploration') return st === 'exploration' && !isArchived;
    if (phSearchTab === 'sub') return st === 'sub' && !isArchived;
    // 'main' tab: non-archived, non-exploration, non-sub
    return !isArchived && st !== 'exploration' && st !== 'sub';
  });
  if (filtered.length === 0) {
    return '<div class="ph-search-status">' + escapeHtml(isZh ? '未找到匹配的对话' : 'No matching conversations found') + '</div>';
  }
  const queryEscaped = escapeHtml(phSearchQuery.trim());
  let html = '<div class="ph-search-status">' + escapeHtml((isZh ? '找到 ' : 'Found ') + filtered.length + (isZh ? ' 个结果' : ' results')) + '</div>';
  html += '<div class="feature-project-session-list">';
  html += filtered.map((r) => {
    const openAction = escapeHtml(JSON.stringify({ type: 'open_session', sessionId: r.sessionId }));
    let snippetHtml = escapeHtml(r.snippet);
    if (queryEscaped) {
      const safePattern = queryEscaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try {
        snippetHtml = snippetHtml.replace(new RegExp('(' + safePattern + ')', 'gi'), '<mark class="search-highlight">$1</mark>');
      } catch {}
    }
    const roleLabel = r.matchRole === 'user' ? (isZh ? '用户' : 'User') : r.matchRole === 'assistant' ? (isZh ? '助手' : 'Assistant') : '';
    return [
      '<div class="feature-project-session-item workspace-history-item ph-search-result-item" data-prebuilt-session-agent-id="' + escapeHtml(agentId) + '" data-prebuilt-session-id="' + escapeHtml(r.sessionId) + '">',
      '<div class="workspace-history-main">',
      '<div class="workspace-history-title-row">',
      '<div class="workspace-history-title">' + escapeHtml(r.title || r.sessionId) + '</div>',
      roleLabel ? '<span class="ph-search-role-badge">' + escapeHtml(roleLabel) + '</span>' : '',
      '</div>',
      '<div class="ph-search-snippet">' + snippetHtml + '</div>',
      '</div>',
      '<div class="workspace-history-side">',
      '<div class="workspace-actions stacked">',
      '<button class="workspace-action" type="button" data-workspace-action="' + openAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + escapeHtml(t('workspace_open_chat')) + '</button>',
      '</div>',
      '</div>',
      '</div>',
    ].join('');
  }).join('');
  html += '</div>';
  return html;
};

function _updatePhSearchPanelDom(agentId) {
  const panel = document.querySelector('.ph-search-panel');
  if (panel) panel.innerHTML = window._buildPhSearchPanelHtml(agentId);
}

window.phOnSearchInput = (value) => {
  phSearchQuery = value || '';
  if (_phSearchTimer) {
    clearTimeout(_phSearchTimer);
    _phSearchTimer = null;
  }
  const trimmed = phSearchQuery.trim();
  const activeAgent = getCurrentAgentRecord();
  const agentId = activeAgent?.id || 'programming-helper';

  // Update clear button visibility
  const clearBtn = document.querySelector('.ph-search-clear-btn');
  if (clearBtn) clearBtn.style.display = trimmed ? 'flex' : 'none';

  if (!trimmed) {
    // Clear search via DOM toggle — no full re-render
    phSearchResults = null;
    phSearchLoading = false;
    const tabsContainer = document.querySelector('.ph-session-tabs');
    if (tabsContainer) tabsContainer.classList.remove('searching');
    return;
  }

  // Switch to searching mode via CSS class — no full re-render
  const tabsContainer = document.querySelector('.ph-session-tabs');
  if (tabsContainer) tabsContainer.classList.add('searching');

  // Debounce the API call
  _phSearchTimer = setTimeout(async () => {
    const wsState = getAgentWorkspaceState(activeAgent);
    const openDirectory = String(wsState?.openDirectory || '').trim();
    // Show loading state in search panel
    phSearchLoading = true;
    phSearchResults = null;
    _updatePhSearchPanelDom(agentId);
    try {
      const params = new URLSearchParams({ agentId, q: trimmed, openDirectory });
      const resp = await fetch('/protoclaw/search_sessions?' + params.toString());
      if (!resp.ok) throw new Error('search failed');
      const data = await resp.json();
      // Guard against stale results
      if (phSearchQuery.trim() !== trimmed) return;
      phSearchResults = data.results || [];
      phSearchLoading = false;
      _updatePhSearchPanelDom(agentId);
    } catch (err) {
      if (phSearchQuery.trim() !== trimmed) return;
      phSearchResults = [];
      phSearchLoading = false;
      _updatePhSearchPanelDom(agentId);
    }
  }, 300);
};

window.phClearSearch = () => {
  phSearchQuery = '';
  phSearchResults = null;
  phSearchLoading = false;
  if (_phSearchTimer) { clearTimeout(_phSearchTimer); _phSearchTimer = null; }
  const input = document.querySelector('.ph-search-input');
  if (input) input.value = '';
  const clearBtn = document.querySelector('.ph-search-clear-btn');
  if (clearBtn) clearBtn.style.display = 'none';
  const tabsContainer = document.querySelector('.ph-session-tabs');
  if (tabsContainer) tabsContainer.classList.remove('searching');
  const panel = document.querySelector('.ph-search-panel');
  if (panel) panel.innerHTML = '';
};

/**
 * Open the unified ctx-menu for a session list item (triggered by ⋯ button).
 * Equivalent to right-clicking the session item — both use getCtxMenuItems('session', ...).
 */
window.phShowSessionCtxMenu = (event, button, agentId, sessionId, variant) => {
  if (event) { event.stopPropagation(); }
  const items = getCtxMenuItems('session', agentId, variant, sessionId);
  if (items.length === 0) return;
  const rect = button.getBoundingClientRect();
  window.closeCtxMenu();
  closeAgentContextMenu();
  closeSessionContextMenu();
  closeCompactMenu();
  closeProjectContextMenu();
  window.showCtxMenu(rect.right, rect.bottom, items, { role: 'session', ns: agentId, id: sessionId, variant, sessionId });
};
