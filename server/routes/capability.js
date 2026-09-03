/**
 * Capability control-plane routes: the host half of the session capability
 * registry. Feature commands live inside the agent runtime process; these
 * routes are the generic transport that replaces per-feature IPC branches
 * (force-continuation / context-guard style request/ack links).
 *
 *   GET  /protoclaw/commands          → host command names + session commands
 *   POST /protoclaw/capability_invoke → invoke one session command
 */

import { getAgentRuntime } from '../shared/agent-access.js';
import { resolveRuntimeControlTarget } from '../shared/operation-target.js';
import { bareId, resolveForwardHostTarget, forwardProtoclawRoute, readForwardTargetError } from '../shared/remote-forward.js';
import { buildLocalFailureResponse, readOperationMetadata } from '../shared/operation-contract.js';

// ADR-0011：远程写幂等闸。远程目标 + 无 idempotencyKey → 400 且请求不过隧道；
// 本地路径保持现状不强制（session.js 同族契约）。
function requireRemoteIdempotencyKey(req, res, metadata = {}) {
  const requestMetadata = readOperationMetadata(req);
  if (requestMetadata.idempotencyKey) return true;
  res.status(400).json({
    ok: false,
    code: 'idempotency_key_required',
    retryable: false,
    operationId: requestMetadata.operationId || metadata.operationId || null,
    message: 'Remote write operations require an idempotency key (x-idempotency-key)',
    error: 'Remote write operations require an idempotency key (x-idempotency-key)',
  });
  return false;
}

// Host-domain commands execute in the browser (they mirror right-click
// actions over existing routes), so the server only enumerates their names
// for consumers without a UI (headless CLI / future bridge). The frontend
// keeps its own registrations with handlers and localized descriptions.
const HOST_COMMANDS = [
  { name: 'trim', destination: 'host' },
  { name: 'summary', destination: 'host' },
];

