import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

// 真实状态写入入口 + 切换请求 + 顶栏/详情渲染，隔离网络和用户数据。
const model = (modelRevision, name, extra = {}) => ({
  modelRevision, presetName: name, modelName: name + '-model',
  thinkingEffort: 'low', provider: 'anthropic', contextLength: 200000, compressRatio: 80,
  ...extra,
});

function sandbox() {
  function element() {
    const classes = new Set();
    return { innerHTML: '', textContent: '', style: {}, dataset: {}, title: '',
      classList: { add: (v) => classes.add(v), remove: (v) => classes.delete(v), contains: (v) => classes.has(v) },
      addEventListener() {}, getBoundingClientRect: () => ({ left: 100, bottom: 30 }),
    };
  }
  const bar = element(), modelLabel = element(), effortLabel = element(), effortButton = element();
  const ctx = createFrontendSandbox({
    currentRuntimeAgentId: 'rt-1', focusedAgentId: 'host-agent', selectedFeatureName: null,
    getCurrentHostAgentRecord: () => ({ id: 'host-agent' }),
    getActiveWorkspaceSessionId: () => 'sess-1',
    getRuntimeAwareAgentRecord: () => ({ id: 'host-agent' }),
    formatPresetDisplayName: (name) => name,
    ClawToast: { show() {}, update() {} },
    ClawFeatureCommunication: {
      listChannels: async () => [{ featureId: 'model-selection', channelId: 'selection' }],
      calls: [],
      request: async (target, requestType, payload) => {
        ctx.ClawFeatureCommunication.calls.push({ target, requestType, payload });
        return ctx.requestResult ?? { ok: true, meta: model(1, 'a') };
      },
    },
    getClawModelPresets: () => ['a', 'b', '__default__'].map((name) => ({ name, thinkingEffort: 'low' })),
    clawModelPresetsMatchSession: () => true,
    ensureClawModelPresetsForSession: async () => {},
    shouldRenderWorkspaceSurface: () => false,
    isChatSurfaceActive: () => true,
    notifyChatViewportMutation() {}, followLatestEnabled: false, container: { scrollTop: 0 },
    document: {
      querySelector: (s) => s === '.input-model-name' ? modelLabel : s === '.input-thinking-name' ? effortLabel : null,
      getElementById: (id) => id === 'chat-context-bar' ? bar : id === 'input-thinking-btn' ? effortButton : null,
      createElement: element, addEventListener() {}, body: { appendChild() {} },
    },
  });
  ctx.window.ClawFeatureCommunication = ctx.ClawFeatureCommunication;
  ctx.loadSource('public/src/modules/session-view-state.js');
  ctx.loadSource('public/src/modules/overview-data.js');
  ctx.loadSource('public/src/modules/input-model-switcher.js');
  ctx.loadSource('public/src/modules/chat-context-bar.js');
  ctx.run(`applySessionViewPatch({ identity: { agentId: 'host-agent', sessionId: 'sess-1' } })`);
  const render = () => ctx.run('updateInputModelSwitcher(); updateThinkingEffortSwitcher(); updateChatContextBar()');
  const overview = (value) => {
    ctx.payload = value;
    ctx.run('commitSessionViewPatch(captureSessionViewToken(), { overview: payload })');
    render();
  };
  const swap = async (value, effort = false) => {
    ctx.requestResult = { ok: true, meta: value };
    ctx.payload = value;
    await ctx.run(effort ? `_performThinkingEffortSwap('host-agent', payload.thinkingEffort)` : `_performInputModelSwap('host-agent', payload.presetName)`);
  };
  overview({ ...model(1, 'a'), usageStats: { lastRequestUsage: { inputTokens: 100000 }, totalUsage: { inputTokens: 250000 }, totalRequests: 3 } });
  return { ctx, bar, modelLabel, effortLabel, overview, swap, render };
}

