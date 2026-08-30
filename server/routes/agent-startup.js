import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import {
  RUNTIME_SCRIPT,
  VIEWER_PORT, APP_ORIGIN, PROJECT_ROOT,
  NO_SESSION_TOKEN,
  PROCESS_EXIT_WAIT_MS, RUNTIME_READY_WAIT_MS,
  CALL_EXECUTION_TIMEOUT_MS,
  resolveInstanceUdsPath,
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
  computeProcessGroupKey, findSharedProcessRuntime, listRuntimesByProcess,
} from '../shared/agent-access.js';
import {
  readSessionIndex, getPrebuiltSessionFilePath, updateSessionIndex,
} from '../shared/session-access.js';
import { notifyRuntimeReady } from '../shared/runtime-hooks.js';
import { getInternalAuthToken } from '../auth.js';
import {
  PROCESS_MODE_ISOLATED,
  PROCESS_MODE_SHARED_BY_PROJECT,
  PROCESS_MODE_SHARED_GLOBAL,
  GLOBAL_SHARED_AGENT_ID,
} from '../shared/process-mode.js';
import { releaseRuntimeState } from '../runtime-call-envelope.js';
import {
  ensureAssemblyWorkspaceBase, ensureAssemblyWorkspaceDependencies,
} from './assembly-helpers.js';
import { readWorkspaceState, writeWorkspaceState } from './workspace.js';
import { readProjectIMWorkspaceConfig } from './im.js';
import { addOpenSession } from '../shared/open-sessions-tracker.js';

/**
 * Resolve process placement without deriving a session workspace from the
 * process host. Shared-global is deliberately restricted to programming-helper
 * and still requires the session's explicit project directory: every hosted
 * Agent must receive its own workspaceCwd through add-session.
 */
export function buildSessionWorkspaceEnv(agentId, sessionId, projectDir) {
  if (sanitizeSessionFragment(agentId) !== GLOBAL_SHARED_AGENT_ID || !sessionId) return {};
  const workspaceCwd = typeof projectDir === 'string' ? projectDir.trim() : '';
  if (!workspaceCwd) {
    throw new Error('Programming Helper sessions require an explicit session project directory');
  }
  return { PROTOCLAW_SESSION_WORKSPACE_CWD: workspaceCwd };
}

export function buildSharedSessionStartMessage({ sessionId, agentName, projectDir, handoffPath, runtime }) {
  const workspaceCwd = typeof projectDir === 'string' ? projectDir.trim() : '';
  if (!workspaceCwd) {
    throw new Error('Shared sessions require an explicit session project directory');
  }
  return {
    type: 'add-session',
    sessionId,
    agentName,
    // Never substitute the host process cwd here. The SessionLifecycle must
    // receive the exact directory owned by this logical session.
    workspaceCwd,
    handoffPath: handoffPath || null,
    runtime: {
      sessionType: runtime?.sessionType || null,
      gcChatId: runtime?.gcChatId || null,
      modelPresetRole: runtime?.modelPresetRole || null,
    },
  };
}

