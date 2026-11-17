/**
 * P2 长尾批次：input-model-switcher 整域迁移的收尾断言。
 *
 * 三件本批特有、其它三个行为测试不覆盖的事：
 *   1. **导出面 / 全局面**：整域迁 ESM 后只有 5 个命名导出，跨文件兼容面就是
 *      4 个 KernelState 桥键 + `ClawFW.getThinkingEffortOptions` 命名空间协议；
 *      原 classic 的私有 helper 与状态不再出现在 window 上（台账消失的机器证据）。
 *   2. **已迁依赖一律 import**：把 `window.ClawToast` /
 *      `window.ClawFeatureCommunication` / 预设缓存四个 classic 兼容键换成毒桩，
 *      真实下拉与切换链路照常工作——证明本域读的是 import 绑定而不是 window。
 *   3. **R1/R2 时序前提**：首屏冷态那条同步链（app-ui 无条件调用
 *      `notifyInputSurfaceChanged` → `renderInputRequests`）在模块**未装载**时
 *      照常短路到 hidden 分支；一旦这条链开始触达 `update*Switcher`，本用例
 *      会以 ReferenceError 变红（这正是「不许延后首屏」的回归护栏）。
 *
 * 装载路线：withP2EsmCase 的真实 classic 沙箱 + `c.load` 真实 import 图。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { sourceBetween } from './helpers/frontend-vm.js';

const MODULE = 'public/src/modules/input-model-switcher.js';
const PRESET_CACHE = 'public/src/modules/model-preset-cache.js';
const TOAST = 'public/src/modules/toast-notify.js';

const DECLARED_CHANNELS = [{ featureId: 'model-selection', channelId: 'selection' }];
const PRESETS = [{ name: 'a', thinkingEffort: 'low' }, { name: 'b', thinkingEffort: 'low' }];

function createElement(tag = '') {
  const classes = new Set();
  const listeners = {};
  return {
    tagName: String(tag).toUpperCase(),
    innerHTML: '',
    textContent: '',
    title: '',
    style: {},
    dataset: {},
    offsetHeight: 40,
    isConnected: false,
    children: [],
    listeners,
    classList: {
      add(value) { classes.add(value); },
      remove(value) { classes.delete(value); },
      contains(value) { return classes.has(value); },
    },
    addEventListener(type, listener) { listeners[type] = listener; },
    removeEventListener(type) { delete listeners[type]; },
    remove() { this.isConnected = false; },
    contains() { return false; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 100, top: 200, bottom: 230 }; },
  };
}

function createDocument() {
  const modelLabel = createElement('span');
  const effortLabel = createElement('span');
  const modelButton = createElement('button');
  const effortButton = createElement('button');
  const inputContainer = createElement('div');
  const choiceContainer = createElement('div');
  const chatContainer = createElement('div');
  const body = createElement('body');
  body.nodes = [];
  body.appendChild = (node) => { node.isConnected = true; body.nodes.push(node); return node; };
  body.contains = () => true;

  const byId = new Map([
    ['input-model-switch-btn', modelButton],
    ['input-thinking-btn', effortButton],
    ['user-input-container', inputContainer],
    ['choice-input-container', choiceContainer],
    ['chat-container', chatContainer],
  ]);
  const bySelector = new Map([
    ['.input-model-name', modelLabel],
    ['.input-thinking-name', effortLabel],
  ]);
  return {
    modelLabel,
    effortLabel,
    inputContainer,
    choiceContainer,
    body,
    menus: () => body.nodes.filter((node) => node.className === 'ccb-model-dropdown'),
    getElementById: (id) => byId.get(id) || null,
    querySelector: (selector) => bySelector.get(selector) || null,
    querySelectorAll: () => [],
    createElement: (tag) => createElement(tag),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {},
    removeEventListener() {},
    documentElement: createElement('html'),
    head: createElement('head'),
    activeElement: null,
    hidden: false,
    readyState: 'complete',
  };
}

function jsonResponse(payload, ok = true, status = 200) {
  return { ok, status, json: async () => payload };
}

function settle() {
  return new Promise((resolve) => { setImmediate(resolve); });
}

/** 真实图需要的平台面（markdown-utils / renderer / 预置库）。 */
function classicGlobals(doc, fetchImpl) {
  return {
    document: doc,
    fetch: fetchImpl,
    renderer: { options: {} },
    escapeHtml: (text) => String(text ?? '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[m]),
    marked: { Renderer: class { constructor() {} }, setOptions() {}, parse: () => '' },
    hljs: { getLanguage: () => null, highlight: () => ({ value: '' }) },
  };
}

/** 生产 classic 前缀（与 index.html 同序的关键段）。 */
function loadClassicPrefix(sandbox) {
  sandbox.loadSource('public/src/modules/action-dispatcher.js');
  // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
  sandbox.loadSource('public/src/app-core.js');
  sandbox.loadSource('public/src/modules/session-view-state.js');
}

/** 一个完整落库的切换网络面：channels → getStatus → presets → selectModel。 */
function createSwitchNetwork(requests) {
  return async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith('/protoclaw/feature-comms/channels')) {
      return jsonResponse({ ok: true, channels: DECLARED_CHANNELS });
    }
    if (target === '/protoclaw/feature-comms/request') {
      const body = JSON.parse(init.body);
      requests.push(body);
      const result = body.requestType === 'getStatus'
        ? { ok: true, choice: { presetName: 'a' } }
        : { ok: true, meta: { modelRevision: 2, presetName: 'b', modelName: 'b-model', thinkingEffort: 'low' } };
      return jsonResponse({ ok: true, result });
    }
    if (target.startsWith('/protoclaw/model_config')) {
      return jsonResponse({ config: {}, presets: PRESETS });
    }
    throw new Error('非预期网络请求：' + target);
  };
}

