/**
 * ph-search-locate.js — 搜索结果 → 聊天消息定位与返回
 *
 * 工单 2026-10-21 历史搜索体验收敛（定位与返回板块）：
 *  - 搜索结果进入会话后定位到命中消息。消息索引即原始 context 索引：
 *    服务端索引按消息边界记录 raw index（session-search-index.js
 *    extractSessionSearchMessages 的 `i`），与 chat-renderer 的 `msg-<index>`
 *    DOM id 同源——前端 currentMessages 始终是全量数组（/messages 的
 *    ?since / ?tail 增量在 app-main.js runMessagesProbeCycle 拼回全量），
 *    渲染下标不因分页偏移。
 *  - 错误组折叠不是回扫猜测：用 chat-renderer 的
 *    computeAssistantErrorGroups(messages).plan 做精确数据映射——组内
 *    非首消息由组首行（`eg-<startIndex>`）统一渲染，目标在组内时定位到
 *    组首行并经 toggleErrorGroup 展开（用户态跨全量渲染保持）。
 *  - 身份守卫含 runtime + session：定位以第一次身份匹配落定的
 *    { runtimeId, sessionId } 为锚，之后任何偏离（用户切走）即放弃；
 *    serial 代次让旧定位的迟到回调失效，不抢新会话滚动位置。
 *  - 浮动条生命周期绑定同一锚：container 渲染漂移后身份不匹配即自动
 *  收起，不遗留到别的会话；返回/回最新不依赖 render 中发网络，全部
 *  读本地 ClawFW.phSearch 状态。
 *
 * 依赖全局:
 *   container (app-core.js — #chat-container，唯一滚动容器)
 *   readCurrentSessionViewState (modules/session-view-state.js — 身份守卫，
 *     返回 { runtimeId, identity: { agentId, sessionId }, messages })
 *   computeAssistantErrorGroups (modules/chat-renderer.js — 错误组权威 plan)
 *   registerManualScrollIntent, requestFollowLatest (modules/chat-viewport.js)
 *   selectWorkspaceSurface (app-ui.js — selectWorkspaceSurface(agentId, options))
 *   currentLanguage, escapeHtml (app-core.js)
 * 入口（workspace-actions.js open_session 流程挂钩）:
 *   window.phSearchLocatePrepare(action) — 导航开始前调用（进入前捕获
 *     .ph-session-tabs dataset 项目身份 + 搜索列表滚动位置）
 *   window.phSearchLocateAfterOpen(action) — 导航落定后调用；action 携带
 *     { sessionId, messageIndex }。messageIndex 缺席时 no-op（正常列表
 *     进入行为不变）。
 */

window.ClawFW = window.ClawFW || {};

// 事件驱动等待的绝对上限兜底（身份/数据一直不满足时防观察器悬挂）。
const PH_LOCATE_MAX_WAIT_MS = 8000;

let _locateSerial = 0;
let _backSerial = 0;
let _locateActive = null; // { serial, sessionId, messageIndex, anchor, observer, abortTimer }
let _prepareCapture = null; // 进入前捕获的项目身份 { hostAgentId, remoteOnly, projectId }
let _locateBarEl = null;
let _locateBarWatch = null; // { anchor, observer } 浮条生命周期身份锚

function _viewIdentitySnapshot() {
  try {
    if (typeof readCurrentSessionViewState === 'function') {
      const view = readCurrentSessionViewState();
      const runtimeId = String(view?.runtimeId || '');
      // 远程 runtime 不在本机 allAgents，会话身份由远程目录 accessor 持有。
      const remote = typeof isRemoteNamespaceAgentId === 'function' && isRemoteNamespaceAgentId(runtimeId);
      const sessionId = remote
        ? window.RemoteConnections.getEntryRuntimeSessionId(runtimeId)
        : view?.identity?.sessionId;
      return {
        sessionId: String(sessionId || ''),
        runtimeId,
        switchEpoch: view?.switchEpoch,
        messages: Array.isArray(view?.messages) ? view.messages : null,
      };
    }
  } catch { /* A view being replaced is not yet a locate target. */ }
  return { sessionId: '', runtimeId: '', messages: null };
}

