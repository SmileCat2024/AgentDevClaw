/**
 * frontend-foreground-sync-owner.test.js — 前台同步链路的所有权契约。
 *
 * 背景（P4 T2 收尾批次改变了引擎相位）：app-main 的 visibilitychange 处理器
 * 仍以裸标识符调用两条同步链路：
 *   - `refreshAgentCallStates(allAgents, ...)`：唯一实例现在是 ESM 模块
 *     `modules/agent-call-states-engine.js`（原 app-main 顶层 IIFE 逐字搬出），
 *     桥键 `agent-call-states` 在模块相注册；解析相（模块图未求值）的
 *     visibilitychange 由处理器的 typeof 守卫跳过——与 `currentRuntimeAgentId`
 *     的 null 不变量同款，模块就绪后的轮询事件补齐这一跳。
 *   - `refreshCurrentRuntimeStatus(currentRuntimeAgentId)`：ESM-only，靠
 *     `currentRuntimeAgentId` 在模块相之前恒 null 不被求值。
 *
 * 本文件用真实 classic 链（test/p2-classic-hosts.js）+ 真实侧栏域 ESM 钉住契约：
 *   1. 监听器在 classic 相注册，引擎桥键在模块相就位（相位事实）；
 *   2. 容器/锁/默认读取是同一份引用（无双存储，含 B4/B5 两处 seam）；
 *   3. 模块相前的 visibilitychange 被守卫跳过，模块相后同一条链跑完整并发真实请求；
 *   4. 适配器缺 owner 时响亮失败，不静默跳过。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

/**
 * 每个用例：真实 classic 先行链（app-main 注册 visibilitychange、app-core 交出
 * 容器）+ 侧栏域模块相（runtime-status / sidebar-render / 引擎）。
 */
function withForegroundCase(fn, { beforeDomain, afterClassic } = {}) {
  const listeners = [];
  const fetched = [];
  let registrationSnapshot = null;
  return withP2EsmCase({
    globals: {
      fetch: async (url) => {
        fetched.push(String(url));
        return { ok: true, status: 200, json: async () => ({ callActive: false }) };
      },
    },
    classic: (sandbox) => {
      sandbox.setInterval = () => 0;
      // 沙箱 document 的 addEventListener 是桩：包装它记录 visibilitychange
      // 处理器与「注册瞬间」的引擎可用性。
      const doc = sandbox.document;
      const originalAdd = doc.addEventListener;
      doc.addEventListener = function (type, handler) {
        if (type === 'visibilitychange') {
          if (!registrationSnapshot) {
            registrationSnapshot = {
              accessor: typeof sandbox.refreshAgentCallStates,
              status: typeof sandbox.refreshCurrentRuntimeStatus,
            };
          }
          listeners.push(handler);
        }
        return originalAdd.call(this, type, handler);
      };
      prepareClassicSandbox(sandbox);
      if (beforeDomain) beforeDomain(sandbox);
      if (afterClassic) afterClassic(sandbox, { listeners });
    },
  }, async (c) => fn({
    sandbox: c.window,
    listeners,
    fetched,
    getRegistrationSnapshot: () => registrationSnapshot,
  }));
}

