import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

// ADR-0011 能力矩阵：连接级 capabilities 逐动作查询（capabilityFor），
// isRemoteWriteEnabled 收敛为 write 位的薄委托。覆盖工单最低测试集：
//   1. 本地身份三 action 恒 true（本地全能力）
//   2. 远程 capabilities 齐全 → 对应位 true
//   3. 旧远程（capabilities 缺字段 / 只有 write）→ 新位 false、write 位正确
//   4. 未知连接 / 非 remote 前缀的畸形输入 → false
//   5. isRemoteWriteEnabled 行为回归不变
//
// 装载路线（P4 T3）：remote-connections 已迁 ESM → withP2EsmCase + 真实 import。
// 用例体必须在 case 内驱动：catalog 端点与 renderAgentList 观察面经 globals
// 注入，模块级 catalog 缓存不跨 case 共享（每 case 一张新图）。

const REMOTE_CONNECTIONS = 'public/src/modules/remote-connections.js';
const ACTIONS = ['write', 'sessionOps', 'workspaceCreate'];

function withRemoteModule(catalogPayload, fn) {
  return withP2EsmCase({
    globals: {
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => catalogPayload,
      }),
      renderAgentList: () => {},
    },
  }, async (c) => fn(await c.load(REMOTE_CONNECTIONS), c));
}

describe('bridge surface (domain remote-connections)', () => {
  it('命名空间对象与函数键经桥投放，classic 写方覆盖后双向一致', async () => {
    await withRemoteModule(connectedCatalog(), async (rc, c) => {
      // 桥键存在且指向模块实现（命名空间对象是同一份引用，不是副本）
      assert.equal(typeof c.window.isRemoteNamespaceAgentId, 'function');
      assert.equal(c.window.isRemoteNamespaceAgentId('remote:a:b'), true);
      assert.equal(c.window.RemoteConnections.capabilityFor, rc.capabilityFor);
      assert.equal(c.window.RemoteConnections.refresh, rc.refreshRemoteCatalog);

      // classic 写方经 setter 转发进域模块，读方（window / 域状态）看到同一值
      const override = (value) => value === 'polluted';
      c.window.isRemoteNamespaceAgentId = override;
      assert.equal(c.window.isRemoteNamespaceAgentId, override);
      assert.equal(c.window.isRemoteNamespaceAgentId('polluted'), true);
    });
  });
});

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
    await withRemoteModule(connectedCatalog(), async (rc) => {
      await rc.refreshRemoteCatalog();
      for (const action of ACTIONS) {
        assert.equal(rc.capabilityFor('plain-agent', action), true, `local ${action}`);
      }
    });
  });

  it('remote with full capabilities reports true per action', async () => {
    await withRemoteModule(connectedCatalog({ write: true, sessionOps: true, workspaceCreate: true }), async (rc) => {
      await rc.refreshRemoteCatalog();
      for (const action of ACTIONS) {
        assert.equal(
          rc.capabilityFor('remote:server-a:runtime-main', action),
          true,
          `remote ${action}`,
        );
      }
    });
  });

  it('legacy write-only remote reports new bits false and write bit correct', async () => {
    await withRemoteModule(connectedCatalog({ write: true }), async (rc) => {
      await rc.refreshRemoteCatalog();
      assert.equal(rc.capabilityFor('remote:server-a:runtime-main', 'write'), true);
      assert.equal(rc.capabilityFor('remote:server-a:runtime-main', 'sessionOps'), false);
      assert.equal(rc.capabilityFor('remote:server-a:runtime-main', 'workspaceCreate'), false);
    });
  });

  it('remote without capabilities field (legacy) and disconnected report every action false', async () => {
    await withRemoteModule(connectedCatalog(), async (rc) => {
      await rc.refreshRemoteCatalog();
      for (const action of ACTIONS) {
        assert.equal(rc.capabilityFor('remote:server-a:runtime-main', action), false, `legacy ${action}`);
      }
    });

    await withRemoteModule({
      connections: [{ connectionId: 'server-a', name: 'Lab-B', status: 'error', workspaces: [] }],
    }, async (rc) => {
      await rc.refreshRemoteCatalog();
      for (const action of ACTIONS) {
        assert.equal(rc.capabilityFor('remote:server-a:runtime-main', action), false, `disconnected ${action}`);
      }
    });
  });

  it('unknown connections report false for every action', async () => {
    await withRemoteModule(connectedCatalog({ write: true, sessionOps: true, workspaceCreate: true }), async (rc) => {
      await rc.refreshRemoteCatalog();
      for (const action of ACTIONS) {
        assert.equal(rc.capabilityFor('remote:ghost:runtime-1', action), false, `unknown ${action}`);
      }
    });
  });

  it('malformed inputs report false, not the local all-capable true', async () => {
    await withRemoteModule(connectedCatalog({ write: true, sessionOps: true, workspaceCreate: true }), async (rc) => {
      for (const action of ACTIONS) {
        assert.equal(rc.capabilityFor(null, action), false, `null ${action}`);
        assert.equal(rc.capabilityFor(undefined, action), false, `undefined ${action}`);
        // remote: 前缀但缺 innerId → 解析失败，按不可用处理。
        assert.equal(rc.capabilityFor('remote:bare', action), false, `bare ${action}`);
      }
    });
  });

  it('unknown actions always report false even for local identities', async () => {
    await withRemoteModule(connectedCatalog({ write: true, sessionOps: true, workspaceCreate: true }), async (rc) => {
      await rc.refreshRemoteCatalog();
      assert.equal(rc.capabilityFor('plain-agent', 'read'), false);
      assert.equal(rc.capabilityFor('remote:server-a:runtime-main', 'read'), false);
    });
  });
});

describe('isRemoteWriteEnabled regression', () => {
  it('stays equivalent to the write bit of the capability matrix', async () => {
    await withRemoteModule(connectedCatalog({ write: true }), async (rc) => {
      await rc.refreshRemoteCatalog();
      assert.equal(rc.isRemoteWriteEnabled('remote:server-a:runtime-main'), true);
      assert.equal(rc.isRemoteWriteEnabled('plain-agent'), true);
      assert.equal(rc.isRemoteWriteEnabled('remote:ghost:runtime-1'), false);
    });

    await withRemoteModule(connectedCatalog(), async (rc) => {
      await rc.refreshRemoteCatalog();
      assert.equal(rc.isRemoteWriteEnabled('remote:server-a:runtime-main'), false);
    });

    await withRemoteModule({
      connections: [{ connectionId: 'server-a', name: 'Lab-B', status: 'error', workspaces: [] }],
    }, async (rc) => {
      await rc.refreshRemoteCatalog();
      assert.equal(rc.isRemoteWriteEnabled('remote:server-a:runtime-main'), false);
    });
  });
});
