/**
 * plugin-ui.js — 插件 UI 面声明合成（ADR-0045 P1 / ADR-0046 可见性合成）
 *
 * 权威链（ADR-0046 决策 2，2026-11-19 修订）：装配层级 = 可见性层级，
 * manifest 的 ui.panels scope 只是作者给的装配建议，不参与可见性裁决：
 *   - 面板可见范围 = 装配它的身份集合（when.agentIds）；默认装配源
 *     （global 层 $mount）按 opt-in 展开为声明 defaultMounts 的身份集合。
 *   - 未装配：面板不下发（含作者标注 scope=global 的面板——导入不等于
 *     可用，与 ADR-0045 决策 5 的旧语义相反，经 0046 修订）。
 *
 * 资产就绪检查：版本目录内 .digest 存在才下发（tgz 手工拷入仓库但未走
 * 导入链路解出 client/ 的包不下发，避免面板按钮指向 404 资产）。
 *
 * 版本选择钉装配版本：多身份/多层级装配不同版本时取装配版本里最高者
 * （catalog 中存在更高版本不跟随——版本策略为精确钉版 + 显式升级，ADR-0046
 * 决策 5），warning 说明多版本并存。
 *
 * 同面板 id 被多个包提供：先到先得 + warning（面板 id 是前端注册表键，
 * 必须全局唯一）。
 */

import { existsSync } from 'fs';
import path from 'path';

import { catalogRootsWithWorkspaceRepositories, isCatalogEntryVisibleTo, scanFeatureCatalog } from './catalog.js';
import { IDENTITY_SCOPES, readDeclaredMounts, readGlobalDeclaredMounts, readEffectiveMounts } from './install-service.js';
import { versionAssetDir, ensureFacetExtracted } from './feature-assets.js';

const SCOPE_VALUES = new Set(['global', 'assembly']);

/** URL / 资产目录共用的包目录段（@scope/name → scope!name，避免路径分隔；@ 不保留）。 */
function packageDirName(packageName) {
  return String(packageName).replace(/^@([^\/]+)\//, '$1!');
}

/** 宽容提取 manifest 面板声明；非法项返回 { error }（调用方收集 warning）。 */
function normalizePanelDeclaration(raw, packageName, version) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `${packageName}@${version} ui.panels 项不是对象` };
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const entry = typeof raw.entry === 'string' ? raw.entry.trim() : '';
  if (!id) return { error: `${packageName}@${version} ui.panels 项缺 id` };
  if (!entry || entry.includes('..')) return { error: `${packageName}@${version} 面板 ${id} 缺 entry 或 entry 含非法段` };
  const scope = typeof raw.scope === 'string' && raw.scope.trim() !== '' ? raw.scope.trim() : 'assembly';
  if (!SCOPE_VALUES.has(scope)) {
    return { error: `${packageName}@${version} 面板 ${id} scope 非法（${scope}，允许 global/assembly）` };
  }
  const label = raw.label && typeof raw.label === 'object' && !Array.isArray(raw.label) ? raw.label : null;
  const description = raw.description && typeof raw.description === 'object' && !Array.isArray(raw.description) ? raw.description : null;
  const icon = typeof raw.icon === 'string' ? raw.icon : '';
  const order = typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : null;
  const surfaces = Array.isArray(raw.when?.surfaces)
    ? raw.when.surfaces.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
    : null;
  return {
    panel: {
      id,
      pluginId: typeof raw.pluginId === 'string' && raw.pluginId.trim() !== '' ? raw.pluginId.trim() : id,
      entry,
      scope,
      ...(label ? { label } : {}),
      ...(description ? { description } : {}),
      ...(icon ? { icon } : {}),
      ...(order !== null ? { order } : {}),
      ...(surfaces ? { surfaces } : {}),
    },
  };
}

/**
 * 读取全部装配事实（默认装配源展开 + 各身份 agent 层）：Map<packageName,
 * Array<{ identity, agentId, version, layerId }>>。
 *
 * 默认装配源（global 层 $mount，ADR-0046 2026-11-19 修订）按 opt-in 展开：
 * 对每个声明 defaultMounts 的身份各记一条（layerId 'global'），不再产出
 * "处处可见"的无主条目——面板/数据面的生效范围 = 声明 opt-in 的身份集合。
 * builtin 挂载无包坐标，不参与（UI 面只能来自仓库包）。
 * 导出供 plugin-server.js（数据面挂载）复用同一装配事实源。
 */
