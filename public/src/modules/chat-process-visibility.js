/**
 * chat-process-visibility.js — 对话过程显隐（ESM 域 `chat-process-visibility`）。
 *
 * 来源与边界（P2 输入面收尾批次）：本模块从 input-helpers.js 原位迁出「过程
 * 内容显隐」这一支——可见性偏好持久化、过程行 DOM 同步、显隐切换编排。原文件
 * 按 R1 只保留唯一 classic 实现 `updateChatProcessToggle`（首屏同步链触达，见
 * input-helpers.js 头注）。搬移不改行为：函数体逐行保留。
 *
 * 时序审计（R1/R2/R4）：
 *   - 本文件的键在 classic 相零触达：`applyConversationProcessState` 的唯一
 *     classic 消费方是 chat-renderer 的渲染函数（消息上屏后才调用），
 *     `toggleChatProcessVisibility` 只被 app-core 装载期注册的 click 监听
 *     （`chatProcessToggle` 按钮）在用户交互时调用。deferred 模块在
 *     DOMContentLoaded 之前求值，用户无法在此之前点击，注册相位 = ESM 执行相。
 *   - `updateChatProcessToggle` 仍由本模块在函数体内经 window 晚绑定调用
 *     （它保持 classic 唯一实现），不复制第二实现、不新增等待。
 *
 * 桥键（domain `chat-process-visibility`）：
 *   - `applyConversationProcessState` ← chat-renderer.js（appendNewMessages /
 *     updateLastMessage / render 落位后按 DOM 行起点增量应用）
 *   注销条件：chat-renderer 迁 ESM 并改为 import。
 *   `toggleChatProcessVisibility` ← app-core 的 chatProcessToggle click 监听
 *   （`window.toggleChatProcessVisibility()`）。显式的 `window.` 调用不等于永久
 *   外部协议：按配方统一经 defineKey 注册，函数键 setter 原样转发。
 *   `saveChatProcessVisibility` / `syncAssistantProcessOnlyRows` 零跨文件消费方，
 *   按配方保持模块私有，不上桥。
 *
 * 依赖形态：
 *   - 已迁 ESM 直接 import：DOM 引用（domRefs.container）、聊天表面状态
 *     （chatSurface：showChatProcess / followLatestEnabled /
 *     CHAT_PROCESS_VISIBILITY_KEY）、窗口分级与整行窗口（lazy-tool-content 的
 *     applyProcessDistance / clearProcessDistance / precomputeViewportIdx）、
 *     渲染签名（render-entry-state 的 setLastRenderedChatSig）、消息存储
 *     （currentMessages）。
 *   - 仍 classic 的显式 window 晚绑定（原实现同为运行期调用）：
 *     `updateChatProcessToggle`（input-helpers）、`syncCollapseStates` /
 *     `render`（chat-renderer）、`isChatSurfaceActive`（app-ui）、
 *     `notifyChatViewportMutation`（chat-viewport）、
 *     `ensureChatRuntimeIndicator`（runtime-status，原实现带 `typeof` 守卫，
 *     此处保留）。
 */
import { domRefs } from './p2-bootstrap-dom.js';
import { chatSurface } from './p2-bootstrap-chat-surface.js';
import {
  applyProcessDistance,
  clearProcessDistance,
  precomputeViewportIdx,
} from './lazy-tool-content.js';
import { setLastRenderedChatSig } from './render-entry-state.js';
import { currentMessages } from './session-view-storage.js';

function saveChatProcessVisibility() {
  try {
    localStorage.setItem(chatSurface.CHAT_PROCESS_VISIBILITY_KEY, chatSurface.showChatProcess ? 'true' : 'false');
  } catch (error) {
    console.warn('Failed to persist chat process visibility:', error);
  }
}

function syncAssistantProcessOnlyRows(root = domRefs.container, fromIndex = 0) {
  // fromIndex 之后才可能是新插入 / 被 patch 的行，旧行的空行判定不随
  // 尾部追加变化；child 探测里的 offsetParent 读取在布局脏时会强制
  // flush，遍历必须限定在尾部范围。fromIndex 是 DOM 行下标，不是消息
  // 下标（错误聚合会合并行），因此按全行列表而非 .assistant 子集截断。
  const rows = root.querySelectorAll('.message-row');
  for (let i = Math.max(0, fromIndex | 0); i < rows.length; i++) {
    const row = rows[i];
    if (!row.classList.contains('assistant')) continue;
    const content = row.querySelector('.message-content');
    if (!content) continue;

    const hasProcessChild = Array.from(content.children).some((child) =>
      child.classList.contains('reasoning-block')
      || child.classList.contains('tool-call-container')
    );
    const visibleContent = Array.from(content.children).some((child) => {
      if (child.classList.contains('markdown-body')) {
        return String(child.textContent || '').trim().length > 0;
      }
      if (child.classList.contains('reasoning-block')) {
        return !child.classList.contains('process-hidden')
          && !child.classList.contains('process-cv-hidden');
      }
      if (child.classList.contains('tool-call-container')) {
        return !child.classList.contains('process-hidden')
          && !child.classList.contains('process-cv-hidden');
      }
      return child.offsetParent !== null;
    });

    // In show-process mode, a far process-only row is still a real layout
    // row: its children use content-visibility and retain intrinsic height.
    // Treating those children as invisible here adds process-hidden-empty and
    // removes the row from layout, which invalidates the viewport model.
    const shouldHideEmptyRow = chatSurface.showChatProcess
      ? !hasProcessChild && !visibleContent
      : !visibleContent;
    row.classList.toggle('process-hidden-empty', shouldHideEmptyRow);
  }
}

