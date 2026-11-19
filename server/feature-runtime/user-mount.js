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

import { workspaceFeatureRepositoryRoot } from '../shared/constants.js';
import { resolveCatalogPackage, scanFeatureCatalog } from './catalog.js';
import { provisionRuntimeEnvironment } from './provisioner.js';
import { mountResolvedFeatures } from './loader.js';
import { resolvePluginSettings } from './plugin-settings.js';

/**
 * 补本空间私有仓库根（ADR-0046 空间级仓库）：装配身份既可用全局两仓，
 * 也可用 `workspaces/<agentId>/features/` 里只有它可见的包。调用方显式注入的
 * workspaceRoots 优先（测试隔离）。
 */
function catalogRootsForIdentity(agentId, catalogRoots) {
  // 显式注入（测试隔离）时原样使用，不读真实用户目录；生产路径按身份补根
  if (catalogRoots) return catalogRoots;
  return agentId ? { workspaceRoots: { [agentId]: workspaceFeatureRepositoryRoot(agentId) } } : {};
}

/**
 * mounts（Map<runtimeName, {package, version}>）→ catalog 解析 + runtime plan。
 * 启动挂载链、install-service（商店安装/环境重建/envReady 探测）三处共用，
 * 保证 plan 构造（尤其 agent.id 格式与依赖集）严格同构——环境 hash 才一致。
 * config 不参与 dependency hash，此函数不带配置值；挂载链在返回的 features
 * 上按 agent 配置树补 config（见 mountUserConfiguredFeatures）。
 */
export async function buildUserMountPlan({ mounts, agentId, catalogRoots }) {
  // 装配身份可见 = 全局两仓 + 本空间私有仓（ADR-0046 空间级仓库）
  const catalog = await scanFeatureCatalog(catalogRootsForIdentity(agentId, catalogRoots));
  const features = [];
  for (const [runtimeName, mount] of mounts) {
    const archive = resolveCatalogPackage(catalog, {
      packageName: mount.package,
      version: mount.version,
      allowLatest: false,
      agentId,
    });
    // 多 feature 包（ADR-0046 2026-11-19 第三批）：一个 $mount 声明展开为多个
    // 运行时 feature，彼此独立实例、独立配置键（= 声明 name）；装卸仍以包为单位。
    if (Array.isArray(archive.manifestFeatures) && archive.manifestFeatures.length > 0) {
      // feature 级禁用（ADR-0052）：包仍装配，被禁用的实例不进入装配计划；
      // 配置、面板与数据面按包保留，重新启用只改声明、不重装环境
      const disabled = new Set(mount.disabledFeatures || []);
      for (const declared of archive.manifestFeatures) {
        if (disabled.has(declared.name)) continue;
        const entry = declared.entry || archive.entry;
        features.push({
          package: mount.package,
          version: archive.version,
          runtimeName: declared.name,
          resolvedFrom: 'repository',
          archivePath: archive.archivePath,
          archiveDigest: archive.archiveDigest,
          entry,
          ...((declared.export || archive.export) ? { export: declared.export || archive.export } : {}),
          source: archive.source,
        });
      }
      continue;
    }
    // 单 feature 包不存在可单独禁用的实例：声明 disabledFeatures 属配置错误，
    // fail fast 提示改用包级 enabled:false（避免"禁用不生效"的静默误解）
    if (Array.isArray(mount.disabledFeatures) && mount.disabledFeatures.length > 0) {
      throw new Error(
        `Feature 包 ${mount.package}@${mount.version} 没有声明 manifest.features（单 feature 包），`
        + `不支持 $mount.disabledFeatures；如需整体下线请用 $mount.enabled: false。`,
      );
    }
    features.push({
      package: mount.package,
      version: archive.version,
      runtimeName,
      resolvedFrom: 'repository',
      archivePath: archive.archivePath,
      archiveDigest: archive.archiveDigest,
      entry: archive.entry,
      ...(archive.export ? { export: archive.export } : {}),
      source: archive.source,
    });
  }
  return {
    catalog,
    plan: {
      schemaVersion: 1,
      mode: 'release',
      agent: { id: `${agentId}:user-mounts` },
      features,
    },
  };
}

/**
 * @param {object} agent 已构造完毕的 agent 实例（静态装配 + super 已完成）
 * @param {Map<string, {package: string, version: string, layerId: string}>} mounts
 * @param {{agentId: string, catalogRoots?: object, environmentRoot?: string}} options
 *   catalogRoots / environmentRoot 是测试隔离注入口（透传 scanFeatureCatalog /
 *   provisionRuntimeEnvironment 的同名参数），生产调用不传。
 * @returns {Promise<Array<{package: string, name: string, resolvedFrom: string, entry: string}>>}
 * @throws 解析失败（仓库无此包/版本）、安装失败、同名冲突时抛错——装配是用户
 *   显式声明，启动 fail fast，不静默降级。
 */
export async function mountUserConfiguredFeatures(agent, mounts, {
  agentId,
  catalogRoots,
  environmentRoot,
} = {}) {
  if (!(mounts instanceof Map) || mounts.size === 0) return [];
  if (!agentId) throw new Error('mountUserConfiguredFeatures requires agentId.');

  const { plan, catalog } = await buildUserMountPlan({ mounts, agentId, catalogRoots });
  const projections = new Map();
  for (const feature of plan.features) {
    if (!projections.has(feature.archivePath)) {
      const archive = catalog.packages.get(feature.package).find((entry) => entry.archivePath === feature.archivePath);
      projections.set(feature.archivePath, archive.pluginSettings
        ? resolvePluginSettings(archive, agent.pluginSettingsLayers).features : null);
    }
    const projection = projections.get(feature.archivePath)?.get(feature.runtimeName);
    if (projection) {
      feature.config = { ...agent.config?.features?.[feature.runtimeName], ...projection };
      feature.projectedConfig = true;
      continue;
    }
    const configValue = agent.config?.features?.[feature.runtimeName];
    if (configValue && typeof configValue === 'object' && Object.keys(configValue).length > 0) {
      feature.config = configValue;
    }
  }
  const environment = await provisionRuntimeEnvironment({ plan, root: environmentRoot });
  const mounted = await mountResolvedFeatures(agent, plan, { environmentDir: environment.environmentDir });
  // 配置树键 = 装配计划里的 runtimeName（单 feature 包 = $mount 键，多 feature 包 =
  // manifest.features[].name）。实例 name 与计划不一致说明配置会静默丢失、面板
  // 展示名失真——fail fast 让用户修正声明。
  const declaredNames = new Set(plan.features.map((feature) => String(feature.runtimeName || '')));
  for (const item of mounted) {
    if (!declaredNames.has(item.name)) {
      const declaredKey = [...mounts.entries()].find(([, mount]) => mount.package === item.package)?.[0];
      throw new Error(
        `Feature 包 ${item.package} 的实例 name 是 '${item.name}'，与装配声明的键 '${declaredKey || '(未知)'}' 不一致；请以实例 name 作为 $mount 的键（多 feature 包用 manifest.features[].name）。`,
      );
    }
  }
  return mounted;
}
