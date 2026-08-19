import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';

import {
  FEATURE_MANIFEST_NAME,
  USER_FEATURE_REPOSITORY_ROOT,
} from '../shared/constants.js';
import { ensureFeatureProjectManifest } from '../routes/feature-repository.js';
import { runCommand } from '../routes/fs-operations.js';

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function sha256(filePath) {
  const content = await fs.readFile(filePath);
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function parsePackOutput(stdout) {
  const start = stdout.indexOf('[');
  const parsed = JSON.parse(start >= 0 ? stdout.slice(start) : stdout);
  const result = parsed?.[0];
  const filename = result?.filename;
  if (typeof filename !== 'string' || !filename.trim()) {
    throw new Error('npm pack 没有返回 tgz 文件名。');
  }
  const files = Array.isArray(result.files)
    ? result.files.map((item) => typeof item?.path === 'string' ? item.path : '').filter(Boolean)
    : [];
  return { filename: filename.trim(), files };
}

/**
 * Build an already-standard Feature package and place an immutable snapshot in
 * the user repository. This intentionally does not publish or install it.
 */
export async function packageFeatureProject({
  projectDir,
  repositoryDir = USER_FEATURE_REPOSITORY_ROOT,
} = {}) {
  const root = path.resolve(String(projectDir || '').trim());
  if (!root) throw new Error('projectDir 不能为空。');
  const packageJsonPath = path.join(root, 'package.json');
  const pkg = await readJson(packageJsonPath);
  if (typeof pkg.name !== 'string' || !pkg.name.trim()) throw new Error('Feature package.json 缺少 name。');
  if (typeof pkg.version !== 'string' || !pkg.version.trim()) throw new Error('Feature package.json 缺少 version。');

  await ensureFeatureProjectManifest(root);
  await runCommand(npmCommand(), ['run', 'build'], { cwd: root });
  const { stdout } = await runCommand(npmCommand(), ['pack', '--json'], { cwd: root });
  const packed = parsePackOutput(stdout);
  const sourceArchivePath = path.join(root, packed.filename);
  const targetRoot = path.resolve(repositoryDir);
  const targetPath = path.join(targetRoot, packed.filename);
  try {
    if (!packed.files.includes(FEATURE_MANIFEST_NAME)) {
      throw new Error(`打包产物缺少 ${FEATURE_MANIFEST_NAME}：${sourceArchivePath}`);
    }
    const archiveDigest = await sha256(sourceArchivePath);
    await fs.mkdir(targetRoot, { recursive: true });
    const existingDigest = await sha256(targetPath).catch(() => '');
    if (existingDigest && existingDigest !== archiveDigest) {
      throw new Error(`本地 Feature 仓库已存在 ${pkg.name}@${pkg.version} 的不同内容。请升级 package.json 的 version 后重新验证并创建快照。`);
    }
    if (!existingDigest) await fs.copyFile(sourceArchivePath, targetPath, fs.constants.COPYFILE_EXCL);
    return {
      packageName: pkg.name.trim(),
      version: pkg.version.trim(),
      archivePath: targetPath,
      archiveDigest,
      reused: !!existingDigest,
    };
  } finally {
    await fs.rm(sourceArchivePath, { force: true }).catch(() => {});
  }
}

export async function createTemporarySnapshotDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'agentdev-feature-snapshot-'));
}
