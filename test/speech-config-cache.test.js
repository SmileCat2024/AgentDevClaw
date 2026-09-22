import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * speech-config-cache.js — window.ClawFW._speechModelConfig / _speechPresets
 * 的唯一写方（owner 模块）契约测试。
 *
 * 收敛前写点分散在 5 个文件：model-settings（面板开/关）、speech-settings
 * （preset 编辑/保存）、voice-input / wg-voice-input / work-group-ui（三份
 * 逐字重复的懒加载：缓存 miss → GET speech_model_config → 写入）。
 */

// vm 沙箱内创建的对象原型属于 sandbox realm，deepStrictEqual 会因原型
// 不同判不等；断言前经 JSON 往返归一到主 realm 的普通对象。
const plain = (value) => JSON.parse(JSON.stringify(value));

function createCacheSandbox(fetchImpl) {
  const ctx = createFrontendSandbox({ fetch: fetchImpl });
  ctx.loadSource('public/src/modules/speech-config-cache.js');
  return ctx;
}

const SPEECH_MODEL = { baseUrl: 'https://api.example.com', apiKey: 'sk-x', model: 'whisper', language: 'auto' };

describe('speech-config-cache：基础读写', () => {
  it('初始状态：config 为 null，presets 为空数组', () => {
    const ctx = createCacheSandbox(async () => { throw new Error('should not fetch'); });
    assert.equal(ctx.run('getClawSpeechModelConfig()'), null);
    assert.deepEqual(plain(ctx.run('getClawSpeechPresets()')), []);
  });

  it('setter / getter 往返', () => {
    const ctx = createCacheSandbox(async () => { throw new Error('should not fetch'); });
    ctx.run(`setClawSpeechModelConfig(${JSON.stringify(SPEECH_MODEL)})`);
    ctx.run(`setClawSpeechPresets(${JSON.stringify([SPEECH_MODEL])})`);
    assert.deepEqual(plain(ctx.run('getClawSpeechModelConfig()')), SPEECH_MODEL);
    assert.deepEqual(plain(ctx.run('getClawSpeechPresets()')), [SPEECH_MODEL]);
  });

  it('setClawSpeechModelConfig(null) 归一为 null；presets 非数组归一为 []', () => {
    const ctx = createCacheSandbox(async () => { throw new Error('should not fetch'); });
    ctx.run('setClawSpeechModelConfig(undefined)');
    ctx.run('setClawSpeechPresets("oops")');
    assert.equal(ctx.run('getClawSpeechModelConfig()'), null);
    assert.deepEqual(plain(ctx.run('getClawSpeechPresets()')), []);
  });

  it('presets 原地修改后写回可读到（speech-settings 的 splice 用法）', () => {
    const ctx = createCacheSandbox(async () => { throw new Error('should not fetch'); });
    ctx.run(`setClawSpeechPresets(${JSON.stringify([SPEECH_MODEL, { name: 'p2' }])})`);
    ctx.run(`
      const list = getClawSpeechPresets();
      list.splice(0, 1);
      setClawSpeechPresets(list);
    `);
    assert.deepEqual(plain(ctx.run('getClawSpeechPresets()')), [{ name: 'p2' }]);
  });
});

describe('speech-config-cache：懒加载 ensureClawSpeechModelConfig', () => {
  it('缓存完整（baseUrl + apiKey）：不 fetch 直接返回', async () => {
    const urls = [];
    const ctx = createCacheSandbox(async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ speechModel: SPEECH_MODEL }) };
    });
    ctx.run(`setClawSpeechModelConfig(${JSON.stringify(SPEECH_MODEL)})`);
    const config = await ctx.run('ensureClawSpeechModelConfig()');
    assert.deepEqual(plain(config), SPEECH_MODEL);
    assert.equal(urls.length, 0);
  });

  it('缓存 miss：fetch speech_model_config，写入并返回', async () => {
    const urls = [];
    const ctx = createCacheSandbox(async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ speechModel: SPEECH_MODEL }) };
    });
    const config = await ctx.run('ensureClawSpeechModelConfig()');
    assert.deepEqual(plain(config), SPEECH_MODEL);
    assert.deepEqual(urls, ['/protoclaw/speech_model_config']);
    assert.deepEqual(plain(ctx.run('getClawSpeechModelConfig()')), SPEECH_MODEL);
  });

  it('缓存的 speechModel 不完整（缺 apiKey）：仍视为 miss 重新 fetch', async () => {
    const urls = [];
    const ctx = createCacheSandbox(async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ speechModel: SPEECH_MODEL }) };
    });
    ctx.run(`setClawSpeechModelConfig(${JSON.stringify({ baseUrl: 'https://x', model: 'y' })})`);
    await ctx.run('ensureClawSpeechModelConfig()');
    assert.equal(urls.length, 1);
  });

  it('fetch 抛错：返回 null 且不写缓存（调用方据此提示未配置）', async () => {
    const ctx = createCacheSandbox(async () => { throw new Error('network down'); });
    const config = await ctx.run('ensureClawSpeechModelConfig()');
    assert.equal(config, null);
    assert.equal(ctx.run('getClawSpeechModelConfig()'), null);
  });

  it('响应含不完整的 speechModel：无条件写入并返回，完整性判断留给调用方', async () => {
    const ctx = createCacheSandbox(async () => ({
      ok: true,
      json: async () => ({ speechModel: { baseUrl: 'https://x' } }),
    }));
    const config = await ctx.run('ensureClawSpeechModelConfig()');
    assert.deepEqual(plain(config), { baseUrl: 'https://x' });
    assert.deepEqual(plain(ctx.run('getClawSpeechModelConfig()')), { baseUrl: 'https://x' });
  });
});
