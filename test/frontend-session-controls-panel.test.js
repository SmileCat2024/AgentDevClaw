import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { loadEsmPluginInSandbox } from './helpers/load-esm-plugin.js';

function panelSandbox(overrides = {}) {
  const fetchCalls = [];
  const ctx = createFrontendSandbox({
    focusedAgentId: 'programming-helper',
    currentRuntimeAgentId: 'runtime-a',
    currentLanguage: 'zh',
    URLSearchParams,
    featurePanelBody: { addEventListener() {} },
    activeFeaturePanel: null,
    getRuntimeWorkspaceSessionId: () => 'session-a',
    getActiveWorkspaceSessionId: () => 'session-a',
    renderFeaturePanel() {},
    // 面板的显隐判据是当前会话 runtime 实际挂载的 Feature 名单
    // （inspector 快照）；缺省给全量两件套（context-guard 的开关已迁至
    // 上边栏 badge，见 frontend-context-guard-toggle.test.js）。
    currentHookInspector: {
      lifecycleOrder: [],
      features: [
        { name: 'force-continuation' },
        { name: 'step-rotating-model' },
      ],
      hooks: [],
    },
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          status: {
            enabled: false,
            triggers: { outputTruncation: true, apiErrorRetry: true },
            maxConsecutiveContinuations: 3,
            consecutiveContinuations: 0,
            lastProviderStopReason: 'end_turn',
            lastFinishReason: 'completed',
            lastOutcomeStatus: 'completed',
            lastAction: 'completed',
          },
        }),
      };
    },
    ...overrides,
  });
  ctx.window.setInterval = () => 0;
  ctx.loadSource('public/src/modules/claw-host.js');
  loadEsmPluginInSandbox(ctx, 'public/src/panel-plugins/session-controls.js');
  return { ctx, fetchCalls };
}