/** 精确数据映射：messageIndex → DOM 行。错误组经权威 plan 归约到组首行。 */
function _locateResolveTarget(messages, messageIndex) {
  if (!Array.isArray(messages) || messageIndex >= messages.length) {
    return null; // 数据未提交到位，继续等
  }
  const plan = typeof computeAssistantErrorGroups === 'function'
    ? computeAssistantErrorGroups(messages).plan
    : null;
  const groupEntry = plan ? plan[messageIndex] : null;
  if (groupEntry) {
    // 组内消息（含组首）都落在组首行；命中原文在组体内，需确保展开。
    const gid = 'eg-' + groupEntry.group.startIndex;
    const head = document.getElementById(gid);
    const row = head && head.closest ? head.closest('.message-row') : null;
    if (!row) return null;
    return { row, expandGroupId: gid };
  }
  const el = document.getElementById('msg-' + messageIndex);
  const row = el && el.closest ? el.closest('.message-row') : null;
  if (!row) return null;
  // 用户折叠（或重渲染恢复的折叠态）消息：经真实 toggle 展开后再滚动，
  // 命中原文可见。
  if (el.classList && el.classList.contains('collapsed')) {
    return { row, expandMsgId: 'msg-' + messageIndex };
  }
  return { row };
}

function _locateTeardownActive() {
  if (!_locateActive) return;
  if (_locateActive.observer) {
    _locateActive.observer.disconnect();
    _locateActive.observer = null;
  }
  if (_locateActive.abortTimer) {
    clearTimeout(_locateActive.abortTimer);
    _locateActive.abortTimer = null;
  }
  _locateActive = null;
}

function _locateScrollToRow(row) {
  if (typeof registerManualScrollIntent === 'function') {
    // 定位是用户主动改变阅读位置：中断跟随动画，否则 follow-latest 会把
    // 位置重新拉回底部（与 chat-nav-timeline 导航点击同语义）。
    registerManualScrollIntent({ interrupt: true });
  }
  const cRect = container.getBoundingClientRect();
  const rRect = row.getBoundingClientRect();
  const delta = rRect.top - cRect.top + container.scrollTop;
  container.scrollTop = Math.max(0, delta - 72);
  // 行窗口化（content-visibility）按滚动位置揭露；显式补发一次滚动事件，
  // 确保目标行立即参与绘制。
  try { container.dispatchEvent(new Event('scroll')); } catch { /* The next native scroll also reveals the row. */ }
  row.classList.add('chat-locate-flash');
  setTimeout(() => row.classList.remove('chat-locate-flash'), 2000);
}

function _locateTryFinish(active) {
  if (!_locateActive || _locateActive !== active) return true;
  const view = _viewIdentitySnapshot();
  if (active.switchEpoch !== view.switchEpoch) {
    _locateTeardownActive();
    return true;
  }
  if (!active.anchor) {
    // 尚未锁定身份锚：目标会话身份落地才算定位开始（落定前的旧视图不碰）。
    if (view.sessionId !== active.sessionId || !view.runtimeId) return false;
    active.anchor = { sessionId: view.sessionId, runtimeId: view.runtimeId, switchEpoch: view.switchEpoch };
  } else if (view.sessionId !== active.anchor.sessionId
    || view.runtimeId !== active.anchor.runtimeId) {
    // 用户已导航去别的会话/runtime → 放弃定位（不抢滚动位置）。
    _locateTeardownActive();
    return true;
  }
  const resolved = _locateResolveTarget(view.messages, active.messageIndex);
  if (!resolved) return false;
  if (resolved.expandGroupId
    && typeof window.toggleErrorGroup === 'function') {
    const head = document.getElementById(resolved.expandGroupId);
    if (head && head.classList && !head.classList.contains('expanded')) {
      window.toggleErrorGroup(resolved.expandGroupId);
    }
  }
  if (resolved.expandMsgId && typeof window.toggleMessage === 'function') {
    window.toggleMessage(resolved.expandMsgId);
  }
  if (active.observer) {
    active.observer.disconnect();
    active.observer = null;
  }
  if (active.abortTimer) {
    clearTimeout(active.abortTimer);
    active.abortTimer = null;
  }
  _locateScrollToRow(resolved.row);
  _showLocateBar(active.anchor);
  _locateActive = null;
  return true;
}

