import path from 'path';
import process from 'process';
import { existsSync, promises as fs } from 'fs';

import {
  AGENTDEV_ROOT,
  FEATURE_REPOSITORY_ROOT,
  USER_FEATURE_REPOSITORY_ROOT,
} from '../shared/constants.js';
import { sanitizeSessionFragment } from '../shared/string-helpers.js';
import { readJson, ensureDir } from '../shared/fs-helpers.js';
import { runCommand } from './fs-operations.js';
import { summarizeFeatureRepository } from './feature-repository.js';

export function isValidFeatureName(value) {
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(String(value || '').trim());
}

export function resolveFeatureCreatorOutputDir(parentDir, featureName) {
  return path.join(path.resolve(String(parentDir || '').trim()), String(featureName || '').trim());
}

export async function ensureAssemblyWorkspaceBase(envDir, assemblyName) {
  await ensureDir(envDir);
  await ensureDir(path.join(envDir, '.agentdev', 'audit'));
  await ensureDir(path.join(envDir, '.agentdev', 'plugins'));
  await ensureDir(path.join(envDir, '.agentdev', 'tts'));

  const claudeMdPath = path.join(envDir, 'CLAUDE.md');
  try {
    await fs.access(claudeMdPath);
  } catch {
    await fs.writeFile(claudeMdPath, `# ${assemblyName}\n\nThis is the workspace for the ${assemblyName} chatbot.\n`, 'utf8');
  }

  const packageJsonPath = path.join(envDir, 'package.json');
  try {
    await fs.access(packageJsonPath);
  } catch {
    await fs.writeFile(packageJsonPath, `${JSON.stringify({
      name: sanitizeSessionFragment(assemblyName),
      private: true,
      type: 'module',
      version: '0.0.0',
      description: `Assembly workspace for ${assemblyName}`,
    }, null, 2)}\n`, 'utf8');
  }
}

export async function resolveAssemblyFeatureArchives(tokens) {
  const requested = Array.from(new Set(tokens
    .map((token) => String(token || '').trim())
    .filter(Boolean)));

  if (requested.length === 0) {
    return [];
  }

  const [officialData, customData] = await Promise.all([
    summarizeFeatureRepository(FEATURE_REPOSITORY_ROOT, 'official'),
    summarizeFeatureRepository(USER_FEATURE_REPOSITORY_ROOT, 'custom'),
  ]);
  const catalogs = [officialData, customData];
  const resolved = [];

  for (const token of requested) {
    const normalized = token.replace(/^@agentdev\//, '').trim().toLowerCase();
    let matched = null;

    for (const catalog of catalogs) {
      const packages = Array.isArray(catalog?.packages) ? catalog.packages : [];
      const item = packages.find((pkg) => {
        const packageName = String(pkg?.packageName || '').trim().toLowerCase();
        const packageId = String(pkg?.id || '').trim().toLowerCase();
        const packageNameShort = packageName.replace(/^@agentdev\//, '');
        return token.toLowerCase() === packageName
          || normalized === packageId
          || normalized === packageNameShort;
      });

      if (!item) {
        continue;
      }

      const versions = Array.isArray(item.versions) ? item.versions : [];
      const latestVersion = versions.find((version) => String(version?.version || '') === String(item.latestVersion || ''))
        || versions[versions.length - 1]
        || null;
      if (!latestVersion?.fileName) {
        continue;
      }

      const rootDir = item.source === 'custom' ? USER_FEATURE_REPOSITORY_ROOT : FEATURE_REPOSITORY_ROOT;
      matched = {
        token,
        packageName: String(item.packageName || token).trim(),
        archivePath: path.join(rootDir, latestVersion.fileName),
      };
      break;
    }

    if (!matched) {
      throw new Error(`未找到装配 Feature 包: ${token}`);
    }

    resolved.push(matched);
  }

  return resolved;
}

export function toFileDependencySpec(targetPath) {
  return `file:${path.resolve(targetPath).replace(/\\/g, '/')}`;
}

export function computeDependencyHash(dependencies) {
  const entries = Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b));
  let hash = 0;
  for (const [key, value] of entries) {
    for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
    hash = ((hash << 5) - hash + 0x3A) | 0;
    for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
    hash = ((hash << 5) - hash + 0x7C) | 0;
  }
  return hash.toString(36);
}

export async function ensureAssemblyWorkspaceDependencies(envDir, selectedFeatures) {
  const _t0 = Date.now();
  const requestedFeatures = Array.isArray(selectedFeatures)
    ? Array.from(new Set(selectedFeatures.map((value) => String(value || '').trim()).filter(Boolean)))
    : [];
  const hashFilePath = path.join(envDir, '.protoclaw-deps-hash');
  const nodeModulesExists = existsSync(path.join(envDir, 'node_modules'));
  const featureKey = [...requestedFeatures].sort().join(',');

  // Early skip: if features haven't changed and node_modules exists, skip everything
  if (nodeModulesExists && requestedFeatures.length >= 0) {
    const savedContent = await fs.readFile(hashFilePath, 'utf8').catch(() => '');
    const savedParts = savedContent.trim().split('|');
    const savedFeatureKey = savedParts.length > 1 ? savedParts[0] : null;
    const savedHash = savedParts.length > 1 ? savedParts[1] : savedParts[0];
    if (savedFeatureKey === featureKey && savedHash) {
      console.log(`[PERF] ensureAssemblyWorkspaceDependencies EARLY SKIP (${Date.now() - _t0}ms) features=${featureKey}`);
      return { installedPackages: requestedFeatures, installDir: envDir, skipped: true };
    }
  }

  const archives = requestedFeatures.length > 0
    ? await resolveAssemblyFeatureArchives(requestedFeatures)
    : [];
  const nextDependencies = {
    agentdev: toFileDependencySpec(AGENTDEV_ROOT),
    ...Object.fromEntries(archives.map((item) => [item.packageName, toFileDependencySpec(item.archivePath)])),
  };
  const depHash = computeDependencyHash(nextDependencies);

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packageJsonPath = path.join(envDir, 'package.json');
  const packageJson = await readJson(packageJsonPath).catch(() => ({}));

  await fs.writeFile(packageJsonPath, `${JSON.stringify({
    ...packageJson,
    name: typeof packageJson?.name === 'string' && packageJson.name.trim() ? packageJson.name.trim() : sanitizeSessionFragment(path.basename(envDir)),
    private: true,
    type: 'module',
    version: typeof packageJson?.version === 'string' && packageJson.version.trim() ? packageJson.version.trim() : '0.0.0',
    description: typeof packageJson?.description === 'string' && packageJson.description.trim()
      ? packageJson.description.trim()
      : `Assembly workspace for ${path.basename(envDir)}`,
    dependencies: nextDependencies,
  }, null, 2)}\n`, 'utf8');

  await Promise.all([
    fs.rm(path.join(envDir, 'node_modules'), { recursive: true, force: true }).catch(() => {}),
    fs.rm(path.join(envDir, 'package-lock.json'), { force: true }).catch(() => {}),
  ]);

  await runCommand(npmCommand, [
    'install',
    '--no-fund',
    '--no-audit',
    '--no-package-lock',
  ], { cwd: envDir });

  const hashContent = `${featureKey}|${depHash}`;
  await fs.writeFile(hashFilePath, hashContent, 'utf8').catch(() => {});

  console.log(`[PERF] ensureAssemblyWorkspaceDependencies npm install DONE (${Date.now() - _t0}ms) deps=${Object.keys(nextDependencies).join(',')}`);
  return {
    installedPackages: archives.map((item) => item.packageName),
    installDir: envDir,
    skipped: false,
  };
}
