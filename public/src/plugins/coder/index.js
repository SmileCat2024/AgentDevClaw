/**
 * index.js — coder 前端插件入口
 *
 * 形态：coder APP 首页的线程列表视图（原 modules/coder-threads-ui.js），
 * 以插件形式挂到宿主：装载时注册 coder-threads block 与行动作 action，
 * 卸载时全部摘除（含自动刷新定时器）。
 *
 * 心智：行 = 线程（不是会话）。会话是实体层，线程是把链条成员折叠成
 * 一行的连接结构；行入口每次动态解析当前 head（不自动跳转）。
 *
 * - 生命状态四态（thread-life-state.js 合成，随 /protoclaw/threads 附带）：
 *   executing / pending-commands / idle / archived，failed 为独立注意力信号；
 * - 行动作：打开 head（整卡可点）、中断（路由到 head runtime 的 turn
 *   中断通道）、归档（任何非归档状态可用——生产 lifecycle 归档即打断
 *   收纳：seal 取消 pending + 停全链 runtime，不做 busy 拒绝）、取消归档
 *   （已归档 tab）、删除（明确确认 + 级联影响展示）；
 * - 归档宾语是线程：成员会话不动，视图按线程归档态折叠；
 * - 空态是教育点：线程由调度面创建（ACP / claw threads CLI / dispatch
 *   技能），本视图不提供任何创建动作；
 * - UI 不提供向线程发消息的通道（调度纪律：依赖由调度方控制）。
 *
 * 数据源：thread-store.js 的 ClawThreads（20s 轮询 + 签名失效重渲染），
 * 本插件再加 5s 强刷（surface 可见期）。thread-store 是宿主侧数据层
 * 单例（ClawThreads / refreshThreads / getThreadById / openConversationTarget），
 * 与 ClawToast、openReadOnlySession 一样属宿主提供的全局通道，经 window
 * 读取并带存在性守卫；其余宿主能力一律经 mount 注入。
 *
 * 插件协议（ClawHost.loadPlugin 消费）：
 *   id       插件标识，用于卸载时按 owner 精确摘除自己的注册项
 *   blocks   { type: renderer }，渲染器签名 (agent, block) => html
 *   mount(host)    装载后调用，注入宿主能力
 *   unmount()      卸载前调用，清理定时器与视图状态
 */

const AUTO_REFRESH_INTERVAL = 5000;

let host = null;

let refreshTimer = null;
let activeTab = 'threads'; // 'threads' | 'archived'

// ── 工具（宿主能力经注入；未 mount 前的防御性回退仅供纯函数测试路径）──

function isZh() {
  return host ? host.env.isZh() : true;
}

