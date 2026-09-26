/**
 * install-service.js — Feature 安装服务（安装前移的执行链）
 *
 * 「安装」与「激活」分离：安装（provision 环境，可能联网）发生在用户点击
 * 商店按钮的此刻并即时反馈成败；激活（挂载）仍在 agent 启动时（快路径）。
 * 启动链的幂等自愈兜底保留（环境被删/框架升级后，启动期 provision 重建）。
 *
 * plan 构造经 buildUserMountPlan 与启动链严格同构：安装产出的环境就是下次
 * 启动直接命中的环境（同 agent.id、同依赖集 → 同 hash），不会装两遍。
 *
 * 单飞纪律：同一时刻只允许一个 install/rebuild 在跑（provision 内部无锁，
 * 并发对同一环境目录操作会互相破坏）；冲突返回进行中任务的信息由调用方
 * 决定呈现。overview 经 getInstallState 暴露进行中状态。
 */

import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';

import { buildScopeLayers, validateLayerContent, resolveWriteTarget } from '../routes/feature-config.js';
import { extractFeatureMounts } from '../shared/feature-mount.js';
import { buildUserMountPlan } from './user-mount.js';
import { computeRuntimeDependencyHash, getRuntimeEnvironmentRoot, provisionRuntimeEnvironment } from './provisioner.js';

export const IDENTITY_SCOPES = {
  main: { agentId: 'programming-helper', layerId: 'agent', sessionType: 'main' },
  coder: { agentId: 'coder', layerId: 'coder', sessionType: 'coder' },
};