export function collectAssemblyFacts(resolvers) {
  const facts = new Map();
  const record = (packageName, fact) => {
    const list = facts.get(packageName) || [];
    list.push(fact);
    facts.set(packageName, list);
  };

  // 身份源：显式注入 resolvers（测试隔离）时以注入的 agentId 集合为准——
  // 未注入的身份不是本次合成的数据源，遍历它只会撞上"未注册的 scope"告警；
  // 未注入时遍历全部注册身份（生产路径）。
  const identityEntries = resolvers
    ? Object.entries(IDENTITY_SCOPES).filter(([, scope]) => resolvers.has(scope.agentId))
    : Object.entries(IDENTITY_SCOPES);

  // 默认装配源：仅对 opt-in 身份展开（enabled:false = 禁用，装配保留、
  // 面板不下发，与身份层同口径）
  const globalMounts = readGlobalDeclaredMounts(resolvers).mounts;
  for (const [identity, scope] of identityEntries) {
    if (scope.defaultMounts !== true) continue;
    for (const mount of globalMounts.values()) {
      if (mount.kind === 'builtin' || !mount.package) continue;
      record(mount.package, { identity, agentId: scope.agentId, version: mount.version, layerId: 'global', enabled: mount.enabled !== false });
    }
  }

  for (const [identity, scope] of identityEntries) {
    try {
      const { mounts } = readDeclaredMounts(scope, resolvers);
      for (const mount of mounts.values()) {
        if (mount.kind === 'builtin' || !mount.package) continue;
        record(mount.package, { identity, agentId: scope.agentId, version: mount.version, layerId: 'agent', enabled: mount.enabled !== false });
      }
    } catch (err) {
      // 身份层读取失败（层文件损坏等）不阻塞其他身份的声明合成；错误上抛
      // 会连默认装配源面板一起灭掉，降级为跳过该身份。
      console.warn(`[plugin-ui] 读取身份 ${identity} 装配声明失败（跳过）：`, err?.message || err);
    }
  }
  return facts;
}

/**
 * 合成当前应下发的面板声明。
 *
 * @param {object} options catalogRoots / resolvers 透传 scanFeatureCatalog
 *   与 readDeclaredMounts（测试隔离）；assetsRoot 透传资产就绪检查。
 * @returns {Promise<{declarations: Array<object>, warnings: string[]}>}
 *   declaration：{ panelId, pluginId, package, version, url, meta }
 *   meta 与 ClawHost.panels.declare(id, meta, loader) 的 meta 同构。
 */
