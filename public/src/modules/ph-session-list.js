/**
 * ph-session-list.js — PH 会话列表 UI 交互
 * 从 app-main.js 拆出（S+A3）
 * 拆出日期：2026-07-13
 *
 * 依赖全局状态（定义在 app-core.js）:
 *   currentLanguage
 *   phSearchQuery, _phSearchTimer, savedPhTabState, phSessionSortMode
 * 依赖全局函数:
 *   getCurrentAgentRecord (app-main.js)
 *   renderCurrentMainView (app-ui.js)
 *   escapeHtml, t (app-core.js)
 *   getAgentWorkspaceState (app-ui.js)
 *   getCtxMenuItems (modules/ctx-menu-items.js)
 *   closeCtxMenu, showCtxMenu (modules/context-menu.js)
 *   closeAgentContextMenu, closeSessionContextMenu,
 *   closeCompactMenu, closeProjectContextMenu (app-ui.js)
 *   renderPhSessionItemHtml (modules/session-list-render.js — 正常列表与搜索共用骨架)
 * window 函数:
 *   switchPhSessionTab, phToggleSessionSort,
 *   _buildPhSearchPanelHtml, _updatePhSearchPanelDom,
 *   phOnSearchInput, phClearSearch, phShowSessionCtxMenu,
 *   phSetSearchScope, phToggleSearchSort, phSearchLoadMore,
 *   phSearchRetry, phSearchToggleExpand, phSearchResetState
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
  tabGroup.querySelectorAll('.ph-session-tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.phPanel === targetTab));
};

window.phToggleSessionSort = () => {
  phSessionSortMode = phSessionSortMode === 'createdAt' ? 'updatedAt' : 'createdAt';
  renderCurrentMainView();
};

// ── 搜索状态（模块局部；app-core 全局状态不增）──────────────────────
// 结果/范围/排序/分页/展开全部收敛在 ClawFW.phSearch。异步结果按
// （查询, agentId+openDirectory 身份, 请求代次）三重隔离：响应只在该请求
// 仍是最新代次、且身份未变时落地，连续输入不覆盖新结果。
window.ClawFW = window.ClawFW || {};
const _phSearch = window.ClawFW.phSearch = window.ClawFW.phSearch || {
  epoch: 0,
  agentId: '',
  openDirectory: '',
  projectId: '',
  scope: 'all',          // 'all' | 'main' | 'archived'
  sort: 'relevance',     // 'relevance' | 'recency'
  results: [],
  total: 0,
  limit: 20,
  loading: false,
  error: false,
  expanded: new Set(),
  homeScrollTop: 0,     // 定位进入前的工作区列表滚动位置（返回时恢复）
};

function _phSearchIdentity() {
  const root = document.querySelector('.ph-session-tabs');
  return {
    identity: root?.dataset.searchAgentId || '',
    openDirectory: root?.dataset.searchDirectory || '',
    remoteOnly: root?.dataset.searchRemote === 'true',
    projectId: root?.dataset.searchProjectId || '',
    hostAgentId: root?.dataset.searchHostId || '',
  };
}

function _phSearchStateMatches(identity) {
  return _phSearch.agentId === identity.identity
    && _phSearch.openDirectory === identity.openDirectory
    && _phSearch.projectId === identity.projectId;
}

/** Split before escaping so a match can never cut an HTML entity in half. */
function _phHighlightText(text, query) {
  const raw = String(text || '');
  if (!query) return escapeHtml(raw);
  const lower = raw.toLowerCase();
  const needle = query.toLowerCase();
  let html = '';
  let from = 0;
  let at;
  while ((at = lower.indexOf(needle, from)) >= 0) {
    html += escapeHtml(raw.slice(from, at))
      + '<mark class="search-highlight">' + escapeHtml(raw.slice(at, at + query.length)) + '</mark>';
    from = at + query.length;
  }
  return html + escapeHtml(raw.slice(from));
}

