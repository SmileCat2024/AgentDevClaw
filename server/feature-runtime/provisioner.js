import crypto from 'crypto';
import path from 'path';
import process from 'process';
import { existsSync, promises as fs } from 'fs';

import { AGENTDEV_ROOT, AGENT_RUNTIME_ENVS_ROOT } from '../shared/constants.js';

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
  const environmentDir = getRuntimeEnvironmentRoot(plan.agent.id, dependencyHash, root);
  const packageJsonPath = path.join(environmentDir, 'package.json');
  const lockPath = path.join(environmentDir, 'runtime-lock.json');
  const dependencies = {
    // 拆分后（ADR-0003 / 票 011/012）框架以 @agentdev/core|llm|viewer|mcp 四包提供，
    // 尚未发布 npm，宿主 env 以本地源码目录满足生态包 peer，保证 core 单例。
    '@agentdev/core': toFileDependencySpec(path.join(AGENTDEV_ROOT, 'packages', 'core')),
    '@agentdev/llm': toFileDependencySpec(path.join(AGENTDEV_ROOT, 'packages', 'llm')),
    '@agentdev/viewer': toFileDependencySpec(path.join(AGENTDEV_ROOT, 'packages', 'viewer')),
    ...(plan.features.some((f) => f.package === '@agentdev/websearch-feature')
      ? { '@agentdev/mcp': toFileDependencySpec(path.join(AGENTDEV_ROOT, 'packages', 'mcp')) }
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
