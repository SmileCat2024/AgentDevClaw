/**
 * agent-snapshot-loader-host 真实求值（P2 真实 ESM 图路线）。
 *
 * 装载路线：classic 相只跑仍 classic 的唯一实现（app-core 的桥键与身份函数、
 * session-view-state 的 token/patch 机制、sidebar-render 的
 * createAgentSnapshotLoaderHost 宿主工厂）；agent-snapshot-loader-host 及其
 * 依赖（快照合并策略、调用状态对账、数据加载）经 withP2EsmCase + c.load 走
 * 真实 import 整图，每个用例一份独立模块图。
 *
 * 侧栏快照 token 与诊断队列现在都来自真实 owner 模块（agent-loader-host 已
 * 具名 import sidebar-operations）：过期帧由 `markSidebarAuthoritativeMutation()`
 * （公开 owner 入口，权威变更代次 +1）驱动，诊断事件记录器经该域的桥键注入
 * ——生产里 classic sidebar-render 的宿主闭包正是按裸标识符读同一个键。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const AGENT_SNAPSHOT_LOADER_HOST = 'public/src/modules/agent-snapshot-loader-host.js';

test('snapshot ESM host coalesces reads, preserves source identity, rejects stale frames and unlocks after failure', async () => {
  let release;
  let fail = false;
  let calls = 0;
  const scheduled = [];
  const diagnostics = [];
  const errors = [];

  await withP2EsmCase({
    globals: {
      // markdown-utils（真实 ESM 依赖链）装载期注册 data-action 处理器
      ClawFW: { actions: { handlers: {}, registerMany(map) { Object.assign(this.handlers, map); } } },
      performance,
      isRemoteNamespaceAgentId: (id) => String(id).startsWith('remote:'),
      console: { ...console, log() {}, warn() {}, error: (...args) => errors.push(args) },
      fetch: async () => ({ ok: true, json: async () => ({ agents: [{ id: 'rt', name: 'Viewer name', connected: true, messageCount: 4 }] }) }),
    },
    classic: (sandbox) => {
      // 真实先行脚本序（test/p2-classic-hosts.js）：宿主工厂（runtime-switch /
      // poll / workspace-surface / 侧栏 call 状态）都是生产实现，首屏 boot 与周期
      // 排程由基座关掉。时序观察面（本用例钉住 25ms 过期重排程）在其后覆盖：
      // setTimeout 记账、setInterval 关闭。
      prepareClassicSandbox(sandbox);
      sandbox.setInterval = () => 0;
      sandbox.setTimeout = (callback, delay) => { scheduled.push({ callback, delay }); return 0; };
      // 快照 loader 会调用的 classic 能力（生产 owner：IPC 客户端 / 渲染入口 /
      // 面板渲染）：同形桩并记录调用。
      sandbox.invoke = async () => {
        calls++;
        if (fail) throw new Error('offline');
        return new Promise((resolve) => { release = resolve; });
      };
      sandbox.renderAgentList = () => {};
      sandbox.renderFeaturePanel = () => {};
      sandbox.isSseActive = () => true;

    },
  }, async (c) => {
    const host = { id: 'host', source: 'prebuilt', runtime_session_id: 'rt', sidebar_entry_id: 'host', name: 'Authoritative name' };
    c.read("focusedAgentId = 'host';");
    c.window.allAgents = [host];

    const { loadAgents } = await c.load(AGENT_SNAPSHOT_LOADER_HOST);
    const sidebarOperations = await c.load('public/src/modules/sidebar-operations.js');
    // 诊断事件记录器：注入该域桥键（classic sidebar-render 的宿主席位读它）
    const realDiagnostic = c.window.queueSidebarDiagnosticEvent;
    c.window.queueSidebarDiagnosticEvent = (event) => diagnostics.push(event);
    const first = loadAgents();
    const second = loadAgents();
    assert.equal(calls, 1);
    release([host]);
    await Promise.all([first, second]);
    assert.equal(c.window.allAgents[0].name, 'Authoritative name', 'Viewer data must not overwrite identity');
    assert.equal(c.window.allAgents[0].message_count, 4);
    assert.equal(c.window.loadAgentsInFlight, null);
    assert.deepEqual(errors, [], 'a successful refresh must finish its downstream call-state reconciliation');
    const confirmed = c.window.allAgents;
    const stale = loadAgents();
    // 读取在飞期间发生权威变更（真实 owner 的公开代次入口）→ 已捕获的快照
    // token 过期，落地结果被丢弃。
    sidebarOperations.markSidebarAuthoritativeMutation();
    release([{ id: 'obsolete', source: 'prebuilt' }]);
    assert.deepEqual(await stale, { stale: true });
    assert.strictEqual(c.window.allAgents, confirmed);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delay, 25);
    fail = true;
    await loadAgents();
    assert.equal(errors.length, 1, 'a rejected request keeps the original failure observable');
    assert.strictEqual(c.window.allAgents, confirmed);
    assert.equal(c.window.loadAgentsInFlight, null);
    fail = false;
    const empty = loadAgents();
    release([]);
    await empty;
    assert.equal(c.window.allAgents[0].source, 'prebuilt');
    assert.equal(c.window.allAgents[0].sidebar_entry_id, 'host');
    assert.equal(diagnostics[0].phase, 'empty-connected-preserved-identity');
    assert.equal(calls, 4, 'failure must leave a later read eligible to run');
    assert.equal(c.timerCount(), 0, '用例结束不应残留计时器');
    c.window.queueSidebarDiagnosticEvent = realDiagnostic;
  });
});
