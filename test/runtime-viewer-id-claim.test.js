/**
 * getRuntimeByViewerAgentId 的身份认领（server/shared/agent-access.js）
 *
 * 托管 runtime 记录退出后仍留在 managedAgents（供事后查询）；viewer id
 * （agent-<n>-<m>）在新 runtime 重建连接时可复用。按 viewer 身份转发的
 * 事件（/protoclaw/runtime/exited → emitHostEvent('session-exited')）必须
 * 送达当前持有身份的活跃 runtime；先入表的历史残留不得抢先认领，否则
 * 容器停止的持久化确认落空（stop_agent 500，E2E ⑤ 实测）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { managedAgents, getRuntimeByViewerAgentId, getManagedRuntimeKey } from '../server/shared/agent-access.js';

function fakeRuntime(agentId, sessionId, viewerAgentId, { exited = false, stopped = false } = {}) {
  return {
    key: getManagedRuntimeKey(agentId, sessionId),
    agentId,
    id: getManagedRuntimeKey(agentId, sessionId),
    selectedSessionId: sessionId,
    viewerAgentId,
    stopped,
    process: { exitCode: exited ? 0 : null, signalCode: null },
  };
}

describe('getRuntimeByViewerAgentId 身份认领', () => {
  beforeEach(() => {
    managedAgents.clear();
  });

  it('无记录时返回 null', () => {
    assert.equal(getRuntimeByViewerAgentId('agent-1-1'), null);
  });

  it('唯一存活记录正常命中', () => {
    const runtime = fakeRuntime('coder', 'session-a', 'agent-1-1');
    managedAgents.set(runtime.key, runtime);
    assert.equal(getRuntimeByViewerAgentId('agent-1-1'), runtime);
  });

  it('新 runtime 复用 viewer id 时，退出上报必须命中存活者而非先入表的历史残留', () => {
    const retired = fakeRuntime('coder', 'session-a', 'agent-1-1', { exited: true, stopped: true });
    const active = fakeRuntime('programming-helper', 'session-b', 'agent-1-1');
    managedAgents.set(retired.key, retired);
    managedAgents.set(active.key, active);
    assert.equal(getRuntimeByViewerAgentId('agent-1-1'), active);
  });

  it('全部已退出时按最新记录（幂等重报 no-op，不误命中更早的历史）', () => {
    const older = fakeRuntime('coder', 'session-a', 'agent-1-1', { exited: true, stopped: true });
    const newer = fakeRuntime('coder', 'session-b', 'agent-1-1', { exited: true, stopped: true });
    managedAgents.set(older.key, older);
    managedAgents.set(newer.key, newer);
    assert.equal(getRuntimeByViewerAgentId('agent-1-1'), newer);
  });
});
