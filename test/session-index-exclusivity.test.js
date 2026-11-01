/**
 * 会话索引单一写者启动闸 assertSessionIndexExclusivity（agent-startup.js）
 *
 * 事实模型（真机实测）：WAL 锁跨不过 Windows 宿主 ↔ 容器 VM 边界；本地
 * runtime 子进程长持 db 连接（跨进程无法驱逐），容器打开同一 index.db 必报
 * SQLITE_IOERR。启动闸在 spawn 前结构化拒绝并存（409），而不是事后撞锁。
 *
 * 覆盖矩阵：
 * - container 后端：委托态（容器运行中）→ 409 container_runtime_active；
 *   同 agent 存活本地 runtime → 409 local_runtime_active（已退出的本地
 *   runtime 不拦截；容器 runtime 不计入本地拦截）。
 * - 本地后端：委托态 → 409 container_runtime_active；无委托不拦。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { managedAgents, getManagedRuntimeKey } from '../server/shared/agent-access.js';
import { delegateSessionDb, resumeSessionDb } from '../server/shared/session-access.js';
import { assertSessionIndexExclusivity } from '../server/routes/agent-startup.js';

const AGENT = 'gate-test-agent';

function seedRuntime({ container = false, exited = false, stopped = false } = {}) {
  const key = getManagedRuntimeKey(AGENT, `sess-${container ? 'c' : 'l'}-${Math.random().toString(36).slice(2, 7)}`);
  const runtime = {
    key, agentId: AGENT, id: key, selectedSessionId: key, stopped,
    process: { exitCode: exited ? 0 : null, signalCode: null, __isContainerRuntime: container },
  };
  managedAgents.set(key, runtime);
  return runtime;
}

function expectReject(fn, code) {
  assert.throws(fn, (error) => error.code === code && error.statusCode === 409);
}

describe('assertSessionIndexExclusivity 会话索引单一写者启动闸', () => {
  beforeEach(() => {
    managedAgents.clear();
    resumeSessionDb(AGENT);
  });

  it('无并存时 container 与本地后端均放行', () => {
    assert.doesNotThrow(() => assertSessionIndexExclusivity(AGENT, '显示名', 'container'));
    assert.doesNotThrow(() => assertSessionIndexExclusivity(AGENT, '显示名', 'local'));
  });

  it('container 后端：同 agent 存活本地 runtime → local_runtime_active', () => {
    seedRuntime({ container: false });
    expectReject(() => assertSessionIndexExclusivity(AGENT, '显示名', 'container'), 'local_runtime_active');
  });

  it('container 后端：已退出的本地 runtime 不拦截（记录残留非存活）', () => {
    seedRuntime({ exited: true, stopped: true });
    assert.doesNotThrow(() => assertSessionIndexExclusivity(AGENT, '显示名', 'container'));
  });

  it('container 后端：存活的容器 runtime 不计入本地拦截（由委托态拦截覆盖）', () => {
    // 容器 runtime 存活时必然处于委托态；此处单独验证 __isContainerRuntime
    // 过滤：无委托态的容器记录（异常残留）不误报 local_runtime_active。
    seedRuntime({ container: true });
    assert.doesNotThrow(() => assertSessionIndexExclusivity(AGENT, '显示名', 'container'));
  });

  it('container 后端：委托态 → container_runtime_active（第二个容器互斥）', () => {
    delegateSessionDb(AGENT);
    expectReject(() => assertSessionIndexExclusivity(AGENT, '显示名', 'container'), 'container_runtime_active');
  });

  it('本地后端：委托态 → container_runtime_active（容器运行期本地启动互斥）', () => {
    delegateSessionDb(AGENT);
    expectReject(() => assertSessionIndexExclusivity(AGENT, '显示名', 'local'), 'container_runtime_active');
  });

  it('本地后端：本地 runtime 并存不受拦截（本地多 runtime 共用进程内连接，无容器边界）', () => {
    seedRuntime({ container: false });
    assert.doesNotThrow(() => assertSessionIndexExclusivity(AGENT, '显示名', 'local'));
  });

  it('错误消息携带显示名与可操作指引', () => {
    seedRuntime({ container: false });
    assert.throws(
      () => assertSessionIndexExclusivity(AGENT, '编程小助手', 'container'),
      /编程小助手 有本地（非容器）会话正在运行.*请先停止本地会话/,
    );
  });
});
