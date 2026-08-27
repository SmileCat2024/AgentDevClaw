/**
 * Input Gateway — 用户输入投递的统一线程路由网关
 *
 * 所有「以 runtime 为目标的用户输入」在服务端的必经点。收敛两类调用方：
 *   - 外部直投：Claw 前端 POST /api/agents/:viewerAgentId/user-turn（server.js 代理）
 *   - 内部调用：交互面板提交（ui-surfaces）、未来的 IM 渠道路由
 *
 * 路由规则（R6 队列化：域判定而非窗口判定）：
 *   收件会话是某活跃线程的 head
 *     → Thread Inbox 暂存 + 即时投递尝试。指令的去留时机（hold / 交接
 *       / rotation_failed / runtime 未就绪）由 deliverPendingCommands 在
 *       投递时按客观事实把关，网关不做第二重状态裁决——历史上「fresh
 *       挡板才转 Inbox」的窗口判定会让 hold / failed / closed 态的输入
 *       绕过全部行政检查直投旧 runtime（A11 旁路）。
 *   线程已 close（硬终态）
 *     → 显式拒绝 thread_closed；终态线程的指令入箱只会永久滞留。
 *   收件会话是线程历史成员（非 head）
 *     → 明确拒绝写入 session_not_head；历史 session 只读，调用方应切换
 *       到当前 head。
 *   其余一切情况（无线程 / 非 host / runtime 条目不存在）
 *     → 原样直投 viewer user-turn，行为与未接入线程时完全一致。
 *
 * 「非 head」不在此拦截：那是调用方 UI 上下文的路由问题（前端守卫
 * resolveThreadInputRoute 负责）；网关只拦「线程域归属」这一客观事实。
 *
 * 边界记录（A12 已知窗口）：runtime 条目被删除后（共享进程退出）网关
 * 无法从 viewerAgentId 反查 (agentId, sessionId)——请求体不含会话事实，
 * 只能回退直投，由 submitUserTurn 报出真实的运行时错误。窗口为毫秒级
 * 竞态（successor runtime 注册前），不做请求体接口扩展。
 *
 * IM 渠道（qqbot）当前经 CallArbiter 在 runtime 内路由，不经 viewer
 * user-turn。当 IM 线路绑定指向线程宿主（coder）时，应在 IM 的目标会话
 * 解析处改调本入口，而不是直投 runtime。
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
 * @throws UserTurnDeliveryError 直投失败（网络/校验）、线程已关闭
 *   （thread_closed）或收件会话是历史成员（session_not_head）。
 */
export async function deliverUserInput(
  {
    viewerAgentId,
    text,
    images,
    source,
    sourceRef,
    capabilityActivations,
  } = {},
  { integration = getThreadIntegration(), fetchImpl = fetch } = {},
) {
  const normalizedViewerId = String(viewerAgentId || '').trim();
  const normalizedText = typeof text === 'string' ? text : '';
  const normalizedImages = Array.isArray(images) ? images : [];

  const route = await _resolveThreadRoute(normalizedViewerId, integration);
  if (route.route === 'rejected') {
    throw route.error;
  }
  if (route.route !== 'thread') {
    return submitUserTurn({
      agentId: normalizedViewerId,
      text: normalizedText,
      ...(normalizedImages.length > 0 ? { images: normalizedImages } : {}),
      source,
      sourceRef,
      ...(Array.isArray(capabilityActivations) ? { capabilityActivations } : {}),
    }, { fetchImpl });
  }

  if (!normalizedText.trim() && normalizedImages.length === 0) {
    throw new UserTurnDeliveryError('text or images must be provided', {
      code: 'invalid_input',
      status: 400,
      retryable: false,
    });
  }

  const { command, duplicate } = await integration.core.appendCommand({
    threadId: route.thread.threadId,
    kind: 'user_message',
    text: normalizedText,
    source: String(source || '').trim() || 'gateway',
    idempotencyKey: sourceRef ? `gw-${sourceRef}` : '',
    ...(normalizedImages.length > 0 ? { images: normalizedImages } : {}),
    ...(Array.isArray(capabilityActivations) ? { capabilityActivations } : {}),
  });

  // 竞态闭合：路由判定与 append 之间 succession 可能已完成（advanceHead
  // 已清挡板、applySessionSuccession 已投递过一轮）——补一次投递尝试。
  // 交接仍在进行时它被 deliver 序列的客观检查拦下（no-op），已完成时
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
 * 反查 runtime 归属并判定线程域归属。
 *   - { route:'thread', thread }：活跃线程的 head——指令入箱；
 *   - { route:'rejected', error }：终态线程（closed）或历史成员——显式拒绝；
 *   - { route:'direct' }：其余一切（无线程 / 非 host / 条目不存在）——直投。
 * 网关的介入必须以确定的事实为前提；线程域内不做第二重状态裁决（R6）。
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
    return {
      route: 'rejected',
      error: new UserTurnDeliveryError(
        'Historical thread sessions are read-only; open the current head session to continue',
        { code: 'session_not_head', status: 409, retryable: false },
      ),
    };
  }

  // 终态线程禁入：closeThread 后 head 不变，历史链仍可查看，但工作已无
  // 承接点——指令入箱只会在无投递触发的状态下永久滞留。
  if (thread.status === 'closed') {
    return {
      route: 'rejected',
      error: new UserTurnDeliveryError(
        'This thread is closed; start a new session to continue the work',
        { code: 'thread_closed', status: 409, retryable: false },
      ),
    };
  }

  // 归档线程禁入（与 closed 同理：runtime 已停，unarchive 前入箱只会滞留）。
  // 归档事务窗口（hold 后、runtime 停止前）同样拦截，指令不落入 cancel
  // 快照之外的盲区。判定经 archive 单点，与 commands / deliver / ACP
  // resume 四入口共享同一事实。
  if (typeof integration.archive?.resolveCommandRejection === 'function') {
    const rejection = await integration.archive.resolveCommandRejection(thread.threadId);
    if (rejection) {
      return {
        route: 'rejected',
        error: new UserTurnDeliveryError(
          'This thread is archived; unarchive it before sending new messages',
          { code: rejection.code, status: rejection.status, retryable: false },
        ),
      };
    }
  }

  return { route: 'thread', thread };
}
