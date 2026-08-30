import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

// ADR-0011 能力矩阵：连接级 capabilities 逐动作查询（capabilityFor），
// isRemoteWriteEnabled 收敛为 write 位的薄委托。覆盖工单最低测试集：
//   1. 本地身份三 action 恒 true（本地全能力）
//   2. 远程 capabilities 齐全 → 对应位 true
//   3. 旧远程（capabilities 缺字段 / 只有 write）→ 新位 false、write 位正确
//   4. 未知连接 / 非 remote 前缀的畸形输入 → false
//   5. isRemoteWriteEnabled 行为回归不变

const ACTIONS = ['write', 'sessionOps', 'workspaceCreate'];

function loadRemoteModule(catalogPayload) {
  const ctx = createFrontendSandbox({
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => catalogPayload,
    }),
    renderAgentList: () => {},
    t: (key) => key,
    escapeHtml: (value) => String(value ?? ''),
    isRemoteNamespaceAgentId: (value) => String(value || '').startsWith('remote:'),
    currentRuntimeAgentId: null,
    allAgents: [],
  });
  ctx.loadSource('public/src/modules/remote-connections.js');
  return ctx;
}

function connectedCatalog(capabilities) {
  const section = {
    connectionId: 'server-a',
    name: 'Lab-B',
    status: 'connected',
    workspaces: [],
    ...(capabilities ? { capabilities } : {}),
  };
  return { connections: [section] };
}

describe('capability matrix', () => {
  it('local identities are fully capable across all actions', async () => {
    const ctx = loadRemoteModule(connectedCatalog());
    await ctx.window.RemoteConnections.refresh();
    for (const action of ACTIONS) {
      assert.equal(ctx.window.RemoteConnections.capabilityFor('plain-agent', action), true, `local ${action}`);
    }
  });

  it('remote with full capabilities reports true per action', async () => {
    const ctx = loadRemoteModule(connectedCatalog({ write: true, sessionOps: true, workspaceCreate: true }));
    await ctx.window.RemoteConnections.refresh();
    for (const action of ACTIONS) {
      assert.equal(
        ctx.window.RemoteConnections.capabilityFor('remote:server-a:runtime-main', action),
        true,
        `remote ${action}`,
      );
    }
  });

  it('legacy write-only remote reports new bits false and write bit correct', async () => {
    const ctx = loadRemoteModule(connectedCatalog({ write: true }));
    await ctx.window.RemoteConnections.refresh();
    assert.equal(ctx.window.RemoteConnections.capabilityFor('remote:server-a:runtime-main', 'write'), true);
    assert.equal(ctx.window.RemoteConnections.capabilityFor('remote:server-a:runtime-main', 'sessionOps'), false);
    assert.equal(ctx.window.RemoteConnections.capabilityFor('remote:server-a:runtime-main', 'workspaceCreate'), false);
  });

  it('remote without capabilities field (legacy) and disconnected report every action false', async () => {
    const legacy = loadRemoteModule(connectedCatalog());
    await legacy.window.RemoteConnections.refresh();
    for (const action of ACTIONS) {
      assert.equal(legacy.window.RemoteConnections.capabilityFor('remote:server-a:runtime-main', action), false, `legacy ${action}`);
    }

    const disconnected = loadRemoteModule({
      connections: [{ connectionId: 'server-a', name: 'Lab-B', status: 'error', workspaces: [] }],
    });
    await disconnected.window.RemoteConnections.refresh();
    for (const action of ACTIONS) {
      assert.equal(disconnected.window.RemoteConnections.capabilityFor('remote:server-a:runtime-main', action), false, `disconnected ${action}`);
    }
  });

  it('unknown connections report false for every action', async () => {
    const ctx = loadRemoteModule(connectedCatalog({ write: true, sessionOps: true, workspaceCreate: true }));
    await ctx.window.RemoteConnections.refresh();
    for (const action of ACTIONS) {
      assert.equal(ctx.window.RemoteConnections.capabilityFor('remote:ghost:runtime-1', action), false, `unknown ${action}`);
    }
  });

  it('malformed inputs report false, not the local all-capable true', () => {
    const ctx = loadRemoteModule(connectedCatalog({ write: true, sessionOps: true, workspaceCreate: true }));
    for (const action of ACTIONS) {
      assert.equal(ctx.window.RemoteConnections.capabilityFor(null, action), false, `null ${action}`);
      assert.equal(ctx.window.RemoteConnections.capabilityFor(undefined, action), false, `undefined ${action}`);
      // remote: 前缀但缺 innerId → 解析失败，按不可用处理。
      assert.equal(ctx.window.RemoteConnections.capabilityFor('remote:bare', action), false, `bare ${action}`);
    }
  });

  it('unknown actions always report false even for local identities', async () => {
    const ctx = loadRemoteModule(connectedCatalog({ write: true, sessionOps: true, workspaceCreate: true }));
    await ctx.window.RemoteConnections.refresh();
    assert.equal(ctx.window.RemoteConnections.capabilityFor('plain-agent', 'read'), false);
    assert.equal(ctx.window.RemoteConnections.capabilityFor('remote:server-a:runtime-main', 'read'), false);
  });
});

describe('isRemoteWriteEnabled regression', () => {
  it('stays equivalent to the write bit of the capability matrix', async () => {
    const ctx = loadRemoteModule(connectedCatalog({ write: true }));
    await ctx.window.RemoteConnections.refresh();
    assert.equal(ctx.window.RemoteConnections.isRemoteWriteEnabled('remote:server-a:runtime-main'), true);
    assert.equal(ctx.window.RemoteConnections.isRemoteWriteEnabled('plain-agent'), true);
    assert.equal(ctx.window.RemoteConnections.isRemoteWriteEnabled('remote:ghost:runtime-1'), false);

    const legacy = loadRemoteModule(connectedCatalog());
    await legacy.window.RemoteConnections.refresh();
    assert.equal(legacy.window.RemoteConnections.isRemoteWriteEnabled('remote:server-a:runtime-main'), false);

    const disconnected = loadRemoteModule({
      connections: [{ connectionId: 'server-a', name: 'Lab-B', status: 'error', workspaces: [] }],
    });
    await disconnected.window.RemoteConnections.refresh();
    assert.equal(disconnected.window.RemoteConnections.isRemoteWriteEnabled('remote:server-a:runtime-main'), false);
  });
});
