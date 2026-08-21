/* coder-threads-ui.js — coder 工作空间线程看板（Thread 原生视图，无上层产品语义） */

window.CoderThreadsUI = (() => {
  const AUTO_REFRESH_INTERVAL = 5000;

  let refreshTimer = null;

  const STATUS_META = {
    // 锚点域（框架 WorkThread）：open / rotating / rotation_failed / closed。
    // idle / running / failed / waiting_input 为切换前索引条目的旧词，保留兼容。
    open: { zh: '空闲', en: 'Idle' },
    idle: { zh: '空闲', en: 'Idle' },
    running: { zh: '执行中', en: 'Running' },
    rotating: { zh: '接力中', en: 'Relaying' },
    rotation_failed: { zh: '接力失败', en: 'Rotation failed' },
    failed: { zh: '失败', en: 'Failed' },
    waiting_input: { zh: '等待输入', en: 'Waiting input' },
    closed: { zh: '已关闭', en: 'Closed' },
  };

  // 活动线程排前（执行/接力优先于失败与空闲），closed 沉底；同组按更新时间倒序
  const STATUS_ORDER = ['running', 'rotating', 'waiting_input', 'failed', 'rotation_failed', 'open', 'idle', 'closed'];
  const RESUMABLE = new Set(['failed', 'rotation_failed', 'waiting_input']);

  function isZh() { return typeof currentLanguage !== 'undefined' && currentLanguage === 'zh'; }

  function esc(value) {
    if (typeof escapeHtml === 'function') return escapeHtml(value);
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function shortId(id) {
    const text = String(id || '');
    return text.length > 10 ? text.slice(0, 10) : text;
  }

  function timeAgo(timestamp) {
    const ms = Date.now() - Number(timestamp);
    if (!Number.isFinite(ms) || ms < 0) return '';
    const minutes = Math.floor(ms / 60000);
    if (minutes < 1) return isZh() ? '刚刚' : 'just now';
    if (minutes < 60) return isZh() ? `${minutes} 分钟前` : `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return isZh() ? `${hours} 小时前` : `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return isZh() ? `${days} 天前` : `${days}d ago`;
  }

  function statusLabel(status) {
    const meta = STATUS_META[status];
    if (!meta) return String(status || '—');
    return isZh() ? meta.zh : meta.en;
  }

  /** 接力链摘要：第 N 棒 + trim / 摘要交接计数 */
  function chainSummary(thread) {
    const zh = isZh();
    const legs = (thread.sessionIds || []).length;
    if (!legs) return '';
    const counts = { trim: 0, summary: 0 };
    for (const edge of thread.chainEdges || []) {
      if (counts[edge.relayKind] != null) counts[edge.relayKind] += 1;
    }
    const parts = [zh ? `第 ${legs} 棒` : `leg ${legs}`];
    if (counts.trim) parts.push(`trim ×${counts.trim}`);
    if (counts.summary) parts.push(zh ? `摘要 ×${counts.summary}` : `summary ×${counts.summary}`);
    return parts.join(' · ');
  }

  /** 最新动态：优先最近一次执行事件，其次生命周期事件 */
  function latestActivity(thread) {
    const zh = isZh();
    const event = Array.isArray(thread.executionEvents) && thread.executionEvents.length
      ? thread.executionEvents[thread.executionEvents.length - 1]
      : null;
    if (event?.event) {
      const type = String(event.event.type || '');
      const label = ({
        'turn.started': zh ? '新一轮开始' : 'turn started',
        'turn.completed': zh ? '一轮完成' : 'turn completed',
        'turn.failed': zh ? '一轮失败' : 'turn failed',
        'turn.cancelled': zh ? '一轮被取消' : 'turn cancelled',
      })[type] || type;
      return label;
    }
    const lifecycle = thread.lastLifecycleEvent?.type;
    return lifecycle ? String(lifecycle) : '';
  }

  function renderThread(thread) {
    const zh = isZh();
    const status = String(thread.status || 'idle');
    const closed = status === 'closed';
    const pendingCount = Array.isArray(thread.pendingTexts) ? thread.pendingTexts.length : 0;
    const activity = latestActivity(thread);

    const openRunAction = thread.headSessionId
      ? esc(JSON.stringify({ type: 'open_session', sessionId: thread.headSessionId }))
      : '';

    const actions = [
      thread.headSessionId
        ? '<button class="coder-btn secondary" type="button" data-workspace-action="' + openRunAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + (zh ? '查看执行' : 'Open run') + '</button>'
        : '',
      RESUMABLE.has(status)
        ? '<button class="coder-btn" type="button" onclick="window.CoderThreadsUI.resume(\'' + esc(thread.threadId) + '\')">' + (zh ? '恢复' : 'Resume') + '</button>'
        : '',
      !closed
        ? '<button class="coder-btn secondary" type="button" onclick="window.CoderThreadsUI.close(\'' + esc(thread.threadId) + '\')">' + (zh ? '关闭' : 'Close') + '</button>'
        : '',
    ].filter(Boolean).join('');

    return [
      '<article class="coder-thread-card' + (closed ? ' closed' : '') + '" data-thread-id="' + esc(thread.threadId) + '">',
      '<div class="coder-thread-card-head">',
      '<span class="coder-thread-status status-' + esc(status) + '">' + esc(statusLabel(status)) + '</span>',
      chainSummary(thread) ? '<span class="coder-thread-chain">' + esc(chainSummary(thread)) + '</span>' : '',
      '</div>',
      '<div class="coder-thread-title" title="' + esc(thread.threadId) + '">' + esc(thread.title || shortId(thread.threadId)) + '</div>',
      '<div class="coder-thread-meta">',
      '<span class="coder-thread-meta-id" title="' + esc(thread.threadId) + '">' + esc(shortId(thread.threadId)) + '</span>',
      thread.headSessionId ? '<span class="coder-thread-meta-session" title="' + esc(thread.headSessionId) + '">head ' + esc(shortId(thread.headSessionId)) + '</span>' : '',
      timeAgo(thread.updatedAt) ? '<span class="coder-thread-meta-time">' + esc(timeAgo(thread.updatedAt)) + '</span>' : '',
      '</div>',
      activity ? '<div class="coder-thread-activity">' + esc(activity) + '</div>' : '',
      pendingCount > 0
        ? '<div class="coder-thread-pending">' + esc(zh ? `${pendingCount} 条指令待投递` : `${pendingCount} pending command(s)`) + '</div>'
        : '',
      actions ? '<div class="coder-thread-actions">' + actions + '</div>' : '',
      '</article>',
    ].join('');
  }

  function render() {
    scheduleAutoRefresh();
    // thread-store 首拉（2s 延迟）可能尚未发生：主动补一次，异步返回后由
    // 下一次渲染呈现（refreshThreads(true) 恒返回 Promise，节流路径仅出现在 force=false）
    if (typeof window.refreshThreads === 'function' && !window.ClawThreads?.initialLoadDone) {
      window.refreshThreads(true).catch(() => {});
    }
    const zh = isZh();
    const threads = ((typeof window.ClawThreads !== 'undefined' && Array.isArray(window.ClawThreads.threads))
      ? window.ClawThreads.threads
      : [])
      .filter((thread) => thread?.agentId === 'coder')
      .slice()
      .sort((left, right) => {
        const orderLeft = STATUS_ORDER.indexOf(left.status);
        const orderRight = STATUS_ORDER.indexOf(right.status);
        if (orderLeft !== orderRight) return orderLeft - orderRight;
        return Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
      });

    const title = zh ? '工作线程' : 'Work threads';
    const description = zh
      ? '每条线程是一个持久化调度对象：会话在其内接续（trim / 摘要接力），指令经收件箱投递，全程可通过 claw threads 审计。'
      : 'Each thread is a persisted scheduling object: sessions relay inside it (trim / summary handoff), commands flow through its inbox, and everything is auditable via claw threads.';

    const counts = {};
    for (const thread of threads) counts[thread.status] = (counts[thread.status] || 0) + 1;
    const summary = STATUS_ORDER
      .filter((status) => counts[status])
      .map((status) => `${statusLabel(status)} ${counts[status]}`)
      .join(' · ');

    return [
      '<section class="coder-threads">',
      '<div class="coder-panel-heading"><div><div class="coder-panel-kicker">24H CODER</div><h2>' + title + '</h2><p>' + description + '</p></div>' + (summary ? '<div class="coder-threads-summary">' + esc(summary) + '</div>' : '') + '</div>',
      '<div class="coder-thread-list">',
      threads.length === 0
        ? '<div class="coder-thread-empty">' + (zh ? '暂无线程。新建会话或通过 claw threads send 派发指令后，这里会出现对应线程。' : 'No threads yet. Create a session or send commands via claw threads and threads will appear here.') + '</div>'
        : threads.map(renderThread).join(''),
      '</div></section>',
    ].join('');
  }

  function scheduleAutoRefresh() {
    if (refreshTimer) return;
    refreshTimer = setInterval(() => {
      if (typeof document === 'undefined' || document.hidden) return;
      if (typeof window.refreshThreads !== 'function') return;
      Promise.resolve(window.refreshThreads(true))
        .then(() => {
          if (typeof renderCurrentMainView === 'function') renderCurrentMainView();
        }).catch(() => {});
    }, AUTO_REFRESH_INTERVAL);
  }

  async function request(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) throw new Error(payload.error || 'Thread request failed');
    return payload;
  }

  async function refresh() {
    if (typeof window.refreshThreads !== 'function') return;
    await Promise.resolve(window.refreshThreads(true)).catch(() => {});
    if (typeof renderCurrentMainView === 'function') renderCurrentMainView();
  }

  async function resume(threadId) {
    try {
      await request('/protoclaw/threads/' + encodeURIComponent(threadId) + '/resume', { source: 'ui' });
      await refresh();
    } catch (error) {
      if (typeof ClawToast !== 'undefined') ClawToast.error(error.message || 'Failed to resume thread');
    }
  }

  async function close(threadId) {
    try {
      await request('/protoclaw/threads/' + encodeURIComponent(threadId) + '/close', { reason: 'operator_closed' });
      await refresh();
    } catch (error) {
      if (typeof ClawToast !== 'undefined') ClawToast.error(error.message || 'Failed to close thread');
    }
  }

  return { render, refresh, resume, close };
})();
