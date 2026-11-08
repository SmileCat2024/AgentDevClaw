/**
 * feature-assets.js — 插件 UI 面资产通道（ADR-0045 P1）
 *
 * 插件包（tgz）的 client/ 面在导入确认时解出到用户数据区，经
 * `GET /protoclaw/feature-assets/:package/:version/*file` 版本化 URL 供
 * 浏览器装载。纪律与 tgz 仓库一致：
 *   - 资产目录按 <package>/<version> 寻址，目录内 `.digest` 记录来源 tgz
 *     的 sha256；同版本重导入时 digest 一致幂等跳过、不一致拒绝（同版本
 *     不同字节不允许并存，与仓库 digest 纪律同构）。
 *   - 解出失败（tgz 损坏 / ui 面声明了却无 client/）抛错，由调用方决定
 *     导入回滚。
 *   - 路由解析侧防路径穿越（resolveClientAsset 白名单化拼接 + realpath
 *     校验），MIME 按扩展名白名单。
 *
 * tar 读取/解出走 shared/tgz-archive 的纯 Node 实现（Windows 双 tar 并存，
 * spawn tar CLI 的 PATH 解析因启动环境而异，见该模块头注）。
 */

import path from 'path';
import { existsSync, promises as fs, readdirSync, createReadStream, realpathSync } from 'fs';

import { USER_FEATURE_REPOSITORY_ROOT } from '../shared/constants.js';
import { gunzipFileToBuffer, listTarEntryNames, untarBufferToDir } from '../shared/tgz-archive.js';
import { scanFeatureCatalog, resolveCatalogPackage } from './catalog.js';

/** UI 资产根：用户 feature 仓库下的 assets/（与 tgz 同区，便于整体备份清理）。 */
export function clientAssetsRoot(assetsRoot) {
  return assetsRoot || path.join(USER_FEATURE_REPOSITORY_ROOT, 'assets');
}

/** server 面解出根：server-env/（供主进程 dynamic import，独立于 assets）。 */
export function serverEnvRoot(root) {
  return root || path.join(USER_FEATURE_REPOSITORY_ROOT, 'server-env');
}

/** 包目录名：@scope/name → scope!name（避免嵌套目录与 Windows 非法字符；@ 不保留）。 */
function packageDirName(packageName) {
  return String(packageName).replace(/^@([^\/]+)\//, '$1!');
}

export function versionAssetDir({ packageName, version }, assetsRoot) {
  return path.join(clientAssetsRoot(assetsRoot), packageDirName(packageName), String(version));
}

export function versionServerDir({ packageName, version }, root) {
  return path.join(serverEnvRoot(root), packageDirName(packageName), String(version));
}

function countFiles(dir) {
  let count = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(current, entry.name));
      else if (entry.name !== '.digest') count += 1; // .digest 是导入元数据，不算资产文件
    }
  };
  walk(dir);
  return count;
}

/**
 * 解出 tgz 的指定面（client/ 或 server/）到目标目录。通用核心，
 * 两个薄包装见下。
 *
 * @param {object} args
 *   - archivePath：tgz 绝对路径
 *   - packageName / version：包名与精确版本（目录寻址）
 *   - archiveDigest：tgz 的 sha256 digest（summarizeArchive 已算，避免重读）
 *   - facet：'client' | 'server'
 *   - destDir：目标版本目录（调用方按面选 root）
 * @param {object} options expect：包声明了该面时为 true——tgz 内必须存在
 *   <facet>/，缺失视为包损坏抛错。writeModuleMarker：server 面解出后自动
 *   补写 { "type": "module" } 的 package.json（解出目录脱离包根，无该
 *   标记 .js 会被 Node 按 CJS 解析，ESM export 直接炸）。
 * @returns {{extracted: boolean, fileCount: number}} extracted=false 表示
 *   tgz 无该面，或同版本已存在且 digest 一致（幂等跳过）。
 * @throws digest 不一致（同版本不同字节）、声明面缺失、解出中途失败。
 */
