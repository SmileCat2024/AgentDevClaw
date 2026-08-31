/**
 * Thread Succession — 上下文接力的共享提交点与失败收敛（T002）
 *
 * 把「生成 successor」与「提交 Thread 新 head」分成两个阶段：
 *   prepare: beginSessionSuccession（落盘 pendingSuccession 挡板）
 *            → createCompactedResumeFromHandoff（compact / summary / trim
 *              共享的 successor 创建入口：handoff + successor 会话 + runtime
 *              启动 + READY 等待，产出 ready 证据 result.agent）
 *   commit:  commitSuccession —— 唯一提交点。successor 身份正确（T001 身份
 *            门经 advanceHead 事务内校验）+ Runtime READY + 接力材料完整时
 *            才原子推进 head（旧 head 退历史、挡板清除同盘落盘），随后投递
 *            接力期间积累的 command。
 *   fail:    failSuccession —— Thread 不推进 head；记录失败阶段（stage）与
 *            原因（reason/error）；挡板显式收敛（abortPendingSuccession），
 *            不靠框架 stale TTL 被动过期；successor 会话保留供审计（不进
 *            线程链），其执行产物（runtime）按需清理。
 *
 * compact / summary / trim 以及 context guard 自动轮换（thread-rotation）
 * 全部经本模块提交；各路径不再各自拼装 begin / apply / fail。
 *
 * 重启恢复（convergeInterruptedSuccessions）按落盘状态收敛：
 * pendingSuccession 非空即「prepare 完成、commit 未完成」——挡板与 head
 * 推进在框架 advanceHead 内同盘原子清除，head 已推进则挡板必为 null，
 * 所以这是进程级事实判定，与时间（TTL）无关。崩溃残留显式记为
 * rotation_failed 并收敛挡板；旧 head 无法承接（会话缺失 / 身份未知）时
 * pending 指令标记 failed（归属留在记录里），不投向未知目标、不留永久
 * 挡板。框架 stale 惰性清除保留为未知残留的最后兜底，不再是主收敛路径。
 *
 * 失败阶段（stage）词汇（稳定 code，审计与前端消费）：
 *   - compact_or_successor        生成阶段：handoff 导出 / handoff 损坏 /
 *                                 successor 创建 / 未产生 successor 会话
 *   - successor_runtime_not_ready 提交阶段：successor runtime 未达 READY
 *   - thread_identity_mismatch / session_workspace_mismatch /
 *     session_already_in_thread / thread_identity_missing
 *                                 提交阶段：T001 身份门（框架错误 code 透传）
 *   - commit_not_reached          重启收敛：崩溃于 prepare 之后、commit 之前
 *   - 其余阶段值透传落盘 pendingSuccession.stage
 */

const LIFECYCLE_EVENT_CAP = 200;

/**
 * 显式收敛已结束的交接窗口（纯逻辑，作用于注入的 core 实例）。
 *
 * 调用方必须先经 failSessionHandoff 落 rotation_failed（失败事实 + stage），
 * 本函数只负责清除 pendingSuccession 挡板并记录 handoff_aborted 事件：
 *   - 失败意味着交接窗口已结束，「旧 head 继续有效」（ADR-001 §2）；
 *   - 挡板清除后 pending 指令回到正常投递判定（旧 head runtime 就绪时投递，
 *     未就绪保持 pending 等待 runtime-ready 触发点），不再被
 *     handoff_in_progress 挡到 stale 过期；
 *   - stage / reason / error 事实保留在 lifecycleEvents（handoff_failed +
 *     handoff_aborted），审计不丢失。
 *
 * @param {import('@agentdevjs/core').WorkThread} core
 * @param {string} threadId
 * @param {{ stage?: string, reason?: string, error?: unknown }} [meta]
 */
