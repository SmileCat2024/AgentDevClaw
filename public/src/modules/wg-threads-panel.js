/**
 * wg-threads-panel.js — 群聊工作线程态势面板。
 *
 * 第一层回答“现在需要关注什么”，第二层展示线程摘要，第三层按需展开
 * session 血缘与任务。血缘头部、群聊当前路由、运行时与归档状态彼此独立。
 */

const WG_THREADS_REFRESH_INTERVAL = 15000;

const _threadsState = {
  loading: false,
  loaded: false,
  error: null,
  threads: [],
  taskCache: {},
  taskLoading: new Set(),
  threadCounts: {},
  expandedThreads: new Set(),
  expandedTasks: new Set(),
  showHistory: false,
  lastUpdatedAt: 0,
  requestVersion: 0,
  refreshTimer: null,
  chatId: null,
};

function _threadKey(thread) {
  return thread.threadRef || `${thread.identityRef}:${thread.lineageHeadId || thread.activeHeadId}`;
}

function _threadTitle(thread) {
  return thread.threadTitle || thread.activeHeadTitle || `会话 ${(thread.lineageHeadId || '').slice(-8)}`;
}

function _headId(thread) {
  return thread.lineageHeadId || thread.activeHeadId || '';
}

function _runtimeStatus(thread) {
  if (thread.lifecycle === 'archived' || thread.lifecycle === 'missing') return null;
  return WgState._runtimeStatusCache[_headId(thread)]?.status || thread.runtimeStatus || 'offline';
}

function _taskSummary(thread) {
  return _threadsState.taskCache[_headId(thread)]?.summary || thread.taskSummary || null;
}

function _contextUsage(thread) {
  return _threadsState.taskCache[_headId(thread)]?.contextUsage || thread.contextUsage || null;
}

function _derivedState(thread) {
  const summary = _taskSummary(thread);
  const runtime = _runtimeStatus(thread);
  if (thread.lifecycle === 'archived') return { key: 'archived', label: '已归档' };
  if (thread.lifecycle === 'missing') return { key: 'unavailable', label: '记录不可用' };
  if (runtime === 'running') return { key: 'running', label: '运行中' };
  if (summary?.total > 0 && summary.completed >= summary.total) return { key: 'completed', label: '已完成' };
  if (runtime === 'idle') return { key: 'idle', label: '空闲' };
  return { key: 'offline', label: '未运行' };
}

function _isHistory(thread) {
  return ['archived', 'missing'].includes(thread.lifecycle);
}

function _isCompleted(thread) {
  return !_isHistory(thread) && _derivedState(thread).key === 'completed';
}

function _isActive(thread) {
  return !_isHistory(thread) && !_isCompleted(thread);
}

