/**
 * p2-w2-3a-composer-state.js — 常驻 composer 草稿缓存状态 owner（P2 第二波 3a）。
 *
 * 域：`input-composer`。唯一可变键 `_sessionInputCache`（`{ cacheKey: text }`，
 * 按会话隔离的草稿缓存）。input-composer.js 本轮未整体转 ESM（首屏同步边界，
 * 见批次交付报告），草稿缓存的读写仍由它的 classic 函数承担，但状态唯一
 * owner 是本模块：defineKey 留在 input-composer.js 原声明位置（classic 相
 * 必须带真初值——首屏 `renderInputRequests` → `_applyLeaseInitialDraft` 会
 * 读它），ESM 相 claim 吸收现值。
 *
 * 逐键消费证据（grep public/，排除定义方）：
 *   - `_sessionInputCache` ← persistent-input.js（提交成功按会话键删草稿）、
 *     input-render.js（lease 草稿回填判定）、voice-input.js（ASR 注入后回写）、
 *     input-helpers.js、app-chat-input.js（快记条）
 *   注销条件：上述 classic 消费方迁 ESM 后改 import。
 *
 * `_composerCard`（单例 DOM 引用）与 `_attachMenuEl`（附件菜单节点）零跨文件
 * 消费方，按配方留在 input-composer.js 的模块作用域，不上桥。
 */

export let sessionInputCache = {};

export const setSessionInputCache = (value) => { sessionInputCache = value; };

/**
 * 语义 clear：发送成功后按**发送时刻捕获**的会话键删掉该会话草稿，不误伤其他
 * 会话的草稿（与 persistent-input 提交路径同语义）。空键是 no-op。
 */
export const clearSessionInputDraft = (cacheKey) => {
  if (typeof cacheKey !== 'string' || !cacheKey) return false;
  if (!Object.prototype.hasOwnProperty.call(sessionInputCache, cacheKey)) return false;
  delete sessionInputCache[cacheKey];
  return true;
};

window.KernelState.claim('input-composer', {
  get(key) {
    if (key === '_sessionInputCache') return sessionInputCache;
    return undefined;
  },
  set(key, value) {
    if (key === '_sessionInputCache') setSessionInputCache(value);
  },
});
