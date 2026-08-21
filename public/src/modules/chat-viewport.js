/**
 * chat-viewport.js — Chat Viewport / Scroll 管理模块（从 app-ui.js 域 N 提取）
 *
 * 包含：
 *   - updateAssemblySideRailPosition: assembly side rail 定位
 *   - getToggleButtonLabel: 消息折叠/展开按钮 label（纯 UI 工具）
 *   - Viewport scroll 核心逻辑（32 个函数）：
 *     isNearBottom, updateFollowLatestButton, markManualScrollIntent,
 *     getChatViewportMetrics, getChatViewportBottomTop, setChatViewportTop,
 *     lockChatViewportToBottomNow,
 *     suppressChatViewportObservers, resumeChatViewportObservers,
 *     shouldIgnoreChatViewportObserverEvent, runWithSuppressedChatViewportObservers,
 *     cancelFollowLatestAnimation, startFollowLatestAnimation,
 *     isFollowLatestAnimationCruising, shouldKeepFollowAnimationForMutation,
 *     ensureChatViewportObservers,
 *     interruptFollowLatest, registerManualScrollIntent, hasRecentManualScrollIntent,
 *     beginFollowLatestCooldown, isFollowLatestCooldownActive,
 *     beginFollowLatestEntryWindow, isFollowLatestEntryWindowActive,
 *     cancelChatScrollSettlement, notifyChatViewportMutation,
 *     setPendingChatScrollRestore, consumePendingChatScrollRestore,
 *     scrollToLatest, setFollowLatest, scheduleFollowLatestSettlePass,
 *     requestFollowLatest, scheduleScrollToLatest, scheduleScrollToLatestWithVersion
 *
 * 依赖（全局变量，声明于 app-core.js）：
 *   - container: 聊天容器 DOM
 *   - followLatestButton: follow 按钮 DOM
 *   - workspaceTabsBar: tabs 容器 DOM（仅 getToggleButtonLabel 不依赖）
 *   - currentMessages: 当前消息列表（updateFollowLatestButton 读）
 *   - followLatestEnabled: 跟随开关
 *   - suppressFollowScrollEvent: 滚动事件抑制标志
 *   - lastManualScrollIntentAt: 手动滚动时间戳
 *   - _progScrollCooldownUntil: 冷却截止时间
 *   - followLatestEntryUntil: 进入窗口截止
 *   - chatViewportObserversReady: observer 初始化标志
 *   - chatViewportObserverSuppressDepth: 抑制深度计数
 *   - chatViewportObserverQuietUntil: 静默截止时间
 *   - chatViewportMutationObserver: MutationObserver 实例
 *   - chatViewportResizeObserver: ResizeObserver 实例
 *   - chatViewportSettlementToken, chatViewportSettlementRaf,
 *     chatViewportSettlementTimer, chatViewportSettlementContext
 *   - chatViewportFollowRaf, chatViewportFollowToken, chatViewportFollowTransition
 *   - assemblySideRailRevealTimer: side rail reveal 定时器
 *
 * 依赖（全局函数）：
 *   - isChatSurfaceActive, shouldRenderWorkspaceSurface (app-ui.js 域 A)
 *   - escapeHtml, t (app-core.js)
 */