test('导出面与全局面：只有域公开接口，私有 helper / 状态不上 window', async () => {
  const doc = createDocument();
  await withP2EsmCase({
    classic: loadClassicPrefix,
    globals: classicGlobals(doc, createSwitchNetwork([])),
  }, async (c) => {
    const mod = await c.load(MODULE);
    assert.deepEqual(
      Object.keys(mod).sort(),
      [
        'getThinkingEffortOptions',
        'toggleInputModelDropdown',
        'toggleThinkingEffortDropdown',
        'updateInputModelSwitcher',
        'updateThinkingEffortSwitcher',
      ],
      '不为测试扩大导出面（_perform* / 私有 helper 一律不导出）',
    );
    for (const key of [
      '_performInputModelSwap',
      '_performThinkingEffortSwap',
      '_ensureModelSelectionChannel',
      '_getCurrentThinkingEffort',
      '_getCurrentPresetProtocol',
      '_getInputDefaultPresetName',
      '_modelSelectionTarget',
      '_inputModelDropdown',
      '_inputModelDropdownLoading',
      '_inputThinkingDropdown',
      '_modelSelectionChannelOk',
      '_restoreFailureNotified',
      'OPENAI_EFFORT_LABELS',
      'ANTHROPIC_EFFORT_LABELS',
    ]) {
      assert.equal(c.read(`typeof window.${key}`), 'undefined', `${key} 不得留在 window 上`);
      assert.equal(mod[key], undefined, `${key} 不得出现在模块导出面`);
    }
    // 桥键是访问器（不是散装赋值），可配置以便终局撤除
    for (const key of ['updateInputModelSwitcher', 'updateThinkingEffortSwitcher',
      'toggleInputModelDropdown', 'toggleThinkingEffortDropdown']) {
      const descriptor = c.read(`Object.getOwnPropertyDescriptor(window, '${key}')`);
      assert.equal(typeof descriptor.get, 'function', `${key} 由访问器提供`);
      assert.equal(descriptor.enumerable, false, `${key} 不可枚举`);
      assert.equal(descriptor.configurable, true, `${key} 可配置（终局 delete 撤桥）`);
    }
    // 命名空间协议形状不变（跨 realm 数组用展开取回本 realm 形态）
    assert.deepEqual([...c.read('window.ClawFW.getThinkingEffortOptions("openai")')],
      ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  });
});

test('已迁依赖一律 import：毒化 window 兼容面不影响真实切换链路', async () => {
  const doc = createDocument();
  const requests = [];
  await withP2EsmCase({
    classic: loadClassicPrefix,
    globals: classicGlobals(doc, createSwitchNetwork(requests)),
  }, async (c) => {
    const mod = await c.load(MODULE);
    const toast = await c.load(TOAST);
    const presetCache = await c.load(PRESET_CACHE);
    const toasts = [];
    toast.ClawToast.show = (value) => { toasts.push(value); };
    toast.ClawToast.update = (id, patch) => { toasts.push({ ...patch, id }); };

    c.read(`currentRuntimeAgentId = 'rt-1'; focusedAgentId = 'host-agent';`);
    c.read(`applySessionViewPatch({ identity: { agentId: 'host-agent', sessionId: 'sess-1' } })`);
    c.window.payload = { modelRevision: 1, presetName: 'a', modelName: 'a-model', thinkingEffort: 'low' };
    c.read('applySessionViewPatch({ overview: payload })');

    // 毒桩：任何经 window 兜底的路径都会立刻炸成预期外错误。
    c.read(`window.ClawToast = { show() { throw new Error('window.ClawToast.show 被调用'); },
      update() { throw new Error('window.ClawToast.update 被调用'); } }`);
    c.read(`window.ClawFeatureCommunication = { listChannels() { throw new Error('window.ClawFeatureCommunication 被调用'); },
      request() { throw new Error('window.ClawFeatureCommunication 被调用'); } }`);
    c.read(`window.getClawModelPresets = () => { throw new Error('window.getClawModelPresets 被调用'); }`);
    c.read(`window.clawModelPresetsMatchSession = () => { throw new Error('window.clawModelPresetsMatchSession 被调用'); }`);
    c.read(`window.ensureClawModelPresetsForSession = async () => { throw new Error('window.ensureClawModelPresetsForSession 被调用'); }`);

    await mod.toggleInputModelDropdown();
    assert.equal(doc.menus().length, 1, '真实模块经 import 的通道查询打开菜单');
    const menu = doc.menus().at(-1);
    menu.listeners.click({ target: { closest: (selector) => (selector === '.ccb-md-item' ? { dataset: { preset: 'b' } } : null) } });
    await settle();

    const selectCalls = requests.filter((body) => body.requestType === 'selectModel');
    assert.equal(selectCalls.length, 1, '请求面走 import 的 feature-communication');
    assert.deepEqual(selectCalls[0].payload, { presetName: 'b' });
    assert.equal(toasts.at(-1)?.title, '模型已切换', 'toast 走 import 的 toast-notify');
    assert.equal(presetCache.clawModelPresetsMatchSession('rt-1'), true,
      '预设表走 import 的缓存 owner（会话标记是 owner 模块私有状态，不经 ClawFW 袋）');
    assert.equal(c.read('readCurrentSessionViewState().overview.presetName'), 'b', '回执经会话视图提交落地');
    assert.equal(doc.modelLabel.textContent, 'b');
    assert.equal(presetCache.getClawModelPresets().length, PRESETS.length, '缓存由 owner 提供，不经 window 函数');
  });
});

test('ClawFW.getThinkingEffortOptions 可写性与内部路径独立性', async () => {
  const doc = createDocument();
  await withP2EsmCase({
    classic: loadClassicPrefix,
    globals: classicGlobals(doc, createSwitchNetwork([])),
  }, async (c) => {
    const mod = await c.load(MODULE);
    // 可写性：既有消费方（ph-settings / memo 插件）按命名空间读，classic 侧可替换
    const descriptor = c.read(`Object.getOwnPropertyDescriptor(window.ClawFW, 'getThinkingEffortOptions')`);
    assert.equal(descriptor.writable, true, '命名空间协议保持可写（既有消费方的替换语义不变）');
    c.read(`window.ClawFW.getThinkingEffortOptions = () => ['poisoned']`);
    assert.deepEqual([...c.read('window.ClawFW.getThinkingEffortOptions("openai")')], ['poisoned']);
    // 模块内部档位表不经 window 往返：下拉仍是真实 openai/anthropic 档位
    c.read(`currentRuntimeAgentId = 'rt-1'; focusedAgentId = 'host-agent';`);
    c.read(`applySessionViewPatch({ identity: { agentId: 'host-agent', sessionId: 'sess-1' } })`);
    c.window.payload = { modelRevision: 1, presetName: 'a', modelName: 'a-model', provider: 'openai', thinkingEffort: 'low' };
    c.read('applySessionViewPatch({ overview: payload })');
    await mod.toggleThinkingEffortDropdown();
    const menu = doc.menus().at(-1);
    assert.ok(menu, '思考强度菜单打开');
    assert.match(menu.innerHTML, /data-effort="minimal"/);
    assert.doesNotMatch(menu.innerHTML, /poisoned/);
    assert.deepEqual(mod.getThinkingEffortOptions('openai'), ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  });
});

test('首屏冷态：模块未装载时真实输入面声明链照常短路（R1/R2 护栏）', async () => {
  const doc = createDocument();
  await withP2EsmCase({
    classic: (sandbox) => {
      loadClassicPrefix(sandbox);
      // voice-input 已迁 ESM（P4 L3）：本用例只钉冷态声明链的短路，语音实现不在
      // 断言面内，classic 相不再载入（其 ESM 图会额外拉入输入动作宿主链）。
      sandbox.loadSource('public/src/modules/input-composer.js');
      // rollback-dialog / input-render 已迁 ESM（P4 T2）：在 async 相按
      // 「注册壳 → 渲染入口」顺序 c.load，见下方用例体首段。
      // input-render 经 `getInputSurfaceMode` 求模式；该函数是 app-main 的 classic
      // 实现（整份 app-main 会拉起启动链），此处只注入**真实的**那一段源码。
      const appMain = readFileSync(new URL('../public/src/app-main.js', import.meta.url), 'utf8');
      sandbox.run(sourceBetween(appMain, 'function getInputSurfaceMode(', '// ── Sidebar rendering'));
    },
    globals: {
      ...classicGlobals(doc, createSwitchNetwork([])),
      // 冷态（无 runtime / 无 thread await target / 非只读）下这条链用到的宿主面：
      isChatSurfaceActive: () => true,
      notifyChatViewportMutation() {},
      rebindQueueProjectionForRuntime() {},
      // 隐藏分支把 DOM 清理包在「抑制聊天视口观察者」里；观察器属视口域
      // （chat-viewport.js），本用例只关心分支走向，注入直通实现。
      runWithSuppressedChatViewportObservers: (fn) => fn(),
      _getSessionInputCacheKey: () => '',
      // 语音保留判定由 voice-input（ESM，P4 L3）经桥键提供；本用例不装载语音实现，
      // 按冷态（无录音、无转写）语义给出同形的 false。
      _shouldPreserveVoiceInputForRender: () => false,
      followLatestEnabled: false,
    },
  }, async (c) => {
    // rollback-dialog 注册壳先求值（回退 / 压缩域状态键的 window 访问器），
    // 再装 input-render 的真实实现；两者都是 ESM 相真实 import。
    await c.load('public/src/modules/rollback-dialog.js');
    // 跟随开关是 app-core 的 classic 顶层状态（未上桥），模块经 chatSurface
    // 宿主适配读取；用例按同一 seam 置 false（原用例以同名全局桩代替）。
    c.window.createP2BootstrapChatSurfaceHost().followLatestEnabled = false;
    await c.load('public/src/modules/input-render.js');
    // 本用例**刻意不装载** input-model-switcher：首屏同步相里它还不存在。
    assert.equal(c.read('typeof window.updateInputModelSwitcher'), 'undefined');
    assert.equal(c.read('typeof window.updateThinkingEffortSwitcher'), 'undefined');
    // app-ui 首屏无条件执行的正是这一句（renderCurrentMainView 结构性时机）。
    assert.doesNotThrow(() => c.read('notifyInputSurfaceChanged([])'));
    assert.equal(doc.menus().length, 0);
    assert.equal(doc.inputContainer.children.length, 0, '冷态隐藏分支不渲染 composer');
  });
});
