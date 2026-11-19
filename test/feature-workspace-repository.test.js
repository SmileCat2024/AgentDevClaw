/**
 * 工作空间私有插件仓库（ADR-0046 空间级仓库）
 *
 * 覆盖：
 * 1. scanFeatureCatalog — workspaceRoots 来源标记（source/scopeAgentId）、
 *    来源优先级排序（空间私有 > 用户区 > 官方区）
 * 2. resolveCatalogPackage — 私有包只对所属身份可见
 * 3. buildStorePackages — 货架项带 scopeAgentId，全局与私有各自成条
 * 4. buildUserMountPlan — 装配解析优先命中本空间私有包
 * 5. composePanelDeclarations — 私有面板只下发给所属身份
 *
 * 全部使用临时目录 + 真实 tgz fixture，不读真实用户数据目录。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative as pathRelative } from 'path';
import crypto from 'crypto';

import {
  scanFeatureCatalog,
  resolveCatalogPackage,
  isCatalogEntryVisibleTo,
} from '../server/feature-runtime/catalog.js';
import { buildUserMountPlan } from '../server/feature-runtime/user-mount.js';
import { buildStorePackages } from '../server/routes/feature-store.js';
import { composePanelDeclarations } from '../server/feature-runtime/plugin-ui.js';

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'feature-workspace-repo-test-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 在指定目录打包一个 tgz（package/ 前缀，npm pack 同构）。 */
function makeTgz(dir, { packageName = 'demo-plugin', version = '1.0.0', manifest = null, clientFiles = null } = {}) {
  const src = mkdtempSync(join(root, 'pack-src-'));
  const pkgDir = join(src, 'package');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: packageName, version }));
  if (manifest) {
    writeFileSync(join(pkgDir, 'agentdev-feature.json'), JSON.stringify(manifest, null, 2));
  }
  for (const [name, content] of Object.entries(clientFiles || { 'index.js': 'export default {}' })) {
    const file = join(pkgDir, 'client', name);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
  }
  mkdirSync(dir, { recursive: true });
  const archivePath = join(dir, `${packageName.replace(/[/\\]/g, '!')}-${version}.tgz`);
  execFileSync('tar', ['-czf', pathRelative(root, archivePath), '-C', pathRelative(root, src), 'package'], { cwd: root });
  const digest = `sha256:${crypto.createHash('sha256').update(readFileSync(archivePath)).digest('hex')}`;
  return { archivePath, digest };
}

function dirs() {
  return {
    officialRoot: join(root, 'official'),
    userRoot: join(root, 'user'),
    workspaceRootA: join(root, 'ws-a'),
    workspaceRootB: join(root, 'ws-b'),
  };
}

describe('scanFeatureCatalog（空间私有仓库）', () => {
  it('私有条目带 scopeAgentId 与 workspace 来源；全局条目 scopeAgentId 为 null', async () => {
    const d = dirs();
    makeTgz(d.userRoot, { packageName: 'global-plugin', version: '1.0.0' });
    makeTgz(d.workspaceRootA, { packageName: 'private-plugin', version: '1.0.0' });

    const catalog = await scanFeatureCatalog({
      officialRoot: d.officialRoot,
      userRoot: d.userRoot,
      workspaceRoots: { 'agent-a': d.workspaceRootA },
    });

    const globalEntry = catalog.packages.get('global-plugin')[0];
    assert.equal(globalEntry.source, 'custom');
    assert.equal(globalEntry.scopeAgentId, null);

    const privateEntry = catalog.packages.get('private-plugin')[0];
    assert.equal(privateEntry.source, 'workspace');
    assert.equal(privateEntry.scopeAgentId, 'agent-a');
  });

  it('同包同版本并存：空间私有条目排在全局条目之前（解析优先级）', async () => {
    const d = dirs();
    makeTgz(d.userRoot, { packageName: 'shared-plugin', version: '1.0.0', clientFiles: { 'index.js': 'global' } });
    makeTgz(d.workspaceRootA, { packageName: 'shared-plugin', version: '1.0.0', clientFiles: { 'index.js': 'private' } });

    const catalog = await scanFeatureCatalog({
      officialRoot: d.officialRoot,
      userRoot: d.userRoot,
      workspaceRoots: { 'agent-a': d.workspaceRootA },
    });
    const versions = catalog.packages.get('shared-plugin');
    assert.equal(versions.length, 2);
    assert.equal(versions[0].source, 'workspace');
    assert.equal(versions[1].source, 'custom');
  });

  it('未注入 workspaceRoots 时行为不变（只扫全局两仓）', async () => {
    const d = dirs();
    makeTgz(d.workspaceRootA, { packageName: 'private-plugin', version: '1.0.0' });
    const catalog = await scanFeatureCatalog({ officialRoot: d.officialRoot, userRoot: d.userRoot });
    assert.equal(catalog.packages.has('private-plugin'), false);
  });
});

