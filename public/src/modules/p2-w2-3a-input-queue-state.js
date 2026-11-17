/**
 * p2-w2-3a-input-queue-state.js — 输入面排队投影状态 owner（P2 第二波 3a）。
 *
 * 域：`input-queue`。owner 唯一物理持有方是这里的模块绑定（`export let` 是
 * 活绑定：ESM 消费方 import 后读到的是当前值）；classic 消费方经
 * KernelState 访问器读写，读写语义与原顶层 `let` 完全一致。
 *
 * 为什么这些键仍要注册访问器（注册行在 classic 相）：
 *   首屏同步链 `app-main` 顶层 applyLanguage → renderCurrentMainView →
 *   notifyInputSurfaceChanged → renderInputRequests（classic input-render.js）
 *   → `rebindQueueProjectionForRuntime`（classic，首屏即调用）与
 *   `getInputSurfaceMode → readInputSurfaceModeState`（classic，读
 *   `_localQueuedInputPending` / `_pendingQueuedCount` / `_queuedTexts`）。
 *   这些读取发生在 deferred 模块执行之前，键必须在 classic 相就带真初值可用；
 *   因此 defineKey 留在 persistent-input.js 原声明位置，本 owner 在 ESM 相
 *   claim 时吸收其现值（无双存储）。
 *
 * 逐键消费证据（grep public/，排除定义方；详见批次交付报告）：
 *   - `_pendingQueuedCount` ← input-composer.js（readInputSurfaceModeState）、
 *     runtime-status.js（call.finish / step_start 归零）
 *   - `_queuedTexts`         ← input-composer.js（readInputSurfaceModeState）、
 *     runtime-status.js
 *   - `_localQueuedInputPending` ← input-composer.js（readInputSurfaceModeState）
 *   - `_lastQueueBubbleSignature` ← input-composer.js（detachTransientInputContent
 *     清理气泡后重置签名，跨文件写）
 *   - `_queuedProjectionRuntimeId` ← persistent-input.js 的
 *     `rebindQueueProjectionForRuntime`（classic 首屏边界）与
 *     p2-w2-3a-queue-projection.js 的写入路径共享同一归属判定
 *   注销条件：上述 classic 消费方（input-composer / runtime-status /
 *   persistent-input / app-main）迁到 ESM 并改为 import 之后。
 *
 * 函数键（`_renderQueueBubbles` 等 behavior 桥键）也落在这个域的 owner 里：
 * 域内既持有状态也持有本域 API 引用，避免状态与 API 分属两个 claim。
 */

export let pendingQueuedCount = 0;
export let queuedTexts = [];
export let localQueuedInputPending = false;
export let lastQueueBubbleSignature = '';
export let queuedProjectionRuntimeId = null;

export const setPendingQueuedCount = (value) => { pendingQueuedCount = value; };
export const setQueuedTexts = (value) => { queuedTexts = value; };
export const setLocalQueuedInputPending = (value) => { localQueuedInputPending = value; };
export const setLastQueueBubbleSignature = (value) => { lastQueueBubbleSignature = value; };
export const setQueuedProjectionRuntimeId = (value) => { queuedProjectionRuntimeId = value; };

/**
 * 队列投影清空（语义 clear）：气泡文本、待发送计数、本地乐观态与渲染签名
 * 一起归零。**不动** `queuedProjectionRuntimeId`——投影归属身份（哪个 runtime
 * 的队列）由调用方按会话切换自行重绑，清空不等同于换绑。
 */
export const clearQueuedInputProjection = () => {
  pendingQueuedCount = 0;
  queuedTexts = [];
  localQueuedInputPending = false;
  lastQueueBubbleSignature = '';
};

const KEY_GETTERS = {
  _pendingQueuedCount: () => pendingQueuedCount,
  _queuedTexts: () => queuedTexts,
  _localQueuedInputPending: () => localQueuedInputPending,
  _lastQueueBubbleSignature: () => lastQueueBubbleSignature,
  _queuedProjectionRuntimeId: () => queuedProjectionRuntimeId,
};

const KEY_SETTERS = {
  _pendingQueuedCount: setPendingQueuedCount,
  _queuedTexts: setQueuedTexts,
  _localQueuedInputPending: setLocalQueuedInputPending,
  _lastQueueBubbleSignature: setLastQueueBubbleSignature,
  _queuedProjectionRuntimeId: setQueuedProjectionRuntimeId,
};

// 认领后补注册的函数键（behavior 桥键）落这里：它们与状态同域，但不需要
// typed setter（值是函数引用，原样转发）。
const apiKeys = new Map();

window.KernelState.claim('input-queue', {
  get(key) {
    const getter = KEY_GETTERS[key];
    if (getter) return getter();
    return apiKeys.get(key);
  },
  set(key, value) {
    const setter = KEY_SETTERS[key];
    if (setter) { setter(value); return; }
    apiKeys.set(key, value);
  },
});