export async function abortPendingSuccession(core, threadId, {
  stage = 'unknown',
  reason = 'handoff_failed',
  error = null,
} = {}) {
  const { record } = await core.store.update(threadId, (draft) => {
    if (!draft.pendingSuccession) return draft;
    draft.pendingSuccession = null;
    // 兜底：failSessionHandoff 未落成功（记录异常）时 status 仍是 rotating，
    // 显式落回 open——失败事实由 handoff_aborted 事件承载，不让线程永远
    // 停在「接力中」。
    if (draft.status === 'rotating') draft.status = 'open';
    const event = {
      type: 'handoff_aborted',
      status: draft.status,
      at: Date.now(),
      stage,
      reason,
    };
    if (error != null) event.error = String(error);
    draft.lifecycleEvents = Array.isArray(draft.lifecycleEvents) ? draft.lifecycleEvents : [];
    draft.lifecycleEvents.push(event);
    if (draft.lifecycleEvents.length > LIFECYCLE_EVENT_CAP) {
      draft.lifecycleEvents.splice(0, draft.lifecycleEvents.length - LIFECYCLE_EVENT_CAP);
    }
    draft.lastLifecycleEvent = event;
    return draft;
  });
  return record;
}

/**
 * 接力提交点与失败收敛服务（compact / summary / trim / rotation 共享）。
 *
 * @param {object} deps
 * @param {{ core: import('@agentdevjs/core').WorkThread }} deps.threadControl
 * @param {{ applySessionSuccession: Function, failSessionSuccession: Function }} deps.threadIntegration
 * @param {Function} [deps.stopManagedAgent] - 退役失败 successor 的 runtime（生产装配注入）
 */