describe('模型状态统一提交与呈现', () => {
  it('无 model-selection 通道时当前会话不可切换', async () => {
    const s = sandbox();
    s.ctx.ClawFeatureCommunication.listChannels = async () => [{ featureId: 'shell', channelId: 'task-1' }];
    assert.equal(await s.ctx.run(`_ensureModelSelectionChannel('host-agent')`), false);
    assert.equal(s.ctx.ClawFeatureCommunication.calls.length, 0, '通道缺失时不得投递模型选择请求');
  });

  it('切换通过声明通道向当前会话投递 selectModel 与目标 preset', async () => {
    const s = sandbox();
    await s.swap(model(2, 'b'));
    const [call] = s.ctx.ClawFeatureCommunication.calls;
    assert.deepEqual(JSON.parse(JSON.stringify(call)), {
      target: { agentId: 'host-agent', sessionId: 'sess-1', featureId: 'model-selection', channelId: 'selection' },
      requestType: 'selectModel',
      payload: { presetName: 'b' },
    });
  });

  it('回执同时更新名称、窗口、阈值和协议，保留用量并立即重算占比', async () => {
    const s = sandbox();
    await s.swap(model(2, 'b', { contextLength: 1000000, compressRatio: 70, provider: 'openai', thinkingEffort: 'high' }));
    assert.equal(s.modelLabel.textContent, 'b');
    assert.equal(s.effortLabel.textContent, 'high');
    assert.match(s.bar.innerHTML, /b-model/);
    assert.match(s.bar.innerHTML, />10%</);
    assert.equal(s.ctx.window._ccbDetailData.contextLength, 1000000);
    assert.equal(s.ctx.window._ccbDetailData.compressRatio, 70);
    assert.equal(s.ctx.window._ccbDetailData.used, 100000);
    assert.equal(s.ctx.window._ccbDetailData.totalInput, 250000);
    assert.equal(s.ctx.run('_getCurrentPresetProtocol()'), 'openai');
  });

  it('迟到的旧 overview 只更新用量，不把整组模型状态退回旧版本', async () => {
    const s = sandbox();
    await s.swap(model(3, 'b', { contextLength: 1000000, thinkingEffort: 'high' }));
    s.overview({ ...model(2, 'a'), usageStats: { lastRequestUsage: { inputTokens: 120000 } } });
    assert.equal(s.modelLabel.textContent, 'b');
    assert.equal(s.effortLabel.textContent, 'high');
    assert.equal(s.ctx.window._ccbDetailData.contextLength, 1000000);
    assert.equal(s.ctx.window._ccbDetailData.used, 120000);
    assert.match(s.bar.innerHTML, />12%</);
  });

  it('较新的 feature 切换回到旧名称也能生效，不靠第三值猜测', async () => {
    const s = sandbox();
    await s.swap(model(2, 'b'));
    s.overview(model(3, 'a', { contextLength: 500000 }));
    assert.equal(s.modelLabel.textContent, 'a');
    assert.equal(s.ctx.window._ccbDetailData.contextLength, 500000);
    // 已追认后到达更老的 B 帧也不能回退。
    s.overview(model(2, 'b'));
    assert.equal(s.modelLabel.textContent, 'a');
  });

  it('同一 preset 的新窗口和阈值按版本整组更新', async () => {
    const s = sandbox();
    await s.swap(model(2, 'a', { contextLength: 1000000, compressRatio: 60 }));
    s.overview(model(1, 'a'));
    assert.equal(s.ctx.window._ccbDetailData.contextLength, 1000000);
    assert.equal(s.ctx.window._ccbDetailData.compressRatio, 60);
  });

  it('乱序回执不能覆盖更晚生效的模型状态', async () => {
    const s = sandbox();
    let resolve;
    s.ctx.ClawFeatureCommunication.request = () => new Promise((r) => { resolve = r; });
    const pending = s.ctx.run(`_performInputModelSwap('host-agent', 'b')`);
    s.overview(model(3, 'a', { thinkingEffort: 'high' }));
    resolve({ ok: true, meta: model(2, 'b') });
    await pending;
    assert.equal(s.modelLabel.textContent, 'a');
    assert.equal(s.effortLabel.textContent, 'high');
  });

  it('连续切模型再调思考强度，整组参数保持最新版本', async () => {
    const s = sandbox();
    await s.swap(model(2, 'b', { contextLength: 1000000, thinkingEffort: 'medium' }));
    await s.swap(model(3, 'b', { contextLength: 1000000, thinkingEffort: 'high' }), true);
    s.overview({ ...model(1, 'a'), usageStats: { lastRequestUsage: { inputTokens: 100000 } } });
    assert.equal(s.modelLabel.textContent, 'b');
    assert.equal(s.effortLabel.textContent, 'high');
    assert.equal(s.ctx.window._ccbDetailData.contextLength, 1000000);
    await s.swap(model(4, 'a', { contextLength: 500000 }));
    assert.equal(s.modelLabel.textContent, 'a');
    assert.equal(s.effortLabel.textContent, 'low');
    assert.match(s.bar.innerHTML, />20%</);
  });

  it('切回预设思考档时采用回执中的实际档位，旧 overview 不能恢复旧覆盖', async () => {
    const s = sandbox();
    await s.swap(model(2, 'a', { thinkingEffort: 'medium' }), true);
    s.overview(model(1, 'a', { thinkingEffort: 'high' }));
    assert.equal(s.ctx.run('_getCurrentThinkingEffort()'), 'medium');
    assert.equal(s.effortLabel.textContent, 'medium');
  });

  it('切换失败保持全部已生效状态', async () => {
    const s = sandbox();
    s.ctx.console = { error() {} };
    s.ctx.requestResult = { ok: false, error: 'rejected' };
    await s.ctx.run(`_performInputModelSwap('host-agent', 'b')`);
    assert.equal(s.modelLabel.textContent, 'a');
    assert.equal(s.ctx.window._ccbDetailData.contextLength, 200000);
  });

  it('默认（预设）操作发送 clearThinkingOverride，不发送 null 档位', async () => {
    const s = sandbox();
    s.ctx.run(`_performThinkingEffortSwap('host-agent', null)`);
    await new Promise(resolve => setImmediate(resolve));
    const [call] = s.ctx.ClawFeatureCommunication.calls;
    assert.equal(call.requestType, 'clearThinkingOverride');
    assert.deepEqual(JSON.parse(JSON.stringify(call.payload)), {});
  });

  it('请求期间离开再回到同一会话，旧回执由视图代次拒绝', async () => {
    const s = sandbox();
    let resolve;
    s.ctx.ClawFeatureCommunication.request = () => new Promise((r) => { resolve = r; });
    const pending = s.ctx.run(`_performInputModelSwap('host-agent', 'b')`);
    s.ctx.run(`applySessionViewPatch({ identity: { agentId: 'host-agent', sessionId: 'sess-2' } });
      applySessionViewPatch({ identity: { agentId: 'host-agent', sessionId: 'sess-1' } })`);
    s.overview(model(1, 'a'));
    resolve({ ok: true, meta: model(2, 'b') });
    await pending;
    assert.equal(s.modelLabel.textContent, 'a');
  });

  it('runtime 重启后新实例的低版本可以接管', async () => {
    const s = sandbox();
    await s.swap(model(10, 'b'));
    s.ctx.run(`currentRuntimeAgentId = 'rt-2'`);
    s.overview(model(0, 'a'));
    assert.equal(s.modelLabel.textContent, 'a');
    assert.equal(s.ctx.run('readCurrentSessionViewState().overview.modelRevision'), 0);
  });

  it('同步视图重置清空高版本状态，随后低版本快照可以接管', async () => {
    const s = sandbox();
    await s.swap(model(10, 'b'));
    s.ctx.run('applySessionViewPatch({ overview: getEmptyOverviewSnapshot() })');
    assert.equal(s.ctx.run('readCurrentSessionViewState().overview.modelRevision'), null);
    s.overview(model(1, 'a'));
    assert.equal(s.modelLabel.textContent, 'a');
  });

  it('同 runtime 的另一个 Session 缓存整组恢复，不受上一 Session 版本影响', async () => {
    const s = sandbox();
    await s.swap(model(10, 'b'));
    s.ctx.payload = model(1, 'a');
    s.ctx.run(`applySessionViewPatch({ overview: payload, sessionMeta: { sessionId: 'sess-2' } })`);
    s.render();
    assert.equal(s.modelLabel.textContent, 'a');
    assert.equal(s.ctx.run('readCurrentSessionViewState().overview.modelRevision'), 1);
    s.overview(model(2, 'a', { contextLength: 500000 }));
    assert.equal(s.ctx.window._ccbDetailData.contextLength, 500000);
  });

  it('模型缺失窗口时清空旧窗口，不拼出混合状态', async () => {
    const s = sandbox();
    await s.swap(model(2, 'b', { contextLength: null }));
    assert.equal(s.ctx.window._ccbDetailData.contextLength, 0);
    assert.match(s.bar.innerHTML, /ccb-token-empty/);
    assert.match(s.bar.innerHTML, /b-model/);
  });

  it('全局默认模型同链路显示实际名称', async () => {
    const s = sandbox();
    await s.swap(model(2, '__default__', { modelName: 'global-model' }));
    assert.equal(s.modelLabel.textContent, 'global-model');
    assert.match(s.bar.innerHTML, /global-model/);
  });

  it('已展开的详情随回执和用量快照刷新', async () => {
    const s = sandbox();
    s.ctx.run('_showCcbPopup()');
    assert.match(s.ctx.run('_ccbPopup.innerHTML'), /200\.0K/);
    await s.swap(model(2, 'b', { contextLength: 1000000, compressRatio: 70 }));
    assert.match(s.ctx.run('_ccbPopup.innerHTML'), /b-model/);
    assert.match(s.ctx.run('_ccbPopup.innerHTML'), /1\.0M/);
    assert.match(s.ctx.run('_ccbPopup.innerHTML'), /70%/);
    s.overview({ ...model(2, 'b', { contextLength: 1000000, compressRatio: 70 }), usageStats: { lastRequestUsage: { inputTokens: 150000 } } });
    assert.match(s.ctx.run('_ccbPopup.innerHTML'), /150\.0K/);
  });
});
