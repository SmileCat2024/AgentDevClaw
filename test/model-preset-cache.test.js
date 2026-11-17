import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

/**
 * model-preset-cache.js — 「模型预设列表」缓存 owner 模块契约测试。
 *
 * 缓存物理状态是模块私有（原 window.ClawFW._modelPresets /
 * _modelPresetsRuntimeId 袋键已撤除，无镜像）：断言一律走 owner 的命名导出，
 * 不经 ClawFW 袋读写。
 *
 * 收敛前：7 个写点分散在 5 个文件（app-ui / chat-context-bar /
 * input-model-switcher / model-settings / ph-project-actions），全局写入
 * 不触碰会话标记，远程会话存在串列表风险（ADR-0011）。
 *
 * 本测试锁定的语义修正：不带会话身份的写入会清除会话标记——全局数据
 * 不属于任何会话缓存，不能让旧标记误命中。
 *
 * 装载路线（ESM 迁移配方第三节）：真实 import（esm-module-loader）+ 最小
 * window/document 桩；模块在求值期经 window.KernelState 注册受控桥，
 * 因此先装真实 kernel-state（与生产 classic 先行语义一致）。
 */

async function createCacheHarness(fetchImpl) {
  const prevFetch = globalThis.fetch;
  const cleanupGlobals = installBrowserStubs();
  globalThis.fetch = fetchImpl;
  try {
    // 内核桥先装载（生产 classic 先行语义）；装载失败也必须恢复桩
    await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
    const { module } = await loadModuleOnce('public/src/modules/model-preset-cache.js', { installGlobals: false });
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

const PRESETS_A = [{ name: 'p1', model: 'm1' }, { name: 'p2', model: 'm2' }];
const PRESETS_B = [{ name: 'p3', model: 'm3' }];
const noFetch = async () => { throw new Error('should not fetch'); };

describe('model-preset-cache：基础读写', () => {
  it('初始状态：getter 返回空数组，任何会话不命中', async () => {
    const h = await createCacheHarness(noFetch);
    try {
      assert.deepEqual(h.module.getClawModelPresets(), []);
      assert.equal(h.module.clawModelPresetsMatchSession('rt-1'), false);
    } finally {
      h.cleanup();
    }
  });

  it('物理状态私有：写读都不在 window.ClawFW 袋上留痕（无镜像）', async () => {
    const h = await createCacheHarness(noFetch);
    try {
      h.module.setClawModelPresets(PRESETS_A, 'rt-1');
      assert.deepEqual(h.module.getClawModelPresets(), PRESETS_A);
      const bag = globalThis.window.ClawFW;
      assert.equal(bag?._modelPresets, undefined, 'ClawFW 袋上不应有缓存镜像');
      assert.equal(bag?._modelPresetsRuntimeId, undefined, 'ClawFW 袋上不应有会话标记镜像');
    } finally {
      h.cleanup();
    }
  });

  it('引用身份：setter 原样持有调用方数组，getter 返回同一引用（原地修改可见）', async () => {
    const h = await createCacheHarness(noFetch);
    try {
      const list = [{ name: 'p1' }];
      assert.equal(h.module.setClawModelPresets(list, 'rt-1'), list, 'setter 返回调用方数组本身');
      assert.equal(h.module.getClawModelPresets(), list, 'getter 返回同一引用');
      list.push({ name: 'p2' });
      assert.equal(h.module.getClawModelPresets().length, 2, '原地修改对读方可见');
    } finally {
      h.cleanup();
    }
  });

  it('带会话身份写入：标记该会话命中，其他会话不命中', async () => {
    const h = await createCacheHarness(noFetch);
    try {
      h.module.setClawModelPresets(PRESETS_A, 'rt-1');
      assert.deepEqual(h.module.getClawModelPresets(), PRESETS_A);
      assert.equal(h.module.clawModelPresetsMatchSession('rt-1'), true);
      assert.equal(h.module.clawModelPresetsMatchSession('rt-2'), false);
    } finally {
      h.cleanup();
    }
  });

  it('不带会话身份写入：清除会话标记（修正全局写入残留旧标记的裂缝）', async () => {
    const h = await createCacheHarness(noFetch);
    try {
      h.module.setClawModelPresets(PRESETS_A, 'rt-1');
      h.module.setClawModelPresets(PRESETS_B);
      assert.deepEqual(h.module.getClawModelPresets(), PRESETS_B);
      assert.equal(h.module.clawModelPresetsMatchSession('rt-1'), false);
    } finally {
      h.cleanup();
    }
  });

  it('空 presets 即使带会话身份写入也不命中（保持原 length>0 守卫）', async () => {
    const h = await createCacheHarness(noFetch);
    try {
      h.module.setClawModelPresets([], 'rt-1');
      assert.equal(h.module.clawModelPresetsMatchSession('rt-1'), false);
    } finally {
      h.cleanup();
    }
  });
});

describe('model-preset-cache：会话懒加载 ensureClawModelPresetsForSession', () => {
  it('缓存未命中：fetch 带 agentId 参数，写入并返回', async () => {
    const urls = [];
    const h = await createCacheHarness(async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ presets: PRESETS_A }) };
    });
    try {
      const presets = await h.module.ensureClawModelPresetsForSession('rt-1');
      assert.deepEqual(presets, PRESETS_A);
      assert.deepEqual(urls, ['/protoclaw/model_config?agentId=rt-1']);
      assert.equal(h.module.clawModelPresetsMatchSession('rt-1'), true);
    } finally {
      h.cleanup();
    }
  });

  it('缓存命中：不再 fetch，直接返回缓存', async () => {
    const urls = [];
    const h = await createCacheHarness(async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ presets: PRESETS_A }) };
    });
    try {
      await h.module.ensureClawModelPresetsForSession('rt-1');
      const again = await h.module.ensureClawModelPresetsForSession('rt-1');
      assert.deepEqual(again, PRESETS_A);
      assert.equal(urls.length, 1);
    } finally {
      h.cleanup();
    }
  });

  it('会话切换（runtimeId 变化）：重新 fetch 并更新标记', async () => {
    const urls = [];
    const h = await createCacheHarness(async (url) => {
      urls.push(String(url));
      const rt = String(url).includes('rt-2') ? PRESETS_B : PRESETS_A;
      return { ok: true, json: async () => ({ presets: rt }) };
    });
    try {
      await h.module.ensureClawModelPresetsForSession('rt-1');
      const switched = await h.module.ensureClawModelPresetsForSession('rt-2');
      assert.deepEqual(switched, PRESETS_B);
      assert.deepEqual(h.module.getClawModelPresets(), PRESETS_B);
      assert.equal(urls.length, 2);
    } finally {
      h.cleanup();
    }
  });

  it('runtimeId 为空串：fetch 不带 agentId 查询参数', async () => {
    const urls = [];
    const h = await createCacheHarness(async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ presets: PRESETS_A }) };
    });
    try {
      await h.module.ensureClawModelPresetsForSession('');
      assert.deepEqual(urls, ['/protoclaw/model_config']);
    } finally {
      h.cleanup();
    }
  });

  it('响应 JSON 解析失败：异常向上抛且不写缓存', async () => {
    const h = await createCacheHarness(async () => ({
      ok: true,
      json: async () => { throw new Error('bad json'); },
    }));
    try {
      await assert.rejects(
        () => h.module.ensureClawModelPresetsForSession('rt-1'),
        /bad json/,
      );
      assert.deepEqual(h.module.getClawModelPresets(), []);
    } finally {
      h.cleanup();
    }
  });
});

