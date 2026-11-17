/**
 * P2 第二波批次 1 兼容桥：process 窗口分级 / 整行实测窗口的 classic 消费面。
 *
 * 为什么单列一个 host（而不是在实现模块内 defineKey）：
 *   桥键唯一注册制（kernel-state.js：同一 window 键名只能注册一次）。若注册行
 *   写进实现模块顶层，则「装载实现模块拿全新实例」的测试会二次注册并抛错，
 *   实现模块也不再可重复装载。host 只被装载入口（index.html / kernel-entry）
 *   import 一次，实现模块保持纯 ESM、可任意重装。
 *
 * 桥键逐键消费证据（classic 文件名 + 位置）与注销条件：
 *   lazy-tool-content 域（实现 lazy-tool-content.js）
 *   - clearProcessDistance        ← chat-renderer.js render 分级重估前预隐藏
 *   - freezeProcessWindowing      ← app-ui.js 面板拖动开始
 *   - unfreezeProcessWindowing    ← app-ui.js 面板拖动释放
 *   - runLandingCollapseScan      ← chat-renderer.js render 落位后
 *   - setProcessWindowingDisabled ← chat-renderer.js 按节点预算重估分级
 *   注销条件：上述 chat-renderer / app-ui 迁到 ESM 并改为 import
 *   （视口批次与主视图批次），届时本域整块删除。
 *   已注销：applyProcessDistance / precomputeViewportIdx —— 唯一消费方
 *   chat-process-visibility.js 已 import 命名导出，classic 侧零消费面，桥键撤除
 *   （只保留 lazy-tool-content 的命名导出）。
 *   chat-row-visibility 域（实现 chat-row-visibility.js）
 *   - refreshMeasuredChatRows ← chat-viewport.js `notifyChatViewportMutation`
 *     （`typeof … === 'function'` 可选调用；首屏那一次在无消息行时是 no-op，
 *     故延后到模块执行相注册不改变首屏表现）
 *   - revealMeasuredChatRow   ← chat-renderer.js 行揭示（同上可选调用）
 *   注销条件：chat-viewport / chat-renderer 迁到 ESM 并改为 import。
 *   clearMeasuredChatRows 不在桥上：唯一消费方 lazy-tool-content 已 import。
 *
 * 注册相位：ESM 执行相（本文件被 import 时）。这些键在 classic 相没有触达点
 * ——上面每个消费点都在函数体内，调用时相晚于 deferred 模块执行。
 *
 * 撤除：以上消费方全部迁移后删除本文件（同步删除 index.html / kernel-entry 的
 * 装载行），两个域在 kernel-bridge 基线上归零。
 */
import {
  clearProcessDistance,
  freezeProcessWindowing,
  unfreezeProcessWindowing,
  runLandingCollapseScan,
  setProcessWindowingDisabled,
} from './lazy-tool-content.js';
import {
  refreshMeasuredChatRows,
  revealMeasuredChatRow,
} from './chat-row-visibility.js';

const lazyToolContentBridge = {
  clearProcessDistance,
  freezeProcessWindowing,
  unfreezeProcessWindowing,
  runLandingCollapseScan,
  setProcessWindowingDisabled,
};
window.KernelState.defineKey('lazy-tool-content', 'clearProcessDistance', lazyToolContentBridge.clearProcessDistance);
window.KernelState.defineKey('lazy-tool-content', 'freezeProcessWindowing', lazyToolContentBridge.freezeProcessWindowing);
window.KernelState.defineKey('lazy-tool-content', 'unfreezeProcessWindowing', lazyToolContentBridge.unfreezeProcessWindowing);
window.KernelState.defineKey('lazy-tool-content', 'runLandingCollapseScan', lazyToolContentBridge.runLandingCollapseScan);
window.KernelState.defineKey('lazy-tool-content', 'setProcessWindowingDisabled', lazyToolContentBridge.setProcessWindowingDisabled);
window.KernelState.claim('lazy-tool-content', {
  get: (key) => lazyToolContentBridge[key],
  set: (key, value) => { lazyToolContentBridge[key] = value; },
});

const chatRowVisibilityBridge = { refreshMeasuredChatRows, revealMeasuredChatRow };
window.KernelState.defineKey('chat-row-visibility', 'refreshMeasuredChatRows', chatRowVisibilityBridge.refreshMeasuredChatRows);
window.KernelState.defineKey('chat-row-visibility', 'revealMeasuredChatRow', chatRowVisibilityBridge.revealMeasuredChatRow);
window.KernelState.claim('chat-row-visibility', {
  get: (key) => chatRowVisibilityBridge[key],
  set: (key, value) => { chatRowVisibilityBridge[key] = value; },
});
