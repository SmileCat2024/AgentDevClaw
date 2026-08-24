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
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => {
          if (String(url).startsWith('/protoclaw/context_guard')) {
            return {
              ok: true,
              status: { armed: true, trip: null, thresholdTokens: 160000 },
            };
          }
          return {
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
          };
        },
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
          json: async () => {
            if (String(url).startsWith('/protoclaw/context_guard')) {
              return { ok: true, status: { armed: true, trip: null, thresholdTokens: 160000 } };
            }
            return {
              ok: true,
              status: {
                enabled: true,
                triggers: { providerMaxTokens: true, providerLength: true, frameworkLimitReached: true },
                maxConsecutiveContinuations: 3,
                lastAction: 'idle',
              },
            };
          },
        };
      },
    });

    await ctx.run('window.SessionControlsPanel.updateEnabled(true)');
    const html = ctx.run('window.SessionControlsPanel.render()');

    const fcCall = calls.find((c) => c.url === '/protoclaw/force_continuation_control');
    assert.ok(fcCall);
    assert.deepEqual(JSON.parse(fcCall.options.body), {
      agentId: 'programming-helper',
      sessionId: 'session-a',
      enabled: true,
    });
    assert.match(html, /data-force-continuation-toggle checked/);
    assert.match(html, /输出长度达到上限/);
    assert.doesNotMatch(html, /max_tokens（|（length）|（max_tokens）/);
    assert.match(html, /data-force-continuation-trigger=\"outputTruncation\" checked/);
    assert.match(html, /data-force-continuation-limit[^>]*value=\"3\"/);
  });

  it('updates one recovery candidate without changing the master switch and uses the Todo toggle markup', async () => {
    const calls = [];
    const { ctx } = panelSandbox({
      fetch: async (url, options = {}) => {
        calls.push({ url, options });
        return {
          ok: true,
          status: 200,
          json: async () => {
            if (String(url).startsWith('/protoclaw/context_guard')) {
              return { ok: true, status: { armed: true, trip: null, thresholdTokens: 160000 } };
            }
            return {
              ok: true,
              status: {
                enabled: true,
                triggers: { providerMaxTokens: true, providerLength: false, frameworkLimitReached: true },
              },
            };
          },
        };
      },
    });

    await ctx.run('window.SessionControlsPanel.updateTrigger("outputTruncation", false)');
    const html = ctx.run('window.SessionControlsPanel.render()');

    const fcCall = calls.find((c) => c.url === '/protoclaw/force_continuation_control');
    assert.deepEqual(JSON.parse(fcCall.options.body), {
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
          json: async () => {
            if (String(url).startsWith('/protoclaw/context_guard')) {
              return { ok: true, status: { armed: true, trip: null, thresholdTokens: 160000 } };
            }
            return { ok: true, status: {
              enabled: true,
              triggers: { providerMaxTokens: true, providerLength: true, frameworkLimitReached: true },
              maxConsecutiveContinuations: 8,
            } };
          },
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
    assert.match(html, /data-force-continuation-limit[^>]*value=\"8\"/);

    // Out-of-range input is rejected client-side without a request.
    await ctx.run('window.SessionControlsPanel.updateLimit(42)');
    await ctx.run('window.SessionControlsPanel.updateLimit("NaN")');
    assert.equal(calls.filter((c) => c.url === '/protoclaw/force_continuation_control').length, 1);
    html = ctx.run('window.SessionControlsPanel.render()');
    assert.match(html, /data-force-continuation-limit[^>]*value=\"8\"/);
  });

  it('keeps the control unavailable for agents without the features mounted', () => {
    const { ctx } = panelSandbox({ focusedAgentId: 'qqbot', currentRuntimeAgentId: null });
    const html = ctx.run('window.SessionControlsPanel.render()');

    // 不可用时返回与 hooks 面板一致的通用空态（无开关控件）
    assert.match(html, /feature-panel-empty/);
    assert.match(html, /feature-panel-section-title/);
    assert.doesNotMatch(html, /data-force-continuation-toggle/);
    assert.doesNotMatch(html, /data-guard-armed/);
    assert.match(html, /此控制在当前工作空间不可用/);
  });

  it('serves the panel for the agent-studio workspace', async () => {
    const { ctx, fetchCalls } = panelSandbox({
      focusedAgentId: 'agent-studio',
      currentRuntimeAgentId: 'runtime-studio',
    });

    await ctx.run('window.SessionControlsPanel.refreshStatus({ renderWhenDone: false })');
    const html = ctx.run('window.SessionControlsPanel.render()');

    assert.match(fetchCalls[0].url, /agentId=agent-studio/);
    assert.match(html, /data-force-continuation-toggle/);
  });
});

describe('SessionControlsPanel: context guard fuse', () => {
  it('shows the consumed fuse as off with the trip fact, and re-arms through session-targeted control', async () => {
    const calls = [];
    let armed = false;
    const { ctx } = panelSandbox({
      fetch: async (url, options = {}) => {
        calls.push({ url, options });
        const body = options.body ? JSON.parse(options.body) : null;
        if (String(url) === '/protoclaw/context_guard_control') armed = body.armed === true;
        return {
          ok: true,
          status: 200,
          json: async () => {
            if (String(url).startsWith('/protoclaw/context_guard')) {
              return {
                ok: true,
                status: {
                  armed,
                  trip: { at: 1750000000000, thresholdTokens: 8000, inputTokens: 8300, reason: 'Context threshold reached.' },
                  thresholdTokens: 8000,
                },
              };
            }
            return {
              ok: true,
              status: {
                enabled: false,
                triggers: { providerMaxTokens: true, providerLength: true, frameworkLimitReached: true },
              },
            };
          },
        };
      },
    });

    await ctx.run('window.SessionControlsPanel.refreshGuardStatus({ renderWhenDone: false })');
    let html = ctx.run('window.SessionControlsPanel.render()');
    // 开关已触发关闭：开关为关，同时展示最近一次触发事实
    assert.doesNotMatch(html, /data-guard-armed checked/);
    assert.match(html, /超阈值自动打断/);
    assert.match(html, /最近一次触发/);
    assert.match(html, /8\.3K \/ 8\.0K/);

    await ctx.run('window.SessionControlsPanel.updateGuardArmed(true)');
    const guardCall = calls.find((c) => c.url === '/protoclaw/context_guard_control');
    assert.ok(guardCall);
    assert.deepEqual(JSON.parse(guardCall.options.body), {
      agentId: 'programming-helper',
      sessionId: 'session-a',
      armed: true,
    });
    html = ctx.run('window.SessionControlsPanel.render()');
    assert.match(html, /data-guard-armed checked/);
  });

  it('shows the threshold hint while the fuse is armed and untouched', async () => {
    const { ctx } = panelSandbox();
    await ctx.run('window.SessionControlsPanel.refreshGuardStatus({ renderWhenDone: false })');
    const html = ctx.run('window.SessionControlsPanel.render()');
    assert.match(html, /data-guard-armed checked/);
    assert.match(html, /当前阈值约 160\.0K tokens/);
    assert.doesNotMatch(html, /最近一次触发/);
  });
});
