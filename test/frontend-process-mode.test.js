import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

describe('programming-helper workspace process mode UI', () => {
  it('lists official and optional features with direct config/removal actions', async () => {
    const ctx = createFrontendSandbox({
      fetch: async () => ({
        ok: true,
        json: async () => ({
          base: {
            main: [{ name: 'shell' }, { name: 'user-input' }],
            coder: [{ name: 'shell' }, { name: 'skill' }],
          },
          mounts: {
            coder: { 'coder-extra': { kind: 'package', package: '@agentdev/coder-extra', version: '1.0.0', missing: false } },
            main: {
              agentero: { kind: 'package', package: '@agentdev/agentero', version: '1.2.0', missing: false },
              'optional-browser': { kind: 'builtin', missing: false },
            },
          },
          envReady: { main: { hasEnv: true, ready: true } },
        }),
      }),
    });
    ctx.loadSource('public/src/modules/action-dispatcher.js');
    ctx.loadSource('public/src/modules/ph-settings.js');
    const settingsHost = { innerHTML: '' };
    const mountsHost = { innerHTML: '' };
    ctx.document.getElementById = (id) => id === 'ph-feature-mounts-host' ? mountsHost : settingsHost;
    ctx.run(`var currentLanguage = 'zh'; var escapeHtml = (value) => String(value);
      window.ClawFW = window.ClawFW || {};
      window.ClawFW.actions = { registerMany() {}, bindEventType() {} };
      var getFeatureCreatorProjects = () => [];
      var getCurrentAgentRecord = () => ({ id: 'programming-helper' });
      var getClawModelPresets = () => [];`);

    ctx.run(`(() => {
      window.phSettingsAgentId = 'programming-helper';
      renderPhSettingsOverlay({ id: 'programming-helper' }, []);
      _phSettingsTab = 'feature';
      renderPhSettingsOverlay({ id: 'programming-helper' }, []);
    })()`);
    await new Promise((resolve) => setImmediate(resolve));

    assert.match(settingsHost.innerHTML, /class="ph-settings-tab active"[^>]*data-tab="feature"/);
    assert.match(mountsHost.innerHTML, /agentero/);
    assert.match(mountsHost.innerHTML, /data-action="phSettings\.openFeatureConfig" data-name="agentero"/);
    assert.match(mountsHost.innerHTML, /data-action="phSettings\.removeMountFeature" data-identity="main" data-name="agentero"/);
    assert.match(mountsHost.innerHTML, /data-name="shell"/);
    assert.match(mountsHost.innerHTML, /data-name="user-input"/);
    assert.match(mountsHost.innerHTML, /data-name="optional-browser"/);
    assert.match(settingsHost.innerHTML, /data-sub="mounts"/);
    assert.match(settingsHost.innerHTML, /data-sub="config"/);
    assert.match(mountsHost.innerHTML, /ph-mount-list/);
    assert.doesNotMatch(mountsHost.innerHTML, /data-action="phSettings\.removeMountFeature" data-identity="main" data-name="shell"/);
  });
  it('keeps Coder official and mounted features in its assembly view and provides direct config navigation', async () => {
    const ctx = createFrontendSandbox({
      fetch: async () => ({ ok: true, json: async () => ({
        base: { coder: [{ name: 'shell' }, { name: 'skill' }] },
        mounts: { coder: { 'coder-extra': { kind: 'package', package: '@agentdev/coder-extra', version: '1.0.0', missing: false } } },
        envReady: { coder: { hasEnv: true, ready: true } },
      }) }),
    });
    ctx.window.phSettingsAgentId = 'programming-helper';
    ctx.loadSource('public/src/modules/action-dispatcher.js');
    ctx.loadSource('public/src/modules/ph-settings.js');
    const host = { innerHTML: '' };
    const mountsHost = { innerHTML: '' };
    const configHost = { id: 'ph-feature-config-host', innerHTML: '' };
    ctx.document.getElementById = (id) => id === 'ph-feature-config-host' ? configHost
      : id === 'ph-feature-mounts-host' ? mountsHost : host;
    const editorScopes = [];
    ctx.run(`window.ClawFW = window.ClawFW || {}; window.ClawFW.actions = { registerMany() {}, bindEventType() {} };`);
    ctx.run(`var editorScopes = [];
     var createFeatureConfigEditor = (options) => {
       editorScopes.push({ agentId: options.scopeAgentId || 'programming-helper', initialFeature: options.initialFeature || null });
       return { open() {}, close() {} };
     };
    var getCurrentAgentRecord = () => ({ id: 'programming-helper' });
    var getClawModelPresets = () => [];`);
    ctx.run(`(() => {
      _phSettingsTab = 'model';
      renderPhSettingsOverlay({ id: 'programming-helper' }, []);
      _phSwitchSettingsTab('coder');
    })()`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(host.innerHTML, /data-tab="coder"/);
    assert.match(host.innerHTML, /data-tab="feature"/);
    assert.match(host.innerHTML, /data-sub="mounts"/);
    assert.match(host.innerHTML, /data-sub="config"/);
    assert.match(mountsHost.innerHTML, /data-name="shell"/);
    assert.match(mountsHost.innerHTML, /data-name="skill"/);
    assert.match(mountsHost.innerHTML, /data-name="coder-extra"/);
    assert.match(mountsHost.innerHTML, /data-action="phSettings\.removeMountFeature" data-identity="coder" data-name="coder-extra"/);
    assert.doesNotMatch(mountsHost.innerHTML, /data-action="phSettings\.removeMountFeature" data-identity="coder" data-name="shell"/);
    ctx.run(`_phOpenFeatureConfig({ dataset: { name: 'skill' } });`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(JSON.stringify(ctx.run('editorScopes')), '[{"agentId":"coder","initialFeature":"skill"}]');
  });

  it('renders Coder policy as a host-workspace setting tab without adding quota policy to Programming Helper', () => {
    const ctx = createFrontendSandbox();
    ctx.window.phSettingsAgentId = 'programming-helper';
    ctx.loadSource('public/src/modules/action-dispatcher.js');
    ctx.loadSource('public/src/modules/ph-settings.js');
    const host = { innerHTML: '' };
    ctx.document.getElementById = () => host;
    ctx.run(`(() => {
      _phSettingsTab = 'coder-policy';
      renderPhSettingsOverlay({ id: 'programming-helper' }, []);
    })()`);
    assert.match(host.innerHTML, /Coder 策略/);
    assert.match(host.innerHTML, /ph-coder-policy-host/);
    assert.doesNotMatch(host.innerHTML, /编程小助手.*并发上限/);
  });
  it('renders the server-provided workspace mode without consulting a project key', () => {
    const ctx = createFrontendSandbox();
    ctx.loadSource('public/src/modules/action-dispatcher.js');
    ctx.loadSource('public/src/modules/ph-settings.js');

    const html = ctx.run(`_renderProcessModeContent({
      id: 'programming-helper',
      processMode: 'shared-global',
    })`);

    assert.match(html, /ph-pm-card active[^>]*data-action="phSettings\.setProcessMode" data-mode="shared-global"/);
    assert.doesNotMatch(html, /localStorage/);
  });

  it('saves Coder runtime policy through the same workspace-settings endpoint', async () => {
    const requests = [];
    const ctx = createFrontendSandbox({
      fetch: async (url, options) => {
        requests.push({ url, options });
        if (!options) return { ok: true, json: async () => ({ resourcePolicy: {}, liveThreads: {} }) };
        return { ok: true, json: async () => ({ ok: true }) };
      },
    });
    ctx.loadSource('public/src/modules/action-dispatcher.js');
    ctx.loadSource('public/src/modules/ph-settings.js');

    await ctx.run("window.ClawFW.actions.invoke('phSettings.saveCoderThreadLimit', { value: '4' })");

    const write = requests.find((request) => request.options?.method === 'PUT');
    assert.ok(write);
    assert.equal(write.url, '/protoclaw/workspace_settings/resource_policy');
    assert.deepEqual(JSON.parse(write.options.body), {
      agentId: 'coder',
      permissionId: 'maxLiveThreads',
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
    ctx.loadSource('public/src/modules/action-dispatcher.js');
    ctx.loadSource('public/src/modules/workspace-settings.js');

    await ctx.run("window.onWorkspaceQuotaChange('coder', '4')");

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/protoclaw/workspace_settings/resource_policy');
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      agentId: 'coder',
      permissionId: 'maxLiveThreads',
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
    ctx.loadSource('public/src/modules/action-dispatcher.js');
    ctx.loadSource('public/src/modules/ph-settings.js');

    await ctx.run("window.ClawFW.actions.invoke('phSettings.saveCoderThreadLimit', { value: '1.5' })");

    assert.equal(requests.length, 0);
  });

  it('renders the rotation-strategy cards with the user override active', async () => {
    const ctx = createFrontendSandbox({
      fetch: async () => ({
        ok: true,
        json: async () => ({ resourcePolicy: { coder: { contextRotationStrategy: 'trim' } }, liveThreads: {} }),
      }),
    });
    ctx.window.allAgents = [{ id: 'coder', permissionDefaults: { contextRotationStrategy: 'adaptive' } }];
    ctx.loadSource('public/src/modules/action-dispatcher.js');
    ctx.loadSource('public/src/modules/ph-settings.js');
    const host = { innerHTML: '', textContent: '' };
    ctx.document.getElementById = () => host;

    await ctx.run(`(async () => { _phSettingsTab = 'coder-policy'; await _phLoadCoderPolicy(); })()`);

    // 三张策略卡齐全（形态照进程模式页的 ph-pm-card 单选卡片）
    assert.match(host.innerHTML, /ph-pm-card active[^>]*data-action="phSettings\.setCoderRotationStrategy" data-mode="trim"/);
    assert.match(host.innerHTML, /data-mode="adaptive"/);
    assert.match(host.innerHTML, /data-mode="summary"/);
    // 用户覆盖（trim）压过作者默认（adaptive）
    assert.doesNotMatch(host.innerHTML, /ph-pm-card active[^>]*data-mode="adaptive"/);
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
    assert.match(host.innerHTML, /未归档线程的数量上限/);
    assert.match(host.innerHTML, /自动接续新会话所采用的精简方式/);
    assert.doesNotMatch(host.innerHTML, /即时生效/);
    // 并发上限行仍在同一分页
    assert.match(host.innerHTML, /线程并发上限/);
  });

  it('falls back to the author default when no user override is stored', async () => {
    const ctx = createFrontendSandbox({
      fetch: async () => ({
        ok: true,
        json: async () => ({ resourcePolicy: {}, liveThreads: {} }),
      }),
    });
    ctx.window.allAgents = [{ id: 'coder', permissionDefaults: { contextRotationStrategy: 'adaptive' } }];
    ctx.loadSource('public/src/modules/action-dispatcher.js');
    ctx.loadSource('public/src/modules/ph-settings.js');
    const host = { innerHTML: '', textContent: '' };
    ctx.document.getElementById = () => host;

    await ctx.run(`(async () => { _phSettingsTab = 'coder-policy'; await _phLoadCoderPolicy(); })()`);

    assert.match(host.innerHTML, /ph-pm-card active[^>]*data-action="phSettings\.setCoderRotationStrategy" data-mode="adaptive"/);
  });

  it('saves the rotation strategy through the workspace resource-policy endpoint', async () => {
    const requests = [];
    const ctx = createFrontendSandbox({
      fetch: async (url, options) => {
        requests.push({ url, options });
        if (!options) return { ok: true, json: async () => ({ resourcePolicy: {}, liveThreads: {} }) };
        return { ok: true, json: async () => ({ ok: true }) };
      },
    });
    ctx.loadSource('public/src/modules/action-dispatcher.js');
    ctx.loadSource('public/src/modules/ph-settings.js');
    const host = { innerHTML: '', textContent: '' };
    ctx.document.getElementById = () => host;

    await ctx.run(`(async () => { _phSettingsTab = 'coder-policy'; await window.ClawFW.actions.invoke('phSettings.setCoderRotationStrategy', { dataset: { mode: 'summary' } }); })()`);

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
    ctx.loadSource('public/src/modules/action-dispatcher.js');
    ctx.loadSource('public/src/modules/ph-settings.js');
    const host = { innerHTML: '', textContent: '' };
    ctx.document.getElementById = () => host;

    await ctx.run(`(async () => { await window.ClawFW.actions.invoke('phSettings.setCoderRotationStrategy', { dataset: { mode: 'bogus' } }); })()`);

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
      renderPhSettingsOverlay() {},
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
