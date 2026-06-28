import { getAgentRuntime } from './agent-access.js';
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
