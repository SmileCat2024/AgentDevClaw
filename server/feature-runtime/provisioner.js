import crypto from 'crypto';
import path from 'path';
import process from 'process';
import { existsSync, promises as fs, readFileSync } from 'fs';

import { AGENTDEV_ROOT, PROJECT_ROOT, AGENT_RUNTIME_ENVS_ROOT } from '../shared/constants.js';
import { isExactSemver } from './schemas.js';

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function npmInstallSpawnSpec() {
  const args = ['install', '--no-fund', '--no-audit', '--ignore-scripts'];
  if (process.platform !== 'win32') return { command: npmCommand(), args };
  // npm.cmd cannot be directly spawned with shell:false on this Windows Node
  // runtime. The command line is fixed (no caller-provided tokens), so cmd is
  // only a compatibility launcher, not a user-controlled shell surface.
  return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', ['npm.cmd', ...args].join(' ')] };
}

function toFileDependencySpec(targetPath) {
  return `file:${path.resolve(targetPath).replace(/\\/g, '/')}`;
}

/**
 * 框架包（@agentdevjs/core|llm|viewer|mcp）依赖来源：
 * - 开发态（相邻框架仓库存在）：以本地源码目录满足生态包 peer，改动即生效；
 * - 发布态：相邻仓库不存在，file: 会指向失效路径，改从宿主根声明读取
 *   确切版本走 registry。锁步包 exact pin 保证任一时刻只有一个版本语义。
 */
function frameworkDependencySpecs() {
  const localCorePkg = path.join(AGENTDEV_ROOT, 'packages', 'core', 'package.json');
  if (existsSync(localCorePkg)) {
    return {
      '@agentdevjs/core': toFileDependencySpec(path.join(AGENTDEV_ROOT, 'packages', 'core')),
      '@agentdevjs/llm': toFileDependencySpec(path.join(AGENTDEV_ROOT, 'packages', 'llm')),
      '@agentdevjs/viewer': toFileDependencySpec(path.join(AGENTDEV_ROOT, 'packages', 'viewer')),
      '@agentdevjs/mcp': toFileDependencySpec(path.join(AGENTDEV_ROOT, 'packages', 'mcp')),
    };
  }
  const rootPkg = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const spec = (name) => {
    const declared = rootPkg.dependencies?.[name];
    if (typeof declared !== 'string' || !isExactSemver(declared)) {
      throw new Error(
        `发布态运行环境无法解析 ${name}：宿主根声明缺失或不是精确版本` +
          `（当前值：${declared ?? '(缺声明)'}）。请先执行 npm run agentdev:published 切换到发布态。`
      );
    }
    return declared;
  };
  return {
    '@agentdevjs/core': spec('@agentdevjs/core'),
    '@agentdevjs/llm': spec('@agentdevjs/llm'),
    '@agentdevjs/viewer': spec('@agentdevjs/viewer'),
    '@agentdevjs/mcp': spec('@agentdevjs/mcp'),
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function dependencyEntries(plan) {
  return (plan.features || [])
    .filter((feature) => feature.resolvedFrom === 'repository')
    .map((feature) => ({
      package: feature.package,
      version: feature.version,
      archivePath: path.resolve(feature.archivePath),
      archiveDigest: feature.archiveDigest,
    }))
    .sort((left, right) => left.package.localeCompare(right.package));
}

export function computeRuntimeDependencyHash(plan) {
  const payload = {
    agentdevRoot: path.resolve(AGENTDEV_ROOT),
    // 框架依赖来源参与 hash：发布态下框架版本升级会改变该字段，触发环境重建，
    // 避免「升级了框架但旧环境继续跑旧快照」；开发态下 file: 路径固定，hash 稳定。
    frameworkSpecs: frameworkDependencySpecs(),
    dependencies: dependencyEntries(plan),
  };
  return crypto.createHash('sha256').update(stableJson(payload)).digest('hex').slice(0, 24);
}

export function getRuntimeEnvironmentRoot(agentId, dependencyHash, root = AGENT_RUNTIME_ENVS_ROOT) {
  const safeId = String(agentId || 'agent').trim().replace(/[^a-zA-Z0-9_-]+/g, '-') || 'agent';
  return path.join(root, safeId, dependencyHash);
}

async function runNpmInstall(cwd) {
  const { spawn } = await import('child_process');
  await new Promise((resolve, reject) => {
    const spec = npmInstallSpawnSpec();
    const child = spawn(spec.command, spec.args, {
      cwd,
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || stdout.trim() || `npm install exited with code ${code}`));
    });
  });
}

