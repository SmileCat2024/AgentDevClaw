import path from 'path';
import { existsSync, mkdirSync, promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import multer from 'multer';
import {
  PROJECT_ROOT,
  USER_DATA_ROOT,
  FEATURE_REPOSITORY_ROOT,
  USER_FEATURE_REPOSITORY_ROOT,
  FEATURE_MANIFEST_NAME,
  workspaceFeatureRepositoryRoot,
} from '../shared/constants.js';
import { ensureDir, readJson } from '../shared/fs-helpers.js';
import { compareSemver, uniqueStrings } from '../shared/feature-utils.js';
import { summarizeArchive } from '../feature-runtime/catalog.js';
import { gunzipFileToBuffer, readTarEntry } from '../shared/tgz-archive.js';
import { extractClientAssets, extractServerAssets } from '../feature-runtime/feature-assets.js';
import { IDENTITY_SCOPES } from '../feature-runtime/install-service.js';
import { buildScopeLayers } from './feature-config.js';
import { extractFeatureMounts } from '../shared/feature-mount.js';
import { notifyPluginServerDirty } from '../shared/plugin-server-bus.js';

/* ── feature metadata helpers ─────────────────────────────────────── */

function normalizeFeatureRequirements(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    platforms: uniqueStrings(source.platforms),
    node: typeof source.node === 'string' ? source.node.trim() : '',
    external: uniqueStrings(source.external),
    services: uniqueStrings(source.services),
  };
}

function normalizeFeatureTypes(values) {
  const allowed = new Set(['tools', 'mcp', 'hooks', 'control', 'rollback', 'ability', 'governance', 'interface', 'system']);
  return uniqueStrings(values).filter((value) => allowed.has(value));
}

function normalizeFeatureCompatibility(raw = {}, featureTypes = []) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const rollback = typeof source.rollback === 'boolean'
    ? source.rollback
    : featureTypes.includes('rollback');

  return {
    rollback,
    tags: uniqueStrings([
      ...(Array.isArray(source.tags) ? source.tags : []),
      rollback ? 'supports-rollback' : 'no-rollback',
    ]),
  };
}

function inferFeatureTypes(pkg, baseId) {
  const packageName = String(pkg?.name || '').trim();
  const lowerBaseId = String(baseId || '').toLowerCase();

  if (packageName.startsWith('@sliverp/')) {
    return [];
  }
  if (/(shell|websearch|visual|tts|lsp|memory)/i.test(lowerBaseId)) {
    return ['tools'];
  }
  if (/(audio-feedback|audit|plugin-compat)/i.test(lowerBaseId)) {
    return ['hooks'];
  }
  if (/qqbot/i.test(lowerBaseId)) {
    return ['hooks', 'control'];
  }
  return [];
}

export function normalizeClawManifestV2(pkg) {
  const raw = pkg?.agentdev;
  // v3 = v2 + 插件三面声明（export/ui/server，ADR-0045）：v2 校验字段全部
  // 沿用；三面字段不在此透出（catalog 直接读 tgz 顶层 manifest）。
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw.schemaVersion !== 2 && raw.schemaVersion !== 3)) return null;
  if (typeof raw.id !== 'string' || !raw.id.trim()) return null;
  const displayName = raw.displayName && typeof raw.displayName === 'object'
    ? raw.displayName
    : null;
  return {
    id: typeof raw.id === 'string' ? raw.id.trim() : '',
    name: typeof displayName?.zh === 'string' ? displayName.zh.trim() : (typeof raw.id === 'string' ? raw.id.trim() : ''),
    displayName, 
    type: typeof raw.type === 'string' ? raw.type.trim() : '',
    capabilities: uniqueStrings(raw.capabilities),
    provides: raw.provides && typeof raw.provides === 'object' && !Array.isArray(raw.provides) ? raw.provides : null,
    depends: Array.isArray(raw.depends) ? raw.depends : [],
    version: typeof pkg.version === 'string' ? pkg.version.trim() : '',
    description: typeof pkg.description === 'string' ? pkg.description.trim() : '',
    tags: uniqueStrings(pkg.keywords),
    entry: typeof pkg.main === 'string' ? pkg.main.trim() : '',
    homepage: typeof pkg.homepage === 'string' ? pkg.homepage.trim() : '',
    repository: typeof pkg.repository === 'string' ? pkg.repository.trim() : (typeof pkg.repository?.url === 'string' ? pkg.repository.url.trim() : ''),
    agentdev: { compatible: typeof pkg.engines?.agentdev === 'string' ? pkg.engines.agentdev.trim() : '' },
    featureTypes: typeof raw.type === 'string' ? [raw.type.trim()] : [],
    compatibility: normalizeFeatureCompatibility(raw.compatibility, []),
    requirements: normalizeFeatureRequirements(raw.requirements),
  };
}

