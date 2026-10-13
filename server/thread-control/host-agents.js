/**
 * 线程宿主判定 — 唯一权威定义。
 *
 * 回答「哪个 APP 的新会话自动建立线程环境」。判定是 APP 级的（ADR-0025）：
 * 宿主 APP 的会话即线程宿主；会话不再携带身份标记——归属即身份。
 *
 * 宿主集合由声明驱动（ADR-0024 可拔插验收约束：公共代码不按 APP ID
 * 硬编码）：APP 在 metadata.json 声明 `threadHost: true`，宿主（server）
 * 启动发现后经 registerThreadHostAgents 注入本模块。该定义放在独立的
 * 零依赖轻量模块：server 侧 thread-control 消费方需要同源引用判定，
 * 但不能因此把 server 侧初始化链拉进来。所有消费方一律从本模块
 * import，禁止复制判定。
 */

/** 线程宿主 APP 集合（APP 级闸门；内容由宿主按 metadata 声明注册派生）。 */
export const THREAD_HOST_AGENT_IDS = new Set();

/**
 * 注册线程宿主 APP 集合（替换式、幂等）。宿主启动时按 agents metadata
 * 的 `threadHost` 声明派生注入；测试可直接注册构造场景。
 */
export function registerThreadHostAgents(agentIds) {
  THREAD_HOST_AGENT_IDS.clear();
  for (const id of Array.isArray(agentIds) ? agentIds : []) {
    const normalized = String(id || '').trim();
    if (normalized) THREAD_HOST_AGENT_IDS.add(normalized);
  }
}

/**
 * 判定某个会话是否为线程宿主：新会话创建时自动建立线程环境。
 * 只看会话所属 APP，不看会话自身字段。
 */
export function isThreadHostSession(agentId) {
  return THREAD_HOST_AGENT_IDS.has(String(agentId || '').trim());
}