/**
 * Prepare a content-addressed node_modules environment for repository Features.
 * Development source overrides are deliberately not copied or installed: they are
 * loaded from their source project so Studio retains reload semantics.
 */
async function provisionAgentSource(plan, environmentDir) {
  const agentRoot = path.resolve(plan.agent.root || path.dirname(plan.agent.entry));
  const relativeEntry = path.relative(agentRoot, plan.agent.entry);
  if (relativeEntry.startsWith('..') || path.isAbsolute(relativeEntry)) {
    throw new Error(`Agent entry 必须位于 Agent 项目目录内：${plan.agent.entry}`);
  }
  const targetRoot = path.join(environmentDir, 'agent-source');
  await fs.rm(targetRoot, { recursive: true, force: true });
  await fs.cp(agentRoot, targetRoot, {
    recursive: true,
    filter: (source) => {
      const name = path.basename(source);
      return name !== 'node_modules' && name !== '.agent-studio' && name !== '.git';
    },
  });
  return { entry: path.join(targetRoot, relativeEntry), copied: true };
}

export async function provisionRuntimeEnvironment({ plan, root } = {}) {
  if (!plan?.agent?.id) throw new Error('Runtime plan 缺少 agent.id。');
  const dependencyHash = computeRuntimeDependencyHash(plan);
  const frameworkSpecs = frameworkDependencySpecs();
  const environmentDir = getRuntimeEnvironmentRoot(plan.agent.id, dependencyHash, root);
  const packageJsonPath = path.join(environmentDir, 'package.json');
  const lockPath = path.join(environmentDir, 'runtime-lock.json');
  const dependencies = {
    // 框架四包来源见 frameworkDependencySpecs()：开发态 file: 本地源码，
    // 发布态从宿主根声明确切版本解析，保证 core 单例语义。
    '@agentdevjs/core': frameworkSpecs['@agentdevjs/core'],
    '@agentdevjs/llm': frameworkSpecs['@agentdevjs/llm'],
    '@agentdevjs/viewer': frameworkSpecs['@agentdevjs/viewer'],
    ...(plan.features.some((f) => f.package === '@agentdevjs/websearch-feature')
      ? { '@agentdevjs/mcp': frameworkSpecs['@agentdevjs/mcp'] }
      : {}),
    ...Object.fromEntries(dependencyEntries(plan).map((entry) => [entry.package, toFileDependencySpec(entry.archivePath)])),
  };
  const lock = {
    schemaVersion: 1,
    dependencyHash,
    agentId: plan.agent.id,
    dependencies: dependencyEntries(plan),
  };

  const existingLock = await fs.readFile(lockPath, 'utf8').then(JSON.parse).catch(() => null);
  if (existingLock?.dependencyHash === dependencyHash && existsSync(path.join(environmentDir, 'node_modules'))) {
    const agentSource = await provisionAgentSource(plan, environmentDir);
    return { environmentDir, dependencyHash, installed: false, dependencies: Object.keys(dependencies), agentEntry: agentSource.entry, agentCopied: agentSource.copied };
  }

  await fs.mkdir(environmentDir, { recursive: true });
  await fs.writeFile(packageJsonPath, `${JSON.stringify({
    name: `agentdev-runtime-${plan.agent.id}`.replace(/[^a-zA-Z0-9-]/g, '-'),
    private: true,
    type: 'module',
    version: '0.0.0',
    dependencies,
  }, null, 2)}\n`, 'utf8');

  // An incomplete environment must never be reused. It is safe to remove only
  // this content-addressed directory, which no different dependency plan owns.
  await fs.rm(path.join(environmentDir, 'node_modules'), { recursive: true, force: true });
  await fs.rm(path.join(environmentDir, 'package-lock.json'), { force: true });
  await fs.rm(lockPath, { force: true });
  await runNpmInstall(environmentDir);
  await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  const agentSource = await provisionAgentSource(plan, environmentDir);
  return { environmentDir, dependencyHash, installed: true, dependencies: Object.keys(dependencies), agentEntry: agentSource.entry, agentCopied: agentSource.copied };
}
