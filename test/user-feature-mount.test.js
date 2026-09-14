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
import { validateLayerContent } from '../server/routes/feature-config.js';
import { mountUserConfiguredFeatures } from '../server/feature-runtime/user-mount.js';
import { packageFeatureProject } from '../server/feature-runtime/packager.js';

const mount = (pkg, version) => ({ [MOUNT_KEY]: { package: pkg, version } });

describe('extractFeatureMounts', () => {
  it('提取允许层的 $mount，并从纯配置层剔除该键', () => {
    const { mounts, configLayers } = extractFeatureMounts([
      { id: 'global', config: { shell: { allowDangerous: true } } },
      { id: 'agent', config: { 'demo-feature': { ...mount('@scope/demo', '1.0.0'), strict: true } } },
    ]);
    assert.equal(mounts.size, 1);
    assert.deepEqual(mounts.get('demo-feature'), { package: '@scope/demo', version: '1.0.0', layerId: 'agent' });
    assert.deepEqual(configLayers[0], { shell: { allowDangerous: true } });
    assert.deepEqual(configLayers[1], { 'demo-feature': { strict: true } });
  });

  it('coder 层同样是允许层', () => {
    const { mounts } = extractFeatureMounts([
      { id: 'global', config: {} },
      { id: 'coder', config: { 'demo-feature': mount('@scope/demo', '1.0.0') } },
    ]);
    assert.equal(mounts.get('demo-feature').layerId, 'coder');
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
});
