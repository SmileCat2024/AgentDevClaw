/**
 * 静态装配清单消费（ADR-0054）
 *
 * agent.js 导出 `staticFeatureManifest`（数组，序即挂载序），构造函数经本
 * helper 消费：任何构造点都得到完整装配。清单即装配的执行来源——不存在第
 * 二份需要同步的事实；商店（feature-store）直接读清单导出枚举底座，不经
 * 过本模块。
 *
 * fail-fast：清单条目重名、工厂产出 name 与条目键不一致均抛错（取代
 * use() 的 Map 静默覆盖，与宿主挂载 builtin 的同名校验同口径）。
 */

/**
 * @param {import('@agentdevjs/core').Agent} agent 目标 Agent 实例（须已完成 super()）
 * @param {Array<{ name: string, create: (ctx: object) => object }>} manifest 静态装配清单
 * @param {object} ctx 装配上下文：{ workspaceDir, runtimeIdentity, merged, config }
 *   （契约见 ADR-0054；模块级常量由各条目工厂闭包持有，不进 ctx）
 */
export function mountStaticFeatureManifest(agent, manifest, ctx) {
  if (!Array.isArray(manifest)) {
    throw new Error('staticFeatureManifest 必须是数组');
  }
  const seen = new Set();
  for (const entry of manifest) {
    const name = entry?.name;
    if (typeof name !== 'string' || !name) {
      throw new Error('staticFeatureManifest 条目缺少字符串 name');
    }
    if (typeof entry.create !== 'function') {
      throw new Error(`静态装配条目 '${name}' 缺少 create(ctx) 工厂`);
    }
    if (seen.has(name)) {
      throw new Error(`staticFeatureManifest 条目重名：${name}`);
    }
    seen.add(name);
    const instance = entry.create(ctx);
    if (String(instance?.name || '') !== name) {
      throw new Error(`静态装配工厂产出 name '${instance?.name}' 与清单条目 '${name}' 不一致`);
    }
    agent.use(instance);
  }
}
