import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  isExactSemver,
  normalizeAgentMetadata,
  normalizeFeatureRequirement,
} from '../server/feature-runtime/schemas.js';
import { scanFeatureCatalog, resolveCatalogPackage } from '../server/feature-runtime/catalog.js';
import { resolveAgentRuntimePlan } from '../server/feature-runtime/resolver.js';
import { packageFeatureProject } from '../server/feature-runtime/packager.js';
import { computeRuntimeDependencyHash, getRuntimeEnvironmentRoot, provisionRuntimeEnvironment } from '../server/feature-runtime/provisioner.js';
import { mountResolvedFeatures } from '../server/feature-runtime/loader.js';
import { getRegisteredAgent, listRegisteredAgents, registerAgentProject, unregisterAgentProject } from '../server/feature-runtime/agent-registry.js';
import { PROJECT_ROOT } from '../server/shared/constants.js';
import { spawnSync } from 'child_process';

describe('feature runtime schemas', () => {
  it('requires exact release versions and rejects ranges', () => {
    assert.equal(isExactSemver('1.2.3'), true);
    assert.equal(isExactSemver('1.2.3-dev.4'), true);
    assert.equal(isExactSemver('^1.2.3'), false);
    assert.throws(() => normalizeFeatureRequirement({ package: '@agentdevjs/demo', version: '^1.0.0' }), /精确 semver/);
  });

  it('normalizes standalone Agent metadata and rejects duplicate requirements', () => {
    const metadata = normalizeAgentMetadata({
      id: 'demo-agent',
      entry: './agent.js',
      features: [{ package: '@agentdevjs/demo', version: '1.0.0', config: { enabled: true } }],
    }, { requireFeatureVersions: true });
    assert.equal(metadata.deployment.kind, 'standalone');
    assert.deepEqual(metadata.features[0], { package: '@agentdevjs/demo', version: '1.0.0', config: { enabled: true } });
    assert.throws(() => normalizeAgentMetadata({
      id: 'demo-agent', entry: './agent.js',
      features: [{ package: '@agentdevjs/demo', version: '1.0.0' }, { package: '@agentdevjs/demo', version: '1.0.0' }],
    }), /重复/);
  });
});

describe('feature snapshot packager', () => {
  it('builds a manifest-bearing immutable local snapshot', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'feature-runtime-packager-'));
    const projectDir = path.join(base, 'demo');
    const repositoryDir = path.join(base, 'repository');
    await mkdir(path.join(projectDir, 'dist'), { recursive: true });
    await writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
      name: '@agentdevjs/demo-feature',
      version: '1.0.0',
      type: 'module',
      main: 'dist/index.js',
      files: ['dist', 'README.md'],
      scripts: { build: 'node -e ""' },
    }));
    await writeFile(path.join(projectDir, 'README.md'), '# demo\n');
    await writeFile(path.join(projectDir, 'dist', 'index.js'), 'export class DemoFeature {}\n');
    const first = await packageFeatureProject({ projectDir, repositoryDir });
    assert.equal(first.packageName, '@agentdevjs/demo-feature');
    assert.equal(first.reused, false);
    const second = await packageFeatureProject({ projectDir, repositoryDir });
    assert.equal(second.reused, true);
    await writeFile(path.join(projectDir, 'dist', 'index.js'), 'export class DifferentFeature {}\n');
    await assert.rejects(() => packageFeatureProject({ projectDir, repositoryDir }), /不同内容/);
  });
});

