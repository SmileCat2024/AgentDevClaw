/**
 * thread-store.js — 工作线程前端承接层
 *
 * 职责：让「AI 对话」具备感知与承接工作线程的能力，而不改变其他
 * 工作空间的默认行为；线程宿主 APP（coder）的侧栏保持为稳定的
 * 线程入口：
 *   - 周期拉取 /protoclaw/threads，维护 threadId / sessionId 双向索引；
 *   - 会话列表项渲染线程徽标（无数据时输出空串，零视觉影响）；
 *   - 顶栏指示器：当前会话属于线程时显示承接状态；非 head 会话
 *     提供显式「前往当前承接会话」入口（浏览历史时不自动跳转）；
 *   - 输入路由守卫：当前会话不是线程 head 时，输入改走 Thread Inbox
 *     （防止消息被旧 runtime 消费而丢失在线程外）；
 *   - 提供线程模式提交（submitThreadCommand → Thread Inbox）与
 *     head 推进（threadAdvanceHead）入口。
 *
 * 当前消费方：coder APP（后台自主编码工作空间）。其他工作空间无线程
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
  // 服务端列表聚合的内容哈希（条件刷新凭证）：带上它请求，内容未变时
  // 服务端返回 unchanged 短路，跳过全量传输与重建（先例：会话列表 sinceRevision）。
  lastContentHash: '',
  // 当前激活会话是否为「历史成员只读挂载」事实（activate 响应 browseOnly）。
  // 由 workspace-actions 在 activate 落地时写入；只读横幅/输入守卫消费，
  // 与成员关系（sessionIndex / headSessionId）一致：历史成员必然 browseOnly。
  browseOnly: false,
  browseOnlyThreadId: '',
  activeConversation: null,
};

const THREADS_REFRESH_INTERVAL_MS = 20000;

// ── 内部工具 ──────────────────────────────────────────────────────

function _isZh() {
  return (typeof currentLanguage !== 'undefined' && currentLanguage === 'zh');
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
  if (state.refreshInFlight) {
    if (!force) return state.refreshInFlight;
    // SSE handoff-started 触发的强制刷新不得被慢的周期请求短路：in-flight
    // 拿到的还是旧数据（请求早于挡板立起发出），等它结束后必须再拉一次，
    // 否则挡板新事实延迟到下个 20s 轮询周期（指示器/暂存气泡晚亮几十秒）。
    await state.refreshInFlight.catch(() => {});
  }
  if (!force && state.initialLoadDone && Date.now() - state.lastRefreshAt < 5000) {
    return;
  }
  state.refreshInFlight = (async () => {
    try {
      const query = state.lastContentHash
        ? `?sinceContentHash=${encodeURIComponent(state.lastContentHash)}`
        : '';
      const res = await fetch(`/protoclaw/threads${query}`);
      if (!res.ok) return;
      const data = await res.json();
      // 内容未变（unchanged 短路）或旧服务端忽略参数外的异常形态：保持现状
      if (data?.unchanged) return;
      if (Array.isArray(data?.threads)) {
        state.threads = data.threads;
        if (typeof data.contentHash === 'string' && data.contentHash) {
          state.lastContentHash = data.contentHash;
        }
        _rebuildIndexes();
        _syncActiveThreadSubscription();
        // 新线程事实落地后对账：视图冻结在旧 head 而线程 head 已推进（SSE
        // 事件丢失 / 与 404 清理竞态）时原地重绑。unchanged 短路不经过这里。
        _reconcileConversationWithThreadHead();
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
      // 线程数据更新可能影响暂存气泡（pending 指令增减）；聊天渲染有签名
      // 去重，这里直接同步，不依赖下一轮 poll。
      if (typeof updateQueueIndicator === 'function') updateQueueIndicator();
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

window.getActiveConversationTarget = () => window.ClawThreads.activeConversation;

/**
 * 输入目标一致性校验（会话绝对隔离）：全局线程指向（activeConversation）
 * 只在与当前视图一致时才可作为输入目标。不一致（用户已切到别的会话 /
 * 别的工作空间，全局残留未清）返回 null——消息走当前视图的常规路径，
 * 绝不允许"在 A 会话输入、发到 B 线程"的串线。
 * 一致 = 宿主一致（getCurrentHostAgentRecord）且当前激活会话与指向会话
 * 相同；等待重绑态（runtime 态被 404 清空，_currentActiveSession 回退为
 * activeConversation 自身）天然满足同宿主校验。
 */
