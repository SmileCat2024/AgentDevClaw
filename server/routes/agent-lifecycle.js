import {
  APP_PORT, VIEWER_PORT,
} from '../shared/constants.js';
import { sanitizeSessionFragment } from '../shared/string-helpers.js';
import {
  listAgentRuntimes, getAgentRuntime, buildStatus, isChildProcessRunning,
} from '../shared/agent-access.js';
import { readProjectIMWorkspaceConfig } from './im.js';
import { sendIPCtoSession } from '../shared/ipc.js';
import { removeOpenSession } from '../shared/open-sessions-tracker.js';
import { createConnectedAgentsQuery } from './agent-connected.js';
import { createAgentStartupFns } from './agent-startup.js';
import { releaseRuntimeState } from '../runtime-call-envelope.js';
import { recordSidebarDiagnosticEvent } from '../shared/sidebar-diagnostics.js';

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

  async function removeSharedSession(runtime) {
    const sessionId = runtime?.selectedSessionId;
    const child = runtime?.process;
    if (!sessionId || !child || typeof child.send !== 'function' || typeof child.on !== 'function') {
      return false;
    }
    if (runtime.stopping) return true;

    runtime.stopping = true;
    const clearAcknowledgementListeners = () => {
      child.removeListener?.('message', onMessage);
      child.removeListener?.('exit', onExit);
    };
    const onMessage = (message) => {
      if (message?.type !== 'session-exited' || message.sessionId !== sessionId) return;
      clearAcknowledgementListeners();
      runtime.stopped = true;
      runtime.stopping = false;
      releaseRuntimeState(runtime.key);
      removeOpenSession(runtime.agentId, sessionId).catch((error) => console.warn(error));
    };
    const onExit = () => {
      clearAcknowledgementListeners();
      runtime.stopped = true;
      runtime.stopping = false;
    };
    child.on('message', onMessage);
    child.once?.('exit', onExit);
    try {
      child.send({ type: 'remove-session', sessionId });
      // `session-exited` is the authoritative acknowledgement. Do not detach
      // its listener after an arbitrary wait: a long-running save/dispose may
      // legitimately complete later, and the runtime must still be recorded as
      // stopped when that acknowledgement arrives.
      return true;
    } catch {
      clearAcknowledgementListeners();
      runtime.stopping = false;
      return false;
    }
  }

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
        removeOpenSession(agentId, sessionId).catch(e => console.warn(e));
      }
      return buildStatus(agentId, sessionId);
    }

    for (const runtime of runtimes) {
      if (!isChildProcessRunning(runtime?.process) || runtime.stopped) {
        // Process already exited — still need to clean up the tracker
        if (runtime?.selectedSessionId) {
          removeOpenSession(agentId, runtime.selectedSessionId).catch(e => console.warn(e));
        }
        continue;
      }

      // Shared-process mode: send IPC remove-session instead of killing the process.
      // Only mark stopped after the host confirms that this session released
      // its Agent and background resources. Killing on a failed acknowledgement
      // would terminate unrelated sibling sessions.
      if (runtime.processGroupKey && runtime.selectedSessionId) {
        const accepted = await removeSharedSession(runtime);
        if (!accepted) {
          console.warn(`[agent-lifecycle] failed to request shared-session stop: ${agentId}::${runtime.selectedSessionId}`);
          continue;
        }
      } else {
        runtime.stopped = true;
        runtime.process.kill('SIGTERM');
      }

      // Isolated processes have been signalled and can be removed from recovery
      // tracking now. Shared sessions are removed only by their later
      // `session-exited` acknowledgement in removeSharedSession().
      if (!runtime.processGroupKey && runtime.selectedSessionId) {
        removeOpenSession(agentId, runtime.selectedSessionId).catch(e => console.warn(e));
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
          processMode: agent.processMode || 'isolated',
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
      const startedAt = Date.now();
      try {
        const agents = await getConnectedAgents();
        res.json(agents);
        void recordSidebarDiagnosticEvent({
          kind: 'read_perf',
          operation: 'get_connected_agents',
          phase: 'completed',
          durationMs: Date.now() - startedAt,
          agentCount: agents.length,
          responseBytes: Number(res.getHeader?.('Content-Length')) || 0,
          result: 'success',
        }, { source: 'server' });
      } catch (error) {
        void recordSidebarDiagnosticEvent({
          kind: 'read_perf',
          operation: 'get_connected_agents',
          phase: 'failed',
          durationMs: Date.now() - startedAt,
          result: 'failed',
          errorCode: error?.code || 'connected_agents_failed',
        }, { source: 'server' });
        next(error);
      }
    });

    // Targeted runtime readiness query. Unlike get_connected_agents this does
    // not enumerate every prebuilt session, so creating/opening one session
    // does not depend on the size of the entire session history.
    app.get('/protoclaw/runtime_status', async (req, res, next) => {
      try {
        const agentId = String(req.query.agentId || '').trim();
        const sessionId = String(req.query.sessionId || '').trim();
        if (!agentId || !sessionId) {
          res.status(400).json({ error: 'agentId and sessionId are required' });
          return;
        }
        const runtime = getAgentRuntime(agentId, sessionId);
        const status = buildStatus(agentId, sessionId);
        const viewerAgentId = String(runtime?.viewerAgentId || status.viewerAgentId || '').trim();
        const viewerData = viewerAgentId
          ? await readViewerJson('/api/agents').catch(() => ({ agents: [] }))
          : { agents: [] };
        const viewerAgent = Array.isArray(viewerData?.agents)
          ? viewerData.agents.find((agent) => String(agent?.id || '') === viewerAgentId) || null
          : null;
        const viewerConnected = viewerAgent?.connected === true;
        const processRunning = isChildProcessRunning(runtime?.process);
        const ready = !!(runtime?.ready && !runtime?.stopped && !runtime?.stopping && processRunning && viewerConnected);
        // The session index can be large. A starting/missing runtime has no
        // agent payload to decorate, so do not reread the index on every
        // readiness poll; resolve metadata only for the ready response.
        const meta = ready ? await readWorkspaceSessionMeta(agentId, sessionId) : null;
        const lifecycle = !runtime
          ? 'missing'
          : runtime.stopping || (runtime.stopped && processRunning)
            ? 'stopping'
            : !processRunning
              ? 'stopped'
              : ready
                ? 'ready'
                : 'starting';
        res.json({
          operationId: String(req.query.operationId || '').trim() || null,
          agentId,
          sessionId,
          lifecycle,
          ready,
          viewerConnected,
          status,
          agent: viewerAgent ? {
            id: viewerAgent.id,
            name: meta?.active_workspace_display_name
              || meta?.active_workspace_agent_name
              || meta?.active_workspace_session_title
              || viewerAgent.name,
            description: viewerAgent.description || '',
            status: viewerConnected ? 'running' : 'stopped',
            source: 'child',
            parent_id: agentId,
            active_workspace_session_id: sessionId,
            active_workspace_session_form_id: meta?.active_workspace_session_form_id || null,
            active_workspace_session_title: meta?.active_workspace_session_title || '',
            active_workspace_agent_name: meta?.active_workspace_agent_name || '',
            active_workspace_display_name: meta?.active_workspace_display_name || '',
            connection_info: viewerAgent.connectionInfo || 'viewer://127.0.0.1:2026',
            pid: viewerAgent.pid || runtime?.process?.pid || null,
            runtime_session_id: viewerAgent.id,
            message_count: viewerAgent.messageCount ?? 0,
            created_at: viewerAgent.createdAt ?? runtime?.startedAt ?? null,
            connected: viewerConnected,
          } : null,
        });
      } catch (error) {
        next(error);
      }
    });

    app.get('/protoclaw/agent_detail', async (req, res, next) => {
      const startedAt = Date.now();
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
        void recordSidebarDiagnosticEvent({
          kind: 'read_perf',
          operation: 'agent_detail',
          phase: 'completed',
          agentId,
          durationMs: Date.now() - startedAt,
          sessionCount: Array.isArray(enriched.workspace_sessions?.sessions)
            ? enriched.workspace_sessions.sessions.length
            : 0,
          responseBytes: Number(res.getHeader?.('Content-Length')) || 0,
          result: 'success',
        }, { source: 'server' });
      } catch (error) {
        void recordSidebarDiagnosticEvent({
          kind: 'read_perf',
          operation: 'agent_detail',
          phase: 'failed',
          agentId: String(req.query.agentId || '').trim(),
          durationMs: Date.now() - startedAt,
          result: 'failed',
          errorCode: error?.code || 'agent_detail_failed',
        }, { source: 'server' });
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
        // Route to exact (agentId, sessionId) only.
        // Do NOT fall back to pickPrimaryAgentRuntime — that would silently
        // deliver the interrupt to a different session (cross-session contamination).
        let sent = false;
        if (sessionId) {
          sent = sendIPCtoSession(agentId, sessionId, {
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
