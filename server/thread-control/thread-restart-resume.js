/**
 * C2 重启自动恢复：未完成事实判定 + 空消息续跑
 *
 * 产品语义（线程生命周期共识）：
 * - 归档是唯一终局宣告；系统重启不是。
 * - 重启后按盘上事实判定「未完成」的线程才拉起：
 *   a. 存在 pending 指令（欠着活没干）→ 拉起 head runtime，补投由
 *      handleRuntimeReady 既有机制自然完成，本模块不经手投递。
 *   b. 无 pending 但看板停 running（干到一半进程没了，与手动停止的
 *      idle 已被 C1/C2 语义区分开）→ 拉起 + kind='resume' 空消息续跑，
 *      模型凭尾部工作现场自然续作（投递按 resolveSessionViewerId 定位
 *      head runtime 的 viewerAgentId，与线程域 bridge 同一寻址口径）。
 * - idle / failed / waiting_input 看板 = 无未完成事实，不拉起（失败红点
 *   等人；空闲等归档或新指令）。
 * - archived / deleting / closed / hold 线程一律跳过：归档是终局、删除
 *   是清理、hold 是人为暂停（解除 hold 不等于要求续作，用户没说要续）。
 *
 * 逐线程串行 + 独立容错：单线程恢复失败不阻断其余，也不重试——
 * 拉起失败的事实留在报告里，下次重启仍按盘上状态重新判定。
 */

/**
 * @param {object} deps
 * @param {{ core: object, board: object, archive?: object, resolveSessionViewerId: Function }} deps.control thread-control 聚合（getThreadControl()）
 * @param {Function} deps.ensureHeadRuntime head runtime 就绪闸（agentId, sessionId）→ { ok, ... } | { ok: false, code, message }
 * @param {Function} deps.submitUserTurn viewer user-turn 客户端（server/shared/user-turn.js），kind='resume' 时空 text 放行
 */
export function createThreadRestartResume({ control, ensureHeadRuntime, submitUserTurn }) {
  if (!control?.core || !control?.board) {
    throw new Error('createThreadRestartResume: missing required dependency "control" (core/board)');
  }
  if (typeof control.resolveSessionViewerId !== 'function') {
    throw new Error('createThreadRestartResume: missing required dependency "control.resolveSessionViewerId"');
  }
  if (typeof ensureHeadRuntime !== 'function') {
    throw new Error('createThreadRestartResume: missing required dependency "ensureHeadRuntime"');
  }
  if (typeof submitUserTurn !== 'function') {
    throw new Error('createThreadRestartResume: missing required dependency "submitUserTurn"');
  }

  /**
   * 启动恢复扫描。幂等：重复调用只会在「上次拉起后仍未完成」的线程上
   * 重复触发，而那正是事实驱动语义的预期行为。
   * @returns {Promise<{resumed: Array<object>, skipped: Array<object>, failed: Array<object>}>}
   */
  async function resumeInterruptedThreads() {
    const resumed = [];
    const skipped = [];
    const failed = [];

    const [threads, archiveEntries] = await Promise.all([
      control.core.listThreads({}),
      control.archive?.list?.().catch(() => ({})) || {},
    ]);

    for (const thread of Array.isArray(threads) ? threads : []) {
      const threadId = String(thread?.threadId || '').trim();
      const agentId = String(thread?.agentId || '').trim();
      const headSessionId = String(thread?.headSessionId || '').trim();
      if (!threadId || !agentId) continue;

      // 终局 / 清理 / 冻结 / 关闭：都无「未完成事实」要本模块处理。
      if (Object.hasOwn(archiveEntries, threadId)) {
        skipped.push({ threadId, reason: 'archived' });
        continue;
      }
      if (thread.status === 'closed') {
        skipped.push({ threadId, reason: 'closed' });
        continue;
      }
      if (thread.hold === true) {
        skipped.push({ threadId, reason: 'held' });
        continue;
      }
      if (!headSessionId) {
        skipped.push({ threadId, reason: 'no_head_session' });
        continue;
      }

      // listThreads 是摘要视图（无 commands / deleting）：终态初筛后按
      // 全量记录判定未完成事实。
      const record = await control.core.getThread(threadId).catch(() => null);
      if (!record) {
        skipped.push({ threadId, reason: 'vanished' });
        continue;
      }
      if (record.deleting === true) {
        skipped.push({ threadId, reason: 'deleting' });
        continue;
      }

      const pendingCount = (Array.isArray(record.commands) ? record.commands : [])
        .filter((command) => command?.status === 'pending').length;

      if (pendingCount > 0) {
        // 欠着活：拉起即可，pending 指令由 runtime-ready 补投链自然消费。
        const wake = await wakeHead(agentId, headSessionId, threadId, failed);
        if (wake) resumed.push({ threadId, action: 'wake_pending_commands', pendingCount });
        continue;
      }

      let boardState;
      try {
        boardState = await control.board.getState(threadId);
      } catch (error) {
        failed.push({ threadId, stage: 'board_state', error: String(error?.message || error) });
        continue;
      }
      if (boardState?.status !== 'running') {
        // idle / failed / waiting_input：无未完成事实。
        skipped.push({ threadId, reason: `board_${boardState?.status || 'missing'}` });
        continue;
      }

      // 干到一半进程没了（running 残留）：拉起 + 空消息续跑。
      // 投递寻址与线程域既有通道同源（thread-controller bridge / input-gateway）：
      // head 会话绑定的 runtime 的 viewerAgentId——ViewerWorker 侧 agentId 由
      // DebugHub 分配（agent-<n>-<pid>），裸 agentId 无命中。
      const wake = await wakeHead(agentId, headSessionId, threadId, failed);
      if (!wake) continue;
      const viewerAgentId = control.resolveSessionViewerId(agentId, headSessionId);
      if (!viewerAgentId) {
        failed.push({ threadId, stage: 'resolve_viewer', error: 'head runtime has no viewer agent id after wake' });
        continue;
      }
      try {
        await submitUserTurn({
          agentId: viewerAgentId,
          text: '',
          kind: 'resume',
          source: 'thread-recovery',
          sourceRef: threadId,
        });
        resumed.push({ threadId, action: 'resume_interrupted_turn' });
      } catch (error) {
        // 拉起已成功但续跑投递失败：进程在、turn 未续——记失败事实，
        // 下次重启时看板仍 running，会再次进入本分支重判。
        failed.push({ threadId, stage: 'resume_turn', error: String(error?.message || error) });
      }
    }

    return { resumed, skipped, failed };
  }

  async function wakeHead(agentId, sessionId, threadId, failed) {
    try {
      const wake = await ensureHeadRuntime(agentId, sessionId);
      if (wake?.ok === false) {
        failed.push({ threadId, stage: 'wake', code: wake.code || 'wake_failed', error: wake.message || '' });
        return false;
      }
      return true;
    } catch (error) {
      failed.push({ threadId, stage: 'wake', error: String(error?.message || error) });
      return false;
    }
  }

  return { resumeInterruptedThreads };
}