/** $mount 声明键 = 包 basename（与前端商店 _fsRuntimeKey 同规则） */
function mountKeyFor(packageName) {
  return packageName.replace(/^@[^/]+\//, '');
}

/** 读身份配置层：返回 sparse 与其中全部 $mount 声明（含 builtin）。resolvers 为测试隔离注入口。 */
function readDeclaredMounts(scope, resolvers) {
  const { layers } = buildScopeLayers({ agentId: scope.agentId }, resolvers);
  const layer = (layers || []).find((entry) => entry.id === scope.layerId);
  const sparse = (layer && typeof layer.sparse === 'object' && layer.sparse !== null) ? layer.sparse : {};
  const { mounts } = extractFeatureMounts([{ id: scope.layerId, config: sparse }]);
  return { sparse, mounts };
}

// ── 错误分类（前端按 code 呈现不同文案）─────────────────────────────

export function classifyInstallError(error) {
  const message = String(error?.message || error);
  if (error?.installErrorCode) return { code: error.installErrorCode, message };
  if (/仓库中不存在包|仓库中不存在 .*@|必须为 .* 指定精确版本/.test(message)) {
    return { code: 'package_missing', message };
  }
  if (error?.code === 'ENOENT' && /npm/i.test(message)) {
    return { code: 'npm_unavailable', message };
  }
  if (/(ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|network|INTERNET)/i.test(message)) {
    return { code: 'network', message };
  }
  return { code: 'install_failed', message };
}

// ── 单飞队列 ────────────────────────────────────────────────────────

let installing = null; // { identity, packageName, version, kind, startedAt }

export function getInstallState() {
  return installing ? { ...installing } : null;
}

function acquireInstallSlot(meta) {
  if (installing) {
    const error = new Error(`另一安装正在进行中（${installing.packageName}@${installing.version}）`);
    error.installErrorCode = 'install_busy';
    throw error;
  }
  installing = meta;
}

// ── 声明写回（与 PUT /protoclaw/feature_config/layer 同一权威链）────

function writeDeclaration(scope, sparse, key, packageName, version, resolvers) {
  sparse[key] = {
    ...(sparse[key] && typeof sparse[key] === 'object' ? sparse[key] : {}),
    $mount: { package: packageName, version },
  };
  const validationError = validateLayerContent(sparse, { layerId: scope.layerId });
  if (validationError) {
    throw new Error(`安装产物声明校验失败：${validationError}`);
  }
  const targetPath = resolveWriteTarget({ agentId: scope.agentId, layerId: scope.layerId }, resolvers);
  if (!targetPath) throw new Error(`未知配置层：${scope.agentId}/${scope.layerId}`);
  writeFileSync(targetPath, JSON.stringify(sparse, null, 2) + '\n', 'utf8');
}

// ── 对外动作 ────────────────────────────────────────────────────────

/**
 * 安装一个 repository 包到身份：现有声明组合 + 新包 → 组合 provision →
 * 成功才写 $mount 声明（失败不落盘）。声明已存在同版本时幂等（只 provision，
 * 用于「点重装/环境修复」语义）。
 * 第二参数为测试隔离注入口（catalogRoots/environmentRoot/resolvers 透传各
 * 权威函数；provision 替换执行链，单测不跑真 npm）。生产调用不传。
 * @returns {{ installed: boolean, dependencyHash: string, durationMs: number, declared: boolean }}
 */
export async function installFeature({ identity, packageName, version }, {
  catalogRoots,
  environmentRoot,
  provision = provisionRuntimeEnvironment,
  resolvers,
} = {}) {
  const scope = IDENTITY_SCOPES[identity];
  if (!scope) throw new Error(`未知身份：${identity}`);
  if (!packageName || !version) throw new Error('packageName 与 version 必填');

  acquireInstallSlot({ identity, packageName, version, kind: 'install', startedAt: Date.now() });
  try {
    const { sparse, mounts } = readDeclaredMounts(scope, resolvers);
    const key = mountKeyFor(packageName);
    const existing = mounts.get(key);
    const alreadyDeclared = existing?.package === packageName && existing?.version === version;

    const target = new Map(mounts);
    target.set(key, { package: packageName, version });

    const started = Date.now();
    const { plan } = await buildUserMountPlan({ mounts: target, agentId: scope.agentId, sessionType: scope.sessionType, catalogRoots });
    const environment = await provision({ plan, root: environmentRoot });

    if (!alreadyDeclared) {
      writeDeclaration(scope, sparse, key, packageName, version, resolvers);
    }
    return {
      installed: environment.installed,
      dependencyHash: environment.dependencyHash,
      durationMs: Date.now() - started,
      declared: !alreadyDeclared,
    };
  } finally {
    installing = null;
  }
}

/**
 * 重建身份现有声明组合的环境（不动声明）：环境缺失/损坏时的显式修复入口。
 * 空声明（无可重建）抛错。
 */
export async function rebuildEnvironment({ identity }, {
  catalogRoots,
  environmentRoot,
  provision = provisionRuntimeEnvironment,
  resolvers,
} = {}) {
  const scope = IDENTITY_SCOPES[identity];
  if (!scope) throw new Error(`未知身份：${identity}`);

  acquireInstallSlot({ identity, packageName: '(rebuild)', version: '', kind: 'rebuild', startedAt: Date.now() });
  try {
    const { mounts } = readDeclaredMounts(scope, resolvers);
    const repository = new Map([...mounts].filter(([, mount]) => mount.kind !== 'builtin'));
    if (repository.size === 0) {
      const error = new Error('该身份没有仓库装配声明，无需重建');
      error.installErrorCode = 'nothing_to_rebuild';
      throw error;
    }
    const started = Date.now();
    const { plan } = await buildUserMountPlan({ mounts: repository, agentId: scope.agentId, sessionType: scope.sessionType, catalogRoots });
    const environment = await provision({ plan, root: environmentRoot });
    return {
      installed: environment.installed,
      dependencyHash: environment.dependencyHash,
      durationMs: Date.now() - started,
    };
  } finally {
    installing = null;
  }
}

/**
 * 身份级环境就绪探测（overview 消费）：组合 hash 对应环境目录的 lock 是否存在。
 * 空声明组合恒 ready（无环境需求）。
 * @returns {Promise<{ ready: boolean, hasEnv: boolean }>}
 */
export async function computeScopeEnvReadiness(identity, { catalogRoots, resolvers, environmentRoot } = {}) {
  const scope = IDENTITY_SCOPES[identity];
  if (!scope) throw new Error(`未知身份：${identity}`);
  const { mounts } = readDeclaredMounts(scope, resolvers);
  const repository = new Map([...mounts].filter(([, mount]) => mount.kind !== 'builtin'));
  if (repository.size === 0) return { ready: true, hasEnv: false };
  const { plan } = await buildUserMountPlan({ mounts: repository, agentId: scope.agentId, sessionType: scope.sessionType, catalogRoots });
  const hash = computeRuntimeDependencyHash(plan);
  const envDir = getRuntimeEnvironmentRoot(plan.agent.id, hash, environmentRoot);
  return { ready: existsSync(join(envDir, 'runtime-lock.json')), hasEnv: true };
}
