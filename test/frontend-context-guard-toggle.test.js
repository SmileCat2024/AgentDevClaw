/**
 * context-guard-toggle（上边栏超阈值自动打断 badge）单元测试。
 *
 * 沙箱承载 public/src/modules/context-guard-toggle.js：状态缓存
 * （applyStatus，poll 链路回填）、badge 三态渲染（renderBadge）、
 * 写操作（toggleGuard → POST /protoclaw/context_guard_control + ClawToast
 * 操作反馈）、挂载探测（isAvailable，inspector 名单）。
 *
 * 面板侧的旧 guard 区测试（refreshGuardStatus / updateGuardArmed /
 * data-guard-armed）随迁移删除，见 frontend-session-controls-panel.test.js。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

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
        json: async () => ({ ok: true, status: { armed: false, trip: null, thresholdTokens: 160000 } }),
      };
    },
    ...overrides,
  });
  ctx.window.ClawToast = { show(spec) { toasts.push(spec); } };
  ctx.loadSource('public/src/modules/context-guard-toggle.js');
  return { ctx, calls, toasts };
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

  it('renders no badge before status arrives and after it arrives renders the unarmed invite', () => {
    const { ctx } = guardSandbox();
    assert.equal(ctx.run('window.ContextGuardToggle.renderBadge()'), '');

    ctx.run('window.ContextGuardToggle.applyStatus({ status: { armed: false, trip: null, thresholdTokens: 160000 } }, "runtime-a")');
    const html = ctx.run('window.ContextGuardToggle.renderBadge()');
    assert.match(html, /data-guard-toggle="1"/);
    assert.match(html, /aria-pressed="false"/);
    assert.doesNotMatch(html, /is-armed/);
    // 图标与文字两态同构（off「开启打断」/armed「自动打断」，宽度恒定防
    // 布局跳动），无原生 title
    assert.match(html, /M12 8v4/);
    assert.match(html, /ccb-guard-text/);
    assert.match(html, /开启打断/);
    assert.doesNotMatch(html, /title=/);
  });

  it('renders the armed state with the shield-alert glyph and the text label', () => {
    const { ctx } = guardSandbox();
    ctx.run('window.ContextGuardToggle.applyStatus({ status: { armed: true, trip: null, thresholdTokens: 163840 } }, "runtime-a")');
    const html = ctx.run('window.ContextGuardToggle.renderBadge()');
    assert.match(html, /is-armed/);
    assert.match(html, /aria-pressed="true"/);
    assert.match(html, /M12 8v4/);
    assert.match(html, /ccb-guard-text/);
    assert.match(html, /自动打断/);
    assert.doesNotMatch(html, /title=/);
  });

  it('renders the badge outside the popup trigger region', () => {
    const { ctx } = guardSandbox();
    ctx.run('window.ContextGuardToggle.applyStatus({ status: { armed: false, trip: null, thresholdTokens: 160000 } }, "runtime-a")');
    const html = ctx.run('window.ContextGuardToggle.renderBadge()');
    // 弹窗触发区是白名单（chat-context-bar 按 data-ccb-trigger 判定）：
    // badge 不携带触发标记，hover 它不会弹详情
    assert.ok(html.includes('data-guard-toggle="1"'), 'toggle button rendered');
    assert.ok(!html.includes('data-ccb-trigger'), 'badge carries no popup trigger marker');
  });

  it('re-renders the context bar only when armed or threshold actually changes', () => {
    const renders = [];
    const { ctx } = guardSandbox({ updateChatContextBar: () => renders.push(Date.now()) });

    ctx.run('window.ContextGuardToggle.applyStatus({ status: { armed: true, trip: null, thresholdTokens: 160000 } }, "runtime-a")');
    assert.equal(renders.length, 1); // 首次到位触发渲染
    ctx.run('window.ContextGuardToggle.applyStatus({ status: { armed: true, trip: { at: 1750000000000, thresholdTokens: 160000, inputTokens: 165000 } , thresholdTokens: 160000 } }, "runtime-a")');
    assert.equal(renders.length, 1); // trip 更新但 armed/阈值未变：不重绘
    ctx.run('window.ContextGuardToggle.applyStatus({ status: { armed: false, trip: null, thresholdTokens: 160000 } }, "runtime-a")');
    assert.equal(renders.length, 2); // armed 被消耗：立即回落
  });

  it('exposes popup detail with armed, threshold and the last trip', () => {
    const { ctx } = guardSandbox();
    ctx.run('window.ContextGuardToggle.applyStatus({ status: { armed: false, trip: { at: 1750000000000, thresholdTokens: 8000, inputTokens: 8300, reason: "Context threshold reached." }, thresholdTokens: 8000 } }, "runtime-a")');
    const detail = ctx.run('window.ContextGuardToggle.getDetail()');
    assert.equal(detail.armed, false);
    assert.equal(detail.thresholdTokens, 8000);
    assert.equal(detail.trip.inputTokens, 8300);
    assert.equal(detail.trip.thresholdTokens, 8000);
  });
});

describe('ContextGuardToggle: session-targeted toggle with toast feedback', () => {
  it('arms through context_guard_control, stores the confirmed state and toasts', async () => {
    let armed = false;
    const { ctx, calls, toasts } = guardSandbox({
      fetch: async (url, options = {}) => {
        calls.push({ url, options });
        const body = options.body ? JSON.parse(options.body) : null;
        if (String(url) === '/protoclaw/context_guard_control') armed = body.armed === true;
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, status: { armed, trip: null, thresholdTokens: 160000 } }),
        };
      },
    });

    await ctx.run('window.ContextGuardToggle.toggleGuard()');

    const call = calls.find((c) => c.url === '/protoclaw/context_guard_control');
    assert.ok(call, 'control request was posted');
    assert.equal(call.options.headers['x-idempotency-key'], 'test-idem-key');
    assert.deepEqual(JSON.parse(call.options.body), {
      agentId: 'programming-helper',
      sessionId: 'session-a',
      armed: true,
    });
    assert.match(ctx.run('window.ContextGuardToggle.renderBadge()'), /is-armed/);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].status, 'success');
    assert.match(toasts[0].title, /已开启超阈值自动打断/);
    assert.equal(toasts[0].description, '阈值 ≈ 160.0K tokens');
  });

  it('disarms with a warning toast stating the risk', async () => {
    const { ctx, calls, toasts } = guardSandbox({
      fetch: async (url, options = {}) => {
        calls.push({ url, options });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, status: { armed: false, trip: null, thresholdTokens: 160000 } }),
        };
      },
    });
    ctx.run('window.ContextGuardToggle.applyStatus({ status: { armed: true, trip: null, thresholdTokens: 160000 } }, "runtime-a")');

    await ctx.run('window.ContextGuardToggle.toggleGuard()');

    const call = calls.find((c) => c.url === '/protoclaw/context_guard_control');
    assert.equal(JSON.parse(call.options.body).armed, false);
    assert.doesNotMatch(ctx.run('window.ContextGuardToggle.renderBadge()'), /is-armed/);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].status, 'warning');
    assert.match(toasts[0].title, /已关闭超阈值自动打断/);
    assert.match(toasts[0].description, /不再自动打断/);
    assert.match(toasts[0].description, /大幅增加/);
  });

  it('keeps the pre-click armed state while a write is pending (poll backfill cannot flip it)', async () => {
    let resolveFetch;
    const fetchGate = new Promise((resolve) => { resolveFetch = resolve; });
    const { ctx } = guardSandbox({
      fetch: async (url, options = {}) => fetchGate.then(() => ({
        ok: true,
        status: 200,
        json: async () => {
          const body = options.body ? JSON.parse(options.body) : null;
          return { ok: true, status: { armed: body ? body.armed : false, trip: null, thresholdTokens: 160000 } };
        },
      })),
    });
    ctx.run('window.ContextGuardToggle.applyStatus({ status: { armed: false, trip: null, thresholdTokens: 160000 } }, "runtime-a")');

    const pending = ctx.run('window.ContextGuardToggle.toggleGuard()');
    // 写应答未落定期间 poll 回填了相反的 armed：乐观态不被翻转
    ctx.run('window.ContextGuardToggle.applyStatus({ status: { armed: true, trip: null, thresholdTokens: 160000 } }, "runtime-a")');
    const html = ctx.run('window.ContextGuardToggle.renderBadge()');
    assert.match(html, /is-pending/);
    assert.doesNotMatch(html, /is-armed/);

    resolveFetch();
    await pending;
    assert.match(ctx.run('window.ContextGuardToggle.renderBadge()'), /is-armed/);
  });

  it('rolls back and toasts an error when the control request fails', async () => {
    const { ctx, toasts } = guardSandbox({
      fetch: async () => ({ ok: false, status: 503, json: async () => ({ ok: false, error: 'not mounted' }) }),
    });
    ctx.run('window.ContextGuardToggle.applyStatus({ status: { armed: false, trip: null, thresholdTokens: 160000 } }, "runtime-a")');

    await ctx.run('window.ContextGuardToggle.toggleGuard()');

    const html = ctx.run('window.ContextGuardToggle.renderBadge()');
    assert.doesNotMatch(html, /is-pending/);
    assert.doesNotMatch(html, /is-armed/);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].status, 'error');
    assert.match(toasts[0].title, /切换超阈值自动打断失败/);
    assert.match(toasts[0].description, /not mounted/);
  });

  it('ignores a toggle while another one is pending', async () => {
    let resolveFetch;
    const gate = new Promise((resolve) => { resolveFetch = resolve; });
    const { ctx, calls } = guardSandbox({
      fetch: async (url, options = {}) => {
        calls.push({ url, options });
        return gate.then(() => ({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, status: { armed: true, trip: null, thresholdTokens: 160000 } }),
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
