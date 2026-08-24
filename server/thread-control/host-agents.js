/**
 * 线程宿主判定 — 唯一权威定义。
 *
 * 回答「哪个 (工作空间, 会话类型) 组合的新会话自动建立线程环境」。
 * 判定是会话级的：coder 并入 programming-helper 工作空间后，同一工作空间内
 * 只有 sessionType='coder' 的会话是线程宿主；main 会话是纯会话，不建线程。
 *
 * 该定义放在独立的零依赖轻量模块：server 侧 thread-control 消费方与
 * agent 子进程需要同源引用判定，但不能因此把 server 侧初始化链拉进子进程。
 * 所有消费方一律从本模块 import，禁止复制判定。
 */

/** 允许线程宿主会话存在的工作空间集合（agent 级闸门）。 */
export const THREAD_HOST_AGENT_IDS = new Set(['programming-helper']);

/** 线程宿主会话类型集合（会话级闸门，与工作空间闸门同时满足才成立）。 */
export const THREAD_HOST_SESSION_TYPES = new Set(['coder']);

/**
 * 判定某个会话是否为线程宿主：新会话创建时自动建立线程环境。
 * agentId 与 sessionType 缺一不可——只满足其一都不是宿主。
 */
export function isThreadHostSession(agentId, sessionType) {
  if (!THREAD_HOST_AGENT_IDS.has(String(agentId || '').trim())) return false;
  return THREAD_HOST_SESSION_TYPES.has(String(sessionType || '').trim());
}
