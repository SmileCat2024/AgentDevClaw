/**
 * 输入区模型/思考档位切换的状态提交与呈现（P2 真实 ESM 图路线）。
 *
 * 装载路线：classic 相跑真实生产源（action-dispatcher / i18n / app-core /
 * session-view-state 提供会话视图提交与身份、chat-context-bar 是顶栏/详情渲染），
 * input-model-switcher 已迁 ESM，经 `withP2EsmCase` + `c.load` 真实 import；
 * 其依赖的已迁模块（overview-data / model-preset-cache / feature-communication /
 * toast-notify / session-view-commit-host / orchestration-state）沿 import 链
 * 一并真实求值——预设表、channel 查询、feature 请求全部走**真实模块实现**，
 * 只在 `fetch` 这一层换成契约桩。每个用例一张独立模块图。
 *
 * 交互面：不再直调私有 helper（`_performInputModelSwap` / `_ensureModelSelectionChannel`
 * / `_getCurrentThinkingEffort` 零跨文件消费，按配方保持模块私有）。切换一律经
 * **真实下拉菜单**：`toggleInputModelDropdown()` 打开 → 点击菜单项 → 处理器内部
 * 发请求 / 提交 / toast；断言面是按钮文案、顶栏与 toast 的真实输出。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { BasicAgent } from '@agentdevjs/core';
import { ModelSelectionFeature } from '../local-features/dist/model-selection/src/index.js';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { sourceBetween } from './helpers/frontend-vm.js';

const MODULE = 'public/src/modules/input-model-switcher.js';
const CONTEXT_BAR = 'public/src/modules/chat-context-bar.js';
const OVERVIEW_DATA = 'public/src/modules/overview-data.js';
const PRESET_CACHE = 'public/src/modules/model-preset-cache.js';
const TOAST = 'public/src/modules/toast-notify.js';
const ORCHESTRATION = 'public/src/modules/orchestration-state.js';

// 真实状态写入入口 + 切换请求 + 顶栏/详情渲染，隔离网络和用户数据。
const model = (modelRevision, name, extra = {}) => ({
  modelRevision, presetName: name, modelName: name + '-model',
  thinkingEffort: 'low', provider: 'anthropic', contextLength: 200000, compressRatio: 80,
  ...extra,
});

const DEFAULT_PRESETS = ['a', 'b', '__default__'].map((name) => ({ name, thinkingEffort: 'low' }));
const DECLARED_CHANNELS = [{ featureId: 'model-selection', channelId: 'selection' }];

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

/**
 * 用例 DOM：四个切换器节点 + 顶栏节点，body 记录被追加的下拉菜单
 * （菜单是否真的挂载就是「下拉是否打开」的可观测事实，替代旧的私有状态读取）。
 */
function createDocument() {
  const modelLabel = createElement('span');
  const effortLabel = createElement('span');
  const modelButton = createElement('button');
  const effortButton = createElement('button');
  const bar = createElement('div');
  const body = createElement('body');
  body.nodes = [];
  body.appendChild = (node) => {
    node.isConnected = true;
    body.nodes.push(node);
    return node;
  };
  body.contains = () => true;

  const byId = new Map([
    ['chat-context-bar', bar],
    ['input-model-switch-btn', modelButton],
    ['input-thinking-btn', effortButton],
  ]);
  const bySelector = new Map([
    ['.input-model-name', modelLabel],
    ['.input-thinking-name', effortLabel],
  ]);
  return {
    bar,
    modelLabel,
    effortLabel,
    modelButton,
    effortButton,
    body,
    // 真实挂到 body 上的选择菜单（按 className 归属，顶栏气泡不算）
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

/** 让已发出但未 await 的处理器续体跑完（只走微任务 / setImmediate）。 */
function settle() {
  return new Promise((resolve) => { setImmediate(resolve); });
}

/**
 * feature-comms + model_config 的契约桩：URL / 方法 / body 与真实
 * feature-communication、model-preset-cache 发出的完全一致。未知 URL 直接抛错
 * （非预期网络立刻可见，不做静默兜底）。
 */
function createNetwork({ channels = DECLARED_CHANNELS, presets = DEFAULT_PRESETS } = {}) {
  const state = {
    channels,
    presets,
    channelHandler: null, // () => Promise<response>
    presetHandler: null, // (url) => Promise<response>
    requestHandler: null, // (body) => Promise<response>
    featureResult: { ok: true, meta: model(1, 'a') },
    statusResult: { ok: true, choice: { presetName: 'a' } },
  };
  const calls = [];
  const fetchStub = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, method: init.method || 'GET', body: init.body });
    if (target.startsWith('/protoclaw/feature-comms/channels')) {
      return state.channelHandler ? state.channelHandler(target) : jsonResponse({ ok: true, channels: state.channels });
    }
    if (target === '/protoclaw/feature-comms/request') {
      const body = JSON.parse(init.body);
      if (state.requestHandler) return state.requestHandler(body);
      const result = body.requestType === 'getStatus' ? state.statusResult : state.featureResult;
      return jsonResponse({ ok: true, result });
    }
    if (target.startsWith('/protoclaw/model_config')) {
      return state.presetHandler ? state.presetHandler(target) : jsonResponse({ config: {}, presets: state.presets });
    }
    throw new Error('非预期网络请求：' + target);
  };
  const requests = () => calls
    .filter((call) => call.url === '/protoclaw/feature-comms/request')
    .map((call) => JSON.parse(call.body));
  const requestTypes = () => requests().map((body) => body.requestType);
  return { state, calls, fetchStub, requests, requestTypes };
}