function updateAssemblySideRailPosition() {
  const rail = container.querySelector('.assembly-side-rail');
  const flow = container.querySelector('.assembly-flow');
  if (!rail || !flow) {
    if (assemblySideRailRevealTimer) {
      clearTimeout(assemblySideRailRevealTimer);
      assemblySideRailRevealTimer = null;
    }
    return;
  }
  if (window.innerWidth <= 920) {
    if (assemblySideRailRevealTimer) {
      clearTimeout(assemblySideRailRevealTimer);
      assemblySideRailRevealTimer = null;
    }
    rail.classList.add('positioned');
    rail.classList.add('ready');
    rail.style.removeProperty('--assembly-side-left');
    rail.style.removeProperty('--assembly-side-top');
    return;
  }
  const flowRect = flow.getBoundingClientRect();
  const dockRect = rail.getBoundingClientRect();
  const railWidth = dockRect.width || 316;
  const left = Math.max(flowRect.left + flowRect.width - railWidth - 14, flowRect.left + 14);
  const top = Math.max(flowRect.top + 12, 132);
  rail.style.setProperty('--assembly-side-left', `${Math.round(left)}px`);
  rail.style.setProperty('--assembly-side-top', `${Math.round(top)}px`);
  rail.classList.add('positioned');
  if (rail.classList.contains('ready')) return;
  if (assemblySideRailRevealTimer) {
    clearTimeout(assemblySideRailRevealTimer);
  }
  assemblySideRailRevealTimer = setTimeout(() => {
    if (!document.body.contains(rail)) return;
    rail.classList.add('ready');
    assemblySideRailRevealTimer = null;
  }, 140);
}

function getToggleButtonLabel(collapsed) {
  return collapsed
    ? '<svg viewBox="0 0 24 24"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg> ' + escapeHtml(t('expand'))
    : '<svg viewBox="0 0 24 24"><path d="M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z"/></svg> ' + escapeHtml(t('collapse'));
}

function isNearBottom() {
  const threshold = 48;
  return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
}

function updateFollowLatestButton() {
  if (!followLatestButton) return;
  const hasMessages = currentMessages.length > 0 && isChatSurfaceActive();
  followLatestButton.classList.toggle('hidden', !hasMessages);
  followLatestButton.classList.toggle('active', followLatestEnabled);
  followLatestButton.innerHTML =
    '<span class="follow-latest-dot"></span><span>' +
    escapeHtml(t(followLatestEnabled ? 'follow_latest_on' : 'follow_latest_off')) +
    '</span>';
}

function markManualScrollIntent() {
  lastManualScrollIntentAt = Date.now();
}

function getChatViewportMetrics() {
  return {
    top: container.scrollTop,
    height: container.scrollHeight,
    clientHeight: container.clientHeight,
    rowCount: container.querySelectorAll('.message-row').length,
  };
}

function getChatViewportBottomTop(metrics = getChatViewportMetrics()) {
  return Math.max(0, metrics.height - metrics.clientHeight);
}

function setChatViewportTop(nextTop) {
  suppressFollowScrollEvent = true;
  container.scrollTop = Math.max(0, nextTop);
  suppressFollowScrollEvent = false;
}

function lockChatViewportToBottomNow() {
  cancelFollowLatestAnimation();
  setChatViewportTop(getChatViewportBottomTop());
  chatViewportFollowTransition = 'locked';
}

function suppressChatViewportObservers(quietMs = 160) {
  chatViewportObserverSuppressDepth += 1;
  chatViewportObserverQuietUntil = Math.max(chatViewportObserverQuietUntil || 0, Date.now() + Math.max(0, quietMs));
}

function resumeChatViewportObservers() {
  chatViewportObserverSuppressDepth = Math.max(0, (chatViewportObserverSuppressDepth || 0) - 1);
}

function shouldIgnoreChatViewportObserverEvent() {
  return chatViewportObserverSuppressDepth > 0 || Date.now() < (chatViewportObserverQuietUntil || 0);
}

function runWithSuppressedChatViewportObservers(work, quietMs = 160) {
  suppressChatViewportObservers(quietMs);
  try {
    return work();
  } finally {
    resumeChatViewportObservers();
  }
}

function cancelFollowLatestAnimation() {
  chatViewportFollowToken += 1;
  if (chatViewportFollowRaf) {
    cancelAnimationFrame(chatViewportFollowRaf);
    chatViewportFollowRaf = 0;
  }
}

