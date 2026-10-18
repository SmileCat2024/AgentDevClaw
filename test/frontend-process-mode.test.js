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

  it('renders the rotation-strategy cards with the user override active', async () => {
    const ctx = createFrontendSandbox({
      fetch: async () => ({
        ok: true,
        json: async () => ({ resourcePolicy: { coder: { contextRotationStrategy: 'trim' } }, liveRuntimes: {} }),
      }),
    });
    ctx.window.allAgents = [{ id: 'coder', permissionDefaults: { contextRotationStrategy: 'adaptive' } }];
    ctx.loadSource('public/src/modules/ph-model-config.js');
    const host = { innerHTML: '', textContent: '' };
    ctx.document.getElementById = () => host;

    await ctx.run(`(async () => { _phSettingsTab = 'coder-policy'; await _phLoadCoderPolicy(); })()`);

    // 三张策略卡齐全（形态照进程模式页的 ph-pm-card 单选卡片）
    assert.match(host.innerHTML, /ph-pm-card active[^>]*onclick="window\.phSetCoderRotationStrategy\('trim'\)"/);
    assert.match(host.innerHTML, /window\.phSetCoderRotationStrategy\('adaptive'\)/);
    assert.match(host.innerHTML, /window\.phSetCoderRotationStrategy\('summary'\)/);
    // 用户覆盖（trim）压过作者默认（adaptive）
    assert.doesNotMatch(host.innerHTML, /ph-pm-card active[^>]*phSetCoderRotationStrategy\('adaptive'\)/);
    assert.match(host.innerHTML, /自适应/);
    assert.match(host.innerHTML, /纯精简/);
    assert.match(host.innerHTML, /纯摘要/);
    // 两行同形态（ph-mc-row + 名称/解释）：并发上限在上、接续策略在下，
    // 无分节小标题（settings-section-title）
    assert.doesNotMatch(host.innerHTML, /settings-section-title/);
    assert.ok(
      host.innerHTML.indexOf('并发上限') < host.innerHTML.indexOf('接续策略'),
      'concurrency row renders above the rotation-strategy row',
    );
    // 两行都带固定解释副标题；生效时机的说明文案不再出现在页面上
    assert.match(host.innerHTML, /同时运行的会话数量上限/);
    assert.match(host.innerHTML, /自动接续新会话所采用的精简方式/);
    assert.doesNotMatch(host.innerHTML, /即时生效/);
    // 并发上限行仍在同一分页
    assert.match(host.innerHTML, /并发上限/);
  });

  it('falls back to the author default when no user override is stored', async () => {
    const ctx = createFrontendSandbox({
      fetch: async () => ({
        ok: true,
        json: async () => ({ resourcePolicy: {}, liveRuntimes: {} }),
      }),
    });
    ctx.window.allAgents = [{ id: 'coder', permissionDefaults: { contextRotationStrategy: 'adaptive' } }];
    ctx.loadSource('public/src/modules/ph-model-config.js');
    const host = { innerHTML: '', textContent: '' };
    ctx.document.getElementById = () => host;

    await ctx.run(`(async () => { _phSettingsTab = 'coder-policy'; await _phLoadCoderPolicy(); })()`);

    assert.match(host.innerHTML, /ph-pm-card active[^>]*onclick="window\.phSetCoderRotationStrategy\('adaptive'\)"/);
  });

  it('saves the rotation strategy through the workspace resource-policy endpoint', async () => {
    const requests = [];
    const ctx = createFrontendSandbox({
      fetch: async (url, options) => {
        requests.push({ url, options });
        if (!options) return { ok: true, json: async () => ({ resourcePolicy: {}, liveRuntimes: {} }) };
        return { ok: true, json: async () => ({ ok: true }) };
      },
    });
    ctx.loadSource('public/src/modules/ph-model-config.js');
    const host = { innerHTML: '', textContent: '' };
    ctx.document.getElementById = () => host;

    await ctx.run(`(async () => { _phSettingsTab = 'coder-policy'; await window.phSetCoderRotationStrategy('summary'); })()`);

    const write = requests.find((request) => request.options?.method === 'PUT');
    assert.ok(write);
    assert.equal(write.url, '/protoclaw/workspace_settings/resource_policy');
    assert.deepEqual(JSON.parse(write.options.body), {
      agentId: 'coder',
      permissionId: 'contextRotationStrategy',
      value: 'summary',
    });
    // 保存后重载分页
    assert.ok(requests.some((request) => !request.options && request.url === '/protoclaw/workspace_settings'));
    assert.equal(host.textContent, '已保存');
  });

  it('rejects unknown strategy values before making a request', async () => {
    const requests = [];
    const ctx = createFrontendSandbox({
      fetch: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, json: async () => ({ ok: true }) };
      },
    });
    ctx.loadSource('public/src/modules/ph-model-config.js');
    const host = { innerHTML: '', textContent: '' };
    ctx.document.getElementById = () => host;

    await ctx.run(`(async () => { await window.phSetCoderRotationStrategy('bogus'); })()`);

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
