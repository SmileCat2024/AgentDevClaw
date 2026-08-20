/**
 * Thread Integration — 工作线程与 Claw 会话生命周期的接线层
 *
 * 把 thread-control 控制面挂到既有会话生命周期的钩子上：
 *   1. onSessionCreated：coder 工作空间新建会话（含 branch 产生的新会话）
 *      时自动创建线程（会话成为线程 root 与初始 head）；
 *   2. beginSessionSuccession：compact / summary 接力开始时写入交接意图
 *      （pendingSuccession 挡板）；
 *   3. applySessionSuccession：successor 会话就绪后推进线程 head 并投递
 *      接力期间暂存的指令；
 *   4. onSessionDeleted：被删会话是线程 head 时取消该线程；
 *   5. tryDeliver：appendCommand 后的即时投递尝试（head runtime 已就绪时）。
 *
 * 兼容性边界：THREAD_HOST_AGENT_IDS 之外的工作空间（编程小助手等）
 * 在本层被直接跳过，会话流程行为与未接入线程时完全一致。
 */

import { getThreadController } from './thread-controller.js';
import { ThreadNotFoundError } from './thread-store.js';

/** 开启线程化会话的工作空间（演示阶段仅 coder） */
export const THREAD_HOST_AGENT_IDS = new Set(['coder']);

export function createThreadIntegration({ controller = null } = {}) {
  const threadController = controller || getThreadController();

  return {
    controller: threadController,

    /**
     * 会话创建钩子：线程宿主工作空间的新会话自动成为一条新线程。
     * 失败不阻断会话创建（线程是承接增强，不是会话存在的前提）。
     */
    async onSessionCreated(agentId, session) {
      if (!THREAD_HOST_AGENT_IDS.has(String(agentId || '').trim())) return null;
      const sessionId = String(session?.id || '').trim();
      if (!sessionId) return null;
      try {
        const thread = await threadController.createThread({
          agentId,
          sessionId,
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
     * 非线程宿主 / 会话无线程：no-op（纯会话语义，行为与未接入线程一致）。
     */
    async beginSessionSuccession({ agentId, sessionId, reason = 'manual' }) {
      const normalizedAgentId = String(agentId || '').trim();
      if (!THREAD_HOST_AGENT_IDS.has(normalizedAgentId)) {
        return { applied: false, reason: 'not_thread_host' };
      }
      const from = String(sessionId || '').trim();
      if (!from) return { applied: false, reason: 'invalid_session' };
      try {
        const thread = await threadController.findThreadByHeadSession(normalizedAgentId, from);
        if (!thread) return { applied: false, reason: 'no_thread_for_session' };
        await threadController.beginSessionHandoff({
          threadId: thread.threadId,
          fromSessionId: from,
          reason,
        });
        return { applied: true, threadId: thread.threadId };
      } catch (error) {
        // 标记失败不阻断 compact 主流程：最坏情况是交接期间指令被投向旧
        // head（与未接入线程时的行为一致），不产生新故障模式。
        console.error(`[thread-integration] beginSessionSuccession failed for session=${from}:`, error?.message || error);
        return { applied: false, reason: 'error', error: error?.message || String(error) };
      }
    },

    /**
     * 会话接力钩子：compact / summary 成功创建 successor 后调用。
     * fromSessionId 是线程当前 head 时推进 head（endKind 记录接力原因），
     * 随后尝试把接力期间暂存的 pending 指令投递给新 head runtime。
     * 非 head / 无线程 / 非线程宿主：静默跳过（no-op）。
     */
    async applySessionSuccession({ agentId, fromSessionId, toSessionId, reason = 'manual' }) {
      const normalizedAgentId = String(agentId || '').trim();
      if (!THREAD_HOST_AGENT_IDS.has(normalizedAgentId)) return { applied: false, reason: 'not_thread_host' };
      const from = String(fromSessionId || '').trim();
      const to = String(toSessionId || '').trim();
      if (!from || !to || from === to) return { applied: false, reason: 'invalid_succession' };

      try {
        const thread = await threadController.findThreadByHeadSession(normalizedAgentId, from);
        if (!thread) return { applied: false, reason: 'no_thread_for_session' };

        const advanced = await threadController.advanceHead({
          threadId: thread.threadId,
          toSessionId: to,
          fromSessionId: from,
          endKind: String(reason || 'manual').trim() || 'manual',
        });
        console.log(`[thread-integration] head advanced: ${thread.threadId} ${from} -> ${to} (${reason})`);

        // successor runtime 已在 compact 流程内等待 ready；投递暂存指令
        const delivery = await threadController.deliverPendingCommands(thread.threadId);
        return { applied: true, thread: advanced, delivery };
      } catch (error) {
        if (error instanceof ThreadNotFoundError) {
          return { applied: false, reason: 'thread_not_found' };
        }
        console.error(`[thread-integration] succession failed ${from} -> ${to}:`, error?.message || error);
        return { applied: false, reason: 'error', error: error?.message || String(error) };
      }
    },

    /**
     * 会话删除钩子：被删会话是某线程当前 head 时取消该线程——工作已无
     * 承接点，pending 指令一并取消（继续保留只会形成永远投不出去的
     * 悬空线程）。删除非 head 会话 / 无线程 / 非线程宿主：no-op（线程
     * 历史链对已删棒次的引用由前端标题解析退化为短 id，无需清理）。
     */
    async onSessionDeleted(agentId, sessionId) {
      const normalizedAgentId = String(agentId || '').trim();
      if (!THREAD_HOST_AGENT_IDS.has(normalizedAgentId)) {
        return { applied: false, reason: 'not_thread_host' };
      }
      const deleted = String(sessionId || '').trim();
      if (!deleted) return { applied: false, reason: 'invalid_session' };
      try {
        const thread = await threadController.findThreadByHeadSession(normalizedAgentId, deleted);
        if (!thread) return { applied: false, reason: 'no_thread_for_session' };
        await threadController.cancelThread(thread.threadId, { reason: 'head_session_deleted' });
        console.log(`[thread-integration] thread cancelled (head session deleted): ${thread.threadId}`);
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
        return await threadController.deliverPendingCommands(threadId);
      } catch (error) {
        if (error instanceof ThreadNotFoundError) {
          return { attempted: 0, delivered: 0, reason: 'thread_not_found', results: [] };
        }
        return { attempted: 0, delivered: 0, reason: 'error', error: error?.message || String(error) };
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
