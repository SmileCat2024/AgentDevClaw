import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';

import {
  FEATURE_REPOSITORY_ROOT,
  FEATURE_MANIFEST_NAME,
  USER_FEATURE_REPOSITORY_ROOT,
  PROJECT_ROOT,
} from '../shared/constants.js';
import { compareSemver } from '../shared/feature-utils.js';
import { runCommand } from '../routes/fs-operations.js';

async function readArchiveJson(archivePath, archiveEntryPath) {
  // Windows 下 GNU tar 把 "C:\..." 的盘符冒号当作远程主机分隔符（"Cannot connect
  // to C: resolve failed"），正斜杠绝对路径同样触发该解析（历史遗留：用户仓库 tgz
  // 曾因此全部落入 invalid 被静默吞掉）。runCommand 以 PROJECT_ROOT 为 cwd：
  // 仓库内归档改传 POSIX 风格相对路径绕开；仓库外归档（用户仓库 / 临时目录）在
  // win32 追加 --force-local 禁用远程主机解释（GNU tar 扩展，BSD tar 无此问题）。
  // 注意：跨盘符（PROJECT_ROOT 在 D:、用户仓库/临时目录在 C:）时 path.relative
  // 返回 to 的绝对路径而非 ".." 前缀，必须同时排除绝对路径才算仓库内。
  const relative = path.relative(PROJECT_ROOT, archivePath).replace(/\\/g, '/');
  const insideRepo = !relative.startsWith('..') && !path.isAbsolute(relative);
  const target = insideRepo ? relative : archivePath.replace(/\\/g, '/');
  const tarArgs = !insideRepo && process.platform === 'win32'
    ? ['--force-local', '-xOf', target, archiveEntryPath]
    : ['-xOf', target, archiveEntryPath];
  const { stdout } = await runCommand('tar', tarArgs);
  const raw = stdout.trim();
  if (!raw) throw new Error(`Archive entry is empty: ${archiveEntryPath}`);
  return JSON.parse(raw);
}

async function summarizeArchive(archivePath, source) {
  const [pkg, manifest] = await Promise.all([
    readArchiveJson(archivePath, 'package/package.json'),
    readArchiveJson(archivePath, `package/${FEATURE_MANIFEST_NAME}`).catch(() => null),
  ]);
  const packageName = typeof pkg?.name === 'string' ? pkg.name.trim() : '';
  const version = typeof pkg?.version === 'string' ? pkg.version.trim() : '';
  if (!packageName || !version) {
    throw new Error(`Feature archive 缺少 package name 或 version：${archivePath}`);
  }
  const archive = await fs.readFile(archivePath);
  return {
    packageName,
    version,
    archivePath,
    archiveDigest: `sha256:${crypto.createHash('sha256').update(archive).digest('hex')}`,
    source,
    entry: typeof manifest?.entry === 'string' && manifest.entry.trim()
      ? manifest.entry.trim()
      : (typeof pkg.main === 'string' ? pkg.main.trim() : ''),
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

export async function scanFeatureCatalog({ officialRoot = FEATURE_REPOSITORY_ROOT, userRoot = USER_FEATURE_REPOSITORY_ROOT } = {}) {
  const [official, custom] = await Promise.all([
    scanRoot(officialRoot, 'official'),
    scanRoot(userRoot, 'custom'),
  ]);
  const invalid = [...official, ...custom].filter((entry) => entry.error);
  const packages = new Map();
  for (const entry of [...official, ...custom]) {
    if (entry.error) continue;
    const versions = packages.get(entry.packageName) || [];
    versions.push(entry);
    packages.set(entry.packageName, versions);
  }
  for (const versions of packages.values()) {
    versions.sort((left, right) => {
      const sourceScore = Number(right.source === 'custom') - Number(left.source === 'custom');
      if (sourceScore !== 0) return sourceScore;
      return compareSemver(right.version, left.version);
    });
  }
  return { packages, invalid };
}

export function resolveCatalogPackage(catalog, { packageName, version, allowLatest = false }) {
  const versions = catalog?.packages?.get(packageName) || [];
  if (versions.length === 0) throw new Error(`Feature 仓库中不存在包：${packageName}`);
  if (version) {
    const exact = versions.find((entry) => entry.version === version);
    if (!exact) throw new Error(`Feature 仓库中不存在 ${packageName}@${version}`);
    return exact;
  }
  if (!allowLatest) throw new Error(`必须为 ${packageName} 指定精确版本。`);
  return versions[0];
}