function inferFeatureManifest(pkg, archiveName) {
  const packageName = typeof pkg?.name === 'string' ? pkg.name.trim() : '';
  const baseId = packageName
    ? packageName.split('/').pop()
    : archiveName.replace(/\.tgz$/i, '');
  const tags = uniqueStrings(pkg?.keywords);
  const featureTypes = inferFeatureTypes(pkg, baseId);
  const dependencyNames = Object.keys(pkg?.dependencies || {});
  const requirements = {
    platforms: [],
    node: '',
    external: [],
    services: [],
  };

  if (typeof pkg?.engines?.node === 'string' && pkg.engines.node.trim()) {
    requirements.node = pkg.engines.node.trim();
  }
  if (dependencyNames.includes('openai') || /websearch|visual|tts/i.test(baseId)) {
    requirements.services.push('network');
  }
  if (/shell/i.test(baseId)) {
    requirements.external.push('system-shell');
  }
  if (/audio|tts/i.test(baseId) || dependencyNames.includes('sound-play')) {
    requirements.external.push('audio-output');
  }
  if (/visual/i.test(baseId)) {
    requirements.external.push('desktop-capture');
  }
  if (/lsp/i.test(baseId)) {
    requirements.external.push('language-server');
  }
  if (/qqbot/i.test(baseId)) {
    requirements.services.push('qqbot');
  }

  return {
    schemaVersion: 1,
    id: baseId,
    name: baseId,
    version: typeof pkg?.version === 'string' ? pkg.version.trim() : '',
    description: typeof pkg?.description === 'string' ? pkg.description.trim() : '',
    tags,
    entry: typeof pkg?.main === 'string' ? pkg.main.trim() : '',
    agentdev: {
      compatible: typeof pkg?.peerDependencies?.agentdev === 'string'
        ? pkg.peerDependencies.agentdev.trim()
        : '',
    },
    homepage: typeof pkg?.homepage === 'string' ? pkg.homepage.trim() : '',
    repository: typeof pkg?.repository === 'string'
      ? pkg.repository.trim()
      : (typeof pkg?.repository?.url === 'string' ? pkg.repository.url.trim() : ''),
    featureTypes,
    compatibility: normalizeFeatureCompatibility({}, featureTypes),
    requirements,
  };
}

export async function ensureFeatureProjectManifest(projectDir) {
  const packageJsonPath = path.join(projectDir, 'package.json');
  const manifestPath = path.join(projectDir, FEATURE_MANIFEST_NAME);
  const pkg = await readJson(packageJsonPath);
  const existingManifest = await readJson(manifestPath).catch(() => null);
  const inferred = inferFeatureManifest(pkg, `${path.basename(projectDir)}.tgz`);
  // package.json.agentdev（studio_create_feature 写入的 v2/v3 声明）是顶层
  // manifest 的第二来源：studio 项目不手工维护顶层文件，三面静态声明
  //（export / ui / server / settings）只能经此处进入 tgz——历史缺口：
  // studio 制造的包 settings/ui/server 全部丢失（AGENTER.md ADR-0045 P4）。
  const agentdevMeta = pkg?.agentdev && typeof pkg.agentdev === 'object' && !Array.isArray(pkg.agentdev)
    ? pkg.agentdev
    : {};
  const metaSource = (field) => {
    const fromExisting = existingManifest?.[field];
    if (fromExisting !== undefined && fromExisting !== null) return fromExisting;
    return agentdevMeta[field];
  };
  const featureTypes = normalizeFeatureTypes(existingManifest?.featureTypes || inferred.featureTypes);
  const manifest = {
    schemaVersion: 1,
    id: typeof existingManifest?.id === 'string' && existingManifest.id.trim() ? existingManifest.id.trim() : inferred.id,
    name: typeof existingManifest?.name === 'string' && existingManifest.name.trim() ? existingManifest.name.trim() : inferred.name,
    version: typeof pkg?.version === 'string' ? pkg.version.trim() : inferred.version,
    description: typeof existingManifest?.description === 'string' && existingManifest.description.trim()
      ? existingManifest.description.trim()
      : inferred.description,
    tags: uniqueStrings([...(existingManifest?.tags || []), ...(pkg?.keywords || [])]),
    entry: typeof existingManifest?.entry === 'string' && existingManifest.entry.trim()
      ? existingManifest.entry.trim()
      : inferred.entry,
    homepage: typeof existingManifest?.homepage === 'string' && existingManifest.homepage.trim()
      ? existingManifest.homepage.trim()
      : inferred.homepage,
    repository: typeof existingManifest?.repository === 'string' && existingManifest.repository.trim()
      ? existingManifest.repository.trim()
      : inferred.repository,
    agentdev: {
      compatible: typeof existingManifest?.agentdev?.compatible === 'string' && existingManifest.agentdev.compatible.trim()
        ? existingManifest.agentdev.compatible.trim()
        : inferred.agentdev.compatible,
    },
    featureTypes,
    compatibility: normalizeFeatureCompatibility(existingManifest?.compatibility, featureTypes),
    requirements: normalizeFeatureRequirements(existingManifest?.requirements || inferred.requirements),
  };
  // v3 插件声明面（export / ui / server / settings）透传，优先级：顶层
  // manifest 文件 > package.json.agentdev > 丢弃。export 丢失使 $mount 装配
  // 后 runtime 启动炸（入口多命名导出时 loader 无法唯一确定），ui / server /
  // settings 丢失使面板声明、数据面声明与配置面板渲染失效。
  const exportName = typeof metaSource('export') === 'string' && metaSource('export').trim()
    ? metaSource('export').trim()
    : '';
  if (exportName) manifest.export = exportName;
  for (const v3Field of ['ui', 'server', 'settings']) {
    const value = metaSource(v3Field);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      manifest[v3Field] = value;
    }
  }

  for (const field of ['features', 'pluginSettings']) {
    const value = metaSource(field);
    if (value !== undefined) manifest[field] = value;
  }

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  if (Array.isArray(pkg.files) && !pkg.files.includes(FEATURE_MANIFEST_NAME)) {
    await fs.writeFile(packageJsonPath, `${JSON.stringify({
      ...pkg,
      files: uniqueStrings([...pkg.files, FEATURE_MANIFEST_NAME]),
    }, null, 2)}\n`, 'utf8');
  }

  return {
    manifestPath,
    packageJsonPath,
  };
}

/* ── archive & repository summarization ───────────────────────────── */

async function readArchiveJson(archivePath, archiveEntryPath) {
  // 纯 Node 读取（shared/tgz-archive，与 catalog.js 同步收口）：Windows 双 tar
  // 并存导致 spawn tar CLI 的 PATH 解析因启动环境而异（GNU 需 --force-local、
  // bsdtar 不支持），彻底移除 CLI 依赖。
  const tarBuffer = await gunzipFileToBuffer(archivePath);
  const data = readTarEntry(tarBuffer, archiveEntryPath);
  if (!data || data.length === 0) {
    throw new Error(`Archive entry is empty: ${archiveEntryPath}`);
  }
  return JSON.parse(data.toString('utf8'));
}

