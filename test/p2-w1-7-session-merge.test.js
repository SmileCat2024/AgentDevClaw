import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

/**
 * 模型设置保存后的「会话快照合并」回归（P2 W1-7 返修 S1）。
 *
 * 背景：保存模型配置后会按当前浏览目标重取一次会话切片并合并，避免用目录
 * 切片整体覆盖项目列表、并保住已加载的深层分页段。合并由 sidebar-operations
 * 的 `mergeWorkspaceSessionSnapshots` 承担（P2 W2-6 已迁 ESM），model-settings
 * 直接 import 它。
 *
 * 本测试锁定两件事：
 *   1. 合并策略本身按真实实现生效（版本回退保留上一快照、追加段不清理已加载条目、
 *      unchanged 载荷不触发合并）——旧写法 `typeof window.X === 'function'` 的
 *      静默回退会在这里退化为「fresh 整体覆盖」，即被本测试抓到；
 *   2. 合并不依赖 window 桥键：在**本 case** 真删掉已注册的
 *      `window.mergeWorkspaceSessionSnapshots`（访问器 configurable）后，保存路径
 *      仍走真实合并。
 *
 * 装载路线：一次用例 = 一份真实沙箱 window + 一张真实 ESM 图（`withP2EsmCase`
 * 的 case 级命名空间）。保存链重取会话切片走真实 phFetchSessionsWithOwnership，
 * 契约是 `GET /protoclaw/prebuilt_sessions` 返回切片 JSON，用例只换「服务端给什么」。
 */

async function withMergeCase(fn) {
  // 保存链重取会话切片走真实 phFetchSessionsWithOwnership（model-settings 已改
  // 直接 import）：按同一契约回包，用例只换「服务端给什么」。
  const state = { fresh: null, requests: [], modelConfig: { config: { defaultModel: {}, agent: {} }, presets: [] } };
  return withP2EsmCase({
    globals: {
      fetch: async (url, options) => {
        const target = String(url);
        state.requests.push({ url: target, method: options?.method || 'GET' });
        if (target.startsWith('/protoclaw/prebuilt_sessions')) {
          return { ok: true, status: 200, json: async () => state.fresh };
        }
        if (target === '/protoclaw/model_config' && options?.method === 'PUT') {
          const body = JSON.parse(options.body);
          return { ok: true, json: async () => ({ config: body.config, presets: body.presets }) };
        }
        if (target === '/protoclaw/model_config') {
          return { ok: true, json: async () => state.modelConfig };
        }
        return { ok: true, json: async () => ({}) };
      },
    },
    classic: (sandbox) => {
      prepareClassicSandbox(sandbox);
      // markdown-utils 在求值期读取该桥键值（生产由 markdown-bootstrap classic 注册）
      sandbox.KernelState.defineKey('markdown-utils', 'escapeHtml', (value) => String(value ?? ''));
    },
  }, async (c) => {
    const modelSettings = await c.load('public/src/modules/model-settings.js');
    // 合并实现来自 sidebar-operations（model-settings 的静态依赖链已装载它）：
    // 取同一实例，用于断言「桥键被删后命名导出仍可用」。
    const sidebar = await c.load('public/src/modules/sidebar-operations.js');
    return fn({
      c,
      modelSettings,
      sidebar,
      state,
      settle: () => new Promise((resolve) => { setImmediate(resolve); }),
    });
  });
}

/** 触发真实保存路径：分发器 → applySettingsPreset → saveSettingsConfig → 合并 */
async function applyPreset(h, idx = 0) {
  const dispatched = h.c.window.ClawFW.actions.invoke('modelSettings.applyPreset', { dataset: {} }, { type: 'click' }, idx);
  await h.settle();
  return dispatched;
}

/**
 * 真实用户路径装载设置数据：服务端载荷 → openSettings（设置态归 model-settings
 * 模块私有，不再借宿 window.ClawFW）。
 */
async function seedSettings(h, { presets = [], config = { defaultModel: {}, agent: {} } } = {}) {
  h.state.modelConfig = { config, presets };
  await h.modelSettings.openSettings();
}

function stubAgent(h, agent, fresh) {
  window.getCurrentAgentRecord = () => agent;
  window.getLogicalAgentId = (record) => record?.id || '';
  h.state.fresh = fresh;
}

const PRESET = {
  name: 'merge-test',
  provider: 'anthropic',
  apiSurface: 'chat',
  model: 'claude-test',
  baseUrl: 'https://api.example.com/v1',
  thinkingEffort: null,
};