describe('resolveCatalogPackage（按身份可见性）', () => {
  it('私有包只对所属身份可解析，其他身份报仓库不存在', async () => {
    const d = dirs();
    makeTgz(d.workspaceRootA, { packageName: 'private-plugin', version: '1.0.0' });
    const catalog = await scanFeatureCatalog({
      officialRoot: d.officialRoot,
      userRoot: d.userRoot,
      workspaceRoots: { 'agent-a': d.workspaceRootA },
    });

    const hit = resolveCatalogPackage(catalog, { packageName: 'private-plugin', version: '1.0.0', agentId: 'agent-a' });
    assert.equal(hit.scopeAgentId, 'agent-a');
    assert.throws(
      () => resolveCatalogPackage(catalog, { packageName: 'private-plugin', version: '1.0.0', agentId: 'agent-b' }),
      /仓库中不存在/,
    );
  });

  it('同名同版本时所属身份解析到私有包，其他身份解析到全局包', async () => {
    const d = dirs();
    makeTgz(d.userRoot, { packageName: 'shared-plugin', version: '1.0.0', clientFiles: { 'index.js': 'global' } });
    makeTgz(d.workspaceRootA, { packageName: 'shared-plugin', version: '1.0.0', clientFiles: { 'index.js': 'private' } });
    const catalog = await scanFeatureCatalog({
      officialRoot: d.officialRoot,
      userRoot: d.userRoot,
      workspaceRoots: { 'agent-a': d.workspaceRootA },
    });

    assert.equal(resolveCatalogPackage(catalog, { packageName: 'shared-plugin', version: '1.0.0', agentId: 'agent-a' }).source, 'workspace');
    assert.equal(resolveCatalogPackage(catalog, { packageName: 'shared-plugin', version: '1.0.0', agentId: 'agent-b' }).source, 'custom');
  });

  it('isCatalogEntryVisibleTo：全局条目对所有身份可见', async () => {
    assert.equal(isCatalogEntryVisibleTo({ scopeAgentId: null }, 'anything'), true);
    assert.equal(isCatalogEntryVisibleTo({ scopeAgentId: 'a' }, 'a'), true);
    assert.equal(isCatalogEntryVisibleTo({ scopeAgentId: 'a' }, 'b'), false);
  });
});

describe('buildStorePackages（货架归属）', () => {
  it('全局包与私有包各自成条，条目带 scopeAgentId 与 source', async () => {
    const d = dirs();
    makeTgz(d.userRoot, { packageName: 'global-plugin', version: '1.0.0' });
    makeTgz(d.workspaceRootA, { packageName: 'private-plugin', version: '2.0.0' });
    makeTgz(d.officialRoot, { packageName: 'official-only', version: '1.0.0' });

    const catalog = await scanFeatureCatalog({
      officialRoot: d.officialRoot,
      userRoot: d.userRoot,
      workspaceRoots: { 'agent-a': d.workspaceRootA },
    });
    const packages = buildStorePackages(catalog);

    const globalItem = packages.find((pkg) => pkg.package === 'global-plugin');
    assert.equal(globalItem.scopeAgentId, null);
    assert.equal(globalItem.source, 'custom');

    const privateItem = packages.find((pkg) => pkg.package === 'private-plugin');
    assert.equal(privateItem.scopeAgentId, 'agent-a');
    assert.equal(privateItem.source, 'workspace');

    // 官方仓库包不上货架
    assert.equal(packages.some((pkg) => pkg.package === 'official-only'), false);
  });
});

