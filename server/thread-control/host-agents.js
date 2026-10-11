/**
 * 线程宿主判定 — 唯一权威定义。
 *
 * 回答「哪个 APP 的新会话自动建立线程环境」。判定是 APP 级的（ADR-0025）：
 * coder APP 的会话即线程宿主；会话不再携带身份标记——归属即身份。
 *
 * 该定义放在独立的零依赖轻量模块：server 侧 thread-control 消费方与
 * agent 子进程需要同源引用判定，但不能因此把 server 侧初始化链拉进子进程。
 * 所有消费方一律从本模块 import，禁止复制判定。
 */

/** 线程宿主 APP 集合（APP 级闸门）。 */
export const THREAD_HOST_AGENT_IDS = new Set(['coder']);

/**
 * 判定某个会话是否为线程宿主：新会话创建时自动建立线程环境。
 * 只看会话所属 APP，不看会话自身字段。
 */
export function isThreadHostSession(agentId) {
  return THREAD_HOST_AGENT_IDS.has(String(agentId || '').trim());
}