describe('SessionControlsPanel', () => {
  it('reads authoritative session status when the panel is opened', async () => {
    const { ctx, fetchCalls } = panelSandbox();

    await ctx.run('window.__pluginModule.refreshStatus({ renderWhenDone: false })');
    const html = ctx.run('window.__pluginModule.render()');

    const urls = fetchCalls.map((c) => c.url);
    assert.ok(urls.some((u) => /^\/protoclaw\/force_continuation_status\?/.test(u)));
    assert.match(urls.find((u) => u.includes('force_continuation_status')), /agentId=programming-helper/);
    assert.match(urls.find((u) => u.includes('force_continuation_status')), /sessionId=session-a/);
    // 无摘要/状态行：启停由开关本身表达，默认状态不渲染任何状态文本
    assert.doesNotMatch(html, /force-continuation-summary/);
    assert.doesNotMatch(html, /force-continuation-status-line/);
    assert.match(html, /API 重试/);
    assert.match(html, /data-force-continuation-trigger="outputTruncation" checked/);
    assert.match(html, /data-force-continuation-trigger="apiErrorRetry" checked/);
    assert.doesNotMatch(html, /data-force-continuation-toggle|frameworkLimitReached|保持任务继续|任务步数/);
  });

  it('posts a session-targeted toggle and renders the runtime-confirmed state', async () => {
    const calls = [];
    const { ctx } = panelSandbox({
      fetch: async (url, options = {}) => {
        calls.push({ url, options });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            status: {
              enabled: true,
              triggers: { outputTruncation: true, apiErrorRetry: true },
              maxConsecutiveContinuations: 3,
              lastAction: 'idle',
            },
          }),
        };
      },
    });

    await ctx.run('window.__pluginModule.updateTrigger("apiErrorRetry", true)');
    const html = ctx.run('window.__pluginModule.render()');

    const fcCall = calls.find((c) => c.url === '/protoclaw/force_continuation_control');
    assert.ok(fcCall);
    assert.deepEqual(JSON.parse(fcCall.options.body), {
      agentId: 'programming-helper',
      sessionId: 'session-a',
      triggers: { apiErrorRetry: true },
    });
    assert.match(html, /data-force-continuation-trigger="apiErrorRetry" checked/);
    assert.match(html, /正文输出达到上限/);
    assert.doesNotMatch(html, /max_tokens（|（length）|（max_tokens）/);
    assert.match(html, /data-force-continuation-trigger="outputTruncation" checked/);
    assert.match(html, /data-force-continuation-limit[^>]*value="3"/);
  });

  it('updates one API retry policy independently and uses the Todo toggle markup', async () => {
    const calls = [];
    const { ctx } = panelSandbox({
      fetch: async (url, options = {}) => {
        calls.push({ url, options });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            status: {
              enabled: true,
              triggers: { outputTruncation: false, apiErrorRetry: true },
            },
          }),
        };
      },
    });

    await ctx.run('window.__pluginModule.updateTrigger("outputTruncation", false)');
    const html = ctx.run('window.__pluginModule.render()');

    const fcCall = calls.find((c) => c.url === '/protoclaw/force_continuation_control');
    assert.deepEqual(JSON.parse(fcCall.options.body), {
      agentId: 'programming-helper',
      sessionId: 'session-a',
      triggers: { outputTruncation: false },
    });
    assert.doesNotMatch(html, /data-force-continuation-toggle|frameworkLimitReached/);
    assert.match(html, /class="tool-toggle-input" data-force-continuation-trigger="apiErrorRetry" checked/);
  });

  it('adjusts the auto-resume cap from the number input and clamps invalid values', async () => {
    const calls = [];
    const { ctx } = panelSandbox({
      fetch: async (url, options = {}) => {
        calls.push({ url, options });
        return {
          ok: true, status: 200,
          json: async () => ({
            ok: true,
            status: {
              enabled: true,
              triggers: { outputTruncation: true, apiErrorRetry: true },
              maxConsecutiveContinuations: 8,
            },
          }),
        };
      },
    });

    await ctx.run('window.__pluginModule.updateLimit(8)');
    let html = ctx.run('window.__pluginModule.render()');
    const fcCall = calls.find((c) => c.url === '/protoclaw/force_continuation_control');
    assert.deepEqual(JSON.parse(fcCall.options.body), {
      agentId: 'programming-helper',
      sessionId: 'session-a',
      maxConsecutiveContinuations: 8,
    });
    assert.match(html, /data-force-continuation-limit[^>]*value="8"/);

    // Out-of-range input is rejected client-side without a request.
    await ctx.run('window.__pluginModule.updateLimit(42)');
    await ctx.run('window.__pluginModule.updateLimit("NaN")');
    assert.equal(calls.filter((c) => c.url === '/protoclaw/force_continuation_control').length, 1);
    html = ctx.run('window.__pluginModule.render()');
    assert.match(html, /data-force-continuation-limit[^>]*value="8"/);
  });

  it('keeps the control unavailable when none of the controlled features is mounted', async () => {
    const { ctx } = panelSandbox({
      focusedAgentId: 'qqbot',
      currentRuntimeAgentId: 'runtime-qqbot',
      currentHookInspector: {
        lifecycleOrder: [],
        features: [{ name: 'im-operator' }, { name: 'qqbot-gateway' }],
        hooks: [],
      },
    });
    const first = ctx.run('window.__pluginModule.render()');
    // 名单里没有受控 feature：先探测确证「确实没挂载」，再下结论
    assert.match(first, /正在读取本会话的控制能力/);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const html = ctx.run('window.__pluginModule.render()');

    // 不可用时返回与 hooks 面板一致的通用空态（无开关控件）
    assert.match(html, /feature-panel-empty/);
    assert.match(html, /此控制在当前工作空间不可用/);
    assert.doesNotMatch(html, /data-force-continuation-toggle/);
    assert.doesNotMatch(html, /data-guard-armed/);
  });

  it('hides the rotation section when the runtime only mounts force-continuation', () => {
    const { ctx } = panelSandbox({
      // coder 会话形态：只有 ForceContinuation，没有 rotation
      currentHookInspector: {
        lifecycleOrder: [],
        features: [{ name: 'force-continuation' }],
        hooks: [],
      },
    });
    const html = ctx.run('window.__pluginModule.render()');

    assert.match(html, /data-force-continuation-trigger="outputTruncation"/);
    // 迁移回归：context-guard 的开关已迁至上边栏 badge，面板不再渲染任何 guard 控件
    assert.doesNotMatch(html, /data-guard-armed/);
    assert.doesNotMatch(html, /data-rotation-enabled/);
    assert.doesNotMatch(html, /手动停止和不可重试错误|API 重试次数受上限约束/);
    assert.doesNotMatch(html, /超阈值打断触发后自动关闭/);
  });

  it('never renders the rotation section even when step-rotating-model is mounted', () => {
    // step-rotating-model 已从编程小助手卸载，面板经 ROTATION_SECTION_DISABLED
    // 显式屏蔽：即使 runtime 挂载名单中重新出现该 feature 也不渲染。
    const { ctx } = panelSandbox({
      currentHookInspector: {
        lifecycleOrder: [],
        features: [
          { name: 'force-continuation' },
          { name: 'step-rotating-model' },
        ],
        hooks: [],
      },
    });
    const html = ctx.run('window.__pluginModule.render()');

    assert.match(html, /data-force-continuation-trigger="outputTruncation"/);
    assert.doesNotMatch(html, /data-rotation-enabled/);
    assert.doesNotMatch(html, /data-rotation-menu/);
    assert.doesNotMatch(html, /模型轮转/);
  });

  it('probes the inspector snapshot once when no capability is known yet', async () => {
    let probeCount = 0;
    const { ctx } = panelSandbox({
      currentHookInspector: { lifecycleOrder: [], features: [], hooks: [] },
      fetch: async (url) => {
        if (String(url).includes('/api/agents/runtime-a/hooks')) {
          probeCount += 1;
          return {
            ok: true,
            status: 200,
            json: async () => ({ lifecycleOrder: [], features: [{ name: 'force-continuation' }], hooks: [] }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, status: { enabled: true, triggers: {} } }),
        };
      },
    });

    const first = ctx.run('window.__pluginModule.render()');
    // 快照未决：先给等待态，不误判为「工作空间不支持」
    assert.match(first, /正在读取本会话的控制能力/);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const html = ctx.run('window.__pluginModule.render()');

    assert.match(html, /data-force-continuation-trigger="outputTruncation"/);
    assert.doesNotMatch(html, /data-guard-armed/);
    assert.equal(probeCount, 1); // 结果按 runtime 缓存，不再重复探测
  });

  it('serves the panel for the agent-studio workspace', async () => {
    const { ctx, fetchCalls } = panelSandbox({
      focusedAgentId: 'agent-studio',
      currentRuntimeAgentId: 'runtime-studio',
    });

    await ctx.run('window.__pluginModule.refreshStatus({ renderWhenDone: false })');
    const html = ctx.run('window.__pluginModule.render()');

    assert.match(fetchCalls[0].url, /agentId=agent-studio/);
    assert.match(html, /data-force-continuation-trigger="outputTruncation"/);
  });
});

