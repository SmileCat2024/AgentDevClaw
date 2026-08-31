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
      actions.push(
        '<button class="coder-btn secondary" type="button" onclick="window.CoderThreadsUI.archive(\'' + esc(thread.threadId) + '\')">'
        + (zh ? '归档' : 'Archive') + '</button>',
        '<button class="coder-btn danger" type="button" title="' + esc(zh ? '删除整个线程及其全部会话（不可撤销）' : 'Delete the whole thread and all its sessions (irreversible)') + '" onclick="window.CoderThreadsUI.remove(\'' + esc(thread.threadId) + '\')">'
        + (zh ? '删除' : 'Delete') + '</button>',
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
      + (!archived && thread.headSessionId ? ' style="cursor:pointer" onclick="if(event.target.closest(\'.coder-btn\'))return;window.CoderThreadsUI.openHead(\'' + esc(thread.threadId) + '\')"' : '')
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

  /** 目录归一化：项目归属比较统一小写正斜杠 */
  function normalizeDir(dir) {
    return String(dir || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  function render(options = {}) {
    const projectDir = options.projectDir ? normalizeDir(options.projectDir) : '';
    const embedded = !!projectDir; // 项目卡片内嵌模式：无二级 tab、无标题栏
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
    // 生命状态 closed = 系统清理残迹，不出列表；旧宿主（agentId 不匹配）不展示；
    // 项目内嵌模式按 head 会话的项目目录归属过滤
    const threads = all
      .filter((thread) => thread?.agentId === hostAgentId && thread.lifeState !== 'closed')
      .filter((thread) => !projectDir || normalizeDir(thread.headProjectDir) === projectDir)
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

    if (embedded) {
      // 项目卡片内嵌：合并展示（活跃在前，已归档弱化在后），无二级 tab 与标题栏
      const merged = [...active, ...archived];
      const mergedHtml = merged.length
        ? merged.map(renderThread).join('')
        : '<div class="coder-thread-empty">' + (zh ? '本项目暂无 Coder 线程。' : 'No Coder threads in this project yet.') + '</div>';
      return '<div class="coder-threads embedded">' + mergedHtml + '</div>';
    }

    const rows = activeTab === 'archived' ? archived : active;
    let listHtml;
    if (rows.length === 0) {
      listHtml = activeTab === 'archived'
        ? '<div class="coder-thread-empty">' + (zh ? '暂无已归档线程。' : 'No archived threads.') + '</div>'
        : '<div class="coder-thread-empty">'
          + (zh
            ? '暂无线程。Coder 线程由调度面创建：<br>ACP 编辑器集成（<code>claw acp coder</code>）、CLI（<code>claw threads</code>）或 dispatch 调度技能。'
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
      const visible = document.querySelector('.coder-threads');
      if (!visible) return;
      // 项目卡片内嵌模式：面板未激活（停留在主会话/已归档 tab）时不轮询
      const hostPanel = visible.closest('.ph-session-tab-panel');
      if (hostPanel && !hostPanel.classList.contains('active')) return;
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
      const response = await fetch('/api/agents/' + encodeURIComponent(thread.headViewerAgentId) + '/interrupt', { method: 'POST', headers: { 'x-idempotency-key': newIdempotencyKey() } });
      if (!response.ok) throw new Error(isZh() ? `中断请求失败 (${response.status})` : `interrupt failed (${response.status})`);
      await refresh();
    } catch (error) {
      toastError(error);
    }
  }

  async function archive(threadId) {
    try {
      const payload = await request('/protoclaw/threads/' + encodeURIComponent(threadId) + '/archive');
      showArchiveResult(payload);
      await refresh();
    } catch (error) {
      toastError(error);
    }
  }

  /**
   * 归档取消结果文案（纯函数，可测）：T006——不得提示「恢复后自动继续
   * 已取消指令」。以服务端 cleanup 事实构建展示文案。
   */
  function archiveResultText(cleanup, zh = false) {
    const cancelled = Number(cleanup?.commandsCancelled) || 0;
    const inflight = Number(cleanup?.inflightDrain?.count) || 0;
    const converged = cleanup?.handoffConverged === true;
    return [
      converged ? (zh ? '新派发已拒绝，不再投往旧 head。' : 'New deliveries rejected; no longer routed to the old head.') : '',
      cancelled > 0 ? (zh ? `${cancelled} 条未开始指令已取消。` : `${cancelled} pending command(s) cancelled.`) : (zh ? '无待投递指令。' : 'No queued commands.'),
      inflight > 0 ? (zh ? `${inflight} 条运行中调用已收尾。` : `${inflight} running call(s) settled.`) : '',
      (zh ? '恢复（取消归档）不复活已取消的指令。' : 'Unarchive will not revive cancelled commands.'),
    ].filter(Boolean).join(zh ? '；' : ' ');
  }

  /**
   * 删除确认文案（纯函数，可测）：T006——明确确认 + 展示级联影响范围。
   * 该线程所有成员会话、handoff、执行记录一并删除，不可撤销。
   */
  function deleteConfirmText(thread, zh = false) {
    const members = Array.isArray(thread?.sessionChain)
      ? thread.sessionChain.map((e) => e?.sessionId).filter(Boolean)
      : [];
    if (thread?.headSessionId) members.push(thread.headSessionId);
    if (thread?.rootSessionId) members.push(thread.rootSessionId);
    const memberCount = new Set(members).size;
    const pendingCount = (Array.isArray(thread?.commands)
      ? thread.commands.filter((c) => c?.status === 'pending' || c?.status === 'in_flight').length : 0);
    return zh
      ? `确定要删除该线程吗？将删除其全部 ${memberCount} 个会话（含当前 head）、交接记录与执行记录，不可撤销。`
        + (pendingCount > 0 ? `其中 ${pendingCount} 条待投递/运行中指令会被取消。` : '')
        + '删除后无法恢复。'
      : `Delete this thread? ${memberCount} session(s) (including the current head), handoff and execution records will be removed. This cannot be undone.`
        + (pendingCount > 0 ? ` ${pendingCount} queued/running command(s) will be cancelled.` : '');
  }

  /**
   * 归档取消结果展示（T006：不得提示「恢复后自动继续已取消指令」）。
   * 服务端 cleanup 是归档事务事实（thread-lifecycle）：
   *   - handoffConverged  交接挡板被收敛（后续新派发被拒绝，不再投往旧 head）；
   *   - commandsCancelled  未开始指令已取消（count）；
   *   - inflightDrain.count 已开始的调用数目（允许自然完成/收尾中）。
   */
  function showArchiveResult(payload) {
    const cleanup = payload?.cleanup;
    if (!cleanup) return; // 无取消结果可展示（老服务端/缺字段）——不编造
    if (typeof ClawToast === 'undefined') return;
    const zh = isZh();
    const partial = cleanup.status === 'partial';
    ClawToast.show({
      id: 'thread-archive-' + (payload?.threadId || ''),
      status: partial ? 'warning' : 'success',
      title: zh ? (partial ? '归档完成（部分收尾未确认）' : '已归档') : (partial ? 'Archived (partial cleanup)' : 'Archived'),
      description: archiveResultText(cleanup, zh),
    });
  }

  /**
   * 删除线程（T006：明确确认 + 展示级联影响范围，绝不经无确认路径）。
   * 该线程的所有成员会话、handoff、执行记录、归档索引与 record 一并删除，
   * 不可撤销；运行中调用会收尾（自然完成，超时强停）。确认文本把级联
   * 影响范围讲清楚后再提交。
   */
  async function remove(threadId) {
    const thread = getThread(threadId);
    const zh = isZh();
    const confirmed = window.confirm(deleteConfirmText(thread, zh));
    if (!confirmed) return;
    try {
      const payload = await request('/protoclaw/threads/' + encodeURIComponent(threadId) + '/delete');
      showDeleteResult(payload, threadId);
      await refresh();
    } catch (error) {
      toastError(error);
    }
  }

  function showDeleteResult(payload, threadId) {
    if (typeof ClawToast === 'undefined') return;
    const zh = isZh();
    const partial = payload?.status === 'partial' || payload?.ok === false;
    const cancelled = Number(payload?.cleanup?.commandsCancelled) || 0;
    const desc = [
      zh ? `已删除线程 ${threadId.slice(0, 10)} 的 ${(payload?.cleanup?.sessionIds || []).length} 个会话。` : `Deleted ${(payload?.cleanup?.sessionIds || []).length} session(s) of thread ${threadId.slice(0, 10)}.`,
      cancelled > 0 ? (zh ? `${cancelled} 条指令已取消。` : `${cancelled} command(s) cancelled.`) : '',
    ].filter(Boolean).join(' ');
    ClawToast.show({
      id: 'thread-delete-' + threadId,
      status: partial ? 'warning' : 'success',
      title: zh ? (partial ? '已删除（部分残留待清理）' : '已删除') : (partial ? 'Deleted (residual cleanup pending)' : 'Deleted'),
      description: desc,
    });
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

  /** 项目内嵌视图的 tab 计数：归属该项目且未归档的线程数 */
  function countFor(projectDir) {
    const dir = normalizeDir(projectDir);
    if (!dir) return 0;
    const hostAgentId = currentHostAgentId();
    const all = (typeof window.ClawThreads !== 'undefined' && Array.isArray(window.ClawThreads.threads))
      ? window.ClawThreads.threads
      : [];
    return all.filter((thread) => thread?.agentId === hostAgentId
      && thread.lifeState !== 'closed'
      && thread.lifeState !== 'archived'
      && normalizeDir(thread.headProjectDir) === dir).length;
  }

  function switchTab(tab) {
    activeTab = tab === 'archived' ? 'archived' : 'threads';
    if (typeof renderCurrentMainView === 'function') renderCurrentMainView();
  }

  return { render, refresh, openHead, interrupt, archive, unarchive, resume, remove, switchTab, countFor, archiveResultText, deleteConfirmText };
})();
