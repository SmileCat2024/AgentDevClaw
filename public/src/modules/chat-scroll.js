/**
 * chat-scroll.js — Chat Scroll / Wheel 恢复模块（从 app-main.js 域 AC 提取）
 * 拆出日期：2026-07-04
 *
 * 包含：
 *   - normalizeWheelDeltaY: wheel 事件 deltaY 归一化
 *   - canElementScrollVertically: 判断元素是否可纵向滚动
 *   - hasScrollableWheelTarget: 判断 wheel 目标链是否有可滚动元素
 *   - isChromeWithoutEdge: UA 检测（Chrome 非 Edge）
 *   - shouldUseManualWheelScroll: 是否需要手动 wheel 滚动补偿
 *   - markChatPageResumed: 标记页面恢复（Chrome wheel 恢复标记）
 *   - 事件监听器：wheel, touchmove, pointerdown, keydown, scroll (follow), scroll (sticky), followLatestButton click, visibilitychange, focus, pageshow
 *
 * 依赖全局状态（定义在 app-core.js）:
 *   container, followLatestButton
 * 依赖 chat-viewport.js:
 *   registerManualScrollIntent, hasRecentManualScrollIntent, setFollowLatest,
 *   isNearBottom, suppressFollowScrollEvent, followLatestEnabled
 * 依赖 app-ui.js:
 *   isChatSurfaceActive, shouldRenderWorkspaceSurface
 * 依赖 context-menu.js:
 *   closeCtxMenu (via window.closeCtxMenu)
 */
function normalizeWheelDeltaY(event) {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 40;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * Math.max(1, container.clientHeight);
  return event.deltaY;
}

function canElementScrollVertically(element, deltaY) {
  if (!element || element === container || element === document.body || element === document.documentElement) {
    return false;
  }
  const style = window.getComputedStyle(element);
  const overflowY = style.overflowY;
  if (overflowY !== 'auto' && overflowY !== 'scroll' && overflowY !== 'overlay') {
    return false;
  }
  const maxTop = element.scrollHeight - element.clientHeight;
  if (maxTop <= 1) {
    return false;
  }
  if (deltaY > 0) {
    return element.scrollTop < maxTop - 1;
  }
  if (deltaY < 0) {
    return element.scrollTop > 1;
  }
  return false;
}

function hasScrollableWheelTarget(target, deltaY) {
  let node = target instanceof Element ? target : target?.parentElement;
  while (node && node !== container) {
    if (canElementScrollVertically(node, deltaY)) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

function isChromeWithoutEdge() {
  const ua = navigator.userAgent || '';
  return /\bChrome\//.test(ua) && !/\bEdg\//.test(ua);
}

let chatScrollNeedsWheelRecovery = false;

function shouldUseManualWheelScroll() {
  if (!isChromeWithoutEdge()) return false;
  if (!chatScrollNeedsWheelRecovery) return false;

  chatScrollNeedsWheelRecovery = false;
  return true;
}

container.addEventListener('wheel', (e) => {
  const beforeTop = container.scrollTop;
  const rawDeltaY = normalizeWheelDeltaY(e);
  const canManualScroll = isChatSurfaceActive()
    && !shouldRenderWorkspaceSurface()
    && !e.ctrlKey
    && !e.metaKey
    && Math.abs(rawDeltaY) > Math.abs(e.deltaX || 0)
    && !hasScrollableWheelTarget(e.target, rawDeltaY);
  const manualWheelScroll = canManualScroll && shouldUseManualWheelScroll();
  if (manualWheelScroll) {
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const nextTop = Math.max(0, Math.min(maxTop, beforeTop + rawDeltaY));
    e.preventDefault();
    if (Math.abs(nextTop - beforeTop) > 0.5) {
      container.scrollTop = nextTop;
    }
  }
  if (e.deltaY < 0) {
    // Scrolling up — always cancel follow
    registerManualScrollIntent({ interrupt: true });
  } else {
    // Scrolling down — don't immediately interrupt; let the scroll handler
    // decide via isNearBottom(). When already at the bottom, an involuntary
    // downward scroll shouldn't cancel follow mode.
    registerManualScrollIntent();
  }
}, { passive: false });
container.addEventListener('wheel', () => window.closeCtxMenu(), { passive: true });
container.addEventListener('touchmove', () => registerManualScrollIntent({ interrupt: true }), { passive: true });
container.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'mouse' || event.pointerType === 'touch' || event.pointerType === 'pen') {
    registerManualScrollIntent();
  }
}, { passive: true });
container.addEventListener('keydown', (event) => {
  if (['ArrowUp', 'PageUp', 'Home', ' '].includes(event.key)) {
    registerManualScrollIntent({ interrupt: true });
  }
});
container.addEventListener('scroll', () => {
  if (suppressFollowScrollEvent) {
    return;
  }
  if (followLatestEnabled) {
    // Follow is on — cancel if user scrolled away from bottom
    if (!isNearBottom() && hasRecentManualScrollIntent()) {
      setFollowLatest(false);
    }
  } else {
    // Follow is off — re-enable if user manually scrolled to bottom
    if (isNearBottom() && hasRecentManualScrollIntent()) {
      setFollowLatest(true);
    }
  }
});
// Sticky bar: detect pin/unpin and toggle .is-pinned for expand animation
let _stickyPadTop = null;
container.addEventListener('scroll', () => {
  const bar = container.querySelector('.ph-project-bar');
  if (!bar) return;
  if (_stickyPadTop === null) {
    _stickyPadTop = parseFloat(getComputedStyle(container).paddingTop) || 0;
  }
  const isPinned = bar.getBoundingClientRect().top <= container.getBoundingClientRect().top + _stickyPadTop + 1;
  if (isPinned !== bar.classList.contains('is-pinned')) {
    bar.classList.toggle('is-pinned', isPinned);
  }
}, { passive: true });
followLatestButton.addEventListener('click', () => {
  setFollowLatest(true, { scroll: true, behavior: 'smooth' });
});

function markChatPageResumed() {
  if (isChromeWithoutEdge() && isChatSurfaceActive()) {
    chatScrollNeedsWheelRecovery = true;
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    markChatPageResumed();
  }
});

window.addEventListener('focus', () => {
  markChatPageResumed();
});

window.addEventListener('pageshow', () => {
  markChatPageResumed();
});
