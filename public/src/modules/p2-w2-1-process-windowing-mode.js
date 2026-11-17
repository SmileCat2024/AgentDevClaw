/**
 * P2 第二波批次 1：process 窗口分级模式标志（本批两个 chat 模块共享的上游状态）。
 *
 * 归属：原 `lazy-tool-content.js` 的顶层 `var _windowingDisabled / _windowingFrozen`。
 * 为什么单列一个哑状态模块（无行为、无桥、无副作用）：
 *   - 写入方唯一：lazy-tool-content 的 `setProcessWindowingDisabled()` /
 *     `freezeProcessWindowing()` / `unfreezeProcessWindowing()`（与迁移前一致）；
 *   - 读取方：lazy-tool-content（自身窗口逻辑）与 chat-row-visibility（整行实测
 *     窗口只在全渲染分级、未冻结时生效）；
 *   - 两个模块互为数据依赖（lazy-tool-content 调 chat-row-visibility 的
 *     refreshMeasuredChatRows / clearMeasuredChatRows），把标志留在任一实现
 *     模块都会形成 import 环；环在「桥键唯一注册制 + 测试按唯一 query 重装」
 *     下会让同一文件出现两个实例，故按「共同上游状态」单列本模块断开环。
 *
 * 语义与迁移前完全相同：两个布尔值，初始均为 false，读写不做任何归一化之外
 * 的加工（setProcessWindowingDisabled 的 `!!disabled` 归一化留在原处）。
 * 本模块是 P3 的合并候选：两个消费模块的窗口逻辑收敛后可直接并入其中一方。
 */
export const processWindowingMode = {
  /** true = 全渲染分级（跳过估算窗口，由 chat-row-visibility 实测整行管理）。 */
  disabled: false,
  /** true = 面板拖动期间冻结（scroll 链不写 scrollTop，释放后一次 settle）。 */
  frozen: false,
};
