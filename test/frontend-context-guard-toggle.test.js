/**
 * context-guard-toggle（上边栏超阈值守卫三态 badge）单元测试。
 *
 * 真实 import 路线（P2 ESM 化）：模块经 esm-module-loader 真实动态 import；
 * 已迁 ESM 的状态域（编排的 currentRuntimeAgentId、列表的 focusedAgentId、
 * 会话视图快照的 currentHookInspector、i18n 实时语言）由各自的 owner 模块
 * setter 驱动——模块内是活绑定读，不再经 vm 沙箱全局。toast 同理：操作反馈
 * 走 toast-notify 的具名导出，用例把真实模块对象的 show 换成记录器。
 *
 * 覆盖：状态缓存（applyStatus，poll 链路回填；远程旧版 armed 布尔兼容映射）、
 * badge 三态渲染（renderBadge：off / interrupt / rotate）、循环点击写操作
 * （toggleGuard → POST /protoclaw/context_guard_control {mode} + ClawToast 操作
 * 反馈；allowRotation=false 时两态循环）、挂载探测（isAvailable，inspector 名单）、
 * 以及 ESM 后的 window 命名空间兼容面。
 *
 * 面板侧的旧 guard 区测试（refreshGuardStatus / updateGuardArmed /
 * data-guard-armed）随迁移删除，见 frontend-session-controls-panel.test.js。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

const MODULE_PATH = 'public/src/modules/context-guard-toggle.js';

// 已迁 ESM 的状态域 owner：本文件内是进程级单例（与生产一致——模块只执行一次），
// 每个用例经 setter 重置需要的槽位。
let orchestration;
let agentStore;
let sessionViewStorage;
let i18n;
let toast;
let identity;
let baseCleanup;
const pendingCleanups = [];

before(async () => {
  baseCleanup = installBrowserStubs();
  // 状态模块在装载时 claim 自己的域，需要 classic 桥先就位（生产由
  // app-core 在 classic 相注册、index.html 先加载 kernel-state）。
  await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
  orchestration = await import('../public/src/modules/orchestration-state.js');
  agentStore = await import('../public/src/modules/agent-store-state.js');
  sessionViewStorage = await import('../public/src/modules/session-view-storage.js');
  i18n = await import('../public/src/modules/i18n-environment-state.js');
  toast = await import('../public/src/modules/toast-notify.js');
  // 身份域（P4 T1 从 app-core 抽出）：模块经具名 import 取会话身份，用例改走
  // 生产同一条 viewer 会话绑定，而不是给 window 装同名桩。
  identity = await import('../public/src/modules/identity.js');
});

after(() => {
  while (pendingCleanups.length > 0) pendingCleanups.pop()();
  baseCleanup();
});

const BASE_STATUS = { mode: 'off', strategy: 'adaptive', allowRotation: true, trip: null, thresholdTokens: 160000 };

const INSPECTOR_MOUNTED = {
  lifecycleOrder: [],
  features: [{ name: 'context-guard' }, { name: 'force-continuation' }],
  hooks: [],
};

/**
 * 装本用例的 window 桩（classic 依赖面）+ globalThis.fetch，并加载全新模块实例。
 * @returns {Promise<{ module: object, calls: Array, toasts: Array }>}
 */
async function guardSandbox(overrides = {}) {
  const calls = [];
  const toasts = [];
  const { fetch: fetchOverride, ...windowOverrides } = overrides;
  const cleanupStubs = installBrowserStubs({
    window: { ...windowOverrides },
  });
  // 会话身份：viewer 侧绑定（生产由 switchAgent 建立）
  identity.setViewerSessionBinding('runtime-a', 'session-a');
  // 真实 toast 模块对象：只把 show 换成记录器（本用例不断言 DOM 呈现面）
  const realToastShow = toast.ClawToast.show;
  toast.ClawToast.show = (spec) => { toasts.push(spec); };
  const defaultFetch = async (url, options = {}) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, status: { ...BASE_STATUS } }),
    };
  };
  const hadFetch = Object.hasOwn(globalThis, 'fetch');
  const prevFetch = globalThis.fetch;
  globalThis.fetch = fetchOverride || defaultFetch;
  pendingCleanups.push(() => {
    if (hadFetch) globalThis.fetch = prevFetch; else delete globalThis.fetch;
    toast.ClawToast.show = realToastShow;
    cleanupStubs();
  });

  // 状态域：本用例需要的槽位全部显式赋值（模块内读活绑定）
  orchestration.setCurrentRuntimeAgentId('runtime-a');
  agentStore.setFocusedAgentId('programming-helper');
  i18n.setCurrentLanguage('zh');
  sessionViewStorage.setCurrentHookInspector(
    overrides.currentHookInspector !== undefined ? overrides.currentHookInspector : INSPECTOR_MOUNTED,
  );

  const { module } = await loadModuleOnce(MODULE_PATH, { installGlobals: false });
  return { module, calls, toasts };
}