describe('feature runtime provisioner and loader', () => {
  it('derives a stable, archive-sensitive isolated environment path', () => {
    const plan = {
      agent: { id: 'demo-agent' },
      features: [{ package: '@agentdevjs/released', version: '1.0.0', archivePath: '/tmp/released.tgz', archiveDigest: 'sha256:one', resolvedFrom: 'repository' }],
    };
    const first = computeRuntimeDependencyHash(plan);
    assert.equal(first, computeRuntimeDependencyHash({ ...plan, features: [...plan.features] }));
    assert.notEqual(first, computeRuntimeDependencyHash({ ...plan, features: [{ ...plan.features[0], archiveDigest: 'sha256:two' }] }));
    assert.match(getRuntimeEnvironmentRoot('demo agent', first, '/tmp/runtime-envs'), /demo-agent/);
  });

  it('copies an external Agent source into its isolated environment', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'feature-runtime-agent-copy-'));
    const agentRoot = path.join(root, 'agent');
    const environmentRoot = path.join(root, 'runtime-envs');
    await mkdir(agentRoot, { recursive: true });
    await writeFile(path.join(agentRoot, 'agent.js'), 'export default class ExternalAgent {}\\n');
    const result = await provisionRuntimeEnvironment({
      root: environmentRoot,
      plan: { agent: { id: 'external-agent', root: agentRoot, entry: path.join(agentRoot, 'agent.js') }, features: [] },
    });
    assert.equal(result.agentCopied, true);
    assert.notEqual(result.agentEntry, path.join(agentRoot, 'agent.js'));
    assert.match(await readFile(result.agentEntry, 'utf8'), /ExternalAgent/);
  }, { timeout: 120000 });

  it('loads source features, applies config and mounts in static inject order', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'feature-runtime-loader-'));
    const basePath = path.join(root, 'base.mjs');
    const dependentPath = path.join(root, 'dependent.mjs');
    await writeFile(basePath, 'export class BaseFeature { constructor(config) { this.name = "base"; this.config = config; } }');
    await writeFile(dependentPath, 'export class DependentFeature { static inject = ["base"]; constructor(config) { this.name = "dependent"; this.config = config; } }');
    const mounted = [];
    const agent = {
      features: new Map(),
      config: { features: {} },
      async mountFeature(feature) { this.features.set(feature.name, feature); mounted.push(feature); },
    };
    const output = await mountResolvedFeatures(agent, {
      features: [
        { package: '@agentdevjs/dependent', runtimeName: 'dependent', resolvedFrom: 'source', entry: dependentPath, config: { two: 2 } },
        { package: '@agentdevjs/base', runtimeName: 'base', resolvedFrom: 'source', entry: basePath, config: { one: 1 } },
      ],
    });
    assert.deepEqual(mounted.map((item) => item.name), ['base', 'dependent']);
    assert.deepEqual(mounted[1].config, { two: 2 });
    assert.deepEqual(agent.config.features.dependent, { two: 2 });
    assert.deepEqual(output.map((item) => item.name), ['base', 'dependent']);
  });
});

describe('user Agent registry', () => {
  it('registers, lists and removes only standalone Agent projects', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'feature-runtime-registry-'));
    const agentDir = path.join(root, 'agent');
    const registryPath = path.join(root, 'agent-registry.json');
    await mkdir(agentDir);
    await writeFile(path.join(agentDir, 'agent.js'), 'export default class DemoAgent {}\\n');
    await writeFile(path.join(agentDir, 'metadata.json'), JSON.stringify({ id: 'demo-agent', entry: './agent.js', deployment: { kind: 'standalone' }, features: [] }));
    const registered = await registerAgentProject({ projectDir: agentDir, registryPath });
    assert.equal(registered.id, 'demo-agent');
    assert.equal((await listRegisteredAgents({ registryPath })).length, 1);
    assert.equal((await getRegisteredAgent('demo-agent', { registryPath })).projectDir, agentDir);
    // 内建 plain Agent id 守卫：注册 id 不得与仓库 agents/<id>/agent.js 内建目录冲突。
    // 用临时内建目录验证（不依赖任何具体内建 agent 的存在）。
    const builtinDir = path.join(PROJECT_ROOT, 'agents', 'builtin-guard-probe-agent');
    await mkdir(builtinDir, { recursive: true });
    try {
      await writeFile(path.join(builtinDir, 'agent.js'), 'export default class BuiltinProbeAgent {}\n');
      await writeFile(path.join(agentDir, 'metadata.json'), JSON.stringify({ id: 'builtin-guard-probe-agent', entry: './agent.js', deployment: { kind: 'standalone' }, features: [] }));
      await assert.rejects(() => registerAgentProject({ projectDir: agentDir, registryPath }), /内建 plain Agent/);
    } finally {
      await rm(builtinDir, { recursive: true, force: true });
    }
    await writeFile(path.join(agentDir, 'metadata.json'), JSON.stringify({ id: 'demo-agent', entry: './agent.js', deployment: { kind: 'standalone' }, features: [] }));
    assert.equal((await unregisterAgentProject('demo-agent', { registryPath })).id, 'demo-agent');
    assert.equal((await listRegisteredAgents({ registryPath })).length, 0);
  });
});

