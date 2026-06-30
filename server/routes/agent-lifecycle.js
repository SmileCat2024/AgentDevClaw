import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import {
  RUNTIME_SCRIPT, ONE_SHOT_SCRIPT,
  VIEWER_PORT, APP_ORIGIN, PROJECT_ROOT,
  NO_SESSION_TOKEN, APP_PORT,
} from '../shared/constants.js';
import {
  sanitizeSessionFragment, cleanSessionText, sanitizeSpawnEnv,
  getAssemblyWorkspaceDir, parseListField, log,
} from '../shared/string-helpers.js';
import {
  managedAgents, assemblyRuntimeProcesses,
  getManagedRuntimeKey, listAgentRuntimes,
  getAgentRuntime, getAssemblyRuntime, buildStatus,
} from '../shared/agent-access.js';
import {
  readSessionIndex, getPrebuiltSessionFilePath, updateSessionIndex,
} from '../shared/session-access.js';
import { notifyRuntimeReady } from '../shared/runtime-hooks.js';
import {
  ensureAssemblyWorkspaceBase, ensureAssemblyWorkspaceDependencies,
} from './assembly-helpers.js';
import { readWorkspaceState, writeWorkspaceState } from './workspace.js';
import { readProjectIMWorkspaceConfig } from './im.js';