function startFollowLatestAnimation() {
  if (chatViewportFollowRaf || !followLatestEnabled || !isChatSurfaceActive()) {
    return;
  }

  const token = ++chatViewportFollowToken;
  const step = () => {
    if (token !== chatViewportFollowToken) {
      return;
    }
    chatViewportFollowRaf = 0;
    if (!followLatestEnabled || !isChatSurfaceActive() || shouldRenderWorkspaceSurface()) {
      return;
    }

    const metrics = getChatViewportMetrics();
    const targetTop = getChatViewportBottomTop(metrics);
    const delta = targetTop - metrics.top;
    const pendingContext = chatViewportSettlementContext;
    const hasRecentMutation = pendingContext
      ? (Date.now() - pendingContext.lastMutationAt) < 180
      : false;
    const distance = Math.abs(delta);

    if (distance <= 1) {
      setChatViewportTop(targetTop);
      if (!hasRecentMutation) {
        return;
      }
      chatViewportFollowRaf = requestAnimationFrame(step);
      return;
    }

    if (distance <= 64 || isNearBottom()) {
      setChatViewportTop(targetTop);
    } else if (isFollowLatestEntryWindowActive() || distance > 360) {
      setChatViewportTop(targetTop);
    } else {
      const stepSize = Math.max(14, Math.min(84, distance * 0.35));
      setChatViewportTop(metrics.top + Math.sign(delta) * stepSize);
    }

    chatViewportFollowRaf = requestAnimationFrame(step);
  };

  chatViewportFollowRaf = requestAnimationFrame(step);
}

// ── F1 决策（2026-08-19）：跟随动画 smooth 巡航中的增量更新不打断动画 ──
// 流式 append / patch / observer 事件到达时，若跟随动画正在 smooth 巡航，
// 不再同步硬锁底（旧行为：单帧大跳 = 闪跳），改由动画逐帧追新底部；
// 动画自带的 distance>360 硬跳兜底保证流式过快时仍能追上。
// render-full / process-toggle / input-render 与 forceSnap 仍立即对齐。
function isFollowLatestAnimationCruising() {
  return chatViewportFollowRaf !== 0 && chatViewportFollowTransition === 'smooth';
}

function shouldKeepFollowAnimationForMutation(reason, forceSnap) {
  if (!isFollowLatestAnimationCruising()) return false;
  if (forceSnap) return false;
  return reason !== 'render-full'
    && reason !== 'process-toggle'
    && reason !== 'input-render';
}

function observeChatViewportRows() {
  if (!chatViewportResizeObserver || !container) return;
  // ResizeObserver.observe() is idempotent for an already observed target.
  // Re-scan after each DOM render so newly inserted message rows are covered.
  container.querySelectorAll('.message-row').forEach((row) => {
    chatViewportResizeObserver.observe(row);
  });
}