describe('保存模型配置后的会话快照合并', () => {
  it('版本回退的切片不覆盖已加载快照（保留深层已加载条目）', async () => {
    await withMergeCase(async (h) => {
      const previous = { revision: 10, sessions: [{ id: 'a' }, { id: 'b' }] };
      const agent = { id: 'programming-helper', workspace_sessions: previous };
      stubAgent(h, agent, { revision: 5, sessions: [{ id: 'c' }] });
      await seedSettings(h, { presets: [PRESET] });

      await applyPreset(h, 0);

      assert.equal(agent.workspace_sessions, previous, '版本回退时保留上一快照（不得整体替换）');
      assert.deepEqual(agent.workspace_sessions.sessions.map((s) => s.id), ['a', 'b']);
    });
  });

  it('追加段（sessionOffset > 0）patch 已加载条目并拼接新条目', async () => {
    await withMergeCase(async (h) => {
      const agent = {
        id: 'programming-helper',
        workspace_sessions: { revision: 10, sessions: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] },
      };
      stubAgent(h, agent, { revision: 12, sessionOffset: 40, sessions: [{ id: 'b', title: 'B2' }, { id: 'c', title: 'C' }] });
      await seedSettings(h, { presets: [PRESET] });

      await applyPreset(h, 0);

      assert.deepEqual(agent.workspace_sessions.sessions.map((s) => s.id), ['a', 'b', 'c'], '已加载条目保留并拼接新条目');
      assert.equal(agent.workspace_sessions.sessions[1].title, 'B2', '重复 id 取切片里的新字段');
      assert.equal(agent.workspace_sessions.revision, 12);
    });
  });

  it('unchanged 载荷不触发合并，快照保持原样', async () => {
    await withMergeCase(async (h) => {
      const previous = { revision: 10, sessions: [{ id: 'a' }] };
      const agent = { id: 'programming-helper', workspace_sessions: previous };
      // unchanged 载荷不带新事实：即便附带 sessions / revision 也不得回写快照
      stubAgent(h, agent, { unchanged: true, revision: 11, sessions: [{ id: 'z' }] });
      await seedSettings(h, { presets: [PRESET] });

      await applyPreset(h, 0);

      assert.equal(agent.workspace_sessions, previous);
    });
  });

  it('不依赖 window 桥键：注销 mergeWorkspaceSessionSnapshots 后仍执行真实合并', async () => {
    await withMergeCase(async (h) => {
      // 本 case 的桥键确实由 sidebar-operations 注册（先证明它在），再真删掉它，
      // 断言保存路径仍走真实合并——这才是「桥键注销后的终态」。
      const descriptor = Object.getOwnPropertyDescriptor(window, 'mergeWorkspaceSessionSnapshots');
      assert.equal(typeof descriptor?.get, 'function', '本 case 应存在该桥键（前置事实）');
      assert.equal(descriptor.get(), h.sidebar.mergeWorkspaceSessionSnapshots);
      delete window.mergeWorkspaceSessionSnapshots;
      assert.equal(Object.getOwnPropertyDescriptor(window, 'mergeWorkspaceSessionSnapshots'), undefined,
        '桥键应已从本 case window 上注销');
      assert.equal(typeof h.sidebar.mergeWorkspaceSessionSnapshots, 'function', '命名导出仍可用');

      const agent = {
        id: 'programming-helper',
        workspace_sessions: { revision: 10, sessions: [{ id: 'a' }] },
      };
      stubAgent(h, agent, { revision: 12, sessionOffset: 40, sessions: [{ id: 'b' }] });
      await seedSettings(h, { presets: [PRESET] });

      await applyPreset(h, 0);

      assert.deepEqual(agent.workspace_sessions.sessions.map((s) => s.id), ['a', 'b'], '桥键缺席时不得退化为 fresh 整体覆盖');
    });
  });
});

describe('用例隔离（整图每 case 重建）', () => {
  it('两个连续 case：语言与保存链状态不跨 case 泄漏，桥键在本 case 重新注册', async () => {
    let firstBridgeGetter = null;
    await withMergeCase(async (h) => {
      const i18n = await h.c.load('public/src/modules/i18n-environment-state.js');
      i18n.setCurrentLanguage('en');
      firstBridgeGetter = Object.getOwnPropertyDescriptor(window, 'mergeWorkspaceSessionSnapshots').get;
      assert.equal(i18n.getCurrentLanguage(), 'en');
      assert.equal(h.state.requests.length, 0, '新 case 的 fetch 记录从空开始');
    });

    await withMergeCase(async (h) => {
      const i18n = await h.c.load('public/src/modules/i18n-environment-state.js');
      assert.equal(i18n.getCurrentLanguage(), 'zh', '语言状态不得跨 case 继承');
      const descriptor = Object.getOwnPropertyDescriptor(window, 'mergeWorkspaceSessionSnapshots');
      assert.equal(typeof descriptor?.get, 'function', '桥键在本 case 重新注册');
      assert.notEqual(descriptor.get, firstBridgeGetter, '桥访问器属于本 case 的 KernelState，不复用上一 case');
      assert.equal(descriptor.get(), h.sidebar.mergeWorkspaceSessionSnapshots);
      assert.equal(h.state.requests.length, 0, 'fetch 记录不跨 case 泄漏');
    });
  });
});
