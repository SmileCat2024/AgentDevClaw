/**
 * Thread Runtime Bridge — Thread Inbox → head runtime 的最后一跳
 *
 * 职责：把一条 pending 的线程指令，经 viewer 的原子 user-turn 契约
 * （POST /api/agents/:viewerAgentId/user-turn）投递给当前承接会话
 * （head session）对应的 runtime。仅此而已——不运行 Agent、不判断任务
 * 完成、不理解线程调度。
 *
 * 选择 user-turn 而非 CallEnvelope 的原因：/user-turn 是 server→runtime
 * 的权威投递通道（群聊 dispatch 同路径），带排队语义（runtime 忙时由
 * viewer 侧 CallArbiter 串行消费）与结构化投递结果；envelope 队列当前
 * 无自动消费者，不适合作为真实投递路径。
 *
 * runtime 真相：resolveRuntimeViewerId(agentId, sessionId) 由宿主注入
 * （生产用 agent-access 的 buildStatus：running 且 selectedSessionId 匹配
 * 时返回 viewerAgentId，否则 null）。null 视为 runtime 未就绪，指令保持
 * pending，由调用方在 head 推进或 runtime ready 后重试。
 */

import { submitUserTurn, UserTurnDeliveryError } from '../shared/user-turn.js';

export const THREAD_BRIDGE_DISABLED_REASON = 'bridge_disabled';
export const RUNTIME_NOT_ACCEPTING_REASON = 'runtime_not_accepting';

export function buildRuntimeKey(agentId, sessionId) {
  return `${agentId}::${sessionId}`;
}

export class ThreadRuntimeBridge {
  /**
   * @param {object} options
   * @param {boolean} [options.enabled=false]
   * @param {(agentId: string, sessionId: string) => string | null} [options.resolveRuntimeViewerId]
   *   runtime 存活且可接收时返回 viewerAgentId，否则返回 null。测试可 stub。
   * @param {(params: {viewerAgentId: string, text: string, source: string, sourceRef: string}) => Promise<object>} [options.submitTurn]
   *   投递函数，默认 submitUserTurn。测试可 stub。
   */
  constructor({ enabled = false, resolveRuntimeViewerId = null, submitTurn = null } = {}) {
    this.enabled = enabled === true;
    this.resolveRuntimeViewerId = typeof resolveRuntimeViewerId === 'function' ? resolveRuntimeViewerId : null;
    this.submitTurn = typeof submitTurn === 'function' ? submitTurn : submitUserTurn;
  }

  isEnabled() {
    return this.enabled === true;
  }

  /**
   * 尝试把一条线程指令投递给 head runtime。
   *
   * @param {object} params
   * @param {object} params.thread - 线程记录（使用 agentId / headSessionId / threadId）
   * @param {object} params.command - 指令记录
   * @returns {Promise<{accepted: boolean, reason?: string, retryable?: boolean, deliveryRef?: string}>}
   */
  async deliver({ thread, command }) {
    if (!this.isEnabled()) {
      return { accepted: false, reason: THREAD_BRIDGE_DISABLED_REASON, retryable: true };
    }
    if (!thread?.agentId || !thread?.headSessionId) {
      return { accepted: false, reason: 'invalid_thread_target', retryable: false };
    }

    const viewerAgentId = this.resolveRuntimeViewerId
      ? this.resolveRuntimeViewerId(thread.agentId, thread.headSessionId)
      : null;
    if (!viewerAgentId) {
      // runtime 未就绪（未启动 / 正在换代 / 已停止）：指令保持 pending，
      // 由调用方在 head 推进或 runtime ready 后重试。
      return { accepted: false, reason: RUNTIME_NOT_ACCEPTING_REASON, retryable: true };
    }

    try {
      // 契约对齐：submitUserTurn 的参数是 agentId（viewerAgentId 只是本层
      // 的解析产物名）。参数名漂移会让客户端预校验抛 invalid_input（不可
      // 重试），指令被误判 failed——契约测试覆盖此点。
      await this.submitTurn({
        agentId: viewerAgentId,
        text: command.text,
        source: 'thread',
        sourceRef: command.commandId,
      });
    } catch (error) {
      const retryable = !(error instanceof UserTurnDeliveryError) || error.retryable !== false;
      return {
        accepted: false,
        reason: (error instanceof UserTurnDeliveryError && error.code) || 'delivery_failed',
        retryable,
      };
    }

    return { accepted: true, deliveryRef: viewerAgentId };
  }
}
