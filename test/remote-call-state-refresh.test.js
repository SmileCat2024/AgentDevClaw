import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

// ── Catalog fixtures ────────────────────────────────────────────────────────

function connectedCatalog() {
  return {
    connections: [{
      connectionId: 'server-a',
      name: 'Lab-B',
      status: 'connected',
      workspaces: [{
        groupKey: 'remote:server-a:programming-helper:%2Fsrv%2Fproject-c',
        displayName: 'Lab-B：project-c',
        projectName: 'Lab-B：project-c',
        projectDir: '/srv/project-c',
        entries: [
          {
            id: 'remote:server-a:rt-main',
            runtimeId: 'remote:server-a:rt-main',
            agentId: 'remote:server-a:programming-helper',
            sidebarEntryId: 'programming-helper',
            sessionType: 'main',
            name: '主会话',
          },
          {
            id: 'remote:server-a:rt-coder',
            runtimeId: 'remote:server-a:rt-coder',
            agentId: 'remote:server-a:programming-helper',
            sidebarEntryId: 'programming-helper:coder',
            sessionType: 'coder',
            name: 'Coder 会话',
          },
        ],
      }],
    }],
  };
}

// 断开后的目录：workspaces 缺失由 _rcMemoryByConnection 记忆兜底（真实语义）。
function disconnectedCatalog() {
  return {
    connections: [{
      connectionId: 'server-a',
      name: 'Lab-B',
      status: 'disconnected',
    }],
  };
}

// ── Sandbox harness ─────────────────────────────────────────────────────────

function notificationUrl(runtimeId) {
  return `/api/agents/${encodeURIComponent(runtimeId)}/notification`;
}

/**
 * 加载 remote-connections.js（ESM，真实 import）+ sidebar-render.js 等 classic
 * 宿主链（prepareClassicSandbox）到同一用例沙箱；isRuntimeCalling 来自仍 classic
 * 的 runtime-status。sidebar-render 的跨模块依赖按最小契约 stub。
 *
 * 装载路线（P4 T3）：remote-connections 已迁 ESM → withP2EsmCase；目录端点与
 * renderAgentList 渲染 sink 经 globals / 沙箱全局注入，classic 相由
 * prepareClassicSandbox 按生产顺序装载。
 */
const REMOTE_CONNECTIONS = 'public/src/modules/remote-connections.js';

