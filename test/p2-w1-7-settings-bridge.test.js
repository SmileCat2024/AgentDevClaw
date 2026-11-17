import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

/**
 * P2 消费方批次 7（模型 / 语音 / MCP 设置）的兼容面契约测试。
 *
 * 本批 6 个模块原位转 ESM 后，仍有 classic 消费方经全局键调用其中一部分函数。
 * 这些键必须走 KernelState 受控桥（defineKey 访问器 + claim 认领），不得退化为
 * 散装 `window.X = fn`——两者在 getter/setter 语义、桥债台账与终局撤桥能力上
 * 完全不同。本测试逐键钉住：
 *   - 访问器由 KernelState 注册（configurable / 非枚举，等同原顶层 let 行为）；
 *   - 键值就是模块的命名导出（同一函数引用）；
 *   - 认领后 classic 侧写入经 setter 转发进模块（双向语义不变）；
 *   - 零消费面的键不再挂 window（散装导出已随本批收敛）。
 *
 * 每个用例独立装载 kernel-state + 分发器 + 目标模块（装载器每次给入口唯一
 * query，模块级状态不跨用例共享）。
 */

const MODULES = {
  modelSettings: 'public/src/modules/model-settings.js',
  mcp: 'public/src/modules/mcp-gateway-ui.js',
  presetCache: 'public/src/modules/model-preset-cache.js',
  speechCache: 'public/src/modules/speech-config-cache.js',
  oauthFlow: 'public/src/modules/oauth-flow.js',
  speechSettings: 'public/src/modules/speech-settings.js',
};

async function withBatchHarness(names, fn) {
  return withP2EsmCase({
    globals: { fetch: async () => ({ ok: true, json: async () => ({}) }) },
    classic: (sandbox) => {
      prepareClassicSandbox(sandbox);
    },
  }, async (c) => {
    const modules = {};
    for (const name of names) modules[name] = await c.load(MODULES[name]);
    return fn(modules, c);
  });
}

/** 桥键判定：存在 get/set 访问器、configurable、非枚举，且值等于模块导出。 */
function isBridgeContractIntact(key, exported) {
  const descriptor = Object.getOwnPropertyDescriptor(window, key);
  if (!descriptor || typeof descriptor.get !== 'function' || typeof descriptor.set !== 'function') return false;
  if (descriptor.configurable !== true || descriptor.enumerable !== false) return false;
  return descriptor.get() === exported;
}

describe('批次 7 桥接期兼容面', () => {
  it('model-settings：设置入口三键经 KernelState 受控桥暴露', async () => {
    await withBatchHarness(['modelSettings'], async (modules) => {
      const { modelSettings } = modules;
      for (const key of ['openSettings', 'closeSettings', 'renderSettingsOverlay']) {
        assert.ok(isBridgeContractIntact(key, modelSettings[key]), `${key} 应经 defineKey 桥暴露且值等于模块导出`);
      }
      // 桥访问器非枚举（不进 for-in / Object.keys），与已撤除的顶层 let 行为一致
      assert.equal(Object.keys(window).includes('openSettings'), false, '桥键不进 Object.keys');
    });
  });

  it('model-preset-cache：仅三个 classic 消费键上桥，认领后 classic 写入经 setter 转发', async () => {
    await withBatchHarness(['presetCache'], async (modules) => {
      const { presetCache } = modules;
      for (const key of ['getClawModelPresets', 'setClawModelPresets', 'ensureClawModelPresets']) {
        assert.ok(isBridgeContractIntact(key, presetCache[key]), `${key} 应经 defineKey 桥暴露`);
      }
      // 认领后 classic 写方的赋值转发进模块桥面（双向语义），兄弟键不受影响
      const replacement = () => [{ name: 'from-classic' }];
      window.setClawModelPresets = replacement;
      assert.equal(window.setClawModelPresets, replacement, '认领后写入应被接管');
      assert.equal(window.getClawModelPresets, presetCache.getClawModelPresets, '未写过的键仍解析到模块导出');

      // 纯 ESM 消费的两个键不再发布到 window（只有 input-model-switcher 的 import）
      for (const key of ['clawModelPresetsMatchSession', 'ensureClawModelPresetsForSession']) {
        assert.equal(Object.getOwnPropertyDescriptor(window, key), undefined, `${key} 只有 ESM 消费方，不应上桥`);
      }
      // 命名导出照常可用：真实调用，不经 window
      const cached = [{ name: 'from-owner' }];
      presetCache.setClawModelPresets(cached, 'rt-1');
      assert.equal(presetCache.clawModelPresetsMatchSession('rt-1'), true, 'clawModelPresetsMatchSession 导出可用');
      assert.deepEqual(await presetCache.ensureClawModelPresetsForSession('rt-1'), cached,
        'ensureClawModelPresetsForSession 导出可用（会话命中不发起请求）');
    });
  });

  it('speech-config-cache：只有 ensureClawSpeechModelConfig 有 classic 消费方，其余键不再挂 window', async () => {
    await withBatchHarness(['speechCache'], async (modules) => {
      const { speechCache } = modules;
      assert.ok(isBridgeContractIntact('ensureClawSpeechModelConfig', speechCache.ensureClawSpeechModelConfig));
      for (const key of ['getClawSpeechModelConfig', 'setClawSpeechModelConfig', 'getClawSpeechPresets', 'setClawSpeechPresets']) {
        assert.equal(Object.getOwnPropertyDescriptor(window, key), undefined, `${key} 无可达 classic 消费方，不应上桥`);
        assert.equal(typeof speechCache[key], 'function', `${key} 仍以命名导出供批内 import`);
      }
    });
  });

  it('mcp-gateway-ui：openMcpGateway 上桥，私有动作键不再泄漏到 window', async () => {
    await withBatchHarness(['mcp'], async (modules) => {
      const { mcp } = modules;
      assert.ok(isBridgeContractIntact('openMcpGateway', mcp.openMcpGateway));
      for (const key of ['_loadGatewayData', '_gatewayRestart', '_gatewayViewDetail', '_toggleGatewaySchema', 'closeMcpGateway']) {
        assert.equal(Object.getOwnPropertyDescriptor(window, key), undefined, `${key} 已收敛为模块私有，不应挂 window`);
      }
    });
  });

  it('oauth-flow / speech-settings：内部动作只经模块导出，不再散装挂 window', async () => {
    await withBatchHarness(['oauthFlow', 'speechSettings'], async (modules) => {
      const { oauthFlow, speechSettings } = modules;
      for (const key of ['startOAuthLogin', 'onProtocolChange', 'onOpenCodeTierChange', 'fetchOpenCodeModels', 'onOpenCodeModelSelect', '_oauthPollTimer']) {
        assert.equal(Object.getOwnPropertyDescriptor(window, key), undefined, `${key} 不应挂 window`);
      }
      for (const key of ['addSpeechPreset', 'cancelSpeechPresetEdit', 'saveSpeechPreset']) {
        assert.equal(Object.getOwnPropertyDescriptor(window, key), undefined, `${key} 不应挂 window`);
      }
      assert.equal(typeof oauthFlow.startOAuthLogin, 'function');
      // 轮询定时器的唯一 owner 在 oauth-flow：跨模块的清停经该命名导出，不再直写定时器变量
      assert.equal(typeof oauthFlow.stopOAuthPolling, 'function');
      assert.equal(typeof speechSettings.addSpeechPreset, 'function');
      assert.equal(typeof speechSettings.saveSpeechPreset, 'function');
    });
  });
});
