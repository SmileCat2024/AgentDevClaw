import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * input-model-switcher.js — 模型/思考强度切换乐观回执契约测试。
 *
 * 场景：swap POST 的 ack 即 runtime 新状态（requestRuntimeAck 等 setModel /
 * setThinkingEffort 完成才回包），但 overview 快照经 SSE 事件 / 轮询通道
 * 送达——广域链路（反向代理缓冲等）下可能滞后数秒。切换器与上下文条
 * 不得等待 overview 追认：ack 到达即按回执显示，快照追上（同值或更新值）
 * 或会话身份变化后回执自然退役。
 *
 * 退化形态（本测试锁死）：
 * - 标签只读 currentOverviewSnapshot.presetName，云端访问下按钮模型名
 *   落后 ack 数秒；
 * - 思考强度：updateThinkingEffortSwitcher 的 overview→cache 同步把滞后帧
 *   旧档位写回缓存，切换成功后标签先退回旧档位数秒；
 * - 上下文条模型名只读 overview.modelName，同款滞后。
 */

function createSwitcherSandbox({ fetchImpl, labelEl = null, extraGlobals = {} } = {}) {
  const state = {
    agent: { id: 'host-agent', modelPresets: { default: { primary: 'old-preset' } } },
  };
  const labelElement = labelEl || { textContent: '' };
  const ctx = createFrontendSandbox({
    fetch: fetchImpl,
    ClawToast: { show() {}, update() {} },
    getActiveWorkspaceSessionId: () => 'sess-1',
    getRuntimeAwareAgentRecord: () => state.agent,
    formatPresetDisplayName: (name) => name,
    _fetchPresetsForCurrentSession: async () => {},
    // model-preset-cache.js / session-ui.js 的文档化全局依赖（生产中先于
    // 本模块加载）：_getCurrentThinkingEffort 的 preset 兜底与缓存读取会触达
    updateChatContextBar: () => {},
    _cacheModelInfo: () => {},
    getCachedThinkingEffort: () => null,
    getClawModelPresets: () => [],
    clawModelPresetsMatchSession: () => false,
    ensureClawModelPresetsForSession: async () => {},
    document: {
      querySelector(selector) {
        return selector === '.input-model-name' ? labelElement : null;
      },
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      addEventListener() {},
      body: { appendChild() {} },
    },
    // extraGlobals 最后展开：测试可用自定义 document / 预设表等覆盖基础 stub
    ...extraGlobals,
  });
  ctx.loadSource('public/src/modules/input-model-switcher.js');
  ctx.__state = state;
  ctx.__label = labelElement;
  return ctx;
}

function swapOkResponse(meta) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, agentId: 'host-agent', presetName: meta.presetName, meta }),
  });
}