function _phReadableExcerpt(source) {
  const inline = (tokens) => (tokens || []).map((token) => {
    if (token.type === 'br') return '\n';
    if (token.type === 'image') return token.text || '';
    return token.tokens ? inline(token.tokens) : (token.text || token.raw || '');
  }).join('');
  return marked.lexer(String(source || '')).map((token) => {
    if (token.type === 'space') return '\n';
    if (token.type === 'list') return token.items.map((item) => inline(item.tokens)).join('\n');
    if (token.type === 'table') return [token.header, ...token.rows].map((row) => row.map((cell) => inline(cell.tokens)).join(' | ')).join('\n');
    return token.tokens ? inline(token.tokens) : (token.text || token.raw || '');
  }).join('\n').trim();
}

function _phRoleLabel(role) {
  const isZh = currentLanguage === 'zh';
  if (role === 'user') return isZh ? '你' : 'You';
  if (role === 'assistant') return isZh ? '助手' : 'Assistant';
  return '';
}

function _phMatchHtml(match, queryTrimmed, expanded) {
  const roleLabel = _phRoleLabel(match.role);
  const text = expanded && match.excerpt
    ? (match.excerptLeadingEllipsis ? '…' : '') + match.excerpt + (match.excerptTrailingEllipsis ? '…' : '')
    : (match.leadingEllipsis ? '…' : '') + match.snippet + (match.trailingEllipsis ? '…' : '');
  let contextHtml = '';
  if (match.context) {
    const ctxRole = _phRoleLabel(match.context.role);
    const ctxText = match.context.snippet + (match.context.truncated ? '…' : '');
    contextHtml = '<div class="ph-search-match-context">'
      + (ctxRole ? '<span class="ph-search-match-role">' + escapeHtml(ctxRole) + '</span>' : '')
      + '<span class="ph-search-match-text">' + _phHighlightText(_phReadableExcerpt(ctxText), queryTrimmed) + '</span>'
      + '</div>';
  }
  const hitHtml = '<div class="ph-search-match">'
    + (roleLabel ? '<span class="ph-search-match-role">' + escapeHtml(roleLabel) + '</span>' : '')
    + '<span class="ph-search-match-text">' + _phHighlightText(_phReadableExcerpt(text), queryTrimmed) + '</span>'
    + '</div>';
  return match.context?.relation === 'prev' ? contextHtml + hitHtml : hitHtml + contextHtml;
}

/** 搜索上下文片段区（替代普通条目的 preview + token bar）。 */
function _phSearchSnippetHtml(result, queryTrimmed) {
  const isZh = currentLanguage === 'zh';
  if (!result.matches || result.matches.length === 0) {
    return '<div class="ph-search-snippet ph-search-snippet-title-only">'
      + escapeHtml(isZh ? '标题匹配' : 'Title match') + '</div>';
  }
  const expanded = _phSearch.expanded.has(result.sessionId);
  let shown = result.matches.slice(0, 1);
  if (expanded) {
    const messages = new Map(result.matches.map((match) => [match.index, { ...match, context: null }]));
    const context = result.matches[0].context;
    if (context && Number.isInteger(context.index) && !messages.has(context.index)) {
      messages.set(context.index, { ...context, trailingEllipsis: context.truncated });
    }
    shown = [...messages.values()].sort((a, b) => a.index - b.index);
  }
  let html = shown.map((match) => '<div class="ph-search-passage">'
    + _phMatchHtml(match, queryTrimmed, expanded) + '</div>').join('');
  if (!expanded) {
    html += '<button class="ph-search-expand-btn" type="button" onclick="window.phSearchToggleExpand(\'' + escapeHtml(result.sessionId) + '\')">'
      + escapeHtml(isZh ? '展开上下文' + (result.matchCount > 1 ? ' · ' + result.matchCount + ' 条匹配消息' : '') : 'Show context' + (result.matchCount > 1 ? ' · ' + result.matchCount + ' matching messages' : ''))
      + '</button>';
  } else {
    html += '<button class="ph-search-expand-btn" type="button" onclick="window.phSearchToggleExpand(\'' + escapeHtml(result.sessionId) + '\')">'
      + escapeHtml(isZh ? '收起' : 'Collapse') + '</button>';
  }
  if (expanded && result.matchCount > result.matches.length) {
    html += '<div class="ph-search-status">' + escapeHtml(isZh ? '已展示前 ' + result.matches.length + ' 条匹配消息，可进入对话继续查看' : 'Showing the first ' + result.matches.length + ' matching messages; open the conversation for more') + '</div>';
  }
  return '<div class="ph-search-snippet' + (expanded ? ' expanded' : '') + '">' + html + '</div>';
}

