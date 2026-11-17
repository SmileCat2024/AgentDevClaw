/**
 * chat-viewport.js — Chat Viewport / Scroll 管理模块（从 app-ui.js 域 N 提取）
 *
 * ESM 迁移状态（P4 T2 批次）：**已转 ESM**，原 classic 唯一实现与标签删除。
 * P2 批次曾因「app-main 顶层同步链」判 R1/R4 触线，P4 时序切换（首屏渲染链改由
 * `boot.js` 在模块相触发）后该约束解除，本批按配方常规转换。
 *
 * 时序审计（R1/R2/R3/R4 + S）：
 *   - R1：本文件函数在仍 classic 的文件里**没有顶层调用点**（app-ui / app-main /
 *     chat-renderer 的调用全在函数体与事件回调内），改经桥键晚绑定后调用时相不变。
 *   - R2：首屏链现在由 `boot.js`（index.html 最后一条 module 标签）触发；本模块由
 *     p4-entry 在 kernel-entry 阶段求值，早于 boot，观察者 / 结算 / 跟随状态在首屏
 *     渲染前已就绪。
 *   - R3：`container` / `followLatestButton` 原为 app-core 的 classic 顶层 const
 *     （全局词法绑定，ESM 侧取不到）→ 模块求值期等价重建查询：元素从不替换，
 *     取得的是同一节点。dom-refs 域落地后改为 import。
 *   - R4：顶层语句只有一处 `container.addEventListener('scroll', …)` 注册与若干
 *     纯状态初始化。classic 相（解析中）与模块相（DOMContentLoaded 前求值）之间
 *     浏览器尚未处理输入事件，且首屏前的程序滚动已随时序切换移到模块相之后，
 *     监听对象与注册语义等价。
 *   - S：本文件原本即 `'use strict'`-兼容（无隐式全局赋值、无 with、无顶层 this）。
 *
 * 状态读写边界：跟随开关 / 视口观察与结算句柄 / 冷却与进入窗口都是 **app-core 的
 * 顶层 `let`**（未上桥，ESM 取不到 window 属性）——统一经 `chatSurface` 宿主适配
 * 模块（p2-bootstrap-chat-surface）读写，owner 不变、双向实时转发；
 * `assemblySideRailRevealTimer` 同理走 `assemblyUi`（p2-bootstrap-assembly）。
 * app-core 拆解批次把 owner 迁进 ESM 后，这两个宿主与 chat-viewport 域的桥键一并撤除。
 * 本文件的锚点族状态（`chatViewportAnchorByContext` / pending 阅读位置 / pending
 * 锚点 / 锚点保存定时器 / 避让定位 observer）本来就是模块私有，迁 ESM 后仍是模块私有。
 *
 * 桥键（domain `chat-viewport`，注册相位 = 模块求值相）：本文件顶层 `function`
 * 声明转化为 ESM 后不再是 window 属性，仍 classic 的消费方（app-ui / app-main /
 * app-core / chat-renderer / runtime-status / persistent-input / thread-store /
 * input-composer）与**未在本批清单内**的已迁 ESM 消费方（chat-scroll /
 * chat-row-visibility / lazy-tool-content / tool-progress / input-render /
 * chat-context-bar / chat-process-visibility / chat-nav-timeline / ph-search-locate /
 * debug-panel-host / ctx-menu-handlers / workspace-actions / input-actions）继续经
 * window 晚绑定取用，逐键见文件末尾注册清单与头注注销条件。
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
 * 依赖（import）：
 *   - escapeHtml, t：markdown-utils / ../i18n.js
 *   - currentMessages：session-view-storage（活绑定）
 *   - currentRuntimeAgentId：orchestration-state
 *   - refreshMeasuredChatRows：chat-row-visibility
 *   - chatSurface / assemblyUi：app-core 的状态宿主适配
 * 依赖（仍 classic，window 晚绑定；定义域在行尾标注）：
 *   - shouldRenderWorkspaceSurface, isChatSurfaceActive（app-ui.js）
 *   - getRuntimeContextKey（app-core.js）
 */
import { escapeHtml } from './markdown-utils.js';
import { t } from '../i18n.js';
import { currentMessages } from './session-view-storage.js';
import { currentRuntimeAgentId } from './orchestration-state.js';
import { refreshMeasuredChatRows } from './chat-row-visibility.js';
import { chatSurface } from './p2-bootstrap-chat-surface.js';
import { assemblyUi } from './p2-bootstrap-assembly.js';

// 等价重建 app-core 的两个 DOM 引用（见头注 R3：元素从不替换）。
const container = document.getElementById('chat-container');
const followLatestButton = document.getElementById('follow-latest-btn');