function esc(value) {
  if (host) return host.env.escapeHtml(value);
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

/** 当前渲染宿主：coder APP 自身（焦点即条目记录） */
function currentHostAgentId() {
  const agent = host ? host.workspace.currentAgent() : null;
  return agent?.id || '';
}

/** head 会话标题（线程标题缺省时回退） */
function headSessionTitle(hostAgentId, sessionId) {
  const agent = host ? host.workspace.agentById(hostAgentId) : null;
  const sessions = agent?.workspace_sessions?.sessions;
  const session = Array.isArray(sessions) ? sessions.find((s) => s?.id === sessionId) : null;
  const title = String(session?.title || '').trim();
  return title;
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

// ── 行渲染 ──────────────────────────────────────────────────────

/** 行动按钮（data-action + data-thread-id；分发器从 target 向上取第一个
 *  data-action，按钮先于卡片命中，等价于原「closest('.coder-btn') 排除」）。 */
function actionButton({ cls, label, action, threadId, title }) {
  return '<button class="coder-btn ' + cls + '" type="button"'
    + (title ? ' title="' + esc(title) + '"' : '')
    + ' data-action="' + action + '" data-thread-id="' + esc(threadId) + '">'
    + esc(label) + '</button>';
}

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
  // ADR-0041：标题只认当前 head Session 的索引标题；线程记录里的 title
  // 是历史实现残留，不参与展示（否则接续换头后会出现双真相回退）。
  const title = String(thread.headSessionTitle || '').trim()
    || headSessionTitle(thread.agentId, thread.headSessionId)
    || shortId(thread.threadId);

  const actions = [];
  if (!archived && thread.headSessionId) {
    actions.push(actionButton({
      cls: 'secondary', action: 'coderThreads.openHead', threadId: thread.threadId,
      label: zh ? '打开 head' : 'Open head',
    }));
  }
  // 已归档线程：可经只读浏览查看 head 会话内容（归档禁止启动 runtime，
  // 不禁止查看）。与「取消归档」并列，语义是读历史而非恢复运行。
  if (archived && thread.headSessionId) {
    actions.push(actionButton({
      cls: 'secondary', action: 'coderThreads.openArchived', threadId: thread.threadId,
      label: zh ? '查看内容' : 'View content',
    }));
  }
  if (!archived && busy && thread.headViewerAgentId) {
    actions.push(actionButton({
      cls: 'danger', action: 'coderThreads.interrupt', threadId: thread.threadId,
      label: zh ? '中断' : 'Interrupt',
      title: zh ? '中断当前 head 会话正在执行的 turn' : 'Interrupt the turn running on the current head session',
    }));
  }
  if (!archived) {
    actions.push(actionButton({
      cls: 'secondary', action: 'coderThreads.archive', threadId: thread.threadId,
      label: zh ? '归档' : 'Archive',
    }));
    actions.push(actionButton({
      cls: 'danger', action: 'coderThreads.remove', threadId: thread.threadId,
      label: zh ? '删除' : 'Delete',
      title: zh ? '删除整个线程及其全部会话（不可撤销）' : 'Delete the whole thread and all its sessions (irreversible)',
    }));
  } else {
    actions.push(actionButton({
      cls: 'secondary', action: 'coderThreads.unarchive', threadId: thread.threadId,
      label: zh ? '取消归档' : 'Unarchive',
    }));
  }
  if (!archived && failed) {
    actions.push(actionButton({
      cls: '', action: 'coderThreads.resume', threadId: thread.threadId,
      label: zh ? '恢复' : 'Resume',
    }));
  }

  const statusClasses = ['coder-thread-status', 'status-' + esc(lifeState)];
  if (failed) statusClasses.push('is-failed');

  // 整卡可点（非归档且有 head）：与按钮同一动作名——点击按钮时按钮自身的
  // data-action 先被分发器命中，卡片动作不会被重复触发。
  const cardAction = (!archived && thread.headSessionId)
    ? ' data-action="coderThreads.openHead" data-thread-id="' + esc(thread.threadId) + '"'
      + ' style="cursor:pointer"'
    : '';

  return [
    '<article class="coder-thread-card' + (archived ? ' archived' : '') + '" data-thread-id="' + esc(thread.threadId) + '"'
    + cardAction
    + ' title="' + esc(thread.threadId) + '">',
    '<div class="coder-thread-card-head">',
    '<span class="' + statusClasses.join(' ') + '">' + esc(lifeLabel(lifeState)) + '</span>',
    '',
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
  // 生命状态 closed = 系统清理残迹，不出列表；旧宿主（agentId 不匹配）不展示。
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
      + ' data-action="coderThreads.switchTab" data-tab="' + esc(tab.id) + '">' + esc(tab.label) + '</button>'
    )).join('')
    + '</div>';

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
    if (typeof window.refreshThreads !== 'function') return;
    Promise.resolve(window.refreshThreads(true))
      .then(() => {
        if (host) host.workspace.rerender();
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
  if (host) host.workspace.rerender();
}

function toastError(error) {
  if (typeof window.ClawToast !== 'undefined') window.ClawToast.error(error?.message || 'Thread request failed');
}

function getThread(threadId) {
  return (typeof window.getThreadById === 'function') ? window.getThreadById(threadId) : null;
}

async function openHead(threadId) {
  const thread = getThread(threadId);
  if (!thread) return;
  if (typeof window.openConversationTarget === 'function') {
    await window.openConversationTarget({ agentId: thread.agentId, threadId: thread.threadId });
  }
}

/**
 * 已归档线程的只读查看：读 head 会话的持久记录，不启动 runtime。
 * 归档会话经 activate 会被服务端以 thread_archived 拒绝，这里是唯一
 * 可用的查看入口（与侧栏归档对话同一实现）。
 */
async function openArchived(threadId) {
  const thread = getThread(threadId);
  if (!thread?.headSessionId) return;
  if (typeof window.openReadOnlySession !== 'function') return;
  await window.openReadOnlySession({
    agentId: thread.agentId,
    sessionId: thread.headSessionId,
    threadId: thread.threadId,
    title: String(thread.headSessionTitle || '').trim(),
    archived: true,
  });
}

/** 中断此线程：路由到当前 head 会话 runtime 的 turn 中断通道 */
async function interrupt(threadId) {
  try {
    const thread = getThread(threadId);
    if (!thread?.headViewerAgentId) throw new Error(isZh() ? 'head 会话 runtime 未运行' : 'head runtime is not running');
    const response = await fetch('/api/agents/' + encodeURIComponent(thread.headViewerAgentId) + '/interrupt', {
      method: 'POST',
      headers: { 'x-idempotency-key': host ? host.env.newIdempotencyKey() : '' },
    });
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
 * 归档结果文案（纯函数，可测）：以服务端 cleanup 事实构建，只讲实际
 * 发生的事。「已取消消息不随恢复重发」的提醒仅在真的取消了消息时出现
 * ——空闲归档时无来由地提「指令」只会制造困惑（不得反向暗示「恢复后
 * 自动继续已取消指令」，T006 底线不变）。
 */
export function archiveResultText(cleanup, zh = false) {
  const cancelled = Number(cleanup?.commandsCancelled) || 0;
  const inflight = Number(cleanup?.inflightDrain?.count) || 0;
  const converged = cleanup?.handoffConverged === true;
  const parts = [];
  if (cancelled > 0) parts.push(zh ? `${cancelled} 条排队中的消息已取消。` : `${cancelled} queued message(s) cancelled.`);
  if (inflight > 0) parts.push(zh ? `${inflight} 项进行中的任务正在收尾。` : `${inflight} running task(s) finishing up.`);
  if (converged) parts.push(zh ? '归档后不再接收新消息。' : 'No new messages while archived.');
  if (cancelled > 0) parts.push(zh ? '取消归档后这些消息不会自动重新发送。' : 'Unarchiving won\'t resend them.');
  return parts.join(zh ? '' : ' ');
}

/**
 * 删除确认文案（纯函数，可测）：T006——明确确认 + 展示级联影响范围。
 * 该线程所有成员会话、handoff、执行记录一并删除，不可撤销。
 */
export function deleteConfirmText(thread, zh = false) {
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
  if (typeof window.ClawToast === 'undefined') return;
  const zh = isZh();
  const partial = cleanup.status === 'partial';
  window.ClawToast.show({
    id: 'thread-archive-' + (payload?.threadId || ''),
    status: partial ? 'warning' : 'success',
    title: zh ? (partial ? '已归档（部分收尾未确认）' : '已归档') : (partial ? 'Archived (partial cleanup unconfirmed)' : 'Archived'),
    description: archiveResultText(cleanup, zh) || undefined,
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
  if (typeof window.ClawToast === 'undefined') return;
  const zh = isZh();
  const partial = payload?.status === 'partial' || payload?.ok === false;
  const cancelled = Number(payload?.cleanup?.commandsCancelled) || 0;
  const desc = [
    zh ? `已删除线程 ${threadId.slice(0, 10)} 的 ${(payload?.cleanup?.sessionIds || []).length} 个会话。` : `Deleted ${(payload?.cleanup?.sessionIds || []).length} session(s) of thread ${threadId.slice(0, 10)}.`,
    cancelled > 0 ? (zh ? `${cancelled} 条指令已取消。` : `${cancelled} command(s) cancelled.`) : '',
  ].filter(Boolean).join(' ');
  window.ClawToast.show({
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

function switchTab(tab) {
  activeTab = tab === 'archived' ? 'archived' : 'threads';
  if (host) host.workspace.rerender();
}

// ── 插件协议 ────────────────────────────────────────────────────

export default {
  id: 'coder',

  blocks: {
    'coder-threads': () => render(),
  },

  actions: {
    'coderThreads.openHead': (el) => openHead(el.dataset.threadId),
    'coderThreads.openArchived': (el) => openArchived(el.dataset.threadId),
    'coderThreads.interrupt': (el) => interrupt(el.dataset.threadId),
    'coderThreads.archive': (el) => archive(el.dataset.threadId),
    'coderThreads.remove': (el) => remove(el.dataset.threadId),
    'coderThreads.unarchive': (el) => unarchive(el.dataset.threadId),
    'coderThreads.resume': (el) => resume(el.dataset.threadId),
    'coderThreads.switchTab': (el) => switchTab(el.dataset.tab),
  },

  mount(api) {
    host = api;
  },

  unmount() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    activeTab = 'threads'; // 视图状态复位：重新装载从默认 tab 开始
    host = null;
  },
};
