/**
 * plugin-server.js — 插件数据面（server 面）挂载器（ADR-0045 P2 → ADR-0055）
 *
 * 契约：插件包 manifest v3 的 server 声明 `{ entry, prefix }`；包内
 * server/ 面导出 `registerRoutes(router, context)`。宿主在本模块完成：
 *
 *   - 挂载点选择：`/protoclaw/plugin/<prefix>/*`——prefix 是包声明的路由
 *     前缀，全局唯一（冲突时后挂载者拒绝 + 警告）。prefix 即审计面：
 *     当前全部生效前缀与归属包见挂载结果 mounted 列表。
 *   - 触发条件：包被装配（任一工作空间身份装配，或任一 opt-in 身份消费
 *     默认装配源——装配事实与 UI 面同源，collectAssemblyFacts 已把 global
 *     层展开为声明 defaultMounts 的身份条目）；未装配的包不挂载。多版本
 *     装配取装配版本里最高者（catalog 更高版本不跟随，与面板下发同款钉版
 *     语义）。
 *
 * 执行模型（ADR-0055）：插件 server 面代码不再在本进程内执行——本模块只
 * 计算 mounts 清单（catalog / 装配事实 / 解出自愈）并把代理路由挂进
 * Express；执行体在 plugin-host 子进程（plugin-host-manager 管理 fork /
 * 原子切换 / 崩溃退避重启）。宿主侧收口三件事（收权点即安全点）：
 *
 *   - digest guard：settingsDigest 校验沿用进程内时代语义；
 *   - 配置合成：新协议按请求四层合成（readRequestPluginSettings），存量
 *     包按第一装配身份两层合成——每请求现读，快照随 IPC 下发，子进程
 *     接触不到配置文件；
 *   - 路由匹配：Express 路径模式匹配后下发 (packageName, method,
 *     routePath)，子进程精确分发，构不成对其他插件路由的请求。
 *
 * 包级熔断（连续 5 次未捕获异常 → 503 circuit-open）与异常信封语义由
 * 子进程适配层保持（ADR-0055 决策 3：插件契约零改动）。
 */

import path from 'path';
import { existsSync } from 'fs';

import { catalogRootsWithWorkspaceRepositories, isCatalogEntryVisibleTo, scanFeatureCatalog } from './catalog.js';
import { collectAssemblyFacts } from './plugin-ui.js';
import { IDENTITY_SCOPES, readGlobalDeclaredMounts } from './install-service.js';
import { versionServerDir, ensureFacetExtracted } from './feature-assets.js';
import { resolveScopeConfig } from '../routes/feature-config.js';
import { readRequestPluginSettings } from './plugin-settings-context.js';
import { createClawLogger as createLogger } from '../shared/claw-logger.js';
import {
  ensurePluginHostLocked,
  replacePluginHostLocked,
  terminatePluginHost,
  runPluginHostLifecycle,
  getActivePluginHost,
  readRawBody,
} from './plugin-host/plugin-host-manager.js';

const log = createLogger('plugin-server');

const PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * 计算当前应挂载的 server 面。
 * @returns {Promise<{mounts: Array<{packageName, version, prefix, entryPath, identities}>, warnings: string[]}>}
 */