function _phScopeLabel(scope) {
  const isZh = currentLanguage === 'zh';
  if (scope === 'main') return isZh ? '我的对话' : 'My Chats';
  if (scope === 'archived') return isZh ? '已归档' : 'Archived';
  return isZh ? '全部' : 'All';
}

function _phScopeTabsHtml() {
  const scopes = ['all', 'main', 'archived'];
  return '<div class="ph-search-tabs">' + scopes.map((scope) => {
    const active = _phSearch.scope === scope;
    return '<button class="ph-search-scope-tab' + (active ? ' active' : '') + '" type="button" data-scope="' + escapeHtml(scope) + '" onclick="window.phSetSearchScope(this)">' + escapeHtml(_phScopeLabel(scope)) + '</button>';
  }).join('') + '</div>';
}

function _phSortToggleHtml() {
  const isZh = currentLanguage === 'zh';
  const label = _phSearch.sort === 'relevance' ? (isZh ? '相关度' : 'Relevance') : (isZh ? '最近更新' : 'Recently updated');
  return '<button class="ph-search-sort-btn" type="button" onclick="window.phToggleSearchSort()" title="' + escapeHtml(isZh ? '切换排序方式' : 'Toggle sort order') + '">'
    + '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 2v8M3 10L1.5 8.5M3 10l1.5-1.5M9 10V2M9 2L7.5 3.5M9 2l1.5 1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    + escapeHtml(label) + '</button>';
}

function _phResultRowHtml(result, identity, agent) {
  const queryTrimmed = phSearchQuery.trim();
  const sessionLike = {
    id: result.sessionId,
    title: result.title,
    updatedAt: result.updatedAt,
    archived: result.archived === true,
    todo: result.todo === true,
    sessionType: result.sessionType || 'main',
    messageCount: result.messageCount,
  };
  const variant = result.archived === true ? 'archived' : (result.sessionType || 'main');
  const primaryIndex = (result.matches && result.matches.length > 0) ? result.matches[0].index : null;
  return window.renderPhSessionItemHtml(agent, sessionLike, {
    type: variant,
    nsId: identity.identity,
    titleHtml: _phHighlightText(result.title || result.sessionId, queryTrimmed),
    bodyHtml: _phSearchSnippetHtml(result, queryTrimmed),
    openActionExtra: {
      ...(identity.remoteOnly ? { agentId: identity.identity } : {}),
      ...(Number.isInteger(primaryIndex) ? { messageIndex: primaryIndex } : {}),
    },
    extraClasses: 'ph-search-result-item',
    disableDrag: identity.remoteOnly,
  });
}

