/**
 * Thread Integration — 工作线程与 Claw 会话生命周期的接线层
 *
 * 把 thread-control 控制面挂到既有会话生命周期的钩子上：
 *   1. onSessionCreated：线程宿主 APP（coder）的新会话（含 branch 产生的
 *      新会话）自动创建线程（会话成为线程 root 与初始 head）；
 *   2. beginSessionSuccession：compact / summary 接力开始时写入交接意图
 *      （pendingSuccession 挡板）；
 *   3. applySessionSuccession：successor 会话就绪后推进线程 head 并投递
 *      接力期间暂存的指令；
 *   4. assertSessionDeletable：拒绝单独删除线程 head 会话；
 *   5. tryDeliver：appendCommand 后的即时投递尝试（head runtime 已就绪时）；
 *   6. handleRuntimeReady：head runtime 就绪时补投 pending 指令（经
 *      shared/runtime-hooks 的 onRuntimeReady 订阅接入）。
 *
 * 判定基准：isThreadHostSession 只回答「哪个 APP 的新会话自动建立线程
 * 环境」（环境的存在性开关，消费点：onSessionCreated 与 input-gateway 的
 * 指令路由闸）。其余钩子（succession / 删除前置守卫 / runtime 就绪
 * 补投 / guard 触发的 rotation）一律以「该会话是否为某活跃线程的 head」
 * 为唯一判定——处于线程环境（thread）则生效，纯 session 会话天然 no-op，
 * 与会话所属 APP 无关。
 */

import { getThreadControl } from './thread-controller.js';
import { ThreadNotFoundError } from './thread-store.js';
import { isThreadHostSession } from './host-agents.js';
import { createDeliveryConsumer } from './delivery-consumer.js';
import { abortPendingSuccession } from './thread-succession.js';
import { publishThreadEvent as publishThreadEventDefault } from '../routes/sse-events.js';

// 判定的唯一定义在 ./host-agents.js（无副作用轻量模块，供 agent 子进程同源
// 引用）；此处 re-export 维持 server 侧既有消费方（input-gateway 等）不变。
export { isThreadHostSession };

/**
 * beginSessionSuccession 失败判定：applied=false 且 reason='error' 表示
 * 交接挡板写入本身失败，消费方（compact / trim 接续入口）应据此中断流程；
 * no_thread_for_session / invalid_session 是合法 no-op，不算失败。
 */
export function isSuccessionGateFailure(result) {
  return Boolean(result)
    && result.applied === false
    && result.reason === 'error';
}

/**
 * 退役棒指令消费证据快照构建（ADR-0047 阶段 2b）。
 *
 * 框架 board.readStateDetailed 提供三态完整性（ok / missing / corrupt）；
 * 框架过旧或装配无 board 时降级 getState（null 统一按 missing——corrupt
 * 被吞成 missing 是保守正确方向：无法判定一律进 unresolved，不会把损坏
 * 证据当有效证据放行）。IO 抛错返回第四态 unreadable（瞬时读取失败，
 * 重试可恢复证据）：框架 commit 收到 unreadable 拒绝换头（可重试 409），
 * 不混入 unresolved——结构性缺失（missing/corrupt）才由 unresolved 承接
 * （ADR-0047 阶段 2a 审查裁定：读取失败与证据缺失语义分离）。
 */
