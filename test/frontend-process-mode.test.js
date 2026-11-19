import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

/**
 * classic 相：`prepareClassicSandbox` 跑 index.html 的先行脚本整链（boot 体由
 * BOOT_NEUTRALIZER 挡在永不 resolve 的 auth gate 后），图装载期读到的宿主因此
 * 全部是生产实现本身：
 *   app-core      → p2-bootstrap-* 全套（含 context-menu）、call-interrupt、
 *                   runtime-view-cache、侧栏交互态等
 *   runtime-status→ `_agentSuspended` 等 const 容器（sidebar-render 的 host 工厂读它）
 *   session-view-state → commit host
 *   sidebar-render→ 侧栏渲染签名 / call-states / 列表快照三处 host 工厂
 *   app-main      → 轮询协调器（poll-coordinator-host 的宿主工厂）、runtime-switch /
 *                   compact-resume 宿主与 getCurrentAgentRecord
 *   app-ui        → workspace surface 宿主工厂
 * 测试侧不再手写同形桩：宿主工厂契约只存在于生产实现，生产改动因此能被用例发现。
 *
 * 引导细节：语言初值经真实路径进入（app-core 读 localStorage 注册 i18n 桥键）；
 * agents / 焦点经内核桥访问器写入（app-core 已注册真初值的键）——
 * `getCurrentAgentRecord()` 是 app-main 的生产实现，按 focusedAgentId 在 allAgents
 * 里查记录，不在测试里替换成另一份实现。
 */
function loadClassicBootstrap(sandbox, { allAgents = [], currentAgent } = {}) {
  sandbox.localStorage.setItem('agentdev-language', 'zh');
  prepareClassicSandbox(sandbox);
  const agent = currentAgent || allAgents[0] || null;
  if (allAgents.length > 0) sandbox.allAgents = allAgents;
  if (agent) sandbox.focusedAgentId = agent.id;
}

/**
 * 每个用例一份 console 账本：`globals` 同时注入 vm 沙箱与主 realm，classic 相与
 * ESM 图里的裸 `console` 都落在同一对象上。log / info / debug 静音，warn / error
 * 记账（与 test/p2-template-summary-imports.test.js 同口径）。
 */
function createCaseConsole() {
  const warnings = [];
  const errors = [];
  return {
    warnings,
    errors,
    console: {
      ...console,
      log() {},
      info() {},
      debug() {},
      warn: (...args) => warnings.push(args),
      error: (...args) => errors.push(args),
    },
  };
}

/** 用例装载面 = 调用方给的 classic / globals + 噪音账本；收尾断言非预期噪音为空。 */
async function runProcessModeCase(options, fn) {
  const noise = createCaseConsole();
  const value = await withP2EsmCase(
    { ...options, globals: { ...options.globals, console: noise.console } },
    fn,
  );
  assert.deepEqual(noise.warnings, [], '不得产生非预期 console.warn');
  assert.deepEqual(noise.errors, [], '不得产生任何 console.error');
  return value;
}

const fetchStub = (handler) => async (url, options) => {
  handler(url, options);
  return { ok: true, json: async () => ({ ok: true }) };
};

/** 本批被测模块的装载路线：classic 真实 bootstrap 相 + 真实 ESM import。 */
const workspaceSettingsCase = (fetchImpl) => ({
  classic: (sandbox) => loadClassicBootstrap(sandbox, {}),
  globals: { fetch: fetchImpl },
  label: 'workspace-settings',
});


const PH_SETTINGS = 'public/src/modules/ph-settings.js';

/** MINI DOM：设置面板只需要按 id 定位宿主 + 基础元素面。 */
function createSettingsDoc(hostFor) {
  const elements = new Map();
  const makeElement = () => ({
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { return child; },
    removeChild(child) { return child; },
    setAttribute() {},
    getAttribute() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    focus() {},
    remove() {},
  });
  const doc = {
    getElementById(id) {
      if (hostFor) {
        const host = hostFor(id);
        if (host) return host;
      }
      if (!elements.has(id)) elements.set(id, makeElement());
      return elements.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => makeElement(),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {},
    removeEventListener() {},
    body: makeElement(),
    head: makeElement(),
    documentElement: makeElement(),
    activeElement: null,
    readyState: 'complete',
  };
  return doc;
}

/** 面板宿主元素替身（模块会对宿主做 querySelector 探测）。 */
function createHostElement(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { return child; },
    removeChild(child) { return child; },
    replaceChildren() {},
    setAttribute() {},
    getAttribute() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    focus() {},
    remove() {},
  };
}

