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
 * todo_control reference implementation.
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
 * Broadcast a feature-comms request to every running runtime (fire-and-forget).
 *
 * server 发起的运维事件投递面（凭证刷新 ADR-0028 修订一 → ADR-0034 收编为
 * model-selection 的 onHostRequest）：消息走宿主通用 feature-comms-request
 * 分支（按 featureId 寻址 feature 实例），不新增宿主专用 IPC 分支。未装配
 * 目标 feature 的 runtime 由宿主回 operation_unavailable（装配事实驱动的
 * 自然降级）；本函数不等待回执（旧广播语义保持，结果仅 runtime 日志可见）。
 * featureId/channelId 是寻址参数而非业务分支——server 不解释请求内容。
 */
export function broadcastFeatureCommsRequest(featureId, channelId, requestType, payload = null) {
  const message = { type: 'feature-comms-request', featureId, channelId, requestType, payload };
  let delivered = 0;
  for (const runtime of managedAgents.values()) {
    if (sendIPCToRuntime(runtime, message)) {
      delivered++;
    }
  }
  if (delivered > 0) {
    log('ProtoClaw IPC', `Broadcast feature-comms request to ${delivered} runtime(s): ${featureId}/${channelId} ${requestType}`);
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