function ensureChatViewportObservers() {
  if (chatViewportObserversReady) {
    observeChatViewportRows();
    return;
  }

  if (typeof MutationObserver === 'function') {
    chatViewportMutationObserver = new MutationObserver(() => {
      if (shouldIgnoreChatViewportObserverEvent() || shouldRenderWorkspaceSurface()) return;
      notifyChatViewportMutation({
        reason: 'dom-observer',
        shouldFollow: followLatestEnabled && isChatSurfaceActive(),
        preserveTop: followLatestEnabled ? null : container.scrollTop,
        forceSnap: isFollowLatestEntryWindowActive(),
        allowChase: false,
        preferSmooth: false,
      });
    });
    chatViewportMutationObserver.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  if (typeof ResizeObserver === 'function') {
    chatViewportResizeObserver = new ResizeObserver((entries) => {
      const hasChatRowResize = entries.some((entry) =>
        entry.target?.classList?.contains('message-row')
        || entry.target?.closest?.('.message-row')
      );
      // A row resize is the layout signal we are observing for
      // content-visibility realization. It must not be discarded by the
      // quiet window created by the mutation that caused the realization;
      // only observer noise from unrelated DOM/input changes is quieted.
      if ((chatViewportObserverSuppressDepth > 0
        || (!hasChatRowResize && Date.now() < (chatViewportObserverQuietUntil || 0)))
        || shouldRenderWorkspaceSurface()) return;
      notifyChatViewportMutation({
        reason: hasChatRowResize ? 'message-row-resize' : 'resize-observer',
        shouldFollow: followLatestEnabled && isChatSurfaceActive(),
        preserveTop: followLatestEnabled ? null : container.scrollTop,
        forceSnap: isFollowLatestEntryWindowActive(),
        allowChase: false,
        preferSmooth: false,
      });
    });
    chatViewportResizeObserver.observe(container);
    const inputContainer = document.getElementById('user-input-container');
    if (inputContainer) {
      chatViewportResizeObserver.observe(inputContainer);
    }
    // content-visibility may realize a row's intrinsic height without
    // changing the container's own box. Observe rows so that a height change
    // participates in the same settlement cycle as the original mutation.
    observeChatViewportRows();
  }

  chatViewportObserversReady = true;
}

function interruptFollowLatest(reason = 'manual') {
  cancelFollowLatestAnimation();
  suppressFollowScrollEvent = false;
  cancelChatScrollSettlement();
  chatViewportFollowTransition = 'locked';
  if (reason === 'manual' && followLatestEnabled) {
    followLatestEnabled = false;
    updateFollowLatestButton();
  }
}

function registerManualScrollIntent(options = {}) {
  const { interrupt = false } = options;
  markManualScrollIntent();
  if (interrupt && followLatestEnabled) {
    interruptFollowLatest('manual');
  }
}

function hasRecentManualScrollIntent() {
  return Date.now() - lastManualScrollIntentAt < 1500;
}

function beginFollowLatestCooldown(duration = 800) {
  _progScrollCooldownUntil = Math.max(_progScrollCooldownUntil, Date.now() + Math.max(0, duration));
}

function isFollowLatestCooldownActive() {
  return Date.now() < _progScrollCooldownUntil;
}

function beginFollowLatestEntryWindow(duration = 1200) {
  followLatestEntryUntil = Math.max(followLatestEntryUntil || 0, Date.now() + Math.max(0, duration));
}

function isFollowLatestEntryWindowActive() {
  return Date.now() < (followLatestEntryUntil || 0);
}

function cancelChatScrollSettlement() {
  chatViewportSettlementToken += 1;
  if (chatViewportSettlementRaf) {
    cancelAnimationFrame(chatViewportSettlementRaf);
    chatViewportSettlementRaf = 0;
  }
  if (chatViewportSettlementTimer != null) {
    clearTimeout(chatViewportSettlementTimer);
    chatViewportSettlementTimer = null;
  }
  chatViewportSettlementContext = null;
}

// ── 阅读位置恢复传递（switchAgent → render-full 的 preserveTop）──
// switchAgent 缓存了目标会话的 scrollTop，期望下一次聊天全量渲染把它作为
// preserveTop 保持。恢复值不能在切换时直接写进容器：那一刻容器里还是上一个
// 会话（可能更短）的 DOM，浏览器会把超出的 scrollTop 钳制掉，render 随后
// 读到的是钳制值并把它保持住 —— 从短会话切回长会话时阅读位置被永久销毁。
// 因此恢复值经由此处一次性传递，由下一次全量渲染消费。
let pendingChatScrollRestoreTop = null;

function setPendingChatScrollRestore(top) {
  pendingChatScrollRestoreTop = Number.isFinite(top) ? top : null;
}

function consumePendingChatScrollRestore() {
  const value = pendingChatScrollRestoreTop;
  pendingChatScrollRestoreTop = null;
  return value;
}

function notifyChatViewportMutation(options = {}) {
  ensureChatViewportObservers();

  if (shouldRenderWorkspaceSurface()) {
    cancelChatScrollSettlement();
    cancelFollowLatestAnimation();
    return;
  }

  const context = chatViewportSettlementContext || {
    reasons: new Set(),
    shouldFollow: false,
    preserveTop: null,
    forceSnap: false,
    allowChase: false,
    preferSmooth: false,
    startedAt: Date.now(),
    lastMutationAt: Date.now(),
    stableFrames: 0,
    lastMetricsKey: '',
  };

  const reason = String(options.reason || 'unknown');
  if (options.quietObservers !== false && reason !== 'dom-observer' && reason !== 'resize-observer') {
    chatViewportObserverQuietUntil = Math.max(chatViewportObserverQuietUntil || 0, Date.now() + 180);
  }
  context.reasons.add(reason);
  context.lastMutationAt = Date.now();
  context.shouldFollow = context.shouldFollow || options.shouldFollow === true;
  context.forceSnap = context.forceSnap || options.forceSnap === true;
  context.allowChase = context.allowChase || options.allowChase === true;
  context.preferSmooth = context.preferSmooth || options.preferSmooth === true;

  if (!context.shouldFollow && Number.isFinite(options.preserveTop)) {
    context.preserveTop = options.preserveTop;
  }

  chatViewportSettlementContext = context;

  const shouldLockBottomImmediately =
    context.shouldFollow
    && followLatestEnabled
    && isChatSurfaceActive()
    && !context.preferSmooth
    && !shouldRenderWorkspaceSurface()
    && !shouldKeepFollowAnimationForMutation(reason, options.forceSnap === true);
  if (shouldLockBottomImmediately) {
    lockChatViewportToBottomNow();
  }

  const token = ++chatViewportSettlementToken;
  if (chatViewportSettlementTimer != null) {
    clearTimeout(chatViewportSettlementTimer);
  }
  if (chatViewportSettlementRaf) {
    cancelAnimationFrame(chatViewportSettlementRaf);
    chatViewportSettlementRaf = 0;
  }

  const settle = () => {
    if (token !== chatViewportSettlementToken) return;
    chatViewportSettlementRaf = 0;
    const activeContext = chatViewportSettlementContext;
    if (!activeContext) return;
    if (shouldRenderWorkspaceSurface()) {
      cancelChatScrollSettlement();
      cancelFollowLatestAnimation();
      return;
    }

    const metrics = getChatViewportMetrics();
    const metricsKey = `${metrics.height}|${metrics.clientHeight}|${metrics.rowCount}`;
    if (metricsKey === activeContext.lastMetricsKey) {
      activeContext.stableFrames += 1;
    } else {
      activeContext.stableFrames = 0;
      activeContext.lastMetricsKey = metricsKey;
    }

    const timedOut = (Date.now() - activeContext.startedAt) > 280;
    const stableEnough = activeContext.stableFrames >= 2;
    if (!stableEnough && !timedOut) {
      chatViewportSettlementRaf = requestAnimationFrame(settle);
      return;
    }

    chatViewportSettlementContext = null;

    if (activeContext.shouldFollow && followLatestEnabled && isChatSurfaceActive()) {
      const targetTop = getChatViewportBottomTop(metrics);
      const delta = targetTop - metrics.top;
      const distance = Math.abs(delta);
      // F1：动画仍在 smooth 巡航时，纯增量 context 不抢锁 —— 动画每帧重读
      // 目标并自带 360px 兜底；settle 此刻抢锁会造成单帧大跳（闪跳）。
      const hasLayoutRebuildReason =
        activeContext.reasons.has('render-full')
        || activeContext.reasons.has('process-toggle')
        || activeContext.reasons.has('input-render');
      if (
        isFollowLatestAnimationCruising()
        && !activeContext.forceSnap
        && !isFollowLatestEntryWindowActive()
        && !hasLayoutRebuildReason
      ) {
        return;
      }
      const shouldAnimateExplicitFollow =
        activeContext.preferSmooth
        && chatViewportFollowTransition === 'smooth'
        && !isFollowLatestEntryWindowActive();
      const shouldSnapNow =
        !shouldAnimateExplicitFollow
        || activeContext.forceSnap
        || isFollowLatestEntryWindowActive()
        || distance <= 64
        || distance > 240
        || activeContext.reasons.has('render-full')
        || activeContext.reasons.has('process-toggle')
        || activeContext.reasons.has('input-render');

      if (shouldSnapNow) {
        lockChatViewportToBottomNow();
      } else if (shouldAnimateExplicitFollow && distance > 1) {
        startFollowLatestAnimation();
      }
      return;
    }

    if (activeContext.preserveTop != null) {
      cancelFollowLatestAnimation();
      setChatViewportTop(activeContext.preserveTop);
    }
  };

  chatViewportSettlementTimer = setTimeout(() => {
    if (token !== chatViewportSettlementToken) return;
    chatViewportSettlementTimer = null;
    chatViewportSettlementRaf = requestAnimationFrame(settle);
  }, 0);
}

function scrollToLatest(behavior = 'smooth') {
  const targetTop = getChatViewportBottomTop();
  if (behavior === 'auto') {
    cancelFollowLatestAnimation();
    lastManualScrollIntentAt = 0;
    setChatViewportTop(targetTop);
    chatViewportFollowTransition = 'locked';
    return;
  }

  lastManualScrollIntentAt = 0;
  chatViewportFollowTransition = 'smooth';
  startFollowLatestAnimation();
}

function setFollowLatest(enabled, options = {}) {
  const { scroll = false, behavior = 'smooth' } = options;
  followLatestEnabled = enabled;
  if (enabled) {
    lastManualScrollIntentAt = 0;
    chatViewportFollowTransition = behavior === 'smooth' ? 'smooth' : 'locked';
  }
  updateFollowLatestButton();
  if (enabled && scroll && isChatSurfaceActive()) {
    requestFollowLatest({ behavior, scroll: true });
  } else if (!enabled) {
    interruptFollowLatest('programmatic');
  }
}

function scheduleFollowLatestSettlePass() {
  if (!followLatestEnabled || !isChatSurfaceActive()) return;
  notifyChatViewportMutation({
    reason: 'settle-pass',
    shouldFollow: true,
    forceSnap: true,
    allowChase: false,
    preferSmooth: false,
  });
}

function requestFollowLatest(options = {}) {
  const {
    forceEnable = false,
    behavior = 'auto',
    immediate = false,
    scroll = true,
  } = options;

  if (forceEnable) {
    followLatestEnabled = true;
    lastManualScrollIntentAt = 0;
    updateFollowLatestButton();
  }

  if (!scroll || !isChatSurfaceActive() || !followLatestEnabled) {
    return;
  }

  const entryWindowActive = isFollowLatestEntryWindowActive();
  const smoothAllowed = behavior === 'smooth' && !entryWindowActive && !immediate;
  chatViewportFollowTransition = smoothAllowed ? 'smooth' : 'locked';
  notifyChatViewportMutation({
    reason: 'explicit-follow',
    shouldFollow: true,
    forceSnap: !smoothAllowed,
    allowChase: smoothAllowed,
    preferSmooth: smoothAllowed,
  });
}

function scheduleScrollToLatest(behavior = 'smooth') {
  requestFollowLatest({ behavior, scroll: true });
}

function scheduleScrollToLatestWithVersion(behavior = 'smooth', requestVersion = 0) {
  void requestVersion;
  requestFollowLatest({ behavior, scroll: true });
}

/* ═══════════════════════════════════════════════════════════════
   宽度变化滚动锚定（面板拖动 / 面板开关）
   ═══════════════════════════════════════════════════════════════
   背景：中央区宽度变化 → 内容重排、行高变化；overflow-anchor:none
   下浏览器保持 scrollTop 像素值，视口相对内容漂移（正在读的
   板块滑走 / 跟随最新跳离底部）。

   模式与 input-helpers.js 的 process-toggle 锚定一致：记录视口
   顶部第一个可见行 + 偏移；布局变化后 scrollTop = row.offsetTop
   + offset。与 windowing（cv-hidden 保留高度）无反馈循环。

   诊断：console.debug('[chat-anchor]')，DevTools 中可过滤观察。 */

const CHAT_ANCHOR_DEBUG = false; // 定位问题时置 true

function _debugChatAnchor(...args) {
  if (CHAT_ANCHOR_DEBUG) console.debug('[chat-anchor]', ...args);
}

function _isChatAnchorRowVisible(row) {
  return !row.classList.contains('process-hidden') &&
    !row.classList.contains('process-hidden-empty');
}

/** 捕获当前视口位置。必须在宽度变化（写样式）之前调用。 */
function captureChatViewportAnchor() {
  if (!container || typeof isChatSurfaceActive !== 'function' ||
      typeof shouldRenderWorkspaceSurface !== 'function' ||
      !isChatSurfaceActive() || shouldRenderWorkspaceSurface()) {
    return null;
  }

  const scrollTop = container.scrollTop;

  if (followLatestEnabled) {
    _debugChatAnchor('capture follow mode, scrollTop=', scrollTop);
    return { mode: 'follow', scrollTop };
  }

  const rows = container.querySelectorAll('.message-row');
  let visibleSeen = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!_isChatAnchorRowVisible(row)) continue;
    visibleSeen++;
    const rowTop = row.offsetTop;
    const rowBottom = rowTop + row.offsetHeight;
    if (rowBottom > scrollTop) {
      _debugChatAnchor('capture anchor: idx=', i, 'rowTop=', rowTop,
        'offset=', scrollTop - rowTop, 'scrollTop=', scrollTop,
        'totalRows=', rows.length, 'visibleSeen=', visibleSeen);
      return { mode: 'anchor', row, offset: scrollTop - rowTop, scrollTop, rowIdx: i };
    }
  }

  // 无可见行可锚定（空容器等），退化为像素保持
  _debugChatAnchor('capture pixel fallback, scrollTop=', scrollTop, 'totalRows=', rows.length);
  return { mode: 'pixel', scrollTop };
}