export async function buildSuccessionEvidence(board, threadId) {
  if (typeof board?.readStateDetailed === 'function') {
    try {
      const detailed = await board.readStateDetailed(threadId);
      if (detailed?.integrity === 'ok') {
        const events = Array.isArray(detailed.state?.executionEvents)
          ? detailed.state.executionEvents
          : [];
        return { integrity: 'ok', events };
      }
      if (detailed?.integrity === 'corrupt') {
        return { integrity: 'corrupt', events: [], note: detailed.error || 'board state corrupt' };
      }
      return { integrity: 'missing', events: [] };
    } catch (error) {
      return { integrity: 'unreadable', events: [], note: `readStateDetailed failed: ${error?.message || error}` };
    }
  }
  // 降级路径：旧框架 getState（损坏与缺失都吞成 null）
  if (typeof board?.getState === 'function') {
    try {
      const state = await board.getState(threadId);
      if (!state) return { integrity: 'missing', events: [] };
      return {
        integrity: 'ok',
        events: Array.isArray(state.executionEvents) ? state.executionEvents : [],
      };
    } catch (error) {
      return { integrity: 'unreadable', events: [], note: `getState failed: ${error?.message || error}` };
    }
  }
  return { integrity: 'missing', events: [], note: 'board not assembled' };
}

/**
 * 未决核对通知指令文本（ADR-0047 阶段 2b 强制发现）：自动接续时随 commit
 * 追加进 Inbox，新 head 首轮输入必然携带未决清单，不依赖模型主动查询。
 * 语气对齐框架 DEFAULT_SUCCESSION_INSTRUCTION（先核对现实再继续）。
 */
export function composeUnresolvedNotice(unresolved, retiredSessionId) {
  const lines = [
    `检测到 ${unresolved.length} 条上一棒（${retiredSessionId}）无法判定是否已消费的指令。`,
    '这些指令没有任何可靠消费证据（旧会话执行记录不完整或已丢失），既不能当作已执行，也不能自动重放。',
    '继续工作前，请逐条核对现实状态后处置：',
  ];
  for (const entry of unresolved) {
    const summary = String(entry?.text || '').slice(0, 200);
    lines.push(`- [${entry?.unresolvedId}]（原因 ${entry?.reason}）：${summary}`);
  }
  lines.push('核对方式：检查上述工作是否已真实完成（git 历史 / 文件状态 / 运行结果）。已完成的按已消费处置；未完成且仍需要的，重投该指令继续执行；已失效的显式放弃。处置是显式决定，不会自动发生。');
  return lines.join('\n');
}

