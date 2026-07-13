import {
  APP_PORT, VIEWER_PORT,
} from '../shared/constants.js';
import { sanitizeSessionFragment } from '../shared/string-helpers.js';
import {
  listAgentRuntimes, getAgentRuntime, buildStatus,
} from '../shared/agent-access.js';
import { readProjectIMWorkspaceConfig } from './im.js';
import { sendIPCtoSession } from '../shared/ipc.js';
import { removeOpenSession } from '../shared/open-sessions-tracker.js';
import { createConnectedAgentsQuery } from './agent-connected.js';
import { createAgentStartupFns } from './agent-startup.js';

// ── Agent Lifecycle (orchestration layer) ────────────────────────
// This module wires together three concerns:
//   1. Connected-agents query  → agent-connected.js
//   2. Process startup/wait    → agent-startup.js
//   3. Stop + route handlers   → this file
//
// Factory pattern: sessionApi is a mutable reference object that gets
// filled after session-helpers is created, breaking the circular
// dependency (agent-lifecycle → session-helpers → agent-lifecycle).

export function createAgentLifecycleModule(ctx) {
  const {
    sessionApi,
    getAgents, getAgentsLight, enrichAgent, requireAgentLight,
    resolveRuntimeDisplayName,
    readActiveWorkspaceSessionMeta, readWorkspaceSessionMeta,
    readViewerJson, getPendingInputCount, resolveAgentModelPresets,
  } = ctx;

  const _exitCallbacks = [];

  // ── Connected agents query (delegated to agent-connected.js) ──

  const { getConnectedAgents } = createConnectedAgentsQuery({
    getAgentsLight,
    readActiveWorkspaceSessionMeta,
    readWorkspaceSessionMeta,
    readViewerJson,
    getPendingInputCount,
    resolveAgentModelPresets,
  });

  // ── Startup & wait functions (delegated to agent-startup.js) ──

  const {
    waitForProcessExit,
    waitForManagedRuntimeReady,
    waitForAssemblyRuntimeReady,
    startManagedAgent,
    startOneShotAgent,
    startAssemblyRuntime,
  } = createAgentStartupFns({
    sessionApi,
    getConnectedAgents,
    requireAgentLight,
    resolveRuntimeDisplayName,
    readViewerJson,
    exitCallbacks: _exitCallbacks,
  });

  // ── Stop managed agent ────────────────────────────────────────

  async function stopManagedAgent(agentId, sessionId = undefined) {
    const runtimes = sessionId === undefined ? listAgentRuntimes(agentId) : [getAgentRuntime(agentId, sessionId)].filter(Boolean);
    if (runtimes.length === 0) {
      // No runtime found — still clean up the tracker in case the process
      // already exited and was removed from managedAgents
      if (sessionId) {
        removeOpenSession(agentId, sessionId).catch(() => {});
      }
      return buildStatus(agentId, sessionId);
    }

    for (const runtime of runtimes) {
      if (!runtime?.process || runtime.process.exitCode !== null || runtime.stopped) {
        // Process already exited — still need to clean up the tracker
        if (runtime?.selectedSessionId) {
          removeOpenSession(agentId, runtime.selectedSessionId).catch(() => {});
        }
        continue;
      }
      runtime.stopped = true;
      runtime.process.kill('SIGTERM');
      // Remove from open-sessions tracker (explicit stop)
      if (runtime.selectedSessionId) {
        removeOpenSession(agentId, runtime.selectedSessionId).catch(() => {});
      }
    }
    return buildStatus(agentId, sessionId);
  }

  // ── Route handlers ────────────────────────────────────────────

  function setupRoutes(app, express) {
    app.get('/protoclaw/health', (_req, res) => {
      res.json({ ok: true, appPort: APP_PORT, viewerPort: VIEWER_PORT });
    });

    app.get('/protoclaw/get_prebuilt_agents', async (_req, res, next) => {
      try {
        const agents = await getAgents();
        res.json(agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          description: agent.description,
          icon: agent.icon,
          category: agent.category,
          kind: agent.kind || 'agent',
          launchMode: agent.launchMode || null,
          ui: agent.ui || null,
          features: agent.features || [],
          workspace: agent.workspace || null,
          workspace_sessions: agent.workspace_sessions || { activeSessionId: null, sessions: [] },
          workspace_data: agent.workspace_data || {},
          workspace_state: agent.workspace_state || { forms: {}, openDirectory: '', updatedAt: null },
          active_workspace_session_id: agent.workspace_sessions?.activeSessionId || null,
          modelPresets: agent.modelPresets || null,
          entry_point: agent.relativeDir,
        })));
      } catch (error) {
        next(error);
      }
    });

    app.get('/protoclaw/get_agents_status', async (_req, res, next) => {
      try {
        const agents = await getAgentsLight();
        res.json(agents.map((agent) => ({
          id: agent.id,
          status: buildStatus(agent.id).status,
          pid: buildStatus(agent.id).pid,
        })));
      } catch (error) {
        next(error);
      }
    });

    app.get('/protoclaw/get_connected_agents', async (_req, res, next) => {
      try {
        res.json(await getConnectedAgents());
      } catch (error) {
        next(error);
      }
    });

    app.get('/protoclaw/agent_detail', async (req, res, next) => {
      try {
        const agentId = String(req.query.agentId || '').trim();
        if (!agentId) {
          res.status(400).json({ error: 'agentId is required' });
          return;
        }
        const lightAgents = await getAgentsLight();
        const agent = lightAgents.find((item) => item.id === agentId);
        if (!agent) {
          res.status(404).json({ error: `Unknown agent: ${agentId}` });
          return;
        }
        const enriched = await enrichAgent(agent);
        res.json({
          workspace_sessions: enriched.workspace_sessions || { activeSessionId: null, sessions: [] },
          workspace_data: enriched.workspace_data || {},
          workspace_state: enriched.workspace_state || { forms: {}, openDirectory: '', updatedAt: null },
        });
      } catch (error) {
        next(error);
      }
    });

    app.post('/protoclaw/start_agent', express.json(), async (req, res, next) => {
      try {
        const agent = await requireAgentLight(req.body.agentId);
        if (agent.launchMode === 'ui-only') {
          const connectedAgents = await getConnectedAgents();
          const connected = connectedAgents.find((item) => item.id === agent.id) || null;
          res.json({ status: buildStatus(agent.id), agent: connected });
          return;
        }
        // Block qqbot from starting when no IM channel is selected
        if (sanitizeSessionFragment(agent.id) === 'qqbot') {
          const wsConfig = await readProjectIMWorkspaceConfig();
          if (!wsConfig.selectedChannel) {
            const connectedAgents = await getConnectedAgents();
            const connected = connectedAgents.find((item) => item.id === agent.id) || null;
            res.json({ status: buildStatus(agent.id), agent: connected, warning: '未选择 IM 渠道，门户代理不会启动' });
            return;
          }
        }
        const selectedSessionId = req.body.sessionId || null;
        const status = await startManagedAgent(agent, selectedSessionId);
        const connected = await waitForManagedRuntimeReady(agent.id, 10000, selectedSessionId);
        res.json({ status, agent: connected });
      } catch (error) {
        next(error);
      }
    });

    app.post('/protoclaw/stop_agent', express.json(), async (req, res, next) => {
      try {
        const status = await stopManagedAgent(req.body.agentId, req.body.sessionId);
        res.json(status);
      } catch (error) {
        next(error);
      }
    });

    app.post('/protoclaw/restart_agent', express.json(), async (req, res, next) => {
      try {
        const agent = await requireAgentLight(req.body.agentId);
        // Block qqbot from restarting when no IM channel is selected
        if (sanitizeSessionFragment(agent.id) === 'qqbot') {
          const wsConfig = await readProjectIMWorkspaceConfig();
          if (!wsConfig.selectedChannel) {
            await stopManagedAgent(agent.id, req.body.sessionId || null);
            const connectedAgents = await getConnectedAgents();
            const connected = connectedAgents.find((item) => item.id === agent.id) || null;
            res.json({ status: buildStatus(agent.id), agent: connected, warning: '未选择 IM 渠道，门户代理不会启动' });
            return;
          }
        }
        const selectedSessionId = req.body.sessionId || null;
        await stopManagedAgent(agent.id, selectedSessionId);
        const status = await startManagedAgent(agent, selectedSessionId);
        const connected = await waitForManagedRuntimeReady(agent.id, 10000, selectedSessionId);
        res.json({ status, agent: connected });
      } catch (error) {
        next(error);
      }
    });

    app.post('/protoclaw/todo_control', express.json(), async (req, res, next) => {
      try {
        const { agentId, sessionId, taskId } = req.body || {};
        if (!agentId) {
          return res.status(400).json({ error: 'agentId is required' });
        }
        // Try exact session match first, then fall back to primary runtime
        let sent = false;
        if (sessionId) {
          sent = sendIPCtoSession(agentId, sessionId, {
            type: 'todo-control',
            taskId: taskId || null,
          });
        }
        if (!sent) {
          sent = sendIPCtoSession(agentId, undefined, {
            type: 'todo-control',
            taskId: taskId || null,
          });
        }
        res.json({ ok: sent });
      } catch (error) {
        next(error);
      }
    });
  }

  return {
    getConnectedAgents, waitForProcessExit,
    waitForManagedRuntimeReady, waitForAssemblyRuntimeReady,
    startManagedAgent, startOneShotAgent, startAssemblyRuntime,
    stopManagedAgent,
    setupRoutes,
    onAgentExit: (cb) => { _exitCallbacks.push(cb); },
  };
}
