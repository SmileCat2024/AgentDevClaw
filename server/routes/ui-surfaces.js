/**
 * UI Surface 路由
 *
 * Agent Feature 和 Web UI 共用同一 Store，但能力分开：
 * - Feature (PUT/DELETE): 校验并 upsert/close
 * - Web (GET/POST action): 查询 registry / 显式提交动作
 *
 * 所有写请求在服务端再次执行 Spec 校验，不依赖工具侧 schema。
 */

import { UISurfaceStore } from '../ui-surface-store.js';
import { deliverUserInput, UserTurnDeliveryError } from '../thread-control/input-gateway.js';
import { validateGenerativeUISpec } from '../../local-features/dist/generative-ui/src/validator.js';
import { UI_LIMITS } from '../../local-features/dist/generative-ui/src/types.js';

/** 单例 Store */
const store = new UISurfaceStore({ maxSurfaces: UI_LIMITS.maxSurfacesPerAgent });

export function getUISurfaceStore() {
  return store;
}

/**
 * @param {import('express').Express} app
 * @param {typeof import('express').json} express
 */
export function setupUISurfaceRoutes(app, express) {
  // ═══════════════════════════════════════════════════════════════
  // PUT — Feature upsert
  // ═══════════════════════════════════════════════════════════════

  app.put('/protoclaw/agents/:agentId/ui-surfaces/:surfaceId', express.json({ limit: '512kb' }), async (req, res) => {
    const { agentId, surfaceId } = req.params;
    const body = req.body || {};

    // 基本参数检查
    if (!agentId || typeof agentId !== 'string') {
      return res.status(400).json({ ok: false, code: 'invalid_spec', message: 'agentId is required' });
    }
    if (!surfaceId || typeof surfaceId !== 'string') {
      return res.status(400).json({ ok: false, code: 'invalid_spec', message: 'surfaceId is required' });
    }
    if (!UI_LIMITS.idPattern.test(surfaceId)) {
      return res.status(400).json({ ok: false, code: 'invalid_spec', message: `surfaceId "${surfaceId}" is invalid` });
    }

    // body 大小限制（二次检查，express limit 之外再做一次）
    const bodyBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    if (bodyBytes > UI_LIMITS.maxSpecBytes) {
      return res.status(413).json({ ok: false, code: 'payload_too_large', message: `Spec too large: ${bodyBytes} bytes` });
    }

    const { spec, expectedRevision, presentation } = body;

    if (!spec || typeof spec !== 'object') {
      return res.status(400).json({ ok: false, code: 'invalid_spec', message: 'spec is required and must be an object' });
    }

    // 服务端二次校验
    const validation = validateGenerativeUISpec(spec);
    if (!validation.valid) {
      return res.status(400).json({
        ok: false,
        code: 'invalid_spec',
        message: 'Spec validation failed',
        errors: validation.errors,
      });
    }

    // upsert
    const result = store.upsert(agentId, surfaceId, spec, {
      expectedRevision: typeof expectedRevision === 'number' ? expectedRevision : undefined,
      presentation: presentation || { open: 'if-empty' },
    });

    if (result.conflict === 'revision_conflict') {
      return res.status(409).json({
        ok: false,
        code: 'revision_conflict',
        message: `Expected revision ${expectedRevision}, current is ${result.record.revision}`,
      });
    }

    if (result.conflict === 'surface_limit') {
      return res.status(400).json({
        ok: false,
        code: 'surface_limit',
        message: `Maximum active surfaces (${UI_LIMITS.maxSurfacesPerAgent}) reached for this agent`,
      });
    }

    const record = result.record;
    const response = {
      ok: true,
      surface: {
        surfaceId: record.surfaceId,
        revision: record.revision,
        status: record.status,
        placement: 'right-panel',
        changed: result.changed,
      },
    };

    // ETag
    const etag = `"${record.contentHash}"`;
    res.set('ETag', etag);
    res.status(result.changed ? 201 : 200).json(response);
  });

  // ═══════════════════════════════════════════════════════════════
  // GET — registry (Feature / Web)
  // ═══════════════════════════════════════════════════════════════

  app.get('/protoclaw/agents/:agentId/ui-surfaces', (req, res) => {
    const { agentId } = req.params;
    const includeClosed = req.query.includeClosed === 'true';
    const includeSpec = req.query.includeSpec === 'true';

    if (includeSpec) {
      const registry = store.getRegistry(agentId, { includeClosed });
      const etag = `"r${registry.registryRevision}"`;

      // ETag / 304
      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }
      res.set('ETag', etag);
      return res.json(registry);
    }

    // 默认只返回 summaries
    const { surfaces, registryRevision } = store.list(agentId, { includeClosed });
    const etag = `"r${registryRevision}"`;

    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
    res.set('ETag', etag);
    res.json({ agentId, registryRevision, surfaces });
  });

  // ═══════════════════════════════════════════════════════════════
  // GET — single surface (Feature)
  // ═══════════════════════════════════════════════════════════════

  app.get('/protoclaw/agents/:agentId/ui-surfaces/:surfaceId', (req, res) => {
    const { agentId, surfaceId } = req.params;
    const record = store.get(agentId, surfaceId);

    if (!record) {
      return res.status(404).json({ ok: false, code: 'not_found', message: `Surface "${surfaceId}" not found` });
    }

    res.json({
      ok: true,
      surface: {
        surfaceId: record.surfaceId,
        revision: record.revision,
        status: record.status,
        spec: record.spec,
        updatedAt: record.updatedAt,
      },
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // DELETE — close (Feature)
  // ═══════════════════════════════════════════════════════════════

  app.delete('/protoclaw/agents/:agentId/ui-surfaces/:surfaceId', (req, res) => {
    const { agentId, surfaceId } = req.params;
    const expectedRevision = req.query.expectedRevision ? Number(req.query.expectedRevision) : undefined;

    const result = store.close(agentId, surfaceId, {
      expectedRevision: typeof expectedRevision === 'number' && !isNaN(expectedRevision) ? expectedRevision : undefined,
    });

    if (!result.ok && result.conflict) {
      return res.status(409).json({ ok: false, code: 'revision_conflict', message: 'Revision mismatch' });
    }

    res.json({ ok: true, surfaceId, alreadyClosed: result.alreadyClosed });
  });

  // ═══════════════════════════════════════════════════════════════
  // POST — action (Web: 显式提交给 Agent)
  // ═══════════════════════════════════════════════════════════════

  app.post('/protoclaw/agents/:agentId/ui-surfaces/:surfaceId/actions/:actionId', express.json({ limit: '128kb' }), async (req, res) => {
    const { agentId, surfaceId, actionId } = req.params;
    const body = req.body || {};
    const { eventId, surfaceRevision, values } = body;

    // eventId 必填
    if (!eventId || typeof eventId !== 'string' || eventId.length > 512) {
      return res.status(400).json({ ok: false, code: 'invalid_request', message: 'eventId must be a non-empty string up to 512 characters' });
    }

    // surfaceRevision 必填
    if (!Number.isInteger(surfaceRevision) || surfaceRevision < 1) {
      return res.status(400).json({ ok: false, code: 'invalid_request', message: 'surfaceRevision must be a positive integer' });
    }

    if (values !== undefined && (values === null || typeof values !== 'object' || Array.isArray(values))) {
      return res.status(400).json({ ok: false, code: 'invalid_request', message: 'values must be an object when provided' });
    }
    if (values !== undefined) {
      const valuesBytes = Buffer.byteLength(JSON.stringify(values), 'utf8');
      if (valuesBytes > UI_LIMITS.maxSubmitValueBytes) {
        return res.status(413).json({
          ok: false,
          code: 'payload_too_large',
          message: `Submitted values exceed ${UI_LIMITS.maxSubmitValueBytes} bytes`,
        });
      }
    }

    // 服务端二次校验 action
    const actionResult = store.validateAction(agentId, surfaceId, actionId, surfaceRevision, values);
    if (!actionResult.valid) {
      const statusMap = {
        not_found: 404,
        surface_closed: 400,
        stale_surface: 409,
        action_not_found: 400,
        field_not_allowed: 400,
      };
      return res.status(statusMap[actionResult.error] || 400).json({
        ok: false,
        code: actionResult.error,
        message: actionResult.message || actionResult.error,
      });
    }

    const eventKey = `${agentId}\u0000${surfaceId}\u0000${actionId}\u0000${eventId}`;
    const reservation = store.beginEvent(eventKey);
    if (!reservation.accepted) {
      if (reservation.status === 'completed' && reservation.result) {
        return res.json(reservation.result);
      }
      return res.status(409).json({
        ok: false,
        code: 'event_in_progress',
        message: 'This eventId is already being processed',
      });
    }

    // 构造用户可读、Agent 可解析的规范消息
    const action = actionResult.action;
    const record = actionResult.record;
    const fieldValues = {};
    if (values) {
      for (const fname of actionResult.allowedFields || []) {
        if (Object.prototype.hasOwnProperty.call(values, fname)) {
          fieldValues[fname] = values[fname];
        }
      }
    }

    const messageText = [
      `通过右侧页面「${record.spec.title || surfaceId}」执行「${action.label}」。`,
      '',
      `surfaceId: ${surfaceId}`,
      `surfaceRevision: ${surfaceRevision}`,
      `actionId: ${actionId}`,
      `values:`,
      JSON.stringify(fieldValues, null, 2),
    ].join('\n');

    // 与聊天输入框保持相同投递语义：空闲时响应 input request，运行中排队；
    // 线程交接窗口（coder 宿主）经统一网关转入 Thread Inbox 暂存。
    try {
      const delivery = await deliverUserInput({
        viewerAgentId: agentId,
        text: messageText,
        source: 'generative-ui',
        sourceRef: eventId,
      });

      const responseBody = {
        ok: true,
        // delivery 判别含 'thread_queued'（交接窗口内已暂存到 Thread Inbox）
        delivery: delivery.delivery,
        queued: delivery.delivery === 'queued',
        requestId: delivery.delivery === 'input' ? delivery.requestId : null,
        queueId: delivery.delivery === 'queued' ? delivery.id : null,
      };
      store.completeEvent(eventKey, responseBody);
      res.json(responseBody);
    } catch (err) {
      store.releaseEvent(eventKey);
      const status = err instanceof UserTurnDeliveryError ? err.status : 502;
      res.status(status).json({
        ok: false,
        code: err instanceof UserTurnDeliveryError ? err.code : 'delivery_failed',
        message: err instanceof Error ? err.message : String(err),
        retryable: err instanceof UserTurnDeliveryError ? err.retryable : true,
      });
    }
  });
}
