/**
 * thinkingEffort 统一状态读取（P2 真实 ESM 图路线）。
 *
 * 数据流：classic session-view-state 的 `applySessionViewPatch` 经桥键把 overview
 * 快照写进 session-view-storage owner（overview-data 已迁 ESM，其 setter 就是桥的
 * 实现）；input-model-switcher 已迁 ESM，其 `updateThinkingEffortSwitcher()` 从同一
 * owner 读回档位并渲染到 `.input-thinking-name`。"快照里有值就优先于预设默认"
 * 这条判定必须在真实链路上成立——因此断言面是切换器按钮的**真实渲染结果**，
 * 不是内部 helper（`_getCurrentThinkingEffort` 零跨文件消费，按配方保持模块私有）。
 *
 * 装载路线：classic 相跑真实生产源（action-dispatcher / i18n / app-core /
 * session-view-state），input-model-switcher 与 overview-data、preset 缓存 owner、
 * orchestration 状态 owner 经 `withP2EsmCase` + `c.load` 真实 import；预设表经
 * owner 的 setter 写入（不走测试桩全局），每个用例一张独立模块图。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { APP_CORE_DOMAIN, prepareEsmModules, SESSION_VIEW_DOMAIN } from './p2-classic-hosts.js';

const MODULE = 'public/src/modules/input-model-switcher.js';
const OVERVIEW_DATA = 'public/src/modules/overview-data.js';
const PRESET_CACHE = 'public/src/modules/model-preset-cache.js';
const ORCHESTRATION = 'public/src/modules/orchestration-state.js';

/** 当前会话 runtime 身份（预设缓存按此身份命中，ADR-0011）。 */
const RUNTIME_ID = 'rt-1';

function createElement(tag = '') {
  const classes = new Set();
  return {
    tagName: String(tag).toUpperCase(),
    innerHTML: '',
    textContent: '',
    title: '',
    style: {},
    dataset: {},
    offsetHeight: 40,
    isConnected: false,
    classList: {
      add(value) { classes.add(value); },
      remove(value) { classes.delete(value); },
      contains(value) { return classes.has(value); },
    },
    addEventListener() {},
    removeEventListener() {},
    remove() { this.isConnected = false; },
    contains() { return false; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 100, top: 200, bottom: 230 }; },
  };
}

