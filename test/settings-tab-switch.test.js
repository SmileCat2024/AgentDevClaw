import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

/**
 * 设置面板 tab 切换的回归测试。
 *
 * 历史事故：05ebc2b（auth 功能）删除了 window.switchSettingsTab 的定义，
 * 但渲染出的 tab 按钮 onclick="switchSettingsTab(...)" 未删，导致
 * 「文本模型 / 语音模型」tab 点击即 ReferenceError，切换不过去。
 * 迁移分发器后，按钮经 data-action="modelSettings.switchTab" + data-tab
 * 寻址。本测试锁定：该动作在分发器注册表存在，且经真实点击同款调用
 * 路径（invoke + 元素 dataset）切换生效。
 *
 * 装载路线：一次用例 = 一份真实沙箱 window + 一张真实 ESM 图（`withP2EsmCase`
 * 的 case 级命名空间）。classic 相按 index.html 的先行脚本序装载真实实现
 * （宿主工厂都是生产代码），ESM 侧与 classic 相读写同一个全局对象；静态依赖
 * 的 defineKey / claim 每个 case 都在本 case 的 KernelState 上重新发生。
 */

async function withSettingsCase(fn) {
  return withP2EsmCase({
    globals: {
      // tab 切换会触发真实的后台刷新（模型目录 / OAuth 状态）：空载荷让链跑完
      fetch: async () => ({ ok: true, json: async () => ({}) }),
    },
    classic: (sandbox) => {
      prepareClassicSandbox(sandbox);
      // markdown-utils 在求值期读取该桥键值（生产由 markdown-bootstrap classic 注册）
      sandbox.KernelState.defineKey('markdown-utils', 'escapeHtml', (value) => String(value ?? ''));
    },
  }, async (c) => {
    const modelSettings = await c.load('public/src/modules/model-settings.js');
    return fn({
      c,
      modelSettings,
      /** 让 tab 切换触发的后台刷新链跑完 */
      settle: () => new Promise((resolve) => { setImmediate(resolve); }),
    });
  });
}

/** 模拟真实 tab 按钮元素（分发器点击时传给 handler 的元素形态） */
function tabButton(tab) {
  return { dataset: { tab } };
}

async function invokeTab(h, tab) {
  const dispatched = h.c.window.ClawFW.actions.invoke('modelSettings.switchTab', tabButton(tab), { type: 'click' });
  await h.settle();
  return dispatched;
}

describe('settings tab 切换', () => {
  it('modelSettings.switchTab 动作已注册（tab 按钮的点击路径依赖它存在）', async () => {
    await withSettingsCase(async (h) => {
      assert.equal(await invokeTab(h, 'overview'), true);
    });
  });

  it('切换 tab 更新 ClawFW.settingsTab（设置面板未打开时重渲染只清空宿主）', async () => {
    await withSettingsCase(async (h) => {
      await invokeTab(h, 'speech');
      assert.equal(h.c.window.ClawFW.settingsTab, 'speech');
      await invokeTab(h, 'codex');
      assert.equal(h.c.window.ClawFW.settingsTab, 'codex');
    });
  });

  it('非法 tab 回落到 overview', async () => {
    await withSettingsCase(async (h) => {
      await invokeTab(h, 'text');
      assert.equal(h.c.window.ClawFW.settingsTab, 'overview');
    });
  });
});

describe('用例隔离（整图每 case 重建）', () => {
  it('两个连续 case：语言与设置页签状态不跨 case 泄漏，桥键在本 case 的 KernelState 上重新认领', async () => {
    let first = null;
    await withSettingsCase(async (h) => {
      const i18n = await h.c.load('public/src/modules/i18n-environment-state.js');
      i18n.setCurrentLanguage('en');
      await invokeTab(h, 'codex');
      assert.equal(i18n.getCurrentLanguage(), 'en');
      assert.equal(h.c.window.ClawFW.settingsTab, 'codex');
      // i18n 域在本 case 的 KernelState 上被认领（claim 真发生在这一代图上）
      assert.equal(h.c.read('window.KernelState.stats().claimedKeys > 0'), true);
      first = { i18n };
    });

    await withSettingsCase(async (h) => {
      const i18n = await h.c.load('public/src/modules/i18n-environment-state.js');
      // classic 相（app-core 注册的桥键初值）播种本 case 的语言，而不是继承上一 case 的 en
      assert.equal(i18n.getCurrentLanguage(), 'zh', '语言状态不得跨 case 继承');
      // 上一 case 写进其 window 的设置页签不出现在新 window
      assert.notEqual(h.c.window.ClawFW.settingsTab, 'codex');
      // i18n 域仍被本 case 的 KernelState 认领（不是悬空 claim）
      assert.equal(h.c.read('window.KernelState.stats().claimedKeys > 0'), true);
      i18n.setCurrentLanguage('en');
      await invokeTab(h, 'speech');
      assert.equal(first.i18n.getCurrentLanguage(), 'en', '上一 case 的图持有自己的状态');
      assert.equal(h.c.window.ClawFW.settingsTab, 'speech');
    });
  });
});
