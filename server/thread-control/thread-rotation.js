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
 *   3. compactAndResumeCurrentSession：trim-transcript + 摘要 + 启动 successor
 *      （compact / summary / trim 共享的 successor 创建入口）；
 *   4. commitSuccession：接力提交点（thread-succession.js）——successor
 *      READY 才推进线程 head 并投递暂存指令，READY 失败落
 *      successor_runtime_not_ready；
 *   5. 追加接力恢复指令并投递给新 head。
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
 * 失败路径（T002）：退役旧 runtime，线程标记 rotation_failed 并落失败
 * 阶段（compact_or_successor / successor_runtime_not_ready 等）+ 挡板
 * 显式收敛；旧 head 保持有效，pending 工作归属不丢失，不重放原始指令。
 *
 * 依赖由 server.js 注入（sessionApi / stopManagedAgent）；线程侧只依赖
 * threadControl（core + board 装配，见 thread-controller.js）、
 * threadIntegration 与 threadSuccession（共享提交点），
 * 不含任何上层产品语义。
 */

import { isSuccessionGateFailure } from './thread-integration.js';
import { cleanSessionText } from '../shared/string-helpers.js';

export function createThreadRotationService({
  sessionApi,
  stopManagedAgent,
  threadIntegration,
  threadControl,
  threadSuccession,
} = {}) {
  if (!sessionApi || typeof sessionApi.updateSessionIndex !== 'function'
    || typeof sessionApi.compactAndResumeCurrentSession !== 'function'
    || typeof stopManagedAgent !== 'function' || !threadIntegration || !threadControl) {
    throw new Error('createThreadRotationService requires session and thread dependencies');
  }
  const threadCore = threadControl.core;
  // T002：commit 走共享提交点；未注入（旧装配/测试 stub）时保持既有
  // apply/fail 路径，行为不变。
  const commitHead = threadSuccession && typeof threadSuccession.commitSuccession === 'function'
    ? threadSuccession.commitSuccession.bind(threadSuccession)
    : null;
  const failHandoff = threadSuccession && typeof threadSuccession.failSuccession === 'function'
    ? threadSuccession.failSuccession.bind(threadSuccession)
    : null;

  /** 同一 session 的接力防重入（guard 事件可能随 call 结束多次上报） */
  const inflight = new Map();

  async function rotate(agentId, sessionId) {
    const thread = await threadCore.findThreadByHeadSession(agentId, sessionId);
    if (!thread || thread.status === 'closed') return null;
    // T005：删除中的线程不启动接力（与 integration.beginSessionSuccession /
    // succession.commitSuccession 的 thread_deleting 预检同源）。deleting
    // 窗口（begin 后 / seal 前）线程未 closed，若此处放行会启动接力并
    // 产生孤儿 successor。
    if (thread.deleting === true) return null;

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
      if (!nextSessionId) {
        throw Object.assign(
          new Error('Trim compaction did not create a successor session'),
          { code: 'compact_or_successor' },
        );
      }
      // T002 接力提交点：successor READY（result.agent 为 ready 证据）
      // 之前不得成为有效 head；失败由提交点落阶段与原因。
      const commit = commitHead
        ? await commitHead({
          agentId,
          fromSessionId: sessionId,
          toSessionId: nextSessionId,
          reason: 'trim',
          successorReady: result?.agent != null,
        })
        : await threadIntegration.applySessionSuccession({
          agentId,
          fromSessionId: sessionId,
          toSessionId: nextSessionId,
          reason: 'trim',
        });
      if (!commit.applied) {
        // 提交失败（未 READY / 身份门 / 并发 void）：线程未推进，本棒
        // 不追加恢复指令、不做补投递——pending 工作归属留在旧 head。
        // 旧 runtime 上下文已过阈值（且触发器已一次性消耗），同样退役：
        // 与生成阶段失败同语义，留着只会接收注定超限的后续投递。
        await stopManagedAgent(agentId, sessionId).catch(() => {});
        return {
          applied: false,
          threadId: thread.threadId,
          reason: commit.reason || 'handoff_failed',
          stage: commit.stage,
          error: commit.error || 'succession commit was not applied',
        };
      }
      // 恢复指令由框架 beginSessionHandoff 在 begin 时同笔播种（R3），
      // 提交点只负责推进 head 与补投递，不再二次追加。
      await threadIntegration.tryDeliver(thread.threadId);
      return { applied: true, threadId: thread.threadId, headSessionId: nextSessionId };
    } catch (error) {
      // 接力失败时同样退役旧 runtime：其上下文已过阈值且触发器已一次性
      // 消耗，留着只会接收注定超限的后续投递。
      await stopManagedAgent(agentId, sessionId).catch(() => {});
      // T002：失败阶段取错误 code（生成阶段 compact_or_successor 等），
      // 经共享失败收敛落盘并收敛挡板。
      const stage = error.code || 'compact_or_successor';
      const failCall = failHandoff
        ? failHandoff({
          agentId,
          fromSessionId: sessionId,
          reason: 'context_rotation_failed',
          stage,
          error: error instanceof Error ? error.message : String(error),
        })
        : threadIntegration.failSessionSuccession({
          agentId,
          sessionId,
          reason: 'context_rotation_failed',
          stage,
          error: error instanceof Error ? error.message : String(error),
        });
      await failCall.catch((failure) => {
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