export async function buildPluginServerMounts({ catalogRoots, resolvers, serverRoot } = {}) {
  const catalog = await scanFeatureCatalog(catalogRootsWithWorkspaceRepositories(
    catalogRoots,
    Object.values(IDENTITY_SCOPES).map((scope) => scope.agentId),
  ));
  const assemblyFacts = collectAssemblyFacts(resolvers);

  const warnings = [];
  const mounts = [];
  const seenPrefixes = new Map(); // prefix -> packageName（冲突检测）

  for (const [packageName, versions] of catalog.packages) {
    const withServer = versions.filter(
      (entry) => entry.manifestServer
        && typeof entry.manifestServer.entry === 'string'
        && typeof entry.manifestServer.prefix === 'string',
    );
    if (withServer.length === 0) continue;

    // 禁用事实（enabled:false）等同未装配：数据面整体摘除（三态处置）。
    // 空间私有包只对所属身份可见：其他身份的装配事实按不可见丢弃（不跨空间）
    const mounted = (assemblyFacts.get(packageName) || [])
      .filter((fact) => fact.enabled !== false)
      .filter((fact) => {
        const sameVersion = versions.filter((entry) => entry.version === fact.version);
        // 仓库中根本没有该版本（ghost 装配）：保留事实，交由下游跳过并告警
        if (sameVersion.length === 0) return true;
        return sameVersion.some((entry) => isCatalogEntryVisibleTo(entry, fact.agentId));
      });
    if (mounted.length === 0) continue; // 未装配不挂载（global 层装配同样生效）

    // 版本钉装配：取装配版本里最高者；catalog 更高版本不跟随
    const mountedVersions = [...new Set(mounted.map((fact) => fact.version))];
    const targetVersion = mountedVersions.reduce((a, b) => (b > a ? b : a));
    const versionChoice = withServer.find((entry) => entry.version === targetVersion);
    if (!versionChoice) {
      warnings.push(`插件 ${packageName} 装配版本 ${targetVersion} 已不在仓库（server 面跳过挂载）`);
      continue;
    }
    const prefix = versionChoice.manifestServer.prefix.trim();
    if (!PREFIX_PATTERN.test(prefix)) {
      warnings.push(`插件 ${packageName}@${versionChoice.version} 的 server.prefix 非法（${prefix}，仅小写字母/数字/连字符）：跳过挂载`);
      continue;
    }
    const conflictOwner = seenPrefixes.get(prefix);
    if (conflictOwner) {
      warnings.push(`server 前缀冲突：${conflictOwner} 与 ${packageName} 都声明 '${prefix}'，保留先挂载者`);
      continue;
    }
    seenPrefixes.set(prefix, packageName);

    const entryRel = versionChoice.manifestServer.entry.replace(/\\/g, '/');
    if (entryRel.includes('..') || entryRel.startsWith('/')) {
      warnings.push(`插件 ${packageName}@${versionChoice.version} 的 server.entry 含非法路径段（${entryRel}）：跳过挂载`);
      continue;
    }
    const serverScope = versionChoice.scopeAgentId || '';
    const entryPath = path.join(
      versionServerDir({ packageName, version: versionChoice.version, scopeAgentId: serverScope }, serverRoot),
      entryRel,
    );
    if (!existsSync(entryPath)) {
      // 自愈：解出物缺失（目录被清 / tgz 未经导入链路直放入库）时从仓库
      // tgz 现场解出（digest 幂等）。失败只记 warning，不阻塞其他包。
      await ensureFacetExtracted(
        { packageName, version: versionChoice.version, facet: 'server', scopeAgentId: serverScope },
        { catalog, catalogRoots, serverRoot },
      ).catch((error) => {
        warnings.push(`插件 ${packageName}@${versionChoice.version} server 面自愈解出失败：${error?.message || error}`);
      });
    }
    if (!existsSync(entryPath)) {
      warnings.push(`插件 ${packageName}@${versionChoice.version} 的 server 面未解出且自愈未成（${entryPath} 不存在；重新导入该 tgz 可解出）：跳过挂载`);
      continue;
    }

    mounts.push({
      packageName,
      version: versionChoice.version,
      prefix,
      entryPath,
      identities: mounted,
      ...(versionChoice.pluginSettings ? { settingsDigest: versionChoice.archiveDigest } : {}),
    });
  }

  return { mounts, warnings };
}

// 模块级挂载记录：prefix → [{ method, fullPath }]（unmount 反向摘除依据）
const mountedRouteRegistry = new Map();

/** 从 Express 路由栈摘除 registry 记录的全部路由，返回摘除条数。 */
function removeRegisteredRoutes(app) {
  const router = app._router; // Express 4：app.router 是废弃 getter（访问即抛错）
  if (!router || !Array.isArray(router.stack)) return 0;
  const registered = new Set();
  for (const entries of mountedRouteRegistry.values()) {
    for (const { method, fullPath } of entries) registered.add(`${method} ${fullPath}`);
  }
  let removed = 0;
  for (let i = router.stack.length - 1; i >= 0; i -= 1) {
    const layer = router.stack[i];
    const route = layer?.route;
    if (!route) continue;
    const methods = Object.keys(route.methods || {});
    const hit = methods.some((method) => registered.has(`${method} ${route.path}`));
    if (hit) {
      router.stack.splice(i, 1);
      removed += 1;
    }
  }
  return removed;
}

/**
 * 摘除当前挂载的全部数据面路由。挂载表清空即数据面整体下线——同时终止
 * plugin-host 子进程（进程不再空转；测试 teardown 亦依赖此清理。
 * terminatePluginHost 幂等：无活跃进程时为空操作）。
 */
export function unmountPluginServerRoutes(app) {
  const removed = removeRegisteredRoutes(app);
  mountedRouteRegistry.clear();
  terminatePluginHost().catch((error) => {
    log.warn(`plugin-host 终止失败：${error?.message || error}`);
  });
  return removed;
}

/**
 * 挂载/重建入口（签名与进程内时代一致，消费方 server.js 与测试零改动）。
 *
 * mount：确保存在匹配 mounts 的 plugin-host（指纹一致复用；不一致预启新
 * 进程原子切换）→ 把代理路由挂进 Express。
 * remount：强制换新进程（规避子进程内 ESM import 缓存的换版不生效），
 * 旧进程优雅回收、在途请求在宽限期内完成。
 */
