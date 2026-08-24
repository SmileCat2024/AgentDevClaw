/**
 * thread-store.js — 工作线程前端承接层
 *
 * 职责：让「AI 对话」具备感知与承接工作线程的能力，而不改变其他
 * 工作空间的默认行为：
 *   - 周期拉取 /protoclaw/threads，维护 threadId / sessionId 双向索引；
 *   - 会话列表项渲染线程徽标（无数据时输出空串，零视觉影响）；
 *   - 顶栏指示器：当前会话属于线程时显示承接状态；非 head 会话
 *     提供显式「前往当前承接会话」入口（绝不静默跳转）；
 *   - 输入路由守卫：当前会话不是线程 head 时，输入改走 Thread Inbox
 *     （防止消息被旧 runtime 消费而丢失在线程外）；
 *   - 提供线程模式提交（submitThreadCommand → Thread Inbox）与
 *     head 推进（threadAdvanceHead）入口。
 *
 * 当前消费方：coder（自动化编码智能体）工作空间。其他工作空间无线程
 * 数据，本模块所有入口均为 no-op / 空输出。
 *
 * 依赖全局（均在运行时调用，加载顺序无关）：
 *   - escapeHtml, currentLanguage (app-core.js)
 *   - getCurrentHostAgentRecord, switchAgent (app-main.js)
 *   - window.runWorkspaceAction (workspace-actions.js)
 */

window.ClawThreads = {
  threads: [],
  byId: {},
  sessionIndex: {}, // `${agentId}::${sessionId}` → thread summary
  lastRefreshAt: 0,
  initialLoadDone: false,
  refreshInFlight: null,
  lastThreadsSig: '',
};

const THREADS_REFRESH_INTERVAL_MS = 20000;

// ── 内部工具 ──────────────────────────────────────────────────────

function _shortThreadId(threadId) {
  const id = String(threadId || '');
  // 'wt-1a2b3c4d-…' → 'wt-1a2b'
  return id.length > 8 ? id.slice(0, 8) : id;
}

function _isZh() {
  return (typeof currentLanguage !== 'undefined' && currentLanguage === 'zh');
}

function _esc(value) {
  if (typeof escapeHtml === 'function') return escapeHtml(value);
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function _rebuildIndexes() {
  const state = window.ClawThreads;
  state.byId = {};
  state.sessionIndex = {};
  for (const thread of state.threads) {
    if (!thread?.threadId) continue;
    state.byId[thread.threadId] = thread;
    for (const sessionId of thread.sessionIds || []) {
      const key = `${thread.agentId}::${sessionId}`;
      // 一个会话原则上只属于一条线性线程；若出现脏数据保留首条
      if (!state.sessionIndex[key]) state.sessionIndex[key] = thread;
    }
  }
}

// ── 状态拉取 ──────────────────────────────────────────────────────

window.refreshThreads = async (force = false) => {
  const state = window.ClawThreads;
  if (state.refreshInFlight) return state.refreshInFlight;
  if (!force && state.initialLoadDone && Date.now() - state.lastRefreshAt < 5000) {
    return;
  }
  state.refreshInFlight = (async () => {
    try {
      const res = await fetch('/protoclaw/threads');
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data?.threads)) {
        state.threads = data.threads;
        _rebuildIndexes();
        // 线程签名变化（新建/推进）时失效 workspace HTML 缓存，
        // 使会话列表在下次渲染时带上最新徽标（不主动触发渲染）。
        const sig = data.threads.map((t) => `${t.threadId}:${t.headSessionId}:${t.status}`).sort().join('|');
        if (sig !== state.lastThreadsSig) {
          state.lastThreadsSig = sig;
          if (typeof lastRenderedWorkspaceHtml !== 'undefined') {
            lastRenderedWorkspaceHtml = '';
          }
        }
      }
    } catch {
      // 服务端不可达 / 路由未注册：静默保持现状
    } finally {
      state.lastRefreshAt = Date.now();
      state.initialLoadDone = true;
      state.refreshInFlight = null;
      window.updateThreadHeaderIndicator();
      // 线程数据更新可能影响暂存气泡（pending 指令增减）与接力分隔条；
      // 聊天渲染有签名去重，这里直接同步，不依赖下一轮 poll。
      if (typeof updateQueueIndicator === 'function') updateQueueIndicator();
      try { _syncThreadRelaySeparator(); } catch { /* 显示增强，失败即跳过 */ }
    }
  })();
  return state.refreshInFlight;
};

