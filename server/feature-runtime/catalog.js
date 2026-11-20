import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';

import {
  FEATURE_REPOSITORY_ROOT,
  FEATURE_MANIFEST_NAME,
  USER_FEATURE_REPOSITORY_ROOT,
  workspaceFeatureRepositoryRoot,
} from '../shared/constants.js';
import { compareSemver } from '../shared/feature-utils.js';
import { gunzipBufferToBuffer, parseTarBuffer } from '../shared/tgz-archive.js';
import { compilePluginSettings } from './plugin-settings.js';

/**
 * 单 tgz 摘要提取：一次 readFile、一次 gunzip、一次 tar parse——
 * package.json / manifest / digest 共用同一次读盘（历史形态是对
 * archivePath 做两次独立 gunzip + 一次额外 readFile 算 digest，同一
 * tgz 读三遍盘）。
 */
function readJsonFromEntries(entries, entryPath) {
  const entry = entries.find((e) => e.name === entryPath);
  if (!entry || entry.data.length === 0) throw new Error(`Archive entry is empty: ${entryPath}`);
  return JSON.parse(entry.data.toString('utf8'));
}

/** feature 名：运行时实例名 + 配置键 + 界面展示键，与 npm 包名段同字符集。 */
const FEATURE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * manifest.features[] 归一化（ADR-0046 2026-11-19 第三批：一个插件包可携带
 * 多个 feature）。无该字段 / 空数组 = 单 feature 包，行为与既往完全一致。
 * 每项 { name（必填）, entry?, export? }，entry/export 缺省沿用 manifest 顶层。
 * 非法项丢弃并返回 warnings：catalog 层保持宽容（坏声明不让包从仓库消失），
 * 导入确认面单独展示这些提示。
 */
function normalizeManifestFeatures(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return { features: null, warnings: [] };
  const warnings = [];
  const features = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      warnings.push('manifest.features 项不是对象，已忽略');
      continue;
    }
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name || !FEATURE_NAME_PATTERN.test(name)) {
      warnings.push(`manifest.features 项 name 非法（${name || '(空)'}）：仅允许字母/数字/点/下划线/连字符`);
      continue;
    }
    if (seen.has(name)) {
      warnings.push(`manifest.features 中 feature 名重复：${name}`);
      continue;
    }
    const entry = typeof item.entry === 'string' ? item.entry.trim() : '';
    if (entry && (entry.includes('..') || entry.startsWith('/') || entry.includes('\\'))) {
      warnings.push(`manifest.features.${name} 的 entry 含非法路径段：${entry}`);
      continue;
    }
    const exportName = typeof item.export === 'string' ? item.export.trim() : '';
    seen.add(name);
    features.push({ name, ...(entry ? { entry } : {}), ...(exportName ? { export: exportName } : {}) });
  }
  return { features: features.length ? features : null, warnings };
}