async function extractArchiveFacet(
  { archivePath, packageName, version, archiveDigest, facet, destDir },
  { expect = false, writeModuleMarker = false } = {},
) {
  const tarBuffer = await gunzipFileToBuffer(archivePath);
  const entries = listTarEntryNames(tarBuffer);
  const hasFacet = entries.some((entry) => new RegExp(`^package/${facet}/.+`).test(entry));
  if (!hasFacet) {
    if (expect) {
      const error = new Error(`插件包声明了 ${facet} 面但 tgz 内没有 ${facet}/ 目录：${packageName}@${version}`);
      error.code = `${facet}-assets-missing`;
      throw error;
    }
    return { extracted: false, fileCount: 0 };
  }

  const digestFile = path.join(destDir, '.digest');
  if (existsSync(digestFile)) {
    const existing = (await fs.readFile(digestFile, 'utf8')).trim();
    if (existing === archiveDigest) {
      return { extracted: false, fileCount: 0 };
    }
    const error = new Error(`同版本资产已存在且内容不同（digest 不一致）：${packageName}@${version}`);
    error.code = 'asset-digest-conflict';
    throw error;
  }

  // 全新解出：清掉残缺目录后按 prefix + strip 直接落位，digest 最后写
  // （写入前崩溃的残缺目录按"不存在"处理——digest 缺失即允许下次导入整体重建）。
  await fs.mkdir(path.dirname(destDir), { recursive: true });
  await fs.rm(destDir, { recursive: true, force: true });
  await untarBufferToDir(tarBuffer, destDir, { prefix: `package/${facet}/`, strip: 2 });
  if (!existsSync(destDir)) {
    const error = new Error(`解出后未找到 package/${facet}：${packageName}@${version}`);
    error.code = `${facet}-assets-missing`;
    throw error;
  }
  await fs.writeFile(digestFile, `${archiveDigest}\n`, 'utf8');
  if (writeModuleMarker && !existsSync(path.join(destDir, 'package.json'))) {
    await fs.writeFile(path.join(destDir, 'package.json'), '{"type":"module"}\n', 'utf8');
  }
  return { extracted: true, fileCount: countFiles(destDir) };
}

/**
 * 解出 tgz 的 client/ 面到资产目录（UI 面资产通道）。
 * 参数语义见 extractArchiveFacet；assetsRoot 测试隔离注入口。
 */
export async function extractClientAssets(
  { archivePath, packageName, version, archiveDigest },
  { expectClient = false, assetsRoot } = {},
) {
  return extractArchiveFacet({
    archivePath,
    packageName,
    version,
    archiveDigest,
    facet: 'client',
    destDir: versionAssetDir({ packageName, version }, assetsRoot),
  }, { expect: expectClient });
}

/**
 * 解出 tgz 的 server/ 面到 server-env 目录（数据面，主进程 dynamic import）。
 * 解出目录自动补 ESM 标记。serverRoot 测试隔离注入口。
 */
export async function extractServerAssets(
  { archivePath, packageName, version, archiveDigest },
  { expectServer = false, serverRoot } = {},
) {
  return extractArchiveFacet({
    archivePath,
    packageName,
    version,
    archiveDigest,
    facet: 'server',
    destDir: versionServerDir({ packageName, version }, serverRoot),
  }, { expect: expectServer, writeModuleMarker: true });
}

/** 资产 MIME 白名单（按扩展名）。未列扩展名一律 application/octet-stream。 */
const ASSET_MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

export function assetMimeFor(fileName) {
  return ASSET_MIME[path.extname(String(fileName)).toLowerCase()] || 'application/octet-stream';
}

/**
 * 解析资产请求路径（防穿越）。成功返回绝对文件路径；包版本目录不存在、
 * 路径逃逸、指向 .digest、版本号含非法字符一律返回 null（调用方 404）。
 */
export function resolveClientAsset({ packageName, version, file }, assetsRoot) {
  const raw = String(file || '');
  if (raw.includes('..') || raw.includes('\\') || raw.startsWith('/') || raw.includes('\0')) return null;
  const segments = raw.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) return null;
  if (segments.includes('.digest')) return null;
  if (!/^[\w.]+$/.test(String(version))) return null;
  const base = versionAssetDir({ packageName, version }, assetsRoot);
  let resolvedBase;
  try { resolvedBase = realpathSync(base); } catch { return null; }
  try {
    const resolved = realpathSync(path.join(base, ...segments));
    return resolved.startsWith(resolvedBase + path.sep) ? resolved : null;
  } catch {
    return null;
  }
}

/** 流式回资产文件（路由用）：版本化 URL 内容不可变，允许长缓存。 */
export function streamClientAsset(res, filePath) {
  res.set('Content-Type', assetMimeFor(filePath));
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.set('X-Content-Type-Options', 'nosniff');
  createReadStream(filePath).on('error', () => {
    if (!res.headersSent) res.status(404).json({ error: 'asset read failed' });
    else res.destroy();
  }).pipe(res);
}

// ── 资产自愈（解出物缺失时从仓库 tgz 现场解出）──────────────────────
//
// 背景：解出原本只发生在 confirm_import 时刻（导入即解出），两个路径会让
// 解出物缺失——直接把 tgz 放进仓库目录（未走导入链路）、解出目录被清理或
// 丢失。此前无自愈路径，面板资产 404、数据面跳过挂载，唯一恢复手段是
// 重新导入。自愈把"按需解出"补在两个消费面上：serve 路由 404 前、数据面
// 挂载目录缺失时。幂等性由 extractArchiveFacet 的 .digest 纪律保证
// （一致跳过 / 冲突拒绝 / 残缺重建），内容寻址目录不变。