/** 共享编辑器宿主替身：querySelector 稳定返回同一元素（编辑器按子区渲染）。 */
function createEditorHost() {
  const children = new Map();
  const makeChild = () => ({
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { return child; },
    removeChild(child) { return child; },
    setAttribute() {},
    getAttribute() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    focus() {},
    remove() {},
  });
  return {
    innerHTML: '',
    textContent: '',
    querySelector(selector) {
      if (!children.has(selector)) children.set(selector, makeChild());
      return children.get(selector);
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { return child; },
    removeChild(child) { return child; },
  };
}

/** 面板读的当前 agent（`getCurrentAgentRecord()` 按 focusedAgentId 在 allAgents 里查）。 */
const SETTINGS_AGENT = { id: 'programming-helper', source: 'prebuilt' };

/**
 * ph-settings 用例装载面：真实 classic 链（`loadClassicBootstrap`）+ 真实 ESM import
 * + console 账本。内核桥键在 classic 相注册真初值（生产 app-core 同形），ESM owner
 * 认领后 classic 与 ESM 读写同一份状态。
 */
function withPhSettingsCase({ fetch: fetchImpl, document: doc, allAgents = [], agentId } = {}, fn) {
  const currentAgent = allAgents[0] || SETTINGS_AGENT;
  const fetchDefault = async () => ({ ok: true, json: async () => ({ resourcePolicy: {}, liveRuntimes: {} }) });
  return runProcessModeCase({
    label: 'ph-settings',
    classic: (sandbox) => loadClassicBootstrap(sandbox, {
      allAgents: allAgents.length ? allAgents : [SETTINGS_AGENT],
      currentAgent,
    }),
    globals: {
      fetch: fetchImpl || fetchDefault,
      document: doc || createSettingsDoc(),
    },
  }, async (c) => {
    const settings = await c.load(PH_SETTINGS);
    // 面板身份（原 window.phSettingsAgentId 全局，现为模块 get/set 导出）
    if (agentId) settings.setPhSettingsAgentId(agentId);
    return fn({ c, settings });
  });
}

/** 经真实分发器调用面板动作（模板 data-action 的同一入口）。 */
function invokeSettingsAction(c, name, el) {
  c.window.__actionEl = el;
  return c.read(`window.ClawFW.actions.invoke(${JSON.stringify(name)}, window.__actionEl)`);
}

describe('programming-helper workspace process mode UI', () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it('lists official and optional features with direct config/removal actions', async () => {
    const settingsHost = createHostElement('ph-settings-content');
    const mountsHost = createHostElement('ph-feature-mounts-host');
    await withPhSettingsCase({
      agentId: 'programming-helper',
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
      document: createSettingsDoc((id) => (id === 'ph-feature-mounts-host' ? mountsHost : settingsHost)),
    }, async ({ settings }) => {
      // 公开入口：renderPhSettingsOverlay(agent, presets, { initialTab }) 打开插件页
      settings.renderPhSettingsOverlay({ id: 'programming-helper' }, [], { initialTab: 'feature' });
      await tick();

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
  });

  it('keeps Coder official and mounted features in its assembly view and provides direct config navigation', async () => {
    const resolvedRequests = [];
    const host = createHostElement('ph-settings-content');
    const mountsHost = createHostElement('ph-feature-mounts-host');
    const configHost = createEditorHost();
    await withPhSettingsCase({
      agentId: 'programming-helper',
      fetch: async (url) => {
        const target = String(url);
        if (target.includes('/feature_config/resolved')) {
          resolvedRequests.push(target);
          return { ok: true, status: 200, json: async () => ({ layers: [{ id: 'coder', sparse: {} }], merged: {} }) };
        }
        if (target.includes('/system_feature_manifests')) {
          return { ok: true, status: 200, json: async () => ({ features: [{
            featureName: 'skill',
            manifest: { settings: { properties: { enabled: { type: 'boolean' } } } },
          }], mountedExtras: [] }) };
        }
        if (target.includes('/shell_availability')) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({
          base: { coder: [{ name: 'shell' }, { name: 'skill' }] },
          mounts: { coder: { 'coder-extra': { kind: 'package', package: '@agentdev/coder-extra', version: '1.0.0', missing: false } } },
          envReady: { coder: { hasEnv: true, ready: true } },
        }) };
      },
      document: createSettingsDoc((id) => (id === 'ph-feature-config-host' ? configHost
        : id === 'ph-feature-mounts-host' ? mountsHost : host)),
    }, async ({ c, settings }) => {
      settings.renderPhSettingsOverlay({ id: 'programming-helper' }, [], { initialTab: 'model' });
      // 真实用户路径：点左栏 Coder 页签（data-action="phSettings.switchTab"）
      invokeSettingsAction(c, 'phSettings.switchTab', { dataset: { tab: 'coder' } });
      // 同步断言（fetch 未 resolve 前）：Coder设置页默认落「策略」分页
      assert.match(host.innerHTML, /ph-session-tab active[^>]*data-sub="policy"/);
      assert.match(host.innerHTML, /ph-coder-policy-host/);
      assert.match(host.innerHTML, /data-sub="mounts"/);
      assert.match(host.innerHTML, /data-sub="config"/);
      // 切到功能配置分页后按原断言验收装配清单
      invokeSettingsAction(c, 'phSettings.switchFeatureSubTab', { dataset: { sub: 'mounts' } });
      await tick();
      assert.match(host.innerHTML, /data-tab="coder"/);
      assert.match(host.innerHTML, /data-tab="feature"/);
      assert.match(host.innerHTML, /data-sub="mounts"/);
      assert.match(host.innerHTML, /data-sub="config"/);
      assert.match(mountsHost.innerHTML, /data-name="shell"/);
      assert.match(mountsHost.innerHTML, /data-name="skill"/);
      assert.match(mountsHost.innerHTML, /data-name="coder-extra"/);
      assert.match(mountsHost.innerHTML, /data-action="phSettings\.removeMountFeature" data-identity="coder" data-name="coder-extra"/);
      assert.doesNotMatch(mountsHost.innerHTML, /data-action="phSettings\.removeMountFeature" data-identity="coder" data-name="shell"/);
      // 点某一项齿轮：进入配置分页并以该 Feature 打开共享编辑器（真实编辑器实例）
      invokeSettingsAction(c, 'phSettings.openFeatureConfig', { dataset: { name: 'skill' } });
      // 共享编辑器异步加载 resolved / manifest：轮询到编辑器左栏落地（上限 20 tick）
      const navEl = configHost.querySelector('[data-fce-nav]');
      const mainEl = configHost.querySelector('[data-fce-main]');
      for (let i = 0; i < 20 && /fs-nav-loading|^\s*$/.test(String(navEl.innerHTML)); i += 1) await tick();
      assert.match(String(configHost.innerHTML), /fs-editor-body/, 'config page mounts the shared editor');
      assert.match(String(navEl.innerHTML), /skill/i, 'editor lists the chosen feature section');
      assert.ok(String(mainEl.innerHTML).length > 0, 'feature section body rendered');
      // 编辑器按 Coder 身份层解析配置（点击项来自 Coder 装配清单）
      assert.ok(
        resolvedRequests.some((url) => url.includes('agentId=coder')),
        'editor resolves the coder identity layer',
      );
    });
  });

  // ── 覆盖说明（如实记录）──────────────────────────────────────────────
  // ph-settings 里 `coder-policy` / `process` / `container-images` → 新页签的归一
  // 分支读的是模块私有 `_phSettingsTab`；公开渲染入口
  // `renderPhSettingsOverlay(agent, presets, { initialTab })` 只接受
  // model / feature / coder，legacy 键既无公开 setter 也无持久化写入方，因此在当前
  // 代码里**没有公开可达路径**。下面三条用例覆盖的是用户可见事实——旧独立页签已
  // 消失、对应内容并入新页签的相应分页——而不是归一分支本身。
  // 已知缺口：归一分支本身零覆盖（待业务侧清理死代码或补公开入口）；不为此伪造
  // 私有状态，也不为测试扩生产 API。

  it('renders Coder policy inside the Coder agent page (legacy coder-policy tab is gone)', async () => {
    const host = createHostElement('ph-settings-content');
    await withPhSettingsCase({
      agentId: 'programming-helper',
      document: createSettingsDoc(() => host),
    }, async ({ settings }) => {
      settings.renderPhSettingsOverlay({ id: 'programming-helper' }, [], { initialTab: 'coder' });
      // 左栏旧「Coder 策略」独立页签消失，内容并入 Coder设置页策略分页
      assert.match(host.innerHTML, /Coder设置/);
      assert.doesNotMatch(host.innerHTML, /data-tab="coder-policy"/);
      assert.match(host.innerHTML, /ph-coder-policy-host/);
      assert.match(host.innerHTML, /ph-session-tab active[^>]*data-sub="policy"/);
      assert.doesNotMatch(host.innerHTML, /编程小助手.*并发上限/);
    });
  });

  it('renders process mode in the runtime page local sub-tab (legacy process tab is gone)', async () => {
    const host = createHostElement('ph-settings-content');
    await withPhSettingsCase({
      agentId: 'programming-helper',
      document: createSettingsDoc(() => host),
    }, async ({ c, settings }) => {
      settings.renderPhSettingsOverlay({ id: 'programming-helper' }, [], { initialTab: 'model' });
      invokeSettingsAction(c, 'phSettings.switchTab', { dataset: { tab: 'runtime' } });
      // 旧「进程模式」「容器镜像」独立页签消失，合并为「运行环境」页
      assert.match(host.innerHTML, /data-tab="runtime"[^>]*>.*运行环境/);
      assert.doesNotMatch(host.innerHTML, /data-tab="process"/);
      assert.doesNotMatch(host.innerHTML, /data-tab="container-images"/);
      // 进程模式卡片渲染在本地运行设置分页（默认 active）
      assert.match(host.innerHTML, /ph-session-tab active[^>]*data-sub="local"/);
      assert.match(host.innerHTML, /ph-pm-card/);
    });
  });

  it('renders container images in the runtime page container sub-tab (legacy container-images tab is gone)', async () => {
    const containerRequests = [];
    const host = createHostElement('ph-settings-content');
    await withPhSettingsCase({
      agentId: 'programming-helper',
      fetch: async (url) => {
        containerRequests.push(String(url));
        return { ok: true, json: async () => ({ images: [], containers: [], envReady: {} }) };
      },
      document: createSettingsDoc(() => host),
    }, async ({ c, settings }) => {
      settings.renderPhSettingsOverlay({ id: 'programming-helper' }, [], { initialTab: 'model' });
      invokeSettingsAction(c, 'phSettings.switchTab', { dataset: { tab: 'runtime' } });
      invokeSettingsAction(c, 'phSettings.switchRuntimeSubTab', { dataset: { sub: 'container' } });
      // 容器观测面板渲染在容器运行设置分页
      assert.match(host.innerHTML, /ph-session-tab active[^>]*data-sub="container"/);
      assert.match(host.innerHTML, /ph-container-images-host/);
      // 挂载完成证据：分页进入即由容器镜像模块发起概览读取（真实 direct import 链路）
      assert.ok(
        containerRequests.some((url) => url.includes('/protoclaw/container_images')),
        'container images panel load kicked off for the container sub-tab',
      );
    });
  });

  it('renders the server-provided workspace mode without consulting a project key', async () => {
    const host = createHostElement('ph-settings-content');
    await withPhSettingsCase({
      agentId: 'programming-helper',
      allAgents: [{ id: 'programming-helper', processMode: 'shared-global' }],
      document: createSettingsDoc(() => host),
    }, async ({ c, settings }) => {
      settings.renderPhSettingsOverlay({ id: 'programming-helper', processMode: 'shared-global' }, [], { initialTab: 'model' });
      // 用户路径：点「运行环境」页签，进程模式卡片按服务端 processMode 高亮
      invokeSettingsAction(c, 'phSettings.switchTab', { dataset: { tab: 'runtime' } });
      assert.match(host.innerHTML, /ph-pm-card active[^>]*data-action="phSettings\.setProcessMode" data-mode="shared-global"/);
      assert.doesNotMatch(host.innerHTML, /localStorage/);
    });
  });

  it('saves Coder runtime policy through the same workspace-settings endpoint', async () => {
    const requests = [];
    await withPhSettingsCase({
      fetch: async (url, options) => {
        requests.push({ url, options });
        if (!options) return { ok: true, json: async () => ({ resourcePolicy: {}, liveRuntimes: {} }) };
        return { ok: true, json: async () => ({ ok: true }) };
      },
    }, async ({ c }) => {
      await invokeSettingsAction(c, 'phSettings.saveCoderThreadLimit', { value: '4' });
    });

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
    await runProcessModeCase(workspaceSettingsCase(fetchStub((url, options) => requests.push({ url, options }))), async (c) => {
      // workspace-settings.js 已迁 ESM：经真实 import 取命名导出（原 window 全局
      // 引用面同一实现），classic 相只提供 bootstrap 宿主与被覆盖的 action 注册面。
      const settings = await c.load('public/src/modules/workspace-settings.js');
      await settings.onWorkspaceQuotaChange('coder', '4');
    });

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
    await withPhSettingsCase({
      fetch: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, json: async () => ({ ok: true }) };
      },
    }, async ({ c }) => {
      await invokeSettingsAction(c, 'phSettings.saveCoderThreadLimit', { value: '1.5' });
    });

    assert.equal(requests.length, 0);
  });

  it('renders the rotation-strategy cards with the user override active', async () => {
    const host = createHostElement('ph-settings-content');
    await withPhSettingsCase({
      allAgents: [{ id: 'coder', permissionDefaults: { contextRotationStrategy: 'adaptive' } }],
      fetch: async () => ({
        ok: true,
        json: async () => ({ resourcePolicy: { coder: { contextRotationStrategy: 'trim' } }, liveRuntimes: {} }),
      }),
      document: createSettingsDoc(() => host),
    }, async ({ settings }) => {
      settings.renderPhSettingsOverlay({ id: 'programming-helper' }, [], { initialTab: 'coder' });
      await tick();
      await tick();

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
      assert.match(host.innerHTML, /同时运行的 runtime 数量上限/);
      assert.match(host.innerHTML, /自动接续新会话所采用的精简方式/);
      assert.doesNotMatch(host.innerHTML, /即时生效/);
      // 并发上限行仍在同一分页
      assert.match(host.innerHTML, /线程并发上限/);
    });
  });

  it('falls back to the author default when no user override is stored', async () => {
    const host = createHostElement('ph-settings-content');
    await withPhSettingsCase({
      allAgents: [{ id: 'coder', permissionDefaults: { contextRotationStrategy: 'adaptive' } }],
      fetch: async () => ({
        ok: true,
        json: async () => ({ resourcePolicy: {}, liveRuntimes: {} }),
      }),
      document: createSettingsDoc(() => host),
    }, async ({ settings }) => {
      settings.renderPhSettingsOverlay({ id: 'programming-helper' }, [], { initialTab: 'coder' });
      await tick();
      await tick();

      assert.match(host.innerHTML, /ph-pm-card active[^>]*data-action="phSettings\.setCoderRotationStrategy" data-mode="adaptive"/);
    });
  });

  it('saves the rotation strategy through the workspace resource-policy endpoint', async () => {
    const requests = [];
    const host = createHostElement('ph-settings-content');
    await withPhSettingsCase({
      fetch: async (url, options) => {
        requests.push({ url, options });
        if (!options) return { ok: true, json: async () => ({ resourcePolicy: {}, liveRuntimes: {} }) };
        return { ok: true, json: async () => ({ ok: true }) };
      },
      document: createSettingsDoc(() => host),
    }, async ({ c, settings }) => {
      settings.renderPhSettingsOverlay({ id: 'programming-helper' }, [], { initialTab: 'coder' });
      await tick();
      await invokeSettingsAction(c, 'phSettings.setCoderRotationStrategy', { dataset: { mode: 'summary' } });
    });

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
    const host = createHostElement('ph-settings-content');
    await withPhSettingsCase({
      fetch: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, json: async () => ({ ok: true }) };
      },
      document: createSettingsDoc(() => host),
    }, async ({ c, settings }) => {
      settings.renderPhSettingsOverlay({ id: 'programming-helper' }, [], { initialTab: 'coder' });
      await tick();
      await invokeSettingsAction(c, 'phSettings.setCoderRotationStrategy', { dataset: { mode: 'bogus' } });
    });

    // 旧断言是「一个请求都不发」；新链路需先经公开入口打开 Coder 页，面板装载本身
    // 会发 `/protoclaw/workspace_settings` 的 GET（无 options）。因此断言收窄为
    // **不发出任何写请求**——这才是「非法档位不提交」的业务语义（改前是断言范围更大
    // 但依赖“未渲染面板”这一非语义前提）。
    assert.equal(requests.filter((request) => request.options?.method === 'PUT').length, 0);
  });

  it('persists the selection through the workspace-level server endpoint', async () => {
    const requests = [];
    // 真实的编程小助手工作区记录形状（isPhStyleWorkspaceAgent 判据含 source）；
    // 归属身份 / 逻辑 id / 当前记录全部走 app-core / app-main 的生产实现。
    const agent = { id: 'programming-helper', source: 'prebuilt', processMode: 'shared-by-project' };
    await runProcessModeCase({
      label: 'ph-project-actions',
      classic: (sandbox) => {
        loadClassicBootstrap(sandbox, { allAgents: [agent], currentAgent: agent });
        // 渲染效果出口：本用例只关心写请求与记录落地，主视图重渲是副作用
        // （与 test/p2-template-summary-imports.test.js 同口径，只记录不执行）。
        sandbox.renderCurrentMainView = () => {};
      },
      globals: {
        fetch: async (url, options) => {
          requests.push({ url, options });
          return {
            ok: true,
            json: async () => ({ ok: true, agentId: 'programming-helper', processMode: 'shared-global' }),
          };
        },
        document: createSettingsDoc(),
      },
    }, async (c) => {
      const projectActions = await c.load('public/src/modules/ph-project-actions.js');
      await projectActions.phSetProcessMode('shared-global');
    });

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

describe('多 feature 包的 feature 级开关（ADR-0052）', () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it('渲染 feature chip 与禁用态，点击切换写 $mount.disabledFeatures', async () => {
    const settingsHost = createHostElement('ph-settings-content');
    const mountsHost = createHostElement('ph-feature-mounts-host');
    const puts = [];
    await withPhSettingsCase({
      agentId: 'programming-helper',
      fetch: async (url, options = {}) => {
        const target = String(url);
        if (options.method === 'PUT') {
          puts.push(JSON.parse(options.body));
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        if (target.includes('/feature_config/resolved')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              layers: [
                { id: 'global', sparse: {} },
                { id: 'agent', sparse: { 'multi-demo': { $mount: { package: '@demo/multi', version: '1.0.0', disabledFeatures: ['beta'] } } } },
              ],
              merged: {},
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            base: { main: [] },
            packages: [{
              package: '@demo/multi', scopeAgentId: null, displayName: 'Multi', description: '多 feature 示例',
              versions: [{ version: '1.0.0' }],
            }],
            mounts: {
              main: {
                'multi-demo': {
                  kind: 'repository', package: '@demo/multi', version: '1.0.0', missing: false, featureCount: 2,
                  features: [{ name: 'alpha', disabled: false }, { name: 'beta', disabled: true }],
                },
              },
            },
            envReady: { main: { hasEnv: true, ready: true } },
          }),
        };
      },
      document: createSettingsDoc((id) => (id === 'ph-feature-mounts-host' ? mountsHost : settingsHost)),
    }, async ({ c, settings }) => {
      settings.renderPhSettingsOverlay({ id: 'programming-helper' }, [], { initialTab: 'feature' });
      await tick();

      assert.match(mountsHost.innerHTML, /data-action="phSettings\.toggleMountFeature"/);
      assert.match(mountsHost.innerHTML, /data-feature="alpha"/);
      assert.match(mountsHost.innerHTML, /beta · 已禁用/);

      invokeSettingsAction(c, 'phSettings.toggleMountFeature', {
        dataset: { identity: 'main', mount: 'multi-demo', feature: 'alpha' },
      });
      await tick();

      const put = puts.find((body) => body?.layerId === 'agent');
      assert.ok(put, '应写回 agent 层声明');
      assert.deepEqual(put.content['multi-demo'].$mount.disabledFeatures, ['beta', 'alpha']);
      assert.equal(put.content['multi-demo'].$mount.package, '@demo/multi');
    });
  });
});