function requestCapabilityState(agentId, sessionId, message, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const runtime = getAgentRuntime(agentId, sessionId);
    const child = runtime?.process;
    if (!runtime || runtime.stopped || !child || child.exitCode !== null
      || typeof child.send !== 'function' || typeof child.on !== 'function') {
      resolve({ ok: false, error: 'session runtime not connected' });
      return;
    }
    const requestId = `capability-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener?.('message', onMessage);
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: 'capability-result IPC timeout' }),
      timeoutMs,
    );
    // Triple match (type + requestId + sessionId): a shared child process
    // multiplexes sessions, so answers for another session must not leak in.
    const onMessage = (msg) => {
      if (!msg || msg.type !== 'capability-result') return;
      if (msg.requestId !== requestId || msg.sessionId !== sessionId) return;
      finish({
        ok: msg.ok === true,
        ...(msg.ok === true
          ? { commands: msg.commands, result: msg.result }
          // registry 结果的错误在 message(+code) 字段；capability-ipc 的
          // 传输层错误在 error 字段。两者都透传，避免只剩 fallback 文案。
          : {
            error: [msg.code, msg.message || msg.error]
              .filter(Boolean).join(': ') || 'capability request rejected',
          }),
      });
    };
    child.on('message', onMessage);
    let sent = false;
    try {
      sent = child.send({ ...message, requestId, __targetSessionId: sessionId });
    } catch {
      sent = false;
    }
    if (!sent) finish({ ok: false, error: 'failed to deliver session IPC' });
  });
}

export function setupCapabilityRoutes(app, express) {
  app.get('/protoclaw/commands', async (req, res, next) => {
    try {
      const { agentId, runtimeId, sessionId } = req.query || {};
      // Without a session target only host commands are enumerable —
      // feature commands belong to one runtime process.
      if (!agentId || (!runtimeId && !sessionId)) {
        return res.json({ ok: true, host: HOST_COMMANDS, commands: [] });
      }
      let target;
      try {
        target = resolveRuntimeControlTarget(req.query);
      } catch (error) {
        return res.status(error.status || 400).json({ ok: false, error: error.message, code: error.code });
      }
      // ADR-0011：远程命名空间身份 → 转发远程同名 commands 路由（query 裸 id，
      // 命令清单来自远程会话 registry 真实返回，远程端自己走它的 runtime IPC）；
      // 本地身份走下方既有 IPC 路径，行为字节级不动。GET 只读，无幂等闸。
      try {
        const hostTarget = resolveForwardHostTarget(target.runtimeId, target.agentId, target.sessionId);
        if (hostTarget.scope === 'remote') {
          const params = new URLSearchParams({ agentId: bareId(target.agentId) });
          if (target.runtimeId) params.set('runtimeId', bareId(target.runtimeId));
          if (target.sessionId) params.set('sessionId', bareId(target.sessionId));
          return await forwardProtoclawRoute(res, hostTarget, `/protoclaw/commands?${params.toString()}`);
        }
      } catch (error) {
        return res.status(readForwardTargetError(error)).json(buildLocalFailureResponse(error));
      }
      // Route to the exact (agentId, sessionId) runtime; when the control
      // target addressed a runtimeId without a sessionId, resolve the
      // runtime's selected session instead of guessing a primary fallback.
      const runtime = getAgentRuntime(target.agentId, target.sessionId || undefined);
      const effectiveSessionId = target.sessionId || runtime?.selectedSessionId;
      if (!effectiveSessionId) {
        return res.json({ ok: true, host: HOST_COMMANDS, commands: [] });
      }
      const result = await requestCapabilityState(target.agentId, effectiveSessionId, {
        type: 'capability-list-request',
        entryPoint: 'slash',
      }, { timeoutMs: 3000 });
      if (!result.ok) {
        // A disconnected runtime still yields host commands; the slash menu
        // simply shows the host subset until the session runtime is back.
        return res.json({ ok: true, host: HOST_COMMANDS, commands: [], warning: result.error });
      }
      res.json({ ok: true, host: HOST_COMMANDS, commands: result.commands || [] });
    } catch (error) {
      next(error);
    }
  });

  app.post('/protoclaw/capability_invoke', express.json(), async (req, res, next) => {
    try {
      const { ref, args } = req.body || {};
      if (typeof ref !== 'string' || !ref.trim()) {
        return res.status(400).json({ ok: false, error: 'ref is required' });
      }
      if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
        return res.status(400).json({ ok: false, error: 'args must be an object' });
      }
      let target;
      try {
        target = resolveRuntimeControlTarget(req.body);
      } catch (error) {
        return res.status(error.status || 400).json({ ok: false, error: error.message, code: error.code });
      }
      if (!target.sessionId) {
        return res.status(400).json({ ok: false, error: 'sessionId is required' });
      }
      // ADR-0011：远程命名空间身份 → 转发远程同名 invoke 路由（裸 id，命令在
      // 远程会话 registry 内执行，远程端做自己的 IPC 与 body 校验）；本地身份
      // 走下方既有 IPC 路径，行为字节级不动。远程写强制幂等键（本地路径保持
      // 现状不强制）。
      try {
        const hostTarget = resolveForwardHostTarget(target.runtimeId, target.agentId, target.sessionId);
        if (hostTarget.scope === 'remote') {
          if (!requireRemoteIdempotencyKey(req, res)) return;
          return await forwardProtoclawRoute(res, hostTarget, '/protoclaw/capability_invoke', {
            method: 'POST',
            body: {
              ...(req.body || {}),
              agentId: bareId(target.agentId),
              runtimeId: bareId(target.runtimeId),
              sessionId: bareId(target.sessionId),
            },
          });
        }
      } catch (error) {
        return res.status(readForwardTargetError(error)).json(buildLocalFailureResponse(error));
      }
      // Route to the exact (agentId, sessionId) runtime only — no fallback:
      // a shared process must never invoke another session's capability.
      const result = await requestCapabilityState(target.agentId, target.sessionId, {
        type: 'capability-invoke',
        ref: ref.trim(),
        args: args || {},
      });
      if (!result.ok) return res.status(503).json({ ok: false, error: result.error });
      res.json({ ok: true, agentId: target.agentId, sessionId: target.sessionId, result: result.result ?? null });
    } catch (error) {
      next(error);
    }
  });
}
