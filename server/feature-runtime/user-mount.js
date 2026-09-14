/**
 * 用户 $mount 装配的动态挂载（宿主挂载钩子的装配链消费端）
 *
 * 输入是 agent 构造期提取的 pendingFeatureMounts（Map<runtimeName,
 * {package, version, layerId}>，见 shared/feature-mount.js），在官方 agent
 * 静态装配完成后追加挂载：scanFeatureCatalog → resolveCatalogPackage →
 * 合成 runtime plan → provisionRuntimeEnvironment（内容寻址依赖环境）→
 * mountResolvedFeatures（同名冲突检测 + static inject 拓扑排序内建）。
 *
 * 追加挂载场景没有 agent 入口要跑：plan 不带 agent.root/entry，provisioner
 * 跳过 agent 源码拷贝。配置值从 agent 侧合并树（$mount 键名下，$mount 键已
 * 剔除）读入 plan.features[].config，保证 Feature 构造参数正确；loader 的
 * onInitiate 别名逻辑发现该键已存在即跳过，两条路径语义一致。
 */

import { resolveCatalogPackage, scanFeatureCatalog } from './catalog.js';
import { provisionRuntimeEnvironment } from './provisioner.js';
import { mountResolvedFeatures } from './loader.js';

/**
 * @param {object} agent 已构造完毕的 agent 实例（静态装配 + super 已完成）
 * @param {Map<string, {package: string, version: string, layerId: string}>} mounts
 * @param {{agentId: string, sessionType?: string, catalogRoots?: object, environmentRoot?: string}} options
 *   catalogRoots / environmentRoot 是测试隔离注入口（透传 scanFeatureCatalog /
 *   provisionRuntimeEnvironment 的同名参数），生产调用不传。
 * @returns {Promise<Array<{package: string, name: string, resolvedFrom: string, entry: string}>>}
 * @throws 解析失败（仓库无此包/版本）、安装失败、同名冲突时抛错——装配是用户
 *   显式声明，启动 fail fast，不静默降级。
 */
export async function mountUserConfiguredFeatures(agent, mounts, {
  agentId,
  sessionType = 'main',
  catalogRoots,
  environmentRoot,
} = {}) {
  if (!(mounts instanceof Map) || mounts.size === 0) return [];
  if (!agentId) throw new Error('mountUserConfiguredFeatures requires agentId.');

  const catalog = await scanFeatureCatalog(catalogRoots);
  const features = [];
  for (const [runtimeName, mount] of mounts) {
    const archive = resolveCatalogPackage(catalog, {
      packageName: mount.package,
      version: mount.version,
      allowLatest: false,
    });
    const configValue = agent.config?.features?.[runtimeName];
    features.push({
      package: mount.package,
      version: archive.version,
      runtimeName,
      ...(configValue && typeof configValue === 'object' && Object.keys(configValue).length > 0
        ? { config: configValue }
        : {}),
      resolvedFrom: 'repository',
      archivePath: archive.archivePath,
      archiveDigest: archive.archiveDigest,
      entry: archive.entry,
      source: archive.source,
    });
  }

  const plan = {
    schemaVersion: 1,
    mode: 'release',
    agent: { id: `${agentId}:${sessionType}:user-mounts` },
    features,
  };
  const environment = await provisionRuntimeEnvironment({ plan, root: environmentRoot });
  return mountResolvedFeatures(agent, plan, { environmentDir: environment.environmentDir });
}
