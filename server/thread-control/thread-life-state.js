/**
 * Thread Life State — 线程生命状态合成（推导值，非存储字段）
 *
 * 四态模型（Q4 收敛版，去掉永假的 awaiting-input——coder 无 UserInputFeature）：
 *   archived > executing > pending-commands > idle
 *
 * 数据源拼装（thread 是连接结构，状态从三个既有域合成，不新增状态存储）：
 *   - archived     ← archive-index（ThreadArchiveIndex）
 *   - executing    ← 看板 running，或锚点 rotating（交接中也是活跃工作）
 *   - pending-commands ← 锚点 commands 中 pending / in_flight
 *   - idle         ← open 且无上述活动
 *
 * failed 不进四态（它是注意力信号而非生命位置）：单独以布尔暴露，
 * 看板 failed 或锚点 rotation_failed 时为真，前端可在行上叠红点。
 * closed 线程（系统清理残迹：ACP 回滚 / head 会话删除）不出现在列表，
 * 合成函数对 closed 返回 lifeState 'closed' 供调用方过滤。
 */

const PENDING_COMMAND_STATUSES = new Set(['pending', 'in_flight']);

/**
 * @param {object} params
 * @param {import('@agentdev/core').WorkThreadRecord} params.thread
 * @param {import('@agentdev/core').WorkThreadBoardState | null} [params.boardState]
 * @param {{ archivedAt: number } | null} [params.archiveEntry]
 * @returns {{ lifeState: 'archived'|'executing'|'pending-commands'|'idle'|'closed', archivedAt: number | null, failed: boolean, lastEventAt: number | null }}
 */
export function synthesizeThreadLifeState({ thread, boardState = null, archiveEntry = null }) {
  const lastEventAt = Math.max(
    Number(thread?.updatedAt) || 0,
    Number(boardState?.updatedAt) || 0,
  ) || null;

  if (archiveEntry?.archivedAt) {
    return { lifeState: 'archived', archivedAt: archiveEntry.archivedAt, failed: false, lastEventAt };
  }

  const failed = boardState?.status === 'failed' || thread?.status === 'rotation_failed';

  if (thread?.status === 'closed') {
    return { lifeState: 'closed', archivedAt: null, failed, lastEventAt };
  }

  if (boardState?.status === 'running' || thread?.status === 'rotating') {
    return { lifeState: 'executing', archivedAt: null, failed, lastEventAt };
  }

  const hasPending = Array.isArray(thread?.commands)
    && thread.commands.some((command) => PENDING_COMMAND_STATUSES.has(command?.status));
  if (hasPending) {
    return { lifeState: 'pending-commands', archivedAt: null, failed, lastEventAt };
  }

  return { lifeState: 'idle', archivedAt: null, failed, lastEventAt };
}
