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

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { join } from 'path';

import { buildScopeLayers, validateLayerContent, resolveWriteTarget } from '../routes/feature-config.js';
import { extractFeatureMounts } from '../shared/feature-mount.js';
import { GLOBAL_LAYER_PATH } from '../shared/feature-config-layers.js';
import { buildUserMountPlan } from './user-mount.js';
import { computeRuntimeDependencyHash, getRuntimeEnvironmentRoot, provisionRuntimeEnvironment } from './provisioner.js';

/** 全局装配身份键（ADR-0046 全局级装配）：$mount 写 global 层，处处生效。 */
export const GLOBAL_IDENTITY = 'global';

/**
 * 装配身份注册表（替换式）：identity 键 → 配置层寻址 {agentId, layerId}。
 *
 * 声明驱动派生（ADR-0045：公共代码不按 APP ID 硬编码）：APP 在 metadata.json
 * 声明 `featureMounts: true`（runtime 消费 $mount 装配），宿主启动发现后经
 * registerIdentityScopes 注册；identity 主键用 agentId，历史键 main 是
 * programming-helper 的兼容别名（前端商店 API 已用）。测试可直接注册构造
 * 场景。消费方经 Object.entries(IDENTITY_SCOPES) 读当前注册集。
 */
export const IDENTITY_SCOPES = {
  main: { agentId: 'programming-helper', layerId: 'agent' },
  coder: { agentId: 'coder', layerId: 'agent' },
};

export function registerIdentityScopes(entries) {
  for (const key of Object.keys(IDENTITY_SCOPES)) delete IDENTITY_SCOPES[key];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    const identity = String(entry.identity || '').trim();
    const agentId = String(entry.agentId || '').trim();
    if (!identity || !agentId) continue;
    IDENTITY_SCOPES[identity] = { agentId, layerId: String(entry.layerId || 'agent').trim() };
  }
}