// ── 查询 ──────────────────────────────────────────────────────────

window.getThreadById = (threadId) => window.ClawThreads.byId[threadId] || null;

window.getThreadForSession = (agentId, sessionId) => {
  if (!agentId || !sessionId) return null;
  return window.ClawThreads.sessionIndex[`${agentId}::${sessionId}`] || null;
};

/** 当前激活会话（读全局宿主 agent 记录；无记录时返回 null） */
function _currentActiveSession() {
  try {
    if (typeof getCurrentHostAgentRecord === 'function') {
      const agent = getCurrentHostAgentRecord();
      if (agent) {
        return {
          agentId: agent.id || '',
          sessionId: agent.active_workspace_session_id || agent.workspace_sessions?.activeSessionId || '',
        };
      }
    }
  } catch {
    // getCurrentHostAgentRecord 在 app-main 加载前不可用：视为无激活会话
  }
  return null;
}

// ── 会话列表徽标（渲染点由 session-list-render.js 调用）──────────

/**
 * 线程宿主判定（会话级）：给定会话属于某条线程（即 coder 会话）时为真。
 * 线程宿主已从独立工作空间并入编程小助手（sessionType=coder），宿主级
 * 判定无法区分 main 会话与 coder 会话，调用方必须传 sessionId。
 * 线程索引未就绪（首拉前）时保守返回 false。
 */
window.isThreadHostAgentId = (agentId, sessionId) => {
  const id = String(agentId || '').trim();
  if (!id || !sessionId) return false;
  return !!(window.ClawThreads?.sessionIndex
    && window.ClawThreads.sessionIndex[`${id}::${sessionId}`]);
};

/** 交接意图是否仍在窗口内（与服务端 isHandoffActive 同一派生规则） */
function _handoffFresh(thread) {
  return Number(thread?.handoffStartedAt) > 0
    && Date.now() - Number(thread.handoffStartedAt) < THREAD_HANDOFF_STALE_MS;
}

window.renderSessionThreadBadge = (agentId, session) => {
  const thread = window.getThreadForSession(agentId, session?.id);
  if (!thread) return '';

  const isZh = _isZh();
  if (session.id === thread.headSessionId) {
    // 交接窗口内 head 即将退役：显示进行中状态，而非静态归属
    if (_handoffFresh(thread)) {
      const title = `${thread.threadId} · ${isZh ? '正在交接到后续会话' : 'handing off to successor'}`;
      return (
        '<span class="workspace-history-thread handoffing" title="' + _esc(title) + '">' +
        (isZh ? '接力中…' : 'Relaying…') +
        '</span>'
      );
    }
    const chainLen = (thread.sessionIds || []).length;
    const label = chainLen > 1
      ? (isZh ? `线程·第${chainLen}棒` : `Thread·leg ${chainLen}`)
      : (isZh ? '线程·承接中' : 'Thread·head');
    const title = `${thread.threadId} · ${isZh ? '当前承接会话' : 'current head session'}`;
    return (
      '<span class="workspace-history-thread" title="' + _esc(title) + '">' +
      _esc(label) +
      '</span>'
    );
  }

  const title = `${thread.threadId} · ${isZh ? '已由后续会话接续' : 'continued by a successor session'}`;
  return (
    '<span class="workspace-history-thread continued" title="' + _esc(title) + '">' +
    (isZh ? '已接续' : 'Continued') +
    '</span>'
  );
};

// ── 顶栏指示器 ────────────────────────────────────────────────────