/**
 * 导航开始前的捕获入口（workspace-actions open_session 早期挂钩）：
 * 此刻搜索面 DOM 还在——从 .ph-session-tabs dataset 读项目身份，
 * 保存搜索列表滚动位置（写进搜索模块预留的 ClawFW.phSearch.homeScrollTop）。
 * 搜索词/筛选/展开本就活在 ClawFW.phSearch / phSearchQuery 中，随首页
 * 重渲染自然恢复。
 */
window.phSearchLocatePrepare = (action) => {
  const sessionId = String(action?.sessionId || '').trim();
  const messageIndex = Number(action?.messageIndex);
  if (!sessionId || !Number.isInteger(messageIndex) || messageIndex < 0) return;
  let root = null;
  try {
    root = typeof document !== 'undefined' && document.querySelector
      ? document.querySelector('.ph-session-tabs')
      : null;
  } catch { /* A search surface may have been replaced during navigation. */ }
  const dataset = root?.dataset || {};
  const scrollTop = (typeof container !== 'undefined' && container)
    ? Math.max(0, Number(container.scrollTop) || 0)
    : 0;
  const searchState = window.ClawFW?.phSearch;
  if (searchState) searchState.homeScrollTop = scrollTop;
  _prepareCapture = {
    hostAgentId: String(dataset.searchHostId || ''),
    remoteOnly: dataset.searchRemote === 'true',
    projectId: String(dataset.searchProjectId || ''),
  };
};

/**
 * open_session 导航落定后的定位入口（workspace-actions 挂钩）：等待目标
 * 会话身份落地 + 消息数据提交，再精确滚动。消息 render 同步重建 DOM，
 * MutationObserver 驱动重检，不轮询；绝对上限兜底中止。
 */
window.phSearchLocateAfterOpen = (action) => {
  const sessionId = String(action?.sessionId || '').trim();
  const messageIndex = Number(action?.messageIndex);
  if (!sessionId || !Number.isInteger(messageIndex) || messageIndex < 0) return;
  if (typeof MutationObserver === 'undefined' || !container) return;

  _locateSerial += 1;
  const serial = _locateSerial;
  _locateTeardownActive();
  _dismissLocateBar();
  const active = {
    serial,
    sessionId,
    messageIndex,
    switchEpoch: _viewIdentitySnapshot().switchEpoch,
    anchor: null,
    observer: null,
    abortTimer: null,
  };
  _locateActive = active;

  if (_locateTryFinish(active)) return;

  active.observer = new MutationObserver(() => {
    if (!_locateActive || _locateActive.serial !== serial) return;
    _locateTryFinish(_locateActive);
  });
  active.observer.observe(container, { childList: true, subtree: true });
  active.abortTimer = setTimeout(() => {
    if (_locateActive && _locateActive.serial === serial) {
      const view = _viewIdentitySnapshot();
      _locateTeardownActive();
      if (view.switchEpoch !== active.switchEpoch) return;
      // 索引失效只在原导航仍持有视图时提示，用户切走后不遗留浮条。
      _showLocateFailedBar();
      _watchLocateBar({ sessionId: view.sessionId, runtimeId: view.runtimeId, switchEpoch: view.switchEpoch });
    }
  }, PH_LOCATE_MAX_WAIT_MS);
};

// ── 浮动条 ────────────────────────────────────────────────────────

function _ensureLocateBar() {
  if (_locateBarEl && _locateBarEl.isConnected) return _locateBarEl;
  _locateBarEl = document.createElement('div');
  _locateBarEl.id = 'ph-locate-bar';
  _locateBarEl.className = 'ph-locate-bar';
  document.body.appendChild(_locateBarEl);
  return _locateBarEl;
}

/** 浮条挂上身份锚观察：container 渲染漂移后身份不再匹配 → 自动收起。 */
function _watchLocateBar(anchor) {
  _unwatchLocateBar();
  if (typeof MutationObserver === 'undefined' || !container) return;
  const watch = { anchor, observer: null };
  watch.observer = new MutationObserver(() => {
    const view = _viewIdentitySnapshot();
    if (view.sessionId !== anchor.sessionId || view.runtimeId !== anchor.runtimeId
      || view.switchEpoch !== anchor.switchEpoch) {
      _dismissLocateBar();
    }
  });
  watch.observer.observe(container, { childList: true, subtree: true });
  _locateBarWatch = watch;
}

function _unwatchLocateBar() {
  if (!_locateBarWatch) return;
  if (_locateBarWatch.observer) _locateBarWatch.observer.disconnect();
  _locateBarWatch = null;
}

