import { spawn } from 'child_process';
import { appendFileSync, mkdirSync, promises as fs } from 'fs';
import path from 'path';
import {
  RUNTIME_SCRIPT,
  VIEWER_PORT, APP_ORIGIN, PROJECT_ROOT,
  NO_SESSION_TOKEN,
  PROCESS_EXIT_WAIT_MS, RUNTIME_READY_WAIT_MS,
  CALL_EXECUTION_TIMEOUT_MS,
  resolveInstanceUdsPath,
  resolveUserDataDir,
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
import { resolveDesktopWorkspace } from '../shared/desktop-workspace.js';
import { WORKSPACE_SESSION_AGENT_IDS } from '../shared/constants.js';
import { getInternalAuthToken } from '../auth.js';
import { convergeThreadBoardOnDeliberateStop } from '../thread-control/deliberate-stop-convergence.js';
import {
  PROCESS_MODE_ISOLATED,
  PROCESS_MODE_SHARED_BY_PROJECT,
  PROCESS_MODE_SHARED_GLOBAL,
  GLOBAL_SHARED_AGENT_ID,
} from '../shared/process-mode.js';
import { releaseRuntimeState } from '../runtime-call-envelope.js';
import { withSessionOperation } from '../shared/session-operation.js';
import { getThreadIntegration } from '../thread-control/thread-integration.js';
import { featureCommunicationStore } from './feature-communication.js';
import {
  ensureAssemblyWorkspaceBase, ensureAssemblyWorkspaceDependencies,
} from './assembly-helpers.js';
import { readWorkspaceState, writeWorkspaceState } from './workspace.js';
import { readProjectIMWorkspaceConfig } from './im.js';
import { addOpenSession } from '../shared/open-sessions-tracker.js';
import { resolveSessionRuntimeDirectory } from '../shared/session-project.js';
import { getPhSessionGateInfo, getPhProjectGateInfo } from './ph-projects.js';

const RUNTIME_DIAGNOSTIC_TAIL_CHARS = 8000;

export function persistRuntimeDiagnostic({ agentId, sessionId, event, details = '' }) {
  const logPath = path.join(resolveUserDataDir(), 'logs', 'runtime.log');
  const header = `${new Date().toISOString()} [${event}] agent=${agentId} session=${sessionId || 'none'}`;
  const line = details ? `${header}\n${details}\n` : `${header}\n`;
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, line, 'utf8');
  } catch { /* diagnostics must not affect runtime lifecycle */ }
}

function appendProcessOutputTail(child, text) {
  child.__runtimeOutputTail = `${child.__runtimeOutputTail || ''}${text}`.slice(-RUNTIME_DIAGNOSTIC_TAIL_CHARS);
}

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

export function resolveManagedProcessPlacement(agent, sessionRecord, resolvedProjectDir) {
  const agentId = sanitizeSessionFragment(agent?.id);
  // ticket 042：项目会话的运行目录由调用方先经 resolveSessionRuntimeDirectory
  // 从项目表解析（resolvedProjectDir 传入）；缺省时沿用 openDirectory（目录
  // 会话语义）。processGroupKey 跟随解析后的目录——同路径项目/目录会话按现有
  // 进程模式分组，不因项目配置强制改变进程形态。
  const projectDir = typeof resolvedProjectDir === 'string'
    ? resolvedProjectDir.trim()
    : (typeof sessionRecord?.openDirectory === 'string'
      ? sessionRecord.openDirectory.trim()
      : '');
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
    processGroupKey: computeProcessGroupKey(agentId, projectDir, processMode),
  };
}

// ── Agent Startup ────────────────────────────────────────────────
// Factory that produces all process-spawning and runtime-readiness
// functions. Dependencies are injected to avoid circular imports
// and to share mutable state (exitCallbacks array).

