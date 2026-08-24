/**
 * coder-threads-ui.js — coder 入口的线程列表视图
 *
 * 心智：行 = 线程（不是会话）。会话是实体层，线程是把链条成员折叠成
 * 一行的连接结构；行入口每次动态解析当前 head（不自动跳转）。
 *
 * - 生命状态四态（thread-life-state.js 合成，随 /protoclaw/threads 附带）：
 *   executing / pending-commands / idle / archived，failed 为独立注意力信号；
 * - 行动作：打开 head（整卡可点）、中断（路由到 head runtime 的 turn
 *   中断通道）、归档（executing / pending-commands 置灰——先中断再归档）、
 *   取消归档（已归档 tab）；
 * - 归档宾语是线程：成员会话不动，视图按线程归档态折叠；
 * - 空态是教育点：线程由调度面创建（ACP / claw threads CLI / dispatch
 *   技能），本视图不提供任何创建动作；
 * - UI 不提供向线程发消息的通道（调度纪律：依赖由调度方控制）。
 *
 * 数据源：thread-store.js 的 ClawThreads（20s 轮询 + 签名失效重渲染），
 * 本模块再加 5s 强刷（surface 可见期）。
 *
 * 依赖全局（运行时调用，加载顺序无关）：
 *   - escapeHtml, currentLanguage, allAgents, focusedAgentId (app-core.js)
 *   - window.ClawThreads / refreshThreads / jumpToThreadHead (thread-store.js)
 *   - renderCurrentMainView (app-ui.js)
 */

