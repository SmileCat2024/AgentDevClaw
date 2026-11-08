/**
 * plugin-server.js — 插件数据面（server 面）挂载器（ADR-0045 P2）
 *
 * 契约：插件包 manifest v3 的 server 声明 `{ entry, prefix }`；包内
 * server/ 面导出 `registerRoutes(router, context)`。宿主在本模块完成：
 *
 *   - 挂载点选择：`/protoclaw/plugin/<prefix>/*`——prefix 是包声明的路由
 *     前缀，全局唯一（冲突时后挂载者拒绝 + 警告）。prefix 即审计面：
 *     listMountedPluginServerPrefixes() 列出当前全部生效前缀与归属包。
 *   - 触发条件：包被装配（global 层或任一工作空间身份，装配事实与 UI 面同源，
 *     collectAssemblyFacts）；未装配的包不挂载。多版本装配取装配版本里最高
 *     者（catalog 更高版本不跟随，与面板下发同款钉版语义）。
 *   - 受控 router：只暴露 get/post/put/delete，注册路径必须是以 / 开头
 *     的相对子路径（无 .. 、无绝对段）；宿主包装 handler 做异常计数
 *     熔断（同一包连续 5 次未捕获异常 → 摘除该包全部路由并显式警告，
 *     remountPluginServerRoutes() 可整体重建）。
 *   - context.getConfig()：每次请求现读该包的四层作用域合成配置
 *     （resolveScopeConfig），配置修改无需重启。身份选择取装配事实中第一个
 *     工作空间身份（agent 层是 $mount 与插件配置的权威层）；纯全局装配时
 *     无空间身份，配置取 global 层值（ADR-0046：数据面读 global + 装配层）。
 *
 * 信任与依赖模型（ADR-0045）：server 面在主 server.js 进程内执行，与
 * 工具面同级的信任（本机代码）；依赖约束为 node 内置模块 + 相对导入
 * （解出目录脱离包根 npm 环境，外部依赖不可解析）。import 失败的包
 * 跳过挂载并警告，不阻塞其他包。
 */

import path from 'path';
import { existsSync } from 'fs';
import { pathToFileURL } from 'url';

import { scanFeatureCatalog } from './catalog.js';
import { collectAssemblyFacts } from './plugin-ui.js';
import { readGlobalDeclaredMounts } from './install-service.js';
import { versionServerDir, ensureFacetExtracted } from './feature-assets.js';
import { resolveScopeConfig } from '../routes/feature-config.js';
import { createClawLogger as createLogger } from '../shared/claw-logger.js';

const log = createLogger('plugin-server');

const PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const CIRCUIT_BREAK_THRESHOLD = 5;

/**
 * 计算当前应挂载的 server 面。
 * @returns {Promise<{mounts: Array<{packageName, version, prefix, entryPath, identities}>, warnings: string[]}>}
 */
export async function buildPluginServerMounts({ catalogRoots, resolvers, serverRoot } = {}) {
  const catalog = await scanFeatureCatalog(catalogRoots);
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

    const mounted = assemblyFacts.get(packageName) || [];
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
    const entryPath = path.join(
      versionServerDir({ packageName, version: versionChoice.version }, serverRoot),
      entryRel,
    );
    if (!existsSync(entryPath)) {
      // 自愈：解出物缺失（目录被清 / tgz 未经导入链路直放入库）时从仓库
      // tgz 现场解出（digest 幂等）。失败只记 warning，不阻塞其他包。
      await ensureFacetExtracted(
        { packageName, version: versionChoice.version, facet: 'server' },
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
    });
  }

  return { mounts, warnings };
}

/**
 * 挂载到 Express app。重复调用安全：先摘除上一次挂载的全部路由
 * （unmountPluginServerRoutes），再按当前装配事实重新挂载——导入、装配、
 * 禁用变化后调 remountPluginServerRoutes 整体重建。
 *
 * @returns {Promise<{mounted: Array<{packageName, prefix}>, warnings: string[]}>}
 */
// 模块级挂载记录：prefix → [{ method, fullPath }]（unmount 反向摘除依据）
const mountedRouteRegistry = new Map();

