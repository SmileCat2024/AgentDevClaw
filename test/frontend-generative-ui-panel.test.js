import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { createDomHarness } from './helpers/dom-harness.js';
import { APP_CORE_DOMAIN, prepareEsmModules } from './p2-classic-hosts.js';

/**
 * generative-ui-panel（P4 L2 已迁 ESM）：真实 import 路线。
 *
 * classic 相只装面板注册表宿主（claw-host）与 app-core（内核桥初值 + P2
 * bootstrap 宿主工厂：callActivity 的 `_agentCallActive`）。渲染器入口仍是测试
 * 注入缝——模块经 `window.renderGenUISpec` / `window.createGenUIViewState` 取用，
 * 因此用例照旧注入假渲染器（不改被测面）。
 */

const GENUI = 'public/src/modules/generative-ui-panel.js';
const ORCHESTRATION = 'public/src/modules/orchestration-state.js';

/**
 * 一个用例 = 一份 classic 沙箱 + 一张真实 ESM 图。
 * @param {{ dom?: object, globals?: object, runtimeAgentId?: string|null }} options
 * @param {(env: { ctx: object, module: object }) => any} fn
 */
function withGenUICase({ dom, globals = {}, runtimeAgentId = null } = {}, fn) {
  return withP2EsmCase({
    globals: {
      ...(dom ? { document: dom.document } : {}),
      ...globals,
    },
    classic: (sandbox) => {
      // 生产顺序：claw-host（面板注册表宿主）先于面板实现；app-core 提供内核桥
      // 初值与 P2 bootstrap 宿主工厂（callActivity）。
      sandbox.loadSource('public/src/modules/claw-host.js');
      prepareEsmModules(sandbox, APP_CORE_DOMAIN);
    },
  }, async (c) => {
    const module = await c.load(GENUI);
    if (runtimeAgentId) {
      const orchestration = await c.load(ORCHESTRATION);
      orchestration.setCurrentRuntimeAgentId(runtimeAgentId);
    }
    return fn({ ctx: c.window, module });
  });
}

describe('Generative UI panel submit adapter', () => {
  it('renders multiple surfaces as tabs and keeps only the selected page visible', async () => {
    const dom = createDomHarness();
    dom.createMount('gen-ui-mount');
    await withGenUICase({
      dom,
      globals: {
        createGenUIViewState: () => ({}),
        renderGenUISpec: (spec) => {
          const rendered = dom.document.createElement('div');
          rendered.className = 'rendered-spec';
          rendered.textContent = spec.title;
          return rendered;
        },
      },
    }, ({ ctx }) => {
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
  });

  it('keeps only explicit user overrides when a surface spec is refreshed', async () => {
    await withGenUICase({}, ({ ctx }) => {
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
    await withGenUICase({
      runtimeAgentId: 'agent/a',
      globals: {
        fetch,
        applySessionViewPatch: (patch) => viewPatches.push(patch),
        renderInputRequests() {},
        clearInterruptSuppression() {},
        _markAgentCallStartedForNotify() {},
        _syncPersistentActionButton() {},
        renderAgentList() {},
        poll() {},
        lastRenderedInputSignature: 'old',
      },
    }, async ({ ctx }) => {
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
  });

  it('reports delivery failures without claiming submission success', async () => {
    const toasts = [];
    await withGenUICase({
      runtimeAgentId: 'agent-a',
      globals: {
        fetch: async () => ({
          ok: false,
          status: 409,
          json: async () => ({ message: 'Agent runtime is not accepting input' }),
        }),
        ClawToast: { show: (value) => toasts.push(value) },
      },
    }, async ({ ctx }) => {
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
  });

  it('reuses the model settings dropdown enhancer and shows a local confirmation before dispatch', async () => {
    const dom = createDomHarness();
    dom.createMount('gen-ui-mount');
    const enhancerCalls = [];
    let rendererCallbacks;
    let executed = 0;
    await withGenUICase({
      dom,
      globals: {
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
      },
    }, ({ ctx }) => {
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

  it('marks the mount empty so the empty card aligns with the panel padding contract', async () => {
    const dom = createDomHarness();
    dom.createMount('gen-ui-mount');
    await withGenUICase({
      dom,
      globals: {
        createGenUIViewState: () => ({}),
        renderGenUISpec: (spec) => {
          const rendered = dom.document.createElement('div');
          rendered.className = 'rendered-spec';
          rendered.textContent = spec.title;
          return rendered;
        },
      },
    }, ({ ctx }) => {
      ctx.run(`window.GenUIPanel._internal._applyRegistryUpdate({ surfaces: [
        { surfaceId: 'profile', revision: 1, title: 'Profile', spec: { title: 'Profile' }, closed: false }
      ] })`);

      let mount = dom.document.getElementById('gen-ui-mount');
      assert.equal(mount.classList.contains('is-empty'), false, '非空态不吃 is-empty 修饰');

      ctx.run(`window.GenUIPanel._internal._applyRegistryUpdate({ surfaces: [] })`);

      mount = dom.document.getElementById('gen-ui-mount');
      assert.equal(mount.classList.contains('is-empty'), true, '空态挂 is-empty（垂直 padding 归零，对齐后台任务面板的 24px 契约留白）');
      assert.equal(dom.findAll(mount, '.gen-ui-empty').length, 1, '空态卡照常渲染');
      assert.equal(dom.findAll(mount, '.gen-ui-empty-title')[0].textContent, '暂时没有交互页面');
    });
  });

  it('keeps the GenUIPanel namespace on the kernel bridge for classic consumers', async () => {
    await withGenUICase({}, ({ ctx, module }) => {
      // classic 消费方（agent-data-loader 的 `window.GenUIPanel.forceRefresh()`）
      // 经访问器读到与命名导出同一个对象。
      assert.equal(ctx.run('window.GenUIPanel'), module.GenUIPanel);
      const descriptor = Object.getOwnPropertyDescriptor(ctx, 'GenUIPanel');
      assert.equal(typeof descriptor.get, 'function', '桥键是访问器形态（桥债可计量）');
      assert.equal(descriptor.enumerable, false);
      // claim 之后 classic 写方的赋值经 setter 转发进域模块桥值。
      const replaced = { forceRefresh: () => 'classic-written' };
      ctx.window.GenUIPanel = replaced;
      assert.equal(ctx.run('window.GenUIPanel'), replaced);
    });
  });
});