export function resolveManagedProcessPlacement(agent, sessionRecord) {
  const agentId = sanitizeSessionFragment(agent?.id);
  const projectDir = typeof sessionRecord?.openDirectory === 'string'
    ? sessionRecord.openDirectory.trim()
    : '';
  const processMode = agent?.processMode || PROCESS_MODE_ISOLATED;

  if (!projectDir) {
    return { processMode, projectDir, processGroupKey: null };
  }
  if (processMode !== PROCESS_MODE_SHARED_BY_PROJECT && processMode !== PROCESS_MODE_SHARED_GLOBAL) {
    return { processMode, projectDir, processGroupKey: null };
  }
  if (processMode === PROCESS_MODE_SHARED_GLOBAL && agentId !== GLOBAL_SHARED_AGENT_ID) {
    return { processMode: PROCESS_MODE_ISOLATED, projectDir, processGroupKey: null };
  }

  return {
    processMode,
    projectDir,
    processGroupKey: computeProcessGroupKey(
      agentId, projectDir, processMode,
      sessionRecord?.sessionType && sessionRecord.sessionType !== 'main' ? sessionRecord.sessionType : null,
    ),
  };
}

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
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.removeListener('exit', resolve);
        resolve();
      }, timeoutMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async function waitForManagedRuntimeReady(agentId, timeoutMs = RUNTIME_READY_WAIT_MS, sessionId = undefined) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const runtime = getAgentRuntime(agentId, sessionId);
      // 进程已退出（构造期崩溃等）：ready 不会再到来，立即返回而不是干等满窗口
      if (runtime?.stopped && !isManagedRuntimeRunning(runtime)) {
        return null;
      }
      const status = buildStatus(agentId, sessionId);
      if (status.viewerAgentId && runtime?.ready) {
        const agents = await getConnectedAgents();
        const viewerAgentId = cleanSessionText(status.viewerAgentId);
        const connected = agents.find((agent) => cleanSessionText(agent.id) === viewerAgentId || cleanSessionText(agent.runtime_session_id || agent.runtimeSessionId) === viewerAgentId);
        if (connected) {
          return connected;
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

    // A stopped shared-session entry can legitimately reference a process that
    // remains alive for sibling sessions. Do not wait for that whole process
    // before re-adding this session.
    if (isChildProcessRunning(existing?.process) && existing.stopped && !existing.processGroupKey) {
      await waitForProcessExit(existing.process);
    }

    const runtimeDisplayName = await resolveRuntimeDisplayName(agent, resolvedSessionId);

    // ── Shared-process decision ──────────────────────────────
    // `shared-by-project` groups sessions by project path; `shared-global`
    // groups programming-helper sessions across projects. Both modes retain
    // the target session's projectDir and pass it as workspaceCwd below.
    let processMode = agent.processMode || PROCESS_MODE_ISOLATED;
    let processGroupKey = null;
    let projectDir = '';
    let sessionRecordType = null;
    if (resolvedSessionId) {
      try {
        const idx = await readSessionIndex(agent.id);
        const sessionRecord = (idx?.sessions || []).find(s => s.id === resolvedSessionId);
        const placement = resolveManagedProcessPlacement(agent, sessionRecord);
        processMode = placement.processMode;
        projectDir = placement.projectDir;
        processGroupKey = placement.processGroupKey;
        sessionRecordType = cleanSessionText(sessionRecord?.sessionType) || null;
      } catch {
        // Session index unreadable — retain the agent-level default.
      }
    }
    // Runtime startup is session-type aware (coder sessions dispatch to the
    // coder assembly). When the caller does not pass an explicit type, fall
    // back to the session index record so every path (restart, activate,
    // resume) carries it consistently.
    if (sessionRecordType && !runtimeOptions?.extraEnv?.PROTOCLAW_SESSION_TYPE) {
      runtimeOptions = {
        ...runtimeOptions,
        extraEnv: {
          ...(runtimeOptions?.extraEnv || {}),
          PROTOCLAW_SESSION_TYPE: sessionRecordType,
        },
      };
    }
    if (processGroupKey && resolvedSessionId) {
      const existingShared = findSharedProcessRuntime(processGroupKey);
        if (existingShared) {
          // ── Join existing shared process via IPC ──
          const sharedRuntime = {
            key: getManagedRuntimeKey(agent.id, resolvedSessionId),
            agentId: agent.id,
            id: agent.id,
            process: existingShared.process,
            startedAt: new Date().toISOString(),
            exitCode: null,
            stopped: false,
            viewerAgentId: null,
            selectedSessionId: resolvedSessionId || null,
            ready: false,
            sessionType: runtimeOptions?.extraEnv?.PROTOCLAW_SESSION_TYPE || null,
            gcChatId: null,
            processGroupKey,
          };
          managedAgents.set(sharedRuntime.key, sharedRuntime);

          // Wait for session-ready / session-error IPC reply
          const readyResult = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              existingShared.process.removeListener('message', handler);
              reject(new Error(`add-session timeout after ${RUNTIME_READY_WAIT_MS}ms`));
            }, RUNTIME_READY_WAIT_MS);

            const handler = (msg) => {
              if (!msg || typeof msg !== 'object') return;
              if (msg.sessionId !== resolvedSessionId) return;
              if (msg.type === 'session-ready') {
                clearTimeout(timeout);
                existingShared.process.removeListener('message', handler);
                resolve(msg);
              } else if (msg.type === 'session-error') {
                clearTimeout(timeout);
                existingShared.process.removeListener('message', handler);
                reject(new Error(msg.error || 'session-error'));
              }
            };
            existingShared.process.on('message', handler);

            existingShared.process.send(buildSharedSessionStartMessage({
              sessionId: resolvedSessionId,
              agentName: runtimeDisplayName,
              projectDir,
              handoffPath: runtimeOptions?.extraEnv?.PROTOCLAW_HANDOFF_PATH,
              runtime: {
                sessionType: runtimeOptions?.extraEnv?.PROTOCLAW_SESSION_TYPE,
                gcChatId: runtimeOptions?.extraEnv?.PROTOCLAW_GC_CHAT_ID,
                modelPresetRole: runtimeOptions?.extraEnv?.PROTOCLAW_MODEL_PRESET_ROLE,
              },
            }));
          }).catch(err => {
            managedAgents.delete(sharedRuntime.key);
            throw err;
          });

          sharedRuntime.viewerAgentId = readyResult.viewerAgentId;
          sharedRuntime.ready = true;
          notifyRuntimeReady(agent.id, resolvedSessionId || null);
          if (resolvedSessionId) {
            addOpenSession(agent.id, resolvedSessionId).catch(e => console.warn(e));
          }
          return buildStatus(agent.id, resolvedSessionId);
      }
    }
    const child = spawn(process.execPath, [RUNTIME_SCRIPT, agent.relativeDir, agent.id, runtimeDisplayName, resolvedSessionId || NO_SESSION_TOKEN], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: sanitizeSpawnEnv({
        ...childProcessEnv(),
        AGENTDEV_DEBUG_TRANSPORT: 'viewer-worker',
        AGENTDEV_VIEWER_PORT: String(VIEWER_PORT),
        AGENTDEV_UDS_PATH: resolveInstanceUdsPath(),
        PROTOCLAW_SERVER_ORIGIN: APP_ORIGIN,
        PROTOCLAW_INTERNAL_TOKEN: getInternalAuthToken(),
        PROTOCLAW_PREBUILT_AGENT_ID: String(agent.id || ''),
        PROTOCLAW_PREBUILT_SESSION_ID: resolvedSessionId || '',
        ...(runtimeOptions?.extraEnv && typeof runtimeOptions.extraEnv === 'object' ? runtimeOptions.extraEnv : {}),
        ...buildSessionWorkspaceEnv(agent.id, resolvedSessionId, projectDir),
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
      processGroupKey: processGroupKey || null,
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
      // Mark ALL runtimes sharing this process as stopped
      const sharedRuntimes = listRuntimesByProcess(child);
      for (const rt of sharedRuntimes) {
        rt.exitCode = code;
        rt.signalCode = signal || child.signalCode || null;
        rt.stopped = true;
        releaseRuntimeState(rt.key);
      }
      log(agent.id, `process exited with code ${code ?? 'null'} signal ${signal || child.signalCode || 'none'}`);

      // 通知外部回调（如群聊模块需要在 agent 死亡时闭环）
      // Notify for every session that was sharing this process
      for (const rt of sharedRuntimes) {
        for (const cb of exitCallbacks) {
          try {
            cb(rt.agentId || agent.id, rt.selectedSessionId || null, code, rt.key);
          } catch (e) {
            console.error('[agent-startup] exit callback error:', e);
          }
        }
      }
    });

    child.on('error', (error) => {
      const current = managedAgents.get(runtime.key);
      if (current) {
        current.exitCode = 1;
        current.stopped = true;
        releaseRuntimeState(current.key);
      }
      log(agent.id, `failed to start: ${error.message}`, 'error');
    });

    return buildStatus(agent.id, resolvedSessionId);
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
        AGENTDEV_UDS_PATH: resolveInstanceUdsPath(),
        PROTOCLAW_PREBUILT_AGENT_ID: String(agent.id || ''),
        PROTOCLAW_INTERNAL_TOKEN: getInternalAuthToken(),
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
    startAssemblyRuntime,
  };
}
