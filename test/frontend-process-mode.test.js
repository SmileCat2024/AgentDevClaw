import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

describe('programming-helper workspace process mode UI', () => {
  it('renders the server-provided workspace mode without consulting a project key', () => {
    const ctx = createFrontendSandbox();
    ctx.loadSource('public/src/modules/ph-model-config.js');

    const html = ctx.run(`_renderProcessModeContent({
      id: 'programming-helper',
      processMode: 'shared-global',
    })`);

    assert.match(html, /ph-pm-card active[^>]*onclick="window\.phSetProcessMode\('shared-global'\)"/);
    assert.doesNotMatch(html, /localStorage/);
  });

  it('persists the selection through the workspace-level server endpoint', async () => {
    const requests = [];
    const agent = { id: 'programming-helper', processMode: 'shared-by-project' };
    const ctx = createFrontendSandbox({
      getCurrentAgentRecord: () => agent,
      // app-core.js 全局（本用例仅加载 ph-project-actions.js）
      isPhStyleWorkspaceAgent: (candidate) => candidate?.id === 'programming-helper',
      getLogicalAgentId: (record) => record?.parent_id || record?.id || null,
      fetch: async (url, options) => {
        requests.push({ url, options });
        return {
          ok: true,
          json: async () => ({ ok: true, agentId: 'programming-helper', processMode: 'shared-global' }),
        };
      },
      renderPhModelConfigOverlay() {},
      renderCurrentMainView() {},
      invoke: async () => ({}),
      updateAgentRecord() {},
      updateAgentWorkspaceState() {},
      lastRenderedWorkspaceHtml: '',
      phSearchQuery: '',
      phSearchResults: null,
      phSearchLoading: false,
      _phSearchTimer: null,
      ClawToast: { show() {}, update() {} },
    });
    ctx.loadSource('public/src/modules/ph-project-actions.js');

    await ctx.run("window.phSetProcessMode('shared-global')");

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/protoclaw/agent_process_mode');
    assert.equal(requests[0].options.method, 'PUT');
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      agentId: 'programming-helper',
      processMode: 'shared-global',
    });
    assert.equal(agent.processMode, 'shared-global');
  });
});