export async function summarizeFeatureArchive(archivePath, archiveName, source = 'custom') {
  const stat = await fs.stat(archivePath);
  let pkg = null;
  let manifest = null;
  const warnings = [];

  try {
    pkg = await readArchiveJson(archivePath, 'package/package.json');
  } catch (error) {
    return {
      id: archiveName.replace(/\.tgz$/i, ''),
      name: archiveName.replace(/\.tgz$/i, ''),
      packageName: '',
      description: '',
      latestVersion: '',
      version: '',
      updatedAt: stat.mtime.toISOString(),
      archiveCount: 1,
      size: stat.size,
      tags: [],
      featureTypes: [],
      compatibility: normalizeFeatureCompatibility({}, []),
      requirements: normalizeFeatureRequirements(),
      homepage: '',
      repository: '',
      entry: '',
      agentdev: {},
      manifestPresent: false,
      ui: null,
      server: null,
      warningCount: 1,
      source,
      warnings: [`无法读取 package.json: ${error instanceof Error ? error.message : String(error)}`],
      fileName: archiveName,
    };
  }

  try {
    manifest = await readArchiveJson(archivePath, `package/${FEATURE_MANIFEST_NAME}`);
  } catch {
    manifest = null;
  }

  const v2Manifest = normalizeClawManifestV2(pkg);
  const normalizedManifest = v2Manifest || manifest || inferFeatureManifest(pkg, archiveName);
  const inferredFeatureTypes = inferFeatureTypes(pkg, normalizedManifest.id || pkg.name || archiveName);
  const featureTypes = normalizeFeatureTypes(normalizedManifest.featureTypes || inferredFeatureTypes);
  if (!v2Manifest && !manifest) {
    warnings.push(`缺少 Claw Manifest v2（package.json.agentdev）；当前仅展示有限推断信息。`);
  }

  return {
    id: String(normalizedManifest.id || pkg.name || archiveName.replace(/\.tgz$/i, '')).trim(),
    name: String(normalizedManifest.name || normalizedManifest.id || pkg.name || archiveName.replace(/\\.tgz$/i, '')).trim(),
    displayName: v2Manifest?.displayName || null,
    packageName: String(pkg.name || '').trim(),
    description: String(normalizedManifest.description || pkg.description || '').trim(),
    latestVersion: String(normalizedManifest.version || pkg.version || '').trim(),
    version: String(normalizedManifest.version || pkg.version || '').trim(),
    updatedAt: stat.mtime.toISOString(),
    archiveCount: 1,
    size: stat.size,
    tags: uniqueStrings([...(normalizedManifest.tags || []), ...(pkg.keywords || [])]),
    featureTypes,
    type: v2Manifest?.type || '',
    capabilities: v2Manifest?.capabilities || [],
    provides: v2Manifest?.provides || null,
    depends: v2Manifest?.depends || [],
    compatibility: normalizeFeatureCompatibility(normalizedManifest.compatibility, featureTypes),
    requirements: normalizeFeatureRequirements(normalizedManifest.requirements),
    homepage: typeof normalizedManifest.homepage === 'string' ? normalizedManifest.homepage.trim() : '',
    repository: typeof normalizedManifest.repository === 'string' ? normalizedManifest.repository.trim() : '',
    entry: typeof normalizedManifest.entry === 'string' ? normalizedManifest.entry.trim() : '',
    agentdev: typeof normalizedManifest.agentdev === 'object' && normalizedManifest.agentdev ? normalizedManifest.agentdev : {},
    manifestPresent: !!manifest,
    // manifest v3（ADR-0045）：ui/server 面从原始 manifest 原样透出（v2 规范化
    // 不携带），导入确认页据此展示三面摘要；无 v3 声明的包两个字段为 null
    ui: manifest?.ui && typeof manifest.ui === 'object' && !Array.isArray(manifest.ui) ? manifest.ui : null,
    server: manifest?.server && typeof manifest.server === 'object' && !Array.isArray(manifest.server) ? manifest.server : null,
    warningCount: warnings.length,
    source,
    warnings,
    fileName: archiveName,
  };
}

