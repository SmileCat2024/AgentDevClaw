/**
 * p2-input-action-tail.test.js — 输入面动作域（input-actions）收尾契约。
 *
 * 覆盖 frontend-input-convergence / frontend-rollback-* 之外的尾段语义：
 *   1. `autoResize` 桥键：classic 裸调与模块导出同一实现；classic 侧整体替换后
 *      裸调命中替换实现（原顶层 function 声明的语义）。
 *   2. `newIdempotencyKey` **不注册桥键**：同名 classic 顶层函数声明（app-main）
 *      在 window 上是不可配置属性，再 defineKey 会抛错；模块只导出函数值。
 *   3. 提交失败语义：HTTP 非 ok → 失败 toast 且**不做**乐观清空、不触发 poll；
 *      网络异常 → 失败 toast + 既有 console.error 文案。
 *   4. 迟到提交（A→B→A）：token 代次已推进，成功响应不得清掉新会话的 lease。
 *
 * 加载路线：`withP2EsmCase` 真实 import + 真实 classic 会话视图（token / patch
 * 语义不走测试开关）。桥键按生产协议在 classic 相注册（app-core / i18n 的角色）。
 * 通知与轮询走真实 ESM 依赖：ClawToast 改观察 toast-notify 模块对象的方法调用，
 * poll 经 poll-coordinator-host 的宿主 run 计数——两者都不再经 window 桩。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareEsmModules, SESSION_VIEW_DOMAIN } from './p2-classic-hosts.js';

const INPUT_ACTIONS = 'public/src/modules/input-actions.js';

const BRIDGE_PRELUDE = `
  window.KernelState.defineKey('session-view-storage', 'currentMessages', []);
  window.KernelState.defineKey('session-view-storage', 'currentInputRequests', []);
  window.KernelState.defineKey('session-view-storage', 'toolRenderConfigs', {});
  window.KernelState.defineKey('session-view-storage', 'TOOL_NAMES', {});
  window.KernelState.defineKey('session-view-storage', 'currentHookInspector', {});
  window.KernelState.defineKey('session-view-storage', 'currentHookInspectorSignature', '');
  window.KernelState.defineKey('session-view-storage', 'currentOverviewSnapshot', {});
  window.KernelState.defineKey('session-view-storage', 'currentOverviewSignature', '');
  window.KernelState.defineKey('session-view-storage', 'currentTodoPlan', {});
  window.KernelState.defineKey('session-view-storage', 'currentTodoPlanSignature', '');
  window.KernelState.defineKey('orchestration', 'currentRuntimeAgentId', null);
  window.KernelState.defineKey('orchestration', '_switchEpoch', 0);
  window.KernelState.defineKey('i18n-environment', 'currentLanguage', 'zh');
  currentRuntimeConnected = true;
`;

function createHarness({ response } = {}) {
  const state = {
    toasts: [],
    polls: 0,
    requests: [],
    follow: 0,
    rowListQueries: 0,
    response: response || (async () => ({ ok: true, status: 200, json: async () => ({}) })),
  };
  const container = {
    querySelectorAll(selector) {
      state.rowListQueries += 1;
      assert.equal(selector, '.message-row', 'tail 扫描只读行列表');
      return [];
    },
  };
  const options = {
    classic: (sandbox) => {
      sandbox.run(BRIDGE_PRELUDE);
      prepareEsmModules(sandbox, SESSION_VIEW_DOMAIN);
    },
    globals: {
      createCallInterruptHost: () => ({ pending: new Map(), now: () => Date.now() }),
      createP2BootstrapCallActivityHost: () => ({
        _agentCallActive: new Map(),
        _recentlyFinishedRuntimes: new Set(),
        _seenChoiceAlertIds: new Set(),
        _autoTitleTriggered: new Set(),
        _lastInterruptUserActionAt: 0,
      }),
      createP2BootstrapDomHost: () => ({ container }),
      // 真实 poll 模块的宿主 seam（生产由 app-main 提供）：run 记次即可。
      createPollCoordinatorHost: () => ({
        run: () => { state.polls += 1; return Promise.resolve(); },
        fastInterval: () => 2000,
        setTimeout: (callback, delay) => setTimeout(callback, delay),
        clearTimeout: (id) => clearTimeout(id),
      }),
      beginFollowLatestEntryWindow: () => { state.follow += 1; },
      requestFollowLatest: () => {},
      _markAgentCallStartedForNotify: () => {},
      _syncPersistentActionButton: () => {},
      renderAgentList: () => {},
      fetch: async (url, init = {}) => {
        let body = null;
        if (init.body) {
          try { body = JSON.parse(init.body); } catch { body = init.body; }
        }
        state.requests.push({ url: String(url), body });
        return state.response(url, init);
      },
    },
  };
  return { state, options };
}

async function withActions(harness, fn) {
  const { state, options } = harness;
  return withP2EsmCase(options, async (c) => {
    c.window.currentRuntimeAgentId = 'agent-1';
    // toast 已是 ESM 依赖：替换真实 ClawToast 的 show 接口观察通知（同一实例）。
    const toast = await c.load('public/src/modules/toast-notify.js');
    toast.ClawToast.show = (opts) => { state.toasts.push(opts); };
    const actions = await c.load(INPUT_ACTIONS);
    return fn({ c, state, actions });
  });
}

describe('autoResize bridge key', () => {
  it('classic 裸调与模块导出是同一实现，classic 整体替换后生效', async () => {
    await withActions(createHarness(), ({ c, actions }) => {
      assert.equal(typeof actions.autoResize, 'function');
      assert.equal(c.read('typeof autoResize'), 'function', 'classic 裸标识符经桥解析');
      assert.equal(c.read('autoResize === window.autoResize'), true);

      // 真实行为：高度 = min(scrollHeight, 200)
      const el = c.document.createElement('textarea');
      el.scrollHeight = 320;
      actions.autoResize(el);
      assert.equal(el.style.height, '200px', '超过上限时钳到 200px');
      el.scrollHeight = 48;
      actions.autoResize(el);
      assert.equal(el.style.height, '48px');

      // classic 侧整体替换（诊断 / 测试接管的既有语义）：裸调命中替换实现
      c.read('autoResize = (el) => { el.style.height = "taken-over"; }');
      const other = c.document.createElement('textarea');
      other.scrollHeight = 10;
      c.window.autoResize(other);
      assert.equal(other.style.height, 'taken-over', '桥键转发到替换后的实现');
    });
  });
});

describe('newIdempotencyKey stays off the bridge', () => {
  it('模块导出可用的幂等键，但 window 上没有该桥键', async () => {
    await withActions(createHarness(), ({ c, actions }) => {
      assert.equal(typeof actions.newIdempotencyKey, 'function');
      const first = actions.newIdempotencyKey();
      const second = actions.newIdempotencyKey();
      assert.ok(String(first).length > 0);
      assert.notEqual(first, second, '每次调用生成新键');
      // 未注册桥键：同名 classic 顶层函数声明不可配置，defineKey 会抛错；
      // 本模块因此只导出函数值。
      assert.equal(c.read('Object.getOwnPropertyDescriptor(window, "newIdempotencyKey")'),
        undefined, 'newIdempotencyKey 不注册 window 访问器');
    });
  });
});

describe('submitInputAction failure semantics', () => {
  it('HTTP 非 ok：失败 toast、不做乐观清空、不触发 poll', async () => {
    const harness = createHarness({ response: async () => ({ ok: false, status: 409, json: async () => ({}) }) });
    await withActions(harness, async ({ c, state, actions }) => {
      c.read(`applySessionViewPatch({ inputRequests: [{ requestId: 'keep-me' }] })`);
      await actions.submitInputAction('keep-me', 'rollback_to_call', {}, 'agent-1');
      assert.equal(state.requests.length, 1, '请求已发出');
      assert.equal(state.requests[0].body.response.actionId, 'rollback_to_call');
      assert.equal(state.toasts.length, 1, '失败给出一次用户可见反馈');
      assert.equal(state.toasts[0].status, 'error');
      assert.match(state.toasts[0].id, /^input-action-failed-rollback_to_call-/);
      assert.equal(c.read('currentInputRequests[0].requestId'), 'keep-me',
        '失败不得乐观清空输入请求（用户可直接重试）');
      assert.equal(state.polls, 0, '失败不触发 poll');
      assert.equal(state.follow, 0, '失败不开启跟随窗口');
    });
  });

  it('网络异常：失败 toast + 既有 console.error 文案，状态不动', async () => {
    const harness = createHarness({ response: async () => { throw new Error('network down'); } });
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => { errors.push(args.map(String).join(' ')); };
    try {
      await withActions(harness, async ({ c, state, actions }) => {
        c.read(`applySessionViewPatch({ inputRequests: [{ requestId: 'keep-me' }] })`);
        await actions.submitInputAction('keep-me', 'proceed', {}, 'agent-1');
        assert.equal(state.toasts.length, 1);
        assert.equal(state.toasts[0].status, 'error');
        assert.equal(c.read('currentInputRequests[0].requestId'), 'keep-me');
        assert.equal(state.polls, 0);
      });
    } finally {
      console.error = originalError;
    }
    assert.ok(errors.some((line) => line.includes('提交动作失败')), '保留原有失败日志文案');
  });
});

describe('late action receipt after A -> B -> A', () => {
  it('A 的迟到成功回执不得清掉重新进入 A 后的新 lease', async () => {
    let finish;
    const harness = createHarness({
      response: () => new Promise((resolve) => { finish = resolve; }),
    });
    await withActions(harness, async ({ c, state, actions }) => {
      c.read(`applySessionViewPatch({ identity: { agentId: 'agent-1', sessionId: 'A' },
        inputRequests: [{ requestId: 'A-old' }], messages: [] })`);
      const pending = actions.submitInputAction('A-old', 'proceed', {}, 'agent-1');
      // 期间：A → B → A（身份代次推进，旧 token 作废）
      c.read(`applySessionViewPatch({ identity: { agentId: 'agent-1', sessionId: 'B' } })`);
      c.read(`applySessionViewPatch({ identity: { agentId: 'agent-1', sessionId: 'A' } })`);
      c.read(`applySessionViewPatch({ inputRequests: [{ requestId: 'A-new' }] })`);
      finish({ ok: true, status: 200, json: async () => ({}) });
      await pending;
      assert.equal(c.read('currentInputRequests[0].requestId'), 'A-new',
        '旧回执不得清掉重新进入后的新 lease');
      assert.equal(state.follow, 0, '过期回执不触发跟随窗口');
      assert.equal(state.rowListQueries, 0, '过期回执不重扫回退按钮');
    });
  });
});
