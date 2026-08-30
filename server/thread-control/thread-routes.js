/**
 * Thread Routes — 工作线程 HTTP API
 *
 * 提供线程的创建 / 查询 / 指令追加 / head 推进 / 投递尝试 / 取消，
 * 以及归档（收纳语义：线程层标记，成员会话不动，拒绝新投递）。
 *
 * 宿主判定是会话级的（host-agents.js：agent + sessionType 组合）；
 * 生命状态为推导值（thread-life-state.js 四态合成），随列表/详情响应附带。
 *
 * 错误约定：not_found → 404；revision/head 冲突 → 409；参数问题 → 400；
 * 已归档线程收新指令 → 409 thread_archived；运行中归档 → 409 thread_busy。
 */

import { synthesizeThreadLifeState } from './thread-life-state.js';

/**
 * @param {import('express').Express} app
 * @param {typeof import('express').json} express
 * @param {object} options
 * @param {{ core: import('@agentdevjs/core').WorkThread, board: import('@agentdevjs/core').WorkThreadBoard, archive: import('./thread-archive.js').ThreadArchiveIndex }} options.control
 * @param {{ archiveThread: Function, unarchiveThread: Function }} options.lifecycle
 * @param {import('express').Express} app
 * @param {typeof import('express').json} express
 * @param {object} options
 * @param {{ core: import('@agentdevjs/core').WorkThread, board: import('@agentdevjs/core').WorkThreadBoard, archive: import('./thread-archive.js').ThreadArchiveIndex }} options.control
 * @param {{ archiveThread: Function, unarchiveThread: Function }} options.lifecycle
 * @param {Function} [options.tryDeliver] 指令追加后的即时投递（经 delivery-consumer 消费面；不传则只入箱不投递）
 * @param {Function} [options.ensureHeadRuntime] head runtime 就绪闸：head runtime 不在时
 *   由宿主唤起（startManagedAgent + ready 等待）；返回 { ok: true } 或 { ok: false, code, message }。
 *   就绪闸失败时指令仍入箱（等下一次触发点），但响应带 runtimeWake 失败事实。
 */