describe('input-model-switcher：模型切换乐观回执', () => {
  it('swap ack 后、overview 快照仍滞后时，标签立即显示新 preset', async () => {
    const ctx = createSwitcherSandbox({ fetchImpl: swapOkResponse({ presetName: 'new-preset', modelName: 'new-model', thinkingEffort: null }) });
    ctx.run(`currentRuntimeAgentId = 'rt-1'`);
    ctx.run(`currentOverviewSnapshot = { presetName: 'old-preset', modelName: 'old-model' }`);

    assert.equal(ctx.run('_getInputDefaultPresetName()'), 'old-preset');
    await ctx.run(`_performInputModelSwap('host-agent', 'new-preset')`);

    // overview 快照未动（模拟 SSE 帧仍在链路中缓冲）：回执先行。
    assert.equal(ctx.run(`currentOverviewSnapshot.presetName`), 'old-preset');
    assert.equal(ctx.run('_getInputDefaultPresetName()'), 'new-preset');
  });

  it('__default__ 合成名：回执携带的 modelName 立即渲染到按钮', async () => {
    const labelEl = { textContent: '' };
    const ctx = createSwitcherSandbox({
      fetchImpl: swapOkResponse({ presetName: '__default__', modelName: 'global-default-model', thinkingEffort: null }),
      labelEl,
    });
    ctx.run(`currentRuntimeAgentId = 'rt-1'`);
    ctx.run(`currentOverviewSnapshot = { presetName: '__default__', modelName: 'old-default-model' }`);

    await ctx.run(`_performInputModelSwap('host-agent', '__default__')`);
    assert.equal(labelEl.textContent, 'global-default-model');
  });

  it('overview 出现更新的第三值（feature 再切换）时回执退役，overview 重新权威', async () => {
    const ctx = createSwitcherSandbox({ fetchImpl: swapOkResponse({ presetName: 'new-preset', modelName: 'new-model', thinkingEffort: null }) });
    ctx.run(`currentRuntimeAgentId = 'rt-1'`);
    ctx.run(`currentOverviewSnapshot = { presetName: 'old-preset', modelName: 'old-model' }`);
    await ctx.run(`_performInputModelSwap('host-agent', 'new-preset')`);
    assert.equal(ctx.run('_getInputDefaultPresetName()'), 'new-preset');

    // 快照追上回执：同值，显示不变
    ctx.run(`currentOverviewSnapshot = { presetName: 'new-preset', modelName: 'new-model' }`);
    assert.equal(ctx.run('_getInputDefaultPresetName()'), 'new-preset');

    // 快照又前进到第三值（如 feature 发起的再切换）：回执退役
    ctx.run(`currentOverviewSnapshot = { presetName: 'feature-preset', modelName: 'feature-model' }`);
    assert.equal(ctx.run('_getInputDefaultPresetName()'), 'feature-preset');
  });

  it('会话切换（currentRuntimeAgentId 变化）后回执整体失效，回落 overview', async () => {
    const ctx = createSwitcherSandbox({ fetchImpl: swapOkResponse({ presetName: 'new-preset', modelName: 'new-model', thinkingEffort: null }) });
    ctx.run(`currentRuntimeAgentId = 'rt-1'`);
    ctx.run(`currentOverviewSnapshot = { presetName: 'old-preset', modelName: 'old-model' }`);
    await ctx.run(`_performInputModelSwap('host-agent', 'new-preset')`);
    assert.equal(ctx.run('_getInputDefaultPresetName()'), 'new-preset');

    ctx.run(`currentRuntimeAgentId = 'rt-2'`);
    ctx.run(`currentOverviewSnapshot = { presetName: 'other-session-preset', modelName: 'other-model' }`);
    assert.equal(ctx.run('_getInputDefaultPresetName()'), 'other-session-preset');
  });

  it('连续两次切换（快照仍停在切换前旧值）：回执 prev 列表覆盖旧快照，显示最新回执', async () => {
    const ctx = createSwitcherSandbox({ fetchImpl: swapOkResponse({ presetName: 'preset-b', modelName: 'model-b', thinkingEffort: null }) });
    ctx.run(`currentRuntimeAgentId = 'rt-1'`);
    ctx.run(`currentOverviewSnapshot = { presetName: 'preset-a', modelName: 'model-a' }`);
    await ctx.run(`_performInputModelSwap('host-agent', 'preset-b')`);

    // 第二次切换：fetch 返回新回执，overview 仍停在最初的 preset-a
    ctx.run(`fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, agentId: 'host-agent', presetName: 'preset-c', meta: { presetName: 'preset-c', modelName: 'model-c', thinkingEffort: null } }) })`);
    await ctx.run(`_performInputModelSwap('host-agent', 'preset-c')`);

    assert.equal(ctx.run(`currentOverviewSnapshot.presetName`), 'preset-a');
    assert.equal(ctx.run('_getInputDefaultPresetName()'), 'preset-c');
  });
});

function effortAckResponse(meta) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, agentId: 'host-agent', thinkingEffort: meta.thinkingEffort, meta }),
  });
}