export function createThreadSuccessionService({
  threadControl,
  threadIntegration,
  stopManagedAgent = null,
} = {}) {
  if (!threadControl?.core || !threadIntegration
    || typeof threadIntegration.applySessionSuccession !== 'function'
    || typeof threadIntegration.failSessionSuccession !== 'function') {
    throw new Error('createThreadSuccessionService requires threadControl and threadIntegration');
  }
  const core = threadControl.core;

  /**
   * 定位提交目标线程（T004 归档预检用）：from 是 head 时命中快路径；
   * head 已被并发推进时按成员链兜底。纯 session（无线程）返回 null。
   */
  async function findThreadForSuccession(agentId, fromSessionId) {
    const byHead = await core.findThreadByHeadSession(agentId, fromSessionId).catch(() => null);
    if (byHead) return byHead;
    return core.findThreadBySession(agentId, fromSessionId).catch(() => null);
  }

  /**
   * 提交点：successor 生成成功后调用，决定是否推进 Thread head。
   *
   * 门禁（实施要求 1）：successorReady 为假（runtime 未达 READY）时拒绝
   * 提交——successor 在 READY 之前不得成为有效 head；旧 head 保持有效，
   * 失败阶段 successor_runtime_not_ready 落盘。
   *
   * head 推进本身（旧 head 退历史 + 挡板原子清除 + 身份门）在
   * integration.applySessionSuccession → 框架 advanceHead 事务内完成；
   * 身份门失败（T001 code）由该层记录失败并收敛挡板，本层透传结果。
   *
   * @returns {{applied: boolean, reason?: string, stage?: string, thread?: object, delivery?: object, error?: string}}
   */
  async function commitSuccession({
    agentId,
    fromSessionId,
    toSessionId,
    reason = 'manual',
    successorReady,
  }) {
    const normalizedAgentId = String(agentId || '').trim();
    const from = String(fromSessionId || '').trim();
    const to = String(toSessionId || '').trim();
    if (!normalizedAgentId || !from || !to || from === to) {
      return { applied: false, reason: 'invalid_succession' };
    }

    // T004 冲突响应（与归档并发）：归档标记先落时，succession 提交被拒绝——
    // head 不推进、旧 Inbox 不投递（seal 事务已取消全部 pending + hold
    // 阻塞补投），失败 successor 退役，挡板收敛并留 rotation_failed 审计。
    // 两种时序都收敛：commit 在前则归档 seal 取消剩余 pending；归档在前
    // 则此处预检拒绝，successor 不会消费旧 Inbox。
    const threadForCommit = await findThreadForSuccession(normalizedAgentId, from);

    // T004 冲突响应（与归档并发）：归档标记先落时，succession 提交被拒绝——
    // head 不推进、旧 Inbox 不投递（seal 事务已取消全部 pending + hold
    // 阻塞补投），失败 successor 退役，挡板收敛并留 rotation_failed 审计。
    // 两种时序都收敛：commit 在前则归档 seal 取消剩余 pending；归档在前
    // 则此处预检拒绝，successor 不会消费旧 Inbox。
    if (threadForCommit && threadControl.archive && typeof threadControl.archive.isArchived === 'function'
      && await threadControl.archive.isArchived(threadForCommit.threadId)) {
      const failure = await failSuccession({
        agentId: normalizedAgentId,
        fromSessionId: from,
        reason: 'thread_archived',
        stage: 'thread_archived',
        error: `thread ${threadForCommit.threadId} is archived; succession commit refused`,
        successorSessionId: to,
        retireSuccessorRuntime: true,
      });
      return {
        applied: false,
        reason: 'thread_archived',
        stage: 'thread_archived',
        thread: failure.thread || null,
        error: failure.error || `thread ${threadForCommit.threadId} is archived; succession commit refused`,
      };
    }

    // T005 冲突响应（与删除并发）：deleting 窗口（begin 后 / seal 前）线程
    // 未 closed，框架 advanceHead 不拒绝——提交点显式拒绝，避免删除期间
    // 提交新 successor 产生成员集合之外的孤儿会话。deleting 标记是入口层
    // 事实（与 routes 的 _assertNotDeleting / input-gateway 的 thread_deleting
    // 同源）；seal 后线程 closed，框架 terminal 判定天然拒绝。
    if (threadForCommit && threadForCommit.deleting === true) {
      const failure = await failSuccession({
        agentId: normalizedAgentId,
        fromSessionId: from,
        reason: 'thread_deleting',
        stage: 'thread_deleting',
        error: `thread ${threadForCommit.threadId} is being deleted; succession commit refused`,
        successorSessionId: to,
        retireSuccessorRuntime: true,
      });
      return {
        applied: false,
        reason: 'thread_deleting',
        stage: 'thread_deleting',
        thread: failure.thread || null,
        error: failure.error || `thread ${threadForCommit.threadId} is being deleted; succession commit refused`,
      };
    }

    if (!successorReady) {
      // READY 门禁：提交被拒绝。successor 会话保留供审计（不进线程链），
      // 其半启动的 runtime 退役（执行产物清理，session 文件不动）。
      const failure = await failSuccession({
        agentId: normalizedAgentId,
        fromSessionId: from,
        reason: 'successor_runtime_not_ready',
        stage: 'successor_runtime_not_ready',
        error: 'successor runtime did not reach READY before the succession commit point',
        successorSessionId: to,
        retireSuccessorRuntime: true,
      });
      return {
        applied: false,
        reason: 'successor_not_ready',
        stage: 'successor_runtime_not_ready',
        thread: failure.thread || null,
        error: failure.error || 'successor runtime did not reach READY before the succession commit point',
      };
    }

    const outcome = await threadIntegration.applySessionSuccession({
      agentId: normalizedAgentId,
      fromSessionId: from,
      toSessionId: to,
      reason,
    });
    if (!outcome.applied) {
      // 两种「非失败」的 applied:false 透传：
      //   - no_thread_for_session / thread_not_found：纯 session 会话（无线程）
      //     或线程已不存在——no-op，与未接入线程时行为一致；
      //   - 操作级 void（head_mismatch / already_head / duplicate_session /
      //     thread_closed）：并发接力中另一操作已提交、或线程已终态——
      //     线程状态已是权威，本操作幂等作废，不记失败。
      // 线程级失败（T001 身份门等）已由 applySessionSuccession 内部记录
      // rotation_failed + stage 并收敛挡板，结果带 stage 透传。
      return outcome;
    }
    return outcome;
  }

  /**
   * 失败收敛：Thread 不推进 head，落盘失败阶段与原因，显式收敛挡板。
   * 由 commitSuccession 的 READY 门禁、rotation / 路由的生成阶段失败、
   * 以及重启恢复共用。
   *
   * @returns {Promise<{applied: boolean, thread?: object, threadId?: string, reason?: string, error?: string}>}
   */
  async function failSuccession({
    agentId,
    fromSessionId,
    reason = 'handoff_failed',
    stage = 'unknown',
    error = null,
    successorSessionId = null,
    retireSuccessorRuntime = false,
  }) {
    const normalizedAgentId = String(agentId || '').trim();
    const from = String(fromSessionId || '').trim();
    if (!normalizedAgentId || !from) return { applied: false, reason: 'invalid_session' };

    // 失败 successor 的执行产物清理：runtime 退役（可能未启动，no-op 安全）；
    // session 文件保留供审计，不删除、不标记、不静默改身份。
    if (retireSuccessorRuntime && successorSessionId && typeof stopManagedAgent === 'function') {
      await stopManagedAgent(normalizedAgentId, successorSessionId).catch(() => {});
    }

    const outcome = await threadIntegration.failSessionSuccession({
      agentId: normalizedAgentId,
      sessionId: from,
      reason,
      stage,
      error,
    });
    return outcome;
  }

  return { commitSuccession, failSuccession, core };
}