export async function summarizeArchive(archivePath, source) {
  // 纯 Node 读取（shared/tgz-archive）：Windows 双 tar 并存（GNU 需
  // --force-local 而 bsdtar 不支持），spawn tar CLI 因 PATH 解析因人而异，
  // 历史事故：开发机测试全绿、用户环境导入全炸。
  const raw = await fs.readFile(archivePath);
  const tarBuffer = await gunzipBufferToBuffer(raw);
  const entries = parseTarBuffer(tarBuffer);
  const pkg = readJsonFromEntries(entries, 'package/package.json');
  let manifest = null;
  try {
    manifest = readJsonFromEntries(entries, `package/${FEATURE_MANIFEST_NAME}`);
  } catch { /* manifest 可选：无 agentdev.json 的包按 null 处理 */ }
  const packageName = typeof pkg?.name === 'string' ? pkg.name.trim() : '';
  const version = typeof pkg?.version === 'string' ? pkg.version.trim() : '';
  if (!packageName || !version) {
    throw new Error(`Feature archive 缺少 package name 或 version：${archivePath}`);
  }
  const { features: manifestFeatures, warnings: manifestFeatureWarnings } = normalizeManifestFeatures(manifest?.features);
  return {
    packageName,
    version,
    archivePath,
    archiveDigest: `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`,
    source,
    entry: typeof manifest?.entry === 'string' && manifest.entry.trim()
      ? manifest.entry.trim()
      : (typeof pkg.main === 'string' ? pkg.main.trim() : ''),
    // Feature class 的显式导出名（manifest 顶层，与 entry 同级）。入口多命名导出
    // 且无 default 时，loader 的猜测链无法唯一确定——声明位在此透传（历史事故：
    // agentero 入口 6 个命名导出，$mount 装配后 runtime 启动炸）。
    export: typeof manifest?.export === 'string' && manifest.export.trim()
      ? manifest.export.trim()
      : '',
    manifestPresent: !!manifest,
    manifestName: typeof manifest?.name === 'string' && manifest.name.trim() ? manifest.name.trim() : '',
    manifestDescription: typeof manifest?.description === 'string' && manifest.description.trim()
      ? manifest.description.trim()
      : (typeof pkg.description === 'string' && pkg.description.trim() ? pkg.description.trim() : ''),
    // settings schema 原样保留：已装配项的配置面板按此渲染（manifest v2 的 agentdev.settings）
    manifestSettings: manifest?.settings && typeof manifest.settings === 'object'
      && !Array.isArray(manifest.settings)
      ? manifest.settings
      : null,
    // 多 feature 声明（ADR-0046 2026-11-19 第三批）：一个包可携带多个 feature，
    // 每项是独立运行时实例与独立配置键。null = 单 feature 包（既有语义）。
    manifestFeatures,
    manifestFeatureWarnings,
    pluginSettings: compilePluginSettings(manifest, new Set((manifestFeatures || []).map(({ name }) => name))),
    // 按 feature 分组的配置 schema：settings.features[<name>] = { properties }。
    // 多 feature 包用此形态；单 feature 包仍用顶层 settings.properties。
    manifestFeatureSettings: manifest?.settings && typeof manifest.settings === 'object'
      && !Array.isArray(manifest.settings)
      && manifest.settings.features && typeof manifest.settings.features === 'object'
      && !Array.isArray(manifest.settings.features)
      ? manifest.settings.features
      : null,
    // manifest v3（ADR-0045）：ui 面（panels 声明）与 server 面（entry/prefix）
    // 原样保留；逐项校验与语义合成在 plugin-ui.js 的声明合成处做（catalog
    // 层保持宽容提取，无 v3 声明的包字段为 null，行为与 v2 完全一致）。
    manifestSchemaVersion: typeof manifest?.schemaVersion === 'number' ? manifest.schemaVersion : null,
    manifestUi: manifest?.ui && typeof manifest.ui === 'object' && !Array.isArray(manifest.ui)
      ? manifest.ui
      : null,
    manifestServer: manifest?.server && typeof manifest.server === 'object' && !Array.isArray(manifest.server)
      ? manifest.server
      : null,
  };
}

async function scanRoot(root, source) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const archives = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.tgz'))
    .map((entry) => summarizeArchive(path.join(root, entry.name), source).catch((error) => ({
      archivePath: path.join(root, entry.name),
      source,
      error: error instanceof Error ? error.message : String(error),
    }))));
  return archives;
}

// ── catalog 缓存（mtime+size 键控）──────────────────────────────────
//
// scanFeatureCatalog 的调用密度（面板声明 30s 轮询、商店 overview 每请求
// 3 次全扫、带统一设置的插件数据面每请求）远高于仓库变化频率，而每次全扫
// 对每个 tgz 做完整读盘 + gunzip + tar parse。缓存按 roots 形态键控，命中
// 条件 = 各根目录 readdir 结果与每个 tgz 的 mtime+size 全部一致——任何
// 写入方（导入链路、删除、外部直拷 tgz）落盘后 stat 摘要必然变化，无需
// 手动失效。并发调用共享 inflight promise，避免同 key 双扫。
//
// 返回共享快照对象：调用方按契约只读遍历（packages/invalid），不得原地
// 修改；需要派生数据时复制后改。

const CATALOG_CACHE_LIMIT = 64;
const catalogCache = new Map(); // rootsKey → { stamp, value }
const catalogInflight = new Map(); // rootsKey → Promise<catalog>

function catalogRootsKey({ officialRoot, userRoot, workspaceRoots }) {
  const ws = Object.keys(workspaceRoots).sort()
    .map((id) => `${id}=>${path.resolve(String(workspaceRoots[id]))}`);
  return JSON.stringify([path.resolve(officialRoot), path.resolve(userRoot), ws]);
}

/** 单根 stat 摘要：tgz 文件名|mtimeMs|size 排序列表；目录缺失为 null。 */
async function statRootStamp(root) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (entries === null) return null;
  const stamps = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.tgz'))
    .map(async (entry) => {
      const stat = await fs.stat(path.join(root, entry.name));
      return `${entry.name}|${stat.mtimeMs}|${stat.size}`;
    }));
  return stamps.sort();
}

function stampEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 测试隔离：清空 catalog 缓存与 inflight（生产不调用；stat 摘要自动失效）。 */
export function resetFeatureCatalogCacheForTest() {
  catalogCache.clear();
  catalogInflight.clear();
}

/**
 * 仓库来源优先级：空间私有 > 用户区 > 官方区（同包同版本时高优先级解释）。
 * 空间私有条目只对所属身份可见（scopeAgentId），全局条目对所有身份可见。
 */
