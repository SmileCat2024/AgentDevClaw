/**
 * 用户 $mount 装配（feature 装配一期）测试
 *
 * 覆盖：
 * - extractFeatureMounts：允许层提取 / 后层整体替换 / null 卸载 / 目录层与
 *   会话注入拒绝 / 结构 fail fast / 纯函数纪律
 * - validateLayerContent 的 $mount 写回约束（目录层拒绝、允许层结构校验）
 * - mountUserConfiguredFeatures：真实 tgz 仓库 → 隔离环境 → 挂载（真实
 *   npm install，timeout 对齐现有 provisioner 测试放宽）；缺包 fail fast
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

import { extractFeatureMounts, MOUNT_KEY } from '../server/shared/feature-mount.js';
import { validateLayerContent, registerScopeResolver } from '../server/routes/feature-config.js';
import { mountUserConfiguredFeatures } from '../server/feature-runtime/user-mount.js';
import { buildStorePackages, buildBuiltinShowcase, collectScopeMounts, collectScopeMountManifests, summarizeInstanceSurface } from '../server/routes/feature-store.js';
import { packageFeatureProject } from '../server/feature-runtime/packager.js';
import { runCommand } from '../server/routes/fs-operations.js';

const mount = (pkg, version) => ({ [MOUNT_KEY]: { package: pkg, version } });

describe('extractFeatureMounts', () => {
  it('提取允许层的 $mount，并从纯配置层剔除该键', () => {
    const { mounts, configLayers } = extractFeatureMounts([
      { id: 'global', config: { shell: { allowDangerous: true } } },
      { id: 'agent', config: { 'demo-feature': { ...mount('@scope/demo', '1.0.0'), strict: true } } },
    ]);
    assert.equal(mounts.size, 1);
    assert.deepEqual(mounts.get('demo-feature'), { kind: 'repository', package: '@scope/demo', version: '1.0.0', layerId: 'agent' });
    assert.deepEqual(configLayers[0], { shell: { allowDangerous: true } });
    assert.deepEqual(configLayers[1], { 'demo-feature': { strict: true } });
  });

  it('coder 层同样是允许层', () => {
    const { mounts } = extractFeatureMounts([
      { id: 'global', config: {} },
      { id: 'coder', config: { 'demo-feature': mount('@scope/demo', '1.0.0') } },
    ]);
    assert.equal(mounts.get('demo-feature').layerId, 'coder');
    assert.equal(mounts.get('demo-feature').kind, 'repository');
  });

  it('builtin 形态：{ kind: "builtin" } 合法且不带包版本', () => {
    const { mounts, configLayers } = extractFeatureMounts([
      { id: 'agent', config: { 'playwright-shell': { [MOUNT_KEY]: { kind: 'builtin' }, extra: 1 } } },
    ]);
    assert.deepEqual(mounts.get('playwright-shell'), { kind: 'builtin', layerId: 'agent' });
    assert.deepEqual(configLayers[0], { 'playwright-shell': { extra: 1 } });
  });

  it('builtin 与 repository 同层混用互不干扰', () => {
    const { mounts } = extractFeatureMounts([
      { id: 'agent', config: {
        'playwright-shell': { [MOUNT_KEY]: { kind: 'builtin' } },
        'demo-feature': mount('@scope/demo', '1.0.0'),
      } },
    ]);
    assert.equal(mounts.get('playwright-shell').kind, 'builtin');
    assert.equal(mounts.get('demo-feature').kind, 'repository');
  });

  it('后层 $mount 整体替换前层（装配事实不做字段级合并）', () => {
    const { mounts } = extractFeatureMounts([
      { id: 'global', config: { demo: mount('@scope/demo', '1.0.0') } },
      { id: 'agent', config: { demo: mount('@scope/demo', '2.0.0') } },
    ]);
    assert.equal(mounts.size, 1);
    assert.equal(mounts.get('demo').version, '2.0.0');
  });

  it('$mount: null 卸载前层装配', () => {
    const { mounts, configLayers } = extractFeatureMounts([
      { id: 'global', config: { demo: mount('@scope/demo', '1.0.0'), shell: { a: 1 } } },
      { id: 'agent', config: { demo: { [MOUNT_KEY]: null } } },
    ]);
    assert.equal(mounts.size, 0);
    // 卸载后配置层为空对象（$mount 键剔除后无剩余键）
    assert.deepEqual(configLayers[1], { demo: {} });
  });

  it('目录层拒绝 $mount', () => {
    assert.throws(
      () => extractFeatureMounts([{ id: 'dir', config: { demo: mount('@scope/demo', '1.0.0') } }]),
      /'dir'.*不允许声明.*demo/
    );
  });

  it('会话注入层拒绝 $mount', () => {
    assert.throws(
      () => extractFeatureMounts([{ id: 'session', config: { demo: mount('@scope/demo', '1.0.0') } }]),
      /'session'.*不允许声明/
    );
  });

  it('结构非法时 fail fast（非对象 / 坏包名 / 非精确版本）', () => {
    assert.throws(() => extractFeatureMounts([{ id: 'agent', config: { demo: { [MOUNT_KEY]: 'x' } } }]), /\$mount 必须是/);
    assert.throws(() => extractFeatureMounts([{ id: 'agent', config: { demo: mount('Not Valid!', '1.0.0') } }]), /包名/);
    assert.throws(() => extractFeatureMounts([{ id: 'agent', config: { demo: mount('@scope/demo', '^1.0.0') } }]), /精确 semver/);
    assert.throws(() => extractFeatureMounts([{ id: 'agent', config: { demo: mount('@scope/demo', '') } }]), /精确 semver/);
  });

  it('无 $mount 时 configLayers 与输入一致（存量行为等价）', () => {
    const layer = { shell: { args: ['a'] }, lsp: { mode: 'runtime' } };
    const { mounts, configLayers } = extractFeatureMounts([{ id: 'global', config: layer }]);
    assert.equal(mounts.size, 0);
    assert.equal(configLayers[0], layer);
  });

  it('不污染输入层对象（纯函数纪律）', () => {
    const layer = { demo: { ...mount('@scope/demo', '1.0.0'), strict: true } };
    const snapshot = JSON.stringify(layer);
    extractFeatureMounts([{ id: 'agent', config: layer }]);
    assert.equal(JSON.stringify(layer), snapshot);
    assert.equal(MOUNT_KEY in layer.demo, true);
  });

  it('非对象 config 层原样通过（readLayerFile 兜底 {} / 会话注入缺省）', () => {
    const { mounts, configLayers } = extractFeatureMounts([
      { id: 'global', config: {} },
      { id: 'session', config: undefined },
    ]);
    assert.equal(mounts.size, 0);
    assert.deepEqual(configLayers[1], {});
  });
});

describe('validateLayerContent 的 $mount 写回约束', () => {
  it('单参调用（旧形态）不校验 $mount', () => {
    assert.equal(validateLayerContent({ demo: mount('@scope/demo', '1.0.0') }), null);
  });

  it('目录层拒绝 $mount', () => {
    const error = validateLayerContent({ demo: mount('@scope/demo', '1.0.0') }, { layerId: 'dir:D:/proj' });
    assert.match(error, /不支持 \$mount/);
  });

  it('允许层接受合法 $mount', () => {
    for (const layerId of ['global', 'agent', 'coder']) {
      assert.equal(validateLayerContent({ demo: mount('@scope/demo', '1.0.0') }, { layerId }), null);
    }
  });

  it('允许层拒绝非法 $mount', () => {
    assert.match(
      validateLayerContent({ demo: mount('@scope/demo', 'latest') }, { layerId: 'agent' }),
      /精确 semver/
    );
  });

  it('允许层接受 builtin 形态 $mount', () => {
    for (const layerId of ['global', 'agent', 'coder']) {
      assert.equal(
        validateLayerContent({ 'playwright-shell': { $mount: { kind: 'builtin' } } }, { layerId }),
        null,
      );
    }
    // 目录层对 builtin 同样拒绝
    assert.match(
      validateLayerContent({ 'playwright-shell': { $mount: { kind: 'builtin' } } }, { layerId: 'dir:D:/x' }),
      /不支持 \$mount/,
    );
  });
});

describe('mountUserConfiguredFeatures（真实装配链）', () => {
  it('从临时 tgz 仓库解析、建隔离环境并挂载，配置值注入构造参数', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'user-feature-mount-'));
    try {
      const projectDir = path.join(root, 'demo');
      const repositoryDir = path.join(root, 'repository');
      await mkdir(path.join(projectDir, 'dist'), { recursive: true });
      await writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
        name: '@agentdevjs/demo-mount-feature',
        version: '1.0.0',
        type: 'module',
        main: 'dist/index.js',
        files: ['dist'],
        scripts: { build: 'node -e ""' },
      }));
      await writeFile(
        path.join(projectDir, 'dist', 'index.js'),
        'export class DemoMountFeature { constructor(config) { this.name = "demo-mount"; this.config = config; } }\n'
      );
      await packageFeatureProject({ projectDir, repositoryDir });

      const agent = {
        features: new Map(),
        config: { features: { 'demo-mount': { flag: true } } },
        async mountFeature(feature) { this.features.set(feature.name, feature); },
      };
      const mounts = new Map([
        ['demo-mount', { package: '@agentdevjs/demo-mount-feature', version: '1.0.0', layerId: 'agent' }],
      ]);
      const output = await mountUserConfiguredFeatures(agent, mounts, {
        agentId: 'test-agent',
        catalogRoots: { officialRoot: repositoryDir, userRoot: path.join(root, 'no-user-repo') },
        environmentRoot: path.join(root, 'runtime-envs'),
      });
      assert.equal(output.length, 1);
      assert.equal(output[0].name, 'demo-mount');
      assert.equal(agent.features.has('demo-mount'), true);
      // 配置值来自合并树（$mount 键名下、$mount 键已剔除），经 plan 注入构造参数
      assert.deepEqual(agent.features.get('demo-mount').config, { flag: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, { timeout: 120000 });

  it('仓库缺包时 fail fast（不静默降级）', async () => {
    const agent = { features: new Map(), config: { features: {} }, async mountFeature() {} };
    const mounts = new Map([['missing', { package: '@scope/missing', version: '1.0.0', layerId: 'agent' }]]);
    await assert.rejects(
      () => mountUserConfiguredFeatures(agent, mounts, {
        agentId: 'test-agent',
        catalogRoots: {
          officialRoot: path.join(os.tmpdir(), 'nonexistent-official-repo'),
          userRoot: path.join(os.tmpdir(), 'nonexistent-user-repo'),
        },
      }),
      /不存在包/
    );
  });

  it('空 mounts 直接返回空数组', async () => {
    assert.deepEqual(await mountUserConfiguredFeatures({}, new Map(), { agentId: 'x' }), []);
  });

  it('实例 name 与 $mount 键不一致时 fail fast', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'user-feature-mount-'));
    try {
      const projectDir = path.join(root, 'mismatch');
      const repositoryDir = path.join(root, 'repository');
      await mkdir(path.join(projectDir, 'dist'), { recursive: true });
      await writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
        name: '@agentdevjs/mismatch-feature',
        version: '1.0.0',
        type: 'module',
        main: 'dist/index.js',
        files: ['dist'],
        scripts: { build: 'node -e ""' },
      }));
      await writeFile(
        path.join(projectDir, 'dist', 'index.js'),
        'export class MismatchFeature { constructor() { this.name = "actual-name"; } }\n'
      );
      await packageFeatureProject({ projectDir, repositoryDir });

      const agent = {
        features: new Map(),
        config: { features: {} },
        async mountFeature(feature) { this.features.set(feature.name, feature); },
      };
      const mounts = new Map([
        ['declared-name', { package: '@agentdevjs/mismatch-feature', version: '1.0.0', layerId: 'agent' }],
      ]);
      await assert.rejects(
        () => mountUserConfiguredFeatures(agent, mounts, {
          agentId: 'test-agent',
          catalogRoots: { officialRoot: repositoryDir, userRoot: path.join(root, 'no-user-repo') },
          environmentRoot: path.join(root, 'runtime-envs'),
        }),
        /实例 name 是 'actual-name'.*'declared-name' 不一致/
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, { timeout: 120000 });
});

describe('feature-store 数据面', () => {
  it('buildStorePackages 只列用户仓库源，展示名取 manifest', () => {
    const catalog = {
      packages: new Map([
        ['@user/only-user', [
          { version: '1.0.0', source: 'custom', archiveDigest: 'sha256:a', manifestName: '用户插件', manifestDescription: '描述' },
          { version: '0.9.0', source: 'custom', archiveDigest: 'sha256:b', manifestName: '用户插件', manifestDescription: '描述' },
        ]],
        ['@agentdevjs/mixed', [
          { version: '2.0.0', source: 'custom', archiveDigest: 'sha256:c', manifestName: '', manifestDescription: '' },
          { version: '1.0.0', source: 'official', archiveDigest: 'sha256:d', manifestName: '', manifestDescription: '' },
        ]],
        ['@agentdevjs/only-official', [
          { version: '1.0.0', source: 'official', archiveDigest: 'sha256:e', manifestName: '', manifestDescription: '' },
        ]],
      ]),
      invalid: [],
    };
    const packages = buildStorePackages(catalog);
    assert.equal(packages.length, 2);
    assert.deepEqual(packages[0], {
      package: '@user/only-user',
      displayName: '用户插件',
      description: '描述',
      versions: [{ version: '1.0.0', digest: 'sha256:a' }, { version: '0.9.0', digest: 'sha256:b' }],
    });
    // 混源包只保留 custom 版本；展示名回退包名末段
    assert.deepEqual(packages[1].versions, [{ version: '2.0.0', digest: 'sha256:c' }]);
    assert.equal(packages[1].displayName, 'mixed');
  });

  it('collectScopeMounts 提取层内 $mount 并标记 missing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'feature-store-scope-'));
    try {
      const layerPath = path.join(root, 'agent-layer.json');
      await writeFile(layerPath, JSON.stringify({
        'demo-mount': { [MOUNT_KEY]: { package: '@user/demo', version: '1.0.0' } },
        'gone-mount': { [MOUNT_KEY]: { package: '@user/gone', version: '9.9.9' } },
        'playwright-shell': { [MOUNT_KEY]: { kind: 'builtin' } },
        shell: { allowDangerous: true },
      }));
      registerScopeResolver('test-store-scope', () => ({ layers: [
        { id: 'global', label: 'global', path: path.join(root, 'missing-global.json') },
        { id: 'agent', label: 'agent', path: layerPath },
      ] }));
      const catalog = {
        packages: new Map([
          ['@user/demo', [{ version: '1.0.0', source: 'custom', archiveDigest: 'x' }]],
        ]),
        invalid: [],
      };
      const mounts = await collectScopeMounts('test-store-scope', catalog);
      assert.deepEqual(mounts['demo-mount'], {
        kind: 'repository', package: '@user/demo', version: '1.0.0', layerId: 'agent', missing: false,
      });
      assert.equal(mounts['gone-mount'].missing, true);
      // builtin 不查 tgz 仓库，永不误报 missing
      assert.deepEqual(mounts['playwright-shell'], { kind: 'builtin', layerId: 'agent', missing: false });
      assert.equal('shell' in mounts, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('buildBuiltinShowcase 自加载工厂实例 name/description 并聚合 identities', () => {
    const factory = () => ({ name: 'demo-shell', description: '演示描述' });
    const showcase = buildBuiltinShowcase({
      main: { 'demo-shell': { create: factory } },
      coder: { 'demo-shell': { create: factory } },
    });
    assert.deepEqual(showcase, [{
      runtimeName: 'demo-shell',
      title: 'demo-shell',
      description: '演示描述',
      identities: ['main', 'coder'],
    }]);
    // 工厂不可实例化时仅列名，不阻断货架
    assert.deepEqual(buildBuiltinShowcase({ main: { broken: { create: () => { throw new Error('boom'); } } } }), [{
      runtimeName: 'broken', title: 'broken', description: '', identities: ['main'],
    }]);
  });

  it('summarizeInstanceSurface 静态读取声明面：hooks/tools/skills/commands 与 slash 口径', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'feature-surface-'));
    try {
      // skills/ 下仅含 SKILL.md 的子目录计入（对齐框架 discover 口径）
      await mkdir(path.join(root, 'skills', 'demo-skill'), { recursive: true });
      await mkdir(path.join(root, 'skills', 'not-a-skill'), { recursive: true });
      await writeFile(path.join(root, 'skills', 'demo-skill', 'SKILL.md'), '# demo');
      await writeFile(path.join(root, 'skills', 'not-a-skill', 'README.md'), '# x');

      class FakeFeature {
        static hooks = { onCallStart: { lifecycle: 'CallStart', kind: 'observe' } };
        constructor() {
          this.name = 'demo';
          this.description = '演示';
          this.source = path.join(root, 'index.js');
        }
        getTools() { return [{}, {}]; }
        async getAsyncTools() { return [{}]; }
        getCapabilities() {
          return [
            { id: 'a', entryPoints: ['slash', 'feature'] },
            { id: 'b', entryPoints: ['feature'] },
            { id: 'c' }, // 未声明 entryPoints 时默认 feature 入口，不计入 slash
          ];
        }
      }
      assert.deepEqual(summarizeInstanceSurface(new FakeFeature()), {
        hooks: 1, tools: 2, skills: 1, commands: 1,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('summarizeInstanceSurface 不调用 getAsyncTools，tools 只取同步声明面', async () => {
    let asyncCalled = false;
    class FakeMcp {
      static hooks = {};
      constructor() { this.name = 'mcp'; }
      getTools() { return []; }
      async getAsyncTools() { asyncCalled = true; return [{}]; }
    }
    const surface = summarizeInstanceSurface(new FakeMcp());
    assert.deepEqual(surface, { hooks: 0, tools: 0, skills: 0, commands: 0 });
    assert.equal(asyncCalled, false);
  });

  it('collectScopeMountManifests 合并 repository 项 settings 并返回 extras 全集', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'feature-store-mm-'));
    try {
      // 手工 tgz（npm pack 形态的 package/ 前缀）：manifest 带 settings
      const repoDir = path.join(root, 'repo');
      const pkgRoot = path.join(root, 'pkgroot');
      const pkgDir = path.join(pkgRoot, 'package');
      await mkdir(pkgDir, { recursive: true });
      await mkdir(repoDir, { recursive: true });
      const settings = { properties: { strict: { type: 'boolean', default: false } } };
      await writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@user/settings-demo', version: '1.0.0' }));
      await writeFile(path.join(pkgDir, 'agentdev-feature.json'), JSON.stringify({
        schemaVersion: 1, id: 'settings-demo', name: 'settings-demo', version: '1.0.0',
        entry: 'dist/index.js', settings,
      }));
      await runCommand('tar', ['--force-local', '-czf', path.join(repoDir, 'settings-demo-1.0.0.tgz'), 'package'], { cwd: pkgRoot });

      // 层：repository 项（有 settings）+ builtin 项（无 settings 声明）
      const layerPath = path.join(root, 'agent-layer.json');
      await writeFile(layerPath, JSON.stringify({
        'settings-demo': { [MOUNT_KEY]: { package: '@user/settings-demo', version: '1.0.0' } },
        'playwright-shell': { [MOUNT_KEY]: { kind: 'builtin' } },
      }));
      registerScopeResolver('test-mm-scope', () => ({ layers: [
        { id: 'global', label: 'global', path: path.join(root, 'missing-global.json') },
        { id: 'agent', label: 'agent', path: layerPath },
      ] }));

      const result = await collectScopeMountManifests('test-mm-scope', {
        catalogRoots: { officialRoot: repoDir, userRoot: path.join(root, 'no-user-repo') },
        scopeIdentity: 'main',
      });
      assert.deepEqual(result.extras, ['settings-demo', 'playwright-shell']);
      // 只有声明了 settings.properties 的 repository 项进 manifests；builtin 项
      // （playwright-shell 无 getFeatureManifest）只在 extras
      assert.deepEqual(result.manifests, [{ featureName: 'settings-demo', manifest: { settings } }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
