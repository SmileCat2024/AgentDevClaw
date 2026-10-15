import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

describe('programming-helper workspace process mode UI', () => {
  it('renders Coder policy as a host-workspace setting tab without adding quota policy to Programming Helper', () => {
    const ctx = createFrontendSandbox();
    ctx.window.phModelConfigAgentId = 'programming-helper';
    ctx.loadSource('public/src/modules/ph-model-config.js');
    const host = { innerHTML: '' };
    ctx.document.getElementById = () => host;
    ctx.run(`(() => {
      _phSettingsTab = 'coder-policy';
      renderPhModelConfigOverlay({ id: 'programming-helper' }, []);
    })()`);
    assert.match(host.innerHTML, /Coder 策略/);
    assert.match(host.innerHTML, /ph-coder-policy-host/);
    assert.doesNotMatch(host.innerHTML, /编程小助手.*并发上限/);
  });
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

  it('saves Coder runtime policy through the same workspace-settings endpoint', async () => {
    const requests = [];
    const ctx = createFrontendSandbox({
      fetch: async (url, options) => {
        requests.push({ url, options });
        if (!options) return { ok: true, json: async () => ({ resourcePolicy: {}, liveRuntimes: {} }) };
        return { ok: true, json: async () => ({ ok: true }) };
      },
    });
    ctx.loadSource('public/src/modules/ph-model-config.js');

    await ctx.run("window.phSaveCoderRuntimeLimit('4')");

    const write = requests.find((request) => request.options?.method === 'PUT');
    assert.ok(write);
    assert.equal(write.url, '/protoclaw/workspace_settings/resource_policy');
    assert.deepEqual(JSON.parse(write.options.body), {
      agentId: 'coder',
      permissionId: 'maxLiveRuntimes',
      value: 4,
    });
    assert.ok(requests.some((request) => request.url === '/protoclaw/workspace_settings'));
  });

  it('global workspace settings editor writes the same Coder permission item', async () => {
    const requests = [];
    const ctx = createFrontendSandbox({
      fetch: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, json: async () => ({ ok: true }) };
      },
    });
    ctx.loadSource('public/src/modules/workspace-settings.js');

    await ctx.run("window.onWorkspaceQuotaChange('coder', '4')");

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/protoclaw/workspace_settings/resource_policy');
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      agentId: 'coder',
      permissionId: 'maxLiveRuntimes',
      value: 4,
    });
  });

  it('rejects invalid Coder limit values before making a request', async () => {
    const requests = [];
    const ctx = createFrontendSandbox({
      fetch: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, json: async () => ({ ok: true }) };
      },
    });
    ctx.loadSource('public/src/modules/ph-model-config.js');

    await ctx.run("window.phSaveCoderRuntimeLimit('1.5')");

    assert.equal(requests.length, 0);
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