function _formatRelativeTime(timestamp) {
  if (!timestamp) return '';
  const diff = Math.max(0, Date.now() - timestamp);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function _transitionLabel(transition) {
  if (!transition) return '会话续接';
  if (transition.reason === 'trim') {
    return transition.trimCutRounds != null ? `精简 ${transition.trimCutRounds} 轮` : '精简历史';
  }
  if (transition.reason === 'compact') return '压缩上下文';
  if (transition.reason === 'summary') return '摘要交接';
  if (transition.reason === 'branch') return '创建分支';
  return '会话续接';
}

async function _fetchTasks(thread, { force = false } = {}) {
  const sessionId = _headId(thread);
  if (!sessionId || _threadsState.taskLoading.has(sessionId)) return;
  if (!force && _threadsState.taskCache[sessionId]) return;
  _threadsState.taskLoading.add(sessionId);
  try {
    const data = await wgApiGet(
      `/protoclaw/gc/session_tasks?agentId=${encodeURIComponent(thread.workspaceId)}&sessionId=${encodeURIComponent(sessionId)}`
    );
    _threadsState.taskCache[sessionId] = {
      tasks: data.tasks || [],
      summary: data.summary || {},
      contextUsage: data.contextUsage || null,
      latestMessage: data.latestMessage || null,
    };
  } catch {
    if (!_threadsState.taskCache[sessionId]) {
      _threadsState.taskCache[sessionId] = { tasks: [], summary: { total: 0, completed: 0, inProgress: 0, pending: 0 } };
    }
  } finally {
    _threadsState.taskLoading.delete(sessionId);
  }
}

async function _fetchThreads({ refreshTasks = true } = {}) {
  const chatId = WgState.activeChatId;
  if (!chatId) return;
  const requestVersion = ++_threadsState.requestVersion;
  _threadsState.loading = true;
  _threadsState.chatId = chatId;
  try {
    const data = await wgApiGet(`/protoclaw/gc/session_threads?chatId=${encodeURIComponent(chatId)}`);
    if (requestVersion !== _threadsState.requestVersion || chatId !== WgState.activeChatId) return;
    _threadsState.threads = data.threads || [];
    _threadsState.loaded = true;
    _threadsState.error = null;
    _threadsState.lastUpdatedAt = Date.now();
    const counts = {};
    for (const thread of _threadsState.threads) {
      if (_isHistory(thread)) continue;
      counts[thread.identityRef] = (counts[thread.identityRef] || 0) + 1;
    }
    _threadsState.threadCounts = counts;

    if (refreshTasks) {
      const visibleThreads = _threadsState.threads.filter((thread) => !_isHistory(thread));
      await Promise.all(visibleThreads.map((thread) => _fetchTasks(thread, { force: true })));
      if (requestVersion !== _threadsState.requestVersion || chatId !== WgState.activeChatId) return;
      _threadsState.lastUpdatedAt = Date.now();
    }
  } catch (error) {
    if (requestVersion === _threadsState.requestVersion) _threadsState.error = error?.message || '加载失败';
  } finally {
    if (requestVersion === _threadsState.requestVersion) _threadsState.loading = false;
  }
}

async function _refreshLiveData() {
  if (!WgState.activeChatId || !_threadsState.loaded) return;
  if (typeof fetchRuntimeStatus === 'function') await fetchRuntimeStatus();
  const active = _threadsState.threads.filter((thread) => !_isHistory(thread));
  await Promise.all(active.map((thread) => _fetchTasks(thread, { force: true })));
  _threadsState.lastUpdatedAt = Date.now();
  _refreshPanel();
  _refreshAwareness();
}

function _startTimer() {
  _stopTimer();
  _threadsState.refreshTimer = setInterval(_refreshLiveData, WG_THREADS_REFRESH_INTERVAL);
}

function _stopTimer() {
  if (_threadsState.refreshTimer) clearInterval(_threadsState.refreshTimer);
  _threadsState.refreshTimer = null;
}

function _renderPanel() {
  if (!WgState.activeChat) return _emptyHtml('请先选择一个群聊。');
  if (_threadsState.loading && !_threadsState.loaded) return _loadingHtml();
  if (_threadsState.error && !_threadsState.loaded) {
    return _emptyHtml('工作线程加载失败。', '<button class="wg-thread-retry" data-wg-threads-retry>重新加载</button>');
  }
  if (!_threadsState.loaded || _threadsState.threads.length === 0) {
    return _emptyHtml('还没有工作线程。', '<span>从群聊派发任务后，线程会自动出现在这里。</span>');
  }

  const active = _threadsState.threads.filter(_isActive);
  const completed = _threadsState.threads.filter(_isCompleted);
  const history = _threadsState.threads.filter(_isHistory);
  const runningCount = active.filter((thread) => _runtimeStatus(thread) === 'running').length;

  return [
    '<div class="wg-threads-panel">',
    _renderOverview(active.length, completed.length, history.length, runningCount),
    _threadsState.error ? '<div class="wg-thread-stale">暂时无法更新，正在显示上次数据。</div>' : '',
    active.length ? _renderSection('进行中', active, 'active') : '',
    completed.length ? _renderSection('已完成', completed, 'completed') : '',
    history.length ? _renderHistorySection(history) : '',
    '</div>',
  ].join('');
}

function _renderOverview(activeCount, completedCount, historyCount, runningCount) {
  const updated = _formatRelativeTime(_threadsState.lastUpdatedAt);
  return [
    '<div class="wg-thread-overview">',
    '  <div class="wg-thread-overview-main">',
    '    <div class="wg-thread-overview-title">线程态势</div>',
    `    <div class="wg-thread-overview-meta">${updated ? `更新于 ${wgEsc(updated)}` : ''}</div>`,
    '  </div>',
    '  <div class="wg-thread-metrics">',
    `    <div class="wg-thread-metric${runningCount ? ' is-running' : ''}"><strong>${runningCount}</strong><span>运行中</span></div>`,
    `    <div class="wg-thread-metric"><strong>${activeCount}</strong><span>进行中</span></div>`,
    `    <div class="wg-thread-metric"><strong>${completedCount}</strong><span>已完成</span></div>`,
    `    <div class="wg-thread-metric muted"><strong>${historyCount}</strong><span>历史</span></div>`,
    '  </div>',
    '</div>',
  ].join('');
}

function _renderSection(title, threads, tone) {
  const identities = new Set(threads.map((thread) => thread.identityRef));
  const showIdentity = identities.size > 1 || new Set(_threadsState.threads.map((thread) => thread.identityRef)).size > 1;
  return [
    `<section class="wg-thread-section tone-${tone}">`,
    `  <div class="wg-thread-section-heading"><span>${wgEsc(title)}</span><span>${threads.length}</span></div>`,
    threads.map((thread) => _renderCard(thread, { showIdentity })).join(''),
    '</section>',
  ].join('');
}

function _renderHistorySection(threads) {
  const show = _threadsState.showHistory;
  return [
    '<section class="wg-thread-section is-history">',
    `  <button class="wg-thread-history-toggle" data-wg-threads-history aria-expanded="${show}">`,
    '    <span>历史记录</span>',
    `    <span>${threads.length} ${show ? '收起' : '展开'}</span>`,
    '  </button>',
    show ? `<div class="wg-thread-history-list">${threads.map((thread) => _renderCard(thread, { showIdentity: true, compact: true })).join('')}</div>` : '',
    '</section>',
  ].join('');
}

function _renderCard(thread, { showIdentity = false, compact = false } = {}) {
  const key = _threadKey(thread);
  const state = _derivedState(thread);
  const summary = _taskSummary(thread);
  const expanded = _threadsState.expandedThreads.has(key);
  const progress = summary?.total > 0 ? `${summary.completed || 0}/${summary.total} 完成` : '';
  const latest = _formatRelativeTime(thread.updatedAt);
  const meta = [showIdentity ? thread.identityName : '', progress, latest].filter(Boolean).join(' · ');
  const lineageCount = thread.lineage?.length || 1;
  const runtime = _runtimeStatus(thread) || 'offline';

  return [
    `<article class="wg-thread-card state-${state.key}${compact ? ' compact' : ''}">`,
    '  <div class="wg-thread-card-top">',
    '    <div class="wg-thread-card-copy">',
    '      <div class="wg-thread-title-row">',
    `        <div class="wg-thread-title" title="${wgEsc(_threadTitle(thread))}">${wgEsc(_threadTitle(thread))}</div>`,
    `        ${_renderInlineState(thread, state, runtime)}`,
    '      </div>',
    meta ? `      <div class="wg-thread-meta">${wgEsc(meta)}</div>` : '',
    '    </div>',
    '  </div>',
    compact ? '' : _renderLatestMessage(thread),
    _isHistory(thread) ? '' : _renderRuntimeRow(thread),
    _renderCardActions(thread),
    _isHistory(thread) ? '' : _renderTasks(thread),
    lineageCount > 1
      ? `<button class="wg-thread-detail-toggle" data-wg-threads-toggle="${wgEsc(key)}" aria-expanded="${expanded}"><span><strong>会话脉络</strong> ${lineageCount} 个会话 · ${wgEsc(_transitionLabel(thread.lineage[lineageCount - 1]?.transition))}</span><span>${expanded ? '收起' : '查看脉络'} <i>›</i></span></button>`
      : '',
    expanded ? _renderDetails(thread) : '',
    '</article>',
  ].join('');
}

function _renderInlineState(thread, state, runtime) {
  const label = _isCompleted(thread) || _isHistory(thread)
    ? state.label
    : runtime === 'running' ? '运行中' : runtime === 'idle' ? '空闲' : '未运行';
  const tone = _isCompleted(thread) ? 'completed' : _isHistory(thread) ? 'history' : runtime;
  return `<span class="wg-thread-inline-state ${wgEsc(tone)}"><i></i>${wgEsc(label)}</span>`;
}

function _messagePreviewText(value) {
  return String(value || '')
    .replace(/```[\s\S]*?```/g, ' [代码片段] ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+\s*\|?\s*$/gm, '')
    .replace(/^\s*(?:#{1,6}\s+|[-*_]{3,}\s*$|[-*+]\s+)/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function _renderLatestMessage(thread) {
  const latest = _threadsState.taskCache[_headId(thread)]?.latestMessage || thread.latestMessage;
  if (!latest?.text) return '';
  const preview = _messagePreviewText(latest.text);
  if (!preview) return '';
  return `<p class="wg-thread-latest" title="${wgEsc(preview)}">${wgEsc(preview)}</p>`;
}

function _renderCardActions(thread) {
  const sessionId = _headId(thread);
  const actions = [];
  if (thread.canDispatch) {
    actions.push(
      `<button class="wg-thread-primary" data-wg-threads-dispatch="${wgEsc(thread.identityRef)}" data-wg-threads-session="${wgEsc(sessionId)}" data-wg-threads-title="${wgEsc(_threadTitle(thread))}">派发指令</button>`
    );
  }
  if (thread.lifecycle === 'archived') {
    actions.push(`<button class="wg-thread-secondary" data-wg-threads-record="${wgEsc(thread.workspaceId)}:${wgEsc(sessionId)}">查看记录</button>`);
  } else if (thread.lifecycle !== 'missing') {
    actions.push(`<button class="wg-thread-secondary" data-wg-threads-nav="${wgEsc(thread.workspaceId)}:${wgEsc(sessionId)}">查看会话</button>`);
  }
  return actions.length ? `<div class="wg-thread-actions">${actions.join('')}</div>` : '';
}

function _formatTokenCount(value) {
  const number = Number(value) || 0;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 1000) return `${Math.round(number / 1000)}K`;
  return String(number);
}

function _renderRuntimeRow(thread) {
  const runtime = _runtimeStatus(thread) || 'offline';
  const usage = _contextUsage(thread);
  const percent = Math.max(0, Math.min(100, Number(usage?.percent) || 0));
  const compressRatio = Math.max(1, Math.min(100, Number(usage?.compressRatio) || 80));
  const tone = percent >= compressRatio ? 'compress' : percent >= 60 ? 'high' : percent >= 35 ? 'mid' : 'low';
  const contextHtml = usage ? [
    `<div class="wg-thread-context tone-${tone}" title="上下文 ${_formatTokenCount(usage.usedTokens)} / ${_formatTokenCount(usage.contextLength)}">`,
    '  <div class="wg-thread-context-label">',
    '    <span>上下文</span>',
    `    <span>${percent}%</span>`,
    '  </div>',
    '  <div class="wg-thread-context-bar">',
    `    <span class="wg-thread-context-threshold" style="left:${compressRatio}%"></span>`,
    `    <span class="wg-thread-context-fill" style="width:${percent}%"></span>`,
    '  </div>',
    '</div>',
  ].join('') : '<div class="wg-thread-context unavailable">暂无上下文用量</div>';
  const interrupt = runtime === 'running'
    ? `<button class="wg-thread-interrupt" data-wg-threads-interrupt data-wg-identity="${wgEsc(thread.identityRef)}" data-wg-session-id="${wgEsc(_headId(thread))}" data-wg-workspace-id="${wgEsc(thread.workspaceId)}">中断</button>`
    : '';
  return [
    '<div class="wg-thread-runtime-row">',
    contextHtml,
    interrupt,
    '</div>',
  ].join('');
}

function _renderDetails(thread) {
  const reversed = [...(thread.lineage || [])].reverse();
  const nodes = [];
  reversed.forEach((node, index) => {
    if (index > 0) {
      const newerNode = reversed[index - 1];
      nodes.push(`<div class="wg-thread-transition"><span></span><em>${wgEsc(_transitionLabel(newerNode.transition))}</em></div>`);
    }
    nodes.push(_renderLineageNode(node, thread, index === 0));
  });
  return `<div class="wg-thread-details">${nodes.join('')}</div>`;
}

function _renderLineageNode(node, thread, isHead) {
  const state = node.isArchived ? '已归档' : node.isCurrent ? '当前会话' : node.isAvailable ? '可查看' : '不可用';
  const title = node.sessionTitle || `会话 ${String(node.sessionId || '').slice(-8)}`;
  const nav = node.isArchived
    ? ` data-wg-threads-record="${wgEsc(thread.workspaceId)}:${wgEsc(node.sessionId)}" role="button" tabindex="0"`
    : (node.isAvailable || node.isCurrent)
      ? ` data-wg-threads-nav="${wgEsc(thread.workspaceId)}:${wgEsc(node.sessionId)}" role="button" tabindex="0"`
      : '';
  return [
    '<div class="wg-thread-node">',
    `  <div class="wg-thread-node-row"${nav}>`,
    `    <span class="wg-thread-node-dot${isHead ? ' head' : ''}${node.isArchived ? ' archived' : ''}"></span>`,
    '    <div class="wg-thread-node-copy">',
    `      <div class="wg-thread-node-title">${wgEsc(title)}</div>`,
    `      <div class="wg-thread-node-meta">${wgEsc(state)}</div>`,
    '    </div>',
    '  </div>',
    '</div>',
  ].join('');
}

function _renderTasks(thread) {
  const sessionId = _headId(thread);
  const data = _threadsState.taskCache[sessionId];
  const expanded = _threadsState.expandedTasks.has(sessionId);
  const tasks = data?.tasks || [];
  const summary = data?.summary || { total: 0, completed: 0 };
  const visibleTasks = expanded
    ? [...tasks].sort((a, b) => ({ in_progress: 0, pending: 1, completed: 2 }[a.status] ?? 3) - ({ in_progress: 0, pending: 1, completed: 2 }[b.status] ?? 3))
    : [];
  return [
    '<div class="wg-thread-tasks">',
    `  <button class="wg-thread-tasks-toggle" data-wg-threads-toggle-task="${wgEsc(sessionId)}" aria-expanded="${expanded}"><span><strong>Task</strong>${summary.total > 0 ? ` ${summary.completed || 0}/${summary.total} 已完成` : ' 尚未建立'}</span><span>${expanded ? '收起' : '查看任务'} <i>›</i></span></button>`,
    expanded ? (visibleTasks.length
      ? `<div class="wg-thread-task-list">${visibleTasks.map(_renderTask).join('')}</div>`
      : '<div class="wg-thread-task-empty">此会话暂无 Task</div>') : '',
    '</div>',
  ].join('');
}

function _renderTask(task) {
  const status = task.status === 'completed' ? 'completed' : task.status === 'in_progress' ? 'running' : 'pending';
  const label = task.status === 'in_progress' ? (task.activeForm || task.subject) : task.subject;
  return `<div class="wg-thread-task ${status}"><span class="wg-thread-task-icon"></span><span>${wgEsc(label || '')}</span></div>`;
}

function _loadingHtml() {
  return '<div class="wg-thread-skeleton"><span></span><span></span><span></span></div>';
}

function _emptyHtml(title, detail = '') {
  return `<div class="feature-panel-empty wg-thread-empty"><strong>${wgEsc(title)}</strong>${detail}</div>`;
}

function _refreshPanel() {
  if (typeof activeFeaturePanel !== 'undefined' && activeFeaturePanel === 'threads' && typeof renderFeaturePanel === 'function') {
    renderFeaturePanel();
  }
}

function _refreshAwareness() {
  const awareness = document.querySelector('.wg-awareness');
  if (typeof _updateAwarenessDotsInPlace === 'function' && awareness) {
    _updateAwarenessDotsInPlace(awareness);
  }
  if (typeof _refreshPopoverIfOpen === 'function') _refreshPopoverIfOpen();
}

function _selectThread(identityRef, sessionId, title) {
  if (typeof insertMentionWithSession === 'function') {
    insertMentionWithSession(identityRef, 'specific', sessionId, title);
  }
  const editor = document.querySelector('.wg-input-editor');
  if (editor) editor.focus();
}

function _navigate(raw) {
  if (typeof navigateToSession === 'function') navigateToSession(String(raw || ''));
}

function _navigateRecord(raw) {
  const parts = String(raw || '').split(':');
  if (parts.length < 2) return;
  if (typeof navigateToSessionRecord === 'function') navigateToSessionRecord(parts[0], parts.slice(1).join(':'));
}

function _wireEvents() {
  const body = document.getElementById('feature-panel-body');
  if (!body || body._wgThreadsEventsWired) return;
  body._wgThreadsEventsWired = true;
  body.addEventListener('click', async (event) => {
    const interrupt = event.target.closest('[data-wg-threads-interrupt]');
    if (interrupt) {
      event.preventDefault();
      event.stopPropagation();
      interrupt.disabled = true;
      interrupt.textContent = '中断中…';
      if (typeof handleInterruptSession === 'function') {
        await handleInterruptSession(
          interrupt.dataset.wgIdentity,
          interrupt.dataset.wgSessionId,
          interrupt.dataset.wgWorkspaceId
        );
      }
      _refreshPanel();
      return;
    }
    const dispatch = event.target.closest('[data-wg-threads-dispatch]');
    if (dispatch) {
      _selectThread(dispatch.dataset.wgThreadsDispatch, dispatch.dataset.wgThreadsSession, dispatch.dataset.wgThreadsTitle);
      return;
    }
    const nav = event.target.closest('[data-wg-threads-nav]');
    if (nav) { _navigate(nav.dataset.wgThreadsNav); return; }
    const record = event.target.closest('[data-wg-threads-record]');
    if (record) { _navigateRecord(record.dataset.wgThreadsRecord); return; }
    const toggle = event.target.closest('[data-wg-threads-toggle]');
    if (toggle) {
      const key = toggle.dataset.wgThreadsToggle;
      _threadsState.expandedThreads.has(key) ? _threadsState.expandedThreads.delete(key) : _threadsState.expandedThreads.add(key);
      _refreshPanel();
      return;
    }
    const taskToggle = event.target.closest('[data-wg-threads-toggle-task]');
    if (taskToggle) {
      const sessionId = taskToggle.dataset.wgThreadsToggleTask;
      _threadsState.expandedTasks.has(sessionId) ? _threadsState.expandedTasks.delete(sessionId) : _threadsState.expandedTasks.add(sessionId);
      _refreshPanel();
      return;
    }
    if (event.target.closest('[data-wg-threads-history]')) {
      _threadsState.showHistory = !_threadsState.showHistory;
      _refreshPanel();
      return;
    }
    if (event.target.closest('[data-wg-threads-retry]')) {
      await _fetchThreads();
      _refreshPanel();
    }
  });
  body.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const nav = event.target.closest('[data-wg-threads-nav]');
    if (nav) { event.preventDefault(); _navigate(nav.dataset.wgThreadsNav); }
    const record = event.target.closest('[data-wg-threads-record]');
    if (record) { event.preventDefault(); _navigateRecord(record.dataset.wgThreadsRecord); }
  });
}

window._wgGetThreadsHtml = _renderPanel;

window._wgThreadsInit = async function () {
  _wireEvents();
  if (!_threadsState.loaded || _threadsState.chatId !== WgState.activeChatId) await _fetchThreads();
  _startTimer();
  _refreshPanel();
  _refreshAwareness();
};

window._wgThreadsRefresh = _refreshPanel;

window._wgThreadsReload = async function () {
  if (!WgState.activeChatId) return;
  await _fetchThreads();
  _refreshPanel();
  _refreshAwareness();
};

window._wgGetThreadCount = function (identityRef) {
  return _threadsState.threadCounts[identityRef] || 0;
};

window._wgGetThreadDataState = function () {
  return { loaded: _threadsState.loaded, loading: _threadsState.loading, error: _threadsState.error };
};

window._wgGetThreadSummary = function (identityRef) {
  const threads = _threadsState.threads.filter((thread) => thread.identityRef === identityRef && !_isHistory(thread));
  if (!threads.length) return null;
  const statusCounts = { active: 0, completed: 0, running: 0 };
  const activeHeads = threads.map((thread) => {
    const state = _derivedState(thread);
    if (state.key === 'completed') statusCounts.completed += 1;
    else statusCounts.active += 1;
    if (state.key === 'running') statusCounts.running += 1;
    return {
      title: _threadTitle(thread),
      sessionId: _headId(thread),
      workspaceId: thread.workspaceId,
      canDispatch: thread.canDispatch,
      stateLabel: state.label,
    };
  });
  return { count: threads.length, statusCounts, activeHeads };
};

window._wgThreadsCleanup = function () {
  _stopTimer();
  _threadsState.requestVersion += 1;
  _threadsState.loading = false;
  _threadsState.loaded = false;
  _threadsState.error = null;
  _threadsState.threads = [];
  _threadsState.taskCache = {};
  _threadsState.taskLoading.clear();
  _threadsState.threadCounts = {};
  _threadsState.expandedThreads.clear();
  _threadsState.expandedTasks.clear();
  _threadsState.showHistory = false;
  _threadsState.lastUpdatedAt = 0;
  _threadsState.chatId = null;
};
