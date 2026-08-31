/**
 * Thread Lifecycle — 线程用户生命周期编排。
 *
 * WorkThread 保存连续性锚点，Board 保存执行观测；本模块负责把用户的
 * archive / unarchive 意图串成跨层事务。Session 数据不删除，归档只关闭
 * 关联 runtime 并停止后续执行。
 *
 * T004 归档 = 取消性生命周期操作（ADR-001 §6 / work-thread-design §2.2）：
 *   archive requested
 *     → 写归档标记（routes / input-gateway 拒绝新 send）
 *     → seal 事务（同一 store 事务，无投递窗口）：
 *         hold 置位（阻塞 deliver / 自动补投）
 *         取消全部 pending command（保留取消原因与时间；已开始的
 *         in_flight / delivered 不动，允许自然完成）
 *         收敛 pendingSuccession 挡板（与 compact/rotation 并发的冲突
 *         响应：归档后 relay 不得继续提交消费旧 Inbox，提交点的
 *         thread_archived 预检是第二道门）
 *     → 停止成员 session runtime（graceful：remove-session / SIGTERM →
 *       agent dispose 收敛，不 SIGKILL；不预先 interrupt 当前调用）
 *     → 收尾 Board
 *     → 写 cleanup 结果（complete / partial 如实区分）
 *
 * 恢复（unarchive）只恢复 Thread 与当前 head 的可调度资格（清归档标记
 * + 解除 hold + 重开看板）：不复活已取消的 command，不创建 successor，
 * 不启动 runtime。
 */

const LIFECYCLE_EVENT_CAP = 200;

