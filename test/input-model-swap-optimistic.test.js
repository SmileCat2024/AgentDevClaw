import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { BasicAgent } from '@agentdevjs/core';
import { ModelSelectionFeature } from '../local-features/dist/model-selection/src/index.js';
import { createFrontendSandbox, sourceBetween } from './helpers/frontend-vm.js';

// 真实状态写入入口 + 切换请求 + 顶栏/详情渲染，隔离网络和用户数据。
const model = (modelRevision, name, extra = {}) => ({
  modelRevision, presetName: name, modelName: name + '-model',
  thinkingEffort: 'low', provider: 'anthropic', contextLength: 200000, compressRatio: 80,
  ...extra,
});

function sandbox() {
  function element() {
    const classes = new Set();
    const listeners = {};
    return { innerHTML: '', textContent: '', style: {}, dataset: {}, title: '', listeners,
      classList: { add: (v) => classes.add(v), remove: (v) => classes.delete(v), contains: (v) => classes.has(v) },
      addEventListener(type, listener) { listeners[type] = listener; },
      remove() {}, getBoundingClientRect: () => ({ left: 100, top: 200, bottom: 230 }),
    };
  }
  const bar = element(), modelLabel = element(), effortLabel = element(), effortButton = element(), modelButton = element();
  const ctx = createFrontendSandbox({
    currentRuntimeAgentId: 'rt-1', focusedAgentId: 'host-agent', selectedFeatureName: null,
    getCurrentHostAgentRecord: () => ({ id: 'host-agent' }),
    getActiveWorkspaceSessionId: () => 'sess-1',
    getRuntimeAwareAgentRecord: () => ({ id: 'host-agent' }),
    formatPresetDisplayName: (name) => name,
    ClawToast: {
      messages: [],
      show(value) { this.messages.push(value); },
      update(id, patch) { this.messages.push({ ...patch, id }); },
    },
    ClawFeatureCommunication: {
      listChannels: async () => [{ featureId: 'model-selection', channelId: 'selection' }],
      calls: [],
      request: async (target, requestType, payload) => {
        ctx.ClawFeatureCommunication.calls.push({ target, requestType, payload });
        if (ctx.requestError) throw ctx.requestError;
        return ctx.requestResult ?? { ok: true, meta: model(1, 'a') };
      },
    },
    getClawModelPresets: () => ['a', 'b', '__default__'].map((name) => ({ name, thinkingEffort: 'low' })),
    clawModelPresetsMatchSession: () => true,
    ensureClawModelPresetsForSession: async () => [{ name: 'a' }, { name: 'b' }],
    requestAnimationFrame() {},
    shouldRenderWorkspaceSurface: () => false,
    isChatSurfaceActive: () => true,
    notifyChatViewportMutation() {}, followLatestEnabled: false, container: { scrollTop: 0 },
    document: {
      querySelector: (s) => s === '.input-model-name' ? modelLabel : s === '.input-thinking-name' ? effortLabel : null,
      getElementById: (id) => id === 'chat-context-bar' ? bar : id === 'input-thinking-btn' ? effortButton : id === 'input-model-switch-btn' ? modelButton : null,
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
  return { ctx, bar, modelLabel, effortLabel, modelButton, overview, swap, render };
}

describe('模型状态统一提交与呈现', () => {
  it('无 model-selection 通道时当前会话不可切换', async () => {
    const s = sandbox();
    s.ctx.ClawFeatureCommunication.listChannels = async () => [{ featureId: 'shell', channelId: 'task-1' }];
    assert.equal(await s.ctx.run(`_ensureModelSelectionChannel('host-agent')`), false);
    assert.equal(s.ctx.ClawFeatureCommunication.calls.length, 0, '通道缺失时不得投递模型选择请求');
  });

  it('会话已选中但 runtime 尚未恢复时，提示加载中而非会话不支持', async () => {
    const s = sandbox();
    s.ctx.currentRuntimeAgentId = null;
    const before = s.ctx.ClawToast.messages.length;
    await s.ctx.window.toggleInputModelDropdown();
    const message = s.ctx.ClawToast.messages.at(-1);
    assert.equal(message?.title, '会话正在加载，请稍后再试');
    assert.notEqual(message?.title, '当前会话不支持模型切换');
    assert.equal(s.ctx.ClawFeatureCommunication.calls.length, 0, 'runtime 尚未就绪时不能投递模型请求');
    assert.equal(s.ctx.ClawToast.messages.length, before + 1);
  });

  it('会话操作冲突时模型下拉提示稍后重试，不误报会话不支持', async () => {
    const s = sandbox();
    const error = Object.assign(new Error('Session is busy with open'), {
      status: 409,
      code: 'session_operation_in_progress',
    });
    s.ctx.requestError = error;
    const pending = s.ctx.window.toggleInputModelDropdown();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.ctx.ClawFeatureCommunication.calls[0]?.requestType, 'getStatus', '菜单可用性检查应实际执行状态请求');
    await pending;
    assert.equal(s.ctx.run('_inputModelDropdown'), null, '被会话操作闸拒绝时不应展示可操作菜单');
    assert.equal(s.ctx.ClawToast.messages.at(-1)?.title, '会话正在切换，请稍后重试');
    assert.notEqual(s.ctx.ClawToast.messages.at(-1)?.title, '当前会话不支持模型切换');
    assert.deepEqual(s.ctx.ClawFeatureCommunication.calls.map(call => call.requestType), ['getStatus']);
  });

  it('选择模型遇到会话操作冲突时提示稍后重试，且不显示模型已切换', async () => {
    const s = sandbox();
    s.ctx.requestError = Object.assign(new Error('Session is busy with open'), {
      status: 409,
      code: 'session_operation_in_progress',
    });
    await s.ctx.run(`_performInputModelSwap('host-agent', 'b')`);
    const finalToast = s.ctx.ClawToast.messages.at(-1);
    assert.equal(finalToast?.title, '会话正在切换，请稍后重试');
    assert.notEqual(finalToast?.title, '模型已切换');
    assert.equal(s.ctx.run('readCurrentSessionViewState().overview.presetName'), 'a');
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

  it('模型、显式档位和默认档位均使用当前视图身份，不跟随宿主 active', async () => {
    const s = sandbox();
    s.ctx.getActiveWorkspaceSessionId = () => 'other-session';
    await s.swap(model(2, 'b'));
    await s.swap(model(3, 'b', { thinkingEffort: 'high' }), true);
    await s.ctx.run(`_performThinkingEffortSwap('host-agent', null)`);
    assert.deepEqual(s.ctx.ClawFeatureCommunication.calls.map(call => call.target.sessionId), ['sess-1', 'sess-1', 'sess-1']);
  });

  it('通道查询使用当前视图身份，不查询宿主 active', async () => {
    const s = sandbox();
    s.ctx.getActiveWorkspaceSessionId = () => 'other-session';
    const queries = [];
    s.ctx.ClawFeatureCommunication.listChannels = async (agentId, sessionId) => {
      queries.push({ agentId, sessionId });
      return [{ featureId: 'model-selection', channelId: 'selection' }];
    };
    assert.equal(await s.ctx.run(`_ensureModelSelectionChannel('host-agent')`), true);
    assert.deepEqual(queries, [{ agentId: 'host-agent', sessionId: 'sess-1' }]);
  });

  it('视图身份缺失或宿主不匹配时不回退到 active，也不接受高版本回执', async () => {
    const s = sandbox();
    s.ctx.run(`applySessionViewPatch({ identity: { agentId: 'other-host', sessionId: 'sess-1' } })`);
    await s.swap(model(100, 'b'));
    s.ctx.run(`applySessionViewPatch({ identity: { agentId: 'host-agent', sessionId: '' } })`);
    await s.swap(model(100, 'b'));
    assert.equal(s.ctx.ClawFeatureCommunication.calls.length, 0);
    assert.notEqual(s.ctx.run('readCurrentSessionViewState().overview.modelName'), 'b-model');
  });

  for (const kind of ['model', 'thinking']) {
    const toggle = kind === 'model' ? 'toggleInputModelDropdown' : 'toggleThinkingEffortDropdown';
    const dropdown = kind === 'model' ? '_inputModelDropdown' : '_inputThinkingDropdown';
    it(`${kind} 下拉查询期间离开再返回，不创建旧菜单或向新身份发请求`, async () => {
      const s = sandbox();
      let resolve;
      s.ctx.ClawFeatureCommunication.listChannels = () => new Promise(r => { resolve = r; });
      const pending = s.ctx.window[toggle]();
      s.ctx.run(`applySessionViewPatch({ identity: { agentId: 'host-agent', sessionId: 'sess-2' } });
        applySessionViewPatch({ identity: { agentId: 'host-agent', sessionId: 'sess-1' } })`);
      resolve([{ featureId: 'model-selection', channelId: 'selection' }]);
      await pending;
      assert.equal(s.ctx.run(dropdown), null);
      assert.equal(s.ctx.ClawFeatureCommunication.calls.length, 0);
    });

    it(`${kind} 已打开菜单在切换会话后点击，不修改新旧任一会话`, async () => {
      const s = sandbox();
      await s.ctx.window[toggle]();
      const menu = s.ctx.run(dropdown);
      assert.ok(menu, '当前会话正常打开选择菜单');
      s.ctx.ClawFeatureCommunication.calls.length = 0;
      s.ctx.run(`applySessionViewPatch({ identity: { agentId: 'host-agent', sessionId: 'sess-2' } })`);
      menu.listeners.click({ target: { closest: selector => selector === '.ccb-md-item' ? { dataset: { preset: 'b', effort: 'high' } } : null } });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(s.ctx.ClawFeatureCommunication.calls.length, 0);
    });
  }

  it('预设目录加载期间切换会话，不把旧目录菜单挂到新会话', async () => {
    const s = sandbox();
    let resolvePresets;
    let started;
    const loading = new Promise(resolve => { started = resolve; });
    s.ctx.ensureClawModelPresetsForSession = () => {
      started();
      return new Promise(resolve => { resolvePresets = resolve; });
    };
    const pending = s.ctx.window.toggleInputModelDropdown();
    await loading;
    s.ctx.run(`applySessionViewPatch({ identity: { agentId: 'host-agent', sessionId: 'sess-2' } })`);
    resolvePresets([{ name: 'b' }]);
    await pending;
    assert.equal(s.ctx.run('_inputModelDropdown'), null);
    assert.equal(s.ctx.ClawFeatureCommunication.calls.filter(call => call.requestType === 'selectModel').length, 0);
  });

  it('相同会话 runtime 更换后，旧实例的高版本回执不能污染新实例', async () => {
    const s = sandbox();
    let resolve;
    s.ctx.ClawFeatureCommunication.request = () => new Promise(r => { resolve = r; });
    const pending = s.ctx.run(`_performInputModelSwap('host-agent', 'b')`);
    s.ctx.run(`currentRuntimeAgentId = 'rt-2'`);
    s.overview(model(1, 'a'));
    resolve({ ok: true, meta: model(100, 'b') });
    await pending;
    assert.equal(s.modelLabel.textContent, 'a');
    assert.equal(s.ctx.run('readCurrentSessionViewState().overview.modelRevision'), 1);
  });

  it('当前视图与宿主 active 不同时，下一轮真正调用新模型且不改变另一个会话', async () => {
    const s = sandbox();
    // 身份派生使用生产代码，保留 host.active 与 viewer 绑定不一致的真实场景。
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
      s.ctx.ClawFeatureCommunication.request = (target, type, payload) => features.get(target.sessionId).onHostRequest(type, payload);
      await s.ctx.run(`_performInputModelSwap('host-agent', 'b')`);
      await s.ctx.run(`_performThinkingEffortSwap('host-agent', 'high')`);
      for (const agent of agents.values()) await agent.onCall('after');
      assert.deepEqual(calls['sess-1'], [{ name: 'a', thinkingEffort: 'low' }, { name: 'b', thinkingEffort: 'high' }]);
      assert.deepEqual(calls['sess-2'], [{ name: 'a', thinkingEffort: 'low' }, { name: 'a', thinkingEffort: 'low' }]);
      assert.equal(s.modelLabel.textContent, 'b');
      assert.equal(s.effortLabel.textContent, 'high');
      s.overview(agents.get('sess-1').getLLMMeta());
      assert.equal(s.modelLabel.textContent, 'b', '实际 Agent 状态与显示保持一致');
    } finally {
      for (const agent of agents.values()) await agent.dispose();
    }
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