const SOURCE_PRIORITY = { workspace: 2, custom: 1, official: 0 };

/**
 * 扫描插件仓库。
 * @param {object} options
 *   - officialRoot / userRoot：全局两仓（测试隔离注入口）
 *   - workspaceRoots：{ agentId: root } 工作空间私有仓（ADR-0046 空间级仓库），
 *     条目带 scopeAgentId 标记可见身份；缺省为空（无私有仓的调用方行为不变）
 * 同版本多来源并存时保留全部条目，按来源优先级 + 版本号降序排列，解析时
 * 取首个命中——空间私有包因此覆盖同名全局包，仅对所属身份生效。
 */
export async function scanFeatureCatalog({ officialRoot = FEATURE_REPOSITORY_ROOT, userRoot = USER_FEATURE_REPOSITORY_ROOT, workspaceRoots = {} } = {}) {
  const roots = { officialRoot, userRoot, workspaceRoots: workspaceRoots || {} };
  const key = catalogRootsKey(roots);

  const workspaceEntries = Object.entries(roots.workspaceRoots)
    .filter(([agentId, root]) => typeof agentId === 'string' && agentId.trim() && root);

  // stat 摘要先行：全部根一致时直接复用快照（见缓存头注的失效纪律）
  const stamp = {
    official: await statRootStamp(roots.officialRoot),
    custom: await statRootStamp(roots.userRoot),
    workspace: await Promise.all(workspaceEntries.map(async ([agentId, root]) => ({
      agentId,
      stamp: await statRootStamp(root),
    }))),
  };
  const cached = catalogCache.get(key);
  if (cached && stampEquals(cached.stamp, stamp)) return cached.value;
  const inflight = catalogInflight.get(key);
  if (inflight) return inflight;

  const task = (async () => {
    const [official, custom, ...workspaces] = await Promise.all([
      scanRoot(roots.officialRoot, 'official'),
      scanRoot(roots.userRoot, 'custom'),
      ...workspaceEntries.map(([agentId, root]) => scanRoot(root, 'workspace').then(
        (entries) => entries.map((entry) => ({ ...entry, scopeAgentId: agentId })),
      )),
    ]);
    const all = [...official, ...custom, ...workspaces.flat()];
    const invalid = all.filter((entry) => entry.error);
    const packages = new Map();
    for (const entry of all) {
      if (entry.error) continue;
      const versions = packages.get(entry.packageName) || [];
      versions.push({ ...entry, scopeAgentId: entry.scopeAgentId || null });
      packages.set(entry.packageName, versions);
    }
    for (const versions of packages.values()) {
      versions.sort((left, right) => {
        const sourceScore = (SOURCE_PRIORITY[right.source] || 0) - (SOURCE_PRIORITY[left.source] || 0);
        if (sourceScore !== 0) return sourceScore;
        return compareSemver(right.version, left.version);
      });
    }
    const value = { packages, invalid };
    if (catalogCache.size >= CATALOG_CACHE_LIMIT) {
      catalogCache.delete(catalogCache.keys().next().value);
    }
    catalogCache.set(key, { stamp, value });
    return value;
  })().finally(() => catalogInflight.delete(key));
  catalogInflight.set(key, task);
  return task;
}

/**
 * 生产扫描根：显式注入 catalogRoots 时原样返回（测试隔离完全控制，不读真实
 * 用户目录）；未注入时按身份集合补各空间私有仓根。
 */
export function catalogRootsWithWorkspaceRepositories(catalogRoots, agentIds) {
  if (catalogRoots) return catalogRoots;
  const workspaceRoots = {};
  for (const agentId of agentIds || []) {
    if (agentId) workspaceRoots[agentId] = workspaceFeatureRepositoryRoot(agentId);
  }
  return { workspaceRoots };
}

/** 条目对某身份是否可见：全局条目（scopeAgentId=null）对所有身份可见。 */
export function isCatalogEntryVisibleTo(entry, agentId) {
  const scopeAgentId = entry?.scopeAgentId;
  if (!scopeAgentId) return true;
  return !agentId || scopeAgentId === agentId;
}

export function resolveCatalogPackage(catalog, { packageName, version, allowLatest = false, agentId = null }) {
  const versions = (catalog?.packages?.get(packageName) || [])
    .filter((entry) => isCatalogEntryVisibleTo(entry, agentId));
  if (versions.length === 0) throw new Error(`Feature 仓库中不存在包：${packageName}`);
  if (version) {
    const exact = versions.find((entry) => entry.version === version);
    if (!exact) throw new Error(`Feature 仓库中不存在 ${packageName}@${version}`);
    return exact;
  }
  if (!allowLatest) throw new Error(`必须为 ${packageName} 指定精确版本。`);
  return versions[0];
}
