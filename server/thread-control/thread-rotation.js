/**
 * Thread Rotation — 线程宿主的上下文接力执行器
 *
 * context guard 触发（会话上下文到达阈值、runtime 进入阻断态）后，
 * 由被阻断的会话定位其所属线程并执行 trim+摘要接力：
 *   1. beginSessionSuccession：写入交接意图，接力期间新指令保持 pending；
 *   2. 退役旧 head runtime：guard 已将其置于阻断态（内存仲裁拒绝一切
 *      输入），留着只是僵尸会话；更重要的是 remove-session 会让 runtime
 *      把最新会话状态 flush 落盘——摘要 mirror 读的是 session 文件，若不
 *      先 flush，会基于过期快照生成「没有实质性工作」的失真摘要；
 *   3. compactAndResumeCurrentSession：trim-transcript + 摘要 + 启动 successor；
 *   4. applySessionSuccession：推进线程 head 并投递暂存指令；
 *   5. 追加接力恢复指令并投递给新 head。
 *
 * 判定基准：被阻断会话是否为某活跃线程的 head（findThreadByHeadSession）。
 * 处于线程环境（thread）则触发接力；纯 session 会话无线程，天然 no-op。
 * 与 agent 归属哪个工作空间无关——「哪些 workspace 自动建线程」是
 * integration 层的环境策略（THREAD_HOST_AGENT_IDS），不在本层判定。
 *
 * 失败路径：退役旧 runtime、清除持久化 guard 标志、线程标记 rotation_failed，
 * 由线程恢复入口收拾残局（不重放原始指令）。
 *
 * 依赖由 server.js 注入（sessionApi / stopManagedAgent）；线程侧只依赖
 * threadControl（core + board 装配，见 thread-controller.js）与
 * threadIntegration，不含任何上层产品语义。
 */

import { cleanSessionText } from '../shared/string-helpers.js';

const ROTATION_RESUME_INSTRUCTION = [
  '上下文已精简接力。先检查当前工作树、已有变更、测试结果和上一棒摘要，',
  '确认哪些步骤已经完成；不要重复可能已有副作用的操作，然后继续当前任务。',
  '需要人工决策或无法安全判断时，明确说明原因。',
].join('');

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

  /**
   * 清除 session index 里持久化的守卫阻断标志。守卫阻断只在 runtime 内存里
   * 成立；runtime 停止或重启后它就变成谎言（UI 会一直显示输入被禁用）。
   */
  async function clearPersistedGuardState(agentId, sessionId) {
    try {
      await sessionApi.updateSessionIndex(agentId, (index) => ({
        ...index,
        sessions: index.sessions.map((record) => record.id === sessionId && record.contextGuard
          ? { ...record, contextGuard: null, updatedAt: new Date().toISOString() }
          : record),
      }));
    } catch (error) {
      console.warn(`[thread-rotation] failed to clear persisted guard state for session=${sessionId}:`, error?.message || error);
    }
  }

  async function rotate(agentId, sessionId) {
    const thread = await threadCore.findThreadByHeadSession(agentId, sessionId);
    if (!thread || thread.status === 'closed') return null;

    try {
      await threadIntegration.beginSessionSuccession({ agentId, sessionId, reason: 'trim' });
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
      await threadIntegration.applySessionSuccession({
        agentId,
        fromSessionId: sessionId,
        toSessionId: nextSessionId,
        reason: 'trim',
      });
      await clearPersistedGuardState(agentId, sessionId);
      await threadCore.appendCommand({
        threadId: thread.threadId,
        kind: 'system_continuation',
        text: ROTATION_RESUME_INSTRUCTION,
        source: 'thread-context-rotation',
        idempotencyKey: `thread-context-rotation-${thread.threadId}-${nextSessionId}`,
      });
      await threadIntegration.tryDeliver(thread.threadId);
      return { applied: true, threadId: thread.threadId, headSessionId: nextSessionId };
    } catch (error) {
      // 接力失败时旧 runtime 仍卡在守卫阻断态（内存仲裁拒绝一切输入）。
      // 不退役的话，后续投递会把指令发给一个永远拒绝输入的 runtime。
      await stopManagedAgent(agentId, sessionId).catch(() => {});
      await clearPersistedGuardState(agentId, sessionId);
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
