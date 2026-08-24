/**
 * Input Gateway — 用户输入投递的统一线程路由网关
 *
 * 所有「以 runtime 为目标的用户输入」在服务端的必经点。收敛两类调用方：
 *   - 外部直投：Claw 前端 POST /api/agents/:viewerAgentId/user-turn（server.js 代理）
 *   - 内部调用：交互面板提交（ui-surfaces）、未来的 IM 渠道路由
 *
 * 路由规则（单一真相，调用方无需感知线程）：
 *   收件会话是线程 head 且交接意图 fresh（pendingSuccession）
 *     → Thread Inbox 暂存（head 即将退役，直投的执行结果会留在旧会话、
 *       不被 successor 带走）；交接完成后由 applySessionSuccession 投给新 head。
 *   其余一切情况（无线程 / 非 host / 无交接）
 *     → 原样直投 viewer user-turn，行为与未接入线程时完全一致。
 *   历史 thread session（非 head）
 *     → 明确拒绝写入；历史 session 只读，调用方应切换到当前 head。

 *
 * 「非 head」不在此拦截：那是调用方 UI 上下文的路由问题（前端守卫
 * resolveThreadInputRoute 负责）；网关只拦「交接窗口」这一客观事实。
 *
 * 边界记录：IM 渠道（qqbot）当前经 CallArbiter 在 runtime 内路由，不经
 * viewer user-turn。当 IM 线路绑定指向线程宿主（coder）时，应在 IM 的
 * 目标会话解析处改调本入口，而不是直投 runtime。
 */

import { getRuntimeByViewerAgentId } from '../shared/agent-access.js';
import { submitUserTurn, UserTurnDeliveryError } from '../shared/user-turn.js';
import { getThreadIntegration, isThreadHostSession } from './thread-integration.js';

export { UserTurnDeliveryError };

/**
 * 投递一条用户输入。返回值 delivery 字段显式区分三种结果：
 *   - 'delivered' | 'queued' | 'input'：viewer 原生结果（直投成功/排队/槽位）
 *   - 'thread_queued'：已转入 Thread Inbox 暂存（附带 threadId / commandId）
 *
 * @param {object} [deps] 测试注入（生产调用不传，走默认单例）
 * @throws UserTurnDeliveryError 直投失败（网络/校验），或交接窗口收到
 *   图片输入（Thread Inbox 暂不支持附件，显式失败优于静默丢失）。
 */
export async function deliverUserInput(
  {
    viewerAgentId,
    text,
    images,
    source,
    sourceRef,
  } = {},
  { integration = getThreadIntegration(), fetchImpl = fetch } = {},
) {
  const normalizedViewerId = String(viewerAgentId || '').trim();
  const normalizedText = typeof text === 'string' ? text : '';

  const route = await _resolveThreadRoute(normalizedViewerId, integration);
  if (route.route !== 'thread') {
    return submitUserTurn({
      agentId: normalizedViewerId,
      text: normalizedText,
      images,
      source,
      sourceRef,
    }, { fetchImpl });
  }

  if (!normalizedText.trim()) {
    throw new UserTurnDeliveryError(
      'Thread handoff in progress: image-only input is not supported until the successor session is ready',
      { code: 'thread_handoff_images_unsupported', status: 409, retryable: true },
    );
  }

  const { command, duplicate } = await integration.core.appendCommand({
    threadId: route.thread.threadId,
    kind: 'user_message',
    text: normalizedText,
    source: String(source || '').trim() || 'gateway',
    idempotencyKey: sourceRef ? `gw-${sourceRef}` : '',
  });

  // 竞态闭合：路由判定（fresh 交接）与 append 之间 succession 可能已完成
  // （advanceHead 已清挡板、applySessionSuccession 已投递过一轮）——补一次
  // 投递尝试。交接仍在进行时它是 no-op（handoff_in_progress），已完成时
  // 正好把刚落入的指令当场送达，不留无触发点的 pending。
  let deliveryAttempt = null;
  if (!duplicate && typeof integration.tryDeliver === 'function') {
    deliveryAttempt = await integration.tryDeliver(route.thread.threadId);
  }

  return {
    success: true,
    delivery: 'thread_queued',
    threadId: route.thread.threadId,
    commandId: command.commandId,
    duplicate,
    ...(deliveryAttempt ? { deliveryAttempt } : {}),
  };
}

/**
 * 反查 runtime 归属并判定是否落入交接窗口。
 * 任何解析失败（runtime 不存在 / 非 host / 无线程 / 无 fresh 交接）
 * 一律 direct —— 网关的介入必须以确定的事实为前提。
 */
async function _resolveThreadRoute(viewerAgentId, integration) {
  if (!viewerAgentId) return { route: 'direct' };
  const runtime = getRuntimeByViewerAgentId(viewerAgentId);
  const agentId = String(runtime?.agentId || '').trim();
  const sessionId = String(runtime?.selectedSessionId || '').trim();
  if (!agentId || !sessionId || !isThreadHostSession(agentId, runtime?.sessionType)) {
    return { route: 'direct' };
  }

  let thread = await integration.core.findThreadByHeadSession(agentId, sessionId);
  if (!thread && typeof integration.findThreadBySession === 'function') {
    thread = await integration.findThreadBySession(agentId, sessionId);
  }
  if (!thread) return { route: 'direct' };

  // 非 head Session 仍可查看，但不能把新输入写入历史分片；不要静默转投
  // 当前 head，避免用户误以为自己仍在编辑历史现场。
  if (thread.headSessionId !== sessionId) {
    throw new UserTurnDeliveryError(
      'Historical thread sessions are read-only; open the current head session to continue',
      { code: 'session_not_head', status: 409, retryable: false },
    );
  }

  // 与 core.deliverPendingCommands 的派生规则同源（fresh 判定），
  // 但此处只读不写：stale 交接不构成拦截理由。
  if (!integration.core.isHandoffActive(thread)) {
    return { route: 'direct' };
  }

  return { route: 'thread', thread };
}