describe('input-model-switcher：思考强度切换乐观回执', () => {
  // 复刻 session-ui.js 缓存语义：_cacheModelInfo 仅在实参提供时写入
  // （null=清除为默认），getCachedThinkingEffort 无条目时返回 undefined
  // （区别于显式 null）——消费方以 undefined 判"无缓存"、null 判"已清除"。
  function functionalEffortCache() {
    const cache = new Map();
    return {
      _cacheModelInfo(agent, _a, _b, _c, effort) {
        if (effort !== undefined) cache.set(agent.id, effort || null);
      },
      getCachedThinkingEffort(agent) { return cache.get(agent?.id); },
    };
  }

  const PRESET_GLOBALS = {
    clawModelPresetsMatchSession: () => true,
    getClawModelPresets: () => [{ name: 'old-preset', provider: 'anthropic', thinkingEffort: 'low' }],
    ensureClawModelPresetsForSession: async () => {},
  };

  function effortSandbox({ fetchImpl, thinkingEl, modelEl } = {}) {
    return createSwitcherSandbox({
      fetchImpl,
      labelEl: modelEl || { textContent: '' },
      extraGlobals: {
        ...functionalEffortCache(),
        ...PRESET_GLOBALS,
        document: {
          querySelector(selector) {
            if (selector === '.input-model-name') return modelEl || { textContent: '' };
            if (selector === '.input-thinking-name') return thinkingEl;
            return null;
          },
          querySelectorAll: () => [],
          getElementById(id) { return id === 'input-thinking-btn' ? { classList: { add() {}, remove() {} }, title: '' } : null; },
          createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
          addEventListener() {},
          body: { appendChild() {} },
        },
      },
    });
  }

  it('effort ack 后、滞后 overview 帧把旧档位同步进缓存时，标签不被 clobber 回旧值', async () => {
    const thinkingEl = { textContent: '', style: {} };
    const ctx = effortSandbox({
      fetchImpl: effortAckResponse({ presetName: 'old-preset', modelName: 'old-model', thinkingEffort: 'high' }),
      thinkingEl,
    });
    ctx.run(`currentRuntimeAgentId = 'rt-1'`);
    ctx.run(`currentOverviewSnapshot = { presetName: 'old-preset', modelName: 'old-model', thinkingEffort: 'low', provider: 'anthropic' }`);
    assert.equal(ctx.run('_getCurrentThinkingEffort()'), 'low');

    // 切换成功：ack 即新值。此时 updateThinkingEffortSwitcher 的 overview→cache
    // 同步会把滞后的 'low' 写回缓存——回执必须盖住它。
    await ctx.run(`_performThinkingEffortSwap('host-agent', 'high')`);
    assert.equal(ctx.run(`currentOverviewSnapshot.thinkingEffort`), 'low');
    assert.equal(ctx.run('_getCurrentThinkingEffort()'), 'high');
    assert.equal(thinkingEl.textContent, 'high');
  });

  it('effort 清除为厂商默认（null）时回执显式断言 null，占位立即生效', async () => {
    const thinkingEl = { textContent: '', style: {} };
    const ctx = effortSandbox({
      fetchImpl: effortAckResponse({ presetName: 'old-preset', modelName: 'old-model', thinkingEffort: null }),
      thinkingEl,
    });
    ctx.run(`currentRuntimeAgentId = 'rt-1'`);
    ctx.run(`currentOverviewSnapshot = { presetName: 'old-preset', modelName: 'old-model', thinkingEffort: 'low', provider: 'anthropic' }`);

    await ctx.run(`_performThinkingEffortSwap('host-agent', null)`);
    assert.equal(ctx.run('_getCurrentThinkingEffort()'), null);
    assert.equal(thinkingEl.textContent, '思考强度');
  });

  it('overview 追认后稳定；effort 轴出现第三值时回执退役、overview 重新权威', async () => {
    const thinkingEl = { textContent: '', style: {} };
    const ctx = effortSandbox({
      fetchImpl: effortAckResponse({ presetName: 'old-preset', modelName: 'old-model', thinkingEffort: 'high' }),
      thinkingEl,
    });
    ctx.run(`currentRuntimeAgentId = 'rt-1'`);
    ctx.run(`currentOverviewSnapshot = { presetName: 'old-preset', modelName: 'old-model', thinkingEffort: 'low', provider: 'anthropic' }`);
    await ctx.run(`_performThinkingEffortSwap('host-agent', 'high')`);

    // 快照追认（生产中经 commitMetadataUpdate 会触发一次重渲染）
    ctx.run(`currentOverviewSnapshot = { presetName: 'old-preset', modelName: 'old-model', thinkingEffort: 'high', provider: 'anthropic' }`);
    ctx.run('updateThinkingEffortSwitcher()');
    assert.equal(ctx.run('_getCurrentThinkingEffort()'), 'high');

    // 第三值（feature 发起的再切换）：回执退役，overview 权威
    ctx.run(`currentOverviewSnapshot = { presetName: 'old-preset', modelName: 'old-model', thinkingEffort: 'xhigh', provider: 'anthropic' }`);
    ctx.run('updateThinkingEffortSwitcher()');
    assert.equal(ctx.run('_getCurrentThinkingEffort()'), 'xhigh');
    assert.equal(thinkingEl.textContent, 'xhigh');
  });

  it('混合序列：先切模型再切档位，快照全程停在最初值，两轴均按最新回执显示', async () => {
    const thinkingEl = { textContent: '', style: {} };
    const modelEl = { textContent: '' };
    const ctx = createSwitcherSandbox({
      fetchImpl: async () => ({
        ok: true, status: 200,
        json: async () => ({ ok: true, agentId: 'host-agent', presetName: 'preset-b', meta: { presetName: 'preset-b', modelName: 'model-b', thinkingEffort: 'medium' } }),
      }),
      labelEl: modelEl,
      extraGlobals: {
        ...functionalEffortCache(),
        clawModelPresetsMatchSession: () => true,
        getClawModelPresets: () => [
          { name: 'preset-a', provider: 'anthropic', thinkingEffort: 'low' },
          { name: 'preset-b', provider: 'anthropic', thinkingEffort: 'medium' },
        ],
        ensureClawModelPresetsForSession: async () => {},
        document: {
          querySelector(selector) {
            if (selector === '.input-model-name') return modelEl;
            if (selector === '.input-thinking-name') return thinkingEl;
            return null;
          },
          querySelectorAll: () => [],
          getElementById(id) { return id === 'input-thinking-btn' ? { classList: { add() {}, remove() {} }, title: '' } : null; },
          createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
          addEventListener() {},
          body: { appendChild() {} },
        },
      },
    });
    ctx.run(`currentRuntimeAgentId = 'rt-1'`);
    ctx.run(`currentOverviewSnapshot = { presetName: 'preset-a', modelName: 'model-a', thinkingEffort: 'low', provider: 'anthropic' }`);

    await ctx.run(`_performInputModelSwap('host-agent', 'preset-b')`);
    assert.equal(ctx.run('_getInputDefaultPresetName()'), 'preset-b');
    assert.equal(ctx.run('_getCurrentThinkingEffort()'), 'medium');

    ctx.run(`fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, agentId: 'host-agent', thinkingEffort: 'high', meta: { presetName: 'preset-b', modelName: 'model-b', thinkingEffort: 'high' } }) })`);
    await ctx.run(`_performThinkingEffortSwap('host-agent', 'high')`);

    // 快照全程停在最初值：preset 轴经 prev 链豁免，effort 轴经 prev 链豁免
    assert.equal(ctx.run(`currentOverviewSnapshot.presetName`), 'preset-a');
    assert.equal(ctx.run(`currentOverviewSnapshot.thinkingEffort`), 'low');
    assert.equal(ctx.run('_getInputDefaultPresetName()'), 'preset-b');
    assert.equal(ctx.run('_getCurrentThinkingEffort()'), 'high');

    // 快照一次性追认两轴：显示不变
    ctx.run(`currentOverviewSnapshot = { presetName: 'preset-b', modelName: 'model-b', thinkingEffort: 'high', provider: 'anthropic' }`);
    assert.equal(ctx.run('_getInputDefaultPresetName()'), 'preset-b');
    assert.equal(ctx.run('_getCurrentThinkingEffort()'), 'high');
  });
});