export async function summarizeFeatureRepository(rawPath, source) {
  const resolvedPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(PROJECT_ROOT, rawPath);

  try {
    const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
    const archives = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.tgz'));
    const packageSummaries = await Promise.all(archives.map(async (entry) => {
      const archivePath = path.join(resolvedPath, entry.name);
      const stat = await fs.stat(archivePath);
      let pkg = null;
      let manifest = null;

      try {
        pkg = await readArchiveJson(archivePath, 'package/package.json');
      } catch (error) {
        return {
          id: entry.name.replace(/\.tgz$/i, ''),
          name: entry.name.replace(/\.tgz$/i, ''),
          packageName: '',
          description: '',
          latestVersion: '',
          updatedAt: stat.mtime.toISOString(),
          archiveCount: 1,
          size: stat.size,
          tags: [],
          featureTypes: [],
          compatibility: normalizeFeatureCompatibility({}, []),
          requirements: normalizeFeatureRequirements(),
          homepage: '',
          repository: '',
          manifestPresent: false,
          warningCount: 1,
          warnings: [`无法读取 package.json: ${error instanceof Error ? error.message : String(error)}`],
          versions: [{
            fileName: entry.name,
            version: '',
            size: stat.size,
            updatedAt: stat.mtime.toISOString(),
            manifestPresent: false,
            warnings: ['package.json 缺失或损坏'],
          }],
        };
      }

      try {
        manifest = await readArchiveJson(archivePath, `package/${FEATURE_MANIFEST_NAME}`);
      } catch {
        manifest = null;
      }

        const v2Manifest = normalizeClawManifestV2(pkg);
        const normalizedManifest = v2Manifest || manifest || inferFeatureManifest(pkg, entry.name);
        const inferredFeatureTypes = inferFeatureTypes(pkg, normalizedManifest.id || pkg.name || entry.name);
        const featureTypes = normalizeFeatureTypes(normalizedManifest.featureTypes || inferredFeatureTypes);
        const warnings = [];
        if (!v2Manifest && !manifest) {
          warnings.push('缺少 Claw Manifest v2（package.json.agentdev）；当前仅展示有限推断信息。');
        }

      return {
        id: String(normalizedManifest.id || pkg.name || entry.name.replace(/\\.tgz$/i, '')).trim(),
        name: String(normalizedManifest.name || normalizedManifest.id || pkg.name || entry.name.replace(/\\.tgz$/i, '')).trim(),
        displayName: v2Manifest?.displayName || null,
        packageName: String(pkg.name || '').trim(),
        description: String(normalizedManifest.description || pkg.description || '').trim(),
        version: String(normalizedManifest.version || pkg.version || '').trim(),
        updatedAt: stat.mtime.toISOString(),
        size: stat.size,
        tags: uniqueStrings([...(normalizedManifest.tags || []), ...(pkg.keywords || [])]),
        featureTypes,
        type: v2Manifest?.type || '',
        capabilities: v2Manifest?.capabilities || [],
        provides: v2Manifest?.provides || null,
        depends: v2Manifest?.depends || [],
        compatibility: normalizeFeatureCompatibility(normalizedManifest.compatibility, featureTypes),
        requirements: normalizeFeatureRequirements(normalizedManifest.requirements),
        homepage: typeof normalizedManifest.homepage === 'string' ? normalizedManifest.homepage.trim() : '',
        repository: typeof normalizedManifest.repository === 'string' ? normalizedManifest.repository.trim() : '',
        entry: typeof normalizedManifest.entry === 'string' ? normalizedManifest.entry.trim() : '',
        agentdev: typeof normalizedManifest.agentdev === 'object' && normalizedManifest.agentdev
          ? normalizedManifest.agentdev
          : {},
        manifestPresent: !!manifest,
        warnings,
        fileName: entry.name,
      };
    }));

    const groups = new Map();
    for (const item of packageSummaries) {
      const groupId = item.packageName || item.id;
      if (!groups.has(groupId)) {
        groups.set(groupId, []);
      }
      groups.get(groupId).push(item);
    }

    const packages = [...groups.values()].map((group) => {
      const versions = [...group].sort((left, right) => {
        const semverDiff = compareSemver(right.version, left.version);
        if (semverDiff !== 0) return semverDiff;
        return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
      });
      const latest = versions[0];
      const warnings = uniqueStrings([
        ...versions.flatMap((item) => item.warnings || []),
        versions.some((item) => !item.manifestPresent) ? '部分版本缺少 feature 元数据。' : '',
      ]);

      return {
        id: latest.id,
        name: latest.name,
        packageName: latest.packageName,
        description: latest.description,
        latestVersion: latest.version,
        updatedAt: latest.updatedAt,
        archiveCount: versions.length,
        size: latest.size,
        tags: uniqueStrings(versions.flatMap((item) => item.tags || [])),
        featureTypes: latest.featureTypes || [],
        displayName: latest.displayName || null,
        type: latest.type || '',
        capabilities: latest.capabilities || [],
        provides: latest.provides || null,
        depends: latest.depends || [],
        compatibility: latest.compatibility || normalizeFeatureCompatibility({}, latest.featureTypes || []),
        requirements: latest.requirements || normalizeFeatureRequirements(),
        homepage: latest.homepage,
        repository: latest.repository,
        entry: latest.entry,
        agentdev: latest.agentdev || {},
        manifestPresent: versions.every((item) => item.manifestPresent),
        warningCount: warnings.length,
        source: source || 'official',
        warnings,
        versions: versions.map((item) => ({
          fileName: item.fileName,
          version: item.version,
          updatedAt: item.updatedAt,
          size: item.size,
          manifestPresent: item.manifestPresent,
          warnings: item.warnings || [],
        })),
      };
    }).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));

    return {
      path: resolvedPath,
      exists: true,
      type: 'feature-repository',
      packageCount: packages.length,
      archiveCount: archives.length,
      missingManifestCount: packageSummaries.filter((item) => !item.manifestPresent).length,
      updatedAt: packages.reduce((latest, item) => {
        if (!latest) return item.updatedAt;
        return new Date(item.updatedAt).getTime() > new Date(latest).getTime() ? item.updatedAt : latest;
      }, null),
      packages,
    };
  } catch (error) {
    return {
      path: resolvedPath,
      exists: false,
      type: 'feature-repository',
      packageCount: 0,
      archiveCount: 0,
      missingManifestCount: 0,
      updatedAt: null,
      packages: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function mergeFeatureRepositoryPackages(...catalogs) {
  const groups = new Map();
  for (const catalog of catalogs) {
    const packages = Array.isArray(catalog?.packages) ? catalog.packages : [];
    for (const item of packages) {
      const key = String(item?.packageName || item?.id || '').trim().toLowerCase();
      if (!key) continue;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(item);
    }
  }

  return Array.from(groups.values()).map((group) => {
    const sorted = [...group].sort((left, right) => {
      const sourceScore = (right?.source === 'custom') - (left?.source === 'custom');
      if (sourceScore !== 0) return sourceScore;
      const versionScore = compareSemver(String(right?.latestVersion || ''), String(left?.latestVersion || ''));
      if (versionScore !== 0) return versionScore;
      const t1 = new Date(String(right?.updatedAt || 0)).getTime() || 0;
      const t2 = new Date(String(left?.updatedAt || 0)).getTime() || 0;
      return t1 - t2;
    });
    const preferred = sorted[0];
    const warnings = uniqueStrings(sorted.flatMap((item) => Array.isArray(item?.warnings) ? item.warnings : []));
    return {
      ...preferred,
      source: preferred.source || 'official',
      warnings,
      warningCount: warnings.length,
      duplicateSources: uniqueStrings(sorted.map((item) => String(item?.source || '').trim()).filter(Boolean)),
      versions: Array.isArray(preferred.versions) ? preferred.versions : [],
    };
  }).sort((left, right) => String(left?.name || '').localeCompare(String(right?.name || ''), 'zh-CN'));
}

/** 列出仓库根下的 tgz（packageId = 去掉扩展名的文件名，兼容旧调用形态）。 */
async function listRepositoryArchives(root, source) {
  const archives = [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return archives; // 仓库目录不存在（如该空间从未导入过私有包）
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.tgz')) continue;
    archives.push({
      archivePath: path.join(root, entry.name),
      fileName: entry.name,
      packageId: entry.name.replace(/\.tgz$/i, ''),
      source,
    });
  }
  return archives;
}

/**
 * 收集某包在装配层里的引用（ADR-0046 决策 5：仓库删除 tgz 前必须无任何层级
 * 装配引用）。scopeAgentId 给定时只查该工作空间层（空间私有包只与本空间装配
 * 相关，全局默认装配引用的是全局库存包，不挡私有包删除）；未给定时查全部
 * 装配身份的全部层（含 global 默认装配源）。
 */
function collectAssemblyReferences(packageName, scopeAgentId) {
  const agentIds = new Map();
  if (scopeAgentId) {
    agentIds.set(scopeAgentId, scopeAgentId);
  } else {
    for (const scope of Object.values(IDENTITY_SCOPES)) agentIds.set(scope.agentId, scope.agentId);
  }
  const references = [];
  for (const agentId of agentIds.values()) {
    let layers;
    try {
      ({ layers } = buildScopeLayers({ agentId }));
    } catch {
      continue; // 未注册身份 / 层文件损坏：跳过，不挡删除
    }
    for (const layer of layers) {
      if (scopeAgentId && layer.id === 'global') continue;
      let mounts;
      try {
        ({ mounts } = extractFeatureMounts([{ id: layer.id, config: layer.sparse || {} }]));
      } catch {
        continue;
      }
      for (const [runtimeName, mount] of mounts) {
        if (mount.kind === 'builtin' || mount.package !== packageName) continue;
        references.push({ agentId, layerId: layer.id, runtimeName, version: mount.version });
      }
    }
  }
  // global 层会随每个身份的层清单重复出现，按声明身份去重
  const seen = new Set();
  return references.filter((ref) => {
    const key = `${ref.layerId}|${ref.agentId}|${ref.runtimeName}|${ref.version}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 解析待删档案的包坐标（文件名 → package/version）。坏包（tar 损坏 / 缺
 * package.json）返回空坐标，仅按文件名匹配删除——这类包本来也无法装配。
 */
async function resolveArchiveCoordinates(archive) {
  try {
    const summary = await summarizeArchive(archive.archivePath, archive.fileName, archive.source);
    return { ...archive, packageName: summary.packageName, version: summary.version };
  } catch {
    return { ...archive, packageName: '', version: '' };
  }
}

/* ── route setup ──────────────────────────────────────────────────── */

const pendingFeatureImports = new Map();

/**
 * 导入归属：agentId 为空 = 全局用户仓库；否则落该工作空间私有仓库
 * （ADR-0046 空间级仓库：只有该空间可见、可装配）。agentId 仅作目录名，
 * 非法字符统一安全化，不接受路径段。
 */
function importTargetRoot(agentId) {
  const id = String(agentId || '').trim();
  return id ? workspaceFeatureRepositoryRoot(id) : USER_FEATURE_REPOSITORY_ROOT;
}

/** 上传/导入携带的归属标识规范：仅允许注册表形态的简单 ID。 */
function normalizeImportAgentId(raw) {
  const id = String(raw || '').trim();
  if (!id) return '';
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw Object.assign(new Error('agentId 非法（仅允许字母/数字/连字符/下划线）'), { statusCode: 400 });
  }
  return id;
}

/* ── 分片上传（chunked upload）──────────────────────────────────────
 * 公网部署常经反向代理暴露（如 nginx 默认 client_max_body_size 仅
 * 1MB），单请求传大 tgz 会在到达应用前被网关以 413 拒绝。行业标准解
 * 法是分片上传（S3 Multipart / tus 同思路）：客户端把包切成小于常见
 * 网关默认限制的块逐块传输，服务端拼装后走与 parse_upload 完全相同
 * 的解析 → confirm / cancel 流程（uploadId 语义不变，前端后半段无感）。
 * 单片请求保持小体积同时规避了慢速公网下 Node 默认 5 分钟
 * requestTimeout 对整请求接收期的约束。 */
const CHUNK_UPLOAD_MAX_TOTAL_BYTES = 512 * 1024 * 1024; // 单个插件包上限
const CHUNK_UPLOAD_MAX_CHUNKS = 4096;
const CHUNK_UPLOAD_CHUNK_LIMIT_BYTES = 2 * 1024 * 1024; // 分片级 multer 兜底上限
const UPLOAD_SESSION_TTL_MS = 30 * 60_000; // 会话超龄即清理（含 parse 待确认态）
const UPLOAD_SESSION_SWEEP_INTERVAL_MS = 5 * 60_000;

// uploadId → { dir, originalName, totalChunks, totalSize, createdAt, updatedAt }
const chunkUploadSessions = new Map();

/** 清理超龄的上传会话与临时文件（分片中 / 待确认 / 重启孤儿）。测试可直接注入 now / ttlMs / uploadsRoot。 */
export async function cleanupStaleUploadSessions({ now = Date.now(), ttlMs = UPLOAD_SESSION_TTL_MS, uploadsRoot = null } = {}) {
  for (const [id, session] of chunkUploadSessions) {
    if (now - session.updatedAt <= ttlMs) continue;
    chunkUploadSessions.delete(id);
    await fs.rm(session.dir, { recursive: true, force: true }).catch(e => console.warn('[feature-repository] stale chunk session cleanup failed:', e?.message || e));
  }
  for (const [id, pending] of pendingFeatureImports) {
    if (now - pending.createdAt <= ttlMs) continue;
    pendingFeatureImports.delete(id);
    await fs.rm(pending.tempPath, { force: true }).catch(e => console.warn('[feature-repository] stale pending import cleanup failed:', e?.message || e));
  }
  if (!uploadsRoot) return;
  // 重启孤儿：uploads 下不属于任何活跃会话且超龄的文件 / 目录（进程崩溃残留）
  const live = new Set([...chunkUploadSessions.values()].map(session => session.dir));
  for (const pending of pendingFeatureImports.values()) live.add(pending.tempPath);
  let entries;
  try {
    entries = await fs.readdir(uploadsRoot, { withFileTypes: true });
  } catch {
    return; // 目录不存在：无孤儿可清
  }
  for (const entry of entries) {
    const full = path.join(uploadsRoot, entry.name);
    if (live.has(full)) continue;
    const stat = await fs.stat(full).catch(() => null);
    if (stat && now - stat.mtimeMs > ttlMs) {
      await fs.rm(full, { recursive: true, force: true }).catch(e => console.warn('[feature-repository] orphan upload cleanup failed:', e?.message || e));
    }
  }
}

let uploadSweeperTimer = null;
function ensureUploadSweeper(uploadsRoot) {
  if (uploadSweeperTimer) return;
  uploadSweeperTimer = setInterval(() => {
    void cleanupStaleUploadSessions({ uploadsRoot })
      .catch(e => console.warn('[feature-repository] upload sweep failed:', e?.message || e));
  }, UPLOAD_SESSION_SWEEP_INTERVAL_MS);
  uploadSweeperTimer.unref?.();
}

export function setupFeatureRepositoryRoutes(app, express, options = {}) {
  const uploadsRoot = options.uploadsRoot || path.join(USER_DATA_ROOT, 'uploads');
  mkdirSync(uploadsRoot, { recursive: true });
  // 整包直传（parse_upload / upload）：本地直连场景无网关限制，上限取单包上限
  const upload = multer({ dest: uploadsRoot, limits: { fileSize: CHUNK_UPLOAD_MAX_TOTAL_BYTES } });
  // 分片直传（chunk_append）：每片必须保持小体积，上限独立收紧
  const chunkUpload = multer({ dest: uploadsRoot, limits: { fileSize: CHUNK_UPLOAD_CHUNK_LIMIT_BYTES } });
  ensureUploadSweeper(uploadsRoot);

  /**
   * 删除仓库 tgz（ADR-0046 决策 5）。两种定位方式：
   * - { packageName, version? }：按包坐标删除（插件管理器 / 工作空间商店）；
   *   版本缺省 = 删该包的全部版本；
   * - { packageId }：按仓库文件名删除（旧调用形态，Feature 仓库视图右键）。
   * agentId 给定时只在该空间私有仓库内查找删除，否则在官方 + 用户仓库内查找。
   * 前置检查：仍被装配层引用的包拒绝删除（409 + references），避免装配悬空。
   */
  app.post('/protoclaw/feature_repository/delete', express.json(), async (req, res, next) => {
    try {
      const packageId = String(req.body.packageId || '').trim();
      const packageName = String(req.body.packageName || '').trim();
      const version = String(req.body.version || '').trim();
      if (!packageId && !packageName) {
        res.status(400).json({ error: 'packageName 或 packageId is required' });
        return;
      }
      const scopeAgentId = normalizeImportAgentId(req.body.agentId);

      const roots = scopeAgentId
        ? [{ root: workspaceFeatureRepositoryRoot(scopeAgentId), source: 'workspace' }]
        : [
          { root: FEATURE_REPOSITORY_ROOT, source: 'official' },
          { root: USER_FEATURE_REPOSITORY_ROOT, source: 'custom' },
        ];
      const archives = (await Promise.all(roots.map(({ root, source }) => listRepositoryArchives(root, source)))).flat();
      const byFile = packageId ? archives.filter((archive) => archive.packageId === packageId) : archives;
      const resolved = await Promise.all(byFile.map((archive) => resolveArchiveCoordinates(archive)));
      const targets = resolved.filter((archive) => {
        if (packageName && archive.packageName !== packageName) return false;
        if (version && archive.version !== version) return false;
        if (!packageName && !packageId) return false;
        return true;
      });
      if (targets.length === 0) {
        res.status(404).json({ error: '未找到匹配的插件包（可能已删除或坐标不符）' });
        return;
      }

      // 前置检查：仍被装配引用的包拒绝删除，返回引用明细由前端提示先移除装配
      const blocked = [];
      for (const target of targets) {
        if (!target.packageName) continue;
        const references = collectAssemblyReferences(target.packageName, scopeAgentId);
        if (references.length) blocked.push({ packageName: target.packageName, version: target.version, references });
      }
      if (blocked.length) {
        res.status(409).json({
          error: '插件仍被装配，请先移除装配再删除',
          code: 'package_in_use',
          blocked,
        });
        return;
      }

      const deleted = [];
      for (const target of targets) {
        await fs.unlink(target.archivePath);
        deleted.push({ path: target.archivePath, source: target.source, packageName: target.packageName, version: target.version });
      }
      // 包删除：装配引用悬空的数据面前缀应摘除（防御性重建）
      notifyPluginServerDirty(`删除 ${packageName || packageId}`);
      res.json({ deleted });
    } catch (error) {
      next(error);
    }
  });

  app.post('/protoclaw/feature_repository/parse_upload', upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }

      const tempPath = req.file.path;
      const originalName = path.basename(req.file.originalname || '');
      if (!originalName.toLowerCase().endsWith('.tgz')) {
        await fs.unlink(tempPath).catch(e => console.warn(e));
        res.status(400).json({ error: 'Only .tgz files are allowed' });
        return;
      }

      const uploadId = randomUUID();
      const agentId = normalizeImportAgentId(req.body?.agentId);
      const summary = await summarizeFeatureArchive(tempPath, originalName, agentId ? 'workspace' : 'custom');
      pendingFeatureImports.set(uploadId, {
        tempPath,
        originalName,
        summary,
        agentId,
        createdAt: Date.now(),
      });
      res.json({ uploadId, summary });
    } catch (error) {
      if (req.file?.path) {
        await fs.unlink(req.file.path).catch(e => console.warn(e));
      }
      next(error);
    }
  });

  app.post('/protoclaw/feature_repository/confirm_import', express.json(), async (req, res, next) => {
    try {
      const uploadId = String(req.body?.uploadId || '').trim();
      const pending = pendingFeatureImports.get(uploadId);
      if (!pending) {
        res.status(404).json({ error: 'Unknown or expired import' });
        return;
      }

      pendingFeatureImports.delete(uploadId);
      // 归属目标：全局用户仓库，或该工作空间私有仓库（只有本空间可见可装配）
      const targetRoot = importTargetRoot(pending.agentId);
      await ensureDir(targetRoot);
      const safeName = path.basename(pending.originalName).replace(/[^a-zA-Z0-9._@+-]+/g, '-');
      let targetPath = path.join(targetRoot, safeName);
      if (existsSync(targetPath)) {
        const parsed = path.parse(safeName);
        targetPath = path.join(targetRoot, `${parsed.name}-${Date.now()}${parsed.ext || '.tgz'}`);
      }
      await fs.rename(pending.tempPath, targetPath);

      // 插件面资产解出（ADR-0045 P1/P2）：manifest v3 带 ui.panels 的包
      // 解出 client/（浏览器资产），带 server 声明的包解出 server/（主进程
      // 数据面，含 ESM 标记）。digest 冲突 / 声明面缺失视为包损坏：回滚
      // 删除已落盘 tgz，导入整体失败（不留半可用状态）。
      let assets = null;
      let archiveSummary;
      try {
        archiveSummary = await summarizeArchive(targetPath, 'custom');
        const expectsUi = Array.isArray(archiveSummary.manifestUi?.panels)
          && archiveSummary.manifestUi.panels.length > 0;
        if (expectsUi) {
          const result = await extractClientAssets({
            archivePath: targetPath,
            packageName: archiveSummary.packageName,
            version: archiveSummary.version,
            archiveDigest: archiveSummary.archiveDigest,
            scopeAgentId: pending.agentId || '',
          });
          assets = { ...result, packageName: archiveSummary.packageName, version: archiveSummary.version };
        }
        const expectsServer = archiveSummary.manifestServer
          && typeof archiveSummary.manifestServer.entry === 'string'
          && typeof archiveSummary.manifestServer.prefix === 'string';
        if (expectsServer) {
          await extractServerAssets({
            archivePath: targetPath,
            packageName: archiveSummary.packageName,
            version: archiveSummary.version,
            archiveDigest: archiveSummary.archiveDigest,
            scopeAgentId: pending.agentId || '',
          }, { expectServer: true });
        }
      } catch (error) {
        await fs.unlink(targetPath).catch(() => {});
        console.error('[feature-repository] 插件资产解出失败，导入回滚：', error?.message || error);
        res.status(400).json({
          error: `插件 UI 面资产解出失败，已回滚导入：${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }

      const summary = await summarizeFeatureArchive(
        targetPath, path.basename(targetPath), pending.agentId ? 'workspace' : 'custom',
      );
      // 导入成功：装配引用悬空的版本可能就位（ghost 装配自动挂上），数据面重建
      notifyPluginServerDirty(`导入 ${archiveSummary?.packageName || path.basename(targetPath)}`);
      res.json({
        success: true,
        fileName: path.basename(targetPath),
        scopeAgentId: pending.agentId || null,
        summary,
        assets,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/protoclaw/feature_repository/cancel_import', express.json(), async (req, res, next) => {
    try {
      const uploadId = String(req.body?.uploadId || '').trim();
      const pending = pendingFeatureImports.get(uploadId);
      if (pending) {
        pendingFeatureImports.delete(uploadId);
        await fs.unlink(pending.tempPath).catch(e => console.warn(e));
      }
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/protoclaw/feature_repository/chunk_init', express.json(), async (req, res, next) => {
    try {
      const fileName = path.basename(String(req.body?.fileName || ''));
      const totalChunks = Number(req.body?.totalChunks);
      const totalSize = Number(req.body?.totalSize);
      if (!fileName.toLowerCase().endsWith('.tgz')) {
        res.status(400).json({ error: 'fileName must end with .tgz' });
        return;
      }
      if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > CHUNK_UPLOAD_MAX_CHUNKS) {
        res.status(400).json({ error: `totalChunks must be an integer in [1, ${CHUNK_UPLOAD_MAX_CHUNKS}]` });
        return;
      }
      if (!Number.isInteger(totalSize) || totalSize < 1 || totalSize > CHUNK_UPLOAD_MAX_TOTAL_BYTES) {
        res.status(400).json({ error: `totalSize must be an integer in [1, ${CHUNK_UPLOAD_MAX_TOTAL_BYTES}]` });
        return;
      }
      const uploadId = randomUUID();
      const dir = path.join(uploadsRoot, `chunk-${uploadId}`);
      await fs.mkdir(dir, { recursive: true });
      chunkUploadSessions.set(uploadId, {
        dir,
        originalName: fileName,
        totalChunks,
        totalSize,
        agentId: normalizeImportAgentId(req.body?.agentId),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      res.json({ uploadId });
    } catch (error) {
      next(error);
    }
  });

  // 分片可乱序、可重复（幂等覆盖同 index），uploadId 与 index 走 query，
  // multipart 体只承载数据块本身
  app.post('/protoclaw/feature_repository/chunk_append', chunkUpload.single('file'), async (req, res, next) => {
    try {
      const uploadId = String(req.query?.uploadId || '');
      const index = Number(req.query?.index);
      const session = chunkUploadSessions.get(uploadId);
      if (!session) {
        if (req.file?.path) await fs.unlink(req.file.path).catch(e => console.warn(e));
        res.status(404).json({ error: 'Unknown or expired upload' });
        return;
      }
      if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) {
        if (req.file?.path) await fs.unlink(req.file.path).catch(e => console.warn(e));
        res.status(400).json({ error: `index must be an integer in [0, ${session.totalChunks - 1}]` });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }
      const partPath = path.join(session.dir, `${index}.part`);
      await fs.rm(partPath, { force: true });
      await fs.rename(req.file.path, partPath);
      session.updatedAt = Date.now();
      const received = (await fs.readdir(session.dir)).filter(name => name.endsWith('.part')).length;
      res.json({ received, totalChunks: session.totalChunks });
    } catch (error) {
      if (req.file?.path) await fs.unlink(req.file.path).catch(e => console.warn(e));
      next(error);
    }
  });

  app.post('/protoclaw/feature_repository/chunk_complete', express.json(), async (req, res, next) => {
    try {
      const uploadId = String(req.body?.uploadId || '').trim();
      const session = chunkUploadSessions.get(uploadId);
      if (!session) {
        res.status(404).json({ error: 'Unknown or expired upload' });
        return;
      }
      const missing = [];
      for (let i = 0; i < session.totalChunks; i++) {
        if (!existsSync(path.join(session.dir, `${i}.part`))) missing.push(i);
      }
      if (missing.length > 0) {
        res.status(400).json({
          error: `Missing chunks: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ' …' : ''}`,
          missing,
        });
        return;
      }
      const assembledPath = path.join(uploadsRoot, `${uploadId}.tgz`);
      const failCleanup = async () => {
        chunkUploadSessions.delete(uploadId);
        await fs.rm(session.dir, { recursive: true, force: true }).catch(() => {});
        await fs.rm(assembledPath, { force: true }).catch(() => {});
      };
      try {
        for (let i = 0; i < session.totalChunks; i++) {
          const part = await fs.readFile(path.join(session.dir, `${i}.part`));
          await fs.appendFile(assembledPath, part);
        }
        const assembledSize = (await fs.stat(assembledPath)).size;
        if (assembledSize !== session.totalSize) {
          await failCleanup();
          res.status(400).json({ error: `Assembled size mismatch: expected ${session.totalSize}, got ${assembledSize}` });
          return;
        }
        const summary = await summarizeFeatureArchive(
          assembledPath, session.originalName, session.agentId ? 'workspace' : 'custom',
        );
        pendingFeatureImports.set(uploadId, {
          tempPath: assembledPath,
          originalName: session.originalName,
          summary,
          agentId: session.agentId || '',
          createdAt: Date.now(),
        });
        chunkUploadSessions.delete(uploadId);
        await fs.rm(session.dir, { recursive: true, force: true }).catch(() => {});
        res.json({ uploadId, summary });
      } catch (error) {
        // 坏包（summarize 抛错）等失败必须清理服务端会话资源，不能走 500 裸抛留下泄漏
        await failCleanup();
        res.status(400).json({ error: `chunk assembly failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    } catch (error) {
      next(error);
    }
  });

  // 统一中止：分片进行中与 parse 完成待确认两个阶段都兜（前端失败路径调用）
  app.post('/protoclaw/feature_repository/chunk_abort', express.json(), async (req, res, next) => {
    try {
      const uploadId = String(req.body?.uploadId || '').trim();
      const session = chunkUploadSessions.get(uploadId);
      if (session) {
        chunkUploadSessions.delete(uploadId);
        await fs.rm(session.dir, { recursive: true, force: true }).catch(() => {});
      }
      const pending = pendingFeatureImports.get(uploadId);
      if (pending) {
        pendingFeatureImports.delete(uploadId);
        await fs.unlink(pending.tempPath).catch(e => console.warn(e));
      }
      await fs.rm(path.join(uploadsRoot, `${uploadId}.tgz`), { force: true }).catch(() => {});
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/protoclaw/feature_repository/upload', upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }

      const tempPath = req.file.path;
      const originalName = req.file.originalname;

      if (!originalName.toLowerCase().endsWith('.tgz')) {
        await fs.unlink(tempPath).catch(e => console.warn(e));
        res.status(400).json({ error: 'Only .tgz files are allowed' });
        return;
      }

      // 确保用户feature仓库目录存在
      await ensureDir(USER_FEATURE_REPOSITORY_ROOT);

      // 移动文件到用户feature仓库
      const targetPath = path.join(USER_FEATURE_REPOSITORY_ROOT, originalName);
      await fs.rename(tempPath, targetPath);

      res.json({ success: true, fileName: originalName });
    } catch (error) {
      // 清理临时文件
      if (req.file?.path) {
        await fs.unlink(req.file.path).catch(e => console.warn(e));
      }
      next(error);
    }
  });
}

export {
  normalizeFeatureRequirements,
  normalizeFeatureTypes,
  normalizeFeatureCompatibility,
  inferFeatureTypes,
  inferFeatureManifest,
};
