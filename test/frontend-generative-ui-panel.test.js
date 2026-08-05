import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { createDomHarness } from './helpers/dom-harness.js';

const _trackedIntervals = [];
const _trackedSetInterval = (...args) => {
  const id = setInterval(...args);
  _trackedIntervals.push(id);
  return id;
};

after(() => {
  _trackedIntervals.forEach(id => clearInterval(id));
});

describe('Generative UI panel submit adapter', () => {
  it('renders multiple surfaces as tabs and keeps only the selected page visible', () => {
    const dom = createDomHarness();
    dom.createMount('gen-ui-mount');
    const ctx = createFrontendSandbox({
      document: dom.document,
      setInterval: _trackedSetInterval,
      createGenUIViewState: () => ({}),
      renderGenUISpec: (spec) => {
        const rendered = dom.document.createElement('div');
        rendered.className = 'rendered-spec';
        rendered.textContent = spec.title;
        return rendered;
      },
    });
    ctx.loadSource('public/src/modules/generative-ui-panel.js');

    ctx.run(`window.GenUIPanel._internal._applyRegistryUpdate({ surfaces: [
      { surfaceId: 'profile', revision: 1, title: 'Profile', spec: { title: 'Profile', description: 'Basic details' }, closed: false },
      { surfaceId: 'advanced', revision: 2, title: 'Advanced', spec: { title: 'Advanced' }, closed: false }
    ] })`);

    const mount = dom.document.getElementById('gen-ui-mount');
    const tabs = dom.findAll(mount, '.gen-ui-surface-tab');
    assert.equal(tabs.length, 2);
    assert.deepEqual(tabs.map((tab) => tab.textContent), ['Profile', 'Advanced']);
    assert.equal(dom.findAll(mount, '.settings-tab-bar').length, 1);
    const closeTabs = dom.findAll(mount, '.gen-ui-surface-tab-close');
    assert.equal(closeTabs.length, 2);
    assert.equal(closeTabs[0].parentNode.classList.contains('gen-ui-surface-tab-item'), true);
    assert.equal(dom.findAll(mount, '.gen-ui-surface-page').length, 1);
    assert.equal(dom.findAll(mount, '.gen-ui-surface-page-header').length, 0);
    assert.equal(dom.findAll(mount, '.gen-ui-surface-title').length, 0);
    assert.equal(tabs[0].attributes['aria-controls'], 'gen-ui-surface-page-profile');

    tabs[1].dispatch('click');
    assert.equal(dom.findAll(mount, '.gen-ui-surface-page').length, 1);
    assert.equal(dom.findAll(mount, '.gen-ui-surface-page')[0].id, 'gen-ui-surface-page-advanced');
    assert.equal(dom.findAll(mount, '.gen-ui-surface-tab-item')[1].classList.contains('is-active'), true);
  });

  it('keeps only explicit user overrides when a surface spec is refreshed', () => {
    const ctx = createFrontendSandbox({ setInterval: _trackedSetInterval });
    ctx.loadSource('public/src/modules/generative-ui-panel.js');
    const merged = ctx.run(`window.GenUIPanel._internal._mergeViewState(
      {
        initialValues: { title: 'New prefill', enabled: false },
        elements: {
          title: { type: 'TextInput', props: { name: 'title' } },
          enabled: { type: 'Checkbox', props: { name: 'enabled' } }
        }
      },
      { title: 'User draft', enabled: true, removedField: 'discard me' }
    )`);
    assert.deepEqual(JSON.parse(JSON.stringify(merged)), { title: 'User draft', enabled: true });
  });

  it('uses the validated surface action route instead of queue-input directly', async () => {
    const calls = [];
    const fetch = async (url, options = {}) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, delivery: 'input', requestId: 'input-1' }),
        text: async () => '',
      };
    };
    const viewPatches = [];
    const ctx = createFrontendSandbox({
      currentRuntimeAgentId: 'agent/a',
      fetch,
      setInterval: _trackedSetInterval,
      applySessionViewPatch: (patch) => viewPatches.push(patch),
      renderInputRequests() {},
      clearInterruptSuppression() {},
      _markAgentCallStartedForNotify() {},
      _agentCallActive: new Map(),
      _syncPersistentActionButton() {},
      renderAgentList() {},
      poll() {},
      lastRenderedInputSignature: 'old',
    });
    ctx.loadSource('public/src/modules/generative-ui-panel.js');
    ctx.run(`window.GenUIPanel._internal._registry.set('settings', {
      revision: 7,
      spec: { title: 'Settings' },
      title: 'Settings',
      closed: false
    })`);

    await ctx.run(`window.GenUIPanel._internal._submitAction(
      'settings',
      'save',
      { label: 'Save' },
      { theme: 'dark' }
    )`);

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      '/protoclaw/agents/agent%2Fa/ui-surfaces/settings/actions/save',
    );
    assert.ok(!calls[0].url.includes('queue-input'));
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.surfaceRevision, 7);
    assert.deepEqual(body.values, { theme: 'dark' });
    assert.match(body.eventId, /^ui-/);
    assert.equal(viewPatches.length, 1);
    assert.equal(Array.isArray(viewPatches[0].inputRequests), true);
    assert.equal(viewPatches[0].inputRequests.length, 0);
  });

  it('reports delivery failures without claiming submission success', async () => {
    const toasts = [];
    const ctx = createFrontendSandbox({
      currentRuntimeAgentId: 'agent-a',
      setInterval: _trackedSetInterval,
      fetch: async () => ({
        ok: false,
        status: 409,
        json: async () => ({ message: 'Agent runtime is not accepting input' }),
      }),
      ClawToast: { show: (value) => toasts.push(value) },
    });
    ctx.loadSource('public/src/modules/generative-ui-panel.js');
    ctx.run(`window.GenUIPanel._internal._registry.set('settings', {
      revision: 1,
      spec: { title: 'Settings' },
      title: 'Settings',
      closed: false
    })`);

    await ctx.run(`window.GenUIPanel._internal._submitAction(
      'settings',
      'save',
      { label: 'Save' },
      { theme: 'dark' }
    )`);

    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].status, 'error');
    assert.match(toasts[0].description, /not accepting input/);
  });

  it('reuses the model settings dropdown enhancer and shows a local confirmation before dispatch', () => {
    const dom = createDomHarness();
    dom.createMount('gen-ui-mount');
    const enhancerCalls = [];
    let rendererCallbacks;
    let executed = 0;
    const ctx = createFrontendSandbox({
      document: dom.document,
      setInterval: _trackedSetInterval,
      ClawSelect: {
        enhanceAll: (container, selector) => enhancerCalls.push({ container, selector }),
      },
      createGenUIViewState: () => ({}),
      renderGenUISpec: (_spec, _viewState, callbacks) => {
        rendererCallbacks = callbacks;
        const select = dom.document.createElement('select');
        select.dataset.genUiSelect = 'true';
        return select;
      },
    });
    ctx.loadSource('public/src/modules/generative-ui-panel.js');
    ctx.run(`window.GenUIPanel._internal._applyRegistryUpdate({ surfaces: [
      { surfaceId: 'release', revision: 1, title: 'Release', spec: { title: 'Release' }, closed: false }
    ] })`);

    assert.equal(enhancerCalls.length, 1);
    assert.equal(enhancerCalls[0].selector, 'select[data-gen-ui-select]');
    rendererCallbacks.onConfirm(
      'apply',
      { intent: 'submit', label: 'Apply', confirm: { title: 'Apply release?', description: 'This sends the current values.', confirmLabel: 'Apply now' } },
      { rollout: 40 },
      () => { executed += 1; },
    );

    const mount = dom.document.getElementById('gen-ui-mount');
    assert.equal(dom.findAll(mount, '.gen-ui-confirm-backdrop').length, 1);
    assert.equal(dom.findAll(mount, '.gen-ui-confirm-title')[0].textContent, 'Apply release?');
    assert.equal(executed, 0);
    dom.findAll(mount, '.btn-primary')[0].dispatch('click');
    assert.equal(executed, 1);
    assert.equal(dom.findAll(mount, '.gen-ui-confirm-backdrop').length, 0);
  });
});