/** 一个用例 = 一张独立模块图 + 真实 classic 输入面宿主。 */
async function withSandbox(fn, { presets = DEFAULT_PRESETS, channels = DECLARED_CHANNELS } = {}) {
  const doc = createDocument();
  const net = createNetwork({ presets, channels });
  const logs = [];
  const expectedLogs = [];

  await withP2EsmCase({
    globals: {
      getCurrentHostAgentRecord: () => ({ id: 'host-agent' }),
      getActiveWorkspaceSessionId: () => 'sess-1',
      getRuntimeAwareAgentRecord: () => ({ id: 'host-agent' }),
      formatPresetDisplayName: (name) => name,
      shouldRenderWorkspaceSurface: () => false,
      isChatSurfaceActive: () => true,
      notifyChatViewportMutation() {},
      followLatestEnabled: false,
      container: { scrollTop: 0 },
      document: doc,
      fetch: net.fetchStub,
      // markdown-utils（escapeHtml / renderer 的 ESM owner）求值期读取的经典库面
      renderer: { options: {} },
      escapeHtml: (text) => String(text ?? '').replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[m]),
      marked: { Renderer: class { constructor() {} }, setOptions() {}, parse: () => '' },
      hljs: { getLanguage: () => null, highlight: () => ({ value: '' }) },
      // 预期的 warn/error 由用例登记；未登记的日志在用例收尾时报红。
      console: Object.assign(Object.create(console), {
        log: () => {},
        info: () => {},
        debug: () => {},
        warn: (...args) => { logs.push(['warn', args.map((v) => String(v)).join(' ')]); },
        error: (...args) => { logs.push(['error', args.map((v) => String(v)).join(' ')]); },
      }),
    },
    classic: (sandbox) => {
      // chat-context-bar 顶层的 setTimeout(_initCcbPopup/_initTitlePopup) 不落真实定时器。
      sandbox.setTimeout = () => 0;
      sandbox.window.setTimeout = sandbox.setTimeout;
      sandbox.requestAnimationFrame = () => 0;
      sandbox.window.requestAnimationFrame = sandbox.requestAnimationFrame;
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
      sandbox.loadSource('public/src/app-core.js');
      sandbox.loadSource('public/src/modules/session-view-state.js');
      // chat-context-bar 已迁 ESM（P4 L1）：classic 相只补 markdown-utils 的 classic
      // 实现（escapeHtml / renderer），模块本体在 async 相 c.load。
    },
  }, async (c) => {
    // 上下文栏（已迁 ESM）：classic 侧经桥键 updateChatContextBar 调用同一实现。
    const contextBar = await c.load(CONTEXT_BAR);
    const mod = await c.load(MODULE);
    const toastModule = await c.load(TOAST);
    // overview 快照 owner：会话视图 patch 经桥键写进它，必须先于 patch 求值。
    await c.load(OVERVIEW_DATA);
    const presetCache = await c.load(PRESET_CACHE);
    const orchestration = await c.load(ORCHESTRATION);
    // 真实 toast 模块是同一实例：替换导出对象上的方法做行为记账。
    const toasts = [];
    toastModule.ClawToast.show = (value) => { toasts.push(value); };
    toastModule.ClawToast.update = (id, patch) => { toasts.push({ ...patch, id }); };

    c.read(`currentRuntimeAgentId = 'rt-1'; focusedAgentId = 'host-agent'; selectedFeatureName = null;`);
    c.read(`applySessionViewPatch({ identity: { agentId: 'host-agent', sessionId: 'sess-1' } })`);

    const ctx = c.window;
    const render = () => ctx.run('updateChatContextBar()');
    const overview = (value) => {
      ctx.payload = value;
      ctx.run('commitSessionViewPatch(captureSessionViewToken(), { overview: payload })');
      mod.updateInputModelSwitcher();
      mod.updateThinkingEffortSwitcher();
      render();
    };
    /** 直接点菜单项（真实下拉交互路径，参数由菜单项 dataset 提供）。 */
    const clickItem = (kind, dataset) => {
      const menu = doc.menus().at(-1);
      assert.ok(menu, '下拉菜单应已挂载到 body');
      menu.listeners.click({
        target: { closest: (selector) => (selector === '.ccb-md-item' ? { dataset } : null) },
      });
    };
    const swap = async (value, effort = false) => {
      if (effort) {
        await mod.toggleThinkingEffortDropdown();
        clickItem('thinking', { effort: value });
      } else {
        await mod.toggleInputModelDropdown();
        clickItem('model', { preset: value });
      }
      await settle();
    };
    overview({ ...model(1, 'a'), usageStats: { lastRequestUsage: { inputTokens: 100000 }, totalUsage: { inputTokens: 250000 }, totalRequests: 3 } });
    // 首屏那次 preset 回源（真实 model-preset-cache 的懒加载）先收敛，用例体
    // 里看到的缓存状态因此确定，不会有跨用例体的在飞续体。
    await settle();
    return fn({
      ctx, doc, net, mod, toasts, logs, expectedLogs, orchestration, presetCache,
      overview, swap, render, clickItem, contextBar,
    });
  });
}

