/**
 * chat-scroll.js — Chat Scroll / Wheel 恢复模块（classic → ESM，P4 T2 批次）
 * 从 app-main.js 域 AC 提取；拆出日期：2026-07-04。
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
 * 迁移要点（R4 审计）：
 *   - 顶层语句只有两处 DOM 查询与事件注册。classic 相（解析末尾）与模块相
 *     （DOMContentLoaded 前求值）之间浏览器尚未处理输入事件，因此监听对象与
 *     注册语义完全相同；首屏渲染链已由 `boot.js` 在模块相触发（P4 时序切换
 *     提交），本文件不再有 classic 相同步触达约束。
 *   - `container` / `followLatestButton` 原为 app-core 的 classic 顶层 const
 *     （全局词法绑定，ESM 侧取不到）→ 模块求值期等价重建查询：元素从不替换，
 *     取得的是同一节点。dom-refs 域落地后改为 import。
 *   - 本文件六个导出函数在生产代码里零跨文件消费方（只有测试与既有内联调用），
 *     因此**不注册桥键、不 claim**；模块私有状态（恢复标记 / sticky 基准）同理。
 *   - 状态读写边界：跟随开关与滚动事件抑制标志是 app-core 的 classic 顶层
 *     let（未上桥，ESM 取不到 window 属性），统一经 `chatSurface` 宿主适配模块
 *     （p2-bootstrap-chat-surface）；视口域的同步入口（registerManualScrollIntent /
 *     hasRecentManualScrollIntent / setFollowLatest / isNearBottom）仍是 classic
 *     实现（chat-viewport.js 保留唯一 classic 实现），经 window 晚绑定调用；
 *     `closeCtxMenu` 原有协议即为 `window.closeCtxMenu`。
 * 依赖 app-ui.js（classic 函数，window 晚绑定）：
 *   isChatSurfaceActive, shouldRenderWorkspaceSurface
 */
import { chatSurface } from './p2-bootstrap-chat-surface.js';

// 等价重建 app-core 的两个 DOM 引用（见头注：元素从不替换）。
const container = document.getElementById('chat-container');
const followLatestButton = document.getElementById('follow-latest-btn');

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
  container.removeEventListener('wheel', recoverChatWheelScroll);
  return true;
}

// Only the first eligible wheel after Chrome resumes needs cancellation.
// Keep this blocking listener detached during ordinary compositor scrolling.
function recoverChatWheelScroll(e) {
  if (!chatScrollNeedsWheelRecovery || !window.isChatSurfaceActive() // 桥接期：定义于 app-ui（编排域收敛时移除）
    || window.shouldRenderWorkspaceSurface() || e.ctrlKey || e.metaKey) return;
  const rawDeltaY = normalizeWheelDeltaY(e);
  if (Math.abs(rawDeltaY) <= Math.abs(e.deltaX || 0)
    || hasScrollableWheelTarget(e.target, rawDeltaY)
    || !shouldUseManualWheelScroll()) return;
  const beforeTop = container.scrollTop;
  const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
  const nextTop = Math.max(0, Math.min(maxTop, beforeTop + rawDeltaY));
  e.preventDefault();
  if (Math.abs(nextTop - beforeTop) > 0.5) {
    container.scrollTop = nextTop;
  }
}

container.addEventListener('wheel', (e) => {
  if (e.deltaY < 0) {
    // Scrolling up — always cancel follow
    window.registerManualScrollIntent({ interrupt: true }); // 桥接期：定义于 chat-viewport（视口域收敛时改 import）
  } else {
    // Scrolling down — don't immediately interrupt; let the scroll handler
    // decide via isNearBottom(). When already at the bottom, an involuntary
    // downward scroll shouldn't cancel follow mode.
    window.registerManualScrollIntent();
  }
}, { passive: true });
container.addEventListener('wheel', () => window.closeCtxMenu(), { passive: true });
container.addEventListener('touchmove', () => window.registerManualScrollIntent({ interrupt: true }), { passive: true });
container.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'mouse' || event.pointerType === 'touch' || event.pointerType === 'pen') {
    window.registerManualScrollIntent();
  }
}, { passive: true });
container.addEventListener('keydown', (event) => {
  if (['ArrowUp', 'PageUp', 'Home', ' '].includes(event.key)) {
    window.registerManualScrollIntent({ interrupt: true });
  }
});
// ── 跟随最新判定（方向感知）──
// 跟随的字面语义是"钉在底部"：向上滚动（哪怕只滚一点点、仍在底部容差
// 阈值内）就退出跟随；退出后只有向下滚回底部附近才恢复跟随。
// 方向只记录有实际位移的滚动；无位移的 scroll 事件（同一滚动被重复派
// 发、程序补发）沿用上次方向，避免一次滚动拆成两次事件时第二次丢失方
// 向、被误判为"已滚回底部"而恢复跟随。suppress 期间是程序写 scrollTop，
// 同样更新基准但不做判定，防止后续真实滚动事件与过期基准比较。
(() => {
  let prevTop = container.scrollTop;
  let direction = 0; // -1 = 向上, 1 = 向下

  container.addEventListener('scroll', () => {
    const top = container.scrollTop;
    if (Math.abs(top - prevTop) > 0.5) {
      direction = top < prevTop ? -1 : 1;
      prevTop = top;
    }
    if (chatSurface.suppressFollowScrollEvent) {
      return;
    }
    const scrolledUp = direction === -1;
    if (chatSurface.followLatestEnabled) {
      // Follow is on — cancel if user scrolled away from bottom; an upward
      // scroll cancels immediately even within the bottom threshold, since
      // following means staying pinned to the very bottom.
      if ((!window.isNearBottom() || scrolledUp) && window.hasRecentManualScrollIntent()) {
        window.setFollowLatest(false);
      }
    } else {
      // Follow is off — re-enable only when the latest movement brought the
      // viewport down to the bottom; scrolling up must not re-enable follow.
      if (window.isNearBottom() && !scrolledUp && window.hasRecentManualScrollIntent()) {
        window.setFollowLatest(true);
      }
    }
  });
})();
// Sticky bar: detect pin/unpin and toggle .is-pinned for expand animation
let _stickyPadTop = null;
container.addEventListener('scroll', () => {
  if (!window.shouldRenderWorkspaceSurface()) return;
  const bar = container.querySelector('.ph-project-bar');
  if (!bar) return;
  if (_stickyPadTop === null) {
    _stickyPadTop = parseFloat(window.getComputedStyle(container).paddingTop) || 0;
  }
  const isPinned = bar.getBoundingClientRect().top <= container.getBoundingClientRect().top + _stickyPadTop + 1;
  if (isPinned !== bar.classList.contains('is-pinned')) {
    bar.classList.toggle('is-pinned', isPinned);
  }
}, { passive: true });
followLatestButton.addEventListener('click', () => {
  window.setFollowLatest(true, { scroll: true, behavior: 'smooth' }); // 桥接期：定义于 chat-viewport
});

function markChatPageResumed() {
  if (isChromeWithoutEdge() && window.isChatSurfaceActive()) {
    chatScrollNeedsWheelRecovery = true;
    container.addEventListener('wheel', recoverChatWheelScroll, { passive: false });
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

export {
  normalizeWheelDeltaY,
  canElementScrollVertically,
  hasScrollableWheelTarget,
  isChromeWithoutEdge,
  shouldUseManualWheelScroll,
  markChatPageResumed,
};