function _showLocateBar(anchor) {
  const isZh = currentLanguage === 'zh';
  const bar = _ensureLocateBar();
  bar.innerHTML = [
    '<span class="ph-locate-bar-label">' + escapeHtml(isZh ? '已定位到匹配消息' : 'Located match') + '</span>',
    '<button class="ph-locate-bar-btn" type="button" onclick="window.phSearchLocateBack()">' + escapeHtml(isZh ? '返回搜索' : 'Back to search') + '</button>',
    '<button class="ph-locate-bar-btn" type="button" onclick="window.phSearchLocateLatest()">' + escapeHtml(isZh ? '回最新' : 'Latest') + '</button>',
    '<button class="ph-locate-bar-close" type="button" onclick="window.phSearchLocateDismiss()" title="' + escapeHtml(isZh ? '关闭' : 'Close') + '"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>',
  ].join('');
  bar.classList.add('show');
  _watchLocateBar(anchor);
}

function _dismissLocateBar() {
  _unwatchLocateBar();
  if (_locateBarEl) _locateBarEl.classList.remove('show');
}

/** 定位超时/索引失效的轻量反馈：可关闭、可返回搜索。 */
function _showLocateFailedBar() {
  const isZh = currentLanguage === 'zh';
  const bar = _ensureLocateBar();
  bar.innerHTML = [
    '<span class="ph-locate-bar-label">' + escapeHtml(isZh ? '未定位到匹配消息，会话内容可能已更新或精简' : 'Match not located; conversation may have changed') + '</span>',
    '<button class="ph-locate-bar-btn" type="button" onclick="window.phSearchLocateBack()">' + escapeHtml(isZh ? '返回搜索' : 'Back to search') + '</button>',
    '<button class="ph-locate-bar-close" type="button" onclick="window.phSearchLocateDismiss()" title="' + escapeHtml(isZh ? '关闭' : 'Close') + '"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>',
  ].join('');
  bar.classList.add('show');
}

window.phSearchLocateDismiss = () => {
  _dismissLocateBar();
};

/** 回最新：复用 follow-latest 机制（强制重新启用跟随并跳到底部）。 */
window.phSearchLocateLatest = () => {
  _dismissLocateBar();
  if (typeof requestFollowLatest === 'function') {
    requestFollowLatest({ forceEnable: true });
  } else if (container) {
    container.scrollTop = container.scrollHeight;
  }
};

/**
 * 返回搜索：回工作区首页 surface（selectWorkspaceSurface(agentId, options)
 * ——ph 的非 chat 工作区偏好缺席时落首个非 chat tab = home）。搜索词/筛选/
 * 展开活在 ClawFW.phSearch / phSearchQuery，随重渲染自然恢复；远程项目
 * 视图经 phSurfaceViewProjectId 恢复（session-list-render 消费）。列表
 * 滚动位置在 home 骨架重渲染后恢复，恢复前校验仍在搜索面（防迟到抢位）。
 */
window.phSearchLocateBack = () => {
  _dismissLocateBar();
  _locateTeardownActive();
  const capture = _prepareCapture || {};
  const hostAgentId = capture.hostAgentId || 'programming-helper';
  const savedScrollTop = Math.max(0, Number(window.ClawFW?.phSearch?.homeScrollTop || 0));
  if (capture.remoteOnly && capture.projectId && window.ClawFW) {
    window.ClawFW.phSurfaceViewProjectId = capture.projectId;
  }
  if (typeof selectWorkspaceSurface === 'function') {
    selectWorkspaceSurface(hostAgentId);
  }
  if (savedScrollTop > 0 && typeof container !== 'undefined' && container) {
    _backSerial += 1;
    const serial = _backSerial;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (serial !== _backSerial) return;
        if (!container) return;
        let onSearchSurface = false;
        try {
          const root = document.querySelector('.ph-session-tabs');
          onSearchSurface = !!root
            && root.dataset.searchHostId === capture.hostAgentId
            && root.dataset.searchProjectId === capture.projectId;
        } catch { /* Do not restore into an unavailable search surface. */ }
        if (onSearchSurface && container.scrollHeight >= savedScrollTop) {
          container.scrollTop = savedScrollTop;
        }
      });
    });
  }
};