/**
 * 重启恢复服务：按落盘状态收敛被进程崩溃打断的接力（T002 实施要求 5）。
 *
 * 判定是状态判定，不是时间判定：pendingSuccession 非空 = prepare 完成、
 * commit 未完成（挡板与 head 推进同盘原子，head 已推进则挡板必为 null）。
 * 无论交接意图 startedAt 是否「新鲜」（刚崩溃时必然新鲜，靠 TTL 要多等
 * 5 分钟），重启后立即显式收敛：
 *   - 旧 head 可承接（身份解析成功）→ rotation_failed(stage 透传崩溃点) +
 *     挡板收敛；pending 指令保留，旧 head runtime 就绪时经既有
 *     runtime-ready 触发点补投（状态驱动，不重复投递）；
 *   - 旧 head 无法承接（会话缺失 / 身份未知）→ pending 指令标记 failed
 *     （lastReason 留痕），不投向未知目标、不留永久挡板。
 *
 * @param {object} deps
 * @param {{ core: import('@agentdevjs/core').WorkThread }} deps.threadControl
 * @param {Function} [deps.identitySource] - 会话身份真相源（与 control 装配同源）；
 *   缺省时所有 head 视为不可承接（保守收敛）
 */
export function createThreadRecoveryService({ threadControl, identitySource = null } = {}) {
  if (!threadControl?.core) {
    throw new Error('createThreadRecoveryService requires threadControl');
  }
  const core = threadControl.core;

  /**
   * 扫描全部线程记录，收敛「交接进行中」的崩溃残留。
   * @returns {Promise<{examined: number, converged: Array<object>, skipped: Array<object>}>}
   */
  async function convergeInterruptedSuccessions() {
    const summaries = await core.listThreads();
    const report = { examined: 0, converged: [], skipped: [] };

    for (const summary of summaries) {
      const record = await core.getThread(summary?.threadId).catch(() => null);
      if (!record) {
        report.skipped.push({ threadId: summary?.threadId || null, reason: 'record_unreadable' });
        continue;
      }
      report.examined += 1;
      if (record.status === 'closed' || !record.pendingSuccession) continue;

      const pending = record.pendingSuccession;
      const interruptedStage = (pending.stage && pending.stage !== 'started')
        ? pending.stage
        : 'commit_not_reached';
      const headIdentity = identitySource
        ? await identitySource(record.agentId, record.headSessionId).catch(() => null)
        : null;
      const headUsable = Boolean(headIdentity);
      const reason = headUsable ? 'restart_convergence' : 'head_session_missing';

      const detail = headUsable
        ? 'process restarted before the succession commit; old head remains authoritative'
        : 'head session is missing or has no identity fact; pending commands cannot be delivered';

      try {
        if (!headUsable) {
          // 旧 head 无法承接：pending 指令的目标是未知会话，显式 failed
          // （归属留在记录里：lastReason），永不投向未知目标、永不清除。
          await core.store.update(record.threadId, (draft) => {
            const now = Date.now();
            for (const command of draft.commands || []) {
              if (command.status === 'pending') {
                command.status = 'failed';
                command.lastReason = 'head_session_missing';
                command.attempts = (Number(command.attempts) || 0) + 1;
                command.updatedAt = now;
              }
            }
            return draft;
          });
        }
        // 失败事实先落盘（rotation_failed + handoff_failed 事件带 stage），
        // 再收敛挡板（head 未推进、交接窗口已结束的显式语义）。
        await core.failSessionHandoff(record.threadId, {
          reason,
          stage: interruptedStage,
          error: detail,
        });
        await abortPendingSuccession(core, record.threadId, {
          stage: interruptedStage,
          reason,
          error: detail,
        });
        report.converged.push({
          threadId: record.threadId,
          stage: interruptedStage,
          reason,
          headSessionId: record.headSessionId,
        });
      } catch (error) {
        // 单线程收敛失败不阻断其余线程；残留如实报告，不伪装为成功。
        report.skipped.push({ threadId: record.threadId, reason: String(error?.message || error) });
      }
    }
    return report;
  }

  return { convergeInterruptedSuccessions };
}
