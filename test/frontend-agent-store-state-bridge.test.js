import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

const DOMAIN = 'agent-store';
const MODULE = 'public/src/modules/agent-store-state.js';
const INITIAL = {
  allAgents: [],
  focusedAgentId: null,
  readOnlyMode: false,
  loadAgentsInFlight: null,
  lastAgentListRefreshAt: 0,
  lastCallStateRefreshAt: 0,
  expandedProjectIds: new Set(),
};

async function setup() {
  const cleanup = installBrowserStubs();
  await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
  for (const [key, value] of Object.entries(INITIAL)) window.KernelState.defineKey(DOMAIN, key, value);
  return { cleanup };
}

function cleanupKeys() {
  for (const key of Object.keys(INITIAL)) delete window[key];
  delete window.KernelState;
}

test('agent-store claim absorbs early bridge values without copying list or Set references', async () => {
  const { cleanup } = await setup();
  try {
    const agents = [{ id: 'early-agent' }];
    const expanded = new Set(['project-early']);
    window.allAgents = agents;
    window.expandedProjectIds = expanded;
    window.focusedAgentId = 'early-agent';

    const { module } = await loadModuleOnce(MODULE, { installGlobals: false });
    assert.strictEqual(module.allAgents, agents);
    assert.strictEqual(module.expandedProjectIds, expanded);
    assert.equal(module.focusedAgentId, 'early-agent');
  } finally {
    cleanupKeys();
    cleanup();
  }
});

test('agent-store bridge preserves classic writes, ESM setters, live bindings and object handles', async () => {
  const { cleanup } = await setup();
  try {
    const { module } = await loadModuleOnce(MODULE, { installGlobals: false });
    const replacement = [{ id: 'classic-agent' }];
    window.allAgents = replacement;
    assert.strictEqual(module.allAgents, replacement);

    const promise = Promise.resolve('in-flight');
    window.loadAgentsInFlight = promise;
    assert.strictEqual(module.loadAgentsInFlight, promise);

    const expanded = new Set(['p1']);
    module.setExpandedProjectIds(expanded);
    assert.strictEqual(window.expandedProjectIds, expanded);
    assert.strictEqual(module.expandedProjectIds, expanded);

    module.setLastAgentListRefreshAt(123);
    assert.equal(window.lastAgentListRefreshAt, 123);
    window.readOnlyMode = true;
    assert.equal(module.readOnlyMode, true);
    window.focusedAgentId = 'focus-2';
    assert.equal(module.focusedAgentId, 'focus-2');
  } finally {
    cleanupKeys();
    cleanup();
  }
});

// 放在最后：本用例按生产路径 import 真实装载器宿主（无 query，与图内其它模块同一实例），
// 因此会把 agent-store owner 绑到本用例的 window 上；前面的状态/桥用例各自用隔离
// 实例，顺序调换会让它们的「早期桥值被 claim 吸收」断言读到前一个世界。
test('real loadAgents reuses an in-flight request across owner claim and releases it after failure', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const ctx = createFrontendSandbox({
    performance,
    console: { ...console, error() {}, warn() {} },
  });
  ctx.loadSource('public/src/modules/action-dispatcher.js');
  ctx.loadSource('public/src/app-core.js');
  // classic 侧的宿主工厂（生产由 app-main / app-ui / session-view-state 提供）：
  // 侧栏装载链在求值期取用，本文件不驱动轮询与工作区表面。
  ctx.loadSource('public/src/modules/session-view-state.js');
  // runtime-status 的 200ms 通知时钟在模块求值时启动（与 classic 加载期同义）：
  // 本用例不验它，关掉周期排程免得进程留句柄。
  ctx.setInterval = () => 0;
  ctx.clearInterval = () => {};
  ctx.createPollCoordinatorHost = () => ({
    run: async () => {}, fastInterval: () => 1000, setTimeout: () => 0, clearTimeout: () => {},
  });
  ctx.createWorkspaceSurfaceHost = () => ({ state: {} });
  ctx.createRuntimeSwitchHost = () => ({ state: {} });
  ctx.createCompactResumeHost = () => ({ state: {}, now: () => Date.now() });
  ctx.createAgentCallStatesHost = () => ({ state: {} });
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = ctx;
  // 装载器宿主的 viewer 快照走裸 fetch（模块在宿主 realm 求值）：给确定性响应，
  // 不让真实网络参与本用例。
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ agents: [] }) });
  try {
    // 侧栏装载链自 P4 T2 起是 ESM（sidebar-render → 装载器宿主）：真实 import
    // 路线。宿主面一律在调用时点晚绑定 `window.X`，因此 `ctx.invoke` 替身可以在
    // 装载之后写入同一 window。
    // 只从装载器宿主入口进图：它静态 import sidebar-render，后者的桥键在整图里
    // 只注册一次（两次独立 import 会得到两个入口实例 → 桥键重复注册）。
    // 无 query 的真实图入口：本文件只在这一处装载它，且图内其它模块（session-ui）
    // 也按无 query 路径 import 同一文件——加 query 会让它求出第二份实例并撞桥键。
    await import(new URL('../public/src/modules/agent-snapshot-loader-host.js', import.meta.url).href);
    ctx.invoke = async () => { calls += 1; await pending; throw new Error('controlled read failure'); };
    const first = ctx.run('loadAgents()');
    const second = ctx.run('loadAgents()');
    assert.equal(calls, 1, 'concurrent reads must share the existing request');
    // 在读的是同一个 owner（agent-store 桥键），不是第二份模块实例
    assert.ok(ctx.run('loadAgentsInFlight'), '在飞请求登记在 agent-store owner 上');
    release();
    await Promise.all([first, second]);
    assert.equal(ctx.run('loadAgentsInFlight'), null, 'a failed read must release the mutex');
    await ctx.run('loadAgents()');
    assert.equal(calls, 2, 'a later request must not remain stuck behind the settled promise');
  } finally {
    release();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }
});
