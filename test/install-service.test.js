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
  // 第二个包进同一仓库目录：合并口径用例需要两个不同包验证 plan 并集
  await buildTgzRepository(SHARED_ROOT, '@user/other-feature', '2.0.0');
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
    // plan 同构：agent.id 与启动链一致（agentId:user-mounts，ADR-0025 后无身份段）
    assert.equal(calls[0].plan.agent.id, 'programming-helper:user-mounts');
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

test('installFeature：已有 builtin 声明共存 → builtin 不进 plan、安装成功', async () => {
  const scope = makeScope();
  scope.writeLayer({
    'some-static-plugin': { $mount: { kind: 'builtin' } },
    'demo-feature': { myConfig: 2 },
  });
  const catalogRoots = CATALOG_ROOTS;
  const { calls, provision } = okProvision();
  try {
    const result = await installFeature(
      { identity: 'main', packageName: '@user/demo-feature', version: '1.0.0' },
      { resolvers: scope.resolvers, catalogRoots, provision },
    );
    assert.equal(result.declared, true);
    const planFeatures = calls[0].plan.features;
    assert.ok(!planFeatures.some((f) => f.runtimeName === 'some-static-plugin'), 'builtin 声明不进仓库装配 plan');
    assert.ok(planFeatures.some((f) => f.runtimeName === 'demo-feature'), '目标仓库包在 plan 内');
    const layer = scope.readLayer();
    assert.equal(layer['some-static-plugin'].$mount.kind, 'builtin', 'builtin 声明原样保留');
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

test('installFeature：层文件与父目录均不存在的全新数据目录首装不 ENOENT', async () => {
  // 打包形态真实场景：全新用户数据目录，feature-config/agent.json 从未被创建。
  // 夹具不预建层文件（makeScope 会预建），regression：writeDeclaration 需自建父目录。
  const root = mkdtempSync(join(tmpdir(), 'install-service-fresh-'));
  const layerPath = join(root, 'workspaces', 'programming-helper', 'feature-config', 'agent.json');
  const resolvers = new Map([
    ['programming-helper', () => ({ layers: [{ id: 'agent', label: 'test', path: layerPath }] })],
  ]);
  const { provision } = okProvision();
  try {
    const result = await installFeature(
      { identity: 'main', packageName: '@user/demo-feature', version: '1.0.0' },
      { resolvers, catalogRoots: CATALOG_ROOTS, provision },
    );
    assert.equal(result.declared, true);
    const written = JSON.parse(readFileSync(layerPath, 'utf8'));
    assert.deepEqual(written['demo-feature'].$mount, { package: '@user/demo-feature', version: '1.0.0' });
  } finally { void provision; }
});

// ── 全局装配（ADR-0046 全局级装配：identity='global'，$mount 写 global 层）──

/** 层清单含 global+agent 两层的隔离 fixture（global 层文件独立）。 */
function makeScopeWithGlobal(globalContent = {}) {
  const root = mkdtempSync(join(tmpdir(), 'install-service-global-'));
  const layerPath = join(root, 'agent-layer.json');
  const globalPath = join(root, 'global-layer.json');
  writeFileSync(layerPath, '{}');
  writeFileSync(globalPath, JSON.stringify(globalContent));
  const resolvers = new Map([
    ['programming-helper', () => ({
      layers: [
        { id: 'global', label: '全局', path: globalPath },
        { id: 'agent', label: 'test', path: layerPath },
      ],
    })],
  ]);
  return {
    root,
    layerPath,
    globalPath,
    resolvers,
    readAgent: () => JSON.parse(readFileSync(layerPath, 'utf8')),
    readGlobal: () => JSON.parse(readFileSync(globalPath, 'utf8')),
    dispose: () => { /* tmp 由 OS 回收 */ },
  };
}

test('全局安装：写 global 层声明、不 provision（环境归属消费身份）、agent 层不动', async () => {
  const scope = makeScopeWithGlobal();
  const { calls, provision } = okProvision();
  try {
    const result = await installFeature(
      { identity: 'global', packageName: '@user/demo-feature', version: '1.0.0' },
      { resolvers: scope.resolvers, catalogRoots: CATALOG_ROOTS, provision },
    );
    assert.equal(result.declared, true);
    assert.equal(result.installed, false, '全局装配不做即时环境制备');
    assert.equal(result.provisionDeferred, true);
    assert.equal(calls.length, 0, 'provision 不执行（各消费身份启动自愈/就绪链制备）');
    assert.deepEqual(
      scope.readGlobal()['demo-feature'],
      { $mount: { package: '@user/demo-feature', version: '1.0.0' } },
    );
    assert.deepEqual(scope.readAgent(), {}, 'agent 层不动（全局声明不落身份层）');
  } finally { scope.dispose(); }
});

test('全局安装：已声明同版本幂等，配置值保留', async () => {
  const scope = makeScopeWithGlobal({
    'demo-feature': { $mount: { package: '@user/demo-feature', version: '1.0.0' }, vaultPath: '/v' },
  });
  const { provision } = okProvision();
  try {
    const result = await installFeature(
      { identity: 'global', packageName: '@user/demo-feature', version: '1.0.0' },
      { resolvers: scope.resolvers, catalogRoots: CATALOG_ROOTS, provision },
    );
    assert.equal(result.declared, false);
    assert.equal(scope.readGlobal()['demo-feature'].vaultPath, '/v', '既有配置值保留');
  } finally { scope.dispose(); }
});

test('全局安装：仓库无此包 → 失败且 global 层保持原样（原子性）', async () => {
  const scope = makeScopeWithGlobal({ existing: 'untouched' });
  const { provision } = okProvision();
  try {
    await assert.rejects(
      installFeature({ identity: 'global', packageName: '@user/ghost', version: '2.0.0' },
        { resolvers: scope.resolvers, catalogRoots: CATALOG_ROOTS, provision }),
      (err) => { assert.equal(classifyInstallError(err).code, 'package_missing'); return true; },
    );
    assert.deepEqual(scope.readGlobal(), { existing: 'untouched' });
  } finally { scope.dispose(); }
});

test('身份安装的环境 plan 含 global 层装配（与启动链 hash 同口径）', async () => {
  // 契约依据：user-mount.js——启动链/安装链 plan 严格同构，环境 hash 才一致。
  // global 层声明 X、身份层空，身份安装 Y → provision 收到的 plan 必须同时含 X 与 Y，
  // 否则产出的环境启动链认不出（hash 失配）。
  const scope = makeScopeWithGlobal({
    'demo-feature': { $mount: { package: '@user/demo-feature', version: '1.0.0' } },
  });
  const { calls, provision } = okProvision();
  try {
    const result = await installFeature(
      { identity: 'main', packageName: '@user/other-feature', version: '2.0.0' },
      { resolvers: scope.resolvers, catalogRoots: CATALOG_ROOTS, provision },
    );
    assert.equal(result.declared, true);
    const packages = calls[0].plan.features.map((f) => f.package);
    assert.ok(packages.includes('@user/demo-feature'), 'global 层装配进身份环境 plan');
    assert.ok(packages.includes('@user/other-feature'), '新装包进 plan');
    assert.equal(calls[0].plan.agent.id, 'programming-helper:user-mounts');
    // 声明只写身份层（Y）；global 层声明不被身份安装触碰
    assert.deepEqual(
      scope.readAgent()['other-feature'],
      { $mount: { package: '@user/other-feature', version: '2.0.0' } },
    );
    assert.ok(!scope.readGlobal()['other-feature'], '身份安装不写 global 层');
  } finally { scope.dispose(); }
});

test('global 已声明同版本时身份再装：不写冗余声明（合并层已生效），plan 单包', async () => {
  const scope = makeScopeWithGlobal({
    'demo-feature': { $mount: { package: '@user/demo-feature', version: '1.0.0' } },
  });
  const { calls, provision } = okProvision({ installed: false });
  try {
    const result = await installFeature(
      { identity: 'main', packageName: '@user/demo-feature', version: '1.0.0' },
      { resolvers: scope.resolvers, catalogRoots: CATALOG_ROOTS, provision },
    );
    assert.equal(result.declared, false, '合并层已含同版本声明，幂等');
    assert.deepEqual(scope.readAgent(), {}, '身份层不写冗余声明');
    assert.equal(calls[0].plan.features.length, 1, '同 key 层序合并不重复进 plan');
  } finally { scope.dispose(); }
});

test('全局重建：遍历已注册身份，按合并口径重建（global 声明 + 空 agent 层可重建）', async () => {
  const scope = makeScopeWithGlobal({
    'demo-feature': { $mount: { package: '@user/demo-feature', version: '1.0.0' } },
  });
  const { calls, provision } = okProvision();
  try {
    const result = await rebuildEnvironment(
      { identity: 'global' },
      { resolvers: scope.resolvers, catalogRoots: CATALOG_ROOTS, provision },
    );
    assert.equal(result.rebuilt.length, 1, '注入隔离内只有 main 一个身份');
    assert.equal(result.rebuilt[0].identity, 'main');
    assert.equal(calls[0].plan.agent.id, 'programming-helper:user-mounts');
    assert.deepEqual(
      calls[0].plan.features.map((f) => f.package),
      ['@user/demo-feature'],
      'global 声明进身份重建的 plan（旧单层口径会 nothing_to_rebuild）',
    );
    // 声明不被 rebuild 触碰
    assert.deepEqual(
      scope.readGlobal()['demo-feature'],
      { $mount: { package: '@user/demo-feature', version: '1.0.0' } },
    );
  } finally { scope.dispose(); }
});

test('全局就绪探测：聚合各身份（global 声明 → 身份 hasEnv，无环境 lock → not ready）', async () => {
  const scope = makeScopeWithGlobal({
    'demo-feature': { $mount: { package: '@user/demo-feature', version: '1.0.0' } },
  });
  try {
    assert.deepEqual(
      await computeScopeEnvReadiness('global',
        { resolvers: scope.resolvers, catalogRoots: CATALOG_ROOTS, environmentRoot: join(scope.root, 'envs') }),
      { ready: false, hasEnv: true },
    );
  } finally { scope.dispose(); }
});

test('未知身份拒绝：既非 global 也未注册 → 明确报错', async () => {
  const scope = makeScopeWithGlobal();
  const { provision } = okProvision();
  try {
    await assert.rejects(
      installFeature({ identity: 'nope', packageName: '@user/demo-feature', version: '1.0.0' },
        { resolvers: scope.resolvers, catalogRoots: CATALOG_ROOTS, provision }),
      /未知身份/,
    );
  } finally { scope.dispose(); }
});