function cleanId(value) {
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

export function createThreadLifecycleService({
  control,
  stopSession = null,
} = {}) {
  const { core, board, archive } = control || {};
  if (!core || !board || !archive) {
    throw new Error('createThreadLifecycleService requires thread control');
  }

  async function findThreadBySession(agentId, sessionId) {
    // T001：成员归属事实统一取自框架 WorkThread.findThreadBySession
    // （sessionChain 链记录），与 integration / input-gateway 同源。
    const normalizedAgentId = cleanId(agentId);
    const normalizedSessionId = cleanId(sessionId);
    if (!normalizedAgentId || !normalizedSessionId) return null;
    return core.findThreadBySession(normalizedAgentId, normalizedSessionId);
  }

  async function archiveThread(threadId, { reason = 'user_archive' } = {}) {
    const normalizedThreadId = cleanId(threadId);
    const thread = await core.getThread(normalizedThreadId);
    if (!thread) throw lifecycleError('Thread not found', 'thread_not_found', 404);
    if (thread.status === 'closed') {
      throw lifecycleError('Thread is closed', 'thread_closed');
    }

    // 归档标记先落（cleanup running）：routes 的 _assertNotArchived 与
    // input-gateway 的 thread_archived 拒绝都以此标记为事实，先于 seal
    // 生效——新 send 在清理期间即被拒绝。
    const archiveEntry = await archive.archive(normalizedThreadId, {
      cleanup: { status: 'running', startedAt: Date.now(), failures: [] },
    });

    // seal 事务：hold / 取消 / 挡板收敛在同一次 store 落盘中完成，
    // 消除「setHold 之后、cancel 之前」的投递窗口；遍历的是事务内的
    // 最新 draft，覆盖归档期间并发 append 的 pending（快照循环做不到）。
    let commandsCancelled = 0;
    let handoffConverged = false;
    const inflightCommandIds = [];
    const { record: sealed } = await core.store.update(normalizedThreadId, (draft) => {
      const now = Date.now();
      draft.hold = true;
      if (draft.pendingSuccession) {
        draft.pendingSuccession = null;
        if (draft.status === 'rotating') draft.status = 'open';
        handoffConverged = true;
        pushLifecycleEvent(draft, {
          type: 'handoff_aborted',
          status: draft.status,
          at: now,
          stage: 'archived',
          reason: 'archived',
        });
      }
      for (const command of draft.commands || []) {
        if (command.status === 'pending') {
          // T004：尚未开始的 Inbox command 取消，保留取消原因与时间
          // （UI 与审计解释：为何取消、何时取消）。
          command.status = 'cancelled';
          command.lastReason = reason;
          command.updatedAt = now;
          commandsCancelled += 1;
        } else if (command.status === 'in_flight' || command.status === 'delivered') {
          // T004：已开始的 Runtime call 不取消——允许自然完成，
          // 完成后 hold 保证不再消费下一条（完成回调不触发投递）。
          inflightCommandIds.push(command.commandId);
        }
      }
      pushLifecycleEvent(draft, {
        type: 'archived',
        status: draft.status,
        at: now,
        reason,
        commandsCancelled,
      });
      return draft;
    });

    // 成员集合取 seal 后的最新记录（而非入口处的快照）：归档期间
    // 并发的 head 推进/成员变化同样纳入 runtime 停止范围。
    const sessionIds = Array.from(new Set([
      ...(Array.isArray(sealed.sessionChain) ? sealed.sessionChain.map((entry) => entry?.sessionId) : []),
      sealed.rootSessionId,
      sealed.headSessionId,
    ].map(cleanId).filter(Boolean)));
    const cleanup = {
      status: 'complete',
      startedAt: archiveEntry.cleanup?.startedAt || Date.now(),
      completedAt: null,
      reason,
      headSessionId: sealed.headSessionId || null,
      commandsCancelled,
      // 已开始的调用收尾事实：这些 command 对应已下沉到 runtime 的
      // 调用，归档不取消、不强制中断，graceful stop 时收敛完成。
      inflightDrain: { count: inflightCommandIds.length, commandIds: inflightCommandIds },
      handoffConverged,
      sessions: [],
      failures: [],
    };

    for (const sessionId of sessionIds) {
      try {
        if (typeof stopSession !== 'function') {
          cleanup.sessions.push({ sessionId, status: 'not_requested' });
          continue;
        }
        const result = await stopSession(thread.agentId, sessionId);
        const status = result?.status === 'running' ? 'requested' : (result?.status || 'stopped');
        cleanup.sessions.push({ sessionId, status });
      } catch (error) {
        const message = String(error?.message || error);
        cleanup.sessions.push({ sessionId, status: 'failed', error: message });
        cleanup.failures.push({ stage: 'stop_runtime', sessionId, error: message });
      }
    }

    if (typeof board.closeBoard === 'function') {
      try {
        await board.closeBoard(normalizedThreadId, { reason });
      } catch (error) {
        cleanup.failures.push({ stage: 'close_board', error: String(error?.message || error) });
      }
    }

    cleanup.completedAt = Date.now();
    cleanup.status = cleanup.failures.length > 0 ? 'partial' : 'complete';
    await archive.archive(normalizedThreadId, { cleanup });
    return { threadId: normalizedThreadId, archivedAt: archiveEntry.archivedAt, cleanup };
  }

  async function unarchiveThread(threadId) {
    const normalizedThreadId = cleanId(threadId);
    const thread = await core.getThread(normalizedThreadId);
    if (!thread) throw lifecycleError('Thread not found', 'thread_not_found', 404);
    await archive.unarchive(normalizedThreadId);
    await core.setHold(normalizedThreadId, false).catch(() => {});
    // 重开看板：closeBoard 把看板置为 closed 终态，框架 board 没有
    // reopen 转换（closed 无出边）；恢复可调度资格需要看板回到 idle，
    // 经 setStatus 显式播种（仅改看板域，不反写锚点状态）。看板不存在
    // 时不创建（避免副作用）。不启动 runtime、不触碰 commands
    // （cancelled 永不复活）。
    const boardState = await board.getState(normalizedThreadId).catch(() => null);
    if (boardState?.status === 'closed' && typeof board.setStatus === 'function') {
      await board.setStatus(normalizedThreadId, 'idle').catch(() => {});
    }
    return { threadId: normalizedThreadId, archivedAt: null, runtimeStarted: false };
  }

  return { findThreadBySession, archiveThread, unarchiveThread };
}