function withCallStateSandbox({ catalogResponses, notifications = {}, agents = [] }, fn) {
  const fetchedUrls = [];
  const renderCalls = [];
  let catalogCall = 0;
  let agentCallActive = null;

  return withP2EsmCase({
    classic: (sandbox) => {
      // 真实 classic owner：prepareClassicSandbox 装载 app-core/runtime-status/
      // sidebar-render/app-main，app-main IIFE 创建唯一引擎；本文件只补 remote
      // 目录实现与下游渲染 sink。
      prepareClassicSandbox(sandbox);
      agentCallActive = sandbox.run('_agentCallActive');
      sandbox.run('_agentCallActive.clear(); _agentSuspended.clear(); _interruptSuppression.clear(); _recentlyFinishedRuntimes.clear();');
      sandbox.renderAgentList = () => { renderCalls.push(agentCallActive.size); };
      sandbox.allAgents = agents;
      sandbox.currentRuntimeAgentId = null;
      sandbox._syncPersistentActionButton = () => {};
      sandbox._syncPersistentInputUi = () => {};
    },
    globals: {
      _markAgentCallStartedForNotify: () => {},
      fetch: async (url) => {
        const target = String(url);
        fetchedUrls.push(target);
        if (target.startsWith('/protoclaw/remote_catalog')) {
          const payload = catalogResponses[Math.min(catalogCall, catalogResponses.length - 1)];
          catalogCall += 1;
          return { ok: true, status: 200, json: async () => payload };
        }
        const notification = notifications[target];
        if (notification) return { ok: true, status: 200, json: async () => notification };
        return { ok: false, status: 503, json: async () => ({}) };
      },
    },
  }, async (c) => {
    const rc = await c.load(REMOTE_CONNECTIONS);
    return fn({
      ctx: c,
      rc,
      agentCallActive,
      fetchedUrls,
      renderCalls,
      refreshCatalog: () => rc.refreshRemoteCatalog(),
      refreshCallStates: (localAgents, options = { force: true }) =>
        c.read('refreshAgentCallStates')(localAgents, options),
      renderSignature: () => c.read('getAgentListRenderSignature')(),
    });
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('remote call-state refresh', () => {
  it('getVisibleRemoteEntries projects every visible entry with connection-derived status', async () => {
    await withCallStateSandbox({ catalogResponses: [connectedCatalog(), disconnectedCatalog()] }, async (harness) => {
      await harness.refreshCatalog();

      // vm 跨 realm 对象原型不同，JSON 归一化后比较
      assert.deepEqual(JSON.parse(JSON.stringify(
        harness.rc.getVisibleRemoteEntries(),
      )), [
        { runtimeId: 'remote:server-a:rt-main', status: 'connected' },
        { runtimeId: 'remote:server-a:rt-coder', status: 'connected' },
      ]);

      // 断开后条目仍按记忆可见，status 跟随连接态降级
      await harness.refreshCatalog();
      assert.deepEqual(JSON.parse(JSON.stringify(
        harness.rc.getVisibleRemoteEntries(),
      )), [
        { runtimeId: 'remote:server-a:rt-main', status: 'disconnected' },
        { runtimeId: 'remote:server-a:rt-coder', status: 'disconnected' },
      ]);
    });
  });

  it('polls online remote entries and writes _agentCallActive under the raw remote key', async () => {
    await withCallStateSandbox({
      catalogResponses: [connectedCatalog()],
      notifications: {
        [notificationUrl('remote:server-a:rt-main')]: { callActive: true },
        [notificationUrl('remote:server-a:rt-coder')]: { callActive: false },
      },
    }, async (harness) => {
      await harness.refreshCatalog();

      // 空 local agents：仅剩远程条目时也必须走完整轮询（提前 return 分支
      // 必须在合并远程集合之后判断）
      await harness.refreshCallStates([]);

      assert.equal(harness.agentCallActive.get('remote:server-a:rt-main'), true);
      assert.equal(harness.fetchedUrls.includes(notificationUrl('remote:server-a:rt-main')), true);
      // 真实 isRuntimeCalling 按原始字符串 key 命中，不做 normalize
      assert.equal(harness.ctx.read('isRuntimeCalling("remote:server-a:rt-main")'), true);
      assert.equal(harness.ctx.read('isRuntimeCalling("remote:server-a:rt-coder")'), false);
    });
  });

  it('cleanup keeps online remote keys while the runtime is still calling', async () => {
    await withCallStateSandbox({
      catalogResponses: [connectedCatalog()],
      notifications: {
        [notificationUrl('remote:server-a:rt-main')]: { callActive: true },
      },
    }, async (harness) => {
      await harness.refreshCatalog();

      // 模拟聚焦会话 pre-warm / chat 轮询先写入的 key
      harness.agentCallActive.set('remote:server-a:rt-main', true);
      await harness.refreshCallStates([]);

      // 清理循环不得把在线远程 key 当孤儿删掉（发送按钮横跳的根因回归）
      assert.equal(harness.agentCallActive.get('remote:server-a:rt-main'), true);
      assert.equal(harness.ctx.read('isRuntimeCalling("remote:server-a:rt-main")'), true);
    });
  });

  it('cleanup still purges keys of remote entries that are no longer online', async () => {
    await withCallStateSandbox({
      catalogResponses: [connectedCatalog(), disconnectedCatalog()],
      notifications: {
        [notificationUrl('local-rt')]: { callActive: false },
      },
      agents: [{ id: 'host', runtimeId: 'local-rt', connected: true }],
    }, async (harness) => {
      await harness.refreshCatalog();

      // 连接断开前的残留 calling 状态
      harness.agentCallActive.set('remote:server-a:rt-main', true);
      await harness.refreshCatalog();
      await harness.refreshCallStates();

      assert.equal(harness.agentCallActive.has('remote:server-a:rt-main'), false);
      assert.equal(harness.ctx.read('isRuntimeCalling("remote:server-a:rt-main")'), false);
    });
  });

  it('render signature changes when a remote entry starts or stops calling', async () => {
    await withCallStateSandbox({ catalogResponses: [connectedCatalog()] }, async (harness) => {
      await harness.refreshCatalog();

      const signatureBefore = harness.renderSignature();

      // 模拟 chat 轮询把聚焦远程会话置为 calling
      harness.agentCallActive.set('remote:server-a:rt-main', true);
      const signatureCalling = harness.renderSignature();
      assert.notEqual(signatureCalling, signatureBefore);

      harness.agentCallActive.delete('remote:server-a:rt-main');
      assert.equal(harness.renderSignature(), signatureBefore);
    });
  });
});
