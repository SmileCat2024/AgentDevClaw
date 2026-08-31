import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

// 行尾归一化：提取标记不能依赖 CRLF（跨平台可移植）
function toLf(source) {
  return source.replace(/\r\n/g, '\n');
}

// 真实源码提取：isRuntimeCalling 是 calling 状态的唯一读取口（按原始字符串
// key 读 Map），测试必须用真实实现 + 真实 Map 验证 key 形态契约。
const runtimeStatusSource = toLf(fs.readFileSync(
  new URL('../public/src/modules/runtime-status.js', import.meta.url),
  'utf8',
));

function extractFunction(source, signature, nextMarker) {
  const start = source.indexOf(signature);
  const end = source.indexOf(nextMarker, start);
  assert.notEqual(start, -1, `missing function: ${signature}`);
  assert.notEqual(end, -1, `missing function end marker: ${nextMarker}`);
  return source.slice(start, end);
}

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
 * 加载 remote-connections.js + sidebar-render.js 真实源码到同一 vm 沙箱，
 * 并注入真实 isRuntimeCalling（源码提取）。sidebar-render 的跨模块依赖
 * 按最小契约 stub。
 */
function createCallStateSandbox({ catalogResponses, notifications = {}, agents = [] }) {
  const agentCallActive = new Map();
  const fetchedUrls = [];
  const renderCalls = [];
  let catalogCall = 0;

  const ctx = createFrontendSandbox({
    // app-core.js 全局状态
    allAgents: agents,
    focusedAgentId: null,
    currentRuntimeAgentId: null,
    currentLanguage: 'zh',
    _agentCallActive: agentCallActive,
    _interruptSuppression: new Map(),
    _recentlyFinishedRuntimes: new Set(),
    restartingRuntimeIds: new Set(),
    pendingPrebuiltAgentIds: new Set(),
    lastCallStateRefreshAt: 0,
    // 跨模块依赖 stub（与真实实现语义一致，见各源文件）
    normalizeAgentIdentity: (value) => String(value || '').trim(),
    getAgentRuntimeId: (agent) => agent?.runtimeId || agent?.id || '',
    getParentAgentId: () => '',
    getActiveSessionId: () => '',
    resolveNotificationCallingState: (payload) => payload?.callActive === true,
    getNotificationCallStartedAt: () => 0,
    isInterruptSuppressed: () => false,
    _markAgentCallStartedForNotify: () => {},
    clearInterruptSuppression: () => {},
    _tryNotifyAgentFinished: () => {},
    renderAgentList: () => { renderCalls.push(agentCallActive.size); },
    agentList: { addEventListener() {} },
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
  });

  ctx.loadSource('public/src/modules/remote-connections.js');
  ctx.loadSource('public/src/modules/sidebar-render.js');
  // sidebar-render.js 的函数声明会覆盖 sandbox 预注入的同名 stub：加载完成后
  // 重新注入 renderAgentList 测试替身（只关心渲染是否被触发，不关心渲染产物）。
  ctx.renderAgentList = () => { renderCalls.push(agentCallActive.size); };
  // 注入真实 isRuntimeCalling（runtime-status.js 依赖过多无法整体加载）
  ctx.run(extractFunction(
    runtimeStatusSource,
    'function isRuntimeCalling(',
    '\nfunction isSidebarRuntimeDisconnected(',
  ));

  return {
    ctx,
    agentCallActive,
    fetchedUrls,
    renderCalls,
    refreshCatalog: () => ctx.window.RemoteConnections.refresh(),
    refreshCallStates: (localAgents, options = { force: true }) =>
      ctx.run('refreshAgentCallStates')(localAgents, options),
    renderSignature: () => ctx.run('getAgentListRenderSignature')(),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('remote call-state refresh', () => {
  it('getVisibleRemoteEntries projects every visible entry with connection-derived status', async () => {
    const harness = createCallStateSandbox({
      catalogResponses: [connectedCatalog(), disconnectedCatalog()],
    });
    await harness.refreshCatalog();

    // vm 跨 realm 对象原型不同，JSON 归一化后比较
    assert.deepEqual(JSON.parse(JSON.stringify(
      harness.ctx.window.RemoteConnections.getVisibleRemoteEntries(),
    )), [
      { runtimeId: 'remote:server-a:rt-main', status: 'connected' },
      { runtimeId: 'remote:server-a:rt-coder', status: 'connected' },
    ]);

    // 断开后条目仍按记忆可见，status 跟随连接态降级
    await harness.refreshCatalog();
    assert.deepEqual(JSON.parse(JSON.stringify(
      harness.ctx.window.RemoteConnections.getVisibleRemoteEntries(),
    )), [
      { runtimeId: 'remote:server-a:rt-main', status: 'disconnected' },
      { runtimeId: 'remote:server-a:rt-coder', status: 'disconnected' },
    ]);
  });

  it('polls online remote entries and writes _agentCallActive under the raw remote key', async () => {
    const harness = createCallStateSandbox({
      catalogResponses: [connectedCatalog()],
      notifications: {
        [notificationUrl('remote:server-a:rt-main')]: { callActive: true },
        [notificationUrl('remote:server-a:rt-coder')]: { callActive: false },
      },
    });
    await harness.refreshCatalog();

    // 空 local agents：仅剩远程条目时也必须走完整轮询（提前 return 分支
    // 必须在合并远程集合之后判断）
    await harness.refreshCallStates([]);

    assert.equal(harness.agentCallActive.get('remote:server-a:rt-main'), true);
    assert.equal(harness.fetchedUrls.includes(notificationUrl('remote:server-a:rt-main')), true);
    // 真实 isRuntimeCalling 按原始字符串 key 命中，不做 normalize
    assert.equal(harness.ctx.run('isRuntimeCalling("remote:server-a:rt-main")'), true);
    assert.equal(harness.ctx.run('isRuntimeCalling("remote:server-a:rt-coder")'), false);
  });

  it('cleanup keeps online remote keys while the runtime is still calling', async () => {
    const harness = createCallStateSandbox({
      catalogResponses: [connectedCatalog()],
      notifications: {
        [notificationUrl('remote:server-a:rt-main')]: { callActive: true },
      },
    });
    await harness.refreshCatalog();

    // 模拟聚焦会话 pre-warm / chat 轮询先写入的 key
    harness.agentCallActive.set('remote:server-a:rt-main', true);
    await harness.refreshCallStates([]);

    // 清理循环不得把在线远程 key 当孤儿删掉（发送按钮横跳的根因回归）
    assert.equal(harness.agentCallActive.get('remote:server-a:rt-main'), true);
    assert.equal(harness.ctx.run('isRuntimeCalling("remote:server-a:rt-main")'), true);
  });

  it('cleanup still purges keys of remote entries that are no longer online', async () => {
    const harness = createCallStateSandbox({
      catalogResponses: [connectedCatalog(), disconnectedCatalog()],
      notifications: {
        [notificationUrl('local-rt')]: { callActive: false },
      },
      agents: [{ id: 'host', runtimeId: 'local-rt', connected: true }],
    });
    await harness.refreshCatalog();

    // 连接断开前的残留 calling 状态
    harness.agentCallActive.set('remote:server-a:rt-main', true);
    await harness.refreshCatalog();
    await harness.refreshCallStates();

    assert.equal(harness.agentCallActive.has('remote:server-a:rt-main'), false);
    assert.equal(harness.ctx.run('isRuntimeCalling("remote:server-a:rt-main")'), false);
  });

  it('render signature changes when a remote entry starts or stops calling', async () => {
    const harness = createCallStateSandbox({
      catalogResponses: [connectedCatalog()],
    });
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
