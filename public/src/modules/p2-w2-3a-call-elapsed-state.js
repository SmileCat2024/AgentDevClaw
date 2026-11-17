/**
 * p2-w2-3a-call-elapsed-state.js — 上次对话结束时间状态 owner（P2 第二波 3a）。
 *
 * 域：`input-call-elapsed`。唯一可变键 `_lastCallFinishTime`（毫秒时间戳，
 * 0 = 本轮还没有结束时间）。classic 侧由 persistent-input.js 的
 * `_renderLastCallElapsed`（1s tick 读取）与 `resetCallElapsedForSwitch`
 * （会话切换归零）读写，runtime-status.js 在 call.finish 帧写入；三处都在
 * boot 之后，但 1s tick 在 classic 相已开始运行——键必须在 classic 相带真
 * 初值可用，因此 defineKey 留在 persistent-input.js 原声明位置，本 owner
 * 在 ESM 相 claim 时吸收现值。
 *
 * 逐键消费证据（grep public/，排除定义方）：
 *   - `_lastCallFinishTime` ← runtime-status.js（call.finish 写入时间戳）、
 *     app-ui.js（输入面胶囊可读性判定）。runtime-status 是本轮之后要迁 ESM
 *     的批次（W2-2），届时直接 import 本模块的活绑定 + setter。
 *   注销条件：runtime-status / app-ui / persistent-input 的 classic 消费方
 *   全部改 import 之后。
 *
 * 同一域内 `_runCapsuleStartAt` / `_runCapsuleStartConfirmed` 未迁：它们只有
 * 本域读者（`_renderLastCallElapsed` 与 reset），零跨文件消费面，按配方
 * 「消费面为零 → 保持模块私有」留在 classic 文件里。
 */

export let lastCallFinishTime = 0;

export const setLastCallFinishTime = (value) => { lastCallFinishTime = value; };

/** 语义 clear：会话切换/无焦点时把结束时间归零（与 resetCallElapsedForSwitch 同语义）。 */
export const clearLastCallFinishTime = () => { lastCallFinishTime = 0; };

window.KernelState.claim('input-call-elapsed', {
  get(key) {
    if (key === '_lastCallFinishTime') return lastCallFinishTime;
    return undefined;
  },
  set(key, value) {
    if (key === '_lastCallFinishTime') setLastCallFinishTime(value);
  },
});