/** 日志断言：登记的预期日志必须出现且用尽，其余 warn/error 一律报红。 */
function assertLogs({ logs, expectedLogs }) {
  const remaining = expectedLogs.slice();
  for (const [level, text] of logs) {
    const index = remaining.findIndex((entry) => entry.level === level && entry.match.test(text));
    assert.notEqual(index, -1, `非预期日志：[${level}] ${text}`);
    remaining.splice(index, 1);
  }
  assert.deepEqual(remaining, [], '登记的预期日志没有出现');
}

describe('模型状态统一提交与呈现', () => {
  it('桥键：四个跨文件键经 KernelState 访问器暴露同一实现', async () => {
    await withSandbox(async (s) => {
      for (const [key, fn] of [
        ['updateInputModelSwitcher', s.mod.updateInputModelSwitcher],
        ['updateThinkingEffortSwitcher', s.mod.updateThinkingEffortSwitcher],
        ['toggleInputModelDropdown', s.mod.toggleInputModelDropdown],
        ['toggleThinkingEffortDropdown', s.mod.toggleThinkingEffortDropdown],
      ]) {
        assert.equal(typeof fn, 'function', key);
        assert.equal(s.ctx.window[key], fn, `${key} 桥键指向同一函数`);
        assert.equal(s.ctx.run(`Object.prototype.propertyIsEnumerable.call(window, '${key}')`), false);
        assert.equal(s.ctx.run(`Object.getOwnPropertyDescriptor(window, '${key}').configurable`), true);
      }
      // 命名空间协议保留：既有消费方（ph-settings / memo 插件）仍按 ClawFW 取用
      assert.equal(typeof s.ctx.window.ClawFW.getThinkingEffortOptions, 'function');
      assert.deepEqual(s.mod.getThinkingEffortOptions('openai'), ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
      assert.deepEqual(s.mod.getThinkingEffortOptions('anthropic'), ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
      assert.deepEqual(s.ctx.window.ClawFW.getThinkingEffortOptions('openai'), s.mod.getThinkingEffortOptions('openai'));
      assertLogs(s);
    });
  });

  it('无 model-selection 通道时当前会话不可切换', async () => {
    await withSandbox(async (s) => {
      s.net.state.channels = [{ featureId: 'shell', channelId: 'task-1' }];
      await s.mod.toggleInputModelDropdown();
      assert.deepEqual(s.net.requestTypes(), [], '通道缺失时不得投递模型选择请求');
      assert.equal(s.doc.menus().length, 0, '通道缺失时不打开下拉');
      assert.equal(s.toasts.at(-1)?.title, '当前会话不支持模型切换');
      assertLogs(s);
    });
  });

  it('会话已选中但 runtime 尚未恢复时，提示加载中而非会话不支持', async () => {
    await withSandbox(async (s) => {
      s.ctx.run(`currentRuntimeAgentId = null`);
      const before = s.toasts.length;
      await s.mod.toggleInputModelDropdown();
      const message = s.toasts.at(-1);
      assert.equal(message?.title, '会话正在加载，请稍后再试');
      assert.notEqual(message?.title, '当前会话不支持模型切换');
      assert.deepEqual(s.net.requestTypes(), [], 'runtime 尚未就绪时不能投递模型请求');
      assert.equal(s.toasts.length, before + 1);
      assertLogs(s);
    });
  });

  it('会话操作冲突时模型下拉提示稍后重试，不误报会话不支持', async () => {
    await withSandbox(async (s) => {
      s.net.state.requestHandler = async () => jsonResponse(
        { ok: false, code: 'session_operation_in_progress', error: 'Session is busy with open' },
        false,
        409,
      );
      const pending = s.mod.toggleInputModelDropdown();
      await settle();
      assert.deepEqual(s.net.requestTypes(), ['getStatus'], '菜单可用性检查应实际执行状态请求');
      await pending;
      assert.equal(s.doc.menus().length, 0, '被会话操作闸拒绝时不应展示可操作菜单');
      assert.equal(s.toasts.at(-1)?.title, '会话正在切换，请稍后重试');
      assert.notEqual(s.toasts.at(-1)?.title, '当前会话不支持模型切换');
      assertLogs(s);
    });
  });

  it('选择模型遇到会话操作冲突时提示稍后重试，且不显示模型已切换', async () => {
    await withSandbox(async (s) => {
      const conflict = async () => jsonResponse(
        { ok: false, code: 'session_operation_in_progress', error: 'Session is busy with open' },
        false,
        409,
      );
      // 菜单打开后、点击提交前进入写者更替窗口（服务端 409 闸的真实形态）。
      s.net.state.requestHandler = async (body) => (body.requestType === 'selectModel'
        ? conflict()
        : jsonResponse({ ok: true, result: s.net.state.statusResult }));
      s.expectedLogs.push({ level: 'error', match: /\[InputModelSwitch\] Swap failed/ });
      await s.mod.toggleInputModelDropdown();
      s.clickItem('model', { preset: 'b' });
      await settle();
      const finalToast = s.toasts.at(-1);
      assert.equal(finalToast?.title, '会话正在切换，请稍后重试');
      assert.notEqual(finalToast?.title, '模型已切换');
      assert.equal(s.ctx.run('readCurrentSessionViewState().overview.presetName'), 'a');
      assertLogs(s);
    });
  });

  it('切换通过声明通道向当前会话投递 selectModel 与目标 preset', async () => {
    await withSandbox(async (s) => {
      s.net.state.featureResult = { ok: true, meta: model(2, 'b') };
      await s.swap('b');
      const selectCalls = s.net.requests().filter((body) => body.requestType === 'selectModel');
      assert.equal(selectCalls.length, 1);
      assert.deepEqual(selectCalls[0], {
        agentId: 'host-agent',
        sessionId: 'sess-1',
        featureId: 'model-selection',
        channelId: 'selection',
        requestType: 'selectModel',
        payload: { presetName: 'b' },
      });
      assertLogs(s);
    });
  });

  it('模型、显式档位和默认档位均使用当前视图身份，不跟随宿主 active', async () => {
    await withSandbox(async (s) => {
      s.ctx.getActiveWorkspaceSessionId = () => 'other-session';
      s.net.state.featureResult = { ok: true, meta: model(2, 'b') };
      await s.swap('b');
      s.net.state.featureResult = { ok: true, meta: model(3, 'b', { thinkingEffort: 'high' }) };
      await s.swap('high', true);
      s.net.state.featureResult = { ok: true, meta: model(4, 'b', { thinkingEffort: 'low' }) };
      await s.swap('', true);
      const switches = s.net.requests().filter((body) => body.requestType !== 'getStatus');
      assert.deepEqual(switches.map((body) => body.sessionId), ['sess-1', 'sess-1', 'sess-1']);
      assert.deepEqual(
        switches.map((body) => body.requestType),
        ['selectModel', 'selectModel', 'clearThinkingOverride'],
      );
      assertLogs(s);
    });
  });

  it('通道查询使用当前视图身份，不查询宿主 active', async () => {
    await withSandbox(async (s) => {
      s.ctx.getActiveWorkspaceSessionId = () => 'other-session';
      await s.mod.toggleInputModelDropdown();
      const channelCall = s.net.calls.find((call) => call.url.startsWith('/protoclaw/feature-comms/channels'));
      assert.ok(channelCall, '必须真实查询通道声明');
      assert.deepEqual(
        Object.fromEntries(new URL(channelCall.url, 'http://local').searchParams),
        { agentId: 'host-agent', sessionId: 'sess-1' },
      );
      assertLogs(s);
    });
  });

  it('视图身份缺失或宿主不匹配时不回退到 active，也不接受高版本回执', async () => {
    await withSandbox(async (s) => {
      s.ctx.run(`applySessionViewPatch({ identity: { agentId: 'other-host', sessionId: 'sess-1' } })`);
      await s.mod.toggleInputModelDropdown();
      assert.equal(s.toasts.at(-1)?.title, '当前会话不支持模型切换');
      s.ctx.run(`applySessionViewPatch({ identity: { agentId: 'host-agent', sessionId: '' } })`);
      await s.mod.toggleInputModelDropdown();
      assert.deepEqual(s.net.requestTypes(), [], '身份不完整时不得投递模型请求');
      assert.equal(s.doc.menus().length, 0);
      assert.notEqual(s.ctx.run('readCurrentSessionViewState().overview.modelName'), 'b-model');
      assertLogs(s);
    });
  });

  for (const kind of ['model', 'thinking']) {
    const toggle = kind === 'model' ? 'toggleInputModelDropdown' : 'toggleThinkingEffortDropdown';

    it(`${kind} 下拉查询期间离开再返回，不创建旧菜单或向新身份发请求`, async () => {
      await withSandbox(async (s) => {
        let resolveChannels;
        let started;
        const loading = new Promise((resolve) => { started = resolve; });
        s.net.state.channelHandler = () => {
          started();
          return new Promise((resolve) => { resolveChannels = resolve; });
        };
        const pending = s.mod[toggle]();
        await loading;
        s.ctx.run(`applySessionViewPatch({ identity: { agentId: 'host-agent', sessionId: 'sess-2' } });
          applySessionViewPatch({ identity: { agentId: 'host-agent', sessionId: 'sess-1' } })`);
        resolveChannels(jsonResponse({ ok: true, channels: DECLARED_CHANNELS }));
        await pending;
        assert.equal(s.doc.menus().length, 0);
        assert.deepEqual(s.net.requestTypes(), []);
        assertLogs(s);
      });
    });

    it(`${kind} 已打开菜单在切换会话后点击，不修改新旧任一会话`, async () => {
      await withSandbox(async (s) => {
        await s.mod[toggle]();
        assert.equal(s.doc.menus().length, 1, '当前会话正常打开选择菜单');
        s.ctx.run(`applySessionViewPatch({ identity: { agentId: 'host-agent', sessionId: 'sess-2' } })`);
        s.clickItem(kind, kind === 'model'
          ? { preset: 'b' }
          : { effort: 'high' });
        await settle();
        assert.deepEqual(s.net.requestTypes().filter((type) => type !== 'getStatus'), []);
        assertLogs(s);
      });
    });
  }

  it('预设目录加载期间切换会话，不把旧目录菜单挂到新会话', async () => {
    await withSandbox(async (s) => {
      let resolvePresets;
      let started;
      const loading = new Promise((resolve) => { started = resolve; });
      // 首屏那次懒加载已把默认列表写进会话缓存；这里清空以复现「目录仍在加载」。
      s.presetCache.setClawModelPresets([]);
      s.net.state.presetHandler = () => {
        started();
        return new Promise((resolve) => { resolvePresets = resolve; });
      };
      const pending = s.mod.toggleInputModelDropdown();
      await loading;
      s.ctx.run(`applySessionViewPatch({ identity: { agentId: 'host-agent', sessionId: 'sess-2' } })`);
      resolvePresets(jsonResponse({ config: {}, presets: [{ name: 'b' }] }));
      await pending;
      assert.equal(s.doc.menus().length, 0);
      assert.deepEqual(s.net.requestTypes().filter((type) => type === 'selectModel'), []);
      assertLogs(s);
    });
  });

  it('预设查询期间切到英文：菜单文案取查询结束后的语言', async () => {
    await withSandbox(async (s) => {
      let resolvePresets;
      let started;
      const loading = new Promise((resolve) => { started = resolve; });
      s.presetCache.setClawModelPresets([]);
      s.net.state.presetHandler = () => {
        started();
        return new Promise((resolve) => { resolvePresets = resolve; });
      };
      // 点击时中文 → 三次查询（通道 / 状态 / 预设）期间切到英文 → 起菜单。
      const pending = s.mod.toggleInputModelDropdown();
      await loading;
      s.ctx.run(`currentLanguage = 'en'`);
      resolvePresets(jsonResponse({ config: {}, presets: [{ name: 'b' }] }));
      await pending;
      const menu = s.doc.menus().at(-1);
      assert.ok(menu, '查询结束后照常打开菜单');
      assert.match(menu.innerHTML, />All</, '菜单文案按查询结束时的当前语言渲染');
      assert.match(menu.innerHTML, />Custom</);
      assert.doesNotMatch(menu.innerHTML, />全部</);
      assert.doesNotMatch(menu.innerHTML, />自定义</);
      assertLogs(s);
    });
  });

  it('通道查询期间切到英文：失败提示仍用点击时语言', async () => {
    await withSandbox(async (s) => {
      let resolveChannels;
      let started;
      const loading = new Promise((resolve) => { started = resolve; });
      s.net.state.channelHandler = () => {
        started();
        return new Promise((resolve) => { resolveChannels = resolve; });
      };
      const pending = s.mod.toggleInputModelDropdown();
      await loading;
      s.ctx.run(`currentLanguage = 'en'`);
      // 通道未声明：提示在查询后用**点击时**的语言（zh）给出。
      resolveChannels(jsonResponse({ ok: true, channels: [{ featureId: 'shell', channelId: 'task-1' }] }));
      await pending;
      assert.equal(s.doc.menus().length, 0);
      assert.equal(s.toasts.at(-1)?.title, '当前会话不支持模型切换');
      assert.notEqual(s.toasts.at(-1)?.title, 'Model switching unavailable for this session');
      assertLogs(s);
    });
  });

  it('相同会话 runtime 更换后，旧实例的高版本回执不能污染新实例', async () => {
    await withSandbox(async (s) => {
      let resolveRequest;
      s.net.state.requestHandler = async (body) => {
        if (body.requestType !== 'selectModel') return jsonResponse({ ok: true, result: s.net.state.statusResult });
        return new Promise((resolve) => { resolveRequest = resolve; });
      };
      await s.mod.toggleInputModelDropdown();
      s.clickItem('model', { preset: 'b' });
      await settle();
      s.ctx.run(`currentRuntimeAgentId = 'rt-2'`);
      s.overview(model(1, 'a'));
      resolveRequest(jsonResponse({ ok: true, result: { ok: true, meta: model(100, 'b') } }));
      await settle();
      assert.equal(s.doc.modelLabel.textContent, 'a');
      assert.equal(s.ctx.run('readCurrentSessionViewState().overview.modelRevision'), 1);
      assertLogs(s);
    });
  });

  it('当前视图与宿主 active 不同时，下一轮真正调用新模型且不改变另一个会话', async () => {
    await withSandbox(async (s) => {
      // 身份派生使用生产代码，保留 host.active 与 viewer 绑定不一致的真实场景。
      // （app-core 仍是 classic 真源，此处只取身份派生那一段：整份加载会覆盖本
      //  用例刻意注入的宿主桩，使场景失真。）
      const core = readFileSync(new URL('../public/src/app-core.js', import.meta.url), 'utf8');
      s.ctx.run(sourceBetween(core, 'function normalizeResourceIdentity(', 'function getRuntimeContextKey('));
      s.ctx.getCurrentAgentRecord = () => ({ id: 'host-agent', workspace_sessions: { activeSessionId: 'sess-2' } });
      s.ctx.run(`setViewerSessionBinding('rt-1', 'sess-1')`);
      const calls = { 'sess-1': [], 'sess-2': [] };
      const agents = new Map();
      const features = new Map();
      try {
        for (const sessionId of Object.keys(calls)) {
          const llm = (name, thinkingEffort = 'low') => ({
            modelName: name + '-model',
            async chat() { calls[sessionId].push({ name, thinkingEffort }); return { content: 'ok' }; },
          });
          const agent = new BasicAgent({ name: sessionId, llm: llm('a'), modelResolver: {
            resolve(name, overrides) {
              const thinkingEffort = overrides?.thinkingEffort ?? 'low';
              return { llm: llm(name, thinkingEffort), meta: { ...model(0, name), thinkingEffort } };
            },
          } });
          agents.set(sessionId, agent);
          const feature = new ModelSelectionFeature({ agentId: 'host-agent', sessionId, serverOrigin: 'http://127.0.0.1:1',
            client: { async declareChannel() {}, async publishEvent() {} },
          });
          agent.use(feature);
          features.set(sessionId, feature);
          await agent.onCall('before');
        }
        // 服务端 /protoclaw/feature-comms/request 的真实回执形状：成功 → 200 +
        // { ok:true, result }；Feature 业务失败 → 502 + { ok:false, result }。
        s.net.state.requestHandler = async (body) => {
          const value = await features.get(body.sessionId).onHostRequest(body.requestType, body.payload);
          return value?.ok === false
            ? jsonResponse({ ok: false, result: value }, false, 502)
            : jsonResponse({ ok: true, result: value });
        };
        await s.swap('b');
        await s.swap('high', true);
        for (const agent of agents.values()) await agent.onCall('after');
        assert.deepEqual(calls['sess-1'], [{ name: 'a', thinkingEffort: 'low' }, { name: 'b', thinkingEffort: 'high' }]);
        assert.deepEqual(calls['sess-2'], [{ name: 'a', thinkingEffort: 'low' }, { name: 'a', thinkingEffort: 'low' }]);
        assert.equal(s.doc.modelLabel.textContent, 'b');
        assert.equal(s.doc.effortLabel.textContent, 'high');
        s.overview(agents.get('sess-1').getLLMMeta());
        assert.equal(s.doc.modelLabel.textContent, 'b', '实际 Agent 状态与显示保持一致');
        assertLogs(s);
      } finally {
        for (const agent of agents.values()) await agent.dispose();
      }
    });
  });

  it('回执同时更新名称、窗口、阈值和协议，保留用量并立即重算占比', async () => {
    await withSandbox(async (s) => {
      s.net.state.featureResult = { ok: true, meta: model(2, 'b', { contextLength: 1000000, compressRatio: 70, provider: 'openai', thinkingEffort: 'high' }) };
      await s.swap('b');
      assert.equal(s.doc.modelLabel.textContent, 'b');
      assert.equal(s.doc.effortLabel.textContent, 'high');
      assert.match(s.doc.bar.innerHTML, /b-model/);
      assert.match(s.doc.bar.innerHTML, />10%</);
      assert.equal(s.contextBar._ccbDetailData.contextLength, 1000000);
      assert.equal(s.contextBar._ccbDetailData.compressRatio, 70);
      assert.equal(s.contextBar._ccbDetailData.used, 100000);
      assert.equal(s.contextBar._ccbDetailData.totalInput, 250000);
      // 协议解析（openai vs anthropic）经真实下拉档位表呈现：openai 有 minimal、
      // 没有 max；anthropic 反之。
      await s.mod.toggleThinkingEffortDropdown();
      const menu = s.doc.menus().at(-1);
      assert.match(menu.innerHTML, /data-effort="minimal"/);
      assert.doesNotMatch(menu.innerHTML, /data-effort="max"/);
      assertLogs(s);
    });
  });

  it('迟到的旧 overview 只更新用量，不把整组模型状态退回旧版本', async () => {
    await withSandbox(async (s) => {
      s.net.state.featureResult = { ok: true, meta: model(3, 'b', { contextLength: 1000000, thinkingEffort: 'high' }) };
      await s.swap('b');
      s.overview({ ...model(2, 'a'), usageStats: { lastRequestUsage: { inputTokens: 120000 } } });
      assert.equal(s.doc.modelLabel.textContent, 'b');
      assert.equal(s.doc.effortLabel.textContent, 'high');
      assert.equal(s.contextBar._ccbDetailData.contextLength, 1000000);
      assert.equal(s.contextBar._ccbDetailData.used, 120000);
      assert.match(s.doc.bar.innerHTML, />12%</);
      assertLogs(s);
    });
  });

  it('较新的 feature 切换回到旧名称也能生效，不靠第三值猜测', async () => {
    await withSandbox(async (s) => {
      s.net.state.featureResult = { ok: true, meta: model(2, 'b') };
      await s.swap('b');
      s.overview(model(3, 'a', { contextLength: 500000 }));
      assert.equal(s.doc.modelLabel.textContent, 'a');
      assert.equal(s.contextBar._ccbDetailData.contextLength, 500000);
      // 已追认后到达更老的 B 帧也不能回退。
      s.overview(model(2, 'b'));
      assert.equal(s.doc.modelLabel.textContent, 'a');
      assertLogs(s);
    });
  });

  it('同一 preset 的新窗口和阈值按版本整组更新', async () => {
    await withSandbox(async (s) => {
      s.net.state.featureResult = { ok: true, meta: model(2, 'a', { contextLength: 1000000, compressRatio: 60 }) };
      await s.swap('a');
      s.overview(model(1, 'a'));
      assert.equal(s.contextBar._ccbDetailData.contextLength, 1000000);
      assert.equal(s.contextBar._ccbDetailData.compressRatio, 60);
      assertLogs(s);
    });
  });

  it('乱序回执不能覆盖更晚生效的模型状态', async () => {
    await withSandbox(async (s) => {
      let resolveRequest;
      s.net.state.requestHandler = async (body) => {
        if (body.requestType !== 'selectModel') return jsonResponse({ ok: true, result: s.net.state.statusResult });
        return new Promise((resolve) => { resolveRequest = resolve; });
      };
      await s.mod.toggleInputModelDropdown();
      s.clickItem('model', { preset: 'b' });
      await settle();
      s.overview(model(3, 'a', { thinkingEffort: 'high' }));
      resolveRequest(jsonResponse({ ok: true, result: { ok: true, meta: model(2, 'b') } }));
      await settle();
      assert.equal(s.doc.modelLabel.textContent, 'a');
      assert.equal(s.doc.effortLabel.textContent, 'high');
      assertLogs(s);
    });
  });

  it('连续切模型再调思考强度，整组参数保持最新版本', async () => {
    await withSandbox(async (s) => {
      s.net.state.featureResult = { ok: true, meta: model(2, 'b', { contextLength: 1000000, thinkingEffort: 'medium' }) };
      await s.swap('b');
      s.net.state.featureResult = { ok: true, meta: model(3, 'b', { contextLength: 1000000, thinkingEffort: 'high' }) };
      await s.swap('high', true);
      s.overview({ ...model(1, 'a'), usageStats: { lastRequestUsage: { inputTokens: 100000 } } });
      assert.equal(s.doc.modelLabel.textContent, 'b');
      assert.equal(s.doc.effortLabel.textContent, 'high');
      assert.equal(s.contextBar._ccbDetailData.contextLength, 1000000);
      s.net.state.featureResult = { ok: true, meta: model(4, 'a', { contextLength: 500000 }) };
      await s.swap('a');
      assert.equal(s.doc.modelLabel.textContent, 'a');
      assert.equal(s.doc.effortLabel.textContent, 'low');
      assert.match(s.doc.bar.innerHTML, />20%</);
      assertLogs(s);
    });
  });

  it('切回预设思考档时采用回执中的实际档位，旧 overview 不能恢复旧覆盖', async () => {
    await withSandbox(async (s) => {
      s.net.state.featureResult = { ok: true, meta: model(2, 'a', { thinkingEffort: 'medium' }) };
      await s.swap('medium', true);
      s.overview(model(1, 'a', { thinkingEffort: 'high' }));
      assert.equal(s.doc.effortLabel.textContent, 'medium');
      assertLogs(s);
    });
  });

  it('切换失败保持全部已生效状态', async () => {
    await withSandbox(async (s) => {
      s.expectedLogs.push({ level: 'error', match: /\[InputModelSwitch\] Swap failed/ });
      s.net.state.requestHandler = async (body) => (body.requestType === 'selectModel'
        ? jsonResponse({ ok: false, code: 'model_control_unavailable', error: 'rejected' }, false, 502)
        : jsonResponse({ ok: true, result: s.net.state.statusResult }));
      await s.mod.toggleInputModelDropdown();
      s.clickItem('model', { preset: 'b' });
      await settle();
      assert.equal(s.doc.modelLabel.textContent, 'a');
      assert.equal(s.contextBar._ccbDetailData.contextLength, 200000);
      assert.equal(s.toasts.at(-1)?.title, '切换失败');
      assert.equal(s.toasts.at(-1)?.description, 'rejected');
      assertLogs(s);
    });
  });

  it('默认（预设）操作发送 clearThinkingOverride，不发送 null 档位', async () => {
    await withSandbox(async (s) => {
      s.net.state.featureResult = { ok: true, meta: model(2, 'a', { thinkingEffort: 'low' }) };
      await s.swap('', true);
      const clears = s.net.requests().filter((body) => body.requestType === 'clearThinkingOverride');
      assert.equal(clears.length, 1);
      assert.deepEqual(clears[0].payload, {});
      assert.deepEqual(s.net.requests().filter((body) => body.requestType === 'selectModel'), []);
      assertLogs(s);
    });
  });

  it('请求期间离开再回到同一会话，旧回执由视图代次拒绝', async () => {
    await withSandbox(async (s) => {
      let resolveRequest;
      s.net.state.requestHandler = async (body) => {
        if (body.requestType !== 'selectModel') return jsonResponse({ ok: true, result: s.net.state.statusResult });
        return new Promise((resolve) => { resolveRequest = resolve; });
      };
      await s.mod.toggleInputModelDropdown();
      s.clickItem('model', { preset: 'b' });
      await settle();
      s.ctx.run(`applySessionViewPatch({ identity: { agentId: 'host-agent', sessionId: 'sess-2' } });
        applySessionViewPatch({ identity: { agentId: 'host-agent', sessionId: 'sess-1' } })`);
      s.overview(model(1, 'a'));
      resolveRequest(jsonResponse({ ok: true, result: { ok: true, meta: model(2, 'b') } }));
      await settle();
      assert.equal(s.doc.modelLabel.textContent, 'a');
      assertLogs(s);
    });
  });

  it('runtime 重启后新实例的低版本可以接管', async () => {
    await withSandbox(async (s) => {
      s.net.state.featureResult = { ok: true, meta: model(10, 'b') };
      await s.swap('b');
      s.ctx.run(`currentRuntimeAgentId = 'rt-2'`);
      s.overview(model(0, 'a'));
      assert.equal(s.doc.modelLabel.textContent, 'a');
      assert.equal(s.ctx.run('readCurrentSessionViewState().overview.modelRevision'), 0);
      assertLogs(s);
    });
  });

  it('同步视图重置清空高版本状态，随后低版本快照可以接管', async () => {
    await withSandbox(async (s) => {
      s.net.state.featureResult = { ok: true, meta: model(10, 'b') };
      await s.swap('b');
      s.ctx.run('applySessionViewPatch({ overview: getEmptyOverviewSnapshot() })');
      assert.equal(s.ctx.run('readCurrentSessionViewState().overview.modelRevision'), null);
      s.overview(model(1, 'a'));
      assert.equal(s.doc.modelLabel.textContent, 'a');
      assertLogs(s);
    });
  });

  it('同 runtime 的另一个 Session 缓存整组恢复，不受上一 Session 版本影响', async () => {
    await withSandbox(async (s) => {
      s.net.state.featureResult = { ok: true, meta: model(10, 'b') };
      await s.swap('b');
      s.ctx.payload = model(1, 'a');
      s.ctx.run(`applySessionViewPatch({ overview: payload, sessionMeta: { sessionId: 'sess-2' } })`);
      s.mod.updateInputModelSwitcher();
      s.mod.updateThinkingEffortSwitcher();
      s.render();
      assert.equal(s.doc.modelLabel.textContent, 'a');
      assert.equal(s.ctx.run('readCurrentSessionViewState().overview.modelRevision'), 1);
      s.overview(model(2, 'a', { contextLength: 500000 }));
      assert.equal(s.contextBar._ccbDetailData.contextLength, 500000);
      assertLogs(s);
    });
  });

  it('模型缺失窗口时清空旧窗口，不拼出混合状态', async () => {
    await withSandbox(async (s) => {
      s.net.state.featureResult = { ok: true, meta: model(2, 'b', { contextLength: null }) };
      await s.swap('b');
      assert.equal(s.contextBar._ccbDetailData.contextLength, 0);
      assert.match(s.doc.bar.innerHTML, /ccb-token-empty/);
      assert.match(s.doc.bar.innerHTML, /b-model/);
      assertLogs(s);
    });
  });

  it('全局默认模型同链路显示实际名称', async () => {
    await withSandbox(async (s) => {
      s.net.state.featureResult = { ok: true, meta: model(2, '__default__', { modelName: 'global-model' }) };
      await s.swap('__default__');
      assert.equal(s.doc.modelLabel.textContent, 'global-model');
      assert.match(s.doc.bar.innerHTML, /global-model/);
      assertLogs(s);
    });
  });

  it('已展开的详情随回执和用量快照刷新', async () => {
    await withSandbox(async (s) => {
      s.contextBar._showCcbPopup();
      assert.match(s.contextBar._ccbPopup.innerHTML, /200\.0K/);
      s.net.state.featureResult = { ok: true, meta: model(2, 'b', { contextLength: 1000000, compressRatio: 70 }) };
      await s.swap('b');
      assert.match(s.contextBar._ccbPopup.innerHTML, /b-model/);
      assert.match(s.contextBar._ccbPopup.innerHTML, /1\.0M/);
      assert.match(s.contextBar._ccbPopup.innerHTML, /70%/);
      s.overview({ ...model(2, 'b', { contextLength: 1000000, compressRatio: 70 }), usageStats: { lastRequestUsage: { inputTokens: 150000 } } });
      assert.match(s.contextBar._ccbPopup.innerHTML, /150\.0K/);
      assertLogs(s);
    });
  });
});
