import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

/**
 * speech-config-cache.js — 「语音识别模型配置」缓存 owner 模块契约测试。
 *
 * 缓存物理状态是模块私有（原 window.ClawFW._speechModelConfig /
 * _speechPresets 袋键已撤除，无镜像）：断言一律走 owner 的命名导出，
 * 不经 ClawFW 袋读写。
 *
 * 收敛前写点分散在 5 个文件：model-settings（面板开/关）、speech-settings
 * （preset 编辑/保存）、voice-input / wg-voice-input / work-group-ui（三份
 * 逐字重复的懒加载：缓存 miss → GET speech_model_config → 写入）。
 *
 * 装载路线（ESM 迁移配方第三节）：真实 import + 最小 window/document 桩；
 * 模块求值期经 window.KernelState 注册受控桥，先装真实 kernel-state。
 */

async function createCacheHarness(fetchImpl) {
  const prevFetch = globalThis.fetch;
  const cleanupGlobals = installBrowserStubs();
  globalThis.fetch = fetchImpl;
  try {
    // 内核桥先装载（生产 classic 先行语义）；装载失败也必须恢复桩
    await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
    const { module } = await loadModuleOnce('public/src/modules/speech-config-cache.js', { installGlobals: false });
    return {
      module,
      cleanup() {
        globalThis.fetch = prevFetch;
        cleanupGlobals();
      },
    };
  } catch (err) {
    globalThis.fetch = prevFetch;
    cleanupGlobals();
    throw err;
  }
}

const SPEECH_MODEL = { baseUrl: 'https://api.example.com', apiKey: 'sk-x', model: 'whisper', language: 'auto' };
const noFetch = async () => { throw new Error('should not fetch'); };

describe('speech-config-cache：基础读写', () => {
  it('初始状态：config 为 null，presets 为空数组', async () => {
    const h = await createCacheHarness(noFetch);
    try {
      assert.equal(h.module.getClawSpeechModelConfig(), null);
      assert.deepEqual(h.module.getClawSpeechPresets(), []);
    } finally {
      h.cleanup();
    }
  });

  it('物理状态私有：写读都不在 window.ClawFW 袋上留痕（无镜像）', async () => {
    const h = await createCacheHarness(noFetch);
    try {
      h.module.setClawSpeechModelConfig(SPEECH_MODEL);
      h.module.setClawSpeechPresets([SPEECH_MODEL]);
      assert.deepEqual(h.module.getClawSpeechModelConfig(), SPEECH_MODEL);
      const bag = globalThis.window.ClawFW;
      assert.equal(bag?._speechModelConfig, undefined, 'ClawFW 袋上不应有配置镜像');
      assert.equal(bag?._speechPresets, undefined, 'ClawFW 袋上不应有预设镜像');
    } finally {
      h.cleanup();
    }
  });

  it('setter / getter 往返', async () => {
    const h = await createCacheHarness(noFetch);
    try {
      h.module.setClawSpeechModelConfig(SPEECH_MODEL);
      h.module.setClawSpeechPresets([SPEECH_MODEL]);
      assert.deepEqual(h.module.getClawSpeechModelConfig(), SPEECH_MODEL);
      assert.deepEqual(h.module.getClawSpeechPresets(), [SPEECH_MODEL]);
    } finally {
      h.cleanup();
    }
  });

  it('setClawSpeechModelConfig(null) 归一为 null；presets 非数组归一为 []', async () => {
    const h = await createCacheHarness(noFetch);
    try {
      h.module.setClawSpeechModelConfig(undefined);
      h.module.setClawSpeechPresets('oops');
      assert.equal(h.module.getClawSpeechModelConfig(), null);
      assert.deepEqual(h.module.getClawSpeechPresets(), []);
    } finally {
      h.cleanup();
    }
  });

  it('presets 原地修改后写回可读到（speech-settings 的 splice 用法）', async () => {
    const h = await createCacheHarness(noFetch);
    try {
      h.module.setClawSpeechPresets([SPEECH_MODEL, { name: 'p2' }]);
      const list = h.module.getClawSpeechPresets();
      list.splice(0, 1);
      h.module.setClawSpeechPresets(list);
      assert.deepEqual(h.module.getClawSpeechPresets(), [{ name: 'p2' }]);
    } finally {
      h.cleanup();
    }
  });
});

describe('speech-config-cache：懒加载 ensureClawSpeechModelConfig', () => {
  it('缓存完整（baseUrl + apiKey）：不 fetch 直接返回', async () => {
    const urls = [];
    const h = await createCacheHarness(async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ speechModel: SPEECH_MODEL }) };
    });
    try {
      h.module.setClawSpeechModelConfig(SPEECH_MODEL);
      const config = await h.module.ensureClawSpeechModelConfig();
      assert.deepEqual(config, SPEECH_MODEL);
      assert.equal(urls.length, 0);
    } finally {
      h.cleanup();
    }
  });

  it('缓存 miss：fetch speech_model_config，写入并返回', async () => {
    const urls = [];
    const h = await createCacheHarness(async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ speechModel: SPEECH_MODEL }) };
    });
    try {
      const config = await h.module.ensureClawSpeechModelConfig();
      assert.deepEqual(config, SPEECH_MODEL);
      assert.deepEqual(urls, ['/protoclaw/speech_model_config']);
      assert.deepEqual(h.module.getClawSpeechModelConfig(), SPEECH_MODEL);
    } finally {
      h.cleanup();
    }
  });

  it('缓存的 speechModel 不完整（缺 apiKey）：仍视为 miss 重新 fetch', async () => {
    const urls = [];
    const h = await createCacheHarness(async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ speechModel: SPEECH_MODEL }) };
    });
    try {
      h.module.setClawSpeechModelConfig({ baseUrl: 'https://x', model: 'y' });
      await h.module.ensureClawSpeechModelConfig();
      assert.equal(urls.length, 1);
    } finally {
      h.cleanup();
    }
  });

  it('fetch 抛错：返回 null 且不写缓存（调用方据此提示未配置）', async () => {
    const h = await createCacheHarness(async () => { throw new Error('network down'); });
    try {
      const config = await h.module.ensureClawSpeechModelConfig();
      assert.equal(config, null);
      assert.equal(h.module.getClawSpeechModelConfig(), null);
    } finally {
      h.cleanup();
    }
  });

  it('响应含不完整的 speechModel：无条件写入并返回，完整性判断留给调用方', async () => {
    const h = await createCacheHarness(async () => ({
      ok: true,
      json: async () => ({ speechModel: { baseUrl: 'https://x' } }),
    }));
    try {
      const config = await h.module.ensureClawSpeechModelConfig();
      assert.deepEqual(config, { baseUrl: 'https://x' });
      assert.deepEqual(h.module.getClawSpeechModelConfig(), { baseUrl: 'https://x' });
    } finally {
      h.cleanup();
    }
  });
});