window.updateThreadHeaderIndicator = () => {
  const anchor = document.getElementById('chat-context-bar');
  if (!anchor || !anchor.parentElement) return;

  let el = document.getElementById('thread-header-indicator');
  const active = _currentActiveSession();
  const thread = active ? window.getThreadForSession(active.agentId, active.sessionId) : null;

  if (!thread) {
    if (el) el.remove();
    return;
  }

  const isZh = _isZh();
  const shortId = _shortThreadId(thread.threadId);
  const isHead = active && active.sessionId === thread.headSessionId;

  if (!el) {
    el = document.createElement('span');
    el.id = 'thread-header-indicator';
    anchor.parentElement.insertBefore(el, anchor);
  }

  if (isHead) {
    if (_handoffFresh(thread)) {
      el.className = 'thread-header-indicator relaying';
      el.onclick = null;
      el.title = `${thread.threadId} · ${isZh ? '正在交接到后续会话，期间输入将暂存到线程' : 'handing off; input will be staged in the thread'}`;
      el.textContent = isZh ? '上下文接力中…' : 'Relaying context…';
    } else {
      el.className = 'thread-header-indicator';
      el.onclick = null;
      el.title = `${thread.threadId} · ${isZh ? '当前承接会话' : 'current head session'}`;
      el.textContent = isZh ? `线程 ${shortId} · 承接中` : `Thread ${shortId} · head`;
    }
  } else {
    el.className = 'thread-header-indicator clickable';
    el.title = isZh
      ? `该会话已由工作线程接续至 ${thread.headSessionId}，点击前往当前承接会话`
      : `Continued to ${thread.headSessionId}. Click to open the current head session.`;
    el.textContent = isZh ? '已接续 · 前往当前会话' : 'Continued · open head';
    el.onclick = () => {
      window.jumpToThreadHead(thread.threadId);
    };
  }
};

// ── 输入路由守卫 ──────────────────────────────────────────────────

/**
 * 交接意图陈旧线（与服务端 thread-controller HANDOFF_STALE_MS 一致）：
 * handoffStartedAt 超过该时长视为无交接。两侧派生规则必须同步维护。
 */
const THREAD_HANDOFF_STALE_MS = 5 * 60 * 1000;

/**
 * 本地即时信号：当前 agent 是否有进行中的「创建接续会话」侧栏操作
 * （trim / summary 最终都是 type='create'）。覆盖本页面发起的交接窗口，
 * 弥补 20s 线程轮询对「交接刚开始」的感知滞后。
 */
function _hasActiveHandoffOperation(agentId) {
  if (typeof findSidebarOperation !== 'function') return false;
  return Boolean(findSidebarOperation((op) => (
    op?.agentId === agentId
    && op?.type === 'create'
    && op?.phase !== 'settled'
  )));
}

/**
 * 判定当前激活会话的输入应走哪条路径。输入三层分工：
 *
 *   意图归属 = 工作    → Thread Inbox（持久，跨会话/跨重启）
 *                仅在目标 runtime 不可靠时使用（交接窗口 / 非 head）；
 *   意图归属 = runtime → viewer user-turn（忙时进 viewer 队列，call 间排队）
 *                runtime 健康、会话是 head 时永远直走（PH 纯会话零经过）。
 *
 * - 'direct'：当前会话是线程 head（或无线程）且无交接 → 现有输入契约；
 * - 'thread'：会话已被 successor 接续（非 head），或线程正在交接
 *   （head 即将退役，此时直投的执行结果会留在旧会话、不被 successor 带走）
 *   → 改走 Thread Inbox，交接完成后由服务端投向新 head。
 */
window.resolveThreadInputRoute = () => {
  const active = _currentActiveSession();
  if (!active || !active.agentId || !active.sessionId) return { route: 'direct' };
  const thread = window.getThreadForSession(active.agentId, active.sessionId);
  if (!thread || thread.status === 'closed') return { route: 'direct' };
  if (active.sessionId !== thread.headSessionId) {
    return { route: 'thread', thread, reason: 'session_not_head' };
  }
  // 当前会话是 head：交接窗口内它即将退役，输入必须暂存
  const handoffFresh = Number(thread.handoffStartedAt) > 0
    && Date.now() - Number(thread.handoffStartedAt) < THREAD_HANDOFF_STALE_MS;
  if (handoffFresh || _hasActiveHandoffOperation(active.agentId)) {
    return { route: 'thread', thread, reason: 'handoff_in_progress' };
  }
  return { route: 'direct', thread };
};

