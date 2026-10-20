import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function sandbox(overview = null, preset = null) {
  const ctx = createFrontendSandbox({
    selectedFeatureName: null,
    getClawModelPresets: () => preset ? [preset] : [],
    getRuntimeAwareAgentRecord: () => ({ modelPresets: { default: { primary: 'a' } } }),
  });
  ctx.loadSource('public/src/modules/session-view-state.js');
  ctx.loadSource('public/src/modules/overview-data.js');
  ctx.loadSource('public/src/modules/input-model-switcher.js');
  ctx.payload = overview;
  ctx.run('applySessionViewPatch({ overview: payload })');
  return ctx;
}

describe('thinkingEffort 统一状态读取', () => {
  for (const thinkingEffort of ['high', 'xhigh', null, 'none']) {
    it(`快照保留 ${thinkingEffort} 并优先于预设默认`, () => {
      const ctx = sandbox({ modelRevision: 1, presetName: 'a', thinkingEffort }, { name: 'a', thinkingEffort: 'medium' });
      assert.equal(ctx.run('_getCurrentThinkingEffort()'), thinkingEffort);
    });
  }

  it('首份运行时状态到达之前可显示启动预设默认', () => {
    const ctx = sandbox(null, { name: 'a', thinkingEffort: 'medium' });
    assert.equal(ctx.run('_getCurrentThinkingEffort()'), 'medium');
  });

  it('无预设、无运行时数据时返回空档位', () => {
    const ctx = sandbox();
    assert.equal(ctx.run('_getCurrentThinkingEffort()'), null);
  });

  it('页面重载直接从快照恢复档位，不依赖本地缓存', () => {
    const ctx = sandbox({ modelRevision: 3, presetName: 'a', thinkingEffort: 'high' });
    assert.equal(ctx.run('_getCurrentThinkingEffort()'), 'high');
  });

  it('无版本的远程快照仍保留显式 null，不回填预设默认', () => {
    const ctx = sandbox({ modelName: 'a-model', presetName: 'a', thinkingEffort: null }, { name: 'a', thinkingEffort: 'medium' });
    assert.equal(ctx.run('_getCurrentThinkingEffort()'), null);
  });

  it('模型版本和完整参数经过归一化不会丢失', () => {
    const ctx = sandbox({ modelRevision: 4, modelName: 'b', presetName: 'a', provider: 'openai', thinkingEffort: 'high', contextLength: 1000000, compressRatio: 70 });
    const state = ctx.run('readCurrentSessionViewState().overview');
    assert.equal(state.modelRevision, 4);
    assert.equal(state.provider, 'openai');
    assert.equal(state.contextLength, 1000000);
    assert.equal(state.compressRatio, 70);
  });
});