window._buildPhSearchPanelHtml = (viewIdentity) => {
  const isZh = currentLanguage === 'zh';
  if (!phSearchQuery.trim()) return '';

  const identity = viewIdentity || _phSearchIdentity();

  if (!identity.identity) {
    return '<div class="ph-search-status">' + escapeHtml(isZh ? '远程连接不可用，无法搜索该项目' : 'Remote connection unavailable; cannot search this project') + '</div>';
  }
  if ((_phSearch.loading && _phSearch.results.length === 0) || !_phSearchStateMatches(identity)) {
    return '<div class="ph-search-status">' + escapeHtml(isZh ? '搜索中...' : 'Searching...') + '</div>';
  }
  if (_phSearch.error) {
    return [
      '<div class="ph-search-status ph-search-error">',
      escapeHtml(isZh ? '搜索失败' : 'Search failed'),
      '<button class="workspace-action secondary ph-search-retry-btn" type="button" onclick="window.phSearchRetry()">' + escapeHtml(isZh ? '重试' : 'Retry') + '</button>',
      '</div>',
    ].join('');
  }

  const agent = getCurrentAgentRecord();
  const shown = _phSearch.results.length;
  const headerHtml = [
    '<div class="ph-search-toolbar">',
    _phScopeTabsHtml(),
    _phSortToggleHtml(),
    '</div>',
    '<div class="ph-search-status">' + escapeHtml(
      (isZh ? '共 ' + _phSearch.total + ' 个结果' : _phSearch.total + ' results')
      + (shown < _phSearch.total ? (isZh ? ' · 已显示 ' + shown : ' · showing ' + shown) : '')
      + (isZh ? ' · 范围：当前项目' + (_phSearch.scope === 'all' ? '（含归档）' : '') : ' · scope: current project' + (_phSearch.scope === 'all' ? ' (incl. archived)' : ''))
    ) + '</div>',
  ].join('');

  if (shown === 0) {
    const scopeHint = _phSearch.scope !== 'all'
      ? (isZh ? '；试试切换到「全部」范围' : '; try the All scope')
      : '';
    return headerHtml + '<div class="ph-search-status">' + escapeHtml((isZh ? '未找到匹配的对话' : 'No matching conversations found') + scopeHint) + '</div>';
  }

  let html = headerHtml;
  html += '<div class="feature-project-session-list">';
  html += _phSearch.results.map((r) => _phResultRowHtml(r, identity, agent)).join('');
  if (shown < _phSearch.total) {
    html += '<div class="ph-load-more-wrap"><button class="workspace-action secondary ph-load-more-btn" type="button" onclick="window.phSearchLoadMore()"' + (_phSearch.loading ? ' disabled' : '') + '>'
      + escapeHtml(_phSearch.loading ? (isZh ? '加载中...' : 'Loading...') : (isZh ? '加载更多（已显示 ' + shown + ' / ' + _phSearch.total + '）' : 'Load more (' + shown + ' / ' + _phSearch.total + ')'))
      + '</button></div>';
  }
  html += '</div>';
  return html;
};

function _updatePhSearchPanelDom() {
  const panel = document.querySelector('.ph-search-panel');
  if (panel) panel.innerHTML = window._buildPhSearchPanelHtml();
}

function _phSearchRequestIsCurrent(token) {
  const current = _phSearchIdentity();
  return token.epoch === _phSearch.epoch
    && phSearchQuery.trim() === token.query
    && current.identity === token.agentId
    && current.openDirectory === token.openDirectory
    && current.projectId === token.projectId
    && _phSearch.scope === token.scope && _phSearch.sort === token.sort;
}

async function _phSearchFetch({ replace }) {
  const identity = _phSearchIdentity();
  const queryTrimmed = phSearchQuery.trim();

  if (!queryTrimmed) return;
  if (!identity.identity) {
    _phSearch.error = true;
    _updatePhSearchPanelDom();
    return;
  }

  _phSearch.epoch += 1;
  // 归属身份（045）：项目目标携带 prj_ projectId（服务端与 openDirectory
  // 互斥），目录目标携带 openDirectory；身份比较两者都参与（快速切换
  // A/B/D 时旧响应不落地）。
  const token = {
    epoch: _phSearch.epoch,
    agentId: identity.identity,
    openDirectory: identity.openDirectory,
    projectId: identity.projectId,
    query: queryTrimmed,
    scope: _phSearch.scope,
    sort: _phSearch.sort,
  };
  _phSearch.agentId = identity.identity;
  _phSearch.openDirectory = identity.openDirectory;
  _phSearch.projectId = identity.projectId;
  _phSearch.loading = true;
  _phSearch.error = false;
  if (replace) _phSearch.results = [];
  _updatePhSearchPanelDom();

  const offset = replace ? 0 : _phSearch.results.length;
  try {
    const params = new URLSearchParams({
      agentId: token.agentId,
      q: token.query,
      scope: token.scope,
      sort: token.sort,
      offset: String(offset),
      limit: String(_phSearch.limit),
    });
    if (token.projectId) params.set('projectId', token.projectId);
    else if (token.openDirectory) params.set('openDirectory', token.openDirectory);
    const resp = await fetch('/protoclaw/search_sessions?' + params.toString());
    if (!resp.ok) throw new Error('search failed: ' + resp.status);
    const data = await resp.json();
    // 三重隔离守卫：代次 + 身份 + 查询词（连续输入不覆盖新结果）。
    if (!_phSearchRequestIsCurrent(token)) return;
    const incoming = (Array.isArray(data.results) ? data.results : []).map((result) => {
      if (!identity.remoteOnly) return result;
      const namespaced = window.RemoteConnections.namespaceMutationResult(identity.identity, { session: { id: result.sessionId } });
      return { ...result, sessionId: namespaced.session.id };
    });
    _phSearch.results = replace ? incoming : _phSearch.results.concat(incoming);
    _phSearch.total = Number.isFinite(Number(data.total)) ? Number(data.total) : _phSearch.results.length;
    _phSearch.loading = false;
    _updatePhSearchPanelDom();
  } catch (err) {
    if (!_phSearchRequestIsCurrent(token)) return;
    _phSearch.loading = false;
    _phSearch.error = true;
    _updatePhSearchPanelDom();
  }
}