export function unmountPluginServerRoutes(app) {
  // Express 4：app.router 是废弃 getter（访问即抛错），路由栈只在 _router
  const router = app._router;
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
  mountedRouteRegistry.clear();
  return removed;
}

export async function remountPluginServerRoutes(app, options = {}) {
  unmountPluginServerRoutes(app);
  return mountPluginServerRoutes(app, options);
}

export async function mountPluginServerRoutes(app, options = {}) {
  const { mounts, warnings } = await buildPluginServerMounts(options);
  const mounted = [];

  for (const mount of mounts) {
    let mod;
    try {
      mod = await import(pathToFileURL(mount.entryPath).href);
    } catch (err) {
      warnings.push(`插件 ${mount.packageName}@${mount.version} server 面加载失败（${err?.message || err}）：跳过挂载`);
      continue;
    }
    const registerRoutes = mod?.default?.registerRoutes || mod?.registerRoutes;
    if (typeof registerRoutes !== 'function') {
      warnings.push(`插件 ${mount.packageName}@${mount.version} server 面未导出 registerRoutes(router, context)：跳过挂载`);
      continue;
    }

    // 熔断状态（包级）：连续异常计数
    let consecutiveFailures = 0;
    let broken = false;

    const base = `/protoclaw/plugin/${mount.prefix}`;
    const guard = (handler) => async (req, res, next) => {
      if (broken) {
        res.status(503).json({ ok: false, error: { code: 'plugin-server-circuit-open', message: `插件 ${mount.packageName} 数据面已因连续异常被摘除（前缀 ${mount.prefix}）` } });
        return;
      }
      try {
        await handler(req, res, next);
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= CIRCUIT_BREAK_THRESHOLD) {
          broken = true;
          log.warn(`插件 ${mount.packageName}@${mount.version} 数据面连续 ${consecutiveFailures} 次异常，前缀 ${mount.prefix} 已熔断摘除`, { lastError: err?.message || String(err) });
        }
        if (!res.headersSent) {
          res.status(500).json({ ok: false, error: { code: 'plugin-server-error', message: String(err?.message || err) } });
          return;
        }
        res.destroy();
      }
    };

    const makeRouter = () => {
      const registrations = [];
      const route = (method) => (routePath, handler) => {
        const rel = String(routePath || '');
        if (!rel.startsWith('/') || rel.includes('..') || rel.includes('\\') || rel.includes('\0')) {
          throw new Error(`插件 ${mount.packageName} 注册了非法路由路径：${method} ${rel}（必须是以 / 开头的相对子路径）`);
        }
        registrations.push({ method, routePath: rel, handler });
      };
      return {
        get: route('get'), post: route('post'), put: route('put'), delete: route('delete'),
        _registrations: registrations,
      };
    };

    const router = makeRouter();
    // 配置合成身份：第一个工作空间身份（agent 层是插件配置的权威层）；
    // 纯全局装配时无空间身份，getConfig 回落 global 层值
    const contextIdentity = mount.identities.find((fact) => fact.agentId) || null;
    const context = {
      // 每次调用现读：配置修改后无需重启（与工具面构造期一次合成不同，
      // 数据面生命周期跨配置变更）
      getConfig() {
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
      },
      package: { name: mount.packageName, version: mount.version },
    };

    try {
      registerRoutes(router, context);
    } catch (err) {
      warnings.push(`插件 ${mount.packageName}@${mount.version} registerRoutes 抛错（${err?.message || err}）：跳过挂载`);
      continue;
    }

    const registeredForPackage = [];
    for (const { method, routePath, handler } of router._registrations) {
      const fullPath = `${base}${routePath === '/' ? '' : routePath}`;
      app[method](fullPath, guard(handler));
      registeredForPackage.push({ method, fullPath });
    }
    mountedRouteRegistry.set(mount.prefix, registeredForPackage);
    mounted.push({ packageName: mount.packageName, prefix: mount.prefix });
  }

  for (const warning of warnings) log.warn(warning);
  return { mounted, warnings };
}