function updateAssemblySideRailPosition() {
  if (!window.shouldRenderWorkspaceSurface()) return; // 桥接期：定义于 app-ui（编排域收敛时移除）
  const rail = container.querySelector('.assembly-side-rail');
  const flow = container.querySelector('.assembly-flow');
  if (!rail || !flow) {
    if (assemblyUi.assemblySideRailRevealTimer) {
      clearTimeout(assemblyUi.assemblySideRailRevealTimer);
      assemblyUi.assemblySideRailRevealTimer = null;
    }
    return;
  }
  if (window.innerWidth <= 920) {
    if (assemblyUi.assemblySideRailRevealTimer) {
      clearTimeout(assemblyUi.assemblySideRailRevealTimer);
      assemblyUi.assemblySideRailRevealTimer = null;
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
  if (assemblyUi.assemblySideRailRevealTimer) {
    clearTimeout(assemblyUi.assemblySideRailRevealTimer);
  }
  assemblyUi.assemblySideRailRevealTimer = setTimeout(() => {
    if (!document.body.contains(rail)) return;
    rail.classList.add('ready');
    assemblyUi.assemblySideRailRevealTimer = null;
  }, 140);
}

function getToggleButtonLabel(collapsed) {
  // chevron 由 .expand-toggle-btn::before mask 绘制（见 components.css），
  // 方向用 is-collapsed / is-expanded class 切换，零图标 DOM 节点。
  return collapsed ? escapeHtml(t('expand')) : escapeHtml(t('collapse'));
}

function isNearBottom() {
  const threshold = 48;
  return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
}

function updateFollowLatestButton() {
  if (!followLatestButton) return;
  ensureFollowLatestAvoidObserver();
  const hasMessages = currentMessages.length > 0 && window.isChatSurfaceActive() // 桥接期：定义于 app-ui
    && !container.querySelector('.empty-welcome, .chat-loading');
  followLatestButton.classList.toggle('hidden', !hasMessages);
  followLatestButton.classList.toggle('active', chatSurface.followLatestEnabled);
  followLatestButton.innerHTML =
    '<span class="follow-latest-dot"></span><span>' +
    escapeHtml(t(chatSurface.followLatestEnabled ? 'follow_latest_on' : 'follow_latest_off')) +
    '</span>';
}

/* ── 跟随按钮动态避让 ──
   需要避让输入卡时（中央区变窄或面板打开，与原容器查询同条件），按钮
   bottom 不用固定像素断点：输入卡高度随输入行数与换行动态变化，固定值
   要么侵入输入卡、要么在输入变多后失去跟踪，且多断点叠加会在断点交界
   回落（曾于 ≤768px 从避让位掉回遮挡位）。改为实时测量输入卡顶边到主
   区底边的距离，经 --follow-latest-bottom 写入布局；ResizeObserver 跟
   踪主区与输入容器尺寸——窗口缩放、侧栏拖宽、面板开关、输入框增/缩高
   都汇于此，单一驱动源。 */
const FOLLOW_LATEST_AVOID_MAX_WIDTH = 1100;
const FOLLOW_LATEST_AVOID_GAP = 10;
let _followLatestPosRaf = 0;
let _followLatestAvoidObserver = null;

function updateFollowLatestButtonPosition() {
  if (!followLatestButton) return;
  const main = followLatestButton.closest('.main-content');
  const inputHost = document.getElementById('user-input-container');
  if (!main || !inputHost) return;

  // 严格贴输入卡顶边：容器还包裹运行时长胶囊等更高元素，按容器测会使
  // 按钮悬空在输入卡上方一个胶囊的高度。常驻 composer 是唯一输入卡形态
  // （lease 卡片渲染在独立容器，不参与这里的几何）。
  const inputCard = inputHost.querySelector('.user-input-card');
  const inputRect = inputCard?.getBoundingClientRect();
  const needsAvoid = main.classList.contains('panel-open')
    || main.clientWidth <= FOLLOW_LATEST_AVOID_MAX_WIDTH;
  if (!needsAvoid || !inputRect?.height) {
    followLatestButton.style.removeProperty('--follow-latest-bottom');
    return;
  }
  const dist = main.getBoundingClientRect().bottom - inputRect.top;
  followLatestButton.style.setProperty(
    '--follow-latest-bottom', Math.round(dist + FOLLOW_LATEST_AVOID_GAP) + 'px');
}

/** 惰性建立尺寸跟踪（observe 的首次回调即完成初始定位）。沙箱测试等
 *  缺少 ResizeObserver / DOM 查询的宿主下保持空操作，与 viewport observers
 *  的 ensure 模式一致。 */
function ensureFollowLatestAvoidObserver() {
  if (_followLatestAvoidObserver) return;
  if (typeof ResizeObserver !== 'function'
      || typeof document === 'undefined'
      || typeof document.querySelector !== 'function') return;
  const main = document.querySelector('.main-content');
  const inputHost = document.getElementById('user-input-container');
  if (!main || !inputHost) return;
  _followLatestAvoidObserver = new ResizeObserver(() => {
    if (_followLatestPosRaf) return;
    _followLatestPosRaf = requestAnimationFrame(() => {
      _followLatestPosRaf = 0;
      updateFollowLatestButtonPosition();
    });
  });
  _followLatestAvoidObserver.observe(main);
  _followLatestAvoidObserver.observe(inputHost);
}

function markManualScrollIntent() {
  chatSurface.lastManualScrollIntentAt = Date.now();
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
  chatSurface.suppressFollowScrollEvent = true;
  container.scrollTop = Math.max(0, nextTop);
  chatSurface.suppressFollowScrollEvent = false;
}

function lockChatViewportToBottomNow() {
  cancelFollowLatestAnimation();
  setChatViewportTop(getChatViewportBottomTop());
  chatSurface.chatViewportFollowTransition = 'locked';
}

function suppressChatViewportObservers(quietMs = 160) {
  chatSurface.chatViewportObserverSuppressDepth += 1;
  chatSurface.chatViewportObserverQuietUntil = Math.max(chatSurface.chatViewportObserverQuietUntil || 0, Date.now() + Math.max(0, quietMs));
}

function resumeChatViewportObservers() {
  chatSurface.chatViewportObserverSuppressDepth = Math.max(0, (chatSurface.chatViewportObserverSuppressDepth || 0) - 1);
}

function shouldIgnoreChatViewportObserverEvent() {
  return chatSurface.chatViewportObserverSuppressDepth > 0 || Date.now() < (chatSurface.chatViewportObserverQuietUntil || 0);
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
  chatSurface.chatViewportFollowToken += 1;
  if (chatSurface.chatViewportFollowRaf) {
    cancelAnimationFrame(chatSurface.chatViewportFollowRaf);
    chatSurface.chatViewportFollowRaf = 0;
  }
}

function startFollowLatestAnimation() {
  if (chatSurface.chatViewportFollowRaf || !chatSurface.followLatestEnabled || !window.isChatSurfaceActive()) {
    return;
  }

  const token = ++chatSurface.chatViewportFollowToken;
  const step = () => {
    if (token !== chatSurface.chatViewportFollowToken) {
      return;
    }
    chatSurface.chatViewportFollowRaf = 0;
    if (!chatSurface.followLatestEnabled || !window.isChatSurfaceActive() || window.shouldRenderWorkspaceSurface()) {
      return;
    }

    const metrics = getChatViewportMetrics();
    const targetTop = getChatViewportBottomTop(metrics);
    const delta = targetTop - metrics.top;
    const pendingContext = chatSurface.chatViewportSettlementContext;
    const hasRecentMutation = pendingContext
      ? (Date.now() - pendingContext.lastMutationAt) < 180
      : false;
    const distance = Math.abs(delta);

    if (distance <= 1) {
      setChatViewportTop(targetTop);
      if (!hasRecentMutation) {
        return;
      }
      chatSurface.chatViewportFollowRaf = requestAnimationFrame(step);
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

    chatSurface.chatViewportFollowRaf = requestAnimationFrame(step);
  };

  chatSurface.chatViewportFollowRaf = requestAnimationFrame(step);
}

// ── F1 决策（2026-08-19）：跟随动画 smooth 巡航中的增量更新不打断动画 ──
// 流式 append / patch / observer 事件到达时，若跟随动画正在 smooth 巡航，
// 不再同步硬锁底（旧行为：单帧大跳 = 闪跳），改由动画逐帧追新底部；
// 动画自带的 distance>360 硬跳兜底保证流式过快时仍能追上。
// render-full / process-toggle / input-render 与 forceSnap 仍立即对齐。
function isFollowLatestAnimationCruising() {
  return chatSurface.chatViewportFollowRaf !== 0 && chatSurface.chatViewportFollowTransition === 'smooth';
}

function shouldKeepFollowAnimationForMutation(reason, forceSnap) {
  if (!isFollowLatestAnimationCruising()) return false;
  if (forceSnap) return false;
  return reason !== 'render-full'
    && reason !== 'process-toggle'
    && reason !== 'input-render';
}

function observeChatViewportRows() {
  if (!chatSurface.chatViewportResizeObserver || !container) return;
  // ResizeObserver.observe() is idempotent for an already observed target.
  // Re-scan after each DOM render so newly inserted message rows are covered.
  container.querySelectorAll('.message-row').forEach((row) => {
    chatSurface.chatViewportResizeObserver.observe(row);
  });
}

function ensureChatViewportObservers() {
  if (chatSurface.chatViewportObserversReady) {
    observeChatViewportRows();
    return;
  }

  if (typeof MutationObserver === 'function') {
    chatSurface.chatViewportMutationObserver = new MutationObserver(() => {
      if (shouldIgnoreChatViewportObserverEvent() || window.shouldRenderWorkspaceSurface()) return;
      notifyChatViewportMutation({
        reason: 'dom-observer',
        shouldFollow: chatSurface.followLatestEnabled && window.isChatSurfaceActive(),
        preserveTop: chatSurface.followLatestEnabled ? null : container.scrollTop,
        forceSnap: isFollowLatestEntryWindowActive(),
        allowChase: false,
        preferSmooth: false,
      });
    });
    chatSurface.chatViewportMutationObserver.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  if (typeof ResizeObserver === 'function') {
    chatSurface.chatViewportResizeObserver = new ResizeObserver((entries) => {
      const hasChatRowResize = entries.some((entry) =>
        entry.target?.classList?.contains('message-row')
        || entry.target?.closest?.('.message-row')
      );
      // A row resize is the layout signal we are observing for
      // content-visibility realization. It must not be discarded by the
      // quiet window created by the mutation that caused the realization;
      // only observer noise from unrelated DOM/input changes is quieted.
      if ((chatSurface.chatViewportObserverSuppressDepth > 0
        || (!hasChatRowResize && Date.now() < (chatSurface.chatViewportObserverQuietUntil || 0)))
        || window.shouldRenderWorkspaceSurface()) return;
      notifyChatViewportMutation({
        reason: hasChatRowResize ? 'message-row-resize' : 'resize-observer',
        shouldFollow: chatSurface.followLatestEnabled && window.isChatSurfaceActive(),
        preserveTop: chatSurface.followLatestEnabled ? null : container.scrollTop,
        forceSnap: isFollowLatestEntryWindowActive(),
        allowChase: false,
        preferSmooth: false,
      });
    });
    chatSurface.chatViewportResizeObserver.observe(container);
    const inputContainer = document.getElementById('user-input-container');
    if (inputContainer) {
      chatSurface.chatViewportResizeObserver.observe(inputContainer);
    }
    // content-visibility may realize a row's intrinsic height without
    // changing the container's own box. Observe rows so that a height change
    // participates in the same settlement cycle as the original mutation.
    observeChatViewportRows();
  }

  chatSurface.chatViewportObserversReady = true;
}

function interruptFollowLatest(reason = 'manual') {
  cancelFollowLatestAnimation();
  chatSurface.suppressFollowScrollEvent = false;
  cancelChatScrollSettlement();
  chatSurface.chatViewportFollowTransition = 'locked';
  if (reason === 'manual' && chatSurface.followLatestEnabled) {
    chatSurface.followLatestEnabled = false;
    updateFollowLatestButton();
  }
}

function registerManualScrollIntent(options = {}) {
  const { interrupt = false } = options;
  markManualScrollIntent();
  if (interrupt && chatSurface.followLatestEnabled) {
    interruptFollowLatest('manual');
  }
}

function hasRecentManualScrollIntent() {
  return Date.now() - chatSurface.lastManualScrollIntentAt < 1500;
}

function beginFollowLatestCooldown(duration = 800) {
  chatSurface._progScrollCooldownUntil = Math.max(chatSurface._progScrollCooldownUntil, Date.now() + Math.max(0, duration));
}

function isFollowLatestCooldownActive() {
  return Date.now() < chatSurface._progScrollCooldownUntil;
}

function beginFollowLatestEntryWindow(duration = 1200) {
  chatSurface.followLatestEntryUntil = Math.max(chatSurface.followLatestEntryUntil || 0, Date.now() + Math.max(0, duration));
}

function isFollowLatestEntryWindowActive() {
  return Date.now() < (chatSurface.followLatestEntryUntil || 0);
}

function cancelChatScrollSettlement() {
  chatSurface.chatViewportSettlementToken += 1;
  if (chatSurface.chatViewportSettlementRaf) {
    cancelAnimationFrame(chatSurface.chatViewportSettlementRaf);
    chatSurface.chatViewportSettlementRaf = 0;
  }
  if (chatSurface.chatViewportSettlementTimer != null) {
    clearTimeout(chatSurface.chatViewportSettlementTimer);
    chatSurface.chatViewportSettlementTimer = null;
  }
  chatSurface.chatViewportSettlementContext = null;
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

// Persist the existing semantic viewport anchor across chat DOM rebuilds.
// Only rowIdx/offset are retained: DOM nodes cannot survive innerHTML replacement.
const chatViewportAnchorByContext = new Map();
let pendingChatViewportAnchor = null;

function serializeChatViewportAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object') return null;
  if (anchor.mode === 'follow') return { mode: 'follow' };
  if (anchor.mode !== 'anchor') {
    return Number.isFinite(anchor.scrollTop)
      ? { mode: 'pixel', scrollTop: anchor.scrollTop }
      : null;
  }
  return {
    mode: 'anchor',
    rowIdx: Number.isInteger(anchor.rowIdx) ? anchor.rowIdx : 0,
    offset: Number.isFinite(anchor.offset) ? anchor.offset : 0,
    scrollTop: Number.isFinite(anchor.scrollTop) ? anchor.scrollTop : 0,
  };
}

function setPendingChatViewportAnchor(anchor) {
  pendingChatViewportAnchor = anchor && typeof anchor === 'object' ? anchor : null;
}

function consumePendingChatViewportAnchor() {
  const anchor = pendingChatViewportAnchor;
  pendingChatViewportAnchor = null;
  return anchor;
}

function getChatViewportContextKey() {
  if (!currentRuntimeAgentId || typeof window.getRuntimeContextKey !== 'function') return null; // 桥接期：定义于 app-core
  return window.getRuntimeContextKey(currentRuntimeAgentId);
}

// Alias used by the renderer and runtime-cache boundary. Keep context identity
// in this module so all viewport persistence paths use the same key.
function getChatScrollContextKey() {
  return getChatViewportContextKey();
}

function rememberChatViewportAnchorForContext(contextKey = getChatViewportContextKey()) {
  if (!contextKey) return null;
  const anchor = captureChatViewportAnchor();
  const serialized = serializeChatViewportAnchor(anchor);
  if (serialized && serialized.mode !== 'follow') {
    chatViewportAnchorByContext.set(contextKey, serialized);
    return serialized;
  }
  // A session switch can save while the workspace surface is currently mounted;
  // keep the last semantic anchor instead of replacing it with a null snapshot.
  return chatViewportAnchorByContext.get(contextKey) || null;
}

function getRememberedChatViewportAnchorForContext(contextKey = getChatViewportContextKey()) {
  if (!contextKey) return null;
  return chatViewportAnchorByContext.get(contextKey) || null;
}

// runtime 视图缓存 LRU 淘汰时联动释放对应 context 的锚点（app-core.js
// saveCurrentRuntimeToCache 调用；活跃 context 由调用方排除）。
function forgetChatViewportAnchorForContext(contextKey) {
  if (!contextKey) return;
  chatViewportAnchorByContext.delete(contextKey);
}

// Session/tab switches also capture synchronously at the cache boundary.
// During scrolling, wait for a pause before scanning rows and reading geometry.
let chatViewportAnchorSaveTimer = null;
container.addEventListener('scroll', () => {
  if (chatViewportAnchorSaveTimer !== null) {
    clearTimeout(chatViewportAnchorSaveTimer);
    chatViewportAnchorSaveTimer = null;
  }
  if (typeof window.isChatSurfaceActive !== 'function' || !window.isChatSurfaceActive() // 桥接期：定义于 app-ui
    || (typeof window.shouldRenderWorkspaceSurface === 'function' && window.shouldRenderWorkspaceSurface())
    || chatSurface.followLatestEnabled) {
    return;
  }
  const contextKey = getChatViewportContextKey();
  if (!contextKey) return;
  chatViewportAnchorSaveTimer = setTimeout(() => {
    chatViewportAnchorSaveTimer = null;
    if (getChatViewportContextKey() !== contextKey || !window.isChatSurfaceActive()
      || window.shouldRenderWorkspaceSurface() || chatSurface.followLatestEnabled) return;
    rememberChatViewportAnchorForContext(contextKey);
  }, 150);
}, { passive: true });

function notifyChatViewportMutation(options = {}) {
  refreshMeasuredChatRows(options.reason);
  ensureChatViewportObservers();

  if (window.shouldRenderWorkspaceSurface()) {
    cancelChatScrollSettlement();
    cancelFollowLatestAnimation();
    return;
  }

  const context = chatSurface.chatViewportSettlementContext || {
    reasons: new Set(),
    shouldFollow: false,
    preserveTop: null,
    preserveAnchor: null,
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
    chatSurface.chatViewportObserverQuietUntil = Math.max(chatSurface.chatViewportObserverQuietUntil || 0, Date.now() + 180);
  }
  context.reasons.add(reason);
  context.lastMutationAt = Date.now();
  context.shouldFollow = context.shouldFollow || options.shouldFollow === true;
  context.forceSnap = context.forceSnap || options.forceSnap === true;
  context.allowChase = context.allowChase || options.allowChase === true;
  context.preferSmooth = context.preferSmooth || options.preferSmooth === true;

  if (!context.shouldFollow && options.preserveAnchor) {
    context.preserveAnchor = options.preserveAnchor;
  }
  if (!context.shouldFollow && Number.isFinite(options.preserveTop)) {
    context.preserveTop = options.preserveTop;
  }

  chatSurface.chatViewportSettlementContext = context;

  const shouldLockBottomImmediately =
    context.shouldFollow
    && chatSurface.followLatestEnabled
    && window.isChatSurfaceActive()
    && !context.preferSmooth
    && !window.shouldRenderWorkspaceSurface()
    && !shouldKeepFollowAnimationForMutation(reason, options.forceSnap === true);
  if (shouldLockBottomImmediately) {
    lockChatViewportToBottomNow();
  }

  const token = ++chatSurface.chatViewportSettlementToken;
  if (chatSurface.chatViewportSettlementTimer != null) {
    clearTimeout(chatSurface.chatViewportSettlementTimer);
  }
  if (chatSurface.chatViewportSettlementRaf) {
    cancelAnimationFrame(chatSurface.chatViewportSettlementRaf);
    chatSurface.chatViewportSettlementRaf = 0;
  }

  const settle = () => {
    if (token !== chatSurface.chatViewportSettlementToken) return;
    chatSurface.chatViewportSettlementRaf = 0;
    const activeContext = chatSurface.chatViewportSettlementContext;
    if (!activeContext) return;
    if (window.shouldRenderWorkspaceSurface()) {
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
      chatSurface.chatViewportSettlementRaf = requestAnimationFrame(settle);
      return;
    }

    chatSurface.chatViewportSettlementContext = null;

    if (activeContext.shouldFollow && chatSurface.followLatestEnabled && window.isChatSurfaceActive()) {
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
        && chatSurface.chatViewportFollowTransition === 'smooth'
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

    if (activeContext.preserveAnchor && !hasRecentManualScrollIntent()) {
      cancelFollowLatestAnimation();
      applyChatViewportAnchor(activeContext.preserveAnchor);
    } else if (activeContext.preserveTop != null && !hasRecentManualScrollIntent()) {
      cancelFollowLatestAnimation();
      setChatViewportTop(activeContext.preserveTop);
    }
  };

  chatSurface.chatViewportSettlementTimer = setTimeout(() => {
    if (token !== chatSurface.chatViewportSettlementToken) return;
    chatSurface.chatViewportSettlementTimer = null;
    chatSurface.chatViewportSettlementRaf = requestAnimationFrame(settle);
  }, 0);
}

function scrollToLatest(behavior = 'smooth') {
  const targetTop = getChatViewportBottomTop();
  if (behavior === 'auto') {
    cancelFollowLatestAnimation();
    chatSurface.lastManualScrollIntentAt = 0;
    setChatViewportTop(targetTop);
    chatSurface.chatViewportFollowTransition = 'locked';
    return;
  }

  chatSurface.lastManualScrollIntentAt = 0;
  chatSurface.chatViewportFollowTransition = 'smooth';
  startFollowLatestAnimation();
}

function setFollowLatest(enabled, options = {}) {
  const { scroll = false, behavior = 'smooth' } = options;
  chatSurface.followLatestEnabled = enabled;
  if (enabled) {
    chatSurface.lastManualScrollIntentAt = 0;
    chatSurface.chatViewportFollowTransition = behavior === 'smooth' ? 'smooth' : 'locked';
  }
  updateFollowLatestButton();
  if (enabled && scroll && window.isChatSurfaceActive()) {
    requestFollowLatest({ behavior, scroll: true });
  } else if (!enabled) {
    interruptFollowLatest('programmatic');
  }
}

function scheduleFollowLatestSettlePass() {
  if (!chatSurface.followLatestEnabled || !window.isChatSurfaceActive()) return;
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
    chatSurface.followLatestEnabled = true;
    chatSurface.lastManualScrollIntentAt = 0;
    updateFollowLatestButton();
  }

  if (!scroll || !window.isChatSurfaceActive() || !chatSurface.followLatestEnabled) {
    return;
  }

  const entryWindowActive = isFollowLatestEntryWindowActive();
  const smoothAllowed = behavior === 'smooth' && !entryWindowActive && !immediate;
  chatSurface.chatViewportFollowTransition = smoothAllowed ? 'smooth' : 'locked';
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
  if (!container || typeof window.isChatSurfaceActive !== 'function' ||
      typeof window.shouldRenderWorkspaceSurface !== 'function' ||
      !window.isChatSurfaceActive() || window.shouldRenderWorkspaceSurface()) {
    return null;
  }

  const scrollTop = container.scrollTop;

  if (chatSurface.followLatestEnabled) {
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
    let row = anchor.row;
    if (!(row && document.body.contains(row) && _isChatAnchorRowVisible(row))) {
      // A serialized anchor has no DOM node. Resolve it against the freshly
      // rendered message rows, preserving the same semantic row and offset.
      const rows = container.querySelectorAll('.message-row');
      for (let i = Math.max(0, anchor.rowIdx || 0); i < rows.length; i++) {
        if (_isChatAnchorRowVisible(rows[i])) {
          row = rows[i];
          break;
        }
      }
    }
    if (row && _isChatAnchorRowVisible(row)) {
      const target = Math.max(0, row.offsetTop + anchor.offset);
      if (container.scrollTop !== target) {
        container.scrollTop = target;
        _debugChatAnchor('apply anchor → scrollTop=', target,
          'rowIdx=', anchor.rowIdx, 'rowTop=', row.offsetTop);
      }
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

export {
  updateAssemblySideRailPosition,
  getToggleButtonLabel,
  isNearBottom,
  updateFollowLatestButton,
  updateFollowLatestButtonPosition,
  ensureFollowLatestAvoidObserver,
  markManualScrollIntent,
  getChatViewportMetrics,
  getChatViewportBottomTop,
  setChatViewportTop,
  lockChatViewportToBottomNow,
  suppressChatViewportObservers,
  resumeChatViewportObservers,
  shouldIgnoreChatViewportObserverEvent,
  runWithSuppressedChatViewportObservers,
  cancelFollowLatestAnimation,
  startFollowLatestAnimation,
  isFollowLatestAnimationCruising,
  shouldKeepFollowAnimationForMutation,
  observeChatViewportRows,
  ensureChatViewportObservers,
  interruptFollowLatest,
  registerManualScrollIntent,
  hasRecentManualScrollIntent,
  beginFollowLatestCooldown,
  isFollowLatestCooldownActive,
  beginFollowLatestEntryWindow,
  isFollowLatestEntryWindowActive,
  cancelChatScrollSettlement,
  notifyChatViewportMutation,
  setPendingChatScrollRestore,
  consumePendingChatScrollRestore,
  serializeChatViewportAnchor,
  setPendingChatViewportAnchor,
  consumePendingChatViewportAnchor,
  getChatViewportContextKey,
  getChatScrollContextKey,
  rememberChatViewportAnchorForContext,
  getRememberedChatViewportAnchorForContext,
  forgetChatViewportAnchorForContext,
  scrollToLatest,
  setFollowLatest,
  scheduleFollowLatestSettlePass,
  requestFollowLatest,
  scheduleScrollToLatest,
  scheduleScrollToLatestWithVersion,
  captureChatViewportAnchor,
  applyChatViewportAnchor,
};

/* ── 桥键（domain `chat-viewport`）──────────────────────────────────
   逐键消费面证据（仍未迁移的 classic 消费方 / 本批清单外的已迁 ESM 晚绑定取用）：
   - updateAssemblySideRailPosition   ← app-ui.js（renderCurrentMainView 两处 rAF）、
                                        ctx-menu-handlers.js（window）
   - updateFollowLatestButton         ← app-ui.js、chat-renderer.js（bare）
   - getToggleButtonLabel             ← chat-renderer.js（bare，折叠按钮文案）
   - isNearBottom                     ← chat-scroll.js（window）
   - cancelChatScrollSettlement       ← app-ui.js、chat-renderer.js（bare）
   - notifyChatViewportMutation       ← chat-renderer / chat-context-bar /
                                        chat-process-visibility / input-render /
                                        p2-w2-1-chat-windowing-host 链路
   - runWithSuppressedChatViewportObservers ← chat-renderer / input-composer /
                                        lazy-tool-content / tool-progress / input-render
   - suppressChatViewportObservers / resumeChatViewportObservers ← app-ui.js、
                                        debug-panel-host.js
   - ensureChatViewportObservers      ← app-ui.js（renderCurrentMainView 无条件）
   - lockChatViewportToBottomNow      ← chat-renderer.js（render 首屏锁底）
   - registerManualScrollIntent       ← chat-scroll / chat-nav-timeline /
                                        ph-search-locate；hasRecentManualScrollIntent
                                        ← chat-scroll
   - beginFollowLatestCooldown / beginFollowLatestEntryWindow ← app-main.js（host）、
                                        workspace-actions / input-actions / persistent-input
   - setFollowLatest / requestFollowLatest / scheduleFollowLatestSettlePass ←
                                        app-main / app-ui（host）、chat-scroll、
                                        debug-panel-host、ph-search-locate 等
   - captureChatViewportAnchor / applyChatViewportAnchor ← app-ui / chat-renderer /
                                        chat-row-visibility / debug-panel-host
   - rememberChatViewportAnchorForContext / getRememberedChatViewportAnchorForContext /
     getChatViewportContextKey / forgetChatViewportAnchorForContext ← app-core.js
                                        （createRuntimeViewCacheHost）、app-ui.js
   - setPendingChatScrollRestore ← app-main / thread-store；
     consumePendingChatScrollRestore ← chat-renderer
   - setPendingChatViewportAnchor / consumePendingChatViewportAnchor ← app-main /
                                        thread-store / app-ui / app-core / chat-renderer
   - getChatScrollContextKey          ← chat-renderer.js（render 的 context 比对）

   注销条件（逐批随消费方收敛）：
   - chat-renderer / app-ui / app-main / app-core 四件迁 ESM 并改 import 后，上述对应
     键整块注销（`KERNEL_BRIDGE_UPDATE_BASELINE=1` 由主助手执行）；
   - chat-scroll / chat-nav-timeline / ph-search-locate / input-actions /
     workspace-actions / persistent-input / chat-row-visibility / lazy-tool-content /
     tool-progress / input-render / chat-context-bar / chat-process-visibility /
     ctx-menu-handlers / debug-panel-host 改 import 时逐键注销。
   未上桥的模块内实现（markManualScrollIntent / getChatViewportMetrics /
   updateFollowLatestButtonPosition / scrollToLatest / scheduleScrollToLatest* 等）在
   生产代码里零 window 消费面，只作命名导出（实验脚本与测试消费）。 */
const bridged = {
  updateAssemblySideRailPosition,
  updateFollowLatestButton,
  getToggleButtonLabel,
  isNearBottom,
  cancelChatScrollSettlement,
  notifyChatViewportMutation,
  runWithSuppressedChatViewportObservers,
  suppressChatViewportObservers,
  resumeChatViewportObservers,
  ensureChatViewportObservers,
  lockChatViewportToBottomNow,
  registerManualScrollIntent,
  hasRecentManualScrollIntent,
  beginFollowLatestCooldown,
  beginFollowLatestEntryWindow,
  setFollowLatest,
  requestFollowLatest,
  scheduleFollowLatestSettlePass,
  captureChatViewportAnchor,
  applyChatViewportAnchor,
  rememberChatViewportAnchorForContext,
  getRememberedChatViewportAnchorForContext,
  getChatViewportContextKey,
  forgetChatViewportAnchorForContext,
  setPendingChatScrollRestore,
  consumePendingChatScrollRestore,
  setPendingChatViewportAnchor,
  consumePendingChatViewportAnchor,
  getChatScrollContextKey,
};
// 逐键显式注册（不用循环）：桥债口径按 defineKey 调用点数计量，循环会把 29 个
// 桥键压成 1 个调用点，等于在指标上做口径游戏。
window.KernelState.defineKey('chat-viewport', 'updateAssemblySideRailPosition', bridged.updateAssemblySideRailPosition);
window.KernelState.defineKey('chat-viewport', 'updateFollowLatestButton', bridged.updateFollowLatestButton);
window.KernelState.defineKey('chat-viewport', 'getToggleButtonLabel', bridged.getToggleButtonLabel);
window.KernelState.defineKey('chat-viewport', 'isNearBottom', bridged.isNearBottom);
window.KernelState.defineKey('chat-viewport', 'cancelChatScrollSettlement', bridged.cancelChatScrollSettlement);
window.KernelState.defineKey('chat-viewport', 'notifyChatViewportMutation', bridged.notifyChatViewportMutation);
window.KernelState.defineKey('chat-viewport', 'runWithSuppressedChatViewportObservers', bridged.runWithSuppressedChatViewportObservers);
window.KernelState.defineKey('chat-viewport', 'suppressChatViewportObservers', bridged.suppressChatViewportObservers);
window.KernelState.defineKey('chat-viewport', 'resumeChatViewportObservers', bridged.resumeChatViewportObservers);
window.KernelState.defineKey('chat-viewport', 'ensureChatViewportObservers', bridged.ensureChatViewportObservers);
window.KernelState.defineKey('chat-viewport', 'lockChatViewportToBottomNow', bridged.lockChatViewportToBottomNow);
window.KernelState.defineKey('chat-viewport', 'registerManualScrollIntent', bridged.registerManualScrollIntent);
window.KernelState.defineKey('chat-viewport', 'hasRecentManualScrollIntent', bridged.hasRecentManualScrollIntent);
window.KernelState.defineKey('chat-viewport', 'beginFollowLatestCooldown', bridged.beginFollowLatestCooldown);
window.KernelState.defineKey('chat-viewport', 'beginFollowLatestEntryWindow', bridged.beginFollowLatestEntryWindow);
window.KernelState.defineKey('chat-viewport', 'setFollowLatest', bridged.setFollowLatest);
window.KernelState.defineKey('chat-viewport', 'requestFollowLatest', bridged.requestFollowLatest);
window.KernelState.defineKey('chat-viewport', 'scheduleFollowLatestSettlePass', bridged.scheduleFollowLatestSettlePass);
window.KernelState.defineKey('chat-viewport', 'captureChatViewportAnchor', bridged.captureChatViewportAnchor);
window.KernelState.defineKey('chat-viewport', 'applyChatViewportAnchor', bridged.applyChatViewportAnchor);
window.KernelState.defineKey('chat-viewport', 'rememberChatViewportAnchorForContext', bridged.rememberChatViewportAnchorForContext);
window.KernelState.defineKey('chat-viewport', 'getRememberedChatViewportAnchorForContext', bridged.getRememberedChatViewportAnchorForContext);
window.KernelState.defineKey('chat-viewport', 'getChatViewportContextKey', bridged.getChatViewportContextKey);
window.KernelState.defineKey('chat-viewport', 'forgetChatViewportAnchorForContext', bridged.forgetChatViewportAnchorForContext);
window.KernelState.defineKey('chat-viewport', 'setPendingChatScrollRestore', bridged.setPendingChatScrollRestore);
window.KernelState.defineKey('chat-viewport', 'consumePendingChatScrollRestore', bridged.consumePendingChatScrollRestore);
window.KernelState.defineKey('chat-viewport', 'setPendingChatViewportAnchor', bridged.setPendingChatViewportAnchor);
window.KernelState.defineKey('chat-viewport', 'consumePendingChatViewportAnchor', bridged.consumePendingChatViewportAnchor);
window.KernelState.defineKey('chat-viewport', 'getChatScrollContextKey', bridged.getChatScrollContextKey);
window.KernelState.claim('chat-viewport', {
  get: (key) => bridged[key],
  set: (key, value) => { bridged[key] = value; },
});
