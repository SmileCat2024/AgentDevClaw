/**
 * Rotation Strategy Resolver — 接续策略解析（声明驱动三选一的读侧）
 *
 * 生效值判定链（设计定案 2026-10-18，与通知设置同构）：
 *   用户覆盖（workspace-settings resourcePolicy）> 作者默认（metadata
 *   permissionDefaults）> null（未声明 → 维持组合 trim+摘要语义）。
 *
 * 策略在 rotate() 时现读：改配置对下一次接力即时生效，无需重启。
 * 读侧异常（覆盖读取失败 / 扫描失败）按未声明回退组合语义，不因配置
 * 读取失败挂掉接力；非法覆盖值不在本层校验——保存侧（权限项枚举）已
 * 拦截，读侧遇未知值时消费方（buildRotationHandoffOptions）兜底组合。
 *
 * 依赖注入（server.js 装配）：readPolicies = readWorkspaceResourcePolicies、
 * readDeclaredAgents = discoverAgents(AGENTS_ROOT)。本模块零依赖，测试
 * 注入 stub 数据即可覆盖判定链全分支。
 */

export function buildRotationStrategyResolver({
  readPolicies,
  readDeclaredAgents,
} = {}) {
  if (typeof readPolicies !== 'function' || typeof readDeclaredAgents !== 'function') {
    throw new Error('buildRotationStrategyResolver requires readPolicies and readDeclaredAgents functions');
  }
  return async function resolveRotationStrategy(agentId) {
    try {
      const policies = await readPolicies();
      const override = policies?.[agentId]?.contextRotationStrategy;
      if (typeof override === 'string' && override) return override;
    } catch (error) {
      console.warn('[thread-rotation] strategy override read failed:', error?.message || error);
    }
    try {
      const declared = await readDeclaredAgents();
      const authorDefault = declared.find((item) => item.id === agentId)?.permissionDefaults?.contextRotationStrategy;
      if (typeof authorDefault === 'string' && authorDefault) return authorDefault;
    } catch { /* 扫描失败按未声明（组合语义）兜底 */ }
    return null;
  };
}
