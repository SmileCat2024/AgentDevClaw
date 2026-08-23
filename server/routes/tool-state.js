/**
 * Tool / Feature enable-disable control routes.
 *
 * Sends IPC messages to the explicitly targeted agent runtime to toggle tool
 * or feature enabled state at runtime (no restart). It never broadcasts to
 * another session or derives a target from page focus.
 */
import express from 'express';
import { sendIPCtoSession, sendIPCToRuntime } from '../shared/ipc.js';
import { getRuntimeByViewerAgentId } from '../shared/agent-access.js';
import { resolveRuntimeControlTarget } from '../shared/operation-target.js';

export function setupToolStateRoutes(app) {
  const jsonMiddleware = express.json();

  app.post('/protoclaw/agent/tool_state', jsonMiddleware, async (req, res, next) => {
    try {
      const { scope, action } = req.body || {};
      let target;
      try {
        target = resolveRuntimeControlTarget(req.body);
      } catch (error) {
        return res.status(error.status || 400).json({ error: error.message, code: error.code });
      }
      const { agentId, runtimeId, sessionId } = target;

      // 公共校验
      if (action !== 'enable' && action !== 'disable') {
        return res.status(400).json({ error: 'action must be "enable" or "disable"' });
      }

      // 按 scope 分支校验（discriminated union）
      let message;
      if (scope === 'hook') {
        const { lifecycle, featureName, methodName } = req.body;
        if (!lifecycle || typeof lifecycle !== 'string') {
          return res.status(400).json({ error: 'lifecycle is required for scope="hook"' });
        }
        if (!featureName || typeof featureName !== 'string') {
          return res.status(400).json({ error: 'featureName is required for scope="hook"' });
        }
        if (!methodName || typeof methodName !== 'string') {
          return res.status(400).json({ error: 'methodName is required for scope="hook"' });
        }
        message = { type: 'tool-state', scope: 'hook', lifecycle, featureName, methodName, action };
      } else {
        // scope='tool' | 'feature'（默认 tool）
        const { name } = req.body;
        if (!name || typeof name !== 'string') {
          return res.status(400).json({ error: 'name is required' });
        }
        const resolvedScope = scope === 'feature' ? 'feature' : 'tool';
        message = { type: 'tool-state', scope: resolvedScope, name, action };
      }
      let delivered = 0;

      // Priority 1: runtimeId (viewerAgentId)
      if (runtimeId && typeof runtimeId === 'string') {
        const rt = getRuntimeByViewerAgentId(runtimeId);
        if (rt && rt.process && rt.process.exitCode === null && !rt.stopped) {
          try {
            delivered = sendIPCToRuntime(rt, message) ? 1 : 0;
          } catch (err) {
            console.warn(`[tool_state] IPC failed for runtimeId ${runtimeId}: ${err}`);
          }
        }
      }

      // Priority 2: agentId + sessionId
      if (!delivered && sessionId && typeof sessionId === 'string') {
        delivered = sendIPCtoSession(agentId, sessionId, message) ? 1 : 0;
      }

      // No broadcast fallback: runtime controls must not affect another
      // session when the explicitly named runtime is unavailable.

      if (!delivered) {
        return res.status(503).json({ error: 'No running agent process found' });
      }

      res.json({ ok: true, agentId, scope: message.scope, action, delivered });
    } catch (error) {
      next(error);
    }
  });
}
