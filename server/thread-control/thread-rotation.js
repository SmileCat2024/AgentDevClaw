/**
 * Thread Rotation — 线程宿主的上下文接力执行器
 *
 * context-rotation-trigger 事件（会话上下文到达阈值并打断当前轮）后，
 * 由被触发的会话定位其所属线程并执行 trim+摘要接力：
 *   1. beginSessionSuccession：原子写入交接挡板并播种接续恢复指令（R3，
 *      框架 beginSessionHandoff 同笔事务，幂等键绑移交易）；接力期间
 *      新指令保持 pending；
 *   2. 退役旧 head runtime：remove-session 会让 runtime 把最新会话状态
 *      flush 落盘——摘要 mirror 读的是 session 文件，若不先 flush，
 *      会基于过期快照生成「没有实质性工作」的失真摘要；
 *   3. compactAndResumeCurrentSession：trim-transcript + 摘要 + 启动 successor；
 *   4. applySessionSuccession：推进线程 head 并投递暂存指令（含 1 播种
 *      的恢复指令）。
 *
 * 判定基准：被触发的会话是否为某活跃线程的 head（findThreadByHeadSession）。
 * 处于线程环境（thread）则触发接力；纯 session 会话无线程，天然 no-op。
 * 与 agent 归属哪个工作空间无关——「哪些 workspace 自动建线程」是
 * integration 层的环境策略（THREAD_HOST_AGENT_IDS），不在本层判定。
 *
 * 门禁消费（K11/A9）：begin 未立挡板（closed / held / 在办移交 / head 换代 /
 * 存储失败）时零副作用退出——不退役 runtime、不写 rotation_failed；挡板
 * 归在办移交或归档事务属主，本流程没有失败记录的立卷资格。apply 的
 * applied:false 已由 integration 侧落 rotation_failed（K3 守卫拦截迟到失败），
 * 此处只退役旧 runtime（触发器已一次性消耗）并如实上报。
 *
 * 失败路径：退役旧 runtime、线程标记 rotation_failed，
 * 由线程恢复入口收拾残局（不重放原始指令）。
 *
 * 依赖由 server.js 注入（sessionApi / stopManagedAgent）；线程侧只依赖
 * threadControl（core + board 装配，见 thread-controller.js）与
 * threadIntegration，不含任何上层产品语义。
 */

import { isSuccessionGateFailure } from './thread-integration.js';
import { cleanSessionText } from '../shared/string-helpers.js';

export function createThreadRotationService({
  sessionApi,
  stopManagedAgent,
  threadIntegration,
  threadControl,
} = {}) {
  if (!sessionApi || typeof sessionApi.updateSessionIndex !== 'function'
    || typeof sessionApi.compactAndResumeCurrentSession !== 'function'
    || typeof stopManagedAgent !== 'function' || !threadIntegration || !threadControl) {
    throw new Error('createThreadRotationService requires session and thread dependencies');
  }
  const threadCore = threadControl.core;

  /** 同一 session 的接力防重入（guard 事件可能随 call 结束多次上报） */
  const inflight = new Map();

  async function rotate(agentId, sessionId) {
    const thread = await threadCore.findThreadByHeadSession(agentId, sessionId);
    if (!thread || thread.status === 'closed') return null;

    const begun = await threadIntegration.beginSessionSuccession({ agentId, sessionId, reason: 'trim' });
    if (!begun?.applied) {
      // 挡板未立（gate 拒绝 / 无线程竞态 / 存储失败）：本流程未开始，
      // 零副作用退出。gate 场景在办状态归其属主，退役 runtime 或写
      // rotation_failed 都是对别人的移交/归档事务的破坏。
      return {
        applied: false,
        reason: isSuccessionGateFailure(begun) ? 'begin_rejected' : (begun?.reason || 'begin_rejected'),
        error: begun?.error || null,
      };
    }

    try {
      await stopManagedAgent(agentId, sessionId).catch((error) => {
        console.warn(`[thread-rotation] failed to retire pre-rotation runtime for session=${sessionId}:`, error?.message || error);
      });
      const result = await sessionApi.compactAndResumeCurrentSession({
        preferredAgentId: agentId,
        sessionId,
        // 混合精简：trim-transcript 保留裁剪后的对话主干（工具记录折叠），
        // appendSummary 走官方 summary 进程内实现，把摘要 system message
        // 追加到 seed 尾部（mode: trim-transcript-with-summary）。
        policy: { strategy: 'trim-transcript' },
        appendSummary: true,
        startRuntime: true,
      });
      const nextSessionId = cleanSessionText(result?.session?.id);
      if (!nextSessionId) throw new Error('Trim compaction did not create a successor session');
      const applied = await threadIntegration.applySessionSuccession({
        agentId,
        fromSessionId: sessionId,
        toSessionId: nextSessionId,
        reason: 'trim',
      });
      if (!applied?.applied) {
        // advanceHead 失败 / head 已被并发推进：integration 侧已按 K3 守卫
        // 语义落 rotation_failed（迟到失败 no-op），此处不重复写，只退役
        // 旧 runtime 并如实上报。
        await stopManagedAgent(agentId, sessionId).catch(() => {});
        return { applied: false, reason: 'apply_failed', error: applied?.error || applied?.reason || 'unknown' };
      }
      // 投递兜底：apply 内部已尝试过一次（integration），此处幂等重试覆盖
      // 「apply 时 runtime 未 ready、此刻已 ready」的窗口。
      await threadIntegration.tryDeliver(thread.threadId);
      return { applied: true, threadId: thread.threadId, headSessionId: nextSessionId };
    } catch (error) {
      // 接力失败时同样退役旧 runtime：其上下文已过阈值且触发器已一次性
      // 消耗，留着只会接收注定超限的后续投递。
      await stopManagedAgent(agentId, sessionId).catch(() => {});
      await threadIntegration.failSessionSuccession({
        agentId,
        sessionId,
        reason: 'context_rotation_failed',
        stage: 'compact_or_successor',
        error: error instanceof Error ? error.message : String(error),
      }).catch((failure) => {
        console.error('[thread-rotation] failed to persist rotation_failed:', failure?.message || failure);
      });
      return { applied: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * context guard 事件入口：被阻断的会话是某活跃线程的 head 时执行接力。
   * 纯 session 会话（无线程）：no-op，保持纯会话语义不变。
   */
  async function handleContextGuard(agentId, sessionId) {
    const normalizedAgentId = String(agentId || '').trim();
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedAgentId || !normalizedSessionId) return null;

    if (inflight.has(normalizedSessionId)) return inflight.get(normalizedSessionId);
    const task = rotate(normalizedAgentId, normalizedSessionId)
      .finally(() => inflight.delete(normalizedSessionId));
    inflight.set(normalizedSessionId, task);
    return task;
  }

  return { handleContextGuard };
}