export function applyConversationProcessState(root = domRefs.container, fromIndex = 0) {
  if (chatSurface.showChatProcess) {
    // Show mode: applyProcessDistance handles the windowing. Incremental
    // calls (append/patch with fromIndex > 0) only touch tail rows.
    applyProcessDistance(root, fromIndex);
  } else {
    // Hide mode: hide ALL process elements
    clearProcessDistance(root);
  }

  syncAssistantProcessOnlyRows(root, fromIndex);
  if (!chatSurface.showChatProcess) {
    // Hide mode: safe to sync all (most rows are display:none, early-return)
    // 桥接期：定义域 chat-renderer（聊天渲染域收敛时改 import）。
    window.syncCollapseStates(root);
  }
  // Show mode: skip syncCollapseStates entirely — it reads scrollHeight
  // on all 1,427 rows causing layout thrashing (27s).
  // Collapse is handled lazily by _applyWindow's Phase 2 for revealed rows.
  // 桥接期：定义域 input-helpers（首屏同步实现，随该文件的消费方收敛）。
  window.updateChatProcessToggle();
  // 桥接期：定义域 runtime-status（运行时状态域收敛时改 import）。
  if (typeof window.ensureChatRuntimeIndicator === 'function') window.ensureChatRuntimeIndicator();
}

export function toggleChatProcessVisibility() {
  const container = domRefs.container;
  const chatViewportTopBefore = container.scrollTop;
  // 与 shouldShowChatWelcome 同口径：user 与 assistant 消息都没有（纯 system
  // 前缀）时，隐藏过程模式呈现欢迎页——过程可见性切换是欢迎页 ↔ 正文的切换，
  // 必须全量重渲染。接续会话（system 注入 + assistant 输出、无 user）两种
  // 模式都有正文行，走 CSS 类切换并保留滚动锚点。
  const hasConversationRows = Array.isArray(currentMessages)
    && currentMessages.some(m => m.role === 'user' || m.role === 'assistant');

  // Anchor-based scroll preservation: record the topmost visible row and
  // its offset from the viewport top. After the toggle changes row heights,
  // we restore scroll so that the same row stays at the same screen position.
  // This is more accurate than preserveTop (absolute scrollTop) because rows
  // above the viewport grow/shrink when process blocks show/hide.
  let anchorIdx = -1;
  let anchorOffsetInViewport = 0;
  if (hasConversationRows) {
    const rows = container.querySelectorAll('.message-row');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.classList.contains('process-hidden') ||
          row.classList.contains('process-hidden-empty')) continue;
      const rowTop = row.offsetTop;
      const rowBottom = rowTop + row.offsetHeight;
      if (rowBottom > chatViewportTopBefore) {
        anchorIdx = i;
        anchorOffsetInViewport = chatViewportTopBefore - rowTop;
        break;
      }
    }
  }

  chatSurface.showChatProcess = !chatSurface.showChatProcess;
  saveChatProcessVisibility();

  // Before un-hiding process elements, record the viewport position so
  // applyProcessDistance can window correctly without triggering a full layout.
  if (chatSurface.showChatProcess && hasConversationRows) {
    precomputeViewportIdx();
  }

  // When there are no conversation rows (system-only prefix), toggling process
  // visibility switches between the welcome page and the (hidden-process)
  // content. This requires a full re-render, not just CSS class toggling.
  if (!hasConversationRows) {
    setLastRenderedChatSig('');
    // 桥接期：定义域 chat-renderer（聊天渲染域收敛时改 import）。
    window.render(currentMessages);
  } else {
    applyConversationProcessState(container);
  }

  // Follow mode has one authoritative scroll operation: the viewport
  // mutation settlement below. Restoring the old anchor first creates a
  // visible intermediate position, which is immediately overwritten by the
  // process-toggle follow snap. Anchor restoration is only for readers who
  // are intentionally not following the latest message.
  if (!chatSurface.followLatestEnabled && anchorIdx >= 0) {
    const rows = container.querySelectorAll('.message-row');
    for (let i = anchorIdx; i < rows.length; i++) {
      const row = rows[i];
      if (row.classList.contains('process-hidden') ||
          row.classList.contains('process-hidden-empty')) continue;
      container.scrollTop = row.offsetTop + anchorOffsetInViewport;
      break;
    }
  }

  // 桥接期：定义域 chat-viewport（视口域收敛时改 import）。
  window.notifyChatViewportMutation({
    reason: 'process-toggle',
    shouldFollow: chatSurface.followLatestEnabled && window.isChatSurfaceActive(),
    forceSnap: true,
    allowChase: false,
  });
}

// 函数键按值转发：classic 侧若整体替换该全局（诊断 / 测试接管），语义与原顶层
// function 声明一致——后续裸调命中替换后的实现。
const bridgeValues = { applyConversationProcessState, toggleChatProcessVisibility };

window.KernelState.defineKey('chat-process-visibility', 'applyConversationProcessState', applyConversationProcessState);
window.KernelState.defineKey('chat-process-visibility', 'toggleChatProcessVisibility', toggleChatProcessVisibility);
window.KernelState.claim('chat-process-visibility', {
  get(key) {
    return bridgeValues[key];
  },
  set(key, value) {
    bridgeValues[key] = value;
  },
});
