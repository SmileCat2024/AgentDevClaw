import { getAgentRuntime, listAgentRuntimes, managedAgents } from './agent-access.js';
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

/**
 * Broadcast a message to every running runtime, across all agents.
 *
 * Used by credential-change pushes (ADR-0028 修订：refresh-credentials)：每个
 * managedAgents 记录独立投递并盖上各自的 selectedSessionId，共享进程模式下
 * 同一进程会收到多条消息、各自路由到对应会话的 agent 实例。LLM 实例 =
 * 参数快照，凭证变更不主动重 resolve 的话，旧凭证仍有效期间运行中会话会
 * 无限期继续用旧凭证（401 自愈只覆盖旧凭证已失效的形态）。
 *
 * Returns the number of runtimes that received the message.
 */
export function broadcastIPCToAllRuntimes(message) {
  let delivered = 0;
  for (const runtime of managedAgents.values()) {
    if (sendIPCToRuntime(runtime, message)) {
      delivered++;
    }
  }
  if (delivered > 0) {
    log('ProtoClaw IPC', `Broadcast to ${delivered} runtime(s): ${JSON.stringify(message)}`);
  }
  return delivered;
}

/**
 * Request/ack IPC：带 requestId 发送并等待 runtime 回执。
 *
 * 与 sendIPCToRuntime 的 fire-and-forget 语义互补：消费方需要区分"消息送达"
 * 与"操作生效"时用本函数（如模型热切换——preset 不存在、凭证缺失等失败必须
 * 对前端可见）。回执在 child 的 'message' 事件上按 type + requestId 匹配，
 * requestId 全局唯一，无需 sessionId 三重匹配。
 *
 * @param {object} runtime - runtime 记录（.process / .stopped）
 * @param {object} message - IPC 消息（不含 requestId，本函数注入）
 * @param {string} resultType - 期望的回执消息 type
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string, meta?: object | null }>}
 */
export function requestRuntimeAck(runtime, message, resultType, opts = {}) {
  return new Promise((resolve) => {
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
      opts.timeoutMs ?? 3000,
    );
    const onMessage = (msg) => {
      if (!msg || msg.type !== resultType || msg.requestId !== requestId) return;
      if (msg.ok === true) finish({ ok: true, meta: msg.meta || null });
      else finish({ ok: false, error: msg.error || `${resultType} request rejected` });
    };
    child.on('message', onMessage);
    let sent = false;
    try {
      sent = sendIPCToRuntime(runtime, { ...message, requestId });
    } catch {
      sent = false;
    }
    if (!sent) finish({ ok: false, error: 'failed to deliver session IPC' });
  });
}