describe('SessionControlsPanel output style (stylized-output)', () => {
  function stylePanelSandbox() {
    const invokeCalls = [];
    const statusPayload = {
      ok: true,
      result: {
        styleCount: 2,
        styles: [
          { name: '简洁汇报', description: '短句汇报', signature: 'sig-a' },
          { name: '正式汇报', description: '正式行文', signature: 'sig-b' },
        ],
        activeStyle: '简洁汇报',
        signedForReply: false,
        blockedCount: 0,
        maxSignatureBlocks: 5,
        lastAction: 'idle',
      },
    };
    const ctx = createFrontendSandbox({
      focusedAgentId: 'programming-helper',
      currentRuntimeAgentId: 'runtime-a',
      currentLanguage: 'zh',
      URLSearchParams,
      featurePanelBody: { addEventListener() {} },
      activeFeaturePanel: null,
      getRuntimeWorkspaceSessionId: () => 'session-a',
      getActiveWorkspaceSessionId: () => 'session-a',
      renderFeaturePanel() {},
      currentHookInspector: {
        lifecycleOrder: [],
        features: [{ name: 'stylized-output' }],
        hooks: [],
      },
      fetch: async (url, options = {}) => {
        invokeCalls.push({ url, options });
        return { ok: true, status: 200, json: async () => statusPayload };
      },
    });
    ctx.window.setInterval = () => 0;
    ctx.loadSource('public/src/modules/claw-host.js');
    loadEsmPluginInSandbox(ctx, 'public/src/panel-plugins/session-controls.js');
    return { ctx, invokeCalls };
  }

  it('renders the style trigger from stylized-output.configure status', async () => {
    const { ctx, invokeCalls } = stylePanelSandbox();

    await ctx.run('window.__pluginModule.refreshStyleStatus({ renderWhenDone: false })');
    const html = ctx.run('window.__pluginModule.render()');

    assert.match(html, /session-controls-style-row/);
    assert.match(html, /data-style-menu/);
    assert.match(html, /简洁汇报/);
    assert.match(html, /选择用于回复的表达风格/);
    assert.doesNotMatch(html, /已发现|门禁已启用|门禁未启用|最近动作|风格文件由你放入|风格切换在下一次模型调用前生效|清空选择即关闭签名门禁/);

    const invoke = invokeCalls.find((c) => String(c.url).includes('capability_invoke'));
    assert.ok(invoke, 'capability_invoke was called');
    const body = JSON.parse(invoke.options.body);
    assert.equal(body.ref, 'stylized-output.configure');
    assert.equal(body.agentId, 'programming-helper');
    assert.equal(body.sessionId, 'session-a');
    assert.deepEqual(body.args, {});
  });

  it('switches the active style through capability_invoke', async () => {
    const { ctx, invokeCalls } = stylePanelSandbox();

    await ctx.run('window.__pluginModule.updateStyleSelection("正式汇报")');

    const writes = invokeCalls.filter(
      (c) => String(c.url).includes('capability_invoke') && c.options && c.options.method === 'POST',
    );
    assert.ok(writes.length >= 1, 'a style write was posted');
    const body = JSON.parse(writes[writes.length - 1].options.body);
    assert.equal(body.ref, 'stylized-output.configure');
    assert.deepEqual(body.args, { styleName: '正式汇报' });
  });

  it('clearing the selection posts styleName null', async () => {
    const { ctx, invokeCalls } = stylePanelSandbox();

    await ctx.run('window.__pluginModule.updateStyleSelection("")');

    const writes = invokeCalls.filter(
      (c) => String(c.url).includes('capability_invoke') && c.options && c.options.method === 'POST',
    );
    assert.ok(writes.length >= 1, 'a style write was posted');
    const body = JSON.parse(writes[writes.length - 1].options.body);
    assert.deepEqual(body.args, { styleName: null });
  });
});
describe('SessionControlsPanel: guard rotation strategy selector', () => {
  const GUARD_STATUS = { mode: 'rotate', strategy: 'adaptive', allowRotation: true, trip: null, thresholdTokens: 160000 };

  function guardPanelSandbox(overrides = {}) {
    const calls = [];
    const guardState = { status: { ...GUARD_STATUS } };
    const ctx = createFrontendSandbox({
      focusedAgentId: 'programming-helper',
      currentRuntimeAgentId: 'runtime-a',
      currentLanguage: 'zh',
      URLSearchParams,
      featurePanelBody: { addEventListener() {} },
      activeFeaturePanel: 'session-controls',
      getRuntimeWorkspaceSessionId: () => 'session-a',
      getActiveWorkspaceSessionId: () => 'session-a',
      renderFeaturePanel() {},
      newIdempotencyKey: () => 'test-idem-key',
      currentHookInspector: {
        lifecycleOrder: [],
        features: [
          { name: 'force-continuation' },
          { name: 'step-rotating-model' },
          { name: 'context-guard' },
        ],
        hooks: [],
      },
      fetch: async (url, options = {}) => {
        calls.push({ url, options });
        if (String(url) === '/protoclaw/context_guard_control') {
          const body = options.body ? JSON.parse(options.body) : null;
          if (body && body.strategy) guardState.status = { ...guardState.status, strategy: body.strategy };
          return { ok: true, status: 200, json: async () => ({ ok: true, status: { ...guardState.status } }) };
        }
        if (String(url).includes('force_continuation_status')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              status: {
                enabled: false,
                triggers: { outputTruncation: true, apiErrorRetry: true },
                maxConsecutiveContinuations: 3,
              },
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
      ...overrides,
    });
    ctx.window.setInterval = () => 0;
    ctx.loadSource('public/src/modules/context-guard-toggle.js');
    ctx.loadSource('public/src/modules/claw-host.js');
    loadEsmPluginInSandbox(ctx, 'public/src/panel-plugins/session-controls.js');
    ctx.run(`window.ContextGuardToggle.applyStatus({ status: ${JSON.stringify(GUARD_STATUS)} }, "runtime-a")`);
    return { ctx, calls, guardState };
  }

  it('renders the segmented selector first with the current strategy active', async () => {
    const { ctx } = guardPanelSandbox();
    await ctx.run('window.__pluginModule.refreshStatus({ renderWhenDone: false })');
    const html = ctx.run('window.__pluginModule.render()');
    const selectorAt = html.indexOf('data-guard-strategy');
    assert.ok(selectorAt > -1, 'strategy selector rendered');
    assert.ok(selectorAt < html.indexOf('API 重试'), 'selector sits at the top of the panel');
    // 卡片形态对标 Coder 策略页运行模式三栏切换（ph-pm-card 单选卡片）
    assert.match(html, /ph-coder-runtime-options/);
    assert.match(html, /data-guard-strategy="adaptive"[^>]*aria-pressed="true"/);
    assert.match(html, /class="ph-pm-card active" data-guard-strategy="adaptive"/);
    assert.match(html, /data-guard-strategy="adaptive"[^>]*>\s*<div class="ph-pm-radio checked"/);
    assert.match(html, /data-guard-strategy="trim"[^>]*aria-pressed="false"/);
    assert.match(html, /data-guard-strategy="summary"[^>]*aria-pressed="false"/);
    assert.match(html, /自适应/);
    assert.match(html, /纯精简/);
    assert.match(html, /纯摘要/);
    // 说明句只保留核心语义（触发线程接力时使用的策略）
    assert.match(html, /触发线程接力时使用的策略/);
    assert.doesNotMatch(html, /上边栏守卫第三档/);
  });

  it('hides the selector when rotation is not allowed for the assembly', async () => {
    const { ctx } = guardPanelSandbox();
    ctx.run('window.ContextGuardToggle.applyStatus({ status: { mode: "interrupt", strategy: "adaptive", allowRotation: false, trip: null, thresholdTokens: 160000 } }, "runtime-a")');
    await ctx.run('window.__pluginModule.refreshStatus({ renderWhenDone: false })');
    const html = ctx.run('window.__pluginModule.render()');
    assert.doesNotMatch(html, /data-guard-strategy/);
    assert.match(html, /API 重试/, 'the rest of the panel still renders');
  });

  it('posts the chosen strategy through context_guard_control and syncs the badge cache', async () => {
    const { ctx, calls } = guardPanelSandbox();
    await ctx.run('window.__pluginModule.refreshStatus({ renderWhenDone: false })');

    await ctx.run('window.__pluginModule.updateGuardStrategy("summary")');

    const write = calls.find((c) => c.url === '/protoclaw/context_guard_control');
    assert.ok(write, 'guard control write posted');
    assert.equal(write.options.method, 'POST');
    assert.deepEqual(JSON.parse(write.options.body), {
      agentId: 'programming-helper',
      sessionId: 'session-a',
      strategy: 'summary',
    });
    // 应答回填 badge 缓存（策略选择器与 badge 同源）：detail 反映新策略
    assert.equal(ctx.run('window.ContextGuardToggle.getDetail()').strategy, 'summary');
    const html = ctx.run('window.__pluginModule.render()');
    assert.match(html, /data-guard-strategy="summary"[^>]*aria-pressed="true"/);
  });

  it('shows the write error inline without disturbing the badge cache', async () => {
    const { ctx } = guardPanelSandbox({
      fetch: async (url) => {
        if (String(url) === '/protoclaw/context_guard_control') {
          return { ok: false, status: 503, json: async () => ({ ok: false, error: 'not mounted' }) };
        }
        if (String(url).includes('force_continuation_status')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, status: { enabled: false, triggers: {}, maxConsecutiveContinuations: 3 } }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
    });
    await ctx.run('window.__pluginModule.refreshStatus({ renderWhenDone: false })');

    await ctx.run('window.__pluginModule.updateGuardStrategy("trim")');

    const html = ctx.run('window.__pluginModule.render()');
    assert.match(html, /session-controls-guard-error/);
    assert.match(html, /not mounted/);
    assert.equal(ctx.run('window.ContextGuardToggle.getDetail()').strategy, 'adaptive', 'badge cache untouched on failure');
  });
});