/** 应答按请求体 mode 确认（模拟 server 转发 runtime 的权威回填）。 */
function acknowledgingFetch(calls, initial = BASE_STATUS) {
  const state = { ...initial };
  return async (url, options = {}) => {
    calls.push({ url, options });
    const body = options.body ? JSON.parse(options.body) : null;
    if (String(url) === '/protoclaw/context_guard_control' && body.mode) {
      state.mode = body.mode;
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, status: { ...state } }) };
  };
}

describe('ContextGuardToggle: mount probe & badge rendering', () => {
  it('reports availability from the inspector feature list', async () => {
    const mounted = await guardSandbox();
    assert.equal(mounted.module.isAvailable(), true);

    const unmounted = await guardSandbox({
      currentHookInspector: { lifecycleOrder: [], features: [{ name: 'force-continuation' }], hooks: [] },
    });
    assert.equal(unmounted.module.isAvailable(), false);
  });

  it('renders no badge before status arrives; after arrival renders the off invite without state classes', async () => {
    const { module } = await guardSandbox();
    assert.equal(module.renderBadge(), '');

    module.applyStatus({ status: BASE_STATUS }, 'runtime-a');
    const html = module.renderBadge();
    assert.match(html, /data-guard-toggle="1"/);
    assert.match(html, /is-off/);
    assert.doesNotMatch(html, /is-interrupt/);
    assert.doesNotMatch(html, /is-rotate/);
    // 图标与文字三态同构（中文文案全 4 字，宽度恒定防布局跳动），无原生 title
    assert.match(html, /M12 8v4/);
    assert.match(html, /ccb-guard-text/);
    assert.match(html, /开启打断/);
    assert.doesNotMatch(html, /title=/);
  });

  it('renders the interrupt state with the amber class and the text label', async () => {
    const { module } = await guardSandbox();
    module.applyStatus({ status: { ...BASE_STATUS, mode: 'interrupt' } }, 'runtime-a');
    const html = module.renderBadge();
    assert.match(html, /is-interrupt/);
    assert.doesNotMatch(html, /is-rotate/);
    assert.match(html, /M12 8v4/);
    assert.match(html, /自动打断/);
    assert.match(html, /aria-label="[^"]*点击切换为自动接续/);
  });

  it('renders the rotate state with the blue class, the rotate-cw glyph and the relay label', async () => {
    const { module } = await guardSandbox();
    module.applyStatus({ status: { ...BASE_STATUS, mode: 'rotate' } }, 'runtime-a');
    const html = module.renderBadge();
    assert.match(html, /is-rotate/);
    // rotate 态用循环标志（Lucide rotate-cw），不再是盾牌的感叹号细节
    assert.match(html, /M21 12a9 9 0 1 1-9-9c2\.52 0 4\.93 1 6\.74 2\.74L21 8/);
    assert.doesNotMatch(html, /M12 8v4/);
    assert.match(html, /自动接续/);
    assert.match(html, /aria-label="[^"]*点击关闭守卫/);
  });

  it('maps a legacy remote payload (armed boolean only) onto the two-state baseline', async () => {
    const { module } = await guardSandbox();
    module.applyStatus({ status: { armed: true, trip: null, thresholdTokens: 160000 } }, 'runtime-a');
    assert.match(module.renderBadge(), /is-interrupt/);
    assert.equal(module.getDetail().allowRotation, false);
  });

  it('renders the badge outside the popup trigger region', async () => {
    const { module } = await guardSandbox();
    module.applyStatus({ status: BASE_STATUS }, 'runtime-a');
    const html = module.renderBadge();
    // 弹窗触发区是白名单（chat-context-bar 按 data-ccb-trigger 判定）：
    // badge 不携带触发标记，hover 它不会弹详情
    assert.ok(html.includes('data-guard-toggle="1"'), 'toggle button rendered');
    assert.ok(!html.includes('data-ccb-trigger'), 'badge carries no popup trigger marker');
  });

  it('re-renders the context bar only when mode, strategy or threshold actually changes', async () => {
    const renders = [];
    const { module } = await guardSandbox({ updateChatContextBar: () => renders.push(Date.now()) });

    module.applyStatus({ status: { ...BASE_STATUS, mode: 'interrupt' } }, 'runtime-a');
    assert.equal(renders.length, 1); // 首次到位触发渲染
    module.applyStatus({ status: { ...BASE_STATUS, mode: 'interrupt', trip: { at: 1750000000000, thresholdTokens: 160000, inputTokens: 165000, reason: 'Context threshold reached.', mode: 'interrupt' } } }, 'runtime-a');
    assert.equal(renders.length, 1); // trip 更新但 mode/阈值未变：不重绘
    module.applyStatus({ status: { ...BASE_STATUS, mode: 'off' } }, 'runtime-a');
    assert.equal(renders.length, 2); // mode 变化：立即重绘
  });

  it('exposes popup detail with mode, strategy, allowRotation, threshold and the last trip', async () => {
    const { module } = await guardSandbox();
    module.applyStatus({ status: { ...BASE_STATUS, mode: 'rotate', strategy: 'trim', trip: { at: 1750000000000, thresholdTokens: 8000, inputTokens: 8300, reason: 'Context threshold reached.', mode: 'rotate' }, thresholdTokens: 8000 } }, 'runtime-a');
    const detail = module.getDetail();
    assert.equal(detail.mode, 'rotate');
    assert.equal(detail.strategy, 'trim');
    assert.equal(detail.allowRotation, true);
    assert.equal(detail.thresholdTokens, 8000);
    assert.equal(detail.trip.inputTokens, 8300);
    assert.equal(detail.trip.mode, 'rotate');
  });

  it('keeps the status cache per runtime (a poll backfill for another runtime cannot flip the badge)', async () => {
    const { module } = await guardSandbox();
    module.applyStatus({ status: { ...BASE_STATUS, mode: 'interrupt' } }, 'runtime-a');
    module.applyStatus({ status: { ...BASE_STATUS, mode: 'rotate' } }, 'runtime-b');
    assert.match(module.renderBadge(), /is-interrupt/);
    assert.equal(module.getDetail().mode, 'interrupt');
  });
});