/**
 * 当前激活会话所属线程的 pending 指令文本（暂存气泡数据源）。
 * 无线程 / 无 pending 返回空数组。
 */
window.getThreadPendingTexts = () => {
  const active = _currentActiveSession();
  if (!active || !active.agentId || !active.sessionId) return [];
  const thread = window.getThreadForSession(active.agentId, active.sessionId);
  if (!thread || Array.isArray(thread.pendingTexts)) {
    return Array.isArray(thread?.pendingTexts) ? thread.pendingTexts : [];
  }
  return [];
};

// ── 接力分隔条（聊天区顶部：非 root 棒显示来源与方式）──────────────

/**
 * 查询会话的接力边信息（它从哪个会话、以何种方式接续而来）。
 * 返回 { threadId, fromSessionId, relayKind } 或 null。
 */
window.getThreadRelayEdge = (agentId, sessionId) => {
  const thread = window.getThreadForSession(agentId, sessionId);
  if (!thread) return null;
  const edges = Array.isArray(thread.chainEdges) ? thread.chainEdges : [];
  const edge = edges.find((e) => e?.sessionId === sessionId);
  if (!edge || !edge.fromSessionId) return null;
  return { threadId: thread.threadId, fromSessionId: edge.fromSessionId, relayKind: edge.relayKind || '' };
};

/**
 * 接力分隔条 HTML（聊天区首条消息前渲染；无线程 / root 棒返回空串）。
 * fromTitle 从工作区会话记录解析；找不到时退化为短 id。
 */
window.renderThreadRelaySeparatorHtml = (agentId, sessionId) => {
  const edge = window.getThreadRelayEdge(agentId, sessionId);
  if (!edge) return '';

  const isZh = _isZh();
  const kindLabel = edge.relayKind === 'trim'
    ? (isZh ? '精简' : 'trim')
    : (isZh ? '摘要' : 'summary');

  const fromTitle = _resolveSessionTitle(agentId, edge.fromSessionId);
  const shortFrom = _shortSessionId(edge.fromSessionId);

  const title = isZh
    ? `${edge.threadId} · 由会话 ${shortFrom} 经${kindLabel}交接接续`
    : `${edge.threadId} · relayed from ${shortFrom} via ${kindLabel} handoff`;
  const label = isZh
    ? `已从「${fromTitle}」接续 · ${kindLabel}交接`
    : `Continued from "${fromTitle}" · ${kindLabel} handoff`;

  return (
    '<div class="thread-relay-separator" data-thread-relay="' + _esc(edge.threadId) + '" title="' + _esc(title) + '">' +
    '<div class="thread-relay-line"></div>' +
    '<div class="thread-relay-label"><svg width="11" height="11" viewBox="0 0 14 14" fill="currentColor"><path d="M7 1a6 6 0 0 1 6 6 6 6 0 0 1-6 6H2.5a1.5 1.5 0 0 1 0-3H7a3 3 0 1 0-3-3 1.5 1.5 0 0 1-3 0A6 6 0 0 1 7 1z"/></svg>' +
    _esc(label) + '</div>' +
    '<div class="thread-relay-line"></div>' +
    '</div>'
  );
};

/** 从 allAgents 工作区会话记录解析标题；无记录时返回短 id */
function _resolveSessionTitle(agentId, sessionId) {
  try {
    if (typeof allAgents !== 'undefined' && Array.isArray(allAgents)) {
      const agent = allAgents.find((a) => a?.id === agentId);
      const sessions = agent?.workspace_sessions?.sessions;
      const session = Array.isArray(sessions) ? sessions.find((s) => s?.id === sessionId) : null;
      const title = String(session?.title || '').trim();
      if (title) return title;
    }
  } catch { /* allAgents 不可用时退化为短 id */ }
  return _shortSessionId(sessionId);
}

