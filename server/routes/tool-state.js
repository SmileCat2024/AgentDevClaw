/**
 * Tool / Feature enable-disable control routes.
 *
 * Sends IPC messages to the agent child process to toggle tool or feature
 * enabled state at runtime (no restart). Mirrors the swap-model IPC pattern.
 */
import express from 'express';
import { sendIPCtoSession, sendIPCToAllSessions, sendIPCToRuntime } from '../shared/ipc.js';
import { getRuntimeByViewerAgentId } from '../shared/agent-access.js';

export function setupToolStateRoutes(app) {
  const jsonMiddleware = express.json();

  app.post('/protoclaw/agent/tool_state', jsonMiddleware, async (req, res, next) => {
    try {
      const { agentId, runtimeId, sessionId, scope, name, action } = req.body || {};

      if (!agentId || typeof agentId !== 'string') {
        return res.status(400).json({ error: 'agentId is required' });
      }
      if (!name || typeof name !== 'string') {
        return res.status(400).json({ error: 'name is required' });
      }
      if (action !== 'enable' && action !== 'disable') {
        return res.status(400).json({ error: 'action must be "enable" or "disable"' });
      }
      const resolvedScope = scope === 'feature' ? 'feature' : 'tool';

      const message = { type: 'tool-state', scope: resolvedScope, name, action };
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

      // Last resort: broadcast
      if (!delivered) {
        delivered = sendIPCToAllSessions(agentId, message);
      }

      if (!delivered) {
        return res.status(503).json({ error: 'No running agent process found' });
      }

      res.json({ ok: true, agentId, scope: resolvedScope, name, action, delivered });
    } catch (error) {
      next(error);
    }
  });
}
