/**
 * 插件装配读取的 IO 缓存行为（2026-11-20 IO 热点治理）
 *
 * 覆盖：
 * 1. scanFeatureCatalog — stat 键控缓存：命中返回同一快照引用；
 *    tgz 新增/更新/删除后 stat 摘要变化自动失效重扫；并发 inflight 去重；
 *    不同 roots 互不污染。
 * 2. readLayerFile — mtime+size 键控缓存：命中返回等价独立对象
 *    （调用方原地修改不污染缓存）；文件更新/删除后读到新事实。
 *
 * 全部使用临时目录 + 真实 tgz fixture，不读真实用户数据目录。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, utimesSync, rmSync as rmFile, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative as pathRelative } from 'path';
import crypto from 'crypto';

import {
  scanFeatureCatalog,
  resetFeatureCatalogCacheForTest,
} from '../server/feature-runtime/catalog.js';
import { readLayerFile, resetLayerFileCacheForTest } from '../server/shared/feature-config-layers.js';

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'feature-catalog-cache-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  resetFeatureCatalogCacheForTest();
  resetLayerFileCacheForTest();
});

/** 在指定目录打包一个 tgz（package/ 前缀，npm pack 同构）。 */
function makeTgz(dir, { packageName = 'demo-plugin', version = '1.0.0', pad = '' } = {}) {
  const src = mkdtempSync(join(root, 'pack-src-'));
  const pkgDir = join(src, 'package');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: packageName, version }) + pad);
  mkdirSync(dir, { recursive: true });
  const archivePath = join(dir, `${packageName.replace(/[/\\]/g, '!')}-${version}.tgz`);
  execFileSync('tar', ['-czf', pathRelative(root, archivePath), '-C', pathRelative(root, src), 'package'], { cwd: root });
  const digest = `sha256:${crypto.createHash('sha256').update(readFileSync(archivePath)).digest('hex')}`;
  return { archivePath, digest };
}

/** 显式推进 mtime（部分文件系统分辨率下连续写入的 mtime 可能相同，
 *  用例内以显式 utimes 拉开时间戳，锁定「mtime+size 变化驱动失效」语义）。 */
function bumpMtime(filePath, offsetMs = 2000) {
  const past = new Date(Date.now() + offsetMs);
  utimesSync(filePath, past, past);
}

function userRoot() {
  return join(root, 'user');
}

/** 扫用户仓（official 根显式指向不存在的隔离目录，避免读到真实官方仓库）。 */
function scanUser() {
  return scanFeatureCatalog({ officialRoot: join(root, 'official'), userRoot: userRoot() });
}

describe('scanFeatureCatalog 缓存', () => {
  it('同 roots 二次扫描命中缓存：返回同一快照引用', async () => {
    makeTgz(userRoot());
    const first = await scanUser();
    const second = await scanUser();
    assert.equal(second, first, 'stat 摘要未变时应复用缓存快照（同引用）');
    assert.equal(second.packages.size, 1);
  });

  it('并发扫描共享 inflight：不产生两份快照', async () => {
    makeTgz(userRoot());
    const [a, b] = await Promise.all([
      scanUser(),
      scanUser(),
    ]);
    assert.equal(b, a, '并发同 roots 扫描应共享 inflight promise 产物');
  });

  it('tgz 内容更新（mtime+size 变化）后自动失效重扫', async () => {
    const { archivePath } = makeTgz(userRoot(), { packageName: 'demo-plugin', version: '1.0.0' });
    const first = await scanUser();
    const digestBefore = first.packages.get('demo-plugin')[0].archiveDigest;

    // 重写同坐标 tgz 为不同内容（size 不同 + mtime 显式推进）
    const { archivePath: newPath } = makeTgz(
      mkdtempSync(join(root, 'repack-')),
      { packageName: 'demo-plugin', version: '1.0.0', pad: '   ' },
    );
    copyFileSync(newPath, archivePath);
    bumpMtime(archivePath);

    const second = await scanUser();
    assert.notEqual(second, first, 'stat 摘要变化后应重扫');
    const digestAfter = second.packages.get('demo-plugin')[0].archiveDigest;
    assert.notEqual(digestAfter, digestBefore);
  });

  it('新增 tgz 后重扫可见；删除 tgz 后重扫消失', async () => {
    await scanUser(); // 空仓库基线（也缓存空态）

    const { archivePath } = makeTgz(userRoot(), { packageName: 'added-plugin', version: '0.1.0' });
    const withAdded = await scanUser();
    assert.equal(withAdded.packages.size, 1, '新增文件应使 readdir 摘要变化并重扫');

    rmFile(archivePath);
    const afterRemove = await scanUser();
    assert.equal(afterRemove.packages.size, 0, '删除文件后应重扫为空');
    assert.notEqual(afterRemove, withAdded);
  });

  it('不同 roots 的缓存条目互不污染', async () => {
    const rootA = mkdtempSync(join(root, 'repo-a-'));
    const rootB = mkdtempSync(join(root, 'repo-b-'));
    makeTgz(rootA, { packageName: 'plugin-a', version: '1.0.0' });
    makeTgz(rootB, { packageName: 'plugin-b', version: '1.0.0' });

    const catalogA = await scanFeatureCatalog({ officialRoot: join(root, 'official'), userRoot: rootA });
    const catalogB = await scanFeatureCatalog({ officialRoot: join(root, 'official'), userRoot: rootB });
    assert.equal(catalogA.packages.has('plugin-a'), true);
    assert.equal(catalogA.packages.has('plugin-b'), false);
    assert.equal(catalogB.packages.has('plugin-b'), true);
    assert.equal(catalogB.packages.has('plugin-a'), false);
  });
});

describe('readLayerFile 缓存', () => {
  it('命中返回等价独立对象：原地修改不污染后续读取', () => {
    const layerPath = join(root, 'layer.json');
    writeFileSync(layerPath, JSON.stringify({ shell: { enabled: true } }), 'utf8');

    const first = readLayerFile(layerPath);
    assert.deepEqual(first, { shell: { enabled: true } });
    first.shell.enabled = false; // 调用方原地修改（writeDeclaration 同款行为）
    first.injected = true;

    const second = readLayerFile(layerPath);
    assert.deepEqual(second, { shell: { enabled: true } }, '缓存值不得被调用方修改污染');
  });

  it('文件更新（mtime+size 变化）后读到新内容；删除后返回空对象', () => {
    const layerPath = join(root, 'layer.json');
    writeFileSync(layerPath, JSON.stringify({ a: 1 }), 'utf8');
    assert.deepEqual(readLayerFile(layerPath), { a: 1 });

    writeFileSync(layerPath, JSON.stringify({ a: 1, b: 2 }), 'utf8'); // size 变化
    assert.deepEqual(readLayerFile(layerPath), { a: 1, b: 2 });

    rmFile(layerPath);
    assert.deepEqual(readLayerFile(layerPath), {}, '文件删除后按空层处理');
  });
});
