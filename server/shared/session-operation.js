import { getManagedRuntimeKey } from './agent-access.js';

// Host-owned admission for operations that may replace a Session's writer.
// Keep the lease through IO and commit, not just through runtime retirement.
const operations = new Map();

export function assertSessionNotStarting(agentId, sessionId) {
  if (operations.get(getManagedRuntimeKey(agentId, sessionId)) === 'start') {
    throw Object.assign(new Error('Session runtime is starting'), {
      code: 'session_operation_in_progress', status: 409, statusCode: 409,
    });
  }
}

/**
 * 只读查询会话当前进行中的宿主操作（'start' / 接续变换等），无则 null。
 * 消费方：feature-comms 请求面投递闸（ADR-0034 §4.2）——写者更替窗口内
 * 拒绝定向请求（409），避免请求落进即将退役的旧 runtime。
 */
export function getSessionOperation(agentId, sessionId) {
  return operations.get(getManagedRuntimeKey(agentId, sessionId)) || null;
}

export function withSessionOperations(agentId, sessionIds, operation, run) {
  const ids = [...new Set(sessionIds)].sort();
  const acquire = index => index === ids.length ? run()
    : withSessionOperation(agentId, ids[index], operation, () => acquire(index + 1));
  return acquire(0);
}

export async function withSessionOperation(agentId, sessionId, operation, run) {
  const key = getManagedRuntimeKey(agentId, sessionId);
  const active = operations.get(key);
  if (active) {
    throw Object.assign(new Error(`Session is busy with ${active}`), {
      code: 'session_operation_in_progress', status: 409, statusCode: 409,
    });
  }
  operations.set(key, operation);
  try { return await run(); }
  finally { operations.delete(key); }
}