describe('chat-context-bar：模型名接入 swap 回执', () => {
  function contextBarSandbox({ fetchImpl } = {}) {
    const state = { agent: { id: 'host-agent' }, overview: {} };
    // dataset: chat-context-bar.js 加载期的 setTimeout(_initCcbPopup, 0) 会绑
    // 弹窗事件（真实浏览器有 DOMContentLoaded；沙箱里 document stub 走 0ms 定时器路径）
    const barEl = { innerHTML: '', dataset: {}, addEventListener() {}, contains() { return false; }, classList: { contains: () => false, add() {}, remove() {} } };
    const ctx = createFrontendSandbox({
      fetch: fetchImpl,
      ClawToast: { show() {}, update() {} },
      getActiveWorkspaceSessionId: () => 'sess-1',
      getRuntimeAwareAgentRecord: () => state.agent,
      formatPresetDisplayName: (name) => name,
      _cacheModelInfo: () => {},
      getCachedThinkingEffort: () => null,
      getClawModelPresets: () => [],
      clawModelPresetsMatchSession: () => false,
      ensureClawModelPresetsForSession: async () => {},
      shouldRenderWorkspaceSurface: () => false,
      isChatSurfaceActive: () => true,
      notifyChatViewportMutation: () => {},
      followLatestEnabled: false,
      container: { scrollTop: 0 },
      readCurrentSessionViewState: () => ({ overview: state.overview }),
      document: {
        querySelector(selector) { return selector === '.input-model-name' ? { textContent: '' } : null; },
        querySelectorAll: () => [],
        getElementById(id) { return id === 'chat-context-bar' ? barEl : null; },
        createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
        addEventListener() {},
        body: { appendChild() {} },
      },
    });
    ctx.loadSource('public/src/modules/input-model-switcher.js');
    ctx.loadSource('public/src/modules/chat-context-bar.js');
    ctx.__state = state;
    ctx.__bar = barEl;
    return ctx;
  }

  it('swap 回执在 overview 滞后期间驱动上下文条模型名', async () => {
    const ctx = contextBarSandbox({
      fetchImpl: async () => ({
        ok: true, status: 200,
        json: async () => ({ ok: true, agentId: 'host-agent', presetName: 'new-preset', meta: { presetName: 'new-preset', modelName: 'new-model', thinkingEffort: null } }),
      }),
    });
    ctx.run(`currentRuntimeAgentId = 'rt-1'`);
    ctx.__state.overview = { presetName: 'old-preset', modelName: 'old-model' };
    ctx.run('updateChatContextBar()');
    assert.ok(ctx.__bar.innerHTML.includes('old-model'));

    await ctx.run(`_performInputModelSwap('host-agent', 'new-preset')`);
    // overview 仍滞后（未追认）：上下文条立即显示回执模型名
    ctx.run('updateChatContextBar()');
    assert.ok(ctx.__bar.innerHTML.includes('new-model'));
    assert.ok(!ctx.__bar.innerHTML.includes('old-model'));

    // 快照追认后显示不变
    ctx.__state.overview = { presetName: 'new-preset', modelName: 'new-model' };
    ctx.run('updateChatContextBar()');
    assert.ok(ctx.__bar.innerHTML.includes('new-model'));
  });

  it('无回执时（会话切换后回执退役）回落 overview / session 元数据', async () => {
    const ctx = contextBarSandbox({
      fetchImpl: async () => ({
        ok: true, status: 200,
        json: async () => ({ ok: true, agentId: 'host-agent', presetName: 'new-preset', meta: { presetName: 'new-preset', modelName: 'new-model', thinkingEffort: null } }),
      }),
    });
    ctx.run(`currentRuntimeAgentId = 'rt-1'`);
    ctx.__state.overview = { presetName: 'old-preset', modelName: 'old-model' };
    await ctx.run(`_performInputModelSwap('host-agent', 'new-preset')`);

    ctx.run(`currentRuntimeAgentId = 'rt-2'`);
    ctx.__state.overview = { presetName: 'other-preset', modelName: 'other-model' };
    ctx.run('updateChatContextBar()');
    assert.ok(ctx.__bar.innerHTML.includes('other-model'));
    assert.ok(!ctx.__bar.innerHTML.includes('new-model'));
  });
});