describe('buildUserMountPlan（装配解析到私有包）', () => {
  it('所属身份装配同名包时解析到私有仓库的 tgz', async () => {
    const d = dirs();
    const globalArchive = makeTgz(d.userRoot, {
      packageName: 'shared-plugin', version: '1.0.0', clientFiles: { 'index.js': 'global' },
    });
    const privateArchive = makeTgz(d.workspaceRootA, {
      packageName: 'shared-plugin', version: '1.0.0', clientFiles: { 'index.js': 'private' },
    });
    const catalogRoots = {
      officialRoot: d.officialRoot,
      userRoot: d.userRoot,
      workspaceRoots: { 'agent-a': d.workspaceRootA },
    };
    const mounts = new Map([['shared-plugin', { package: 'shared-plugin', version: '1.0.0' }]]);

    const own = await buildUserMountPlan({ mounts, agentId: 'agent-a', catalogRoots });
    assert.equal(own.plan.features[0].archivePath, privateArchive.archivePath);
    assert.equal(own.plan.features[0].archiveDigest, privateArchive.digest);

    const other = await buildUserMountPlan({ mounts, agentId: 'agent-b', catalogRoots });
    assert.equal(other.plan.features[0].archivePath, globalArchive.archivePath);
  });
});

describe('composePanelDeclarations（私有面板可见范围）', () => {
  function layerTable(agentLayerConfig, globalLayerConfig) {
    const table = new Map();
    const globalFile = join(root, 'layer-global.json');
    writeFileSync(globalFile, JSON.stringify(globalLayerConfig || {}, null, 2));
    const writeLayer = (agentId, sparse) => {
      const file = join(root, `layer-${agentId}.json`);
      writeFileSync(file, JSON.stringify(sparse, null, 2));
      return {
        layers: [
          { id: 'global', label: 'global', path: globalFile },
          { id: 'agent', label: 'agent', path: file },
        ],
      };
    };
    // resolvers：agentId → 返回层清单的解析器（与 feature-assets.test.js 同构）
    table.set('programming-helper', () => writeLayer('programming-helper', agentLayerConfig['programming-helper'] || {}));
    table.set('coder', () => writeLayer('coder', agentLayerConfig.coder || {}));
    return table;
  }

  it('私有包的面板只下发给装配它的所属身份', async () => {
    const d = dirs();
    const manifest = {
      schemaVersion: 3,
      ui: { panels: [{ id: 'private-panel', entry: 'index.js', scope: 'assembly' }] },
    };
    makeTgz(d.workspaceRootA, { packageName: 'private-plugin', version: '1.0.0', manifest });

    const { declarations, warnings } = await composePanelDeclarations({
      catalogRoots: {
        officialRoot: d.officialRoot,
        userRoot: d.userRoot,
        workspaceRoots: { 'programming-helper': d.workspaceRootA },
      },
      resolvers: layerTable({
        'programming-helper': { 'private-plugin': { $mount: { package: 'private-plugin', version: '1.0.0' } } },
      }),
      assetsRoot: join(root, 'assets'),
    });

    const panel = declarations.find((item) => item.panelId === 'private-panel');
    assert.ok(panel, `面板应下发，warnings=${warnings.join('; ')}`);
    assert.deepEqual(panel.meta.when.agentIds, ['programming-helper']);
  });

  it('其他身份装配同名私有包（不可见）时不下发面板', async () => {
    const d = dirs();
    const manifest = {
      schemaVersion: 3,
      ui: { panels: [{ id: 'private-panel', entry: 'index.js', scope: 'assembly' }] },
    };
    makeTgz(d.workspaceRootA, { packageName: 'private-plugin', version: '1.0.0', manifest });

    const { declarations } = await composePanelDeclarations({
      catalogRoots: {
        officialRoot: d.officialRoot,
        userRoot: d.userRoot,
        workspaceRoots: { 'programming-helper': d.workspaceRootA },
      },
      resolvers: layerTable({
        coder: { 'private-plugin': { $mount: { package: 'private-plugin', version: '1.0.0' } } },
      }),
      assetsRoot: join(root, 'assets'),
    });

    assert.equal(declarations.some((item) => item.panelId === 'private-panel'), false);
  });
});