function createDocument() {
  const nameEl = createElement('span');
  const button = createElement('button');
  const body = createElement('body');
  const byId = new Map([['input-thinking-btn', button]]);
  const bySelector = new Map([['.input-thinking-name', nameEl]]);
  return {
    nameEl,
    button,
    body,
    getElementById(id) { return byId.get(id) || null; },
    querySelector(selector) { return bySelector.get(selector) || null; },
    querySelectorAll() { return []; },
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

/** 让已发出但未 await 的续体（preset 回源）跑完，不跨用例残留。 */
function settle() {
  return new Promise((resolve) => { setTimeout(() => setImmediate(resolve), 0); });
}

function jsonResponse(payload, ok = true, status = 200) {
  return { ok, status, json: async () => payload };
}

/**
 * 一个用例 = 一张独立模块图 + 真实 classic 输入面宿主。
 * `presets` 是模型配置端点返回的预设表（远程会话按自己的命名空间返回）。
 */
async function withSwitcherCase({ presets = [] }, fn) {
  const doc = createDocument();
  const logs = [];
  const fetches = [];

  return withP2EsmCase({
    classic: (sandbox) => {
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
      prepareEsmModules(sandbox, APP_CORE_DOMAIN);
      prepareEsmModules(sandbox, SESSION_VIEW_DOMAIN);
    },
    globals: {
      document: doc,
      // markdown-utils（escapeHtml / renderer 的 ESM owner）求值期读取的经典库面
      renderer: { options: {} },
      escapeHtml: (text) => String(text ?? '').replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[m]),
      marked: { Renderer: class { constructor() {} }, setOptions() {}, parse: () => '' },
      hljs: { getLanguage: () => null, highlight: () => ({ value: '' }) },
      // 预设回源只走真实 model-preset-cache → fetch，网络对端换成本地契约
      fetch: async (url) => {
        fetches.push(String(url));
        return jsonResponse({ config: {}, presets });
      },
      console: Object.assign(Object.create(console), {
        log: () => {},
        info: () => {},
        warn: (...args) => { logs.push(['warn', args.map((v) => String(v)).join(' ')]); },
        error: (...args) => { logs.push(['error', args.map((v) => String(v)).join(' ')]); },
      }),
    },
  }, async (c) => {
    const mod = await c.load(MODULE);
    await c.load(OVERVIEW_DATA);
    const presetCache = await c.load(PRESET_CACHE);
    const orchestration = await c.load(ORCHESTRATION);
    orchestration.setCurrentRuntimeAgentId(RUNTIME_ID);
    // 启动配置（首份运行时状态到达之前的回退来源，生产实现是 app-ui 的 classic 函数）
    c.window.getRuntimeAwareAgentRecord = () => ({ modelPresets: { default: { primary: 'a' } } });
    await fn({ c, mod, presetCache, fetches, logs, doc });
  });
}

/** 把 overview 快照提交进会话视图，再跑一次真实切换器渲染，返回按钮文案。 */
async function renderEffort({ c, mod, doc }, overview, preset, presetCache) {
  if (preset) presetCache.setClawModelPresets([preset], RUNTIME_ID);
  c.window.payload = overview;
  c.read('applySessionViewPatch({ overview: payload })');
  mod.updateThinkingEffortSwitcher();
  const text = doc.nameEl.textContent;
  await settle();
  return text;
}

describe('thinkingEffort 统一状态读取', () => {
  for (const [thinkingEffort, label] of [['high', 'high'], ['xhigh', 'xhigh'], ['none', 'none']]) {
    it(`快照保留 ${thinkingEffort} 并优先于预设默认`, async () => {
      await withSwitcherCase({}, async (ctx) => {
        const text = await renderEffort(
          ctx,
          { modelRevision: 1, presetName: 'a', thinkingEffort },
          { name: 'a', thinkingEffort: 'medium' },
          ctx.presetCache,
        );
        assert.equal(text, label);
      });
    });
  }

  it('快照保留 null 并优先于预设默认', async () => {
    await withSwitcherCase({}, async (ctx) => {
      const text = await renderEffort(
        ctx,
        { modelRevision: 1, presetName: 'a', thinkingEffort: null },
        { name: 'a', thinkingEffort: 'medium' },
        ctx.presetCache,
      );
      // 无覆盖档 → 切换器显示中性「思考强度」，而不是预设默认 medium
      assert.equal(text, '思考强度');
      assert.notEqual(text, 'medium');
    });
  });

  it('首份运行时状态到达之前可显示启动预设默认', async () => {
    await withSwitcherCase({}, async (ctx) => {
      const text = await renderEffort(ctx, null, { name: 'a', thinkingEffort: 'medium' }, ctx.presetCache);
      assert.equal(text, 'medium');
    });
  });

  it('无预设、无运行时数据时返回空档位', async () => {
    await withSwitcherCase({}, async (ctx) => {
      const text = await renderEffort(ctx, null, null, ctx.presetCache);
      assert.equal(text, '思考强度');
      assert.deepEqual(ctx.logs, [], '预设回源为空不是错误路径，不得有预期外日志');
    });
  });

  it('页面重载直接从快照恢复档位，不依赖本地缓存', async () => {
    await withSwitcherCase({}, async (ctx) => {
      const text = await renderEffort(
        ctx,
        { modelRevision: 3, presetName: 'a', thinkingEffort: 'high' },
        null,
        ctx.presetCache,
      );
      assert.equal(text, 'high');
    });
  });

  it('无版本的远程快照仍保留显式 null，不回填预设默认', async () => {
    await withSwitcherCase({}, async (ctx) => {
      const text = await renderEffort(
        ctx,
        { modelName: 'a-model', presetName: 'a', thinkingEffort: null },
        { name: 'a', thinkingEffort: 'medium' },
        ctx.presetCache,
      );
      assert.equal(text, '思考强度');
      assert.notEqual(text, 'medium');
    });
  });

  it('模型版本和完整参数经过归一化不会丢失', async () => {
    await withSwitcherCase({}, async (ctx) => {
      const { c } = ctx;
      c.window.payload = {
        modelRevision: 4, modelName: 'b', presetName: 'a', provider: 'openai',
        thinkingEffort: 'high', contextLength: 1000000, compressRatio: 70,
      };
      c.read('applySessionViewPatch({ overview: payload })');
      const state = c.read('readCurrentSessionViewState().overview');
      assert.equal(state.modelRevision, 4);
      assert.equal(state.provider, 'openai');
      assert.equal(state.contextLength, 1000000);
      assert.equal(state.compressRatio, 70);
    });
  });
});
