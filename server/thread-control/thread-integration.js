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
import { abortPendingSuccession } from './thread-succession.js';

// 判定的唯一定义在 ./host-agents.js（无副作用轻量模块，供 agent 子进程同源
// 引用）；此处 re-export 维持 server 侧既有消费方（input-gateway 等）不变。
export { isThreadHostSession };

export function createThreadIntegration({ control = null } = {}) {
  const { core, board, archive } = control || getThreadControl();

  // T001：成员查询的权威实现在框架 WorkThread.findThreadBySession——
  // 归属事实唯一取自 sessionChain 链记录（root / predecessor / head 一致），
  // 不用 UI 投影或运行时扫描推导。此处保留 Claw 侧入口签名，消费方
  // （acp / input-gateway / 前端投影）不变。
  async function findThreadBySession(agentId, sessionId) {
    return core.findThreadBySession(agentId, sessionId);
  }

  return {
    core,
    board,
    // T004：input-gateway 入口层拒绝归档线程新 send 需要归档标记事实
    // （routes 的 _assertNotArchived 同源）；暴露给网关消费。
    archive,
    findThreadBySession,

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
          // T001：身份归属取自 root Session 记录自身（sessionType 即产品身份
          // 事实）。字段缺失（undefined / 空串）时框架回退 identitySource
          // （session index）解析；解析不到记为 null（未知），绝不默认 main。
          identity: session?.sessionType,
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
        // T004：归档线程拒绝新的上下文变换派发（与 thread_archived 的
        // send / deliver 拒绝同源）——归档表达取消意图，不再发起接力。
        if (archive && typeof archive.isArchived === 'function'
          && await archive.isArchived(thread.threadId)) {
          return { applied: false, reason: 'thread_archived', threadId: thread.threadId };
        }
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
     * 会话接力钩子（提交点）：successor 生成且 Runtime READY 后调用。
     * fromSessionId 是线程当前 head 时推进 head（endKind 记录接力原因），
     * 随后把接力期间暂存的 pending 指令投递给新 head runtime。
     * 非 head / 无线程（纯 session）：静默跳过（no-op）。
     *
     * T002：applied=false 分两类——
     *   - void（并发/幂等场景，线程状态已是权威，不记失败）：
     *     head_mismatch / already_head / duplicate_session / thread_closed；
     *   - 失败（T001 身份门：session_workspace_mismatch /
     *     thread_identity_mismatch / thread_identity_missing /
     *     session_already_in_thread，及其它异常）：记 rotation_failed +
     *     错误 code 作 stage，并显式收敛挡板（不靠 stale TTL）。
     */
    async applySessionSuccession({ agentId, fromSessionId, toSessionId, reason = 'manual' }) {
      const normalizedAgentId = String(agentId || '').trim();
      const from = String(fromSessionId || '').trim();
      const to = String(toSessionId || '').trim();
      if (!from || !to || from === to) return { applied: false, reason: 'invalid_succession' };

      const VOID_ADVANCE_CODES = new Set([
        'head_mismatch', 'already_head', 'duplicate_session', 'thread_closed',
      ]);
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

        // 投递暂存指令（successor READY 门禁在提交点上游，thread-succession.js）
        const delivery = await core.deliverPendingCommands(thread.threadId);
        return { applied: true, thread: advanced, delivery };
      } catch (error) {
        if (error instanceof ThreadNotFoundError) {
          return { applied: false, reason: 'thread_not_found' };
        }
        // void 判定先行：这些 code 意味着线程状态已是权威（并发操作已提交
        // head_mismatch/already_head/duplicate_session，或线程已终态
        // thread_closed）——本操作幂等作废，不记失败、不动挡板。
        if (VOID_ADVANCE_CODES.has(error.code)) {
          return { applied: false, reason: error.code };
        }
        if (!thread) {
          // 无 thread 上下文的异常（理论不可达，findThreadByHeadSession
          // 未命中已提前返回）：记录失败但不触碰线程记录。
          console.error(`[thread-integration] succession failed ${from} -> ${to} (no thread):`, error?.message || error);
          return { applied: false, reason: 'handoff_failed', stage: error.code || 'advance_head', error: error?.message || String(error) };
        }
        console.error(`[thread-integration] succession failed ${from} -> ${to}:`, error?.message || error);
        // T002：失败阶段取 T001 身份门错误 code（稳定词汇），stage 落盘供
        // 审计与重启收敛透传；挡板显式收敛（旧 head 继续有效，见
        // thread-succession.abortPendingSuccession）。
        const stage = error.code || 'advance_head';
        const failed = await core.failSessionHandoff(thread.threadId, {
          reason: 'handoff_failed',
          stage,
          error: error?.message || String(error),
        }).catch(() => null);
        if (failed) {
          await abortPendingSuccession(core, thread.threadId, {
            stage,
            reason: 'handoff_failed',
            error: error?.message || String(error),
          }).catch((failure) => {
            console.error('[thread-integration] failed to converge handoff barrier:', failure?.message || failure);
          });
        }
        return { applied: false, reason: 'handoff_failed', stage, error: error?.message || String(error), thread: failed };
      }
    },

    /**
     * 交接失败钩子：把上下文交接停在明确的 rotation_failed，落盘失败
     * 阶段（stage）与原因，并显式收敛 pendingSuccession 挡板（T002）。
     *
     * 挡板收敛（abortPendingSuccession）：失败后交接窗口即结束，「旧 head
     * 继续有效」（ADR-001 §2）——pending 指令回到正常投递判定（旧 head
     * runtime 就绪时投递），不再被 handoff_in_progress 挡到 stale TTL
     * 过期。失败阶段 / 原因保留在 lifecycleEvents（handoff_failed +
     * handoff_aborted），审计不丢失。纯 session 会话（无线程）：no-op。
     */
    async failSessionSuccession({ agentId, sessionId, reason = 'handoff_failed', stage = 'unknown', error = null }) {
      const normalizedAgentId = String(agentId || '').trim();
      const from = String(sessionId || '').trim();
      if (!from) return { applied: false, reason: 'invalid_session' };
      try {
        const thread = await core.findThreadByHeadSession(normalizedAgentId, from);
        if (!thread) return { applied: false, reason: 'no_thread_for_session' };
        // 已关闭线程不再写失败事实（closeThread 已取消 pending 指令，
        // 翻回 rotation_failed 会「复活」终态线程）：直接 no-op。
        if (thread.status === 'closed') {
          return { applied: false, reason: 'thread_closed', threadId: thread.threadId };
        }
        const failed = await core.failSessionHandoff(thread.threadId, { reason, stage, error });
        await abortPendingSuccession(core, thread.threadId, { stage, reason, error });
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
        await board.closeBoard(thread.threadId, { reason: 'head_session_deleted' }).catch(() => {});
        await archive?.unarchive(thread.threadId).catch(() => {});
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
