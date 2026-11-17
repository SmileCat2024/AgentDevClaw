/**
 * input-helpers.js — 过程显隐按钮同步（classic → ESM，P4 T2 批次）。
 *
 * 职责不变：`updateChatProcessToggle` 是过程内容显隐按钮的唯一同步实现。
 * 迁移依据与收敛条件见 [ESM 迁移配方](../../../docs/plans/esm-migration-playbook.md)。
 *
 * 时序（R1/R4）：首屏渲染链已由 `boot.js` 在模块相触发（P4 时序切换提交），
 * 本文件不再需要在 classic 相同步可用；顶层语句只有一次 DOM 查询与桥注册，
 * 模块相执行时 DOM 已解析完毕，与 classic 相语义等价。
 *
 * 跨文件键：`updateChatProcessToggle` 仍被 classic `app-ui`（三处
 * `typeof … === 'function'` 守卫后裸调用）消费，是本批唯一的桥键
 * （domain `input-helpers`）。`chat-process-visibility.js` 早已改用
 * `window.updateChatProcessToggle()`。注销条件：app-ui 迁 ESM 后改为 import。
 *
 * 已迁出的实现（消费方经 import 或 ESM 相桥键取用，本文件不再重复实现）：
 *   - 动作提交与回退/压缩动作可用性（submitInputAction / getPrimaryInputRequest /
 *     requestSupportsAction / getRollbackInputRequest / canRollbackMessage /
 *     updateRollbackActionVisibility）＋ autoResize ＋ newIdempotencyKey
 *     → `input-actions.js`（桥键 domain `input-actions`）
 *   - 过程内容显隐（applyConversationProcessState / saveChatProcessVisibility /
 *     syncAssistantProcessOnlyRows / window.toggleChatProcessVisibility）
 *     → `chat-process-visibility.js`（桥键 domain `chat-process-visibility`）
 */
import { t } from '../i18n.js';
import { chatSurface } from './p2-bootstrap-chat-surface.js';

// DOM 引用原为 app-core 的 classic 顶层 const（全局词法绑定，ESM 侧取不到
// window 属性）→ 模块求值期等价重建查询：元素从不替换，deferred 模块执行时
// DOM 已就绪，取得的是同一节点。dom-refs 域落地后改为 import。
const chatProcessToggle = document.getElementById('chat-process-toggle');

function updateChatProcessToggle() {
  if (!chatProcessToggle) return;
  // 聊天界面常驻显示：数据未到位也不隐藏，与 chat-context-bar 同一显隐
  // 逻辑（非聊天界面时隐藏），避免加载期间按钮出现/消失的布局跳动。
  const show = !window.shouldRenderWorkspaceSurface(); // 桥接期：定义于 app-ui（编排域收敛时移除）
  chatProcessToggle.classList.toggle('hidden', !show);
  if (!show) return;
  // 过程可见性开关是 app-core 的 classic 顶层状态，统一经 chatSurface 宿主适配读写。
  chatProcessToggle.classList.toggle('active', chatSurface.showChatProcess);
  chatProcessToggle.textContent = chatSurface.showChatProcess ? t('hide_process') : t('show_process');
}

export { updateChatProcessToggle };

// 桥（domain `input-helpers`）：classic app-ui 裸调用经访问器取本函数；
// 认领后 classic 侧整体替换（诊断 / 测试接管）同样经 setter 落到本域状态。
const bridgeState = { updateChatProcessToggle };
window.KernelState.defineKey('input-helpers', 'updateChatProcessToggle', bridgeState.updateChatProcessToggle);
window.KernelState.claim('input-helpers', {
  get: (key) => bridgeState[key],
  set: (key, value) => { bridgeState[key] = value; },
});
