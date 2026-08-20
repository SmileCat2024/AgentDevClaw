/**
 * thread-store.js — 工作线程前端承接层（悬置地基）
 *
 * 职责：让「AI 对话」具备感知与承接工作线程的能力，而不改变任何
 * 默认行为：
 *   - 周期拉取 /protoclaw/threads，维护 threadId / sessionId 双向索引；
 *   - 会话列表项可渲染线程徽标（无数据时输出空串，零视觉影响）；
 *   - 顶栏指示器：当前会话属于线程时显示承接状态；非 head 会话
 *     提供显式「前往当前承接会话」入口（绝不静默跳转）；
 *   - 提供线程模式提交（submitThreadCommand → Thread Inbox）与
 *     head 推进（threadAdvanceHead）入口，供未来接线。
 *
 * 地基阶段：服务端无任何流程创建线程 → 列表恒为空 → 徽标与指示器
 * 恒不渲染；普通输入路径完全不经过本模块。
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
      }
    } catch {
      // 服务端不可达 / 路由未注册：静默保持现状（悬置地基下无数据）
    } finally {
      state.lastRefreshAt = Date.now();
      state.initialLoadDone = true;
      state.refreshInFlight = null;
      window.updateThreadHeaderIndicator();
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

window.renderSessionThreadBadge = (agentId, session) => {
  const thread = window.getThreadForSession(agentId, session?.id);
  if (!thread || thread.status === 'cancelled') return '';

  const isZh = _isZh();
  if (session.id === thread.headSessionId) {
    const title = `${thread.threadId} · ${isZh ? '当前承接会话' : 'current head session'}`;
    return (
      '<span class="workspace-history-thread" title="' + _esc(title) + '">' +
      (isZh ? '线程·承接中' : 'Thread·head') +
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

  if (!thread || thread.status === 'cancelled') {
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
    el.className = 'thread-header-indicator';
    el.onclick = null;
    el.title = `${thread.threadId} · ${isZh ? '当前承接会话' : 'current head session'}`;
    el.textContent = isZh ? `线程 ${shortId} · 承接中` : `Thread ${shortId} · head`;
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

// ── 线程动作（未来接线入口；默认 UI 不触发）──────────────────────

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

// ── 启动（周期刷新；悬置阶段列表恒空，开销可忽略）────────────────

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
