import { getAgentRuntime, listAgentRuntimes } from './agent-access.js';
import { log } from './string-helpers.js';

/**
 * Deliver a session-scoped message through one controlled boundary.
 * A shared child process cannot infer the intended session from its process
 * identity, so the runtime's own selectedSessionId is authoritative.
 */
export function sendIPCToRuntime(runtime, message) {
  if (!runtime?.process || runtime.process.exitCode !== null || runtime.stopped) {
    return false;
  }
  const targetSessionId = runtime.selectedSessionId;
  const payload = targetSessionId
    ? { ...message, __targetSessionId: targetSessionId }
    : { ...message };
  try {
    runtime.process.send(payload);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Session-scoped IPC delivery by (agentId, sessionId) key.
 *
 * ⚠ Frontend-originated control IPC (toggles / interrupts / hot swaps) should
 * resolve the runtime by viewerAgentId FIRST (getRuntimeByViewerAgentId +
 * sendIPCToRuntime) and use this as fallback only — the frontend's sessionId
 * comes from an async allAgents cache and can transiently mismatch the
 * managedAgents entry key (silent {ok:false}). Never add a cross-session
 * fallback here. See docs/frontend-rendering-patterns.md §8d and the
 * todo_control / swap_model reference implementations.
 */
export function sendIPCtoSession(targetAgentId, targetSessionId, message) {
  const runtime = getAgentRuntime(targetAgentId, targetSessionId);
  if (!runtime?.process || runtime.process.exitCode !== null || runtime.stopped) {
    log('ProtoClaw IPC', `Target ${targetAgentId}::${targetSessionId} not running`, 'warn');
    return false;
  }
  const sent = sendIPCToRuntime(runtime, message);
  log('ProtoClaw IPC', `${sent ? 'Sent' : 'Failed to send'} to ${targetAgentId}::${targetSessionId}: ${JSON.stringify(message)}`, sent ? undefined : 'error');
  return sent;
}

/**
 * Broadcast an IPC message to all active session runtimes of the given agentId.
 * Returns the number of runtimes that received the message.
 */
export function sendIPCToAllSessions(agentId, message) {
  const runtimes = listAgentRuntimes(agentId);
  let delivered = 0;
  for (const rt of runtimes) {
    const sessionId = rt.selectedSessionId ?? null;
    if (sendIPCtoSession(agentId, sessionId, message)) {
      delivered++;
    }
  }
  return delivered;
}
