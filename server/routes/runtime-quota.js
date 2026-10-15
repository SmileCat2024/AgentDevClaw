/**
 * Runtime Spawn Quota — per-workspace 存活 runtime 配额（ADR-0027）
 *
 * 计数对象：存活 runtime 子进程数（共享进程模式下多条 runtime 条目共享
 * 同一子进程，按进程去重计数）。键：agentId（workspace）。缺省（无
 * resourcePolicy 配置）不限，热路径零额外行为。
 *
 * 豁免（ADR-0027 §5）：
 * - 存量豁免：配额只约束未来的 spawn，不追溯已存活 runtime——判定只看
 *   "本次 spawn 前的存活数是否已达上限"，不击杀任何已存活进程。
 * - rotation/接续豁免：successor 接替旧 head 的短暂重叠窗口不是扩编，
 *   满配额时拦它会死锁线程精简。豁免依据是调用方声明的意图标记
 *   （spawnIntent: 'rotation'），内核不反推意图。
 *
 * 超限行为：结构化拒绝（LocalOperationError，status 429 + runtimeQuota
 * 负载），经全局错误契约（operation-contract）透传给调度方；收到报文后
 * 怎么应对（归档腾位 / 问用户 / 放弃）是应用层语义，内核不管。
 *
 * 身份升级缝（ADR-0027 §6）：caller 参数位本期恒为 undefined（共享内部
 * 令牌下三面不可分），per-child credential 落地后实填，签名不变。
 */

import { countLiveRuntimeProcesses } from '../shared/agent-access.js';
import { PERMISSION_ITEMS } from '../shared/permission-registry.js';
import { readWorkspaceResourcePolicies } from './workspace-settings.js';
import { LocalOperationError } from '../shared/operation-contract.js';

// 计数原语的家在 agent-access（managedAgents 持有方）；此处 re-export
// 供配额判定与既有测试消费，避免 runtime-quota ↔ workspace-settings
// 循环依赖（GET 路由也要数存活 runtime）。
export { countLiveRuntimeProcesses };

export const RUNTIME_SPAWN_INTENTS = Object.freeze({
  NEW: 'new',
  ROTATION: 'rotation',
});

/** resourcePolicy 条目 → 配额上限（正整数），非法/缺省返回 null（不限）。 */
export function resolveRuntimeQuotaLimit(policy) {
  const limit = policy?.[PERMISSION_ITEMS.maxLiveRuntimes.id];
  return PERMISSION_ITEMS.maxLiveRuntimes.validate(limit) ? limit : null;
}

/** 满配额拒绝错误：结构化负载经 buildLocalFailureResponse 透传（HTTP 429）。 */
export function createRuntimeQuotaExceededError({ agentId, limit, liveRuntimes }) {
  const error = new LocalOperationError(
    `工作空间「${agentId}」的 runtime 配额已满（存活 ${liveRuntimes}/${limit}），拒绝拉起新 runtime。`
    + '可行动：归档已完成线程腾出名额，或请用户在 设置 → 工作空间 调整并发上限，或放弃本次派发。',
    { code: 'runtime_quota_exceeded', status: 429 },
  );
  error.runtimeQuota = Object.freeze({
    agentId,
    limit,
    liveRuntimes,
    actions: ['archive_thread', 'raise_quota', 'abandon'],
  });
  return error;
}

/**
 * 配额判定：满配额抛 createRuntimeQuotaExceededError，否则静默放行。
 * 强制点是 startManagedAgent 唯一漏斗（全部拉起路径收敛于此）。
 *
 * settingsPath 是测试缝（隔离用户数据目录），生产调用不传。
 */
export async function assertRuntimeSpawnAllowed({
  agentId,
  permissions = [],
  intent = RUNTIME_SPAWN_INTENTS.NEW,
  // 身份升级缝（ADR-0027 §6）：本期恒为 undefined（per-child credential
  // 未建，三面不可分），落地后实填、签名不变——预留参数位，非未用变量。
  caller = undefined, // eslint-disable-line no-unused-vars
  settingsPath = undefined,
} = {}) {
  const normalizedAgentId = String(agentId || '').trim();
  if (!normalizedAgentId || !Array.isArray(permissions)
    || !permissions.includes(PERMISSION_ITEMS.maxLiveRuntimes.id)) return;

  const policies = await readWorkspaceResourcePolicies({ settingsPath });
  const limit = resolveRuntimeQuotaLimit(policies[normalizedAgentId]);
  if (limit == null) return;
  // rotation/接续豁免：生命周期接续不是扩编（ADR-0027 §5）。
  if (intent === RUNTIME_SPAWN_INTENTS.ROTATION) return;

  const liveRuntimes = countLiveRuntimeProcesses(normalizedAgentId);
  if (liveRuntimes < limit) return;
  throw createRuntimeQuotaExceededError({ agentId: normalizedAgentId, limit, liveRuntimes });
}
