import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

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
  ctx.loadSource('public/src/modules/session-controls-panel.js');
  return { ctx, fetchCalls };
}

describe('SessionControlsPanel', () => {
  it('reads authoritative session status when the panel is opened', async () => {
    const { ctx, fetchCalls } = panelSandbox();

    await ctx.run('window.SessionControlsPanel.refreshStatus({ renderWhenDone: false })');
    const html = ctx.run('window.SessionControlsPanel.render()');

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

    await ctx.run('window.SessionControlsPanel.updateTrigger("apiErrorRetry", true)');
    const html = ctx.run('window.SessionControlsPanel.render()');

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

    await ctx.run('window.SessionControlsPanel.updateTrigger("outputTruncation", false)');
    const html = ctx.run('window.SessionControlsPanel.render()');

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

    await ctx.run('window.SessionControlsPanel.updateLimit(8)');
    let html = ctx.run('window.SessionControlsPanel.render()');
    const fcCall = calls.find((c) => c.url === '/protoclaw/force_continuation_control');
    assert.deepEqual(JSON.parse(fcCall.options.body), {
      agentId: 'programming-helper',
      sessionId: 'session-a',
      maxConsecutiveContinuations: 8,
    });
    assert.match(html, /data-force-continuation-limit[^>]*value="8"/);

    // Out-of-range input is rejected client-side without a request.
    await ctx.run('window.SessionControlsPanel.updateLimit(42)');
    await ctx.run('window.SessionControlsPanel.updateLimit("NaN")');
    assert.equal(calls.filter((c) => c.url === '/protoclaw/force_continuation_control').length, 1);
    html = ctx.run('window.SessionControlsPanel.render()');
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
    const first = ctx.run('window.SessionControlsPanel.render()');
    // 名单里没有受控 feature：先探测确证「确实没挂载」，再下结论
    assert.match(first, /正在读取本会话的控制能力/);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const html = ctx.run('window.SessionControlsPanel.render()');

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
    const html = ctx.run('window.SessionControlsPanel.render()');

    assert.match(html, /data-force-continuation-trigger="outputTruncation"/);
    // 迁移回归：context-guard 的开关已迁至上边栏 badge，面板不再渲染任何 guard 控件
    assert.doesNotMatch(html, /data-guard-armed/);
    assert.doesNotMatch(html, /data-rotation-enabled/);
    // 底部说明只覆盖已显示的 section
    assert.match(html, /手动停止和不可重试错误（如认证失败）不会自动重试/);
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
    const html = ctx.run('window.SessionControlsPanel.render()');

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

    const first = ctx.run('window.SessionControlsPanel.render()');
    // 快照未决：先给等待态，不误判为「工作空间不支持」
    assert.match(first, /正在读取本会话的控制能力/);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const html = ctx.run('window.SessionControlsPanel.render()');

    assert.match(html, /data-force-continuation-trigger="outputTruncation"/);
    assert.doesNotMatch(html, /data-guard-armed/);
    assert.equal(probeCount, 1); // 结果按 runtime 缓存，不再重复探测
  });

  it('serves the panel for the agent-studio workspace', async () => {
    const { ctx, fetchCalls } = panelSandbox({
      focusedAgentId: 'agent-studio',
      currentRuntimeAgentId: 'runtime-studio',
    });

    await ctx.run('window.SessionControlsPanel.refreshStatus({ renderWhenDone: false })');
    const html = ctx.run('window.SessionControlsPanel.render()');

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
    ctx.loadSource('public/src/modules/session-controls-panel.js');
    return { ctx, invokeCalls };
  }

  it('renders the style trigger from stylized-output.configure status', async () => {
    const { ctx, invokeCalls } = stylePanelSandbox();

    await ctx.run('window.SessionControlsPanel.refreshStyleStatus({ renderWhenDone: false })');
    const html = ctx.run('window.SessionControlsPanel.render()');

    assert.match(html, /data-style-menu/);
    assert.match(html, /简洁汇报/);
    assert.match(html, /门禁已启用/);

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

    await ctx.run('window.SessionControlsPanel.updateStyleSelection("正式汇报")');

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

    await ctx.run('window.SessionControlsPanel.updateStyleSelection("")');

    const writes = invokeCalls.filter(
      (c) => String(c.url).includes('capability_invoke') && c.options && c.options.method === 'POST',
    );
    assert.ok(writes.length >= 1, 'a style write was posted');
    const body = JSON.parse(writes[writes.length - 1].options.body);
    assert.deepEqual(body.args, { styleName: null });
  });
});