/**
 * frontend-foreground-sync-owner.test.js — 前台同步引擎的 owner 契约。
 *
 * app-main 的 visibilitychange 处理器在两处裸调同步链路：
 *   - `refreshAgentCallStates(allAgents, ...)`：唯一实现在 classic（app-main 尾部
 *     IIFE 组合的引擎，本批搬回）；ESM 侧只有 late-bound 薄适配器。
 *   - `refreshCurrentRuntimeStatus(currentRuntimeAgentId)`：仍 ESM-only，靠
 *     `currentRuntimeAgentId` 在模块相之前恒 null 不被求值。
 *
 * 本文件用真实 classic 链（test/p2-classic-hosts.js）钉住这条契约，而不是
 * 复制一份 factory 或对源码切片：
 *   1. 监听器注册时引擎已在位（注册顺序契约）；
 *   2. 容器/锁/默认读取是同一份引用（无双存储）；
 *   3. 模块相之前派发真实 visibilitychange：call 状态链路跑完整并发出真实请求，
 *      runtime 状态链路因 null 不变量不被求值（`refreshCurrentRuntimeStatus`
 *      在 classic 相是 undefined）；
 *   4. 适配器缺 owner 时响亮失败，不静默跳过。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';
import { loadModuleOnce } from './helpers/esm-module-loader.js';

function createForegroundSandbox() {
  const listeners = [];
  const fetched = [];
  let registrationSnapshot = null;
  const sandbox = createFrontendSandbox({
    setInterval: () => 0,
    fetch: async (url) => {
      fetched.push(String(url));
      return { ok: true, status: 200, json: async () => ({ callActive: false }) };
    },
  });
  // 沙箱 document 的 addEventListener 是桩：这里包装它，记录 visibilitychange
  // 处理器与「注册瞬间」的引擎可用性（顺序契约）。
  const doc = sandbox.document;
  const originalAdd = doc.addEventListener;
  doc.addEventListener = function (type, handler) {
    if (type === 'visibilitychange') {
      if (!registrationSnapshot) {
        registrationSnapshot = {
          accessor: typeof sandbox.refreshAgentCallStates,
          ownerIdentity: sandbox.refreshAgentCallStates === sandbox.ClawFW?.CallStates?.refreshAgentCallStates,
          status: typeof sandbox.refreshCurrentRuntimeStatus,
        };
      }
      listeners.push(handler);
    }
    return originalAdd.call(this, type, handler);
  };
  prepareClassicSandbox(sandbox);
  // 下游 UI sink（生产由 sidebar layout 模块提供 `window.ClawSidebarLayout`）：
  // 本文件验的是同步引擎与它的状态副作用，不渲染侧栏 DOM。
  const renders = [];
  sandbox.renderAgentList = () => renders.push(1);
  return { sandbox, listeners, fetched, renders, getRegistrationSnapshot: () => registrationSnapshot };
}

describe('foreground visibilitychange: classic sync owner contract', () => {
  it('registers the listener only after the call-state engine is available', () => {
    const env = createForegroundSandbox();
    const snapshot = env.getRegistrationSnapshot();
    assert.ok(snapshot, 'app-main 必须注册 visibilitychange 监听器');
    assert.equal(snapshot.accessor, 'function', '监听器注册时 refreshAgentCallStates 必须已可用');
    assert.equal(snapshot.ownerIdentity, true, 'classic 访问器与 ESM 适配器指向同一实现');
    assert.equal(snapshot.status, 'undefined', 'refreshCurrentRuntimeStatus 在 classic 相不存在（null 不变量的前提）');
  });

  it('shares one container set / engine lock with the classic host factory', () => {
    const { sandbox } = createForegroundSandbox();
    assert.equal(sandbox.run('createAgentCallStatesHost().calling === _agentCallActive'), true);
    assert.equal(sandbox.run('createAgentCallStatesHost().suspended === _agentSuspended'), true);
    assert.equal(sandbox.run('createAgentCallStatesHost().interrupting === _interruptSuppression'), true);
    assert.equal(sandbox.run('createAgentCallStatesHost().finished === _recentlyFinishedRuntimes'), true);
    assert.equal(sandbox.run('createAgentCallStatesHost().agents() === allAgents'), true);
    assert.equal(sandbox.run('window.createCallInterruptHost().pending === _interruptSuppression'), true,
      'call-interrupt owner 与 classic 容器是同一 Map');
    // KernelState 桥键是访问器（唯一注册制的产物），不是裸值属性。
    assert.equal(Object.getOwnPropertyDescriptor(sandbox, 'refreshAgentCallStates')?.get !== undefined, true);
    assert.equal(Object.getOwnPropertyDescriptor(sandbox, 'markInterruptPending')?.get !== undefined, true);
  });

  it('runs the call-state chain on a real foreground event before modules evaluate', async () => {
    const env = createForegroundSandbox();
    env.sandbox.run(`
      allAgents = [{ id: 'rt-seed', connected: true, runtime_session_id: 'rt-seed', source: 'external' }];
      _agentCallActive.set('rt-seed', true);
    `);
    for (const handler of env.listeners) handler();
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(env.fetched.includes('/api/agents/rt-seed/notification'),
      `前台事件必须发出真实 notification 请求（实际 ${JSON.stringify(env.fetched)}）`);
    assert.equal(env.sandbox.run('allAgents.find((agent) => agent.id === "rt-seed").callActive'), false,
      '通知结果回收进 agent 记录');
    assert.deepEqual(env.sandbox.run('Array.from(_agentCallActive.keys())'), [],
      '共享容器被同一引擎清理');
    // runtime 状态链路：处理器里的 `if (currentRuntimeAgentId)` 在模块相之前
    // 恒为 null，因此 ESM-only 的 refreshCurrentRuntimeStatus 不被求值。
    assert.equal(env.sandbox.run('currentRuntimeAgentId'), null);
    assert.equal(env.sandbox.run('typeof refreshCurrentRuntimeStatus'), 'undefined');
    assert.equal(env.fetched.some((url) => url.endsWith('/connection')), false,
      'call 状态对账不得触达 runtime 状态链路');
  });

  it('ESM adapters and the classic bridge keys share one engine: same window, same Map, same lock', async () => {
    const env = createForegroundSandbox();
    const previous = globalThis.window;
    globalThis.window = env.sandbox;
    try {
      const [{ module: callStates }, { module: interrupt }] = await Promise.all([
        loadModuleOnce('public/src/modules/agent-call-states-host.js', { installGlobals: false }),
        loadModuleOnce('public/src/modules/call-interrupt-host.js', { installGlobals: false }),
      ]);
      // 同一 window：classic 桥键与 ESM 适配器读到的是同一个函数对象。
      assert.equal(env.sandbox.refreshAgentCallStates, env.sandbox.ClawFW.CallStates.refreshAgentCallStates);

      // 共享锁：classic 访问器与 ESM 适配器并发只发一次请求。
      env.sandbox.run(`
        allAgents = [{ id: 'rt-shared', connected: true, runtime_session_id: 'rt-shared', source: 'external' }];
      `);
      await Promise.all([
        env.sandbox.refreshAgentCallStates(env.sandbox.allAgents, { force: true }),
        callStates.refreshAgentCallStates(env.sandbox.allAgents, { force: true }),
      ]);
      assert.equal(env.fetched.filter((url) => url === '/api/agents/rt-shared/notification').length, 1,
        'classic 访问器与 ESM 适配器共享同一个 in-flight 锁');

      // 共享 Map：ESM 适配器写入的抑制状态，classic 访问器立即看见；反之亦然。
      interrupt.markInterruptPending('rt-shared', 500);
      assert.equal(env.sandbox.isInterruptSuppressed('rt-shared', 500), true,
        'ESM 写入的 interrupt 状态落在 classic 容器的同一 Map');
      assert.equal(env.sandbox.run("_interruptSuppression.has('rt-shared')"), true,
        '容器就是 classic 顶层 const Map');
      env.sandbox.markInterruptPending('rt-shared-2', 600);
      assert.equal(interrupt.isInterruptSuppressed('rt-shared-2', 600), true,
        'classic 写入经适配器同样可见');
      assert.equal(env.sandbox['clearInterruptSuppression']('rt-shared'), undefined);
      assert.equal(interrupt.isInterruptSuppressed('rt-shared', 500), false);
    } finally {
      globalThis.window = previous;
    }
  });

  it('adapter fails loudly when the classic owner is absent (no silent skip)', async () => {
    const bare = createFrontendSandbox();
    const previous = globalThis.window;
    globalThis.window = bare;
    try {
      const { module } = await loadModuleOnce('public/src/modules/agent-call-states-host.js', { installGlobals: false });
      await assert.rejects(
        async () => module.refreshAgentCallStates([], { force: true }),
        /classic sync owner is not initialized/,
      );
    } finally {
      globalThis.window = previous;
    }
  });
});