describe('ContextGuardToggle: three-state cycling with toast feedback', () => {
  it('cycles off → interrupt with the acknowledged state stored and a success toast', async () => {
    const calls = [];
    const { module, toasts } = await guardSandbox({ fetch: acknowledgingFetch(calls) });

    await module.toggleGuard();

    const call = calls.find((c) => c.url === '/protoclaw/context_guard_control');
    assert.ok(call, 'control request was posted');
    // 幂等键由模块本地私有副本生成（randomUUID 或无 crypto 时的 key- 前缀
    // 随机串），不经 window（wg-threads-panel 改按需装载后 window 无稳定供给）
    assert.match(call.options.headers['x-idempotency-key'],
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^key-/);
    assert.deepEqual(JSON.parse(call.options.body), {
      agentId: 'programming-helper',
      sessionId: 'session-a',
      mode: 'interrupt',
    });
    assert.match(module.renderBadge(), /is-interrupt/);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].status, 'success');
    assert.match(toasts[0].title, /已开启超阈值自动打断/);
    assert.equal(toasts[0].description, '阈值 ≈ 160.0K tokens');
  });

  it('cycles interrupt → rotate with a rotation toast naming the strategy behavior', async () => {
    const calls = [];
    const initial = { ...BASE_STATUS, mode: 'interrupt' };
    const { module, toasts } = await guardSandbox({ fetch: acknowledgingFetch(calls, initial) });
    module.applyStatus({ status: initial }, 'runtime-a');

    await module.toggleGuard();

    const call = calls.find((c) => c.url === '/protoclaw/context_guard_control');
    assert.equal(JSON.parse(call.options.body).mode, 'rotate');
    assert.match(module.renderBadge(), /is-rotate/);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].status, 'success');
    assert.match(toasts[0].title, /已开启超阈值自动接续/);
    assert.match(toasts[0].description, /自动打断并按当前策略接力/);
  });

  it('cycles rotate → off with a warning toast stating the risk', async () => {
    const calls = [];
    const initial = { ...BASE_STATUS, mode: 'rotate' };
    const { module, toasts } = await guardSandbox({ fetch: acknowledgingFetch(calls, initial) });
    module.applyStatus({ status: initial }, 'runtime-a');

    await module.toggleGuard();

    const call = calls.find((c) => c.url === '/protoclaw/context_guard_control');
    assert.equal(JSON.parse(call.options.body).mode, 'off');
    assert.match(module.renderBadge(), /is-off/);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].status, 'warning');
    assert.match(toasts[0].title, /已关闭超阈值守卫/);
    assert.match(toasts[0].description, /大幅增加/);
  });

  it('drops rotate from the cycle when the runtime does not allow rotation', async () => {
    const calls = [];
    const initial = { ...BASE_STATUS, mode: 'interrupt', allowRotation: false };
    const { module } = await guardSandbox({ fetch: acknowledgingFetch(calls, initial) });
    module.applyStatus({ status: initial }, 'runtime-a');

    await module.toggleGuard();

    const call = calls.find((c) => c.url === '/protoclaw/context_guard_control');
    assert.equal(JSON.parse(call.options.body).mode, 'off', 'interrupt → off directly; rotate is never offered');
    assert.match(module.renderBadge(), /is-off/);
  });

  it('keeps the pre-click mode while a write is pending (poll backfill cannot flip it)', async () => {
    let resolveFetch;
    const fetchGate = new Promise((resolve) => { resolveFetch = resolve; });
    const { module } = await guardSandbox({
      fetch: async (url, options = {}) => fetchGate.then(() => {
        const body = options.body ? JSON.parse(options.body) : null;
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, status: { ...BASE_STATUS, mode: body && body.mode ? body.mode : 'off' } }),
        };
      }),
    });
    module.applyStatus({ status: BASE_STATUS }, 'runtime-a');

    const pending = module.toggleGuard();
    // 写应答未落定期间 poll 回填了相反的 mode：乐观态不被翻转
    module.applyStatus({ status: { ...BASE_STATUS, mode: 'rotate' } }, 'runtime-a');
    const html = module.renderBadge();
    assert.match(html, /is-pending/);
    assert.doesNotMatch(html, /is-interrupt/);
    assert.doesNotMatch(html, /is-rotate/, 'poll 回填的相反 mode 不覆盖 pending 期间的乐观态');

    resolveFetch();
    await pending;
    assert.match(module.renderBadge(), /is-interrupt/);
  });

  it('rolls back and toasts an error when the control request fails', async () => {
    const { module, toasts } = await guardSandbox({
      fetch: async () => ({ ok: false, status: 503, json: async () => ({ ok: false, error: 'not mounted' }) }),
    });
    module.applyStatus({ status: BASE_STATUS }, 'runtime-a');

    await module.toggleGuard();

    const html = module.renderBadge();
    assert.doesNotMatch(html, /is-pending/);
    assert.doesNotMatch(html, /is-interrupt/);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].status, 'error');
    assert.match(toasts[0].title, /切换超阈值守卫失败/);
    assert.match(toasts[0].description, /not mounted/);
  });

  it('ignores a toggle while another one is pending', async () => {
    let resolveFetch;
    const gate = new Promise((resolve) => { resolveFetch = resolve; });
    const calls = [];
    const { module } = await guardSandbox({
      fetch: async (url, options = {}) => {
        calls.push({ url, options });
        return gate.then(() => ({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, status: { ...BASE_STATUS, mode: 'interrupt' } }),
        }));
      },
    });

    const first = module.toggleGuard();
    await module.toggleGuard(); // pending 中：no-op
    resolveFetch();
    await first;

    assert.equal(calls.filter((c) => c.url === '/protoclaw/context_guard_control').length, 1);
  });
});

describe('ContextGuardToggle: ESM 兼容面与状态 owner', () => {
  it('keeps window.ContextGuardToggle pointing at the exported namespace', async () => {
    const { module } = await guardSandbox();
    assert.equal(globalThis.window.ContextGuardToggle, module.ContextGuardToggle);
    for (const key of ['isAvailable', 'applyStatus', 'renderBadge', 'toggleGuard', 'getDetail']) {
      assert.equal(globalThis.window.ContextGuardToggle[key], module[key], `${key} 兼容键指向命名导出`);
    }
  });

  it('owns its badge cache per module instance (no cross-instance leakage)', async () => {
    const first = await guardSandbox();
    first.module.applyStatus({ status: { ...BASE_STATUS, mode: 'rotate' } }, 'runtime-a');
    assert.match(first.module.renderBadge(), /is-rotate/);

    const second = await guardSandbox();
    assert.equal(second.module.renderBadge(), '', '新实例没有沿用上一实例的状态缓存');
  });
});
