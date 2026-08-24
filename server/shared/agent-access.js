import { sanitizeSessionFragment } from './string-helpers.js';
import { NO_SESSION_TOKEN, ASSEMBLY_EXIT_WAIT_MS } from './constants.js';
import { PROCESS_MODE_SHARED_BY_PROJECT, PROCESS_MODE_SHARED_GLOBAL } from './process-mode.js';
import { normalize, resolve } from 'path';

export const managedAgents = new Map();
export const assemblyRuntimeProcesses = new Map();

// ChildProcess.exitCode remains null when a process exits because of a signal.
// Treat signalCode as an equally authoritative terminal state so SIGTERM does
// not leave managed runtimes classified as "stopping" forever.
export function isChildProcessRunning(child) {
  return !!child && child.exitCode === null && !child.signalCode;
}

export function isManagedRuntimeRunning(runtime) {
  return isChildProcessRunning(runtime?.process)
    && runtime?.stopped !== true
    && runtime?.stopping !== true;
}

export function getManagedRuntimeKey(agentId, sessionId = null) {
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  const normalizedSessionId = sessionId == null ? NO_SESSION_TOKEN : sanitizeSessionFragment(sessionId);
  return `${normalizedAgentId}::${normalizedSessionId}`;
}

export function listAgentRuntimes(agentId) {
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  return Array.from(managedAgents.values())
    .filter((runtime) => sanitizeSessionFragment(runtime.agentId || runtime.id) === normalizedAgentId);
}

export function pickPrimaryAgentRuntime(agentId) {
  const runtimes = listAgentRuntimes(agentId);
  if (runtimes.length === 0) return null;
  const running = runtimes.filter(isManagedRuntimeRunning);
  const pool = running.length ? running : runtimes;
  return pool.sort((left, right) => String(right.startedAt || '').localeCompare(String(left.startedAt || '')))[0] || null;
}

export function getAgentRuntime(agentId, sessionId = undefined) {
  if (sessionId !== undefined) {
    return managedAgents.get(getManagedRuntimeKey(agentId, sessionId)) ?? null;
  }
  return pickPrimaryAgentRuntime(agentId);
}

export function getRuntimeByViewerAgentId(viewerAgentId) {
  const normalized = sanitizeSessionFragment(viewerAgentId);
  return Array.from(managedAgents.values())
    .find((runtime) => sanitizeSessionFragment(runtime.viewerAgentId || '') === normalized) || null;
}

export function getAssemblyRuntime(sessionId) {
  return assemblyRuntimeProcesses.get(sanitizeSessionFragment(sessionId)) ?? null;
}

export async function stopAssemblyRuntime(sessionId) {
  const runtime = getAssemblyRuntime(sessionId);
  if (!isManagedRuntimeRunning(runtime)) {
    return { sessionId: sanitizeSessionFragment(sessionId), status: 'stopped' };
  }

  runtime.stopped = true;
  const normalizedSessionId = sanitizeSessionFragment(sessionId);
  const waitForExit = new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), ASSEMBLY_EXIT_WAIT_MS);
    runtime.process.once('exit', () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
  runtime.process.kill('SIGTERM');
  const exited = await waitForExit;
  return {
    sessionId: normalizedSessionId,
    status: exited ? 'stopped' : 'stopping',
    viewerAgentId: runtime.viewerAgentId ?? null,
  };
}

export function buildStatus(agentId, sessionId = undefined) {
  const runtime = getAgentRuntime(agentId, sessionId);
  if (!runtime) {
    return { id: agentId, status: 'stopped', pid: null, startedAt: null, exitCode: null, signalCode: null, viewerAgentId: null, selectedSessionId: null };
  }

  const running = isManagedRuntimeRunning(runtime);
  return {
    id: agentId,
    status: running ? 'running' : 'stopped',
    pid: running ? runtime.process.pid : null,
    startedAt: runtime.startedAt ?? null,
    exitCode: runtime.exitCode ?? null,
    signalCode: runtime.signalCode ?? runtime.process?.signalCode ?? null,
    viewerAgentId: running ? (runtime.viewerAgentId ?? null) : null,
    selectedSessionId: runtime.selectedSessionId ?? null,
  };
}

// ── Shared-process support ──────────────────────────────────────

/**
 * Compute a process group key for shared-process mode.
 *
 * `shared-global` intentionally ignores the project path, but callers must
 * still require a session-owned project directory before selecting it. That
 * preserves the runtime invariant that every hosted programming session has
 * an explicit workspaceCwd rather than falling back to the host process CWD.
 *
 * A non-main sessionType (e.g. 'coder') inserts its own segment so different
 * identities of one workspace never share a process: an autonomous coder
 * session restart (thread rotation/succession) must not take down interactive
 * sessions of the same project.
 *
 * @param {string} agentId - Prebuilt agent id (e.g. 'programming-helper')
 * @param {string|null|undefined} projectDir - Absolute project directory path
 * @param {'shared-by-project'|'shared-global'} [processMode='shared-by-project']
 * @param {string|null} [sessionType] - Session identity within the workspace ('main'|'coder'|null)
 * @returns {string|null} Group key or null
 */
export function computeProcessGroupKey(agentId, projectDir, processMode = PROCESS_MODE_SHARED_BY_PROJECT, sessionType = null) {
  if (!projectDir || typeof projectDir !== 'string') return null;
  const trimmed = projectDir.trim();
  if (!trimmed) return null;

  const normalizedAgentId = sanitizeSessionFragment(agentId);
  if (processMode === PROCESS_MODE_SHARED_GLOBAL) {
    return `${normalizedAgentId}::__global__`;
  }

  const canonical = normalize(resolve(trimmed)).replace(/\\/g, '/');
  const normalized = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const scope = sessionType && sessionType !== 'main' ? `${normalizedAgentId}::${sessionType}` : normalizedAgentId;
  return `${scope}::${normalized}`;
}

/**
 * Find a running runtime that shares the given process group key.
 * Used by agent-startup.js to decide whether to send IPC add-session
 * instead of spawning a new process.
 *
 * @param {string|null} processGroupKey
 * @returns {object|null} A managed runtime entry or null
 */
export function findSharedProcessRuntime(processGroupKey) {
  if (!processGroupKey) return null;
  return Array.from(managedAgents.values())
    .find(rt => rt.processGroupKey === processGroupKey && isManagedRuntimeRunning(rt)) || null;
}

/**
 * List all runtime entries that share the same child process as the given runtime.
 * Used by process-exit handlers to mark all affected sessions as stopped.
 *
 * @param {object} childProcess - The ChildProcess to match against
 * @returns {Array<object>} Array of runtime entries sharing this process
 */
export function listRuntimesByProcess(childProcess) {
  if (!childProcess) return [];
  return Array.from(managedAgents.values())
    .filter(rt => rt.process === childProcess);
}