window.CoderThreadsUI = (() => {
  const AUTO_REFRESH_INTERVAL = 5000;

  let refreshTimer = null;
  let activeTab = 'threads'; // 'threads' | 'archived'

  // ── 工具 ────────────────────────────────────────────────────────

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
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const minutes = Math.floor(ms / 60000);
    if (minutes < 1) return isZh() ? '刚刚' : 'just now';
    if (minutes < 60) return isZh() ? `${minutes} 分钟前` : `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return isZh() ? `${hours} 小时前` : `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return isZh() ? `${days} 天前` : `${days}d ago`;
  }

  /** 当前渲染宿主：投影条目记录的 agentId（coder 入口 → programming-helper） */
  function currentHostAgentId() {
    try {
      if (typeof allAgents !== 'undefined' && Array.isArray(allAgents) && typeof focusedAgentId !== 'undefined') {
        const entry = allAgents.find((a) => a?.id === focusedAgentId);
        if (entry?.agentId) return entry.agentId;
        if (entry) return entry.id;
      }
    } catch { /* 全局不可用时退化为空（渲染空态） */ }
    return '';
  }

  /** head 会话标题（线程标题缺省时回退） */
  function headSessionTitle(hostAgentId, sessionId) {
    try {
      if (typeof allAgents !== 'undefined' && Array.isArray(allAgents) && sessionId) {
        const host = allAgents.find((a) => a?.id === hostAgentId);
        const sessions = host?.workspace_sessions?.sessions;
        const session = Array.isArray(sessions) ? sessions.find((s) => s?.id === sessionId) : null;
        const title = String(session?.title || '').trim();
        if (title) return title;
      }
    } catch { /* 退化为短 id */ }
    return '';
  }

  const LIFE_META = {
    executing: { zh: '执行中', en: 'Executing' },
    'pending-commands': { zh: '待投递', en: 'Pending' },
    idle: { zh: '空闲', en: 'Idle' },
    archived: { zh: '已归档', en: 'Archived' },
  };

  function lifeLabel(lifeState) {
    const meta = LIFE_META[lifeState];
    return meta ? (isZh() ? meta.zh : meta.en) : String(lifeState || '—');
  }

  const LIFE_ORDER = ['executing', 'pending-commands', 'idle'];

  function chainSummary(thread) {
    const legs = (thread.sessionIds || []).length;
    if (!legs || legs < 2) return '';
    const zh = isZh();
    const counts = { trim: 0, summary: 0 };
    for (const edge of thread.chainEdges || []) {
      if (counts[edge.relayKind] != null) counts[edge.relayKind] += 1;
    }
    const parts = [zh ? `第 ${legs} 棒` : `leg ${legs}`];
    if (counts.trim) parts.push(`trim ×${counts.trim}`);
    if (counts.summary) parts.push(zh ? `摘要 ×${counts.summary}` : `summary ×${counts.summary}`);
    return parts.join(' · ');
  }

  // ── 行渲染 ──────────────────────────────────────────────────────

  function renderThread(thread) {
    const zh = isZh();
    const lifeState = String(thread.lifeState || 'idle');
    const archived = lifeState === 'archived';
    const busy = lifeState === 'executing' || lifeState === 'pending-commands';
    const failed = thread.failed === true;
    const pendingCount = (Array.isArray(thread.pendingTexts) ? thread.pendingTexts.length : 0)
      + (Array.isArray(thread.commands)
        ? thread.commands.filter((c) => c?.status === 'pending' || c?.status === 'in_flight').length
        : 0);
    const title = String(thread.title || '').trim()
      || headSessionTitle(thread.agentId, thread.headSessionId)
      || shortId(thread.threadId);

    const actions = [];
    if (!archived && thread.headSessionId) {
      actions.push(
        '<button class="coder-btn secondary" type="button" onclick="window.CoderThreadsUI.openHead(\'' + esc(thread.threadId) + '\')">'
        + (zh ? '打开 head' : 'Open head') + '</button>',
      );
    }
    if (!archived && busy && thread.headViewerAgentId) {
      actions.push(
        '<button class="coder-btn danger" type="button" title="' + esc(zh ? '中断当前 head 会话正在执行的 turn' : 'Interrupt the turn running on the current head session') + '" onclick="window.CoderThreadsUI.interrupt(\'' + esc(thread.threadId) + '\')">'
        + (zh ? '中断' : 'Interrupt') + '</button>',
      );
    }
    if (!archived) {
      // 先中断再归档：busy 时置灰（后端同样拒绝，双保险）
      actions.push(
        '<button class="coder-btn secondary" type="button"' + (busy ? ' disabled title="' + esc(zh ? '线程执行中，先中断再归档' : 'Thread is busy; interrupt first, then archive') + '"' : '') + ' onclick="window.CoderThreadsUI.archive(\'' + esc(thread.threadId) + '\')">'
        + (zh ? '归档' : 'Archive') + '</button>',
      );
    } else {
      actions.push(
        '<button class="coder-btn secondary" type="button" onclick="window.CoderThreadsUI.unarchive(\'' + esc(thread.threadId) + '\')">'
        + (zh ? '取消归档' : 'Unarchive') + '</button>',
      );
    }
    if (!archived && failed) {
      actions.push(
        '<button class="coder-btn" type="button" onclick="window.CoderThreadsUI.resume(\'' + esc(thread.threadId) + '\')">'
        + (zh ? '恢复' : 'Resume') + '</button>',
      );
    }

    const statusClasses = ['coder-thread-status', 'status-' + esc(lifeState)];
    if (failed) statusClasses.push('is-failed');

    return [
      '<article class="coder-thread-card' + (archived ? ' archived' : '') + '" data-thread-id="' + esc(thread.threadId) + '"'
      + (!archived && thread.headSessionId ? ' style="cursor:pointer" onclick="window.CoderThreadsUI.openHead(\'' + esc(thread.threadId) + '\')"' : '')
      + ' title="' + esc(thread.threadId) + '">',
      '<div class="coder-thread-card-head">',
      '<span class="' + statusClasses.join(' ') + '">' + esc(lifeLabel(lifeState)) + '</span>',
      chainSummary(thread) ? '<span class="coder-thread-chain">' + esc(chainSummary(thread)) + '</span>' : '',
      '</div>',
      '<div class="coder-thread-title">' + esc(title) + '</div>',
      '<div class="coder-thread-meta">',
      '<span class="coder-thread-meta-id" title="' + esc(thread.threadId) + '">' + esc(shortId(thread.threadId)) + '</span>',
      thread.headSessionId ? '<span class="coder-thread-meta-session" title="' + esc(thread.headSessionId) + '">head ' + esc(shortId(thread.headSessionId)) + '</span>' : '',
      timeAgo(thread.lastEventAt || thread.updatedAt) ? '<span class="coder-thread-meta-time">' + esc(timeAgo(thread.lastEventAt || thread.updatedAt)) + '</span>' : '',
      '</div>',
      failed ? '<div class="coder-thread-activity failed">' + esc(zh ? '最近一轮执行失败' : 'Last turn failed') + '</div>' : '',
      pendingCount > 0 ? '<div class="coder-thread-pending">' + esc(zh ? `${pendingCount} 条指令待投递` : `${pendingCount} pending command(s)`) + '</div>' : '',
      actions.length ? '<div class="coder-thread-actions">' + actions.join('') + '</div>' : '',
      '</article>',
    ].join('');
  }

  // ── 面板渲染 ────────────────────────────────────────────────────

  function render() {
    scheduleAutoRefresh();
    // thread-store 首拉（2s 延迟）可能尚未发生：主动补一次，异步返回后由
    // 下一次渲染呈现（refreshThreads(true) 恒返回 Promise，节流路径仅出现在 force=false）
    if (typeof window.refreshThreads === 'function' && !window.ClawThreads?.initialLoadDone) {
      window.refreshThreads(true).catch(() => {});
    }
    const zh = isZh();
    const hostAgentId = currentHostAgentId();
    const all = (typeof window.ClawThreads !== 'undefined' && Array.isArray(window.ClawThreads.threads))
      ? window.ClawThreads.threads
      : [];
    // 生命状态 closed = 系统清理残迹，不出列表；旧宿主（agentId 不匹配）不展示
    const threads = all
      .filter((thread) => thread?.agentId === hostAgentId && thread.lifeState !== 'closed')
      .slice()
      .sort((left, right) => {
        const lifeLeft = LIFE_ORDER.indexOf(left.lifeState);
        const lifeRight = LIFE_ORDER.indexOf(right.lifeState);
        const orderLeft = lifeLeft === -1 ? LIFE_ORDER.length : lifeLeft;
        const orderRight = lifeRight === -1 ? LIFE_ORDER.length : lifeRight;
        if (orderLeft !== orderRight) return orderLeft - orderRight;
        return Number(right.lastEventAt || right.updatedAt || 0) - Number(left.lastEventAt || left.updatedAt || 0);
      });
    const active = threads.filter((thread) => thread.lifeState !== 'archived');
    const archived = threads.filter((thread) => thread.lifeState === 'archived');

    const tabs = [
      { id: 'threads', label: zh ? `线程 (${active.length})` : `Threads (${active.length})` },
      { id: 'archived', label: zh ? `已归档 (${archived.length})` : `Archived (${archived.length})` },
    ];
    const tabBar = '<div class="coder-threads-tabs">'
      + tabs.map((tab) => (
        '<button type="button" class="coder-threads-tab' + (activeTab === tab.id ? ' active' : '') + '"'
        + ' onclick="window.CoderThreadsUI.switchTab(\'' + tab.id + '\')">' + esc(tab.label) + '</button>'
      )).join('')
      + '</div>';

    const rows = activeTab === 'archived' ? archived : active;
    let listHtml;
    if (rows.length === 0) {
      listHtml = activeTab === 'archived'
        ? '<div class="coder-thread-empty">' + (zh ? '暂无已归档线程。' : 'No archived threads.') + '</div>'
        : '<div class="coder-thread-empty">'
          + (zh
            ? '暂无线程。coder 线程由调度面创建：<br>ACP 编辑器集成（<code>claw acp coder</code>）、CLI（<code>claw threads</code>）或 dispatch 调度技能。'
            : 'No threads yet. Coder threads are created by the dispatch plane:<br>ACP editor integration (<code>claw acp coder</code>), CLI (<code>claw threads</code>), or the dispatch skill.')
          + '</div>';
    } else {
      listHtml = rows.map(renderThread).join('');
    }

    return [
      '<section class="coder-threads">',
      '<div class="coder-panel-heading"><div><div class="coder-panel-kicker">CODER</div><h2>'
      + (zh ? '工作线程' : 'Work threads')
      + '</h2><p>' + (zh
        ? '每行是一条线程：会话在其内接续（trim / 摘要接力），行入口始终指向当前 head。归档的对象是线程，不是会话。'
        : 'Each row is a thread: sessions relay inside it and the row entry always resolves to the current head. Archiving targets the thread, not sessions.')
      + '</p></div></div>',
      tabBar,
      '<div class="coder-thread-list">' + listHtml + '</div>',
      '</section>',
    ].join('');
  }

  function scheduleAutoRefresh() {
    if (refreshTimer) return;
    refreshTimer = setInterval(() => {
      if (typeof document === 'undefined' || document.hidden) return;
      // 只在 coder 线程视图实际可见时轮询重渲染，避免全局后台空转
      if (!document.querySelector('.coder-threads')) return;
      if (typeof window.refreshThreads !== 'function') return;
      Promise.resolve(window.refreshThreads(true))
        .then(() => {
          if (typeof renderCurrentMainView === 'function') renderCurrentMainView();
        }).catch(() => {});
    }, AUTO_REFRESH_INTERVAL);
  }

  // ── 动作 ────────────────────────────────────────────────────────

  async function request(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.message || payload.error || `Request failed (${response.status})`);
    }
    return payload;
  }

  async function refresh() {
    if (typeof window.refreshThreads !== 'function') return;
    await Promise.resolve(window.refreshThreads(true)).catch(() => {});
    if (typeof renderCurrentMainView === 'function') renderCurrentMainView();
  }

  function toastError(error) {
    if (typeof ClawToast !== 'undefined') ClawToast.error(error?.message || 'Thread request failed');
  }

  function getThread(threadId) {
    return (typeof window.getThreadById === 'function') ? window.getThreadById(threadId) : null;
  }

  async function openHead(threadId) {
    if (typeof window.jumpToThreadHead === 'function') {
      await window.jumpToThreadHead(threadId);
    }
  }

  /** 中断此线程：路由到当前 head 会话 runtime 的 turn 中断通道 */
  async function interrupt(threadId) {
    try {
      const thread = getThread(threadId);
      if (!thread?.headViewerAgentId) throw new Error(isZh() ? 'head 会话 runtime 未运行' : 'head runtime is not running');
      const response = await fetch('/api/agents/' + encodeURIComponent(thread.headViewerAgentId) + '/interrupt', { method: 'POST' });
      if (!response.ok) throw new Error(isZh() ? `中断请求失败 (${response.status})` : `interrupt failed (${response.status})`);
      await refresh();
    } catch (error) {
      toastError(error);
    }
  }

  async function archive(threadId) {
    try {
      await request('/protoclaw/threads/' + encodeURIComponent(threadId) + '/archive');
      await refresh();
    } catch (error) {
      toastError(error);
    }
  }

  async function unarchive(threadId) {
    try {
      await request('/protoclaw/threads/' + encodeURIComponent(threadId) + '/unarchive');
      await refresh();
    } catch (error) {
      toastError(error);
    }
  }

  async function resume(threadId) {
    try {
      await request('/protoclaw/threads/' + encodeURIComponent(threadId) + '/resume', { source: 'ui' });
      await refresh();
    } catch (error) {
      toastError(error);
    }
  }

  function switchTab(tab) {
    activeTab = tab === 'archived' ? 'archived' : 'threads';
    if (typeof renderCurrentMainView === 'function') renderCurrentMainView();
  }

  return { render, refresh, openHead, interrupt, archive, unarchive, resume, switchTab };
})();