/**
 * 挂载/重建入口（签名与进程内时代一致，消费方 server.js 与测试零改动）。
 *
 * 全程持有宿主生命周期锁（runPluginHostLifecycle）：mounts 计算、host
 * 切换与 Express 路由安装是一个原子段——并发的 mount / remount 串行化，
 * 杜绝「旧调用的路由安装覆盖新切换」的交错窗口。
 *
 * mount：指纹一致复用现有 plugin-host（配置合成每请求现读，resolvers
 * 变化不换进程）；remount：强制换新进程（规避子进程内 ESM import 缓存
 * 的换版不生效），旧进程优雅回收、在途请求在宽限期内完成。
 */
function mountOrRemountPluginServerRoutes(app, options, { replace }) {
  return runPluginHostLifecycle(async () => {
    const { mounts, warnings } = await buildPluginServerMounts(options);
    const host = replace
      ? await replacePluginHostLocked(mounts, options)
      : await ensurePluginHostLocked(mounts, options);
    for (const warning of host.warnings || []) warnings.push(warning);
    return installProxyRoutes(app, mounts, host, options, warnings);
  });
}

export function mountPluginServerRoutes(app, options = {}) {
  return mountOrRemountPluginServerRoutes(app, options, { replace: false });
}

export function remountPluginServerRoutes(app, options = {}) {
  return mountOrRemountPluginServerRoutes(app, options, { replace: true });
}

/**
 * 把 host 路由表挂成 Express 代理路由：先摘旧记录再挂新（remount 场景
 * 同路径换闭包，避免新旧 handler 叠挂），记账与挂载间无 await。
 */
function installProxyRoutes(app, mounts, host, options, warnings) {
  removeRegisteredRoutes(app);
  const registryEntries = new Map(); // prefix → [{method, fullPath}]
  const mounted = [];

  for (const route of host.routes) {
    const mount = mounts.find((item) => item.packageName === route.packageName);
    if (!mount) continue;
    const fullPath = `/protoclaw/plugin/${mount.prefix}${route.routePath === '/' ? '' : route.routePath}`;
    app[route.method](fullPath, makeProxyHandler(mount, route.routePath, options));
    let list = registryEntries.get(mount.prefix);
    if (!list) {
      list = [];
      registryEntries.set(mount.prefix, list);
      mounted.push({ packageName: mount.packageName, prefix: mount.prefix });
    }
    list.push({ method: route.method, fullPath });
  }

  mountedRouteRegistry.clear();
  for (const [prefix, entries] of registryEntries) mountedRouteRegistry.set(prefix, entries);

  for (const warning of warnings) log.warn(warning);
  return { mounted, warnings };
}

/**
 * 单条路由的宿主侧代理：digest guard + 配置合成收口 → IPC 转发。
 * 执行与熔断在 plugin-host 子进程；本层不 import 插件代码。
 */
function makeProxyHandler(mount, routePath, options) {
  // 配置合成身份：第一个装配身份（存量包 getConfig 无参语义）。默认装配源
  // 条目已按 opt-in 展开、归属到具体身份（ADR-0046）。防御性保留无身份
  // 兜底（回落 global 层值，不抛错）。
  const contextIdentity = mount.identities.find((fact) => fact.agentId) || null;

  const legacySettingsSnapshot = () => {
    try {
      if (!contextIdentity) {
        const { sparse } = readGlobalDeclaredMounts(options.resolvers);
        const raw = sparse[mount.packageName];
        return raw && typeof raw === 'object' ? raw : {};
      }
      const { merged } = resolveScopeConfig({ agentId: contextIdentity.agentId }, options.resolvers);
      return (merged && merged[mount.packageName]) || {};
    } catch {
      return {};
    }
  };

  return async (req, res) => {
    // digest guard（与进程内挂载器同款语义）
    if ((mount.settingsDigest || req.query.digest !== undefined) && req.query.digest !== mount.settingsDigest) {
      res.status(409).json({ error: '请求的插件实现与数据路由不匹配' });
      return;
    }
    // 配置合成（宿主收口）：新协议按请求四层合成，存量包按第一装配身份两层
    let settings;
    if (mount.settingsDigest) {
      try {
        const { values } = await readRequestPluginSettings(mount.packageName, req.query, options);
        settings = values;
      } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
        return;
      }
    } else {
      settings = legacySettingsSnapshot();
    }

    const host = getActivePluginHost();
    if (!host || host.disposed) {
      res.status(503).json({ ok: false, error: { code: 'plugin-host-unavailable', message: '插件宿主进程不可用（启动或重启中）' } });
      return;
    }

    const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readRawBody(req);
    host.request({
      packageName: mount.packageName,
      method: req.method,
      routePath,
      params: req.params,
      query: req.query,
      headers: req.headers,
      body,
      settings,
    }, res);
  };
}