// ── Agent Lifecycle ──────────────────────────────────────────────
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

  async function getConnectedAgents() {
    const prebuiltAgents = await getAgentsLight();
    const viewerData = await readViewerJson('/api/agents').catch(() => ({ agents: [], currentAgentId: null }));
    const runtimeAgents = Array.isArray(viewerData.agents) ? viewerData.agents : [];
    const managedRuntimeByViewerId = new Map(
      Array.from(managedAgents.values())
        .filter((runtime) => runtime?.viewerAgentId && runtime.process && runtime.process.exitCode === null && !runtime.stopped)
        .map((runtime) => [String(runtime.viewerAgentId), runtime])
    );

    const connectedAgents = await Promise.all(prebuiltAgents.map(async (agent) => {
      const { workspaceSessions, sessionMeta } = await readActiveWorkspaceSessionMeta(agent);
      return {
        id: agent.id,
        name: agent.name,
        base_name: agent.name,
        description: agent.description,
        kind: agent.kind || 'agent',
        launchMode: agent.launchMode || null,
        ui: agent.ui || null,
        workspace: agent.workspace || null,
        workspace_sessions: workspaceSessions,
        workspace_data: {},
        workspace_state: { forms: {}, openDirectory: '', updatedAt: null },
        active_workspace_session_id: sessionMeta.active_workspace_session_id,
        active_workspace_session_form_id: sessionMeta.active_workspace_session_form_id,
        active_workspace_session_title: sessionMeta.active_workspace_session_title,
        active_workspace_agent_name: sessionMeta.active_workspace_agent_name,
        active_workspace_display_name: sessionMeta.active_workspace_display_name,
        status: 'stopped',
        source: 'prebuilt',
        parent_id: null,
        connection_info: null,
        pid: agent.status.pid,
        runtime_session_id: agent.status.viewerAgentId,
        message_count: 0,
        pending_input_count: null,
        created_at: null,
        modelPresets: await resolveAgentModelPresets(agent.id, agent.modelPresets),
        connected: false,
      };
    }));

    for (const runtimeAgent of runtimeAgents) {
      const managedRuntime = managedRuntimeByViewerId.get(String(runtimeAgent.id || '')) || null;
      if (managedRuntime) {
        const runtimeMeta = await readWorkspaceSessionMeta(managedRuntime.agentId, managedRuntime.selectedSessionId);
        connectedAgents.push({
          id: runtimeAgent.id,
          name: runtimeMeta.active_workspace_display_name
            || runtimeMeta.active_workspace_agent_name
            || runtimeMeta.active_workspace_session_title
            || runtimeAgent.name,
          description: runtimeAgent.description || '',
          status: runtimeAgent.connected ? 'running' : 'stopped',
          source: 'child',
          parent_id: managedRuntime.agentId,
          active_workspace_session_id: runtimeMeta.active_workspace_session_id,
          active_workspace_session_form_id: runtimeMeta.active_workspace_session_form_id,
          active_workspace_session_title: runtimeMeta.active_workspace_session_title,
          active_workspace_agent_name: runtimeMeta.active_workspace_agent_name,
          active_workspace_display_name: runtimeMeta.active_workspace_display_name,
          connection_info: runtimeAgent.connectionInfo || 'viewer://127.0.0.1:2026',
          pid: runtimeAgent.pid || managedRuntime.process?.pid || null,
          runtime_session_id: runtimeAgent.id,
          message_count: runtimeAgent.messageCount ?? 0,
          pending_input_count: await getPendingInputCount(runtimeAgent.id),
          created_at: runtimeAgent.createdAt ?? managedRuntime.startedAt ?? null,
          connected: runtimeAgent.connected ?? false,
        });
        continue;
      }

      const explicitParentHost = connectedAgents.find((agent) =>
        agent.source === 'prebuilt'
        && sanitizeSessionFragment(agent.id) === sanitizeSessionFragment(runtimeAgent.parentAgentId || ''));
      const isExplicitChildRuntime = !!runtimeAgent.parentAgentId && !!explicitParentHost;

      const workspaceHostParent = connectedAgents.find((agent) =>
        agent.source === 'prebuilt'
        && sanitizeSessionFragment(agent.id) === sanitizeSessionFragment(runtimeAgent.parentAgentId || '')
        && (agent.id === 'agent-creator' || agent.id === 'feature-creator'));
      const isWorkspaceHostRuntime =
        workspaceHostParent
        && (cleanSessionText(runtimeAgent.name) === cleanSessionText(workspaceHostParent.base_name)
          || cleanSessionText(runtimeAgent.name) === cleanSessionText(workspaceHostParent.name));
      if (isWorkspaceHostRuntime) {
        continue;
      }

      const matched = connectedAgents.find((agent) => agent.id === runtimeAgent.id)
        || connectedAgents.find((agent) => agent.source === 'prebuilt' && agent.runtime_session_id === runtimeAgent.id)
        || (!isExplicitChildRuntime
          ? connectedAgents.find((agent) => agent.source === 'prebuilt' && (agent.base_name === runtimeAgent.name || agent.name === runtimeAgent.name))
          : null);
      const exposeAsSeparateAssemblyRuntime = matched
        && matched.source === 'prebuilt'
        && (sanitizeSessionFragment(matched.id) === 'agent-creator' || sanitizeSessionFragment(matched.id) === 'flow-workspace')
        && cleanSessionText(matched.active_workspace_session_form_id) === 'assembly-form';

      if (matched && !exposeAsSeparateAssemblyRuntime) {
        matched.status = runtimeAgent.connected ? 'running' : matched.status;
        matched.connection_info = 'viewer://127.0.0.1:2026';
        matched.runtime_session_id = runtimeAgent.id;
        matched.message_count = runtimeAgent.messageCount ?? 0;
        matched.created_at = runtimeAgent.createdAt ?? null;
        matched.connected = runtimeAgent.connected ?? false;
        matched.pending_input_count = await getPendingInputCount(runtimeAgent.id);
        continue;
      }

      if (!runtimeAgent.connected) {
        continue;
      }

      connectedAgents.push({
        id: runtimeAgent.id,
        name: runtimeAgent.name,
        description: runtimeAgent.description || '',
        status: runtimeAgent.connected ? 'running' : 'stopped',
        source: exposeAsSeparateAssemblyRuntime ? 'external' : (runtimeAgent.parentAgentId ? 'child' : 'external'),
        parent_id: exposeAsSeparateAssemblyRuntime ? matched.id : (runtimeAgent.parentAgentId || null),
        active_workspace_session_id: exposeAsSeparateAssemblyRuntime ? (matched.active_workspace_session_id || null) : null,
        active_workspace_session_form_id: exposeAsSeparateAssemblyRuntime ? (matched.active_workspace_session_form_id || null) : null,
        active_workspace_session_title: exposeAsSeparateAssemblyRuntime ? (matched.active_workspace_session_title || null) : null,
        active_workspace_agent_name: exposeAsSeparateAssemblyRuntime ? (matched.active_workspace_agent_name || null) : null,
        active_workspace_display_name: exposeAsSeparateAssemblyRuntime ? (matched.active_workspace_display_name || null) : null,
        connection_info: runtimeAgent.connectionInfo || 'viewer://127.0.0.1:2026',
        pid: runtimeAgent.pid || null,
        runtime_session_id: runtimeAgent.id,
        message_count: runtimeAgent.messageCount ?? 0,
        pending_input_count: await getPendingInputCount(runtimeAgent.id),
        created_at: runtimeAgent.createdAt ?? null,
        connected: runtimeAgent.connected ?? false,
      });
    }

    for (const managed of connectedAgents) {
      const status = buildStatus(managed.id);
      if (status.status === 'running') {
        managed.status = 'running';
        managed.pid = status.pid;
        managed.active_workspace_session_id = status.selectedSessionId || managed.active_workspace_session_id;
        if (status.viewerAgentId) {
          managed.runtime_session_id = status.viewerAgentId;
        }
      } else if (managed.source === 'prebuilt') {
        managed.status = 'stopped';
        managed.pid = null;
        managed.runtime_session_id = null;
        managed.message_count = 0;
        managed.pending_input_count = null;
        managed.connected = false;
        managed.callActive = false;
      }
    }

    // 查询每个 connected agent 的 call 状态（从 ViewerWorker notification）
    await Promise.all(connectedAgents
      .filter((agent) => agent.connected && agent.runtime_session_id)
      .map(async (agent) => {
        try {
          const notif = await readViewerJson(`/api/agents/${encodeURIComponent(agent.runtime_session_id)}/notification`);
          agent.callActive = notif?.callActive === true;
        } catch {
          agent.callActive = false;
        }
      })
    );

    return connectedAgents;
  }

  async function waitForProcessExit(child, timeoutMs = 5000) {
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  async function waitForManagedRuntimeReady(agentId, timeoutMs = 10000, sessionId = undefined) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const runtime = getAgentRuntime(agentId, sessionId);
      // Exploration agents run headlessly (no ViewerWorker) — just check ready flag
      if (runtime?.sessionType === 'exploration') {
        if (runtime.ready) return runtime;
      } else {
        const status = buildStatus(agentId, sessionId);
        if (status.viewerAgentId && runtime?.ready) {
          const agents = await getConnectedAgents();
          const viewerAgentId = cleanSessionText(status.viewerAgentId);
          const connected = agents.find((agent) => cleanSessionText(agent.id) === viewerAgentId || cleanSessionText(agent.runtime_session_id || agent.runtimeSessionId) === viewerAgentId);
          if (connected) {
            return connected;
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  }

  async function waitForAssemblyRuntimeReady(sessionId, timeoutMs = 10000) {
    const normalizedSessionId = sanitizeSessionFragment(sessionId);
    const start = Date.now();
    console.log(`[PERF] waitForAssemblyRuntimeReady BEGIN session=${normalizedSessionId} timeout=${timeoutMs}`);
    while (Date.now() - start < timeoutMs) {
      const runtime = getAssemblyRuntime(normalizedSessionId);
      if (runtime?.viewerAgentId && runtime?.ready) {
        const viewerData = await readViewerJson('/api/agents').catch(() => ({ agents: [] }));
        const agents = Array.isArray(viewerData?.agents) ? viewerData.agents : [];
        const connected = agents.find((agent) => agent.id === runtime.viewerAgentId);
        if (connected) {
          console.log(`[PERF] waitForAssemblyRuntimeReady FOUND (${Date.now() - start}ms)`);
          return connected;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    console.log(`[PERF] waitForAssemblyRuntimeReady TIMEOUT (${Date.now() - start}ms)`);
    return null;
  }

  async function startManagedAgent(agent, selectedSessionId = undefined, runtimeOptions = {}) {
    const requestedSessionId = typeof selectedSessionId === 'string' && selectedSessionId
      ? sanitizeSessionFragment(selectedSessionId)
      : (selectedSessionId === null ? null : undefined);
    let preferredSessionId = null;
    if (requestedSessionId === undefined && sanitizeSessionFragment(agent?.id) === 'qqbot') {
      preferredSessionId = (await readProjectIMWorkspaceConfig().catch(() => ({ receptionistSessionId: '' })))?.receptionistSessionId || null;
    }
    const existing = getAgentRuntime(agent.id, requestedSessionId);
    const resolvedSessionId = requestedSessionId !== undefined
      ? requestedSessionId
      : (preferredSessionId || existing?.selectedSessionId || agent.workspace_sessions?.activeSessionId || null);

    if (sanitizeSessionFragment(agent?.id) === 'qqbot') {
      const siblings = listAgentRuntimes(agent.id).filter((rt) =>
        rt?.process && rt.process.exitCode === null && !rt.stopped
        && rt !== existing
      );
      for (const rt of siblings) {
        rt.stopped = true;
        rt.process.kill('SIGTERM');
      }
      await Promise.all(siblings.map((rt) => waitForProcessExit(rt.process)));
    }

    if (resolvedSessionId && !runtimeOptions?.extraEnv?.PROTOCLAW_HANDOFF_PATH) {
      try {
        const idx = await readSessionIndex(agent.id);
        const sessionRecord = idx.sessions.find(s => s.id === resolvedSessionId);
        if (sessionRecord?.metadata?.handoffPath) {
          // Only pass handoff env when the session has no persisted messages yet.
          // If the session file already exists and contains messages, the handoff
          // was already consumed on first boot and re-injecting would duplicate
          // seed messages with conflicting turn values.
          let shouldInjectHandoff = true;
          try {
            const sessionPath = getPrebuiltSessionFilePath(agent.id, resolvedSessionId);
            const raw = await fs.readFile(sessionPath, 'utf8');
            const snapshot = JSON.parse(raw);
            const messages = snapshot?.runtime?.context?.messages;
            if (Array.isArray(messages) && messages.length > 0) {
              shouldInjectHandoff = false;
            }
          } catch {
            // Session file doesn't exist or is unreadable — safe to inject
          }
          if (shouldInjectHandoff) {
            runtimeOptions = {
              ...runtimeOptions,
              extraEnv: {
                ...(runtimeOptions?.extraEnv || {}),
                PROTOCLAW_HANDOFF_PATH: sessionRecord.metadata.handoffPath,
              },
            };
          }
        }
      } catch {}
    }

    if (existing?.process && existing.process.exitCode === null && !existing.stopped) {
      if (!resolvedSessionId || existing.selectedSessionId === resolvedSessionId) {
        return buildStatus(agent.id, resolvedSessionId);
      }

      existing.stopped = true;
      existing.process.kill('SIGTERM');
      await waitForProcessExit(existing.process);
    }

    if (existing?.process && existing.process.exitCode === null && existing.stopped) {
      await waitForProcessExit(existing.process);
    }

    const runtimeDisplayName = await resolveRuntimeDisplayName(agent, resolvedSessionId);

    const isExplorationSession = runtimeOptions?.extraEnv?.PROTOCLAW_SESSION_TYPE === 'exploration';
    const child = spawn(process.execPath, [RUNTIME_SCRIPT, agent.relativeDir, agent.id, runtimeDisplayName, resolvedSessionId || NO_SESSION_TOKEN], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: sanitizeSpawnEnv({
        ...process.env,
        ...(isExplorationSession ? {} : {
          AGENTDEV_DEBUG_TRANSPORT: 'viewer-worker',
          AGENTDEV_VIEWER_PORT: String(VIEWER_PORT),
          AGENTDEV_UDS_PATH: process.env.AGENTDEV_UDS_PATH || '\\\\.\\pipe\\agentdev-viewer',
        }),
        PROTOCLAW_SERVER_ORIGIN: APP_ORIGIN,
        PROTOCLAW_PREBUILT_AGENT_ID: String(agent.id || ''),
        PROTOCLAW_PREBUILT_SESSION_ID: resolvedSessionId || '',
        ...(runtimeOptions?.extraEnv && typeof runtimeOptions.extraEnv === 'object' ? runtimeOptions.extraEnv : {}),
      }),
      windowsHide: true,
    });

    const runtime = {
      key: getManagedRuntimeKey(agent.id, resolvedSessionId),
      agentId: agent.id,
      id: agent.id,
      process: child,
      startedAt: new Date().toISOString(),
      exitCode: null,
      stopped: false,
      viewerAgentId: null,
      selectedSessionId: resolvedSessionId || null,
      ready: false,
      sessionType: runtimeOptions?.extraEnv?.PROTOCLAW_SESSION_TYPE || null,
    };

    managedAgents.set(runtime.key, runtime);

    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      const match = text.match(/Viewer Agent ID:\s*([^\s]+)/);
      if (match) {
        runtime.viewerAgentId = match[1];
      }
      if (text.includes('[ProtoClaw Runtime] READY session=')) {
        runtime.ready = true;
        // Notify runtime-ready hook (for event-driven dispatch schedules)
        notifyRuntimeReady(agent.id, resolvedSessionId || null);
      }
      log(agent.id, text.trim());
    });

    child.stderr.on('data', (chunk) => {
      log(agent.id, String(chunk).trim(), 'error');
    });

    child.on('exit', (code) => {
      const current = managedAgents.get(runtime.key);
      if (current && current === runtime) {
        current.exitCode = code;
        current.stopped = true;
      }
      log(agent.id, `process exited with code ${code ?? 'null'}`);
    });

    child.on('error', (error) => {
      const current = managedAgents.get(runtime.key);
      if (current) {
        current.exitCode = 1;
        current.stopped = true;
      }
      log(agent.id, `failed to start: ${error.message}`, 'error');
    });

    return buildStatus(agent.id, resolvedSessionId);
  }

  /**
   * 启动一次性子代理（阻塞式）。
   *
   * 与 startManagedAgent 不同：
   * - 使用 run-one-shot-agent.js 而非 run-prebuilt-agent.js
   * - 不连接 ViewerWorker
   * - 只执行一次 onCall(goal) 后退出
   * - 返回 Promise，在进程退出时 resolve
   */
  async function startOneShotAgent(agent, sessionId, goal, options = {}) {
    const resolvedSessionId = sanitizeSessionFragment(sessionId);
    const timeoutMs = options.timeoutMs || 300000;

    return new Promise((resolve, reject) => {
      let resultLine = null;
      const stdoutChunks = [];

      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`One-shot agent timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const child = spawn(process.execPath, [
        ONE_SHOT_SCRIPT,
        agent.relativeDir,
        agent.id,
        resolvedSessionId,
        goal,
      ], {
        cwd: PROJECT_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: sanitizeSpawnEnv({
          ...process.env,
          PROTOCLAW_SERVER_ORIGIN: APP_ORIGIN,
          PROTOCLAW_PREBUILT_AGENT_ID: String(agent.id || ''),
          PROTOCLAW_PREBUILT_SESSION_ID: resolvedSessionId || '',
          ...(options.extraEnv && typeof options.extraEnv === 'object' ? options.extraEnv : {}),
        }),
        windowsHide: true,
      });

      child.stdout.on('data', (chunk) => {
        const text = String(chunk);
        stdoutChunks.push(text);
        const lines = text.split('\n');
        for (const line of lines) {
          if (line.startsWith('ONE_SHOT_RESULT:')) {
            resultLine = line;
          }
        }
        log(agent.id, text.trim());
      });

      child.stderr.on('data', (chunk) => {
        log(agent.id, String(chunk).trim(), 'error');
      });

      child.on('exit', (code) => {
        clearTimeout(timeout);
        log(agent.id, `one-shot process exited with code ${code ?? 'null'}`);

        if (resultLine) {
          try {
            const jsonStr = resultLine.slice('ONE_SHOT_RESULT:'.length);
            const result = JSON.parse(jsonStr);
            resolve({ exitCode: code, result, stdout: stdoutChunks.join('') });
          } catch (err) {
            reject(new Error(`Failed to parse one-shot result: ${err.message}`));
          }
        } else {
          reject(new Error(
            `One-shot agent exited (code ${code}) without producing a result. ` +
            `stdout: ${stdoutChunks.join('').slice(-500)}`,
          ));
        }
      });

      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(new Error(`One-shot agent failed to start: ${error.message}`));
      });
    });
  }

  async function startAssemblyRuntime(sessionId, agentId = 'agent-creator', preActivatedSession = null, preloadedWorkspaceState = null) {
    const _t0 = Date.now();
    console.log(`[PERF] startAssemblyRuntime BEGIN session=${sessionId} agent=${agentId} hasSession=${!!preActivatedSession} hasState=${!!preloadedWorkspaceState}`);
    const agent = await requireAgentLight(agentId || 'agent-creator');
    let session = preActivatedSession || await sessionApi.activatePrebuiltSession(agent.id, sessionId);
    if (!preActivatedSession) {
      console.log(`[PERF] startAssemblyRuntime activatePrebuiltSession (${Date.now() - _t0}ms)`);
    } else {
      console.log(`[PERF] startAssemblyRuntime using pre-activated session (${Date.now() - _t0}ms)`);
    }
    const normalizedSessionId = sanitizeSessionFragment(session.id);
    const existing = getAssemblyRuntime(normalizedSessionId);

    if (existing?.process && existing.process.exitCode === null && !existing.stopped) {
      return existing;
    }

    const workspaceState = preloadedWorkspaceState || await readWorkspaceState(agent.id).catch(() => ({ forms: {}, openDirectory: '', updatedAt: null }));
    if (!preloadedWorkspaceState) {
      console.log(`[PERF] startAssemblyRuntime readWorkspaceState (${Date.now() - _t0}ms)`);
    }
    const assemblyForm = workspaceState?.forms?.['assembly-form'] || {};
    const runtimeDisplayName = cleanSessionText(session.agentName)
      || cleanSessionText(assemblyForm.assembly_name)
      || 'assembled-agent';
    const assemblyWorkspace = cleanSessionText(assemblyForm.env_dir) || getAssemblyWorkspaceDir(runtimeDisplayName);
    const selectedFeatures = parseListField(assemblyForm.selected_features);
    const customWorkdir = cleanSessionText(assemblyForm.workdir);
    const runtimeWorkdir = customWorkdir || assemblyWorkspace;

    if (cleanSessionText(session.openDirectory) !== assemblyWorkspace) {
      let updatedSession = session;
      await updateSessionIndex(agent.id, (index) => {
        const sessions = index.sessions.map((item) => item.id === session.id
          ? { ...item, openDirectory: assemblyWorkspace, updatedAt: new Date().toISOString() }
          : item);
        updatedSession = sessions.find((item) => item.id === session.id) || session;
        return { ...index, sessions };
      });
      session = await sessionApi.summarizePrebuiltSession(agent.id, updatedSession);
    }

    await ensureAssemblyWorkspaceBase(assemblyWorkspace, runtimeDisplayName);
    console.log(`[PERF] startAssemblyRuntime ensureBase (${Date.now() - _t0}ms)`);
    const installResult = await ensureAssemblyWorkspaceDependencies(assemblyWorkspace, selectedFeatures);
    console.log(`[PERF] startAssemblyRuntime ensureDeps (${Date.now() - _t0}ms) skipped=${installResult.skipped}`);
    if (installResult.installedPackages.length > 0) {
      log(`assembly:${normalizedSessionId}`, `refreshed feature dependencies: ${installResult.installedPackages.join(', ')}`);
    }
    await writeWorkspaceState(agent.id, {
      forms: {
        ...(workspaceState?.forms || {}),
        'assembly-form': {
          ...assemblyForm,
          assembly_name: runtimeDisplayName,
          env_created: '1',
          env_dir: assemblyWorkspace,
          env_configured_name: runtimeDisplayName,
          env_configured_features: selectedFeatures.join('\n'),
          env_status: 'ready',
          env_status_message: selectedFeatures.length > 0
            ? `Runtime dependencies refreshed for ${selectedFeatures.length} feature(s).`
            : 'Runtime dependencies refreshed.',
        },
      },
      openDirectory: assemblyWorkspace,
    });
    console.log(`[PERF] startAssemblyRuntime writeWorkspaceState (${Date.now() - _t0}ms)`);
    const spawnArgs = [
      String(RUNTIME_SCRIPT),
      String(agent.relativeDir || ''),
      String(agent.id || ''),
      String(runtimeDisplayName || ''),
      String(normalizedSessionId || ''),
    ];
    const child = spawn(process.execPath, spawnArgs, {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizeSpawnEnv({
        ...process.env,
        AGENTDEV_DEBUG_TRANSPORT: 'viewer-worker',
        AGENTDEV_VIEWER_PORT: String(VIEWER_PORT),
        AGENTDEV_UDS_PATH: process.env.AGENTDEV_UDS_PATH || '\\\\.\\pipe\\agentdev-viewer',
        PROTOCLAW_PREBUILT_AGENT_ID: String(agent.id || ''),
        PROTOCLAW_PREBUILT_SESSION_ID: normalizedSessionId,
        PROTOCLAW_ASSEMBLY_RUNTIME: '1',
        PROTOCLAW_ASSEMBLY_WORKSPACE: runtimeWorkdir,
      }),
      windowsHide: true,
    });

    const runtime = {
      sessionId: normalizedSessionId,
      requestedName: runtimeDisplayName,
      workspaceDir: runtimeWorkdir,
      installedPackages: selectedFeatures,
      process: child,
      startedAt: new Date().toISOString(),
      exitCode: null,
      viewerAgentId: null,
      ready: false,
      stopped: false,
    };

    assemblyRuntimeProcesses.set(normalizedSessionId, runtime);
    console.log(`[PERF] startAssemblyRuntime process SPAWNED (${Date.now() - _t0}ms) pid=${child.pid}`);

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      log(`assembly:${normalizedSessionId}`, text.trimEnd());
      const viewerMatch = text.match(/Viewer Agent ID:\s*(\S+)/);
      if (viewerMatch) {
        runtime.viewerAgentId = viewerMatch[1];
        console.log(`[PERF] startAssemblyRuntime viewerAgentId=${viewerMatch[1]} (${Date.now() - _t0}ms)`);
      }
      if (text.includes('READY session=')) {
        runtime.ready = true;
        console.log(`[PERF] startAssemblyRuntime READY (${Date.now() - _t0}ms)`);
      }
    });

    child.stderr?.on('data', (chunk) => {
      log(`assembly:${normalizedSessionId}`, chunk.toString().trimEnd(), 'error');
    });

    child.on('exit', (code) => {
      runtime.exitCode = code ?? 0;
      runtime.stopped = true;
      assemblyRuntimeProcesses.delete(normalizedSessionId);
    });

    return runtime;
  }

  async function stopManagedAgent(agentId, sessionId = undefined) {
    const runtimes = sessionId === undefined ? listAgentRuntimes(agentId) : [getAgentRuntime(agentId, sessionId)].filter(Boolean);
    if (runtimes.length === 0) {
      return buildStatus(agentId, sessionId);
    }

    for (const runtime of runtimes) {
      if (!runtime?.process || runtime.process.exitCode !== null || runtime.stopped) {
        continue;
      }
      runtime.stopped = true;
      runtime.process.kill('SIGTERM');
    }
    return buildStatus(agentId, sessionId);
  }

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
  }

  return {
    getConnectedAgents, waitForProcessExit,
    waitForManagedRuntimeReady, waitForAssemblyRuntimeReady,
    startManagedAgent, startOneShotAgent, startAssemblyRuntime,
    stopManagedAgent,
    setupRoutes,
  };
}
