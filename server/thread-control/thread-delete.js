/**
 * Thread Delete — 线程直接删除与级联清理编排（T005 / ADR-001 §7）
 *
 * 删除是带确认的破坏性生命周期操作（确认层在 UI / CLI，服务端是最终安全
 * 边界，本模块不做确认、不进回收站）。语义链路：
 *
 *   delete requested
 *     → 目标解析：任意 Thread 成员（root / historical / head）都定位到所属
 *       Thread（locateBySession 注入，生产 = 框架 findThreadBySession，与
 *       T003 统一目标解析同源）；历史 Session 不能单独删除；
 *     → begin 事务（hold 置位 + deleting 标记，同一 store 落盘）：
 *         hold 阻塞 deliver / 自动补投（thread_held）；deleting 标记是
 *         「停止新 command 写入与派发」的入口层事实——routes 的
 *         commands/deliver 守卫、input-gateway 新 send、
 *         integration.beginSessionSuccession、succession.commitSuccession
 *         四处入口对 deleting 线程显式拒绝（thread_deleting，与 T004
 *         thread_archived 预检同构）。deleting 期间看板不 closed：
 *         runtime 的 turn.completed 事件仍能收敛 board running → idle，
 *         「优先等待自然完成」才真正可达（若此刻就 closed，框架 board
 *         拒绝迟到事件，自然收尾路径永不可达，每次删除必然强停）。
 *     → 收尾运行中调用（T005 实施要求 2/3）：优先等待 board 收敛到非
 *       running（自然完成），达到 forceWaitMs 预算后强制停止 Runtime
 *       （stopSession 注入）；无论是否自然收尾，成员 runtime 都经
 *       stopSession 幂等收敛（长活进程不绑已删会话）。
 *     → seal 事务（status=closed + 取消剩余 pending / in_flight，保留
 *       取消原因与时间 + deleting 生命周期事件）。closed 是框架 terminal
 *       判定：advanceHead / beginSessionHandoff 拒绝，deliver 返回
 *       thread_closed——deleting 窗口内不会提交新 successor（入口已拒），
 *       不会留下成员集合之外的孤儿会话。
 *     → 级联清理（T005 实施要求 4/5：每步幂等，已删除对象视为成功，失败项
 *       收集为结构化残留列表，重复执行 deleteThread 可继续收敛）：
 *         sessions / handoffs / runtimes（注入的跨目录清理器）
 *         board      看板文件（boards/<id>.board.json，执行事件随文件删除）
 *         archive    归档索引条目（不存在 = 幂等成功）
 *         record     Thread record 文件 + index 条目（ThreadStore.remove），
 *                    全部干净后才删；partial 失败保留 record 作重试寻址对象
 *     → 返回完整清理结果：complete / partial + failures（stage + error）。
 *
 * 删除后旧 Session ID / Thread ID / pending command 的读路径自然返回
 * not found（T005 实施要求 6）：
 *   - GET /protoclaw/threads/:threadId → 404 thread_not_found（record 已删）；
 *   - POST /protoclaw/threads/:id/commands|deliver → store.update 抛
 *     WorkThreadNotFoundError → 404；
 *   - session delete / archive 路由经 resolveLifecycleTarget 解析：成员已无
 *     归属（findThreadBySession 查不到）→ 独立 Session 语义，而 Session
 *     记录也已删 → requirePrebuiltSessionRecord 404 / Unknown session；
 *   - input-gateway 新 send：runtime 已停止 + 线程已删 → 直投失败。
 *
 * 本模块是纯编排：线程域数据（record / index / board / archive）经注入的
 * control 实例操作；跨目录清理（session 数据 / handoff / runtime 状态）与
 * runtime 停止 / 运行探测由注入的资源承担（生产装配见
 * thread-delete-resources.js，测试注入 stub 完全隔离）。部分失败绝不伪装
 * 成功：cleanup.status='partial' + 结构化 failures。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { sanitizeSessionFragment } from '../shared/string-helpers.js';

const DELETING_CANCEL_REASON = 'thread_deleted';
const LIFECYCLE_EVENT_CAP = 200;
/** 强停后给进程退出 / session-exited 确认的收敛窗口（bounded，不无限等）。 */
const SETTLE_AFTER_FORCE_STOP_MS = 500;
/** 等待轮询间隔（生产 / 测试同值；测试预算小，真实墙钟可控）。 */
const DRAIN_POLL_MS = 50;

function cleanText(value) {
  return String(value || '').trim();
}