describe('foreground visibilitychange: sync owner contract (P4 T2 相位)', () => {
  it('registers the listener in classic phase; engine bridge lands in module phase', async () => {
    await withForegroundCase(async (env) => {
      const snapshot = env.getRegistrationSnapshot();
      assert.ok(snapshot, 'app-main 必须注册 visibilitychange 监听器');
      assert.equal(snapshot.accessor, 'undefined',
        '解析相引擎尚未装载（桥键在模块相注册）——处理器因此要守卫');
      assert.equal(snapshot.status, 'undefined', 'refreshCurrentRuntimeStatus 在 classic 相不存在（null 不变量的前提）');
      assert.equal(typeof env.sandbox.refreshAgentCallStates, 'function', '模块相后桥键就位');
      assert.equal(env.sandbox.refreshAgentCallStates, env.sandbox.ClawFW?.CallStates?.refreshAgentCallStates,
        'classic 桥键与 ClawFW.CallStates 协议面是同一实现');
    });
  });

  it('shares one container set / engine lock with the sidebar host factory (B4/B5 seams)', async () => {
    await withForegroundCase(async (env) => {
      const { sandbox } = env;
      const host = sandbox.__esmDomain.sidebarRender.createAgentCallStatesHost();
      assert.equal(host.calling, sandbox.run('_agentCallActive'));
      // B4：`_agentSuspended` 是 runtime-status 的模块私有 Map（具名导出同一引用）。
      assert.equal(host.suspended, sandbox.__esmDomain.runtimeStatus._agentSuspended);
      // B5：`_interruptSuppression` 经 app-core 的 callActivity seam 按引用交出。
      assert.equal(host.interrupting, sandbox.run('_interruptSuppression'));
      assert.equal(host.finished, sandbox.run('_recentlyFinishedRuntimes'));
      assert.equal(host.agents(), sandbox.run('allAgents'));
      assert.equal(sandbox.run('window.createCallInterruptHost().pending === _interruptSuppression'), true,
        'call-interrupt owner 与 classic 容器是同一 Map');
      // KernelState 桥键是访问器（唯一注册制的产物），不是裸值属性。
      assert.equal(Object.getOwnPropertyDescriptor(sandbox, 'refreshAgentCallStates')?.get !== undefined, true);
      assert.equal(Object.getOwnPropertyDescriptor(sandbox, 'markInterruptPending')?.get !== undefined, true);
    });
  });

  it('a foreground event before module phase is skipped; after it the chain runs for real', async () => {
    await withForegroundCase(async (env) => {
      const { sandbox } = env;
      // 解析相派发的真实事件（见下方 afterClassic）：守卫跳过，不发请求。
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(env.fetched, [], '解析相的前台事件不触达 call 状态链（typeof 守卫）');

      sandbox.run(`
        allAgents = [{ id: 'rt-seed', connected: true, runtime_session_id: 'rt-seed', source: 'external' }];
        _agentCallActive.set('rt-seed', true);
      `);
      // 模块相之后：同一条链跑完整并发真实请求。
      for (const handler of env.listeners) handler();
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(env.fetched.includes('/api/agents/rt-seed/notification'),
        `前台事件必须发出真实 notification 请求（实际 ${JSON.stringify(env.fetched)}）`);
      assert.equal(sandbox.run('allAgents.find((agent) => agent.id === "rt-seed").callActive'), false,
        '通知结果回收进 agent 记录');
      assert.deepEqual(sandbox.run('Array.from(_agentCallActive.keys())'), [],
        '共享容器被同一引擎清理');
      // runtime 状态链路：处理器里的 `if (currentRuntimeAgentId)` 在模块相之前
      // 恒为 null，因此 ESM-only 的 refreshCurrentRuntimeStatus 不被求值。
      assert.equal(sandbox.run('currentRuntimeAgentId'), null);
      assert.equal(sandbox.run('typeof refreshCurrentRuntimeStatus'), 'undefined');
      assert.equal(env.fetched.some((url) => url.endsWith('/connection')), false,
        'call 状态对账不得触达 runtime 状态链路');
    }, {
      // 解析相：app-main 刚注册完监听器、模块图尚未求值 → 引擎桥键还不存在。
      afterClassic: (sandbox, { listeners }) => {
        sandbox.run(`
          allAgents = [{ id: 'rt-seed', connected: true, runtime_session_id: 'rt-seed', source: 'external' }];
          _agentCallActive.set('rt-seed', true);
        `);
        for (const handler of listeners) handler();
      },
    });
  });

  it('ESM adapters and the classic bridge keys share one engine: same window, same Map, same lock', async () => {
    await withForegroundCase(async (env) => {
      const { sandbox } = env;
      const callStates = await import('../public/src/modules/agent-call-states-host.js?foreground-owner');
      const interrupt = await import('../public/src/modules/call-interrupt-host.js?foreground-owner');
      // 同一 window：classic 桥键与 ESM 适配器读到的是同一个函数对象。
      assert.equal(sandbox.refreshAgentCallStates, sandbox.ClawFW.CallStates.refreshAgentCallStates);

      // 共享锁：classic 访问器与 ESM 适配器并发只发一次请求。
      sandbox.run(`
        allAgents = [{ id: 'rt-shared', connected: true, runtime_session_id: 'rt-shared', source: 'external' }];
      `);
      await Promise.all([
        sandbox.refreshAgentCallStates(sandbox.allAgents, { force: true }),
        callStates.refreshAgentCallStates(sandbox.allAgents, { force: true }),
      ]);
      assert.equal(env.fetched.filter((url) => url === '/api/agents/rt-shared/notification').length, 1,
        'classic 访问器与 ESM 适配器共享同一个 in-flight 锁');

      // 共享 Map：ESM 适配器写入的抑制状态，classic 访问器立即看见；反之亦然。
      interrupt.markInterruptPending('rt-shared', 500);
      assert.equal(sandbox.isInterruptSuppressed('rt-shared', 500), true,
        'ESM 写入的 interrupt 状态落在 classic 容器的同一 Map');
      assert.equal(sandbox.run("_interruptSuppression.has('rt-shared')"), true,
        '容器就是 classic 顶层 const Map');
      sandbox.markInterruptPending('rt-shared-2', 600);
      assert.equal(interrupt.isInterruptSuppressed('rt-shared-2', 600), true,
        'classic 写入经适配器同样可见');
      assert.equal(sandbox.clearInterruptSuppression('rt-shared'), undefined);
      assert.equal(interrupt.isInterruptSuppressed('rt-shared', 500), false);
    });
  });

  it('adapter fails loudly when the engine owner is absent (no silent skip)', async () => {
    await withP2EsmCase({ classic: () => {} }, async () => {
      // 只有 window 桩、没有引擎桥键：适配器必须在调用点响亮失败。
      const callStates = await import('../public/src/modules/agent-call-states-host.js?foreground-owner-bare');
      await assert.rejects(
        async () => callStates.refreshAgentCallStates([], { force: true }),
        /classic sync owner is not initialized/,
      );
    });
  });
});
