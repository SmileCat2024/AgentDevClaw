/**
 * Thread Integration — 工作线程与 Claw 会话生命周期的接线层
 *
 * 把 thread-control 控制面挂到既有会话生命周期的钩子上：
 *   1. onSessionCreated：线程宿主会话（如 programming-helper 工作空间的
 *      coder 类型会话，含 branch 产生的新会话）自动创建线程（会话成为
 *      线程 root 与初始 head）；
 *   2. beginSessionSuccession：compact / summary 接力开始时写入交接意图
 *      （pendingSuccession 挡板）；
 *   3. applySessionSuccession：successor 会话就绪后推进线程 head 并投递
 *      接力期间暂存的指令；
 *   4. onSessionDeleted：被删会话是线程 head 时取消该线程；
 *   5. tryDeliver：appendCommand 后的即时投递尝试（head runtime 已就绪时）；
 *   6. handleRuntimeReady：head runtime 就绪时补投 pending 指令（经
 *      shared/runtime-hooks 的 onRuntimeReady 订阅接入）。
 *
 * 判定基准：isThreadHostSession 只回答「哪个 (工作空间, 会话类型) 组合的
 * 新会话自动建立线程环境」（环境的存在性开关，消费点：onSessionCreated
 * 与 input-gateway 的指令路由闸）。其余事件响应钩子（succession / 删除
 * 清理 / runtime 就绪补投 / guard 触发的 rotation）一律以「该会话是否为
 * 某活跃线程的 head」为唯一判定——处于线程环境（thread）则生效，纯
 * session 会话天然 no-op，与 agent 归属哪个工作空间无关。
 */

import { getThreadControl } from './thread-controller.js';
import { ThreadNotFoundError } from './thread-store.js';
import { isThreadHostSession } from './host-agents.js';

// 判定的唯一定义在 ./host-agents.js（无副作用轻量模块，供 agent 子进程同源
// 引用）；此处 re-export 维持 server 侧既有消费方（input-gateway 等）不变。
export { isThreadHostSession };

