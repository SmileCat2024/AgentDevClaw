import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { packageFeatureProject } from '../server/feature-runtime/packager.js';
import {
  installFeature,
  rebuildEnvironment,
  computeScopeEnvReadiness,
  getInstallState,
  classifyInstallError,
} from '../server/feature-runtime/install-service.js';

// install-service：安装前移执行链的纯逻辑行为（provision 以 stub 替换，
// 不跑真 npm——真实装配链由 user-feature-mount.test.js 与 staging E2E 覆盖）。

/** 临时层 + 测试 resolvers（层文件路径指向临时目录，不触真实用户配置） */
function makeScope() {
  const root = mkdtempSync(join(tmpdir(), 'install-service-'));
  const layerPath = join(root, 'agent-layer.json');
  writeFileSync(layerPath, '{}');
  const resolvers = new Map([
    ['programming-helper', () => ({ layers: [{ id: 'agent', label: 'test', path: layerPath }] })],
  ]);
  return {
    root,
    layerPath,
    resolvers,
    readLayer: () => JSON.parse(readFileSync(layerPath, 'utf8')),
    writeLayer: (content) => writeFileSync(layerPath, JSON.stringify(content)),
    dispose: () => { /* tmp 由 OS 回收，测试进程内不阻塞 */ },
  };
}

/** 真 tgz 仓库（catalog resolve 需要 manifest）。模块级共享：npm build 昂贵，只造一次。 */
async function buildTgzRepository(root, name, version) {
  const projectDir = join(root, 'pkg-' + name.replace(/^@|\//g, '_'));
  const repositoryDir = join(root, 'repository');
  mkdirSync(join(projectDir, 'dist'), { recursive: true });
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
    name, version, type: 'module', main: 'dist/index.js', files: ['dist'],
    scripts: { build: 'node -e ""' },
  }));
  writeFileSync(join(projectDir, 'dist', 'index.js'),
    `export class F { constructor() { this.name = 'demo'; } }\n`);
  await packageFeatureProject({ projectDir, repositoryDir });
  return repositoryDir;
}

const SHARED_ROOT = mkdtempSync(join(tmpdir(), 'install-service-shared-'));
const CATALOG_ROOTS = await (async () => {
  const repositoryDir = await buildTgzRepository(SHARED_ROOT, '@user/demo-feature', '1.0.0');
  return { officialRoot: repositoryDir, userRoot: join(SHARED_ROOT, 'no-user') };
})();

function okProvision(overrides = {}) {
  const calls = [];
  return {
    calls,
    provision: async (arg) => { calls.push(arg); return { installed: true, dependencyHash: 'h', environmentDir: '/tmp/x', ...overrides }; },
  };
}

test('installFeature：成功写声明、plan 与启动链同构', async () => {
  const scope = makeScope();
  const catalogRoots = CATALOG_ROOTS;
  const { calls, provision } = okProvision();
  try {
    const result = await installFeature(
      { identity: 'main', packageName: '@user/demo-feature', version: '1.0.0' },
      { resolvers: scope.resolvers, catalogRoots, provision },
    );
    assert.equal(result.declared, true);
    assert.equal(result.installed, true);
    // 声明落盘：键 = 包 basename，$mount 形态
    const layer = scope.readLayer();
    assert.deepEqual(layer['demo-feature'], { $mount: { package: '@user/demo-feature', version: '1.0.0' } });
    // plan 同构：agent.id 与启动链一致（agentId:sessionType:user-mounts）
    assert.equal(calls[0].plan.agent.id, 'programming-helper:main:user-mounts');
    assert.equal(calls[0].plan.features[0].package, '@user/demo-feature');
  } finally { scope.dispose(); }
});

test('installFeature：provision 失败 → 声明不落盘（原子性）+ 网络错误分类', async () => {
  const scope = makeScope();
  scope.writeLayer({ existing: 'untouched' });
  const catalogRoots = CATALOG_ROOTS;
  const provision = async () => { throw new Error('npm install failed: request to https://registry.npmjs.org/ ETIMEDOUT'); };
  try {
    await assert.rejects(
      installFeature({ identity: 'main', packageName: '@user/demo-feature', version: '1.0.0' },
        { resolvers: scope.resolvers, catalogRoots, provision }),
    );
    // 层文件保持原样（$mount 未写入）
    assert.deepEqual(scope.readLayer(), { existing: 'untouched' });
    // 失败后单飞槽位释放
    assert.equal(getInstallState(), null);
  } finally { scope.dispose(); }
});

test('installFeature：已声明同版本 → 幂等重装、不重复写声明', async () => {
  const scope = makeScope();
  scope.writeLayer({ 'demo-feature': { $mount: { package: '@user/demo-feature', version: '1.0.0' }, myConfig: 1 } });
  const catalogRoots = CATALOG_ROOTS;
  const { calls, provision } = okProvision({ installed: false });
  try {
    const result = await installFeature(
      { identity: 'main', packageName: '@user/demo-feature', version: '1.0.0' },
      { resolvers: scope.resolvers, catalogRoots, provision },
    );
    assert.equal(result.declared, false);
    assert.equal(calls.length, 1, '环境修复语义：仍 provision（可能命中缓存）');
    assert.deepEqual(scope.readLayer()['demo-feature'].myConfig, 1, '既有配置值保留');
  } finally { scope.dispose(); }
});

