/**
 * Thread Runtime Bridge — Thread Inbox → Runtime Envelope 的最后一跳
 *
 * 职责：把一条 pending 的线程指令，投递为当前承接会话（head session）
 * 对应 runtime 的 CallEnvelope。仅此而已——不运行 Agent、不判断任务
 * 完成、不理解线程调度。
 *
 * 休眠设计：默认 enabled = false。此时 deliver() 永远返回
 * { accepted: false, reason: 'bridge_disabled' }，指令停留在 inbox 的
 * pending 状态，不会触碰任何真实 runtime inbox。地基阶段没有任何
 * 现有流程会把 enabled 打开——启用属于未来接线方（thread 接续产品化
 * 时的显式决策）。
 *
 * isRuntimeAccepting(runtimeKey) 为可注入谓词：未来接线时由宿主提供
 * 「该 runtime 是否存活且可接收」的真相；测试中用 stub。
 */

export const THREAD_BRIDGE_DISABLED_REASON = 'bridge_disabled';
export const RUNTIME_NOT_ACCEPTING_REASON = 'runtime_not_accepting';

export function buildRuntimeKey(agentId, sessionId) {
  return `${agentId}::${sessionId}`;
}

export class ThreadRuntimeBridge {
  /**
   * @param {object} options
   * @param {boolean} [options.enabled=false]
   * @param {(runtimeKey: string) => boolean} [options.isRuntimeAccepting]
   * @param {object} [options.envelopeModule] - 可注入 envelope 实现（测试用），
   *   默认延迟 import '../runtime-call-envelope.js'，避免模块级副作用。
   */
  constructor({ enabled = false, isRuntimeAccepting = null, envelopeModule = null } = {}) {
    this.enabled = enabled === true;
    this.isRuntimeAccepting = typeof isRuntimeAccepting === 'function' ? isRuntimeAccepting : null;
    this._envelopeModule = envelopeModule;
    this._envelopeModulePromise = null;
  }

  isEnabled() {
    return this.enabled === true;
  }

  async _getEnvelopeModule() {
    if (this._envelopeModule) return this._envelopeModule;
    if (!this._envelopeModulePromise) {
      this._envelopeModulePromise = import('../runtime-call-envelope.js');
    }
    return this._envelopeModulePromise;
  }

  /**
   * 尝试把一条线程指令下沉为 head runtime 的 envelope。
   *
   * @param {object} params
   * @param {object} params.thread - 线程记录（使用 headSessionId / agentId）
   * @param {object} params.command - 指令记录
   * @returns {Promise<{accepted: boolean, reason?: string, retryable?: boolean, envelopeId?: string}>}
   */
  async deliver({ thread, command }) {
    if (!this.isEnabled()) {
      return { accepted: false, reason: THREAD_BRIDGE_DISABLED_REASON, retryable: true };
    }
    if (!thread?.agentId || !thread?.headSessionId) {
      return { accepted: false, reason: 'invalid_thread_target', retryable: false };
    }

    const runtimeKey = buildRuntimeKey(thread.agentId, thread.headSessionId);
    if (this.isRuntimeAccepting && !this.isRuntimeAccepting(runtimeKey)) {
      // runtime 未就绪（未启动 / 正在换代 / 已停止）：指令保持 pending，
      // 由调用方在 head 推进或 runtime ready 后重试。
      return { accepted: false, reason: RUNTIME_NOT_ACCEPTING_REASON, retryable: true };
    }

    const envelopeModule = await this._getEnvelopeModule();
    const envelope = envelopeModule.createCallEnvelope({
      runtimeKey,
      agentId: thread.agentId,
      sessionId: thread.headSessionId,
      source: envelopeModule.EnvelopeSource.THREAD,
      sourceRef: command.commandId,
      text: command.text,
      threadId: thread.threadId,
      commandId: command.commandId,
    });
    envelopeModule.enqueueRuntimeEnvelope(envelope);

    return { accepted: true, envelopeId: envelope.id };
  }
}
