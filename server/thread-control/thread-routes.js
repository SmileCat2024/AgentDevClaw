/**
 * Thread Routes — 工作线程 HTTP API（悬置地基）
 *
 * 提供线程的创建 / 查询 / 指令追加 / head 推进 / 投递尝试 / 取消。
 * 地基阶段无任何前端入口或自动流程调用这些接口——它们是未来
 * 「连续工作」产品化的接线点，注册即休眠。
 *
 * 错误约定：not_found → 404；revision/head 冲突 → 409；参数问题 → 400。
 */

/**
 * @param {import('express').Express} app
 * @param {typeof import('express').json} express
 * @param {object} options
 * @param {import('./thread-controller.js').ThreadController} options.controller
 */
export function setupThreadRoutes(app, express, { controller } = {}) {
  if (!controller) {
    throw new Error('setupThreadRoutes requires a controller');
  }

  const jsonMiddleware = express.json({ limit: '256kb' });

  const _errorResponse = (res, err) => {
    const status = Number(err?.status) || 500;
    const body = {
      ok: false,
      code: err?.code || 'internal_error',
      message: err instanceof Error ? err.message : String(err),
    };
    if (err?.code === 'thread_not_found') {
      return res.status(404).json(body);
    }
    return res.status(status).json(body);
  };

  // ── 列表 ─────────────────────────────────────────────────────────

  app.get('/protoclaw/threads', async (req, res) => {
    try {
      const agentId = String(req.query.agentId || '').trim();
      const threads = await controller.listThreads({ agentId: agentId || undefined });
      res.json({ ok: true, threads });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  // ── 创建 ─────────────────────────────────────────────────────────

  app.post('/protoclaw/threads', jsonMiddleware, async (req, res) => {
    try {
      const { agentId, sessionId, title, mode, workspaceId } = req.body || {};
      const thread = await controller.createThread({ agentId, sessionId, title, mode, workspaceId });
      res.status(201).json({ ok: true, thread });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  // ── 详情 ─────────────────────────────────────────────────────────

  app.get('/protoclaw/threads/:threadId', async (req, res) => {
    try {
      const thread = await controller.getThread(req.params.threadId);
      if (!thread) {
        return res.status(404).json({ ok: false, code: 'thread_not_found', message: 'Thread not found' });
      }
      res.json({ ok: true, thread });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  // ── 指令追加 ─────────────────────────────────────────────────────

  app.post('/protoclaw/threads/:threadId/commands', jsonMiddleware, async (req, res) => {
    try {
      const { kind, text, source, idempotencyKey } = req.body || {};
      const result = await controller.appendCommand({
        threadId: req.params.threadId,
        kind,
        text,
        source,
        idempotencyKey,
      });
      res.status(result.duplicate ? 200 : 201).json({ ok: true, ...result });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  // ── head 推进（会话接力事务入口）────────────────────────────────

  app.post('/protoclaw/threads/:threadId/head', jsonMiddleware, async (req, res) => {
    try {
      const { toSessionId, fromSessionId, expectedRevision, endKind } = req.body || {};
      const thread = await controller.advanceHead({
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

  // ── 投递尝试（地基阶段恒返回 bridge_disabled）────────────────────

  app.post('/protoclaw/threads/:threadId/deliver', jsonMiddleware, async (req, res) => {
    try {
      const result = await controller.deliverPendingCommands(req.params.threadId);
      res.json({ ok: true, ...result });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  // ── 取消 ─────────────────────────────────────────────────────────

  app.post('/protoclaw/threads/:threadId/cancel', jsonMiddleware, async (req, res) => {
    try {
      const { reason } = req.body || {};
      const thread = await controller.cancelThread(req.params.threadId, { reason });
      res.json({ ok: true, thread });
    } catch (err) {
      _errorResponse(res, err);
    }
  });
}