function _shortSessionId(sessionId) {
  const id = String(sessionId || '');
  // 'session-1787188474941-c5e1de' → 保留尾部哈希段
  const tail = id.split('-').filter(Boolean).pop();
  return tail ? `…${tail}` : id.slice(-8);
}

/**
 * 分隔条 DOM 同步：期望存在但缺失 → 插入；期望缺失但存在 → 移除；
 * threadId 变化 → 原位替换。只动分隔条节点，不触碰消息区。
 */
function _syncThreadRelaySeparator() {
  if (typeof container === 'undefined' || !container) return;
  const active = _currentActiveSession();
  const expectedHtml = active && typeof window.renderThreadRelaySeparatorHtml === 'function'
    ? window.renderThreadRelaySeparatorHtml(active.agentId, active.sessionId)
    : '';
  const existing = container.querySelector(':scope > .thread-relay-separator');
  if (!expectedHtml) {
    if (existing) existing.remove();
    return;
  }
  if (existing) {
    const nextThread = _extractRelayThreadId(expectedHtml);
    if (existing.dataset.threadRelay !== nextThread) existing.remove();
    else return;
  }
  // 消息区存在时插到最前；空态（welcome）时不插（render 会重新处理）
  if (container.querySelector('.message-row')) {
    container.insertAdjacentHTML('afterbegin', expectedHtml);
  }
}

/** 从分隔条 HTML 提取 threadId（data-thread-relay 属性值） */
function _extractRelayThreadId(html) {
  const match = String(html || '').match(/data-thread-relay="([^"]*)"/);
  return match ? match[1] : '';
}

// ── 线程动作 ──────────────────────────────────────────────────────

window.jumpToThreadHead = async (threadId) => {
  const thread = window.getThreadById(threadId);
  if (!thread || !thread.headSessionId) return { ok: false, reason: 'thread_not_found' };

  const active = _currentActiveSession();
  if (active && active.agentId === thread.agentId && active.sessionId === thread.headSessionId) {
    return { ok: true, already: true };
  }

  // 线程会话属于 thread.agentId 的工作空间；跨空间先切换宿主
  if (active && active.agentId && active.agentId !== thread.agentId && typeof window.switchAgent === 'function') {
    await window.switchAgent(thread.agentId);
  }

  if (typeof window.runWorkspaceAction === 'function') {
    await window.runWorkspaceAction(JSON.stringify({ type: 'open_session', sessionId: thread.headSessionId }));
  }
  window.updateThreadHeaderIndicator();
  return { ok: true };
};

window.submitThreadCommand = async (threadId, text, options = {}) => {
  const idempotencyKey =
    options.idempotencyKey ||
    `ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const res = await fetch(`/protoclaw/threads/${encodeURIComponent(threadId)}/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: options.kind || 'user_message',
      text: String(text || ''),
      source: options.source || 'ui',
      idempotencyKey,
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    throw new Error(data?.message || `submitThreadCommand failed (${res.status})`);
  }
  return data;
};

window.threadAdvanceHead = async (threadId, toSessionId, options = {}) => {
  const res = await fetch(`/protoclaw/threads/${encodeURIComponent(threadId)}/head`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      toSessionId,
      fromSessionId: options.fromSessionId,
      expectedRevision: options.expectedRevision,
      endKind: options.endKind,
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    throw new Error(data?.message || `threadAdvanceHead failed (${res.status})`);
  }
  await window.refreshThreads(true);
  return data;
};

// ── 启动（周期刷新；非线程宿主的服务端列表恒空，开销可忽略）──────

setTimeout(() => {
  window.refreshThreads(true);
}, 2000);

setInterval(() => {
  if (document.visibilityState === 'visible') {
    window.refreshThreads();
  }
}, THREADS_REFRESH_INTERVAL_MS);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    window.refreshThreads();
  }
});