describe('runtime preparation script', () => {
  it('rejects missing required CLI arguments before resolving a cwd fallback', () => {
    const result = spawnSync(process.execPath, ['scripts/prepare-agent-runtime.js'], { cwd: process.cwd(), encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /用法/);
  });

  it('reports invalid metadata without producing a plan', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'feature-runtime-prepare-'));
    const metadataPath = path.join(base, 'metadata.json');
    const planPath = path.join(base, 'runtime-plan.json');
    await writeFile(metadataPath, JSON.stringify({ id: 'bad', entry: '/absolute.js' }));
    const result = spawnSync(process.execPath, [
      'scripts/prepare-agent-runtime.js', '--agent-root', base, '--metadata', metadataPath, '--output', planPath,
    ], { cwd: process.cwd(), encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /metadata\.entry/);
  });
});

describe('feature runtime catalog and resolver', () => {
  it('prefers a user archive when both sources provide the same version', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'feature-runtime-catalog-'));
    const officialRoot = path.join(base, 'official');
    const userRoot = path.join(base, 'user');
    await Promise.all([mkdir(officialRoot), mkdir(userRoot)]);
    const invalidArchive = path.join(officialRoot, 'invalid.tgz');
    await writeFile(invalidArchive, 'not-a-tar');
    const catalog = await scanFeatureCatalog({ officialRoot, userRoot });
    assert.equal(catalog.invalid.length, 1);
    assert.throws(() => resolveCatalogPackage(catalog, { packageName: '@agentdevjs/demo', version: '1.0.0' }), /不存在/);
  });

  it('builds a mixed debug resolution plan from source overrides and a repository package', () => {
    const catalog = {
      packages: new Map([['@agentdevjs/released', [{
        packageName: '@agentdevjs/released', version: '1.0.0', archivePath: '/tmp/released.tgz', archiveDigest: 'sha256:x', entry: 'dist/index.js', source: 'official',
      }]]]),
    };
    const plan = resolveAgentRuntimePlan({
      agentRoot: '/project',
      metadata: {
        id: 'demo', entry: './agent.js', deployment: { kind: 'standalone' },
        features: [
          { package: '@agentdevjs/developing', version: '1.0.0' },
          { package: '@agentdevjs/released', version: '1.0.0' },
        ],
      },
      catalog,
      mode: 'debug',
      sourceOverrides: [{
        package: '@agentdevjs/developing', runtimeName: 'developing',
        source: { kind: 'project', projectDir: './features/developing', entry: './features/developing/dist/index.js' },
      }],
    });
    assert.equal(plan.features[0].resolvedFrom, 'source');
    assert.equal(plan.features[1].resolvedFrom, 'repository');
    assert.equal(plan.features[1].archivePath, '/tmp/released.tgz');
    assert.throws(() => resolveAgentRuntimePlan({
      agentRoot: '/project',
      metadata: {
        id: 'demo', entry: './agent.js', deployment: { kind: 'standalone' },
        features: [{ package: '@agentdevjs/developing', version: '1.0.0' }],
      },
      catalog,
      mode: 'release',
      sourceOverrides: [{ package: '@agentdevjs/developing', runtimeName: 'developing', source: { kind: 'project', projectDir: '.', entry: 'x.js' } }],
    }), /source override/);
  });
});