window.getActiveThreadInputTarget = () => {
  const selected = window.ClawThreads.activeConversation;
  if (!selected?.threadId) return null;
  const hostRecord = typeof getCurrentHostAgentRecord === 'function'
    ? getCurrentHostAgentRecord()
    : null;
  if (!hostRecord || String(hostRecord.id || '') !== String(selected.agentId || '')) {
    return null;
  }
  const active = _currentActiveSession();
  if (active && active.agentId === String(selected.agentId || '')
    && active.sessionId === String(selected.sessionId || '')) {
    return selected;
  }
  return null;
};

/**
 * 接续等待表面（挡板窗口唯一入口）：视图身份挂线程 + 聊天表面挂等待
 * 会话 + 拉取上一棒消息渲染。消息源是服务端会话文件只读出口
 * （/protoclaw/prebuilt_sessions/session_messages：runtime.context.messages
 * 与 viewer /messages 同源同形），挡板期间两代 runtime 都不可用也不影响
 * 上一棒对话可见。挡板结束由 head-advanced 重绑接管（loadAgentData 拉新
 * head，消息自然切换）；挡板失败收敛由 _reconcileConversationWithThreadHead
 * 的挡板死分支终结等待态。输入走线程 inbox 暂存（等待重绑态是
 * getActiveThreadInputTarget 的合法形态），新 head 上线后投递。
 */
async function enterThreadAwaitSurface(agentId, thread, sessionId) {
  if (typeof window.switchAgent === 'function') {
    await window.switchAgent(agentId, { awaitSessionId: sessionId });
  }
  window.ClawThreads.activeConversation = {
    agentId,
    threadId: thread.threadId,
    sessionId,
    runtimeId: '',
    wasHead: true,
    awaitSurface: true,
  };
  window.updateThreadHeaderIndicator();
  _syncActiveThreadSubscription();
  _loadAwaitSurfaceMessages(agentId, sessionId);
  return { ok: true, target: window.ClawThreads.activeConversation };
}

function _loadAwaitSurfaceMessages(agentId, sessionId) {
  fetch(`/protoclaw/prebuilt_sessions/session_messages?agentId=${encodeURIComponent(agentId)}&sessionId=${encodeURIComponent(sessionId)}`)
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      // 竞态守卫：仅当等待表面仍挂在该会话上才注入——重绑（head-advanced）
      // 或用户切走后，本响应作废。
      const selected = window.ClawThreads.activeConversation;
      if (!selected?.awaitSurface || selected.agentId !== agentId || selected.sessionId !== sessionId) return;
      if (!Array.isArray(data?.messages) || data.messages.length === 0) return;
      currentMessages = data.messages;
      _lastRenderedChatSig = '';
      clearChatLoadingSession();
      if (typeof renderCurrentMainView === 'function') renderCurrentMainView();
    })
    .catch(() => {});
}