describe('model-preset-cache：全局懒加载 ensureClawModelPresets（app-ui 语义）', () => {
  it('缓存 falsy：fetch 不带参数，成功后写入', async () => {
    const urls = [];
    const h = await createCacheHarness(async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ presets: PRESETS_A }) };
    });
    try {
      const presets = await h.module.ensureClawModelPresets();
      assert.deepEqual(presets, PRESETS_A);
      assert.deepEqual(urls, ['/protoclaw/model_config']);
    } finally {
      h.cleanup();
    }
  });

  it('已初始化（含空数组）：不重复 fetch', async () => {
    const urls = [];
    const h = await createCacheHarness(async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ presets: [] }) };
    });
    try {
      await h.module.ensureClawModelPresets();
      const again = await h.module.ensureClawModelPresets();
      assert.deepEqual(again, []);
      assert.equal(urls.length, 1);
    } finally {
      h.cleanup();
    }
  });

  it('fetch 失败：静默写空数组不抛错（原 app-ui catch 语义）', async () => {
    const h = await createCacheHarness(async () => { throw new Error('network down'); });
    try {
      const presets = await h.module.ensureClawModelPresets();
      assert.deepEqual(presets, []);
      assert.deepEqual(h.module.getClawModelPresets(), []);
    } finally {
      h.cleanup();
    }
  });
});