function lifecycleError(message, code, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function pushLifecycleEvent(record, event) {
  record.lifecycleEvents = Array.isArray(record.lifecycleEvents) ? record.lifecycleEvents : [];
  record.lifecycleEvents.push(event);
  if (record.lifecycleEvents.length > LIFECYCLE_EVENT_CAP) {
    record.lifecycleEvents.splice(0, record.lifecycleEvents.length - LIFECYCLE_EVENT_CAP);
  }
  record.lastLifecycleEvent = event;
}

function memberSessionIds(thread) {
  return Array.from(new Set([
    ...(Array.isArray(thread?.sessionChain) ? thread.sessionChain.map((e) => e?.sessionId) : []),
    thread?.rootSessionId,
    thread?.headSessionId,
  ].map(cleanText).filter(Boolean)));
}

/**
 * 组装线程删除服务。
 *
 * @param {object} deps
 * @param {{ core: import('@agentdevjs/core').WorkThread,
 *           board: import('@agentdevjs/core').WorkThreadBoard,
 *           archive: import('./thread-archive.js').ThreadArchiveIndex,
 *           store: import('./thread-store.js').ThreadStore }} deps.control
 * @param {(agentId: string, sessionId: string) => Promise<object|null>} [deps.locateBySession]
 *   成员→所属 Thread 解析（生产 = threadLifecycle.findThreadBySession，与
 *   T003 统一目标解析同源；缺省用 core.findThreadBySession）
 * @param {Function} [deps.stopSession] - 停止成员 runtime（生产装配为幂等
 *   graceful 停止：remove-session 确认 / SIGTERM，(agentId, sessionId) => Promise）
 * @param {Function} [deps.removeSessions] - (agentId, sessionIds[]) => Promise，
 *   删除全部成员 Session 数据（index 记录 / 会话文件 / 运行恢复 / search index）
 * @param {Function} [deps.removeHandoffs] - (agentId, sessionIds[]) => Promise，
 *   删除 sourceSessionId 属于成员集合的 handoff
 * @param {Function} [deps.clearRuntimes] - (agentId, sessionIds[]) => void|Promise，
 *   释放成员 session 的 runtime envelope 状态
 * @param {object} [deps.timers] - 测试注入：{ setTimeout }
 */
export function createThreadDeleteService({
  control,
  locateBySession = null,
  stopSession = null,
  removeSessions = null,
  removeHandoffs = null,
  clearRuntimes = null,
  timers = null,
} = {}) {
  if (!control || !control.core || !control.board || !control.archive) {
    throw new Error('createThreadDeleteService requires thread control ({core, board, archive})');
  }
  const { core, board, archive, store } = control;
  const sleep = (ms) => new Promise((resolve) => {
    const t = (timers && typeof timers.setTimeout === 'function' ? timers.setTimeout : globalThis.setTimeout)(resolve, ms);
    if (t && typeof t.unref === 'function') t.unref?.();
  });

  const memberLookup = (agentId, sessionId) => (
    typeof locateBySession === 'function'
      ? locateBySession(agentId, sessionId)
      : core.findThreadBySession(agentId, sessionId)
  );

  /** 同一线程的并发删除去重（幂等入口）。 */
  const inflightDeletes = new Map();

  /**
   * 从任意 Thread 成员目标解析到所属 Thread（T005 实施要求 1）。
   * @returns {Promise<{thread: object, agentId: string, sessionId: string}|null>}
   *   非 Thread 成员返回 null（调用方走独立 Session 语义）。
   */
  async function resolveThreadTarget(agentId, sessionId) {
    const normalizedAgentId = cleanText(agentId);
    const normalizedSessionId = cleanText(sessionId);
    if (!normalizedAgentId || !normalizedSessionId) return null;
    const thread = await memberLookup(normalizedAgentId, normalizedSessionId);
    if (!thread) return null;
    return { thread, agentId: normalizedAgentId, sessionId: normalizedSessionId };
  }

  /**
   * 判定线程是否仍有运行中调用（drain 退出条件）。事实源：
   *   - 看板 running（runtime turn 事件流的「调用进行中」真相：
   *     turn.started → running / turn.completed → idle / turn.failed → failed）。
   * 刻意不用进程存活判定（coder runtime 是长活进程，调用结束后进程不退出，
   * 进程存活不是「调用进行中」事实）；也不用 in_flight / delivered 命令
   * 状态（投递后无完成回写，永久驻留，不是运行中事实）。
   *
   * 关键约束：drain 必须在 seal（status=closed）之前执行。closed 会让框架
   * board 拒绝后续 runtime 事件（isTerminal → thread_closed），board 的
   * running 将永远无法被 turn.completed 收敛到 idle——「优先等待自然完成」
   * 路径因此永不可达。begin 阶段只置 hold + deleting（不 closed），board
   * 事件照常收敛，自然完成才真正可达。
   */
  async function threadHasRunningCall(thread) {
    const boardState = await board.getState(thread.threadId).catch(() => null);
    return boardState?.status === 'running';
  }

  /**
   * 运行中调用收尾（T005 实施要求 2/3）：优先等待自然完成，达到明确
   * 超时后强制停止 Runtime；无论是否自然收尾，成员 runtime 都必须收敛
   * （Runtime 是承载 Session 的可重建执行实例，Session 即将删除，长活
   * 进程不能绑在已删会话上）。stopSession 是幂等 graceful 停止
   * （remove-session / SIGTERM → 退出收敛；runtime 不存在时 no-op）。
   * startedCommandIds 取 seal 前的命令快照（seal 会取消它们，seal 后读不到）。
   * 返回 { drained, forcedStopped, waitedMs, startedCommandIds, stopped }；
   * stopped 记录每个成员 session 的停止结果（失败项由编排层聚合进 failures）。
   */
  async function drainInflightCalls(thread, { forceWaitMs, startedCommandIds }) {
    const startedAt = Date.now();
    let drained = !(await threadHasRunningCall(thread));
    const budget = Math.max(0, Number(forceWaitMs) || 0);

    // 优先等待自然完成（不预先 interrupt 当前调用，与 T004 归档语义一致）。
    while (!drained && Date.now() - startedAt < budget) {
      await sleep(Math.min(DRAIN_POLL_MS, Math.max(1, budget - (Date.now() - startedAt))));
      drained = !(await threadHasRunningCall(thread));
    }
    const forcedStopped = !drained;

    const stopped = [];
    if (typeof stopSession === 'function') {
      for (const sessionId of memberSessionIds(thread)) {
        try {
          await stopSession(thread.agentId, sessionId);
          stopped.push({ sessionId, status: 'stopped' });
        } catch (error) {
          // 单 session 停止失败不中断其余清理；失败项聚合为结构化残留。
          stopped.push({ sessionId, status: 'failed', error: String(error?.message || error) });
        }
      }
      // stop 全部成功 = 执行载体已收敛：stopManagedAgent 是幂等 graceful
      // 停止（remove-session 确认 / SIGTERM），进程退出前看板收不到
      // turn.completed，盘上 running 只是未回写的观测态，不构成残留
      // 事实（board 文件随后随清理删除）。任一 stop 失败时该 session 的
      // 调用可能仍在跑，才判定未收敛。
      drained = stopped.every((s) => s.status === 'stopped');
    } else {
      // 未注入 stop（最小测试装配）：退回状态轮询，给收敛窗口（bounded）。
      const settleAt = Date.now() + SETTLE_AFTER_FORCE_STOP_MS;
      while ((await threadHasRunningCall(thread)) && Date.now() < settleAt) {
        await sleep(DRAIN_POLL_MS);
      }
      drained = !(await threadHasRunningCall(thread));
    }

    return {
      drained,
      forcedStopped,
      waitedMs: Date.now() - startedAt,
      startedCommandIds,
      stopped,
    };
  }

  // ── 线程域清理步骤（control 实例内，每步幂等）──────────────────

  /** board：看板文件（执行事件随文件删除，T005 §执行事件）。 */
  async function removeBoardFile(threadId) {
    const boardsDir = board.boardsDir || path.join(store.rootDir, 'boards');
    await fsp.rm(path.join(boardsDir, `${sanitizeSessionFragment(threadId)}.board.json`), { force: true });
    return { removed: true };
  }

  /** archive：归档索引条目（未归档 = 幂等成功）。 */
  async function removeArchiveEntry(threadId) {
    await archive.unarchive(threadId);
    return { removed: true };
  }

  /** record：Thread record 文件 + index 条目（ThreadStore.remove，幂等）。 */
  async function removeThreadRecord(threadId) {
    return await store.remove(threadId);
  }

  // ── 删除编排 ────────────────────────────────────────────────────

  /**
   * 删除一个 Thread 及其全部关联数据（T005）。
   *
   * 幂等：threadId 已不存在 → { deleted: true, idempotent: true }。
   * 部分失败不抛出（清理阶段）：cleanup.status='partial' + failures
   * 结构化残留；重复调用 deleteThread 继续清理失败残留（各步骤均幂等，
   * record 最后删——删掉 record 前失败仍可按 threadId 重试）。
   *
   * @param {string} threadId
   * @param {object} [options]
   * @param {number} [options.forceWaitMs=5000] - 运行中调用自然收尾的等待预算
   * @param {string} [options.reason='user_delete']
   * @returns {Promise<{threadId, deleted, idempotent, status, cleanup}>}
   */
  async function deleteThread(threadId, { forceWaitMs = 5000, reason = 'user_delete' } = {}) {
    const normalizedThreadId = cleanText(threadId);
    if (!normalizedThreadId) {
      throw lifecycleError('Thread id is required', 'invalid_thread_id', 400);
    }
    if (inflightDeletes.has(normalizedThreadId)) {
      return inflightDeletes.get(normalizedThreadId);
    }
    const task = (async () => {
      const existing = await core.getThread(normalizedThreadId);
      if (!existing) {
        // 已删除对象视为幂等成功（重复执行的收敛终态）。
        return {
          threadId: normalizedThreadId,
          deleted: true,
          idempotent: true,
          status: 'complete',
          cleanup: null,
        };
      }
      const thread = existing;
      const failures = [];
      const cleanup = {
        status: 'running',
        startedAt: Date.now(),
        reason,
        agentId: thread.agentId,
        headSessionId: thread.headSessionId || null,
        sessionIds: memberSessionIds(thread),
        commandsCancelled: 0,
        inflightDrain: null,
        steps: {},
        failures: [],
      };

      // 已开始调用清单在 begin 前快照（seal 会把它们取消，seal 后读不到
      // in_flight / delivered 事实）。
      const startedCommandIds = (Array.isArray(thread.commands) ? thread.commands : [])
        .filter((c) => c?.status === 'in_flight' || c?.status === 'delivered')
        .map((c) => c.commandId);

      // ── begin 事务（hold + deleting 标记，不 closed）────────────────
      // hold 阻塞自动投递（thread_held）；deleting 标记是「停止新 command
      // 写入与派发」的入口层事实（routes commands/deliver 守卫、
      // input-gateway 新 send、integration.beginSessionSuccession、
      // succession.commitSuccession 四处入口对 deleting 线程显式拒绝）。
      // 此刻看板不 closed：runtime 的 turn.completed 事件仍能收敛 board
      // running → idle，「优先等待自然完成」才真正可达（若此刻就 closed，
      // 框架 board 拒绝迟到事件，自然收尾路径永不可达，每次删除必然强停）。
      let began = null;
      try {
        const outcome = await core.store.update(normalizedThreadId, (draft) => {
          const now = Date.now();
          draft.hold = true;
          draft.deleting = true;
          pushLifecycleEvent(draft, {
            type: 'deleting',
            status: draft.status,
            at: now,
            reason,
          });
          return draft;
        });
        began = outcome.record;
        cleanup.steps.begin = { ok: true };
      } catch (error) {
        const message = String(error?.message || error);
        cleanup.steps.begin = { ok: false, error: message };
        failures.push({ stage: 'begin', error: message });
      }

      // ── 运行中调用收尾（优先等待，超时强停）────────────────────────
      // 强停后仍未收敛的调用是明确残留（Runtime 进程可能仍在跑），必须进
      // failures——部分失败不伪装成功（ADR-001 §7）。
      try {
        cleanup.inflightDrain = await drainInflightCalls(began || thread, { forceWaitMs, startedCommandIds });
        if (cleanup.inflightDrain.drained) {
          cleanup.steps.drain = { ok: true };
        } else {
          cleanup.steps.drain = { ok: false, error: 'runtime did not settle after force stop' };
          failures.push({
            stage: 'drain',
            error: `runtime still running after force stop; startedCommands=${cleanup.inflightDrain.startedCommandIds.length}`,
          });
        }
      } catch (error) {
        const message = String(error?.message || error);
        cleanup.inflightDrain = { drained: false, forcedStopped: false, waitedMs: 0, startedCommandIds };
        cleanup.steps.drain = { ok: false, error: message };
        failures.push({ stage: 'drain', error: message });
      }

      // ── seal 事务（status=closed + 取消 + 清除 deleting，同一 store 落盘）
      // 运行中调用已收敛（自然完成或强停），此刻才进入 closed 终态：
      //   - closed 是框架 terminal 判定：advanceHead / beginSessionHandoff
      //     拒绝，deliver 返回 thread_closed——deleting 窗口内不会提交新
      //     successor（入口已拒），不会留下成员集合之外的孤儿会话；
      //   - 取消剩余 pending / in_flight，保留取消原因与时间；
      //   - 清除 deleting 标记（终态后由 closed 取代，避免「删除中」事实
      //     残留在已删 / 待删记录上误导审计）。
      // seal 失败不影响清理推进（清理各步幂等、可重试）；seal 失败时线程
      // 仍 held（自动投递被阻）+ deleting 标记仍在（入口拒绝仍在），
      // 残留状态是安全的：重复执行 deleteThread 会重新走 begin（幂等）
      // 并在 seal 处再次尝试。
      let sealed = null;
      try {
        const outcome = await core.store.update(normalizedThreadId, (draft) => {
          const now = Date.now();
          draft.status = 'closed';
          draft.closeReason = reason;
          draft.closedAt = now;
          draft.deleting = false;
          for (const command of draft.commands || []) {
            if (command.status === 'pending' || command.status === 'in_flight') {
              command.status = 'cancelled';
              command.lastReason = DELETING_CANCEL_REASON;
              command.updatedAt = now;
              cleanup.commandsCancelled += 1;
            }
          }
          pushLifecycleEvent(draft, {
            type: 'deleting',
            status: 'closed',
            at: now,
            reason,
          });
          return draft;
        });
        sealed = outcome.record;
        cleanup.steps.seal = { ok: true };
      } catch (error) {
        const message = String(error?.message || error);
        cleanup.steps.seal = { ok: false, error: message };
        failures.push({ stage: 'seal', error: message });
      }

      // 级联清理：record 最后处理。部分失败时保留 record（closed 终态，
      // 新写入 / 投递已被拒绝）——这是重试的寻址对象：重复执行
      // deleteThread(threadId) 逐条收敛失败步骤（各步均幂等），全部干净后
      // 才删 record。若在 partial 时删掉 record，残留对象（如 session
      // 文件）将失去寻址入口，「重复执行可以继续收敛」无从谈起。
      const steps = [
        ['sessions', typeof removeSessions === 'function' ? () => removeSessions(thread.agentId, cleanup.sessionIds) : null],
        ['handoffs', typeof removeHandoffs === 'function' ? () => removeHandoffs(thread.agentId, cleanup.sessionIds) : null],
        ['runtimes', typeof clearRuntimes === 'function' ? () => clearRuntimes(thread.agentId, cleanup.sessionIds) : null],
        ['board', () => removeBoardFile(normalizedThreadId)],
        ['archive', () => removeArchiveEntry(normalizedThreadId)],
      ];
      for (const [stage, step] of steps) {
        if (!step) {
          cleanup.steps[stage] = { skipped: true, note: 'resource_not_injected' };
          continue;
        }
        try {
          cleanup.steps[stage] = { ok: true, ...((await step()) || {}) };
        } catch (error) {
          const message = String(error?.message || error);
          cleanup.steps[stage] = { ok: false, error: message };
          failures.push({ stage, error: message });
        }
      }

      const partial = failures.length > 0;
      if (partial) {
        cleanup.steps.record = { skipped: true, note: 'retained_for_retry' };
      } else {
        try {
          cleanup.steps.record = { ok: true, ...((await removeThreadRecord(normalizedThreadId)) || {}) };
        } catch (error) {
          const message = String(error?.message || error);
          cleanup.steps.record = { ok: false, error: message };
          failures.push({ stage: 'record', error: message });
        }
      }

      cleanup.completedAt = Date.now();
      cleanup.status = failures.length > 0 ? 'partial' : 'complete';
      cleanup.failures = failures;
      return {
        threadId: normalizedThreadId,
        deleted: failures.length === 0,
        idempotent: false,
        status: cleanup.status,
        cleanup,
      };
    })().finally(() => {
      inflightDeletes.delete(normalizedThreadId);
    });
    inflightDeletes.set(normalizedThreadId, task);
    return task;
  }

  /**
   * 按成员目标删除（T005 实施要求 1：历史 Session 不能单独删除）。
   *
   * @returns {Promise<{ok: true, actual: {type: 'thread', id: string},
   *   requested: {agentId, sessionId}, result: object}|null>}
   *   非 Thread 成员返回 null（调用方执行独立 Session 删除）。
   */
  async function deleteBySessionTarget(agentId, sessionId, options = {}) {
    const target = await resolveThreadTarget(agentId, sessionId);
    if (!target) return null;
    const result = await deleteThread(target.thread.threadId, options);
    return {
      ok: true,
      actual: { type: 'thread', id: target.thread.threadId },
      requested: { agentId: target.agentId, sessionId: target.sessionId },
      result,
    };
  }

  return {
    resolveThreadTarget,
    deleteThread,
    deleteBySessionTarget,
  };
}