window.openConversationTarget = async (target) => {  const threadId = String(target?.threadId || '').trim();
  const thread = threadId ? window.getThreadById(threadId) : null;
  // threadId 已足自解析宿主：接续退役窗口的占位条目点击时 runtimeId 已不在
  // allAgents，调用方只能提供 threadId——宿主从线程事实回退，点击不得静默
  // agent_missing（否则接续中切走后切不回来）。
  const agentId = String(target?.agentId || thread?.agentId || '').trim();
  if (!agentId) return { ok: false, reason: 'agent_missing' };
  if (threadId && !thread) return { ok: false, reason: 'thread_missing' };
  const sessionId = String(thread?.headSessionId || target?.sessionId || '').trim();
  if (!sessionId) return { ok: false, reason: 'session_missing' };

  // 接力挡板窗口：head runtime 的生命周期由接续流程管理（退役 → compact
  // → successor），open_session 会无条件 startManagedAgent 给退役中的 head
  // 启动 runtime，与 rotation 直接打架（历史事故：点击接力条目触发 runtime
  // 竞态、视图混乱闪烁）。本地挂线程等待表面：视图身份挂到线程，接力徽标
  // 即时可见，head-advanced 事件原地重绑后自动接上。awaitSessionId 让
  // 切换落在该会话的聊天加载表面（等待视图）而不是工作空间首页——用户
  // 点的导航目标是这条线程，不是首页。
  if (thread && _handoffFresh(thread)) {
    return enterThreadAwaitSurface(agentId, thread, sessionId);
  }

  // Leave the previous conversation selected while navigation saves its draft.
  if (_currentActiveSession()?.agentId !== agentId && typeof window.switchAgent === 'function') {
    await window.switchAgent(agentId);
  }

  const runtime = (Array.isArray(allAgents) ? allAgents : []).find((entry) => (
    entry?.source === 'child'
    && entry?.parent_id === agentId
    && String(entry?.active_workspace_session_id || '') === sessionId
  ));
  const runtimeId = String(runtime?.runtime_session_id || runtime?.runtimeSessionId || runtime?.id || '').trim();
  if (runtimeId && typeof setViewerSessionBinding === 'function') {
    setViewerSessionBinding(runtimeId, sessionId);
  }
  if (runtimeId && typeof window.switchAgent === 'function') {
    await window.switchAgent(runtimeId);
  } else if (typeof window.runWorkspaceAction === 'function') {
    await window.runWorkspaceAction(JSON.stringify({ type: 'open_session', sessionId }));
  } else {
    return { ok: false, reason: 'runtime_missing' };
  }

  const active = _currentActiveSession();
  const resolvedRuntimeId = String(currentRuntimeAgentId || runtimeId || '').trim();
  if (active?.agentId !== agentId || active?.sessionId !== sessionId || !resolvedRuntimeId) {
    return { ok: false, reason: 'navigation_failed' };
  }
  window.ClawThreads.activeConversation = {
    agentId,
    threadId: thread?.threadId || '',
    sessionId,
    runtimeId: resolvedRuntimeId,
    // 冻结事实：视图身份挂在 head 上才有资格进入「等待重绑」豁免（app-main
    // 404 处理）；历史成员浏览冻结时即非 head，不占用接续窗口语义。
    wasHead: sessionId === thread?.headSessionId,
  };
  _syncActiveThreadSubscription();
  return { ok: true, target: window.ClawThreads.activeConversation };
};

/**
 * 当前激活会话：以用户当前查看的 runtime/session 绑定为准。
 * 宿主的 active_workspace_session_id 会被 IM、CLI、coder 接力等其他入口
 * 改写，不能作为当前浏览器输入目标；共享 runtime 下尤其如此。
 */
function _currentActiveSession() {
  try {
    const host = typeof getCurrentHostAgentRecord === 'function'
      ? getCurrentHostAgentRecord()
      : null;
    const runtimeId = String(
      typeof currentRuntimeAgentId !== 'undefined' ? currentRuntimeAgentId || '' : '',
    ).trim();
    const sessionId = runtimeId && typeof getRuntimeWorkspaceSessionId === 'function'
      ? String(getRuntimeWorkspaceSessionId(runtimeId) || '').trim()
      : '';
    if (host?.id && sessionId) {
      return { agentId: host.id, sessionId };
    }
    // 接续退役窗口（且仅此窗口）：runtime 态被 /responses 404 清空，但视图
    // 身份（activeConversation）仍指向线程会话——这不是用户离开，是「等待
    // 重绑」，线程指向保留。有 runtime 态时绝不回退：绑定缺席 + 条目字段
    // 缺失不是「等待重绑」，回退残留 activeConversation 会把输入串到与当前
    // 视图无关的会话（历史事故：main 会话输入串到残留 coder 会话并经
    // ensureHeadRuntime 唤醒其 head runtime）。
    if (!runtimeId) {
      const selected = window.ClawThreads?.activeConversation;
      if (selected?.threadId && selected?.sessionId
        && String(selected.agentId || '').trim() === String(host.id || '').trim()) {
        return { agentId: host.id, sessionId: String(selected.sessionId || '').trim() };
      }
    }
    // 宿主 active 回退已删除：宿主 active_workspace_session_id 会被 IM、CLI、
    // coder 接力等入口改写（跨会话共享可变状态），作为输入目标是串扰源——
    // 解析失败宁可为 null（输入降级 direct），不得猜测。
  } catch {
    // 输入路由在 app-main 身份尚未完成初始化时退化为 direct。
  }
  return null;
}

// ── 会话列表徽标（渲染点由 session-list-render.js 调用）──────────

// 会话列表位的线程徽标（第 N 棒 / 承接中 / 已接续 / 接力中）已按产品要求
// 全部移除：接续过程提示仅保留顶栏交接窗口的「上下文接力中…」一个。
// session-list-render 的调用点经 typeof 守卫，函数缺席时零渲染。

