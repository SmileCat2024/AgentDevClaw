/**
 * Thread Lifecycle — 线程用户生命周期编排。
 *
 * WorkThread 保存连续性锚点，Board 保存执行观测；本模块负责把用户的
 * archive / unarchive 意图串成跨层事务。Session 数据不删除，归档只关闭
 * 关联 runtime 并停止后续执行。
 */

function cleanId(value) {
  return String(value || '').trim();
}

function lifecycleError(message, code, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

export function createThreadLifecycleService({
  control,
  interruptSession = null,
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

    // 写入归档标记先于清理，保证清理期间不会再接收新命令。
    const archiveEntry = await archive.archive(normalizedThreadId, {
      cleanup: { status: 'running', startedAt: Date.now(), failures: [] },
    });
    if (typeof core.setHold === 'function') {
      await core.setHold(normalizedThreadId, true).catch(() => {});
    }

    const sessionIds = Array.from(new Set([
      ...(Array.isArray(thread.sessionChain) ? thread.sessionChain.map((entry) => entry?.sessionId) : []),
      thread.rootSessionId,
      thread.headSessionId,
    ].map(cleanId).filter(Boolean)));
    const cleanup = {
      status: 'complete',
      startedAt: archiveEntry.cleanup?.startedAt || Date.now(),
      completedAt: null,
      reason,
      headSessionId: thread.headSessionId || null,
      headInterrupt: null,
      commandsCancelled: 0,
      sessions: [],
      failures: [],
    };

    if (thread.headSessionId && typeof interruptSession === 'function') {
      try {
        cleanup.headInterrupt = await interruptSession(thread.agentId, thread.headSessionId);
      } catch (error) {
        cleanup.headInterrupt = { status: 'failed', error: String(error?.message || error) };
        cleanup.failures.push({ stage: 'interrupt_head', sessionId: thread.headSessionId, error: cleanup.headInterrupt.error });
      }
    } else {
      cleanup.headInterrupt = { status: 'not_running' };
    }

    for (const command of Array.isArray(thread.commands) ? thread.commands : []) {
      if (command?.status !== 'pending') continue;
      try {
        if (typeof core.cancelCommand !== 'function') continue;
        const cancelled = await core.cancelCommand(normalizedThreadId, command.commandId);
        if (cancelled?.status === 'cancelled') cleanup.commandsCancelled += 1;
      } catch (error) {
        cleanup.failures.push({ stage: 'cancel_command', commandId: command.commandId, error: String(error?.message || error) });
      }
    }

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
    // Board.closeBoard 是归档终态；取消归档显式 reopen 看板，但绝不自动启动 runtime。
    if (typeof board.reopenBoard === 'function') {
      await board.reopenBoard(normalizedThreadId, { source: 'unarchive' }).catch(() => {});
    }
    return { threadId: normalizedThreadId, archivedAt: null, runtimeStarted: false };
  }

  return { findThreadBySession, archiveThread, unarchiveThread };
}
