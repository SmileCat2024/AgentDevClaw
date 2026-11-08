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

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative as pathRelative } from 'path';
import { Writable } from 'node:stream';
import crypto from 'crypto';

import {
  extractClientAssets,
  resolveClientAsset,
  assetMimeFor,
  streamClientAsset,
  versionAssetDir,
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

  it('skips panels whose client assets were never extracted (tgz 手拷未走导入)', async () => {
    makePluginTgz({
      packageName: 'no-asset-plugin',
      manifest: uiManifest([{ id: 'no-asset-panel', entry: 'index.js' }]),
    });
    const { declarations, warnings } = await composePanelDeclarations({
      catalogRoots: { userRoot: join(root), officialRoot: join(root, 'official-empty') },
      resolvers: makeLayerTable({
        'programming-helper': { 'no-asset-plugin': { $mount: { package: 'no-asset-plugin', version: '1.0.0' } } },
      }),
      assetsRoot: join(root, 'assets'),
    });
    assert.equal(declarations.length, 0);
    assert.ok(warnings.some((w) => w.includes('no-asset-plugin') && w.includes('未解出')));
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