/**
 * 线程宿主判定（APP 级，ADR-0025）：给定会话属于某条线程（即线程宿主
 * APP 的会话）时为真。线程索引未就绪（首拉前）时保守返回 false。
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

/**
 * 登记 activate 响应中的目标事实（T006 / T003 响应 shape）。
 *
 * 服务端 activate 已按 Thread 成员关系解析目标：历史成员返回
 * `browseOnly:true` + `target`（实际生效对象 = Thread）。前端据此：
 *   - 历史成员 → ClawThreads.browseOnly 置位（顶栏只读横幅 + 输入守卫）；
 *   - 任何成员 → 刷新线程（Thread 是真实对象，不能只刷 Session）。
 *
 * @param {object} [activateResult] activate 路由的响应 JSON
 */
window.registerSessionActivateTarget = (activateResult) => {
  const state = window.ClawThreads;
  const target = activateResult?.target?.actual || activateResult?.target;
  if (activateResult?.browseOnly === true) {
    state.browseOnly = true;
    state.browseOnlyThreadId = String(activateResult?.target?.threadId || target?.threadId || '').trim();
  } else {
    // 非 browse-only 的打开/创建：清除历史残留的只读事实
    state.browseOnly = false;
    state.browseOnlyThreadId = '';
  }
  // 兼容 Session 入口返回实际 Thread 结果时（T003 target shape）：
  // UI 刷新 Thread 而不是只刷新 Session——head 推进 / 成员变化立即可见。
  if (target?.type === 'thread' || activateResult?.browseOnly === true) {
    void window.refreshThreads(true);
  }
  window.updateThreadHeaderIndicator();
  _syncActiveThreadSubscription();
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
  const isHead = active && active.sessionId === thread.headSessionId;

  // 接续对用户不可感知：正常工作态（非交接窗口）不显示任何线程指示器；
  // 顶栏只保留交接窗口内的「上下文接力中…」一个提示。
  if (isHead && !_handoffFresh(thread)) {
    if (el) el.remove();
    return;
  }

  if (!el) {
    el = document.createElement('span');
    el.id = 'thread-header-indicator';
    anchor.parentElement.insertBefore(el, anchor);
  }

  if (isHead) {
    el.className = 'thread-header-indicator relaying';
    el.onclick = null;
    el.title = `${thread.threadId} · ${isZh ? '正在交接到后续会话，期间输入将暂存到线程' : 'handing off; input will be staged in the thread'}`;
    el.textContent = isZh ? '上下文接力中…' : 'Relaying context…';
  } else {
    // 历史成员：只读查看（T006 / ADR-001）。成员关系（sessionIndex）是事实源，
    // 不依赖 browseOnly 时序：非 head 即只读。明示「只读 + 前往当前 head」，
    // 点击是显式动作——绝不静默跳转 / 静默转投（work-thread-design §2.2）。
    const browseOnly = window.ClawThreads.browseOnly === true
      && (window.ClawThreads.browseOnlyThreadId === '' || window.ClawThreads.browseOnlyThreadId === thread.threadId);
    el.className = 'thread-header-indicator historical' + (browseOnly ? ' readonly' : '');
    el.title = isZh
      ? `当前为只读查看；点击前往当前承接会话`
      : `Read-only view; click to open the current head session.`;
    el.textContent = isZh ? '只读 · 前往当前会话' : 'Read-only · open head';
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

window.submitThreadInput = async (threadId, payload = {}) => {
  const res = await fetch(`/protoclaw/threads/${encodeURIComponent(threadId)}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: typeof payload.text === 'string' ? payload.text : '',
      ...(Array.isArray(payload.images) ? { images: payload.images } : {}),
      ...(typeof payload.source === 'string' ? { source: payload.source } : {}),
      ...(typeof payload.sourceRef === 'string' ? { sourceRef: payload.sourceRef } : {}),
      ...(payload.kind ? { kind: payload.kind } : {}),
      ...(Array.isArray(payload.capabilityActivations)
        ? { capabilityActivations: payload.capabilityActivations } : {}),
      ...(payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
        ? { metadata: payload.metadata } : {}),
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.ok !== true) {
    throw Object.assign(new Error(data?.message || `thread input failed (${res.status})`), {
      code: data?.code || 'thread_input_failed',
      status: res.status,
    });
  }
  void window.refreshThreads?.(true);
  return data;
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
      ...(Array.isArray(options.capabilityActivations) && options.capabilityActivations.length > 0
        ? { capabilityActivations: options.capabilityActivations }
        : {}),
      ...(options.metadata && typeof options.metadata === 'object' && !Array.isArray(options.metadata)
        ? { metadata: options.metadata }
        : {}),
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

// ── 接续换头：保持同一会话视图身份，只更换 runtime 绑定与消息数据源 ──

let _activeThreadSubscription = null;

function _syncActiveThreadSubscription() {
  const active = _currentActiveSession();
  const thread = active ? window.getThreadForSession(active.agentId, active.sessionId) : null;
  const selected = window.ClawThreads.activeConversation;
  if (selected?.threadId) {
    const selectedThread = window.getThreadById(selected.threadId);
    const currentSessionBelongsToThread = selectedThread?.agentId === active?.agentId
      && (selectedThread.sessionIds || []).includes(active?.sessionId);
    // 接续退役窗口：runtime 态被 /responses 404 清理清空，_currentActiveSession
    // 落到宿主 main 会话——这不是用户离开，是「视图身份仍在、等待重绑」态。
    // 保留线程指向与订阅，否则 handoff-started 指示器延迟、head-advanced
    // 重绑失效。豁免以宿主焦点为界：用户已切到别的工作空间（宿主不再是
    // 本线程宿主）时豁免失效，落入下方重建分支清除残留——全局线程指向
    // 不跨工作空间存续（会话隔离；历史事故：main 会话输入经残留指向串到
    // coder 线程）。
    const runtimeStateCleared = String(currentRuntimeAgentId || '').trim() === '';
    const hostRecord = typeof getCurrentHostAgentRecord === 'function'
      ? getCurrentHostAgentRecord()
      : null;
    const hostOwnsThread = !!hostRecord
      && String(hostRecord.id || '') === String(selected.agentId || '');
    if (selectedThread?.agentId === selected.agentId && hostOwnsThread
      && (!selected.runtimeId || runtimeStateCleared)) {
      // A user navigation has selected this stable thread target but the
      // session runtime has not mounted yet. Do not replace it with whatever
      // conversation was visible before the navigation began. Same for the
      // succession gap after the 404 cleanup cleared the runtime binding.
    } else if (selectedThread?.agentId === selected.agentId && currentSessionBelongsToThread) {
      selected.sessionId = selectedThread.headSessionId || selected.sessionId;
      selected.runtimeId = String(currentRuntimeAgentId || selected.runtimeId || '');
      // wasHead 是「冻结时是否 head」的事实，记账对齐不改变它——历史成员
      // 被对齐 head 后仍不得获得接续重绑资格（对账入口以 wasHead 为锚）。
    } else {
      window.ClawThreads.activeConversation = thread ? {
        agentId: active.agentId,
        threadId: thread.threadId,
        sessionId: active.sessionId,
        runtimeId: String(currentRuntimeAgentId || ''),
        wasHead: active.sessionId === thread.headSessionId,
      } : (active ? {
        agentId: active.agentId,
        threadId: '',
        sessionId: active.sessionId,
        runtimeId: String(currentRuntimeAgentId || ''),
        wasHead: false,
      } : null);
    }
  } else {
    window.ClawThreads.activeConversation = thread ? {
      agentId: active.agentId,
      threadId: thread.threadId,
      sessionId: active.sessionId,
      runtimeId: String(currentRuntimeAgentId || ''),
      wasHead: active.sessionId === thread.headSessionId,
    } : (active ? {
      agentId: active.agentId,
      threadId: '',
      sessionId: active.sessionId,
      runtimeId: String(currentRuntimeAgentId || ''),
      wasHead: false,
    } : null);
  }
  const selectedThreadId = String(window.ClawThreads.activeConversation?.threadId || '').trim();
  const threadId = selectedThreadId || String(thread?.threadId || '').trim();
  if (_activeThreadSubscription && _activeThreadSubscription.threadId === threadId) return;
  const client = window.ClawFW?.SseClient;
  if (!threadId || typeof client?.subscribeThreadEvents !== 'function') {
    _activeThreadSubscription?.unsubscribe?.();
    _activeThreadSubscription = null;
    return;
  }
  _activeThreadSubscription?.unsubscribe?.();
  const subscription = { threadId, unsubscribe: null };
  subscription.unsubscribe = client.subscribeThreadEvents(threadId, async (event) => {
    if (event?.type === 'thread.handoff-started') {
      // 交接开始即时可见：事件只是发现信号，状态事实仍以 /threads 数据
      // 为准——立即拉取（内部顺带刷新顶栏指示器为「接力中」）并重渲侧栏
      // 过渡占位，不等 20s contentHash 轮询。
      if (typeof window.refreshThreads === 'function') await window.refreshThreads(true).catch(() => {});
      renderAgentList();
      return;
    }
    if (event?.type !== 'thread.head-advanced') return;
    const fromSessionId = String(event.payload?.fromSessionId || '').trim();
    const toSessionId = String(event.payload?.toSessionId || '').trim();
    if (!fromSessionId || !toSessionId) return;
    // 事件只是加速信号：重绑的成立条件一律以调用时点的 threads / allAgents
    // 权威事实为准（_rebindConversationToThreadHead 内部守卫），与轮询事实
    // 对账共用同一实现，不存在第二条重绑路径。
    if (typeof window.refreshThreads === 'function') await window.refreshThreads(true).catch(() => {});
    renderAgentList();
    await _rebindConversationToThreadHead(threadId, fromSessionId, toSessionId);
  });
  _activeThreadSubscription = subscription;
}

/**
 * 接续重绑（唯一实现）：把视图身份从 fromSessionId 原地换到 toSessionId 的
 * head runtime。调用方（SSE head-advanced 处理器 / threads 事实对账）各自
 * 先刷新线程事实再进入；守卫全部建立在权威数据上——线程匹配、head 对账、
 * runtime 对账、宿主一致，任一失配静默退出（幂等，重复调用安全）。
 */
let _rebindInFlight = false;
async function _rebindConversationToThreadHead(threadId, fromSessionId, toSessionId) {
  if (_rebindInFlight) return;
  _rebindInFlight = true;
  try {
    const current = _currentActiveSession();
    const selectedConversation = window.ClawThreads.activeConversation;
    const ownerAgentId = String(selectedConversation?.agentId || '').trim();
    // 重绑守卫：用户仍挂在本线程的视图（threadId 匹配）即可。不再要求
    // current.sessionId === fromSessionId——接续退役旧 head 时 /responses 404
    // 清理会清空 runtime 态，_currentActiveSession 落到宿主 main 会话，原
    // 前置在被打断后必不满足（历史事故：重绑静默跳过，successor 需手动
    // 点击）。runtime 态仍在时仍要求指向 from 会话，防止迟到事件把已切到
    // 同线程历史分支的用户拉走。
    const runtimeStateHeld = String(currentRuntimeAgentId || '').trim() !== '';
    const userStillOnThread = selectedConversation?.threadId === threadId
      && (!ownerAgentId || current?.agentId === ownerAgentId)
      && (!runtimeStateHeld || current?.sessionId === fromSessionId);
    const nextThread = window.getThreadById(threadId);
    if (!userStillOnThread || nextThread?.headSessionId !== toSessionId) {
      return;
    }
    if (typeof loadAgents === 'function') await loadAgents().catch(() => {});
    const latest = _currentActiveSession();
    const latestConversation = window.ClawThreads.activeConversation;
    if (latestConversation?.threadId !== threadId
      || latestConversation.agentId !== ownerAgentId
      || latest?.agentId !== ownerAgentId) return;
    const runtime = (Array.isArray(allAgents) ? allAgents : []).find((agent) => (
      agent?.source === 'child'
      && agent?.parent_id === ownerAgentId
      && String(agent?.active_workspace_session_id || '') === toSessionId
    ));
    if (!runtime) return;
    const previousRuntimeId = String(currentRuntimeAgentId || '').trim();
    if (previousRuntimeId && typeof getRuntimeWorkspaceSessionId === 'function'
      && getRuntimeWorkspaceSessionId(previousRuntimeId) !== fromSessionId) return;
    _storeVisibleSessionInputDraft();
    const nextRuntimeId = String(runtime.runtime_session_id || runtime.runtimeSessionId || runtime.id || '').trim();
    if (!nextRuntimeId) return;
    if (previousRuntimeId && typeof saveCurrentRuntimeToCache === 'function') {
      saveCurrentRuntimeToCache(previousRuntimeId, getRuntimeContextKey(previousRuntimeId));
    }
    setViewerSessionBinding(nextRuntimeId, toSessionId);
    const openedConversation = window.ClawThreads.activeConversation;
    if (openedConversation?.threadId === threadId && openedConversation.agentId === ownerAgentId) {
      openedConversation.sessionId = toSessionId;
      openedConversation.runtimeId = nextRuntimeId;
    }
    window.ClawThreads.activeConversation = {
      agentId: ownerAgentId,
      threadId,
      sessionId: toSessionId,
      runtimeId: nextRuntimeId,
      wasHead: true,
    };
    // 线程会话归属线程宿主 APP（如 coder）：侧栏高亮同步切到该 APP。
    focusedAgentId = ownerAgentId;
    currentRuntimeAgentId = nextRuntimeId;
    readOnlyMode = false;
    _lastRenderedChatSig = '';
    setPendingChatScrollRestore(null);
    if (typeof setPendingChatViewportAnchor === 'function') setPendingChatViewportAnchor(null);
    resetRuntimeStatusForSwitch();
    renderAgentList();
    loadAgentData(nextRuntimeId).catch((error) => console.warn('[threads] successor view rebind failed:', error));
    if (typeof window.refreshThreads === 'function') window.refreshThreads(true).catch(() => {});
    _syncActiveThreadSubscription();
  } finally {
    _rebindInFlight = false;
  }
}

/**
 * 事实对账（ADR-0024 接续零感知）：SSE head-advanced 只是加速信号，事件
 * 丢失（断连 / 后台标签）时 threads 轮询拉到 head 已推进的快照即是重绑的
 * 正当时刻。视图冻结在本线程旧 head（wasHead）且线程 head 已换代 → 经
 * _rebindConversationToThreadHead 唯一实现原地换绑。挂在 refreshThreads
 * 收尾：404 豁免块的强刷、20s 周期轮询、事件处理器的事实刷新都会经过
 * 这里，无需独立触发器。
 *
 * 差值锚点：runtime viewer 绑定是「视图正在显示的会话」真相（记账
 * sessionId 会被 _syncActiveThreadSubscription 的跟随分支对齐 head，不能
 * 作信号）；runtime 态被 404 清空的退役窗口用冻结值（此时无人改写它）。
 */
function _reconcileConversationWithThreadHead() {
  const selected = window.ClawThreads.activeConversation;
  if (!selected?.threadId || selected.wasHead !== true) return;
  const thread = window.getThreadById(selected.threadId);
  if (!thread || thread.status === 'closed') return;
  const headSessionId = String(thread.headSessionId || '').trim();
  if (!headSessionId) return;
  const runtimeId = String(currentRuntimeAgentId || '').trim();
  const boundSessionId = runtimeId && typeof getRuntimeWorkspaceSessionId === 'function'
    ? String(getRuntimeWorkspaceSessionId(runtimeId) || '').trim()
    : '';
  const viewedSessionId = boundSessionId || String(selected.sessionId || '').trim();
  if (!viewedSessionId) return;
  // 挡板死收敛：等待表面挂着、挡板已过新鲜窗、head 未推进、无 runtime——
  // rotation 失败收敛后的形态（旧 head 已退役、successor 未起来、线程回
  // open），没有任何可以等待的对象。终结等待态：已渲染的上一棒消息保留
  // 可读，提示接续失败。恢复路径：再点线程条目 → open_session → activate
  // 拉起旧 head（挡板已收敛，无竞态）。
  if (selected.awaitSurface === true
    && headSessionId === viewedSessionId
    && !runtimeId
    && !_handoffFresh(thread)) {
    window.ClawThreads.activeConversation = null;
    window.updateThreadHeaderIndicator();
    window.ClawToast?.show?.({
      id: `thread-handoff-failed-${selected.threadId}`,
      status: 'error',
      title: currentLanguage === 'zh' ? '线程接续失败' : 'Thread handoff failed',
      description: currentLanguage === 'zh'
        ? '接续未完成，当前显示上一棒的对话记录；重新点击线程条目可恢复。'
        : 'Handoff did not complete. Showing the previous run; click the thread again to resume.',
    });
    return;
  }
  if (headSessionId === viewedSessionId) return;
  if (!(thread.sessionIds || []).includes(viewedSessionId)) return;
  void _rebindConversationToThreadHead(selected.threadId, viewedSessionId, headSessionId)
    .catch((error) => console.warn('[threads] head reconciliation rebind failed:', error));
}

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
