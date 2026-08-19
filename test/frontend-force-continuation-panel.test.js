import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function panelSandbox(overrides = {}) {
  const fetchCalls = [];
  const ctx = createFrontendSandbox({
    currentAgentId: 'programming-helper',
    currentRuntimeAgentId: 'runtime-a',
    currentLanguage: 'zh',
    URLSearchParams,
    featurePanelBody: { addEventListener() {} },
    activeFeaturePanel: null,
    getRuntimeWorkspaceSessionId: () => 'session-a',
    getActiveWorkspaceSessionId: () => 'session-a',
    renderFeaturePanel() {},
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          status: {
            enabled: false,
            triggers: { providerMaxTokens: true, providerLength: true, frameworkLimitReached: true },
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
  ctx.loadSource('public/src/modules/force-continuation-panel.js');
  return { ctx, fetchCalls };
}

describe('ForceContinuationPanel', () => {
  it('reads authoritative session status when the panel is opened', async () => {
    const { ctx, fetchCalls } = panelSandbox();

    await ctx.run('window.ForceContinuationPanel.refreshStatus({ renderWhenDone: false })');
    const html = ctx.run('window.ForceContinuationPanel.render()');

    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].url, /^\/protoclaw\/force_continuation_status\?/);
    assert.match(fetchCalls[0].url, /agentId=programming-helper/);
    assert.match(fetchCalls[0].url, /sessionId=session-a/);
    // 无摘要/状态行：启停由开关本身表达，默认状态不渲染任何状态文本
    assert.doesNotMatch(html, /force-continuation-summary/);
    assert.doesNotMatch(html, /force-continuation-status-line/);
    assert.match(html, /data-force-continuation-toggle>/);
    assert.doesNotMatch(html, /data-force-continuation-toggle checked/);
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
              triggers: { providerMaxTokens: true, providerLength: true, frameworkLimitReached: true },
              maxConsecutiveContinuations: 3,
              lastAction: 'idle',
            },
          }),
        };
      },
    });

    await ctx.run('window.ForceContinuationPanel.updateEnabled(true)');
    const html = ctx.run('window.ForceContinuationPanel.render()');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/protoclaw/force_continuation_control');
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      agentId: 'programming-helper',
      sessionId: 'session-a',
      enabled: true,
    });
    assert.match(html, /data-force-continuation-toggle checked/);
    assert.match(html, /输出长度达到上限/);
    assert.doesNotMatch(html, /max_tokens（|（length）|（max_tokens）/);
    assert.match(html, /data-force-continuation-trigger=\"outputTruncation\" checked/);
    assert.match(html, /data-force-continuation-limit[^>]*value="3"/);
  });

  it('updates one recovery candidate without changing the master switch and uses the Todo toggle markup', async () => {
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
              triggers: { providerMaxTokens: true, providerLength: false, frameworkLimitReached: true },
            },
          }),
        };
      },
    });

    await ctx.run('window.ForceContinuationPanel.updateTrigger("outputTruncation", false)');
    const html = ctx.run('window.ForceContinuationPanel.render()');

    assert.deepEqual(JSON.parse(calls[0].options.body), {
      agentId: 'programming-helper',
      sessionId: 'session-a',
      triggers: { providerMaxTokens: false, providerLength: false },
    });
    assert.match(html, /class=\"tool-toggle-input\" data-force-continuation-toggle/);
    assert.match(html, /class=\"tool-toggle-input\" data-force-continuation-trigger=\"frameworkLimitReached\" checked/);
  });

  it('adjusts the auto-resume cap from the number input and clamps invalid values', async () => {
    const calls = [];
    const { ctx } = panelSandbox({
      fetch: async (url, options = {}) => {
        calls.push({ url, options });
        return {
          ok: true, status: 200,
          json: async () => ({ ok: true, status: {
            enabled: true,
            triggers: { providerMaxTokens: true, providerLength: true, frameworkLimitReached: true },
            maxConsecutiveContinuations: 8,
          } }),
        };
      },
    });

    await ctx.run('window.ForceContinuationPanel.updateLimit(8)');
    let html = ctx.run('window.ForceContinuationPanel.render()');
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      agentId: 'programming-helper',
      sessionId: 'session-a',
      maxConsecutiveContinuations: 8,
    });
    assert.match(html, /data-force-continuation-limit[^>]*value="8"/);

    // Out-of-range input is rejected client-side without a request.
    await ctx.run('window.ForceContinuationPanel.updateLimit(42)');
    await ctx.run('window.ForceContinuationPanel.updateLimit("NaN")');
    assert.equal(calls.length, 1);
    html = ctx.run('window.ForceContinuationPanel.render()');
    assert.match(html, /data-force-continuation-limit[^>]*value="8"/);
  });

  it('keeps the control unavailable outside a connected programming-helper session', () => {
    const { ctx } = panelSandbox({ currentAgentId: 'qqbot', currentRuntimeAgentId: null });
    const html = ctx.run('window.ForceContinuationPanel.render()');

    // 不可用时返回与 hooks 面板一致的通用空态（无开关控件）
    assert.match(html, /feature-panel-empty/);
    assert.match(html, /feature-panel-section-title/);
    assert.doesNotMatch(html, /data-force-continuation-toggle/);
    assert.match(html, /此控制仅适用于编程小助手/);
  });
});
