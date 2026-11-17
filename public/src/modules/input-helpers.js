/**
 * input-helpers.js — 过程显隐按钮同步（classic 首屏实现）。
 * 从 app-main.js 域 AB 提取（2026-07-04），P2 输入面收尾批次只留 R1 首屏实现。
 *
 * 为什么只剩这一个函数（时序审计，真实可达链）：
 *   `app-main` 顶层 `applyTheme → applyLanguage → renderCurrentMainView` 在
 *   deferred 模块执行之前同步运行，app-ui 的三个分支（workspace surface /
 *   空消息欢迎态 / 正文渲染）都会在 `typeof updateChatProcessToggle === 'function'`
 *   守卫后调用它。因此它是本文件唯一的**真实 R1** 键，必须保持 classic 唯一实现，
 *   不能改 import、不能复制第二实现、不能延迟到模块就绪后再跑（会把首屏按钮
 *   文案/显隐推到认证之后）。
 *
 * 已迁出的实现（消费方经 import 或 ESM 相桥键取用，本文件不再重复实现）：
 *   - 动作提交与回退/压缩动作可用性（submitInputAction / getPrimaryInputRequest /
 *     requestSupportsAction / getRollbackInputRequest / canRollbackMessage /
 *     updateRollbackActionVisibility）＋ autoResize ＋ newIdempotencyKey
 *     → `input-actions.js`（桥键 domain `input-actions`）
 *   - 过程内容显隐（applyConversationProcessState / saveChatProcessVisibility /
 *     syncAssistantProcessOnlyRows / window.toggleChatProcessVisibility）
 *     → `chat-process-visibility.js`（桥键 domain `chat-process-visibility`）
 *
 * 依赖（classic 全局，与原实现一致）：
 *   chatProcessToggle（app-core 的 DOM 引用）、showChatProcess（聊天表面状态）、
 *   shouldRenderWorkspaceSurface（app-ui）、t（i18n）。
 */

function updateChatProcessToggle() {
  if (!chatProcessToggle) return;
  // 聊天界面常驻显示：数据未到位也不隐藏，与 chat-context-bar 同一显隐
  // 逻辑（非聊天界面时隐藏），避免加载期间按钮出现/消失的布局跳动。
  const show = !shouldRenderWorkspaceSurface();
  chatProcessToggle.classList.toggle('hidden', !show);
  if (!show) return;
  chatProcessToggle.classList.toggle('active', showChatProcess);
  chatProcessToggle.textContent = showChatProcess ? t('hide_process') : t('show_process');
}
