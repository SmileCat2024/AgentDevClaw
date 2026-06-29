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
} from '../shared/constants.js';
import { ensureDir, readJson } from '../shared/fs-helpers.js';
import { runCommand } from './fs-operations.js';
import { compareSemver, uniqueStrings } from '../shared/feature-utils.js';

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
  const allowed = new Set(['tools', 'mcp', 'hooks', 'control', 'rollback']);
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
  const { stdout } = await runCommand('tar', ['-xOf', archivePath, archiveEntryPath], { cwd: PROJECT_ROOT });
  const raw = stdout.trim();
  if (!raw) {
    throw new Error(`Archive entry is empty: ${archiveEntryPath}`);
  }
  return JSON.parse(raw);
}

async function summarizeFeatureArchive(archivePath, archiveName, source = 'custom') {
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

  const normalizedManifest = manifest || inferFeatureManifest(pkg, archiveName);
  const inferredFeatureTypes = inferFeatureTypes(pkg, normalizedManifest.id || pkg.name || archiveName);
  const featureTypes = normalizeFeatureTypes(normalizedManifest.featureTypes || inferredFeatureTypes);
  if (!manifest) {
    warnings.push(`缺少 ${FEATURE_MANIFEST_NAME}，当前仅展示 package.json 推断信息。`);
  }

  return {
    id: String(normalizedManifest.id || pkg.name || archiveName.replace(/\.tgz$/i, '')).trim(),
    name: String(normalizedManifest.name || normalizedManifest.id || pkg.name || archiveName.replace(/\.tgz$/i, '')).trim(),
    packageName: String(pkg.name || '').trim(),
    description: String(normalizedManifest.description || pkg.description || '').trim(),
    latestVersion: String(normalizedManifest.version || pkg.version || '').trim(),
    version: String(normalizedManifest.version || pkg.version || '').trim(),
    updatedAt: stat.mtime.toISOString(),
    archiveCount: 1,
    size: stat.size,
    tags: uniqueStrings([...(normalizedManifest.tags || []), ...(pkg.keywords || [])]),
    featureTypes,
    compatibility: normalizeFeatureCompatibility(normalizedManifest.compatibility, featureTypes),
    requirements: normalizeFeatureRequirements(normalizedManifest.requirements),
    homepage: typeof normalizedManifest.homepage === 'string' ? normalizedManifest.homepage.trim() : '',
    repository: typeof normalizedManifest.repository === 'string' ? normalizedManifest.repository.trim() : '',
    entry: typeof normalizedManifest.entry === 'string' ? normalizedManifest.entry.trim() : '',
    agentdev: typeof normalizedManifest.agentdev === 'object' && normalizedManifest.agentdev ? normalizedManifest.agentdev : {},
    manifestPresent: !!manifest,
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

      const normalizedManifest = manifest || inferFeatureManifest(pkg, entry.name);
      const inferredFeatureTypes = inferFeatureTypes(pkg, normalizedManifest.id || pkg.name || entry.name);
      const featureTypes = normalizeFeatureTypes(normalizedManifest.featureTypes || inferredFeatureTypes);
      const warnings = [];
      if (!manifest) {
        warnings.push(`缺少 ${FEATURE_MANIFEST_NAME}，当前仅展示 package.json 推断信息。`);
      }

      return {
        id: String(normalizedManifest.id || pkg.name || entry.name.replace(/\.tgz$/i, '')).trim(),
        name: String(normalizedManifest.name || normalizedManifest.id || pkg.name || entry.name.replace(/\.tgz$/i, '')).trim(),
        packageName: String(pkg.name || '').trim(),
        description: String(normalizedManifest.description || pkg.description || '').trim(),
        version: String(normalizedManifest.version || pkg.version || '').trim(),
        updatedAt: stat.mtime.toISOString(),
        size: stat.size,
        tags: uniqueStrings([...(normalizedManifest.tags || []), ...(pkg.keywords || [])]),
        featureTypes,
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

async function deleteFeaturePackage(packageId) {
  const deletedFiles = [];

  // 尝试从官方仓库删除
  const officialPath = FEATURE_REPOSITORY_ROOT;
  try {
    const officialEntries = await fs.readdir(officialPath, { withFileTypes: true });
    for (const entry of officialEntries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.tgz')) {
        const archivePath = path.join(officialPath, entry.name);
        const archiveId = entry.name.replace(/\.tgz$/i, '');
        if (archiveId === packageId) {
          await fs.unlink(archivePath);
          deletedFiles.push({ path: archivePath, source: 'official' });
        }
      }
    }
  } catch {
    // 官方仓库可能不存在
  }

  // 尝试从用户仓库删除
  const userPath = USER_FEATURE_REPOSITORY_ROOT;
  try {
    const userEntries = await fs.readdir(userPath, { withFileTypes: true });
    for (const entry of userEntries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.tgz')) {
        const archivePath = path.join(userPath, entry.name);
        const archiveId = entry.name.replace(/\.tgz$/i, '');
        if (archiveId === packageId) {
          await fs.unlink(archivePath);
          deletedFiles.push({ path: archivePath, source: 'custom' });
        }
      }
    }
  } catch {
    // 用户仓库可能不存在
  }

  return deletedFiles;
}

/* ── route setup ──────────────────────────────────────────────────── */

const pendingFeatureImports = new Map();

export function setupFeatureRepositoryRoutes(app, express) {
  const uploadsDir = path.join(USER_DATA_ROOT, 'uploads');
  mkdirSync(uploadsDir, { recursive: true });
  const upload = multer({ dest: uploadsDir });

  app.post('/protoclaw/feature_repository/delete', express.json(), async (req, res, next) => {
    try {
      const packageId = String(req.body.packageId || '').trim();
      if (!packageId) {
        res.status(400).json({ error: 'packageId is required' });
        return;
      }

      const deleted = await deleteFeaturePackage(packageId);
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
        await fs.unlink(tempPath).catch(() => {});
        res.status(400).json({ error: 'Only .tgz files are allowed' });
        return;
      }

      const uploadId = randomUUID();
      const summary = await summarizeFeatureArchive(tempPath, originalName, 'custom');
      pendingFeatureImports.set(uploadId, {
        tempPath,
        originalName,
        summary,
        createdAt: Date.now(),
      });
      res.json({ uploadId, summary });
    } catch (error) {
      if (req.file?.path) {
        await fs.unlink(req.file.path).catch(() => {});
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
      await ensureDir(USER_FEATURE_REPOSITORY_ROOT);
      const safeName = path.basename(pending.originalName).replace(/[^a-zA-Z0-9._@+-]+/g, '-');
      let targetPath = path.join(USER_FEATURE_REPOSITORY_ROOT, safeName);
      if (existsSync(targetPath)) {
        const parsed = path.parse(safeName);
        targetPath = path.join(USER_FEATURE_REPOSITORY_ROOT, `${parsed.name}-${Date.now()}${parsed.ext || '.tgz'}`);
      }
      await fs.rename(pending.tempPath, targetPath);
      const summary = await summarizeFeatureArchive(targetPath, path.basename(targetPath), 'custom');
      res.json({ success: true, fileName: path.basename(targetPath), summary });
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
        await fs.unlink(pending.tempPath).catch(() => {});
      }
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
        await fs.unlink(tempPath).catch(() => {});
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
        await fs.unlink(req.file.path).catch(() => {});
      }
      next(error);
    }
  });
}