export function createAgentStartupFns(deps) {
  const {
    sessionApi,
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
        // 轻量 viewer 列表探测（与 waitForAssemblyRuntimeReady 同模式）：
        // getConnectedAgents 每次调用都要重建富会话投影（百 ms 级），
        // 这里只确认 viewer 是否已列出该 agent，200ms 轮询不应反复支付该成本。
        const viewerData = await readViewerJson('/api/agents').catch(() => ({ agents: [] }));
        const agents = Array.isArray(viewerData?.agents) ? viewerData.agents : [];
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

    return withSessionOperation(agent.id, resolvedSessionId, 'start', () =>
      startManagedSession(agent, resolvedSessionId, runtimeOptions));
  }

  async function startManagedSession(agent, resolvedSessionId, runtimeOptions) {
    const existing = getAgentRuntime(agent.id, resolvedSessionId);
    if (resolvedSessionId) {
      await getThreadIntegration().assertSessionStartable(agent.id, resolvedSessionId);
      const index = await readSessionIndex(agent.id);
      const record = index.sessions.find(session => session.id === resolvedSessionId);
      if (!record || record.archived) {
        throw Object.assign(new Error(record ? 'Restore the archived session before starting it' : 'Session not found'), {
          code: record ? 'session_archived' : 'session_not_found', status: record ? 409 : 404, statusCode: record ? 409 : 404,
        });
      }
    }
    // ticket 046：PH 归属释放窗口（项目改绑 / 会话归属转移）先于一切复用与
    // 启动判定。下方 existing 复用会直接返回按旧归属装配的存活实例；spawn
    // 会按旧索引记录绑旧目录——两者都会在转移落盘后变成幽灵实例，必须在此
    // 提前拒绝（无窗口时空表短路，热路径零成本）。
    const phSessionGate = resolvedSessionId ? getPhSessionGateInfo(resolvedSessionId) : null;
    if (phSessionGate) {
      const error = new Error(phSessionGate.message);
      error.statusCode = 409;
      error.code = phSessionGate.code;
      throw error;
    }

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
          //
          // branch 注入包（ADR-0034 §4.1）例外：分支快照创建时本就带边界前的
          // 历史消息，消息数守卫对它恒假；它传递的是 Feature continuity（非
          // seed 消息），runtime 首启导入后自删注入文件，不会重复注入。
          let shouldInjectHandoff = true;
          let handoffIsBranch = false;
          try {
            const rawHandoff = await fs.readFile(sessionRecord.metadata.handoffPath, 'utf8');
            handoffIsBranch = JSON.parse(rawHandoff)?.mode === 'branch';
          } catch {
            // handoff 文件缺失（已消费）或损坏：按非 branch 走消息数守卫——
            // 分支会话有消息则不注入（消费侧 loadRuntimeHandoffFromPath 亦容错）。
          }
          if (!handoffIsBranch) {
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

    if (existing?.stopping) {
      const error = new Error('Session runtime is closing; wait for retirement before starting it again');
      error.code = 'session_closing';
      error.statusCode = 409;
      throw error;
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
    let sessionRecord = null;
    if (resolvedSessionId) {
      try {
        const idx = await readSessionIndex(agent.id);
        sessionRecord = (idx?.sessions || []).find(s => s.id === resolvedSessionId) || null;
      } catch {
        // Session index unreadable — retain the agent-level default.
      }
    }
    // ticket 042：项目会话的运行目录以项目表当前记录为权威（改绑后跟随新
    // 目录），openDirectory 只是创建时的目录记录。项目身份无法解析时直接
    // 报错——绝不退回 openDirectory 旧记录或 workspace 当前目录继续运行。
    // 解析放在上面的 try 之外：项目身份失效是确定性错误，不能被索引读取
    // 容错吞掉。
    if (sessionRecord) {
      // ticket 046：归属窗口（改绑 / 转移 / 归档 / 删除）内拒绝按旧表启动，
      // 否则新 runtime 会绑到旧目录、窗口落盘后变成幽灵实例。
      const recordProjectId = cleanSessionText(sessionRecord?.projectId);
      if (recordProjectId) {
        const projectGate = getPhProjectGateInfo(recordProjectId);
        if (projectGate) {
          const error = new Error(projectGate.message);
          error.statusCode = 409;
          error.code = projectGate.code;
          throw error;
        }
      }
      const sessionProjectDir = resolveSessionRuntimeDirectory(sessionRecord, { sessionId: resolvedSessionId });
      sessionRecordType = cleanSessionText(sessionRecord?.sessionType) || null;
      const placement = resolveManagedProcessPlacement(agent, sessionRecord, sessionProjectDir || undefined);
      processMode = placement.processMode;
      projectDir = placement.projectDir;
      processGroupKey = placement.processGroupKey;
    }
    // Runtime startup carries the session record's run-form tag (e.g.
    // 'exploration') for agents that branch on it. When the caller does not
    // pass an explicit type, fall back to the session index record so every
    // path (restart, activate, resume) carries it consistently. The tag is
    // not an identity (ADR-0025).
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
              const error = new Error(`add-session timeout after ${RUNTIME_READY_WAIT_MS}ms`);
              persistRuntimeDiagnostic({
                agentId: agent.id,
                sessionId: resolvedSessionId,
                event: 'shared-session-timeout',
                details: `${error.message}\nruntimePid=${existingShared.process.pid || 'unknown'}\nruntimeOutputTail:\n${existingShared.process.__runtimeOutputTail || '(no output captured)'}`,
              });
              reject(error);
            }, RUNTIME_READY_WAIT_MS);

            const handler = (msg) => {
              if (!msg || typeof msg !== 'object') return;
              if (msg.sessionId !== resolvedSessionId) return;
              if (msg.type === 'runtime-identity') {
                if (msg.agentId !== agent.id || msg.sessionId !== resolvedSessionId) return;
                const viewerAgentId = cleanSessionText(msg.viewerAgentId);
                if (!viewerAgentId) return;
                sharedRuntime.viewerAgentId = viewerAgentId;
                existingShared.process.send({ ...msg, type: 'runtime-identity-accepted' });
                return;
              }
              if (msg.type === 'session-ready') {
                clearTimeout(timeout);
                existingShared.process.removeListener('message', handler);
                resolve(msg);
              } else if (msg.type === 'session-error') {
                clearTimeout(timeout);
                existingShared.process.removeListener('message', handler);
                persistRuntimeDiagnostic({
                  agentId: agent.id,
                  sessionId: resolvedSessionId,
                  event: 'shared-session-error',
                  details: `runtimePid=${existingShared.process.pid || 'unknown'}\n${msg.error || 'session-error'}\nruntimeOutputTail:\n${existingShared.process.__runtimeOutputTail || '(no output captured)'}`,
                });
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

    const runtimeCwd = agent.id === 'agent-studio' && projectDir
      ? projectDir
      : (WORKSPACE_SESSION_AGENT_IDS.has(agent.id) ? PROJECT_ROOT : resolveDesktopWorkspace());
    const child = spawn(process.execPath, [RUNTIME_SCRIPT, agent.relativeDir, agent.id, runtimeDisplayName, resolvedSessionId || NO_SESSION_TOKEN], {
      cwd: runtimeCwd,
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
    child.on('message', (message) => {
      if (message?.type === 'session-exited') {
        const retired = listRuntimesByProcess(child).find(rt => rt.selectedSessionId === message.sessionId);
        if (retired) {
          retired.persistenceConfirmed = message.persisted === true;
          retired.stopped = true;
          releaseRuntimeState(retired.key);
          featureCommunicationStore.closeSession(retired.agentId, retired.selectedSessionId);
        }
        return;
      }
      if (message?.type !== 'runtime-identity') return;
      if (message.agentId !== agent.id || message.sessionId !== (resolvedSessionId || null)) return;
      const viewerAgentId = cleanSessionText(message.viewerAgentId);
      if (!viewerAgentId) return;

      // The child must publish its session ownership before registering with
      // ViewerWorker. Acknowledge only after the managed runtime record is
      // updated, making this the authoritative identity handoff boundary.
      runtime.viewerAgentId = viewerAgentId;
      child.send({
        type: 'runtime-identity-accepted',
        agentId: agent.id,
        sessionId: resolvedSessionId || null,
        viewerAgentId,
      });
    });

    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      appendProcessOutputTail(child, text);
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
      const text = String(chunk);
      appendProcessOutputTail(child, text);
      log(agent.id, text.trim(), 'error');
    });

    child.on('exit', (code, signal) => {
      // Mark ALL runtimes sharing this process as stopped
      const sharedRuntimes = listRuntimesByProcess(child);
      for (const rt of sharedRuntimes) {
        // 人为/意外区分（C1）：宿主人为停止会先行标记 stopped=true；
        // 崩溃 / 宿主被收割到达这里时尚为 false——保留看板 running 事实，
        // 供重启恢复判定"未完成"。
        const deliberate = rt.stopped === true;
        rt.exitCode = code;
        rt.signalCode = signal || child.signalCode || null;
        rt.stopped = true;
        releaseRuntimeState(rt.key);
        if (rt.selectedSessionId) featureCommunicationStore.closeSession(rt.agentId || agent.id, rt.selectedSessionId);
        if (deliberate && rt.selectedSessionId) {
          // 进程退出确认后收敛：事件流已终止，无迟到事件反转窗口
          convergeThreadBoardOnDeliberateStop(rt.agentId || agent.id, rt.selectedSessionId)
            .catch(() => { /* 收敛失败不阻断 exit 善后 */ });
        }
      }
      const exitSummary = `process exited with code ${code ?? 'null'} signal ${signal || child.signalCode || 'none'}`;
      log(agent.id, exitSummary);
      if (code !== 0 || signal || child.signalCode) {
        persistRuntimeDiagnostic({
          agentId: agent.id,
          sessionId: resolvedSessionId,
          event: 'runtime-process-exit',
          details: `${exitSummary}\npid=${child.pid || 'unknown'}\nruntimeOutputTail:\n${child.__runtimeOutputTail || '(no output captured)'}`,
        });
      }

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
      persistRuntimeDiagnostic({
        agentId: agent.id,
        sessionId: resolvedSessionId,
        event: 'runtime-process-error',
        details: `pid=${child.pid || 'unknown'}\n${error.stack || error.message}`,
      });
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
