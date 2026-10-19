/**
 * Thread Quota — per-workspace 非终态线程配额（ADR-0027 修订一）
 *
 * 计数对象：workspace 名下的非终态线程数（lifeState 为 executing /
 * pending-commands / idle；archived / closed 不计）。判定只依赖线程账面
 * 状态（锚点 status + 归档索引），不读看板、不数进程——idle 未归档线程
 * 也占名额，归档是唯一释放动作，配额由此与「干完收口」的调度纪律闭环。
 *
 * 键：agentId（workspace）。工作空间经 metadata.json permissions 声明
 * maxLiveThreads 才接受治理；缺省（无 resourcePolicy 配置）不限，热路径
 * 零额外行为。
 *
 * 强制点：建线入口（修订一自 startManagedAgent 的 spawn 漏斗迁移）——
 *   - POST /protoclaw/prebuilt_sessions：会话落盘之前检查（满配额时连
 *     会话都不创建，不留无线程的孤儿会话）；
 *   - POST /protoclaw/threads：core.start 之前。
 * 上下文接续（rotate）不新增线程，天然不经过建线入口，无需豁免标记；
 * send / deliver 唤醒已有线程的 head runtime 同样不经建线入口——满配额
 * 只挡新建，不影响既有线程续工。
 *
 * 超限行为：结构化拒绝（LocalOperationError，status 429 + threadQuota
 * 负载），经全局错误契约（operation-contract）透传给调度方；收到报文后
 * 怎么应对（归档腾位 / 问用户 / 放弃）是应用层语义，内核不管。
 */

import { PERMISSION_ITEMS } from '../shared/permission-registry.js';
import { readWorkspaceResourcePolicies } from './workspace-settings.js';
import { LocalOperationError } from '../shared/operation-contract.js';

/** resourcePolicy 条目 → 配额上限（正整数），非法/缺省返回 null（不限）。 */
export function resolveThreadQuotaLimit(policy) {
  const limit = policy?.[PERMISSION_ITEMS.maxLiveThreads.id];
  return PERMISSION_ITEMS.maxLiveThreads.validate(limit) ? limit : null;
}

/** 满配额拒绝错误：结构化负载经 buildLocalFailureResponse 透传（HTTP 429）。 */
export function createThreadQuotaExceededError({ agentId, limit, liveThreads }) {
  const error = new LocalOperationError(
    `工作空间「${agentId}」的线程并发上限已满（存活线程 ${liveThreads}/${limit}），拒绝新建线程。`
    + '可行动：归档自己已完成的线程腾出名额，或请用户在 设置 → 工作空间 调整线程并发上限，或放弃本次派发。',
    { code: 'thread_quota_exceeded', status: 429 },
  );
  error.threadQuota = Object.freeze({
    agentId,
    limit,
    liveThreads,
    actions: ['archive_thread', 'raise_quota', 'abandon'],
  });
  return error;
}

/** 非终态判定：archived（归档索引）与 closed（锚点终态）之外全部计数。 */
function isNonTerminalThread(thread, archivedIds) {
  return Boolean(thread) && thread.status !== 'closed' && !archivedIds.has(thread.threadId);
}

async function readArchivedIds(archive) {
  const entries = await archive.list().catch(() => ({}));
  return new Set(Object.keys(entries || {}));
}

/**
 * 某个 workspace 的非终态线程数。executing / pending-commands / idle 对
 * 计数等价，无需看板状态合成。
 */
export async function countNonTerminalThreads(control, agentId) {
  const normalizedAgentId = String(agentId || '').trim();
  const threads = await control.core.listThreads({ agentId: normalizedAgentId || undefined });
  const archivedIds = await readArchivedIds(control.archive);
  return threads.filter((thread) => isNonTerminalThread(thread, archivedIds)).length;
}

/**
 * 全部 workspace 的非终态线程数投影（{ <agentId>: n }）：设置面板「当前
 * N」与 coder_shell 预检共用（经 GET /protoclaw/workspace_settings）。
 */
export async function countNonTerminalThreadsByAgent(control) {
  const threads = await control.core.listThreads({});
  const archivedIds = await readArchivedIds(control.archive);
  const counts = {};
  for (const thread of threads) {
    if (!isNonTerminalThread(thread, archivedIds)) continue;
    const agentId = String(thread.agentId || '').trim();
    if (!agentId) continue;
    counts[agentId] = (counts[agentId] || 0) + 1;
  }
  return counts;
}

/**
 * 配额判定：满配额抛 createThreadQuotaExceededError，否则静默放行。
 *
 * control（{ core, archive }）由调用方传入：会话路由经
 * getThreadIntegration()，threads 路由经装配层闭包；本模块不绑定线程
 * 控制面的获取方式（测试注入替身同理）。settingsPath 是测试缝（隔离
 * 用户数据目录），生产调用不传。
 */
export async function assertThreadQuotaAllowed({
  agentId,
  permissions = [],
  control,
  settingsPath = undefined,
} = {}) {
  const normalizedAgentId = String(agentId || '').trim();
  if (!normalizedAgentId || !Array.isArray(permissions)
    || !permissions.includes(PERMISSION_ITEMS.maxLiveThreads.id)) return;

  const policies = await readWorkspaceResourcePolicies({ settingsPath });
  const limit = resolveThreadQuotaLimit(policies[normalizedAgentId]);
  if (limit == null) return;

  const liveThreads = await countNonTerminalThreads(control, normalizedAgentId);
  if (liveThreads < limit) return;
  throw createThreadQuotaExceededError({ agentId: normalizedAgentId, limit, liveThreads });
}
