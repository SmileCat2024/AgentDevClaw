import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * model-preset-cache.js — window.ClawFW._modelPresets / _modelPresetsRuntimeId
 * 的唯一写方（owner 模块）契约测试。
 *
 * 收敛前：7 个写点分散在 5 个文件（app-ui / chat-context-bar /
 * input-model-switcher / model-settings / ph-project-actions），全局写入
 * 不触碰会话标记，远程会话存在串列表风险（ADR-0011）。
 *
 * 本测试锁定的语义修正：不带会话身份的写入会清除会话标记——全局数据
 * 不属于任何会话缓存，不能让旧标记误命中。
 */

// vm 沙箱内创建的对象原型属于 sandbox realm，deepStrictEqual 会因原型
// 不同判不等；断言前经 JSON 往返归一到主 realm 的普通对象。
const plain = (value) => JSON.parse(JSON.stringify(value));

function createCacheSandbox(fetchImpl) {
  const ctx = createFrontendSandbox({ fetch: fetchImpl });
  ctx.loadSource('public/src/modules/model-preset-cache.js');
  return ctx;
}

const PRESETS_A = [{ name: 'p1', model: 'm1' }, { name: 'p2', model: 'm2' }];
const PRESETS_B = [{ name: 'p3', model: 'm3' }];

describe('model-preset-cache：基础读写', () => {
  it('初始状态：getter 返回空数组，任何会话不命中', () => {
    const ctx = createCacheSandbox(async () => { throw new Error('should not fetch'); });
    assert.deepEqual(plain(ctx.run('getClawModelPresets()')), []);
    assert.equal(ctx.run('clawModelPresetsMatchSession("rt-1")'), false);
  });

  it('带会话身份写入：标记该会话命中，其他会话不命中', () => {
    const ctx = createCacheSandbox(async () => { throw new Error('should not fetch'); });
    ctx.run(`setClawModelPresets(${JSON.stringify(PRESETS_A)}, 'rt-1')`);
    assert.deepEqual(plain(ctx.run('getClawModelPresets()')), PRESETS_A);
    assert.equal(ctx.run('clawModelPresetsMatchSession("rt-1")'), true);
    assert.equal(ctx.run('clawModelPresetsMatchSession("rt-2")'), false);
  });

  it('不带会话身份写入：清除会话标记（修正全局写入残留旧标记的裂缝）', () => {
    const ctx = createCacheSandbox(async () => { throw new Error('should not fetch'); });
    ctx.run(`setClawModelPresets(${JSON.stringify(PRESETS_A)}, 'rt-1')`);
    ctx.run(`setClawModelPresets(${JSON.stringify(PRESETS_B)})`);
    assert.deepEqual(plain(ctx.run('getClawModelPresets()')), PRESETS_B);
    assert.equal(ctx.run('clawModelPresetsMatchSession("rt-1")'), false);
  });

  it('空 presets 即使带会话身份写入也不命中（保持原 length>0 守卫）', () => {
    const ctx = createCacheSandbox(async () => { throw new Error('should not fetch'); });
    ctx.run('setClawModelPresets([], "rt-1")');
    assert.equal(ctx.run('clawModelPresetsMatchSession("rt-1")'), false);
  });
});

describe('model-preset-cache：会话懒加载 ensureClawModelPresetsForSession', () => {
  it('缓存未命中：fetch 带 agentId 参数，写入并返回', async () => {
    const urls = [];
    const ctx = createCacheSandbox(async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ presets: PRESETS_A }) };
    });
    const presets = await ctx.run(`ensureClawModelPresetsForSession('rt-1')`);
    assert.deepEqual(plain(presets), PRESETS_A);
    assert.deepEqual(urls, ['/protoclaw/model_config?agentId=rt-1']);
    assert.equal(ctx.run('clawModelPresetsMatchSession("rt-1")'), true);
  });

  it('缓存命中：不再 fetch，直接返回缓存', async () => {
    const urls = [];
    const ctx = createCacheSandbox(async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ presets: PRESETS_A }) };
    });
    await ctx.run(`ensureClawModelPresetsForSession('rt-1')`);
    const again = await ctx.run(`ensureClawModelPresetsForSession('rt-1')`);
    assert.deepEqual(plain(again), PRESETS_A);
    assert.equal(urls.length, 1);
  });

  it('会话切换（runtimeId 变化）：重新 fetch 并更新标记', async () => {
    const urls = [];
    const ctx = createCacheSandbox(async (url) => {
      urls.push(String(url));
      const rt = String(url).includes('rt-2') ? PRESETS_B : PRESETS_A;
      return { ok: true, json: async () => ({ presets: rt }) };
    });
    await ctx.run(`ensureClawModelPresetsForSession('rt-1')`);
    const switched = await ctx.run(`ensureClawModelPresetsForSession('rt-2')`);
    assert.deepEqual(plain(switched), PRESETS_B);
    assert.deepEqual(plain(ctx.run('getClawModelPresets()')), PRESETS_B);
    assert.equal(urls.length, 2);
  });

  it('runtimeId 为空串：fetch 不带 agentId 查询参数', async () => {
    const urls = [];
    const ctx = createCacheSandbox(async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ presets: PRESETS_A }) };
    });
    await ctx.run(`ensureClawModelPresetsForSession('')`);
    assert.deepEqual(urls, ['/protoclaw/model_config']);
  });

  it('响应 JSON 解析失败：异常向上抛且不写缓存', async () => {
    const ctx = createCacheSandbox(async () => ({
      ok: true,
      json: async () => { throw new Error('bad json'); },
    }));
    await assert.rejects(
      () => ctx.run(`ensureClawModelPresetsForSession('rt-1')`),
      /bad json/,
    );
    assert.deepEqual(plain(ctx.run('getClawModelPresets()')), []);
  });
});

describe('model-preset-cache：全局懒加载 ensureClawModelPresets（app-ui 语义）', () => {
  it('缓存 falsy：fetch 不带参数，成功后写入', async () => {
    const urls = [];
    const ctx = createCacheSandbox(async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ presets: PRESETS_A }) };
    });
    const presets = await ctx.run('ensureClawModelPresets()');
    assert.deepEqual(plain(presets), PRESETS_A);
    assert.deepEqual(urls, ['/protoclaw/model_config']);
  });

  it('已初始化（含空数组）：不重复 fetch', async () => {
    const urls = [];
    const ctx = createCacheSandbox(async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ presets: [] }) };
    });
    await ctx.run('ensureClawModelPresets()');
    const again = await ctx.run('ensureClawModelPresets()');
    assert.deepEqual(plain(again), []);
    assert.equal(urls.length, 1);
  });

  it('fetch 失败：静默写空数组不抛错（原 app-ui catch 语义）', async () => {
    const ctx = createCacheSandbox(async () => { throw new Error('network down'); });
    const presets = await ctx.run('ensureClawModelPresets()');
    assert.deepEqual(plain(presets), []);
    assert.deepEqual(plain(ctx.run('getClawModelPresets()')), []);
  });
});