export function setupThreadRoutes(app, express, { control, lifecycle, resolveSessionOpenDirectory, tryDeliver, ensureHeadRuntime } = {}) {
  if (!control?.core || !control?.board || !control?.archive) {
    throw new Error('setupThreadRoutes requires a control ({core, board, archive})');
  }
  const { core, board, archive } = control;
  const lifecycleService = lifecycle || {
    archiveThread: async (threadId) => {
      const thread = await core.getThread(threadId);
      if (!thread) throw Object.assign(new Error('Thread not found'), { code: 'thread_not_found', status: 404 });
      const boardState = await board.getState(threadId).catch(() => null);
      const life = synthesizeThreadLifeState({ thread, boardState });
      if (life.lifeState === 'executing' || life.lifeState === 'pending-commands') {
        throw Object.assign(new Error(`线程当前状态为 ${life.lifeState}，请先中断再归档`), { code: 'thread_busy', status: 409 });
      }
      const entry = await archive.archive(threadId);
      return { threadId, archivedAt: entry.archivedAt };
    },
    unarchiveThread: async (threadId) => {
      const thread = await core.getThread(threadId);
      if (!thread) throw Object.assign(new Error('Thread not found'), { code: 'thread_not_found', status: 404 });
      await archive.unarchive(threadId);
      return { threadId, archivedAt: null, runtimeStarted: false };
    },
  };

  /** 为线程附带合成生命状态（归档标记 + 看板状态 + 锚点指令拼装）。 */
  const _attachLifeState = async (thread, archiveEntries) => {
    const boardState = await board.getState(thread.threadId).catch(() => null);
    const life = synthesizeThreadLifeState({
      thread,
      boardState,
      archiveEntry: archiveEntries?.[thread.threadId] || null,
    });
    return { ...thread, ...life };
  };

  const _getArchiveEntries = () => archive.list().catch(() => ({}));

  const _assertNotArchived = async (threadId) => {
    // 归档判定走 archive 单点（与 gateway / ACP resume 共享同一事实）
    const rejection = await archive.resolveCommandRejection(threadId);
    if (rejection) {
      const err = new Error('线程已归档，拒绝新投递（如需继续请新建线程或先取消归档）');
      err.status = rejection.status;
      err.code = rejection.code;
      throw err;
    }
  };

  const jsonMiddleware = express.json({ limit: '256kb' });

  const _errorResponse = (res, err) => {
    const status = Number(err?.status) || 500;
    const body = {
      ok: false,
      code: err?.code || 'internal_error',
      message: err instanceof Error ? err.message : String(err),
    };
    if (err?.code === 'thread_not_found' || err?.code === 'workthread_not_found') {
      return res.status(404).json(body);
    }
    return res.status(status).json(body);
  };

  // ── 列表 ─────────────────────────────────────────────────────────

  app.get('/protoclaw/threads', async (req, res) => {
    try {
      const agentId = String(req.query.agentId || '').trim();
      const threads = await core.listThreads({ agentId: agentId || undefined });
      const archiveEntries = await _getArchiveEntries();
      const withLife = await Promise.all(
        threads.map(async (thread) => {
          const withState = await _attachLifeState(thread, archiveEntries);
          // head 会话的 viewer runtime id：前端「中断此线程」的路由目标
          //（runtime 未运行时为 null，中断入口据此置灰）。
          const headViewerAgentId = typeof control.resolveSessionViewerId === 'function'
            ? control.resolveSessionViewerId(withState.agentId, withState.headSessionId)
            : null;
          // head 会话的项目目录：PH 项目卡片的 coder tab 按此归属线程
          const headProjectDir = typeof resolveSessionOpenDirectory === 'function'
            ? (await resolveSessionOpenDirectory(withState.agentId, withState.headSessionId).catch(() => null)) || null
            : null;
          return { ...withState, headViewerAgentId, headProjectDir };
        }),
      );
      res.json({ ok: true, threads: withLife });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  // ── 创建 ─────────────────────────────────────────────────────────

  app.post('/protoclaw/threads', jsonMiddleware, async (req, res) => {
    try {
      const { agentId, sessionId, title, mode, workspaceId } = req.body || {};
      // 锚点创建走 core.start（sessionRef 重组，Q6 清单第 1 项）；
      // mode 归看板（board.setMode）。
      const thread = await core.start({
        sessionRef: { agentId, sessionId },
        title,
        workspaceId,
      });
      if (mode) {
        await board.setMode(thread.threadId, mode);
      }
      res.status(201).json({ ok: true, thread });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  // ── 详情 ─────────────────────────────────────────────────────────

  app.get('/protoclaw/threads/:threadId', async (req, res) => {
    try {
      const thread = await core.getThread(req.params.threadId);
      if (!thread) {
        return res.status(404).json({ ok: false, code: 'thread_not_found', message: 'Thread not found' });
      }
      res.json({ ok: true, thread: await _attachLifeState(thread, await _getArchiveEntries()) });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  // ── runtime session events ───────────────────────────────────────
  // The payload uses the same turn.* event shape consumed by the headless
  // single-session CLI. Only the board interprets state changes (Q6 第 3 项：
  // recordRuntimeEvent 移层看板)。
  app.post('/protoclaw/thread_events', jsonMiddleware, async (req, res) => {
    try {
      const { agentId, sessionId, runtimeInstanceId, event } = req.body || {};
      const result = await board.recordRuntimeEvent({
        agentId,
        sessionId,
        runtimeInstanceId,
        event,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  app.get('/protoclaw/threads/:threadId/events', async (req, res) => {
    try {
      // 加法式附加 eventId / receivedAt（ticket 018）：board 查询 API 只返回
      // 裸事件（信封字段被剥掉），这里直接读看板状态并按与
      // board.getExecutionEvents 相同的绝对游标窗口语义（ticket 017：
      // cursor = baseOffset + 窗口长度；after 落后于窗口起点时 clamp 到 0）
      // 切片，逐事件附加上信封字段。单次读状态，避免两次查询间的竞态；
      // 游标语义变更时与 board.getExecutionEvents 同步。
      const state = await board.getState(req.params.threadId);
      if (!state) {
        res.json({ ok: true, events: [], cursor: 0 });
        return;
      }
      const entries = Array.isArray(state.executionEvents) ? state.executionEvents : [];
      const baseOffset = Math.max(0, Number(state.executionEventBaseOffset) || 0);
      const after = Math.max(0, Number(req.query.after) || 0);
      const from = after < baseOffset ? 0 : after - baseOffset;
      res.json({
        ok: true,
        events: entries.slice(from).map((entry) => ({
          ...(entry?.event || {}),
          eventId: entry?.eventId,
          receivedAt: entry?.receivedAt,
        })),
        cursor: baseOffset + entries.length,
      });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  // ── 指令追加 ─────────────────────────────────────────────────────

  app.post('/protoclaw/threads/:threadId/commands', jsonMiddleware, async (req, res) => {
    try {
      const { kind, text, source, idempotencyKey } = req.body || {};
      await _assertNotArchived(req.params.threadId);
      const thread = await core.getThread(req.params.threadId);
      if (!thread) {
        return res.status(404).json({ ok: false, code: 'thread_not_found', message: 'Thread not found' });
      }
      // head runtime 就绪闸：runtime 消失（进程退出 / server 重启清空）后
      // 指令入箱只会滞留——投递触发点全部依赖"runtime 会 ready"的事件，
      // 而进程死亡后不会再有该事件。入箱前先经宿主唤起 head runtime；
      // 唤起失败时指令仍入箱（幂等键保留），响应携带失败事实供调用方
      // 区分"已投递"与"滞留无承接"，不再静默等待一个不会来的 ready。
      let runtimeWake = null;
      if (typeof ensureHeadRuntime === 'function' && thread.headSessionId) {
        const wake = await ensureHeadRuntime(thread.agentId, thread.headSessionId).catch((error) => ({
          ok: false,
          code: 'runtime_wake_failed',
          message: String(error?.message || error),
        }));
        if (!wake?.ok) {
          runtimeWake = { ok: false, code: wake?.code || 'runtime_wake_failed', message: wake?.message || 'head runtime not available' };
        }
      }
      const result = await core.appendCommand({
        threadId: req.params.threadId,
        kind,
        text,
        source,
        idempotencyKey,
      });
      // head runtime 已就绪时即时投递（successor 已接棒的场景）；
      // 未就绪保持 pending，等 head 推进时投递。即时投递统一经
      // delivery-consumer 消费面（线程级退避 / 水位检查同源），与
      // gateway / runtime-ready / advance 后投递共享同一套行为。
      let delivery = null;
      if (!result.duplicate && typeof tryDeliver === 'function') {
        delivery = await tryDeliver(req.params.threadId);
      }
      res.status(result.duplicate ? 200 : 201).json({
        ok: true,
        ...result,
        delivery,
        ...(runtimeWake ? { runtimeWake } : {}),
      });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  // ── head 推进（会话接力事务入口）────────────────────────────────

  app.post('/protoclaw/threads/:threadId/head', jsonMiddleware, async (req, res) => {
    try {
      const { toSessionId, fromSessionId, expectedRevision, endKind } = req.body || {};
      const thread = await core.advanceHead({
        threadId: req.params.threadId,
        toSessionId,
        fromSessionId,
        expectedRevision,
        endKind,
      });
      res.json({ ok: true, thread });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  // ── 投递尝试（显式触发；交接中 / runtime 未就绪时指令保持 pending）──

  app.post('/protoclaw/threads/:threadId/deliver', jsonMiddleware, async (req, res) => {
    try {
      await _assertNotArchived(req.params.threadId);
      let result = await core.deliverPendingCommands(req.params.threadId);
      // 与 send 同源的恢复闸：裸投递撞上 runtime_not_accepting（head runtime
      // 不在）时先唤起再重投一次，deliver 从"只会重复报错的手动动作"变成
      // 与 send 一致的恢复路径。唤起失败时保留首次结果并附 runtimeWake 事实。
      let runtimeWake = null;
      const notAccepting = result?.reason === 'runtime_not_accepting' || (result?.results || []).some((r) => r.reason === 'runtime_not_accepting');
      if (notAccepting && typeof ensureHeadRuntime === 'function') {
        const thread = await core.getThread(req.params.threadId);
        if (thread?.headSessionId && thread?.status === 'open') {
          const wake = await ensureHeadRuntime(thread.agentId, thread.headSessionId).catch((error) => ({
            ok: false,
            code: 'runtime_wake_failed',
            message: String(error?.message || error),
          }));
          if (wake?.ok) {
            result = await core.deliverPendingCommands(req.params.threadId);
          } else {
            runtimeWake = { ok: false, code: wake?.code || 'runtime_wake_failed', message: wake?.message || 'head runtime not available' };
          }
        }
      }
      res.json({ ok: true, ...result, ...(runtimeWake ? { runtimeWake } : {}) });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  // ── 交接失败 / 恢复 ───────────────────────────────────────────────

  app.post('/protoclaw/threads/:threadId/handoff-failed', jsonMiddleware, async (req, res) => {
    try {
      const { reason, stage, error } = req.body || {};
      const thread = await core.failSessionHandoff(req.params.threadId, { reason, stage, error });
      res.json({ ok: true, thread });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  // 恢复（Q6 第 2 项：移层看板，board 只允许 failed / waiting_input 恢复；
  // 锚点域 rotation_failed 的残局收拾由宿主接力路径负责，不经此端点）
  app.post('/protoclaw/threads/:threadId/resume', jsonMiddleware, async (req, res) => {
    try {
      const boardState = await board.resume(req.params.threadId, {
        source: req.body?.source || 'api',
      });
      res.json({ ok: true, board: boardState });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  // ── 归档（跨 Thread / Board / Runtime 的生命周期事务）────────────
  app.post('/protoclaw/threads/:threadId/archive', jsonMiddleware, async (req, res) => {
    try {
      const result = await lifecycleService.archiveThread(req.params.threadId, {
        reason: req.body?.reason || 'user_archive',
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  app.post('/protoclaw/threads/:threadId/unarchive', jsonMiddleware, async (req, res) => {
    try {
      const result = await lifecycleService.unarchiveThread(req.params.threadId);
      res.json({ ok: true, ...result });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  // ── 关闭（锚点终态：调度侧清理，如 ACP 创建回滚 / head 会话删除）──

  app.post('/protoclaw/threads/:threadId/close', jsonMiddleware, async (req, res) => {
    try {
      const { reason } = req.body || {};
      const thread = await core.closeThread(req.params.threadId, { reason });
      res.json({ ok: true, thread });
    } catch (err) {
      _errorResponse(res, err);
    }
  });
}
