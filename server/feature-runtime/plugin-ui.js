/**
 * plugin-ui.js — 插件 UI 面声明合成（ADR-0045 P1）
 *
 * 权威链（ADR-0045）：插件 manifest 的 ui.panels 只是素材（label/icon/
 * order/scope 为默认呈现建议），合成时叠加装配事实：
 *   - scope=global：面板随包导入即可用（vault 类全局工具），when 不设
 *     agentIds 限制（保留 manifest 的 surfaces 限定）。
 *   - scope=assembly（缺省）：面板只在装配了该插件的工作空间身份视图出
 *     现——when.agentIds = 装配身份的 agentId 集合；无任何身份装配时该
 *     面板不下发。
 *   - 呈现层最终裁决（显隐/排序）在前端工作空间呈现配置（P4），本层只
 *     产出素材 + 装配合成结果。
 *
 * 资产就绪检查：版本目录内 .digest 存在才下发（tgz 手工拷入仓库但未走
 * 导入链路解出 client/ 的包不下发，避免面板按钮指向 404 资产）。
 *
 * 同包多版本跨身份装配属边缘情况：面板按最高装配版本下发一次，when 合并
 * 全部装配身份，warnings 说明。同面板 id 被多个包提供：先到先得 + warning
 * （面板 id 是前端注册表键，必须全局唯一）。
 */

import { existsSync } from 'fs';
import path from 'path';

import { scanFeatureCatalog } from './catalog.js';
import { IDENTITY_SCOPES, readDeclaredMounts } from './install-service.js';
import { clientAssetsRoot, versionAssetDir } from './feature-assets.js';

const SCOPE_VALUES = new Set(['global', 'assembly']);

/** URL / 资产目录共用的包目录段（@scope/name → @scope!name，避免路径分隔）。 */
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
 * 读取全部身份的装配事实：Map<packageName, Array<{ identity, agentId, version }>>。
 * builtin 挂载无包坐标，不参与（UI 面只能来自仓库包）。
 * 导出供 plugin-server.js（数据面挂载）复用同一装配事实源。
 */
export function collectAssemblyFacts(resolvers) {
  const facts = new Map();
  for (const [identity, scope] of Object.entries(IDENTITY_SCOPES)) {
    try {
      const { mounts } = readDeclaredMounts(scope, resolvers);
      for (const mount of mounts.values()) {
        if (mount.kind === 'builtin' || !mount.package) continue;
        const list = facts.get(mount.package) || [];
        list.push({ identity, agentId: scope.agentId, version: mount.version });
        facts.set(mount.package, list);
      }
    } catch (err) {
      // 身份层读取失败（层文件损坏等）不阻塞其他身份的声明合成；错误上抛
      // 会连 global 面板一起灭掉，降级为跳过该身份。
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
  const catalog = await scanFeatureCatalog(catalogRoots);
  const assemblyFacts = collectAssemblyFacts(resolvers);
  const root = clientAssetsRoot(assetsRoot);

  const warnings = [];
  const declarations = [];
  const seenPanelIds = new Map(); // panelId -> packageName（冲突检测）

  for (const [packageName, versions] of catalog.packages) {
    const archivesWithUi = versions.filter((entry) => entry.manifestUi && Array.isArray(entry.manifestUi.panels));
    if (archivesWithUi.length === 0) continue;

    // 下发版本选择：装配版本里最高者（跨版本装配的边缘情况合并处理）
    const mounted = assemblyFacts.get(packageName) || [];
    const versionChoice = mounted.length > 0
      ? archivesWithUi.reduce((best, entry) => (entry.version > best.version ? entry : best))
      : archivesWithUi[0]; // 未装配：仍需合成（global 面板不依赖装配）
    if (mounted.length > 1) {
      const distinctVersions = new Set(mounted.map((fact) => fact.version));
      if (distinctVersions.size > 1) {
        warnings.push(`插件 ${packageName} 被多个身份装配了不同版本（${[...distinctVersions].join(', ')}），面板按最高版本 ${versionChoice.version} 下发`);
      }
    }

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
      const assetDir = versionAssetDir({ packageName, version: versionChoice.version }, assetsRoot);
      if (!existsSync(path.join(assetDir, '.digest'))) {
        if (mounted.length > 0 || panel.scope === 'global') {
          warnings.push(`插件 ${packageName}@${versionChoice.version} 面板 ${panel.id} 的 client 资产未解出（跳过下发；重新导入该 tgz 可解出）`);
        }
        continue;
      }

      const when = {};
      if (panel.scope === 'assembly') {
        const agentIds = mounted.map((fact) => fact.agentId);
        if (agentIds.length === 0) continue; // 无身份装配：面板不可用
        when.agentIds = [...new Set(agentIds)];
      }
      if (panel.surfaces) when.surfaces = panel.surfaces;

      declarations.push({
        panelId: panel.id,
        pluginId: panel.pluginId,
        package: packageName,
        version: versionChoice.version,
        url: `/protoclaw/feature-assets/${packageDirName(packageName)}/${versionChoice.version}/${panel.entry}`,
        meta: {
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