/**
 * URL 目录段名反解为规范包名：scope!name → @scope/name（npm 包名不含 !，
 * 替换无歧义；无 ! 的普通包名原样通过。段名形态见 packageDirName：@ 在
 * 转义时被吃掉，产物不带 @）。
 */
function packageNameFromDirName(name) {
  return String(name).replace(/^([^!@]+)!(.+)$/, '@$1/$2');
}

/** 同坐标并发自愈共享同一 inflight promise（rm+untar 非原子，并发重入会互踩）。 */
const healInflight = new Map();

/**
 * 负结果短缓存：catalog 查无 / 包损坏（digest 冲突）的自愈失败记 60s，
 * 防止 404 路径反复触发全量 catalog 扫描（每个 tgz gunzip+sha256，被恶意
 * URL 刷动会成为放大点）。成功自愈不缓存（此后 existsSync 短路）。
 */
const HEAL_MISS_TTL_MS = 60_000;
const healMissCache = new Map();

function healMissRecent(key) {
  const at = healMissCache.get(key);
  if (!at) return false;
  if (Date.now() - at > HEAL_MISS_TTL_MS) {
    healMissCache.delete(key);
    return false;
  }
  return true;
}

/**
 * 自愈解出：按 catalog 定位 package@version 的仓库 tgz，解出指定面。
 * catalog 查无该包@版本 → { healed: false, reason: 'not-in-catalog' }（不抛错，
 * 调用方按"缺失"处理）；解出过程抛错向上传（digest 冲突等包级损坏）。
 * 两类失败均记入负缓存，60s 内同坐标不再重试。
 * @param {object} args { packageName, version, facet: 'client' | 'server' }
 *   packageName 接受规范名或 URL 目录段名（@scope!name）两种形态
 * @param {object} options catalog 传入现成实例（避免重扫）；否则按
 *   catalogRoots 现扫。assetsRoot / serverRoot 测试隔离注入口。
 * @returns {Promise<{healed: boolean, extracted?: boolean, fileCount?: number, reason?: string}>}
 */
export async function ensureFacetExtracted({ packageName, version, facet }, { catalog, catalogRoots, assetsRoot, serverRoot } = {}) {
  const canonicalName = packageNameFromDirName(packageName);
  const key = `${facet}|${canonicalName}@${version}`;
  if (healMissRecent(key)) return { healed: false, reason: 'recently-failed' };
  const inflight = healInflight.get(key);
  if (inflight) return inflight;
  const task = (async () => {
    let archive;
    try {
      const resolvedCatalog = catalog || await scanFeatureCatalog(catalogRoots);
      archive = resolveCatalogPackage(resolvedCatalog, { packageName: canonicalName, version });
    } catch {
      healMissCache.set(key, Date.now());
      return { healed: false, reason: 'not-in-catalog' };
    }
    try {
      const result = facet === 'server'
        ? await extractServerAssets(archive, { serverRoot })
        : await extractClientAssets(archive, { assetsRoot });
      return { healed: true, extracted: result.extracted, fileCount: result.fileCount };
    } catch (error) {
      healMissCache.set(key, Date.now());
      throw error;
    }
  })().finally(() => healInflight.delete(key));
  healInflight.set(key, task);
  return task;
}

/** 测试隔离：清空自愈 inflight 与负缓存（生产代码不应调用）。 */
export function resetAssetHealCachesForTest() {
  healInflight.clear();
  healMissCache.clear();
}

/**
 * client 资产解析（带自愈）：resolveClientAsset 未命中且版本目录整体缺失时，
 * 从仓库 tgz 现场解出后重试。自愈失败降级为原 404 行为（warn 日志，不上抛）
 * ——serve 路由不能因自愈异常崩溃。目录存在而文件缺失属于包损坏，不治，
 * 保持 404 如实。
 */
export async function resolveClientAssetWithHeal(params, options = {}) {
  const filePath = resolveClientAsset(params, options.assetsRoot);
  if (filePath) return filePath;
  if (!existsSync(versionAssetDir(params, options.assetsRoot))) {
    await ensureFacetExtracted({ ...params, facet: 'client' }, options).catch((error) => {
      console.warn('[feature-assets] client 面自愈解出失败（按缺失处理）：', error?.message || error);
    });
    return resolveClientAsset(params, options.assetsRoot);
  }
  return null;
}
