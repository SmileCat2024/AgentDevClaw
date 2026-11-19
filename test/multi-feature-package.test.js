/**
 * 一包多 feature（ADR-0052）
 *
 * 覆盖：
 * 1. manifest.features[] 归一化：name 必填、包内唯一、entry/export 可选；
 *    非法项丢弃并产出 warning（catalog 层宽容）
 * 2. buildUserMountPlan：一条 $mount 展开为多个运行时 feature，配置键 = 声明 name
 * 3. feature 级禁用：$mount.disabledFeatures 只影响对应实例，包仍装配
 * 4. 单 feature 包声明 disabledFeatures：fail fast（提示改用 enabled:false）
 *
 * 真实 tgz fixture 在临时目录构造，不读真实用户数据目录。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative as pathRelative } from 'path';
import crypto from 'crypto';

import { scanFeatureCatalog, summarizeArchive } from '../server/feature-runtime/catalog.js';
import { buildUserMountPlan } from '../server/feature-runtime/user-mount.js';

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'multi-feature-pkg-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeTgz(dir, { packageName = 'multi-demo', version = '1.0.0', manifest = null } = {}) {
  const src = mkdtempSync(join(root, 'pack-src-'));
  const pkgDir = join(src, 'package');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: packageName, version, main: 'index.js' }));
  writeFileSync(join(pkgDir, 'index.js'), 'export class A {}\nexport class B {}\n');
  if (manifest) writeFileSync(join(pkgDir, 'agentdev-feature.json'), JSON.stringify(manifest, null, 2));
  mkdirSync(dir, { recursive: true });
  const archivePath = join(dir, `${packageName}-${version}.tgz`);
  execFileSync('tar', ['-czf', pathRelative(root, archivePath), '-C', pathRelative(root, src), 'package'], { cwd: root });
  return {
    archivePath,
    digest: `sha256:${crypto.createHash('sha256').update(readFileSync(archivePath)).digest('hex')}`,
  };
}

function roots(dir) {
  return { officialRoot: join(root, 'official'), userRoot: dir, workspaceRoots: {} };
}

describe('manifest.features 归一化', () => {
  it('多 feature 声明原样提取，name 必填且包内唯一', async () => {
    const dir = join(root, 'repo-a');
    const { archivePath } = makeTgz(dir, {
      manifest: {
        schemaVersion: 3,
        entry: 'index.js',
        features: [
          { name: 'alpha', export: 'A' },
          { name: 'beta', entry: 'beta.js', export: 'B' },
        ],
      },
    });
    const summary = await summarizeArchive(archivePath, 'custom');
    assert.deepEqual(summary.manifestFeatures, [
      { name: 'alpha', export: 'A' },
      { name: 'beta', entry: 'beta.js', export: 'B' },
    ]);
    assert.deepEqual(summary.manifestFeatureWarnings, []);
  });

  it('非法项（缺 name / 重名 / 路径逃逸 entry）被丢弃并给 warning，合法项保留', async () => {
    const dir = join(root, 'repo-b');
    const { archivePath } = makeTgz(dir, {
      manifest: {
        schemaVersion: 3,
        entry: 'index.js',
        features: [
          { export: 'A' },
          { name: 'dup' },
          { name: 'dup' },
          { name: 'evil', entry: '../outside.js' },
          { name: 'ok' },
        ],
      },
    });
    const summary = await summarizeArchive(archivePath, 'custom');
    assert.deepEqual(summary.manifestFeatures, [{ name: 'dup' }, { name: 'ok' }]);
    assert.equal(summary.manifestFeatureWarnings.length >= 3, true);
  });
});

describe('buildUserMountPlan（多 feature 展开）', () => {
  it('一条 $mount 展开为多个运行时 feature，entry 缺省沿用顶层', async () => {
    const dir = join(root, 'repo-c');
    makeTgz(dir, {
      manifest: {
        schemaVersion: 3,
        entry: 'index.js',
        features: [{ name: 'alpha', export: 'A' }, { name: 'beta', export: 'B' }],
      },
    });
    const mounts = new Map([['multi-demo', { package: 'multi-demo', version: '1.0.0' }]]);
    const { plan } = await buildUserMountPlan({ mounts, agentId: 'programming-helper', catalogRoots: roots(dir) });

    assert.deepEqual(plan.features.map((item) => item.runtimeName), ['alpha', 'beta']);
    assert.equal(plan.features[0].entry, 'index.js');
    assert.equal(plan.features[0].export, 'A');
    assert.equal(plan.features[1].export, 'B');
    // 同一个包坐标只装一次环境
    assert.equal(new Set(plan.features.map((item) => item.package)).size, 1);
  });

  it('disabledFeatures 只移除对应实例，其余照常装配', async () => {
    const dir = join(root, 'repo-d');
    makeTgz(dir, {
      manifest: {
        schemaVersion: 3,
        entry: 'index.js',
        features: [{ name: 'alpha', export: 'A' }, { name: 'beta', export: 'B' }],
      },
    });
    const mounts = new Map([[
      'multi-demo',
      { package: 'multi-demo', version: '1.0.0', disabledFeatures: ['beta'] },
    ]]);
    const { plan } = await buildUserMountPlan({ mounts, agentId: 'programming-helper', catalogRoots: roots(dir) });
    assert.deepEqual(plan.features.map((item) => item.runtimeName), ['alpha']);
  });

  it('单 feature 包声明 disabledFeatures：报错并提示用包级 enabled:false', async () => {
    const dir = join(root, 'repo-e');
    makeTgz(dir, { manifest: { schemaVersion: 3, entry: 'index.js', export: 'A' } });
    const mounts = new Map([[
      'multi-demo',
      { package: 'multi-demo', version: '1.0.0', disabledFeatures: ['alpha'] },
    ]]);
    await assert.rejects(
      () => buildUserMountPlan({ mounts, agentId: 'programming-helper', catalogRoots: roots(dir) }),
      /不支持 \$mount\.disabledFeatures/,
    );
  });

  it('catalog 扫描后条目可用于装配（含多 feature 声明）', async () => {
    const dir = join(root, 'repo-f');
    makeTgz(dir, {
      manifest: { schemaVersion: 3, entry: 'index.js', features: [{ name: 'alpha' }] },
    });
    const catalog = await scanFeatureCatalog({ officialRoot: join(root, 'official'), userRoot: dir });
    const entry = catalog.packages.get('multi-demo')?.[0];
    assert.deepEqual(entry?.manifestFeatures, [{ name: 'alpha' }]);
  });
});