export function createThreadIntegration({ control = null, publishThreadEvent = publishThreadEventDefault } = {}) {
  const { core, board, archive } = control || getThreadControl();

  // ADR-0047 阶段 5 身份采纳通道：successor 在 READY 门前拉起时不是 head，
  // spawn 身份不含线程信息；换头提交后必须把新 head 身份推给 runtime
  // （IPC → Agent.adoptThreadHeadIdentity → Viewer 重注册），fencing 才能
  // 放行线程指令。经 setter 晚绑定（组合根 server.js 配置），本模块不
  // 依赖 runtime 管理，单例创建顺序不影响装配。
  let headIdentityAdopter = null;

  /**
   * 向新 head runtime 推送线程身份（宿主组合根装配）。
   * 签名：(agentId, sessionId, { threadId, headGeneration }) => { ok, error? }
   */

  // T001：成员查询的权威实现在框架 WorkThread.findThreadBySession——
  // 归属事实唯一取自 sessionChain 链记录（root / predecessor / head 一致），
  // 不用 UI 投影或运行时扫描推导。此处保留 Claw 侧入口签名，消费方
  // （acp / input-gateway / 前端投影）不变。
  async function findThreadBySession(agentId, sessionId) {
    return core.findThreadBySession(agentId, sessionId);
  }

  /**
   * head generation 的权威派生（ADR-0047 fencing 身份链）：框架
   * core.headGeneration 对 legacy 记录（盘上无 headGeneration）按
   * sessionChain.length 派生。宿主注入 spawn 身份必须与投递侧
   * （deliverPendingCommands → bridge → viewer fencing 校验）同一口径，
   * 两处各写 fallback 会让 legacy 多棒线程的指令被永久拒收
   * （spawn 注入 1 vs wire 派生 N）。宿主消费方（agent-startup）一律
   * 经此入口取值，不自行派生。
   */
  function resolveHeadGeneration(thread) {
    return core.headGeneration(thread);
  }

  /**
   * 未决核对通知（ADR-0047 阶段 2b 强制发现）：自动接续时经
   * commitSessionSuccession 的 composeNotice 回调在换头事务内构造入箱
   * （system_continuation 指令，幂等键 succession-notice:<threadId>:<to>）
   * ——新 head 首轮输入必然携带清单，不依赖模型主动查询，也不存在
   * 「已换头但通知未追加」的崩溃窗口（阶段 2b 审查修正：事务外追加
   * 崩溃后 head CAS 拒绝重试，通知永不补建）。手动接续
   * （seedContinuation=false）不构造：手动精简停在产物上等真实输入，
   * 通知指令会唤醒轮次违反免播语义；未决事实经 thread-routes 的
   * unresolved 查询/处置端点可见（ADR 阶段 2b API 面）。
   */

  // R6：投递统一经 delivery-consumer（退避 / 滞留水位告警 / FIFO 顺序），
  // 三个触发点（apply 后 / runtime ready / gateway append 后）共享同一消费面
  const deliveryConsumer = createDeliveryConsumer(core);

  // ADR-0047 阶段 2b：退役棒指令消费判定与 head 推进合并为框架原子事务
  // commitSessionSuccession（分类语义同源、单文件原子写 + unresolved 一等
  // 事实），宿主侧判定闸已退役。证据快照经 buildSuccessionEvidence 构建
  // （ok / missing / corrupt / unreadable 四态）。

  return {
    core,
    board,
    // T004：input-gateway 入口层拒绝归档线程新 send 需要归档标记事实
    // （routes 的 _assertNotArchived 同源）；暴露给网关消费。
    archive,
    findThreadBySession,
    resolveHeadGeneration,
    /**
     * 装配换头身份采纳器（组合根 server.js）：applySessionSuccession 在
     * 换头提交后、补投递前调用。见上方 headIdentityAdopter 注释。
     */
    setHeadIdentityAdopter(fn) {
      headIdentityAdopter = typeof fn === 'function' ? fn : null;
    },

    async assertSessionStartable(agentId, sessionId) {
      const thread = await findThreadBySession(agentId, sessionId);
      if (!thread) return;
      const code = thread.deleting ? 'thread_deleting'
        : thread.status === 'closed' ? 'thread_closed'
        : await archive.isArchived(thread.threadId) ? 'thread_archived'
        : thread.pendingSuccession && thread.headSessionId === sessionId ? 'handoff_in_progress'
        : null;
      if (code) throw Object.assign(new Error(`Session runtime cannot start: ${code}`), { code, status: 409, statusCode: 409 });
    },

    /**
     * 会话创建钩子：线程宿主 APP 的新会话自动成为一条新线程。
     * 失败不阻断会话创建（线程是承接增强，不是会话存在的前提）。
     */
    async onSessionCreated(agentId, session) {
      if (!isThreadHostSession(agentId)) return null;
      const sessionId = String(session?.id || '').trim();
      if (!sessionId) return null;
      try {
        const thread = await core.start({
          sessionRef: { agentId, sessionId },
          // ADR-0041：建线不再写入 title。对话名称的唯一来源是 Session 索引，
          // 线程记录的 title 字段保留但停止写入与消费，避免双真相回退。
        });
        console.log(`[thread-integration] thread created: ${thread.threadId} head=${sessionId}`);
        // 创建事务落定后发布事实事件（无订阅者时 no-op）。重启恢复不经过
        // 此钩子（会话是恢复不是创建，线程已在 store），不会把既有线程
        // 重复发布为新建事件。
        publishThreadEvent(thread.threadId, {
          kind: 'thread.created',
          agentId: thread.agentId,
          rootSessionId: thread.rootSessionId,
          headSessionId: thread.headSessionId,
          status: thread.status,
        });
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
     * seedContinuation=false：同笔事务免播接续恢复指令（R3 per-call 开关）。
     * 手动接续（用户发起的精简/摘要）免播——变换完成、head 推进后停在
     * 产物上，等下一条真实输入；自动接续（context guard → thread-rotation）
     * 缺省播种，新 head 以恢复指令续跑。挡板与 Inbox 暂存语义两者相同。
     * 纯 session 会话（无线程）：no-op（纯会话语义，行为与未接入线程一致）。
     */
    async beginSessionSuccession({ agentId, sessionId, reason = 'manual', seedContinuation = true }) {
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
        // T005：删除中的线程拒绝新的上下文变换派发（与 routes 的
        // _assertNotDeleting / input-gateway 的 thread_deleting 同源）。
        // deleting 窗口（begin 后 / seal 前）线程未 closed，框架
        // beginSessionHandoff 不拒绝——入口层显式拒绝，避免删除期间
        // 启动接力产生孤儿 successor。
        if (thread.deleting === true) {
          return { applied: false, reason: 'thread_deleting', threadId: thread.threadId };
        }
        await core.beginSessionHandoff({
          threadId: thread.threadId,
          fromSessionId: from,
          reason,
          seedContinuation,
        });
        // 交接开始的事实事件：前端活动线程订阅据此即时点亮「接力中」状态
        // （顶栏指示器 / 侧栏过渡占位），不等 20s contentHash 轮询。事件只
        // 携带事务事实（与 head-advanced 同纪律），状态以 /threads 数据为准。
        publishThreadEvent(thread.threadId, {
          kind: 'thread.handoff-started',
          agentId: normalizedAgentId,
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
     * fromSessionId 是线程当前 head 时原子提交接续（ADR-0047 阶段 2b：
     * head 推进 + 挡板清除 + 退役棒指令消费分类 + unresolved 持久化在同
     * 一次框架事务内），随后把接力期间暂存的 pending 指令投递给新 head
     * runtime。非 head / 无线程（纯 session）：静默跳过（no-op）。
     *
     * seedContinuation（默认 true，与 beginSessionSuccession 对称）：
     * 自动接续时 commit 产生的 unresolved 清单追加为 system_continuation
     * 通知指令强制进入新 head 首轮；false（手动精简免播路径）不追加，
     * unresolved 经 /threads/:id/unresolved 查询处置面可见。
     *
     * T002：applied=false 分两类——
     *   - void（并发/幂等场景，线程状态已是权威，不记失败）：
     *     head_mismatch / already_head / duplicate_session / thread_closed；
     *   - 失败（evidence_unreadable 等可重试 / 事务异常等）：记
     *     rotation_failed + 错误 code 作 stage，并显式收敛挡板（不靠
     *     stale TTL）。
     */
    async applySessionSuccession({ agentId, fromSessionId, toSessionId, reason = 'manual', seedContinuation = true }) {
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

        // ADR-0047 阶段 2b 原子提交：证据快照（事务外读取，单向保守）+
        // 框架 commitSessionSuccession——head 推进、挡板清除、退役棒指令
        // 消费分类、unresolved 持久化在同一次原子写内完成。瞬时读取失败
        // （evidence_unreadable）经 catch 链失败收敛（rotation_failed 可重试，
        // 旧 head 权威）；结构性缺失（missing/corrupt）由 unresolved 承接。
        // 强制发现通知（自动路径）经 composeNotice 在同一事务内构造入箱
        // （阶段 2b 审查修正：事务外追加在 commit 后崩溃会因 head CAS
        // 拒绝重试而永不补建——通知与换头必须同生共死）。
        const evidence = await buildSuccessionEvidence(board, thread.threadId);
        const committed = await core.commitSessionSuccession({
          threadId: thread.threadId,
          fromSessionId: from,
          toSessionId: to,
          endKind: String(reason || 'manual').trim() || 'manual',
          evidence,
          ...(seedContinuation !== false
            ? {
              composeNotice: (unresolved) => (Array.isArray(unresolved) && unresolved.length > 0
                ? { text: composeUnresolvedNotice(unresolved, from) }
                : null),
            }
            : {}),
        });
        console.log(`[thread-integration] head advanced: ${thread.threadId} ${from} -> ${to} (${reason})`);

        // 身份采纳（ADR-0047 阶段 5）：换头事实落定后、补投递前，向新 head
        // runtime 推送线程身份——successor 拉起早于换头提交（READY 门），
        // spawn 身份不含线程，不采纳则 fencing 拒收一切线程指令。失败不
        // 回滚换头：指令保持 retryable-pending，runtime 重启路径在 spawn 时
        // 注入身份（headSessionId 已指向新 head），自然收敛。
        if (typeof headIdentityAdopter === 'function') {
          try {
            const adopted = await headIdentityAdopter(normalizedAgentId, to, {
              threadId: thread.threadId,
              headGeneration: committed.record?.headGeneration,
            });
            if (adopted?.ok !== true) {
              console.warn(`[thread-integration] head identity adoption not confirmed (thread=${thread.threadId} session=${to}): ${adopted?.error || 'unknown'}`);
            }
          } catch (adoptError) {
            console.warn(`[thread-integration] head identity adoption failed (thread=${thread.threadId} session=${to}):`, adoptError?.message || adoptError);
          }
        }

        // successor READY 门禁在提交点上游（thread-succession.js）；投递暂存指令
        // 统一经 delivery-consumer 消费面（force：advance 换代是新权威事实，
        // 不受线程级退避约束）
        const delivery = await deliveryConsumer.consume(thread.threadId, { force: true });
        // head 推进事务落定（commit + 通知指令 + 补投递完成后）发布事实事件：
        // 前端流视图据此发现换头并重绑数据源（ADR-0024），事件只携带
        // 事务事实，不承载派生视图数据。
        publishThreadEvent(thread.threadId, {
          kind: 'thread.head-advanced',
          agentId: normalizedAgentId,
          fromSessionId: from,
          toSessionId: to,
          reason: String(reason || 'manual').trim() || 'manual',
        });
        return { applied: true, thread: committed.record, delivery, unresolved: committed.unresolved };
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
        // 已关闭线程不再写失败事实（关闭语义只由删除事务封存，
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
     * 会话删除前置守卫：线程成员必须通过删除线程事务级联删除；head 会话
     * 不能单独删除，以免线程失去承接点而留下悬空记录。非 head 会话 / 无
     * 线程（纯 session）由上游按独立会话语义处理。
     */
    async assertSessionDeletable(agentId, sessionId) {
      const normalizedAgentId = String(agentId || '').trim();
      const deleted = String(sessionId || '').trim();
      if (!deleted) return { applied: false, reason: 'invalid_session' };
      const thread = await core.findThreadByHeadSession(normalizedAgentId, deleted);
      if (!thread) return { applied: false, reason: 'no_thread_for_session' };
      const error = new Error(`Session ${deleted} is the head of thread ${thread.threadId} and cannot be deleted individually; delete the thread instead`);
      error.code = 'thread_head_session_cannot_be_deleted';
      error.status = 409;
      throw error;
    },

    /**
     * 指令追加后的即时投递：head runtime 已就绪时当场送达，
     * 否则保持 pending 等待下一次 head 推进 / 显式 deliver。
     * 经 delivery-consumer 消费（投递失败进入线程级退避）。
     */
    async tryDeliver(threadId) {
      try {
        return await deliveryConsumer.consume(threadId);
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
     * force：runtime ready 是新事实，不受此前投递失败的退避约束。
     */
    async handleRuntimeReady(agentId, sessionId) {
      const normalizedAgentId = String(agentId || '').trim();
      const readySession = String(sessionId || '').trim();
      if (!readySession) return { applied: false, reason: 'invalid_session' };
      try {
        const thread = await core.findThreadByHeadSession(normalizedAgentId, readySession);
        if (!thread) return { applied: false, reason: 'no_thread_for_session' };
        const delivery = await deliveryConsumer.consume(thread.threadId, { force: true });
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