/** 应用锚点。必须在宽度变化已写入样式后、同一帧内调用（读 offsetTop 触发 forced layout 拿到新位置）。 */
function applyChatViewportAnchor(anchor) {
  if (!anchor || !container) return;

  if (anchor.mode === 'follow') {
    const target = container.scrollHeight;
    if (container.scrollTop !== target) {
      container.scrollTop = target;
      _debugChatAnchor('apply follow → scrollTop=', target);
    }
    return;
  }

  if (anchor.mode === 'anchor') {
    if (anchor.row && document.body.contains(anchor.row) && _isChatAnchorRowVisible(anchor.row)) {
      const target = Math.max(0, anchor.row.offsetTop + anchor.offset);
      if (container.scrollTop !== target) {
        container.scrollTop = target;
        _debugChatAnchor('apply anchor → scrollTop=', target,
          'rowIdx=', anchor.rowIdx, 'rowTop=', anchor.row.offsetTop);
      }
      return;
    }
    // 锚点行失效（被隐藏 / DOM 重建），顺延到其后第一个可见行
    _debugChatAnchor('anchor row stale, walking forward');
    const rows = container.querySelectorAll('.message-row');
    for (let i = (anchor.rowIdx || 0); i < rows.length; i++) {
      const row = rows[i];
      if (!_isChatAnchorRowVisible(row)) continue;
      container.scrollTop = Math.max(0, row.offsetTop + anchor.offset);
      _debugChatAnchor('apply stale→ idx=', i, 'rowTop=', row.offsetTop);
      return;
    }
    return;
  }

  // pixel fallback
  if (container.scrollTop !== anchor.scrollTop) {
    container.scrollTop = anchor.scrollTop;
    _debugChatAnchor('apply pixel → scrollTop=', anchor.scrollTop);
  }
}
