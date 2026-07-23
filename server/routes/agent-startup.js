import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import {
  RUNTIME_SCRIPT, ONE_SHOT_SCRIPT,
  VIEWER_PORT, APP_ORIGIN, PROJECT_ROOT,
  NO_SESSION_TOKEN,
  PROCESS_EXIT_WAIT_MS, RUNTIME_READY_WAIT_MS,
  CALL_EXECUTION_TIMEOUT_MS,
} from '../shared/constants.js';
import {
  sanitizeSessionFragment, cleanSessionText, sanitizeSpawnEnv, childProcessEnv,
  getAssemblyWorkspaceDir, parseListField, log,
} from '../shared/string-helpers.js';
import {
  managedAgents, assemblyRuntimeProcesses,
  getManagedRuntimeKey, listAgentRuntimes,
  getAgentRuntime, getAssemblyRuntime, buildStatus,
  isChildProcessRunning, isManagedRuntimeRunning,
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
import { addOpenSession } from '../shared/open-sessions-tracker.js';

// Platform-aware default UDS path for ViewerWorker IPC
export const DEFAULT_UDS_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\agentdev-viewer'
  : '/tmp/agentdev-viewer.sock';

// ── Agent Startup ────────────────────────────────────────────────
// Factory that produces all process-spawning and runtime-readiness
// functions. Dependencies are injected to avoid circular imports
// and to share mutable state (exitCallbacks array).

export function createAgentStartupFns(deps) {
  const {
    sessionApi,
    getConnectedAgents,
    requireAgentLight,
    resolveRuntimeDisplayName,
    readViewerJson,
    exitCallbacks,
  } = deps;

  async function waitForProcessExit(child, timeoutMs = PROCESS_EXIT_WAIT_MS) {
    if (!isChildProcessRunning(child)) return;
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  async function waitForManagedRuntimeReady(agentId, timeoutMs = RUNTIME_READY_WAIT_MS, sessionId = undefined) {
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

  async function waitForAssemblyRuntimeReady(sessionId, timeoutMs = RUNTIME_READY_WAIT_MS) {
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
        isManagedRuntimeRunning(rt)
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

    if (isManagedRuntimeRunning(existing)) {
      if (!resolvedSessionId || existing.selectedSessionId === resolvedSessionId) {
        return buildStatus(agent.id, resolvedSessionId);
      }

      existing.stopped = true;
      existing.process.kill('SIGTERM');
      await waitForProcessExit(existing.process);
    }

    if (isChildProcessRunning(existing?.process) && existing.stopped) {
      await waitForProcessExit(existing.process);
    }

    const runtimeDisplayName = await resolveRuntimeDisplayName(agent, resolvedSessionId);

    const isExplorationSession = runtimeOptions?.extraEnv?.PROTOCLAW_SESSION_TYPE === 'exploration';
    const child = spawn(process.execPath, [RUNTIME_SCRIPT, agent.relativeDir, agent.id, runtimeDisplayName, resolvedSessionId || NO_SESSION_TOKEN], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: sanitizeSpawnEnv({
        ...childProcessEnv(),
        ...(isExplorationSession ? {} : {
          AGENTDEV_DEBUG_TRANSPORT: 'viewer-worker',
          AGENTDEV_VIEWER_PORT: String(VIEWER_PORT),
          AGENTDEV_UDS_PATH: process.env.AGENTDEV_UDS_PATH || DEFAULT_UDS_PATH,
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
      gcChatId: runtimeOptions?.extraEnv?.PROTOCLAW_GC_CHAT_ID || null,
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
        // Track open session for post-restart recovery
        if (resolvedSessionId) {
          addOpenSession(agent.id, resolvedSessionId).catch(e => console.warn(e));
        }
      }
      log(agent.id, text.trim());
    });

    child.stderr.on('data', (chunk) => {
      log(agent.id, String(chunk).trim(), 'error');
    });

    child.on('exit', (code, signal) => {
      const current = managedAgents.get(runtime.key);
      if (current && current === runtime) {
        current.exitCode = code;
        current.signalCode = signal || child.signalCode || null;
        current.stopped = true;
      }
      log(agent.id, `process exited with code ${code ?? 'null'} signal ${signal || child.signalCode || 'none'}`);

      // 通知外部回调（如群聊模块需要在 agent 死亡时闭环）
      for (const cb of exitCallbacks) {
        try {
          cb(agent.id, resolvedSessionId || null, code, runtime.key);
        } catch (e) {
          console.error('[agent-startup] exit callback error:', e);
        }
      }
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
    const timeoutMs = options.timeoutMs || CALL_EXECUTION_TIMEOUT_MS;

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
          ...childProcessEnv(),
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

    if (isManagedRuntimeRunning(existing)) {
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
        ...childProcessEnv(),
        AGENTDEV_DEBUG_TRANSPORT: 'viewer-worker',
        AGENTDEV_VIEWER_PORT: String(VIEWER_PORT),
        AGENTDEV_UDS_PATH: process.env.AGENTDEV_UDS_PATH || DEFAULT_UDS_PATH,
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

  return {
    waitForProcessExit,
    waitForManagedRuntimeReady,
    waitForAssemblyRuntimeReady,
    startManagedAgent,
    startOneShotAgent,
    startAssemblyRuntime,
  };
}
