/**
 * Runtime quota — per-workspace running Coder runtime instances.
 *
 * The existing permission id `maxLiveThreads` is retained for configuration
 * compatibility. Its value limits simultaneously running runtime processes,
 * not thread records. Shared-process sessions count once by ChildProcess
 * identity; idle, pending-command, and archived threads do not affect it.
 */

import { countLiveRuntimeProcesses } from '../shared/agent-access.js';
import { PERMISSION_ITEMS } from '../shared/permission-registry.js';
import { readWorkspaceResourcePolicies } from './workspace-settings.js';
import { LocalOperationError } from '../shared/operation-contract.js';

const reservationsByAgent = new Map();
const quotaLocks = new Map();

async function withQuotaLock(agentId, fn) {
  const previous = quotaLocks.get(agentId) || Promise.resolve();
  let releaseLock;
  const current = new Promise((resolve) => { releaseLock = resolve; });
  quotaLocks.set(agentId, current);
  await previous;
  try {
    return await fn();
  } finally {
    releaseLock();
    if (quotaLocks.get(agentId) === current) quotaLocks.delete(agentId);
  }
}

export function resolveRuntimeQuotaLimit(policy) {
  const limit = policy?.[PERMISSION_ITEMS.maxLiveThreads.id];
  return PERMISSION_ITEMS.maxLiveThreads.validate(limit) ? limit : null;
}

export function createRuntimeQuotaExceededError({ agentId, limit, liveRuntimes }) {
  const error = new LocalOperationError(
    `工作空间「${agentId}」的 runtime 并发上限已满（当前运行 ${liveRuntimes}/${limit}），拒绝拉起新的 Coder runtime。`
      + '可行动：等待运行中的 runtime 退出，或请用户在 设置 → 工作空间 调整并发上限，或放弃本次派发。',
    { code: 'runtime_quota_exceeded', status: 429 },
  );
  error.runtimeQuota = Object.freeze({
    agentId,
    limit,
    liveRuntimes,
    actions: ['wait_for_runtime', 'raise_quota', 'abandon'],
  });
  return error;
}

/**
 * Reserve one slot immediately before a new child process is started.
 * The reservation closes the check/start race between concurrent dispatches.
 * Call the returned release function after the runtime is registered, or when
 * spawn fails before registration.
 */
export async function acquireRuntimeSpawnSlot({
  agentId,
  permissions = [],
  settingsPath = undefined,
} = {}) {
  const normalizedAgentId = String(agentId || '').trim();
  if (!normalizedAgentId || !Array.isArray(permissions)
    || !permissions.includes(PERMISSION_ITEMS.maxLiveThreads.id)) return null;

  return withQuotaLock(normalizedAgentId, async () => {
    const policies = await readWorkspaceResourcePolicies({ settingsPath });
    const limit = resolveRuntimeQuotaLimit(policies[normalizedAgentId]);
    if (limit == null) return null;

    const reserved = reservationsByAgent.get(normalizedAgentId) || 0;
    const liveRuntimes = countLiveRuntimeProcesses(normalizedAgentId);
    if (liveRuntimes + reserved >= limit) {
      throw createRuntimeQuotaExceededError({ agentId: normalizedAgentId, limit, liveRuntimes });
    }

    reservationsByAgent.set(normalizedAgentId, reserved + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = reservationsByAgent.get(normalizedAgentId) || 0;
      if (current <= 1) reservationsByAgent.delete(normalizedAgentId);
      else reservationsByAgent.set(normalizedAgentId, current - 1);
    };
  });
}

/** Current running runtime process count, deduplicated by ChildProcess identity. */
export function countLiveRuntimesByAgent(agentId) {
  return countLiveRuntimeProcesses(agentId);
}

export function countLiveRuntimesByAgentMap() {
  return countLiveRuntimeProcesses();
}