export async function composePanelDeclarations({ catalogRoots, resolvers, assetsRoot } = {}) {
  // 装配身份可见 = 全局两仓 + 各空间私有仓（空间私有包只对所属身份可见）
  const catalog = await scanFeatureCatalog(catalogRootsWithWorkspaceRepositories(
    catalogRoots,
    Object.values(IDENTITY_SCOPES).map((scope) => scope.agentId),
  ));
  const assemblyFacts = collectAssemblyFacts(resolvers);

  const warnings = [];
  const declarations = [];
  const seenPanelIds = new Map(); // panelId -> packageName（冲突检测）

  for (const [packageName, versions] of catalog.packages) {
    const archivesWithUi = versions.filter((entry) => entry.manifestUi && Array.isArray(entry.manifestUi.panels));
    if (archivesWithUi.length === 0) continue;

    // 可见性 = 装配事实（ADR-0046 决策 2，2026-11-19 修订）：未装配不下发
    // ——含作者标注 scope=global 的面板（scope 是装配建议，不参与可见性裁决）；
    // 默认装配源已按 opt-in 展开为身份条目，无 opt-in 消费者时等同未装配；
    // 禁用事实（enabled:false）等同未装配（三态处置：装配保留、面板下线）。
    // 空间私有包（scopeAgentId）只对所属身份的装配事实施加生效——其他身份
    // 即使声明了同名包，也按不可见丢弃（私有包不跨空间）。
    const mounted = (assemblyFacts.get(packageName) || [])
      .filter((fact) => fact.enabled !== false)
      .filter((fact) => {
        const sameVersion = versions.filter((entry) => entry.version === fact.version);
        // 仓库中根本没有该版本（ghost 装配）：保留事实，由下游给"已不在仓库"警告
        if (sameVersion.length === 0) return true;
        return sameVersion.some((entry) => isCatalogEntryVisibleTo(entry, fact.agentId));
      });
    if (mounted.length === 0) continue;

    // 版本钉装配：取装配版本里最高者；catalog 存在更高版本不跟随
    // （精确钉版 + 显式升级，ADR-0046 决策 5）
    const mountedVersions = [...new Set(mounted.map((fact) => fact.version))];
    const targetVersion = mountedVersions.reduce((a, b) => (b > a ? b : a));
    if (mountedVersions.length > 1) {
      warnings.push(`插件 ${packageName} 被多个层级/身份装配了不同版本（${mountedVersions.join(', ')}），面板按最高装配版本 ${targetVersion} 下发`);
    }
    const versionChoice = archivesWithUi.find((entry) => entry.version === targetVersion);
    if (!versionChoice) {
      warnings.push(`插件 ${packageName} 装配版本 ${targetVersion} 已不在仓库（面板跳过下发；重装该版本或调整装配声明）`);
      continue;
    }

    // 资产就绪自愈（#9）：client 面解出物缺失（tgz 手拷入库 / 解出目录丢失）
    // 时从仓库 tgz 现场解出（幂等）。自愈不可达（catalog 查无 / digest 冲突）
    // 不在此报警——面板级 .digest 检查按缺失跳过并给既有 warning。
    // 资产按包来源定位目录：空间私有包解出到所属空间（ADR-0052 §7）
    const assetScope = versionChoice.scopeAgentId || '';
    await ensureFacetExtracted(
      { packageName, version: versionChoice.version, facet: 'client', scopeAgentId: assetScope },
      { catalog, catalogRoots, assetsRoot },
    ).catch(() => {});

    for (const raw of versionChoice.manifestUi.panels) {
      const { panel, error } = normalizePanelDeclaration(raw, packageName, versionChoice.version);
      if (error) {
        warnings.push(error);
        continue;
      }
      const conflictOwner = seenPanelIds.get(panel.id);
      if (conflictOwner) {
        warnings.push(`面板 id '${panel.id}' 冲突：${conflictOwner} 与 ${packageName} 都提供，保留先注册者`);
        continue;
      }
      seenPanelIds.set(panel.id, packageName);

      // 资产就绪检查（.digest 由导入链路写入）
      const assetDir = versionAssetDir({ packageName, version: versionChoice.version, scopeAgentId: assetScope }, assetsRoot);
      if (!existsSync(path.join(assetDir, '.digest'))) {
        warnings.push(`插件 ${packageName}@${versionChoice.version} 面板 ${panel.id} 的 client 资产未解出（跳过下发；重新导入该 tgz 可解出）`);
        continue;
      }

      const when = {};
      // 装配事实已全部归属到身份（默认装配源按 opt-in 展开），可见范围 =
      // 装配身份集合；此处不再有"处处可见"的无主形态
      const matchingFacts = versionChoice.pluginSettings ? mounted.filter((fact) => {
        const scope = Object.values(IDENTITY_SCOPES).find((item) => item.agentId === fact.agentId);
        if (!scope) return false;
        const effective = [...readEffectiveMounts(scope, resolvers).mounts.values()];
        const matches = effective.filter((mount) => mount.package === packageName && mount.enabled !== false);
        return matches.length === 1 && versions.find((entry) => entry.version === matches[0].version
          && isCatalogEntryVisibleTo(entry, fact.agentId)) === versionChoice;
      }) : mounted;
      when.agentIds = [...new Set(matchingFacts.map((fact) => fact.agentId).filter(Boolean))];
      if (!when.agentIds.length) continue;
      if (panel.surfaces) when.surfaces = panel.surfaces;

      declarations.push({
        panelId: panel.id,
        pluginId: panel.pluginId,
        package: packageName,
        version: versionChoice.version,
        url: `/protoclaw/feature-assets/${packageDirName(packageName)}/${versionChoice.version}/${panel.entry}`
          + (assetScope ? `?ws=${encodeURIComponent(assetScope)}` : ''),
        meta: {
          ...(versionChoice.pluginSettings ? { pluginSettings: { packageName, digest: versionChoice.archiveDigest } } : {}),
          ...(panel.label ? { label: panel.label } : {}),
          ...(panel.description ? { description: panel.description } : {}),
          ...(panel.icon ? { icon: panel.icon } : {}),
          ...(panel.order !== null && panel.order !== undefined ? { order: panel.order } : {}),
          when,
        },
      });
    }
  }

  return { declarations, warnings };
}