export function createThreadIntegration({ control = null } = {}) {
  const { core, board } = control || getThreadControl();

  return {
    core,
    board,

    /**
     * 会话创建钩子：线程宿主工作空间的新会话自动成为一条新线程。
     * 失败不阻断会话创建（线程是承接增强，不是会话存在的前提）。
     */
    async onSessionCreated(agentId, session) {
      if (!isThreadHostSession(agentId, session?.sessionType)) return null;
      const sessionId = String(session?.id || '').trim();
      if (!sessionId) return null;
      try {
        const thread = await core.start({
          sessionRef: { agentId, sessionId },
          title: String(session?.title || '').trim(),
        });
        console.log(`[thread-integration] thread created: ${thread.threadId} head=${sessionId}`);
        return thread;
      } catch (error) {
        console.error(`[thread-integration] failed to create thread for session=${sessionId}:`, error?.message || error);
        return null;
      }
    },

    /**
     * 交接开始钩子：会话路由确定要执行 compact/summary 接力时调用。
     * 在线程记录里写入 pendingSuccession（交接意图），使接力期间追加的
     * inbox 指令保持 pending、不被投向即将退役的旧 head；advanceHead
     * 推进时原子清除并统一投递给新 head。
     * 纯 session 会话（无线程）：no-op（纯会话语义，行为与未接入线程一致）。
     */
    async beginSessionSuccession({ agentId, sessionId, reason = 'manual' }) {
      const normalizedAgentId = String(agentId || '').trim();
      const from = String(sessionId || '').trim();
      if (!from) return { applied: false, reason: 'invalid_session' };
      try {
        const thread = await core.findThreadByHeadSession(normalizedAgentId, from);
        if (!thread) return { applied: false, reason: 'no_thread_for_session' };
        await core.beginSessionHandoff({
          threadId: thread.threadId,
          fromSessionId: from,
          reason,
        });
        return { applied: true, threadId: thread.threadId };
      } catch (error) {
        console.error(`[thread-integration] beginSessionSuccession failed for session=${from}:`, error?.message || error);
        return { applied: false, reason: 'error', error: error?.message || String(error) };
      }
    },

    /**
     * 会话接力钩子：compact / summary 成功创建 successor 后调用。
     * fromSessionId 是线程当前 head 时推进 head（endKind 记录接力原因），
     * 随后尝试把接力期间暂存的 pending 指令投递给新 head runtime。
     * 非 head / 无线程（纯 session）：静默跳过（no-op）。
     */
    async applySessionSuccession({ agentId, fromSessionId, toSessionId, reason = 'manual' }) {
      const normalizedAgentId = String(agentId || '').trim();
      const from = String(fromSessionId || '').trim();
      const to = String(toSessionId || '').trim();
      if (!from || !to || from === to) return { applied: false, reason: 'invalid_succession' };

      let thread = null;
      try {
        thread = await core.findThreadByHeadSession(normalizedAgentId, from);
        if (!thread) return { applied: false, reason: 'no_thread_for_session' };

        const advanced = await core.advanceHead({
          threadId: thread.threadId,
          toSessionId: to,
          fromSessionId: from,
          endKind: String(reason || 'manual').trim() || 'manual',
        });
        console.log(`[thread-integration] head advanced: ${thread.threadId} ${from} -> ${to} (${reason})`);

        // successor runtime 已在 compact 流程内等待 ready；投递暂存指令
        const delivery = await core.deliverPendingCommands(thread.threadId);
        return { applied: true, thread: advanced, delivery };
      } catch (error) {
        if (error instanceof ThreadNotFoundError) {
          return { applied: false, reason: 'thread_not_found' };
        }
        console.error(`[thread-integration] succession failed ${from} -> ${to}:`, error?.message || error);
        const failed = await core.failSessionHandoff(thread.threadId, {
          reason: 'handoff_failed',
          stage: 'advance_head',
          error: error?.message || String(error),
        }).catch(() => null);
        return { applied: false, reason: 'handoff_failed', error: error?.message || String(error), thread: failed };
      }
    },

    /**
     * 交接失败钩子：把上下文交接停在明确的 rotation_failed，保留
     * pendingSuccession 和失败阶段，供恢复入口收拾残局。
     * 纯 session 会话（无线程）：no-op。
     */
    async failSessionSuccession({ agentId, sessionId, reason = 'handoff_failed', stage = 'unknown', error = null }) {
      const normalizedAgentId = String(agentId || '').trim();
      const from = String(sessionId || '').trim();
      if (!from) return { applied: false, reason: 'invalid_session' };
      try {
        const thread = await core.findThreadByHeadSession(normalizedAgentId, from);
        if (!thread) return { applied: false, reason: 'no_thread_for_session' };
        const failed = await core.failSessionHandoff(thread.threadId, { reason, stage, error });
        return { applied: true, thread: failed, threadId: thread.threadId };
      } catch (failure) {
        console.error(`[thread-integration] failSessionSuccession failed for session=${from}:`, failure?.message || failure);
        return { applied: false, reason: 'error', error: failure?.message || String(failure) };
      }
    },

    /**
     * 会话删除钩子：被删会话是某线程当前 head 时取消该线程——工作已无
     * 承接点，pending 指令一并取消（继续保留只会形成永远投不出去的
     * 悬空线程）。删除非 head 会话 / 无线程（纯 session）：no-op（线程
     * 历史链对已删棒次的引用由前端标题解析退化为短 id，无需清理）。
     */
    async onSessionDeleted(agentId, sessionId) {
      const normalizedAgentId = String(agentId || '').trim();
      const deleted = String(sessionId || '').trim();
      if (!deleted) return { applied: false, reason: 'invalid_session' };
      try {
        const thread = await core.findThreadByHeadSession(normalizedAgentId, deleted);
        if (!thread) return { applied: false, reason: 'no_thread_for_session' };
        await core.closeThread(thread.threadId, { reason: 'head_session_deleted' });
        console.log(`[thread-integration] thread closed (head session deleted): ${thread.threadId}`);
        return { applied: true, threadId: thread.threadId };
      } catch (error) {
        // 善后失败不阻断删除主流程：最坏情况是线程悬空 active，后续删除
        // 该 head 或显式 cancel 仍可收敛。
        console.error(`[thread-integration] onSessionDeleted failed for session=${deleted}:`, error?.message || error);
        return { applied: false, reason: 'error', error: error?.message || String(error) };
      }
    },

    /**
     * 指令追加后的即时投递：head runtime 已就绪时当场送达，
     * 否则保持 pending 等待下一次 head 推进 / 显式 deliver。
     */
    async tryDeliver(threadId) {
      try {
        return await core.deliverPendingCommands(threadId);
      } catch (error) {
        if (error instanceof ThreadNotFoundError) {
          return { attempted: 0, delivered: 0, reason: 'thread_not_found', results: [] };
        }
        return { attempted: 0, delivered: 0, reason: 'error', error: error?.message || String(error) };
      }
    },

    /**
     * runtime 就绪钩子（server.js 经 onRuntimeReady 订阅接入）。
     * succession 时刻 runtime 未就绪（waitForManagedRuntimeReady 超时等）
     * 而保持 pending 的指令，在 head runtime 真正 ready 时补投——
     * 这是「runtime 未就绪保持 pending，ready 后重试」的最后一个触发点。
     * 就绪会话不是任何线程 head（纯 session，启动期常态）时 no-op，非错误。
     */
    async handleRuntimeReady(agentId, sessionId) {
      const normalizedAgentId = String(agentId || '').trim();
      const readySession = String(sessionId || '').trim();
      if (!readySession) return { applied: false, reason: 'invalid_session' };
      try {
        const thread = await core.findThreadByHeadSession(normalizedAgentId, readySession);
        if (!thread) return { applied: false, reason: 'no_thread_for_session' };
        const delivery = await this.tryDeliver(thread.threadId);
        return { applied: true, threadId: thread.threadId, delivery };
      } catch (error) {
        console.error(`[thread-integration] runtime-ready delivery failed for session=${readySession}:`, error?.message || error);
        return { applied: false, reason: 'error', error: error?.message || String(error) };
      }
    },
  };
}

let _defaultIntegration = null;

export function getThreadIntegration() {
  if (!_defaultIntegration) {
    _defaultIntegration = createThreadIntegration();
  }
  return _defaultIntegration;
}
