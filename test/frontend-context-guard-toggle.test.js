/**
 * context-guard-toggle（上边栏超阈值守卫三态 badge）单元测试。
 *
 * 沙箱承载 public/src/modules/context-guard-toggle.js：状态缓存
 * （applyStatus，poll 链路回填；远程旧版 armed 布尔兼容映射）、badge
 * 三态渲染（renderBadge：off / interrupt / rotate）、循环点击写操作
 * （toggleGuard → POST /protoclaw/context_guard_control {mode} +
 * ClawToast 操作反馈；allowRotation=false 时两态循环）、挂载探测
 * （isAvailable，inspector 名单）。
 *
 * 面板侧的旧 guard 区测试（refreshGuardStatus / updateGuardArmed /
 * data-guard-armed）随迁移删除，见 frontend-session-controls-panel.test.js。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

const BASE_STATUS = { mode: 'off', strategy: 'adaptive', allowRotation: true, trip: null, thresholdTokens: 160000 };

function guardSandbox(overrides = {}) {
  const calls = [];
  const toasts = [];
  const ctx = createFrontendSandbox({
    focusedAgentId: 'programming-helper',
    currentRuntimeAgentId: 'runtime-a',
    currentLanguage: 'zh',
    getRuntimeWorkspaceSessionId: () => 'session-a',
    getActiveWorkspaceSessionId: () => 'session-a',
    newIdempotencyKey: () => 'test-idem-key',
    currentHookInspector: {
      lifecycleOrder: [],
      features: [{ name: 'context-guard' }, { name: 'force-continuation' }],
      hooks: [],
    },
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, status: { ...BASE_STATUS } }),
      };
    },
    ...overrides,
  });
  ctx.window.ClawToast = { show(spec) { toasts.push(spec); } };
  ctx.loadSource('public/src/modules/context-guard-toggle.js');
  return { ctx, calls, toasts };
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
  it('reports availability from the inspector feature list', () => {
    const mounted = guardSandbox();
    assert.equal(mounted.ctx.run('window.ContextGuardToggle.isAvailable()'), true);

    const unmounted = guardSandbox({
      currentHookInspector: { lifecycleOrder: [], features: [{ name: 'force-continuation' }], hooks: [] },
    });
    assert.equal(unmounted.ctx.run('window.ContextGuardToggle.isAvailable()'), false);
  });

  it('renders no badge before status arrives; after arrival renders the off invite without state classes', () => {
    const { ctx } = guardSandbox();
    assert.equal(ctx.run('window.ContextGuardToggle.renderBadge()'), '');

    ctx.run(`window.ContextGuardToggle.applyStatus({ status: ${JSON.stringify(BASE_STATUS)} }, "runtime-a")`);
    const html = ctx.run('window.ContextGuardToggle.renderBadge()');
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

  it('renders the interrupt state with the amber class and the text label', () => {
    const { ctx } = guardSandbox();
    ctx.run(`window.ContextGuardToggle.applyStatus({ status: ${JSON.stringify({ ...BASE_STATUS, mode: 'interrupt' })} }, "runtime-a")`);
    const html = ctx.run('window.ContextGuardToggle.renderBadge()');
    assert.match(html, /is-interrupt/);
    assert.doesNotMatch(html, /is-rotate/);
    assert.match(html, /M12 8v4/);
    assert.match(html, /自动打断/);
    assert.match(html, /aria-label="[^"]*点击切换为自动接续/);
  });

  it('renders the rotate state with the blue class, the rotate-cw glyph and the relay label', () => {
    const { ctx } = guardSandbox();
    ctx.run(`window.ContextGuardToggle.applyStatus({ status: ${JSON.stringify({ ...BASE_STATUS, mode: 'rotate' })} }, "runtime-a")`);
    const html = ctx.run('window.ContextGuardToggle.renderBadge()');
    assert.match(html, /is-rotate/);
    // rotate 态用循环标志（Lucide rotate-cw），不再是盾牌的感叹号细节
    assert.match(html, /M21 12a9 9 0 1 1-9-9c2\.52 0 4\.93 1 6\.74 2\.74L21 8/);
    assert.doesNotMatch(html, /M12 8v4/);
    assert.match(html, /自动接续/);
    assert.match(html, /aria-label="[^"]*点击关闭守卫/);
  });

  it('maps a legacy remote payload (armed boolean only) onto the two-state baseline', () => {
    const { ctx } = guardSandbox();
    ctx.run('window.ContextGuardToggle.applyStatus({ status: { armed: true, trip: null, thresholdTokens: 160000 } }, "runtime-a")');
    assert.match(ctx.run('window.ContextGuardToggle.renderBadge()'), /is-interrupt/);
    assert.equal(ctx.run('window.ContextGuardToggle.getDetail()').allowRotation, false);
  });

  it('renders the badge outside the popup trigger region', () => {
    const { ctx } = guardSandbox();
    ctx.run(`window.ContextGuardToggle.applyStatus({ status: ${JSON.stringify(BASE_STATUS)} }, "runtime-a")`);
    const html = ctx.run('window.ContextGuardToggle.renderBadge()');
    // 弹窗触发区是白名单（chat-context-bar 按 data-ccb-trigger 判定）：
    // badge 不携带触发标记，hover 它不会弹详情
    assert.ok(html.includes('data-guard-toggle="1"'), 'toggle button rendered');
    assert.ok(!html.includes('data-ccb-trigger'), 'badge carries no popup trigger marker');
  });

  it('re-renders the context bar only when mode, strategy or threshold actually changes', () => {
    const renders = [];
    const { ctx } = guardSandbox({ updateChatContextBar: () => renders.push(Date.now()) });

    ctx.run(`window.ContextGuardToggle.applyStatus({ status: ${JSON.stringify({ ...BASE_STATUS, mode: 'interrupt' })} }, "runtime-a")`);
    assert.equal(renders.length, 1); // 首次到位触发渲染
    ctx.run(`window.ContextGuardToggle.applyStatus({ status: ${JSON.stringify({ ...BASE_STATUS, mode: 'interrupt', trip: { at: 1750000000000, thresholdTokens: 160000, inputTokens: 165000, reason: 'Context threshold reached.', mode: 'interrupt' } })} }, "runtime-a")`);
    assert.equal(renders.length, 1); // trip 更新但 mode/阈值未变：不重绘
    ctx.run(`window.ContextGuardToggle.applyStatus({ status: ${JSON.stringify({ ...BASE_STATUS, mode: 'off' })} }, "runtime-a")`);
    assert.equal(renders.length, 2); // mode 变化：立即重绘
  });

  it('exposes popup detail with mode, strategy, allowRotation, threshold and the last trip', () => {
    const { ctx } = guardSandbox();
    ctx.run(`window.ContextGuardToggle.applyStatus({ status: ${JSON.stringify({ ...BASE_STATUS, mode: 'rotate', strategy: 'trim', trip: { at: 1750000000000, thresholdTokens: 8000, inputTokens: 8300, reason: 'Context threshold reached.', mode: 'rotate' }, thresholdTokens: 8000 })} }, "runtime-a")`);
    const detail = ctx.run('window.ContextGuardToggle.getDetail()');
    assert.equal(detail.mode, 'rotate');
    assert.equal(detail.strategy, 'trim');
    assert.equal(detail.allowRotation, true);
    assert.equal(detail.thresholdTokens, 8000);
    assert.equal(detail.trip.inputTokens, 8300);
    assert.equal(detail.trip.mode, 'rotate');
  });
});

describe('ContextGuardToggle: three-state cycling with toast feedback', () => {
  it('cycles off → interrupt with the acknowledged state stored and a success toast', async () => {
    const calls = [];
    const { ctx, toasts } = guardSandbox({ fetch: acknowledgingFetch(calls) });

    await ctx.run('window.ContextGuardToggle.toggleGuard()');

    const call = calls.find((c) => c.url === '/protoclaw/context_guard_control');
    assert.ok(call, 'control request was posted');
    assert.equal(call.options.headers['x-idempotency-key'], 'test-idem-key');
    assert.deepEqual(JSON.parse(call.options.body), {
      agentId: 'programming-helper',
      sessionId: 'session-a',
      mode: 'interrupt',
    });
    assert.match(ctx.run('window.ContextGuardToggle.renderBadge()'), /is-interrupt/);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].status, 'success');
    assert.match(toasts[0].title, /已开启超阈值自动打断/);
    assert.equal(toasts[0].description, '阈值 ≈ 160.0K tokens');
  });

  it('cycles interrupt → rotate with a rotation toast naming the strategy behavior', async () => {
    const calls = [];
    const initial = { ...BASE_STATUS, mode: 'interrupt' };
    const { ctx, toasts } = guardSandbox({ fetch: acknowledgingFetch(calls, initial) });
    ctx.run(`window.ContextGuardToggle.applyStatus({ status: ${JSON.stringify(initial)} }, "runtime-a")`);

    await ctx.run('window.ContextGuardToggle.toggleGuard()');

    const call = calls.find((c) => c.url === '/protoclaw/context_guard_control');
    assert.equal(JSON.parse(call.options.body).mode, 'rotate');
    assert.match(ctx.run('window.ContextGuardToggle.renderBadge()'), /is-rotate/);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].status, 'success');
    assert.match(toasts[0].title, /已开启超阈值自动接续/);
    assert.match(toasts[0].description, /自动打断并按当前策略接力/);
  });

  it('cycles rotate → off with a warning toast stating the risk', async () => {
    const calls = [];
    const initial = { ...BASE_STATUS, mode: 'rotate' };
    const { ctx, toasts } = guardSandbox({ fetch: acknowledgingFetch(calls, initial) });
    ctx.run(`window.ContextGuardToggle.applyStatus({ status: ${JSON.stringify(initial)} }, "runtime-a")`);

    await ctx.run('window.ContextGuardToggle.toggleGuard()');

    const call = calls.find((c) => c.url === '/protoclaw/context_guard_control');
    assert.equal(JSON.parse(call.options.body).mode, 'off');
    assert.match(ctx.run('window.ContextGuardToggle.renderBadge()'), /is-off/);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].status, 'warning');
    assert.match(toasts[0].title, /已关闭超阈值守卫/);
    assert.match(toasts[0].description, /大幅增加/);
  });

  it('drops rotate from the cycle when the runtime does not allow rotation', async () => {
    const calls = [];
    const initial = { ...BASE_STATUS, mode: 'interrupt', allowRotation: false };
    const { ctx } = guardSandbox({ fetch: acknowledgingFetch(calls, initial) });
    ctx.run(`window.ContextGuardToggle.applyStatus({ status: ${JSON.stringify(initial)} }, "runtime-a")`);

    await ctx.run('window.ContextGuardToggle.toggleGuard()');

    const call = calls.find((c) => c.url === '/protoclaw/context_guard_control');
    assert.equal(JSON.parse(call.options.body).mode, 'off', 'interrupt → off directly; rotate is never offered');
    assert.match(ctx.run('window.ContextGuardToggle.renderBadge()'), /is-off/);
  });

  it('keeps the pre-click mode while a write is pending (poll backfill cannot flip it)', async () => {
    let resolveFetch;
    const fetchGate = new Promise((resolve) => { resolveFetch = resolve; });
    const { ctx } = guardSandbox({
      fetch: async (url, options = {}) => fetchGate.then(() => {
        const body = options.body ? JSON.parse(options.body) : null;
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, status: { ...BASE_STATUS, mode: body && body.mode ? body.mode : 'off' } }),
        };
      }),
    });
    ctx.run(`window.ContextGuardToggle.applyStatus({ status: ${JSON.stringify(BASE_STATUS)} }, "runtime-a")`);

    const pending = ctx.run('window.ContextGuardToggle.toggleGuard()');
    // 写应答未落定期间 poll 回填了相反的 mode：乐观态不被翻转
    ctx.run(`window.ContextGuardToggle.applyStatus({ status: ${JSON.stringify({ ...BASE_STATUS, mode: 'rotate' })} }, "runtime-a")`);
    const html = ctx.run('window.ContextGuardToggle.renderBadge()');
    assert.match(html, /is-pending/);
    assert.doesNotMatch(html, /is-interrupt/);

    resolveFetch();
    await pending;
    assert.match(ctx.run('window.ContextGuardToggle.renderBadge()'), /is-interrupt/);
  });

  it('rolls back and toasts an error when the control request fails', async () => {
    const { ctx, toasts } = guardSandbox({
      fetch: async () => ({ ok: false, status: 503, json: async () => ({ ok: false, error: 'not mounted' }) }),
    });
    ctx.run(`window.ContextGuardToggle.applyStatus({ status: ${JSON.stringify(BASE_STATUS)} }, "runtime-a")`);

    await ctx.run('window.ContextGuardToggle.toggleGuard()');

    const html = ctx.run('window.ContextGuardToggle.renderBadge()');
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
    const { ctx } = guardSandbox({
      fetch: async (url, options = {}) => {
        calls.push({ url, options });
        return gate.then(() => ({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, status: { ...BASE_STATUS, mode: 'interrupt' } }),
        }));
      },
    });

    const first = ctx.run('window.ContextGuardToggle.toggleGuard()');
    await ctx.run('window.ContextGuardToggle.toggleGuard()'); // pending 中：no-op
    resolveFetch();
    await first;

    assert.equal(calls.filter((c) => c.url === '/protoclaw/context_guard_control').length, 1);
  });
});
