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
 * 运行期补充（convergePhantomRotating）：启动收敛被跳过或单线程收敛失败的
 * rotating 残留，由 rotation-registry 事实判定（记录 rotating + 本进程无
 * 编排在办 = 幽灵投影）周期收敛，无 TTL 等待窗口也不误杀慢接续。
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

import { readSessionIndex } from '../shared/session-access.js';
import { getRotationRegistry } from './rotation-registry.js';

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
  rotationRegistry = null,
} = {}) {
  if (!threadControl?.core || !threadIntegration
    || typeof threadIntegration.applySessionSuccession !== 'function'
    || typeof threadIntegration.failSessionSuccession !== 'function') {
    throw new Error('createThreadSuccessionService requires threadControl and threadIntegration');
  }
  const core = threadControl.core;
  // 在办登记（rotation-registry）：begin 由 integration 咽喉落，end 由本
  // 服务 commit / fail 终局的 finally 收（配对契约见 rotation-registry.js）。
  const registry = rotationRegistry || getRotationRegistry();

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
   * head 推进本身（旧 head 退历史 + 挡板原子清除 + 身份门 + 退役棒指令
   * 消费分类 + unresolved 持久化）在 integration.applySessionSuccession →
   * 框架 commitSessionSuccession 原子事务内完成；
   * 身份门失败（T001 code）由该层记录失败并收敛挡板，本层透传结果。
   *
   * @returns {{applied: boolean, reason?: string, stage?: string, thread?: object, delivery?: object, error?: string}}
   */
  async function commitSuccession(options) {
    // 终局 finally 注销在办登记（rotation-registry 配对契约）。finally 而非
    // 成功路径——记录级收敛写盘失败时登记也先释放，残留挡板交运行期幽灵
    // 扫描收敛，而不是与登记一起泄漏到 age 阀。
    const terminal = { threadId: null };
    try {
      return await runCommitSuccession(options, terminal);
    } finally {
      if (terminal.threadId) registry.end(terminal.threadId);
    }
  }

  async function runCommitSuccession({
    agentId,
    fromSessionId,
    toSessionId,
    reason = 'manual',
    successorReady,
    seedContinuation = true,
  }, terminal) {
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
    terminal.threadId = threadForCommit?.threadId || null;

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
      seedContinuation,
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
  /**
   * 失败收敛（编排方公共形态）：终局 finally 注销在办登记，语义同
   * commitSuccession 的包装层。
   */
  async function failSuccession(options) {
    const terminal = { threadId: null };
    try {
      return await runFailSuccession(options, terminal);
    } finally {
      if (terminal.threadId) registry.end(terminal.threadId);
    }
  }

  async function runFailSuccession({
    agentId,
    fromSessionId,
    reason = 'handoff_failed',
    stage = 'unknown',
    error = null,
    successorSessionId = null,
    retireSuccessorRuntime = false,
  }, terminal) {
    const normalizedAgentId = String(agentId || '').trim();
    const from = String(fromSessionId || '').trim();
    if (!normalizedAgentId || !from) return { applied: false, reason: 'invalid_session' };
    terminal.threadId = (await findThreadForSuccession(normalizedAgentId, from))?.threadId || null;

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
 * 重启恢复服务：按落盘状态收敛被进程崩溃打断的接力（T002 实施要求 5），
 * 并提供运行期幽灵挡板扫描（rotation-registry 事实判定）。
 *
 * 启动收敛（convergeInterruptedSuccessions）判定是状态判定，不是时间判定：
 * pendingSuccession 非空 = prepare 完成、commit 未完成（挡板与 head 推进
 * 同盘原子，head 已推进则挡板必为 null）。无论交接意图 startedAt 是否
 * 「新鲜」（刚崩溃时必然新鲜，靠 TTL 要多等 5 分钟），重启后立即显式收敛：
 *   - 旧 head 可承接（身份解析成功）→ rotation_failed(stage 透传崩溃点) +
 *     挡板收敛；pending 指令保留，旧 head runtime 就绪时经既有
 *     runtime-ready 触发点补投（状态驱动，不重复投递）；
 *   - 旧 head 无法承接（会话缺失 / 身份未知）→ pending 指令标记 failed
 *     （lastReason 留痕），不投向未知目标、不留永久挡板。
 *
 * 运行期扫描（convergePhantomRotating）覆盖启动收敛之外的第二类残留：
 * 启动收敛被整体跳过（listThreads 瞬时失败等）或单线程收敛失败后，崩溃
 * 残留的 rotating 记录没有任何后续收敛触发点——投递被 handoff_in_progress
 * 门禁挡住、输入路径按 rotating 跳过 head 唤醒、前端按设计不设本地时间窗，
 * 用户消息滞留锁定气泡等待一个不存在的接续。判定的权威是进程内在办登记
 * （rotation-registry）：记录 rotating + 无在办编排 = 幽灵投影，立即收敛
 * （无 TTL 等待）；真实接续登记在册，跑多久都不误杀。
 *
 * @param {object} deps
 * @param {{ core: import('@agentdevjs/core').WorkThread, resolveSessionViewerId?: Function }} deps.threadControl
 * @param {ReturnType<import('./rotation-registry.js').createRotationRegistry>} [deps.rotationRegistry]
 * @param {Function} [deps.getEnsureHeadRuntime] head runtime 就绪闸的惰性取用
 *        （server.js 侧 ensureHeadRuntime 定义晚于本 service 构造，经 getter
 *        注入规避 TDZ）。运行期滞留 pending 兜底扫描（requeueStalledPendingThreads）用。
 */
export function createThreadRecoveryService({
  threadControl,
  rotationRegistry = null,
  getEnsureHeadRuntime = null,
  getForceDeliver = null,
  getHeadIdentityAdopter = null,
} = {}) {
  if (!threadControl?.core) {
    throw new Error('createThreadRecoveryService requires threadControl');
  }
  const core = threadControl.core;
  const registry = rotationRegistry || getRotationRegistry();

  /**
   * head 会话存在性检查：崩溃残留收敛只关心「旧 head 会话是否仍可承接」，
   * 直查会话索引（ADR-0025：会话身份不再是判定维度）。
   */
  async function headSessionResolvable(agentId, sessionId) {
    try {
      const index = await readSessionIndex(agentId);
      return (index.sessions || []).some((s) => String(s?.id || '').trim() === sessionId);
    } catch {
      return false;
    }
  }

  /**
   * 单线程收敛核心（启动收敛与运行期幽灵扫描共用）：
   *   1. head 不可承接时 pending 指令显式 failed（归属留痕，不投未知目标）；
   *   2. 失败事实先落盘（rotation_failed + handoff_failed 事件带 stage）；
   *   3. 挡板显式收敛（abortPendingSuccession，head 未推进、交接窗口已
   *      结束的显式语义，不靠框架 stale TTL 被动过期）；
   *   4. 在办登记注销（若仍有残留——收敛即终局）。
   *
   * @param {object} record - 已确认含 pendingSuccession 的线程记录
   * @param {{ sweepReason: string, sweepDetail: string }} sweep - head 可承接
   *        时的收敛原因与说明（启动收敛与运行期扫描各有可区分的审计词汇）
   */
  async function convergeInterruptedThread(record, { sweepReason, sweepDetail }) {
    const pending = record.pendingSuccession;
    const interruptedStage = (pending.stage && pending.stage !== 'started')
      ? pending.stage
      : 'commit_not_reached';
    const headUsable = await headSessionResolvable(record.agentId, record.headSessionId);
    const reason = headUsable ? sweepReason : 'head_session_missing';
    const detail = headUsable
      ? sweepDetail
      : 'head session is missing or has no identity fact; pending commands cannot be delivered';

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
    registry.end(record.threadId);
    return {
      threadId: record.threadId,
      stage: interruptedStage,
      reason,
      headSessionId: record.headSessionId,
    };
  }

  /**
   * 扫描全部线程记录，收敛「交接进行中」的崩溃残留（启动态：进程刚起，
   * 任何在办登记都不可能存在，全部按落盘状态判定）。
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

      try {
        report.converged.push(await convergeInterruptedThread(record, {
          sweepReason: 'restart_convergence',
          sweepDetail: 'process restarted before the succession commit; old head remains authoritative',
        }));
      } catch (error) {
        // 单线程收敛失败不阻断其余线程；残留如实报告，不伪装为成功。
        report.skipped.push({ threadId: record.threadId, reason: String(error?.message || error) });
      }
    }
    return report;
  }

  /**
   * 运行期幽灵挡板扫描：status='rotating' 但本进程无编排在办
   * （rotation-registry 事实判定）→ 投影失去事实，立即收敛。
   *
   * 与启动收敛的分工：启动态（进程刚起）全部 rotating 都是幽灵，走状态
   * 判定；运行期以登记为准——真实接续（慢摘要 LLM 等）不受打扰，这是与
   * 时间判定（框架 HANDOFF_STALE_MS 惰性清除）的本质区别。
   *
   * 范围只认 status='rotating'：rotation_failed + 挡板残留（fail 落盘后、
   * abort 前崩溃）属启动收敛的范围，运行期不碰——避免与并发重试接续
   * （begin 会先把 status 转回 rotating）竞态误清。
   *
   * @returns {Promise<{examined: number, converged: Array<object>, skipped: Array<object>}>}
   */
  async function convergePhantomRotating() {
    const summaries = await core.listThreads();
    const report = { examined: 0, converged: [], skipped: [] };

    for (const summary of summaries) {
      // 摘要预筛：非 rotating 无幽灵可能（终态 / 失败态 / 正常态都已有
      // 权威状态），摘要携带 status，只读索引不触记录文件——健康线程
      // 零记录级开销，扫描可以高频跑。
      if (String(summary?.status || '') !== 'rotating') continue;
      const threadId = String(summary?.threadId || '').trim();
      if (!threadId) continue;
      // 真实编排在办：投影与事实一致，不动。
      if (registry.isActive(threadId)) continue;

      const record = await core.getThread(threadId).catch(() => null);
      if (!record) {
        report.skipped.push({ threadId, reason: 'record_unreadable' });
        continue;
      }
      if (record.status !== 'rotating' || !record.pendingSuccession) continue;
      // 写前复核（登记复查）：读记录期间可能有并发 begin 落新挡板并登记
      // ——此时不是幽灵，留给下一轮扫描按登记判定。
      if (registry.isActive(threadId)) continue;

      report.examined += 1;
      try {
        report.converged.push(await convergeInterruptedThread(record, {
          sweepReason: 'phantom_rotation_sweep',
          sweepDetail: 'no in-process rotation orchestration is active; the persisted rotating status is a phantom barrier left by an interrupted run',
        }));
      } catch (error) {
        // 单线程收敛失败不阻断扫描；残留如实报告，下一轮扫描重试。
        report.skipped.push({ threadId, reason: String(error?.message || error) });
      }
    }
    return report;
  }

  // 滞留 pending 运行期兜底（C 修复）：唤醒/补投链任何一环反复失败（共享
  // 进程 add-session 超时+对账前错位、拉起崩溃等）都会让线程 pending 指令
  // 无限暂存——前端表现为「已暂存，等接续后自动继续」永久挂起，与接续无关。
  // 本扫描对「pending 滞留超阈值」的线程行动，按宿主侧条目事实分流：
  //   - 条目缺位：ensureHeadRuntime → add-session 加入；若 runtime 侧会话
  //     早已就绪（历史错位），already-exists 对账路径会重建宿主记录，随后
  //     runtime-ready 补投既有机制自然完成投递。
  //   - 条目在位：不再无条件跳过（构造性复现钉住的死锁形态：宿主条目在位
  //     而 viewer 侧身份未采纳，投递被 fencing 永拒且三个触发点全被同一
  //     宿主事实挡死，见 test/thread-pending-stall-deadlock-repro.test.js）。
  //     行动 = 强制重投（覆盖触发点丢失类滞留，不受退避约束）；仍有滞留时
  //     重试身份采纳 adopt-thread-head（与重启路径 spawn 注入身份的收敛
  //     语义同构——运行期也能发生），采纳后再投一次。仍失败由下一轮扫描
  //     自然重试，本模块不直接经手投递语义本身。
  const requeueInFlight = new Set();
  const STALL_THRESHOLD_MS = 60_000;
  const TERMINAL_LIKE_STATUS = new Set(['archived', 'closed', 'deleting', 'hold']);

  async function requeueStalledPendingThreads() {
    const report = { examined: 0, requeued: [], reconciled: [], skipped: [] };
    const ensureHead = typeof getEnsureHeadRuntime === 'function' ? getEnsureHeadRuntime() : null;
    const forceDeliver = typeof getForceDeliver === 'function' ? getForceDeliver() : null;
    const adoptIdentity = typeof getHeadIdentityAdopter === 'function' ? getHeadIdentityAdopter() : null;
    const resolveViewer = typeof threadControl?.resolveSessionViewerId === 'function'
      ? threadControl.resolveSessionViewerId.bind(threadControl)
      : null;
    if (typeof ensureHead !== 'function') return report;

    const actions = [];
    const summaries = await core.listThreads();
    for (const summary of summaries) {
      // 摘要预筛：无 pending 指令的线程不读记录（健康线程零记录级开销）。
      if (!Array.isArray(summary?.pendingTexts) || summary.pendingTexts.length === 0) continue;
      const status = String(summary?.status || '');
      if (TERMINAL_LIKE_STATUS.has(status)) continue;
      const threadId = String(summary?.threadId || '').trim();
      if (!threadId || requeueInFlight.has(threadId)) continue;

      const record = await core.getThread(threadId).catch(() => null);
      if (!record) continue;
      const pending = (Array.isArray(record.commands) ? record.commands : [])
        .filter((c) => c?.status === 'pending');
      if (pending.length === 0) continue;
      const oldest = pending.reduce(
        (min, c) => Math.min(min, Number(c?.createdAt) || Number.POSITIVE_INFINITY),
        Number.POSITIVE_INFINITY,
      );
      if (!Number.isFinite(oldest) || Date.now() - oldest < STALL_THRESHOLD_MS) continue;

      const viewerPresent = resolveViewer
        ? Boolean(resolveViewer(record.agentId, record.headSessionId))
        : false;
      if (viewerPresent && typeof forceDeliver !== 'function') {
        // 条目在位且无 reconcile 注入面：保持旧语义不行动，但如实报告——
        // 漏装配不静默。
        report.skipped.push({ threadId, reason: 'viewer_present_no_reconciler' });
        continue;
      }

      report.examined += 1;
      requeueInFlight.add(threadId);
      // 行动并发发起，tick 结束前统一等待 settle（report 完整、调用方可
      // 确定性观测；janitor 为间隔定时器不重入，tick 漂移无害）。单线程
      // 失败下一轮扫描自然重试（滞留事实仍在盘上）。
      const action = viewerPresent
        ? reconcileStalledDelivery(record, { forceDeliver, adoptIdentity, threadId })
          .then((outcome) => {
            report.reconciled.push({ threadId, ...outcome });
            if (outcome.delivered > 0) {
              console.warn(`[thread-recovery] reconciled stalled pending on ${threadId}: delivered ${outcome.delivered}, adopt=${outcome.adopt}`);
            } else {
              console.warn(`[thread-recovery] reconcile did not clear stall on ${threadId} (adopt=${outcome.adopt}); next sweep will retry`);
            }
          })
        : Promise.resolve(ensureHead(record.agentId, record.headSessionId))
          .then(() => { report.requeued.push(threadId); });
      actions.push(Promise.resolve(action)
        .catch((error) => console.warn(`[thread-recovery] stalled ${viewerPresent ? 'reconcile' : 'requeue wake'} failed for ${threadId}:`, error?.message || error))
        .finally(() => requeueInFlight.delete(threadId)));
    }
    await Promise.allSettled(actions);
    return report;
  }

  /**
   * 条目在位形态的滞留对账：先强制重投（新事实通道，不受退避约束；覆盖
   * 触发点丢失类滞留——runtime 已就绪且身份正确，只是没人再调投递），
   * 仍有滞留且注入了身份采纳器时重试 adopt-thread-head（viewer 侧身份
   * 错位形态的唯一运行期收敛路径，重启路径经 spawn 注入等价实现），
   * 采纳成功后再投一次。
   */
  async function reconcileStalledDelivery(record, { forceDeliver, adoptIdentity, threadId }) {
    const first = await forceDeliver(threadId);
    const firstDelivered = Number(first?.delivered) || 0;
    const fresh = await core.getThread(threadId).catch(() => null);
    const stillPending = (fresh?.commands || []).some((c) => c?.status === 'pending');
    if (!stillPending) {
      return { delivered: firstDelivered, adopt: 'not_needed' };
    }
    if (typeof adoptIdentity !== 'function') {
      return { delivered: firstDelivered, adopt: 'unavailable' };
    }
    let adopted;
    try {
      adopted = await adoptIdentity(record.agentId, record.headSessionId, {
        threadId,
        headGeneration: core.headGeneration(record),
      });
    } catch (error) {
      return { delivered: firstDelivered, adopt: `error:${error?.message || error}` };
    }
    if (adopted?.ok !== true) {
      const why = adopted?.skipped ? 'skipped_no_live_runtime' : (adopted?.error || 'rejected');
      return { delivered: firstDelivered, adopt: `failed:${why}` };
    }
    const second = await forceDeliver(threadId);
    return {
      delivered: firstDelivered + (Number(second?.delivered) || 0),
      adopt: adopted?.skipped ? 'skipped' : 'ok',
    };
  }

  return { convergeInterruptedSuccessions, convergePhantomRotating, requeueStalledPendingThreads };
}
