/**
 * p2-w2-3a-recap-state.js — 离开摘要（recap）状态 owner（P2 第二波 3a）。
 *
 * 域：`recap-hint`。recap-hint.js 本轮整体转 ESM，状态唯一 owner 是本模块；
 * 行为模块 import 这里的活绑定与 setter，不再各自持有一份。
 *
 * 注册相位（ESM 相，本文件内）与其它三个输入面域不同：recap 的键在 classic
 * 相没有任何触达点——首屏同步链只走 `renderInputRequests` 的 hidden 分支，
 * `_renderRecapHint` / `_clearRecapForNewMessage` / `_trackRecapSessionPresence`
 * 分别由持久输入面渲染、消息提交、轮询调用，全部晚于 deferred 模块执行；
 * runtime-status（classic）读写 `_recapPendingTrigger` 也在通知状态更新里，
 * 属 boot 之后。因此该跨文件键由本 owner 在 ESM 相注册后立即 claim，
 * 不需要 classic 相预注册。
 *
 * 逐键消费证据（grep public/，排除定义方）：
 *   - `_recapPendingTrigger` ← runtime-status.js（call.finish 后补触发 recap）
 *   注销条件：runtime-status 改 import 之后。
 *
 * `_currentRecapText` 的桥已注销：agent-data-loader 已改 import 本模块的
 * `clearRecapForNewMessage` / setter，window 上零消费方。
 *
 * 其余四个键（`_recapLastSeenBySession` / `_recapShownForSession` /
 * `_recapDismissedForSession` / `_recapFetchInFlight`）零跨文件生产消费方，
 * 只在本 owner 与 recap-hint.js 之间流动，因此只做命名导出，不上桥。
 */

export let currentRecapText = '';
export let recapPendingTrigger = false;
export let recapFetchInFlight = false;
export let recapLastSeenBySession = {};   // sessionKey → 最后活跃时间戳
export let recapShownForSession = new Set();
export let recapDismissedForSession = new Set();

export const setCurrentRecapText = (value) => { currentRecapText = value; };
export const setRecapPendingTrigger = (value) => { recapPendingTrigger = value; };
export const setRecapFetchInFlight = (value) => { recapFetchInFlight = value; };
export const setRecapLastSeenBySession = (value) => { recapLastSeenBySession = value; };
export const setRecapShownForSession = (value) => { recapShownForSession = value; };
export const setRecapDismissedForSession = (value) => { recapDismissedForSession = value; };

/**
 * 语义 clear（新消息提交）：清掉当前摘要文本与「等忙完再触发」的挂起意图。
 * 这是 agent-data-loader 的 `clearRecap` 回调与 persistent-input 提交成功
 * 路径共同需要的语义，独立于「按会话遗忘已生成/已关闭」的集合维护。
 */
export const clearRecapForNewMessage = () => {
  currentRecapText = '';
  recapPendingTrigger = false;
};

// 认领后补注册的函数键（recap-hint.js 的 behavior 桥键）落这里：与本域状态
// 同一个 owner，值是函数引用，原样转发（同 p2-w2-3a-input-queue-state.js）。
const apiKeys = new Map();

window.KernelState.defineKey('recap-hint', '_recapPendingTrigger', false);

window.KernelState.claim('recap-hint', {
  get(key) {
    switch (key) {
      case '_recapPendingTrigger': return recapPendingTrigger;
      default: return apiKeys.get(key);
    }
  },
  set(key, value) {
    switch (key) {
      case '_recapPendingTrigger': setRecapPendingTrigger(value); break;
      default: apiKeys.set(key, value);
    }
  },
});