/** $mount 声明键 = 包 basename（与前端商店 _fsRuntimeKey 同规则） */
function mountKeyFor(packageName) {
  return packageName.replace(/^@[^/]+\//, '');
}

/**
 * 读身份配置层：返回 sparse 与其中全部 $mount 声明（含 builtin）。resolvers 为测试隔离注入口。
 * 导出供 plugin-ui（声明合成）与 plugin-routes（server 面挂载）复用装配事实，
 * 避免各写一份层读取逻辑漂移。
 */
export function readDeclaredMounts(scope, resolvers) {
  const { layers } = buildScopeLayers({ agentId: scope.agentId }, resolvers);
  const layer = (layers || []).find((entry) => entry.id === scope.layerId);
  const sparse = (layer && typeof layer.sparse === 'object' && layer.sparse !== null) ? layer.sparse : {};
  const { mounts } = extractFeatureMounts([{ id: scope.layerId, config: sparse }]);
  return { sparse, mounts };
}

/**
 * 读全局层 $mount 声明（ADR-0046 全局级装配）。global 层是所有 scope 层清单
 * 的公共首层（PH/coder 两条 resolver 均以 global 层开头），取任一已注册身份
 * 的层清单解析——resolvers 测试隔离注入随之路径生效；清单缺 global 层（测试
 * 隔离表可只含 agent 层）视为空声明。启动链（agent.js 装配期）同样合并
 * global+agent 两层的 $mount，本函数让 UI 面/数据面的装配事实与之同口径。
 */
export function readGlobalDeclaredMounts(resolvers) {
  const anyScope = Object.values(IDENTITY_SCOPES)[0];
  if (!anyScope) return { sparse: {}, mounts: new Map() };
  try {
    const { layers } = buildScopeLayers({ agentId: anyScope.agentId }, resolvers);
    const layer = (layers || []).find((entry) => entry.id === 'global');
    const sparse = (layer && typeof layer.sparse === 'object' && layer.sparse !== null) ? layer.sparse : {};
    const { mounts } = extractFeatureMounts([{ id: 'global', config: sparse }]);
    return { sparse, mounts };
  } catch (err) {
    // 层清单解析失败（层文件损坏等）按空声明降级，与 readDeclaredMounts 的
    // 调用方容错语义一致（单层失败不拖垮其他层）。
    console.warn('[install-service] 读取全局层装配声明失败（按空处理）：', err?.message || err);
    return { sparse: {}, mounts: new Map() };
  }
}

// ── 身份解析与有效装配（与启动链同口径）──────────────────────────────

/**
 * 身份解析：'global' → 全局虚拟 scope（写入层是 global 层）；其余查注册表。
 * @returns {{ identity, agentId: string|null, layerId: string, isGlobal: boolean }}
 */
function resolveScopeFor(identity) {
  if (identity === GLOBAL_IDENTITY) {
    return { identity, agentId: null, layerId: 'global', isGlobal: true };
  }
  const scope = IDENTITY_SCOPES[identity];
  if (!scope) throw new Error(`未知身份：${identity}`);
  return { identity, ...scope, isGlobal: false };
}

/**
 * 读身份的有效装配 = global 层 + 身份层按层序合并（后层覆盖、null 卸载），
 * 与启动链 agent 构造期 [global, agent] 层序完全同权威（extractFeatureMounts
 * 是唯一合并实现）。install/rebuild/readiness 的 plan 输入必须是这个口径——
 * 启动链的环境 hash 按合并依赖集计算，单层口径会让 install/rebuild 产出
 * 启动链认不出的环境（hash 失配，装两遍）。
 * @returns {{ mounts: Map, targetSparse: object }} targetSparse 是写入目标层的 sparse
 *   （global 身份 → global 层；空间身份 → 该身份 agent 层）
 */
function readEffectiveMounts(scope, resolvers) {
  const globalPart = readGlobalDeclaredMounts(resolvers);
  if (scope.isGlobal) {
    return { mounts: globalPart.mounts, targetSparse: globalPart.sparse };
  }
  const identityPart = readDeclaredMounts(scope, resolvers);
  const { mounts } = extractFeatureMounts([
    { id: 'global', config: globalPart.sparse },
    { id: scope.layerId, config: identityPart.sparse },
  ]);
  return { mounts, targetSparse: identityPart.sparse };
}

/** global 层写入路径：任一已注册身份层清单声明的 global 层（测试隔离注入随之路径
 *  生效），无声明时回落生产固定路径。与 readGlobalDeclaredMounts 的层解析同源。 */
function resolveGlobalLayerPath(resolvers) {
  const anyScope = Object.values(IDENTITY_SCOPES)[0];
  if (anyScope) {
    try {
      const { layers } = buildScopeLayers({ agentId: anyScope.agentId }, resolvers);
      const declared = (layers || []).find((entry) => entry.id === 'global');
      if (declared?.path) return declared.path;
    } catch { /* 层清单不可解析时回落固定路径 */ }
  }
  return GLOBAL_LAYER_PATH;
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
  // global 身份写入层是 global 层（层清单优先，注入隔离随之路径生效）
  const targetPath = scope.isGlobal
    ? resolveGlobalLayerPath(resolvers)
    : resolveWriteTarget({ agentId: scope.agentId, layerId: scope.layerId }, resolvers);
  if (!targetPath) throw new Error(`未知配置层：${scope.agentId || 'global'}/${scope.layerId}`);
  // 全新数据目录下层文件的父目录尚不存在（PUT /protoclaw/feature_config/layer
  // 的写入链同样先建目录）；绕过路由直写时这里必须自建，否则首装 ENOENT
  if (!existsSync(dirname(targetPath))) mkdirSync(dirname(targetPath), { recursive: true });
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
  const scope = resolveScopeFor(identity);
  if (!packageName || !version) throw new Error('packageName 与 version 必填');

  acquireInstallSlot({ identity, packageName, version, kind: 'install', startedAt: Date.now() });
  try {
    // 有效装配 = global 层 + 身份层合并（与启动链同口径，见 readEffectiveMounts）
    const { mounts: effectiveMounts, targetSparse } = readEffectiveMounts(scope, resolvers);
    const key = mountKeyFor(packageName);
    const existing = effectiveMounts.get(key);
    const alreadyDeclared = existing?.package === packageName && existing?.version === version;

    // builtin 挂载是静态装配开关，不参与仓库装配 plan（与 rebuild/readiness 同口径）；
    // 不过滤会让 plan 解析器拿到无 package 字段的条目，报"包不存在：undefined"
    const target = new Map([...effectiveMounts].filter(([, mount]) => mount.kind !== 'builtin'));
    target.set(key, { package: packageName, version });

    const started = Date.now();
    const { plan } = await buildUserMountPlan({
      mounts: target,
      // plan.agent.id 决定环境归属：空间身份是环境主人；global 装配不 provision，
      // agent.id 仅占位（校验用），环境由各消费身份启动链/就绪链制备
      agentId: scope.isGlobal ? GLOBAL_IDENTITY : scope.agentId,
      catalogRoots,
    });

    if (scope.isGlobal) {
      // 全局装配不做即时 provision：环境按消费身份分区（plan.agent.id per-identity），
      // 此刻 provision 会建出一个没有任何启动链消费的孤儿环境。plan 校验（包坐标
      // 可解析）已过，声明写入；各身份环境在启动自愈 / rebuild / readiness 就绪链制备。
      if (!alreadyDeclared) {
        writeDeclaration(scope, targetSparse, key, packageName, version, resolvers);
      }
      return {
        installed: false,
        provisionDeferred: true,
        dependencyHash: null,
        durationMs: Date.now() - started,
        declared: !alreadyDeclared,
      };
    }

    const environment = await provision({ plan, root: environmentRoot });

    if (!alreadyDeclared) {
      writeDeclaration(scope, targetSparse, key, packageName, version, resolvers);
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
 * identity='global' 时遍历全部已注册身份逐一重建（环境按消费身份分区，全局
 * 装配没有自己的环境；无 resolver 的身份在测试隔离注入下跳过）。
 */
export async function rebuildEnvironment({ identity }, {
  catalogRoots,
  environmentRoot,
  provision = provisionRuntimeEnvironment,
  resolvers,
} = {}) {
  const scope = resolveScopeFor(identity);
  if (scope.isGlobal) {
    return rebuildAllIdentities({ catalogRoots, environmentRoot, provision, resolvers });
  }

  acquireInstallSlot({ identity, packageName: '(rebuild)', version: '', kind: 'rebuild', startedAt: Date.now() });
  try {
    const { mounts: effectiveMounts } = readEffectiveMounts(scope, resolvers);
    const repository = new Map([...effectiveMounts].filter(([, mount]) => mount.kind !== 'builtin'));
    if (repository.size === 0) {
      const error = new Error('该身份没有仓库装配声明，无需重建');
      error.installErrorCode = 'nothing_to_rebuild';
      throw error;
    }
    const started = Date.now();
    const { plan } = await buildUserMountPlan({ mounts: repository, agentId: scope.agentId, catalogRoots });
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

/** rebuildAllIdentities 不单飞占槽（内层逐身份 rebuild 各自占槽）。 */
async function rebuildAllIdentities({ catalogRoots, environmentRoot, provision, resolvers }) {
  const started = Date.now();
  const rebuilt = [];
  let rebuiltAny = false;
  for (const [identity, scope] of Object.entries(IDENTITY_SCOPES)) {
    if (resolvers && !resolvers.has(scope.agentId)) continue; // 注入隔离外的身份跳过
    try {
      const result = await rebuildEnvironment({ identity }, { catalogRoots, environmentRoot, provision, resolvers });
      rebuilt.push({ identity, ...result });
      rebuiltAny = true;
    } catch (err) {
      if (err?.installErrorCode !== 'nothing_to_rebuild') throw err;
    }
  }
  if (!rebuiltAny) {
    const error = new Error('全部身份都没有仓库装配声明，无需重建');
    error.installErrorCode = 'nothing_to_rebuild';
    throw error;
  }
  return { rebuilt, installed: true, durationMs: Date.now() - started };
}

/**
 * 身份级环境就绪探测（overview 消费）：组合 hash 对应环境目录的 lock 是否存在。
 * 空声明组合恒 ready（无环境需求）。identity='global' 聚合全部已注册身份
 * （任一未就绪 → not ready；注入隔离外的身份跳过）。
 * @returns {Promise<{ ready: boolean, hasEnv: boolean }>}
 */
export async function computeScopeEnvReadiness(identity, { catalogRoots, resolvers, environmentRoot } = {}) {
  const scope = resolveScopeFor(identity);
  if (scope.isGlobal) {
    let ready = true;
    let hasEnv = false;
    for (const [scopeIdentity, entry] of Object.entries(IDENTITY_SCOPES)) {
      if (resolvers && !resolvers.has(entry.agentId)) continue;
      const result = await computeScopeEnvReadiness(scopeIdentity, { catalogRoots, resolvers, environmentRoot });
      ready = ready && result.ready;
      hasEnv = hasEnv || result.hasEnv;
    }
    return { ready, hasEnv };
  }
  const { mounts: effectiveMounts } = readEffectiveMounts(scope, resolvers);
  const repository = new Map([...effectiveMounts].filter(([, mount]) => mount.kind !== 'builtin'));
  if (repository.size === 0) return { ready: true, hasEnv: false };
  const { plan } = await buildUserMountPlan({ mounts: repository, agentId: scope.agentId, catalogRoots });
  const hash = computeRuntimeDependencyHash(plan);
  const envDir = getRuntimeEnvironmentRoot(plan.agent.id, hash, environmentRoot);
  return { ready: existsSync(join(envDir, 'runtime-lock.json')), hasEnv: true };
}