window.phOnSearchInput = (value) => {
  const changed = phSearchQuery !== (value || '');
  phSearchQuery = value || '';
  _phSearch.epoch += 1;
  if (changed) _phSearch.expanded.clear();
  if (_phSearchTimer) {
    clearTimeout(_phSearchTimer);
    _phSearchTimer = null;
  }
  const trimmed = phSearchQuery.trim();

  // Update clear button visibility
  const clearBtn = document.querySelector('.ph-search-clear-btn');
  if (clearBtn) clearBtn.style.display = trimmed ? 'flex' : 'none';

  if (!trimmed) {
    // Clear search via DOM toggle — no full re-render
    _phSearchResetResults();
    const tabsContainer = document.querySelector('.ph-session-tabs');
    if (tabsContainer) tabsContainer.classList.remove('searching');
    return;
  }

  // Switch to searching mode via CSS class — no full re-render
  const tabsContainer = document.querySelector('.ph-session-tabs');
  if (tabsContainer) tabsContainer.classList.add('searching');
  _phSearch.loading = true;
  _phSearch.error = false;
  _phSearch.results = [];
  _updatePhSearchPanelDom();

  // Debounce the API call
  _phSearchTimer = setTimeout(() => {
    _phSearchTimer = null;
    _phSearchFetch({ replace: true });
  }, 300);
};

window.phSetSearchScopeByValue = (scope) => {
  const next = scope === 'main' || scope === 'archived' ? scope : 'all';
  if (_phSearch.scope === next) return;
  _phSearch.scope = next;
  if (phSearchQuery.trim()) {
    _phSearchFetch({ replace: true });
  } else {
    _updatePhSearchPanelDom();
  }
};

window.phSetSearchScope = (btn) => {
  if (btn?.dataset?.scope) window.phSetSearchScopeByValue(btn.dataset.scope);
};

window.phToggleSearchSort = () => {
  _phSearch.sort = _phSearch.sort === 'relevance' ? 'recency' : 'relevance';
  if (phSearchQuery.trim()) {
    _phSearchFetch({ replace: true });
  } else {
    _updatePhSearchPanelDom();
  }
};

window.phSearchLoadMore = () => {
  if (_phSearch.loading) return;
  if (phSearchQuery.trim()) _phSearchFetch({ replace: false });
};

window.phSearchRetry = () => {
  if (phSearchQuery.trim()) _phSearchFetch({ replace: true });
};

window.phSearchToggleExpand = (sessionId) => {
  if (_phSearch.expanded.has(sessionId)) {
    _phSearch.expanded.delete(sessionId);
  } else {
    _phSearch.expanded.add(sessionId);
  }
  _updatePhSearchPanelDom();
};

function _phSearchResetResults() {
  _phSearch.epoch += 1;
  _phSearch.results = [];
  _phSearch.total = 0;
  _phSearch.loading = false;
  _phSearch.error = false;
  _phSearch.expanded.clear();
}

/** 项目/宿主切换入口（ph-project-actions 调用）：搜索状态整体作废。 */
window.phSearchResetState = () => {
  _phSearchResetResults();
  _phSearch.agentId = '';
  _phSearch.openDirectory = '';
  _phSearch.projectId = '';
  _phSearch.scope = 'all';
  _phSearch.sort = 'relevance';
  if (_phSearchTimer) { clearTimeout(_phSearchTimer); _phSearchTimer = null; }
  const panel = document.querySelector('.ph-search-panel');
  if (panel) panel.innerHTML = '';
};

window.phClearSearch = () => {
  phSearchQuery = '';
  _phSearchResetResults();
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