test('installFeature：仓库无此包 → package_missing、不动层文件', async () => {
  const scope = makeScope();
  const catalogRoots = CATALOG_ROOTS;
  const { provision } = okProvision();
  try {
    await assert.rejects(
      installFeature({ identity: 'main', packageName: '@user/ghost', version: '2.0.0' },
        { resolvers: scope.resolvers, catalogRoots, provision }),
      (err) => {
        assert.equal(classifyInstallError(err).code, 'package_missing');
        return true;
      },
    );
    assert.equal(existsSync(scope.layerPath), true);
    assert.deepEqual(scope.readLayer(), {});
  } finally { scope.dispose(); }
});

test('单飞：进行中第二个安装 → install_busy；结束后释放', async () => {
  const scope = makeScope();
  const catalogRoots = CATALOG_ROOTS;
  let release;
  const gate = new Promise((r) => { release = r; });
  const provision = async () => { await gate; return { installed: true, dependencyHash: 'h' }; };
  try {
    const first = installFeature(
      { identity: 'main', packageName: '@user/demo-feature', version: '1.0.0' },
      { resolvers: scope.resolvers, catalogRoots, provision },
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(getInstallState().packageName, '@user/demo-feature');
    await assert.rejects(
      installFeature({ identity: 'main', packageName: '@user/other', version: '1.0.0' },
        { resolvers: scope.resolvers, catalogRoots, provision }),
      (err) => { assert.equal(classifyInstallError(err).code, 'install_busy'); return true; },
    );
    release();
    await first;
    assert.equal(getInstallState(), null);
  } finally { release?.(); scope.dispose(); }
});

test('rebuildEnvironment：无声明 → nothing_to_rebuild；有声明 → 按现有组合 provision', async () => {
  const scope = makeScope();
  const catalogRoots = CATALOG_ROOTS;
  const { calls, provision } = okProvision();
  try {
    await assert.rejects(
      rebuildEnvironment({ identity: 'main' }, { resolvers: scope.resolvers, catalogRoots, provision }),
      (err) => { assert.equal(classifyInstallError(err).code, 'nothing_to_rebuild'); return true; },
    );
    scope.writeLayer({ 'demo-feature': { $mount: { package: '@user/demo-feature', version: '1.0.0' } } });
    const result = await rebuildEnvironment({ identity: 'main' }, { resolvers: scope.resolvers, catalogRoots, provision });
    assert.equal(result.installed, true);
    assert.equal(calls[0].plan.features.length, 1);
    assert.deepEqual(scope.readLayer()['demo-feature'], { $mount: { package: '@user/demo-feature', version: '1.0.0' } }, 'rebuild 不改声明');
  } finally { scope.dispose(); }
});

test('computeScopeEnvReadiness：空声明恒 ready；有声明按环境 lock 探测', async () => {
  const scope = makeScope();
  const catalogRoots = CATALOG_ROOTS;
  const envRoot = join(scope.root, 'envs');
  const { provision } = okProvision();
  try {
    // 空声明
    assert.deepEqual(
      await computeScopeEnvReadiness('main', { resolvers: scope.resolvers, catalogRoots }),
      { ready: true, hasEnv: false },
    );
    // 有声明 + 先经 install 真写环境（stub 只返回目录，需真建 lock 文件）
    scope.writeLayer({ 'demo-feature': { $mount: { package: '@user/demo-feature', version: '1.0.0' } } });
    assert.deepEqual(
      await computeScopeEnvReadiness('main', { resolvers: scope.resolvers, catalogRoots, environmentRoot: envRoot }),
      { ready: false, hasEnv: true },
    );
    // 用真 provisionRuntimeEnvironment 太重：直接按 install 相同 hash 建目录与 lock
    const { buildUserMountPlan } = await import('../server/feature-runtime/user-mount.js');
    const { computeRuntimeDependencyHash, getRuntimeEnvironmentRoot } = await import('../server/feature-runtime/provisioner.js');
    const { plan } = await buildUserMountPlan({
      mounts: new Map([['demo-feature', { package: '@user/demo-feature', version: '1.0.0' }]]),
      agentId: 'programming-helper', sessionType: 'main', catalogRoots,
    });
    const envDir = getRuntimeEnvironmentRoot(plan.agent.id, computeRuntimeDependencyHash(plan), envRoot);
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, 'runtime-lock.json'), '{}');
    assert.deepEqual(
      await computeScopeEnvReadiness('main', { resolvers: scope.resolvers, catalogRoots, environmentRoot: envRoot }),
      { ready: true, hasEnv: true },
    );
    void provision;
  } finally { scope.dispose(); }
});

test('classifyInstallError 分类表', () => {
  const cases = [
    [new Error('Feature 仓库中不存在包：@x/y'), 'package_missing'],
    [new Error('Feature 仓库中不存在 @x/y@1.0.0'), 'package_missing'],
    [Object.assign(new Error('spawn npm.cmd ENOENT'), { code: 'ENOENT' }), 'npm_unavailable'],
    [new Error('request to https://registry.npmjs.org/ failed, reason: connect ETIMEDOUT'), 'network'],
    [Object.assign(new Error('另一安装正在进行中'), { installErrorCode: 'install_busy' }), 'install_busy'],
    [new Error('tsup build crash'), 'install_failed'],
  ];
  for (const [err, expected] of cases) {
    assert.equal(classifyInstallError(err).code, expected, String(err.message));
  }
});
