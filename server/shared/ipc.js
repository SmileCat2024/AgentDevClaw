import { getAgentRuntime, listAgentRuntimes } from './agent-access.js';
import { log } from './string-helpers.js';

export function sendIPCtoSession(targetAgentId, targetSessionId, message) {
  const runtime = getAgentRuntime(targetAgentId, targetSessionId);
  if (!runtime?.process || runtime.process.exitCode !== null || runtime.stopped) {
    log('ProtoClaw IPC', `Target ${targetAgentId}::${targetSessionId} not running`, 'warn');
    return false;
  }
  try {
    runtime.process.send(message);
    log('ProtoClaw IPC', `Sent to ${targetAgentId}::${targetSessionId}: ${JSON.stringify(message)}`);
    return true;
  } catch (err) {
    log('ProtoClaw IPC', `Failed to send to ${targetAgentId}::${targetSessionId}: ${err}`, 'error');
    return false;
  }
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
