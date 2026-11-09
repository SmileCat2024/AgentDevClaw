/**
 * Tests for 插件 UI 面资产通道与声明合成（ADR-0045 P1）
 *
 * 覆盖：
 * 1. extractClientAssets — 真实小 tgz 的 client/ 解出、digest 幂等/冲突、
 *    ui 面缺 client/ 拒绝、无 client/ 的普通包跳过
 * 2. resolveClientAsset — 防路径穿越（../、绝对段、.digest、非法版本）、
 *    正常解析
 * 3. streamClientAsset — MIME 白名单与 immutable 缓存头
 * 4. composePanelDeclarations — scope=global/assembly 换算 when、装配过滤、
 *    资产就绪检查、非法声明 warning、面板 id 冲突
 *
 * 全部使用临时目录构造 fixture（真实 tgz 经系统 tar 打包，与导入链路同一
 * 归档形态），不读真实用户数据目录。
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative as pathRelative } from 'path';
import { Writable } from 'node:stream';
import crypto from 'crypto';

import {
  extractClientAssets,
  resolveClientAsset,
  resolveClientAssetWithHeal,
  ensureFacetExtracted,
  resetAssetHealCachesForTest,
  assetMimeFor,
  streamClientAsset,
  versionAssetDir,
  versionServerDir,
} from '../server/feature-runtime/feature-assets.js';
import { composePanelDeclarations } from '../server/feature-runtime/plugin-ui.js';

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'feature-assets-test-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ── fixture：打包真实 tgz（package/ 前缀，npm pack 同构） ──────────

function makePluginTgz({
  packageName = 'demo-plugin',
  version = '1.0.0',
  manifest = null,
  clientFiles = { 'index.js': 'export default {}' },
  serverFiles = null,
} = {}) {
  const src = join(root, 'pack-src');
  const pkgDir = join(src, 'package');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: packageName, version }));
  if (manifest) {
    writeFileSync(join(pkgDir, 'agentdev-feature.json'), JSON.stringify(manifest, null, 2));
  }
  for (const [name, content] of Object.entries(clientFiles)) {
    const file = join(pkgDir, 'client', name);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
  }
  for (const [name, content] of Object.entries(serverFiles || {})) {
    const file = join(pkgDir, 'server', name);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
  }
  // 相对路径 + cwd 打包：Windows GNU tar 会把 "C:\..." 盘符冒号当远程主机
  // 分隔符（与 catalog.js 同坑），相对路径对 GNU/BSD tar 都安全。
  // scoped 包名（@adv/demo）里的 "/" 不能进文件名（join 会拼出子目录），
  // 与资产目录同款转义为 "!"。
  const archivePath = join(root, `${packageName.replace(/[/\\]/g, '!')}-${version}.tgz`);
  execFileSync('tar', ['-czf', pathRelative(root, archivePath), '-C', pathRelative(root, src), 'package'], { cwd: root });
  const digest = `sha256:${crypto.createHash('sha256').update(readFileSync(archivePath)).digest('hex')}`;
  return { archivePath, digest };
}

const uiManifest = (panels) => ({
  schemaVersion: 3,
  id: 'demo-plugin',
  entry: 'dist/index.js',
  ui: { panels },
});

// ── extractClientAssets ────────────────────────────────────────────

describe('extractClientAssets', async () => {
  it('extracts package/client to the versioned asset dir and records digest', async () => {
    const { archivePath, digest } = makePluginTgz();
    const assetsRoot = join(root, 'assets');
    const result = await extractClientAssets(
      { archivePath, packageName: 'demo-plugin', version: '1.0.0', archiveDigest: digest },
      { expectClient: true, assetsRoot },
    );
    assert.equal(result.extracted, true);
    assert.equal(result.fileCount, 1);
    const dir = versionAssetDir({ packageName: 'demo-plugin', version: '1.0.0' }, assetsRoot);
    assert.equal(readFileSync(join(dir, 'index.js'), 'utf8'), 'export default {}');
    assert.equal(readFileSync(join(dir, '.digest'), 'utf8').trim(), digest);
  });

  it('scopes package names to a single directory segment (@scope/name → @scope!name)', async () => {
    const { archivePath, digest } = makePluginTgz({ packageName: '@adv/demo', version: '0.1.0' });
    const assetsRoot = join(root, 'assets');
    await extractClientAssets(
      { archivePath, packageName: '@adv/demo', version: '0.1.0', archiveDigest: digest },
      { expectClient: true, assetsRoot },
    );
    assert.ok(existsSync(join(assetsRoot, 'adv!demo', '0.1.0', 'index.js')));
  });

  it('is idempotent when re-importing the same digest', async () => {
    const { archivePath, digest } = makePluginTgz();
    const assetsRoot = join(root, 'assets');
    const args = { archivePath, packageName: 'demo-plugin', version: '1.0.0', archiveDigest: digest };
    await extractClientAssets(args, { expectClient: true, assetsRoot });
    const again = await extractClientAssets(args, { expectClient: true, assetsRoot });
    assert.equal(again.extracted, false);
  });

  it('rejects same version with a different digest (同版本不同字节)', async () => {
    const first = makePluginTgz();
    const second = makePluginTgz({ clientFiles: { 'index.js': 'export default { changed: true }' } });
    const assetsRoot = join(root, 'assets');
    await extractClientAssets(
      { archivePath: first.archivePath, packageName: 'demo-plugin', version: '1.0.0', archiveDigest: first.digest },
      { expectClient: true, assetsRoot },
    );
    await assert.rejects(
      () => extractClientAssets(
        { archivePath: second.archivePath, packageName: 'demo-plugin', version: '1.0.0', archiveDigest: second.digest },
        { expectClient: true, assetsRoot },
      ),
      (err) => err.code === 'asset-digest-conflict',
    );
  });

  it('rejects ui-declared package without client/ (包损坏)', async () => {
    const { archivePath, digest } = makePluginTgz({ clientFiles: {} });
    await assert.rejects(
      () => extractClientAssets(
        { archivePath, packageName: 'demo-plugin', version: '1.0.0', archiveDigest: digest },
        { expectClient: true, assetsRoot: join(root, 'assets') },
      ),
      (err) => err.code === 'client-assets-missing',
    );
  });

  it('skips extraction for plain packages without client/', async () => {
    const { archivePath, digest } = makePluginTgz({ clientFiles: {} });
    const result = await extractClientAssets(
      { archivePath, packageName: 'demo-plugin', version: '1.0.0', archiveDigest: digest },
      { assetsRoot: join(root, 'assets') },
    );
    assert.equal(result.extracted, false);
    assert.equal(result.fileCount, 0);
  });
});

// ── resolveClientAsset / MIME / 流式回包 ───────────────────────────

describe('resolveClientAsset', async () => {
  it('resolves a file inside the version dir', async () => {
    const { archivePath, digest } = makePluginTgz();
    const assetsRoot = join(root, 'assets');
    await extractClientAssets(
      { archivePath, packageName: 'demo-plugin', version: '1.0.0', archiveDigest: digest },
      { expectClient: true, assetsRoot },
    );
    const resolved = resolveClientAsset({ packageName: 'demo-plugin', version: '1.0.0', file: 'index.js' }, assetsRoot);
    assert.equal(resolved, join(versionAssetDir({ packageName: 'demo-plugin', version: '1.0.0' }, assetsRoot), 'index.js'));
  });

  it('rejects traversal, digest file, and malformed versions', async () => {
    const { archivePath, digest } = makePluginTgz();
    const assetsRoot = join(root, 'assets');
    await extractClientAssets(
      { archivePath, packageName: 'demo-plugin', version: '1.0.0', archiveDigest: digest },
      { expectClient: true, assetsRoot },
    );
    const cases = [
      { packageName: 'demo-plugin', version: '1.0.0', file: '../other/index.js' },
      { packageName: 'demo-plugin', version: '1.0.0', file: 'a/../../x.js' },
      { packageName: 'demo-plugin', version: '1.0.0', file: '.digest' },
      { packageName: 'demo-plugin', version: '1.0.0/x', file: 'index.js' },
      { packageName: 'demo-plugin', version: '1.0.0', file: '' },
      { packageName: 'demo-plugin', version: '9.9.9', file: 'index.js' },
    ];
    for (const item of cases) {
      assert.equal(resolveClientAsset(item, assetsRoot), null, JSON.stringify(item));
    }
  });

  it('maps extensions through the MIME whitelist', async () => {
    assert.match(assetMimeFor('a.js'), /javascript/);
    assert.match(assetMimeFor('b.css'), /css/);
    assert.match(assetMimeFor('c.woff2'), /font/);
    assert.equal(assetMimeFor('d.bin'), 'application/octet-stream');
  });

  it('streams with immutable cache headers', async () => {
    const { archivePath, digest } = makePluginTgz();
    const assetsRoot = join(root, 'assets');
    await extractClientAssets(
      { archivePath, packageName: 'demo-plugin', version: '1.0.0', archiveDigest: digest },
      { expectClient: true, assetsRoot },
    );
    const filePath = resolveClientAsset({ packageName: 'demo-plugin', version: '1.0.0', file: 'index.js' }, assetsRoot);
    const chunks = [];
    // 真 Writable 流承接 pipe（on/once/emit 由流基类提供），headers/set 模拟 Express res
    const res = new Writable({
      write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
    });
    res.headers = {};
    res.set = function set(name, value) { this.headers[name.toLowerCase()] = value; return this; };
    streamClientAsset(res, filePath);
    await new Promise((resolve) => res.on('finish', resolve));
    assert.match(res.headers['content-type'], /javascript/);
    assert.match(res.headers['cache-control'], /immutable/);
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'export default {}');
  });
});

// ── composePanelDeclarations ───────────────────────────────────────

function makeLayerTable(agentLayerConfig, globalLayerConfig) {
  const table = new Map();
  // global 层文件对全部身份共享（与生产 scope 层清单一致：global 是公共首层）
  const globalFile = join(root, 'layer-global.json');
  writeFileSync(globalFile, JSON.stringify(globalLayerConfig || {}, null, 2));
  const writeLayer = (agentId, sparse) => {
    const file = join(root, `layer-${agentId}.json`);
    writeFileSync(file, JSON.stringify(sparse, null, 2));
    return {
      layers: [
        { id: 'global', label: '全局', path: globalFile },
        { id: 'agent', label: 'agent', path: file },
      ],
    };
  };
  table.set('programming-helper', () => writeLayer('programming-helper', agentLayerConfig?.['programming-helper'] || {}));
  table.set('coder', () => writeLayer('coder', agentLayerConfig?.coder || {}));
  return table;
}

describe('composePanelDeclarations', async () => {
  it('可见性由装配层级决定：空间装配 → when 限定装配身份（scope 不参与裁决）', async () => {
    const mounted = makePluginTgz({
      packageName: 'mounted-plugin',
      version: '1.0.0',
      manifest: uiManifest([
        { id: 'mounted-panel', entry: 'index.js', scope: 'assembly' },
        { id: 'global-panel', entry: 'index.js', scope: 'global' },
      ]),
    });
    const assetsRoot = join(root, 'assets');
    for (const pkg of ['mounted-plugin']) {
      await extractClientAssets(
        { archivePath: mounted.archivePath, packageName: pkg, version: '1.0.0', archiveDigest: mounted.digest },
        { expectClient: true, assetsRoot },
      );
    }
    const table = makeLayerTable({
      'programming-helper': { 'mounted-plugin': { $mount: { package: 'mounted-plugin', version: '1.0.0' } } },
    });

    const { declarations, warnings } = await composePanelDeclarations({
      catalogRoots: { userRoot: join(root), officialRoot: join(root, 'official-empty') },
      resolvers: table,
      assetsRoot,
    });

    assert.deepEqual(warnings, []);
    const mountedPanel = declarations.find((d) => d.panelId === 'mounted-panel');
    const globalPanel = declarations.find((d) => d.panelId === 'global-panel');
    // ADR-0046：scope 降级为装配建议，两个面板都按装配层级（空间级）限可见性
    assert.deepEqual(mountedPanel?.meta.when, { agentIds: ['programming-helper'] });
    assert.deepEqual(globalPanel?.meta.when, { agentIds: ['programming-helper'] });
    assert.equal(mountedPanel.url, '/protoclaw/feature-assets/mounted-plugin/1.0.0/index.js');
    assert.equal(mountedPanel.pluginId, 'mounted-panel');
  });

  it('全局级装配（global 层 $mount）→ 面板处处可见，when 不设 agentIds', async () => {
    const fixture = makePluginTgz({
      packageName: 'global-mounted-plugin',
      version: '1.0.0',
      manifest: uiManifest([{ id: 'anywhere-panel', entry: 'index.js' }]),
    });
    const assetsRoot = join(root, 'assets');
    await extractClientAssets(
      { archivePath: fixture.archivePath, packageName: 'global-mounted-plugin', version: '1.0.0', archiveDigest: fixture.digest },
      { expectClient: true, assetsRoot },
    );
    const { declarations, warnings } = await composePanelDeclarations({
      catalogRoots: { userRoot: join(root), officialRoot: join(root, 'official-empty') },
      resolvers: makeLayerTable({}, { 'global-mounted-plugin': { $mount: { package: 'global-mounted-plugin', version: '1.0.0' } } }),
      assetsRoot,
    });
    assert.deepEqual(warnings, []);
    const panel = declarations.find((d) => d.panelId === 'anywhere-panel');
    assert.deepEqual(panel?.meta.when, {});
  });

  it('混合装配：global + 空间身份并存 → 按全局级处理（处处可见）', async () => {
    const fixture = makePluginTgz({
      packageName: 'mixed-plugin',
      version: '1.0.0',
      manifest: uiManifest([{ id: 'mixed-panel', entry: 'index.js' }]),
    });
    const assetsRoot = join(root, 'assets');
    await extractClientAssets(
      { archivePath: fixture.archivePath, packageName: 'mixed-plugin', version: '1.0.0', archiveDigest: fixture.digest },
      { expectClient: true, assetsRoot },
    );
    const { declarations } = await composePanelDeclarations({
      catalogRoots: { userRoot: join(root), officialRoot: join(root, 'official-empty') },
      resolvers: makeLayerTable(
        { coder: { 'mixed-plugin': { $mount: { package: 'mixed-plugin', version: '1.0.0' } } } },
        { 'mixed-plugin': { $mount: { package: 'mixed-plugin', version: '1.0.0' } } },
      ),
      assetsRoot,
    });
    assert.deepEqual(declarations.find((d) => d.panelId === 'mixed-panel')?.meta.when, {});
  });

  it('禁用装配（enabled:false）→ 面板不下发；启用装配并存时仍下发', async () => {
    const disabled = makePluginTgz({
      packageName: 'disabled-plugin',
      version: '1.0.0',
      manifest: uiManifest([{ id: 'disabled-panel', entry: 'index.js' }]),
    });
    const enabledFixture = makePluginTgz({
      packageName: 'enabled-plugin',
      version: '1.0.0',
      manifest: uiManifest([{ id: 'enabled-panel', entry: 'index.js' }]),
    });
    const assetsRoot = join(root, 'assets');
    await extractClientAssets(
      { archivePath: disabled.archivePath, packageName: 'disabled-plugin', version: '1.0.0', archiveDigest: disabled.digest },
      { expectClient: true, assetsRoot },
    );
    await extractClientAssets(
      { archivePath: enabledFixture.archivePath, packageName: 'enabled-plugin', version: '1.0.0', archiveDigest: enabledFixture.digest },
      { expectClient: true, assetsRoot },
    );
    const { declarations, warnings } = await composePanelDeclarations({
      catalogRoots: { userRoot: join(root), officialRoot: join(root, 'official-empty') },
      resolvers: makeLayerTable({
        'programming-helper': {
          'disabled-plugin': { $mount: { package: 'disabled-plugin', version: '1.0.0', enabled: false } },
          'enabled-plugin': { $mount: { package: 'enabled-plugin', version: '1.0.0' } },
        },
      }),
      assetsRoot,
    });
    assert.equal(declarations.find((d) => d.panelId === 'disabled-panel'), undefined, '禁用装配的面板不下发');
    assert.deepEqual(warnings, [], '禁用是显式处置，不是告警形态');
    const panel = declarations.find((d) => d.panelId === 'enabled-panel');
    assert.deepEqual(panel?.meta.when, { agentIds: ['programming-helper'] }, '启用装配不受禁用条目影响');
  });

  it('工作空间装配 + chat surfaces → 仅声明到指定身份的聊天面，不含工作空间首页', async () => {
    const fixture = makePluginTgz({
      packageName: 'chat-only-plugin',
      version: '1.0.0',
      manifest: uiManifest([{ id: 'chat-only-panel', entry: 'index.js', when: { surfaces: ['chat'] } }]),
    });
    const assetsRoot = join(root, 'assets');
    await extractClientAssets(
      { archivePath: fixture.archivePath, packageName: 'chat-only-plugin', version: '1.0.0', archiveDigest: fixture.digest },
      { expectClient: true, assetsRoot },
    );
    const { declarations } = await composePanelDeclarations({
      catalogRoots: { userRoot: join(root), officialRoot: join(root, 'official-empty') },
      resolvers: makeLayerTable({
        'programming-helper': { 'chat-only-plugin': { $mount: { package: 'chat-only-plugin', version: '1.0.0' } } },
      }),
      assetsRoot,
    });
    assert.deepEqual(declarations.find((d) => d.panelId === 'chat-only-panel')?.meta.when, {
      agentIds: ['programming-helper'],
      surfaces: ['chat'],
    });
  });

  it('global 层禁用装配 → 全局面板不下发', async () => {
    const fixture = makePluginTgz({
      packageName: 'global-disabled-plugin',
      version: '1.0.0',
      manifest: uiManifest([{ id: 'gd-panel', entry: 'index.js' }]),
    });
    const assetsRoot = join(root, 'assets');
    await extractClientAssets(
      { archivePath: fixture.archivePath, packageName: 'global-disabled-plugin', version: '1.0.0', archiveDigest: fixture.digest },
      { expectClient: true, assetsRoot },
    );
    const { declarations } = await composePanelDeclarations({
      catalogRoots: { userRoot: join(root), officialRoot: join(root, 'official-empty') },
      resolvers: makeLayerTable({}, { 'global-disabled-plugin': { $mount: { package: 'global-disabled-plugin', version: '1.0.0', enabled: false } } }),
      assetsRoot,
    });
    assert.equal(declarations.find((d) => d.panelId === 'gd-panel'), undefined);
  });

  it('未装配不下发：含作者标注 scope=global 的面板（导入 ≠ 可用，ADR-0046）', async () => {
    const fixture = makePluginTgz({
      packageName: 'unmounted-plugin',
      manifest: uiManifest([{ id: 'gone-panel', entry: 'index.js' }, { id: 'gone-global', entry: 'index.js', scope: 'global' }]),
    });
    const assetsRoot = join(root, 'assets');
    await extractClientAssets(
      { archivePath: fixture.archivePath, packageName: 'unmounted-plugin', version: '1.0.0', archiveDigest: fixture.digest },
      { expectClient: true, assetsRoot },
    );
    const { declarations } = await composePanelDeclarations({
      catalogRoots: { userRoot: join(root), officialRoot: join(root, 'official-empty') },
      resolvers: makeLayerTable({}),
      assetsRoot,
    });
    assert.equal(declarations.find((d) => d.panelId === 'gone-panel'), undefined);
    assert.equal(declarations.find((d) => d.panelId === 'gone-global'), undefined);
  });

  it('版本钉装配：catalog 存在更高版本不跟随，按装配版本下发', async () => {
    const old = makePluginTgz({
      packageName: 'pinned-plugin',
      version: '1.0.0',
      manifest: uiManifest([{ id: 'pinned-panel', entry: 'index.js' }]),
    });
    const newer = makePluginTgz({
      packageName: 'pinned-plugin',
      version: '1.1.0',
      manifest: uiManifest([{ id: 'pinned-panel', entry: 'index.js' }]),
    });
    const assetsRoot = join(root, 'assets');
    await extractClientAssets(
      { archivePath: old.archivePath, packageName: 'pinned-plugin', version: '1.0.0', archiveDigest: old.digest },
      { expectClient: true, assetsRoot },
    );
    await extractClientAssets(
      { archivePath: newer.archivePath, packageName: 'pinned-plugin', version: '1.1.0', archiveDigest: newer.digest },
      { expectClient: true, assetsRoot },
    );
    const { declarations } = await composePanelDeclarations({
      catalogRoots: { userRoot: join(root), officialRoot: join(root, 'official-empty') },
      resolvers: makeLayerTable({
        'programming-helper': { 'pinned-plugin': { $mount: { package: 'pinned-plugin', version: '1.0.0' } } },
      }),
      assetsRoot,
    });
    const panel = declarations.find((d) => d.panelId === 'pinned-panel');
    assert.equal(panel?.version, '1.0.0');
    assert.ok(panel?.url.includes('/1.0.0/'));
  });

  it('装配版本已不在仓库：跳过下发并出警告', async () => {
    makePluginTgz({
      packageName: 'ghost-plugin',
      version: '1.0.0',
      manifest: uiManifest([{ id: 'ghost-panel', entry: 'index.js' }]),
    });
    // 包仍在仓库（1.0.0），装配声明指向不存在的 1.1.0
    const { declarations, warnings } = await composePanelDeclarations({
      catalogRoots: { userRoot: join(root), officialRoot: join(root, 'official-empty') },
      resolvers: makeLayerTable({
        'programming-helper': { 'ghost-plugin': { $mount: { package: 'ghost-plugin', version: '1.1.0' } } },
      }),
      assetsRoot: join(root, 'assets'),
    });
    assert.equal(declarations.length, 0);
    assert.ok(warnings.some((w) => w.includes('ghost-plugin') && w.includes('不在仓库')));
  });

  it('tgz 手拷未走导入：声明合成的自愈解出后正常下发面板（#9）', async () => {
    makePluginTgz({
      packageName: 'no-asset-plugin',
      manifest: uiManifest([{ id: 'no-asset-panel', entry: 'index.js' }]),
    });
    const { declarations, warnings } = await composePanelDeclarations({
      catalogRoots: { userRoot: join(root), officialRoot: join(root, 'official-empty') },
      resolvers: makeLayerTable({
        'programming-helper': { 'no-asset-plugin': { $mount: { package: 'no-asset-plugin', version: '1.0.0' } } },
      }),
      assetsRoot: join(root, 'assets'), // 从未解出
    });
    assert.deepEqual(warnings, []);
    assert.equal(declarations.length, 1);
    assert.equal(declarations[0].panelId, 'no-asset-panel');
    // 自愈解出的资产可被 serve 层直接解析（URL 链路闭环）
    const served = await resolveClientAssetWithHeal(
      { packageName: 'no-asset-plugin', version: '1.0.0', file: 'index.js' },
      { catalogRoots: { userRoot: join(root), officialRoot: join(root, 'official-empty') }, assetsRoot: join(root, 'assets') },
    );
    assert.ok(served);
    assert.equal(readFileSync(served, 'utf8'), 'export default {}');
  });

  it('client 面解出自愈不可达（tgz 声明了 ui 面但无 client/）：面板跳过下发并警告', async () => {
    // manifest 带 ui 面声明、tgz 内却无 client/ 目录：自愈解出必然无产物
    // （extractClientAssets 无该面返回 extracted:false），面板级检查按缺失跳过。
    makePluginTgz({
      packageName: 'broken-no-client',
      clientFiles: {},
      manifest: uiManifest([{ id: 'p-no-client', entry: 'index.js' }]),
    });
    const { declarations, warnings } = await composePanelDeclarations({
      catalogRoots: { userRoot: join(root), officialRoot: join(root, 'official-empty') },
      resolvers: makeLayerTable({
        'programming-helper': { 'broken-no-client': { $mount: { package: 'broken-no-client', version: '1.0.0' } } },
      }),
      assetsRoot: join(root, 'assets'),
    });
    assert.equal(declarations.length, 0);
    assert.ok(warnings.some((w) => w.includes('broken-no-client') && w.includes('未解出')));
  });

  it('collects warnings for invalid declarations instead of failing the whole catalog', async () => {
    const assetsRoot = join(root, 'assets');
    const broken = makePluginTgz({
      packageName: 'broken-plugin',
      manifest: uiManifest([
        { entry: 'index.js' }, // 缺 id
        { id: 'bad-entry', entry: '../../etc/passwd' }, // entry 穿越
        { id: 'bad-scope', entry: 'index.js', scope: 'everywhere' }, // scope 非法
        { id: 'ok-panel', entry: 'index.js', scope: 'global', order: 5, label: { zh: '正常', en: 'OK' } },
      ]),
    });
    await extractClientAssets(
      { archivePath: broken.archivePath, packageName: 'broken-plugin', version: '1.0.0', archiveDigest: broken.digest },
      { expectClient: true, assetsRoot },
    );
    const { declarations, warnings } = await composePanelDeclarations({
      catalogRoots: { userRoot: join(root), officialRoot: join(root, 'official-empty') },
      resolvers: makeLayerTable({
        'programming-helper': { 'broken-plugin': { $mount: { package: 'broken-plugin', version: '1.0.0' } } },
      }),
      assetsRoot,
    });
    const ids = declarations.map((d) => d.panelId);
    assert.deepEqual(ids, ['ok-panel']);
    assert.equal(warnings.filter((w) => w.includes('broken-plugin')).length, 3);
    assert.equal(declarations[0].meta.order, 5);
    assert.deepEqual(declarations[0].meta.label, { zh: '正常', en: 'OK' });
  });
});

// ── 资产自愈（懒解出）──────────────────────────────────────────────

describe('资产自愈（ensureFacetExtracted / resolveClientAssetWithHeal）', () => {
  beforeEach(() => {
    resetAssetHealCachesForTest();
  });

  /** 把 fixture tgz 挪进"仓库"，返回 catalogRoots（隔离注入）。 */
  function seedRepository(tgzPath, fileName) {
    const repoRoot = join(root, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    renameSync(tgzPath, join(repoRoot, fileName));
    return { userRoot: repoRoot, officialRoot: join(root, 'official-empty') };
  }

  it('client 面：解出目录缺失时从仓库 tgz 现场解出，资产可读（URL 目录段名形态）', async () => {
    const { archivePath } = makePluginTgz({
      packageName: '@adv/demo',
      version: '0.2.0',
      manifest: uiManifest([{ id: 'p1', entry: 'index.js' }]),
    });
    const catalogRoots = seedRepository(archivePath, 'adv!demo-0.2.0.tgz');
    const assetsRoot = join(root, 'assets'); // 从未解出
    const filePath = await resolveClientAssetWithHeal(
      { packageName: 'adv!demo', version: '0.2.0', file: 'index.js' }, // URL 段名形态（@ 不保留）
      { catalogRoots, assetsRoot },
    );
    assert.ok(filePath, '自愈后应解析出资产路径');
    assert.equal(readFileSync(filePath, 'utf8'), 'export default {}');
  });

  it('catalog 查无时降级 404 语义；60s 负缓存内补上 tgz 仍不自愈；TTL 过期后恢复', async (t) => {
    const catalogRoots = { userRoot: join(root, 'repo'), officialRoot: join(root, 'official-empty') };
    mkdirSync(catalogRoots.userRoot, { recursive: true });
    const opts = { catalogRoots, assetsRoot: join(root, 'assets') };
    const params = { packageName: 'ghost-plugin', version: '1.0.0', file: 'index.js' };

    // 仓库为空：自愈不可达，按缺失处理（null，不抛错）
    assert.equal(await resolveClientAssetWithHeal(params, opts), null);

    // 补上 tgz：负缓存仍在有效期，不重扫 catalog，结果不变。
    // 若没有负缓存，这次调用会重扫并自愈成功（返回非 null）——断言因此有区分度。
    const { archivePath } = makePluginTgz({ packageName: 'ghost-plugin', version: '1.0.0' });
    renameSync(archivePath, join(catalogRoots.userRoot, 'ghost-plugin-1.0.0.tgz'));
    assert.equal(await resolveClientAssetWithHeal(params, opts), null);

    // 快进 61s（锚定真实时钟，避免 mock 从 0 起算导致负缓存永不过期）：缓存过期，自愈成功
    t.mock.timers.enable({ time: ['Date'], now: Date.now() });
    t.mock.timers.tick(61_000);
    assert.ok(await resolveClientAssetWithHeal(params, opts));
  });

  it('server 面：ensureFacetExtracted(facet=server) 从仓库 tgz 解出，目录按 versionServerDir 可寻址', async () => {
    const { archivePath } = makePluginTgz({
      packageName: 'srv-heal',
      version: '0.1.0',
      manifest: { schemaVersion: 3, id: 'srv-heal', entry: 'dist/index.js', server: { entry: 'index.js', prefix: 'srv-heal' } },
      clientFiles: {},
      serverFiles: { 'index.js': 'export default { registerRoutes() {} };\n' },
    });
    const catalogRoots = seedRepository(archivePath, 'srv-heal-0.1.0.tgz');
    const serverRoot = join(root, 'srv'); // 从未解出
    const result = await ensureFacetExtracted(
      { packageName: 'srv-heal', version: '0.1.0', facet: 'server' },
      { catalogRoots, serverRoot },
    );
    assert.equal(result.healed, true);
    assert.equal(result.fileCount, 2); // index.js + 自动补写的 package.json ESM 标记
    const entryPath = join(versionServerDir({ packageName: 'srv-heal', version: '0.1.0' }, serverRoot), 'index.js');
    assert.ok(existsSync(entryPath), 'server 入口应已解出到版本目录');
  });

  it('同坐标并发自愈不互踩：两个并发调用都成功且产物完整', async () => {
    const { archivePath } = makePluginTgz({ packageName: 'par-heal', version: '1.0.0', manifest: uiManifest([{ id: 'p1', entry: 'index.js' }]) });
    const catalogRoots = seedRepository(archivePath, 'par-heal-1.0.0.tgz');
    const opts = { catalogRoots, assetsRoot: join(root, 'assets') };
    const args = { packageName: 'par-heal', version: '1.0.0', facet: 'client' };
    const [first, second] = await Promise.all([
      ensureFacetExtracted(args, opts),
      ensureFacetExtracted(args, opts),
    ]);
    // rm+untar 非原子：无 inflight 去重时并发重入会互踩（目录半写/ENOENT）。
    // 此处断言并发正确性（都成功、产物完整可读）；"只解出一次"由 inflight 共享保证。
    assert.equal(first.healed, true);
    assert.equal(second.healed, true);
    const filePath = await resolveClientAsset({ packageName: 'par-heal', version: '1.0.0', file: 'index.js' }, opts.assetsRoot);
    assert.ok(filePath);
    assert.equal(readFileSync(filePath, 'utf8'), 'export default {}');
  });

  it('目录存在但文件缺失（包损坏）不触发自愈，保持 404 如实', async () => {
    const { archivePath } = makePluginTgz({
      packageName: 'damaged-plugin',
      version: '1.0.0',
      manifest: uiManifest([{ id: 'p1', entry: 'index.js' }]),
      clientFiles: { 'index.js': 'export default {}', 'extra.css': 'body{}' },
    });
    const catalogRoots = seedRepository(archivePath, 'damaged-plugin-1.0.0.tgz');
    const assetsRoot = join(root, 'assets');
    // 正常解出后删掉其中一个文件：目录仍在，内容残缺
    await ensureFacetExtracted({ packageName: 'damaged-plugin', version: '1.0.0', facet: 'client' }, { catalogRoots, assetsRoot });
    rmSync(join(versionAssetDir({ packageName: 'damaged-plugin', version: '1.0.0' }, assetsRoot), 'extra.css'));
    // 请求已删除的文件：目录存在 → 不自愈（否则会掩盖包损坏），null 如实
    assert.equal(
      await resolveClientAssetWithHeal({ packageName: 'damaged-plugin', version: '1.0.0', file: 'extra.css' }, { catalogRoots, assetsRoot }),
      null,
    );
  });
});
