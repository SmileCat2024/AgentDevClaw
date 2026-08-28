import path from 'path';
import {
  APP_PORT, VIEWER_PORT, PROJECT_ROOT,
} from '../shared/constants.js';
import { readJsonSafe } from '../shared/fs-helpers.js';
import { sanitizeSessionFragment } from '../shared/string-helpers.js';
import {
  listAgentRuntimes, getAgentRuntime, getRuntimeByViewerAgentId, buildStatus, isChildProcessRunning,
} from '../shared/agent-access.js';
import { readProjectIMWorkspaceConfig } from './im.js';
import { sendIPCtoSession, sendIPCToRuntime } from '../shared/ipc.js';
import { removeOpenSession } from '../shared/open-sessions-tracker.js';
import { createConnectedAgentsQuery } from './agent-connected.js';
import { createAgentStartupFns } from './agent-startup.js';
import { releaseRuntimeState } from '../runtime-call-envelope.js';
import { recordSidebarDiagnosticEvent } from '../shared/sidebar-diagnostics.js';
import { resolveRuntimeControlTarget } from '../shared/operation-target.js';
import { bareId, resolveForwardHostTarget, forwardProtoclawRoute, readForwardTargetError } from '../shared/remote-forward.js';
import { buildLocalFailureResponse } from '../shared/operation-contract.js';

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
    readRemoteCatalog = null,
  } = ctx;

  const _exitCallbacks = [];

  // ── App info (versions / repos for the sidebar brand card) ────
  // 版本与仓库信息在进程生命周期内不变，读一次后缓存。
  // @agentdevjs/core 的 exports 只暴露 "."，不能 require 其 package.json，用 fs 直读。
  let _appInfoPromise = null;
  function loadAppInfo() {
    if (!_appInfoPromise) {
      _appInfoPromise = (async () => {
        const [clawPkg, corePkg] = await Promise.all([
          readJsonSafe(path.join(PROJECT_ROOT, 'package.json'), {}),
          readJsonSafe(path.join(PROJECT_ROOT, 'node_modules', '@agentdevjs', 'core', 'package.json'), {}),
        ]);
        return {
          name: 'AgentDevClaw',
          version: clawPkg?.version || null,
          framework: {
            name: '@agentdevjs/core',
            version: corePkg?.version || null,
          },
          // ADR-0011：本版本 Claw 支持被远程写透传（幂等闸在连接侧强制）。
          // 旧远程读不到此字段，握手侧视为不可写。
          capabilities: {
            write: true,
          },
          repos: {
            app: 'https://github.com/SmileCat2024/AgentDevClaw',
            framework: 'https://github.com/SmileCat2024/AgentDev',
          },
        };
      })();
    }
    return _appInfoPromise;
  }

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
    readRemoteCatalog,
  });

  // ── Startup & wait functions (delegated to agent-startup.js) ──

  const {
    waitForProcessExit,
    waitForManagedRuntimeReady,
    waitForAssemblyRuntimeReady,
    startManagedAgent,
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

    app.get('/protoclaw/app_info', async (_req, res) => {
      try {
        res.json({ ok: true, ...(await loadAppInfo()) });
      } catch (error) {
        res.status(500).json({ ok: false, error: error?.message || String(error) });
      }
    });

    app.get('/protoclaw/get_prebuilt_agents', async (_req, res, next) => {
      try {
        const agents = await getAgents();
        // 注意：这里不展开 sidebar 投影身份。本路由的 id 被消费方
        //（dispatch 下拉等）直接用作会话创建的 agentId，投影 id
        //（host:identity）不是合法工作空间；投影只属于 sidebar 数据源
        //（agent-connected 的 get_connected_agents）。
        const entries = agents.map((agent) => ({
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
        }));
        res.json(entries);
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

    // ── Session-scoped feature control (request/ack over session IPC) ──
    // The Feature instance lives inside the runtime process; browser panels
    // talk to it through these routes. Every request carries a requestId and
    // waits for a matching result message, so a panel always renders the
    // runtime-confirmed state instead of an optimistic guess.
    function requestSessionRuntimeState(agentId, sessionId, message, resultType) {
      return new Promise((resolve) => {
        const runtime = getAgentRuntime(agentId, sessionId);
        const child = runtime?.process;
        if (!runtime || runtime.stopped || !child || child.exitCode !== null
          || typeof child.send !== 'function' || typeof child.on !== 'function') {
          resolve({ ok: false, error: 'session runtime not connected' });
          return;
        }
        const requestId = `${resultType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.removeListener?.('message', onMessage);
          resolve(result);
        };
        const timer = setTimeout(
          () => finish({ ok: false, error: `${resultType} IPC timeout` }),
          3000,
        );
        // Triple match (type + requestId + sessionId): a shared child process
        // multiplexes sessions, so answers for another session must not leak in.
        const onMessage = (msg) => {
          if (!msg || msg.type !== resultType) return;
          if (msg.requestId !== requestId || msg.sessionId !== sessionId) return;
          if (msg.ok === true) finish({ ok: true, status: msg.status || null });
          else finish({ ok: false, error: msg.error || `${resultType} request rejected` });
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

    function requestForceContinuationState(agentId, sessionId, message) {
      return requestSessionRuntimeState(agentId, sessionId, message, 'force-continuation-result');
    }

    app.get('/protoclaw/force_continuation_status', async (req, res, next) => {
      try {
        let target;
        try {
          target = resolveRuntimeControlTarget(req.query);
        } catch (error) {
          return res.status(error.status || 400).json({ ok: false, error: error.message, code: error.code });
        }
        const { agentId, sessionId } = target;
        if (!sessionId) {
          return res.status(400).json({ ok: false, error: 'sessionId is required' });
        }
        const result = await requestForceContinuationState(agentId, sessionId, { type: 'force-continuation-status' });
        if (!result.ok) return res.status(503).json({ ok: false, error: result.error });
        res.json({ ok: true, agentId, sessionId, status: result.status });
      } catch (error) {
        next(error);
      }
    });

    app.post('/protoclaw/force_continuation_control', express.json(), async (req, res, next) => {
      try {
        const { enabled, triggers, maxConsecutiveContinuations } = req.body || {};
        let target;
        try {
          target = resolveRuntimeControlTarget(req.body);
        } catch (error) {
          return res.status(error.status || 400).json({ ok: false, error: error.message, code: error.code });
        }
        const { agentId, sessionId } = target;
        if (!sessionId) {
          return res.status(400).json({ ok: false, error: 'sessionId is required' });
        }
        if (enabled !== undefined && typeof enabled !== 'boolean') {
          return res.status(400).json({ ok: false, error: 'enabled must be a boolean' });
        }
        if (triggers !== undefined && (typeof triggers !== 'object' || triggers === null || Array.isArray(triggers))) {
          return res.status(400).json({ ok: false, error: 'triggers must be an object' });
        }
        if (maxConsecutiveContinuations !== undefined
          && (typeof maxConsecutiveContinuations !== 'number' || !Number.isFinite(maxConsecutiveContinuations)
            || Math.floor(maxConsecutiveContinuations) !== maxConsecutiveContinuations
            || maxConsecutiveContinuations < 1 || maxConsecutiveContinuations > 10)) {
          return res.status(400).json({ ok: false, error: 'maxConsecutiveContinuations must be an integer between 1 and 10' });
        }
        // Route to the exact (agentId, sessionId) runtime only — no primary-runtime
        // fallback: a shared process must never toggle another session's feature.
        const result = await requestForceContinuationState(agentId, sessionId, {
          type: 'force-continuation-control',
          ...(enabled !== undefined ? { enabled } : {}),
          ...(triggers !== undefined ? { triggers } : {}),
          ...(maxConsecutiveContinuations !== undefined ? { maxConsecutiveContinuations } : {}),
        });
        if (!result.ok) return res.status(503).json({ ok: false, error: result.error });
        res.json({
          ok: true,
          agentId,
          sessionId,
          enabled: typeof enabled === 'boolean' ? enabled : (result.status?.enabled ?? false),
          status: result.status,
        });
      } catch (error) {
        next(error);
      }
    });

    // ── Context-guard session control (interactive shell fuse) ──
    // Mirrors the force-continuation request/ack pattern: the fuse state lives
    // in the runtime's ContextGuardFeature; the session control panel reads
    // and toggles it through these routes.
    app.get('/protoclaw/context_guard_status', async (req, res, next) => {
      try {
        let target;
        try {
          target = resolveRuntimeControlTarget(req.query);
        } catch (error) {
          return res.status(error.status || 400).json({ ok: false, error: error.message, code: error.code });
        }
        const { agentId, sessionId } = target;
        if (!sessionId) {
          return res.status(400).json({ ok: false, error: 'sessionId is required' });
        }
        const result = await requestSessionRuntimeState(agentId, sessionId, { type: 'context-guard-status' }, 'context-guard-result');
        if (!result.ok) return res.status(503).json({ ok: false, error: result.error });
        res.json({ ok: true, agentId, sessionId, status: result.status });
      } catch (error) {
        next(error);
      }
    });

    app.post('/protoclaw/context_guard_control', express.json(), async (req, res, next) => {
      try {
        const { armed } = req.body || {};
        if (armed !== undefined && typeof armed !== 'boolean') {
          return res.status(400).json({ ok: false, error: 'armed must be a boolean' });
        }
        let target;
        try {
          target = resolveRuntimeControlTarget(req.body);
        } catch (error) {
          return res.status(error.status || 400).json({ ok: false, error: error.message, code: error.code });
        }
        const { agentId, sessionId } = target;
        if (!sessionId) {
          return res.status(400).json({ ok: false, error: 'sessionId is required' });
        }
        const result = await requestSessionRuntimeState(agentId, sessionId, {
          type: 'context-guard-control',
          ...(armed !== undefined ? { armed } : {}),
        }, 'context-guard-result');
        if (!result.ok) return res.status(503).json({ ok: false, error: result.error });
        res.json({ ok: true, agentId, sessionId, status: result.status });
      } catch (error) {
        next(error);
      }
    });

    app.post('/protoclaw/todo_control', express.json(), async (req, res, next) => {
      try {
        const { taskId, forceContinue } = req.body || {};
        let target;
        try {
          target = resolveRuntimeControlTarget(req.body);
        } catch (error) {
          return res.status(error.status || 400).json({ error: error.message, code: error.code });
        }
        const { agentId, sessionId, runtimeId } = target;
        // ADR-0011：远程命名空间身份 → 转发远程同名 todo_control 路由（裸 id，
        // 远程端做自己的 IPC 与 body 校验）；本地身份走下方既有 IPC 路径，行为
        // 字节级不动。
        try {
          const hostTarget = resolveForwardHostTarget(runtimeId, agentId, sessionId);
          if (hostTarget.scope === 'remote') {
            return await forwardProtoclawRoute(res, hostTarget, '/protoclaw/todo_control', {
              method: 'POST',
              body: {
                ...(req.body || {}),
                agentId: bareId(agentId),
                runtimeId: bareId(runtimeId),
                sessionId: bareId(sessionId),
              },
            });
          }
        } catch (error) {
          return res.status(readForwardTargetError(error)).json(buildLocalFailureResponse(error));
        }
        if (taskId !== undefined && typeof taskId !== 'string' && taskId !== null) {
          return res.status(400).json({ error: 'taskId must be a string or null' });
        }
        if (forceContinue !== undefined && typeof forceContinue !== 'boolean') {
          return res.status(400).json({ error: 'forceContinue must be a boolean' });
        }
        const hasControlPayload = taskId !== undefined || forceContinue !== undefined;
        if (!hasControlPayload) {
          return res.status(400).json({ error: 'taskId or forceContinue is required' });
        }

        const deliver = (send) => {
          let sent = false;
          if (forceContinue !== undefined) {
            sent = send({ type: 'todo-force-continue', enabled: forceContinue });
          }
          if (taskId !== undefined) {
            sent = send({ type: 'todo-control', taskId: taskId || null }) || sent;
          }
          return sent;
        };

        // Priority 1: runtimeId (viewerAgentId) — same id space as the frontend's
        // poll source (GET /api/agents/:id/todo), so the toggle always targets
        // the exact runtime whose snapshot the UI is displaying. Mirrors the
        // swap_model / tool_state IPC resolution pattern.
        if (runtimeId && typeof runtimeId === 'string') {
          const rt = getRuntimeByViewerAgentId(runtimeId);
          if (rt && rt.process && rt.process.exitCode === null && !rt.stopped) {
            try {
              if (deliver((message) => sendIPCToRuntime(rt, message))) {
                return res.json({ ok: true, agentId, via: 'runtimeId' });
              }
            } catch (err) {
              console.warn(`[todo_control] IPC via runtimeId ${runtimeId} failed: ${err}`);
            }
          }
        }

        // Priority 2: agentId + sessionId exact routing.
        // Do NOT fall back to pickPrimaryAgentRuntime — that would silently
        // deliver the interrupt to a different session (cross-session contamination).
        if (sessionId) {
          if (deliver((message) => sendIPCtoSession(agentId, sessionId, message))) {
            return res.json({ ok: true, agentId, via: 'sessionId' });
          }
        }

        res.json({ ok: false });
      } catch (error) {
        next(error);
      }
    });
  }

  return {
    getConnectedAgents, waitForProcessExit,
    waitForManagedRuntimeReady, waitForAssemblyRuntimeReady,
    startManagedAgent, startAssemblyRuntime,
    stopManagedAgent,
    setupRoutes,
    onAgentExit: (cb) => { _exitCallbacks.push(cb); },
  };
}
