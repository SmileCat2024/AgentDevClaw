/**
 * Thread Routes — 工作线程 HTTP API
 *
 * 提供线程的创建 / 查询 / 指令追加 / head 推进 / 投递尝试 / 取消。
 * 当前由 coder（自动化编码智能体）工作空间消费；其他工作空间不创建
 * 线程，本组接口对其不可见。
 *
 * 错误约定：not_found → 404；revision/head 冲突 → 409；参数问题 → 400。
 */

/**
 * @param {import('express').Express} app
 * @param {typeof import('express').json} express
 * @param {object} options
 * @param {{ core: import('@agentdev/core').WorkThread, board: import('@agentdev/core').WorkThreadBoard }} options.control
 */
export function setupThreadRoutes(app, express, { control } = {}) {
  if (!control?.core || !control?.board) {
    throw new Error('setupThreadRoutes requires a control ({core, board})');
  }
  const { core, board } = control;

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
      res.json({ ok: true, threads });
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
      res.json({ ok: true, thread });
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
      const result = await core.appendCommand({
        threadId: req.params.threadId,
        kind,
        text,
        source,
        idempotencyKey,
      });
      // head runtime 已就绪时即时投递（successor 已接棒的场景）；
      // 未就绪保持 pending，等 head 推进时投递。
      let delivery = null;
      if (!result.duplicate) {
        delivery = await core.deliverPendingCommands(req.params.threadId);
      }
      res.status(result.duplicate ? 200 : 201).json({ ok: true, ...result, delivery });
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
      const result = await core.deliverPendingCommands(req.params.threadId);
      res.json({ ok: true, ...result });
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

  // ── 关闭 ─────────────────────────────────────────────────────────

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
